import type { Item } from '@dm/shared';
import type { Dims } from '../inventory/grid.js';
import { renderGrid } from '../inventory/gridView.js';

/**
 * Сетка магазина — ОДИН В ОДИН инвентарь: рендерит той же `renderGrid` (клетки/рамки-редкости/глифы/тултипы —
 * общий код gridView). Отличия только: сток без pos → раскладываем упаковкой; клик по клетке = купить предмет
 * из неё; в углу предмета — бейдж цены (через `badge` в GridHandlers). Никакого своего рендера предметов.
 */
export interface ShopGridOpts {
  price: (it: Item) => number;
  affordable: (it: Item) => boolean;
  onBuy: (it: Item) => void;
  tooltip: (it: Item) => string;
  cols?: number;      // ширина в клетках (по умолч. 11)
  minRows?: number;   // минимум рядов (пустые клетки — «больше ячеек»)
}

export interface Placed { it: Item; x: number; y: number }

/** Жадная упаковка: каждый предмет — в первую свободную клетку (сканируем ряд за рядом). Экспорт — для теста. */
export function packShopItems(items: Item[], cols: number): { placed: Placed[]; rows: number } {
  const occ: boolean[][] = [];
  const fits = (x: number, y: number, w: number, h: number): boolean => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) { if (x + dx >= cols) return false; if (occ[y + dy]?.[x + dx]) return false; }
    return true;
  };
  const mark = (x: number, y: number, w: number, h: number): void => {
    for (let dy = 0; dy < h; dy++) { const row = (occ[y + dy] ??= []); for (let dx = 0; dx < w; dx++) row[x + dx] = true; }
  };
  const placed: Placed[] = [];
  let maxRow = 0;
  for (const it of items) {
    const w = Math.min(it.gridW, cols), h = it.gridH;
    let done = false;
    for (let y = 0; !done; y++) {
      for (let x = 0; x + w <= cols; x++) {
        if (fits(x, y, w, h)) { mark(x, y, w, h); placed.push({ it, x, y }); maxRow = Math.max(maxRow, y + h); done = true; break; }
      }
    }
  }
  return { placed, rows: maxRow };
}

export function renderShopGrid(items: Item[], o: ShopGridOpts): HTMLElement {
  const cols = o.cols ?? 11;
  const { placed, rows } = packShopItems(items, cols);
  const dims: Dims = { cols, rows: Math.max(rows, o.minRows ?? 4) };
  // Отображаемые копии с назначенной pos (сток с сервера pos не имеет; оригиналы не мутируем).
  const display = placed.map(({ it, x, y }) => ({ ...it, pos: { x, y } }));
  // Клетка → предмет (для покупки по клику по клетке — renderGrid отдаёт col/row).
  const at = new Map<string, Item>();
  for (const { it, x, y } of placed) {
    for (let dy = 0; dy < it.gridH; dy++) for (let dx = 0; dx < Math.min(it.gridW, cols); dx++) at.set(`${x + dx},${y + dy}`, it);
  }
  return renderGrid(display, dims, {
    onPick: (col, row) => { const it = at.get(`${col},${row}`); if (it) o.onBuy(it); },
    onPlace: () => { /* магазин: класть некуда */ },
    tooltip: (it) => o.tooltip(it),
    badge: (it) => ({ text: `${o.price(it)}`, affordable: o.affordable(it) }),
  });
}
