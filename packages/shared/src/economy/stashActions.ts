import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { Item } from '../types/items.js';
import { type AccountStash, STASH_VERSION } from '../types/stash.js';
import { cellFree, packInventory, placeWithDisplacement, type Dims } from '../inventory/grid.js';
import type { ActionResult } from './townActions.js';

/**
 * АВТОРИТЕТНЫЕ операции над ОБЩИМ (на аккаунт) городским сундуком — чистые, для сервера.
 * Сундук живёт вне SaveState; перекладка может затрагивать и `save.inventory` героя, и вкладки
 * сундука. Переиспользуют общую сетку (`inventory/grid`) — та же истина, что у инвентаря.
 */

/** Размер одной вкладки сундука (клетки). */
export function stashDims(reg: ConfigRegistry): Dims {
  const s = reg.get('balance').stash;
  return { cols: s.cols, rows: s.rows };
}
/** Сколько вкладок в сундуке (по конфигу). */
export function stashTabCount(reg: ConfigRegistry): number {
  return reg.get('balance').stash.tabs;
}

/**
 * Приводит сундук к валидному виду под текущий конфиг: гарантирует ≥N вкладок (добивает
 * пустыми), лечит битые/наложенные позиции в каждой вкладке (`packInventory`). НЕ удаляет
 * лишние вкладки при уменьшении конфига — анти-потеря предметов. Мутирует и возвращает stash.
 */
export function sanitizeStash(reg: ConfigRegistry, stash: AccountStash): AccountStash {
  const dims = stashDims(reg);
  const need = stashTabCount(reg);
  if (!Array.isArray(stash.tabs)) stash.tabs = [];
  while (stash.tabs.length < need) stash.tabs.push([]);
  for (const tab of stash.tabs) packInventory(tab, dims);
  return stash;
}

/** Пустой сундук (для аккаунта без сохранённого). */
export function emptyStash(reg: ConfigRegistry): AccountStash {
  return sanitizeStash(reg, { version: STASH_VERSION, tabs: [] });
}

/** Назначение перекладки: инвентарь героя (`'inv'`) или вкладка сундука по индексу. */
export type StashDst = 'inv' | number;

/**
 * АВТОРИТЕТНАЯ перекладка предмета между инвентарём героя и вкладками общего сундука (и
 * внутри одного контейнера). Предмет ищется по uid в инвентаре и во всех вкладках.
 *  - тот же контейнер → `placeWithDisplacement` (свап одного предмета, как в инвентаре);
 *  - разные контейнеры → кладём только на свободный след (`cellFree`), иначе «Нет места» — без
 *    свапа через границу (проще курсор, исключает потерю предмета).
 * Мутирует `save.inventory` и `stash.tabs`. Возвращает {ok, reason?}.
 */
export function stashMove(
  reg: ConfigRegistry, save: SaveState, stash: AccountStash, uid: string, dst: StashDst, x: number, y: number,
): ActionResult {
  sanitizeStash(reg, stash); // гарантирует нужные вкладки перед доступом по индексу

  // Источник: инвентарь или вкладка, где лежит предмет.
  let src: Item[] | null = null;
  if (save.inventory.some((i) => i.uid === uid)) src = save.inventory;
  else for (const tab of stash.tabs) if (tab.some((i) => i.uid === uid)) { src = tab; break; }
  if (!src) return { ok: false, reason: 'Предмет не найден' };

  // Целевой контейнер + его размеры.
  if (dst !== 'inv' && !stash.tabs[dst]) return { ok: false, reason: 'Нет такой вкладки' };
  const target: Item[] = dst === 'inv' ? save.inventory : stash.tabs[dst]!;
  const dims: Dims = dst === 'inv' ? reg.get('balance').inventory : stashDims(reg);
  const item = src.find((i) => i.uid === uid)!;

  if (src === target) {
    // Внутри одного контейнера — свап с вытеснением одного предмета.
    return placeWithDisplacement(target, item, x, y, dims) ? { ok: true } : { ok: false, reason: 'Не помещается' };
  }

  // Между контейнерами — только на свободное место.
  if (!cellFree(target, x, y, item.gridW, item.gridH, dims)) return { ok: false, reason: 'Нет места' };
  src.splice(src.indexOf(item), 1);
  item.pos = { x, y };
  target.push(item);
  return { ok: true };
}
