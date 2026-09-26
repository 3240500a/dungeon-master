import { configEtagOf } from '../configEtag.js';

/** Готовое тело ответа и его ETag. */
export interface CachedBody { body: string; etag: string }

/**
 * ⭐ R6-20: ТЕЛО АНОНИМНОЙ РУЧКИ — ИЗ КЭША. `GET /api/pose` на каждый запрос читал из базы весь `pose_store` (сотни КБ) и
 * сериализовал его заново, `GET /api/cluster` на каждый запрос спрашивал базу об узлах: поток анонимных GET становился
 * нагрузкой общей базы и главного потока. Здесь тело собирается одно на срок `ttlMs` — и одно на все запросы, пришедшие,
 * пока оно собирается; `invalidate` (запись этим процессом) — следующее чтение свежее, а собранное до записи не кладётся.
 * Упавшее чтение не кэшируется: ошибка — тем, кто его ждал, следующий запрос читает заново. `now` — для теста.
 */
export function cachedJson(
  load: () => Promise<unknown>, ttlMs: number, now: () => number = () => performance.now(),
): { get(): Promise<CachedBody>; invalidate(): void } {
  let cur: { at: number; value: CachedBody } | null = null;
  let pending: Promise<CachedBody> | null = null;
  let gen = 0;
  return {
    get(): Promise<CachedBody> {
      if (cur && now() - cur.at <= ttlMs) return Promise.resolve(cur.value);
      if (pending) return pending;
      const my = gen;
      const at = now();
      const p: Promise<CachedBody> = load().then((v) => {
        const body = JSON.stringify(v);
        const value = { body, etag: configEtagOf(body) };
        if (my === gen) cur = { at, value };   // сброшен, пока читали, — прочитанное могло быть до записи
        return value;
      }).finally(() => { if (pending === p) pending = null; });
      pending = p;
      return p;
    },
    invalidate(): void { gen++; cur = null; pending = null; },
  };
}
