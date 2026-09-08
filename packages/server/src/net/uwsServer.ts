import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import type { ConfigRegistry } from '@dm/shared';
import { RoomManager } from './roomManager.js';
import { installShutdown } from './wsServer.js';
import type { GameConn } from './conn.js';

/**
 * Транспорт на uWebSockets.js (Ф1.6) — включается `DM_WS=uws`.
 *
 * ЗАЧЕМ. Библиотека `ws` разбирает кадры на JavaScript; uWS — это C++-сервер под тонким
 * биндингом. В транспортном бенче (тот же кадр, та же частота, та же рассылка «каждому по
 * очереди») процесс на uWS стоил примерно на четверть меньше CPU. Игровая логика при этом
 * не меняется вообще: она видит только `GameConn`.
 *
 * ПОЧЕМУ ЗДЕСЬ ЖИВЁТ ПРОКСИ HTTP. uWS не умеет вставать поверх `node:http` — у него свой
 * слушатель. Чтобы снаружи ничего не поменялось (один порт, тот же `/ws`, тот же `/api`),
 * игровой порт занимает uWS, express переезжает на порт петли, а всё, что не `/ws`,
 * uWS переправляет ему. Игровой трафик через прокси НЕ идёт — только редкие запросы
 * аккаунтов, конфига и статики, где лишние микросекунды не стоят ничего.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Своего heartbeat: uWS сам шлёт ping и закрывает молчащих по `idleTimeout`.
 */

/** Минимальная типизация нужного нам куска uWS (пакет ставится опционально). */
interface UwsSocket {
  getRemoteAddressAsText(): ArrayBuffer;
  send(data: string | ArrayBufferView, isBinary?: boolean): number;
  end(code?: number, reason?: string): void;
  close(): void;
}
interface UwsRes {
  onAborted(cb: () => void): void;
  onData(cb: (chunk: ArrayBuffer, isLast: boolean) => void): void;
  cork(cb: () => void): void;
  writeStatus(status: string): UwsRes;
  writeHeader(key: string, value: string): UwsRes;
  end(body?: string | ArrayBufferView): void;
  getRemoteAddressAsText(): ArrayBuffer;
}
interface UwsReq {
  getUrl(): string;
  getQuery(): string;
  getMethod(): string;
  forEach(cb: (key: string, value: string) => void): void;
}
interface UwsApp {
  ws(pattern: string, behavior: Record<string, unknown>): UwsApp;
  any(pattern: string, handler: (res: UwsRes, req: UwsReq) => void): UwsApp;
  listen(host: string, port: number, cb: (token: unknown) => void): UwsApp;
}
interface Uws {
  App(): UwsApp;
  DISABLED: number;
}

const dec = new TextDecoder();
const EMPTY = Buffer.alloc(0);

/** Обёртка сокета uWS → `GameConn`. Живёт ровно одно соединение. */
class UwsConn implements GameConn {
  open = true;
  onMsg?: (raw: string) => void;
  onEnd?: () => void;
  constructor(private readonly ws: UwsSocket, readonly ip: string) {}
  send(data: string | Uint8Array): void {
    if (!this.open) return;
    // uWS бросает, если сокет уже закрыт «под нами» (клиент отвалился между тиком и отправкой).
    try { this.ws.send(typeof data === 'string' ? data : data, typeof data !== 'string'); }
    catch { this.open = false; }
  }
  close(code?: number, reason?: string): void {
    if (!this.open) return;
    this.open = false;
    // `end` — закрытие с кодом по протоколу; клиент увидит 4001/4008, как и на транспорте ws.
    try { this.ws.end(code ?? 1000, reason ?? ''); } catch { /* уже закрыт */ }
  }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
}

/**
 * Поднимает uWS на `port`: `/ws` — игра, всё остальное — прокси на express (`httpPort`
 * на петле). Возвращает false, если пакет не собран под эту платформу: вызывающий откатится
 * на транспорт `ws`, а не уронит сервер.
 */
export function startUwsServer(cfg: ConfigRegistry, port: number, httpPort: number): boolean {
  let uWS: Uws;
  try {
    uWS = createRequire(import.meta.url)('uWebSockets.js') as Uws;
  } catch (e) {
    console.warn(`[dm-server] DM_WS=uws, но uWebSockets.js не загрузился (${(e as Error).message}) — остаюсь на ws`);
    return false;
  }

  const rooms = new RoomManager(cfg);
  const conns = new Map<UwsSocket, UwsConn>();

  const app = uWS.App().ws('/ws', {
    // Сжатие выключено по той же причине, что и на `ws` — см. комментарий в wsServer.ts.
    compression: uWS.DISABLED,
    // Клиент шлёт только маленькие JSON-кадры ввода; всё крупное — повод закрыть соединение.
    maxPayloadLength: 64 * 1024,
    // Молчащего клиента (обрыв интернета, TCP ещё висит) закрываем сами — иначе в комнате
    // копится «призрак» игрока. uWS шлёт ping автоматически, свой heartbeat не нужен.
    idleTimeout: 32,
    // Потолок неотправленного на клиента: кто не успевает читать — отключается, а не съедает
    // память сервера. На `ws` эту роль играет рост bufferedAmount, но там его никто не рубит.
    maxBackpressure: 16 * 1024 * 1024,
    open: (ws: UwsSocket) => {
      const conn = new UwsConn(ws, dec.decode(ws.getRemoteAddressAsText()));
      conns.set(ws, conn);
      rooms.handleConnection(conn);
    },
    message: (ws: UwsSocket, msg: ArrayBuffer, isBinary: boolean) => {
      // От клиента приходит только текст (JSON). Двоичный кадр вверх — не наш протокол.
      if (isBinary) return;
      conns.get(ws)?.onMsg?.(dec.decode(msg));
    },
    close: (ws: UwsSocket) => {
      const conn = conns.get(ws);
      conns.delete(ws);
      if (conn) { conn.open = false; conn.onEnd?.(); }
    },
  });

  app.any('/*', (res, req) => proxyToExpress(res, req, httpPort));

  app.listen('0.0.0.0', port, (token) => {
    if (!token) {
      console.error(`[dm-server] uWS не смог занять порт ${port}`);
      process.exit(1);
    }
    console.log(`[dm-server] WebSocket на /ws (транспорт uws), HTTP проксируется на :${httpPort}`);
  });

  installShutdown(rooms);
  return true;
}

/** Переправить один HTTP-запрос express-серверу на петле и вернуть его ответ дословно. */
function proxyToExpress(res: UwsRes, req: UwsReq, httpPort: number): void {
  // onAborted ОБЯЗАТЕЛЕН до первого await/асинхронного шага: без него uWS роняет процесс,
  // если клиент отвалился раньше ответа.
  let aborted = false;
  res.onAborted(() => { aborted = true; });

  const method = req.getMethod().toUpperCase();
  const query = req.getQuery();
  const path = req.getUrl() + (query ? `?${query}` : '');
  const headers: Record<string, string> = {};
  req.forEach((k, v) => { headers[k] = v; });
  // Настоящий адрес клиента. Если заголовок уже есть (мы за nginx) — не трогаем: первым в нём
  // стоит адрес игрока, и именно по нему считают лимиты частоты (Ф0.5).
  if (!headers['x-forwarded-for']) {
    const addr = dec.decode(res.getRemoteAddressAsText());
    if (addr) headers['x-forwarded-for'] = addr;
  }
  // Тело собираем целиком: через прокси идут только запросы аккаунтов/конфига и загрузка
  // моделей из редактора — редкие и обозримые. Игровой трафик сюда не попадает.
  const forward = (body: Buffer): void => {
    const upstream = httpRequest(
      { host: '127.0.0.1', port: httpPort, path, method, headers },
      (up) => {
        const out: Buffer[] = [];
        up.on('data', (d: Buffer) => out.push(d));
        up.on('end', () => {
          if (aborted) return;
          const payload = Buffer.concat(out);
          res.cork(() => {
            res.writeStatus(`${up.statusCode ?? 500} ${up.statusMessage ?? ''}`.trim());
            for (const [k, v] of Object.entries(up.headers)) {
              // Длину и кодирование считает сам uWS — свои значения тут только всё сломают.
              if (k === 'content-length' || k === 'transfer-encoding' || k === 'connection') continue;
              if (Array.isArray(v)) for (const one of v) res.writeHeader(k, one);
              else if (v != null) res.writeHeader(k, String(v));
            }
            res.end(payload);
          });
        });
      },
    );
    upstream.on('error', (e) => {
      if (aborted) return;
      res.cork(() => { res.writeStatus('502 Bad Gateway').end(`прокси не достучался до express: ${e.message}`); });
    });
    if (body.length) upstream.write(body);
    upstream.end();
  };

  // У запросов без тела ждать `onData` нельзя — переправляем сразу.
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') { forward(EMPTY); return; }

  const chunks: Buffer[] = [];
  res.onData((chunk, isLast) => {
    // Буфер uWS переиспользуется между вызовами — копия обязательна, иначе тело затрётся.
    if (chunk.byteLength) chunks.push(Buffer.from(new Uint8Array(chunk).slice()));
    if (isLast) forward(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
  });
}
