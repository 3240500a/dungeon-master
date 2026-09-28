import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigRegistry, configRev, staleConfigKeys } from '@dm/shared';
import { LiveConfigBase, loadLiveConfig, LOAD_RETRY_MS } from './liveConfig.js';

/**
 * ⭐ C-09: РЕДАКТОР КОНФИГОВ, ОТКРЫТЫЙ ПРИ ЛЕЖАЩЕМ СЕРВЕРЕ, НЕ ЗАТИРАЕТ ЖИВОЙ КОНФИГ ДЕФОЛТАМИ.
 *
 * Живой конфиг грузился один раз на старте (`/api/config`); не ответил сервер (перезапуск под `tsx watch` — на каждую правку кода, машина
 * недоступна) — рабочая копия оставалась встроенными дефолтами, и только строка статуса говорила «сохранять нельзя». Ничего не мешало:
 * «Применить» слало таблицу ЦЕЛИКОМ (с повтором 4 раза — как раз чтобы пережить перезапуск), и сервер заменял оверрайд — все прежние правки
 * таблицы (`balance`: цены кузницы, сброса, лавки, ковка, штраф смерти…) откатывались к дефолтам у всех игроков. Теперь: пока живой конфиг
 * не загружен, загрузка повторяется, а запись не уходит вовсе; загружен — запись несёт ревизии загруженного, и сервер отказывает (409) правке
 * поверх того, что на нём уже другое (другая вкладка, инструмент, машина).
 */
describe('⭐ C-09: рабочая копия редактора — только поверх загруженной правды сервера', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('⭐ сервер лежит на открытии: записи нет (было — дефолты таблицы целиком поверх живых правок); загрузка повторяется, пока не поднимется', async () => {
    const live = new LiveConfigBase();
    const snap = { balance: { respecCost: 999 }, rarities: [1] };   // на сервере — правки админа
    let up = false;
    const got: unknown[] = [], fails: [number, number][] = [];
    loadLiveConfig(() => (up ? Promise.resolve(structuredClone(snap)) : Promise.reject(new Error('ECONNREFUSED'))), live, {
      loaded: (s) => got.push(s), failed: (n, ms) => fails.push([n, ms]),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(live.loaded).toBe(false);
    expect(live.body({ balance: { respecCost: 100 } }), 'было: таблица из дефолтов уходила на сервер').toBeNull();
    await vi.advanceTimersByTimeAsync(LOAD_RETRY_MS[0] + LOAD_RETRY_MS[1]);
    expect(fails.map(([n]) => n), 'повтор с паузой, а не один раз на старте').toEqual([1, 2, 3]);
    expect(fails.map(([, ms]) => ms)).toEqual([LOAD_RETRY_MS[0], LOAD_RETRY_MS[1], LOAD_RETRY_MS[2]]);
    up = true;   // сервер поднялся
    await vi.advanceTimersByTimeAsync(LOAD_RETRY_MS[2]);
    expect(got).toEqual([snap]);
    expect(live.loaded).toBe(true);
    const body = live.body({ balance: { respecCost: 100 } })!;
    expect(body.balance).toEqual({ respecCost: 100 });
    expect(body.__baseRev, 'запись — поверх загруженного').toEqual({ balance: configRev(snap.balance) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fails, 'загружено — больше не спрашиваем').toHaveLength(3);
  });

  it('⭐ старый снимок: таблицу сохранили в другой вкладке — сверка сервера отказывает; своя запись сдвигает базу ответом сервера', () => {
    const server = new ConfigRegistry();
    server.loadAll();
    const cur = (k: string): unknown => (server.snapshot() as Record<string, unknown>)[k];
    const tabA = new LiveConfigBase(), tabB = new LiveConfigBase();
    tabA.accept(JSON.parse(JSON.stringify(server.snapshot())) as Record<string, unknown>);
    tabB.accept(JSON.parse(JSON.stringify(server.snapshot())) as Record<string, unknown>);
    const bal = structuredClone(server.get('balance'));
    // Вкладка B сохранила `balance` — сервер принял (база совпала) и ответил новыми ревизиями.
    const b1 = tabB.body({ balance: { ...bal, respecCost: bal.respecCost + 7 } })!;
    expect(staleConfigKeys(b1.__baseRev, ['balance'], cur)).toEqual([]);
    server.reload({ balance: b1.balance });
    tabB.saved({ balance: configRev(server.get('balance')) });
    // Вкладка A (снимок до правки B) правит другое поле той же таблицы — поверх старого: отказ, правка B цела.
    const a1 = tabA.body({ balance: { ...bal, townRestockSec: bal.townRestockSec + 1 } })!;
    expect(staleConfigKeys(a1.__baseRev, ['balance'], cur), 'было: A молча откатывала цену, выставленную B').toEqual(['balance']);
    // А B пишет дальше поверх своей же правки — база сдвинута ответом сервера.
    const b2 = tabB.body({ balance: { ...bal, respecCost: bal.respecCost + 8 } })!;
    expect(staleConfigKeys(b2.__baseRev, ['balance'], cur)).toEqual([]);
  });

  it('проводка `main.ts`: загрузка — через `loadLiveConfig`, каждая запись (Применить, в файл, инструменты, уборка ассетов) — телом `live.body`', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8');
    expect(src).toMatch(/loadLiveConfig\(/);
    expect(src, '⚠ одна загрузка на старте без повтора вернулась').not.toMatch(/function loadFromServer\(\): void \{\s*fetch\('\/api\/config'\)/);
    for (const route of ["'/api/dev/config'", "'/api/dev/config-file'"]) {
      const at = src.indexOf(`devFetch(${route}`);
      expect(at, route).toBeGreaterThan(0);
      expect(src.slice(at, at + 200), `${route}: тело — с базой (live.body), а не голые значения`).toMatch(/body: JSON\.stringify\(body\)/);
    }
    expect(src, 'тело записи — `live.body` (не загружен — null)').toMatch(/const body = live\.body\(values\);/);
    expect(src.match(/const body = liveBody\(/g)?.length, 'тело с базой — в обеих записях (оверрайд и файл)').toBe(2);
    expect(src, 'ответ 409 — отказ со строкой, без повтора').toMatch(/r\.status === 409/);
  });
});
