import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * ⭐ R4-21: МАРШРУТ К НОДЕ — СТРОКИ ДО БАЗЫ. `GET /api/route` (гейтвей, и в одиночном режиме тоже) отдавал в Postgres
 * `charId`, билет очереди и токен как пришли: `?charId=%00` — это 22021 от базы, ответ 500 и стек в лог на КАЖДЫЙ запрос
 * любого вошедшего игрока, без лимита. Здесь настоящая ручка (`installGatewayRoutes`) за настоящим express, а база —
 * шпион, который, как Postgres, не принимает байт 0x00 в тексте: кривое обязано получить 4xx и не дойти до базы.
 */
const db = vi.hoisted(() => {
  const calls: string[] = [];
  const TOKEN = 'a'.repeat(64);
  const CHAR = '0f8e0c5e-1c2b-4d6a-9e3f-1234567890ab';
  /** Как Postgres: 0x00 в текстовом параметре — 22021. */
  const pgText = (args: unknown[]): void => {
    if (args.some((a) => typeof a === 'string' && a.includes(String.fromCharCode(0)))) {
      throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' });
    }
  };
  const spy = <T>(fn: string, out: (...a: unknown[]) => T) => async (...args: unknown[]): Promise<T> => {
    calls.push(fn);
    pgText(args.flat());
    return out(...args);
  };
  /** R5-13: сколько игроков в реестре у ноды и сколько живых нод (по буквам A…). */
  const cluster = { players: 0, nodes: 1 };
  return { calls, TOKEN, CHAR, spy, cluster };
});
vi.mock('../db/db.js', () => ({
  getSession: db.spy('getSession', (t) => (t === db.TOKEN ? 'user-1' : null)),
  getCharacter: db.spy('getCharacter', (id) => (id === db.CHAR ? { userId: 'user-1', data: {}, version: 1 } : null)),
}));
vi.mock('../db/pool.js', () => ({ q: db.spy('q', () => []), q1: db.spy('q1', () => null) }));
vi.mock('./registry.js', () => ({
  liveNodes: db.spy('liveNodes', () => Array.from({ length: db.cluster.nodes }, (_, i) => (
    { id: `node-${i}`, url: `ws://n${i}/ws`, players: db.cluster.players, rooms: 0, draining: false, cpu_seconds: 0, rss_bytes: '0', loop_p99_ms: 0, tick_hz: 30 }))),
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
/** Потолок маршрута (R4-21) — на каждый тест заново: его проверяет свой тест ниже. */
const resetRoute = async (): Promise<void> => {
  const { limits } = await import('../net/rateLimit.js');
  (limits as unknown as Record<string, { reset(k: string): void } | undefined>).route?.reset('user-1');
  // R11-06: и потолок ручек с токеном на аккаунт (`sessionUser`) — он шире маршрутного и здесь не проверяется.
  (limits as unknown as Record<string, { reset(k: string): void } | undefined>).account?.reset('user-1');
};
beforeEach(async () => { db.calls.length = 0; await resetRoute(); });

async function route(query: string, token: string | null = db.TOKEN): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/route?${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('R4-21: маршрут к ноде — кривые строки до базы не доходят', () => {
  it('⭐ id героя с U+0000 или мусором — 400 без единого вызова базы (и без 500 со стеком)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const charId of ['%00', `${db.CHAR}%00`, 'a%20b', 'x'.repeat(65)]) {
      const r = await route(`charId=${charId}`);
      expect(r.status, charId).toBe(400);
    }
    expect(db.calls, 'база не тронута').toEqual([]);
    expect(err, 'лог молчит').not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('⭐ токен не того вида — 401 без похода в базу', async () => {
    for (const token of ['short', 'A'.repeat(64), `${'a'.repeat(63)}é`, 'b'.repeat(200)]) {
      expect((await route(`charId=${db.CHAR}`, token)).status, token).toBe(401);
    }
    expect((await route(`charId=${db.CHAR}`, null)).status).toBe(401);
    expect(db.calls).toEqual([]);
  });

  it('⭐ билет очереди и код комнаты не того вида — 400, а не 500; честные — проходят', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const q of [`ticket=%00`, `ticket=abc`, `roomCode=%00`, `roomCode=A%20B`, `roomCode=${'A'.repeat(9)}`]) {
      const r = await route(`charId=${db.CHAR}&${q}`);
      expect(r.status, q).toBe(400);
    }
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
    expect((await route(`charId=${db.CHAR}`)).status).toBe(200);
    expect((await route(`charId=${db.CHAR}&ticket=0f8e0c5e-1c2b-4d6a-9e3f-1234567890ab`)).status).toBe(200);
    const byCode = await route(`charId=${db.CHAR}&roomCode=a2b3c4d5`);
    expect(byCode.status, 'код без учёта регистра').toBe(200);
    expect(byCode.json.node).toBe('node-0');
  });

  it('⭐ R4-21: у маршрута потолок частоты на аккаунт — каждый вызов пишет закрепление в базу', async () => {
    let limited = 0;
    for (let i = 0; i < 40; i++) if ((await route(`charId=${db.CHAR}`)).status === 429) limited++;
    expect(limited, 'поток маршрутов упирается в потолок').toBeGreaterThan(0);
    await resetRoute();
    expect((await route(`charId=${db.CHAR}`)).status).toBe(200);
  });
});

/**
 * ⭐ R5-13: ОЧЕРЕДЬ НА ВХОД — И ДЛЯ ВХОДА ПО КОДУ. Маршрут по коду комнаты отдавал адрес ноды ДО проверки потолка кластера, а
 * код из одной буквы проходил проверку вида: `?roomCode=A` — адрес первой ноды мимо очереди, дальше вход без кода туда же.
 */
describe('⭐ R5-13: маршрут по коду не обходит очередь', () => {
  let cappedBase = '';
  let capped: Server;
  beforeAll(async () => {
    vi.resetModules();
    process.env.DM_MAX_PLAYERS = '1';
    try {
      const { installGatewayRoutes } = await import('./gateway.js');
      const app = express();
      installGatewayRoutes(app);
      capped = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      cappedBase = `http://127.0.0.1:${(capped.address() as AddressInfo).port}`;
    } finally { delete process.env.DM_MAX_PLAYERS; }
  });
  afterAll(() => { capped.close(); db.cluster.players = 0; db.cluster.nodes = 1; });
  const routeCapped = async (query: string): Promise<{ status: number; json: Record<string, unknown> }> => {
    const { limits } = await import('../net/rateLimit.js');
    limits.route.reset('user-1');
    const r = await fetch(`${cappedBase}/api/route?${query}`, { headers: { Authorization: `Bearer ${db.TOKEN}` } });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };

  it('кластер на потолке: без кода — место в очереди; по коду — в пределах запаса ноды (R6-08), за ним — тоже очередь', async () => {
    db.cluster.players = 1;
    const plain = await routeCapped(`charId=${db.CHAR}`);
    expect(plain.status).toBe(503);
    expect(plain.json.queue).toBeDefined();
    const byCode = await routeCapped(`charId=${db.CHAR}&roomCode=A2B3C4D5`);
    expect(byCode.status, 'к другу — в запасе ноды над потолком (нода держит его сама, `admits`)').toBe(200);
    db.cluster.players = 1 + 4;
    const over = await routeCapped(`charId=${db.CHAR}&roomCode=A2B3C4D5`);
    expect(over.status, 'запас исчерпан — по коду тоже очередь').toBe(503);
    expect(over.json.url, 'адреса ноды нет').toBeUndefined();
  });

  it('код короче полного — «Комната не найдена», адреса ноды нет (буква ноды — не пропуск)', async () => {
    db.cluster.players = 0;
    for (const code of ['A', 'AB', 'A2B3C4D']) {
      const r = await routeCapped(`charId=${db.CHAR}&roomCode=${code}`);
      expect(r.status, code).toBe(404);
      expect(r.json.url, code).toBeUndefined();
    }
    const full = await routeCapped(`charId=${db.CHAR}&roomCode=A2B3C4D5`);
    expect(full.status).toBe(200);
    expect(full.json.node).toBe('node-0');
  });

  it('⭐ R5-14: код, выданный последней нодой (26-й, буква Z), ведёт к ней', async () => {
    db.cluster.players = 0;
    db.cluster.nodes = 26;
    const r = await routeCapped(`charId=${db.CHAR}&roomCode=Z2B3C4D5`);
    expect(r.status).toBe(200);
    expect(r.json.node).toBe('node-25');
    db.cluster.nodes = 1;
  });
});

/**
 * ⭐ R6-20: СОСТОЯНИЕ КЛАСТЕРА — СЛУЖЕБНАЯ РУЧКА. `GET /api/cluster` отвечал любому (игроки, комнаты, слив, частота тика,
 * лаг цикла, память и адреса нод — то, что R3-03 закрыл на `/metrics`), и каждый анонимный запрос шёл в базу за узлами.
 * Теперь — правилом `/metrics`: прямой вызов с самой машины (или ключ чтения метрик), а список узлов — из короткого кэша.
 */
describe('⭐ R6-20: состояние кластера — только служебно и без запроса в базу на каждый вызов', () => {
  const liveNodesCalls = (): number => db.calls.filter((c) => c === 'liveNodes').length;

  it('через прокси (X-Forwarded-For) — 403 без похода в базу; прямой вызов с машины — 200', async () => {
    const r = await fetch(`${base}/api/cluster`, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    expect(r.status).toBe(403);
    expect(liveNodesCalls(), 'база не тронута').toBe(0);
    const ok = await fetch(`${base}/api/cluster`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { nodes: unknown[] }).nodes).toHaveLength(1);
  });

  it('100 вызовов за секунду — не больше одного запроса узлов', async () => {
    await new Promise((r) => setTimeout(r, 1100));   // кэш прошлого теста истёк
    db.calls.length = 0;
    const statuses = await Promise.all(Array.from({ length: 100 }, () => fetch(`${base}/api/cluster`).then((r) => r.status)));
    expect(new Set(statuses)).toEqual(new Set([200]));
    expect(liveNodesCalls()).toBeLessThanOrEqual(1);
  });
});
