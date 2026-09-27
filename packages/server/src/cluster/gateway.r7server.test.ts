import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * ⭐ R7-05: СТРОКА ЗАПРОСА — ТОЛЬКО СТРОКОЙ. Разборщик express по умолчанию (`qs`, «extended») строит из `?charId[toString]=1`
 * объект `{ toString: '1' }`, и `String(req.query.charId)` бросал (`toString` — не функция): ответ 500 и стек в лог на КАЖДЫЙ
 * анонимный запрос — токен нужен лишь того вида, что у сессии, в базу до броска никто не ходит. Тот же класс, что закрывал
 * R4-21. Ручка — настоящая (`installGatewayRoutes`) за настоящим express, база и реестр — шпионы.
 */
const db = vi.hoisted(() => {
  const calls: string[] = [];
  const TOKEN = 'a'.repeat(64);
  const CHAR = '0f8e0c5e-1c2b-4d6a-9e3f-1234567890ab';
  const spy = <T>(fn: string, out: (...a: unknown[]) => T) => async (...args: unknown[]): Promise<T> => { calls.push(fn); return out(...args); };
  return { calls, TOKEN, CHAR, spy };
});
vi.mock('../db/db.js', () => ({
  getSession: db.spy('getSession', (t) => (t === db.TOKEN ? 'user-1' : null)),
  getCharacter: db.spy('getCharacter', (id) => (id === db.CHAR ? { userId: 'user-1', data: {}, version: 1 } : null)),
}));
vi.mock('../db/pool.js', () => ({ q: db.spy('q', () => []), q1: db.spy('q1', () => null) }));
vi.mock('./registry.js', () => ({
  liveNodes: db.spy('liveNodes', () => [{ id: 'node-0', url: 'ws://n0/ws', players: 0, rooms: 0, draining: false, cpu_seconds: 0, rss_bytes: '0', loop_p99_ms: 0, tick_hz: 30 }]),
  claimChar: db.spy('claimChar', (_c, n) => n),
  sweepNodes: db.spy('sweepNodes', () => 0),
  liveClaim: db.spy('liveClaim', () => null),
}));

let server: Server;
let base = '';
beforeAll(async () => {
  const { installGatewayRoutes } = await import('./gateway.js');
  const app = express();
  installGatewayRoutes(app);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(async () => {
  db.calls.length = 0;
  const { limits } = await import('../net/rateLimit.js');
  limits.route.reset('user-1');
});

async function route(query: string, token = '0'.repeat(64)): Promise<number> {
  const r = await fetch(`${base}/api/route?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  await r.body?.cancel();
  return r.status;
}

describe('⭐ R7-05: вложенное значение в строке запроса маршрута — 400, без броска и без стека в лог', () => {
  it('charId / ticket / roomCode вида `[toString]=1` и массивом — 400, лог молчит, база не тронута', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const bad = [
        'charId[toString]=1', 'charId[a]=1', `charId=${db.CHAR}&charId=${db.CHAR}`,
        `charId=${db.CHAR}&ticket[toString]=1`, `charId=${db.CHAR}&roomCode[toString]=1`, `charId=${db.CHAR}&roomCode[valueOf]=1`,
      ];
      for (const q of bad) expect(await route(q), q).toBe(400);
      expect(err, 'лог молчит').not.toHaveBeenCalled();
      expect(db.calls, 'база не тронута').toEqual([]);
    } finally { err.mockRestore(); }
  });

  it('контроль: честный маршрут — 200', async () => {
    expect(await route(`charId=${db.CHAR}`, db.TOKEN)).toBe(200);
    expect(await route(`charId=${db.CHAR}&roomCode=a2b3c4d5`, db.TOKEN)).toBe(200);
  });
});

describe('⭐ R7-05: чужое значение строки запроса — `queryText`', () => {
  it('строка — как есть, нет — пусто, объект и массив — не строка', async () => {
    const { queryText } = await import('../net/asyncRoute.js');
    expect(queryText('abc')).toBe('abc');
    expect(queryText(undefined)).toBe('');
    expect(queryText({ toString: '1' })).toBeUndefined();
    expect(queryText(['a', 'b'])).toBeUndefined();
  });
});
