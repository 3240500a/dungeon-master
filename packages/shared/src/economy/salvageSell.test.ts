import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import {
  baseTierRange, craftTiers, craftWeapon, defaultParts, emptyJournal, essenceCost, priceTierIndex, salvageGrades, salvageTierIndex, shapeFoundWeapon,
} from '../formulas/craft.js';
import { generateItem, itemFromBaseId, rollTierLevel } from '../formulas/itemgen.js';
import { createRng, type Rng } from '../formulas/rng.js';
import { ESSENCE_ID, type SalvageRng } from '../formulas/salvage.js';
import { salvageSellIssues } from '../formulas/salvageGuard.js';
import { newCharacterSave } from './newCharacter.js';
import { emptyStash } from './stashActions.js';
import {
  enchantAction, fieldSalvage, forgeGold, forgeSalvage, salvageRange, salvageWorth, sellItem, shopSellPrice, upgradedItem,
} from './townActions.js';
import type { Item, ItemOrigin, Rarity } from '../types/items.js';
import type { SaveState } from '../types/save.js';
/** §6.2: зачарование и перекатка тратят эссенцию — кошелёк сундука с запасом (тесту важно не это). */
const essWallet = (): Record<string, number> => ({ [ESSENCE_ID]: 1_000_000 });

/**
 * ⭐ D4 (решение владельца 06.10: «пусть продаются, надо просто сделать так, чтобы это было не выгодно, как во всех играх»):
 * РАЗОБРАТЬ ВЕЩЬ И ПРОДАТЬ СЫРЬЁ (И ЭССЕНЦИЮ) НЕ ВЫГОДНЕЕ, ЧЕМ ПРОДАТЬ САМУ ВЕЩЬ — у кузнеца и в поле, у каждой базы × ступени × редкости ×
 * происхождения; переплавить скованную и продать сырьё — не выгоднее, чем продать её. Держится:
 *  - ЦЕНАМИ СЫРЬЯ (1 · 2 · 5 · 10 · 15, эссенция 5): у найденных вещей пол цены не включается вовсе — цена вещи её формула (здесь проверено
 *    настоящими вещами генератора дропа, лавки, наград, подъёма);
 *  - ПРАВИЛОМ ЯДРА (`shopSellPrice`: пол — `salvageWorth`): у скованной (переплавка возвращает долю заплаченного) и при ЛЮБОМ конфиге — и при
 *    множителе редкости у нуля, и при ценах сырья мимо реестра (фаззер ниже);
 *  - РЕЕСТРОМ (`salvageSellIssues`, проверка поверх таблиц): цену сырья выше вещи редактор не сохранит.
 * Заодно — правила сорта (предложение «Разбор, сырьё и чары» §1): IV — только у найденных t4+, V — только у найденных t6, купленное и вещь без
 * происхождения — не выше III, поднятая — по исходной ступени, старая «★»-вещь без ступени — по уровню, а не по статам.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const MAX: SalvageRng = { int: (_a, b) => b, chance: () => true };
const ORIGINS: (ItemOrigin | undefined)[] = ['drop', 'chest', 'boss', 'quest', 'shop', undefined];
const RARITIES: Rarity[] = ['normal', 'magic', 'rare'];
const priceOf = (r: ConfigRegistry, id: string): number => r.get('craft-materials').find((m) => m.id === id)?.sellPrice ?? 0;
/** Продажа по формуле вещи, без пола (`shopSellPrice` до D4): `0.4 × (15 + 4·ilvl + 12·аффиксы) × редкость`. */
const flatSell = (r: ConfigRegistry, it: Item): number => {
  const pm = r.get('rarities').find((x) => x.id === it.rarity)?.priceMult ?? 1;
  return Math.max(1, Math.floor(Math.round((15 + it.itemLevel * 4 + it.affixes.length * 12) * pm) * 0.4));
};
/** Верх выхода разбора в поле (лучший бросок) в ценах лавки. */
const fieldTop = (r: ConfigRegistry, it: Item): number =>
  Math.ceil(Object.entries(salvageRange(r, it, true).range).reduce((s, [id, x]) => s + x.max * priceOf(r, id), 0));

/** Вещи, какими они бывают в игре: дроп (окно ступени), лавка, награда, без происхождения — каждая база × редкость, уровни 1..100. */
function realItems(r: ConfigRegistry, rng: Rng, perLevel = 2): Item[] {
  const out: Item[] = [];
  const bases = r.get('items.base').filter((b) => b.kind !== 'consumable' && b.enabled !== false);
  const loot = r.get('balance').loot;
  for (let level = 1; level <= 100; level += 3) {
    for (let k = 0; k < perLevel; k++) {
      const base = rng.pick(bases);
      const origin = rng.pick(ORIGINS);
      const it = shapeFoundWeapon(r, generateItem(r.get('items.base'), r.get('affixes'), r.get('uniques'), {
        dropBias: 1, itemLevel: level, tierLevel: rollTierLevel(level, loot.tierWindow, rng), baseId: base.id, tiers: r.get('item-tiers'),
        rarities: r.get('rarities'), forceRarity: rng.pick(RARITIES), maxReqTotal: r.get('balance').maxTotalRequirement, baseRoll: loot.baseRoll,
        ...(origin ? { origin } : {}),
      }, rng));
      if (it.rarity !== 'unique') out.push(it);
    }
  }
  return out;
}

describe('⭐ D4: разобрать и продать сырьё не выгоднее, чем продать вещь', () => {
  it('⭐ каждая база × ступень (низ окна) × редкость × происхождение: разбор у кузнеца и в поле — не дороже продажи; пол не включается', () => {
    const tiers = craftTiers(reg);
    const over = reg.get('balance').loot.tierWindow.over;
    let n = 0;
    for (const base of reg.get('items.base').filter((b) => b.kind !== 'consumable' && b.enabled !== false)) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t <= hi; t++) {
        const tier = tiers[t]!;
        for (const rarity of RARITIES) for (const origin of ORIGINS) for (const lvl of [Math.max(1, tier.minItemLevel - over), tier.minItemLevel]) {
          const raw = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
            dropBias: 1, itemLevel: lvl, tierLevel: tier.minItemLevel, baseId: base.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
            forceRarity: rarity, maxReqTotal: reg.get('balance').maxTotalRequirement, baseRoll: reg.get('balance').loot.baseRoll,
            ...(origin ? { origin } : {}),
          }, createRng(t * 97 + lvl)));
          if (raw.rarity !== rarity || raw.tier !== tier.id) continue;
          // Худший случай — без аффиксов (у пула мог кончиться выбор).
          for (const it of [raw, { ...raw, affixes: [] }]) {
            const tag = `${base.id} ${tier.id} ${rarity} ${origin ?? 'без происхождения'} ур.${lvl} аффиксов ${it.affixes.length}`;
            const sell = shopSellPrice(reg, it);
            expect(salvageWorth(reg, it), `${tag}: кузнец`).toBeLessThanOrEqual(sell);
            expect(fieldTop(reg, it), `${tag}: поле`).toBeLessThanOrEqual(sell);
            expect(sell, `${tag}: цена — формула вещи, пол не включается`).toBe(flatSell(reg, it));
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(5000);
  });

  it('⭐ настоящими действиями: разобрал у кузнеца (и в поле) и сдал всё сырьё — не больше, чем сдал вещь (дроп, лавка, награды, подъём)', () => {
    const rng = createRng(20261006);
    const items = realItems(reg, rng, 4);
    // Поднятые кузнецом — по исходной ступени (`bornTier`).
    for (const it of items.slice(0, 60)) { const up = upgradedItem(reg, it); if (up) items.push({ ...up, uid: `${up.uid}-up` }); }
    let n = 0;
    for (const it of items) {
      const direct = mkSave([it]);
      expect(sellItem(reg, direct, it.uid).ok).toBe(true);
      for (const inField of [false, true]) {
        const save = mkSave([it]);
        const ok = inField ? fieldSalvage(reg, save, it.uid, MAX).ok : forgeSalvage(reg, save, emptyStash(reg), it.uid, MAX).ok;
        if (!ok) continue;
        for (const m of save.inventory.filter((x) => x.kind === 'material')) expect(sellItem(reg, save, m.uid).ok).toBe(true);
        expect(save.gold, `«${it.name}» ${it.tier} ${it.rarity} ${it.origin ?? '—'} ${inField ? 'поле' : 'кузница'}`).toBeLessThanOrEqual(direct.gold);
        n++;
      }
    }
    expect(n).toBeGreaterThan(300);
  });

  it('⭐ скованное: переплавить и сдать сырьё не выгоднее, чем сдать вещь — пол цены (у кузнеца и в поле, и зачарованное)', () => {
    let n = 0, floorOn = 0;
    for (const t of reg.get('weapon-types').filter((x) => x.enabled !== false)) {
      for (const hands of [...new Set(t.bases.map((b) => b.hands))]) for (const step of [1, 3, 5]) {
        const parts = defaultParts(reg, t.id, hands, step);
        const pv = parts ? craftWeapon(reg, { weaponClass: t.id, hands, parts }, { rng: createRng(step) }) : null;
        if (!pv?.ok || !pv.item) continue;
        const forged: Item = { ...pv.item, uid: `f-${t.id}-${hands}-${step}`, origin: 'craft' };
        const variants: Item[] = [forged];
        const s0 = mkSave([forged]);
        s0.gold = 1e9;
        if (enchantAction(reg, s0, forged.uid, 'rare', createRng(1), undefined, essWallet()).ok) variants.push({ ...s0.inventory.find((i) => i.uid === forged.uid)! });
        for (const it of variants) {
          const sell = shopSellPrice(reg, it);
          if (sell > flatSell(reg, it)) floorOn++;
          for (const inField of [false, true]) {
            const save = mkSave([it]);
            const ok = inField ? fieldSalvage(reg, save, it.uid, MAX).ok : forgeSalvage(reg, save, emptyStash(reg), it.uid, MAX).ok;
            if (!ok) continue;
            expect(save.inventory.some((x) => x.materialId === ESSENCE_ID), 'переплавка эссенции не даёт').toBe(false);
            for (const m of save.inventory.filter((x) => x.kind === 'material')) expect(sellItem(reg, save, m.uid).ok).toBe(true);
            expect(save.gold, `${it.name} ${inField ? 'поле' : 'кузница'}`).toBeLessThanOrEqual(sell);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(40);
    expect(floorOn, 'у сторожа есть зубы: без пола переплавка обгоняла бы продажу').toBeGreaterThan(0);
  });

  it('⭐ ФАЗЗ конфига: множитель редкости 0…3, цены сырья и эссенции мимо реестра, выход разбора — правило держится всегда', () => {
    const r0 = createRng(406);
    let n = 0, floorOn = 0;
    for (let k = 0; k < 24; k++) {
      const r = new ConfigRegistry();
      r.loadAll();
      const pm = (x: ConfigShapes['rarities'][number]): ConfigShapes['rarities'][number] => ({ ...x, priceMult: Math.round(r0.float(0, 3) * 100) / 100 });
      const mats = r.get('craft-materials').map((m) => ({ ...m, sellPrice: r0.int(0, 60) }));
      const bal = structuredClone(r.get('balance'));
      bal.salvage.essence = { magic: r0.int(0, 4), rare: r0.int(0, 6), unique: 2 };
      for (const sl of ['strike', 'grip', 'bind', 'head'] as const) bal.craft.salvage.units[sl] = r0.int(0, 6);
      bal.salvage.fieldYield = Math.round(r0.float(0, 0.95) * 100) / 100;
      r.reload({ rarities: r.get('rarities').map(pm), 'craft-materials': mats, balance: bal }, { cross: false });
      for (const it of realItems(r, r0, 1)) {
        const sell = shopSellPrice(r, it);
        if (sell > flatSell(r, it)) floorOn++;
        expect(salvageWorth(r, it), `конфиг ${k}: «${it.name}»`).toBeLessThanOrEqual(sell);
        expect(fieldTop(r, it), `конфиг ${k}: «${it.name}» в поле`).toBeLessThanOrEqual(sell);
        n++;
      }
    }
    expect(n).toBeGreaterThan(500);
    expect(floorOn, 'фаззер доходит до конфигов, где правило держит пол').toBeGreaterThan(20);
  });

  it('⭐ реестр не пускает цену сырья выше вещи: правка цены, лишняя единица разбора — отказ с причиной; поставка — без нарушений', () => {
    expect(salvageSellIssues({
      balance: reg.get('balance'), 'item-tiers': reg.get('item-tiers'), 'craft-materials': reg.get('craft-materials'), 'salvage-rules': reg.get('salvage-rules'),
    })).toEqual([]);
    const r = new ConfigRegistry();
    r.loadAll();
    expect(() => r.reload({ 'craft-materials': r.get('craft-materials').map((m) => (m.id === 'iron-5' ? { ...m, sellPrice: 40 } : m)) })).toThrow(/D4 разбор не выгоднее продажи/);
    expect(() => r.reload({ 'craft-materials': r.get('craft-materials').map((m) => (m.id === 'plate-1' ? { ...m, sellPrice: 3 } : m)) })).toThrow(/D4/);
    const bal = structuredClone(r.get('balance'));
    bal.craft.salvage.units.strike = 6;
    expect(() => r.reload({ balance: bal })).toThrow(/D4/);
    // Правка редкости живьём (R23-04) этим правилом не запирается — её держит пол цены.
    expect(() => r.reload({ rarities: r.get('rarities').map((x) => ({ ...x, priceMult: 0 })) })).not.toThrow();
  });
});

describe('⭐ сорт = ступень вещи (§1): высокие сорта — только с находок', () => {
  it('⭐ каждая база × ступень × редкость × происхождение: сорт — рецепт ступени, не-находка — не выше III; IV только у найденных t4+, V — у t6', () => {
    const tiers = craftTiers(reg);
    const recipe = reg.get('balance').salvage.recipeByTier;
    let n = 0;
    for (const base of reg.get('items.base').filter((b) => b.kind !== 'consumable' && b.enabled !== false)) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t <= hi; t++) for (const rarity of RARITIES) for (const origin of ORIGINS) {
        const tier = tiers[t]!;
        const it = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
          dropBias: 1, itemLevel: tier.minItemLevel + 2, tierLevel: tier.minItemLevel, baseId: base.id, tiers: reg.get('item-tiers'),
          rarities: reg.get('rarities'), forceRarity: rarity, baseRoll: reg.get('balance').loot.baseRoll, ...(origin ? { origin } : {}),
        }, createRng(t + 13)));
        if (it.rarity !== rarity || it.tier !== tier.id) continue;
        const full = origin !== undefined && origin !== 'shop';
        const r = salvageRange(reg, it, false);
        expect(r.ok, `${base.id} ${tier.id}`).toBe(true);
        const grades = Object.keys(r.range).filter((id) => id !== ESSENCE_ID).map((id) => Number(id.split('-').pop()));
        const top = Math.max(...grades);
        const tag = `${base.id} ${tier.id} ${rarity} ${origin ?? '—'}`;
        expect(top, tag).toBeLessThanOrEqual(full ? Math.max(...recipe[t]!) : Math.min(3, Math.max(...recipe[t]!)));
        if (top >= 4) expect(full && t >= 4, `${tag}: IV+ — только найденное t4+`).toBe(true);
        if (top >= 5) expect(full && t === tiers.length - 1, `${tag}: V — только найденное t6`).toBe(true);
        // Эссенция — только находки и награды магической/редкой редкости.
        const ess = r.range[ESSENCE_ID]?.max ?? 0;
        const want = full ? (reg.get('balance').salvage.essence as Record<string, number>)[rarity] ?? 0 : 0;
        expect(ess, `${tag}: эссенция`).toBe(want);
        n++;
      }
    }
    expect(n).toBeGreaterThan(1000);
  });

  it('⭐ поднятая кузнецом разбирается по исходной ступени (`bornTier`): «поднять и разобрать» не даёт ни сорта, ни единицы сверх', () => {
    let n = 0;
    for (const base of reg.get('items.base').filter((b) => (b.kind === 'weapon' || b.kind === 'armor') && b.enabled !== false).slice(0, 40)) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t < hi; t++) {
        const tier = craftTiers(reg)[t]!;
        let it = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
          dropBias: 1, itemLevel: tier.minItemLevel, tierLevel: tier.minItemLevel, baseId: base.id, tiers: reg.get('item-tiers'),
          rarities: reg.get('rarities'), forceRarity: 'rare', baseRoll: reg.get('balance').loot.baseRoll, origin: 'drop',
        }, createRng(t * 5 + 1)));
        if (it.tier !== tier.id || it.rarity !== 'rare') continue;
        const before = salvageRange(reg, it, false).range;
        for (let k = 0; k < 3; k++) {
          const up = upgradedItem(reg, it);
          if (!up) break;
          expect(up.bornTier, `${base.id}: исходная ступень записана один раз`).toBe(tier.id);
          expect(salvageRange(reg, up, false).range, `${base.id} ${tier.id} → ${up.tier}`).toEqual(before);
          it = up;
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(30);
  });

  it('⭐ старый сейв (прод 08.08): без происхождения и ступени, статы раздуты «★»-подъёмом — сорт по УРОВНЮ вещи, не выше III, без эссенции', () => {
    const base = reg.get('items.base').find((b) => b.id === 'short-sword')!;
    const it = itemFromBaseId(reg.get('items.base'), base.id, reg.get('item-tiers'))!;
    const star: Item = { ...it, rarity: 'magic', itemLevel: 12, baseStats: it.baseStats.map((m) => ({ ...m, value: Math.round(m.value * 1.2 ** 10) })) };
    delete star.tier;
    delete star.origin;
    const t = salvageTierIndex(reg, star);
    expect(craftTiers(reg)[t]!.minItemLevel, 'ступень — по уровню вещи, не по статам').toBeLessThanOrEqual(12);
    const r = salvageRange(reg, star, false);
    expect(Object.keys(r.range).every((id) => !/-[45]$/.test(id))).toBe(true);
    expect(r.range[ESSENCE_ID]).toBeUndefined();
    expect(salvageGrades(reg, star).cap).toBe(3);
  });

  it('⭐ та же «★»-вещь: цена перекатки и починки (золото и эссенция) — по той же ступени, что разбор, а не по раздутым статам', () => {
    // Прежде разбор читал её t0 (по уровню), а перекатка — t6 (по статам): 14 эссенции и золото мифика за вещь 12-го уровня.
    const base = reg.get('items.base').find((b) => b.id === 'short-sword')!;
    const it = itemFromBaseId(reg.get('items.base'), base.id, reg.get('item-tiers'))!;
    const star: Item = { ...it, rarity: 'rare', itemLevel: 12, baseStats: it.baseStats.map((m) => ({ ...m, value: Math.round(m.value * 1.2 ** 10) })) };
    delete star.tier;
    delete star.origin;
    const t = salvageTierIndex(reg, star);
    expect(priceTierIndex(reg, star)).toBe(t);
    const k = reg.get('balance').craft.cost.essence;
    expect(essenceCost(reg, star, 'rare', 'reroll')).toBe(Math.ceil((k.base + k.perTier * t) * k.rareMult * k.rerollShare - 1e-9));
    // Золото перекатки и починки — как у такой же вещи, у которой ступень записана (та, что по уровню).
    const tiered: Item = { ...star, tier: craftTiers(reg)[t]!.id };
    expect(forgeGold(reg, star, 'reroll')).toBe(forgeGold(reg, tiered, 'reroll'));
    expect(forgeGold(reg, star, 'repair')).toBe(forgeGold(reg, tiered, 'repair'));
    // Подъём по-прежнему читает ступень по статам: он пересобирает статы от базы, и вещь не должна «улучшаться» в слабую.
    expect(upgradedItem(reg, star), 'раздутая до потолка базы — выше не поднимается').toBeUndefined();
  });

  it('стартовый набор и тела: эссенции и сырья комплект не даёт; тело монстра — только I сорт (salvage.test.ts)', () => {
    const kit = newCharacterSave(reg, 'warrior', 't', 't');
    for (const it of Object.values(kit.equipment)) if (it) expect(salvageRange(reg, it, false).range).toEqual({});
    expect(emptyJournal().gearSeen).toEqual([]);
  });
});

function mkSave(inventory: Item[]): SaveState {
  return { gold: 0, inventory: inventory.map((i) => ({ ...i, pos: null })) } as unknown as SaveState;
}
