import { isBlockedCell, TILE, type Grid } from './grid.js';

/** Точка/вектор в мировых (пиксельных) координатах. */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Сеточное движение с коллизией круга об стены (замена Arcade-физики, headless).
 * Оси разрешаются независимо → скольжение вдоль стен: если движение по X упирается
 * в стену, X «прилипает» к грани тайла, а Y продолжает идти. Клетка непроходима =
 * стена/закрытая дверь/за пределами (см. `isBlockedCell`).
 *
 * `vel` — скорость в пикселях/сек, `dt` — шаг в секундах. Возвращает новую позицию
 * (вход не мутируется). Предполагается, что стартовая позиция валидна и смещение за
 * шаг меньше тайла (без туннелирования на игровых скоростях).
 */
export function moveWithCollision(pos: Vec2, vel: Vec2, radius: number, grid: Grid, dt: number): Vec2 {
  let x = pos.x;
  let y = pos.y;
  const dx = vel.x * dt;
  const dy = vel.y * dt;

  // Ось X (Y фиксирован): вертикальный охват круга по текущему y.
  // Дальняя грань — полуоткрытый интервал (ceil-1): касание точно по линии сетки
  // (y+r ровно на границе тайла) не считается перекрытием соседней клетки.
  if (dx !== 0) {
    const nx = x + dx;
    const top = Math.floor((y - radius) / TILE);
    const bot = Math.ceil((y + radius) / TILE) - 1;
    if (dx > 0) {
      const col = Math.floor((nx + radius) / TILE);
      x = spanBlocked(grid, col, top, bot) ? col * TILE - radius : nx;
    } else {
      const col = Math.floor((nx - radius) / TILE);
      x = spanBlocked(grid, col, top, bot) ? (col + 1) * TILE + radius : nx;
    }
  }

  // Ось Y (X — уже обновлённый): горизонтальный охват круга по новому x.
  if (dy !== 0) {
    const ny = y + dy;
    const left = Math.floor((x - radius) / TILE);
    const right = Math.ceil((x + radius) / TILE) - 1;
    if (dy > 0) {
      const row = Math.floor((ny + radius) / TILE);
      y = spanBlockedRow(grid, row, left, right) ? row * TILE - radius : ny;
    } else {
      const row = Math.floor((ny - radius) / TILE);
      y = spanBlockedRow(grid, row, left, right) ? (row + 1) * TILE + radius : ny;
    }
  }

  return { x, y };
}

/** Есть ли непроходимая клетка в столбце `col` на строках [cy0..cy1]. */
function spanBlocked(grid: Grid, col: number, cy0: number, cy1: number): boolean {
  for (let cy = cy0; cy <= cy1; cy++) if (isBlockedCell(grid, col, cy)) return true;
  return false;
}

/** Есть ли непроходимая клетка в строке `row` на столбцах [cx0..cx1]. */
function spanBlockedRow(grid: Grid, row: number, cx0: number, cx1: number): boolean {
  for (let cx = cx0; cx <= cx1; cx++) if (isBlockedCell(grid, cx, row)) return true;
  return false;
}
