import { describe, it, expect } from 'vitest';
import { buildRelease, CONTENT_ABI, parseArtRelease, type ReleaseInput } from './releaseManifest.js';
import { sha256 } from './blobStore.js';

/**
 * ⭐ 08.10 (Д1): МАНИФЕСТ РЕЛИЗА — одно содержимое даёт одни байты (иначе каждый старт сервера резал бы «новый» релиз и клиенты качали бы
 * манифест зря), клип — свой файл (правка одного клипа = один новый файл), порядок клипов — порядок библиотеки (клип ищется первым
 * совпадением), не-контент (роадмап) в релиз не попадает.
 */
function input(over: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    config: JSON.stringify({ balance: { a: 1 }, models: [] }),
    configRev: 'a-1', gameRev: 'b-2',
    pose: {
      pe_clips: [{ name: 'run_fwd', keys: [1, 2] }, { name: 'idle', keys: [3] }, { name: 'hit_axe', keys: [4] }],
      pe_anim: { warrior: { base: { idle: 'idle' } } },
      pe_grip: { axe: [0, 1, 2] },
      pe_roadmap: { milestones: [] },
    },
    ...over,
  };
}

describe('⭐ Д1: манифест релиза контента', () => {
  it('одно содержимое — одни байты и один хэш; порядок ключей входа не важен', () => {
    const a = buildRelease(input());
    const b = buildRelease(input());
    expect(b.manifestSha).toBe(a.manifestSha);
    const shuffled = input();
    shuffled.pose = { pe_roadmap: shuffled.pose.pe_roadmap, pe_grip: shuffled.pose.pe_grip, pe_clips: shuffled.pose.pe_clips, pe_anim: shuffled.pose.pe_anim };
    expect(buildRelease(shuffled).manifestSha).toBe(a.manifestSha);
    expect(sha256(a.manifestBytes)).toBe(a.manifestSha);
  });

  it('клип — свой файл, в порядке библиотеки; правка одного клипа меняет ровно один файл', () => {
    const a = buildRelease(input());
    expect(a.manifest.data.clips).toHaveLength(3);
    const edited = input();
    (edited.pose.pe_clips as { keys: number[] }[])[1]!.keys = [3, 3];
    const b = buildRelease(edited);
    const fresh = [...b.blobs.keys()].filter((sha) => !a.blobs.has(sha));
    expect(fresh).toHaveLength(1);
    expect(b.manifest.data.clips[1]).toBe(fresh[0]);
    expect(b.manifest.data.clips[0]).toBe(a.manifest.data.clips[0]);
    expect(b.manifestSha).not.toBe(a.manifestSha);
  });

  it('файл клипа — JSON клипа; конфиг — ровно тело `/api/config`', () => {
    const inp = input();
    const r = buildRelease(inp);
    expect(r.blobs.get(r.manifest.data.clips[2]!)!.toString('utf8')).toBe(JSON.stringify((inp.pose.pe_clips as unknown[])[2]));
    expect(r.blobs.get(r.manifest.data.config)!.toString('utf8')).toBe(inp.config);
  });

  it('ключи поз — по файлу, без клипов и роадмапа; ревизии и ABI — в манифесте; размеры всех файлов', () => {
    const r = buildRelease(input());
    expect(Object.keys(r.manifest.data.pose)).toEqual(['pe_anim', 'pe_grip']);
    expect(r.manifest.rev).toEqual({ config: 'a-1', game: 'b-2' });
    expect(r.manifest.abi).toBe(CONTENT_ABI);
    for (const [sha, bytes] of r.blobs) expect(r.manifest.files[sha]).toEqual({ size: bytes.length });
    expect(Object.keys(r.manifest.files)).toHaveLength(r.blobs.size);
  });

  it('одинаковые клипы — один файл, но два места в порядке; нет клипов — пустой список', () => {
    const dup = input();
    dup.pose.pe_clips = [{ name: 'x' }, { name: 'x' }];
    const r = buildRelease(dup);
    expect(r.manifest.data.clips).toHaveLength(2);
    expect(r.manifest.data.clips[0]).toBe(r.manifest.data.clips[1]);
    const none = input();
    delete none.pose.pe_clips;
    expect(buildRelease(none).manifest.data.clips).toEqual([]);
  });

  it('правка картинки в конфиге меняет файл конфига, но не клипы', () => {
    const a = buildRelease(input());
    const b = buildRelease(input({ config: JSON.stringify({ balance: { a: 1 }, models: [{ id: 'k' }] }) }));
    expect(b.manifest.data.config).not.toBe(a.manifest.data.config);
    expect(b.manifest.data.clips).toEqual(a.manifest.data.clips);
  });

  it('⭐ Д2: арт-релиз — в данных манифеста и в списке файлов с размерами; без арта — как прежде', () => {
    const sha = (c: string) => c.repeat(64).slice(0, 64);
    const art = { catalog: { name: 'catalog_abi1.bin', sha: sha('c'), size: 900 }, bundles: [{ name: 'char_knight_x.bundle', sha: sha('d'), size: 5_000_000 }] };
    const r = buildRelease(input({ art }));
    expect(r.manifest.data.art).toEqual(art);
    expect(r.manifest.files[sha('c')]).toEqual({ size: 900 });
    expect(r.manifest.files[sha('d')]).toEqual({ size: 5_000_000 });
    expect(r.blobs.has(sha('d'))).toBe(false);   // файлы арта уже в хранилище — не байты релиза
    expect(buildRelease(input()).manifest.data.art).toBeUndefined();
    expect(r.manifestSha).not.toBe(buildRelease(input()).manifestSha);
  });

  it('⭐ Д2: описание арт-релиза — только по форме: имя без путей, sha256, целый размер; бандлы по имени', () => {
    const ok = { catalog: { name: 'catalog_abi1.bin', sha: 'a'.repeat(64), size: 1 }, bundles: [{ name: 'b.bundle', sha: 'b'.repeat(64), size: 2 }, { name: 'a.bundle', sha: 'c'.repeat(64), size: 3 }] };
    expect(parseArtRelease(ok)!.bundles.map((b) => b.name)).toEqual(['a.bundle', 'b.bundle']);
    expect(parseArtRelease({ ...ok, catalog: { ...ok.catalog, name: '../x' } })).toBeNull();
    expect(parseArtRelease({ ...ok, catalog: { ...ok.catalog, sha: 'XYZ' } })).toBeNull();
    expect(parseArtRelease({ ...ok, bundles: [{ name: 'b', sha: 'b'.repeat(64), size: -1 }] })).toBeNull();
    expect(parseArtRelease(null)).toBeNull();
    // ⭐ 08.10: метка публикации (мс) — проходит; кривая — отбрасывается (описание без метки — по-прежнему годно)
    expect(parseArtRelease({ ...ok, built: 1_791_000_000_000 })!.built).toBe(1_791_000_000_000);
    expect(parseArtRelease({ ...ok, built: 'вчера' })!.built).toBeUndefined();
    expect(parseArtRelease({ ...ok, built: -5 })!.built).toBeUndefined();
  });
});
