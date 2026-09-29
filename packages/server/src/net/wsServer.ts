import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ConfigRegistry } from '@dm/shared';
import { RoomManager } from './roomManager.js';
import { clientIp } from './rateLimit.js';
import { MAX_BACKPRESSURE, MAX_FRAME_BYTES, isGameWsPath, routePassOf, type GameConn } from './conn.js';
import { counters } from './metrics.js';
import { logThrottle } from './logThrottle.js';
import { nodeShutdownInstalled } from '../cluster/node.js';

/**
 * Транспорт по умолчанию: библиотека `ws` поверх общего HTTP-сервера (тот же порт, что REST).
 * Игровая логика видит соединение через `GameConn` (см. `conn.ts`), поэтому здесь остаётся
 * только специфика библиотеки: рукопожатие, heartbeat и завершение работы.
 */

/**
 * Обёртка `ws.WebSocket` → `GameConn`. Один объект на всё соединение (годится ключом Map). Экспорт — для фаззера протокола: он гоняет
 * НАСТОЯЩУЮ обёртку поверх сокета, ведущего себя как `ws` (`protocolFuzz.test.ts`).
 *
 * ⭐ B3-V1, B3-V2: ЗАКРЫТИЕ, НАЧАТОЕ СЕРВЕРОМ, — ОКОНЧАТЕЛЬНО СРАЗУ, как у uWS (`end` зовёт обработчик закрытия синхронно). У `ws`
 * `close(code)` — только начало рукопожатия: сокет в `CLOSING`, библиотека отдаёт кадры клиента дальше, а событие `close` приходит, когда
 * клиент ответит, или через `closeTimeout` (30 с). Клиент, не отвечающий на закрытие, держал рабочий канал команд: закрытый за поток
 * кадров (4008), вытесненный (4001), снятый устаревшим (4009) входил тем же сокетом заново и играл; а снятие сессии при закрытии мимо
 * менеджера (медленный читатель, 1013) ждало события — всё это время игрок сидел в комнате на мёртвом сокете (место в пати, голос).
 * Теперь `close` сразу закрывает обёртку (`open` — ложь, кадры не идут) и зовёт обработчик закрытия (`onClose`, один раз); событие
 * транспорта потом ничего не делает. ⭐ R18-01: закрытие изнутри отправки (медленный читатель, 1013) зовёт его ближайшей микрозадачей —
 * не поперёк синхронного шага комнаты, который эту отправку делал (см. `shut`).
 */
export class WsConn implements GameConn {
  /** Закрыто: сервером (`close`) или транспортом (событие `close`/`error`). Кадры больше не идут ни туда, ни сюда. */
  private closed = false;
  private ended = false;
  private onEnd?: () => void;
  constructor(private readonly ws: WebSocket, readonly ip: string, readonly routePass?: string) {}
  get open(): boolean { return !this.closed && this.ws.readyState === this.ws.OPEN; }
  send(data: string | Uint8Array): void {
    if (!this.open) return;
    // Клиент, который не успевает читать, копит неотправленное В ПАМЯТИ СЕРВЕРА. У uWS для
    // этого есть `maxBackpressure`, у `ws` — только растущий `bufferedAmount`, и его никто
    // не рубил: подвисший браузер мог тянуть сервер за собой. Порог тот же, что у uWS.
    if (this.ws.bufferedAmount > MAX_BACKPRESSURE) {
      counters.slowClientsDropped++;
      this.shut(1013, 'slow-client', true);   // ⭐ R18-01: из отправки — снятие сессии микрозадачей
      return;
    }
    // `binary` обязателен: без него Buffer уехал бы текстовым кадром и клиент не распознал бы его.
    if (typeof data === 'string') this.ws.send(data);
    else this.ws.send(data, { binary: true });
  }
  close(code?: number, reason?: string): void {
    this.shut(code, reason, false);
  }
  /**
   * Закрыть: сокет — сразу (`open` — ложь, кадры не идут ни туда, ни сюда), обработчик закрытия — B3-V2: сейчас, а не по концу рукопожатия.
   * ⭐ R18-01: закрытие ИЗНУТРИ ОТПРАВКИ (`later`: очередь выше потолка) зовёт его ближайшей микрозадачей. Отправку зовёт комната посреди
   * своего синхронного шага (рассылка мира, окна смерти, статусы), и снятие сессии прямо в ней (`RoomManager.onClose` → `removePlayer`) шло
   * поперёк шага: копия ждущего реконнекта снималась между тиком, убившим героя, и штрафом за эту смерть — «оплачено» без штрафа, а голос,
   * проходящий на снятии, переносил пати посреди рассылки. Теперь шаг доходит до конца, а сессия снимается сразу после него.
   */
  private shut(code: number | undefined, reason: string | undefined, later: boolean): void {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(code, reason); } catch { /* уже закрыт */ }
    if (later) queueMicrotask(() => this.end()); else this.end();
  }
  onMessage(cb: (raw: string) => void): void {
    // R2-01: бросок из обработчика кадра внутри события сокета — это необработанное исключение и выход процесса со
    // всеми комнатами. Менеджер ловит своё сам; здесь — последний рубеж: гасим кадр, не процесс.
    this.ws.on('message', (data: Buffer) => {
      if (!this.open) return;   // ⭐ B3-V1: закрытый сокет (в `CLOSING` библиотека кадры ещё отдаёт) не действует
      try { cb(data.toString()); } catch (e) { frameFailed(e); }
    });
  }
  onClose(cb: () => void): void {
    this.onEnd = cb;
    this.ws.on('close', () => this.end());
    this.ws.on('error', () => this.end());
    if (this.closed) this.end();   // закрыли раньше подписки — подписчик узнаёт сразу
  }
  /** Обработчик закрытия — ровно один раз, кто бы ни закрыл: сервер (`close`) или транспорт. Подписки ещё нет — позовёт `onClose`. */
  private end(): void {
    this.closed = true;
    const cb = this.onEnd;
    if (this.ended || !cb) return;
    this.ended = true;
    this.onEnd = undefined;
    cb();
  }
}

/**
 * Кадр погашен исключением на уровне транспорта (R2-01) — счётчик и лог не чаще раза в 10 с: поток кривых
 * кадров не должен топить лог. Общий для обоих транспортов. ⭐ R17-06: срок — по часам процесса (`logThrottle`).
 */
const frameFailLog = logThrottle();
export function frameFailed(e: unknown): void {
  counters.frameErrors++;
  const muted = frameFailLog.pass();
  if (muted === null) return;
  console.error(`[ws] кадр погашен исключением${muted}:`, e);
}

export function attachWsServer(server: Server, cfg: ConfigRegistry): void {
  // Ф0.1: сжатие ВЫКЛЮЧЕНО осознанно. Замер: perMessageDeflate стоит 179 мкс на кадр НА КАЖДОГО
  // клиента и выполняется в пуле из четырёх потоков libuv. На сотне клиентов пул захлёбывается,
  // очередь исходящих растёт (RSS 270→730 МБ), задержка уходит в 10–12 СЕКУНД. Тот же тест без
  // сжатия: RTT 8 мс, память стабильна. Цена — трафик вниз растёт с ~25 до ~175 КБ/с на игрока;
  // это временно: Ф1 (дельта-снапшоты + область интереса + бинарный кадр) уводит кадр на порядок
  // вниз, после чего сжимать будет уже нечего. Возвращать сжатие без замера — не надо.
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
    // R2-18: кадр больше потолка закрывается кодом 1009 ДО того, как ляжет в память (умолчание `ws` — 100 МБ).
    maxPayload: MAX_FRAME_BYTES,
  });
  // R4-13: игровой сокет — `/ws` и `/ws/<i>` (путь за прокси по путям, см. `isGameWsPath`); прочие пути — 400, как было.
  wss.shouldHandle = (req) => isGameWsPath(req.url ?? '');
  // WSS привязан к http-серверу и переизлучает его ошибки (напр. EADDRINUSE при dev-рестарте). БЕЗ обработчика
  // 'error' здесь Node роняет процесс (unhandled 'error') → сервер умирает и редактор/клиент ловят ECONNREFUSED.
  // Логируем; освобождение порта/повтор listen обрабатывает server.on('error') в index.ts.
  wss.on('error', (e) => console.warn('[ws] WebSocketServer error:', (e as Error).message));
  const rooms = new RoomManager(cfg);
  wss.on('connection', (ws, req) => {
    // Heartbeat: помечаем «живым» на любой pong/сообщение; мёртвые (обрыв интернета, TCP ещё висит)
    // добиваем ниже — иначе removePlayer не сработал бы до TCP-таймаута (~2 мин) и в комнате копился
    // бы «призрак» игрока (дубль при реконнекте).
    (ws as { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => { (ws as { isAlive?: boolean }).isAlive = true; });
    ws.on('message', () => { (ws as { isAlive?: boolean }).isAlive = true; });
    // R13-08: пропуск маршрута гейтвея — из адреса сокета.
    rooms.handleConnection(new WsConn(ws, clientIp(req.headers, req.socket.remoteAddress), routePassOf(req.url ?? '')));
  });
  // Пинг всех раз в 10с; кто не ответил с прошлого пинга — terminate() → 'close' → removePlayer.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as { isAlive?: boolean };
      if (w.isAlive === false) { ws.terminate(); continue; }
      w.isAlive = false;
      ws.ping();
    }
  }, 10_000);
  wss.on('close', () => clearInterval(heartbeat));
  console.log('[dm-server] WebSocket на /ws (транспорт ws)');

  installShutdown(rooms);
}

/**
 * Graceful shutdown: при остановке/рестарте (в dev — `tsx watch` шлёт SIGTERM на каждую
 * правку кода) сбрасываем прогресс всех комнат в БД — забег не теряется.
 */
export function installShutdown(rooms: RoomManager): void {
  // Ф2: запись в базу асинхронна, поэтому выходим ТОЛЬКО после её завершения. Прежний
  // `process.exit` сразу после вызова просто выбросил бы незаписанные сейвы.
  let leaving = false;
  const shutdown = (): void => {
    // ⭐ R3-12: у ноды кластера (роли node и single) выходит СЛИВ НОДЫ — он пишет те же сейвы, снимает ноду и её
    // закрепления из реестра и сам выходит. Раньше этот обработчик выходил первым, сразу после своей записи (или
    // через 5 с): до `releaseNode` и раньше, чем слив дожидался прощальных записей.
    if (leaving || nodeShutdownInstalled()) return;
    leaving = true;
    const done = (): never => process.exit(0);
    // Страховка: если база молчит, всё равно выходим — иначе рестарт dev-сервера подвиснет.
    const guard = setTimeout(done, 5000);
    // R12-04: дописка ждёт моргнувшую базу кругами — до полусекунды до страховки.
    void rooms.flushAll(4_500).catch((e: unknown) => console.error('[dm-server] сейвы при остановке:', e))
      .finally(() => { clearTimeout(guard); done(); });
  };
  // ⭐ R5-08: `on`, а не `once`: повторный сигнал во время записи не должен убивать процесс действием по умолчанию.
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
