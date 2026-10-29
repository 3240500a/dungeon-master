import { Cell, TILE } from '../world/grid.js';
import type { FloorInit } from './netTypes.js';

/**
 * ⭐ С-аудит F5 (29.10): ТУМАН ВОЙНЫ — ЭТАЖ ОТКРЫВАЕТСЯ ПО МЕРЕ ИССЛЕДОВАНИЯ. Раньше `FloorInit` нёс весь этаж: сетку, все сундуки с
 * тирами, рычаги с их дверями, выходы, алтарь, комнаты и декор — изменённый клиент шёл прямо к лучшим сундукам и к выходу, не исследуя.
 * Теперь клиент знает только открытые куски этажа (`REVEAL_CHUNK`×`REVEAL_CHUNK` клеток — те же куски, которыми Unity строит пол и стены):
 * кусок открывается, когда герой пати подходит к нему ближе радиуса вида, и приходит кадром `reveal` (клетки и всё, что на них стоит).
 *
 * Клетки открытого куска приходят С КАЙМОЙ в одну клетку: стене на краю куска нужен сосед, чтобы клиент выбрал её вид и сторону. Кайма
 * чужого куска ничего не открывает — она часть его стен, а рисует клиент только открытые куски. Неоткрытая клетка в сетке клиента — стена.
 */
export const REVEAL_CHUNK = 16;

/** Ключ куска (столбец и строка кусков). */
export const chunkKey = (cx: number, cy: number): number => cy * 4096 + cx;
export const chunkOf = (key: number): { cx: number; cy: number } => ({ cx: key % 4096, cy: Math.floor(key / 4096) });
/** Ключ куска, в котором стоит точка мира (пиксели сервера). */
export const chunkAt = (x: number, y: number): number => chunkKey(Math.floor(x / TILE / REVEAL_CHUNK), Math.floor(y / TILE / REVEAL_CHUNK));

/** Куски сетки `cols`×`rows` клеток, чей прямоугольник ближе `r` (пиксели) хотя бы к одной из точек. */
export function chunksNear(cols: number, rows: number, pts: readonly { x: number; y: number }[], r: number): number[] {
  const out: number[] = [];
  const span = REVEAL_CHUNK * TILE;
  const ncx = Math.ceil(cols / REVEAL_CHUNK), ncy = Math.ceil(rows / REVEAL_CHUNK);
  for (const p of pts) {
    const c0 = Math.max(0, Math.floor((p.x - r) / span)), c1 = Math.min(ncx - 1, Math.floor((p.x + r) / span));
    const r0 = Math.max(0, Math.floor((p.y - r) / span)), r1 = Math.min(ncy - 1, Math.floor((p.y + r) / span));
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
      const nx = Math.max(cx * span, Math.min(p.x, (cx + 1) * span)), ny = Math.max(cy * span, Math.min(p.y, (cy + 1) * span));
      if ((nx - p.x) ** 2 + (ny - p.y) ** 2 <= r * r) out.push(chunkKey(cx, cy));
    }
  }
  return [...new Set(out)];
}

/** Клетка (столбец, строка) — в открытом куске или в его кайме. */
function cellKnown(revealed: ReadonlySet<number>, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (revealed.has(chunkKey(Math.floor((x + dx) / REVEAL_CHUNK), Math.floor((y + dy) / REVEAL_CHUNK)))) return true;
  }
  return false;
}

/** Точка мира — в открытом куске. */
const pointOpen = (revealed: ReadonlySet<number>, x: number, y: number): boolean => revealed.has(chunkAt(x, y));

/** Прямоугольник клеток задевает открытый кусок. */
function rectOpen(revealed: ReadonlySet<number>, r: { x: number; y: number; w: number; h: number }): boolean {
  for (let cy = Math.floor(r.y / REVEAL_CHUNK); cy <= Math.floor((r.y + r.h - 1) / REVEAL_CHUNK); cy++)
    for (let cx = Math.floor(r.x / REVEAL_CHUNK); cx <= Math.floor((r.x + r.w - 1) / REVEAL_CHUNK); cx++) if (revealed.has(chunkKey(cx, cy))) return true;
  return false;
}

/**
 * Область для клиента, знающего куски `revealed`: сетка — открытые куски с каймой (прочее — стена), объекты — только на открытых, выходы — с
 * номером ребра (`i`). Город и арена не прячутся (весь вид и так на экране) — их функция не зовётся. `revealed` уходит в кадре списком.
 */
export function maskFloor(f: FloorInit, revealed: ReadonlySet<number>): FloorInit {
  const grid = f.grid.map((row, y) => row.map((c, x) => (cellKnown(revealed, x, y) ? c : Cell.Wall)));
  const exits = (f.exits ?? (f.stairs ? [f.stairs] : [])).map((e, i) => ({ x: e.x, y: e.y, i })).filter((e) => pointOpen(revealed, e.x, e.y));
  const out: FloorInit = {
    ...f,
    grid,
    exits,
    stairs: exits.find((e) => e.i === 0) ? f.stairs : undefined,
    decor: f.decor.filter((d) => pointOpen(revealed, d.x, d.y)),
    doors: f.doors.filter((d) => d.cells.some((c) => revealed.has(chunkKey(Math.floor(c.cx / REVEAL_CHUNK), Math.floor(c.cy / REVEAL_CHUNK))))),
    levers: f.levers.filter((l) => pointOpen(revealed, l.x, l.y)),
    chests: f.chests.filter((c) => pointOpen(revealed, c.x, c.y)),
    revealed: [...revealed],
  };
  if (f.altar && !pointOpen(revealed, f.altar.x, f.altar.y)) delete out.altar;
  if (f.rooms) out.rooms = f.rooms.filter((r) => rectOpen(revealed, r));
  return out;
}

/**
 * Кадр `reveal`: куски `fresh` открылись поверх `before`. Клетки — прямоугольником на кусок с каймой, объекты — те, что стоят на новых
 * кусках (комната — задевшая новый кусок и не задевавшая прежние; дверь — так же).
 */
export function revealOf(f: FloorInit, fresh: readonly number[], before: ReadonlySet<number>): Extract<import('./netTypes.js').ServerFrame, { t: 'reveal' }> {
  const now = new Set([...before, ...fresh]);
  const rows = f.grid.length, cols = f.grid[0]?.length ?? 0;
  const patches = fresh.map((k) => {
    const { cx, cy } = chunkOf(k);
    const x0 = Math.max(0, cx * REVEAL_CHUNK - 1), y0 = Math.max(0, cy * REVEAL_CHUNK - 1);
    const x1 = Math.min(cols, (cx + 1) * REVEAL_CHUNK + 1), y1 = Math.min(rows, (cy + 1) * REVEAL_CHUNK + 1);
    const cells: number[] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cells.push(f.grid[y]![x]!);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cells };
  });
  const isFresh = (x: number, y: number): boolean => fresh.includes(chunkAt(x, y));
  const freshSet = new Set(fresh);
  const doorChunks = (d: FloorInit['doors'][number]): number[] => d.cells.map((c) => chunkKey(Math.floor(c.cx / REVEAL_CHUNK), Math.floor(c.cy / REVEAL_CHUNK)));
  const exits = (f.exits ?? (f.stairs ? [f.stairs] : [])).map((e, i) => ({ x: e.x, y: e.y, i })).filter((e) => isFresh(e.x, e.y));
  return {
    t: 'reveal',
    chunks: [...fresh],
    patches,
    exits,
    decor: f.decor.filter((d) => isFresh(d.x, d.y)),
    doors: f.doors.filter((d) => doorChunks(d).some((k) => freshSet.has(k)) && !doorChunks(d).some((k) => before.has(k))),
    levers: f.levers.filter((l) => isFresh(l.x, l.y)),
    chests: f.chests.filter((c) => isFresh(c.x, c.y)),
    ...(f.altar && isFresh(f.altar.x, f.altar.y) ? { altar: f.altar } : {}),
    rooms: (f.rooms ?? []).filter((r) => rectOpen(freshSet, r) && !rectOpen(before, r) && rectOpen(now, r)),
  };
}
