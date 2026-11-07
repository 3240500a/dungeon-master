import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, cfgKey, itemFromBaseId, newCharacterSave, sheetView, tr, SRV_CORPUS, pseudoForms, type ServerFrame, type SaveState, type Interactable,
  type AccountStash, type Item, type SessionEvent,
} from '@dm/shared';
import { limits } from './rateLimit.js';
import { inTextLang, langFromAcceptLanguage, requestLang, scopeCodeOf } from './textScope.js';

vi.setConfig({ testTimeout: 20_000 });

/**
 * ⭐ i18n Ф1 (06.11): СЕРВЕР ГОВОРИТ НА ЯЗЫКЕ ИГРОКА. Настоящий менеджер комнат и комната, база — маленькая честная. В таблицу `locales`
 * добавлен тестовый язык `xx` (включён) с несколькими переводами `srv:`/`cfg:`-ключей. Сторожа:
 *  • вид, кадр героя, отказ команды, ошибка лобби — на `xx` у того, кто выбрал `xx`, а у русского игрока ТОЙ ЖЕ комнаты — побайтово как раньше;
 *  • область языка переживает `await` транзакции команды, и две команды разных языков вперемешку не путают язык;
 *  • отказ несёт машинный код (`cmdResult.code`), одинаковый на любом языке;
 *  • кадр `lang` меняет язык на лету: лист героя заново и `langChanged`; не включённый язык — источник.
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { userId: string; data: unknown; version: number }>(),
  sessions: new Map<string, string>(),
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  getSession: async (token: string) => db.sessions.get(token) ?? null,
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: r.userId, data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = structuredClone(data);
    return r.version;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  // ⚠ ЧТЕНИЕ СУНДУКА ЖДЁТ: транзакция команды (`withAccount`) уходит в `await`, и область языка обязана его пережить
  getAccountStash: () => new Promise((r) => setTimeout(() => r(null), 5)),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

let RM: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
let rm: InstanceType<typeof RM>;
const tok = (userId: string): string => createHash('sha256').update(userId).digest('hex');

class FakeConn implements GameConn {
  open = true;
  frames: ServerFrame[] = [];
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  readonly ip = '127.0.0.1';
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { if (!this.open) return; this.open = false; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(JSON.stringify(frame)); }
  all<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }>[] { return this.frames.filter((f) => f.t === t) as Extract<ServerFrame, { t: T }>[]; }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined { return this.all(t).at(-1); }
}
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const until = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

/** Текстовое поле `xx`-перевода — с меткой, чтобы его было видно в любом кадре. */
const XX = (s: string): string => `XX⟨${s}⟩`;
let classKey = '';

let seq = 0;
function seedChar(prefix: string): { charId: string; userId: string; token: string } {
  const charId = `${prefix}-${++seq}`;
  const userId = `user-${charId}`;
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, prefix.slice(0, 12), charId) as SaveState;
  save.inventory.push(itemFromBaseId(cfg.get('items.base'), 'healing-potion', undefined, 'shop')!);
  db.chars.set(charId, { userId, data: save, version: 1 });
  db.sessions.set(tok(userId), userId);
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.forgeCmd, limits.cmdResync, limits.viewReq, limits.stashRead]) l.reset(userId);
  return { charId, userId, token: tok(userId) };
}
async function joined(h: { charId: string; token: string }, extra: Record<string, unknown>): Promise<FakeConn> {
  const ws = new FakeConn();
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: h.token, charId: h.charId, ...extra });
  await until(() => !!ws.last('joined') || !!ws.last('error'));
  expect(ws.last('joined'), JSON.stringify(ws.last('error'))).toBeDefined();
  return ws;
}
type RoomIn = { session: { world: { players: Record<string, { save: SaveState; toggles: string[]; hp: number; mana: number; stamina: number }> } } };
const roomOf = (pid: string): RoomIn => {
  for (const r of (rm as unknown as { rooms: Map<string, RoomIn> }).rooms.values()) if (r.session.world.players[pid]) return r;
  throw new Error(`${pid} ни в одной комнате`);
};

beforeAll(async () => {
  ({ RoomManager: RM } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
  classKey = cfgKey('classes', [cfg.get('classes')[0]!.id], 'name');
  const locales = structuredClone(cfg.get('locales')) as Record<string, unknown>;
  locales.xx = {
    name: 'Test', enabled: true, grammar: { join: ' ', agrees: false, capitalize: 'none' }, templates: {},
    strings: {
      'srv:hero.hudTown': XX('town'),
      'srv:hero.offenseTitle': XX('Offense'),
      [classKey]: XX('Class'),
      'srv:town.notInBag': XX('not in bag'),
      'srv:consent.sellGold': XX('price changed: {gold}'),
      'srv:stash.noMaterialsInBag': XX('no materials'),
      'srv:lobby.noRoom': XX('no room'),
      // ⭐ 07.11: подписи [E] (станции, портал, выходы, возврат, рычаги, сундуки, алтарь) — транслитом без кириллицы (кадр `interactables`)
      ...Object.fromEntries(Object.entries(SRV_CORPUS)
        .filter(([k]) => ['srv:interact.', 'srv:station.', 'srv:run.exit', 'srv:runNode.'].some((p) => k.startsWith(p)))
        .map(([k, v]) => [k, pseudoForms(v)])),
    },
  };
  cfg.reload({ locales });
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try { rm = new RM(cfg); } finally { vi.useRealTimers(); }
});
beforeEach(() => { for (const n of ['lobbyIp', 'roomCodeMiss', 'roomCodeMissIp']) (limits as unknown as Record<string, { reset(k: string): void }>)[n]?.reset('ip:127.0.0.1'); });
afterAll(() => { for (const r of (rm as unknown as { rooms: Map<string, { stop(): void }> }).rooms.values()) r.stop(); });

describe('⭐ i18n Ф1: сервер собирает текст на языке игрока', () => {
  it('⭐ лист героя (кадр `hero`) и вид `hero/sheet`: у `xx` — перевод фраз и конфига, у русского — побайтово как без перевода', async () => {
    const a = seedChar('i18n-xx'), b = seedChar('i18n-ru');
    const wa = await joined(a, { fresh: true, lang: 'xx' });
    const code = wa.last('joined')!.roomCode;
    const wb = await joined(b, { roomCode: code });
    await settle();
    expect(JSON.stringify(wa.last('hero')!.view)).toContain(XX('town'));
    expect(JSON.stringify(wb.last('hero')!.view)).not.toContain('XX⟨');
    expect(JSON.stringify(wb.last('hero')!.view)).toContain('город');

    wa.push({ t: 'view', id: 1, kind: 'hero', args: { part: 'sheet' } });
    wb.push({ t: 'view', id: 1, kind: 'hero', args: { part: 'sheet' } });
    await until(() => !!wa.last('view') && !!wb.last('view'));
    const va = JSON.stringify(wa.last('view')!.view), vb = wb.last('view')!.view as { blocks: unknown };
    expect(va).toContain(XX('Offense'));
    expect(va, 'имя класса — текст конфига, `cfg:`-ключ').toContain(XX('Class'));
    // Русский — ровно то, что та же функция вида даёт вне всякой области (как было до шва)
    const pb = wb.last('joined')!.playerId;
    const p = roomOf(pb).session.world.players[pb]!;
    const direct = sheetView(cfg, p.save, p.toggles, { hp: p.hp, mana: p.mana, stamina: p.stamina }, { lastTarget: null, pending: {} });
    expect(JSON.stringify(vb), 'русский вид — бит в бит').toBe(JSON.stringify({ blocks: direct }));
    wa.close(); wb.close();
    await settle();
  });

  it('⭐ отказ команды — на языке игрока, а машинный код (`priceChanged`) — один на всех', async () => {
    const a = seedChar('i18n-cmd-xx'), b = seedChar('i18n-cmd-ru');
    const wa = await joined(a, { fresh: true, lang: 'xx' });
    const wb = await joined(b, { fresh: true });
    wa.push({ t: 'cmd', id: 1, command: { cmd: 'sell', uid: 'no-such-item' } });
    wb.push({ t: 'cmd', id: 1, command: { cmd: 'sell', uid: 'no-such-item' } });
    await until(() => !!wa.last('cmdResult') && !!wb.last('cmdResult'));
    expect(wa.last('cmdResult')).toMatchObject({ id: 1, ok: false, reason: XX('not in bag') });
    expect(wb.last('cmdResult')).toMatchObject({ id: 1, ok: false, reason: 'Предмет не в инвентаре' });
    expect(wb.last('cmdResult')!.code, 'обычный отказ правила кода не несёт').toBeUndefined();

    const uidOf = (ws: FakeConn): string => {
      const pid = ws.last('joined')!.playerId;
      return roomOf(pid).session.world.players[pid]!.save.inventory.find((i) => i.baseId === 'healing-potion')!.uid;
    };
    wa.push({ t: 'cmd', id: 2, command: { cmd: 'sell', uid: uidOf(wa), minGold: 999_999 } });
    wb.push({ t: 'cmd', id: 2, command: { cmd: 'sell', uid: uidOf(wb), minGold: 999_999 } });
    await until(() => wa.last('cmdResult')?.id === 2 && wb.last('cmdResult')?.id === 2);
    const ra = wa.last('cmdResult')!, rb = wb.last('cmdResult')!;
    expect(ra.reason).toMatch(/^XX⟨price changed: \d+⟩$/);
    expect(rb.reason).toMatch(/^Цена изменилась: лавка даст \d+ золота$/);
    expect([ra.code, rb.code], 'клиент перечитывает конфиг по коду, а не по началу строки').toEqual(['priceChanged', 'priceChanged']);
    // ⭐ повтор того же номера отвечает ТЕМ ЖЕ итогом — и кодом (память повторов хранит его)
    wb.push({ t: 'cmd', id: 2, command: { cmd: 'sell', uid: uidOf(wb), minGold: 999_999 } });
    await until(() => wb.all('cmdResult').length >= 3);
    expect(wb.last('cmdResult')).toMatchObject({ id: 2, ok: false, code: 'priceChanged' });
    wa.close(); wb.close();
    await settle();
  });

  it('⭐⭐ область языка ПЕРЕЖИВАЕТ `await` транзакции, и две команды разных языков вперемешку не путаются', async () => {
    const a = seedChar('i18n-tx-xx'), b = seedChar('i18n-tx-ru');
    const wa = await joined(a, { fresh: true, lang: 'xx' });
    const wb = await joined(b, { fresh: true });
    // сдать сырьё в сундук: команда ждёт чтения сундука из базы (`withAccount`), отказ «Сырья в сумке нет» — уже после ожидания
    wa.push({ t: 'cmd', id: 7, command: { cmd: 'depositMaterials' } });
    wb.push({ t: 'cmd', id: 7, command: { cmd: 'depositMaterials' } });
    await until(() => wa.last('cmdResult')?.id === 7 && wb.last('cmdResult')?.id === 7);
    expect(wa.last('cmdResult')).toMatchObject({ ok: false, reason: XX('no materials') });
    expect(wb.last('cmdResult')).toMatchObject({ ok: false, reason: 'Сырья в сумке нет' });
    wa.close(); wb.close();
    await settle();
  });

  it('⭐ кадр `lang`: язык на лету — лист героя заново и `langChanged`; не включённый язык — источник', async () => {
    const h = seedChar('i18n-lang');
    const ws = await joined(h, { fresh: true });
    await settle();
    expect(JSON.stringify(ws.last('hero')!.view)).toContain('город');
    const heroes = ws.all('hero').length;
    ws.push({ t: 'lang', lang: 'xx' });
    await until(() => !!ws.last('langChanged'));
    expect(ws.last('langChanged')).toEqual({ t: 'langChanged', lang: 'xx' });
    expect(ws.all('hero').length, 'лист героя — заново').toBe(heroes + 1);
    expect(JSON.stringify(ws.last('hero')!.view)).toContain(XX('town'));
    ws.push({ t: 'view', id: 3, kind: 'hero', args: { part: 'sheet' } });
    await until(() => ws.last('view')?.id === 3);
    expect(JSON.stringify(ws.last('view')!.view)).toContain(XX('Offense'));
    // язык, которого нет (или не включён), — язык-источник, и лист — снова русский
    ws.push({ t: 'lang', lang: 'zz' });
    await until(() => ws.all('langChanged').length === 2);
    expect(ws.last('langChanged')).toEqual({ t: 'langChanged', lang: 'ru' });
    expect(JSON.stringify(ws.last('hero')!.view)).toContain('город');
    ws.close();
    await settle();
  });

  it('⭐ до входа: кадр `lang` — язык ответов лобби («Комната не найдена»)', async () => {
    const h = seedChar('i18n-lobby');
    const ws = new FakeConn();
    rm.handleConnection(ws);
    ws.push({ t: 'lang', lang: 'xx' });
    await until(() => !!ws.last('langChanged'));
    expect(ws.last('langChanged')).toEqual({ t: 'langChanged', lang: 'xx' });
    ws.push({ t: 'join', token: h.token, charId: h.charId, roomCode: 'ZZZZZ' });
    await until(() => !!ws.last('error'));
    expect(ws.last('error')).toMatchObject({ code: 'no-room', msg: XX('no room') });
    ws.close();
  });
});

describe('i18n Ф1: область языка сервера (`textScope`)', () => {
  it('журнал кодов — только своей области: чужой код отказа не просачивается', async () => {
    const codes = new Map<string, string>();
    await inTextLang(undefined, undefined, async () => {
      tr('srv:consent.gold', 'Цена изменилась: {gold} золота', { gold: 1 });
      await new Promise((r) => setTimeout(r, 1));
      expect(scopeCodeOf('Цена изменилась: 1 золота')).toBe('priceChanged');
      tr('srv:room.tooOften', 'Слишком часто');
      expect(scopeCodeOf('Слишком часто')).toBe('rateLimited');
    }, codes);
    expect(scopeCodeOf('Цена изменилась: 1 золота'), 'вне области журнала нет').toBeUndefined();
  });

  it('язык HTTP-запроса: явное поле → `Accept-Language` (вес q, основа региона) → источник; только включённые', () => {
    const locales = cfg.get('locales');
    expect(langFromAcceptLanguage('en-US,en;q=0.9,xx;q=0.95', ['ru', 'xx'])).toBe('xx');
    expect(langFromAcceptLanguage('xx-YY;q=0.5, de', ['ru', 'xx'])).toBe('xx');
    expect(langFromAcceptLanguage('de,fr;q=0.8', ['ru', 'xx'])).toBeUndefined();
    expect(requestLang({ headers: { 'accept-language': 'xx' } }, locales)).toBe('xx');
    expect(requestLang({ headers: { 'accept-language': 'xx' }, body: { lang: 'ru' } }, locales), 'явное поле — сверху').toBe('ru');
    // ⭐ i18n (07.11, этап 1): английский включён — `en-GB` берётся основой; испанский (без строк) — выключен: источник
    expect(requestLang({ headers: { 'accept-language': 'en-GB,en;q=0.9' } }, locales), 'en включён').toBe('en');
    expect(requestLang({ headers: { 'accept-language': 'es' } }, locales), 'es не включён').toBeUndefined();
    expect(requestLang({ headers: {}, query: { lang: 'zz' } }, locales)).toBeUndefined();
  });
});

describe('⭐ i18n (07.11, хвосты Ф1): смена языка на лету — подписи [E] и лимит', () => {
  type RoomX = RoomIn & {
    descend(pid: string): void; castVote(pid: string, yes: boolean): void; step(emit?: boolean): void; area: string;
    session: RoomIn['session'] & { world: { grid: unknown } };
  };
  /** Как клиент знает интерактивы области: `areaChanged` (или `joined`), затем каждый `reveal` с тех пор. */
  const known = (ws: FakeConn): Interactable[] => {
    let list: Interactable[] = [];
    for (const f of ws.frames) {
      if (f.t === 'joined' || f.t === 'areaChanged') list = [...(f.floor.interactables ?? [])];
      else if (f.t === 'reveal') list.push(...(f.interactables ?? []));
      else if (f.t === 'interactables') list = [...f.interactables];
    }
    return list;
  };
  /** Всё, кроме подписи, — ключом: точка, радиус, действие, окно, рычаг/сундук, выход. */
  const shape = (l: readonly Interactable[]): string[] =>
    l.map((i) => JSON.stringify({ ...i, label: undefined })).sort();
  const cyr = /[Ѐ-ӿ]/;

  it('⭐ город: `lang` → лист героя, `langChanged`, затем `interactables` — те же точки и действия, подписи на новом языке', async () => {
    const h = seedChar('i18n-labels-town');
    const ws = await joined(h, { fresh: true });
    await settle();
    const ru = known(ws);
    expect(ru.length, 'станции и портал города').toBeGreaterThanOrEqual(6);
    expect(ru.every((i) => cyr.test(i.label))).toBe(true);
    const from = ws.frames.length;
    ws.push({ t: 'lang', lang: 'xx' });
    await until(() => ws.frames.slice(from).some((f) => f.t === 'interactables'));
    const order = ws.frames.slice(from).map((f) => f.t).filter((t) => t === 'hero' || t === 'langChanged' || t === 'interactables');
    expect(order, 'порядок: лист, подтверждение, подписи').toEqual(['hero', 'langChanged', 'interactables']);
    const xx = ws.last('interactables')!.interactables;
    expect(shape(xx), 'те же id/точки/действия').toEqual(shape(ru));
    expect(xx.map((i) => i.label).join(' | ')).not.toMatch(cyr);
    expect(xx.map((i) => i.label)).not.toEqual(ru.map((i) => i.label));
    // обратно на источник — те же русские подписи, что пришли со входом
    ws.push({ t: 'lang', lang: 'ru' });
    await until(() => ws.all('interactables').length === 2);
    expect(ws.last('interactables')!.interactables).toEqual(ru);
    // тот же язык ещё раз — не смена: только подтверждение, ни листа, ни подписей
    const n = ws.frames.length;
    ws.push({ t: 'lang', lang: 'ru' });
    await until(() => ws.frames.length > n);
    await settle();
    const again = ws.frames.slice(n).map((f) => f.t);
    expect(again.filter((t) => t === 'langChanged').length).toBe(1);
    expect(again.includes('hero') || again.includes('interactables'), 'не смена — ни листа, ни подписей').toBe(false);
    ws.close();
    await settle();
  });

  it('⭐ подземелье: подписи — по открытым кускам (как знает клиент), без нового `reveal`; id и точки — как у русского списка', async () => {
    const h = seedChar('i18n-labels-dun');
    const ws = await joined(h, { fresh: true });
    await settle();
    const pid = ws.last('joined')!.playerId;
    const room = roomOf(pid) as unknown as RoomX;
    room.descend(pid);
    if (room.area !== 'dungeon') room.castVote(pid, true);
    await until(() => ws.last('areaChanged')?.floor.area === 'dungeon');
    await settle();
    // ⭐ ревизия (07.11): этаж случайный — у входа могло не открыться ни выхода, ни рычага, ни сундука (предусловие падало в общем прогоне).
    // Герой — к первому выходу, его кусок открывает настоящий `revealTick` (кадр `reveal`, как в игре): у клиента — и возврат, и выход забега
    const w = room.session.world as unknown as {
      players: Record<string, { pos: { x: number; y: number } }>; exits?: { x: number; y: number }[]; stairs?: { x: number; y: number };
    };
    const exit = (w.exits?.length ? w.exits : w.stairs ? [w.stairs] : [])[0];
    expect(exit, 'у этажа забега есть выход').toBeDefined();
    Object.assign(w.players[pid]!.pos, { x: exit!.x, y: exit!.y });
    (room as unknown as { revealTick(): void }).revealTick();
    await settle();
    const ru = known(ws);
    expect(ru.some((i) => i.act === 'return') && ru.some((i) => i.act === 'exit')).toBe(true);
    const reveals = ws.all('reveal').length;
    const from = ws.frames.length;
    ws.push({ t: 'lang', lang: 'xx' });
    await until(() => ws.frames.slice(from).some((f) => f.t === 'interactables'));
    const xx = ws.last('interactables')!.interactables;
    expect(shape(xx)).toEqual(shape(ru));
    expect(xx.map((i) => i.label).join(' | ')).not.toMatch(cyr);
    expect(ws.all('reveal').length, 'смена языка кусков не открывает').toBe(reveals);
    ws.close();
    await settle();
  });

  it('⭐ лимит видов исчерпан: язык сменён и `langChanged` сразу, лист и подписи — тиком, когда лимит пустит; следующий лист — полный', async () => {
    const h = seedChar('i18n-lang-limit');
    const ws = await joined(h, { fresh: true });
    await settle();
    const pid = ws.last('joined')!.playerId;
    const room = roomOf(pid) as unknown as RoomX;
    limits.viewReq.charge(h.userId, 10_000);   // в долг: следующие запросы аккаунта ждут
    const from = ws.frames.length;
    ws.push({ t: 'lang', lang: 'xx' });
    await until(() => !!ws.frames.slice(from).find((f) => f.t === 'langChanged'));
    await settle();
    expect(ws.last('langChanged')).toEqual({ t: 'langChanged', lang: 'xx' });
    const after = ws.frames.slice(from).map((f) => f.t);
    expect(after.includes('hero') || after.includes('interactables'), 'над лимитом — ни листа, ни подписей').toBe(false);
    // тик над лимитом — тоже ничего
    room.step(false);
    expect(ws.frames.slice(from).some((f) => f.t === 'hero' || f.t === 'interactables')).toBe(false);
    // лимит пустил — тик дошлёт лист (на новом языке) и подписи
    limits.viewReq.reset(h.userId);
    room.step(false);
    const late = ws.frames.slice(from);
    expect(late.some((f) => f.t === 'hero')).toBe(true);
    expect(JSON.stringify(ws.last('hero')!.view)).toContain(XX('town'));
    expect(late.filter((f) => f.t === 'interactables').length).toBe(1);
    expect(ws.last('interactables')!.interactables.map((i) => i.label).join(' | ')).not.toMatch(cyr);
    // дошло — больше не повторяется
    const n = ws.all('interactables').length;
    room.step(false);
    expect(ws.all('interactables').length).toBe(n);
    ws.close();
    await settle();
  });

  it('⭐ над лимитом лист, ушедший по другой причине до тика, — полный, на новом языке (`heroSent` снят)', async () => {
    const h = seedChar('i18n-lang-full');
    const ws = await joined(h, { fresh: true });
    await settle();
    const pid = ws.last('joined')!.playerId;
    const room = roomOf(pid) as unknown as RoomX & { pushHero(pid: string): void };
    limits.viewReq.charge(h.userId, 10_000);
    ws.push({ t: 'lang', lang: 'xx' });
    await until(() => !!ws.last('langChanged'));
    const heroes = ws.all('hero').length;
    room.pushHero(pid);   // сейв, ауры, смена области — тот же вызов
    expect(ws.all('hero').length).toBe(heroes + 1);
    expect(JSON.stringify(ws.last('hero')!.view)).toContain(XX('town'));
    limits.viewReq.reset(h.userId);
    ws.close();
    await settle();
  });
});

describe('⭐ i18n (07.11, этап 1): смена языка — кадры с готовыми именами заново; HUD и «Поднято» — текстом сервера', () => {
  type Cl = { stashSeen?: AccountStash; lang?: string };
  type RoomY = RoomIn & {
    clients: Map<string, Cl>; area: string; step(emit?: boolean): void; setLang(pid: string, lang: string | undefined, announce?: boolean): string;
    pushHero(pid: string): void; descend(pid: string): void; castVote(pid: string, yes: boolean): void; broadcastEvents(e: SessionEvent[]): void;
  };
  const cyr = /[Ѐ-ӿ]/;
  const NAMED = ['hero', 'saveUpdate', 'stash', 'shop', 'questBoard', 'langChanged', 'interactables'];
  const order = (fs: readonly ServerFrame[]): string[] => fs.map((f) => f.t).filter((t) => NAMED.includes(t));
  const names = (items: readonly (Item | null | undefined)[]): string[] => items.filter((i): i is Item => !!i).map((i) => i.name);
  const saveNames = (s: SaveState): string[] => names([...s.inventory, ...Object.values(s.equipment), ...(s.belt ?? [])]);
  const bucket = (userId: string, tokens: number): void => {
    (limits.viewReq as unknown as { buckets: Map<string, { tokens: number; at: number }> }).buckets.set(userId, { tokens, at: performance.now() });
  };
  /** Вход в город с увиденным слепком сундука (вещь в нём — как после `stashOpen`). */
  async function town(prefix: string): Promise<{ h: ReturnType<typeof seedChar>; ws: FakeConn; pid: string; room: RoomY; stashItem: Item }> {
    const h = seedChar(prefix);
    const ws = await joined(h, { fresh: true });
    await until(() => !!ws.last('stash'));
    await settle();
    const pid = ws.last('joined')!.playerId;
    const room = roomOf(pid) as unknown as RoomY;
    const base = cfg.get('items.base').find((b) => 'slot' in b && b.slot === 'weapon' && b.enabled !== false)!;
    const stashItem = itemFromBaseId(cfg.get('items.base'), base.id, undefined, 'shop')!;
    room.clients.get(pid)!.stashSeen = { version: 1, tabs: [[stashItem]], materials: {} } as AccountStash;
    return { h, ws, pid, room, stashItem };
  }

  it('⭐⭐ `lang` en: лист, сейв, сундук, прилавок, доска — ДО `langChanged`, затем подписи; имена — английские; обратно на ru — испечённые', async () => {
    const { ws, pid, room, stashItem } = await town('i18n-named-en');
    const ruShop = JSON.stringify(ws.last('shop')), ruBoard = JSON.stringify(ws.last('questBoard'));
    expect((JSON.parse(ruShop) as { items: Item[] }).items.length, 'на прилавке есть вещи').toBeGreaterThan(0);
    let from = ws.frames.length;
    ws.push({ t: 'lang', lang: 'en' });
    await until(() => ws.frames.slice(from).some((f) => f.t === 'interactables'));
    expect(order(ws.frames.slice(from)), 'порядок: к подтверждению языка сумка, сундук и прилавок уже на новом').toEqual(NAMED);
    const save = ws.last('saveUpdate')!.save;
    expect(saveNames(save).length).toBeGreaterThan(3);
    expect(saveNames(save).join(' | ')).not.toMatch(cyr);
    expect(names(ws.last('stash')!.tabs.flat()).join(' | ')).not.toMatch(cyr);
    expect(names(ws.last('stash')!.tabs.flat())).not.toEqual([stashItem.name]);
    expect(names(ws.last('shop')!.items).join(' | ')).not.toMatch(cyr);
    const board = ws.last('questBoard')!.quests;
    expect(board.length, 'доска не пуста').toBeGreaterThan(0);
    expect(board.map((q) => q.name).join(' | ')).not.toMatch(cyr);
    // обратно на источник — испечённые имена, а прилавок и доска — те же байты, что ушли со входом
    from = ws.frames.length;
    ws.push({ t: 'lang', lang: 'ru' });
    await until(() => ws.frames.slice(from).some((f) => f.t === 'interactables'));
    expect(order(ws.frames.slice(from))).toEqual(NAMED);
    const live = room.session.world.players[pid]!.save;
    expect(saveNames(ws.last('saveUpdate')!.save), 'русскому — испечённые').toEqual(saveNames(live));
    expect(names(ws.last('stash')!.tabs.flat())).toEqual([stashItem.name]);
    expect(JSON.stringify(ws.last('shop')), 'прилавок — байт в байт как со входом').toBe(ruShop);
    expect(JSON.stringify(ws.last('questBoard')), 'доска — байт в байт как со входом').toBe(ruBoard);
    ws.close();
    await settle();
  });

  it('⭐ цена смены языка — по тому, что уходит: в городе со сундуком 2 + 4 токена; над ценой — `langChanged` сразу, остальное тиком тем же порядком', async () => {
    const { h, ws, pid, room } = await town('i18n-named-cost');
    bucket(h.userId, 5.5);   // лист + подписи (2) + сейв, сундук, прилавок, доска (4) = 6 — на полтокена меньше
    let from = ws.frames.length;
    room.setLang(pid, 'xx', true);
    expect(order(ws.frames.slice(from)), 'над ценой — только подтверждение').toEqual(['langChanged']);
    bucket(h.userId, 5.5);
    room.step(false);
    expect(order(ws.frames.slice(from)), 'тик над ценой — ничего').toEqual(['langChanged']);
    bucket(h.userId, 6);
    from = ws.frames.length;
    room.step(false);
    expect(order(ws.frames.slice(from)), 'лимит пустил — тем же порядком, без второго подтверждения')
      .toEqual(['hero', 'saveUpdate', 'stash', 'shop', 'questBoard', 'interactables']);
    expect(JSON.stringify(ws.last('hero')!.view)).toContain(XX('town'));
    limits.viewReq.reset(h.userId);
    ws.close();
    await settle();
  });

  // ⭐ ревью этапов (07.11): + 1 за определения знакомых монстров этажа (`monsterInfo`, тест ниже) — монстры у входа в вид пати сразу
  it('⭐ подземелье: прилавка нет (его шлют вход и возврат в город) — сейв, сундук и доска заново; цена 2 + 3 (+ 1 — монстры)', async () => {
    const { h, ws, pid, room } = await town('i18n-named-dun');
    room.descend(pid);
    if (room.area !== 'dungeon') room.castVote(pid, true);
    await until(() => ws.last('areaChanged')?.floor.area === 'dungeon');
    await settle();
    room.step();   // кадр мира: знакомые монстры — наверняка
    expect(ws.all('monsterInfo').length, 'монстры у входа — в виду пати').toBeGreaterThan(0);
    bucket(h.userId, 6);
    const from = ws.frames.length;
    room.setLang(pid, 'en', true);
    expect(order(ws.frames.slice(from))).toEqual(['hero', 'saveUpdate', 'stash', 'questBoard', 'langChanged', 'interactables']);
    expect(saveNames(ws.last('saveUpdate')!.save).join(' | ')).not.toMatch(cyr);
    limits.viewReq.reset(h.userId);
    ws.close();
    await settle();
  });

  /**
   * ⭐ i18n (07.11, ревью этапов): ТАБЛИЧКИ МОНСТРОВ. Имя над монстром Unity берёт из его определения (`monsterInfo`), а сервер шлёт его один
   * раз — когда монстр входит в вид пати. Без повтора на смене языка таблички этажа оставались на прежнем до следующего этажа.
   */
  it('⭐ подземелье со знакомыми монстрами: их определения (`monsterInfo`) — заново до `langChanged`, по-английски; обратно — те же байты; цена 2 + 3 + 1', async () => {
    const { h, ws, pid, room } = await town('i18n-named-mon');
    room.descend(pid);
    if (room.area !== 'dungeon') room.castVote(pid, true);
    await until(() => ws.last('areaChanged')?.floor.area === 'dungeon');
    await settle();
    for (let i = 0; i < 3; i++) room.step();
    type Info = Extract<ServerFrame, { t: 'monsterInfo' }>['monsters'];
    const seen = new Map<number, string>();   // id → определение, как оно ушло первым кадром (русское)
    for (const f of ws.all('monsterInfo')) for (const m of f.monsters) seen.set(m.id, JSON.stringify(m.def));
    expect(seen.size, 'монстры этажа в виду пати — определения пришли').toBeGreaterThan(0);
    const MON = [...NAMED.slice(0, 5), 'monsterInfo', ...NAMED.slice(5)];
    const orderM = (fs: readonly ServerFrame[]): string[] => fs.map((f) => f.t).filter((t) => MON.includes(t));
    bucket(h.userId, 5.5);   // сейв, сундук, доска (3) + монстры (1) + лист и подписи (2) = 6 — на полтокена меньше
    let from = ws.frames.length;
    room.setLang(pid, 'en', true);
    expect(orderM(ws.frames.slice(from)), 'над ценой — только подтверждение').toEqual(['langChanged']);
    room.setLang(pid, undefined, true);   // назад к источнику — тоже над ценой
    limits.viewReq.reset(h.userId);
    from = ws.frames.length;
    room.setLang(pid, 'en', true);
    expect(orderM(ws.frames.slice(from))).toEqual(['hero', 'saveUpdate', 'stash', 'questBoard', 'monsterInfo', 'langChanged', 'interactables']);
    const en: Info = ws.last('monsterInfo')!.monsters;
    const onFloor = (room.session.world as unknown as { monsters: { id: number }[] }).monsters;
    expect(new Set(en.map((m) => m.id)), 'ровно те, кого клиент уже знает').toEqual(new Set([...seen.keys()].filter((id) => onFloor.some((m) => m.id === id))));
    expect(en.map((m) => m.def.name).join(' | ')).not.toMatch(cyr);
    const ruName = (id: number): string => (JSON.parse(seen.get(id)!) as { name: string }).name;
    expect(en.map((m) => m.def.name), 'имена — новые, не русские прежние').not.toEqual(en.map((m) => ruName(m.id)));
    expect(en.map((m) => ruName(m.id)).join(' | '), 'прежние были русскими').toMatch(cyr);
    from = ws.frames.length;
    room.setLang(pid, 'ru', true);
    expect(orderM(ws.frames.slice(from))).toEqual(['hero', 'saveUpdate', 'stash', 'questBoard', 'monsterInfo', 'langChanged', 'interactables']);
    for (const m of ws.last('monsterInfo')!.monsters) expect(JSON.stringify(m.def), `источнику — определение ${m.id} байт в байт как первым кадром`).toBe(seen.get(m.id));
    limits.viewReq.reset(h.userId);
    ws.close();
    await settle();
  });

  it('⭐ HUD в кадре `hero`: строка аур и имена статусов — на языке игрока; у русского — то, что Unity собирал по конфигу', async () => {
    const a = seedChar('i18n-hud-en'), b = seedChar('i18n-hud-ru');
    const wa = await joined(a, { fresh: true, lang: 'en' });
    const wb = await joined(b, { roomCode: wa.last('joined')!.roomCode });
    await settle();
    const room = roomOf(wa.last('joined')!.playerId) as unknown as RoomY;
    const aura = cfg.get('skill-tree').nodes.find((n) => n.effect.active?.category === 'aura')!;
    for (const ws of [wa, wb]) {
      const pid = ws.last('joined')!.playerId;
      room.session.world.players[pid]!.toggles = [aura.id];
      room.pushHero(pid);
    }
    type HeroV = { auraLine: string; debuffLabels: Record<string, string>; toggles: string[] };
    const va = wa.last('hero')!.view as HeroV, vb = wb.last('hero')!.view as HeroV;
    expect(vb.auraLine, 'русский — «◈ имя» из конфига, как `DmTown.AuraLine`').toBe(`◈ ${aura.name}`);
    expect(va.auraLine.startsWith('◈ ') && va.auraLine !== vb.auraLine).toBe(true);
    expect(va.auraLine).not.toMatch(cyr);
    const conf = Object.fromEntries(cfg.get('debuffs').map((d) => [d.id, d.name]));
    expect(vb.debuffLabels, 'русский — имена таблицы `debuffs`, как `DmTown.DebuffLabel`').toEqual(conf);
    expect(Object.keys(va.debuffLabels).sort()).toEqual(Object.keys(conf).sort());
    expect(Object.values(va.debuffLabels).join(' | ')).not.toMatch(cyr);
    wa.close(); wb.close();
    await settle();
  });

  it('⭐ событие сырья — с готовой строкой «Поднято: …» (`text`) на языке получателя; русскому — байты сборки Unity по конфигу', async () => {
    const a = seedChar('i18n-mat-en'), b = seedChar('i18n-mat-ru');
    const wa = await joined(a, { fresh: true, lang: 'en' });
    const wb = await joined(b, { roomCode: wa.last('joined')!.roomCode });
    await settle();
    const pa = wa.last('joined')!.playerId, pb = wb.last('joined')!.playerId;
    const room = roomOf(pa) as unknown as RoomY;
    const mats = cfg.get('craft-materials').filter((m) => m.enabled !== false).slice(0, 2);
    const gains = { [mats[0]!.id]: 3, [mats[1]!.id]: 12, 'no-such-mat': 1 };
    const evOf = (ws: FakeConn): Extract<SessionEvent, { type: 'materials' }> | undefined =>
      ws.all('events').flatMap((f) => f.events).find((e): e is Extract<SessionEvent, { type: 'materials' }> => e.type === 'materials');
    room.broadcastEvents([
      { type: 'materials', playerId: pa, gains, x: 1, y: 1 },
      { type: 'materials', playerId: pb, gains, x: 1, y: 1 },
    ]);
    const ea = evOf(wa)!, eb = evOf(wb)!;
    expect(ea.playerId, 'своё — только своё').toBe(pa);
    expect(eb.playerId).toBe(pb);
    expect(eb.gains, 'прежние поля — как были').toEqual(gains);
    // `DmClient.MaterialsText`: имя из `craft-materials` (нет — id), « ×» + число, через «, », шаблон «Поднято: {list}»
    expect(eb.text).toBe(`Поднято: ${mats[0]!.name} ×3, ${mats[1]!.name} ×12, no-such-mat ×1`);
    expect(ea.text).toMatch(/^Picked up: .+ ×3, .+ ×12, no-such-mat ×1$/);
    expect(ea.text).not.toMatch(cyr);
    wa.close(); wb.close();
    await settle();
  });
});
