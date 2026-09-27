import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigRegistry, newBotSave, parseTownCommand, skillRespecFee, type SaveState, type TownCommand } from '@dm/shared';
import type { App } from '../../core/app.js';
import { dismissAsk } from '../../ui/kit.js';
import { activeTreeFor } from '../skills-active/allocate.js';
import { renderSkillTree } from './skillTreeView.js';

/**
 * ⭐ R7-12: «СБРОСИТЬ СКИЛЛЫ» В ПОДЗЕМЕЛЬЕ — ВОПРОС В ИГРЕ, А НЕ `window.confirm`. Окно скилов (K) открывается везде, и
 * `respecSkills` сервер исполняет везде. `window.confirm` замораживает страницу: через 10 тиков без ввода сервер
 * останавливает героя, а монстры бьют, пока игрок читает вопрос (правило R1-14, `askInGame`). В городе — как было.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуются окно и вопрос.
 */
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; innerHTML = ''; disabled = false; parent: El | null = null;
  clientWidth = 0; clientHeight = 0;
  attrs: Record<string, string> = {};
  private on = new Map<string, ((e: unknown) => void)[]>();
  constructor(public tag: string) { }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  addEventListener(t: string, f: (e: unknown) => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  click(): void { for (const f of this.on.get('click') ?? []) f({ stopPropagation() { }, preventDefault() { } }); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  text(): string { return [this.textContent, ...this.all().map((c) => c.textContent)].join(' | '); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

describe('⭐ R7-12: сброс скилов вне города', () => {
  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  let body: El;
  beforeEach(() => {
    body = new El('body');
    G.document = { createElement: (t: string) => new El(t), createElementNS: (_ns: string, t: string) => new El(t), body };
    G.window = { addEventListener() { }, confirm: () => { throw new Error('window.confirm в подземелье замораживает игру'); } };
  });
  afterEach(() => { dismissAsk(); delete G.document; delete G.window; });

  /** Герой с вложенным скиллом, золота хватает; окно скилов нарисовано; кнопка сброса. */
  function open(area: 'town' | 'dungeon') {
    const save: SaveState = newBotSave(reg, 'warrior');
    save.skills[activeTreeFor(reg).entryNodes[0]!] = 1;
    save.gold = 1_000_000;
    const sent: TownCommand[] = [];
    const logs: string[] = [];
    const app = {
      config: reg, state: { save, area },
      sendCmd: (c: TownCommand) => { sent.push(c); return sent.length; },
      bus: { emit: (_t: string, e: { text: string }) => { logs.push(e.text); } },
    } as unknown as App;
    const panel = new El('div');
    renderSkillTree(app, panel as unknown as HTMLElement);
    const reset = panel.all().find((e) => e.tag === 'button' && e.textContent.startsWith('Сбросить скиллы'))!;
    return { save, sent, logs, reset, fee: skillRespecFee(reg, save) };
  }
  /** Открытый вопрос в игре и его кнопки «да»/«нет». */
  const asked = (): { box: El; yes: El; no: El } | null => {
    const box = body.children.at(-1);
    if (!box) return null;
    const btns = box.all().filter((e) => e.tag === 'button');
    return { box, yes: btns[0]!, no: btns[1]! };
  };
  const tick = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('⭐ в подземелье: клик не зовёт window.confirm — вопрос плашкой; «да» → сброс с комиссией из вопроса', async () => {
    const o = open('dungeon');
    expect(o.reset.disabled).toBe(false);
    o.reset.click();                                   // window.confirm здесь бросил бы
    await tick();
    expect(asked()?.box.text()).toContain(`комиссия ${o.fee} зол.`);
    expect(o.sent, 'пока вопрос висит, команды нет').toEqual([]);
    asked()!.yes.click();
    await tick();
    expect(o.sent).toEqual([{ cmd: 'respecSkills', maxGold: o.fee }]);
    expect(parseTownCommand(o.sent[0]).ok).toBe(true);
    expect(body.children, 'ответили — плашка снята').toHaveLength(0);
  });

  it('«нет» и снятый игрой вопрос (`dismissAsk`) — ничего; пока висел вопрос, скилы уже сброшены — «да» ничего не шлёт', async () => {
    const no = open('dungeon');
    no.reset.click();
    await tick();
    asked()!.no.click();
    await tick();
    expect(no.sent).toEqual([]);

    const gone = open('dungeon');
    gone.reset.click();
    await tick();
    dismissAsk();                                      // смена области / потеря связи
    await tick();
    expect(gone.sent).toEqual([]);
    expect(gone.logs, 'вопрос снят игрой — лог молчит').toEqual([]);

    const moved = open('dungeon');
    moved.reset.click();
    await tick();
    moved.save.skills = {};                            // сброс уже прошёл (второе окно, клиент Unity)
    asked()!.yes.click();
    await tick();
    expect(moved.sent).toEqual([]);
    expect(moved.logs).toEqual([expect.stringMatching(/^Сброс отменён: /)]);
  });

  it('в городе — как было: `window.confirm`, и «да» шлёт сразу', async () => {
    let q = '';
    G.window = { addEventListener() { }, confirm: (m: string) => { q = m; return true; } };
    const o = open('town');
    o.reset.click();
    await tick();
    expect(q).toContain('Сбросить ВСЕ скиллы?');
    expect(body.children, 'в городе плашки нет').toHaveLength(0);
    expect(o.sent).toEqual([{ cmd: 'respecSkills', maxGold: o.fee }]);
  });
});
