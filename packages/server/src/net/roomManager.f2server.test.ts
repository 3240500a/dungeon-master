import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type RunConfig } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ ФАЗЗЕРЫ, ПРОХОД ПРАВОК 2 (сервер), граница менеджера комнат. Менеджер и комнаты — настоящие; база — маленькая честная (версии сейва),
 * умеет зависнуть (сессия, сундук аккаунта) до знака теста.
 *  • C-03: погибший, ушедший до возврата пати в город, «Завершить» после грейса платит штраф, как любой оживший: город оживил и его;
 *  • C-04: «Продолжить» ведёт в СВОЙ забег — не в грейс-комнату, начавшую другой (и не в ту, где его забег — чужой);
 *  • C-06: очередь кадров соединения ограничена (кадры и байты; до входа — только кадры размера лобби): поток при зависшей базе
 *    закрывает соединение (4008), а закрытие снимает сессию СРАЗУ — стоявшие за зависшим кадры закрытого соединения не исполняются.
 */
const TOK = 'f2'.repeat(32);
const USER = 'user-f2rm';
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number }>(),
  /** Поиск сессии ждёт, пока тест не откроет. */
  sessionGate: null as Promise<void> | null,
  /** Чтение сундука аккаунта ждёт, пока тест не откроет. */
  stashGate: null as Promise<void> | null,
  stashReads: 0,
  log: [] as string[],
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => [],
  mergeRunLedger: async () => undefined,
  landedVersion: async () => null,
  getSession: async (token: string) => {
    if (db.sessionGate) await db.sessionGate;
    return token === 'f2'.repeat(32) ? 'user-f2rm' : null;
  },
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-f2rm', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data);
    await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    if (!r || v !== r.version) { db.log.push(`${charId} v${v} CONFLICT`); return null; }
    r.version = v + 1; r.data = snap;
    db.log.push(`${charId} v${v}->v${r.version}`);
    return r.version;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: async () => { db.stashReads++; if (db.stashGate) await db.stashGate; return null; },
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
  count(t: ServerFrame['t']): number { return this.frames.filter((f) => f.t === t).length; }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(what: string, ok: () => boolean, turns = 5_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}
const turns = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

type Pl = { hp: number; alive: boolean; pos: { x: number; y: number }; save: SaveState; debuffs: Record<string, unknown> };
type RoomIn = {
  code: string; area: string; movedAt: number; size: number; stop(): void; step(): void;
  runConfig: RunConfig | null; runNodeId: string | null;
  descend(pid: string): void; castVote(pid: string, yes: boolean): void; returnTown(pid: string): void;
  disconnected: Map<string, { safe?: boolean }>;
  session: { world: { monsters: { alive: boolean }[]; spawn: { x: number; y: number }; players: Record<string, Pl>; timeMs: number; drops: { item?: { uid: string } }[] } };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; unsaved: Map<string, unknown>;
  conns: Map<GameConn, unknown>; graceByChar: Map<string, RoomIn>; charOps: Map<string, unknown>;
  handleConnection(ws: GameConn): void;
};
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
/** Свой менеджер на тест, без фоновой дописки копий по таймеру (R3-19). */
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
  // Ключи соединений (`c1`, `c2`…) у каждого менеджера свои с единицы, а бакеты кадров — общие на процесс: соединение, оставленное
  // открытым прошлым тестом, не должно делиться бакетом с этим.
  for (let i = 1; i <= 400; i++) { limits.wsFrames.reset(`c${i}`); limits.lobbyConn.reset(`c${i}`); }
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  db.sessionGate = null; db.stashGate = null;
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.restoreAllMocks();
});

function seed(id: string, patch?: (s: SaveState) => void): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.attributes.vitality = 60; s.gold = 5000;
  patch?.(s);
  db.chars.set(id, { data: s, version: 1 });
}
const row = (id: string): SaveState => db.chars.get(id)!.data as SaveState;
let ipSeq = 0;
function conn(): FakeConn { return new FakeConn(`198.51.100.${++ipSeq % 250}`); }
async function join(rm: RMIn, charId: string, how: { roomCode?: string; resume?: boolean } = {}): Promise<FakeConn> {
  const ws = conn();
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(how.roomCode ? { roomCode: how.roomCode } : how.resume ? { resume: true } : { fresh: true }) });
  await until(`${charId} вошёл`, () => !!ws.last('joined') || !!ws.last('error'));
  return ws;
}
async function lobby(rm: RMIn, frame: Record<string, unknown>, done: (ws: FakeConn) => boolean): Promise<FakeConn> {
  const ws = conn();
  rm.handleConnection(ws);
  ws.push({ ...frame, token: TOK });
  await until(`ответ на ${String(frame.t)}`, () => done(ws));
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
/** Срок грейса на время теста — доли секунды. */
async function shortGrace<T>(fn: () => Promise<T>): Promise<T> {
  const bal = cfg.get('balance') as { reconnectGraceSec: number };
  const was = bal.reconnectGraceSec;
  bal.reconnectGraceSec = 0.05;
  try { return await fn(); } finally { bal.reconnectGraceSec = was; }
}

describe('⭐ C-03: погибший ушёл, пати увела забег в город — «Завершить» после грейса платит, как любой оживший', () => {
  it('⭐ смерть → закрыл вкладку → пати в городе → грейс истёк → «Завершить» — штраф (его смерть город «отжил»)', async () => {
    const rm = manager();
    seed('F2C3A'); seed('F2C3B');
    const { room, pidA, pidB, wsA, wsB } = await coopDungeon(rm, 'F2C3A', 'F2C3B');
    kill(room, pidB);
    const afterDeath = room.session.world.players[pidB]!.save.gold;
    expect(afterDeath, 'штраф смерти взят').toBeLessThan(5000);
    wsB.close();
    await until('B ждёт реконнекта', () => room.disconnected.has('F2C3B') && idle(rm, 'F2C3B'));
    room.movedAt = 0; room.returnTown(pidA);
    expect(room.area, 'пати в городе').toBe('town');
    await shortGrace(async () => {
      wsA.close();   // вышел из города: комната ждёт одного B
      await until('грейс истёк, B отпущен', () => !rm.graceByChar.has('F2C3B') && idle(rm, 'F2C3B') && !rm.rooms.size, 20_000);
    });
    expect(row('F2C3B').run, 'забег припаркован').toBeDefined();
    expect(row('F2C3B').run?.deadAt, 'город оживил — «мёртв, оплачено» в строке нет').toBeUndefined();
    const ws = await lobby(rm, { t: 'abandon', charId: 'F2C3B' }, (w) => !!w.last('abandoned') || !!w.last('error'));
    expect(ws.last('abandoned'), JSON.stringify(ws.last('error'))).toBeDefined();
    expect(row('F2C3B').run, 'забег завершён').toBeUndefined();
    expect(row('F2C3B').gold, '«Завершить» ожившего — штраф').toBeLessThan(afterDeath);
  });
});

describe('⭐ C-04: «Продолжить» — в свой забег', () => {
  it('⭐ грейс-комната начала другой забег — припаркованный отпущен без штрафа, «Продолжить» ведёт в его забег, а не в её подземелье', async () => {
    const rm = manager();
    seed('F2C4A'); seed('F2C4B');
    const { room, pidA, wsA, wsB } = await coopDungeon(rm, 'F2C4A', 'F2C4B');
    const x = room.runConfig!.id;
    wsB.close();   // спокойно, у точки входа
    await until('B ждёт реконнекта', () => room.disconnected.has('F2C4B') && idle(rm, 'F2C4B'));
    room.movedAt = 0; room.returnTown(pidA);
    expect(room.disconnected.get('F2C4B')?.safe, 'забег B припаркован').toBe(true);
    // A завершает свой забег (выселение из города) и возвращается в комнату по коду — уже без забега.
    const ab = await lobby(rm, { t: 'abandon', charId: 'F2C4A' }, (w) => !!w.last('abandoned') || !!w.last('error'));
    expect(ab.last('abandoned')).toBeDefined();
    expect(wsA.open).toBe(false);
    const wsA2 = await join(rm, 'F2C4A', { roomCode: room.code });
    expect(wsA2.last('joined')!.roomCode).toBe(room.code);
    room.movedAt = 0; room.descend(wsA2.last('joined')!.playerId);
    expect(room.area, 'новый забег').toBe('dungeon');
    expect(room.runConfig!.id).not.toBe(x);
    const ws = await lobby(rm, { t: 'join', resume: true, charId: 'F2C4B' }, (w) => !!w.last('joined') || !!w.last('error'));
    const j = ws.last('joined');
    expect(j, JSON.stringify(ws.last('error'))).toBeDefined();
    expect(j!.roomCode, 'не в комнату чужого забега').not.toBe(room.code);
    const mine = rm.rooms.get(j!.roomCode)!;
    expect(mine.runConfig?.id, 'в свой забег').toBe(x);
    expect(row('F2C4B').gold, 'без штрафа').toBe(5000);
  });

  it('⭐ ждал гостем (свой забег — чужой комнате), пати в городе — «Продолжить» и статус — про СВОЙ забег', async () => {
    const rm = manager();
    seed('F2C4C'); seed('F2C4D');
    // D сам начал и припарковал свой забег X (вышел из города).
    const wsD0 = await join(rm, 'F2C4D');
    const q = rm.rooms.get(wsD0.last('joined')!.roomCode)!;
    q.movedAt = 0; q.descend(wsD0.last('joined')!.playerId);
    expect(q.area).toBe('dungeon');
    const x = q.runConfig!.id;
    q.stop();
    q.session.world.players[wsD0.last('joined')!.playerId]!.pos = { ...q.session.world.spawn };
    q.movedAt = 0; q.returnTown(wsD0.last('joined')!.playerId);
    wsD0.close();
    await until('D вышел', () => idle(rm, 'F2C4D') && !rm.rooms.has(q.code));
    expect(row('F2C4D').run?.config.id, 'забег X припаркован').toBe(x);
    // C в своём забеге Y; D по коду к нему в подземелье (со своим X). ⭐ R16 C-03: отказ `run` — в подземелье только участники его забега (гостем
    // с чужим забегом D был вне правил бегства из боя). Раньше D садился туда гостем и ждал реконнекта в комнате чужого забега.
    const wsC = await join(rm, 'F2C4C');
    const room = rm.rooms.get(wsC.last('joined')!.roomCode)!;
    const pidC = wsC.last('joined')!.playerId;
    room.movedAt = 0; room.descend(pidC);
    expect(room.area).toBe('dungeon');
    room.stop();
    const wsD = await join(rm, 'F2C4D', { roomCode: room.code });
    expect(wsD.last('joined'), 'гостем с чужим забегом в подземелье не входят').toBeUndefined();
    expect(wsD.last('error')).toMatchObject({ code: 'run' });
    await until('D свободен', () => idle(rm, 'F2C4D'));
    expect(room.disconnected.has('F2C4D'), 'и не ждёт в комнате C').toBe(false);
    room.movedAt = 0; room.returnTown(pidC);
    expect(room.area).toBe('town');
    const st = await lobby(rm, { t: 'runStatus', charId: 'F2C4D' }, (v) => !!v.last('runStatus') || !!v.last('error'));
    expect(st.last('runStatus'), 'статус — про свой забег, не про комнату C').toMatchObject({ hasRun: true });
    expect(st.last('runStatus')!.roomCode).not.toBe(room.code);
    const ws = await lobby(rm, { t: 'join', resume: true, charId: 'F2C4D' }, (v) => !!v.last('joined') || !!v.last('error'));
    const j = ws.last('joined');
    expect(j, JSON.stringify(ws.last('error'))).toBeDefined();
    expect(j!.roomCode, 'не в город C').not.toBe(room.code);
    expect(rm.rooms.get(j!.roomCode)!.runConfig?.id, 'в свой забег').toBe(x);
    expect(row('F2C4D').gold, 'без штрафа').toBe(5000);
  });
});

describe('⭐ C-06: очередь кадров соединения ограничена; закрытие снимает сессию сразу', () => {
  /** Вошедший в город. */
  async function town(rm: RMIn, id: string): Promise<{ ws: FakeConn; room: RoomIn; pid: string }> {
    seed(id);
    const ws = await join(rm, id);
    await until('записи входа легли', () => !rm.inflight.size);
    await turns(10);
    const room = rm.rooms.get(ws.last('joined')!.roomCode)!;
    return { ws, room, pid: ws.last('joined')!.playerId };
  }
  /** Чтение сундука зависнет до `open()`. */
  function stallStash(): () => void {
    let open!: () => void;
    db.stashGate = new Promise<void>((r) => { open = r; });
    return () => { db.stashGate = null; open(); };
  }
  /** Часы бакетов идут в темпе кадров (80/с — устойчивый потолок кадров соединения): поток упирается не в него. */
  function paced(): void {
    let t = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => (t += 12.6));
  }

  it('⭐ база зависла на команде — поток кадров по 15 КБ за ней закрывает соединение (4008), сессия снята сразу', async () => {
    const rm = manager();
    const { ws, room } = await town(rm, 'F2C6A');
    const open = stallStash();
    ws.push({ t: 'cmd', id: 1, command: { cmd: 'stashOpen' } });
    await turns(5);
    paced();
    const pad = 'x'.repeat(15_000);
    let sent = 0;
    for (; sent < 400 && ws.open; sent++) ws.push(`{"t":"cmd","id":${sent + 2},"command":{"cmd":"stashOpen","pad":"${pad}"}}`);
    expect(ws.closedWith, 'очередь переполнена — соединение закрыто').toBe(4008);
    expect(sent, 'задолго до потолка частоты').toBeLessThan(40);
    expect(rm.live.has('F2C6A'), 'сессия снята сразу, не за очередью').toBe(false);
    expect(room.size, 'в комнате его нет').toBe(0);
    open();
    await until('очередь разошлась', () => idle(rm, 'F2C6A'));
    await turns(30);
    expect(ws.count('cmdResult'), 'кадры закрытого соединения не исполнялись').toBeLessThanOrEqual(1);
  });

  it('⭐ клиент закрыл вкладку, пока команда ждёт базу, — сессия снята сразу; выброс, стоявший за ней, не исполнился', async () => {
    const rm = manager();
    const { ws, room, pid } = await town(rm, 'F2C6B');
    const save = room.session.world.players[pid]!.save;
    const w = save.equipment.weapon!;
    const open = stallStash();
    ws.push({ t: 'cmd', id: 1, command: { cmd: 'stashOpen' } });
    await turns(5);
    ws.push({ t: 'cmd', id: 2, command: { cmd: 'unequip', slot: 'weapon' } });
    ws.push({ t: 'cmd', id: 3, command: { cmd: 'drop', uid: w.uid } });
    ws.close();
    expect(rm.live.has('F2C6B'), 'сессия снята сразу').toBe(false);
    expect(rm.conns.size).toBe(0);
    open();
    await until('записи легли', () => idle(rm, 'F2C6B'));
    await turns(30);
    expect(room.session.world.drops.some((d) => d.item?.uid === w.uid), 'на земле нет').toBe(false);
    expect(row('F2C6B').equipment.weapon?.uid, 'оружие — в строке, на месте').toBe(w.uid);
  });

  it('⭐ вход ещё в очереди (сессию ищет зависшая база): большие кадры за ним не копятся, поток малых закрывает соединение', async () => {
    const rm = manager();
    seed('F2C6C');
    let open!: () => void;
    db.sessionGate = new Promise<void>((r) => { open = r; });
    const ws = conn();
    rm.handleConnection(ws);
    ws.push({ t: 'join', token: TOK, charId: 'F2C6C', fresh: true });
    await turns(3);
    paced();
    const big = `{"t":"cmd","id":1,"command":{"cmd":"stashOpen","pad":"${'y'.repeat(15_000)}"}}`;
    for (let i = 0; i < 100; i++) ws.push(big);
    expect(ws.open, 'большие до входа отброшены, не копятся').toBe(true);
    const small = `{"t":"cmd","id":2,"command":{"cmd":"stashOpen","pad":"${'z'.repeat(900)}"}}`;
    let sent = 0;
    for (; sent < 200 && ws.open; sent++) ws.push(small);
    expect(ws.closedWith, 'очередь до входа переполнена — закрыто').toBe(4008);
    expect(sent, 'до входа — немного').toBeLessThan(64);
    db.sessionGate = null; open();
    await until('вход отпущен', () => !rm.charOps.has('F2C6C'));
    await turns(30);
    expect(rm.live.has('F2C6C'), 'на закрытом сокете не сел').toBe(false);
  });

  it('контроль: сотня мелких честных команд за командой, ждущей базу, — не закрывает; все отвечены', async () => {
    const rm = manager();
    const { ws, room, pid } = await town(rm, 'F2C6D');
    const it0 = room.session.world.players[pid]!.save.inventory[0];
    const open = stallStash();
    ws.push({ t: 'cmd', id: 1, command: { cmd: 'stashOpen' } });
    await turns(5);
    limits.townCmd.reset(USER);
    for (let i = 0; i < 100; i++) ws.push({ t: 'cmd', id: 10 + i, command: it0 ? { cmd: 'moveItem', uid: it0.uid, x: i % 2 ? 0 : 4, y: 0 } : { cmd: 'stashOpen' } });
    expect(ws.open, 'не закрыто').toBe(true);
    open();
    await until('все отвечены', () => ws.count('cmdResult') >= 101, 20_000);
    expect(rm.live.has('F2C6D')).toBe(true);
  });
});
