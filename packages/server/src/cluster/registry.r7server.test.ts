import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * ⭐ R7-09: ЗАКРЕПЛЕНИЕ НЕ УХОДИТ ОТ НОДЫ, КОТОРАЯ ЛИШЬ НЕНАДОЛГО ЗАМОЛЧАЛА. База лежала 10 с и дольше (рестарт, переключение),
 * сердцебиение ноды A не проходило — и первый же вход героя на ноду B в окне «база встала, A ещё не ударила» забирал его
 * закрепление: B читала сейв ДО того, что A держала недописанной копией (вещь, отданная соседу по аккаунту), а A потом
 * забывала копию (R6-06) — вещь у двоих. Против НАСТОЯЩЕЙ базы (`dungeon_test`, своя схема файла): здесь проверяется SQL.
 *
 * ⚠ Адрес базы — в `vi.hoisted`, до импортов (см. `registry.test.ts`).
 */
const tdb = await vi.hoisted(async () => (await import('../db/testDb.js')).testDb('registryr7'));

let reg: typeof import('./registry.js');
let pool: typeof import('../db/pool.js');
let alive = false;
const tag = `r7${Date.now().toString(36)}`;
const nodeA = `${tag}-a`, nodeB = `${tag}-b`;
const beat = { players: 0, rooms: 0, cpuSeconds: 0, rssBytes: 0, loopP99: 0, tickHz: 0, draining: false };
let seq = 0;
const char = (): string => `${tag}-c${++seq}`;
const ownerOf = async (charId: string): Promise<string | null> =>
  (await pool.q1<{ node_id: string }>('SELECT node_id FROM char_claims WHERE char_id = $1', [charId]))?.node_id ?? null;
/** Нода `id` последний раз подала признак жизни `sec` секунд назад (строки нет — заводится). */
async function beatAgo(id: string, sec: number): Promise<void> {
  await reg.heartbeat(id, `ws://${id}`, beat);
  await pool.q(`UPDATE cluster_nodes SET beat_at = now() - ($2 || ' seconds')::interval WHERE id = $1`, [id, String(sec)]);
}
/** Живое закрепление героя за нодой, которое она последний раз продлила `sec` секунд назад. */
async function liveAgo(charId: string, node: string, sec: number): Promise<void> {
  await pool.q(`INSERT INTO char_claims (char_id, node_id, touched_at, live_at)
                VALUES ($1, $2, now() - ($3 || ' seconds')::interval, now() - ($3 || ' seconds')::interval)`, [charId, node, String(sec)]);
}

beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('../db/pool.js');
  reg = await import('./registry.js');
  if (!alive) return;   // базы нет — тесты ниже пропустятся
  await reg.initClusterSchema();
  await reg.heartbeat(nodeB, 'ws://b', beat);
});
afterAll(async () => {
  if (!alive) return;
  await pool.closePool();
  await tdb.drop();
});

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ R7-09: закрепление ноды, замолчавшей ненадолго, не забирают', () => {
  it('база лежала 15 с: нода A и её герой молчат 15 с — вход на B отказан, закрепление за A', async () => {
    if (!alive) return;
    const c = char();
    await beatAgo(nodeA, 15);
    await liveAgo(c, nodeA, 15);
    expect(await reg.claimForJoin(c, nodeB), 'нода A держит героя — вход на B ждёт её').toBe(nodeA);
    expect(await ownerOf(c)).toBe(nodeA);
  });

  it('база лежала 45 с (дольше срока простоя закрепления): то же — A держала героя на последнем ударе сердца', async () => {
    if (!alive) return;
    const c = char();
    await beatAgo(nodeA, 45);
    await liveAgo(c, nodeA, 45);
    expect(await reg.claimForJoin(c, nodeB)).toBe(nodeA);
  });

  it('A продлила героя, а ударить сердцем ещё не успела (порядок удара: продление, затем сердце) — не забирают', async () => {
    if (!alive) return;
    const c = char();
    await beatAgo(nodeA, 45);
    await liveAgo(c, nodeA, 0);
    expect(await reg.claimForJoin(c, nodeB)).toBe(nodeA);
  });

  it('нода снята (штатный уход или уборка реестра) — закрепление переходит', async () => {
    if (!alive) return;
    const c = char();
    const gone = `${tag}-gone`;
    await beatAgo(gone, 15);
    await liveAgo(c, gone, 15);
    await pool.q('DELETE FROM cluster_nodes WHERE id = $1', [gone]);
    expect(await reg.claimForJoin(c, nodeB)).toBe(nodeB);
  });

  it('нода молчит дольше срока смерти — закрепление переходит', async () => {
    if (!alive) return;
    const c = char();
    const dead = `${tag}-dead`;
    await beatAgo(dead, 3600);
    await liveAgo(c, dead, 3600);
    expect(await reg.claimForJoin(c, nodeB)).toBe(nodeB);
  });

  it('контроль R2-17: нода жива, а героя давно не продлевает (его там нет) — закрепление переходит', async () => {
    if (!alive) return;
    const c = char();
    const idle = `${tag}-idle`;
    await beatAgo(idle, 0);
    await liveAgo(c, idle, 300);
    expect(await reg.claimForJoin(c, nodeB)).toBe(nodeB);
  });

  it('контроль: нода молчит, но героя не продлевала и до того (вышел раньше, снятие не дошло) — закрепление переходит', async () => {
    if (!alive) return;
    const c = char();
    const quiet = `${tag}-quiet`;
    await beatAgo(quiet, 20);
    await liveAgo(c, quiet, 120);
    expect(await reg.claimForJoin(c, nodeB)).toBe(nodeB);
  });

  it('уборка реестра не сносит ноду, молчащую меньше срока смерти: иначе её героев забирали бы раньше', async () => {
    if (!alive) return;
    const quiet = `${tag}-sweep`;
    await beatAgo(quiet, 90);
    await reg.sweepNodes();
    const row = await pool.q1<{ id: string }>('SELECT id FROM cluster_nodes WHERE id = $1', [quiet]);
    expect(row?.id).toBe(quiet);
  });
});
