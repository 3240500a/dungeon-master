import { defineConfig } from 'vite';
import { resolve } from 'node:path';

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
export default defineConfig({
  resolve: {
    alias: {
      '@dm/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  // Мультистраничная сборка: 2D-клиент (index), 3D-онлайн-клиент (game3d), редактор поз (pose-editor).
  // Каждая страница — свой entry; иначе `vite build` соберёт только index.html.
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
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
});
