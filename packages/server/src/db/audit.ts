import type { SaveState } from '@dm/shared';
import { isUuid } from '@dm/shared';
import { q, q1 } from './pool.js';
import { itemsOfSave, itemsOfStash, locOfChar, LOC_REVOKED } from './items.js';

/**
 * Аудит инвариантов (Ф2.6).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ МОДУЛЕМ, А НЕ В CLI. Проверку гоняют двое: человек руками
 * (`npm run items:audit`) и ночная задача на гейтвее. Считать они обязаны ОДНО И ТО ЖЕ —
 * иначе через месяц окажется, что ночью проверяется не то, что смотрели глазами.
 *
 * ЧТО ЭТО НЕ ДЕЛАЕТ: не наказывает и ничего не чинит. Находка — это повод посмотреть,
 * а не основание для действия. Правило то же, что у детектора аномалий (Ф3.3).
 *
 * ЧЕСТНО О ГРАНИЦАХ. Сохранности ЗОЛОТА проверить нечем: журнала золота у нас нет, есть
 * только журнал предметов. Поэтому экономические проверки здесь — о скорости появления
 * вещей и о выбросах между аккаунтами, а не о балансе «сколько добыто против сколько
 * потрачено». Врать в отчёте хуже, чем не проверять.
 */

export type Severity = 'incident' | 'attention' | 'info';

export interface Finding {
  kind: string;
  severity: Severity;
  title: string;
  count: number;
  /** Несколько примеров: без них находку невозможно разбирать. */
  examples: string[];
}

export interface AuditResult {
  at: Date;
  items: number;
  events: number;
  findings: Finding[];
  /** Сколько находок уровня «инцидент». Ноль — норма, любое другое число это разбор. */
  incidents: number;
}

/** Известные причины появления вещи. Всё остальное — повод посмотреть, кто это написал. */
const KNOWN_REASONS = ['newCharacter', 'autosave', 'stash', 'join'];

export async function runAudit(): Promise<AuditResult> {
  const findings: Finding[] = [];
  const add = (kind: string, severity: Severity, title: string, examples: string[]): void => {
    findings.push({ kind, severity, title, count: examples.length, examples: examples.slice(0, 10) });
  };

  const items = Number((await q1<{ n: string }>('SELECT COUNT(*) n FROM items'))?.n ?? 0);
  const events = Number((await q1<{ n: string }>('SELECT COUNT(*) n FROM item_events'))?.n ?? 0);

  // ── 1. Вещи без записи о рождении ───────────────────────────────────────────
  // Такого быть не может, если в леджер писал только наш код.
  const orphan = await q<{ id: string }>(
    `SELECT i.id FROM items i
     WHERE NOT EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = i.id AND e.kind = 'created')
     LIMIT 50`);
  if (orphan.length) add('orphan', 'incident', 'вещи без записи о рождении', orphan.map((r) => r.id));

  // ── 2. Главная сверка: сейвы против леджера ─────────────────────────────────
  const chars = await q<{ char_id: string; user_id: string; data: SaveState }>(
    'SELECT char_id, user_id, data FROM characters');
  const stashes = await q<{ user_id: string; data: unknown }>('SELECT user_id, data FROM account_stash');

  // Леджер целиком в память: построчные запросы на тысячах вещей превращают ночную задачу
  // в получасовую. Строка леджера маленькая, десятки тысяч влезают без вопросов.
  const ledger = new Map<string, { loc: string; user: string }>();
  for (const r of await q<{ id: string; loc: string; user_id: string }>('SELECT id, loc, user_id FROM items')) {
    ledger.set(r.id, { loc: r.loc, user: r.user_id });
  }

  const mismatch: string[] = [];
  const legacy: string[] = [];
  const dupes: string[] = [];
  const seen = new Map<string, string>();

  const check = (id: string, where: string, userId: string): void => {
    if (!isUuid(id)) { legacy.push(`${id} (${where})`); return; }
    const prev = seen.get(id);
    if (prev) { dupes.push(`${id}: ${prev} И ${where}`); return; }
    seen.set(id, where);
    const row = ledger.get(id);
    if (!row) { mismatch.push(`${id} (${where}): нет в леджере`); return; }
    if (row.user !== userId) { mismatch.push(`${id} (${where}): леджер числит за ${row.user}`); return; }
    if (row.loc !== where) mismatch.push(`${id} (${where}): леджер говорит «${row.loc}»`);
  };

  for (const c of chars) for (const it of itemsOfSave(c.data)) check(it.uid, locOfChar(c.char_id), c.user_id);
  for (const s of stashes) for (const it of itemsOfStash(s.data as never)) check(it.uid, 'stash', s.user_id);

  if (dupes.length) add('dupe', 'incident', 'ОДНА ВЕЩЬ В ДВУХ МЕСТАХ', dupes);
  if (mismatch.length) add('mismatch', 'incident', 'сейв и леджер разошлись', mismatch);
  if (legacy.length) add('legacy', 'info', 'вещи со старыми id (до Ф2, вне леджера)', legacy);

  // ── 3. Обратная сверка: леджер держит вещь у персонажа, а её там нет ─────────
  // Прямая сверка (выше) ловит лишнее в сейве; эта — потерянное. Вместе они замыкают круг.
  const lost: string[] = [];
  for (const [id, row] of ledger) {
    if (row.loc === LOC_REVOKED || row.loc === 'world') continue;
    if (!seen.has(id)) lost.push(`${id}: леджер держит в «${row.loc}», в сейве нет`);
    if (lost.length >= 50) break;
  }
  if (lost.length) add('lost', 'incident', 'леджер держит вещь, которой нет в сейве', lost);

  // ── 4. Причины появления вещей ──────────────────────────────────────────────
  // Причина пишется нашим кодом; незнакомая означает либо новую ветку, про которую забыли,
  // либо запись мимо обычного пути.
  const reasons = await q<{ reason: string | null; n: string }>(
    `SELECT reason, COUNT(*) n FROM item_events WHERE kind = 'created' GROUP BY reason ORDER BY n DESC`);
  const strange = reasons.filter((r) => !r.reason || !KNOWN_REASONS.some((k) => r.reason!.startsWith(k)));
  if (strange.length) {
    add('reason', 'attention', 'вещи созданы с незнакомой причиной',
      strange.map((r) => `${r.reason ?? '(без причины)'}: ${r.n}`));
  }

  // ── 5. Экономика: скорость появления вещей и выбросы между аккаунтами ───────
  const perUser = await q<{ user_id: string; n: string }>(
    `SELECT user_id, COUNT(*) n FROM item_events
     WHERE kind = 'created' AND at > now() - interval '24 hours'
     GROUP BY user_id ORDER BY COUNT(*) DESC`);
  if (perUser.length >= 5) {
    const counts = perUser.map((r) => Number(r.n)).sort((a, b) => a - b);
    const med = counts[counts.length >> 1] ?? 0;
    // Медиана, а не среднее: среднее сдвигают сами нарушители (то же правило, что в Ф3.3).
    const loud = perUser.filter((r) => med > 0 && Number(r.n) >= med * 5);
    if (loud.length) {
      add('loot-outlier', 'attention', `добыча выше медианы впятеро (медиана ${med} вещей за сутки)`,
        loud.map((r) => `${r.user_id}: ${r.n} вещей`));
    }
  }

  // ── 6. Кластер: закрепления за узлами, которых больше нет ───────────────────
  const stale = await q<{ char_id: string; node_id: string }>(
    `SELECT c.char_id, c.node_id FROM char_claims c
     WHERE NOT EXISTS (SELECT 1 FROM cluster_nodes n WHERE n.id = c.node_id)
       AND c.touched_at > now() - interval '10 minutes'
     LIMIT 20`);
  if (stale.length) {
    add('stale-claim', 'attention', 'персонажи закреплены за исчезнувшими узлами',
      stale.map((r) => `${r.char_id} → ${r.node_id}`));
  }

  // ── 7. Справочно ────────────────────────────────────────────────────────────
  const backs = Number((await q1<{ n: string }>(`SELECT COUNT(*) n FROM item_events WHERE from_loc = 'world'`))?.n ?? 0);
  const revoked = Number((await q1<{ n: string }>('SELECT COUNT(*) n FROM items WHERE loc = $1', [LOC_REVOKED]))?.n ?? 0);
  add('info', 'info', 'справочно', [
    `возвратов из мира (подбор своего дропа): ${backs}`,
    `отозванных вещей: ${revoked}`,
    `персонажей: ${chars.length}, сундуков: ${stashes.length}`,
  ]);

  const incidents = findings.filter((f) => f.severity === 'incident').reduce((a, f) => a + f.count, 0);
  return { at: new Date(), items, events, findings, incidents };
}

/** Человеческий отчёт — один и тот же для консоли и для лога ночной задачи. */
export function formatAudit(r: AuditResult): string {
  const out: string[] = [];
  out.push(`АУДИТ ИНВАРИАНТОВ · вещей в леджере ${r.items}, записей в журнале ${r.events}`);
  const mark = { incident: '✗', attention: '⚠', info: '·' };
  for (const f of r.findings) {
    out.push(`  ${mark[f.severity]} ${f.title}${f.severity === 'info' ? '' : `: ${f.count}`}`);
    for (const e of f.examples) out.push(`      ${e}`);
    if (f.count > f.examples.length) out.push(`      … и ещё ${f.count - f.examples.length}`);
  }
  if (!r.findings.some((f) => f.severity === 'incident')) out.push('  ✓ инцидентов нет');
  return out.join('\n');
}

/** Сохранить прогон: без истории «ноль нарушений» ничего не значит — не с чем сравнить. */
export async function saveAuditRun(r: AuditResult): Promise<void> {
  await q(
    `INSERT INTO audit_runs (at, items, events, incidents, findings) VALUES (now(), $1, $2, $3, $4)`,
    [r.items, r.events, r.incidents, JSON.stringify(r.findings)]);
}
