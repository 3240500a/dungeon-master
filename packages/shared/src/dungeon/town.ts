import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';

/**
 * Геометрия города (headless): огороженная комната-хаб. NPC/портал — клиентский
 * декор (их позиции — константы клиента), серверу нужен только грид + спавн для
 * авторитетного движения. Раньше грид строил `TownScene`; теперь — общий источник.
 */
export interface TownLayout {
  grid: Grid;
  spawn: { x: number; y: number };
}

export function townLayout(cols = 22, rows = 15): TownLayout {
  const grid = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { grid[0]![x] = Cell.Wall; grid[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { grid[y]![0] = Cell.Wall; grid[y]![cols - 1] = Cell.Wall; }
  return { grid, spawn: cellToWorld(Math.floor(cols / 2), Math.floor(rows / 2)) };
}
