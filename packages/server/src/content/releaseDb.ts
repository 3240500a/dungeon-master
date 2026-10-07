import { applySchema, tx, withSchemaLock, q1 } from '../db/pool.js';

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

/** Своя консультативная блокировка схемы (как у кластера) — процессы стартуют разом. */
const SCHEMA_LOCK = 947_213_003;
/** Блокировка записи релиза: два нарезчика (два процесса на одной базе) не заводят двух релизов одного содержимого. */
const CUT_LOCK = 947_213_004;

export async function initContentSchema(): Promise<void> {
  await withSchemaLock(SCHEMA_LOCK, (c) => applySchema(c, 'content', [SCHEMA_CONTENT]));
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
 */
export async function recordRelease(r: ReleaseRecord, channel = 'dev', now = Date.now()): Promise<Recorded> {
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
      `INSERT INTO content_channels (channel, abi, seq, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel, abi) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`,
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
}

/** Указатель канала для ABI или `null` — релиза нет. */
export async function channelPointer(channel: string, abi: number): Promise<ChannelPointer | null> {
  const row = await q1<{ seq: string; manifest: string; manifest_size: number; min_client: number; latest_client: number }>(
    `SELECT r.seq, r.manifest, r.manifest_size, ch.min_client, ch.latest_client
       FROM content_channels ch JOIN content_releases r ON r.seq = ch.seq
      WHERE ch.channel = $1 AND ch.abi = $2`, [channel, abi]);
  if (!row) return null;
  return {
    channel, seq: Number(row.seq), manifest: row.manifest, manifestSize: row.manifest_size,
    minClient: row.min_client, latestClient: row.latest_client,
  };
}
