import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import { craftWeapon, enchantCost, fullJournal, keyVariantsByBase, variantsFor, type CraftInput } from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, keySlotOf } from '../formulas/craftType.js';
import { generateItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { newBotSave } from '../sim/playerBot.js';
import { parseTownCommand } from '../session/netSchemas.js';
import {
  allocPassive, buyItem, craftAction, enchantAction, forgeGold, forgeRepair, forgeReroll, forgeUpgrade, passiveRespecFee, respec,
  respecPassives, respecSkills, sellItem, shopBuyPrice, shopSellPrice, skillRespecFee,
} from './townActions.js';
import { emptyStash } from './stashActions.js';
import type { AccountStash } from '../types/stash.js';
import type { CraftParts, Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ R5-15: СОГЛАСИЕ НА ЦЕНУ (`maxGold`). Золото берёт сервер по своему конфигу, а клиент показывает цену по своему — и
 * тот мог устареть: деплой с правкой баланса, после которого вкладка переподключилась без перезагрузки (L2 / R3-25),
 * правка из редактора, `/api/config`, не ответивший на старте. Платная команда несёт цену, которую видел игрок; ядро
 * отказывает, если его цена ВЫШЕ, — до любой траты, сейв и сундук байт в байт. Без `maxGold` (Unity, старые вкладки) —
 * прежнее поведение.
 */

type Data = Record<string, unknown> & typeof defaultConfigData;
function regWith(patch: (d: Data) => void = () => {}): ConfigRegistry {
  const d = structuredClone(defaultConfigData) as Data;
  for (const m of d['craft-materials'] as { enabled: boolean }[]) m.enabled = true;
  patch(d);
  const r = new ConfigRegistry();
  r.loadAll(d);
  return r;
}
/** Конфиг клиента (до деплоя) и сервера (после): все цены золота — в полтора раза выше. */
const before = regWith();
const after = regWith((d) => {
  const b = d.balance as unknown as {
    craft: { cost: { goldPerReqMult: number; enchantGold: number } };
    forgePrices: { upgradeTier: number; rerollAffix: number; repairBroken: number };
    respecCost: number; passiveRespecCostPct: number; skillRespecCostPerPoint: number;
  };
  b.craft.cost.goldPerReqMult = Math.round(b.craft.cost.goldPerReqMult * 1.5);
  b.craft.cost.enchantGold = Math.round(b.craft.cost.enchantGold * 1.5);
  b.forgePrices.upgradeTier = Math.round(b.forgePrices.upgradeTier * 1.5);
  b.forgePrices.rerollAffix = Math.round(b.forgePrices.rerollAffix * 1.5);
  b.forgePrices.repairBroken = Math.round(b.forgePrices.repairBroken * 1.5);
  b.respecCost = Math.round(b.respecCost * 1.5);
  b.passiveRespecCostPct = Math.min(1, b.passiveRespecCostPct * 1.5);
  b.skillRespecCostPerPoint = Math.round(b.skillRespecCostPerPoint * 1.5);
});

const wallet = (): Record<string, number> => Object.fromEntries(after.get('craft-materials').map((m) => [m.id, 999]));
const hero = (): SaveState => { const s = newBotSave(after, after.get('classes')[0]!.id); s.gold = 1_000_000; return s; };
const frozen = (...xs: unknown[]): string => JSON.stringify(xs);

function inputAt(r: ConfigRegistry, step: number): CraftInput {
  const keySlot = keySlotOf(r, 'sword');
  const group = keyVariantsByBase(r, 'sword', 1).find((g) => g.variants.some((p) => p.stepMin <= step && step <= p.stepMax))!;
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group.variants : variantsFor(r, 'sword', slot, 1);
    const p = pool.find((v) => v.stepMin <= step && step <= v.stepMax)!;
    parts[slot] = { id: p.id, step };
  }
  return { weaponClass: 'sword', hands: 1, parts };
}
const INPUT = inputAt(after, 4);
const stashOf = (): AccountStash => ({ ...emptyStash(after), materials: wallet(), forgeJournal: fullJournal(after) });

/** Найденная магическая вещь в сумке: её улучшают, перекатывают и (сломанную) чинят. */
function found(broken = false): Item {
  const bal = after.get('balance');
  const it = generateItem(after.get('items.base'), after.get('affixes'), after.get('uniques'), {
    dropBias: 1, itemLevel: 6, tierLevel: 6, baseId: 'long-sword', tiers: after.get('item-tiers'), rarities: after.get('rarities'),
    forceRarity: 'magic', maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
  }, createRng(7));
  return { ...it, uid: 'pc-item', pos: { x: 0, y: 0 }, ...(broken ? { broken: true } : {}) };
}

/**
 * Карточка показала `shown`, сервер берёт `real`: с `maxGold: shown` — отказ «Цена изменилась: real», сейв и кошелёк
 * байт в байт; с `maxGold: real` — проходит и берёт ровно `real`.
 */
function consent(shown: number, real: number, run: (maxGold: number) => { ok: boolean; reason?: string }, save: SaveState, ...also: unknown[]): void {
  expect(real, 'правка баланса подняла цену').toBeGreaterThan(shown);
  const snap = frozen(save, ...also);
  const r = run(shown);
  expect(r.ok, 'было: сервер молча брал новую цену').toBe(false);
  expect(r.reason).toBe(`Цена изменилась: ${real} золота`);
  expect(frozen(save, ...also), 'отказ — до любой траты').toBe(snap);
  const g0 = save.gold;
  const ok = run(real);
  expect(ok.ok, ok.reason).toBe(true);
  expect(g0 - save.gold, 'взято ровно по своей цене').toBe(real);
}

describe('⭐ R5-15: платные команды кузницы и сбросов — только по цене, которую видел игрок', () => {
  it('⭐ ковка: окно показало цену старого конфига — отказ байт в байт; по новой — ковка', () => {
    const shown = craftWeapon(before, INPUT, { journal: fullJournal(before) }).cost!.gold;
    const real = craftWeapon(after, INPUT, { journal: fullJournal(after) }).cost!.gold;
    const save = hero(), stash = stashOf();
    let n = 0;
    consent(shown, real, (maxGold) => craftAction(after, save, stash, `pc-nonce-${++n}`, INPUT, createRng(3), { maxGold }), save, stash);
  });

  it('ковка: повтор ключа уже скованной заявки отвечает прежней вещью при любой цене — он не платит', () => {
    const save = hero(), stash = stashOf();
    const r = craftAction(after, save, stash, 'pc-nonce-again', INPUT, createRng(3));
    expect(r.ok, r.reason).toBe(true);
    const snap = frozen(save, stash);
    expect(craftAction(after, save, stash, 'pc-nonce-again', INPUT, createRng(3), { maxGold: 0 })).toEqual({ ok: true, uid: r.uid });
    expect(frozen(save, stash)).toBe(snap);
  });

  it('⭐ зачарование скованной', () => {
    const save = hero(), stash = stashOf();
    const c = craftAction(after, save, stash, 'pc-nonce-ench', INPUT, createRng(3));
    const item = save.inventory.find((i) => i.uid === c.uid)!;
    consent(enchantCost(before, item, 'rare'), enchantCost(after, item, 'rare'),
      (maxGold) => enchantAction(after, save, item.uid, 'rare', createRng(5), maxGold), save);
  });

  it('⭐ улучшение, перекатка, починка', () => {
    const up = hero(); up.inventory = [found()];
    const w1 = wallet();
    consent(forgeGold(before, up.inventory[0]!, 'upgrade'), forgeGold(after, up.inventory[0]!, 'upgrade'),
      (maxGold) => forgeUpgrade(after, up, 'pc-item', w1, maxGold), up, w1);
    const rr = hero(); rr.inventory = [found()];
    consent(forgeGold(before, rr.inventory[0]!, 'reroll'), forgeGold(after, rr.inventory[0]!, 'reroll'),
      (maxGold) => forgeReroll(after, rr, 'pc-item', createRng(9), maxGold), rr);
    const fx = hero(); fx.inventory = [found(true)];
    const w2 = wallet();
    consent(forgeGold(before, fx.inventory[0]!, 'repair'), forgeGold(after, fx.inventory[0]!, 'repair'),
      (maxGold) => forgeRepair(after, fx, 'pc-item', w2, maxGold), fx, w2);
  });

  it('сброс атрибутов, скилов и мастерств', () => {
    const a = hero(); a.attributes = { ...a.attributes, vitality: a.attributes.vitality + 3 };
    consent(before.get('balance').respecCost, after.get('balance').respecCost, (maxGold) => respec(after, a, maxGold), a);
    const node = after.get('skill-tree').nodes[0]!.id;
    const s = hero(); s.skills = { [node]: 2 };
    consent(skillRespecFee(before, s), skillRespecFee(after, s), (maxGold) => respecSkills(after, s, maxGold), s);
    const m = hero(); m.masteries = { [after.get('mastery-tree').nodes.find((x) => x.cost.type === 'gold' && x.cost.amount >= 10)!.id]: 1 };
    consent(passiveRespecFee(before, m), passiveRespecFee(after, m), (maxGold) => respecPassives(after, m, maxGold), m);
  });

  it('цена ниже показанной — не отказ; без `maxGold` (Unity, старая вкладка) — как раньше; кривой `maxGold` — отказ', () => {
    const cheap = hero(); cheap.inventory = [found()];
    const real = forgeGold(before, cheap.inventory[0]!, 'reroll');
    expect(forgeReroll(before, cheap, 'pc-item', createRng(1), real * 2).ok).toBe(true);
    const legacy = hero(); legacy.inventory = [found()];
    expect(forgeReroll(after, legacy, 'pc-item', createRng(1)).ok).toBe(true);
    const bad = hero(); bad.inventory = [found()];
    const snap = frozen(bad);
    expect(forgeReroll(after, bad, 'pc-item', createRng(1), Number.NaN).ok).toBe(false);
    expect(frozen(bad)).toBe(snap);
  });
});

describe('R5-15: `maxGold` на проводе', () => {
  it('платные команды его принимают: целое ≥ 0; дробь, минус, строка — отказ схемы; бесплатным он чужой', () => {
    for (const c of [
      { cmd: 'forgeUpgrade', uid: 'u' }, { cmd: 'forgeReroll', uid: 'u' }, { cmd: 'forgeRepair', uid: 'u' },
      { cmd: 'forgeEnchant', uid: 'u', rarity: 'rare' }, { cmd: 'craft', nonce: 'nonce-0001', input: INPUT },
      { cmd: 'respec' }, { cmd: 'respecSkills' }, { cmd: 'respecPassives' },
      // R6-16: покупка в лавке и узел мастерства — тоже за золото.
      { cmd: 'buy', uid: 'u' }, { cmd: 'allocPassive', nodeId: 'n1' },
    ]) {
      expect(parseTownCommand({ ...c, maxGold: 4500 }).ok, c.cmd).toBe(true);
      expect(parseTownCommand({ ...c, maxGold: 0 }).ok, c.cmd).toBe(true);
      expect(parseTownCommand(c).ok, `${c.cmd} без цены`).toBe(true);
      for (const bad of [-1, 1.5, '4500', null, Number.POSITIVE_INFINITY]) expect(parseTownCommand({ ...c, maxGold: bad }).ok, `${c.cmd} ${String(bad)}`).toBe(false);
    }
    // R6-16: продажа несёт НИЖНЮЮ границу (`minGold`) — ту же рамку числа; «потолок» продаже чужой.
    expect(parseTownCommand({ cmd: 'sell', uid: 'u', minGold: 7 }).ok).toBe(true);
    expect(parseTownCommand({ cmd: 'sell', uid: 'u', minGold: 0 }).ok).toBe(true);
    for (const bad of [-1, 1.5, '7', null, Number.POSITIVE_INFINITY]) expect(parseTownCommand({ cmd: 'sell', uid: 'u', minGold: bad }).ok, `sell ${String(bad)}`).toBe(false);
    for (const c of [{ cmd: 'sell', uid: 'u' }, { cmd: 'forgeSalvage', uid: 'u' }]) {
      expect(parseTownCommand({ ...c, maxGold: 10 }).ok, c.cmd).toBe(false);
    }
    expect(parseTownCommand({ cmd: 'buy', uid: 'u', minGold: 10 }).ok, 'покупке «пол» чужой').toBe(false);
  });
});

/**
 * ⚠ R6-16: СОГЛАСИЕ НА ЦЕНУ БЫЛО ЧАСТИЧНЫМ. R5-15 дал `maxGold` кузнице и сбросам, но не узлу мастерства («след. ранг: N зол.»
 * по конфигу вкладки), не покупке (цена кадра `shop`, собранного на входе в город) и не продаже (подпись «+N» по конфигу
 * клиента). Правка цен из редактора живьём (или деплой с переподключением без перезагрузки): показано 800 — взято 2700,
 * показано 19 — взято 57, показано +7 — выплачено иначе, без отказа. Теперь — тот же отказ до траты; у продажи — если
 * лавка даст МЕНЬШЕ показанного.
 */
describe('⚠ R6-16: мастерство, покупка и продажа — по цене, которую видел игрок', () => {
  const was = regWith();
  const dearer = regWith((d) => {
    (d.balance as unknown as { passiveRankCostMult: number }).passiveRankCostMult = 3;
    for (const r of d.rarities as unknown as { priceMult: number }[]) r.priceMult *= 1.5;
  });
  const cheaper = regWith((d) => { for (const r of d.rarities as unknown as { priceMult: number }[]) r.priceMult *= 0.5; });
  const heroIn = (r: ConfigRegistry): SaveState => { const s = newBotSave(r, r.get('classes')[0]!.id); s.gold = 1_000_000; return s; };

  it('⭐ узел мастерства: карточка «след. ранг» по старому множителю — отказ до траты; по новой цене — ранг', () => {
    const node = dearer.get('mastery-tree').nodes.find((n) => n.cost.type === 'gold' && n.cost.amount >= 10 && n.maxRank >= 3)!;
    const s = heroIn(dearer);
    s.masteries = { [node.id]: 1 };
    s.unspentMasteryPoints = 3;
    const shown = Math.round(node.cost.amount * Math.pow(was.get('balance').passiveRankCostMult, 1));
    const real = Math.round(node.cost.amount * Math.pow(dearer.get('balance').passiveRankCostMult, 1));
    consent(shown, real, (maxGold) => allocPassive(dearer, s, node.id, maxGold), s);
    expect(s.masteries[node.id]).toBe(2);
  });

  it('⭐ покупка: цена кадра лавки старого конфига — отказ, вещь не куплена; по новой — куплена ровно за неё', () => {
    const s = heroIn(dearer);
    s.inventory = [];
    const it = found();
    const shown = shopBuyPrice(was, it), real = shopBuyPrice(dearer, it);
    consent(shown, real, (maxGold) => buyItem(dearer, s, it, maxGold), s);
    expect(s.inventory.some((x) => x.uid === it.uid)).toBe(true);
  });

  it('⭐ продажа: подпись «+N» старого конфига, лавка даёт меньше — отказ, вещь в сумке; даёт больше или столько же — продано', () => {
    const it = found();
    const shown = shopSellPrice(was, it), low = shopSellPrice(cheaper, it), high = shopSellPrice(dearer, it);
    expect(low, 'правка опустила цену скупки').toBeLessThan(shown);
    const s = heroIn(cheaper);
    s.inventory = [{ ...it }];
    const snap = frozen(s);
    const r = sellItem(cheaper, s, it.uid, shown);
    expect(r).toEqual({ ok: false, reason: `Цена изменилась: лавка даст ${low} золота` });
    expect(frozen(s), 'отказ — до продажи').toBe(snap);
    const g0 = s.gold;
    expect(sellItem(cheaper, s, it.uid, low).ok).toBe(true);
    expect(s.gold - g0).toBe(low);
    const h = heroIn(dearer);
    h.inventory = [{ ...it }];
    const g1 = h.gold;
    expect(sellItem(dearer, h, it.uid, shown).ok, 'дали больше показанного — не отказ').toBe(true);
    expect(h.gold - g1).toBe(high);
    const legacy = heroIn(cheaper);
    legacy.inventory = [{ ...it }];
    expect(sellItem(cheaper, legacy, it.uid).ok, 'без `minGold` (Unity, старая вкладка) — как раньше').toBe(true);
    const bad = heroIn(cheaper);
    bad.inventory = [{ ...it }];
    expect(sellItem(cheaper, bad, it.uid, Number.NaN).ok, 'кривой `minGold` — отказ').toBe(false);
  });
});
