import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

/**
 * ⭐ R6-18: СХЕМА ПРИМЕНЯЕТСЯ НЕ ПОД ПОТОЛКАМИ ПУЛА. Консультативную блокировку схемы и сами части схемы брало соединение
 * пула, а у него `statement_timeout` 10 с (параметр старта соединения) и `query_timeout` 15 с. Деплой с правкой схемы:
 * супервизор поднимает гейтвей и ноды разом, первый держит блокировку, пока ждёт занятую таблицу (до ~20 с), — остальные
 * через 10 с получают 57014 на `pg_advisory_lock` и падают кругом перезапусков; а часть схемы дольше 10 с (индекс по
 * растущему журналу вещей) не применяется никогда — ни одна нода, ни одиночный процесс не поднимаются.
 *
 * Против НАСТОЯЩЕЙ базы `dungeon_test` в своей схеме (как `items.test.ts`, см. `testDb.ts`); без базы тест пропускается.
 * Ключи блокировок — свои (не ключ схемы): консультативные блокировки — на всю базу, соседние файлы поднимают схему в то же
 * время, и держать её ключ дольше их потолка ожидания хука нельзя.
 */
const tdb = await vi.hoisted(async () => (await import('./testDb.js')).testDb('poolschema'));

type SchemaApi = { withSchemaLock?: (key: number, fn: (c: pg.ClientBase) => Promise<void>) => Promise<void> };
let pool: typeof import('./pool.js');
let alive = false;
beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('./pool.js');
  if (alive) await pool.initSchema();
});
afterAll(async () => { if (alive) { await pool.closePool(); await tdb.drop(); } });

const KEY_WAIT = 947_213_091;
const KEY_SLOW = 947_213_092;

describe.runIf(process.env.DM_SKIP_PG !== '1')('схема не под потолками пула (R6-18)', () => {
  it('⭐ блокировку схемы держит другой процесс — ждём его, а не падаем; своё соединение схемы без потолка запроса', async () => {
    if (!alive) return;
    const { withSchemaLock } = pool as unknown as SchemaApi;
    expect(withSchemaLock, 'схема — на своём соединении под своей блокировкой').toBeTypeOf('function');
    const holder = new pg.Client({ connectionString: process.env.DM_PG });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [KEY_WAIT]);
      let seen = '';
      const t0 = Date.now();
      const waiting = withSchemaLock!(KEY_WAIT, async (c) => {
        seen = (await c.query<{ statement_timeout: string }>('SHOW statement_timeout')).rows[0]!.statement_timeout;
      });
      await new Promise((r) => setTimeout(r, 1500));
      await holder.query('SELECT pg_advisory_unlock($1)', [KEY_WAIT]);
      await waiting;
      expect(Date.now() - t0, 'дождался держателя').toBeGreaterThanOrEqual(1400);
      expect(seen, 'потолка запроса у соединения схемы нет').toBe('0');
    } finally { await holder.end(); }
  });

  it('⭐ часть схемы дольше потолка запроса пула (10 с) применяется и помечается', async () => {
    if (!alive) return;
    const { withSchemaLock } = pool as unknown as SchemaApi;
    expect(withSchemaLock).toBeTypeOf('function');
    const name = `r618-${Date.now().toString(36)}`;
    try {
      await withSchemaLock!(KEY_SLOW, (c) => pool.applySchema(c as pg.PoolClient, name, ['SELECT pg_sleep(10.5)']));
      const rows = await pool.q<{ hash: string }>('SELECT hash FROM schema_marks WHERE name = $1', [name]);
      expect(rows, 'отпечаток записан').toHaveLength(1);
    } finally {
      await pool.q('DELETE FROM schema_marks WHERE name = $1', [name]);
    }
  }, 30_000);
});
