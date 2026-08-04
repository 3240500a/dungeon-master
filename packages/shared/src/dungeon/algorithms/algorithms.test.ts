import { describe, it, expect } from 'vitest';
import { generateFloorParams } from '../generateFloor.js';
import { validate, type DungeonLayout } from '../floorCommon.js';
import { Cell, TILE } from '../../world/grid.js';
import type { FloorAlgoParams } from '../../config/schemas.js';

const ROOMS: FloorAlgoParams = { algorithm: 'rooms', cols: 56, rows: 42, roomCount: 9, bigChance: 0.3, loops: 0.5, spawnMode: 'farthest', shapes: { rect: 6, ell: 1, blob: 1, round: 1, hall: 1 }, prefabChance: 0 };
const BSP: FloorAlgoParams = { algorithm: 'bsp', cols: 60, rows: 44, splitDepth: 4, minLeaf: 9, roomPad: 1, loops: 0.45, spawnMode: 'farthest', shapes: { rect: 6, ell: 1, blob: 1, round: 1, hall: 1 }, prefabChance: 0 };
const CELLULAR: FloorAlgoParams = { algorithm: 'cellular', cols: 64, rows: 48, fillProb: 0.45, steps: 5, born: 5, survive: 4, prefabRooms: { min: 0, max: 2 } };
const MAZE: FloorAlgoParams = { algorithm: 'maze', cols: 56, rows: 42, braid: 0.3, width: 1, prefabRooms: { min: 0, max: 2 } };

function floorCount(L: DungeonLayout): number {
  let n = 0;
  for (const row of L.grid) for (const c of row) if (c === Cell.Floor) n++;
  return n;
}

/** Число ВЕРШИННО-НЕПЕРЕСЕКАЮЩИХСЯ путей spawn→exit по полу (max-flow с расщеплением вершин). */
function routeCount(L: DungeonLayout): number {
  const grid = L.grid, rows = grid.length, cols = grid[0]!.length;
  const sx = Math.round(L.spawn.x / TILE), sy = Math.round(L.spawn.y / TILE);
  const tx = Math.round(L.exits[0]!.x / TILE), ty = Math.round(L.exits[0]!.y / TILE);
  const idx = (x: number, y: number): number => y * cols + x;
  const V = cols * rows * 2, INF = 1e9;
  const to: number[] = [], cap: number[] = [], nxt: number[] = [];
  const head = new Array<number>(V).fill(-1);
  const add = (u: number, v: number, c: number): void => { to.push(v); cap.push(c); nxt.push(head[u]!); head[u] = to.length - 1; to.push(u); cap.push(0); nxt.push(head[v]!); head[v] = to.length - 1; };
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (grid[y]![x] !== Cell.Floor) continue;
    const c = idx(x, y), end = (x === sx && y === sy) || (x === tx && y === ty);
    add(2 * c, 2 * c + 1, end ? INF : 1); // вершинная ёмкость 1 (концы — ∞)
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < cols && ny < rows && grid[ny]![nx] === Cell.Floor) { const nc = idx(nx, ny); add(2 * c + 1, 2 * nc, INF); add(2 * nc + 1, 2 * c, INF); }
    }
  }
  const S = 2 * idx(sx, sy) + 1, T = 2 * idx(tx, ty);
  let flow = 0;
  for (;;) {
    const prev = new Array<number>(V).fill(-1), pe = new Array<number>(V).fill(-1);
    prev[S] = S; const q = [S];
    for (let h = 0; h < q.length && prev[T] === -1; h++) { const u = q[h]!; for (let e = head[u]!; e !== -1; e = nxt[e]!) if (cap[e]! > 0 && prev[to[e]!] === -1) { prev[to[e]!] = u; pe[to[e]!] = e; q.push(to[e]!); } }
    if (prev[T] === -1) break;
    let v = T; while (v !== S) { const e = pe[v]!; cap[e]!--; cap[e ^ 1]!++; v = prev[v]!; }
    if (++flow > 40) break;
  }
  return flow;
}

describe('braid — несколько путей старт→финиш (rooms/bsp)', () => {
  it.each([['rooms', ROOMS], ['bsp', BSP]] as const)('%s: браид даёт больше маршрутов, чем дерево', (_n, base) => {
    let tree = 0, braid = 0, braidMin = Infinity;
    for (let seed = 1; seed <= 30; seed++) {
      tree += routeCount(generateFloorParams({ ...base, loops: 0 } as FloorAlgoParams, seed, { lock: false }));
      const b = routeCount(generateFloorParams(base, seed, { lock: false })); // base уже с дефолтным loops
      braid += b; braidMin = Math.min(braidMin, b);
    }
    expect(braid, 'сумма маршрутов браида > дерева').toBeGreaterThan(tree); // петли реально добавляют обходные пути
    expect(braidMin, 'связность не теряется').toBeGreaterThanOrEqual(2);
  });
});

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

describe('v3 — формы комнат и размещение старт/выход', () => {
  it('формы комнат появляются при весах (rooms/bsp)', () => {
    for (const base of [ROOMS, BSP]) {
      const cranked = { ...base, shapes: { rect: 1, ell: 3, blob: 3, round: 3, hall: 3 } } as FloorAlgoParams;
      let nonRect = 0;
      for (let s = 1; s <= 20; s++) nonRect += generateFloorParams(cranked, s, { lock: false }).rooms.filter((r) => r.shape && r.shape !== 'rect').length;
      expect(nonRect, base.algorithm).toBeGreaterThan(10);
    }
  });

  it('spawnMode farthest: старт↔выход разнесены; спавн не «застревает» в углу', () => {
    for (const base of [ROOMS, BSP]) {
      const diag = Math.hypot(base.cols, base.rows);
      let far = 0; const spawnCells = new Set<string>();
      for (let s = 1; s <= 30; s++) {
        const L = generateFloorParams(base, s, { lock: false });
        const scx = Math.round(L.spawn.x / TILE), scy = Math.round(L.spawn.y / TILE);
        const ecx = Math.round(L.stairsDown.x / TILE), ecy = Math.round(L.stairsDown.y / TILE);
        if (Math.hypot(scx - ecx, scy - ecy) > diag * 0.4) far++;
        spawnCells.add(`${scx},${scy}`);
      }
      expect(far, `${base.algorithm} разнесены`).toBeGreaterThanOrEqual(24);       // ≥80% сидов
      expect(spawnCells.size, `${base.algorithm} спавн варьируется`).toBeGreaterThan(12);
    }
  });

  it('несколько выходов разнесены (farthest-point sampling)', () => {
    for (let s = 1; s <= 20; s++) {
      const L = generateFloorParams(ROOMS, s, { exitCount: 3, lock: false });
      expect(L.exits.length).toBe(3);
      let minD = Infinity;
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        const a = L.exits[i]!, b = L.exits[j]!;
        minD = Math.min(minD, Math.hypot((a.x - b.x) / TILE, (a.y - b.y) / TILE));
      }
      expect(minD, `seed=${s}`).toBeGreaterThan(6); // выходы не впритык
    }
  });
});
