import { decodeWorldFrame, applyWorldDelta, emptySnapshot, WIRE_FULL, type ClientFrame, type ServerFrame, type WorldSnapshot } from '@dm/shared';

type Handler = (frame: ServerFrame) => void;

/**
 * Тонкая обёртка над WebSocket к авторитетному серверу (`/ws`, dev — через Vite-proxy).
 * Клиент шлёт `ClientFrame`, получает `ServerFrame`. Обработчики по типу кадра (`on(t, cb)`),
 * плюс `onOpen`/`onClose`; каждая подписка возвращает свою отписку. Реконнект — базовый (по желанию позже).
 */
const PING_INTERVAL_MS = 1000;
/** ⭐ R15-04: неотправленного в сокете больше этого (≈20 кадров ввода) — связь встала: ввод не шлём (`send`). */
const INPUT_BACKLOG_BYTES = 4096;

export class NetClient {
  private ws?: WebSocket;
  private handlers = new Map<ServerFrame['t'], Handler[]>();
  private openCbs: (() => void)[] = [];
  /** Обработчики закрытия получают код закрытия сокета (R3-25): 4009 — сессия устарела, 4001 — вход из другого окна. */
  private closeCbs: ((code?: number) => void)[] = [];
  // Замер задержки: раз в секунду шлём ping с id, ловим pong → RTT. -1 = ещё нет замера.
  private pingTimer?: ReturnType<typeof setInterval>;
  private pingId = 0;
  private pingSentAt = new Map<number, number>();
  private _rtt = -1;
  private _netMs = 0;
  /** Ф1.4: своя копия мира — к ней применяются двоичные дельты. */
  private world?: WorldSnapshot;
  /** Контрольная сумма последнего кадра (Ф1.3) — для диагностики расхождений. */
  private lastSum = 0;

  /** Сумма, пришедшая с последним кадром мира. Совпадение с `worldChecksum` своей копии = всё сошлось. */
  get worldSum(): number { return this.lastSum; }   // сглаженная стоимость обработки кадра сервера (JSON.parse + диспатч) на главном потоке — профиль спайков снапшота

  /** Последний измеренный RTT (мс), −1 если ещё не измерен / нет соединения. */
  get rtt(): number { return this._rtt; }
  /** Сглаженное время обработки серверного кадра (мс): парс снапшота + применение. Для DBG-профиля. */
  get netMs(): number { return this._netMs; }

  /**
   * Открыть соединение. ⭐ L2: живой — только ПОСЛЕДНИЙ сокет. Прежний (ещё соединяется, закрывается) закрываем и
   * глушим: его позднее закрытие сносило бы уже новую сессию (плашка «соединение потеряно» и ещё одно переподключение),
   * а его кадры шли бы в обработчики новой. Копия мира — тоже с чистого листа: первая дельта нового сокета до его
   * полного кадра к миру прошлого не применяется.
   */
  connect(url = wsUrl()): void {
    const old = this.ws;
    if (old) {
      old.onopen = null; old.onclose = null; old.onmessage = null;
      try { old.close(); } catch { /* уже закрыт */ }
    }
    this.stopPing();
    this._rtt = -1;
    this.world = undefined;
    this.lastSum = 0;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';   // Ф1.4: кадры мира приходят двоичными
    this.ws = ws;
    ws.onopen = () => { if (this.ws !== ws) return; this.startPing(); for (const cb of this.openCbs) cb(); };
    ws.onclose = (ev) => { if (this.ws !== ws) return; this.stopPing(); this._rtt = -1; for (const cb of this.closeCbs) cb(ev?.code); };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const _t = performance.now();
      let frame: ServerFrame;
      if (typeof ev.data !== 'string') {
        // Ф1.4: двоичный кадр мира. Раскодируем, применяем к своей копии и отдаём сцене
        // в привычном виде `snapshot` — весь код выше по стеку об этом не знает.
        const f = decodeWorldFrame(new Uint8Array(ev.data as ArrayBuffer));
        const base = f.kind === WIRE_FULL ? emptySnapshot() : this.world;
        if (!base) return;                       // дельта до первого полного кадра — ждём его
        this.world = applyWorldDelta(base, f.delta);
        this.lastSum = f.sum;
        frame = { t: 'snapshot', snap: this.world };
        for (const h of this.handlers.get('snapshot') ?? []) h(frame);
        this._netMs += (performance.now() - _t - this._netMs) * 0.08;
        return;
      }
      try { frame = JSON.parse(ev.data) as ServerFrame; } catch { return; }
      if (frame.t === 'pong') { // транспортный кадр — не отдаём в обработчики сцены (и не мерим netMs)
        const sent = this.pingSentAt.get(frame.id);
        if (sent != null) { this._rtt = Math.round(performance.now() - sent); this.pingSentAt.delete(frame.id); }
        return;
      }
      for (const h of this.handlers.get(frame.t) ?? []) h(frame);
      this._netMs += (performance.now() - _t - this._netMs) * 0.08;   // парс+применение серверного кадра (в основном снапшоты)
    };
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const id = ++this.pingId;
      this.pingSentAt.set(id, performance.now());
      if (this.pingSentAt.size > 20) this.pingSentAt.delete(this.pingSentAt.keys().next().value!); // не копим неотвеченные
      this.send({ t: 'ping', id });
    }, PING_INTERVAL_MS);
  }
  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
    this.pingSentAt.clear();
  }

  /**
   * Подписаться на кадр типа `t`. Возвращает отписку — ровно этого обработчика (R5-16): владелец, живущий меньше
   * `NetClient` (драйвер сцены), снимает свои подписки сам, а не копит их до перезагрузки страницы.
   * ⭐ R19-02: ДРУГОГО СНЯТИЯ НЕТ. Был `off(t)` — снять ВСЕ обработчики типа (и `clearLifecycle` — все open/close): 2D-сцена звала его на каждом
   * входе и снимала заодно подписки `App` (штамп сборки на `joined`, R18-08) — деплой со сменой кода цен шёл молча, как до R18-08.
   */
  on<T extends ServerFrame['t']>(t: T, cb: (frame: Extract<ServerFrame, { t: T }>) => void): () => void {
    const list = this.handlers.get(t) ?? [];
    list.push(cb as Handler);
    this.handlers.set(t, list);
    return () => {
      const cur = this.handlers.get(t);
      if (cur) this.handlers.set(t, cur.filter((h) => h !== cb));
    };
  }
  /** Сокет открылся. Отписка — ровно этого колбэка (R19-02), как у `on`. */
  onOpen(cb: () => void): () => void {
    this.openCbs.push(cb);
    return () => { this.openCbs = this.openCbs.filter((c) => c !== cb); };
  }
  /** Сокет закрылся (код закрытия — R3-25). Отписка — ровно этого колбэка (R19-02). */
  onClose(cb: (code?: number) => void): () => void {
    this.closeCbs.push(cb);
    return () => { this.closeCbs = this.closeCbs.filter((c) => c !== cb); };
  }
  /** Сбросить копию мира (смена области/переподключение) — следующий полный кадр задаст новую. */
  resetWorld(): void { this.world = undefined; }

  send(frame: ClientFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // ⭐ R15-04: связь встала, а сокет жив (роуминг Wi-Fi, смена соты) — ввод не копится в буфере сокета: вернувшаяся связь отдала бы
    // серверу секунды накопленного ввода разом (сервер его отбросит, а поток сверх меры рвёт кодом 4008), а устаревшее нажатие сработало бы
    // с опозданием. Комната берёт последний ввод, и следующий кадр после разгрузки буфера несёт текущее состояние.
    if (frame.t === 'input' && this.ws.bufferedAmount > INPUT_BACKLOG_BYTES) return;
    this.ws.send(JSON.stringify(frame));
  }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  close(): void { this.stopPing(); this.ws?.close(); this.ws = undefined; }
}

/** Адрес ноды, заданный сборкой (`VITE_WS_URL`): клиент прибит к нему, маршрут у гейтвея не спрашивает. */
function pinnedWsUrl(): string | undefined {
  return (import.meta as { env?: Record<string, string> }).env?.VITE_WS_URL || undefined;
}

/** Адрес WS: dev — тот же хост (Vite проксирует /ws на :3001); прод — VITE_WS_URL. */
function wsUrl(): string {
  const env = pinnedWsUrl();
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/** Адрес на петле — достижим только с той машины, где открыт. */
const isLoopback = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]' || host === '::1';

/**
 * ⭐ R4-13: АДРЕС НОДЫ ИЗ ОТВЕТА ГЕЙТВЕЯ — таким, каким до неё дойдёт БРАУЗЕР.
 *  • Относительный путь (`/ws/0`) — от origin страницы, `wss:` на https.
 *  • Адрес на петле (`ws://127.0.0.1:3001/ws` — умолчание одиночного процесса без `DM_NODE_URL`) достижим только с
 *    машины сервера. Страница открыта не с неё — значит, между ними прокси (Caddy), и путь тот же, но на origin страницы:
 *    иначе каждый игрок одиночного сервера за доменом стучался бы к себе на 127.0.0.1.
 *  • ⭐ R10-17: страница по https, а узел назван `ws://` не на петле (DEPLOY, вариант Б) — `wss://` у того же хоста и порта.
 *    `ws://` браузер со страницы https не откроет вовсе (смешанное содержимое: конструктор сокета бросает `SecurityError`);
 *    с `wss://` узел за TLS соединится, а узел без TLS даст обычное «Сервер недоступен» с кнопкой лобби.
 */
export function nodeUrl(raw: string, page: Pick<Location, 'protocol' | 'host' | 'hostname'> = location): string {
  const proto = page.protocol === 'https:' ? 'wss:' : 'ws:';
  let u: URL;
  try { u = new URL(raw, `${proto}//${page.host}`); } catch { return `${proto}//${page.host}/ws`; }
  if (isLoopback(u.hostname) && !isLoopback(page.hostname)) return `${proto}//${page.host}${u.pathname}${u.search}`;
  if (proto === 'wss:' && u.protocol === 'ws:' && !isLoopback(u.hostname)) u.protocol = 'wss:';
  return u.toString();
}

/**
 * Ответ гейтвея «куда подключаться» (Ф4.1): адрес ноды, место в очереди или отказ. `code` у отказа — чей вход
 * недействителен: аккаунта (`auth`, 401) или героя (`forbidden`, 403) — клиент уводит на вход / выбор героя.
 */
export type RouteAnswer =
  | { url: string }
  | { queue: { ticket: string; position: number; total: number } }
  | { error: string; code?: 'auth' | 'forbidden' };

/**
 * Ф4.1: спросить у гейтвея, к какому узлу подключаться. Возвращает либо адрес, либо место
 * в очереди — очередь это НЕ ошибка, а штатный ответ на потолке кластера: держать людей
 * в очереди дешевле, чем принять всех и лечь.
 *
 * ⭐ R4-13: зовёт поток входа (`entryFlow.ts`) перед КАЖДЫМ подключением — раньше не звал никто, и кластер из DEPLOY.md
 * был недоступен веб-клиентам: сокет шёл на origin, то есть к гейтвею, у которого игрового сокета нет. Отказ гейтвея
 * (4xx с причиной: «Комната не найдена: узел не отвечает», «Слишком часто», «Требуется вход») — строкой игроку. Если
 * маршрутизации нет или она сломалась (старый сервер, сеть, 5xx) — обычный адрес, и клиент работает как раньше.
 * Адрес задан сборкой (`VITE_WS_URL`) — к нему, без запроса.
 */
export async function routeToNode(token: string, charId: string, ticket?: string, roomCode?: string): Promise<RouteAnswer> {
  const pinned = pinnedWsUrl();
  if (pinned) return { url: pinned };
  const qs = new URLSearchParams({ charId });
  if (ticket) qs.set('ticket', ticket);
  if (roomCode) qs.set('roomCode', roomCode);
  try {
    const r = await fetch(`/api/route?${qs.toString()}`, { headers: { authorization: `Bearer ${token}` } });
    const b = (await r.json().catch(() => null)) as { url?: unknown; queue?: { ticket: string; position: number; total: number }; error?: unknown } | null;
    if (r.ok && typeof b?.url === 'string') return { url: nodeUrl(b.url) };
    if (r.status === 503 && b?.queue) return { queue: b.queue };
    if (r.status >= 400 && r.status < 500 && typeof b?.error === 'string') {
      return { error: b.error, ...(r.status === 401 ? { code: 'auth' as const } : r.status === 403 ? { code: 'forbidden' as const } : {}) };
    }
  } catch { /* сети нет — падём на общий адрес ниже */ }
  return { url: wsUrl() };
}
