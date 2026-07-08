import type { Item } from '@dm/shared';
import { rarityHex } from '../modules/loot/rarity.js';

/**
 * Небольшой UI-кит: общие DOM-компоненты и стили для всех панелей — слоты-иконки,
 * тултипы по наведению, кнопки, вкладки. Держит внешний вид консистентным.
 */

/**
 * Палитра из арт-фона (тёмное фэнтези, факелы): холодный камень/ночь + тёплый факельный акцент +
 * мшистая зелень + сталь луны. Central-источник цвета для всех DOM-панелей.
 */
export const COLORS = {
  bg: '#0e1117',       // ночное небо/тени
  panel: '#171b24',    // тёмный камень (поверхность)
  panel2: '#0f131a',   // утопленная поверхность
  border: '#2b323f',   // холодный камень
  borderHi: '#3e4756', // подсвеченная рамка
  text: '#e6ddc9',     // тёплый пергамент
  dim: '#8f897c',      // выветренный камень
  gold: '#dca94b',     // факельное золото (опыт/лут)
  good: '#8aa84a',     // мшистая зелень
  bad: '#c85a48',      // тёплый кровавый (опасность/HP)
  accent: '#e39a3c',   // факельный амбер (акцент/интерактив)
  info: '#6f9bcf',     // сталь луны/неба (мана, ссылки)
};

/**
 * Заголовочный шрифт (медиевальный). Бандлится локально через @fontsource:
 * Cinzel рисует латиницу («Dungeon Master»), Forum — кириллицу (римские капители с
 * родной кириллицей; у Cinzel нет кириллических глифов, браузер подставляет следующий
 * в стеке поглифно). Титры сцен и кнопки меню; тело/тултипы остаются на sans.
 */
export const FONT_TITLE = "'Cinzel', 'Forum', Georgia, serif";

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
  // Камень-фон; primary — тёплый амбер, danger — тёмный кровавый. Hover — амбер-рамка (свет факела).
  const style =
    variant === 'primary' ? { bg: '#3a2c15', bd: COLORS.accent, fg: '#f0d9a8' }
    : variant === 'danger' ? { bg: '#3a1f18', bd: COLORS.bad, fg: '#f0b6a8' }
    : { bg: '#1a1f29', bd: COLORS.borderHi, fg: COLORS.text };
  const b = mk('button', '', label);
  b.style.cssText = `padding:6px 12px;cursor:pointer;background:${style.bg};color:${style.fg};border:1px solid ${style.bd};border-radius:6px;font-size:13px`;
  b.disabled = disabled;
  if (disabled) b.style.opacity = '0.5';
  else {
    b.addEventListener('mouseenter', () => { b.style.borderColor = COLORS.accent; });
    b.addEventListener('mouseleave', () => { b.style.borderColor = style.bd; });
  }
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
    // Активная вкладка — тёплым амбером (факел), неактивная — камень.
    t.style.cssText = `padding:6px 12px;cursor:pointer;border-radius:6px;border:1px solid ${active ? COLORS.accent : COLORS.borderHi};background:${active ? '#26221a' : COLORS.panel};color:${active ? COLORS.accent : COLORS.text}`;
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
  const size = opts.size ?? 56;
  const slot = mk('div',
    `width:${size}px;height:${size}px;box-sizing:border-box;border-radius:6px;` +
    `display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:bold;` +
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
