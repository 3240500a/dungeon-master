/**
 * ⭐ i18n Ф3 (07.11): ВЫГРУЗКА ПАРТИЙ ПЕРЕВОДА. Запуск из корня проекта:
 *     npm run i18n:todo -- en <папка>            — непереведённое: по файлу на таблицу конфига / область фраз
 *     npm run i18n:todo -- en <папка> --all      — всё, и переведённое тоже (для сверки и правки уже залитого)
 *     npm run i18n:todo -- en <папка> --only cfg:skill-tree,srv:craft
 *
 * Файл партии — TSV с шапкой `key  ru  <язык>  where  ctx`: переводчик заполняет колонку языка и отдаёт файл `npm run i18n:merge`.
 * Табуляция и перевод строки внутри ячейки — `\t` и `\n`; формы по числу — JSON-объектом (`{"one":"…","other":"…"}`).
 * ⚠ Выгрузка ничего не пишет в данные: истина — `locales.json`, партии — расходный материал.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_LANG } from '@dm/shared';
import { cell, collectCorpus, loadLocales, type CorpusEntry } from './corpus.js';

const [lang, outDir, ...rest] = process.argv.slice(2);
if (!lang || lang === SOURCE_LANG || !outDir) {
  console.error('Запуск: npm run i18n:todo -- <язык, не ru> <папка> [--all] [--only cfg:<таблица>,srv:<область>,ui:<область>]');
  process.exit(1);
}
const all = rest.includes('--all');
const onlyAt = rest.indexOf('--only');
const only = onlyAt >= 0 ? new Set((rest[onlyAt + 1] ?? '').split(',').filter(Boolean)) : null;

const locales = loadLocales();
const pack = locales[lang];
if (!pack) {
  console.error(`Языка "${lang}" нет в locales.json — сперва добавь его пакет (name/enabled/grammar).`);
  process.exit(1);
}
const { entries, notes } = collectCorpus(process.cwd());
for (const n of notes) console.log(`⚠ ${n}`);

const groups = new Map<string, CorpusEntry[]>();
for (const e of entries) {
  const id = `${e.kind}:${e.group}`;
  if (only && !only.has(id)) continue;
  const have = pack.strings[e.key];
  const done = typeof have === 'string' ? have.trim() !== '' : have !== undefined && Object.values(have).some((v) => v.trim() !== '');
  if (done && !all) continue;
  const list = groups.get(id) ?? [];
  list.push(e);
  groups.set(id, list);
}

mkdirSync(outDir, { recursive: true });
let rows = 0, chars = 0;
for (const [id, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  const lines = [`key\t${SOURCE_LANG}\t${lang}\twhere\tctx`];
  for (const e of list) {
    lines.push([e.key, cell(e.source), cell(pack.strings[e.key]), e.where, cell(e.ctx)].join('\t'));
    chars += typeof e.source === 'string' ? e.source.length : Object.values(e.source).join('').length;
  }
  rows += list.length;
  const file = join(outDir, `${id.replace(':', '_')}.tsv`);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  console.log(`  ${id.padEnd(28)} ${String(list.length).padStart(5)} строк → ${file}`);
}
console.log(`${lang}: выгружено ${rows} строк (${chars.toLocaleString('ru-RU')} симв. исходника) в ${groups.size} файлов${all ? ' (вместе с переведённым)' : ''}`);
