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
