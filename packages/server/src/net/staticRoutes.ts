import express, { type Express } from 'express';

/**
 * Раздача файлов игровым процессом: модели и текстуры (`/assets`, папка ассетов сервера). Вынесено из `index.ts`, чтобы порядок
 * монтирования стоял под тестом: импорт `index.ts` поднимает сервер и лезет в базу (как `internalRoutes.ts`, `accountRoutes.ts`).
 *
 * ⭐ С1 (29.10): СОБРАННЫЙ ВЕБ-КЛИЕНТ (`client/dist`: страницы, бандл, SPA-фолбэк) СЕРВЕР БОЛЬШЕ НЕ РАЗДАЁТ. Веб-клиент не поддерживается,
 * играют Unity: ему нужны `/api`, `/ws` и `/assets`. Сервер самодостаточен и ничего не знает о том, какой клиент его рисует.
 */
export interface StaticOptions {
  /** Папка моделей и текстур (`packages/server/assets`) — раздаётся на `/assets`. */
  assetsDir: string;
  /** Не продакшен: ассеты без кэша (перезалил модель под тем же именем — свежие байты сразу). */
  dev: boolean;
}

export function installStatic(app: Express, o: StaticOptions): void {
  // Dev: ЖЁСТКО без кэша — `no-store` + БЕЗ etag/last-modified (никаких 304): перезалил модель/текстуру под тем же именем → свежие байты
  // сразу. Прод: часовой кэш (модели крупные). Вернуть кэш = запустить с NODE_ENV=production.
  app.use('/assets', express.static(o.assetsDir, {
    maxAge: o.dev ? 0 : '1h',
    etag: !o.dev,
    lastModified: !o.dev,
    cacheControl: !o.dev,
    index: false,
    setHeaders: o.dev
      ? (res): void => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0'); }
      : undefined,
  }));
  // Нет такого файла → честный JSON 404: клиент не разберёт страницу как модель, а чистка битых ссылок в редакторе достоверно видит «нет файла».
  app.use('/assets', (_req, res) => { res.status(404).json({ error: 'asset not found' }); });
}
