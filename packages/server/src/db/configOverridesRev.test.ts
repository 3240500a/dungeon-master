import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * ⭐ R16 C-02, C-08: РЕВИЗИЯ ОВЕРРАЙДОВ КОНФИГА (`getConfigOverridesRev`) — по ней процессы кластера узнают, что конфиг правили в другом процессе
 * (`configSync.ts`). Сдвигается с каждой записью и удалением — и с правкой мимо сервера, не тронувшей `updated_at` (`db:repair`, SQL); без правок
 * — та же. Против НАСТОЯЩЕЙ базы `dungeon_test` в своей схеме (`testDb.ts`); без базы тест пропускается.
 */
const tdb = await vi.hoisted(async () => (await import('./testDb.js')).testDb('cfgrev'));

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

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ R16 C-02: ревизия оверрайдов конфига в базе', () => {
  it('запись, повтор той же записи, правка мимо сервера и удаление — каждый раз другая; без правок — та же', async () => {
    if (!alive) return;
    const r0 = await db.getConfigOverridesRev();
    expect(await db.getConfigOverridesRev(), 'без правок — та же').toBe(r0);
    await db.setConfigOverride('environment', [{ id: 'crypt' }]);
    const r1 = await db.getConfigOverridesRev();
    expect(r1).not.toBe(r0);
    await db.setConfigOverride('environment', [{ id: 'crypt' }]);
    const r2 = await db.getConfigOverridesRev();
    expect(r2, 'повтор записи — тоже правка').not.toBe(r1);
    await pool.q(`UPDATE config_overrides SET json = '[{"id":"crypt","fade":{"start":1}}]'::jsonb WHERE key = 'environment'`);
    const r3 = await db.getConfigOverridesRev();
    expect(r3, 'правка SQL без `updated_at`').not.toBe(r2);
    expect(await db.getConfigOverridesRev()).toBe(r3);
    await db.deleteConfigOverride('environment');
    expect(await db.getConfigOverridesRev(), 'удаление').not.toBe(r3);
  });
});
