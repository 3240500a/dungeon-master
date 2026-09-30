import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * ⭐ E2E 30.09 (седьмой прогон): СНИМОК СЧЁТЧИКОВ НОДЫ — В СТРОКЕ РЕЕСТРА (`cluster_nodes.counters`), против НАСТОЯЩЕЙ базы: удар сердца его
 * пишет (и вставкой, и продлением с арендой), `liveNodes` отдаёт гейтвею — тот складывает метрики кластера (`gateway.metrics.test.ts`). Удар без
 * снимка (нода старше правки в катящемся обновлении) прежний снимок не затирает. Схема — своя на файл (`db/testDb.ts`).
 */
const tdb = await vi.hoisted(async () => (await import('../db/testDb.js')).testDb('regcounters'));

let reg: typeof import('./registry.js');
let pool: typeof import('../db/pool.js');
let alive = false;
const beat = { players: 0, rooms: 0, cpuSeconds: 0, rssBytes: 0, loopP99: 0, tickHz: 0, draining: false };

beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('../db/pool.js');
  reg = await import('./registry.js');
  if (!alive) return;
  await reg.initClusterSchema();
});
afterAll(async () => {
  if (!alive) return;
  await pool.closePool();
  await tdb.drop();
});

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ E2E 30.09: счётчики ноды в реестре', () => {
  it('удар пишет снимок, продление с арендой — тоже; удар без снимка его не затирает', async () => {
    if (!alive) return;
    const counters = { boot: 'p1', values: { dm_write_foreign_total: 2, dm_save_conflicts_total: 0 } };
    await reg.heartbeat('node-k', 'ws://k', { ...beat, counters });
    let row = (await reg.liveNodes()).find((n) => n.id === 'node-k');
    expect(row?.counters).toEqual(counters);
    const next = { boot: 'p1', values: { dm_write_foreign_total: 3, dm_save_conflicts_total: 1 } };
    expect(await reg.heartbeat('node-k', 'ws://k', { ...beat, counters: next }, true), 'продление с арендой легло').toBe(true);
    row = (await reg.liveNodes()).find((n) => n.id === 'node-k');
    expect(row?.counters).toEqual(next);
    await reg.heartbeat('node-k', 'ws://k', beat);
    await reg.heartbeat('node-k', 'ws://k', beat, true);
    row = (await reg.liveNodes()).find((n) => n.id === 'node-k');
    expect(row?.counters, 'удар ноды старше правки снимок не затёр').toEqual(next);
  });
});
