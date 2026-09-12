import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { moveInventoryItem, allocPassive, respecPassives, passiveInvestedGold, passiveRespecFee, passiveEntriesFor, allocActive, respecSkills, skillRespecFee, forgeUpgrade, forgeReroll, forgeSalvage, forgeRepair, fieldSalvage, upgradeCost, repairCost, upgradedItem, nextTierOf, equip, socketInsert, socketClear } from './townActions.js';
import { newCharacterSave } from './newCharacter.js';
import { createRng } from '../formulas/rng.js';
import { carriedMaterials } from './materials.js';
import { generateItem } from '../formulas/itemgen.js';
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
  const rich = (): Record<string, number> => ({ 'iron-1': 99, 'iron-2': 99, 'iron-3': 99 });

  /** Настоящий предмет из конвейера генерации — у выдуманного нет ни тира, ни базовых статов. */
  const rolled = (ilvl: number): Item => generateItem(
    reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
    { dropBias: 1, itemLevel: ilvl, baseId: swordBase.id, tiers: reg.get('item-tiers'),
      rarities: reg.get('rarities'), forceRarity: 'normal', maxReqTotal: reg.get('balance').maxTotalRequirement },
    createRng(1));

  it('⭐ улучшение поднимает ТИР на ступень, а не множит статы', () => {
    const it = rolled(1);
    expect(it.tier).toBe('t0');
    const save = { gold: 1000, inventory: [it], materials: rich() } as unknown as SaveState;
    expect(forgeUpgrade(reg, save, it.uid, wallet).ok).toBe(true);
    expect(it.tier).toBe('t1');
    expect(save.gold).toBe(1000 - price.upgradeTier);
    expect(wallet['iron-1']).toBe(99 - price.upgradeMaterials.tier1);
    // Имя обновилось приставкой нового тира, а не украсилось звёздочкой.
    const t1 = reg.get('item-tiers').find((t) => t.id === 't1')!;
    expect(it.name.startsWith(t1.name)).toBe(true);
  });

  it('⭐ кузнечный тир РАВЕН найденному по статам, но ЛЕГЧЕ по требованиям', () => {
    const forged = rolled(1);
    const save = { gold: 1000, inventory: [forged], materials: rich() } as unknown as SaveState;
    expect(forgeUpgrade(reg, save, forged.uid, wallet).ok).toBe(true);
    const found = rolled(8); // тот же t1, но с пола
    expect(found.tier).toBe('t1');
    const dmg = (i: Item): number => i.baseStats.filter((m) => m.kind === 'flat').reduce((a, m) => a + m.value, 0);
    expect(dmg(forged)).toBe(dmg(found));                    // сила одинаковая — иначе тир ничего не значит
    const req = (i: Item): number => Object.values(i.requirements).reduce((a, b) => a + (b ?? 0), 0);
    expect(req(forged)).toBeLessThan(req(found));            // а носится раньше — в этом смысл крафта
  });

  it('⚠ выше потолка базы не поднять — лестница конечна по построению', () => {
    const it = rolled(1);
    const save = { gold: 10_000_000, inventory: [it], materials: { 'iron-1': 9999, 'iron-2': 9999, 'iron-3': 9999 } } as unknown as SaveState;
    let steps = 0;
    while (forgeUpgrade(reg, save, it.uid, wallet).ok && steps < 50) steps++;
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(20);                          // упёрлись, а не крутили бесконечно
    expect(it.tier).toBe(swordBase.maxTier);
    expect(forgeUpgrade(reg, save, it.uid, wallet).reason).toContain('Лучше');
  });

  it('⚠ перекатка КОНЕЧНА: предел из конфига', () => {
    const it = rolled(30);
    const save = { gold: 1_000_000, inventory: [it] } as unknown as SaveState;
    let n = 0;
    while (forgeReroll(reg, save, it.uid, createRng(n + 1)).ok && n < 50) n++;
    expect(n).toBe(price.rerollLimit);
    expect(it.rerolls).toBe(price.rerollLimit);
  });

  it('улучшение: мало золота → отказ, предмет, золото и материалы не тронуты', () => {
    const it = weapon('w');
    const save = { gold: price.upgradeTier - 1, inventory: [it], materials: rich() } as unknown as SaveState;
    expect(forgeUpgrade(reg, save, 'w', wallet).ok).toBe(false);
    expect(it.name).toBe('Меч');
    expect(save.gold).toBe(price.upgradeTier - 1);
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
    const it = weapon('w');
    const save = { gold: 1000, inventory: [it] } as unknown as SaveState;
    expect(forgeReroll(reg, save, 'w', createRng(1)).ok).toBe(true);
    expect(save.gold).toBe(1000 - price.rerollAffix);
    expect(Array.isArray(it.affixes)).toBe(true);   // пул мог дать 0/1 — но операция прошла и списала золото
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
    expect(forgeSalvage(reg, s, 'a', createRng(1)).ok).toBe(true);
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
      forgeSalvage(reg, f, 'a', createRng(seed));
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
    const r = forgeSalvage(reg, s, 'u', createRng(1));
    expect(r.ok).toBe(false);
    expect(s.inventory).toHaveLength(1);
    expect(s.materials).toEqual({});
  });

  it('чужой uid — отказ', () => {
    expect(forgeSalvage(reg, save(axe()), 'нет', createRng(1)).ok).toBe(false);
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
    expect(forgeSalvage(reg, s, 'b', createRng(1)).ok).toBe(true);
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
