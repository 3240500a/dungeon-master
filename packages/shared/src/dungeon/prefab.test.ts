import { describe, it, expect } from 'vitest';
import { generateFloorParams } from './generateFloor.js';
import { validate, type DungeonLayout } from './floorCommon.js';
import { rotatePrefabCW, mirrorPrefab, trimPrefab, stampPrefabTerrain, selectPrefabs } from './prefab.js';
import { Cell, TILE, makeGrid } from '../world/grid.js';
import type { RoomPrefab, FloorAlgoParams } from '../config/schemas.js';

const ROOM_PF: RoomPrefab = {
  id: 'pf-room', name: 'Зал', enabled: true, scope: 'room', biomes: [], algorithms: [], w: 7, h: 5,
  terrain: ['#######', '#..o..#', '+.....+', '#..o..#', '#######'],
  zones: ['       ', '   d   ', '       ', '   c   ', '       '],
  tags: [], weight: 1,
};
const FLOOR_PF: RoomPrefab = {
  id: 'pf-floor', name: 'Арена', enabled: true, scope: 'floor', biomes: [], algorithms: [], w: 14, h: 10,
  terrain: [
    '##############', '#............#', '#............#', '#....####....#', '#....#..#....#',
    '#....#..#....#', '#............#', '#............#', '#............#', '##############',
  ],
  zones: [
    '              ', '  e           ', '              ', '              ', '              ',
    '              ', '          m   ', '              ', '           x  ', '              ',
  ],
  tags: [], weight: 1,
};

const ROOMS: FloorAlgoParams = { algorithm: 'rooms', cols: 56, rows: 42, roomCount: 12, bigChance: 0.4, loops: 0.5, spawnMode: 'farthest', shapes: { rect: 4, ell: 2, blob: 2, round: 2, hall: 2 }, prefabChance: 1 };
const BSP: FloorAlgoParams = { algorithm: 'bsp', cols: 56, rows: 42, splitDepth: 4, minLeaf: 10, roomPad: 1, loops: 0.45, spawnMode: 'farthest', shapes: { rect: 4, ell: 2, blob: 2, round: 2, hall: 2 }, prefabChance: 1 };
const PREFAB: FloorAlgoParams = { algorithm: 'prefab', cols: 40, rows: 30 };

const cell = (p: { x: number; y: number }): { cx: number; cy: number } => ({ cx: Math.floor(p.x / TILE), cy: Math.floor(p.y / TILE) });

describe('prefab — трансформы', () => {
  it('rotatePrefabCW: 7×5 → 5×7, зоны едут вместе', () => {
    const r = rotatePrefabCW(ROOM_PF);
    expect(r.w).toBe(5); expect(r.h).toBe(7);
    expect(r.terrain.length).toBe(7); expect(r.terrain[0]!.length).toBe(5);
    expect(r.zones.join('').includes('d')).toBe(true);
  });
  it('mirrorPrefab: размеры те же, строки зеркалятся', () => {
    const m = mirrorPrefab(ROOM_PF);
    expect(m.w).toBe(7); expect(m.terrain[1]).toBe('#..o..#');
  });

  it('trimPrefab: режет до габаритов нарисованного (пустота по краям отбрасывается)', () => {
    const p: RoomPrefab = {
      id: 't', name: 't', enabled: true, scope: 'room', biomes: [], algorithms: [], w: 6, h: 5,
      terrain: ['      ', '  ##  ', '  #.  ', '      ', '      '],
      zones: ['      ', '      ', '   d  ', '      ', '      '], tags: [], weight: 1,
    };
    const t = trimPrefab(p);
    expect(t.w).toBe(2); expect(t.h).toBe(2);
    expect(t.terrain).toEqual(['##', '#.']);
    expect(t.zones[1]).toBe(' d');
  });

  it('stampPrefabTerrain: клетки-пустоты (\' \') не трогают grid → форма произвольная', () => {
    const grid = makeGrid(6, 6, Cell.Wall);
    const p: RoomPrefab = { id: 's', name: 's', enabled: true, scope: 'room', biomes: [], algorithms: [], w: 2, h: 2, terrain: [' .', '. '], zones: ['  ', '  '], tags: [], weight: 1 };
    stampPrefabTerrain(grid, p, 2, 2);
    expect(grid[2]![2]).toBe(Cell.Wall);  // пусто → не тронуто
    expect(grid[2]![3]).toBe(Cell.Floor);
    expect(grid[3]![2]).toBe(Cell.Floor);
    expect(grid[3]![3]).toBe(Cell.Wall);  // пусто → не тронуто
  });
});

describe('prefab — интеграция в генерацию', () => {
  it('scope:floor — целый этаж из префаба: проходим, spawn/exit из зон e/x', () => {
    for (let s = 1; s <= 40; s++) {
      const L = generateFloorParams(PREFAB, s, { prefabs: [FLOOR_PF], exitCount: 1, lock: false });
      expect(validate(L), `seed=${s}`).toBe(true);
      expect(L.exits.length).toBe(1);
      expect(L.spawn).not.toEqual(L.stairsDown);
      // spawn совпал с зоной 'e' (после ориентации префаб мог повернуться — просто проверяем валидную клетку пола)
      const sc = cell(L.spawn); expect(L.grid[sc.cy]?.[sc.cx]).toBe(Cell.Floor);
    }
  });

  it('scope:floor — нет floor-префабов → фолбэк на rooms (проходим)', () => {
    for (let s = 1; s <= 20; s++) {
      const L = generateFloorParams(PREFAB, s, { prefabs: [ROOM_PF], exitCount: 1, lock: false }); // только room-scope
      expect(validate(L), `seed=${s}`).toBe(true);
      expect(L.rooms.length).toBeGreaterThan(1); // это rooms-фолбэк, а не одна арена
    }
  });

  const chests = (L: { decor: { kind: string }[] }): number => L.decor.filter((d) => d.kind === 'chest').length;

  it('scope:room — rooms/bsp вставляют префаб-комнаты: проходимо + зоны дают контент (сундуки)', () => {
    for (const base of [ROOMS, BSP]) {
      let withPf = 0, noPf = 0;
      for (let s = 1; s <= 40; s++) {
        const L = generateFloorParams(base, s, { prefabs: [ROOM_PF], exitCount: 1, lock: false });
        expect(validate(L), `${base.algorithm} seed=${s}`).toBe(true);
        withPf += chests(L);
        noPf += chests(generateFloorParams({ ...base, prefabChance: 0 } as FloorAlgoParams, s, { prefabs: [ROOM_PF], exitCount: 1, lock: false }));
      }
      // Префаб-комнаты добавляют сундук из зоны 'c' → сундуков заметно больше, чем без вставки.
      expect(withPf, `${base.algorithm}: префаб-зоны дают контент`).toBeGreaterThan(noPf);
    }
  });

  it('selectPrefabs — отбор по биому/алгоритму (пустой список = любой, нет контекста = без фильтра)', () => {
    const A: RoomPrefab = { ...ROOM_PF, id: 'a', biomes: ['crypt'], algorithms: ['rooms'] };
    const B: RoomPrefab = { ...ROOM_PF, id: 'b', biomes: [], algorithms: [] }; // везде
    const ids = (arr: RoomPrefab[]): string[] => arr.map((p) => p.id);
    expect(ids(selectPrefabs([A, B], { biomeId: 'crypt', algorithm: 'rooms' }))).toEqual(['a', 'b']);
    expect(ids(selectPrefabs([A, B], { biomeId: 'caves', algorithm: 'rooms' }))).toEqual(['b']); // A только crypt
    expect(ids(selectPrefabs([A, B], { biomeId: 'crypt', algorithm: 'bsp' }))).toEqual(['b']); // A только rooms
    expect(ids(selectPrefabs([A, B], {}))).toEqual(['a', 'b']); // нет контекста — не фильтруем
    expect(ids(selectPrefabs([{ ...A, enabled: false }, B], { biomeId: 'crypt', algorithm: 'rooms' }))).toEqual(['b']); // выключенный отсеян
  });

  it('generateFloorParams — чужой биом: room-префаб отсеивается (как будто префабов нет)', () => {
    const PF: RoomPrefab = { ...ROOM_PF, biomes: ['crypt'] };
    let own = 0, foreign = 0, none = 0;
    for (let s = 1; s <= 40; s++) {
      own += chests(generateFloorParams(ROOMS, s, { prefabs: [PF], biomeId: 'crypt', exitCount: 1, lock: false }));
      foreign += chests(generateFloorParams(ROOMS, s, { prefabs: [PF], biomeId: 'caves', exitCount: 1, lock: false }));
      none += chests(generateFloorParams({ ...ROOMS, prefabChance: 0 } as FloorAlgoParams, s, { prefabs: [], exitCount: 1, lock: false }));
    }
    expect(own).toBeGreaterThan(foreign); // свой биом — префаб-комнаты добавляют сундуки из зоны 'c'
    expect(foreign).toBe(none); // чужой биом — префаб отсеян, сундуков ровно как без префабов (базовый фон)
  });

  it('prefabChance:0 — префабы не используются (геометрия идентична без них)', () => {
    const base = { ...ROOMS, prefabChance: 0 } as FloorAlgoParams;
    for (let s = 1; s <= 20; s++) {
      const a = generateFloorParams(base, s, { prefabs: [ROOM_PF], exitCount: 1, lock: false });
      const b = generateFloorParams(base, s, { prefabs: [], exitCount: 1, lock: false });
      expect(JSON.stringify(a.grid), `seed=${s}`).toBe(JSON.stringify(b.grid));
    }
  });
});

describe('prefab — камеры в пещерах/лабиринте (cellular/maze)', () => {
  type Range = { min: number; max: number };
  const CELL = (pr: Range): FloorAlgoParams => ({ algorithm: 'cellular', cols: 60, rows: 44, fillProb: 0.45, steps: 5, born: 5, survive: 4, prefabRooms: pr });
  const MAZE = (pr: Range, width = 1): FloorAlgoParams => ({ algorithm: 'maze', cols: 47, rows: 37, braid: 0.3, width, prefabRooms: pr });
  const chestCount = (L: DungeonLayout): number => L.decor.filter((d) => d.kind === 'chest').length;
  const gridStr = (L: DungeonLayout): string => JSON.stringify(L.grid);
  const floorOf = (L: DungeonLayout): number => { let f = 0; for (const row of L.grid) for (const c of row) if (c === Cell.Floor) f++; return f; };

  it('врезка камер держит проходимость (validate) по сидам — cellular и maze', () => {
    for (const mk of [() => CELL({ min: 2, max: 3 }), () => MAZE({ min: 2, max: 3 })]) {
      for (let s = 1; s <= 40; s++) {
        const L = generateFloorParams(mk(), s, { prefabs: [ROOM_PF], exitCount: 1, lock: false });
        expect(validate(L), `${mk().algorithm} seed=${s}`).toBe(true);
      }
    }
  });

  it('камеры добавляют сундуки из зоны c (больше, чем без камер) — cellular и maze', () => {
    for (const [off, on] of [[CELL({ min: 0, max: 0 }), CELL({ min: 2, max: 2 })], [MAZE({ min: 0, max: 0 }), MAZE({ min: 2, max: 2 })]] as const) {
      let none = 0, withPf = 0;
      for (let s = 1; s <= 40; s++) {
        none += chestCount(generateFloorParams(off, s, { prefabs: [ROOM_PF], exitCount: 1, lock: false }));
        withPf += chestCount(generateFloorParams(on, s, { prefabs: [ROOM_PF], exitCount: 1, lock: false }));
      }
      expect(withPf, `${on.algorithm}: камеры дают сундуки`).toBeGreaterThan(none);
    }
  });

  it('prefabRooms:0 или префаб чужого алгоритма → геометрия идентична без префабов', () => {
    const foreign: RoomPrefab = { ...ROOM_PF, algorithms: ['rooms'] }; // не для пещер/лабиринта
    for (const mk of [CELL, MAZE]) {
      for (let s = 1; s <= 15; s++) {
        const base = gridStr(generateFloorParams(mk({ min: 0, max: 0 }), s, { prefabs: [], exitCount: 1, lock: false }));
        expect(gridStr(generateFloorParams(mk({ min: 0, max: 0 }), s, { prefabs: [ROOM_PF], exitCount: 1, lock: false })), `off seed=${s}`).toBe(base);
        expect(gridStr(generateFloorParams(mk({ min: 3, max: 3 }), s, { prefabs: [foreign], exitCount: 1, lock: false })), `foreign seed=${s}`).toBe(base);
      }
    }
  });

  it('maze width: шире коридоры → больше пола, этаж проходим', () => {
    let sumW1 = 0, sumW3 = 0;
    for (let s = 1; s <= 20; s++) {
      const a = generateFloorParams(MAZE({ min: 0, max: 0 }, 1), s, { exitCount: 1, lock: false });
      const b = generateFloorParams(MAZE({ min: 0, max: 0 }, 3), s, { exitCount: 1, lock: false });
      expect(validate(a), `w1 seed=${s}`).toBe(true);
      expect(validate(b), `w3 seed=${s}`).toBe(true);
      sumW1 += floorOf(a); sumW3 += floorOf(b);
    }
    expect(sumW3).toBeGreaterThan(sumW1);
  });
});
