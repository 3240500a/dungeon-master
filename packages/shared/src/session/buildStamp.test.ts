import { describe, it, expect } from 'vitest';
import { buildStampOf, isBuildStampSource } from './buildStamp.js';

/**
 * ⭐ R18-08: ШТАМП СБОРКИ — одинаков у сборки клиента и у сервера на тех же исходниках (порядок обхода папки и разделитель путей у них свои:
 * Windows даёт `\`), и двигается от ЛЮБОЙ правки кода рантайма shared — а тесты, фаззеры и данные конфига его не двигают.
 */
describe('⭐ R18-08: штамп сборки (`buildStampOf`)', () => {
  const files: [string, string][] = [
    ['economy/townActions.ts', 'export const PRICE = 0.4;\n'],
    ['formulas/craft.ts', 'export const M = 1;\n'],
    ['index.ts', "export * from './economy/townActions.js';\n"],
  ];

  it('порядок обхода и разделитель путей не важны', () => {
    const a = buildStampOf(files);
    expect(a).not.toBe('');
    expect(buildStampOf([...files].reverse())).toBe(a);
    expect(buildStampOf(files.map(([p, t]) => [p.replace(/\//g, '\\'), t] as const))).toBe(a);
  });

  it('любая правка кода рантайма двигает штамп: знак формулы, переименование файла, новый файл', () => {
    const a = buildStampOf(files);
    expect(buildStampOf(files.map(([p, t]) => [p, t.replace('0.4', '0.3')] as const)), 'формула цены скупки').not.toBe(a);
    expect(buildStampOf(files.map(([p, t]) => [p, t.replace('M = 1', 'M = 2')] as const)), 'та же длина, другой знак').not.toBe(a);
    expect(buildStampOf(files.map(([p, t]) => [p === 'formulas/craft.ts' ? 'formulas/crafts.ts' : p, t] as const))).not.toBe(a);
    expect(buildStampOf([...files, ['formulas/new.ts', 'export {};\n']])).not.toBe(a);
    // Граница файлов — часть штампа: перенос текста из одного файла в соседний — другой код.
    expect(buildStampOf([['a.ts', 'xy'], ['b.ts', 'z']])).not.toBe(buildStampOf([['a.ts', 'x'], ['b.ts', 'yz']]));
  });

  it('тесты, фаззеры, объявления и данные конфига штамп не двигают', () => {
    const a = buildStampOf(files);
    for (const extra of ['economy/townActions.test.ts', 'economy/fuzz/economyFuzz.ts', 'session/fuzz/rulesFuzz.ts', 'config/data/balance.json', 'types/x.d.ts', 'README.md']) {
      expect(isBuildStampSource(extra), extra).toBe(false);
      expect(buildStampOf([...files, [extra, 'что угодно']]), extra).toBe(a);
    }
    expect(isBuildStampSource('economy\\townActions.ts')).toBe(true);
    expect(isBuildStampSource('refuzz/x.ts'), 'папка `fuzz/` — целиком по имени, а не по хвосту').toBe(true);
  });

  /**
   * ⚠ R19-06: КОНЦЫ СТРОК И BOM — НЕ КОД. Хэш шёл по сырому тексту: клиент, собранный из выгрузки Windows (`core.autocrlf=true`, CRLF), и
   * сервер из выгрузки Linux (LF) того же коммита получали разные штампы — каждой вкладке «Сервер обновился — перезагрузите», и перезагрузка
   * не помогала никогда (тот же бандл). Одиночный CR (старый Mac) и BOM в начале файла — туда же.
   */
  it('⚠ R19-06: LF, CRLF, CR и BOM в начале файла — один штамп; правка одного знака его по-прежнему двигает', () => {
    const lf: [string, string][] = [...files, ['formulas/multi.ts', 'export const A = 1;\nexport const B = 2;\n\nexport const C = 3;\n']];
    const a = buildStampOf(lf);
    const crlf = lf.map(([p, t]) => [p, t.replace(/\n/g, '\r\n')] as const);
    expect(buildStampOf(crlf), 'CRLF (выгрузка Windows)').toBe(a);
    expect(buildStampOf(lf.map(([p, t]) => [p, t.replace(/\n/g, '\r')] as const)), 'CR').toBe(a);
    expect(buildStampOf(lf.map(([p, t], i) => [p, i === 1 ? `﻿${t}` : t] as const)), 'BOM в начале файла').toBe(a);
    expect(buildStampOf(crlf.map(([p, t], i) => [p, i % 2 ? t : t.replace(/\r\n/g, '\n')] as const)), 'выгрузка вперемешку').toBe(a);
    expect(buildStampOf(crlf.map(([p, t]) => [p, t.replace('B = 2', 'B = 3')] as const)), 'правка знака под CRLF').not.toBe(a);
    expect(buildStampOf(lf.map(([p, t]) => [p, t.replace('\n\n', '\n')] as const)), 'пустая строка — правка').not.toBe(a);
    expect(buildStampOf(lf.map(([p, t]) => [p, t.replace('B = 2', 'B =﻿2')] as const)), 'BOM посреди текста — знак').not.toBe(a);
  });

  it('исходников нет — штампа нет (сравнивать нечего)', () => {
    expect(buildStampOf([])).toBe('');
    expect(buildStampOf([['a.test.ts', 'x']])).toBe('');
  });
});
