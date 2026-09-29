import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CONFIG_REV_HEADER, ConfigRegistry, PRICE_CHANGED, PROTOCOL_VERSION, configChanged, configSchemas, createRng, defaultConfigData, forgeGold, newBotSave, parseTownCommand,
  type SaveState, type TownCommand,
} from '@dm/shared';
import { App } from './app.js';
import { EntryFlow, PROTOCOL_STALE, type EntryView } from '../net/entryFlow.js';

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

/**
 * Сервер `/api/config`: тело и ETag; 304 на совпавший `If-None-Match`; `down` — не отвечает. ⭐ R16 C-07: и ревизия сервера для этого тела
 * (`CONFIG_REV_HEADER`, как у `index.ts`); `noRev` — сервер старше заголовка.
 */
const server = { reg: serverReg(1), etag: 'W/"a"', down: false, noRev: false, calls: [] as (string | null)[] };
async function fakeFetch(url: string, init?: { headers?: Record<string, string> }): Promise<unknown> {
  if (url !== '/api/config') throw new Error(`не ждали ${url}`);
  const inm = init?.headers?.['if-none-match'] ?? null;
  server.calls.push(inm);
  if (server.down) throw new Error('сервер перезапускается');
  const headers = { get: (h: string): string | null => {
    const k = h.toLowerCase();
    return k === 'etag' ? server.etag : k === CONFIG_REV_HEADER && !server.noRev ? server.reg.revision() : null;
  } };
  if (inm === server.etag) return { ok: false, status: 304, headers, json: async () => { throw new Error('304 без тела'); } };
  const body = JSON.parse(JSON.stringify(server.reg.snapshot())) as unknown;
  return { ok: true, status: 200, headers, json: async () => body };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

/**
 * ⭐ R16 C-07: реестр сервера НОВОГО выпуска — таблица `key` разобрана его схемой (`table` — её разобранное значение), которой у старой
 * вкладки нет. Схему не подменить — кладём разобранное прямо в данные реестра: так он и выглядит у нового сервера.
 */
function drifted(key: string, table: unknown, base = serverReg(1)): ConfigRegistry {
  const r = new ConfigRegistry();
  const data = (x: ConfigRegistry): Record<string, unknown> => (x as unknown as { data: Record<string, unknown> }).data;
  Object.assign(data(r), data(base), { [key]: table });   // прочие таблицы — те же объекты (их ревизии не пересчитываются)
  return r;
}
type Obj = Record<string, unknown>;
/** Первый объект таблицы (сама таблица-объект или первый объект массива) — где менять форму. */
function firstObj(v: unknown): Obj | null {
  if (Array.isArray(v)) return (v.find((x) => x !== null && typeof x === 'object' && !Array.isArray(x)) as Obj | undefined) ?? null;
  return v !== null && typeof v === 'object' ? (v as Obj) : null;
}
/**
 * ⭐ R16 C-07: как новый выпуск меняет ФОРМУ таблицы, не трогая значений (схема вкладки старше и разбирает тело сервера «удачно», но не в то же):
 * новое поле (вкладка его срезает), другой порядок полей (вкладка кладёт в своём), поле убрано (вкладка допишет значение по умолчанию).
 * Значение таблицы у сервера или `null` — к этой таблице вид неприменим.
 */
const DRIFTS: Record<string, (key: keyof typeof configSchemas, v: unknown) => unknown> = {
  'новое поле': (_key, v) => {
    const c = structuredClone(v);
    const o = firstObj(c);
    if (!o) return null;
    o.knobOfNextRelease = 3;
    return c;
  },
  'поля в другом порядке': (_key, v) => {
    const c = structuredClone(v);
    const o = firstObj(c);
    if (!o || Object.keys(o).length < 2) return null;
    const entries = Object.entries(o).reverse();
    for (const k of Object.keys(o)) delete o[k];
    for (const [k, x] of entries) o[k] = x;
    return c;
  },
  'поле убрано (вкладка допишет умолчание)': (key, v) => {
    for (const f of Object.keys(firstObj(v) ?? {})) {
      const c = structuredClone(v);
      delete firstObj(c)![f];
      const seen = configSchemas[key].safeParse(structuredClone(c));
      if (seen.success && JSON.stringify(seen.data) !== JSON.stringify(c)) return c;
    }
    return null;
  },
};

const view: EntryView ={ showConnecting() { }, showLobby() { }, showResume() { }, hide() { }, setStatus() { } };

describe('⭐ R5-15: конфиг клиента — на каждом входе в мир', () => {
  const G = globalThis as unknown as { WebSocket?: unknown; fetch?: unknown; location?: unknown };
  let saved: { ws: unknown; fetch: unknown; location: unknown };
  beforeEach(() => {
    saved = { ws: G.WebSocket, fetch: G.fetch, location: G.location };
    G.WebSocket = FakeWs; FakeWs.all = [];
    G.fetch = fakeFetch;
    G.location = { protocol: 'http:', host: 'game.test', hostname: 'game.test' };   // адрес сокета по умолчанию — от страницы
    Object.assign(server, { reg: serverReg(1), etag: 'W/"a"', down: false, noRev: false, calls: [] });
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
    /** Сокет открылся, статус забега, клик «Соло», кадр `joined` (⭐ R18-08: `build` — штамп сборки сервера; нет — сервер старше штампа). */
    const enter = async (v = PROTOCOL_VERSION, build?: string): Promise<void> => {
      const ws = FakeWs.all.at(-1)!;
      ws.open();
      ws.frame({ t: 'runStatus', hasRun: false });
      entry.join({ fresh: true });
      ws.frame({ t: 'joined', v, playerId: 'p1', roomCode: 'ABCD', floor: {}, peers: [], save, ...(build !== undefined ? { build } : {}) });
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

  // ⭐ V-B3-07 (фаззер паритета «окно ≡ сервер»): согласие держало только цену — правка живьём, не менявшая цены (вилка броска,
  // скидка требований, «кузнец закрыт»), и окно по старому конфигу обещало одно, а сервер делал другое или отказывал не ценой, и
  // конфиг так и не перечитывался. Теперь команды кузницы, скупки и разбора несут ревизию конфига клиента (`cfgRev`); у сервера
  // другая — отказ «Цена изменилась» до исполнения (`configChanged`), по нему клиент перечитывает конфиг, и дальше — согласие.
  it('⭐ V-B3-07: команды кузницы несут ревизию конфига; устаревшая — отказ до исполнения, конфиг перечитан, дальше — согласие', async () => {
    const g = await game();
    await g.enter();
    const lastCmd = (): TownCommand & { cfgRev?: string } => {
      const f = g.ws().sent.map((s) => JSON.parse(s) as { t: string; command?: TownCommand }).filter((x) => x.t === 'cmd').at(-1)!;
      expect(parseTownCommand(f.command).ok, 'схема сервера принимает команду с ревизией').toBe(true);
      return f.command!;
    };
    g.app.sendCmd({ cmd: 'forgeReroll', uid: 'x', maxGold: 10 });
    expect(lastCmd().cfgRev, 'ревизия конфига клиента = серверной').toBe(server.reg.revision());
    expect(configChanged(server.reg, lastCmd().cfgRev)).toBeNull();
    g.app.sendCmd({ cmd: 'equip', uid: 'x' });
    expect('cfgRev' in lastCmd(), 'надеть — без согласия на конфиг').toBe(false);
    g.app.sendCmd({ cmd: 'buy', uid: 'x', maxGold: 5 });
    expect('cfgRev' in lastCmd(), 'покупка — цену и вещь прислал сервер, конфиг клиента в ней не участвует').toBe(false);

    server.reg = serverReg(1); server.etag = 'W/"d"';
    const b = structuredClone(server.reg.get('balance'));
    b.loot.baseRoll.weapon = 0.3;   // правка живьём, цены не тронуты
    server.reg.reload({ balance: b });
    g.app.sendCmd({ cmd: 'forgeUpgrade', uid: 'x', maxGold: 999 });
    const refusal = configChanged(server.reg, lastCmd().cfgRev);
    expect(refusal?.reason?.startsWith(PRICE_CHANGED), 'конфиг клиента устарел — отказ ценой').toBe(true);
    g.ws().frame({ t: 'cmdResult', id: 99, cmd: 'forgeUpgrade', ok: false, reason: refusal!.reason });
    await flush();
    g.app.sendCmd({ cmd: 'forgeUpgrade', uid: 'x', maxGold: 999 });
    expect(configChanged(server.reg, lastCmd().cfgRev), 'перечитал — согласие').toBeNull();
    expect(g.app.config.get('balance').loot.baseRoll.weapon).toBe(0.3);
  });

  /** Ревизия конфига, с которой ушла последняя команда согласия (`cfgRev`), — её сервер и сверяет (`configChanged`). */
  const stampOf = (g: Awaited<ReturnType<typeof game>>): string | undefined => {
    g.app.sendCmd({ cmd: 'sell', uid: 'x', minGold: 1 });
    const f = g.ws().sent.map((s) => JSON.parse(s) as { t: string; command?: TownCommand & { cfgRev?: string } }).filter((x) => x.t === 'cmd').at(-1)!;
    return f.command!.cfgRev;
  };
  const staleHints = (g: Awaited<ReturnType<typeof game>>): number => g.logs.filter((t) => t === PROTOCOL_STALE).length;

  // ⭐ R16 C-07: деплой (вкладка переподключается сама, L2 / R3-25, `PROTOCOL_VERSION` тот же) добавил поле в таблицу конфига. Старая схема
  // вкладки его срезает — разбор «удался», а ревизия её конфига (`ConfigRegistry.revision`, по разобранному) уже не серверная, НАВСЕГДА: каждая
  // продажа, ковка, разбор — «Цена изменилась», перечитывание — 304 с тем же ETag, отказы в логе прячутся повтором (R4-24), и ни слова о
  // перезагрузке. Теперь согласие — «с какого конфига СЕРВЕРА нарисовано» (ревизия, которую сервер прислал с телом, `CONFIG_REV_HEADER`), а
  // схема вкладки старше — игроку один раз на ETag «перезагрузите страницу».
  it('⭐ R16 C-07: деплой добавил поле в конфиг — старая вкладка продаёт и кует (согласие по ревизии сервера), а «перезагрузите» — один раз', async () => {
    const g = await game();
    await g.enter();
    const b = structuredClone(server.reg.get('balance')) as unknown as Obj;
    b.newKnobFromNextRelease = 3;
    server.reg = drifted('balance', b); server.etag = 'W/"new"';
    g.ws().drop(4009);
    await g.enter();
    expect(g.app.config.revision(), 'схема вкладки срезала новое поле: её ревизия — не серверная').not.toBe(server.reg.revision());
    for (let click = 0; click < 5; click++) {
      expect(configChanged(server.reg, stampOf(g)), `клик ${click + 1}: было — «Цена изменилась» навсегда`).toBeNull();
    }
    expect(staleHints(g), 'схема вкладки старше сервера — игроку «перезагрузите», один раз').toBe(1);
    g.ws().drop(1006);
    await g.enter();
    expect(server.calls.at(-1), 'тот же конфиг — 304').toBe('W/"new"');
    expect(staleHints(g), 'тот же ETag — второй раз не твердим').toBe(1);

    // Правка живьём после деплоя — согласие по-прежнему её ловит: отказ, перечитывание, дальше — согласие.
    const b2 = structuredClone(b);
    (b2.loot as { baseRoll: { weapon: number } }).baseRoll.weapon = 0.3;
    server.reg = drifted('balance', b2); server.etag = 'W/"new2"';
    const refusal = configChanged(server.reg, stampOf(g));
    expect(refusal?.reason?.startsWith(PRICE_CHANGED), 'конфиг сервера сменился — отказ до исполнения').toBe(true);
    g.ws().frame({ t: 'cmdResult', id: 901, cmd: 'sell', ok: false, reason: refusal!.reason });
    await flush();
    expect(configChanged(server.reg, stampOf(g)), 'перечитал — согласие').toBeNull();
    expect(g.app.config.get('balance').loot.baseRoll.weapon).toBe(0.3);
  });

  // ⭐ R16 C-07 — весь класс: ЛЮБЫЕ таблицы и любые виды смены их формы новым выпуском (набор — из сидового потока: каждая таблица с долей
  // вероятности меняется одним из видов, первый раунд — без смен). Инвариант после перечитывания: согласие на конфиг проходит (команды не
  // отказываются без конца), а расхождение схем вкладки и сервера игроку не молчит — «перезагрузите» ровно тогда, когда оно есть (и не при
  // конфиге, разобранном в то же). Раунд — полный путь `syncConfig` (тело ~0,6 МБ): раундов немного, таблиц в каждом — много.
  it('⭐ R16 C-07: любые таблицы, любые виды смены формы — согласие проходит, «перезагрузите» ровно при расхождении схем', async () => {
    const g = await game();
    await g.enter();
    const pristine = serverReg(1);
    const rng = createRng(0xc07);
    const keys = Object.keys(configSchemas) as (keyof typeof configSchemas)[];
    const kinds = Object.entries(DRIFTS);
    const shapedBy = new Map<string, number>();   // вид → сколько таблиц им менялось (покрытие)
    let drifts = 0, calm = 0;
    for (let round = 0; round < 14; round++) {
      const server0 = drifted(keys[0]!, pristine.get(keys[0]!), pristine);
      const changed: string[] = [];
      for (const key of keys) {
        if (round === 0 || !rng.chance(0.35)) continue;
        const [kind, shape] = rng.pick(kinds);
        const table = shape(key, pristine.get(key));
        if (table === null) continue;
        (server0 as unknown as { data: Record<string, unknown> }).data[key] = table;
        changed.push(`${key} × ${kind}`);
        shapedBy.set(kind, (shapedBy.get(kind) ?? 0) + 1);
      }
      server.reg = server0; server.etag = `W/"round-${round}"`;
      const before = staleHints(g);
      await g.app.syncConfig();
      const drift = g.app.config.revision() !== server.reg.revision();
      if (drift) drifts++; else calm++;
      const what = `раунд ${round} (${changed.join(', ') || 'без смен'})`;
      expect(configChanged(server.reg, stampOf(g)), `${what}: согласие`).toBeNull();
      expect(staleHints(g) - before, `${what}: «перезагрузите» — ${drift ? 'схема вкладки старше' : 'разобрано в то же'}`).toBe(drift ? 1 : 0);
    }
    expect(drifts, 'фаззер холостой: ни одного расхождения схем').toBeGreaterThan(8);
    expect(calm, 'и без расхождения — ни одной ложной подсказки (раунд без смен)').toBeGreaterThan(0);
    for (const [kind] of kinds) expect(shapedBy.get(kind) ?? 0, `вид «${kind}» не выпал ни разу`).toBeGreaterThan(20);
    // Сервер старше заголовка ревизии: согласие — по ревизии конфига вкладки, как было (а разобранный в то же конфиг — согласие).
    server.noRev = true; server.reg = serverReg(2); server.etag = 'W/"old-server"';
    await g.app.syncConfig();
    expect(configChanged(server.reg, stampOf(g))).toBeNull();
  });

  // ⭐ R16 C-07 × R7-14: конфиг сервера вкладка не разбирает вовсе (новая таблица) — прежний конфиг цел, «перезагрузите» сказано один раз на
  // ETag. А дальше каждая продажа и ковка — «Цена изменилась» (её конфиг — не серверный), перечитывание — 304 по негодному ETag, и кнопки
  // выглядели мёртвыми. Теперь отказ «Цена изменилась» у такой вкладки — снова «перезагрузите» (не чаще раза в 2 с, как повтор отказа).
  it('⭐ R16 C-07: вкладка, не разбирающая конфиг сервера, на каждый отказ «Цена изменилась» снова слышит «перезагрузите»', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const g = await game();
      await g.enter();
      const next = serverReg(1);
      const b = structuredClone(next.get('balance'));
      b.respecCost += 7;
      next.reload({ balance: b });
      (next as unknown as { data: Record<string, unknown> }).data['craft-new-table'] = [{ id: 'x' }];   // таблица, которой вкладка не знает
      server.reg = next; server.etag = 'W/"v2"';
      g.ws().drop(4009);
      await g.enter();
      expect(g.app.config.get('balance').respecCost, 'R7-14: прежний конфиг цел').not.toBe(b.respecCost);
      expect(staleHints(g), 'R7-14: сказано один раз').toBe(1);
      for (let click = 0; click < 3; click++) {
        vi.setSystemTime(Date.now() + 5_000);
        const refusal = configChanged(server.reg, stampOf(g));
        expect(refusal?.reason?.startsWith(PRICE_CHANGED), 'конфиг вкладки — не серверный: отказ').toBe(true);
        g.ws().frame({ t: 'cmdResult', id: 700 + click, cmd: 'sell', ok: false, reason: refusal!.reason });
        await flush();
        expect(staleHints(g), `клик ${click + 1}: было — только «Не вышло: Цена изменилась», без подсказки`).toBe(2 + click);
      }
      // Зажатый клик (отказы подряд быстрее 2 с) — одна строка, а не лента.
      g.ws().frame({ t: 'cmdResult', id: 799, cmd: 'sell', ok: false, reason: configChanged(server.reg, stampOf(g))!.reason });
      await flush();
      expect(staleHints(g)).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Отказ «Цена изменилась» на команду вкладки — как его шлёт сервер (`priceRaised`, `priceDropped`): верстак ждёт ответа (`request`),
   * продажа — нет (`sendCmd`). Номер — тот, с которым команда ушла.
   */
  async function refuse(g: Awaited<ReturnType<typeof game>>, command: TownCommand, reason: string): Promise<void> {
    const waiting = command.cmd === 'forgeUpgrade';
    const reply = waiting ? g.app.request(command) : (g.app.sendCmd(command), null);
    const sent = JSON.parse(g.ws().sent.at(-1)!) as { id: number };
    g.ws().frame({ t: 'cmdResult', id: sent.id, cmd: command.cmd, ok: false, reason });
    if (reply) expect((await reply)?.ok).toBe(false);
    await flush();
  }
  const upgrade: TownCommand = { cmd: 'forgeUpgrade', uid: 'x', maxGold: 200 };
  const sell: TownCommand = { cmd: 'sell', uid: 'y', minGold: 40 };

  // ⭐ R18-08: деплой сменил формулу цены в КОДЕ (`forgeGold`, цена скупки, выход разбора), а тело конфига — нет: ETag и ревизия те же. Вкладка
  // переподключилась сама (L2 / R3-25) со старым бандлом и тем же `PROTOCOL_VERSION`: её карточки считают цену старой формулой, сервер — новой, и
  // каждая платная команда — «Цена изменилась»; перечитывание — 304, подсказка «перезагрузите» повторялась только у негодного конфига (R7-14), и
  // игрок кликал в пустоту, не зная почему. Теперь у сборки есть штамп (`__DM_BUILD__` вкладки, `joined.build` сервера): не сошлись — «перезагрузите»
  // на входе и на каждый отказ ценой, который перечитывание не вылечило (не чаще раза в 2 с). Отказ, который вылечил новый конфиг (200), — без неё.
  it('⭐ R18-08: деплой сменил цену в коде, конфиг тот же — «перезагрузите» на входе и на каждый отказ ценой, который перечитывание не лечит', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubGlobal('__DM_BUILD__', 'build-1');   // штамп, который сборка вписала в бандл вкладки
    try {
      const g = await game();
      await g.enter(PROTOCOL_VERSION, 'build-1');
      expect(staleHints(g), 'сборки одни — ни слова').toBe(0);
      // Та же сборка, тот же конфиг, а отказ ценой (гонка: второй клик ушёл, пока первый поднимал ступень) — перезагрузка тут не поможет, молчим.
      vi.setSystemTime(Date.now() + 5_000);
      await refuse(g, upgrade, `${PRICE_CHANGED}: 268 золота`);
      expect(staleHints(g), 'сборка та же — «перезагрузите» было бы ложью').toBe(0);

      g.ws().drop(4009);                                  // деплой: сервер новой сборки, тело конфига то же
      await g.enter(PROTOCOL_VERSION, 'build-2');
      expect(staleHints(g), 'было: вход с новой сборкой сервера — ни слова').toBe(1);
      const n = server.calls.length;
      for (let click = 0; click < 3; click++) {
        vi.setSystemTime(Date.now() + 5_000);
        await refuse(g, upgrade, `${PRICE_CHANGED}: 268 золота`);
        await refuse(g, sell, `${PRICE_CHANGED}: лавка даст 31 золота`);   // тот же клик — в пределах 2 с: одна строка, не лента
        expect(staleHints(g), `клик ${click + 1}: было — только «Не вышло: Цена изменилась», без подсказки`).toBe(2 + click);
      }
      expect(server.calls.slice(n).every((x) => x === 'W/"a"'), 'перечитывание — условное и 304: конфиг тот же').toBe(true);

      // Правка живьём после деплоя: отказ, который перечитывание ВЫЛЕЧИЛО (200, новый конфиг лёг), — не повод для «перезагрузите».
      vi.setSystemTime(Date.now() + 5_000);
      server.reg = serverReg(2); server.etag = 'W/"b"';
      await refuse(g, sell, `${PRICE_CHANGED}: условия кузницы и лавки обновлены`);
      expect(prices(g.app.config)).toEqual(prices(server.reg));
      expect(staleHints(g), 'отказ объяснён новым конфигом — без подсказки').toBe(4);
      vi.setSystemTime(Date.now() + 5_000);
      await refuse(g, sell, `${PRICE_CHANGED}: лавка даст 31 золота`);
      expect(staleHints(g), 'а следующий снова упёрся в код сборки — снова подсказка').toBe(5);

      // Переподключение к той же новой сборке — на входе ещё раз не твердим (сказано на этот штамп), а отказы ценой — по-прежнему.
      g.ws().drop(1006);
      await g.enter(PROTOCOL_VERSION, 'build-2');
      expect(staleHints(g), 'тот же штамп сервера — на входе второй раз не твердим').toBe(5);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  // ⭐ R18-08: штампа нет с одной из сторон — сервер старше штампа (кадр без `build`), вкладка из дев-сервера Vite (штамп пуст): сравнивать нечего,
  // и отказ ценой, как прежде, только перечитывает конфиг — ложной подсказки нет.
  it('⭐ R18-08: штампа нет у сервера или у вкладки — отказ ценой без «перезагрузите»', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const [client, srv] of [['build-1', undefined], [undefined, 'build-2'], ['', 'build-2']] as const) {
        if (client !== undefined) vi.stubGlobal('__DM_BUILD__', client);
        const g = await game();
        await g.enter(PROTOCOL_VERSION, srv);
        for (let click = 0; click < 2; click++) {
          vi.setSystemTime(Date.now() + 5_000);
          await refuse(g, sell, `${PRICE_CHANGED}: лавка даст 31 золота`);
        }
        expect(staleHints(g), `вкладка ${String(client)}, сервер ${String(srv)}`).toBe(0);
        vi.unstubAllGlobals();
      }
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  // ⭐ R18-08 × R16 C-07: схема вкладки старше (деплой добавил поле в таблицу): «перезагрузите» было сказано ОДИН раз — на входе. Карточки считают
  // по разобранному «не в то же», и отказ ценой (`priceRaised`) перечитывание не лечит (304 тем же ETag) — раньше каждый такой отказ был молча.
  it('⭐ R18-08: схема вкладки старше сервера (R16 C-07) — отказ ценой, который перечитывание не лечит, снова «перезагрузите»', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const g = await game();
      await g.enter();
      const b = structuredClone(server.reg.get('balance')) as unknown as Obj;
      b.newKnobFromNextRelease = 3;
      server.reg = drifted('balance', b); server.etag = 'W/"new"';
      g.ws().drop(4009);
      await g.enter();
      expect(staleHints(g), 'R16 C-07: сказано на входе').toBe(1);
      for (let click = 0; click < 3; click++) {
        vi.setSystemTime(Date.now() + 5_000);
        await refuse(g, upgrade, `${PRICE_CHANGED}: 268 золота`);
        expect(staleHints(g), `клик ${click + 1}: было — молча`).toBe(2 + click);
      }
      // Сервер откатили к форме вкладки (новый ETag, разобрано в то же): отказ, который перечитывание вылечило, и следующие — без подсказки.
      vi.setSystemTime(Date.now() + 5_000);
      server.reg = serverReg(1); server.etag = 'W/"back"';
      await refuse(g, upgrade, `${PRICE_CHANGED}: условия кузницы и лавки обновлены`);
      vi.setSystemTime(Date.now() + 5_000);
      await refuse(g, upgrade, `${PRICE_CHANGED}: 268 золота`);
      expect(staleHints(g), 'схемы снова одни — молчим').toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // ⭐ R18-08: схема конфига меняется только вместе с кодом shared — деплой со сменой схемы приходит и с чужим штампом сборки. На входе игроку
  // ОДНА строка «перезагрузите», а не две подряд (штамп + конфиг «не в то же» / негодный); без штампа у сервера — конфиг говорит сам, как прежде.
  it('⭐ R18-08: чужой штамп и схема конфига старше на одном входе — одна строка «перезагрузите», а не лента', async () => {
    vi.stubGlobal('__DM_BUILD__', 'build-1');
    try {
      const g = await game();
      await g.enter(PROTOCOL_VERSION, 'build-1');
      const b = structuredClone(server.reg.get('balance')) as unknown as Obj;
      b.newKnobFromNextRelease = 3;
      server.reg = drifted('balance', b); server.etag = 'W/"new"';
      g.ws().drop(4009);
      await g.enter(PROTOCOL_VERSION, 'build-2');
      expect(staleHints(g), 'штамп и C-07 — об одном деплое').toBe(1);
      expect(g.app.configRevision(), 'согласие — по ревизии сервера, как при C-07').toBe(server.reg.revision());

      const next = serverReg(1);
      (next as unknown as { data: Record<string, unknown> }).data['craft-new-table'] = [{ id: 'x' }];   // и негодный конфиг (R7-14) того же деплоя
      server.reg = next; server.etag = 'W/"v3"';
      g.ws().drop(4009);
      await g.enter(PROTOCOL_VERSION, 'build-2');
      expect(staleHints(g), 'тот же штамп сервера, новый негодный конфиг — сказано уже на этот деплой').toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
