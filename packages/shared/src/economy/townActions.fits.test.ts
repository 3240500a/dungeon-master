import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { craftWeapon, defaultParts, fullJournal, type CraftInput } from '../formulas/craft.js';
import { createRng } from '../formulas/rng.js';
import type { SalvageRng } from '../formulas/salvage.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { addToInventory } from '../inventory/grid.js';
import {
  FIELD_SALVAGE_FULL, buyItem, canBuy, craftAction, craftFits, fieldSalvage, fieldSalvageFits, salvageRange, shopBuyPrice,
} from './townActions.js';
import { materialItem } from './materials.js';
import { emptyStash } from './stashActions.js';
import type { AccountStash } from '../types/stash.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ B3: МЕСТО В СУМКЕ — ОДНО ПРАВИЛО ДЛЯ ОКНА И СЕРВЕРА. Фаззер паритета «окно ≡ сервер» (`client/…/uiParity.fuzz.test.ts`)
 * нашёл три окна, которые горели, а сервер отказывал «нет места»: ценник прилавка (V-B3-02), «Ковать» (V-B3-03) и «Разобрать
 * здесь» (V-B3-04). Окно смотрело на золото и сырьё, сервер — ещё и на сумку. Теперь проверка места одна — её зовут и действие,
 * и окно (`canBuy`, `craftFits`, `fieldSalvageFits`), — а у разбора в поле она ещё и не зависит от броска.
 */

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const dims = reg.get('balance').inventory;
const STACK = dims.materialStack;
const mkSave = (gold: number, inventory: Item[]): SaveState => ({ gold, inventory, equipment: {} } as unknown as SaveState);
const LO: SalvageRng = { int: (a) => a, chance: () => false };
const HI: SalvageRng = { int: (_a, b) => b, chance: (p) => p > 1e-9 };

let junkN = 0;
/** Забить свободные клетки сумки полными стеками сырья, которого действие не касается (в полный стек не доложить). */
function fillBag(bag: Item[], avoid: readonly string[], leave = 0): Item[] {
  const def = reg.get('craft-materials').find((m) => !avoid.includes(m.id))!;
  const free = dims.cols * dims.rows;
  for (let k = 0; k < free; k++) if (!addToInventory(bag, materialItem(def, STACK, `junk-${++junkN}`), dims)) break;
  for (let k = 0; k < leave; k++) bag.pop();
  return bag;
}

describe('⭐ V-B3-02: прилавок — «по карману» и место в сумке одним ответом (`canBuy`)', () => {
  const sword = { ...itemFromBaseId(reg.get('items.base'), 'long-sword', reg.get('item-tiers'), 'shop')!, uid: 'shop-sword' };
  const price = shopBuyPrice(reg, sword);

  it('полная сумка: `canBuy` отказывает «Нет места» — тем же, что и покупка', () => {
    const save = mkSave(price * 3, fillBag([], []));
    expect(canBuy(reg, save, sword, price)).toEqual({ ok: false, reason: 'Нет места' });
    const before = JSON.stringify(save);
    expect(buyItem(reg, save, sword, price)).toEqual({ ok: false, reason: 'Нет места' });
    expect(JSON.stringify(save), 'отказ сейв не трогает').toBe(before);
  });

  it('`canBuy` ≡ `buyItem` на грани золота и места', () => {
    for (const gold of [price - 1, price, price + 1]) {
      for (const bag of [[] as Item[], fillBag([], []), fillBag([], [], 3)]) {
        const save = mkSave(gold, structuredClone(bag));
        const can = canBuy(reg, save, sword, price);
        const r = buyItem(reg, save, structuredClone(sword), price);
        expect(r, `золото ${gold}, в сумке ${bag.length}`).toEqual(can.ok ? { ok: true } : can);
      }
    }
  });
});

describe('⭐ V-B3-03: «Ковать» — место ПОСЛЕ списания сырья одним ответом (`craftFits`)', () => {
  const input: CraftInput = { weaponClass: 'sword', hands: 1, parts: defaultParts(reg, 'sword', 1, 2)!, finish: 0 };
  const pv = craftWeapon(reg, input, { journal: fullJournal(reg), materialsOn: true });
  const need = pv.cost!.materials;
  const stash = (): AccountStash => ({ ...emptyStash(reg), materials: Object.fromEntries(Object.keys(need).map((id) => [id, 10_000])), forgeJournal: fullJournal(reg) });

  it('полная сумка, сырьё в сундуке: не ляжет — и ковка отказывает «Нет места в сумке», ничего не тронув', () => {
    const bag = fillBag([], Object.keys(need));
    expect(craftFits(reg, bag, need, pv.item!)).toBe(false);
    const save = mkSave(1_000_000, bag), st = stash();
    const before = JSON.stringify([save, st]);
    expect(craftAction(reg, save, st, 'fits-0000000001', input, createRng(1))).toEqual({ ok: false, reason: 'Нет места в сумке' });
    expect(JSON.stringify([save, st])).toBe(before);
  });

  it('сумка полна, но сырьё ковки лежит в ней и уходит целиком — место освобождается: ляжет, и ковка проходит', () => {
    // Столбец (0, 0…h−1) — стеки сырья цены по одной штуке: ковка их съест, и вещь ляжет ровно туда.
    const ids = Object.keys(need);
    const h = pv.item!.gridH;
    const bag: Item[] = [];
    for (let y = 0; y < h; y++) bag.push({ ...materialItem(reg.get('craft-materials').find((m) => m.id === ids[y % ids.length])!, 1, `own-${y}`), pos: { x: 0, y } });
    fillBag(bag, ids);
    expect(pv.item!.gridW, 'сборка — в один столбец').toBe(1);
    expect(craftFits(reg, bag, need, pv.item!)).toBe(true);
    const save = mkSave(1_000_000, bag);
    expect(craftAction(reg, save, stash(), 'fits-0000000002', input, createRng(2)).ok).toBe(true);
  });
});

describe('⭐ V-B3-04: разбор в поле — место по ЛУЧШЕМУ броску (`fieldSalvageFits`), исход не зависит от кубика', () => {
  // Стилет: в поле вилка «0–1» по четырём материалам — лучший бросок просит четыре клетки, худший — ни одной.
  const stiletto = (): Item => ({ ...itemFromBaseId(reg.get('items.base'), 'stiletto', reg.get('item-tiers'), 'drop')!, uid: 'stiletto' });
  const range = salvageRange(reg, stiletto(), true).range;
  const cells = Object.values(range).filter((y) => y.max > 0).length;
  const withStiletto = (spare: number): Item[] => {
    const bag: Item[] = [];
    addToInventory(bag, stiletto(), dims);
    return fillBag(bag, Object.keys(range), spare);
  };

  it('лучший бросок не влезет: отказ при ЛЮБОМ броске (раньше худший — пустой — проходил), вещь цела', () => {
    expect(Object.values(range).every((y) => y.min === 0), 'худший бросок не даёт ничего').toBe(true);
    const spare = cells - stiletto().gridW * stiletto().gridH - 1;   // клеток на одну меньше, чем нужно лучшему
    expect(spare).toBeGreaterThanOrEqual(0);
    expect(fieldSalvageFits(reg, withStiletto(spare), stiletto())).toBe(false);
    for (const [name, rng] of [['худший', LO], ['лучший', HI], ['случайный', createRng(7)]] as const) {
      const save = mkSave(0, withStiletto(spare));
      const before = JSON.stringify(save);
      expect(fieldSalvage(reg, save, 'stiletto', rng as SalvageRng), name).toEqual({ ok: false, reason: FIELD_SALVAGE_FULL });
      expect(JSON.stringify(save), name).toBe(before);
    }
  });

  it('лучший бросок влезает: разбор при любом броске', () => {
    const spare = cells - stiletto().gridW * stiletto().gridH;
    expect(fieldSalvageFits(reg, withStiletto(spare), stiletto())).toBe(true);
    for (const rng of [LO, HI, createRng(7)]) {
      const save = mkSave(0, withStiletto(spare));
      expect(fieldSalvage(reg, save, 'stiletto', rng).ok).toBe(true);
      expect(save.inventory.some((i) => i.uid === 'stiletto')).toBe(false);
    }
  });
});
