import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Раздача файлов игровым процессом: модели и текстуры (`/assets`, папка ассетов сервера) и собранный клиент (`client/dist`: страницы,
 * бандл, картинки). Вынесено из `index.ts`, чтобы порядок монтирования стоял под тестом: импорт `index.ts` поднимает сервер и лезет в
 * базу (как `internalRoutes.ts`, `accountRoutes.ts`). Ставится ПОСЛЕ всех `/api`-ручек: SPA-фолбэк иначе отвечал бы им страницей.
 */
export interface StaticOptions {
  /** Папка моделей и текстур (`packages/server/assets`) — раздаётся на `/assets` при любом `serveStatic`. */
  assetsDir: string;
  /** Собранный клиент (`packages/client/dist`). */
  clientDist: string;
  /** Ф0.9: `DM_SERVE_STATIC=off` снимает раздачу клиента с игрового процесса (ассеты `/assets` остаются). */
  serveStatic: boolean;
  /** Не продакшен: ассеты без кэша (перезалил модель под тем же именем — свежие байты сразу). */
  dev: boolean;
}

/**
 * Смонтировать раздачу. Возвращает корневую страницу клиента (первая найденная: `game3d.html`, `index.html`) или `undefined` —
 * клиент не раздаётся (выключено или `client/dist` нет).
 */
export function installStatic(app: Express, o: StaticOptions): string | undefined {
  // Dev: ЖЁСТКО без кэша — `no-store` + БЕЗ etag/last-modified (никаких 304). Браузер НИКОГДА не хранит и не ревалидирует:
  // перезалил модель/текстуру под тем же именем → свежие байты сразу (без Ctrl+Shift+R, без залипания).
  // Прод: часовой кэш (GLB крупные). Вернуть кэш = запустить с NODE_ENV=production.
  app.use('/assets', express.static(o.assetsDir, {
    maxAge: o.dev ? 0 : '1h',
    etag: !o.dev,          // dev: без ETag → нет условных запросов/304
    lastModified: !o.dev,  // dev: без Last-Modified
    cacheControl: !o.dev,  // dev: заголовок ставим сами (ниже)
    setHeaders: o.dev
      ? (res): void => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0'); }
      : undefined,
  }));
  // ⚠ Корневую страницу НЕЛЬЗЯ прибивать к index.html: 2D-клиент больше не собирается в продакшен (см. `client/vite.config.ts`), и
  // жёсткая ссылка на него выключила бы раздачу целиком — вместе с 3D-стендом и поз-редактором. Первая существующая, порядок = приоритет.
  const entry = o.serveStatic ? ['game3d.html', 'index.html'].find((f) => existsSync(join(o.clientDist, f))) : undefined;
  // ⭐ R10-03: БАНДЛ КЛИЕНТА — ТОЖЕ `/assets`: Vite кладёт его в `dist/assets/` (`/assets/game3d-<хэш>.js`, ленивые куски). Раньше
  // `/assets` занимали модели сервера со своим 404 ниже, и до раздачи клиента запрос бандла не доходил: страница приходила, её скрипт —
  // JSON 404, стенд и поз-редактор в собранной выкладке — белый экран. Модели — первыми (их имена `<id>.glb|png|…`, у бандла — с хэшем),
  // бандл — с вечным кэшем: имя меняется с каждой сборкой.
  if (entry) app.use('/assets', express.static(join(o.clientDist, 'assets'), { immutable: true, maxAge: '1y', index: false }));
  // Нет такого файла → честный 404 (перехват ДО общего catch-all, иначе отсутствующий ассет отдавал HTML-заглушку со статусом 200,
  // и игра парсила её как GLB/PNG). Заодно чистка битых ссылок в редакторе может достоверно определить «нет файла».
  app.use('/assets', (_req, res) => { res.status(404).json({ error: 'asset not found' }); });

  if (!entry) return undefined;
  app.use(express.static(o.clientDist));
  // SPA-фолбэк: любой не-/api GET → корневая страница (deep links). /api/* уходит в 404 выше по стеку.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(o.clientDist, entry));
  });
  return entry;
}
