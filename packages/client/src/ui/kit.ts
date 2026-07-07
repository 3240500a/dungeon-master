import type { Item } from '@dm/shared';
import { rarityHex } from '../modules/loot/rarity.js';

/**
 * Небольшой UI-кит: общие DOM-компоненты и стили для всех панелей — слоты-иконки,
 * тултипы по наведению, кнопки, вкладки. Держит внешний вид консистентным.
 */

export const COLORS = {
  bg: '#161620',
  panel: '#1c1c26',
  panel2: '#12121a',
  border: '#2c2c3a',
  borderHi: '#3c3c4a',
  text: '#e8e8f0',
  dim: '#8a8a9a',
  gold: '#ffd24b',
  good: '#7fd67f',
  bad: '#ff8080',
  accent: '#6a8ad0',
};

/** Создаёт элемент с cssText и (опц.) текстом. */
export function mk<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (text !== undefined) el.textContent = text;
  return el;
}

export type ButtonVariant = 'default' | 'primary' | 'danger';

export function button(
  label: string,
  onClick: () => void,
  variant: ButtonVariant = 'default',
  disabled = false,
): HTMLButtonElement {
  const bg =
    variant === 'primary' ? '#2a4a2a' : variant === 'danger' ? '#4a2a2a' : COLORS.border;
  const b = mk('button', '', label);
  b.style.cssText = `padding:6px 12px;cursor:pointer;background:${bg};color:${COLORS.text};border:1px solid ${COLORS.borderHi};border-radius:6px;font-size:13px`;
  b.disabled = disabled;
  if (disabled) b.style.opacity = '0.5';
  b.addEventListener('click', onClick);
  return b;
}

/** Полоса вкладок. Возвращает контейнер; onSelect зовётся с ключом. */
export function tabsBar<T extends string>(
  items: readonly (readonly [T, string])[],
  current: T,
  onSelect: (key: T) => void,
): HTMLElement {
  const bar = mk('div', 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap');
  for (const [key, label] of items) {
    const active = key === current;
    const t = mk('button', '', label);
    t.style.cssText = `padding:6px 12px;cursor:pointer;border-radius:6px;border:1px solid ${COLORS.borderHi};background:${active ? '#3a3a4c' : COLORS.panel};color:${COLORS.text}`;
    t.addEventListener('click', () => onSelect(key));
    bar.appendChild(t);
  }
  return bar;
}

export function sectionTitle(text: string): HTMLElement {
  return mk('h4', `margin:0 0 8px;color:${COLORS.text}`, text);
}

// ── Тултип (одиночный, общий) ───────────────────────────────────────────────
let tooltipEl: HTMLDivElement | null = null;

function ensureTooltip(): HTMLDivElement {
  if (tooltipEl) return tooltipEl;
  tooltipEl = mk('div',
    `position:fixed;z-index:100;max-width:300px;pointer-events:none;display:none;` +
    `background:${COLORS.panel2};border:1px solid ${COLORS.borderHi};border-radius:6px;` +
    `padding:8px 10px;font-size:12px;color:${COLORS.text};box-shadow:0 6px 20px rgba(0,0,0,0.5)`,
  );
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

/** Элемент-якорь текущей показанной подсказки (для авто-скрытия при его удалении). */
let tooltipAnchor: Element | null = null;

/** Прячет всплывающую подсказку (напр. при закрытии окна, пока курсор был над строкой). */
export function hideTooltip(): void {
  if (tooltipEl) tooltipEl.style.display = 'none';
  tooltipAnchor = null;
}

// Бэкстоп: если якорь подсказки убрали из DOM (окно закрыли/перерисовали), а
// mouseleave не сработал — прячем её при следующем движении мыши.
if (typeof window !== 'undefined') {
  window.addEventListener('mousemove', () => {
    if (tooltipEl && tooltipEl.style.display === 'block' && tooltipAnchor && !tooltipAnchor.isConnected) {
      hideTooltip();
    }
  }, true);
}

/** Навешивает всплывающую подсказку (html-функция) на элемент (HTML или SVG). */
export function attachTooltip(el: Element, htmlFn: () => string): void {
  const show = (e: Event) => {
    const tt = ensureTooltip();
    tt.innerHTML = htmlFn();
    tt.style.display = 'block';
    tooltipAnchor = el;
    position(tt, e as MouseEvent);
  };
  const move = (e: Event) => {
    if (tooltipEl && tooltipEl.style.display === 'block') position(tooltipEl, e as MouseEvent);
  };
  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', move);
  el.addEventListener('mouseleave', hideTooltip);
}

function position(tt: HTMLElement, e: MouseEvent): void {
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const r = tt.getBoundingClientRect();
  if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
  tt.style.left = `${Math.max(4, x)}px`;
  tt.style.top = `${Math.max(4, y)}px`;
}

// ── Иконка/слот предмета ────────────────────────────────────────────────────
const SLOT_GLYPH: Record<string, string> = {
  weapon: 'Ор', offhand: 'Оф', helm: 'Шл', chest: 'На', gloves: 'Пе', boots: 'Са', belt: 'По', ring: 'Ко', amulet: 'Ам',
};

/** Квадратный слот с иконкой предмета (буква + рамка по редкости) или пустой. */
export function itemSlot(
  item: Item | null,
  opts: { size?: number; onClick?: () => void; emptyLabel?: string } = {},
): HTMLElement {
  const size = opts.size ?? 46;
  const slot = mk('div',
    `width:${size}px;height:${size}px;box-sizing:border-box;border-radius:6px;` +
    `display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:bold;` +
    `background:${COLORS.panel2};`,
  );
  if (item) {
    const color = rarityHex(item.rarity);
    slot.style.border = `2px solid ${color}`;
    slot.style.color = color;
    slot.textContent = item.kind === 'consumable' ? '🧪' : item.slot ? SLOT_GLYPH[item.slot] ?? '?' : '?';
    if (opts.onClick) slot.style.cursor = 'pointer';
  } else {
    slot.style.border = `1px dashed ${COLORS.border}`;
    slot.style.color = '#555';
    slot.textContent = opts.emptyLabel ?? '';
  }
  if (opts.onClick) slot.addEventListener('click', opts.onClick);
  return slot;
}
