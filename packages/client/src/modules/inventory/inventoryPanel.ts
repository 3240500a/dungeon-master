import { meetsRequirements, type EquipSlot, type Item } from '@dm/shared';
import type { App } from '../../core/app.js';
import type { GameState } from '../../core/gameState.js';
import type { PanelFactory } from '../../ui/domUi.js';
import { effectiveAttributes } from './equip.js';
import { itemsOverlapping, type Dims } from './grid.js';
import { itemTooltipHtml } from './itemView.js';
import { rarityHex } from '../loot/rarity.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';

const CELL = 32;
const GAP = 3;
const PITCH = CELL + GAP;

const GLYPH: Record<string, string> = {
  weapon: 'Ор', offhand: 'Оф', helm: 'Шл', chest: 'На', gloves: 'Пе', boots: 'Са', belt: 'По', ring: 'Ко', amulet: 'Ам',
};

/**
 * «Предмет на курсоре» (модель Diablo 2): клик — взять предмет на курсор, клик — положить.
 * Раскладка инвентаря АВТОРИТЕТНА НА СЕРВЕРЕ: держимый предмет — чисто визуальный (из сейва не
 * удаляется, просто прячется в сетке); на «положить» шлём команду `moveItem` (сервер делает
 * перекладку с вытеснением одного предмета и возвращает `saveUpdate`), на «в мир» — `drop`.
 * Клиент только рисует серверную раскладку — client и server не расходятся.
 */

interface Held {
  item: Item;
  grabOx: number;
  grabOy: number;
  ghost: HTMLElement;
  onMove: (e: MouseEvent) => void;
  onWorldClick: (e: MouseEvent) => void;
}

let held: Held | null = null;
let lastPointer = { x: 0, y: 0 };

/** Перерисовать открытые окна (спрятать/показать держимый предмет). Раскладку считает сервер. */
function reRender(app: App): void {
  app.bus.emit('state:changed', {});
}

function itemAtCell(inv: Item[], col: number, row: number): Item | null {
  return itemsOverlapping(inv, col, row, 1, 1, '')[0] ?? null;
}

// ── Держимый предмет (курсор) ────────────────────────────────────────────────
function makeGhost(item: Item): HTMLElement {
  const g = mk('div',
    `position:fixed;z-index:10000;pointer-events:none;opacity:0.92;border:2px solid ${rarityHex(item.rarity)};` +
    `background:${COLORS.panel};color:${rarityHex(item.rarity)};border-radius:6px;display:flex;align-items:center;` +
    `justify-content:center;font-size:12px;font-weight:500;text-align:center;padding:2px`);
  g.style.width = `${item.gridW * CELL + (item.gridW - 1) * GAP}px`;
  g.style.height = `${item.gridH * CELL + (item.gridH - 1) * GAP}px`;
  g.textContent = item.gridW >= 2 ? item.name : item.kind === 'consumable' ? '🧪' : item.slot ? GLYPH[item.slot] ?? '·' : '·';
  document.body.appendChild(g);
  return g;
}

function positionGhost(): void {
  if (!held) return;
  held.ghost.style.left = `${lastPointer.x - held.grabOx * PITCH - CELL / 2}px`;
  held.ghost.style.top = `${lastPointer.y - held.grabOy * PITCH - CELL / 2}px`;
}

function beginHold(app: App, item: Item, grabOx: number, grabOy: number): void {
  const onMove = (e: MouseEvent) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    positionGhost();
  };
  const onWorldClick = (e: MouseEvent) => {
    if (!held) return;
    // Роняем ТОЛЬКО при попадании по игровому холсту (#game/canvas). Проверяем
    // положительно, а не «не в окне»: узлы инвентаря после ре-рендера отсоединяются,
    // и «не в окне» ложно срабатывало бы как выброс.
    const t = e.target as HTMLElement | null;
    if (t && (t.closest('#game') || t.tagName === 'CANVAS')) dropHeldToGround(app);
  };
  held = { item, grabOx, grabOy, ghost: makeGhost(item), onMove, onWorldClick };
  positionGhost();
  window.addEventListener('mousemove', onMove);
  window.addEventListener('click', onWorldClick);
}

function clearHeld(): void {
  if (!held) return;
  window.removeEventListener('mousemove', held.onMove);
  window.removeEventListener('click', held.onWorldClick);
  held.ghost.remove();
  held = null;
}

function dropHeldToGround(app: App): void {
  if (!held) return;
  const uid = held.item.uid;
  clearHeld();
  app.sendCmd({ cmd: 'drop', uid }); // авторитетно: сервер убирает из инвентаря и роняет на землю
  reRender(app);
}

/** Закрыли окно с держимым — предмет из сейва не удалялся, просто отпускаем курсор. */
function resolveHeldOnClose(app: App): void {
  if (!held) return;
  clearHeld();
  reRender(app);
}

// ── Панель ───────────────────────────────────────────────────────────────────
export const inventoryPanel: PanelFactory = (app) => ({
  title: 'Инвентарь и экипировка',
  render(body) {
    const dims: Dims = app.config.get('balance').inventory;
    // Раскладку (item.pos) держит валидной СЕРВЕР (moveItem + лечение на загрузке). Клиент только рисует.
    const msg = mk('div', `color:${COLORS.bad};font-size:12px;min-height:16px;margin:4px 0`);

    const layout = mk('div', 'display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start');
    layout.append(paperdoll(app, dims, msg), gridView(app, dims, msg));
    body.append(layout, msg);
    body.append(mk('div', 'font-size:11px;color:#666;margin-top:8px',
      'Клик — взять на курсор, клик — положить (обмен, если под следом один предмет). ' +
      'Клик в мир — выбросить. ПКМ — меню.'));
  },
  dispose() {
    resolveHeldOnClose(app);
  },
});

// ── Пупсик (A-стайл) ─────────────────────────────────────────────────────────
const DOLL_LAYOUT: (EquipSlot | null)[] = [
  null, 'helm', 'amulet',
  'weapon', 'chest', 'offhand',
  'gloves', 'belt', 'ring',
  null, 'boots', null,
];

function paperdoll(app: App, dims: Dims, msg: HTMLElement): HTMLElement {
  const box = mk('div');
  box.append(mk('p', `font-size:12px;color:${COLORS.dim};margin:0 0 8px`, 'Экипировка'));
  const grid = mk('div', 'display:grid;grid-template-columns:repeat(3,52px);gap:10px');
  for (const slot of DOLL_LAYOUT) {
    grid.append(slot ? equipSlotCell(app, slot, dims, msg) : mk('div'));
  }
  box.append(grid);
  return box;
}

function equipSlotCell(app: App, slot: EquipSlot, dims: Dims, msg: HTMLElement): HTMLElement {
  const state = app.state!;
  const item = state.save.equipment[slot] ?? null;
  const cell = mk('div',
    `width:52px;height:52px;border-radius:8px;display:flex;align-items:center;justify-content:center;` +
    `font-size:13px;font-weight:500;background:${COLORS.panel2};cursor:pointer`);
  cell.dataset.eqslot = slot;
  if (item) {
    cell.style.border = `2px solid ${rarityHex(item.rarity)}`;
    cell.style.color = rarityHex(item.rarity);
    cell.textContent = GLYPH[slot] ?? '?';
    attachTooltip(cell, () => itemTooltipHtml(item));
  } else {
    cell.style.border = `1px dashed ${COLORS.border}`;
    cell.style.color = '#555';
    cell.textContent = GLYPH[slot] ?? '';
  }
  cell.addEventListener('click', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    onSlotClick(app, dims, slot, msg);
  });
  return cell;
}

/** Принимает ли слот предмет (учёт offhand: щит или 1-ручное; блок двуручкой). */
function slotAccepts(item: Item, slot: EquipSlot, state: GameState): boolean {
  if (slot === 'offhand') {
    if ((state.save.equipment.weapon?.hands ?? 1) >= 2) return false; // занято двумя руками
    if (item.slot === 'offhand') return true; // щит
    return item.slot === 'weapon' && (item.hands ?? 1) === 1; // дуал-вилд
  }
  return item.slot === slot;
}

/** Клик по слоту пупсика: положить держимое (надеть/обмен) или взять надетое на курсор. */
function onSlotClick(app: App, dims: Dims, slot: EquipSlot, msg: HTMLElement): void {
  const state = app.state!;
  if (held) {
    // Клиентская пред-проверка (UX); авторитетно экипирует сервер по команде.
    if (!slotAccepts(held.item, slot, state)) {
      msg.textContent = slot === 'offhand' && (state.save.equipment.weapon?.hands ?? 1) >= 2
        ? 'Занято двумя руками' : 'Этот предмет не для этого слота';
      return;
    }
    if (!meetsRequirements(held.item, effectiveAttributes(state, state.save.equipment[slot] ?? undefined))) {
      msg.textContent = 'Недостаточно атрибутов';
      return;
    }
    app.sendCmd({ cmd: 'equip', uid: held.item.uid });
    clearHeld();
  } else {
    if (!state.save.equipment[slot]) return;
    app.sendCmd({ cmd: 'unequip', slot });
  }
}

// ── Сетка ────────────────────────────────────────────────────────────────────
function gridView(app: App, dims: Dims, msg: HTMLElement): HTMLElement {
  const state = app.state!;
  const box = mk('div');
  box.append(mk('p', `font-size:12px;color:${COLORS.dim};margin:0 0 8px`, 'Инвентарь'));

  const wrap = mk('div', 'position:relative');
  wrap.dataset.grid = '1';
  const w = dims.cols * CELL + (dims.cols - 1) * GAP;
  const h = dims.rows * CELL + (dims.rows - 1) * GAP;
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;

  const bg = mk('div', `display:grid;grid-template-columns:repeat(${dims.cols},${CELL}px);grid-auto-rows:${CELL}px;grid-auto-columns:${CELL}px;gap:${GAP}px`);
  for (let i = 0; i < dims.cols * dims.rows; i++) {
    bg.append(mk('div', `background:${COLORS.panel2};border:0.5px solid ${COLORS.border};border-radius:4px`));
  }

  const items = mk('div', `position:absolute;inset:0;display:grid;grid-template-columns:repeat(${dims.cols},${CELL}px);grid-auto-rows:${CELL}px;grid-auto-columns:${CELL}px;gap:${GAP}px`);
  for (const item of state.save.inventory) {
    if (!item.pos) continue;
    if (held && held.item.uid === item.uid) continue; // держимый предмет — на курсоре, в сетке прячем
    items.append(gridItemEl(app, dims, msg, item));
  }
  wrap.append(bg, items);

  // Клик по сетке: взять (если пусто в руке) или положить держимое.
  wrap.addEventListener('click', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    const rect = wrap.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / PITCH);
    const row = Math.floor((e.clientY - rect.top) / PITCH);
    if (col < 0 || row < 0 || col >= dims.cols || row >= dims.rows) return;
    if (held) placeAt(app, dims, col, row);
    else pickUpFromGrid(app, col, row);
  });

  box.append(wrap);
  return box;
}

function gridItemEl(app: App, dims: Dims, msg: HTMLElement, item: Item): HTMLElement {
  const state = app.state!;
  const el = mk('div',
    `grid-column:${item.pos!.x + 1} / span ${item.gridW};grid-row:${item.pos!.y + 1} / span ${item.gridH};` +
    `border:2px solid ${rarityHex(item.rarity)};color:${rarityHex(item.rarity)};border-radius:6px;` +
    `background:${COLORS.panel};display:flex;align-items:center;justify-content:center;text-align:center;` +
    `font-size:12px;font-weight:500;cursor:pointer;line-height:1.1;overflow:hidden;padding:2px`);
  const glyph = item.kind === 'consumable' ? '🧪' : item.slot ? GLYPH[item.slot] ?? '·' : '·';
  // Название показываем только у предметов шириной ≥2 клеток (в 1 клетку 32px имя не влезает —
  // получается нечитаемая каша); узкие рисуем глифом-типом, полное имя — в тултипе.
  el.textContent = item.gridW >= 2 ? item.name : glyph;
  attachTooltip(el, () => itemTooltipHtml(item, item.slot ? state.save.equipment[item.slot] ?? null : null));
  // Клики по предмету обрабатывает сетка (wrap). Здесь — только ПКМ-меню, когда пусто в руке.
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (held) return;
    const actions = item.kind === 'consumable'
      ? [
          { label: 'Выпить', run: () => app.sendCmd({ cmd: 'useConsumable', uid: item.uid }) },
          { label: 'В пояс', run: () => app.sendCmd({ cmd: 'moveBelt', uid: item.uid }) },
        ]
      : [
          { label: 'Надеть', run: () => app.sendCmd({ cmd: 'equip', uid: item.uid }) },
        ];
    actions.push({ label: 'Выбросить', run: () => app.sendCmd({ cmd: 'drop', uid: item.uid }) });
    showContextMenu(e.clientX, e.clientY, actions);
  });
  return el;
}

/** Берёт предмет из сетки НА КУРСОР — визуально; из сейва НЕ удаляем (перекладку сделает сервер). */
function pickUpFromGrid(app: App, col: number, row: number): void {
  const item = itemAtCell(app.state!.save.inventory, col, row);
  if (!item || !item.pos) return;
  beginHold(app, item, col - item.pos.x, row - item.pos.y);
  reRender(app); // спрятать взятый предмет в сетке
}

/**
 * Кладёт держимый предмет: шлём авторитетную команду `moveItem` (сервер: пусто→кладёт, ровно
 * один предмет под следом→обмен, 2+→отказ). Клиент только рисует ответный `saveUpdate`.
 */
function placeAt(app: App, dims: Dims, col: number, row: number): void {
  if (!held) return;
  const { item } = held;
  const tx = col - held.grabOx;
  const ty = row - held.grabOy;
  clearHeld();
  if (tx < 0 || ty < 0 || tx + item.gridW > dims.cols || ty + item.gridH > dims.rows) { reRender(app); return; }
  app.sendCmd({ cmd: 'moveItem', uid: item.uid, x: tx, y: ty });
  reRender(app);
}

// ── Контекст-меню ────────────────────────────────────────────────────────────
let openMenu: HTMLElement | null = null;
function showContextMenu(x: number, y: number, options: { label: string; run: () => void }[]): void {
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
  const close = () => { menu.remove(); openMenu = null; window.removeEventListener('pointerdown', onDoc, true); };
  const onDoc = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', onDoc, true), 0);
  document.body.appendChild(menu);
  openMenu = menu;
}
