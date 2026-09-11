import type { SaveState } from '../types/save.js';

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
