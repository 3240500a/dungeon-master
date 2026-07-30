import { describe, it, expect } from 'vitest';
import type { Item } from '../types/items.js';
import { weaponDebuffs, elementDebuffs, mergeElementOnHit, shapeSkillPacket, weightScaleSplit } from './resolveWeapon.js';
import { skillWeaponAllowed } from './skills.js';
import type { DebuffApply } from '../world/debuffs.js';
import { armorClassModifiers, armorNoise, armorPoise } from './resolveArmor.js';
import { emptyPacket } from '../types/combat.js';
import { ConfigRegistry } from '../config/registry.js';

const wpn = (over: Partial<Item>): Item => over as unknown as Item;
// Справочники (классы брони, физ-подтипы, веса, маг. подтипы) — из конфига (таблицы data-driven).
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const AC = reg.get('armor-classes');
const PS = reg.get('phys-subtypes');
const WW = reg.get('weapon-weights');
const MS = reg.get('magic-subtypes');
const DB = reg.get('debuffs');

describe('resolveWeapon', () => {
  it('доли скейла по весу: сверхлёгкое — Ловк, тяжёлое — Сила, магическое — Интеллект', () => {
    expect(weightScaleSplit('superlight', WW)).toEqual({ strength: 0, dexterity: 1, intelligence: 0 });
    expect(weightScaleSplit('heavy', WW)).toEqual({ strength: 1, dexterity: 0, intelligence: 0 });
    expect(weightScaleSplit('magical', WW)).toEqual({ strength: 0, dexterity: 0, intelligence: 1 });
  });

  it('подтип урона → свой дебафф; шанс НЕ зависит от веса (задаёт подтип)', () => {
    const dagger = weaponDebuffs(wpn({ physSub: 'piercing', weight: 'superlight' }), PS, DB);
    const heavyAxe = weaponDebuffs(wpn({ physSub: 'chopping', weight: 'heavy' }), PS, DB);
    expect(dagger[0]!.kind).toBe('wound');
    expect(heavyAxe[0]!.kind).toBe('sunder');

    // Вес больше не масштабирует шанс — база из подтипа одинакова для всех весов.
    const lightWound = weaponDebuffs(wpn({ physSub: 'piercing', weight: 'superlight' }), PS, DB)[0]!.chance;
    const heavyWound = weaponDebuffs(wpn({ physSub: 'piercing', weight: 'heavy' }), PS, DB)[0]!.chance;
    expect(lightWound).toBe(heavyWound);

    // Кровотечение — DoT: сила = доля от урона (magPerDamage), флэт-mag = 0.
    const bleed = weaponDebuffs(wpn({ physSub: 'slashing', weight: 'light' }), PS, DB)[0]!;
    expect(bleed.kind).toBe('bleed');
    expect(bleed.magPerDamage).toBeGreaterThan(0);
    expect(bleed.mag).toBe(0);
  });

  it('без подтипа — дебаффов нет', () => {
    expect(weaponDebuffs(wpn({}), PS, DB)).toHaveLength(0);
  });

  it('гейт оружия скилла: класс/руки/damageKind/дуал', () => {
    const sword = wpn({ weaponClass: 'sword', attackType: 'melee', damageKind: 'physical', hands: 1 });
    const axe = wpn({ weaponClass: 'axe', attackType: 'melee', damageKind: 'physical', hands: 1 });
    const wand = wpn({ weaponClass: 'wand', attackType: 'ranged', damageKind: 'magical', hands: 1 });
    expect(skillWeaponAllowed({ weaponClasses: ['axe'] }, sword)).toBe(false);   // скилл топоров мечом нельзя
    expect(skillWeaponAllowed({ weaponClasses: ['axe'] }, axe)).toBe(true);
    expect(skillWeaponAllowed({}, sword)).toBe(true);                            // пустой гейт — любое
    expect(skillWeaponAllowed({}, undefined)).toBe(true);
    expect(skillWeaponAllowed({ damageKinds: ['magical'] }, sword)).toBe(false); // маг-скилл только магией
    expect(skillWeaponAllowed({ damageKinds: ['magical'] }, wand)).toBe(true);
    expect(skillWeaponAllowed({ hands: 'two' }, sword)).toBe(false);             // 2 руки — одноручным нельзя
    expect(skillWeaponAllowed({ hands: 'two' }, wpn({ hands: 2 }))).toBe(true);
    expect(skillWeaponAllowed({ requiresDual: true }, sword)).toBe(false);       // дуал — нужен оффхенд-оружие
    expect(skillWeaponAllowed({ requiresDual: true }, sword, axe)).toBe(true);
  });

  it('стих. урон в пакете → статус: огонь→поджиг (DoT), холод→заморозка (флэт)', () => {
    const pkt = emptyPacket();
    pkt.fire = 8; pkt.cold = 5;
    const els = elementDebuffs(pkt, MS, DB);
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
    expect(elementDebuffs(phys, MS, DB)).toHaveLength(0);
    expect(elementDebuffs(emptyPacket(), MS, DB)).toHaveLength(0);
  });

  it('mergeElementOnHit: физ. урон есть → physSub держится + стих-проки', () => {
    const physSub: DebuffApply = { kind: 'sunder', chance: 0.5, maxStacks: 5, durationMs: 4000, mag: 0.04 };
    const pkt = emptyPacket(); pkt.physical = 20; pkt.fire = 8;
    const kinds = mergeElementOnHit([physSub], pkt, MS, DB).map((d) => d.kind);
    expect(kinds).toContain('sunder');   // физ-подтип держится (есть физ. урон)
    expect(kinds).toContain('burn');     // + стих-прок огня
  });

  it('mergeElementOnHit: полная конверсия (физ=0) → physSub гаснет, только стихия', () => {
    const physSub: DebuffApply = { kind: 'sunder', chance: 0.5, maxStacks: 5, durationMs: 4000, mag: 0.04 };
    const pkt = emptyPacket(); pkt.cold = 15;   // всё сконвертили в холод, физ. урона нет
    const kinds = mergeElementOnHit([physSub], pkt, MS, DB).map((d) => d.kind);
    expect(kinds).not.toContain('sunder');  // физ-статус погас
    expect(kinds).toEqual(['freeze']);       // остался только статус стихии
  });

  it('shapeSkillPacket: multScope=base множит только баз. тип (стихии гира не раздуваются)', () => {
    const p = emptyPacket(); p.physical = 10; p.fire = 5;
    shapeSkillPacket(p, { mult: 2, multScope: 'base', addElementPct: 0, convertPct: 0, baseType: 'physical', element: 'physical' });
    expect(p.physical).toBe(20);  // база ×2
    expect(p.fire).toBe(5);       // стихия гира не тронута
  });

  it('shapeSkillPacket: multScope=all множит весь пакет', () => {
    const p = emptyPacket(); p.physical = 10; p.fire = 5;
    shapeSkillPacket(p, { mult: 2, multScope: 'all', addElementPct: 0, convertPct: 0, baseType: 'physical', element: 'physical' });
    expect(p.physical).toBe(20); expect(p.fire).toBe(10);
  });

  it('shapeSkillPacket: convertPct=1 сливает весь урон в стихию', () => {
    const p = emptyPacket(); p.physical = 10; p.fire = 5;
    shapeSkillPacket(p, { mult: 1, multScope: 'base', addElementPct: 0, convertPct: 1, baseType: 'physical', element: 'cold' });
    expect(p.physical).toBe(0); expect(p.fire).toBe(0); expect(p.cold).toBe(15);
  });

  it('shapeSkillPacket: addElementPct добавляет % базы как стихию, прочее не трогает', () => {
    const p = emptyPacket(); p.physical = 10; p.fire = 4;
    shapeSkillPacket(p, { mult: 1, multScope: 'base', addElementPct: 0.3, convertPct: 0, baseType: 'physical', element: 'cold' });
    expect(p.physical).toBe(10);          // база на месте
    expect(p.fire).toBe(4);               // стихия гира на месте
    expect(p.cold).toBeCloseTo(3, 5);     // +30% базы холодом
  });

  it('mergeElementOnHit: явный статус того же вида не задваивается', () => {
    const explicitBurn: DebuffApply = { kind: 'burn', chance: 0.9, maxStacks: 1, durationMs: 5000, mag: 0, magPerDamage: 0.3 };
    const pkt = emptyPacket(); pkt.physical = 10; pkt.fire = 8;
    const burns = mergeElementOnHit([explicitBurn], pkt, MS, DB).filter((d) => d.kind === 'burn');
    expect(burns).toHaveLength(1);               // один поджиг
    expect(burns[0]!.chance).toBe(0.9);          // и именно явный (авто-прок не добавился)
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
