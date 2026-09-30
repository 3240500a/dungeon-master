import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NetDriver } from './netDriver.js';
import { InputPacer, INPUT_PERIOD_MS } from './inputPacer.js';
import { KeyNode, phaserKeyboard } from './phaserKeyboardHarness.js';
import { beginHold, clearHeld, type HeldFrom } from '../modules/inventory/heldItem.js';

/**
 * ⭐ R3-08: 2D-КЛИЕНТ ШЛЁТ ВВОД С ЧАСТОТОЙ ТИКА СЕРВЕРА, А НЕ КАДРОВ. `NetDriver.update` зовётся каждый кадр Phaser
 * (rAF без потолка FPS) и слал кадр `input` на каждый: на мониторе 144 Гц — 144 кадра в секунду при потолке сокета
 * 80/с (`limits.wsFrames`), и сервер рвал соединение кодом 4008 через пару секунд. Теперь — не больше ~30 в секунду,
 * а фронт нажатия (рывок) — в том же кадре.
 *
 * Phaser в node не живёт — подменены он сам и модули-спрайты; драйвер настоящий.
 */
vi.mock('phaser', () => ({ default: { Input: { Keyboard: { KeyCodes: { W: 87, A: 65, S: 83, D: 68, SHIFT: 16, SPACE: 32, ALT: 18, E: 69, Q: 81 } } } } }));
vi.mock('../modules/combat/monster.js', () => ({ Monster: class {} }));
vi.mock('../modules/combat/projectile.js', () => ({ Projectile: class {} }));
vi.mock('../modules/loot/droppedItem.js', () => ({ DroppedItem: class {} }));
vi.mock('../modules/combat/playerVfx.js', () => ({ PlayerVfx: class { drawFrame(): void {} destroy(): void {} } }));


type Sent = { t: string; input?: { dodge?: boolean } };
/** Обработчики кадров поддельного `NetClient` по типу — `on` отдаёт отписку, как настоящий (R5-16). */
const netHandlers = new Map<string, Set<(f: never) => void>>();
function rig() {
  const keys = new Map<number, { isDown: boolean }>();
  const scene = {
    input: {
      keyboard: { addKey: (k: number) => { const key = { isDown: false }; keys.set(k, key); return key; }, addCapture: () => {}, removeCapture: () => {} },
      mouse: { disableContextMenu: () => {} },
      on: () => {}, off: () => {}, hitTestPointer: () => [],
    },
    time: { now: 0 },
  };
  const sent: Sent[] = [];
  const app = {
    net: {
      on: (t: string, cb: (f: never) => void) => {
        const set = netHandlers.get(t) ?? new Set(); set.add(cb); netHandlers.set(t, set);
        return () => { set.delete(cb); };
      },
      send: (f: Sent) => { sent.push(f); },
    },
    state: { save: { mouseLeft: null, mouseRight: null, hotbar: [null, null, null] } },
    config: { get: () => undefined },
    bus: { emit: () => {} },
  };
  const player = { facing: 0 };
  const driver = new NetDriver(scene as never, app as never, player as never);
  const inputs = (): Sent[] => sent.filter((f) => f.t === 'input');
  return { driver, keys, inputs, app };
}

describe('⭐ R3-08: ввод 2D-клиента — с частотой тика, а не кадров', () => {
  it('⭐ 144 Гц: 144 кадра за секунду дают не больше 31 кадра ввода (было 144 — сервер рвал 4008)', () => {
    const { driver, inputs } = rig();
    for (let i = 0; i < 144; i++) driver.update(1000 / 144);
    expect(inputs().length).toBeLessThanOrEqual(31);
    expect(inputs().length, 'ввод идёт с частотой тика, а не замирает').toBeGreaterThanOrEqual(29);
  });

  it('60 Гц с дрожью кадра — в среднем 30 в секунду (остаток переносится, а не обнуляется)', () => {
    const { driver, inputs } = rig();
    for (let i = 0; i < 120; i++) driver.update(1000 / 60 + (i % 2 ? 0.4 : -0.4));
    expect(inputs().length).toBeGreaterThanOrEqual(58);
    expect(inputs().length).toBeLessThanOrEqual(61);
  });

  it('⭐ фронт рывка (пробел) уходит в ТОМ ЖЕ кадре, между отправками; удержание его не повторяет', () => {
    const { driver, keys, inputs } = rig();
    driver.update(1000 / 144);                        // первый кадр — сразу
    driver.update(1000 / 144);
    const before = inputs().length;
    keys.get(32)!.isDown = true;                      // SPACE
    driver.update(1000 / 144);
    expect(inputs().length, 'кадр нажатия отправлен без ожидания периода').toBe(before + 1);
    expect(inputs().at(-1)!.input!.dodge).toBe(true);
    for (let i = 0; i < 20; i++) driver.update(1000 / 144);
    expect(inputs().slice(before + 1).every((f) => f.input!.dodge === false), 'удержание — не новый рывок').toBe(true);
  });

  it('InputPacer: долгий кадр не выпускает пачку отправок подряд; кривой dt не ломает счёт', () => {
    const p = new InputPacer();
    expect(p.due(1)).toBe(true);                      // первый — сразу
    expect(p.due(5_000)).toBe(true);                  // фриз вкладки
    expect(p.due(1), 'после фриза — не пачкой').toBe(false);
    expect(p.due(NaN)).toBe(false);
    expect(p.due(-50)).toBe(false);
    expect(p.due(INPUT_PERIOD_MS)).toBe(true);
  });
});

describe('⭐ R5-16: снесённый драйвер не слушает сеть', () => {
  it('после destroy кадры мира, событий, сейва и статики пиров не доходят ни до одного его обработчика', () => {
    netHandlers.clear();
    const { driver } = rig();
    const types = ['snapshot', 'events', 'saveUpdate', 'peerInfo', 'monsterInfo', 'peerJoined', 'peerLeft'];
    for (const t of types) expect(netHandlers.get(t)?.size, t).toBe(1);
    driver.destroy();
    for (const t of types) expect(netHandlers.get(t)?.size ?? 0, `было: обработчик «${t}» снесённого драйвера жил в NetClient до перезагрузки`).toBe(0);
  });
});

describe('⭐ R6-03: клавиши драйвера не перехватывают набор на всю страницу', () => {
  /**
   * Клавиатура Phaser — настоящая (`phaserKeyboardHarness`): перехват у неё один на страницу (слушатель на `window`,
   * `preventDefault` без оглядки на поле ввода) и переживает сцену. Драйвер перехватывал W/A/S/D/E/Q и пробел — после
   * ухода на вход (R4-22) они не набирались ни в ник, ни в пароль до F5, а «a» — в код комнаты в лобби.
   */
  function realRig() {
    const win = new KeyNode('#window');
    const body = win.child('#document').child('BODY');
    const kb = phaserKeyboard(win);
    const scene = {
      input: { keyboard: kb.plugin, mouse: { disableContextMenu: () => {} }, on: () => {}, off: () => {}, hitTestPointer: () => [] },
      time: { now: 0 },
    };
    const app = {
      net: { on: () => () => {}, send: () => {} },
      state: { save: { mouseLeft: null, mouseRight: null, hotbar: [null, null, null] } },
      config: { get: () => undefined },
      bus: { emit: () => {} },
    };
    const driver = new NetDriver(scene as never, app as never, { facing: 0 } as never);
    return { kb, driver, canvas: body.child('CANVAS'), input: body.child('INPUT') };
  }
  const LETTERS = [87, 65, 83, 68, 69, 81];   // W A S D E Q

  it('⭐ буквы игры — без перехвата: их набор в любом поле страницы браузер не теряет', () => {
    const r = realRig();
    for (const c of LETTERS) expect(r.kb.captures(), `буква ${String.fromCharCode(c)}`).not.toContain(c);
    const e = r.kb.press(r.input, 65, 'a');
    expect(e.defaultPrevented, 'было: «a» не набиралась ни в код комнаты, ни в пароль').toBe(false);
  });

  it('в игре клавиши работают: WASD и E видны драйверу, пробел по-прежнему не жмёт кнопку в фокусе', () => {
    const r = realRig();
    r.kb.press(r.canvas, 68, 'd');
    r.kb.press(r.canvas, 69, 'e');
    expect(r.kb.isDown(68)).toBe(true);
    expect(r.kb.isDown(69)).toBe(true);
    expect(r.kb.press(r.canvas, 32, ' ').defaultPrevented).toBe(true);
  });

  it('⭐ снесённый драйвер (выход на вход / выбор героя) перехвата не оставляет: пробел и буквы набираются', () => {
    const r = realRig();
    r.driver.destroy();
    r.kb.shutdown();                                   // Phaser сносит клавиши сцены, а перехват — нет
    expect(r.kb.captures(), 'было: [W, A, S, D, SHIFT, SPACE, ALT, E, Q] до перезагрузки страницы').toEqual([]);
    const typed = [...'swordfish qed'].filter((ch) => !r.kb.press(r.input, ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0), ch).defaultPrevented).join('');
    expect(typed, 'было: «orfih»').toBe('swordfish qed');
  });
});

/**
 * ⚠ R8-15: ОТКАТ БАФФА — НЕ УДАР. R6-15 слал на каст баффа `swing` с нулевым локом: клиент ставил им общий attack-лок в
 * «сейчас» (бафф посреди замаха — слоты атак переставали сереть при идущем серверном локе) и рисовал форму удара. Теперь
 * бафф шлёт `cooldown`: только заливка слота.
 */
describe('⚠ R8-15: событие отката баффа', () => {
  it('⭐ заливает откат своего слота, общий attack-лок и замах не трогает; чужое — мимо', () => {
    netHandlers.clear();
    const { driver, app } = rig();
    driver.setMyId('p1');
    const a = app as unknown as { attackLockUntil: number; actionCooldowns: Record<string, { start: number; until: number }> };
    a.actionCooldowns = {};
    const lock = performance.now() + 900;    // идёт серверный лок удара
    a.attackLockUntil = lock;
    const emit = (events: unknown[]): void => { for (const cb of netHandlers.get('events')!) cb({ t: 'events', events } as never); };
    // Замах драйвер рисует через `PlayerVfx.startSwing` — у подмены его нет: позови его обработчик — тест упадёт.
    emit([{ type: 'cooldown', playerId: 'p1', ability: 'b-class-warrior-a5', cooldownMs: 12_000 }]);
    expect(a.attackLockUntil, 'лок удара цел').toBe(lock);
    const cd = a.actionCooldowns['b-class-warrior-a5'];
    // `until − start` — разность двух дробных `performance.now` (`start + 12 000`): точно 12 000 — только при «удобном» `start`, а он — сколько
    // процесс уже живёт (при 5000,1 выходило 11 999,999999999998 — красный полный прогон). Сравнение с точностью до микросекунд.
    expect(cd && cd.until - cd.start, 'откат слота залит').toBeCloseTo(12_000, 6);
    emit([{ type: 'cooldown', playerId: 'p2', ability: 'x', cooldownMs: 5_000 }]);
    expect(a.actionCooldowns.x, 'откат чужого героя — не мой слот').toBeUndefined();
  });

  it('3D-клиент: ветка `cooldown` не бьёт куклой, не рисует «слэш» и не пишет attack-лок', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../render3d/online3d.ts', import.meta.url), 'utf8');
    const at = src.indexOf("e.type === 'cooldown'");
    expect(at, 'ветка есть').toBeGreaterThan(0);
    const branch = src.slice(at, src.indexOf('} else if', at));
    expect(branch).toContain('actionCooldowns[e.ability]');
    for (const bad of ['.attack(', 'vfx.slash', 'attackLockUntil']) expect(branch, bad).not.toContain(bad);
  });
});

/**
 * ⭐ R8-11: КЛИК, КОТОРЫМ БРОСАЮТ ПРЕДМЕТ С КУРСОРА, — НЕ УДАР. Предмет «на курсоре» (D2) роняется кликом по холсту
 * (`heldItem.onWorldClick` → `drop`, из сундука — отмена), но тот же `pointerdown` холста поднимал `leftHeld`: сэмплер
 * видел фронт ЛКМ и слал `attack:true` или скилл ЛКМ (маг с огнешаром на ЛКМ тратил ману и откат, удар тянул мобов, на
 * арене бил соперника). Веб-3D это гасил давно (`online3d.pumpInput`: `L: !holding && lmb`), 2D — нет.
 *
 * Драйвер и «предмет на курсоре» — настоящие; DOM — заглушка (`window`/`document`), Phaser подменён выше.
 */
describe('⭐ R8-11: бросок предмета с курсора — не удар и не каст', () => {
  type Frame = { t: string; cmd?: string; input?: { attack: boolean; cast: string | null } };
  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  let winClick: ((e: unknown) => void)[] = [];
  beforeEach(() => {
    winClick = [];
    G.document = {
      createElement: () => ({ style: {}, remove: () => {} }), body: { appendChild: () => {} },
      addEventListener: () => {}, removeEventListener: () => {}, hidden: false,
    };
    G.window = {
      addEventListener: (t: string, cb: (e: unknown) => void) => { if (t === 'click') winClick.push(cb); },
      removeEventListener: (t: string, cb: (e: unknown) => void) => { if (t === 'click') winClick = winClick.filter((f) => f !== cb); },
    };
  });
  afterEach(() => { clearHeld(); delete G.document; delete G.window; });

  const ITEM = { uid: 'it-1', name: 'Меч', gridW: 1, gridH: 3, rarity: 'normal', kind: 'weapon', slot: 'weapon' };
  const btn = (left: boolean, right = false) => ({ leftButtonDown: () => left, rightButtonDown: () => right });

  function heldRig(binds: { mouseLeft: string | null; mouseRight?: string | null }) {
    const on = new Map<string, (p: unknown) => void>();
    const scene = {
      input: {
        keyboard: { addKey: () => ({ isDown: false }), addCapture: () => {}, removeCapture: () => {} },
        mouse: { disableContextMenu: () => {} },
        on: (t: string, cb: (p: unknown) => void) => { on.set(t, cb); }, off: () => {}, hitTestPointer: () => [],
      },
      time: { now: 0 },
    };
    const sent: Frame[] = [];
    const app = {
      net: { on: () => () => {}, send: (f: Frame) => { sent.push(f); } },
      state: { save: { mouseLeft: binds.mouseLeft, mouseRight: binds.mouseRight ?? null, hotbar: [null, null, null] } },
      config: { get: () => undefined },
      bus: { emit: () => {} },
      sendCmd: (c: { cmd: string }) => { sent.push({ t: 'cmd', cmd: c.cmd }); return 1; },
    };
    const driver = new NetDriver(scene as never, app as never, { facing: 0 } as never);
    const frames = (n: number): void => { for (let i = 0; i < n; i++) driver.update(1000 / 60); };
    frames(10);                     // ровный ход: ничего не зажато
    sent.length = 0;
    /** Клик по земле, как в браузере: mousedown → ~100 мс кадров → mouseup → DOM-`click` окна (тут роняется предмет). */
    const clickGround = (right = false): void => {
      on.get('pointerdown')!(right ? btn(false, true) : btn(true));
      frames(6);
      on.get('pointerup')!(btn(false));
      for (const cb of [...winClick]) cb({ target: { tagName: 'CANVAS', closest: () => ({}) } });
      frames(3);
    };
    const hold = (from: HeldFrom): void => beginHold(app as never, ITEM as never, 0, 0, from);
    const inputs = (): Frame[] => sent.filter((f) => f.t === 'input');
    return { on, frames, clickGround, hold, sent, inputs };
  }

  it('⭐ из инвентаря: уходит `drop`, а удара нет (было: `attack:true` на каждый выброс)', () => {
    const r = heldRig({ mouseLeft: 'attack' });
    r.hold('inv');
    r.clickGround();
    expect(r.sent.filter((f) => f.t === 'cmd').map((f) => f.cmd)).toEqual(['drop']);
    expect(r.inputs().length, 'ввод идёт своим темпом').toBeGreaterThan(0);
    expect(r.inputs().filter((f) => f.input!.attack), 'было: взмах на каждый выброс').toEqual([]);
  });

  it('⭐ скилл на ЛКМ не кастуется (было: маг с огнешаром тратил ману и откат)', () => {
    const r = heldRig({ mouseLeft: 'fireball-node' });
    r.hold('inv');
    r.clickGround();
    expect(r.sent.some((f) => f.t === 'cmd' && f.cmd === 'drop')).toBe(true);
    expect(r.inputs().filter((f) => f.input!.cast != null), 'было: cast=fireball-node').toEqual([]);
  });

  it('из сундука клик по холсту — отмена взятия: ни команды, ни удара', () => {
    const r = heldRig({ mouseLeft: 'attack' });
    r.hold({ tab: 0 });
    r.clickGround();
    expect(r.sent.filter((f) => f.t === 'cmd')).toEqual([]);
    expect(r.inputs().filter((f) => f.input!.attack)).toEqual([]);
  });

  it('ПКМ с предметом на курсоре — тоже не каст (правило веб-3D: `R: !holding && rmb`)', () => {
    const r = heldRig({ mouseLeft: null, mouseRight: 'fireball-node' });
    r.hold('inv');
    r.clickGround(true);
    expect(r.inputs().filter((f) => f.input!.cast != null)).toEqual([]);
  });

  it('удержание, поднятое ДО взятия предмета, на время курсора гаснет', () => {
    const r = heldRig({ mouseLeft: 'attack' });
    r.on.get('pointerdown')!(btn(true));   // ЛКМ зажата (отпущена над окном — `pointerupoutside` драйверу не приходит)
    r.frames(3);
    expect(r.inputs().some((f) => f.input!.attack), 'контроль: без предмета бьёт').toBe(true);
    r.hold('inv');
    r.sent.length = 0;
    r.frames(12);
    expect(r.inputs().length).toBeGreaterThan(0);
    expect(r.inputs().filter((f) => f.input!.attack), 'предмет на курсоре — не бьём').toEqual([]);
  });

  it('контроль: без предмета на курсоре тот же клик — удар и каст, как прежде', () => {
    const a = heldRig({ mouseLeft: 'attack' });
    a.clickGround();
    expect(a.sent.some((f) => f.t === 'cmd')).toBe(false);
    expect(a.inputs().some((f) => f.input!.attack)).toBe(true);
    const c = heldRig({ mouseLeft: 'fireball-node' });
    c.clickGround();
    expect(c.inputs().some((f) => f.input!.cast === 'fireball-node')).toBe(true);
  });
});
