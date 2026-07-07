import { isBlockedCell, TILE, type Grid } from './grid.js';

/**
 * Прямая видимость по сетке стен (Bresenham между клетками). Возвращает false,
 * если между точками есть хотя бы одна непроходимая клетка. Клетки самих точек не
 * учитываются (там стоят монстр/игрок на полу). Координаты — пиксельные.
 * Headless-версия клиентского `hasLineOfSight` (переезжает на неё на Этапе 3).
 */
export function hasLineOfSight(
  grid: Grid,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const cx1 = Math.floor(x1 / TILE);
  const cy1 = Math.floor(y1 / TILE);
  const cx2 = Math.floor(x2 / TILE);
  const cy2 = Math.floor(y2 / TILE);

  const dx = Math.abs(cx2 - cx1);
  const dy = Math.abs(cy2 - cy1);
  const sx = cx1 < cx2 ? 1 : -1;
  const sy = cy1 < cy2 ? 1 : -1;
  let err = dx - dy;
  let x = cx1;
  let y = cy1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const isEndpoint = (x === cx1 && y === cy1) || (x === cx2 && y === cy2);
    if (!isEndpoint && isBlockedCell(grid, x, y)) return false;
    if (x === cx2 && y === cy2) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return true;
}
