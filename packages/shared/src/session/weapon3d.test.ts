import { describe, it, expect } from 'vitest';
import { weapon3dKeyFromEquipment } from './weapon3d.js';
import type { Item } from '../types/items.js';

const item = (o: Partial<Item>): Item => o as Item;

describe('weapon3dKeyFromEquipment', () => {
  it('одноручное + офф-рука (щит/дуал)', () => {
    expect(weapon3dKeyFromEquipment(item({ weaponClass: 'sword', hands: 1 }), undefined)).toBe('sword');
    expect(weapon3dKeyFromEquipment(item({ weaponClass: 'sword', hands: 1 }), item({ kind: 'shield' }))).toBe('sword+shield');
    expect(weapon3dKeyFromEquipment(item({ weaponClass: 'sword', hands: 1 }), item({ kind: 'weapon', weaponClass: 'dagger', hands: 1 }))).toBe('sword+dagger');
    expect(weapon3dKeyFromEquipment(item({ weaponClass: 'axe', hands: 1 }), item({ kind: 'shield' }))).toBe('axe+shield');
  });
  it('двуручное → great*/staff, офф-рука игнорируется', () => {
    expect(weapon3dKeyFromEquipment(item({ weaponClass: 'sword', hands: 2 }), undefined)).toBe('greatsword');
    expect(weapon3dKeyFromEquipment(item({ weaponClass: 'axe', hands: 2 }), item({ kind: 'shield' }))).toBe('greataxe');
    expect(weapon3dKeyFromEquipment(item({ weaponClass: 'mace', hands: 2 }), undefined)).toBe('greatmaul');
    expect(weapon3dKeyFromEquipment(item({ weaponClass: 'staff', hands: 2 }), undefined)).toBe('staff');
    expect(weapon3dKeyFromEquipment(item({ weaponClass: 'bow', hands: 2 }), undefined)).toBe('bow');
  });
  it('неизвестное оружие и пустые руки → null (клиент подставит класс-дефолт)', () => {
    expect(weapon3dKeyFromEquipment(item({ hands: 1 }), undefined)).toBeNull();   // без weaponClass
    expect(weapon3dKeyFromEquipment(undefined, undefined)).toBeNull();            // вообще пусто
  });

  it('⭐⭐ ГЛАВНАЯ РУКА ПУСТА, А ОФФ-РУКА ЗАНЯТА — это `none+<предмет>`, а не «ключа нет»', () => {
    // ⚠ ЗДЕСЬ БЫЛО ОБРАТНОЕ ТРЕБОВАНИЕ («нет оружия → null»), и его отменила живая проверка автора:
    // «снимаешь оружие — щит тоже пропадает с модели, а должен остаться». `null` означал «ключа нет»,
    // клиент подставлял КЛАСС-ДЕФОЛТ — то есть рисовал оружие, которого на игроке нет, и терял щит,
    // который есть. Удар при этом честно уходит в безоружный: цепочка `none+shield` ведёт к `none`.
    expect(weapon3dKeyFromEquipment(undefined, item({ kind: 'shield' }))).toBe('none+shield');
    expect(weapon3dKeyFromEquipment(undefined, item({ kind: 'weapon', weaponClass: 'dagger', hands: 1 }))).toBe('none+dagger');
    expect(weapon3dKeyFromEquipment(undefined, item({ kind: 'weapon', weaponClass: 'sword', hands: 2 })),
      'двуручное во второй руке — не бывает').toBeNull();
  });
});
