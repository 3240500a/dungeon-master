import { z } from 'zod';
import { type Lang, SOURCE_LANG, placeholders } from './keys.js';
import { type Agreement, type FormSet, type LangGrammar, DEFAULT_GRAMMAR, formAgreement, joinParts, pickForm } from './forms.js';
import { DEFAULT_NAME_TEMPLATES, fillNameTemplate } from './name.js';

export * from './keys.js';
export * from './forms.js';
export * from './name.js';
export * from './tr.js';   // ⭐ i18n Ф1 (06.11): шов текста сервера — `tr` / `trn` / `cfgText` и область языка
export * from './srvCorpus.js';   // ⭐ i18n Ф2 (06.11): корпус фраз кода `srv:` (снимок `corpus.srv.json`)
export * from './uiCorpus.js';    // ⭐ i18n (07.11): корпус фраз клиента Unity `ui:` (снимок `corpus.ui.json`)
export * from './pseudo.js';      // ⭐ i18n Ф2: псевдоязык — сторож утечек кириллицы

/** Строки одного языка: ключ → форма (или набор форм). */
export const localeStringsSchema = z.record(
  z.string(),
  z.union([z.string(), z.record(z.string(), z.string())]),
);

/** Один язык: как его звать, включён ли, его грамматика и его строки. */
export const localePackSchema = z.object({
  /** Самоназвание для выбора языка в игре («Русский», «English»). */
  name: z.string().min(1),
  /** Выключенный язык не предлагается игроку, но живёт в редакторе — так переводят до выпуска. */
  enabled: z.boolean().default(false),
  /** Доля переведённого (считает сторож, не человек) — для вкладки редактора. */
  coverage: z.number().min(0).max(1).optional(),
  grammar: z.object({
    /** Пробел у ru/en/es, пустая строка у zh. */
    join: z.string().default(' '),
    /** Согласует ли язык прилагательные с существительным. */
    agrees: z.boolean().default(true),
    /** Заглавная буква собранного имени: `first` — как сегодня, `none` — не трогать. */
    capitalize: z.enum(['first', 'none']).default('first'),
  }).default({ join: ' ', agrees: true, capitalize: 'first' }),
  /**
   * ⭐ ПОРЯДОК СЛОВ В ИМЕНИ — данные языка. Ключи — `NAME_TEMPLATES` (`item.tiered`, `item.magic`,
   * `item.titled`, `item.rare`). Пусто = русский порядок по умолчанию (`DEFAULT_NAME_TEMPLATES`).
   * ⚠ Китайскому переписывать шаблоны НЕ НАДО: пробельный разделитель берётся из `grammar.join`.
   */
  templates: z.record(z.string(), z.string()).default({}),
  strings: localeStringsSchema.default({}),
});

/** Строгая таблица `locales`: язык → его пакет. Ею сверяют ОТГРУЖАЕМЫЕ данные (сторож), а не вход рантайма. */
export const localesStrictSchema = z.record(z.string(), localePackSchema);

/**
 * Таблица `locales`: язык → его пакет. ⭐ Новый язык — ПРАВКА ДАННЫХ, а не кода.
 *
 * ⚠⚠ РАЗБОР ТЕРПИМЫЙ, И ЭТО ПРАВИЛО, А НЕ ПОСЛАБЛЕНИЕ. У записи (`z.record`) нет «неизвестных ключей»:
 * лишний ключ — это ЗНАЧЕНИЕ, которое обязано сойтись со схемой пакета. А конфиг ложится во вкладку
 * ВСЁ ИЛИ НИЧЕГО (R7-14, нарочно: раньше ложилась половина, и карточки считали цену по смеси двух
 * конфигов). Со строгой записью одна битая запись перевода уносила бы ВЕСЬ конфиг вместе с ценами
 * кузницы и лавки — поймано фаззером C-07, который дописал в таблицу ключ так, как это делает новый
 * выпуск, и получил «Цена изменилась» на всём.
 *
 * Поэтому негодная запись языка ВЫБРАСЫВАЕТСЯ, остальные живут: худшее следствие битого перевода —
 * непереведённая строка, а не потерянный конфиг. То же правило уже применено к ревизиям (перевод вне
 * всех ревизий — `CONFIG_TEXT_ONLY_KEYS`), здесь оно же про разбор.
 *
 * ⚠ Строгость не потеряна: отгружаемые данные сверяет сторож `localesStrictSchema` и заодно проверяет,
 * что терпимый разбор не выбросил ни одной записи, — иначе «всё зелено» означало бы «молча потеряли язык».
 */
export const localesSchema = z.preprocess((raw) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  // ⚠ БЕЗ ПРОТОТИПА: язык с кодом `__proto__` иначе не кладётся как ключ, а ПЕРЕПИСЫВАЕТ прототип
  // объекта — и разбор всей таблицы (а с ней всего конфига) падает. Фаззер инвариантов дописывает в
  // таблицу ключи именно так, как это делает новый выпуск, так что вход достижим не только руками.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [lang, pack] of Object.entries(raw as Record<string, unknown>)) {
    if (localePackSchema.safeParse(pack).success) out[lang] = pack;
  }
  return out;
}, localesStrictSchema);

export type LocalePack = z.infer<typeof localePackSchema>;
export type Locales = z.infer<typeof localesSchema>;

/**
 * ⭐⭐ РАЗРЕШИТЕЛЬ ТЕКСТА НА ОДНОМ ЯЗЫКЕ.
 *
 * Это КЛАСС, а не модульное «текущий язык», сознательно: редактору нужно показать имя новой вещи СРАЗУ НА
 * ВСЕХ языках (требование владельца 26.10), то есть несколько языков в одном процессе одновременно. Модульное
 * состояние это бы запретило. Игровой клиент держит один экземпляр, редактор — по одному на язык.
 *
 * ⚠ Перевод не попадает ни в `revision()`, ни в `gameRevision()`: иначе правка перевода закрывала бы кузницу и лавку
 * всем игрокам с «Цена изменилась» и заново резала релиз контента. (Замер 26.10 «сервер текста не шлёт» устарел с С2:
 * ⭐ i18n Ф1 (06.11) — сервер держит по экземпляру на (таблицу, язык) через `localizerFor` и собирает текст на языке
 * игрока швом `tr.ts`; ревизии от этого не меняются — перевод по-прежнему вне них.)
 */
export class Localizer {
  readonly lang: Lang;
  private readonly strings: Readonly<Record<string, FormSet>>;
  private readonly fallback: Readonly<Record<string, FormSet>>;
  private readonly rules: LangGrammar;
  private readonly tpl: Readonly<Record<string, string>>;

  constructor(locales: Locales | undefined, lang: Lang = SOURCE_LANG) {
    this.lang = lang;
    const pack = locales?.[lang];
    const base = locales?.[SOURCE_LANG];
    this.strings = pack?.strings ?? {};
    this.fallback = lang === SOURCE_LANG ? {} : base?.strings ?? {};
    this.rules = pack?.grammar ?? DEFAULT_GRAMMAR;
    this.tpl = pack?.templates ?? {};
  }

  /** Правила склейки и согласования этого языка. */
  grammar(): LangGrammar {
    return this.rules;
  }

  /** Набор форм ключа: свой язык → язык-источник → ничего. */
  forms(key: string): FormSet | undefined {
    return this.strings[key] ?? this.fallback[key];
  }

  /**
   * Текст ключа. `source` — текст на языке-источнике ПРЯМО ИЗ КОНФИГА: для `cfg:`-ключей он и есть запас,
   * поэтому русский перевод в таблице держать не нужно — он уже лежит в самих данных.
   */
  text(key: string, source?: string): string {
    const f = this.forms(key);
    if (f === undefined) return source ?? '';
    const picked = pickForm(f);
    return picked || (source ?? '');
  }

  /** Форма ключа под согласование существительного. Для языка без согласования `agreement` игнорируется. */
  form(key: string, agreement?: Agreement, source?: string): string {
    const f = this.forms(key);
    if (f === undefined) return source ?? '';
    return pickForm(f, this.rules.agrees ? agreement : undefined) || (source ?? '');
  }

  /** Согласование, объявленное переводом существительного (у `espada` — женский, хотя у «меча» мужской). */
  agreementOf(key: string, fallback?: Agreement): Agreement | undefined {
    return formAgreement(this.forms(key)) ?? fallback;
  }

  /**
   * Текст ключа кода с подстановками `{имя}`. Подстановка — только для `ui:`-ключей: текст конфига
   * статичен, а шаблоны имён собирает генератор имён, а не этот шов.
   */
  t(key: string, params?: Readonly<Record<string, string | number>>, source?: string): string {
    const raw = this.text(key, source);
    if (!params) return raw;
    return raw.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (whole, name: string) => {
      const v = params[name];
      return v === undefined ? whole : String(v);
    });
  }

  /** Склейка частей имени по правилам языка. */
  join(parts: readonly string[]): string {
    return joinParts(parts, this.rules);
  }

  /** Шаблон сборки имени: свой у языка → русский по умолчанию. */
  template(id: string): string {
    return this.tpl[id] ?? DEFAULT_NAME_TEMPLATES[id] ?? '';
  }

  /**
   * ⭐ СОБИРАЕТ ИМЯ по шаблону языка. Единственный шов сборки имён: вместо `${adj} ${base}` в коде —
   * порядок слов из данных, связки из данных, разделитель из грамматики.
   */
  name(id: string, slots: Readonly<Record<string, string>>): string {
    return fillNameTemplate(this.template(id), slots, this.rules);
  }

  /** Есть ли у ключа перевод ИМЕННО на этом языке (без запаса) — для подсчёта покрытия. */
  has(key: string): boolean {
    return this.strings[key] !== undefined;
  }
}

/** Языки таблицы в устойчивом порядке: источник первым, дальше по алфавиту. */
export function localeLangs(locales: Locales | undefined, opts?: { enabledOnly?: boolean }): Lang[] {
  const all = Object.entries(locales ?? {})
    .filter(([, p]) => !opts?.enabledOnly || p.enabled)
    .map(([lang]) => lang)
    .sort();
  return [...all.filter((l) => l === SOURCE_LANG), ...all.filter((l) => l !== SOURCE_LANG)];
}

/**
 * ⭐ i18n (07.11, шаг 9 «тонкая раздача»): СТРОКИ ТАБЛИЦЫ ЯЗЫКОВ, КОТОРЫЕ НУЖНЫ ИГРОКУ. Текст конфига (`cfg:`) и фразы кода (`srv:`) сервер с
 * Ф1 собирает сам на языке игрока; Unity переводит только СВОЮ обвязку — ключи `ui:` (`DmText.T` / `Tn`). Сверено по рантайму `Assets/DM`
 * (07.11): таблицу читают только `DmLang` → `DmI18n.Loc` → `DmText`; сборка имени по `cfg:` (`ComposeItemName`) — только сторож `I18nCheck`
 * (эталон, а не живой конфиг); последние четыре чтения текста конфига (имя класса, статусы, ауры, «Поднято») заменены текстом сервера.
 */
export const PLAYER_STRING_PREFIXES: readonly string[] = ['ui:'];

/**
 * ⭐ ТАБЛИЦА ЯЗЫКОВ ДЛЯ ИГРОКА — тело `/api/config` и конфиг релиза контента. У каждого пакета всё, кроме строк, как есть (`name`, `enabled`,
 * `coverage`, `grammar`, `templates` — выбор языка в Unity и терпимый разбор `DmI18n.ValidPack`), а из строк — только `PLAYER_STRING_PREFIXES`.
 * Полная таблица живёт в реестре сервера (он собирает текст) и уходит редактору (`/api/config?locales=full`: вкладка «🌐 Языки» и сверка 409
 * по ревизии ПОЛНОЙ таблицы). Ревизии конфига вынос строк не сдвигает: `locales` — вне их (`CONFIG_TEXT_ONLY_KEYS`).
 * ⚠ Без прототипа (как `localesSchema`): язык с кодом `__proto__` иначе переписал бы прототип ответа, а не лёг ключом.
 */
export function playerLocales(locales: Locales): Locales {
  const out = Object.create(null) as Locales;
  for (const [lang, pack] of Object.entries(locales)) {
    const strings = Object.create(null) as LocalePack['strings'];
    for (const [k, v] of Object.entries(pack.strings ?? {})) if (PLAYER_STRING_PREFIXES.some((pre) => k.startsWith(pre))) strings[k] = v;
    out[lang] = { ...pack, strings };
  }
  return out;
}

/**
 * Доля ключей, переведённых на язык (считается, а не записывается руками). `keys` — полный корпус из
 * извлекателя: и `cfg:`, и `ui:`.
 */
export function localeCoverage(locales: Locales | undefined, lang: Lang, keys: readonly string[]): number {
  if (lang === SOURCE_LANG) return 1;
  const strings = locales?.[lang]?.strings ?? {};
  if (!keys.length) return 1;
  let have = 0;
  for (const k of keys) if (strings[k] !== undefined) have++;
  return have / keys.length;
}

/** Слоты `{имя}` ключа на языке-источнике и на переводе — сторож паритета сверяет наборы. */
export function keyPlaceholders(locales: Locales | undefined, lang: Lang, key: string): string[] {
  const f = locales?.[lang]?.strings?.[key];
  if (f === undefined) return [];
  const forms = typeof f === 'string' ? [f] : Object.values(f);
  return [...new Set(forms.flatMap(placeholders))].sort();
}
