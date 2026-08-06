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

  it('unique крупнее обычного и с регеном (элит-статы; чемпионов больше нет)', () => {
    const full = { itemAffixes: reg.get('affixes'), rarities: reg.get('rarities'), monsterRarity: reg.get('monster-rarity'), monsterUniques: reg.get('monster-uniques') };
    const normal = generateMonster(monsters, gear, affixes, { baseId: 'zombie', depth: 5, ...full, rarity: 'normal' }, createRng(2));
    const uniq = generateMonster(monsters, gear, affixes, { baseId: 'zombie', depth: 5, ...full, rarity: 'unique' }, createRng(2));
    expect(uniq.rarity).toBe('unique');
    expect(uniq.hp).toBeGreaterThan(normal.hp);
    expect(uniq.hpRegen).toBeGreaterThan(0);
  });

  it('monster-affixes: выключенные аффиксы не навешиваются', () => {
    const off = affixes.map((a) => ({ ...a, enabled: false }));
    for (let s = 0; s < 40; s++) {
      const m = generateMonster(monsters, gear, off, { baseId: 'zombie', depth: 5 }, createRng(s));
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

  it('детерминизм с редкостью', () => {
    const a = genR({ baseId: 'zombie', depth: 15, rarity: 'rare' }, 42);
    const b = genR({ baseId: 'zombie', depth: 15, rarity: 'rare' }, 42);
    expect(a).toEqual(b);
  });
});

const monsterRarity = reg.get('monster-rarity');
const monsterUniques = reg.get('monster-uniques');
const genG = (opts: Parameters<typeof generateMonster>[3], seed = 1) =>
  generateMonster(monsters, gear, affixes, { itemAffixes, rarities, monsterRarity, monsterUniques, ...opts }, createRng(seed));
const multiSlot = monsters.find((m) => m.armor && m.offhand) ?? monsters.find((m) => m.armor) ?? monsters[0]!;

describe('generateMonster — редкость по слотам гира (per-piece)', () => {
  it('gearRolls: разбивка по слотам, оружие прокачано первым, афиксы только на magic/rare', () => {
    const m = genG({ baseId: multiSlot.id, depth: 40, rarity: 'rare' }, 3);
    expect(m.gearRolls?.length).toBeGreaterThan(0);
    const rolls = m.gearRolls!;
    expect(rolls.some((r) => r.slot === 'weapon')).toBe(true);
    expect(rolls.find((r) => r.slot === 'weapon')!.rarity).toBe('rare'); // оружие прокачивается первым
    for (const r of rolls) if (r.rarity === 'normal') expect(r.affixes.length).toBe(0); // нормальные без афиксов
  });

  it('число прокачанных слотов растёт с уровнем (rare)', () => {
    const low = genG({ baseId: multiSlot.id, depth: 1, rarity: 'rare' }, 9);
    const high = genG({ baseId: multiSlot.id, depth: 60, rarity: 'rare' }, 9);
    const nLow = (low.gearRolls ?? []).filter((r) => r.rarity !== 'normal').length;
    const nHigh = (high.gearRolls ?? []).filter((r) => r.rarity !== 'normal').length;
    expect(nHigh).toBeGreaterThanOrEqual(nLow);
    expect(nLow).toBeGreaterThanOrEqual(1); // хотя бы оружие
  });

  it('derive-override: у моба со своим derive используются ЕГО коэффициенты, не общие', () => {
    const b = monsters.find((m) => m.id === 'zombie') ?? monsters[0]!;
    const fat = { ...b, derive: { ...reg.get('monster-derive'), hpPerVit: 100 } }; // жирный HP за Выносливость
    const monsters2 = monsters.map((m) => (m.id === b.id ? fat : m));
    const normal = generateMonster(monsters, gear, affixes, { baseId: b.id, depth: 5 }, createRng(1));
    const over = generateMonster(monsters2, gear, affixes, { baseId: b.id, depth: 5 }, createRng(1));
    expect(over.hp).toBeGreaterThan(normal.hp * 2); // hpPerVit 100 ≫ дефолтный → HP сильно больше
  });

  it('normal — все слоты normal, без афиксов', () => {
    const m = genG({ baseId: multiSlot.id, depth: 20, rarity: 'normal' }, 5);
    for (const r of m.gearRolls ?? []) { expect(r.rarity).toBe('normal'); expect(r.affixes.length).toBe(0); }
  });

  it('unique — уник-имя из пула + элит-статы + гир на ВСЕХ слотах', () => {
    const norm = genG({ baseId: multiSlot.id, depth: 20, rarity: 'normal' }, 7);
    const uniq = genG({ baseId: multiSlot.id, depth: 20, rarity: 'unique' }, 7);
    expect(uniq.rarity).toBe('unique');
    expect(uniq.hp).toBeGreaterThan(norm.hp);                                   // элит-статы (жирный HP)
    expect(monsterUniques.some((u) => u.name === uniq.name)).toBe(true);        // имя из пула
    const rolls = uniq.gearRolls ?? [];
    expect(rolls.length).toBeGreaterThan(0);
    expect(rolls.every((g) => g.rarity === 'unique')).toBe(true);               // все слоты — unique
  });
});

const monsterItemAffixes = reg.get('monster-item-affixes');
describe('generateMonster — монстровый пул аффиксов шмота (таргетинг по типу предмета)', () => {
  // Разрешён ли аффикс с данным appliesTo на данном слоте гира (грубо: weapon / armor|helm / shield).
  const slotAllowed = (appliesTo: string[], slot: string): boolean => {
    if (appliesTo.length === 0) return true;                                    // пустой appliesTo = любой тип
    if (slot === 'weapon') return appliesTo.some((t) => t === 'weapon' || t.startsWith('weapon.'));
    if (slot === 'armor' || slot === 'helm') return appliesTo.some((t) => t === 'armor');
    if (slot === 'shield') return appliesTo.some((t) => t === 'shield');
    return false;
  };
  const appliesOf = new Map(monsterItemAffixes.map((a) => [a.word, a.appliesTo]));

  it('аффикс садится ТОЛЬКО на разрешённый его appliesTo тип предмета (оружие/броня/щит)', () => {
    let sawWeapon = false, sawArmor = false;
    for (let s = 0; s < 60; s++) {
      const m = generateMonster(monsters, gear, affixes,
        { baseId: multiSlot.id, depth: 40, rarity: 'rare', itemAffixes: monsterItemAffixes, rarities, monsterRarity, monsterUniques }, createRng(s));
      for (const roll of m.gearRolls ?? []) {
        for (const word of roll.affixes) {
          const appliesTo = appliesOf.get(word);
          expect(appliesTo, `слово «${word}» должно быть из монстрового пула`).toBeDefined();
          expect(slotAllowed(appliesTo!, roll.slot), `«${word}» не должно падать на слот «${roll.slot}»`).toBe(true);
          if (roll.slot === 'weapon') sawWeapon = true;
          if (roll.slot === 'armor' || roll.slot === 'helm') sawArmor = true;
        }
      }
    }
    expect(sawWeapon).toBe(true); // покрытие: оружейные аффиксы реально катаются
    expect(sawArmor).toBe(true);  // и броневые тоже (иначе тест пустой)
  });

  it('нормальный монстр не берёт монстровых афиксов (пул подключён, но normal = без афиксов)', () => {
    const m = generateMonster(monsters, gear, affixes,
      { baseId: multiSlot.id, depth: 30, rarity: 'normal', itemAffixes: monsterItemAffixes, rarities, monsterRarity, monsterUniques }, createRng(3));
    expect(m.affixes).toEqual([]);
    for (const roll of m.gearRolls ?? []) expect(roll.affixes.length).toBe(0);
  });
});
