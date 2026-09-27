import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigRegistry, acceptQuest, newBotSave, parseTownCommand, trackObjective, type QuestDef, type SaveState, type TownCommand } from '@dm/shared';
import type { App } from '../../core/app.js';
import { dismissAsk } from '../../ui/kit.js';
import { takeQuest } from './questLogPanel.js';

/**
 * ⚠ R6-13: «Взять» зачистку, когда своя зачистка уже на 11 из 12. Сервер R5-20 молча стирал начатое; теперь он начатое не
 * трогает без согласия (`replace`), а клиент спрашивает — и шлёт согласие только после «да».
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const cull = (id: string, target: string, amount: number): QuestDef => ({
  id, name: `Уничтожить ${amount} (${target})`, description: '', objectives: [{ id: 'o1', type: 'kill', target, amount }], reward: { gold: 10 },
});
const A = cull('rnd_rnd-cull_aaa0', 'zombie-archer', 12);
const B = cull('rnd_rnd-cull_bbb0', 'zombie', 5);

function fake(save: SaveState, area: 'town' | 'dungeon' = 'town') {
  const sent: TownCommand[] = [];
  const logs: string[] = [];
  const app = {
    state: { save, area }, questBoard: [B],
    sendCmd: (c: TownCommand) => { sent.push(c); return sent.length; },
    bus: { emit: (_t: string, e: { text: string }) => { logs.push(e.text); } },
  } as unknown as App;
  return { app, sent, logs };
}
/** Сейв с начатым A (11 из 12) — «Взять» B того же вида спрашивает. */
function rivalSave(): SaveState {
  const save = newBotSave(reg, 'warrior');
  expect(acceptQuest(save, A).ok).toBe(true);
  for (let i = 0; i < 11; i++) trackObjective(save, 'kill', 'zombie-archer');
  return save;
}

describe('⚠ R6-13: «Взять» при начатом задании того же вида', () => {
  const G = globalThis as unknown as { window?: unknown };
  afterEach(() => { delete G.window; });

  it('⭐ начатое есть: спросить; «нет» — ничего не ушло; «да» — ушло с согласием, и провод его пропускает', async () => {
    const { app, sent } = fake(rivalSave());
    const asked: string[] = [];
    G.window = { confirm: (t: string) => { asked.push(t); return false; } };
    await takeQuest(app, B);
    expect(sent, 'отказался — команды нет').toEqual([]);
    expect(asked[0]).toContain('11/12');
    G.window = { confirm: () => true };
    await takeQuest(app, B);
    expect(sent).toEqual([{ cmd: 'acceptQuest', questId: B.id, replace: true }]);
    expect(parseTownCommand(sent[0]).ok).toBe(true);
  });

  it('начатого нет — без вопроса и без флага (как было)', async () => {
    const save = newBotSave(reg, 'warrior');
    expect(acceptQuest(save, A).ok).toBe(true);   // принято, но ни одного убийства
    const { app, sent } = fake(save);
    let asked = 0;
    G.window = { confirm: () => { asked++; return true; } };
    await takeQuest(app, B);
    expect(asked).toBe(0);
    expect(sent).toEqual([{ cmd: 'acceptQuest', questId: B.id }]);
  });
});

/**
 * ⭐ R7-12: ВНЕ ГОРОДА ВОПРОС — В ИГРЕ, А НЕ `window.confirm`. Журнал (J) открывается и в подземелье, доска там жива (кадр
 * `questBoard` приходит и входящему в подземелье по коду), а `acceptQuest` сервер исполняет везде. `window.confirm` замораживает
 * страницу: через 10 тиков без ввода сервер останавливает героя, а монстры бьют — ни рывка, ни зелья, пока игрок читает
 * вопрос (правило R1-14, `askInGame`). Пока висит вопрос в игре, игра идёт — после «да» перепроверка, что спрашивали о том же.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуется вопрос.
 */
describe('⭐ R7-12: «Взять» в подземелье — вопрос в игре', () => {
  class El {
    children: El[] = []; style: Record<string, string> = {}; textContent = ''; disabled = false; parent: El | null = null;
    private on = new Map<string, (() => void)[]>();
    constructor(public tag: string) { }
    addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
    append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
    appendChild(c: El): El { this.append(c); return c; }
    remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
    click(): void { for (const f of this.on.get('click') ?? []) f(); }
    all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
    text(): string { return [this.textContent, ...this.all().map((c) => c.textContent)].join(' | '); }
  }
  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  let body: El;
  beforeEach(() => {
    body = new El('body');
    G.document = { createElement: (t: string) => new El(t), body };
    G.window = { confirm: () => { throw new Error('window.confirm в подземелье замораживает игру'); } };
  });
  afterEach(() => { dismissAsk(); delete G.document; delete G.window; });
  /** Открытый вопрос и его кнопки «да»/«нет». */
  const asked = (): { box: El; yes: El; no: El } | null => {
    const box = body.children.at(-1);
    if (!box) return null;
    const btns = box.all().filter((e) => e.tag === 'button');
    return { box, yes: btns[0]!, no: btns[1]! };
  };

  it('⭐ спрашивает переданный вопрос-промис, не window.confirm; команда — только после «да», «нет» — ничего', async () => {
    const { app, sent } = fake(rivalSave(), 'dungeon');
    const q: string[] = [];
    let answer!: (yes: boolean) => void;
    const ask = (m: string): Promise<boolean> => { q.push(m); return new Promise((res) => { answer = res; }); };
    const p = takeQuest(app, B, ask);
    expect(q[0], 'спросил в игре').toContain('11/12');
    expect(sent, 'пока вопрос висит, команды нет').toEqual([]);
    answer(true);
    await expect(p).resolves.toBe(true);
    expect(sent).toEqual([{ cmd: 'acceptQuest', questId: B.id, replace: true }]);

    const no = fake(rivalSave(), 'dungeon');
    const p2 = takeQuest(no.app, B, () => Promise.resolve(false));
    await expect(p2).resolves.toBe(false);
    expect(no.sent).toEqual([]);
  });

  it('⭐ по умолчанию — плашка в игре (`askInGame`); смена области снимает вопрос (`dismissAsk`) — «нет», лог молчит', async () => {
    const f = fake(rivalSave(), 'dungeon');
    const p = takeQuest(f.app, B);   // window.confirm здесь бросил бы
    await Promise.resolve();
    expect(asked()?.box.text()).toContain('11/12');
    asked()!.yes.click();
    await expect(p).resolves.toBe(true);
    expect(f.sent).toEqual([{ cmd: 'acceptQuest', questId: B.id, replace: true }]);
    expect(body.children, 'ответили — плашка снята').toHaveLength(0);

    const d = fake(rivalSave(), 'dungeon');
    const p2 = takeQuest(d.app, B);
    await Promise.resolve();
    dismissAsk();                                      // пати ушла в город, герой умер, связь потеряна
    await expect(p2).resolves.toBe(false);
    expect(d.sent).toEqual([]);
    expect(d.logs).toEqual([]);
  });

  it('пока висел вопрос, игра шла: доска обновилась или прежнее задание сменилось — «да» ничего не шлёт, строка в логе', async () => {
    const gone = fake(rivalSave(), 'dungeon');
    let yes!: (v: boolean) => void;
    const p1 = takeQuest(gone.app, B, () => new Promise((r) => { yes = r; }));
    (gone.app as unknown as { questBoard: QuestDef[] }).questBoard = [];   // новая доска без B
    yes(true);
    await expect(p1).resolves.toBe(false);
    expect(gone.sent).toEqual([]);
    expect(gone.logs).toEqual([expect.stringMatching(/^Задание не взято: /)]);

    const done = fake(rivalSave(), 'dungeon');
    const p2 = takeQuest(done.app, B, () => new Promise((r) => { yes = r; }));
    trackObjective(done.app.state!.save, 'kill', 'zombie-archer');         // прежнее выполнено — о нём спрашивали зря
    yes(true);
    await expect(p2).resolves.toBe(false);
    expect(done.sent).toEqual([]);
    expect(done.logs).toEqual([expect.stringMatching(/^Задание не взято: /)]);
  });
});
