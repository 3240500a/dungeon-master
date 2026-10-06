import {
  ConfigRegistry, configSchemas, configCrossIssues, upgradeStoredOverride, CONFIG_CROSS_CORE,
  type ConfigCrossIssue, type ConfigCrossRule, type ConfigKey,
} from '@dm/shared';

/**
 * ⭐ R21-01/02/03: КАНДИДАТ ЖИВОГО КОНФИГА — ОДНА СБОРКА НА ВСЕХ. Пересборка (`configLive.ts`: старт, сверка, запись), проба записи (ручки
 * редактора, наблюдатель файлов, сброс таблицы) и `db:repair` собирают одно и то же: основу (файлы данных — импорт старта и файлы, прочитанные
 * с диска после него) и оверрайды базы поверх. Правило поверх нескольких таблиц (⭐ D4: время баффа) спрашивается у ИТОГОВОГО кандидата.
 *
 * Раньше оверрайды ложились по одному (`reload({[key]})`) в порядке строк `SELECT … FROM config_overrides` (без ORDER BY — порядок кучи,
 * UPDATE уносит строку в конец), и правило D4 проверялось над ПОЛУСОБРАННЫМ реестром. Годный вместе набор хозяина в одном порядке ложился, в
 * другом — баланс проверялся против древа файла и выбрасывался целиком инцидентом (очки за уровень, цены кузницы, сброса — с файла), или
 * древо и вставки «приводились» против баланса файла (потолок ранга клича 8 → 6, откат печати 7 → 10.4), и `db:repair --fix` писал это в
 * базу. Одним фиксированным порядком не спасти: правило связывает таблицы в обе стороны. А основа грузилась с проверкой D4 над ОДНИМИ
 * файлами — файл, годный только вместе с оверрайдами, ронял каждую пересборку и старт процесса.
 *
 * Теперь сборка в два шага, и от порядка строк не зависит ни один:
 *  1. СХЕМА — у каждой таблицы своя: основа — схемой (негодный файл — бросок, как прежде: его не пропускают ни наблюдатель, ни ручка записи),
 *     каждый оверрайд — схемой с приведением прежних схем (R20-08, D2); не прошедший — пропуск инцидентом, как прежде.
 *  2. ПРАВИЛО ПОВЕРХ ТАБЛИЦ — над итоговым кандидатом. Древо и вставки кандидата (оверрайд или файл) приводятся зажимом D4
 *     (`upgradeStoredOverride`) ТОЛЬКО если нарушают правило вместе с прочими таблицами кандидата: годный вместе набор не меняется ни в каком
 *     порядке. Древо — поверх баланса и вставок кандидата, вставки — поверх приведённого древа (донор печати). Приведённое в оверрайде —
 *     предупреждение (сохранён до правила), в ФАЙЛЕ — инцидент (файлы данных вместе с оверрайдами нарушают правило: поправить файл). После
 *     зажима кандидат годен по построению (`buffTimingIssues.repair`); нет — `crossLeft`, сборка не бросает (ядро держит зажим с логом).
 * Отката «по одному ключу в неком порядке с повтором до неподвижной точки» здесь нет сознательно: схема одной таблицы от прочих не зависит,
 * а правило поверх таблиц решается над итогом — любой фиксированный порядок ломал бы одно из направлений связи (баланс ↔ древо ↔ вставки).
 *
 * Запись и сброс (`configLive.ts` `trial`) проверяют правку СТРОГО поверх этого кандидата: зажим — только для того, что уже лежит, а не для
 * новой правки.
 */
export interface ConfigCandidate {
  /** Сырые таблицы кандидата (основа + оверрайды, приведённые): для `loadAll` живого реестра. */
  raw: Record<string, unknown>;
  /** Реестр-проба с кандидатом (разобранным, без проверки поверх таблиц): база проб записи (`reload` поверх — строго). */
  reg: ConfigRegistry;
  /** Оверрайды, легшие в кандидат (по ключу). */
  applied: string[];
  /** Приведённое в оверрайдах (ключ → строки): предупреждение (R20-08) — в базе прежний, `db:repair -- --fix` запишет. */
  fixes: Record<string, string[]>;
  /** ⚠ Приведённое в ФАЙЛАХ данных правилом поверх таблиц (ключ → строки): инцидент — файл вместе с оверрайдами нарушает правило. */
  fileFixes: Record<string, string[]>;
  /** Пропущенные оверрайды (неизвестная таблица, схема не пустила): инцидент. `value` — после приведения прежних схем (для `db:repair`). */
  skipped: { key: string; error: string; value: unknown }[];
  /** Правило поверх таблиц кандидат всё же нарушает (приведение не справилось — не бывает по построению): инцидент, ядро держит зажим. */
  crossLeft: ConfigCrossIssue[];
}

/** Таблицы, которые правило D4 приводит, в порядке приведения: древо (поверх баланса и вставок), затем вставки (поверх приведённого древа). */
const REPAIRED: readonly ConfigKey[] = ['skill-tree', 'skill-inserts'];

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Собрать кандидат: `base` — основа (файлы данных), `stored` — оверрайды базы (как их вернул `getConfigOverrides`, порядок не важен).
 * Бросает только на негодной ОСНОВЕ по схеме таблицы (как `loadAll` прежде) — правило поверх таблиц не бросает никогда.
 */
export function buildCandidate(base: Record<string, unknown>, stored: Record<string, unknown>): ConfigCandidate {
  const reg = new ConfigRegistry();
  reg.loadAll(base, { cross: false });   // шаг 1: основа — схемой; правило поверх таблиц — над итоговым кандидатом (шаг 2)
  const raw: Record<string, unknown> = { ...base };
  const applied: string[] = [];
  const fixes: Record<string, string[]> = {};
  const fileFixes: Record<string, string[]> = {};
  const skipped: ConfigCandidate['skipped'] = [];
  for (const key of Object.keys(stored).sort()) {
    // Приведение прежних схем одной таблицы (R20-08: старт класса; D2: кривая опыта). Правило D4 древа и вставок — не здесь, а в шаге 2:
    // над итоговым кандидатом, а не над тем, что успело лечь.
    const { value, fixes: f } = (REPAIRED as readonly string[]).includes(key) ? { value: stored[key], fixes: [] } : upgradeStoredOverride(key, stored[key]);
    try {
      reg.reload({ [key]: value } as Partial<Record<ConfigKey, unknown>>, { cross: false });   // неизвестная таблица и схема — бросок
    } catch (e) {
      skipped.push({ key, error: errText(e), value });
      continue;
    }
    raw[key] = value;
    applied.push(key);
    if (f.length) fixes[key] = f;
  }
  // Шаг 2: правило поверх таблиц — над итоговым кандидатом (`reg` — его подобие для `upgradeStoredOverride`).
  for (const key of REPAIRED) {
    const { value, fixes: f } = upgradeStoredOverride(key, raw[key], reg);
    if (!f.length) continue;
    try {
      reg.reload({ [key]: value }, { cross: false });
    } catch {
      continue;   // зажим вывел таблицу из схемы — не бывает; нарушение останется в `crossLeft`
    }
    raw[key] = value;
    const into = applied.includes(key) ? fixes : fileFixes;
    into[key] = [...(into[key] ?? []), ...f];
  }
  const crossLeft = configCrossIssues((k) => reg.get(k));
  return { raw, reg, applied, fixes, fileFixes, skipped, crossLeft };
}

/**
 * Нарушения по правилам — текст, где у каждого правила сказано, что делает ядро, пока оно нарушено (`CONFIG_CROSS_CORE`): прежде строка
 * про любое нарушение говорила «ядро зажимает откаты», хотя у правил разбора откатов нет вовсе.
 */
function byRule(issues: readonly ConfigCrossIssue[]): string {
  const rules = [...new Set(issues.map((i) => i.rule))] as ConfigCrossRule[];
  return rules.map((r) => `[${r}: ${CONFIG_CROSS_CORE[r]}] ${issues.filter((i) => i.rule === r).map((i) => `${i.key}: ${i.msg}`).join(' | ')}`).join(' || ');
}

/** Строки для лога по приведённому и пропущенному — одним текстом у сервера и `db:repair`. */
export const candidateText = {
  skipped: (s: ConfigCandidate['skipped'][number]): string =>
    `пропущен невалидный оверрайд конфига "${s.key}" — таблица целиком живёт на файле, правок хозяина в ней в игре нет (сохранить заново из редактора или npm run db:repair): ${s.error}`,
  fixed: (key: string, lines: readonly string[]): string =>
    `оверрайд конфига "${key}" сохранён под прежней схемой — приведён при загрузке (в базе прежний: записать — «Применить» в редакторе или npm run db:repair -- --fix): ${lines.join(', ')}`,
  fileFixed: (key: string, lines: readonly string[]): string =>
    `файл данных «${key}» вместе с прочими таблицами (файлы и оверрайды базы) нарушает правило времени баффа (⭐ D4) — приведён при сборке, в игре приведённое (поправить data/${key}.json или связанный оверрайд в редакторе): ${lines.join(', ')}`,
  crossLeft: (issues: readonly ConfigCrossIssue[]): string =>
    `живой конфиг нарушает правило поверх таблиц и после приведения — собран без проверки: ${byRule(issues)}`,
  filesAlone: (issues: readonly ConfigCrossIssue[]): string =>
    `файлы данных сами по себе (без оверрайдов базы) нарушают правило поверх таблиц — на деплое старт соберёт их с инцидентом: ${byRule(issues)}`,
};
