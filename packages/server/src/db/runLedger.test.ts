import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { RUN_NODES_MAX, runNodeDepth, type RunNodeState } from '@dm/shared';

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

/**
 * R10-13: дождаться, пока ровно `n` сеансов ЭТОГО файла (свои — по `application_name`, `testDb.ts`) ждут блокировку, у каждого
 * есть кто-то, кто её держит, и никого не держит `not` (держатель, уже отпустивший строку). Ждём состояние базы, а не часы.
 */
async function lockWaiters(n: number, not?: number, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const rows = await pool.q<{ by: number[] }>(
      `SELECT pg_blocking_pids(pid) AS by FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = current_setting('application_name')
         AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (rows.length === n && rows.every((r) => r.by.length > 0 && (not === undefined || !r.by.includes(not)))) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}

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

  it('⭐ R10-13: две комнаты пишут ОДНИ И ТЕ ЖЕ узлы в разном порядке — без взаимоблокировки (40P01), обе записи легли', async () => {
    if (!alive) return;
    const key = 'id:r10-order';
    await db.mergeRunLedger(key, [rec('n1_0', 5, [], [1]), rec('n2_0', 5, [], [1])]);
    // Держатели строк (как «другая комната уже на этой строке») задают переплетение: без них гонка — лотерея таймингов.
    const h1 = await pool.pool.connect(), h2 = await pool.pool.connect();
    try {
      const pidOf = async (c: typeof h1): Promise<number> => (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
      const p1 = await pidOf(h1);
      await h1.query('BEGIN'); await h1.query(`SELECT 1 FROM run_ledger WHERE run_key = $1 AND node_id = 'n1_0' FOR UPDATE`, [key]);
      await h2.query('BEGIN'); await h2.query(`SELECT 1 FROM run_ledger WHERE run_key = $1 AND node_id = 'n2_0' FOR UPDATE`, [key]);
      // Комната A снимает свод в порядке [n1, n2], комната B — [n2, n1] (порядок `ledgerDirty` у каждой свой).
      const a = db.mergeRunLedger(key, [rec('n1_0', 5, [], [2]), rec('n2_0', 5, [], [2])]).then(() => 'ok', (e: { code?: string }) => e.code ?? 'err');
      const b = db.mergeRunLedger(key, [rec('n2_0', 5, [], [3]), rec('n1_0', 5, [], [3])]).then(() => 'ok', (e: { code?: string }) => e.code ?? 'err');
      expect(await lockWaiters(2), 'обе записи ждут строки').toBe(true);
      await h1.query('COMMIT');                      // n1 свободна: её берёт первый в очереди и идёт к n2
      expect(await lockWaiters(2, p1), 'обе снова ждут — уже не держателя n1').toBe(true);
      await h2.query('COMMIT');
      expect([await a, await b], 'обе легли (раньше вторая — 40P01, повтор через 5 с)').toEqual(['ok', 'ok']);
    } finally { h1.release(); h2.release(); }
    const rows = await db.getRunLedger(key);
    expect(rows.map((r) => [r.id, r.killed])).toEqual([['n1_0', [1, 2, 3]], ['n2_0', [1, 2, 3]]]);
  });

  /**
   * ⭐⭐ 13.10 (Г2, Р5): СВОД РЕЖЕТСЯ ПО ГЛУБИНЕ, А НЕ ПО ТЕКСТУ — и у вставки есть потолок.
   *
   * `node_id` — текст (`n<глубина>_<полоса>`), и `ORDER BY node_id LIMIT 512` давал ЛЕКСИКОГРАФИЧЕСКИЙ порядок: на
   * забеге из 600 узлов в выборку шли глубины 1…561 с 88 дырами, `n600_0` НЕ ПОПАДАЛ, а `n1_0` попадал. Участник, у
   * которого записи нет в своём сейве, пересобрал бы самый глубокий узел СВЕЖИМ — вернулся бы фарм сундуков и босса
   * (R4-01). Вставка же не знала потолка вовсе: строка на узел за этаж, а спуск бесконечен.
   */
  it('⭐⭐ Г2 (Р5): 600 узлов — окно по ГЛУБИНЕ (самый глубокий в выборке, первых нет), таблица под потолком', async () => {
    if (!alive) return;
    const key = 'id:deep600';
    // Пачками по 50 — так свод и снимается комнатой; потолок вставки срабатывает на каждой.
    for (let d = 1; d <= 600; d += 50) {
      await db.mergeRunLedger(key, Array.from({ length: 50 }, (_, i) => rec(`n${d + i}_0`, 5, [d + i])));
    }
    const rows = await db.getRunLedger(key);
    const ids = rows.map((r) => r.id);
    const depths = ids.map((id) => Number(/^n(\d+)_/.exec(id)![1]));
    expect(rows.length, 'выборка — ровно окно').toBe(RUN_NODES_MAX);
    expect(depths, 'окно — самые ГЛУБОКИЕ подряд').toEqual(Array.from({ length: RUN_NODES_MAX }, (_, i) => 600 - RUN_NODES_MAX + 1 + i));
    expect(ids, 'узел максимальной глубины обязан быть').toContain('n600_0');
    // ⚠ Ровно то, что давала лексикографика: по тексту первыми идут `n1_0`, `n10_0`, `n100_0`…
    expect(ids, 'первого этажа в окне нет').not.toContain('n1_0');
    expect(ids, 'и «текстово первых» тоже').not.toContain('n100_0');
    // ⭐ ПОТОЛОК НА ВСТАВКУ: в базе лежит рез, а не 600 строк (иначе таблица растёт на каждом забеге).
    // ⭐⭐ 14.10: потолок реза — СВОЙ (`LEDGER_TRIM_MAX`, 512), а не окно сейва: рез общий на забег, а окно чтения —
    // у каждого участника своё (см. сторож разошедшейся пати ниже).
    const cnt = await pool.q<{ n: string }>('SELECT count(*) AS n FROM run_ledger WHERE run_key = $1', [key]);
    expect(Number(cnt[0]!.n), 'строк забега в базе').toBe(db.LEDGER_TRIM_MAX);
    // Имя не нашего вида (порча, чужие руки) не роняет разбор глубины в SQL и считается самым мелким.
    await pool.q('INSERT INTO run_ledger (run_key, node_id, el) VALUES ($1, $2, 1)', [key, 'n99999999999999999999_0']);
    const after = await db.getRunLedger(key);
    expect(after.length, 'окно держится').toBe(RUN_NODES_MAX);
    expect(after.map((r) => r.id), 'порченое имя вытеснено, а не выбрано').not.toContain('n99999999999999999999_0');
  });

  /**
   * ⭐⭐ 14.10: ЧТЕНИЕ СВОДА РЕЖЕТСЯ ПО УЧАСТНИКУ (а РЕЗ ВСТАВКИ — по забегу, см. шапку `LEDGER_TRIM_MAX` в `db.ts`:
   * прежний заголовок «по участнику, а не по забегу» спорил с ней) — сторож на ту самую беду, ради которой свод в базе
   * и заведён (R9-01: РАЗОШЕДШАЯСЯ ПАТИ).
   *
   * ⚠ ЧЕГО ЭТОТ ТЕСТ НЕ ПРОВЕРЯЕТ: самого реза. Он пишет 101 строку — потолок (`LEDGER_TRIM_MAX`, 512) там даже не
   * срабатывает, то есть рез в нём ПУСТОЙ ВЫЗОВ. Рез стережёт тест ниже («забег в 1200 узлов»).
   *
   * Замер на живой базе до правки: комната B пишет глубины 100…199, комната A стоит на `n5_0` и сливает свой свод с
   * открытым сундуком — и `trimRunLedger` (её же вызов, сразу после слива, потолок был `RUN_NODES_MAX` = 32) удалял
   * `n5_0`, а выборка отдавала окно `n168_0…n199_0`. То есть участник на мелком узле переставал его помнить и
   * продолжал его СВЕЖИМ: сундук и босс снова целы, возврат R4-01.
   *
   * Лечится ПРАВИЛОМ с двух сторон: чтение режется по глубине СПРАШИВАЮЩЕГО (`atDepth`), а потолок реза — свой и
   * щедрый (`LEDGER_TRIM_MAX`, 512 СТРОК отставания — ⚠ строк, а не этажей: у разошедшейся пати комнаты стоят на
   * разных ПОЛОСАХ одной глубины и пишут по строке каждая, поэтому охват в этажах ниже заявленного).
   */
  it('⭐⭐ 14.10: разошедшаяся пати — окно свода у участника на мелком узле держит ЕГО запись', async () => {
    if (!alive) return;
    const key = 'id:split-party';
    // Комната B одна уходит на сотню этажей вперёд — пачками, как снимает свод живая комната (рез на каждой).
    for (let d = 100; d <= 199; d += 25) {
      await db.mergeRunLedger(key, Array.from({ length: 25 }, (_, i) => rec(`n${d + i}_0`, 20, [d + i])));
    }
    // Комната A всё это время стоит на `n5_0`: сливает свой свод (открытый сундук 1, убитый 4) — и тем же вызовом режет.
    await db.mergeRunLedger(key, [rec('n5_0', 12, [1], [4])]);
    const mine = await db.getRunLedger(key, RUN_NODES_MAX, 5);
    expect(mine.map((r) => r.id), 'запись СВОЕГО узла на месте (её удалял рез)').toContain('n5_0');
    expect(mine.find((r) => r.id === 'n5_0'), 'и сундук в ней открыт, и убитый помнится').toEqual(rec('n5_0', 12, [1], [4]));
    expect(mine.map((r) => r.id), 'чужой глубокий хвост в окно спрашивающего не идёт').not.toContain('n199_0');
    // Напарник на 199-м спрашивает про свою глубину и получает свой хвост — окно у каждого своё.
    const his = await db.getRunLedger(key, RUN_NODES_MAX, 199);
    expect(his.at(-1)!.id, 'самый глубокий узел напарника').toBe('n199_0');
    expect(his.length, 'и ровно окно').toBe(RUN_NODES_MAX);
    // ⭐ ПРЕЖНИЙ СТОРОЖ ЖИВ: без `atDepth` (инструменты, аудит) — окно от самой ГЛУБОКОЙ записи забега, как было.
    const deepest = await db.getRunLedger(key);
    expect(deepest.at(-1)!.id, 'без `atDepth` — от самой глубокой').toBe('n199_0');
    expect(deepest.map((r) => r.id), 'и мелкого узла в нём нет').not.toContain('n5_0');
  });

  /**
   * ⭐⭐ 14.10: ГЛУБИНА ИЗ ИМЕНИ — ОДНО ПРАВИЛО НА SQL И НА КОД. Шаблон свода не был закреплён по концу имени, поэтому
   * `substring` брал глубину из любого имени, НАЧИНАЮЩЕГОСЯ как наше (`n1_0_x` → 1, `n5_abc` → 5), а `runNodeDepth`
   * тем же именам даёт −1: порченое имя считалось в базе настоящим глубоким узлом и вытесняло живые записи, а в окне
   * сейва было самым мелким. Список — из замера: оба конца шаблона и оба конца потолка цифр (14/15 цифр проходят, 16 и
   * 20 — нет, иначе глубина не влезет в `bigint` и уронит ВЕСЬ запрос свода).
   */
  it('⭐⭐ 14.10: шаблон глубины в SQL и `runNodeDepth` дают ОДНО И ТО ЖЕ на порченых именах', async () => {
    if (!alive) return;
    const names = [
      'n1_0_x', 'n5_abc', 'N5_0', 'n_0', 'n-5_0', 'n5', '_n5_0', 'boss', 'finale',
      'n18446744073709551616_0',                       // 20 цифр (2^64) — за `bigint`
      `n${'9'.repeat(16)}_9`, `n${'9'.repeat(15)}_8`, `n${'9'.repeat(14)}_7`,
      'n5_0', 'n600_12',                                // настоящие имена — для контраста
    ];
    const rows = await pool.q<{ id: string; d: string | null }>(
      `SELECT node_id AS id, ${db.LEDGER_DEPTH} AS d
       FROM unnest($1::text[]) WITH ORDINALITY AS t(node_id, ord) ORDER BY ord`, [names]);
    const sql = rows.map((r) => [r.id, r.d === null ? -1 : Number(r.d)] as const);
    expect(sql.map(([id, d]) => `${id} → ${d}`), 'SQL и код расходятся на порченых именах')
      .toEqual(names.map((id) => `${id} → ${runNodeDepth(id)}`));
    // И по сути: всё перечисленное, кроме двух последних, — «не узел» (самое мелкое), а не глубина.
    expect(sql.filter(([, d]) => d >= 0).map(([id]) => id)).toEqual([`n${'9'.repeat(15)}_8`, `n${'9'.repeat(14)}_7`, 'n5_0', 'n600_12']);
  });

  /**
   * ⭐⭐ 14.10: РЕЗ ВСТАВКИ — ТО, ЧТО ОН УДАЛИЛ, ВЕРНУТЬ НЕЛЬЗЯ, И ЭТО ТОЖЕ ПРАВИЛО.
   *
   * Сторож разошедшейся пати выше пишет 101 строку: потолок там не срабатывает, и рез в нём — пустой вызов. То есть
   * САМ рез не стерёг никто, а он УДАЛЯЕТ данные: забег, у которого строк больше потолка, теряет мелкие, и участник
   * на мелком узле получает ПУСТО — его узел собирается свежим (сундук цел, босс жив, возврат R4-01). Это
   * осознанная цена потолка (дальше отставший опирается на СВОЙ сейв: `run.node`/`run.nodes` едут строкой героя), но
   * цену надо знать числом, а не словами.
   *
   * ⚠ И ещё: 512 — это 512 СТРОК, а не этажей. Здесь по строке на этаж (одна полоса), поэтому числа совпадают; у
   * разошедшейся пати комнаты стоят на разных полосах одной глубины и пишут по строке каждая — охват в этажах ниже.
   *
   * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ ТЕСТ ВАЛИТ (проверены руками 14.10: наложить → прогнать → вернуть, md5 сверен):
   * потолок реза снят (`LEDGER_TRIM_MAX` = 100 000) и рез берёт самые МЕЛКИЕ (`DESC` → `ASC` в `trimRunLedger`).
   */
  it('⭐⭐ 14.10: забег в 1200 узлов — в базе ровно рез, и на мелкой глубине свод отдаёт ПУСТО', async () => {
    if (!alive) return;
    const key = 'id:trim1200';
    const TOTAL = 1200;
    for (let d = 1; d <= TOTAL; d += 50) {
      await db.mergeRunLedger(key, Array.from({ length: 50 }, (_, i) => rec(`n${d + i}_0`, 20, [d + i])));
    }
    const cnt = await pool.q<{ n: string }>('SELECT count(*) AS n FROM run_ledger WHERE run_key = $1', [key]);
    expect(Number(cnt[0]!.n), 'в базе ровно потолок реза').toBe(db.LEDGER_TRIM_MAX);
    // Выжили САМЫЕ ГЛУБОКИЕ: 1200 − 512 + 1 … 1200.
    const first = TOTAL - db.LEDGER_TRIM_MAX + 1;
    const alive1 = await pool.q<{ lo: string; hi: string }>(
      `SELECT min(${db.LEDGER_DEPTH}) AS lo, max(${db.LEDGER_DEPTH}) AS hi FROM run_ledger WHERE run_key = $1`, [key]);
    expect([Number(alive1[0]!.lo), Number(alive1[0]!.hi)], 'выжил глубокий хвост').toEqual([first, TOTAL]);
    // ⭐ ЦЕНА РЕЗА ЧИСЛОМ: участник, отставший глубже реза, получает ПУСТО.
    const shallow = await db.getRunLedger(key, RUN_NODES_MAX, 5);
    expect(shallow, 'на 5-м этаже свода уже нет — рез его удалил').toEqual([]);
    // А тот, чей узел в выживших, получает своё окно (и своя запись в нём первая с конца).
    const mid = await db.getRunLedger(key, RUN_NODES_MAX, first + 11);
    expect(mid.length, 'окно спрашивающего на краю выжившего хвоста').toBe(12);
    expect(mid.at(-1)!.id, 'и его собственный узел — самый глубокий в окне').toBe(`n${first + 11}_0`);
    const deep = await db.getRunLedger(key, RUN_NODES_MAX, TOTAL);
    expect(deep.length).toBe(RUN_NODES_MAX);
    expect(deep.at(-1)!.id).toBe(`n${TOTAL}_0`);
    console.log(`\nРЕЗ СВОДА (замер 14.10): забег ${TOTAL} узлов → в базе ${cnt[0]!.n} строк, выжили глубины ${first}…${TOTAL};`
      + ` getRunLedger(key, ${RUN_NODES_MAX}, 5) → ${shallow.length} строк, (…, ${first + 11}) → ${mid.length}, (…, ${TOTAL}) → ${deep.length}`);
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
