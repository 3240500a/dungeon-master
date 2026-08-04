import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { configSchemas } from '@dm/shared';
import { defaultValue } from './form.js';

/**
 * Проверяем интроспекцию zod: defaultValue не падает ни на одной схеме конфига
 * (и на элементах массивов), покрывая object/array/tuple/record/enum/number/string.
 */
describe('defaultValue по схемам конфигов', () => {
  for (const [key, schema] of Object.entries(configSchemas)) {
    it(`строит дефолт для ${key}`, () => {
      expect(() => defaultValue(schema as z.ZodTypeAny)).not.toThrow();
      const s = schema as z.ZodTypeAny;
      if (s._def.typeName === 'ZodArray') {
        expect(() => defaultValue(s._def.type)).not.toThrow();
        const elemTn = s._def.type._def.typeName;
        // массив ОБЪЕКТОВ → дефолт-элемент объект; массив примитивов (строки) — примитив, это ок
        if (elemTn === 'ZodObject' || elemTn === 'ZodDiscriminatedUnion') expect(defaultValue(s._def.type)).toBeTypeOf('object');
      }
    });
  }
});

describe('дискриминированный union items.base', () => {
  it('дефолт элемента — первый вариант (weapon) с дискриминатором kind и полями варианта', () => {
    const arr = configSchemas['items.base'] as z.ZodTypeAny;
    const el = defaultValue(arr._def.type) as Record<string, unknown>;
    expect(el.kind).toBe('weapon');
    expect(el).toHaveProperty('weaponClass'); // поле оружия
    expect(el).not.toHaveProperty('armorClass'); // не поле оружия — редактор не покажет
  });
});

describe('defaultValue уважает .default(...) скаляров (регресс: splitDepth=0 → ошибка min(1))', () => {
  it('число с .default(N) даёт N, а не 0', () => {
    expect(defaultValue(z.number().int().min(1).default(4))).toBe(4);
    expect(defaultValue(z.number().min(0).default(0.3))).toBe(0.3);
  });
  it('строка/enum/boolean с .default дают заданное значение', () => {
    expect(defaultValue(z.string().default('x'))).toBe('x');
    expect(defaultValue(z.enum(['a', 'b']).default('b'))).toBe('b');
    expect(defaultValue(z.boolean().default(true))).toBe(true);
  });
  it('bsp-вариант этажа: дефолт-элемент проходит собственную валидацию (splitDepth≥1)', () => {
    const floorsArr = configSchemas['floors'] as z.ZodTypeAny;
    const algoUnion = (floorsArr._def.type as z.ZodObject<z.ZodRawShape>).shape.algoParams as z.ZodTypeAny;
    const raw = algoUnion._def.options;
    const opts = (Array.isArray(raw) ? raw : [...raw.values()]) as z.ZodObject<z.ZodRawShape>[];
    const bsp = opts.find((o) => String((o.shape.algorithm as z.ZodTypeAny)._def.value) === 'bsp')!;
    const def = defaultValue(bsp);
    expect(() => bsp.parse(def)).not.toThrow(); // раньше splitDepth=0 → падало min(1)
    expect((def as Record<string, number>).splitDepth).toBeGreaterThanOrEqual(1);
  });
});
