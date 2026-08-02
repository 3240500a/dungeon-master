import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { moveInventoryItem, allocPassive, respecPassives, passiveInvestedGold, passiveRespecFee, passiveEntriesFor, allocActive, respecSkills, skillRespecFee, forgeUpgrade, forgeReroll } from './townActions.js';
import { createRng } from '../formulas/rng.js';
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

describe('forgeUpgrade / forgeReroll (авторитетная кузница)', () => {
  const price = reg.get('balance').forgePrices;
  const weapon = (uid: string): Item => ({
    uid, baseId: 'b', name: 'Меч', slot: 'weapon', rarity: 'normal', itemLevel: 5,
    requirements: {}, affixes: [], gridW: 1, gridH: 3, pos: null,
    baseStats: [{ kind: 'flat', stat: 'minDamage', value: 10 }, { kind: 'increased', stat: 'attackSpeed', value: 5 }],
  } as unknown as Item);

  it('улучшение: −золото, +20% плоским статам (мин +1), % не тронут, префикс ★', () => {
    const it = weapon('w');
    const save = { gold: 1000, inventory: [it] } as unknown as SaveState;
    expect(forgeUpgrade(reg, save, 'w').ok).toBe(true);
    expect(save.gold).toBe(1000 - price.upgradeTier);
    expect(it.baseStats[0]).toMatchObject({ kind: 'flat', value: 12 });        // 10 → round(12)
    expect(it.baseStats[1]).toMatchObject({ kind: 'increased', value: 5 });    // %-стат не меняем
    expect(it.name.startsWith('★')).toBe(true);
  });

  it('улучшение: мало золота → отказ, предмет и золото не тронуты', () => {
    const it = weapon('w');
    const save = { gold: price.upgradeTier - 1, inventory: [it] } as unknown as SaveState;
    expect(forgeUpgrade(reg, save, 'w').ok).toBe(false);
    expect(it.name).toBe('Меч');
    expect(save.gold).toBe(price.upgradeTier - 1);
  });

  it('реролл: −золото, перекатывает аффиксы (столько же)', () => {
    const it = weapon('w');
    const save = { gold: 1000, inventory: [it] } as unknown as SaveState;
    expect(forgeReroll(reg, save, 'w', createRng(1)).ok).toBe(true);
    expect(save.gold).toBe(1000 - price.rerollAffix);
    expect(Array.isArray(it.affixes)).toBe(true);   // пул мог дать 0/1 — но операция прошла и списала золото
  });

  it('нет предмета → отказ', () => {
    const save = { gold: 1000, inventory: [] } as unknown as SaveState;
    expect(forgeUpgrade(reg, save, 'nope').ok).toBe(false);
    expect(forgeReroll(reg, save, 'nope', createRng(1)).ok).toBe(false);
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

describe('respecSkills (сброс дерева скилов за золото)', () => {
  const skillSave = () => ({
    classId: 'warrior', level: 30, gold: 100000,
    unspentSkillPoints: 10, skills: {},
    hotbar: [null, null, null], mouseLeft: 'attack', mouseRight: null,
  } as unknown as SaveState);

  it('возвращает очки скиллов, берёт комиссию за вложенное очко, чистит дерево', () => {
    const tree = reg.get('skill-tree');
    const entry = tree.branches.find((b) => !b.classId)!.entryNode;
    const nb = tree.edges.flatMap(([a, b]) => (a === entry ? [b] : b === entry ? [a] : []))[0]!;
    const save = skillSave();
    expect(allocActive(reg, save, entry).ok).toBe(true);
    expect(allocActive(reg, save, nb).ok).toBe(true);   // 2 очка вложено
    const goldBefore = save.gold;
    const fee = skillRespecFee(reg, save);
    expect(fee).toBe(2 * reg.get('balance').skillRespecCostPerPoint);

    expect(respecSkills(reg, save).ok).toBe(true);
    expect(save.skills).toEqual({});
    expect(save.unspentSkillPoints).toBe(10);            // −2 вложено, +2 возврат
    expect(save.gold).toBe(goldBefore - fee);            // снята только комиссия
    expect(respecSkills(reg, save).ok).toBe(false);      // пусто — сбрасывать нечего
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
