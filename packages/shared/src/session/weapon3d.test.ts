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
  it('нет/неизвестное оружие → null (клиент подставит класс-дефолт)', () => {
    expect(weapon3dKeyFromEquipment(undefined, item({ kind: 'shield' }))).toBeNull();
    expect(weapon3dKeyFromEquipment(item({ hands: 1 }), undefined)).toBeNull();   // без weaponClass
  });
});
