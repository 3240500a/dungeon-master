import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * ⭐ 08.10 (Д1): РЕЛИЗЫ И КАНАЛЫ — против НАСТОЯЩЕЙ базы `dungeon_test` в своей схеме (`testDb.ts`); без базы тест пропускается.
 * Одно содержимое — один релиз; новое — новый номер и канал на нём; каналы и ABI — раздельно; два нарезчика разом (два процесса на одной
 * базе) — один релиз, а не два.
 */
const tdb = await vi.hoisted(async () => (await import('../db/testDb.js')).testDb('contentrel'));

let pool: typeof import('../db/pool.js');
let rel: typeof import('./releaseDb.js');
let alive = false;
beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('../db/pool.js');
  rel = await import('./releaseDb.js');
  if (alive) { await pool.initSchema(); await rel.initContentSchema(); }
});
afterAll(async () => { if (alive) { await pool.closePool(); await tdb.drop(); } });

const M = (c: string): string => c.repeat(64).slice(0, 64);
const R = (manifest: string, abi = 1) => ({ abi, manifest, manifestSize: 100, configRev: 'a-1', gameRev: 'b-2' });

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ Д1: релизы контента в базе', () => {
  it('первый релиз — номер и канал dev на нём; то же содержимое — тот же релиз', async () => {
    if (!alive) return;
    const a = await rel.recordRelease(R(M('a')));
    expect(a.fresh).toBe(true);
    const again = await rel.recordRelease(R(M('a')));
    expect(again).toEqual({ seq: a.seq, fresh: false });
    expect(await rel.channelPointer('dev', 1)).toMatchObject({ channel: 'dev', seq: a.seq, manifest: M('a'), manifestSize: 100, minClient: 0, latestClient: 0 });
  });

  it('новое содержимое — следующий номер, канал переехал; другой канал и другая ABI — свои указатели', async () => {
    if (!alive) return;
    const before = (await rel.channelPointer('dev', 1))!.seq;
    const b = await rel.recordRelease(R(M('b')));
    expect(b.seq).toBeGreaterThan(before);
    expect((await rel.channelPointer('dev', 1))!.manifest).toBe(M('b'));
    expect(await rel.channelPointer('live', 1)).toBeNull();
    const beta = await rel.recordRelease(R(M('b')), 'beta');
    expect(beta.fresh).toBe(true);   // канал без указателя — свой релиз (номер растёт и при откате/перекладке)
    expect((await rel.channelPointer('beta', 1))!.seq).toBe(beta.seq);
    expect(await rel.channelPointer('dev', 2)).toBeNull();
    await rel.recordRelease(R(M('c'), 2));
    expect((await rel.channelPointer('dev', 2))!.manifest).toBe(M('c'));
    expect((await rel.channelPointer('dev', 1))!.manifest).toBe(M('b'));
  });

  it('два нарезчика разом с одним содержимым — один новый релиз', async () => {
    if (!alive) return;
    const rs = await Promise.all([rel.recordRelease(R(M('d'))), rel.recordRelease(R(M('d'))), rel.recordRelease(R(M('d')))]);
    expect(rs.filter((r) => r.fresh)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.seq)).size).toBe(1);
  });

  it('схема второй раз — без изменений (отпечаток части `content`)', async () => {
    if (!alive) return;
    await rel.initContentSchema();
    expect((await rel.channelPointer('dev', 1))!.manifest).toBe(M('d'));
  });
});
