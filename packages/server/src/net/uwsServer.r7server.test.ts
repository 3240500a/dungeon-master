import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { createHash } from 'node:crypto';

/**
 * ⭐ R7-10: ПРОКСИ uWS → express НЕ КОПИТ ОТВЕТ ЦЕЛИКОМ. Раньше ответ express собирался в памяти до последнего байта
 * (`Buffer.concat`) и только потом уходил клиенту: аноним, запросивший 13 МБ GLB из `/assets` (или конфиг, ~0,5 МБ) и не
 * читающий ответ, держал на ноде весь файл — поток таких запросов раздувал память ноды на «размер × число запросов» и стоял
 * циклом событий. Теперь ответ течёт с обратным давлением: клиент не читает — прокси не читает у express.
 *
 * Здесь настоящий uWS (`proxyToExpress`) перед настоящим `node:http`, который пишет ответ с учётом обратного давления и
 * считает, сколько у него забрали. Клиенты — сырой TCP, который не читает.
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

const BIG = 32 * 1024 * 1024;
const PIECE = Buffer.alloc(64 * 1024, 7);
/** Сколько байт ответа express отдал (сокет взял) — по каждому запросу. */
const written: number[] = [];
/** Ответы express: закрыт ли и завершён ли целиком к закрытию. */
const closed: { closed: boolean; finished: boolean }[] = [];
let upstream: Server;
let proxyPort = 0;
let token: unknown = null;

/** Тело ответа: `size` байт кусками по 64 КБ, с обратным давлением (сокет полон — ждём `drain`). */
function pump(res: ServerResponse, size: number, slot: number): void {
  let left = size;
  const go = (): void => {
    while (left > 0) {
      const n = Math.min(left, PIECE.length);
      left -= n;
      const ok = res.write(n === PIECE.length ? PIECE : PIECE.subarray(0, n));
      written[slot] = size - left;
      if (!ok) { res.once('drain', go); return; }
    }
    res.end();
  };
  go();
}
const expected = (size: number): string => {
  const h = createHash('sha256');
  for (let left = size; left > 0; left -= PIECE.length) h.update(left >= PIECE.length ? PIECE : PIECE.subarray(0, left));
  return h.digest('hex');
};

beforeAll(async () => {
  if (!uWS) return;
  upstream = createServer((req, res) => {
    const slot = written.push(0) - 1;
    const rec = { closed: false, finished: false };
    closed.push(rec);
    res.on('close', () => { rec.closed = true; rec.finished = res.writableFinished; });
    const size = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('size') ?? BIG);
    if (req.url?.startsWith('/small')) { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
    if (req.url?.startsWith('/broken')) {   // обещал мегабайт, отдал 100 КБ и порвал соединение
      res.setHeader('content-length', String(1024 * 1024));
      res.write(Buffer.alloc(100 * 1024, 1), () => { res.socket?.destroy(); });
      return;
    }
    if (req.url?.startsWith('/chunked')) { res.setHeader('content-type', 'application/octet-stream'); pump(res, size, slot); return; }
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(size));
    if (req.method === 'HEAD') { res.end(); return; }
    pump(res, size, slot);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const httpPort = (upstream.address() as AddressInfo).port;
  const { proxyToExpress } = await import('./uwsServer.js');
  const u = uWS;
  await new Promise<void>((resolve, reject) => {
    u.App().any('/*', (res, req) => proxyToExpress(res as never, req as never, httpPort)).listen('127.0.0.1', 0, (t) => {
      if (!t) { reject(new Error('uWS не занял порт')); return; }
      token = t; proxyPort = u.us_socket_local_port(t); resolve();
    });
  });
});
afterAll(() => {
  if (uWS && token) uWS.us_listen_socket_close(token);
  upstream?.close();
});

/** Сырой клиент: запрос — и дальше он не читает. */
async function stalled(path: string): Promise<net.Socket> {
  const s = net.connect(proxyPort, '127.0.0.1');
  await new Promise<void>((resolve) => s.once('connect', () => resolve()));
  s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
  s.pause();
  return s;
}
/** Дождаться, пока express перестанет отдавать байты (или отдаст всё). */
async function quiet(slots: number[], cap: number): Promise<number> {
  const sum = (): number => slots.reduce((a, i) => a + (written[i] ?? 0), 0);
  let last = -1, still = 0;
  for (let i = 0; i < 300 && still < 6; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const now = sum();
    if (now >= cap) return now;
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return sum();
}

describe.runIf(!!uWS)('⭐ R7-10: ответ express через прокси uWS течёт с обратным давлением', () => {
  for (const kind of ['big', 'chunked'] as const) {
    it(`три клиента не читают ${kind === 'big' ? 'файл с длиной' : 'ответ без длины'} (32 МБ) — прокси не забирает у express и половины`, async () => {
      const from = written.length;
      const socks = [await stalled(`/${kind}`), await stalled(`/${kind}`), await stalled(`/${kind}`)];
      try {
        for (let i = 0; i < 100 && written.length < from + 3; i++) await new Promise((r) => setTimeout(r, 10));
        const slots = [from, from + 1, from + 2];
        const took = await quiet(slots, 3 * BIG);
        expect(took, `забрано у express: ${(took / 1048576).toFixed(1)} МБ из ${3 * BIG / 1048576}`).toBeLessThan((3 * BIG) / 2);
      } finally {
        for (const s of socks) s.destroy();
      }
    }, 30_000);
  }

  it('клиент бросил загрузку — прокси бросает ответ express, а не дочитывает его', async () => {
    const from = closed.length;
    const s = await stalled('/big');
    for (let i = 0; i < 100 && closed.length === from; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    s.destroy();
    // uWS замечает обрыв клиента сразу — ответ express закрыт незавершённым, а не дописан до конца в память прокси
    // (и не висит на паузе вечно).
    await vi.waitFor(() => { if (!closed[from]!.closed) throw new Error('ответ express ещё открыт'); }, { timeout: 5_000, interval: 20 });
    expect(closed[from]!.finished, 'оборван, а не дописан').toBe(false);
    expect(written[from]!, 'express отдал не всё').toBeLessThan(BIG);
  }, 15_000);

  /** Честный клиент: весь ответ, как есть. */
  function fetchRaw(path: string, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; sha: string; len: number }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: proxyPort, path, method }, (res) => {
        const h = createHash('sha256');
        let len = 0;
        res.on('data', (d: Buffer) => { h.update(d); len += d.length; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, sha: h.digest('hex'), len }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('контроль: express порвал ответ посреди тела — клиенту обрыв, а не вечное ожидание и не «успех» с дырой', async () => {
    const r = await new Promise<{ status: number; len: number; ok: boolean }>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port: proxyPort, path: '/broken' }, (res) => {
        let len = 0;
        res.on('data', (d: Buffer) => { len += d.length; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, len, ok: res.complete }));
        res.on('error', () => resolve({ status: res.statusCode ?? 0, len, ok: false }));
        res.on('close', () => resolve({ status: res.statusCode ?? 0, len, ok: res.complete }));
      });
      req.on('error', () => resolve({ status: 0, len: 0, ok: false }));
      req.end();
    });
    expect(r.ok, 'ответ не считается целым').toBe(false);
    expect(r.len).toBeLessThan(1024 * 1024);
  }, 15_000);

  it('контроль: читающий клиент получает ответ целиком — с длиной и без, маленький JSON и HEAD', async () => {
    const size = 5 * 1024 * 1024 + 123;
    const big = await fetchRaw(`/big?size=${size}`);
    expect(big.status).toBe(200);
    expect(big.len).toBe(size);
    expect(big.sha).toBe(expected(size));
    expect(big.headers['content-length'], 'длина ответа сохранена').toBe(String(size));
    expect(big.headers['content-type']).toBe('application/octet-stream');
    const chunked = await fetchRaw(`/chunked?size=${size}`);
    expect(chunked.len).toBe(size);
    expect(chunked.sha).toBe(expected(size));
    const small = await fetchRaw('/small');
    expect(small.status).toBe(200);
    expect(small.len).toBe(11);
    const head = await fetchRaw(`/big?size=${size}`, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.len).toBe(0);
    const empty = await fetchRaw('/big?size=0');
    expect(empty.status).toBe(200);
    expect(empty.len).toBe(0);
  }, 30_000);
});
