import { describe, it, expect } from 'vitest';
import type { Item } from '@dm/shared';
import { cellFree, findFree, packInventory, addToInventory, hasSpace, placeWithDisplacement, type Dims } from './grid.js';

const dims: Dims = { cols: 10, rows: 6 };

function item(uid: string, w: number, h: number, x?: number, y?: number): Item {
  return {
    uid, baseId: 'b', name: uid, slot: 'chest', rarity: 'normal', itemLevel: 1,
    requirements: {}, affixes: [], baseStats: [], gridW: w, gridH: h,
    pos: x === undefined ? null : { x, y: y! },
  };
}

describe('inventory grid', () => {
  it('cellFree учитывает границы и пересечения', () => {
    const items = [item('a', 2, 2, 0, 0)];
    expect(cellFree(items, 0, 0, 1, 1, dims)).toBe(false); // занято a
    expect(cellFree(items, 2, 0, 1, 1, dims)).toBe(true);
    expect(cellFree(items, 9, 0, 2, 1, dims)).toBe(false); // за границей
  });

  it('findFree находит первое свободное место', () => {
    const items = [item('a', 2, 2, 0, 0)];
    expect(findFree(items, 2, 2, dims)).toEqual({ x: 2, y: 0 });
  });

  it('packInventory раскладывает без пересечений', () => {
    const items = [item('a', 2, 3), item('b', 2, 3), item('c', 1, 3)];
    packInventory(items, dims);
    for (const it of items) expect(it.pos).not.toBeNull();
    // Никакие два не пересекаются.
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!; const b = items[j]!;
        const inter = a.pos!.x < b.pos!.x + b.gridW && a.pos!.x + a.gridW > b.pos!.x &&
          a.pos!.y < b.pos!.y + b.gridH && a.pos!.y + a.gridH > b.pos!.y;
        expect(inter).toBe(false);
      }
  });

  it('addToInventory кладёт в свободное место, false если нет', () => {
    const items: Item[] = [];
    expect(addToInventory(items, item('a', 10, 6), dims)).toBe(true);
    expect(hasSpace(items, 1, 1, dims)).toBe(false);
    expect(addToInventory(items, item('b', 1, 1), dims)).toBe(false);
  });

  it('placeWithDisplacement: шлем 2x2 на жезл 1x2 вытесняет жезл', () => {
    const helm = item('helm', 2, 2, 5, 0); // где-то справа
    const wand = item('wand', 1, 2, 0, 0); // цель: 0,0..0,1
    const items = [helm, wand];
    // Кладём шлем в (0,0): он накрывает жезл (0,0-0,1) + пустые (1,0-1,1).
    expect(placeWithDisplacement(items, helm, 0, 0, dims)).toBe(true);
    expect(helm.pos).toEqual({ x: 0, y: 0 });
    // Жезл вытеснен на старую позицию шлема (5,0), помещается.
    expect(wand.pos).toEqual({ x: 5, y: 0 });
    // Никаких пересечений.
    expect(cellFree(items, helm.pos!.x, helm.pos!.y, 2, 2, dims, helm.uid)).toBe(true);
  });

  it('placeWithDisplacement: за границей — false, позиции не тронуты', () => {
    const a = item('a', 2, 2, 0, 0);
    const items = [a];
    expect(placeWithDisplacement(items, a, 9, 0, dims)).toBe(false); // 9+2>10
    expect(a.pos).toEqual({ x: 0, y: 0 });
  });

  it('placeWithDisplacement: 2+ предмета под целью — false', () => {
    const a = item('a', 2, 1, 4, 0);
    const b = item('b', 1, 1, 0, 0);
    const c = item('c', 1, 1, 1, 0);
    const items = [a, b, c];
    expect(placeWithDisplacement(items, a, 0, 0, dims)).toBe(false); // накрывает b и c
    expect(a.pos).toEqual({ x: 4, y: 0 });
  });
});
