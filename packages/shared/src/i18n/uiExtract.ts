/**
 * ⭐⭐ i18n (07.11, «литералы обвязки»): ИЗВЛЕКАТЕЛЬ ФРАЗ КЛИЕНТА UNITY (`ui:`). Решение владельца: сервер шлёт весь свой текст на языке игрока,
 * Unity переводит только СВОЮ обвязку — подписи окон, кнопки, подсказки, экраны входа, настройки. Каждый такой литерал в рантайме
 * `Assets/DM` (без папок `Editor` и `Tests`) идёт через шов `DmText` (`Assets/DM/UI/DmText.cs`):
 *
 *     DmText.T("ui:<область>.<camelCase>", "исходник", "слот", значение, …)
 *     DmText.Tn("ui:…", n, new PluralForms(other: "…", one: "…", few: "…", many: "…"))
 *     DmText.With(loc, "ui:…", "исходник", …) / DmText.WithN(loc, "ui:…", n, new PluralForms(…))   — явным разрешителем
 *
 * Отсюда снимок `corpus.ui.json` (ключ → исходник; у фразы по числу — формы), а с ним вкладка «🌐 Языки», покрытие `npm run i18n`,
 * заготовки `i18n:stub` и псевдоязык сторожа утечек. Правило шва то же, что у `srv:` (`srvExtract.ts`): ключ и исходник — СТРОКОВЫЕ
 * ЛИТЕРАЛЫ (без `$`, `@` и склейки), один ключ — один исходник; нарушение — отказ извлекателя, а не тихий пропуск.
 *
 * Почему не регулярка: пример в комментарии (`DmText.cs` показывает `DmText.T("ui:settings.language", …)` в шапке) — не ключ, дыра
 * интерполяции (`$"{DmText.T(…)}"`) — ключ, а исходник с `\n` / `\"` — текст, а не запись. Ниже — лексер C# ровно настолько, насколько это
 * нужно: комментарии, символы, строки (обычные, `@` дословные, `$` интерполированные с дырами), скобки. ⚠ Тот же разбор — у сторожа Unity
 * (`tools/unity-check/ui_text.py`): он сверяет свой корпус с эталоном, который пишет этот извлекатель (`__golden__/unity_ui.json`).
 *
 * ⚠ Модуль читает файловую систему и НЕ входит в индекс shared (редактор собирает индекс в браузер): его зовут инструмент
 * (`tools/i18n/extract.ts`) и сторож (`uiCorpus.test.ts`) по пути. Корпус для браузера — `uiCorpus.ts` (снимок JSON).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { FormSet } from './forms.js';
import { pseudoForms } from './pseudo.js';

/** Ключ фразы клиента: `ui:<область>.<camelCase>` (правило шва `DmText`). */
export const UI_KEY = /^ui:[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/;

/** Где в Unity-репо ищутся фразы: рантайм клиента (папки `Editor` и `Tests` — мимо: инструменты владельца русские, ключи проверок учебные). */
export const UI_ROOT = 'Assets/DM';

/** Найденная фраза: ключ, исходник (строка или формы по числу) и где она (путь от корня Unity-репо). */
export interface UiPhrase {
  key: string;
  source: FormSet;
  file: string;
  line: number;
}

export interface UiExtract {
  phrases: UiPhrase[];
  problems: string[];
}

/**
 * Корень Unity-репо: переменная `DM_UNITY_REPO`, иначе соседняя папка `../ashes of the past/Ashes of the past` от корня веб-репо. Нет
 * папки `Assets/DM` — null (Unity-репо на этой машине нет: корпус берётся снимком).
 */
export function unityRepoRoot(webRoot: string, env: string | undefined = process.env.DM_UNITY_REPO): string | null {
  const root = env ? resolve(env) : resolve(webRoot, '..', 'ashes of the past', 'Ashes of the past');
  return existsSync(join(root, UI_ROOT)) ? root : null;
}

// ── лексер C# ────────────────────────────────────────────────────────────────────────────────────────────
type Tok =
  | { kind: 'id' | 'p' | 'num'; text: string; line: number }
  | { kind: 'str'; text: string; line: number; value: string; interp: boolean; verbatim: boolean; bad: boolean };

const ESC: Readonly<Record<string, string>> = { '\\': '\\', '"': '"', "'": "'", n: '\n', r: '\r', t: '\t', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
const PUNCT = ['??=', '<<=', '>>=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::', '->', '<<'];

/** Значение обычного литерала C#; кривой escape — null. */
function unescape(s: string): string | null {
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i]!;
    if (c !== '\\') { out += c; i++; continue; }
    const e = s[i + 1];
    if (e === undefined) return null;
    if (e in ESC) { out += ESC[e]; i += 2; continue; }
    if (e === 'u' && /^[0-9a-fA-F]{4}/.test(s.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; continue; }
    if (e === 'U' && /^[0-9a-fA-F]{8}/.test(s.slice(i + 2, i + 10))) { out += String.fromCodePoint(parseInt(s.slice(i + 2, i + 10), 16)); i += 10; continue; }
    if (e === 'x') {
      const m = /^[0-9a-fA-F]{1,4}/.exec(s.slice(i + 2, i + 6));
      if (!m) return null;
      out += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue;
    }
    return null;
  }
  return out;
}

const isIdStart = (c: string): boolean => /[\p{L}_]/u.test(c);
const isIdPart = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);

/** Токены файла; дыры интерполяции — токенами между синтетическими `(` `)` (запятая выравнивания не делит аргументы вызова). */
export function lexCs(src: string): Tok[] {
  const toks: Tok[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (p: number): number => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= p) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };

  const stringLit = (i: number, pre: string, openLen: number): number => {
    const verbatim = pre.includes('@'), interp = pre.includes('$');
    let j = i + openLen, text = '', bad = false;
    const at = toks.length;
    let holes = false;
    while (j < src.length) {
      const c = src[j]!;
      if (verbatim && c === '"') {
        if (src[j + 1] === '"') { text += '"'; j += 2; continue; }
        break;
      }
      if (!verbatim && c === '"') break;
      if (!verbatim && c === '\n') { bad = true; break; }
      if (!verbatim && c === '\\') { text += src.slice(j, j + 2); j += 2; continue; }
      if (interp && c === '{') {
        if (src[j + 1] === '{') { text += '{'; j += 2; continue; }
        text += '{}';
        holes = true;
        toks.push({ kind: 'p', text: '(', line: lineOf(j) });
        let k = run(j + 1, true);
        toks.push({ kind: 'p', text: ')', line: lineOf(k) });
        while (k < src.length && src[k] !== '}') k++;   // формат / выравнивание — не код
        j = k + 1;
        continue;
      }
      if (interp && c === '}' && src[j + 1] === '}') { text += '}'; j += 2; continue; }
      text += c; j++;
    }
    const value = verbatim ? text : unescape(text);
    const tok: Tok = { kind: 'str', text: src.slice(i, j + 1), line: lineOf(i), value: value ?? text, interp, verbatim, bad: bad || value === null };
    if (holes) toks.splice(at, 0, tok); else toks.push(tok);
    return j + 1;
  };

  /** Лексит с `i`; `hole` — дыра интерполяции: вернуть позицию `}` / `:` / `,` верхнего уровня. */
  const run = (start: number, hole = false): number => {
    let i = start, depth = 0, bol = true;
    while (i < src.length) {
      const c = src[i]!;
      if (c === '\n') { bol = true; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\uFEFF') { i++; continue; }
      if (bol && c === '#' && !hole) { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue; }   // директива препроцессора
      bol = false;
      if (src.startsWith('//', i)) { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue; }
      if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; continue; }
      if (c === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== "'" && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        i = j + 1; continue;
      }
      const m = /^(\$@|@\$|@|\$)?"/.exec(src.slice(i, i + 3));
      if (m) { i = stringLit(i, m[1] ?? '', m[0].length); continue; }
      if (hole) {
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) { if (depth === 0 && c === '}') return i; depth--; }
        else if (depth === 0 && (c === ':' || c === ',')) return i;
      }
      if (isIdStart(c) || (c === '@' && isIdStart(src[i + 1] ?? ''))) {
        let j = i + 1;
        while (j < src.length && isIdPart(src[j]!)) j++;
        toks.push({ kind: 'id', text: src.slice(c === '@' ? i + 1 : i, j), line: lineOf(i) }); i = j; continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i + 1;
        while (j < src.length && (/[0-9a-zA-Z_]/.test(src[j]!) || (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')))) j++;
        toks.push({ kind: 'num', text: src.slice(i, j), line: lineOf(i) }); i = j; continue;
      }
      const p = PUNCT.find((x) => src.startsWith(x, i)) ?? c;
      toks.push({ kind: 'p', text: p, line: lineOf(i) });
      i += p.length;
    }
    return i;
  };
  run(0);
  return toks;
}

/** Вызовы шва: `DmText.<имя>` → (номер аргумента-ключа, номер аргумента-исходника или форм). */
const SEAM: Readonly<Record<string, readonly [number, number]>> = { T: [0, 1], Tn: [0, 2], With: [1, 2], WithN: [1, 3] };
const FORM_NAMES = new Set(['other', 'one', 'few', 'many', 'two', 'zero']);

/** Пары скобок `([{` ↔ `)]}` по номерам токенов. */
function matchBrackets(toks: readonly Tok[]): Map<number, number> {
  const m = new Map<number, number>();
  const st: number[] = [];
  toks.forEach((t, i) => {
    if (t.kind !== 'p') return;
    if (t.text === '(' || t.text === '[' || t.text === '{') st.push(i);
    else if (t.text === ')' || t.text === ']' || t.text === '}') { const j = st.pop(); if (j !== undefined) { m.set(j, i); m.set(i, j); } }
  });
  return m;
}

/** Аргументы вызова, чья `(` — токен `open`: диапазоны токенов [от, до) по запятым верхнего уровня. */
function argsOf(toks: readonly Tok[], mt: ReadonlyMap<number, number>, open: number): Array<[number, number]> {
  const close = mt.get(open);
  if (close === undefined) return [];
  const out: Array<[number, number]> = [];
  let a = open + 1;
  for (let i = open + 1; i < close; i++) {
    const t = toks[i]!;
    if (t.kind === 'p' && (t.text === '(' || t.text === '[' || t.text === '{')) { i = mt.get(i) ?? i; continue; }
    if (t.kind === 'p' && t.text === ',') { out.push([a, i]); a = i + 1; }
  }
  if (close > open + 1) out.push([a, close]);
  return out;
}

/** Ровно один простой строковый литерал (без `$`, `@`, склейки) — его значение; иначе undefined. */
function plainLit(toks: readonly Tok[], [a, b]: [number, number]): string | undefined {
  const t = toks[a];
  return b - a === 1 && t?.kind === 'str' && !t.interp && !t.verbatim && !t.bad ? t.value : undefined;
}

/**
 * Проходит файлы `files` (путь → текст). Возвращает фразы и нарушения правила шва: ключ не литерал или не по форме, исходник не литерал,
 * формы — не `new PluralForms(имя: "литерал", …)` с `other`, у одного ключа два разных исходника.
 */
export function extractUiPhrases(files: ReadonlyArray<{ path: string; text: string }>): UiExtract {
  const phrases: UiPhrase[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const toks = lexCs(f.text);
    const mt = matchBrackets(toks);
    for (let i = 0; i + 3 < toks.length; i++) {
      const a = toks[i]!, dot = toks[i + 1]!, fnTok = toks[i + 2]!, open = toks[i + 3]!;
      if (!(a.kind === 'id' && a.text === 'DmText' && dot.kind === 'p' && dot.text === '.' && fnTok.kind === 'id' && open.kind === 'p' && open.text === '(')) continue;
      const fn = fnTok.text;
      const seam = SEAM[fn];
      if (!seam) continue;
      const where = `${f.path}:${a.line}`;
      const args = argsOf(toks, mt, i + 3);
      const [ki, si] = seam;
      if (args.length <= Math.max(ki, si)) { problems.push(`${where}: DmText.${fn} — мало аргументов`); continue; }
      const key = plainLit(toks, args[ki]!);
      if (key === undefined) { problems.push(`${where}: ключ DmText.${fn} — не строковый литерал`); continue; }
      if (!UI_KEY.test(key)) { problems.push(`${where}: ключ «${key}» не по форме ui:<область>.<camelCase>`); continue; }
      if (fn === 'T' || fn === 'With') {
        const src = plainLit(toks, args[si]!);
        if (src === undefined) { problems.push(`${where}: исходник «${key}» — не строковый литерал (без $, @ и склейки)`); continue; }
        phrases.push({ key, source: src, file: f.path, line: a.line });
        continue;
      }
      // формы по числу: `new PluralForms(other: "…", one: "…", …)` — только именованные литералы
      const [s, e] = args[si]!;
      const forms: Record<string, string> = {};
      let ok = e - s >= 4 && toks[s]!.kind === 'id' && toks[s]!.text === 'new' && toks[s + 1]!.kind === 'id' && toks[s + 1]!.text === 'PluralForms'
        && toks[s + 2]!.kind === 'p' && toks[s + 2]!.text === '(' && mt.get(s + 2) === e - 1;
      if (ok) {
        for (const [fa, fb] of argsOf(toks, mt, s + 2)) {
          const n = toks[fa], colon = toks[fa + 1];
          const v = fb - fa === 3 ? plainLit(toks, [fa + 2, fb]) : undefined;
          if (!(n?.kind === 'id' && FORM_NAMES.has(n.text) && colon?.kind === 'p' && colon.text === ':' && v !== undefined)) { ok = false; break; }
          forms[n.text] = v;
        }
      }
      if (!ok || forms.other === undefined) { problems.push(`${where}: формы «${key}» — не \`new PluralForms(other: "…", …)\` именованными литералами`); continue; }
      phrases.push({ key, source: forms, file: f.path, line: a.line });
    }
  }
  // ── один ключ — один исходник ──
  const first = new Map<string, UiPhrase>();
  for (const p of phrases) {
    const was = first.get(p.key);
    if (!was) { first.set(p.key, p); continue; }
    if (JSON.stringify(sorted(was.source)) !== JSON.stringify(sorted(p.source))) {
      problems.push(`${p.file}:${p.line}: у ключа «${p.key}» два исходника: ${JSON.stringify(was.source)} (${was.file}:${was.line}) и ${JSON.stringify(p.source)}`);
    }
  }
  return { phrases, problems };
}

/** Формы — в порядке имён (сравнение «тот же исходник» не зависит от порядка именованных аргументов). */
function sorted(v: FormSet): FormSet {
  return typeof v === 'string' ? v : Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Все `.cs` рантайма под `Assets/DM` (без папок `Editor` и `Tests`) в устойчивом порядке. */
function listCs(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'Editor' || name === 'Tests' || name.startsWith('.') || name.endsWith('~')) continue;
      listCs(p, out);
    } else if (name.endsWith('.cs')) out.push(p);
  }
}

/** Проход по рантайму Unity-репо `unityRoot`. Пути в итоге — от корня Unity-репо, с `/`. */
export function extractUiFromRepo(unityRoot: string): UiExtract {
  const paths: string[] = [];
  listCs(join(unityRoot, UI_ROOT), paths);
  return extractUiPhrases(paths.map((p) => ({ path: relative(unityRoot, p).split(sep).join('/'), text: readFileSync(p, 'utf8').replace(/^\uFEFF/, '') })));
}

/** Корпус из фраз: ключ → исходник, ключи по алфавиту. */
export function uiCorpusOf(phrases: readonly UiPhrase[]): Record<string, FormSet> {
  const out: Record<string, FormSet> = {};
  for (const p of [...phrases].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) if (!(p.key in out)) out[p.key] = p.source;
  return out;
}

/** Текст файла корпуса (`corpus.ui.json`) — его пишет `npm run i18n`, сторож сверяет с ним код Unity. */
export function uiCorpusFileText(strings: Record<string, FormSet>): string {
  return `${JSON.stringify({
    note: 'Фразы клиента Unity (ui:). Генерит `npm run i18n` (tools/i18n/extract.ts) из вызовов DmText.T/Tn/With/WithN в рантайме Assets/DM Unity-репо (без Editor и Tests). Руками не править: сторож uiCorpus.test.ts сверяет файл с кодом (когда Unity-репо рядом), Unity — tools/unity-check/ui_text.py.',
    count: Object.keys(strings).length,
    strings,
  }, null, 1)}\n`;
}

/** Язык эталона Unity: псевдоязык сторожа утечек (`pseudo.ts`). */
export const UI_PSEUDO_LANG = 'xx';

/**
 * ⭐ ЭТАЛОН UNITY `__golden__/unity_ui.json` (копия — `Assets/DM/UI/Tests/unity_ui_golden.json`, `golden_sync.py`): корпус `ui:` и таблица
 * языков — пакет источника `ru` из `locales.json` как есть и псевдоязык `xx`, где КАЖДЫЙ ключ корпуса переведён транслитом (`pseudoForms`).
 * Сторожа Unity: `ui_text.py` сверяет корпус своего кода с `strings` (эталон не устарел), `UiTextCheck` (C#) — что под `xx` шов `DmText`
 * отдаёт по каждому ключу текст без кириллицы, с теми же `{слотами}` и ведущим знаком. Пишет `npm run i18n` (тот же проход, что корпус).
 */
export function unityUiGoldenText(strings: Readonly<Record<string, FormSet>>, ruPack: unknown): string {
  const xx: Record<string, FormSet> = {};
  for (const [k, v] of Object.entries(strings)) xx[k] = pseudoForms(v);
  return `${JSON.stringify({
    note: 'Эталон Unity для сторожа фраз клиента (ui:): корпус corpus.ui.json + псевдоязык xx (транслит каждого ключа). Генерит `npm run i18n` (tools/i18n/extract.ts); копия — Assets/DM/UI/Tests/unity_ui_golden.json (golden_sync.py); сторожа — tools/unity-check/ui_text.py и UiTextCheck. Руками не править.',
    lang: UI_PSEUDO_LANG,
    locales: {
      ru: ruPack ?? { name: 'Русский', enabled: true, grammar: { join: ' ', agrees: true }, templates: {}, strings: {} },
      [UI_PSEUDO_LANG]: { name: 'Pseudo', enabled: true, grammar: { join: ' ', agrees: false, capitalize: 'first' }, templates: {}, strings: xx },
    },
    strings,
  }, null, 1)}\n`;
}
