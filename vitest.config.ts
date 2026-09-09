import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tools/` тоже под тестами: там живут дев-сервисы (шим генерации анимаций), и их чистая
    // логика обязана проверяться тем же прогоном, а не «руками, когда вспомним».
    include: ['packages/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
  },
});
