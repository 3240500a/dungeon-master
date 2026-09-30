import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConfigRegistry, CRAFT_SLOT_LIST, anatomyOf, craftAction, createRng, defaultParts, emptyJournal, emptyStash, enchantAction, fullJournal,
  keySlotOf, newBotSave, parseClientFrame, sketchAction, variantsFor,
  type AccountStash, type CraftJournal, type SaveState, type ServerFrame,
} from '@dm/shared';

/**
 * ⭐ L2: КУЗНИЦА ПО-НАСТОЯЩЕМУ, С КОВКОЙ ОТКРЫТОЙ В ДАННЫХ (`balance.craft.live` = true, R4-03) — от клика до сервера и
 * обратно. Прочие тесты кузницы проверяют окно с поддельным хозяином или хозяина с поддельной связью; здесь всё
 * клиентское настоящее: `App` (ожидание ответа `request`, приём сундука `applyStash`), `NetClient` (провод JSON),
 * окно кузницы с вкладкой «Ковка» (грузится тем же `import()`), игровой хозяин, верстак. Поддельный — только сокет и
 * сервер за ним, и тот сервер:
 * - пропускает КАЖДЫЙ кадр клиента через `parseClientFrame` — ту же строгую схему, что стоит на входе настоящего
 *   (лишний ключ в заявке отказал бы всю ковку «неверной командой»);
 * - исполняет команды ТЕМИ ЖЕ ядрами, что `Room` (`craftAction` / `enchantAction` / `sketchAction`), и отвечает в том же
 *   порядке: сундук → `saveUpdate` → `cmdResult` (D3), отказ — `error{cmd}` + `cmdResult`.
 * Ворота `craft.live` в самой `Room` и транзакции с базой проверяет `server/src/net/room.run.test.ts` (R4-03).
 *
 * 3D-стенд сборки в node не рисуется (WebGL) — подменён; DOM — заглушка ровно тех свойств, которыми пользуются окна.
 */
// ⚠ ПОТОЛКИ — ПОД ЗАГРУЗКУ МОДУЛЕЙ, А НЕ ПОД ГОНКИ. Каждый тест — свежий граф клиента (`vi.resetModules`: `App`, окна, а по клику «Ковка» —
// ленивая вкладка ковки со всем, что она тянет), и каждый его модуль воркер заново просит у главного процесса vitest. Поодиночке это доли
// секунды, а под нагрузкой полного прогона (главный процесс разбирает модули всех файлов) — секунды: тест падал временем (умолчание 5 с,
// ожидание окна 3 с), не утверждением. Проверки от этого не зависят: `until` ждёт состояние окна и выходит, как только оно есть.
vi.setConfig({ testTimeout: 60_000 });

vi.mock('./craftPreview3d.js', () => ({
  weaponPreview3d: () => (globalThis as unknown as { document: { createElement: (t: string) => unknown } }).document.createElement('div'),
  resumePreview3d: () => { },
}));

class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; disabled = false; title = ''; colSpan = 1; value = '';
  parent: El | null = null; isConnected = true;
  private html = '';
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string) { }
  set innerHTML(v: string) { this.children = []; this.html = v; }
  get innerHTML(): string { return this.html; }
  get lastChild(): El | null { return this.children[this.children.length - 1] ?? null; }
  get parentElement(): El | null { return this.parent; }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: (El | string)[]): void {
    for (const x of c) {
      if (typeof x === 'string') continue;
      const i = x.parent ? x.parent.children.indexOf(x) : -1;   // узел переезжает, а не копируется
      if (i >= 0) x.parent!.children.splice(i, 1);
      x.parent = this; this.children.push(x);
    }
  }
  appendChild(c: El): El { this.append(c); return c; }
  replaceChildren(...c: El[]): void { this.children = []; this.append(...c); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  click(): void { if (!this.disabled) for (const f of this.on.get('click') ?? []) f(); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  text(): string { return [this.html, this.textContent, ...this.all().map((c) => `${c.html} ${c.textContent}`)].join(' | '); }
  button(label: string): El | undefined { return this.all().find((e) => e.tag === 'button' && e.textContent.includes(label)); }
  /** Строка списка деталей окна ковки по имени детали (её разметка — в innerHTML). */
  row(name: string): El | undefined { return this.all().find((e) => e.tag === 'button' && e.innerHTML.includes(`${name}</span>`)); }
  /** Карточка действия верстака по заголовку (первая строка карточки). */
  card(title: string): El | undefined { return this.all().find((e) => e.tag === 'div' && e.children[0]?.textContent.includes(title)); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const wallet = (): Record<string, number> => Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 999]));

/** Сокет браузера — подделка; «сеть» — синхронный вызов сервера. */
class FakeWs {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static last: FakeWs | null = null;
  static serve: (raw: string) => void = () => { };
  readyState = FakeWs.CONNECTING; binaryType = '';
  onopen: (() => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) { FakeWs.last = this; }
  send(raw: string): void { FakeWs.serve(raw); }
  close(): void { this.readyState = FakeWs.CLOSED; }
  open(): void { this.readyState = FakeWs.OPEN; this.onopen?.(); }
  push(f: ServerFrame): void { this.onmessage?.({ data: JSON.stringify(f) }); }
}

/** Сервер за сокетом: свой сейв и сундук аккаунта, те же ядра и тот же порядок кадров, что у `Room`. */
function fakeServer(save: SaveState, stash: AccountStash) {
  const S = { save: structuredClone(save), stash: structuredClone(stash), cmds: [] as string[], rejected: [] as string[] };
  let seed = 7;
  const push = (f: ServerFrame): void => FakeWs.last!.push(f);
  const sendStash = (): void => push({ t: 'stash', tabs: S.stash.tabs, cols: 20, rows: 12, tabCount: 2, materials: S.stash.materials ?? {}, forgeJournal: S.stash.forgeJournal ?? emptyJournal() });
  FakeWs.serve = (raw) => {
    const f = parseClientFrame(raw);
    if (!f) { S.rejected.push(raw); return; }   // настоящий сервер такой кадр отбросил бы
    if (f.t !== 'cmd') return;
    const c = f.command;
    S.cmds.push(c.cmd);
    const live = reg.get('balance').craft.live;
    const closed = { ok: false, reason: 'Кузнец ещё не куёт' };
    let out: { ok: boolean; reason?: string; uid?: string; unlocked?: string[] };
    let stashTouched = false;
    switch (c.cmd) {
      case 'stashOpen': sendStash(); out = { ok: true }; break;
      case 'craft': out = live ? craftAction(reg, S.save, S.stash, c.nonce, c.input, createRng(seed++)) : closed; stashTouched = out.ok; break;
      case 'forgeEnchant': out = live ? enchantAction(reg, S.save, c.uid, c.rarity, createRng(seed++)) : closed; break;
      case 'forgeSketch': out = sketchAction(reg, S.stash, c.variantId); stashTouched = out.ok; break;
      default: out = { ok: false, reason: `сервер теста не исполняет ${c.cmd}` };
    }
    if (out.ok) { if (stashTouched) sendStash(); push({ t: 'saveUpdate', save: S.save }); }
    else push({ t: 'error', code: 'cmd', msg: out.reason ?? '' });
    push({
      t: 'cmdResult', ...(f.id !== undefined ? { id: f.id } : {}), cmd: c.cmd, ok: out.ok,
      ...(out.reason !== undefined ? { reason: out.reason } : {}), ...(out.uid !== undefined ? { uid: out.uid } : {}),
      ...(out.unlocked !== undefined ? { unlocked: out.unlocked } : {}),
    });
  };
  return S;
}

/** Герой с золотом и пустой сумкой; сундук с сырьём и журналом. */
function hero(journal: CraftJournal = fullJournal(reg)): { save: SaveState; stash: AccountStash } {
  const save = newBotSave(reg, reg.get('classes')[0]!.id);
  save.gold = 1_000_000; save.inventory = [];
  return { save, stash: { ...emptyStash(reg), materials: wallet(), forgeJournal: journal } };
}

/**
 * Клиент как в игре: свежие модули (у окна ковки и хозяина память на странице), настоящий `App`, сокет открыт, сейв
 * героя из «входа», `saveUpdate` — как у обоих клиентов (новый сейв + перерисовка окон).
 */
async function client(save: SaveState) {
  vi.resetModules();
  const [{ App }, { GameState }, { forgePanel }, { forgeBench }] = await Promise.all([
    import('../../core/app.js'), import('../../core/gameState.js'), import('./forgePanel.js'), import('./forgeBench.js'),
  ]);
  const app = new App();
  app.net.connect('ws://test/ws');
  FakeWs.last!.open();
  const st = new GameState(structuredClone(save)); st.restoreFull(); app.state = st;
  app.net.on('saveUpdate', (f) => { app.state!.save = f.save; app.bus.emit('state:changed', {}); });
  return { app, forgePanel, forgeBench };
}

/** Окно кузницы как в `DomUi`: тело перерисовывается на каждое `state:changed`. */
function mountForge(c: Awaited<ReturnType<typeof client>>) {
  const body = new El('div');
  const panel = c.forgePanel(c.app, { openPanel: () => { } } as never);
  const render = (): void => { body.innerHTML = ''; panel.render(body as unknown as HTMLElement); };
  c.app.bus.on('state:changed', render);
  render();
  return body;
}
/** Ждать состояние окна (ответ «сервера», догрузку вкладки ковки); потолок щедрый — см. шапку файла про загрузку модулей под нагрузкой. */
const until = (f: () => void): Promise<void> => vi.waitFor(f, { timeout: 30_000, interval: 5 });

describe('⭐ L2: кузница с открытой ковкой — клик → провод → сервер → окно', () => {
  const G = globalThis as unknown as { document?: unknown; WebSocket?: unknown };
  let savedWs: unknown;
  beforeEach(() => {
    G.document = { createElement: (t: string) => new El(t), body: new El('body') };
    savedWs = G.WebSocket; G.WebSocket = FakeWs;
  });
  afterEach(() => { delete G.document; G.WebSocket = savedWs; FakeWs.last?.close(); });

  it('⭐ «Ковка» → «Ковать» куёт на сервере, окно показывает вещь; «✦ Магический» из окна зачаровывает её', async () => {
    expect(reg.get('balance').craft.live, 'balance.craft.live в data/balance.json').toBe(true);
    const h = hero();
    const S = fakeServer(h.save, h.stash);
    const c = await client(h.save);
    const body = mountForge(c);
    await until(() => expect(c.app.stash?.forgeJournal, 'кузница запросила сундук с журналом').toBeTruthy());

    body.button('Ковка')!.click();
    await until(() => expect(body.button('Ковать'), 'вкладка загрузила окно ковки').toBeTruthy());
    expect(body.text()).not.toContain('ещё не куёт');
    const forge = body.button('Ковать')!;
    expect(forge.disabled, `кнопка ковки живая: ${forge.title}`).toBe(false);
    const matsBefore = { ...S.stash.materials };
    forge.click();
    await until(() => expect(body.text()).toContain('Скована:'));
    expect(S.rejected, 'все кадры клиента прошли строгую схему сервера').toEqual([]);
    expect(S.cmds).toEqual(['stashOpen', 'craft']);
    expect(S.save.inventory, 'сервер сковал одну вещь').toHaveLength(1);
    const made = S.save.inventory[0]!;
    expect(c.app.state!.save.inventory.map((i) => i.uid), 'сейв клиента — с сервера (`saveUpdate`)').toEqual([made.uid]);
    expect(S.stash.materials, 'сырьё списано').not.toEqual(matsBefore);
    expect(c.app.stash!.materials, 'кошелёк окна — из кадра сундука после ковки').toEqual(S.stash.materials);

    const magic = body.button('Магический');
    expect(magic, 'у скованной обычной вещи — зачарование').toBeTruthy();
    expect(magic!.disabled, `зачарование живое: ${magic!.title}`).toBe(false);
    magic!.click();
    await until(() => expect(body.text()).toContain('Зачарована:'));
    expect(S.cmds.at(-1)).toBe('forgeEnchant');
    expect(S.rejected).toEqual([]);
    expect(S.save.inventory.find((i) => i.uid === made.uid)!.rarity, 'сервер зачаровал').toBe('magic');
    expect(c.app.state!.save.inventory.find((i) => i.uid === made.uid)!.rarity, 'и клиент видит это из сейва').toBe('magic');
    expect(body.button('Магический')!.disabled, 'второй раз не зачаровать').toBe(true);
  });

  it('⭐ верстак: карточка «✦ Редкий» скованной вещи уходит по проводу, сервер зачаровывает, отказа нет', async () => {
    const h = hero();
    const r = craftAction(reg, h.save, h.stash, '0123456789abcdef0123456789abcdef', { weaponClass: 'sword', hands: 1, parts: defaultParts(reg, 'sword', 1, 2)! }, createRng(3));
    expect(r.ok, r.reason).toBe(true);
    const S = fakeServer(h.save, h.stash);
    const c = await client(h.save);
    c.app.applyStash({ t: 'stash', tabs: [], cols: 20, rows: 12, tabCount: 2, materials: S.stash.materials ?? {}, forgeJournal: S.stash.forgeJournal ?? emptyJournal() });
    let note = '';
    const opts = { uid: r.uid!, setUid: () => { }, get note() { return note; }, setNote: (n: string) => { note = n; } };
    const bench = (): El => c.forgeBench(c.app, opts) as unknown as El;
    const card = bench().card('Редкий');
    expect(card, 'карточка зачарования на верстаке').toBeTruthy();
    card!.click();
    await until(() => expect(S.save.inventory.find((i) => i.uid === r.uid)!.rarity).toBe('rare'));
    await until(() => expect(c.app.state!.save.inventory.find((i) => i.uid === r.uid)!.rarity).toBe('rare'));
    expect(S.cmds).toEqual(['forgeEnchant']);
    expect(S.rejected).toEqual([]);
    await until(() => expect(bench().text(), 'карточки снова живые — ответ пришёл').not.toContain('⏳'));
    expect(note, 'отказа нет').not.toContain('⚠');
  });

  it('⭐ эскиз: закрытая деталь → «✦ Открыть эскизом» → forgeSketch по проводу → журнал из кадра сундука', async () => {
    const save0 = hero().save;
    const cls = save0.equipment.weapon?.weaponClass;
    const wc = cls && anatomyOf(reg, cls) ? cls : 'sword';   // окно открывается на классе того, что в руках (`startClass`)
    const { initialCraftState } = await import('./craftPanel.js');
    const init = initialCraftState(reg, wc);
    const slot = CRAFT_SLOT_LIST.find((s) => s !== keySlotOf(reg, wc))!;
    const target = variantsFor(reg, wc, slot, init.hands).filter((p) => p.id !== init.parts[slot].id).at(-1)!;
    expect(target, 'есть закрытая к эскизу деталь').toBeTruthy();
    const full = fullJournal(reg);
    const h = hero({ ...full, variants: full.variants.filter((v) => v !== target.id), sketches: 1 });
    const S = fakeServer(h.save, h.stash);
    const c = await client(h.save);
    const body = mountForge(c);
    await until(() => expect(c.app.stash?.forgeJournal).toBeTruthy());
    body.button('Ковка')!.click();
    await until(() => expect(body.text()).toContain('Эскизов: 1'));
    const row = body.row(target.name)!;
    expect(row.innerHTML, 'закрытая деталь открываема эскизом').toContain(`✦ ${target.name}`);
    row.click();
    body.button('Открыть эскизом')!.click();
    await until(() => expect(body.text()).toContain(`Открыто эскизом: ${target.name}`));
    expect(S.cmds).toEqual(['stashOpen', 'forgeSketch']);
    expect(S.rejected).toEqual([]);
    expect(S.stash.forgeJournal!.variants, 'сервер открыл деталь в журнале аккаунта').toContain(target.id);
    expect(S.stash.forgeJournal!.sketches).toBe(0);
    expect(c.app.stash!.forgeJournal!.variants, 'журнал окна — из кадра сундука').toContain(target.id);
    expect(body.text(), 'эскизов не осталось — плашки нет').not.toContain('Эскизов:');
    expect(body.row(target.name)!.innerHTML, 'деталь открыта').not.toContain('✦');
  });
});
