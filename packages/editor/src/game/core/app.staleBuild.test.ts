import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from './app.js';
import { PROTOCOL_STALE } from '../net/versionGate.js';

/**
 * ⭐ R10-12: ЛЮБОЙ ЛЕНИВЫЙ КУСОК СБОРКИ, НЕ ЗАГРУЗИВШИЙСЯ ПОСЛЕ ДЕПЛОЯ, — «ПЕРЕЗАГРУЗИТЕ СТРАНИЦУ».
 *
 * Обёртка Vite вокруг каждого ленивого `import()` сборки шлёт на `window` событие `vite:preloadError`, если кусок (или
 * его зависимость) не загрузился. Раньше его не слушал никто: вкладка, пережившая деплой (L2 — без перезагрузки, тот же
 * `PROTOCOL_VERSION`), узнавала о новом коде только по сломанному окну. Теперь `App` (игра — не мост редактора) говорит
 * игроку `PROTOCOL_STALE` один раз на страницу и события не гасит: `import()` по-прежнему отказывает своему вызывающему.
 */
describe('⭐ R10-12: `vite:preloadError` — игроку «перезагрузите страницу», один раз', () => {
  const G = globalThis as unknown as { window?: unknown; fetch?: unknown };
  let saved: { window: unknown; fetch: unknown };
  beforeEach(() => {
    saved = { window: G.window, fetch: G.fetch };
    G.window = new EventTarget();
    G.fetch = () => Promise.reject(new Error('сервер перезапускается'));
    vi.spyOn(console, 'warn').mockImplementation(() => { });
  });
  afterEach(() => { G.window = saved.window; G.fetch = saved.fetch; vi.restoreAllMocks(); });

  it('кусок не загрузился — строка в лог игры; второй сбой — без второй строки; мост редактора молчит; событие не погашено', () => {
    const app = new App();
    const bridge = new App({ offline: true });   // мост редактора (`gameHarness`): у него нет ни лога, ни деплоя
    const logs: string[] = [], bridgeLogs: string[] = [];
    app.bus.on('log:message', (m) => { logs.push(m.text); });
    bridge.bus.on('log:message', (m) => { bridgeLogs.push(m.text); });
    const w = G.window as EventTarget;

    const e1 = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: new TypeError('Failed to fetch dynamically imported module') });
    w.dispatchEvent(e1);
    expect(logs, 'было: событие не слушал никто').toEqual([PROTOCOL_STALE]);
    expect(e1.defaultPrevented, 'не гасим: `import()` отказывает своему вызывающему (окно ковки, модель оружия)').toBe(false);

    w.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(logs, 'одна строка на страницу').toEqual([PROTOCOL_STALE]);
    expect(bridgeLogs).toEqual([]);
  });
});
