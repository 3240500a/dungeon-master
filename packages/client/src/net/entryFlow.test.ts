import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseClientFrame, type ClientFrame, type ServerFrame } from '@dm/shared';
import { EntryFlow, netLostText, QUEUE_POLL_MS, STATUS_RETRY_MS, type EntryDeps } from './entryFlow.js';
import { NetClient, routeToNode, type RouteAnswer } from './netClient.js';
import { entryScreens } from '../ui/entryScreens.js';
import { askInGame } from '../ui/kit.js';

/**
 * ⭐ ВХОД В МИР И ПОТЕРЯ СВЯЗИ — ОДИН ПОТОК НА ОБА КЛИЕНТА (`EntryFlow` + общие экраны `entryScreens`).
 *
 * Веб-3D на ЛЮБОЕ закрытие сокета показывал лобби «Сервер недоступен» и не переподключался вовсе, а кнопки лобби слали
 * `join` в мёртвый сокет: после 4009 / 4001 / 4008 игроку оставалось только перезагрузить страницу. В 2D это уже было
 * починено (R3-25) — теперь та же логика одна на двоих, и её гоняет этот тест так, как её зовёт веб-3D: свой корень
 * DOM, свои крючки (миникарта, лог), свой сброс мира.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуются экраны.
 */
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; parent: El | null = null; value = '';
  private sel = new Map<string, El>();
  private html = '';
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string) { }
  set innerHTML(v: string) { this.children = []; this.sel.clear(); this.html = v; }
  get innerHTML(): string { return this.html; }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  click(): void { for (const f of this.on.get('click') ?? []) f(); }
  /** Элемент разметки по селектору: заглушка — один на селектор, кнопки кликабельны. */
  querySelector(s: string): El { let e = this.sel.get(s); if (!e) { e = new El('q'); e.parent = this; this.sel.set(s, e); } return e; }
  text(): string { return [this.html, this.textContent, ...[...this.sel.values()].map((e) => e.textContent), ...this.children.map((c) => c.text())].join(' | '); }
}

const TOKEN = 'ab'.repeat(32);

/** Поддельный `NetClient`: кадры сервера — `fire`, жизнь сокета — `open`/`close`; `server` — что сервер делает с кадром. */
function fakeNet() {
  const handlers = new Map<string, ((f: never) => void)[]>();
  const opens: (() => void)[] = [], closes: ((code?: number) => void)[] = [];
  const net = {
    connected: false, connects: 0, resets: 0,
    /** Куда подключались (`undefined` — адрес по умолчанию). */
    urls: [] as (string | undefined)[],
    /** Ушло по живому сокету. */
    sent: [] as ClientFrame[],
    /** Отправлено в мёртвый сокет — `NetClient.send` такое молча роняет. */
    void: [] as ClientFrame[],
    /** Сокет открывается сам сразу после `connect` (синхронно — жёстче, чем в браузере). */
    autoOpen: false,
    server: undefined as ((f: ClientFrame) => void) | undefined,
    on(t: string, cb: (f: never) => void): void { handlers.set(t, [...(handlers.get(t) ?? []), cb]); },
    onOpen(cb: () => void): void { opens.push(cb); },
    onClose(cb: (code?: number) => void): void { closes.push(cb); },
    connect(url?: string): void { net.connects++; net.urls.push(url); if (net.autoOpen) net.open(); },
    resetWorld(): void { net.resets++; },
    send(f: ClientFrame): void {
      // Кадр обязан пройти ту же строгую схему, что стоит на входе сервера: иначе он отброшен и «вход» не случится.
      if (!parseClientFrame(JSON.stringify(f))) throw new Error(`сервер отбросил бы кадр: ${JSON.stringify(f)}`);
      if (!net.connected) { net.void.push(f); return; }
      net.sent.push(f); net.server?.(f);
    },
    fire<T extends ServerFrame['t']>(t: T, f: Omit<Extract<ServerFrame, { t: T }>, 't'>): void { for (const h of handlers.get(t) ?? []) h({ t, ...f } as never); },
    open(): void { net.connected = true; for (const cb of opens) cb(); },
    close(code?: number): void { net.connected = false; for (const cb of closes) cb(code); },
    joins(): ClientFrame[] { return net.sent.filter((f) => f.t === 'join'); },
  };
  return net;
}

/** Клиент «как веб-3D»: свой корень, крючок экранов входа (прячет миникарту и лог), свой сброс мира и лог игры. */
function client(charId = 'hero-1', extra: Partial<EntryDeps> = {}) {
  const net = fakeNet();
  const root = new El('ui-root');
  const hooks = { menus: 0, lost: 0, dropped: 0, log: [] as string[] };
  const flow = new EntryFlow({
    net, who: () => ({ token: TOKEN, charId }),
    view: entryScreens(() => root as unknown as HTMLElement, () => { hooks.menus++; }),
    onLost: () => { hooks.lost++; },
    replies: { dropAll: () => { hooks.dropped++; } },
    log: (text) => hooks.log.push(text),
    ...extra,
  });
  flow.attach();
  /** Экран входа, что сейчас на экране (один за раз), или undefined. */
  const screen = (): El | undefined => root.children.at(-1);
  const text = (): string => root.text();
  const click = (sel: string): void => screen()!.querySelector(sel).click();
  return { net, root, flow, hooks, screen, text, click, start: () => flow.start() };
}
/** Вход в мир: подключились, сервер ответил «забега нет», игрок нажал «Соло», сервер впустил. */
function enterWorld(c: ReturnType<typeof client>): void {
  c.start(); c.net.open();
  c.net.fire('runStatus', { hasRun: false });
  c.click('[data-a="solo"]');
  c.net.fire('joined', {} as never);
}

describe('⭐ EntryFlow — вход в мир и потеря связи (общий для 2D и веб-3D)', () => {
  const G = globalThis as unknown as { document?: unknown };
  let body: El;
  beforeEach(() => { body = new El('body'); G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body }; });
  afterEach(() => { delete G.document; });

  it('вход: плашка «Подключение…» → статус забега → лобби → «Соло» шлёт join по открытому сокету → экраны сняты', () => {
    const c = client();
    c.start();
    expect(c.net.connects).toBe(1);
    expect(c.text()).toContain('Подключение к серверу');
    expect(c.screen()!.style.cssText, '⚠ корень веб-3D не ловит мышь (pointer-events:none) — экран обязан ловить сам').toContain('pointer-events:auto');
    c.net.open();
    expect(c.net.sent).toEqual([{ t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
    c.net.fire('runStatus', { hasRun: false });
    expect(c.text()).toContain('Кооп');
    expect(c.root.children, 'экран входа один').toHaveLength(1);
    c.click('[data-a="solo"]');
    expect(c.net.joins()).toEqual([{ t: 'join', token: TOKEN, charId: 'hero-1', fresh: true }]);
    c.net.fire('joined', {} as never);
    expect(c.root.children, 'в игре экранов входа нет').toHaveLength(0);
    expect(c.hooks.menus, 'крючок экранов входа (веб-3D прячет миникарту и лог)').toBeGreaterThanOrEqual(2);
  });

  it('вход по коду комнаты и «Продолжить»/«Забросить» — те же кадры, что слали клиенты', () => {
    const c = client();
    c.start(); c.net.open();
    c.net.fire('runStatus', { hasRun: false });
    // Код — полной длины (R4-18: 8 знаков); неполный лобби не шлёт вовсе (R4-12, `ui/entryScreens.test.ts`).
    c.screen()!.querySelector('.code').value = ' a7k3f9xy ';
    c.click('[data-a="join"]');
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', roomCode: 'A7K3F9XY' });
    c.net.fire('runStatus', { hasRun: true, roomCode: 'QWER', depth: 3 });
    expect(c.text()).toContain('Незавершённое прохождение');
    expect(c.text()).toContain('этаж 3, комната QWER');
    c.click('[data-a="resume"]');
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
    c.click('[data-a="abandon"]');
    expect(c.net.sent.at(-1)).toEqual({ t: 'abandon', token: TOKEN, charId: 'hero-1' });
    c.net.fire('abandoned', {} as never);
    expect(c.text()).toContain('Кооп');
    expect(c.text()).not.toContain('Незавершённое');
  });

  it('незавершённый забег без кода комнаты (из сейва) — без пустого «комната »', () => {
    const c = client();
    c.start(); c.net.open();
    c.net.fire('runStatus', { hasRun: true, depth: 2 });
    expect(c.text()).toContain('этаж 2)');
    expect(c.text()).not.toMatch(/комната\s*\)/);
  });

  it('⭐ сервер закрыл живую сессию (4009) — мир снесён, ждущие отпущены, плашка с причиной, переподключение, лобби с причиной', () => {
    const c = client();
    enterWorld(c);
    c.net.close(4009);
    expect(c.hooks.lost, 'мир прошлой сессии снесён (куклы, пиры, снапшот)').toBe(1);
    expect(c.hooks.dropped, 'ждущие ответа на команды отпущены сразу, а не через 8 с').toBe(1);
    expect(c.net.resets, 'копия мира прошлой сессии сброшена').toBe(1);
    expect(c.net.connects, 'было (веб-3D): закрытие не переподключало вовсе').toBe(2);
    expect(c.text()).toContain('Подключение к серверу');
    expect(c.text()).toContain('Сессия устарела');
    expect(c.text(), 'было (веб-3D): «Сервер недоступен» на любое закрытие').not.toContain('Сервер недоступен');
    c.net.open();
    expect(c.net.sent.at(-1)).toEqual({ t: 'runStatus', token: TOKEN, charId: 'hero-1' });
    c.net.fire('runStatus', { hasRun: false });
    expect(c.text()).toContain('Кооп');
    expect(c.text(), 'лобби говорит, почему игрок снова здесь').toContain('Сессия устарела');
    const before = c.net.joins().length;
    c.click('[data-a="solo"]');
    expect(c.net.void, 'было (веб-3D): join уходил в мёртвый сокет').toEqual([]);
    expect(c.net.joins()).toHaveLength(before + 1);
    c.net.fire('joined', {} as never);
    expect(c.root.children).toHaveLength(0);
    c.net.close(1006);
    expect(c.text(), 'новый вход — причина прошлой потери забыта, новая своя').toContain('Соединение потеряно');
    expect(c.text()).not.toContain('Сессия устарела');
  });

  it('причины: 4001 — вход из другого окна, 4008 — лимит запросов, без кода — обрыв; «Продолжить» тоже с причиной', () => {
    expect(netLostText(4001)).toContain('другом окне');
    expect(netLostText(4008)).toContain('Слишком много запросов');
    expect(netLostText(4009)).toContain('Сессия устарела');
    expect(netLostText()).toContain('Соединение потеряно');
    for (const [code, want] of [[4001, 'другом окне'], [4008, 'Слишком много запросов']] as const) {
      const c = client();
      enterWorld(c);
      c.net.close(code);
      expect(c.text()).toContain(want);
      c.net.open();
      c.net.fire('runStatus', { hasRun: true, roomCode: 'ABCD', depth: 2 });
      expect(c.text()).toContain('Незавершённое прохождение');
      expect(c.text(), `${code}: «Продолжить» говорит, почему игрок снова здесь`).toContain(want);
    }
  });

  it('⭐ переподключение героя НЕ входит само: два окна одного героя не выселяют друг друга по кругу', () => {
    // Сервер: вход выселяет прежнее соединение героя (4001), статус забега не выселяет никого.
    let owner: ReturnType<typeof fakeNet> | null = null;
    const serve = (net: ReturnType<typeof fakeNet>) => (f: ClientFrame): void => {
      if (f.t === 'runStatus') net.fire('runStatus', { hasRun: false });
      if (f.t === 'join') {
        const old = owner; owner = net;
        if (old && old !== net && old.connected) old.close(4001);
        net.fire('joined', {} as never);
      }
    };
    const a = client(), b = client();
    for (const c of [a, b]) { c.net.autoOpen = true; c.net.server = serve(c.net); }
    enterWorld(a);
    expect(a.root.children, 'окно A в игре').toHaveLength(0);
    enterWorld(b);                                     // герой вошёл во втором окне — A выселено (4001)
    expect(owner).toBe(b.net);
    expect(a.net.connects, 'A переподключилось').toBe(2);
    expect(a.text(), 'A в лобби с причиной, а не в игре').toContain('другом окне');
    expect(a.net.joins(), '⭐ A само НЕ вошло: иначе выселило бы B, B — A, и так по кругу').toHaveLength(1);
    expect(b.root.children, 'B продолжает играть').toHaveLength(0);
    expect(b.net.connects, 'B никто не трогал').toBe(1);
  });

  it('до входа (плашка «Подключение…») закрытие — лобби «Сервер недоступен», без переподключения по кругу', () => {
    const c = client();
    c.start();
    c.net.close(1006);
    expect(c.net.connects).toBe(1);
    expect(c.text()).toContain('Кооп');
    expect(c.text()).toContain('Сервер недоступен');
    expect(c.hooks.lost, 'мира ещё не было — сносить нечего').toBe(0);
  });

  it('⭐ связь потеряна в лобби, переподключиться не вышло — кнопка лобби поднимает связь заново, а не шлёт в пустоту', () => {
    const c = client();
    enterWorld(c);
    c.net.close(4009);                                 // потеря в игре → переподключение…
    c.net.close(1006);                                 // …сервера нет
    expect(c.text()).toContain('Сервер недоступен');
    expect(c.net.connects).toBe(2);
    c.click('[data-a="solo"]');
    expect(c.net.void, 'было: join в мёртвый сокет — «Подключение…» навсегда').toEqual([]);
    expect(c.net.connects, 'клик поднял связь заново').toBe(3);
    expect(c.text()).toContain('Подключение к серверу');
    c.net.open();
    expect(c.net.sent.at(-1), 'и спросил статус забега — вход только следующим кликом').toEqual({ t: 'runStatus', token: TOKEN, charId: 'hero-1' });
    expect(c.net.joins()).toHaveLength(1);
    c.net.fire('runStatus', { hasRun: false });
    c.click('[data-a="solo"]');
    expect(c.net.joins()).toHaveLength(2);
  });

  it('⭐ сервер «моргает» (снова закрыл соединение вскоре после переподключения, входа не было) — без петли переподключений', () => {
    let now = 1_000_000;
    const net = fakeNet();
    const root = new El('ui-root');
    const flow = new EntryFlow({ net, who: () => ({ token: TOKEN, charId: 'hero-1' }), view: entryScreens(() => root as unknown as HTMLElement), now: () => now });
    flow.attach(); flow.start(); net.open();
    net.fire('runStatus', { hasRun: false });
    root.children.at(-1)!.querySelector('[data-a="solo"]').click();
    net.fire('joined', {} as never);
    net.close(4009);                                   // потеря в игре — переподключаемся сами
    expect(net.connects).toBe(2);
    net.open(); net.fire('runStatus', { hasRun: false });
    now += 1_000;
    net.close(1006);                                   // через секунду снова, а игрок никуда не входил
    expect(net.connects, 'второй раз сам не переподключается — иначе все клиенты долбили бы сервер по кругу').toBe(2);
    expect(root.text()).toContain('Кооп');
    expect(root.text()).toContain('нажмите');
    root.children.at(-1)!.querySelector('[data-a="solo"]').click();
    expect(net.connects, 'кнопка поднимает связь').toBe(3);
    net.open(); net.fire('runStatus', { hasRun: false });
    now += 6_000;
    net.close(1006);                                   // спустя время — снова сам
    expect(net.connects).toBe(4);
    net.open(); net.fire('runStatus', { hasRun: false });
    root.children.at(-1)!.querySelector('[data-a="solo"]').click();
    net.fire('joined', {} as never);                   // вошёл — это клик игрока, не петля
    now += 500;
    net.close(4009);
    expect(net.connects, 'после входа потеря снова переподключается сама').toBe(5);
  });

  it('синхронный open прямо из обработчика закрытия (гонка) — всё равно лобби, а не плашка поверх него', () => {
    const c = client();
    c.net.server = (f) => { if (f.t === 'runStatus') c.net.fire('runStatus', { hasRun: false }); };
    enterWorld(c);
    c.net.autoOpen = true;
    c.net.close(4009);
    expect(c.root.children).toHaveLength(1);
    expect(c.text()).toContain('Кооп');
    expect(c.text()).not.toContain('Подключение к серверу');
    expect(c.text()).toContain('Сессия устарела');
  });

  it('статус забега, пришедший в игре, лобби поверх мира не рисует', () => {
    const c = client();
    enterWorld(c);
    c.net.fire('runStatus', { hasRun: false });
    c.net.fire('abandoned', {} as never);
    c.net.fire('error', { code: 'no-run', msg: 'Забег не найден' });
    expect(c.root.children).toHaveLength(0);
  });

  it('ошибки сервера: на экране входа — строкой статуса; «нет забега» — в лобби; в игре — в лог (кроме отказа команды)', () => {
    const c = client();
    c.start(); c.net.open();
    c.net.fire('runStatus', { hasRun: true, roomCode: 'ABCD', depth: 1 });
    c.click('[data-a="resume"]');
    expect(c.text()).toContain('Возврат в забег');
    c.net.fire('error', { code: 'busy', msg: 'Сервер занят, попробуйте ещё раз' });
    expect(c.text()).toContain('Сервер занят');
    c.net.fire('error', { code: 'no-run', msg: 'Забег не найден' });
    expect(c.text(), 'забег истёк за время раздумий').toContain('Кооп');
    c.click('[data-a="solo"]');
    c.net.fire('joined', {} as never);
    c.net.fire('error', { code: 'far', msg: 'Подойдите к порталу' });
    c.net.fire('error', { code: 'rate', msg: 'Подождите немного' });
    c.net.fire('error', { code: 'cmd', msg: 'Слишком часто' });
    expect(c.hooks.log, 'было: в игре ошибка писалась в статус снятого экрана — её не видел никто').toEqual(['Подойдите к порталу', 'Подождите немного']);
    expect(c.root.children).toHaveLength(0);
  });

  it('⭐ потеря связи снимает открытый вопрос «разобрать здесь?» с ответом «нет»', async () => {
    const c = client();
    enterWorld(c);
    const r: { answer?: boolean } = {};
    void askInGame('Разобрать здесь?').then((v) => { r.answer = v; });
    c.net.close(4009);
    await new Promise((res) => setTimeout(res, 0));
    expect(r.answer).toBe(false);
    expect(body.children.filter((x) => x.text().includes('Разобрать здесь?'))).toEqual([]);
  });

  it('отцеплен (выход из игры) — закрытие сокета ничего не трогает, экраны сняты', () => {
    const c = client();
    c.start(); c.net.open();
    c.net.fire('runStatus', { hasRun: false });
    c.flow.detach();
    expect(c.root.children).toHaveLength(0);
    c.net.close(4009);
    expect(c.net.connects).toBe(1);
    expect(c.root.children).toHaveLength(0);
    c.net.fire('runStatus', { hasRun: false });
    expect(c.root.children).toHaveLength(0);
  });

  it('старт при уже открытом сокете — статус забега сразу, без второго соединения', () => {
    const c = client();
    c.net.connected = true;
    c.start();
    expect(c.net.connects).toBe(0);
    expect(c.net.sent).toEqual([{ t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
  });

  it('⭐ R6-25: «герой в мире» (`inWorld`) — да с кадра `joined`; нет на потере связи (до `onLost`), отказе и выходе', () => {
    const flips: string[] = [];
    const c = client('hero-1', { inWorld: (on) => flips.push(on ? 'in' : 'out'), onLost: () => flips.push('lost') });
    c.start();
    expect(flips, 'вход ещё не состоялся — не мир').toEqual(['out']);
    c.net.open(); c.net.fire('runStatus', { hasRun: false });
    c.click('[data-a="solo"]');
    expect(flips).toEqual(['out']);
    c.net.fire('joined', {} as never);
    expect(flips).toEqual(['out', 'in']);
    c.net.close(4009);
    expect(flips, 'вне мира — раньше, чем сносится мир прошлой сессии').toEqual(['out', 'in', 'out', 'lost']);
    c.net.open(); c.net.fire('runStatus', { hasRun: false });
    expect(flips.at(-1), 'лобби переподключения — не мир').not.toBe('in');
    c.click('[data-a="solo"]'); c.net.fire('joined', {} as never);
    expect(flips.at(-1)).toBe('in');
    c.flow.detach();
    expect(flips.at(-1), 'выход из игры (и отказ входа — он тоже отцепляет поток)').toBe('out');
  });
});

describe('⭐ R4-22: отказ на автоматический статус забега — не плашка без кнопок навсегда', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { vi.useFakeTimers(); G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body: new El('body') }; });
  afterEach(() => { vi.useRealTimers(); delete G.document; });

  /** Потеря связи в игре (4009 — сбой фиксации, база медленная) и новое соединение: поток сам спросил статус забега. */
  function lostAndBack(extra: Partial<EntryDeps> = {}) {
    const c = client('hero-1', extra);
    enterWorld(c);
    c.net.close(4009);
    c.net.open();
    expect(c.net.sent.at(-1)).toEqual({ t: 'runStatus', token: TOKEN, charId: 'hero-1' });
    return c;
  }
  const statuses = (c: ReturnType<typeof client>): number => c.net.sent.filter((f) => f.t === 'runStatus').length;
  const BUSY = { code: 'busy', msg: 'Сервер занят, попробуйте ещё раз' } as const;

  it('⭐ «занят» (BUSY_ERROR) — статус переспрашивается с паузой 2/4/8 с, а кончились попытки — лобби с кнопками и причиной', async () => {
    const c = lostAndBack();
    const asked = statuses(c);
    c.net.fire('error', BUSY);
    expect(c.text()).toContain('Сервер занят');
    await vi.advanceTimersByTimeAsync(STATUS_RETRY_MS[0]);
    expect(statuses(c), 'было: ни повтора, ни кнопки — только перезагрузка страницы').toBe(asked + 1);
    for (const ms of STATUS_RETRY_MS.slice(1)) {
      c.net.fire('error', BUSY);
      await vi.advanceTimersByTimeAsync(ms);
    }
    expect(statuses(c)).toBe(asked + STATUS_RETRY_MS.length);
    c.net.fire('error', BUSY);
    expect(c.text(), 'попытки кончились — лобби, в нём есть что нажать').toContain('Кооп');
    expect(c.text()).toContain('Сервер занят');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statuses(c), 'из лобби сам больше не спрашивает').toBe(asked + STATUS_RETRY_MS.length);
    c.click('[data-a="solo"]');
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', fresh: true });
  });

  it('база ожила — повтор получил статус: экран по ответу, таймер повтора снят', async () => {
    const c = lostAndBack();
    c.net.fire('error', BUSY);
    await vi.advanceTimersByTimeAsync(STATUS_RETRY_MS[0]);
    c.net.fire('runStatus', { hasRun: true, roomCode: 'A7K3F9XY', depth: 2 });
    expect(c.text()).toContain('Незавершённое прохождение');
    const asked = statuses(c);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statuses(c)).toBe(asked);
    expect(c.text()).toContain('Незавершённое прохождение');
  });

  it('сокет закрылся, пока ждали повтора, — лобби «Сервер недоступен», повтор в мёртвый сокет не уходит', async () => {
    const c = lostAndBack();
    c.net.fire('error', BUSY);
    c.net.close(1006);
    const sent = c.net.sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.net.sent).toHaveLength(sent);
    expect(c.net.void).toEqual([]);
    expect(c.text()).toContain('Сервер недоступен');
  });

  it('⭐ «Требуется вход» (токен вышел в другой вкладке) и «Персонаж недоступен» (герой удалён) — к входу / выбору героя', () => {
    for (const code of ['auth', 'forbidden'] as const) {
      const out: string[] = [];
      const c = lostAndBack({ onRejected: (k) => out.push(k) });
      c.net.fire('error', { code, msg: code === 'auth' ? 'Требуется вход' : 'Персонаж недоступен' });
      expect(out, `${code}: клиент уводит на вход или выбор героя`).toEqual([code]);
      expect(c.root.children, 'экраны входа сняты — дальше экран клиента').toHaveLength(0);
      c.net.close(1006);
      expect(c.net.connects, 'поток отцеплен: закрытие сокета больше ничего не поднимает').toBe(2);
    }
  });

  it('без крючка клиента — и «Требуется вход», и «Неверный запрос» ведут в лобби с причиной, а не оставляют плашку', () => {
    for (const [code, msg] of [['auth', 'Требуется вход'], ['forbidden', 'Персонаж недоступен'], ['bad-frame', 'Неверный запрос']] as const) {
      const c = lostAndBack();
      c.net.fire('error', { code, msg });
      expect(c.text(), code).toContain('Кооп');
      expect(c.text(), code).toContain(msg);
    }
  });
});

describe('⭐ R4-13: маршрут к игровой ноде (кластер) — перед каждым подключением', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { vi.useFakeTimers(); G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body: new El('body') }; });
  afterEach(() => { vi.useRealTimers(); delete G.document; });

  /** Поддельный гейтвей: ответы по очереди (последний повторяется), вызовы записаны. */
  function gateway(...answers: RouteAnswer[]) {
    const calls: { ticket?: string; roomCode?: string }[] = [];
    const route = (token: string, charId: string, ticket?: string, roomCode?: string): Promise<RouteAnswer> => {
      expect([token, charId]).toEqual([TOKEN, 'hero-1']);
      calls.push({ ...(ticket ? { ticket } : {}), ...(roomCode ? { roomCode } : {}) });
      return Promise.resolve(answers.length > 1 ? answers.shift()! : answers[0]!);
    };
    return { route, calls };
  }
  const NODE0 = 'wss://game.example/ws/0';
  const NODE1 = 'wss://game.example/ws/1';
  /** Вошёл через маршрут: подключился к первой ноде, забега нет, «Соло», сервер впустил. */
  async function routedIn(c: ReturnType<typeof client>): Promise<void> {
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.net.open(); c.net.fire('runStatus', { hasRun: false }); c.click('[data-a="solo"]'); c.net.fire('joined', {} as never);
  }

  it('⭐ вход: сперва маршрут у гейтвея, сокет — на адрес ноды из ответа (было: всегда тот же origin, где у гейтвея нет /ws)', async () => {
    const gw = gateway({ url: NODE0 });
    const c = client('hero-1', { route: gw.route });
    c.start();
    expect(c.text()).toContain('Подключение к серверу');
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.calls).toEqual([{}]);
    expect(c.net.urls).toEqual([NODE0]);
    c.net.open();
    expect(c.net.sent).toEqual([{ t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
  });

  it('⭐ очередь (503): место в очереди на плашке, переспрос с билетом, потом — к ноде', async () => {
    const gw = gateway({ queue: { ticket: 't-1', position: 3, total: 7 } }, { queue: { ticket: 't-1', position: 1, total: 5 } }, { url: NODE1 });
    const c = client('hero-1', { route: gw.route });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.text()).toContain('Очередь на вход: 3 из 7');
    expect(c.net.connects, 'в очереди сокет не открываем').toBe(0);
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_MS);
    expect(c.text()).toContain('Очередь на вход: 1 из 5');
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_MS);
    expect(gw.calls).toEqual([{}, { ticket: 't-1' }, { ticket: 't-1' }]);
    expect(c.net.urls).toEqual([NODE1]);
  });

  it('⭐ потеря связи в игре (нода ушла на перезапуск, 1012) — снова маршрут, потом сокет к той ноде, что назвал гейтвей', async () => {
    const gw = gateway({ url: NODE0 }, { url: NODE1 });
    const c = client('hero-1', { route: gw.route });
    await routedIn(c);
    c.net.close(1012);
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.calls).toHaveLength(2);
    expect(c.net.urls).toEqual([NODE0, NODE1]);
    c.net.open();
    expect(c.net.sent.at(-1)).toEqual({ t: 'runStatus', token: TOKEN, charId: 'hero-1' });
  });

  it('⭐ «Персонаж в игре на другом узле» (wrong-node) — маршрут заново и статус с той ноды; сам не входит и не кружит', async () => {
    const gw = gateway({ url: NODE0 }, { url: NODE1 });
    const c = client('hero-1', { route: gw.route });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.net.open(); c.net.fire('runStatus', { hasRun: false });
    c.click('[data-a="solo"]');
    c.net.fire('error', { code: 'wrong-node', msg: 'Персонаж в игре на другом узле — войдите заново' });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.net.urls, 'было: кнопка слала join на ту же ноду снова и снова').toEqual([NODE0, NODE1]);
    c.net.open();
    expect(c.net.sent.at(-1)).toEqual({ t: 'runStatus', token: TOKEN, charId: 'hero-1' });
    expect(c.net.joins(), 'вход — только следующим кликом').toHaveLength(1);
    c.net.fire('runStatus', { hasRun: true, depth: 2 });
    expect(c.text()).toContain('на другом узле');
    // Гейтвей снова ведёт не туда — второй маршрут подряд без клика не спрашиваем: остаётся экран с кнопками.
    c.net.fire('error', { code: 'wrong-node', msg: 'Персонаж в игре на другом узле — войдите заново' });
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.calls).toHaveLength(2);
    expect(c.text()).toContain('Незавершённое прохождение');
  });

  it('⭐ к другу по коду — маршрут с кодом (нода — по первой букве), сокет к ней, вход по коду — как только открылся', async () => {
    const gw = gateway({ url: NODE0 }, { url: NODE1 });
    const c = client('hero-1', { route: gw.route });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.net.open(); c.net.fire('runStatus', { hasRun: false });
    c.screen()!.querySelector('.code').value = 'B7K3F9XY';
    c.click('[data-a="join"]');
    expect(c.net.joins(), 'на ноду лобби код не уходит: там этой комнаты нет, а промах платит лимит').toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.calls.at(-1)).toEqual({ roomCode: 'B7K3F9XY' });
    expect(c.net.urls).toEqual([NODE0, NODE1]);
    c.net.open();
    expect(c.net.sent.at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', roomCode: 'B7K3F9XY' });
    c.net.fire('error', { code: 'no-room', msg: 'Комната не найдена' });
    expect(c.text(), 'промах — лобби с причиной и кнопками').toContain('Кооп');
    expect(c.text()).toContain('Комната не найдена');
  });

  it('гейтвей отказал (узел комнаты не отвечает) — лобби с причиной, сокет не трогаем; «Требуется вход» — к входу', async () => {
    const gw = gateway({ url: NODE0 }, { error: 'Комната не найдена: узел не отвечает' });
    const c = client('hero-1', { route: gw.route });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.net.open(); c.net.fire('runStatus', { hasRun: false });
    c.screen()!.querySelector('.code').value = 'Z7K3F9XY';
    c.click('[data-a="join"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.text()).toContain('узел не отвечает');
    expect(c.text()).toContain('Кооп');
    expect(c.net.urls).toEqual([NODE0]);

    const out: string[] = [];
    const d = client('hero-1', { route: gateway({ error: 'Требуется вход', code: 'auth' }).route, onRejected: (k) => out.push(k) });
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toEqual(['auth']);
    expect(d.net.connects).toBe(0);
  });

  it('ответ маршрута, опоздавший к выходу из игры, сокет не открывает', async () => {
    let answer!: (r: RouteAnswer) => void;
    const c = client('hero-1', { route: () => new Promise((res) => { answer = res; }) });
    c.start();
    c.flow.detach();
    answer({ url: NODE0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.net.connects).toBe(0);
  });
});

/**
 * ⭐ R10-17: СОКЕТ НЕ СОЗДАЛСЯ — ЛОББИ С ПРИЧИНОЙ, А НЕ ВЕЧНАЯ ПЛАШКА.
 *
 * Конструктор `WebSocket` бросает СИНХРОННО: страница по https и адрес узла `ws://` (DEPLOY, вариант Б) — смешанное
 * содержимое (`SecurityError`), негодный адрес — `SyntaxError`. `connect` звался последним в ответе маршрута без защиты:
 * бросок становился необработанным отказом промиса, а игрок оставался на плашке «Подключение…» без кнопок, без таймера и
 * без причины (R4-22: на экране входа всегда есть что нажать). Теперь — лобби с причиной; кнопка лобби пробует снова.
 */
describe('⭐ R10-17: сокет не создался (конструктор бросил) — лобби с причиной, а не плашка без кнопок', () => {
  const G = globalThis as unknown as { document?: unknown };
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => { unhandled.push(e); };
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body: new El('body') };
    vi.spyOn(console, 'warn').mockImplementation(() => { });
  });
  afterEach(() => { process.off('unhandledRejection', onUnhandled); delete G.document; vi.restoreAllMocks(); });
  /** Все отложенные шаги (ответ маршрута, отказ промиса) — настоящими часами: отказ «без обработчика» ловит сам node. */
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  const insecure = (): never => {
    throw Object.assign(new Error("Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded over HTTPS."), { name: 'SecurityError' });
  };

  it('⭐ адрес ноды от гейтвея не открывается — лобби с причиной, без необработанного отказа; кнопка лобби пробует снова', async () => {
    const NODE = 'ws://203.0.113.5:3101/ws';
    const c = client('hero-1', { route: () => Promise.resolve({ url: NODE }) });
    const connect = c.net.connect;
    let broken = true;
    c.net.connect = (url?: string): void => { connect(url); if (broken) insecure(); };
    c.start();
    await settle();
    expect(c.net.urls).toEqual([NODE]);
    expect(unhandled, 'было: бросок внутри ответа маршрута — необработанный отказ').toEqual([]);
    expect(c.text(), 'было: плашка «Подключение…» без кнопок навсегда').toContain('Кооп');
    expect(c.text()).toContain('Не удалось подключиться к узлу игры');
    expect(console.warn, 'причина — в консоль (оператору: ws:// со страницы https)').toHaveBeenCalled();

    // Кнопка лобби — новая попытка (маршрут заново); снова бросок — снова лобби, не плашка.
    c.click('[data-a="solo"]');
    await settle();
    expect(c.net.urls).toEqual([NODE, NODE]);
    expect(c.text()).toContain('Кооп');
    expect(unhandled).toEqual([]);

    // Починили адрес — следующая кнопка подключает и входит, как обычно.
    broken = false;
    c.click('[data-a="solo"]');
    await settle();
    expect(c.net.urls).toEqual([NODE, NODE, NODE]);
    c.net.open();
    expect(c.net.sent.at(-1)).toEqual({ t: 'runStatus', token: TOKEN, charId: 'hero-1' });
  });

  it('без маршрута (одиночный процесс) — бросок сокета на старте не роняет `start`, а ведёт в лобби с причиной', async () => {
    const c = client();
    const connect = c.net.connect;
    c.net.connect = (url?: string): void => { connect(url); insecure(); };
    expect(() => c.start(), 'было: бросок уходил из `start` в код клиента').not.toThrow();
    await settle();
    expect(c.net.connects).toBe(1);
    expect(c.text()).toContain('Кооп');
    expect(c.text()).toContain('Не удалось подключиться к узлу игры');
    expect(unhandled).toEqual([]);
  });

  it('⭐ как в браузере: настоящие `NetClient` и `routeToNode`, страница по https, гейтвей называет `ws://` узла', async () => {
    const W = globalThis as unknown as { location?: unknown; fetch?: unknown; WebSocket?: unknown };
    const saved = { location: W.location, fetch: W.fetch, WebSocket: W.WebSocket };
    const made: string[] = [];
    class BrowserWs {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0; binaryType = '';
      onopen: (() => void) | null = null; onclose: ((ev?: { code?: number }) => void) | null = null; onmessage: (() => void) | null = null;
      constructor(url: string) { if (url.startsWith('ws:')) insecure(); made.push(url); }   // Chrome/Firefox на https-странице
      send(): void { }
      close(): void { this.readyState = 3; }
    }
    W.location = { protocol: 'https:', host: 'game.example', hostname: 'game.example' };
    W.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url: 'ws://203.0.113.5:3101/ws' }) });
    W.WebSocket = BrowserWs;
    try {
      const net = new NetClient();
      const root = new El('ui-root');
      const flow = new EntryFlow({
        net, who: () => ({ token: TOKEN, charId: 'hero-1' }), route: routeToNode,
        view: entryScreens(() => root as unknown as HTMLElement, () => { }),
      });
      flow.attach();
      flow.start();
      await settle();
      expect(unhandled).toEqual([]);
      // Страница по https — сокет узла только `wss://` (браузер `ws://` не откроет вовсе): просим его у того же хоста и порта.
      expect(made).toEqual(['wss://203.0.113.5:3101/ws']);
      flow.detach();
    } finally {
      Object.assign(W, saved);
    }
  });
});
