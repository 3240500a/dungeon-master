import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRng, parseClientFrame, type ClientFrame, type Rng, type ServerFrame } from '@dm/shared';
import {
  EntryFlow, netLostText, QUEUE_POLL_MS, STATUS_RETRY_MS, SOLO_YES, SOLO_RESUME, PARTY_YES, ROOM_ONLY_ERRORS, ROOM_SHARED_ERRORS, partyAsk, partyEnter,
  type EntryDeps,
} from './entryFlow.js';
import { NetClient, routeToNode, type RouteAnswer } from './netClient.js';
import { entryScreens } from '../ui/entryScreens.js';
import { askInGame, dismissAsk } from '../ui/kit.js';

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

/** Элемент поддерева по условию (кнопки вопроса в игре). */
function findEl(e: El, ok: (x: El) => boolean): El | undefined {
  if (ok(e)) return e;
  for (const c of e.children) { const f = findEl(c, ok); if (f) return f; }
  return undefined;
}

const TOKEN = 'ab'.repeat(32);
/** ⭐ D1: подсказка сервера позвавшему, чей голос за продолжение своего забега не прошёл (`SOLO_HINT` в `server/net/room.ts`). */
const RUN_ASK_SOLO = 'Пати не идёт. Можно продолжить забег без неё — бесплатно, в своей комнате («Продолжить без пати»); напарники придут к вам, когда позовут спуск или нажмут «Продолжить»';
/** Отказы входа `run` без кода комнаты — строки сервера (`RUN_PARKED_JOIN`, `RUN_CLASH_JOIN` в `roomManager.ts`). */
const RUN_PARKED = 'У вас незавершённый забег — продолжите или завершите его';
const RUN_CLASH = 'У вас незавершённый забег — продолжите или завершите его, прежде чем идти в чужой';

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
    on(t: string, cb: (f: never) => void): () => void {
      handlers.set(t, [...(handlers.get(t) ?? []), cb]);
      return () => { handlers.set(t, (handlers.get(t) ?? []).filter((h) => h !== cb)); };
    },
    onOpen(cb: () => void): () => void { opens.push(cb); return () => { const i = opens.indexOf(cb); if (i >= 0) opens.splice(i, 1); }; },
    onClose(cb: (code?: number) => void): () => void { closes.push(cb); return () => { const i = closes.indexOf(cb); if (i >= 0) closes.splice(i, 1); }; },
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
  afterEach(() => { dismissAsk(); delete G.document; });
  /** ⭐ R20-04: вопрос в игре (`askInGame`) с кнопкой «Продолжить без пати», если он на экране. */
  const asked = (): El | undefined => body.children.find((x) => x.text().includes(SOLO_YES));
  /** Нажать кнопку вопроса по подписи. */
  const press = (box: El, label: string): void => { findEl(box, (e) => e.tag === 'button' && e.textContent === label)!.click(); };
  /** Ответ вопроса — промисом: дать ему дойти. */
  const settled = async (): Promise<void> => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

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

  // ⭐ R16-01: вход без «Продолжить» при грейсе, чей бросок стоил бы штрафа, сервер отказывает `run` (раньше бросал забег молча). Лобби об этом
  // знать не могло (забег появился, пока оно висело) — и строка «продолжите или завершите» без таких кнопок оставляла только F5.
  it('⭐ R16-01: «Соло» отказан `run` (висит забег) — статус забега заново и экран «Продолжить / Забросить» с причиной', () => {
    const c = client();
    c.start(); c.net.open();
    c.net.fire('runStatus', { hasRun: false });
    c.click('[data-a="solo"]');
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', fresh: true });
    const sent = c.net.sent.length;
    c.net.fire('error', { code: 'run', msg: 'У вас незавершённый забег — продолжите или завершите его' });
    expect(c.net.sent.slice(sent), 'статус забега заново').toEqual([{ t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
    c.net.fire('runStatus', { hasRun: true, roomCode: 'QWER', depth: 2 });
    expect(c.text()).toContain('Незавершённое прохождение');
    expect(c.text(), 'и почему').toContain('незавершённый забег');
    c.click('[data-a="resume"]');
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
    c.net.fire('joined', {} as never);
    expect(c.root.children).toHaveLength(0);
  });

  // ⭐ R17-05: причина отказа R16-01 — разовая строка экрана «Продолжить / Забросить», а не причина потери связи (`note`): та живёт до входа, и
  // лобби после «Забросить» (штраф уже взят) твердило «у вас незавершённый забег» — будто бросок не удался — на каждом экране до входа.
  it('⭐ R17-05: после «Забросить» лобби не твердит «незавершённый забег» — причина отказа разовая, не причина потери связи', () => {
    const c = client();
    c.start(); c.net.open();
    c.net.fire('runStatus', { hasRun: false });
    c.click('[data-a="solo"]');
    c.net.fire('error', { code: 'run', msg: RUN_PARKED });
    c.net.fire('runStatus', { hasRun: true, roomCode: 'QWER', depth: 2 });
    expect(c.text()).toContain('Незавершённое прохождение');
    expect(c.text(), 'и почему').toContain(RUN_PARKED);
    c.click('[data-a="abandon"]');
    expect(c.net.sent.at(-1)).toEqual({ t: 'abandon', token: TOKEN, charId: 'hero-1' });
    c.net.fire('abandoned', {} as never);
    expect(c.text()).toContain('Кооп');
    expect(c.text(), 'было: «… продолжите или завершите его» в лобби сразу после броска').not.toContain('незавершённый забег');
    expect(c.flow.lostNote, 'было: причина отказа жила как причина потери связи до следующего входа').toBe('');
    c.net.fire('runStatus', { hasRun: true, depth: 1 });
    expect(c.text(), 'и не всплывает на следующем экране «Продолжить»').not.toContain('незавершённый забег');

    // Статус заново сказал «забега нет» (кончился, пока спрашивали) — лобби без строки, и позже она не всплывает.
    const d = client('hero-2');
    d.start(); d.net.open();
    d.net.fire('runStatus', { hasRun: false });
    d.click('[data-a="solo"]');
    d.net.fire('error', { code: 'run', msg: RUN_PARKED });
    d.net.fire('runStatus', { hasRun: false });
    expect(d.text()).toContain('Кооп');
    expect(d.text()).not.toContain('незавершённый забег');
    d.net.fire('runStatus', { hasRun: true, depth: 1 });
    expect(d.text()).not.toContain('незавершённый забег');

    // Причина потери связи после «Забросить» тоже устарела: лобби — после броска, а не «после обрыва».
    const e = client('hero-3');
    enterWorld(e);
    e.net.close(4009);
    e.net.open();
    e.net.fire('runStatus', { hasRun: true, roomCode: 'ABCD', depth: 2 });
    expect(e.text()).toContain('Сессия устарела');
    e.click('[data-a="abandon"]');
    e.net.fire('abandoned', {} as never);
    expect(e.text()).toContain('Кооп');
    expect(e.text()).not.toContain('Сессия устарела');
  });

  // ⭐ R17-05: вход ПО КОДУ сервер отказывает `run` без кода комнаты так же, как «Соло»: грейс героя держит забег за штраф (`RUN_PARKED_JOIN`) или
  // комната кода — в подземелье чужого забега, а у героя свой (`RUN_CLASH_JOIN`). Ветка R16-01 смотрела на код ВХОДА — и по коду игрок оставался в
  // лобби со строкой «продолжите или завершите» без таких кнопок (выход — угадать «Соло» или F5).
  it('⭐ R17-05: вход по коду отказан `run` без кода комнаты (висит свой забег) — статус забега и «Продолжить / Забросить» с причиной', () => {
    for (const msg of [RUN_PARKED, RUN_CLASH]) {
      const c = client();
      c.start(); c.net.open();
      c.net.fire('runStatus', { hasRun: false });
      c.screen()!.querySelector('.code').value = 'A7K3F9XY';
      c.click('[data-a="join"]');
      expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', roomCode: 'A7K3F9XY' });
      const sent = c.net.sent.length;
      c.net.fire('error', { code: 'run', msg });
      expect(c.net.sent.slice(sent), `${msg}: было — ничего, лобби «Кооп» со строкой и без кнопок`).toEqual([{ t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
      c.net.fire('runStatus', { hasRun: true, depth: 2 });
      expect(c.text()).toContain('Незавершённое прохождение');
      expect(c.text(), 'и почему').toContain(msg);
      c.click('[data-a="resume"]');
      expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
    }
  });

  it('незавершённый забег без кода комнаты (из сейва) — без пустого «комната »', () => {
    const c = client();
    c.start(); c.net.open();
    c.net.fire('runStatus', { hasRun: true, depth: 2 });
    expect(c.text()).toContain('этаж 2)');
    expect(c.text()).not.toMatch(/комната\s*\)/);
  });

  // ⭐ R16 C-09: герой погиб в этом забеге (штраф взят) и отключился — экран «Продолжить / Забросить» твердил «Забросить — штраф золота и
  // части предметов», хотя сервер за такой забег второго штрафа не берёт (V1), а «Продолжить» вернёт его мёртвым ждать пати (K1): бесплатный
  // выход выглядел платным и толкал к «Продолжить». Статус забега теперь говорит, что смерть оплачена (`dead`), и экран — как есть.
  it('⭐ R16 C-09: погибший в забеге — «Забросить» без штрафа (он уже взят), «Продолжить» — мёртвым ждать пати', () => {
    const c = client();
    c.start(); c.net.open();
    c.net.fire('runStatus', { hasRun: true, roomCode: 'QWER', depth: 3, dead: true });
    expect(c.text()).toContain('Незавершённое прохождение');
    expect(c.text(), 'было: «штраф золота и части предметов» и у погибшего').not.toMatch(/штраф золота/);
    expect(c.text()).toMatch(/Забросить[^|]*без штрафа/);
    expect(c.text()).toMatch(/Продолжить[^|]*мёртвым/);
    c.click('[data-a="abandon"]');
    expect(c.net.sent.at(-1), 'кнопки — те же кадры').toEqual({ t: 'abandon', token: TOKEN, charId: 'hero-1' });

    const d = client('hero-2');
    d.start(); d.net.open();
    d.net.fire('runStatus', { hasRun: true, roomCode: 'QWER', depth: 3, dead: false });
    expect(d.text(), 'живой — штраф, как было').toMatch(/штраф золота и части предметов/);
    expect(d.text()).not.toMatch(/без штрафа/);
    const e = client('hero-3');
    e.start(); e.net.open();
    e.net.fire('runStatus', { hasRun: true, depth: 1 });
    expect(e.text(), 'сервер старше поля — как было').toMatch(/штраф золота и части предметов/);
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

  // ⭐ R20-04, D1: голос за продолжение своего забега не прошёл («нет» напарника или срок голосования) — у героя право «Соло» (правило общего забега,
  // docs/MULTIPLAYER.md). Ни в одном веб-клиенте из мира на экран входа не выйти (меню нет, кадр `leave` не слал никто): строка в логе звала в меню,
  // которого нет, а повтор спуска снова ждал напарника. Подсказка несёт поле `solo`, и игра предлагает кнопку; кнопка сама и входит.
  it('⭐ D1: подсказка «пати не идёт» (`solo`) — кнопка «Продолжить без пати»: `leave` по живому сокету, статус забега и сразу `join{resume, solo}`', async () => {
    const flips: string[] = [];
    const c = client('hero-1', { inWorld: (on) => flips.push(on ? 'in' : 'out'), onLost: () => flips.push('lost') });
    enterWorld(c);
    const sent = c.net.sent.length;
    c.net.fire('error', { code: 'vote', msg: RUN_ASK_SOLO, solo: true });
    expect(c.hooks.log, 'строка — в лог, как прежде').toEqual([RUN_ASK_SOLO]);
    const box = asked();
    expect(box, 'было: только строка в логе про меню входа, которого в игре нет').toBeDefined();
    expect(c.net.sent.slice(sent), 'сам никуда не уходит — только кнопкой').toEqual([]);
    press(box!, SOLO_YES);
    await settled();
    expect(c.net.sent.slice(sent), 'выход из комнаты по ТОМУ ЖЕ сокету и статус забега').toEqual([{ t: 'leave' }, { t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
    expect(c.net.connects, 'связь не рвём').toBe(1);
    expect(flips.slice(-2), 'вне мира — раньше, чем снесён мир прошлой комнаты').toEqual(['out', 'lost']);
    expect(asked(), 'вопрос снят').toBeUndefined();
    c.net.fire('runStatus', { hasRun: true, roomCode: 'QWER', depth: 3 });
    expect(c.net.joins().at(-1), 'кнопка и была кликом: вход — сразу, без второго экрана').toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true, solo: true });
    expect(c.text(), 'экран «Продолжить / Забросить» не нужен').not.toContain('Незавершённое прохождение');
    expect(c.net.sent.filter((f) => f.t === 'abandon'), '«Забросить» не понадобилось').toEqual([]);
    c.net.fire('joined', {} as never);
    expect(c.root.children).toHaveLength(0);
    expect(flips.at(-1)).toBe('in');
  });

  it('D1: «Продолжить без пати» сразу не вошло («занято») — экран «Продолжить» с причиной, и его «Продолжить» повторяет «Соло»; забега уже нет — лобби', async () => {
    const c = client();
    enterWorld(c);
    c.net.fire('error', { code: 'vote', msg: RUN_ASK_SOLO, solo: true });
    press(asked()!, SOLO_YES);
    await settled();
    c.net.fire('runStatus', { hasRun: true, depth: 3 });
    const sent = c.net.sent.length;
    c.net.fire('error', { code: 'busy', msg: 'Сервер занят, попробуйте ещё раз' });
    expect(c.net.sent.slice(sent), 'статус заново — сам не входит').toEqual([{ t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
    c.net.fire('runStatus', { hasRun: true, depth: 3 });
    expect(c.text()).toContain('Незавершённое прохождение');
    expect(c.text(), 'и почему игрок здесь').toContain('Сервер занят');
    expect(c.text(), 'и что сделает «Продолжить»').toContain(SOLO_RESUME);
    c.click('[data-a="resume"]');
    expect(c.net.joins().at(-1), 'было бы: «Продолжить» к пати, что не пошла').toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true, solo: true });
    c.net.fire('joined', {} as never);

    // Пока выходили, забег кончился (пати завершила его без него) — лобби, вход не уходит.
    c.net.fire('error', { code: 'vote', msg: RUN_ASK_SOLO, solo: true });
    press(asked()!, SOLO_YES);
    await settled();
    const n = c.net.joins().length;
    c.net.fire('runStatus', { hasRun: false });
    expect(c.text()).toContain('Кооп');
    expect(c.net.joins()).toHaveLength(n);
    // Лобби сбрасывает «Соло»: «Соло» лобби — обычная новая комната.
    c.click('[data-a="solo"]');
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', fresh: true });
  });

  it('⭐ D1: в игре отказ спуска `run` — кнопка «Продолжить забег»: с кодом (забег ведёт другая комната) и без (у героя свой) — `join{resume}`', async () => {
    for (const roomCode of ['B3K9QZXA', undefined]) {
      const c = client();
      enterWorld(c);
      const sent = c.net.sent.length;
      const msg = roomCode ? `Этот забег идёт в комнате ${roomCode} — войдите к пати по коду` : 'У вас незавершённый забег — продолжите или завершите его';
      c.net.fire('error', { code: 'run', msg, ...(roomCode ? { roomCode } : {}) });
      const box = body.children.find((x) => x.text().includes(PARTY_YES));
      expect(box, `${roomCode}: было — только строка в логе`).toBeDefined();
      expect(box!.text()).toContain(partyAsk(roomCode));
      expect(c.net.sent.slice(sent), 'сам никуда не уходит').toEqual([]);
      press(box!, PARTY_YES);
      await settled();
      expect(c.net.sent.slice(sent)).toEqual([{ t: 'leave' }, { t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
      c.net.fire('runStatus', { hasRun: true, depth: 2 });
      expect(c.net.joins().at(-1), 'к комнате, что держит его забег, — «Продолжить», не «Соло»').toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
      c.net.fire('joined', {} as never);
      dismissAsk();
    }
  });

  it('R20-04, D1: «Остаться» — ничего не шлёт; прочие отказы `vote` (без `solo`) кнопки не дают; обрыв связи и смена области снимают кнопку', async () => {
    const c = client();
    enterWorld(c);
    const sent = c.net.sent.length;
    c.net.fire('error', { code: 'vote', msg: 'Уже идёт голосование — ответьте на него' });
    expect(asked(), 'обычный отказ голосования — только строка').toBeUndefined();
    c.net.fire('error', { code: 'vote', msg: RUN_ASK_SOLO, solo: true });
    press(asked()!, 'Остаться');
    await settled();
    expect(asked()).toBeUndefined();
    expect(c.net.sent.slice(sent), 'остался с пати — в комнате').toEqual([]);
    expect(c.root.children, 'экранов входа нет').toHaveLength(0);
    // Пати всё же пошла (голос прошёл) — вопрос о прошлой области снят сам.
    c.net.fire('error', { code: 'vote', msg: RUN_ASK_SOLO, solo: true });
    expect(asked()).toBeDefined();
    c.net.fire('areaChanged', {} as never);
    await settled();
    expect(asked(), 'область сменилась — кнопки нет').toBeUndefined();
    expect(c.net.sent.slice(sent)).toEqual([]);

    const d = client('hero-2');
    enterWorld(d);
    d.net.fire('error', { code: 'vote', msg: RUN_ASK_SOLO, solo: true });
    expect(asked()).toBeDefined();
    d.net.close(1006);
    await settled();
    expect(asked(), 'связь потеряна — вопрос снят «нет»').toBeUndefined();
    expect(d.net.void, 'и `leave` в мёртвый сокет не ушёл').toEqual([]);
  });

  it('⭐ R20-04: кадры комнаты, посланные ДО выхода, ещё в пути (окно голосования, отказы комнаты) — ответ на статус забега сносит их следы, вход уходит', async () => {
    let box = false;
    const c = client('hero-1', { onLost: () => { box = false; } });
    c.net.on('voteStart', () => { box = true; });   // как у сцены: окно голосования
    enterWorld(c);
    c.net.fire('error', { code: 'vote', msg: RUN_ASK_SOLO, solo: true });
    press(asked()!, SOLO_YES);
    await settled();
    // Сервер ещё не разобрал `leave`: напарник позвал голосование, команда и спуск получили отказы — все кадры приходят уже на плашку.
    c.net.fire('voteStart', {} as never);
    c.net.fire('error', { code: 'cmd', msg: 'Слишком часто' });
    c.net.fire('error', { code: 'vote', msg: 'Уже идёт голосование — ответьте на него' });
    expect(c.text(), 'отказы комнаты — не ответ лобби: плашка, а не лобби с чужой причиной').toContain('Подключение к серверу');
    c.net.fire('runStatus', { hasRun: true, roomCode: 'QWER', depth: 3 });
    expect(box, 'было бы: окно голосования прошлой комнаты поверх входа').toBe(false);
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true, solo: true });
    expect(c.text()).not.toContain('Слишком часто');
    // После ответа следы больше не сносятся: новая комната — свой мир.
    c.net.fire('joined', {} as never);
    c.net.fire('voteStart', {} as never);
    c.net.fire('runStatus', { hasRun: false });
    expect(box, 'голосование новой комнаты — на месте').toBe(true);
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

/**
 * ⭐ C-05, C-08: «ПРОДОЛЖИТЬ» ОТКАЗАН — ЗАБЕГ ВЕДЁТ ДРУГАЯ КОМНАТА (V2). Сервер держит один забег в одной комнате, и «Продолжить» идёт только к
 * ней: её нода — другая (`run`, кластер) или в её пати нет мест (`full`). Раньше отказ писался строкой на экран «Продолжить / Забросить», где
 * поля кода нет: «Продолжить» слало тот же вход и получало тот же отказ (F5 — тот же экран), и выходом оставалось «Забросить» (штраф смерти).
 * Теперь код держателя — полем кадра: к его ноде — сами (там снова «Продолжить»), а нет мест или идти некуда — лобби с этим кодом в поле
 * («Войти» — к пати, «Соло» — город, забег цел).
 */
describe('⭐ C-05, C-08: «Продолжить», отказанный из-за забега в другой комнате, — путь в игру без «Забросить»', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { vi.useFakeTimers(); G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body: new El('body') }; });
  afterEach(() => { vi.useRealTimers(); delete G.document; });

  const NODE0 = 'wss://game.example/ws/0';
  const NODE1 = 'wss://game.example/ws/1';
  const HOLDER = 'B3K9QZXA';
  const ELSEWHERE = `Этот забег идёт в комнате ${HOLDER} — войдите к пати по коду`;
  /** Поддельный гейтвей: по коду комнаты — нода по букве (B → NODE1), без кода — NODE0. */
  function gateway() {
    const calls: { roomCode?: string }[] = [];
    const route = (_t: string, _c: string, _ticket?: string, roomCode?: string): Promise<RouteAnswer> => {
      calls.push(roomCode ? { roomCode } : {});
      return Promise.resolve({ url: roomCode?.startsWith('B') ? NODE1 : NODE0 });
    };
    return { route, calls };
  }
  /** Экран «Незавершённое прохождение» (забег поднят из сейва: грейс-комнаты нет) и клик «Продолжить». */
  async function resumeClicked(c: ReturnType<typeof client>): Promise<void> {
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.net.open();
    c.net.fire('runStatus', { hasRun: true, depth: 3 });
    expect(c.text()).toContain('Незавершённое прохождение');
    c.click('[data-a="resume"]');
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
  }

  it('⭐ кластер: `run` с кодом держателя — маршрут к его ноде и там снова «Продолжить»; вход — экраны сняты', async () => {
    const gw = gateway();
    const c = client('hero-1', { route: gw.route });
    await resumeClicked(c);
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: HOLDER });
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.calls.at(-1), 'было: отказ строкой на экране без поля кода').toEqual({ roomCode: HOLDER });
    expect(c.net.urls).toEqual([NODE0, NODE1]);
    expect(c.text()).toContain('переходим к пати');
    c.net.open();
    // Там — снова «Продолжить» (свой забег, где бы он ни шёл), а не вход по коду: держатель мог отпустить забег, пока шли.
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
    expect(c.net.sent.filter((f) => f.t === 'abandon'), '«Забросить» не понадобилось').toEqual([]);
    c.net.fire('joined', {} as never);
    expect(c.root.children, 'в игре — экранов входа нет').toHaveLength(0);
  });

  it('второй такой отказ подряд (забег переехал, гонка закрепления) — не кружим: лобби с кодом держателя в поле; «Войти» — к нему', async () => {
    const gw = gateway();
    const c = client('hero-1', { route: gw.route });
    await resumeClicked(c);
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: HOLDER });
    await vi.advanceTimersByTimeAsync(0);
    c.net.open();
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: HOLDER });
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.calls, 'маршрут к держателю — один раз на клик').toHaveLength(2);
    expect(c.text(), 'лобби — поле кода и «Соло»').toContain('Кооп');
    expect(c.text()).toContain(ELSEWHERE);
    expect(c.screen()!.querySelector('.code').value, 'код держателя — уже в поле').toBe(HOLDER);
    c.click('[data-a="join"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.calls.at(-1)).toEqual({ roomCode: HOLDER });
    c.net.open();
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', roomCode: HOLDER });
  });

  it('⭐ пати забега полна (`full` с кодом) — лобби с кодом держателя и причиной: «Соло» — город, «Войти» — когда место освободится', () => {
    const c = client();
    c.start(); c.net.open();
    c.net.fire('runStatus', { hasRun: true, depth: 2 });
    c.click('[data-a="resume"]');
    c.net.fire('error', { code: 'full', msg: 'В комнате нет мест', roomCode: HOLDER });
    expect(c.text(), 'было: строка на экране «Продолжить / Забросить» — повтор давал тот же отказ').toContain('Кооп');
    expect(c.text()).toContain(`В пати забега нет мест (комната ${HOLDER})`);
    expect(c.text()).toContain('забег сохранён');
    expect(c.screen()!.querySelector('.code').value).toBe(HOLDER);
    c.click('[data-a="solo"]');
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', fresh: true });
    expect(c.net.sent.filter((f) => f.t === 'abandon')).toEqual([]);
  });

  it('старый сервер (код только в тексте) и одиночный процесс — тоже лобби с причиной, а не тот же экран', () => {
    for (const code of ['run', 'full'] as const) {
      const c = client();
      c.start(); c.net.open();
      c.net.fire('runStatus', { hasRun: true, depth: 1 });
      c.click('[data-a="resume"]');
      c.net.fire('error', { code, msg: code === 'run' ? ELSEWHERE : 'В комнате нет мест' });
      expect(c.text(), code).toContain('Кооп');
      expect(c.text(), code).not.toContain('Незавершённое прохождение');
      expect(c.net.urls, `${code}: без маршрута — к той же ноде не кружим`).toHaveLength(1);
    }
  });

  // ⭐ R17-05: кластер — к другу по коду поток подключился к ноде его комнаты (плашка «Подключение…»), и там вход отказан `run` без кода комнаты
  // (висит свой забег): было — `refused` → лобби со строкой «продолжите или завершите» без таких кнопок. Теперь — статус забега у той же ноды.
  it('⭐ R17-05: кластер — вход по коду (и «Соло») отказан `run` без кода комнаты — статус забега и «Продолжить / Забросить», а не лобби со строкой', async () => {
    for (const byCode of [true, false]) {
      for (const msg of [RUN_PARKED, RUN_CLASH]) {
        const gw = gateway();
        const c = client('hero-1', { route: gw.route });
        c.start();
        await vi.advanceTimersByTimeAsync(0);
        c.net.open(); c.net.fire('runStatus', { hasRun: false });
        if (byCode) {
          c.screen()!.querySelector('.code').value = HOLDER;
          c.click('[data-a="join"]');
          await vi.advanceTimersByTimeAsync(0);
          expect(c.net.urls).toEqual([NODE0, NODE1]);
          c.net.open();
          expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', roomCode: HOLDER });
        } else {
          c.click('[data-a="solo"]');
          expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', fresh: true });
        }
        const sent = c.net.sent.length;
        c.net.fire('error', { code: 'run', msg });
        expect(c.net.sent.slice(sent), `${byCode}/${msg}: было (по коду) — ничего, лобби «Кооп» со строкой и без кнопок`).toEqual([{ t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
        c.net.fire('runStatus', { hasRun: true, depth: 2 });
        expect(c.text()).toContain('Незавершённое прохождение');
        expect(c.text(), 'и почему').toContain(msg);
        c.click('[data-a="resume"]');
        expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
        expect(gw.calls, 'маршрут — только тот, что к ноде комнаты').toHaveLength(byCode ? 2 : 1);
      }
    }
  });

  // ⭐ R20-09: у ноды держателя «Продолжить» ответили «занят» (свод забега ещё не дописан, взятие в пути, слив, нода полна — с R18-02 это
  // ответ «повторите»). Было: плашка «Подключение…» → `refused` → лобби «Сервер занят» без «Продолжить» и без кода держателя; до «Продолжить» —
  // только «Соло», отказ `run` и новый статус (две лишние петли).
  const BUSY = { code: 'busy', msg: 'Сервер занят, попробуйте ещё раз' } as const;
  it('⭐ R20-09: после перехода к ноде держателя «Продолжить» ответили «занят» — экран «Продолжить» у той же ноды с причиной, а не лобби без кода', async () => {
    const gw = gateway();
    const c = client('hero-1', { route: gw.route });
    await resumeClicked(c);
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: HOLDER });
    await vi.advanceTimersByTimeAsync(0);
    c.net.open();
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
    const sent = c.net.sent.length;
    c.net.fire('error', BUSY);
    expect(c.text(), 'было: лобби без «Продолжить»').not.toContain('Кооп');
    expect(c.net.sent.slice(sent), 'статус забега — у той же ноды, сам не входит').toEqual([{ t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
    c.net.fire('runStatus', { hasRun: true, roomCode: HOLDER, depth: 3 });
    expect(c.text()).toContain('Незавершённое прохождение');
    expect(c.text(), 'и почему').toContain(BUSY.msg);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.net.joins(), 'без клика — ни одного входа').toHaveLength(2);
    c.click('[data-a="resume"]');
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
    expect(c.net.urls, 'та же нода — без нового маршрута').toEqual([NODE0, NODE1]);
    c.net.fire('joined', {} as never);
    expect(c.root.children).toHaveLength(0);
  });

  it('R20-09: иной отказ после перехода к держателю (лимит входа) — лобби с кодом держателя в поле; «занят» на вход по коду — лобби, как было', async () => {
    const gw = gateway();
    const c = client('hero-1', { route: gw.route });
    await resumeClicked(c);
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: HOLDER });
    await vi.advanceTimersByTimeAsync(0);
    c.net.open();
    c.net.fire('error', { code: 'rate', msg: 'Слишком часто — подождите немного' });
    expect(c.text()).toContain('Кооп');
    expect(c.text()).toContain('Слишком часто');
    expect(c.screen()!.querySelector('.code').value, 'было: поле пусто — «Войти» к пати не вело').toBe(HOLDER);

    const d = client('hero-1', { route: gateway().route });
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    d.net.open(); d.net.fire('runStatus', { hasRun: false });
    d.screen()!.querySelector('.code').value = HOLDER;
    d.click('[data-a="join"]');
    await vi.advanceTimersByTimeAsync(0);
    d.net.open();
    const sent = d.net.sent.length;
    d.net.fire('error', BUSY);
    expect(d.text(), 'вход по коду: «занят» — лобби с причиной, как было').toContain('Кооп');
    expect(d.text()).toContain(BUSY.msg);
    expect(d.net.sent.slice(sent)).toEqual([]);
  });

  it('в игре отказ `run` (спуск из города) — строкой в лог и вопросом; лобби поверх мира не рисуем, сами никуда не уходим', async () => {
    const gw = gateway();
    const c = client('hero-1', { route: gw.route });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.net.open(); c.net.fire('runStatus', { hasRun: false }); c.click('[data-a="solo"]'); c.net.fire('joined', {} as never);
    const sent = c.net.sent.length;
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: HOLDER });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.hooks.log).toEqual([ELSEWHERE]);
    expect(c.root.children).toHaveLength(0);
    expect(gw.calls).toHaveLength(1);
    expect(c.net.sent.slice(sent), 'без клика — никуда').toEqual([]);
    dismissAsk();
  });

  it('⭐ D1: «Продолжить без пати» у ноды, где держателя уже нет, — `run` с кодом: к его ноде, и там снова `join{resume, solo}`', async () => {
    const gw = gateway();
    const c = client('hero-1', { route: gw.route });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.net.open(); c.net.fire('runStatus', { hasRun: true, depth: 3 });
    // Экран «Продолжить» после «занято» — «Продолжить» с него несёт `solo` (см. выше); здесь — прямой вход с `solo`.
    c.flow.join({ resume: true, solo: true });
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true, solo: true });
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: HOLDER });
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.calls.at(-1)).toEqual({ roomCode: HOLDER });
    c.net.open();
    expect(c.net.joins().at(-1), 'право «Соло» — у держателя: туда и с ним').toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true, solo: true });
  });
});

/**
 * ⭐ D1: КНОПКА «ПРОДОЛЖИТЬ БЕЗ ПАТИ» — БЕЗ СРОКА. Право «Соло» на сервере не истекает само (правило общего забега): кнопка висит, пока игрок не
 * ответит, пока её не сменит новый вопрос или не сменится область комнаты. Раньше она снималась через 45 с — под срок отказа `RUN_ASK_MS` (R20-02).
 */
describe('⭐ D1: кнопка «Продолжить без пати» живёт до ответа', () => {
  const G = globalThis as unknown as { document?: unknown };
  let body: El;
  beforeEach(() => { vi.useFakeTimers(); body = new El('body'); G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body }; });
  afterEach(() => { dismissAsk(); vi.useRealTimers(); delete G.document; });
  const asked = (): El | undefined => body.children.find((x) => x.text().includes(SOLO_YES));

  it('минуты спустя вопрос на месте; новая подсказка — новый вопрос (ответ прежнего не в счёт); чужой вопрос его сменяет', async () => {
    const c = client();
    enterWorld(c);
    const sent = c.net.sent.length;
    c.net.fire('error', { code: 'vote', msg: RUN_ASK_SOLO, solo: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(asked(), 'срока нет').toBeDefined();
    c.net.fire('error', { code: 'vote', msg: RUN_ASK_SOLO, solo: true });   // спуск позван снова, пати снова не пошла
    expect(body.children.filter((x) => x.text().includes(SOLO_YES)), 'один вопрос, а не два').toHaveLength(1);
    let other: boolean | undefined;
    void askInGame('Разобрать здесь?').then((v) => { other = v; });
    await vi.advanceTimersByTimeAsync(0);
    expect(asked(), 'чужой вопрос сменил нашу кнопку').toBeUndefined();
    expect(other, 'чужой вопрос висит').toBeUndefined();
    expect(c.net.sent.slice(sent), 'и никуда не ушли').toEqual([]);
  });
});

/**
 * ⭐ R21-04: «ЭТОТ ЗАБЕГ ИДЁТ В КОМНАТЕ X. ПЕРЕЙТИ К ПАТИ?» — И ГЕРОЮ БЕЗ СВОЕГО ЗАБЕГА. Хозяин с припаркованным забегом и гость без забега стоят в
 * его городе, а забег держит другая комната X (напарник ушёл «Соло», V2; или комната другой ноды): спуск гостя — отказ `run` с кодом X (и всей
 * комнате — продолжение, которое не прошло из-за держателя). С D1 вопрос в игре предлагал «Продолжить забег» (`leave` → статус → `join{resume}`), а у
 * гостя забега нет: статус «забега нет» — и кнопка, обещавшая пати, уводила его из города пати в пустое лобби, без кода и без причины (лог игры
 * экраны входа прячут). Участник забега — герой, в чьём сейве этот забег (D1): ему «Продолжить» ведёт к держателю (правило 1); не участнику к пати
 * комнаты X ведёт вход по её коду.
 */
describe('⭐ R21-04: «Перейти к пати?» герою без своего забега — вход по коду комнаты пати, а не пустое лобби', () => {
  const G = globalThis as unknown as { document?: unknown };
  let body: El;
  beforeEach(() => { vi.useFakeTimers(); body = new El('body'); G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body }; });
  afterEach(() => { dismissAsk(); vi.useRealTimers(); delete G.document; });

  const PARTY = 'BXYZ1QWE';
  const ELSEWHERE = `Этот забег идёт в комнате ${PARTY} — войдите к пати по коду`;
  const NODE0 = 'wss://game.example/ws/0';
  const NODE1 = 'wss://game.example/ws/1';
  /** Вопрос в игре с кнопкой `label`, если он на экране. */
  const offered = (label: string): El | undefined => body.children.find((x) => !!findEl(x, (e) => e.tag === 'button' && e.textContent === label));
  const press = (label: string): void => { findEl(offered(label)!, (e) => e.tag === 'button' && e.textContent === label)!.click(); };
  /** Сейв сервера (`joined`, `saveUpdate`): с забегом или без. */
  const save = (run: boolean): never => ({ charId: 'hero-1', ...(run ? { run: { config: { seed: 1 }, currentNodeId: 'n0' } } : {}) }) as never;
  /** Гейтвей: по коду комнаты — нода по букве (B → NODE1), без кода — NODE0. */
  function gateway() {
    const calls: { roomCode?: string }[] = [];
    const route = (_t: string, _c: string, _ticket?: string, roomCode?: string): Promise<RouteAnswer> => {
      calls.push(roomCode ? { roomCode } : {});
      return Promise.resolve({ url: roomCode?.startsWith('B') ? NODE1 : NODE0 });
    };
    return { route, calls };
  }

  it('сейв клиенту не известен — «Продолжить забег»: `leave`, статус; «забега нет» — вход по коду X, а не лобби без кода', async () => {
    const c = client();
    enterWorld(c);
    const sent = c.net.sent.length;
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: PARTY });
    expect(offered(PARTY_YES)!.text()).toContain(partyAsk(PARTY));
    press(PARTY_YES);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.net.sent.slice(sent)).toEqual([{ t: 'leave' }, { t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
    c.net.fire('runStatus', { hasRun: false });
    expect(c.net.joins().at(-1), 'было: лобби без кода, вход не уходил — кнопка «к пати» уводила из города пати в никуда').toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', roomCode: PARTY });
    expect(c.text(), 'не лобби, а вход к пати').not.toContain('Кооп');
    expect(c.text(), 'и почему туда').toContain(PARTY);
    c.net.fire('joined', { save: save(true) } as never);
    expect(c.root.children, 'вошёл — экраны сняты').toHaveLength(0);
  });

  it('кластер: вход по коду — маршрут к ноде комнаты пати (по букве кода), там `join{roomCode}`', async () => {
    const gw = gateway();
    const c = client('hero-1', { route: gw.route });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.net.open(); c.net.fire('runStatus', { hasRun: false }); c.click('[data-a="solo"]'); c.net.fire('joined', { save: save(false) } as never);
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: PARTY });
    press(partyEnter(PARTY));
    await vi.advanceTimersByTimeAsync(0);
    c.net.fire('runStatus', { hasRun: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(gw.calls.at(-1), 'нода — комнаты пати, а не нода лобби (там её нет: «Комната не найдена»)').toEqual({ roomCode: PARTY });
    expect(c.net.urls.at(-1)).toBe(NODE1);
    c.net.open();
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', roomCode: PARTY });
  });

  it('⭐ по сейву: без забега — кнопка «Войти в комнату X» (не «Продолжить забег»); с забегом — «Продолжить забег» и `join{resume}`', async () => {
    const c = client();
    enterWorld(c);
    c.net.fire('saveUpdate', { save: save(false) });
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: PARTY });
    expect(offered(PARTY_YES), 'забега у героя нет — продолжать ему нечего').toBeUndefined();
    expect(offered(partyEnter(PARTY))!.text()).toContain(partyAsk(PARTY));
    const sent = c.net.sent.length;
    press(partyEnter(PARTY));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.net.sent.slice(sent), 'из комнаты — тем же сокетом, и статус забега').toEqual([{ t: 'leave' }, { t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
    c.net.fire('runStatus', { hasRun: false });
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', roomCode: PARTY });
    // Пока шли, у героя появился забег (сейв клиента устарел) — ответ сервера решает: он участник, «Продолжить» ведёт к держателю (правило 1).
    c.net.fire('joined', { save: save(false) } as never);
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: PARTY });
    press(partyEnter(PARTY));
    await vi.advanceTimersByTimeAsync(0);
    c.net.fire('runStatus', { hasRun: true, depth: 2 });
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
    // Участник (в сейве забег) — «Продолжить забег», как было.
    c.net.fire('joined', { save: save(true) } as never);
    c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: PARTY });
    expect(offered(partyEnter(PARTY))).toBeUndefined();
    press(PARTY_YES);
    await vi.advanceTimersByTimeAsync(0);
    c.net.fire('runStatus', { hasRun: true, depth: 2 });
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true });
    // Отказ без кода (у героя свой забег, R4-25) — «Продолжить забег» при любом сейве: сервер знает забег героя.
    c.net.fire('joined', { save: save(false) } as never);
    c.net.fire('error', { code: 'run', msg: 'У вас незавершённый забег — продолжите или завершите его' });
    expect(offered(PARTY_YES)!.text()).toContain(partyAsk());
  });

  it('вход по коду к пати отказан (нет мест, комнаты уже нет) — лобби с кодом X в поле и причиной; «Войти» — к ней снова', async () => {
    for (const refusal of [{ code: 'full', msg: 'В комнате нет мест' }, { code: 'no-room', msg: 'Комната не найдена' }]) {
      const c = client();
      enterWorld(c);
      c.net.fire('saveUpdate', { save: save(false) });
      c.net.fire('error', { code: 'run', msg: ELSEWHERE, roomCode: PARTY });
      press(partyEnter(PARTY));
      await vi.advanceTimersByTimeAsync(0);
      c.net.fire('runStatus', { hasRun: false });
      c.net.fire('error', refusal);
      expect(c.text(), refusal.code).toContain('Кооп');
      expect(c.text(), `${refusal.code}: причина`).toContain(refusal.msg);
      expect(c.screen()!.querySelector('.code').value, `${refusal.code}: было — поле пусто, код пати пропадал вместе с логом игры`).toBe(PARTY);
      c.click('[data-a="join"]');
      expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', roomCode: PARTY });
      dismissAsk();
    }
  });
});

/**
 * ⭐ R23-03: ОКНО ВЫХОДА КОНЧАЕТСЯ ЛЮБЫМ ОТВЕТОМ НА СТАТУС, А НЕ ТОЛЬКО КАДРОМ `runStatus`. Кнопка вопроса в игре («Продолжить без пати»,
 * «Продолжить забег») шлёт `leave` и статус забега тем же сокетом (`toEntry`), и до ответа поток отбрасывает отказы, которые шлёт только комната
 * (`leaving`: кадры прошлой комнаты ещё в пути). Флаг снимал лишь кадр `runStatus` — а на статус сервер отвечает и отказом: «занят» (база не
 * ответила, аренда ноды потеряна) во всех повторах, лимит кадров лобби, «неверный запрос». Поток уходил в лобби с поднятым флагом и дальше глотал
 * отказы `run` на клики игрока: «Соло» при припаркованном забеге (R16-01) молчал строкой «Подключение…», а вход по коду в кластере (отказ
 * `RUN_CLASH_JOIN` у ноды комнаты) оставлял плашку без кнопок до F5 — тупик правила 5 D1. И наоборот: отказ комнаты с кодом, который шлёт и
 * лобби (`rate` — голос чаще паузы, `busy` — «Продолжить» не собралось), ещё в пути после `leave` принимался за ответ на статус: лобби снимало
 * вход кнопки, и «Продолжить» с экрана по настоящему статусу вело к пати, что не пошла (без `solo`).
 */
describe('⭐ R23-03: окно выхода из мира кнопкой вопроса кончается любым ответом на статус; отказы комнаты в пути исхода не решают', () => {
  const G = globalThis as unknown as { document?: unknown };
  let body: El;
  beforeEach(() => { vi.useFakeTimers(); body = new El('body'); G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body }; });
  afterEach(() => { dismissAsk(); vi.useRealTimers(); delete G.document; });

  const BUSY = { code: 'busy', msg: 'Сервер занят, попробуйте ещё раз' } as const;
  const HOLDER = 'B3K9QZXA';
  const NODE0 = 'wss://game.example/ws/0';
  const NODE1 = 'wss://game.example/ws/1';
  /** Отказы комнаты игроку в ней — строки `server/net/room.ts`: спуск чаще паузы (`voteAllowed`), «Продолжить» не собралось, изъятие вещи. */
  const ROOM_RATE = { code: 'rate', msg: 'Подождите немного' } as const;
  const RESUME_FAILED = { code: 'busy', msg: 'Не удалось продолжить забег — позовите спуск снова' } as const;
  const LEDGER = { code: 'ledger', msg: 'Вещь с чужого аккаунта изъята: передавать вещи между аккаунтами нельзя' } as const;
  const STATUS = { t: 'runStatus', token: TOKEN, charId: 'hero-1' } as const;
  const statuses = (c: ReturnType<typeof client>): number => c.net.sent.filter((f) => f.t === 'runStatus').length;
  /** «Продолжить без пати» из мира: подсказка `solo`, кнопка — `leave` и статус тем же сокетом. */
  async function soloPressed(c: ReturnType<typeof client>): Promise<void> {
    c.net.fire('error', { code: 'vote', msg: RUN_ASK_SOLO, solo: true });
    const box = body.children.find((x) => x.text().includes(SOLO_YES));
    findEl(box!, (e) => e.tag === 'button' && e.textContent === SOLO_YES)!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.net.sent.slice(-2)).toEqual([{ t: 'leave' }, STATUS]);
  }
  /** Статус после выхода отказан «занят» и во всех повторах (база лежит ~15 с, аренда ноды потеряна) — лобби. */
  async function busyToLobby(c: ReturnType<typeof client>): Promise<void> {
    c.net.fire('error', BUSY);
    for (const ms of STATUS_RETRY_MS) { await vi.advanceTimersByTimeAsync(ms); c.net.fire('error', BUSY); }
    expect(c.text()).toContain('Кооп');
  }

  it('⭐ статус после «Продолжить без пати» — «занят» во всех повторах: лобби; отказ `run` на «Соло» (висит забег) ведёт к «Продолжить», а не глотается', async () => {
    const c = client();
    enterWorld(c);
    await soloPressed(c);
    await busyToLobby(c);
    c.click('[data-a="solo"]');
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', fresh: true });
    const sent = c.net.sent.length;
    c.net.fire('error', { code: 'run', msg: RUN_PARKED });
    expect(c.net.sent.slice(sent), 'было: отказ принят за кадр прошлой комнаты — строка «Подключение…», и ничего').toEqual([STATUS]);
    c.net.fire('runStatus', { hasRun: true, roomCode: 'QWER', depth: 3 });
    expect(c.text()).toContain('Незавершённое прохождение');
    expect(c.text(), 'и почему').toContain(RUN_PARKED);
  });

  /** Кластер: вошёл, «Продолжить без пати», статус «занят» во всех повторах — лобби; оттуда вход по коду — к ноде комнаты, там отказ `RUN_CLASH_JOIN`. */
  async function clusterClash(): Promise<ReturnType<typeof client>> {
    const route = (_t: string, _c: string, _k?: string, code?: string): Promise<RouteAnswer> => Promise.resolve({ url: code?.startsWith('B') ? NODE1 : NODE0 });
    const c = client('hero-1', { route });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.net.open(); c.net.fire('runStatus', { hasRun: false }); c.click('[data-a="solo"]'); c.net.fire('joined', {} as never);
    await soloPressed(c);
    await busyToLobby(c);
    c.screen()!.querySelector('.code').value = HOLDER;
    c.click('[data-a="join"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.net.urls).toEqual([NODE0, NODE1]);
    c.net.open();
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', roomCode: HOLDER });
    const sent = c.net.sent.length;
    c.net.fire('error', { code: 'run', msg: RUN_CLASH });
    expect(c.net.sent.slice(sent), 'было: отказ проглочен — плашка «Подключение к комнате…» без кнопок до F5').toEqual([STATUS]);
    return c;
  }

  it('⭐ кластер: после того же лобби вход по коду отказан у ноды комнаты `run` (`RUN_CLASH_JOIN`) — «Продолжить / Забросить», а не плашка без кнопок', async () => {
    const c = await clusterClash();
    c.net.fire('runStatus', { hasRun: true, depth: 2 });
    expect(c.text()).toContain('Незавершённое прохождение');
    expect(c.text(), 'и почему').toContain(RUN_CLASH);
  });

  it('у статуса новой плашки — свои повторы: там «занят» — повтор через 2 с, а не сразу лобби (попытки прошлой плашки кончились вместе с ней)', async () => {
    const c = await clusterClash();
    const asked = statuses(c);
    c.net.fire('error', BUSY);
    expect(c.text(), 'было: счёт попыток прошлой плашки — сразу лобби').not.toContain('Кооп');
    await vi.advanceTimersByTimeAsync(STATUS_RETRY_MS[0]);
    expect(statuses(c)).toBe(asked + 1);
    c.net.fire('runStatus', { hasRun: true, depth: 2 });
    expect(c.text()).toContain('Незавершённое прохождение');
    expect(c.text(), 'и почему').toContain(RUN_CLASH);
  });

  it('ответ на статус — отказ лобби (`bad-frame`; `auth` без крючка клиента): лобби с причиной, и окно выхода кончилось — отказ `run` на «Соло» не глотается', async () => {
    for (const answer of [{ code: 'bad-frame', msg: 'Неверный запрос' }, { code: 'auth', msg: 'Требуется вход' }]) {
      const c = client();
      enterWorld(c);
      await soloPressed(c);
      c.net.fire('error', answer);
      expect(c.text(), answer.code).toContain('Кооп');
      expect(c.text(), answer.code).toContain(answer.msg);
      c.click('[data-a="solo"]');
      const sent = c.net.sent.length;
      c.net.fire('error', { code: 'run', msg: RUN_PARKED });
      expect(c.net.sent.slice(sent), answer.code).toEqual([STATUS]);
      dismissAsk();
    }
  });

  it('⭐ отказы комнаты, посланные до того, как сервер разобрал `leave` (`rate` голоса, `busy` «не собралось», изъятие вещи), — не ответ на статус: вход кнопки уходит по настоящему', async () => {
    const c = client();
    enterWorld(c);
    await soloPressed(c);
    const sent = c.net.sent.length;
    for (const f of [ROOM_RATE, RESUME_FAILED, LEDGER]) c.net.fire('error', f);
    expect(c.text(), 'было: `rate` принят за ответ на статус — лобби, вход кнопки снят').toContain('Подключение к серверу');
    expect(c.text()).not.toContain('Кооп');
    c.net.fire('runStatus', { hasRun: true, roomCode: 'QWER', depth: 3 });
    expect(c.net.joins().at(-1), 'было: экран «Продолжить», чьё «Продолжить» — к пати, что не пошла (без `solo`)').toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true, solo: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.net.sent.slice(sent).filter((f) => f.t === 'runStatus'), 'повтор статуса снят ответом').toEqual([]);
  });

  it('кадры комнаты в пути не съедают повторов статуса: «занят» в ответ — те же три повтора, что без них, и вход кнопки не теряется', async () => {
    const c = client();
    enterWorld(c);
    await soloPressed(c);
    const asked = statuses(c);
    for (const f of [ROOM_RATE, RESUME_FAILED]) c.net.fire('error', f);
    c.net.fire('error', BUSY);   // настоящий ответ на статус — за кадрами комнаты
    for (const ms of STATUS_RETRY_MS.slice(0, -1)) { await vi.advanceTimersByTimeAsync(ms); c.net.fire('error', BUSY); }
    await vi.advanceTimersByTimeAsync(STATUS_RETRY_MS.at(-1)!);
    expect(statuses(c) - asked, 'три повтора — было бы: кадры комнаты съели два').toBe(STATUS_RETRY_MS.length);
    expect(c.text()).not.toContain('Кооп');
    c.net.fire('runStatus', { hasRun: true, depth: 3 });
    expect(c.net.joins().at(-1)).toEqual({ t: 'join', token: TOKEN, charId: 'hero-1', resume: true, solo: true });
  });
});

/**
 * ⭐ R23-03: ФАЗЗЕР ОКНА ВЫХОДА (`EntryFlow.toEntry`). Сервер разбирает кадры соединения по очереди: всё, что комната послала игроку до `leave`,
 * приходит РАНЬШЕ ответа на статус забега, а ответ — кадр `runStatus` или отказ лобби (`busy`, `rate`, `bad-frame`, `auth`). Сид задаёт вопрос в
 * игре (соло; к пати с кодом — участнику и гостю; свой забег без кода), кластер или нет, кадры комнаты в пути (`ROOM_SENT` — все отказы, что шлёт
 * `server/net/room.ts`; полноту держит сторож), ответы на каждый кадр лобби (статус, вход, «Забросить») и клики игрока на экранах входа.
 * Инварианты:
 *  (1) ТУПИКА НЕТ (D1, правило 5): всё отвечено, все сроки вышли — игрок в игре, в лобби или на экране «Продолжить», а не на плашке без кнопок;
 *  (2) КАДРЫ КОМНАТЫ В ПУТИ ИСХОДА НЕ МЕНЯЮТ: тот же сид без них — те же кадры лобби, те же ответы и те же экраны;
 *  (3) ОТКАЗ НА КАДР ЛОББИ НЕ ТЕРЯЕТСЯ: поток шлёт новый кадр, меняет экран или пишет причину — а не молчит.
 * Без правки R23-03 его ловят все три: лобби после «занят» глотало отказ `run` (3), в кластере — плашка (1), `rate` комнаты в пути уводил в лобби (2).
 */
describe('⭐ R23-03: фаззер окна выхода из мира — ответы лобби и кадры комнаты в пути в любом допустимом порядке', () => {
  const G = globalThis as unknown as { document?: unknown };
  let body: El;
  beforeEach(() => { vi.useFakeTimers(); body = new El('body'); G.document = { createElement: (t: string) => new El(t), getElementById: () => null, body }; });
  afterEach(() => { dismissAsk(); vi.useRealTimers(); delete G.document; });

  type Err = { code: string; msg: string; roomCode?: string; solo?: boolean };
  type Answer = { t: 'runStatus'; hasRun: boolean; depth?: number; roomCode?: string } | { t: 'joined' } | { t: 'abandoned' } | ({ t: 'error' } & Err);
  type Offer = 'solo' | 'party' | 'guest' | 'own';
  /** ~0.3 мс на сид: 3000 — и редкие цепочки (попытки прошлой плашки, дошедшие до новой, — сид 2849). */
  const SEEDS = Number(process.env.DM_ENTRY_FUZZ_SEEDS ?? 3000);
  const HOLDER = 'B3K9QZXA';
  const ELSEWHERE = `Этот забег идёт в комнате ${HOLDER} — войдите к пати по коду`;
  const NODE0 = 'wss://game.example/ws/0';
  const NODE1 = 'wss://game.example/ws/1';
  const SAVING = 'Сохраняем прогресс героя — повторите вход через несколько секунд';
  /** Все отказы, что комната шлёт игроку в ней (`server/net/room.ts`), — строки сервера. */
  const ROOM_SENT: readonly Err[] = [
    { code: 'busy', msg: 'Сервер перезапускается — войдите через несколько секунд' },   // FROZEN
    { code: 'busy', msg: 'Не удалось продолжить забег — позовите спуск снова' },   // RESUME_FAILED
    { code: 'rate', msg: 'Подождите немного' },   // voteAllowed
    { code: 'vote', msg: RUN_ASK_SOLO, solo: true },
    { code: 'vote', msg: 'Уже идёт голосование — ответьте на него' },
    { code: 'cmd', msg: 'Слишком часто' },
    { code: 'far', msg: 'Подойдите к порталу' },
    { code: 'run', msg: RUN_PARKED },
    { code: 'run', msg: ELSEWHERE, roomCode: HOLDER },
    { code: 'ledger', msg: 'Вещь с чужого аккаунта изъята: передавать вещи между аккаунтами нельзя' },
  ];
  /** Ответы лобби на статус забега (`RoomManager`, кадр `runStatus`), с весами. */
  const STATUS_ANS: readonly (readonly [Answer, number])[] = [
    [{ t: 'runStatus', hasRun: true, depth: 2 }, 3],
    [{ t: 'runStatus', hasRun: true, depth: 3, roomCode: 'QWER' }, 1],
    [{ t: 'runStatus', hasRun: false }, 2],
    [{ t: 'error', code: 'busy', msg: 'Сервер занят, попробуйте ещё раз' }, 4],
    [{ t: 'error', code: 'rate', msg: 'Слишком много запросов — подождите немного' }, 2],
    [{ t: 'error', code: 'bad-frame', msg: 'Неверный запрос' }, 1],
    [{ t: 'error', code: 'auth', msg: 'Требуется вход' }, 1],
  ];
  /** Ответы на вход (`RoomManager.join`) — по его виду: новая комната, по коду, «Продолжить». */
  const JOIN_ANS: Record<'fresh' | 'code' | 'resume', readonly (readonly [Answer, number])[]> = {
    fresh: [
      [{ t: 'joined' }, 4],
      [{ t: 'error', code: 'busy', msg: SAVING }, 1],
      [{ t: 'error', code: 'busy', msg: 'Сервер заполнен — войдите через несколько минут' }, 1],
      [{ t: 'error', code: 'run', msg: RUN_PARKED }, 2],
      [{ t: 'error', code: 'rate', msg: 'Слишком часто создаёте комнаты' }, 1],
    ],
    code: [
      [{ t: 'joined' }, 4],
      [{ t: 'error', code: 'busy', msg: SAVING }, 1],
      [{ t: 'error', code: 'run', msg: RUN_PARKED }, 1],
      [{ t: 'error', code: 'run', msg: RUN_CLASH }, 1],
      [{ t: 'error', code: 'no-room', msg: 'Комната не найдена' }, 1],
      [{ t: 'error', code: 'full', msg: 'В комнате нет мест' }, 1],
      [{ t: 'error', code: 'rate', msg: 'Слишком часто — подождите немного' }, 1],
    ],
    resume: [
      [{ t: 'joined' }, 4],
      [{ t: 'error', code: 'busy', msg: 'Сервер занят, попробуйте ещё раз' }, 1],
      [{ t: 'error', code: 'busy', msg: SAVING }, 1],
      [{ t: 'error', code: 'run', msg: ELSEWHERE, roomCode: HOLDER }, 1],
      [{ t: 'error', code: 'full', msg: 'В комнате нет мест', roomCode: HOLDER }, 1],
      [{ t: 'error', code: 'no-run', msg: 'Забег не найден' }, 1],
      [{ t: 'error', code: 'rate', msg: 'Слишком часто — подождите немного' }, 1],
    ],
  };
  /** Кластер: и «герой на другом узле» (закрепление героя — у другой ноды). */
  const WRONG_NODE: readonly [Answer, number] = [{ t: 'error', code: 'wrong-node', msg: 'Персонаж в игре на другом узле — войдите заново' }, 1];
  const joinAnswers = (f: ClientFrame, cluster: boolean): readonly (readonly [Answer, number])[] => {
    const j = f as Extract<ClientFrame, { t: 'join' }>;
    const table = JOIN_ANS[j.resume ? 'resume' : j.roomCode ? 'code' : 'fresh'];
    return cluster ? [...table, WRONG_NODE] : table;
  };
  const ABANDON_ANS: readonly (readonly [Answer, number])[] = [[{ t: 'abandoned' }, 2], [{ t: 'error', code: 'busy', msg: SAVING }, 1]];
  const LOBBY: ReadonlySet<string> = new Set(['runStatus', 'join', 'abandon']);

  function weighted<T>(r: Rng, table: readonly (readonly [T, number])[]): T {
    let x = r.next() * table.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of table) { x -= w; if (x < 0) return v; }
    return table.at(-1)![0];
  }
  const save = (run: boolean): never => ({ charId: 'hero-1', ...(run ? { run: { config: { seed: 1 }, currentNodeId: 'n0' } } : {}) }) as never;
  const kindOf = (c: ReturnType<typeof client>): 'game' | 'plate' | 'lobby' | 'resume' => {
    if (!c.screen()) return 'game';
    const t = c.text();
    return t.includes('Кооп') ? 'lobby' : t.includes('Незавершённое прохождение') ? 'resume' : 'plate';
  };
  /** Кадр лобби — строкой следа (без токена). */
  const shown = (f: ClientFrame): string => { const { token: _t, charId: _c, ...rest } = f as ClientFrame & { token?: string; charId?: string }; return JSON.stringify(rest); };

  /** Прогон сида: `withFlying` — с кадрами комнаты в пути после `leave` (иначе — тот же сид без них). Возвращает след прогона. */
  async function play(seed: number, withFlying: boolean): Promise<string[]> {
    const r = createRng((seed * 2654435761) >>> 0 || 1);   // сценарий
    const offer = r.pick<Offer>(['solo', 'solo', 'party', 'guest', 'own']);
    const cluster = r.chance(0.5);
    const flying = Array.from({ length: r.int(0, 4) }, () => r.pick(ROOM_SENT));
    const a = createRng((seed * 40503 + 7) >>> 0 || 3);   // ответы сервера и клики игрока — одни на оба прогона
    const where = `сид ${seed} (${offer}${cluster ? ', кластер' : ''}${withFlying ? `, в пути: ${flying.map((f) => f.code).join(',') || '—'}` : ''})`;
    const trace: string[] = [];
    const route = (_t: string, _c: string, _k?: string, code?: string): Promise<RouteAnswer> => Promise.resolve({ url: code?.startsWith('B') ? NODE1 : NODE0 });
    const c = client('hero-1', cluster ? { route } : {});
    c.net.autoOpen = true;
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.net.fire('runStatus', { hasRun: false });
    c.click('[data-a="solo"]');
    c.net.fire('joined', { save: save(offer !== 'guest') } as never);
    // Вопрос в игре и его кнопка — `leave` и статус забега тем же сокетом.
    const ask: Err = offer === 'solo' ? { code: 'vote', msg: RUN_ASK_SOLO, solo: true }
      : offer === 'own' ? { code: 'run', msg: RUN_PARKED } : { code: 'run', msg: ELSEWHERE, roomCode: HOLDER };
    c.net.fire('error', ask);
    const yes = offer === 'solo' ? SOLO_YES : offer === 'guest' ? partyEnter(HOLDER) : PARTY_YES;
    const box = body.children.find((x) => !!findEl(x, (e) => e.tag === 'button' && e.textContent === yes));
    expect(box, `${where}: вопрос с кнопкой «${yes}»`).toBeDefined();
    findEl(box!, (e) => e.tag === 'button' && e.textContent === yes)!.click();
    await vi.advanceTimersByTimeAsync(0);
    let next = c.net.sent.length - 1;
    expect(c.net.sent.slice(-2), where).toEqual([{ t: 'leave' }, { t: 'runStatus', token: TOKEN, charId: 'hero-1' }]);
    if (withFlying) for (const f of flying) c.net.fire('error', f);
    const dump = (): string => `${where}\n${trace.join('\n')}`;
    let acts = 0;
    for (let step = 0; step < 120; step++) {
      while (next < c.net.sent.length && !LOBBY.has(c.net.sent[next]!.t)) next++;
      if (next < c.net.sent.length) {
        const f = c.net.sent[next++]!;
        const ans = weighted(a, f.t === 'runStatus' ? STATUS_ANS : f.t === 'abandon' ? ABANDON_ANS : joinAnswers(f, cluster));
        trace.push(`→ ${shown(f)} ← ${ans.t === 'error' ? `error:${ans.code}` : JSON.stringify(ans)}`);
        const before = { sent: c.net.sent.length, screen: c.screen(), connects: c.net.connects };
        const { t, ...rest } = ans;
        c.net.fire(t, rest as never);
        await vi.advanceTimersByTimeAsync(0);
        if (ans.t === 'error') {
          const moved = c.net.sent.length !== before.sent || c.screen() !== before.screen || c.net.connects !== before.connects || c.text().includes(ans.msg);
          expect(moved, `(3) отказ «${ans.code}» на ${f.t} потерян — поток не сдвинулся и не сказал причины: ${dump()}`).toBe(true);
        }
        continue;
      }
      const n = c.net.sent.length;
      await vi.advanceTimersByTimeAsync(20_000);   // сроки повторов статуса (2/4/8 с)
      if (c.net.sent.length !== n) continue;
      const k = kindOf(c);
      trace.push(`= ${k}`);
      expect(k, `(1) тупик — плашка без кнопок, а ответов ждать не от чего: ${dump()}`).not.toBe('plate');
      if (k === 'game' || acts++ >= 3) break;
      // Игрок жмёт кнопку экрана входа.
      let what: string;
      if (k === 'lobby') {
        if (a.chance(0.5)) { what = 'solo'; c.click('[data-a="solo"]'); }
        else { what = a.chance(0.5) ? HOLDER : 'A7K3F9XY'; c.screen()!.querySelector('.code').value = what; c.click('[data-a="join"]'); }
      } else { what = a.chance(0.7) ? 'resume' : 'abandon'; c.click(`[data-a="${what}"]`); }
      trace.push(`click ${what}`);
      await vi.advanceTimersByTimeAsync(0);
    }
    c.flow.detach();
    dismissAsk();
    return trace;
  }

  it(`(1) тупика нет, (2) кадры комнаты в пути исхода не меняют, (3) отказ на кадр лобби не теряется — ${SEEDS} сидов`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const base = await play(seed, false);
      const hit = await play(seed, true);
      expect(hit, `сид ${seed}: (2) кадры комнаты в пути после \`leave\` изменили исход; без них:\n${base.join('\n')}`).toEqual(base);
    }
  }, Math.max(120_000, SEEDS * 40));   // запас — на загруженную машину (полный прогон идёт параллельно)

  it('сторож модели: `ROOM_SENT` — все коды отказов `server/net/room.ts`, и поток знает каждый — «только комната» или «и лобби»', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../server/src/net/room.ts'), 'utf8');
    const codes = new Set([...src.matchAll(/t: 'error', code: '([a-z-]+)'/g)].map((m) => m[1]!));
    expect(codes.size, 'разбор отказов комнаты сломался').toBeGreaterThan(3);
    expect(new Set(ROOM_SENT.map((f) => f.code)), 'новый отказ комнаты — в модель фаззера').toEqual(codes);
    for (const code of codes) {
      expect(ROOM_ONLY_ERRORS.has(code) || ROOM_SHARED_ERRORS.has(code), `${code}: в окне выхода поток принял бы отказ комнаты за ответ на статус`).toBe(true);
    }
    // Ответы на статус забега (`RoomManager`, кадр `runStatus`): «занят», лимит лобби, вход и герой недействительны, кривой кадр — ни один не «только комната».
    for (const code of ['busy', 'rate', 'auth', 'forbidden', 'bad-frame']) expect(ROOM_ONLY_ERRORS.has(code), code).toBe(false);
    for (const [ans] of STATUS_ANS) if (ans.t === 'error') expect(ROOM_ONLY_ERRORS.has(ans.code), ans.code).toBe(false);
  });
});
