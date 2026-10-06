import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { craftWeapon, defaultParts, fullJournal, shapeFoundWeapon } from '../formulas/craft.js';
import { generateItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { craftAction, enchantAction, upgradedItem } from '../economy/townActions.js';
import { newCharacterSave } from '../economy/newCharacter.js';
import { emptyStash } from '../economy/stashActions.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import { saveStateSchema } from './save.js';
import { ESSENCE_ID } from '../formulas/salvage.js';
/** §6.2: зачарование и перекатка тратят эссенцию — кошелёк сундука с запасом (тесту важно не это). */
const essWallet = (): Record<string, number> => ({ [ESSENCE_ID]: 1_000_000 });

/**
 * ⭐ СХЕМА СЕЙВА НИЧЕГО НЕ СРЕЗАЕТ. zod по умолчанию молча выкидывает незнакомые ключи, а схема
 * предмета знала только поля до ковки: пропусти через неё сейв — и скованная вещь теряет детали
 * (`parts`), найденная — `foundParts`/`origin`/`tierForged`, клинок — разброс, а прок-аффикс (без
 * `modifier`) и вовсе валит разбор. Сейв после разбора обязан совпасть с исходным целиком.
 */

const reg = new ConfigRegistry();
reg.loadAll();
const ROLL = reg.get('balance').loot.baseRoll;
/** Сейв таким, каким он лежит в базе и едет по проводу, — JSON (ключей со значением undefined там нет). */
const stored = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Скованный меч, зачарованный до редкого, — через те же действия, что зовёт сервер. */
function craftedRare(): Item {
  const save = { gold: 10_000_000, inventory: [] } as unknown as SaveState;
  const stash = { ...emptyStash(reg), materials: Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 999])), forgeJournal: fullJournal(reg) };
  const parts = defaultParts(reg, 'sword', 1, 3)!;
  const r = craftAction(reg, save, stash, 'nonce-save-rt-01', { weaponClass: 'sword', hands: 1, parts }, createRng(11));
  expect(r.ok, r.reason).toBe(true);
  const e = enchantAction(reg, save, r.uid!, 'rare', createRng(12), undefined, essWallet());
  expect(e.ok, e.reason).toBe(true);
  return save.inventory.find((i) => i.uid === e.uid)!;
}

/** Найденный меч с формой клинка (разброс от ширины) и поднятой кузнецом ступенью. */
function foundSword(): Item {
  const swords = reg.get('items.base').filter((b) => b.kind === 'weapon' && b.weaponClass === 'sword' && b.enabled !== false);
  for (const b of swords) {
    for (let seed = 1; seed < 40; seed++) {
      const raw = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
        dropBias: 1, itemLevel: 12, tierLevel: 12, baseId: b.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
        forceRarity: 'magic', maxReqTotal: reg.get('balance').maxTotalRequirement, baseRoll: ROLL, origin: 'drop',
      }, createRng(seed));
      const shaped = shapeFoundWeapon(reg, raw);
      if (shaped.spreadMult === undefined || !shaped.foundParts) continue;
      const up = upgradedItem(reg, shaped);
      if (up?.tierForged) return up;
    }
  }
  throw new Error('нет найденного меча с формой клинка и подъёмом ступени');
}

/** Вещь с прок-аффиксом (шанс каста): у такого аффикса нет `modifier`. */
function procItem(): Item {
  const affix = reg.get('affixes').find((a) => a.proc && a.enabled !== false && a.appliesTo.includes('weapon'))!;
  expect(affix, 'в конфиге есть прок-аффикс оружия').toBeTruthy();
  const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
    dropBias: 1, itemLevel: 20, baseId: reg.get('items.base').find((b) => b.kind === 'weapon' && b.enabled !== false)!.id,
    tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'rare', baseRoll: ROLL, origin: 'chest',
  }, createRng(5));
  it.affixes.push({ affixId: affix.id, kind: affix.kind, proc: { skillId: affix.proc!.skillId, level: affix.proc!.level, chance: affix.proc!.chance, trigger: affix.proc!.trigger } });
  return it;
}

describe('⭐ saveStateSchema — разбор сейва без потерь', () => {
  const crafted = craftedRare();
  const found = foundSword();
  const proc = procItem();

  it('образцы несут ровно те поля, что старая схема срезала', () => {
    expect(crafted.parts).toBeTruthy();
    expect(crafted.craftPaid?.length).toBeGreaterThan(0);
    expect(crafted.origin).toBe('craft');
    expect(crafted.rarity).toBe('rare');
    expect(crafted.affixes.length).toBeGreaterThan(0);
    expect(crafted.tier).toBeTruthy();
    expect(found.foundParts).toBeTruthy();
    expect(found.origin).toBe('drop');
    expect(found.tierForged).toBe(true);
    expect(found.spreadMult).toBeTypeOf('number');
    expect(proc.affixes.some((a) => a.proc && !a.modifier)).toBe(true);
  });

  it('скованная, найденный меч и прок-вещь в сумке, на теле и в сундуке — после разбора те же', () => {
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Тест', 'c-save-rt');
    save.inventory.push({ ...crafted, pos: { x: 0, y: 0 } });
    save.equipment.weapon = found;
    save.stash.push(proc);
    save.belt = [null, { ...proc, uid: 'belt-copy' }];
    save.materials = { 'iron-1': 7 };
    save.sockets = { 'node-a': [null, 'ins-1'] };
    const want = stored(save);
    const input = stored(save);
    const r = saveStateSchema.safeParse(input);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true);
    if (!r.success) return;
    expect(r.data.inventory.at(-1)).toStrictEqual(want.inventory.at(-1));
    expect(r.data.equipment.weapon).toStrictEqual(stored(found));
    expect(r.data.stash.at(-1)).toStrictEqual(stored(proc));
    expect(r.data).toStrictEqual(want);
    expect(JSON.stringify(r.data).length, 'ни байта не потеряно').toBe(JSON.stringify(want).length);
    expect(input, 'разбор не трогает вход').toStrictEqual(want);
  });

  it('проверка не выключена: мусор в предмете по-прежнему отвергается', () => {
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Тест', 'c-save-bad');
    const bad = (patch: Record<string, unknown>): boolean =>
      saveStateSchema.safeParse({ ...save, inventory: [{ ...crafted, ...patch }] }).success;
    expect(bad({})).toBe(true);
    expect(bad({ rarity: 'legendary' })).toBe(false);
    expect(bad({ uid: 5 })).toBe(false);
    expect(bad({ affixes: [{ affixId: 'x', kind: 'prefix', modifier: { stat: 'str', kind: 'more', value: 1 } }] })).toBe(false);
    expect(bad({ affixes: [{ affixId: 'x', kind: 'suffix', proc: { skillId: 's', level: 1, chance: 1.5 } }] })).toBe(false);
    expect(bad({ baseRoll: { minDamage: 2 } })).toBe(false);
    expect(bad({ craftPaid: [{ id: 'iron-2', n: -5 }] })).toBe(false);
    expect(bad({ craftPaid: [{ id: 'iron-2', n: 1.5 }] })).toBe(false);
    expect(bad({ craftPaid: 'много' })).toBe(false);
  });
});

// Предпросмотр ковки не лежит в сейве, но и его разбор не должен ронять: вилка — лишнее поле, не ошибка.
describe('saveStateSchema — вещь предпросмотра', () => {
  it('rollPreview проходит насквозь', () => {
    const pv = craftWeapon(reg, { weaponClass: 'sword', hands: 1, parts: defaultParts(reg, 'sword', 1, 2)! }).item!;
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Тест', 'c-save-pv');
    save.stash.push(pv);
    const r = saveStateSchema.safeParse(stored(save));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.stash.at(-1)).toStrictEqual(stored(pv));
  });
});
