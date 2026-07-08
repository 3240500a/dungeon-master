import type { Item } from '@dm/shared';
import type { App } from '../../core/app.js';
import { COLORS, mk } from '../../ui/kit.js';
import { rarityHex } from '../loot/rarity.js';

/**
 * ЕДИНЫЙ «предмет на курсоре» (модель Diablo 2) для инвентаря И общего сундука: клик — взять
 * на курсор, клик — положить. Раскладка АВТОРИТЕТНА НА СЕРВЕРЕ — держимый предмет чисто визуален
 * (в сетке прячется). Панели строят серверную команду по `from` (откуда взяли). Один общий курсор
 * позволяет таскать предмет инвентарь↔вкладка сундука.
 */

export const CELL = 40; // клетка инвентаря/сундука (была 32). Сундук 20 клеток → см. domUi maxWidth.
export const GAP = 3;
export const PITCH = CELL + GAP;

export const GLYPH: Record<string, string> = {
  weapon: 'Ор', offhand: 'Оф', helm: 'Шл', chest: 'На', gloves: 'Пе', boots: 'Са', belt: 'По', ring: 'Ко', amulet: 'Ам',
};

/** Откуда взят держимый предмет — чтобы «положить» построило верную серверную команду. */
export type HeldFrom = 'inv' | { tab: number };

interface Held {
  item: Item;
  grabOx: number;
  grabOy: number;
  from: HeldFrom;
  ghost: HTMLElement;
  onMove: (e: MouseEvent) => void;
  onWorldClick: (e: MouseEvent) => void;
}

let held: Held | null = null;
let lastPointer = { x: 0, y: 0 };

export function getHeld(): { item: Item; grabOx: number; grabOy: number; from: HeldFrom } | null {
  return held;
}
export function setLastPointer(x: number, y: number): void { lastPointer = { x, y }; }

/** Глиф-подпись предмета в клетке/гхосте: имя для широких (≥2), иначе тип/зелье. */
export function glyphOf(item: Item): string {
  if (item.gridW >= 2) return item.name;
  return item.kind === 'consumable' ? '🧪' : item.slot ? GLYPH[item.slot] ?? '·' : '·';
}

function makeGhost(item: Item): HTMLElement {
  const g = mk('div',
    `position:fixed;z-index:10000;pointer-events:none;opacity:0.92;border:2px solid ${rarityHex(item.rarity)};` +
    `background:${COLORS.panel};color:${rarityHex(item.rarity)};border-radius:6px;display:flex;align-items:center;` +
    `justify-content:center;font-size:12px;font-weight:500;text-align:center;padding:2px`);
  g.style.width = `${item.gridW * CELL + (item.gridW - 1) * GAP}px`;
  g.style.height = `${item.gridH * CELL + (item.gridH - 1) * GAP}px`;
  g.textContent = glyphOf(item);
  document.body.appendChild(g);
  return g;
}

function positionGhost(): void {
  if (!held) return;
  held.ghost.style.left = `${lastPointer.x - held.grabOx * PITCH - CELL / 2}px`;
  held.ghost.style.top = `${lastPointer.y - held.grabOy * PITCH - CELL / 2}px`;
}

/** Перерисовать открытые окна (спрятать/показать держимый предмет). Раскладку считает сервер. */
function reRender(app: App): void { app.bus.emit('state:changed', {}); }

/** Берёт предмет на курсор (визуально). `from` — источник для будущей команды «положить». */
export function beginHold(app: App, item: Item, grabOx: number, grabOy: number, from: HeldFrom): void {
  const onMove = (e: MouseEvent): void => { lastPointer = { x: e.clientX, y: e.clientY }; positionGhost(); };
  const onWorldClick = (e: MouseEvent): void => {
    if (!held) return;
    // Роняем ТОЛЬКО при попадании по игровому холсту (#game/canvas) — узлы UI после ре-рендера
    // отсоединяются, «не в окне» ложно срабатывало бы как выброс.
    const t = e.target as HTMLElement | null;
    if (t && (t.closest('#game') || t.tagName === 'CANVAS')) dropHeldToWorld(app);
  };
  held = { item, grabOx, grabOy, from, ghost: makeGhost(item), onMove, onWorldClick };
  positionGhost();
  window.addEventListener('mousemove', onMove);
  window.addEventListener('click', onWorldClick);
  reRender(app); // спрятать взятый предмет в сетке
}

export function clearHeld(): void {
  if (!held) return;
  window.removeEventListener('mousemove', held.onMove);
  window.removeEventListener('click', held.onWorldClick);
  held.ghost.remove();
  held = null;
}

/**
 * Клик по игровому миру с предметом на курсоре: из инвентаря — выбросить на землю (`drop`);
 * из сундука — просто отменить взятие (в мир из сундука не бросаем; предмет вернётся во вкладку
 * при ре-рендере). Сервер авторитетно роняет только предмет инвентаря.
 */
export function dropHeldToWorld(app: App): void {
  if (!held) return;
  const { from, item } = held;
  clearHeld();
  if (from === 'inv') app.sendCmd({ cmd: 'drop', uid: item.uid });
  reRender(app);
}

/** Закрыли окно с держимым — отпускаем курсор (из сейва/сундука предмет не удалялся). */
export function resolveHeldOnClose(app: App): void {
  if (!held) return;
  clearHeld();
  reRender(app);
}
