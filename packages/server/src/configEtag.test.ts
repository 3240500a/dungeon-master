import { describe, it, expect } from 'vitest';
import { configEtagOf } from './configEtag.js';

/**
 * ⭐ ETag ОБЯЗАН МЕНЯТЬСЯ ОТ ЛЮБОЙ ПРАВКИ ТЕЛА.
 *
 * Прежняя версия брала каждый 64-й символ: правка числа той же длины давала ТОТ ЖЕ ETag, клиент
 * получал 304 и жил со старым конфигом. Это тот самый случай «поправил, перезапустил всё, ничего
 * не изменилось» — и по виду не отличимый от «правка не сохранилась».
 */
describe('ETag конфига', () => {
  it('⭐ правка ОДНОГО символа в любом месте меняет ETag', () => {
    const body = JSON.stringify({ models: Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, scale: 1 })) });
    const base = configEtagOf(body);
    let same = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      const alt = body.slice(0, i) + (ch === 'x' ? 'y' : 'x') + body.slice(i + 1);   // длина сохраняется
      if (configEtagOf(alt) === base) same++;
    }
    expect(same, `⚠ ${same} позиций тела не влияют на ETag`).toBe(0);
    expect(body.length).toBeGreaterThan(500);   // тело заведомо длиннее прежнего шага выборки
  });

  it('одинаковое тело — одинаковый ETag (иначе 304 не сработает никогда)', () => {
    const b = '{"a":1,"b":[1,2,3]}';
    expect(configEtagOf(b)).toBe(configEtagOf(b));
  });

  it('формат слабого ETag сохранён', () => {
    expect(configEtagOf('{}')).toMatch(/^W\/"[0-9a-z]+-[0-9a-z]+"$/);
  });
});
