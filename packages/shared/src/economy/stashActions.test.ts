import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { stashMove, sanitizeStash, emptyStash, migrateWalletToStash } from './stashActions.js';
import { availableMaterials, spendBoth } from './materials.js';
import { emptyJournal } from '../formulas/craft.js';
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

  it('D1: новый и старый сундук получают ПУСТОЙ журнал кузнеца и пустой список ключей', () => {
    for (const s of [emptyStash(reg), sanitizeStash(reg, stashWith())]) {
      expect(s.forgeJournal).toEqual(emptyJournal());
      expect(s.craftNonces).toEqual([]);
    }
  });

  it('⚠ D1: мусор из базы в журнале и ключах чистится, а не доезжает до ковки', () => {
    const raw = {
      version: 1, tabs: [],
      forgeJournal: {
        bases: ['long-sword', 7, null, 'long-sword', { x: 1 }, ''], variants: 'sw-a-x', tierHi: 'max',
        classSalvages: JSON.parse('{"sword":3,"axe":-2,"mace":"x","__proto__":1,"constructor":2,"a b":4,"bow":2.7}'), sketches: -1, mythic: Number.NaN,
        typesSeen: [['nested']], typesForged: ['t1', 't1'], extra: 'кто-то дописал',
      },
      craftNonces: [
        { n: 'nonce-aaaa', uid: 'u1' }, { n: 'bad', uid: 'u2' }, { n: 'nonce-bbbb', uid: 5 }, 'nonce-cccc', null,
        { n: 'nonce-dddd', uid: 'u4', extra: 1 }, { n: 'nonce-aaaa', uid: 'u1-again' },
        ...Array.from({ length: 40 }, (_, i) => ({ n: `bulk-${String(i).padStart(4, '0')}`, uid: `b${i}` })),
      ],
    } as unknown as AccountStash;
    const s = sanitizeStash(reg, raw);
    const j = s.forgeJournal!;
    expect(j.bases).toEqual(['long-sword']);
    expect(j.variants).toEqual([]);
    expect(j.tierHi).toBe(-1);
    expect(j.classSalvages).toEqual({ sword: 3, bow: 2 });
    expect(j.sketches).toBe(0);
    expect(j.mythic).toBe(0);
    expect(j.typesSeen).toEqual([]);
    expect(j.typesForged).toEqual(['t1']);
    expect(Object.keys(j).sort()).toEqual(Object.keys(emptyJournal()).sort());
    expect(s.craftNonces).toHaveLength(32);
    expect(s.craftNonces!.every((e) => Object.keys(e).sort().join() === 'n,uid' && typeof e.uid === 'string')).toBe(true);
    expect(s.craftNonces!.at(-1)).toEqual({ n: 'bulk-0039', uid: 'b39' });
    expect(s.craftNonces!.some((e) => e.n === 'bad' || e.n === 'nonce-bbbb')).toBe(false);
    // Журнал и ключи не того типа целиком — пустые, без исключения.
    for (const junk of [null, 5, 'x', [], [1, 2]]) {
      const t = sanitizeStash(reg, { version: 1, tabs: [], forgeJournal: junk, craftNonces: junk } as unknown as AccountStash);
      expect(t.forgeJournal).toEqual(emptyJournal());
      expect(t.craftNonces).toEqual([]);
    }
  });

  it('⚠ кошелёк сырья: отрицательное, NaN, дробное и ключи-ловушки не переживают загрузку', () => {
    const wallet = JSON.parse('{"iron-1": 5, "iron-2": -3, "iron-3": "7", "wood-1": 2.9, "wood-2": 0, "__proto__": 9}') as Record<string, number>;
    wallet['hide-1'] = Number.NaN;
    const keep = wallet;
    const s = sanitizeStash(reg, { version: 1, tabs: [], materials: wallet });
    expect(s.materials).toBe(keep);   // чистится на месте — ссылку могли держать
    expect({ ...s.materials }).toEqual({ 'iron-1': 5, 'wood-1': 2 });
    expect(sanitizeStash(reg, { version: 1, tabs: [], materials: [] as unknown as Record<string, number> }).materials).toEqual({});
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

describe('кошелёк сырья живёт на АККАУНТЕ', () => {
  const heroWith = (mats: Record<string, number>): SaveState =>
    ({ inventory: [], materials: mats } as unknown as SaveState);

  it('⭐ два героя одного аккаунта видят ОДИН запас, и трата одним видна другому', () => {
    const stash = emptyStash(reg);
    stash.materials = { 'iron-1': 100 };
    const a = heroWith({});
    const b = heroWith({});

    expect(availableMaterials(a.inventory, stash.materials)['iron-1']).toBe(100);
    expect(availableMaterials(b.inventory, stash.materials)['iron-1']).toBe(100);

    // Герой A кует. Кошелёк один, поэтому у героя B запас обязан УМЕНЬШИТЬСЯ.
    expect(spendBoth(a.inventory, stash.materials, { 'iron-1': 30 })).toBe(true);
    expect(availableMaterials(b.inventory, stash.materials)['iron-1']).toBe(70);
  });

  it('⚠ старый персонажный кошелёк вливается РОВНО ОДИН раз', () => {
    const stash = emptyStash(reg);
    const save = heroWith({ 'iron-1': 40, 'wood-2': 5 });

    expect(migrateWalletToStash(save, stash)).toBe(true);
    expect(stash.materials).toEqual({ 'iron-1': 40, 'wood-2': 5 });

    // Повторный вход в игру не должен задваивать: сейв уже опустошён.
    expect(migrateWalletToStash(save, stash)).toBe(false);
    expect(migrateWalletToStash(save, stash)).toBe(false);
    expect(stash.materials).toEqual({ 'iron-1': 40, 'wood-2': 5 });
    expect(save.materials).toEqual({});
  });

  it('второй герой аккаунта доливает в тот же кошелёк, а не затирает его', () => {
    const stash = emptyStash(reg);
    migrateWalletToStash(heroWith({ 'iron-1': 40 }), stash);
    migrateWalletToStash(heroWith({ 'iron-1': 7, 'wood-1': 3 }), stash);
    expect(stash.materials).toEqual({ 'iron-1': 47, 'wood-1': 3 });
  });

  it('пустой кошелёк не считается миграцией (иначе запись в БД на каждый вход)', () => {
    expect(migrateWalletToStash(heroWith({}), emptyStash(reg))).toBe(false);
    expect(migrateWalletToStash({ inventory: [] } as unknown as SaveState, emptyStash(reg))).toBe(false);
  });
});
