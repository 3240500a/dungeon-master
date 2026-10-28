/**
 * ПРОДЮСЕР эталона СБОРКИ ИМЁН И ВЫБОРА ФОРМ для Unity-клиента.
 *
 * Зачем он нужен именно здесь. Русское согласование было зашито в КОД, и притом в четырёх независимых
 * реализациях — две в TS и две в Unity (`DmTownCraft.Agree`, `DmTownUpgrade.DeclineTier`), причём версия
 * Unity была богаче веба. В паритете их не держало ничего, кроме золотых эталонов окон, а те сверяют
 * ИТОГОВЫЕ строки окон, и расхождение правила видно в них только если оно попало в показанную вещь.
 * Замер 27.10: две TS-копии расходились на слове «падающий» в среднем роде («падающое» против
 * «падающее»), и эталоны этого не ловили — слово живёт в данных, которые ходят только через одну из них.
 *
 * Теперь правило ОДНО: выбор формы (`pickForm`) + шаблон локали (`fillNameTemplate`) + один запас
 * арифметики на русский (`ruAgree`). Этот эталон сверяет его ПОШТУЧНО, на всех языках таблицы, и
 * поэтому порт в C# нельзя «почти» повторить: расхождение в одном окончании или в одном пробеле
 * показывает конкретную строку.
 *
 * Что внутри:
 *  • `grammar` — разделитель, согласует ли язык, правило заглавной, шаблоны порядка слов;
 *  • `forms` — выбор формы по согласованию: точное попадание, спуск признаков, запасы, мусорный ключ;
 *  • `templates` — подстановка в шаблон: пустые слоты, связки, литералы, регистр токена;
 *  • `names` — собранные имена: каждая база × ступени × все формы имени × все языки.
 *
 * Эталон: `__golden__/unity_i18n.json` → Unity `Assets/DM/UI/Tests/unity_i18n_golden.json`,
 * проверка — `I18nCheck` (порт `pickForm`/`fillNameTemplate`/`ruAgree`).
 * Перезапись: `npx vitest run packages/shared/src/i18n/unityI18nGolden.gen.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ConfigRegistry } from '../config/registry.js';
import { composeItemName, type NameShape } from '../formulas/itemName.js';
import { ruAgree } from '../formulas/ruAgree.js';
import { Localizer, localeLangs, localesSchema, type Locales } from './index.js';
import { AGREEMENT_TOKENS, normalizeAgreement, pickForm } from './forms.js';
import { NAME_TEMPLATES, fillNameTemplate } from './name.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const locales = localesSchema.parse(reg.get('locales')) as Locales;
const langs = localeLangs(locales);

const frag = (key: string, source: string): { key: string; source: string } => ({ key, source });
const SHAPES: readonly NameShape[] = ['tiered', 'magic', 'titled', 'rare'];
const SLOT_NAMES = ['tier', 'prefix', 'suffix', 'title', 'noun', 'epithet'] as const;

/** Случаи выбора формы — не «типичные», а те, в которых реализации и расходятся. */
const FORM_CASES: ReadonlyArray<{ why: string; forms: unknown; agreement: string }> = [
  { why: 'точное попадание по роду', forms: { m: 'Кровавый', f: 'Кровавая', n: 'Кровавое', pl: 'Кровавые' }, agreement: 'f' },
  { why: 'одна строка — одна форма на все случаи', forms: 'Bloody', agreement: 'f' },
  { why: 'испанское число: род+число', forms: { m: 'Sangriento', f: 'Sangrienta', 'pl.m': 'Sangrientos' }, agreement: 'pl.m' },
  { why: 'спуск числа к роду, когда формы числа нет', forms: { m: 'Кровавый', f: 'Кровавая' }, agreement: 'pl.m' },
  { why: 'падеж отбрасывается первым', forms: { f: 'Кровавая' }, agreement: 'gen.sg.f' },
  { why: 'порядок токенов при чтении не важен', forms: { 'gen.pl.f': 'кровавых' }, agreement: 'f.pl.gen' },
  { why: 'мусорный ключ согласования не даёт пустоту', forms: { m: 'Bloody' }, agreement: 'xx' },
  { why: 'согласования нет вовсе — берём запас', forms: { n: 'Кровавое', f: 'Кровавая' }, agreement: '' },
  { why: 'старое `p` конфига приводится к `pl`', forms: { m: 'Кровавый', pl: 'Кровавые' }, agreement: normalizeAgreement('p') },
  // ⚠ Эти два случая НАЗВАЛА встречная проверка: без них порт мог переставить лестницу запасов или
  // порядок спуска признаков, и эталон бы сошёлся — различающего входа в нём просто не было.
  { why: '⚠ лестница запасов: `one` раньше `m`', forms: { m: 'МУЖ', one: 'ОДНА', sg: 'ЕД' }, agreement: 'zz' },
  { why: '⚠ спуск признаков: число держится дольше падежа', forms: { 'sg.f': 'ЧИСЛО+РОД', 'nom.f': 'ПАДЕЖ+РОД' }, agreement: 'nom.sg.f' },
];

/** Случаи шаблона — пустые слоты, связки, литералы, регистр. Именно здесь ломались другие игры. */
const TPL_CASES: ReadonlyArray<{ why: string; tpl: string; slots: Record<string, string>; join: string }> = [
  { why: 'обычная подстановка', tpl: '{tier} {base}', slots: { tier: 'Кровавый', base: 'меч' }, join: ' ' },
  { why: 'пустой слот не оставляет двойного пробела', tpl: '{tier} {base} {suffix}', slots: { base: 'меч' }, join: ' ' },
  { why: 'связка только при двух непустых соседях', tpl: '{base} of {title}', slots: { base: 'Sword', title: 'Thirst' }, join: ' ' },
  { why: '⚠ висящая связка: «Sword of» без слова', tpl: '{base} of {title}', slots: { base: 'Sword' }, join: ' ' },
  { why: 'китайский: разделитель из грамматики, шаблон не правлен', tpl: '{tier} {base}', slots: { tier: '血腥', base: '剑' }, join: '' },
  { why: 'литерал без пробелов не разъезжается', tpl: '«{a}»', slots: { a: 'Меч' }, join: ' ' },
  { why: 'литерал без соседа не выводится', tpl: '«{a}»', slots: {}, join: ' ' },
  { why: 'регистр у ТОКЕНА, а не поиском подстроки', tpl: '{b} {a:lower}', slots: { a: 'Меч', b: 'большой' }, join: ' ' },
  { why: 'шаблон без слотов отдаётся как есть', tpl: 'Меч', slots: {}, join: ' ' },
  // ⚠⚠ НАБОР «ПРОБЕЛА» — ПО ECMAScript, и он НЕ СОВПАДАЕТ с .NET в обе стороны (замер 27.10 на
  // обеих настоящих реализациях). Без этих строк эталон различал только «ключа нет» и «пустая строка»,
  // а мусор импорта — 0x85 из CP1252 и BOM из копирования — расходился бы молча.
  { why: '⚠ U+0085 пробелом НЕ считается (а .NET считает) — слот непуст, связка выводится', tpl: '{base} de {title}', slots: { base: 'espada', title: '' }, join: ' ' },
  { why: '⚠ U+FEFF пробел ЕСТЬ (а для .NET нет) — слот пуст, связки нет', tpl: '{base} de {title}', slots: { base: 'espada', title: '﻿' }, join: ' ' },
  { why: '⚠ BOM в ИМЕНИ слота подрезается — иначе ступень теряется целиком', tpl: '{﻿tier} {base}', slots: { tier: 'Кровавый', base: 'меч' }, join: ' ' },
  { why: '⚠ «поЛукафтан»: заглавная у первой БУКВЫ, а не у первого символа', tpl: '«{a}»', slots: { a: 'меч' }, join: ' ' },
];

/**
 * ⭐⭐ СТЕНД ЗАПОЛНЕННОГО ПЕРЕВОДА. Сегодня в `locales` НЕТ НИ ОДНОЙ строки (замер: 0 на каждый язык),
 * поэтому раздел `names` выше проверяет только порядок слов и запас арифметики — а путь «ключ → формы →
 * согласование, объявленное переводом» не трогает ни одна строка эталона. Именно в нём порт и ломается
 * незаметно: он оживёт через месяц, когда переводы начнут заполнять, и разойдётся молча.
 *
 * Поэтому здесь таблица языков задана НАРОЧНО заполненной, и проверка Unity берёт её из эталона как есть:
 *  • `es` — согласование ОБЪЯВЛЯЕТ ПЕРЕВОД: `espada` женского рода, хотя у «меча» мужской, и ступень
 *    обязана встать в женскую форму, а слова встать в испанском порядке со связкой `de`;
 *  • `en` — `agrees: false`: согласование ИГНОРИРУЕТСЯ, даже если форма под него в таблице есть;
 *  • `zh` — склейка без пробелов и без заглавной, шаблоны не переписаны (`join: ""` достаточно);
 *  • `es` без своей строки ступени — спуск к языку-источнику (`fallback`), форма выбирается всё равно;
 *  • старое `p` конфига (вещь во множественном) приводится к `pl` и выбирает множественную форму.
 */
const STAND_LOCALES: Locales = localesSchema.parse({
  ru: {
    name: 'Русский', enabled: true, grammar: { join: ' ', agrees: true, capitalize: 'first' },
    templates: { 'item.tiered': '{tier} {base}', 'item.titled': '{base} {title}' },
    strings: {
      'cfg:item-tiers/t9/name': { m: 'Кровавый', f: 'Кровавая', n: 'Кровавое', pl: 'Кровавые' },
      'cfg:item-tiers/t8/name': { m: 'Поздний', f: 'Поздняя', n: 'Позднее', pl: 'Поздние' },
    },
  },
  es: {
    name: 'Español', enabled: true, grammar: { join: ' ', agrees: true, capitalize: 'first' },
    templates: { 'item.tiered': '{base} {tier}', 'item.titled': '{base} de {title}' },
    strings: {
      'cfg:items-base/sword/name': { one: 'espada', agreement: 'f' },
      'cfg:items-base/boots/name': { one: 'botas', agreement: 'pl.f' },
      // ⚠ Голова, у которой форм НЕСКОЛЬКО: её текст берётся БЕЗ согласования (`Text`), иначе имя
      // согласовывалось бы само с собой. Различающий вход — тоже из встречной проверки.
      'cfg:items-base/axe/name': { m: 'hachaM', f: 'hachaF', agreement: 'f' },
      // ⚠ Синоним `gender` вместо `agreement`: в данных конфига поле зовётся так, и перевод вправе
      // объявить согласование тем же именем.
      'cfg:items-base/mace/name': { one: 'maza', gender: 'f' },
      'cfg:item-tiers/t9/name': { m: 'sangriento', f: 'sangrienta', 'pl.f': 'sangrientas' },
      'cfg:uniques/u1/name': 'hermanos oscuros',
    },
  },
  en: {
    name: 'English', enabled: true, grammar: { join: ' ', agrees: false, capitalize: 'first' },
    templates: { 'item.tiered': '{tier} {base}', 'item.titled': '{base} of {title}' },
    strings: {
      'cfg:items-base/sword/name': 'sword',
      // ⚠ Форма под женский род в таблице ЕСТЬ, но язык не согласует — выбрана она быть НЕ ДОЛЖНА.
      'cfg:item-tiers/t9/name': { m: 'bloody', f: 'НЕ-ДОЛЖНО-ВЫБРАТЬСЯ' },
    },
  },
  zh: {
    name: '简体中文', enabled: true, grammar: { join: '', agrees: false, capitalize: 'none' }, templates: {},
    strings: { 'cfg:items-base/sword/name': '剑', 'cfg:item-tiers/t9/name': '血腥' },
  },
}) as Locales;

/** Случаи сборки по ЗАПОЛНЕННОЙ таблице: какой язык, какая форма имени, из каких фрагментов. */
const TRANS_CASES: ReadonlyArray<{
  why: string; lang: string; shape: NameShape; head: { key: string; source: string };
  agreement?: string; parts?: Readonly<Record<string, { key: string; source: string }>>;
}> = [
  { why: 'согласование объявил ПЕРЕВОД: espada женского, хотя «меч» мужского',
    lang: 'es', shape: 'tiered', head: { key: 'cfg:items-base/sword/name', source: 'Меч' }, agreement: 'm',
    parts: { tier: { key: 'cfg:item-tiers/t9/name', source: 'Кровавый' } } },
  { why: 'род+число перевода: botas → множественная женская форма',
    lang: 'es', shape: 'tiered', head: { key: 'cfg:items-base/boots/name', source: 'Сапоги' }, agreement: 'p',
    parts: { tier: { key: 'cfg:item-tiers/t9/name', source: 'Кровавый' } } },
  { why: 'испанский порядок и связка: {base} de {title}',
    lang: 'es', shape: 'titled', head: { key: 'cfg:items-base/sword/name', source: 'Меч' }, agreement: 'm',
    parts: { title: { key: 'cfg:uniques/u1/name', source: 'тёмных братьев' } } },
  { why: '⚠ связки нет, если титул не переведён и пуст — «espada de» без слова',
    lang: 'es', shape: 'titled', head: { key: 'cfg:items-base/sword/name', source: 'Меч' }, agreement: 'm',
    parts: { title: { key: 'cfg:uniques/u2/name', source: '' } } },
  { why: 'спуск к языку-источнику: своей строки ступени у es нет, форма берётся из ru',
    lang: 'es', shape: 'tiered', head: { key: 'cfg:items-base/sword/name', source: 'Меч' }, agreement: 'm',
    parts: { tier: { key: 'cfg:item-tiers/t8/name', source: 'Поздний' } } },
  { why: '⚠ agrees:false — согласование игнорируется, хотя форма под него есть',
    lang: 'en', shape: 'tiered', head: { key: 'cfg:items-base/sword/name', source: 'Меч' }, agreement: 'f',
    parts: { tier: { key: 'cfg:item-tiers/t9/name', source: 'Кровавый' } } },
  { why: 'китайский: без пробелов и без заглавной, шаблон не переписан',
    lang: 'zh', shape: 'tiered', head: { key: 'cfg:items-base/sword/name', source: 'Меч' }, agreement: 'm',
    parts: { tier: { key: 'cfg:item-tiers/t9/name', source: 'Кровавый' } } },
  { why: 'русский берёт форму ИЗ ТАБЛИЦЫ, а не из арифметики',
    lang: 'ru', shape: 'tiered', head: { key: 'cfg:items-base/spear/name', source: 'Копьё' }, agreement: 'n',
    parts: { tier: { key: 'cfg:item-tiers/t9/name', source: 'Кровавый' } } },
  { why: 'перевода нет вовсе — запас арифметики на русском',
    lang: 'ru', shape: 'tiered', head: { key: 'cfg:items-base/spear/name', source: 'Копьё' }, agreement: 'n',
    parts: { tier: { key: 'cfg:item-tiers/нет-такого/name', source: 'Широкий' } } },
  { why: '⚠ перевода нет и язык не русский — русское слово БЕЗ русского окончания',
    lang: 'es', shape: 'tiered', head: { key: 'cfg:items-base/spear/name', source: 'Копьё' }, agreement: 'n',
    parts: { tier: { key: 'cfg:item-tiers/нет-такого/name', source: 'Широкий' } } },
  { why: '⚠ голова С ФОРМАМИ берётся БЕЗ согласования, но САМА его объявляет',
    lang: 'es', shape: 'tiered', head: { key: 'cfg:items-base/axe/name', source: 'Секира' }, agreement: 'm',
    parts: { tier: { key: 'cfg:item-tiers/t9/name', source: 'Кровавый' } } },
  { why: '⚠ согласование объявлено синонимом `gender`, а не `agreement`',
    lang: 'es', shape: 'tiered', head: { key: 'cfg:items-base/mace/name', source: 'Булава' }, agreement: 'm',
    parts: { tier: { key: 'cfg:item-tiers/t9/name', source: 'Кровавый' } } },
];

describe('эталон i18n для Unity', () => {
  it('⭐⭐ пишет __golden__/unity_i18n.json', () => {
    const bases = reg.get('items.base');
    const tiers = reg.get('item-tiers');
    const affixes = reg.get('affixes');
    const rare = reg.get('rare-names');
    const pre = affixes.filter((a) => a.kind === 'prefix' && a.word);
    const suf = affixes.filter((a) => a.kind === 'suffix' && a.word);

    const grammar = Object.fromEntries(langs.map((l) => {
      const loc = new Localizer(locales, l);
      return [l, {
        ...loc.grammar(),
        templates: Object.fromEntries(Object.values(NAME_TEMPLATES).map((id) => [id, loc.template(id)])),
      }];
    }));

    const forms = FORM_CASES.map((c) => ({
      why: c.why, forms: c.forms, agreement: c.agreement,
      out: pickForm(c.forms as Parameters<typeof pickForm>[0], c.agreement),
    }));

    const templates = TPL_CASES.map((c) => ({
      why: c.why, tpl: c.tpl, slots: c.slots, join: c.join,
      out: fillNameTemplate(c.tpl, c.slots, { join: c.join, agrees: true, capitalize: 'first' }),
    }));

    // ⭐ ИМЕНА: каждая база × каждая форма имени × каждый язык. Ступень и аффиксы берутся по кругу,
    // чтобы в выборку попали и прилагательные с мягкой основой, и шипящие, и не-прилагательные.
    // ⚠ 28.10: в живом `locales` появились строки (английский, 629), а Unity собирает эти имена по ГРАММАТИКЕ эталона
    // (`grammar` выше) — строк перевода ей здесь не дают, путь заполненного перевода проверяет стенд `translated`.
    // Поэтому имена — по той же таблице без `strings`: иначе эталон требует перевода, которого в нём нет.
    const grammarOnly = Object.fromEntries(Object.entries(locales).map(([l, p]) => [l, { ...p, strings: {} }])) as Locales;
    const names: Array<Record<string, unknown>> = [];
    bases.forEach((b, i) => {
      const tier = tiers[i % tiers.length]!;
      const p = pre[i % pre.length]!, s = suf[i % suf.length]!;
      const noun = rare.nouns[i % rare.nouns.length]!, ep = rare.epithets[i % rare.epithets.length]!;
      for (const shape of SHAPES) {
        const spec = {
          shape,
          base: frag(`cfg:items-base/${b.id}/name`, b.name),
          agreement: b.gender,
          tier: shape === 'tiered' && tier.name ? frag(`cfg:item-tiers/${tier.id}/name`, tier.name) : undefined,
          prefix: shape === 'magic' ? frag(`cfg:affixes/${p.id}/word`, p.word!) : undefined,
          suffix: shape === 'magic' ? frag(`cfg:affixes/${s.id}/word`, s.word!) : undefined,
          title: shape === 'titled' ? frag(`cfg:rare-names/epithets/${ep.id}/t`, ep.t) : undefined,
          noun: shape === 'rare' ? frag(`cfg:rare-names/nouns/${noun.id}/t`, noun.t) : undefined,
          epithet: shape === 'rare' ? frag(`cfg:rare-names/epithets/${ep.id}/t`, ep.t) : undefined,
        };
        names.push({
          // ⚠ Фрагмент лежит в строке ЦЕЛИКОМ — ключ И текст: проверка Unity обязана собрать имя САМА,
          // не читая конфиг, и собрать его ТЕМИ ЖЕ ключами. Иначе первая заполненная форма разъедется молча.
          base: b.id, gender: b.gender ?? 'm', shape,
          head: spec.base,
          parts: Object.fromEntries(SLOT_NAMES.filter((s) => spec[s]).map((s) => [s, spec[s]!])),
          out: Object.fromEntries(langs.map((l) => [l, composeItemName(new Localizer(grammarOnly, l), spec)])),
        });
      }
    });

    // ⚠ Запас арифметики — отдельным блоком: Unity обязана повторить ЕГО, а не свою прежнюю версию.
    const adjectives = [...new Set([
      ...tiers.map((t) => t.name ?? ''),
      ...pre.map((a) => a.word!),
      'падающий', 'поздний', 'ранний', 'широкий', 'большой', 'тугой', 'синий', 'с долом',
    ].filter(Boolean))].sort();
    const ruFallback = adjectives.map((w) => ({
      word: w,
      out: Object.fromEntries(['m', 'f', 'n', 'pl'].map((g) => [g, ruAgree(w, g)])),
    }));

    const translated = {
      // Таблица языков уезжает в эталон ЦЕЛИКОМ: проверка Unity обязана читать её тем же разбором.
      locales: STAND_LOCALES,
      cases: TRANS_CASES.map((c) => {
        const spec = {
          shape: c.shape, base: c.head, agreement: c.agreement,
          ...Object.fromEntries(SLOT_NAMES.filter((s) => c.parts?.[s]).map((s) => [s, c.parts![s]!])),
        };
        return { ...c, out: composeItemName(new Localizer(STAND_LOCALES, c.lang), spec) };
      }),
    };

    const golden = {
      langs,
      tokens: [...AGREEMENT_TOKENS].sort(),
      sourceLang: 'ru',
      grammar,
      forms,
      templates,
      ruFallback,
      names,
      translated,
    };

    // сторожа выборки: эталон обязан нести и согласующие языки, и несогласующие, и язык без пробелов
    expect(langs.length, 'языков в таблице').toBeGreaterThanOrEqual(2);
    expect(Object.values(grammar).some((g) => g.agrees), 'есть согласующий язык').toBe(true);
    expect(Object.values(grammar).some((g) => !g.agrees), 'есть несогласующий язык').toBe(true);
    expect(Object.values(grammar).some((g) => g.join === ''), 'есть язык без пробелов').toBe(true);
    expect(names.length, 'имён в эталоне').toBeGreaterThan(300);
    expect(ruFallback.some((r) => r.out.n !== r.word), 'запас арифметики что-то меняет').toBe(true);
    // ⚠ Стенд перевода обязан ДОКАЗАТЬ каждое правило, иначе проверка Unity сойдётся ни на чём.
    const byWhy = new Map(translated.cases.map((c) => [c.why, c.out]));
    expect([...byWhy.values()].filter((o) => /[a-z]/.test(o)).length, 'переведённые имена в стенде').toBeGreaterThan(3);
    expect([...byWhy].some(([, o]) => o === 'Espada sangrienta'), 'согласование из перевода').toBe(true);
    expect([...byWhy].some(([, o]) => o.includes('ДОЛЖНО')), '⚠ agrees:false выбрал согласованную форму').toBe(false);
    expect([...byWhy].some(([, o]) => o === '血腥剑'), 'китайский без пробелов').toBe(true);
    expect([...byWhy].some(([, o]) => /\bde\b/.test(o)), 'связка выведена').toBe(true);
    expect(translated.cases.filter((c) => c.why.includes('связки нет')).every((c) => !/\bde\b/.test(c.out)),
      '⚠ висящая связка при пустом слоте').toBe(true);

    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unity_i18n.json'), JSON.stringify(golden));
  });
});
