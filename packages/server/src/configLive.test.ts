import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigRegistry, configCrossIssues, defaultConfigData } from '@dm/shared';
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

/**
 * ⭐ D2: ОВЕРРАЙД БАЛАНСА С КРИВОЙ ОПЫТА СТАРШЕ R20-05 — ПРИВЕСТИ, А НЕ ВЫБРОСИТЬ. До R20-05 схема пускала любой массив чисел в `xpTable`,
 * теперь — «0, 0, дальше строго растёт». Одна ступенька в сохранённой кривой — и пересборка выбрасывала ВЕСЬ баланс хозяина (цены, очки за
 * уровень, сброс, кузницу): игра жила на файле. Теперь кривая приводится при загрузке (`upgradeXpTable`: выпавшие пороги — на прямую между
 * оставшимися), сказано вслух, что приведено; прочие правки баланса живут, инцидента нет.
 */
describe('⭐ D2: оверрайд баланса с кривой опыта старше R20-05 — приводится, правки хозяина живут', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('ступенька xp[11..20] и правка хозяина рядом: кривая строго растёт, reconnectGraceSec хозяина живёт, сказано вслух', async () => {
    const file = (): { xpTable: number[]; reconnectGraceSec: number } => { const c = new ConfigRegistry(); c.loadAll(); return structuredClone(c.get('balance')) as never; };
    const bal = file();
    bal.reconnectGraceSec = 4321;
    bal.xpTable = bal.xpTable.map((v, i) => (i >= 11 && i <= 20 ? 100 : v));
    const config = new ConfigRegistry();
    const warned: string[] = [], incidents: string[] = [];
    const live = liveConfig({
      config, readOverrides: async () => ({ balance: structuredClone(bal) }), deleteOverride: async () => undefined, changed: () => undefined,
      log: () => undefined, warn: (s) => { warned.push(s); }, incident: (s) => { incidents.push(s); },
    });
    config.loadAll();
    await live.rebuild();
    const t = config.get('balance').xpTable;
    expect(incidents).toEqual([]);
    expect(config.get('balance').reconnectGraceSec, 'правка хозяина рядом живёт').toBe(4321);
    expect(t.length, 'потолок прежний').toBe(bal.xpTable.length);
    expect(t.every((v, i) => (i < 2 ? v === 0 : v > t[i - 1]!)), 'строго растёт').toBe(true);
    expect(t.slice(0, 11), 'пороги до ступеньки — как были').toEqual(bal.xpTable.slice(0, 11));
    expect(warned.join('\n')).toMatch(/оверрайд конфига "balance" сохранён под прежней схемой — приведён[\s\S]*balance\.xpTable\[11\]/);
  });
});

/**
 * ⭐ D4: ОВЕРРАЙД ДРЕВА И ВСТАВОК, СОХРАНЁННЫЙ ДО ПРАВИЛА ВРЕМЕНИ БАФФА (`shared/formulas/buffTiming.ts`), — ЗАЖИМ, А НЕ ВЫБРОС. Схема теперь
 * не пускает бафф, чей откат хоть на одном ранге короче действия с отдыхом: древо хозяина с кличем до 20-го ранга или печать с откатом 0
 * выбрасывали бы при каждой пересборке ВСЕ его правки древа. Нарушитель приводится (потолок ранга до последнего годного, откат 1-го ранга /
 * печати — до правила) — как делал зажим R19-03 в ядре, только в данных и вслух; прочие правки живут, инцидента нет.
 */
describe('⭐ D4: оверрайд древа и вставок старше правила времени баффа — зажим с предупреждением, правки хозяина живут', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('клич до 20-го ранга (12 с), имя узла хозяина, печать с откатом 0: приведено и сказано вслух; реестр годен', async () => {
    const file = new ConfigRegistry();
    file.loadAll();
    type Node = { id: string; name: string; maxRank: number; effect: { active?: { cooldown: number } } };
    const tree = structuredClone(file.get('skill-tree')) as unknown as { nodes: Node[] };
    const warcry = tree.nodes.find((n) => n.id === 'b-class-warrior-a5')!;
    warcry.maxRank = 20; warcry.effect.active!.cooldown = 12; warcry.name = 'Клич хозяина';
    type Ins = { id: string; proc?: { ability: { cooldown: number } } };
    const ins = structuredClone(file.get('skill-inserts')) as unknown as Ins[];
    ins.find((i) => i.id === 'ins-ward')!.proc!.ability.cooldown = 0;
    const config = new ConfigRegistry();
    const warned: string[] = [], incidents: string[] = [];
    const live = liveConfig({
      config, readOverrides: async () => ({ 'skill-tree': structuredClone(tree), 'skill-inserts': structuredClone(ins) }), deleteOverride: async () => undefined,
      changed: () => undefined, log: () => undefined, warn: (s) => { warned.push(s); }, incident: (s) => { incidents.push(s); },
    });
    config.loadAll();
    await live.rebuild();
    expect(incidents).toEqual([]);
    const got = config.get('skill-tree').nodes.find((n) => n.id === 'b-class-warrior-a5')!;
    expect(got.name, 'правка хозяина рядом живёт').toBe('Клич хозяина');
    expect(got.maxRank, 'потолок — до последнего годного ранга (12 с × 0.85 = 10.2 ≥ 10)').toBe(6);
    expect((got.effect.active as { cooldown: number }).cooldown, 'база хозяина').toBe(12);
    expect((config.get('skill-inserts').find((i) => i.id === 'ins-ward')!.proc!.ability as { cooldown: number }).cooldown).toBe(10.4);
    const said = warned.join('\n');
    expect(said).toMatch(/оверрайд конфига "skill-tree" сохранён под прежней схемой — приведён[\s\S]*b-class-warrior-a5\.maxRank: 20 → 6/);
    expect(said).toMatch(/оверрайд конфига "skill-inserts"[\s\S]*ins-ward\.proc\.ability\.cooldown: 0 → 10\.4/);
  });
});

/**
 * ⭐ R21-01: ПРАВИЛО ПОВЕРХ НЕСКОЛЬКИХ ТАБЛИЦ (D4) — НАД ИТОГОВЫМ КАНДИДАТОМ, А НЕ ПО ОДНОЙ ТАБЛИЦЕ В ПОРЯДКЕ СТРОК БАЗЫ. Пересборка клала
 * оверрайды по одному (`reload({[key]})`) в порядке `SELECT … FROM config_overrides` (без ORDER BY — порядок кучи; UPDATE уносит строку в
 * конец), а правило D4 спрашивала у полусобранного реестра. Годный ВМЕСТЕ набор хозяина в одном порядке ложился, в другом — баланс
 * проверялся против древа ФАЙЛА и выбрасывался целиком инцидентом (очки за уровень, цены кузницы, сброса — с файла), или древо/вставки
 * «приводились» против баланса файла: потолок ранга клича 8 → 6, откат печати 7 → 10.4 — молча, а `db:repair --fix` писал это в базу.
 */
describe('⭐ R21-01: годный вместе набор оверрайдов — в любом порядке строк базы как есть', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  type Tree = { nodes: { id: string; maxRank: number; effect: { active?: { category?: string; cooldown: number }; grantsInsert?: string } }[] };
  type Ins = { id: string; proc?: { ability: { category?: string; cooldown: number } } }[];
  const file = (): ConfigRegistry => { const c = new ConfigRegistry(); c.loadAll(); return c; };
  const raisedTree = (k: number): Tree => {
    const t = structuredClone(file().get('skill-tree')) as unknown as Tree;
    for (const n of t.nodes) if (n.effect.active?.category === 'buff') n.effect.active.cooldown = Math.round(n.effect.active.cooldown * k * 100) / 100;
    return t;
  };
  const raisedInserts = (k: number): Ins => {
    const t = structuredClone(file().get('skill-inserts')) as unknown as Ins;
    for (const i of t) if (i.proc?.ability.category === 'buff') i.proc.ability.cooldown = Math.round(i.proc.ability.cooldown * k * 100) / 100;
    return t;
  };
  const boot = async (rows: [string, unknown][]): Promise<{ config: ConfigRegistry; warned: string[]; incidents: string[] }> => {
    const config = new ConfigRegistry();
    const warned: string[] = [], incidents: string[] = [];
    const live = liveConfig({
      config, readOverrides: async () => Object.fromEntries(rows.map(([k, v]) => [k, structuredClone(v)])), deleteOverride: async () => undefined,
      changed: () => undefined, log: () => undefined, warn: (s) => { warned.push(s); }, incident: (s) => { incidents.push(s); },
    });
    await live.rebuild();
    return { config, warned, incidents };
  };
  const perms = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  const node = (c: ConfigRegistry, id: string): Tree['nodes'][number] => (c.get('skill-tree') as unknown as Tree).nodes.find((n) => n.id === id)!;
  const ward = (c: ConfigRegistry): number => (c.get('skill-inserts') as unknown as Ins).find((i) => i.id === 'ins-ward')!.proc!.ability.cooldown;

  it('баланс с отдыхом 1.0 и экономикой хозяина + древо и вставки с поднятыми откатами — во всех 6 порядках: всё живёт, ни инцидента, ни приведения', async () => {
    const tables: Record<string, unknown> = {
      balance: { ...structuredClone(file().get('balance')), buffMinRest: 1.0, attributePointsPerLevel: 7, respecCost: 12345 },
      'skill-tree': raisedTree(3), 'skill-inserts': raisedInserts(3),
    };
    expect(() => file().reload(structuredClone(tables)), 'вместе набор годен (реестр принимает его разом)').not.toThrow();
    for (const order of perms(Object.keys(tables))) {
      const at = order.join(' → ');
      const { config, warned, incidents } = await boot(order.map((k) => [k, tables[k]]));
      expect(incidents, `${at}: было — весь баланс хозяина выброшен инцидентом`).toEqual([]);
      expect(warned.filter((w) => /приведён/.test(w)), at).toEqual([]);
      expect(config.get('balance').buffMinRest, at).toBe(1.0);
      expect(config.get('balance').attributePointsPerLevel, `${at}: очки за уровень хозяина`).toBe(7);
      expect(config.get('balance').respecCost, `${at}: цена сброса хозяина`).toBe(12345);
      expect(node(config, 'b-class-warrior-a5').effect.active!.cooldown, at).toBe(40.5);
      expect(ward(config), at).toBe(42);
    }
  });

  it('отдых 0.1 и клич 12 с × 8 рангов (годно вместе): древо первым — потолок 8, а не «приведён» до 6', async () => {
    const balance = { ...structuredClone(file().get('balance')), buffMinRest: 0.1 };
    const tree = structuredClone(file().get('skill-tree')) as unknown as Tree;
    const wc = tree.nodes.find((n) => n.id === 'b-class-warrior-a5')!;
    wc.effect.active!.cooldown = 12; wc.maxRank = 8;
    expect(() => file().reload({ balance, 'skill-tree': structuredClone(tree) }), 'вместе годно').not.toThrow();
    for (const rows of [[['skill-tree', tree], ['balance', balance]], [['balance', balance], ['skill-tree', tree]]] as [string, unknown][][]) {
      const at = rows.map(([k]) => k).join(' → ');
      const { config, warned, incidents } = await boot(rows);
      expect(incidents, at).toEqual([]);
      expect(warned.filter((w) => /приведён/.test(w)), `${at}: было — «сохранён под прежней схемой — приведён», maxRank 8 → 6`).toEqual([]);
      expect(node(config, 'b-class-warrior-a5').maxRank, at).toBe(8);
      expect(node(config, 'b-class-warrior-a5').effect.active!.cooldown, at).toBe(12);
      expect(config.get('balance').buffMinRest, at).toBe(0.1);
    }
  });

  it('печать «Оберег» 7 с и её донор с потолком 3 (годно вместе): вставки первыми — откат 7, а не 10.4', async () => {
    const tree = structuredClone(file().get('skill-tree')) as unknown as Tree;
    const donor = tree.nodes.find((n) => n.effect.grantsInsert === 'ins-ward')!;
    donor.maxRank = 3;
    const ins = structuredClone(file().get('skill-inserts')) as unknown as Ins;
    ins.find((i) => i.id === 'ins-ward')!.proc!.ability.cooldown = 7;
    expect(() => file().reload({ 'skill-tree': structuredClone(tree), 'skill-inserts': structuredClone(ins) }), 'вместе годно').not.toThrow();
    for (const rows of [[['skill-inserts', ins], ['skill-tree', tree]], [['skill-tree', tree], ['skill-inserts', ins]]] as [string, unknown][][]) {
      const at = rows.map(([k]) => k).join(' → ');
      const { config, warned, incidents } = await boot(rows);
      expect(incidents, at).toEqual([]);
      expect(warned.filter((w) => /приведён/.test(w)), at).toEqual([]);
      expect(ward(config), `${at}: откат печати хозяина`).toBe(7);
      expect(node(config, donor.id).maxRank, at).toBe(3);
    }
  });
});

/**
 * ⭐ R21-03: ФАЙЛ ДАННЫХ, ПРИНЯТЫЙ НАБЛЮДАТЕЛЕМ, НЕ ЛОМАЕТ СЛЕДУЮЩУЮ ПЕРЕСБОРКУ И СТАРТ. Наблюдатель проверял файл против ЖИВОГО конфига
 * (с оверрайдами базы), а пересборка и старт грузят файлы БЕЗ оверрайдов — и правило D4 проверялось над одними файлами: баланс с отдыхом
 * 1.0 при древе и вставках с поднятыми откатами ТОЛЬКО в базе принимался, а дальше каждая пересборка бросала (сверка — повтор раз в 3 с
 * навсегда, «Применить» — 500, живой конфиг замёрз), и следующий старт процесса падал до чтения оверрайдов.
 */
describe('⭐ R21-03: файл, годный только вместе с оверрайдами базы, — отказ; пересборка и старт не бросают из-за правила поверх таблиц', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  type Tree = { nodes: { id: string; maxRank: number; effect: { active?: { category?: string; cooldown: number } } }[] };
  type Ins = { id: string; proc?: { ability: { category?: string; cooldown: number } } }[];
  const file = (): ConfigRegistry => { const c = new ConfigRegistry(); c.loadAll(); return c; };
  const x8 = (): Record<string, unknown> => {
    const t = structuredClone(file().get('skill-tree')) as unknown as Tree;
    for (const n of t.nodes) if (n.effect.active?.category === 'buff') n.effect.active.cooldown = Math.round(n.effect.active.cooldown * 8);
    const ins = structuredClone(file().get('skill-inserts')) as unknown as Ins;
    for (const i of ins) if (i.proc?.ability.category === 'buff') i.proc.ability.cooldown = Math.round(i.proc.ability.cooldown * 8);
    return { 'skill-tree': t, 'skill-inserts': ins };
  };
  const world = (rows: Record<string, unknown>): { config: ConfigRegistry; live: ReturnType<typeof liveConfig>; incidents: string[] } => {
    const config = new ConfigRegistry();
    const incidents: string[] = [];
    const live = liveConfig({
      config, readOverrides: async () => structuredClone(rows), deleteOverride: async (k) => { delete rows[k]; },
      changed: () => undefined, log: () => undefined, warn: () => undefined, incident: (s) => { incidents.push(s); },
    });
    return { config, live, incidents };
  };
  const warcry = (c: ConfigRegistry): Tree['nodes'][number] => (c.get('skill-tree') as unknown as Tree).nodes.find((n) => n.id === 'b-class-warrior-a5')!;

  it('наблюдатель: balance.json с отдыхом 1.0 годен лишь с древом и вставками базы — принят, как его примет старт (⭐ R22-02); пересборка не бросает', async () => {
    const w = world(x8());
    await w.live.rebuild();
    const bal = { ...structuredClone(w.config.get('balance')), buffMinRest: 1.0 };
    // ⭐ R22-02: файл уже на диске — отказ наблюдателя его оттуда не уберёт, а старт процесса возьмёт (вместе с оверрайдами база годна).
    // Раньше — «не применён»: живое 0.25, диск 1.0, рестарт — 1.0; «Применить везде» баланса затирало файл живой таблицей.
    await expect(w.live.applyFile('balance', bal)).resolves.toBeUndefined();
    expect(w.config.get('balance').buffMinRest, 'живой конфиг — с файла').toBe(1.0);
    await expect(w.live.rebuild(), 'пересборка (сверка, «Применить») не бросает').resolves.toBeUndefined();
    expect(w.config.get('balance').buffMinRest, 'основа — новый файл').toBe(1.0);
    expect(warcry(w.config).effect.active!.cooldown, 'древо хозяина живёт').toBe(108);
    expect(w.incidents, 'вместе с оверрайдами базы набор годен — старт тоже промолчал бы').toEqual([]);
  });

  it('старт над файлами, вместе нарушающими правило (закоммиченная пара, правка на диске при лежащем сервере): сборка не бросает — ИНЦИДЕНТ, живой конфиг годен', async () => {
    const w = world({});
    w.live.noteFile('balance', { ...structuredClone(file().get('balance')), buffMinRest: 1.0, respecCost: 777 });
    await expect(w.live.rebuild(), 'было — бросок, а на старте процесс падал').resolves.toBeUndefined();
    expect(w.config.get('balance').buffMinRest, 'файл баланса лёг').toBe(1.0);
    expect(w.config.get('balance').respecCost).toBe(777);
    expect(w.incidents.join('\n')).toMatch(/ИНЦИДЕНТ[\s\S]*skill-tree[\s\S]*правил/);
    expect(() => new ConfigRegistry().loadAll(w.config.snapshot() as unknown as Record<string, unknown>), 'живой конфиг держит правило D4').not.toThrow();
  });

  it('те же файлы, но древо и вставки хозяина в базе держат отдых 1.0 — годно вместе: ни инцидента, ни приведения', async () => {
    const w = world(x8());
    w.live.noteFile('balance', { ...structuredClone(file().get('balance')), buffMinRest: 1.0 });
    await w.live.rebuild();
    expect(w.incidents).toEqual([]);
    expect(w.config.get('balance').buffMinRest).toBe(1.0);
    expect(warcry(w.config).maxRank).toBe(8);
  });
});

/**
 * ⭐ R22-02: НАБЛЮДАТЕЛЬ ФАЙЛОВ РЕШАЕТ ТО ЖЕ, ЧТО СТАРТ. С R21-03 наблюдатель проверял ОДИН файл строго поверх кандидата со ВСЕМИ оверрайдами
 * базы и прежними соседними файлами, а отказ оставлял только строку «не применён»: файл лежал на диске, живой конфиг и редактор — на старой
 * таблице. Годный вместе набор (git pull баланса вместе с древом и вставками) отказывался при любом порядке событий; файл, спорящий лишь с
 * оверрайдом ДРУГОЙ таблицы, — тоже (мимо правила «файл главнее оверрайда»). Дальше «Применить везде» той таблицы из редактора (он грузит
 * живое) писало СТАРУЮ живую таблицу поверх файла — правка напарника молча откатывалась на диске, а рестарт до того собирал другой конфиг
 * (оверрайд хозяина «приводился»), чем работающий процесс. И чтение базы шло ДО всего: при лежащей базе правка файла терялась насовсем.
 * Теперь основа — файлы, какие они на диске: годный схемой файл (или пачка файлов одного окна дребезга) ложится в основу, как его возьмёт
 * старт, а правило поверх таблиц решается над итоговым кандидатом (спорящий оверрайд чужой таблицы — зажим вслух, как на старте).
 */
describe('⭐ R22-02: наблюдатель файлов решает то же, что старт процесса', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  type Tree = { nodes: { id: string; maxRank: number; effect: { active?: { category?: string; cooldown: number } } }[] };
  type Ins = { id: string; proc?: { ability: { category?: string; cooldown: number } } }[];
  const file = (): ConfigRegistry => { const c = new ConfigRegistry(); c.loadAll(); return c; };
  /** Набор, годный только вместе: отдых 3 в балансе и откаты всех баффов 5000 с в древе и вставках. */
  const together = (): Record<string, unknown> => {
    const f = file();
    const tree = structuredClone(f.get('skill-tree')) as unknown as Tree;
    for (const n of tree.nodes) if (n.effect.active?.category === 'buff') n.effect.active.cooldown = 5000;
    const ins = structuredClone(f.get('skill-inserts')) as unknown as Ins;
    for (const i of ins) if (i.proc?.ability.category === 'buff') i.proc.ability.cooldown = 5000;
    return { balance: { ...structuredClone(f.get('balance')), buffMinRest: 3 }, 'skill-inserts': ins, 'skill-tree': tree };
  };
  interface W { config: ConfigRegistry; live: ReturnType<typeof liveConfig>; rows: Map<string, unknown>; said: string[]; failReads: number }
  const world = (rows: Record<string, unknown> = {}): W => {
    const w = { config: new ConfigRegistry(), rows: new Map(Object.entries(rows).map(([k, v]) => [k, structuredClone(v)])), said: [] as string[], failReads: 0 } as W;
    w.live = liveConfig({
      config: w.config,
      readOverrides: async () => {
        if (w.failReads > 0) { w.failReads--; throw new Error('connection terminated unexpectedly'); }
        return Object.fromEntries([...w.rows].map(([k, v]) => [k, structuredClone(v)]));
      },
      deleteOverride: async (k) => { w.rows.delete(k); }, changed: () => undefined,
      log: () => undefined, warn: (s) => { if (/приведён/.test(s)) w.said.push(s); }, incident: (s) => { w.said.push(s); },
    });
    return w;
  };
  /** Старт нового процесса над той же базой и файлами на диске: настоящий живой конфиг. */
  const restart = async (w: W, disk: Record<string, unknown>): Promise<{ config: ConfigRegistry; said: string[] }> => {
    const b = world(Object.fromEntries(w.rows));
    for (const [k, v] of Object.entries(disk)) b.live.noteFile(k, v);
    await b.live.rebuild();
    return { config: b.config, said: b.said };
  };
  const ward = (c: ConfigRegistry): number => (c.get('skill-inserts') as unknown as Ins).find((i) => i.id === 'ins-ward')!.proc!.ability.cooldown;
  const warcryOf = (t: Tree): Tree['nodes'][number] => t.nodes.find((n) => n.id === 'b-class-warrior-a5')!;
  const warcry = (c: ConfigRegistry): Tree['nodes'][number] => warcryOf(c.get('skill-tree') as unknown as Tree);

  it('три файла, годные только вместе: по одному в обоих порядках и разом — все живут; в итоге ни приведения, ни инцидента; живое ≡ рестарт', async () => {
    const disk = together();
    const probe = file();
    probe.reload(structuredClone(disk) as never, { cross: false });
    expect(configCrossIssues((k) => probe.get(k)), 'вместе набор годен').toEqual([]);
    for (const how of ['баланс первым', 'баланс последним', 'разом'] as const) {
      const w = world();
      await w.live.rebuild();
      const keys = how === 'баланс последним' ? ['skill-tree', 'skill-inserts', 'balance'] : ['balance', 'skill-inserts', 'skill-tree'];
      if (how === 'разом') {
        const got = await Promise.allSettled(keys.map((k) => w.live.applyFile(k, structuredClone(disk[k]))));
        expect(got.map((g) => g.status), `${how}: было — [rejected, fulfilled, fulfilled]`).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      } else {
        for (const k of keys) await expect(w.live.applyFile(k, structuredClone(disk[k])), `${how}: ${k}`).resolves.toBeUndefined();
      }
      expect(w.config.get('balance').buffMinRest, `${how}: было — баланс «не применён», живое 0.25`).toBe(3);
      expect(ward(w.config), how).toBe(5000);
      expect(warcry(w.config).effect.active!.cooldown, how).toBe(5000);
      w.said.length = 0;
      await w.live.rebuild();
      expect(w.said, `${how}: итог годен — ни приведения, ни инцидента`).toEqual([]);
      const b = await restart(w, disk);
      expect(b.config.revision(), `${how}: рестарт ≡ работающий`).toBe(w.config.revision());
    }
  });

  it('пачка одного окна дребезга (`applyFiles`) — ни одной строки по пути: промежуточного «баланс без древа» нет', async () => {
    const w = world();
    await w.live.rebuild();
    const out = await w.live.applyFiles(together());
    expect([...out.taken].sort()).toEqual(['balance', 'skill-inserts', 'skill-tree']);
    expect(out.refused).toEqual({});
    expect(w.said).toEqual([]);
    expect(w.config.get('balance').buffMinRest).toBe(3);
  });

  it('клич хозяина 12.7 с в базе + balance.json с отдыхом 0.26 и ценой сброса 4242: файл принят, клич приведён вслух (8 → 7), работающий ≡ рестарт', async () => {
    const tree = structuredClone(file().get('skill-tree')) as unknown as Tree;
    warcryOf(tree).effect.active!.cooldown = 12.7;
    const w = world({ 'skill-tree': tree });
    await w.live.rebuild();
    expect(w.said).toEqual([]);
    const bal = { ...structuredClone(file().get('balance')), buffMinRest: 0.26, respecCost: 4242 };
    await expect(w.live.applyFile('balance', bal), 'было — «не применён» (строгая проба поверх оверрайда древа)').resolves.toBeUndefined();
    expect(w.config.get('balance').respecCost, 'правка напарника живёт').toBe(4242);
    expect(w.config.get('balance').buffMinRest).toBe(0.26);
    expect(warcry(w.config).maxRank, 'оверрайд чужой таблицы приведён — как на старте').toBe(7);
    expect(w.said.join('\n')).toMatch(/оверрайд конфига "skill-tree"[\s\S]*приведён[\s\S]*b-class-warrior-a5\.maxRank: 8 → 7/);
    const b = await restart(w, { balance: bal });
    expect(b.config.revision(), 'было — рестарт собирал другой конфиг (приведённый клич), чем работающий').toBe(w.config.revision());
    expect(b.said, 'рестарт говорит то же').toEqual(w.said);
  });

  it('негодный схемой файл (пишется, опечатка) — отказ с причиной, в основу не ложится; поправленный — ложится', async () => {
    const w = world();
    await w.live.rebuild();
    const out = await w.live.applyFiles({ balance: { ...structuredClone(file().get('balance')), respecCost: 'много' }, rarities: structuredClone(file().get('rarities')) });
    expect(out.taken, 'соседний годный файл пачки ложится').toEqual(['rarities']);
    expect(out.refused.balance).toMatch(/balance[\s\S]*respecCost/);
    await w.live.rebuild();
    expect(w.config.get('balance').respecCost).toBe(file().get('balance').respecCost);
    await w.live.applyFile('balance', { ...structuredClone(file().get('balance')), respecCost: 999 });
    expect(w.config.get('balance').respecCost).toBe(999);
  });

  it('наблюдатель при лежащей базе: правка файла не теряется — повтор, и она ложится (оверрайд «файл главнее» снят)', async () => {
    vi.useFakeTimers();
    const { configWatcher } = await import('./configWatch.js');
    const w = world({ balance: { ...structuredClone(file().get('balance')), respecCost: 111 } });
    await w.live.rebuild();
    const disk = new Map<string, unknown>([['balance.json', { ...structuredClone(file().get('balance')), respecCost: 555 }]]);
    const warned: string[] = [];
    const watch = configWatcher({
      live: w.live, keys: Object.keys(defaultConfigData), read: (f) => structuredClone(disk.get(f)),
      log: () => undefined, warn: (s) => { warned.push(s); }, debounceMs: 200, retryMs: 3_000,
    });
    w.failReads = 1;   // база не ответила на чтение оверрайдов
    watch.touched('balance.json');
    await vi.advanceTimersByTimeAsync(250);
    expect(warned.join('\n'), 'сбой сказан вслух, с повтором').toMatch(/balance\.json[\s\S]*повтор/);
    await vi.advanceTimersByTimeAsync(3_100);
    watch.stop();
    expect(w.config.get('balance').respecCost, 'было — правка файла потеряна насовсем').toBe(555);
    expect(w.rows.has('balance'), 'устаревший оверрайд снят — файл главнее').toBe(false);
  });

  it('наблюдатель: файлы одного окна дребезга — одной пачкой; отказанный файл перечитывается при следующем применении', async () => {
    vi.useFakeTimers();
    const { configWatcher } = await import('./configWatch.js');
    const w = world();
    await w.live.rebuild();
    const t = together();
    const disk = new Map<string, unknown>([['balance.json', t.balance], ['skill-tree.json', t['skill-tree']], ['skill-inserts.json', t['skill-inserts']]]);
    const batches: string[][] = [];
    const live = {
      applyFiles: async (c: Record<string, unknown>) => { batches.push(Object.keys(c).sort()); return w.live.applyFiles(c); },
      fileMatches: (k: string, d: unknown) => w.live.fileMatches(k, d),
    };
    const read = (f: string): unknown => { if (!disk.has(f)) throw new Error('нет файла'); return structuredClone(disk.get(f)); };
    const watch = configWatcher({ live, keys: Object.keys(defaultConfigData), read, log: () => undefined, warn: () => undefined });
    watch.touched('balance.json');
    await vi.advanceTimersByTimeAsync(50);
    watch.touched('skill-inserts.json');
    watch.touched('skill-tree.json');
    watch.touched('README.md');   // не таблица — мимо
    await vi.advanceTimersByTimeAsync(250);
    expect(batches, 'одна пачка на окно').toEqual([['balance', 'skill-inserts', 'skill-tree']]);
    expect(w.said).toEqual([]);
    expect(w.config.get('balance').buffMinRest).toBe(3);
    // Битый файл: отказ; при следующем применении (любой файл) он перечитывается — поправленный ложится.
    disk.set('rarities.json', { oops: true });
    watch.touched('rarities.json');
    await vi.advanceTimersByTimeAsync(250);
    disk.set('rarities.json', structuredClone(file().get('rarities')).map((r, i) => (i ? r : { ...r, priceMult: 7 })));
    watch.touched('balance.json');
    await vi.advanceTimersByTimeAsync(250);
    watch.stop();
    expect(batches.at(-1), 'отказанный перечитан вместе со следующей пачкой').toEqual(['balance', 'rarities']);
    expect(w.config.get('rarities')[0]!.priceMult).toBe(7);
  });
});

/**
 * ⭐ R22-06: СЛОЙ ФАЙЛОВ, УЖЕ НАРУШАЮЩИЙ ПРАВИЛО (старт его принял с инцидентом, R21-03), НЕ ЗАПИРАЕТ ПРАВКИ ЧУЖИХ ТАБЛИЦ. Проба «в файл»
 * грузила весь слой файлов со всеми правилами — и отказывала из-за нарушения, которое уже лежало, что бы ни правили: «Применить везде»
 * моделей и материалов поз-редактора, наблюдатель `monsters.json`, `weapon-parts.json`. Теперь отказ — только правке, которая вносит в слой
 * файлов НОВОЕ нарушение или углубляет лежащее (ранг раньше, нехватка больше); лежащее — инцидент старта, как было.
 */
describe('⭐ R22-06: слой файлов уже нарушает правило — чужие таблицы пишутся, новое или углублённое нарушение — отказ', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  type Tree = { nodes: { id: string; maxRank: number; effect: { active?: { cooldown: number } } }[] };
  const file = (): ConfigRegistry => { const c = new ConfigRegistry(); c.loadAll(); return c; };
  const world = async (rows: Record<string, unknown> = {}): Promise<{ config: ConfigRegistry; live: ReturnType<typeof liveConfig>; incidents: string[] }> => {
    const config = new ConfigRegistry();
    const incidents: string[] = [];
    const live = liveConfig({
      config, readOverrides: async () => structuredClone(rows), deleteOverride: async () => undefined, changed: () => undefined,
      log: () => undefined, warn: () => undefined, incident: (s) => { incidents.push(s); },
    });
    live.noteFile('balance', { ...structuredClone(file().get('balance')), buffMinRest: 0.3 });   // «Ворожея» на 8-м ранге — короче правила
    await live.rebuild();
    return { config, live, incidents };
  };

  it('чужая таблица (монстры, детали оружия) и правка баланса мимо отдыха — проходят и пробу «в файл», и наблюдатель', async () => {
    const w = await world();
    expect(w.incidents.join('\n'), 'нарушение уже лежит — инцидент старта').toMatch(/ИНЦИДЕНТ[\s\S]*skill-tree/);
    const monsters = structuredClone(w.config.get('monsters'));
    expect(await w.live.trial({ monsters }, { files: true }), 'было — 422 «…Конфиг "skill-tree" не прошёл валидацию»').toBeNull();
    expect(await w.live.trial({ 'weapon-parts': structuredClone(w.config.get('weapon-parts')) }, { files: true })).toBeNull();
    expect(await w.live.trial({ balance: { ...structuredClone(w.config.get('balance')), respecCost: 777 } }, { files: true }), 'отдых тот же — нарушение не глубже').toBeNull();
    await expect(w.live.applyFile('monsters', monsters), 'было — «не применён»').resolves.toBeUndefined();
  });

  it('правка, вносящая новое нарушение или углубляющая лежащее, — отказ «в файл» с тем, что нового (оверрайды базы её держат); исправляющая — проходит', async () => {
    // Древо и вставки ×3 — оверрайдами базы: кандидат с ними годен и при отдыхе 0.35, а слой файлов (древо файла) — нет.
    const x3 = (): Record<string, unknown> => {
      const t = structuredClone(file().get('skill-tree')) as unknown as { nodes: { effect: { active?: { category?: string; cooldown: number } } }[] };
      for (const n of t.nodes) if (n.effect.active?.category === 'buff') n.effect.active.cooldown *= 3;
      return { 'skill-tree': t };
    };
    const w = await world(x3());
    const worse = await w.live.trial({ balance: { ...structuredClone(w.config.get('balance')), buffMinRest: 0.35 } }, { files: true });
    expect(worse, 'отдых выше: клич и «Вьюга» — новые, «Ворожея» — уже с 7-го ранга').toMatch(/без оверрайдов базы[\s\S]*b-class-warrior-a5/);
    expect(worse).toMatch(/b-class-vorozheya-a3/);
    // Отдых 0.1 — оверрайдом базы: кандидат годен, а в слое файлов (отдых 0.3) «Ворожея» с откатом на 1 с короче падает уже с 6-го ранга.
    const v = await world({ balance: { ...structuredClone(file().get('balance')), buffMinRest: 0.1 } });
    const deeper = structuredClone(file().get('skill-tree')) as unknown as Tree;
    deeper.nodes.find((n) => n.id === 'b-class-vorozheya-a3')!.effect.active!.cooldown -= 1;
    expect(await v.live.trial({ 'skill-tree': deeper }, { files: true }), 'нарушение глубже (ранг 8 → 6) — отказ').toMatch(/без оверрайдов базы[\s\S]*b-class-vorozheya-a3/);
    expect(await v.live.trial({ 'skill-tree': deeper }), 'оверрайдом (не в файл) — годно: кандидат держит').toBeNull();
    const fixed = structuredClone(file().get('skill-tree')) as unknown as Tree;
    fixed.nodes.find((n) => n.id === 'b-class-vorozheya-a3')!.maxRank = 7;   // потолок — до последнего годного: нарушение снято
    expect(await v.live.trial({ 'skill-tree': fixed }, { files: true }), 'исправление проходит').toBeNull();
  });
});
