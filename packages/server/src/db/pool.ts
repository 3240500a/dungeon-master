import pg from 'pg';
import { createHash } from 'node:crypto';
import { CommitUnknown } from './errors.js';

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

const { Pool, Client } = pg;

/**
 * Адрес базы. В разработке — локальный сервер со стенда, в бою обязателен `DM_PG`:
 * молчаливый уход на localhost в проде хуже падения при старте.
 */
const DEV_URL = 'postgresql://dm:dmpass@127.0.0.1:5432/dungeon';
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
  // R1-15: предохранители на СТОРОНЕ КЛИЕНТА. `statement_timeout` считает сервер, и полуоткрытое соединение
  // (база ушла, сокет молчит) он не спасает: запись висела бы вечно, а с ней — прощальная запись, которую
  // ждёт вход персонажа. Ожидание соединения из пула, ответа на запрос и живость сокета — ограничены.
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
  keepAlive: true,
  // ⭐ R3-13: предохранитель на СТОРОНЕ БАЗЫ. Нода, чей хост умер без FIN/RST (или отрезан сетью), оставляла свои
  // соединения «idle in transaction» — со всеми блокировками строк героев и сундуков, пока TCP keepalive сервера не
  // заметит обрыв (с настройками ОС — около двух часов). Героя тем временем закрепляла другая нода, и каждая запись его
  // сейва и сундука аккаунта ждала блокировку до `statement_timeout`: «Не удалось сохранить» и копии «на дописать» —
  // часами. Игровые транзакции короче секунды: простоявшее в транзакции дольше предела соединение база закрывает
  // сама, блокировки уходят с ним. Переменная — для теста; в бою умолчание. Живость сокета на стороне базы —
  // `tcp_keepalives_*` в postgresql.conf (docs/DEPLOY.md).
  idle_in_transaction_session_timeout: Number(process.env.DM_PG_IDLE_TX_MS ?? 30_000),
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
  // Соединение, на котором не прошёл даже ROLLBACK (оборвано, запрос завис), в пул не возвращаем — иначе
  // следующая транзакция встала бы в очередь за зависшим запросом на том же сокете (R1-15).
  let broken = false;
  // R3-13: пока соединение у нас, база может закрыть его сама (простой в транзакции дольше предела — процесс замер).
  // Пул слушает ошибки только простаивающих соединений: без своего слушателя это необработанное 'error' — падение
  // процесса со всеми комнатами. Ошибку и так получит ждущий запрос; соединение в пул не вернётся.
  const onError = (e: Error): void => { broken = true; console.warn('[db] соединение закрыто посреди транзакции:', e.message); };
  c.on('error', onError);
  // ⭐ R2-09: сбой НА `COMMIT` — не «не записано». По таймауту node-postgres лишь отклоняет промис, а отправленный
  // `COMMIT` база доводит до конца: вызывающий обязан выяснить исход, а не откатывать память к «до». Сбой раньше
  // фиксации — обычная ошибка: транзакцию откатил ROLLBACK или (соединение умерло) сама база.
  let committing = false;
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    committing = true;
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { broken = true; /* соединение уже мертво */ }
    throw committing ? new CommitUnknown(e, !broken) : e;
  } finally {
    c.off('error', onError);
    c.release(broken);
  }
}

/**
 * ⭐ R2-22: СХЕМА ПРИМЕНЯЕТСЯ, ТОЛЬКО КОГДА ОНА ПОМЕНЯЛАСЬ. `ALTER TABLE … ADD COLUMN IF NOT EXISTS` берёт
 * ИСКЛЮЧИТЕЛЬНУЮ блокировку таблицы, даже когда колонка уже есть, а `CREATE INDEX IF NOT EXISTS` — разделяемую;
 * пакет шёл одной неявной транзакцией и держал всё взятое до конца. Долгий читатель (ночной аудит сундуков)
 * останавливал ALTER, за ним вставали чтения и записи сундука, а за разделяемой блокировкой персонажей — все
 * сейвы: кузница и сундук на всех нодах отвечали «Не удалось сохранить». И так — на КАЖДЫЙ старт каждой ноды.
 *
 * Теперь части схемы помечены отпечатком их текста (`schema_marks`): совпал — не делаем НИЧЕГО, блокировок нет.
 * Правка схемы меняет текст, и она применяется один раз — с `lock_timeout`: не дождались блокировки — повтор
 * через секунду, а не очередь из всех запросов кластера. Правило «вся схема в этом файле» не меняется.
 */
const SCHEMA_LOCK_WAIT_MS = 2_000;
const SCHEMA_TRIES = 5;
export async function applySchema(c: pg.ClientBase, name: string, parts: readonly string[]): Promise<void> {
  const hash = createHash('sha1').update(parts.join('\n-- ⸻\n')).digest('hex');
  await c.query(`CREATE TABLE IF NOT EXISTS schema_marks (
    name text PRIMARY KEY, hash text NOT NULL, at timestamptz NOT NULL DEFAULT now()
  )`);
  const cur = await c.query<{ hash: string }>('SELECT hash FROM schema_marks WHERE name = $1', [name]);
  if (cur.rows[0]?.hash === hash) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await c.query(`SET lock_timeout = ${SCHEMA_LOCK_WAIT_MS}`);
      // Части — по одной: каждая своей неявной транзакцией, взятое одной не держится до конца всех.
      for (const part of parts) await c.query(part);
      await c.query(
        `INSERT INTO schema_marks (name, hash, at) VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET hash = excluded.hash, at = now()`, [name, hash]);
      return;
    } catch (e) {
      // 55P03 — не дождались блокировки: таблицу держит долгий запрос. Повторяем, а не ждём вечно.
      if ((e as { code?: string }).code !== '55P03' || attempt >= SCHEMA_TRIES) throw e;
      console.warn(`[db] схема «${name}»: таблица занята, повтор ${attempt}/${SCHEMA_TRIES - 1}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    } finally {
      await c.query('RESET lock_timeout').catch(() => undefined);
    }
  }
}

/**
 * Схема. Идемпотентна: гоняется на каждом старте, `IF NOT EXISTS` везде. Отдельного
 * инструмента миграций нет намеренно — таблиц мало, а изменения проходят через этот файл,
 * который читается целиком за минуту.
 */
/**
 * Ключ консультативной блокировки на создание схемы. С Ф4 процессов много, и стартуют они
 * одновременно: без блокировки два процесса одновременно делают `DROP TRIGGER` + `CREATE
 * TRIGGER`, и второй падает с «триггер уже существует». Проверено на первом же запуске
 * кластера из пяти процессов.
 */
const SCHEMA_LOCK = 947_213_001;

export async function initSchema(): Promise<void> {
  // R2-22: схема на месте — ни одного DDL и ни одной блокировки таблиц (см. `applySchema`).
  // R9-01: свод записей забегов — своей частью: новая таблица не переприменяет основную схему (и её блокировки).
  await withSchemaLock(SCHEMA_LOCK, async (c) => {
    await applySchema(c, 'main', SCHEMA_MAIN);
    await applySchema(c, 'runs', SCHEMA_RUNS);
  });
}

/**
 * ⭐ R9-01: СВОД ЗАПИСЕЙ ЗАБЕГА — В БАЗЕ, ПО ЛИЧНОСТИ ЗАБЕГА (`run_key`: `RunConfig.id`, у старых — сид и всё, из чего
 * пересобирается граф). Что взято на узле (открытые сундуки, номера убитых из заселения, дёрнутые рычаги) принадлежит
 * ЗАБЕГУ, а не тому, у кого ещё жива копия: записи жили только в сейвах участников, и копия, брошенная одним (финал, «Завершить»,
 * вайп), уносила взятое с узлов, куда другой не доходил, — его старая копия потом собирала эти узлы свежими (R4-04 снова).
 * Строка — узел; списки — множества (запись только добавляет: `mergeRunLedger`), мощь — первой записи. Чистится по сроку
 * (`sweepRunLedger`): забеги не переживают рестарт ноды (`clearAllRuns`), а строки — неделю.
 */
const SCHEMA_RUNS: readonly string[] = [`
    CREATE TABLE IF NOT EXISTS run_ledger (
      run_key    text NOT NULL,
      node_id    text NOT NULL,
      el         double precision NOT NULL,
      chests     integer[] NOT NULL DEFAULT '{}',
      killed     integer[] NOT NULL DEFAULT '{}',
      levers     integer[] NOT NULL DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (run_key, node_id)
    );
    CREATE INDEX IF NOT EXISTS run_ledger_updated ON run_ledger (updated_at);
  `];

/** R6-18: сколько процесс на старте ждёт блокировку схемы, которую держит другой (применяет правку схемы). */
const SCHEMA_WAIT_MS = 10 * 60_000;

/**
 * ⭐ R6-18: СХЕМА — НА СВОЁМ СОЕДИНЕНИИ, БЕЗ ПОТОЛКОВ ПУЛА, ПОД КОНСУЛЬТАТИВНОЙ БЛОКИРОВКОЙ `key`. У соединений пула
 * `statement_timeout` 10 с (параметр старта соединения) и `query_timeout` 15 с. Деплой с правкой схемы: супервизор поднимает
 * гейтвей и ноды разом, первый держит блокировку, пока ждёт занятую таблицу (`applySchema`, до ~20 с), — остальные через
 * 10 с получали 57014 на `pg_advisory_lock` и падали кругом перезапусков; а часть схемы дольше 10 с (новый индекс по
 * растущему журналу вещей) отменялась на каждом старте — не поднялась бы ни одна нода, ни одиночный процесс.
 * Теперь запросы схемы без потолка, а ожидание блокировки — опросом `pg_try_advisory_lock` с паузами до `SCHEMA_WAIT_MS`:
 * ни один запрос не висит, а процесс ждёт ведущего, а не падает. Соединение закрывается после — блокировка уходит с ним.
 */
export async function withSchemaLock(key: number, fn: (c: pg.ClientBase) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000, keepAlive: true });
  c.on('error', (e) => console.warn('[db] соединение схемы:', e.message));
  await c.connect();
  try {
    await c.query('SET statement_timeout = 0');
    const deadline = Date.now() + SCHEMA_WAIT_MS;
    for (let pause = 100, told = false; ; pause = Math.min(pause * 2, 2_000)) {
      const got = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key]);
      if (got.rows[0]?.ok) break;
      if (Date.now() >= deadline) throw new Error(`[db] блокировку схемы ${key} держат дольше ${SCHEMA_WAIT_MS / 1000} с`);
      if (!told) { told = true; console.log(`[db] схему применяет другой процесс — жду блокировку ${key}`); }
      await new Promise((r) => setTimeout(r, pause));
    }
    try {
      await fn(c);
    } finally {
      try { await c.query('SELECT pg_advisory_unlock($1)', [key]); } catch { /* соединение умерло — блокировка ушла с ним */ }
    }
  } finally {
    await c.end().catch(() => undefined);
  }
}

/** Основная схема: таблицы, запрет переписывания журнала вещей. Правка текста = миграция на следующем старте. */
const SCHEMA_MAIN: readonly string[] = [`
    CREATE TABLE IF NOT EXISTS users (
      id         text PRIMARY KEY,
      username   text NOT NULL,
      pass_hash  text NOT NULL,
      pass_salt  text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      -- Ф3.5: адрес, с которого завели аккаунт. По нему стоит суточный потолок на число
      -- новых аккаунтов: честному игроку он незаметен, ботоводу мешает разводить пачку.
      created_ip text
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ip text;
    CREATE INDEX IF NOT EXISTS users_created_ip ON users (created_ip, created_at DESC);
    -- R6-19: сеть адреса регистрации (IPv4 — сам адрес, IPv6 — /64): суточный потолок считается по ней, иначе ферма
    -- меняла хвост IPv6 внутри своей сети. created_ip остаётся — для разбора.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_net text;
    CREATE INDEX IF NOT EXISTS users_created_net ON users (created_net, created_at DESC);
    -- РОЛЬ. Инструментальные роуты (/api/dev/*) держались на том, что запрос пришёл с локальной
    -- машины. Это не пропуск, а его видимость: браузер разработчика тоже ходит с 127.0.0.1, значит
    -- под гейт подпадала ЛЮБАЯ открытая в нём страница. Теперь пускает роль, а не адрес.
    -- Умолчание player — существующие аккаунты правами не обрастают, админа выдаёт grant-admin.
    -- (Обратные кавычки в этом комментарии недопустимы: SQL лежит в шаблонной строке.)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'player';
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
      updated_at timestamptz NOT NULL DEFAULT now(),
      -- D8: оптимистичная блокировка сундука, как у сейва (Ф0.3). Сундук общий на аккаунт, а героев
      -- у аккаунта можно держать онлайн сразу нескольких: без версии две записи внахлёст проходили
      -- обе (last-writer-wins), и вторая молча затирала то, что потратила или положила первая.
      version    integer NOT NULL DEFAULT 1
    );
    ALTER TABLE account_stash ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

    CREATE TABLE IF NOT EXISTS config_overrides (
      key        text PRIMARY KEY,
      json       jsonb NOT NULL,
      updated_at bigint NOT NULL
    );

    -- ── Предметы как данные (Ф2) ────────────────────────────────────────────────
    -- ЛЕДЖЕР: у каждой вещи ровно одна строка и ровно одно место. Дубль вещи невозможен
    -- по построению: id — первичный ключ, а «оказаться в двух местах» здесь просто негде.
    CREATE TABLE IF NOT EXISTS items (
      id       uuid PRIMARY KEY,
      user_id  text NOT NULL,
      -- Где вещь сейчас: 'char:<charId>' | 'stash' | 'world'.
      -- 'world' = ушла от аккаунта (продана, выброшена, уничтожена). Вернуться оттуда можно
      -- (подобрал свой же дроп) — журнал покажет и уход, и возврат.
      loc      text NOT NULL,
      base_id  text NOT NULL,
      data     jsonb NOT NULL,
      born_at  timestamptz NOT NULL DEFAULT now(),
      moved_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS items_owner ON items (user_id, loc);

    -- ЖУРНАЛ ПРОИСХОЖДЕНИЯ: только дозапись. Одного лишь уникального id мало — Blizzard в D2
    -- удаляла дубли по id, и дуперы обходили это, превращая руну в новую вещь через Куб.
    -- Историю переходов нельзя ни подчистить, ни переписать: см. триггер ниже.
    CREATE TABLE IF NOT EXISTS item_events (
      seq      bigserial PRIMARY KEY,
      item_id  uuid NOT NULL,
      at       timestamptz NOT NULL DEFAULT now(),
      kind     text NOT NULL,          -- created | moved | changed | gone
      user_id  text NOT NULL,
      from_loc text,
      to_loc   text,
      reason   text,                   -- чем вызвана запись (autosave / stash / join / …)
      data     jsonb                   -- снимок вещи: на создании и на изменении (ковка)
    );
    CREATE INDEX IF NOT EXISTS item_events_item ON item_events (item_id, seq);
    CREATE INDEX IF NOT EXISTS item_events_at ON item_events (at);

    -- ── Телеметрия поведения (Ф3.2) ─────────────────────────────────────────────
    -- Наблюдения, а не состояние игры: чистятся по сроку, теряются без последствий.
    CREATE TABLE IF NOT EXISTS play_sessions (
      id             bigserial PRIMARY KEY,
      user_id        text NOT NULL,
      char_id        text NOT NULL,
      ip             text,
      started_at     timestamptz NOT NULL,
      updated_at     timestamptz NOT NULL DEFAULT now(),
      ended_at       timestamptz,
      minutes        double precision NOT NULL DEFAULT 0,
      kills          integer NOT NULL DEFAULT 0,
      gold           integer NOT NULL DEFAULT 0,
      xp             integer NOT NULL DEFAULT 0,
      items          integer NOT NULL DEFAULT 0,
      deaths         integer NOT NULL DEFAULT 0,
      floors         integer NOT NULL DEFAULT 0,
      actions        integer NOT NULL DEFAULT 0,
      -- Ритм действий: среднее и разброс интервала. Разброс около нуля — это не человек.
      action_mean_ms double precision NOT NULL DEFAULT 0,
      action_sd_ms   double precision NOT NULL DEFAULT 0
    );
    -- Кузница (K7, §22): счётчики рядом с убийствами — «цена ковки ≈ времени фарма» проверяется по ним.
    ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS crafted   integer NOT NULL DEFAULT 0;
    ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS melted    integer NOT NULL DEFAULT 0;
    ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS salvaged  integer NOT NULL DEFAULT 0;
    ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS enchanted integer NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS play_sessions_user ON play_sessions (user_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS play_sessions_ip ON play_sessions (ip, started_at DESC);
    CREATE INDEX IF NOT EXISTS play_sessions_updated ON play_sessions (updated_at);

    -- История аудитов (Ф2.6). Без неё «ноль нарушений» ничего не значит: не с чем сравнить,
    -- и не видно, когда именно инвариант поехал.
    CREATE TABLE IF NOT EXISTS audit_runs (
      id        bigserial PRIMARY KEY,
      at        timestamptz NOT NULL DEFAULT now(),
      items     integer NOT NULL DEFAULT 0,
      events    integer NOT NULL DEFAULT 0,
      incidents integer NOT NULL DEFAULT 0,
      findings  jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE INDEX IF NOT EXISTS audit_runs_at ON audit_runs (at DESC);

    CREATE TABLE IF NOT EXISTS pose_store (
      key        text PRIMARY KEY,
      json       jsonb NOT NULL,
      updated_at bigint NOT NULL
    );
  `,
  // Запрет на переписывание журнала — на стороне БАЗЫ, а не кода. Приложение может ошибиться
  // или быть скомпрометировано; здесь же любое UPDATE/DELETE по журналу падает с ошибкой.
  `
    CREATE OR REPLACE FUNCTION item_events_append_only() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'item_events — журнал только на дозапись, % запрещён', TG_OP;
    END;
    $fn$ LANGUAGE plpgsql;
  `,
  // Снять и поставить заново ОДНОЙ частью (одна неявная транзакция): между ними журнал не остаётся без запрета.
  `
    DROP TRIGGER IF EXISTS item_events_no_rewrite ON item_events;
    CREATE TRIGGER item_events_no_rewrite BEFORE UPDATE OR DELETE ON item_events
    FOR EACH STATEMENT EXECUTE FUNCTION item_events_append_only();
  `,
];

/** Закрыть пул (тесты и graceful shutdown). */
export async function closePool(): Promise<void> {
  await pool.end();
}
