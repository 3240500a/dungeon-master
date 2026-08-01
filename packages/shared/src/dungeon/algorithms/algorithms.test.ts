import { describe, it, expect } from 'vitest';
import { generateFloorParams } from '../generateFloor.js';
import { validate, type DungeonLayout } from '../floorCommon.js';
import { Cell } from '../../world/grid.js';
import type { FloorAlgoParams } from '../../config/schemas.js';

const ROOMS: FloorAlgoParams = { algorithm: 'rooms', cols: 56, rows: 42, roomCount: 9, bigChance: 0.3 };
const BSP: FloorAlgoParams = { algorithm: 'bsp', cols: 60, rows: 44, splitDepth: 4, minLeaf: 9, roomPad: 1 };
const CELLULAR: FloorAlgoParams = { algorithm: 'cellular', cols: 64, rows: 48, fillProb: 0.45, steps: 5, born: 5, survive: 4 };
const MAZE: FloorAlgoParams = { algorithm: 'maze', cols: 56, rows: 42, braid: 0.3 };

function floorCount(L: DungeonLayout): number {
  let n = 0;
  for (const row of L.grid) for (const c of row) if (c === Cell.Floor) n++;
  return n;
}

describe.each([
  ['rooms', ROOMS],
  ['bsp', BSP],
  ['cellular', CELLULAR],
  ['maze', MAZE],
] as const)('алгоритм %s — инвариант проходимости', (_name, params) => {
  it('на сотнях сидов: этаж всегда проходим (validate), spawn≠stairs, есть пол', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const L = generateFloorParams(params, seed);
      expect(validate(L), `seed=${seed}`).toBe(true);
      expect(floorCount(L)).toBeGreaterThan(20);
      expect(L.spawn).not.toEqual(L.stairsDown);
      expect(L.rooms.length).toBeGreaterThan(0);
    }
  });

  it('детерминизм: один сид → идентичная сетка', () => {
    const a = generateFloorParams(params, 12345);
    const b = generateFloorParams(params, 12345);
    expect(b.grid).toEqual(a.grid);
    expect(b.spawn).toEqual(a.spawn);
    expect(b.stairsDown).toEqual(a.stairsDown);
  });

  it('разные сиды → разные карты (в основном)', () => {
    const a = generateFloorParams(params, 1);
    const b = generateFloorParams(params, 2);
    expect(JSON.stringify(b.grid)).not.toEqual(JSON.stringify(a.grid));
  });

  it('exits по умолчанию = 1 и совпадает со stairsDown', () => {
    const L = generateFloorParams(params, 77);
    expect(L.exits.length).toBe(1);
    expect(L.exits[0]).toEqual(L.stairsDown);
  });
});

describe('v2.2 — замки, выходы, town', () => {
  it('простой этаж (lock:false) → без дверей у rooms/bsp', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const p of [ROOMS, BSP]) {
        const L = generateFloorParams(p, seed, { lock: false });
        expect(L.doors.length, `${p.algorithm} seed=${seed}`).toBe(0);
        expect(validate(L)).toBe(true);
      }
    }
  });

  it('boss-этаж (lock:true) у rooms/bsp обычно ставит замок', () => {
    let locked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      if (generateFloorParams(ROOMS, seed, { lock: true }).doors.length > 0) locked++;
    }
    expect(locked).toBeGreaterThan(30); // подавляющее большинство сидов запираются (фолбэк редок)
  });

  it('несколько выходов: exitCount=3 → 3 различных достижимых выхода', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const L = generateFloorParams(ROOMS, seed, { exitCount: 3, lock: false });
      expect(L.exits.length, `seed=${seed}`).toBe(3);
      const keys = new Set(L.exits.map((e) => `${e.x},${e.y}`));
      expect(keys.size).toBe(3); // различны
      expect(validate(L)).toBe(true); // все достижимы (validate проверяет каждый exit)
    }
  });

  it('терминальный этаж (0 выходов = финал) → портал возврата в город', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const L = generateFloorParams(ROOMS, seed, { exitCount: 0, lock: false });
      expect(L.exits.length).toBe(0);
      expect(L.decor.some((d) => d.kind === 'portal'), `seed=${seed}`).toBe(true);
      expect(validate(L)).toBe(true);
    }
  });

  it('town-этаж компактный: 1 вход + N выходов, портал+сундук, без промежуточных комнат', () => {
    for (const exitCount of [1, 2, 3]) {
      for (let seed = 1; seed <= 30; seed++) {
        const L = generateFloorParams(ROOMS, seed, { town: true, exitCount });
        expect(L.rooms.length, `n=${exitCount} seed=${seed}`).toBe(1 + exitCount); // вход + по комнате на выход
        expect(L.exits.length).toBe(exitCount);
        expect(L.decor.some((d) => d.kind === 'portal')).toBe(true);
        expect(L.decor.some((d) => d.kind === 'stash')).toBe(true);
        expect(L.doors.length).toBe(0);
        expect(validate(L)).toBe(true);
      }
    }
  });
});
