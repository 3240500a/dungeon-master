/**
 * ⭐⭐ Г8-1 (15.10, решение владельца): ЦИКЛ КОНТЕНТА 20 ЭТАЖЕЙ — «весь контент посмотрел, с боссом и монстрами в
 * сильных доспехах, и дальше заново: опять слабые, и к 20-му снова сильные и босс».
 *
 * ЗАЧЕМ ЭТОТ СТОРОЖ. Спуск бесконечен (Г2), а контента настроено на пару десятков этажей: за краем настройки подбор
 * этажа и мешанина монстров ЗАСТЫВАЛИ — на 500-м этаже ровно то же, что на 20-м, и до конца времён. Теперь выбор
 * контента смотрит на МЕСТО В ПОЛОСЕ (`bandDepth`), а сила — по-прежнему на абсолютную глубину.
 *
 * ⚠⚠ ГЛАВНОЕ, ЧТО ЗДЕСЬ СТОРОЖИТСЯ, — РАЗДЕЛЕНИЕ: сцена циклится, СИЛА НЕТ. Утащи кто-нибудь `bandDepth` в
 * `floorChallengeLevel` — и за 20-м этажом игра станет вечным первым кругом: монстры 21-го этажа снова первого
 * уровня. Этот файл обязан валить такую правку.
 *
 * ⚠ ПОЧЕМУ МЕРЯЮТСЯ ВЕСА, А НЕ СОСТАВ ЗАСЕЛЁННОГО ЭТАЖА. Состав — это ВЫБОРКА: редкость монстра зависит от
 * АБСОЛЮТНОЙ глубины (`loot.depthRarity` — так и задумано, Г9 про качество), а редкость сдвигает поток `rng` внутри
 * `generateMonster`. Поэтому этажи 5 и 25 дают одинаковые ВЕРОЯТНОСТИ, но не одинаковый список — и ассерт «состав
 * бит в бит» был бы просто неверным. Правило живёт в весах, их и сверяем; заселение проверяется отдельно тем, что
 * этаж не пустеет.
 */
import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { bandDepth, floorMonsterLevel } from '../formulas/power.js';
import { spawnWeightAt } from '../formulas/spawnWeight.js';
import { pickFloorForRole, resolveFloorSpec } from './floorSpec.js';
import { floorChallengeLevel, spawnPacksEl } from './floor.js';
import { Cell, makeGrid } from '../world/grid.js';
import type { DungeonLayout } from './floorCommon.js';

const DIFF = 'normal';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}
function hall(): DungeonLayout {
  const grid = makeGrid(44, 24, Cell.Floor);
  const rooms = [
    { x: 1, y: 1, w: 8, h: 8, type: 'small', content: undefined },
    { x: 11, y: 1, w: 8, h: 8, type: 'small', content: undefined },
    { x: 21, y: 1, w: 10, h: 10, type: 'large', content: undefined },
    { x: 1, y: 12, w: 8, h: 8, type: 'small', content: undefined },
  ];
  return { grid, rooms } as unknown as DungeonLayout;
}

/**
 * ВЕС СПАВНА каждого монстра пула на этом этаже — то самое правило, которое циклится. Берём через ту же чистую
 * функцию, что и заселение (`spawnWeightAt`), но с местом в полосе: так сверяется ПРАВИЛО, а не выборка.
 */
function weights(r: ConfigRegistry, depth: number): Record<string, number> {
  const cycle = r.get('balance').dungeonAccess.contentCycle;
  const tiers = r.get('depth-tiers');
  const pool = new Set(r.get('biomes')[0]!.monsterPool);
  const out: Record<string, number> = {};
  for (const m of r.get('monsters')) {
    if (!pool.has(m.id) || m.enabled === false) continue;
    out[m.id] = +spawnWeightAt(m, tiers, bandDepth(depth, cycle)).toFixed(6);
  }
  return out;
}
/** Сколько монстров встало на этаже (заселение не должно пустеть ни на каком круге). */
function spawned(r: ConfigRegistry, depth: number): number {
  return spawnPacksEl(r, hall(), depth, DIFF, createRng(777), r.get('biomes')[0]!.monsterPool, 1, '').length;
}

describe('⭐⭐ Г8-1: цикл контента 20 этажей', () => {
  it('ПОЛОСА: 1→1, 20→20, 21→1, 40→20, 501→1; цикл 0/1 — глубина как есть', () => {
    const c = reg().get('balance').dungeonAccess.contentCycle;
    expect(c, 'штатная длина цикла — 20 этажей').toBe(20);
    expect([1, 5, 20, 21, 25, 40, 41, 501].map((d) => bandDepth(d, c))).toEqual([1, 5, 20, 1, 5, 20, 1, 1]);
    for (const off of [0, 1]) expect([1, 23, 500].map((d) => bandDepth(d, off))).toEqual([1, 23, 500]);
    expect([bandDepth(Number.NaN, c), bandDepth(0, c), bandDepth(-7, c), bandDepth(1.9, c)], 'мусор — как первый этаж').toEqual([1, 1, 1, 1]);
  });

  it('⚠⚠ СЦЕНА ЦИКЛИТСЯ, СИЛА НЕТ: уровень монстров растёт и за краем цикла, монотонно', () => {
    const r = reg();
    const diff = r.get('difficulties').find((d) => d.id === DIFF)!;
    const lv = [1, 20, 21, 40, 41, 200].map((d) => floorChallengeLevel(r, DIFF, d));
    expect(lv, 'уровень = номер этажа, цикл его не трогает').toEqual([1, 20, 21, 40, 41, 200]);
    for (const d of [21, 40, 200]) expect(floorChallengeLevel(r, DIFF, d)).toBe(floorMonsterLevel(diff, d));
    console.log('Г8 УРОВЕНЬ ПО АБСОЛЮТНОЙ ГЛУБИНЕ: ' + [1, 20, 21, 40, 41, 200].map((d, i) => `этаж ${d} → ур. ${lv[i]}`).join(', '));
  });

  it('ВЕСА СПАВНА ПОВТОРЯЮТСЯ КРУГ В КРУГ: этаж 21 = этаж 1, 25 = 5, 40 = 20; внутри полосы — меняются', () => {
    const r = reg();
    for (const [a, b] of [[1, 21], [5, 25], [11, 31], [20, 40], [7, 1007]] as const) {
      expect(weights(r, b), `веса этажей ${a} и ${b}`).toEqual(weights(r, a));
    }
    expect(weights(r, 20)).not.toEqual(weights(r, 1));
    expect(weights(r, 11)).not.toEqual(weights(r, 5));
  });

  it('ЗАСЕЛЕНИЕ НЕ ПУСТЕЕТ НИ НА КАКОМ КРУГЕ (и на 500-м этаже тоже)', () => {
    const r = reg();
    const rows = [1, 20, 21, 40, 101, 500].map((d) => `этаж ${d}: монстров ${spawned(r, d)}`);
    for (const d of [1, 20, 21, 40, 101, 500]) expect(spawned(r, d), `этаж ${d} заселён`).toBeGreaterThan(3);
    console.log('Г8 ЗАСЕЛЕНИЕ ПО КРУГАМ\n' + rows.join('\n'));
  });

  it('ВЕСЬ НАСТРОЕННЫЙ РЯД ТИРОВ ДОСТИЖИМ: каждый тир глубины попадает хотя бы на один этаж полосы', () => {
    const r = reg();
    const tiers = r.get('depth-tiers');
    const c = r.get('balance').dungeonAccess.contentCycle;
    const covered = new Set<string>();
    for (let d = 1; d <= c; d++) {
      const t = tiers.find((x) => d >= x.fromFloor && d <= x.toFloor);
      if (t) covered.add(t.id);
    }
    expect([...covered].sort(), 'ни один тир не остался мёртвым за краем полосы').toEqual(tiers.map((t) => t.id).sort());
    console.log('Г8 ТИРЫ ГЛУБИНЫ В ПОЛОСЕ: ' + tiers.map((t) => `${t.id} ${t.fromFloor}..${t.toFloor}`).join(', '));
  });

  it('ВЫБОР ЭТАЖА ПО РОЛИ И ТАЙЛСЕТ ПОВТОРЯЮТСЯ КРУГ В КРУГ (при одном сиде выбора)', () => {
    // ⚠ РОЛЬ слоя (бой/элита/привал/босс) — своя у каждой АБСОЛЮТНОЙ глубины (её решает поток `layerSeed`, Г2), и
    // циклить её нельзя: иначе 21-й этаж повторял бы первый круг ещё и порядком узлов. Циклится ОКНО ДОСТУПНОСТИ
    // этажей и вариант тайлсета — их и сверяем, на фиксированном сиде выбора.
    const r = reg();
    const cycle = r.get('balance').dungeonAccess.contentCycle;
    const biome = r.get('biomes')[0]!;
    const floors = r.get('floors');
    const pick = (role: 'combat' | 'elite' | 'rest' | 'boss' | 'treasure', d: number): string | undefined =>
      pickFloorForRole(role, biome.id, floors, bandDepth(d, cycle), 999331)?.id;
    const tiles = (d: number): string => resolveFloorSpec(biome, undefined, bandDepth(d, cycle), 7).tileset;
    for (const [a, b] of [[2, 22], [8, 28], [13, 33], [20, 40], [4, 1004]] as const) {
      for (const role of ['combat', 'elite', 'rest', 'boss', 'treasure'] as const) {
        expect(pick(role, b), `этаж роли «${role}» на ${a} и ${b}`).toBe(pick(role, a));
      }
      expect(tiles(b), `тайлсет на ${a} и ${b}`).toBe(tiles(a));
    }
  });

  it('⭐⭐ Ф2: ЗА КРАЕМ НАСТРОЙКИ СМЕСЬ НЕ ЗАСТЫВАЕТ — место круга ведёт её и на 21..40', () => {
    // ⚠ ЧТО ИМЕННО ДАЁТ ЦИКЛ ПОСЛЕ Ф2. Прежде окна глубины были узкими (`crypt-halls` 1..5, `crypt-catacombs`
    // 5..15), за 15-м этажом окно пустело, и подбор до конца времён брал ОДНИ И ТЕ ЖЕ катакомбы — цикл возвращал
    // чередование самим фактом. С Ф2 окна открыты настежь, и застыть подбор уже не может; зато от цикла зависит
    // СМЕСЬ: вес едет по месту круга, и на 21-м (место 1) обязан побеждать мелкий этаж, а на 40-м (место 20) —
    // крупный. Без цикла (`c = 0`) вес вырождается в `first` — смесь одинакова на любой глубине, и крупные этажи
    // своей очереди не получают никогда. Это и меряем.
    const r = reg();
    const cycle = r.get('balance').dungeonAccess.contentCycle;
    const biome = r.get('biomes').find((b) => b.id === 'crypt')!;
    const floors = r.get('floors');
    const mix = (d: number, c: number): Record<string, number> => {
      const place = bandDepth(d, c);
      const out: Record<string, number> = {};
      for (let seed = 1; seed <= 300; seed++) {
        const f = pickFloorForRole('combat', biome.id, floors, place, seed * 7919, { place, cycle: c });
        if (f) out[f.id] = (out[f.id] ?? 0) + 1;
      }
      return out;
    };
    const at21 = mix(21, cycle), at40 = mix(40, cycle);
    const froz21 = mix(21, 0), froz40 = mix(40, 0);
    const small = 'crypt-halls', big = 'crypt-depths';
    expect((at21[small] ?? 0) > (at21[big] ?? 0), 'этаж 21 (место 1): мелкий чаще крупного').toBe(true);
    expect((at40[big] ?? 0) > (at40[small] ?? 0), 'этаж 40 (место 20): крупный чаще мелкого').toBe(true);
    // Без цикла смесь застыла: 21-й и 40-й дают одно и то же распределение.
    expect(froz21, 'без цикла — одна и та же смесь на любой глубине').toEqual(froz40);
    console.log(`Ф2 СМЕСЬ ЗА КРАЕМ: этаж 21 — ${small} ${at21[small] ?? 0} / ${big} ${at21[big] ?? 0}; `
      + `этаж 40 — ${small} ${at40[small] ?? 0} / ${big} ${at40[big] ?? 0}; без цикла одинаково`);
  });

  it('ВЫКЛЮЧАЕТСЯ ОДНИМ ЧИСЛОМ: `contentCycle: 0` — поведение до Г8 (за краем настройки состав застывает)', () => {
    const r = reg();
    r.reload({ balance: { ...r.get('balance'), dungeonAccess: { ...r.get('balance').dungeonAccess, contentCycle: 0 } } });
    expect(weights(r, 21), 'без цикла 21-й этаж — «за краем», а не первый круг').not.toEqual(weights(r, 1));
    expect(weights(r, 500), 'и 500-й — то же застывшее дно, что 20-й').toEqual(weights(r, 20));
  });
});
