import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Как в `packages/editor/vite.config.ts`: мост редактора (`gameHarness.ts`) берёт настоящие панели и `App` игры из
      // исходников клиента — без этого его не проверить в node (R7-15).
      '@dm/client': fileURLToPath(new URL('./packages/client/src', import.meta.url)),
    },
  },
  test: {
    // `tools/` тоже под тестами: там живут дев-сервисы (шим генерации анимаций), и их чистая
    // логика обязана проверяться тем же прогоном, а не «руками, когда вспомним».
    include: ['packages/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
    // Хуки `beforeAll` импортируют граф игры целиком (shared, комнаты, транспорт) и поднимают схему базы файла
    // (`server/src/db/testDb.ts`). Под нагрузкой полного прогона (процесс на файл, все ядра заняты, а разбор модулей идёт через
    // один главный процесс) это доходило до 10 с умолчания — и падал весь файл. Проверок в хуках нет: потолок только про время.
    hookTimeout: 30_000,
  },
});
