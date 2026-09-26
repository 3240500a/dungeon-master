import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng, type Rng } from '../formulas/rng.js';
import {
  CRAFT_NONCE_RE, craftWeapon, enchantSlots, enchantCost, fullJournal, keyVariantsByBase, normalizeJournal, shapeFoundWeapon,
  variantsFor, type CraftInput,
} from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, keySlotOf } from '../formulas/craftType.js';
import { craftAction, enchantAction, fieldSalvage, forgeSalvage, sellItem, shopSellPrice } from '../economy/townActions.js';
import { availableMaterials, depositCarried, materialItem, type MaterialCost } from '../economy/materials.js';
import { emptyStash } from '../economy/stashActions.js';
import { addToInventory } from '../inventory/grid.js';
import { generateItem } from '../formulas/itemgen.js';
import { newBotSave, levelUpBotTo } from './playerBot.js';
import { bestCraft, considerDrop, visitForge, visitShop, scoreItem, type FieldCarry } from './economy.js';
import { DEFAULT_BUILD } from './types.js';
import { runSessionSim } from '../session/runner.js';
import type { AccountStash } from '../types/stash.js';
import type { Item, CraftParts } from '../types/items.js';
import type { SaveState } from '../types/save.js';

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
          const e = enchantAction(reg, save, uid, r, rng);
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
        expect(m.unlocked, 'переплавка ничего не открывает').toBeUndefined();
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
    // Журнал: переплавка и продажа не открывают ничего — растёт только кодекс «сковал».
    const j = normalizeJournal(stash.forgeJournal);
    expect({ ...j, typesForged: [] }).toEqual({ ...journal0, typesForged: [] });
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
    // Снятое стартовое кузнец не разбирает (R3-04: комплект бесплатен и бесконечен) — бот сдаёт его в лавку за 1.
    expect(old.origin).toBe('start');
    expect(out.salvaged).toBe(0);
    expect(out.sold, 'стартовое продано за 1').toBe(1);
    expect(normalizeJournal(stash.forgeJournal).bases, 'журнал стартовым не открывается').not.toContain(old.baseId);
    const have1 = availableMaterials(save.inventory, stash.materials!);
    const spent = Object.values(have0).reduce((a, b) => a + b, 0) - Object.values(have1).reduce((a, b) => a + b, 0);
    expect(spent, 'сырьё: списано на ковку минус пришло разбором/переплавкой').toBe(out.matsOutCraft + out.matsOutForge - out.matsIn - out.matsMelt);
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

describe('K7: фаззер кузницы бота — случайные журналы, сырьё, золото и сумки', () => {
  it('⭐ 100 случайных состояний: не бросает, золото и сырьё сходятся до единицы, скованное не продаётся', () => {
    const rng = createRng(4242);
    const full = fullJournal(reg);
    const weapons = reg.get('items.base').filter((b) => b.kind === 'weapon' && b.enabled !== false).map((b) => b.id);
    const units = (save: SaveState, st: AccountStash): number =>
      Object.values(availableMaterials(save.inventory, st.materials ?? {})).reduce((a, b) => a + b, 0);
    let crafted = 0;
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
      const gold0 = save.gold, u0 = units(save, st);
      const out = visitForge(reg, save, DEFAULT_BUILD, st, { craft: true, rng, nonce: () => `fuzz-${i}-${crafted}`, fullJournal: rng.chance(0.3) });
      crafted += out.crafted;
      expect(Number.isInteger(save.gold) && save.gold >= 0, `#${i}: золото ${save.gold}`).toBe(true);
      expect(save.gold, `#${i}: сальдо золота`).toBe(gold0 - out.spent - out.goldCraft - out.goldEnchant + out.sold);
      expect(units(save, st), `#${i}: сальдо сырья`).toBe(u0 + out.matsIn + out.matsMelt - out.matsOutCraft - out.matsOutForge);
      for (const [id, n] of Object.entries(st.materials ?? {})) expect(Number.isInteger(n) && n > 0, `#${i}: ${id}=${n}`).toBe(true);
      expect(save.inventory.filter((it) => it.kind === 'weapon' && !it.broken), `#${i}: принесённое оружие разобрано`).toEqual([]);
      expect(st.craftNonces!.length).toBeLessThanOrEqual(32);
    }
    expect(crafted, 'фаззер дошёл и до ковки').toBeGreaterThan(5);
  });
});

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
    expect(stash.materials!['iron-1'], 'прогон не правит переданный сундук').toBe(300);
    const b = runSessionSim(reg, opts);
    expect(b.craft.crafted).toBe(a.craft.crafted);
    expect(b.craft.materials).toEqual(a.craft.materials);
    expect(b.goldEnd).toBe(a.goldEnd);

    // Без ковки на том же сиде — ни одной ковки, ни одного разбора у кузнеца.
    const off = runSessionSim(reg, { ...opts, craft: false });
    expect(off.craft.crafted + off.craft.salvagedAtForge + off.craft.enchanted).toBe(0);
  });
});
