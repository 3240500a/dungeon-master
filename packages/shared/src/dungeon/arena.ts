import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';

/**
 * Геометрия PvP-арены (headless): круглый зал size×size клеток — пол внутри круга, стены
 * снаружи. Спавны — противоположные концы вертикального диаметра (игроки стартуют лицом
 * к лицу через весь зал). Монстров нет; серверу нужен только грид + точки спавна.
 */
export interface ArenaLayout {
  grid: Grid;
  /** Точки спавна (мировые координаты) — по кругу, противоположными концами. */
  spawns: { x: number; y: number }[];
}

export function arenaLayout(size = 20): ArenaLayout {
  const grid = makeGrid(size, size, Cell.Wall);
  const c = (size - 1) / 2;        // центр в координатах клеток
  const r = size / 2 - 1;          // радиус пола (−1 клетка на кольцо стены)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - c, y - c) <= r) grid[y]![x] = Cell.Floor;
    }
  }
  const cx = Math.round(c);
  const topY = Math.round(c - r + 1);
  const botY = Math.round(c + r - 1);
  return { grid, spawns: [cellToWorld(cx, topY), cellToWorld(cx, botY)] };
}
