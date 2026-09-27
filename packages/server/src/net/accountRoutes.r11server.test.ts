import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigRegistry } from '@dm/shared';

// Сотни запросов по настоящему HTTP за тест; под нагрузкой полного прогона умолчание 5 с — лотерея.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 11 (сервер), HTTP-ручки аккаунтов за настоящим express. База, реестр кластера и сверка пароля — шпионы; часы бакетов —
 * ручные (`performance.now`): «сколько прошло» не зависит от скорости машины под нагрузкой полного прогона.
 *  • R11-01: лимиты IPv6 — ступенями /64, /56, /48 (и суточный потолок аккаунтов тоже); scrypt — общий бюджет процесса;
 *  • R11-05: живой токен и существующий ник, которых процесс не видел (рестарт, простой), не заперты чужим потоком с общего адреса;
 *    тролль неверными паролями не запирает вход соседям (ник — раньше адреса, токен устройства);
 *  • R11-06: ручки с токеном — под потолком аккаунта; R11-07: выход — под бакетом адреса; R11-08: регистрация — бакет адреса только
 *    перед scrypt; R11-10: знакомый ник — пачка поисков в базе под бакетом; R11-11: сбой базы — лог через глушитель.
 */
const db = vi.hoisted(() => ({
  users: new Map<string, { id: string; username: string; passHash: string; passSalt: string }>(),
  /** Заведённые регистрацией: сети адреса, как их передала ручка (для суточного потолка). */
  regs: [] as { nets: string[] }[],
  sessions: new Map<string, string>(),
  sessionLookups: 0,
  nameLookups: 0,
  deletes: 0,
  lists: 0,
  counts: 0,
  roster: 0,
  lookupDelayMs: 0,
  lookupGate: null as Promise<void> | null,
  failDb: false,
  tokenSeq: 0,
  CHAR: '0f8e0c5e-1c2b-4d6a-9e3f-1234567890ab',
}));
const pw = vi.hoisted(() => ({ hashes: 0, verifies: 0 }));
vi.mock('../db/db.js', () => ({
  getUserByName: async (name: string) => {
    db.nameLookups++;
    if (db.failDb) throw new Error('Connection terminated due to connection timeout');
    if (db.lookupDelayMs) await new Promise((r) => setTimeout(r, db.lookupDelayMs));
    if (db.lookupGate) await db.lookupGate;
    return db.users.get(name.toLowerCase()) ?? null;
  },
  createSession: async (userId: string) => {
    const t = (++db.tokenSeq).toString(16).padStart(64, 'd');
    db.sessions.set(t, userId);
    return t;
  },
  createUser: async (username: string, _h: string, _s: string, _ip?: string, net?: string, wider?: readonly string[]) => {
    const id = `user-${username.toLowerCase()}`;
    db.users.set(username.toLowerCase(), { id, username, passHash: 'h', passSalt: 's' });
    db.regs.push({ nets: [net ?? '', ...(wider ?? [])] });
    return id;
  },
  deleteSession: async (t: string) => {
    db.deletes++;
    if (db.failDb) throw new Error('Connection terminated due to connection timeout');
    return db.sessions.delete(t);
  },
  getSession: async (token: string) => { db.sessionLookups++; return db.sessions.get(token) ?? null; },
  // Как Postgres: строки, у которых совпала сеть любой ступени (/64, /56, /48).
  countRecentRegistrations: async (key: string) => db.regs.filter((r) => r.nets.includes(key)).length,
  listCharacters: async () => { db.lists++; return []; },
  getCharacter: async (id: string) => (id === db.CHAR ? { userId: 'user-honest', data: {}, version: 1 } : null),
  createCharacter: async () => 1,
  deleteCharacter: async () => undefined,
  countCharacters: async () => { db.counts++; return db.roster; },
  deleteSessionsOfUser: async () => 0,
  listLiveSessions: async () => [...db.sessions].map(([token, userId]) => ({ token, userId })),
  listUsernames: async () => [...db.users.keys()],
}));
vi.mock('../db/pool.js', () => ({ q: async () => [], q1: async () => null }));
vi.mock('../cluster/registry.js', () => ({
  liveNodes: async () => [{ id: 'node-0', url: 'ws://n0/ws', players: 0, rooms: 0, draining: false, cpu_seconds: 0, rss_bytes: '0', loop_p99_ms: 0, tick_hz: 30 }],
  claimChar: async (_c: string, n: string) => n,
  sweepNodes: async () => 0,
  liveClaim: async () => null,
}));
// Сверка — синхронной подменой: ручка её дожидается (`await` на значении — то же значение); асинхронность scrypt — в `password.test.ts`.
vi.mock('../auth/password.js', () => ({
  hashPassword: () => { pw.hashes++; return { hash: 'h', salt: 's' }; },
  verifyPassword: (password: string) => { pw.verifies++; return password === 'own-secret'; },
}));

let server: Server;
let base = '';
let rl: typeof import('./rateLimit.js');
let auth: typeof import('./authSession.js');
/** Часы бакетов (мс): стоят, пока тест их не сдвинет. */
let T = 1_000_000;
beforeAll(async () => {
  for (const n of ['honest', 'someone', 'neigh', 'returning', 'victim', 'owner']) {
    db.users.set(n, { id: `user-${n}`, username: n, passHash: 'h', passSalt: 's' });
  }
  const cfg = new ConfigRegistry();
  cfg.loadAll();
  rl = await import('./rateLimit.js');
  auth = await import('./authSession.js');
  const { installAccountRoutes } = await import('./accountRoutes.js');
  const { installGatewayRoutes } = await import('../cluster/gateway.js');
  const app = express();
  installAccountRoutes(app, { config: cfg });
  installGatewayRoutes(app);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server.keepAliveTimeout = 60_000;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  db.sessionLookups = 0; db.nameLookups = 0; db.deletes = 0; db.lists = 0; db.counts = 0; db.roster = 0;
  db.lookupDelayMs = 0; db.lookupGate = null; db.failDb = false;
  pw.hashes = 0; pw.verifies = 0;
  T += 3_600_000;   // час между тестами: бакеты ников и аккаунтов прошлых тестов полны
  vi.spyOn(performance, 'now').mockImplementation(() => T);
  (rl.limits as unknown as Record<string, { reset?(k: string): void }>).scrypt?.reset?.('all');
});

let natSeq = 0;
/** Свой адрес на тест: бакеты адреса у каждого теста свои. */
const nat = (): string => `198.51.100.${++natSeq}`;
const junk = (i: number): string => i.toString(16).padStart(64, 'e');

async function get(path: string, ip: string, token: string): Promise<number> {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip } });
  await r.body?.cancel();
  return r.status;
}
async function post(path: string, ip: string, body?: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown>; retry: string | null }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, body: json, retry: r.headers.get('retry-after') };
}
const login = (ip: string, username: string, password: string, device?: string) =>
  post('/api/login', ip, { username, password, ...(device ? { device } : {}) });
const register = (ip: string, username: string) => post('/api/register', ip, { username, password: 'secret-123' });
const route = (ip: string, token: string): Promise<number> => get(`/api/route?charId=${db.CHAR}`, ip, token);
const characters = (ip: string, token: string): Promise<number> => get('/api/characters', ip, token);

describe('⭐ R11-01: IPv6 — лимиты и суточный потолок ступенями /64, /56, /48', () => {
  /** Общий бюджет scrypt процесса — полон: здесь проверяются ступени сети, а не он (у него свой тест ниже). */
  const fullBudget = (): void => { (rl.limits as unknown as Record<string, { reset?(k: string): void }>).scrypt?.reset?.('all'); };

  it('64 разные /64 одной /56, по 6 регистраций с каждой — аккаунтов (и scrypt) не больше потолка /56', async () => {
    const before = db.regs.length;
    for (let n = 0; n < 64; n++) {
      const ip = `2001:db8:77:${(0x7700 + n).toString(16)}::1`;
      for (let k = 0; k < 6; k++) { fullBudget(); await register(ip, `farm${n}x${k}`); }
    }
    const made = db.regs.length - before;
    expect(made, `аккаунтов с одной /56: ${made}`).toBeLessThanOrEqual(20);
    expect(pw.hashes, `scrypt регистраций: ${pw.hashes}`).toBeLessThanOrEqual(20);
  });

  it('туннель /48: по регистрации из 256 разных /56 — аккаунтов не больше потолка /48', async () => {
    const before = db.regs.length;
    for (let n = 0; n < 256; n++) { fullBudget(); await register(`2001:db8:48:${(n << 8).toString(16)}::1`, `tun${n}`); }
    const made = db.regs.length - before;
    expect(made, `аккаунтов с одной /48: ${made}`).toBeLessThanOrEqual(80);
  });

  it('вход: 64 разные /64 одной /56 к разным никам — бакет адреса общий на /56, а не 64 независимых', async () => {
    for (let n = 0; n < 64; n++) db.users.set(`v56-${n}`, { id: `user-v56-${n}`, username: `v56-${n}`, passHash: 'h', passSalt: 's' });
    let refused = 0;
    for (let n = 0; n < 64; n++) {
      fullBudget();
      const st = (await login(`2001:db8:56:${(0x5600 + n).toString(16)}::1`, `v56-${n}`, 'wrong-pass')).status;
      if (st === 429) refused++;
    }
    expect(pw.verifies, `сверок пароля с одной /56: ${pw.verifies}`).toBeLessThanOrEqual(40);
    expect(refused).toBeGreaterThan(0);
  });

  it('общий бюджет scrypt процесса: 200 неверных паролей с разных /48 к разным никам — сверок не больше бюджета, остальным 503 без scrypt', async () => {
    for (let i = 0; i < 200; i++) db.users.set(`spray${i}`, { id: `user-spray${i}`, username: `spray${i}`, passHash: 'h', passSalt: 's' });
    const statuses: number[] = [];
    let retry: string | null = null;
    for (let i = 0; i < 200; i++) {
      const r = await login(`2001:db8:${(0x1000 + i).toString(16)}::1`, `spray${i}`, 'wrong-pass');
      statuses.push(r.status);
      if (r.status === 503) retry = r.retry;
    }
    expect(pw.verifies, `сверок пароля: ${pw.verifies}`).toBeLessThanOrEqual(20);
    expect(statuses.filter((s) => s === 503).length).toBe(200 - pw.verifies);
    expect(Number(retry), 'Retry-After у «сервер занят»').toBeGreaterThan(0);
  });
});

describe('⭐ R11-05: соседа за общим адресом не запирают', () => {
  it('рестарт: живой токен, которого процесс не видел, — под потоком чужих токенов маршрут и ростер 200', async () => {
    const ip = nat();
    const token = 'c'.repeat(63) + '5';
    db.sessions.set(token, 'user-honest');   // сессия заведена до рестарта процесса
    rl.known.sessions.delete(auth.sessionKey(token));
    await auth.primeKnown();                  // старт процесса: живые сессии и ники — из базы
    for (let i = 0; i < 70; i++) await characters(ip, junk(10_000 + i));
    expect(await characters(ip, junk(10_999)), 'поток упёрся в потолок адреса').toBe(429);
    expect(await route(ip, token), 'маршрут').toBe(200);
    expect(await characters(ip, token), 'ростер').toBe(200);
  });

  it('токен, простоявший дольше 12 ч (срок сессии — неделя), — всё ещё свой: поток чужих его не запирает', async () => {
    const ip = nat();
    const { token } = (await login(nat(), 'honest', 'own-secret')).body as { token?: string };
    expect(token).toBeTruthy();
    T += 13 * 3_600_000;
    for (let i = 0; i < 70; i++) await characters(ip, junk(20_000 + i));
    expect(await route(ip, token!)).toBe(200);
  });

  it('рестарт: ник, которого процесс не видел, — после 61 мусорного ника с того же адреса верный пароль входит', async () => {
    const ip = nat();
    rl.known.names.delete('returning');
    await auth.primeKnown();
    for (let i = 0; i < 61; i++) await login(ip, `ghost-r11-${i}`, 'whatever-1');
    expect((await login(ip, `ghost-r11-x`, 'whatever-1')).status, 'поток ников упёрся в потолок').toBe(429);
    expect((await login(ip, 'returning', 'own-secret')).status).toBe(200);
  });

  it('ник, не входивший дольше суток, — всё ещё знаком: поток мусорных ников его не запирает', async () => {
    const ip = nat();
    expect((await login(nat(), 'owner', 'own-secret')).status).toBe(200);
    T += 25 * 3_600_000;
    for (let i = 0; i < 61; i++) await login(ip, `ghost-r11b-${i}`, 'whatever-1');
    expect((await login(ip, 'owner', 'own-secret')).status).toBe(200);
  });

  it('тролль: попытки к нику, чей потолок исчерпан, бакет адреса не тратят — сосед со своим паролем входит', async () => {
    const ip = nat();
    // Потолок ника «someone» исчерпан с другого адреса (перебор с ботнета).
    for (let i = 0; i < 10; i++) await login(nat(), 'someone', 'wrong-pass');
    expect((await login(nat(), 'someone', 'wrong-pass')).status).toBe(429);
    // С общего адреса — 20 попыток к нему же: все отказаны по нику.
    for (let i = 0; i < 20; i++) expect((await login(ip, 'someone', 'wrong-pass')).status).toBe(429);
    expect((await login(ip, 'neigh', 'own-secret')).status, 'сосед входит').toBe(200);
  });

  it('тролль: неверные пароли к разным никам опустошили бакет адреса — сосед с токеном устройства входит, и так раунд за раундом', async () => {
    const ip = nat();
    const first = await login(nat(), 'neigh', 'own-secret');
    expect(first.status).toBe(200);
    const device = first.body.device as string | undefined;
    expect(device, 'вход выдаёт токен устройства').toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < 10; i++) db.users.set(`dec${i}`, { id: `user-dec${i}`, username: `dec${i}`, passHash: 'h', passSalt: 's' });
    for (let i = 0; i < 10; i++) expect((await login(ip, `dec${i}`, 'wrong-pass')).status).toBe(401);
    expect((await login(ip, 'neigh', 'own-secret')).status, 'без токена устройства — потолок адреса (цена защиты)').toBe(429);
    expect((await login(ip, 'neigh', 'own-secret', device)).status, 'с токеном устройства').toBe(200);
    for (let k = 0; k < 5; k++) {
      T += 3_000;
      await login(ip, `dec${k}`, 'wrong-pass');
      expect((await login(ip, 'neigh', 'own-secret', device)).status, `раунд ${k}`).toBe(200);
    }
    // Чужой токен устройства (другого ника) не пропускает.
    expect((await login(ip, 'honest', 'own-secret', device)).status).toBe(429);
  });
});

describe('⭐ R11-06: ручки с токеном — под потолком аккаунта', () => {
  it('300 GET /api/characters со своим токеном — в базу не больше потолка аккаунта, хвост — 429', async () => {
    const ip = nat();
    const { token } = (await login(nat(), 'honest', 'own-secret')).body as { token?: string };
    const statuses: number[] = [];
    for (let i = 0; i < 300; i++) statuses.push(await characters(ip, token!));
    expect(db.lists, `ростер из базы: ${db.lists}`).toBeLessThanOrEqual(30);
    expect(db.sessionLookups, `сессия из базы: ${db.sessionLookups}`).toBeLessThanOrEqual(30);
    expect(statuses.slice(-10)).toEqual(Array(10).fill(429));
  });

  it('300 POST /api/characters при полном ростере — подсчёт героев в базе не больше потолка аккаунта', async () => {
    const ip = nat();
    const { token } = (await login(nat(), 'honest', 'own-secret')).body as { token?: string };
    db.roster = 5;
    for (let i = 0; i < 300; i++) await post('/api/characters', ip, { classId: 'warrior', name: 'Hero' }, token);
    expect(db.counts, `подсчётов героев: ${db.counts}`).toBeLessThanOrEqual(30);
  });
});

describe('⭐ R11-07: выход — под бакетом адреса, как прочие ручки с токеном', () => {
  it('300 анонимных выходов с чужими токенами — в базу не больше потолка адреса (60), хвост — 429', async () => {
    const ip = nat();
    const statuses: number[] = [];
    for (let i = 0; i < 300; i++) statuses.push((await post('/api/logout', ip, undefined, junk(30_000 + i))).status);
    expect(db.deletes, `удалений сессии: ${db.deletes}`).toBeLessThanOrEqual(60);
    expect(statuses.slice(-10)).toEqual(Array(10).fill(429));
  });

  it('свой токен выходит всегда: знакомый — и незнакомый процессу (рестарт), даже под потоком чужих', async () => {
    const ip = nat();
    const { token } = (await login(nat(), 'honest', 'own-secret')).body as { token?: string };
    for (let i = 0; i < 70; i++) await post('/api/logout', ip, undefined, junk(40_000 + i));
    expect((await post('/api/logout', ip, undefined, token)).status).toBe(200);
    expect(db.sessions.has(token!), 'знакомая сессия удалена').toBe(false);
    const ip2 = nat();
    const other = 'c'.repeat(63) + '7';
    db.sessions.set(other, 'user-honest');
    rl.known.sessions.delete(auth.sessionKey(other));
    expect((await post('/api/logout', ip2, undefined, other)).status).toBe(200);
    expect(db.sessions.has(other), 'незнакомая сессия удалена').toBe(false);
  });
});

describe('⭐ R11-08: регистрация — бакет адреса только перед scrypt', () => {
  it('пустые тела с общего адреса (5 подряд, дальше одно в 30 с) — сосед регистрируется', async () => {
    const ip = nat();
    for (let i = 0; i < 5; i++) expect((await post('/api/register', ip, {})).status).toBe(422);
    expect((await register(ip, 'newbie-a')).status).toBe(200);
    for (let k = 0; k < 3; k++) {
      T += 30_000;
      await post('/api/register', ip, {});
      expect((await register(ip, `newbie-b${k}`)).status, `раунд ${k}`).toBe(200);
    }
    expect(pw.hashes).toBeLessThanOrEqual(5);
  });

  it('поток «ник занят» с общего адреса — бакет адреса цел, сосед регистрируется', async () => {
    const ip = nat();
    for (let i = 0; i < 30; i++) expect((await register(ip, 'honest')).status).toBe(409);
    expect((await register(ip, 'newbie-c')).status).toBe(200);
  });
});

describe('⭐ R11-10: знакомый ник — пачка одновременных входов ищет ник в базе не больше потолка', () => {
  it('150 одновременных неверных паролей к знакомому нику с одного адреса — поисков в базе не больше 60', async () => {
    const ip = nat();
    expect((await login(nat(), 'victim', 'wrong-pass')).status).toBe(401);   // ник знаком процессу
    db.nameLookups = 0;
    // Поиск в базе ждёт ворот, пока ВСЕ 150 запросов не дошли до него или не получили отказ: пачка — по-настоящему одновременная.
    let open!: () => void;
    db.lookupGate = new Promise<void>((r) => { open = r; });
    let answered = 0;
    const all = Array.from({ length: 150 }, () => login(ip, 'victim', 'wrong-pass').then((r) => { answered++; return r; }));
    for (let i = 0; i < 20_000 && db.nameLookups + answered < 150; i++) await new Promise((r) => setTimeout(r, 1));
    db.lookupGate = null;
    open();
    const statuses = (await Promise.all(all)).map((r) => r.status);
    expect(db.nameLookups, `поисков ника: ${db.nameLookups}`).toBeLessThanOrEqual(60);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(90);
  });
});

describe('⭐ R11-11: сбой базы — лог через глушитель, а не стек на каждый запрос', () => {
  it('200 анонимных выходов, пока база не отвечает, — строк в логе не больше двух', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Окно глушителя — 10 с по `Date.now`: часы стоят, и «за 10 с» не зависит от скорости машины под нагрузкой полного прогона.
    const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    db.failDb = true;
    try {
      const statuses = new Set<number>();
      for (let i = 0; i < 200; i++) statuses.add((await post('/api/logout', `203.0.113.${i % 250}`, undefined, junk(90_000 + i))).status);
      for (let i = 0; i < 50; i++) statuses.add((await login(`203.0.114.${i}`, `lost${i}`, 'whatever-1')).status);
      expect([...statuses].every((s) => s === 500 || s === 429)).toBe(true);
      expect(err.mock.calls.length, 'строк в логе').toBeLessThanOrEqual(2);
    } finally {
      db.failDb = false;
      wall.mockRestore();
      err.mockRestore();
    }
  });
});
