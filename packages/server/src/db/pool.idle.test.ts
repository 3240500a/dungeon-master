import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { ConfigRegistry, newCharacterSave, uuidv7 } from '@dm/shared';

/**
 * ⭐ R3-13: ТРАНЗАКЦИЯ, БРОШЕННАЯ МЁРТВОЙ НОДОЙ, НЕ ДЕРЖИТ СТРОКИ ЧАСАМИ. Запись сейва — несколько обменов с базой внутри
 * транзакции; нода, чей хост умер без FIN/RST (или отрезан сетью), оставляет свои соединения «idle in transaction» —
 * со всеми взятыми блокировками строк, пока TCP keepalive сервера не заметит обрыв (с настройками ОС — около двух
 * часов). Через 10 с закрепление героя переходит к другой ноде, он входит там — и КАЖДАЯ запись его сейва и сундука
 * аккаунта ждёт блокировку до `statement_timeout`: автосейвы падают, кузница и сундук отвечают «Не удалось
 * сохранить», прощальная копия уходит «на дописать» — на часы.
 *
 * Пул ставит `idle_in_transaction_session_timeout`: игровые транзакции короче секунды, и база сама закрывает
 * соединение, простоявшее в транзакции дольше предела, — блокировки уходят вместе с ним. Здесь предел — 1 с.
 *
 * Против НАСТОЯЩЕЙ базы `dungeon_test` в своей схеме (как `items.test.ts`, см. `testDb.ts`); без базы тест пропускается.
 */
const tdb = await vi.hoisted(async () => {
  process.env.DM_PG_IDLE_TX_MS = '1000';
  return (await import('./testDb.js')).testDb('poolidle');
});

let db: typeof import('./db.js');
let pool: typeof import('./pool.js');
let alive = false;
let cfg: ConfigRegistry;

beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('./pool.js');
  if (!alive) return;   // базы нет — тесты ниже пропустятся
  await pool.initSchema();
  db = await import('./db.js');
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
afterAll(async () => { if (alive) { await pool.closePool(); await tdb.drop(); } });

describe.runIf(process.env.DM_SKIP_PG !== '1')('простой в транзакции (R3-13)', () => {
  it('соединение пула несёт предел простоя в транзакции', async () => {
    if (!alive) return;
    const [row] = await pool.q<{ idle_in_transaction_session_timeout: string }>('SHOW idle_in_transaction_session_timeout');
    expect(row!.idle_in_transaction_session_timeout).toBe('1s');
  });

  it('⭐ брошенная транзакция «мёртвой ноды» отпускает строку героя: запись его сейва с другого соединения проходит', async () => {
    if (!alive) return;
    const userId = await db.createUser(`t_${uuidv7().slice(-12)}`, 'h', 's');
    const charId = uuidv7();
    const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Тест', charId);
    await db.createCharacter(charId, userId, save);
    const row = (await db.getCharacter(charId))!;

    // «Нода A»: соединение её пула взяло блокировку строки героя посреди записи — и замолчало навсегда.
    const dead = await pool.pool.connect();
    dead.on('error', () => { /* база закрыла простоявшее соединение — ровно этого и ждём */ });
    try {
      await dead.query('BEGIN');
      await dead.query('UPDATE characters SET version = version WHERE char_id = $1', [charId]);
      await new Promise((r) => setTimeout(r, 1_500));

      // «Нода B»: герой вошёл сюда, автосейв.
      const t0 = Date.now();
      const next = await db.putCharacter(charId, userId, row.data, row.version, 'autosave');
      expect(next, 'запись прошла').toBe(row.version + 1);
      expect(Date.now() - t0, 'и не ждала блокировку').toBeLessThan(3_000);
    } finally {
      dead.release(true);
    }
  }, 20_000);
});
