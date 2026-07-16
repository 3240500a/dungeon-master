import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { moveInventoryItem, allocPassive, respecPassives, passiveInvestedGold, passiveRespecFee, passiveEntriesFor } from './townActions.js';
import type { Item, SaveState } from '../types/index.js';

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })(); // сетка 10×6

function mkItem(uid: string, gridW: number, gridH: number, x: number, y: number): Item {
  return {
    uid, baseId: 'b', name: uid, slot: 'chest', rarity: 'normal', itemLevel: 1,
    requirements: {}, affixes: [], baseStats: [], gridW, gridH, pos: { x, y },
  };
}
const saveWith = (...items: Item[]): SaveState => ({ inventory: items } as unknown as SaveState);

describe('moveInventoryItem (авторитетная перекладка инвентаря)', () => {
  it('в пустую клетку — кладёт', () => {
    const a = mkItem('a', 1, 1, 0, 0);
    expect(moveInventoryItem(reg, saveWith(a), 'a', 5, 3).ok).toBe(true);
    expect(a.pos).toEqual({ x: 5, y: 3 });
  });

  it('ровно на один предмет — обмен местами', () => {
    const a = mkItem('a', 1, 1, 0, 0);
    const b = mkItem('b', 1, 1, 5, 3);
    expect(moveInventoryItem(reg, saveWith(a, b), 'a', 5, 3).ok).toBe(true);
    expect(a.pos).toEqual({ x: 5, y: 3 });
    expect(b.pos).toEqual({ x: 0, y: 0 }); // вытесненный уехал на старое место a
  });

  it('на 2+ предмета — отказ (позиции не тронуты)', () => {
    const a = mkItem('a', 2, 1, 0, 0);
    const b = mkItem('b', 1, 1, 5, 3);
    const c = mkItem('c', 1, 1, 6, 3);
    expect(moveInventoryItem(reg, saveWith(a, b, c), 'a', 5, 3).ok).toBe(false);
    expect(a.pos).toEqual({ x: 0, y: 0 });
  });

  it('за границей сетки — отказ', () => {
    const a = mkItem('a', 2, 1, 0, 0);
    expect(moveInventoryItem(reg, saveWith(a), 'a', 9, 0).ok).toBe(false); // 9+2 > 10
  });

  it('нет такого предмета — отказ', () => {
    expect(moveInventoryItem(reg, saveWith(), 'nope', 0, 0).ok).toBe(false);
  });
});

describe('respecPassives (сброс пассивов за золото)', () => {
  it('возвращает очки, берёт комиссию, вложенное золото НЕ возвращает', () => {
    const tree = reg.get('mastery-tree');
    const entry = tree.entryNodes[0]!;
    const nb = (() => { for (const [a, b] of tree.edges) { if (a === entry) return b; if (b === entry) return a; } return entry; })();
    const save = { gold: 100000, unspentMasteryPoints: 10, masteries: {} } as unknown as SaveState;

    expect(allocPassive(reg, save, entry).ok).toBe(true);
    expect(allocPassive(reg, save, nb).ok).toBe(true);
    const goldAfterAlloc = save.gold;
    const invested = passiveInvestedGold(reg, save);
    const fee = passiveRespecFee(reg, save);
    expect(fee).toBe(Math.round(invested * reg.get('balance').passiveRespecCostPct));

    expect(respecPassives(reg, save).ok).toBe(true);
    expect(save.masteries).toEqual({});
    expect(save.unspentMasteryPoints).toBe(10);          // −2 вложено, +2 возврат
    expect(save.gold).toBe(goldAfterAlloc - fee);        // вложенное не вернулось, снята только комиссия
    expect(respecPassives(reg, save).ok).toBe(false);    // пусто — сбрасывать нечего
  });
});

describe('входы дерева мастерства — все доступны всем (класс-гейт снят в Ф6)', () => {
  const mk = (classId: string) => ({ classId, gold: 5000, unspentMasteryPoints: 5, masteries: {} } as unknown as SaveState);

  it('любой класс может начать с любого входа', () => {
    const tree = reg.get('mastery-tree');
    expect(passiveEntriesFor(reg, mk('mage'))).toEqual(tree.entryNodes);
    // раньше «чужой» вход был закрыт — теперь открыт всем.
    expect(allocPassive(reg, mk('mage'), 'p-str').ok).toBe(true);
    expect(allocPassive(reg, mk('warrior'), 'p-int').ok).toBe(true);
  });

  it('без класса — тоже все входы', () => {
    const nobody = { gold: 5000, unspentMasteryPoints: 5, masteries: {} } as unknown as SaveState;
    const tree = reg.get('mastery-tree');
    expect(passiveEntriesFor(reg, nobody)).toEqual(tree.entryNodes);
    expect(allocPassive(reg, nobody, tree.entryNodes[0]!).ok).toBe(true);
  });
});
