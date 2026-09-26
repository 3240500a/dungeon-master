import { createRequire } from 'node:module';

/**
 * СТЕНД КЛАВИАТУРЫ PHASER ДЛЯ NODE-ТЕСТОВ (R6-03). Настоящие `KeyboardManager` (один на игру: слушатель `keydown`/`keyup`
 * на «window», `preventDefault` по списку перехвата `captures`, не глядя на цель события) и `KeyboardPlugin` сцены
 * (`addKey`, `addCapture`, `removeCapture`, выход сцены) из `phaser/src` — без игры, канваса и браузера.
 *
 * DOM в node нет — узлы-заглушки `KeyNode` со всплытием: событие идёт от цели вверх до «window», `stopPropagation`
 * обрывает путь после текущего узла, как у браузера. ⚠ Только для тестов: `require` из `phaser/src` в браузере нет.
 */
const req = createRequire(import.meta.url);
const KeyboardManager = req('phaser/src/input/keyboard/KeyboardManager.js') as new (input: unknown) => any;
const KeyboardPlugin = req('phaser/src/input/keyboard/KeyboardPlugin.js') as new (sceneInput: unknown) => any;
/** Эмиттер самого Phaser (`on(событие, fn, контекст)` — у node:events контекста нет, и `this` в обработчиках Phaser терялся). */
const EventEmitter = req('eventemitter3') as new () => unknown;

/** Клавиатурное событие стенда — ровно те поля, что читают Phaser и сторож набора. */
export interface KeyEv {
  type: 'keydown' | 'keyup';
  keyCode: number;
  key: string;
  target: KeyNode;
  timeStamp: number;
  altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Узел-заглушка: тег, родитель и слушатели. «window» — узел без родителя в корне пути. */
export class KeyNode {
  parent: KeyNode | null = null;
  isContentEditable = false;
  private on = new Map<string, ((e: KeyEv) => void)[]>();
  constructor(public tagName = 'DIV') { }
  addEventListener(t: string, f: (e: KeyEv) => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  removeEventListener(t: string, f: (e: KeyEv) => void): void { this.on.set(t, (this.on.get(t) ?? []).filter((x) => x !== f)); }
  /** Дочерний узел (цепочка всплытия). */
  child(tagName = 'DIV'): KeyNode { const c = new KeyNode(tagName); c.parent = this; return c; }
  /** Слушатели этого узла по типу — для `press`. */
  listeners(t: string): ((e: KeyEv) => void)[] { return [...(this.on.get(t) ?? [])]; }
}

let stamp = 0;
/**
 * Нажатие (или отпускание) по цели: всплытие цель → … → корень; `stopPropagation` обрывает путь после текущего узла.
 * `key` — что набрал бы браузер, `keyCode` — физическая клавиша (для Phaser).
 */
export function press(target: KeyNode, keyCode: number, key: string, type: 'keydown' | 'keyup' = 'keydown', mods: Partial<Pick<KeyEv, 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>> = {}): KeyEv {
  let stopped = false;
  const e: KeyEv = {
    type, keyCode, key, target, timeStamp: ++stamp,
    altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...mods,
    defaultPrevented: false,
    preventDefault: () => { e.defaultPrevented = true; },
    stopPropagation: () => { stopped = true; },
  };
  for (let n: KeyNode | null = target; n && !stopped; n = n.parent) for (const f of n.listeners(type)) f(e);
  return e;
}

/**
 * Клавиатура Phaser на «окне» `win`: менеджер игры и плагин одной сцены (`plugin` — это `scene.input.keyboard`).
 * `captures` — список перехвата менеджера (глобальный на страницу); `shutdown` — выход сцены (`KeyboardPlugin.shutdown`:
 * клавиши сцены сносятся, а перехват — нет); `isDown` — видит ли игра клавишу зажатой.
 */
export function phaserKeyboard(win: KeyNode) {
  const game = { events: new EventEmitter() };
  const input = { events: new EventEmitter(), game, config: { inputKeyboard: true, inputKeyboardEventTarget: win, inputKeyboardCapture: [] } };
  const manager = new KeyboardManager(input);
  manager.boot();
  const sceneInput = {
    systems: { game },
    scene: { sys: { settings: { input: {} }, events: new EventEmitter(), canInput: () => true } },
    manager: { keyboard: manager, events: input.events },
    pluginEvents: new EventEmitter(),
  };
  const plugin = new KeyboardPlugin(sceneInput);
  plugin.boot();
  plugin.start();
  return {
    manager,
    plugin,
    captures: (): number[] => [...(manager.captures as number[])],
    /** Нажатие по цели; очередь менеджера после него чистится, как в конце шага игры. */
    press: (target: KeyNode, keyCode: number, key: string, type: 'keydown' | 'keyup' = 'keydown'): KeyEv => {
      const e = press(target, keyCode, key, type);
      manager.postUpdate();
      return e;
    },
    isDown: (keyCode: number): boolean => Boolean(plugin.keys[keyCode]?.isDown),
    shutdown: (): void => plugin.shutdown(),
  };
}
