/**
 * ⭐ i18n Ф3 (07.11): ЗАЛИВКА ПАРТИЙ ПЕРЕВОДА В `locales.json`. Запуск из корня проекта:
 *     npm run i18n:merge -- en <файл.tsv|папка> [ещё…]           — проверить и НАЛОЖИТЬ на пакет языка
 *     npm run i18n:merge -- en <файлы…> --check                  — только проверить, ничего не писать
 *     npm run i18n:merge -- en <файлы…> --skip-bad               — наложить годные строки, негодные перечислить
 *
 * НАКЛАДЫВАЕТ, а не заменяет: строки, которых нет в партиях, остаются как были (потеря партии не стирает перевод). Пустая ячейка языка —
 * «не тронуто», а не «стереть».
 *
 * Сторожа строки (ошибка — партия не ложится, пока не исправят или не дан `--skip-bad`):
 *  • ключ есть в корпусе (`cfg:` конфига, `srv:` сервера, `ui:` клиента Unity) — иначе перевод осиротеет;
 *  • ни одной кириллической буквы; формы по числу — JSON-объектом с `other`;
 *  • тот же набор подстановок `{…}`, что у исходника, и тот же ведущий знак (`⚠ ✦ 🔒 ▮` — по ним красит клиент);
 *  • ⭐ ГЛОССАРИЙ ВЛАДЕЛЬЦА (`tools/i18n/en/glossary.json`): имя строки, которое в нём есть, переводится РОВНО его словом;
 *  • ⭐ политики глоссария: британская орфография (Armour, Colour, Defence, Grey…), «здоровье» — Health, а не Life.
 * Предупреждения (печатаются, не держат): `-ize`/`-yze`, «гнев» → Wrath (Wrath занят «Карой небес»), другой ведущий значок.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leadingMarker, placeholders, SOURCE_LANG, type FormSet } from '@dm/shared';
import { collectCorpus, LOCALES_FILE, loadLocales, localesFileText, uncell, type CorpusEntry } from './corpus.js';

const args = process.argv.slice(2);
const lang = args[0];
const flags = new Set(args.filter((a) => a.startsWith('--')));
const inputs = args.slice(1).filter((a) => !a.startsWith('--'));
if (!lang || lang === SOURCE_LANG || !inputs.length) {
  console.error('Запуск: npm run i18n:merge -- <язык, не ru> <файл.tsv|папка> [ещё…] [--check] [--skip-bad]');
  process.exit(1);
}

const files: string[] = [];
for (const p of inputs) {
  if (!existsSync(p)) { console.error(`нет такого пути: ${p}`); process.exit(1); }
  if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) { if (f.endsWith('.tsv')) files.push(join(p, f)); }
  else files.push(p);
}

const locales = loadLocales();
const pack = locales[lang];
if (!pack) { console.error(`Языка "${lang}" нет в ${LOCALES_FILE}.`); process.exit(1); }
const { entries } = collectCorpus(process.cwd());
const byKey = new Map(entries.map((e) => [e.key, e] as const));

// ── глоссарий: группа записи → таблица конфига; строка совпала, если в её пути есть id записи, поле — имя, а исходник — слово записи ──
const GLOSSARY_FILE = `tools/i18n/${lang}/glossary.json`;
const GROUP_TABLE: Readonly<Record<string, string>> = {
  branch: 'skill-tree', skill: 'skill-tree', mastery: 'mastery-tree', weaponType: 'weapon-types', anatomy: 'weapon-anatomy',
};
const NAME_FIELDS = new Set(['name', 'title', 'label', 'short', 'name2h']);
const expected = new Map<string, string>();
if (existsSync(GLOSSARY_FILE)) {
  const g = JSON.parse(readFileSync(GLOSSARY_FILE, 'utf8')) as { entries: Array<{ group: string; ids?: string[]; ru: string; en: string }> };
  const index = new Map<string, Array<{ ids: Set<string>; en: string }>>();
  for (const e of g.entries) {
    const table = GROUP_TABLE[e.group];
    if (!table || !e.ids?.length) continue;
    const k = `${table}\u0000${e.ru.trim()}`;
    const list = index.get(k) ?? [];
    list.push({ ids: new Set(e.ids), en: e.en });
    index.set(k, list);
  }
  for (const c of entries) {
    if (c.kind !== 'cfg' || typeof c.source !== 'string') continue;
    const field = c.key.slice(c.key.lastIndexOf('/') + 1);
    if (!NAME_FIELDS.has(field)) continue;
    const list = index.get(`${c.group}\u0000${c.source.trim()}`);
    if (!list) continue;
    const segs = c.key.slice(4).split('/');
    const hit = list.find((x) => segs.some((s) => x.ids.has(s)));
    if (hit) expected.set(c.key, hit.en);
  }
}

console.log(`глоссарий ${GLOSSARY_FILE}: под надзором ${expected.size} имён строк`);

// ── орфография и политики ──
const CYR = /[А-Яа-яЁё]/;
const US_SPELLING: ReadonlyArray<[RegExp, string]> = [
  [/\barmor/i, 'Armour'], [/\bcolor/i, 'Colour'], [/\bhonor/i, 'Honour'], [/\bvigor\b/i, 'Vigour'], [/\bvalor\b/i, 'Valour'],
  [/\bfavor/i, 'Favour'], [/\bbehavior/i, 'Behaviour'], [/\brumor/i, 'Rumour'], [/\bsplendor/i, 'Splendour'], [/\bclamor/i, 'Clamour'],
  [/\bdefense/i, 'Defence'], [/\boffense/i, 'Offence'], [/\bgray/i, 'Grey'], [/\bcenter/i, 'Centre'], [/\btheater/i, 'Theatre'],
  [/\bfiber/i, 'Fibre'], [/\bsaber/i, 'Sabre'], [/\bscepter/i, 'Sceptre'], [/\bmold(s|ed|ing)?\b/i, 'Mould'], [/\bjewelry/i, 'Jewellery'],
  [/\bplow/i, 'Plough'], [/\bsulfur/i, 'Sulphur'], [/\bskeptic/i, 'Sceptic'], [/\bmaneuver/i, 'Manoeuvre'], [/\bluster\b/i, 'Lustre'],
  [/\bmeager/i, 'Meagre'], [/\bsomber/i, 'Sombre'], [/\bspecter/i, 'Spectre'], [/\btraveled|\btraveling/i, 'Travelled'],
  [/\bcanceled|\bcanceling/i, 'Cancelled'], [/\bmodeled|\bmodeling/i, 'Modelled'], [/\bfueled|\bfueling/i, 'Fuelled'],
];
const IZE = /\b\w{3,}(iz|yz)(e|es|ed|ing|ation|ations)\b/i;
const IZE_OK = /\b(size|sizes|sized|seize|seizes|seized|seizing|prize|prizes|capsize|baize|maize)\b/i;

/** Ведущий значок строки (не буква и не цифра): «⚔ », «★ » — другой у перевода, вероятно, недосмотр. */
const leadGlyph = (s: string): string => /^[^\p{L}\p{N}\s"«({[]+/u.exec(s)?.[0] ?? '';
const uniq = (xs: string[]): string => [...new Set(xs)].sort().join(',');

interface Row { file: string; line: number; key: string; value: FormSet }
const errors: string[] = [];
const warnings: string[] = [];
const rows: Row[] = [];
const badKeys = new Set<string>();

for (const file of files) {
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const head = (lines[0] ?? '').split('\t');
  const kCol = head.indexOf('key');
  const vCol = head.indexOf(lang);
  if (kCol < 0 || vCol < 0) { errors.push(`${file}: в шапке нет колонок «key» и «${lang}»`); continue; }
  lines.slice(1).forEach((raw, i) => {
    if (!raw.trim() || raw.startsWith('#')) return;
    const cols = raw.split('\t');
    const key = (cols[kCol] ?? '').trim();
    // ⚠ НЕ обрезать: краевой пробел и ведущий перевод строки — часть фразы (« за {price} золота» клеится к числу); сверка — ниже
    const v = uncell(cols[vCol] ?? '');
    if (!v.trim()) return;
    const at = `${file}:${i + 2} ${key}`;
    const bad = (msg: string): void => { errors.push(`${at}: ${msg}`); badKeys.add(key); };
    const e: CorpusEntry | undefined = byKey.get(key);
    if (!e) { bad('ключа нет в корпусе (осиротеет)'); return; }
    let value: FormSet;
    if (typeof e.source === 'string') {
      value = v;
    } else {
      try { value = JSON.parse(v) as FormSet; } catch { bad('формы по числу — не JSON'); return; }
      if (typeof value !== 'object' || value === null || typeof (value as Record<string, unknown>).other !== 'string'
        || Object.values(value).some((x) => typeof x !== 'string')) { bad('формы по числу — объект строк с «other»'); return; }
    }
    const src = e.source;
    const srcMain = typeof src === 'string' ? src : (src.other ?? Object.values(src)[0] ?? '');
    const forms = typeof value === 'string' ? [value] : Object.values(value);
    const edge = (s: string): string => `${/^\s*/.exec(s)![0]}|${/\s*$/.exec(s)![0]}`;
    for (const f of forms) {
      // орфография и политики — по ТЕКСТУ: без подстановок (`{armor}` — имя слота кода) и без разметки TMP (`<color=#…>` — тег, не слово)
      const prose = f.replace(/\{[a-zA-Z0-9_.-]+\}/g, ' ').replace(/<\/?[a-zA-Z][^<>]*>/g, ' ');
      if (CYR.test(f)) bad(`кириллица в переводе: «${f}»`);
      if (edge(f) !== edge(srcMain)) bad(`краевые пробелы ${JSON.stringify(edge(f))} ≠ исходника ${JSON.stringify(edge(srcMain))}`);
      if (uniq(placeholders(f)) !== uniq(placeholders(srcMain))) bad(`подстановки {${uniq(placeholders(f))}} ≠ исходника {${uniq(placeholders(srcMain))}}`);
      if ((leadingMarker(srcMain) ?? '') !== (leadingMarker(f) ?? '')) bad(`ведущий знак «${leadingMarker(f) ?? ''}» ≠ исходника «${leadingMarker(srcMain) ?? ''}»`);
      else if (leadGlyph(srcMain).trim() !== leadGlyph(f).trim()) warnings.push(`${at}: ведущий значок «${leadGlyph(f)}» ≠ исходника «${leadGlyph(srcMain)}»`);
      for (const [re, uk] of US_SPELLING) if (re.test(prose)) bad(`американская орфография (${re.source}) — британская: ${uk}`);
      if (IZE.test(prose) && !IZE_OK.test(prose)) warnings.push(`${at}: -ize/-yze — по британской норме -ise/-yse? «${f}»`);
      if (/здоров/i.test(srcMain) && /\blife\b/i.test(prose)) bad('«здоровье» — Health, не Life (политика глоссария)');
      if (/гнев/i.test(srcMain) && /\bwrath\b/i.test(prose)) warnings.push(`${at}: «гнев» → Fury: Wrath занят «Карой небес»`);
    }
    const want = expected.get(key);
    if (want !== undefined && typeof value === 'string' && value !== want) bad(`глоссарий: «${srcMain}» → «${want}», а здесь «${value}»`);
    rows.push({ file, line: i + 2, key, value });
  });
}

// ── одна строка — один перевод: два разных значения ключа в партиях — ошибка (какое из них верное, решает человек) ──
const firstOf = new Map<string, Row>();
for (const r of rows) {
  const was = firstOf.get(r.key);
  if (was && JSON.stringify(was.value) !== JSON.stringify(r.value)) {
    errors.push(`${r.file}:${r.line} ${r.key}: второй перевод «${JSON.stringify(r.value)}» ≠ «${JSON.stringify(was.value)}» (${was.file}:${was.line})`);
    badKeys.add(r.key);
  } else if (!was) firstOf.set(r.key, r);
}

for (const w of warnings) console.log(`  ~ ${w}`);
for (const e of errors) console.log(`  ✗ ${e}`);
const good = [...firstOf.values()].filter((r) => !badKeys.has(r.key));
let changed = 0;
for (const r of good) if (JSON.stringify(pack.strings[r.key]) !== JSON.stringify(r.value)) changed++;
console.log(`${lang}: строк в партиях ${rows.length}, годных ${good.length}, ошибок ${errors.length}, предупреждений ${warnings.length}; меняет ${changed}`);

const write = !flags.has('--check') && (errors.length === 0 || flags.has('--skip-bad'));
if (write) {
  for (const r of good) pack.strings[r.key] = r.value;
  pack.strings = Object.fromEntries(Object.entries(pack.strings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(LOCALES_FILE, localesFileText(locales), 'utf8');
  console.log(`записано в ${LOCALES_FILE}`);
} else if (!flags.has('--check')) {
  console.log('НЕ записано: есть ошибки (исправь партию или запусти с --skip-bad)');
}

// ── остаток по корпусам ──
const left = new Map<string, number>();
let leftAll = 0;
for (const e of entries) {
  const have = pack.strings[e.key];
  const done = typeof have === 'string' ? have.trim() !== '' : have !== undefined && Object.values(have).some((v) => v.trim() !== '');
  if (done) continue;
  leftAll++;
  const id = `${e.kind}:${e.group}`;
  left.set(id, (left.get(id) ?? 0) + 1);
}
const top = [...left].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, n]) => `${id} ${n}`).join(' · ');
console.log(`осталось без перевода: ${leftAll} из ${entries.length}${top ? ` — ${top}` : ''}`);
if (errors.length && !flags.has('--skip-bad')) process.exit(1);
