import { describe, it, expect } from 'vitest';
import { ConfigRegistry, newBotSave, retierItem, type Item } from '@dm/shared';
import { benchActions, benchTarget, diffStrings } from './forgeActions.js';

/**
 * Верстак кузницы: ЧТО он предлагает делать с вещью. Правило, которое здесь стережётся, —
 * «первая карточка не меняет места, только смысл»: целой вещи «Улучшить», сломанной «Починить».
 * Без него игрок со сломанной сумкой (а после забега она вся сломанная) видит главным действием
 * то, которое ему недоступно.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

/** Вещь из стартового комплекта: настоящая, со своей базой, тиром и правилом разбора. */
function gearItem(broken = false): Item {
  const save = newBotSave(reg, reg.get('classes')[0]!.id);
  const it = save.equipment.weapon!;
  return { ...it, broken: broken || undefined };
}
const RICH = { 'iron-1': 999, 'iron-2': 999, 'iron-3': 999, 'wood-1': 999, 'wood-2': 999, 'wood-3': 999,
  'cloth-1': 999, 'cloth-2': 999, 'cloth-3': 999, 'hide-1': 999, 'hide-2': 999, 'hide-3': 999,
  'plate-1': 999, 'plate-2': 999, 'plate-3': 999 };

describe('benchActions — какое действие главное', () => {
  it('⭐ у ЦЕЛОЙ вещи первая карточка «Улучшить»', () => {
    const a = benchActions(reg, gearItem(), 99999, [], RICH);
    expect(a[0]!.id).toBe('upgrade');
    expect(a[0]!.primary).toBe(true);
    expect(a[0]!.enabled).toBe(true);
  });

  it('⭐ у СЛОМАННОЙ вещи первая карточка «Починить» — на том же месте', () => {
    const a = benchActions(reg, gearItem(true), 99999, [], RICH);
    expect(a[0]!.id).toBe('repair');
    expect(a[0]!.primary).toBe(true);
    expect(a[0]!.enabled).toBe(true);
    // ⚠ Улучшения в списке НЕТ вовсе: сломанное улучшать нельзя, и мёртвая карточка только шумела бы.
    expect(a.some((x) => x.id === 'upgrade')).toBe(false);
  });

  it('порядок карточек фиксирован, разбор ВСЕГДА последний (он уничтожает вещь)', () => {
    for (const broken of [false, true]) {
      const ids = benchActions(reg, gearItem(broken), 99999, [], RICH).map((x) => x.id);
      expect(ids[ids.length - 1]).toBe('salvage');
      expect(ids).toHaveLength(3);
      expect(ids.filter((_, i) => i > 0).every((id) => id !== 'repair' && id !== 'upgrade')).toBe(true);
    }
  });

  it('реролл сломанной гаснет и ГОВОРИТ ПОЧЕМУ, а не просто серый', () => {
    const rr = benchActions(reg, gearItem(true), 99999, [], RICH).find((x) => x.id === 'reroll')!;
    expect(rr.enabled).toBe(false);
    expect(rr.lines.map((l) => l.text).join(' ')).toContain('почини');
  });
});

describe('benchActions — цена построчно', () => {
  it('⭐ нехватка видна СТРОКОЙ с «есть N», а не одной серой кнопкой', () => {
    const a = benchActions(reg, gearItem(), 99999, [], {}); // сырья нет вовсе
    const up = a[0]!;
    expect(up.enabled).toBe(false);
    const miss = up.lines.filter((l) => l.state === 'miss');
    expect(miss.length).toBeGreaterThan(0);
    expect(miss.some((l) => l.text.includes('есть 0'))).toBe(true);
  });

  it('нехватка ЗОЛОТА помечает свою строку, а строки сырья остаются зелёными', () => {
    const up = benchActions(reg, gearItem(), 0, [], RICH)[0]!;
    expect(up.enabled).toBe(false);
    const gold = up.lines.find((l) => l.text.includes('золота'))!;
    expect(gold.state).toBe('miss');
    expect(up.lines.filter((l) => l !== gold).every((l) => l.state === 'ok')).toBe(true);
  });

  it('разбор показывает выход ВИЛКОЙ — он случаен, одно число было бы враньём', () => {
    const sv = benchActions(reg, gearItem(), 99999, [], RICH).find((x) => x.id === 'salvage')!;
    expect(sv.enabled).toBe(true);
    expect(sv.lines.length).toBeGreaterThan(0);
    expect(sv.lines.every((l) => l.state === 'gain')).toBe(true);
  });

  it('⚠ сырьё в СУМКЕ засчитывается наравне с сундуком (кузница тратит оба)', () => {
    const item = gearItem();
    const empty = benchActions(reg, item, 99999, [], {})[0]!;
    expect(empty.enabled).toBe(false);
    // Тот же расчёт, но запас лежит в сумке стеками, а не в сундуке.
    const bag: Item[] = Object.keys(RICH).map((id, i) => ({
      uid: `m${i}`, baseId: id, materialId: id, kind: 'material', name: id, rarity: 'normal',
      itemLevel: 1, count: 999, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: null,
    } as unknown as Item));
    expect(benchActions(reg, item, 99999, bag, {})[0]!.enabled).toBe(true);
  });
});

describe('benchTarget — что показывает предпросмотр', () => {
  it('сломанной вещи показывает ПОЧИНКУ, а не улучшение', () => {
    const t = benchTarget(reg, gearItem(true))!;
    expect(t.broken).toBeFalsy();
    expect(t.tier).toBe(gearItem(true).tier); // тир не тронут — чинят, а не улучшают
  });

  it('целой — следующую ступень, и статы там ВЫШЕ', () => {
    const it = gearItem();
    const t = benchTarget(reg, it)!;
    expect(t.tier).not.toBe(it.tier);
    const dmgOf = (x: Item): number => x.baseStats.find((m) => m.stat === 'maxDamage')?.value ?? 0;
    expect(dmgOf(t)).toBeGreaterThan(dmgOf(it));
  });

  it('⭐ кузнечная вещь требует МЕНЬШЕ атрибутов, чем НАЙДЕННАЯ того же тира', () => {
    const it = gearItem();
    const t = benchTarget(reg, it)!;
    const base = reg.get('items.base').find((x) => x.id === it.baseId)!;
    const tier = reg.get('item-tiers').find((x) => x.id === t.tier)!;
    // Тот же тир, тот же расчёт — но БЕЗ скидки: так вещь приходит с дропа.
    const found = retierItem(base, it, tier, { maxReqTotal: reg.get('balance').maxTotalRequirement });
    const sum = (x: Item): number => Object.values(x.requirements).reduce((a, b) => a + b, 0);
    expect(sum(found)).toBeGreaterThan(0);
    expect(sum(t)).toBeLessThan(sum(found));   // ради этого крафт и существует
  });
});

describe('diffStrings — предпросмотр показывает только изменившееся', () => {
  it('одинаковые строки не попадают в дифф', () => {
    expect(diffStrings(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
  it('изменившаяся строка даёт пару «было → станет»', () => {
    expect(diffStrings(['Урон 1–2', 'x'], ['Урон 3–4', 'x'])).toEqual([{ was: 'Урон 1–2', will: 'Урон 3–4' }]);
  });
  it('⚠ ИСЧЕЗНУВШАЯ строка не сдвигает хвост — иначе починка показывала бы «Сломано → Урон»', () => {
    // Ровно случай починки: пропала первая строка, остальные не тронуты.
    expect(diffStrings(['⚠ Сломано', 'Урон 1–2', 'Уровень 5'], ['Урон 1–2', 'Уровень 5']))
      .toEqual([{ was: '⚠ Сломано', will: '' }]);
  });

  it('⭐ реальный дифф улучшения: урон и требования встают своими парами', () => {
    // Совпавшие строки («Тип», «Уровень предмета») — якоря, между ними пары идут по порядку.
    expect(diffStrings(
      ['Тип: рубящее', 'Урон: 9–22', 'Требует: Сила 39', 'Уровень предмета: 12'],
      ['Тип: рубящее', 'Урон: 13–31', 'Требует: Сила 46', 'Уровень предмета: 12'],
    )).toEqual([
      { was: 'Урон: 9–22', will: 'Урон: 13–31' },
      { was: 'Требует: Сила 39', will: 'Требует: Сила 46' },
    ]);
  });

  it('добавленная строка показывается как «было пусто → станет»', () => {
    expect(diffStrings(['x'], ['x', '+2 Броня'])).toEqual([{ was: '', will: '+2 Броня' }]);
  });
});
