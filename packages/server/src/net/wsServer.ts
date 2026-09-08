import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ConfigRegistry } from '@dm/shared';
import { RoomManager } from './roomManager.js';
import type { GameConn } from './conn.js';

/**
 * Транспорт по умолчанию: библиотека `ws` поверх общего HTTP-сервера (тот же порт, что REST).
 * Игровая логика видит соединение через `GameConn` (см. `conn.ts`), поэтому здесь остаётся
 * только специфика библиотеки: рукопожатие, heartbeat и завершение работы.
 */

/** Обёртка `ws.WebSocket` → `GameConn`. Один объект на всё соединение (годится ключом Map). */
class WsConn implements GameConn {
  constructor(private readonly ws: WebSocket) {}
  get open(): boolean { return this.ws.readyState === this.ws.OPEN; }
  send(data: string | Uint8Array): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    // `binary` обязателен: без него Buffer уехал бы текстовым кадром и клиент не распознал бы его.
    if (typeof data === 'string') this.ws.send(data);
    else this.ws.send(data, { binary: true });
  }
  close(code?: number, reason?: string): void {
    try { this.ws.close(code, reason); } catch { /* уже закрыт */ }
  }
  onMessage(cb: (raw: string) => void): void {
    this.ws.on('message', (data: Buffer) => cb(data.toString()));
  }
  onClose(cb: () => void): void {
    let done = false;
    const once = (): void => { if (!done) { done = true; cb(); } };
    this.ws.on('close', once);
    this.ws.on('error', once);
  }
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
    path: '/ws',
    perMessageDeflate: false,
  });
  // WSS привязан к http-серверу и переизлучает его ошибки (напр. EADDRINUSE при dev-рестарте). БЕЗ обработчика
  // 'error' здесь Node роняет процесс (unhandled 'error') → сервер умирает и редактор/клиент ловят ECONNREFUSED.
  // Логируем; освобождение порта/повтор listen обрабатывает server.on('error') в index.ts.
  wss.on('error', (e) => console.warn('[ws] WebSocketServer error:', (e as Error).message));
  const rooms = new RoomManager(cfg);
  wss.on('connection', (ws) => {
    // Heartbeat: помечаем «живым» на любой pong/сообщение; мёртвые (обрыв интернета, TCP ещё висит)
    // добиваем ниже — иначе removePlayer не сработал бы до TCP-таймаута (~2 мин) и в комнате копился
    // бы «призрак» игрока (дубль при реконнекте).
    (ws as { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => { (ws as { isAlive?: boolean }).isAlive = true; });
    ws.on('message', () => { (ws as { isAlive?: boolean }).isAlive = true; });
    rooms.handleConnection(new WsConn(ws));
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
    if (leaving) return;
    leaving = true;
    const done = (): never => process.exit(0);
    // Страховка: если база молчит, всё равно выходим — иначе рестарт dev-сервера подвиснет.
    const guard = setTimeout(done, 5000);
    void rooms.flushAll().catch((e: unknown) => console.error('[dm-server] сейвы при остановке:', e))
      .finally(() => { clearTimeout(guard); done(); });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
