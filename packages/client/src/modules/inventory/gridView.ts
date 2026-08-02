import type { Item } from '@dm/shared';
import type { Dims } from './grid.js';
import { CELL, GAP, PITCH, getHeld, setLastPointer, glyphOf } from './heldItem.js';
import { rarityHex } from '../loot/rarity.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';

/**
 * Переиспользуемая отрисовка сетки контейнера (инвентарь / вкладка сундука): фон-клетки +
 * предметы + клики. Логика «взять/положить» — общий курсор `heldItem`; конкретные серверные
 * команды задаёт вызывающий через `onPick`/`onPlace`. Держимый предмет прячется. Одна истина
 * рендера сетки для всех контейнеров — без дублирования.
 */
export interface GridHandlers {
  /** Пусто в руке, клик по клетке (col,row) — взять предмет из этой клетки. */
  onPick: (col: number, row: number) => void;
  /** Держим предмет, клик по клетке (col,row) — положить сюда. */
  onPlace: (col: number, row: number) => void;
  /** HTML тултипа предмета. */
  tooltip: (item: Item) => string;
  /** ПКМ по предмету (когда пусто в руке) — опц. контекст-меню. */
  contextMenu?: (item: Item, x: number, y: number) => void;
  /** Опц. бейдж в углу предмета (магазин — цена; affordable=false → тускло/красный). Инвентарь не передаёт. */
  badge?: (item: Item) => { text: string; affordable: boolean } | null;
}

export function renderGrid(items: Item[], dims: Dims, h: GridHandlers): HTMLElement {
  const wrap = mk('div', 'position:relative');
  wrap.style.width = `${dims.cols * CELL + (dims.cols - 1) * GAP}px`;
  wrap.style.height = `${dims.rows * CELL + (dims.rows - 1) * GAP}px`;

  const bg = mk('div', `display:grid;grid-template-columns:repeat(${dims.cols},${CELL}px);grid-auto-rows:${CELL}px;gap:${GAP}px`);
  for (let i = 0; i < dims.cols * dims.rows; i++) {
    bg.append(mk('div', `background:${COLORS.panel2};border:0.5px solid ${COLORS.border};border-radius:4px`));
  }

  const held = getHeld();
  const layer = mk('div',
    `position:absolute;inset:0;display:grid;grid-template-columns:repeat(${dims.cols},${CELL}px);grid-auto-rows:${CELL}px;gap:${GAP}px`);
  for (const item of items) {
    if (!item.pos) continue;
    if (held && held.item.uid === item.uid) continue; // держимый — на курсоре, в сетке прячем
    layer.append(itemEl(item, h));
  }
  wrap.append(bg, layer);

  wrap.addEventListener('click', (e) => {
    setLastPointer(e.clientX, e.clientY);
    const rect = wrap.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / PITCH);
    const row = Math.floor((e.clientY - rect.top) / PITCH);
    if (col < 0 || row < 0 || col >= dims.cols || row >= dims.rows) return;
    if (getHeld()) h.onPlace(col, row);
    else h.onPick(col, row);
  });
  return wrap;
}

function itemEl(item: Item, h: GridHandlers): HTMLElement {
  const el = mk('div',
    `grid-column:${item.pos!.x + 1} / span ${item.gridW};grid-row:${item.pos!.y + 1} / span ${item.gridH};` +
    `border:2px solid ${rarityHex(item.rarity)};color:${rarityHex(item.rarity)};border-radius:6px;` +
    `background:${COLORS.panel};display:flex;align-items:center;justify-content:center;text-align:center;` +
    `font-size:12px;font-weight:500;cursor:pointer;line-height:1.1;overflow:hidden;padding:2px;position:relative`);
  el.textContent = glyphOf(item);
  const b = h.badge?.(item);
  if (b) {
    el.append(mk('div',
      `position:absolute;right:1px;bottom:0;font-size:9.5px;color:${b.affordable ? COLORS.gold : COLORS.bad};` +
      `background:rgba(7,9,13,0.72);padding:0 3px;border-radius:3px;pointer-events:none`, b.text));
    if (!b.affordable) el.style.opacity = '0.6';
  }
  attachTooltip(el, () => h.tooltip(item));
  if (h.contextMenu) {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (getHeld()) return; // клики по предмету при держимом обрабатывает сетка (положить)
      h.contextMenu!(item, e.clientX, e.clientY);
    });
  }
  return el;
}

// ── Контекст-меню (общее для инвентаря/сундука) ──────────────────────────────
let openMenu: HTMLElement | null = null;
export function showContextMenu(x: number, y: number, options: { label: string; run: () => void }[]): void {
  openMenu?.remove();
  const menu = mk('div',
    `position:fixed;left:${x}px;top:${y}px;z-index:10001;background:${COLORS.panel2};` +
    `border:1px solid ${COLORS.borderHi};border-radius:6px;padding:4px;min-width:150px;box-shadow:0 6px 20px rgba(0,0,0,0.5)`);
  for (const opt of options) {
    const b = mk('div', `padding:6px 10px;cursor:pointer;border-radius:4px;font-size:13px;color:${COLORS.text}`, opt.label);
    b.addEventListener('mouseenter', () => (b.style.background = COLORS.border));
    b.addEventListener('mouseleave', () => (b.style.background = 'transparent'));
    b.addEventListener('click', () => { close(); opt.run(); });
    menu.appendChild(b);
  }
  const close = (): void => { menu.remove(); openMenu = null; window.removeEventListener('pointerdown', onDoc, true); };
  const onDoc = (e: PointerEvent): void => { if (!menu.contains(e.target as Node)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', onDoc, true), 0);
  document.body.appendChild(menu);
  openMenu = menu;
}
