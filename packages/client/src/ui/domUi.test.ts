import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '@dm/shared';
import { DomUi, TOWN_PANELS } from './domUi.js';

const DIR = dirname(fileURLToPath(import.meta.url));

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

  it('⭐ R11-16: галка или ползунок настроек в фокусе — хоткей окна работает; в текстовом поле — нет', () => {
    const u = ui(true);
    const press = (target: unknown): void => { for (const f of keydown) f({ code: 'KeyI', target, preventDefault: () => { } }); };
    press({ tagName: 'INPUT', type: 'checkbox' });
    expect(u.d.isOpen('inventory'), 'было: любой INPUT в фокусе глотал хоткей').toBe(true);
    press({ tagName: 'INPUT', type: 'range' });
    expect(u.d.isOpen('inventory')).toBe(false);
    press({ tagName: 'INPUT', type: 'text' });
    expect(u.d.isOpen('inventory'), '«i», набранная в поле, окна не открывает').toBe(false);
  });

  it('Esc закрывает окно и вне мира', () => {
    const u = ui(true);
    u.d.openPanel('inventory');
    u.app.inWorld = false;
    u.key('Escape');
    expect(u.d.isOpen()).toBe(false);
  });
});

describe('⭐ R7-11: уход из города закрывает окна объектов города', () => {
  /**
   * Хост повёл пати в подземелье (или на арену), пока у кого-то была открыта кузница, лавка или сундук: `areaChanged` окон
   * не закрывал, и каждый клик в них из подземелья получал «Это доступно только в городе» и шёл в телеметрию чита
   * (`dm_cmd_out_of_place_total`), хотя честный клиент таких команд не шлёт. Окна горячих клавиш (инвентарь, скилы,
   * персонаж, квесты, карта забега) работают везде — они остаются.
   */
  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  beforeEach(() => {
    G.document = { createElement: (t: string) => new El(t), body: new El('body') };
    G.window = { addEventListener: () => { } };
  });
  afterEach(() => { delete G.document; delete G.window; });

  const HOTKEY = ['inventory', 'skills', 'character', 'quests', 'runmap'];
  function ui() {
    const bus = new EventBus();
    const d = new DomUi({ bus, inWorld: true } as never, new El('ui-root') as unknown as HTMLElement);
    for (const name of [...TOWN_PANELS, ...HOTKEY]) d.register(name, () => ({ title: name, render: () => { } }));
    for (const name of [...TOWN_PANELS, ...HOTKEY]) d.openPanel(name);
    return { d, bus };
  }

  it('⭐ город → подземелье: лавка, кузница, мастер, сундук и алтарь закрыты; окна горячих клавиш — открыты', () => {
    const u = ui();
    u.bus.emit('area:entered', { area: 'dungeon' });
    for (const name of TOWN_PANELS) expect(u.d.isOpen(name), `${name} закрыто`).toBe(false);
    for (const name of HOTKEY) expect(u.d.isOpen(name), `${name} открыто`).toBe(true);
  });

  it('вход в город окон не трогает', () => {
    const u = ui();
    u.bus.emit('area:entered', { area: 'town' });
    for (const name of [...TOWN_PANELS, ...HOTKEY]) expect(u.d.isOpen(name), name).toBe(true);
  });

  it('окна объектов города — ровно те, что открываются у объектов города обоих клиентов (кроме доски: у квестов хоткей J)', () => {
    expect([...TOWN_PANELS].sort()).toEqual(['difficulty', 'forge', 'master', 'shop', 'stash']);
    for (const f of [join(DIR, '..', 'scenes', 'OnlineScene.ts'), join(DIR, '..', 'render3d', 'online3d.ts')]) {
      const src = readFileSync(f, 'utf8');
      const npcs = [...src.matchAll(/\{ cx: \d+, cy: \d+, label: '[^']+', panel: '(\w+)'/g)].map((m) => m[1]!);
      expect(npcs.length, `${f}: список NPC города найден`).toBeGreaterThan(0);
      for (const p of npcs) if (!HOTKEY.includes(p)) expect(TOWN_PANELS, `${f}: окно NPC «${p}»`).toContain(p);
    }
  });

  it('⭐ оба клиента сообщают об области на каждый вход и не строят «Общий сундук» из декора подземелья', () => {
    for (const f of [join(DIR, '..', 'scenes', 'OnlineScene.ts'), join(DIR, '..', 'render3d', 'online3d.ts')]) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f}: область — в шину`).toMatch(/bus\.emit\('area:entered', \{ area: floor\.area \}\)/);
      expect(src, `${f}: сундук подземелья`).not.toMatch(/label: 'Общий сундук'/);
    }
  });
});
