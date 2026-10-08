import { createHash } from 'node:crypto';

/**
 * ⭐ 08.10 (Д3, план «Обновление контента без пересборки клиента»): ПРАВИЛА КАНАЛОВ — чистые, без базы и express (их делят
 * `releaseDb.ts` и `net/releaseRoutes.ts`, и они проверяются тестом без Postgres).
 *
 *  • `dev` меняется САМ (нарезчик на каждой правке), `beta` и `live` — только кнопкой администратора.
 *  • Раскатка: у канала новый релиз `seq`, процент `rollout` и прежний релиз `prev` — его получают те, кто вне процента. Корзина
 *    устройства — `sha256("<id>|<channel>|<seq>")`: первые 4 байта как беззнаковое целое (big-endian) по модулю 100; меньше процента —
 *    новый релиз. От номера зависит, поэтому каждая раскатка тасует заново, а внутри одной раскатки (10% → 50% → 100%) корзина та же —
 *    попавший раньше остаётся с новым. Без `id` — новый только при 100%.
 *  • Клиент: `build < minClient` — «нужен новый клиент» (экран «Обновите игру»), `build < latestClient` — «доступно обновление».
 */
export const AUTO_CHANNEL = 'dev';
/** Каналы, которые выпускает администратор. */
export const ADMIN_CHANNELS: readonly string[] = ['beta', 'live'];
export const CHANNEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Отказ операции с каналом: код ответа и строка для человека. */
export class ChannelOpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

export function rolloutBucket(id: string, channel: string, seq: number): number {
  return createHash('sha256').update(`${id}|${channel}|${seq}`, 'utf8').digest().readUInt32BE(0) % 100;
}

export interface ReleaseRef { seq: number; manifest: string; manifestSize: number }

export interface Rollout extends ReleaseRef {
  rollout: number;
  prev: ReleaseRef | null;
}

/** Какой релиз отдать этому устройству. Прежнего нет — новый (раскатку поверх пустого канала `promote` не заводит). */
export function pickRelease(p: Rollout, channel: string, id: string | undefined): ReleaseRef {
  const fresh: ReleaseRef = { seq: p.seq, manifest: p.manifest, manifestSize: p.manifestSize };
  if (p.rollout >= 100 || !p.prev) return fresh;
  if (id === undefined) return p.prev;
  return rolloutBucket(id, channel, p.seq) < p.rollout ? fresh : p.prev;
}

export interface ClientGate { required: boolean; outdated: boolean }

/** `build` не прислан — 0: старый клиент без номера сборки не докажет, что он не ниже `minClient`. */
export function clientGate(build: number, minClient: number, latestClient: number): ClientGate {
  return { required: minClient > 0 && build < minClient, outdated: latestClient > 0 && build < latestClient };
}

/** Процент раскатки: целое 0..100. */
export function parsePercent(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 ? v : null;
}

/** Потолок номера сборки клиента (`min_client`/`latest_client` — колонки `integer`). */
export const CLIENT_BUILD_MAX = 2_147_483_647;

/** Номер (релиза, сборки): целое ≥ 0 в пределах точного double. */
export function parseCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}
