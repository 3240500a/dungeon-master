import { describe, it, expect } from 'vitest';
import { createRng } from './rng.js';
import { levelForXp, xpForLevel } from './xp.js';
import { deriveStats, meetsRequirements } from './stats.js';
import { generateItem, rollRarity } from './itemgen.js';
import { ConfigRegistry } from '../config/registry.js';
import type { Attributes } from '../types/attributes.js';
import { DEFAULT_HP_MANA_SCALING } from '../types/attributes.js';
import type { Item } from '../types/items.js';

const reg = new ConfigRegistry();
reg.loadAll();
const balance = reg.get('balance');

describe('xp', () => {
  const t = balance.xpTable;
  it('levelForXp растёт по таблице', () => {
    expect(levelForXp(0, t)).toBe(1);
    expect(levelForXp(t[2]!, t)).toBe(2); // ровно порог 2-го уровня
    expect(levelForXp(t[2]! - 1, t)).toBe(1); // чуть меньше — ещё 1-й
    expect(levelForXp(Number.MAX_SAFE_INTEGER, t)).toBe(t.length - 1);
  });
  it('xpForLevel согласован с таблицей и монотонен', () => {
    expect(xpForLevel(2, t)).toBe(t[2]);
    expect(xpForLevel(30, t)).toBeGreaterThan(xpForLevel(29, t));
  });
  // ⚠ R20-05: негодную кривую отвергает схема; формула — вторая линия: по ступеньке (порог не выше прежнего) она не лезет, иначе кривая,
  // прошедшая мимо схемы, подняла бы героя 10-го с одного очка опыта до 20-го. На годной кривой — то же, что прежде.
  it('R20-05: по ступеньке кривой (мимо схемы) уровень не лезет', () => {
    const typo = t.map((v, i) => (i >= 11 && i <= 20 ? 100 : v));
    expect(levelForXp(t[10]! + 1, typo), 'ступенька xp[11..20] = 100').toBe(10);
    const dup = t.map((v, i) => (i === 30 ? t[29]! : v));
    expect(levelForXp(t[31]!, dup), 'повтор порога').toBe(29);
    const neg = t.map((v, i) => (i === 5 ? -1 : v));
    expect(levelForXp(t[6]!, neg), 'минус').toBe(4);
    const nan = t.map((v, i) => (i === 5 ? Number.NaN : v));
    expect(levelForXp(t[6]!, nan), 'NaN').toBe(4);
    for (const xp of [0, 1, t[2]! - 1, t[2]!, t[10]!, t[10]! + 1, t[50]! - 1, Number.MAX_SAFE_INTEGER]) {
      let want = 1;
      for (let i = 2; i < t.length && xp >= t[i]!; i++) want = i;
      expect(levelForXp(xp, t), `годная кривая, опыт ${xp}`).toBe(want);
    }
  });
});

describe('stats', () => {
  const attrs: Attributes = {
    strength: 20,
    dexterity: 15,
    intelligence: 10,
    vitality: 20,
  };
  it('deriveStats считает hp/mana/выносливость от атрибутов', () => {
    const s = deriveStats(attrs);
    expect(s.maxHp).toBe(50 + 20 * 5); // Живучесть
    expect(s.maxMana).toBe(20 + 10 * 3 + 20 * 1); // Интеллект + Живучесть
    expect(s.maxStamina).toBe(40 + 20 * 2 + 15 * 1.5); // Сила + Ловкость
  });
  it('moveSpeed = база × классовый множитель; attackMoveMult проходит из scaling', () => {
    const def = deriveStats(attrs);
    expect(def.moveSpeed).toBe(120);       // дефолт: база 120 × множитель 1
    expect(def.attackMoveMult).toBe(0.2);  // дефолт замедления при атаке
    const tuned = deriveStats(attrs, [], { ...DEFAULT_HP_MANA_SCALING, moveSpeedMult: 1.5, attackMoveMult: 0.5 }, 1, 200);
    expect(tuned.moveSpeed).toBe(200 * 1.5);   // база 200 × множитель 1.5
    expect(tuned.attackMoveMult).toBe(0.5);
  });
  it('meetsRequirements проверяет требования', () => {
    const sword: Item = {
      uid: 'x', baseId: 'short-sword', name: 'меч', slot: 'weapon',
      attackType: 'melee', damageKind: 'physical', rarity: 'normal', itemLevel: 1,
      requirements: { strength: 15 }, affixes: [], baseStats: [],
      gridW: 1, gridH: 3, pos: null,
    };
    expect(meetsRequirements(sword, attrs)).toBe(true);
    expect(meetsRequirements(sword, { ...attrs, strength: 10 })).toBe(false);
  });
});

describe('itemgen', () => {
  it('rollRarity детерминирован при одном seed', () => {
    expect(rollRarity(1, createRng(5), reg.get('rarities'))).toBe(rollRarity(1, createRng(5), reg.get('rarities')));
  });
  it('generateItem возвращает валидный предмет с базой из конфига', () => {
    const item = generateItem(
      reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { dropBias: 1, itemLevel: 5, rarities: reg.get('rarities') }, createRng(123),
    );
    expect(item.uid).toBeTruthy();
    expect(reg.get('items.base').some((b) => b.id === item.baseId)).toBe(true);
  });

  it('тир масштабирует базу оружия по itemLevel (глубже = сильнее)', () => {
    const tiers = reg.get('item-tiers');
    const opts = { dropBias: 0, tiers, rarities: reg.get('rarities') } as const; // dropBias 0 → всегда normal (без аффиксов)
    const flat = (it: ReturnType<typeof generateItem>, stat: string) =>
      it.baseStats.filter((m) => m.stat === stat && m.kind === 'flat').reduce((s, m) => s + m.value, 0);

    // Лестница начинается с «Убогого» (базовый ×1.0): ilvl 1 → Убогий,
    // ilvl 80 → высший «Мифический». Имя всегда с префиксом, согласованным по роду.
    const low = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { ...opts, itemLevel: 1, baseId: 'mace' }, createRng(1));
    const high = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { ...opts, itemLevel: 80, baseId: 'mace' }, createRng(1));

    expect(flat(high, 'maxDamage')).toBeGreaterThan(flat(low, 'maxDamage'));
    expect((high.requirements.strength ?? 0)).toBeGreaterThan(low.requirements.strength ?? 0);
    // Булава — женский род → «Убогая»/«Мифическая», а не «Убогий».
    expect(low.name).toBe('Убогая Булава');
    expect(high.name.startsWith('Мифическая')).toBe(true);
    expect(high.name.endsWith('Булава')).toBe(true);

    // ⚠ Множественное и средний род — отдельные ветки правила: у основы на г/к/х множественное
    // «-ие», а не «-ые» («Убогие перчатки», а не «Убогые»). Переименуешь тир — тест скажет, если слово не склоняется.
    const plural = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { ...opts, itemLevel: 1, baseId: 'quilted-gloves' }, createRng(1));
    expect(plural.name.startsWith('Убогие ')).toBe(true);
    const neuter = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { ...opts, itemLevel: 1, baseId: 'spear' }, createRng(1));
    expect(neuter.name.startsWith('Убогое ')).toBe(true);
  });

  it('щит — отдельный вид (kind=shield, shieldClass), без armorClass', () => {
    const shield = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { dropBias: 0, itemLevel: 1, baseId: 'wooden-shield', tiers: reg.get('item-tiers'), rarities: reg.get('rarities') }, createRng(1));
    expect(shield.kind).toBe('shield');
    expect(shield.shieldClass).toBe('medium');
    expect(shield.armorClass).toBeUndefined();
  });

  it('itemLevel базы выводится из minTier (не задаётся руками)', () => {
    const base = reg.get('items.base').find((b) => b.id === 'spear')!;
    expect('itemLevel' in base).toBe(false); // поля в базе больше нет
    const tiers = reg.get('item-tiers');
    // Копьё с minTier=t0 (порог 1): при вызове уровня 1 → itemLevel 1.
    const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'),
      { dropBias: 0, itemLevel: 1, baseId: 'spear', tiers, rarities: reg.get('rarities') }, createRng(1));
    expect(it.itemLevel).toBe(tiers.find((t) => t.id === base.minTier)!.minItemLevel);
  });
});
