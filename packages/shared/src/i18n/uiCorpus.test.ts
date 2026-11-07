import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractUiFromRepo, extractUiPhrases, uiCorpusFileText, uiCorpusOf, unityRepoRoot, unityUiGoldenText, UI_KEY } from './uiExtract.js';
import { UI_CORPUS, uiCorpusRows } from './uiCorpus.js';
import { CYRILLIC, leadingMarker, localesSchema, placeholders, pseudoLocales, SOURCE_LANG } from './index.js';
import { defaultConfigData } from '../config/defaults.js';

/**
 * ⭐⭐ i18n (07.11, «литералы обвязки»): СТОРОЖ КОРПУСА ФРАЗ КЛИЕНТА UNITY (`ui:`). Файл `corpus.ui.json` — то, что видит переводчик; код Unity —
 * то, что видит игрок. Падает, когда:
 *  • вызов шва `DmText.T`/`Tn`/`With`/`WithN` есть в рантайме Unity, а в снимке его нет (или исходник другой) — «перезапусти `npm run i18n`»
 *    (⏸ только когда Unity-репо рядом: `DM_UNITY_REPO` или соседняя `../ashes of the past/Ashes of the past`; нет — пропуск с причиной);
 *  • у ключа два исходника, ключ или исходник не литерал (извлекатель их не найдёт — значит, и переводчик);
 *  • эталон Unity (`__golden__/unity_ui.json`: корпус + псевдоязык) разошёлся со снимком — Unity сверяет по нему свой код;
 *  • перевод `ui:` висит на ключе, которого в корпусе нет, потерял `{слот}` или ведущий знак источника.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const UNITY = unityRepoRoot(REPO);

describe('⭐⭐ i18n (07.11): корпус фраз клиента Unity (`ui:`)', () => {
  it.skipIf(!UNITY)(`⭐⭐ СНИМОК СВЕЖИЙ: ровно вызовы шва рантайма Unity с их исходниками (иначе — npm run i18n)${UNITY ? '' : ' — ⏸ Unity-репо не найден: сверка с кодом пропущена'}`, () => {
    const ex = extractUiFromRepo(UNITY!);
    expect(ex.problems, 'вызовы шва по правилу DmText.cs').toEqual([]);
    expect(ex.phrases.length, 'вызовов шва в рантайме (07.11 — ~480)').toBeGreaterThan(300);
    const want = uiCorpusOf(ex.phrases);
    const missing = Object.keys(want).filter((k) => !(k in UI_CORPUS));
    const stale = Object.keys(UI_CORPUS).filter((k) => !(k in want));
    const changed = Object.keys(want).filter((k) => k in UI_CORPUS && JSON.stringify(want[k]) !== JSON.stringify(UI_CORPUS[k]));
    expect({ missing, stale, changed }, 'corpus.ui.json устарел: npm run i18n').toEqual({ missing: [], stale: [], changed: [] });
    const file = readFileSync(join(REPO, 'packages/shared/src/i18n/corpus.ui.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(file, 'формат файла — тот, что пишет извлекатель').toBe(uiCorpusFileText(want));
  });

  it('⭐ ЭТАЛОН UNITY СВЕЖИЙ: `unity_ui.json` = снимок корпуса + псевдоязык (его сверяют `ui_text.py` и `UiTextCheck`)', () => {
    const ru = localesSchema.parse(defaultConfigData.locales)[SOURCE_LANG];
    const file = readFileSync(join(REPO, 'packages/shared/src/i18n/__golden__/unity_ui.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(file, 'эталон устарел: npm run i18n (и golden_sync.py в Unity)').toBe(unityUiGoldenText({ ...UI_CORPUS }, ru));
  });

  it('⭐ каждый ключ корпуса — по форме `ui:<область>.<camelCase>`, исходник непустой, у фразы по числу есть `other`', () => {
    const keys = Object.keys(UI_CORPUS);
    expect(keys.length, 'фраз клиента (07.11 — ~440)').toBeGreaterThan(300);
    for (const k of keys) expect(UI_KEY.test(k), k).toBe(true);
    for (const [k, v] of Object.entries(UI_CORPUS)) {
      if (typeof v === 'string') expect(v.length, k).toBeGreaterThan(0);
      else expect(typeof v.other, `${k}: формы без other`).toBe('string');
    }
  });

  it('⚠ извлекатель ловит нарушения шва, а не угадывает', () => {
    const r = extractUiPhrases([{
      path: 'X.cs', text: [
        '/// DmText.T("ui:x.doc", "в комментарии") — не ключ',
        'var a = DmText.T("ui:x.one", "Раз");',
        'var b = DM.UI.DmText.T("ui:x.one", "Два");',                    // два исходника у ключа
        'var c = DmText.T(key, "Три");',                                  // ключ — не литерал
        'var d = DmText.T("ui:x.bad_key", "Четыре");',                    // не camelCase
        'var e = DmText.T("ui:x.dyn", $"пять {n}");',                     // исходник — интерполяция
        'var f = DmText.T("ui:x.cat", "шесть" + "семь");',                // исходник — склейка
        'var g = DmText.T("ui:x.esc", "строка\\nвторая \\"в кавычках\\"", "n", 5);',
        'var h = DmText.Tn("ui:x.n", n, new PluralForms(one: "{n} раз", few: "{n} раза", many: "{n} раз", other: "{n} раза"));',
        'var i = DmText.Tn("ui:x.m", n, forms);',                         // формы — не литералы
        'var j = DmText.Tn("ui:x.k", n, new PluralForms("{n}"));',        // формы — не именованные
        'var k = DmText.With(loc, "ui:x.w", "{name} {tier}");',
        'var l = $"<b>{DmText.T("ui:x.hole", "В дыре")}</b>";',           // вызов в дыре интерполяции — ключ
        "var m = 'ё'; var n2 = DmText.T(\"ui:x.after\", \"после символа\");",
        'var o = DmText.WithN(loc, "ui:x.wn", 3, new PluralForms(other: "{n} штук", one: "{n} штука"));',
      ].join('\n'),
    }]);
    expect(r.phrases.map((p) => p.key)).toEqual(['ui:x.one', 'ui:x.one', 'ui:x.esc', 'ui:x.n', 'ui:x.w', 'ui:x.hole', 'ui:x.after', 'ui:x.wn']);
    expect(r.phrases.find((p) => p.key === 'ui:x.esc')!.source).toBe('строка\nвторая "в кавычках"');
    expect(r.phrases.find((p) => p.key === 'ui:x.n')!.source).toEqual({ one: '{n} раз', few: '{n} раза', many: '{n} раз', other: '{n} раза' });
    expect(r.phrases.find((p) => p.key === 'ui:x.hole')!.source).toBe('В дыре');
    expect(r.problems.length, r.problems.join('\n')).toBe(7);
  });

  it('⭐ переводы `ui:` не сироты и держат те же `{слоты}` и ведущий знак, что исходник', () => {
    const table = localesSchema.parse(defaultConfigData.locales);
    const bad: string[] = [];
    for (const [lang, pack] of Object.entries(table)) {
      for (const [k, v] of Object.entries(pack.strings)) {
        if (!k.startsWith('ui:')) continue;
        const src = UI_CORPUS[k];
        if (src === undefined) { bad.push(`${lang}: перевод висит на ключе, которого в клиенте нет: ${k}`); continue; }
        const want = new Set((typeof src === 'string' ? [src] : Object.values(src)).flatMap(placeholders));
        const filled = typeof v === 'string' ? (v ? [v] : []) : Object.values(v).filter(Boolean);
        for (const f of filled) {
          const got = new Set(placeholders(f));
          for (const p of got) if (!want.has(p) && p !== 'n') bad.push(`${lang} ${k}: чужой слот {${p}}`);
          for (const p of want) if (p !== 'n' && !got.has(p)) bad.push(`${lang} ${k}: потерян слот {${p}}`);
          const m = leadingMarker(typeof src === 'string' ? src : src.other ?? '');
          if (m && !f.startsWith(m)) bad.push(`${lang} ${k}: «${f}» без «${m}»`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('⭐ ПСЕВДОЯЗЫК покрывает каждый ключ `ui:`: без кириллицы, с теми же `{слотами}` и ведущим знаком (сторож утечек Unity — `UiTextCheck`)', () => {
    const xx = pseudoLocales(undefined, defaultConfigData).xx!;
    const bad: string[] = [];
    for (const [k, src] of Object.entries(UI_CORPUS)) {
      const t = xx.strings[k];
      if (t === undefined) { bad.push(`${k}: нет в псевдоязыке`); continue; }
      const pairs: Array<[string, string]> = typeof src === 'string' ? [[src, t as string]] : Object.entries(src).map(([f, s]) => [s, (t as Record<string, string>)[f] ?? '']);
      for (const [s, p] of pairs) {
        if (CYRILLIC.test(p)) bad.push(`${k}: кириллица в «${p}»`);
        if (JSON.stringify(placeholders(s)) !== JSON.stringify(placeholders(p))) bad.push(`${k}: слоты «${s}» → «${p}»`);
        const m = leadingMarker(s);
        if (m && !p.startsWith(m)) bad.push(`${k}: «${p}» без «${m}»`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('строки корпуса клиента — в форме строк кода сервера (вкладка «Языки» и покрытие идут одним кодом)', () => {
    const rows = uiCorpusRows();
    expect(rows.length).toBe(Object.keys(UI_CORPUS).length);
    expect(rows.find((r) => r.key === 'ui:settings.language')).toMatchObject({ table: 'ui:settings', field: 'text', source: 'Язык:' });
    for (const r of rows) expect(r.table.startsWith('ui:') && !r.table.includes('.'), r.key).toBe(true);
  });
});
