import { isBlockedCell, TILE, type Grid } from './grid.js';
import type { Obstacle } from './state.js';

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
 *
 * `obstacles` (опц.) — суб-тайловые препятствия напольного декора (круг/бокс): ПОСЛЕ
 * тайл-резолва актёр-круг выталкивается наружу по нормали проникновения (тангенц.
 * движение сохраняется → скольжение вдоль декора накапливается по тикам). Препятствия
 * ставятся ВНУТРИ комнат (footprint-резерв держит их от стен), поэтому выталкивание не
 * загоняет в стену; краевой случай доразрешает движение следующего тика.
 */
export function moveWithCollision(pos: Vec2, vel: Vec2, radius: number, grid: Grid, dt: number, obstacles?: readonly Obstacle[]): Vec2 {
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

  // Суб-тайловые препятствия: вытолкнуть круг наружу (2 релаксации — на случай
  // пары близких препятствий; выход, когда за проход ничего не сдвинулось).
  if (obstacles && obstacles.length) {
    for (let it = 0; it < 2; it++) {
      let moved = false;
      for (const o of obstacles) {
        const p = pushOutObstacle(x, y, radius, o);
        if (p) { x = p.x; y = p.y; moved = true; }
      }
      if (!moved) break;
    }
  }

  return { x, y };
}

/**
 * Выталкивает круг (центр x,y, радиус R) наружу из препятствия, если они пересекаются.
 * Возвращает новый центр или null (нет пересечения). Круг↔круг — по оси центров;
 * круг↔ориент.-бокс — через ближайшую точку бокса в его локальных осях.
 */
export function pushOutObstacle(x: number, y: number, radius: number, o: Obstacle): Vec2 | null {
  if (o.shape === 'circle') {
    const r = o.r ?? 0;
    let dx = x - o.x;
    let dy = y - o.y;
    const min = radius + r;
    let d = Math.hypot(dx, dy);
    if (d >= min) return null;
    if (d < 1e-6) { dx = 1; dy = 0; d = 1; } // центры совпали — детерм. ось
    const push = min - d;
    return { x: x + (dx / d) * push, y: y + (dy / d) * push };
  }
  // Бокс: в локаль (поворот на −yaw), полу-габариты hw/hh + радиус круга.
  const hw = o.hw ?? 0;
  const hh = o.hh ?? 0;
  const yaw = o.yaw ?? 0;
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const rx = x - o.x;
  const ry = y - o.y;
  const lx = rx * cs + ry * sn;   // локальные координаты центра круга
  const ly = -rx * sn + ry * cs;
  const ex = hw + radius;         // «раздутый» бокс (Минковский) — круг как точка
  const ey = hh + radius;
  if (Math.abs(lx) >= ex || Math.abs(ly) >= ey) return null; // вне раздутого бокса
  // Внутри: вытолкнуть по оси наименьшего проникновения.
  const penX = ex - Math.abs(lx);
  const penY = ey - Math.abs(ly);
  let nlx = lx;
  let nly = ly;
  if (penX <= penY) nlx = (lx < 0 ? -ex : ex);
  else nly = (ly < 0 ? -ey : ey);
  // Обратно в мир (поворот на +yaw).
  return { x: o.x + nlx * cs - nly * sn, y: o.y + nlx * sn + nly * cs };
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
