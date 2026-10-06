import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import { configSchemas } from '../config/schemas.js';
import { createRng } from '../formulas/rng.js';
import { ESSENCE_ID } from '../formulas/salvage.js';
import { newCharacterSave } from './newCharacter.js';
import { materialItem, availableMaterials } from './materials.js';
import { emptyStash } from './stashActions.js';
import { PRICE_CHANGED, shopSellPrice } from './townActions.js';
import { exchangeQuote, exchangeTargets, exchangeUnitGold, exchangeYield, forgeExchange } from './exchange.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import type { AccountStash } from '../types/stash.js';

/**
 * ⭐ ОБМЕН СЫРЬЯ У КУЗНЕЦА (`economy/exchange.ts`): тот же сорт другой семьи, 3 → 2 вниз, золото за полученную единицу по сорту. Сумка —
 * первой, полученное — в сундук; эссенция и выключенное сырьё не меняются; согласие — как у прочей кузницы; «обменял и продал» невыгодно
 * при любом конфиге.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const defs = reg.get('craft-materials');
const def = (id: string) => defs.find((m) => m.id === id)!;
const stack = (id: string, n: number, x = 0): Item => ({ ...materialItem(def(id), n, `m-${id}-${x}`), pos: { x, y: 0 } });

function setup(bag: Item[], wallet: Record<string, number>, gold = 10_000): { save: SaveState; st: AccountStash } {
  const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Меняла', 'char-ex');
  save.inventory = bag;
  save.gold = gold;
  const st = emptyStash(reg);
  st.materials = { ...wallet };
  return { save, st };
}

describe('⭐ обмен: курс, сорт, золото', () => {
  it('ручка в данных: 3 → 2, золото I 5 · II 12 · III 30 · IV 60 · V 120 (balance.json, не умолчание схемы)', () => {
    const file = (defaultConfigData.balance as { forgePrices: { exchange: unknown } }).forgePrices.exchange;
    expect(file).toEqual({ enabled: true, give: 3, get: 2, goldPerUnit: [5, 12, 30, 60, 120] });
    expect(reg.get('balance').forgePrices.exchange).toEqual(file);
  });

  it('вниз и без лишнего: 9 → 6, 10 → 6 (берётся 9), 2 → 1, 1 → ничего', () => {
    expect(exchangeYield(reg, 9)).toEqual({ get: 6, spend: 9 });
    expect(exchangeYield(reg, 10)).toEqual({ get: 6, spend: 9 });
    expect(exchangeYield(reg, 11)).toEqual({ get: 7, spend: 11 });
    expect(exchangeYield(reg, 2)).toEqual({ get: 1, spend: 2 });
    expect(exchangeYield(reg, 1)).toEqual({ get: 0, spend: 0 });
    // Отдано никогда не дешевле курса: get/spend ≤ 2/3.
    for (let n = 1; n <= 300; n++) { const y = exchangeYield(reg, n); if (y.get) expect(y.get * 3, `n=${n}`).toBeLessThanOrEqual(y.spend * 2); }
  });

  it('тот же сорт другой семьи; золото — по сорту за полученную единицу', () => {
    const q = exchangeQuote(reg, 'iron-3', 'wood', 9);
    expect(q).toMatchObject({ ok: true, from: 'iron-3', to: 'wood-3', grade: 3, spend: 9, get: 6, unitGold: 30, gold: 180 });
    for (const [g, unit] of [[1, 5], [2, 12], [3, 30], [4, 60], [5, 120]] as const) {
      expect(exchangeQuote(reg, `hide-${g}`, 'trim', 3)).toMatchObject({ ok: true, to: `trim-${g}`, get: 2, gold: 2 * unit });
    }
  });

  it('цели: шесть семей минус своя, без эссенции; Плечей и Фокуса нет', () => {
    const t = exchangeTargets(reg, 'iron-2');
    expect(t.map((x) => x.family).sort()).toEqual(['cloth', 'hide', 'plate', 'trim', 'wood']);
    expect(t.every((x) => x.ok && x.id.endsWith('-2'))).toBe(true);
    expect(exchangeTargets(reg, ESSENCE_ID)).toEqual([]);
  });

  it('отказы: эссенция, своя семья, нет такой семьи, мало, выключенное — с причиной', () => {
    expect(exchangeQuote(reg, ESSENCE_ID, 'iron', 9).reason).toMatch(/Эссенцию не меняют/);
    expect(exchangeQuote(reg, 'iron-3', 'ench', 9).reason).toMatch(/Эссенцию не меняют/);
    expect(exchangeQuote(reg, 'iron-3', 'iron', 9).reason).toMatch(/другую семью/);
    expect(exchangeQuote(reg, 'iron-3', 'stave', 9).reason).toMatch(/Нет такой семьи/);
    expect(exchangeQuote(reg, 'iron-3', 'wood', 1).reason).toMatch(/Мало/);
    const off = new ConfigRegistry();
    const d = structuredClone(defaultConfigData) as Record<string, unknown>;
    for (const m of d['craft-materials'] as { id: string; enabled: boolean }[]) if (m.id === 'wood-5') m.enabled = false;
    (d.balance as { forgePrices: { exchange: { enabled: boolean } } }).forgePrices.exchange.enabled = true;
    off.loadAll(d);
    const q = exchangeQuote(off, 'iron-5', 'wood', 9);
    expect(q.ok).toBe(false);
    expect(q.reason, 'в выключенное не меняют').toMatch(/ещё не в игре/);
    expect(exchangeQuote(off, 'wood-5', 'iron', 9).ok, 'из выключенного — можно: это запас игрока').toBe(true);
    const closed = new ConfigRegistry();
    const d2 = structuredClone(defaultConfigData) as Record<string, unknown>;
    (d2.balance as { forgePrices: { exchange: { enabled: boolean } } }).forgePrices.exchange.enabled = false;
    closed.loadAll(d2);
    expect(exchangeQuote(closed, 'iron-3', 'wood', 9).reason).toBe('Кузнец сейчас не меняет сырьё');
  });

  it('схема: получаешь не больше, чем отдаёшь (иначе туда-обратно растило бы сырьё); золото за единицу ≥ 1', () => {
    const b = structuredClone(defaultConfigData.balance) as { forgePrices: { exchange: Record<string, unknown> } };
    b.forgePrices.exchange.get = 4;
    expect(configSchemas.balance.safeParse(b).success).toBe(false);
    b.forgePrices.exchange.get = 2; b.forgePrices.exchange.goldPerUnit = [0, 12, 30, 60, 120];
    expect(configSchemas.balance.safeParse(b).success).toBe(false);
  });
});

describe('⭐ обмен — авторитетно (`forgeExchange`)', () => {
  it('сперва сумка, потом сундук; полученное — в сундук; золото списано; итоговая строка', () => {
    const { save, st } = setup([stack('iron-3', 5)], { 'iron-3': 10, 'wood-3': 1 });
    const r = forgeExchange(reg, save, st, 'iron-3', 'wood', 9, 180, { 'iron-3': 9 }, { 'wood-3': 6 });
    expect(r.ok, r.reason).toBe(true);
    expect(r.summary).toMatch(/^Обмен: отдано .* → получено .* \(в сундук\) · 180 золота$/);
    expect(save.inventory, 'стопка сумки ушла целиком первой').toEqual([]);
    expect(st.materials).toEqual({ 'iron-3': 6, 'wood-3': 7 });
    expect(save.gold).toBe(10_000 - 180);
  });

  it('остаток деления не сгорает: просил 10 — ушло 9', () => {
    const { save, st } = setup([], { 'cloth-2': 10 });
    expect(forgeExchange(reg, save, st, 'cloth-2', 'hide', 10, 72, { 'cloth-2': 10 }, { 'hide-2': 6 }).ok).toBe(true);
    expect(st.materials).toEqual({ 'cloth-2': 1, 'hide-2': 6 });
  });

  it('отказы — ДО траты: нет сырья, нет золота, неизвестное, эссенция', () => {
    for (const [bag, wallet, gold, from, to, n] of [
      [[], { 'iron-3': 8 }, 10_000, 'iron-3', 'wood', 9],
      [[], { 'iron-3': 9 }, 100, 'iron-3', 'wood', 9],
      [[], { 'iron-3': 9 }, 10_000, 'stave-3', 'wood', 9],
      [[], { [ESSENCE_ID]: 9 }, 10_000, ESSENCE_ID, 'wood', 9],
    ] as const) {
      const { save, st } = setup([...bag], { ...wallet }, gold);
      const snap = JSON.stringify([save, st]);
      const r = forgeExchange(reg, save, st, from, to, n, 10_000, { [from]: n }, {});
      expect(r.ok, `${from}→${to}`).toBe(false);
      expect(r.reason).toBeTruthy();
      expect(JSON.stringify([save, st]), `${from}→${to}: ничего не тронуто`).toBe(snap);
    }
  });

  it('⭐ согласие: золото, сырьё (у сервера обязательно) и выход карточки — иначе «Цена изменилась…» до траты', () => {
    for (const [maxGold, maxMaterials, minYield] of [
      [179, { 'iron-3': 9 }, { 'wood-3': 6 }],
      [180, {}, { 'wood-3': 6 }],
      [180, { 'iron-3': 8 }, { 'wood-3': 6 }],
      [180, { 'iron-3': 9 }, { 'wood-3': 7 }],
      [180, { 'iron-3': 9 }, { 'hide-3': 1 }],
    ] as const) {
      const { save, st } = setup([], { 'iron-3': 30 });
      const snap = JSON.stringify([save, st]);
      const r = forgeExchange(reg, save, st, 'iron-3', 'wood', 9, maxGold, { ...maxMaterials }, { ...minYield });
      expect(r.ok, JSON.stringify([maxGold, maxMaterials, minYield])).toBe(false);
      expect(r.reason!.startsWith(PRICE_CHANGED), r.reason).toBe(true);
      expect(JSON.stringify([save, st])).toBe(snap);
    }
  });
});

describe('⭐ «обменял и продал» невыгодно — при любом конфиге', () => {
  /** Продать стопку `n` штук `id` в лавке — настоящей ценой скупки. */
  const sell = (r: ConfigRegistry, id: string, n: number): number =>
    (n > 0 ? shopSellPrice(r, materialItem(r.get('craft-materials').find((m) => m.id === id)!, n, 'sell')) : 0);

  it('живой конфиг: каждая пара семей × сорт × количество — золото после «обмен → продажа» не больше, чем «продать отданное»', () => {
    const fams = [...new Set(defs.filter((m) => m.family !== 'ench').map((m) => m.family))];
    let n0 = 0;
    for (const a of fams) for (const b of fams) for (let g = 1; g <= 5; g++) for (const n of [2, 3, 9, 50, 200]) {
      if (a === b) continue;
      const q = exchangeQuote(reg, `${a}-${g}`, b, n);
      if (!q.ok) continue;
      const via = sell(reg, q.to, q.get) - q.gold;
      expect(via, `${a}-${g} → ${b} ×${n}`).toBeLessThanOrEqual(0);
      expect(via, `${a}-${g} → ${b} ×${n}: хуже, чем продать отданное`).toBeLessThan(sell(reg, q.from, q.spend));
      n0++;
    }
    expect(n0).toBeGreaterThan(500);
  });

  it('фазз конфигов в обход реестра: цены продажи 0…1000, золото за единицу 1…200, курс give ≥ get — то же', () => {
    const rng = createRng(20261006);
    for (let k = 0; k < 120; k++) {
      const d = structuredClone(defaultConfigData) as Record<string, unknown>;
      for (const m of d['craft-materials'] as { sellPrice: number }[]) m.sellPrice = rng.int(0, 1000);
      const give = rng.int(1, 6), get = rng.int(1, give);
      (d.balance as { forgePrices: { exchange: unknown } }).forgePrices.exchange = {
        enabled: true, give, get, goldPerUnit: [1, 2, 3, 4, 5].map(() => rng.int(1, 200)),
      };
      const r = new ConfigRegistry();
      r.loadAll(d, { cross: false });
      const ids = r.get('craft-materials').filter((m) => m.family !== 'ench').map((m) => m.id);
      for (let t = 0; t < 30; t++) {
        const from = rng.pick(ids);
        const to = rng.pick(['iron', 'wood', 'trim', 'hide', 'cloth', 'plate']);
        const n = rng.int(1, 400);
        const q = exchangeQuote(r, from, to, n);
        if (!q.ok) continue;
        expect(q.unitGold, 'за единицу не меньше её продажи').toBeGreaterThanOrEqual(r.get('craft-materials').find((m) => m.id === q.to)!.sellPrice);
        expect(sell(r, q.to, q.get) - q.gold, `${from}→${to} ×${n} (курс ${give}→${get})`).toBeLessThanOrEqual(0);
        expect(q.get * give, 'курс не щедрее заявленного').toBeLessThanOrEqual(q.spend * get);
        expect(exchangeUnitGold(r, q.grade, q.to)).toBe(q.unitGold);
      }
    }
  });

  it('туда-обратно теряет сырьё и платит дважды — петли нет', () => {
    const { save, st } = setup([], { 'iron-4': 300 }, 1_000_000);
    const units0 = availableMaterials(save.inventory, st.materials!);
    let gold = save.gold;
    for (let i = 0; i < 6; i++) {
      const have = (st.materials!['iron-4'] ?? 0);
      if (have >= 2) forgeExchange(reg, save, st, 'iron-4', 'wood', have, Number.MAX_SAFE_INTEGER, { 'iron-4': have }, {});
      const back = st.materials!['wood-4'] ?? 0;
      if (back >= 2) forgeExchange(reg, save, st, 'wood-4', 'iron', back, Number.MAX_SAFE_INTEGER, { 'wood-4': back }, {});
      expect(save.gold).toBeLessThan(gold);
      gold = save.gold;
    }
    const total = Object.values(st.materials!).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(units0['iron-4']!);
  });
});
