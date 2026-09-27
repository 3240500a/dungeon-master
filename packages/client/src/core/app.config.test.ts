import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigRegistry, PROTOCOL_VERSION, defaultConfigData, forgeGold, newBotSave, type SaveState } from '@dm/shared';
import { App } from './app.js';
import { EntryFlow, type EntryView } from '../net/entryFlow.js';

/**
 * ⭐ R5-15: КОНФИГ КЛИЕНТА ДОГОНЯЕТ СЕРВЕРНЫЙ НА КАЖДОМ ВХОДЕ В МИР.
 *
 * `App` брал `/api/config` ОДИН раз — в конструкторе, и молча оставался на встроенных дефолтах, если тот не ответил. С
 * L2 / R3-25 деплой больше не перезагружает страницу: вкладка переподключается сама, а цены кузницы, зачарования,
 * улучшения, перекатки, починки, скупки и сбросов, гашение карточек и даже «аура ли это» оставались ДО деплоя — сервер
 * же брал новую цену. Теперь кадр `joined` (вход и КАЖДЫЙ новый вход после потери связи) перечитывает конфиг
 * условным запросом (`If-None-Match`): не изменился — 304 и ничего; изменился — новый конфиг, метки и перерисовка.
 * Отказ «Цена изменилась» (сервер не взял больше показанного, `priceRaised`) — тоже повод перечитать.
 *
 * Сокет — `NetClient` с подделкой WebSocket; `/api/config` — подделка `fetch` с ETag, как у сервера (`configEtag.ts`).
 */
class FakeWs {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all: FakeWs[] = [];
  readyState = FakeWs.CONNECTING;
  binaryType = '';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(s: string): void { this.sent.push(s); }
  close(): void { this.readyState = FakeWs.CLOSED; }
  open(): void { this.readyState = FakeWs.OPEN; this.onopen?.(); }
  drop(code?: number): void { this.readyState = FakeWs.CLOSED; this.onclose?.({ code }); }
  frame(f: unknown): void { this.onmessage?.({ data: JSON.stringify(f) }); }
}

type Data = Record<string, unknown> & typeof defaultConfigData;
/** Конфиг сервера: дефолты, у которых цены кузницы помножены на `k`. */
function serverReg(k: number): ConfigRegistry {
  const d = structuredClone(defaultConfigData) as Data;
  const fp = (d.balance as unknown as { forgePrices: { upgradeTier: number; rerollAffix: number } }).forgePrices;
  fp.upgradeTier = Math.round(fp.upgradeTier * k);
  fp.rerollAffix = Math.round(fp.rerollAffix * k);
  const r = new ConfigRegistry();
  r.loadAll(d);
  return r;
}

/** Сервер `/api/config`: тело и ETag; 304 на совпавший `If-None-Match`; `down` — не отвечает. */
const server = { reg: serverReg(1), etag: 'W/"a"', down: false, calls: [] as (string | null)[] };
async function fakeFetch(url: string, init?: { headers?: Record<string, string> }): Promise<unknown> {
  if (url !== '/api/config') throw new Error(`не ждали ${url}`);
  const inm = init?.headers?.['if-none-match'] ?? null;
  server.calls.push(inm);
  if (server.down) throw new Error('сервер перезапускается');
  if (inm === server.etag) return { ok: false, status: 304, headers: { get: () => server.etag }, json: async () => { throw new Error('304 без тела'); } };
  const body = JSON.parse(JSON.stringify(server.reg.snapshot())) as unknown;
  return { ok: true, status: 200, headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? server.etag : null) }, json: async () => body };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

const view: EntryView = { showConnecting() { }, showLobby() { }, showResume() { }, hide() { }, setStatus() { } };

describe('⭐ R5-15: конфиг клиента — на каждом входе в мир', () => {
  const G = globalThis as unknown as { WebSocket?: unknown; fetch?: unknown; location?: unknown };
  let saved: { ws: unknown; fetch: unknown; location: unknown };
  beforeEach(() => {
    saved = { ws: G.WebSocket, fetch: G.fetch, location: G.location };
    G.WebSocket = FakeWs; FakeWs.all = [];
    G.fetch = fakeFetch;
    G.location = { protocol: 'http:', host: 'game.test', hostname: 'game.test' };   // адрес сокета по умолчанию — от страницы
    Object.assign(server, { reg: serverReg(1), etag: 'W/"a"', down: false, calls: [] });
  });
  afterEach(() => { G.WebSocket = saved.ws; G.fetch = saved.fetch; G.location = saved.location; });

  /** Игра «как в браузере»: настоящие `App` и `EntryFlow` на поддельном сокете; вход героем. */
  async function game() {
    const app = new App();
    await flush();
    const logs: string[] = [];
    app.bus.on('log:message', (m) => { logs.push(m.text); });
    const entry = new EntryFlow({
      net: app.net, view, who: () => ({ token: 'ab'.repeat(32), charId: 'hero-1' }), replies: app.replies,
      log: (text) => logs.push(text), onJoined: () => void app.syncConfig(),
    });
    entry.attach();
    entry.start();
    const save: SaveState = newBotSave(app.config, app.config.get('classes')[0]!.id);
    /** Сокет открылся, статус забега, клик «Соло», кадр `joined`. */
    const enter = async (v = PROTOCOL_VERSION): Promise<void> => {
      const ws = FakeWs.all.at(-1)!;
      ws.open();
      ws.frame({ t: 'runStatus', hasRun: false });
      entry.join({ fresh: true });
      ws.frame({ t: 'joined', v, playerId: 'p1', roomCode: 'ABCD', floor: {}, peers: [], save });
      await flush();
    };
    return { app, entry, enter, logs, ws: () => FakeWs.all.at(-1)! };
  }
  const prices = (r: ConfigRegistry): unknown => r.get('balance').forgePrices;

  it('⭐ деплой с правкой цен: вкладка переподключилась без перезагрузки — на новом входе цены сервера, и верстак считает ту же цену, что возьмёт сервер', async () => {
    const g = await game();
    await g.enter();
    expect(prices(g.app.config)).toEqual(prices(server.reg));
    server.reg = serverReg(1.5); server.etag = 'W/"b"';        // деплой: новый баланс
    g.ws().drop(4009);                                          // сервер ушёл на перезапуск — вкладка переподключается сама
    await g.enter();
    expect(prices(g.app.config), 'было: цены до деплоя до перезагрузки страницы').toEqual(prices(server.reg));
    const item = newBotSave(server.reg, server.reg.get('classes')[0]!.id).equipment.weapon!;
    expect(forgeGold(g.app.config, item, 'upgrade')).toBe(forgeGold(server.reg, item, 'upgrade'));
    expect(server.calls.at(-1), 'условный запрос — прежним ETag').toBe('W/"a"');
  });

  it('конфиг не менялся — 304 и ничего не перечитано; на старте сервер не ответил — догоняет на первом входе', async () => {
    server.down = true;
    const g = await game();
    server.down = false;
    server.reg = serverReg(2);
    expect(prices(g.app.config), 'пока — встроенные дефолты').not.toEqual(prices(server.reg));
    await g.enter();
    expect(prices(g.app.config), 'было: неудача на старте — навсегда дефолты').toEqual(prices(server.reg));
    let changed = 0;
    g.app.bus.on('state:changed', () => { changed++; });
    g.ws().drop(1006);
    await g.enter();
    expect(server.calls.at(-1)).toBe('W/"a"');
    expect(changed, '304: панели не перерисовываются зря').toBe(0);
  });

  it('⭐ отказ «Цена изменилась» (правка без переподключения) — клиент перечитывает конфиг сам', async () => {
    const g = await game();
    await g.enter();
    const n = server.calls.length;
    server.reg = serverReg(3); server.etag = 'W/"c"';
    g.ws().frame({ t: 'cmdResult', id: 77, cmd: 'forgeUpgrade', ok: false, reason: 'Цена изменилась: 600 золота' });
    await flush();
    expect(server.calls.length).toBe(n + 1);
    expect(prices(g.app.config)).toEqual(prices(server.reg));
  });

  it('сервер другой версии протокола — игроку «перезагрузите страницу»', async () => {
    const g = await game();
    await g.enter(PROTOCOL_VERSION + 1);
    expect(g.logs.some((t) => /перезагрузите страницу/i.test(t)), g.logs.join(' | ')).toBe(true);
    const h = await game();
    await h.enter();
    expect(h.logs.some((t) => /перезагрузите/i.test(t))).toBe(false);
  });
});

/**
 * ⭐ R7-14: КОНФИГ СЕРВЕРА ЛОЖИТСЯ ЦЕЛИКОМ ИЛИ НИКАК. Деплой без перезагрузки вкладки (R5-15) со сменой схемы — новая
 * таблица, переименованное поле — и старая вкладка не может разобрать ОДНУ таблицу. Реестр клал таблицы по одной: те, что
 * до негодной, уже новые, она и дальше — старые; ошибку `syncConfig` глотал молча. Карточки кузницы и лавки считали цену
 * по смеси двух конфигов, сервер отказывал «Цена изменилась», отказ снова звал `syncConfig` — та же смесь, тишина, и
 * игрок застревал на отказах, не зная, что нужна перезагрузка. Теперь: негодный — прежний конфиг цел, и игроку ОДИН раз
 * (на этот ETag) «перезагрузите страницу».
 */
describe('⭐ R7-14: серверный конфиг, который старая вкладка не разбирает', () => {
  const G = globalThis as unknown as { fetch?: unknown };
  let saved: unknown;
  /** Ответ `/api/config`: тело (в порядке ключей схемы, как у сервера) и ETag. */
  let reply: { body: unknown; etag: string };
  let calls = 0;
  beforeEach(() => {
    saved = G.fetch;
    calls = 0;
    G.fetch = async (url: string, init?: { headers?: Record<string, string> }): Promise<unknown> => {
      if (url !== '/api/config') throw new Error(`не ждали ${url}`);
      calls++;
      const { body, etag } = reply;
      if (init?.headers?.['if-none-match'] === etag) return { ok: false, status: 304, headers: { get: () => etag }, json: async () => { throw new Error('304 без тела'); } };
      return { ok: true, status: 200, headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? etag : null) }, json: async () => JSON.parse(JSON.stringify(body)) as unknown };
    };
  });
  afterEach(() => { G.fetch = saved; });

  /** Снимок нового сервера: `balance` (первый ключ) изменён и годен; дальше — таблица, которой старая вкладка не знает. */
  function newServer(): Record<string, unknown> {
    const d = structuredClone(defaultConfigData) as unknown as Record<string, unknown>;
    (d.balance as { respecCost: number }).respecCost = 777;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) {
      out[k] = v;
      if (k === 'item-tiers') out['craft-new-table'] = [{ id: 'x' }];   // деплой, добавивший таблицу
    }
    (out.rarities as { name: string }[])[0]!.name = 'NEW-NAME';
    return out;
  }

  it('⭐ ни одной таблицы нового конфига (было: `balance` новый, `rarities` старый); игроку — «перезагрузите», один раз на ETag', async () => {
    reply = { body: newServer(), etag: 'W/"v2"' };
    const app = new App();
    const logs: string[] = [];
    app.bus.on('log:message', (m) => { logs.push(m.text); });
    await flush();
    const def = new ConfigRegistry(); def.loadAll();
    expect(app.config.get('balance').respecCost, 'было: 777 — половина нового конфига').toBe(def.get('balance').respecCost);
    expect(app.config.get('rarities')[0]!.name).toBe(def.get('rarities')[0]!.name);
    expect(logs.filter((t) => /перезагрузите страницу/i.test(t)), logs.join(' | ')).toHaveLength(1);

    await app.syncConfig();                           // отказ «Цена изменилась» / новый вход — тот же сервер
    await app.syncConfig();
    expect(calls).toBe(3);
    expect(logs.filter((t) => /перезагрузите/i.test(t)), 'тот же ETag — второй раз не твердим').toHaveLength(1);
    expect(app.config.get('balance').respecCost).toBe(def.get('balance').respecCost);

    // Сервер откатили (или вкладка того же выпуска): годный конфиг ложится, как раньше.
    const ok = structuredClone(defaultConfigData) as unknown as { balance: { respecCost: number } };
    ok.balance.respecCost = 555;
    reply = { body: ok, etag: 'W/"v3"' };
    await app.syncConfig();
    expect(app.config.get('balance').respecCost).toBe(555);
  });
});
