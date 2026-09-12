import { describe, it, expect } from 'vitest';
import { addToInventory, type Dims } from './grid.js';
import { materialItem, carriedMaterials, type MaterialDef } from '../economy/materials.js';
import type { Item } from '../types/items.js';

/**
 * ⭐ Ради ЭТОГО материалы и переехали из кошелька в сумку: разбор СЖИМАЕТ место. Кольчуга занимает
 * 6 клеток, а пластины с неё доливаются в существующий стек и не занимают ничего. Тесты стерегут
 * именно сжатие и то, что при полной сумке сырьё не исчезает молча.
 */

const IRON: MaterialDef = { id: 'iron-1', name: 'Ржавое железо', family: 'iron', tier: 1 };
const WOOD: MaterialDef = { id: 'wood-1', name: 'Трухлявое древко', family: 'wood', tier: 1 };
const dims: Dims = { cols: 4, rows: 2 };            // 8 клеток — легко упереться
let n = 0;
const uid = (): string => `m${n++}`;

describe('стек материала в сумке', () => {
  it('⭐ второй такой же материал НЕ занимает новую клетку', () => {
    const inv: Item[] = [];
    expect(addToInventory(inv, materialItem(IRON, 30, uid()), dims, 200)).toBe(true);
    expect(addToInventory(inv, materialItem(IRON, 45, uid()), dims, 200)).toBe(true);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.count).toBe(75);
  });

  it('разные материалы не смешиваются', () => {
    const inv: Item[] = [];
    addToInventory(inv, materialItem(IRON, 10, uid()), dims, 200);
    addToInventory(inv, materialItem(WOOD, 10, uid()), dims, 200);
    expect(inv).toHaveLength(2);
    expect(carriedMaterials(inv)).toEqual({ 'iron-1': 10, 'wood-1': 10 });
  });

  it('сверх предела стека заводится второй стек', () => {
    const inv: Item[] = [];
    addToInventory(inv, materialItem(IRON, 250, uid()), dims, 100);
    expect(inv).toHaveLength(3);                     // 100 + 100 + 50
    expect(carriedMaterials(inv)['iron-1']).toBe(250);
    for (const it of inv) expect(it.count).toBeLessThanOrEqual(100);
  });

  it('⚠ у уложенного стека количество НЕ обнуляется (ловушка, на которой я уже ошибся)', () => {
    const inv: Item[] = [];
    addToInventory(inv, materialItem(IRON, 137, uid()), dims, 200);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.count).toBe(137);                 // а не 0
    expect(carriedMaterials(inv)['iron-1']).toBe(137);
  });

  it('⚠ сумка полна: влезает частично, ОСТАТОК возвращается зовущему, а не пропадает', () => {
    const inv: Item[] = [];
    // Забиваем 8 клеток восемью разными стеками... но видов всего два, поэтому забьём вещами.
    for (let i = 0; i < 8; i++) {
      inv.push({ uid: `x${i}`, baseId: 'b', name: 'хлам', rarity: 'normal', itemLevel: 1,
        requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: { x: i % 4, y: Math.floor(i / 4) } } as Item);
    }
    const carrier = materialItem(IRON, 137, uid());
    expect(addToInventory(inv, carrier, dims, 200)).toBe(false);
    expect(carrier.count).toBe(137);                 // всё осталось у зовущего
    expect(inv).toHaveLength(8);                     // в сумку ничего не попало
  });

  it('⚠ частичная укладка: что влезло — в сумке, что нет — у зовущего', () => {
    const inv: Item[] = [];
    for (let i = 0; i < 7; i++) {
      inv.push({ uid: `x${i}`, baseId: 'b', name: 'хлам', rarity: 'normal', itemLevel: 1,
        requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: { x: i % 4, y: Math.floor(i / 4) } } as Item);
    }
    const carrier = materialItem(IRON, 250, uid());  // одна свободная клетка, стек 100
    expect(addToInventory(inv, carrier, dims, 100)).toBe(true);
    expect(carriedMaterials(inv)['iron-1']).toBe(100);
    expect(carrier.count).toBe(150);                 // остаток честно вернулся
  });

  it('долив идёт в НЕДОБИТЫЙ стек даже когда свободных клеток нет', () => {
    const inv: Item[] = [];
    addToInventory(inv, materialItem(IRON, 50, uid()), dims, 200);
    for (let i = 0; i < 7; i++) {
      inv.push({ uid: `x${i}`, baseId: 'b', name: 'хлам', rarity: 'normal', itemLevel: 1,
        requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: { x: (i + 1) % 4, y: Math.floor((i + 1) / 4) } } as Item);
    }
    const carrier = materialItem(IRON, 40, uid());
    expect(addToInventory(inv, carrier, dims, 200)).toBe(true);
    expect(carriedMaterials(inv)['iron-1']).toBe(90);
    expect(carrier.count).toBe(0);
  });

  it('⚠ обычные предметы стеками НЕ становятся — стек только у материала', () => {
    const inv: Item[] = [];
    const sword = (): Item => ({ uid: uid(), baseId: 'sword', name: 'Меч', kind: 'weapon', slot: 'weapon',
      rarity: 'normal', itemLevel: 1, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: null } as Item);
    addToInventory(inv, sword(), dims, 200);
    addToInventory(inv, sword(), dims, 200);
    expect(inv).toHaveLength(2);
  });
});
