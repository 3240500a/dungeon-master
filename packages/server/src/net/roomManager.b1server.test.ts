import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, itemFromBaseId, type ServerFrame, type SaveState, type RunConfig, type RunNodeState, type Item } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ ФАЗЗЕР КЛАСТЕРА B1, ПРОХОД ПРАВОК 1 (сервер), менеджер комнат. Менеджеры и комнаты — настоящие (два менеджера — два процесса: слитая
 * нода и соседняя); база — маленькая честная: версии сейва и свод записей забега (`run_ledger`), и она помнит, не легла ли строка героя
 * поперёд свода его забега.
 *  • K1: «мёртв, оплачено» (`run.deadAt`) — правда о смерти и там, где комната героя не помнит: «Продолжить» после слива ноды, вход по коду к
 *    напарнику, продолжившему забег, — мёртвым; вход не в подземелье своего забега — забег снят без штрафа; смена этажа, оживившая ждущего
 *    реконнекта, снимает метку и в строке — сразу;
 *  • K2: строка героя не ложится поперёд свода его забега (сундук, открытый перед выбросом вещи); свод не ложится — не ложится и строка;
 *  • K3: поднятое выброшенное соседа по аккаунту — в строке поднявшего сразу, а не автосейвом.
 */
const TOK = 'b1'.repeat(32);
const USER = 'user-b1rm';
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number }>(),
  /** Свод записей забегов: ключ забега → узел → взятое. */
  ledger: new Map<string, Map<string, { chests: number[]; killed: number[] }>>(),
  /** Запись свода падает (база свода отказывает). */
  ledgerDown: false,
  /** K2: строки, легшие с записью узла, которой в своде забега в базе ещё нет (`герой:узел`). */
  ahead: [] as string[],
  /** Легшие записи строк героев — по порядку. */
  writes: [] as string[],
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async (key: string) =>
    [...(db.ledger.get(key)?.entries() ?? [])].map(([id, r]) => ({ id, el: 1, chests: [...r.chests], killed: [...r.killed], levers: [] })),
  mergeRunLedger: async (key: string, recs: readonly { id: string; chests: number[]; killed: number[] }[]) => {
    await new Promise((res) => setTimeout(res, 1));
    if (db.ledgerDown) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    let m = db.ledger.get(key);
    if (!m) db.ledger.set(key, (m = new Map()));
    for (const r of recs) {
      const cur = m.get(r.id) ?? { chests: [], killed: [] };
      m.set(r.id, { chests: [...new Set([...cur.chests, ...r.chests])], killed: [...new Set([...cur.killed, ...r.killed])] });
    }
  },
  landedVersion: async () => null,
  getSession: async (token: string) => (token === 'b1'.repeat(32) ? 'user-b1rm' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-b1rm', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data) as SaveState;   // снимок — в момент вызова, как `snapshotOf`
    const { runLedgerKey } = await import('./room.js');
    const { runRecords } = await import('@dm/shared');
    await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = snap;
    db.writes.push(charId);
    const run = snap.run;
    if (run?.config) {
      const m = db.ledger.get(runLedgerKey(run.config));
      for (const st of runRecords(run, run.config)) {
        const l = m?.get(st.id);
        if (st.chests.some((c) => !l?.chests.includes(c)) || st.killed.some((k) => !l?.killed.includes(k))) db.ahead.push(`${charId}:${st.id}`);
      }
    }
    return r.version;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

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
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(what: string, ok: () => boolean, turns = 5_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}
const turns = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

type Pl = { hp: number; alive: boolean; pos: { x: number; y: number }; save: SaveState; debuffs: Record<string, unknown> };
type RoomIn = {
  code: string; area: string; movedAt: number; strandAt: number; lastSaveAt: number; stop(): void; step(): void;
  runConfig: RunConfig | null; runNodeId: string | null; nodeState: RunNodeState | null;
  descend(pid: string): void; castVote(pid: string, yes: boolean): void; returnTown(pid: string): void;
  syncNodeState(): void;
  disconnected: Map<string, { safe?: boolean }>;
  session: {
    world: {
      monsters: { alive: boolean }[]; spawn: { x: number; y: number }; players: Record<string, Pl>; timeMs: number;
      drops: { id: number; kind: string; item?: Item; pos: { x: number; y: number }; heldBy?: string }[];
    };
  };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; unsaved: Map<string, unknown>;
  conns: Map<GameConn, unknown>; graceByChar: Map<string, RoomIn>; charOps: Map<string, unknown>;
  handleConnection(ws: GameConn): void;
  flushAll(budgetMs?: number): Promise<void>;
};
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
/** Свой менеджер (процесс ноды) на тест, без фоновой дописки копий по таймеру (R3-19). */
function manager(): RMIn {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try {
    const rm = new RoomManagerCtor(cfg) as unknown as RMIn;
    managers.push(rm);
    return rm;
  } finally { vi.useRealTimers(); }
}
beforeEach(() => {
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync, limits.stashRead]) l.reset(USER);
  for (let i = 1; i <= 400; i++) { limits.wsFrames.reset(`c${i}`); limits.lobbyConn.reset(`c${i}`); }
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db.ledgerDown = false; db.ahead = []; db.writes = [];
});
afterEach(() => {
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.restoreAllMocks();
});

function seed(id: string): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.attributes.vitality = 60; s.gold = 5000;
  const sword = itemFromBaseId(cfg.get('items.base'), 'long-sword', cfg.get('item-tiers'), 'drop')!;
  s.inventory.push({ ...sword, x: 0, y: 0 } as Item);
  db.chars.set(id, { data: s, version: 1 });
}
const row = (id: string): SaveState => db.chars.get(id)!.data as SaveState;
let ipSeq = 0;
async function join(rm: RMIn, charId: string, how: { roomCode?: string; resume?: boolean } = {}): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(how.roomCode ? { roomCode: how.roomCode } : how.resume ? { resume: true } : { fresh: true }) });
  await until(`${charId} вошёл`, () => !!ws.last('joined') || !!ws.last('error'));
  return ws;
}
const idle = (rm: RMIn, id: string): boolean => !rm.live.has(id) && !rm.inflight.has(id) && !rm.charOps.has(id);
/** Кооп A + B в подземелье комнаты A; монстры «спят», тик — только шагами теста, оба у точки входа. */
async function coopDungeon(rm: RMIn, a: string, b: string): Promise<{ room: RoomIn; pidA: string; pidB: string; wsA: FakeConn; wsB: FakeConn }> {
  const wsA = await join(rm, a);
  const code = wsA.last('joined')!.roomCode;
  const pidA = wsA.last('joined')!.playerId;
  const wsB = await join(rm, b, { roomCode: code });
  const pidB = wsB.last('joined')!.playerId;
  const room = rm.rooms.get(code)!;
  await until('записи входа легли', () => !rm.inflight.size);
  room.movedAt = 0; room.descend(pidA); room.castVote(pidB, true);
  expect(room.area).toBe('dungeon');
  room.stop();
  await until('записи спуска легли', () => !rm.inflight.size);
  await turns(30);
  const w = room.session.world;
  for (const m of w.monsters) m.alive = false;
  w.players[pidA]!.pos = { ...w.spawn }; w.players[pidB]!.pos = { ...w.spawn };
  return { room, pidA, pidB, wsA, wsB };
}
function kill(room: RoomIn, pid: string): void {
  const p = room.session.world.players[pid]!;
  p.hp = 1;
  p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: room.session.world.timeMs + 60_000, mag: 9999, mag2: 0 };
  for (let t = 0; t < 10 && p.alive; t++) room.step();
  expect(p.alive, 'погиб').toBe(false);
}
/** Кооп A + B, B погиб; процесс слит (копии дописаны, комнаты заморожены) — строка B: штраф и «мёртв, оплачено». */
async function deadThenDrained(a: string, b: string): Promise<{ gold: number; node: string }> {
  const rm1 = manager();
  seed(a); seed(b);
  const { room, pidB } = await coopDungeon(rm1, a, b);
  kill(room, pidB);
  const gold = room.session.world.players[pidB]!.save.gold;
  const node = room.runNodeId!;
  await rm1.flushAll(3_000);
  expect(row(b).run?.deadAt, 'в строке — «мёртв, оплачено»').toBe(node);
  expect(row(b).gold, 'и штраф').toBe(gold);
  return { gold, node };
}

describe('⭐ K1: «мёртв, оплачено» — по сейву, и там, где комната героя не помнит', () => {
  it('⭐ слив ноды: «Продолжить» на соседней — мёртвым на узле; один — возврат в город вайпом, без второго штрафа', async () => {
    const { gold, node } = await deadThenDrained('B1K1A', 'B1K1B');
    const rm2 = manager();   // соседняя нода
    const ws = await join(rm2, 'B1K1B', { resume: true });
    const j = ws.last('joined');
    expect(j, JSON.stringify(ws.last('error'))).toBeDefined();
    const room = rm2.rooms.get(j!.roomCode)!;
    room.stop();
    expect(room.area).toBe('dungeon');
    expect(room.runNodeId).toBe(node);
    const p = room.session.world.players[j!.playerId]!;
    expect(p.alive, 'мёртвым, а не живым с полным здоровьем').toBe(false);
    expect(ws.frames.some((f) => f.t === 'died' && f.status === true && f.toTown === true), 'один — «возвращаетесь в город»').toBe(true);
    room.strandAt = Date.now() - 1;   // срок возврата застрявших вышел
    room.step();
    expect(room.area).toBe('town');
    expect(p.save.run, 'забег окончен (вайп)').toBeUndefined();
    expect(p.save.gold, 'второго штрафа нет').toBe(gold);
  });

  it('⭐ слив ноды: напарник продолжил забег, погибший — к нему по коду: мёртвым, ждать пати', async () => {
    await deadThenDrained('B1K1C', 'B1K1D');
    const rm2 = manager();
    const wsA = await join(rm2, 'B1K1C', { resume: true });
    const room = rm2.rooms.get(wsA.last('joined')!.roomCode)!;
    room.stop();
    expect(room.area).toBe('dungeon');
    expect(room.session.world.players[wsA.last('joined')!.playerId]!.alive, 'напарник жив').toBe(true);
    const wsB = await join(rm2, 'B1K1D', { roomCode: room.code });
    const j = wsB.last('joined');
    expect(j, JSON.stringify(wsB.last('error'))).toBeDefined();
    expect(j!.roomCode).toBe(room.code);
    expect(room.session.world.players[j!.playerId]!.alive, 'мёртвым — пати этаж не меняла').toBe(false);
    expect(wsB.frames.some((f) => f.t === 'died' && f.status === true && !f.toTown), 'окно смерти: ждать пати').toBe(true);
  });

  it('⭐ слив ноды: погибший — «Соло» в новый город: забег снят без штрафа (как страховка), спуском его не продолжить', async () => {
    const { gold } = await deadThenDrained('B1K1E', 'B1K1F');
    const rm2 = manager();
    const ws = await join(rm2, 'B1K1F');
    const j = ws.last('joined');
    expect(j, JSON.stringify(ws.last('error'))).toBeDefined();
    const room = rm2.rooms.get(j!.roomCode)!;
    room.stop();
    const p = room.session.world.players[j!.playerId]!;
    expect(room.area).toBe('town');
    expect(p.save.run, 'забег снят').toBeUndefined();
    expect(p.save.gold, 'без штрафа — смерть оплачена').toBe(gold);
    await until('вход записан', () => !rm2.inflight.size && row('B1K1F').run === undefined);
  });

  it('⭐ погиб, закрыл вкладку, пати ушла в город — метка снята и в строке сразу, не только в копии', async () => {
    const rm = manager();
    seed('B1K1G'); seed('B1K1H');
    const { room, pidA, pidB, wsB } = await coopDungeon(rm, 'B1K1G', 'B1K1H');
    kill(room, pidB);
    wsB.close();
    await until('B ждёт реконнекта', () => room.disconnected.has('B1K1H') && idle(rm, 'B1K1H'));
    expect(row('B1K1H').run?.deadAt, 'прощание легло с меткой').toBeDefined();
    room.movedAt = 0; room.returnTown(pidA);
    expect(room.area).toBe('town');
    await until('копия записана', () => !rm.inflight.size && row('B1K1H').run?.deadAt === undefined);
    expect(row('B1K1H').run, 'забег припаркован').toBeDefined();
  });

  it('погиб, закрыл вкладку, пати ушла в город — «Продолжить» в свою комнату: живым (её память — смена этажа)', async () => {
    const rm = manager();
    seed('B1K1I'); seed('B1K1J');
    const { room, pidA, pidB, wsB } = await coopDungeon(rm, 'B1K1I', 'B1K1J');
    kill(room, pidB);
    wsB.close();
    await until('B ждёт реконнекта', () => room.disconnected.has('B1K1J') && idle(rm, 'B1K1J'));
    room.movedAt = 0; room.returnTown(pidA);
    await until('записи легли', () => !rm.inflight.size);
    const ws = await join(rm, 'B1K1J', { resume: true });
    const j = ws.last('joined');
    expect(j, JSON.stringify(ws.last('error'))).toBeDefined();
    expect(j!.roomCode).toBe(room.code);
    expect(room.session.world.players[j!.playerId]!.alive).toBe(true);
  });
});

/** Узел забега комнаты: взято ещё что-то (сундук `chest`) — запись узла в сейвы участников и в свод (как `openChest`). */
function openChestRecord(room: RoomIn, chest: number): void {
  room.nodeState!.chests.push(chest);
  room.syncNodeState();
}
function sword(room: RoomIn, pid: string): Item {
  return room.session.world.players[pid]!.save.inventory.find((i) => i.baseId === 'long-sword')!;
}

describe('⭐ K2: строка героя не ложится поперёд свода его забега', () => {
  it('⭐ открыт сундук, вещь выброшена (запись выброса — сразу) — строка ложится после свода с этим сундуком', async () => {
    const rm = manager();
    seed('B1K2A'); seed('B1K2B');
    const { room, pidA, wsA } = await coopDungeon(rm, 'B1K2A', 'B1K2B');
    const v0 = db.chars.get('B1K2A')!.version;
    openChestRecord(room, 901);
    wsA.push({ t: 'cmd', id: 1, command: { cmd: 'drop', uid: sword(room, pidA).uid } });
    await until('выброс записан', () => db.chars.get('B1K2A')!.version > v0);
    expect(db.ahead, `строки поперёд свода: ${db.ahead.join(', ')}`).toEqual([]);
    expect(db.ledger.get((await import('./room.js')).runLedgerKey(room.runConfig!))?.get(room.runNodeId!)?.chests).toContain(901);
  });

  it('⭐ свод не ложится — строка героя забега тоже (сбой записи); база вернулась — обе, свод первым', async () => {
    const rm = manager();
    seed('B1K2C'); seed('B1K2D');
    const { room, pidA, wsA } = await coopDungeon(rm, 'B1K2C', 'B1K2D');
    const v0 = db.chars.get('B1K2C')!.version;
    db.ledgerDown = true;
    openChestRecord(room, 902);
    wsA.push({ t: 'cmd', id: 1, command: { cmd: 'drop', uid: sword(room, pidA).uid } });
    await until('ответ на выброс', () => !!wsA.last('cmdResult'));
    await turns(200);
    expect(db.chars.get('B1K2C')!.version, 'строка не обогнала свод').toBe(v0);
    db.ledgerDown = false;
    room.lastSaveAt = 0;
    room.step();   // автосейв
    await until('автосейв лёг', () => db.chars.get('B1K2C')!.version > v0);
    expect(db.ahead, `строки поперёд свода: ${db.ahead.join(', ')}`).toEqual([]);
  });
});

describe('⭐ K3: поднятое выброшенное соседа по аккаунту — в строке поднявшего сразу', () => {
  it('⭐ A выбросил меч в городе, B поднял — строка B с мечом ложится без автосейва (падение процесса после — меч не пропал)', async () => {
    const rm = manager();
    seed('B1K3A'); seed('B1K3B');
    const wsA = await join(rm, 'B1K3A');
    const room = rm.rooms.get(wsA.last('joined')!.roomCode)!;
    const wsB = await join(rm, 'B1K3B', { roomCode: room.code });
    room.stop();
    await until('записи входа легли', () => !rm.inflight.size);
    const pidA = wsA.last('joined')!.playerId, pidB = wsB.last('joined')!.playerId;
    const uid = sword(room, pidA).uid;
    wsA.push({ t: 'cmd', id: 1, command: { cmd: 'drop', uid } });
    await until('выброс записан — вещь отпущена', () => room.session.world.drops.some((d) => d.item?.uid === uid && d.heldBy === undefined));
    expect((row('B1K3A').inventory as Item[]).some((i) => i.uid === uid), 'из строки A ушла').toBe(false);
    const d = room.session.world.drops.find((x) => x.item?.uid === uid)!;
    room.session.world.players[pidB]!.pos = { ...d.pos };
    wsB.push({ t: 'cmd', id: 1, command: { cmd: 'pickup', dropId: d.id } });
    await until('подъём', () => room.session.world.players[pidB]!.save.inventory.some((i) => i.uid === uid));
    await until('строка B с мечом легла сразу', () => (row('B1K3B').inventory as Item[]).some((i) => i.uid === uid), 500);
  });
});
