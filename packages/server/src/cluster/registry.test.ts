import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Закрепления персонажей за нодами (Ф4, R1-08) — против НАСТОЯЩЕЙ базы: здесь проверяется ровно SQL, и мок
 * проверил бы только сам себя. Без базы тест пропускается — `DM_PG_TEST` или локальный PostgreSQL на 5432 (`dungeon_test`).
 *
 * ⚠ Адрес базы — в `vi.hoisted`, до импортов (см. `items.test.ts`): иначе пул открылся бы на DEV-базе. Схема — своя на файл
 * (`db/testDb.ts`): живые ноды и закрепления соседних файлов сюда не попадают.
 */
const tdb = await vi.hoisted(async () => (await import('../db/testDb.js')).testDb('registry'));

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
  alive = await tdb.open();
  pool = await import('../db/pool.js');
  reg = await import('./registry.js');
  if (!alive) return;   // базы нет — тесты ниже пропустятся
  await reg.initClusterSchema();
  await reg.heartbeat(nodeA, 'ws://a', beat);
  await reg.heartbeat(nodeB, 'ws://b', beat);
  // Мёртвая нода: была в реестре, но давно молчит.
  await reg.heartbeat(nodeDead, 'ws://dead', beat);
  await pool.q(`UPDATE cluster_nodes SET beat_at = now() - interval '1 hour' WHERE id = $1`, [nodeDead]);
});
afterAll(async () => {
  if (!alive) return;
  await pool.closePool();
  await tdb.drop();
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
    (await pool.q(`SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'char_claims' AND column_name = 'live_at'`)).length > 0;

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

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ R16-02: нода, которую реестр уже счёл мёртвой, отданного не оживляет', () => {
  const runOwner = async (key: string): Promise<string | null> =>
    (await pool.q1<{ node_id: string }>('SELECT node_id FROM run_locks WHERE run_key = $1', [key]))?.node_id ?? null;

  it('A молчала 200 с (простой машины), её героя и забег взяла B и отпустила — продление A с арендой их не вставляет; возраст удара A — по часам базы', async () => {
    if (!alive) return;
    const a = `${tag}-pa`, b = `${tag}-pb`;
    await reg.heartbeat(a, 'ws://pa', beat);
    await reg.heartbeat(b, 'ws://pb', beat);
    const h = char(), r = `id:${tag}-run1`;
    expect(await reg.claimForJoin(h, a)).toBe(a);
    expect(await reg.claimRun(r, a, 'AAAA1')).toBeNull();
    expect(await reg.nodeBeatAge(a), 'только что била').toBeLessThan(5);
    // A на паузе 200 с: реестр её не видит.
    await pool.q(`UPDATE cluster_nodes SET beat_at = now() - interval '200 seconds' WHERE id = $1`, [a]);
    expect(await reg.nodeBeatAge(a), 'реестр не видел её 200 с').toBeGreaterThanOrEqual(199);
    // Герой переподключился через гейтвей на B, доиграл и ушёл из города (забег припаркован в строке): B отпустила и героя, и забег.
    expect(await reg.claimForJoin(h, b), 'A мертва — герой переходит').toBe(b);
    expect(await reg.claimRun(r, b, 'BBBB1'), 'и забег').toBeNull();
    await reg.releaseChar(h, b);
    await reg.releaseRun(r, b, 'BBBB1');
    // A проснулась: продление своих (нода с арендой) — ни вставки, ни продления.
    expect([...await reg.touchClaims([h], a, true)], 'героя A больше не держит').toEqual([]);
    expect([...await reg.touchRuns([{ key: r, room: 'AAAA1' }], a, true)], 'и забега').toEqual([]);
    expect(await reg.claimOwner(h), 'закрепление не вставлено').toBeNull();
    expect(await runOwner(r), 'держание забега не вставлено').toBeNull();
    // Уборка реестра сняла строку A — то же, и возраста у неё нет.
    await pool.q('DELETE FROM cluster_nodes WHERE id = $1', [a]);
    expect(await reg.nodeBeatAge(a), 'строки нет').toBeNull();
    expect([...await reg.touchClaims([h], a, true)]).toEqual([]);
    expect([...await reg.touchRuns([{ key: r, room: 'AAAA1' }], a, true)]).toEqual([]);
    expect(await reg.claimOwner(h)).toBeNull();
    expect(await runOwner(r)).toBeNull();
    // Живая нода с арендой — как прежде: своё продлевает, снятое восстанавливает (R1-08, V2).
    const g = char(), rg = `id:${tag}-run2`;
    expect([...await reg.touchClaims([g], b, true)], 'живая B восстанавливает своё').toEqual([g]);
    expect([...await reg.touchRuns([{ key: rg, room: 'BBBB2' }], b, true)]).toEqual([rg]);
    expect(await reg.claimOwner(g)).toBe(b);
    expect(await runOwner(rg)).toBe(b);
  });

  it('⭐ R17-01: удар сердца ноды с арендой — только пока реестр её видел меньше аренды назад: мёртвую строку не освежает и снятую не вставляет', async () => {
    if (!alive) return;
    const a = `${tag}-qa`, b = `${tag}-qb`;
    const ageOf = async (id: string): Promise<number | null> => reg.nodeBeatAge(id);
    expect(await reg.heartbeat(a, 'ws://qa', beat), 'первый удар — вставка (аренды ещё нет)').toBe(true);
    await reg.heartbeat(b, 'ws://qb', beat);
    expect(await reg.heartbeat(a, 'ws://qa', beat, true), 'живая нода с арендой — удар дошёл').toBe(true);
    expect(await ageOf(a)).toBeLessThan(5);
    const h = char(), r = `id:${tag}-run3`;
    expect(await reg.claimForJoin(h, a)).toBe(a);
    expect(await reg.claimRun(r, a, 'AAAA3')).toBeNull();
    // Машина A на паузе 200 с; сверка возраста удара (`nodeBeatAge`) ответила ДО паузы — «2 с», и нода действует по этому ответу.
    await pool.q(`UPDATE cluster_nodes SET beat_at = now() - interval '200 seconds' WHERE id = $1`, [a]);
    // B взяла героя и забег и отпустила (доиграл, ушёл из города).
    expect(await reg.claimForJoin(h, b)).toBe(b);
    expect(await reg.claimRun(r, b, 'BBBB3')).toBeNull();
    await reg.releaseChar(h, b);
    await reg.releaseRun(r, b, 'BBBB3');
    // Проснувшаяся A: продление своих отказано (R16-02), и удар сердца — тоже: строка не освежается.
    expect([...await reg.touchClaims([h], a, true)]).toEqual([]);
    expect(await reg.heartbeat(a, 'ws://qa', beat, true), 'реестр не видел её дольше аренды — удара нет').toBe(false);
    expect(await ageOf(a), 'строка не освежена').toBeGreaterThanOrEqual(199);
    // Следующий удар по расписанию (сверка теперь видит 200 с — но и без неё): продление по-прежнему ничего не вставляет.
    expect([...await reg.touchClaims([h], a, true)]).toEqual([]);
    expect([...await reg.touchRuns([{ key: r, room: 'AAAA3' }], a, true)]).toEqual([]);
    expect(await reg.claimOwner(h), 'отпущенный B герой не вернулся за A').toBeNull();
    expect(await pool.q1('SELECT 1 FROM run_locks WHERE run_key = $1', [r]), 'и забег').toBeNull();
    // Строку A сняла уборка — удар с арендой её не вставляет.
    await pool.q('DELETE FROM cluster_nodes WHERE id = $1', [a]);
    expect(await reg.heartbeat(a, 'ws://qa', beat, true), 'строки нет — удара нет').toBe(false);
    expect(await ageOf(a), 'строка не вставлена').toBeNull();
    // Контроль: без аренды (первый удар нового процесса, одиночная роль) — вставка, как прежде.
    expect(await reg.heartbeat(a, 'ws://qa', beat), 'первый удар нового процесса').toBe(true);
    expect(await ageOf(a)).toBeLessThan(5);
  });

  it('контроль: одиночный процесс (аренды нет, отдать его героев некому) продлевает и восстанавливает своих и после долгой тишины, как прежде', async () => {
    if (!alive) return;
    const s = `${tag}-ps`;
    await reg.heartbeat(s, 'ws://ps', beat);
    await pool.q(`UPDATE cluster_nodes SET beat_at = now() - interval '200 seconds' WHERE id = $1`, [s]);
    const h = char();
    expect([...await reg.touchClaims([h], s)], 'база лежала дольше срока — свои у одиночного процесса остаются').toEqual([h]);
    expect(await reg.claimOwner(h)).toBe(s);
  });
});
