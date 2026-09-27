import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { Item } from '../types/items.js';
import { type AccountStash, STASH_VERSION } from '../types/stash.js';
import { cellFree, packInventory, placeWithDisplacement, type Dims } from '../inventory/grid.js';
import { isSafeKey, normalizeCraftNonces, normalizeJournal } from '../formulas/craft.js';
import { mendBrokenUniques, type ActionResult } from './townActions.js';

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
 * пустыми), лечит битые/наложенные позиции в каждой вкладке (`packInventory`), чистит журнал
 * кузнеца и ключи заявок на ковку, снимает «сломано» со старых уников (R7-19). НЕ удаляет лишние вкладки при
 * уменьшении конфига — анти-потеря предметов. Мутирует и возвращает stash.
 */
export function sanitizeStash(reg: ConfigRegistry, stash: AccountStash): AccountStash {
  const dims = stashDims(reg);
  const need = stashTabCount(reg);
  if (!Array.isArray(stash.tabs)) stash.tabs = [];
  while (stash.tabs.length < need) stash.tabs.push([]);
  for (const tab of stash.tabs) packInventory(tab, dims);
  for (const tab of stash.tabs) mendBrokenUniques(tab);   // R7-19: сломанный уник старого сейва — цел
  cleanWallet(stash);
  // Журнал и ключи заявок приходят из JSONB как есть — доверять их форме нельзя (D1): всё, что не
  // того типа, отбрасывается, ключей — не больше 32 последних. Нет поля — пустой журнал, как у нового.
  stash.forgeJournal = normalizeJournal(stash.forgeJournal);
  stash.craftNonces = normalizeCraftNonces(stash.craftNonces);
  return stash;
}

/**
 * Кошелёк сырья из базы → только целые положительные счётчики под безопасными ключами. Отрицательное
 * или NaN в кошельке сломало бы проверку «хватает ли» (сравнение с NaN всегда ложно), а ключ вроде
 * `__proto__` дальше по коду подменил бы прототип. Чистит НА МЕСТЕ: ссылку на кошелёк могут держать.
 */
function cleanWallet(stash: AccountStash): void {
  const w = stash.materials as unknown;
  if (!w || typeof w !== 'object' || Array.isArray(w)) { stash.materials = {}; return; }
  const rec = w as Record<string, unknown>;
  for (const id of Object.keys(rec)) {
    const n = rec[id];
    if (isSafeKey(id) && typeof n === 'number' && Number.isFinite(n) && n >= 1) rec[id] = Math.floor(n);
    else delete rec[id];
  }
}

/**
 * ПЕРЕЕЗД СТАРОГО ПЕРСОНАЖНОГО КОШЕЛЬКА В АККАУНТНЫЙ — одноразово, при первом входе героя.
 *
 * До этой правки `SaveState.materials` был у КАЖДОГО персонажа свой. Теперь сырьё общее, и всё
 * накопленное надо влить в аккаунтный кошелёк. ⚠ Поле в сейве после вливания ОБНУЛЯЕТСЯ — иначе
 * при следующем входе оно влилось бы второй раз и сырьё бы задвоилось. Если у аккаунта несколько
 * героев со своими кошельками, каждый вольётся ровно один раз, и это ПРАВИЛЬНО: их запасы
 * складываются в общий.
 */
export function migrateWalletToStash(save: SaveState, stash: AccountStash): boolean {
  const old = save.materials;
  if (!old || !Object.keys(old).length) return false;
  const w = stash.materials ?? (stash.materials = {});
  for (const [id, n] of Object.entries(old)) if (n > 0) w[id] = (w[id] ?? 0) + n;
  save.materials = {};
  return true;
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
