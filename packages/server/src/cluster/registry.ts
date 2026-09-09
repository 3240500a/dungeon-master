import { q, q1, pool } from '../db/pool.js';

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

/** Тот же ключ, что у основной схемы: процессы кластера стартуют одновременно. */
const SCHEMA_LOCK = 947_213_002;

export async function initClusterSchema(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    await initClusterSchemaLocked();
  } finally {
    try { await c.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]); } catch { /* соединение умерло */ }
    c.release();
  }
}

async function initClusterSchemaLocked(): Promise<void> {
  await q(`
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

    -- Очередь на вход (Ф4.4). Пускать по одному, когда есть место, дешевле, чем принять
    -- всех и лечь: на потолке новый игрок и так не может зайти — цикл занят игрой.
    CREATE TABLE IF NOT EXISTS login_queue (
      ticket  text PRIMARY KEY,
      user_id text NOT NULL,
      at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS login_queue_at ON login_queue (at);
  `);
}

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

/** Продлить закрепление (нода делает это для своих живых игроков). */
export async function touchClaims(charIds: readonly string[]): Promise<void> {
  if (!charIds.length) return;
  await q('UPDATE char_claims SET touched_at = now() WHERE char_id = ANY($1)', [charIds]);
}

/** Снять закрепление: игрок ушёл окончательно и грейс-комнаты у него нет. */
export async function releaseChar(charId: string, nodeId: string): Promise<void> {
  await q('DELETE FROM char_claims WHERE char_id = $1 AND node_id = $2', [charId, nodeId]);
}

/** Снять все закрепления ноды — при её штатной остановке. */
export async function releaseNode(nodeId: string): Promise<void> {
  await q('DELETE FROM char_claims WHERE node_id = $1', [nodeId]);
  await q('DELETE FROM cluster_nodes WHERE id = $1', [nodeId]);
}
