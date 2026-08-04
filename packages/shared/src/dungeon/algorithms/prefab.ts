import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams } from '../../config/schemas.js';
import { Cell, makeGrid, cellToWorld } from '../../world/grid.js';
import type { DungeonLayout, Room } from '../floorCommon.js';
import { orientPrefab, stampPrefabTerrain, prefabZoneCells, pickPrefab } from '../prefab.js';
import type { FloorAlgoOpts } from './types.js';
import { roomsAlgorithm } from './rooms.js';

type Vc = { cx: number; cy: number };

/**
 * Алгоритм `prefab`: целый этаж — рукотворный префаб (scope:'floor') из библиотеки `opts.prefabs`.
 * Стампит террейн; спавн — зона `e` (иначе любой пол), выходы — зоны `x` (иначе дальняя клетка),
 * декор — зоны `d`(факел)/`c`(сундук), якорь-комнаты монстров — зоны `m` (спавн пачек). Нет
 * подходящего префаба → фолбэк на `rooms`. Проходимость гарантирует `generateFloor` (validate+реген).
 */
export function prefabAlgorithm(params: FloorAlgoParams, rng: Rng, opts?: FloorAlgoOpts): DungeonLayout {
  if (params.algorithm !== 'prefab') throw new Error('prefabAlgorithm: неверные параметры');
  const pool = (opts?.prefabs ?? []).filter((p) => p.enabled !== false && p.scope === 'floor');
  const base = pickPrefab(pool, rng);
  if (!base) {
    return roomsAlgorithm(
      { algorithm: 'rooms', cols: params.cols, rows: params.rows, roomCount: 9, bigChance: 0.3, loops: 0.5, spawnMode: 'farthest', shapes: { rect: 4, ell: 2, blob: 2, round: 2, hall: 2 }, prefabChance: 0 },
      rng, opts,
    );
  }
  const p = orientPrefab(base, rng);
  const grid = makeGrid(p.w + 2, p.h + 2, Cell.Wall);
  stampPrefabTerrain(grid, p, 1, 1);

  const eC = prefabZoneCells(p, 1, 1, 'e'), xC = prefabZoneCells(p, 1, 1, 'x'), mC = prefabZoneCells(p, 1, 1, 'm');
  const dC = prefabZoneCells(p, 1, 1, 'd'), cC = prefabZoneCells(p, 1, 1, 'c');
  const floors: Vc[] = [];
  for (let y = 1; y <= p.h; y++) for (let x = 1; x <= p.w; x++) if (grid[y]![x] === Cell.Floor) floors.push({ cx: x, cy: y });
  const ensure = (c: Vc): Vc => { grid[c.cy]![c.cx] = Cell.Floor; return c; };
  const spawnC = ensure(eC[0] ?? floors[0] ?? { cx: 1, cy: 1 });
  const d2 = (a: Vc, b: Vc): number => (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2;
  const farExit = floors.length ? floors.reduce((best, c) => (d2(c, spawnC) > d2(best, spawnC) ? c : best), floors[0]!) : spawnC;
  const exitCells = (xC.length ? xC.map(ensure) : [farExit]).filter((c) => c.cx !== spawnC.cx || c.cy !== spawnC.cy);
  if (!exitCells.length) exitCells.push(farExit);

  const rooms: Room[] = [{ x: spawnC.cx, y: spawnC.cy, w: 1, h: 1, type: 'entrance' }];
  const monsterAnchors = mC.length ? mC : (floors.length ? [floors[Math.floor(floors.length / 2)]!] : []);
  for (const c of monsterAnchors) rooms.push({ x: c.cx, y: c.cy, w: 1, h: 1, type: 'large' });

  const decor: DungeonLayout['decor'] = [];
  for (const c of dC) decor.push({ ...cellToWorld(c.cx, c.cy), kind: 'torch' });
  for (const c of cC) decor.push({ ...cellToWorld(c.cx, c.cy), kind: 'chest' });

  const stairsDown = cellToWorld(exitCells[0]!.cx, exitCells[0]!.cy);
  return {
    grid, rooms,
    spawn: cellToWorld(spawnC.cx, spawnC.cy),
    stairsDown, exits: exitCells.map((c) => cellToWorld(c.cx, c.cy)),
    decor, doors: [], levers: [],
  };
}
