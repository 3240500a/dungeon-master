import pg from 'pg';
import { randomBytes } from 'node:crypto';

/**
 * ⭐ ТЕСТОВАЯ БАЗА: У КАЖДОГО ФАЙЛА ТЕСТОВ — СВОЯ СХЕМА. Только для тестов (`*.test.ts`), игра этот модуль не видит.
 *
 * ЗАЧЕМ. Файлы тестов против настоящего Postgres идут ПАРАЛЛЕЛЬНО (vitest — по процессу на файл) и раньше делили одну
 * схему `public` базы `dungeon_test`. Отсюда плавающие падения, которые «не повторяются поодиночке»:
 *  - аудит (`runAudit`) читает ВСЮ базу, а примеров в находке десять: дюпы, подсаженные соседними файлами и брошенные
 *    упавшими прогонами (в базе копились тысячи героев), вытесняли из отчёта дюп самого теста;
 *  - `DELETE FROM login_queue` одного файла чистил очередь другого, `clearAllRuns` снимал забеги чужих героев;
 *  - «ждём, пока наш запрос встанет в ожидание блокировки» (`pg_stat_activity`) видел ожидание соседнего файла.
 * Теперь файл получает пустую схему `vt_<метка>_<время>_<случайное>` (search_path соединений пула — через `options`
 * адреса), поднимает в ней всю схему игры (`initSchema`) и сносит её в конце. Имя схемы — и `application_name` его
 * соединений: по нему файл отличает свои сеансы в `pg_stat_activity`. Схемы файлов, упавших, не дойдя до сноса, сносит
 * следующий прогон — по возрасту из имени.
 *
 * ⚠ АДРЕС — ТОЛЬКО ТЕСТОВОЙ БАЗЫ: `DM_PG_TEST` или `dungeon_test` на этой машине. `DM_PG` окружения НЕ берётся: он
 * указывает на базу, с которой работает сервер (в разработке — `dungeon`), и тесты не должны писать туда ни строки.
 *
 * ⚠ Звать `testDb()` — в `vi.hoisted`, ДО импорта `pool.js`: пул читает `DM_PG` в момент загрузки модуля, а статические
 * импорты в ESM исполняются раньше тела файла (см. `items.test.ts`).
 */
export const TEST_PG_URL = process.env.DM_PG_TEST ?? 'postgresql://dm:dmpass@127.0.0.1:5432/dungeon_test';

/** Префикс схем тестов: по нему (и только по нему) уборка находит брошенные схемы. */
const PREFIX = 'vt_';
/** Схема старше — брошена упавшим прогоном (файл тестов столько не идёт). */
const STALE_MS = 6 * 3600_000;

export interface TestDb {
  /** Имя схемы файла (оно же `application_name` соединений пула). */
  readonly schema: string;
  /** Завести схему. `false` — базы нет (или `DM_SKIP_PG=1`): тесты файла пропускаются. */
  open(): Promise<boolean>;
  /** Снести схему со всем содержимым. Звать после `closePool()`. */
  drop(): Promise<void>;
}

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: TEST_PG_URL, connectionTimeoutMillis: 5_000 });
  c.on('error', () => { /* база закрыла соединение — ошибку получит ждущий запрос */ });
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => undefined); }
}

/** Снести схемы тестов, брошенные упавшими прогонами (время создания — в имени). Сосед сносит ту же — не беда. */
async function sweepStale(c: pg.Client): Promise<void> {
  const rows = await c.query<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE '${PREFIX}%'`);
  for (const { nspname } of rows.rows) {
    const born = parseInt(nspname.split('_').at(-2) ?? '', 36);
    if (!Number.isFinite(born) || Date.now() - born < STALE_MS) continue;
    await c.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`).catch(() => undefined);
  }
}

/**
 * Своя схема для файла тестов: ставит `process.env.DM_PG` на адрес тестовой базы со своей схемой. `tag` — короткая метка
 * файла (видна в имени схемы).
 */
export function testDb(tag: string): TestDb {
  const label = tag.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'x';
  const schema = `${PREFIX}${label}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const url = new URL(TEST_PG_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  url.searchParams.set('application_name', schema);
  process.env.DM_PG = url.toString();
  return {
    schema,
    async open() {
      if (process.env.DM_SKIP_PG === '1') return false;
      try {
        await withAdmin(async (c) => {
          await sweepStale(c);
          await c.query(`CREATE SCHEMA "${schema}"`);
        });
        return true;
      } catch {
        return false;   // базы нет — тесты файла пропустятся
      }
    },
    async drop() {
      await withAdmin((c) => c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)).catch(() => undefined);
    },
  };
}
