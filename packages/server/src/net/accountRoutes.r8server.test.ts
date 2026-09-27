import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigRegistry } from '@dm/shared';

// Полсотни запросов по настоящему HTTP за раз; под нагрузкой полного прогона умолчание 5 с — лотерея.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ R8-05: ПРОВЕРКА И СПИСАНИЕ БАКЕТА ВХОДА — БЕЗ ОЖИДАНИЯ МЕЖДУ НИМИ. R7-13 спрашивал бакет сети адреса до `await getUserByName`
 * (`peek`), а списывал после scrypt — и итог списания не смотрел: полсотни одновременных входов с неверным паролем проходили
 * проверку все, пока бакет полон, и каждый стоил scrypt (десятки мс главного потока — тики всех комнат процесса). А вход с
 * несуществующим ником не платил ничего: поиск в базе без потолка и оракул «такой ник есть» на скорости сети. Ручки —
 * настоящие (`installAccountRoutes`), база — шпион, сверка пароля — шпион (считает вызовы, сам scrypt здесь не нужен).
 */
const db = vi.hoisted(() => ({
  users: new Map<string, { id: string; username: string; passHash: string; passSalt: string }>(),
  lookups: 0,
  /** Поиск ника ждёт, пока тест не отпустит (`release`): так все запросы гарантированно стоят в ожидании разом. */
  held: null as null | { waiting: number; gate: Promise<void>; release: () => void },
}));
const pw = vi.hoisted(() => ({ verifies: 0 }));
vi.mock('../db/db.js', () => ({
  getUserByName: async (name: string) => {
    db.lookups++;
    if (db.held) { db.held.waiting++; await db.held.gate; }
    return db.users.get(name.toLowerCase()) ?? null;
  },
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
vi.mock('../auth/password.js', () => ({
  hashPassword: () => ({ hash: 'h', salt: 's' }),
  verifyPassword: (password: string) => { pw.verifies++; return password === 'secret-1'; },
}));

const NAT = '203.0.113.8';
const NAMES = ['r8a', 'r8b', 'r8c', 'r8d', 'r8e'];
let server: Server;
let base = '';
beforeAll(async () => {
  for (const n of [...NAMES, 'honest']) db.users.set(n, { id: `user-${n}`, username: n, passHash: 'h', passSalt: 's' });
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
  const lim = limits as unknown as Record<string, { reset(k: string): void } | undefined>;
  for (const name of ['login', 'loginLookup']) lim[name]?.reset(ipBucket(NAT));
  for (const u of [...NAMES, 'honest']) limits.loginUser.reset(u);
  db.lookups = 0; pw.verifies = 0; db.held = null;
  // Часы бакетов стоят: пополнения за время теста нет — «сколько прошло» не зависит от скорости машины под нагрузкой.
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
/** Поиск ника держим, пока `n` запросов не встанут в ожидание разом, — потом отпускаем всех. */
function holdLookups(n: number): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  db.held = { waiting: 0, gate, release };
  return (async () => {
    const until = Date.now() + 20_000;
    while (db.held!.waiting < n && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    db.held!.release();
  })();
}

describe('⭐ R8-05: бакет входа списывается до scrypt, поиск ника — под своим потолком', () => {
  it('50 одновременных входов с неверным паролем в 5 ников с одного адреса — scrypt не больше потолка адреса (10)', async () => {
    const released = holdLookups(50);
    const statuses = await Promise.all(Array.from({ length: 50 }, (_, i) => login(NAMES[i % NAMES.length]!, `wrong-${i}`)));
    await released;
    expect(pw.verifies, `scrypt: ${pw.verifies}`).toBeLessThanOrEqual(10);
    expect(statuses.filter((s) => s === 401).length).toBe(pw.verifies);
    expect(statuses.filter((s) => s === 429).length, 'остальные — «слишком часто»').toBe(50 - pw.verifies);
  });

  it('200 несуществующих ников с одного адреса — в базу не больше потолка поиска, дальше 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) statuses.push(await login(`nobody-${i}`, 'whatever1'));
    expect(db.lookups, `поисков в базе: ${db.lookups}`).toBeLessThanOrEqual(60);
    expect(statuses.slice(0, 30).every((s) => s === 401), 'человеческий темп ошибок — «неверно»').toBe(true);
    expect(statuses.slice(-10), 'поток — «слишком часто»').toEqual(Array(10).fill(429));
    expect(pw.verifies, 'scrypt не было').toBe(0);
  });

  it('контроль (R7-13): 30 мусорных ников соседа по NAT — потом верный пароль с того же адреса: 200', async () => {
    for (let i = 0; i < 30; i++) expect(await login(`junk-${i}`, 'whatever1')).toBe(401);
    expect(await login('honest', 'secret-1')).toBe(200);
  });

  it('контроль: верный пароль бакет адреса не расходует — десять входов подряд, потом неверный ещё сверяется', async () => {
    for (let i = 0; i < 10; i++) expect(await login('honest', 'secret-1')).toBe(200);
    expect(await login('honest', 'nope-123')).toBe(401);
  });
});
