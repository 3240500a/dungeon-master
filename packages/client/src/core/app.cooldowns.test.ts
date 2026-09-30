import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION, newCharacterSave, type SaveState } from '@dm/shared';
import { App } from './app.js';
import { GameState } from './gameState.js';
import { buildBindBar } from '../ui/bindBar.js';

/**
 * ⭐ R21-05: ОТКАТЫ СЛОТОВ НА НОВОЙ СТРАНИЦЕ — С КАДРА ВХОДА, А НЕ С ПАМЯТИ СТРАНИЦЫ.
 *
 * Сервер на входе возвращает герою откаты умений (реконнект — запись ухода R4-06; другая комната — D4, из `vitals.cd`; вторая вкладка), а заливку
 * слота клиент ставил только по событию каста (`swing`/`cooldown`). После F5, входа с другого устройства или по коду `App.actionCooldowns` пуст —
 * слот нарисован готовым, нажатие уходит, и сервер каст молча отбрасывает до конца скрытого отката. Обратно — смена героя без перезагрузки
 * (`setAuth` другим аккаунтом, другой `pendingCharId`) оставляла заливки и общий лок прежнего героя. Теперь каждый вход начинает с откатов сервера
 * (`joined.cooldowns`: остаток и полный), а смена героя их забывает (`forgetSession`).
 *
 * Браузерного WebSocket и DOM в node нет — подделки ровно тех свойств, которыми пользуются `NetClient` и панель биндов.
 */
class FakeWs {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static last: FakeWs | null = null;
  readyState = FakeWs.CONNECTING;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) { FakeWs.last = this; }
  send(): void { }
  close(): void { this.readyState = FakeWs.CLOSED; }
  open(): void { this.readyState = FakeWs.OPEN; this.onopen?.(); }
  frame(f: unknown): void { this.onmessage?.({ data: JSON.stringify(f) }); }
}

/** Узел DOM в тех свойствах, которыми пользуется панель биндов. */
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; title = '';
  constructor(public tag: string) { }
  set innerHTML(_v: string) { this.children = []; }
  append(...c: El[]): void { this.children.push(...c); }
  addEventListener(): void { }
}

const BUFF = 'b-class-warrior-a5';   // «Боевой клич»: откат 13.5 с на 1-м ранге (D4)
const OVERLAY = 'position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6)';

describe('⭐ R21-05: откаты слотов — с кадра входа; смена героя их забывает', () => {
  const G = globalThis as unknown as { WebSocket?: unknown; fetch?: unknown; document?: unknown };
  let saved: { ws: unknown; fetch: unknown; doc: unknown };
  /** Оверлеи отката слотов панели биндов — в порядке слотов (ЛКМ, ПКМ, Shift, Q, Alt). */
  let overlays: El[];
  beforeEach(() => {
    saved = { ws: G.WebSocket, fetch: G.fetch, doc: G.document };
    G.WebSocket = FakeWs;
    G.fetch = () => Promise.reject(new Error('сети нет'));
    overlays = [];
    G.document = {
      createElement: (t: string) => {
        const e = new El(t);
        // Оверлей отката узнаётся по своему стилю (панель ставит его сразу после создания) — запоминаем все блоки, фильтр — при чтении.
        overlays.push(e);
        return e;
      },
      createTextNode: (s: string) => { const e = new El('#text'); e.textContent = s; return e; },
    };
  });
  afterEach(() => { G.WebSocket = saved.ws; G.fetch = saved.fetch; G.document = saved.doc; });

  /** Страница «в игре» воином с кличем на Shift: сокет открыт, кадр `joined` — с тем, что прислал сервер. */
  function page(cooldowns?: Record<string, { leftMs: number; fullMs: number }>): { app: App; save: SaveState; join: (cd?: Record<string, { leftMs: number; fullMs: number }>) => void } {
    const app = new App();
    app.setAuth({ token: 'ab'.repeat(32), userId: 'user-a', username: 'a' });
    app.pendingCharId = 'hero-a';
    const save = newCharacterSave(app.config, 'warrior', 'H', 'hero-a');
    save.skills[BUFF] = 1;
    save.hotbar[0] = BUFF;
    app.net.connect('ws://game.test/ws');
    FakeWs.last!.open();
    const join = (cd?: Record<string, { leftMs: number; fullMs: number }>): void => {
      FakeWs.last!.frame({ t: 'joined', v: PROTOCOL_VERSION, playerId: 'p1', roomCode: 'ABCD1234', floor: {}, peers: [], save, ...(cd ? { cooldowns: cd } : {}) });
      app.state = new GameState(save);   // мир героя строит сцена клиента на тот же кадр
    };
    join(cooldowns);
    return { app, save, join };
  }
  /** Доля заливки слота Shift панели биндов, %. */
  const shiftFill = (app: App): number => {
    const bar = buildBindBar(app);
    bar.refresh();
    const fills = overlays.filter((e) => (e.style.cssText ?? '').startsWith(OVERLAY));
    return Number.parseInt(fills.at(-3)!.style.height ?? '0', 10);
  };

  it('⭐ вход с откатом клича (сервер вернул 6 из 13.5 с) — слот залит на долю остатка, до его конца; было — готов, а каст молча отброшен', () => {
    const { app } = page({ [BUFF]: { leftMs: 6000, fullMs: 13_500 } });
    const cd = app.actionCooldowns[BUFF];
    expect(cd, 'было: страница откатов не знала — слот готов').toBeDefined();
    const now = performance.now();
    expect(cd!.until - now).toBeGreaterThan(5900);
    expect(cd!.until - now).toBeLessThanOrEqual(6000);
    expect(cd!.until - cd!.start, 'доля — от полного отката').toBeCloseTo(13_500, 0);
    const fill = shiftFill(app);
    expect(fill, 'заливка слота — остаток от полного').toBeGreaterThan(0);
    expect(fill).toBeGreaterThanOrEqual(43);
    expect(fill).toBeLessThanOrEqual(45);
  });

  it('каждый вход начинает с откатов сервера: заливки и общий лок прошлой сессии прочь (сервер их сбросил — слот готов)', () => {
    const { app, join } = page({ [BUFF]: { leftMs: 6000, fullMs: 13_500 } });
    const now = performance.now();
    app.actionCooldowns.attack = { start: now, until: now + 900 };
    app.attackLockUntil = now + 900;
    join();
    expect(app.actionCooldowns, 'сервер откатов не прислал — их нет').toEqual({});
    expect(app.attackLockUntil).toBe(0);
    expect(shiftFill(app)).toBe(0);
    // Полный короче остатка (ранг поднят с каста) — доля не больше 1.
    join({ [BUFF]: { leftMs: 5000, fullMs: 4000 } });
    const cd = app.actionCooldowns[BUFF]!;
    expect(cd.until - cd.start).toBeGreaterThanOrEqual(5000);
    expect(shiftFill(app)).toBe(100);
  });

  it('⭐ смена героя (другой `pendingCharId`, вход к выбору героя) и аккаунта (`setAuth`, `clearAuth`) — заливки и лок прежнего героя прочь', () => {
    const arm = (app: App): void => {
      const now = performance.now();
      app.actionCooldowns[BUFF] = { start: now, until: now + 13_500 };
      app.attackLockUntil = now + 700;
    };
    const cleared = (app: App, why: string): void => {
      expect(app.actionCooldowns, `${why}: заливки героя A у героя B`).toEqual({});
      expect(app.attackLockUntil, `${why}: общий лок героя A`).toBe(0);
    };
    const { app } = page();
    arm(app);
    app.pendingCharId = 'hero-b';
    cleared(app, 'другой герой');
    arm(app);
    app.pendingCharId = null;
    cleared(app, 'к выбору героя');
    arm(app);
    app.setAuth({ token: 'cd'.repeat(32), userId: 'user-b', username: 'b' });
    cleared(app, 'другой аккаунт');
    arm(app);
    app.clearAuth();
    cleared(app, 'выход');
    // Тот же герой и тот же аккаунт (новый токен) — заливки живут: сессия та же.
    const { app: same } = page();
    arm(same);
    same.pendingCharId = 'hero-a';
    same.setAuth({ token: 'ef'.repeat(32), userId: 'user-a', username: 'a' });
    expect(same.actionCooldowns[BUFF]).toBeDefined();
  });
});
