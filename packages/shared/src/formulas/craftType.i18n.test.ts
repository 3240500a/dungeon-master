import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { localizerFor, cfgRowTextWith, cfgRowKey, type Localizer } from '../i18n/index.js';
import { CRAFT_SLOT_LIST, familiesOf, partFits, resolveType, typeDisplay, typesRow, type PartSet, type TypeInfo } from './craftType.js';

/**
 * ⭐ i18n Ф3 (07.11): СБОРКА ИМЕНИ ТИПА НА ЯЗЫКЕ ИГРОКА — три ошибки кода, пойманные английским переводом:
 * 1. `{base}` строчной — правило русского, а не сборки («Bearded War Axe», не «Bearded war Axe»);
 * 2. заглавная — только у буквы в начале (после кавычек и скобок), а не у первой латинской/кириллической где угодно («16Th c.»);
 * 3. кириллический `code` значения анатомии на ином языке — переведённым именем значения («Codex: blade Падающий»).
 * Русский вывод прежний (оракул имени — `itemDisplay.test.ts`, эталон окон — `unityViews.gen.test.ts`).
 */
const CYR = /\p{Script=Cyrillic}/u;
const reg = new ConfigRegistry();
reg.loadAll();
const EN = localizerFor(reg.get('locales'), 'en')!;

/** Все сочетания деталей всех семейств всех классов → тип (собрался) и его вид на языке `L`. */
function walk(r: ConfigRegistry, L: Localizer | null, each: (cls: string, hands: number, parts: PartSet, t: TypeInfo, shown: Pick<TypeInfo, 'name' | 'subtitle' | 'formula'>) => void): number {
  let n = 0;
  for (const anat of r.get('weapon-anatomy')) {
    for (const hands of familiesOf(r, anat.id)) {
      const pools = CRAFT_SLOT_LIST.map((slot) => r.get('weapon-parts').filter((p) => partFits(p, anat.id, slot, hands)));
      if (pools.some((p) => !p.length)) continue;
      const idx = [0, 0, 0, 0];
      for (;;) {
        const parts = Object.fromEntries(CRAFT_SLOT_LIST.map((s, i) => [s, pools[i]![idx[i]!]!])) as PartSet;
        const t = resolveType(r, anat.id, hands, parts);
        if (t.ok) { n++; each(anat.id, hands, parts, t, typeDisplay(r, anat.id, hands, parts, t, L)); }
        let k = 3;
        while (k >= 0) { idx[k]!++; if (idx[k]! < pools[k]!.length) break; idx[k] = 0; k--; }
        if (k < 0) break;
      }
    }
  }
  return n;
}

describe('⭐ i18n Ф3: имя, подзаголовок и формула типа на английском', () => {
  it('⭐ ни одной кириллической буквы в имени, подзаголовке и строке-формуле — у каждого сочетания деталей каждого класса', () => {
    const leaks: string[] = [];
    const n = walk(reg, EN, (cls, hands, _p, _t, d) => {
      const s = `${d.name} || ${d.subtitle} || ${d.formula}`;
      if (CYR.test(s)) leaks.push(`${cls}/${hands}: ${s}`);
    });
    expect(n, 'обошли все сочетания').toBeGreaterThan(10_000);
    expect(leaks.slice(0, 5)).toEqual([]);
  });

  it('⭐ русская формула прежняя: кириллический `code` печатается как был («клинок Падающий»), латинский — везде как есть', () => {
    let ruCyrCode = 0, enLatin = 0;
    walk(reg, EN, (_c, _h, _p, t, d) => {
      if (/клинок Падающий/.test(t.formula)) ruCyrCode++;
      if (/blade XI\b/.test(d.formula) && /клинок XI\b/.test(t.formula)) enLatin++;
    });
    expect(ruCyrCode).toBeGreaterThan(0);
    expect(enLatin).toBeGreaterThan(0);
  });

  it('⭐ `{base}` держит свой регистр на английском, строчной становится только на русском', () => {
    let en = 0, ru = 0;
    walk(reg, EN, (cls, _h, _p, t, d) => {
      const row = typesRow(reg, cls)!;
      if (!t.fallback || !row.fallback.template.includes('{base}')) return;
      const base = reg.get('items.base').find((b) => b.id === t.baseId)!;
      const enBase = cfgRowTextWith(EN, reg, 'items.base', base);
      const enTpl = cfgRowTextWith(EN, reg, 'weapon-types', row.fallback, 'template');
      // шаблон начинается с `{base}` — заглавную ставит сборка, сверять там нечего
      if (!enTpl.startsWith('{base}')) { expect(d.name, `${cls}: «${d.name}»`).toContain(enBase); en++; }
      if (!row.fallback.template.startsWith('{base}')) { expect(t.name, `${cls}: «${t.name}»`).toContain(base.name[0]!.toLowerCase() + base.name.slice(1)); ru++; }
    });
    expect(en, 'английские шаблоны с базой не в начале (топор)').toBeGreaterThan(0);
    expect(ru).toBeGreaterThan(0);
  });

  it('⭐ язык без строк (es / zh сегодня) — русский запас: формула побайтово русская, база внутри фразы строчной (ревью Ф3)', () => {
    // пакет без строк строим сами: тест не должен сломаться, когда у es появится перевод
    const loc = structuredClone(reg.get('locales')) as Record<string, { strings: Record<string, unknown> }>;
    loc.es!.strings = {};
    const ES = localizerFor(loc as never, 'es')!;
    const bad: string[] = [];
    const n = walk(reg, ES, (cls, _h, _p, t, d) => {
      if (d.formula !== t.formula) bad.push(`${cls}: формула «${d.formula}» ≠ «${t.formula}»`);
      const row = typesRow(reg, cls)!;
      if (!t.fallback || row.fallback.template.startsWith('{base}') || !row.fallback.template.includes('{base}')) return;
      const base = reg.get('items.base').find((b) => b.id === t.baseId)!;
      if (!d.name.includes(base.name[0]!.toLowerCase() + base.name.slice(1))) bad.push(`${cls}: «${d.name}» — база не строчной`);
    });
    expect(n).toBeGreaterThan(10_000);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('⭐ заглавная — только у буквы в начале: после кавычек и скобок — да, после цифры, тире, иероглифа — нет; à → À', () => {
    // подзаголовок первого сработавшего правила подменяется образцами — и на русском (исходник), и на английском (перевод)
    let probe: { cls: string; hands: number; parts: PartSet; rule: string } | undefined;
    walk(reg, null, (cls, hands, parts, t) => { if (!probe && !t.fallback && t.typeId) probe = { cls, hands, parts, rule: t.typeId }; });
    expect(probe).toBeDefined();
    const cases: Array<[string, string]> = [
      ['16th c. spanned', '16th c. spanned'],
      ['à moulinet / à tour', 'À moulinet / à tour'],
      ['«kidney dagger» — эвфемизм', '«Kidney dagger» — эвфемизм'],
      ['"belly bow": slider', '"Belly bow": slider'],
      ['(pedum) crook', '(Pedum) crook'],
      ['諸葛弩: короб на 10 стрел', '諸葛弩: короб на 10 стрел'],
      ['— тире впереди', '— тире впереди'],
      ['ёлочный узор', 'Ёлочный узор'],
    ];
    for (const [src, want] of cases) {
      const r = new ConfigRegistry();
      r.loadAll();
      const types = structuredClone(r.get('weapon-types'));
      const rule = types.find((x) => x.id === probe!.cls)!.names.find((x) => x.id === probe!.rule)!;
      rule.subtitle = src;
      const loc = structuredClone(r.get('locales')) as Record<string, { strings: Record<string, unknown> }>;
      r.reload({ 'weapon-types': types });
      const key = cfgRowKey(r, 'weapon-types', r.get('weapon-types').find((x) => x.id === probe!.cls)!.names.find((x) => x.id === probe!.rule)!, 'subtitle')!;
      loc.en!.strings[key] = src;
      r.reload({ locales: loc });
      const t = resolveType(r, probe!.cls, probe!.hands, probe!.parts);
      expect(t.subtitle, `ru «${src}»`).toBe(want);
      expect(typeDisplay(r, probe!.cls, probe!.hands, probe!.parts, t, localizerFor(r.get('locales'), 'en')).subtitle, `en «${src}»`).toBe(want);
    }
  });
});
