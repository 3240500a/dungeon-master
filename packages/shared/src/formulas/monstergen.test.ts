import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from './rng.js';
import { generateMonster, monsterCombatStats, buildMonsterPacket } from './monstergen.js';

const reg = new ConfigRegistry();
reg.loadAll();
const monsters = reg.get('monsters');
const gear = reg.get('monster-gear');
const affixes = reg.get('monster-affixes');
const gen = (opts: Parameters<typeof generateMonster>[3], seed = 1) =>
  generateMonster(monsters, gear, affixes, opts, createRng(seed));

describe('generateMonster (деривация из атрибутов+гира)', () => {
  it('деривит валидный стат-блок из заготовки', () => {
    const m = gen({ baseId: 'zombie', depth: 5 });
    expect(m.hp).toBeGreaterThan(0);
    expect(m.level).toBe(6);
    expect(m.maxDamage).toBeGreaterThanOrEqual(m.minDamage);
    expect(m.damage).toBeGreaterThan(0);
    expect(Number.isFinite(m.accuracy)).toBe(true);
  });

  it('весь стат-блок растёт с глубиной (hp/урон/меткость/xp)', () => {
    // Один сид → одинаковые роллы чемпиона/аффиксов, поэтому разница = чистое масштабирование уровнем.
    const d0 = gen({ baseId: 'zombie', depth: 0 });
    const d10 = gen({ baseId: 'zombie', depth: 10 });
    expect(d10.hp).toBeGreaterThan(d0.hp);
    expect(d10.maxDamage).toBeGreaterThan(d0.maxDamage);
    expect(d10.accuracy).toBeGreaterThan(d0.accuracy);
    expect(d10.xp).toBeGreaterThan(d0.xp);
  });

  it('детерминирован при одном seed', () => {
    const a = gen({ baseId: 'zombie', depth: 3 }, 42);
    const b = gen({ baseId: 'zombie', depth: 3 }, 42);
    expect(a).toEqual(b);
  });

  it('чемпион крупнее и с регеном', () => {
    // сид, дающий чемпиона через forceChampion — сравним с обычным той же заготовки.
    const normal = generateMonster(monsters, gear, affixes, { baseId: 'zombie', depth: 5 }, createRng(2));
    const champ = generateMonster(monsters, gear, affixes, { baseId: 'zombie', depth: 5, forceChampion: true }, createRng(2));
    expect(champ.rarity).toBe('champion');
    expect(champ.hp).toBeGreaterThan(normal.hp);
    expect(champ.hpRegen).toBeGreaterThan(0);
    expect(champ.name).toContain('Чемпион');
  });

  it('monster-affixes: выключенные аффиксы не навешиваются даже на чемпиона', () => {
    const off = affixes.map((a) => ({ ...a, enabled: false }));
    for (let s = 0; s < 40; s++) {
      const m = generateMonster(monsters, gear, off, { baseId: 'zombie', depth: 5, forceChampion: true }, createRng(s));
      expect(m.affixes).toEqual([]);
    }
  });

  it('monsterCombatStats и пакет корректны', () => {
    const m = gen({ baseId: 'zombie', depth: 2 }, 7);
    const cs = monsterCombatStats(m);
    expect(cs.level).toBe(m.level);
    expect(cs.armor).toBe(m.armor);
    const p = buildMonsterPacket(m, createRng(7));
    expect(p[m.damageType]).toBeGreaterThan(0);
  });

  it('дальнобойная заготовка получает ranged-kiter AI из оружия', () => {
    const archer = gen({ baseId: 'zombie-archer', depth: 1 });
    expect(archer.ai).toBe('ranged-kiter');
  });
});

const itemAffixes = reg.get('affixes');
const rarities = reg.get('rarities');
const genR = (opts: Parameters<typeof generateMonster>[3], seed = 1) =>
  generateMonster(monsters, gear, affixes, { itemAffixes, rarities, ...opts }, createRng(seed));

describe('generateMonster — редкость через гир-афиксы (item-движок)', () => {
  it('normal → без афиксов; magic → rarity=magic и падают афиксы', () => {
    const norm = genR({ baseId: 'zombie', depth: 20, rarity: 'normal' }, 5);
    expect(norm.rarity).toBe('normal');
    expect(norm.affixes).toEqual([]);
    let found = false;
    for (let s = 0; s < 30 && !found; s++) {
      const m = genR({ baseId: 'zombie', depth: 20, rarity: 'magic' }, s);
      expect(m.rarity).toBe('magic');
      if (m.affixes.length > 0) found = true;
    }
    expect(found).toBe(true); // хотя бы один сид дал magic-афикс
  });

  it('гир-афиксы двигают статы (magic отличается от normal при том же сиде)', () => {
    let diff = false;
    for (let s = 0; s < 40 && !diff; s++) {
      const n = genR({ baseId: 'zombie', depth: 30, rarity: 'normal' }, s);
      const m = genR({ baseId: 'zombie', depth: 30, rarity: 'magic' }, s);
      if (m.affixes.length > 0 && (m.hp !== n.hp || m.minDamage !== n.minDamage || m.armor !== n.armor || m.accuracy !== n.accuracy || m.critChance !== n.critChance || m.resFire !== n.resFire || m.attackSpeed !== n.attackSpeed)) diff = true;
    }
    expect(diff).toBe(true);
  });

  it('чемпион с rarity=normal всё равно получает гир-афиксы (эффективно magic)', () => {
    let any = false;
    for (let s = 0; s < 20 && !any; s++) {
      const m = genR({ baseId: 'zombie', depth: 20, forceChampion: true, rarity: 'normal' }, s);
      expect(m.rarity).toBe('champion'); // champion перекрывает поле rarity
      if (m.affixes.length > 0) any = true;
    }
    expect(any).toBe(true);
  });

  it('детерминизм с редкостью', () => {
    const a = genR({ baseId: 'zombie', depth: 15, rarity: 'rare' }, 42);
    const b = genR({ baseId: 'zombie', depth: 15, rarity: 'rare' }, 42);
    expect(a).toEqual(b);
  });
});
