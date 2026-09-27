import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, itemFromBaseId, type ServerFrame, type SaveState, type Item } from '@dm/shared';
import { counters } from './metrics.js';
import { limits } from './rateLimit.js';

// Тесты файла ждут комнату оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый такой оборот — шаг системного
// таймера (~15,6 мс). Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот потолок не прячет — они падают
// утверждением, а не временем.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Раунд 7 (сервер), граница менеджера комнат: кадр с длинным массивом не доходит до схемы, а кадр игры без входа — ни до
 * схемы, ни до разбора массивов (R7-04); копия, забытая из-за чужого закрепления, — инцидент, а не строка лога (R7-09);
 * возвращение в свою грейс-комнату по её коду мест не спрашивает (R7-16); вход «заново» того, чей забег пати уже увела в
 * город, — без штрафа (R7-03). База — маленькая честная (версии сейва), у каждого героя свой аккаунт и токен (`tok`).
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { userId: string; data: unknown; version: number }>(),
  /** Токен → аккаунт. Нет в карте — сессии нет. */
  sessions: new Map<string, string>(),
  /** Чьи записи сейва падают (база «лежит» для этого героя). */
  down: new Set<string>(),
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
    const snap = structuredClone(data);          // снимок в момент вызова — как и настоящая запись
    if (db.down.has(charId)) throw new Error('база упала');
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = snap;
    return r.version;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
/** Реестр кластера: чья нода держит героя (`owner`, null — эта). */
const reg = vi.hoisted(() => ({ owner: null as string | null }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(reg.owner ?? node),
  claimOwner: () => Promise.resolve(reg.owner ?? (process.env.DM_NODE_ID ?? 'node-0')),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

let RM: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
/** Токен сессии аккаунта — настоящего вида (64 hex). */
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
  codes(): string[] { return this.frames.filter((f) => f.t === 'error').map((f) => (f as { code: string }).code); }
}
const settle = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

type Pt = { x: number; y: number };
type RoomIn = {
  code: string; area: string; movedAt: number;
  stop(): void; descend(pid: string, d?: string, t?: string, rc?: unknown): void;
  session: { world: { spawn: Pt; players: Record<string, { save: SaveState; pos: Pt; combatTimer: number }> } };
};
type Inner = {
  rooms: Map<string, RoomIn>;
  graceByChar: Map<string, RoomIn>;
  unsaved: Map<string, unknown>;
  retryUnsaved(now?: number): Promise<void>;
};
let rm: InstanceType<typeof RM>;
const inner = (): Inner => rm as unknown as Inner;
const roomOf = (charId: string): RoomIn => {
  for (const r of inner().rooms.values()) for (const p of Object.values(r.session.world.players)) if (p.save.charId === charId) return r;
  throw new Error(`${charId} ни в одной комнате`);
};
const pidOf = (room: RoomIn, charId: string): string =>
  Object.entries(room.session.world.players).find(([, p]) => p.save.charId === charId)![0];
const saved = (charId: string): SaveState => db.chars.get(charId)!.data as SaveState;

let seq = 0;
/** Новый герой в «базе»; аккаунт — свой (или `userId`), сессия заведена. */
function seedChar(prefix: string, patch?: (s: SaveState) => void, userId?: string): { charId: string; userId: string; token: string } {
  const charId = `${prefix}-${++seq}`;
  const uid = userId ?? `user-${charId}`;
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, prefix.slice(0, 12), charId) as SaveState;
  patch?.(save);
  db.chars.set(charId, { userId: uid, data: save, version: 1 });
  db.sessions.set(tok(uid), uid);
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(uid);
  limits.roomCodeMiss.reset(`user:${uid}`);
  return { charId, userId: uid, token: tok(uid) };
}
function connFrom(ip = '127.0.0.1'): FakeConn { const ws = new FakeConn(ip); rm.handleConnection(ws); return ws; }
/** Соединение, уже вошедшее героем. */
async function joined(h: { charId: string; token: string }, extra: Record<string, unknown> = { fresh: true }): Promise<FakeConn> {
  const ws = connFrom();
  ws.push({ t: 'join', token: h.token, charId: h.charId, ...extra });
  await settle(10);
  expect(ws.last('joined'), `${h.charId} вошёл: ${JSON.stringify(ws.last('error'))}`).toBeDefined();
  return ws;
}
const lim = limits as unknown as Record<string, { reset(k: string): void } | undefined>;
function freshIp(...ips: string[]): void {
  for (const ip of ips) for (const name of ['lobbyIp', 'roomCodeMiss', 'roomCodeMissIp']) lim[name]?.reset(`ip:${ip}`);
}

beforeAll(async () => {
  ({ RoomManager: RM } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
  // Без фоновой дописи по таймеру (R3-19): тест R7-09 дописывает копию сам (`retryUnsaved`), фон не должен попасть в окно.
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try { rm = new RM(cfg); } finally { vi.useRealTimers(); }
});
beforeEach(() => { freshIp('127.0.0.1'); });
afterEach(() => { db.down.clear(); reg.owner = null; vi.restoreAllMocks(); });
afterAll(() => { for (const r of inner().rooms.values()) r.stop(); });

describe('⭐ R7-04: кадр с длинным массивом — не до схемы; кадр игры без входа — ни до схемы, ни до разбора массивов', () => {
  /** Кадр спуска с плоским массивом модификаторов почти в потолок транспорта (16 КБ): zod разбирал каждый элемент. */
  const fat = (): string => {
    const head = '{"t":"descend","runConfig":{"modifiers":[';
    const n = Math.floor((16 * 1024 - head.length - 8) / 2);
    return head + Array(n).fill('0').join(',') + ']}}';
  };
  const cpuMs = (fn: () => void): number => {
    const c0 = process.cpuUsage();
    fn();
    const c = process.cpuUsage(c0);
    return (c.user + c.system) / 1000;
  };

  it('соединение без входа: 60 таких кадров — главный поток свободен, сокет живёт, ответов нет', () => {
    const raw = fat();
    expect(Buffer.byteLength(raw)).toBeLessThan(16 * 1024);
    const ws = connFrom('198.51.100.40');
    // Время процессора, а не часов: под нагрузкой полного прогона процесс вытесняют. Разбор схемой — ~8 мс на кадр (≈0,5 с на
    // 60), без неё — разбор JSON, доли миллисекунды.
    const ms = cpuMs(() => { for (let i = 0; i < 60; i++) ws.push(raw); });
    expect(ms, 'процессорное время на 60 кадров, мс').toBeLessThan(150);
    expect(ws.frames, 'без входа — без ответа').toEqual([]);
    ws.close();
  });

  it('вошедший игрок: те же 60 кадров — главный поток свободен, кадры кривые, спуска нет', async () => {
    const h = seedChar('r704');
    const ws = await joined(h);
    const room = roomOf(h.charId);
    const raw = fat();
    const bad0 = counters.framesInvalid;
    const ms = cpuMs(() => { for (let i = 0; i < 60; i++) ws.push(raw); });
    await settle(10);
    expect(ms, 'процессорное время на 60 кадров, мс').toBeLessThan(150);
    expect(counters.framesInvalid - bad0, 'каждый — кривой').toBe(60);
    expect(room.area, 'спуска не было').toBe('town');
    ws.close();
    await settle(10);
  });

  it('контроль: честный спуск с 32 модификаторами от вошедшего доходит до комнаты', async () => {
    const h = seedChar('r704ok');
    const ws = await joined(h);
    const room = roomOf(h.charId);
    const got: unknown[] = [];
    const orig = room.descend.bind(room);
    room.descend = (pid, d, t, rc) => { got.push(rc); orig(pid, d, t, rc); };
    try {
      ws.push({ t: 'descend', runConfig: { modifiers: Array.from({ length: 32 }, (_, i) => `mod-${i}`) } });
      await settle(10);
    } finally { delete (room as { descend?: unknown }).descend; }
    expect(got).toHaveLength(1);
    ws.close();
    await settle(10);
  });

  it('контроль: кадр игры, посланный вдогонку `join` до ответа, исполняется после входа (как прежде)', async () => {
    const h = seedChar('r704seq');
    const ws = connFrom();
    ws.push({ t: 'join', token: h.token, charId: h.charId, fresh: true });
    ws.push({ t: 'arena' });
    await settle(20);
    expect(ws.last('joined')).toBeDefined();
    expect(roomOf(h.charId).area, 'голосование за арену прошло соло').toBe('arena');
    ws.close();
    await settle(10);
  });
});

describe('⭐ R7-16: возвращение в свою грейс-комнату по её коду мест не спрашивает', () => {
  it('четверо, четвёртый отвалился у портала, пати в городе, пятый занял место — четвёртый входит по коду своей комнаты', async () => {
    const hs = [1, 2, 3, 4, 5].map((i) => seedChar(`r716-${i}`));
    const ws1 = await joined(hs[0]!);
    const room = roomOf(hs[0]!.charId);
    const party = [ws1];
    for (const h of hs.slice(1, 4)) party.push(await joined(h, { roomCode: room.code }));
    ws1.push({ t: 'descend' });
    for (const w of party.slice(1)) w.push({ t: 'vote', accept: true });
    await settle(10);
    expect(room.area).toBe('dungeon');
    const w = room.session.world;
    for (const h of hs.slice(0, 4)) w.players[pidOf(room, h.charId)]!.pos = { ...w.spawn };
    party[3]!.close();
    await settle(10);
    room.movedAt = 0;
    ws1.push({ t: 'return' });
    party[1]!.push({ t: 'vote', accept: true });
    party[2]!.push({ t: 'vote', accept: true });
    await settle(10);
    expect(room.area).toBe('town');
    const ws5 = await joined(hs[4]!, { roomCode: room.code });
    expect(roomOf(hs[4]!.charId)).toBe(room);
    const back = connFrom();
    back.push({ t: 'join', token: hs[3]!.token, charId: hs[3]!.charId, roomCode: room.code });
    await settle(10);
    expect(back.codes(), 'не «full»').toEqual([]);
    expect(back.last('joined')).toBeDefined();
    expect(roomOf(hs[3]!.charId)).toBe(room);
    for (const c of [...party.slice(0, 3), ws5, back]) c.close();
    await settle(10);
  });
});

describe('⭐ R7-03: вход «заново» того, чей забег пати увела в город, — без штрафа', () => {
  it('B отвалился у портала, пати в городе; B входит в новую комнату — золото и забег целы', async () => {
    const a = seedChar('r703a'), b = seedChar('r703b', (s) => { s.gold = 1000; });
    const wa = await joined(a);
    const room = roomOf(a.charId);
    const wb = await joined(b, { roomCode: room.code });
    wa.push({ t: 'descend' });
    wb.push({ t: 'vote', accept: true });
    await settle(10);
    expect(room.area).toBe('dungeon');
    const w = room.session.world;
    for (const h of [a, b]) { const p = w.players[pidOf(room, h.charId)]!; p.pos = { ...w.spawn }; p.combatTimer = 0; }
    wb.close();
    await settle(10);
    room.movedAt = 0;
    wa.push({ t: 'return' });
    await settle(10);
    expect(room.area).toBe('town');
    expect(inner().graceByChar.get(b.charId), 'B ждёт реконнекта').toBe(room);
    const wb2 = await joined(b, { fresh: true });
    expect(roomOf(b.charId)).not.toBe(room);
    expect(saved(b.charId).gold, 'штрафа нет').toBe(1000);
    expect(saved(b.charId).run, 'забег припаркован').toBeTruthy();
    wa.close(); wb2.close();
    await settle(10);
  });
});

describe('⭐ R7-09: копия, забытая из-за чужого закрепления, — инцидент, а не строка лога', () => {
  it('P передал вещь Q (один аккаунт), пока база лежала; закрепление P ушло другой ноде — копия забыта со счётчиком и «ИНЦИДЕНТ» в лог', async () => {
    const acc = 'user-r709-acc';
    const base = cfg.get('items.base').find((b) => b.kind === 'armor' && b.enabled !== false)!;
    const item = itemFromBaseId(cfg.get('items.base'), base.id, cfg.get('item-tiers'), 'drop') as Item;
    const p = seedChar('r709p', (s) => { item.pos = null; s.inventory = [...s.inventory, item]; }, acc), q = seedChar('r709q', undefined, acc);
    const wp = await joined(p);
    const room = roomOf(p.charId);
    const wq = await joined(q, { roomCode: room.code });
    db.down.add(p.charId);                                   // база лежит для P: его записи падают
    wp.push({ t: 'cmd', command: { cmd: 'drop', uid: item.uid }, id: 1 });
    await settle(10);
    const w = room.session.world as unknown as { drops: { id: number; pos: Pt; item?: { uid: string } }[] };
    const drop = w.drops.find((d) => d.item?.uid === item.uid)!;
    expect(drop, 'вещь на земле').toBeDefined();
    const qp = room.session.world.players[pidOf(room, q.charId)]!;
    qp.pos = { ...drop.pos };
    wq.push({ t: 'cmd', command: { cmd: 'pickup', dropId: drop.id }, id: 1 });
    await settle(10);
    expect(qp.save.inventory.some((i) => i.uid === item.uid), 'Q поднял').toBe(true);
    wp.close();
    await settle(10);
    expect(inner().unsaved.has(p.charId), 'копия P ждёт дописи').toBe(true);
    wq.close();
    await settle(10);
    expect(saved(q.charId).inventory.some((i) => i.uid === item.uid), 'у Q в базе вещь есть').toBe(true);
    db.down.delete(p.charId);
    reg.owner = 'node-9';                                    // закрепление P у другой ноды
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f0 = (counters as unknown as Record<string, number>).farewellForgotten ?? 0;
    await inner().retryUnsaved();
    await settle(10);
    expect(inner().unsaved.has(p.charId), 'копия забыта (дописывать её в строку героя чужой ноды нельзя, R6-06)').toBe(false);
    expect((counters as unknown as Record<string, number>).farewellForgotten, 'счётчик инцидентов').toBe(f0 + 1);
    expect(err.mock.calls.some((c) => String(c[0]).includes('ИНЦИДЕНТ') && String(c[0]).includes(p.charId)), 'инцидент — в лог').toBe(true);
  });
});
