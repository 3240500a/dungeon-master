import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, uuidv7, type SaveState } from '@dm/shared';

/**
 * ⭐ R8-06: СБРОС ЗАБЕГОВ НА СТАРТЕ НОДЫ — ПО ТОМУ ЖЕ ПРАВИЛУ ВЛАДЕНИЯ, ЧТО И ВХОД (`claimForJoin`, R7-09). Сброс щадил только
 * героев ноды, ударившей сердцем за последние 10 с, а вход признаёт ноду живой 120 с: база легла на 10–120 с, нода B стартовала
 * в этом окне — и снимала забег и поднимала версию героям, которых вход всё ещё отдавал ноде A. Её живые сессии потом получали
 * отказ по версии (массовый 4009), а недописанная прощальная копия — «конфликт», то есть «записано»: копия пропадала молча, и
 * вещь, уже поднятая соседом по аккаунту, оставалась у двоих. Против НАСТОЯЩЕЙ базы (`dungeon_test`, своя схема файла).
 *
 * ⚠ Адрес базы — в `vi.hoisted`, до импортов (см. `registry.test.ts`).
 */
const tdb = await vi.hoisted(async () => (await import('../db/testDb.js')).testDb('registryr8'));

let reg: typeof import('./registry.js');
let pool: typeof import('../db/pool.js');
let db: typeof import('../db/db.js');
let cfg: ConfigRegistry;
let alive = false;
const tag = `r8${Date.now().toString(36)}`;
const nodeB = `${tag}-b`;
const beat = { players: 0, rooms: 0, cpuSeconds: 0, rssBytes: 0, loopP99: 0, tickHz: 0, draining: false };
let seq = 0;

/** Нода `id` последний раз подала признак жизни `sec` секунд назад (строки нет — заводится). */
async function beatAgo(id: string, sec: number): Promise<void> {
  await reg.heartbeat(id, `ws://${id}`, beat);
  await pool.q(`UPDATE cluster_nodes SET beat_at = now() - ($2 || ' seconds')::interval WHERE id = $1`, [id, String(sec)]);
}
/** Закрепление героя за нодой, которое она последний раз продлила `sec` секунд назад (`live` — нет: закрепление маршрута). */
async function claimAgo(charId: string, node: string, sec: number, live = true): Promise<void> {
  await pool.q(`INSERT INTO char_claims (char_id, node_id, touched_at, live_at)
                VALUES ($1, $2, now() - ($3 || ' seconds')::interval, CASE WHEN $4 THEN now() - ($3 || ' seconds')::interval END)`,
  [charId, node, String(sec), live]);
}
/** Герой с припаркованным забегом в «базе»; версия сейва — 2. */
async function heroWithRun(): Promise<string> {
  const userId = await db.createUser(`t_${uuidv7().slice(-12)}`, 'h', 's');
  const charId = uuidv7();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, `R8-${++seq}`, charId) as SaveState;
  await db.createCharacter(charId, userId, save);
  save.run = { templateId: 't', config: { templateId: 't', biomeId: 'b', tier: 'normal', seed: 1, modifiers: [] }, currentNodeId: 'start', visited: [] } as unknown as SaveState['run'];
  expect(await db.putCharacter(charId, userId, save, 1)).toBe(2);
  return charId;
}
async function stateOf(charId: string): Promise<{ version: number; run: boolean }> {
  const row = (await db.getCharacter(charId))!;
  return { version: row.version, run: !!row.data.run };
}

beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('../db/pool.js');
  if (!alive) return;   // базы нет — тесты ниже пропустятся
  await pool.initSchema();
  reg = await import('./registry.js');
  await reg.initClusterSchema();
  db = await import('../db/db.js');
  cfg = new ConfigRegistry();
  cfg.loadAll();
  await reg.heartbeat(nodeB, 'ws://b', beat);
});
afterAll(async () => {
  if (!alive) return;
  await pool.closePool();
  await tdb.drop();
});

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ R8-06: сброс забегов на старте ноды щадит героев, которых вход отдаёт другой ноде', () => {
  it('нода A молчит 30 с (база лежала), держала героя на последнем ударе — вход на B отказан, и сброс его не трогает', async () => {
    if (!alive) return;
    const a = `${tag}-a30`;
    const c = await heroWithRun();
    await beatAgo(a, 30);
    await claimAgo(c, a, 31);
    expect(await reg.claimForJoin(c, nodeB), 'вход признаёт героя ноды A').toBe(a);
    await db.clearAllRuns(nodeB);
    expect(await stateOf(c), 'забег и версия целы').toEqual({ version: 2, run: true });
  });

  it('A молчит 110 с (почти срок смерти) — то же', async () => {
    if (!alive) return;
    const a = `${tag}-a110`;
    const c = await heroWithRun();
    await beatAgo(a, 110);
    await claimAgo(c, a, 110);
    await db.clearAllRuns(nodeB);
    expect(await stateOf(c)).toEqual({ version: 2, run: true });
  });

  it('контроль: A молчит дольше срока смерти — забег сброшен (как и вход его отдаёт)', async () => {
    if (!alive) return;
    const a = `${tag}-dead`;
    const c = await heroWithRun();
    await beatAgo(a, 600);
    await claimAgo(c, a, 600);
    expect(await reg.claimForJoin(c, `${tag}-probe`), 'вход забирает героя мёртвой ноды').toBe(`${tag}-probe`);
    await pool.q('DELETE FROM char_claims WHERE char_id = $1', [c]);
    await claimAgo(c, a, 600);
    await db.clearAllRuns(nodeB);
    expect(await stateOf(c)).toEqual({ version: 3, run: false });
  });

  it('контроль: A молчит 30 с, а героя не продлевала задолго до того (вышел раньше) — забег сброшен', async () => {
    if (!alive) return;
    const a = `${tag}-quiet`;
    const c = await heroWithRun();
    await beatAgo(a, 30);
    await claimAgo(c, a, 120);
    await db.clearAllRuns(nodeB);
    expect(await stateOf(c)).toEqual({ version: 3, run: false });
  });

  it('контроль R2-11: живая нода (удар только что) — щадится и закрепление маршрута; ничей и свой прежний — сбрасываются', async () => {
    if (!alive) return;
    const a = `${tag}-live`;
    const routed = await heroWithRun(), nobody = await heroWithRun(), mine = await heroWithRun();
    await beatAgo(a, 0);
    await claimAgo(routed, a, 5, false);
    await claimAgo(mine, nodeB, 0);
    await db.clearAllRuns(nodeB);
    expect(await stateOf(routed), 'маршрут гейтвея к живой ноде').toEqual({ version: 2, run: true });
    expect(await stateOf(nobody)).toEqual({ version: 3, run: false });
    expect(await stateOf(mine), 'свой хвост с прошлого запуска').toEqual({ version: 3, run: false });
  });
});
