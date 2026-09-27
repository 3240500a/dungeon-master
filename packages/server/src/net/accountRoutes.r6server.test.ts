import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Express, type ErrorRequestHandler } from 'express';
import { createRequire } from 'node:module';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { ConfigRegistry } from '@dm/shared';

/**
 * Раунд 6 (сервер), HTTP: суточный потолок аккаунтов — по сети адреса (IPv6 — /64), а не по адресу (R6-19); тело запроса
 * разбирается только там, где оно нужно, и маленьким (R6-04: анонимный POST с 2 МБ вложенного JSON держал главный поток
 * всех комнат ~115 мс ДО любого лимита); кривой JSON — 400 без стека в логе (R6-21). Ручки — настоящие
 * (`installAccountRoutes`), прокси — настоящий uWS (`proxyToExpress`), база — шпион.
 */
const db = vi.hoisted(() => {
  const TOKEN = 'a'.repeat(64);
  /** Заведённые аккаунты: адрес и сеть адреса, как их передала ручка. */
  const users: { ip?: string; net?: string }[] = [];
  const spy = <T>(out: (...a: unknown[]) => T) => (...args: unknown[]): Promise<T> => Promise.resolve(out(...args));
  return { TOKEN, users, spy };
});
vi.mock('../db/db.js', () => ({
  createUser: db.spy((_n, _h, _s, ip, net) => { db.users.push({ ip: ip as string, net: net as string | undefined }); return `user-${db.users.length}`; }),
  getUserByName: db.spy(() => null),
  createSession: db.spy(() => db.TOKEN),
  deleteSession: db.spy(() => undefined),
  getSession: db.spy((t) => (t === db.TOKEN ? 'user-1' : null)),
  // Как Postgres: считает строки, у которых совпал ключ, — сеть адреса, а у строк до правки — сам адрес.
  countRecentRegistrations: db.spy((key) => db.users.filter((u) => (u.net ?? u.ip) === key).length),
  listCharacters: db.spy(() => []),
  getCharacter: db.spy(() => null),
  createCharacter: db.spy(() => 1),
  deleteCharacter: db.spy(() => undefined),
  countCharacters: db.spy(() => 0),
  deleteSessionsOfUser: db.spy(() => 0),
}));

interface UwsLike {
  App(): { any(p: string, h: (res: unknown, req: unknown) => void): { listen(host: string, port: number, cb: (t: unknown) => void): void } };
  us_socket_local_port(t: unknown): number;
  us_listen_socket_close(t: unknown): void;
}
let uWS: UwsLike | null = null;
try { uWS = createRequire(import.meta.url)('uWebSockets.js') as UwsLike; } catch { /* пакет не собран под платформу */ }

let config: ConfigRegistry;
const servers: Server[] = [];
let uwsToken: unknown = null;
/** Обработчик ошибок express (R6-21), если он есть. */
let httpErrors: ErrorRequestHandler | undefined;
async function listen(app: Express): Promise<number> {
  const s = await new Promise<Server>((resolve) => { const v = app.listen(0, '127.0.0.1', () => resolve(v)); });
  servers.push(s);
  return (s.address() as AddressInfo).port;
}
/** Приложение как в `index.ts` ПОСЛЕ правки: ручки аккаунтов со своим разбором тела, обработчик ошибок в конце. */
async function accountApp(): Promise<Express> {
  const { installAccountRoutes } = await import('./accountRoutes.js');
  const app = express();
  app.set('env', 'production');   // как в бою: обработчик express по умолчанию пишет стек в лог везде, кроме env=test
  installAccountRoutes(app, { config });
  if (httpErrors) app.use(httpErrors);
  return app;
}
beforeAll(async () => {
  config = new ConfigRegistry();
  config.loadAll();
  httpErrors = ((await import('./asyncRoute.js')) as { httpErrors?: ErrorRequestHandler }).httpErrors;
});
afterAll(() => {
  for (const s of servers) s.close();
  if (uWS && uwsToken) uWS.us_listen_socket_close(uwsToken);
});
// Лимиты входа — у каждого теста свои: запросы идут с петли одним адресом.
beforeEach(async () => {
  const { limits } = await import('./rateLimit.js');
  limits.login.reset('127.0.0.1');
  limits.loginUser.reset('hero');
});

describe('⭐ R6-19: суточный потолок аккаунтов — по сети адреса (IPv6 — /64)', () => {
  let port = 0;
  beforeAll(async () => {
    // Приложение как в `index.ts` ДО правки R6-04 (общий разбор тела) — потолок проверяется сам по себе.
    const { installAccountRoutes } = await import('./accountRoutes.js');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    installAccountRoutes(app, { config });
    port = await listen(app);
  });

  it('шесть регистраций с шести адресов одной /64 — шестая «слишком много аккаунтов»', async () => {
    const { limits, ipBucket } = await import('./rateLimit.js');
    db.users.length = 0;
    const results: { status: number; error?: string }[] = [];
    for (let i = 1; i <= 6; i++) {
      const ip = `2001:db8:77:5::${i}`;
      limits.register.reset(ipBucket(ip));   // лимит частоты проверен своим тестом — здесь только суточный потолок
      const r = await fetch(`http://127.0.0.1:${port}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },   // с петли — доверенный прокси
        body: JSON.stringify({ username: `farm${i}`, password: 'secret-1' }),
      });
      results.push({ status: r.status, error: ((await r.json()) as { error?: string }).error });
    }
    expect(results.slice(0, 5).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results[5]).toEqual({ status: 429, error: 'С этого адреса сегодня создано слишком много аккаунтов' });
    expect(db.users[0], 'в базу — и адрес (для разбора), и его сеть').toEqual({ ip: '2001:db8:77:5::1', net: ipBucket('2001:db8:77:5::1') });
  });
});

/** POST с телом `body` на `port` (прокси отказав закрывает соединение посреди тела — ответ ловим, обрыв не ошибка). */
function post(port: number, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
      answered = true;
      let out = '';
      res.on('data', (d: Buffer) => { out += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      res.on('error', () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    req.on('error', (e) => { if (!answered) reject(e); });
    req.end(body);
  });
}

describe('⭐ R6-04: тело запроса — только там, где оно нужно, и маленькое', () => {
  /** 2 МБ сплошной вложенности — разбор такого стоил ~115 мс главного потока. */
  const NESTED = '['.repeat(1024 * 1024 - 8) + ']'.repeat(1024 * 1024 - 8);

  it('index.ts не разбирает тела всех запросов подряд', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/app\.use\(\s*express\.(json|raw|text|urlencoded)\(/);
  });

  it('прямо в express (транспорт ws): 10 × 2 МБ вложенного JSON на вход — 413, ручка не вызвана, тело не разобрано', async () => {
    const { limits } = await import('./rateLimit.js');
    const port = await listen(await accountApp());
    const take = vi.spyOn(limits.login, 'peek');   // R7-13: ручка входа первым делом спрашивает бакет адреса (платит — неудача)
    const parse = vi.spyOn(JSON, 'parse');
    // Цикл «не стоит» — без настенных часов: раньше здесь был худший лаг цикла < 50 мс, и под нагрузкой полного прогона
    // (процесс ждёт своей очереди на ядро) он давал 51–104 мс на исправном коде. Прямо: тело больше потолка НЕ РАЗБИРАЕТСЯ
    // (разбор — это те ~115 мс на запрос), и процессорного времени на десять запросов уходит меньше, чем стоил бы один разбор
    // каждого (≈1,2 с) — хоть клиент в том же процессе и сам готовит по 2 МБ.
    const cpu0 = process.cpuUsage();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await post(port, '/api/login', NESTED).catch(() => ({ status: -1, body: '' }))).status);
    const cpu = process.cpuUsage(cpu0);
    expect(statuses).toEqual(Array(10).fill(413));
    expect(take, 'до ручки входа не дошло').not.toHaveBeenCalled();
    expect(parse.mock.calls.filter(([s]) => typeof s === 'string' && s.length > 8 * 1024), 'тело больше потолка не разбиралось').toEqual([]);
    expect((cpu.user + cpu.system) / 1000, 'процессорное время на 10 запросов, мс').toBeLessThan(600);
    parse.mockRestore();
    take.mockRestore();
  });

  it.runIf(!!uWS)('за прокси uWS: 2 МБ на вход — 413 от самого прокси, до express не доходит', async () => {
    const { limits } = await import('./rateLimit.js');
    const { proxyToExpress } = await import('./uwsServer.js');
    const reached: string[] = [];
    const app = express();
    app.use((req, _res, next) => { reached.push(req.path); next(); });
    const { installAccountRoutes } = await import('./accountRoutes.js');
    installAccountRoutes(app, { config });
    if (httpErrors) app.use(httpErrors);
    const httpPort = await listen(app);
    const u = uWS!;
    const uwsPort = await new Promise<number>((resolve, reject) => {
      u.App().any('/*', (res, req) => proxyToExpress(res as never, req as never, httpPort)).listen('127.0.0.1', 0, (t) => {
        if (!t) { reject(new Error('uWS не занял порт')); return; }
        uwsToken = t; resolve(u.us_socket_local_port(t));
      });
    });
    const take = vi.spyOn(limits.login, 'peek');   // R7-13: ручка входа первым делом спрашивает бакет адреса (платит — неудача)
    const r = await post(uwsPort, '/api/login', NESTED).catch(() => ({ status: -1, body: '' }));
    expect(r.status).toBe(413);
    expect(reached, 'express запроса не видел').not.toContain('/api/login');
    expect(take).not.toHaveBeenCalled();
    // Честный вход по-прежнему проходит прокси и доходит до ручки.
    const ok = await post(uwsPort, '/api/login', JSON.stringify({ username: 'hero', password: 'secret-1' }));
    expect(ok.status, ok.body).toBe(401);
    expect(take).toHaveBeenCalled();
    take.mockRestore();
  });
});

describe('⭐ R6-21: кривой JSON — 400, а не стек в лог на каждый запрос', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('50 запросов с телом «{» — 50 ответов 400 JSON, лог молчит', async () => {
    const port = await listen(await accountApp());
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bodies: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await post(port, '/api/login', '{');
      expect(r.status).toBe(400);
      bodies.push(r.body);
    }
    expect(JSON.parse(bodies[0]!)).toEqual({ error: 'Неверный запрос' });
    expect(err.mock.calls.length, 'лог').toBeLessThanOrEqual(1);
  });
});
