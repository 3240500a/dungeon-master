import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import { buildCraftShell, generateItem, retierItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { canUpgradeItem, forgeUpgrade, shopBuyPrice, shopSellPrice, upgradedItem } from './townActions.js';
import type { Item, Rarity } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ R12-03: СТУПЕНЬ, КОТОРАЯ НИЧЕГО НЕ МЕНЯЕТ, НЕ ПРОДАЁТСЯ. Ступень множит только урон и броню базы (и требования). У кольца
 * и амулета нет ни того, ни другого: подъём у кузнеца брал золото и сырьё (t0 → t6 — 13 584 золота и шесть лестниц железа), а
 * вещь выходила та же — статы, требования, аффиксы, мощь героя. Лавка брала за «Мифическое» кольцо впятеро дороже «Убогого»
 * с теми же свойствами — надбавку за силу, которой нет. Сторож гоняет НАСТОЯЩИЙ подъём (`forgeUpgrade`) по каждой базе.
 */

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
type Base = ConfigShapes['items.base'][number];
const ladder = [...reg.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);
const at = (id: string | undefined, dflt: number): number => { const i = ladder.findIndex((t) => t.id === id); return i < 0 ? dflt : i; };
const fullWallet = (): Record<string, number> => Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 9999]));

/** Вещь базы на ступени `t` (середина вилки), найденная: цена подъёма от происхождения не зависит, а комплект — особый. */
function onTier(base: Base, t: number, rarity: Rarity): Item {
  return { ...buildCraftShell(base, ladder[t]!, reg.get('balance').maxTotalRequirement), rarity, origin: 'drop', uid: `noop-${base.id}-${t}-${rarity}`, pos: { x: 0, y: 0 } };
}

describe('⭐ R12-03: ступень, которая ничего не меняет, не продаётся', () => {
  it('подъём, после которого статы и требования те же, — отказ ДО оплаты: золото, сырьё и вещь нетронуты', () => {
    let noop = 0, real = 0;
    for (const base of reg.get('items.base')) {
      if (base.kind === 'consumable' || base.enabled === false) continue;
      const hi = at(base.maxTier, ladder.length - 1);
      for (let t = at(base.minTier, 0); t < hi; t++) {
        for (const rarity of ['normal', 'magic', 'rare'] as const) {
          const item = onTier(base, t, rarity);
          const next = upgradedItem(reg, item);
          const same = !!next && JSON.stringify(next.baseStats) === JSON.stringify(item.baseStats)
            && JSON.stringify(next.requirements) === JSON.stringify(item.requirements);
          if (!same) { if (next && canUpgradeItem(reg, item).ok) real++; continue; }
          noop++;
          const why = `${base.id} ${ladder[t]!.id} ${rarity}`;
          expect(canUpgradeItem(reg, item), why).toMatchObject({ ok: false });
          const save = { gold: 10_000_000, inventory: [structuredClone(item)] } as unknown as SaveState;
          const wallet = fullWallet();
          expect(forgeUpgrade(reg, save, item.uid, wallet).ok, why).toBe(false);
          expect(save.gold, why).toBe(10_000_000);
          expect(wallet, why).toEqual(fullWallet());
          expect(save.inventory[0], why).toEqual(item);
        }
      }
    }
    expect(noop, 'кольца и амулеты: пустых подъёмов много').toBeGreaterThanOrEqual(2 * 6 * 3);
    expect(real, 'настоящие подъёмы брони и оружия — по-прежнему').toBeGreaterThan(500);
  });

  it('причина отказа — «ступень ничего не меняет», а не «лучше не сделать»', () => {
    const ring = reg.get('items.base').find((b) => b.id === 'simple-ring')!;
    expect(canUpgradeItem(reg, onTier(ring, 0, 'rare')).reason).toMatch(/ничего не меняет/);
  });

  it('лавка не берёт надбавку за ступень кольца и амулета: t0 и t6 с теми же свойствами стоят одинаково', () => {
    const bal = reg.get('balance');
    for (const id of ['simple-ring', 'simple-amulet']) {
      const base = reg.get('items.base').find((b) => b.id === id)!;
      for (const rarity of ['normal', 'magic', 'rare'] as const) {
        const low = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
          dropBias: 1, itemLevel: 80, tierLevel: 1, baseId: id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
          rareNames: reg.get('rare-names'), forceRarity: rarity, maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'shop',
        }, createRng(80));
        expect(low.tier, id).toBe(ladder[0]!.id);
        const top = retierItem(base, low, ladder.at(-1)!, { maxReqTotal: bal.maxTotalRequirement, spread: bal.loot.baseRoll });
        expect(top.affixes).toEqual(low.affixes);
        expect(shopBuyPrice(reg, top), `${id} ${rarity}`).toBe(shopBuyPrice(reg, low));
        expect(shopSellPrice(reg, top)).toBe(shopSellPrice(reg, low));
      }
    }
  });

  it('контроль: у брони и оружия надбавка за ступень осталась — там ступень и есть сила', () => {
    for (const id of ['leather-armor', reg.get('items.base').find((b) => b.kind === 'weapon' && b.enabled !== false)!.id]) {
      const base = reg.get('items.base').find((b) => b.id === id)!;
      const low = onTier(base, 0, 'magic');
      expect(shopBuyPrice(reg, onTier(base, ladder.length - 1, 'magic')), id).toBeGreaterThan(shopBuyPrice(reg, low));
    }
  });
});
