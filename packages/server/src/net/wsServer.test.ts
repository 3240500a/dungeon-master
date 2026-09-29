import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { ConfigRegistry } from '@dm/shared';
import { counters } from './metrics.js';
import { MAX_BACKPRESSURE } from './conn.js';

/**
 * ТРАНСПОРТ `ws` ЦЕЛИКОМ: настоящий `attachWsServer` на порту 0 и настоящие сокеты. Здесь проверяется то, чего
 * не видно из менеджера комнат: что бросок внутри обработчика кадра не валит процесс (R2-01) и что огромный
 * кадр закрывается транспортом ДО разбора (R2-18). База не нужна — кадры не доходят до входа в игру.
 */
vi.mock('../db/db.js', () => ({
  getSession: () => Promise.resolve(null),
  getCharacter: () => Promise.resolve(null),
  putCharacter: () => Promise.resolve(null),
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'save' }),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(null),
}));

let server: Server;
let url = '';

beforeAll(async () => {
  const { attachWsServer } = await import('./wsServer.js');
  const cfg = new ConfigRegistry();
  cfg.loadAll();
  server = createServer();
  // Обработчики SIGINT/SIGTERM транспорта в тестовом процессе не нужны: они вызвали бы process.exit.
  const once = vi.spyOn(process, 'once').mockImplementation(() => process);
  attachWsServer(server, cfg);
  once.mockRestore();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});
const opened: WebSocket[] = [];
afterAll(() => {
  // Сокеты после апгрейда сервер уже не держит — рвём свои и не ждём закрытия слушателя.
  for (const ws of opened) ws.terminate();
  server.close();
});

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    opened.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
/** Понг на пинг с номером `id` — или `null`, если за полсекунды ответа нет. */
function ping(ws: WebSocket, id: number): Promise<unknown> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 500);
    ws.on('message', (d: Buffer) => {
      const f = JSON.parse(d.toString()) as { t?: string; id?: unknown };
      if (f.t === 'pong' && f.id === id) { clearTimeout(t); resolve(f); }
    });
    ws.send(JSON.stringify({ t: 'ping', id }));
  });
}
/** Код закрытия сокета — или `-1`, если за `ms` сокет так и не закрыли. */
function closedWith(ws: WebSocket, ms = 2000): Promise<number> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(-1), ms);
    ws.once('close', (code: number) => { clearTimeout(t); resolve(code); });
  });
}

describe('транспорт ws — кадры-убийцы', () => {
  it('⭐ R2-01: пинг с id глубиной 6000 уровней не роняет процесс — соседний сокет получает понг', async () => {
    const bad = await open();
    bad.send('{"t":"ping","id":' + '['.repeat(6000) + ']'.repeat(6000) + '}');
    await new Promise((r) => setTimeout(r, 50));
    const good = await open();
    expect(await ping(good, 7)).toEqual({ t: 'pong', id: 7 });
    bad.close(); good.close();
  });

  it('⭐ R2-18: кадр больше 64 КБ закрывается кодом 1009 и до разбора не доходит; соседний сокет живёт', async () => {
    const big = await open();
    const closing = closedWith(big);
    const in0 = counters.framesIn;
    big.send('{"t":"ping","id":1,"pad":"' + 'a'.repeat(70 * 1024) + '"}');
    expect(await closing).toBe(1009);
    expect(counters.framesIn - in0, 'кадр не дошёл до менеджера комнат').toBe(0);
    const good = await open();
    expect(await ping(good, 8)).toEqual({ t: 'pong', id: 8 });
    good.close();
  });
});

describe('⭐ R4-13: путь игрового сокета за прокси по путям (DEPLOY §3a, вариант А)', () => {
  /** Открыть сокет на путь `path` того же сервера: открылся — сокет, отказ рукопожатия — его HTTP-код. */
  function openAt(path: string): Promise<WebSocket | number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url.replace(/\/ws$/, path));
      opened.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
      ws.once('error', () => resolve(-1));
    });
  }

  it('⭐ гейтвей отдаёт wss://домен/ws/<i>, прокси пересылает путь как есть — нода принимает /ws/<i> (было: 400)', async () => {
    const ws = await openAt('/ws/0');
    expect(ws, 'сокет на /ws/0 открылся').toBeInstanceOf(WebSocket);
    expect(await ping(ws as WebSocket, 11)).toEqual({ t: 'pong', id: 11 });
    const ws12 = await openAt('/ws/12?x=1');
    expect(ws12).toBeInstanceOf(WebSocket);
    (ws as WebSocket).close(); (ws12 as WebSocket).close();
  });

  it('прочие пути игрового сокета не получают', async () => {
    for (const p of ['/wsx', '/ws/abc', '/ws/0/1', '/api/ws']) expect(await openAt(p), p).not.toBeInstanceOf(WebSocket);
  });
});

describe('⭐ B3-V1, B3-V2: закрытие сервером — окончательно сразу (`WsConn` поверх сокета, ведущего себя как `ws`)', () => {
  /** Сокет `ws`: `close` — только начало рукопожатия (`CLOSING`), кадры клиента библиотека отдаёт и в нём, событие `close` — позже. */
  class FakeWs extends EventEmitter {
    readonly OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent: unknown[] = [];
    closedWith?: number;
    send(d: unknown): void { this.sent.push(d); }
    close(code?: number): void { if (this.readyState === 1) { this.readyState = 2; this.closedWith = code; } }
    finish(): void { this.readyState = 3; this.emit('close'); }
  }
  async function conn(): Promise<{ ws: FakeWs; c: import('./conn.js').GameConn; frames: string[]; ends: () => number }> {
    const { WsConn } = await import('./wsServer.js');
    const ws = new FakeWs();
    const c = new WsConn(ws as unknown as WebSocket, '127.0.0.1');
    const frames: string[] = [];
    let n = 0;
    c.onMessage((raw) => frames.push(raw));
    c.onClose(() => { n++; });
    return { ws, c, frames, ends: () => n };
  }

  it('B3-V1: кадр клиента после закрытия сервером (сокет в CLOSING) в игру не идёт', async () => {
    const { ws, c, frames } = await conn();
    ws.emit('message', Buffer.from('{"t":"ping","id":1}'));
    c.close(4008, 'rate limit');
    expect(ws.closedWith).toBe(4008);
    expect(c.open).toBe(false);
    ws.emit('message', Buffer.from('{"t":"join"}'));   // клиент не отвечает на закрытие и шлёт дальше — библиотека кадр отдаёт
    expect(frames).toEqual(['{"t":"ping","id":1}']);
  });

  it('B3-V2: закрытие сервером зовёт обработчик закрытия сразу и один раз — событие транспорта потом ничего не делает', async () => {
    const { ws, c, ends } = await conn();
    c.close(4001, 'replaced');
    expect(ends(), 'снятие сессии — сразу, а не по концу рукопожатия').toBe(1);
    ws.finish();
    ws.emit('error', new Error('ECONNRESET'));
    expect(ends()).toBe(1);
  });

  it('B3-V2, R18-01: медленный читатель (очередь выше потолка) закрывается 1013 сразу, а обработчик закрытия — ближайшей микрозадачей', async () => {
    const { ws, c, frames, ends } = await conn();
    ws.bufferedAmount = MAX_BACKPRESSURE + 1;
    c.send('{"t":"pong","id":1}');
    expect(ws.closedWith).toBe(1013);
    expect(ws.sent).toEqual([]);
    expect(c.open, 'сокет закрыт сразу').toBe(false);
    // ⭐ R18-01: не изнутри отправки — её делает комната посреди синхронного шага (рассылка мира тика, где герой погиб).
    expect(ends(), 'снятие сессии — не поперёк отправки').toBe(0);
    ws.emit('message', Buffer.from('{"t":"vote","accept":true}'));
    expect(frames, 'кадр клиента после закрытия в игру не идёт').toEqual([]);
    await Promise.resolve();
    expect(ends(), 'и сразу за ней — один раз').toBe(1);
    ws.finish();
    expect(ends()).toBe(1);
  });

  it('закрытие клиентом — обработчик один раз, по событию транспорта', async () => {
    const { ws, ends } = await conn();
    expect(ends()).toBe(0);
    ws.finish();
    expect(ends()).toBe(1);
  });
});

describe('⭐ R18-01: транспорт uWS — закрытие изнутри отправки снимает сессию микрозадачей (`gameWsBehavior` поверх сокета, ведущего себя как uWS)', () => {
  /** Сокет uWS: `end` зовёт обработчик закрытия поведения синхронно — как сам uWS. */
  class FakeUwsSocket {
    closed = false;
    buffered = 0;
    sent = 0;
    closedWith?: number;
    constructor(readonly behavior: Record<string, unknown>) {}
    getRemoteAddressAsText(): ArrayBuffer { return new TextEncoder().encode('127.0.0.1').buffer as ArrayBuffer; }
    getUserData(): { ip?: string } { return { ip: '127.0.0.1' }; }
    getBufferedAmount(): number { return this.buffered; }
    send(): number { this.sent++; return 1; }
    end(code?: number): void {
      if (this.closed) throw new Error('Invalid access of closed uWS.WebSocket');
      this.closed = true; this.closedWith = code;
      (this.behavior.close as (ws: unknown) => void)(this);
    }
  }
  async function uws(): Promise<{ sock: FakeUwsSocket; c: import('./conn.js').GameConn; ends: () => number }> {
    const { gameWsBehavior } = await import('./uwsServer.js');
    let c: import('./conn.js').GameConn | undefined;
    const behavior = gameWsBehavior({ DISABLED: 0 }, (conn) => { c = conn; });
    const sock = new FakeUwsSocket(behavior);
    (behavior.open as (ws: unknown) => void)(sock);
    let n = 0;
    c!.onClose(() => { n++; });
    return { sock, c: c!, ends: () => n };
  }

  it('очередь выше потолка: сокет закрыт 1013 сразу, обработчик закрытия — ближайшей микрозадачей, один раз', async () => {
    const { sock, c, ends } = await uws();
    sock.buffered = MAX_BACKPRESSURE;
    c.send(new Uint8Array(1024));
    expect(sock.closedWith).toBe(1013);
    expect(sock.sent).toBe(0);
    expect(c.open).toBe(false);
    expect(ends(), 'не изнутри отправки').toBe(0);
    await Promise.resolve();
    expect(ends()).toBe(1);
  });

  it('закрытие сервером (не из отправки) — обработчик сразу, как прежде (B3-V2)', async () => {
    const { sock, c, ends } = await uws();
    c.close(4001, 'replaced');
    expect(sock.closedWith).toBe(4001);
    expect(ends()).toBe(1);
  });
});
