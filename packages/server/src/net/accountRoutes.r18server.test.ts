import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigRegistry } from '@dm/shared';

// Десятки запросов по настоящему HTTP за тест; под нагрузкой полного прогона умолчание 5 с — лотерея. Часы бакетов — ручные.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 18 (сервер), вход за настоящим express. База и сверка пароля — шпионы; часы бакетов — ручные (`performance.now`).
 *  • R18-05: ПОТОЛОК НИКА (`limits.loginUser`) ПЛАТИЛ И ВХОД С ТОКЕНОМ УСТРОЙСТВА. Тролль, знающий ник (регистрация отвечает «ник занят»),
 *    неверным паролем раз в 30 с с любого адреса держал бакет ника пустым — и владелец с верным паролем и своим токеном устройства получал 429
 *    бессрочно (новое устройство, выход, истёкшая сессия, каждый запуск Unity). Токен устройства (R11-05) снимал только бакет адреса. Теперь вход
 *    с годным токеном ника платит СВОЙ потолок ника (`loginUserDevice`): чужие неудачи без токена его не тратят, а перебор с утёкшим токеном
 *    держит он же.
 */
const db = vi.hoisted(() => ({
  users: new Map<string, { id: string; username: string; passHash: string; passSalt: string }>(),
  sessions: new Map<string, string>(),
  tokenSeq: 0,
}));
vi.mock('../db/db.js', () => ({
  getUserByName: async (name: string) => db.users.get(name.toLowerCase()) ?? null,
  createSession: async (userId: string) => {
    const t = (++db.tokenSeq).toString(16).padStart(64, 'b');
    db.sessions.set(t, userId);
    return t;
  },
  createUser: async (username: string) => {
    const id = `user-${username.toLowerCase()}`;
    db.users.set(username.toLowerCase(), { id, username, passHash: 'h', passSalt: 's' });
    return id;
  },
  deleteSession: async (t: string) => db.sessions.delete(t),
  getSession: async (token: string) => db.sessions.get(token) ?? null,
  countRecentRegistrations: async () => 0,
  listCharacters: async () => [],
  getCharacter: async () => null,
  createCharacter: async () => 1,
  deleteCharacter: async () => undefined,
  countCharacters: async () => 0,
  deleteSessionsOfUser: async () => 0,
  listLiveSessions: async () => [...db.sessions].map(([token, userId]) => ({ token, userId })),
  listUsernames: async () => [...db.users.keys()],
}));
vi.mock('../db/pool.js', () => ({ q: async () => [], q1: async () => null }));
// Сверка — синхронной подменой (ручка её дожидается); асинхронность scrypt — в `password.test.ts`.
vi.mock('../auth/password.js', () => ({
  hashPassword: () => ({ hash: 'h', salt: 's' }),
  verifyPassword: (password: string) => password === 'own-secret',
}));

let server: Server;
let base = '';
let rl: typeof import('./rateLimit.js');
/** Часы бакетов (мс): стоят, пока тест их не сдвинет. */
let T = 5_000_000;
beforeAll(async () => {
  const cfg = new ConfigRegistry();
  cfg.loadAll();
  rl = await import('./rateLimit.js');
  const { installAccountRoutes } = await import('./accountRoutes.js');
  const app = express();
  installAccountRoutes(app, { config: cfg });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server.keepAliveTimeout = 60_000;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  T += 3_600_000;   // час между тестами: бакеты ников прошлых тестов полны
  vi.spyOn(performance, 'now').mockImplementation(() => T);
  (rl.limits as unknown as Record<string, { reset?(k: string): void }>).scrypt?.reset?.('all');
});

async function login(ip: string, username: string, password: string, device?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ username, password, ...(device ? { device } : {}) }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
async function register(ip: string, username: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ username, password: 'own-secret' }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('⭐ R18-05: чужие неверные пароли не запирают владельца, входящего со своим токеном устройства', () => {
  it('12 неверных паролей без токена с чужого адреса, затем верный пароль с токеном устройства — 200 (раньше 429)', async () => {
    const reg = await register('198.51.100.40', 'victim18');
    expect(reg.status).toBe(200);
    const device = reg.body.device as string;
    expect(device).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < 12; i++) {
      T += 100;
      expect([401, 429], `попытка тролля ${i + 1}`).toContain((await login('203.0.113.9', 'victim18', 'wrong-pass')).status);
    }
    expect((await login('203.0.113.9', 'victim18', 'wrong-pass')).status, 'потолок ника без токена исчерпан').toBe(429);
    expect((await login('198.51.100.41', 'victim18', 'own-secret', device)).status, 'владелец со своим токеном').toBe(200);
  });

  it('тролль держит бакет ника пустым час (неверный пароль раз в 30 с) — владелец с токеном входит каждый раз', async () => {
    const reg = await register('198.51.100.42', 'victim18b');
    const device = reg.body.device as string;
    for (let i = 0; i < 10; i++) await login('203.0.113.10', 'victim18b', 'wrong-pass');
    for (let min = 0; min < 60; min++) {
      for (let k = 0; k < 2; k++) { T += 30_000; await login('203.0.113.10', 'victim18b', 'wrong-pass'); }
      if (min % 10 === 9) expect((await login('198.51.100.43', 'victim18b', 'own-secret', device)).status, `минута ${min + 1}`).toBe(200);
    }
  });

  it('путь с токеном устройства — тоже под потолком ника: 11 неверных паролей с годным токеном — 429', async () => {
    const reg = await register('198.51.100.44', 'leaked18');
    const device = reg.body.device as string;
    const got: number[] = [];
    for (let i = 0; i < 11; i++) { T += 100; got.push((await login(`203.0.113.${20 + i}`, 'leaked18', 'wrong-pass', device)).status); }
    expect(got.slice(0, 10).every((s) => s === 401), JSON.stringify(got)).toBe(true);
    expect(got[10], 'одиннадцатая с утёкшим токеном').toBe(429);
    // Владелец без токена (новое устройство) не заперт перебором с утёкшим токеном — это другой бакет ника.
    expect((await login('198.51.100.45', 'leaked18', 'own-secret')).status).toBe(200);
  });

  it('верный вход обнуляет оба потолка ника', async () => {
    const reg = await register('198.51.100.46', 'both18');
    const device = reg.body.device as string;
    for (let i = 0; i < 10; i++) await login('203.0.113.50', 'both18', 'wrong-pass');
    for (let i = 0; i < 10; i++) await login('203.0.113.51', 'both18', 'wrong-pass', device);
    expect((await login('203.0.113.50', 'both18', 'wrong-pass')).status).toBe(429);
    expect((await login('203.0.113.51', 'both18', 'wrong-pass', device)).status).toBe(429);
    T += 30_000;   // один токен в бакете с токеном — на верный вход владельца
    expect((await login('198.51.100.47', 'both18', 'own-secret', device)).status).toBe(200);
    expect(rl.limits.loginUser.peek('both18'), 'потолок без токена обнулён').toBe(true);
    expect((await login('198.51.100.48', 'both18', 'own-secret')).status, 'и вход без токена').toBe(200);
  });
});
