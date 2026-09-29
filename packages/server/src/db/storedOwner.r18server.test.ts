import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, uuidv7, type SaveState } from '@dm/shared';

/**
 * ⭐ R18-03: ЗАПИСЬ ПО СТРОКЕ БАЗЫ — ТОЛЬКО ПОКА ГЕРОЯ ДЕРЖИТ ЭТА НОДА (`putCharacterOwned`) — против НАСТОЯЩЕЙ базы: проверяется ровно SQL
 * (владение и запись — одним запросом). Без базы тест пропускается — `DM_PG_TEST` или локальный PostgreSQL на 5432 (`dungeon_test`), схема —
 * своя на файл (`testDb.ts`).
 */
const tdb = await vi.hoisted(async () => (await import('./testDb.js')).testDb('storedown'));

let db: typeof import('./db.js');
let pool: typeof import('./pool.js');
let reg: typeof import('../cluster/registry.js');
let alive = false;
let cfg: ConfigRegistry;
const tag = `t${Date.now().toString(36)}`;
const nodeA = `${tag}-a`, nodeB = `${tag}-b`;
const beat = { players: 0, rooms: 0, cpuSeconds: 0, rssBytes: 0, loopP99: 0, tickHz: 0, draining: false };

beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('./pool.js');
  if (!alive) return;   // базы нет — тесты ниже пропустятся
  await pool.initSchema();
  reg = await import('../cluster/registry.js');
  await reg.initClusterSchema();
  db = await import('./db.js');
  cfg = new ConfigRegistry();
  cfg.loadAll();
  await reg.heartbeat(nodeA, 'ws://a', beat);
  await reg.heartbeat(nodeB, 'ws://b', beat);
});
afterAll(async () => { if (alive) { await pool.closePool(); await tdb.drop(); } });

async function freshChar(): Promise<{ userId: string; charId: string; save: SaveState }> {
  const userId = await db.createUser(`t_${uuidv7().slice(-12)}`, 'h', 's');
  const charId = uuidv7();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Тест', charId);
  await db.createCharacter(charId, userId, save);
  return { userId, charId, save };
}
const gold = async (charId: string): Promise<{ gold: number; version: number }> => {
  const r = (await db.getCharacter(charId))!;
  return { gold: r.data.gold, version: r.version };
};

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ R18-03: запись по строке базы — с проверкой владения тем же запросом', () => {
  it('закрепление за этой нодой — пишет (новая версия); за другой — `foreign`, строка не тронута', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    expect(await reg.claimForJoin(charId, nodeA)).toBe(nodeA);
    save.gold = 111;
    expect(await db.putCharacterOwned(charId, userId, save, 1, { node: nodeA, leased: true }), 'своя нода').toBe(2);
    expect(await gold(charId)).toEqual({ gold: 111, version: 2 });
    // Героя забрала нода B (нода A «мертва» по реестру — её удар давно не приходил).
    await pool.q(`UPDATE cluster_nodes SET beat_at = now() - interval '1 hour' WHERE id = $1`, [nodeA]);
    expect(await reg.claimForJoin(charId, nodeB)).toBe(nodeB);
    await reg.heartbeat(nodeA, 'ws://a', beat);   // A «оттаяла» и снова бьётся — но героя уже держит B
    save.gold = 0;
    expect(await db.putCharacterOwned(charId, userId, save, 2, { node: nodeA, leased: true }), 'чужая нода').toBe('foreign');
    expect(await gold(charId), 'строка не тронута').toEqual({ gold: 111, version: 2 });
    // Своя нода, но версия ушла — обычный отказ по версии (`null`), не «чужой».
    expect(await db.putCharacterOwned(charId, userId, save, 1, { node: nodeB, leased: true })).toBeNull();
  });

  it('нода с арендой, чей удар реестр не видел дольше аренды, — `foreign` (без аренды — пишет: одиночный процесс)', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    const nodeC = `${tag}-c`;
    await reg.heartbeat(nodeC, 'ws://c', beat);
    expect(await reg.claimForJoin(charId, nodeC)).toBe(nodeC);
    await pool.q(`UPDATE cluster_nodes SET beat_at = now() - interval '10 minutes' WHERE id = $1`, [nodeC]);
    save.gold = 5;
    expect(await db.putCharacterOwned(charId, userId, save, 1, { node: nodeC, leased: true }), 'аренда кончилась').toBe('foreign');
    expect(await gold(charId), 'строка не тронута').toMatchObject({ version: 1 });
    expect(await db.putCharacterOwned(charId, userId, save, 1, { node: nodeC, leased: false }), 'одиночный процесс').toBe(2);
  });

  it('сейв и сундук одной записью (`putCharacterWithStash` с `owner`): героя держит другая нода — `foreign`, не записано ни то, ни другое', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    expect(await reg.claimForJoin(charId, nodeB)).toBe(nodeB);
    const stash = { tabs: [[]] } as unknown as import('@dm/shared').AccountStash;
    save.gold = 7;
    expect(await db.putCharacterWithStash(charId, userId, save, 1, stash, 0, 'stash', undefined, { node: nodeA, leased: true }))
      .toEqual({ ok: false, conflict: 'foreign' });
    expect(await gold(charId), 'строка не тронута').toMatchObject({ version: 1 });
    expect(await db.getAccountStash(userId), 'сундук не заведён').toBeNull();
    const ok = await db.putCharacterWithStash(charId, userId, save, 1, stash, 0, 'stash', undefined, { node: nodeB, leased: true });
    expect(ok, 'своя нода').toMatchObject({ ok: true, version: 2, stashVersion: 1 });
    expect(await db.putCharacterWithStash(charId, userId, save, 2, stash, 1, 'stash'), 'без `owner` — как прежде').toMatchObject({ ok: true, version: 3 });
  });

  it('закрепления нет вовсе — `foreign`', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    expect(await db.putCharacterOwned(charId, userId, save, 1, { node: nodeA, leased: false })).toBe('foreign');
  });
});
