/**
 * ⭐ i18n Ф3 (07.11): ВЕСЬ ПЕРЕВОДИМЫЙ ТЕКСТ ОДНИМ СПИСКОМ — для выгрузки партий (`todo.ts`) и их заливки (`merge.ts`).
 *
 * Три корпуса, те же, что считает отчёт `npm run i18n` (`extract.ts`): текст конфига (`cfg:`), фразы кода сервера (`srv:`) и фразы
 * клиента Unity (`ui:`). У каждой строки — где она живёт (`where`: таблица.поле или файл:строка) и подсказка смысла (`ctx`: имя строки
 * таблицы, к которой относится описание), чтобы переводчик видел не голую фразу, а её место.
 *
 * ⚠ Ключи и исходники берутся ТЕМИ ЖЕ функциями, что у рантайма и сторожей (`walkConfigText`, `extractSrvFromRepo`, `extractUiFromRepo`), —
 * своей логики обхода здесь нет: иначе партия ушла бы под ключами, которых игра не спросит.
 */
import { readFileSync } from 'node:fs';
import { defaultConfigData, localesSchema, walkConfigText, type FormSet, type Locales } from '@dm/shared';
import { extractSrvFromRepo } from '../../packages/shared/src/i18n/srvExtract.js';
import { extractUiFromRepo, unityRepoRoot } from '../../packages/shared/src/i18n/uiExtract.js';

export const LOCALES_FILE = 'packages/shared/src/config/data/locales.json';
const UI_FILE = 'packages/shared/src/i18n/corpus.ui.json';

/** Одна переводимая строка. `group` — таблица конфига (`cfg`) или область фразы (`srv`/`ui`: первый сегмент после двоеточия). */
export interface CorpusEntry {
  key: string;
  kind: 'cfg' | 'srv' | 'ui';
  group: string;
  source: FormSet;
  where: string;
  ctx: string;
}

/** Таблица переводов как есть в файле (строгий разбор: битый файл — отказ, а не тихая потеря языка). */
export function loadLocales(): Locales {
  const parsed = localesSchema.safeParse(JSON.parse(readFileSync(LOCALES_FILE, 'utf8')));
  if (!parsed.success) throw new Error(`${LOCALES_FILE} не прошёл схему:\n${parsed.error.toString()}`);
  return parsed.data;
}

/** Текст файла переводов — тем же форматом, что пишет `npm run i18n:stub` (два пробела, перевод строки в конце). */
export function localesFileText(locales: Locales): string {
  return `${JSON.stringify(locales, null, 2)}\n`;
}

export function collectCorpus(repoRoot: string): { entries: CorpusEntry[]; notes: string[] } {
  const notes: string[] = [];
  const entries: CorpusEntry[] = [];

  // ── конфиг: подсказка — имя строки (поле `name`/`title` того же пути), если переводится не оно само ──
  const cfg = walkConfigText(defaultConfigData);
  const rowName = new Map<string, string>();
  for (const c of cfg) {
    const row = c.key.slice(0, c.key.lastIndexOf('/'));
    if ((c.field === 'name' || c.field === 'title') && !rowName.has(row)) rowName.set(row, c.source);
  }
  for (const c of cfg) {
    const row = c.key.slice(0, c.key.lastIndexOf('/'));
    const name = rowName.get(row);
    entries.push({ key: c.key, kind: 'cfg', group: c.table, source: c.source, where: `${c.table}.${c.field}`, ctx: name && name !== c.source ? name : '' });
  }

  // ── фразы сервера: по дереву исходников, место — первый вызов ──
  const srv = extractSrvFromRepo(repoRoot);
  if (srv.problems.length) throw new Error(`фразы кода нарушают правило шва:\n  ${srv.problems.join('\n  ')}`);
  const seen = new Set<string>();
  for (const p of [...srv.phrases].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    entries.push({ key: p.key, kind: 'srv', group: p.key.slice(4).split('.')[0]!, source: p.source, where: `${p.file}:${p.line}`, ctx: '' });
  }

  // ── фразы клиента Unity: по коду Unity-репо, если он рядом; иначе снимок корпуса без мест ──
  const unityRoot = unityRepoRoot(repoRoot);
  if (unityRoot) {
    const ui = extractUiFromRepo(unityRoot);
    if (ui.problems.length) throw new Error(`фразы клиента Unity нарушают правило шва:\n  ${ui.problems.join('\n  ')}`);
    for (const p of [...ui.phrases].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      entries.push({ key: p.key, kind: 'ui', group: p.key.slice(3).split('.')[0]!, source: p.source, where: `${p.file}:${p.line}`, ctx: '' });
    }
  } else {
    notes.push(`Unity-репо не найден — фразы ui: из снимка ${UI_FILE} (без мест)`);
    const snap = (JSON.parse(readFileSync(UI_FILE, 'utf8')) as { strings: Record<string, FormSet> }).strings;
    for (const [key, source] of Object.entries(snap)) entries.push({ key, kind: 'ui', group: key.slice(3).split('.')[0]!, source, where: '', ctx: '' });
  }
  return { entries, notes };
}

// ── TSV: табуляция и перевод строки внутри ячейки экранируются, формы по числу — JSON-объектом ──
export function cell(v: FormSet | string | undefined): string {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function uncell(s: string): string {
  return s.replace(/\\(\\|t|r|n)/g, (_, c: string) => (c === 't' ? '\t' : c === 'r' ? '\r' : c === 'n' ? '\n' : '\\'));
}
