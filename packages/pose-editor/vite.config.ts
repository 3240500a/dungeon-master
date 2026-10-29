import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * ⭐ С3 (29.10): ПОЗ-РЕДАКТОР — СВОЙ ПАКЕТ (был страницей веб-клиента `packages/client/pose-editor.html`). Веб-клиент не поддерживается,
 * а редактор анимаций — живой инструмент: клипы, импорт мокапа, риг, хваты пишутся на сервер (`/api/dev/pose`), Unity их читает.
 * Тот же адрес, что раньше: http://localhost:5173/pose-editor.html (`npm run dev` в корне поднимает его вместе с сервером).
 *
 *   DM_API=http://192.168.1.69:3001   — куда проксировать /api и /assets (по умолчанию локальный сервер)
 *   DM_LAN=1                          — слушать не только 127.0.0.1
 * Префикс `DM_`, а не `VITE_`: Vite впечатывает `VITE_*` в бандл, а адрес машины нужен только дев-серверу.
 */
const API = process.env.DM_API ?? 'http://localhost:3001';
const LAN = !!process.env.DM_LAN;

export default defineConfig({
  resolve: {
    alias: {
      '@dm/shared': resolve(__dirname, '../shared/src/index.ts'),
      '@dm/pose-editor': resolve(__dirname, 'src'),
    },
  },
  build: { rollupOptions: { input: { poseEditor: resolve(__dirname, 'pose-editor.html') } } },
  server: {
    port: 5173,
    host: LAN,
    proxy: { '/api': API, '/assets': API },
    watch: { ignored: ['**/node_modules/**', '**/config/data/**'] },
  },
});
