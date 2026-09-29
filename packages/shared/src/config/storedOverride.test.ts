import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { upgradeStoredOverride } from './storedOverride.js';

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
    const bal = { xpTable: [0, 0.5, 1.5] };
    expect(upgradeStoredOverride('balance', bal)).toEqual({ value: bal, fixes: [] });
    const junk = file();
    (junk[0]!.startAttributes as Record<string, unknown>).vitality = 'много';
    (junk[1]!.startAttributes as Record<string, unknown>).strength = Number.NaN;
    expect(upgradeStoredOverride('classes', junk).fixes).toEqual([]);
    for (const v of [null, 5, 'x', { a: 1 }, [null, 3, { startAttributes: null }]]) expect(upgradeStoredOverride('classes', v).fixes).toEqual([]);
  });
});
