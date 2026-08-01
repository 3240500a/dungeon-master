import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams } from '../../config/schemas.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../../world/grid.js';
import { type DungeonLayout, type Room, decorate } from '../floorCommon.js';

/**
 * Алгоритм «лабиринт» (recursive backtracker): идеальный лабиринт на решётке клеток-узлов
 * (нечётные координаты — узлы, чётные между ними — перемычки). `braid` расплетает долю тупиков
 * (пробивает лишнюю стену), снижая «однопроходность». Связность spawn→stairs гарантирована
 * конструкцией — замков/дверей нет (как в пещерах). spawn = стартовый узел, stairs = самый
 * дальний по BFS. Синтетические 3×3-якоря на коридорах — для расстановки пачек монстров.
 */
export function mazeAlgorithm(params: FloorAlgoParams, rng: Rng): DungeonLayout {
  if (params.algorithm !== 'maze') throw new Error('mazeAlgorithm: неверные параметры');
  const { cols, rows, braid } = params;
  const grid = makeGrid(cols, rows, Cell.Wall);

  // Решётка узлов: узлы в нечётных клетках, между ними — перемычки.
  const nCols = Math.max(1, Math.floor((cols - 1) / 2));
  const nRows = Math.max(1, Math.floor((rows - 1) / 2));
  const gx = (nx: number) => nx * 2 + 1;
  const gy = (ny: number) => ny * 2 + 1;
  const key = (nx: number, ny: number) => `${nx},${ny}`;

  const visited = new Set<string>();
  // Итеративный DFS (стек) — без риска переполнения на больших сетках.
  const start = { nx: 0, ny: 0 };
  const stack: { nx: number; ny: number }[] = [start];
  visited.add(key(start.nx, start.ny));
  grid[gy(start.ny)]![gx(start.nx)] = Cell.Floor;
  while (stack.length) {
    const cur = stack[stack.length - 1]!;
    const neigh = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
      .map(([dx, dy]) => ({ nx: cur.nx + dx, ny: cur.ny + dy }))
      .filter((n) => n.nx >= 0 && n.ny >= 0 && n.nx < nCols && n.ny < nRows && !visited.has(key(n.nx, n.ny)));
    if (!neigh.length) { stack.pop(); continue; }
    const nb = rng.pick(neigh);
    // прорубаем узел соседа и перемычку между
    grid[gy(nb.ny)]![gx(nb.nx)] = Cell.Floor;
    grid[(gy(cur.ny) + gy(nb.ny)) / 2]![(gx(cur.nx) + gx(nb.nx)) / 2] = Cell.Floor;
    visited.add(key(nb.nx, nb.ny));
    stack.push(nb);
  }

  // braid: расплетаем часть тупиков — узел с 1 выходом получает ещё один проход к соседу.
  if (braid > 0) {
    for (let ny = 0; ny < nRows; ny++) for (let nx = 0; nx < nCols; nx++) {
      const cx = gx(nx), cy = gy(ny);
      if (grid[cy]![cx] !== Cell.Floor) continue;
      const dirs = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const);
      const open = dirs.filter(([dx, dy]) => grid[cy + dy]?.[cx + dx] === Cell.Floor);
      if (open.length !== 1) continue; // не тупик
      if (!rng.chance(braid)) continue;
      // пробить перемычку к любому соседнему узлу, к которому ещё нет прохода
      const cand = dirs.filter(([dx, dy]) => {
        const tx = nx + dx, ty = ny + dy;
        return tx >= 0 && ty >= 0 && tx < nCols && ty < nRows && grid[cy + dy]?.[cx + dx] === Cell.Wall;
      });
      if (cand.length) { const [dx, dy] = rng.pick(cand); grid[cy + dy]![cx + dx] = Cell.Floor; }
    }
  }

  // spawn = стартовый узел; stairs = самый дальний по BFS.
  const sx = gx(0), sy = gy(0);
  const dist = new Map<string, number>([[`${sx},${sy}`, 0]]);
  const q: { x: number; y: number }[] = [{ x: sx, y: sy }];
  let far = { x: sx, y: sy }, farD = 0;
  const floorCells: { x: number; y: number }[] = [{ x: sx, y: sy }];
  for (let h = 0; h < q.length; h++) {
    const cur = q[h]!; const d = dist.get(`${cur.x},${cur.y}`)!;
    if (d > farD) { farD = d; far = cur; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if ((grid[ny]?.[nx]) !== Cell.Floor) continue;
      const k = `${nx},${ny}`;
      if (dist.has(k)) continue;
      dist.set(k, d + 1); q.push({ x: nx, y: ny }); floorCells.push({ x: nx, y: ny });
    }
  }

  // Синтетические якоря 3×3 для пачек (центр — пол-коридор).
  const rooms: Room[] = [];
  const anchor = (cx: number, cy: number, type: Room['type']) => rooms.push({ x: cx - 1, y: cy - 1, w: 3, h: 3, type });
  anchor(sx, sy, 'entrance');
  anchor(far.x, far.y, 'boss');
  // Плотность пачек сопоставима с rooms/bsp: узкие коридоры лабиринта дают много клеток пола,
  // поэтому делим щедро и капим, иначе этаж превращается в толпу.
  const anchorCount = Math.min(12, Math.max(3, Math.floor(floorCells.length / 120)));
  for (let i = 0; i < anchorCount; i++) {
    const c = rng.pick(floorCells);
    anchor(c.x, c.y, i === 0 ? 'treasure' : 'small');
  }

  const decor: DungeonLayout['decor'] = [];
  for (const r of rooms) decorateSafe(r, decor, rng, grid);

  const stairsDown = cellToWorld(far.x, far.y);
  return {
    grid, rooms,
    spawn: cellToWorld(sx, sy),
    stairsDown, exits: [stairsDown],
    decor, doors: [], levers: [],
  };
}

/** Декор без колонн (узкие коридоры лабиринта нельзя перекрывать колоннами). */
function decorateSafe(r: Room, out: DungeonLayout['decor'], rng: Rng, grid: Grid): void {
  if (r.type === 'large') return; // колонны заблокировали бы коридор
  decorate(r, out, rng, grid);
}
