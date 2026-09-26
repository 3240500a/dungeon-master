import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ConfigRegistry, craftAction, createRng, defaultParts, emptyStash, enchantCost, forgeGold, fullJournal, newBotSave,
  type Item, type SaveState, type TownCommand,
} from '@dm/shared';
import type { CmdReply } from '../../net/cmdReplies.js';
import { forgeBench } from './forgeBench.js';

/**
 * ВЕРСТАК КУЗНИЦЫ ГЛАЗАМИ ИГРОКА (DOM-заглушка, тесты идут в node):
 * - ⭐ R3-16: действие в полёте гасит все карточки — двойной клик по «Реролл» уходил двумя платными командами (двойная
 *   цена, две из трёх перекаток, первый итог не виден); отказ сервера («Слишком часто») виден строкой над верстаком.
 * - ⭐ R3-09: у скованной вещи на верстаке есть зачарование — не только в окне ковки сразу после ковки.
 */
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; parent: El | null = null;
  private html = '';
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string) { }
  set innerHTML(v: string) { this.children = []; this.html = v; }
  get innerHTML(): string { return this.html; }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: (El | string)[]): void { for (const x of c) { if (typeof x === 'string') continue; x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  click(): void { for (const f of this.on.get('click') ?? []) f(); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  text(): string { return [this.html, this.textContent, ...this.all().map((c) => `${c.html} ${c.textContent}`)].join(' | '); }
  /** Карточка действия по заголовку (первая строка карточки). */
  card(title: string): El | undefined { return this.all().find((e) => e.tag === 'div' && e.children[0]?.textContent.includes(title)); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
/**
 * Реестры с ковкой открытой и закрытой (`balance.craft.live`) — ЯВНО: с 26.09 в данных она открыта (решение владельца),
 * а закрытое поведение (зачарование без неё сервер отклоняет) обязано оставаться правдой, если флаг снимут.
 */
const withLive = (live: boolean): ConfigRegistry => {
  const r = new ConfigRegistry(); r.loadAll();
  const b = r.get('balance');
  r.reload({ balance: { ...b, craft: { ...b.craft, live } } });
  return r;
};
const liveReg = withLive(true);
const closedReg = withLive(false);
const wallet = (): Record<string, number> => Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 999]));

type Reply = CmdReply | null;
function bench(item: Item, config = reg) {
  const save: SaveState = newBotSave(reg, reg.get('classes')[0]!.id);
  save.gold = 9_999_999;
  save.inventory = [{ ...item, pos: { x: 0, y: 0 } }];
  const requests: TownCommand[] = [];
  /** Номер команды каждого запроса — как у `App.request`: свой, если окно его не передало. */
  const ids: number[] = [];
  const fired: TownCommand[] = [];
  const pending: ((r: Reply) => void)[] = [];
  /** R5-18: куда `App.request` отдал бы поздний ответ — по запросу. */
  const lates: (((r: CmdReply) => void) | undefined)[] = [];
  let note = '';
  let lastId = 100;
  const nextCmdId = (): number => ++lastId;
  const app = {
    config, state: { save }, stash: { materials: wallet() },
    net: { connected: true },
    nextCmdId,
    request: (c: TownCommand, _ms?: number, id = nextCmdId(), onLate?: (r: CmdReply) => void): Promise<Reply> => {
      requests.push(c); ids.push(id); lates.push(onLate);
      return new Promise<Reply>((res) => { pending.push(res); });
    },
    sendCmd: (c: TownCommand) => { fired.push(c); return fired.length; },
    bus: { emit: () => {} },
  };
  const opts = { uid: item.uid, setUid: () => {}, get note() { return note; }, setNote: (n: string) => { note = n; } };
  const render = (): El => forgeBench(app as never, opts) as unknown as El;
  return {
    app, save, requests, ids, fired, render, note: () => note,
    reply: async (r: Reply) => { pending.shift()!(r); await Promise.resolve(); await Promise.resolve(); },
    /** Поздний ответ на `i`-й запрос (его ждущий уже получил `null`) — как его отдаёт `CmdReplies`. */
    late: (i: number, r: CmdReply) => { lates[i]?.({ ...r, id: ids[i]! }); },
    pendingCount: () => pending.length,
  };
}
const magicWeapon = (): Item => ({ ...newBotSave(reg, reg.get('classes')[0]!.id).equipment.weapon!, uid: 'bench-x', rarity: 'magic', origin: 'drop' });
const reply = (cmd: string, ok: boolean, reason?: string): CmdReply => ({ t: 'cmdResult', id: 1, cmd: cmd as CmdReply['cmd'], ok, ...(reason ? { reason } : {}) });

describe('⭐ R3-16: действие верстака в полёте', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  it('⭐ двойной клик по «Реролл» — ОДНА платная команда, с ожиданием ответа; пока ждём — все карточки гаснут', async () => {
    const b = bench(magicWeapon());
    const root = b.render();
    const card = root.card('Реролл')!;
    expect(card, 'карточка реролла горит').toBeDefined();
    card.click(); card.click();                        // двойной клик: второй — по той же, ещё не перерисованной карточке
    expect(b.requests, 'было: две команды forgeReroll подряд').toEqual([{ cmd: 'forgeReroll', uid: 'bench-x', maxGold: forgeGold(reg, magicWeapon(), 'reroll') }]);
    expect(b.fired, 'мимо ожидания ответа не уходит ничего').toEqual([]);
    // Перерисовка кадром сейва, ответа ещё нет: карточки погашены, нажатая — «⏳».
    const busy = b.render();
    expect(busy.text()).toContain('⏳');
    busy.card('Реролл')!.click();
    busy.card('Улучшить')!.click();
    expect(b.requests).toHaveLength(1);
    await b.reply(reply('forgeReroll', true));
    b.render().card('Реролл')!.click();
    expect(b.requests, 'ответ пришёл — карточка снова живая').toHaveLength(2);
    await b.reply(reply('forgeReroll', true));
  });

  it('⭐ отказ сервера («Слишком часто») — строкой над верстаком, а не молчанием; тишина — «нет ответа»', async () => {
    const b = bench(magicWeapon());
    b.render().card('Реролл')!.click();
    await b.reply(reply('forgeReroll', false, 'Слишком часто'));
    expect(b.note()).toContain('Слишком часто');
    expect(b.render().text()).toContain('Слишком часто');
    b.render().card('Реролл')!.click();
    await b.reply(null);
    expect(b.note()).toContain('Нет ответа');
    expect(b.render().text()).not.toContain('⏳');
  });
});

describe('⭐ R5-15: платное действие верстака несёт цену, которую показала карточка', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  it('«Улучшить», «Реролл», «Починить» — с `maxGold` строки цены; разбор бесплатен — без неё', async () => {
    const item = magicWeapon();
    const b = bench(item);
    b.render().card('Улучшить')!.click();
    await b.reply(reply('forgeUpgrade', true));
    b.render().card('Реролл')!.click();
    await b.reply(reply('forgeReroll', true));
    const broken = bench({ ...magicWeapon(), uid: 'bench-br', broken: true });
    broken.render().card('Починить')!.click();
    await broken.reply(reply('forgeRepair', true));
    expect(b.requests, 'было: без цены — сервер брал по своему конфигу, какой бы ни видел игрок').toEqual([
      { cmd: 'forgeUpgrade', uid: 'bench-x', maxGold: forgeGold(reg, item, 'upgrade') },
      { cmd: 'forgeReroll', uid: 'bench-x', maxGold: forgeGold(reg, item, 'reroll') },
    ]);
    expect(broken.requests).toEqual([{ cmd: 'forgeRepair', uid: 'bench-br', maxGold: forgeGold(reg, { ...item, broken: true }, 'repair') }]);
  });
});

describe('⭐ R3-09: скованную вещь зачаровывают с верстака', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  function forged(): Item {
    const save = newBotSave(reg, reg.get('classes')[0]!.id);
    save.gold = 9_999_999; save.inventory = [];
    const stash = { ...emptyStash(reg), materials: wallet(), forgeJournal: fullJournal(reg) };
    const r = craftAction(reg, save, stash, 'bench-r309-nonce', { weaponClass: 'sword', hands: 1, parts: defaultParts(reg, 'sword', 1, 2)! }, createRng(9), { fullJournal: true });
    if (!r.ok) throw new Error(r.reason);
    return save.inventory.find((i) => i.uid === r.uid)!;
  }

  it('⭐ скованная обычная вещь на верстаке (окно ковки её не помнит) — «✦ Магический» шлёт forgeEnchant', async () => {
    const item = forged();
    const b = bench(item, liveReg);
    const root = b.render();
    const magic = root.card('Магический');
    expect(magic, 'было: зачаровать с верстака нельзя вовсе').toBeDefined();
    expect(root.card('Редкий')).toBeDefined();
    magic!.click();
    expect(b.requests).toEqual([{ cmd: 'forgeEnchant', uid: item.uid, rarity: 'magic', maxGold: enchantCost(liveReg, item, 'magic') }]);
    await b.reply(reply('forgeEnchant', true));
  });

  it('ковка закрыта — карточки есть, но не шлют ничего', () => {
    const b = bench(forged(), closedReg);
    b.render().card('Магический')!.click();
    expect(b.requests).toEqual([]);
  });

  it('⭐ с данными «как в игре» (ковка открыта) зачарование с верстака уходит на сервер', async () => {
    expect(reg.get('balance').craft.live, 'balance.craft.live в data/balance.json').toBe(true);
    const item = forged();
    const b = bench(item, reg);
    b.render().card('Редкий')!.click();
    expect(b.requests).toEqual([{ cmd: 'forgeEnchant', uid: item.uid, rarity: 'rare', maxGold: enchantCost(reg, item, 'rare') }]);
    await b.reply(reply('forgeEnchant', true));
  });
});

describe('⭐ R4-23: повтор после «нет ответа» не платит дважды', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });
  const weapon = (uid: string): Item => ({ ...magicWeapon(), uid });

  it('⭐ «Улучшить» без ответа 8 с (база медленная, команда ещё в очереди) — повтор уходит ТЕМ ЖЕ номером: сервер ответит итогом первой', async () => {
    const b = bench(weapon('r423-up'));
    b.render().card('Улучшить')!.click();
    await b.reply(null);                                // 8 с тишины: `request` ответил «неизвестно»
    expect(b.note()).toContain('Нет ответа');
    b.render().card('Улучшить')!.click();              // вещь не изменилась — игрок жмёт ещё раз
    const up = { cmd: 'forgeUpgrade', uid: 'r423-up', maxGold: forgeGold(reg, weapon('r423-up'), 'upgrade') };
    expect(b.requests).toEqual([up, up]);
    expect(b.ids[1], 'было: новый номер — повтор уходил мимо дедупа и покупал вторую ступень').toBe(b.ids[0]);
    await b.reply(reply('forgeUpgrade', true));
  });

  it('⭐ «Реролл» — так же; ответ на повтор (любой) снимает память: следующий клик — новая заявка', async () => {
    const b = bench(weapon('r423-rr'));
    b.render().card('Реролл')!.click();
    await b.reply(null);
    b.render().card('Реролл')!.click();
    expect(b.ids[1]).toBe(b.ids[0]);
    await b.reply(reply('forgeReroll', false, 'Недостаточно золота'));   // итог первой заявки из дедупа
    expect(b.note()).toContain('Недостаточно золота');
    b.render().card('Реролл')!.click();
    expect(b.ids[2], 'итог известен — дальше новый номер (иначе дедуп вечно отвечал бы тем же отказом)').not.toBe(b.ids[0]);
    await b.reply(reply('forgeReroll', true));
  });

  it('первая заявка всё же прошла (вещь изменилась — пришёл сейв) — повтор это НОВАЯ заявка, а не эхо первой', async () => {
    const b = bench(weapon('r423-late'));
    b.render().card('Улучшить')!.click();
    await b.reply(null);
    // Сейв пришёл: первая заявка прошла, вещь уже другая (здесь — счётчик перекаток; годится любое поле, кроме места в сумке).
    b.save.inventory[0] = { ...b.save.inventory[0]!, rerolls: (b.save.inventory[0]!.rerolls ?? 0) + 1 };
    b.render().card('Улучшить')!.click();
    expect(b.ids[1], 'вещь другая — старый номер вернул бы итог первой, и вторая ступень не купилась бы').not.toBe(b.ids[0]);
    await b.reply(reply('forgeUpgrade', true));
  });

  it('вещь лишь переложили в сумке (и пришла она кадром с иным порядком полей) — это та же вещь: повтор тем же номером', async () => {
    const b = bench(weapon('r423-moved'));
    b.render().card('Улучшить')!.click();
    await b.reply(null);
    const it = b.save.inventory[0]!;
    b.save.inventory[0] = Object.fromEntries(Object.entries({ ...it, pos: { x: 3, y: 1 } }).reverse()) as unknown as Item;
    b.render().card('Улучшить')!.click();
    expect(b.ids[1]).toBe(b.ids[0]);
    await b.reply(reply('forgeUpgrade', true));
  });

  it('⭐ R5-18: поздний ОТКАЗ на заявку без ответа («Не удалось сохранить…») — виден над верстаком, а повтор уходит НОВЫМ номером', async () => {
    const b = bench(weapon('r518-late'));
    b.render().card('Улучшить')!.click();
    await b.reply(null);                                // 8 с тишины
    b.late(0, reply('forgeUpgrade', false, 'Не удалось сохранить, попробуйте ещё раз'));   // сервер ответил позже: отказ
    expect(b.note(), 'было: отказ уходил только в лог, над верстаком висело «могло пройти»').toContain('Не удалось сохранить');
    b.render().card('Улучшить')!.click();              // вещь та же — игрок повторяет, как просит сообщение
    expect(b.ids[1], 'было: тот же номер — дедуп сервера отвечал эхом отказа, и повтор не исполнялся').not.toBe(b.ids[0]);
    await b.reply(reply('forgeUpgrade', true));
  });

  it('R5-18: поздний УСПЕХ снимает «нет ответа» с верстака; следующий клик — новая заявка', async () => {
    const b = bench(weapon('r518-ok'));
    b.render().card('Реролл')!.click();
    await b.reply(null);
    expect(b.note()).toContain('Нет ответа');
    b.late(0, reply('forgeReroll', true));
    expect(b.note()).not.toContain('Нет ответа');
    b.render().card('Реролл')!.click();
    expect(b.ids[1]).not.toBe(b.ids[0]);
    await b.reply(reply('forgeReroll', true));
  });

  it('другое действие над той же вещью — своя заявка со своим номером', async () => {
    const b = bench(weapon('r423-other'));
    b.render().card('Улучшить')!.click();
    await b.reply(null);
    b.render().card('Реролл')!.click();
    expect(b.ids[1]).not.toBe(b.ids[0]);
    await b.reply(reply('forgeReroll', true));
  });

  it('⭐ нет связи — действие не уходит вовсе и говорит почему (было: «нет ответа… могло пройти» про команду, которой не было)', () => {
    const b = bench(weapon('r423-off'));
    b.app.net.connected = false;
    b.render().card('Реролл')!.click();
    expect(b.requests).toEqual([]);
    expect(b.note()).toContain('Нет связи');
    expect(b.render().text()).not.toContain('⏳');
  });
});
