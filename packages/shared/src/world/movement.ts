import { vecLen } from './fastMath.js';
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
 * (вход не мутируется). Предполагается, что стартовая позиция валидна.
 *
 * ⚠ R4-07: СМЕЩЕНИЕ РАЗВЁРТЫВАЕТСЯ ПОДШАГАМИ ≤ `sweepStep` (полклетки, не больше радиуса). Клетка проверялась
 * только в точке назначения, и шаг длиннее клетки перепрыгивал стену: рывок 5+ ранга (≥ 34 px за тик 1/30)
 * проходил закрытую дверь рычага, `to` рывка/прыжка и отброс (одним шагом `dt = 1`, 100–220 px) уводили
 * урон и монстров за стены. Обычная ходьба (4–7 px за тик) — один подшаг, как и было. Не число
 * (NaN/∞ в скорости) — стоим на месте: ∞ иначе означала бы бесконечное число подшагов.
 *
 * `obstacles` (опц.) — суб-тайловые препятствия напольного декора (круг/бокс): ПОСЛЕ
 * тайл-резолва актёр-круг выталкивается наружу по нормали проникновения (тангенц.
 * движение сохраняется → скольжение вдоль декора накапливается по тикам).
 *
 * ⚠ V-RF-05: ВЫТАЛКИВАНИЕ — ТЕМ ЖЕ РАЗРЕШЕНИЕМ ПО ТАЙЛАМ, ЧТО И ХОД (`tileSweep`). Раньше оно ставило круг по нормали мимо
 * сетки («препятствия внутри комнат, краевой случай доразрешит следующий тик»): у преграды вплотную к стене (настенный
 * реквизит, `placeWallProps`) круг уходил в стену, и следующий шаг, задев строку стены охватом оси, «прилипал» к дальней
 * грани — рывок до клетки ПРОТИВ ввода, дрожь туда-обратно; монстр, заселённый на преграду, выдавливался в стену, закрытую
 * дверь и через диагональный шов. Теперь толчок в стену гасится гранью, как шаг: круг, зажатый между стеной и преградой,
 * остаётся чуть внутри преграды (её догоняет следующий толчок), но в стену не входит никогда.
 */
export function moveWithCollision(pos: Vec2, vel: Vec2, radius: number, grid: Grid, dt: number, obstacles?: readonly Obstacle[]): Vec2 {
  const dx = vel.x * dt;
  const dy = vel.y * dt;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { x: pos.x, y: pos.y };
  const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(vecLen(dx, dy) / sweepStep(radius))));
  let p: Vec2 = { x: pos.x, y: pos.y };
  for (let i = 0; i < n; i++) p = stepOnce(p.x, p.y, dx / n, dy / n, radius, grid, obstacles);
  return p;
}

/** Длина подшага развёртки: полклетки (колонка не перепрыгивается), не больше радиуса (декор не проскакивается). */
function sweepStep(radius: number): number {
  return Math.max(1, Math.min(TILE / 2, radius));
}
/** Потолок подшагов: ~14 тыс. px при подшаге 14 — больше любой карты; бред в конфиге не повесит тик. */
const MAX_SUBSTEPS = 1024;

/** Один подшаг (смещение не длиннее `sweepStep`): тайлы по осям, затем выталкивание из декора — тоже по тайлам (V-RF-05). */
function stepOnce(x: number, y: number, dx: number, dy: number, radius: number, grid: Grid, obstacles?: readonly Obstacle[]): Vec2 {
  let p = tileStep(x, y, dx, dy, radius, grid);
  // Суб-тайловые препятствия: вытолкнуть круг наружу (2 релаксации — на случай
  // пары близких препятствий; выход, когда за проход ничего не сдвинулось).
  if (obstacles && obstacles.length) {
    for (let it = 0; it < 2; it++) {
      let moved = false;
      for (const o of obstacles) {
        const out = pushOutObstacle(p.x, p.y, radius, o);
        if (!out) continue;
        const q = tileSweep(p.x, p.y, out.x - p.x, out.y - p.y, radius, grid);
        if (q.x !== p.x || q.y !== p.y) { p = q; moved = true; }
      }
      if (!moved) break;
    }
  }
  return p;
}

/** Смещение только по тайлам (без декора) — подшагами ≤ `sweepStep`, как ход: толчок из преграды не перепрыгнет клетку. */
function tileSweep(x: number, y: number, dx: number, dy: number, radius: number, grid: Grid): Vec2 {
  const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(vecLen(dx, dy) / sweepStep(radius))));
  let p: Vec2 = { x, y };
  for (let i = 0; i < n; i++) p = tileStep(p.x, p.y, dx / n, dy / n, radius, grid);
  return p;
}

/** Подшаг по тайлам: оси независимо (X, затем Y по новому x) — скольжение вдоль стен, в непроходимую клетку круг не входит. */
function tileStep(x: number, y: number, dx: number, dy: number, radius: number, grid: Grid): Vec2 {
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
    let d = vecLen(dx, dy);
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
