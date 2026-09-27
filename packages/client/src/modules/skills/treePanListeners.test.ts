import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigRegistry, newBotSave } from '@dm/shared';
import type { App } from '../../core/app.js';
import { renderSkillTree } from './skillTreeView.js';
import { renderPassiveTree } from '../skills-passive/treeView.js';

/**
 * ⭐ R12-10: ПАН ДРЕВА НЕ ВЕШАЕТ СЛУШАТЕЛЬ НА `window` ЗА КАЖДУЮ ОТРИСОВКУ. Древо скилов (K — открывается и в подземелье) и
 * древо мастерства перерисовываются на каждое `state:changed` / `gold:changed` (`DomUi.refresh`): каждый убитый монстр (xp →
 * сейв) и каждая монета. Каждая отрисовка вешала `window.addEventListener('pointerup', …)` и не снимала его никогда — замыкание
 * держало `wrap` своей отрисовки, то есть всё отсоединённое SVG-древо (сотни узлов с подсказками); за бой копились сотни древ,
 * и каждое отпускание мыши гоняло сотни мёртвых обработчиков. Теперь «отпустил» слушается только НА ВРЕМЯ перетаскивания:
 * вешается на `pointerdown`, снимается на `pointerup`/`pointercancel` (как `ui/graphKit.ts`).
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно того, чем пользуются окна; `window` — модель браузера:
 * тот же обработчик того же типа второй раз не добавляется.
 */
type Handler = (e: unknown) => void;
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; innerHTML = ''; disabled = false; parent: El | null = null;
  clientWidth = 0; clientHeight = 0;
  attrs: Record<string, string> = {};
  private on = new Map<string, Handler[]>();
  constructor(public tag: string) { }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  addEventListener(t: string, f: Handler): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  removeEventListener(t: string, f: Handler): void { this.on.set(t, (this.on.get(t) ?? []).filter((x) => x !== f)); }
  append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 760, height: 640, right: 760, bottom: 640 }; }
  fire(t: string, e: unknown): void { for (const f of this.on.get(t) ?? []) f(e); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

describe('⭐ R12-10: пан древа скилов и мастерства — без слушателя на window за каждую отрисовку', () => {
  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  /** Живые слушатели `window` (тип + обработчик), как их держит браузер. */
  let live: { type: string; fn: Handler }[] = [];
  const count = (type: string): number => live.filter((l) => l.type === type).length;
  const fireWindow = (type: string): void => { for (const l of live.filter((x) => x.type === type)) l.fn({ clientX: 0, clientY: 0, pointerId: 1 }); };
  beforeEach(() => {
    live = [];
    G.document = { createElement: (t: string) => new El(t), createElementNS: (_ns: string, t: string) => new El(t), createTextNode: (s: string) => new El(s), body: new El('body') };
    G.window = {
      addEventListener: (type: string, fn: Handler) => { if (!live.some((l) => l.type === type && l.fn === fn)) live.push({ type, fn }); },
      removeEventListener: (type: string, fn: Handler) => { live = live.filter((l) => !(l.type === type && l.fn === fn)); },
      confirm: () => false,
    };
  });
  afterEach(() => { delete G.document; delete G.window; });

  const app = (): App => ({
    config: reg, state: { save: newBotSave(reg, 'warrior'), area: 'dungeon' },
    bus: { emit() { } }, sendCmd: () => 0, request: async () => null,
  }) as unknown as App;
  const TREES: [string, (a: App, b: HTMLElement) => void][] = [['древо скилов (K)', renderSkillTree], ['древо мастерства', renderPassiveTree]];

  /** Отрисовать окно; вернуть холст пана (`wrap`) и узел, который он двигает (`g` с `transform`). */
  function draw(render: (a: App, b: HTMLElement) => void, a: App): { wrap: El; g: El } {
    const body = new El('div');
    render(a, body as unknown as HTMLElement);
    const wrap = body.all().find((e) => (e.style.cssText ?? '').includes('cursor:grab'))!;
    const g = wrap.all().find((e) => e.tag === 'g' && 'transform' in e.attrs)!;
    return { wrap, g };
  }

  it('⭐ 50 перерисовок каждого древа (бой с открытым K, клики в мастерстве) — ни одного слушателя pointerup на window', () => {
    const a = app();
    for (let i = 0; i < 50; i++) renderPassiveTree(a, new El('div') as unknown as HTMLElement);
    expect(count('pointerup'), 'было: 50 — по слушателю на каждую отрисовку, навсегда').toBe(0);
    for (let i = 0; i < 50; i++) renderSkillTree(a, new El('div') as unknown as HTMLElement);
    expect(count('pointerup'), 'было: 100').toBe(0);
    expect(live, 'на window не висит ничего').toEqual([]);
  });

  for (const [name, render] of TREES) {
    it(`${name}: перетаскивание двигает древо и заканчивается отпусканием где угодно; слушатель — только на время перетаскивания`, () => {
      const { wrap, g } = draw(render, app());
      const t0 = g.attrs.transform;
      wrap.fire('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
      expect(wrap.style.cursor).toBe('grabbing');
      expect(count('pointerup'), 'пока тянут — слушают отпускание').toBe(1);
      wrap.fire('pointerdown', { clientX: 10, clientY: 10, pointerId: 2 });   // второй палец / повтор — не второй слушатель
      expect(count('pointerup')).toBe(1);
      wrap.fire('pointermove', { clientX: 60, clientY: 40 });
      const t1 = g.attrs.transform;
      expect(t1, 'пан двигает древо').not.toBe(t0);
      fireWindow('pointerup');   // отпустили хоть за окном
      expect(wrap.style.cursor).toBe('grab');
      expect([count('pointerup'), count('pointercancel')], 'было: pointerup висел навсегда').toEqual([0, 0]);
      wrap.fire('pointermove', { clientX: 200, clientY: 200 });
      expect(g.attrs.transform, 'отпустили — древо больше не тянется').toBe(t1);
    });

    it(`${name}: отмена указателя (pointercancel) тоже заканчивает перетаскивание и снимает слушатели`, () => {
      const { wrap, g } = draw(render, app());
      wrap.fire('pointerdown', { clientX: 0, clientY: 0, pointerId: 1 });
      fireWindow('pointercancel');
      expect([count('pointerup'), count('pointercancel')]).toEqual([0, 0]);
      const t = g.attrs.transform;
      wrap.fire('pointermove', { clientX: 90, clientY: 90 });
      expect(g.attrs.transform).toBe(t);
      expect(wrap.style.cursor).toBe('grab');
    });

    it(`${name}: перерисовка посреди перетаскивания (монета, убийство) — старый слушатель уходит с отпусканием`, () => {
      const a = app();
      const { wrap } = draw(render, a);
      wrap.fire('pointerdown', { clientX: 0, clientY: 0, pointerId: 1 });
      for (let i = 0; i < 10; i++) draw(render, a);
      expect(count('pointerup')).toBe(1);
      fireWindow('pointerup');
      expect(live).toEqual([]);
    });
  }
});
