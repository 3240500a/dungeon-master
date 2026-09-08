import pg from 'pg';

/**
 * Подключение к Postgres (Ф2). Одна точка входа: пул, помощник запроса и помощник транзакции.
 *
 * ПОЧЕМУ УШЛИ С SQLITE. Предметы становятся отдельными строками с журналом происхождения
 * (`items` + `item_events`), а это значит: настоящие транзакции с несколькими писателями,
 * частичные индексы, `jsonb` с поиском внутри, и в перспективе (Ф4) несколько игровых нод
 * на одной базе. Встроенный `node:sqlite` синхронен и живёт в процессе — на одной ноде это
 * работало, но именно на нём нельзя построить общий замок и общий журнал.
 *
 * ЦЕНА, О КОТОРОЙ НАДО ЗНАТЬ: доступ к данным стал асинхронным. Всё, что раньше читалось
 * «по ходу дела», теперь требует `await`, и в сетевом слое появилась очередь на соединение
 * (`RoomManager`) — иначе два кадра одного игрока обгоняли бы друг друга.
 */

const { Pool } = pg;

/**
 * Адрес базы. В разработке — локальный сервер со стенда, в бою обязателен `DM_PG`:
 * молчаливый уход на localhost в проде хуже падения при старте.
 */
const DEV_URL = 'postgresql://dm:dmpass@127.0.0.1:5433/dungeon';
const URL_ = process.env.DM_PG ?? (process.env.NODE_ENV === 'production' ? '' : DEV_URL);
if (!URL_) {
  console.error('[dm-server] не задан DM_PG (строка подключения к Postgres) — в бою это обязательно');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: URL_,
  // Пул под одну игровую ноду: запросов немного (вход, автосейв раз в 10 с, перенос предмета),
  // но они не должны ждать друг друга из-за нехватки соединений.
  max: Number(process.env.DM_PG_POOL ?? 10),
  idleTimeoutMillis: 30_000,
  // Долгий запрос — это всегда ошибка в нашем коде: игровых запросов длиннее секунды не бывает.
  statement_timeout: 10_000,
});

// Пул переизлучает ошибки простаивающих соединений. БЕЗ обработчика Node роняет процесс:
// разрыв соединения с базой не повод убивать сервер, пул откроет новое.
pool.on('error', (e) => console.warn('[db] ошибка простаивающего соединения:', e.message));

/** Обычный запрос. Возвращает строки. */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string, params: readonly unknown[] = [],
): Promise<T[]> {
  const r = await pool.query<T>(text, params as unknown[]);
  return r.rows;
}

/** Первая строка или null — для запросов по ключу. */
export async function q1<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string, params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Транзакция на ОДНОМ соединении. Всё внутри `fn` обязано идти через переданный клиент —
 * иначе часть работы уедет мимо транзакции в другое соединение пула, и «атомарность» окажется
 * ложной. Именно на этом ломаются переносы предметов, поэтому клиент передаётся явно.
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* соединение уже мертво */ }
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Схема. Идемпотентна: гоняется на каждом старте, `IF NOT EXISTS` везде. Отдельного
 * инструмента миграций нет намеренно — таблиц мало, а изменения проходят через этот файл,
 * который читается целиком за минуту.
 */
export async function initSchema(): Promise<void> {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id         text PRIMARY KEY,
      username   text NOT NULL,
      pass_hash  text NOT NULL,
      pass_salt  text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- Ник уникален БЕЗ учёта регистра: «Vasya» и «vasya» — один и тот же игрок.
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

    CREATE TABLE IF NOT EXISTS sessions (
      token      text PRIMARY KEY,
      user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

    CREATE TABLE IF NOT EXISTS characters (
      char_id    text PRIMARY KEY,
      user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      -- Оптимистичная блокировка (Ф0.3): запись проходит, только если версия та же, что читали.
      version    integer NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS characters_user ON characters (user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS account_stash (
      user_id    text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS config_overrides (
      key        text PRIMARY KEY,
      json       jsonb NOT NULL,
      updated_at bigint NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pose_store (
      key        text PRIMARY KEY,
      json       jsonb NOT NULL,
      updated_at bigint NOT NULL
    );
  `);
}

/** Закрыть пул (тесты и graceful shutdown). */
export async function closePool(): Promise<void> {
  await pool.end();
}
