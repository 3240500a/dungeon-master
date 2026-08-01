import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams } from '../../config/schemas.js';
import { Cell, makeGrid, cellToWorld, gridSize, type Grid } from '../../world/grid.js';
import { type DungeonLayout, type Room, decorate } from '../floorCommon.js';

/** Число соседей-стен (8-окрестность; за границей — стена). */
function wallNeighbors(grid: Grid, x: number, y: number): number {
  const { cols, rows } = gridSize(grid);
  let w = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0) continue;
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || grid[ny]![nx] !== Cell.Floor) w++;
  }
  return w;
}

/** Компонента пола, содержащая (sx,sy) (4-связность). */
function floorRegion(grid: Grid, sx: number, sy: number): { cx: number; cy: number }[] {
  const { cols, rows } = gridSize(grid);
  const seen = new Set<string>([`${sx},${sy}`]);
  const out: { cx: number; cy: number }[] = [{ cx: sx, cy: sy }];
  for (let h = 0; h < out.length; h++) {
    const { cx, cy } = out[h]!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || grid[ny]![nx] !== Cell.Floor) continue;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      seen.add(k); out.push({ cx: nx, cy: ny });
    }
  }
  return out;
}

/**
 * Клеточный автомат (пещеры): шум fillProb → `steps` сглаживаний по born/survive → выбор
 * КРУПНЕЙШЕЙ полости (прочие заливаются стеной) → spawn и лестница на противоположных концах
 * этой полости (связность гарантирована конструкцией; дверей/рычагов нет — пещеры открыты).
 */
export function cellularAlgorithm(params: FloorAlgoParams, rng: Rng): DungeonLayout {
  if (params.algorithm !== 'cellular') throw new Error('cellularAlgorithm: неверные параметры');
  const { cols, rows, fillProb, steps, born, survive } = params;
  const grid = makeGrid(cols, rows, Cell.Wall);
  // шум (кроме рамки)
  for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) {
    grid[y]![x] = rng.chance(fillProb) ? Cell.Wall : Cell.Floor;
  }
  // сглаживание
  for (let s = 0; s < steps; s++) {
    const next = grid.map((row) => row.slice());
    for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) {
      const w = wallNeighbors(grid, x, y);
      next[y]![x] = grid[y]![x] === Cell.Wall ? (w >= survive ? Cell.Wall : Cell.Floor) : (w >= born ? Cell.Wall : Cell.Floor);
    }
    for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) grid[y]![x] = next[y]![x]!;
  }

  // крупнейшая компонента пола
  const visited = new Set<string>();
  let best: { cx: number; cy: number }[] = [];
  for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) {
    if (grid[y]![x] !== Cell.Floor || visited.has(`${x},${y}`)) continue;
    const region = floorRegion(grid, x, y);
    for (const c of region) visited.add(`${c.cx},${c.cy}`);
    if (region.length > best.length) best = region;
  }
  // всё, что не в крупнейшей полости — стена
  const keep = new Set(best.map((c) => `${c.cx},${c.cy}`));
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (grid[y]![x] === Cell.Floor && !keep.has(`${x},${y}`)) grid[y]![x] = Cell.Wall;
  }

  if (best.length < 8) {
    // деградация (слишком мало пола) — одна открытая полость
    for (let y = 2; y < rows - 2; y++) for (let x = 2; x < cols - 2; x++) grid[y]![x] = Cell.Floor;
    best = floorRegion(grid, Math.floor(cols / 2), Math.floor(rows / 2));
    keep.clear();
    for (const c of best) keep.add(`${c.cx},${c.cy}`);
  }

  // spawn = верхне-левая клетка полости; лестница = самая дальняя по BFS.
  const spawnCell = best.reduce((a, b) => (b.cy < a.cy || (b.cy === a.cy && b.cx < a.cx) ? b : a), best[0]!);
  const dist = new Map<string, number>([[`${spawnCell.cx},${spawnCell.cy}`, 0]]);
  const q = [spawnCell];
  let far = spawnCell, farD = 0;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h]!; const d = dist.get(`${cur.cx},${cur.cy}`)!;
    if (d > farD) { farD = d; far = cur; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cur.cx + dx, ny = cur.cy + dy;
      if (grid[ny]?.[nx] !== Cell.Floor) continue;
      const k = `${nx},${ny}`;
      if (dist.has(k)) continue;
      dist.set(k, d + 1); q.push({ cx: nx, cy: ny });
    }
  }

  // синтетические «комнаты»-якоря 3×3 для спавна пачек (центр — гарантированно пол).
  const rooms: Room[] = [];
  const anchor = (cx: number, cy: number, type: Room['type']) => {
    rooms.push({ x: cx - 1, y: cy - 1, w: 3, h: 3, type });
  };
  anchor(spawnCell.cx, spawnCell.cy, 'entrance');
  anchor(far.cx, far.cy, 'boss');
  const anchorCount = Math.min(12, Math.max(3, Math.floor(best.length / 110)));
  const shuffled = [...best];
  for (let i = 0; i < anchorCount; i++) {
    const c = rng.pick(shuffled);
    anchor(c.cx, c.cy, i === 0 ? 'treasure' : 'small');
  }

  const decor: DungeonLayout['decor'] = [];
  for (const r of rooms) decorate(r, decor, rng, grid);

  const stairsDown = cellToWorld(far.cx, far.cy);
  return {
    grid, rooms,
    spawn: cellToWorld(spawnCell.cx, spawnCell.cy),
    stairsDown, exits: [stairsDown],
    decor, doors: [], levers: [],
  };
}
