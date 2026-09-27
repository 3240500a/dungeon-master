import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigRegistry } from '@dm/shared';

// Каждая неудача пароля — настоящий scrypt (десятки мс процессора; под нагрузкой полного прогона — в разы дольше), а тест
// их делает до дюжины: умолчание 5 с — лотерея.
vi.setConfig({ testTimeout: 20_000 });

/**
 * ⭐ R7-13: БАКЕТ ВХОДА С АДРЕСА ПЛАТИТ ТОЛЬКО НЕУДАЧНЫЙ ПАРОЛЬ. Раньше `/api/login` списывал токен адреса (IPv4 или IPv6 /64) за
 * КАЖДУЮ попытку — до разбора тела и поиска ника, и возвращал его лишь на успешном входе. Вход с несуществующим ником scrypt
 * не стоит (героя нет — сверять нечего), но бакет опустошал: за общим NAT (оператор, общежитие, офис) один тролль с потоком
 * мусорных ников запирал вход соседям с верным паролем. Ручки — настоящие (`installAccountRoutes`), база — шпион, хэш пароля
 * — настоящий scrypt. Все запросы — с петли с `X-Forwarded-For` одного адреса (так их пересылает прокси uWS).
 */
const db = vi.hoisted(() => ({
  users: new Map<string, { id: string; username: string; passHash: string; passSalt: string }>(),
  lookups: 0,
}));
vi.mock('../db/db.js', () => ({
  getUserByName: async (name: string) => { db.lookups++; return db.users.get(name.toLowerCase()) ?? null; },
  createSession: async () => 'b'.repeat(64),
  createUser: async () => 'user-x',
  deleteSession: async () => undefined,
  getSession: async () => null,
  countRecentRegistrations: async () => 0,
  listCharacters: async () => [],
  getCharacter: async () => null,
  createCharacter: async () => 1,
  deleteCharacter: async () => undefined,
  countCharacters: async () => 0,
  deleteSessionsOfUser: async () => 0,
}));

const NAT = '203.0.113.7';
let server: Server;
let base = '';
beforeAll(async () => {
  const { hashPassword } = await import('../auth/password.js');
  const h = await hashPassword('secret-1');
  db.users.set('honest', { id: 'user-honest', username: 'honest', passHash: h.hash, passSalt: h.salt });
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
  const { limits, ipBucket } = await import('./rateLimit.js');
  limits.login.reset(ipBucket(NAT));
  limits.loginLookup.reset(ipBucket(NAT));   // R8-05: поиск ника — свой бакет адреса
  for (const u of ['honest', 'victim']) limits.loginUser.reset(u);
  limits.scrypt.reset('all');   // R11-01: общий бюджет scrypt процесса полон — здесь он не проверяется (часы стоят)
  // Часы бакетов стоят: пополнения за время теста нет — «пустой бакет» не зависит от скорости машины под нагрузкой.
  vi.spyOn(performance, 'now').mockReturnValue(performance.now());
});

async function login(username: string, password: string): Promise<number> {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': NAT },
    body: JSON.stringify({ username, password }),
  });
  await r.body?.cancel();
  return r.status;
}

describe('⭐ R7-13: мусорные ники соседа по NAT не запирают вход', () => {
  it('30 входов с несуществующими никами с адреса — потом верный пароль с того же адреса: 200, а не 429', async () => {
    const junk: number[] = [];
    for (let i = 0; i < 30; i++) junk.push(await login(`nobody${i}`, 'whatever1'));
    expect(junk.every((s) => s === 401), `мусор — «неверно»: ${junk.join(',')}`).toBe(true);
    expect(await login('honest', 'secret-1'), 'сосед по NAT входит').toBe(200);
  });

  it('кривые тела (короткий ник) тоже бакет адреса не платят', async () => {
    for (let i = 0; i < 20; i++) expect(await login('x', 'y')).toBe(422);
    expect(await login('honest', 'secret-1')).toBe(200);
  });

  it('контроль: неверный пароль (scrypt) платит бакет адреса — после десятка неудач с адреса вход ждёт', async () => {
    db.users.set('victim', { ...db.users.get('honest')!, id: 'user-victim', username: 'victim' });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push(await login('victim', `wrong-${i}`));
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect(await login('honest', 'secret-1'), 'перебор паролей с адреса держится').toBe(429);
  });

  it('контроль: перебор пароля одного ника — потолок ника, с любых адресов', async () => {
    db.users.set('victim', { ...db.users.get('honest')!, id: 'user-victim', username: 'victim' });
    const { limits, ipBucket } = await import('./rateLimit.js');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      limits.login.reset(ipBucket(NAT));   // «сотня адресов»: бакет адреса каждый раз свежий
      statuses.push(await login('victim', `wrong-${i}`));
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10), 'ник заперт').toEqual([429, 429]);
  });
});
