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
      // ⚠ R20-08: пропуск таблицы целиком — инцидент (`incident`), а не предупреждение: говорится вслух так же.
      log: () => undefined, warn: (s) => { warned.push(s); }, incident: (s) => { warned.push(s); },
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

/**
 * ⚠ R20-08: ОВЕРРАЙД КЛАССОВ СТАРШЕ R18-07 — ПРИВЕСТИ, А НЕ ВЫБРОСИТЬ. До R18-07 старт класса был любым числом (редактор пускал дробь:
 * «Ловкость + 0.5»), а R18-07 сделал его целым ≥ 0. Оверрайд ложится таблицей целиком: одна дробь в сохранённой строке — и пересборка
 * (старт, каждая сверка) выбрасывала ВСЕ правки классов хозяина (имена, галки, стартовое оружие, старты прочих), игра жила на файле, а
 * след — одна строка предупреждения. Теперь сохранённый старт приводится при загрузке (вниз до целого, не ниже нуля) и говорится вслух,
 * что приведено; новая запись из редактора с дробью — по-прежнему 422. Таблица, которую не привести, — пропуск, но ИНЦИДЕНТОМ.
 */
describe('⚠ R20-08: оверрайд классов с дробным стартом (старше R18-07) — приводится, правки хозяина живут', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  type Row = { id: string; name: string; startAttributes: Record<string, number> };
  const fileClasses = (): Row[] => { const c = new ConfigRegistry(); c.loadAll(); return structuredClone(c.get('classes')) as unknown as Row[]; };
  const boot = async (overrides: Record<string, unknown>): Promise<{ config: ConfigRegistry; warned: string[]; incidents: string[] }> => {
    const config = new ConfigRegistry();
    const warned: string[] = [];
    const incidents: string[] = [];
    const live = liveConfig({
      config,
      readOverrides: async () => structuredClone(overrides),
      deleteOverride: async () => undefined,
      changed: () => undefined,
      log: () => undefined, warn: (s) => { warned.push(s); }, incident: (s) => { incidents.push(s); },
    });
    config.loadAll();
    await live.rebuild();
    return { config, warned, incidents };
  };

  it('переименование и старты хозяина живут; 12.5 → 12, −2 → 0; сказано вслух, что приведено; инцидента нет', async () => {
    const classes = fileClasses();
    const row = (id: string): Row => classes.find((c) => c.id === id)!;
    row('warrior').name = 'Витязь (правка хозяина)';
    row('warrior').startAttributes.strength = 24;
    row('archer').startAttributes.vitality = 12.5;
    row('mage').startAttributes.dexterity = -2;
    const { config, warned, incidents } = await boot({ classes });
    const got = (id: string): Row => config.get('classes').find((c) => c.id === id) as unknown as Row;
    expect(got('warrior').name, 'переименование хозяина живёт').toBe('Витязь (правка хозяина)');
    expect(got('warrior').startAttributes.strength, 'целый старт хозяина живёт').toBe(24);
    expect(got('archer').startAttributes.vitality, 'дробный — вниз до целого').toBe(12);
    expect(got('mage').startAttributes.dexterity, 'минус — ноль').toBe(0);
    expect(incidents).toEqual([]);
    const said = warned.join('\n');
    expect(said).toMatch(/оверрайд конфига "classes" сохранён под прежней схемой — приведён/);
    expect(said).toContain('archer.startAttributes.vitality: 12.5 → 12');
    expect(said).toContain('mage.startAttributes.dexterity: -2 → 0');
    expect(said, 'приведено только негодное').not.toContain('warrior.startAttributes');
  });

  it('новая запись из редактора с дробным стартом — отказ (та же проверка, что у `/api/dev/config`: реестр-проба)', () => {
    const classes = fileClasses();
    classes[0]!.startAttributes.vitality = 20.5;
    const trial = new ConfigRegistry();
    trial.loadAll();
    expect(() => trial.reload({ classes }), 'редактор получает 422').toThrow(/startAttributes/);
  });

  it('таблицу, которую не привести, пропуск — ИНЦИДЕНТОМ и счётчиком, а не строкой предупреждения', async () => {
    const { counters } = await import('./net/metrics.js');
    const was = counters.configOverridesSkipped;
    const classes = fileClasses();
    (classes[0]!.startAttributes as Record<string, unknown>).vitality = 'много';
    const { config, incidents } = await boot({ classes });
    expect(config.get('classes')[0]!.startAttributes, 'таблица — с файла').toEqual(fileClasses()[0]!.startAttributes);
    expect(incidents.join('\n')).toMatch(/ИНЦИДЕНТ[\s\S]*пропущен невалидный оверрайд конфига "classes"/);
    expect(counters.configOverridesSkipped - was, 'метрика `dm_config_override_skipped_total`').toBe(1);
  });
});
