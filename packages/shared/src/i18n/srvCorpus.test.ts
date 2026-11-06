import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSrvFromRepo, extractSrvPhrases, srvCorpusFileText, srvCorpusOf } from './srvExtract.js';
import { SRV_CORPUS, srvCorpusRows } from './srvCorpus.js';
import { localesSchema, placeholders } from './index.js';
import { defaultConfigData } from '../config/defaults.js';

/**
 * ⭐⭐ i18n Ф2 (06.11): СТОРОЖ КОРПУСА ФРАЗ КОДА. Файл `corpus.srv.json` — то, что видит переводчик; код — то, что видит игрок. Разойдись
 * они, и новая фраза уйдёт игроку непереведённой, а переводчик о ней не узнает никогда. Падает, когда:
 *  • ключ `tr()`/`trn()` есть в коде, а в файле его нет (или исходник другой) — «перезапусти `npm run i18n`»;
 *  • у одного ключа два разных исходника (два разных текста под одним переводом — один из них покажут не там);
 *  • ключ или исходник не литерал (извлекатель его не найдёт — значит, и переводчик);
 *  • перевод висит на ключе, которого в коде больше нет, или потерял `{слот}` источника.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('⭐⭐ i18n Ф2: корпус фраз кода (`srv:`)', () => {
  const ex = extractSrvFromRepo(REPO);

  it('⭐ каждый вызов шва — по правилу: ключ и исходник литералы, ключ `srv:<область>.<camelCase>`, один ключ — один исходник', () => {
    expect(ex.problems).toEqual([]);
    expect(ex.phrases.length, 'фраз набрано (Ф1 — ~1 080 вызовов)').toBeGreaterThan(900);
  });

  it('⭐⭐ ФАЙЛ КОРПУСА СВЕЖИЙ: ровно ключи кода с их исходниками (иначе — `npm run i18n`)', () => {
    const want = srvCorpusOf(ex.phrases);
    const have = SRV_CORPUS;
    const missing = Object.keys(want).filter((k) => !(k in have));
    const stale = Object.keys(have).filter((k) => !(k in want));
    const changed = Object.keys(want).filter((k) => k in have && JSON.stringify(want[k]) !== JSON.stringify(have[k]));
    expect({ missing, stale, changed }, 'corpus.srv.json устарел: npm run i18n').toEqual({ missing: [], stale: [], changed: [] });
    const file = readFileSync(join(REPO, 'packages/shared/src/i18n/corpus.srv.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(file, 'формат файла — тот, что пишет извлекатель').toBe(srvCorpusFileText(want));
  });

  it('⚠ извлекатель ловит нарушения шва, а не угадывает', () => {
    const r = extractSrvPhrases([{
      path: 'x.ts', text: [
        "const A = 'Раз';",
        "tr('srv:x.one', 'Раз');",
        "tr('srv:x.one', 'Два');",              // два исходника у ключа
        "tr(key, 'Три');",                       // ключ — не литерал
        "tr('srv:x.bad_key', 'Четыре');",        // не camelCase
        "tr('srv:x.dyn', `пять ${n}`);",          // исходник — шаблон с подстановкой
        "tr('srv:x.c', A);",                     // константа — можно
        "trn('srv:x.n', n, { one: '{n} раз', other: '{n} раза' });",
        "trn('srv:x.m', n, forms);",             // формы — не литерал
        '// tr(\'srv:x.comment\', \'в комментарии\') — не ключ',
      ].join('\n'),
    }]);
    expect(r.phrases.map((p) => p.key)).toEqual(['srv:x.one', 'srv:x.one', 'srv:x.c', 'srv:x.n']);
    expect(r.phrases.find((p) => p.key === 'srv:x.c')!.source).toBe('Раз');
    expect(r.problems.length).toBe(5);
  });

  it('⭐ переводы `srv:` не сироты и держат те же `{слоты}`, что исходник', () => {
    const table = localesSchema.parse(defaultConfigData.locales);
    for (const [lang, pack] of Object.entries(table)) {
      for (const [k, v] of Object.entries(pack.strings)) {
        if (!k.startsWith('srv:')) continue;
        expect(k in SRV_CORPUS, `${lang}: перевод висит на ключе, которого в коде нет: ${k}`).toBe(true);
        const filled = typeof v === 'string' ? (v ? [v] : []) : Object.values(v).filter(Boolean);
        const src = SRV_CORPUS[k]!;
        const want = new Set((typeof src === 'string' ? [src] : Object.values(src)).flatMap(placeholders));
        for (const f of filled) {
          const got = new Set(placeholders(f));
          // у фразы по числу `{n}` подставляется само — переводу его можно и опустить («once»), остальные слоты — те же
          for (const p of got) expect(want.has(p) || p === 'n', `${lang} ${k}: чужой слот {${p}}`).toBe(true);
          for (const p of want) if (p !== 'n') expect(got.has(p), `${lang} ${k}: потерян слот {${p}}`).toBe(true);
        }
      }
    }
  });

  it('строки корпуса кода — в форме строк конфига (вкладка «Языки» и покрытие идут одним кодом)', () => {
    const rows = srvCorpusRows();
    expect(rows.length).toBe(Object.keys(SRV_CORPUS).length);
    const plural = rows.find((r) => r.key === 'srv:salvage.timesN');
    expect(plural?.field).toBe('forms');
    expect(plural?.forms?.few).toBe('в {n} раза больше');
    expect(rows.find((r) => r.key === 'srv:room.tooOften')).toMatchObject({ table: 'srv:room', field: 'text', source: 'Слишком часто' });
  });
});
