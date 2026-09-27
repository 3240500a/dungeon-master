import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { ConfigRegistry, newCharacterSave, emptyStash, uuidv7, type AccountStash } from '@dm/shared';

/**
 * ⭐ R3-18: НОЧНОЙ АУДИТ ПРОТИВ ЖИВОЙ ИГРЫ — против НАСТОЯЩЕЙ базы `dungeon_test`, в своей схеме (`testDb.ts`; без базы тест
 * пропускается).
 *
 * Аудит идёт на гейтвее, пока ноды пишут сейвы. Раньше персонажи, сундуки и леджер читались тремя отдельными
 * запросами — тремя разными снимками: перенос вещи в сундук, зафиксированный между чтением персонажей и чтением
 * сундуков, давал «ОДНА ВЕЩЬ В ДВУХ МЕСТАХ», любой автосейв между первым и третьим чтением — «сейв и леджер
 * разошлись». Всё — уровня «инцидент»: настоящий дюп тонул в шуме, от которого R1-16 и берёгся.
 *
 * Запись вставляется РОВНО между чтением персонажей и остальными (перехват ответа драйвера), ответы сужаются до
 * аккаунта теста (схема файла своя, но сужение держит проверку честной и при общей базе).
 */
const tdb = await vi.hoisted(async () => (await import('./testDb.js')).testDb('auditrace'));

let db: typeof import('./db.js');
let pool: typeof import('./pool.js');
let audit: typeof import('./audit.js');
let alive = false;
let cfg: ConfigRegistry;

beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('./pool.js');
  if (!alive) return;   // базы нет — тест пропустится
  // Обе схемы, как у процессов, гоняющих аудит (гейтвей, `items:audit`): аудит читает и закрепления кластера.
  await pool.initSchema();
  await (await import('../cluster/registry.js')).initClusterSchema();
  db = await import('./db.js');
  audit = await import('./audit.js');
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
afterAll(async () => { if (alive) { await pool.closePool(); await tdb.drop(); } });

describe.runIf(process.env.DM_SKIP_PG !== '1')('аудит и живая игра (R3-18)', () => {
  it('⭐ перенос вещи в сундук посреди чтений аудита — ни «дюпа», ни «расхождения»: чтения делят один снимок', async () => {
    if (!alive) return;
    const userId = await db.createUser(`t_${uuidv7().slice(-12)}`, 'h', 's');
    const charId = uuidv7();
    const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Тест', charId);
    await db.createCharacter(charId, userId, save);
    const slot = (Object.keys(save.equipment) as (keyof typeof save.equipment)[])[0]!;
    const item = save.equipment[slot]!;
    const next = structuredClone(save);
    delete next.equipment[slot];
    const stash: AccountStash = emptyStash(cfg);
    stash.tabs[0]!.push({ ...item, pos: { x: 0, y: 0 } });

    let moved = false;
    const mine = (r: pg.QueryResult): void => { r.rows = r.rows.filter((row: { user_id?: string }) => row.user_id === userId); };
    const onResult = async (text: string, r: pg.QueryResult): Promise<pg.QueryResult> => {
      if (/SELECT char_id, user_id, data FROM characters/.test(text)) {
        mine(r);
        if (!moved) {
          moved = true;   // игра переносит вещь в сундук и фиксирует — после чтения персонажей, до остальных
          expect(await db.putCharacterWithStash(charId, userId, next, 1, stash, 0, 'stash')).toMatchObject({ ok: true });
        }
      } else if (/SELECT user_id, data FROM account_stash/.test(text) || /SELECT id, loc, user_id FROM items/.test(text)) {
        mine(r);
      }
      return r;
    };
    const p = pool.pool as unknown as {
      query: (text: string, params?: unknown[]) => Promise<pg.QueryResult>;
      connect: (cb?: unknown) => Promise<pg.PoolClient> | undefined;
    };
    const query0 = p.query, connect0 = p.connect;
    // Чтение мимо транзакции (`q`) и внутри неё (`tx`) — оба пути перехвачены.
    p.query = (text, params) => query0.call(pool.pool, text, params).then((r) => onResult(text, r));
    p.connect = (cb?: unknown) => {
      if (cb) return connect0.call(pool.pool, cb);   // `pool.query` берёт соединение с колбэком — его не трогаем
      return (connect0.call(pool.pool) as Promise<pg.PoolClient>).then((c) => {
        const orig = c.query, rel0 = c.release;
        const q0 = orig.bind(c) as unknown as (text: string, params?: unknown[]) => Promise<pg.QueryResult>;
        c.query = ((text: string, params?: unknown[]) => q0(text, params).then((r) => onResult(text, r))) as never;
        c.release = ((err?: Error | boolean) => { c.query = orig; c.release = rel0; return rel0.call(c, err); }) as never;
        return c;
      });
    };
    let r: Awaited<ReturnType<typeof audit.runAudit>>;
    try {
      r = await audit.runAudit();
    } finally {
      p.query = query0; p.connect = connect0;
    }
    expect(moved, 'перенос случился посреди аудита').toBe(true);
    const about = r.findings.filter((f) => f.examples.some((e) => e.includes(item.uid)));
    expect(about.map((f) => `${f.kind}: ${f.examples.join('; ')}`), 'про эту вещь аудиту сказать нечего').toEqual([]);
    expect(r.findings.filter((f) => ['dupe', 'mismatch', 'lost'].includes(f.kind)), 'и ни про что другое этого аккаунта').toEqual([]);
  }, 20_000);
});
