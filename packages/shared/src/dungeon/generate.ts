import { createRng, type Rng } from '../formulas/rng.js';
import { Cell, makeGrid, cellToWorld, worldToCell, gridSize, type Grid } from '../world/grid.js';

/**
 * Headless-генератор этажа (чистый: сид-rng + сетка). Комнаты (MST-связь + петли),
 * декор, и ЗАМКИ по модели «дверь ↔ рычаг»: каждый запертый проём — короткий спан
 * `Cell.Door` + СВОЙ рычаг снаружи; рычаг открывает ТОЛЬКО свою дверь. Инвариант
 * (`validate`): каждый рычаг достижим при всех закрытых дверях, лестница — после открытия
 * всех дверей; иначе перегенерация (или фолбэк — снять замки). Софт-локов не бывает.
 */

export type RoomType = 'entrance' | 'small' | 'large' | 'treasure' | 'boss';

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  type: RoomType;
}

export interface DecorObject {
  x: number;
  y: number;
  kind: 'pillar' | 'torch' | 'chest' | 'arena';
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
  stairsDown: { x: number; y: number };
  decor: DecorObject[];
  doors: Door[];
  levers: Lever[];
}

function roomCenter(r: Room): { cx: number; cy: number } {
  return { cx: Math.floor(r.x + r.w / 2), cy: Math.floor(r.y + r.h / 2) };
}
function dist2(a: Room, b: Room): number {
  const ca = roomCenter(a);
  const cb = roomCenter(b);
  return (ca.cx - cb.cx) ** 2 + (ca.cy - cb.cy) ** 2;
}
function carveRoom(grid: Grid, r: Room): void {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid[y]![x] = Cell.Floor;
}
function carveCell(grid: Grid, x: number, y: number, t: number): void {
  const { cols, rows } = gridSize(grid);
  for (let ty = 0; ty < t; ty++) for (let tx = 0; tx < t; tx++) {
    const nx = x + tx, ny = y + ty;
    if (nx > 0 && ny > 0 && nx < cols - 1 && ny < rows - 1) grid[ny]![nx] = Cell.Floor;
  }
}
function carveCorridor(grid: Grid, a: Room, b: Room, rng: Rng): void {
  const ca = roomCenter(a), cb = roomCenter(b), t = 2;
  const stepH = (y: number) => { for (let x = Math.min(ca.cx, cb.cx); x <= Math.max(ca.cx, cb.cx); x++) carveCell(grid, x, y, t); };
  const stepV = (x: number) => { for (let y = Math.min(ca.cy, cb.cy); y <= Math.max(ca.cy, cb.cy); y++) carveCell(grid, x, y, t); };
  if (rng.chance(0.5)) { stepH(ca.cy); stepV(cb.cx); } else { stepV(ca.cx); stepH(cb.cy); }
}

/** Клетки, достижимые от (sx,sy) ТОЛЬКО по полу (двери/стены/колонны — непроходимы). */
function floorReachable(grid: Grid, sx: number, sy: number): Set<string> {
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

interface Entrance { cx: number; cy: number; ox: number; oy: number }

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
 * BFS снаружи двери (все двери закрыты) → случайная клетка на удалении ≥ minStep
 * (но досягаемая, чтобы держать инвариант). null — если снаружи вообще нет пола.
 */
function leverSpot(grid: Grid, run: Entrance[], rng: Rng): { cx: number; cy: number } | null {
  let start: { cx: number; cy: number } | null = null;
  for (const e of run) { const f = firstFloorOutward(grid, e); if (f) { start = f; break; } } // любой проём даёт наружный пол
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
  const lo = Math.min(5, maxD);   // не вплотную к двери
  const hi = Math.min(14, maxD);  // но и не через всю карту — рядом, но поискать
  const band = q.filter((c) => { const d = dist.get(`${c.cx},${c.cy}`) ?? 0; return d >= lo && d <= hi; });
  const atLeast = q.filter((c) => (dist.get(`${c.cx},${c.cy}`) ?? 0) >= lo);
  return rng.pick(band.length ? band : atLeast.length ? atLeast : q);
}

/** Разбивает клетки грани на смежные пробеги (каждый = отдельный дверной проём). */
function splitRuns(side: Entrance[]): Entrance[][] {
  if (side.length === 0) return [];
  const axis = (e: Entrance) => (side[0]!.oy !== 0 ? e.cx : e.cy); // вдоль грани
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
 * (`Cell.Door`) + рычаг снаружи. Проём без места под рычаг оставляем открытым (пол),
 * чтобы не было двери без рычага (софт-лок). Мутирует grid, дополняет doors/levers.
 */
function lockRoom(grid: Grid, room: Room, doors: Door[], levers: Lever[], rng: Rng): void {
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
  // 1) сначала закрываем ВСЕ проёмы дверьми — тогда BFS для рычага корректно видит замки.
  const created: { id: number; run: Entrance[] }[] = [];
  for (const run of runs) {
    const id = doors.length + 1;
    for (const e of run) grid[e.cy]![e.cx] = Cell.Door;
    doors.push({ id, cells: run.map((e) => ({ cx: e.cx, cy: e.cy })) });
    created.push({ id, run });
  }
  // 2) рычаги — снаружи, НЕ вплотную к двери (leverSpot). Дверь без места под рычаг отбракует validate.
  for (const { id, run } of created) {
    const spot = leverSpot(grid, run, rng);
    if (spot) { const w = cellToWorld(spot.cx, spot.cy); levers.push({ id: levers.length + 1, x: w.x, y: w.y, doorId: id }); }
  }
}

function decorate(r: Room, out: DecorObject[], rng: Rng, grid: Grid): void {
  const c = roomCenter(r);
  const center = cellToWorld(c.cx, c.cy);
  if (r.type === 'treasure') { out.push({ ...center, kind: 'chest' }); return; }
  if (r.type === 'boss') { out.push({ ...center, kind: 'arena' }); }
  if (r.type === 'large') {
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

/** Один прогон генерации (без гарантии проходимости — её проверяет `validate`). */
function buildLayout(seed: number, depth: number, cols: number, rows: number): DungeonLayout {
  const rng = createRng(seed + depth * 7919);
  const grid = makeGrid(cols, rows, Cell.Wall);

  const roomCount = Math.min(12, 6 + Math.floor(depth / 2));
  const rooms: Room[] = [];
  let attempts = 0;
  while (rooms.length < roomCount && attempts < 400) {
    attempts++;
    const big = rng.chance(0.3);
    const w = big ? rng.int(10, 14) : rng.int(5, 8);
    const h = big ? rng.int(8, 11) : rng.int(4, 7);
    const x = rng.int(1, cols - w - 1);
    const y = rng.int(1, rows - h - 1);
    if (rooms.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) continue;
    rooms.push({ x, y, w, h, type: 'small' });
  }

  const n = rooms.length;
  let farIdx = 0, farD = -1;
  for (let i = 1; i < n; i++) { const d = dist2(rooms[0]!, rooms[i]!); if (d > farD) { farD = d; farIdx = i; } }
  const treasureIdx = n > 3 ? (farIdx === 1 ? 2 : 1) : -1;
  rooms.forEach((r, i) => {
    r.type = i === 0 ? 'entrance' : i === farIdx ? 'boss' : i === treasureIdx ? 'treasure' : (r.w * r.h >= 80 ? 'large' : 'small');
  });
  for (const r of rooms) carveRoom(grid, r);

  const edgeKey = (i: number, j: number) => (i < j ? `${i}-${j}` : `${j}-${i}`);
  const used = new Set<string>();
  if (n > 1) {
    const inTree = new Array(n).fill(false); inTree[0] = true;
    for (let k = 1; k < n; k++) {
      let bi = -1, bj = -1, bd = Infinity;
      for (let i = 0; i < n; i++) if (inTree[i]) for (let j = 0; j < n; j++) if (!inTree[j]) {
        const d = dist2(rooms[i]!, rooms[j]!); if (d < bd) { bd = d; bi = i; bj = j; }
      }
      if (bj >= 0) { inTree[bj] = true; used.add(edgeKey(bi, bj)); carveCorridor(grid, rooms[bi]!, rooms[bj]!, rng); }
    }
    const pairs: [number, number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (i === farIdx || j === farIdx) continue; // босс — не в петлях (запирается)
      if (!used.has(edgeKey(i, j))) pairs.push([i, j, dist2(rooms[i]!, rooms[j]!)]);
    }
    pairs.sort((a, b) => a[2] - b[2]);
    for (let k = 0; k < Math.max(1, Math.floor(n * 0.25)) && k < pairs.length; k++) {
      const [i, j] = pairs[k]!; carveCorridor(grid, rooms[i]!, rooms[j]!, rng);
    }
  }

  // Замок: комната-босс (в ней лестница-вниз). Дискретные ворота + рычаги.
  const doors: Door[] = [];
  const levers: Lever[] = [];
  const boss = farIdx !== 0 ? rooms[farIdx] : undefined;
  if (boss) lockRoom(grid, boss, doors, levers, rng);

  const decor: DecorObject[] = [];
  for (const r of rooms) decorate(r, decor, rng, grid);

  const first = roomCenter(rooms[0]!);
  const last = roomCenter(boss ?? rooms[0]!);
  return {
    grid, rooms,
    spawn: cellToWorld(first.cx, first.cy),
    stairsDown: cellToWorld(last.cx, last.cy),
    decor, doors, levers,
  };
}

/**
 * Инвариант проходимости: (1) КАЖДЫЙ рычаг достижим от входа с ВСЕМИ дверями закрытыми
 * (рычаг не за дверью); (2) лестница достижима, когда все двери открыты. При условии, что
 * у каждой двери есть рычаг (гарантирует `lockRoom`), из этого следует, что этаж проходим.
 */
function validate(L: DungeonLayout): boolean {
  // (0) у каждой двери есть рычаг (иначе её нечем открыть → софт-лок).
  for (const d of L.doors) if (!L.levers.some((lv) => lv.doorId === d.id)) return false;
  const s = roomCenter(L.rooms[0]!);
  const closed = floorReachable(L.grid, s.cx, s.cy);
  for (const lv of L.levers) {
    const c = worldToCell(lv.x, lv.y);
    if (!closed.has(`${c.cx},${c.cy}`)) return false;
  }
  const g = L.grid.map((row) => row.slice());
  for (const d of L.doors) for (const c of d.cells) g[c.cy]![c.cx] = Cell.Floor;
  const open = floorReachable(g, s.cx, s.cy);
  const st = worldToCell(L.stairsDown.x, L.stairsDown.y);
  return open.has(`${st.cx},${st.cy}`);
}

/**
 * Генерация этажа с ГАРАНТИЕЙ проходимости: генерим и валидируем (детерминированные
 * перегенерации сид-сдвигом), при неудаче — фолбэк без замков (двери → пол).
 */
export function generateDungeon(seed: number, depth: number, opts: { cols?: number; rows?: number } = {}): DungeonLayout {
  const cols = opts.cols ?? 56;
  const rows = opts.rows ?? 42;
  for (let attempt = 0; attempt < 16; attempt++) {
    const L = buildLayout(seed + attempt * 104729, depth, cols, rows);
    if (validate(L)) return L;
  }
  // Фолбэк: не запирать (снять двери) — этаж заведомо проходим.
  const L = buildLayout(seed, depth, cols, rows);
  for (const d of L.doors) for (const c of d.cells) L.grid[c.cy]![c.cx] = Cell.Floor;
  L.doors = [];
  L.levers = [];
  return L;
}
