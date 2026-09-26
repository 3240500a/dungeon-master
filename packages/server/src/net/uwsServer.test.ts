import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import WebSocket from 'ws';
import type { GameConn } from './conn.js';

/**
 * ⭐ R4-29: АДРЕС ИГРОКА НА СОКЕТЕ uWS. За Caddy (DEPLOY §3a/§4) собеседник каждого игрового сокета — сам прокси на петле,
 * и `open` брал только его: у всех игроков в `play_sessions.ip` стояло 127.0.0.1, а сигнал аномалий «рой с одного адреса»
 * срабатывал на каждого, кто играл одновременно с тремя другими. HTTP это правило (R3-03) уже держал — теперь и апгрейд:
 * адрес читается из заголовков в `upgrade` (другого места у uWS нет) тем же `clientIp`, что и у HTTP.
 *
 * Здесь настоящий uWS с поведением игрового сокета (`gameWsBehavior`), клиент — настоящий `ws` по сети.
 */
vi.mock('../db/db.js', () => ({}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(null),
}));

interface UwsLike {
  App(): { ws(p: string, b: Record<string, unknown>): { listen(host: string, port: number, cb: (t: unknown) => void): void } };
  us_socket_local_port(t: unknown): number;
  us_listen_socket_close(t: unknown): void;
}
let uWS: UwsLike | null = null;
try { uWS = createRequire(import.meta.url)('uWebSockets.js') as UwsLike; } catch { /* пакет не собран под платформу */ }
const LAN = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

const conns: GameConn[] = [];
let port = 0;
let token: unknown = null;

beforeAll(async () => {
  if (!uWS) return;
  const { gameWsBehavior } = await import('./uwsServer.js');
  const u = uWS;
  await new Promise<void>((resolve, reject) => {
    u.App().ws('/ws', gameWsBehavior(u as never, (c) => { conns.push(c); })).listen('0.0.0.0', 0, (t) => {
      if (!t) { reject(new Error('uWS не занял порт')); return; }
      token = t; port = u.us_socket_local_port(t); resolve();
    });
  });
});
afterAll(() => { if (uWS && token) uWS.us_listen_socket_close(token); });

/** Открыть игровой сокет и вернуть, с каким адресом его увидела игра. */
async function ipOf(o: { to: string; headers?: Record<string, string>; from?: string }): Promise<string> {
  const before = conns.length;
  const ws = new WebSocket(`ws://${o.to}:${port}/ws`, { headers: o.headers, localAddress: o.from });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  for (let i = 0; i < 50 && conns.length === before; i++) await new Promise((r) => setTimeout(r, 5));
  ws.close();
  return conns[conns.length - 1]!.ip;
}

describe.runIf(!!uWS)('адрес игрока на сокете uWS (R4-29)', () => {
  it('⭐ за обратным прокси на той же машине — адрес игрока из X-Forwarded-For, а не петля прокси', async () => {
    expect(await ipOf({ to: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('203.0.113.7');
    expect(await ipOf({ to: '127.0.0.1', headers: { 'x-forwarded-for': '10.0.0.5, 198.51.100.4' } }), 'правый адрес цепочки — его дописал прокси').toBe('198.51.100.4');
  });

  it('⭐ заголовок от НЕ прокси (чужой собеседник) не читается — адрес собеседника', async () => {
    if (!LAN) return;
    expect(await ipOf({ to: LAN, from: LAN, headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe(LAN);
  });

  it('прямо с машины без заголовков — петля', async () => {
    expect(await ipOf({ to: '127.0.0.1' })).toBe('127.0.0.1');
  });
});

describe.runIf(!!uWS)('⭐ R4-13: путь игрового сокета uWS за прокси по путям (DEPLOY §3a, вариант А)', () => {
  let routedPort = 0;
  let routedToken: unknown = null;
  beforeAll(async () => {
    const { gameWsBehavior, mountGameWs } = await import('./uwsServer.js');
    const u = uWS!;
    await new Promise<void>((resolve, reject) => {
      (mountGameWs(u.App() as never, gameWsBehavior(u as never, (c) => { conns.push(c); })) as unknown as { listen(h: string, p: number, cb: (t: unknown) => void): void })
        .listen('0.0.0.0', 0, (t) => {
          if (!t) { reject(new Error('uWS не занял порт')); return; }
          routedToken = t; routedPort = u.us_socket_local_port(t); resolve();
        });
    });
  });
  afterAll(() => { if (uWS && routedToken) uWS.us_listen_socket_close(routedToken); });

  /** Открылся ли игровой сокет на пути `path`. */
  function opens(path: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${routedPort}${path}`);
      ws.once('open', () => { ws.close(); resolve(true); });
      ws.once('unexpected-response', () => resolve(false));
      ws.once('error', () => resolve(false));
    });
  }

  it('⭐ /ws и /ws/<i> — игровой сокет (было: /ws/0 → 404, кластер по документации был недоступен)', async () => {
    expect(await opens('/ws')).toBe(true);
    expect(await opens('/ws/0')).toBe(true);
    expect(await opens('/ws/7?x=1')).toBe(true);
  });

  it('прочие пути под /ws/ игрового сокета не получают', async () => {
    for (const p of ['/ws/abc', '/ws/0/1']) expect(await opens(p), p).toBe(false);
  });
});

/**
 * ⭐ R5-01: ПРОКСИ HTTP НЕ БРОСАЕТ НИКОГДА. Разборщик uWS пропускает то, от чего `http.request` бросает синхронно: управляющий
 * байт в значении заголовка (в том числе `Host` и `User-Agent`), не-ASCII в пути, метод не из знаков токена. Бросок шёл из
 * нативного колбэка uWS — это необработанное исключение и выход процесса со всеми комнатами ноды от ОДНОГО анонимного
 * запроса (и так после каждого рестарта). Здесь настоящий uWS с `proxyToExpress` перед простым http-сервером, запросы —
 * сырыми байтами по TCP.
 */
describe.runIf(!!uWS)('⭐ R5-01: кривой HTTP-запрос не роняет процесс', () => {
  let proxyPort = 0;
  let proxyToken: unknown = null;
  let upstream: import('node:http').Server | null = null;
  beforeAll(async () => {
    const { proxyToExpress } = await import('./uwsServer.js');
    const { createServer } = await import('node:http');
    const up = createServer((_req, res) => { res.end('ok'); });
    upstream = up;
    await new Promise<void>((resolve) => up.listen(0, '127.0.0.1', () => resolve()));
    const httpPort = (up.address() as { port: number }).port;
    const u = uWS as unknown as { App(): { any(p: string, h: (res: unknown, req: unknown) => void): { listen(h: string, p: number, cb: (t: unknown) => void): void } } } & UwsLike;
    await new Promise<void>((resolve, reject) => {
      u.App().any('/*', (res, req) => proxyToExpress(res as never, req as never, httpPort)).listen('127.0.0.1', 0, (t) => {
        if (!t) { reject(new Error('uWS не занял порт')); return; }
        proxyToken = t; proxyPort = u.us_socket_local_port(t); resolve();
      });
    });
  });
  afterAll(() => { if (uWS && proxyToken) uWS.us_listen_socket_close(proxyToken); upstream?.close(); });

  /** Сырые байты по TCP → первая строка ответа (или пусто: соединение закрыто без ответа). */
  async function raw(bytes: Buffer): Promise<string> {
    const { connect } = await import('node:net');
    return new Promise((resolve) => {
      let out = '';
      const s = connect(proxyPort, '127.0.0.1', () => s.write(bytes));
      const done = (): void => { clearTimeout(timer); s.destroy(); resolve(out.split('\r\n')[0] ?? ''); };
      const timer = setTimeout(done, 1500);
      s.on('data', (d: Buffer) => { out += d.toString('latin1'); if (out.includes('\r\n\r\n')) done(); });
      s.on('close', done);
      s.on('error', done);
    });
  }
  const b = (...parts: (string | number[])[]): Buffer =>
    Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

  it('⭐ управляющие и не-ASCII байты в заголовках и пути, метод не-токен — ответ 4xx, процесс жив, следом обычный GET — 200', async () => {
    const crashes: unknown[] = [];
    const onCrash = (e: unknown): void => { crashes.push(e); };
    process.on('uncaughtException', onCrash);
    try {
      const cases: [string, Buffer][] = [
        ['DEL в значении заголовка', b('GET / HTTP/1.1\r\nHost: x\r\nX-T: a', [0x7f], 'b\r\n\r\n')],
        ['DEL в Host', b('GET / HTTP/1.1\r\nHost: x', [0x7f], '\r\n\r\n')],
        ['DEL в User-Agent у POST входа', b('POST /api/login HTTP/1.1\r\nHost: x\r\nUser-Agent: a', [0x7f], '\r\nContent-Length: 2\r\n\r\n{}')],
        ['байт 0x80 в заголовке', b('GET / HTTP/1.1\r\nHost: x\r\nX-T: a', [0x80], 'b\r\n\r\n')],
        ['байт 0xFF в пути', b('GET /a', [0xff], ' HTTP/1.1\r\nHost: x\r\n\r\n')],
        ['метод не из знаков токена', b('G(T / HTTP/1.1\r\nHost: x\r\n\r\n')],
      ];
      for (const [name, bytes] of cases) {
        const line = await raw(bytes);
        expect(crashes, `${name}: процесс не получил необработанного исключения`).toEqual([]);
        expect(line, `${name}: ответ — отказ 4xx`).toMatch(/^HTTP\/1\.1 4\d\d/);
      }
      const ok = await raw(b('GET /health HTTP/1.1\r\nHost: x\r\n\r\n'));
      expect(ok, 'прокси жив и дальше отвечает').toMatch(/^HTTP\/1\.1 200/);
    } finally { process.removeListener('uncaughtException', onCrash); }
  });
});

describe('⭐ R5-01: последний рубеж — необработанное исключение начинает обычный слив, а не обрывает процесс', () => {
  it('исключение → лог и слив ОДИН раз (повторы — только в лог); процесс не выходит сам', async () => {
    const { installCrashDrain } = await import('./internalRoutes.js');
    const before = process.listeners('uncaughtException');
    const drain = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installCrashDrain(drain);
    const mine = process.listeners('uncaughtException').filter((l) => !before.includes(l));
    try {
      expect(mine.length, 'обработчик поставлен').toBe(1);
      for (const l of mine) (l as (e: Error, origin: string) => void)(new Error('бросок из колбэка'), 'uncaughtException');
      for (const l of mine) (l as (e: Error, origin: string) => void)(new Error('второй'), 'unhandledRejection');
      expect(drain, 'слив начат один раз').toHaveBeenCalledTimes(1);
      expect(exit, 'выход — дело слива, а не обработчика').not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledTimes(2);
    } finally {
      for (const l of mine) process.removeListener('uncaughtException', l as never);
      err.mockRestore(); exit.mockRestore();
    }
  });
});
