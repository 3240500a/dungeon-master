import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createRequire } from 'node:module';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * ⭐ R3-03, R3-07: СЛУЖЕБНЫЕ РУЧКИ И АДРЕС КЛИЕНТА ЗА НАСТОЯЩИМ ТРАНСПОРТОМ. uWS держит игровой порт и переправляет
 * всё, что не `/ws`, в express на петле — поэтому express видел адрес сокета 127.0.0.1 у КАЖДОГО запроса. Проверка
 * «только с самой машины» пускала любого: `curl -X POST http://сервер:порт/internal/drain` гасил ноду, `/metrics`
 * отдавался наружу. А `X-Forwarded-For`, присланный самим клиентом, проходил прокси насквозь и становился ключом
 * лимитов входа и регистрации — новый заголовок на каждую попытку, и лимиты не срабатывали никогда.
 *
 * Здесь настоящий прокси uWS (`proxyToExpress`) стоит перед настоящими ручками (`installInternalRoutes`), запросы
 * идут по сети — с петли и, если у машины есть сетевой адрес, с него (это «чужой» для сервера собеседник).
 */
vi.mock('../db/db.js', () => ({}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(null),
}));

interface UwsLike {
  App(): { any(p: string, h: (res: unknown, req: unknown) => void): { listen(host: string, port: number, cb: (t: unknown) => void): void } };
  us_socket_local_port(t: unknown): number;
  us_listen_socket_close(t: unknown): void;
}
let uWS: UwsLike | null = null;
try { uWS = createRequire(import.meta.url)('uWebSockets.js') as UwsLike; } catch { /* пакет не собран под платформу — прокси нечего проверять */ }
/** Сетевой адрес этой машины — запрос с него для сервера «не с петли». Нет такого — эти проверки пропускаются. */
const LAN = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

const drained = vi.fn();
/** R5-24: ключ чтения метрик для удалённого сборщика (стенд `dmload` с другой машины, Prometheus на отдельном хосте). */
const METRICS_KEY = 'm'.repeat(40);
/** R4-11: пути, дошедшие до express, и вызовы ручки входа. */
const reached: string[] = [];
let loginCalls = 0;
let server: Server;
let httpPort = 0;
let uwsPort = 0;
let listenToken: unknown = null;

beforeAll(async () => {
  const { installInternalRoutes } = await import('./internalRoutes.js');
  const { clientIp } = await import('./rateLimit.js');
  const { proxyToExpress } = await import('./uwsServer.js');
  const app = express();
  installInternalRoutes(app, { nodeId: 'node-t', metrics: () => Promise.resolve('dm_probe 1\n'), drain: drained, metricsKey: METRICS_KEY });
  // Эхо: какой адрес клиента увидят лимиты входа и регистрации и что пришло в заголовке.
  app.get('/echo', (req, res) => { res.json({ ip: clientIp(req.headers, req.socket.remoteAddress), xff: req.headers['x-forwarded-for'] ?? null }); });
  // R4-11: какие запросы вообще дошли до express (прокси не обязан нести ему всё подряд) — и ручки с телом, как в index.ts.
  app.use((req, _res, next) => { reached.push(req.path); next(); });
  app.post('/api/login', express.json({ limit: '2mb' }), (_req, res) => { loginCalls++; res.json({ ok: true }); });
  app.post('/api/dev/assets/:id', express.raw({ type: () => true, limit: '64mb' }), (req, res) => { res.json({ len: (req.body as Buffer).length }); });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  httpPort = (server.address() as AddressInfo).port;
  if (uWS) {
    const u = uWS;
    await new Promise<void>((resolve, reject) => {
      u.App().any('/*', (res, req) => proxyToExpress(res as never, req as never, httpPort)).listen('0.0.0.0', 0, (t) => {
        if (!t) { reject(new Error('uWS не занял порт')); return; }
        listenToken = t; uwsPort = u.us_socket_local_port(t); resolve();
      });
    });
  }
});
afterAll(() => {
  if (uWS && listenToken) uWS.us_listen_socket_close(listenToken);
  server.close();
});

/** HTTP-запрос с явным адресом отправителя (`from`) — так «чужой» собеседник получается без второй машины. */
function call(o: { to: string; port: number; path: string; method?: string; headers?: Record<string, string>; from?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: o.to, port: o.port, path: o.path, method: o.method ?? 'GET', headers: o.headers, localAddress: o.from }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const settleDrain = (): Promise<void> => new Promise((r) => setTimeout(r, 120));

describe.runIf(!!uWS)('служебные ручки за прокси uWS (R3-03)', () => {
  it('⭐ запрос не с петли — /metrics и /internal/drain закрыты (403), слива нет', async () => {
    if (!LAN) return;
    drained.mockClear();
    expect((await call({ to: LAN, port: uwsPort, path: '/metrics', from: LAN })).status).toBe(403);
    expect((await call({ to: LAN, port: uwsPort, path: '/internal/drain', method: 'POST', from: LAN })).status).toBe(403);
    await settleDrain();
    expect(drained).not.toHaveBeenCalled();
  });

  it('⭐ через обратный прокси на той же машине (есть X-Forwarded-For) — тоже закрыты: это чужой запрос', async () => {
    drained.mockClear();
    const via = { 'x-forwarded-for': '203.0.113.9' };
    expect((await call({ to: '127.0.0.1', port: uwsPort, path: '/metrics', headers: via })).status).toBe(403);
    expect((await call({ to: '127.0.0.1', port: uwsPort, path: '/internal/drain', method: 'POST', headers: via })).status).toBe(403);
    await settleDrain();
    expect(drained).not.toHaveBeenCalled();
  });

  it('с самой машины — открыты: и через игровой порт (стенд, мониторинг), и прямо на петлю express', async () => {
    drained.mockClear();
    const m = await call({ to: '127.0.0.1', port: uwsPort, path: '/metrics' });
    expect(m.status).toBe(200);
    expect(m.body).toContain('dm_probe 1');
    expect((await call({ to: '127.0.0.1', port: httpPort, path: '/metrics' })).status).toBe(200);
    expect((await call({ to: '127.0.0.1', port: httpPort, path: '/internal/drain', method: 'POST' })).status).toBe(200);
    await settleDrain();
    expect(drained).toHaveBeenCalledTimes(1);
  });
});

/**
 * ⭐ R5-24: МЕТРИКИ ДЛЯ СТЕНДА С ДРУГОЙ МАШИНЫ — ПО КЛЮЧУ. С R3-03 `/metrics` отвечает 403 всем, кроме прямого вызова с самой
 * машины, а стенд по STAND.md запускается с ноутбука: `dmload` не смотрел на код ответа, частота тика читалась нулём,
 * проверка «мир в слоу-мо» не срабатывала никогда, и перегруженный сервер проходил замер ёмкости с ✓. Теперь удалённому
 * сборщику — ключ только на чтение (`DM_METRICS_KEY`); слив узла — по-прежнему только с самой машины.
 */
describe.runIf(!!uWS)('⭐ R5-24: /metrics по ключу чтения — и не с машины сервера', () => {
  const bearer = (k: string): Record<string, string> => ({ authorization: `Bearer ${k}` });
  it('не с петли с верным ключом — 200 на /metrics, но слив — 403; неверный ключ — 403', async () => {
    if (!LAN) return;
    drained.mockClear();
    const m = await call({ to: LAN, port: uwsPort, path: '/metrics', from: LAN, headers: bearer(METRICS_KEY) });
    expect(m.status).toBe(200);
    expect(m.body).toContain('dm_probe 1');
    expect((await call({ to: LAN, port: uwsPort, path: '/metrics', from: LAN, headers: bearer('x'.repeat(40)) })).status).toBe(403);
    expect((await call({ to: LAN, port: uwsPort, path: '/internal/drain', method: 'POST', from: LAN, headers: bearer(METRICS_KEY) })).status).toBe(403);
    await settleDrain();
    expect(drained).not.toHaveBeenCalled();
  });

  it('через обратный прокси (X-Forwarded-For) с ключом — 200; без ключа — 403, как было', async () => {
    const via = { 'x-forwarded-for': '203.0.113.9' };
    expect((await call({ to: '127.0.0.1', port: uwsPort, path: '/metrics', headers: { ...via, ...bearer(METRICS_KEY) } })).status).toBe(200);
    expect((await call({ to: '127.0.0.1', port: uwsPort, path: '/metrics', headers: via })).status).toBe(403);
  });

  it('ключ короче 16 знаков не включается вовсе — слабый ключ никого не пускает', async () => {
    const { installInternalRoutes } = await import('./internalRoutes.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = express();
    installInternalRoutes(app, { nodeId: 'node-w', metrics: () => Promise.resolve('x 1\n'), drain: () => undefined, metricsKey: 'short' });
    const s = await new Promise<Server>((resolve) => { const v = app.listen(0, '127.0.0.1', () => resolve(v)); });
    try {
      const port = (s.address() as AddressInfo).port;
      expect((await call({ to: '127.0.0.1', port, path: '/metrics', headers: { 'x-forwarded-for': '203.0.113.9', ...bearer('short') } })).status).toBe(403);
      expect(warn).toHaveBeenCalled();
    } finally { s.close(); warn.mockRestore(); }
  });
});

describe.runIf(!!uWS)('адрес клиента за прокси uWS (R3-07)', () => {
  it('⭐ X-Forwarded-For, присланный самим клиентом, заменяется настоящим адресом — ключ лимитов не подделать', async () => {
    if (!LAN) return;
    const r = JSON.parse((await call({ to: LAN, port: uwsPort, path: '/echo', from: LAN, headers: { 'x-forwarded-for': '10.0.0.5' } })).body) as { ip: string; xff: string };
    expect(r.ip).toBe(LAN);
    expect(r.xff, 'заголовок перезаписан прокси').toBe(LAN);
  });

  it('обратный прокси на той же машине: клиент — ПРАВЫЙ адрес его цепочки (его дописал прокси), а не левый', async () => {
    const r = JSON.parse((await call({ to: '127.0.0.1', port: uwsPort, path: '/echo', headers: { 'x-forwarded-for': '10.0.0.5, 203.0.113.9' } })).body) as { ip: string; xff: string };
    expect(r.ip).toBe('203.0.113.9');
    expect(r.xff).toBe('203.0.113.9');
  });

  it('с петли без заголовков — петля', async () => {
    const r = JSON.parse((await call({ to: '127.0.0.1', port: uwsPort, path: '/echo' })).body) as { ip: string };
    expect(r.ip).toBe('127.0.0.1');
  });
});

/**
 * Тело запроса по сети: `chunked` — без Content-Length (как шлёт скрипт, чтобы прокси не знал размер заранее), иначе с ним.
 * Прокси, отказав, закрывает соединение посреди тела — ответ ловим, а обрыв записи не считаем ошибкой.
 */
function post(o: { port: number; path: string; bytes: number; chunked?: boolean; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = httpRequest({
      host: '127.0.0.1', port: o.port, path: o.path, method: 'POST',
      headers: { 'content-type': 'application/json', ...(o.chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(o.bytes) }), ...o.headers },
    }, (res) => {
      answered = true;
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', (e) => { if (!answered) reject(e); });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let left = o.bytes;
    const pump = (): void => {
      while (left > 0) {
        const n = Math.min(left, chunk.length);
        left -= n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) { req.once('drain', pump); return; }
      }
      req.end();
    };
    pump();
  });
}

describe.runIf(!!uWS)('тело запроса за прокси uWS (R4-11)', () => {
  it('⭐ тело больше потолка без Content-Length — 413 от самого прокси: express его не видит, память не копится', async () => {
    reached.length = 0; loginCalls = 0;
    const r = await post({ port: uwsPort, path: '/api/login', bytes: 3 * 1024 * 1024, chunked: true }).catch(() => ({ status: -1, body: '' }));
    expect(r.status, 'отказ — от прокси').toBe(413);
    expect(reached, 'до express не дошло').not.toContain('/api/login');
    expect(loginCalls).toBe(0);
  });

  it('⭐ Content-Length больше потолка — 413 сразу, до тела', async () => {
    reached.length = 0;
    const r = await post({ port: uwsPort, path: '/api/login', bytes: 3 * 1024 * 1024 }).catch(() => ({ status: -1, body: '' }));
    expect(r.status).toBe(413);
    expect(reached).not.toContain('/api/login');
  });

  it('обычное тело проходит; загрузка модели вне продакшена — до своего потолка (64 МБ)', async () => {
    reached.length = 0; loginCalls = 0;
    const small = await post({ port: uwsPort, path: '/api/login', bytes: 1024, chunked: true });
    expect(small.status, 'пробелы — не JSON, но до express дошло').not.toBe(413);
    expect(reached).toContain('/api/login');
    const big = await post({ port: uwsPort, path: '/api/dev/assets/x', bytes: 3 * 1024 * 1024, chunked: true });
    expect(big.status).toBe(200);
    expect(JSON.parse(big.body)).toEqual({ len: 3 * 1024 * 1024 });
  });
});

describe('слив по команде на любой платформе (R4-27)', () => {
  it('⭐ слив — это обработчики SIGTERM процесса, а не сигнал: на Windows `process.kill(self)` убивает процесс без них', async () => {
    const { drainProcess } = await import('./internalRoutes.js');
    const heard = vi.fn();
    process.once('SIGTERM', heard);
    try {
      drainProcess();
      expect(heard, 'обработчик слива (запись сейвов, снятие ноды) вызван').toHaveBeenCalledTimes(1);
    } finally { process.removeListener('SIGTERM', heard); }
  });
});
