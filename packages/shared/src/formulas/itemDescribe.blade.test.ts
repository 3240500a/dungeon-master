import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { describeItem } from './itemDescribe.js';
import { itemFromBaseId } from './itemgen.js';
import { clampStep, craftWeapon, partById, variantsFor } from './craft.js';
import { axisOf, bladeStats } from './bladeStats.js';
import { CRAFT_SLOT_LIST } from './craftType.js';
import type { CraftParts, Item } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';

/**
 * Подсказка вещи после §26: блок базы и блок точки баланса клинка — ОДНОЙ строкой суммой («Блок 9 %»),
 * а не двумя слагаемыми; сумма в ноль строку не печатает (docs/CRAFT_WEAPONS.md §26).
 */

const reg = new ConfigRegistry();
reg.loadAll();
const LABELS = { armorClass: (id: string) => id, weight: (id: string) => id, physSub: (id: string) => id, skill: (id: string) => id, dmgShort: (dt: string) => dt };
const lines = (it: Item): string[] => describeItem(it, LABELS).map((l) => l.text);
const sword = (): Item => itemFromBaseId(reg.get('items.base'), 'long-sword', reg.get('item-tiers'))!;
const mod = (stat: string, value: number, kind: 'flat' | 'increased' = 'flat'): StatModifier => ({ stat, kind, value } as StatModifier);

describe('⭐ подсказка: одинаковые моды — одной строкой суммой (§26)', () => {
  it('два плоских блока — одна строка с суммой, слагаемых нет', () => {
    const it = sword();
    const own = it.baseStats.find((m) => m.stat === 'blockChance' && m.kind === 'flat')!.value;
    it.baseStats = [...it.baseStats, mod('blockChance', 0.01)];
    const block = lines(it).filter((t) => /Блок/.test(t));
    expect(block).toEqual([`+${Math.round((own + 0.01) * 100)}% Блок`]);
  });
  it('сумма в ноль строку не печатает; отрицательная сумма — со знаком минус', () => {
    const it = sword();
    const own = it.baseStats.find((m) => m.stat === 'blockChance' && m.kind === 'flat')!.value;
    it.baseStats = [...it.baseStats, mod('blockChance', -own)];
    expect(lines(it).some((t) => /Блок/.test(t))).toBe(false);
    it.baseStats = [...it.baseStats, mod('blockChance', -0.02)];
    expect(lines(it).filter((t) => /Блок/.test(t))).toEqual(['−2% Блок']);
  });
  it('разные виды одного стата не сливаются; подсказка не мутирует статы вещи', () => {
    const it = sword();
    it.baseStats = [...it.baseStats, mod('accuracy', 3), mod('accuracy', 0.1, 'increased')];
    const before = structuredClone(it.baseStats);
    const acc = lines(it).filter((t) => /Меткость/.test(t));
    const own = before.filter((m) => m.stat === 'accuracy' && m.kind === 'flat').reduce((s, m) => s + m.value, 0);
    expect(acc).toEqual([`+${own} Меткость`, '+10% Меткость']);
    expect(it.baseStats).toEqual(before);
  });
  it('скованный короткий меч с архаичным клинком: блок базы и блок точки баланса — одной строкой, ровно их сумма', () => {
    // Клинок с весом у руки и оголовье-диск: точка баланса > 0, блок добавляется к блоку базы. Архаичный
    // клинок (эпоха, а не класс, с 25.09) куётся на базе короткого меча — у неё свой блок.
    const strike = variantsFor(reg, 'sword', 'strike', 1)
      .find((p) => p.tags.blade === 'short' && p.id.startsWith('sw-r-') && p.stepMin <= 3 && 3 <= p.stepMax && (bladeStats(reg, p)?.balance ?? 0) > 0)!;
    expect(strike, 'нужен архаичный клинок с весом у руки').toBeTruthy();
    const parts = {} as CraftParts;
    for (const slot of CRAFT_SLOT_LIST) {
      const p = slot === 'strike' ? strike : slot === 'head' ? partById(reg, 'sw-pm-disc')!
        : [...variantsFor(reg, 'sword', slot, 1)].sort((a, b) => Math.abs(axisOf(reg, a)) - Math.abs(axisOf(reg, b)))[0]!;
      parts[slot] = { id: p.id, step: clampStep(p, 3) };
    }
    const res = craftWeapon(reg, { weaponClass: 'sword', hands: 1, parts });
    expect(res.ok, res.reason).toBe(true);
    const it = res.item!;
    const blocks = it.baseStats.filter((m) => m.stat === 'blockChance' && m.kind === 'flat');
    expect(blocks.length).toBe(2); // блок базы + блок точки баланса
    const sum = blocks.reduce((s, m) => s + m.value, 0);
    expect(lines(it).filter((t) => /Блок/.test(t))).toEqual([`+${Math.round(sum * 100)}% Блок`]);
  });
});

describe('доли процента в подсказке (§26)', () => {
  it('блок меньше половины процента — с десятой, а не «+0%»', () => {
    const it = sword();
    it.baseStats = [...it.baseStats.filter((m) => m.stat !== 'blockChance'), mod('blockChance', 0.004)];
    expect(lines(it).filter((t) => /Блок/.test(t))).toEqual(['+0.4% Блок']);
  });
  it('меньше 0.05 % — строки нет вовсе: при показе это был бы ноль', () => {
    const it = sword();
    it.baseStats = [...it.baseStats, mod('bleedChancePct', 0.0003)];
    expect(lines(it).some((t) => /кровотечения/.test(t))).toBe(false);
  });
});
