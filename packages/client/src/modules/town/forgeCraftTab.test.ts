import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ConfigRegistry, craftWeapon, createRng, fullJournal, newBotSave,
  type CraftInput, type Item, type SaveState, type TownCommand,
} from '@dm/shared';
import type { App } from '../../core/app.js';
import { renderCraftTab } from './forgeCraftTab.js';

/**
 * ⭐ R7-22: ОКНО КОВКИ НЕ ПЕРЕЖИВАЕТ СМЕНУ АККАУНТА ИЛИ ГЕРОЯ. Выбор сборки, «Скована: … бросок N %» и скованная вещь живут
 * на уровне модуля — закрыть и открыть кузницу не повод их терять. Но страница без перезагрузки входит другим аккаунтом
 * (R4-22 / R5-17: выход → вход, общий компьютер) — и B, открыв «Ковку», видел строку A: имя его вещи и бросок, и сборку
 * A. Теперь окно помнит, ЧЬЁ оно: другой аккаунт или герой — с чистого листа; тот же — всё как было.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуется окно.
 */
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; disabled = false; title = ''; colSpan = 1;
  parent: El | null = null; isConnected = true;
  private html = '';
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string) { }
  set innerHTML(v: string) { this.children = []; this.html = v; }
  get innerHTML(): string { return this.html; }
  get parentElement(): El | null { return this.parent; }
  get lastChild(): El | null { return this.children[this.children.length - 1] ?? null; }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: (El | string)[]): void { for (const x of c) { if (typeof x === 'string') continue; x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  replaceChildren(...c: El[]): void { this.children = []; this.append(...c); }
  click(): void { for (const f of this.on.get('click') ?? []) f(); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  button(label: string): El | undefined { return this.all().find((e) => e.tag === 'button' && e.textContent.includes(label)); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const rich = (): Record<string, number> => Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 999]));

/** Вошедший игрок: аккаунт, герой и сервер, который куёт тем же ядром и кладёт вещь в сумку. */
function player(userId: string, charId: string) {
  const save: SaveState = newBotSave(reg, 'warrior');
  save.charId = charId;
  save.gold = 9_999_999;
  const journal = fullJournal(reg);
  const app = {
    config: reg, auth: { userId, token: 't', username: userId }, state: { save, area: 'town' },
    stash: { materials: rich(), forgeJournal: journal },
    net: { connected: true },
    bus: { emit: () => { } },
    request: async (c: TownCommand) => {
      if (c.cmd !== 'craft') return { t: 'cmdResult', id: 0, cmd: c.cmd, ok: false, reason: 'n/a' };
      const item: Item = craftWeapon(reg, c.input as CraftInput, { journal, rng: createRng(7) }).item!;
      save.inventory.push(item);
      return { t: 'cmdResult', id: 0, cmd: c.cmd, ok: true, uid: item.uid };
    },
  };
  return app as unknown as App;
}
const message = (body: El): string | undefined => body.all().find((e) => e.textContent.startsWith('Скована:'))?.textContent;
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('⭐ R7-22: окно ковки — чьё оно', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  it('⭐ A сковал и вышел, B вошёл на той же странице — ни строки A, ни его сборки; тот же A — всё на месте', async () => {
    const a = player('user-A', 'hero-A');
    const bodyA = new El('div');
    renderCraftTab(a, bodyA as unknown as HTMLElement);
    const startB = new El('div');
    bodyA.button('Топор')?.click();                     // A выбрал топор
    bodyA.all().find((e) => e.tag === 'button' && e.textContent.includes('Ковать'))!.click();
    await flush();
    const again = new El('div');
    renderCraftTab(a, again as unknown as HTMLElement);  // закрыл и открыл кузницу — выбор и итог на месте
    const aMsg = message(again);
    expect(aMsg, 'A видит свою ковку').toBeTruthy();

    const b = player('user-B', 'hero-B');
    renderCraftTab(b, startB as unknown as HTMLElement);
    expect(message(startB), 'было: B видел «Скована: …» аккаунта A').toBeUndefined();
    const fresh = new El('div');
    renderCraftTab(player('user-C', 'hero-C'), fresh as unknown as HTMLElement);
    /** Кнопки окна с их видом (выбранный чип подсвечен) — по ним видно, какая сборка выбрана. */
    const look = (body: El): string[] => body.all().filter((e) => e.tag === 'button')
      .map((e) => `${e.textContent}|${e.style.cssText ?? ''}|${e.disabled}`);
    expect(look(again), 'сторож: сборка A (топор) видна по кнопкам').not.toEqual(look(fresh));
    expect(look(startB), 'сборка B — с чистого листа, как у нового игрока').toEqual(look(fresh));
  });

  it('тот же аккаунт, другой герой — тоже с чистого листа: скованное прежним героем — не его', async () => {
    const a1 = player('user-A', 'hero-1');
    const body1 = new El('div');
    renderCraftTab(a1, body1 as unknown as HTMLElement);
    body1.all().find((e) => e.tag === 'button' && e.textContent.includes('Ковать'))!.click();
    await flush();
    const re = new El('div');
    renderCraftTab(a1, re as unknown as HTMLElement);
    expect(message(re)).toBeTruthy();
    const a2 = player('user-A', 'hero-2');
    const body2 = new El('div');
    renderCraftTab(a2, body2 as unknown as HTMLElement);
    expect(message(body2)).toBeUndefined();
  });
});
