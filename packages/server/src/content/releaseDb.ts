import type pg from 'pg';
import { applySchema, tx, withSchemaLock, q, q1 } from '../db/pool.js';
import { ADMIN_CHANNELS, AUTO_CHANNEL, CHANNEL_RE, ChannelOpError, type ReleaseRef } from './channelRules.js';

/**
 * ⭐ 08.10 (Д1): РЕЛИЗЫ И КАНАЛЫ КОНТЕНТА В БАЗЕ. Релиз — неизменная запись «номер → хэш манифеста» (файлы лежат в хранилище по хэшу,
 * `blobStore.ts`); канал (`dev`, позже `beta`/`live` — ветки Steam) — указатель на релиз своей ABI. Откат = указатель снова на прошлый
 * релиз; номер при этом растёт (на него опрётся защита от подставного старого релиза, Д3). Все процессы читают одно и то же.
 */
const SCHEMA_CONTENT = `
    CREATE TABLE IF NOT EXISTS content_releases (
      seq           bigserial PRIMARY KEY,
      abi           integer NOT NULL,
      manifest      text NOT NULL,
      manifest_size integer NOT NULL,
      config_rev    text NOT NULL,
      game_rev      text NOT NULL,
      created_at    bigint NOT NULL,
      note          text NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS content_releases_manifest ON content_releases (manifest);
    CREATE TABLE IF NOT EXISTS content_channels (
      channel       text NOT NULL,
      abi           integer NOT NULL,
      seq           bigint NOT NULL REFERENCES content_releases (seq),
      rollout       integer NOT NULL DEFAULT 100,
      min_client    integer NOT NULL DEFAULT 0,
      latest_client integer NOT NULL DEFAULT 0,
      updated_at    bigint NOT NULL,
      PRIMARY KEY (channel, abi)
    );
  `;

/**
 * ⭐ 08.10 (Д3, план «Обновление контента без пересборки клиента»): РАСКАТКА, ОТКАТ, ВЕРСИИ КЛИЕНТА — миграция ТОЛЬКО ДОБАВЛЯЮЩАЯ и
 * своей частью (текст первой не тронут: новая база получает таблицы из неё, колонки — отсюда; на базе Д1 — только колонки). Старые
 * строки: `rollout` 100, `min_client`/`latest_client` 0, прежнего релиза нет. Колонки, что уже были у Д1, — для базы, заведённой
 * черновиком без них (на базе Д1 строки — пустые операции).
 *  • `content_channels.prev_seq` — прежний релиз канала: его получают те, кто вне процента раскатки, на него откатывает «Откатить».
 *  • `content_channels.updated_by` — кто менял последним (`cutter` — нарезчик, `key` — ключ процессов, иначе id администратора).
 *  • `content_releases.origin_seq` — у перевыпуска (откат, выпуск старого релиза): чей манифест он несёт. Файлы не копируются — та же
 *    запись хэша манифеста под новым номером.
 */
const SCHEMA_CONTENT_D3 = `
    ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS rollout integer NOT NULL DEFAULT 100;
    ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS prev_seq bigint REFERENCES content_releases (seq);
    ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS min_client integer NOT NULL DEFAULT 0;
    ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS latest_client integer NOT NULL DEFAULT 0;
    ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT '';
    ALTER TABLE content_releases ADD COLUMN IF NOT EXISTS origin_seq bigint;
  `;

/** Своя консультативная блокировка схемы (как у кластера) — процессы стартуют разом. */
const SCHEMA_LOCK = 947_213_003;
/**
 * Блокировка записи релиза: два нарезчика (два процесса на одной базе) не заводят двух релизов одного содержимого. ⭐ Д3: её же берут
 * действия администратора с каналами — нарезка и выпуск идут по одному.
 */
const CUT_LOCK = 947_213_004;

export async function initContentSchema(): Promise<void> {
  await withSchemaLock(SCHEMA_LOCK, (c) => applySchema(c, 'content', [SCHEMA_CONTENT, SCHEMA_CONTENT_D3]));
}

export interface ReleaseRecord {
  abi: number;
  manifest: string;
  manifestSize: number;
  configRev: string;
  gameRev: string;
  note?: string;
}

export interface Recorded { seq: number; fresh: boolean }

/**
 * Записать релиз и перевести на него канал. Канал уже смотрит на релиз с тем же манифестом — ничего не заводим (`fresh: false`): одно
 * содержимое — один релиз. Порядок по плану: файлы уже в хранилище (их кладёт нарезчик ДО записи), здесь — запись и указатель одной
 * транзакцией.
 * ⭐ Д3: сверка — только с указателем ЭТОГО канала (не «есть ли где-то релиз с таким манифестом»): перевыпуск при откате `live` несёт
 * старый манифест под новым номером, и поиск по манифесту увёл бы `dev` назад. Новый релиз канала — на 100%, прежний — в `prev_seq`.
 */
export async function recordRelease(r: ReleaseRecord, channel = AUTO_CHANNEL, now = Date.now()): Promise<Recorded> {
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [CUT_LOCK]);
    const cur = await c.query<{ seq: string; manifest: string }>(
      `SELECT r.seq, r.manifest FROM content_channels ch JOIN content_releases r ON r.seq = ch.seq
        WHERE ch.channel = $1 AND ch.abi = $2`, [channel, r.abi]);
    const row = cur.rows[0];
    if (row && row.manifest === r.manifest) return { seq: Number(row.seq), fresh: false };
    const ins = await c.query<{ seq: string }>(
      `INSERT INTO content_releases (abi, manifest, manifest_size, config_rev, game_rev, created_at, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING seq`,
      [r.abi, r.manifest, r.manifestSize, r.configRev, r.gameRev, now, r.note ?? '']);
    const seq = Number(ins.rows[0]!.seq);
    await c.query(
      `INSERT INTO content_channels (channel, abi, seq, rollout, prev_seq, updated_at, updated_by) VALUES ($1, $2, $3, 100, NULL, $4, 'cutter')
       ON CONFLICT (channel, abi) DO UPDATE SET seq = excluded.seq, rollout = 100, prev_seq = content_channels.seq,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [channel, r.abi, seq, now]);
    return { seq, fresh: true };
  });
}

export interface ChannelPointer {
  channel: string;
  seq: number;
  manifest: string;
  manifestSize: number;
  minClient: number;
  latestClient: number;
  /** ⭐ Д3: процент раскатки `seq` (0..100); остальным — `prev`. */
  rollout: number;
  /** ⭐ Д3: прежний релиз канала (тем, кто вне процента; цель «Откатить»); при 100% не раздаётся. */
  prev: ReleaseRef | null;
}

/** Указатель канала для ABI или `null` — релиза нет. */
export async function channelPointer(channel: string, abi: number): Promise<ChannelPointer | null> {
  const row = await q1<{
    seq: string; manifest: string; manifest_size: number; min_client: number; latest_client: number; rollout: number;
    prev_seq: string | null; prev_manifest: string | null; prev_size: number | null;
  }>(
    `SELECT r.seq, r.manifest, r.manifest_size, ch.min_client, ch.latest_client, ch.rollout,
            p.seq AS prev_seq, p.manifest AS prev_manifest, p.manifest_size AS prev_size
       FROM content_channels ch JOIN content_releases r ON r.seq = ch.seq
       LEFT JOIN content_releases p ON p.seq = ch.prev_seq
      WHERE ch.channel = $1 AND ch.abi = $2`, [channel, abi]);
  if (!row) return null;
  return {
    channel, seq: Number(row.seq), manifest: row.manifest, manifestSize: row.manifest_size,
    minClient: row.min_client, latestClient: row.latest_client, rollout: row.rollout,
    prev: row.prev_seq !== null && row.prev_manifest !== null
      ? { seq: Number(row.prev_seq), manifest: row.prev_manifest, manifestSize: row.prev_size ?? 0 } : null,
  };
}

// ── ⭐ Д3: действия администратора с каналами ──────────────────────────────────────────────────────────────────────────────────

export interface ReleaseInfo {
  seq: number;
  abi: number;
  manifest: string;
  manifestSize: number;
  configRev: string;
  gameRev: string;
  /** Время записи, мс эпохи. */
  created: number;
  note: string;
  /** Перевыпуск: номер релиза, чей манифест он несёт; `null` — релиз нарезан сам. */
  origin: number | null;
}

type ReleaseRow = {
  seq: string; abi: number; manifest: string; manifest_size: number; config_rev: string; game_rev: string;
  created_at: string; note: string; origin_seq: string | null;
};
const RELEASE_COLS = 'seq, abi, manifest, manifest_size, config_rev, game_rev, created_at, note, origin_seq';
const releaseOf = (r: ReleaseRow): ReleaseInfo => ({
  seq: Number(r.seq), abi: r.abi, manifest: r.manifest, manifestSize: r.manifest_size, configRev: r.config_rev, gameRev: r.game_rev,
  created: Number(r.created_at), note: r.note, origin: r.origin_seq === null ? null : Number(r.origin_seq),
});

export async function getRelease(seq: number): Promise<ReleaseInfo | null> {
  const r = await q1<ReleaseRow>(`SELECT ${RELEASE_COLS} FROM content_releases WHERE seq = $1`, [seq]);
  return r ? releaseOf(r) : null;
}

interface ChannelState {
  channel: string; abi: number; seq: number; manifest: string; prev: number | null; rollout: number;
  minClient: number; latestClient: number;
}

/** Состояние канала под блокировкой строки (внутри транзакции с `CUT_LOCK`). */
async function channelIn(c: pg.PoolClient, channel: string, abi: number): Promise<ChannelState | null> {
  const r = await c.query<{ seq: string; manifest: string; prev_seq: string | null; rollout: number; min_client: number; latest_client: number }>(
    `SELECT ch.seq, r.manifest, ch.prev_seq, ch.rollout, ch.min_client, ch.latest_client
       FROM content_channels ch JOIN content_releases r ON r.seq = ch.seq
      WHERE ch.channel = $1 AND ch.abi = $2 FOR UPDATE OF ch`, [channel, abi]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    channel, abi, seq: Number(row.seq), manifest: row.manifest, prev: row.prev_seq === null ? null : Number(row.prev_seq),
    rollout: row.rollout, minClient: row.min_client, latestClient: row.latest_client,
  };
}

async function releaseIn(c: pg.PoolClient, seq: number): Promise<ReleaseInfo | null> {
  const r = await c.query<ReleaseRow>(`SELECT ${RELEASE_COLS} FROM content_releases WHERE seq = $1`, [seq]);
  return r.rows[0] ? releaseOf(r.rows[0]) : null;
}

/**
 * ПЕРЕВЫПУСК: новая запись с тем же манифестом под новым номером (`bigserial` — больше всех прежних). Так канал возвращается к старому
 * содержимому, а номер у клиента только растёт; файлы не дублируются — запись лишь ссылается на тот же хэш манифеста.
 */
async function reissue(c: pg.PoolClient, rel: ReleaseInfo, note: string, now: number): Promise<number> {
  const ins = await c.query<{ seq: string }>(
    `INSERT INTO content_releases (abi, manifest, manifest_size, config_rev, game_rev, created_at, note, origin_seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING seq`,
    [rel.abi, rel.manifest, rel.manifestSize, rel.configRev, rel.gameRev, now, note, rel.origin ?? rel.seq]);
  return Number(ins.rows[0]!.seq);
}

/** Итог действия с каналом. */
export interface ChannelChange {
  channel: string;
  abi: number;
  /** Релиз канала после действия. */
  seq: number;
  rollout: number;
  prev: number | null;
  minClient: number;
  latestClient: number;
  /** Номер — перевыпуск (новая запись старого манифеста): откат или выпуск релиза не новее текущего. */
  reissued: boolean;
  /** Чьё содержимое несёт канал (номер нарезанного релиза; у перевыпуска — исходного). */
  origin: number;
  /** `false` — так уже и было, ничего не записано. */
  changed: boolean;
  /** Как было до действия; `null` — канал выпущен впервые. */
  was: { seq: number; rollout: number; prev: number | null } | null;
}

/** Проверка файлов релиза в хранилище: список недостающих (пустой — всё на месте). */
export type VerifyFiles = (manifest: string) => string[];

function assertAdminChannel(channel: string): void {
  if (channel === AUTO_CHANNEL) throw new ChannelOpError(400, `канал ${AUTO_CHANNEL} меняется сам, на каждой нарезке — кнопкой его не трогаем`);
  if (!ADMIN_CHANNELS.includes(channel)) throw new ChannelOpError(400, `канал — один из: ${ADMIN_CHANNELS.join(', ')}`);
}

function checkFiles(verify: VerifyFiles | undefined, rel: ReleaseInfo): void {
  const missing = verify ? verify(rel.manifest) : [];
  if (missing.length) {
    throw new ChannelOpError(409, `у релиза #${rel.seq} нет файлов в хранилище (${missing.length}) — выпускать нечего`, { missing: missing.slice(0, 10), count: missing.length });
  }
}

const stateOf = (s: ChannelState): ChannelChange['was'] => ({ seq: s.seq, rollout: s.rollout, prev: s.prev });

export interface PromoteInput {
  channel: string;
  seq: number;
  /** Процент раскатки 0..100; нет — 100. */
  percent?: number;
  /** Кто (для `updated_by` и лога). */
  actor: string;
  verify?: VerifyFiles;
  now?: number;
}

/**
 * ВЫПУСК РЕЛИЗА В КАНАЛ (`beta`/`live`), ABI — релиза.
 *  • Канал не выпущен — релиз на 100% (раскатка по процентам — только поверх прежнего релиза: вне процента иначе давать нечего).
 *  • Тот же манифест, что у канала, — меняется только процент, и только вверх (10 → 50 → 100); вниз — «Откатить».
 *  • Новое содержимое — только когда прежняя раскатка доведена до 100%: прежним (`prev`) становится текущий релиз. Номер релиза не
 *    больше текущего (выпуск старого) — перевыпуск под новым номером: номер канала только растёт.
 */
export async function promoteRelease(i: PromoteInput): Promise<ChannelChange> {
  assertAdminChannel(i.channel);
  const percent = i.percent ?? 100;
  const now = i.now ?? Date.now();
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [CUT_LOCK]);
    const rel = await releaseIn(c, i.seq);
    if (!rel) throw new ChannelOpError(404, `релиза #${i.seq} нет`);
    const origin = rel.origin ?? rel.seq;
    const cur = await channelIn(c, i.channel, rel.abi);
    if (!cur) {
      if (percent < 100) {
        throw new ChannelOpError(409, `канал ${i.channel} (ABI ${rel.abi}) ещё не выпущен — первый выпуск только на 100%: тем, кто вне процента, давать нечего`);
      }
      checkFiles(i.verify, rel);
      await c.query(
        `INSERT INTO content_channels (channel, abi, seq, rollout, prev_seq, updated_at, updated_by) VALUES ($1, $2, $3, 100, NULL, $4, $5)`,
        [i.channel, rel.abi, rel.seq, now, i.actor]);
      return { channel: i.channel, abi: rel.abi, seq: rel.seq, rollout: 100, prev: null, minClient: 0, latestClient: 0, reissued: false, origin, changed: true, was: null };
    }
    const same = { channel: i.channel, abi: rel.abi, minClient: cur.minClient, latestClient: cur.latestClient, was: stateOf(cur) };
    if (rel.manifest === cur.manifest) {
      if (percent < cur.rollout) {
        throw new ChannelOpError(409, `процент раскатки только растёт (${cur.rollout}% → ${percent}%) — вернуть прежний релиз: «Откатить»`);
      }
      const curOrigin = (await releaseIn(c, cur.seq))?.origin ?? cur.seq;
      if (percent === cur.rollout) return { ...same, seq: cur.seq, rollout: cur.rollout, prev: cur.prev, reissued: false, origin: curOrigin, changed: false };
      await c.query(`UPDATE content_channels SET rollout = $3, updated_at = $4, updated_by = $5 WHERE channel = $1 AND abi = $2`,
        [i.channel, rel.abi, percent, now, i.actor]);
      return { ...same, seq: cur.seq, rollout: percent, prev: cur.prev, reissued: false, origin: curOrigin, changed: true };
    }
    if (cur.rollout < 100) {
      throw new ChannelOpError(409, `в ${i.channel} идёт раскатка #${cur.seq} (${cur.rollout}%) — доведи её до 100% или откати`);
    }
    checkFiles(i.verify, rel);
    const reissued = rel.seq <= cur.seq;
    const target = reissued ? await reissue(c, rel, `выпуск в ${i.channel}: содержимое #${origin} заново (номер канала только растёт)`, now) : rel.seq;
    await c.query(
      `UPDATE content_channels SET seq = $3, prev_seq = $4, rollout = $5, updated_at = $6, updated_by = $7 WHERE channel = $1 AND abi = $2`,
      [i.channel, rel.abi, target, cur.seq, percent, now, i.actor]);
    return { ...same, seq: target, rollout: percent, prev: cur.seq, reissued, origin, changed: true };
  });
}

export interface RollbackInput {
  channel: string;
  abi: number;
  /** Куда; нет — прежний релиз канала (`prev`). */
  toSeq?: number;
  actor: string;
  verify?: VerifyFiles;
  now?: number;
}

/**
 * ОТКАТ КАНАЛА: канал снова на содержимом прежнего релиза (или `toSeq`), на 100%, — ПЕРЕВЫПУСКОМ под новым номером: клиент, уже
 * взявший плохой релиз, видит номер больше своего и принимает откат, а подставной старый указатель (номер меньше) отвергает. Идущая
 * раскатка откатом снимается. Прежнего у канала после отката нет: второй щелчок «Откатить» не вернёт плохой релиз (нужен `toSeq`).
 */
export async function rollbackChannel(i: RollbackInput): Promise<ChannelChange> {
  assertAdminChannel(i.channel);
  const now = i.now ?? Date.now();
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [CUT_LOCK]);
    const cur = await channelIn(c, i.channel, i.abi);
    if (!cur) throw new ChannelOpError(404, `канал ${i.channel} (ABI ${i.abi}) не выпущен — откатывать нечего`);
    const toSeq = i.toSeq ?? cur.prev;
    if (toSeq === null || toSeq === undefined) throw new ChannelOpError(409, `откатывать некуда: у ${i.channel} нет прежнего релиза — укажи toSeq`);
    const rel = await releaseIn(c, toSeq);
    if (!rel) throw new ChannelOpError(404, `релиза #${toSeq} нет`);
    if (rel.abi !== i.abi) throw new ChannelOpError(409, `релиз #${toSeq} другой ABI (${rel.abi}, канал — ${i.abi})`);
    if (rel.manifest === cur.manifest) throw new ChannelOpError(409, `${i.channel} уже на содержимом #${rel.origin ?? rel.seq}`);
    checkFiles(i.verify, rel);
    // ⭐ Д3 (проверка): откат — только к СОДЕРЖИМОМУ СТАРШЕ текущего (по исходному номеру: перевыпуск старого под новым номером — тоже назад);
    // новее — это выпуск (там правила раскатки), а не «откат на 100% в обход»
    const curRel = await releaseIn(c, cur.seq);
    const curOrigin = curRel ? (curRel.origin ?? curRel.seq) : cur.seq;
    if ((rel.origin ?? rel.seq) > curOrigin) throw new ChannelOpError(409, `откат только назад: содержимое #${rel.origin ?? rel.seq} новее текущего #${curOrigin} — для нового содержимого «Выпустить»`);
    const origin = rel.origin ?? rel.seq;
    const reissued = rel.seq <= cur.seq;
    const target = reissued ? await reissue(c, rel, `откат ${i.channel}: #${cur.seq} → содержимое #${origin}`, now) : rel.seq;
    await c.query(
      `UPDATE content_channels SET seq = $3, prev_seq = NULL, rollout = 100, updated_at = $4, updated_by = $5 WHERE channel = $1 AND abi = $2`,
      [i.channel, i.abi, target, now, i.actor]);
    return {
      channel: i.channel, abi: i.abi, seq: target, rollout: 100, prev: null, minClient: cur.minClient, latestClient: cur.latestClient,
      reissued, origin, changed: true, was: stateOf(cur),
    };
  });
}

export interface ClientsInput {
  channel: string;
  abi: number;
  minClient?: number;
  latestClient?: number;
  actor: string;
  now?: number;
}

/**
 * ВЕРСИИ КЛИЕНТА КАНАЛА: `minClient` — ниже экран «Обновите игру» (`clientRequired` указателя), `latestClient` — ниже плашка «Доступно
 * обновление» (`clientOutdated`); 0 — не задано. Любой канал, и `dev` тоже (стенд экрана обновления): это не указатель релиза.
 */
export async function setChannelClients(i: ClientsInput): Promise<ChannelChange> {
  if (!CHANNEL_RE.test(i.channel)) throw new ChannelOpError(400, 'канал');
  if (i.minClient === undefined && i.latestClient === undefined) throw new ChannelOpError(400, 'нужен minClient или latestClient');
  const now = i.now ?? Date.now();
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [CUT_LOCK]);
    const cur = await channelIn(c, i.channel, i.abi);
    if (!cur) throw new ChannelOpError(404, `канал ${i.channel} (ABI ${i.abi}) не выпущен`);
    const min = i.minClient ?? cur.minClient;
    const latest = i.latestClient ?? cur.latestClient;
    if (latest > 0 && min > latest) throw new ChannelOpError(400, `minClient (${min}) выше latestClient (${latest})`);
    const origin = (await releaseIn(c, cur.seq))?.origin ?? cur.seq;
    const base = { channel: i.channel, abi: i.abi, seq: cur.seq, rollout: cur.rollout, prev: cur.prev, reissued: false, origin, was: stateOf(cur) };
    if (min === cur.minClient && latest === cur.latestClient) return { ...base, minClient: min, latestClient: latest, changed: false };
    await c.query(
      `UPDATE content_channels SET min_client = $3, latest_client = $4, updated_at = $5, updated_by = $6 WHERE channel = $1 AND abi = $2`,
      [i.channel, i.abi, min, latest, now, i.actor]);
    return { ...base, minClient: min, latestClient: latest, changed: true };
  });
}

export interface ListedChannel {
  channel: string;
  abi: number;
  seq: number;
  prev: number | null;
  rollout: number;
  minClient: number;
  latestClient: number;
  /** Мс эпохи. */
  updated: number;
  updatedBy: string;
  /** `dev` — меняется сам. */
  auto: boolean;
}

export interface ListedRelease extends ReleaseInfo {
  /** Каналы, что указывают на релиз: `current` — его раздают `percent`% канала, `prev` — остальным (при 100% — 0: цель отката). */
  channels: Array<{ channel: string; as: 'current' | 'prev'; percent: number }>;
}

export interface ReleaseList { releases: ListedRelease[]; channels: ListedChannel[] }

/** Последние `limit` релизов (номер вниз) и каждый, на который указывает канал, — со ссылками каналов. */
export async function listReleases(o: { abi?: number; limit?: number } = {}): Promise<ReleaseList> {
  const limit = Math.max(1, Math.min(500, o.limit ?? 50));
  const abi = o.abi ?? null;
  const chans = await q<{
    channel: string; abi: number; seq: string; prev_seq: string | null; rollout: number; min_client: number; latest_client: number;
    updated_at: string; updated_by: string;
  }>(
    `SELECT channel, abi, seq, prev_seq, rollout, min_client, latest_client, updated_at, updated_by FROM content_channels
      WHERE $1::integer IS NULL OR abi = $1 ORDER BY abi, channel`, [abi]);
  const channels: ListedChannel[] = chans.map((r) => ({
    channel: r.channel, abi: r.abi, seq: Number(r.seq), prev: r.prev_seq === null ? null : Number(r.prev_seq), rollout: r.rollout,
    minClient: r.min_client, latestClient: r.latest_client, updated: Number(r.updated_at), updatedBy: r.updated_by, auto: r.channel === AUTO_CHANNEL,
  }));
  const pinned = channels.flatMap((ch) => (ch.prev === null ? [ch.seq] : [ch.seq, ch.prev]));
  const rows = await q<ReleaseRow>(
    `(SELECT ${RELEASE_COLS} FROM content_releases WHERE $1::integer IS NULL OR abi = $1 ORDER BY seq DESC LIMIT $2)
     UNION SELECT ${RELEASE_COLS} FROM content_releases WHERE seq = ANY($3::bigint[])`, [abi, limit, pinned]);
  const releases: ListedRelease[] = rows.map((r) => ({ ...releaseOf(r), channels: [] }));
  releases.sort((a, b) => b.seq - a.seq);
  const bySeq = new Map(releases.map((r) => [r.seq, r]));
  for (const ch of channels) {
    bySeq.get(ch.seq)?.channels.push({ channel: ch.channel, as: 'current', percent: ch.rollout });
    if (ch.prev !== null) bySeq.get(ch.prev)?.channels.push({ channel: ch.channel, as: 'prev', percent: 100 - ch.rollout });
  }
  return { releases, channels };
}

/** Корни уборки хранилища: манифесты последних `keepReleases` релизов (всех ABI) и каждого указателя каналов — текущего и прежнего. */
/** ⭐ Д3 (проверка): выполнить `fn` под блокировкой нарезки/каналов (`CUT_LOCK`): уборка не идёт одновременно с выпуском или откатом. */
export async function withCutLock<T>(fn: () => Promise<T>): Promise<T> {
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [CUT_LOCK]);
    return fn();
  });
}

export async function gcRoots(keepReleases: number): Promise<string[]> {
  const rows = await q<{ manifest: string }>(
    `(SELECT manifest FROM content_releases ORDER BY seq DESC LIMIT $1)
     UNION SELECT r.manifest FROM content_channels ch JOIN content_releases r ON r.seq = ch.seq OR r.seq = ch.prev_seq`,
    [Math.max(1, keepReleases)]);
  return rows.map((r) => r.manifest);
}
