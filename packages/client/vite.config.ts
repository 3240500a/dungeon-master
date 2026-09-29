import { defineConfig } from 'vite';
import { join, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { buildStampOf, isBuildStampSource } from '../shared/src/session/buildStamp.ts';

/**
 * АДРЕС СЕРВЕРА И ВЫХОД В ЛОКАЛЬНУЮ СЕТЬ — две переменные, умолчания НЕ МЕНЯЮТСЯ.
 *
 * Работа на двух машинах (редактор здесь, сервер и генератор анимаций там) упиралась в то, что
 * адрес сервера был прибит гвоздями, а Vite слушал только петлю.
 *   DM_API=http://192.168.1.69:3001   — куда проксировать /api и /assets
 *   DM_LAN=1                          — слушать не только 127.0.0.1
 *
 * ПРЕФИКС `DM_`, А НЕ `VITE_`, НАМЕРЕННО: переменные с `VITE_` Vite ВПЕЧАТЫВАЕТ в собранный
 * бандл, и внутренний адрес машины уехал бы в продакшен-сборку. Этот адрес нужен ТОЛЬКО
 * дев-серверу Vite (Node), браузер о нём знать не должен.
 *
 * ⚠ Сервер с другой машины потребует входа: инструментальные роуты закрыты ролью admin
 * (см. `server/src/net/adminAccess.ts`), и адрес редактора надо добавить в `DM_ORIGINS` сервера.
 */
const API = process.env.DM_API ?? 'http://localhost:3001';
const LAN = !!process.env.DM_LAN;

/**
 * ⭐ R18-08: ШТАМП СБОРКИ — хэш исходников shared (`buildStampOf`), тот же, что сервер считает на старте по файлам, с которых работает
 * (`server/src/buildStamp.ts`) и шлёт в `joined.build`. Вкладка, пережившая деплой со старым бандлом, видит чужой штамп — «перезагрузите»
 * (`App`). Только `vite build`: дев-сервер считал бы его раз на запуск, а исходники под ним меняются — вкладке пустой штамп, сравнения нет.
 */
function buildStamp(): string {
  const dir = resolve(__dirname, '../shared/src');
  const files = readdirSync(dir, { recursive: true }).map(String).filter(isBuildStampSource);
  return buildStampOf(files.map((p) => [p, readFileSync(join(dir, p), 'utf8')] as const));
}

export default defineConfig(({ command }) => ({
  resolve: {
    alias: {
      '@dm/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  define: {
    __DM_BUILD__: JSON.stringify(command === 'build' ? buildStamp() : ''),
  },
  /**
   * Мультистраничная сборка. Каждая страница — свой entry; иначе `vite build` соберёт только index.html.
   *
   * ⚠ 2D-КЛИЕНТА (index.html) ЗДЕСЬ НАМЕРЕННО НЕТ. Игровой клиент теперь Unity, и 2D не должен
   * уезжать на арендованный сервер и занимать там место и трафик. Код при этом НИКУДА НЕ УДАЛЁН:
   * он лежит в репозитории и полностью работает в дев-режиме (`npm run dev` → localhost:5173),
   * потому что Vite отдаёт в дев-режиме любой html из корня, независимо от этого списка.
   * Веб-3D остаётся в сборке как ТЕСТОВЫЙ СТЕНД (графика в него больше не добавляется),
   * поз-редактор — как рабочий инструмент, он ходит на серверный /api/pose с обеих машин.
   */
  build: {
    rollupOptions: {
      input: {
        game3d: resolve(__dirname, 'game3d.html'),
        poseEditor: resolve(__dirname, 'pose-editor.html'),
      },
    },
  },
  server: {
    port: 5173,
    host: LAN,
    proxy: {
      '/api': API,
      '/assets': API,   // GLB-модели (импорт из редактора) раздаёт сервер
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
    // Не перезагружать страницу при записи конфигов из редактора («Применить везде» пишет
    // data/*.json). Иначе игра перезагружается на каждое сохранение. Новый конфиг подтянется
    // с сервера при ручном обновлении (Ctrl+F5) — сервер уже держит его в живом конфиге.
    watch: { ignored: ['**/node_modules/**', '**/config/data/**'] },
  },
}));
