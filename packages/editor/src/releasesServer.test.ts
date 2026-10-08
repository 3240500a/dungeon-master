import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildModel, channelOf, loadList, planClients, planPromote, planRollback, request, runPlan, URLS,
  type ChannelChange, type PageModel, type Plan, type Send,
} from './releasesModel.js';

/**
 * ⭐ 08.10 (Д3): ВКЛАДКА «📦 ВЫПУСКИ» ≡ СЕРВЕР. План вкладки (`releasesModel.ts`) повторяет правила сервера, чтобы подтверждение говорило
 * правду, а заведомый отказ не доходил до окна. Здесь план сверяется с НАСТОЯЩИМ сервером: ручки `server/src/net/releaseRoutes.ts` за
 * настоящим express и операции `server/src/content/releaseDb.ts` против базы `dungeon_test` в своей схеме (`server/src/db/testDb.ts`;
 * без базы — пропуск). Запросы идут теми же функциями, что у вкладки (`loadList`, `runPlan`), — вместо `devFetch` голый `fetch` к стенду.
 *
 *  • сценарий владельца: dev → «В бету» → «Выпустить» 10% → 50% → «Откатить» → версии клиента, с отказами по дороге;
 *  • фаззер: случайные нарезки и кнопки (`DM_FUZZ_SEEDS`, `DM_FUZZ_OPS`): план «можно» — сервер принял ровно с предсказанным итогом;
 *    «так уже есть» — сервер ответил «без изменений»; «нельзя» — сервер отказал (400/404/409) и ничего не поменял;
 *  • самопроверка: план, забывший правило «посреди раскатки другой релиз нельзя», фаззер ловит — он сверяет, а не кивает.
 *
 * Импорт сервера — с путём из переменной: пакет редактора не тянет сервер в свою проверку типов (как `configChannel.fuzzKit.ts`).
 */
interface TestDb { open(): Promise<boolean>; drop(): Promise<void> }
const tdb = await vi.hoisted(async () => {
  const path = '../../server/src/db/testDb.js';
  return ((await import(/* @vite-ignore */ path)) as { testDb(tag: string): TestDb }).testDb('edrelease');
});

interface Pool { initSchema(): Promise<void>; closePool(): Promise<void> }
interface ReleaseDb {
  initContentSchema(): Promise<void>;
  recordRelease(r: { abi: number; manifest: string; manifestSize: number; configRev: string; gameRev: string; note?: string }): Promise<{ seq: number; fresh: boolean }>;
  channelPointer: unknown; listReleases: unknown; promoteRelease: unknown; rollbackChannel: unknown; setChannelClients: unknown;
}
interface Store { put(bytes: Buffer): { sha: string; size: number } }

const SRV = '../../server/src/';
const imp = async <T>(p: string): Promise<T> => (await import(/* @vite-ignore */ SRV + p)) as T;

let alive = false;
let pool: Pool;
let rel: ReleaseDb;
let store: Store;
let root = '';
let server: Server | null = null;
let base = '';
const log: string[] = [];
const send: Send = (url, init) => fetch(base + url, init);

beforeAll(async () => {
  alive = await tdb.open();
  if (!alive) return;
  pool = await imp<Pool>('db/pool.js');
  rel = await imp<ReleaseDb>('content/releaseDb.js');
  const { blobStore } = await imp<{ blobStore(root: string): Store }>('content/blobStore.js');
  const { loadContentSigner } = await imp<{ loadContentSigner(o: unknown): unknown }>('content/contentSign.js');
  const { installReleaseRoutes } = await imp<{ installReleaseRoutes(app: unknown, deps: unknown): unknown }>('net/releaseRoutes.js');
  const expressName = 'express';
  const express = ((await import(/* @vite-ignore */ expressName)) as { default: () => { listen(port: number, host: string, cb: () => void): Server } }).default;
  await pool.initSchema();
  await rel.initContentSchema();
  root = mkdtempSync(join(tmpdir(), 'dm-edrelease-'));
  store = blobStore(root);
  const signer = loadContentSigner({ devKeyPath: join(root, 'dev-sign.key'), log: () => undefined, warn: () => undefined });
  const app = express();
  installReleaseRoutes(app, {
    store, pointer: rel.channelPointer, abi: 1, cdn: ['/c/'], signer, devFallback: true,
    admin: {
      guard: async () => 'editor-test',
      list: rel.listReleases, promote: rel.promoteRelease, rollback: rel.rollbackChannel, clients: rel.setChannelClients,
      gc: async () => { throw new Error('уборка вкладкой не зовётся'); },
      log: (m: string) => { log.push(m); },
    },
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (alive) { await pool.closePool(); await tdb.drop(); }
  if (root) rmSync(root, { recursive: true, force: true });
});

let cutNo = 0;
/** Нарезка: манифест (без файлов) в хранилище и релиз в базе — как у нарезчика; канал dev переезжает на него сам. */
async function cut(tag = `r${++cutNo}`): Promise<{ seq: number; manifest: string }> {
  const { sha, size } = store.put(Buffer.from(JSON.stringify({ format: 1, abi: 1, tag, files: {} }), 'utf8'));
  const r = await rel.recordRelease({ abi: 1, manifest: sha, manifestSize: size, configRev: `cfg-${tag}`, gameRev: `game-${tag}`, note: tag });
  return { seq: r.seq, manifest: sha };
}
/** Нарезка того же содержимого, что у старого релиза (правку вернули): dev получает новый номер со старым манифестом. */
async function recut(manifest: string): Promise<number> {
  return (await rel.recordRelease({ abi: 1, manifest, manifestSize: 10, configRev: 'cfg-back', gameRev: 'game-back', note: 'возврат' })).seq;
}

async function page(): Promise<PageModel> {
  const r = await loadList(send);
  if (!r.ok) throw new Error(r.error);
  return buildModel(r.value);
}
const states = (m: PageModel): string => JSON.stringify(m.channels.map((c) => c.state && {
  n: c.name, s: c.state.seq, p: c.state.prev, r: c.state.rollout, mi: c.state.minClient, la: c.state.latestClient,
}));

/** Итог совпал с обещанием плана. */
function matches(plan: Extract<Plan, { ok: true }>, before: PageModel, c: ChannelChange): void {
  const e = plan.expect;
  const ctx = `${plan.what} ${JSON.stringify(plan.body)} → ${JSON.stringify(c)}`;
  expect(c.changed, ctx).toBe(true);
  if (e.seq === 'new') expect(c.seq, ctx).toBeGreaterThan(before.maxSeq); else expect(c.seq, ctx).toBe(e.seq);
  expect({ rollout: c.rollout, prev: c.prev, reissued: c.reissued, origin: c.origin }, ctx)
    .toEqual({ rollout: e.rollout, prev: e.prev, reissued: e.reissued, origin: e.origin });
  if (e.minClient !== undefined) expect({ min: c.minClient, latest: c.latestClient }, ctx).toEqual({ min: e.minClient, latest: e.latestClient });
}

/** Сверить план с сервером: тело отказа — то, что послала бы вкладка без своей проверки. */
async function check(plan: Plan, body: Record<string, unknown>, url: string): Promise<ChannelChange | null> {
  const before = await page();
  if (plan.ok) {
    expect(plan.body, plan.what).toEqual(body);
    const r = await runPlan(send, plan);
    if (!r.ok) throw new Error(`план обещал «можно», сервер отказал: ${r.error}\n${plan.confirm}`);
    matches(plan, before, r.value);
    const after = await page();
    const ch = channelOf(after, r.value.channel)!.state!;
    expect({ seq: ch.seq, prev: ch.prev, rollout: ch.rollout }).toEqual({ seq: r.value.seq, prev: r.value.prev, rollout: r.value.rollout });
    return r.value;
  }
  const r = await request(send, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (plan.noop) {
    expect(r.status, `${plan.what}: ${plan.error}`).toBe(200);
    expect((r.body as ChannelChange).changed, plan.error).toBe(false);
  } else {
    expect([400, 404, 409], `план «нельзя» (${plan.error}), а сервер: ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
  }
  expect(states(await page()), plan.error).toBe(states(before));
  return null;
}

const pg = process.env.DM_SKIP_PG !== '1';

describe.runIf(pg)('⭐ Д3: вкладка «Выпуски» против настоящего сервера', () => {
  it('сценарий владельца: dev → бета → live 10% → 50% → откат → версии клиента; отказы — понятным текстом', async () => {
    if (!alive) return;
    const a = await cut('a');
    let m = await page();
    expect(channelOf(m, 'dev')!.state?.seq).toBe(a.seq);
    expect(channelOf(m, 'live')!.state).toBeNull();

    // live впервые — только на 100%: план и сервер согласны.
    const first10 = planPromote(m, 'live', a.seq, 10);
    expect(first10.ok).toBe(false);
    await check(first10, { channel: 'live', seq: a.seq, percent: 10 }, URLS.promote);

    await check(planPromote(m, 'beta', a.seq, 100), { channel: 'beta', seq: a.seq, percent: 100 }, URLS.promote);
    m = await page();
    await check(planPromote(m, 'live', a.seq, 100), { channel: 'live', seq: a.seq, percent: 100 }, URLS.promote);

    const b = await cut('b');
    m = await page();
    await check(planPromote(m, 'beta', b.seq, 100), { channel: 'beta', seq: b.seq, percent: 100 }, URLS.promote);
    m = await page();
    const ten = planPromote(m, 'live', b.seq, 10);
    expect(ten.ok && ten.confirm).toMatch(/~10% устройств.*~90% остаются на #/);
    await check(ten, { channel: 'live', seq: b.seq, percent: 10 }, URLS.promote);
    m = await page();
    expect(channelOf(m, 'live')!.state).toMatchObject({ seq: b.seq, prev: a.seq, rollout: 10 });
    expect(m.bySeq.get(b.seq)!.channels).toEqual(expect.arrayContaining([{ channel: 'live', as: 'current', percent: 10 }]));
    expect(m.bySeq.get(a.seq)!.channels).toEqual(expect.arrayContaining([{ channel: 'live', as: 'prev', percent: 90 }]));

    await check(planPromote(m, 'live', b.seq, 50), { channel: 'live', seq: b.seq, percent: 50 }, URLS.promote);
    m = await page();
    const down = planPromote(m, 'live', b.seq, 20);
    expect(!down.ok && down.error).toMatch(/только растёт/);
    await check(down, { channel: 'live', seq: b.seq, percent: 20 }, URLS.promote);

    const c = await cut('c');
    m = await page();
    const mid = planPromote(m, 'live', c.seq, 100);
    expect(!mid.ok && mid.error).toMatch(/идёт раскатка/);
    await check(mid, { channel: 'live', seq: c.seq, percent: 100 }, URLS.promote);

    // Откат: содержимое a под новым номером, раскатка снята, прежнего нет — второй «Откатить» некуда.
    const back = await check(planRollback(m, 'live'), { channel: 'live', abi: 1 }, URLS.rollback);
    expect(back).toMatchObject({ reissued: true, origin: a.seq, rollout: 100, prev: null });
    m = await page();
    const again = planRollback(m, 'live');
    expect(!again.ok && again.error).toMatch(/нет прежнего релиза/);
    await check(again, { channel: 'live', abi: 1 }, URLS.rollback);
    await check(planRollback(m, 'live', b.seq), { channel: 'live', abi: 1, toSeq: b.seq }, URLS.rollback);

    // Версии клиента.
    m = await page();
    await check(planClients(m, 'live', '5', '6'), { channel: 'live', abi: 1, minClient: 5, latestClient: 6 }, URLS.clients);
    m = await page();
    expect(channelOf(m, 'live')!.state).toMatchObject({ minClient: 5, latestClient: 6 });
    await check(planClients(m, 'live', '5', '6'), { channel: 'live', abi: 1, minClient: 5, latestClient: 6 }, URLS.clients);
    await check(planClients(m, 'live', '7', '5'), { channel: 'live', abi: 1, minClient: 7, latestClient: 5 }, URLS.clients);
    // Новая нарезка версии клиента не сбрасывает (они на канале, а не на релизе).
    await cut('d');
    expect(channelOf(await page(), 'live')!.state).toMatchObject({ minClient: 5, latestClient: 6 });
    expect(log.some((l) => /^выпуск: live ← #\d+ на 10%/.test(l))).toBe(true);
  });

  it('у релиза нет файлов в хранилище — план «можно», сервер отказывает 409, и вкладка называет недостающее', async () => {
    if (!alive) return;
    const ghost = 'f'.repeat(64);   // манифеста нет в хранилище
    const seq = (await rel.recordRelease({ abi: 1, manifest: ghost, manifestSize: 1, configRev: 'x', gameRev: 'y', note: 'без файлов' })).seq;
    const m = await page();
    const plan = planPromote(m, 'beta', seq, 100);
    if (!plan.ok) throw new Error(plan.error);
    const r = await runPlan(send, plan);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/^В бету: сервер отказал \(409\) — у релиза #\d+ нет файлов в хранилище \(1\)/);
      expect(r.error).toContain('Нет в хранилище: ffffffffff');
    }
    await cut('after-ghost');   // dev — снова на годном релизе (фаззер ниже берёт релизы из списка)
  });

  it('фаззер: случайные нарезки и кнопки — план вкладки ≡ ответ сервера', async () => {
    if (!alive) return;
    const seeds = Number(process.env.DM_FUZZ_SEEDS ?? 2);
    const ops = Number(process.env.DM_FUZZ_OPS ?? 60);
    const tally = { ok: 0, noop: 0, refused: 0 };
    for (let s = 1; s <= seeds; s++) await fuzz(s, ops, planPromote, tally);
    // Фаззер обязан ходить по обеим дорогам — иначе он молча проверяет пустоту.
    expect(tally.ok).toBeGreaterThan(5);
    expect(tally.refused).toBeGreaterThan(5);
  }, 120_000);

  it('самопроверка: вкладка, обещающая «можно» посреди раскатки (правило забыто), ловится', async () => {
    if (!alive) return;
    const lax: typeof planPromote = (m, channel, seq, percent) => {
      const p = planPromote(m, channel, seq, percent);
      if (p.ok || !/идёт раскатка/.test(p.error)) return p;
      return { ok: true, what: p.what, url: URLS.promote, body: { channel, seq, percent }, confirm: '', expect: { seq, rollout: percent, prev: null, reissued: false, origin: seq } };
    };
    let caught = '';
    for (let s = 101; s <= 106 && !caught; s++) {
      try { await fuzz(s, 60, lax, { ok: 0, noop: 0, refused: 0 }); } catch (e) { caught = String(e); }
    }
    expect(caught).toMatch(/план обещал «можно», сервер отказал: .*идёт раскатка/);
  }, 120_000);
});

/** Один прогон фаззера: `ops` случайных шагов от сида; `promote` — план выпуска (подменяется в самопроверке). */
async function fuzz(seed: number, ops: number, promote: typeof planPromote, tally: { ok: number; noop: number; refused: number }): Promise<void> {
  const rnd = mulberry32(seed * 7919);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  for (let i = 0; i < ops; i++) {
    const m = await page();
    const seqs = m.releases.filter((r) => r.note !== 'без файлов').map((r) => r.seq);
    const roll = rnd();
    let plan: Plan; let body: Record<string, unknown>; let url: string;
    if (roll < 0.12) { await cut(); continue; }
    if (roll < 0.17) { await recut(m.bySeq.get(pick(seqs))!.manifest); continue; }
    const channel = pick(['beta', 'live'] as const);
    const cur = channelOf(m, channel)!.state;
    if (roll < 0.6) {
      const seq = cur && rnd() < 0.3 ? cur.seq : pick(seqs);
      const percent = pick([1, 10, 25, 50, 99, 100, 100, 1 + Math.floor(rnd() * 100)]);
      plan = promote(m, channel, seq, percent); body = { channel, seq, percent }; url = URLS.promote;
    } else if (roll < 0.82) {
      const toSeq = rnd() < 0.5 ? undefined : pick(seqs);
      plan = planRollback(m, channel, toSeq); body = { channel, abi: 1, ...(toSeq !== undefined ? { toSeq } : {}) }; url = URLS.rollback;
    } else {
      const min = pick([0, 0, 1, 3, 5, 10]); const latest = pick([0, 0, 2, 5, 10]);
      plan = planClients(m, channel, String(min), String(latest)); body = { channel, abi: 1, minClient: min, latestClient: latest }; url = URLS.clients;
    }
    await check(plan, body, url);
    tally[plan.ok ? 'ok' : plan.noop ? 'noop' : 'refused']++;
  }
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
