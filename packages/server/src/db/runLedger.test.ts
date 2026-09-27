import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { RunNodeState } from '@dm/shared';

/**
 * ⭐ R9-01: СВОД ЗАПИСЕЙ ЗАБЕГА В БАЗЕ (`run_ledger`). Что взято на узле, принадлежит забегу: запись только добавляет (списки —
 * объединением, мощь — первой записи), две комнаты одного забега пишут строку узла одновременно и не теряют ни одной записи,
 * старое чистится по сроку. Против НАСТОЯЩЕЙ базы `dungeon_test` в своей схеме (`testDb.ts`); без базы тест пропускается.
 */
const tdb = await vi.hoisted(async () => (await import('./testDb.js')).testDb('runledger'));

let db: typeof import('./db.js');
let pool: typeof import('./pool.js');
let alive = false;
beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('./pool.js');
  db = await import('./db.js');
  if (alive) await pool.initSchema();
});
afterAll(async () => { if (alive) { await pool.closePool(); await tdb.drop(); } });

const rec = (id: string, el: number, chests: number[], killed: number[] = [], levers: number[] = []): RunNodeState => ({ id, el, chests, killed, levers });

/**
 * R10-13: дождаться, пока ровно `n` сеансов ЭТОГО файла (свои — по `application_name`, `testDb.ts`) ждут блокировку, у каждого
 * есть кто-то, кто её держит, и никого не держит `not` (держатель, уже отпустивший строку). Ждём состояние базы, а не часы.
 */
async function lockWaiters(n: number, not?: number, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const rows = await pool.q<{ by: number[] }>(
      `SELECT pg_blocking_pids(pid) AS by FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = current_setting('application_name')
         AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (rows.length === n && rows.every((r) => r.by.length > 0 && (not === undefined || !r.by.includes(not)))) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ R9-01: свод записей забега в базе', () => {
  it('запись только добавляет: объединение списков, мощь — первой записи; чужой забег не видит', async () => {
    if (!alive) return;
    await db.mergeRunLedger('id:run-a', [rec('n1_0', 12, [3, 1], [0, 5]), rec('n2_0', 14, [], [2])]);
    await db.mergeRunLedger('id:run-a', [rec('n1_0', 99, [2], [5, 7], [4])]);
    await db.mergeRunLedger('id:run-b', [rec('n1_0', 1, [9])]);
    const a = await db.getRunLedger('id:run-a');
    expect(a).toEqual([rec('n1_0', 12, [1, 2, 3], [0, 5, 7], [4]), rec('n2_0', 14, [], [2])]);
    expect(await db.getRunLedger('id:run-b')).toEqual([rec('n1_0', 1, [9])]);
    expect(await db.getRunLedger('id:none')).toEqual([]);
  });

  it('две комнаты пишут строку одного узла одновременно — объединение не теряет ни одной записи', async () => {
    if (!alive) return;
    await Promise.all(Array.from({ length: 20 }, (_, i) => db.mergeRunLedger('id:race', [rec('n3_1', 20, [i], [100 + i])])));
    const [row] = await db.getRunLedger('id:race');
    expect(row!.chests).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(row!.killed).toEqual(Array.from({ length: 20 }, (_, i) => 100 + i));
  });

  it('⭐ R10-13: две комнаты пишут ОДНИ И ТЕ ЖЕ узлы в разном порядке — без взаимоблокировки (40P01), обе записи легли', async () => {
    if (!alive) return;
    const key = 'id:r10-order';
    await db.mergeRunLedger(key, [rec('n1_0', 5, [], [1]), rec('n2_0', 5, [], [1])]);
    // Держатели строк (как «другая комната уже на этой строке») задают переплетение: без них гонка — лотерея таймингов.
    const h1 = await pool.pool.connect(), h2 = await pool.pool.connect();
    try {
      const pidOf = async (c: typeof h1): Promise<number> => (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
      const p1 = await pidOf(h1);
      await h1.query('BEGIN'); await h1.query(`SELECT 1 FROM run_ledger WHERE run_key = $1 AND node_id = 'n1_0' FOR UPDATE`, [key]);
      await h2.query('BEGIN'); await h2.query(`SELECT 1 FROM run_ledger WHERE run_key = $1 AND node_id = 'n2_0' FOR UPDATE`, [key]);
      // Комната A снимает свод в порядке [n1, n2], комната B — [n2, n1] (порядок `ledgerDirty` у каждой свой).
      const a = db.mergeRunLedger(key, [rec('n1_0', 5, [], [2]), rec('n2_0', 5, [], [2])]).then(() => 'ok', (e: { code?: string }) => e.code ?? 'err');
      const b = db.mergeRunLedger(key, [rec('n2_0', 5, [], [3]), rec('n1_0', 5, [], [3])]).then(() => 'ok', (e: { code?: string }) => e.code ?? 'err');
      expect(await lockWaiters(2), 'обе записи ждут строки').toBe(true);
      await h1.query('COMMIT');                      // n1 свободна: её берёт первый в очереди и идёт к n2
      expect(await lockWaiters(2, p1), 'обе снова ждут — уже не держателя n1').toBe(true);
      await h2.query('COMMIT');
      expect([await a, await b], 'обе легли (раньше вторая — 40P01, повтор через 5 с)').toEqual(['ok', 'ok']);
    } finally { h1.release(); h2.release(); }
    const rows = await db.getRunLedger(key);
    expect(rows.map((r) => [r.id, r.killed])).toEqual([['n1_0', [1, 2, 3]], ['n2_0', [1, 2, 3]]]);
  });

  it('номер вне `integer` (порча) не роняет запись свода — отбрасывается; старое чистится по сроку', async () => {
    if (!alive) return;
    await db.mergeRunLedger('id:odd', [rec('n1_0', 5, [1, 2 ** 40], [3])]);
    expect(await db.getRunLedger('id:odd')).toEqual([rec('n1_0', 5, [1], [3])]);
    await pool.q(`UPDATE run_ledger SET updated_at = now() - interval '8 days' WHERE run_key = 'id:odd'`);
    expect(await db.sweepRunLedger(7)).toBe(1);
    expect(await db.getRunLedger('id:odd')).toEqual([]);
    expect((await db.getRunLedger('id:run-a')).length, 'свежее не тронуто').toBe(2);
  });
});
