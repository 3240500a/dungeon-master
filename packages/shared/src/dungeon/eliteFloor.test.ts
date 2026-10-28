import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateFloor } from './generateFloor.js';
import { spawnPacksEl } from './floor.js';
import { resolveFloorSpec } from './floorSpec.js';
import type { Biome, Floor } from '../config/schemas.js';

/**
 * ⭐⭐ Ф2 (16.10, решение владельца): «ЭЛИТНЫЙ ЭТАЖ — ЭТО ЭТАЖ, ГДЕ БУДУТ ЭЛИТНЫЕ МОНСТРЫ, НЕСКОЛЬКО ШТУК».
 *
 * ⚠⚠ ЗАМЕР, С КОТОРОГО ЭТО НАЧАЛОСЬ (аудит Ф2, 16.10): у `crypt-elite` стояло `features.uniqueRooms: 0` — то есть
 * «элитный» этаж не ставил НИ ОДНОЙ комнаты с элитой. Механизм был (комната с меткой `unique` форсит редкость
 * монстров — `dungeon/floor.ts`), а контента у него не было: тип узла обещал элиту, а этаж её не делал.
 *
 * Сторож меряет ИСХОД, а не настройку: сколько элитных монстров рождается на элитном этаже против обычного. Числа
 * печатаются — порог держит смысл («ощутимо больше»), а не конкретный прокат.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const crypt = reg.get('biomes').find((b) => b.id === 'crypt')! as Biome;
const floorById = (id: string): Floor => reg.get('floors').find((f) => f.id === id)! as Floor;

/** Монстры этажа по редкостям — тем же путём, что сервер: спецификация этажа → геометрия → пачки по комнатам. */
function rarities(floorId: string, seed: number): Record<string, number> {
  const spec = resolveFloorSpec(crypt, floorById(floorId), 7, seed, []);
  const layout = generateFloor(spec);
  const out: Record<string, number> = {};
  const rng = createRng((seed ^ 0x5bf03635) >>> 0 || 1);
  for (const s of spawnPacksEl(reg, layout, 7, 'normal', rng, crypt.monsterPool, 1, floorId)) {
    const r = (s.def as { rarity?: string }).rarity ?? 'normal';
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

/** Суммарно по сидам: элита = всё, что выше обычного (magic/rare/unique). */
function elites(floorId: string, seeds: number): { elite: number; total: number; unique: number } {
  let elite = 0, total = 0, unique = 0;
  for (let s = 1; s <= seeds; s++) {
    const r = rarities(floorId, s * 7919 + 13);
    for (const [k, n] of Object.entries(r)) {
      total += n;
      if (k !== 'normal') elite += n;
      if (k === 'unique') unique += n;
    }
  }
  return { elite, total, unique };
}

describe('⭐⭐ Ф2: элитный этаж ставит элиту', () => {
  it('⭐⭐ на элитном этаже элитных монстров ОЩУТИМО больше, чем на обычном (замер до правки: ноль комнат с элитой)', () => {
    const SEEDS = 12;
    const el = elites('crypt-elite', SEEDS);
    const plain = elites('crypt-halls', SEEDS);
    console.log('Ф2 ЭЛИТА НА ЭТАЖЕ (12 сидов)');
    console.log(`  crypt-elite: монстров ${el.total}, элитных ${el.elite} (уникальных ${el.unique}) — ${(el.elite / Math.max(1, el.total) * 100).toFixed(1)} %`);
    console.log(`  crypt-halls: монстров ${plain.total}, элитных ${plain.elite} (уникальных ${plain.unique}) — ${(plain.elite / Math.max(1, plain.total) * 100).toFixed(1)} %`);

    expect(el.unique, 'на элитном этаже элита есть вовсе (до Ф2 было 0)').toBeGreaterThan(0);
    const shareEl = el.elite / Math.max(1, el.total);
    const sharePlain = plain.elite / Math.max(1, plain.total);
    expect(shareEl, 'доля элиты на элитном этаже выше, чем на обычном').toBeGreaterThan(sharePlain);
    // «Несколько штук» — но не каждый второй: этаж остаётся проходимым.
    expect(el.unique / SEEDS, 'уникальных на этаж — несколько').toBeGreaterThanOrEqual(2);
    expect(shareEl, 'и элита не заменяет собой весь этаж').toBeLessThan(0.5);
  });

  /**
   * ⚠ ЗАМЕР, КОТОРЫЙ ПРИШЛОСЬ УЧЕСТЬ: уникальные монстры бывают и БЕЗ комнат с элитой — их форсит комната типа
   * `boss`, которую генератор ставит и на обычном этаже (замер: ~3.8 уникальных на обычный этаж крипты против
   * ~12.5 на элитный). Поэтому «сторож сторожа» сравнивает ЧИСЛО, а не наличие: снятие `uniqueRooms` обязано
   * ощутимо срезать элиту, а не обнулить её.
   */
  it('⭐ сторож сторожа: убери комнаты с элитой — и элиты станет заметно меньше', () => {
    const r2 = new ConfigRegistry();
    r2.loadAll();
    r2.reload({ floors: r2.get('floors').map((f) => (f.id === 'crypt-elite' ? { ...f, features: { ...f.features, uniqueRooms: 0 } } : f)) });
    const spec = resolveFloorSpec(crypt, r2.get('floors').find((f) => f.id === 'crypt-elite')! as Floor, 7, 4242, []);
    const layout = generateFloor(spec);
    const rng = createRng(4242);
    const mons = spawnPacksEl(r2, layout, 7, 'normal', rng, crypt.monsterPool, 1, 'crypt-elite');
    const without = mons.filter((s) => (s.def as { rarity?: string }).rarity === 'unique').length;
    const withRooms = rarities('crypt-elite', 4242)['unique'] ?? 0;
    console.log(`Ф2 СТОРОЖ СТОРОЖА (сид 4242): с комнатами элиты ${withRooms} уникальных, без них ${without}`);
    expect(withRooms, 'комнаты с элитой дают больше уникальных, чем их отсутствие').toBeGreaterThan(without);
  });
});
