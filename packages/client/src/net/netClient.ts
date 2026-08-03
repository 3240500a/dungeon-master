import type { ClientFrame, ServerFrame } from '@dm/shared';

type Handler = (frame: ServerFrame) => void;

/**
 * Тонкая обёртка над WebSocket к авторитетному серверу (`/ws`, dev — через Vite-proxy).
 * Клиент шлёт `ClientFrame`, получает `ServerFrame`. Один обработчик на тип кадра
 * (`on(t, cb)`), плюс `onOpen`/`onClose`. Реконнект — базовый (по желанию позже).
 */
const PING_INTERVAL_MS = 1000;

export class NetClient {
  private ws?: WebSocket;
  private handlers = new Map<ServerFrame['t'], Handler[]>();
  private openCbs: (() => void)[] = [];
  private closeCbs: (() => void)[] = [];
  // Замер задержки: раз в секунду шлём ping с id, ловим pong → RTT. -1 = ещё нет замера.
  private pingTimer?: ReturnType<typeof setInterval>;
  private pingId = 0;
  private pingSentAt = new Map<number, number>();
  private _rtt = -1;
  private _netMs = 0;   // сглаженная стоимость обработки кадра сервера (JSON.parse + диспатч) на главном потоке — профиль спайков снапшота

  /** Последний измеренный RTT (мс), −1 если ещё не измерен / нет соединения. */
  get rtt(): number { return this._rtt; }
  /** Сглаженное время обработки серверного кадра (мс): парс снапшота + применение. Для DBG-профиля. */
  get netMs(): number { return this._netMs; }

  connect(url = wsUrl()): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.startPing(); for (const cb of this.openCbs) cb(); };
    ws.onclose = () => { this.stopPing(); this._rtt = -1; for (const cb of this.closeCbs) cb(); };
    ws.onmessage = (ev) => {
      const _t = performance.now();
      let frame: ServerFrame;
      try { frame = JSON.parse(ev.data as string) as ServerFrame; } catch { return; }
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

  on<T extends ServerFrame['t']>(t: T, cb: (frame: Extract<ServerFrame, { t: T }>) => void): void {
    const list = this.handlers.get(t) ?? [];
    list.push(cb as Handler);
    this.handlers.set(t, list);
  }
  onOpen(cb: () => void): void { this.openCbs.push(cb); }
  onClose(cb: () => void): void { this.closeCbs.push(cb); }

  /** Снять все обработчики типа кадра (сцена пере-подписывается при каждом входе — иначе дубли). */
  off<T extends ServerFrame['t']>(t: T): void { this.handlers.delete(t); }
  /** Сбросить onOpen/onClose-колбэки (владелец — сцена; при перезапуске вешаются заново). */
  clearLifecycle(): void { this.openCbs = []; this.closeCbs = []; }

  send(frame: ClientFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  close(): void { this.stopPing(); this.ws?.close(); this.ws = undefined; }
}

/** Адрес WS: dev — тот же хост (Vite проксирует /ws на :3001); прод — VITE_WS_URL. */
function wsUrl(): string {
  const env = (import.meta as { env?: Record<string, string> }).env?.VITE_WS_URL;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
