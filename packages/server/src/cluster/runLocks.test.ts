import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * ⭐ V2: ЗАБЕГ — ЗА ОДНОЙ НОДОЙ КЛАСТЕРА (`run_locks`) — против НАСТОЯЩЕЙ базы: здесь проверяется ровно SQL. Без базы тест пропускается —
 * `DM_PG_TEST` или локальный PostgreSQL на 5432 (`dungeon_test`), схема — своя на файл (`db/testDb.ts`).
 *
 * Внутри ноды забег держит одна комната (`RoomManager.runRooms`), какая нода — решает база: взять можно свободный, свой (любой комнатой
 * своей ноды) и забег ноды, которая его больше не держит (мертва или давно не подтверждала — правило держания закрепления героя,
 * `claimRule.ts`); чужой живой — отказ с кодом комнаты-держателя.
 */
const tdb = await vi.hoisted(async () => (await import('../db/testDb.js')).testDb('runlocks'));

let reg: typeof import('./registry.js');
let pool: typeof import('../db/pool.js');
let alive = false;
const tag = `t${Date.now().toString(36)}`;
const nodeA = `${tag}-a`, nodeB = `${tag}-b`, nodeDead = `${tag}-dead`;
const beat = { players: 0, rooms: 0, cpuSeconds: 0, rssBytes: 0, loopP99: 0, tickHz: 0, draining: false };
let seq = 0;
const run = (): string => `id:${tag}-r${++seq}`;
const holder = async (key: string): Promise<{ node_id: string; room: string } | null> =>
  pool.q1<{ node_id: string; room: string }>('SELECT node_id, room FROM run_locks WHERE run_key = $1', [key]);

beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('../db/pool.js');
  reg = await import('./registry.js');
  if (!alive) return;   // базы нет — тесты ниже пропустятся
  await reg.initClusterSchema();
  await reg.heartbeat(nodeA, 'ws://a', beat);
  await reg.heartbeat(nodeB, 'ws://b', beat);
  await reg.heartbeat(nodeDead, 'ws://dead', beat);
  await pool.q(`UPDATE cluster_nodes SET beat_at = now() - interval '1 hour' WHERE id = $1`, [nodeDead]);
});
afterAll(async () => {
  if (!alive) return;
  await pool.closePool();
  await tdb.drop();
});

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ V2: забег за нодой кластера', () => {
  it('свободный и свой — наш (своя нода — любой комнатой); чужой живой — отказ с кодом комнаты-держателя', async () => {
    if (!alive) return;
    const k = run();
    expect(await reg.claimRun(k, nodeA, 'AAAA1'), 'свободный — наш').toBeNull();
    expect(await reg.claimRun(k, nodeA, 'AAAA2'), 'своя нода — наш (комнату решает нода)').toBeNull();
    expect(await holder(k)).toEqual({ node_id: nodeA, room: 'AAAA2' });
    expect(await reg.claimRun(k, nodeB, 'BBBB1'), 'чужой живой — отказ').toBe('AAAA2');
    expect(await holder(k), 'отказ строку не тронул').toEqual({ node_id: nodeA, room: 'AAAA2' });
  });

  it('нода-держатель мертва или давно не подтверждала забег — он переходит', async () => {
    if (!alive) return;
    const d = run();
    await pool.q(`INSERT INTO run_locks (run_key, node_id, room, live_at) VALUES ($1, $2, 'DDDD1', now())`, [d, nodeDead]);
    expect(await reg.claimRun(d, nodeB, 'BBBB2'), 'нода молчит — забег переходит').toBeNull();
    expect(await holder(d)).toEqual({ node_id: nodeB, room: 'BBBB2' });
    const idle = run();
    await pool.q(`INSERT INTO run_locks (run_key, node_id, room, live_at) VALUES ($1, $2, 'AAAA3', now() - interval '5 minutes')`, [idle, nodeA]);
    expect(await reg.claimRun(idle, nodeB, 'BBBB3'), 'нода жива, но забег не подтверждает — его у неё нет').toBeNull();
  });

  it('сердцебиение продлевает свои забеги, восстанавливает снятую строку и не перехватывает чужую — чужой в ответе нет', async () => {
    if (!alive) return;
    const mine = run(), gone = run(), foreign = run();
    await reg.claimRun(mine, nodeA, 'AAAA4');
    await pool.q(`UPDATE run_locks SET live_at = now() - interval '20 seconds' WHERE run_key = $1`, [mine]);
    await reg.claimRun(foreign, nodeB, 'BBBB4');
    const kept = await reg.touchRuns([{ key: mine, room: 'AAAA5' }, { key: gone, room: 'AAAA6' }, { key: foreign, room: 'AAAA7' }], nodeA);
    expect([...kept].sort()).toEqual([gone, mine].sort());
    expect(await holder(mine), 'продлён — и за комнатой, что держит сейчас').toEqual({ node_id: nodeA, room: 'AAAA5' });
    const age = await pool.q1<{ age: number }>(`SELECT extract(epoch FROM now() - live_at)::int AS age FROM run_locks WHERE run_key = $1`, [mine]);
    expect(age!.age).toBeLessThan(5);
    expect(await holder(gone), 'снятая строка восстановлена').toEqual({ node_id: nodeA, room: 'AAAA6' });
    expect(await holder(foreign), 'чужая не перехвачена').toEqual({ node_id: nodeB, room: 'BBBB4' });
  });

  it('⭐ R15-08: комната отпустила забег, пока удар продлевал снимок, — продление вставило строку заново, повторный отпуск (`runsGone`) её снимает: забег свободен другой ноде', async () => {
    if (!alive) return;
    const k = run();
    expect(await reg.claimRun(k, nodeA, 'AROOM')).toBeNull();
    const snapshot = [{ key: k, room: 'AROOM' }];   // `heldRuns` удара
    await reg.releaseRun(k, nodeA, 'AROOM');         // комната ушла — её отпуск лёг раньше продления
    const kept = await reg.touchRuns(snapshot, nodeA);
    expect(kept.has(k), 'продление вставило строку ушедшей комнаты заново').toBe(true);
    expect(await reg.claimRun(k, nodeB, 'BROOM'), 'без повторного отпуска — «идёт в комнате AROOM»').toBe('AROOM');
    await reg.releaseRun(k, nodeA, 'AROOM');         // ⭐ R15-08: нода отпускает его снова (`RoomManager.releaseRuns`)
    expect(await reg.claimRun(k, nodeB, 'BROOM'), 'забег свободен').toBeNull();
  });

  it('снятие — только своей строки и только за той комнатой; старт ноды и её уход снимают все её забеги', async () => {
    if (!alive) return;
    const k = run();
    await reg.claimRun(k, nodeA, 'AAAA8');
    await reg.releaseRun(k, nodeB, 'AAAA8');
    await reg.releaseRun(k, nodeA, 'AAAA9');
    expect(await holder(k), 'чужая нода и другая комната не снимают').toEqual({ node_id: nodeA, room: 'AAAA8' });
    await reg.releaseRun(k, nodeA, 'AAAA8');
    expect(await holder(k)).toBeNull();

    const n = `${tag}-n`;
    await reg.heartbeat(n, 'ws://n', beat);
    const [x, y] = [run(), run()];
    await reg.claimRun(x, n, 'NNNN1');
    await reg.claimRun(y, n, 'NNNN2');
    expect(await reg.releaseNodeRuns(n), 'старт ноды — хвосты прошлого процесса').toBe(2);
    expect(await holder(x)).toBeNull();
    await reg.claimRun(x, n, 'NNNN3');
    await reg.releaseNode(n);
    expect(await holder(x), 'штатный уход ноды').toBeNull();
  });
});
