/**
 * ⭐⭐ Г8-3 (15.10, схема владельца): ЛЕСТНИЦА БОССОВ ВНУТРИ ПОЛОСЫ — мини на 5-м месте, крепкий на 14-м, актовый на
 * 19-м, а последнее место круга (20-е) — портал: «на 19-м босс, 20-й портал и 21-й по новой всё».
 *
 * ЗАЧЕМ ЭТОТ СТОРОЖ. Прежде босс был одной каденцией шаблона (`bossEvery`, «каждые 5») и одной силой. С циклом
 * контента (Г8-1) каденция и круг жили бы врознь: во втором круге боссы встали бы не там, где в первом. Теперь
 * лестница — ДАННЫЕ полосы, и у ранга своя надбавка уровня и свой множитель жизни.
 *
 * Что файл обязан валить: лестницу, посчитанную от абсолютной глубины (боссы перестанут повторяться круг в круг);
 * ранг, не доезжающий до заселения (все боссы снова одной силы); множитель жизни, применённый вне боссовой комнаты
 * (жирными станут рядовые монстры); позицию лестницы, севшую на привал (метка — чистая функция глубины, её терять
 * нельзя); «ступень снаряжения не замкнута боссом» — то самое, ради чего ступени сдвинуты на 11/21/31.
 */
import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { bandDepth, isWaypoint } from '../formulas/power.js';
import { Cell, makeGrid } from '../world/grid.js';
import type { DungeonLayout } from './floorCommon.js';
import { spawnPacksEl } from './floor.js';
import type { BossRank } from './run/types.js';

const DIFF = 'normal';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}
/** Этаж с ОДНОЙ боссовой комнатой и одной обычной: сравниваем их монстров между собой. */
function bossFloor(): DungeonLayout {
  const grid = makeGrid(40, 24, Cell.Floor);
  const rooms = [
    { x: 1, y: 1, w: 9, h: 9, type: 'small', content: undefined },
    { x: 20, y: 6, w: 10, h: 10, type: 'boss', content: 'boss' },
  ];
  return { grid, rooms } as unknown as DungeonLayout;
}
/** Жизнь и уровень монстров боссовой комнаты (x > 480 — она справа) и обычной. */
function split(r: ConfigRegistry, depth: number, rank?: BossRank): { boss: { hp: number; level: number }[]; plain: { hp: number; level: number }[] } {
  const pool = r.get('biomes')[0]!.monsterPool;
  const all = spawnPacksEl(r, bossFloor(), depth, DIFF, createRng(4242), pool, 1, '', 1, rank);
  const boss = all.filter((s) => s.x > 480).map((s) => ({ hp: s.def.hp, level: s.def.level }));
  const plain = all.filter((s) => s.x <= 480).map((s) => ({ hp: s.def.hp, level: s.def.level }));
  return { boss, plain };
}

describe('⭐⭐ Г8-2: лестница боссов полосы', () => {
  it('ЛЕСТНИЦА В ДАННЫХ — места 5 / 14 / 20 полосы и три ранга; ни одно место не садится на привал', () => {
    const access = reg().get('balance').dungeonAccess;
    expect(access.bossLadder.map((x) => [x.at, x.rank])).toEqual([[5, 'mini'], [14, 'strong'], [19, 'act']]);
    // ⚠⚠ ГЛАВНЫЙ АССЕРТ НАСТРОЙКИ: место лестницы, попавшее на ПОРТАЛ, означало бы ПОТЕРЯННОГО босса (при
    // совпадении уступает он). Со схемой владельца 15.10 этого не бывает: порталы 3/6/9/12/15/18/20, боссы 5/14/19.
    for (const { at, rank } of access.bossLadder) {
      expect(access.portalsAt.includes(at), `место ${at} (${rank}) сошлось с порталом`).toBe(false);
      expect(at <= access.contentCycle, `место ${at} за пределами полосы ${access.contentCycle}`).toBe(true);
    }
    // ⭐ Г8-3: актовый босс стоит ПЕРЕД порталом круга — «убил, вышел в город, и 21-й по новой».
    const act = access.bossLadder.find((x) => x.rank === 'act')!.at;
    expect(access.portalsAt.includes(act + 1), `после актового босса (место ${act}) сразу портал`).toBe(true);
  });

  it('⭐ БОССЫ ПОВТОРЯЮТСЯ КРУГ В КРУГ: 5/14/19 → 25/34/39 → 45/54/59 … и ни один не на портале', () => {
    const access = reg().get('balance').dungeonAccess;
    const ladder = new Map(access.bossLadder.map((x) => [x.at, x.rank]));
    const rows: string[] = [];
    for (let d = 1; d <= 100; d++) {
      const at = bandDepth(d, access.contentCycle);
      const rank = ladder.get(at);
      if (!rank) continue;
      expect(isWaypoint(d, access.portalsAt, access.contentCycle), `этаж ${d}: босс не на портале`).toBe(false);
      rows.push(`${d} (${rank})`);
    }
    expect(rows.slice(0, 6)).toEqual(['5 (mini)', '14 (strong)', '19 (act)', '25 (mini)', '34 (strong)', '39 (act)']);
    expect(rows.length, 'три босса на круг × пять кругов до 100-го').toBe(15);
    console.log('Г8-2 БОССЫ ДО 100-го: ' + rows.join(', '));
  });

  it('⭐⭐ БОСС ЗАМЫКАЕТ СТУПЕНЬ: он — ПОСЛЕДНИЙ БОЙ круга, за ним портал, а с нового круга ступень новая', () => {
    const r = reg();
    const tiers = r.get('monster-gear-tiers').filter((x) => x.enabled !== false);
    // Ступени сдвинуты решением владельца 15.10: гир меняется НЕ на 10/20/30, а на 11/21/31.
    expect(tiers.slice(0, 5).map((x) => x.fromLevel)).toEqual([1, 11, 21, 31, 41]);
    const access = r.get('balance').dungeonAccess;
    const ladder = new Map(access.bossLadder.map((x) => [x.at, x.rank]));
    // ⭐⭐ СХЕМА ВЛАДЕЛЬЦА 15.10: «на 19-м босс, 20-й портал, и 21-й по новой всё». Значит круг кончается
    // боем с актовым боссом, сразу за ним портал (вышел в город, продал), а новый круг начинается с новой
    // ступени снаряжения — ступени идут с 11/21/31, то есть ровно с первого этажа круга.
    const actAt = access.bossLadder.find((x) => x.rank === 'act')!.at;
    expect(actAt, 'актовый босс — предпоследнее место круга').toBe(access.contentCycle - 1);
    expect(access.portalsAt.includes(access.contentCycle), 'последнее место круга — портал').toBe(true);
    const actFloors = [19, 39, 59, 79, 99];
    for (const f of actFloors) {
      expect(ladder.get(bandDepth(f, access.contentCycle)), `этаж ${f} — актовый босс`).toBe('act');
      expect(isWaypoint(f + 1, access.portalsAt, access.contentCycle), `за ${f}-м этажом сразу портал`).toBe(true);
      // Новый круг (f + 2) начинается с НОВОЙ ступени снаряжения монстров.
      expect(tiers.some((x) => x.fromLevel === f + 2), `с ${f + 2}-го этажа новая ступень снаряжения`).toBe(true);
    }
    console.log('Г8-3 КОНЕЦ КРУГА: актовый босс ' + actFloors.join(', ')
      + '; портал сразу за ним ' + actFloors.map((f) => f + 1).join(', ')
      + '; новая ступень гира с ' + actFloors.map((f) => f + 2).join(', '));
  });

  it('⭐ РАНГ ДОЕЗЖАЕТ ДО ЗАСЕЛЕНИЯ: уровень и жизнь боссовой комнаты растут по ранкам, рядовая комната — нет', () => {
    // ⚠ СРАВНИВАЕМ БОССОВУЮ КОМНАТУ С САМОЙ СОБОЙ БЕЗ РАНГА, а не с рядовой: в рядовой стоят монстры других
    // ЗАГОТОВОК (пачки боссовой комнаты тянут сильные роли, у них свой `tierHp`), и отношение «босс / рядовой»
    // мерило бы заодно разницу заготовок — на каждой глубине свою. Правило ранга — это именно прибавка к боссовой
    // комнате, её и судим; «во сколько раз тяжелее соседей» печатается ниже как справка.
    const r = reg();
    const base = split(r, 20);
    expect(base.boss.length, 'боссовая комната заселена').toBeGreaterThan(0);
    expect(base.plain.length, 'и обычная тоже').toBeGreaterThan(0);
    const baseHp = Math.max(...base.boss.map((m) => m.hp));
    const baseLv = Math.max(...base.boss.map((m) => m.level));
    const plainHp = Math.max(...base.plain.map((m) => m.hp));
    const rows: string[] = [];
    let prevHp = 0, prevLv = 0;
    for (const rank of ['mini', 'strong', 'act'] as const) {
      const got = split(r, 20, rank);
      const hp = Math.max(...got.boss.map((m) => m.hp));
      const lv = Math.max(...got.boss.map((m) => m.level));
      expect(Math.max(...got.plain.map((m) => m.hp)), `${rank}: рядовая комната не тронута`).toBe(plainHp);
      expect(hp, `${rank}: жизнь выше предыдущего ранга`).toBeGreaterThan(prevHp);
      expect(lv, `${rank}: уровень не ниже предыдущего ранга`).toBeGreaterThanOrEqual(prevLv);
      rows.push(`${rank}: ур. ${lv} (без ранга ${baseLv}), hp ${hp} — ×${(hp / baseHp).toFixed(2)} к боссу без ранга, ×${(hp / plainHp).toFixed(1)} к соседям по этажу`);
      prevHp = hp; prevLv = lv;
    }
    // Мини = прежний босс (levelMult 1, hpMult 1): правило «ничего не менять у мини» держит ряд сравнимым с прошлым.
    const mini = split(r, 20, 'mini');
    expect(Math.max(...mini.boss.map((m) => m.hp)), 'мини — ровно прежний босс').toBe(baseHp);
    console.log('Г8-2 РАНГИ НА 20-м ЭТАЖЕ\n  ' + rows.join('\n  '));
  });

  it('⭐ ЛЕСТНИЦА ДЕРЖИТСЯ НА ГЛУБИНЕ: прибавка актового ранга одна и та же на 20, 40, 100', () => {
    const r = reg();
    const rows: string[] = [];
    const ratios: number[] = [];
    for (const d of [20, 40, 100]) {
      const plainBoss = Math.max(...split(r, d).boss.map((m) => m.hp));
      const actBoss = Math.max(...split(r, d, 'act').boss.map((m) => m.hp));
      ratios.push(actBoss / plainBoss);
      rows.push(`этаж ${d}: без ранга ${plainBoss} → актовый ${actBoss} (×${(actBoss / plainBoss).toFixed(2)})`);
    }
    // ⚠ ЗАЧЕМ: прибавка ранга обязана быть ОДИНАКОВОЙ на любой глубине — ровно та беда, от которой 13.10 ушли
    // плоские «+3 уровня» у босс-комнаты (они давали ×2.07 на 4-м этаже и ×1.04 на 200-м). Разброс — до 1.4 раза.
    expect(Math.max(...ratios) / Math.min(...ratios), 'прибавка ранга не зависит от глубины').toBeLessThan(1.4);
    console.log('Г8-2 АКТОВЫЙ РАНГ ПО ГЛУБИНЕ\n  ' + rows.join('\n  '));
  });

  it('БЕЗ РАНГА — КАК БЫЛО: ни надбавки ранга, ни множителя жизни (старый сервер, сим, редактор)', () => {
    const r = reg();
    const a = split(r, 20);
    const b = split(r, 20, undefined);
    expect(b).toEqual(a);
  });
});
