import {
  finalAttributes,
  modifiersFromItems,
  offhandRefusal,
  type EquipSlot,
  type Item,
  type Attributes,
  type TownCommand,
} from '@dm/shared';
import type { GameState } from '../../core/gameState.js';

/**
 * Эффективные атрибуты с учётом всей экипировки, КРОМЕ указанного предмета — для клиентской
 * пред-проверки требований при экипировке (авторитетно экипирует сервер по команде `equip`).
 */
export function effectiveAttributes(state: GameState, exclude?: Item): Attributes {
  const items = state.equippedItems().filter((i) => i.uid !== exclude?.uid);
  return finalAttributes(state.save.attributes, modifiersFromItems(items));
}

/**
 * ⭐ R11-02: КОМАНДА ПУПСИКА на клик по ячейке `cell` с вещью на курсоре — или причина отказа строкой. Ячейка второй руки шлёт
 * ЦЕЛЬ (`slot: 'offhand'`): без неё сервер надевал вещь в родной слот, и кинжал, брошенный в левую ячейку, менял меч в
 * основной руке. Что встанет во вторую руку, решает то же правило, что у сервера (`offhandRefusal`): раньше своя проверка
 * пупсика не пускала щит под полуторный, который сервер надевает (§25). Требования проверяет зовущий (`effectiveAttributes`).
 */
export function paperdollCommand(item: Item, cell: EquipSlot, main: Item | undefined): TownCommand | string {
  if (cell === 'offhand') return offhandRefusal(item, main) ?? { cmd: 'equip', uid: item.uid, slot: 'offhand' };
  return item.slot === cell ? { cmd: 'equip', uid: item.uid } : 'Этот предмет не для этого слота';
}
