import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams } from '../../config/schemas.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../../world/grid.js';
import { type DungeonLayout, type Room, decorate, reconnectFloor } from '../floorCommon.js';
import { carvePrefabChambers } from '../prefab.js';
import type { FloorAlgoOpts } from './types.js';

/**
 * Алгоритм «лабиринт» (recursive backtracker): идеальный лабиринт на решётке узлов. Коридор шириной
 * `width` клеток, стена между коридорами — 1 клетка ⇒ шаг решётки = width+1 (width=1 — классический
 * тонкий лабиринт). `braid` расплетает долю тупиков (пробивает лишнюю перемычку). spawn = стартовый
 * узел, stairs = самый дальний по BFS; замков/дверей нет (как в пещерах). Опц. врезка рукотворных
 * room-префаб-камер (`prefabRooms` от..до) + `reconnectFloor` для сохранения проходимости.
 * Синтетические 3×3-якоря на коридорах — для расстановки пачек монстров.
 */
export function mazeAlgorithm(params: FloorAlgoParams, rng: Rng, opts?: FloorAlgoOpts): DungeonLayout {
  if (params.algorithm !== 'maze') throw new Error('mazeAlgorithm: неверные параметры');
  const { cols, rows, braid, width } = params;
  const grid = makeGrid(cols, rows, Cell.Wall);

  // Решётка узлов: блок-узел width×width, между блоками — стена 1 клетка ⇒ шаг = width+1.
  const step = width + 1;
  const nCols = Math.max(1, Math.floor((cols - 1) / step));
  const nRows = Math.max(1, Math.floor((rows - 1) / step));
  const tlx = (nx: number): number => nx * step + 1; // верх-левый угол блока-узла
  const tly = (ny: number): number => ny * step + 1;
  const key = (nx: number, ny: number): string => `${nx},${ny}`;
  const fillBlock = (nx: number, ny: number): void => {
    for (let dy = 0; dy < width; dy++) for (let dx = 0; dx < width; dx++) grid[tly(ny) + dy]![tlx(nx) + dx] = Cell.Floor;
  };
  // Перемычка между смежными узлами (одна клетка-стена, пробитая на всю ширину коридора).
  const fillBridge = (ax: number, ay: number, bx: number, by: number): void => {
    if (ax !== bx) { const x = Math.min(tlx(ax), tlx(bx)) + width; for (let dy = 0; dy < width; dy++) grid[tly(ay) + dy]![x] = Cell.Floor; }
    else { const y = Math.min(tly(ay), tly(by)) + width; for (let dx = 0; dx < width; dx++) grid[y]![tlx(ax) + dx] = Cell.Floor; }
  };
  // Открыт ли мост от узла к соседу (для braid).
  const bridgeOpen = (nx: number, ny: number, dx: number, dy: number): boolean => {
    if (dx !== 0) { const x = Math.min(tlx(nx), tlx(nx + dx)) + width; return grid[tly(ny)]?.[x] === Cell.Floor; }
    const y = Math.min(tly(ny), tly(ny + dy)) + width; return grid[y]?.[tlx(nx)] === Cell.Floor;
  };

  // Итеративный DFS (стек) — без риска переполнения на больших сетках.
  const visited = new Set<string>();
  const start = { nx: 0, ny: 0 };
  const stack: { nx: number; ny: number }[] = [start];
  visited.add(key(start.nx, start.ny));
  fillBlock(start.nx, start.ny);
  while (stack.length) {
    const cur = stack[stack.length - 1]!;
    const neigh = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
      .map(([dx, dy]) => ({ nx: cur.nx + dx, ny: cur.ny + dy }))
      .filter((n) => n.nx >= 0 && n.ny >= 0 && n.nx < nCols && n.ny < nRows && !visited.has(key(n.nx, n.ny)));
    if (!neigh.length) { stack.pop(); continue; }
    const nb = rng.pick(neigh);
    fillBlock(nb.nx, nb.ny);
    fillBridge(cur.nx, cur.ny, nb.nx, nb.ny);
    visited.add(key(nb.nx, nb.ny));
    stack.push(nb);
  }

  // braid: расплетаем часть тупиков — узел с 1 открытым мостом получает ещё один.
  if (braid > 0) {
    for (let ny = 0; ny < nRows; ny++) for (let nx = 0; nx < nCols; nx++) {
      if (grid[tly(ny)]?.[tlx(nx)] !== Cell.Floor) continue;
      const dirs = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const);
      const open = dirs.filter(([dx, dy]) => bridgeOpen(nx, ny, dx, dy));
      if (open.length !== 1) continue; // не тупик
      if (!rng.chance(braid)) continue;
      // пробить перемычку к любому соседнему узлу, к которому ещё нет прохода
      const cand = dirs.filter(([dx, dy]) => {
        const tx = nx + dx, ty = ny + dy;
        return tx >= 0 && ty >= 0 && tx < nCols && ty < nRows && !bridgeOpen(nx, ny, dx, dy);
      });
      if (cand.length) { const [dx, dy] = rng.pick(cand); fillBridge(nx, ny, nx + dx, ny + dy); }
    }
  }

  // spawn = центр стартового блока; stairs = самый дальний по BFS.
  const sx = tlx(0) + (width >> 1), sy = tly(0) + (width >> 1);
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
  const anchor = (cx: number, cy: number, type: Room['type']): void => { rooms.push({ x: cx - 1, y: cy - 1, w: 3, h: 3, type }); };
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
  // Врезаем рукотворные room-префаб-камеры (число — ролл prefabRooms от..до), затем чиним связность
  // (стена-кольцо камеры разрезает коридоры — reconnectFloor сшивает обратно). Пропущены, если нет префабов.
  const chamberSet = new Set<Room>();
  const prefabs = opts?.prefabs ?? [];
  const { min: pfMin, max: pfMax } = params.prefabRooms;
  if (prefabs.length && pfMax > 0) {
    const n = rng.int(Math.min(pfMin, pfMax), Math.max(pfMin, pfMax));
    const chambers = carvePrefabChambers(grid, prefabs, n, { cx: sx, cy: sy }, { cx: far.x, cy: far.y }, rooms, decor, rng);
    if (chambers.length) {
      reconnectFloor(grid, { cx: sx, cy: sy }, rng);
      for (const c of chambers) { rooms.push(c); chamberSet.add(c); }
    }
  }
  for (const r of rooms) if (!chamberSet.has(r)) decorateSafe(r, decor, rng, grid);

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
