import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigRegistry, newBotSave } from '@dm/shared';
import { forgePanel } from './forgePanel.js';
import { onStaleBuild } from '../../net/staleBuild.js';

/**
 * ⭐ R10-12: ОКНО КОВКИ ПОСЛЕ ДЕПЛОЯ — «ПЕРЕЗАГРУЗИТЕ», А НЕ «ПЕРЕКЛЮЧИ ВКЛАДКУ».
 *
 * Окно ковки — ленивый кусок сборки (`forgeCraftTab-<хэш>.js`). Деплой очищает `dist` и меняет хэши, а вкладка его
 * переживает без перезагрузки (L2) при прежнем `PROTOCOL_VERSION`: `import()` просит файл, которого больше нет. Раньше
 * вкладка писала «Нет связи с сервером игры? Переключи вкладку…», и каждый повтор падал снова — сказать «F5» было некому.
 * Теперь упавший кусок — «код вкладки устарел»: кнопка перезагрузки, строка игроку один раз на страницу
 * (`markStaleBuild` → `App` → лог), и без нового запроса на каждую перерисовку.
 *
 * Кусок «не грузится» — `vi.mock` с броском: так `import()` отказывает, как в браузере на 404.
 */
const loads = vi.hoisted(() => ({ n: 0 }));
vi.mock('./forgeCraftTab.js', () => {
  loads.n++;
  throw new TypeError('Failed to fetch dynamically imported module: https://game.example/assets/forgeCraftTab-KtW2feJZ.js');
});

class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; disabled = false; parent: El | null = null;
  private html = '';
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string) { }
  set innerHTML(v: string) { this.children = []; this.html = v; }
  get innerHTML(): string { return this.html; }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: (El | string)[]): void { for (const x of c) { if (typeof x === 'string') continue; x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  click(): void { for (const f of this.on.get('click') ?? []) f(); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  text(): string { return [this.html, this.textContent, ...this.all().map((c) => `${c.html} ${c.textContent}`)].join(' | '); }
  button(label: string): El | undefined { return this.all().find((e) => e.tag === 'button' && e.textContent.includes(label)); }
}

const base = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
/**
 * Дождаться, что загрузка куска кончилась (окно зовёт перерисовку в `finally`). ⚠ Не числом тиков: `import()` в vitest
 * идёт через раннер модулей, и под нагрузкой полного прогона его отказ приходит позже любых «пяти тиков».
 */
const loaded = (redraws: () => number, before: number): Promise<void> =>
  vi.waitFor(() => { if (redraws() <= before) throw new Error('кусок ещё грузится'); }, { timeout: 15_000, interval: 5 });

/** Кузница с открытой ковкой и уже пришедшим журналом: вкладке «Ковка» остаётся только загрузить своё окно. */
function fakeForge() {
  let redraws = 0;
  const app = {
    config: base,
    state: { save: newBotSave(base, base.get('classes')[0]!.id) },
    stash: { tabs: [], cols: 20, rows: 12, tabCount: 2, materials: {}, forgeJournal: { bases: [], variants: [], tierHi: 0, mythic: 0 } },
    shopStock: [],
    request: () => new Promise(() => { }),
    sendCmd: () => 1,
    bus: { emit: (t: string) => { if (t === 'state:changed') redraws++; } },
  };
  const panel = forgePanel(app as never, { openPanel: () => { } } as never);
  const body = new El('div');
  return { body, redraws: () => redraws, render: () => panel.render(body as unknown as HTMLElement) };
}

describe('⭐ R10-12: окно ковки не загрузилось (деплой сменил хэши кусков) — перезагрузка, а не «переключи вкладку»', () => {
  const G = globalThis as unknown as { document?: unknown; location?: unknown };
  let savedLoc: unknown;
  const reload = vi.fn();
  beforeEach(() => {
    savedLoc = G.location;
    G.document = { createElement: (t: string) => new El(t), body: new El('body') };
    G.location = { reload };
    vi.spyOn(console, 'warn').mockImplementation(() => { });
  });
  afterEach(() => { delete G.document; G.location = savedLoc; vi.restoreAllMocks(); });

  // Потолок 30 с: ожидание отказа `import()` (`loaded`) под нагрузкой полного прогона — не про логику.
  it('⭐ упавший кусок — «перезагрузите (F5)» с кнопкой; перерисовки не просят кусок заново; игроку — один раз', async () => {
    const said: number[] = [];
    onStaleBuild(() => said.push(1));
    expect(base.get('balance').craft.live, 'ковка открыта в данных').toBe(true);
    const f = fakeForge();
    f.render();
    f.body.button('Ковка')!.click();
    expect(f.body.text()).toContain('раскладывает инструмент');
    await loaded(f.redraws, 0);
    expect(loads.n, 'кусок просили').toBeGreaterThan(0);
    const asked = loads.n;

    // Окно перерисовывается на каждое `state:changed` (каждая подобранная монета) — и каждый раз то же: перезагрузка.
    for (let i = 0; i < 3; i++) {
      f.render();
      f.body.button('Ковка')!.click();
      await flush();
      const t = f.body.text();
      expect(t, 'было: «Нет связи… Переключи вкладку»').not.toContain('Переключи вкладку');
      expect(t).not.toContain('раскладывает инструмент');
      expect(t).toContain('F5');
      expect(f.body.button('Перезагрузить'), 'кнопка перезагрузки').toBeDefined();
    }
    expect(loads.n, 'без клика игрока кусок заново не просим — ни на перерисовке, ни на смене вкладки').toBe(asked);
    expect(said, 'игроку сказано один раз на страницу').toEqual([1]);

    f.body.button('Перезагрузить')!.click();
    expect(reload).toHaveBeenCalledTimes(1);

    // «Повторить» — новая попытка (мигнула связь, а браузер неудачу не запомнил); не вышло — снова «перезагрузите».
    const before = f.redraws();
    f.body.button('Повторить')!.click();
    expect(f.body.text()).toContain('раскладывает инструмент');
    await loaded(f.redraws, before);
    f.render();
    f.body.button('Ковка')!.click();
    expect(f.body.text()).toContain('F5');
    expect(said, 'повторный сбой второй строки не даёт').toEqual([1]);
  }, 30_000);
});
