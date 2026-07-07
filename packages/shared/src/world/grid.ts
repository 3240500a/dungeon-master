/**
 * Чистая сетка мира (headless, без Phaser). Каноничная версия — клиентская
 * `client/src/world/grid.ts` в перспективе переезжает на неё (Этап 3).
 * Значения `Cell` совпадают с клиентом численно (Floor=0, Wall=1, Door=2), чтобы
 * сетки были взаимозаменяемы. Дверь блокирует проход, пока сессия не откроет её
 * (сменит клетку на Floor).
 */

/** Размер тайла в пикселях. */
export const TILE = 32;

/** Тип клетки сетки мира. */
export enum Cell {
  Floor = 0,
  Wall = 1,
  /** Запертая дверь — блокирует проход, пока не открыта ключом. */
  Door = 2,
  /** Колонна-препятствие: блокирует проход и обзор, но под ней рисуется пол. */
  Pillar = 3,
}

/** Сетка мира: grid[y][x]. */
export type Grid = Cell[][];

export function gridSize(grid: Grid): { cols: number; rows: number } {
  return { rows: grid.length, cols: grid[0]?.length ?? 0 };
}

/** Пиксельный центр клетки. */
export function cellToWorld(cx: number, cy: number): { x: number; y: number } {
  return { x: cx * TILE + TILE / 2, y: cy * TILE + TILE / 2 };
}

export function worldToCell(x: number, y: number): { cx: number; cy: number } {
  return { cx: Math.floor(x / TILE), cy: Math.floor(y / TILE) };
}

/** Создаёт прямоугольную сетку, заполненную стенами (для последующего «прорезания»). */
export function makeGrid(cols: number, rows: number, fill: Cell = Cell.Wall): Grid {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => fill),
  );
}

/** Клетка по координатам сетки (undefined за пределами). */
export function cellAt(grid: Grid, cx: number, cy: number): Cell | undefined {
  return grid[cy]?.[cx];
}

/** Клетка непроходима (стена, закрытая дверь, колонна или за пределами карты). */
export function isBlockedCell(grid: Grid, cx: number, cy: number): boolean {
  const c = grid[cy]?.[cx];
  return c === undefined || c === Cell.Wall || c === Cell.Door || c === Cell.Pillar;
}

/** Проходима ли точка в мировых координатах (по клетке под ней). */
export function isWalkableWorld(grid: Grid, x: number, y: number): boolean {
  return !isBlockedCell(grid, Math.floor(x / TILE), Math.floor(y / TILE));
}
