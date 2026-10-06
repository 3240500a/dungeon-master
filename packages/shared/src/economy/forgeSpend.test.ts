import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import { balanceSchema } from '../config/schemas.js';
import {
  baseTierRange, craftTiers, defaultParts, essenceCost, fullJournal, partFamily, partsOf, salvageGrades, shapeFoundWeapon, tierIndex,
} from '../formulas/craft.js';
import { anatomyRow } from '../formulas/craftType.js';
import { generateItem, tierMatters } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { ESSENCE_ID, salvageRuleFor } from '../formulas/salvage.js';
import {
  UNIQUE_NO_UPGRADE, canUpgradeItem, craftAction, enchantAction, enchantMaterials, forgeReroll, repairCost, rerollMaterials, salvageRange, upgradeCost,
  upgradedItem,
} from './townActions.js';
import { emptyStash } from './stashActions.js';
import type { Item, Rarity } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ СТОРОНА ТРАТ КУЗНИЦЫ (предложение «Разбор, сырьё и чары» §6.2, §7; решения владельца 06.10):
 *  - ПОДЪЁМ — по ЦЕЛЕВОЙ СТУПЕНИ, а не по редкости: основа — верх вилки разбора вещи у кузнеца, будь она найдена на целевой ступени
 *    (семьи деталей, рецепт `salvage.recipeByTier`), плюс расходник I сорта главной семьи. Редкость меняет только золото. Уник — явный отказ.
 *  - ПОЧИНКА — расходник I + главный сорт вещи на её ступени.
 *  - ЗАЧАРОВАНИЕ и ПЕРЕКАТКА — сверх золота ЭССЕНЦИЯ: 2 + 2×ступень, редкая ×2, перекатка — половина.
 * Сторож держит правило НАСТОЯЩИМИ вещами генератора дропа — каждая база × ступень, — а не выборкой.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const tiers = craftTiers(reg);
const bal = reg.get('balance');
const RARITIES: Rarity[] = ['normal', 'magic', 'rare'];

/** Найденная вещь базы на ступени `t` (бросок — порог ступени), как её кладёт дроп сервера. */
function found(baseId: string, t: number, rarity: Rarity = 'normal', seed = 1): Item {
  const lvl = tiers[t]!.minItemLevel;
  return shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
    dropBias: 1, itemLevel: lvl, tierLevel: lvl, baseId, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: rarity,
    maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
  }, createRng(seed * 7919 + lvl)));
}
const grade = (id: string): number => Number(id.split('-').pop());
const family = (id: string): string => id.replace(/-\d+$/, '');
const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);

describe('⭐ §7: подъём — по целевой ступени, семьями деталей; починка — по нынешней', () => {
  it('⭐ каждая база × ступень: основа — сорта рецепта целевой ступени (не выше), расходник — I сорт главной семьи; редкость сырья не меняет', () => {
    let n = 0, weapons = 0;
    for (const base of reg.get('items.base').filter((b) => b.kind !== 'consumable' && b.enabled !== false && tierMatters(b))) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t < hi; t++) {
        const it = found(base.id, t);
        if (tierIndex(reg, it.tier) !== t) continue;
        const next = upgradedItem(reg, it);
        if (!next || !canUpgradeItem(reg, it).ok) continue;
        const target = tierIndex(reg, next.tier);
        expect(target, `${base.id} t${t}`).toBe(t + 1);
        const cost = upgradeCost(reg, it);
        const row = bal.salvage.recipeByTier[target]!;
        for (const id of Object.keys(cost)) expect(grade(id), `${base.id} t${t}→t${target}: ${id} выше рецепта ${row.join('/')}`).toBeLessThanOrEqual(Math.max(...row));
        // Расходник: `consumable` I сорта главной семьи (у оружия по деталям — семья ударной части).
        const anat = base.kind === 'weapon' ? anatomyRow(reg, base.weaponClass) : undefined;
        const picks = partsOf(reg, next);
        if (anat && picks) {
          const strike = reg.get('weapon-parts').find((p) => p.id === picks.strike.id)!;
          const main = partFamily(anat, 'strike', strike);
          expect(cost[`${main}-1`] ?? 0, `${base.id}: расходник`).toBeGreaterThanOrEqual(bal.forgePrices.upgradeMaterials.consumable);
          // Основа — 7 единиц (3 + 2 + 1 + 1) по рецепту целевой ступени: верх вилки разбора меча-находки той ступени.
          expect(sum(cost) - bal.forgePrices.upgradeMaterials.consumable, `${base.id} t${t}: основа`).toBe(7);
          expect(cost[`${main}-${row[0]}`] ?? 0, `${base.id} t${t}: удар по рецепту`).toBeGreaterThanOrEqual(3);
          weapons++;
        }
        // Редкость — только в золоте.
        for (const rarity of RARITIES) {
          const other = { ...it, rarity };
          expect(upgradeCost(reg, other), `${base.id} t${t} ${rarity}`).toEqual(cost);
          expect(repairCost(reg, { ...other, broken: true }), `${base.id} t${t} ${rarity}: починка`).toEqual(repairCost(reg, { ...it, broken: true }));
        }
        n++;
      }
    }
    expect(n, 'шагов подъёма').toBeGreaterThan(200);
    expect(weapons, 'оружие по деталям').toBeGreaterThan(100);
  });

  it('⭐ IV и V тратятся подъёмом: найденное оружие t5 → t6 — вся основа сорта V, t4 → t5 — сорта IV; у не-находки — то же (цена — «как у находки»)', () => {
    let seen = 0;
    for (const base of reg.get('items.base').filter((b) => b.kind === 'weapon' && b.enabled !== false && baseTierRange(reg, b).hi === tiers.length - 1)) {
      for (let seed = 1; seed < 6; seed++) {
        for (const [from, g] of [[tiers.length - 2, 5], [tiers.length - 3, 4]] as const) {
          const it = found(base.id, from, 'normal', seed);
          if (tierIndex(reg, it.tier) !== from || !canUpgradeItem(reg, it).ok) continue;
          for (const origin of ['drop', 'shop', undefined] as const) {
            const cost = upgradeCost(reg, { ...it, origin });
            const top = Object.entries(cost).filter(([id]) => grade(id) === g).reduce((s, [, k]) => s + k, 0);
            expect(top, `${base.id} t${from}→t${from + 1} (${origin ?? 'без происхождения'})`).toBe(7);
          }
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it('⭐ починка: расходник I + главный сорт вещи на её ступени (удар оружия, нижний у брони) — по каждой ступени', () => {
    const k = bal.forgePrices.repairMaterials;
    let n = 0;
    for (const base of reg.get('items.base').filter((b) => (b.kind === 'weapon' || b.kind === 'armor' || b.kind === 'shield') && b.enabled !== false)) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t <= hi; t++) {
        const it = { ...found(base.id, t), broken: true };
        if (tierIndex(reg, it.tier) !== t) continue;
        const cost = repairCost(reg, it);
        expect(sum(cost), `${base.id} t${t}`).toBe(k.consumable + k.main);
        const g = salvageGrades(reg, { ...it, origin: 'drop' });
        const want = base.kind === 'weapon' && partsOf(reg, it) ? g.row[0]! : g.low;
        expect(Math.max(...Object.keys(cost).map(grade)), `${base.id} t${t}: главный сорт`).toBe(want);
        expect(new Set(Object.keys(cost).map(family)).size, `${base.id} t${t}: одна семья`).toBe(1);
        n++;
      }
    }
    expect(n).toBeGreaterThan(300);
  });

  it('⭐ уник кузнец не поднимает — явный отказ у КАЖДОГО уника конфига, и цена подъёма пуста', () => {
    let n = 0;
    for (const u of reg.get('uniques')) {
      const base = reg.get('items.base').find((b) => b.id === u.baseId);
      if (!base || !tierMatters(base)) continue;
      const it = { ...found(base.id, baseTierRange(reg, base).lo), rarity: 'unique' as const };
      expect(canUpgradeItem(reg, it), u.id).toEqual({ ok: false, reason: UNIQUE_NO_UPGRADE });
      expect(upgradeCost(reg, it), u.id).toEqual({});
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe('⭐ узкие семьи ковки — не только с оружия своего класса (рецензия 06.10)', () => {
  /**
   * Прибор (обвязка и оголовье почти у всех классов — 96 из 240 единиц ковки t5/t6), Плечи (лук и арбалет), Фокус (жезл и посох) и Ткань
   * (тетива) шли только с разбора оружия своего класса, и ковка t5/t6 упиралась в них в 2–6 раз дольше железа. Теперь у каждой семьи ковки
   * есть источник среди брони, щитов и украшений: кольцо и амулет — прибор, щит — побочный прибор, латы и кольчуга — побочная Ткань
   * (поддоспешник). ⭐ 06.10: «Плечи» и «Фокус» сняты (лук — Дерево, арбалетная дуга — Железо, навершие — Прибор), побочных Плеч у
   * кожаной и стёганой брони больше нет.
   */
  it('у каждой семьи, которую тратит ковка, есть источник вне оружия', () => {
    const used = new Set<string>();
    for (const a of reg.get('weapon-anatomy')) for (const slot of ['strike', 'grip', 'bind', 'head'] as const) used.add(a[slot].family);
    const fromGear = new Set<string>();
    for (const r of reg.get('salvage-rules')) {
      if (r.enabled === false || (r.kind !== 'armor' && r.kind !== 'shield' && r.kind !== 'jewelry')) continue;
      for (const y of r.yields) fromGear.add(family(y.materialId));
    }
    for (const f of used) expect(fromGear.has(f), `семья «${f}» идёт только с оружия своего класса`).toBe(true);
  });

  it('кольцо и амулет — прибор (в сорт ступени; Фокус снят 06.10), украшение железа больше не даёт', () => {
    for (const [baseId, fam] of [['ring', 'trim'], ['amulet', 'trim']] as const) {
      const base = reg.get('items.base').find((b) => b.kind === 'jewelry' && b.slot === baseId)!;
      const it = found(base.id, 5, 'normal');
      const r = salvageRange(reg, it, false).range;
      expect(Object.keys(r).some((id) => family(id) === fam && grade(id) === salvageGrades(reg, it).low), `${base.id}: ${JSON.stringify(r)}`).toBe(true);
      expect(Object.keys(r).some((id) => family(id) === 'iron'), base.id).toBe(false);
    }
  });

  it('⭐ побочный выход правила («0–N») в основу подъёма не входит: подъём брони и щита — как прежде, главными семьями', () => {
    let n = 0;
    for (const base of reg.get('items.base').filter((b) => (b.kind === 'armor' || b.kind === 'shield') && b.enabled !== false && tierMatters(b))) {
      const it = found(base.id, 4);
      if (!canUpgradeItem(reg, it).ok) continue;
      const rule = salvageRuleFor(it, undefined, reg.get('salvage-rules'))!;
      const yields = rule.yields ?? [];
      const must = new Set(yields.filter((y) => y.min > 0).map((y) => family(y.materialId)));
      const optional = yields.filter((y) => y.min <= 0).map((y) => family(y.materialId)).filter((f) => !must.has(f));
      // 06.10: у кожаной и стёганой брони побочных Плеч больше нет (семья снята) — побочный выход есть у лат, кольчуги и щитов.
      if (rule.kind === 'armor' && (rule.armorClass === 'leather' || rule.armorClass === 'quilted')) { expect(optional, base.id).toEqual([]); continue; }
      expect(optional.length, `${base.id}: у правила есть побочный выход`).toBeGreaterThan(0);
      for (const id of Object.keys(upgradeCost(reg, it))) expect(optional.includes(family(id)), `${base.id}: ${id} в цене подъёма`).toBe(false);
      n++;
    }
    expect(n).toBeGreaterThan(10);
  });
});

describe('⭐ §6.2: эссенция зачарования и перекатки', () => {
  it('⭐ таблица предложения: до магической 2 + 2×ступень, до редкой ×2, перекатка — половина', () => {
    const it = found('long-sword', 0);
    const row = (r: Rarity, op: 'enchant' | 'reroll'): number[] => tiers.map((t) => essenceCost(reg, { ...it, tier: t.id }, r, op));
    expect(row('magic', 'enchant')).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(row('rare', 'enchant')).toEqual([4, 8, 12, 16, 20, 24, 28]);
    expect(row('magic', 'reroll')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(row('rare', 'reroll')).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(essenceCost(reg, it, 'normal', 'enchant'), 'не магическая и не редкая — нечего катать').toBe(0);
    expect(rerollMaterials(reg, { ...it, rarity: 'rare' })).toEqual({ [ESSENCE_ID]: 2 });
    expect(enchantMaterials(reg, it, 'rare')).toEqual({ [ESSENCE_ID]: 4 });
  });

  it('эссенция выключена в редакторе — чары и перекатка без неё (выключенный материал не участвует в рецептах), а не заперты навсегда', () => {
    const off = new ConfigRegistry();
    off.loadAll();
    off.reload({ 'craft-materials': off.get('craft-materials').map((m) => (m.id === ESSENCE_ID ? { ...m, enabled: false } : m)) }, { cross: false });
    const it = { ...found('long-sword', 0, 'magic'), pos: { x: 0, y: 0 } };
    expect(rerollMaterials(off, it)).toEqual({});
    const save = { gold: 1_000_000, inventory: [it] } as unknown as SaveState;
    expect(forgeReroll(off, save, it.uid, createRng(1), undefined, {}).ok).toBe(true);
  });

  it('⭐ зачарование списывает эссенцию сначала из сумки, недостающее — из сундука; переплавка её не вернёт', () => {
    const save = { gold: 10_000_000, inventory: [] } as unknown as SaveState;
    const stash = { ...emptyStash(reg), materials: Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 999])), forgeJournal: fullJournal(reg) };
    const parts = defaultParts(reg, 'sword', 1, 3)!;
    const c = craftAction(reg, save, stash, 'spend-essence-1', { weaponClass: 'sword', hands: 1, parts }, createRng(3));
    expect(c.ok, c.reason).toBe(true);
    const item = save.inventory.find((i) => i.uid === c.uid)!;
    const need = enchantMaterials(reg, item, 'rare')[ESSENCE_ID]!;
    stash.materials[ESSENCE_ID] = need;   // ровно столько в сундуке
    const before = stash.materials[ESSENCE_ID];
    const e = enchantAction(reg, save, item.uid, 'rare', createRng(5), undefined, stash.materials);
    expect(e.ok, e.reason).toBe(true);
    expect(stash.materials[ESSENCE_ID] ?? 0).toBe(before - need);
    const enchanted = save.inventory.find((i) => i.uid === e.uid)!;
    expect(enchanted.craftPaid?.some((l) => l.id === ESSENCE_ID), 'эссенция в «заплачено» ковки не пишется').toBe(false);
  });
});

describe('конфиг: новые ключи — значения в data/balance.json и совпадают с умолчаниями схемы (оверрайд старше ключа их не теряет)', () => {
  it('forgePrices.upgradeMaterials / repairMaterials, craft.cost.essence; прежних ключей (tier1…3, ladderByRarity, mythicSalvages) нет', () => {
    const raw = defaultConfigData.balance as unknown as {
      forgePrices: Record<string, unknown>; craft: { cost: Record<string, unknown>; journal: Record<string, unknown> };
    };
    const defaults = balanceSchema.parse({ ...raw, forgePrices: { ...raw.forgePrices, upgradeMaterials: undefined, repairMaterials: undefined },
      craft: { ...raw.craft, cost: { ...raw.craft.cost, essence: undefined } } });
    expect(raw.forgePrices.upgradeMaterials).toEqual(defaults.forgePrices.upgradeMaterials);
    expect(raw.forgePrices.repairMaterials).toEqual(defaults.forgePrices.repairMaterials);
    expect(raw.craft.cost.essence).toEqual(defaults.craft.cost.essence);
    expect('ladderByRarity' in raw.forgePrices).toBe(false);
    expect('mythicSalvages' in raw.craft.journal).toBe(false);
    // Схема не пускает перекатку дороже зачарования и редкую дешевле магической.
    for (const bad of [{ rerollShare: 1.5 }, { rareMult: 0.5 }, { base: -1 }]) {
      const b = structuredClone(raw) as typeof raw;
      b.craft.cost.essence = { ...(raw.craft.cost.essence as object), ...bad };
      expect(balanceSchema.safeParse(b).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
