import { describe, it, expect } from 'vitest';
import { packShopItems } from './shopGrid.js';
import type { Item } from '@dm/shared';

const mk = (uid: string, gridW: number, gridH: number): Item => ({ uid, gridW, gridH } as unknown as Item);

describe('packShopItems — раскладка магазина по размеру', () => {
  it('размещает все предметы без пересечений и в пределах ширины', () => {
    const items = [
      mk('a', 2, 4), mk('b', 1, 3), mk('c', 2, 3), mk('d', 1, 2), mk('e', 2, 4),
      mk('f', 1, 4), mk('g', 1, 3), mk('h', 1, 2), mk('i', 1, 3), mk('j', 2, 2),
    ];
    const cols = 11;
    const { placed, rows } = packShopItems(items, cols);
    expect(placed.length).toBe(items.length);
    const occ = new Map<string, string>();
    for (const { it, x, y } of placed) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + it.gridW).toBeLessThanOrEqual(cols);              // в пределах ширины
      for (let dy = 0; dy < it.gridH; dy++) for (let dx = 0; dx < it.gridW; dx++) {
        const key = `${x + dx},${y + dy}`;
        expect(occ.has(key)).toBe(false);                         // без пересечений
        occ.set(key, it.uid);
        expect(y + dy).toBeLessThan(rows);                        // rows покрывает все клетки
      }
    }
  });

  it('предмет шире сетки — не выходит за левый край (x=0)', () => {
    const { placed } = packShopItems([mk('big', 20, 1)], 5);
    expect(placed[0]!.x).toBe(0);
  });

  it('пустой список → 0 рядов', () => {
    expect(packShopItems([], 11)).toEqual({ placed: [], rows: 0 });
  });
});
