import { q, q1, applySchema, withSchemaLock } from '../db/pool.js';
import { NODE_DEAD_SEC, CLAIM_IDLE_SEC, claimHeldSql, claimHeldParams } from './claimRule.js';
import { LEASE_MS } from './lease.js';

/**
 * Реестр кластера (Ф4.2): кто из процессов жив, сколько на нём народу и за какой нодой
 * закреплён персонаж.
 *
 * ПОЧЕМУ POSTGRES, А НЕ REDIS. План называл Redis, и для реестра, к которому обращаются
 * на каждом кадре, он был бы прав. Но обращений здесь единицы в секунду: вход, выход,
 * сердцебиение раз в две секунды. Postgres уже стоит, уже транзакционный и уже переживает
 * перезапуск — вторая база ради десятка запросов в секунду это лишняя движущаяся часть
 * в бою. Интерфейс намеренно узкий (шесть функций), поэтому подменить хранилище позже —
 * работа на час.
 *
 * ГЛАВНЫЙ ИНВАРИАНТ (он же глобальный замок из Ф0.3, но теперь настоящий): у персонажа
 * ровно одна живая сессия во ВСЁМ кластере. Держится он не блокировкой, а маршрутизацией:
 * `claimChar` атомарно закрепляет персонажа за нодой, и повторный вход того же персонажа
 * попадает на ТУ ЖЕ ноду, где локальное выселение (Ф0.3) уже работает. То есть глобальная
 * задача сведена к локальной, которая давно решена и покрыта тестами.
 */

/** Живой узел кластера. */
export interface NodeRow {
  id: string;
  url: string;
  players: number;
  rooms: number;
  draining: boolean;
  cpu_seconds: number;
  rss_bytes: string;
  loop_p99_ms: number;
  tick_hz: number;
  /**
   * ⭐ E2E 27.09: время последнего сердцебиения по часам БАЗЫ, мс. Гейтвей по нему снимает свою поправку «направлен, но ещё
   * не учтён» — когда сердцебиение точно видит направленных (`gateway.ts`, `settleIssued`). Сравниваются только значения
   * этого же поля между собой: часы гейтвея с часами базы не смешиваются. Нет поля (старая строка, мок) — поправку снимает
   * запасной срок.
   */
  beat_ms?: number;
}

/** Сколько нода может молчать, прежде чем её перестанут считать живой. */
const NODE_STALE_SEC = 10;
/**
 * Сколько живёт закрепление персонажа за нодой после последнего касания. Должно быть
 * заметно больше грейс-реконнекта: игрок, у которого оборвалась связь, обязан вернуться
 * на ТУ ЖЕ ноду, где висит его комната, иначе забег потеряется.
 */
const CLAIM_STALE_SEC = 300;
// Срок смерти ноды (`NODE_DEAD_SEC`, R7-09) и простоя закрепления входа (`CLAIM_IDLE_SEC`, R2-17) — в `claimRule.ts`: по ним же
// сбрасывает забеги старт ноды (R8-06).

/** Тот же ключ, что у основной схемы: процессы кластера стартуют одновременно. */
const SCHEMA_LOCK = 947_213_002;

export async function initClusterSchema(): Promise<void> {
  // R2-22: схема на месте — ни одного DDL и ни одной блокировки (`char_claims` трогает каждый вход).
  // R6-18: на своём соединении без потолков пула — ждём ведущего, а не падаем (`withSchemaLock`).
  await withSchemaLock(SCHEMA_LOCK, (c) => applySchema(c, 'cluster', [SCHEMA_CLUSTER]));
}

const SCHEMA_CLUSTER = `
    CREATE TABLE IF NOT EXISTS cluster_nodes (
      id           text PRIMARY KEY,
      url          text NOT NULL,
      players      integer NOT NULL DEFAULT 0,
      rooms        integer NOT NULL DEFAULT 0,
      draining     boolean NOT NULL DEFAULT false,
      -- Показатели процесса: гейтвей складывает их и отдаёт как метрики кластера.
      cpu_seconds  double precision NOT NULL DEFAULT 0,
      rss_bytes    bigint NOT NULL DEFAULT 0,
      loop_p99_ms  double precision NOT NULL DEFAULT 0,
      tick_hz      double precision NOT NULL DEFAULT 0,
      beat_at      timestamptz NOT NULL DEFAULT now()
    );

    -- Закрепление персонажа за нодой. Первичный ключ по char_id и есть глобальный замок:
    -- двух живых сессий одного персонажа не может быть, потому что строка одна.
    CREATE TABLE IF NOT EXISTS char_claims (
      char_id    text PRIMARY KEY,
      node_id    text NOT NULL,
      touched_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS char_claims_node ON char_claims (node_id);
    -- R2-17: когда нода последний раз подтвердила ЖИВОГО героя (вход, продление). Пусто — закрепление маршрута.
    ALTER TABLE char_claims ADD COLUMN IF NOT EXISTS live_at timestamptz;

    -- Очередь на вход (Ф4.4). Пускать по одному, когда есть место, дешевле, чем принять
    -- всех и лечь: на потолке новый игрок и так не может зайти — цикл занят игрой.
    CREATE TABLE IF NOT EXISTS login_queue (
      ticket  text PRIMARY KEY,
      user_id text NOT NULL,
      at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS login_queue_at ON login_queue (at);
    -- R6-08: at — место в очереди (не меняется), seen_at — последний опрос: по нему билет протухает. Раньше срок считался
    -- от at, и через минуту честного ожидания билет исчезал.
    ALTER TABLE login_queue ADD COLUMN IF NOT EXISTS seen_at timestamptz NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS login_queue_seen ON login_queue (seen_at);
    CREATE INDEX IF NOT EXISTS login_queue_user ON login_queue (user_id);

    -- ⭐ V2: забег — за одной нодой (как закрепление героя): герои одного забега входят через гейтвей куда угодно, и «Продолжить»
    -- на соседней ноде собирало бы тот же узел во второй комнате. room — код комнаты-держателя (подпись для отказа), live_at —
    -- когда нода подтвердила забег (продлевает сердцебиением, правило держания — как у закрепления героя, claimRule.ts).
    CREATE TABLE IF NOT EXISTS run_locks (
      run_key text PRIMARY KEY,
      node_id text NOT NULL,
      room    text NOT NULL,
      live_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS run_locks_node ON run_locks (node_id);
  `;

/**
 * Нода объявляет себя живой и сообщает свои показатели. Зовётся раз в пару секунд. `true` — удар лёг.
 *
 * ⭐ R17-01: `leased` — нода держит аренду (`lease.ts`, после своего первого удара): удар ложится ОДНИМ запросом с проверкой, что реестр видел
 * её меньше аренды назад (`beat_at` моложе `LEASE_MS` по часам базы), — без вставки; не лёг (реестр уже вправе был счесть её мёртвой, или
 * уборка сняла строку) — `false`, и нода уходит без записи (`node.ts`). Раньше удар всегда был вставкой: сверка возраста удара в начале
 * (`nodeBeatAge`, R16-02) — отдельный запрос, и её ответ, ждавший в буфере сокета всю паузу машины ноды (часы процесса стояли — аренда по
 * ним почти полная), пропускал удар, который оживлял мёртвую строку; аренда продлевалась, а следующий удар вставлял закрепления героев и
 * держание забегов, которые другая нода уже взяла и отпустила. Первый удар процесса (аренды ещё нет) и одиночная роль — вставка, как прежде.
 */
export async function heartbeat(
  id: string, url: string,
  s: { players: number; rooms: number; cpuSeconds: number; rssBytes: number; loopP99: number; tickHz: number; draining: boolean },
  leased = false,
): Promise<boolean> {
  const params = [id, url, s.players, s.rooms, s.draining, s.cpuSeconds, s.rssBytes, s.loopP99, s.tickHz];
  if (leased) {
    const r = await q1<{ id: string }>(
      `UPDATE cluster_nodes SET
         url = $2, players = $3, rooms = $4, draining = $5, cpu_seconds = $6,
         rss_bytes = $7, loop_p99_ms = $8, tick_hz = $9, beat_at = now()
       WHERE id = $1 AND beat_at > now() - ($10 || ' milliseconds')::interval
       RETURNING id`,
      [...params, String(LEASE_MS)]);
    return !!r;
  }
  await q(
    `INSERT INTO cluster_nodes (id, url, players, rooms, draining, cpu_seconds, rss_bytes, loop_p99_ms, tick_hz, beat_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (id) DO UPDATE SET
       url = excluded.url, players = excluded.players, rooms = excluded.rooms,
       draining = excluded.draining, cpu_seconds = excluded.cpu_seconds,
       rss_bytes = excluded.rss_bytes, loop_p99_ms = excluded.loop_p99_ms,
       tick_hz = excluded.tick_hz, beat_at = now()`,
    params);
  return true;
}

/**
 * ⭐ R16-02: сколько секунд назад по часам БАЗЫ реестр видел последний удар ноды `id`; строки нет (снята уборкой или штатно) — `null`. Нода
 * с арендой спрашивает это перед каждым ударом (`node.ts`): по этим часам реестр решает, мертва ли она, — часы процесса простоя машины
 * (ВМ на паузе) не видят.
 */
export async function nodeBeatAge(id: string): Promise<number | null> {
  const r = await q1<{ age: number }>('SELECT extract(epoch FROM now() - beat_at)::float8 AS age FROM cluster_nodes WHERE id = $1', [id]);
  return r ? Number(r.age) : null;
}

/** Живые узлы (те, что подавали признаки жизни недавно). */
export async function liveNodes(): Promise<NodeRow[]> {
  return q<NodeRow>(
    `SELECT id, url, players, rooms, draining, cpu_seconds, rss_bytes, loop_p99_ms, tick_hz,
            (extract(epoch FROM beat_at) * 1000)::float8 AS beat_ms
     FROM cluster_nodes WHERE beat_at > now() - ($1 || ' seconds')::interval
     ORDER BY id`, [String(NODE_STALE_SEC)]);
}

/**
 * Убрать из реестра узлы, которые давно молчат (упали или сняты с деплоя). ⭐ R7-09: не раньше `NODE_DEAD_SEC` — снятая строка
 * отдаёт героев ноды любому входу (`claimForJoin`), и уборка на 60-й секунде обходила бы срок смерти.
 */
export async function sweepNodes(): Promise<number> {
  const rows = await q<{ id: string }>(
    `DELETE FROM cluster_nodes WHERE beat_at < now() - ($1 || ' seconds')::interval RETURNING id`,
    [String(Math.max(NODE_STALE_SEC * 6, NODE_DEAD_SEC))]);
  // ⭐ V2: забеги снятых нод — ничьи (правило держания их и так отдаёт любому), строки — долой.
  if (rows.length) await q('DELETE FROM run_locks WHERE node_id = ANY($1::text[])', [rows.map((r) => r.id)]);
  return rows.length;
}

/**
 * Закрепить персонажа за нодой — АТОМАРНО.
 *
 * Возвращает ноду, за которой персонаж закреплён СЕЙЧАС: свежую заявку `preferred`, если
 * закрепления не было или оно протухло, либо существующую. Именно эта атомарность закрывает
 * гонку двух одновременных входов с разных машин: обе попытки увидят одну и ту же ноду,
 * и вторая сессия будет выселена локально, а не заведёт вторую копию персонажа.
 */
export async function claimChar(charId: string, preferred: string): Promise<string> {
  const r = await q1<{ node_id: string }>(
    `INSERT INTO char_claims (char_id, node_id, touched_at) VALUES ($1, $2, now())
     ON CONFLICT (char_id) DO UPDATE SET
       node_id = CASE
         WHEN char_claims.touched_at < now() - ($3 || ' seconds')::interval THEN excluded.node_id
         ELSE char_claims.node_id
       END,
       touched_at = now()
     RETURNING node_id`,
    [charId, preferred, String(CLAIM_STALE_SEC)]);
  return r?.node_id ?? preferred;
}

/**
 * ⭐ Закрепить персонажа за ЭТОЙ нодой на входе (R1-08) — последний рубеж инварианта «одна живая сессия во всём
 * кластере». Гейтвей закрепляет на маршрутизации, но вход по коду комнаты идёт по букве кода мимо закрепления:
 * без этой проверки герой, живой на ноде A, заходил ещё и на ноду B к другу.
 *
 * Забираем закрепление, если его нет, оно наше, за ним нет живого героя (R2-17: маршрут гейтвея — `live_at` пуст; нода
 * жива, а героя давно не продлевает — сорванный вход, «Завершить» без сессии) или его нода мертва (упала — иначе игрок ждал
 * бы пять минут). Чужое живое закрепление не трогаем и НЕ продлеваем. Возвращает ноду-владельца: эту — вход разрешён, чужую —
 * отказ; не смогли выяснить — бросок (вход ответит «сервер занят»), но НИКОГДА не «значит, наше».
 *
 * ⭐ R7-09: «МЕРТВА» — ЭТО `NODE_DEAD_SEC`, А НЕ `NODE_STALE_SEC`. Раньше хватало 10 с молчания: база легла — сердцебиение ноды
 * не проходило, и вход на соседнюю ноду в окне после подъёма базы забирал героя, чью правду нода держала недописанной копией
 * (дюп через соседа по аккаунту). Теперь закрепление держится, если на ПОСЛЕДНЕМ ударе сердца (не старше срока смерти) нода
 * держала героя: продлила его не раньше чем за `CLAIM_IDLE_SEC` до удара (нода продлевает своих перед ударом, `node.ts`).
 * Молчит — удары не идут, и этот признак не стареет, сколько бы база ни лежала. Нода снята (штатно или уборкой) или молчит
 * дольше срока смерти — закрепление переходит.
 *
 * ⭐ R2-05: ДВА ЗАПРОСА, А НЕ ОДИН. Раньше владельца при отказе читал тот же запрос — со снимком, взятым ДО того,
 * как соседняя нода зафиксировала вставку, на которой наша вставка ждала: строки в снимке «не было», и ответ
 * «закрепление наше» пускал героя на две ноды сразу. Отдельный запрос берёт свежий снимок и видит соседа.
 */
export async function claimForJoin(charId: string, nodeId: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const up = await q1<{ node_id: string }>(
      `INSERT INTO char_claims (char_id, node_id, touched_at, live_at) VALUES ($1, $2, now(), now())
       ON CONFLICT (char_id) DO UPDATE SET node_id = excluded.node_id, touched_at = now(), live_at = now()
         WHERE char_claims.node_id = excluded.node_id
            OR char_claims.live_at IS NULL
            OR NOT EXISTS (SELECT 1 FROM cluster_nodes n
                           WHERE n.id = char_claims.node_id AND ${claimHeldSql('char_claims', 'n', 3, 4)})
       RETURNING node_id`,
      [charId, nodeId, ...claimHeldParams()]);   // R8-06: то же правило — у сброса забегов на старте ноды
    if (up) return up.node_id;
    const owner = await claimOwner(charId);
    if (owner) return owner;
    // Строку сняли между запросами (выход на её ноде) — ещё одна попытка забрать.
  }
  throw new Error(`закрепление ${charId} за ${nodeId} не выяснено: строка исчезает между запросами`);
}

/** Нода, за которой персонаж закреплён сейчас, или null. Только чтение — ничего не забирает и не продлевает. */
export async function claimOwner(charId: string): Promise<string | null> {
  return (await q1<{ node_id: string }>('SELECT node_id FROM char_claims WHERE char_id = $1', [charId]))?.node_id ?? null;
}

/**
 * ⭐ R6-08: нода, за которой у героя ЖИВОЕ закрепление — живая сессия, грейс-комната или прощальная запись в полёте (их нода
 * продлевает каждые 2 с, `live_at`), — если сама нода жива; иначе null. Только чтение. Гейтвей ведёт такого героя к его
 * ноде мимо очереди на вход: это возвращение (разрыв посреди забега, вторая вкладка), а не новый вход.
 */
export async function liveClaim(charId: string): Promise<string | null> {
  const r = await q1<{ node_id: string }>(
    `SELECT c.node_id FROM char_claims c JOIN cluster_nodes n ON n.id = c.node_id
     WHERE c.char_id = $1 AND c.live_at > now() - ($2 || ' seconds')::interval
       AND n.beat_at > now() - ($3 || ' seconds')::interval`,
    [charId, String(CLAIM_IDLE_SEC), String(NODE_STALE_SEC)]);
  return r?.node_id ?? null;
}

/**
 * Продлить закрепление (нода делает это для своих живых игроков). R1-08: и ВОССТАНОВИТЬ, если его нет — живой
 * герой без закрепления (снятие опоздало к повторному входу) иначе так и оставался бы без него, и второй вход
 * уходил бы на соседнюю ноду. Чужое закрепление не перехватываем.
 *
 * ⭐ R2-05: возвращает, КОГО продлили. Кого нет в ответе — того закрепление у чужой ноды: там уже живой герой, а
 * здесь — проигравшая копия. Нода снимает такую сессию (`clusterHooks.fenceLost`), а не играет ею дальше.
 *
 * ⭐ R16-02: `leased` — нода держит аренду (`lease.ts`): продлевает и восстанавливает она, только пока реестр сам числит её живой (удар не
 * старше `NODE_DEAD_SEC`). Мёртвую по реестру героев её уже вправе был забрать и ОТПУСТИТЬ другой: восстановление вставляло их закрепления
 * заново, и гейтвей вёл героя к её устаревшей копии. Главная защита — выход без записи до удара (`node.ts`); это — второй рубеж на случай,
 * когда между сверкой и продлением прошёл срок. ⭐ R17-01: а третий — сам удар (`heartbeat(…, leased)`): отказ здесь не оживляет строку ноды,
 * и следующий удар отданного не вставит. Одиночный процесс (аренды нет) — как прежде: отдать его героев некому.
 */
export async function touchClaims(charIds: readonly string[], nodeId: string, leased = false): Promise<Set<string>> {
  if (!charIds.length) return new Set();
  const rows = await q<{ char_id: string }>(
    `INSERT INTO char_claims (char_id, node_id, touched_at, live_at)
     SELECT c, $2, now(), now() FROM unnest($1::text[]) AS c
      WHERE NOT $3 OR EXISTS (SELECT 1 FROM cluster_nodes n WHERE n.id = $2 AND n.beat_at > now() - ($4 || ' seconds')::interval)
     ON CONFLICT (char_id) DO UPDATE SET touched_at = now(), live_at = now() WHERE char_claims.node_id = excluded.node_id
     RETURNING char_id`,
    [charIds, nodeId, leased, String(NODE_DEAD_SEC)]);
  return new Set(rows.map((r) => r.char_id));
}

/**
 * Снять закрепление: игрок ушёл окончательно, и ничего его на этой ноде не держит. Только своё.
 *
 * R2-17: без «момента выхода». Раньше снятие сравнивало время касания по часам БАЗЫ с моментом выхода по часам
 * НОДЫ — часы базы впереди, и снятие не находило строку: закрепление держало героя до пяти минут. Порядок и так
 * держит очередь персонажа: снятие идёт ПОСЛЕ прощальной записи, а повторный вход сюда — после снятия.
 */
export async function releaseChar(charId: string, nodeId: string): Promise<void> {
  await q('DELETE FROM char_claims WHERE char_id = $1 AND node_id = $2', [charId, nodeId]);
}

/** Снять все закрепления ноды — при её штатной остановке. ⭐ V2: и её забеги. */
export async function releaseNode(nodeId: string): Promise<void> {
  await q('DELETE FROM char_claims WHERE node_id = $1', [nodeId]);
  await q('DELETE FROM run_locks WHERE node_id = $1', [nodeId]);
  await q('DELETE FROM cluster_nodes WHERE id = $1', [nodeId]);
}

// ── Забеги за нодами (V2) ────────────────────────────────────────────────────
/**
 * ⭐ V2: ВЗЯТЬ ЗАБЕГ `runKey` ЗА НОДОЙ `nodeId` (комната `room` — подпись) — АТОМАРНО. Забираем, если строки нет, она этой же ноды (какая
 * комната внутри ноды держит забег, решает сама нода — `RoomManager.runRooms`), или нода-держатель больше его не держит: мертва или давно
 * не подтверждала (то же правило, что у закрепления героя, `claimHeldSql`: база лежала — удары не шли, и признак не стареет). Возвращает
 * код комнаты-держателя на ДРУГОЙ ноде или `null` (забег наш). Не выяснили — бросок (продолжение ответит «занято»), но никогда не «наш».
 * Два запроса, как у `claimForJoin` (R2-05): свежий снимок видит соседа, чья вставка легла, пока наша ждала.
 */
export async function claimRun(runKey: string, nodeId: string, room: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const up = await q1<{ node_id: string }>(
      `INSERT INTO run_locks (run_key, node_id, room, live_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (run_key) DO UPDATE SET node_id = excluded.node_id, room = excluded.room, live_at = now()
         WHERE run_locks.node_id = excluded.node_id
            OR NOT EXISTS (SELECT 1 FROM cluster_nodes n
                           WHERE n.id = run_locks.node_id AND ${claimHeldSql('run_locks', 'n', 4, 5)})
       RETURNING node_id`,
      [runKey, nodeId, room, ...claimHeldParams()]);
    if (up) return null;
    const held = await q1<{ node_id: string; room: string }>('SELECT node_id, room FROM run_locks WHERE run_key = $1', [runKey]);
    if (held && held.node_id !== nodeId) return held.room;
    // Строку сняли между запросами (забег кончился на её ноде) — ещё одна попытка забрать.
  }
  throw new Error(`забег ${runKey} за ${nodeId} не выяснен: строка исчезает между запросами`);
}

/**
 * ⭐ V2: продлить забеги, которые держат комнаты ноды (сердцебиение, `node.ts`), — и восстановить строку, если её нет (снятие опоздало к
 * новому держателю). Чужую строку не перехватываем. Возвращает, КОГО продлили: кого нет — того забег у другой ноды (инцидент: её правило
 * держания решило, что мы мертвы). ⭐ R16-02: `leased` — как у `touchClaims`: нода с арендой, мёртвая по реестру, отпущенного другой не вставляет.
 */
export async function touchRuns(runs: readonly { key: string; room: string }[], nodeId: string, leased = false): Promise<Set<string>> {
  if (!runs.length) return new Set();
  const rows = await q<{ run_key: string }>(
    `INSERT INTO run_locks (run_key, node_id, room, live_at)
     SELECT k, $3, r, now() FROM unnest($1::text[], $2::text[]) AS t(k, r)
      WHERE NOT $4 OR EXISTS (SELECT 1 FROM cluster_nodes n WHERE n.id = $3 AND n.beat_at > now() - ($5 || ' seconds')::interval)
     ON CONFLICT (run_key) DO UPDATE SET room = excluded.room, live_at = now() WHERE run_locks.node_id = excluded.node_id
     RETURNING run_key`,
    [runs.map((r) => r.key), runs.map((r) => r.room), nodeId, leased, String(NODE_DEAD_SEC)]);
  return new Set(rows.map((r) => r.run_key));
}

/** ⭐ V2: нода забег больше не держит (кончился, комната ушла). Только своё и только за этой комнатой — строку, уже продлённую за другой комнатой ноды, не трогаем. */
export async function releaseRun(runKey: string, nodeId: string, room: string): Promise<void> {
  await q('DELETE FROM run_locks WHERE run_key = $1 AND node_id = $2 AND room = $3', [runKey, nodeId, room]);
}

/** ⭐ V2: снять все забеги ноды — на её старте (комнаты прошлого процесса ушли вместе с ним, `clearAllRuns` снял и сами забеги). */
export async function releaseNodeRuns(nodeId: string): Promise<number> {
  const rows = await q<{ run_key: string }>('DELETE FROM run_locks WHERE node_id = $1 RETURNING run_key', [nodeId]);
  return rows.length;
}
