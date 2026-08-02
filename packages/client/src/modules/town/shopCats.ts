import type { Item } from '@dm/shared';

/** Категория предмета для магазина/кузницы. */
export type ShopCat = 'melee' | 'ranged' | 'armor' | 'potion';

/**
 * Категория предмета: зелья/расходники → лавка; оружие ближнего/дальнего боя и броня (вкл. щит/бижу)
 * → кузница-магазин (3 вкладки). Ближний = melee-оружие, дальний = ranged (луки/арбалеты/жезлы/посохи).
 */
export function shopCategory(it: Item): ShopCat {
  if (it.kind === 'consumable') return 'potion';
  if (it.kind === 'weapon') return it.attackType === 'ranged' ? 'ranged' : 'melee';
  return 'armor'; // armor / shield / jewelry
}
