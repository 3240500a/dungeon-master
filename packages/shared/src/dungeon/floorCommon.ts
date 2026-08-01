import type { Rng } from '../formulas/rng.js';
import { Cell, cellToWorld, worldToCell, gridSize, type Grid } from '../world/grid.js';

/**
 * Общие типы и helper'ы поклеточной генерации этажа, разделяемые ВСЕМИ алгоритмами
 * (rooms/bsp/cellular/…). Вынесено из `generate.ts`, чтобы новый алгоритм переиспользовал
 * замки «дверь↔рычаг», декор и инвариант проходимости, а не дублировал их.
 */

export type RoomType = 'entrance' | 'small' | 'large' | 'treasure' | 'boss';

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  type: RoomType;
  /** Спец-содержимое комнаты (для спавна): чемпионы / босс / сокровищница. */
  content?: 'champion' | 'boss' | 'treasure';
}

export interface DecorObject {
  x: number;
  y: number;
  kind: 'pillar' | 'torch' | 'chest' | 'arena' | 'portal' | 'stash' | 'shop';
}

/** Запертые ворота: группа смежных клеток `Cell.Door` одного проёма. */
export interface Door {
  id: number;
  cells: { cx: number; cy: number }[];
}
/** Рычаг, открывающий свою дверь (`doorId`). Позиция — в мировых координатах. */
export interface Lever {
  id: number;
  x: number;
  y: number;
  doorId: number;
}

export interface DungeonLayout {
  grid: Grid;
  rooms: Room[];
  spawn: { x: number; y: number };
  /** Первый выход (== exits[0]) — оставлен для обратной совместимости сервера/сима. */
  stairsDown: { x: number; y: number };
  /** Все выходы на следующие этажи (развилка = несколько выходов). exits[0] === stairsDown. */
  exits: { x: number; y: number }[];
  decor: DecorObject[];
  doors: Door[];
  levers: Lever[];
}

export function roomCenter(r: Room): { cx: number; cy: number } {
  return { cx: Math.floor(r.x + r.w / 2), cy: Math.floor(r.y + r.h / 2) };
}
export function dist2(a: Room, b: Room): number {
  const ca = roomCenter(a);
  const cb = roomCenter(b);
  return (ca.cx - cb.cx) ** 2 + (ca.cy - cb.cy) ** 2;
}
export function carveRoom(grid: Grid, r: Room): void {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid[y]![x] = Cell.Floor;
}
export function carveCell(grid: Grid, x: number, y: number, t: number): void {
  const { cols, rows } = gridSize(grid);
  for (let ty = 0; ty < t; ty++) for (let tx = 0; tx < t; tx++) {
    const nx = x + tx, ny = y + ty;
    if (nx > 0 && ny > 0 && nx < cols - 1 && ny < rows - 1) grid[ny]![nx] = Cell.Floor;
  }
}
export function carveCorridor(grid: Grid, a: Room, b: Room, rng: Rng): void {
  const ca = roomCenter(a), cb = roomCenter(b), t = 2;
  const stepH = (y: number) => { for (let x = Math.min(ca.cx, cb.cx); x <= Math.max(ca.cx, cb.cx); x++) carveCell(grid, x, y, t); };
  const stepV = (x: number) => { for (let y = Math.min(ca.cy, cb.cy); y <= Math.max(ca.cy, cb.cy); y++) carveCell(grid, x, y, t); };
  if (rng.chance(0.5)) { stepH(ca.cy); stepV(cb.cx); } else { stepV(ca.cx); stepH(cb.cy); }
}

/** Клетки Г-коридора между центрами (сначала по X либо по Y). */
function elbowCells(ca: { cx: number; cy: number }, cb: { cx: number; cy: number }, horizontalFirst: boolean): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  if (horizontalFirst) {
    for (let x = Math.min(ca.cx, cb.cx); x <= Math.max(ca.cx, cb.cx); x++) cells.push({ x, y: ca.cy });
    for (let y = Math.min(ca.cy, cb.cy); y <= Math.max(ca.cy, cb.cy); y++) cells.push({ x: cb.cx, y });
  } else {
    for (let y = Math.min(ca.cy, cb.cy); y <= Math.max(ca.cy, cb.cy); y++) cells.push({ x: ca.cx, y });
    for (let x = Math.min(ca.cx, cb.cx); x <= Math.max(ca.cx, cb.cx); x++) cells.push({ x, y: cb.cy });
  }
  return cells;
}
/** Сколько клеток коридора попадают ВНУТРЬ чужих комнат (не a/b) — «режет» комнату. */
function intrusion(cells: { x: number; y: number }[], rooms: Room[], a: Room, b: Room): number {
  let n = 0;
  for (const c of cells) {
    for (const r of rooms) {
      if (r === a || r === b) continue;
      if (c.x > r.x && c.x < r.x + r.w - 1 && c.y > r.y && c.y < r.y + r.h - 1) { n++; break; }
    }
  }
  return n;
}
/**
 * «Умный» коридор: выбирает колено (по X- или Y-оси первым), которое МЕНЬШЕ режет чужие комнаты;
 * прямой сегмент, если центры выровнены. Убирает коридоры, пересекающие сторонние комнаты (BSP).
 */
export function carveCorridorSmart(grid: Grid, a: Room, b: Room, rooms: Room[], rng: Rng): void {
  const ca = roomCenter(a), cb = roomCenter(b), t = 2;
  if (ca.cx === cb.cx || ca.cy === cb.cy) {
    for (const c of elbowCells(ca, cb, true)) carveCell(grid, c.x, c.y, t);
    return;
  }
  const p1 = elbowCells(ca, cb, true), p2 = elbowCells(ca, cb, false);
  const i1 = intrusion(p1, rooms, a, b), i2 = intrusion(p2, rooms, a, b);
  const pick = i1 < i2 ? p1 : i2 < i1 ? p2 : (rng.chance(0.5) ? p1 : p2);
  for (const c of pick) carveCell(grid, c.x, c.y, t);
}

/** Клетки, достижимые от (sx,sy) ТОЛЬКО по полу (двери/стены/колонны — непроходимы). */
export function floorReachable(grid: Grid, sx: number, sy: number): Set<string> {
  const { cols, rows } = gridSize(grid);
  const seen = new Set<string>([`${sx},${sy}`]);
  const q: [number, number][] = [[sx, sy]];
  for (let head = 0; head < q.length; head++) {
    const [x, y] = q[head]!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (grid[ny]![nx] !== Cell.Floor) continue;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  return seen;
}

export interface Entrance { cx: number; cy: number; ox: number; oy: number }

/** Первая клетка пола, шагая наружу от проёма. */
function firstFloorOutward(grid: Grid, e: Entrance): { cx: number; cy: number } | null {
  let cx = e.cx + e.ox, cy = e.cy + e.oy;
  for (let i = 0; i < 6; i++) {
    if (grid[cy]?.[cx] === Cell.Floor) return { cx, cy };
    cx += e.ox; cy += e.oy;
  }
  return null;
}

/**
 * Место рычага: НЕ вплотную к двери, а в нескольких клетках по достижимому полу.
 * BFS снаружи двери (все двери закрыты) → случайная клетка на удалении ≥ minStep.
 */
function leverSpot(grid: Grid, run: Entrance[], rng: Rng): { cx: number; cy: number } | null {
  let start: { cx: number; cy: number } | null = null;
  for (const e of run) { const f = firstFloorOutward(grid, e); if (f) { start = f; break; } }
  if (!start) return null;
  const { cols, rows } = gridSize(grid);
  const dist = new Map<string, number>([[`${start.cx},${start.cy}`, 0]]);
  const q: { cx: number; cy: number }[] = [start];
  for (let h = 0; h < q.length; h++) {
    const cur = q[h]!;
    const d = dist.get(`${cur.cx},${cur.cy}`)!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cur.cx + dx, ny = cur.cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (grid[ny]![nx] !== Cell.Floor) continue;
      const k = `${nx},${ny}`;
      if (dist.has(k)) continue;
      dist.set(k, d + 1); q.push({ cx: nx, cy: ny });
    }
  }
  const maxD = Math.max(...dist.values());
  const lo = Math.min(5, maxD);
  const hi = Math.min(14, maxD);
  const band = q.filter((c) => { const d = dist.get(`${c.cx},${c.cy}`) ?? 0; return d >= lo && d <= hi; });
  const atLeast = q.filter((c) => (dist.get(`${c.cx},${c.cy}`) ?? 0) >= lo);
  return rng.pick(band.length ? band : atLeast.length ? atLeast : q);
}

/** Разбивает клетки грани на смежные пробеги (каждый = отдельный дверной проём). */
function splitRuns(side: Entrance[]): Entrance[][] {
  if (side.length === 0) return [];
  const axis = (e: Entrance) => (side[0]!.oy !== 0 ? e.cx : e.cy);
  const sorted = [...side].sort((a, b) => axis(a) - axis(b));
  const runs: Entrance[][] = [[sorted[0]!]];
  for (let i = 1; i < sorted.length; i++) {
    if (axis(sorted[i]!) - axis(sorted[i - 1]!) === 1) runs[runs.length - 1]!.push(sorted[i]!);
    else runs.push([sorted[i]!]);
  }
  return runs;
}

/**
 * Запирает комнату: каждый входной проём (пробег клеток-полов на периметре) → дверь
 * (`Cell.Door`) + рычаг снаружи. Проём без места под рычаг оставляем открытым (пол).
 * Мутирует grid, дополняет doors/levers. Общий для всех алгоритмов с прямоуг. комнатами.
 */
export function lockRoom(grid: Grid, room: Room, doors: Door[], levers: Lever[], rng: Rng): void {
  const top: Entrance[] = [], bot: Entrance[] = [], left: Entrance[] = [], right: Entrance[] = [];
  for (let x = room.x; x < room.x + room.w; x++) {
    if (grid[room.y - 1]?.[x] === Cell.Floor) top.push({ cx: x, cy: room.y - 1, ox: 0, oy: -1 });
    if (grid[room.y + room.h]?.[x] === Cell.Floor) bot.push({ cx: x, cy: room.y + room.h, ox: 0, oy: 1 });
  }
  for (let y = room.y; y < room.y + room.h; y++) {
    if (grid[y]?.[room.x - 1] === Cell.Floor) left.push({ cx: room.x - 1, cy: y, ox: -1, oy: 0 });
    if (grid[y]?.[room.x + room.w] === Cell.Floor) right.push({ cx: room.x + room.w, cy: y, ox: 1, oy: 0 });
  }
  const runs: Entrance[][] = [];
  for (const side of [top, bot, left, right]) for (const run of splitRuns(side)) runs.push(run);
  const created: { id: number; run: Entrance[] }[] = [];
  for (const run of runs) {
    const id = doors.length + 1;
    for (const e of run) grid[e.cy]![e.cx] = Cell.Door;
    doors.push({ id, cells: run.map((e) => ({ cx: e.cx, cy: e.cy })) });
    created.push({ id, run });
  }
  for (const { id, run } of created) {
    const spot = leverSpot(grid, run, rng);
    if (spot) { const w = cellToWorld(spot.cx, spot.cy); levers.push({ id: levers.length + 1, x: w.x, y: w.y, doorId: id }); }
  }
}

/** Декор комнаты (сундук/арена/колонны/факелы). Колонны блокируют проход/обзор. */
export function decorate(r: Room, out: DecorObject[], rng: Rng, grid: Grid): void {
  const c = roomCenter(r);
  const center = cellToWorld(c.cx, c.cy);
  if (r.type === 'treasure') { out.push({ ...center, kind: 'chest' }); return; }
  if (r.type === 'boss') { out.push({ ...center, kind: 'arena' }); }
  if (r.type === 'large' && r.w >= 6 && r.h >= 6) {
    const spots: [number, number][] = [[2, 2], [r.w - 3, 2], [2, r.h - 3], [r.w - 3, r.h - 3]];
    for (const [dx, dy] of spots) {
      const cx = r.x + dx, cy = r.y + dy;
      grid[cy]![cx] = Cell.Pillar;
      out.push({ ...cellToWorld(cx, cy), kind: 'pillar' });
    }
  }
  if (rng.chance(0.8)) out.push({ ...cellToWorld(r.x + 1, r.y + 1), kind: 'torch' });
  if (rng.chance(0.8)) out.push({ ...cellToWorld(r.x + r.w - 2, r.y + r.h - 2), kind: 'torch' });
}

/**
 * Инвариант проходимости (общий для всех алгоритмов): (0) у каждой двери есть рычаг;
 * (1) каждый рычаг достижим от входа при ВСЕХ закрытых дверях; (2) лестница достижима,
 * когда все двери открыты. Если дверей нет — проверяется только связность spawn→stairs.
 */
export function validate(L: DungeonLayout): boolean {
  for (const d of L.doors) if (!L.levers.some((lv) => lv.doorId === d.id)) return false;
  const s = worldToCell(L.spawn.x, L.spawn.y);
  const closed = floorReachable(L.grid, s.cx, s.cy);
  for (const lv of L.levers) {
    const c = worldToCell(lv.x, lv.y);
    if (!closed.has(`${c.cx},${c.cy}`)) return false;
  }
  const g = L.grid.map((row) => row.slice());
  for (const d of L.doors) for (const c of d.cells) g[c.cy]![c.cx] = Cell.Floor;
  const open = floorReachable(g, s.cx, s.cy);
  // Каждый выход должен быть достижим при открытых дверях (не только stairsDown).
  const exits = L.exits.length ? L.exits : [L.stairsDown];
  for (const ex of exits) {
    const st = worldToCell(ex.x, ex.y);
    if (!open.has(`${st.cx},${st.cy}`)) return false;
  }
  return true;
}
