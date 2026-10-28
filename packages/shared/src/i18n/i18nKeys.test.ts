import { describe, expect, it } from 'vitest';
import { defaultConfigData } from '../config/index.js';
import { rareNamesSchema, rareNamesStrictSchema } from '../config/schemas.js';
import locales from '../config/data/locales.json' with { type: 'json' };
import {
  I18N_INTERNAL_FIELDS, I18N_SKIP_TABLES, I18N_TEXT_FIELDS, Localizer, SOURCE_LANG,
  AGREEMENT_TOKENS, joinParts, keyPlaceholders, localeCoverage, localeLangs, localePackSchema, localesSchema,
  localesStrictSchema, normalizeAgreement, pickForm, placeholders,
  walkConfigText, type Locales,
} from './index.js';

const corpus = walkConfigText(defaultConfigData);
const table = localesSchema.parse(locales) as Locales;

/**
 * ⭐⭐ СТОРОЖ СЛОЯ ЛОКАЛИЗАЦИИ. Задача одна: сделать невозможным «встрять потом». Три беды, которые он ловит:
 *  • ключ поехал (индекс вместо `id`) — правка контента молча обнулила бы часть перевода;
 *  • поле выпало из списка текстовых — текст молча остался бы непереведённым, и это увидел бы только игрок;
 *  • перевод разошёлся с источником (сирота, другой набор подстановок) — дыра в тексте на одном языке.
 */
describe('локализация: ключи и корпус', () => {
  it('⭐ корпус игроцкого текста набран и не схлопнулся', () => {
    // Нижняя граница — от замера 26.10 (3 898 строк). Контент растёт, значит число может только расти;
    // падение ниже границы означает, что из `I18N_TEXT_FIELDS` выпало поле или таблица попала в `SKIP`.
    expect(corpus.length, 'корпус схлопнулся — проверь I18N_TEXT_FIELDS и I18N_SKIP_TABLES').toBeGreaterThanOrEqual(3800);
    const chars = corpus.reduce((s, c) => s + c.source.length, 0);
    expect(chars).toBeGreaterThanOrEqual(95_000);
  });

  it('⚠ КАЖДОЕ объявленное текстовое поле реально даёт ключи', () => {
    // Иначе список полей тихо врёт: поле объявлено, а обходчик до него не доходит (опечатка, вложенность).
    const seen = new Set(corpus.map((c) => c.field));
    const dead = I18N_TEXT_FIELDS.filter((f) => !seen.has(f));
    expect(dead, 'поле объявлено текстовым, но ни одного ключа не дало — опечатка или сломанный обход').toEqual([]);
  });

  it('⚠ ни одно ВНУТРЕННЕЕ поле не попало в корпус', () => {
    // `ref`/`source` — скрытая историческая справка ковки, `seam` — имя кодового шва: переводить их незачем.
    const leaked = corpus.filter((c) => I18N_INTERNAL_FIELDS.includes(c.field));
    expect(leaked.map((c) => c.key), 'внутреннее поле ушло в перевод — деньги на ветер').toEqual([]);
  });

  it('⚠ ни одна пропущенная таблица не попала в корпус', () => {
    const leaked = corpus.filter((c) => I18N_SKIP_TABLES.has(c.table));
    expect(leaked.map((c) => c.key)).toEqual([]);
  });

  it('⚠⚠ САМА таблица переводов не извлекается: самоназвания языков не переводят', () => {
    // Поймано расхождением замеров (3 898 против 3 902 — ровно четыре имени языков). «Русский» в списке
    // языков обязан выглядеть «Русский» и на английском, иначе игрок не найдёт свой язык.
    expect(corpus.filter((c) => c.table === 'locales'), 'обходчик полез в собственную таблицу переводов').toEqual([]);
    expect(corpus.some((c) => c.source === 'English' || c.source === 'Español')).toBe(false);
  });

  it('⭐⭐ КОЛЛИЗИЙ КЛЮЧЕЙ НЕТ: один ключ — одна строка', () => {
    const seen = new Map<string, string[]>();
    for (const c of corpus) seen.set(c.key, [...(seen.get(c.key) ?? []), c.source]);
    const dup = [...seen].filter(([, v]) => v.length > 1);
    expect(dup.map(([k, v]) => `${k} ×${v.length}`), 'два разных текста под одним ключом — перевод затрёт сам себя').toEqual([]);
  });

  it('⭐⭐ НИ ОДНОГО КЛЮЧА ПО ИНДЕКСУ', () => {
    // Ключ по индексу = вставка вещи в середину списка сдвигает перевод всех последующих. Замер 26.10: 0.
    const bad = corpus.filter((c) => !c.stable);
    expect(bad.map((c) => c.key), 'добавь опору (id/tag/when) или текстовый якорь в anchor()').toEqual([]);
  });

  it('⚠ фрагменты СБОРКИ ИМЁН в корпусе (имена вещей не хранятся, а собираются)', () => {
    // Пропустить их — получить вещь с переведённым описанием и непереведённым именем.
    for (const field of ['adj', 'with', 'epoch', 'word', 't', 'template', 'name2h'] as const) {
      expect(corpus.some((c) => c.field === field), `фрагмент имени "${field}" выпал из корпуса`).toBe(true);
    }
  });
});

describe('локализация: таблица языков', () => {
  it('таблица проходит схему и держит заявленные языки', () => {
    expect(localesSchema.safeParse(locales).success).toBe(true);
    expect(localeLangs(table)).toEqual(['ru', 'en', 'es', 'zh']);
    expect(localeLangs(table, { enabledOnly: true }), 'игроку пока предлагаем только источник').toEqual(['ru']);
  });

  it('⚠ в пакете языка-источника НЕТ строк: русский живёт в самих данных конфига', () => {
    // Иначе появляется вторая правда: правка имени в `items-base` и забытая копия в `locales.ru`.
    expect(Object.keys(table[SOURCE_LANG]?.strings ?? {}), 'русский продублирован в таблицу переводов').toEqual([]);
  });

  it('⚠ грамматика языков объявлена и различается там, где должна', () => {
    expect(table.en?.grammar.agrees, 'английский прилагательные не согласует').toBe(false);
    expect(table.es?.grammar.agrees, 'испанский согласует — и по роду, и по числу').toBe(true);
    expect(table.zh?.grammar.join, 'китайский склеивает без пробелов').toBe('');
  });

  it('⭐ СИРОТ НЕТ: каждый переведённый `cfg:`-ключ есть в корпусе', () => {
    const known = new Set(corpus.map((c) => c.key));
    for (const lang of localeLangs(table)) {
      const orphans = Object.keys(table[lang]?.strings ?? {})
        .filter((k) => k.startsWith('cfg:') && !known.has(k));
      expect(orphans, `${lang}: перевод висит на ключе, которого в конфиге больше нет`).toEqual([]);
    }
  });

  it('⭐ ПОДСТАНОВКИ СОВПАДАЮТ: у перевода тот же набор `{слотов}`, что у источника', () => {
    const src = new Map(corpus.map((c) => [c.key, placeholders(c.source)]));
    for (const lang of localeLangs(table)) {
      if (lang === SOURCE_LANG) continue;
      for (const key of Object.keys(table[lang]?.strings ?? {})) {
        const want = src.get(key);
        if (!want) continue;
        const got = keyPlaceholders(table, lang, key);
        if (!got.length && !want.length) continue;
        expect(got, `${lang}/${key}: слоты шаблона разошлись с источником — имя соберётся с дыркой`).toEqual(want);
      }
    }
  });

  it('покрытие считается, а не записывается руками', () => {
    const keys = corpus.map((c) => c.key);
    expect(localeCoverage(table, SOURCE_LANG, keys), 'источник переведён по определению').toBe(1);
    // ⚠ Раньше здесь стоял СНИМОК состояния («английского ещё нет → 0»), и он упал от первой же
    // переведённой строки (28.10). Требование не в том, СКОЛЬКО переведено, а в том, что счёт берётся из
    // таблицы: полностью переведённая таблица даёт 1, незнакомый ключ — 0, пустой язык — 0.
    const tiers = corpus.filter((c) => c.key.startsWith('cfg:item-tiers/')).map((c) => c.key);
    expect(tiers.length, 'ступени вещей есть в корпусе').toBeGreaterThan(5);
    expect(localeCoverage(table, 'en', tiers), 'ступени переведены на английский все').toBe(1);
    expect(localeCoverage(table, 'en', ['cfg:нет-такой-таблицы/нет-строки/name']), 'незнакомый ключ не переведён').toBe(0);
    expect(localeCoverage(table, 'zh', keys), 'китайского ещё нет').toBe(0);
  });
});

describe('локализация: выбор формы и склейка', () => {
  it('одна строка — одна форма на все случаи', () => {
    expect(pickForm('Bloody', 'f')).toBe('Bloody');
  });

  it('⭐ форма берётся по согласованию существительного', () => {
    const ru = { m: 'Кровавый', f: 'Кровавая', n: 'Кровавое', pl: 'Кровавые' };
    expect(pickForm(ru, 'm')).toBe('Кровавый');
    expect(pickForm(ru, 'f')).toBe('Кровавая');
    expect(pickForm(ru, 'n')).toBe('Кровавое');
    expect(pickForm(ru, 'pl')).toBe('Кровавые');
  });

  it('⭐⭐ ТОКЕНЫ ФОРМ — ЗАКРЫТЫЙ СЛОВАРЬ, и старое `p` конфига приводится к нему', () => {
    // В WoW признаки накопились двумя несовместимыми нумерациями, и живут до сих пор обе. Поэтому
    // словарь закрыт: род `m|f|n|c`, число `sg|pl`, падеж `nom…loc` — и ничего кроме.
    for (const tok of ['m', 'f', 'n', 'c', 'sg', 'pl', 'nom', 'gen']) {
      expect(AGREEMENT_TOKENS.has(tok), tok).toBe(true);
    }
    expect(AGREEMENT_TOKENS.has('p'), '«p» — это ЧИСЛО, и в словаре оно `pl`').toBe(false);
    // ⚠ Поле `gender` конфига не переписываем (232 записи и золотые эталоны) — приводим на входе.
    expect(normalizeAgreement('p')).toBe('pl');
    expect(normalizeAgreement('f')).toBe('f');
    expect(normalizeAgreement(undefined)).toBe('');
    // порядок токенов при чтении не важен, при записи канонический — падеж, число, род
    expect(pickForm({ 'gen.pl.f': 'кровавых' }, 'f.pl.gen')).toBe('кровавых');
  });

  it('⭐ признаки отбрасываются от падежа к роду: род держится дольше всех', () => {
    // Испанскому нужны род И число, русскому — только род. Один селектор обслуживает оба, и кода про
    // язык в нём нет: `pl.m` не нашлось → спускаемся к `m`.
    expect(pickForm({ m: 'Sangriento', f: 'Sangrienta', 'pl.m': 'Sangrientos' }, 'pl.m')).toBe('Sangrientos');
    expect(pickForm({ m: 'Кровавый', f: 'Кровавая' }, 'pl.m'), 'нет формы числа — берём род').toBe('Кровавый');
    // падеж отбрасывается ПЕРВЫМ: имя всегда в именительном, и форма без падежа подходит
    expect(pickForm({ f: 'Кровавая' }, 'gen.sg.f')).toBe('Кровавая');
  });

  it('⚠ неизвестное согласование не даёт пустоту', () => {
    expect(pickForm({ m: 'Bloody' }, 'xx')).toBe('Bloody');
    expect(pickForm(undefined, 'm')).toBe('');
  });

  it('⭐ склейка по правилам языка: пустые части выпадают, китайский без пробелов', () => {
    expect(joinParts(['Кровавый', '', 'меч', 'с золотым навершием'])).toBe('Кровавый меч с золотым навершием');
    expect(joinParts(['血腥', '剑'], { join: '', agrees: false })).toBe('血腥剑');
  });
});

/**
 * ⚠⚠ ТЕКСТ НЕ ИМЕЕТ ПРАВА УРОНИТЬ КОНФИГ — и терпимость не имеет права молча потерять язык.
 *
 * Разбор `locales` терпимый нарочно: у записи (`z.record`) нет «неизвестных ключей», лишний ключ — это
 * ЗНАЧЕНИЕ, обязанное сойтись со схемой пакета, а конфиг ложится во вкладку ВСЁ ИЛИ НИЧЕГО (R7-14).
 * Со строгой записью одна битая запись перевода уносила бы весь конфиг вместе с ценами кузницы и лавки
 * — ровно это поймал фаззер C-07 (`client/core/app.config.test.ts`), дописав в таблицу ключ так, как
 * это делает новый выпуск.
 *
 * Цена терпимости — «всё зелено» могло бы означать «молча потеряли язык». Поэтому здесь две проверки.
 */
describe('локализация: терпимый разбор не прячет потерю', () => {
  it('⭐⭐ ОТГРУЖАЕМЫЕ данные проходят СТРОГУЮ схему', () => {
    const strict = localesStrictSchema.safeParse(locales);
    expect(strict.success, strict.success ? '' : JSON.stringify(strict.error.issues.slice(0, 3))).toBe(true);
  });

  it('⭐⭐ терпимость не выбросила ни одной записи отгружаемых данных', () => {
    expect(Object.keys(table).sort(), 'языков после разбора — ровно столько же, сколько в файле')
      .toEqual(Object.keys(locales as Record<string, unknown>).sort());
  });

  it('⭐ битая запись языка выбрасывается, остальные живут — конфиг цел', () => {
    const parsed = localesSchema.parse({
      ru: { name: 'Русский', enabled: true },
      knobOfNextRelease: 3,          // так новый выпуск дописывает поле в таблицу
      broken: { enabled: true },     // пакет без самоназвания
      en: { name: 'English' },
    }) as Locales;
    expect(Object.keys(parsed).sort(), 'годные языки целы, негодные записи выброшены').toEqual(['en', 'ru']);
    expect(parsed.ru!.name).toBe('Русский');
  });

  it('⚠ мусор вместо таблицы даёт пустую таблицу, а не падение', () => {
    for (const junk of [null, 42, 'ru', [], undefined]) {
      expect(localesSchema.parse(junk), String(junk)).toEqual({});
    }
  });

  it('⭐⭐ `id` фрагментов имён раров — ЯВНЫЕ в отгружаемых данных', () => {
    // Разбор их достраивает (иначе оверрайд из БД старше поля уронил бы ВЕСЬ конфиг — поймано живым
    // редактором: 500 и белый экран). Но достроенный id держится за ТЕКСТ, а это ровно та хрупкость,
    // от которой поле и заводили. У того, что отгружаем, он обязан стоять явно.
    const strict = rareNamesStrictSchema.safeParse(defaultConfigData['rare-names']);
    expect(strict.success, strict.success ? '' : JSON.stringify(strict.error.issues.slice(0, 3))).toBe(true);
  });

  it('⭐ достроенный id совпадает с отгружаемым — старый оверрайд получает ТЕ ЖЕ ключи', () => {
    const shipped = defaultConfigData['rare-names'] as { nouns: { id: string; t: string }[] };
    const first = shipped.nouns[0]!;
    const legacy = { nouns: [{ t: first.t, themes: [] }, { t: first.t, themes: [] }], epithets: [] };
    const got = rareNamesSchema.parse(legacy) as { nouns: { id: string }[] };
    expect(got.nouns[0]!.id, 'тот же транслит, что у отгружаемых').toBe(first.id);
    expect(got.nouns[1]!.id, 'повтор разведён суффиксом, а не отказом').toBe(`${first.id}-2`);
  });
});

describe('локализация: разрешитель', () => {
  it('⭐ без перевода отдаёт ИСТОЧНИК из конфига, а не пустоту', () => {
    const en = new Localizer(table, 'en');
    expect(en.text('cfg:items-base/quilted-cap/name', 'Стёганый шлем')).toBe('Стёганый шлем');
    expect(en.has('cfg:items-base/quilted-cap/name'), 'перевода ещё нет').toBe(false);
  });

  it('⭐ язык без согласования игнорирует род существительного', () => {
    const t = localesSchema.parse({
      ru: { name: 'Русский', enabled: true, grammar: { join: ' ', agrees: true }, strings: {} },
      en: {
        name: 'English', enabled: true, grammar: { join: ' ', agrees: false },
        strings: { 'cfg:item-tiers/t3/name': { m: 'Bloody', f: 'WRONG' } },
      },
    });
    expect(new Localizer(t, 'en').form('cfg:item-tiers/t3/name', 'f')).toBe('Bloody');
    const ru = localePackSchema.parse({ name: 'Русский', enabled: true });
    const es = localesSchema.parse({
      ru,
      es: {
        name: 'Español', enabled: true, grammar: { join: ' ', agrees: true },
        strings: { 'cfg:item-tiers/t3/name': { m: 'Sangriento', f: 'Sangrienta' } },
      },
    });
    expect(new Localizer(es, 'es').form('cfg:item-tiers/t3/name', 'f')).toBe('Sangrienta');
  });

  it('⭐⭐ РОД — свойство ЯЗЫКА: «меч» мужского рода, `espada` женского', () => {
    const t = localesSchema.parse({
      ru: { name: 'Русский', enabled: true, grammar: { join: ' ', agrees: true }, strings: {} },
      es: {
        name: 'Español', enabled: true, grammar: { join: ' ', agrees: true },
        strings: { 'cfg:weapon-types/sword/name': { one: 'espada', agreement: 'f' } },
      },
    });
    const es = new Localizer(t, 'es');
    expect(es.agreementOf('cfg:weapon-types/sword/name', 'm'), 'перевод объявил свой род').toBe('f');
    expect(new Localizer(t, 'ru').agreementOf('cfg:weapon-types/sword/name', 'm'), 'у источника — род из данных вещи').toBe('m');
  });

  it('запас идёт к языку-источнику, а потом к тексту из конфига', () => {
    const t = localesSchema.parse({
      ru: { name: 'Русский', enabled: true, grammar: { join: ' ', agrees: true }, strings: { 'ui:town.forge.title': 'Кузница' } },
      en: { name: 'English', enabled: false, grammar: { join: ' ', agrees: false }, strings: {} },
    });
    expect(new Localizer(t, 'en').t('ui:town.forge.title'), 'нет английского — показываем русский, не пустоту').toBe('Кузница');
    expect(new Localizer(t, 'xx').t('ui:town.forge.title')).toBe('Кузница');
  });

  it('⭐ подстановки `{имя}` только у ключей кода', () => {
    const t = localesSchema.parse({
      ru: {
        name: 'Русский', enabled: true, grammar: { join: ' ', agrees: true },
        strings: { 'ui:altar.seals': 'Печатей: {n} из {max}' },
      },
    });
    const ru = new Localizer(t, 'ru');
    expect(ru.t('ui:altar.seals', { n: 3, max: 8 })).toBe('Печатей: 3 из 8');
    expect(ru.t('ui:altar.seals', { n: 3 }), 'забытый параметр оставляет слот видимым, а не рисует undefined').toBe('Печатей: 3 из {max}');
  });
});
