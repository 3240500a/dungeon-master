import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blobStore, sha256, type BlobStore } from './blobStore.js';
import { buildRelease } from './releaseManifest.js';
import { artFilesIn, collectGarbage, missingFiles, releaseFiles } from './contentGc.js';
import { ChannelOpError } from './channelRules.js';

/**
 * ⭐ 08.10 (Д3): ФАЙЛЫ РЕЛИЗА И УБОРКА ХРАНИЛИЩА — временная папка, часы — у теста (возраст файла двигаем `utimes`).
 * Удаляется только то, на что не ссылается ни один держимый манифест и ни одно арт-описание, и что старше срока; сухой прогон ничего не
 * трогает; нечитаемый держимый манифест останавливает уборку целиком.
 */
let root = '';
let store: BlobStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dm-gc-')); store = blobStore(root); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.now();
function age(sha: string, days: number): void {
  const t = (NOW - days * DAY) / 1000;
  for (const p of [store.pathOf(sha), store.pathOf(sha) + '.gz']) if (existsSync(p)) utimesSync(p, t, t);
}
/** Нарезать релиз в хранилище (как нарезчик): файлы, затем манифест. */
function cut(clips: unknown[]): { manifest: string; files: string[] } {
  const b = buildRelease({ config: '{"c":1}', configRev: 'c', gameRev: 'g', pose: { pe_clips: clips } });
  for (const bytes of b.blobs.values()) store.put(bytes);
  store.put(b.manifestBytes);
  return { manifest: b.manifestSha, files: [...b.blobs.keys()] };
}

describe('⭐ Д3: файлы релиза', () => {
  it('манифест и всё из него; недостающее видно; манифеста нет — он один и недостаёт', () => {
    const r = cut([{ n: 1 }, { n: 2 }]);
    expect(new Set(releaseFiles(store, r.manifest))).toEqual(new Set([r.manifest, ...r.files]));
    expect(missingFiles(store, r.manifest)).toEqual([]);
    rmSync(store.pathOf(r.files[0]!));
    expect(missingFiles(store, r.manifest)).toEqual([r.files[0]]);
    const ghost = sha256('нет такого манифеста');
    expect(missingFiles(store, ghost)).toEqual([ghost]);
  });
});

describe('⭐ Д3: уборка хранилища', () => {
  it('старое без ссылок — прочь; держимое и молодое — на месте; сухой прогон ничего не трогает', () => {
    const old = cut([{ n: 1 }, { n: 'старый' }]);
    const cur = cut([{ n: 1 }, { n: 'новый' }]);
    const stray = store.put(Buffer.from('молодой файл без ссылок'.repeat(40))).sha;
    for (const s of [old.manifest, ...old.files, cur.manifest, ...cur.files]) age(s, 30);
    const dry = collectGarbage({ store, keepManifests: [cur.manifest], minAgeMs: 14 * DAY, dryRun: true, now: NOW });
    const gone = [old.manifest, ...old.files.filter((f) => !cur.files.includes(f))];
    expect(dry.removed).toBe(gone.length);
    expect(new Set(dry.sample)).toEqual(new Set(gone));
    expect(dry.young).toBe(1);
    for (const s of gone) expect(store.has(s)).toBe(true);

    const wet = collectGarbage({ store, keepManifests: [cur.manifest], minAgeMs: 14 * DAY, dryRun: false, now: NOW });
    expect(wet.removed).toBe(gone.length);
    for (const s of gone) expect(store.has(s)).toBe(false);
    for (const s of [cur.manifest, ...cur.files, stray]) expect(store.has(s)).toBe(true);
    expect(collectGarbage({ store, keepManifests: [cur.manifest], minAgeMs: 14 * DAY, dryRun: false, now: NOW }).removed).toBe(0);
  });

  it('сжатая копия уходит вместе с файлом; обрывки записи и сирота-копия старше срока — тоже', () => {
    const big = store.put(Buffer.from(JSON.stringify(Array.from({ length: 400 }, (_, i) => i)))).sha;
    expect(store.gzPathOf(big)).not.toBeNull();
    age(big, 30);
    const dir = join(root, 'b', big.slice(0, 2));
    writeFileSync(join(dir, `${big}.1.abcd.part`), 'обрывок');
    const orphan = sha256('сирота');
    const orphanDir = join(root, 'b', orphan.slice(0, 2));
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, `${orphan}.gz`), 'gz');
    const t = (NOW - 30 * DAY) / 1000;
    utimesSync(join(dir, `${big}.1.abcd.part`), t, t);
    utimesSync(join(orphanDir, `${orphan}.gz`), t, t);
    const r = collectGarbage({ store, keepManifests: [], minAgeMs: 14 * DAY, dryRun: false, now: NOW });
    expect(r.removed).toBe(1);
    expect(r.parts).toBe(2);
    expect(readdirSync(dir).filter((n) => n.startsWith(big))).toEqual([]);
    expect(existsSync(join(orphanDir, `${orphan}.gz`))).toBe(false);
  });

  it('арт-описание держит свои файлы; кривое описание и нечитаемый держимый манифест — отказ без удалений', () => {
    const bundle = store.put(Buffer.from('бандл'.repeat(30))).sha;
    const catalog = store.put(Buffer.from('каталог')).sha;
    age(bundle, 30); age(catalog, 30);
    writeFileSync(join(root, 'art-abi1.json'), JSON.stringify({ catalog: { name: 'catalog.bin', sha: catalog, size: 7 }, bundles: [{ name: 'a.bundle', sha: bundle, size: 10 }] }));
    const protect = artFilesIn(root);
    expect(new Set(protect)).toEqual(new Set([bundle, catalog]));
    expect(collectGarbage({ store, keepManifests: [], protect, minAgeMs: DAY, dryRun: false, now: NOW }).removed).toBe(0);

    writeFileSync(join(root, 'art-abi2.json'), '{"кривой":');
    expect(() => artFilesIn(root)).toThrow(ChannelOpError);

    const ghost = sha256('манифест, которого нет');
    let err: unknown;
    try { collectGarbage({ store, keepManifests: [ghost], minAgeMs: DAY, dryRun: false, now: NOW }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ChannelOpError);
    expect((err as ChannelOpError).status).toBe(409);
    expect(store.has(bundle)).toBe(true);
  });
});
