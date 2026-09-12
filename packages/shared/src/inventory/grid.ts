import type { Item } from '../types/items.js';

/**
 * Чистая математика сетки инвентаря (без Phaser/DOM): размещение/упаковка/поиск
 * места по клеткам. Общая для клиента (отрисовка/DnD) и сервера (авторитетный
 * инвентарь: покупка/экип/подбор) — одна истина.
 */

export interface Dims {
  cols: number;
  rows: number;
}

function overlaps(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** Свободен ли прямоугольник w×h в позиции (x,y) с учётом границ и других предметов. */
export function cellFree(
  items: Item[],
  x: number, y: number, w: number, h: number,
  dims: Dims,
  ignoreUid?: string,
): boolean {
  if (x < 0 || y < 0 || x + w > dims.cols || y + h > dims.rows) return false;
  for (const it of items) {
    if (it.uid === ignoreUid || !it.pos) continue;
    if (overlaps(x, y, w, h, it.pos.x, it.pos.y, it.gridW, it.gridH)) return false;
  }
  return true;
}

/** Первая свободная позиция для предмета w×h (сканирование по строкам). */
export function findFree(items: Item[], w: number, h: number, dims: Dims): { x: number; y: number } | null {
  for (let y = 0; y <= dims.rows - h; y++) {
    for (let x = 0; x <= dims.cols - w; x++) {
      if (cellFree(items, x, y, w, h, dims)) return { x, y };
    }
  }
  return null;
}

/** Проставляет позиции предметам без валидного места (авто-упаковка first-fit). */
export function packInventory(items: Item[], dims: Dims): void {
  for (const it of items) {
    if (it.pos && cellFree(items, it.pos.x, it.pos.y, it.gridW, it.gridH, dims, it.uid)) continue;
    it.pos = null;
  }
  for (const it of items) {
    if (it.pos) continue;
    it.pos = findFree(items, it.gridW, it.gridH, dims);
  }
}

/**
 * Добавляет предмет в первую свободную клетку. false — если места нет.
 *
 * ⭐ СТЕК МАТЕРИАЛА СЛИВАЕТСЯ с уже лежащим: сперва доливаем в существующие стеки того же
 * материала до `stackMax`, и только остаток занимает новую клетку. Ради этого материалы и
 * переехали в сумку — кольчуга занимает 6 клеток, а пластины с неё доливаются в ноль.
 *
 * Возвращает false, ТОЛЬКО если не поместилось НИЧЕГО. Частичный долив (влезло 40 из 137)
 * считается успехом, а остаток остаётся в `item.count` — зовущая сторона решает, что с ним
 * делать: подбор с земли оставляет остаток лежать, а не уничтожает его.
 */
export function addToInventory(items: Item[], item: Item, dims: Dims, stackMax = 0): boolean {
  if (item.kind === 'material' && item.materialId && stackMax > 0) {
    let left = item.count ?? 1;
    for (const it of items) {
      if (left <= 0) break;
      if (it.kind !== 'material' || it.materialId !== item.materialId) continue;
      const room = stackMax - (it.count ?? 1);
      if (room <= 0) continue;
      const add = Math.min(room, left);
      it.count = (it.count ?? 1) + add;
      left -= add;
    }
    if (left <= 0) { item.count = 0; return true; }   // всё ушло в существующие стеки
    // Остаток кладём НОВЫМИ стеками, пока есть клетки. ⚠ Сам `item` в сумку не попадает никогда:
    // он остаётся «носителем остатка», и его `count` — ровно то, что НЕ влезло. Если класть его
    // самого, финальная строка обнулила бы count уже уложенному стеку.
    let placed = 0;
    while (left > 0) {
      const f = findFree(items, item.gridW, item.gridH, dims);
      if (!f) break;
      const chunk = Math.min(stackMax, left);
      items.push({ ...item, uid: `${item.uid}_${placed}`, pos: { x: f.x, y: f.y }, count: chunk });
      left -= chunk;
      placed++;
    }
    item.count = left;                                 // что не влезло — остаётся у зовущего
    return placed > 0;
  }
  const f = findFree(items, item.gridW, item.gridH, dims);
  if (!f) return false;
  item.pos = { x: f.x, y: f.y };
  items.push(item);
  return true;
}

/**
 * Есть ли место под предмет w×h.
 * ⚠ Про стеки НЕ знает намеренно: её читают покупка и экипировка, а туда стек не попадает.
 * Для материалов правду говорит только `addToInventory` (место может найтись в недобитом стеке).
 */
export function hasSpace(items: Item[], w: number, h: number, dims: Dims): boolean {
  return findFree(items, w, h, dims) !== null;
}

/** Все предметы, чей прямоугольник пересекает область (x,y,w,h), кроме ignoreUid. */
export function itemsOverlapping(
  items: Item[], x: number, y: number, w: number, h: number, ignoreUid: string,
): Item[] {
  return items.filter(
    (it) =>
      it.uid !== ignoreUid && it.pos &&
      x < it.pos.x + it.gridW && x + w > it.pos.x &&
      y < it.pos.y + it.gridH && y + h > it.pos.y,
  );
}

/**
 * Кладёт перетаскиваемый предмет в позицию (tx,ty) с ВЫТЕСНЕНИЕМ: пусто — просто
 * кладём; область накрывает ровно один предмет — он переезжает на старое место
 * перетаскиваемого (или в первое свободное). Мутирует pos. false — если не вышло
 * (за границей / накрыто 2+ предметов / некуда деть вытесняемого).
 */
export function placeWithDisplacement(
  items: Item[], dragged: Item, tx: number, ty: number, dims: Dims,
): boolean {
  if (tx < 0 || ty < 0 || tx + dragged.gridW > dims.cols || ty + dragged.gridH > dims.rows) {
    return false;
  }
  const overlap = itemsOverlapping(items, tx, ty, dragged.gridW, dragged.gridH, dragged.uid);
  if (overlap.length === 0) {
    dragged.pos = { x: tx, y: ty };
    return true;
  }
  if (overlap.length > 1) return false;

  const other = overlap[0]!;
  const oldDragged = { x: dragged.pos!.x, y: dragged.pos!.y };
  const oldOther = { x: other.pos!.x, y: other.pos!.y };
  dragged.pos = { x: tx, y: ty };
  other.pos = null; // временно освобождаем
  const spot = cellFree(items, oldDragged.x, oldDragged.y, other.gridW, other.gridH, dims, other.uid)
    ? oldDragged
    : findFree(items, other.gridW, other.gridH, dims);
  if (!spot) {
    dragged.pos = oldDragged;
    other.pos = oldOther;
    return false;
  }
  other.pos = spot;
  return true;
}
