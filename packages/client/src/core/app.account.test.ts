import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newBotSave, type Item } from '@dm/shared';
import { App } from './app.js';

/**
 * ⭐ R5-17: СОСТОЯНИЕ АККАУНТА И ГЕРОЯ В `App` НЕ ПЕРЕЖИВАЕТ СМЕНУ АККАУНТА И ГЕРОЯ.
 *
 * `App` живёт всю жизнь страницы, а после R4-22 страница без перезагрузки уходит ко входу («вход недействителен») или к
 * выбору героя («герой недоступен») — и входит ДРУГИМ аккаунтом или героем. Сундук (сырьё и журнал кузнеца), прилавок с
 * его ценами, доска заданий и забег оставались от прежнего: окно кузницы, не дождавшись `stash`, считало чужое сырьё и
 * чужой журнал (`stashLost` смотрит только на «сундук есть»).
 *
 * Браузерного WebSocket в node нет — `App` строится с подделкой (сокет ему здесь не нужен).
 */
class FakeWs { static OPEN = 1; readyState = 0; binaryType = ''; onopen = null; onclose = null; onmessage = null; send(): void { } close(): void { } }

describe('⭐ R5-17: смена аккаунта и героя сбрасывает их состояние в App', () => {
  const G = globalThis as unknown as { WebSocket?: unknown; fetch?: unknown };
  let saved: { ws: unknown; fetch: unknown };
  beforeEach(() => {
    saved = { ws: G.WebSocket, fetch: G.fetch };
    G.WebSocket = FakeWs;
    G.fetch = () => Promise.reject(new Error('сети нет'));
  });
  afterEach(() => { G.WebSocket = saved.ws; G.fetch = saved.fetch; });

  /** App «в игре» аккаунта A героем hero-a: сундук с журналом, прилавок, доска и забег уже пришли кадрами. */
  function inGame(): App {
    const app = new App();
    app.setAuth({ token: 'ab'.repeat(32), userId: 'user-a', username: 'a' });
    app.pendingCharId = 'hero-a';
    const item = newBotSave(app.config, app.config.get('classes')[0]!.id).equipment.weapon as Item;
    app.applyStash({ t: 'stash', tabs: [[]], cols: 10, rows: 8, tabCount: 1, materials: { 'iron-1': 40 }, forgeJournal: { types: ['x'] } as never });
    app.shopStock = [item];
    app.shopPrices = { [item.uid]: 120 };
    app.questBoard = [{ id: 'q' } as never];
    app.run = { plan: {} as never, currentNodeId: 'n1' };
    return app;
  }
  const empty = (app: App): void => {
    expect(app.stash, 'сундук и журнал кузнеца прежнего аккаунта').toBeNull();
    expect(app.shopStock).toEqual([]);
    expect(app.shopPrices).toEqual({});
    expect(app.questBoard).toEqual([]);
    expect(app.run).toBeNull();
  };

  it('⭐ «вход недействителен» (clearAuth) — всё прежнего аккаунта забыто', () => {
    const app = inGame();
    app.clearAuth();
    empty(app);
  });

  it('⭐ «герой недоступен» (другой герой) — прилавок, доска, забег и слепок сундука — заново', () => {
    const app = inGame();
    app.pendingCharId = null;
    empty(app);
    const again = inGame();
    again.pendingCharId = 'hero-b';
    empty(again);
  });

  it('вход другим аккаунтом без выхода — тоже сброс; тот же герой и тот же аккаунт — ничего не трогают', () => {
    const app = inGame();
    app.pendingCharId = 'hero-a';
    app.setAuth({ token: 'cd'.repeat(32), userId: 'user-a', username: 'a' });   // новый токен того же аккаунта
    expect(app.stash).not.toBeNull();
    expect(app.shopStock).toHaveLength(1);
    app.setAuth({ token: 'ef'.repeat(32), userId: 'user-b', username: 'b' });
    empty(app);
  });
});
