import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { FloorAlgoParams } from '../config/schemas.js';
import { createRng, type Rng } from '../formulas/rng.js';
import { Cell, TILE, worldToCell } from '../world/grid.js';
import { MONSTER_RADIUS_UNIQUE, PLAYER_RADIUS } from '../world/state.js';
import { buildNavMask, NAV_CELL, NAV_DOWN, NAV_RIGHT } from '../world/pathfind.js';
import { corridorWidths, validate, type DungeonLayout } from './floorCommon.js';
import { generateFloorParams } from './generateFloor.js';
import { generateFloorFor } from './floorInputs.js';
import { resolveFloorSpec } from './floorSpec.js';
import { roomDoorways } from './slots.js';

/**
 * ⭐ 13.10 (владелец: «давай сделаем коридоры шириной от 2 до 4 клеток, чтобы были разные варианты»): ШИРИНА КОРИДОРОВ «ОТ … ДО» —
 * `corridorWidth` / `corridorWidthMax` параметров алгоритма (rooms, bsp), ширина на КАЖДУЮ связку комнат из своего потока rng этажа:
 *  • без «до» (или «до» = «от») — одна ширина, поток не тронут, этаж байт-в-байт прежний (и сторож-снимок `slots.test.ts` / `decorPassport.test.ts`
 *    на замороженных входах без поля);
 *  • с ним — проёмы связок всех ширин диапазона, комнаты (их броски — до связок) те же, `validate()` держит;
 *  • данные: крипта 2…4, прочие биомы — без диапазона;
 *  • узкий коридор не запирает: на живых этажах крипты (декор, оформление, слоты) выходы, рычаги и сундуки достижимы от спавна радиусом героя
 *    и радиусом уника (самый широкий монстр), двери открыты / закрыты.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const BSP: FloorAlgoParams = { algorithm: 'bsp', cols: 56, rows: 42, splitDepth: 4, minLeaf: 9, roomPad: 1, loops: 0.45, spawnMode: 'farthest', shapes: { rect: 4, ell: 2, blob: 2, round: 2, hall: 2 }, prefabChance: 0, largeRoomArea: 80 };
const ROOMS: FloorAlgoParams = { algorithm: 'rooms', cols: 56, rows: 42, roomCount: 9, bigChance: 0.3, loops: 0.5, spawnMode: 'farthest', shapes: { rect: 4, ell: 2, blob: 2, round: 2, hall: 2 }, prefabChance: 0, largeRoomArea: 80 };

/** Сколько раз дёрнули `int` у потока. */
function spy(seed = 7): { rng: Rng; calls: () => number } {
  let n = 0;
  const r = createRng(seed);
  return { rng: { ...r, int: (a: number, b: number): number => { n++; return r.int(a, b); } }, calls: () => n };
}

describe('⭐ 13.10: ширина коридоров «от … до» (`corridorWidth` / `corridorWidthMax`)', () => {
  it('`corridorWidths`: без «до» и при «до» = «от» — одна ширина, поток не тронут; «до» меньше — границы местами; иначе — каждая ширина диапазона', () => {
    for (const [p, want] of [[{}, 4], [{ corridorWidth: 3 }, 3], [{ corridorWidth: 2, corridorWidthMax: 2 }, 2], [{ corridorWidthMax: 4 }, 4]] as const) {
      const s = spy(), w = corridorWidths(p, s.rng);
      expect([w(), w(), w()]).toEqual([want, want, want]);
      expect(s.calls(), JSON.stringify(p)).toBe(0);
    }
    const s = spy(), w = corridorWidths({ corridorWidth: 2, corridorWidthMax: 4 }, s.rng);
    const got = Array.from({ length: 300 }, w);
    expect(s.calls()).toBe(300);
    expect([...new Set(got)].sort()).toEqual([2, 3, 4]);
    for (const k of [2, 3, 4]) expect(got.filter((x) => x === k).length, `ширина ${k}`).toBeGreaterThan(70);
    const back = corridorWidths({ corridorWidth: 4, corridorWidthMax: 2 }, createRng(9));
    expect([...new Set(Array.from({ length: 100 }, back))].sort()).toEqual([2, 3, 4]);
    // без потока (алгоритм позван напрямую) — свой поток от констант: детерминированно
    const a = corridorWidths({ corridorWidth: 2, corridorWidthMax: 4 }), b = corridorWidths({ corridorWidth: 2, corridorWidthMax: 4 });
    expect(Array.from({ length: 20 }, a)).toEqual(Array.from({ length: 20 }, b));
  });

  it('без диапазона — этаж байт-в-байт тот же: «до» = «от» (и пусто, и 4) даёт ровно этаж без поля (rooms и bsp × 30 сидов)', () => {
    for (const base of [BSP, ROOMS]) for (let seed = 1; seed <= 30; seed++) {
      const plain = JSON.stringify(generateFloorParams(base, seed * 7919 + 13));
      expect(JSON.stringify(generateFloorParams({ ...base, corridorWidthMax: 4 }, seed * 7919 + 13))).toBe(plain);
      expect(JSON.stringify(generateFloorParams({ ...base, corridorWidth: 3, corridorWidthMax: 3 }, seed * 7919 + 13)))
        .toBe(JSON.stringify(generateFloorParams({ ...base, corridorWidth: 3 }, seed * 7919 + 13)));
    }
  });

  it('2…4: проёмы связок — все три ширины; комнаты — те же, что при одной ширине (свой поток: броски комнат не сдвинуты); validate()', () => {
    const widths = new Map<number, number>();
    let same = 0, n = 0;
    for (const base of [BSP, ROOMS]) for (let seed = 1; seed <= 40; seed++) {
      const L = generateFloorParams({ ...base, corridorWidth: 2, corridorWidthMax: 4 }, seed * 7919 + 13);
      const L4 = generateFloorParams(base, seed * 7919 + 13);
      expect(validate(L)).toBe(true);
      for (const d of roomDoorways(L)) widths.set(d.width, (widths.get(d.width) ?? 0) + 1);
      n++;
      if (JSON.stringify(L.rooms) === JSON.stringify(L4.rooms)) same++;
    }
    for (const w of [2, 3, 4]) expect(widths.get(w) ?? 0, `проёмов ширины ${w}`).toBeGreaterThan(100);
    // комнаты расходятся только там, где одна из версий взяла другую попытку `validate` (замок рычага) — редкость
    expect(same / n).toBeGreaterThan(0.9);
  });

  it('данные: этажи крипты — коридоры 2…4; прочие биомы — без диапазона', () => {
    for (const f of reg.get('floors')) {
      const p = f.algoParams as { corridorWidth?: number; corridorWidthMax?: number };
      if (f.biomeId === 'crypt') expect([p.corridorWidth, p.corridorWidthMax], f.id).toEqual([2, 4]);
      else expect(p.corridorWidthMax, f.id).toBeUndefined();
    }
  });

  it('узкий коридор не запирает: живая крипта — выходы, рычаги, сундуки достижимы от спавна радиусом героя и уника (двери открыты / закрыты)', () => {
    const b = reg.get('biomes').find((x) => x.id === 'crypt')!;
    const reach = (L: DungeonLayout, obstacles: Parameters<typeof buildNavMask>[2], pad: number, open: boolean): Uint8Array => {
      const rows = L.grid.length, cols = L.grid[0]!.length;
      const bits = buildNavMask(cols, rows, obstacles, pad)?.bits ?? new Uint8Array(cols * rows);
      const walk = (i: number): boolean => { const c = L.grid[(i / cols) | 0]![i % cols]; return (c === Cell.Floor || (open && c === Cell.Door)) && !(bits[i]! & NAV_CELL); };
      const seen = new Uint8Array(cols * rows);
      const s = worldToCell(L.spawn.x, L.spawn.y), start = s.cy * cols + s.cx;
      if (!walk(start)) return seen;
      const q = [start]; seen[start] = 1;
      while (q.length) {
        const i = q.pop()!, x = i % cols, y = (i / cols) | 0;
        const go = (j: number, edge: boolean): void => { if (edge && !seen[j] && walk(j)) { seen[j] = 1; q.push(j); } };
        if (x + 1 < cols) go(i + 1, !(bits[i]! & NAV_RIGHT));
        if (x > 0) go(i - 1, !(bits[i - 1]! & NAV_RIGHT));
        if (y + 1 < rows) go(i + cols, !(bits[i]! & NAV_DOWN));
        if (y > 0) go(i - cols, !(bits[i - cols]! & NAV_DOWN));
      }
      return seen;
    };
    let floors = 0, narrow = 0;
    // ⚠ Г8-5: число случаев считается ОТ ДАННЫХ, а не зашито числом. Крипта получила «Нижние ярусы», и выборка
    // выросла со 100 до 120 — правило при этом не менялось. Магическое число здесь значило бы, что каждый новый
    // этаж крипты валит сторож, не найдя ни одной настоящей ошибки.
    const SEEDS = 20;
    const sample = reg.get('floors').filter((x) => x.biomeId === 'crypt' && x.role !== 'rest');
    for (const f of sample) for (let seed = 1; seed <= SEEDS; seed++) {
      const { layout: L, obstacles } = generateFloorFor(reg, resolveFloorSpec(b, f, f.minDepth, seed * 7919 + 13, [], { exitCount: 1 + (seed % 3) }), b);
      const cols = L.grid[0]!.length;
      floors++;
      narrow += roomDoorways(L).filter((d) => d.width === 2).length;
      for (const pad of [PLAYER_RADIUS, MONSTER_RADIUS_UNIQUE]) {
        const open = reach(L, obstacles, pad, true), closed = reach(L, obstacles, pad, false);
        const at = (p: { x: number; y: number }): number => { const c = worldToCell(p.x, p.y); return c.cy * cols + c.cx; };
        for (const p of [...L.exits, ...L.chests]) expect(open[at(p)], `${f.id}/${seed} r ${pad}: ${p.x / TILE},${p.y / TILE}`).toBe(1);
        for (const lv of L.levers) expect(closed[at(lv)], `${f.id}/${seed} r ${pad}: рычаг`).toBe(1);
      }
    }
    expect(floors, 'случаев — все боевые этажи крипты × сиды').toBe(sample.length * SEEDS);
    expect(sample.length, 'и сама выборка не опустела').toBeGreaterThanOrEqual(5);
    expect(narrow / floors, 'проёмов шириной 2 на этаж').toBeGreaterThan(5);
  });
});
