import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';

/**
 * ⭐ R12-01: ПРОКСИ uWS → express НЕ ДЕЛИТ СОЕДИНЕНИЯ И НЕ ПЕРЕСЫЛАЕТ ЧУЖУЮ ДЛИНУ. Раньше прокси копировал заголовки клиента
 * целиком (и `Content-Length` у GET, чьё тело он не пересылал), а запрос к express шёл через общий пул Node 24 (соединения живут и
 * делятся между клиентами). GET с `Content-Length: N` оставлял express ждать N байт тела — ими становилась голова СЛЕДУЮЩЕГО
 * запроса чужого клиента на том же соединении, а тело того (`POST /internal/drain` без заголовков прокси) express разбирал как
 * отдельный запрос «с самой машины»: служебные ручки открывались любому без аккаунта.
 *
 * Здесь настоящий uWS (`proxyToExpress`) перед `node:http`, который спрашивает настоящий `localCaller`; клиенты — сырой TCP.
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
try { uWS = createRequire(import.meta.url)('uWebSockets.js') as UwsLike; } catch { /* пакет не собран под платформу */ }

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; local: boolean; body: string };
/** Что дошло до express: каждый разобранный им запрос. */
const seen: Seen[] = [];
let upstream: Server;
let capture: net.Server;
let captured = Buffer.alloc(0);
let upstreamPort = 0, proxyPort = 0, capProxyPort = 0;
const tokens: unknown[] = [];

beforeAll(async () => {
  if (!uWS) return;
  const { localCaller } = await import('./adminAccess.js');
  upstream = createServer((req, res) => {
    const answer = (body: string): void => {
      seen.push({
        method: req.method ?? '', url: req.url ?? '', headers: req.headers, body,
        local: localCaller(req.headers, req.socket.remoteAddress, req.socket.remotePort),
      });
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    };
    // Как ручки express: GET отвечает сразу, тела не ждёт (его у GET не бывает); остальные — по телу.
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') { answer(''); return; }
    let body = '';
    req.setEncoding('latin1');
    req.on('data', (d: string) => { body += d; });
    req.on('end', () => answer(body));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as AddressInfo).port;
  // «Express», который только записывает байты: сколько байт головы прокси шлёт за запрос — мерка для подгонки длины.
  capture = net.createServer((s) => { s.on('data', (d: Buffer) => { captured = Buffer.concat([captured, d]); }); });
  await new Promise<void>((r) => capture.listen(0, '127.0.0.1', () => r()));
  const { proxyToExpress } = await import('./uwsServer.js');
  const u = uWS;
  const mount = (port: number): Promise<number> => new Promise((resolve, reject) => {
    u.App().any('/*', (res, req) => proxyToExpress(res as never, req as never, port)).listen('127.0.0.1', 0, (t) => {
      if (!t) { reject(new Error('uWS не занял порт')); return; }
      tokens.push(t); resolve(u.us_socket_local_port(t));
    });
  });
  proxyPort = await mount(upstreamPort);
  capProxyPort = await mount((capture.address() as AddressInfo).port);
});
afterAll(() => {
  for (const t of tokens) uWS?.us_listen_socket_close(t);
  upstream?.close();
  capture?.close();
});

/** Разобрать ответы в `text` (промежуточные 1xx — не ответы): сколько пришло целиком, и их коды. */
function parse(text: string): number[] {
  const out: number[] = [];
  let at = 0;
  for (;;) {
    const end = text.indexOf('\r\n\r\n', at);
    if (end < 0) return out;
    const head = text.slice(at, end);
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
    const len = status >= 200 ? Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0) : 0;
    if (text.length < end + 4 + len) return out;
    if (status >= 200) out.push(status);
    at = end + 4 + len;
  }
}

/** Сырое соединение с прокси: `ask` шлёт запрос и ждёт ответ на него целиком (или закрытия соединения). */
async function dial(port: number): Promise<{ ask(data: string): Promise<{ status?: number; text: string }>; close(): void }> {
  const s = net.connect(port, '127.0.0.1');
  s.setEncoding('latin1');
  let text = '';
  let closed = false;
  let wake: (() => void) | null = null;
  s.on('data', (d: string) => { text += d; wake?.(); });
  s.on('close', () => { closed = true; wake?.(); });
  s.on('error', () => { closed = true; wake?.(); });
  await new Promise<void>((r) => s.once('connect', () => r()));
  let answered = 0;
  return {
    async ask(data) {
      const from = text.length;
      s.write(data);
      const deadline = Date.now() + 10_000;
      while (parse(text).length <= answered && !closed && Date.now() < deadline) {
        await new Promise<void>((r) => { wake = r; setTimeout(r, 200); });
      }
      const statuses = parse(text);
      const status = statuses.length > answered ? statuses[answered] : undefined;
      answered = statuses.length;
      return { status, text: text.slice(from) };
    },
    close() { s.destroy(); },
  };
}
/** Один запрос на своём соединении. */
async function raw(port: number, data: string): Promise<{ status?: number; text: string }> {
  const c = await dial(port);
  try { return await c.ask(data); } finally { c.close(); }
}
/** «Чужой» клиент для прокси: заголовок адреса делает запрос не-локальным (как у любого из интернета). */
const REMOTE = 'X-Forwarded-For: 203.0.113.7\r\n';

describe.runIf(!!uWS)('⭐ R12-01: GET с длиной тела не подсовывает express чужой запрос', () => {
  it('смещение по соединению с express: второй клиент не проносит «POST /internal/drain с самой машины»', async () => {
    const smuggled = 'POST /internal/drain HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n';
    const req2 = `POST /api/logout HTTP/1.1\r\nHost: x\r\n${REMOTE}Content-Type: text/plain\r\nContent-Length: ${smuggled.length}\r\n\r\n${smuggled}`;
    // Мерка: сколько байт головы прокси шлёт в express за второй запрос (на «express», который только пишет байты).
    captured = Buffer.alloc(0);
    void raw(capProxyPort, req2);
    await vi.waitFor(() => { if (!captured.includes('\r\n\r\n')) throw new Error('голова ещё не пришла'); }, { timeout: 10_000, interval: 10 });
    const headLen = captured.toString('latin1').indexOf('\r\n\r\n') + 4;
    const from = seen.length;
    // Первый: GET с телом ровно такой длины (uWS своё соединение с клиентом держит ровно — тело он читает).
    const r1 = await raw(proxyPort, `GET /api/config HTTP/1.1\r\nHost: x\r\n${REMOTE}Content-Length: ${headLen}\r\n\r\n${'z'.repeat(headLen)}`);
    // Второй — с другого соединения, как чужой игрок.
    const r2 = await raw(proxyPort, req2);
    expect(r2.status, `второй получил ответ: ${JSON.stringify(r2.text.slice(0, 80))}`).toBeDefined();
    await vi.waitFor(() => { if (!seen.slice(from).some((s) => s.method === 'POST')) throw new Error('express ещё не видел второго'); }, { timeout: 10_000, interval: 10 });
    const got = seen.slice(from);
    expect(got.map((s) => `${s.method} ${s.url}`), `ответ первому: ${JSON.stringify(r1.text.slice(0, 60))}`).not.toContain('POST /internal/drain');
    expect(got.filter((s) => s.local), 'ничего «с самой машины» от чужих клиентов').toEqual([]);
    expect(got.map((s) => `${s.method} ${s.url}`)).toContain('POST /api/logout');
    const logout = got.find((s) => s.url === '/api/logout')!;
    expect(logout.body, 'тело второго дошло целиком').toBe(smuggled);
  }, 30_000);

  it('GET (HEAD, OPTIONS) с заявленным телом — 400 от самого прокси, до express не доходит', async () => {
    const from = seen.length;
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      const r = await raw(proxyPort, `${m} /api/config HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nzzzzz`);
      expect(r.status, m).toBe(400);
    }
    const chunked = await raw(proxyPort, 'GET /api/config HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nzzzzz\r\n0\r\n\r\n');
    expect(chunked.status).toBe(400);
    expect(seen.slice(from), 'express их не видел').toEqual([]);
  }, 30_000);

  it('express не получает от клиента ни длины, ни кодирования, ни заголовков соединения: длина — ровно пересланное тело', async () => {
    const from = seen.length;
    const r = await raw(proxyPort, `POST /api/login HTTP/1.1\r\nHost: x\r\n${REMOTE}Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive, x-forwarded-for\r\nKeep-Alive: timeout=99\r\nTE: trailers\r\nExpect: 100-continue\r\n\r\n7\r\n{"a":1}\r\n0\r\n\r\n`);
    expect(r.status).toBe(200);
    const got = seen.slice(from);
    expect(got).toHaveLength(1);
    expect(got[0]!.body).toBe('{"a":1}');
    expect(got[0]!.headers['content-length']).toBe('7');
    expect(got[0]!.headers['transfer-encoding']).toBeUndefined();
    expect(got[0]!.headers['keep-alive']).toBeUndefined();
    expect(got[0]!.headers['te']).toBeUndefined();
    expect(got[0]!.headers['expect']).toBeUndefined();
    expect(got[0]!.headers['x-forwarded-for'], 'адрес — от прокси, «Connection: x-forwarded-for» его не снимает').toBe('203.0.113.7');
    // GET — без длины и кодирования вовсе.
    const g0 = seen.length;
    expect((await raw(proxyPort, `GET /api/config HTTP/1.1\r\nHost: x\r\n${REMOTE}Content-Length: 0\r\n\r\n`)).status).toBe(200);
    const g = seen.slice(g0);
    expect(g).toHaveLength(1);
    expect(g[0]!.headers['content-length']).toBeUndefined();
    expect(g[0]!.headers['transfer-encoding']).toBeUndefined();
  }, 30_000);

  it('контроль: честный клиент — три запроса подряд по одному соединению, все дошли и получили ответ', async () => {
    const from = seen.length;
    const c = await dial(proxyPort);
    try {
      expect((await c.ask(`GET /a HTTP/1.1\r\nHost: x\r\n${REMOTE}\r\n`)).status).toBe(200);
      expect((await c.ask(`POST /b HTTP/1.1\r\nHost: x\r\n${REMOTE}Content-Length: 3\r\n\r\nabc`)).status).toBe(200);
      expect((await c.ask(`GET /c HTTP/1.1\r\nHost: x\r\n${REMOTE}\r\n`)).status).toBe(200);
    } finally { c.close(); }
    expect(seen.slice(from).map((s) => `${s.method} ${s.url} ${s.body}`)).toEqual(['GET /a ', 'POST /b abc', 'GET /c ']);
  }, 30_000);
});

describe.runIf(!!uWS)('⭐ R12-01: вторая линия — соединение прокси без его доказательства не «с самой машины»', () => {
  it('прямой вызов с машины через прокси — локальный; чужой с поддельным доказательством — нет', async () => {
    const { LOCAL_PROOF_HEADER } = await import('./adminAccess.js');
    const from = seen.length;
    // R14-11: свой вызов называет в `Host` петлю, куда и звонит (curl, стенд): чужое имя там — подмена DNS.
    expect((await raw(proxyPort, 'GET /metrics HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')).status).toBe(200);
    expect((await raw(proxyPort, `GET /metrics HTTP/1.1\r\nHost: x\r\n${REMOTE}${LOCAL_PROOF_HEADER}: ${'0'.repeat(64)}\r\n\r\n`)).status).toBe(200);
    const [mine, forged] = seen.slice(from);
    expect(mine!.local, 'стенд, мониторинг — через игровой порт').toBe(true);
    expect(forged!.local).toBe(false);
    expect(forged!.headers[LOCAL_PROOF_HEADER], 'заголовок клиента снят').toBeUndefined();
    // Без прокси — прямо на петлю express: как было (R3-03).
    const d0 = seen.length;
    expect((await raw(upstreamPort, 'GET /metrics HTTP/1.1\r\nHost: localhost\r\n\r\n')).status).toBe(200);
    expect(seen[d0]!.local, 'прямо на петлю express — с самой машины').toBe(true);
  }, 30_000);

  it('запрос на соединении прокси без доказательства (любые заголовки, кроме него) — не локальный; соединение закрыто — правило прежнее', async () => {
    const { localCaller, proxyLinks, LOCAL_PROOF_HEADER } = await import('./adminAccess.js');
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    expect(localCaller({}, '127.0.0.1', port), 'не соединение прокси').toBe(true);
    proxyLinks.open(port);
    proxyLinks.open(port);   // тот же порт взяло новое соединение, пока закрытие старого ещё в пути
    try {
      expect(localCaller({}, '127.0.0.1', port)).toBe(false);
      expect(localCaller({ [LOCAL_PROOF_HEADER]: 'x'.repeat(64) }, '127.0.0.1', port)).toBe(false);
      expect(localCaller({ [LOCAL_PROOF_HEADER]: proxyLinks.proof() }, '127.0.0.1', port)).toBe(true);
      expect(localCaller({ [LOCAL_PROOF_HEADER]: proxyLinks.proof(), 'x-forwarded-for': '1.2.3.4' }, '127.0.0.1', port)).toBe(false);
      proxyLinks.close(port);
      expect(localCaller({}, '127.0.0.1', port), 'закрытие старого не снимает новое').toBe(false);
    } finally { proxyLinks.close(port); }
    expect(localCaller({}, '127.0.0.1', port)).toBe(true);
  });
});
