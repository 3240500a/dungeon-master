import { describe, it, expect } from 'vitest';
import type { Item } from '../types/items.js';
import { weaponDebuffs, elementDebuffs, weightScaleSplit } from './resolveWeapon.js';
import { armorClassModifiers, armorNoise, armorPoise } from './resolveArmor.js';
import { emptyPacket } from '../types/combat.js';
import { ConfigRegistry } from '../config/registry.js';

const wpn = (over: Partial<Item>): Item => over as unknown as Item;
// Справочники (классы брони, физ-подтипы, веса, типы урона) — из конфига (таблицы data-driven).
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const AC = reg.get('armor-classes');
const PS = reg.get('phys-subtypes');
const WW = reg.get('weapon-weights');
const DT = reg.get('damage-types');

describe('resolveWeapon', () => {
  it('доли скейла по весу: сверхлёгкое — Ловк, тяжёлое — Сила, магическое — Интеллект', () => {
    expect(weightScaleSplit('superlight', WW)).toEqual({ strength: 0, dexterity: 1, intelligence: 0 });
    expect(weightScaleSplit('heavy', WW)).toEqual({ strength: 1, dexterity: 0, intelligence: 0 });
    expect(weightScaleSplit('magical', WW)).toEqual({ strength: 0, dexterity: 0, intelligence: 1 });
  });

  it('подтип урона → свой дебафф; шанс НЕ зависит от веса (задаёт подтип)', () => {
    const dagger = weaponDebuffs(wpn({ physSub: 'piercing', weight: 'superlight' }), PS);
    const heavyAxe = weaponDebuffs(wpn({ physSub: 'chopping', weight: 'heavy' }), PS);
    expect(dagger[0]!.kind).toBe('wound');
    expect(heavyAxe[0]!.kind).toBe('sunder');

    // Вес больше не масштабирует шанс — база из подтипа одинакова для всех весов.
    const lightWound = weaponDebuffs(wpn({ physSub: 'piercing', weight: 'superlight' }), PS)[0]!.chance;
    const heavyWound = weaponDebuffs(wpn({ physSub: 'piercing', weight: 'heavy' }), PS)[0]!.chance;
    expect(lightWound).toBe(heavyWound);

    // Кровотечение — DoT: сила = доля от урона (magPerDamage), флэт-mag = 0.
    const bleed = weaponDebuffs(wpn({ physSub: 'slashing', weight: 'light' }), PS)[0]!;
    expect(bleed.kind).toBe('bleed');
    expect(bleed.magPerDamage).toBeGreaterThan(0);
    expect(bleed.mag).toBe(0);
  });

  it('без подтипа — дебаффов нет', () => {
    expect(weaponDebuffs(wpn({}), PS)).toHaveLength(0);
  });

  it('стих. урон в пакете → статус: огонь→поджиг (DoT), холод→заморозка (флэт)', () => {
    const pkt = emptyPacket();
    pkt.fire = 8; pkt.cold = 5;
    const els = elementDebuffs(pkt, DT);
    const kinds = els.map((e) => e.kind);
    expect(kinds).toContain('burn');
    expect(kinds).toContain('freeze');
    expect(kinds).not.toContain('shock');   // молнии в ударе нет
    const burn = els.find((e) => e.kind === 'burn')!;
    expect(burn.magPerDamage).toBeGreaterThan(0);  // поджиг — DoT (доля урона/сек)
    expect(burn.mag).toBe(0);
    const freeze = els.find((e) => e.kind === 'freeze')!;
    expect(freeze.mag).toBeGreaterThan(0);          // заморозка — флэт замедление
  });

  it('физический урон статуса не даёт; пустой пакет — пусто', () => {
    const phys = emptyPacket(); phys.physical = 20;
    expect(elementDebuffs(phys, DT)).toHaveLength(0);
    expect(elementDebuffs(emptyPacket(), DT)).toHaveLength(0);
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
