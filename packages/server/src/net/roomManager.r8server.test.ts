import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, itemFromBaseId, type ServerFrame, type SaveState, type Item } from '@dm/shared';
import { limits } from './rateLimit.js';

// Тесты файла ждут менеджер оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый такой оборот — шаг системного
// таймера (~15,6 мс). Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот потолок не прячет.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Раунд 8 (сервер), граница менеджера комнат: кадр с тысячами ключей не разбирается вовсе, кадр до входа — только маленький, а
 * кривая команда платит потолок команд (R8-09); вход с переездом старого кошелька, чья фиксация не выяснена, не входит со
 * старой копией (R8-17). База — маленькая честная (версии сейва), у каждого героя свой аккаунт и токен (`tok`).
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { userId: string; data: unknown; version: number }>(),
  /** Токен → аккаунт. Нет в карте — сессии нет. */
  sessions: new Map<string, string>(),
  /**
   * Чем кончается запись «сейв + сундук» (переезд кошелька): `ok` — легла; `stash`/`save` — обогнали; `unknown` — строка
   * записана, а ответ на COMMIT потерян и выяснить исход не удалось (`CommitUnknown`, R2-09).
   */
  stashWrite: 'ok' as 'ok' | 'stash' | 'save' | 'unknown',
}));
vi.mock('../db/db.js', () => ({
  // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  getSession: async (token: string) => db.sessions.get(token) ?? null,
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: r.userId, data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data);
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = snap;
    return r.version;
  },
  putCharacterWithStash: async (charId: string, _u: string, data: unknown, v: number) => {
    const r = db.chars.get(charId)!;
    if (db.stashWrite === 'stash') return { ok: false, conflict: 'stash' };
    if (db.stashWrite === 'save' || v !== r.version) return { ok: false, conflict: 'save' };
    r.version = v + 1; r.data = structuredClone(data);
    if (db.stashWrite === 'unknown') {
      const { CommitUnknown: CU } = await import('../db/errors.js');
      throw new CU(new Error('query_timeout'), false);
    }
    return { ok: true, version: r.version, stashVersion: 1 };
  },
  getAccountStash: () => Promise.resolve(null),
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
const tok = (userId: string): string => createHash('sha256').update(userId).digest('hex');

class FakeConn implements GameConn {
  open = true;
  frames: ServerFrame[] = [];
  closedWith?: number;
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  constructor(readonly ip = '127.0.0.1') {}
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(code?: number): void { if (!this.open) return; this.open = false; this.closedWith = code; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(typeof frame === 'string' ? frame : JSON.stringify(frame)); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
  all<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }>[] { return this.frames.filter((f) => f.t === t) as Extract<ServerFrame, { t: T }>[]; }
}
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

type RoomIn = {
  stop(): void;
  session: { world: { drops: { item?: { uid: string } }[]; players: Record<string, { save: SaveState }> } };
};
let rm: InstanceType<typeof RM>;
const rooms = (): RoomIn[] => [...(rm as unknown as { rooms: Map<string, RoomIn> }).rooms.values()];

let seq = 0;
function seedChar(prefix: string, patch?: (s: SaveState) => void): { charId: string; userId: string; token: string } {
  const charId = `${prefix}-${++seq}`;
  const uid = `user-${charId}`;
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, prefix.slice(0, 12), charId) as SaveState;
  patch?.(save);
  db.chars.set(charId, { userId: uid, data: save, version: 1 });
  db.sessions.set(tok(uid), uid);
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(uid);
  return { charId, userId: uid, token: tok(uid) };
}
let ipSeq = 0;
/** Соединение со своего адреса: лимиты адреса у каждого теста свои. */
function conn(): FakeConn { const ws = new FakeConn(`198.51.100.${++ipSeq}`); rm.handleConnection(ws); return ws; }
async function joined(h: { charId: string; token: string }): Promise<FakeConn> {
  const ws = conn();
  ws.push({ t: 'join', token: h.token, charId: h.charId, fresh: true });
  await settle();
  expect(ws.last('joined'), `${h.charId} вошёл: ${JSON.stringify(ws.last('error'))}`).toBeDefined();
  return ws;
}
/** Кадр ≈16 КБ: начало `head`, затем плоские ключи `,"_<n>":0` до `bytes`, затем `tail`. */
function manyKeys(head: string, tail: string, bytes = 16_300): string {
  let s = head;
  for (let i = 0; s.length + tail.length + 12 < bytes; i++) s += `,"_${i.toString(36)}":0`;
  return s + tail;
}

beforeAll(async () => {
  ({ RoomManager: RM } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
  vi.useFakeTimers({ toFake: ['setInterval'] });   // без фоновой дописи копий по таймеру (R3-19)
  try { rm = new RM(cfg); } finally { vi.useRealTimers(); }
});
beforeEach(() => { db.stashWrite = 'ok'; });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { for (const r of rooms()) r.stop(); });

describe('⭐ R8-09: кадр с тысячами ключей не разбирается; до входа — только маленький; кривая команда платит потолок', () => {
  /** Сколько раз `JSON.parse` разбирал строку длиннее `min` (разбор кадров клиента — в `accept`). */
  function parsesOver(min: number): { count(): number } {
    const real = JSON.parse;
    let n = 0;
    vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: (this: unknown, k: string, v: unknown) => unknown) => {
      if (typeof text === 'string' && text.length > min) n++;
      return real(text, reviver);
    }) as typeof JSON.parse);
    return { count: () => n };
  }

  it('без входа: 100 кадров «входа» по 16 КБ с тысячами ключей — ни один не разобран', async () => {
    const ws = conn();
    const frame = manyKeys('{"t":"join","token":"x","charId":"c-0"', '}');
    expect((frame.match(/:/g) ?? []).length, 'ключей — тысячи').toBeGreaterThan(1500);
    const parsed = parsesOver(10_000);
    for (let i = 0; i < 100; i++) ws.push(frame);
    await settle();
    expect(parsed.count(), 'JSON.parse по ним не звался').toBe(0);
    expect(ws.open, 'поток в потолке кадров соединение не рвёт').toBe(true);
  });

  it('без входа: большой кадр без ключей (длинная строка) — тоже не разобран: честный кадр лобби — сотни байт', async () => {
    const ws = conn();
    const frame = `{"t":"join","token":"${'a'.repeat(16_000)}","charId":"c-0"}`;
    const parsed = parsesOver(10_000);
    for (let i = 0; i < 50; i++) ws.push(frame);
    await settle();
    expect(parsed.count()).toBe(0);
  });

  it('после входа: команда на 16 КБ с тысячами ключей — не разобрана и до комнаты не дошла', async () => {
    const ws = await joined(seedChar('r8k'));
    const before = ws.frames.length;
    const frame = manyKeys('{"t":"cmd","id":1,"command":{"cmd":"buy","uid":"x"', '}}');
    const parsed = parsesOver(10_000);
    for (let i = 0; i < 50; i++) ws.push(frame);
    await settle();
    expect(parsed.count()).toBe(0);
    expect(ws.frames.slice(before).filter((f) => f.t === 'cmdResult'), 'комната их не видела').toEqual([]);
  });

  it('после входа: кривая команда платит потолок команд — поток кривых упирается в «Слишком часто»', async () => {
    const h = seedChar('r8i');
    const ws = await joined(h);
    vi.spyOn(performance, 'now').mockReturnValue(performance.now());   // часы бакетов стоят: пополнения нет
    limits.townCmd.reset(h.userId);
    for (let i = 0; i < 118; i++) limits.townCmd.take(h.userId);        // в бакете — два токена
    for (let i = 0; i < 4; i++) ws.push({ t: 'cmd', id: 100 + i, command: { cmd: 'buy', uid: 5 } });
    await settle();
    const reasons = ws.all('cmdResult').filter((r) => (r.id ?? 0) >= 100).map((r) => r.reason);
    expect(reasons).toEqual(['Неверная команда', 'Неверная команда', 'Слишком часто', 'Слишком часто']);
  });

  it('контроль: честные кадры — ковка с полным согласием по сырью и спуск с выбором алтаря — доходят до комнаты', async () => {
    const h = seedChar('r8h');
    const ws = await joined(h);
    const mats = Object.fromEntries(cfg.get('craft-materials').slice(0, 32).map((m) => [m.id, 99]));
    const craft = {
      t: 'cmd', id: 7, command: {
        cmd: 'craft', nonce: 'nonce-r8h-000001', maxGold: 1000, maxMaterials: mats,
        input: { weaponClass: 'sword', hands: 1, finish: 0, parts: { strike: { id: 'a', step: 1 }, grip: { id: 'b', step: 1 }, bind: { id: 'c', step: 1 }, head: { id: 'd', step: 1 } } },
      },
    };
    ws.push(craft);
    await settle();
    expect(ws.last('cmdResult'), 'ковка дошла до комнаты (ответ — её, а не молчание)').toMatchObject({ id: 7, cmd: 'craft' });
    ws.push({ t: 'descend', difficultyId: 'easy', runConfig: { modifiers: cfg.get('run-modifiers').slice(0, 32).map((m) => m.id) } });
    await settle();
    expect(ws.last('voteStart') ?? ws.last('areaChanged'), 'спуск дошёл').toBeDefined();
  });
});

describe('⭐ R8-17: переезд кошелька, чья фиксация не выяснена, не входит со старой копией', () => {
  /** Герой со старым кошельком в сейве и вещью в сумке. */
  function legacy(): { h: { charId: string; userId: string; token: string }; weapon: Item } {
    const weapon = itemFromBaseId(cfg.get('items.base'), cfg.get('items.base').find((b) => b.kind === 'weapon' && b.enabled !== false)!.id, cfg.get('item-tiers'), 'drop') as Item;
    const h = seedChar('r8w', (s) => { s.materials = { 'iron-1': 5 }; s.inventory.push(weapon); });
    return { h, weapon };
  }
  const onGround = (uid: string): boolean => rooms().some((r) => r.session.world.drops.some((d) => d.item?.uid === uid));
  const inRoom = (charId: string): boolean => rooms().some((r) => Object.values(r.session.world.players).some((p) => p.save.charId === charId));

  for (const how of ['unknown', 'save'] as const) {
    it(`${how === 'unknown' ? 'ответ на COMMIT потерян' : 'строку обогнали'}: вход — «сервер занят», героя нет ни в одной комнате, брошенного вдогонку нет на земле`, async () => {
      const { h, weapon } = legacy();
      db.stashWrite = how;
      const ws = conn();
      ws.push({ t: 'join', token: h.token, charId: h.charId, fresh: true });
      ws.push({ t: 'cmd', id: 1, command: { cmd: 'drop', uid: weapon.uid } });
      await settle(20);
      expect(ws.last('joined'), 'не вошёл').toBeUndefined();
      expect(ws.last('error'), 'сказали повторить').toMatchObject({ code: 'busy' });
      expect(inRoom(h.charId)).toBe(false);
      expect(onGround(weapon.uid), 'вещь не на земле').toBe(false);
      // Повтор входа читает правду из базы: переезд там уже лёг (или ляжет теперь).
      db.stashWrite = 'ok';
      const again = await joined(h);
      expect(again.last('joined')!.save.materials ?? {}, 'кошелёк переехал').toEqual({});
      expect(again.last('joined')!.save.inventory.some((i) => i.uid === weapon.uid), 'вещь — в сумке, одна').toBe(true);
    });
  }

  it('контроль: сундук обогнал другой герой (не записано ничего) — входит со своим сейвом, кошелёк переедет в следующий раз', async () => {
    const { h } = legacy();
    db.stashWrite = 'stash';
    const ws = await joined(h);
    expect(ws.last('joined')!.save.materials).toEqual({ 'iron-1': 5 });
  });

  it('контроль: переезд лёг — входит с переехавшим кошельком', async () => {
    const { h } = legacy();
    const ws = await joined(h);
    expect(ws.last('joined')!.save.materials).toEqual({});
    expect(db.chars.get(h.charId)!.version, 'переезд + запись на входе').toBeGreaterThanOrEqual(2);
  });
});
