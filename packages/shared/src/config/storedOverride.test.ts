import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { upgradeStoredOverride, upgradeXpTable } from './storedOverride.js';
import { levelForXp } from '../formulas/xp.js';

/**
 * ⚠ R20-08: ОВЕРРАЙД `classes`, СОХРАНЁННЫЙ ДО R18-07 (старт класса — любым числом), — приводится при загрузке из базы, а не выбрасывается
 * целиком: старт — вниз до целого, не ниже нуля; прочее — как было. Новая запись (реестр-проба редактора) — строгая схема, дробь — отказ.
 */
describe('⚠ R20-08: upgradeStoredOverride — старт класса старше R18-07', () => {
  const file = (): { id: string; name: string; startAttributes: Record<string, number> }[] => {
    const c = new ConfigRegistry();
    c.loadAll();
    return structuredClone(c.get('classes')) as never;
  };

  it('дробь — вниз до целого, минус — ноль; правки хозяина рядом целы; исходное не тронуто; приведённая таблица проходит схему', () => {
    const stored = file();
    stored[0]!.name = 'Правка хозяина';
    stored[0]!.startAttributes.strength = 24;
    stored[1]!.startAttributes.vitality = 12.5;
    stored[2]!.startAttributes.dexterity = -2.5;
    const before = structuredClone(stored);
    const { value, fixes } = upgradeStoredOverride('classes', stored);
    const rows = value as typeof stored;
    expect(stored, 'исходное не тронуто').toEqual(before);
    expect(rows[0]!.name).toBe('Правка хозяина');
    expect(rows[0]!.startAttributes.strength).toBe(24);
    expect(rows[1]!.startAttributes.vitality).toBe(12);
    expect(rows[2]!.startAttributes.dexterity).toBe(0);
    expect(fixes).toEqual([
      `${stored[1]!.id}.startAttributes.vitality: 12.5 → 12`,
      `${stored[2]!.id}.startAttributes.dexterity: -2.5 → 0`,
    ]);
    const reg = new ConfigRegistry();
    reg.loadAll();
    expect(() => reg.reload({ classes: stored }), 'как есть — отказ схемы (R18-07)').toThrow(/startAttributes/);
    expect(() => reg.reload({ classes: value }), 'приведённое — проходит').not.toThrow();
    expect(reg.get('classes')[0]!.name).toBe('Правка хозяина');
  });

  it('годное и чужое не трогает: целые старты, другие таблицы, мусор (его отвергнет схема — пропуск инцидентом)', () => {
    const ok = file();
    expect(upgradeStoredOverride('classes', ok)).toEqual({ value: ok, fixes: [] });
    // D2: годная кривая опыта оверрайда `balance` — как есть (приводится только кривая старше R20-05, `upgradeXpTable` ниже).
    const bal = { xpTable: [0, 0, 1.5] };
    expect(upgradeStoredOverride('balance', bal)).toEqual({ value: bal, fixes: [] });
    const junk = file();
    (junk[0]!.startAttributes as Record<string, unknown>).vitality = 'много';
    (junk[1]!.startAttributes as Record<string, unknown>).strength = Number.NaN;
    expect(upgradeStoredOverride('classes', junk).fixes).toEqual([]);
    for (const v of [null, 5, 'x', { a: 1 }, [null, 3, { startAttributes: null }]]) expect(upgradeStoredOverride('classes', v).fixes).toEqual([]);
  });
});

/**
 * ⭐ D2: ОВЕРРАЙД `balance`, СОХРАНЁННЫЙ ДО R20-05 (кривая опыта — любым массивом чисел), — кривая приводится к «0, 0, дальше строго растёт»,
 * а не выбрасывается вся таблица баланса (цены, очки за уровень, сброс, кузница хозяина откатывались бы к файлу при каждой пересборке).
 * Выпавшие пороги встают на прямую между оставшимися, хвост без порогов выше прежних отрезается (потолок ниже — уровни не отнимаются, R9-05).
 */
describe('⭐ D2: upgradeXpTable — кривая опыта старше R20-05', () => {
  const file = (): { xpTable: number[]; respecCost: number } => {
    const c = new ConfigRegistry();
    c.loadAll();
    return structuredClone(c.get('balance')) as never;
  };
  const strict = (t: number[]): boolean => t.every((v, i) => Number.isFinite(v) && v >= 0 && (i < 2 ? v === 0 : v > t[i - 1]!));

  it('ступенька, повтор, пропущенная и лишняя цифра, минус, ненулевой порог первого уровня — на прямую между соседями; прочее как было', () => {
    const cases: [string, number[], number[]][] = [
      ['ступенька', [0, 0, 100, 200, 100, 100, 100, 600, 700], [0, 0, 100, 200, 300, 400, 500, 600, 700]],
      ['повтор', [0, 0, 100, 200, 200, 400], [0, 0, 100, 200, 300, 400]],
      ['пропущенная цифра', [0, 0, 100, 200, 30, 400], [0, 0, 100, 200, 300, 400]],
      ['лишняя цифра', [0, 0, 100, 200, 3000, 400, 500], [0, 0, 100, 200, 300, 400, 500]],
      ['минус', [0, 0, 100, -200, 300], [0, 0, 100, 200, 300]],
      ['порог первого уровня', [0, 50, 100, 200], [0, 0, 100, 200]],
      ['дробные пороги', [0, 0, 10.5, 10.5, 30.5], [0, 0, 10.5, 21, 30.5]],
    ];
    for (const [what, was, want] of cases) {
      const got = upgradeXpTable(was);
      expect(got?.table, what).toEqual(want);
      expect(strict(got!.table), what).toBe(true);
      expect(got!.fixes.length, what).toBe(want.filter((v, i) => v !== was[i]).length);
    }
  });

  it('хвост без порогов выше прежних отрезается (потолок ниже); сторож одного очка опыта: ступенька не проходится разом', () => {
    const got = upgradeXpTable([0, 0, 100, 200, 300, 0, 0]);
    expect(got?.table).toEqual([0, 0, 100, 200, 300]);
    expect(got?.fixes.at(-1)).toMatch(/потолок уровня 6 → 4/);
    const t = file().xpTable.map((v, i) => (i >= 11 && i <= 20 ? 100 : v));
    const up = upgradeXpTable(t)!.table;
    expect(strict(up)).toBe(true);
    expect(up.length, 'участок выше ступеньки остался').toBe(t.length);
    expect(levelForXp(up[10]! + 1, up), 'с порога 10-го одним очком — всё ещё 10-й').toBe(10);
  });

  it('годная кривая, не массив конечных чисел, без единого порога — не трогается (null): пропуск инцидентом, угадывать нечего', () => {
    expect(upgradeXpTable(file().xpTable)).toBeNull();
    for (const t of [undefined, 5, 'x', [0], [0, 0, null, 5], [0, 0, 'сто'], [0, 0, -5, -1]]) expect(upgradeXpTable(t), JSON.stringify(t)).toBeNull();
  });

  it('оверрайд баланса целиком: приведённая кривая проходит схему, правки хозяина рядом целы, исходное не тронуто', () => {
    const stored = file();
    stored.respecCost = 777;
    stored.xpTable = stored.xpTable.map((v, i) => (i === 12 ? stored.xpTable[11]! : v));
    const before = structuredClone(stored);
    const { value, fixes } = upgradeStoredOverride('balance', stored);
    expect(stored, 'исходное не тронуто').toEqual(before);
    expect(fixes).toEqual([`balance.xpTable[12]: ${stored.xpTable[11]} → ${(value as typeof stored).xpTable[12]}`]);
    const reg = new ConfigRegistry();
    reg.loadAll();
    expect(() => reg.reload({ balance: stored }), 'как есть — отказ схемы (R20-05)').toThrow(/xpTable/);
    expect(() => reg.reload({ balance: value }), 'приведённое — проходит').not.toThrow();
    expect(reg.get('balance').respecCost, 'правка хозяина рядом цела').toBe(777);
  });
});
