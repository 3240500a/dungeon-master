/**
 * Виды города ⇄ эталон города Unity (`unity_town.json`, TownParityCheck.cs): реестр — из снимка `config`. Разделы:
 *  • `sell` — цена скупки (`sellOffer` вида лавки = `shopSellPrice` сервера);
 *  • `forge` — цена работы, сырьё подъёма и починки, эссенция перекатки, ворота, следующая ступень: сами правила ядра И карточки верстака
 *    (`benchActions`) на них — главное действие и перекатка несут ровно эти числа согласием (`gold`, `materials`) или причину строкой;
 *  • `offhand`, `equip` — вторая рука и решение пупсика (`paperdollEquipView`);
 *  • `steps`, `fillable` — ступень из деталей и «пул наберёт форму» (правила ядра под подъёмом найденного и перекаткой);
 *  • `fees` — комиссии сбросов (`respecFees`) и цена следующего ранга узла мастерства (`passiveNodeCost`).
 * Не покрыт: `drop` — «куда ляжет брошенный предмет» (геометрия курсора на клиенте; сервер проверяет `moveItem` сам).
 */
import { describe, it, expect } from 'vitest';
import type { EquipSlot, Item, SaveState } from '../types/index.js';
import {
  canRerollItem, canUpgradeItem, forgeGold, nextTierOf, offhandRefusal, repairCost, rerollMaterials, upgradeCost,
} from '../economy/townActions.js';
import { affixSlotsFillable, tierOfSteps } from '../formulas/craft.js';
import { GOLDEN, readGolden, registryFromGolden } from './town.testkit.js';
import { benchActions, paperdollEquipView, passiveNodeCost, respecFees, sellOffer } from './town.js';

type Golden = {
  config: Record<string, unknown>;
  sell: { item: Item; price: number }[];
  offhand: { main: Item | null; item: Item; refusal: string | null }[];
  forge: { item: Item; upgrade: string | null; reroll: string | null; cost: Record<string, number>; repairCost: Record<string, number>;
    rerollEssence: Record<string, number>; gold: { upgrade: number | null; reroll: number | null; repair: number | null }; next: string | null }[];
  steps: { steps: number[]; tier: number }[];
  fillable: { pool: { id: string; kind: 'prefix' | 'suffix'; group?: string }[]; slots: { minAffixes: number; maxAffixes: number; maxPrefix: number; maxSuffix: number }; fillable: boolean }[];
  equip: { save: SaveState; checks: { uid: string; cell: EquipSlot; result: string | { cmd: string; uid: string; slot?: string }; item?: Item }[] }[];
  fees: { respec: { skills: Record<string, number>; masteries: Record<string, number>; skillFee: number; passiveFee: number }[]; nodeCost: { amount: number; rank: number; cost: number }[] };
};
const g = readGolden<Golden>(GOLDEN.town);
const num = (v: number): number | null => (Number.isFinite(v) ? v : null);

describe.skipIf(!g)('виды города ⇄ unity_town.json', () => {
  const reg = registryFromGolden(g!.config);

  it('sell: цена скупки вида лавки', () => {
    for (const c of g!.sell) expect(sellOffer(reg, c.item, undefined).price, `${c.item.uid} ${c.item.name}`).toBe(c.price);
  });

  it('forge: правила ядра и карточки верстака на них', () => {
    const rich = Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 1e6]));
    for (const c of g!.forge) {
      const it = c.item;
      const who = `${it.uid} «${it.name}»`;
      const up = canUpgradeItem(reg, it), rr = canRerollItem(reg, it);
      expect(up.ok ? null : up.reason ?? '', `${who} подъём`).toBe(c.upgrade);
      expect(rr.ok ? null : rr.reason ?? '', `${who} перекатка`).toBe(c.reroll);
      for (const op of ['upgrade', 'reroll', 'repair'] as const) expect(num(forgeGold(reg, it, op)), `${who} цена ${op}`).toBe(c.gold[op]);
      expect(upgradeCost(reg, it), `${who} cost`).toEqual(c.cost);
      expect(repairCost(reg, it), `${who} repairCost`).toEqual(c.repairCost);
      expect(rerollMaterials(reg, it), `${who} rerollEssence`).toEqual(c.rerollEssence);
      expect(nextTierOf(reg, it)?.name ?? null, `${who} next`).toBe(c.next);
      // Карточки верстака — эти же числа согласием или эта же причина строкой.
      const cards = benchActions(reg, it, 1e12, [], rich);
      if (!it.broken) {
        const u = cards.find((a) => a.id === 'upgrade')!;
        if (c.upgrade === null) {
          expect(u.gold, `${who} card upgrade gold`).toBe(c.gold.upgrade);
          expect(u.materials, `${who} card upgrade materials`).toEqual(c.cost);
          expect(u.enabled).toBe(true);
          expect(u.sub).toBe(it.parts ? 'скованная вещь' : `до «${c.next}»`);
        } else {
          expect(u.lines, `${who} card upgrade why`).toEqual([{ text: c.upgrade, state: 'dim' }]);
          expect('gold' in u || 'materials' in u).toBe(false);
        }
      }
      const r = cards.find((a) => a.id === 'reroll')!;
      if (c.reroll === null) {
        expect(r.gold, `${who} card reroll gold`).toBe(c.gold.reroll);
        expect(r.materials, `${who} card reroll essence`).toEqual(c.rerollEssence);
      } else expect(r.lines, `${who} card reroll why`).toEqual([{ text: c.reroll, state: 'dim' }]);
      if (it.broken && Object.keys(c.repairCost).length && it.rarity !== 'unique') {
        const rp = cards.find((a) => a.id === 'repair')!;
        expect(rp.gold, `${who} card repair gold`).toBe(c.gold.repair);
        expect(rp.materials, `${who} card repair materials`).toEqual(c.repairCost);
      }
    }
  });

  it('offhand: что встанет во вторую руку', () => {
    for (const c of g!.offhand) expect(offhandRefusal(c.item, c.main ?? undefined), JSON.stringify([c.main, c.item])).toBe(c.refusal);
  });

  it('equip: решение пупсика — команда (родной слот / вторая рука) или причина отказа', () => {
    let n = 0;
    for (const e of g!.equip) {
      for (const c of e.checks) {
        const item = c.item ?? e.save.inventory.find((i) => i.uid === c.uid)!;
        const v = paperdollEquipView(reg, e.save, item, c.cell);
        const got = v.refusal ?? `equip${v.target ? `:${v.target}` : ''}`;
        const want = typeof c.result === 'string' ? c.result : `equip${c.result.slot ? `:${c.result.slot}` : ''}`;
        expect(got, `«${item.name}» (${c.uid}) в «${c.cell}»`).toBe(want);
        n++;
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it('steps и fillable: правила ядра под подъёмом найденного и перекаткой', () => {
    for (const c of g!.steps) {
      const [a, b, s, d] = c.steps as [number, number, number, number];
      expect(tierOfSteps(reg, { strike: { step: a }, grip: { step: b }, bind: { step: s }, head: { step: d } }).tier, c.steps.join(',')).toBe(c.tier);
    }
    for (const c of g!.fillable) expect(affixSlotsFillable(c.pool as never, c.slots), JSON.stringify(c)).toBe(c.fillable);
  });

  it('fees: комиссии сбросов и цена следующего ранга узла мастерства', () => {
    for (const c of g!.fees.respec) {
      const f = respecFees(reg, c as unknown as SaveState);
      expect(f.skills.fee, JSON.stringify(c.skills)).toBe(c.skillFee);
      expect(f.masteries.fee, JSON.stringify(c.masteries)).toBe(c.passiveFee);
    }
    const mult = reg.get('balance').passiveRankCostMult;
    for (const c of g!.fees.nodeCost) expect(passiveNodeCost(c.amount, c.rank, mult), `${c.amount}@${c.rank}`).toBe(c.cost);
  });
});
