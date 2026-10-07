import type { Express, Request, Response } from 'express';
import { createReadStream, statSync } from 'node:fs';
import { ah } from './asyncRoute.js';
import { isSha, type BlobStore } from '../content/blobStore.js';
import type { ChannelPointer } from '../content/releaseDb.js';
import type { CutResult } from '../content/releaseCutter.js';

/**
 * ⭐ 08.10 (Д1): РАЗДАЧА РЕЛИЗОВ КОНТЕНТА (план «Обновление контента без пересборки клиента»).
 *
 *  • `GET /api/content/pointer?channel=dev&abi=1&build=N` — УКАЗАТЕЛЬ: номер релиза канала и хэш его манифеста, порядка сотни байт, с
 *    ETag и без кэша (`no-cache`). Клиент сравнивает хэш с сохранённым: совпал — запуск без скачиваний. Чужая ABI — 409 с ABI сервера;
 *    канала нет — указатель `dev` (каналы `beta`/`live` заводит фаза Д3); релиза ещё нет (сервер только поднялся) — 503 и «повтори».
 *  • `GET /c/b/<2>/<sha256>` — ФАЙЛ ПО ХЭШУ: имя = содержимое, поэтому `immutable` на год (у клиента — свой кэш на диске). Понимает
 *    gzip — отдаём сжатую копию (`Content-Encoding: gzip`); клиент сверяет sha256 распакованного.
 *  • `POST /api/dev/content/release` — нарезать релиз сейчас (разработчику и тестам; обычно режет сам нарезчик после правки).
 *
 * Вынесено из `index.ts`, чтобы стоять под тестом за настоящим express (как `contentRoutes.ts`).
 */
export interface ReleaseRoutesDeps {
  store: BlobStore;
  /** Указатель канала (`releaseDb.channelPointer`). */
  pointer(channel: string, abi: number): Promise<ChannelPointer | null>;
  abi: number;
  /** Базы адресов файлов (`<база>b/<2>/<sha>`): пока — свой сервер. */
  cdn: readonly string[];
  /** Ручка разработчика: охрана (`devGuard`) и нарезка. Нет — ручки нет. */
  dev?: { guard(req: Request, res: Response): Promise<boolean>; cutNow(): Promise<CutResult> };
  /** Часы кэша указателя (тесты). */
  now?(): number;
}

/** Сколько указатель отдаётся из памяти, мс: дёшево и для сотен запусков в секунду, а новый релиз виден почти сразу. */
export const POINTER_CACHE_MS = 1_000;
const CHANNEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface ReleaseRoutes { invalidate(): void }

export function installReleaseRoutes(app: Express, deps: ReleaseRoutesDeps): ReleaseRoutes {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: ChannelPointer | null }>();
  async function pointerOf(channel: string, abi: number): Promise<ChannelPointer | null> {
    const key = `${channel}|${abi}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < POINTER_CACHE_MS) return hit.value;
    let value = await deps.pointer(channel, abi);
    if (!value && channel !== 'dev') value = await deps.pointer('dev', abi);
    cache.set(key, { at: now(), value });
    return value;
  }

  app.get('/api/content/pointer', ah(async (req, res) => {
    const channel = typeof req.query.channel === 'string' && req.query.channel ? req.query.channel : 'dev';
    if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'канал' });
    const abiQ = typeof req.query.abi === 'string' && req.query.abi !== '' ? Number(req.query.abi) : deps.abi;
    if (!Number.isInteger(abiQ)) return res.status(400).json({ error: 'abi' });
    res.setHeader('Cache-Control', 'no-cache');
    if (abiQ !== deps.abi) return res.status(409).json({ error: 'abi', abi: deps.abi });
    const p = await pointerOf(channel, abiQ);
    if (!p) { res.setHeader('Retry-After', '2'); return res.status(503).json({ error: 'релиза контента ещё нет' }); }
    const etag = `"${p.seq}-${p.manifest.slice(0, 16)}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json({
      seq: p.seq, manifest: p.manifest, manifestSize: p.manifestSize, abi: abiQ, channel: p.channel,
      cdn: deps.cdn, minClient: p.minClient, latestClient: p.latestClient,
    });
  }));

  app.get('/c/b/:p/:sha', (req, res) => {
    const { p, sha } = req.params;
    if (!isSha(sha) || p !== sha.slice(0, 2)) return res.status(400).json({ error: 'адрес файла' });
    if (!deps.store.has(sha)) return res.status(404).json({ error: 'нет файла' });
    const etag = `"${sha}"`;
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) ? deps.store.gzPathOf(sha) : null;
    const path = gz ?? deps.store.pathOf(sha);
    let size: number;
    try { size = statSync(path).size; } catch { return res.status(404).json({ error: 'нет файла' }); }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(size));
    if (gz) res.setHeader('Content-Encoding', 'gzip');
    const s = createReadStream(path);
    s.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    s.pipe(res);
  });

  if (deps.dev) {
    const dev = deps.dev;
    app.post('/api/dev/content/release', ah(async (req, res) => {
      if (!await dev.guard(req, res)) return;
      const r = await dev.cutNow();
      cache.clear();
      res.json(r);
    }));
  }

  return { invalidate: () => cache.clear() };
}
