import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createRequire } from 'node:module';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * ⭐ R14-11: СЛУЖЕБНЫЕ РУЧКИ И БРАУЗЕР НА ТОЙ ЖЕ МАШИНЕ. «Прямой вызов с самой машины» (R3-03, R12-01) смотрел только на адрес сокета
 * и заголовки прокси — а любая страница, открытая в браузере на машине сервера (dev у владельца, прод, если на нём кто-то сидит в
 * браузере), ходит на `localhost:3001` с петли и без заголовков прокси. `fetch(…/internal/drain, {method:'POST', mode:'no-cors'})` —
 * простой запрос без предзапроса: CORS лишь прячет ответ, а ручка уже отработала — слив, процесс уходит. С подменой DNS (evil.example →
 * 127.0.0.1) страница ещё и ЧИТАЛА `/metrics` и `/api/cluster` (источник совпадал с `Host`). Теперь браузерный запрос отличим: чужой
 * `Origin`, `Sec-Fetch-Site` не `none`, `Host` не петля — не с самой машины. curl, Prometheus, `dmload`, `fetch` из Node их не шлют.
 *
 * Здесь настоящие ручки (`installInternalRoutes`) — прямо на петле express и за настоящим прокси uWS (`proxyToExpress`).
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

const drained = vi.fn();
let server: Server;
let httpPort = 0;
let uwsPort = 0;
let listenToken: unknown = null;

beforeAll(async () => {
  const { installInternalRoutes } = await import('./internalRoutes.js');
  const { proxyToExpress } = await import('./uwsServer.js');
  const app = express();
  installInternalRoutes(app, { nodeId: 'node-r14', metrics: () => Promise.resolve('dm_probe 1\n'), drain: drained });
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

function call(o: { port: number; path: string; method?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: o.port, path: o.path, method: o.method ?? 'GET', headers: o.headers }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const settleDrain = (): Promise<void> => new Promise((r) => setTimeout(r, 120));

/** Порты, на которых проверяем: прямо express на петле и (если собран) игровой порт uWS перед ним. */
const ports = (): { name: string; port: number }[] => [{ name: 'express', port: httpPort }, ...(uWS ? [{ name: 'uWS', port: uwsPort }] : [])];
/** Что шлёт браузер со страницы evil.example: `fetch(…, {method:'POST', mode:'no-cors'})` и форма — с `Origin`. */
const EVIL_FETCH = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'content-type': 'text/plain' };

describe('⭐ R14-11: служебные ручки — не браузерной странице с той же машины', () => {
  it('⭐ POST /internal/drain со страницы чужого сайта (no-cors fetch, форма) — 403, слива нет', async () => {
    for (const { name, port } of ports()) {
      drained.mockClear();
      const host = { host: `localhost:${port}` };
      expect((await call({ port, path: '/internal/drain', method: 'POST', headers: { ...host, ...EVIL_FETCH } })).status, name).toBe(403);
      // Старый браузер без Sec-Fetch-*: `Origin` у POST есть всегда.
      expect((await call({ port, path: '/internal/drain', method: 'POST', headers: { ...host, origin: 'null' } })).status, `${name}: Origin null`).toBe(403);
      await settleDrain();
      expect(drained, name).not.toHaveBeenCalled();
    }
  });

  it('⭐ подмена DNS (Host — чужое имя, Origin с ним совпадает) — /metrics не читается: 403', async () => {
    for (const { name, port } of ports()) {
      const h = { host: `evil.example:${port}` };
      expect((await call({ port, path: '/metrics', headers: { ...h, origin: `http://evil.example:${port}`, 'sec-fetch-site': 'same-origin' } })).status, name).toBe(403);
      // И без Origin (GET того же источника, старый браузер): решает Host.
      expect((await call({ port, path: '/metrics', headers: h })).status, `${name}: Host`).toBe(403);
    }
  });

  it('контроль: curl, `fetch` из Node (стенд, супервизор) и адресная строка браузера на самой машине — открыты', async () => {
    for (const { name, port } of ports()) {
      drained.mockClear();
      // curl: Host — петля, других заголовков нет.
      const m = await call({ port, path: '/metrics', headers: { host: `127.0.0.1:${port}`, 'user-agent': 'curl/8.4.0' } });
      expect(m.status, name).toBe(200);
      expect(m.body).toContain('dm_probe 1');
      // fetch из Node (undici): `sec-fetch-mode: cors`, без Origin и Sec-Fetch-Site.
      const node = { host: `localhost:${port}`, 'sec-fetch-mode': 'cors', 'accept-language': '*', 'user-agent': 'node' };
      expect((await call({ port, path: '/metrics', headers: node })).status, `${name}: fetch из Node`).toBe(200);
      // Владелец открыл /metrics в адресной строке: навигация верхнего уровня — `Sec-Fetch-Site: none`, без Origin.
      expect((await call({ port, path: '/metrics', headers: { host: `[::1]:${port}`, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' } })).status,
        `${name}: адресная строка`).toBe(200);
      expect((await call({ port, path: '/internal/drain', method: 'POST', headers: { host: `127.0.0.1:${port}` } })).status, name).toBe(200);
      await settleDrain();
      expect(drained, name).toHaveBeenCalledTimes(1);
    }
  });
});
