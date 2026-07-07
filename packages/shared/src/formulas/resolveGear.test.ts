import { describe, it, expect } from 'vitest';
import type { Item } from '../types/items.js';
import { weaponDebuffs, weightScaleSplit } from './resolveWeapon.js';
import { armorClassModifiers, armorNoise, armorPoise } from './resolveArmor.js';
import { ConfigRegistry } from '../config/registry.js';

const wpn = (over: Partial<Item>): Item => over as unknown as Item;
// Справочники (классы брони, физ-подтипы, веса) — из конфига (таблицы data-driven).
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const AC = reg.get('armor-classes');
const PS = reg.get('phys-subtypes');
const WW = reg.get('weapon-weights');
const TH = reg.get('balance').twoHandedPowerMult;

describe('resolveWeapon', () => {
  it('доли скейла: сверхлёгкое — Ловкость, тяжёлое — Сила', () => {
    expect(weightScaleSplit('superlight', WW)).toEqual({ strength: 0, dexterity: 1 });
    expect(weightScaleSplit('heavy', WW)).toEqual({ strength: 1, dexterity: 0 });
  });

  it('подтип урона → свой дебафф; лёгкие чаще ранят, тяжёлые чаще увечат', () => {
    const dagger = weaponDebuffs(wpn({ physSub: 'piercing', weight: 'superlight', hands: 1 }), PS, WW, TH);
    const heavyAxe = weaponDebuffs(wpn({ physSub: 'chopping', weight: 'heavy', hands: 2 }), PS, WW, TH);
    expect(dagger[0]!.kind).toBe('wound');
    expect(heavyAxe[0]!.kind).toBe('sunder');

    const lightWound = weaponDebuffs(wpn({ physSub: 'piercing', weight: 'superlight', hands: 1 }), PS, WW, TH)[0]!.chance;
    const heavyWound = weaponDebuffs(wpn({ physSub: 'piercing', weight: 'heavy', hands: 1 }), PS, WW, TH)[0]!.chance;
    expect(lightWound).toBeGreaterThan(heavyWound); // рана — finesse (легче чаще)

    const lightSunder = weaponDebuffs(wpn({ physSub: 'chopping', weight: 'light', hands: 1 }), PS, WW, TH)[0]!.chance;
    const heavySunder = weaponDebuffs(wpn({ physSub: 'chopping', weight: 'heavy', hands: 1 }), PS, WW, TH)[0]!.chance;
    expect(heavySunder).toBeGreaterThan(lightSunder); // увечье — power (тяжелее чаще)
  });

  it('без осей — дебаффов нет', () => {
    expect(weaponDebuffs(wpn({}), PS, WW, TH)).toHaveLength(0);
  });
});

describe('resolveArmor', () => {
  it('латы штрафуют бег/атаку/уворот; кожа даёт уворот без штрафов', () => {
    const plate = armorClassModifiers([{ armorClass: 'plate' }, { armorClass: 'plate' }], AC);
    const move = plate.find((m) => m.stat === 'moveSpeed');
    expect(move!.value).toBeLessThan(0);
    const leather = armorClassModifiers([{ armorClass: 'leather' }], AC);
    expect(leather.find((m) => m.stat === 'moveSpeed')).toBeUndefined();
    expect(leather.find((m) => m.stat === 'evade')!.value).toBeGreaterThan(0);
  });

  it('штраф бега капается на −45%', () => {
    const all = armorClassModifiers(Array(15).fill({ armorClass: 'plate' }), AC);
    expect(all.find((m) => m.stat === 'moveSpeed')!.value).toBe(-0.45);
  });

  it('шум: латы громче кожи', () => {
    const plate = armorNoise(Array(6).fill({ armorClass: 'plate' }), AC);
    const leather = armorNoise(Array(6).fill({ armorClass: 'leather' }), AC);
    expect(plate).toBeGreaterThan(1);
    expect(leather).toBeLessThan(1);
  });

  it('выдержка: каждый класс лучше держит свой дебафф, кап 60%', () => {
    // Кожаная — против раны, латная — против ошеломления.
    expect(armorPoise([{ armorClass: 'leather' }], 'wound', AC))
      .toBeGreaterThan(armorPoise([{ armorClass: 'leather' }], 'daze', AC));
    expect(armorPoise([{ armorClass: 'plate' }], 'daze', AC))
      .toBeGreaterThan(armorPoise([{ armorClass: 'plate' }], 'wound', AC));
    expect(armorPoise(Array(20).fill({ armorClass: 'plate' }), 'daze', AC)).toBe(0.6);
  });
});
