import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams } from '../../config/schemas.js';
import { Cell, makeGrid, cellToWorld } from '../../world/grid.js';
import {
  type DungeonLayout, type Room,
  roomCenter, dist2, carveRoom, carveCorridor, lockRoom, decorate,
} from '../floorCommon.js';

/**
 * Алгоритм «комнаты + коридоры» (рефактор исходного генератора): rejection-sampling комнат,
 * MST-связь центров + петли, замок «дверь↔рычаг» на боссе, декор. Параметры (размер/число
 * комнат/шанс большой) приходят из биома, а не из глубины.
 */
export function roomsAlgorithm(params: FloorAlgoParams, rng: Rng, opts?: { lock?: boolean }): DungeonLayout {
  if (params.algorithm !== 'rooms') throw new Error('roomsAlgorithm: неверные параметры');
  const lock = opts?.lock ?? true;
  const { cols, rows, roomCount, bigChance } = params;
  const grid = makeGrid(cols, rows, Cell.Wall);

  const rooms: Room[] = [];
  let attempts = 0;
  while (rooms.length < roomCount && attempts < 400) {
    attempts++;
    const big = rng.chance(bigChance);
    const w = big ? rng.int(10, 14) : rng.int(5, 8);
    const h = big ? rng.int(8, 11) : rng.int(4, 7);
    const x = rng.int(1, cols - w - 1);
    const y = rng.int(1, rows - h - 1);
    if (rooms.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) continue;
    rooms.push({ x, y, w, h, type: 'small' });
  }

  const n = rooms.length;
  let farIdx = 0, farD = -1;
  for (let i = 1; i < n; i++) { const d = dist2(rooms[0]!, rooms[i]!); if (d > farD) { farD = d; farIdx = i; } }
  const treasureIdx = n > 3 ? (farIdx === 1 ? 2 : 1) : -1;
  rooms.forEach((r, i) => {
    r.type = i === 0 ? 'entrance' : i === farIdx ? 'boss' : i === treasureIdx ? 'treasure' : (r.w * r.h >= 80 ? 'large' : 'small');
  });
  for (const r of rooms) carveRoom(grid, r);

  const edgeKey = (i: number, j: number) => (i < j ? `${i}-${j}` : `${j}-${i}`);
  const used = new Set<string>();
  if (n > 1) {
    const inTree = new Array(n).fill(false); inTree[0] = true;
    for (let k = 1; k < n; k++) {
      let bi = -1, bj = -1, bd = Infinity;
      for (let i = 0; i < n; i++) if (inTree[i]) for (let j = 0; j < n; j++) if (!inTree[j]) {
        const d = dist2(rooms[i]!, rooms[j]!); if (d < bd) { bd = d; bi = i; bj = j; }
      }
      if (bj >= 0) { inTree[bj] = true; used.add(edgeKey(bi, bj)); carveCorridor(grid, rooms[bi]!, rooms[bj]!, rng); }
    }
    const pairs: [number, number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (i === farIdx || j === farIdx) continue; // босс — не в петлях (запирается)
      if (!used.has(edgeKey(i, j))) pairs.push([i, j, dist2(rooms[i]!, rooms[j]!)]);
    }
    pairs.sort((a, b) => a[2] - b[2]);
    for (let k = 0; k < Math.max(1, Math.floor(n * 0.25)) && k < pairs.length; k++) {
      const [i, j] = pairs[k]!; carveCorridor(grid, rooms[i]!, rooms[j]!, rng);
    }
  }

  const doors: DungeonLayout['doors'] = [];
  const levers: DungeonLayout['levers'] = [];
  const boss = farIdx !== 0 ? rooms[farIdx] : undefined;
  if (boss && lock) lockRoom(grid, boss, doors, levers, rng);

  const decor: DungeonLayout['decor'] = [];
  for (const r of rooms) decorate(r, decor, rng, grid);

  const first = roomCenter(rooms[0]!);
  const last = roomCenter(boss ?? rooms[0]!);
  const stairsDown = cellToWorld(last.cx, last.cy);
  return {
    grid, rooms,
    spawn: cellToWorld(first.cx, first.cy),
    stairsDown, exits: [stairsDown],
    decor, doors, levers,
  };
}
