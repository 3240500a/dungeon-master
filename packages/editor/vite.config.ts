import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@dm/shared': resolve(__dirname, '../shared/src/index.ts'),
      // Калькулятор переиспользует реальные панели игры (@dm/client) — «одна истина» по статам.
      '@dm/client': resolve(__dirname, '../client/src'),
    },
  },
  server: {
    // Проксируем /api на сервер, чтобы «Применить в игру» слало оверрайды в живой конфиг
    // (игра серверно-авторитетна — правки должны дойти до сервера, а не только до клиента).
    proxy: {
      '/api': 'http://localhost:3001',
    },
    // Не перезагружать редактор при записи data/*.json («Применить везде») — иначе теряется
    // текущее состояние правки. Правка уже в памяти редактора; файл пишется для git/деплоя.
    watch: { ignored: ['**/node_modules/**', '**/config/data/**'] },
  },
});
