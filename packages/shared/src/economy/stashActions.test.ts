import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { stashMove, sanitizeStash, emptyStash } from './stashActions.js';
import type { AccountStash, Item, SaveState } from '../types/index.js';

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })(); // инв 10×6, сундук 2×(20×12)

function mkItem(uid: string, gridW: number, gridH: number, x: number, y: number): Item {
  return {
    uid, baseId: 'b', name: uid, slot: 'chest', rarity: 'normal', itemLevel: 1,
    requirements: {}, affixes: [], baseStats: [], gridW, gridH, pos: { x, y },
  };
}
const saveWith = (...items: Item[]): SaveState => ({ inventory: items } as unknown as SaveState);
const stashWith = (...tabs: Item[][]): AccountStash => ({ version: 1, tabs });

describe('sanitizeStash', () => {
  it('добивает вкладки до конфигурного числа (2) и не теряет предметы', () => {
    const s = sanitizeStash(reg, stashWith([mkItem('a', 1, 1, 0, 0)]));
    expect(s.tabs.length).toBe(2);
    expect(s.tabs[0]!.map((i) => i.uid)).toEqual(['a']);
  });
  it('лечит наложенные позиции внутри вкладки (packInventory)', () => {
    const a = mkItem('a', 1, 1, 0, 0);
    const b = mkItem('b', 1, 1, 0, 0); // конфликт
    sanitizeStash(reg, stashWith([a, b]));
    expect(a.pos).not.toEqual(b.pos);
  });
  it('emptyStash даёт нужное число пустых вкладок', () => {
    expect(emptyStash(reg).tabs.length).toBe(2);
  });
});

describe('stashMove', () => {
  it('депозит инвентарь → вкладка (свободно)', () => {
    const a = mkItem('a', 1, 1, 0, 0);
    const save = saveWith(a);
    const stash = emptyStash(reg);
    expect(stashMove(reg, save, stash, 'a', 0, 3, 4).ok).toBe(true);
    expect(save.inventory.find((i) => i.uid === 'a')).toBeUndefined();
    expect(stash.tabs[0]!.find((i) => i.uid === 'a')?.pos).toEqual({ x: 3, y: 4 });
  });

  it('забор вкладка → инвентарь', () => {
    const a = mkItem('a', 1, 1, 2, 2);
    const save = saveWith();
    const stash = stashWith([a], []);
    expect(stashMove(reg, save, stash, 'a', 'inv', 1, 1).ok).toBe(true);
    expect(stash.tabs[0]!.length).toBe(0);
    expect(save.inventory.find((i) => i.uid === 'a')?.pos).toEqual({ x: 1, y: 1 });
  });

  it('свап внутри вкладки (вытеснение одного)', () => {
    const a = mkItem('a', 1, 1, 0, 0);
    const b = mkItem('b', 1, 1, 5, 5);
    const stash = stashWith([a, b], []);
    expect(stashMove(reg, saveWith(), stash, 'a', 0, 5, 5).ok).toBe(true);
    expect(a.pos).toEqual({ x: 5, y: 5 });
    expect(b.pos).toEqual({ x: 0, y: 0 });
  });

  it('перенос между вкладками', () => {
    const a = mkItem('a', 1, 1, 0, 0);
    const stash = stashWith([a], []);
    expect(stashMove(reg, saveWith(), stash, 'a', 1, 4, 4).ok).toBe(true);
    expect(stash.tabs[0]!.length).toBe(0);
    expect(stash.tabs[1]!.find((i) => i.uid === 'a')?.pos).toEqual({ x: 4, y: 4 });
  });

  it('через границу контейнеров занято — отказ, источник не тронут', () => {
    const a = mkItem('a', 1, 1, 0, 0);      // в инвентаре
    const b = mkItem('b', 1, 1, 4, 4);      // во вкладке 0
    const save = saveWith(a);
    const stash = stashWith([b], []);
    expect(stashMove(reg, save, stash, 'a', 0, 4, 4).ok).toBe(false);
    expect(save.inventory.find((i) => i.uid === 'a')).toBeDefined(); // остался в инвентаре
    expect(stash.tabs[0]!.length).toBe(1);
  });

  it('выход за границу вкладки (20×12) — отказ', () => {
    const a = mkItem('a', 2, 1, 0, 0);
    expect(stashMove(reg, saveWith(a), emptyStash(reg), 'a', 0, 19, 0).ok).toBe(false); // 19+2 > 20
  });

  it('нет такого предмета — отказ', () => {
    expect(stashMove(reg, saveWith(), emptyStash(reg), 'nope', 0, 0, 0).ok).toBe(false);
  });
});
