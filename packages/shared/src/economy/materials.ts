import type { SaveState } from '../types/save.js';
import type { Item } from '../types/items.js';
import { addToInventory, type Dims } from '../inventory/grid.js';

/**
 * КОШЕЛЁК МАТЕРИАЛОВ — счётчики по id, а НЕ предметы в сетке инвентаря.
 *
 * ⭐ ПОЧЕМУ КОШЕЛЁК, А НЕ ПРЕДМЕТЫ. Стекирования в игре нет нигде: `inventory/grid.ts`
 * всегда кладёт предмет отдельной штукой, а сетка 10×6 забилась бы материалами за один
 * забег. Кошелёк снимает всю работу по стекам, перетаскиванию и стешу разом — и так же
 * сделано в Diablo 4 и Last Epoch. Наружу это показывается вкладкой инвентаря, но
 * ХРАНИТСЯ как золото. Подробности решения — docs/ECONOMY.md.
 *
 * ⚠ Материалы при смерти НЕ теряются: они уже переработаны. Теряется то, что несёшь
 * целиком, — поэтому разбор в поле даёт меньше, чем у кузнеца (docs/ECONOMY.md, §4).
 */

/** Сколько чего лежит: id материала → количество. Нулей в карте не держим. */
export type MaterialWallet = Record<string, number>;

/** Стоимость или приход: id материала → количество. */
export type MaterialCost = Record<string, number>;

/** Кошелёк сейва. Поля может не быть (старый сейв) — это пустой кошелёк, миграция не нужна. */
export const walletOf = (save: SaveState): MaterialWallet => save.materials ?? {};

/** Сколько единиц материала есть. Неизвестный id — ноль, а не исключение. */
export const materialCount = (save: SaveState, id: string): number => walletOf(save)[id] ?? 0;

/**
 * Начислить материалы. Отрицательные и нулевые значения игнорируются: приход не должен
 * уметь списывать — для списания есть `spendMaterials`, и он атомарный.
 */
export function addMaterials(save: SaveState, gain: MaterialCost): void {
  const w: MaterialWallet = { ...walletOf(save) };
  for (const [id, n] of Object.entries(gain)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    w[id] = (w[id] ?? 0) + Math.floor(n);
  }
  save.materials = w;
}

/** Хватает ли на всю стоимость целиком. Пустая стоимость — хватает всегда. */
export function canAfford(save: SaveState, cost: MaterialCost): boolean {
  const w = walletOf(save);
  for (const [id, n] of Object.entries(cost)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    if ((w[id] ?? 0) < Math.floor(n)) return false;
  }
  return true;
}

/**
 * Списать стоимость ЦЕЛИКОМ или не списать ничего. Половинчатое списание недопустимо:
 * иначе неудачный крафт съедает материалы и ничего не даёт, а это худший вид потери
 * для игрока — он даже не поймёт, за что заплатил.
 *
 * Возвращает `true`, если списано. Позиции, ушедшие в ноль, из карты удаляются, чтобы
 * кошелёк не зарастал нулями и показывал только то, что реально есть.
 */
export function spendMaterials(save: SaveState, cost: MaterialCost): boolean {
  if (!canAfford(save, cost)) return false;
  const w: MaterialWallet = { ...walletOf(save) };
  for (const [id, n] of Object.entries(cost)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const left = (w[id] ?? 0) - Math.floor(n);
    if (left > 0) w[id] = left;
    else delete w[id];
  }
  save.materials = w;
  return true;
}

/** Чего и сколько не хватает до стоимости — для понятного отказа в интерфейсе. */
export function missingFor(save: SaveState, cost: MaterialCost): MaterialCost {
  const w = walletOf(save);
  const out: MaterialCost = {};
  for (const [id, n] of Object.entries(cost)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const lack = Math.floor(n) - (w[id] ?? 0);
    if (lack > 0) out[id] = lack;
  }
  return out;
}

/** Общее число единиц в кошельке — для строки «материалов: N» в интерфейсе. */
export const totalMaterials = (save: SaveState): number =>
  Object.values(walletOf(save)).reduce((a, b) => a + b, 0);


// ── Материал как ПЕРЕНОСИМЫЙ предмет (Ч7: сырьё едет в сумке, а не сразу в кошелёк) ──────────────

/** Запись материала в части, важной для стека (структурно ⊆ конфига `craft-materials`). */
export interface MaterialDef {
  id: string;
  name: string;
  family: string;
  tier: number;
}

/**
 * СТЕК МАТЕРИАЛА В СУМКЕ.
 *
 * Сырьё падает в инвентарь, а не в кошелёк: тогда под угрозой смерти оказывается улов ТЕКУЩЕГО
 * забега, а накопленное за десятки забегов лежит в сундуке и не теряется. И тогда же у разбора
 * появляется вторая причина существовать — он СЖИМАЕТ место: кольчуга занимает 6 клеток,
 * а пластины с неё доливаются в существующий стек и не занимают ничего.
 *
 * Предмет намеренно «пустой»: без слота, аффиксов и статов — его нельзя надеть, продать в кузнице
 * и он не попадает в журнал предметов. Всё это отсекается уже существующими проверками.
 */
export function materialItem(def: MaterialDef, count: number, uid: string): Item {
  return {
    uid,
    baseId: def.id,
    materialId: def.id,
    kind: 'material',
    name: def.name,
    rarity: 'normal',
    itemLevel: 1,
    count: Math.max(1, Math.round(count)),
    requirements: {},
    affixes: [],
    baseStats: [],
    gridW: 1,
    gridH: 1,
    pos: null,
  };
}

/** Тот же материал? Стеки сливаются только по id — разные ступени не смешиваются. */
export function sameMaterial(a: Item, b: Item): boolean {
  return a.kind === 'material' && b.kind === 'material' && !!a.materialId && a.materialId === b.materialId;
}

/** Сколько единиц материала лежит в сумке (по всем стекам). */
export function carriedMaterials(inventory: readonly Item[]): MaterialWallet {
  const out: MaterialWallet = {};
  for (const it of inventory) {
    if (it.kind !== 'material' || !it.materialId) continue;
    out[it.materialId] = (out[it.materialId] ?? 0) + (it.count ?? 1);
  }
  return out;
}

/**
 * КЛАДЁТ МАТЕРИАЛЫ В СУМКУ стеками и возвращает ОСТАТОК, который не поместился.
 *
 * Пустой остаток — всё влезло. Непустой значит «сумка полна»: зовущая сторона обязана оставить
 * этот остаток лежать на земле, а не потерять его молча. Именно это и создаёт момент «пора домой»,
 * ради которого материалы и переехали из кошелька в сумку.
 */
export function giveMaterials(
  save: SaveState,
  gains: MaterialCost,
  defs: readonly MaterialDef[],
  dims: Dims,
  stackMax: number,
  uid: () => string,
): MaterialCost {
  const left: MaterialCost = {};
  for (const [id, n] of Object.entries(gains)) {
    if (n <= 0) continue;
    const def = defs.find((d) => d.id === id);
    if (!def) continue;                                   // материал выключен/удалён — молча мимо
    const carrier = materialItem(def, n, uid());
    addToInventory(save.inventory, carrier, dims, stackMax);
    // `addToInventory` оставляет в `count` носителя ровно то, что не влезло.
    if ((carrier.count ?? 0) > 0) left[id] = carrier.count!;
  }
  return left;
}
