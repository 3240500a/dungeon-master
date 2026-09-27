import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigRegistry } from '@dm/shared';

// Сотни запросов по настоящему HTTP за тест; под нагрузкой полного прогона умолчание 5 с — лотерея.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Раунд 9 (сервер), ручки аккаунтов за настоящим express: верный пароль своего аккаунта не обнуляет бакет адреса — перебор
 * чужих паролей с одного адреса не множится (R9-10); сессия, которой нет, платит бакет сети адреса ДО базы — поток случайных
 * токенов правильного вида не ходит в общую базу без предела (R9-12). База — шпион, сверка пароля — шпион (scrypt не нужен).
 */
const db = vi.hoisted(() => ({
  users: new Map<string, { id: string; username: string; passHash: string; passSalt: string }>(),
  /** Токен → аккаунт: живые сессии. */
  sessions: new Map<string, string>(),
  sessionLookups: 0,
}));
const pw = vi.hoisted(() => ({ wrong: 0, right: 0 }));
vi.mock('../db/db.js', () => ({
  getUserByName: async (name: string) => db.users.get(name.toLowerCase()) ?? null,
  createSession: async () => 'b'.repeat(64),
  createUser: async () => 'user-x',
  deleteSession: async () => undefined,
  getSession: async (token: string) => { db.sessionLookups++; return db.sessions.get(token) ?? null; },
  countRecentRegistrations: async () => 0,
  listCharacters: async () => [],
  getCharacter: async () => null,
  createCharacter: async () => 1,
  deleteCharacter: async () => undefined,
  countCharacters: async () => 0,
  deleteSessionsOfUser: async () => 0,
}));
vi.mock('../auth/password.js', () => ({
  hashPassword: () => ({ hash: 'h', salt: 's' }),
  verifyPassword: (password: string) => {
    const ok = password === 'own-secret';
    if (ok) pw.right++; else pw.wrong++;
    return ok;
  },
}));

let server: Server;
let base = '';
beforeAll(async () => {
  db.users.set('attacker', { id: 'user-attacker', username: 'attacker', passHash: 'h', passSalt: 's' });
  for (let i = 0; i < 300; i++) db.users.set(`victim${i}`, { id: `user-v${i}`, username: `victim${i}`, passHash: 'h', passSalt: 's' });
  const cfg = new ConfigRegistry();
  cfg.loadAll();
  const { installAccountRoutes } = await import('./accountRoutes.js');
  const app = express();
  installAccountRoutes(app, { config: cfg });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(async () => {
  pw.wrong = 0; pw.right = 0; db.sessionLookups = 0;
  (await import('./rateLimit.js')).limits.scrypt.reset('all');   // R11-01: общий бюджет scrypt процесса полон — здесь он не проверяется
  // Часы бакетов стоят: пополнения за время теста нет — «сколько прошло» не зависит от скорости машины под нагрузкой.
  vi.spyOn(performance, 'now').mockReturnValue(performance.now());
});

let natSeq = 0;
/** Свой адрес на тест: бакеты адреса у каждого теста свои. */
const nat = (): string => `203.0.113.${++natSeq}`;

async function login(ip: string, username: string, password: string): Promise<number> {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ username, password }),
  });
  await r.body?.cancel();
  return r.status;
}
async function characters(ip: string, token: string): Promise<number> {
  const r = await fetch(`${base}/api/characters`, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip } });
  await r.body?.cancel();
  return r.status;
}
/** Токен правильного вида (64 hex), которого в базе нет. */
const randomToken = (i: number): string => i.toString(16).padStart(64, 'f');

describe('⭐ R9-10: верный пароль своего аккаунта не обнуляет бакет адреса', () => {
  it('круги «9 неверных паролей чужих ников + верный свой» с одного адреса — сверок неверных не больше потолка адреса (10)', async () => {
    const ip = nat();
    let victim = 0;
    const statuses: number[] = [];
    for (let cycle = 0; cycle < 12; cycle++) {
      for (let i = 0; i < 9; i++) statuses.push(await login(ip, `victim${victim++}`, `guess-${cycle}-${i}`));
      statuses.push(await login(ip, 'attacker', 'own-secret'));
    }
    expect(pw.wrong, `сверок неверного пароля: ${pw.wrong}`).toBeLessThanOrEqual(10);
    expect(statuses.slice(-20), 'дальше — «слишком часто»').toEqual(Array(20).fill(429));
  });

  it('контроль: верный пароль токен возвращает — десять верных входов подряд, потом неверный ещё сверяется', async () => {
    const ip = nat();
    for (let i = 0; i < 10; i++) expect(await login(ip, 'attacker', 'own-secret')).toBe(200);
    expect(await login(ip, 'victim299', 'nope-123')).toBe(401);
    expect(pw.wrong).toBe(1);
  });

  it('контроль: человек ошибся паролем пару раз и вошёл — следующий вход не ждёт', async () => {
    const ip = nat();
    expect(await login(ip, 'attacker', 'typo-1')).toBe(401);
    expect(await login(ip, 'attacker', 'typo-2')).toBe(401);
    expect(await login(ip, 'attacker', 'own-secret')).toBe(200);
    expect(await login(ip, 'attacker', 'own-secret')).toBe(200);
  });
});

describe('⭐ R9-12: сессия, которой нет, платит бакет сети адреса до базы', () => {
  it('поток случайных токенов правильного вида с одного адреса — в базу не больше потолка, дальше 429 без базы', async () => {
    const ip = nat();
    const statuses: number[] = [];
    for (let i = 0; i < 300; i++) statuses.push(await characters(ip, randomToken(i)));
    expect(db.sessionLookups, `запросов сессии в базу: ${db.sessionLookups}`).toBeLessThanOrEqual(60);
    expect(statuses.slice(0, 20).every((s) => s === 401), 'человеческий темп — «требуется вход»').toBe(true);
    expect(statuses.slice(-10), 'поток — «слишком часто»').toEqual(Array(10).fill(429));
  });

  it('контроль: живая сессия бакет адреса не расходует — сотни запросов соседа по NAT со своим токеном проходят', async () => {
    const ip = nat();
    const token = 'c'.repeat(64);
    db.sessions.set(token, 'user-attacker');
    for (let i = 0; i < 30; i++) expect(await characters(ip, randomToken(1000 + i))).toBe(401);   // сосед по NAT ошибается
    const { limits } = await import('./rateLimit.js');
    for (let i = 0; i < 200; i++) {
      limits.account.reset('user-attacker');   // R11-06: потолок аккаунта (часы стоят) — у него свой тест; здесь — бакет адреса
      expect(await characters(ip, token)).toBe(200);
    }
  });
});
