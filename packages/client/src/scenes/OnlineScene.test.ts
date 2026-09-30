import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CONFIG_REV_HEADER, ConfigRegistry, newBotSave, PRICE_CHANGED, PROTOCOL_VERSION, TILE, type FloorInit, type ServerFrame } from '@dm/shared';
import { OnlineScene } from './OnlineScene.js';
import { App } from '../core/app.js';
import { NetClient } from '../net/netClient.js';
import { EntryFlow } from '../net/entryFlow.js';
import { PROTOCOL_STALE } from '../net/versionGate.js';
import { askInGame } from '../ui/kit.js';
import { KeyNode, phaserKeyboard } from '../net/phaserKeyboardHarness.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 2D-СЦЕНА ОНЛАЙН-ИГРЫ (`OnlineScene`) — её проводка к сети, без Phaser: сам Phaser и модули-спрайты подменены,
 * сцена, `GameState` и кадры сервера — настоящие.
 * - ⭐ R3-24: `app.state.area` ведёт сцена — иначе в 2D-подземелье он навсегда 'town', и полевого разбора нет вовсе.
 * - ⭐ R3-25: сервер закрыл живую сессию (4009, 4001, обрыв) — сцена не замирает молча, а переподключается и ведёт в
 *   лобби/«Продолжить» с причиной.
 * - ⭐ R3-23: смена области и обрыв снимают открытый вопрос «разобрать здесь?».
 */
/** R6-25: «клавиша E только что нажата» (`Phaser.Input.Keyboard.JustDown`) — тест жмёт её сам. */
const keyE = vi.hoisted(() => ({ justDown: false }));
vi.mock('phaser', () => ({
  default: {
    Scene: class { constructor(_key?: string) { } },
    Input: { Keyboard: { KeyCodes: { E: 69 }, JustDown: () => keyE.justDown } },
    Scenes: { Events: { SHUTDOWN: 'shutdown' } },
    Math: { Distance: { Between: (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by) } },
  },
}));
/** R5-16: сколько героев-видов и драйверов построила сцена и сколько раз их снесла (счёт на весь файл). */
const made = { player: 0, playerDestroy: 0, driver: 0, driverDestroy: 0 };
vi.mock('../modules/movement/player.js', () => ({
  Player: class { x = 0; y = 0; cameraTarget = {}; constructor() { made.player++; } setPos(): void { } update(): void { } destroy(): void { made.playerDestroy++; } },
}));
vi.mock('../net/netDriver.js', () => ({
  NetDriver: class {
    myId = ''; resets = 0; dead = false;
    constructor() { made.driver++; }
    setMyId(id: string): void { this.myId = id; } seedPeers(): void { } buildMonsters(): void { } resetInterpolation(): void { }
    resetWorld(): void { this.resets++; } update(): void { } destroy(): void { this.dead = true; made.driverDestroy++; }
  },
}));
vi.mock('../world/tileWorld.js', () => ({ renderGrid: () => ({ walls: { destroy: () => { } }, objects: [] }) }));
vi.mock('../world/fogOfWar.js', () => ({ FogOfWar: class { revealSpawn(): void { } destroy(): void { } update(): void { } } }));
vi.mock('../world/torch.js', () => ({ Torch: class { x = 0; y = 0; flicker = 1; destroy(): void { } update(): void { } } }));
vi.mock('../world/lighting.js', () => ({ Lighting: class { destroy(): void { } update(): void { } } }));
// R4-13: маршрута у гейтвея здесь нет — сокет по адресу по умолчанию, как у одиночного процесса. Сам маршрут (очередь,
// «wrong-node», вход по коду к чужой ноде) гоняет `net/entryFlow.test.ts` с поддельным гейтвеем; проводку — сторож ниже.
vi.mock('../net/netClient.js', async (orig) => ({ ...(await orig<typeof import('../net/netClient.js')>()), routeToNode: undefined }));

class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; parent: El | null = null; value = '';
  private sel = new Map<string, El>();
  private html = '';
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string) { }
  set innerHTML(v: string) { this.children = []; this.sel.clear(); this.html = v; }
  get innerHTML(): string { return this.html; }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  click(): void { for (const f of this.on.get('click') ?? []) f(); }
  /** Элемент разметки по селектору: заглушка — один на селектор, кнопки кликабельны. */
  querySelector(s: string): El { let e = this.sel.get(s); if (!e) { e = new El('q'); e.parent = this; this.sel.set(s, e); } return e; }
  text(): string { return [this.html, this.textContent, ...[...this.sel.values()].map((e) => e.textContent), ...this.children.map((c) => c.text())].join(' | '); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const grid = [[1, 1, 1], [1, 0, 1], [1, 1, 1]] as unknown as FloorInit['grid'];
const floor = (area: 'town' | 'dungeon'): FloorInit => ({
  area, depth: area === 'dungeon' ? 1 : 0, grid, spawn: { x: 48, y: 48 }, exits: area === 'dungeon' ? [{ x: 16, y: 16 }] : undefined,
  decor: [], doors: [], levers: [], chests: [],
});

/** Поддельный `NetClient`: кадры сервера — `fire`, жизнь сокета — `open`/`close`. */
function fakeNet() {
  const handlers = new Map<string, ((f: never) => void)[]>();
  let opens: (() => void)[] = [], closes: ((code?: number) => void)[] = [];
  const net = {
    connected: false, rtt: -1, connects: 0, resets: 0, sent: [] as unknown[],
    /** Отписка — ровно этого обработчика, как у настоящего `NetClient.on` (R5-16). */
    on(t: string, cb: (f: never) => void): () => void {
      handlers.set(t, [...(handlers.get(t) ?? []), cb]);
      return () => { handlers.set(t, (handlers.get(t) ?? []).filter((h) => h !== cb)); };
    },
    /** Сколько обработчиков кадра `t` висит сейчас. */
    count(t: string): number { return handlers.get(t)?.length ?? 0; },
    /** R19-02: и жизнь сокета — с отпиской ровно своего колбэка; снять оптом, как и у `NetClient`, нечем. */
    onOpen(cb: () => void): () => void { opens.push(cb); return () => { opens = opens.filter((c) => c !== cb); }; },
    onClose(cb: (code?: number) => void): () => void { closes.push(cb); return () => { closes = closes.filter((c) => c !== cb); }; },
    connect(): void { net.connects++; },
    resetWorld(): void { net.resets++; },
    send(f: unknown): void { if (net.connected) net.sent.push(f); },
    fire<T extends ServerFrame['t']>(t: T, f: Omit<Extract<ServerFrame, { t: T }>, 't'>): void { for (const h of handlers.get(t) ?? []) h({ t, ...f } as never); },
    open(): void { net.connected = true; for (const cb of opens) cb(); },
    close(code?: number): void { net.connected = false; for (const cb of closes) cb(code); },
  };
  return net;
}

function setup(keyboard: unknown = { addKey: () => ({}) }) {
  const net = fakeNet();
  const logs: string[] = [];
  /** Прочие события шины сцены (R4-36: «закрыть все окна»). */
  const events: string[] = [];
  const app = {
    net, auth: { token: 'ab'.repeat(32) }, pendingCharId: 'hero-1', state: null as { area: string } | null,
    config: reg, gameLog: undefined, run: null,
    bus: { emit: (t: string, p: { text?: string; panel?: string }) => { if (t === 'log:message' && p.text) logs.push(p.text); else events.push(t === 'ui:open' ? `ui:open ${p.panel}` : t); } },
    /** R6-25: герой в мире — ставит поток входа (`App.setInWorld`; окна на смене закрывает сам `App`, см. его тест). */
    inWorld: false,
    setInWorld(on: boolean): void { app.inWorld = on; },
    replies: { dropAll: vi.fn() },
    clearAuth: vi.fn(),
    syncConfig: vi.fn(() => Promise.resolve()),
  };
  const { scene, camera, shutdown } = stage(app, keyboard);
  scene.create();
  const save = newBotSave(reg, reg.get('classes')[0]!.id);
  const join = (area: 'town' | 'dungeon', pid = 'p1'): void => net.fire('joined', { playerId: pid, save, floor: floor(area), peers: [], roomCode: 'ABCD' } as never);
  return { net, app, scene, join, logs, events, camera, shutdown };
}

/** Сцена без Phaser: реестр игры отдаёт `app`, прочее — заглушки. `create` — зовёт тест. */
function stage(app: unknown, keyboard: unknown = { addKey: () => ({}) }) {
  const chain: unknown = new Proxy(() => chain, { get: (_t, k) => (k === 'then' ? undefined : chain), apply: () => chain });
  const scene = new OnlineScene() as unknown as Record<string, unknown> & { create(): void; update(t: number, dt: number): void };
  let shutdown: (() => void) | undefined;
  /** R5-16: камера — со счётом слежения (Phaser на SHUTDOWN сцены сносит её вместе с настройками). */
  const camera = { startFollow: vi.fn(), setZoom: vi.fn() };
  Object.assign(scene, {
    game: { registry: { get: () => app } },
    input: { keyboard, activePointer: {} },
    add: chain, cameras: { main: camera }, textures: { exists: () => false }, time: { now: 0 },
    scene: { start: vi.fn(), stop: vi.fn(), isActive: () => true, launch: () => { } },
    events: { once: (_e: string, cb: () => void) => { shutdown = cb; } },
  });
  return { scene, camera, shutdown: () => shutdown?.() };
}

describe('OnlineScene — проводка 2D-клиента к серверу', () => {
  const G = globalThis as unknown as { document?: unknown };
  let body: El;
  beforeEach(() => { body = new El('body'); G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body }; });
  afterEach(() => { delete G.document; });

  it('⭐ R3-24: вход и смена области ведут app.state.area — в подземелье это «dungeon», в городе «town»', () => {
    const s = setup();
    s.net.open();
    s.join('dungeon');
    expect(s.app.state!.area, 'было: всегда «town» — полевой разбор в 2D не предлагался').toBe('dungeon');
    s.net.fire('areaChanged', { floor: floor('town') } as never);
    expect(s.app.state!.area).toBe('town');
    s.net.fire('areaChanged', { floor: floor('dungeon') } as never);
    expect(s.app.state!.area).toBe('dungeon');
  });

  it('⭐ R3-25: сервер закрыл живую сессию (4009) — плашка с причиной, переподключение, статус забега, лобби с причиной', () => {
    const s = setup();
    expect(s.net.connects).toBe(1);
    s.net.open();
    expect(s.net.sent).toEqual([{ t: 'runStatus', token: 'ab'.repeat(32), charId: 'hero-1' }]);
    s.net.fire('runStatus', { hasRun: false });
    s.join('dungeon');
    expect(body.text(), 'в игре — ни лобби, ни плашки').not.toContain('Кооп');
    s.net.close(4009);
    expect(s.net.connects, 'было: в игре закрытие не делало ничего — мир замирал').toBe(2);
    expect(body.text()).toContain('Подключение к серверу');
    expect(body.text()).toContain('Сессия устарела');
    expect(s.net.resets, 'копия мира прошлой сессии сброшена').toBe(1);
    s.net.open();
    expect(s.net.sent.at(-1)).toEqual({ t: 'runStatus', token: 'ab'.repeat(32), charId: 'hero-1' });
    s.net.fire('runStatus', { hasRun: false });
    expect(body.text()).toContain('Кооп');
    expect(body.text(), 'лобби говорит, почему игрок снова здесь').toContain('Сессия устарела');
    s.join('dungeon', 'p2');
    expect(body.text()).not.toContain('Кооп');
    expect((s.scene.driver as { myId: string }).myId, 'новый вход — новый id своего игрока').toBe('p2');
  });

  it('R3-25: вход из другого окна (4001) — своя причина; обрыв без кода — «соединение потеряно»; незавершённый забег — «Продолжить» с причиной', () => {
    const a = setup();
    a.net.open(); a.join('town');
    a.net.close(4001);
    expect(body.text()).toContain('другом окне');
    body.children = [];
    const b = setup();
    b.net.open(); b.join('dungeon');
    b.net.close();
    expect(body.text()).toContain('Соединение потеряно');
    b.net.open();
    b.net.fire('runStatus', { hasRun: true, roomCode: 'ABCD', depth: 2 });
    expect(body.text()).toContain('Незавершённое прохождение');
    expect(body.text()).toContain('Соединение потеряно');
  });

  it('до входа (плашка «Подключение…») закрытие — лобби с «Сервер недоступен», без переподключения по кругу', () => {
    const s = setup();
    s.net.close(1006);
    expect(s.net.connects).toBe(1);
    expect(body.text()).toContain('Кооп');
    expect(body.text()).toContain('Сервер недоступен');
  });

  it('⭐ L2 (общий поток входа): потеря связи отпускает ждущих команд; мёртвое лобби поднимает связь кнопкой; ошибка в игре — в лог', () => {
    const s = setup();
    s.net.open(); s.net.fire('runStatus', { hasRun: false }); s.join('dungeon');
    s.net.fire('error', { code: 'far', msg: 'Подойдите к порталу' } as never);
    expect(s.logs, 'было: ошибка в игре уходила в статус снятого окна — её не видел никто').toContain('Подойдите к порталу');
    s.net.close(4009);
    expect(s.app.replies.dropAll, 'ответ по мёртвому сокету не придёт — ждущие отпущены сразу, а не через 8 с').toHaveBeenCalledTimes(1);
    s.net.close(1006);                                 // переподключиться не вышло
    expect(body.text()).toContain('Сервер недоступен');
    const lobby = body.children.find((c) => c.text().includes('Кооп'))!;
    lobby.querySelector('[data-a="solo"]').click();
    expect(s.net.connects, 'было: клик слал join в мёртвый сокет, «Подключение…» навсегда').toBe(3);
    expect(body.text()).toContain('Подключение к серверу');
    s.net.open();
    expect(s.net.sent.at(-1), 'сперва статус забега — вход только следующим кликом').toEqual({ t: 'runStatus', token: 'ab'.repeat(32), charId: 'hero-1' });
  });

  it('после выхода из сцены закрытие сокета её не трогает', () => {
    const s = setup();
    s.net.open(); s.join('town');
    s.shutdown();
    s.net.close(4009);
    expect(s.net.connects).toBe(1);
  });

  it('⭐ R3-23: смена области и обрыв снимают открытый вопрос «разобрать здесь?» с ответом «нет»', async () => {
    const s = setup();
    s.net.open(); s.join('dungeon');
    /** Ответ на вопрос, если он уже есть (вопрос, который никто не снял, не ответится никогда). */
    const ask = (): { answer?: boolean } => { const r: { answer?: boolean } = {}; void askInGame('Разобрать здесь?').then((v) => { r.answer = v; }); return r; };
    const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 0));
    const q1 = ask();
    s.net.fire('areaChanged', { floor: floor('town') } as never);
    await tick();
    expect(q1.answer, 'было: вопрос висел над городом').toBe(false);
    s.net.fire('areaChanged', { floor: floor('dungeon') } as never);
    const q2 = ask();
    s.net.close(4009);
    await tick();
    expect(q2.answer, 'обрыв').toBe(false);
    const q3 = ask();
    s.shutdown();
    await tick();
    expect(q3.answer, 'выход из игры').toBe(false);
    expect(body.children.filter((c) => c.text().includes('Разобрать здесь?')), 'плашек не осталось').toEqual([]);
  });

  it('⭐ R4-22: «Требуется вход» на статус забега — ко входу (токен забыт); «Персонаж недоступен» — к выбору героя', () => {
    const a = setup();
    a.net.open();
    a.net.fire('error', { code: 'auth', msg: 'Требуется вход' } as never);
    expect(a.app.clearAuth).toHaveBeenCalledTimes(1);
    expect((a.scene.scene as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalledWith('Login');
    const b = setup();
    b.net.open();
    b.net.fire('error', { code: 'forbidden', msg: 'Персонаж недоступен' } as never);
    expect(b.app.pendingCharId).toBeNull();
    expect((b.scene.scene as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalledWith('CharacterSelect');
  });

  it('⭐ R5-16: после ухода на вход (R4-22) и нового входа сцена строит героя, драйвер и камеру заново — а не оживляет снесённые', () => {
    const s = setup();
    s.net.open(); s.join('town');
    const before = { ...made };
    const firstDriver = s.scene.driver as { dead: boolean };
    s.net.close(4009); s.net.open();
    s.net.fire('error', { code: 'auth', msg: 'Требуется вход' } as never);   // вышли в другой вкладке — ко входу
    const sc = s.scene.scene as { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    expect(sc.start).toHaveBeenCalledWith('Login');
    expect(sc.stop, 'HUD и хоткеи окон не живут над экраном входа').toHaveBeenCalledWith('UI');
    expect(s.events, 'окна прошлой сессии прочь').toContain('ui:closeAll');
    s.shutdown();                                     // Phaser сносит сцену: спрайты, клавиши, камеру
    expect(made.playerDestroy - before.playerDestroy, 'вид героя снесён вместе со сценой').toBe(1);
    (s.app as { auth: unknown }).auth = { token: 'cd'.repeat(32) };
    s.scene.create();                                 // игрок выбрал героя: scene.start('Online') — та же сцена заново
    s.net.open(); s.join('town', 'p9');
    expect(made.player - before.player, 'было: 0 — прежний, уже снесённый вид героя, невидимый и без ввода').toBe(1);
    expect(made.driver - before.driver, 'было: 0 — прежний драйвер со снесёнными клавишами и без мыши').toBe(1);
    expect(s.camera.startFollow, 'камера снова следит за героем').toHaveBeenCalledTimes(2);
    expect(s.camera.setZoom).toHaveBeenCalledTimes(2);
    expect(firstDriver.dead).toBe(true);
    expect(s.scene.driver, 'живой — новый драйвер').not.toBe(firstDriver);
    expect((s.scene.driver as { myId: string }).myId).toBe('p9');
  });

  it('⭐ R4-36: потеря связи закрывает окна (инвентарь, кузница…) — они не висят поверх лобби с кнопками в мёртвую сессию', () => {
    const s = setup();
    s.net.open(); s.join('town');
    expect(s.events).not.toContain('ui:closeAll');
    s.net.close(4009);
    expect(s.events).toContain('ui:closeAll');
  });

  it('⭐ D3: сцена в сверку версий не вмешивается — конфиг на входе перечитывает рукопожатие `App`, а не обработчик сцены', () => {
    const s = setup();
    s.net.open(); s.join('town');
    s.net.close(4009); s.net.open(); s.net.fire('runStatus', { hasRun: false }); s.join('town', 'p2');
    // R5-15 держит `App` (`net/versionGate.ts`, `core/app.config.test.ts`); у сцены своего перечитывания больше нет — раньше их было два пути.
    expect(s.app.syncConfig, 'сцена сама конфиг не трогает').not.toHaveBeenCalled();
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'OnlineScene.ts'), 'utf8');
    expect(src, '⚠ свой обработчик версий у сцены вернулся').not.toMatch(/onJoined|syncConfig|PROTOCOL_VERSION|buildDiffers|PROTOCOL_STALE/);
  });

  it('R4-13: адрес ноды поток спрашивает у гейтвея (`routeToNode`) — проводка 2D', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'OnlineScene.ts'), 'utf8');
    expect(src).toMatch(/route: routeToNode,/);
  });

  it('⭐ R6-03: сцена не перехватывает E — ни на лобби, ни после выхода (перехват Phaser на всю страницу и переживает сцену)', () => {
    const kb = phaserKeyboard(new KeyNode('#window'));
    const s = setup(kb.plugin);
    expect(kb.captures(), 'было: E перехвачена уже на первом лобби страницы — код с E не набирался').not.toContain(69);
    s.net.open(); s.join('town');
    expect(kb.captures()).not.toContain(69);
    s.shutdown(); kb.shutdown();                     // выход на вход (R4-22): Phaser сносит клавиши сцены, а перехват — нет
    for (const c of [65, 69, 87, 83, 68, 81, 32]) expect(kb.captures(), `код ${c}`).not.toContain(c);
  });

  it('⭐ R6-25: под плашкой и лобби [E] у NPC не срабатывает — кузница не открывается под экраном входа', () => {
    const s = setup();
    s.net.open(); s.net.fire('runStatus', { hasRun: false }); s.join('town');
    expect(s.app.inWorld, 'вход состоялся — герой в мире').toBe(true);
    const hero = s.scene.player as { x: number; y: number };
    hero.x = 7 * TILE + TILE / 2; hero.y = 4 * TILE + TILE / 2;   // у «Кузницы»
    const opened = (): string[] => s.events.filter((e) => e.startsWith('ui:open'));
    keyE.justDown = true;
    try {
      s.scene.update(0, 16);
      expect(opened(), 'в мире [E] открывает кузницу').toEqual(['ui:open forge']);
      s.events.length = 0;
      s.net.close(4009);                              // плашка «Подключение…»: вид героя, драйвер и NPC прошлой сессии живы
      expect(s.app.inWorld).toBe(false);
      s.scene.update(0, 16);
      s.net.open(); s.net.fire('runStatus', { hasRun: false });   // лобби
      s.scene.update(0, 16);
      expect(opened(), 'было: кузница под лобби, её `stashOpen` — в сокет без сессии, «Сундук не загрузился» через 8 с').toEqual([]);
      s.join('town', 'p2');
      expect(s.app.inWorld).toBe(true);
      s.scene.update(0, 16);
      expect(opened(), 'снова в мире — снова открывает').toEqual(['ui:open forge']);
    } finally { keyE.justDown = false; }
  });

  it('R6-25: выход из сцены прямо из мира — герой больше не в мире (хоткеи окон в меню молчат)', () => {
    const s = setup();
    s.net.open(); s.join('town');
    expect(s.app.inWorld).toBe(true);
    s.shutdown();
    expect(s.app.inWorld).toBe(false);
  });

  /**
   * ⭐ R13-14: АВТО-ВОЗРОЖДЕНИЕ АРЕНЫ СНИМАЕТ ОКНО СМЕРТИ. Сервер воскрешает погибшего в PvP через ~3 с (`tickArenaRespawns`
   * → `respawnPlayer`) без кадра `areaChanged` — о возрождении клиент узнаёт только по снапшоту (`alive:true`). 2D закрывал
   * окно лишь на смене области, обрыве, выходе и кнопке: «Вы повержены» висело над героем и глотало клики холста (атаки в
   * этой части экрана) на каждой смерти арены. ⚠ Смотрим на ПРИШЕДШИЙ снапшот, а не на кадр отрисовки: мир тикает 30 Гц,
   * снапшоты — 20 Гц, и на тике без рассылки `died` приходит раньше снапшота со смертью — последний принятый ещё «жив».
   */
  describe('⭐ R13-14: окно смерти и возрождение без смены области', () => {
    const snap = (players: { id: string; alive: boolean }[]): { snap: never } => ({
      snap: {
        tick: 1, monsters: [], projectiles: [], drops: [],
        players: players.map((p) => ({ x: 48, y: 48, facing: 0, hp: p.alive ? 100 : 0, mana: 10, stamina: 10, debuffs: {}, toggles: [], inCombat: false, stun: false, ...p })),
      } as never,
    });
    const deathBox = (): El | undefined => body.children.find((c) => /Вы повержены|Вы погибли/.test(c.text()));

    it('⭐ арена: `died {pvp}` → снапшот, где свой герой жив, без `areaChanged` — окно снято', () => {
      const s = setup();
      s.net.open(); s.net.fire('runStatus', { hasRun: false }); s.join('town');
      s.net.fire('snapshot', snap([{ id: 'p1', alive: false }, { id: 'p2', alive: true }]));
      s.net.fire('died', { goldLost: 0, itemsLost: 0, toTown: false, pvp: true });
      expect(deathBox()?.text()).toContain('Вы повержены');
      s.net.fire('snapshot', snap([{ id: 'p1', alive: false }, { id: 'p2', alive: true }]));
      expect(deathBox(), 'мёртв — окно на месте').toBeDefined();
      s.net.fire('snapshot', snap([{ id: 'p1', alive: true }, { id: 'p2', alive: true }]));
      expect(deathBox(), 'было: окно висело над героем до клика «Смотреть» и глотало клики холста').toBeUndefined();
    });

    it('⭐ смерть на тике без снапшота: `died` пришёл, а последний принятый снапшот ещё «жив» — окно не снимается кадрами отрисовки', () => {
      const s = setup();
      s.net.open(); s.net.fire('runStatus', { hasRun: false }); s.join('town');
      s.net.fire('snapshot', snap([{ id: 'p1', alive: true }]));
      s.net.fire('died', { goldLost: 0, itemsLost: 0, toTown: false, pvp: true });
      for (let i = 0; i < 5; i++) s.scene.update(0, 16);
      expect(deathBox(), 'окно смерти не мигнуло и не пропало').toBeDefined();
      s.net.fire('snapshot', snap([{ id: 'p1', alive: false }]));
      s.scene.update(0, 16);
      expect(deathBox()).toBeDefined();
      s.net.fire('snapshot', snap([{ id: 'p1', alive: true }]));
      expect(deathBox()).toBeUndefined();
    });

    it('кооп: мёртвый ждёт пати — живые союзники в снапшоте окно не снимают; «Смотреть» закрывает, как прежде', () => {
      const s = setup();
      s.net.open(); s.net.fire('runStatus', { hasRun: false }); s.join('dungeon');
      s.net.fire('died', { goldLost: 120, itemsLost: 1, toTown: false });
      for (let i = 0; i < 3; i++) s.net.fire('snapshot', snap([{ id: 'p1', alive: false }, { id: 'p2', alive: true }]));
      expect(deathBox()?.text()).toContain('120');
      deathBox()!.children.find((c) => c.textContent === 'Смотреть за пати')!.click();
      expect(deathBox()).toBeUndefined();
      s.net.fire('snapshot', snap([{ id: 'p1', alive: false }, { id: 'p2', alive: true }]));
      expect(deathBox(), 'закрытое «Смотреть» снапшоты не открывают').toBeUndefined();
    });

    it('подписка на снапшоты — одна на показ сцены: выход её снимает, новый вход не копит', () => {
      const s = setup();
      const base = s.net.count('snapshot');
      s.shutdown();
      expect(s.net.count('snapshot'), 'после выхода обработчика сцены нет').toBe(base - 1);
      s.scene.create();
      s.scene.create();
      expect(s.net.count('snapshot')).toBe(base);
    });

    it('3D-клиент: то же правило — по пришедшему снапшоту, а не на кадре отрисовки', () => {
      const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'render3d', 'online3d.ts'), 'utf8');
      const at = src.indexOf("app.net.on('snapshot'");
      expect(at, 'обработчик снапшота есть').toBeGreaterThan(0);
      const handler = src.slice(at, src.indexOf('\n  app.net.on(', at + 1));
      expect(handler, 'жив в пришедшем снапшоте — окно смерти прочь').toMatch(/alive\s*&&\s*deathWin\.state\)\s*deathWin\.reset\(\)/);
      const render = src.slice(src.indexOf('function renderWorld('), src.indexOf('function renderWorld(') + 4000);
      expect(render, 'было: проверка по последнему принятому снапшоту на кадре отрисовки снимала окно на тике без снапшота').not.toMatch(/deathWin\.reset\(\)/);
    });
  });

  /**
   * ⭐ R14-03: «В ГОРОД» ПОСЛЕ «СМОТРЕТЬ». A погиб при живом B, закрыл окно «Смотреть»; B отвалился посреди боя — сервер один раз шлёт
   * `died{status, canLeave}` (пати ждёт B до часа). Закрытое окно статусы не открывают (R13-05) — и «В город», единственный выход,
   * не рисовался нигде. Теперь — плашка с кнопкой вне окна, кнопка шлёт `return`.
   */
  it('⭐ R14-03: смерть → «Смотреть» → статус `canLeave` — плашка «В город», её кнопка шлёт `return`; напарник вернулся — плашка прочь', () => {
    const s = setup();
    s.net.open(); s.net.fire('runStatus', { hasRun: false }); s.join('dungeon');
    const box = (re: RegExp): El | undefined => body.children.find((c) => re.test(c.text()));
    s.net.fire('died', { goldLost: 350, itemsLost: 2, toTown: false });
    box(/Вы погибли/)!.children.find((c) => c.textContent === 'Смотреть за пати')!.click();
    expect(box(/Вы погибли/)).toBeUndefined();
    s.net.fire('died', { goldLost: 0, itemsLost: 0, toTown: false, status: true, canLeave: true });
    expect(box(/Вы погибли/), 'окно само не встаёт (R13-05)').toBeUndefined();
    const dock = box(/отключился посреди боя/);
    expect(dock, 'было: ни окна, ни кнопки — мёртвый ждал до часа').toBeDefined();
    const town = dock!.children.find((c) => c.textContent === 'В город');
    expect(town, 'кнопка «В город»').toBeDefined();
    const sent = s.net.sent.length;
    town!.click();
    expect(s.net.sent.slice(sent)).toEqual([{ t: 'return' }]);
    s.net.fire('died', { goldLost: 0, itemsLost: 0, toTown: false, status: true });
    expect(box(/отключился посреди боя/), 'напарник вернулся — выхода мёртвому больше нет').toBeUndefined();
    s.net.fire('died', { goldLost: 0, itemsLost: 0, toTown: false, status: true, canLeave: true });
    expect(box(/отключился посреди боя/)).toBeDefined();
    s.net.fire('areaChanged', { floor: floor('town') } as never);
    expect(box(/отключился посреди боя/), 'смена области — плашка прочь').toBeUndefined();
  });
});

/**
 * ⭐ R19-02: СЦЕНА НЕ СНИМАЕТ ЧУЖИХ ПОДПИСОК. `App` (живёт всё приложение, создан в `main.ts` до сцен) слушает `joined` — штамп сборки сервера
 * (R18-08) — и `cmdResult`. 2D-сцена на каждом входе снимала обработчики кадров ОПТОМ (`NetClient.off(t)` — все обработчики типа), и штамп
 * сборки молча уходил вместе со своими: деплой со сменой кода цен при том же конфиге оставлял 2D-вкладку в круге «Цена изменилась» (перечитывание —
 * 304) без «перезагрузите», ровно как до R18-08. 3D и тесты `App` этого не видели: там `off` не зовёт никто. Здесь — настоящие `App` и
 * `NetClient` (сокет поддельный), сцена — та, что в 2D-клиенте.
 */
class FakeWs {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all: FakeWs[] = [];
  readyState = FakeWs.CONNECTING;
  binaryType = '';
  bufferedAmount = 0;
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

describe('⭐ R19-02: 2D-сцена и подписки App — штамп сборки на входе и отказ ценой', () => {
  const G = globalThis as unknown as { document?: unknown; WebSocket?: unknown; fetch?: unknown; location?: unknown };
  let saved: { ws: unknown; fetch: unknown; location: unknown; warn: { mockRestore(): void } };
  beforeEach(() => {
    saved = { ws: G.WebSocket, fetch: G.fetch, location: G.location, warn: vi.spyOn(console, 'warn').mockImplementation(() => { }) };
    G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body: new El('body') };
    G.WebSocket = FakeWs; FakeWs.all = [];
    // `/api/config`: тело конфига то же (304) — деплой сменил КОД цен, не конфиг.
    G.fetch = () => Promise.resolve({ ok: false, status: 304, headers: { get: () => null }, json: () => Promise.reject(new Error('304 без тела')) });
    G.location = { protocol: 'http:', host: 'game.test', hostname: 'game.test' };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubGlobal('__DM_BUILD__', 'build-1');   // штамп, который сборка вписала в бандл вкладки
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    G.WebSocket = saved.ws; G.fetch = saved.fetch; G.location = saved.location;
    saved.warn.mockRestore();
    delete G.document;
  });
  const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

  /** Страница 2D: `App` из `main.ts`, вход в аккаунт и выбор героя, затем сцена «Online». */
  async function page() {
    const app = new App();
    await flush();
    app.auth = { token: 'ab'.repeat(32), userId: 'u1', username: 'hero' };
    app.pendingCharId = 'hero-1';
    const hints: number[] = [];
    app.bus.on('log:message', (m) => { if (m.text === PROTOCOL_STALE) hints.push(Date.now()); });
    const st = stage(app);
    st.scene.create();
    const save = newBotSave(app.config, app.config.get('classes')[0]!.id);
    const ws = (): FakeWs => FakeWs.all.at(-1)!;
    /** Сокет открылся, статус забега (лобби), кадр `joined` сервера сборки `build`. */
    const enter = async (build: string, pid = 'p1'): Promise<void> => {
      if (ws().readyState !== FakeWs.OPEN) ws().open();
      ws().frame({ t: 'runStatus', hasRun: false });
      ws().frame({ t: 'joined', v: PROTOCOL_VERSION, build, playerId: pid, save, floor: floor('town'), peers: [], roomCode: 'ABCD' });
      await flush();
    };
    /** Отказ ценой: команда без ждущего (продажа), перечитывание конфига — 304. */
    const refuse = async (): Promise<void> => {
      vi.setSystemTime(Date.now() + 5_000);   // игрок думает дольше повтора подсказки
      ws().frame({ t: 'cmdResult', id: 900 + hints.length, cmd: 'sell', ok: false, reason: `${PRICE_CHANGED}: лавка даст 31 золота` });
      await flush();
    };
    /** Сколько обработчиков висит на кадре `t` и на жизни сокета (приватное `NetClient` — только для счёта). */
    const count = (t: ServerFrame['t']): number => ((app.net as unknown as { handlers: Map<string, unknown[]> }).handlers.get(t) ?? []).length;
    const life = (): number => {
      const n = app.net as unknown as { openCbs: unknown[]; closeCbs: unknown[] };
      return n.openCbs.length + n.closeCbs.length;
    };
    return { app, hints, enter, refuse, count, life, ...st };
  }

  it('⭐ деплой сменил код цен, конфиг тот же: «перезагрузите» на входе и на каждый отказ ценой — и после пере-входа в сцену', async () => {
    const p = await page();
    await p.enter('build-1');
    expect(p.hints, 'сборки одни — ни слова').toEqual([]);
    FakeWs.all.at(-1)!.drop(4009);                     // деплой: сервер новой сборки, вкладка переподключилась сама
    await p.enter('build-2');
    expect(p.hints.length, 'было: 0 — сцена сняла обработчик штампа App вместе со своими').toBe(1);
    await p.refuse();
    expect(p.hints.length, 'было: 0 — отказ ценой при том же конфиге, «перезагрузите» ни разу').toBe(2);
    // Выход к выбору героя и новый вход (R4-22 / R5-16: `scene.start('Online')` — та же сцена заново; сокет жив).
    p.shutdown();
    p.scene.create();
    await p.enter('build-2', 'p2');
    expect(p.hints.length, '⭐ D3: новый вход к чужой сборке — одна строка (было: тот же штамп — молча)').toBe(3);
    await p.refuse();
    expect(p.hints.length, 'отказ ценой после пере-входа в сцену — снова сказано').toBe(4);
    FakeWs.all.at(-1)!.drop(4009);                     // следующий деплой
    await p.enter('build-3', 'p3');
    expect(p.hints.length, 'новая сборка сервера после пере-входа в сцену — сказано на входе').toBe(5);
  });

  it('пере-вход в сцену не копит подписок и не снимает подписок App: выход оставляет ровно подписки App', async () => {
    const p = await page();
    const types = ['joined', 'cmdResult', 'shop', 'stash', 'questBoard', 'runPlan', 'areaChanged', 'died', 'error', 'runStatus', 'abandoned', 'snapshot'] as const;
    const shown = Object.fromEntries(types.map((t) => [t, p.count(t)]));
    const shownLife = p.life();
    p.shutdown();
    const bare = new App();                            // подписки самого App (страница без сцены)
    const own = (t: ServerFrame['t']): number => ((bare.net as unknown as { handlers: Map<string, unknown[]> }).handlers.get(t) ?? []).length;
    expect(Object.fromEntries(types.map((t) => [t, p.count(t)])), 'после выхода — только подписки App').toEqual(Object.fromEntries(types.map((t) => [t, own(t)])));
    expect(p.life(), 'и жизнь сокета сцене больше не нужна').toBe(0);
    p.scene.create();
    p.scene.create();                                  // и второй показ без выхода — не копит
    expect(Object.fromEntries(types.map((t) => [t, p.count(t)]))).toEqual(shown);
    expect(p.life()).toBe(shownLife);
  });

  it('сторож: снять обработчики кадра оптом нельзя — у `NetClient` нет `off`/`clearLifecycle`, и клиент их не зовёт', () => {
    const proto = Object.getOwnPropertyNames(NetClient.prototype);
    expect(proto, 'подписку снимает только её владелец — отпиской, которую вернул `on`').not.toContain('off');
    expect(proto).not.toContain('clearLifecycle');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : []));
    const calls = files(root).filter((f) => /\bnet\??\.(off|clearLifecycle)\(/.test(readFileSync(f, 'utf8')));
    expect(calls, 'снятие подписок оптом').toEqual([]);
  });
});

/**
 * ⭐ D3: ОДНО РУКОПОЖАТИЕ ВЕРСИЙ — 2D И ВЕБ-3D ОДНИМ ПУТЁМ. Сверка версий (протокол, штамп сборки, ревизия конфига) и «перезагрузите» живут в `App`
 * (`net/versionGate.ts`); клиенты отличаются только проводкой входа: 2D — настоящая сцена `OnlineScene` со своим потоком входа, веб-3D — поток входа
 * с теми же зависимостями, что в `render3d/online3d.ts` (сам `online3d` в node не собирается, его проводку сторожит `online3dNet.test.ts`). Один и
 * тот же сценарий деплоев и отказов обязан дать обоим клиентам ОДНУ И ТУ ЖЕ ленту подсказок и те же перечитывания конфига. Раньше путей было три
 * (протокол — поток входа, штамп — подписка `App`, конфиг — `onJoined` каждого клиента), и 2D-сцена одну из подписок снимала (R19-02).
 */
describe('⭐ D3: рукопожатие версий — 2D-сцена и веб-3D одним путём', () => {
  const G = globalThis as unknown as { document?: unknown; WebSocket?: unknown; fetch?: unknown; location?: unknown };
  /** Сервер `/api/config`: тело, ETag, ревизия (`CONFIG_REV_HEADER`) и счёт запросов. */
  const srv = { body: {} as Record<string, unknown>, etag: '', rev: '', calls: 0 };
  const good = (tweak = 0): void => {
    const r = new ConfigRegistry(); r.loadAll();
    if (tweak) { const b = structuredClone(r.get('balance')); b.respecCost += tweak; r.reload({ balance: b }); }
    Object.assign(srv, { body: JSON.parse(JSON.stringify(r.snapshot())) as Record<string, unknown>, etag: `W/"ok-${tweak}"`, rev: r.revision() });
  };
  /** Деплой со сменой схемы: таблица, которой вкладка не знает, — конфиг она не разберёт (R7-14). */
  const broken = (): void => {
    good(3);
    Object.assign(srv, { body: { ...srv.body, 'craft-new-table': [{ id: 'x' }] }, etag: 'W/"broken"', rev: 'br0ken-1' });
  };
  let saved: { ws: unknown; fetch: unknown; location: unknown; warn: { mockRestore(): void } };
  beforeEach(() => {
    saved = { ws: G.WebSocket, fetch: G.fetch, location: G.location, warn: vi.spyOn(console, 'warn').mockImplementation(() => { }) };
    G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body: new El('body') };
    G.WebSocket = FakeWs; FakeWs.all = [];
    good();
    srv.calls = 0;
    G.fetch = (url: string, init?: { headers?: Record<string, string> }) => {
      if (url !== '/api/config') return Promise.reject(new Error(`не ждали ${url}`));
      srv.calls++;
      const headers = { get: (h: string) => (h.toLowerCase() === 'etag' ? srv.etag : h.toLowerCase() === CONFIG_REV_HEADER ? srv.rev : null) };
      if (init?.headers?.['if-none-match'] === srv.etag) return Promise.resolve({ ok: false, status: 304, headers, json: () => Promise.reject(new Error('304')) });
      const body = JSON.parse(JSON.stringify(srv.body)) as unknown;
      return Promise.resolve({ ok: true, status: 200, headers, json: () => Promise.resolve(body) });
    };
    G.location = { protocol: 'http:', host: 'game.test', hostname: 'game.test' };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubGlobal('__DM_BUILD__', 'build-1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    G.WebSocket = saved.ws; G.fetch = saved.fetch; G.location = saved.location;
    saved.warn.mockRestore();
    delete G.document;
  });
  const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

  /** Страница клиента: `App` из `main.ts`, вход героем; 2D — сцена «Online», 3D — поток входа с проводкой `online3d`. */
  async function client(kind: '2d' | '3d') {
    const app = new App();
    await flush();
    app.auth = { token: 'ab'.repeat(32), userId: 'u1', username: 'hero' };
    app.pendingCharId = 'hero-1';
    const hints: number[] = [];
    app.bus.on('log:message', (m) => { if (m.text === PROTOCOL_STALE) hints.push(Date.now()); });
    if (kind === '2d') {
      stage(app).scene.create();
    } else {
      const view = { showConnecting() { }, showLobby() { }, showResume() { }, hide() { }, setStatus() { } };
      const entry = new EntryFlow({
        net: app.net, who: () => ({ token: app.auth!.token, charId: app.pendingCharId! }), view, onLost: () => { }, replies: app.replies,
        log: (text) => app.bus.emit('log:message', { text, kind: 'system' }), inWorld: (on) => app.setInWorld(on),
      });
      entry.attach();
      entry.start();
    }
    const save = newBotSave(app.config, app.config.get('classes')[0]!.id);
    const ws = (): FakeWs => FakeWs.all.at(-1)!;
    return {
      hints,
      /** Вход: кадр `joined` — рукопожатие `v`, `build`, `cfgRev`. */
      enter: async (h: { v?: number; build: string; cfgRev: string }): Promise<void> => {
        if (ws().readyState !== FakeWs.OPEN) ws().open();
        ws().frame({ t: 'runStatus', hasRun: false });
        ws().frame({ t: 'joined', v: h.v ?? PROTOCOL_VERSION, build: h.build, cfgRev: h.cfgRev, playerId: 'p1', save, floor: floor('town'), peers: [], roomCode: 'ABCD' });
        await flush();
      },
      drop: (): void => { ws().drop(4009); },
      /** Отказ ценой; `ms` — сколько игрок думал до клика. */
      refuse: async (ms = 5_000): Promise<void> => {
        vi.setSystemTime(Date.now() + ms);
        ws().frame({ t: 'cmdResult', id: 900 + srv.calls, cmd: 'sell', ok: false, reason: `${PRICE_CHANGED}: лавка даст 31 золота` });
        await flush();
      },
    };
  }

  /** Сценарий деплоев — лента: после каждого шага [что, подсказок, запросов конфига]. */
  async function script(kind: '2d' | '3d'): Promise<[string, number, number][]> {
    good();
    srv.calls = 0;
    const c = await client(kind);
    const out: [string, number, number][] = [];
    const mark = (what: string): void => { out.push([what, c.hints.length, srv.calls]); };
    await c.enter({ build: 'build-1', cfgRev: srv.rev }); mark('вход: всё сходится');
    c.drop(); await c.enter({ build: 'build-2', cfgRev: srv.rev }); mark('деплой кода');
    await c.refuse(); mark('отказ ценой');
    await c.refuse(500); mark('зажатый клик');
    c.drop(); await c.enter({ build: 'build-2', cfgRev: srv.rev }); mark('тот же сервер, новый вход');
    broken(); c.drop(); await c.enter({ build: 'build-1', cfgRev: srv.rev }); mark('схема конфига новее вкладки');
    await c.refuse(); mark('отказ: конфиг не разобран');
    good(5); await c.refuse(); mark('отказ: конфиг починили — лёг');
    await c.refuse(); mark('отказ: гонка той же сборки');
    c.drop(); await c.enter({ build: 'build-1', cfgRev: srv.rev }); mark('вход: снова всё сходится');
    broken(); c.drop(); await c.enter({ v: PROTOCOL_VERSION + 1, build: 'build-2', cfgRev: srv.rev }); mark('протокол, штамп и схема разом');
    return out;
  }

  it('один сценарий — одна лента подсказок у 2D и веб-3D: одна строка на вход, отказ — после одного перечитывания, без ложных', async () => {
    const d2 = await script('2d');
    FakeWs.all = [];
    const d3 = await script('3d');
    expect(d3, 'веб-3D — тем же путём, что 2D').toEqual(d2);
    expect(d2.map(([what, hints]) => [what, hints])).toEqual([
      ['вход: всё сходится', 0],
      ['деплой кода', 1],
      ['отказ ценой', 2],
      ['зажатый клик', 2],
      ['тот же сервер, новый вход', 3],
      ['схема конфига новее вкладки', 4],
      ['отказ: конфиг не разобран', 5],
      ['отказ: конфиг починили — лёг', 5],
      ['отказ: гонка той же сборки', 5],
      ['вход: снова всё сходится', 5],
      ['протокол, штамп и схема разом', 6],
    ]);
    // Перечитывания: вход с той же ревизией — без запроса; вход с другой и каждый отказ ценой — ровно одно.
    const calls = Object.fromEntries(d2.map(([what, , n], i) => [what, n - (i ? d2[i - 1]![2] : 1)]));
    expect(calls, 'старт страницы — одно чтение конфига, дальше — только по делу').toEqual({
      'вход: всё сходится': 0,
      'деплой кода': 0,
      'отказ ценой': 1,
      'зажатый клик': 1,
      'тот же сервер, новый вход': 0,
      'схема конфига новее вкладки': 1,
      'отказ: конфиг не разобран': 1,
      'отказ: конфиг починили — лёг': 1,
      'отказ: гонка той же сборки': 1,
      'вход: снова всё сходится': 0,
      'протокол, штамп и схема разом': 1,
    });
  });
});
