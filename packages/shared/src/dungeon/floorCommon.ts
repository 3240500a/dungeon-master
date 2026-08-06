import type { Rng } from '../formulas/rng.js';
import { Cell, cellToWorld, worldToCell, gridSize, type Grid } from '../world/grid.js';

/**
 * Общие типы и helper'ы поклеточной генерации этажа, разделяемые ВСЕМИ алгоритмами
 * (rooms/bsp/cellular/…). Вынесено из `generate.ts`, чтобы новый алгоритм переиспользовал
 * замки «дверь↔рычаг», декор и инвариант проходимости, а не дублировал их.
 */

export type RoomType = 'entrance' | 'small' | 'large' | 'treasure' | 'boss';

/** Форма комнаты (заливка интерьера; bbox x/y/w/h всегда прямоуг. — для связности). */
export type RoomShape = 'rect' | 'ell' | 'blob' | 'round' | 'hall';

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  type: RoomType;
  /** Форма интерьера (rect по умолчанию). */
  shape?: RoomShape;
  /** Спец-содержимое комнаты (для спавна): чемпионы / босс / сокровищница. */
  content?: 'unique' | 'boss' | 'treasure';
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

/**
 * Взаимное расположение bbox'ов двух комнат: «смотрят» ли они друг на друга гранью (перекрытие
 * проекций по одной оси) и зазор между ними. `axis:'h'` — комнаты бок-о-бок (проход вдоль X,
 * перекрытие по Y в [lo,hi]); `axis:'v'` — одна над другой (проход вдоль Y, перекрытие по X).
 * null — комнаты «по диагонали» (проекции не перекрываются) → нужен Г-коридор.
 */
export function roomFacing(a: Room, b: Room): { axis: 'h' | 'v'; lo: number; hi: number; gap: number } | null {
  const yLo = Math.max(a.y, b.y), yHi = Math.min(a.y + a.h, b.y + b.h);
  const xLo = Math.max(a.x, b.x), xHi = Math.min(a.x + a.w, b.x + b.w);
  let hGap = Infinity;
  if (yHi - yLo >= 2) { // перекрытие по Y → возможен горизонтальный проход
    if (a.x + a.w <= b.x) hGap = b.x - (a.x + a.w);
    else if (b.x + b.w <= a.x) hGap = a.x - (b.x + b.w);
  }
  let vGap = Infinity;
  if (xHi - xLo >= 2) {
    if (a.y + a.h <= b.y) vGap = b.y - (a.y + a.h);
    else if (b.y + b.h <= a.y) vGap = a.y - (b.y + b.h);
  }
  if (!isFinite(hGap) && !isFinite(vGap)) return null;
  return hGap <= vGap ? { axis: 'h', lo: yLo, hi: yHi, gap: hGap } : { axis: 'v', lo: xLo, hi: xHi, gap: vGap };
}

/**
 * Соединяет две комнаты БЕЗ дублей-параллелей: если они «смотрят» гранью (перекрытие проекций) —
 * ПРЯМОЙ проём/короткий коридор шириной `width` сквозь зазор в зоне перекрытия (стаб на 1-2 клетки
 * внутрь обеих комнат, чтобы дойти до пола даже у фигурных комнат); иначе (диагональ) — Г-коридор
 * с наименьшим пересечением чужих комнат. Мутирует grid.
 */
/** Позиция полосы шириной `w` в [lo,hi): предпочесть место, где `ok(pos)` на всех w линиях (пол у грани). */
function pickStrip(lo: number, hi: number, w: number, ok: (p: number) => boolean, rng: Rng): number {
  const good: number[] = [];
  for (let s = lo; s + w <= hi; s++) { let g = true; for (let k = 0; k < w && g; k++) if (!ok(s + k)) g = false; if (g) good.push(s); }
  if (good.length) return good[rng.int(0, good.length - 1)]!;
  return lo + (hi - lo > w ? rng.int(0, hi - lo - w) : 0);
}

export function connectRooms(grid: Grid, a: Room, b: Room, rooms: Room[], width: number, rng: Rng): void {
  const f = roomFacing(a, b);
  if (!f) { carveCorridorSmart(grid, a, b, rooms, rng); return; }
  const F = (x: number, y: number): boolean => grid[y]?.[x] === Cell.Floor;
  const w = Math.max(1, Math.min(width, f.hi - f.lo));
  if (f.axis === 'h') {
    const left = a.x <= b.x ? a : b, right = a.x <= b.x ? b : a;
    const lE = left.x + left.w - 1, rE = right.x, lc = roomCenter(left).cx, rc = roomCenter(right).cx;
    const start = pickStrip(f.lo, f.hi, w, (y) => F(lE, y) && F(rE, y), rng);
    for (let dy = 0; dy < w; dy++) {
      const y = start + dy;
      for (let x = lE; x <= rE; x++) carveCell(grid, x, y, 1);                       // проём/коридор через зазор
      for (let x = lE - 1; x > lc; x--) { if (F(x, y)) break; carveCell(grid, x, y, 1); } // стаб в левую комнату до пола
      for (let x = rE + 1; x < rc; x++) { if (F(x, y)) break; carveCell(grid, x, y, 1); } // стаб в правую комнату до пола
    }
  } else {
    const top = a.y <= b.y ? a : b, bot = a.y <= b.y ? b : a;
    const tE = top.y + top.h - 1, bE = bot.y, tc = roomCenter(top).cy, bc = roomCenter(bot).cy;
    const start = pickStrip(f.lo, f.hi, w, (x) => F(x, tE) && F(x, bE), rng);
    for (let dx = 0; dx < w; dx++) {
      const x = start + dx;
      for (let y = tE; y <= bE; y++) carveCell(grid, x, y, 1);
      for (let y = tE - 1; y > tc; y--) { if (F(x, y)) break; carveCell(grid, x, y, 1); }
      for (let y = bE + 1; y < bc; y++) { if (F(x, y)) break; carveCell(grid, x, y, 1); }
    }
  }
}

/**
 * Заливает комнату по ФОРМЕ (bbox остаётся прямоугольным — для связности): rect (весь bbox),
 * ell (вырез угла — L/T), blob (1-2 «укуса» по краям), round (скошенные углы — октагон),
 * hall (колонны сеткой). Для НЕ-rect гарантируем центральный «крест» (2 полосы через центр — пол):
 * это (1) держит комнату связной и (2) даёт `connectRooms` куда «дотянуть» проём. Маленькие комнаты
 * → rect (формы на них выглядят плохо / не помещаются). Мутирует grid.
 */
export function carveRoomShaped(grid: Grid, room: Room, shape: RoomShape, rng: Rng): void {
  carveRoom(grid, room);
  const big = room.w >= 7 && room.h >= 6;
  if (shape === 'rect' || !big) return;
  const cx = roomCenter(room).cx, cy = roomCenter(room).cy;
  const { cols, rows } = gridSize(grid);
  // Режем клетки комнаты В ЛЮБОМ месте bbox (включая внешнее кольцо) → внешняя граница формы НЕ прямоугольник.
  // Ограничение — только рамка грида (её не трогаем). Связность гарантирует центральный крест ниже.
  const wallIn = (x: number, y: number): void => {
    if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1 && x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) grid[y]![x] = Cell.Wall;
  };
  if (shape === 'ell') {
    const cw = rng.int(Math.floor(room.w * 0.35), Math.floor(room.w * 0.5));
    const ch = rng.int(Math.floor(room.h * 0.35), Math.floor(room.h * 0.5));
    const corner = rng.int(0, 3);
    const x0 = (corner & 1) ? room.x + room.w - cw : room.x, y0 = (corner & 2) ? room.y + room.h - ch : room.y;
    for (let y = y0; y < y0 + ch; y++) for (let x = x0; x < x0 + cw; x++) wallIn(x, y);
  } else if (shape === 'round') {
    // Эллипс-маска: клетки вне вписанного овала → стена (чёткая круглая/овальная комната).
    const rx = room.w / 2, ry = room.h / 2, ecx = room.x + rx - 0.5, ecy = room.y + ry - 0.5;
    for (let y = room.y; y < room.y + room.h; y++) for (let x = room.x; x < room.x + room.w; x++) {
      const nx = (x - ecx) / rx, ny = (y - ecy) / ry;
      if (nx * nx + ny * ny > 1.0) wallIn(x, y);
    }
  } else if (shape === 'blob') {
    for (let k = 0, bites = rng.int(1, 2); k < bites; k++) {
      const bw = rng.int(2, Math.max(2, Math.floor(room.w * 0.3))), bh = rng.int(2, Math.max(2, Math.floor(room.h * 0.3)));
      const side = rng.int(0, 3);
      const x0 = side === 3 ? room.x + room.w - bw : side === 2 ? room.x : room.x + rng.int(0, room.w - bw);
      const y0 = side === 1 ? room.y + room.h - bh : side === 0 ? room.y : room.y + rng.int(0, room.h - bh);
      for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) wallIn(x, y);
    }
  } else if (shape === 'hall') {
    for (let y = room.y + 2; y < room.y + room.h - 1; y += 3) for (let x = room.x + 2; x < room.x + room.w - 1; x += 3) if (grid[y]![x] === Cell.Floor) grid[y]![x] = Cell.Pillar;
  }
  // Центральный крест (1 полоса) — пол: связность интерьера + посадка проёмов из connectRooms (тонкий, не размывает форму).
  for (let x = room.x; x < room.x + room.w; x++) grid[cy]![x] = Cell.Floor;
  for (let y = room.y; y < room.y + room.h; y++) grid[y]![cx] = Cell.Floor;
}

/** Взвешенный выбор формы комнаты из весов (rect по умолчанию доминирует). */
export function pickShape(weights: Record<RoomShape, number>, rng: Rng): RoomShape {
  const order: RoomShape[] = ['rect', 'ell', 'blob', 'round', 'hall'];
  const total = order.reduce((s, k) => s + Math.max(0, weights[k] ?? 0), 0);
  if (total <= 0) return 'rect';
  let r = rng.float(0, total);
  for (const k of order) { r -= Math.max(0, weights[k] ?? 0); if (r <= 0) return k; }
  return 'rect';
}

/**
 * Граф соседства комнат: кандидаты рёбер = граф Габриэля центров (планарный, ⊇ EMST → связен, без
 * пересечений) ∪ «смотрящие гранью» пары с зазором ≤ `maxGap` (естественные двери между соседями).
 */
export function neighborEdges(rooms: Room[], maxGap = 8): [number, number][] {
  const n = rooms.length;
  const c = rooms.map(roomCenter);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let gabriel = true; // ни один другой центр не внутри окружности с диаметром (ci,cj)
    for (let k = 0; k < n && gabriel; k++) {
      if (k === i || k === j) continue;
      const d = (c[k]!.cx - c[i]!.cx) * (c[k]!.cx - c[j]!.cx) + (c[k]!.cy - c[i]!.cy) * (c[k]!.cy - c[j]!.cy);
      if (d < 0) gabriel = false; // угол при k тупой → внутри
    }
    const f = roomFacing(rooms[i]!, rooms[j]!);
    if (gabriel || (f && f.gap <= maxGap)) out.push([i, j]);
  }
  return out;
}

/**
 * Связность через граф соседства: MST (Kruskal по рёбрам соседства, вес = дистанция) — база и
 * гарантия проходимости; браид добавляет ОСТАВШИЕСЯ рёбра соседства (≈`loops×комнат`, приоритет
 * ДАЛЁКИХ в графе — крупные обходы) → каждое ребро режется РОВНО раз ⇒ НЕТ параллельных дублей.
 * `branch` (спавн/выход) дотягиваются до степени ≥2; `excludeIdx` (запертый босс) вне петель.
 * Возвращает число петель (альтернативные маршруты). Мутирует grid.
 */
export function connectByNeighborGraph(
  grid: Grid,
  rooms: Room[],
  opts: { loops: number; excludeIdx?: number; branch?: number[]; width?: number },
  rng: Rng,
): number {
  const n = rooms.length;
  if (n <= 1) return 0;
  const width = opts.width ?? 2;
  const excl = opts.excludeIdx ?? -1;
  const key = (i: number, j: number): string => (i < j ? `${i}-${j}` : `${j}-${i}`);
  const cand = neighborEdges(rooms);
  const candSet = new Set(cand.map(([i, j]) => key(i, j)));

  // Union-find для MST.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
  const union = (a: number, b: number): boolean => { const ra = find(a), rb = find(b); if (ra === rb) return false; parent[ra] = rb; return true; };

  const carved = new Set<string>();
  const adj: number[][] = rooms.map(() => []);
  const carve = (i: number, j: number): void => {
    const k = key(i, j); if (carved.has(k)) return; carved.add(k);
    connectRooms(grid, rooms[i]!, rooms[j]!, rooms, width, rng);
    adj[i]!.push(j); adj[j]!.push(i);
  };

  // MST по рёбрам соседства.
  const cw = cand.map(([i, j]) => ({ i, j, w: dist2(rooms[i]!, rooms[j]!) })).sort((a, b) => a.w - b.w);
  for (const e of cw) if (union(e.i, e.j)) carve(e.i, e.j);
  // Страховка связности: если граф соседства не покрыл всё — соединяем ближайшие пары через компоненты.
  const allPairs: { i: number; j: number; w: number }[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) allPairs.push({ i, j, w: dist2(rooms[i]!, rooms[j]!) });
  allPairs.sort((a, b) => a.w - b.w);
  for (const p of allPairs) if (union(p.i, p.j)) carve(p.i, p.j);

  // Браид: оставшиеся рёбра соседства, приоритет далёких в графе (крупные обходы).
  const bfs = (src: number): number[] => {
    const d = new Array<number>(n).fill(-1); d[src] = 0; const q = [src];
    for (let h = 0; h < q.length; h++) { const u = q[h]!; for (const v of adj[u]!) if (d[v] === -1) { d[v] = d[u]! + 1; q.push(v); } }
    return d;
  };
  let loops = 0;
  let budget = Math.round(opts.loops * n);
  while (budget-- > 0) {
    const dc = new Map<number, number[]>();
    let bi = -1, bj = -1, best = -Infinity;
    for (let i = 0; i < n; i++) {
      if (i === excl) continue;
      let di = dc.get(i); if (!di) { di = bfs(i); dc.set(i, di); }
      for (let j = i + 1; j < n; j++) {
        if (j === excl || carved.has(key(i, j)) || !candSet.has(key(i, j))) continue;
        const gd = di[j]!; if (gd < 2) continue;
        const s = gd * 100 - Math.sqrt(dist2(rooms[i]!, rooms[j]!));
        if (s > best) { best = s; bi = i; bj = j; }
      }
    }
    if (bi < 0) break;
    carve(bi, bj); loops++;
  }

  // Спавн/выход → степень ≥2 (несколько подходов): предпочесть ребро соседства, иначе ближайшую комнату.
  for (const idx of opts.branch ?? []) {
    if (idx < 0 || idx === excl || adj[idx]!.length >= 2) continue;
    let bj = -1, bd = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === idx || j === excl || carved.has(key(idx, j))) continue;
      const d = (candSet.has(key(idx, j)) ? 0 : 1e9) + dist2(rooms[idx]!, rooms[j]!);
      if (d < bd) { bd = d; bj = j; }
    }
    if (bj >= 0) carve(idx, bj);
  }
  return loops;
}

/** Пара комнат с МАКСИМАЛЬНОЙ дистанцией центров (для разнесения спавна и выхода). */
export function farthestPair(rooms: Room[]): [number, number] {
  const n = rooms.length;
  if (n <= 1) return [0, 0];
  let bi = 0, bj = 1, bd = -1;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = dist2(rooms[i]!, rooms[j]!); if (d > bd) { bd = d; bi = i; bj = j; }
  }
  return [bi, bj];
}

/**
 * Выбор комнат спавна/выхода по режиму: `farthest` — самая дальняя пара (спавн не привязан к углу);
 * `random` — спавн случайный, выход дальше всего от него; `corner` — старое (спавн=комната 0).
 */
export function pickSpawnExit(rooms: Room[], mode: 'farthest' | 'random' | 'corner', rng: Rng): [number, number] {
  const n = rooms.length;
  if (n <= 1) return [0, 0];
  const farthestFrom = (s: number): number => {
    let f = s === 0 ? 1 : 0, fd = -1;
    for (let i = 0; i < n; i++) { if (i === s) continue; const d = dist2(rooms[s]!, rooms[i]!); if (d > fd) { fd = d; f = i; } }
    return f;
  };
  if (mode === 'corner') return [0, farthestFrom(0)];
  if (mode === 'random') { const s = rng.int(0, n - 1); return [s, farthestFrom(s)]; }
  return farthestPair(rooms);
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

/** Все компоненты связности пола (4-связность), каждая — список клеток. Пусто, если пола нет. */
export function floorComponents(grid: Grid): { cx: number; cy: number }[][] {
  const { cols, rows } = gridSize(grid);
  const seen = new Set<string>();
  const comps: { cx: number; cy: number }[][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (grid[y]![x] !== Cell.Floor || seen.has(`${x},${y}`)) continue;
    const reached = floorReachable(grid, x, y);
    const comp: { cx: number; cy: number }[] = [];
    for (const k of reached) { seen.add(k); const [cx, cy] = k.split(',').map(Number) as [number, number]; comp.push({ cx, cy }); }
    comps.push(comp);
  }
  return comps;
}

/**
 * Гарантирует единую компоненту пола: сливает все полости в ту, что содержит `spawn`, прокапывая
 * прямой L-тоннель (гориз.+верт., шириной 1) от каждой посторонней компоненты к ближайшей клетке
 * главной. Нужно после врезки префаб-камер в органику (пещеры/лабиринт), где стена-кольцо префаба
 * могла разрезать этаж. Мутирует grid; связность после — гарантированно одна компонента.
 */
export function reconnectFloor(grid: Grid, spawn: { cx: number; cy: number }, _rng: Rng): void {
  for (let guard = 0; guard < 64; guard++) {
    const main = floorReachable(grid, spawn.cx, spawn.cy);
    // Первая клетка пола вне главной компоненты.
    const comps = floorComponents(grid);
    const outside = comps.find((c) => !main.has(`${c[0]!.cx},${c[0]!.cy}`));
    if (!outside) return; // всё в одной компоненте
    // Клетка посторонней компоненты, ближайшая к любой клетке главной (по манхэттену).
    let best: { a: { cx: number; cy: number }; b: { cx: number; cy: number }; d: number } | null = null;
    const mainCells = [...main].map((k) => { const [cx, cy] = k.split(',').map(Number) as [number, number]; return { cx, cy }; });
    for (const a of outside) for (const b of mainCells) {
      const d = Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy);
      if (!best || d < best.d) best = { a, b, d };
    }
    if (!best) return;
    // L-тоннель a→b: сначала по X, затем по Y.
    const { a, b } = best;
    const sx = Math.sign(b.cx - a.cx) || 1;
    for (let x = a.cx; x !== b.cx; x += sx) carveCell(grid, x, a.cy, 1);
    const sy = Math.sign(b.cy - a.cy) || 1;
    for (let y = a.cy; y !== b.cy; y += sy) carveCell(grid, b.cx, y, 1);
    carveCell(grid, b.cx, b.cy, 1);
  }
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
      if (grid[cy]?.[cx] !== Cell.Floor) continue;   // клетка-стена/пустота (нерегулярная комната) → не «замуровываем» колонну
      grid[cy]![cx] = Cell.Pillar;
      out.push({ ...cellToWorld(cx, cy), kind: 'pillar' });
    }
  }
  // Факелы — только на клетке-полу (углы нерегулярной комнаты часто стена). rng.chance зовём всегда (детерминизм сида).
  const t1x = r.x + 1, t1y = r.y + 1, t2x = r.x + r.w - 2, t2y = r.y + r.h - 2;
  if (rng.chance(0.8) && grid[t1y]?.[t1x] === Cell.Floor) out.push({ ...cellToWorld(t1x, t1y), kind: 'torch' });
  if (rng.chance(0.8) && grid[t2y]?.[t2x] === Cell.Floor) out.push({ ...cellToWorld(t2x, t2y), kind: 'torch' });
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
