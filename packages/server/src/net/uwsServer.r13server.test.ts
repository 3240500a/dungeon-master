import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import type { GameConn } from './conn.js';
import { counters } from './metrics.js';

// Настоящий uWS и настоящий клиент по сети; под нагрузкой полного прогона умолчание 5 с — лотерея. Ждём события сокета, не часы.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ R13-07: ДВОИЧНЫЙ КАДР ОТ КЛИЕНТА НА uWS — НАРУШЕНИЕ ПРОТОКОЛА: соединение закрывается (1003) и кадр считается. Раньше обработчик
 * `message` молча возвращался на `isBinary` ДО `onMsg` — мимо счётчика кадров, потолков `wsFrames`/`wsInput` и закрытия 4008, а
 * каждый кадр ещё и продлевал `idleTimeout`: анонимный сокет без входа гнал миллионы пустых двоичных кадров без предела (замер —
 * ~8 с простоя цикла событий). Текстом тот же поток закрывался через ~120 кадров. Честный клиент двоичного вверх не шлёт никогда.
 */
vi.mock('../db/db.js', () => ({}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

interface UwsLike {
  App(): { ws(p: string, b: Record<string, unknown>): { listen(host: string, port: number, cb: (t: unknown) => void): void } };
  us_socket_local_port(t: unknown): number;
  us_listen_socket_close(t: unknown): void;
}
let uWS: UwsLike | null = null;
try { uWS = createRequire(import.meta.url)('uWebSockets.js') as UwsLike; } catch { /* пакет не собран под платформу */ }

const conns: { conn: GameConn; frames: string[] }[] = [];
let port = 0;
let token: unknown = null;
beforeAll(async () => {
  if (!uWS) return;
  const { gameWsBehavior } = await import('./uwsServer.js');
  const u = uWS;
  await new Promise<void>((resolve, reject) => {
    u.App().ws('/ws', gameWsBehavior(u as never, (c) => {
      const rec = { conn: c, frames: [] as string[] };
      c.onMessage((raw) => { rec.frames.push(raw); });
      c.onClose(() => {});
      conns.push(rec);
    })).listen('127.0.0.1', 0, (t) => {
      if (!t) { reject(new Error('uWS не занял порт')); return; }
      token = t; port = u.us_socket_local_port(t); resolve();
    });
  });
});
afterAll(() => { if (uWS && token) uWS.us_listen_socket_close(token); });

async function open(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return ws;
}

describe.runIf(!!uWS)('⭐ R13-07: двоичный кадр вверх на uWS — закрытие, а не молчаливый пропуск', () => {
  it('анонимный сокет шлёт пустые двоичные кадры — соединение закрыто кодом 1003, кадр посчитан', async () => {
    const invalid0 = counters.framesInvalid;
    const ws = await open();
    // Не закрыли за 10 с — провал утверждением (-1), а не потолком теста: честное закрытие приходит за миллисекунды.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = Promise.race([
      new Promise<number>((resolve) => ws.once('close', (code) => resolve(code))),
      new Promise<number>((resolve) => { timer = setTimeout(() => resolve(-1), 10_000); }),
    ]).finally(() => clearTimeout(timer));
    for (let i = 0; i < 50; i++) ws.send(Buffer.alloc(0), { binary: true });
    expect(await closed).toBe(1003);
    expect(counters.framesInvalid - invalid0, 'двоичный кадр — отброшен как кривой').toBeGreaterThanOrEqual(1);
  });

  it('контроль: текстовый кадр доходит до игры, сокет жив', async () => {
    const before = conns.length;
    const ws = await open();
    for (let i = 0; i < 50 && conns.length === before; i++) await new Promise((r) => setTimeout(r, 5));
    const rec = conns[conns.length - 1]!;
    ws.send(JSON.stringify({ t: 'ping', id: 1 }));
    for (let i = 0; i < 200 && !rec.frames.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(rec.frames).toEqual(['{"t":"ping","id":1}']);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe.runIf(!!uWS)('⭐ R13-08: пропуск маршрута гейтвея — из адреса игрового сокета', () => {
  it('`/ws?lp=…` — пропуск у соединения; без него — нет', async () => {
    const before = conns.length;
    const pass = 'abc123.' + 'x'.repeat(43);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?lp=${encodeURIComponent(pass)}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    for (let i = 0; i < 200 && conns.length === before; i++) await new Promise((r) => setTimeout(r, 5));
    expect(conns[conns.length - 1]!.conn.routePass).toBe(pass);
    ws.close();
    const plain = await open();
    for (let i = 0; i < 200 && conns.length === before + 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(conns[conns.length - 1]!.conn.routePass).toBeUndefined();
    plain.close();
  });
});
