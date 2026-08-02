import type { Item } from '@dm/shared';
import { CELL, GAP, PITCH, glyphOf } from '../inventory/heldItem.js';
import { rarityHex } from '../loot/rarity.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';

/**
 * Сетка магазина «как инвентарь»: предметы занимают gridW×gridH клеток (не по одной), с бейджем цены.
 * Раскладка — жадная упаковка row-major по размеру (сток без pos). Клик по предмету = купить.
 * Стиль клеток/рамок-редкости общий с инвентарём (gridView), но клик пер-предметный (покупка), а не по клетке.
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

const px = (cells: number): number => cells * CELL + (cells - 1) * GAP;

export function renderShopGrid(items: Item[], o: ShopGridOpts): HTMLElement {
  const cols = o.cols ?? 11;
  const { placed, rows: usedRows } = packShopItems(items, cols);
  const rows = Math.max(usedRows, o.minRows ?? 4);

  const wrap = mk('div', 'position:relative');
  wrap.style.width = `${px(cols)}px`;
  wrap.style.height = `${px(rows)}px`;

  const bg = mk('div', `display:grid;grid-template-columns:repeat(${cols},${CELL}px);grid-auto-rows:${CELL}px;gap:${GAP}px`);
  for (let i = 0; i < cols * rows; i++) bg.append(mk('div', `background:${COLORS.panel2};border:0.5px solid ${COLORS.border};border-radius:4px`));
  wrap.append(bg);

  for (const { it, x, y } of placed) {
    const affordable = o.affordable(it);
    const cell = mk('div',
      `position:absolute;left:${x * PITCH}px;top:${y * PITCH}px;width:${px(Math.min(it.gridW, cols))}px;height:${px(it.gridH)}px;` +
      `border:2px solid ${rarityHex(it.rarity)};color:${rarityHex(it.rarity)};border-radius:6px;background:${COLORS.panel};` +
      `display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;font-weight:500;` +
      `line-height:1.1;overflow:hidden;padding:2px;cursor:pointer`);
    cell.textContent = glyphOf(it);
    const badge = mk('div',
      `position:absolute;right:1px;bottom:0;font-size:9.5px;color:${affordable ? COLORS.gold : COLORS.bad};` +
      `background:rgba(7,9,13,0.72);padding:0 3px;border-radius:3px;pointer-events:none`, `${o.price(it)}`);
    cell.append(badge);
    if (!affordable) cell.style.opacity = '0.65';
    attachTooltip(cell, () => o.tooltip(it));
    cell.addEventListener('click', () => o.onBuy(it));
    wrap.append(cell);
  }
  return wrap;
}
