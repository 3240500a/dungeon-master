/**
 * ⭐⭐ i18n Ф1 (06.11): ШОВ ТЕКСТА, КОТОРЫЙ ШЛЁТ СЕРВЕР. Сервер авторитетен во всём и сам собирает всё, что видит игрок: модели окон
 * (`views/`), причины отказа команд, итоги, сообщения входа. Решение владельца: «сервер рисует каждый свой текст на языке игрока, Unity
 * переводит только свою обвязку». Поэтому каждый игроцкий литерал кода идёт через ОДНУ из трёх функций этого файла:
 *
 * ```ts
 * tr('srv:forge.noRoom', 'Нет места в сумке');                       // фраза кода
 * tr('srv:forge.priceGold', 'Цена изменилась: {gold} золота', { gold }); // с подстановками
 * trn('srv:town.items', n, { one: '{n} вещь', few: '{n} вещи', many: '{n} вещей', other: '{n} вещи' });   // от числа
 * cfgText('difficulties', [diff.id], 'name', diff.name);             // текст конфига
 * ```
 *
 * ⚠⚠ ЯЗЫК НЕ ПЕРЕДАЁТСЯ ПАРАМЕТРОМ, а берётся из ТЕКУЩЕЙ ОБЛАСТИ ТЕКСТА (`setTextProvider`): иначе язык пришлось бы протащить через
 * сотни подписей формул (`itemDescribe`, отказы `townActions`, карточки ковки), и каждая забытая дала бы русскую строку посреди
 * английского окна — молча, видно только игроку. По умолчанию области нет — язык-источник, и редактор, сим, тесты работают как
 * раньше: ни одна функция ниже не меняет ни байта русского текста. Сервер ставит область на каждый путь одного игрока
 * (`server/src/net/textScope.ts`, AsyncLocalStorage — переживает `await` транзакций).
 *
 * ⭐ 07.11: с явным разрешителем — `trWith(loc, key, source, params)` (там, где сборке передан `Localizer`, а не область).
 *
 * ⚠ ПРАВИЛА ДЛЯ ИЗВЛЕКАТЕЛЯ (он находит ключи статически, без запуска):
 *  • ключ — СТРОКОВЫЙ ЛИТЕРАЛ вида `srv:<область>.<camelCase>`; один ключ — один исходный текст;
 *  • исходник — литерал (или `const` со строковым литеральным типом — тогда извлекатель берёт его тип);
 *  • предложение — ОДНА строка с `{слотами}`, а не склейка кусков: порядок слов — дело перевода;
 *  • подстановка — как у шаблонной строки JS сегодня (`String(v)`): число печатается тем, что передал код (уже округлённым).
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigKey } from '../config/schemas.js';
import { Localizer, type Locales } from './index.js';
import { SOURCE_LANG, cfgKey, rowPathOf, type Lang } from './keys.js';

/** Разрешитель текущей области: `null` — язык-источник (переводить нечего, `Localizer` не заводится). */
export type TextProvider = () => Localizer | null;
/** Наблюдатель выданных фраз (ключ → итоговый текст) — сервер узнаёт по нему КОД отказа, не сравнивая текст (`cmdResult.code`). */
export type TextObserver = (key: string, text: string) => void;
/** Параметры подстановки: как `${v}` шаблонной строки — `String(v)`. */
export type TextParams = Readonly<Record<string, unknown>>;
/** Формы фразы по категориям `Intl.PluralRules` языка. `other` обязателен: это и дробные числа, и запас. */
export type PluralForms = Readonly<Partial<Record<Intl.LDMLPluralRule, string>>> & { readonly other: string };

const NO_SCOPE: TextProvider = () => null;
let provider: TextProvider = NO_SCOPE;
let observer: TextObserver | null = null;
/** Синхронная область `withTextLang` (перебивает провайдера); `undefined` — её нет. */
let syncScope: Localizer | null | undefined;

/**
 * Ставит провайдера текущей области. `null` — снять (язык-источник). Ставит его СЕРВЕР один раз на старте процесса; shared
 * остаётся браузерно-безопасным — асинхронную область (AsyncLocalStorage) держит сервер.
 */
export function setTextProvider(fn: TextProvider | null): void {
  provider = fn ?? NO_SCOPE;
}

/** Ставит наблюдателя выданных фраз (`null` — снять). Только сервер: коды отказов (`cmdResult.code`). */
export function setTextObserver(fn: TextObserver | null): void {
  observer = fn;
}

/** Разрешитель текущей области (`null` — язык-источник). */
export function textLocalizer(): Localizer | null {
  return syncScope !== undefined ? syncScope : provider();
}

/** Язык текущей области. */
export function textLang(): Lang {
  return textLocalizer()?.lang ?? SOURCE_LANG;
}

/** Кэш разрешителей: таблица `locales` (новый объект на каждую перезагрузку конфига — она и есть ревизия) → язык → `Localizer`. */
const cache = new WeakMap<object, Map<Lang, Localizer>>();

/**
 * Разрешитель для языка таблицы — один на (ревизию таблицы, язык). Язык-источник и пустая таблица — `null`: переводить нечего, и
 * горячий путь русского игрока не заводит ни одного объекта.
 */
export function localizerFor(locales: Locales | undefined, lang: Lang | undefined): Localizer | null {
  if (!lang || lang === SOURCE_LANG || !locales || typeof locales !== 'object') return null;
  let byLang = cache.get(locales);
  if (!byLang) { byLang = new Map(); cache.set(locales, byLang); }
  let loc = byLang.get(lang);
  if (!loc) { loc = new Localizer(locales, lang); byLang.set(lang, loc); }
  return loc;
}

/**
 * Синхронная область языка: `fn` и всё, что она зовёт СИНХРОННО, говорит на `lang`. Для тестов, редактора и сервера там, где путь не
 * ждёт. ⚠ Через `await` область не переживает — асинхронную держит сервер (`server/src/net/textScope.ts`).
 */
export function withTextLang<T>(locales: Locales | undefined, lang: Lang | undefined, fn: () => T): T {
  const prev = syncScope;
  syncScope = localizerFor(locales, lang);
  try {
    return fn();
  } finally {
    syncScope = prev;
  }
}

/** `{имя}` → `String(params[имя])`; слота нет в параметрах — остаётся как есть (видно, а не `undefined`). */
function fill(raw: string, params: TextParams | undefined): string {
  if (!params) return raw;
  return raw.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (whole, name: string) =>
    (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole));
}

/**
 * ⭐ Фраза кода на языке текущей области. Нет перевода — исходник (русский текст, ровно как сегодня). `{слоты}` — из `params`.
 */
export function tr(key: string, source: string, params?: TextParams): string {
  return phrase(textLocalizer(), key, source, params);
}

/**
 * ⭐ i18n (07.11, хвосты Ф1): та же фраза кода, что `tr`, но языком `loc` ЯВНО, а не областью — там, где сборке уже передан разрешитель
 * (`itemDisplay`: рецепт имени собирается и источником для сверки, и языком игрока). `null` — исходник. Правила извлекателя — те же:
 * ключ (2-й аргумент) и исходник (3-й) — литералы (`srvExtract.ts` собирает и `trWith`).
 */
export function trWith(loc: Localizer | null, key: string, source: string, params?: TextParams): string {
  return phrase(loc, key, source, params);
}

/** Общее тело `tr` / `trWith` (своё имя — извлекатель ищет вызовы `tr`/`trWith` с литеральным ключом, а здесь ключ — переменная). */
function phrase(loc: Localizer | null, key: string, source: string, params: TextParams | undefined): string {
  const out = fill(loc ? loc.text(key, source) : source, params);
  if (observer) observer(key, out);
  return out;
}

const rules = new Map<Lang, Intl.PluralRules>();
/** Категория числа по правилам языка (`one`/`few`/`many`/`other`…). Неизвестный рантайму язык — правила источника. */
export function pluralCategory(lang: Lang, n: number): Intl.LDMLPluralRule {
  let r = rules.get(lang);
  if (!r) {
    try { r = new Intl.PluralRules(lang); } catch { r = new Intl.PluralRules(SOURCE_LANG); }
    rules.set(lang, r);
  }
  return r.select(n);
}

/**
 * ⭐ Фраза, зависящая от числа. `forms` — исходник по категориям `Intl.PluralRules` языка-источника (у русского целые — `one`/`few`/
 * `many`, дробные — `other`); перевод — запись ключа с категориями СВОЕГО языка (у английского `one`/`other`) или одна строка.
 * `{n}` подставляется само (`String(n)`), `params` его перебивают. Только там, где код УЖЕ выбирает текст по числу.
 */
export function trn(key: string, n: number, forms: PluralForms, params?: TextParams): string {
  const loc = textLocalizer();
  const t = loc?.forms(key);
  const own = (): string => forms[pluralCategory(SOURCE_LANG, n)] ?? forms.other;
  let raw: string;
  if (t === undefined) raw = own();
  else if (typeof t === 'string') raw = t || own();
  else raw = t[pluralCategory(loc!.lang, n)] || t.other || own();   // пустая заготовка перевода — как нет перевода
  const out = fill(raw, { n, ...params });
  if (observer) observer(key, out);
  return out;
}

/**
 * ⭐ Текст конфига на языке текущей области: ключ `cfg:<таблица>/<путь по id>/<поле>` (`cfgKey`, тот же, что у извлекателя);
 * нет перевода — исходник из самих данных конфига. Путь — по `id`-подобным полям строки, как его строит `walkConfigText`.
 */
export function cfgText(table: string, path: readonly string[], field: string, source: string): string {
  const loc = textLocalizer();
  return loc ? loc.text(cfgKey(table, path, field), source) : source;
}

/**
 * ⭐ Текст СТРОКИ ТАБЛИЦЫ конфига (`def.name`, `node.description`) на языке области — путь ключа берётся по самому объекту строки
 * (`rowPathOf`), а не угадывается: у вложенных таблиц он глубокий (`weapon-anatomy/sword/strike/tags/type/values/XXII/adj`). Строки нет
 * — `undefined`; поле не строка — как есть; объект не из таблицы (копия) — исходник.
 */
export function cfgRowText(reg: ConfigRegistry, table: ConfigKey, row: object, field?: string): string;
export function cfgRowText(reg: ConfigRegistry, table: ConfigKey, row: object | null | undefined, field?: string): string | undefined;
export function cfgRowText(reg: ConfigRegistry, table: ConfigKey, row: object | null | undefined, field = 'name'): string | undefined {
  if (!row) return undefined;
  const source = (row as Record<string, unknown>)[field];
  if (typeof source !== 'string') return source as string | undefined;
  const loc = textLocalizer();
  if (!loc) return source;
  let root: unknown;
  try { root = reg.get(table); } catch { return source; }
  const path = rowPathOf(table, root, row);
  return path ? loc.text(cfgKey(table, path, field), source) : source;
}

/**
 * ⭐ i18n Ф2 (06.11): ключ `cfg:` строки таблицы по самому объекту (`rowPathOf`) — сборке имён (`itemDisplayName`, тип ковки) нужен ключ
 * фрагмента, а не только его текст: по ключу берётся и ФОРМА прилагательного под род головы. Строки нет или она не из таблицы — `undefined`.
 */
export function cfgRowKey(reg: ConfigRegistry, table: ConfigKey, row: object | null | undefined, field = 'name'): string | undefined {
  if (!row) return undefined;
  let root: unknown;
  try { root = reg.get(table); } catch { return undefined; }
  const path = rowPathOf(table, root, row);
  return path ? cfgKey(table, path, field) : undefined;
}

/**
 * ⭐ i18n Ф2: текст строки таблицы языком `loc` ЯВНО, а не областью: сборка показа сверяет имя, испечённое языком-источником, с тем же
 * рецептом на источнике (`loc` — разрешитель источника) и только тогда собирает его на языке игрока. `null` или источник — поле как есть.
 */
export function cfgRowTextWith(loc: Localizer | null, reg: ConfigRegistry, table: ConfigKey, row: object, field = 'name'): string {
  const source = (row as Record<string, unknown>)[field];
  if (typeof source !== 'string') return source === undefined || source === null ? '' : String(source);
  if (!loc || loc.lang === SOURCE_LANG) return source;
  const key = cfgRowKey(reg, table, row, field);
  return key ? loc.text(key, source) : source;
}

/** То же, что `cfgRowText`, когда у кода в руках САМА таблица (`root` — `reg.get(table)`), а не реестр (`debuffLabel(cfg.get('debuffs'))`). */
export function cfgRowTextIn(table: string, root: unknown, row: object | null | undefined, field = 'name'): string | undefined {
  if (!row) return undefined;
  const source = (row as Record<string, unknown>)[field];
  if (typeof source !== 'string') return source as string | undefined;
  const loc = textLocalizer();
  if (!loc) return source;
  const path = rowPathOf(table, root, row);
  return path ? loc.text(cfgKey(table, path, field), source) : source;
}
