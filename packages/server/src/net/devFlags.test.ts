import { describe, it, expect } from 'vitest';
import { craftFullJournalOn, craftFullJournalNotice, isProduction } from './devFlags.js';

/**
 * ⭐ ФЛАГ РАЗРАБОТЧИКА НЕ ДОЛЖЕН ДОЕХАТЬ ДО БОЯ. `DM_CRAFT_FULL_JOURNAL=1` открывает ворота журнала
 * кузнеца ВСЕМ игрокам: забытый в окружении боевого сервера, он раздал бы каталог ковки даром.
 * Поэтому в продакшене (`NODE_ENV=production` — тот же признак, что закрывает dev-роуты) флаг
 * игнорируется, а в логе это видно с первой секунды.
 */
describe('DM_CRAFT_FULL_JOURNAL — только вне продакшена', () => {
  it('вне продакшена флаг работает: dev, test, без NODE_ENV', () => {
    for (const NODE_ENV of [undefined, 'development', 'test', '']) {
      expect(craftFullJournalOn({ DM_CRAFT_FULL_JOURNAL: '1', NODE_ENV }), String(NODE_ENV)).toBe(true);
    }
  });

  it('в продакшене флаг ИГНОРИРУЕТСЯ — в любом написании NODE_ENV', () => {
    for (const NODE_ENV of ['production', 'Production', ' PRODUCTION ', 'production\n']) {
      expect(craftFullJournalOn({ DM_CRAFT_FULL_JOURNAL: '1', NODE_ENV }), JSON.stringify(NODE_ENV)).toBe(false);
      expect(isProduction({ NODE_ENV }), JSON.stringify(NODE_ENV)).toBe(true);
    }
  });

  it('включает только ровно «1»: пусто, 0, true, yes — выключено', () => {
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '11']) {
      expect(craftFullJournalOn({ DM_CRAFT_FULL_JOURNAL: v }), JSON.stringify(v)).toBe(false);
    }
  });

  it('строка для лога при старте: нет флага — молчим; есть — громко, и в продакшене «проигнорирован»', () => {
    expect(craftFullJournalNotice({})).toBeNull();
    expect(craftFullJournalNotice({ DM_CRAFT_FULL_JOURNAL: '0', NODE_ENV: 'production' })).toBeNull();
    const dev = craftFullJournalNotice({ DM_CRAFT_FULL_JOURNAL: '1' });
    expect(dev).toMatch(/DM_CRAFT_FULL_JOURNAL=1/);
    expect(dev).toMatch(/ОТКРЫТЫ/);
    const prod = craftFullJournalNotice({ DM_CRAFT_FULL_JOURNAL: '1', NODE_ENV: 'production' });
    expect(prod).toMatch(/DM_CRAFT_FULL_JOURNAL=1/);
    expect(prod).toMatch(/ПРОИГНОРИРОВАН/);
    expect(prod).not.toMatch(/ОТКРЫТЫ/);
  });
});
