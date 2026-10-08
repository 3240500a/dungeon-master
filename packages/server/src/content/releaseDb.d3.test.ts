import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * ⭐ 08.10 (Д3): КАНАЛЫ, РАСКАТКА, ОТКАТ, ВЕРСИИ КЛИЕНТА — против НАСТОЯЩЕЙ базы `dungeon_test` в своей схеме (`testDb.ts`); без базы
 * тест пропускается. Схема файла начинается с таблиц Д1 (как на живой базе до Д3) — миграция только добавляет колонки, старые строки
 * остаются на 100% и без версий клиента. Номер канала только растёт: откат и выпуск старого релиза — перевыпуском под новым номером.
 */
const tdb = await vi.hoisted(async () => (await import('../db/testDb.js')).testDb('contentd3'));

let pool: typeof import('../db/pool.js');
let rel: typeof import('./releaseDb.js');
let rules: typeof import('./channelRules.js');
let alive = false;

/** Таблицы ровно как их завела схема Д1 (до колонок Д3). */
const D1_TABLES = `
  CREATE TABLE content_releases (
    seq bigserial PRIMARY KEY, abi integer NOT NULL, manifest text NOT NULL, manifest_size integer NOT NULL,
    config_rev text NOT NULL, game_rev text NOT NULL, created_at bigint NOT NULL, note text NOT NULL DEFAULT ''
  );
  CREATE INDEX content_releases_manifest ON content_releases (manifest);
  CREATE TABLE content_channels (
    channel text NOT NULL, abi integer NOT NULL, seq bigint NOT NULL REFERENCES content_releases (seq),
    rollout integer NOT NULL DEFAULT 100, min_client integer NOT NULL DEFAULT 0, latest_client integer NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL, PRIMARY KEY (channel, abi)
  );
  INSERT INTO content_releases (abi, manifest, manifest_size, config_rev, game_rev, created_at) VALUES (1, '${'a'.repeat(64)}', 100, 'c', 'g', 1);
  INSERT INTO content_channels (channel, abi, seq, updated_at) VALUES ('dev', 1, 1, 1);
`;

beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('../db/pool.js');
  rel = await import('./releaseDb.js');
  rules = await import('./channelRules.js');
  if (alive) { await pool.initSchema(); await pool.q(D1_TABLES); await rel.initContentSchema(); }
});
afterAll(async () => { if (alive) { await pool.closePool(); await tdb.drop(); } });

const M = (c: string): string => c.repeat(64).slice(0, 64);
const R = (manifest: string, abi = 1) => ({ abi, manifest, manifestSize: 100, configRev: 'a-1', gameRev: 'b-2' });
/** Ошибка правила: код и текст. */
async function refused(p: Promise<unknown>): Promise<{ status: number; message: string; extra: Record<string, unknown> }> {
  try { await p; } catch (e) {
    if (e instanceof rules.ChannelOpError) return { status: e.status, message: e.message, extra: e.extra };
    throw e;
  }
  throw new Error('ожидался отказ');
}
const maxSeq = async (): Promise<number> => Number((await pool.q1<{ m: string }>('SELECT max(seq) AS m FROM content_releases'))!.m);

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ Д3: каналы и раскатка в базе', () => {
  it('миграция Д1 → Д3 только добавляет: строка dev — 100%, без версий клиента и без прежнего; повтор схемы — без изменений', async () => {
    if (!alive) return;
    const cols = await pool.q<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name IN ('content_channels', 'content_releases')`);
    const has = (t: string, c: string): boolean => cols.some((r) => r.table_name === t && r.column_name === c);
    expect(has('content_channels', 'prev_seq') && has('content_channels', 'updated_by') && has('content_releases', 'origin_seq')).toBe(true);
    expect(await rel.channelPointer('dev', 1)).toEqual({
      channel: 'dev', seq: 1, manifest: M('a'), manifestSize: 100, minClient: 0, latestClient: 0, rollout: 100, prev: null,
    });
    await rel.initContentSchema();
    expect((await rel.channelPointer('dev', 1))!.seq).toBe(1);
  });

  it('первый выпуск канала — только на 100%; dev кнопкой не трогается; нет релиза — 404; нет файлов — 409 и ничего не записано', async () => {
    if (!alive) return;
    expect((await refused(rel.promoteRelease({ channel: 'live', seq: 1, percent: 10, actor: 't' }))).status).toBe(409);
    expect((await refused(rel.promoteRelease({ channel: 'dev', seq: 1, actor: 't' }))).status).toBe(400);
    expect((await refused(rel.promoteRelease({ channel: 'prod', seq: 1, actor: 't' }))).status).toBe(400);
    expect((await refused(rel.promoteRelease({ channel: 'live', seq: 999, actor: 't' }))).status).toBe(404);
    const miss = await refused(rel.promoteRelease({ channel: 'live', seq: 1, actor: 't', verify: () => ['x', 'y'] }));
    expect(miss).toMatchObject({ status: 409, extra: { missing: ['x', 'y'], count: 2 } });
    expect(await rel.channelPointer('live', 1)).toBeNull();
    const r = await rel.promoteRelease({ channel: 'live', seq: 1, actor: 'admin-1', verify: () => [] });
    expect(r).toMatchObject({ channel: 'live', abi: 1, seq: 1, rollout: 100, prev: null, reissued: false, origin: 1, changed: true, was: null });
  });

  it('раскатка: новый релиз на 10% поверх прежнего; процент только растёт; посреди раскатки другой релиз — 409', async () => {
    if (!alive) return;
    const b = await rel.recordRelease(R(M('b')));
    expect(b).toMatchObject({ fresh: true });
    const p10 = await rel.promoteRelease({ channel: 'live', seq: b.seq, percent: 10, actor: 't' });
    expect(p10).toMatchObject({ seq: b.seq, rollout: 10, prev: 1, reissued: false, was: { seq: 1, rollout: 100, prev: null } });
    expect(await rel.channelPointer('live', 1)).toMatchObject({
      seq: b.seq, manifest: M('b'), rollout: 10, prev: { seq: 1, manifest: M('a'), manifestSize: 100 },
    });
    expect((await refused(rel.promoteRelease({ channel: 'live', seq: b.seq, percent: 5, actor: 't' }))).status).toBe(409);
    expect(await rel.promoteRelease({ channel: 'live', seq: b.seq, percent: 50, actor: 't' })).toMatchObject({ rollout: 50, prev: 1, changed: true });
    expect(await rel.promoteRelease({ channel: 'live', seq: b.seq, percent: 50, actor: 't' })).toMatchObject({ changed: false });
    const c = await rel.recordRelease(R(M('c')));
    expect((await refused(rel.promoteRelease({ channel: 'live', seq: c.seq, actor: 't' }))).message).toContain('идёт раскатка');
  });

  it('откат: канал на прежнем содержимом под НОВЫМ номером (больше всех), раскатка снята; второй щелчок — некуда', async () => {
    if (!alive) return;
    const before = (await rel.channelPointer('live', 1))!;
    const top = await maxSeq();
    const r = await rel.rollbackChannel({ channel: 'live', abi: 1, actor: 't', verify: () => [] });
    expect(r.seq).toBeGreaterThan(top);
    expect(r.seq).toBeGreaterThan(before.seq);
    expect(r).toMatchObject({ rollout: 100, prev: null, reissued: true, origin: 1, was: { seq: before.seq, rollout: 50, prev: 1 } });
    const now = (await rel.channelPointer('live', 1))!;
    expect(now).toMatchObject({ seq: r.seq, manifest: M('a'), rollout: 100, prev: null });
    const info = (await rel.getRelease(r.seq))!;
    expect(info).toMatchObject({ manifest: M('a'), origin: 1, abi: 1 });
    expect(info.note).toContain('откат live');
    expect((await refused(rel.rollbackChannel({ channel: 'live', abi: 1, actor: 't' }))).status).toBe(409);
    expect((await refused(rel.rollbackChannel({ channel: 'live', abi: 1, toSeq: 1, actor: 't' }))).message).toContain('уже на содержимом');
    // ⭐ Д3 (проверка): «откат» к содержимому НОВЕЕ текущего — это выпуск в обход раскатки, отказ
    expect((await refused(rel.rollbackChannel({ channel: 'live', abi: 1, toSeq: before.seq, actor: 't', verify: () => [] }))).message).toContain('откат только назад');
    expect((await refused(rel.rollbackChannel({ channel: 'beta', abi: 1, actor: 't' }))).status).toBe(404);
    expect((await refused(rel.rollbackChannel({ channel: 'dev', abi: 1, actor: 't' }))).status).toBe(400);
  });

  it('повторная нарезка того же содержимого не трогает dev; содержимое, вернувшееся назад, — новый номер dev, а не старый релиз', async () => {
    if (!alive) return;
    const dev = (await rel.channelPointer('dev', 1))!;
    expect(dev.manifest).toBe(M('c'));
    expect(await rel.recordRelease(R(M('c')))).toEqual({ seq: dev.seq, fresh: false });
    expect((await rel.channelPointer('dev', 1))!.seq).toBe(dev.seq);
    // содержимое A уже лежит под номером 1 и под перевыпуском отката live — dev получает свой, больший номер
    const top = await maxSeq();
    const back = await rel.recordRelease(R(M('a')));
    expect(back.fresh).toBe(true);
    expect(back.seq).toBeGreaterThan(top);
    expect(await rel.channelPointer('dev', 1)).toMatchObject({ seq: back.seq, manifest: M('a'), rollout: 100, prev: { seq: dev.seq } });
    expect((await rel.channelPointer('live', 1))!.manifest).toBe(M('a'));
  });

  it('выпуск старого релиза — перевыпуск под новым номером; то же содержимое, что у канала, — без изменений', async () => {
    if (!alive) return;
    const live = (await rel.channelPointer('live', 1))!;
    expect(await rel.promoteRelease({ channel: 'live', seq: 1, actor: 't' })).toMatchObject({ seq: live.seq, changed: false });
    const bSeq = (await pool.q1<{ seq: string }>(`SELECT min(seq) AS seq FROM content_releases WHERE manifest = $1`, [M('b')]))!.seq;
    const top = await maxSeq();
    const r = await rel.promoteRelease({ channel: 'live', seq: Number(bSeq), actor: 't', verify: () => [] });
    expect(r).toMatchObject({ reissued: true, origin: Number(bSeq), prev: live.seq, rollout: 100 });
    expect(r.seq).toBeGreaterThan(top);
    expect((await rel.channelPointer('live', 1))!.manifest).toBe(M('b'));
  });

  it('два отката разом — один проходит, второй видит уже снятый прежний (409): действия идут по одному', async () => {
    if (!alive) return;
    const rs = await Promise.allSettled([
      rel.rollbackChannel({ channel: 'live', abi: 1, actor: 'a' }), rel.rollbackChannel({ channel: 'live', abi: 1, actor: 'b' }),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const no = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((no.reason as InstanceType<typeof rules.ChannelOpError>).status).toBe(409);
  });

  it('версии клиента: на канал+ABI; min выше latest — 400; канала нет — 404; dev — можно; новая нарезка их не сбрасывает', async () => {
    if (!alive) return;
    expect((await refused(rel.setChannelClients({ channel: 'live', abi: 1, minClient: 130, latestClient: 121, actor: 't' }))).status).toBe(400);
    expect((await refused(rel.setChannelClients({ channel: 'beta', abi: 1, minClient: 1, actor: 't' }))).status).toBe(404);
    expect((await refused(rel.setChannelClients({ channel: 'live', abi: 1, actor: 't' }))).status).toBe(400);
    expect(await rel.setChannelClients({ channel: 'live', abi: 1, minClient: 118, latestClient: 121, actor: 't' })).toMatchObject({ minClient: 118, latestClient: 121, changed: true });
    expect(await rel.setChannelClients({ channel: 'live', abi: 1, latestClient: 121, actor: 't' })).toMatchObject({ minClient: 118, changed: false });
    expect(await rel.channelPointer('live', 1)).toMatchObject({ minClient: 118, latestClient: 121 });
    await rel.setChannelClients({ channel: 'dev', abi: 1, minClient: 5, actor: 't' });
    await rel.recordRelease(R(M('e')));
    expect(await rel.channelPointer('dev', 1)).toMatchObject({ manifest: M('e'), minClient: 5 });
  });

  it('список: последние релизы и каждый, на который указывает канал (даже за пределом), со ссылками каналов', async () => {
    if (!alive) return;
    await rel.promoteRelease({ channel: 'beta', seq: 1, actor: 't' });
    const devSeq = (await rel.channelPointer('dev', 1))!.seq;
    await rel.promoteRelease({ channel: 'beta', seq: devSeq, percent: 25, actor: 't', verify: () => [] });
    const list = await rel.listReleases({ limit: 1 });
    expect(list.releases[0]!.seq).toBe(await maxSeq());
    const live = list.channels.find((c) => c.channel === 'live')!;
    const beta = list.channels.find((c) => c.channel === 'beta')!;
    expect(beta).toMatchObject({ seq: devSeq, prev: 1, rollout: 25, auto: false, updatedBy: 't' });
    expect(list.channels.find((c) => c.channel === 'dev')).toMatchObject({ auto: true, updatedBy: 'cutter', minClient: 5 });
    const seqs = list.releases.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    for (const s of [live.seq, beta.seq, 1]) expect(seqs).toContain(s);
    const one = list.releases.find((r) => r.seq === 1)!;
    expect(one.channels).toContainEqual({ channel: 'beta', as: 'prev', percent: 75 });
    expect(list.releases.find((r) => r.seq === devSeq)!.channels).toEqual(expect.arrayContaining([
      { channel: 'dev', as: 'current', percent: 100 }, { channel: 'beta', as: 'current', percent: 25 },
    ]));
  });

  it('корни уборки: манифесты последних N релизов и всех указателей каналов', async () => {
    if (!alive) return;
    const roots = new Set(await rel.gcRoots(1));
    const top = (await rel.getRelease(await maxSeq()))!;
    expect(roots.has(top.manifest)).toBe(true);
    for (const ch of ['dev', 'live', 'beta']) {
      const p = (await rel.channelPointer(ch, 1))!;
      expect(roots.has(p.manifest)).toBe(true);
      if (p.prev) expect(roots.has(p.prev.manifest)).toBe(true);
    }
  });
});
