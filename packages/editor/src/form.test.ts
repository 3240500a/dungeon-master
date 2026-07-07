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
        const el = defaultValue(s._def.type);
        expect(el).toBeTypeOf('object');
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
