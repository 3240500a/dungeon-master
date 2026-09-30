import { defaultConfigData } from '@dm/shared';
import { buildCandidate } from '../configCandidate.js';

/**
 * Починка оверрайдов конфига, отставших от схемы (`npm run db:repair`, `repairConfig.ts` — обёртка с базой).
 *
 * ЗАЧЕМ. Сервер применяет сохранённые оверрайды поверх дефолтов и МОЛЧА пропускает те,
 * что не проходят валидацию (это правильно: лучше играть на дефолтах, чем упасть). Но
 * молчание означает, что правка из редактора может месяцами не доезжать до игры, и никто
 * этого не заметит. Так и случилось с `materials`: у цвета стало четыре компоненты вместо
 * трёх (добавилась прозрачность), а сохранённое значение осталось трёхкомпонентным — и весь
 * оверрайд игнорировался с 22 августа.
 *
 * Чинит только то, что чинится ОДНОЗНАЧНО: цвет [r,g,b] → [r,g,b,1] (непрозрачный —
 * ровно то, чем он был до появления альфы). Всё остальное только показывается: угадывать
 * авторский замысел скриптом нельзя.
 *
 * ⭐ R21-01: оверрайды проверяются ВМЕСТЕ — тем же кандидатом, что собирает сервер (`buildCandidate`: файлы данных + все оверрайды): правило
 * поверх нескольких таблиц (D4, время баффа) спрашивается у итогового набора. Раньше каждый ключ пробовался один поверх файлов, а приведение
 * баффа считалось против файлов: годный вместе набор (отдых 1.0 в балансе при поднятых откатах древа) звался «не проходит валидацию», а
 * древо, годное при отдыхе 0.1 из базы, `--fix` «приводил» против отдыха файла — потолок ранга клича 8 → 6 навсегда. Теперь `--fix` пишет
 * приведение баффа, только если набор вместе правило нарушает, и ровно то, что сервер и так применяет.
 */
export interface RepairDeps {
  /** Оверрайды базы (`getConfigOverrides`). */
  overrides: Record<string, unknown>;
  /** Записывать (`--fix`) или только показать. */
  fix: boolean;
  /** Записать оверрайд (`setConfigOverride`). */
  write: (key: string, value: unknown) => Promise<void>;
  /** Строка отчёта (`console.log`). */
  out: (line: string) => void;
  /** Файлы данных (умолчание — импорт процесса: файлы на диске в момент запуска скрипта). */
  base?: Record<string, unknown>;
}

export interface RepairReport {
  /** Не проходят схему — в игре НЕ применяются. */
  broken: string[];
  /** Сервер приводит при загрузке (применяются приведёнными). */
  upgraded: string[];
  /** Записано (`fix`). */
  written: string[];
  /** Файлы данных, которые сервер приводит правилом поверх таблиц (базой не чинится). */
  files: string[];
}

/** Дописать непрозрачность трёхкомпонентным цветам. Возвращает число исправлений. */
function padColors(v: unknown, key: string, path: string[], log: string[]): number {
  if (Array.isArray(v)) {
    // Цвет — массив из трёх чисел там, где ждут четыре.
    if (v.length === 3 && v.every((x) => typeof x === 'number')) {
      const last = path[path.length - 1] ?? '';
      if (/color|colour/i.test(last)) {
        (v as number[]).push(1);
        log.push(`  ${key}.${path.join('.')}: [${v.slice(0, 3).join(', ')}] → [${v.join(', ')}]`);
        return 1;
      }
    }
    let n = 0;
    for (const [i, item] of v.entries()) n += padColors(item, key, [...path, String(i)], log);
    return n;
  }
  if (v && typeof v === 'object') {
    let n = 0;
    for (const [k, item] of Object.entries(v)) n += padColors(item, key, [...path, k], log);
    return n;
  }
  return 0;
}

export async function repairOverrides(o: RepairDeps): Promise<RepairReport> {
  const { out } = o;
  const base = o.base ?? defaultConfigData;
  const cand = buildCandidate(base, o.overrides);
  const report: RepairReport = { broken: cand.skipped.map((s) => s.key), upgraded: [], written: [], files: Object.keys(cand.fileFixes) };
  // ⚠ R20-08: сохранённое под прежней схемой сервер приводит при загрузке (`upgradeStoredOverride`: старт класса дробью или минусом;
  // ⭐ D2 — кривая опыта баланса старше R20-05; ⭐ D4 — бафф, нарушающий правило ВМЕСТЕ с прочими таблицами кандидата) — такое в игре
  // ПРИМЕНЯЕТСЯ; `--fix` записывает приведённое, и строка лога при каждой пересборке пропадает.
  for (const key of cand.applied) {
    const lines = cand.fixes[key];
    if (!lines?.length) continue;
    report.upgraded.push(key);
    out(`\n~ «${key}» сохранён под прежней схемой — сервер приводит при загрузке (${lines.length}):`);
    for (const l of lines.slice(0, 8)) out(`  ${l}`);
    if (lines.length > 8) out(`    … и ещё ${lines.length - 8}`);
    if (o.fix) { await o.write(key, cand.raw[key]); report.written.push(key); }
  }
  for (const [key, lines] of Object.entries(cand.fileFixes)) {
    out(`\n⚠ файл данных «${key}» вместе с оверрайдами нарушает правило поверх таблиц (D4) — сервер приводит его при сборке (${lines.length}); базой это не чинится: поправить data/${key}.json или связанный оверрайд в редакторе`);
    for (const l of lines.slice(0, 8)) out(`  ${l}`);
  }
  if (cand.crossLeft.length) out(`\n✗ набор нарушает правило поверх таблиц и после приведения: ${cand.crossLeft.map((i) => `${i.key}: ${i.msg}`).join(' | ')}`);
  for (const s of cand.skipped) {
    out(`\n✗ «${s.key}» не проходит валидацию и НЕ ПРИМЕНЯЕТСЯ в игре`);
    out(`  ${s.error.split('\n')[0]}`);
  }
  if (!cand.skipped.length) {
    out('Все сохранённые оверрайды конфига проходят валидацию.');
    if (report.written.length) out('✓ Приведённое записано.');
    return report;
  }

  out('\nЧто можно исправить однозначно:');
  for (const s of cand.skipped) {
    const value = structuredClone(s.value);   // R20-08: поверх приведённого, как сервер
    const log: string[] = [];
    const n = padColors(value, s.key, [], log);
    if (!n) { out(`  ${s.key}: автоматически не чинится — нужен редактор`); continue; }
    // Проба — как сервер: кандидат со всеми оверрайдами и исправленным (⭐ R21-01: вместе, а не один поверх файлов).
    const trial = buildCandidate(base, { ...o.overrides, [s.key]: value });
    const still = trial.skipped.find((x) => x.key === s.key);
    if (still) {
      out(`  ${s.key}: после правки цветов всё ещё не проходит — не трогаю`);
      out(`    ${still.error.split('\n')[0]}`);
      continue;
    }
    out(`  ${s.key}: исправлений ${n}`);
    for (const l of log.slice(0, 8)) out(l);
    if (log.length > 8) out(`    … и ещё ${log.length - 8}`);
    if (o.fix) { await o.write(s.key, trial.raw[s.key]); report.written.push(s.key); }
  }

  out(o.fix
    ? (report.written.length ? '\n✓ Записано. Перезапустите сервер, чтобы оверрайды применились.' : '\nНичего не записано.')
    : '\nЭто был показ. Чтобы записать: npm run db:repair -- --fix');
  return report;
}
