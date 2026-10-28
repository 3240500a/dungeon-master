import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import type { Item } from '../types/items.js';
import {
  SEAL_REFORGE_BIOME, canReforgeSeals, giveSealsTo, liveSealDefs, reforgeSeals, rollSeal, sealBiomeKey,
  sealBuffs, sealDangerOf, sealFitsBiome, sealKey, sealTiers,
} from './seals.js';

/**
 * ⭐⭐ Ф5-6′ (23.10): ПЕЧАТЬ МОЖЕТ ПРИНАДЛЕЖАТЬ БИОМУ (`seals[].biomes`; пусто — везде).
 *
 * Зачем: печать — КУСОК КОНТЕНТА, а контент у биомов разный; привязка даёт крипте свои печати, пещерам свои, и
 * спуск в другой биом перестаёт быть спуском с тем же набором решений. Сегодня все шесть видов — общие
 * (`biomes: []`), и это НАРОЧНО: в данных включён один биом (`crypt`), и привязывать виды к выключенным
 * биомам значило бы спрятать контент. Механика готова, наполнение — когда владелец включит пещеры и остальные.
 *
 * ⚠⚠ ПРАВИЛО ОДНО НА ВСЕ ПУТИ, И ИМЕННО ЭТО ЗДЕСЬ СТЕРЕЖЁТСЯ: привязанный вид не падает в чужом биоме, НЕ
 * ВСТАВЛЯЕТСЯ на чужом алтаре (сторож сервера — `room.sealBiome.test.ts`) и НЕ ДЕЙСТВУЕТ в множителях. Забудь
 * любой из трёх путей — и привязка родит предмет-ловушку: лежит в сумке, вставить нельзя, продать и разобрать
 * нельзя (печати этого не умеют по правилу), то есть чистая потеря хода.
 */

const dims = { cols: 10, rows: 6 };
let n = 0;
const uid = (): string => `b${++n}`;

/** Реестр, где первый вид привязан к `crypt`, а второй — к `caves`. */
function reg(): { r: ConfigRegistry; crypt: string; caves: string; free: string } {
  const r = new ConfigRegistry();
  r.loadAll();
  const seals = r.get('seals');
  const rows = seals.map((s, i) => (i === 0 ? { ...s, biomes: ['crypt'] } : i === 1 ? { ...s, biomes: ['caves'] } : s));
  r.reload({ seals: rows });
  return { r, crypt: seals[0]!.id, caves: seals[1]!.id, free: seals[2]!.id };
}

function bagOf(r: ConfigRegistry, want: [string, string, number][]): Item[] {
  const inv: Item[] = [];
  const gains: Record<string, number> = {};
  for (const [kind, tier, k] of want) gains[sealKey(kind, tier)] = (gains[sealKey(kind, tier)] ?? 0) + k;
  expect(Object.keys(giveSealsTo(r, inv, gains, dims, uid)), 'стенд: печати не влезли').toEqual([]);
  return inv;
}

describe('Ф5-6′: печать и биом', () => {
  it('⭐⭐ пустая привязка — вид живёт везде, в том числе когда биом неизвестен (город, кузница, редактор)', () => {
    const { r, free } = reg();
    const def = r.get('seals').find((s) => s.id === free)!;
    expect(def.biomes, 'умолчание данных — «везде»').toEqual([]);
    for (const biome of ['crypt', 'caves', undefined]) expect(sealFitsBiome(def, biome), `общий вид в ${biome ?? 'без биома'}`).toBe(true);
  });

  it('⭐⭐ привязанный вид виден только в своём биоме, а без биома — виден всегда', () => {
    const { r, crypt, caves } = reg();
    const inCrypt = liveSealDefs(r, 'crypt').map((s) => s.id);
    const inCaves = liveSealDefs(r, 'caves').map((s) => s.id);
    expect(inCrypt).toContain(crypt);
    expect(inCrypt, 'печать пещер в крипте не живёт').not.toContain(caves);
    expect(inCaves).toContain(caves);
    expect(inCaves).not.toContain(crypt);
    // ⚠ Биом неизвестен — список ПОЛНЫЙ: иначе у кузнеца пропали бы все привязанные печати.
    expect(liveSealDefs(r).map((s) => s.id), 'без биома — все живые виды').toContain(caves);
  });

  it('⭐⭐ ДРОП: в крипте не падает ни одна печать пещер (300 бросков)', () => {
    const { r, caves, crypt } = reg();
    const rng = createRng(11);
    const got = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const roll = rollSeal(r, 20, rng, 'crypt');
      if (roll) got.add(roll.sealId);
    }
    expect(got.has(caves), 'печать пещер выпала в крипте').toBe(false);
    expect(got.has(crypt), 'своя печать крипты выпадает').toBe(true);
  });

  it('⭐⭐ МНОЖИТЕЛИ: чужая печать не действует (как мёртвый вид), своя — действует', () => {
    const { r, caves } = reg();
    const top = sealTiers(r)[0]!;
    const picks = { [sealKey(caves, top.id)]: 1 };
    const here = sealBuffs(r, picks, 'crypt');
    const home = sealBuffs(r, picks, 'caves');
    const def = r.get('seals').find((s) => s.id === caves)!;
    console.log(`Ф5-6′ ЧУЖОЙ БИОМ: ${def.name} в крипте → ${def.danger.stat} ×${(here as Record<string, number>)[def.danger.stat]!.toFixed(2)}, в пещерах → ×${(home as Record<string, number>)[def.danger.stat]!.toFixed(2)}`);
    expect((here as Record<string, number>)[def.danger.stat], 'чужая печать не делает этаж опаснее').toBe(1);
    expect((here as Record<string, number>)[def.reward.stat], 'и богаче тоже не делает').toBe(1);
    expect((home as Record<string, number>)[def.danger.stat], 'своя — действует').toBeGreaterThan(1);
  });

  it('⭐⭐ допуск связки не обходится чужой печатью: мёртвая штука не приносит допуска живым', () => {
    const { r, crypt, caves } = reg();
    const top = sealTiers(r)[sealTiers(r).length - 1]!;
    const alone = sealDangerOf(r, { [sealKey(crypt, top.id)]: 1 }, 'crypt');
    const padded = sealDangerOf(r, { [sealKey(crypt, top.id)]: 1, [sealKey(caves, top.id)]: 1 }, 'crypt');
    console.log(`Ф5-6′ ДОПУСК: своя печать +${(alone * 100).toFixed(0)} %; со «добавкой» чужой +${(padded * 100).toFixed(0)} %`);
    expect(padded, 'чужая печать подняла допуск своей').toBe(alone);
  });

  /**
   * ⭐⭐ 23.10 (пробел ревизии): ОБА ШВА ЭТАЖА СПРАШИВАЮТ БИОМ — ПРАВИЛОМ, А НЕ ПАМЯТЬЮ.
   *
   * ⚠⚠ Ревизия нашла, что заселение (`Room.enterNode` → `spawnPacksEl`) звало `sealBuffs` БЕЗ биома, а награда
   * (`GameSession.enterFloor`) — С биомом: две стороны ОДНОЙ печати расходились, и привязанная печать делала
   * этаж опаснее, не делая богаче. Правка на месте, но «забыть третий аргумент» обязано быть НЕВОЗМОЖНО —
   * поэтому сторож читает ИСХОДНИКИ живых швов и требует биом у каждого вызова.
   *
   * ⚠ Тесты и редактор сюда не входят: у них своя задача (проверить само правило), и биом там может быть не нужен.
   */
  it('⭐⭐ оба живых шва зовут sealBuffs С БИОМОМ (иначе опасность и награда разойдутся)', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const here = url.fileURLToPath(new URL('.', import.meta.url));
    // ⚠ Путь от этого файла: `packages/shared/src/economy/` → корень репозитория пятью уровнями выше.
    const files = [
      `${here}../../../server/src/net/room.ts`,
      `${here}../session/session.ts`,
    ];
    const seen: string[] = [];
    for (const f of files) {
      const src = await fs.readFile(f, 'utf8');
      for (const m of src.matchAll(/sealBuffs\(([^)]*)\)/g)) {
        const args = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
        seen.push(`${f.split('/').pop()}: sealBuffs(${args.join(', ')})`);
        expect(args.length, `${f.split('/').pop()}: sealBuffs без биома — ${m[0]}`).toBe(3);
      }
    }
    expect(seen.length, 'швов не нашлось — сторож смотрит не туда').toBeGreaterThanOrEqual(2);
    console.log('ШВЫ С БИОМОМ\n  ' + seen.join('\n  '));
  });

  it('⭐⭐ ПЕРЕКОВКА не смешивает привязки — даже на одной ступени', () => {
    const { r, crypt, caves } = reg();
    const t1 = sealTiers(r)[0]!.id;
    const bag = bagOf(r, [[crypt, t1, 2], [caves, t1, 1]]);
    const can = canReforgeSeals(r, bag, { [sealKey(crypt, t1)]: 2, [sealKey(caves, t1)]: 1 }, 0, Infinity);
    expect(can.ok, 'смешанная привязка принята').toBe(false);
    if (!can.ok) expect(can.reason).toBe(SEAL_REFORGE_BIOME);
  });

  it('⭐⭐ ПЕРЕКОВКА: вид результата — ТОЙ ЖЕ привязки, что у отданных печатей', () => {
    const { r, crypt } = reg();
    // ⚠ Нужны хотя бы два вида одной привязки, иначе бросок нечему решать: добавим второй вид крипты.
    const seals = r.get('seals');
    r.reload({ seals: seals.map((s, i) => (i === 0 || i === 3 ? { ...s, biomes: ['crypt'] } : i === 1 ? { ...s, biomes: ['caves'] } : s)) });
    const t1 = sealTiers(r)[0]!.id;
    const need = r.get('balance').seals.reforge.need;
    const bag = bagOf(r, [[crypt, t1, need]]);
    const out = reforgeSeals(r, bag, { [sealKey(crypt, t1)]: need }, 0, dims, createRng(5), uid, Infinity);
    expect(out.ok, 'перековка своей привязки обязана проходить').toBe(true);
    if (out.ok) {
      const made = r.get('seals').find((s) => s.id === out.item.sealId)!;
      console.log(`Ф5-6′ ПЕРЕКОВКА В ПРИВЯЗКЕ: ${need}× крипты → ${out.item.name} (привязка «${sealBiomeKey(made)}»)`);
      expect(sealBiomeKey(made), 'вышла печать чужой привязки').toBe('crypt');
    }
  });
});
