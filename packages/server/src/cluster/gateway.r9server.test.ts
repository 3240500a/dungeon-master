import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Сотни запросов по настоящему HTTP за тест; под нагрузкой полного прогона умолчание 5 с — лотерея.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ R9-12: МАРШРУТ К НОДЕ — СЕССИЯ ПОД БАКЕТОМ СЕТИ АДРЕСА. `/api/route` проверял у токена только вид и шёл в базу за сессией, а
 * его лимит (`limits.route`) ключом берёт аккаунт — то есть стоит уже после базы: поток случайных 64-hex токенов с одного адреса
 * стоил запроса в общую базу на каждый. Ручка — настоящая (`installGatewayRoutes`) за настоящим express, база и реестр — шпионы.
 */
const db = vi.hoisted(() => ({ sessionLookups: 0, TOKEN: 'a'.repeat(64), CHAR: '0f8e0c5e-1c2b-4d6a-9e3f-1234567890ab' }));
vi.mock('../db/db.js', () => ({
  getSession: async (t: string) => { db.sessionLookups++; return t === db.TOKEN ? 'user-1' : null; },
  getCharacter: async (id: string) => (id === db.CHAR ? { userId: 'user-1', data: {}, version: 1 } : null),
}));
vi.mock('../db/pool.js', () => ({ q: async () => [], q1: async () => null }));
vi.mock('./registry.js', () => ({
  liveNodes: async () => [{ id: 'node-0', url: 'ws://n0/ws', players: 0, rooms: 0, draining: false, cpu_seconds: 0, rss_bytes: '0', loop_p99_ms: 0, tick_hz: 30 }],
  claimChar: async (_c: string, n: string) => n,
  sweepNodes: async () => 0,
  liveClaim: async () => null,
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
  db.sessionLookups = 0;
  const { limits } = await import('../net/rateLimit.js');
  limits.route.reset('user-1');
  // Часы бакетов стоят: пополнения за время теста нет — «сколько прошло» не зависит от скорости машины под нагрузкой.
  vi.spyOn(performance, 'now').mockReturnValue(performance.now());
});

let natSeq = 0;
const nat = (): string => `198.51.100.${++natSeq}`;
async function route(ip: string, token: string): Promise<number> {
  const r = await fetch(`${base}/api/route?charId=${db.CHAR}`, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip } });
  await r.body?.cancel();
  return r.status;
}

describe('⭐ R9-12: /api/route — сессии, которой нет, база не видит сверх потолка сети адреса', () => {
  it('300 случайных токенов правильного вида с одного адреса — в базу не больше потолка, дальше 429 без базы', async () => {
    const ip = nat();
    const statuses: number[] = [];
    for (let i = 0; i < 300; i++) statuses.push(await route(ip, i.toString(16).padStart(64, 'e')));
    expect(db.sessionLookups, `запросов сессии в базу: ${db.sessionLookups}`).toBeLessThanOrEqual(60);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(-10)).toEqual(Array(10).fill(429));
  });

  it('контроль: свой токен с того же адреса проходит и после чужих неудач соседа по NAT', async () => {
    const ip = nat();
    for (let i = 0; i < 30; i++) expect(await route(ip, (5000 + i).toString(16).padStart(64, 'e'))).toBe(401);
    for (let i = 0; i < 15; i++) expect(await route(ip, db.TOKEN)).toBe(200);
  });
});
