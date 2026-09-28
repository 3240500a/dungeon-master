import { diagonalSealed, isBlockedCell, TILE, type Grid } from './grid.js';
import type { Obstacle } from './state.js';

/**
 * Прямая видимость по сетке стен (Bresenham между клетками). Возвращает false,
 * если между точками есть хотя бы одна непроходимая клетка. Клетки самих точек не
 * учитываются (там стоят монстр/игрок на полу). Координаты — пиксельные.
 * Headless-версия клиентского `hasLineOfSight` (переезжает на неё на Этапе 3).
 *
 * ⚠ R10-02: шаг по ДИАГОНАЛИ сквозь угол, у которого обе боковые клетки непроходимы (`diagonalSealed`), — тоже стена.
 * Проверялась только клетка, куда шагнули: через «диагональный шов» (две клетки пола, касающиеся углом) было видно, а тело
 * угол не проходит. Монстр видел героя, в обход не шёл (путь ищется только без видимости) и застревал у угла дальше своего
 * удара, а герой бил его через угол; тем же швом подбор, сундук, рычаг и разлёт добычи доставали в запечатанное.
 *
 * `obstacles` (опц.) — суб-тайловые препятствия декора: если у препятствия
 * `blocksSight`, и отрезок пересекает его форму (круг/бокс), обзор перекрыт
 * (высокая колонна прячет цель). Низкий декор (`blocksSight:false`) обзор не трогает.
 */
export function hasLineOfSight(
  grid: Grid,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  obstacles?: readonly Obstacle[],
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
    const px = x;
    const py = y;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
    if (diagonalSealed(grid, px, py, x, y)) return false; // R10-02: угол шва не просвечивает
  }

  // Суб-тайловые препятствия, перекрывающие обзор (после чистого грида).
  return !sightBlockedByObstacles(obstacles, x1, y1, x2, y2);
}

/**
 * Перекрыт ли отрезок (x1,y1)-(x2,y2) преградой декора, закрывающей обзор (`blocksSight`), — та же проверка, что у
 * `hasLineOfSight` после сетки. ⚠ C-10: ею же гасится снаряд (подшаг `stepProjectiles`): сетку он смотрел, а колонну — нет.
 */
export function sightBlockedByObstacles(obstacles: readonly Obstacle[] | undefined, x1: number, y1: number, x2: number, y2: number): boolean {
  if (!obstacles) return false;
  for (const o of obstacles) {
    if (o.blocksSight && segHitsObstacle(o, x1, y1, x2, y2)) return true;
  }
  return false;
}

/** Пересекает ли отрезок (x1,y1)-(x2,y2) форму препятствия (круг/ориент.-бокс). */
export function segHitsObstacle(o: Obstacle, x1: number, y1: number, x2: number, y2: number): boolean {
  if (o.shape === 'circle') {
    const r = o.r ?? 0;
    return pointSegDist2(o.x, o.y, x1, y1, x2, y2) <= r * r;
  }
  // Бокс: перевести отрезок в локаль (поворот на −yaw), затем отрезок-vs-AABB.
  const yaw = o.yaw ?? 0;
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const lx1 = (x1 - o.x) * cs + (y1 - o.y) * sn;
  const ly1 = -(x1 - o.x) * sn + (y1 - o.y) * cs;
  const lx2 = (x2 - o.x) * cs + (y2 - o.y) * sn;
  const ly2 = -(x2 - o.x) * sn + (y2 - o.y) * cs;
  return segAabb(lx1, ly1, lx2, ly2, o.hw ?? 0, o.hh ?? 0);
}

/** Квадрат расстояния от точки до отрезка. */
function pointSegDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}

/** Пересечение отрезка с AABB [−hw..hw]×[−hh..hh] (Лианг-Барски). */
function segAabb(x1: number, y1: number, x2: number, y2: number, hw: number, hh: number): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [[-dx, x1 + hw], [dx, hw - x1], [-dy, y1 + hh], [dy, hh - y1]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return false; continue; } // параллельно грани и вне слэба
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 <= t1;
}
