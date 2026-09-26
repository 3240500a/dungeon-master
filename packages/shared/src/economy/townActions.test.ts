import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { allocAttr, respec, attrRespecRefund, forgeGold, moveInventoryItem, allocPassive, respecPassives, passiveInvestedGold, passiveRespecFee, passiveEntriesFor, allocActive, respecSkills, skillRespecFee, forgeUpgrade, forgeReroll, forgeSalvage, forgeRepair, fieldSalvage, upgradeCost, repairCost, upgradedItem, nextTierOf, equip, unequip, socketInsert, socketClear } from './townActions.js';
import { newCharacterSave } from './newCharacter.js';
import { emptyStash } from './stashActions.js';
import { createRng } from '../formulas/rng.js';
import { carriedMaterials } from './materials.js';
import { generateItem, itemFromBaseId } from '../formulas/itemgen.js';
import { shapeFoundWeapon } from '../formulas/craft.js';
import type { Item, SaveState } from '../types/index.js';

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })(); // сетка 10×6
/**
 * Кошелёк СУНДУКА АККАУНТА — с ч7 сырьё живёт здесь, а не в сейве персонажа.
 * Сбрасывается перед каждым тестом: общий изменяемый объект между тестами — классическая течь.
 */
let wallet: Record<string, number> = {};
beforeEach(() => { wallet = { 'iron-1': 99, 'iron-2': 99, 'iron-3': 99, 'wood-1': 99, 'wood-2': 99, 'plate-1': 99 }; });

function mkItem(uid: string, gridW: number, gridH: number, x: number, y: number): Item {
  return {
    uid, baseId: 'b', name: uid, slot: 'chest', rarity: 'normal', itemLevel: 1,
    requirements: {}, affixes: [], baseStats: [], gridW, gridH, pos: { x, y },
  };
}
const saveWith = (...items: Item[]): SaveState => ({ inventory: items } as unknown as SaveState);
/** Вещь в сумке по uid — ПОСЛЕ улучшения это новый объект (D14), старая ссылка его не видит. */
const inBag = (save: SaveState, uid: string): Item => save.inventory.find((i) => i.uid === uid)!;

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
  // ⚠ База НАСТОЯЩАЯ: цена улучшения берёт семью материала из правила разбора этой базы,
  // а правило ищется по классу оружия, которого у выдуманного `baseId` нет.
  const swordBase = reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'sword')!;
  const weapon = (uid: string, rarity: Item['rarity'] = 'normal'): Item => ({
    uid, baseId: swordBase.id, name: 'Меч', kind: 'weapon', slot: 'weapon', rarity, itemLevel: 5,
    requirements: {}, affixes: [], gridW: 1, gridH: 3, pos: null,
    baseStats: [{ kind: 'flat', stat: 'minDamage', value: 10 }, { kind: 'increased', stat: 'attackSpeed', value: 5 }],
  } as unknown as Item);
  /** Кошелёк, которого заведомо хватает на любое улучшение. */
  const rich = (): Record<string, number> => ({ 'iron-1': 99, 'iron-2': 99, 'iron-3': 99, 'iron-4': 99, 'iron-5': 99 });

  /** Настоящий предмет из конвейера генерации — у выдуманного нет ни тира, ни базовых статов. */
  const rolled = (ilvl: number, rarity: Item['rarity'] = 'normal'): Item => generateItem(
    reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
    { dropBias: 1, itemLevel: ilvl, baseId: swordBase.id, tiers: reg.get('item-tiers'),
      rarities: reg.get('rarities'), forceRarity: rarity, maxReqTotal: reg.get('balance').maxTotalRequirement },
    createRng(1));

  it('⭐ улучшение поднимает ТИР на ступень, а не множит статы', () => {
    const it = rolled(1);
    expect(it.tier).toBe('t0');
    const save = { gold: 1000, inventory: [it], materials: rich() } as unknown as SaveState;
    // ⚠ Цена больше НЕ плоская (база × reqMult ступени × priceMult редкости) и снимается ДО
    // улучшения: после него `it` уже на следующей ступени, и `forgeGold` вернул бы цену ДРУГОГО шага.
    const paid = forgeGold(reg, it, 'upgrade');
    expect(forgeUpgrade(reg, save, it.uid, wallet).ok).toBe(true);
    // D14: улучшение ЗАМЕНЯЕТ объект в сумке — смотрим на то, что лежит там теперь.
    const up = inBag(save, it.uid);
    expect(up.tier).toBe('t1');
    expect(save.gold).toBe(1000 - paid);
    expect(wallet['iron-1']).toBe(99 - price.upgradeMaterials.tier1);
    // Имя обновилось приставкой нового тира, а не украсилось звёздочкой.
    const t1 = reg.get('item-tiers').find((t) => t.id === 't1')!;
    expect(up.name.startsWith(t1.name)).toBe(true);
  });

  it('⭐ кузнечный тир РАВЕН найденному по статам, но ЛЕГЧЕ по требованиям', () => {
    const forged = rolled(1);
    const save = { gold: 1000, inventory: [forged], materials: rich() } as unknown as SaveState;
    expect(forgeUpgrade(reg, save, forged.uid, wallet).ok).toBe(true);
    const up = inBag(save, forged.uid);
    const found = rolled(8); // тот же t1, но с пола
    expect(found.tier).toBe('t1');
    const dmg = (i: Item): number => i.baseStats.filter((m) => m.kind === 'flat').reduce((a, m) => a + m.value, 0);
    expect(dmg(up)).toBe(dmg(found));                        // сила одинаковая — иначе тир ничего не значит
    const req = (i: Item): number => Object.values(i.requirements).reduce((a, b) => a + (b ?? 0), 0);
    expect(req(up)).toBeLessThan(req(found));                // а носится раньше — в этом смысл крафта
  });

  it('⚠ выше потолка базы не поднять — лестница конечна по построению', () => {
    const it = rolled(1);
    const save = { gold: 10_000_000, inventory: [it], materials: { 'iron-1': 9999, 'iron-2': 9999, 'iron-3': 9999, 'iron-4': 9999, 'iron-5': 9999 } } as unknown as SaveState;
    let steps = 0;
    // ⚠ Кошелёк отдельный и заведомо бездонный: мечу открыты все шесть ступеней, и на общем
    // кошельке теста улучшения кончались не по потолку базы, а по сырью.
    const deep: Record<string, number> = Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 9999]));
    while (forgeUpgrade(reg, save, it.uid, deep).ok && steps < 50) steps++;
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(20);                          // упёрлись, а не крутили бесконечно
    expect(inBag(save, it.uid).tier).toBe(swordBase.maxTier);
    expect(forgeUpgrade(reg, save, it.uid, deep).reason).toContain('Лучше');
  });

  it('⚠ перекатка КОНЕЧНА: предел из конфига', () => {
    const it = rolled(30, 'magic');   // у обычной перекатывать нечего (R2-13) — предел мерить не на чем
    const save = { gold: 1_000_000, inventory: [it] } as unknown as SaveState;
    let n = 0;
    while (forgeReroll(reg, save, it.uid, createRng(n + 1)).ok && n < 50) n++;
    expect(n).toBe(price.rerollLimit);
    expect(it.rerolls).toBe(price.rerollLimit);
  });

  it('улучшение: мало золота → отказ, предмет, золото и материалы не тронуты', () => {
    const it = weapon('w');
    const need = forgeGold(reg, it, 'upgrade');
    const save = { gold: need - 1, inventory: [it], materials: rich() } as unknown as SaveState;
    expect(forgeUpgrade(reg, save, 'w', wallet).ok).toBe(false);
    expect(it.name).toBe('Меч');
    expect(save.gold).toBe(need - 1);
    expect(wallet['iron-1']).toBe(99);
  });

  it('⚠ мало материалов → отказ, и ЗОЛОТО ТОЖЕ не списано', () => {
    const it = weapon('w');
    const save = { gold: 1000, inventory: [it] } as unknown as SaveState;
    wallet = { 'iron-1': 1 };                   // в сундуке почти пусто, в сумке сырья нет
    const r = forgeUpgrade(reg, save, 'w', wallet);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('материалов');
    expect(save.gold).toBe(1000);              // отказ на середине не должен обирать игрока
    expect(wallet['iron-1']).toBe(1);
    expect(it.name).toBe('Меч');
  });

  it('⭐ лестница цены: обычная — ржавое, магическая — и чистое, редкая — и калёное', () => {
    expect(Object.keys(upgradeCost(reg, weapon('a', 'normal')))).toEqual(['iron-1']);
    expect(Object.keys(upgradeCost(reg, weapon('b', 'magic')))).toEqual(['iron-1', 'iron-2']);
    expect(Object.keys(upgradeCost(reg, weapon('c', 'rare')))).toEqual(['iron-1', 'iron-2', 'iron-3']);
    // ⚠ количество первой ступени ОДНО И ТО ЖЕ у всех: ржавое — базовая валюта крафта
    expect(upgradeCost(reg, weapon('d', 'rare'))['iron-1']).toBe(upgradeCost(reg, weapon('e', 'normal'))['iron-1']);
  });

  it('⚠ уникальные кузница не улучшает вовсе — и не берёт за это денег', () => {
    const it = weapon('u', 'unique');
    const save = { gold: 1000, inventory: [it], materials: rich() } as unknown as SaveState;
    expect(upgradeCost(reg, it)).toEqual({});
    expect(forgeUpgrade(reg, save, 'u', wallet).ok).toBe(false);
    expect(save.gold).toBe(1000);
  });

  it('семья материала идёт от вещи: лук качается деревом, латы — пластинами', () => {
    const bowBase = reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'bow')!;
    const bow = { ...weapon('bw', 'magic'), baseId: bowBase.id } as Item;
    expect(Object.keys(upgradeCost(reg, bow))).toEqual(['wood-1', 'wood-2']);
    const plateBase = reg.get('items.base').find((b) => b.kind === 'armor' && b.armorClass === 'plate')!;
    const mail = { ...weapon('pl', 'normal'), baseId: plateBase.id, kind: 'armor', slot: 'chest', armorClass: 'plate' } as unknown as Item;
    expect(Object.keys(upgradeCost(reg, mail))).toEqual(['plate-1']);
  });

  it('реролл: −золото, перекатывает аффиксы (столько же)', () => {
    const it = weapon('w', 'magic');
    const save = { gold: 1000, inventory: [it] } as unknown as SaveState;
    expect(forgeReroll(reg, save, 'w', createRng(1)).ok).toBe(true);
    expect(save.gold).toBe(1000 - forgeGold(reg, it, 'reroll'));
    expect(it.affixes.length).toBeGreaterThan(0);
    expect(it.rerolls).toBe(1);
  });

  it('⚠ R2-13: обычную и уникальную не перекатить — отказ ДО платы, перекатка не тратится', () => {
    for (const rarity of ['normal', 'unique'] as const) {
      const it = weapon('w', rarity);
      const save = { gold: 1000, inventory: [it] } as unknown as SaveState;
      const r = forgeReroll(reg, save, 'w', createRng(1));
      expect(r.ok, rarity).toBe(false);
      expect(r.reason, rarity).toMatch(rarity === 'normal' ? /нечего перекатывать/ : /Уникальные/);
      expect(save.gold, rarity).toBe(1000);
      expect(it.rerolls, rarity).toBeUndefined();
    }
  });

  it('⚠ D14: улучшение ЗАМЕНЯЕТ вещь — ключи, снятые пересборкой клинка, исчезают', () => {
    // Найденный клинок, чья новая форма НЕ даёт множителя урона. Ищем перебором, а не по имени базы:
    // тест не должен ломаться от правки каталога клинков.
    let found: Item | undefined;
    for (const b of reg.get('items.base').filter((x) => x.kind === 'weapon' && x.enabled !== false)) {
      for (let seed = 1; seed < 20 && !found; seed++) {
        const it = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
          { dropBias: 1, itemLevel: 1, baseId: b.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'normal',
            maxReqTotal: reg.get('balance').maxTotalRequirement, baseRoll: reg.get('balance').loot.baseRoll }, createRng(seed)));
        const next = it.foundParts ? upgradedItem(reg, { ...it, damageMult: 1.37 }) : undefined;
        if (next && !('damageMult' in next)) found = it;
      }
      if (found) break;
    }
    expect(found, 'в каталоге есть найденный клинок без множителя урона').toBeTruthy();
    // Вещь из старого сейва: множитель остался от прежней формы клинка, пересборка его снимет.
    const stale = { ...found!, damageMult: 1.37 } as Item;
    const expected = upgradedItem(reg, stale)!;
    const save = { gold: 1e9, inventory: [stale] } as unknown as SaveState;
    const deep: Record<string, number> = Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 9999]));
    expect(forgeUpgrade(reg, save, stale.uid, deep).ok).toBe(true);
    const up = inBag(save, stale.uid);
    expect(up, 'в сумке лежит НОВЫЙ объект').not.toBe(stale);
    expect('damageMult' in up, 'устаревший множитель урона ушёл вместе со старым объектом').toBe(false);
    expect(up).toEqual(expected);
    expect(save.inventory.filter((i) => i.uid === stale.uid), 'вещь одна, не задвоилась').toHaveLength(1);
  });

  it('нет предмета → отказ', () => {
    const save = { gold: 1000, inventory: [] } as unknown as SaveState;
    expect(forgeUpgrade(reg, save, 'nope', wallet).ok).toBe(false);
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

/**
 * ГНЁЗДА МОДУЛЬНЫХ СКИЛОВ — авторитетная сторона. Клиент шлёт намерение, и всё, что он мог бы
 * соврать, обязано отбиваться ЗДЕСЬ: чужая ветка, неоткрытая вставка, гнездо сверх ранга,
 * второй экземпляр одного типа. Резолв (`session/inserts.ts`) негодное просто игнорирует —
 * этого мало: сейв не должен принимать в себя мусор вообще.
 */
describe('socketInsert / socketClear (авторитетная сборка скила)', () => {
  const tree = () => reg.get('skill-tree');
  /** Узел с активкой в ветке БЕЗ класса — доступен любому персонажу. */
  const freeNode = (): string => {
    const free = tree().branches.filter((b) => !b.classId).map((b) => b.id);
    return tree().nodes.find((n) => free.includes(n.branchId) && n.effect.active)!.id;
  };
  /** Узел с активкой в ветке ЧУЖОГО класса. */
  const mageNode = (): string => {
    const b = tree().branches.find((x) => x.classId === 'mage')!.id;
    return tree().nodes.find((n) => n.branchId === b && n.effect.active)!.id;
  };
  /** Открыть вставку: вкладываем ранг в её узел-донор из дерева. */
  const unlock = (save: SaveState, id: string): void => {
    save.skills[tree().nodes.find((n) => n.effect.grantsInsert === id)!.id] = 1;
  };
  /** Воин с выученным до максимума узлом (все гнёзда открыты) и открытыми вставками. */
  const hero = (nodeId: string, rank = 20, unlocks: string[] = []): SaveState => {
    const s = newCharacterSave(reg, 'warrior', 'Hero', 'c1');
    s.skills[nodeId] = rank;
    for (const id of unlocks) unlock(s, id);
    return s;
  };

  it('вставляет и вынимает — сейв меняется только через эти команды', () => {
    const id = freeNode();
    const save = hero(id, 20, ['ins-flame-edge']);
    expect(socketInsert(reg, save, id, 0, 'ins-flame-edge').ok).toBe(true);
    expect(save.sockets![id]![0]).toBe('ins-flame-edge');
    expect(socketClear(reg, save, id, 0).ok).toBe(true);
    expect(save.sockets![id]![0]).toBeNull();
    expect(socketClear(reg, save, id, 0).ok, 'вынуть из пустого — отказ').toBe(false);
  });

  it('НЕОТКРЫТУЮ вставку не берёт, даже существующую', () => {
    const id = freeNode();
    const save = hero(id);                                    // доноров нет вовсе
    const r = socketInsert(reg, save, id, 0, 'ins-flame-edge');
    expect(r.ok).toBe(false);
    expect(save.sockets?.[id]?.[0] ?? null, 'в сейв ничего не легло').toBeNull();
  });

  it('НЕСУЩЕСТВУЮЩУЮ вставку не берёт', () => {
    const id = freeNode();
    expect(socketInsert(reg, hero(id), id, 0, 'ins-нет-такой').ok).toBe(false);
  });

  it('ЧУЖОЙ КЛАСС: ни вставить, ни вынуть', () => {
    const id = mageNode();
    const save = hero(id, 20, ['ins-flame-edge']);             // воин с прокачанным магическим узлом
    expect(socketInsert(reg, save, id, 0, 'ins-flame-edge').ok).toBe(false);
    // Симметрия важнее самой проверки: «вынуть» слабее «вставить» — это и есть дыра.
    expect(socketClear(reg, save, id, 0).ok).toBe(false);
  });

  it('ГНЕЗДО СВЕРХ РАНГА и невыученный узел — отказ', () => {
    const id = freeNode();
    const ranks = reg.get('balance').skillSocketRanks;
    // ОБЕ вставки открыты и разного типа: единственная причина для отказа — само гнездо.
    // (Первая версия открывала только одну, и отказ приходил от «вставка не открыта» —
    // снятие проверки диапазона тест не роняло, мутация это и показала.)
    const low = hero(id, ranks[0]!, ['ins-flame-edge', 'ins-kindling']);   // ранг открывает ровно одно гнездо
    expect(socketInsert(reg, low, id, 0, 'ins-flame-edge').ok).toBe(true);
    expect(socketInsert(reg, low, id, 1, 'ins-kindling').ok, 'второго гнезда ещё нет').toBe(false);
    expect(low.sockets![id]!.length, 'фантомного гнезда в сейве не появилось').toBe(1);
    const none = hero(id, 0, ['ins-flame-edge']);
    expect(socketInsert(reg, none, id, 0, 'ins-flame-edge').ok, 'скил не выучен').toBe(false);
  });

  it('ОДИН ТИП НА СКИЛ: вторая вставка того же типа отбита, другого — принята', () => {
    const id = freeNode();
    const save = hero(id, 20, ['ins-flame-edge', 'ins-frost-edge', 'ins-kindling']);
    expect(socketInsert(reg, save, id, 0, 'ins-flame-edge').ok).toBe(true);
    expect(socketInsert(reg, save, id, 1, 'ins-frost-edge').ok, 'обе damage').toBe(false);
    expect(socketInsert(reg, save, id, 1, 'ins-kindling').ok, 'ailment — другой тип').toBe(true);
    // Заменить вставку В ТОМ ЖЕ гнезде тип не мешает — иначе перекладывать пришлось бы в два шага.
    expect(socketInsert(reg, save, id, 0, 'ins-frost-edge').ok).toBe(true);
  });

  it('ОРУЖИЕ учитывается: лучная вставка не лезет в руки с мечом', () => {
    const id = freeNode();
    const save = hero(id, 20, ['ins-piercing']);
    expect(save.equipment.weapon?.weaponClass, 'воин стартует НЕ с луком — иначе тест ничего не проверяет')
      .not.toBe('bow');
    expect(socketInsert(reg, save, id, 0, 'ins-piercing').ok).toBe(false);
  });

  it('РЕСПЕК СКИЛОВ вычищает и гнёзда — иначе вставки повисли бы на сброшенных узлах', () => {
    const id = freeNode();
    const save = hero(id, 20, ['ins-flame-edge']);
    save.gold = 1_000_000;
    expect(socketInsert(reg, save, id, 0, 'ins-flame-edge').ok).toBe(true);
    expect(respecSkills(reg, save).ok).toBe(true);
    expect(save.sockets).toEqual({});
  });
});

describe('разбор вещи на материалы (Ч3)', () => {
  /** Оружие с настоящей базой: правилам разбора нужен класс оружия, а он живёт на базе. */
  function axe(uid = 'a', rarity: Item['rarity'] = 'normal'): Item {
    const base = reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'axe')!;
    return { uid, baseId: base.id, name: uid, kind: 'weapon', slot: 'weapon', rarity, itemLevel: 1,
      requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: { x: 0, y: 0 } };
  }
  const save = (...items: Item[]): SaveState =>
    ({ inventory: items, materials: {} } as unknown as SaveState);

  it('кузница: вещь исчезает, а на её месте в СУМКЕ появляется сырьё', () => {
    const s = save(axe());
    expect(forgeSalvage(reg, s, emptyStash(reg), 'a', createRng(1)).ok).toBe(true);
    expect(s.inventory.some((i) => i.uid === 'a')).toBe(false);       // сама вещь ушла
    const got = carriedMaterials(s.inventory);
    expect(Object.values(got).reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
    // ⭐ И это сжатие: топор занимал несколько клеток, сырьё с него — стеки по одной.
    for (const it of s.inventory) expect(it.gridW * it.gridH).toBe(1);
  });

  it('⭐ поле даёт меньше кузницы на том же предмете и том же сиде', () => {
    const sum = (m: Record<string, number>): number => Object.values(m).reduce((x, y) => x + y, 0);
    let forge = 0;
    let field = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const f = save(axe());
      forgeSalvage(reg, f, emptyStash(reg), 'a', createRng(seed));
      forge += sum(carriedMaterials(f.inventory));
      const g = save(axe());
      fieldSalvage(reg, g, 'a', createRng(seed));
      field += sum(carriedMaterials(g.inventory));
    }
    expect(field).toBeGreaterThan(0);            // иначе разбирать в поле бессмысленно
    expect(field).toBeLessThan(forge * 0.6);     // и донести должно быть заметно выгоднее
  });

  it('⚠ отказ НЕ съедает вещь: уник остаётся в сумке', () => {
    const s = save(axe('u', 'unique'));
    const r = forgeSalvage(reg, s, emptyStash(reg), 'u', createRng(1));
    expect(r.ok).toBe(false);
    expect(s.inventory).toHaveLength(1);
    expect(s.materials).toEqual({});
  });

  it('чужой uid — отказ', () => {
    expect(forgeSalvage(reg, save(axe()), emptyStash(reg), 'нет', createRng(1)).ok).toBe(false);
    expect(fieldSalvage(reg, save(axe()), 'нет', createRng(1)).ok).toBe(false);
  });
});

describe('сломанные трофеи и починка (Ч4)', () => {
  const price = reg.get('balance').forgePrices;
  const swordBase = reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'sword')!;
  const broken = (uid = 'b'): Item => ({
    uid, baseId: swordBase.id, name: 'Меч', kind: 'weapon', weaponClass: 'sword', slot: 'weapon',
    rarity: 'normal', itemLevel: 5, requirements: {}, affixes: [], baseStats: [],
    gridW: 1, gridH: 3, pos: { x: 0, y: 0 }, broken: true,
  } as unknown as Item);
  const save = (it: Item, gold = 1000): SaveState =>
    ({ gold, inventory: [it], equipment: {}, belt: [],
      attributes: { strength: 200, dexterity: 200, intelligence: 200, vitality: 200 },
      level: 50, skills: {}, masteries: {} } as unknown as SaveState);

  it('⚠ сломанное НАДЕТЬ НЕЛЬЗЯ — это вся суть трофея', () => {
    const it = broken();
    const s = save(it);
    const r = equip(reg, s, 'b');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Сломано');
    expect(s.inventory).toHaveLength(1);       // из сумки не пропало
  });

  it('починка: −золото, −материалы, флаг снят, дальше вещь обычная', () => {
    const it = broken();
    const s = save(it);
    expect(forgeRepair(reg, s, 'b', wallet).ok).toBe(true);
    expect(it.broken).toBeUndefined();
    expect(s.gold).toBe(1000 - price.repairBroken);
    expect(wallet['iron-1']).toBe(99 - price.repairMaterials.tier1);
    expect(equip(reg, s, 'b').ok).toBe(true);  // теперь надевается
  });

  it('чинить целое нечего — отказ, ресурсы не тронуты', () => {
    const it = broken();
    delete (it as { broken?: boolean }).broken;
    const s = save(it);
    expect(forgeRepair(reg, s, 'b', wallet).ok).toBe(false);
    expect(s.gold).toBe(1000);
  });

  it('⚠ мало золота → отказ, и материалы не списаны', () => {
    const it = broken();
    const s = save(it, price.repairBroken - 1);
    expect(forgeRepair(reg, s, 'b', wallet).ok).toBe(false);
    expect(it.broken).toBe(true);
    expect(wallet['iron-1']).toBe(99);
  });

  it('сломанное УЛУЧШАТЬ нельзя — сперва почини', () => {
    const s = save(broken());
    const r = forgeUpgrade(reg, s, 'b', wallet);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('почини');
    expect(s.gold).toBe(1000);
  });

  it('⭐ но РАЗОБРАТЬ сломанное можно — в этом и выбор', () => {
    const s = save(broken());
    expect(forgeSalvage(reg, s, emptyStash(reg), 'b', createRng(1)).ok).toBe(true);
    expect(s.inventory.some((i) => i.uid === 'b')).toBe(false);
    expect(Object.keys(carriedMaterials(s.inventory)).length).toBeGreaterThan(0);
  });

  it('починка дешевле улучшения — иначе чинить не имело бы смысла', () => {
    const it = broken('x');
    const rep = repairCost(reg, it);
    const up = upgradeCost(reg, it);
    const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
    expect(sum(rep)).toBeLessThan(sum(up));
  });
});

describe('⚠ вещь БЕЗ записанного тира (сейв старше Ч5)', () => {
  /** Реальная вещь с ненулевым тиром и незапертым потолком — на ней и ломалось. */
  function tiered(): Item | null {
    for (let seed = 1; seed <= 200; seed++) {
      const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
        { dropBias: 1, itemLevel: 12, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
          categoryWeights: reg.get('balance').loot.categoryWeights, rareNames: reg.get('rare-names'),
          maxReqTotal: reg.get('balance').maxTotalRequirement }, createRng(seed));
      if (it.tier && it.tier !== 't0' && upgradedItem(reg, it)
        && it.baseStats.some((m) => m.stat === 'maxDamage' && m.kind === 'flat')) return it;
    }
    return null;
  }

  it('⭐ улучшается ТУДА ЖЕ, куда и вещь с полем: тир восстанавливается ПО СТАТАМ', () => {
    const it = tiered()!;
    expect(it).toBeTruthy();
    const legacy: Item = { ...it, tier: undefined };
    expect(nextTierOf(reg, legacy)?.id).toBe(nextTierOf(reg, it)?.id);
    expect(upgradedItem(reg, legacy)).toEqual(upgradedItem(reg, it));
  });

  it('⚠ и НЕ СЛАБЕЕТ от улучшения — прежде её тянуло на t0 (×1.0)', () => {
    const it = tiered()!;
    const dmg = (x: Item): number => x.baseStats.find((m) => m.stat === 'maxDamage')?.value ?? 0;
    // Замер до правки: алебарда 14–30 «улучшалась» до 11–23 за 200 золота и сырьё.
    const up = upgradedItem(reg, { ...it, tier: undefined })!;
    expect(dmg(up)).toBeGreaterThan(dmg(it));
  });

  it('база без шкалируемых статов (украшения) следа не оставляет — падаем на уровень предмета', () => {
    const ring = reg.get('items.base').find((b) => 'slot' in b && b.slot === 'ring');
    if (!ring) return;                      // колец в конфиге нет — проверять нечего
    const it: Item = { ...tiered()!, baseId: ring.id, baseStats: [], tier: undefined };
    expect(() => nextTierOf(reg, it)).not.toThrow();
  });
});

describe('⭐ forgeGold — цена привязана к СТУПЕНИ и РЕДКОСТИ', () => {
  // Своя база: хелперы соседних describe в этот блок не видны.
  const sword = reg.get('items.base').find((b) => b.kind === 'weapon')!;
  /** Вещь заданной ступени и редкости. Статы настоящие — по ним `inferTierId` и узнаёт ступень. */
  function at(tierId: string, rarity: string): Item {
    const base = generateItem(
      reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { dropBias: 1, itemLevel: 5, baseId: sword.id, tiers: reg.get('item-tiers'),
        rarities: reg.get('rarities'), forceRarity: 'normal', maxReqTotal: reg.get('balance').maxTotalRequirement },
      createRng(1),
    );
    return { ...base, tier: tierId, rarity } as Item;
  }
  const tiers = reg.get('item-tiers');
  const lowId = tiers[0]!.id, highId = tiers[tiers.length - 2]!.id;

  it('выше ступень — дороже работа', () => {
    for (const op of ['repair', 'reroll'] as const) {
      expect(forgeGold(reg, at(highId, 'normal'), op)).toBeGreaterThan(forgeGold(reg, at(lowId, 'normal'), op));
    }
  });

  it('выше редкость — дороже работа', () => {
    const n = forgeGold(reg, at(lowId, 'normal'), 'repair');
    const m = forgeGold(reg, at(lowId, 'magic'), 'repair');
    const r = forgeGold(reg, at(lowId, 'rare'), 'repair');
    expect(m).toBeGreaterThan(n);
    expect(r).toBeGreaterThan(m);
  });

  it('⚠ улучшение платит за ЦЕЛЕВУЮ ступень, а не за текущую', () => {
    const it = at(lowId, 'normal');
    // Улучшение с t0 стоит дороже починки той же вещи в t0: покупаем следующую ступень.
    const up = forgeGold(reg, it, 'upgrade');
    const same = Math.round(reg.get('balance').forgePrices.upgradeTier * (tiers[0]!.reqMult));
    expect(up).toBeGreaterThan(same);
  });

  it('⚠ цена никогда не ноль — иначе работа стала бы бесплатной на нулевых множителях', () => {
    for (const op of ['upgrade', 'repair', 'reroll'] as const) {
      expect(forgeGold(reg, at(lowId, 'normal'), op)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('⚠ R1-02: снятое при экипировке — место под ВСЁ сразу, а не под каждую вещь поодиночке', () => {
  const dims = reg.get('balance').inventory;
  /** Вещь по базе, с «нулевыми» требованиями: проверяем место, а не атрибуты. */
  const mk = (baseId: string): Item => {
    const it = itemFromBaseId(reg.get('items.base'), baseId, reg.get('item-tiers'), 'drop')!;
    it.requirements = {};
    return it;
  };
  /** Сейв героя с пустой сумкой: снаряжение и пояс задаёт тест. */
  const hero = (): SaveState => {
    const s = newCharacterSave(reg, 'warrior', 'Герой', 'r102');
    s.attributes = { strength: 999, dexterity: 999, intelligence: 999, vitality: 999 } as SaveState['attributes'];
    s.equipment = {};
    s.belt = [];
    s.inventory = [];
    return s;
  };
  /** Всё, кроме клеток `keep`, забито хламом 1×1: свободно ровно то, что оставил тест. */
  const fillExcept = (s: SaveState, keep: (x: number, y: number) => boolean): void => {
    const used = new Set<string>();
    for (const it of s.inventory) if (it.pos) for (let y = 0; y < it.gridH; y++) for (let x = 0; x < it.gridW; x++) used.add(`${it.pos.x + x},${it.pos.y + y}`);
    for (let y = 0; y < dims.rows; y++) for (let x = 0; x < dims.cols; x++) {
      if (!keep(x, y) && !used.has(`${x},${y}`)) s.inventory.push(mkItem(`j${x}-${y}`, 1, 1, x, y));
    }
  };
  /** Все uid героя: сумка + надетое + пояс. Вещь не может ни пропасть, ни задвоиться. */
  const uids = (s: SaveState): string[] => [
    ...s.inventory.map((i) => i.uid),
    ...Object.values(s.equipment).filter((i): i is Item => !!i).map((i) => i.uid),
    ...s.belt.filter((i): i is Item => !!i).map((i) => i.uid),
  ].sort();
  /** Никакие две вещи сумки не лежат друг на друге и все в сетке. */
  const noOverlap = (s: SaveState): void => {
    const cells = new Set<string>();
    for (const it of s.inventory) {
      expect(it.pos, it.uid).toBeTruthy();
      for (let y = 0; y < it.gridH; y++) for (let x = 0; x < it.gridW; x++) {
        const k = `${it.pos!.x + x},${it.pos!.y + y}`;
        expect(cells.has(k), `${it.uid} на занятой клетке ${k}`).toBe(false);
        expect(it.pos!.x + x < dims.cols && it.pos!.y + y < dims.rows, it.uid).toBe(true);
        cells.add(k);
      }
    }
  };

  /** Одноручник 1×3 и щит 2×2 надеты, в сумке двуручник 2×3 в углу. */
  const twoHander = (): { s: SaveState; claymore: Item } => {
    const s = hero();
    s.equipment.weapon = { ...mk('short-sword'), pos: null };
    s.equipment.offhand = { ...mk('wooden-shield'), pos: null };
    const claymore = { ...mk('claymore'), pos: { x: 0, y: 0 } };
    s.inventory.push(claymore);
    return { s, claymore };
  };

  it('двуручник вместо одноручника со щитом: каждое снятое влезает поодиночке, вместе — нет → отказ, сейв байт в байт', () => {
    const { s, claymore } = twoHander();
    fillExcept(s, (x, y) => x < 2 && y < 3);             // свободны только клетки под двуручником
    const before = JSON.stringify(s);
    const r = equip(reg, s, claymore.uid);
    expect(r.ok, 'щит пропал бы молча').toBe(false);
    expect(r.reason).toBe('Нет места для снятого');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('⭐ хватает места на всё снятое — надевается, ни одна вещь не пропала и не задвоилась', () => {
    const { s, claymore } = twoHander();
    fillExcept(s, (x, y) => (x < 2 && y < 3) || (x >= 8 && y >= 4));   // + свободный угол 2×2 под щит
    const before = uids(s);
    const r = equip(reg, s, claymore.uid);
    expect(r.ok, r.reason).toBe(true);
    expect(s.equipment.weapon?.uid).toBe(claymore.uid);
    expect(s.equipment.offhand).toBeUndefined();
    expect(uids(s)).toEqual(before);
    noOverlap(s);
  });

  it('снять пояс с двумя колбами: пояс и колбы влезают поодиночке, вместе — нет → отказ, сейв байт в байт', () => {
    const s = hero();
    s.equipment.belt = { ...mk('cloth-sash'), pos: null };
    s.belt = [mk('minor-healing-potion'), mk('minor-healing-potion')];
    fillExcept(s, (x, y) => x < 2 && y === 0);           // свободно ровно 2×1 — место самого пояса
    const before = JSON.stringify(s);
    const r = unequip(reg, s, 'belt');
    expect(r.ok, 'колбы пропали бы молча').toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('снять пояс, когда места хватает на всё: пояс и колбы в сумке, ничего не потеряно', () => {
    const s = hero();
    s.equipment.belt = { ...mk('cloth-sash'), pos: null };
    s.belt = [mk('minor-healing-potion'), mk('minor-healing-potion')];
    fillExcept(s, (x, y) => y === 0 && x < 4);           // 2×1 под пояс + две клетки под колбы
    const before = uids(s);
    expect(unequip(reg, s, 'belt').ok).toBe(true);
    expect(s.belt).toEqual([]);
    expect(uids(s)).toEqual(before);
    noOverlap(s);
  });

  it('смена пояса на меньший: лишние колбы и старый пояс не влезают вместе → отказ, сейв байт в байт', () => {
    const s = hero();
    s.equipment.belt = { ...mk('leather-belt'), pos: null };            // 4 слота
    s.belt = [mk('minor-healing-potion'), mk('minor-healing-potion'), mk('minor-healing-potion'), mk('minor-healing-potion')];
    const sash = { ...mk('cloth-sash'), pos: { x: 0, y: 0 } };           // 2 слота
    s.inventory.push(sash);
    fillExcept(s, (x, y) => x < 2 && y === 0);
    const before = JSON.stringify(s);
    const r = equip(reg, s, sash.uid);
    expect(r.ok, 'две колбы пропали бы молча').toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('⚠ R2-15: очки атрибутов — ПАЧКОЙ одной командой', () => {
  const fresh = (unspent: number): SaveState => {
    const s = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Тест', 'c-r215');
    s.unspentAttributePoints = unspent;
    return s;
  };

  it('n очков одной командой: атрибут +n, нераспределённых −n (после сброса у 40-го уровня ≈ 195)', () => {
    const s = fresh(300);
    const str0 = s.attributes.strength;
    expect(allocAttr(s, 'strength', 300).ok).toBe(true);
    expect(s.attributes.strength).toBe(str0 + 300);
    expect(s.unspentAttributePoints).toBe(0);
  });

  it('без числа — одно очко, как раньше (Unity и «+» шлют так)', () => {
    const s = fresh(2);
    expect(allocAttr(s, 'vitality').ok).toBe(true);
    expect(s.unspentAttributePoints).toBe(1);
  });

  it('⚠ всё или ничего: очков меньше n, кривое n — отказ, сейв байт в байт', () => {
    const s = fresh(5);
    const before = JSON.stringify(s);
    for (const n of [6, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = allocAttr(s, 'strength', n);
      expect(r.ok, String(n)).toBe(false);
      expect(r.reason, String(n)).toBeTruthy();
      expect(JSON.stringify(s), String(n)).toBe(before);
    }
    expect(allocAttr(s, 'luck', 1).ok).toBe(false);
  });
});

describe('⚠ R4-08: требования держатся ВСЁ время ношения, а не только на входе в слот', () => {
  /** Вещь слота `slot`: +`str` Силы (плоско) и требование Силы `req` (0 — без требований). */
  const gear = (uid: string, slot: Item['slot'], str: number, req = 0, name = uid): Item => ({
    uid, baseId: 'b', name, slot, rarity: 'normal', itemLevel: 1,
    requirements: req ? { strength: req } : {}, affixes: [],
    baseStats: str ? [{ stat: 'strength', kind: 'flat', value: str }] : [],
    gridW: 1, gridH: 1, pos: null,
  });
  /** Воин (Сила 20) с пустыми слотами и сумкой из `bag`. */
  const hero = (...bag: Item[]): SaveState => {
    const s = newCharacterSave(reg, 'warrior', 'Герой', 'r408');
    s.equipment = {};
    s.belt = [];
    s.inventory = bag.map((it, i) => ({ ...it, pos: { x: i, y: 0 } }));
    s.gold = 100_000;
    return s;
  };
  const wear = (s: SaveState, uid: string): void => { const r = equip(reg, s, uid); expect(r.ok, `${uid}: ${r.reason}`).toBe(true); };

  it('⭐ смена амулета: уходящий +15 Силы больше не считается — амулет «Сила 30» при базе 20 не надевается', () => {
    const s = hero(gear('a1', 'amulet', 15), gear('a2', 'amulet', 0, 30));
    wear(s, 'a1');
    const before = JSON.stringify(s);
    const r = equip(reg, s, 'a2');
    expect(r.ok, 'надел бы на 20 Силы при требовании 30').toBe(false);
    expect(r.reason).toBe('Недостаточно атрибутов');
    expect(JSON.stringify(s), 'сейв байт в байт').toBe(before);
  });

  it('⭐ снять вещь, на которой держится чужое требование, — отказ; сперва снимается тяжёлое', () => {
    const s = hero(gear('h', 'helm', 15), gear('w', 'weapon', 0, 30, 'Двуручник'));
    wear(s, 'h');
    wear(s, 'w');
    const before = JSON.stringify(s);
    const r = unequip(reg, s, 'helm');
    expect(r.ok, 'меч остался бы надетым при 20 Силы из 30').toBe(false);
    expect(r.reason).toContain('Двуручник');
    expect(JSON.stringify(s)).toBe(before);
    expect(unequip(reg, s, 'weapon').ok).toBe(true);
    expect(unequip(reg, s, 'helm').ok).toBe(true);
  });

  it('⭐ смена шлема на шлем без Силы — тот же отказ: уходящий держал меч', () => {
    const s = hero(gear('h', 'helm', 15), gear('w', 'weapon', 0, 30, 'Двуручник'), gear('h2', 'helm', 0));
    wear(s, 'h');
    wear(s, 'w');
    const before = JSON.stringify(s);
    const r = equip(reg, s, 'h2');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Двуручник');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('⭐ сброс атрибутов, пока надето то, что держится на вложенной Силе, — отказ; снял — сброс идёт', () => {
    const s = hero(gear('w', 'weapon', 0, 30, 'Двуручник'));
    s.unspentAttributePoints = 10;
    expect(allocAttr(s, 'strength', 10).ok).toBe(true);
    wear(s, 'w');
    const before = JSON.stringify(s);
    const r = respec(reg, s);
    expect(r.ok, 'меч висел бы на 20 Силы, очки ушли бы в Ловкость').toBe(false);
    expect(r.reason).toContain('Двуручник');
    expect(JSON.stringify(s), 'ни золота, ни очков').toBe(before);
    expect(unequip(reg, s, 'weapon').ok).toBe(true);
    expect(respec(reg, s).ok).toBe(true);
  });

  it('⭐ две вещи, подпирающие только друг друга, не держатся: снять третью, на которой стояли обе, — отказ', () => {
    // База 20. Шлем +10 без требований → амулет (+15, нужно 25) → кольцо (+10, нужно 30). Без шлема: амулету
    // хватает с кольцом (30), кольцу — с амулетом (35), а по порядку от базы не встаёт ни одно.
    const s = hero(gear('h', 'helm', 10), gear('a', 'amulet', 15, 25, 'Амулет'), gear('r', 'ring', 10, 30, 'Кольцо'));
    wear(s, 'h');
    wear(s, 'a');
    wear(s, 'r');
    const before = JSON.stringify(s);
    expect(unequip(reg, s, 'helm').ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('честная смена и сейв старше правки (уже не держится) — не запираются', () => {
    const s = hero(gear('a1', 'amulet', 15), gear('a2', 'amulet', 5, 20), gear('ring', 'ring', 0));
    wear(s, 'a1');
    wear(s, 'a2');                                   // 20 из 20 — своей базой
    expect(s.equipment.amulet?.uid).toBe('a2');
    const legacy = hero(gear('ring', 'ring', 0));
    legacy.equipment.weapon = gear('w', 'weapon', 0, 99);   // надето до правки при 20 Силы
    wear(legacy, 'ring');                            // не ломает ничего нового — можно
    expect(unequip(reg, legacy, 'weapon').ok, 'и снять не державшееся — можно').toBe(true);
  });
});

/**
 * ⚠ R6-11: СБРОС АТРИБУТОВ БЕРЁТ ЗОЛОТО ТОЛЬКО ЗА СБРОС. Ядро считало возврат очков, но не отказывало на нуле и списывало
 * `respecCost` всегда: двойной клик по кнопке (она перерисовывается лишь по `saveUpdate`) платил дважды — второй раз за
 * ничто, а свежий герой платил 500 за пустое место. Сбросы скилов и мастерств на нуле отказывают давно.
 */
describe('⚠ R6-11: сброс атрибутов — отказ, когда сбрасывать нечего', () => {
  const cost = reg.get('balance').respecCost;
  it('⭐ новый герой: отказ «Атрибуты не вложены», золото и атрибуты не тронуты', () => {
    const s = newCharacterSave(reg, 'warrior', 'Новичок', 'r611-a');
    s.gold = cost + 100;
    expect(attrRespecRefund(reg, s)).toBe(0);
    const before = JSON.stringify(s);
    expect(respec(reg, s)).toEqual({ ok: false, reason: 'Атрибуты не вложены' });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('⭐ два сброса подряд (двойной клик): золото списано ОДИН раз, второй — отказ без траты', () => {
    const s = newCharacterSave(reg, 'warrior', 'Двойной', 'r611-b');
    s.gold = 5000;
    s.unspentAttributePoints = 10;
    expect(allocAttr(s, 'strength', 10).ok).toBe(true);
    expect(attrRespecRefund(reg, s)).toBe(10);
    expect(respec(reg, s, cost).ok).toBe(true);
    expect(s.gold).toBe(5000 - cost);
    expect(s.unspentAttributePoints).toBe(10);
    const before = JSON.stringify(s);
    expect(respec(reg, s, cost)).toEqual({ ok: false, reason: 'Атрибуты не вложены' });
    expect(JSON.stringify(s), 'второй клик — ни золота, ни очков').toBe(before);
  });
});

/** ⚠ R6-17: вложил — сбросил — очков скилов ровно столько же, сколько было до вложения (не больше и не меньше). */
describe('⚠ R6-17: сброс дерева скилов возвращает ровно вложенное', () => {
  it('⭐ каждый вход ветки без класса: вложить до потолка ранга, сбросить — очки как до вложения, золото — только пошлина', () => {
    const tree = reg.get('skill-tree');
    let n = 0;
    for (const br of tree.branches.filter((b) => !b.classId)) {
      const s = newCharacterSave(reg, 'warrior', 'Сброс', `r617-${br.id}`);
      s.level = 99; s.gold = 10_000_000; s.unspentSkillPoints = 50;
      const before = s.unspentSkillPoints;
      let ranks = 0;
      while (allocActive(reg, s, br.entryNode).ok) ranks++;
      expect(ranks, br.id).toBeGreaterThan(0);
      const fee = skillRespecFee(reg, s);
      const g0 = s.gold;
      expect(respecSkills(reg, s).ok).toBe(true);
      expect(s.unspentSkillPoints, `${br.id}: вернулось ровно вложенное`).toBe(before);
      expect(g0 - s.gold).toBe(fee);
      n++;
    }
    expect(n).toBeGreaterThan(3);
  });
});
