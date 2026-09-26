import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from '@dm/shared';
import { DomUi } from './domUi.js';

/**
 * ⭐ R4-36: ОКНА — ПОД ЭКРАНАМИ ВХОДА, ГОЛОСОВАНИЕМ И СМЕРТЬЮ. Каждый клик в окне поднимал его `z-index` на единицу без
 * потолка (от 60): три десятка кликов по инвентарю — обычная игра — и окно выше плашки «Подключение…» / лобби /
 * «Продолжить» (90), голосования (88) и окна смерти (96). Потеря связи окон не закрывала: инвентарь или кузница (до 900
 * пикселей) рисовались поверх лобби, закрывали «Продолжить», а их кнопки слали команды в сессию, которой нет.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуется менеджер окон.
 */
class El {
  children: El[] = []; style: Record<string, string> = {}; dataset: Record<string, string> = {}; textContent = ''; parent: El | null = null;
  innerHTML = '';
  offsetLeft = 0; offsetTop = 0;
  private on = new Map<string, ((e: unknown) => void)[]>();
  constructor(public tag: string) { }
  addEventListener(t: string, f: (e: unknown) => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  fire(t: string, e: unknown = { target: this }): void { for (const f of this.on.get(t) ?? []) f(e); }
}

/** Слои поверх окон (`z-index`): голосование, экраны входа (плашка, лобби, «Продолжить»), окно смерти. */
const VOTE = 88, ENTRY = 90, DEATH = 96;

describe('⭐ R4-36: окна DomUi — в своей полосе z-index', () => {
  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  beforeEach(() => {
    G.document = { createElement: (t: string) => new El(t), body: new El('body') };
    G.window = { addEventListener: () => { } };
  });
  afterEach(() => { delete G.document; delete G.window; });

  function ui() {
    const bus = new EventBus();
    const root = new El('ui-root');
    const d = new DomUi({ bus } as never, root as unknown as HTMLElement);
    for (const name of ['inventory', 'forge', 'skills']) d.register(name, () => ({ title: name, render: () => { } }));
    const win = (i: number): El => root.children[i]!;
    const z = (i: number): number => Number(win(i).style.zIndex);
    return { d, bus, root, win, z };
  }

  it('⭐ сотня кликов в окне — оно всё ещё НИЖЕ голосования, экранов входа и окна смерти (было: 60 + 100)', () => {
    const u = ui();
    u.d.openPanel('inventory'); u.d.openPanel('forge');
    for (let i = 0; i < 100; i++) u.win(i % 2).fire('pointerdown');
    for (const i of [0, 1]) {
      expect(u.z(i), `окно ${i}`).toBeLessThan(VOTE);
      expect(u.z(i)).toBeLessThan(ENTRY);
      expect(u.z(i)).toBeLessThan(DEATH);
    }
  });

  it('порядок окон при этом живой: нажатое — поверх остальных', () => {
    const u = ui();
    u.d.openPanel('inventory'); u.d.openPanel('forge'); u.d.openPanel('skills');
    for (let i = 0; i < 300; i++) u.win(i % 3).fire('pointerdown');
    for (const top of [0, 1, 2, 1, 0]) {
      u.win(top).fire('pointerdown');
      const others = [0, 1, 2].filter((i) => i !== top);
      for (const o of others) expect(u.z(top), `нажатое ${top} поверх ${o}`).toBeGreaterThan(u.z(o));
    }
    u.d.close('forge');
    u.d.openPanel('forge');
    expect(u.z(2), 'новое окно — поверх').toBeGreaterThan(Math.max(u.z(0), u.z(1)));
  });

  it('⭐ «закрыть все окна» по шине (потеря связи): ни одного окна поверх экранов входа', () => {
    const u = ui();
    u.d.openPanel('inventory'); u.d.openPanel('forge');
    u.bus.emit('ui:closeAll', {});
    expect(u.d.isOpen()).toBe(false);
    expect(u.root.children).toHaveLength(0);
  });
});

describe('⭐ R6-25: вне мира окна не открываются — ни хоткеем, ни по шине', () => {
  /**
   * Связь потеряна (плашка «Подключение…», лобби, «Продолжить»), вход в аккаунт или выбор героя: окна прошлой сессии
   * закрыты (R4-36), а хоткеи I/K/C/J/M и [E] у NPC открывали их снова — под экраном входа, с кнопками в сессию, которой
   * нет, и они переживали вход в новую. «В мире» — `App.inWorld`: его ведёт поток входа (`EntryFlow`).
   */
  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  let keydown: ((e: unknown) => void)[] = [];
  beforeEach(() => {
    keydown = [];
    G.document = { createElement: (t: string) => new El(t), body: new El('body') };
    G.window = { addEventListener: (t: string, f: (e: unknown) => void) => { if (t === 'keydown') keydown.push(f); } };
  });
  afterEach(() => { delete G.document; delete G.window; });

  function ui(inWorld: boolean) {
    const bus = new EventBus();
    const app = { bus, inWorld };
    const d = new DomUi(app as never, new El('ui-root') as unknown as HTMLElement);
    for (const name of ['inventory', 'forge']) d.register(name, () => ({ title: name, render: () => { } }));
    const key = (code: string): void => { for (const f of keydown) f({ code, target: new El('canvas'), preventDefault: () => { } }); };
    return { d, bus, app, key };
  }

  it('⭐ хоткей I вне мира окно не открывает (было: инвентарь под плашкой и в лобби)', () => {
    const u = ui(false);
    u.key('KeyI');
    expect(u.d.isOpen('inventory')).toBe(false);
    u.app.inWorld = true;
    u.key('KeyI');
    expect(u.d.isOpen('inventory'), 'в мире — как было').toBe(true);
  });

  it('⭐ «открыть окно» по шине ([E] у NPC) вне мира не открывает (было: кузница под лобби со `stashOpen` в сокет без сессии)', () => {
    const u = ui(false);
    u.bus.emit('ui:open', { panel: 'forge' });
    expect(u.d.isOpen()).toBe(false);
    u.app.inWorld = true;
    u.bus.emit('ui:open', { panel: 'forge' });
    expect(u.d.isOpen('forge')).toBe(true);
  });

  it('Esc закрывает окно и вне мира', () => {
    const u = ui(true);
    u.d.openPanel('inventory');
    u.app.inWorld = false;
    u.key('Escape');
    expect(u.d.isOpen()).toBe(false);
  });
});
