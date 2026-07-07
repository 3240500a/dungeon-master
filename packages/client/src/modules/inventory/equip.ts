import {
  finalAttributes,
  modifiersFromItems,
  type Item,
  type Attributes,
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
