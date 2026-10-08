import { isBlockedCell, worldToCell, cellToWorld, gridSize, TILE, type Grid } from './grid.js';
import type { Vec2 } from './movement.js';
import type { Obstacle } from './state.js';

/**
 * Поиск пути по сетке (BFS 4-связность) для навигации ботов/ИИ. Возвращает список
 * путевых точек (центры клеток) от старта к цели, исключая стартовую клетку; пусто —
 * если цель недостижима. Чистая функция; клиентский ИИ пока ходит напрямую, ботам
 * сима нужен обход стен, чтобы реально зачищать этажи.
 *
 * ⭐ 08.10: `nav` — НАВИГАЦИОННАЯ МАСКА ДЕКОРА (`navMaskFor`): путь обходит преграды напольного декора (костёр, колонна-проп), а не
 * ведёт сквозь них. Сетка при этом не меняется (стены, двери, LoS и коллизия — как были). Клетка цели и клетка старта, если они сами
 * под преградой (герой прижат к костру, монстр вытолкнут на угол его клетки), запретом маски не считаются — иначе к цели не подойти и
 * из клетки не выйти. Обойти нельзя (герой зажат преградами) — путь как без маски, сквозь декор: не хуже, чем было. Нет маски (`null`,
 * этаж без преград) — поиск байт-в-байт прежний.
 */
export function findPath(grid: Grid, from: Vec2, to: Vec2, maxNodes = 6000, nav?: NavMask | null): Vec2[] {
  const { cols, rows } = gridSize(grid);
  if (cols === 0 || rows === 0) return [];
  const start = worldToCell(from.x, from.y);
  const goal = worldToCell(to.x, to.y);
  if (start.cx === goal.cx && start.cy === goal.cy) return [];

  // Если цель в стене (монстр вплотную к стене/за дверью) — целимся в ближайшую
  // проходимую клетку рядом с ней.
  let gx = goal.cx;
  let gy = goal.cy;
  if (isBlockedCell(grid, gx, gy)) {
    const near = nearestOpen(grid, gx, gy);
    if (!near) return [];
    gx = near.cx;
    gy = near.cy;
  }

  const mask = nav && nav.cols === cols && nav.rows === rows ? nav : null;   // маска чужого этажа (другой размер) — мимо
  if (mask) {
    const r = search(grid, cols, rows, start.cx, start.cy, gx, gy, maxNodes, mask);
    if (r.path || !r.pruned) return r.path ?? [];
    // маска отрезала все пути — как без неё (ниже)
  }
  return search(grid, cols, rows, start.cx, start.cy, gx, gy, maxNodes, null).path ?? [];
}

/** BFS от клетки старта к клетке цели; `pruned` — маска отвергла хоть один шаг (без неё путь мог найтись). */
function search(
  grid: Grid, cols: number, rows: number, sx: number, sy: number, gx: number, gy: number, maxNodes: number, nav: NavMask | null,
): { path: Vec2[] | null; pruned: boolean } {
  const idx = (cx: number, cy: number): number => cy * cols + cx;
  const prev = new Int32Array(cols * rows).fill(-1);
  const seen = new Uint8Array(cols * rows);
  const startIdx = idx(sx, sy);
  const queue: number[] = [startIdx];
  seen[startIdx] = 1;
  const goalIdx = idx(gx, gy);
  // ⭐ 08.10: старт/цель под преградой — их рёбра маска не судит (выйти из клетки и войти в клетку цели можно всегда)
  const bits = nav?.bits;
  const freeStart = !!bits && (bits[startIdx]! & NAV_CELL) !== 0;
  const freeGoal = !!bits && (bits[goalIdx]! & NAV_CELL) !== 0;
  let found = false;
  let pruned = false;
  let visited = 0;

  for (let head = 0; head < queue.length && visited < maxNodes; head++) {
    const cur = queue[head]!;
    visited++;
    if (cur === goalIdx) { found = true; break; }
    const cx = cur % cols;
    const cy = (cur - cx) / cols;
    const neighbors = [
      [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1],
    ] as const;
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = idx(nx, ny);
      if (seen[ni] || isBlockedCell(grid, nx, ny)) continue;
      if (bits) {
        // клетка под преградой (кроме цели) и ребро сквозь преграду (кроме рёбер старта/цели, что сами под ней)
        if (ni !== goalIdx && (bits[ni]! & NAV_CELL)) { pruned = true; continue; }
        const exempt = (freeStart && cur === startIdx) || (freeGoal && ni === goalIdx);
        if (!exempt) {
          const edge = nx > cx ? bits[cur]! & NAV_RIGHT : nx < cx ? bits[ni]! & NAV_RIGHT : ny > cy ? bits[cur]! & NAV_DOWN : bits[ni]! & NAV_DOWN;
          if (edge) { pruned = true; continue; }
        }
      }
      seen[ni] = 1;
      prev[ni] = cur;
      queue.push(ni);
    }
  }
  if (!found) return { path: null, pruned };

  // Реконструкция пути от цели к старту, затем разворот.
  const path: Vec2[] = [];
  let cur = goalIdx;
  while (cur !== startIdx && cur !== -1) {
    const cx = cur % cols;
    const cy = (cur - cx) / cols;
    path.push(cellToWorld(cx, cy));
    cur = prev[cur]!;
  }
  path.reverse();
  return { path, pruned };
}

/** Ближайшая проходимая клетка к (cx,cy) кольцевым поиском (для целей у стен). */
function nearestOpen(grid: Grid, cx: number, cy: number): { cx: number; cy: number } | null {
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // только кольцо
        if (!isBlockedCell(grid, cx + dx, cy + dy)) return { cx: cx + dx, cy: cy + dy };
      }
    }
  }
  return null;
}

// ── ⭐ 08.10: навигационная маска декора ──────────────────────────────────────────────────────────────────────────────────────

/**
 * ⭐ 08.10: НАВИГАЦИОННАЯ МАСКА ДЕКОРА — слой поверх сетки для поиска пути: какие клетки и рёбра между соседними клетками перекрыты
 * преградами напольного декора (`Obstacle`: костёр, колонна-проп, ниша статуи). Путь BFS идёт от центра клетки к центру соседки, поэтому:
 *  • КЛЕТКА закрыта, если её центр — внутри преграды (путевая точка там недостижима: тело упрётся и встанет — так монстры стояли у
 *    костров крипты по 20 с, ревью 08.10);
 *  • РЕБРО закрыто, если отрезок «центр — центр» проходит сквозь преграду (тело шло бы в неё лоб в лоб).
 * Запас на радиус тела НЕ берётся (`pad` = 0): центр клетки вне преграды достижим всегда — тело (радиус ≤ 15 px) дотягивается до него
 * ближе порога «дошёл» (16 px), а отрезок, проходящий мимо преграды хоть сбоку, тело огибает скольжением (`moveWithCollision` хранит
 * касательную). С запасом в радиус закрылась бы клетка перед нишей статуи в коридоре шириной в клетку (бокс 7 px от стены, центр клетки
 * в 16 px) — коридор, который тело проходит, стал бы для пути глухим.
 * Строится раз на этаж (`navMaskFor`, кэш по массиву преград), чистая функция преград → детерминирована у сервера, сима и клиента.
 */
export interface NavMask {
  cols: number;
  rows: number;
  /** На клетку `cy * cols + cx`: `NAV_CELL` — центр под преградой, `NAV_RIGHT` — ребро к (cx+1, cy), `NAV_DOWN` — к (cx, cy+1). */
  bits: Uint8Array;
}
export const NAV_CELL = 1;
export const NAV_RIGHT = 2;
export const NAV_DOWN = 4;

/** Маска по преградам этажа; ни одна преграда ничего не закрыла (или их нет) — `null`: поиск пути как без маски. */
export function buildNavMask(cols: number, rows: number, obstacles: readonly Obstacle[] | undefined, pad = 0): NavMask | null {
  if (!obstacles || !obstacles.length || cols <= 0 || rows <= 0) return null;
  const bits = new Uint8Array(cols * rows);
  let any = false;
  for (const o of obstacles) {
    const reach = (o.shape === 'circle' ? o.r ?? 0 : Math.hypot(o.hw ?? 0, o.hh ?? 0)) + Math.max(0, pad);
    if (!(reach > 0) || !Number.isFinite(reach) || !Number.isFinite(o.x) || !Number.isFinite(o.y)) continue;
    // клетки, чей центр или ребро к соседке (+x, +y) может задеть преграду; на клетку шире с каждой стороны
    const x0 = Math.max(0, Math.floor((o.x - reach) / TILE) - 1), x1 = Math.min(cols - 1, Math.floor((o.x + reach) / TILE) + 1);
    const y0 = Math.max(0, Math.floor((o.y - reach) / TILE) - 1), y1 = Math.min(rows - 1, Math.floor((o.y + reach) / TILE) + 1);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const x = cx * TILE + TILE / 2, y = cy * TILE + TILE / 2;
      let b = 0;
      if (segmentHits(o, x, y, x, y, pad)) b |= NAV_CELL;
      if (cx + 1 < cols && segmentHits(o, x, y, x + TILE, y, pad)) b |= NAV_RIGHT;
      if (cy + 1 < rows && segmentHits(o, x, y, x, y + TILE, pad)) b |= NAV_DOWN;
      if (b) { bits[cy * cols + cx]! |= b; any = true; }
    }
  }
  return any ? { cols, rows, bits } : null;
}

const navCache = new WeakMap<readonly Obstacle[], { n: number; cols: number; rows: number; mask: NavMask | null }>();

/**
 * Маска этажа (`world.grid` + `world.obstacles`) — из кэша: строится один раз на массив преград (новый этаж — новый массив, `enterFloor`).
 * Сетка в маску не входит (только её размер), поэтому открытая дверь маску не старит.
 */
export function navMaskFor(grid: Grid, obstacles: readonly Obstacle[] | undefined): NavMask | null {
  if (!obstacles || !obstacles.length) return null;
  const { cols, rows } = gridSize(grid);
  const c = navCache.get(obstacles);
  if (c && c.n === obstacles.length && c.cols === cols && c.rows === rows) return c.mask;
  const mask = buildNavMask(cols, rows, obstacles);
  navCache.set(obstacles, { n: obstacles.length, cols, rows, mask });
  return mask;
}

/**
 * Отрезок (ax, ay)–(bx, by) проходит ВНУТРИ преграды, раздутой на `pad` (касание границы — не внутри, как у `pushOutObstacle`);
 * нулевой отрезок — точка. Бокс — в своих осях (поворот на −yaw); раздутие бокса — прямоугольное (с запасом на углах).
 */
export function segmentHits(o: Obstacle, ax: number, ay: number, bx: number, by: number, pad = 0): boolean {
  const p = Math.max(0, pad);
  if (o.shape === 'circle') {
    const r = (o.r ?? 0) + p;
    return r > 0 && segDist2(o.x, o.y, ax, ay, bx, by) < r * r;
  }
  const yaw = o.yaw ?? 0, cs = Math.cos(yaw), sn = Math.sin(yaw);
  const lax = (ax - o.x) * cs + (ay - o.y) * sn, lay = -(ax - o.x) * sn + (ay - o.y) * cs;
  const lbx = (bx - o.x) * cs + (by - o.y) * sn, lby = -(bx - o.x) * sn + (by - o.y) * cs;
  return segInBox(lax, lay, lbx, lby, (o.hw ?? 0) + p, (o.hh ?? 0) + p);
}

/** Квадрат расстояния от точки (px, py) до отрезка (ax, ay)–(bx, by). */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

/** Отрезок заходит ВНУТРЬ открытого прямоугольника |x| < ex, |y| < ey (отсечение Лианга — Барски по открытым полосам). */
function segInBox(ax: number, ay: number, bx: number, by: number, ex: number, ey: number): boolean {
  if (!(ex > 0) || !(ey > 0)) return false;
  let t0 = 0, t1 = 1;
  const clip = (a: number, d: number, e: number): boolean => {
    if (Math.abs(d) < 1e-12) return Math.abs(a) < e;   // параллельно полосе: весь внутри или весь вне
    let ta = (-e - a) / d, tb = (e - a) / d;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    return t0 < t1;
  };
  return clip(ax, bx - ax, ex) && clip(ay, by - ay, ey);
}
