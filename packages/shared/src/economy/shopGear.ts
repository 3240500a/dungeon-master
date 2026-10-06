import type { ConfigRegistry } from '../config/registry.js';
import type { Item } from '../types/items.js';
import { craftTiers, shapeFoundWeapon, tierIndex } from '../formulas/craft.js';
import { generateItem, rollTierLevel } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';

/**
 * ⭐ ЛАВКА НЕ ВЫШЕ `balance.shop.maxTier` (t4, предложение «Разбор, сырьё и чары» §8.1): t5–t6 — только находки и ковка. Раньше прилавок
 * с 76-го уровня выставлял t6 (≈ 1,5 штуки за завоз на 80-м), и «купить и разобрать» было краном сырья V.
 *
 * Потолок держится ПО ИТОГОВОЙ ступени вещи, тремя замками сразу:
 * - пулы — без баз, чья НИЖНЯЯ ступень (`minTier`) выше потолка: такая база иначе выйдет выше него при любом уровне (`pickTierClamped`
 *   меняет местами перевёрнутый диапазон);
 * - бросок уровня ступени зажат под порог следующей ступени (`levelCap` = `minItemLevel` её − 1);
 * - потолок базы для броска — нижний из её `maxTier` и потолка лавки (`generateItem` → `lowerTierId`).
 * Последовательность кубика та же, что без потолка: зерно завоза и отметки о купленном (`save.townStock`) остаются верными. Уровень вещи
 * (`itemLevel`) прежний — L+1: свойства те же, пропадает только надбавка ступени.
 * ⚠ НЕТ ТАКОЙ СТУПЕНИ В КОНФИГЕ — ЗАКРЫТО, А НЕ «БЕЗ ЛИМИТА». `shop.maxTier` — свободная строка: опечатка («T4») или переименованная ступень
 * прежде давали `null` — потолка нет вовсе, и прилавок на 90-м уровне молча выкладывал t6 (кран сырья V, ради которого лимит и заведён).
 * Теперь потолок — запасная ступень `SHOP_TIER_FALLBACK`, а нет и её — нижняя; `fallback` — сервер говорит об этом при сборке конфига
 * (`economyDrift`). Отказ реестра здесь не годится: ступени и баланс правятся по таблице за раз, и переименование ступени запиралось бы.
 */
export interface ShopTierCap { id: string; index: number; levelCap: number; fallback: boolean }

/** Запасной потолок лавки, когда `balance.shop.maxTier` не найден среди ступеней (умолчание схемы). */
export const SHOP_TIER_FALLBACK = 't4';

export function shopTierCap(reg: ConfigRegistry): ShopTierCap {
  const want = reg.get('balance').shop.maxTier;
  const own = tierIndex(reg, want);
  const index = own >= 0 ? own : Math.max(0, tierIndex(reg, SHOP_TIER_FALLBACK));
  const tiers = craftTiers(reg);
  const next = tiers[index + 1];
  return {
    id: tiers[index]?.id ?? want, index, fallback: own < 0,
    levelCap: next ? Math.max(1, next.minItemLevel - 1) : Number.POSITIVE_INFINITY,
  };
}

/**
 * Снаряжение кузницы для стока героя (R1-03): броски тира, редкости и аффиксов — поэтому оно и сток. ⭐ R5-22: бросок — от сида стока
 * (`seed`): тот же сид и уровень дают те же вещи в том же порядке на любой ноде. Сервер (`Room.rollGear`) зовёт ровно это.
 */
export function rollShopGear(reg: ConfigRegistry, seed: number, heroLevel: number): Item[] {
  const itemsBase = reg.get('items.base');
  const rarities = reg.get('rarities');
  const tiers = reg.get('item-tiers');
  const affixes = reg.get('affixes');
  const uniques = reg.get('uniques');
  const rng = createRng((seed >>> 0) || 1);
  const level = Math.max(1, heroLevel);
  const bal = reg.get('balance');
  const loot = bal.loot;
  const cap = shopTierCap(reg);
  const gear: Item[] = [];
  // Оружие/броня — кузница. Гарантируем товар в КАЖДОЙ вкладке магазина (ближний/дальний/броня):
  // N роллов на категорию по её базам (generateItem с baseId → полноценный ролл: тир/редкость/аффиксы).
  // ⚠ Только ВКЛЮЧЁННЫЕ базы: выключенная база (ещё не в игре) не падает с монстров — не должна и продаваться.
  // ⭐ И только базы, что бывают не выше потолка лавки (`shopTierCap`).
  const on = itemsBase.filter((b) => b.enabled !== false && tierIndex(reg, b.minTier) <= cap.index);
  const meleeBases = on.filter((b) => b.kind === 'weapon' && b.attackType === 'melee');
  const rangedBases = on.filter((b) => b.kind === 'weapon' && b.attackType === 'ranged');
  const armorBases = on.filter((b) => b.kind === 'armor' || b.kind === 'shield' || b.kind === 'jewelry');
  const rollFrom = (pool: typeof itemsBase, count: number): void => {
    for (let i = 0; i < count && pool.length; i++) {
      const baseId = rng.pick(pool).id;
      // D21: ступень базы — БРОСОК в окне, ровно как у дропа (`rollTierLevel`). Без него прилавок
      // выставлял высшую ступень уровня каждый раз — надёжный кран верхних ступеней для разбора.
      const rolled = rollTierLevel(level + 1, loot.tierWindow, rng);
      // Меч с прилавка — как с пола: клинок несёт статы своей геометрии (§26).
      gear.push(shapeFoundWeapon(reg, generateItem(itemsBase, affixes, uniques, {
        dropBias: 1.3, itemLevel: level + 1, baseId, tiers, rarities,
        tierLevel: Math.min(rolled, cap.levelCap),
        maxTier: cap.id,
        rareNames: reg.get('rare-names'), maxReqTotal: bal.maxTotalRequirement, baseRoll: loot.baseRoll,
        // Происхождение (D16): купленное — не находка: сорт разбора не выше III, без эссенции и эскиза.
        origin: 'shop',
        // ⭐ R13-09: УНИКОВ КУЗНИЦА НЕ ПРОДАЁТ («нашёл — носи как есть», ECONOMY.md). Бросок «уник» (2,6% на вещь, у половины
        // прилавков) ставил на полку уник по цене уровня хозяина — секира палача за 284 золота у альта 1-го уровня, её
        // фиксированные аффиксы от уровня не зависят, — и на чужой базе: вкладка теряла вещь. Теперь — редкая вещь этой базы.
        noUnique: true,
      }, rng)));
    }
  };
  rollFrom(meleeBases, 9); rollFrom(rangedBases, 6); rollFrom(armorBases, 9);
  return gear;
}
