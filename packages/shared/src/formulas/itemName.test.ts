import { describe, expect, it } from 'vitest';
import { defaultConfigData } from '../config/index.js';
import {
  DEFAULT_NAME_TEMPLATES, Localizer, NAME_TEMPLATES, fillNameTemplate,
  localesSchema, type Locales,
} from '../i18n/index.js';
import { composeItemName } from './itemName.js';
import { ruAgree } from './ruAgree.js';

const table = localesSchema.parse(defaultConfigData.locales) as Locales;
const ru = new Localizer(table, 'ru');
const en = new Localizer(table, 'en');
const es = new Localizer(table, 'es');
const zh = new Localizer(table, 'zh');

const bases = defaultConfigData['items.base'] as Array<{ id: string; name: string; gender?: string }>;
const tiers = defaultConfigData['item-tiers'] as Array<{ id: string; name?: string }>;
const affixes = defaultConfigData.affixes as Array<{ id: string; word?: string; kind?: string }>;
const rare = defaultConfigData['rare-names'] as {
  nouns: Array<{ id: string; t: string }>;
  epithets: Array<{ id: string; t: string }>;
};

const frag = (key: string, source: string): { key: string; source: string } => ({ key, source });
const head = (b: { id: string; name: string }): { key: string; source: string } =>
  frag(`cfg:items-base/${b.id}/name`, b.name);

/**
 * ⭐⭐ ОРАКУЛ: сборка имён ДО правки, слово в слово как она была в `itemgen.ts` (`declineTier` +
 * склейка пробелом). Он здесь ровно для одного — доказать, что перевод сборки имён на данные НЕ
 * СДВИНУЛ НИ ОДНОГО РУССКОГО ИМЕНИ. Пока таблица форм пуста, новый шов обязан совпадать с ним
 * побайтово; как только формы заполнят, оракул начнёт расходиться законно — и его надо будет снять.
 */
function oracleDecline(adj: string, gender: string | undefined): string {
  if (!adj || gender === 'm' || !gender) return adj;
  const stem = adj.replace(/(ый|ий|ой)$/, '');
  if (stem === adj) return adj;
  if (gender === 'f') return stem + 'ая';
  if (gender === 'n') return stem + 'ое';
  if (gender === 'p') return stem + (/[кгхжшчщ]$/.test(stem) ? 'ие' : 'ые');
  return adj;
}
const oracleTiered = (prefix: string, baseName: string, g?: string): string =>
  prefix ? `${oracleDecline(prefix, g)} ${baseName}` : baseName;
const oracleMagic = (baseName: string, g: string | undefined, pre: string, suf: string): string => {
  let n = baseName;
  if (pre) n = `${oracleDecline(pre, g)} ${n}`;
  if (suf) n = `${n} ${suf}`;
  return n;
};
const oracleTitled = (baseName: string, g: string | undefined, title: string): string =>
  title ? `${baseName} ${oracleDecline(title, g)}` : baseName;

describe('сборка имени: русский не сдвинулся ни на байт', () => {
  it('⭐⭐ ступень × база — все сочетания сходятся с оракулом', () => {
    let n = 0;
    for (const b of bases) {
      for (const t of tiers) {
        const got = composeItemName(ru, {
          shape: 'tiered',
          base: head(b),
          agreement: b.gender,
          tier: t.name ? frag(`cfg:item-tiers/${t.id}/name`, t.name) : undefined,
        });
        expect(got, `${t.name} + ${b.name}`).toBe(oracleTiered(t.name ?? '', b.name, b.gender));
        n++;
      }
    }
    expect(n, 'сочетаний проверено').toBeGreaterThan(400);
  });

  it('⭐⭐ магия: слово-префикс × база × слово-суффикс сходятся с оракулом', () => {
    const pre = affixes.filter((a) => a.kind === 'prefix' && a.word);
    const suf = affixes.filter((a) => a.kind === 'suffix' && a.word);
    expect(pre.length, 'префиксов со словом').toBeGreaterThan(5);
    let n = 0;
    for (const b of bases) {
      for (let i = 0; i < pre.length; i++) {
        const p = pre[i]!, s = suf[i % suf.length];
        const got = composeItemName(ru, {
          shape: 'magic',
          base: head(b),
          agreement: b.gender,
          prefix: frag(`cfg:affixes/${p.id}/word`, p.word!),
          suffix: s?.word ? frag(`cfg:affixes/${s.id}/word`, s.word) : undefined,
        });
        expect(got, `${p.word} + ${b.name} + ${s?.word}`)
          .toBe(oracleMagic(b.name, b.gender, p.word!, s?.word ?? ''));
        n++;
      }
    }
    expect(n).toBeGreaterThan(400);
  });

  it('⭐⭐ рар: база × основа × эпитет сходятся с оракулом', () => {
    let n = 0;
    for (const b of bases) {
      for (let i = 0; i < rare.nouns.length; i++) {
        const noun = rare.nouns[i]!, ep = rare.epithets[i % rare.epithets.length]!;
        const got = composeItemName(ru, {
          shape: 'rare',
          base: head(b),
          agreement: b.gender,
          noun: frag(`cfg:rare-names/nouns/${noun.id}/t`, noun.t),
          epithet: frag(`cfg:rare-names/epithets/${ep.id}/t`, ep.t),
        });
        expect(got, `${b.name} + ${noun.t} ${ep.t}`)
          .toBe(oracleTitled(b.name, b.gender, `${noun.t} ${ep.t}`));
        n++;
      }
    }
    expect(n).toBeGreaterThan(400);
  });

  it('пустой слот не оставляет ни лишнего пробела, ни висящей связки', () => {
    expect(composeItemName(ru, { shape: 'tiered', base: head(bases[0]!) })).toBe(bases[0]!.name);
    // у рара может не быть эпитета — вещь без вторичного свойства
    expect(composeItemName(ru, {
      shape: 'rare', base: frag('', 'Меч'), agreement: 'm', noun: frag('', 'Искра'),
    })).toBe('Меч Искра');
  });
});

describe('сборка имени: язык добавляется ДАННЫМИ', () => {
  const swordHead = frag('cfg:items-base/sword/name', 'Меч');

  it('⭐ порядок слов — из шаблона локали: испанский ставит прилагательное ПОЗАДИ', () => {
    const spec = {
      shape: 'tiered' as const, base: swordHead, agreement: 'm',
      tier: frag('cfg:item-tiers/t3/name', 'Кровавый'),
    };
    expect(composeItemName(ru, spec)).toBe('Кровавый Меч');
    expect(composeItemName(es, spec), 'тот же вызов, другой порядок — и ни строки кода про язык').toBe('Меч Кровавый');
  });

  it('⭐⭐ КИТАЙСКОМУ НЕ НУЖЕН НИ ОДИН ШАБЛОН — только `join: ""`', () => {
    expect(table.zh!.templates, 'шаблонов у китайского нет').toEqual({});
    const got = composeItemName(zh, {
      shape: 'tiered', base: frag('x', '剑'), tier: frag('y', '血腥'),
    });
    expect(got, 'пробельный разделитель шаблона взят из грамматики языка').toBe('血腥剑');
  });

  it('⭐ связка выводится, только если непусты ОБА соседних слота', () => {
    const withTitle = composeItemName(en, {
      shape: 'titled', base: frag('x', 'Sword'), title: frag('y', 'Thirst'),
    });
    expect(withTitle).toBe('Sword of Thirst');
    const noTitle = composeItemName(en, { shape: 'titled', base: frag('x', 'Sword') });
    expect(noTitle, '⚠ «Sword of» без слова — ровно та беда, от которой правило и нужно').toBe('Sword');
  });

  it('⭐ язык без согласования не получает русских окончаний', () => {
    // Ключи — без перевода нарочно: английский дорастает до живых ключей (28.10 «Fine» у t3), а проверка — про
    // показ ИСТОЧНИКА в языке без согласования, а не про содержимое перевода.
    const got = composeItemName(en, {
      shape: 'tiered', base: frag('test:untranslated/base', 'Сапоги'), agreement: 'p',
      tier: frag('test:untranslated/tier', 'Кровавый'),
    });
    expect(got, 'перевода нет — показываем источник как есть, без «Кровавые» в английской фразе')
      .toBe('Кровавый Сапоги');
    expect(composeItemName(ru, {
      shape: 'tiered', base: frag('cfg:items-base/boots/name', 'Сапоги'), agreement: 'p',
      tier: frag('cfg:item-tiers/t3/name', 'Кровавый'),
    }), 'а русскому запас окончаний достаётся').toBe('Кровавые Сапоги');
  });

  it('⭐⭐ явные формы ПЕРЕБИВАЮТ арифметику — и это выход из «Падающое копьё»', () => {
    const t = localesSchema.parse({
      ru: {
        name: 'Русский', enabled: true,
        templates: DEFAULT_NAME_TEMPLATES,
        strings: { 'cfg:item-tiers/t3/name': { m: 'Падающий', f: 'Падающая', n: 'падающее!', pl: 'Падающие' } },
      },
    }) as Locales;
    const loc = new Localizer(t, 'ru');
    const got = composeItemName(loc, {
      shape: 'tiered', base: frag('cfg:items-base/spear/name', 'копьё'), agreement: 'n',
      tier: frag('cfg:item-tiers/t3/name', 'Падающий'),
    });
    expect(got, 'форма из таблицы, а не склеенная из основы').toBe('Падающее! копьё');
    expect(ruAgree('падающий', 'n'), 'арифметика у нас как раз верная…').toBe('падающее');
    expect(oracleDecline('падающий', 'n'), '…а вторая копия, которую мы снесли, врала').toBe('падающое');
  });

  it('⭐ согласование объявляет ПЕРЕВОД: у «меча» мужской род, у `espada` женский', () => {
    const t = localesSchema.parse({
      ru: { name: 'Русский', enabled: true, templates: DEFAULT_NAME_TEMPLATES },
      es: {
        name: 'Español', enabled: true,
        templates: { 'item.tiered': '{base} {tier}' },
        strings: {
          'cfg:items-base/sword/name': { one: 'espada', agreement: 'f' },
          'cfg:item-tiers/t3/name': { m: 'sangriento', f: 'sangrienta' },
        },
      },
    }) as Locales;
    const got = composeItemName(new Localizer(t, 'es'), {
      shape: 'tiered', base: swordHead, agreement: 'm',
      tier: frag('cfg:item-tiers/t3/name', 'Кровавый'),
    });
    expect(got, 'род взят из записи перевода, а не из поля вещи').toBe('Espada sangrienta');
  });
});

describe('шаблон имени: разбор и подстановка', () => {
  it('⭐ регистр правится у ТОКЕНА, а не поиском подстроки', () => {
    // В русском PoE заглавные ставили подстановочной заменой, и вышло «поЛукафтан».
    expect(fillNameTemplate('{a} {b}', { a: 'лукафтан', b: 'полукафтан' })).toBe('Лукафтан полукафтан');
    expect(fillNameTemplate('{a:lower} {b}', { a: 'Меч', b: 'огня' })).toBe('Меч огня');
    expect(fillNameTemplate('{b} {a:lower}', { a: 'Меч', b: 'большой' })).toBe('Большой меч');
  });

  it('литерал в начале и в конце держится за соседний слот', () => {
    expect(fillNameTemplate('«{a}»', { a: 'Меч' })).toBe('«Меч»');
    expect(fillNameTemplate('«{a}»', {})).toBe('');
  });

  it('⚠ шаблон без слотов отдаётся как есть — это не повод рисовать пустоту', () => {
    expect(fillNameTemplate('Меч', {})).toBe('Меч');
  });

  it('все четыре формы имени объявлены и у русского есть шаблон на каждую', () => {
    for (const id of Object.values(NAME_TEMPLATES)) {
      expect(DEFAULT_NAME_TEMPLATES[id], id).toBeTruthy();
      expect(ru.template(id), id).toBeTruthy();
    }
  });
});

/**
 * ⚠ ФАЗЗЕР СОГЛАСОВАНИЯ. Сочетаний имени у нас ~430 тысяч, выписать нельзя; инварианты — можно.
 * Ловит ровно то, на чём ломались другие: двойной пробел (Last Epoch в китайском), висящая связка,
 * пустое имя и потерянная заглавная.
 */
describe('фаззер: база × ступень × аффикс × локаль', () => {
  it('⭐⭐ инварианты держатся на всех языках', () => {
    const langs: Array<[string, Localizer]> = [['ru', ru], ['en', en], ['es', es], ['zh', zh]];
    const pre = affixes.filter((a) => a.kind === 'prefix' && a.word);
    const suf = affixes.filter((a) => a.kind === 'suffix' && a.word);
    let checked = 0;
    for (const [lang, loc] of langs) {
      const sep = loc.grammar().join;
      for (let i = 0; i < bases.length; i++) {
        const b = bases[i]!;
        const specs = [
          { shape: 'tiered' as const, tier: frag(`cfg:item-tiers/${tiers[i % tiers.length]!.id}/name`, tiers[i % tiers.length]!.name ?? '') },
          { shape: 'magic' as const, prefix: frag('p', pre[i % pre.length]!.word!), suffix: frag('s', suf[i % suf.length]!.word!) },
          { shape: 'magic' as const, prefix: frag('p', pre[i % pre.length]!.word!) },
          { shape: 'rare' as const, noun: frag('n', rare.nouns[i % rare.nouns.length]!.t), epithet: frag('e', rare.epithets[i % rare.epithets.length]!.t) },
          { shape: 'rare' as const, noun: frag('n', rare.nouns[i % rare.nouns.length]!.t) },
          { shape: 'titled' as const },
        ];
        for (const extra of specs) {
          const got = composeItemName(loc, { base: head(b), agreement: b.gender, ...extra });
          const why = `${lang} · ${extra.shape} · ${b.name} → «${got}»`;
          expect(got, `${why}: имя не бывает пустым`).not.toBe('');
          expect(got, `${why}: двойного разделителя быть не может`).not.toContain('  ');
          expect(got.trim(), `${why}: без обрамляющих пробелов`).toBe(got);
          if (sep) expect(got.endsWith(sep) || got.startsWith(sep), `${why}: разделитель на краю`).toBe(false);
          // висящая связка: шаблон английского/испанского кончается связкой только при пустом слоте
          expect(/\b(of|de)$/.test(got), `${why}: висящая связка`).toBe(false);
          checked++;
        }
      }
    }
    expect(checked, 'проверено сочетаний').toBeGreaterThan(1500);
  });
});
