import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { newBotSave, shopBuyPrice, itemFromBaseId, SHOP_CONSUMABLES, type Item } from '@dm/shared';
import { App } from '../../core/app.js';
import { GameState } from '../../core/gameState.js';
import { shopCategory } from './shopCats.js';
import { shopPanel } from './shopPanel.js';
import { forgePanel } from './forgePanel.js';

/**
 * ⭐ R4-37: ЦЕНА НА ПРИЛАВКЕ — ТА, ЧТО СПИШЕТ СЕРВЕР. Кадр `shop` несёт точные цены по uid (`prices`, R2-36), а веб-клиент
 * их выбрасывал и считал цену и «хватает ли золота» по СВОЕМУ конфигу. Конфиг клиента расходится с серверным: правка из
 * редактора доходит до других вкладок только через BroadcastChannel того же браузера, оверрайд баланса в базе, `/api/config`
 * не ответил на старте — и клиент живёт на встроенных данных. Тогда вещь «по карману» по бейджу отказывалась «Недостаточно
 * золота», а списывалось не то, что показано.
 *
 * Сетку прилавка подменяем: проверяем, какую цену и какую «доступность» окно ей отдаёт.
 */
const grids = vi.hoisted(() => [] as { stock: Item[]; o: { price: (it: Item) => number; affordable: (it: Item) => boolean } }[]);
vi.mock('./shopGrid.js', () => ({
  renderShopGrid: (stock: Item[], o: (typeof grids)[number]['o']) => { grids.push({ stock, o }); return document.createElement('div'); },
}));

class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; parent: El | null = null;
  private html = '';
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string) { }
  set innerHTML(v: string) { this.children = []; this.html = v; }
  get innerHTML(): string { return this.html; }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: (El | string)[]): void { for (const x of c) { if (typeof x === 'string') continue; x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  click(): void { for (const f of this.on.get('click') ?? []) f(); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

describe('⭐ R4-37: цена прилавка — из кадра сервера', () => {
  const G = globalThis as unknown as { document?: unknown; WebSocket?: unknown; fetch?: unknown };
  let saved: { fetch: unknown; ws: unknown };
  beforeEach(() => {
    saved = { fetch: G.fetch, ws: G.WebSocket };
    G.fetch = () => Promise.reject(new Error('сети нет'));   // `/api/config` не ответил — клиент на встроенных данных
    G.document = { createElement: (t: string) => new El(t), body: new El('body') };
    grids.length = 0;
  });
  afterEach(() => { G.fetch = saved.fetch; G.WebSocket = saved.ws; delete G.document; });

  /** Настоящий `App` с героем; прилавок пришёл кадром `shop` с ценами сервера, отличными от цен клиента. */
  function shop(baseIds: readonly string[]) {
    const app = new App();
    const save = newBotSave(app.config, app.config.get('classes')[0]!.id);
    app.state = new GameState(save);
    const stock = stockOf(app, baseIds);
    const prices = Object.fromEntries(stock.map((it) => [it.uid, shopBuyPrice(app.config, it) * 2 + 7]));
    class Ws { static OPEN = 1; readyState = 1; binaryType = ''; onmessage: ((ev: { data: string }) => void) | null = null; onopen = null; onclose = null; send(): void { } close(): void { } constructor() { ws = this; } }
    let ws!: Ws;
    G.WebSocket = Ws;
    app.net.connect('ws://x/ws');
    ws.onmessage!({ data: JSON.stringify({ t: 'shop', items: stock, prices }) });
    return { app, save, stock, prices };
  }
  /** Сток, собранный тем же ядром, что у сервера (`itemFromBaseId(…, 'shop')`). */
  function stockOf(app: App, baseIds: readonly string[]): Item[] {
    return baseIds.map((id, i) => ({ ...itemFromBaseId(app.config.get('items.base'), id, app.config.get('item-tiers'), 'shop')!, uid: `shop-${i}` }));
  }

  it('⭐ лавка зелий: бейдж и «хватает ли золота» — по цене сервера, а не по своему конфигу', () => {
    const s = shop(SHOP_CONSUMABLES);
    expect(s.stock.length).toBeGreaterThan(0);
    const body = new El('div');
    shopPanel(s.app, {} as never).render(body as unknown as HTMLElement);
    const g = grids.at(-1)!;
    const it = g.stock[0]!;
    const server = s.prices[it.uid]!;
    expect(shopBuyPrice(s.app.config, it), 'цены разошлись — иначе проверка ничего не значит').not.toBe(server);
    expect(g.o.price(it), 'было: цена своего конфига').toBe(server);
    s.save.gold = server - 1;
    expect(g.o.affordable(it), 'было: «по карману» по своей цене — и отказ «Недостаточно золота» от сервера').toBe(false);
    s.save.gold = server;
    expect(g.o.affordable(it)).toBe(true);
  });

  it('⭐ кузница «Купить»: то же', () => {
    const s = shop(['long-sword']);
    expect(s.stock.map(shopCategory)).toEqual(['melee']);
    const body = new El('div');
    const panel = forgePanel(s.app, { openPanel: () => { } } as never);
    panel.render(body as unknown as HTMLElement);
    body.all().find((e) => e.tag === 'button' && e.textContent.includes('Купить'))!.click();
    body.all().find((e) => e.tag === 'button' && e.textContent.includes('Ближний'))!.click();
    const g = grids.at(-1)!;
    const it = g.stock[0]!;
    expect(g.o.price(it)).toBe(s.prices[it.uid]);
    s.save.gold = s.prices[it.uid]! - 1;
    expect(g.o.affordable(it)).toBe(false);
  });

  it('цены в кадре нет (сервер старше R2-36) — по своему конфигу, как раньше', () => {
    const app = new App();
    const it = stockOf(app, ['long-sword'])[0]!;
    expect(app.shopPrice(it)).toBe(shopBuyPrice(app.config, it));
  });
});
