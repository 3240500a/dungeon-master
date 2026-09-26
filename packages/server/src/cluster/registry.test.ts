import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Закрепления персонажей за нодами (Ф4, R1-08) — против НАСТОЯЩЕЙ базы: здесь проверяется ровно SQL, и мок
 * проверил бы только сам себя. Без базы тест пропускается — `DM_PG` или локальный PostgreSQL на 5432.
 *
 * ⚠ Адрес базы — в `vi.hoisted`, до импортов (см. `items.test.ts`): иначе пул открылся бы на DEV-базе.
 */
vi.hoisted(() => {
  process.env.DM_PG ??= 'postgresql://dm:dmpass@127.0.0.1:5432/dungeon_test';
});

let reg: typeof import('./registry.js');
let pool: typeof import('../db/pool.js');
let alive = false;
const tag = `t${Date.now().toString(36)}`;
const nodeA = `${tag}-a`, nodeB = `${tag}-b`, nodeDead = `${tag}-dead`;
const beat = { players: 0, rooms: 0, cpuSeconds: 0, rssBytes: 0, loopP99: 0, tickHz: 0, draining: false };
let seq = 0;
const char = (): string => `${tag}-c${++seq}`;
const ownerOf = async (charId: string): Promise<string | null> =>
  (await pool.q1<{ node_id: string }>('SELECT node_id FROM char_claims WHERE char_id = $1', [charId]))?.node_id ?? null;

beforeAll(async () => {
  pool = await import('../db/pool.js');
  reg = await import('./registry.js');
  try {
    await reg.initClusterSchema();
    alive = true;
  } catch {
    alive = false;
    return;
  }
  await reg.heartbeat(nodeA, 'ws://a', beat);
  await reg.heartbeat(nodeB, 'ws://b', beat);
  // Мёртвая нода: была в реестре, но давно молчит.
  await reg.heartbeat(nodeDead, 'ws://dead', beat);
  await pool.q(`UPDATE cluster_nodes SET beat_at = now() - interval '1 hour' WHERE id = $1`, [nodeDead]);
});
afterAll(async () => {
  if (!alive) return;
  await pool.q('DELETE FROM char_claims WHERE char_id LIKE $1', [`${tag}-%`]);
  await pool.q('DELETE FROM cluster_nodes WHERE id LIKE $1', [`${tag}-%`]);
  await pool.closePool();
});

describe.runIf(process.env.DM_SKIP_PG !== '1')('R1-08: закрепления за нодами', () => {
  it('⭐ вход забирает свободное и своё; чужое живое — нет и не продлевает его; упавшей ноды — забирает', async () => {
    if (!alive) return;
    const c = char();
    expect(await reg.claimForJoin(c, nodeA), 'свободное — наше').toBe(nodeA);
    expect(await reg.claimForJoin(c, nodeA), 'своё — наше').toBe(nodeA);
    await pool.q(`UPDATE char_claims SET touched_at = now() - interval '100 seconds' WHERE char_id = $1`, [c]);
    expect(await reg.claimForJoin(c, nodeB), 'чужое живое — отказ, владелец A').toBe(nodeA);
    const t = await pool.q1<{ age: number }>(`SELECT extract(epoch FROM now() - touched_at)::int AS age FROM char_claims WHERE char_id = $1`, [c]);
    expect(t!.age, 'отказ чужое закрепление не продлил').toBeGreaterThanOrEqual(99);
    expect(await ownerOf(c)).toBe(nodeA);

    const d = char();
    await pool.q('INSERT INTO char_claims (char_id, node_id, touched_at) VALUES ($1, $2, now())', [d, nodeDead]);
    expect(await reg.claimForJoin(d, nodeB), 'нода молчит — закрепление переходит').toBe(nodeB);

    const s = char();
    await pool.q(`INSERT INTO char_claims (char_id, node_id, touched_at) VALUES ($1, $2, now() - interval '1 hour')`, [s, nodeA]);
    expect(await reg.claimForJoin(s, nodeB), 'протухшее — переходит').toBe(nodeB);
  });

  it('⭐ снятие — только своего закрепления; часы ноды в нём не участвуют (R2-17: часы базы впереди)', async () => {
    if (!alive) return;
    const c = char();
    await reg.claimForJoin(c, nodeA);
    await reg.releaseChar(c, nodeB);
    expect(await ownerOf(c), 'чужая нода чужое не снимает').toBe(nodeA);
    // Касание «из будущего»: часы базы на 5 с впереди часов ноды. Раньше снятие сравнивало время касания по
    // часам базы с моментом выхода по часам ноды — и не снимало ничего; закрепление держало героя пять минут.
    await pool.q(`UPDATE char_claims SET touched_at = now() + interval '5 seconds' WHERE char_id = $1`, [c]);
    await reg.releaseChar(c, nodeA);
    expect(await ownerOf(c), 'своё — снято').toBeNull();
  });

  it('⭐ сердцебиение восстанавливает закрепление живого героя и не перехватывает чужое; чужое — в ответе нет (R2-05)', async () => {
    if (!alive) return;
    const lost = char(), foreign = char();
    await pool.q('INSERT INTO char_claims (char_id, node_id, touched_at) VALUES ($1, $2, now())', [foreign, nodeB]);
    const kept = await reg.touchClaims([lost, foreign], nodeA);
    expect(await ownerOf(lost), 'живой без закрепления — закреплён снова').toBe(nodeA);
    expect(await ownerOf(foreign), 'чужое не перехвачено').toBe(nodeB);
    expect([...kept].sort(), 'нода узнаёт, кого потеряла').toEqual([lost]);
  });
});

describe.runIf(process.env.DM_SKIP_PG !== '1')('раунд 2: гонка входа и закрепления без сессии', () => {
  /** Отдельное соединение — «соседняя нода», чья транзакция ещё не зафиксирована. */
  async function neighbour(): Promise<import('pg').Client> {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: process.env.DM_PG });
    await c.connect();
    return c;
  }
  const hasLiveAt = async (): Promise<boolean> =>
    (await pool.q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'char_claims' AND column_name = 'live_at'`)).length > 0;

  it('⭐ R2-05: две ноды входят одновременно — вторая видит закрепление первой, а не «строки нет, значит наше»', async () => {
    if (!alive) return;
    const c = char();
    const live = await hasLiveAt();
    const other = await neighbour();
    try {
      await other.query('BEGIN');
      // Вставка — как у `claimForJoin` ноды A: живое закрепление входа.
      await other.query(
        `INSERT INTO char_claims (char_id, node_id, touched_at${live ? ', live_at' : ''}) VALUES ($1, $2, now()${live ? ', now()' : ''})`, [c, nodeA]);
      const racing = reg.claimForJoin(c, nodeB);
      await new Promise((r) => setTimeout(r, 200));
      await other.query('COMMIT');
      expect(await racing, 'владелец — A, вход на B отклоняется').toBe(nodeA);
    } finally { await other.end(); }
    expect(await ownerOf(c)).toBe(nodeA);
  });

  it('⭐ R2-05: A одновременно забирает протухшее закрепление B — B не считает его своим', async () => {
    if (!alive) return;
    const c = char();
    await pool.q(`INSERT INTO char_claims (char_id, node_id, touched_at) VALUES ($1, $2, now() - interval '1 hour')`, [c, nodeB]);
    const live = await hasLiveAt();
    const other = await neighbour();
    try {
      await other.query('BEGIN');
      await other.query(
        `UPDATE char_claims SET node_id = $2, touched_at = now()${live ? ', live_at = now()' : ''} WHERE char_id = $1`, [c, nodeA]);
      const racing = reg.claimForJoin(c, nodeB);
      await new Promise((r) => setTimeout(r, 200));
      await other.query('COMMIT');
      expect(await racing).toBe(nodeA);
    } finally { await other.end(); }
  });

  it('⭐ R2-17: закрепление маршрута (гейтвей) не держит героя — вход на другой ноде его забирает', async () => {
    if (!alive) return;
    const c = char();
    expect(await reg.claimChar(c, nodeA)).toBe(nodeA);
    expect(await reg.claimForJoin(c, nodeB), 'живой сессии за маршрутом нет').toBe(nodeB);
  });

  it('⭐ R2-17: закрепление входа, которое нода давно не продлевала, живого героя не держит', async () => {
    if (!alive) return;
    const c = char();
    expect(await reg.claimForJoin(c, nodeA)).toBe(nodeA);
    expect(await reg.claimForJoin(c, nodeB), 'свежее — держит').toBe(nodeA);
    await pool.q(`UPDATE char_claims SET live_at = now() - interval '5 minutes' WHERE char_id = $1`, [c]);
    expect(await reg.claimForJoin(c, nodeB), 'нода героя не продлевает — его у неё нет').toBe(nodeB);
    expect(await reg.claimOwner(c)).toBe(nodeB);
  });
});

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ R6-08: живое закрепление — для маршрута мимо очереди', () => {
  it('сессия, грейс, прощальная запись (нода продлевает `live_at`) на живой ноде — её нода; маршрут, протухшее, мёртвая нода — null', async () => {
    if (!alive) return;
    const c = char();
    expect(await reg.claimForJoin(c, nodeA)).toBe(nodeA);
    expect(await reg.liveClaim(c), 'живая сессия на живой ноде').toBe(nodeA);
    await pool.q(`UPDATE char_claims SET live_at = now() - interval '5 minutes' WHERE char_id = $1`, [c]);
    expect(await reg.liveClaim(c), 'нода давно не продлевала — героя там нет').toBeNull();
    const r = char();
    expect(await reg.claimChar(r, nodeA)).toBe(nodeA);
    expect(await reg.liveClaim(r), 'закрепление маршрута — не живой герой').toBeNull();
    const d = char();
    await pool.q('INSERT INTO char_claims (char_id, node_id, touched_at, live_at) VALUES ($1, $2, now(), now())', [d, nodeDead]);
    expect(await reg.liveClaim(d), 'нода молчит — вести некуда').toBeNull();
    expect(await reg.liveClaim(char()), 'закрепления нет').toBeNull();
  });
});
