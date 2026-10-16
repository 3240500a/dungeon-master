import { describe, it, expect } from 'vitest';
import { defaultConfigData } from '@dm/shared';
import { ROW_KEYS, getAt } from './model.js';
import { loadSeed, type ArtbookSeed } from './seed.js';

/**
 * ⭐ 16.10 (Артбук): сторож СИДА. Путь правки держится за ключ строки (`id` / `subtype` / `code`) — значит ключи в каждой
 * таблице черновика обязаны быть уникальными, иначе правка ляжет не на ту строку. Плюс сид согласован с конфигом: классы —
 * ровно классы игры, биомы заметок — существующие биомы.
 */
const load = (): Promise<ArtbookSeed> => loadSeed();

/** Все массивы объектов в дереве: путь → массив. */
function arraysOf(x: unknown, path = '', out: [string, unknown[]][] = []): [string, unknown[]][] {
  if (Array.isArray(x)) {
    if (x.some((r) => r && typeof r === 'object' && !Array.isArray(r))) out.push([path, x]);
    x.forEach((r, i) => arraysOf(r, `${path}/${i}`, out));
  } else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) arraysOf(v, path ? `${path}/${k}` : k, out);
  return out;
}

describe('artbook: сид', () => {
  it('черновик крипты: пять подтипов, архетипы и матрица ссылаются только на них', async () => {
    const { crypt } = await load();
    const ids = crypt.subtypes.map((s) => s.id);
    expect(ids).toEqual(['egypt_mesopotamia', 'greece', 'rome', 'vikings', 'medieval']);
    for (const a of crypt.archetypes) for (const s of a.subtypes) expect(ids, a.id).toContain(s);
    expect(crypt.matrix.columns.map((c) => c.id)).toEqual(ids);
    for (const r of [...crypt.layers.rows, ...crypt.decayLadder.rows, ...crypt.statuses.rows, ...crypt.signatures.rows, ...crypt.readability.keys]) expect(ids).toContain(r.subtype);
  });

  it('⭐ ключи строк уникальны в каждой таблице сида — путь правки не перепутает строки', async () => {
    const seed = await load();
    for (const [path, arr] of arraysOf(seed)) {
      for (const k of ROW_KEYS) {
        const keys = arr.map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>)[k] : undefined)).filter((v) => typeof v === 'string');
        if (!keys.length) continue;
        expect(new Set(keys).size, `${path}: повтор ${k}`).toBe(keys.length);
        expect(keys.some((v) => /^\d+$/.test(v as string)), `${path}: ключ-число спутается с индексом`).toBe(false);
        break;   // строку узнаёт первый найденный ключ
      }
    }
  });

  it('пути страниц находят поля черновика', async () => {
    const seed = await load();
    for (const p of [
      'crypt/subtypes/greece/lore', 'crypt/decayLadder/rows/rome/body', 'crypt/layers/rows/medieval/boss', 'crypt/engine/codes/К1/name',
      'crypt/engine/existingMap/zombie/to', 'crypt/packs/templates/herd/perSubtype/vikings', 'crypt/eras/archaic/note', 'crypt/intro/purpose/0',
      'crypt/readability/keys/rome/head', 'crypt/questions/0/rec', 'classes/classes/mage/lore', 'locations/biomes/crypt/artNotes',
    ]) expect(typeof getAt(seed, p), p).toBe('string');
  });

  it('классы сида = классы конфига; биомы заметок — из конфига', async () => {
    const { classes, locations } = await load();
    const cfgClasses = (defaultConfigData.classes as { id: string }[]).map((c) => c.id).sort();
    expect(classes.classes.map((c) => c.id).sort()).toEqual(cfgClasses);
    const biomes = (defaultConfigData.biomes as { id: string }[]).map((b) => b.id);
    for (const b of locations.biomes) expect(biomes).toContain(b.id);
  });
});
