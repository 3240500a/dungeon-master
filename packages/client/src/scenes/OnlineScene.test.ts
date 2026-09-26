import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigRegistry, newBotSave, TILE, type FloorInit, type ServerFrame } from '@dm/shared';
import { OnlineScene } from './OnlineScene.js';
import { askInGame } from '../ui/kit.js';
import { KeyNode, phaserKeyboard } from '../net/phaserKeyboardHarness.js';
import { readFileSync } from 'node:fs';
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
    on(t: string, cb: (f: never) => void): void { handlers.set(t, [...(handlers.get(t) ?? []), cb]); },
    off(t: string): void { handlers.delete(t); },
    clearLifecycle(): void { opens = []; closes = []; },
    onOpen(cb: () => void): void { opens.push(cb); },
    onClose(cb: (code?: number) => void): void { closes.push(cb); },
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
  scene.create();
  const save = newBotSave(reg, reg.get('classes')[0]!.id);
  const join = (area: 'town' | 'dungeon', pid = 'p1'): void => net.fire('joined', { playerId: pid, save, floor: floor(area), peers: [], roomCode: 'ABCD' } as never);
  return { net, app, scene, join, logs, events, camera, shutdown: () => shutdown?.() };
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

  it('⭐ R5-15: каждый вход (и новый — после потери связи) сверяет конфиг с сервером', () => {
    const s = setup();
    s.net.open(); s.join('town');
    expect(s.app.syncConfig, 'было: конфиг брался один раз на страницу — деплой без перезагрузки оставлял цены до деплоя').toHaveBeenCalledTimes(1);
    s.net.close(4009); s.net.open(); s.net.fire('runStatus', { hasRun: false }); s.join('town', 'p2');
    expect(s.app.syncConfig).toHaveBeenCalledTimes(2);
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
});
