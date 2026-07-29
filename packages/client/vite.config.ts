import { defineConfig } from 'vite';
import { resolve } from 'node:path';

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
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
    // Не перезагружать страницу при записи конфигов из редактора («Применить везде» пишет
    // data/*.json). Иначе игра перезагружается на каждое сохранение. Новый конфиг подтянется
    // с сервера при ручном обновлении (Ctrl+F5) — сервер уже держит его в живом конфиге.
    watch: { ignored: ['**/node_modules/**', '**/config/data/**'] },
  },
});
