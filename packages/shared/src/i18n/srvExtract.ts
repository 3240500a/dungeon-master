/**
 * ⭐⭐ i18n Ф2 (06.11): ИЗВЛЕКАТЕЛЬ ФРАЗ КОДА (`srv:`) — по синтаксическому дереву TypeScript, а не регуляркой. Каждый вызов
 * `tr('srv:…', 'исходник', …)` / `trn('srv:…', n, { one, few, many, other })` в `packages/shared/src` и `packages/server/src` — ключ
 * корпуса `corpus.srv.json`; из него берут переводчик (вкладка «🌐 Языки»), отчёт покрытия (`npm run i18n`) и сторож псевдоязыка.
 * ⭐ 07.11: и `trWith(loc, 'srv:…', 'исходник', …)` — та же фраза с явным разрешителем (ключ — 2-й аргумент, исходник — 3-й).
 *
 * Почему дерево, а не регулярка: пример в комментарии (`tr.ts` показывает `tr('srv:forge.noRoom', …)` в шапке) — не ключ, а исходник,
 * переданный константой (`tr('srv:salvage.starterKnown', STARTER_KNOWN)`), — ключ; регулярка путает оба. Константа ищется по ИМЕНИ среди
 * `const ИМЯ = 'литерал'` всех файлов (исходник обязан быть литералом или такой константой — правило шва `tr.ts`); два разных значения
 * одного имени — ошибка, а не угадывание.
 *
 * ⚠ Модуль тянет `typescript` и потому НЕ входит в индекс shared (редактор собирает индекс в браузер): его зовут инструмент
 * (`tools/i18n/extract.ts`) и сторож (`srvCorpus.test.ts`) по пути.
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { FormSet } from './forms.js';

/** Корни, по которым ищутся фразы: правила (`shared`) и исполнение (`server`). Тесты — мимо: их ключи нарочно учебные. */
export const SRV_ROOTS: readonly string[] = ['packages/shared/src', 'packages/server/src'];

/** Ключ фразы кода: `srv:<область>.<camelCase>` (правило шва). */
export const SRV_KEY = /^srv:[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/;

/** Найденная фраза: ключ, исходник (строка или формы по числу) и где она. */
export interface SrvPhrase {
  key: string;
  source: FormSet;
  file: string;
  line: number;
}

/** Итог прохода: фразы в порядке файлов и строк, плюс всё, что нарушает правило шва. */
export interface SrvExtract {
  phrases: SrvPhrase[];
  problems: string[];
}

/** Все `.ts` под корнем, кроме тестов и `d.ts`, — в устойчивом порядке (корпус не должен прыгать от порядка обхода ФС). */
function listTs(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      listTs(p, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') && !name.includes('.testkit.')) out.push(p);
  }
}

const lit = (n: ts.Node | undefined): string | undefined =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;

/** Литерал под `as const` / скобками / `satisfies` — тот же литерал. */
function unwrap(n: ts.Expression): ts.Expression {
  let e = n;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/**
 * Проходит файлы `files` (путь → текст; путь — для отчёта). Возвращает фразы и нарушения правила шва:
 * ключ не литерал или не по форме, исходник не литерал и не константа, у одного ключа два разных исходника.
 */
export function extractSrvPhrases(files: ReadonlyArray<{ path: string; text: string }>): SrvExtract {
  const problems: string[] = [];
  const parsed = files.map((f) => ({ path: f.path, sf: ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) }));

  // ── константы-исходники: `const ИМЯ = 'литерал'` во всех файлах ──
  const consts = new Map<string, Set<string>>();
  for (const { sf } of parsed) {
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const v = lit(unwrap(n.initializer));
        if (v !== undefined) {
          const set = consts.get(n.name.text) ?? new Set<string>();
          set.add(v);
          consts.set(n.name.text, set);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const constOf = (id: string): string | undefined => {
    const set = consts.get(id);
    return set && set.size === 1 ? [...set][0] : undefined;
  };

  // ── вызовы `tr` / `trWith` / `trn` ──
  // ⭐ 07.11: `trWith(loc, key, source, params)` — та же фраза с явным разрешителем: ключ — 2-й аргумент, исходник — 3-й
  const phrases: SrvPhrase[] = [];
  for (const { path, sf } of parsed) {
    const where = (n: ts.Node): { file: string; line: number } => ({ file: path, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'tr' || n.expression.text === 'trn' || n.expression.text === 'trWith')) {
        const fn = n.expression.text;
        const at = where(n);
        const shift = fn === 'trWith' ? 1 : 0;
        const keyNode = n.arguments[shift];
        const key = keyNode ? lit(unwrap(keyNode)) : undefined;
        if (key === undefined) {
          problems.push(`${at.file}:${at.line}: ключ ${fn}() — не строковый литерал`);
        } else if (!SRV_KEY.test(key)) {
          problems.push(`${at.file}:${at.line}: ключ «${key}» не по форме srv:<область>.<camelCase>`);
        } else if (fn === 'tr' || fn === 'trWith') {
          const srcArg = n.arguments[1 + shift];
          const src = srcArg ? unwrap(srcArg) : undefined;
          const text = lit(src) ?? (src && ts.isIdentifier(src) ? constOf(src.text) : undefined);
          if (text === undefined) problems.push(`${at.file}:${at.line}: исходник «${key}» — не литерал и не константа с одним значением`);
          else phrases.push({ key, source: text, ...at });
        } else {
          const formsNode = n.arguments[2] ? unwrap(n.arguments[2]) : undefined;
          const forms: Record<string, string> = {};
          let ok = !!formsNode && ts.isObjectLiteralExpression(formsNode);
          if (ok) {
            for (const p of (formsNode as ts.ObjectLiteralExpression).properties) {
              const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
              const v = ts.isPropertyAssignment(p) ? lit(unwrap(p.initializer)) : undefined;
              if (name === undefined || v === undefined) { ok = false; break; }
              forms[name] = v;
            }
          }
          if (!ok || forms.other === undefined) problems.push(`${at.file}:${at.line}: формы «${key}» — не объект строковых литералов с \`other\``);
          else phrases.push({ key, source: forms, ...at });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // ── один ключ — один исходник ──
  const first = new Map<string, SrvPhrase>();
  for (const p of phrases) {
    const was = first.get(p.key);
    if (!was) { first.set(p.key, p); continue; }
    if (JSON.stringify(was.source) !== JSON.stringify(p.source)) {
      problems.push(`${p.file}:${p.line}: у ключа «${p.key}» два исходника: ${JSON.stringify(was.source)} (${was.file}:${was.line}) и ${JSON.stringify(p.source)}`);
    }
  }
  return { phrases, problems };
}

/** Проход по корням проекта (`SRV_ROOTS`) от корня репозитория `repoRoot`. Пути в итоге — от корня, с `/`. */
export function extractSrvFromRepo(repoRoot: string): SrvExtract {
  const paths: string[] = [];
  for (const r of SRV_ROOTS) listTs(join(repoRoot, r), paths);
  return extractSrvPhrases(paths.map((p) => ({ path: relative(repoRoot, p).split(sep).join('/'), text: readFileSync(p, 'utf8') })));
}

/** Корпус из фраз: ключ → исходник, ключи по алфавиту (файл корпуса не прыгает от перестановки кода). */
export function srvCorpusOf(phrases: readonly SrvPhrase[]): Record<string, FormSet> {
  const out: Record<string, FormSet> = {};
  for (const p of [...phrases].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) if (!(p.key in out)) out[p.key] = p.source;
  return out;
}

/** Текст файла корпуса (`corpus.srv.json`) — его пишет `npm run i18n`, сторож сверяет с ним код. */
export function srvCorpusFileText(strings: Record<string, FormSet>): string {
  return `${JSON.stringify({
    note: 'Фразы кода сервера (srv:). Генерит `npm run i18n` (tools/i18n/extract.ts) из вызовов tr()/trn() в packages/shared/src и packages/server/src. Руками не править: сторож srvCorpus.test.ts сверяет файл с кодом.',
    count: Object.keys(strings).length,
    strings,
  }, null, 1)}\n`;
}
