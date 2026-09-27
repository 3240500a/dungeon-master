import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultConfigData, newBotSave, ConfigRegistry } from '@dm/shared';
import { followHarness, makeHarness } from './gameHarness.js';

/**
 * ⭐ R7-15: МОСТ РЕДАКТОРА СЧИТАЕТ ПО ДАННЫМ, КОТОРЫЕ ЕМУ ДАЛИ. Песочница ковки («Лестница блока», «Грань дальнего боя» —
 * правка `items.base`) и калькулятор строят мост из своих данных «что, если», а конструктор `App` тут же тянул `/api/config`
 * (через прокси Vite) и через несколько миллисекунд клал поверх СЕРВЕРНЫЙ конфиг — первый кадр считал по песочнице,
 * следующий клик — по серверу, а галочка оставалась включённой. Ещё и канал правок (`BroadcastChannel`) открывался на каждый
 * мост и не закрывался: брошенные мосты перечитывали конфиг на каждое «Применить». Теперь мост — `App` без сети, а правку
 * редактора он берёт из тех же данных инструмента (`followHarness`).
 */
class FakeBc {
  static open = 0;
  onmessage: ((e: unknown) => void) | null = null;
  constructor(public name: string) { FakeBc.open++; }
  close(): void { FakeBc.open--; }
  postMessage(): void { }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('⭐ R7-15: мост редактора — без сервера', () => {
  const G = globalThis as unknown as { fetch?: unknown; window?: unknown; BroadcastChannel?: unknown };
  let saved: { fetch: unknown; window: unknown; bc: unknown };
  let calls: string[];
  beforeEach(() => {
    saved = { fetch: G.fetch, window: G.window, bc: G.BroadcastChannel };
    calls = [];
    FakeBc.open = 0;
    // Сервер: стоковый конфиг — не тот, что у песочницы.
    G.fetch = async (url: string): Promise<unknown> => {
      calls.push(url);
      const body = JSON.parse(JSON.stringify(defaultConfigData)) as unknown;
      return { ok: true, status: 200, headers: { get: () => 'W/"srv"' }, json: async () => body };
    };
    G.BroadcastChannel = FakeBc;
    G.window = { BroadcastChannel: FakeBc };
  });
  afterEach(() => { G.fetch = saved.fetch; G.window = saved.window; G.BroadcastChannel = saved.bc; });

  /** Данные «что, если»: другая цена сброса — сервер такой не знает. */
  function whatIf(cost: number): Record<string, unknown> {
    const d = structuredClone(defaultConfigData) as unknown as Record<string, unknown>;
    (d.balance as { respecCost: number }).respecCost = cost;
    return d;
  }

  it('⭐ конфиг моста — данные инструмента и после ответа сервера; к серверу не ходит, канал правок не держит', async () => {
    const data = whatIf(12345);
    const reg = new ConfigRegistry(); reg.loadAll(data);
    const app = makeHarness(data, newBotSave(reg, 'warrior'), () => { });
    let changed = 0;
    app.bus.on('state:changed', () => { changed++; });
    expect(app.config.get('balance').respecCost).toBe(12345);
    await flush();
    expect(app.config.get('balance').respecCost, 'было: 500 — серверный конфиг поверх песочницы').toBe(12345);
    expect(calls, 'мост не спрашивает сервер').toEqual([]);
    expect(FakeBc.open, 'было: канал на каждый мост, не закрывался').toBe(0);
    expect(changed, 'сам по себе мост не перерисовывает инструмент').toBe(0);
    await app.syncConfig();                         // вход в мир у моста не бывает, но и прямой вызов — без сети
    expect(calls).toEqual([]);
  });

  it('правка в редакторе доходит до моста из данных инструмента — сейв моста цел', () => {
    const data = whatIf(12345);
    const reg = new ConfigRegistry(); reg.loadAll(data);
    const save = newBotSave(reg, 'warrior');
    const app = makeHarness(data, save, () => { });
    expect(followHarness(app, data), 'данные те же — не перечитывает').toBe(false);
    (data.balance as { respecCost: number }).respecCost = 777;   // правка ручки (с «Применить» или без)
    expect(followHarness(app, data)).toBe(true);
    expect(app.config.get('balance').respecCost).toBe(777);
    expect(app.state!.save, 'билд в мосте тот же').toBe(save);
  });
});
