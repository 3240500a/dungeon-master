import { describe, it, expect, vi } from 'vitest';
import { NetDriver } from './netDriver.js';
import { InputPacer, INPUT_PERIOD_MS } from './inputPacer.js';
import { KeyNode, phaserKeyboard } from './phaserKeyboardHarness.js';

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
  return { driver, keys, inputs };
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
