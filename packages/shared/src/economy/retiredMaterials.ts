import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import type { AccountStash } from '../types/stash.js';

/**
 * ⭐ СНЯТЫЕ СЕМЬИ СЫРЬЯ — «Плечи» (`stave`) и «Фокус» (`focus`), решение владельца 06.10 (документ «Разбор, сырьё и чары», раздел «Обмен»).
 * Узкие семьи шли только с оружия своего класса, и лук, арбалет, жезл и посох на t6 ковались в 2–3 раза дольше ближнего боя. Теперь рога и
 * концы лука — Дерево (накладки и роговые ноки — Прибор: своя семья детали), дуга арбалета — Железо, навершие жезла и посоха — Прибор.
 *
 * Сырьё, которое у игроков УЖЕ лежит, переезжает в ТОТ ЖЕ СОРТ преемника: `stave-N` → `wood-N`, `focus-N` → `trim-N`. Переезд:
 * - без потерь: единица за единицу, стеки сумки сливаются в пределах `materialStack` (лишнее остаётся в последнем стеке — ни одна единица
 *   не пропадает, даже если старый стек был длиннее предела), строки оплаты ковки (`craftPaid`) меняют только id — по одной на гнездо, как
 *   были (переплавка считает долю ПО СТРОКЕ, и слитые строки вернули бы больше заплаченного);
 * - сколько угодно раз: второй проход ничего не находит (сторож `retiredMaterials.test.ts` гоняет дважды);
 * - на чтении: вход героя (`RoomManager.sanitize`), каждое чтение сундука (`sanitizeStash`), сим (`runSessionSim`) и мост редактора
 *   (`makeHarness`). Записывается то, что прочитано и приведено: в памяти старых id нет, и первая же запись кладёт в базу новые.
 * Согласие со старыми id (`maxMaterials` / `minYield` старой вкладки) не приводится: это ОТКАЗ «Цена изменилась…» — окно перечитает конфиг.
 * Оверрайды конфига в базе приводит `upgradeStoredOverride` (`config/storedOverride.ts`).
 */
export const RETIRED_FAMILIES: Readonly<Record<string, string>> = Object.freeze({ stave: 'wood', focus: 'trim' });

/** Преемник снятого id того же сорта (`stave-3` → `wood-3`, `focus-5` → `trim-5`); не снятый — `undefined`. */
export function retiredSuccessor(id: string): string | undefined {
  const m = /^([a-z]+)-(\d+)$/.exec(id);
  if (!m || !Object.prototype.hasOwnProperty.call(RETIRED_FAMILIES, m[1]!)) return undefined;
  return `${RETIRED_FAMILIES[m[1]!]}-${m[2]}`;
}

/** id сырья под нынешний конфиг: снятый — преемник, прочий — как есть. */
export const liveMaterialId = (id: string): string => retiredSuccessor(id) ?? id;

/** Семья под нынешний конфиг: `stave` → `wood`, `focus` → `trim`, прочая — как есть. */
export const liveFamily = (family: string): string =>
  (Object.prototype.hasOwnProperty.call(RETIRED_FAMILIES, family) ? RETIRED_FAMILIES[family]! : family);

/**
 * Кошелёк (сундук аккаунта, старый кошелёк героя) — снятые id в преемника, суммой. НА МЕСТЕ: ссылку на кошелёк держат (кузница пишет в тот
 * же объект). Мусорные счётчики не трогает — их чистит `sanitizeStash`. `true` — что-то переехало.
 */
export function migrateWallet(wallet: Record<string, number> | undefined): boolean {
  if (!wallet || typeof wallet !== 'object') return false;
  let moved = false;
  for (const id of Object.keys(wallet)) {
    const to = retiredSuccessor(id);
    if (!to) continue;
    const n = wallet[id]!;
    delete wallet[id];
    moved = true;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
    wallet[to] = (typeof wallet[to] === 'number' && Number.isFinite(wallet[to]) ? wallet[to]! : 0) + n;
  }
  return moved;
}

/** Имя материала по id (стек сумки носит имя строкой) — из таблицы сырья; нет строки — прежнее имя. */
export interface RetiredDefs { id: string; name: string }

/**
 * Вещь: стек снятого сырья — в преемника (id, база стека и имя по таблице сырья), строки оплаты ковки — в преемника (по строке на гнездо).
 * `true` — вещь изменилась.
 */
export function migrateItemMaterials(item: Item, defs: readonly RetiredDefs[] = []): boolean {
  let changed = false;
  if (item.kind === 'material' && item.materialId) {
    const to = retiredSuccessor(item.materialId);
    if (to) {
      if (item.baseId === item.materialId) item.baseId = to;
      item.materialId = to;
      const def = defs.find((d) => d.id === to);
      if (def) item.name = def.name;
      changed = true;
    }
  }
  if (Array.isArray(item.craftPaid)) {
    for (const line of item.craftPaid) {
      const to = line && typeof line.id === 'string' ? retiredSuccessor(line.id) : undefined;
      if (to) { line.id = to; changed = true; }
    }
  }
  return changed;
}

/**
 * Список вещей (сумка, вкладка сундука, старый сундук героя): каждую — `migrateItemMaterials`, а стеки сырья, в которых что-то переехало,
 * сливаются со стеками того же id в пределах `stackMax` (по порядку в списке; опустевшие убираются, место в сетке освобождается). Лишнее
 * сверх предела остаётся в последнем стеке — без потерь. Чужие стеки (без переезда) не трогает. `true` — список изменился.
 */
export function migrateItemList(items: (Item | null)[] | undefined, defs: readonly RetiredDefs[] = [], stackMax = Infinity): boolean {
  if (!Array.isArray(items)) return false;
  const touched = new Set<string>();
  let changed = false;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const was = it.kind === 'material' ? it.materialId : undefined;
    if (migrateItemMaterials(it, defs)) {
      changed = true;
      if (was && it.materialId && it.materialId !== was) touched.add(it.materialId);
    }
  }
  const cap = Number.isFinite(stackMax) && stackMax >= 1 ? Math.floor(stackMax) : Infinity;
  for (const id of touched) {
    const stacks = items.filter((it): it is Item => !!it && it.kind === 'material' && it.materialId === id);
    if (stacks.length < 2) continue;
    let left = stacks.reduce((s, it) => s + countOf(it), 0);
    // Опустевшие — по ссылке, а не по счётчику: `countOf` читает 0 как 1 (стек без числа — одна единица), и проверка «count ≤ 0» через него
    // оставляла в сумке стеки ×0 (три стека 7 + 5 + 10 → 22 + 0 + 0, живая проверка 06.10).
    const emptied = new Set<Item>();
    stacks.forEach((it, i) => {
      const take = i === stacks.length - 1 ? left : Math.min(cap, left);
      if (take > 0) it.count = take; else emptied.add(it);
      left -= take;
    });
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && emptied.has(it)) items.splice(i, 1);
    }
  }
  return changed;
}

const countOf = (it: Item): number => (typeof it.count === 'number' && Number.isFinite(it.count) && it.count >= 1 ? Math.floor(it.count) : 1);

/**
 * Сейв героя: сумка (со слиянием стеков), надетое, пояс, старый сундук героя (`save.stash`) и старый кошелёк героя (`save.materials`).
 * `true` — что-то переехало.
 */
export function migrateRetiredInSave(save: SaveState, defs: readonly RetiredDefs[] = [], stackMax = Infinity): boolean {
  let changed = migrateItemList(save.inventory, defs, stackMax);
  for (const it of Object.values(save.equipment ?? {})) if (it && migrateItemMaterials(it, defs)) changed = true;
  // Пояс — по слотам (индекс = клавиша): стеки в нём не сливаются и не убираются, только меняют id (сырья там и не бывает).
  for (const it of Array.isArray(save.belt) ? save.belt : []) if (it && migrateItemMaterials(it, defs)) changed = true;
  if (migrateItemList(save.stash, defs, stackMax)) changed = true;
  if (migrateWallet(save.materials)) changed = true;
  return changed;
}

/** Сундук аккаунта: кошелёк сырья и вкладки (вещи и стеки, если их туда переложили). `true` — что-то переехало. */
export function migrateRetiredInStash(stash: AccountStash, defs: readonly RetiredDefs[] = [], stackMax = Infinity): boolean {
  let changed = migrateWallet(stash.materials);
  for (const tab of Array.isArray(stash.tabs) ? stash.tabs : []) if (migrateItemList(tab, defs, stackMax)) changed = true;
  return changed;
}
