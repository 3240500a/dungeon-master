import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from './rng.js';
import { generateMonster, monsterCombatStats, buildMonsterPacket } from './monstergen.js';

const reg = new ConfigRegistry();
reg.loadAll();
const monsters = reg.get('monsters');
const affixes = reg.get('monster-affixes');

describe('generateMonster', () => {
  it('масштабирует базу по глубине', () => {
    const base = monsters.find((m) => m.id === 'skeleton')!;
    const m = generateMonster(monsters, affixes, { baseId: 'skeleton', depth: 5 }, createRng(1));
    expect(m.hp).toBeGreaterThan(base.hp);
    expect(m.xp).toBeGreaterThan(base.xp);
    expect(m.level).toBe(6);
    expect(m.maxDamage).toBeGreaterThanOrEqual(m.minDamage);
  });

  it('весь стат-блок растёт с глубиной (прогрессивно, включая уклонение)', () => {
    // Один сид → одинаковые роллы чемпиона/аффиксов, поэтому разница = чистое масштабирование.
    const d0 = generateMonster(monsters, affixes, { baseId: 'skeleton', depth: 0 }, createRng(1));
    const d10 = generateMonster(monsters, affixes, { baseId: 'skeleton', depth: 10 }, createRng(1));
    expect(d10.evade).toBeGreaterThan(d0.evade);        // раньше НЕ рос
    expect(d10.accuracy).toBeGreaterThan(d0.accuracy);
    expect(d10.armor).toBeGreaterThan(d0.armor);
    expect(d10.hp).toBeGreaterThan(d0.hp);
    expect(d10.blockChance).toBeGreaterThan(d0.blockChance);
    expect(d10.critChance).toBeGreaterThan(d0.critChance);
    expect(d10.resFire).toBeGreaterThan(d0.resFire);
  });

  it('детерминирован при одном seed', () => {
    const a = generateMonster(monsters, affixes, { baseId: 'skeleton', depth: 3 }, createRng(42));
    const b = generateMonster(monsters, affixes, { baseId: 'skeleton', depth: 3 }, createRng(42));
    expect(a).toEqual(b);
  });

  it('monsterCombatStats и пакет корректны', () => {
    const m = generateMonster(monsters, affixes, { baseId: 'skeleton', depth: 2 }, createRng(7));
    const cs = monsterCombatStats(m);
    expect(cs.level).toBe(m.level);
    expect(cs.armor).toBe(m.armor);
    const p = buildMonsterPacket(m, createRng(7));
    expect(p[m.damageType]).toBeGreaterThan(0);
  });
});
