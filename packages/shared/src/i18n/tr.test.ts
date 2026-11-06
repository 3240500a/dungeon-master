import { afterEach, describe, expect, it } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import { localesSchema, type Locales } from './index.js';
import { cfgKey, walkConfigText, I18N_SKIP_TABLES, I18N_TEXT_FIELDS } from './keys.js';
import {
  cfgRowText, cfgText, localizerFor, pluralCategory, setTextObserver, setTextProvider, textLang, tr, trn, withTextLang,
} from './tr.js';

/**
 * ⭐ i18n Ф1 (06.11): сторож ШВА ТЕКСТА СЕРВЕРА (`tr` / `trn` / `cfgText` / `cfgRowText`). Без области — язык-источник, ровно как раньше
 * (на этом стоит побайтовость русского); перевода нет — исходник; подстановки — как у шаблонной строки JS; формы по числу — категории
 * `Intl.PluralRules` языка; путь ключа строки конфига — тот же, что у извлекателя.
 */
const pack = (strings: Record<string, string | Record<string, string>>, extra: Record<string, unknown> = {}): Locales =>
  localesSchema.parse({
    ru: { name: 'Русский', enabled: true },
    xx: { name: 'Test', enabled: true, grammar: { join: ' ', agrees: false }, strings, ...extra },
    en: { name: 'English', enabled: true, grammar: { join: ' ', agrees: false }, strings },
  });

afterEach(() => { setTextProvider(null); setTextObserver(null); });

describe('i18n Ф1: tr — фраза кода на языке области', () => {
  it('⭐ без области — исходник, слоты — как у шаблонной строки (`String(v)`)', () => {
    expect(textLang()).toBe('ru');
    expect(tr('srv:t.a', 'Нет места')).toBe('Нет места');
    const gold = 0.1 + 0.2, none = undefined, nil = null;
    expect(tr('srv:t.b', 'Цена: {gold} · {none} · {nil}', { gold, none, nil })).toBe(`Цена: ${gold} · ${none} · ${nil}`);
    expect(tr('srv:t.c', 'Печатей: {n} из {max}', { n: 3 }), 'забытый слот виден, а не «undefined»').toBe('Печатей: 3 из {max}');
    expect(tr('srv:t.d', '{a}{a}', { a: '{a}' }), 'подстановка не перечитывается').toBe('{a}{a}');
  });

  it('⭐ область — перевод; нет перевода или пустая заготовка — исходник; область снимается', () => {
    const loc = pack({ 'srv:t.a': 'No room', 'srv:t.b': 'Price: {gold}', 'srv:t.e': '' });
    withTextLang(loc, 'xx', () => {
      expect(textLang()).toBe('xx');
      expect(tr('srv:t.a', 'Нет места')).toBe('No room');
      expect(tr('srv:t.b', 'Цена: {gold}', { gold: 5 })).toBe('Price: 5');
      expect(tr('srv:t.z', 'Нет перевода')).toBe('Нет перевода');
      expect(tr('srv:t.e', 'Пустая заготовка')).toBe('Пустая заготовка');
      withTextLang(loc, 'ru', () => expect(tr('srv:t.a', 'Нет места'), 'вложенная область перебивает внешнюю').toBe('Нет места'));
      expect(tr('srv:t.a', 'Нет места'), 'внешняя вернулась').toBe('No room');
    });
    expect(tr('srv:t.a', 'Нет места')).toBe('Нет места');
  });

  it('язык-источник и пустая таблица не заводят `Localizer`; один на (таблицу, язык)', () => {
    const loc = pack({});
    expect(localizerFor(loc, 'ru')).toBeNull();
    expect(localizerFor(undefined, 'xx')).toBeNull();
    expect(localizerFor(loc, 'xx')).toBe(localizerFor(loc, 'xx'));
    expect(localizerFor(pack({}), 'xx'), 'новая таблица (перезагрузка конфига) — новый разрешитель').not.toBe(localizerFor(loc, 'xx'));
  });

  it('провайдер области (сервер) и синхронная область: синхронная — сверху', () => {
    const loc = pack({ 'srv:t.a': 'No room' });
    setTextProvider(() => localizerFor(loc, 'xx'));
    expect(tr('srv:t.a', 'Нет места')).toBe('No room');
    withTextLang(loc, 'ru', () => expect(tr('srv:t.a', 'Нет места')).toBe('Нет места'));
    setTextProvider(null);
    expect(tr('srv:t.a', 'Нет места')).toBe('Нет места');
  });

  it('наблюдатель видит ключ и итоговый текст (из них сервер выводит `cmdResult.code`)', () => {
    const seen: [string, string][] = [];
    setTextObserver((k, t) => seen.push([k, t]));
    tr('srv:consent.gold', 'Цена изменилась: {gold} золота', { gold: 7 });
    expect(seen).toEqual([['srv:consent.gold', 'Цена изменилась: 7 золота']]);
  });
});

describe('i18n Ф1: trn — фраза от числа по категориям `Intl.PluralRules`', () => {
  const forms = { one: 'в {n} раз больше', few: 'в {n} раза больше', many: 'в {n} раз больше', other: 'в {n} раза больше' };
  it('⭐ русский исходник: 1/21 — one, 2–4/22 — few, 5/11–14/25 — many, дробь — other', () => {
    expect([1, 21, 2, 4, 22, 5, 11, 12, 14, 25, 100].map((n) => pluralCategory('ru', n)))
      .toEqual(['one', 'one', 'few', 'few', 'few', 'many', 'many', 'many', 'many', 'many', 'many']);
    expect(pluralCategory('ru', 1.5)).toBe('other');
    expect(trn('srv:t.n', 5, forms)).toBe('в 5 раз больше');
    expect(trn('srv:t.n', 22, forms)).toBe('в 22 раза больше');
    expect(trn('srv:t.n', 21, forms)).toBe('в 21 раз больше');
    expect(trn('srv:t.n', 3, forms, { n: '3.0' }), 'параметры перебивают `n`').toBe('в 3.0 раза больше');
  });
  it('⭐ перевод — категории СВОЕГО языка (en: one/other); строка — на все числа; нет перевода — русские формы', () => {
    const loc = pack({ 'srv:t.n': { one: '{n} time more', other: '{n} times more' }, 'srv:t.s': 'x{n}' });
    withTextLang(loc, 'en', () => {
      expect(trn('srv:t.n', 1, forms)).toBe('1 time more');
      expect(trn('srv:t.n', 3, forms), 'у английского 3 — other, а не few').toBe('3 times more');
      expect(trn('srv:t.s', 7, forms)).toBe('x7');
      expect(trn('srv:t.none', 2, forms)).toBe('в 2 раза больше');
    });
  });
});

describe('i18n Ф1: тексты конфига — `cfgText` и `cfgRowText`', () => {
  const reg = new ConfigRegistry();
  reg.loadAll();

  it('`cfgText`: ключ `cfgKey` таблицы, нет перевода — исходник из данных', () => {
    const diff = reg.get('difficulties')[0]!;
    const loc = pack({ [cfgKey('difficulties', [diff.id], 'name')]: 'XX-tier' });
    expect(cfgText('difficulties', [diff.id], 'name', diff.name)).toBe(diff.name);
    withTextLang(loc, 'xx', () => {
      expect(cfgText('difficulties', [diff.id], 'name', diff.name)).toBe('XX-tier');
      expect(cfgText('difficulties', ['nope'], 'name', 'исходник')).toBe('исходник');
    });
  });

  it('⭐ `cfgRowText`: путь ключа — по самому объекту строки, и во вложенных таблицах; копия строки — исходник', () => {
    const node = reg.get('skill-tree').nodes[3]!;
    const anat = reg.get('weapon-anatomy')[0]!;
    const loc = pack({
      [cfgKey('skill-tree', ['nodes', node.id], 'name')]: 'XX-node',
      [cfgKey('weapon-anatomy', [anat.id, 'strike'], 'name')]: 'XX-strike',
    });
    withTextLang(loc, 'xx', () => {
      expect(cfgRowText(reg, 'skill-tree', node)).toBe('XX-node');
      expect(cfgRowText(reg, 'weapon-anatomy', anat.strike)).toBe('XX-strike');
      expect(cfgRowText(reg, 'skill-tree', { ...node }), 'копия — не строка таблицы').toBe(node.name);
      expect(cfgRowText(reg, 'skill-tree', undefined)).toBeUndefined();
    });
    expect(cfgRowText(reg, 'skill-tree', node), 'без области — исходник').toBe(node.name);
  });

  it('⭐⭐ ключи РАНТАЙМА = ключи ИЗВЛЕКАТЕЛЯ: каждое текстовое поле разобранного реестра находится по объекту строки под ключом корпуса', () => {
    // Перевод кладут по корпусу сырых данных (`walkConfigText(defaultConfigData)`), а ищут — по строкам РАЗОБРАННОГО реестра (zod: умолчания,
    // приведения). Разойдись пути — перевод лежал бы под ключом, которого рантайм не спрашивает, и строка молча осталась бы русской.
    const corpus = new Map(walkConfigText(defaultConfigData).map((c) => [c.key, c.source]));
    const text = new Set(I18N_TEXT_FIELDS);
    const marked: Record<string, string> = {};
    for (const k of corpus.keys()) marked[k] = `«${k}»`;
    const loc = pack(marked);
    let checked = 0;
    const miss: string[] = [];
    withTextLang(loc, 'xx', () => {
      for (const table of Object.keys(defaultConfigData)) {
        if (I18N_SKIP_TABLES.has(table)) continue;
        let root: unknown;
        try { root = reg.get(table as never); } catch { continue; }
        const visit = (node: unknown): void => {
          if (Array.isArray(node)) { node.forEach(visit); return; }
          if (node === null || typeof node !== 'object') return;
          for (const [f, v] of Object.entries(node as Record<string, unknown>)) {
            if (typeof v === 'string' && text.has(f) && v.trim()) {
              checked++;
              const got = cfgRowText(reg, table as never, node, f);
              if (!got || !got.startsWith('«cfg:') || corpus.get(got.slice(1, -1)) !== v) miss.push(`${table}.${f}=${v} → ${got}`);
            } else if (v !== null && typeof v === 'object') visit(v);
          }
        };
        visit(root);
      }
    });
    expect(checked, 'корпус не схлопнулся').toBeGreaterThan(3000);
    expect(miss.slice(0, 10), `строк реестра вне корпуса: ${miss.length}`).toEqual([]);
  });
});
