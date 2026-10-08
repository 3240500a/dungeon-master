import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRegistry, defaultParts, weaponLookSig } from '@dm/shared';
import type { BakeJob, BakeResult } from './baker.js';
import { GlbCache } from './cache.js';
import { CraftMeshService, craftMeshCodeStamp } from './service.js';

/**
 * U6b: КЛЮЧ, КЭШ И ПЕЧЬ МОДЕЛИ ПО ВИДУ. Печь — шпион (настоящий поток — `net/craftMeshRoutes.test.ts`): проверяется, ЧТО печётся и
 * сколько раз. Ключ = штамп кода + ревизия таблиц модели + подпись: правка таблицы модели — новый ключ, чужой таблицы — тот же;
 * один вид печётся один раз (и одновременные запросы ждут одну печь); несобираемый — помнится; диск переживает новую службу, но
 * не смену кода.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'dm-u6b-')); dirs.push(d); return d; };

function spyBaker(answer: (j: BakeJob) => BakeResult = () => ({ ok: true, bytes: new Uint8Array([7, 7, 7]) }), delayMs = 0) {
  const jobs: BakeJob[] = [];
  return {
    jobs,
    bake: async (j: BakeJob): Promise<BakeResult> => {
      jobs.push(j);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return answer(j);
    },
  };
}

const freshReg = (): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(); return r; };
function look(reg: ConfigRegistry) {
  const base = reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'sword' && (b.hands ?? 1) === 1)!;
  const parts = defaultParts(reg, 'sword', 1, 3)!;
  return { sig: weaponLookSig({ baseId: base.id, parts }), parts };
}

describe('ключ модели', () => {
  it('⭐ правка таблицы модели — новый ключ и ETag; правка чужой таблицы — тот же', () => {
    const reg = freshReg();
    const svc = new CraftMeshService({ config: reg, baker: spyBaker(), codeStamp: 'code1' });
    const { sig, parts } = look(reg);
    const a = svc.request(sig, 'sword', 1, parts);
    expect(svc.request(sig, 'sword', 1, parts), 'тот же конфиг — тот же ключ').toEqual(a);
    reg.reload({ 'item-tiers': reg.get('item-tiers').map((t, i) => (i === 0 ? { ...t, name: `${t.name}·` } : t)) }, { cross: false });
    expect(svc.request(sig, 'sword', 1, parts).etag, 'таблица не из CRAFT_MESH_DEPS').toBe(a.etag);
    reg.reload({ 'weapon-parts': reg.get('weapon-parts').map((p) => (p.id === parts.strike.id ? { ...p, name: `${p.name}·` } : p)) }, { cross: false });
    const b = svc.request(sig, 'sword', 1, parts);
    expect(b.etag, 'деталь поправили — новый ETag').not.toBe(a.etag);
    expect(b.rev).not.toBe(a.rev);
    expect(b.tables['weapon-parts'], 'снимок таблиц — новые объекты').toBe(reg.get('weapon-parts'));
  });

  it('ревизия — по СОДЕРЖИМОМУ: тот же конфиг в другом процессе (другие объекты) — тот же ключ', () => {
    const r1 = freshReg(), r2 = freshReg();
    const { sig, parts } = look(r1);
    const k1 = new CraftMeshService({ config: r1, baker: spyBaker(), codeStamp: 'c' }).request(sig, 'sword', 1, parts);
    const k2 = new CraftMeshService({ config: r2, baker: spyBaker(), codeStamp: 'c' }).request(sig, 'sword', 1, parts);
    expect(k2.key).toBe(k1.key);
    const k3 = new CraftMeshService({ config: r2, baker: spyBaker(), codeStamp: 'c2' }).request(sig, 'sword', 1, parts);
    expect(k3.key, 'другой код печи — другой ключ').not.toBe(k1.key);
  });

  it('⭐ 08.10 (Ф4): формат — часть ключа: у DMCM свой ключ (`|bin1`) и ETag `"cmb1-…"`, у GLB — прежние', () => {
    const reg = freshReg();
    const svc = new CraftMeshService({ config: reg, baker: spyBaker(), codeStamp: 'code1' });
    const { sig, parts } = look(reg);
    const g = svc.request(sig, 'sword', 1, parts);
    const b = svc.request(sig, 'sword', 1, parts, 'bin');
    expect(g.fmt).toBe('glb');
    expect(b.fmt).toBe('bin');
    expect(g.key, 'ключ GLB не сменился — кэши старых сборок живы').toBe(`code1|${g.rev}|${sig}`);
    expect(b.key).toBe(`${g.key}|bin1`);
    expect(g.etag).toMatch(/^"cm-[A-Za-z0-9_-]{27}"$/);
    expect(b.etag).toMatch(/^"cmb1-[A-Za-z0-9_-]{27}"$/);
    expect(b.etag.slice(6)).not.toBe(g.etag.slice(4));
  });

  it('штамп кода считается из исходников (построитель, печь, shared, three)', () => {
    expect(craftMeshCodeStamp()).toMatch(/^[0-9a-z-]+\.[0-9a-z-]+\.[0-9a-z-]+\.three\d/);
  });
});

describe('кэш и печь', () => {
  it('⭐ один вид — одна печь: повтор из памяти, одновременные запросы ждут одну работу', async () => {
    const reg = freshReg();
    const baker = spyBaker(undefined, 20);
    const svc = new CraftMeshService({ config: reg, baker, codeStamp: '' });
    const { sig, parts } = look(reg);
    const q = svc.request(sig, 'sword', 1, parts);
    const all = await Promise.all(Array.from({ length: 8 }, () => svc.get(q)));
    expect(all.every((a) => a.ok)).toBe(true);
    expect(baker.jobs.length, 'восемь одновременных — одна печь').toBe(1);
    expect(await svc.get(q)).toMatchObject({ ok: true, source: 'memory' });
    expect(baker.jobs.length).toBe(1);
    expect(baker.jobs[0]).toMatchObject({ rev: q.rev, look: sig, weaponClass: 'sword', hands: 1, parts });
    expect(baker.jobs[0]!.tables(), 'печь получает ТОТ снимок таблиц, по которому ключ').toBe(q.tables);
  });

  it('несобираемый вид — 422 и помнится; сбой печи (занята) — 503 и НЕ помнится', async () => {
    const reg = freshReg();
    let kind: 'unbuildable' | 'busy' = 'unbuildable';
    const baker = spyBaker(() => ({ ok: false, kind, reason: kind }));
    const svc = new CraftMeshService({ config: reg, baker, codeStamp: '' });
    const { sig, parts } = look(reg);
    const q = svc.request(sig, 'sword', 1, parts);
    expect(await svc.get(q)).toEqual({ ok: false, status: 422, reason: 'unbuildable' });
    expect(await svc.get(q)).toEqual({ ok: false, status: 422, reason: 'unbuildable' });
    expect(baker.jobs.length, 'кривой вид печь второй раз не занимает').toBe(1);
    kind = 'busy';
    const q2 = svc.request(sig.replace(/:3\|/, ':2|'), 'sword', 1, parts);
    expect(await svc.get(q2)).toMatchObject({ ok: false, status: 503 });
    expect(await svc.get(q2)).toMatchObject({ ok: false, status: 503 });
    expect(baker.jobs.length, 'занятость не помнится — повтор идёт в печь').toBe(3);
  });

  it('⭐ память — LRU с потолком по байтам: старейшее вытесняется, свежепрочитанное живёт', () => {
    const c = new GlbCache({ maxBytes: 10, maxEntries: 100 });
    c.set('a', new Uint8Array(4)); c.set('b', new Uint8Array(4));
    expect(c.get('a')).toBeTruthy();          // «a» освежена
    c.set('c', new Uint8Array(4));             // 12 > 10 — вытесняется старейшая, то есть «b»
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeTruthy();
    expect(c.get('c')).toBeTruthy();
    expect(c.stats()).toMatchObject({ entries: 2, bytes: 8 });
    c.set('huge', new Uint8Array(11));
    expect(c.get('huge'), 'больше всего потолка — не кладётся').toBeUndefined();
    const n = new GlbCache({ maxBytes: 1000, maxEntries: 2 });
    n.set('1', new Uint8Array(1)); n.set('2', new Uint8Array(1)); n.set('3', new Uint8Array(1));
    expect(n.stats().entries, 'и с потолком по числу').toBe(2);
  });

  it('⭐ диск: новая служба (рестарт) берёт модель с диска без печи; другой код — печёт заново; без штампа диск не трогается', async () => {
    const reg = freshReg();
    const dir = tmp();
    const { sig, parts } = look(reg);
    const b1 = spyBaker(() => ({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]) }));
    const s1 = new CraftMeshService({ config: reg, baker: b1, codeStamp: 'code-A', cache: new GlbCache({ dir }) });
    expect(await s1.get(s1.request(sig, 'sword', 1, parts))).toMatchObject({ ok: true, source: 'bake' });
    for (let i = 0; i < 100 && !readdirSync(dir).some((f) => f.endsWith('.glb')); i++) await new Promise((r) => setTimeout(r, 10));
    expect(readdirSync(dir).filter((f) => f.endsWith('.glb')).length, 'записано на диск').toBe(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp')), 'без хвостов временных файлов').toEqual([]);

    const b2 = spyBaker();
    const s2 = new CraftMeshService({ config: reg, baker: b2, codeStamp: 'code-A', cache: new GlbCache({ dir }) });
    const a2 = await s2.get(s2.request(sig, 'sword', 1, parts));
    expect(a2).toMatchObject({ ok: true, source: 'disk' });
    expect(a2.ok && [...a2.bytes]).toEqual([1, 2, 3, 4]);
    expect(b2.jobs.length, 'с диска — без печи').toBe(0);

    const b3 = spyBaker();
    const s3 = new CraftMeshService({ config: reg, baker: b3, codeStamp: 'code-B', cache: new GlbCache({ dir }) });
    expect(await s3.get(s3.request(sig, 'sword', 1, parts))).toMatchObject({ ok: true, source: 'bake' });
    expect(b3.jobs.length, 'деплой с другим построителем — старую модель с диска не отдаёт').toBe(1);

    const empty = tmp();
    const s4 = new CraftMeshService({ config: reg, baker: spyBaker(), codeStamp: '', cache: new GlbCache({ dir: empty }) });
    await s4.get(s4.request(sig, 'sword', 1, parts));
    await new Promise((r) => setTimeout(r, 30));
    expect(readdirSync(empty), 'без штампа кода диск не пишется').toEqual([]);
  });

  it('⭐ 08.10 (Ф4): общий LRU и общий диск не путают форматы — байты GLB на запрос DMCM не уходят ни из памяти, ни с диска', async () => {
    const reg = freshReg();
    const dir = tmp();
    const { sig, parts } = look(reg);
    const GLB = [103, 108, 84, 70], BIN = [68, 77, 67, 77];
    const b1 = spyBaker((j) => ({ ok: true, bytes: new Uint8Array(j.fmt === 'bin' ? BIN : GLB) }));
    const s1 = new CraftMeshService({ config: reg, baker: b1, codeStamp: 'code-A', cache: new GlbCache({ dir }) });
    const g = await s1.get(s1.request(sig, 'sword', 1, parts));
    expect(g.ok && [...g.bytes]).toEqual(GLB);
    const b = await s1.get(s1.request(sig, 'sword', 1, parts, 'bin'));
    expect(b, 'GLB в памяти — DMCM всё равно печётся').toMatchObject({ ok: true, source: 'bake' });
    expect(b.ok && [...b.bytes]).toEqual(BIN);
    expect(b1.jobs.map((j) => j.fmt)).toEqual(['glb', 'bin']);
    expect(await s1.get(s1.request(sig, 'sword', 1, parts, 'bin'))).toMatchObject({ ok: true, source: 'memory', bytes: new Uint8Array(BIN) });
    expect(await s1.get(s1.request(sig, 'sword', 1, parts))).toMatchObject({ ok: true, source: 'memory', bytes: new Uint8Array(GLB) });
    for (let i = 0; i < 100 && readdirSync(dir).filter((f) => /\.(glb|dmcm)$/.test(f)).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(readdirSync(dir).filter((f) => f.endsWith('.glb')).length, 'GLB — .glb').toBe(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.dmcm')).length, 'DMCM — своё расширение').toBe(1);

    const b2 = spyBaker();
    const s2 = new CraftMeshService({ config: reg, baker: b2, codeStamp: 'code-A', cache: new GlbCache({ dir }) });
    const d2 = await s2.get(s2.request(sig, 'sword', 1, parts, 'bin'));
    expect(d2).toMatchObject({ ok: true, source: 'disk' });
    expect(d2.ok && [...d2.bytes], 'с диска — DMCM, а не GLB того же вида').toEqual(BIN);
    expect(b2.jobs.length).toBe(0);
  });

  it('потолок файлов на диске: сверх — сносятся старейшие', async () => {
    const dir = tmp();
    const c = new GlbCache({ dir, diskMax: 5 });
    for (let i = 0; i < 12; i++) await c.putDisk(`k${i}`, new Uint8Array([i]));
    const n = readdirSync(dir).filter((f) => f.endsWith('.glb')).length;
    expect(n).toBeLessThanOrEqual(5);
    expect(n).toBeGreaterThan(0);
    expect(await c.getDisk('k11'), 'свежайшее на месте').toBeTruthy();
  });

  it('⭐ чистка трогает ТОЛЬКО свои файлы: чужие .glb в папке живут; брошенный временный файл (сбой посреди записи) сносится', async () => {
    const dir = tmp();
    const foreign = ['knight.glb', 'Model_01.glb', `${'a'.repeat(63)}.glb`, 'readme.txt'];
    for (const f of foreign) writeFileSync(join(dir, f), 'x');
    const name = `${'b'.repeat(64)}.glb`;
    const stale = `${name}.4242.0badc0de.tmp`, fresh = `${name}.4243.0badc0df.tmp`;
    writeFileSync(join(dir, stale), 'half'); writeFileSync(join(dir, fresh), 'half');
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(dir, stale), old, old);
    for (const f of foreign) utimesSync(join(dir, f), old, old);   // чужие — старше любых наших: по возрасту снеслись бы первыми
    const c = new GlbCache({ dir, diskMax: 3 });
    for (let i = 0; i < 8; i++) await c.putDisk(`k${i}`, new Uint8Array([i]));
    const left = readdirSync(dir);
    for (const f of foreign) expect(left, `чужой «${f}» на месте`).toContain(f);
    expect(left.filter((f) => /^[0-9a-f]{64}\.glb$/.test(f)).length, 'своих — под потолком').toBeLessThanOrEqual(3);
    expect(left, 'брошенный временный файл снесён').not.toContain(stale);
    expect(left, 'свежий временный (запись идёт в другом процессе) не тронут').toContain(fresh);
  });

  it('⭐ сбой построителя (исключение) — 503 и НЕ помнится, причина наружу общая; повторился трижды — вид не строится (422, помнится)', async () => {
    const reg = freshReg();
    const baker = spyBaker(() => ({ ok: false, kind: 'error', reason: 'RangeError: Array buffer allocation failed at /srv/x.ts:1' }));
    const svc = new CraftMeshService({ config: reg, baker, codeStamp: '' });
    const { sig, parts } = look(reg);
    const q = svc.request(sig, 'sword', 1, parts);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a1 = await svc.get(q);
    expect(a1).toMatchObject({ ok: false, status: 503 });
    expect(!a1.ok && a1.reason, 'текст исключения клиенту не уходит').not.toMatch(/RangeError|\/srv/);
    expect(await svc.get(q)).toMatchObject({ ok: false, status: 503 });
    expect(baker.jobs.length, 'сбой не помнится — повтор идёт в печь').toBe(2);
    const a3 = await svc.get(q);
    expect(a3).toMatchObject({ ok: false, status: 422 });
    expect(!a3.ok && a3.reason).not.toMatch(/RangeError/);
    expect(await svc.get(q)).toMatchObject({ ok: false, status: 422 });
    expect(baker.jobs.length, 'третий сбой подряд — вид не строится, печь больше не занимает').toBe(3);
    expect(warn, 'подробность — в журнал сервера').toHaveBeenCalled();
    warn.mockRestore();
  });

  it('удачная печь после сбоя обнуляет счёт сбоев вида', async () => {
    const reg = freshReg();
    let n = 0;
    const baker = spyBaker(() => (++n % 3 === 0 ? { ok: true, bytes: new Uint8Array([n]) } : { ok: false, kind: 'error', reason: 'x' }));
    const svc = new CraftMeshService({ config: reg, baker, codeStamp: '', cache: new GlbCache({ maxEntries: 0 }) });
    const { sig, parts } = look(reg);
    const q = svc.request(sig, 'sword', 1, parts);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const got: number[] = [];
    for (let i = 0; i < 6; i++) { const a = await svc.get(q); got.push(a.ok ? 200 : a.status); }
    expect(got, 'два сбоя, удача, два сбоя, удача — до 422 не доходит').toEqual([503, 503, 200, 503, 503, 200]);
    warn.mockRestore();
  });
});
