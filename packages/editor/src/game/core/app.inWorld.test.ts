import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { App } from './app.js';

/**
 * ⭐ R6-25: «ГЕРОЙ В МИРЕ» — `App.inWorld`. Его ведёт поток входа (`EntryFlow` → `setInWorld`): вход состоялся — да;
 * связь потеряна, отказ входа, выход из игры — нет. Вне мира хоткеи окон и [E] у NPC молчат, а КАЖДАЯ смена закрывает все
 * окна: открытое в прошлой сессии не висит под экраном входа, открытое до входа не переходит в новую сессию.
 *
 * Браузерного WebSocket в node нет — `App` строится с подделкой (сокет ему здесь не нужен).
 */
class FakeWs { static OPEN = 1; readyState = 0; binaryType = ''; onopen = null; onclose = null; onmessage = null; send(): void { } close(): void { } }

describe('⭐ R6-25: App.inWorld', () => {
  const G = globalThis as unknown as { WebSocket?: unknown; fetch?: unknown };
  let saved: { ws: unknown; fetch: unknown };
  beforeEach(() => {
    saved = { ws: G.WebSocket, fetch: G.fetch };
    G.WebSocket = FakeWs;
    G.fetch = () => Promise.reject(new Error('сети нет'));
  });
  afterEach(() => { G.WebSocket = saved.ws; G.fetch = saved.fetch; });

  it('страница открывается вне мира; вход и потеря связи закрывают все окна — один раз на смену', () => {
    const app = new App();
    let closes = 0;
    app.bus.on('ui:closeAll', () => { closes++; });
    expect(app.inWorld, 'вход в аккаунт, выбор героя, «Подключение…» — не мир').toBe(false);
    app.setInWorld(true);
    expect(app.inWorld).toBe(true);
    expect(closes, 'окно, открытое до входа, не переходит в новую сессию').toBe(1);
    app.setInWorld(true);
    expect(closes, 'повтор — не смена').toBe(1);
    app.setInWorld(false);
    expect(closes, 'связь потеряна — окна прошлой сессии прочь').toBe(2);
    app.setInWorld(false);
    expect(closes).toBe(2);
  });
});
