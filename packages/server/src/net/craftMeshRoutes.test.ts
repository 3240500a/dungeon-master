import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ConfigRegistry, defaultParts, familiesOf, weaponLookSig, type WeaponLookHand } from '@dm/shared';
import type { BakeJob, BakeResult } from '../craftMesh/baker.js';
import type { CraftMeshService } from '../craftMesh/service.js';

// Настоящий поток печи поднимается секунды (разбор `shared` и построителей), под нагрузкой полного прогона — дольше.
vi.setConfig({ testTimeout: 90_000 });

/**
 * ⭐ U6b · `GET /api/craft-mesh.glb` ЗА НАСТОЯЩИМ EXPRESS. База сессий — шпион; печь — НАСТОЯЩИЙ поток (`workerBoot.mjs` → `worker.ts`:
 * tsx, `three`, построители) у первого сервера и шпион у второго (статусы, которых живая печь не даёт по заказу).
 *  • годный вид → GLB настоящей печи: грузится, вершины есть, материалы `семья:ступень`; повтор — из памяти; `If-None-Match` — 304;
 *  • правка таблицы модели → новый ETag и новая модель (поток получил новые таблицы: свечение посоха сменило цвет);
 *  • кривой вид → 400; без сессии → 401 (и раньше разбора вида); потолки аккаунта и сети адреса → 429 с `Retry-After`;
 *  • печь занята → 503 с `Retry-After`; вид не строится → 422, и повтор печь не занимает.
 */
const db = vi.hoisted(() => ({ sessions: new Map<string, string>(), lookups: 0 }));
vi.mock('../db/db.js', () => ({
  getSession: async (t: string) => { db.lookups++; return db.sessions.get(t) ?? null; },
  listLiveSessions: async () => [],
  listUsernames: async () => [],
}));

const tok = (n: number): string => n.toString(16).padStart(64, 'a');
const TOKEN = tok(1), TOKEN_RL = tok(2), TOKEN_IP = tok(3), TOKEN_KNOWN = tok(4), TOKEN_NEW = tok(5);
db.sessions.set(TOKEN, 'user-1');
db.sessions.set(TOKEN_RL, 'user-rl');
db.sessions.set(TOKEN_IP, 'user-ip');
db.sessions.set(TOKEN_KNOWN, 'user-known');
db.sessions.set(TOKEN_NEW, 'user-new');

const reg = new ConfigRegistry();
reg.loadAll();
const spyReg = new ConfigRegistry();
spyReg.loadAll();

function handOf(r: ConfigRegistry, cls: string, hands: number): WeaponLookHand {
  const base = r.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === cls && (b.hands ?? 1) === hands && !b.id.startsWith('archmage'))!;
  return { baseId: base.id, parts: defaultParts(r, cls, hands, 3)! };
}

let realSvc: CraftMeshService;
let realBase = '';
let spyBase = '';
const spy = { jobs: [] as BakeJob[], answer: (_j: BakeJob): BakeResult => ({ ok: true, glb: new Uint8Array([103, 108, 84, 70]) }) };
const servers: Server[] = [];
let addr = 0;
/** Свой адрес на тест (за петлёй — `X-Forwarded-For`): бакеты сети адреса у тестов свои. */
let ip = '';

async function listen(app: express.Express): Promise<string> {
  const s = await new Promise<Server>((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  const { installCraftMeshRoute } = await import('./craftMeshRoutes.js');
  const { CraftMeshService } = await import('../craftMesh/service.js');
  const real = express();
  realSvc = installCraftMeshRoute(real, { config: reg });
  realBase = await listen(real);
  const fake = express();
  installCraftMeshRoute(fake, {
    config: spyReg,
    service: new CraftMeshService({ config: spyReg, codeStamp: 'spy', baker: { bake: async (j) => { spy.jobs.push(j); return spy.answer(j); } } }),
  });
  spyBase = await listen(fake);
});
afterAll(async () => {
  for (const s of servers) s.close();
  await realSvc?.close();
});
beforeEach(() => { ip = `10.77.${Math.floor(++addr / 250)}.${addr % 250}`; });
afterEach(() => { vi.restoreAllMocks(); });

const url = (base: string, look: string | undefined, extra = ''): string =>
  `${base}/api/craft-mesh.glb${look === undefined ? '' : `?look=${encodeURIComponent(look)}`}${extra}`;
function get(u: string, o: { token?: string | null; inm?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'x-forwarded-for': ip };
  if (o.token !== null) headers.authorization = `Bearer ${o.token ?? TOKEN}`;
  if (o.inm) headers['if-none-match'] = o.inm;
  return fetch(u, { headers });
}

async function parseGlb(r: Response): Promise<{ verts: number; mats: string[] }> {
  const ab = await r.arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(ab, '');
  let verts = 0;
  const mats = new Set<string>();
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    verts += m.geometry.getAttribute('position').count;
    mats.add((m.material as THREE.Material).name);
  });
  return { verts, mats: [...mats].sort() };
}

describe('⭐ U6b: модель из деталей — настоящая печь', () => {
  it('годный вид → 200 GLB: грузится, вершины есть, материалы названы; повтор — из памяти; If-None-Match — 304 без печи', async () => {
    const look = weaponLookSig(handOf(reg, 'sword', 1));
    const r = await get(url(realBase, look));
    expect(r.status, await r.clone().text().catch(() => '')).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^model\/gltf-binary/);
    expect(r.headers.get('cache-control')).toBe('private, no-cache');
    expect(r.headers.get('x-craft-mesh-source')).toBe('bake');
    const etag = r.headers.get('etag')!;
    expect(etag).toMatch(/^"cm-[A-Za-z0-9_-]+"$/);
    const { verts, mats } = await parseGlb(r);
    expect(verts).toBeGreaterThan(100);
    expect(mats.length).toBeGreaterThan(0);
    expect(mats.every((m) => /^(?:[a-z]+:[1-5](?::glow=[0-9a-f]{6})?|fixed:[0-9a-f]{6})$/.test(m)), mats.join(', ')).toBe(true);

    const again = await get(url(realBase, look));
    expect(again.status).toBe(200);
    expect(again.headers.get('x-craft-mesh-source'), 'повтор — из памяти').toBe('memory');
    expect(again.headers.get('etag')).toBe(etag);

    const bakes = realSvc.cache.stats().misses;
    const nm = await get(url(realBase, look), { inm: `W/${etag}` });
    expect(nm.status, 'ETag совпал — 304').toBe(304);
    expect(nm.headers.get('etag')).toBe(etag);
    expect(realSvc.cache.stats().misses, '304 — без кэша и печи').toBe(bakes);
  });

  it('⭐ правка таблицы модели → новый ETag и модель с новыми таблицами (поток получил их): свечение посоха сменило цвет', async () => {
    const hands = familiesOf(reg, 'staff')[0]!;
    const look = weaponLookSig(handOf(reg, 'staff', hands));
    const r1 = await get(url(realBase, look));
    expect(r1.status).toBe(200);
    const glow1 = (await parseGlb(r1)).mats.find((m) => m.includes(':glow='))!;
    expect(glow1, 'у посоха светится фокус').toBeTruthy();
    expect(glow1, 'не архимаг: цвет — от стихии базы').not.toMatch(/c08aff$/);
    const [to, hex] = glow1.endsWith('8fe8ff') ? ['poison', '7fe07a'] : ['cold', '8fe8ff'];
    reg.reload({
      'items.base': reg.get('items.base').map((b) =>
        b.kind === 'weapon' && (b.weaponClass === 'staff' || b.weaponClass === 'wand') && !b.id.startsWith('archmage') ? { ...b, damageType: to } : b),
    }, { cross: false });
    const r2 = await get(url(realBase, look), { inm: r1.headers.get('etag')! });
    expect(r2.status, 'старый ETag больше не совпадает').toBe(200);
    expect(r2.headers.get('etag')).not.toBe(r1.headers.get('etag'));
    expect(r2.headers.get('x-craft-mesh-rev')).not.toBe(r1.headers.get('x-craft-mesh-rev'));
    expect(r2.headers.get('x-craft-mesh-source')).toBe('bake');
    expect((await parseGlb(r2)).mats.find((m) => m.includes(':glow=')), 'модель из новых таблиц').toMatch(new RegExp(`glow=${hex}$`));
  });
});

describe('U6b: отказы до печи', () => {
  it('⭐ без сессии — 401, и раньше разбора вида; база сессий не спрашивается без токена', async () => {
    const look = weaponLookSig(handOf(spyReg, 'sword', 1));
    const before = db.lookups;
    expect((await get(url(spyBase, look), { token: null })).status, 'нет токена').toBe(401);
    expect((await get(url(spyBase, 'мусор'), { token: null })).status, 'мусорный вид без входа — тоже 401').toBe(401);
    expect((await get(url(spyBase, look), { token: 'not-a-token' })).status, 'токен не того вида').toBe(401);
    expect(db.lookups, 'кривой токен и пустой — без базы').toBe(before);
    expect((await get(url(spyBase, look), { token: tok(999) })).status, 'сессии нет').toBe(401);
    expect(spy.jobs.length, 'печь не тронута').toBe(0);
  });

  it('⭐ кривой вид — 400 с причиной, печь не тронута', async () => {
    const h = handOf(spyReg, 'sword', 1);
    const good = weaponLookSig(h);
    const bad: [string, string][] = [
      [url(spyBase, undefined), 'нет вида'],
      [`${spyBase}/api/craft-mesh.glb?look=a&look=b`, 'вид массивом'],
      [`${spyBase}/api/craft-mesh.glb?look[toString]=1`, 'вид объектом'],
      [url(spyBase, 'x'.repeat(2000)), 'простыня'],
      [url(spyBase, good.replace(/:3\|/, ':9|')), 'ступень 9'],
      [url(spyBase, good.replace(/\|[^|:]+:/, '|no-such-part:')), 'нет детали'],
      [url(spyBase, good.replace(/^[^|]+/, 'no-such-base')), 'нет базы'],
      [url(spyBase, weaponLookSig({ ...h, parts: { ...h.parts, grip: h.parts.strike } })), 'клинок в гнезде рукояти'],
    ];
    for (const [u, what] of bad) {
      const r = await get(u);
      expect(r.status, what).toBe(400);
      expect(((await r.json()) as { error?: string }).error, what).toBeTruthy();
    }
    expect(spy.jobs.length).toBe(0);
  });

  it('⭐ потолок АККАУНТА: 60 подряд, дальше 429 с Retry-After (часы бакетов — у теста)', async () => {
    const T = 1e12 + addr * 3_600_000;
    vi.spyOn(performance, 'now').mockImplementation(() => T);
    const look = weaponLookSig(handOf(spyReg, 'sword', 1));
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await get(url(spyBase, look), { token: TOKEN_RL })).status);
    expect(codes.slice(0, 60).every((c) => c === 200), codes.join(',')).toBe(true);
    const last = await get(url(spyBase, look), { token: TOKEN_RL });
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await get(url(spyBase, look))).status, 'другой аккаунт с того же адреса — свой потолок').toBe(200);
  });

  it('⭐ потолок СЕТИ адреса: исчерпан — 429 до сессии и печи', async () => {
    const T = 1e12 + addr * 3_600_000;
    vi.spyOn(performance, 'now').mockImplementation(() => T);
    const { limits } = await import('./rateLimit.js');
    while (limits.craftMeshIp.take(ip, T)) { /* сеть адреса выбрана другими аккаунтами */ }
    const before = db.lookups;
    const r = await get(url(spyBase, weaponLookSig(handOf(spyReg, 'sword', 1))), { token: TOKEN_IP });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(db.lookups, 'база сессий не спрошена').toBe(before);
  });

  it('⭐ R10-04: ЗНАКОМЫЙ токен бакет сети адреса не платит — поток чужих токенов за тем же NAT не запирает модели соседу', async () => {
    const T = 1e12 + addr * 3_600_000;
    vi.spyOn(performance, 'now').mockImplementation(() => T);
    const { limits } = await import('./rateLimit.js');
    const look = weaponLookSig(handOf(spyReg, 'sword', 1));
    expect((await get(url(spyBase, look), { token: TOKEN_KNOWN })).status, 'первый запрос: база подтвердила сессию').toBe(200);
    while (limits.craftMeshIp.take(ip, T)) { /* поток мусорных токенов выбрал сеть адреса */ }
    expect((await get(url(spyBase, 'мусор'), { token: tok(777) })).status, 'чужой токен — 429 до базы').toBe(429);
    const ok = await get(url(spyBase, look), { token: TOKEN_KNOWN });
    expect(ok.status, 'знакомый токен — модель, а не 429').toBe(200);
  });

  it('⭐ незнакомый, но живой токен платит сеть адреса ДО базы и получает токен назад: сеть адреса платят только неудачи', async () => {
    const T = 1e12 + addr * 3_600_000;
    vi.spyOn(performance, 'now').mockImplementation(() => T);
    const { limits } = await import('./rateLimit.js');
    let left = 0;
    while (limits.craftMeshIp.take(ip, T)) left++;
    limits.craftMeshIp.refund(ip);   // в бакете ровно один токен
    const look = weaponLookSig(handOf(spyReg, 'sword', 1));
    expect(left).toBeGreaterThan(1);
    expect((await get(url(spyBase, look), { token: TOKEN_NEW })).status, 'последний токен сети — живой сессии').toBe(200);
    expect(limits.craftMeshIp.peek(ip, T), 'живая сессия вернула токен сети').toBe(true);
    expect((await get(url(spyBase, look), { token: tok(778) })).status, 'сессии нет — 401').toBe(401);
    expect(limits.craftMeshIp.peek(ip, T), 'неудача токен не вернула').toBe(false);
  });
});

describe('U6b: отказы печи', () => {
  it('печь занята — 503 с Retry-After; вид не строится — 422, и повтор печь не занимает', async () => {
    const h = handOf(spyReg, 'axe', familiesOf(spyReg, 'axe')[0]!);
    spy.answer = () => ({ ok: false, kind: 'busy', reason: 'занята' });
    const busy = await get(url(spyBase, weaponLookSig(h)));
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('2');
    expect(busy.headers.get('etag') ?? '', 'у отказа нет ETag модели (слабый ETag тела JSON ставит сам express)').not.toMatch(/cm-/);
    spy.answer = () => ({ ok: false, kind: 'unbuildable', reason: 'не строится' });
    const n = spy.jobs.length;
    const u1 = await get(url(spyBase, weaponLookSig(h)));
    expect(u1.status).toBe(422);
    expect(await u1.json()).toEqual({ error: 'не строится' });
    expect((await get(url(spyBase, weaponLookSig(h)))).status).toBe(422);
    expect(spy.jobs.length - n, 'несобираемый вид помнится').toBe(1);
  });
});
