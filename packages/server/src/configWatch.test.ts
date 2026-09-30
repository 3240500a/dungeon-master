import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigRegistry, configSchemas, defaultConfigData } from '@dm/shared';
import { liveConfig } from './configLive.js';
import { configWatcher } from './configWatch.js';
import { configKeyForFile } from './configFiles.js';

const KEYS = Object.keys(configSchemas);
const file = (): ConfigRegistry => { const c = new ConfigRegistry(); c.loadAll(); return c; };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/**
 * ⭐ R23-06: ФАЙЛ, ИЗМЕНЁННЫЙ МЕЖДУ ИМПОРТОМ ДАННЫХ И ВЗВЕДЕНИЕМ НАБЛЮДАТЕЛЯ, — НЕ ПОТЕРЯН. `defaults.ts` импортирует `data/*.json` при загрузке
 * модуля, а наблюдатель (`watchConfigFiles`) взводится в конце `boot()` — после схемы базы, ревизии и сборки конфига (секунды; у нод кластера —
 * дольше, они ждут замок схемы). `tsx watch` папку данных не видит, так что файл, записанный в этом окне (генератор, руки, `git pull` вместе с
 * `.ts` — перезапуск), не видел никто: живой конфиг и `/api/config` — на импорте, а любой рестарт собирал новый (обратно R22-02: работающий ≡
 * рестарт). И «Применить везде» этой таблицы отвечало 409 навсегда (`fileMatches` сверял диск с импортом), обещая «сервер возьмёт его сам» —
 * а события ФС больше не было. Теперь наблюдатель, едва взведён, сверяет файлы всех таблиц с основой (`sweep`): разошедшийся — как тронутый.
 */
describe('⭐ R23-06: наблюдатель, взведённый после импорта, сверяет диск с основой', () => {
  const world = (rows: Record<string, unknown> = {}) => {
    const config = new ConfigRegistry();
    const overrides = new Map(Object.entries(rows));
    const live = liveConfig({
      config, readOverrides: async () => Object.fromEntries(overrides), deleteOverride: async (k) => { overrides.delete(k); }, changed: () => undefined,
      log: () => undefined, warn: () => undefined, incident: () => undefined,
    });
    return { config, overrides, live };
  };

  it('balance.json изменён до взведения: после взведения и дребезга живое ≡ диск, `fileMatches` — да, живое ≡ рестарт; чужие оверрайды не тронуты', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rar = structuredClone(file().get('rarities'));
    rar[0]!.priceMult += 0.5;
    const w = world({ rarities: rar });   // правка хозяина в базе по таблице, чей файл не менялся
    await w.live.rebuild();   // старт: основа — импорт
    const bal = { ...structuredClone(file().get('balance')), respecCost: 4242 };
    const disk: Record<string, unknown> = { balance: bal };   // `git pull` лёг, пока процесс собирал конфиг
    const read = vi.fn((f: string) => structuredClone(disk[configKeyForFile(f, KEYS)!] ?? (defaultConfigData as Record<string, unknown>)[configKeyForFile(f, KEYS)!]));
    const applied: string[][] = [];
    const watch = configWatcher({
      live: { applyFiles: (c) => { applied.push(Object.keys(c).sort()); return w.live.applyFiles(c); }, fileMatches: (k, d) => w.live.fileMatches(k, d) },
      keys: KEYS, read, log: () => undefined, warn: () => undefined, debounceMs: 200,
    });
    // (событий ФС не будет — файл записан до взведения)
    watch.sweep();
    await vi.advanceTimersByTimeAsync(250);
    watch.stop();
    expect(w.config.get('balance').respecCost, 'было — импорт старта до следующего рестарта').toBe(4242);
    expect(w.live.fileMatches('balance', disk.balance), 'было — нет: «Применить везде» баланса — 409 навсегда').toBe(true);
    expect(applied, 'в пачку — только разошедшийся файл: равные диску не применяются (их оверрайды «файл главнее» не снимает)').toEqual([['balance']]);
    expect(w.overrides.has('rarities'), 'оверрайд таблицы, чей файл не менялся, цел').toBe(true);
    expect(w.config.get('rarities')[0]!.priceMult).toBe(rar[0]!.priceMult);
    const restart = world({ rarities: rar });
    restart.live.noteFile('balance', bal);
    await restart.live.rebuild();
    expect(restart.config.revision(), 'работающий ≡ рестарт').toBe(w.config.revision());
  });

  it('диск ≡ импорт — ни одного применения; нечитаемый файл (пишется) — как тронутый: применение его перечитает', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    await w.live.rebuild();
    const applied: string[][] = [];
    let torn = false;
    const read = (f: string): unknown => {
      const k = configKeyForFile(f, KEYS)!;
      if (k === 'rarities' && torn) throw new Error('Unexpected end of JSON input');
      return structuredClone((defaultConfigData as Record<string, unknown>)[k]);
    };
    const watch = configWatcher({
      live: { applyFiles: (c) => { applied.push(Object.keys(c).sort()); return w.live.applyFiles(c); }, fileMatches: (k, d) => w.live.fileMatches(k, d) },
      keys: KEYS, read, log: () => undefined, warn: () => undefined, debounceMs: 200,
    });
    watch.sweep();
    await vi.advanceTimersByTimeAsync(250);
    expect(applied, 'диск ≡ основа — применять нечего').toEqual([]);
    torn = true;   // файл пойман на середине записи
    watch.sweep();
    torn = false;   // дописан
    await vi.advanceTimersByTimeAsync(250);
    watch.stop();
    expect(applied, 'нечитаемый на сверке — перечитан применением').toEqual([['rarities']]);
  });
});

/**
 * ⚠ R23-07: ЛЕЖАЩАЯ БАЗА НЕ ТОПИТ ЛОГ И У НАБЛЮДАТЕЛЯ. Применение правки файла, упавшее на базе (`readOverrides`: локальный Postgres
 * перезапускается, ноутбук спал), повторяется каждые `retryMs` (3 с), и каждый повтор писал полную строку предупреждения — строка раз в 3–8 с
 * весь простой базы. Правило сверки конфига (`configSync.ts`) и путей R7-05/R11-11/R17-06 — не чаще раза в минуту, с числом промолчанных.
 */
describe('⚠ R23-07: повтор применения при лежащей базе — лог не чаще раза в минуту', () => {
  it('21 повтор за минуту: применений 21, строк предупреждения — две (первая сразу, вторая через минуту — с числом промолчанных); повтор не тронут', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let calls = 0;
    const warned: string[] = [];
    const watch = configWatcher({
      live: { applyFiles: async () => { calls++; throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); }, fileMatches: () => true },
      keys: ['balance', 'rarities'], read: () => ({}), log: () => undefined, warn: (s) => { warned.push(s); }, debounceMs: 200, retryMs: 3_000,
    });
    watch.touched('balance.json');
    await vi.advanceTimersByTimeAsync(200 + 19 * 3_000 + 100);
    expect(calls, 'повтор — каждые 3 с, как был').toBe(20);
    expect(warned, 'было — строка на каждый повтор').toHaveLength(1);
    expect(warned[0]).toMatch(/balance\.json[\s\S]*ECONNREFUSED[\s\S]*повтор/);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(21);
    expect(warned, 'через минуту — одна строка с числом промолчанных').toHaveLength(2);
    expect(warned[1]).toMatch(/и ещё 19/);
    watch.stop();
  });
});
