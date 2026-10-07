import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { request } from 'node:http';
import { blobStore, sha256, type BlobStore } from '../content/blobStore.js';
import type { ChannelPointer } from '../content/releaseDb.js';
import { installReleaseRoutes, POINTER_CACHE_MS } from './releaseRoutes.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ 08.10 (Д1): РУЧКИ РЕЛИЗОВ — настоящие (`installReleaseRoutes`) за настоящим express; указатель — шпион, хранилище — временная папка,
 * часы кэша указателя — у теста.
 */
let server: Server;
let base = '';
let root = '';
let store: BlobStore;
let t = 0;
let pointers: Record<string, ChannelPointer | null> = {};
let pointerCalls = 0;
let cuts = 0;
let allowDev = true;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dm-rel-'));
  store = blobStore(root);
  const app = express();
  installReleaseRoutes(app, {
    store, abi: 1, cdn: ['/c/'], now: () => t,
    pointer: async (channel) => { pointerCalls++; return pointers[channel] ?? null; },
    dev: {
      guard: async (_req, res) => { if (!allowDev) { res.status(403).json({ error: 'нет' }); return false; } return true; },
      cutNow: async () => { cuts++; return { seq: 7, fresh: true, manifest: 'm', files: 1, newFiles: 1, bytes: 1, newBytes: 1 }; },
    },
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

/** Сырой GET без автоматической распаковки (fetch распаковал бы gzip сам и спрятал заголовок). */
function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const P = (seq: number, channel = 'dev'): ChannelPointer => ({ channel, seq, manifest: 'ab'.repeat(32), manifestSize: 321, minClient: 0, latestClient: 0 });

describe('⭐ Д1: указатель версии контента', () => {
  it('отдаёт номер и хэш манифеста, без кэша, с ETag; тот же ETag — 304', async () => {
    t += 10_000; pointers = { dev: P(5) };
    const r = await raw('/api/content/pointer?channel=dev&abi=1');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-cache');
    const j = JSON.parse(r.body.toString()) as Record<string, unknown>;
    expect(j).toMatchObject({ seq: 5, manifest: 'ab'.repeat(32), manifestSize: 321, abi: 1, cdn: ['/c/'], channel: 'dev' });
    const again = await raw('/api/content/pointer?channel=dev&abi=1', { 'if-none-match': String(r.headers.etag) });
    expect(again.status).toBe(304);
  });

  it('канала нет — указатель dev; чужая ABI — 409 с ABI сервера; релиза нет — 503; кривой канал — 400', async () => {
    t += 10_000; pointers = { dev: P(9) };
    const live = JSON.parse((await raw('/api/content/pointer?channel=live&abi=1')).body.toString()) as { seq: number; channel: string };
    expect(live).toMatchObject({ seq: 9, channel: 'dev' });
    const abi = await raw('/api/content/pointer?abi=2');
    expect(abi.status).toBe(409);
    expect(JSON.parse(abi.body.toString())).toEqual({ error: 'abi', abi: 1 });
    t += 10_000; pointers = {};
    const none = await raw('/api/content/pointer');
    expect(none.status).toBe(503);
    expect(none.headers['retry-after']).toBe('2');
    expect((await raw('/api/content/pointer?channel=../x')).status).toBe(400);
  });

  it('указатель — из памяти на секунду: сотня запусков не ходит в базу сотню раз', async () => {
    t += 10_000; pointers = { dev: P(11) };
    const before = pointerCalls;
    for (let i = 0; i < 5; i++) await raw('/api/content/pointer');
    expect(pointerCalls - before).toBe(1);
    t += POINTER_CACHE_MS;
    pointers = { dev: P(12) };
    expect(JSON.parse((await raw('/api/content/pointer')).body.toString())).toMatchObject({ seq: 12 });
  });
});

describe('⭐ Д1: файлы по хэшу', () => {
  it('отдаёт файл навсегда (`immutable`), понимающему gzip — сжатым; содержимое сходится с хэшем', async () => {
    const bytes = Buffer.from(JSON.stringify({ clip: Array.from({ length: 300 }, (_, i) => i) }));
    const { sha } = store.put(bytes);
    const path = `/c/b/${sha.slice(0, 2)}/${sha}`;
    const plain = await raw(path);
    expect(plain.status).toBe(200);
    expect(plain.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(sha256(plain.body)).toBe(sha);
    const gz = await raw(path, { 'accept-encoding': 'gzip, deflate' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.body.length).toBeLessThan(bytes.length);
    expect(sha256(gunzipSync(gz.body))).toBe(sha);
    expect((await raw(path, { 'if-none-match': `"${sha}"` })).status).toBe(304);
  });

  it('кривой адрес — 400, неизвестный хэш — 404', async () => {
    const sha = sha256('нет такого');
    expect((await raw(`/c/b/zz/${sha}`)).status).toBe(400);
    expect((await raw('/c/b/ab/not-a-sha')).status).toBe(400);
    expect((await raw(`/c/b/${sha.slice(0, 2)}/${sha}`)).status).toBe(404);
  });
});

describe('⭐ Д1: нарезка по ручке разработчика', () => {
  it('под охраной: закрыто — нарезки нет', async () => {
    allowDev = false;
    const no = await fetch(base + '/api/dev/content/release', { method: 'POST' });
    expect(no.status).toBe(403);
    expect(cuts).toBe(0);
    allowDev = true;
    const ok = await fetch(base + '/api/dev/content/release', { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ seq: 7, fresh: true });
    expect(cuts).toBe(1);
  });
});
