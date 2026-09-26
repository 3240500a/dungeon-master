import { q, q1, applySchema, withSchemaLock } from '../db/pool.js';

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
}

/** Сколько нода может молчать, прежде чем её перестанут считать живой. */
const NODE_STALE_SEC = 10;
/**
 * Сколько живёт закрепление персонажа за нодой после последнего касания. Должно быть
 * заметно больше грейс-реконнекта: игрок, у которого оборвалась связь, обязан вернуться
 * на ТУ ЖЕ ноду, где висит его комната, иначе забег потеряется.
 */
const CLAIM_STALE_SEC = 300;
/**
 * ⭐ R2-17: сколько закрепление ВХОДА держит героя без продления. Нода продлевает своих (живых, в грейсе, с
 * прощальной записью в полёте) каждые две секунды — `live_at`; полминуты без продления значат, что за
 * закреплением никакой сессии нет (вход сорвался, «Завершить» без сессии, снятие не нашло строку). Закрепление
 * маршрута (гейтвей, `claimChar`) `live_at` не ставит вовсе: оно — подсказка, куда вести, а не живой герой.
 */
const CLAIM_IDLE_SEC = 30;

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
  `;

/** Нода объявляет себя живой и сообщает свои показатели. Зовётся раз в пару секунд. */
export async function heartbeat(
  id: string, url: string,
  s: { players: number; rooms: number; cpuSeconds: number; rssBytes: number; loopP99: number; tickHz: number; draining: boolean },
): Promise<void> {
  await q(
    `INSERT INTO cluster_nodes (id, url, players, rooms, draining, cpu_seconds, rss_bytes, loop_p99_ms, tick_hz, beat_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (id) DO UPDATE SET
       url = excluded.url, players = excluded.players, rooms = excluded.rooms,
       draining = excluded.draining, cpu_seconds = excluded.cpu_seconds,
       rss_bytes = excluded.rss_bytes, loop_p99_ms = excluded.loop_p99_ms,
       tick_hz = excluded.tick_hz, beat_at = now()`,
    [id, url, s.players, s.rooms, s.draining, s.cpuSeconds, s.rssBytes, s.loopP99, s.tickHz]);
}

/** Живые узлы (те, что подавали признаки жизни недавно). */
export async function liveNodes(): Promise<NodeRow[]> {
  return q<NodeRow>(
    `SELECT id, url, players, rooms, draining, cpu_seconds, rss_bytes, loop_p99_ms, tick_hz
     FROM cluster_nodes WHERE beat_at > now() - ($1 || ' seconds')::interval
     ORDER BY id`, [String(NODE_STALE_SEC)]);
}

/** Убрать из реестра узлы, которые давно молчат (упали или сняты с деплоя). */
export async function sweepNodes(): Promise<number> {
  const rows = await q<{ id: string }>(
    `DELETE FROM cluster_nodes WHERE beat_at < now() - ($1 || ' seconds')::interval RETURNING id`,
    [String(NODE_STALE_SEC * 6)]);
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
 * Забираем закрепление, если его нет, оно наше, протухло, его нода не подаёт признаков жизни (упала — иначе
 * игрок ждал бы пять минут) или за ним нет живого героя (R2-17: маршрут гейтвея, сорванный вход — `live_at`).
 * Чужое живое закрепление не трогаем и НЕ продлеваем. Возвращает ноду-владельца: эту — вход разрешён, чужую —
 * отказ; не смогли выяснить — бросок (вход ответит «сервер занят»), но НИКОГДА не «значит, наше».
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
            OR char_claims.touched_at < now() - ($3 || ' seconds')::interval
            OR char_claims.live_at IS NULL
            OR char_claims.live_at < now() - ($5 || ' seconds')::interval
            OR NOT EXISTS (SELECT 1 FROM cluster_nodes n
                           WHERE n.id = char_claims.node_id AND n.beat_at > now() - ($4 || ' seconds')::interval)
       RETURNING node_id`,
      [charId, nodeId, String(CLAIM_STALE_SEC), String(NODE_STALE_SEC), String(CLAIM_IDLE_SEC)]);
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
 */
export async function touchClaims(charIds: readonly string[], nodeId: string): Promise<Set<string>> {
  if (!charIds.length) return new Set();
  const rows = await q<{ char_id: string }>(
    `INSERT INTO char_claims (char_id, node_id, touched_at, live_at)
     SELECT c, $2, now(), now() FROM unnest($1::text[]) AS c
     ON CONFLICT (char_id) DO UPDATE SET touched_at = now(), live_at = now() WHERE char_claims.node_id = excluded.node_id
     RETURNING char_id`,
    [charIds, nodeId]);
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

/** Снять все закрепления ноды — при её штатной остановке. */
export async function releaseNode(nodeId: string): Promise<void> {
  await q('DELETE FROM char_claims WHERE node_id = $1', [nodeId]);
  await q('DELETE FROM cluster_nodes WHERE id = $1', [nodeId]);
}
