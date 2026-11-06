import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, cfgKey, itemFromBaseId, newCharacterSave, sheetView, tr, type ServerFrame, type SaveState,
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
    expect(requestLang({ headers: { 'accept-language': 'en' } }, locales), 'en не включён').toBeUndefined();
    expect(requestLang({ headers: {}, query: { lang: 'zz' } }, locales)).toBeUndefined();
  });
});
