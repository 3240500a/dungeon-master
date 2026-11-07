import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { ConfigRegistry, SRV_CORPUS, pseudoText, type Locales } from '@dm/shared';
import { httpErrors, httpErrorsWith } from './asyncRoute.js';

/**
 * ⭐ i18n (07.11, хвосты Ф1): ОТКАЗЫ HTTP ДО ОБЛАСТИ ЗАПРОСА — НА ЯЗЫКЕ ЗАПРОСА. Кривой JSON и тело больше потолка отказывает разборщик
 * тела express — ДО ручки, то есть до её области языка (`withRequestLang`), а фронт uWS отказывает (400, 413, 502) ещё до express. Раньше —
 * всегда на источнике. Здесь — тем же правилом, что у ручек (`lang` строки запроса → `Accept-Language` → источник), а без таблицы и без
 * языка в запросе — побайтово прежний русский.
 */
const PSEUDO = (key: string): string => pseudoText(SRV_CORPUS[key] as string);
let locales: Locales;
const servers: Server[] = [];

beforeAll(() => {
  const cfg = new ConfigRegistry();
  cfg.loadAll();
  const strings: Record<string, string> = {};
  for (const k of ['srv:http.badRequest', 'srv:http.bodyTooLarge', 'srv:http.internalError', 'srv:http.proxyCut', 'srv:http.proxyUnreachable']) strings[k] = PSEUDO(k);
  locales = { ...(cfg.get('locales') as Locales), xx: { name: 'Pseudo', enabled: true, grammar: { join: ' ', agrees: false, capitalize: 'first' }, templates: {}, strings } } as Locales;
});
afterAll(() => { for (const s of servers) s.close(); });

async function listen(app: Express): Promise<number> {
  const s = await new Promise<Server>((resolve) => { const v = app.listen(0, '127.0.0.1', () => resolve(v)); });
  servers.push(s);
  return (s.address() as AddressInfo).port;
}
/** Приложение как в `index.ts`: разбор тела с потолком, ручка, обработчик ошибок в конце (`errors`). */
function appWith(errors: express.ErrorRequestHandler): Express {
  const app = express();
  app.set('env', 'production');
  app.post('/api/x', express.json({ limit: 64 }), (_req, res) => { res.json({ ok: true }); });
  app.get('/api/boom', (_req, _res, next) => { next(new Error('boom')); });
  app.use(errors);
  return app;
}
async function post(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
  return { status: r.status, text: await r.text() };
}

describe('⭐ i18n (07.11): отказы express до ручки — на языке запроса (`httpErrorsWith`)', () => {
  it('кривой JSON и 413 — по `Accept-Language` и `?lang=`; без языка — побайтово прежний русский', async () => {
    const port = await listen(appWith(httpErrorsWith(() => locales)));
    const bad = await post(port, '/api/x', '{', { 'accept-language': 'xx' });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.text)).toEqual({ error: PSEUDO('srv:http.badRequest') });
    expect(JSON.parse((await post(port, '/api/x?lang=xx', '{')).text)).toEqual({ error: PSEUDO('srv:http.badRequest') });
    const big = await post(port, '/api/x', JSON.stringify({ s: 'x'.repeat(200) }), { 'accept-language': 'en-US, xx;q=0.5' });
    expect(big.status).toBe(413);
    expect(JSON.parse(big.text)).toEqual({ error: PSEUDO('srv:http.bodyTooLarge') });
    // русский — те же байты, что до правки
    expect((await post(port, '/api/x', '{')).text).toBe('{"error":"Неверный запрос"}');
    expect((await post(port, '/api/x', JSON.stringify({ s: 'x'.repeat(200) }))).text).toBe('{"error":"Слишком большое тело запроса"}');
    // невключённый язык — источник
    expect((await post(port, '/api/x', '{', { 'accept-language': 'de' })).text).toBe('{"error":"Неверный запрос"}');
    // 500 — тоже на языке запроса
    const boom = await fetch(`http://127.0.0.1:${port}/api/boom`, { headers: { 'accept-language': 'xx' } });
    expect([boom.status, await boom.json()]).toEqual([500, { error: PSEUDO('srv:http.internalError') }]);
  });

  it('`httpErrors` без таблицы — источник, какой бы язык ни просили (прежнее поведение)', async () => {
    const port = await listen(appWith(httpErrors));
    expect((await post(port, '/api/x', '{', { 'accept-language': 'xx' })).text).toBe('{"error":"Неверный запрос"}');
  });
});

// ── фронт uWS ──
interface UwsLike {
  App(): { any(p: string, h: (res: unknown, req: unknown) => void): { listen(h: string, p: number, cb: (t: unknown) => void): void } };
  us_socket_local_port(t: unknown): number;
  us_listen_socket_close(t: unknown): void;
}
let uWS: UwsLike | null = null;
try { uWS = createRequire(import.meta.url)('uWebSockets.js') as UwsLike; } catch { /* пакет не собран под платформу */ }

describe.runIf(!!uWS)('⭐ i18n (07.11): отказы самого прокси uWS (400 / 413 / 502) — на языке запроса', () => {
  let proxyPort = 0, deadPort = 0;
  const tokens: unknown[] = [];
  beforeAll(async () => {
    const { proxyToExpress } = await import('./uwsServer.js');
    // порт, где никто не слушает: 502 «не достучался»
    const tmp = await new Promise<Server>((resolve) => { const v = express().listen(0, '127.0.0.1', () => resolve(v)); });
    deadPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    const u = uWS!;
    await new Promise<void>((resolve, reject) => {
      u.App().any('/*', (res, req) => proxyToExpress(res as never, req as never, deadPort, () => locales)).listen('127.0.0.1', 0, (t) => {
        if (!t) { reject(new Error('uWS не занял порт')); return; }
        tokens.push(t); proxyPort = u.us_socket_local_port(t); resolve();
      });
    });
  });
  afterAll(() => { for (const t of tokens) uWS?.us_listen_socket_close(t); });

  /** Сырой запрос по TCP → статус и тело ответа. */
  async function raw(text: string): Promise<{ status: string; body: string }> {
    const { connect } = await import('node:net');
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const s = connect(proxyPort, '127.0.0.1', () => s.write(Buffer.from(text, 'latin1')));
      const done = (): void => {
        clearTimeout(timer); s.destroy();
        const all = Buffer.concat(chunks).toString('utf8');
        const [head, ...rest] = all.split('\r\n\r\n');
        resolve({ status: (head ?? '').split('\r\n')[0] ?? '', body: rest.join('\r\n\r\n') });
      };
      const timer = setTimeout(done, 2000);
      s.on('data', (d: Buffer) => {
        chunks.push(d);
        // ответ целиком (заголовки + тело по `Content-Length`) — не ждать закрытия сокета
        const all = Buffer.concat(chunks);
        const end = all.indexOf('\r\n\r\n');
        const len = end < 0 ? NaN : Number(/content-length:\s*(\d+)/i.exec(all.subarray(0, end).toString('latin1'))?.[1]);
        if (end >= 0 && Number.isFinite(len) && all.length >= end + 4 + len) done();
      });
      s.on('close', done);
      s.on('error', done);
    });
  }
  const body = (b: string): unknown => JSON.parse(b.slice(b.indexOf('{'), b.lastIndexOf('}') + 1));

  it('400 (запрос без тела с заявленным телом) и 413 (заявлено больше потолка) — по `Accept-Language`; без языка — прежние байты', async () => {
    const bad = await raw('GET /api/x HTTP/1.1\r\nHost: a\r\nAccept-Language: xx\r\nContent-Length: 5\r\n\r\nhello');
    expect(bad.status).toContain('400');
    expect(body(bad.body)).toEqual({ error: PSEUDO('srv:http.badRequest') });
    const big = await raw('POST /api/login?lang=xx HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 99999999\r\n\r\n');
    expect(big.status).toContain('413');
    expect(body(big.body)).toEqual({ error: PSEUDO('srv:http.bodyTooLarge') });
    const ru = await raw('GET /api/x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello');
    expect(ru.body).toContain('{"error":"Неверный запрос"}');
  });

  it('502 «не достучался до express» — фразой языка с подстановкой ошибки сокета; русский — прежняя строка', async () => {
    const xx = await raw('GET /api/ping HTTP/1.1\r\nHost: a\r\nAccept-Language: xx\r\n\r\n');
    expect(xx.status).toContain('502');
    const msg = (body(xx.body) as { error: string }).error;
    expect(msg.startsWith(PSEUDO('srv:http.proxyUnreachable').replace('{error}', ''))).toBe(true);
    expect(msg).toMatch(/ECONNREFUSED/);
    expect(msg).not.toMatch(/[Ѐ-ӿ]/);
    const ru = await raw('GET /api/ping HTTP/1.1\r\nHost: a\r\n\r\n');
    expect((body(ru.body) as { error: string }).error).toMatch(/^прокси не достучался до express: .*ECONNREFUSED/);
  });
});
