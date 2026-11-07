/**
 * ⭐ i18n (07.11, шов Unity): ПРОДЮСЕР эталона ШВА ФРАЗ КОДА для Unity-клиента — `tr` / `trn` и категории числа.
 *
 * Unity переводит свою обвязку (ключи `ui:`) тем же правилом, что сервер свои фразы (`srv:`): `DmText.T` / `DmText.Tn`
 * (`Assets/DM/UI/DmText.cs`) — порт `tr` / `trn` из `tr.ts`. Расходиться им нельзя ни в запасе (пустой перевод → исходник, ключа нет →
 * таблица языка-источника → исходник), ни в подстановке `{слотов}` (неизвестный слот виден как есть), ни в форме по числу.
 *
 * ⚠⚠ У .NET нет `Intl.PluralRules`: категории CLDR (`one` / `few` / `many` / `other`) для ru / en / es / zh портированы руками, и
 * доказать их можно только ЗАПУСКОМ обеих реализаций. Здесь категория берётся той же функцией, что у сервера (`pluralCategory`),
 * — с её правилами округления: `Intl.PluralRules` видит число так, как его напечатал бы `Intl.NumberFormat` по умолчанию (дробь — до 3
 * знаков, половина — от нуля), поэтому 1.0004 — это «1» (`one`), а 1.9996 — «2».
 *
 * Что внутри:
 *  • `plural` — категория каждого числа 0…300, дробей, отрицательных, больших и особых (строкой: "NaN", "Infinity", "-0") на 4 языках;
 *  • `locales` — стенд-таблица языков (терпимо разбирается и портом);
 *  • `tr` — фраза кода: язык, ключ, исходник, подстановки (нет поля — без подстановки) → итог;
 *  • `trn` — фраза от числа: язык, ключ, число, формы источника, подстановки → итог.
 *
 * Эталон: `__golden__/unity_text.json` → Unity `Assets/DM/UI/Tests/unity_text_golden.json`, проверка — `TextCheck`.
 * Перезапись: `npx vitest run packages/shared/src/i18n/unityTextGolden.gen.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Locales } from './index.js';
import { pluralCategory, tr, trn, withTextLang, type PluralForms, type TextParams } from './tr.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LANGS = ['ru', 'en', 'es', 'zh'] as const;

/** Числа эталона категорий: целые подряд, дроби у границ округления до 3 знаков, отрицательные, большие, особые. */
function numbers(): (number | string)[] {
  const out: (number | string)[] = [];
  for (let n = 0; n <= 300; n++) out.push(n);
  out.push(
    0.5, 1.5, 2.5, 0.1, 0.25, 1.25, 1.001, 1.0001, 1.0004, 1.0005, 1.0015, 1.9994, 1.9995, 1.9996, 2.0004, 0.0004, 0.0005, 0.9994, 0.9995,
    0.9999, 4.9999, 11.0001, 21.5, 22.5, 101.5, 111.1, 3.14159, 5.000001, 1e-7, 0.1 + 0.2, 1000, 1001, 1011, 1021, 1111, 2022, 10000, 100000,
    1000000, 2000000, 1000001, 1000000.5, 3000000.0004, 1e9, 1e15, 123456789012, 1e21, 1.5e21, 2.5e22, 1e300, Number.MAX_SAFE_INTEGER,
    -1, -2, -5, -11, -21, -1.5, -0.0004,
    'NaN', 'Infinity', '-Infinity', '-0',
  );
  return out;
}
const numOf = (v: number | string): number => (typeof v === 'number' ? v : Number(v === '-0' ? -0 : v));

/** Стенд таблицы языков: переводы `ui:`-ключей, пустые заготовки, формы по числу, запас в таблице источника. */
const LOCALES = {
  ru: {
    name: 'Русский', enabled: true,
    strings: {
      'ui:t.ruOnly': 'Из таблицы источника',
      'ui:t.ruForms': { one: '{n} штука', few: '{n} штуки', many: '{n} штук', other: '{n} штуки' },
    },
  },
  en: {
    name: 'English', enabled: true,
    strings: {
      'ui:t.hello': 'Hello, {name}!',
      'ui:t.plain': 'Choose language',
      'ui:t.empty': '',
      'ui:t.slots': '{a} and {b} and {missing} {a}',
      'ui:t.braces': '{{name}} {name} {na me} {} {name.x} {name-y} {_z}',
      'ui:t.items': { one: '{n} item', other: '{n} items' },
      'ui:t.itemsOtherOnly': { other: '{n} things' },
      'ui:t.itemsEmpty': { one: '', other: '' },
      'ui:t.itemsOneEmpty': { one: '', other: '{n} pieces' },
      'ui:t.flat': 'Count: {n}',
      'ui:t.flatEmpty': '',
      'ui:t.nOverride': { one: '{n} of {max}', other: '{n} of {max}' },
    },
  },
  es: {
    name: 'Español', enabled: true,
    strings: {
      'ui:t.hello': '¡Hola, {name}!',
      'ui:t.items': { one: '{n} objeto', many: '{n} de objetos', other: '{n} objetos' },
    },
  },
  zh: {
    name: '简体中文', enabled: true, grammar: { join: '' },
    strings: {
      'ui:t.hello': '你好，{name}！',
      'ui:t.items': { other: '{n} 件物品' },
    },
  },
} as unknown as Locales;

interface TrCase { lang: string; key: string; source: string; params?: TextParams }
interface TrnCase { lang: string; key: string; n: number; forms: PluralForms; params?: TextParams }

const RU_FORMS: PluralForms = { one: '{n} вещь', few: '{n} вещи', many: '{n} вещей', other: '{n} вещи' };

function trCases(): TrCase[] {
  const out: TrCase[] = [];
  for (const lang of LANGS) {
    out.push({ lang, key: 'ui:t.hello', source: 'Привет, {name}!', params: { name: 'Вася' } });
    out.push({ lang, key: 'ui:t.hello', source: 'Привет, {name}!' });                         // без подстановок: слот как есть
    out.push({ lang, key: 'ui:t.hello', source: 'Привет, {name}!', params: {} });             // пустые подстановки: слот как есть
    out.push({ lang, key: 'ui:t.plain', source: 'Выберите язык' });
    out.push({ lang, key: 'ui:t.empty', source: 'Пусто — исходник' });                        // пустой перевод → исходник
    out.push({ lang, key: 'ui:t.absent', source: 'Нет ключа' });                              // нет ключа → исходник
    out.push({ lang, key: 'ui:t.ruOnly', source: 'Исходник кода' });                          // ключ только в таблице источника
    out.push({ lang, key: 'ui:t.items', source: 'Формы как фраза' });                         // набор форм через tr — запас выбора формы
    out.push({ lang, key: 'ui:t.slots', source: '{a} и {b} и {missing} {a}', params: { a: 1, b: 'два' } });
    out.push({ lang, key: 'ui:t.braces', source: '{{name}} {name} {na me} {} {name.x} {name-y} {_z}', params: { name: 'N', 'name.x': 'X', 'name-y': 'Y', _z: 'Z' } });
    // ⚠ NaN и ∞ в подстановки эталона не идут: JSON пишет их `null` — порт прочёл бы «null», а веб напечатал «NaN» (печать числа сверяет `plural`)
    out.push({ lang, key: 'ui:t.nums', source: '{i} {d} {neg} {big} {tiny} {sum} {t} {f}', params: { i: 42, d: 12.5, neg: -3, big: 1e21, tiny: 1e-7, sum: 0.1 + 0.2, t: true, f: false } });
    out.push({ lang, key: 'ui:t.nulls', source: '[{a}] [{b}]', params: { a: null, b: '' } });
    out.push({ lang, key: 'ui:t.dollar', source: 'Цена: {p} $& $1 $$', params: { p: '$&$1' } });
  }
  return out;
}

function trnCases(): TrnCase[] {
  const out: TrnCase[] = [];
  const ns = [0, 1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 1000000, 1.5, 0.5, 1.0004, 2.0004];
  for (const lang of LANGS) {
    for (const n of ns) {
      out.push({ lang, key: 'ui:t.items', n, forms: RU_FORMS });
      out.push({ lang, key: 'ui:t.absent', n, forms: RU_FORMS });
    }
    for (const n of [1, 2, 5]) {
      out.push({ lang, key: 'ui:t.itemsOtherOnly', n, forms: RU_FORMS });
      out.push({ lang, key: 'ui:t.itemsEmpty', n, forms: RU_FORMS });          // пустые формы перевода → исходник
      out.push({ lang, key: 'ui:t.itemsOneEmpty', n, forms: RU_FORMS });       // пустая своя категория → other перевода
      out.push({ lang, key: 'ui:t.flat', n, forms: RU_FORMS });                // перевод одной строкой
      out.push({ lang, key: 'ui:t.flatEmpty', n, forms: RU_FORMS });           // пустая строка → исходник
      out.push({ lang, key: 'ui:t.ruForms', n, forms: RU_FORMS });             // ключ только в таблице источника
      out.push({ lang, key: 'ui:t.nOverride', n, forms: { one: '{n} из {max}', other: '{n} из {max}' }, params: { max: 8 } });
      out.push({ lang, key: 'ui:t.nOverride', n, forms: { one: '{n} из {max}', other: '{n} из {max}' }, params: { n: 'N', max: 8 } });   // params перебивают {n}
      out.push({ lang, key: 'ui:t.absent', n, forms: { other: '{n} всего' } });                  // у источника только other
      out.push({ lang, key: 'ui:t.absent', n, forms: { one: '', other: '{n} всего' } });         // пустая форма источника — значение (`??`)
    }
  }
  return out;
}

describe('эталон шва фраз кода для Unity (unity_text.json)', () => {
  it('⭐⭐ пишет __golden__/unity_text.json', () => {
    const plural = numbers().map((v) => {
      const n = numOf(v);
      const row: Record<string, string | number> = { n: v };
      for (const lang of LANGS) row[lang] = pluralCategory(lang, n);
      return row;
    });
    const tr1 = trCases().map((c) => ({ ...c, out: withTextLang(LOCALES, c.lang, () => tr(c.key, c.source, c.params)) }));
    const trn1 = trnCases().map((c) => ({ ...c, out: withTextLang(LOCALES, c.lang, () => trn(c.key, c.n, c.forms, c.params)) }));

    // Самопроверка стенда: эталон не пуст и покрывает то, ради чего заведён
    expect(plural.length).toBeGreaterThan(350);
    expect(new Set(plural.map((r) => r.ru))).toEqual(new Set(['one', 'few', 'many', 'other']));
    expect(new Set(plural.map((r) => r.es))).toEqual(new Set(['one', 'many', 'other']));
    expect(new Set(plural.map((r) => r.zh))).toEqual(new Set(['other']));
    expect(tr1.find((c) => c.lang === 'ru' && c.key === 'ui:t.ruOnly')?.out).toBe('Исходник кода');   // источник таблицу не читает
    expect(tr1.find((c) => c.lang === 'en' && c.key === 'ui:t.ruOnly')?.out).toBe('Из таблицы источника');
    expect(trn1.find((c) => c.lang === 'en' && c.key === 'ui:t.items' && c.n === 1.0004)?.out).toBe('1.0004 item');

    const golden = { locales: LOCALES, plural, tr: tr1, trn: trn1 };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unity_text.json'), JSON.stringify(golden));
  });
});
