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
import type { ChannelChange, ChannelPointer, ClientsInput, PromoteInput, RollbackInput } from '../content/releaseDb.js';
import { loadContentSigner, verifyContentSig, type ContentSigner } from '../content/contentSign.js';
import { ChannelOpError, rolloutBucket } from '../content/channelRules.js';
import { buildRelease } from '../content/releaseManifest.js';
import { installReleaseRoutes, POINTER_CACHE_MS, type ReleaseAdminDeps } from './releaseRoutes.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ 08.10 (Д1): РУЧКИ РЕЛИЗОВ — настоящие (`installReleaseRoutes`) за настоящим express; указатель — шпион, хранилище — временная папка,
 * часы кэша указателя — у теста.
 * ⭐ 08.10 (Д3): корзины раскатки, подпись (проверяется открытым ключом из `/api/content/pubkey`), версия клиента, запасной путь к `dev`
 * (вне продакшена — да, на проде — 404), ручки администратора (охрана, разбор тела, отказы правилом). Сами операции с каналами — шпионы;
 * их правила против настоящей базы — `content/releaseDb.test.ts`.
 */
let server: Server;
let prodServer: Server;
let base = '';
let prodBase = '';
let root = '';
let store: BlobStore;
let signer: ContentSigner;
let t = 0;
let pointers: Record<string, ChannelPointer | null> = {};
let pointerCalls = 0;
let cuts = 0;
let allowDev = true;
let allowAdmin = true;
const adminCalls: Array<{ op: string; arg: unknown }> = [];
const adminLog: string[] = [];
let adminFail: ChannelOpError | null = null;

const CH: ChannelChange = { channel: 'live', abi: 1, seq: 12, rollout: 10, prev: 10, minClient: 0, latestClient: 0, reissued: false, origin: 12, changed: true, was: { seq: 10, rollout: 100, prev: 9 } };
const admin: ReleaseAdminDeps = {
  guard: async (_req, res) => { if (!allowAdmin) { res.status(403).json({ error: 'Нужны права администратора' }); return null; } return 'tester'; },
  list: async (o) => { adminCalls.push({ op: 'list', arg: o }); return { releases: [], channels: [] }; },
  promote: async (i: PromoteInput) => {
    adminCalls.push({ op: 'promote', arg: i });
    if (adminFail) throw adminFail;
    return { ...CH, seq: i.seq, rollout: i.percent ?? 100 };
  },
  rollback: async (i: RollbackInput) => { adminCalls.push({ op: 'rollback', arg: i }); return { ...CH, reissued: true, origin: 10, seq: 13, rollout: 100, prev: null }; },
  clients: async (i: ClientsInput) => { adminCalls.push({ op: 'clients', arg: i }); return { ...CH, minClient: i.minClient ?? 0, latestClient: i.latestClient ?? 0 }; },
  gc: async (o) => { adminCalls.push({ op: 'gc', arg: o }); return { dryRun: o.dryRun, kept: 3, scanned: 5, young: 1, removed: 1, bytes: 10, parts: 0, sample: ['x'] }; },
  log: (m) => adminLog.push(m),
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dm-rel-'));
  store = blobStore(root);
  signer = loadContentSigner({ devKeyPath: join(root, 'dev-sign.key'), log: () => undefined, warn: () => undefined })!;
  const mk = (devFallback: boolean): express.Express => {
    const app = express();
    installReleaseRoutes(app, {
      store, abi: 1, cdn: ['/c/'], now: () => t, signer, devFallback,
      pointer: async (channel) => { pointerCalls++; return pointers[channel] ?? null; },
      dev: {
        guard: async (_req, res) => { if (!allowDev) { res.status(403).json({ error: 'нет' }); return false; } return true; },
        cutNow: async () => { cuts++; return { seq: 7, fresh: true, manifest: 'm', files: 1, newFiles: 1, bytes: 1, newBytes: 1 }; },
      },
      admin,
    });
    return app;
  };
  const listen = (app: express.Express): Promise<Server> => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server = await listen(mk(true));
  prodServer = await listen(mk(false));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  prodBase = `http://127.0.0.1:${(prodServer.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); prodServer.close(); rmSync(root, { recursive: true, force: true }); });

/** Сырой GET без автоматической распаковки (fetch распаковал бы gzip сам и спрятал заголовок). */
function raw(path: string, headers: Record<string, string> = {}, at = base): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(at + path, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const getJson = async (path: string, at = base): Promise<Record<string, unknown>> => JSON.parse((await raw(path, {}, at)).body.toString()) as Record<string, unknown>;

const P = (seq: number, channel = 'dev', extra: Partial<ChannelPointer> = {}): ChannelPointer =>
  ({ channel, seq, manifest: 'ab'.repeat(32), manifestSize: 321, minClient: 0, latestClient: 0, rollout: 100, prev: null, ...extra });

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

  it('канала нет — указатель dev (вне продакшена); чужая ABI — 409 с ABI сервера; релиза нет — 503; кривой канал — 400', async () => {
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

describe('⭐ Д3: каналы, раскатка, версия клиента', () => {
  const NEW = 'cd'.repeat(32), OLD = 'ab'.repeat(32);
  const live = (rollout: number): ChannelPointer => P(12, 'live', { manifest: NEW, manifestSize: 500, rollout, prev: { seq: 10, manifest: OLD, manifestSize: 400 } });

  it('на проде канал без указателя — 404 «канал не выпущен», dev не подсовывается; сам dev — как был', async () => {
    t += 10_000; pointers = { dev: P(9) };
    const r = await raw('/api/content/pointer?channel=live', {}, prodBase);
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body.toString())).toEqual({ error: 'канал не выпущен', channel: 'live' });
    expect(await getJson('/api/content/pointer?channel=dev', prodBase)).toMatchObject({ seq: 9, channel: 'dev' });
  });

  it('корзины: в проценте — новый, вне — прежний; доля — около процента; без id — прежний, пока не 100%', async () => {
    t += 10_000; pointers = { live: live(30) };
    let fresh = 0;
    for (let i = 0; i < 60; i++) {
      const id = `dev-${i}`;
      const j = await getJson(`/api/content/pointer?channel=live&id=${id}`);
      const want = rolloutBucket(id, 'live', 12) < 30;
      expect(j).toMatchObject(want ? { seq: 12, manifest: NEW, manifestSize: 500 } : { seq: 10, manifest: OLD, manifestSize: 400 });
      expect(j.rollout).toBe(30);
      if (want) fresh++;
    }
    expect(fresh).toBeGreaterThan(5);
    expect(fresh).toBeLessThan(35);
    expect(await getJson('/api/content/pointer?channel=live')).toMatchObject({ seq: 10 });
  });

  it('0% — всем прежний; 100% — всем новый, и без id', async () => {
    t += 10_000; pointers = { live: live(0) };
    for (let i = 0; i < 20; i++) expect(await getJson(`/api/content/pointer?channel=live&id=u${i}`)).toMatchObject({ seq: 10 });
    t += 10_000; pointers = { live: live(100) };
    expect(await getJson('/api/content/pointer?channel=live')).toMatchObject({ seq: 12 });
    expect(await getJson('/api/content/pointer?channel=live&id=u1')).toMatchObject({ seq: 12 });
  });

  it('подпись — по строке контракта того релиза, что отдан; сходится с открытым ключом из /api/content/pubkey', async () => {
    const pk = await getJson('/api/content/pubkey');
    expect(pk).toMatchObject({ alg: 'ed25519', keyId: signer.keyId, publicKey: signer.publicKey, dev: true, format: 'dmcontent:v1|<abi>|<seq>|<manifest>|<channel>' });
    expect(String(pk.pem)).toContain('BEGIN PUBLIC KEY');
    t += 10_000; pointers = { live: live(50) };
    for (const id of ['a1', 'b2', 'c3', 'd4', undefined]) {
      const j = await getJson(`/api/content/pointer?channel=live${id ? `&id=${id}` : ''}`) as { seq: number; manifest: string; channel: string; abi: number; sig: string; keyId: string; sigAlg: string };
      expect(j.sigAlg).toBe('ed25519');
      expect(j.keyId).toBe(signer.keyId);
      expect(verifyContentSig(String(pk.publicKey), j.abi, j.seq, j.manifest, j.channel, j.sig)).toBe(true);
      // подменённый номер (старый релиз), манифест (CDN) или канал — не сходится
      expect(verifyContentSig(String(pk.publicKey), j.abi, j.seq - 1, j.manifest, j.channel, j.sig)).toBe(false);
      expect(verifyContentSig(String(pk.publicKey), j.abi, j.seq, 'ef'.repeat(32), j.channel, j.sig)).toBe(false);
      expect(verifyContentSig(String(pk.publicKey), j.abi, j.seq, j.manifest, 'beta', j.sig)).toBe(false);
    }
    // запасной указатель dev подписан каналом dev — клиент прода, спросивший live, его отвергнет
    t += 10_000; pointers = { dev: P(9) };
    const fb = await getJson('/api/content/pointer?channel=beta') as { seq: number; manifest: string; channel: string; sig: string };
    expect(fb.channel).toBe('dev');
    expect(verifyContentSig(signer.publicKey, 1, fb.seq, fb.manifest, 'dev', fb.sig)).toBe(true);
    expect(verifyContentSig(signer.publicKey, 1, fb.seq, fb.manifest, 'beta', fb.sig)).toBe(false);
  });

  it('build ниже minClient — 200 с флагом «нужен новый клиент»; ниже latestClient — «доступно обновление»; без build — 0', async () => {
    t += 10_000; pointers = { live: P(12, 'live', { minClient: 118, latestClient: 121 }) };
    expect(await getJson('/api/content/pointer?channel=live&build=117')).toMatchObject({ build: 117, minClient: 118, latestClient: 121, clientRequired: true, clientOutdated: true, seq: 12 });
    expect(await getJson('/api/content/pointer?channel=live&build=119')).toMatchObject({ clientRequired: false, clientOutdated: true });
    expect(await getJson('/api/content/pointer?channel=live&build=121')).toMatchObject({ clientRequired: false, clientOutdated: false });
    expect(await getJson('/api/content/pointer?channel=live')).toMatchObject({ build: 0, clientRequired: true });
    const r = await raw('/api/content/pointer?channel=live&build=117');
    expect(r.status).toBe(200);
    expect((await raw('/api/content/pointer?channel=live&build=-1')).status).toBe(400);
    expect((await raw('/api/content/pointer?channel=live&build=1.5')).status).toBe(400);
    expect((await raw(`/api/content/pointer?channel=live&id=${'x'.repeat(129)}`)).status).toBe(400);
  });

  it('ETag — от всего ответа: другая корзина и другой build — другой ETag', async () => {
    t += 10_000; pointers = { live: live(50) };
    const ids = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];
    const inside = ids.find((id) => rolloutBucket(id, 'live', 12) < 50)!;
    const outside = ids.find((id) => rolloutBucket(id, 'live', 12) >= 50)!;
    const a = await raw(`/api/content/pointer?channel=live&id=${inside}`);
    const b = await raw(`/api/content/pointer?channel=live&id=${outside}`);
    expect(a.headers.etag).not.toBe(b.headers.etag);
    expect((await raw(`/api/content/pointer?channel=live&id=${outside}`, { 'if-none-match': String(a.headers.etag) })).status).toBe(200);
    const c = await raw(`/api/content/pointer?channel=live&id=${inside}&build=5`);
    expect(c.headers.etag).not.toBe(a.headers.etag);
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

describe('⭐ Д3: ручки администратора', () => {
  const post = (path: string, body: unknown, at = base): Promise<Response> =>
    fetch(at + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ADMIN = ['/api/admin/content/promote', '/api/admin/content/rollback', '/api/admin/content/clients', '/api/admin/content/gc'];

  it('без охраны — 403 на каждой, и действие не доходит до базы; ни слова в лог', async () => {
    allowAdmin = false;
    const before = adminCalls.length;
    expect((await fetch(base + '/api/admin/content/releases')).status).toBe(403);
    for (const p of ADMIN) expect((await post(p, { channel: 'live', seq: 5, minClient: 1 })).status).toBe(403);
    expect(adminCalls.length).toBe(before);
    expect(adminLog).toHaveLength(0);
    allowAdmin = true;
  });

  it('ручки есть и на проде — под той же охраной (отдельная дверь, а не dev-роут)', async () => {
    expect((await fetch(prodBase + '/api/admin/content/releases')).status).toBe(200);
    allowAdmin = false;
    expect((await post('/api/admin/content/promote', { channel: 'live', seq: 5 }, prodBase)).status).toBe(403);
    allowAdmin = true;
  });

  it('список: релизы, каналы, ключ подписи', async () => {
    const r = await fetch(base + '/api/admin/content/releases?limit=10&abi=1');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ abi: 1, keyId: signer.keyId, devKey: true, devFallback: true, releases: [], channels: [] });
    expect(adminCalls.at(-1)).toEqual({ op: 'list', arg: { abi: 1, limit: 10 } });
    expect((await fetch(base + '/api/admin/content/releases?limit=0')).status).toBe(400);
  });

  it('выпуск: канал dev и чужой — 400; кривой процент — 400; годный — действие с проверкой файлов, кэш указателя сброшен, строка в лог', async () => {
    expect((await post('/api/admin/content/promote', { channel: 'dev', seq: 5 })).status).toBe(400);
    expect((await post('/api/admin/content/promote', { channel: 'prod', seq: 5 })).status).toBe(400);
    expect((await post('/api/admin/content/promote', { channel: 'live', seq: 5, percent: 101 })).status).toBe(400);
    expect((await post('/api/admin/content/promote', { channel: 'live', seq: '5' })).status).toBe(400);
    t += 10_000; pointers = { live: P(10, 'live') };
    expect(await getJson('/api/content/pointer?channel=live')).toMatchObject({ seq: 10 });
    pointers = { live: P(12, 'live') };
    const ok = await post('/api/admin/content/promote', { channel: 'live', seq: 12, percent: 10 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ channel: 'live', seq: 12, rollout: 10 });
    const call = adminCalls.at(-1)!;
    expect(call.op).toBe('promote');
    expect(call.arg).toMatchObject({ channel: 'live', seq: 12, percent: 10, actor: 'tester' });
    expect(typeof (call.arg as PromoteInput).verify).toBe('function');
    expect(await getJson('/api/content/pointer?channel=live')).toMatchObject({ seq: 12 });   // кэш сброшен, не ждём секунду
    expect(adminLog.at(-1)).toMatch(/^выпуск: live ← #12 на 10%.*— tester$/);
  });

  it('проверка файлов, которую ручка отдаёт операции, видит хранилище: нет манифеста — он и недостаёт; нарезанный релиз — цел', async () => {
    const verify = (adminCalls.filter((c) => c.op === 'promote').at(-1)!.arg as PromoteInput).verify!;
    const ghost = sha256('нет манифеста');
    expect(verify(ghost)).toEqual([ghost]);
    const b = buildRelease({ config: '{}', configRev: 'a', gameRev: 'b', pose: { pe_clips: [{ n: 1 }] } });
    for (const bytes of b.blobs.values()) store.put(bytes);
    store.put(b.manifestBytes);
    expect(verify(b.manifestSha)).toEqual([]);
  });

  it('отказ правилом — его код и строка (с подробностями), и строка отказа в лог', async () => {
    adminFail = new ChannelOpError(409, 'у релиза #12 нет файлов в хранилище (2) — выпускать нечего', { missing: ['a', 'b'], count: 2 });
    const r = await post('/api/admin/content/promote', { channel: 'live', seq: 12 });
    adminFail = null;
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'у релиза #12 нет файлов в хранилище (2) — выпускать нечего', missing: ['a', 'b'], count: 2 });
    expect(adminLog.at(-1)).toContain('отказ 409');
  });

  it('откат: канал и необязательный toSeq; ABI — сервера', async () => {
    expect((await post('/api/admin/content/rollback', { channel: 'dev' })).status).toBe(400);
    expect((await post('/api/admin/content/rollback', { channel: 'live', toSeq: 0 })).status).toBe(400);
    const r = await post('/api/admin/content/rollback', { channel: 'live' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ seq: 13, reissued: true, origin: 10, rollout: 100 });
    expect(adminCalls.at(-1)).toMatchObject({ op: 'rollback', arg: { channel: 'live', abi: 1, toSeq: undefined, actor: 'tester' } });
    await post('/api/admin/content/rollback', { channel: 'beta', toSeq: 7 });
    expect(adminCalls.at(-1)).toMatchObject({ op: 'rollback', arg: { channel: 'beta', toSeq: 7 } });
    expect(adminLog.at(-1)).toMatch(/^откат: beta: #13 \(перевыпуск содержимого #10\)/);
  });

  it('версии клиента: любой канал (и dev); номера — целые 0..2^31-1', async () => {
    const r = await post('/api/admin/content/clients', { channel: 'dev', minClient: 118, latestClient: 121 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ minClient: 118, latestClient: 121 });
    expect(adminCalls.at(-1)).toMatchObject({ op: 'clients', arg: { channel: 'dev', abi: 1, minClient: 118, latestClient: 121, actor: 'tester' } });
    expect((await post('/api/admin/content/clients', { channel: 'live', minClient: -1 })).status).toBe(400);
    expect((await post('/api/admin/content/clients', { channel: 'live', minClient: 2 ** 31 })).status).toBe(400);
    expect((await post('/api/admin/content/clients', { channel: '../x', minClient: 1 })).status).toBe(400);
  });

  it('уборка: по умолчанию сухой прогон, 20 релизов, 14 суток; срок меньше суток — 400', async () => {
    const r = await post('/api/admin/content/gc', {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ dryRun: true, removed: 1, keepReleases: 20, minAgeDays: 14 });
    expect(adminCalls.at(-1)).toEqual({ op: 'gc', arg: { dryRun: true, keepReleases: 20, minAgeMs: 14 * 86_400_000 } });
    expect(adminLog.at(-1)).toContain('сухой прогон');
    await post('/api/admin/content/gc', { dryRun: false, keepReleases: 5, minAgeDays: 30 });
    expect(adminCalls.at(-1)).toEqual({ op: 'gc', arg: { dryRun: false, keepReleases: 5, minAgeMs: 30 * 86_400_000 } });
    expect((await post('/api/admin/content/gc', { minAgeDays: 0.5 })).status).toBe(400);
    expect((await post('/api/admin/content/gc', { dryRun: 'no' })).status).toBe(400);
    expect((await post('/api/admin/content/gc', { keepReleases: 0 })).status).toBe(400);
  });
});
