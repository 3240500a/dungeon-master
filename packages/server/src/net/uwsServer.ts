import { createRequire } from 'node:module';
import { request as httpRequest, validateHeaderName, validateHeaderValue, type IncomingMessage } from 'node:http';
import type { ConfigRegistry } from '@dm/shared';
import { RoomManager } from './roomManager.js';
import { installShutdown, frameFailed } from './wsServer.js';
import { MAX_BACKPRESSURE, MAX_FRAME_BYTES, isGameWsPath, routePassOf, type GameConn } from './conn.js';
import { clientIp } from './rateLimit.js';
import { isLoopback, PROXY_HEADERS, LOCAL_PROOF_HEADER, proxyLinks } from './adminAccess.js';
import { counters } from './metrics.js';

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
  /** R4-29: то, что `upgrade` передал сокету, — адрес игрока (и R13-08: пропуск маршрута). */
  getUserData(): { ip?: string; pass?: string };
  send(data: string | ArrayBufferView, isBinary?: boolean): number;
  /** Сколько байт ещё не ушло клиенту (исходящая очередь сокета). */
  getBufferedAmount(): number;
  end(code?: number, reason?: string): void;
  close(): void;
}
interface UwsRes {
  onAborted(cb: () => void): void;
  onData(cb: (chunk: ArrayBuffer, isLast: boolean) => void): void;
  cork(cb: () => void): void;
  writeStatus(status: string): UwsRes;
  writeHeader(key: string, value: string): UwsRes;
  end(body?: string | ArrayBufferView, closeConnection?: boolean): void;
  /** R7-10: кусок тела без длины (chunked); `false` — у сокета обратное давление (uWS держит кусок у себя). */
  write(chunk: ArrayBufferView): boolean;
  /** R7-10: кусок тела известной длины `total`: [взят целиком, ответ окончен]. Не взят — дописать остаток в `onWritable`. */
  tryEnd(chunk: ArrayBufferView, total: number): [boolean, boolean];
  getWriteOffset(): number;
  onWritable(cb: (offset: number) => boolean): void;
  close(): void;
  getRemoteAddressAsText(): ArrayBuffer;
  upgrade(userData: { ip: string; pass?: string }, key: string, protocol: string, extensions: string, context: unknown): void;
}
interface UwsReq {
  getUrl(): string;
  getQuery(): string;
  getMethod(): string;
  getHeader(key: string): string;
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
/**
 * ⭐ R4-11: ПОТОЛОК ТЕЛА ЗАПРОСА НА ПРОКСИ. Раньше прокси собирал тело целиком, а express отказывал уже после: анонимный POST
 * на `/api/login` в несколько гигабайт (chunked, без Content-Length) раздувал память ноды до падения вместе со всеми
 * комнатами. Больше потолка — 413 от самого прокси, тело дальше не копится.
 * ⭐ R6-04: 16 КБ, а не 2 МБ — как у разбора тел аккаунтов (`accountRoutes.ts`, 8 КБ): 2 МБ вложенного JSON разбирались на
 * главном потоке ~115 мс до любого лимита, и десяток анонимных запросов в секунду стоял тиками всех комнат.
 */
const BODY_MAX = 16 * 1024;
/**
 * Инструменты вне продакшена (`/api/dev/*`: конфиг, контент поз-редактора).
 *
 * ⚠⚠ ЭТО ЧИСЛО ОБЯЗАНО СОВПАДАТЬ С `devJson` В `index.ts`, И ИМЕННО ОНО РЕЖЕТ ПЕРВЫМ. Поднять лимит
 * только у express бесполезно: прокси стоит ПЕРЕД ним и отвечает 413 сам, тело дальше не копится.
 * ЗАМЕР живым браузером на 2 МБ: 1.9 МБ доезжало, 2.5 МБ давало `TypeError: Failed to fetch` — браузер
 * получает обрыв, а не 413, и поз-редактор честно писал «сервер недоступен», хотя сервер работал.
 * Публикация шлёт ВСЕ грязные ключи одним телом, а `pe_clips` с мокап-набором это ~1.5 МБ сам по себе:
 * у владельца посылка весила 5.6 МБ и не уходила целиком — отсюда же «часть доезжает, часть нет».
 */
const DEV_BODY_MAX = 24 * 1024 * 1024;
const DEV_PATH = '/api/dev/';
/** Загрузка моделей из редактора (`/api/dev/assets/:id`, `express.raw` 64 МБ) — только вне продакшена: там ручка закрыта. */
const ASSET_BODY_MAX = 64 * 1024 * 1024;
const ASSET_PATH = '/api/dev/assets/';

/** R4-11: сколько тела прокси вообще готов принять на этот путь. В продакшене инструменты закрыты — им и тело не нужно. */
export function bodyCapFor(path: string, production = process.env.NODE_ENV === 'production'): number {
  if (production || !path.startsWith(DEV_PATH)) return BODY_MAX;
  return path.startsWith(ASSET_PATH) ? ASSET_BODY_MAX : DEV_BODY_MAX;
}

/**
 * ⭐ R5-01: ЧТО `http.request` ПРИМЕТ БЕЗ БРОСКА. Разборщик uWS пропускает шире: управляющий байт в значении заголовка
 * (`Host`, `User-Agent`, любой), не-ASCII в пути, метод не из знаков токена. `http.request` на таком бросает СИНХРОННО
 * (`ERR_INVALID_CHAR`, `ERR_UNESCAPED_CHARACTERS`, `ERR_INVALID_HTTP_TOKEN`), а бросок из нативного колбэка uWS — это
 * выход процесса со всеми комнатами ноды от одного анонимного запроса. Кривое получает 400 от самого прокси.
 */
const METHOD_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;   // RFC 9110: метод — токен
/** Путь с запросом — печатный ASCII без пробелов; честный клиент прочее экранирует `%XX`. */
const PATH_RE = /^\/[\x21-\x7e]*$/;
/** Годится ли запрос к пересылке: метод, путь и каждый заголовок — те, что `http.request` пропустит. */
export function proxyableRequest(method: string, path: string, headers: Record<string, string>): boolean {
  if (!METHOD_RE.test(method) || !PATH_RE.test(path)) return false;
  try {
    for (const [k, v] of Object.entries(headers)) { validateHeaderName(k); validateHeaderValue(k, v); }
  } catch {
    return false;
  }
  return true;
}

/**
 * ⭐ R12-01: ЗАГОЛОВКИ СОЕДИНЕНИЯ И ДЛИНЫ КЛИЕНТА ДАЛЬШЕ ПРОКСИ НЕ ИДУТ. Они описывают соединение клиента с прокси, а не прокси с
 * express: длину тела прокси ставит свою (ровно то, что собрал), кодирование и жизнь соединения решает `http.request`. Раньше
 * `Content-Length` GET-запроса уходил в express при пустом теле, и тот ждал тела — следующими байтами того же соединения.
 */
const HOP_HEADERS: readonly string[] = [
  'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer', 'expect',
];

/** `ws.send` uWS: кадр не отправлен — исходящая очередь клиента выше `maxBackpressure`. */
const SEND_DROPPED = 2;

/** Обёртка сокета uWS → `GameConn`. Живёт ровно одно соединение. */
class UwsConn implements GameConn {
  open = true;
  onMsg?: (raw: string) => void;
  onEnd?: () => void;
  /**
   * ⭐ R18-01: идёт отправка кадра (или сокет закрыт ею). uWS зовёт обработчик закрытия синхронно — изнутри `end` (и `send`, если закрывает сам,
   * `closeOnBackpressureLimit`): закрытие ИЗ ОТПРАВКИ снимало сессию поперёк синхронного шага комнаты, который эту отправку делал (см. `ended`).
   */
  private sending = false;
  constructor(private readonly ws: UwsSocket, readonly ip: string, readonly routePass?: string) {}
  send(data: string | Uint8Array): void {
    if (!this.open) return;
    // ⭐ R6-07: ОЧЕРЕДЬ ПЕРЕПОЛНЯЕТСЯ — КЛИЕНТ ОТКЛЮЧАЕТСЯ, как на транспорте `ws` (1013). Раньше сверх `maxBackpressure` uWS
    // молча не отправлял кадр (код 2), а сокет держал: кадры смены этажа, сейва, ответов на команды и голосований пропадали,
    // а клиент (его ввод продлевал жизнь сокета) стоял на старой карте со старым сейвом и держал голосования пати.
    // Закрываем ДО переполнения: сверх потолка uWS не отправит и закрывающий кадр — клиент узнал бы только обрыв. Пустую
    // очередь кадр не переполняет по определению (как и у самого uWS): большой кадр честному клиенту уходит.
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    let status: number;
    // uWS бросает, если сокет уже закрыт «под нами» (клиент отвалился между тиком и отправкой).
    this.sending = true;
    try {
      const queued = this.ws.getBufferedAmount();
      status = queued > 0 && queued + size > MAX_BACKPRESSURE
        ? SEND_DROPPED
        : this.ws.send(typeof data === 'string' ? data : data, typeof data !== 'string');
    } catch { this.open = false; return; } finally { this.sending = false; }
    if (status === SEND_DROPPED) {
      counters.slowClientsDropped++;
      this.sending = true;   // ⭐ R18-01: закрытие из отправки — снятие сессии микрозадачей (`ended`)
      this.close(1013, 'slow-client');
    }
  }
  close(code?: number, reason?: string): void {
    if (!this.open) return;
    this.open = false;
    // `end` — закрытие с кодом по протоколу; клиент увидит 4001/4008, как и на транспорте ws.
    try { this.ws.end(code ?? 1000, reason ?? ''); } catch { /* уже закрыт */ }
  }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  /**
   * Обработчик закрытия транспорта (событие `close` uWS) — ровно один раз. ⭐ R18-01: закрытие, начатое отправкой (очередь выше потолка), зовёт
   * его ближайшей микрозадачей, а не изнутри `send`: отправку делает комната посреди синхронного шага (рассылка мира, окна смерти), и снятие
   * сессии (`RoomManager.onClose` → `removePlayer`) поперёк него снимало копию погибшего в этом тике до штрафа («оплачено» без штрафа), а голос,
   * проходящий на снятии, переносил пати посреди рассылки. Сокет закрыт сразу (`open` — ложь): кадры не идут ни туда, ни сюда.
   */
  ended(): void {
    this.open = false;
    const cb = this.onEnd;
    this.onEnd = undefined;
    if (!cb) return;
    if (this.sending) queueMicrotask(cb); else cb();
  }
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
  const app = mountGameWs(uWS.App(), gameWsBehavior(uWS, (conn) => rooms.handleConnection(conn)));

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

/**
 * ⭐ R4-13: игровой сокет на `/ws` и `/ws/<i>` — путь за прокси по путям (DEPLOY.md §3a, вариант А): гейтвей отдаёт
 * `wss://домен/ws/<i>`, прокси пересылает путь как есть, а нода слушала только ровно `/ws` (`/ws/0` → 404). Шаблон uWS
 * `/ws/*` шире — лишнее под ним отсекает `upgrade` (`isGameWsPath`). Экспорт — для теста.
 */
export function mountGameWs<A extends Pick<UwsApp, 'ws'>>(app: A, behavior: Record<string, unknown>): A {
  app.ws('/ws', behavior);
  app.ws('/ws/*', behavior);
  return app;
}

/**
 * Поведение игрового сокета `/ws`: каждое новое соединение уходит в `onConn` обёрткой `GameConn`. Экспорт — для теста
 * адреса (R4-29).
 *
 * ⭐ R4-29: АДРЕС ИГРОКА — ИЗ АПГРЕЙДА. За обратным прокси (Caddy, DEPLOY §3a/§4) собеседник сокета — сам прокси на петле,
 * и `open` видел 127.0.0.1 у каждого: `play_sessions.ip` одинаков у всех, а сигнал «рой с одного адреса» срабатывал на
 * любого, кто играл одновременно с тремя другими. Заголовки у uWS есть только в `upgrade` — там адрес и решается, тем же
 * правилом, что у HTTP (`clientIp`: `X-Forwarded-For` читается, только если собеседник — доверенный прокси, и справа).
 */
export function gameWsBehavior(uWS: Pick<Uws, 'DISABLED'>, onConn: (conn: GameConn) => void): Record<string, unknown> {
  const conns = new Map<UwsSocket, UwsConn>();
  return {
    // Сжатие выключено по той же причине, что и на `ws` — см. комментарий в wsServer.ts.
    compression: uWS.DISABLED,
    // Клиент шлёт только маленькие JSON-кадры ввода; всё крупное — повод закрыть соединение (общий потолок, R2-18).
    maxPayloadLength: MAX_FRAME_BYTES,
    // Молчащего клиента (обрыв интернета, TCP ещё висит) закрываем сами — иначе в комнате
    // копится «призрак» игрока. uWS шлёт ping автоматически, свой heartbeat не нужен.
    idleTimeout: 32,
    // Потолок неотправленного на клиента: кто не успевает читать — отключается, а не съедает
    // память сервера. На `ws` эту роль играет рост bufferedAmount (`WsConn.send`).
    // ⭐ R6-07: и ОТКЛЮЧАЕТСЯ — сам uWS сверх потолка только отказывает в отправке (код 2), а сокет держит. Закрывает
    // `UwsConn.send` — до переполнения, чтобы клиент получил 1013 (счётчик `dm_slow_clients_dropped_total`);
    // `closeOnBackpressureLimit` — вторая линия для отправок мимо него (пинги uWS).
    maxBackpressure: MAX_BACKPRESSURE,
    closeOnBackpressureLimit: true,
    upgrade: (res: UwsRes, req: UwsReq, context: unknown) => {
      // R4-13: под шаблоном `/ws/*` игровой сокет — только `/ws/<номер>` (см. `mountGameWs`).
      if (!isGameWsPath(req.getUrl())) { res.writeStatus('404 Not Found').end(); return; }
      const headers: Record<string, string> = {};
      req.forEach((k, v) => { headers[k] = v; });
      const ip = clientIp(headers, dec.decode(res.getRemoteAddressAsText()));
      // R13-08: пропуск маршрута гейтвея (`?lp=`) — только здесь: запрос у uWS живёт лишь до конца `upgrade`.
      const query = req.getQuery();
      const pass = query ? routePassOf(`?${query}`) : undefined;
      res.upgrade({ ip, ...(pass ? { pass } : {}) }, req.getHeader('sec-websocket-key'), req.getHeader('sec-websocket-protocol'),
        req.getHeader('sec-websocket-extensions'), context);
    },
    open: (ws: UwsSocket) => {
      const conn = new UwsConn(ws, ws.getUserData().ip ?? dec.decode(ws.getRemoteAddressAsText()), ws.getUserData().pass);
      conns.set(ws, conn);
      onConn(conn);
    },
    message: (ws: UwsSocket, msg: ArrayBuffer, isBinary: boolean) => {
      // От клиента приходит только текст (JSON). Двоичный кадр вверх — не наш протокол.
      // ⭐ R13-07: и НАРУШЕНИЕ — соединение закрывается (1003), кадр считается отброшенным. Раньше он молча пропускался ДО игры: мимо
      // счётчика кадров, потолков `wsFrames`/`wsInput` и закрытия 4008 (всё это — в `RoomManager.accept`), а каждый кадр ещё и продлевал
      // `idleTimeout` — анонимный сокет без входа гнал миллионы пустых двоичных кадров без предела. Честный клиент их не шлёт никогда.
      if (isBinary) {
        counters.framesInvalid++;
        conns.get(ws)?.close(1003, 'binary not accepted');
        return;
      }
      // R2-01: бросок из обработчика внутри нативного колбэка uWS — это падение процесса. Гасим кадр.
      try { conns.get(ws)?.onMsg?.(dec.decode(msg)); } catch (e) { frameFailed(e); }
    },
    close: (ws: UwsSocket) => {
      const conn = conns.get(ws);
      conns.delete(ws);
      conn?.ended();   // R18-01: закрытое изнутри отправки — микрозадачей
    },
  };
}

/**
 * Переправить один HTTP-запрос express-серверу на петле и вернуть его ответ дословно. Экспорт — для теста доступа.
 *
 * ⭐ R5-01: НЕ БРОСАЕТ НИКОГДА — зовётся из нативного колбэка uWS, и бросок здесь был бы выходом процесса. Кривой запрос
 * (`proxyableRequest`) — 400 до пересылки; любой бросок, что всё же случился (в том числе в колбэке тела), — 400 и строка
 * в лог (через общий глушитель: поток таких запросов лог не топит).
 */
export function proxyToExpress(res: UwsRes, req: UwsReq, httpPort: number): void {
  // onAborted ОБЯЗАТЕЛЕН до первого await/асинхронного шага: без него uWS роняет процесс,
  // если клиент отвалился раньше ответа.
  let aborted = false;
  // R7-10: клиент ушёл — бросить и запрос к express (обработчик у uWS один: остальные — списком).
  const onAbort: (() => void)[] = [];
  /** R7-10: ответ express уже пошёл клиенту (`relayResponse`) — свой отказ прокси поверх него не пишет. */
  let relayed = false;
  res.onAborted(() => {
    aborted = true;
    for (const f of onAbort.splice(0)) { try { f(); } catch (e) { frameFailed(e); } }
  });
  /** Отказ от самого прокси (ответ ровно один: дальше `res` не трогаем); `close` — закрыть и соединение. */
  const refuse = (status: string, body: string, close = false): void => {
    if (aborted || relayed) return;
    aborted = true;
    try { res.cork(() => { res.writeStatus(status).writeHeader('content-type', 'application/json').end(body, close); }); } catch { /* сокет уже закрыт */ }
  };
  const badRequest = (e?: unknown): void => {
    if (e !== undefined) frameFailed(e);
    refuse('400 Bad Request', '{"error":"Неверный запрос"}', true);
  };
  try {
    forwardRequest(res, req, httpPort, () => aborted, refuse, badRequest, (f) => { onAbort.push(f); }, () => { relayed = true; });
  } catch (e) {
    badRequest(e);
  }
}

/** Тело `proxyToExpress`: разбор, проверка и пересылка. Бросок отсюда ловит вызывающий. */
function forwardRequest(
  res: UwsRes, req: UwsReq, httpPort: number, isAborted: () => boolean,
  refuse: (status: string, body: string, close?: boolean) => void, badRequest: (e?: unknown) => void,
  onAbort: (f: () => void) => void, relaying: () => void,
): void {
  const method = req.getMethod().toUpperCase();
  const query = req.getQuery();
  const path = req.getUrl() + (query ? `?${query}` : '');
  const headers: Record<string, string> = {};
  req.forEach((k, v) => { headers[k] = v; });
  if (!proxyableRequest(method, path, headers)) { badRequest(); return; }
  // ⭐ R12-01: ЗАПРОС БЕЗ ТЕЛА С ЗАЯВЛЕННЫМ ТЕЛОМ — 400. Такого честный клиент не шлёт, а пересланный как есть (`Content-Length`
  // при пустом теле) он съедал голову следующего запроса на том же соединении с express как своё тело (см. `HOP_HEADERS`).
  const bodiless = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const declared = Number(headers['content-length'] ?? 0);
  if (bodiless && (headers['transfer-encoding'] !== undefined || declared !== 0)) { badRequest(); return; }
  for (const h of HOP_HEADERS) delete headers[h];
  delete headers[LOCAL_PROOF_HEADER];   // R12-01: доказательство локальности ставит только сам прокси (ниже)
  // ⭐ R3-03, R3-07: АДРЕС КЛИЕНТА РЕШАЕТ ЭТОТ ПРОКСИ, а express получает его готовым. Раньше заголовок клиента
  // проходил насквозь (его «первый адрес» и был ключом лимитов входа — подменяй на каждую попытку), а без заголовка
  // express видел петлю у КАЖДОГО запроса — служебные ручки «только с самой машины» были открыты всем.
  //  • Собеседник с петли и без заголовков прокси — это сама машина (стенд, мониторинг): переправляем как есть, и
  //    express видит ровно то, что есть, — прямой локальный вызов (⭐ R12-01: с доказательством прокси, `localCaller`).
  //  • Иначе `X-Forwarded-For` ПЕРЕЗАПИСЫВАЕТСЯ одним адресом клиента (`clientIp`: заголовок читается, только если
  //    собеседник — доверенный прокси, и справа). Заголовок есть — служебные ручки закрыты (`localCaller`).
  const peer = dec.decode(res.getRemoteAddressAsText());
  if (!isLoopback(peer) || PROXY_HEADERS.some((h) => headers[h] !== undefined)) headers['x-forwarded-for'] = clientIp(headers, peer);
  else headers[LOCAL_PROOF_HEADER] = proxyLinks.proof();   // R12-01: прямой вызов с самой машины — с доказательством
  // Тело ЗАПРОСА собираем целиком (под потолком пути, R4-11): через прокси идут только запросы аккаунтов/конфига и загрузка
  // моделей из редактора — редкие и обозримые. Игровой трафик сюда не попадает. ⭐ R7-10: а ОТВЕТ течёт клиенту потоком
  // (`relayResponse`): он бывает и мегабайтами (статика `/assets`, конфиг), и копить его целиком прокси не может.
  // ⭐ R12-01: длина тела — СВОЯ (ровно собранное), а соединение с express — на ОДИН запрос (`agent: false`). Раньше запрос шёл
  // через общий пул Node (в Node 24 он держит соединения живыми) — соединение делили чужие клиенты, и сбитая длина одного
  // становилась чужим запросом у express.
  const forward = (body: Buffer): void => {
    /** Тело ушло в сокет: дальнейший сброс — это ответ express, потерянный вместе со сбросом, а не «нет связи». */
    let wrote = false;
    if (!bodiless) headers['content-length'] = String(body.length);
    const upstream = httpRequest(
      { host: '127.0.0.1', port: httpPort, path, method, headers, agent: false },
      (up) => relayResponse(res, up, method, isAborted, onAbort, relaying),
    );
    onAbort(() => upstream.destroy());   // R7-10: клиент ушёл — запрос к express больше не нужен
    // ⚠ СБРОС ПОСЛЕ ОТПРАВКИ ТЕЛА — ЭТО НЕ «НЕ ДОСТУЧАЛСЯ», И ЭТА ФОРМУЛИРОВКА УВОДИЛА В СТОРОНУ ПОЛДНЯ.
    // Express, отказавший ДО чтения тела (`devGate`: 401/403/429), закрывает соединение сбросом, а сброс уносит из
    // приёмного буфера и сам ответ — прокси видит только `read ECONNRESET`. Достучался он прекрасно, и отказ был
    // осмысленный. Лечится на стороне express (`drainRequest`), а здесь — честное имя происходящего: связь была.
    upstream.on('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      const cut = wrote && (code === 'ECONNRESET' || code === 'EPIPE');
      refuse('502 Bad Gateway', JSON.stringify({
        error: cut
          ? `express оборвал соединение, не дочитав тело (${(body.length / (1024 * 1024)).toFixed(1)} МБ) — его ответ пропал вместе со сбросом. Обычно это отказ входа или прав: войди заново и повтори`
          : `прокси не достучался до express: ${e.message}`,
      }));
    });
    // R12-01: соединение — прокси: пока оно открыто, express не верит на нём «петле без заголовков» без доказательства.
    upstream.on('socket', (s) => {
      s.once('connect', () => {
        const port = s.localPort;
        if (port === undefined) return;
        proxyLinks.open(port);
        s.once('close', () => proxyLinks.close(port));
      });
    });
    upstream.end(body.length ? body : undefined);
    wrote = true;
  };

  // У запросов без тела ждать `onData` нельзя — переправляем сразу.
  if (bodiless) { forward(EMPTY); return; }

  // ⭐ R4-11: тело — под потолком пути. Заявлено больше — отказ сразу, до тела; пришло больше (chunked, без длины) — отказ
  // на первом лишнем байте, накопленное выбрасывается, соединение закрывается (иначе клиент продолжал бы слать).
  const cap = bodyCapFor(req.getUrl());
  const tooLarge = (): void => { refuse('413 Payload Too Large', '{"error":"Слишком большое тело запроса"}'); };
  if (Number.isFinite(declared) && declared > cap) { tooLarge(); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  res.onData((chunk, isLast) => {
    if (isAborted()) return;
    // R5-01: колбэк тела — тоже нативный: пересылка из него не бросает наружу.
    try {
      size += chunk.byteLength;
      if (size > cap) { chunks.length = 0; tooLarge(); return; }
      // Буфер uWS переиспользуется между вызовами — копия обязательна, иначе тело затрётся.
      if (chunk.byteLength) chunks.push(Buffer.from(new Uint8Array(chunk).slice()));
      if (isLast) forward(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
    } catch (e) { badRequest(e); }
  });
}

/**
 * ⭐ R7-10: ОТВЕТ express — КЛИЕНТУ ПОТОКОМ, С ОБРАТНЫМ ДАВЛЕНИЕМ. Раньше прокси собирал ответ целиком (`Buffer.concat`) и
 * отдавал одним куском: аноним, запросивший 13 МБ GLB из `/assets` (или конфиг, ~0,5 МБ) и не читающий ответ, держал на ноде
 * весь файл, а поток таких запросов раздувал память ноды на «размер × число запросов» (и ещё стоил цикла событий). Теперь
 * кусок ответа уходит клиенту, как только пришёл; не взял сокет — прокси перестаёт читать у express (`pause`), пока клиент не
 * разгребёт (`onWritable`). Длина известна — `tryEnd` (uWS сам ставит `Content-Length`, клиент видит прогресс загрузки);
 * нет — куски без длины (`write`). Клиент ушёл — ответ express брошен (`onAbort`), а не дочитан в память.
 *
 * R5-01: колбэки событий и нативные колбэки uWS — бросок из них был бы выходом процесса: всё, что трогает `res`, — под `try`.
 */
function relayResponse(
  res: UwsRes, up: IncomingMessage, method: string, isAborted: () => boolean,
  onAbort: (f: () => void) => void, relaying: () => void,
): void {
  onAbort(() => up.destroy());
  if (isAborted()) { up.destroy(); return; }
  relaying();
  const code = up.statusCode ?? 500;
  const bodiless = method === 'HEAD' || code === 204 || code === 304 || code < 200;
  const declared = Number(up.headers['content-length']);
  const total = !bodiless && up.headers['content-length'] !== undefined && Number.isSafeInteger(declared) && declared >= 0 ? declared : -1;
  let headed = false;
  /** Ответ окончен или оборван — `res` больше не трогаем. */
  let over = false;
  /** Кусок, который uWS не взял целиком (`tryEnd` при обратном давлении), и смещение ответа, с которого он начинался. */
  let pending: Buffer | null = null;
  let pendingAt = 0;
  const head = (): void => {
    if (headed) return;
    headed = true;
    res.writeStatus(`${code} ${up.statusMessage ?? ''}`.trim());
    for (const [k, v] of Object.entries(up.headers)) {
      // Длину и кодирование считает сам uWS — свои значения тут только всё сломают.
      if (k === 'content-length' || k === 'transfer-encoding' || k === 'connection') continue;
      if (Array.isArray(v)) for (const one of v) res.writeHeader(k, one);
      else if (v != null) res.writeHeader(k, String(v));
    }
  };
  /** Вне колбэков uWS запись в `res` — только внутри `cork` (иначе uWS шлёт каждый кусок отдельным пакетом и шумит в лог). */
  const corked = (f: () => void): void => {
    if (over || isAborted()) return;
    try { res.cork(f); } catch (e) { over = true; up.destroy(); frameFailed(e); }
  };
  /** Ответ express оборвался посреди тела — клиенту обрыв соединения, а не «успех» с дырой. */
  const cut = (): void => {
    if (over || isAborted()) return;
    over = true;
    try { res.close(); } catch { /* уже закрыт */ }
  };
  res.onWritable((offset) => {
    if (over || isAborted()) return true;
    try {
      if (total < 0) { up.resume(); return true; }   // без длины кусок держит сам uWS — читать дальше
      if (!pending) return true;
      const [ok, done] = res.tryEnd(pending.subarray(offset - pendingAt), total);
      if (done) { over = true; pending = null; } else if (ok) { pending = null; up.resume(); }
      return ok;
    } catch (e) { over = true; up.destroy(); frameFailed(e); return true; }
  });
  up.on('data', (chunk: Buffer) => corked(() => {
    head();
    if (total < 0) { if (!res.write(chunk)) up.pause(); return; }
    // Кусок пришёл, пока прошлый ждёт дописки (на паузе так не бывает, но порядок байт дороже): в хвост ждущего.
    if (pending) { pending = Buffer.concat([pending, chunk]); up.pause(); return; }
    pendingAt = res.getWriteOffset();
    const [ok, done] = res.tryEnd(chunk, total);
    if (done) over = true;
    else if (!ok) { pending = chunk; up.pause(); }
  }));
  up.on('end', () => {
    if (over || isAborted()) return;
    // Длина объявлена: конец ответа — последний `tryEnd` (или его дописка в `onWritable`); кончилось раньше длины — обрыв.
    if (total > 0) { if (!pending) cut(); return; }
    corked(() => { head(); over = true; res.end(); });
  });
  up.on('aborted', cut);
  up.on('error', cut);
  up.on('close', () => { if (!up.complete) cut(); });   // соединение с express порвалось посреди ответа (любая версия Node)
}
