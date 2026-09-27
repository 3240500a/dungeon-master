import type { Express, Request, Response } from 'express';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ah } from './asyncRoute.js';
import { cachedJson, type CachedBody } from './cachedJson.js';

/**
 * АНОНИМНОЕ ЧТЕНИЕ АВТОРСКОГО КОНТЕНТА: `GET /api/pose` (тела поз-редактора), `GET /api/pose/rev` (их ревизии) и
 * `GET /api/assets/stats` (счётчики файлов ассетов для «Роадмапа»). Вынесено из `index.ts`, чтобы кэш стоял под тестом за
 * настоящим express: импорт `index.ts` поднимает сервер и лезет в базу (как `accountRoutes.ts`, `internalRoutes.ts`).
 *
 * ⭐ R6-20: тело `/api/pose` — из кэша (`cachedJson`), с ETag: раньше каждый анонимный GET читал из базы весь `pose_store`.
 * ⭐ R9-12: и его соседи. `/api/pose/rev` на каждый запрос спрашивал базу (`SELECT key, updated_at FROM pose_store`), а
 * `/api/assets/stats` синхронно обходил всё дерево ассетов (`readdirSync`/`statSync`) на главном потоке — том, что тикает
 * комнаты: ~0,5 мс сегодня (24 файла), ~8 мс при 480 файлах, а «Роадмап» ждёт сотни. Поток анонимных GET держал тики всех
 * комнат процесса. Теперь все три — из кэша на срок: чтение (обход, база) одно на срок и одно на все запросы, пришедшие, пока
 * оно идёт. Запись этим процессом (публикация поз, заливка ассета) кэш сбрасывает (`invalidate*`); записи соседних процессов
 * видны по сроку — как и прежде у тел поз.
 */

/** Сколько тела и ревизии поз отдаются из кэша, мс (R6-20). */
export const POSE_CACHE_MS = 5_000;
/** R9-12: сколько счётчики ассетов отдаются из кэша, мс: «Роадмап» их не торопит, а заливка своим процессом кэш сбрасывает. */
export const ASSET_STATS_CACHE_MS = 10_000;

/** Счётчики файлов ассетов: по расширению, по подпапке и суммарный объём. */
export interface AssetStats { byExt: Record<string, number>; byDir: Record<string, number>; bytes: number }

/**
 * СТАТИСТИКА ФАЙЛОВ АССЕТОВ — для вкладки «Роадмап» в редакторе: сколько моделей, текстур и звуков
 * реально лежит на сервере. Это позволяет пунктам роадмапа СЧИТАТЬ СЕБЯ САМИМ («звуков 0 из 200»),
 * вместо ручных галок, которые устаревают.
 *
 * Роут ЧИТАЮЩИЙ и без авторизации — в отличие от загрузки (`POST /api/dev/assets`): он отдаёт только
 * агрегаты (счётчики и суммарный объём), без имён файлов и содержимого.
 */
export function assetStats(dir: string): AssetStats {
  const byExt: Record<string, number> = {};
  const byDir: Record<string, number> = {};
  let bytes = 0;
  const walk = (abs: string, rel: string): void => {
    let entries: string[];
    try { entries = readdirSync(abs); } catch { return; }        // папку могли удалить между вызовами — не 500-им из-за этого
    for (const name of entries) {
      const full = join(abs, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, rel ? rel + '/' + name : name); continue; }
      const ext = (name.split('.').pop() ?? '').toLowerCase();
      byExt[ext] = (byExt[ext] ?? 0) + 1;
      if (rel) byDir[rel] = (byDir[rel] ?? 0) + 1;
      bytes += st.size;
    }
  };
  walk(dir, '');
  return { byExt, byDir, bytes };
}

/** Тело из кэша с ETag: совпал `If-None-Match` — 304 без тела. */
async function sendCached(req: Request, res: Response, cache: { get(): Promise<CachedBody> }): Promise<void> {
  const { body, etag } = await cache.get();
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
  res.type('application/json').send(body);
}

/**
 * Поставить ручки чтения контента. Источники — снаружи (`index.ts`: база и папка ассетов; тест — шпионы), `now` — часы кэша
 * (для теста). Возвращает сброс кэшей — его зовут ручки записи этого процесса.
 */
export function installContentReads(
  app: Express,
  o: {
    poseStore: () => Promise<unknown>;
    poseRevs: () => Promise<unknown>;
    assetStats: () => AssetStats;
    now?: () => number;
  },
): { invalidatePose(): void; invalidateAssets(): void } {
  const poseBody = cachedJson(o.poseStore, POSE_CACHE_MS, o.now);
  const poseRevBody = cachedJson(o.poseRevs, POSE_CACHE_MS, o.now);
  const assetBody = cachedJson(async () => o.assetStats(), ASSET_STATS_CACHE_MS, o.now);
  // GET — весь авторский контент (pe_gait/clips/sway/phys/ragdoll/chars); грузят и редактор, и игра (кэшируют в localStorage).
  app.get('/api/pose', ah(async (req, res) => sendCached(req, res, poseBody)));
  // Ревизии без тел: редактор зовёт их на каждой загрузке, чтобы понять, ушёл ли сервер вперёд.
  app.get('/api/pose/rev', ah(async (req, res) => sendCached(req, res, poseRevBody)));
  app.get('/api/assets/stats', ah(async (req, res) => sendCached(req, res, assetBody)));
  return {
    invalidatePose(): void { poseBody.invalidate(); poseRevBody.invalidate(); },
    invalidateAssets(): void { assetBody.invalidate(); },
  };
}
