import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigRegistry } from '@dm/shared';

// Сотни запросов по настоящему HTTP за тест; под нагрузкой полного прогона умолчание 5 с — лотерея.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ R10-04: ЧУЖИЕ НЕУДАЧИ С ОБЩЕГО АДРЕСА НЕ ЗАПИРАЮТ СОСЕДЕЙ. Бакет сети адреса (`authIp`, R9-12) списывался ДО поиска сессии у
 * каждого запроса, и пустой бакет отказывал и живому токену: поток случайных 64-hex токенов из-за общего NAT (оператор, общежитие,
 * офис) запирал соседям маршрут к ноде (`/api/route` — перед каждым подключением), ростер героев и вход редактора. Так же поиск ника
 * (`loginLookup`, R8-05) платил каждый вход — и поток мусорных ников запирал вход соседям с верным паролем. Ручки — настоящие
 * (`installAccountRoutes`, `installGatewayRoutes`) за настоящим express; база, реестр и сверка пароля — шпионы.
 */
const db = vi.hoisted(() => ({
  users: new Map<string, { id: string; username: string; passHash: string; passSalt: string }>(),
  sessions: new Map<string, string>(),
  sessionLookups: 0,
  nameLookups: 0,
  tokenSeq: 0,
  CHAR: '0f8e0c5e-1c2b-4d6a-9e3f-1234567890ab',
}));
const pw = vi.hoisted(() => ({ verifies: 0 }));
vi.mock('../db/db.js', () => ({
  getUserByName: async (name: string) => { db.nameLookups++; return db.users.get(name.toLowerCase()) ?? null; },
  createSession: async (userId: string) => {
    const t = (++db.tokenSeq).toString(16).padStart(64, 'd');
    db.sessions.set(t, userId);
    return t;
  },
  createUser: async (username: string) => {
    const id = `user-${username.toLowerCase()}`;
    db.users.set(username.toLowerCase(), { id, username, passHash: 'h', passSalt: 's' });
    return id;
  },
  deleteSession: async (t: string) => { db.sessions.delete(t); },
  getSession: async (token: string) => { db.sessionLookups++; return db.sessions.get(token) ?? null; },
  countRecentRegistrations: async () => 0,
  listCharacters: async () => [],
  getCharacter: async (id: string) => (id === db.CHAR ? { userId: 'user-honest', data: {}, version: 1 } : null),
  createCharacter: async () => 1,
  deleteCharacter: async () => undefined,
  countCharacters: async () => 0,
  deleteSessionsOfUser: async () => 0,
}));
vi.mock('../db/pool.js', () => ({ q: async () => [], q1: async () => null }));
vi.mock('../cluster/registry.js', () => ({
  liveNodes: async () => [{ id: 'node-0', url: 'ws://n0/ws', players: 0, rooms: 0, draining: false, cpu_seconds: 0, rss_bytes: '0', loop_p99_ms: 0, tick_hz: 30 }],
  claimChar: async (_c: string, n: string) => n,
  sweepNodes: async () => 0,
  liveClaim: async () => null,
}));
vi.mock('../auth/password.js', () => ({
  hashPassword: () => ({ hash: 'h', salt: 's' }),
  verifyPassword: (password: string) => { pw.verifies++; return password === 'own-secret'; },
}));

let server: Server;
let base = '';
let limits: typeof import('./rateLimit.js').limits;
beforeAll(async () => {
  db.users.set('honest', { id: 'user-honest', username: 'honest', passHash: 'h', passSalt: 's' });
  const cfg = new ConfigRegistry();
  cfg.loadAll();
  ({ limits } = await import('./rateLimit.js'));
  const { installAccountRoutes } = await import('./accountRoutes.js');
  const { installGatewayRoutes } = await import('../cluster/gateway.js');
  const app = express();
  installAccountRoutes(app, { config: cfg });
  installGatewayRoutes(app);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  db.sessionLookups = 0; db.nameLookups = 0; pw.verifies = 0;
  for (const l of [limits.route, limits.loginUser, limits.loginOk, limits.account]) { l.reset('user-honest'); l.reset('honest'); }
  limits.scrypt.reset('all');   // R11-01: общий бюджет scrypt процесса полон — здесь он не проверяется (часы стоят)
  // Часы бакетов стоят: пополнения за время теста нет — «сколько прошло» не зависит от скорости машины под нагрузкой.
  vi.spyOn(performance, 'now').mockReturnValue(performance.now());
});

let natSeq = 0;
/** Свой адрес на тест: бакеты адреса у каждого теста свои. */
const nat = (): string => `203.0.113.${++natSeq}`;
const junkToken = (i: number): string => i.toString(16).padStart(64, 'e');

async function get(path: string, ip: string, token: string): Promise<number> {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip } });
  await r.body?.cancel();
  return r.status;
}
const characters = (ip: string, token: string): Promise<number> => get('/api/characters', ip, token);
const route = (ip: string, token: string): Promise<number> => get(`/api/route?charId=${db.CHAR}`, ip, token);
async function login(ip: string, username: string, password: string): Promise<{ status: number; token?: string }> {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ username, password }),
  });
  const body = (await r.json().catch(() => ({}))) as { token?: string };
  return { status: r.status, token: body.token };
}

describe('⭐ R10-04: поток чужих токенов с общего адреса — живая сессия соседа проходит', () => {
  it('сосед вошёл; затем 70 случайных токенов с того же адреса — его токен по-прежнему 200 на ростере и маршруте', async () => {
    const ip = nat();
    const { status, token } = await login(ip, 'honest', 'own-secret');
    expect(status).toBe(200);
    for (let i = 0; i < 70; i++) await characters(ip, junkToken(i));
    expect(await characters(ip, junkToken(999)), 'поток упёрся в потолок адреса').toBe(429);
    expect(await characters(ip, token!), 'ростер соседа').toBe(200);
    expect(await route(ip, token!), 'маршрут к ноде соседа').toBe(200);
  });

  it('токен, уже предъявленный этому процессу (вход был раньше, сессия жива), — тоже проходит поток', async () => {
    const ip = nat();
    const token = 'c'.repeat(64);
    db.sessions.set(token, 'user-honest');
    expect(await route(ip, token)).toBe(200);
    for (let i = 0; i < 70; i++) await route(ip, junkToken(10_000 + i));
    for (let i = 0; i < 5; i++) expect(await route(ip, token), `повтор ${i}`).toBe(200);
  });

  it('R9-12 в силе: поток случайных токенов в базу — не больше потолка адреса (60); отозванная сессия — 401', async () => {
    const ip = nat();
    const statuses: number[] = [];
    for (let i = 0; i < 300; i++) statuses.push(await characters(ip, junkToken(20_000 + i)));
    expect(db.sessionLookups, `запросов сессии в базу: ${db.sessionLookups}`).toBeLessThanOrEqual(60);
    expect(statuses.slice(-10)).toEqual(Array(10).fill(429));
    // Сессию отозвали (выход) — «знакомый» токен больше не пускает: база спрашивается всегда.
    const ip2 = nat();
    const { token } = await login(ip2, 'honest', 'own-secret');
    expect(await characters(ip2, token!)).toBe(200);
    db.sessions.delete(token!);
    expect(await characters(ip2, token!)).toBe(401);
  });
});

describe('⭐ R10-04: поток мусорных ников с общего адреса — сосед с верным паролем входит', () => {
  it('61 вход с несуществующими никами, затем сосед (ник уже входил сюда) с верным паролем — 200', async () => {
    const ip = nat();
    expect((await login(nat(), 'honest', 'own-secret')).status, 'ник знаком процессу').toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await login(ip, `ghost${i}`, 'whatever-1')).status);
    expect(statuses.at(-1), 'поток ников упёрся в потолок').toBe(429);
    expect((await login(ip, 'honest', 'own-secret')).status, 'сосед вошёл').toBe(200);
  });

  it('R8-05 в силе: поток мусорных ников в базу — не больше потолка адреса (60)', async () => {
    const ip = nat();
    for (let i = 0; i < 200; i++) await login(ip, `phantom${i}`, 'whatever-1');
    expect(db.nameLookups, `поисков ника: ${db.nameLookups}`).toBeLessThanOrEqual(60);
  });

  it('верный пароль своего аккаунта мимо бакета адреса — не без предела: сверок пароля не больше потолка ника', async () => {
    const ip = nat();
    let ok = 0;
    for (let i = 0; i < 40; i++) if ((await login(ip, 'honest', 'own-secret')).status === 200) ok++;
    expect(ok, 'десять подряд — как прежде (R9-10)').toBeGreaterThanOrEqual(10);
    expect(pw.verifies, `сверок пароля (scrypt): ${pw.verifies}`).toBeLessThanOrEqual(20);
  });
});
