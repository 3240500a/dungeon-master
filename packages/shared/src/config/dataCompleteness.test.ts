import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { configSchemas } from './schemas.js';
import { defaultConfigData } from './defaults.js';

/**
 * ⭐ ВСЕ ЗНАЧЕНИЯ ЖИВУТ В ФАЙЛАХ ДАННЫХ, А НЕ В `.default()` СХЕМЫ.
 *
 * Принцип №2 проекта: данные отделены от кода. Но zod-схема разрешает написать `.default(30)` и не
 * класть поле в json — и тогда число ЕДЕТ ИЗ КОДА, хотя формально «настраивается конфигом». Дизайнер
 * открывает `balance.json`, поля там нет, и он справедливо считает, что ручки не существует.
 *
 * Замер, с которого сторож и появился: 3 поля из 157 ехали мимо файла, и два из них были только что
 * добавлены мной под видом «вынес в конфиг». Третьим оказался `skillSocketRanks`, у которого в самой
 * схеме написано «в конфиге, а не в коде» — а лежал он как раз в коде.
 *
 * `.default()` при этом НЕ запрещён и остаётся нужен: он страхует МИГРАЦИЮ, когда поле добавили, а
 * сохранённые/присланные данные о нём ещё не знают. Запрещено другое — хранить там значение.
 *
 * Идём по `defaultConfigData` (это и есть карта «ключ → файл», которую читает реестр), а не по
 * угаданным именам файлов: иначе сторож молча пропустил бы конфиг и прошёл вхолостую.
 */

type Any = z.ZodTypeAny & { _def: { typeName: string; innerType?: Any; schema?: Any } };

/**
 * Пути обязательных листьев схемы (`a.b.c`).
 *
 * `optional`/`nullable` пропускаем вместе с поддеревом — такое поле законно отсутствует.
 * В массивы, записи и union НЕ заходим: там ключи — это уже сами данные (предметы, монстры), и
 * требовать от них «полноты по схеме» бессмысленно.
 */
function requiredLeaves(s: Any, prefix = ''): string[] {
  let c = s;
  for (let i = 0; i < 20; i++) {
    const tn = c._def.typeName;
    if (tn === 'ZodOptional' || tn === 'ZodNullable') return [];       // законно отсутствует
    if (tn === 'ZodDefault') { c = c._def.innerType as Any; continue; }   // ← ровно тот случай, что ловим
    if (tn === 'ZodEffects') { c = c._def.schema as Any; continue; }
    break;
  }
  if (c._def.typeName !== 'ZodObject') return prefix ? [prefix] : [];
  const shape = (c as unknown as { shape: Record<string, Any> }).shape;
  const out: string[] = [];
  for (const [k, v] of Object.entries(shape)) out.push(...requiredLeaves(v, prefix ? `${prefix}.${k}` : k));
  return out;
}

const at = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);

describe('полнота файлов данных', () => {
  const raw = defaultConfigData as Record<string, unknown>;

  it('сторож вообще что-то проверяет — иначе он прошёл бы вхолостую', () => {
    // Пустой обход = зелёный тест ни о чём. Пересчитываем листья и требуем, чтобы их были сотни.
    let n = 0;
    for (const [key, schema] of Object.entries(configSchemas)) {
      if (Array.isArray(raw[key])) continue;
      n += requiredLeaves(schema as unknown as Any).length;
    }
    expect(n, 'обязательных листьев схемы').toBeGreaterThan(100);
  });

  for (const [key, schema] of Object.entries(configSchemas)) {
    it(`${key}: каждое поле схемы лежит в файле`, () => {
      const data = raw[key];
      if (Array.isArray(data) || data === undefined) return;   // массивные конфиги — там файл и есть данные
      const missing = requiredLeaves(schema as unknown as Any).filter((l) => at(data, l) === undefined);
      expect(missing, `едут из .default() в коде вместо ${key}.json`).toEqual([]);
    });
  }
});
