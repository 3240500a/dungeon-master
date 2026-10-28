import { describe, it, expect } from 'vitest';
import { deriveMonsterStats, DEFAULT_MDERIVE, type MonsterTemplate } from './monsterDerive.js';
import type { ConfigShapes } from '../config/schemas.js';
import { ConfigRegistry } from '../config/registry.js';

type Gear = ConfigShapes['monster-gear'][number];
type GearWeapon = Extract<Gear, { kind: 'weapon' }>;
type GearArmor = Extract<Gear, { kind: 'armor' }>;
type GearShield = Extract<Gear, { kind: 'shield' }>;

const sword: GearWeapon = {
  kind: 'weapon', id: 'w-sword', name: 'меч', faction: 'undead', enabled: true, minGearTier: 'm0', maxGearTier: 'm19', withLevel: true,
  weaponClass: 'sword', weight: 'medium', attackType: 'melee', hands: 1,
  damageType: 'physical', minDamage: 3, maxDamage: 6, attackSpeed: 1,
};
const bow: GearWeapon = {
  kind: 'weapon', id: 'w-bow', name: 'лук', faction: 'undead', enabled: true, minGearTier: 'm0', maxGearTier: 'm19', withLevel: true,
  weaponClass: 'bow', weight: 'light', attackType: 'ranged', hands: 2,
  damageType: 'physical', minDamage: 2, maxDamage: 5, attackSpeed: 1,
};
const staff: GearWeapon = {
  kind: 'weapon', id: 'w-staff', name: 'посох', faction: 'undead', enabled: true, minGearTier: 'm0', maxGearTier: 'm19', withLevel: true,
  weaponClass: 'staff', weight: 'magical', attackType: 'ranged', hands: 2,
  damageType: 'cold', minDamage: 4, maxDamage: 8, attackSpeed: 0.8,
};
const plate: GearArmor = {
  kind: 'armor', id: 'a-plate', name: 'латы', faction: 'undead', enabled: true, minGearTier: 'm0', maxGearTier: 'm19', withLevel: true,
  armorClass: 'plate', slot: 'chest', defense: 30,
};
const shield: GearShield = {
  kind: 'shield', id: 's-shield', name: 'щит', faction: 'undead', enabled: true, minGearTier: 'm0', maxGearTier: 'm19', withLevel: true,
  block: 0.18, defense: 6,
};

const base: MonsterTemplate = {
  id: 'm', name: 'моб', faction: 'undead', sprite: 'skeleton',
  str: 10, dex: 10, int: 10, vit: 10,
};

describe('deriveMonsterStats', () => {
  it('produces every MonsterDef field, no NaN', () => {
    const d = deriveMonsterStats(base, sword, plate, null, 1);
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true);
    }
    expect(d.id).toBe('m');
    expect(d.faction).toBe('undead');
    expect(d.sprite).toBe('skeleton');
    expect(d.hp).toBeGreaterThan(0);
    expect(d.maxDamage).toBeGreaterThanOrEqual(d.minDamage);
  });

  it('VIT drives HP', () => {
    const tanky = deriveMonsterStats({ ...base, vit: 40 }, sword, null, null, 1);
    const frail = deriveMonsterStats({ ...base, vit: 5 }, sword, null, null, 1);
    expect(tanky.hp).toBeGreaterThan(frail.hp);
  });

  it('STR drives melee damage + armor', () => {
    const strong = deriveMonsterStats({ ...base, str: 40 }, sword, plate, null, 1);
    const weak = deriveMonsterStats({ ...base, str: 5 }, sword, plate, null, 1);
    expect(strong.maxDamage).toBeGreaterThan(weak.maxDamage);
    expect(strong.armor).toBeGreaterThan(weak.armor);
  });

  it('DEX drives accuracy, evade, ranged damage', () => {
    const nimble = deriveMonsterStats({ ...base, dex: 40 }, bow, null, null, 1);
    const clumsy = deriveMonsterStats({ ...base, dex: 5 }, bow, null, null, 1);
    expect(nimble.accuracy).toBeGreaterThan(clumsy.accuracy);
    expect(nimble.evade).toBeGreaterThan(clumsy.evade);
    expect(nimble.maxDamage).toBeGreaterThan(clumsy.maxDamage); // bow scales DEX
  });

  it('INT drives magical weapon damage', () => {
    const smart = deriveMonsterStats({ ...base, int: 40 }, staff, null, null, 1);
    const dull = deriveMonsterStats({ ...base, int: 5 }, staff, null, null, 1);
    expect(smart.maxDamage).toBeGreaterThan(dull.maxDamage);
    expect(smart.damageType).toBe('cold');
  });

  it('AI + damageType derive from weapon', () => {
    expect(deriveMonsterStats(base, sword, null, null, 1).ai).toBe('melee-chaser');
    expect(deriveMonsterStats(base, bow, null, null, 1).ai).toBe('ranged-kiter');
    expect(deriveMonsterStats(base, sword, null, null, 1).damageType).toBe('physical');
  });

  it('explicit ai overrides weapon inference', () => {
    expect(deriveMonsterStats({ ...base, ai: 'stationary' }, sword, null, null, 1).ai).toBe('stationary');
  });

  it('shield grants block; no shield → 0', () => {
    expect(deriveMonsterStats(base, sword, plate, shield, 1).blockChance).toBe(0.18);
    expect(deriveMonsterStats(base, sword, plate, null, 1).blockChance).toBe(0);
  });

  it('undead resists poison, weak to fire', () => {
    const d = deriveMonsterStats(base, sword, null, null, 1);
    expect(d.resPoison).toBeGreaterThan(0);
    expect(d.resFire).toBeLessThan(0);
  });

  it('scales with level (hp, damage, accuracy grow)', () => {
    const lo = deriveMonsterStats(base, sword, plate, null, 1);
    const hi = deriveMonsterStats(base, sword, plate, null, 15);
    expect(hi.hp).toBeGreaterThan(lo.hp);
    expect(hi.maxDamage).toBeGreaterThan(lo.maxDamage);
    expect(hi.accuracy).toBeGreaterThan(lo.accuracy);
    expect(hi.xp).toBeGreaterThan(lo.xp);
  });

  it('tier multiplies xp', () => {
    const weak = deriveMonsterStats({ ...base, tier: 'weak' }, sword, null, null, 5);
    const boss = deriveMonsterStats({ ...base, tier: 'boss' }, sword, null, null, 5);
    expect(boss.xp).toBeGreaterThan(weak.xp);
  });

  it('коэффициенты деривации (конфиг) управляют крутизной кривой', () => {
    const steep = { ...DEFAULT_MDERIVE, levelGrowth: 0.3, hpPerVit: 2 };
    const lo = deriveMonsterStats(base, sword, plate, null, 90);
    const hi = deriveMonsterStats(base, sword, plate, null, 90, steep);
    expect(hi.hp).toBeGreaterThan(lo.hp * 1.5);
  });

  it('xp берётся из xpBase/xpPerLevel/tierXp конфига', () => {
    const s = { ...DEFAULT_MDERIVE, xpBase: 100, xpPerLevel: 0 };
    expect(deriveMonsterStats(base, sword, null, null, 1, s).xp).toBe(100); // medium tierXp=1
  });
});

/**
 * ⭐ БЛОКЕР ПЛАНА «Монстры: план по силе» (13.10): две вещи, из-за которых правка кривой НЕ ДОЕЗЖАЛА до игры.
 *
 * 1. `DEFAULT_MDERIVE` расходился с `monster-derive.json` (`hpPerLevel` 1 против 5): тесты и инструменты без реестра
 *    меряли ДРУГУЮ игру, и сверка «в симе так, в игре иначе» упиралась в это.
 * 2. У 18 из 19 монстров в `monsters.json` лежала ПОЛНАЯ КОПИЯ базовых коэффициентов (16 ключей, все
 *    равны базе): правка `monster-derive.json` меняла ровно одного монстра из 19. Оверрайд остаётся правом
 *    монстра отличаться — но только ТЕМИ ключами, которые действительно другие; ключ равный базе — шум, который
 *    глушит правку баланса.
 */
describe('⭐ коэффициенты деривации: дефолт ≡ данные, оверрайд ≡ отличие', () => {
  const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

  it('⭐ `DEFAULT_MDERIVE` совпадает с `monster-derive.json` поле в поле', () => {
    const data = reg.get('monster-derive') as unknown as Record<string, unknown>;
    const dflt = DEFAULT_MDERIVE as unknown as Record<string, unknown>;
    const bad = Object.keys(data)
      .filter((k) => JSON.stringify(dflt[k]) !== JSON.stringify(data[k]))
      .map((k) => `${k}: дефолт ${JSON.stringify(dflt[k])} против данных ${JSON.stringify(data[k])}`);
    expect(bad, 'дефолт кода расходится с живым конфигом').toEqual([]);
    expect(Object.keys(data).length, 'сторож что-то мерит').toBeGreaterThan(10);
  });

  it('⭐ в `monsters.json` нет оверрайдов-копий: каждый ключ `derive` реально отличается от базы', () => {
    const data = reg.get('monster-derive') as unknown as Record<string, unknown>;
    const noise: string[] = [];
    for (const m of reg.get('monsters')) {
      const ovr = (m as { derive?: Record<string, unknown> }).derive;
      if (!ovr) continue;
      for (const k of Object.keys(ovr)) {
        if (JSON.stringify(ovr[k]) === JSON.stringify(data[k])) noise.push(`${m.id}.derive.${k}`);
      }
    }
    expect(noise, 'ключ равен базе — убрать, иначе правка баланса монстра не касается').toEqual([]);
  });
});
