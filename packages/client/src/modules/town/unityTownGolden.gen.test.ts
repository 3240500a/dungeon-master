/**
 * ПРОДЮСЕР golden-эталона ГОРОДА для Unity-клиента (R2-35, R2-36). На каждом `npm test` перегенерирует
 * `__golden__/unity_town.json` из ТЕКУЩЕГО веб-кода (веб = источник истины), как эталон походки. Unity сверяет с
 * ним свои порты: цену скупки лавкой (`DmItem.SellPrice` ≡ `shopSellPrice`) и «куда ляжет брошенный предмет»
 * (`DmHeld.DropCell` ≡ `heldItem.dropCell`). Меню Unity: DM ▸ Verify Town Parity. Правили веб осознанно — эталон
 * обновится здесь, потом скопировать в Assets/DM/UI/Tests/unity_town_golden.json.
 * Цену ПОКУПКИ Unity не считает вовсе — её шлёт сервер в кадре `shop` (`prices`), сверять нечего.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ConfigRegistry, createRng, generateItem, itemFromBaseId, materialItem, newCharacterSave, parseTownCommand, shopSellPrice, stashDims,
  upgradedItem, type Item,
} from '@dm/shared';
import { dropCell } from '../inventory/heldItem.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

/** Вещи для цены скупки: все ступени × редкости, уник, зелье, сырьё разной длины стека и без счётчика, стартовый комплект (R5-23). */
function sellItems(): Item[] {
  const out: Item[] = [];
  const bal = reg.get('balance');
  const weapons = reg.get('items.base').filter((b) => b.kind === 'weapon' && b.enabled !== false);
  const armor = reg.get('items.base').filter((b) => b.kind === 'armor' && b.enabled !== false);
  let seed = 1;
  for (const tier of reg.get('item-tiers')) {
    for (const rarity of ['normal', 'magic', 'rare', 'unique'] as const) {
      for (const pool of [weapons, armor]) {
        const lvl = tier.minItemLevel + 2;
        const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
          dropBias: 1, itemLevel: lvl, tierLevel: lvl, baseId: pool[seed % pool.length]!.id, tiers: reg.get('item-tiers'),
          rarities: reg.get('rarities'), forceRarity: rarity, maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
        }, createRng(seed++));
        out.push(it);
      }
    }
  }
  const potion = itemFromBaseId(reg.get('items.base'), 'healing-potion', undefined, 'shop');
  if (potion) out.push(potion);
  const mats = reg.get('craft-materials');
  for (const [i, m] of [mats[0]!, mats[7]!, mats.at(-1)!].entries()) {
    for (const n of [1, 7, 50]) out.push(materialItem(m, n, `mat-${i}-${n}`));
  }
  const noCount = materialItem(mats[3]!, 1, 'mat-nocount') as Item & { count?: number };
  delete noCount.count;
  out.push(noCount);
  // ⭐ R5-23: стартовый комплект КАЖДОГО класса — нетронутый (`origin: 'start'`, лавка берёт за 1: R3-04) и оружие,
  // поднятое у кузнеца (`tierForged`, цена по формуле: R4-34). Без них сверка Unity не видела правила комплекта вовсе.
  let forged = false;
  for (const cls of reg.get('classes').filter((c) => c.enabled !== false)) {
    const kit = newCharacterSave(reg, cls.id, 'golden', 'golden');
    for (const it of [...Object.values(kit.equipment), ...kit.inventory]) if (it) out.push(it);
    const up = !forged && kit.equipment.weapon ? upgradedItem(reg, kit.equipment.weapon) : undefined;
    if (up) { out.push(up); forged = true; }
  }
  // uid — постоянный: эталон не должен меняться от прогона к прогону.
  return out.map((it, i) => ({ ...it, uid: `golden-${i}` }));
}

/** Броски предмета: размеры × точки захвата × клетки у краёв сумки и вкладки сундука. */
function dropCases(): { cols: number; rows: number; w: number; h: number; grabOx: number; grabOy: number; col: number; row: number; cell: { x: number; y: number } | null }[] {
  const out = [];
  const bag = reg.get('balance').inventory;
  for (const dims of [{ cols: bag.cols, rows: bag.rows }, stashDims(reg)]) {
    const cols = [0, 1, dims.cols - 2, dims.cols - 1], rows = [0, 1, dims.rows - 2, dims.rows - 1];
    for (const [w, h] of [[1, 1], [1, 2], [2, 2], [2, 3], [1, 4]] as const) {
      for (let gx = 0; gx < w; gx++) for (let gy = 0; gy < h; gy++) {
        for (const col of cols) for (const row of rows) {
          out.push({ cols: dims.cols, rows: dims.rows, w, h, grabOx: gx, grabOy: gy, col, row, cell: dropCell({ gridW: w, gridH: h }, gx, gy, col, row, dims) });
        }
      }
    }
  }
  return out;
}

describe('unityTownGolden — продюсер эталона (пишет __golden__/unity_town.json)', () => {
  it('генерит эталон цены скупки и бросков и пишет на диск', () => {
    const sell = sellItems().map((item) => ({ item, price: shopSellPrice(reg, item) }));
    expect(sell.length).toBeGreaterThan(50);
    expect(sell.every((c) => Number.isInteger(c.price) && c.price >= 1)).toBe(true);
    expect(sell.some((c) => c.item.kind === 'material' && c.price > 7), 'сырьё — поштучно, а не «7 за стек»').toBe(true);
    // ⭐ R5-23: стартовый комплект — за 1 (R3-04), а поднятый у кузнеца — уже по формуле (R4-34). Без этих вещей в эталоне
    // Unity показывал «+7» за нетронутый комплект, а сервер платил 1, и сверка паритета этого не видела.
    expect(sell.some((c) => c.item.origin === 'start' && !c.item.tierForged && c.price === 1), 'нетронутый стартовый комплект').toBe(true);
    expect(sell.some((c) => c.item.origin === 'start' && c.item.tierForged && c.price > 1), 'комплект, поднятый у кузнеца').toBe(true);
    const drop = dropCases();
    expect(drop.some((c) => c.cell === null) && drop.some((c) => c.cell !== null)).toBe(true);
    // Каждая клетка, которую dropCell разрешает, проходит строгую схему сервера (R2-35).
    for (const c of drop) if (c.cell) expect(parseTownCommand({ cmd: 'moveItem', uid: 'u', ...c.cell }).ok).toBe(true);
    const golden = {
      note: 'Эталон паритета Unity ↔ веб для города (R2-35, R2-36). Генерит packages/client/src/modules/town/unityTownGolden.gen.test.ts.',
      // Ровно те разделы /api/config, которые читает порт цены: множитель редкости и цена сырья поштучно.
      config: {
        rarities: reg.get('rarities').map((r) => ({ id: r.id, priceMult: r.priceMult })),
        'craft-materials': reg.get('craft-materials').map((m) => ({ id: m.id, sellPrice: m.sellPrice })),
      },
      sell,
      drop,
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unity_town.json'), JSON.stringify(golden));
  });
});
