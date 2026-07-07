import { describe, it, expect } from 'vitest';
import { resolveAttack, hitChance, armorMitigation } from './combat.js';
import { emptyPacket, type CombatStats, type DamagePacket } from '../types/combat.js';
import type { Rng } from './rng.js';

/** Управляемый ГПСЧ: chance() берёт из очереди, float() возвращает заданное. */
function fakeRng(chances: boolean[], float = 0.5): Rng {
  const q = [...chances];
  return {
    next: () => 0.5,
    int: (a) => a,
    float: () => float,
    pick: (arr) => arr[0]!,
    chance: () => q.shift() ?? false,
  };
}

const base: CombatStats = {
  accuracy: 100, evade: 100, armor: 0, blockChance: 0,
  critChance: 0, critMultiplier: 2,
  resFire: 0, resCold: 0, resLightning: 0, resPoison: 0, level: 1,
};
const phys = (n: number): DamagePacket => ({ ...emptyPacket(), physical: n });

describe('resolveAttack', () => {
  it('промах — урон 0', () => {
    const r = resolveAttack(base, base, phys(100), fakeRng([false]));
    expect(r.hit).toBe(false);
    expect(r.total).toBe(0);
  });

  it('блок полностью гасит', () => {
    const def = { ...base, blockChance: 0.5 };
    const r = resolveAttack(base, def, phys(100), fakeRng([true, true]));
    expect(r.blocked).toBe(true);
    expect(r.total).toBe(0);
  });

  it('крит множит весь урон', () => {
    const att = { ...base, critChance: 1, critMultiplier: 2 };
    const r = resolveAttack(att, base, phys(100), fakeRng([true, false, true]));
    expect(r.crit).toBe(true);
    expect(r.total).toBe(200);
  });

  it('сопротивление режет стихию', () => {
    const def = { ...base, resFire: 0.5 };
    const r = resolveAttack(base, def, { ...emptyPacket(), fire: 100 }, fakeRng([true, false, false]));
    expect(r.total).toBe(50);
  });

  it('броня режет физ. урон', () => {
    const def = { ...base, armor: 70 }; // mit = 70/(70+30+5) = 0.667
    const r = resolveAttack(base, def, phys(100), fakeRng([true, false, false]));
    expect(r.total).toBe(33);
  });
});

describe('вспомогательные', () => {
  it('hitChance зажат в 0.05..0.95', () => {
    expect(hitChance(1, 1000)).toBeCloseTo(0.05, 5);
    expect(hitChance(1000, 1)).toBeCloseTo(0.95, 5);
  });
  it('armorMitigation растёт с бронёй', () => {
    expect(armorMitigation(0, 1)).toBe(0);
    expect(armorMitigation(100, 1)).toBeGreaterThan(armorMitigation(50, 1));
  });
});
