import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigRegistry, newBotSave, type TownCommand } from '@dm/shared';
import type { CmdReply } from '../../net/cmdReplies.js';
import { forgePanel } from './forgePanel.js';

/**
 * ⭐ R2-34: СУНДУК КУЗНИЦЫ ЗАПРАШИВАЕТСЯ С ОЖИДАНИЕМ ОТВЕТА. Журнал и кошелёк кузнеца приходят кадром `stash`; кузница
 * просила его командой «в пустоту», и если сервер не прочёл сундук (база упала и на входе, и сейчас), кадра не было
 * вовсе: вкладка «⚒ Ковка» вечно «листала журнал», верстак считал сырьё сундука нулём — до переоткрытия окна.
 * Теперь отказ или тишина — «Сундук не загрузился» с кнопкой повтора.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуется окно.
 */

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
/** Конфиг с открытой ковкой (`balance.craft.live`): иначе вкладка честно пишет «Кузнец ещё не куёт» и журнала не ждёт. */
const liveReg = {
  get: (k: string) => {
    if (k !== 'balance') return base.get(k as 'balance');
    const b = base.get('balance');
    return { ...b, craft: { ...b.craft, live: true } };
  },
} as unknown as ConfigRegistry;

type Reply = CmdReply | null;
function fakeForge(config: ConfigRegistry = liveReg) {
  const requests: TownCommand[] = [];
  const fired: TownCommand[] = [];
  const pending: ((r: Reply) => void)[] = [];
  let redraws = 0;
  const app = {
    config,
    state: { save: newBotSave(base, base.get('classes')[0]!.id) },
    stash: null as unknown,
    shopStock: [],
    request: (c: TownCommand) => { requests.push(c); return new Promise<Reply>((res) => { pending.push(res); }); },
    sendCmd: (c: TownCommand) => { fired.push(c); return 1; },
    bus: { emit: (t: string) => { if (t === 'state:changed') redraws++; } },
  };
  const ui = { openPanel: () => {} };
  const panel = forgePanel(app as never, ui as never);
  const body = new El('div');
  return {
    app, requests, fired, body, redraws: () => redraws,
    render: () => panel.render(body as unknown as HTMLElement),
    reply: async (r: Reply) => { pending.shift()!(r); await Promise.resolve(); await Promise.resolve(); },
  };
}
const fail = (reason = 'Ошибка сервера'): CmdReply => ({ t: 'cmdResult', id: 1, cmd: 'stashOpen', ok: false, reason });

describe('⭐ R2-34: кузница ждёт ответа на запрос сундука', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  it('запрос сундука — с ожиданием ответа (`request`), а не в пустоту', () => {
    const f = fakeForge();
    expect(f.requests).toEqual([{ cmd: 'stashOpen' }]);
    expect(f.fired.filter((c) => c.cmd === 'stashOpen')).toEqual([]);
  });

  it('⭐ отказ сервера — вкладка «Ковка» говорит «не загрузился» и даёт повтор, а не «листает журнал» вечно', async () => {
    const f = fakeForge();
    f.render();
    f.body.button('Ковка')!.click();
    expect(f.body.text(), 'пока ответа нет — ждём').toContain('листает журнал');
    await f.reply(fail());
    expect(f.redraws(), 'ответ перерисовывает окно').toBeGreaterThan(0);
    f.render();
    expect(f.body.text()).not.toContain('листает журнал');
    expect(f.body.text()).toContain('не загрузился');
    const retry = f.body.button('Повторить');
    expect(retry, 'кнопка повтора').toBeDefined();
    retry!.click();
    expect(f.requests).toEqual([{ cmd: 'stashOpen' }, { cmd: 'stashOpen' }]);
    f.render();
    expect(f.body.text(), 'повтор в полёте — снова ждём').toContain('листает журнал');
  });

  it('тишина (нет ответа за 8 с) — то же, что отказ; верстак тоже предупреждает, что сырьё сундука не учтено', async () => {
    const f = fakeForge();
    await f.reply(null);
    f.render();
    expect(f.body.text()).toContain('не загрузился');
    expect(f.body.button('Повторить')).toBeDefined();
  });

  it('сундук уже есть (пришёл на входе) — отказ повторного запроса окна не портит', async () => {
    const f = fakeForge();
    f.app.stash = { tabs: [], cols: 20, rows: 12, tabCount: 2, materials: { 'iron-1': 5 }, forgeJournal: undefined };
    await f.reply(fail());
    f.render();
    expect(f.body.text()).not.toContain('не загрузился');
  });
});

/**
 * ⭐ Ковка открыта В ДАННЫХ (`balance.craft.live` = true, решение владельца 26.09). Вкладка «Ковка» с конфигом «как в
 * игре» обязана ждать журнал и открывать окно, а не писать «Кузнец ещё не куёт»; закрытое поведение — только с флагом,
 * снятым явно.
 */
describe('⭐ вкладка «Ковка» при открытой ковке в данных', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });
  const closedReg = {
    get: (k: string) => {
      if (k !== 'balance') return base.get(k as 'balance');
      const b = base.get('balance');
      return { ...b, craft: { ...b.craft, live: false } };
    },
  } as unknown as ConfigRegistry;

  it('конфиг «как в игре»: не «ещё не куёт», а журнал — и с журналом окно ковки грузится', () => {
    expect(base.get('balance').craft.live, 'balance.craft.live в data/balance.json').toBe(true);
    const f = fakeForge(base);
    f.render();
    f.body.button('Ковка')!.click();
    expect(f.body.text()).not.toContain('ещё не куёт');
    expect(f.body.text(), 'ждём журнал из кадра сундука').toContain('листает журнал');
    f.app.stash = { tabs: [], cols: 20, rows: 12, tabCount: 2, materials: {}, forgeJournal: { bases: [], variants: [], tierHi: 0, mythic: 0 } };
    f.render();
    expect(f.body.text()).not.toContain('листает журнал');
    expect(f.body.text()).not.toContain('ещё не куёт');
  });

  it('флаг снят явно — честно «Кузнец ещё не куёт», журнал не ждём', () => {
    const f = fakeForge(closedReg);
    f.render();
    f.body.button('Ковка')!.click();
    expect(f.body.text()).toContain('Кузнец ещё не куёт');
    expect(f.body.text()).not.toContain('листает журнал');
  });
});

/**
 * ⭐ ВКЛАДКА «⇄ ОБМЕН» (06.10): стопка → семья → «⇄ Обменять» уходит командой `forgeExchange` с согласием карточки и ЖДЁТ ответа; пока
 * ждёт — кнопка «⏳», ответ — строкой над вкладкой (итог сервера).
 */
describe('⭐ вкладка «⇄ Обмен» кузницы', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  it('выбор стопки и семьи → команда с согласием, ожидание ответа, итог строкой', async () => {
    const f = fakeForge(base);
    const app = f.app as unknown as { net: { connected: boolean }; nextCmdId: () => number; stash: unknown; state: { save: { gold: number } } };
    app.net = { connected: true };
    app.nextCmdId = () => 77;
    app.stash = { tabs: [], cols: 20, rows: 12, tabCount: 2, materials: { 'iron-3': 12 }, forgeJournal: undefined };
    app.state.save.gold = 1000;
    f.render();
    f.body.button('Обмен')!.click();
    expect(f.body.text()).toContain('Курс: 3 → 2');
    const chip = (s: string): El => f.body.all().find((e) => e.tag === 'div' && e.textContent.startsWith(s))!;
    chip(`${base.get('craft-materials').find((m) => m.id === 'iron-3')!.name} ×12`).click();
    f.render();
    chip('Дерево:').click();
    f.render();
    expect(f.body.text()).toContain('Получишь:');
    f.body.button('Обменять')!.click();
    const sent = f.requests.find((c) => c.cmd === 'forgeExchange');
    expect(sent).toEqual({ cmd: 'forgeExchange', from: 'iron-3', to: 'wood', n: 3, maxGold: 60, maxMaterials: { 'iron-3': 3 }, minYield: { 'wood-3': 2 } });
    f.render();
    expect(f.body.button('Кузнец меняет'), 'в полёте — «⏳»').toBeDefined();
    // Первая ожидающая — запрос сундука на открытии; вторая — обмен.
    await f.reply(null);
    await f.reply({ t: 'cmdResult', id: 77, cmd: 'forgeExchange', ok: true, summary: 'Обмен: отдано … → получено …' });
    f.render();
    expect(f.body.text()).toContain('⇄ Обмен: отдано');
    expect(f.body.button('Обменять'), 'кнопка снова живая').toBeDefined();
  });
});
