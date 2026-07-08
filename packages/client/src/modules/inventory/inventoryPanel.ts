import { meetsRequirements, type EquipSlot, type Item } from '@dm/shared';
import type { App } from '../../core/app.js';
import type { GameState } from '../../core/gameState.js';
import type { PanelFactory } from '../../ui/domUi.js';
import { effectiveAttributes } from './equip.js';
import { itemsOverlapping, type Dims } from './grid.js';
import { itemTooltipHtml } from './itemView.js';
import { rarityHex } from '../loot/rarity.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';
import { GLYPH, getHeld, beginHold, clearHeld, resolveHeldOnClose, setLastPointer } from './heldItem.js';
import { renderGrid, showContextMenu } from './gridView.js';

/**
 * Инвентарь + пупсик экипировки. Раскладка (item.pos) АВТОРИТЕТНА НА СЕРВЕРЕ: клиент только
 * рисует, «взять/положить» идёт единым курсором `heldItem` (общий с сундуком) → серверная
 * команда `moveItem` (внутри инвентаря) или `stashMove dst:'inv'` (если тащим из сундука).
 */

function itemAtCell(inv: Item[], col: number, row: number): Item | null {
  return itemsOverlapping(inv, col, row, 1, 1, '')[0] ?? null;
}

// ── Панель ───────────────────────────────────────────────────────────────────
export const inventoryPanel: PanelFactory = (app) => ({
  title: 'Инвентарь и экипировка',
  render(body) {
    const dims: Dims = app.config.get('balance').inventory;
    const msg = mk('div', `color:${COLORS.bad};font-size:12px;min-height:16px;margin:4px 0`);

    const layout = mk('div', 'display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start');
    layout.append(paperdoll(app, msg), gridView(app, dims));
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

function paperdoll(app: App, msg: HTMLElement): HTMLElement {
  const box = mk('div');
  box.append(mk('p', `font-size:12px;color:${COLORS.dim};margin:0 0 8px`, 'Экипировка'));
  const grid = mk('div', 'display:grid;grid-template-columns:repeat(3,62px);gap:12px');
  for (const slot of DOLL_LAYOUT) {
    grid.append(slot ? equipSlotCell(app, slot, msg) : mk('div'));
  }
  box.append(grid);
  return box;
}

function equipSlotCell(app: App, slot: EquipSlot, msg: HTMLElement): HTMLElement {
  const state = app.state!;
  const item = state.save.equipment[slot] ?? null;
  const cell = mk('div',
    `width:62px;height:62px;border-radius:8px;display:flex;align-items:center;justify-content:center;` +
    `font-size:15px;font-weight:500;background:${COLORS.panel2};cursor:pointer`);
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
    setLastPointer(e.clientX, e.clientY);
    onSlotClick(app, slot, msg);
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
function onSlotClick(app: App, slot: EquipSlot, msg: HTMLElement): void {
  const state = app.state!;
  const held = getHeld();
  if (held) {
    // Надеть можно только из инвентаря (сервер экипирует из save.inventory). Из сундука — сначала в инвентарь.
    if (held.from !== 'inv') { msg.textContent = 'Сначала перенесите предмет в инвентарь'; return; }
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

// ── Сетка инвентаря ───────────────────────────────────────────────────────────
function gridView(app: App, dims: Dims): HTMLElement {
  const state = app.state!;
  const box = mk('div');
  box.append(mk('p', `font-size:12px;color:${COLORS.dim};margin:0 0 8px`, 'Инвентарь'));
  box.append(renderGrid(state.save.inventory, dims, {
    onPick: (col, row) => pickUpFromGrid(app, col, row),
    onPlace: (col, row) => placeAt(app, dims, col, row),
    tooltip: (item) => itemTooltipHtml(item, item.slot ? state.save.equipment[item.slot] ?? null : null),
    contextMenu: (item, x, y) => itemMenu(app, item, x, y),
  }));
  return box;
}

function itemMenu(app: App, item: Item, x: number, y: number): void {
  const actions = item.kind === 'consumable'
    ? [
        { label: 'Выпить', run: () => app.sendCmd({ cmd: 'useConsumable', uid: item.uid }) },
        { label: 'В пояс', run: () => app.sendCmd({ cmd: 'moveBelt', uid: item.uid }) },
      ]
    : [
        { label: 'Надеть', run: () => app.sendCmd({ cmd: 'equip', uid: item.uid }) },
      ];
  actions.push({ label: 'Выбросить', run: () => app.sendCmd({ cmd: 'drop', uid: item.uid }) });
  showContextMenu(x, y, actions);
}

/** Берёт предмет из сетки НА КУРСОР — визуально; из сейва НЕ удаляем (перекладку сделает сервер). */
function pickUpFromGrid(app: App, col: number, row: number): void {
  const item = itemAtCell(app.state!.save.inventory, col, row);
  if (!item || !item.pos) return;
  beginHold(app, item, col - item.pos.x, row - item.pos.y, 'inv');
}

/**
 * Кладёт держимый предмет в инвентарь: команда зависит от источника — `moveItem` (из инвентаря,
 * свап под следом на сервере) или `stashMove dst:'inv'` (тащим из вкладки сундука). Клиент рисует ответ.
 */
function placeAt(app: App, dims: Dims, col: number, row: number): void {
  const held = getHeld();
  if (!held) return;
  const { item, grabOx, grabOy, from } = held;
  const tx = col - grabOx;
  const ty = row - grabOy;
  clearHeld();
  if (tx < 0 || ty < 0 || tx + item.gridW > dims.cols || ty + item.gridH > dims.rows) { app.bus.emit('state:changed', {}); return; }
  if (from === 'inv') app.sendCmd({ cmd: 'moveItem', uid: item.uid, x: tx, y: ty });
  else app.sendCmd({ cmd: 'stashMove', uid: item.uid, dst: 'inv', x: tx, y: ty });
  app.bus.emit('state:changed', {});
}
