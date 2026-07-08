import type { ClientFrame, ServerFrame } from '@dm/shared';

type Handler = (frame: ServerFrame) => void;

/**
 * Тонкая обёртка над WebSocket к авторитетному серверу (`/ws`, dev — через Vite-proxy).
 * Клиент шлёт `ClientFrame`, получает `ServerFrame`. Один обработчик на тип кадра
 * (`on(t, cb)`), плюс `onOpen`/`onClose`. Реконнект — базовый (по желанию позже).
 */
export class NetClient {
  private ws?: WebSocket;
  private handlers = new Map<ServerFrame['t'], Handler[]>();
  private openCbs: (() => void)[] = [];
  private closeCbs: (() => void)[] = [];

  connect(url = wsUrl()): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { for (const cb of this.openCbs) cb(); };
    ws.onclose = () => { for (const cb of this.closeCbs) cb(); };
    ws.onmessage = (ev) => {
      let frame: ServerFrame;
      try { frame = JSON.parse(ev.data as string) as ServerFrame; } catch { return; }
      for (const h of this.handlers.get(frame.t) ?? []) h(frame);
    };
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

  close(): void { this.ws?.close(); this.ws = undefined; }
}

/** Адрес WS: dev — тот же хост (Vite проксирует /ws на :3001); прод — VITE_WS_URL. */
function wsUrl(): string {
  const env = (import.meta as { env?: Record<string, string> }).env?.VITE_WS_URL;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
