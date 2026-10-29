import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@dm/pose-editor': fileURLToPath(new URL('./packages/pose-editor/src', import.meta.url)),   // ⭐ С3
    },
  },
  test: {
    // `tools/` тоже под тестами: там живут дев-сервисы (шим генерации анимаций), и их чистая
    // логика обязана проверяться тем же прогоном, а не «руками, когда вспомним».
    include: ['packages/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
    // ⭐ С7 (29.10): сторожа и фаззеры шлют команды лавки, кузницы и сундука со спавна города — проверку «герой у станции» снимаем им
    // (флаг стенда, в бою игнорируется: `devFlags.stationCheckOff`). Само правило сторожит `room.audit.test.ts`, включая его на время теста.
    env: { DM_STATION_CHECK: 'off' },
    // Хуки `beforeAll` импортируют граф игры целиком (shared, комнаты, транспорт) и поднимают схему базы файла
    // (`server/src/db/testDb.ts`). Под нагрузкой полного прогона (процесс на файл, все ядра заняты, а разбор модулей идёт через
    // один главный процесс) это доходило до 10 с умолчания — и падал весь файл. Проверок в хуках нет: потолок только про время.
    hookTimeout: 30_000,
  },
});
