import type { Rng } from '../formulas/rng.js';
import { Cell, cellToWorld, gridSize, type Grid } from '../world/grid.js';
import type { RoomPrefab } from '../config/schemas.js';
import type { Room, DecorObject } from './floorCommon.js';

/**
 * Хелперы рукотворных префабов комнат/этажей (рисуются по клеткам в редакторе, конфиг `room-prefabs`).
 * `terrain`: '.'/'+' → пол ('+' = помеченный проём, где комната стыкуется с коридором — функционально пол),
 * '#' → стена, 'o' → колонна. `zones`: ' 'нет 'd'декор 'm'монстр 'c'сундук 'e'вход 'x'выход. Чистые (без DOM).
 */

const TERR_TO_CELL: Record<string, Cell> = { '.': Cell.Floor, '+': Cell.Floor, '#': Cell.Wall, o: Cell.Pillar };

/** Строки сетки, повёрнутые на 90° по часовой (w×h → h×w). */
export function rotateRowsCW(rows: string[], w: number, h: number, fill: string): string[] {
  const out: string[] = [];
  for (let nr = 0; nr < w; nr++) { let row = ''; for (let nc = 0; nc < h; nc++) row += rows[h - 1 - nc]?.[nr] ?? fill; out.push(row); }
  return out;
}
export function mirrorRows(rows: string[]): string[] { return rows.map((r) => [...r].reverse().join('')); }

/** Копия префаба, повёрнутая на 90° CW (terrain+zones+w/h). */
export function rotatePrefabCW(p: RoomPrefab): RoomPrefab {
  return { ...p, w: p.h, h: p.w, terrain: rotateRowsCW(p.terrain, p.w, p.h, ' '), zones: rotateRowsCW(p.zones, p.w, p.h, ' ') };
}
/** Копия префаба, отражённая по горизонтали. */
export function mirrorPrefab(p: RoomPrefab): RoomPrefab {
  return { ...p, terrain: mirrorRows(p.terrain), zones: mirrorRows(p.zones) };
}
/** Случайная ориентация (0/90/180/270 + опц. зеркало) — для вариативности при вставке в этаж. */
export function orientPrefab(p: RoomPrefab, rng: Rng): RoomPrefab {
  let q = p;
  const rot = rng.int(0, 3);
  for (let i = 0; i < rot; i++) q = rotatePrefabCW(q);
  if (rng.chance(0.5)) q = mirrorPrefab(q);
  return q;
}

/** Штампует террейн префаба в grid со смещением (ox,oy). Клетки-пустоты (' ') пропускаются
 *  (грид не трогается — так форма префаба ПРОИЗВОЛЬНАЯ, а не прямоугольный bbox). Мутирует grid. */
export function stampPrefabTerrain(grid: Grid, p: RoomPrefab, ox: number, oy: number): void {
  const rows = grid.length, cols = grid[0]?.length ?? 0;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const gx = ox + x, gy = oy + y;
    if (gx <= 0 || gy <= 0 || gx >= cols - 1 || gy >= rows - 1) continue; // рамку грида не трогаем
    const cell = TERR_TO_CELL[p.terrain[y]?.[x] ?? ' '];
    if (cell === undefined) continue; // ' ' (пусто) и неизвестные символы — клетка вне формы, пропускаем
    grid[gy]![gx] = cell;
  }
}

/** Обрезает префаб до габаритов НАРИСОВАННОГО (не-пустых клеток) — «размер из рисунка». Пусто → без изменений. */
export function trimPrefab(p: RoomPrefab): { terrain: string[]; zones: string[]; w: number; h: number } {
  let x0 = p.w, y0 = p.h, x1 = -1, y1 = -1;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    if ((p.terrain[y]?.[x] ?? ' ') !== ' ') { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return { terrain: p.terrain, zones: p.zones, w: p.w, h: p.h }; // ничего не нарисовано
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  const terrain: string[] = [], zones: string[] = [];
  for (let y = y0; y <= y1; y++) {
    terrain.push((p.terrain[y] ?? '').slice(x0, x1 + 1).padEnd(nw, ' '));
    zones.push((p.zones[y] ?? '').slice(x0, x1 + 1).padEnd(nw, ' '));
  }
  return { terrain, zones, w: nw, h: nh };
}

/** Клетки зон заданного типа в мировых координатах-клетках (для decor/spawn/exit/монстров). */
export function prefabZoneCells(p: RoomPrefab, ox: number, oy: number, kind: string): { cx: number; cy: number }[] {
  const out: { cx: number; cy: number }[] = [];
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (p.zones[y]?.[x] === kind) out.push({ cx: ox + x, cy: oy + y });
  return out;
}

/**
 * Пытается поставить рукотворный room-префаб В КОМНАТУ вместо процедурной формы: подбирает
 * подходящий по размеру (с учётом поворота), РЕЗАЙЗИТ bbox комнаты под префаб (центрируя в слоте),
 * штампует террейн, выкладывает декор из зон d(факел)/c(сундук). Связность добьёт `connectRooms`
 * (предпочтёт floor-грани, в т.ч. проёмы '+'). Возвращает true, если префаб поставлен.
 */
export function stampRoomPrefab(grid: Grid, room: Room, prefabs: RoomPrefab[], decor: DecorObject[], rng: Rng): boolean {
  const fits: { p: RoomPrefab; rot: boolean }[] = [];
  for (const p of prefabs) {
    if (p.enabled === false || p.scope !== 'room' || p.w < 3 || p.h < 3) continue;
    if (p.w <= room.w && p.h <= room.h) fits.push({ p, rot: false });
    if (p.h <= room.w && p.w <= room.h) fits.push({ p, rot: true });
  }
  if (!fits.length) return false;
  const pick = fits[rng.int(0, fits.length - 1)]!;
  let pf = pick.rot ? rotatePrefabCW(pick.p) : pick.p;
  if (rng.chance(0.5)) pf = mirrorPrefab(pf);
  room.x += Math.floor((room.w - pf.w) / 2);
  room.y += Math.floor((room.h - pf.h) / 2);
  room.w = pf.w; room.h = pf.h; room.shape = 'rect';
  stampPrefabTerrain(grid, pf, room.x, room.y);
  for (const c of prefabZoneCells(pf, room.x, room.y, 'd')) decor.push({ ...cellToWorld(c.cx, c.cy), kind: 'torch' });
  for (const c of prefabZoneCells(pf, room.x, room.y, 'c')) decor.push({ ...cellToWorld(c.cx, c.cy), kind: 'chest' });
  return true;
}

/**
 * Отбирает префабы, подходящие текущему этажу: по биому и типу генерации.
 * Пустой список у префаба = «любой» (появляется везде). `enabled === false` отсеивается.
 * Undefined-ось контекста (нет биома/алгоритма) — по ней НЕ фильтруем (для превью редактора).
 */
export function selectPrefabs(prefabs: RoomPrefab[], ctx: { biomeId?: string; algorithm?: string }): RoomPrefab[] {
  return prefabs.filter((p) => {
    if (p.enabled === false) return false;
    if (ctx.algorithm && p.algorithms?.length && !p.algorithms.includes(ctx.algorithm)) return false;
    if (ctx.biomeId && p.biomes?.length && !p.biomes.includes(ctx.biomeId)) return false;
    return true;
  });
}

/** Взвешенный выбор префаба (по `weight`); undefined — если список пуст. */
export function pickPrefab(prefabs: RoomPrefab[], rng: Rng): RoomPrefab | undefined {
  if (!prefabs.length) return undefined;
  const total = prefabs.reduce((s, p) => s + Math.max(0, p.weight ?? 1), 0);
  if (total <= 0) return prefabs[rng.int(0, prefabs.length - 1)];
  let r = rng.float(0, total);
  for (const p of prefabs) { r -= Math.max(0, p.weight ?? 1); if (r <= 0) return p; }
  return prefabs[prefabs.length - 1];
}

/**
 * Врезает до `count` рукотворных room-префабов КАМЕРАМИ в уже готовый грид (для органических
 * алгоритмов — пещеры/лабиринт, где нет комнат-слотов). Подбирает влезающий префаб (случайная
 * ориентация), центрирует bbox на случайной клетке пола, НЕ накрывает spawn/stairs и уже
 * поставленные комнаты (`avoid`+свои), штампует террейн (пустоты пропускаются), кладёт декор из
 * зон d(факел)/c(сундук). Связность стена-кольца добьёт `reconnectFloor`. Возвращает камеры-комнаты
 * (для якорей пачек; вызывающий пропускает их в процедурном `decorate`). Мутирует grid+decor.
 */
export function carvePrefabChambers(
  grid: Grid,
  prefabs: RoomPrefab[],
  count: number,
  spawn: { cx: number; cy: number },
  stairs: { cx: number; cy: number },
  avoid: Room[],
  decor: DecorObject[],
  rng: Rng,
): Room[] {
  const roomPrefabs = prefabs.filter((p) => p.enabled !== false && p.scope === 'room' && p.terrain.length > 0 && p.w >= 3 && p.h >= 3);
  if (!roomPrefabs.length || count <= 0) return [];
  const { cols, rows } = gridSize(grid);
  const placed: Room[] = [];
  for (let tries = 0; placed.length < count && tries < count * 30; tries++) {
    const cx = rng.int(1, cols - 2), cy = rng.int(1, rows - 2);
    if (grid[cy]?.[cx] !== Cell.Floor) continue; // центр — по полости
    const base = pickPrefab(roomPrefabs, rng);
    if (!base) break;
    const pf = orientPrefab(base, rng);
    if (pf.w > cols - 2 || pf.h > rows - 2) continue; // не влезает в рамку
    const ox = Math.max(1, Math.min(cols - 1 - pf.w, cx - (pf.w >> 1)));
    const oy = Math.max(1, Math.min(rows - 1 - pf.h, cy - (pf.h >> 1)));
    const covers = (c: { cx: number; cy: number }): boolean => c.cx >= ox && c.cx < ox + pf.w && c.cy >= oy && c.cy < oy + pf.h;
    if (covers(spawn) || covers(stairs)) continue; // не поверх старта/выхода
    const overlap = (r: Room): boolean => ox < r.x + r.w + 1 && ox + pf.w + 1 > r.x && oy < r.y + r.h + 1 && oy + pf.h + 1 > r.y;
    if (avoid.some(overlap) || placed.some(overlap)) continue; // не поверх других комнат (с зазором)
    stampPrefabTerrain(grid, pf, ox, oy);
    for (const c of prefabZoneCells(pf, ox, oy, 'd')) decor.push({ ...cellToWorld(c.cx, c.cy), kind: 'torch' });
    for (const c of prefabZoneCells(pf, ox, oy, 'c')) decor.push({ ...cellToWorld(c.cx, c.cy), kind: 'chest' });
    placed.push({ x: ox, y: oy, w: pf.w, h: pf.h, type: 'small', shape: 'rect' });
  }
  return placed;
}
