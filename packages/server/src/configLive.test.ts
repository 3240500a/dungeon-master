import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigRegistry } from '@dm/shared';
import { liveConfig } from './configLive.js';
import { startConfigSync } from './configSync.js';
import { configReplyOf } from './configEtag.js';

/**
 * ⭐ R15-05: ПРАВКА ФАЙЛА ДАННЫХ ПЕРЕЖИВАЕТ ПЕРЕСБОРКУ ПО СВЕРКЕ. Живой конфиг и сверка — настоящие (`configLive.ts`, `configSync.ts`), база
 * оверрайдов — карта в памяти (ревизия — как у `getConfigOverridesRev`: ключ и момент правки каждой строки), ручки `index.ts` — их шаги по
 * порядку: «Применить и записать в файл» пишет файл,
 * ставит оверрайд и пересобирает; наблюдатель через ~200 мс перечитывает файл и снимает оверрайд «файл главнее»; сверка видит сдвиг
 * ревизии и пересобирает. Раньше основа пересборки была импортом старта — и правка откатывалась за ~3 с до старого.
 */
interface Overrides { set(k: string, v: unknown): void; has(k: string): boolean }
async function world(pre: Record<string, unknown> = {}): Promise<{
  config: ConfigRegistry; overrides: Overrides; live: ReturnType<typeof liveConfig>; body: () => string;
  sync: ReturnType<typeof startConfigSync>;
}> {
  const config = new ConfigRegistry();
  const rows = new Map<string, { v: unknown; at: number }>();
  let clock = 0;
  const overrides: Overrides = { set: (k, v) => { rows.set(k, { v: structuredClone(v), at: ++clock }); }, has: (k) => rows.has(k) };
  let body = '';
  const live = liveConfig({
    config,
    readOverrides: async () => Object.fromEntries([...rows].map(([k, r]) => [k, structuredClone(r.v)])),
    deleteOverride: async (k) => { rows.delete(k); },
    changed: () => { body = configReplyOf(config).body; },
    log: () => undefined, warn: () => undefined,
  });
  const rev = async (): Promise<string> => [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([k, r]) => `${k}:${r.at}`).join(',');
  config.loadAll();
  for (const [k, v] of Object.entries(pre)) overrides.set(k, v);
  const initial = await rev();   // старт процесса: ревизия — до сборки (R16 C-02)
  await live.rebuild();
  return { config, overrides, live, body: () => body, sync: startConfigSync({ readRev: rev, rebuild: () => live.rebuild(), initial, intervalMs: 3_600_000 }) };
}
/** Таблица `balance` встроенных данных (без правок). */
const builtin = (): Record<string, unknown> => { const c = new ConfigRegistry(); c.loadAll(); return structuredClone(c.get('balance')) as unknown as Record<string, unknown>; };
type Balance = { reconnectGraceSec: number };
const balance = (c: ConfigRegistry): Balance => c.get('balance') as unknown as Balance;

describe('⭐ R15-05: основа пересборки живого конфига — файлы, какие они сейчас', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('«Применить и записать в файл» (оверрайд таблицы уже был) → наблюдатель снял оверрайд → сверка пересобрала: новое значение остаётся (и в `/api/config`)', async () => {
    const start = (builtin() as unknown as Balance).reconnectGraceSec;
    const w = await world({ balance: { ...builtin(), reconnectGraceSec: start + 1 } });   // прошлое «Применить на сервере»
    expect(balance(w.config).reconnectGraceSec).toBe(start + 1);
    const edited = { ...structuredClone(w.config.get('balance')), reconnectGraceSec: start + 123 };
    // Ручка `/api/dev/config-file`: файл записан, оверрайд поставлен, пересборка.
    w.live.noteFile('balance', edited);
    w.overrides.set('balance', edited);
    await w.live.rebuild();
    expect(balance(w.config).reconnectGraceSec).toBe(start + 123);
    // Наблюдатель файлов (~200 мс): «файл главнее» — оверрайд снят.
    await w.live.applyFile('balance', structuredClone(edited));
    expect(w.overrides.has('balance'), 'оверрайд снят').toBe(false);
    // Сверка (≤ 3 с): ревизия оверрайдов сдвинулась — пересборка.
    expect(await w.sync.check(), 'сверка пересобрала конфиг').toBe(true);
    w.sync.stop();
    expect(balance(w.config).reconnectGraceSec, 'правка файла не откатилась к импорту старта').toBe(start + 123);
    expect(w.body(), 'и тело `/api/config` — с ней').toContain(`"reconnectGraceSec":${start + 123}`);
  });

  it('правка файла руками (оверрайда не было), потом «Применить на сервере» другой таблицы — правка файла переживает пересборку', async () => {
    const w = await world();
    const start = balance(w.config).reconnectGraceSec;
    await w.live.applyFile('balance', { ...structuredClone(w.config.get('balance')), reconnectGraceSec: start + 5 });
    expect(balance(w.config).reconnectGraceSec).toBe(start + 5);
    // Другая таблица — оверрайдом (`/api/dev/config`) в другом процессе: здесь её пересоберёт сверка.
    w.overrides.set('rarities', structuredClone(w.config.get('rarities')));
    expect(await w.sync.check()).toBe(true);
    w.sync.stop();
    expect(balance(w.config).reconnectGraceSec, 'правка руками цела').toBe(start + 5);
  });

  it('невалидный файл — ни в живой конфиг, ни в основу: пересборка берёт последний годный', async () => {
    const w = await world();
    const good = { ...structuredClone(w.config.get('balance')), reconnectGraceSec: 77 };
    await w.live.applyFile('balance', good);
    await expect(w.live.applyFile('balance', { reconnectGraceSec: 'много' })).rejects.toThrow();
    w.overrides.set('rarities', structuredClone(w.config.get('rarities')));
    await w.sync.check();
    w.sync.stop();
    expect(balance(w.config).reconnectGraceSec).toBe(77);
  });

  it('оверрайд поверх файла — главнее, пока его не сняли', async () => {
    const w = await world();
    w.live.noteFile('balance', { ...structuredClone(w.config.get('balance')), reconnectGraceSec: 11 });
    w.overrides.set('balance', { ...structuredClone(w.config.get('balance')), reconnectGraceSec: 22 });
    await w.live.rebuild();
    w.sync.stop();
    expect(balance(w.config).reconnectGraceSec).toBe(22);
  });
});

/**
 * ⚠ R17-03: ОВЕРРАЙД БАЛАНСА СТАРШЕ §21.1 ПРИ СТАРТЕ — ПРОПУСК С ПРЕДУПРЕЖДЕНИЕМ, А НЕ КОВКА ПО ×1. Оверрайд ложится таблицей целиком
 * (`reload({[key]: value})`): в балансе, сохранённом до §21.1, раздела `craft` нет, и каждая его строка брала умолчание схемы — у цен
 * форм это `{}`, то есть все формы по ×1 (3+2 вшестеро дешевле). Теперь схема такой баланс не пропускает: пересборка его пропускает,
 * говорит вслух, какой ключ и почему, а игра живёт на файле. Прочие оверрайды ложатся как прежде.
 */
describe('⚠ R17-03: старый оверрайд баланса без цен форм — пропуск при старте', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  const boot = async (overrides: Record<string, unknown>): Promise<{ config: ConfigRegistry; warned: string[] }> => {
    const config = new ConfigRegistry();
    const warned: string[] = [];
    const live = liveConfig({
      config,
      readOverrides: async () => structuredClone(overrides),
      deleteOverride: async () => undefined,
      changed: () => undefined,
      log: () => undefined, warn: (s) => { warned.push(s); },
    });
    config.loadAll();
    await live.rebuild();
    return { config, warned };
  };
  const file = (): Record<string, number> => (builtin() as unknown as { craft: { formMult: Record<string, number> } }).craft.formMult;

  it('баланс без раздела craft и баланс без строки «3+2» — пропущены с предупреждением, цены форм — из файла', async () => {
    const { craft: _craft, ...stale } = builtin();
    const noRow = builtin() as unknown as { craft: { formMult: Record<string, number> } };
    delete noRow.craft.formMult['3+2'];
    const base = new ConfigRegistry();
    base.loadAll();
    for (const [how, bal] of [['раздела craft нет', { ...stale, reconnectGraceSec: 4321 }], ['строки «3+2» нет', noRow]] as const) {
      const rarities = structuredClone(base.get('rarities'));
      rarities[0]!.priceMult += 0.5;
      const { config, warned } = await boot({ balance: bal, rarities });
      expect(config.get('balance').craft.formMult, `${how}: было — все формы по ×1`).toEqual(file());
      expect(warned.join('\n'), how).toMatch(/пропущен невалидный оверрайд конфига "balance"[\s\S]*formMult/);
      expect(config.get('rarities')[0]!.priceMult, `${how}: прочие оверрайды ложатся`).toBe(rarities[0]!.priceMult);
    }
  });
});
