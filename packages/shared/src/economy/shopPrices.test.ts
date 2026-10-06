import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import {
  baseTierRange, craftTiers, craftWeapon, enchantCost, enchantItem, enchantSlots, keyVariantsByBase, meltReturn,
  partById, shapeFoundWeapon, tierOfSteps, variantsFor, type CraftInput,
} from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, keySlotOf, type CraftSlot } from '../formulas/craftType.js';
import { generateItem, itemFromBaseId, rollTierLevel } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { monsterTrophyBase } from '../formulas/trophy.js';
import type { SalvageRng } from '../formulas/salvage.js';
import {
  buyItem, craftAction, forgeSalvage, forgeUpgrade, salvageRange, salvageWorth, salvageYield, sellItem, shopBuyPrice, shopConsumableIds, shopItemValue,
  shopSellPrice,
} from './townActions.js';
import { materialItem } from './materials.js';
import { emptyStash } from './stashActions.js';
import type { CraftParts, Item, Rarity } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ D21 (К2): ЦЕНА ВИДИТ СТУПЕНЬ, и ни одна петля «золото → вещь → сырьё/золото» не печатает денег.
 *
 * Валюта сравнения — золото и сырьё по `craft-materials.sellPrice`: ровно по этой цене сырьё и продаётся
 * (`shopSellPrice` стека). Инварианты гоняются НАСТОЯЩИМИ действиями (купить, сковать, разобрать, продать),
 * а не формулами цены — формула, проверенная сама собой, ничего не сторожит.
 *  а) сковал → продал: выручка меньше золота ковки (сырьё ковки — сверху), в том числе после зачарования;
 *  б) сковал → переплавил: возврат меньше цены по каждому материалу, и в сумме с золотом — убыток;
 *  в) купил в лавке → (поднял у кузнеца) → разобрал → продал сырьё: не больше, чем заплачено;
 *  в″) КАЖДЫЙ ОДИН шаг подъёма найденной вещи любой редкости — не в плюс ни продажей, ни разбором (R3-21);
 *  г) поднял ступень у кузнеца → продал: прибавка продажи меньше цены подъёма на ЛЮБОМ уровне вещи.
 */

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
type Base = ConfigShapes['items.base'][number];
type WeaponBase = Extract<Base, { kind: 'weapon' }>;
const MAX: SalvageRng = { int: (_a, b) => b, chance: () => true };
const mats = reg.get('craft-materials');
const worth = (m: Record<string, number>): number => Object.entries(m).reduce((s, [id, n]) => s + n * (mats.find((x) => x.id === id)?.sellPrice ?? 0), 0);
const fullWallet = (): Record<string, number> => Object.fromEntries(mats.map((m) => [m.id, 5000]));
const mkSave = (gold: number, inventory: Item[] = []): SaveState => ({ gold, inventory } as unknown as SaveState);
const tiers = craftTiers(reg);
const over = reg.get('balance').loot.tierWindow.over;
let nonceN = 0;
const nonce = (): string => `shop-${String(++nonceN).padStart(6, '0')}`;

/** Продать всё сырьё из сумки — так, как его продаст игрок. */
function sellMaterials(save: SaveState): void {
  for (const it of save.inventory.filter((i) => i.kind === 'material')) expect(sellItem(reg, save, it.uid).ok).toBe(true);
}

/** Вещь «с прилавка»: как `rollGear` сервера (дроп-генератор + форма найденного), с заданной ступенью и редкостью (`R` — реестр, по умолчанию поставка). */
function shopItem(base: Base, itemLevel: number, tierLevel: number, rarity: Rarity, seed: number, R: ConfigRegistry = reg): Item {
  return shapeFoundWeapon(R, generateItem(R.get('items.base'), R.get('affixes'), R.get('uniques'), {
    dropBias: 1.3, itemLevel, tierLevel, baseId: base.id, tiers: R.get('item-tiers'), rarities: R.get('rarities'),
    rareNames: R.get('rare-names'), forceRarity: rarity, maxReqTotal: R.get('balance').maxTotalRequirement,
    baseRoll: R.get('balance').loot.baseRoll, origin: 'shop',
  }, createRng(seed)));
}

// ── Заявка на ковку базы ровно нужной ступени ───────────────────────────────────────────────────
type Steps = Record<CraftSlot, number>;
const COMBOS: Steps[] = [];
for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (let c = 1; c <= 5; c++) for (let d = 1; d <= 5; d++) COMBOS.push({ strike: a, grip: b, bind: c, head: d });
const spreadOf = (s: Steps): number => Math.max(...CRAFT_SLOT_LIST.map((k) => s[k])) - Math.min(...CRAFT_SLOT_LIST.map((k) => s[k]));
COMBOS.sort((x, y) => spreadOf(x) - spreadOf(y));
const stepsOf = (s: Steps) => ({ strike: { step: s.strike }, grip: { step: s.grip }, bind: { step: s.bind }, head: { step: s.head } });

/** Ровнейшая четвёрка ступеней, из которой база `base` куётся ровно ступенью `t` (или `null`). */
function inputFor(base: WeaponBase, t: number, finish = 0): CraftInput | null {
  const cls = base.weaponClass, hands = base.hands ?? 1;
  const keySlot = keySlotOf(reg, cls);
  const keys = keyVariantsByBase(reg, cls, hands).find((g) => g.baseId === base.id)?.variants ?? [];
  if (!keys.length) return null;
  for (const s of COMBOS) {
    if (tierOfSteps(reg, stepsOf(s)).tier !== t) continue;
    const parts = {} as CraftParts;
    let ok = true;
    for (const slot of CRAFT_SLOT_LIST) {
      const pool = slot === keySlot ? keys : variantsFor(reg, cls, slot, hands);
      const p = pool.find((v) => v.stepMin <= s[slot] && s[slot] <= v.stepMax);
      if (!p) { ok = false; break; }
      parts[slot] = { id: p.id, step: s[slot] };
    }
    if (!ok) continue;
    const input: CraftInput = { weaponClass: cls, hands, parts, finish };
    const pv = craftWeapon(reg, input);
    if (pv.ok && pv.type?.baseId === base.id && pv.tier === t) return input;
  }
  return null;
}

const weaponBases = reg.get('items.base').filter((b): b is WeaponBase => b.kind === 'weapon' && b.enabled !== false);

/** Реестр с правкой баланса — для проверки, что сторож ловит подложенную прибыль (R3-21). */
function patched(patch: (b: ConfigShapes['balance']) => void): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  const b = structuredClone(r.get('balance'));
  patch(b);
  r.reload({ balance: b });
  return r;
}

/**
 * ⭐ R3-21: ОДИН ШАГ ПОДЪЁМА НАЙДЕННОЙ ВЕЩИ — настоящим `forgeUpgrade`. Цена шага — золото и сырьё (по `sellPrice`),
 * ценность вещи — лучшее из «сдать в лавку» и «разобрать у кузнеца» (верх вилки разбора, `salvageWorth`). Шаг в плюс,
 * если ценность выросла НЕ МЕНЬШЕ, чем стоил шаг. Находка бесплатна (цены покупки с надбавкой ступени нет, в отличие от
 * (в′)), поэтому здесь видна прибыль любого отдельного шага — у любой базы, ступени и редкости.
 */
function profitableUpgradeSteps(
  r: ConfigRegistry, only: { rarities?: readonly Rarity[]; kinds?: readonly string[]; forgetBorn?: boolean } = {},
): { n: number; bad: string[] } {
  const ts = craftTiers(r);
  const priced = new Map(r.get('craft-materials').map((m) => [m.id, m.sellPrice]));
  const value = (m: Record<string, number>): number => Object.entries(m).reduce((s, [id, k]) => s + k * (priced.get(id) ?? 0), 0);
  const worthOf = (it: Item): number => Math.max(salvageWorth(r, it), shopSellPrice(r, it));
  const bases = r.get('items.base').filter((b) => b.kind !== 'consumable' && b.enabled !== false && (!only.kinds || only.kinds.includes(b.kind)));
  const bad: string[] = [];
  let n = 0;
  for (const base of bases) {
    const { lo, hi } = baseTierRange(r, base);
    for (let t = lo; t < hi; t++) {
      const tier = ts[t]!;
      for (const rarity of only.rarities ?? (['normal', 'magic', 'rare'] as const)) {
        for (const extra of [0, 10, 30, 60]) {
          const it = shapeFoundWeapon(r, generateItem(r.get('items.base'), r.get('affixes'), r.get('uniques'), {
            dropBias: 1, itemLevel: tier.minItemLevel + extra, tierLevel: tier.minItemLevel, baseId: base.id, tiers: r.get('item-tiers'),
            rarities: r.get('rarities'), rareNames: r.get('rare-names'), forceRarity: rarity, maxReqTotal: r.get('balance').maxTotalRequirement,
            baseRoll: r.get('balance').loot.baseRoll, origin: 'drop',
          }, createRng(t * 131 + extra + 7)));
          if (it.rarity === 'unique' || it.tier !== tier.id) continue;
          const before = worthOf(it);
          const save = mkSave(100_000_000, [{ ...it, pos: null }]);
          const wallet = Object.fromEntries(r.get('craft-materials').map((m) => [m.id, 5000]));
          const w0 = value(wallet);
          if (!forgeUpgrade(r, save, it.uid, wallet).ok) continue;
          const up = save.inventory.find((i) => i.uid === it.uid)!;
          // Самопроверка зубов: «забыть» исходную ступень — разбор пойдёт по нынешней (как до `bornTier`, но и без «как купленная»).
          if (only.forgetBorn) { delete up.bornTier; delete up.tierForged; }
          const after = worthOf(up);
          const paid = (100_000_000 - save.gold) + (w0 - value(wallet));
          n++;
          if (after - before >= paid) bad.push(`${base.id} ${tier.id}→ ${rarity} ур.${it.itemLevel}: ценность +${after - before}, шаг стоил ${paid}`);
        }
      }
    }
  }
  return { n, bad };
}

describe('D21: цена видит ступень', () => {
  it('на пороге своей ступени вещь стоит ×statMult прежней цены; выше ступень — дороже', () => {
    const base = weaponBases.find((b) => baseTierRange(reg, b).hi === tiers.length - 1 && baseTierRange(reg, b).lo === 0)!;
    let prev = 0;
    for (const t of tiers) {
      const it = shopItem(base, t.minItemLevel, t.minItemLevel, 'normal', 3);
      expect(it.tier).toBe(t.id);
      expect(shopItemValue(reg, it), t.id).toBe(Math.round((15 + 4 * t.minItemLevel) * t.statMult));
      const flat = shopItem(base, 80, t.minItemLevel, 'normal', 3);   // тот же уровень, разные ступени
      expect(shopItemValue(reg, flat), t.id).toBeGreaterThan(prev);
      prev = shopItemValue(reg, flat);
    }
    // §12.4: «обычная» мифическая с прилавка на 80-м уровне была ≈ 339 золота — теперь ≈ ×6.
    const myth = shopItem(base, 81, 80, 'normal', 3);
    expect(shopItemValue(reg, myth)).toBeGreaterThan(5 * 339);
  });

  it('вещь без тира (старый сейв, зелье) — прежняя формула', () => {
    const it = { ...shopItem(weaponBases[0]!, 30, 30, 'magic', 4), tier: undefined };
    const pm = reg.get('rarities').find((r) => r.id === 'magic')!.priceMult;
    expect(shopItemValue(reg, it)).toBe(Math.round((15 + 30 * 4 + it.affixes.length * 12) * pm));
  });

  it('⭐ сырьё продаётся ПОШТУЧНО по sellPrice (раньше — 7 золота за стек любой длины)', () => {
    for (const m of mats) {
      for (const n of [1, 7, 200]) expect(shopSellPrice(reg, materialItem(m, n, `u-${m.id}-${n}`)), `${m.id}×${n}`).toBe(m.sellPrice * n);
    }
    // Мусор в счётчике — одна штука, а не NaN и не «бесконечно».
    const one = mats.find((m) => m.sellPrice > 1)!;
    for (const junk of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(shopSellPrice(reg, { ...materialItem(one, 3, 'j'), count: junk as number }), String(junk)).toBe(one.sellPrice);
    }
  });

  it('⭐ детали сорт не «протекают»: «Крепкий» с булатным клинком разбирается как «Крепкий», а не в три булата (рецепт ступени, §4.1)', () => {
    // Ступень вещи — средняя по массе (§11): булатный клинок при прочем из первой ступени даёт t2. Раньше разбор отдавал
    // материалы деталей ИХ ступеней — три булата с «Крепкого», и лавке нужен был пол цены покупки по сырью разбора (D21).
    // Теперь сорт — рецепт ступени вещи (t2 — II), и купленное — не выше III: такая вещь стоит как «Крепкий».
    const t2 = tiers.findIndex((t) => t.id === 't2');
    const recipe = reg.get('balance').salvage.recipeByTier[t2]!;
    let found = 0;
    for (const base of weaponBases) {
      const cls = base.weaponClass, hands = base.hands ?? 1;
      const keySlot = keySlotOf(reg, cls);
      const key = keyVariantsByBase(reg, cls, hands).find((g) => g.baseId === base.id)?.variants.find((v) => v.stepMax === 5);
      if (!key || tierOfSteps(reg, stepsOf({ strike: keySlot === 'strike' ? 5 : 1, grip: keySlot === 'grip' ? 5 : 1, bind: keySlot === 'bind' ? 5 : 1, head: keySlot === 'head' ? 5 : 1 })).tier !== t2) continue;
      const parts = {} as CraftParts;
      let ok = true;
      for (const slot of CRAFT_SLOT_LIST) {
        const p = slot === keySlot ? key : variantsFor(reg, cls, slot, hands).find((v) => v.stepMin <= 1);
        if (!p) { ok = false; break; }
        parts[slot] = { id: p.id, step: slot === keySlot ? 5 : 1 };
      }
      if (!ok || baseTierRange(reg, base).hi < t2 || baseTierRange(reg, base).lo > t2) continue;
      const raw = shopItem(base, tiers[t2]!.minItemLevel, tiers[t2]!.minItemLevel, 'normal', 5);
      if (raw.tier !== 't2') continue;
      for (const origin of ['shop', 'drop'] as const) {
        const it = shapeFoundWeapon(reg, { ...raw, origin, foundParts: parts });
        const grades = Object.keys(salvageRange(reg, it, false).range).map((id) => Number(id.split('-').pop()));
        expect(Math.max(...grades), `${base.id} ${origin}: сорт — рецепт t2`).toBe(Math.max(...recipe));
        expect(salvageWorth(reg, it), `${base.id} ${origin}`).toBeLessThanOrEqual(shopItemValue(reg, it));
        expect(shopBuyPrice(reg, it), `${base.id} ${origin}: пол покупки по сырью не нужен`).toBe(shopItemValue(reg, it));
      }
      // Петля целиком: купил → разобрал → продал сырьё — не в плюс.
      const it = shapeFoundWeapon(reg, { ...raw, foundParts: parts });
      const save = mkSave(shopBuyPrice(reg, it));
      expect(buyItem(reg, save, it).ok).toBe(true);
      expect(forgeSalvage(reg, save, emptyStash(reg), it.uid, MAX).ok).toBe(true);
      sellMaterials(save);
      expect(save.gold, base.id).toBeLessThanOrEqual(shopBuyPrice(reg, it));
      found++;
    }
    expect(found, 'сторож видит хоть одну такую базу').toBeGreaterThan(0);
  });
});

describe('⚠ R2-16: надбавка ступени — только в цене ПОКУПКИ, продажа находки её не видит', () => {
  /**
   * D21 положил надбавку в `shopItemValue`, чтобы мифик на прилавке не стоил восемь убийств. Та же оценка кормила и
   * ПРОДАЖУ (`0.4 × оценка`), и каждая находка, сданная в лавку, — обычное поведение игрока — приносила ×1.24 на
   * 20-м уровне и ×2.5 на 90-м: доход за убийство +53 % на глубине, против цели «золото дефицитно всю игру»
   * (docs/ECONOMY.md). Бот сима этого не видел: ненужное он разбирает, а не продаёт.
   */
  const pm = (r: Rarity): number => reg.get('rarities').find((x) => x.id === r)?.priceMult ?? 1;
  /** Продажа ДО D21: `0.4 × (15 + ilvl × 4 + аффиксы × 12) × редкость` — ступени не видит. */
  const flatSell = (it: Item): number => Math.max(1, Math.floor(Math.round((15 + it.itemLevel * 4 + it.affixes.length * 12) * pm(it.rarity)) * 0.4));
  const loot = reg.get('balance').loot;
  /** Находка с тела — как `GameSession.killMonster`: трофей по весам категорий, ступень — бросок в окне уровня. */
  function drop(level: number, rng: ReturnType<typeof createRng>): Item {
    const baseId = monsterTrophyBase(undefined, () => undefined, reg.get('items.base'), rng, loot.categoryWeights);
    const it = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: level, tierLevel: rollTierLevel(level, loot.tierWindow, rng), baseId,
      tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), categoryWeights: loot.categoryWeights,
      rareNames: reg.get('rare-names'), maxReqTotal: reg.get('balance').maxTotalRequirement, baseRoll: loot.baseRoll, origin: 'drop',
    }, rng));
    if (baseId && rng.chance(loot.brokenChance)) it.broken = true;
    return it;
  }

  it('⭐ выручка за находку на 20/50/90-м уровне — в полосе ±5 % прежней продажи (было ×1.24 / ×1.79 / ×2.49)', () => {
    for (const level of [20, 50, 90]) {
      const rng = createRng(level * 31 + 7);
      let sold = 0, flat = 0, tiered = 0;
      for (let i = 0; i < 2000; i++) {
        const it = drop(level, rng);
        if (it.tier) tiered++;
        sold += shopSellPrice(reg, it);
        flat += flatSell(it);
      }
      expect(tiered, `ур.${level}: сторож видит вещи со ступенью`).toBeGreaterThan(1500);
      expect(sold / flat, `ур.${level}`).toBeGreaterThanOrEqual(0.95);
      expect(sold / flat, `ур.${level}`).toBeLessThanOrEqual(1.05);
    }
  });

  /**
   * ⚠ R3-21: сторож выше сравнивает продажу с `flatSell` — а это та же формула строка в строку: отношение ровно 1, и он
   * ловит лишь вернувшуюся надбавку. Правка редкости, аффиксов, весов трофеев или самой формулы проходила бы мимо.
   * Здесь — БЮДЖЕТ ЧИСЛОМ: средняя выручка лавки за находку с тела на 20/50/90-м уровне (замер 26.09.2026: 62.5 / 125.4 /
   * 215.8 золота) + 10 %. Надбавка ступени в продаже (×1.24 уже на 20-м) его пробивает. Бюджет двигают ОСОЗНАННО —
   * вместе с docs/ECONOMY.md («золото дефицитно всю игру»), а не подгоняют под новую выручку.
   */
  it('⭐ R3-21: выручка лавки за находку — в бюджете числом (замер + 10 %), а не только «как прежняя формула»', () => {
    const BUDGET: Record<number, number> = { 20: 69, 50: 138, 90: 238 };
    for (const level of [20, 50, 90]) {
      const rng = createRng(level * 31 + 7);
      let sold = 0;
      for (let i = 0; i < 2000; i++) sold += shopSellPrice(reg, drop(level, rng));
      const mean = sold / 2000;
      expect(mean, `ур.${level}: золото за находку`).toBeLessThanOrEqual(BUDGET[level]!);
      expect(mean, `ур.${level}: бюджет не пустой — сторож не выродился`).toBeGreaterThan(BUDGET[level]! / 1.1 * 0.8);
    }
  });

  /**
   * ⚠ R6-23: бюджет выше мерит ОДИН путь золота с находки — сдать её в лавку. Второй — разобрать у кузнеца
   * (`forgeSalvage`: найденное оружие отдаёт сырьё своих деталей их ступеней, §10.9) и сдать стеки поштучно (`sellItem`,
   * 1 · 4 · 12 · 36 · 108). Цена сырья растёт ступенью ×3, цена вещи — уровнем линейно, и на глубине разбор обгоняет
   * продажу: оружие 90-го уровня — 224 золота продажей против 253 разбором. Игрок берёт лучшее из двух, и выручка за
   * находку (замер 26.09.2026) — 62.7 / 130.7 / 248.6 золота, ×1.15 к продаже на 90-м: бюджет R3-21 (238) этот путь
   * уже пробил, а сторож его не видел — как и любую правку `sellPrice` ступеней 4–5 или `balance.craft.salvage`.
   * Решение R6-23 — путь остаётся (R3-20, docs/CRAFT_WEAPONS.md §13: проданное сырьё уходит из ковки, это выбор на одну
   * вещь, а не петля — (в)…(в″) выше), но и у него БЮДЖЕТ ЧИСЛОМ: замер + 10 %. Двигают его так же — осознанно,
   * вместе с docs/ECONOMY.md.
   */
  const BEST_BUDGET: Record<number, number> = { 20: 69, 50: 144, 90: 274 };

  /**
   * Золото с находки двумя путями, НАСТОЯЩИМИ действиями: сдать её в лавку (`shopSellPrice`) — или разобрать у кузнеца
   * (`forgeSalvage`, выход в сумку) и сдать каждый стек сырья (`sellItem`). Находки — те же 2000, что у R3-21: броски
   * разбора (путь по правилу) катает свой кубик и ряд находок не сдвигают.
   */
  function findGold(r: ConfigRegistry, level: number): { sold: number; best: number; salvaged: number } {
    const rng = createRng(level * 31 + 7);
    const rolls = createRng(level * 31 + 8);
    let sold = 0, best = 0, salvaged = 0;
    for (let i = 0; i < 2000; i++) {
      const it = drop(level, rng);
      const direct = shopSellPrice(r, it);
      const save = mkSave(0, [{ ...it, pos: null }]);
      const stash = emptyStash(r);
      if (forgeSalvage(r, save, stash, it.uid, rolls).ok) {
        expect(stash.materials ?? {}, 'сумка пуста — весь выход в ней, мимо сундука ничего').toEqual({});
        for (const m of save.inventory.filter((x) => x.kind === 'material')) expect(sellItem(r, save, m.uid).ok).toBe(true);
        salvaged++;
      }
      sold += direct;
      best += Math.max(direct, save.gold);
    }
    return { sold: sold / 2000, best: best / 2000, salvaged };
  }

  it('⭐ R6-23 + D4: лучшее из «сдать находку / разобрать у кузнеца и сдать сырьё» — ВСЕГДА продажа; и в бюджете числом', () => {
    for (const level of [20, 50, 90]) {
      const { sold, best, salvaged } = findGold(reg, level);
      const tag = `ур.${level}: золото за находку лучшим путём (продажей — ${sold.toFixed(1)})`;
      // ⭐ D4 (решение владельца 06.10): разобрать и сдать сырьё не выгоднее, чем сдать саму вещь, — ни у одной находки.
      expect(best, `${tag}: разбор ни разу не обогнал продажу`).toBe(sold);
      expect(best, tag).toBeLessThanOrEqual(BEST_BUDGET[level]!);
      expect(best, `${tag}: бюджет не пустой — сторож не выродился`).toBeGreaterThan(BEST_BUDGET[level]! / 1.1 * 0.8);
      expect(salvaged, `ур.${level}: разбор идёт — сторож не выродился в R3-21`).toBeGreaterThan(1500);
    }
  });

  it('R6-23 + D4: у сторожа есть зубы — дорогое сырьё и лишние единицы разбора реестр не пускает, а мимо реестра их держит пол цены вещи', () => {
    const now = findGold(reg, 90);
    const dearMats = (m: ConfigShapes['craft-materials'][number]): ConfigShapes['craft-materials'][number] => (m.tier >= 4 ? { ...m, sellPrice: m.sellPrice * 3 } : m);
    // Реестр (файлы, оверрайды, редактор) не пускает: сырьё с вещи дороже самой вещи (`salvageSellIssues`).
    const strict = new ConfigRegistry();
    strict.loadAll();
    expect(() => strict.reload({ 'craft-materials': strict.get('craft-materials').map(dearMats) })).toThrow(/D4 разбор не выгоднее продажи/);
    expect(() => patched((b) => { for (const k of CRAFT_SLOT_LIST) b.craft.salvage.units[k] += 1; })).toThrow(/D4 разбор не выгоднее продажи/);
    // Мимо реестра (`cross: false` — как сборка с инцидентом): правило ядра — лавка платит за вещь не меньше её разбора.
    const dear = new ConfigRegistry();
    dear.loadAll();
    dear.reload({ 'craft-materials': dear.get('craft-materials').map(dearMats) }, { cross: false });
    const more = new ConfigRegistry();
    more.loadAll();
    const b = structuredClone(more.get('balance'));
    for (const k of CRAFT_SLOT_LIST) b.craft.salvage.units[k] += 1;
    more.reload({ balance: b }, { cross: false });
    for (const [label, r] of [['сырьё 4–5 ×3', dear], ['разбор +1 единица на деталь', more]] as const) {
      const g = findGold(r, 90);
      expect(g.best, `${label}: разбор не обгоняет продажу и тут — пол цены вещи`).toBe(g.sold);
      expect(g.sold, `${label}: пол цены поднял продажу — бюджет R3-21 это видит`).toBeGreaterThan(now.sold);
    }
  });

  it('покупка надбавку видит: мифик с прилавка стоит ×statMult, а сданный обратно — прежние 40 % без неё', () => {
    const base = weaponBases.find((b) => baseTierRange(reg, b).hi === tiers.length - 1)!;
    const myth = shopItem(base, 81, 80, 'normal', 3);
    expect(myth.tier).toBe(tiers[tiers.length - 1]!.id);
    expect(shopBuyPrice(reg, myth)).toBeGreaterThan(5 * 339);
    expect(shopSellPrice(reg, myth)).toBe(flatSell(myth));
    // Сырьё по-прежнему поштучно: к нему формула вещи не относится вовсе.
    const m = mats.find((x) => x.sellPrice > 1)!;
    expect(shopSellPrice(reg, materialItem(m, 5, 'm5'))).toBe(m.sellPrice * 5);
  });
});

describe('D21: инварианты «не прачечная» — настоящими действиями', () => {
  it('⭐ а) сковал → продал: выручка меньше золота ковки — у каждой базы, ступени и доводки; и после зачарования', () => {
    const finishes = reg.get('balance').craft.finish.length;
    let n = 0, enchanted = 0;
    for (const base of weaponBases) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t <= hi; t++) for (let f = 0; f < Math.max(1, finishes); f++) {
        const input = inputFor(base, t, f);
        if (!input) continue;
        const tag = `${base.id} ${tiers[t]!.id} доводка ${f}`;
        const cost = craftWeapon(reg, input).cost!;
        const save = mkSave(10_000_000);
        const stash = { ...emptyStash(reg), materials: fullWallet() };
        const r = craftAction(reg, save, stash, nonce(), input, createRng(n + 1), { fullJournal: true });
        expect(r.ok, `${tag}: ${r.reason}`).toBe(true);
        const item = save.inventory.find((i) => i.uid === r.uid)!;
        const gold0 = save.gold;
        expect(10_000_000 - gold0, tag).toBe(cost.gold);
        expect(sellItem(reg, save, item.uid).ok).toBe(true);
        expect(save.gold - gold0, tag).toBeLessThan(cost.gold);
        n++;
        if (f !== 0) continue;
        // Зачарование: и прибавка продажи от него, и вся цепочка — в минус.
        for (const rarity of ['magic', 'rare'] as const) {
          if (!enchantSlots(reg, item, rarity)?.fillable) continue;
          const en = enchantItem(reg, item, rarity, createRng(t * 7 + 1))!;
          const ec = enchantCost(reg, item, rarity);
          expect(shopSellPrice(reg, en) - shopSellPrice(reg, item), `${tag} → ${rarity}`).toBeLessThan(ec);
          expect(shopSellPrice(reg, en), `${tag} → ${rarity}`).toBeLessThan(cost.gold + ec);
          enchanted++;
        }
      }
    }
    expect(n).toBeGreaterThan(100);
    expect(enchanted).toBeGreaterThan(20);
  });

  it('⭐ б) переплавка: возврат меньше цены по КАЖДОМУ материалу, и «сковал → переплавил → продал» — убыток', () => {
    let n = 0;
    for (const base of weaponBases) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t <= hi; t++) {
        const input = inputFor(base, t, reg.get('balance').craft.finish.length - 1) ?? inputFor(base, t);
        if (!input) continue;
        const tag = `${base.id} ${tiers[t]!.id}`;
        const cost = craftWeapon(reg, input).cost!;
        const save = mkSave(10_000_000);
        const stash = { ...emptyStash(reg), materials: fullWallet() };
        const w0 = worth(stash.materials), g0 = save.gold;
        const r = craftAction(reg, save, stash, nonce(), input, createRng(t + 11), { fullJournal: true });
        expect(r.ok, `${tag}: ${r.reason}`).toBe(true);
        const item = save.inventory.find((i) => i.uid === r.uid)!;
        const melt = meltReturn(reg, item);
        for (const [id, k] of Object.entries(melt)) expect(k, `${tag}: ${id}`).toBeLessThan(cost.materials[id] ?? 0);
        expect(forgeSalvage(reg, save, stash, item.uid, MAX).ok).toBe(true);
        sellMaterials(save);
        const net = (save.gold - g0) + (worth(stash.materials) - w0);
        expect(net, tag).toBeLessThan(0);
        n++;
      }
    }
    expect(n).toBeGreaterThan(40);
  });

  it('⭐ в) купил в лавке → разобрал → продал сырьё: не больше, чем заплачено (любая база, ступень, редкость)', () => {
    const bases = reg.get('items.base').filter((b) => b.kind !== 'consumable');   // лавка катает и выключенные
    let n = 0;
    for (const base of bases) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t <= hi; t++) {
        const tier = tiers[t]!;
        for (const rarity of ['normal', 'magic', 'rare'] as const) {
          for (const ilvl of [Math.max(1, tier.minItemLevel - over), tier.minItemLevel + 20]) {
            const it = shopItem(base, ilvl, tier.minItemLevel, rarity, ilvl + t);
            if (it.rarity === 'unique') continue;
            const price = shopBuyPrice(reg, it);
            const save = mkSave(price);
            expect(buyItem(reg, save, it).ok).toBe(true);
            expect(save.gold).toBe(0);
            const stash = emptyStash(reg);
            if (!forgeSalvage(reg, save, stash, it.uid, MAX).ok) continue;
            sellMaterials(save);
            const net = save.gold + worth(stash.materials ?? {}) - price;
            expect(net, `${base.id} ${tier.id} ${rarity} ур.${ilvl}`).toBeLessThanOrEqual(0);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(300);
  });

  it('⭐ в′) купил → поднял у кузнеца до потолка → разобрал → продал: тоже не в плюс (подъём — не насос сырья)', () => {
    let n = 0;
    for (const base of weaponBases.concat(reg.get('items.base').filter((b) => b.kind === 'armor') as never[])) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t < hi; t++) {
        const tier = tiers[t]!;
        const it = shopItem(base, tier.minItemLevel, tier.minItemLevel, 'normal', 17 + t);
        const price = shopBuyPrice(reg, it);
        const save = mkSave(price);
        expect(buyItem(reg, save, it).ok).toBe(true);
        const wallet = fullWallet();
        const stash = { ...emptyStash(reg), materials: wallet };
        const w0 = worth(wallet);
        save.gold = 100_000_000;
        let ups = 0;
        while (forgeUpgrade(reg, save, it.uid, wallet).ok) ups++;
        const spent = 100_000_000 - save.gold;
        save.gold = 0;
        if (!ups || !forgeSalvage(reg, save, stash, it.uid, MAX).ok) continue;
        sellMaterials(save);
        const net = save.gold + (worth(wallet) - w0) - price - spent;
        expect(net, `${base.id} ${tier.id} +${ups}`).toBeLessThanOrEqual(0);
        n++;
      }
    }
    expect(n).toBeGreaterThan(50);
  });

  it('⭐ в″) R3-21: КАЖДЫЙ шаг подъёма НАЙДЕННОЙ вещи любой редкости — не в плюс: прибавка max(разбор, продажа) меньше цены шага', () => {
    const { n, bad } = profitableUpgradeSteps(reg);
    expect(bad, bad.slice(0, 12).join('\n')).toEqual([]);
    expect(n, 'сторож не выродился: шагов тысячи').toBeGreaterThan(5000);
  });

  it('⭐ в″) у сторожа есть зубы: подъём почти даром — в плюс ТОЛЬКО без `bornTier`; с ним подъём — чистый расход при любом конфиге', () => {
    // Подъём почти даром (золото 1, основа ×0 и расходник 1 — §7), сырьё дорогое: разбор вещи после шага — по ИСХОДНОЙ ступени (`bornTier`, §11.2),
    // поэтому шаг не прибавляет ни разбора, ни продажи — в плюс он не бывает, какие бы цены ни стояли в конфиге.
    // Сырьё вдесятеро дороже (мимо реестра, `cross: false`): разбор дороже вещи, цену держит пол — и шаг меняет пол, если разбор по нынешней.
    const cheap = new ConfigRegistry();
    cheap.loadAll();
    const cb = structuredClone(cheap.get('balance'));
    cb.forgePrices.upgradeTier = 1;
    cb.forgePrices.upgradeMaterials = { baseShare: 0, consumable: 1 };
    cheap.reload({ balance: cb, 'craft-materials': cheap.get('craft-materials').map((m) => ({ ...m, sellPrice: m.sellPrice * 10 })) }, { cross: false });
    const held = profitableUpgradeSteps(cheap, { rarities: ['normal', 'rare'], kinds: ['weapon', 'armor'] });
    expect(held.n, 'сторож видит шаги').toBeGreaterThan(20);
    expect(held.bad, held.bad.slice(0, 5).join('\n')).toEqual([]);
    // Без `bornTier` (разбор по нынешней ступени) тот же конфиг даёт шаг в плюс — сторож его видит.
    const lost = profitableUpgradeSteps(cheap, { rarities: ['normal', 'rare'], kinds: ['weapon', 'armor'], forgetBorn: true });
    expect(lost.bad.length, 'без исходной ступени дешёвый подъём находки — в плюс').toBeGreaterThan(0);
  });

  it('⭐ г) подъём ступени → продажа: прибавка меньше цены подъёма на ЛЮБОМ уровне вещи (надбавка не множит уровень)', () => {
    const bases = reg.get('items.base').filter((b) => b.kind === 'weapon' || b.kind === 'armor' || b.kind === 'shield');
    let n = 0;
    for (const base of bases) {
      const { lo, hi } = baseTierRange(reg, base);
      for (let t = lo; t < hi; t++) for (const rarity of ['normal', 'magic', 'rare'] as const) for (const ilvl of [tiers[t]!.minItemLevel, 200, 1000, 5000]) {
        const it = shopItem(base, ilvl, tiers[t]!.minItemLevel, rarity, t + ilvl);
        if (it.rarity === 'unique' || it.tier !== tiers[t]!.id) continue;
        const save = mkSave(100_000_000, [{ ...it, pos: null }]);
        const wallet = fullWallet(), w0 = worth(wallet);
        const before = shopSellPrice(reg, it);
        if (!forgeUpgrade(reg, save, it.uid, wallet).ok) continue;
        const after = shopSellPrice(reg, save.inventory.find((i) => i.uid === it.uid)!);
        const paid = (100_000_000 - save.gold) + (w0 - worth(wallet));
        expect(after - before, `${base.id} ${tiers[t]!.id}→ ${rarity} ур.${ilvl}`).toBeLessThan(paid);
        n++;
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it('детали скованной вещи, выключенные после ковки, не ломают цену (цена считается, переплавка идёт)', () => {
    const base = weaponBases.find((b) => inputFor(b, 2))!;
    const it = craftWeapon(reg, inputFor(base, 2)!, { rng: createRng(1) }).item!;
    expect(partById(reg, it.parts!.strike.id)).toBeTruthy();
    const ghost = { ...it, parts: { ...it.parts!, grip: { id: 'удалённая-деталь', step: 2 } } };
    expect(Number.isFinite(shopSellPrice(reg, ghost))).toBe(true);
    expect(Number.isFinite(shopBuyPrice(reg, ghost))).toBe(true);
    expect(salvageWorth(reg, ghost)).toBeGreaterThan(0);
  });
});

describe('⚠ R1-20: вилка разбора «от и до» — ровно крайние НАСТОЯЩИЕ броски', () => {
  /** Настоящий бросок N раз: для каждого материала — сколько выпало меньше всего и больше всего (не выпал — 0). */
  function observed(it: Item, inField: boolean, rolls: number, seed: number): Record<string, { min: number; max: number }> {
    const rng = createRng(seed);
    const all: Record<string, number>[] = [];
    for (let i = 0; i < rolls; i++) all.push(salvageYield(reg, it, rng, inField).gains);
    const ids = new Set(all.flatMap((g) => Object.keys(g)));
    const out: Record<string, { min: number; max: number }> = {};
    for (const id of ids) {
      const ns = all.map((g) => g[id] ?? 0);
      out[id] = { min: Math.min(...ns), max: Math.max(...ns) };
    }
    return out;
  }
  /** Разбираемые вещи: каждая включённая база × редкость (найденные), плюс скованные — у них переплавка. */
  function samples(): { it: Item; label: string }[] {
    const out: { it: Item; label: string }[] = [];
    const bases = reg.get('items.base').filter((b) => b.kind !== 'consumable' && b.enabled !== false);
    for (const base of bases) {
      for (const rarity of ['normal', 'magic', 'rare'] as const) {
        const { lo } = baseTierRange(reg, base);
        const it = shopItem(base, tiers[lo]!.minItemLevel + 5, tiers[lo]!.minItemLevel, rarity, 31);
        if (it.rarity !== 'unique') out.push({ it, label: `${base.id} ${rarity}` });
      }
    }
    for (const base of weaponBases) {
      const input = inputFor(base, baseTierRange(reg, base).lo);
      const pv = input ? craftWeapon(reg, input, { rng: createRng(5) }) : null;
      if (pv?.ok && pv.item) out.push({ it: pv.item, label: `${base.id} скованный` });
    }
    return out;
  }

  it('⭐ у кузнеца и в поле: верх и низ вилки совпадают с тем, что реально выпадает; пол цены = цена этого верха', () => {
    let n = 0, checked = 0;
    const bad: string[] = [];
    for (const { it, label } of samples()) {
      for (const inField of [false, true]) {
        const est = salvageRange(reg, it, inField);
        if (!est.ok) continue;
        // Путь по деталям у кузнеца бросков не знает вовсе; доли и правило по редкости — катаются.
        const rolls = salvageYield(reg, it, createRng(1), inField).source === 'rules' || inField ? 2500 : 1;
        const real = observed(it, inField, rolls, 7 + n++);
        for (const id of new Set([...Object.keys(est.range), ...Object.keys(real)])) {
          const e = est.range[id] ?? { min: 0, max: 0 };
          const r = real[id] ?? { min: 0, max: 0 };
          if (e.min !== r.min || e.max !== r.max) bad.push(`${label} ${inField ? 'поле' : 'кузница'} ${id}: вилка ${e.min}–${e.max}, выпадает ${r.min}–${r.max}`);
        }
        if (!inField) {
          const hi = Object.fromEntries(Object.entries(real).map(([id, r]) => [id, r.max]));
          if (salvageWorth(reg, it) !== Math.ceil(worth(hi))) bad.push(`${label}: пол цены ${salvageWorth(reg, it)}, верх разбора стоит ${Math.ceil(worth(hi))}`);
        }
        checked++;
      }
    }
    expect(bad, bad.slice(0, 12).join('\n')).toEqual([]);
    expect(checked, 'сторож видит и находки, и скованное, и оба места').toBeGreaterThan(150);
  });
});

describe('⚠ R23-04: лавка не скупает дороже, чем продаёт, — и при множителе цены редкости у нуля', () => {
  /**
   * Схема пускает `rarities.priceMult` от 0 («обычное ничего не стоит»). Оценка вещи — `round(… × priceMult)`, и ниже ≈ 0.026 зелье
   * прилавка (обычное, ilvl 1: `(15 + 4) × priceMult`) стоило 0, а скупка держит пол 1 (`shopSellPrice`): герой с нулём золота
   * раскупал 20 колб, сдавал по 1 — и так на каждый заход в город (прилавок зелий заново). Кузница пол 1 держит (`forgeGold`), лавка — нет.
   * Поставку (normal = 1) это не задевает — только правку из редактора; мерим при 0 / 0.01 / 0.02 у каждой редкости по очереди.
   */
  function cheapRarity(id: Rarity, mult: number): ConfigRegistry {
    const r = new ConfigRegistry();
    r.loadAll();
    r.reload({ rarities: r.get('rarities').map((x) => (x.id === id ? { ...x, priceMult: mult } : x)) });
    return r;
  }
  const KINDS = ['weapon', 'armor', 'shield', 'jewelry'] as const;

  it('зелья прилавка и снаряжение каждой редкости: покупка ≥ скупки (и ≥ 1), «купил → продал» не в плюс', () => {
    const bad: string[] = [];
    let n = 0;
    for (const rarity of ['normal', 'magic', 'rare', 'unique'] as const) for (const mult of [0, 0.01, 0.02]) {
      const R = cheapRarity(rarity, mult);
      const items: Item[] = [];
      if (rarity === 'normal') for (const id of shopConsumableIds(R)) items.push(itemFromBaseId(R.get('items.base'), id, undefined, 'shop')!);
      for (const kind of KINDS) for (const base of R.get('items.base').filter((b) => b.kind === kind && b.enabled !== false).slice(0, 3)) {
        for (const lvl of [1, 12]) {
          const it = shopItem(base, lvl, lvl, rarity, 17 + lvl, R);
          if (it.rarity === rarity) items.push(it);
        }
      }
      for (const it of items) {
        const label = `${rarity}×${mult} «${it.baseId}» ilvl ${it.itemLevel}`;
        const buy = shopBuyPrice(R, it), sell = shopSellPrice(R, it);
        if (!(buy >= 1)) bad.push(`${label}: цена покупки ${buy}`);
        if (buy < sell) bad.push(`${label}: покупка ${buy} < скупки ${sell}`);
        // Петля настоящими действиями: ровно столько золота, сколько просят, — купил и сдал.
        const save = mkSave(buy);
        if (buyItem(R, save, it).ok && sellItem(R, save, it.uid).ok && save.gold > buy) bad.push(`${label}: купил за ${buy} → сдал, стало ${save.gold}`);
        // Героем без гроша вещь не купить (согласие «до 0» — тоже нет).
        if (buyItem(R, mkSave(0), { ...it, uid: `${it.uid}-0` }, 0).ok) bad.push(`${label}: куплена за 0 золота`);
        n++;
      }
    }
    expect(bad, bad.slice(0, 12).join('\n')).toEqual([]);
    expect(n, 'сторож видит и зелья, и снаряжение каждой редкости').toBeGreaterThan(150);
  });

  it('поставка не сдвинулась: пол скупки не трогает ни одну цену прилавка (оценка и сырьё разбора и так выше)', () => {
    for (const id of shopConsumableIds(reg)) {
      const p = itemFromBaseId(reg.get('items.base'), id, undefined, 'shop')!;
      expect(shopBuyPrice(reg, p), id).toBe(Math.max(shopItemValue(reg, p), salvageWorth(reg, p)));
    }
    for (const kind of KINDS) for (const base of reg.get('items.base').filter((b) => b.kind === kind && b.enabled !== false)) {
      for (const rarity of ['normal', 'magic', 'rare'] as const) {
        const it = shopItem(base, 20, 20, rarity, 41);
        expect(shopBuyPrice(reg, it), `${base.id} ${rarity}`).toBe(Math.max(shopItemValue(reg, it), salvageWorth(reg, it)));
      }
    }
  });
});
