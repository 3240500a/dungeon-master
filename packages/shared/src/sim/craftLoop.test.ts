import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng, type Rng } from '../formulas/rng.js';
import {
  CRAFT_NONCE_RE, craftWeapon, enchantSlots, enchantCost, fullJournal, keyVariantsByBase, normalizeJournal, shapeFoundWeapon,
  variantsFor, type CraftInput,
} from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, keySlotOf } from '../formulas/craftType.js';
import {
  craftAction, enchantAction, fieldSalvage, forgeGold, forgeSalvage, rerollMaterials, sellItem, shopSellPrice,
} from '../economy/townActions.js';
import { meetsRequirements } from '../formulas/stats.js';
import { availableMaterials, depositCarried, materialItem, type MaterialCost } from '../economy/materials.js';
import { emptyStash } from '../economy/stashActions.js';
import { addToInventory } from '../inventory/grid.js';
import { generateItem } from '../formulas/itemgen.js';
import { newBotSave, levelUpBotTo } from './playerBot.js';
import {
  bestCraft, carryPriority, considerDrop, forgeSalvageGain, rerollGain, visitForge, visitShop, scoreItem, type FieldCarry, type ForgeResult,
} from './economy.js';
import { DEFAULT_BUILD } from './types.js';
import { runSessionSim } from '../session/runner.js';
import type { AccountStash } from '../types/stash.js';
import type { Item, CraftParts } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import { ESSENCE_ID } from '../formulas/salvage.js';
/** §6.2: зачарование и перекатка тратят эссенцию — кошелёк сундука с запасом (тесту важно не это). */
const essWallet = (): Record<string, number> => ({ [ESSENCE_ID]: 1_000_000 });

/**
 * K7 — СИМ И БОТ КОВКИ. Главный сторож: «сковал → переплавил» и «сковал → продал» (в том числе через
 * зачарование) не растят НИ золото, НИ одно сырьё — ни на одной из тысячи петель, собранных случайно из
 * всего конфига. Все шаги — авторитетные действия игры (`craftAction`, `enchantAction`, `forgeSalvage`,
 * `fieldSalvage`, `sellItem`), а не их копии: иначе сторож проверял бы свою арифметику, а не игру.
 * Ниже — бот: куёт лучшее доступное по правилам ядра, не продаёт скованное, несёт найденное кузнецу.
 */

const reg = new ConfigRegistry();
reg.loadAll();
const mats = reg.get('craft-materials');
const priceOf = new Map(mats.map((m) => [m.id, m.sellPrice]));
const worth = (w: MaterialCost): number => Object.entries(w).reduce((s, [id, n]) => s + n * (priceOf.get(id) ?? 0), 0);

/** Сундук с горой каждого включённого сырья: петлю ограничивает только правило, а не кошелёк. */
function richStash(n = 1_000_000): AccountStash {
  const st = emptyStash(reg);
  st.materials = Object.fromEntries(mats.filter((m) => m.enabled !== false).map((m) => [m.id, n]));
  return st;
}

/** Случайная заявка по конфигу: семейство, четыре детали, ступени в окнах форм, доводка. Может не пройти правила. */
function randomInput(rng: Rng): CraftInput | null {
  const types = reg.get('weapon-types').filter((t) => t.bases.length);
  const t = rng.pick(types);
  const fam = rng.pick(t.bases);
  const hands = fam.hands;
  const keySlot = keySlotOf(reg, t.id);
  const group = keyVariantsByBase(reg, t.id, hands).find((g) => g.baseId === fam.base);
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group?.variants ?? [] : variantsFor(reg, t.id, slot, hands);
    if (!pool.length) return null;
    const p = rng.pick(pool);
    parts[slot] = { id: p.id, step: rng.int(p.stepMin, p.stepMax) };
  }
  return { weaponClass: t.id, hands, parts, finish: rng.int(0, reg.get('balance').craft.finish.length - 1) };
}

const bagIsClean = (save: SaveState): boolean => save.inventory.every((i) => i.kind === 'material');

describe('K7: ковка не прачечная — 1000 петель действиями игры', () => {
  it('⭐ «сковал → переплавил / продал / зачаровал и продал / зачаровал и переплавил»: ни золото, ни одно сырьё не растут ни на одной петле', () => {
    const save = newBotSave(reg, 'warrior');
    save.inventory = [];
    save.gold = 1e12;
    const stash = richStash();
    const wallet = stash.materials!;
    const rng = createRng(20260926);
    const journal0 = normalizeJournal(stash.forgeJournal);
    const paths = ['melt', 'field', 'sell', 'enchant-sell', 'enchant-melt'] as const;
    const done: Record<(typeof paths)[number], number> = { melt: 0, field: 0, sell: 0, 'enchant-sell': 0, 'enchant-melt': 0 };
    let loops = 0, tries = 0;
    while (loops < 1000) {
      expect(++tries, 'конфиг даёт достаточно сковываемых заявок').toBeLessThan(40_000);
      const input = randomInput(rng);
      if (!input) continue;
      const gold0 = save.gold;
      const have0 = availableMaterials(save.inventory, wallet);
      const nonce = `loop-${tries.toString().padStart(6, '0')}`;
      expect(nonce).toMatch(CRAFT_NONCE_RE);
      const made = craftAction(reg, save, stash, nonce, input, rng, { fullJournal: true });
      if (!made.ok) continue;   // окно ступеней базы, окно формы — правило, а не ошибка
      loops++;
      const item = save.inventory.find((i) => i.uid === made.uid)!;
      expect(item.parts, 'скованная вещь несёт детали').toBeDefined();
      expect(item.origin).toBe('craft');
      const path = paths[loops % paths.length]!;
      let uid = item.uid;
      if (path === 'enchant-sell' || path === 'enchant-melt') {
        const r = (['rare', 'magic'] as const).find((x) => enchantSlots(reg, item, x)?.fillable && enchantCost(reg, item, x) > 0);
        if (r) {
          const e = enchantAction(reg, save, uid, r, rng, undefined, essWallet());
          expect(e.ok, e.reason).toBe(true);
          uid = e.uid!;
        }
      }
      const it = save.inventory.find((i) => i.uid === uid)!;
      if (path === 'sell' || path === 'enchant-sell') {
        const price = shopSellPrice(reg, it);
        expect(sellItem(reg, save, uid).ok).toBe(true);
        expect(price, 'цена продажи скованного — число').toBeGreaterThan(0);
      } else if (path === 'field') {
        // Полевая доля катается: пустой бросок — вещь цела, тогда переплавка у кузнеца.
        if (!fieldSalvage(reg, save, uid, rng).ok) expect(forgeSalvage(reg, save, stash, uid, rng).ok).toBe(true);
      } else {
        const m = forgeSalvage(reg, save, stash, uid, rng);
        expect(m.ok, m.reason).toBe(true);
        expect((m.unlocked ?? []).filter((x) => !/^(Тип|Деталь) «/.test(x)), 'переплавка пишет в каталог только тип и детали').toEqual([]);
      }
      depositCarried(save.inventory, wallet);
      done[path]++;

      expect(bagIsClean(save), `${path}: вещь не осталась в сумке`).toBe(true);
      expect(save.gold, `${path}: золото не выросло (${input.weaponClass})`).toBeLessThan(gold0);
      const have1 = availableMaterials(save.inventory, wallet);
      for (const id of new Set([...Object.keys(have0), ...Object.keys(have1)])) {
        expect(have1[id] ?? 0, `${path}: сырьё ${id} не выросло`).toBeLessThanOrEqual(have0[id] ?? 0);
      }
      expect(save.gold + worth(have1), `${path}: ценность (золото + сырьё по sellPrice) только падает`).toBeLessThan(gold0 + worth(have0));
    }
    for (const p of paths) expect(done[p], `путь ${p} пройден`).toBeGreaterThan(100);
    // Журнал: переплавка пишет в каталог тип и детали скованного (D1: любая разобранная у кузнеца вещь), продажа — ничего; кодекс
    // «видел», потолок, жалость и мифики не растут — растёт только кодекс «сковал».
    const j = normalizeJournal(stash.forgeJournal);
    expect({ ...j, typesForged: [], bases: [], variants: [] }).toEqual({ ...journal0, typesForged: [], bases: [], variants: [] });
  });
});

describe('K7: бот у кузницы — ковка авторитетными действиями', () => {
  /** Воин 20-го уровня с золотом; журнал — флаг разработчика, сырья — гора. */
  function hero(gold = 200_000): SaveState {
    const save = newBotSave(reg, 'warrior');
    levelUpBotTo(reg, save, 20, DEFAULT_BUILD, createRng(3));
    save.gold = gold;
    return save;
  }
  const nonces = (): (() => string) => { let n = 0; return () => `bot-test-${++n}`; };

  it('⭐ куёт лучшее доступное, надевает, снятое — на верстак (журнал); золото и сырьё — ровно по цене', () => {
    const save = hero();
    const stash = richStash(500);
    const old = save.equipment.weapon!;
    const plan = bestCraft(reg, save, stash, DEFAULT_BUILD, { fullJournal: true })!;
    expect(plan, 'план есть: журнал открыт, сырья и золота хватает').toBeTruthy();
    expect(plan.score).toBeGreaterThan(scoreItem(reg, save, old, DEFAULT_BUILD));
    const gold0 = save.gold;
    const have0 = availableMaterials(save.inventory, stash.materials!);
    const out = visitForge(reg, save, DEFAULT_BUILD, stash, { craft: true, rng: createRng(5), nonce: nonces(), fullJournal: true });
    expect(out.crafted).toBe(1);
    const w = save.equipment.weapon!;
    expect(w.parts, 'в руке скованное').toEqual(plan.input.parts);
    expect(w.origin).toBe('craft');
    expect(out.goldCraft, 'золото ковки — по цене плана').toBe(plan.cost.gold);
    expect(out.matsOutCraft).toBe(Object.values(plan.cost.materials).reduce((a, b) => a + b, 0));
    expect(save.gold, 'сальдо золота сходится').toBe(gold0 - out.goldCraft - out.goldEnchant - out.spent + out.sold);
    // Снятое стартовое кузнец разбирает ТОЛЬКО В КАТАЛОГ (R3-04 + D1: комплект бесплатен и бесконечен — сырья с него нет).
    expect(old.origin).toBe('start');
    expect(out.salvaged, 'стартовое — в каталог').toBe(1);
    expect(out.matsIn, 'сырья стартовое не даёт').toBe(0);
    expect(out.sold).toBe(0);
    expect(normalizeJournal(stash.forgeJournal).bases, 'тип стартового — в каталоге').toContain(old.baseId);
    const have1 = availableMaterials(save.inventory, stash.materials!);
    const spent = Object.values(have0).reduce((a, b) => a + b, 0) - Object.values(have1).reduce((a, b) => a + b, 0);
    expect(spent, 'сырьё: списано на ковку и чары (эссенция) минус пришло разбором/переплавкой').toBe(out.matsOutCraft + out.matsOutForge + out.matsOutEnchant + out.matsOutReroll - out.matsIn - out.matsMelt);
    expect(save.inventory.filter((i) => i.kind !== 'material'), 'в сумке не осталось вещей').toEqual([]);
    expect(stash.craftNonces!.length, 'ключ записан').toBe(1);

    // Второй визит: своё скованное ради броска не перековывает — только на ступень выше.
    const again = visitForge(reg, save, DEFAULT_BUILD, stash, { craft: true, rng: createRng(6), nonce: nonces(), fullJournal: true });
    expect(again.crafted).toBe(0);
    expect(save.equipment.weapon!.uid).toBe(w.uid);
  });

  it('повтор ключа заявки ядро отвечает прежним uid — бот не считает это ковкой и ничего не надевает', () => {
    const stash = richStash(500);
    const same = (): string => 'bot-same-nonce';
    const a = hero();
    expect(visitForge(reg, a, DEFAULT_BUILD, stash, { craft: true, rng: createRng(1), nonce: same, fullJournal: true }).crafted).toBe(1);
    const b = hero();
    const w0 = b.equipment.weapon!, gold0 = b.gold;
    const out = visitForge(reg, b, DEFAULT_BUILD, stash, { craft: true, rng: createRng(2), nonce: same, fullJournal: true });
    expect(out.crafted).toBe(0);
    expect(out.goldCraft).toBe(0);
    expect(b.equipment.weapon!.uid, 'в руке прежнее').toBe(w0.uid);
    expect(b.gold).toBe(gold0 - out.spent - out.goldEnchant + out.sold);
  });

  it('зачаровывает скованное, когда золото сверх запаса; бедным — нет', () => {
    const rich = hero(10_000_000);
    const stash = richStash(500);
    const out = visitForge(reg, rich, DEFAULT_BUILD, stash, { craft: true, rng: createRng(7), nonce: nonces(), fullJournal: true });
    expect(out.crafted).toBe(1);
    expect(out.enchanted, 'богатый зачаровал').toBe(1);
    expect(rich.equipment.weapon!.rarity).not.toBe('normal');
    expect(out.goldEnchant).toBeGreaterThan(0);

    const plan = bestCraft(reg, hero(), richStash(500), DEFAULT_BUILD, { fullJournal: true })!;
    const poor = hero(plan.cost.gold);   // ровно на ковку — на зачарование и запас уже нет
    const o2 = visitForge(reg, poor, DEFAULT_BUILD, richStash(500), { craft: true, rng: createRng(7), nonce: nonces(), fullJournal: true });
    expect(o2.crafted).toBe(1);
    expect(o2.enchanted).toBe(0);
    expect(poor.gold, 'в кармане — только выручка за снятое стартовое (R3-04: за 1)').toBe(o2.sold);
    expect(o2.sold).toBeLessThanOrEqual(1);
  });

  it('ковка закрыта — кузница не куёт и не разбирает принесённое; журнал пуст — ковать нечего', () => {
    const save = hero();
    const found = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { dropBias: 1, itemLevel: 10, baseId: 'long-sword', tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'normal', origin: 'drop' }, createRng(9)));
    expect(addToInventory(save.inventory, found, reg.get('balance').inventory)).toBe(true);
    const off = visitForge(reg, save, DEFAULT_BUILD, richStash(500), { craft: false, rng: createRng(1) });
    expect(off.crafted + off.salvaged + off.melted).toBe(0);
    expect(save.inventory.some((i) => i.uid === found.uid), 'без ковки у кузнеца ничего не разобрано').toBe(true);

    const s2 = hero();
    const o2 = visitForge(reg, s2, DEFAULT_BUILD, richStash(500), { craft: true, rng: createRng(1), nonce: nonces() });
    expect(o2.crafted, 'журнал пуст — ни одна база не открыта').toBe(0);
  });

  it('⭐ бот НЕ продаёт скованное: магазин кладёт снятое в сумку, кузница переплавляет', () => {
    const save = hero(10_000_000);
    const stash = richStash(500);
    visitForge(reg, save, DEFAULT_BUILD, stash, { craft: true, rng: createRng(11), nonce: nonces(), fullJournal: true });
    const crafted = save.equipment.weapon!;
    expect(crafted.parts).toBeDefined();
    // Магазин на глубине, где любая вещь сильнее: снятое скованное — в сумку, не в золото.
    save.level = 80;
    save.attributes = { strength: 900, dexterity: 900, intelligence: 900, vitality: 900 };
    let replaced = false;
    for (let i = 0; i < 40 && !replaced; i++) {
      const gold0 = save.gold;
      const r = visitShop(reg, save, 80, createRng(100 + i), DEFAULT_BUILD);
      if (save.equipment.weapon?.uid !== crafted.uid) {
        replaced = true;
        expect(save.inventory.some((it) => it.uid === crafted.uid), 'скованное лежит в сумке').toBe(true);
        expect(save.gold, 'за скованное не выручено ни монеты').toBe(gold0 - r.spent + r.sold);
        const soldCrafted = r.bought.every((b) => b.uid !== crafted.uid);
        expect(soldCrafted).toBe(true);
      }
    }
    expect(replaced, 'магазин нашёл замену').toBe(true);
    const out = visitForge(reg, save, DEFAULT_BUILD, stash, { craft: true, rng: createRng(12), nonce: nonces(), fullJournal: true });
    expect(out.melted, 'кузница переплавила снятое скованное').toBeGreaterThanOrEqual(1);
    expect(save.inventory.some((it) => it.uid === crafted.uid)).toBe(false);
  });
});

describe('K7: бот в поле — ноша к кузнецу и разбор без двойного выхода', () => {
  const base = { dropBias: 1, itemLevel: 10, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'normal' as const, origin: 'drop' as const };
  const drop = (baseId: string, seed: number): Item =>
    shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), { ...base, baseId }, createRng(seed)));
  /** Мифический редкий двуручник: в руке у героя — сильнее любой находки десятого уровня. */
  const mythic = (baseId: string, seed: number): Item =>
    shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { ...base, baseId, itemLevel: 90, tierLevel: 90, forceRarity: 'rare' }, createRng(seed)));
  /** Герой с запасом атрибутов и мификом в руке — находки заведомо хуже надетого. */
  function armed(): SaveState {
    const save = newBotSave(reg, 'warrior');
    save.attributes = { strength: 900, dexterity: 900, intelligence: 900, vitality: 900 };
    save.equipment.weapon = mythic('executioner-axe', 1);
    return save;
  }

  it('⭐ разобранное на месте НЕ продаётся ещё раз (раньше сим мерил не тот кошелёк и брал двойной выход)', () => {
    const save = armed();
    const junk = drop('hand-axe', 2);
    expect(scoreItem(reg, save, junk, DEFAULT_BUILD)).toBeLessThan(scoreItem(reg, save, save.equipment.weapon!, DEFAULT_BUILD));
    const gold0 = save.gold;
    const r = considerDrop(reg, save, junk, DEFAULT_BUILD);
    expect(r.equipped).toBe(false);
    expect(r.salvaged, 'сырьё вышло').toBeGreaterThan(0);
    expect(r.sold, 'и за ту же вещь НЕ взято золото').toBe(0);
    expect(save.gold).toBe(gold0);
  });

  it('ковка открыта: найденное с неоткрытым несём кузнецу (журнал), повтор уже взятого — только в пределах бюджета', () => {
    const save = armed();
    const carry: FieldCarry = { journal: normalizeJournal(undefined), carryCells: 15 };
    const first = drop('long-sword', 3);
    expect(considerDrop(reg, save, first, DEFAULT_BUILD, carry).kept, 'новая база — несём').toBe(true);
    expect(carry.journal.bases).toContain('long-sword');
    const cells = carry.carryCells;
    const twin = { ...first, uid: 'twin-uid' };
    const r = considerDrop(reg, save, twin, DEFAULT_BUILD, carry);
    // Близнец ничего не откроет: берём, только пока бюджет выше запаса под открытия, иначе — разбор на месте.
    if (r.kept) expect(carry.carryCells).toBe(cells - twin.gridW * twin.gridH);
    else expect(r.salvaged).toBeGreaterThan(0);
    // Бюджет кончился — новое тоже разбирается на месте, ничего не теряется и не продаётся.
    const tight: FieldCarry = { journal: normalizeJournal(undefined), carryCells: 1 };
    const r2 = considerDrop(reg, save, drop('mace', 4), DEFAULT_BUILD, tight);
    expect(r2.kept).toBeFalsy();
    expect(r2.sold).toBe(0);
  });

  it('скованное из сумки (сейв из игры) — переплавка на месте или ноша к кузнецу, но не золото — даже не по силам', () => {
    const save = armed();
    save.attributes = { strength: 1, dexterity: 1, intelligence: 1, vitality: 1 };   // не по силам: раньше это шло в продажу
    const pv = craftWeapon(reg, { weaponClass: 'axe', hands: 1, parts: defaultAxe() }, { rng: createRng(2) });
    const gold0 = save.gold;
    const r = considerDrop(reg, save, pv.item!, DEFAULT_BUILD);
    expect(r.sold).toBe(0);
    expect(r.melted === 1 || r.kept === true, JSON.stringify(r)).toBe(true);
    expect(save.gold).toBe(gold0);
    // Кузница переплавляет принесённое скованное и при закрытой ковке (разбор от флага не зависит).
    const bag = newBotSave(reg, 'warrior');
    const pv2 = craftWeapon(reg, { weaponClass: 'axe', hands: 1, parts: defaultAxe() }, { rng: createRng(3) });
    addToInventory(bag.inventory, pv2.item!, reg.get('balance').inventory);
    const out = visitForge(reg, bag, DEFAULT_BUILD, emptyStash(reg), { craft: false, rng: createRng(1) });
    expect(out.melted).toBe(1);
    expect(out.sold).toBe(0);
  });

  it('снятое ради находки скованное — переплавка на месте, не продажа', () => {
    const save = armed();
    const pv = craftWeapon(reg, { weaponClass: 'axe', hands: 1, parts: defaultAxe() }, { rng: createRng(1) });
    expect(pv.ok, pv.reason).toBe(true);
    save.equipment.weapon = pv.item!;
    const better = mythic('battle-axe', 7);
    expect(scoreItem(reg, save, better, DEFAULT_BUILD)).toBeGreaterThan(scoreItem(reg, save, pv.item!, DEFAULT_BUILD));
    const gold0 = save.gold;
    const r = considerDrop(reg, save, better, DEFAULT_BUILD);
    expect(r.equipped).toBe(true);
    expect(r.melted).toBe(1);
    expect(r.salvaged).toBeGreaterThan(0);
    expect(save.gold, 'скованное не ушло в золото').toBe(gold0);
  });
});

describe('⭐ бот по правилам «Разбор, сырьё и чары»: перекатка, ноша к кузнецу, крафтер', () => {
  const big = { strength: 900, dexterity: 900, intelligence: 900, vitality: 900 };
  const helmBase = reg.get('items.base').find((b) => b.kind === 'armor' && b.slot === 'helm' && b.enabled !== false)!;
  const chestBase = reg.get('items.base').find((b) => b.kind === 'armor' && b.slot === 'chest' && b.enabled !== false)!;
  const gen = (baseId: string, rarity: 'normal' | 'magic' | 'rare', seed: number, itemLevel = 20): Item =>
    shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { dropBias: 1, itemLevel, baseId, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: rarity, origin: 'drop' }, createRng(seed)));
  /** Герой 20-го уровня, атрибуты с запасом, на голове — редкий шлем БЕЗ свойств (перекатка заведомо выгодна). */
  function poorHelmHero(gold = 200_000): { save: SaveState; helm: Item } {
    const save = newBotSave(reg, 'warrior');
    levelUpBotTo(reg, save, 20, DEFAULT_BUILD, createRng(3));
    save.attributes = { ...big };
    save.gold = gold;
    const helm = { ...gen(helmBase.id, 'rare', 11), affixes: [] };
    save.equipment.helm = helm;
    return { save, helm };
  }
  const nonces = (): (() => string) => { let n = 0; return () => `bot-rr-${++n}`; };

  it('⭐ перекатка: выгодна — бот платит ровно золото и эссенцию перекатки, свойства есть, счёт перекаток +1', () => {
    const { save, helm } = poorHelmHero();
    expect(rerollGain(reg, save, 'helm', DEFAULT_BUILD)!, 'средний бросок лучше пустых свойств').toBeGreaterThan(0);
    const gold = forgeGold(reg, helm, 'reroll');
    const ess = rerollMaterials(reg, helm)[ESSENCE_ID]!;
    expect(ess).toBeGreaterThan(0);
    const stash = emptyStash(reg);
    stash.materials = { [ESSENCE_ID]: 100 };
    const gold0 = save.gold;
    const out = visitForge(reg, save, DEFAULT_BUILD, stash, { craft: true, rng: createRng(4), nonce: nonces() });
    expect(out.rerolled).toBe(1);
    expect(out.goldReroll).toBe(gold);
    expect(out.flow.reroll).toEqual({ [ESSENCE_ID]: ess });
    expect(out.matsOutReroll).toBe(ess);
    expect(stash.materials[ESSENCE_ID]).toBe(100 - ess);
    expect(save.equipment.helm!.uid).toBe(helm.uid);
    expect(save.equipment.helm!.affixes.length, 'свойства выкатились').toBeGreaterThan(0);
    expect(save.equipment.helm!.rerolls).toBe(1);
    expect(save.gold).toBe(gold0 - out.spent - out.goldCraft - out.goldEnchant + out.sold);
    flowsAgree(out, 'перекатка');
  });

  it('перекатка: нет эссенции — не катает и пишет «не хватило эссенции»; золото только на запас — «не хватило золота»', () => {
    const a = poorHelmHero();
    const outA = visitForge(reg, a.save, DEFAULT_BUILD, emptyStash(reg), { craft: true, rng: createRng(4), nonce: nonces() });
    expect(outA.rerolled).toBe(0);
    expect(outA.blocked.rerollEssence).toBe(1);
    expect(a.save.equipment.helm!.affixes).toEqual([]);
    const b = poorHelmHero(0);
    b.save.gold = forgeGold(reg, b.helm, 'reroll');   // на перекатку хватает, а запас на лавку (`goldReserve`) съела бы она
    const stash = emptyStash(reg);
    stash.materials = { [ESSENCE_ID]: 100 };
    const outB = visitForge(reg, b.save, DEFAULT_BUILD, stash, { craft: true, rng: createRng(4), nonce: nonces() });
    expect(outB.rerolled).toBe(0);
    expect(outB.blocked.rerollGold).toBe(1);
    expect(outB.blocked.rerollEssence).toBe(0);
    expect(stash.materials[ESSENCE_ID]).toBe(100);
  });

  it('перекатка: средний бросок не лучше нынешнего — бот не платит (лучший из 40 редких шлемов)', () => {
    const { save } = poorHelmHero();
    let best: Item | null = null;
    for (let k = 0; k < 40; k++) {
      const it = gen(helmBase.id, 'rare', 100 + k);
      save.equipment.helm = it;
      if (!best || scoreItem(reg, save, it, DEFAULT_BUILD) > scoreItem(reg, save, best, DEFAULT_BUILD)) best = it;
    }
    save.equipment.helm = best!;
    const gain = rerollGain(reg, save, 'helm', DEFAULT_BUILD)!;
    const stash = emptyStash(reg);
    stash.materials = { [ESSENCE_ID]: 100 };
    const out = visitForge(reg, save, DEFAULT_BUILD, stash, { craft: true, rng: createRng(4), nonce: nonces() });
    if (gain <= 0.05 * scoreItem(reg, save, best!, DEFAULT_BUILD)) expect(out.rerolled, `выгода ${gain}`).toBe(0);
    expect(rerollGain(reg, save, 'weapon', DEFAULT_BUILD), 'обычная (стартовая) — перекатывать нечего').toBeNull();
  });

  it('⭐ очерёдность ноши: открытие каталога выше всего, редкая выше обычной той же базы (эссенция), уник и зелье — 0', () => {
    const j = normalizeJournal(undefined);
    const sword = gen('long-sword', 'normal', 5);
    expect(carryPriority(reg, j, sword)).toBe(1e6);
    const rare = gen(chestBase.id, 'rare', 6, 30), normal = { ...rare, uid: 'n-uid', rarity: 'normal' as const, affixes: [] };
    expect(forgeSalvageGain(reg, rare)).toBeGreaterThan(forgeSalvageGain(reg, normal));
    expect(carryPriority(reg, j, rare)).toBeGreaterThan(carryPriority(reg, j, normal));
    expect(carryPriority(reg, j, normal)).toBeGreaterThan(0);
    expect(carryPriority(reg, j, { ...rare, rarity: 'unique' })).toBe(0);
    const potion = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { dropBias: 1, itemLevel: 5, baseId: 'healing-potion', tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), origin: 'drop' }, createRng(1));
    expect(carryPriority(reg, j, potion)).toBe(0);
  });

  it('⭐ снятое ради находки ценное — к кузнецу (`carried`), а не в разбор на месте', () => {
    const save = newBotSave(reg, 'warrior');
    save.attributes = { ...big };
    const old = { ...gen(chestBase.id, 'rare', 7, 30), affixes: [] };
    save.equipment.chest = old;
    const better = gen(chestBase.id, 'rare', 8, 30);
    expect(scoreItem(reg, save, better, DEFAULT_BUILD)).toBeGreaterThan(scoreItem(reg, save, old, DEFAULT_BUILD));
    const carry: FieldCarry = { journal: normalizeJournal(undefined), carryCells: 15, reserve: 0 };
    const r = considerDrop(reg, save, better, DEFAULT_BUILD, carry);
    expect(r.equipped).toBe(true);
    expect(r.carried, 'снятое несём').toBe(old);
    expect(r.sold + (r.salvaged ?? 0)).toBe(0);
    expect(carry.carryCells).toBe(15 - old.gridW * old.gridH);
  });

  it('⭐ крафтер (`salvageAll`): не по силам — в разбор, а не в золото; без политики — в золото, как было', () => {
    const weak = (): SaveState => {
      const s = newBotSave(reg, 'warrior');
      s.inventory = [];
      s.attributes = { strength: 1, dexterity: 1, intelligence: 1, vitality: 1 };
      return s;
    };
    const heavy = reg.get('items.base').filter((b) => b.kind === 'armor' && b.slot === 'chest' && b.enabled !== false)
      .map((b, i) => gen(b.id, 'rare', 9 + i, 70)).find((it) => !meetsRequirements(it, weak().attributes))!;
    expect(heavy, 'есть нагрудник не по силам').toBeTruthy();
    const a = weak();
    const ra = considerDrop(reg, a, { ...heavy }, DEFAULT_BUILD, { journal: normalizeJournal(undefined), carryCells: 0, reserve: 0 });
    expect(ra.sold, 'по умолчанию — продажа').toBeGreaterThan(0);
    const b = weak();
    const rb = considerDrop(reg, b, { ...heavy }, DEFAULT_BUILD, { journal: normalizeJournal(undefined), carryCells: 0, reserve: 0, salvageAll: true });
    expect(rb.sold).toBe(0);
    expect(rb.salvagedItems).toBe(1);
    expect(rb.gains?.[ESSENCE_ID] ?? 0, 'эссенция в поле — доля').toBeLessThanOrEqual(1);
    expect(Object.values(rb.forgeMean ?? {}).reduce((x, y) => x + y, 0), 'у кузнеца было бы больше').toBeGreaterThan(Object.values(rb.gains ?? {}).reduce((x, y) => x + y, 0));
  });

  it('⭐ у кузнеца разбирается ВСЁ принесённое: броня — в каталог снаряжения, эссенция и сырьё — целиком; учёт по id сходится', () => {
    const save = newBotSave(reg, 'warrior');
    save.inventory = [];
    const chest = gen(chestBase.id, 'rare', 12, 30);
    expect(addToInventory(save.inventory, chest, reg.get('balance').inventory)).toBe(true);
    const stash = emptyStash(reg);
    const out = visitForge(reg, save, DEFAULT_BUILD, stash, { craft: true, rng: createRng(5), nonce: nonces() });
    expect(out.salvaged).toBe(1);
    expect(out.flow.salvage[ESSENCE_ID], 'редкая — 2 эссенции').toBe(2);
    expect(normalizeJournal(stash.forgeJournal).gearSeen).toContain(chestBase.id);
    expect(save.inventory.some((i) => i.uid === chest.uid)).toBe(false);
    flowsAgree(out, 'броня у кузнеца');
  });

  it('лавка с ковкой (`toForge`): снятое — в сумку к кузнецу, а не на прилавок; без ковки — продаётся', () => {
    const mk = (): SaveState => {
      const s = newBotSave(reg, 'warrior');
      levelUpBotTo(reg, s, 20, DEFAULT_BUILD, createRng(3));
      s.gold = 10_000_000;
      return s;
    };
    const a = mk(), b = mk();
    const ra = visitShop(reg, a, 20, createRng(21), DEFAULT_BUILD, { toForge: true });
    const rb = visitShop(reg, b, 20, createRng(21), DEFAULT_BUILD);
    expect(ra.bought.length, 'лавка что-то продала').toBeGreaterThan(0);
    expect(ra.bought.map((i) => i.baseId)).toEqual(rb.bought.map((i) => i.baseId));
    expect(rb.sold, 'без ковки снятое продано, как было').toBeGreaterThan(0);
    expect(ra.sold, 'с ковкой снятое не продано').toBe(0);
    expect(a.inventory.length, 'снятое лежит в сумке').toBeGreaterThan(0);
    expect(b.inventory.length).toBe(0);
    // Кузница разбирает снятое (стартовое — только в каталог, а нового нет — за 1, R3-04): в сумке не остаётся вещей.
    const out = visitForge(reg, a, DEFAULT_BUILD, emptyStash(reg), { craft: true, rng: createRng(5), nonce: nonces() });
    expect(out.salvaged + (out.sold > 0 ? 1 : 0)).toBeGreaterThan(0);
    expect(a.inventory.filter((i) => i.kind !== 'material')).toEqual([]);
  });
});

/** Эталонная сборка топора первой ступени — для «скованного в руке». */
function defaultAxe(): CraftParts {
  const keySlot = keySlotOf(reg, 'axe');
  const group = keyVariantsByBase(reg, 'axe', 1).find((g) => g.baseId === 'hand-axe')!;
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group.variants : variantsFor(reg, 'axe', slot, 1);
    const p = pool.find((x) => x.stepMin <= 1) ?? pool[0]!;
    parts[slot] = { id: p.id, step: p.stepMin };
  }
  return parts;
}

/** Сырьё по id (`flow`) сходится со счётчиками единиц, золото по статьям — с `spent`: отчёт «сорт × семья» и эссенции не врёт. */
function flowsAgree(out: ForgeResult, tag: string): void {
  const u = (m: MaterialCost): number => Object.values(m).reduce((a, b) => a + b, 0);
  expect(u(out.flow.salvage), `${tag}: разбор`).toBe(out.matsIn);
  expect(u(out.flow.melt), `${tag}: переплавка`).toBe(out.matsMelt);
  expect(u(out.flow.craft), `${tag}: ковка`).toBe(out.matsOutCraft);
  expect(u(out.flow.upgrade) + u(out.flow.repair), `${tag}: подъём и починка`).toBe(out.matsOutForge);
  expect(u(out.flow.enchant), `${tag}: зачарование`).toBe(out.matsOutEnchant);
  expect(u(out.flow.reroll), `${tag}: перекатка`).toBe(out.matsOutReroll);
  for (const [k, m] of Object.entries(out.flow)) for (const [id, n] of Object.entries(m)) expect(n, `${tag}: ${k} ${id} — без минусов`).toBeGreaterThan(0);
  expect(Object.keys(out.flow.reroll).every((id) => id === ESSENCE_ID), `${tag}: перекатка тратит только эссенцию`).toBe(true);
  expect(out.spent, `${tag}: статьи золота`).toBe(out.goldRepair + out.goldUpgrade + out.goldReroll);
}

describe('K7: фаззер кузницы бота — случайные журналы, сырьё, золото и сумки', () => {
  it('⭐ 100 случайных состояний: не бросает, золото и сырьё сходятся до единицы, скованное не продаётся', () => {
    const rng = createRng(4242);
    const full = fullJournal(reg);
    const weapons = reg.get('items.base').filter((b) => b.kind === 'weapon' && b.enabled !== false).map((b) => b.id);
    const units = (save: SaveState, st: AccountStash): number =>
      Object.values(availableMaterials(save.inventory, st.materials ?? {})).reduce((a, b) => a + b, 0);
    let crafted = 0, rerolled = 0;
    for (let i = 0; i < 100; i++) {
      const save = newBotSave(reg, rng.pick(['warrior', 'mage', 'archer', 'zastupnik', 'vyuga']));
      levelUpBotTo(reg, save, rng.int(1, 60), DEFAULT_BUILD, rng);
      save.gold = rng.chance(0.2) ? 0 : rng.int(0, 200_000);
      const st = emptyStash(reg);
      st.forgeJournal = {
        ...normalizeJournal(undefined),
        bases: full.bases.filter(() => rng.chance(0.4)),
        variants: full.variants.filter(() => rng.chance(0.5)),
        tierHi: rng.int(-1, 6),
        mythic: rng.int(0, 6),
      };
      for (const m of mats) if (rng.chance(0.6)) st.materials![m.id] = rng.int(1, 400);
      // Сумка: найденное (иногда сломанное), скованное, стек сырья.
      for (let k = rng.int(0, 5); k > 0; k--) {
        const it = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
          { dropBias: 1.5, itemLevel: rng.int(1, 80), baseId: rng.pick(weapons), tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), origin: 'drop' }, rng));
        if (rng.chance(0.2)) it.broken = true;
        addToInventory(save.inventory, it, reg.get('balance').inventory);
      }
      if (rng.chance(0.5)) {
        const pv = craftWeapon(reg, { weaponClass: 'axe', hands: 1, parts: defaultAxe() }, { rng });
        if (pv.item) addToInventory(save.inventory, pv.item, reg.get('balance').inventory);
      }
      if (rng.chance(0.5)) addToInventory(save.inventory, materialItem(rng.pick(mats), rng.int(1, 150), `stack-${i}`), reg.get('balance').inventory, 200);
      // Надетое магическое и редкое (перекатка, §6.2): иногда с пустыми свойствами — тогда перекатка выгодна; эссенции — когда есть, когда нет.
      for (let k = rng.int(0, 3); k > 0; k--) {
        const it = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
          { dropBias: 2, itemLevel: rng.int(1, 80), tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: rng.pick(['magic', 'rare'] as const), origin: 'drop' }, rng));
        if (!it.slot) continue;
        if (rng.chance(0.5)) it.affixes = [];
        save.equipment[it.slot] = it;
      }
      if (rng.chance(0.5)) st.materials![ESSENCE_ID] = rng.int(0, 60);
      const gold0 = save.gold, u0 = units(save, st);
      const out = visitForge(reg, save, DEFAULT_BUILD, st, { craft: true, rng, nonce: () => `fuzz-${i}-${crafted}`, fullJournal: rng.chance(0.3) });
      crafted += out.crafted;
      expect(Number.isInteger(save.gold) && save.gold >= 0, `#${i}: золото ${save.gold}`).toBe(true);
      expect(save.gold, `#${i}: сальдо золота`).toBe(gold0 - out.spent - out.goldCraft - out.goldEnchant + out.sold);
      expect(units(save, st), `#${i}: сальдо сырья`).toBe(u0 + out.matsIn + out.matsMelt - out.matsOutCraft - out.matsOutForge - out.matsOutEnchant - out.matsOutReroll);
      for (const [id, n] of Object.entries(st.materials ?? {})) expect(Number.isInteger(n) && n > 0, `#${i}: ${id}=${n}`).toBe(true);
      flowsAgree(out, `#${i}`);
      rerolled += out.rerolled;
      expect(save.inventory.filter((it) => it.kind === 'weapon' && !it.broken), `#${i}: принесённое оружие разобрано`).toEqual([]);
      expect(st.craftNonces!.length).toBeLessThanOrEqual(32);
    }
    expect(crafted, 'фаззер дошёл и до ковки').toBeGreaterThan(5);
    expect(rerolled, 'и до перекатки').toBeGreaterThan(5);
  });
});

/** Отчёт прогона: сырьё по id сходится с единицами по источникам и статьям, золото по статьям — с общими суммами. */
function reportAgrees(r: ReturnType<typeof runSessionSim>): void {
  const u = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
  const c = r.craft, m = c.materials;
  expect(u(c.flow.in.monsters)).toBe(m.in.monsters);
  expect(u(c.flow.in.field)).toBe(m.in.field);
  expect(u(c.flow.in.forge)).toBe(m.in.forge);
  expect(u(c.flow.in.melt)).toBe(m.in.melt);
  expect(u(c.flow.out.craft)).toBe(m.out.craft);
  expect(u(c.flow.out.upgrade) + u(c.flow.out.repair)).toBe(m.out.forge);
  expect(u(c.flow.out.enchant)).toBe(m.out.enchant);
  expect(u(c.flow.out.reroll)).toBe(m.out.reroll);
  expect(c.gold.monsters).toBe(r.goldEarned);
  expect(c.gold.sold).toBe(r.goldSold);
  expect(c.gold.passives).toBe(r.goldOnPassives);
  expect(c.gold.shop + c.gold.belt + c.gold.repair + c.gold.upgrade + c.gold.reroll, 'магазин + пояс + кузня').toBe(r.goldSpent);
}

describe('K7: сим на GameSession с ковкой', () => {
  it('⭐ бот куёт в настоящем прогоне; сверка сырья сходится; скованное не продаётся; сид повторяется', () => {
    const stash = richStash(300);
    // Золото на старте: иначе первые минуты его съедают пассивы и лавка, и до ковки дело не доходит.
    const save = { ...newBotSave(reg, 'warrior'), gold: 20_000 };
    const opts = {
      classId: 'warrior', difficultyId: 'normal', seed: 77, targetLevel: 80, maxHours: 0.1, build: DEFAULT_BUILD,
      craft: true, fullJournal: true, stash, save,
    };
    const a = runSessionSim(reg, opts);
    expect(a.craft.enabled).toBe(true);
    expect(a.craft.crafted, 'ковка случилась').toBeGreaterThanOrEqual(1);
    expect(a.craftedPerHour).toBeGreaterThan(0);
    expect(a.craft.goldOnCraft).toBeGreaterThan(0);
    expect(a.craft.materials.out.craft).toBeGreaterThan(0);
    // Сверка: старт + пришло − ушло − запас = потеряно (смерть, не влезло) — не меньше нуля.
    expect(a.craft.materials.lost).toBeGreaterThanOrEqual(0);
    reportAgrees(a);
    expect(stash.materials!['iron-1'], 'прогон не правит переданный сундук').toBe(300);
    const b = runSessionSim(reg, opts);
    expect(b.craft.crafted).toBe(a.craft.crafted);
    expect(b.craft.materials).toEqual(a.craft.materials);
    expect(b.goldEnd).toBe(a.goldEnd);

    // Без ковки на том же сиде — ни одной ковки, ни одного разбора у кузнеца.
    const off = runSessionSim(reg, { ...opts, craft: false });
    expect(off.craft.crafted + off.craft.salvagedAtForge + off.craft.enchanted + off.craft.rerolled).toBe(0);
    reportAgrees(off);
  });

  it('⭐ крафтер (`salvageAll`): отчёт по id и по статьям золота сходится; эссенция приходит; сид повторяется', () => {
    const save = newBotSave(reg, 'warrior');
    levelUpBotTo(reg, save, 30, DEFAULT_BUILD, createRng(30));
    save.gold = 5_000;
    // Эссенция приходит только разбором волшебных и редких вещей — будет ли такая за 0.15 ч, решает удача сида (этажи, бои, лут). Тест
    // не должен падать от правки генерации этажа (08.10: этажи крипты без колонн): ищем сид, где разбор её принёс, среди нескольких,
    // и все проверки — на нём
    const base = { classId: 'warrior', difficultyId: 'normal', targetLevel: 80, maxHours: 0.15, build: DEFAULT_BUILD, craft: true, salvageAll: true };
    const essOf = (r: ReturnType<typeof runSessionSim>): number => (r.craft.flow.in.field[ESSENCE_ID] ?? 0) + (r.craft.flow.in.forge[ESSENCE_ID] ?? 0);
    let opts = { ...base, seed: 31, save: structuredClone(save) };
    let a = runSessionSim(reg, opts);
    for (let seed = 32; essOf(a) === 0 && seed < 40; seed++) { opts = { ...base, seed, save: structuredClone(save) }; a = runSessionSim(reg, opts); }
    reportAgrees(a);
    expect(a.craft.salvagedAtForge + a.craft.salvagedInField, 'разбор был').toBeGreaterThan(0);
    const ess = essOf(a);
    expect(ess, 'эссенция пришла разбором (хоть на одном из сидов 31–39)').toBeGreaterThan(0);
    expect(a.craft.materials.endByTier['эссенция'] ?? 0, 'эссенция — своей строкой, не «ступень 1»').toBeGreaterThan(0);
    const b = runSessionSim(reg, opts);
    expect(b.craft.flow).toEqual(a.craft.flow);
    expect(b.craft.gold).toEqual(a.craft.gold);
  });
});
