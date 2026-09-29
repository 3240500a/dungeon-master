import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type RunConfig } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решают моки базы и реестра, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ ПЕРЕПРОГОН ФАЗЗЕРОВ ПОСЛЕ РАУНДА 18 (сервер): СВОД ЗАБЕГА — ПОСЛЕ ВЗЯТИЯ. Фаззер кластера (сид 10250172, 300 операций): продолжение из
 * города прочитало свод забега и ждало взятия в реестре (поздний ответ); в это окно забег продолжила другая комната той же ноды, открыла сундук
 * и отдала забег (гибель) — свод с сундуком лёг, а первая комната вошла в узел по своду, прочитанному ДО этого: сундук закрыт снова, добыча
 * второй раз. Тот же порядок — «прочитать, потом взять» — был и у «Продолжить» в новую комнату (`RoomManager.join`). Теперь:
 *  • свод читается ПОСЛЕ взятия забега в кластере (соседняя нода его уже не возьмёт; её отпуск ждёт, пока свод ляжет, R18-02);
 *  • взятие забега другой комнатой процесса, пока продолжение ждёт реестр и базу (`watchRunTakes`), — отказ «занято»: повтор войдёт к ней или
 *    прочтёт свод заново.
 * Менеджер и комнаты — настоящие; база — маленькая честная (свод забега объединением), чтение свода и взятие в реестре — с воротами теста.
 */
const TOK = 'e7'.repeat(32);
const USER = 'user-r18rr';
type Rec = { id: string; el: number; chests: number[]; killed: number[]; levers: number[] };
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: SaveState; version: number }>(),
  ledger: new Map<string, Map<string, { id: string; el: number; chests: number[]; killed: number[]; levers: number[] }>>(),
  /** Ворота чтения свода: снимок берётся сразу, ответ ждёт ворот (медленная база — ответ устаревает в пути). */
  readGate: null as Promise<void> | null,
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async (key: string) => {
    const snap = [...(db.ledger.get(key)?.values() ?? [])].map((r) => structuredClone(r));
    if (db.readGate) await db.readGate;
    return snap;
  },
  mergeRunLedger: async (key: string, recs: Rec[]) => {
    await new Promise((res) => setTimeout(res, 1));
    let m = db.ledger.get(key);
    if (!m) db.ledger.set(key, (m = new Map()));
    const u = (a: number[] = [], b: number[] = []): number[] => [...new Set([...a, ...b])].sort((x, y) => x - y);
    for (const r of recs) {
      const cur = m.get(r.id);
      m.set(r.id, cur ? { ...cur, chests: u(cur.chests, r.chests), killed: u(cur.killed, r.killed), levers: u(cur.levers, r.levers) } : structuredClone(r));
    }
  },
  landedVersion: async () => null,
  getSession: async (token: string) => (token === 'e7'.repeat(32) ? 'user-r18rr' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r18rr', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: SaveState, v: number) => {
    const json = JSON.stringify(data);   // снимок — в момент вызова, как `snapshotOf`
    await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = JSON.parse(json) as SaveState;
    return r.version;
  },
  putCharacterOwned: async () => 'foreign',
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
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  constructor(readonly ip = '127.0.0.1') {}
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { if (!this.open) return; this.open = false; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(JSON.stringify(frame)); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Ждать условия оборотами цикла (не часами): записи мока идут кругами по миллисекунде. */
async function until(what: string, ok: () => boolean, turns = 5_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}

type Pl = { pos: { x: number; y: number }; save: SaveState; alive: boolean };
type RoomIn = {
  code: string; area: string; movedAt: number; runConfig: RunConfig | null;
  stop(): void; descend(pid: string): void; returnTown(pid: string): void; castVote(pid: string, yes: boolean): void; openChest(pid: string, id: number): void;
  holdsRun(key: string): boolean; ledgerPending(): boolean;
  session: {
    world: {
      players: Record<string, Pl>; spawn: { x: number; y: number }; monsters: { alive: boolean }[];
      chests: { id: number; pos: { x: number; y: number }; opened: boolean }[];
    };
  };
};
type RMIn = { rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; charOps: Map<string, unknown>; handleConnection(ws: GameConn): void };
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let setRunLockStore: typeof import('./roomManager.js').setRunLockStore;
let runLedgerKey: (cfg: RunConfig) => string;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor, setRunLockStore } = await import('./roomManager.js'));
  ({ runLedgerKey } = await import('./room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
function manager(): RMIn {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try {
    const rm = new RoomManagerCtor(cfg) as unknown as RMIn;
    managers.push(rm);
    return rm;
  } finally { vi.useRealTimers(); }
}
/**
 * Реестр забегов кластера (одна нода): взятие легло сразу; `holdNextClaim` — ответ СЛЕДУЮЩЕГО взятия ждёт ворот теста (поздний ответ реестра),
 * взятие само легло сразу.
 */
const reg = { gate: null as ((v: string | null) => void) | null, holdNext: false, held: 0, released: [] as [string, string][] };
function holdNextClaim(): void { reg.gate = null; reg.holdNext = true; }
beforeEach(() => {
  db.readGate = null; reg.gate = null; reg.holdNext = false; reg.held = 0; reg.released = [];
  setRunLockStore({
    claim: (_key, _room) => {
      if (!reg.holdNext) return Promise.resolve(null);
      reg.holdNext = false; reg.held++;
      return new Promise((res) => { reg.gate = res; });
    },
    // ⭐ Перепрогон R20: отпуски строк забега — по порядку (ключ, комната).
    release: (key, room) => { reg.released.push([key, room]); return Promise.resolve(); },
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  db.readGate = null;
  reg.gate?.(null);
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  setRunLockStore(null);
  vi.restoreAllMocks();
});
function resetLimits(): void {
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync, limits.stashRead]) l.reset(USER);
}
function seed(id: string): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.gold = 10_000; s.attributes.vitality = 60;
  db.chars.set(id, { data: s, version: 1 });
}
let ipSeq = 0;
/** Кадр входа — без ожидания ответа (ответ может ждать ворот теста). */
function send(rm: RMIn, charId: string, how: { roomCode?: string; resume?: boolean } = {}): FakeConn {
  resetLimits();
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(how.roomCode ? { roomCode: how.roomCode } : how.resume ? { resume: true } : { fresh: true }) });
  return ws;
}
async function join(rm: RMIn, charId: string, how: { roomCode?: string; resume?: boolean } = {}): Promise<FakeConn> {
  const ws = send(rm, charId, how);
  await until(`${charId}: ответ на вход`, () => !!ws.last('joined') || !!ws.last('error'));
  return ws;
}
async function leave(rm: RMIn, ws: FakeConn, charId: string): Promise<void> {
  ws.push({ t: 'leave' });
  await until(`${charId} вышел`, () => !rm.live.has(charId) && !rm.inflight.has(charId) && !rm.charOps.has(charId));
}
/** Герой в своей новой городской комнате (тик — только шагами теста). */
async function solo(rm: RMIn, charId: string): Promise<{ ws: FakeConn; room: RoomIn; pid: string }> {
  const ws = await join(rm, charId);
  const j = ws.last('joined');
  expect(j, JSON.stringify(ws.last('error'))).toBeDefined();
  const room = rm.rooms.get(j!.roomCode)!;
  room.stop();
  await until('записи входа легли', () => !rm.inflight.size);
  return { ws, room, pid: j!.playerId };
}

/**
 * A и B прошли узел забега K вместе (сундук узла `chestId` не тронут) и вышли из города — K припаркован у обоих, его никто не держит. Каждый —
 * в своей новой городской комнате (RA, RB).
 */
async function apart(rm: RMIn, tag: string): Promise<{ key: string; chestId: number; a: string; b: string; RA: Awaited<ReturnType<typeof solo>>; RB: Awaited<ReturnType<typeof solo>> }> {
  const a = `${tag}A`, b = `${tag}B`;
  seed(a); seed(b);
  const wsA = await join(rm, a);
  const code = wsA.last('joined')!.roomCode;
  const pidA = wsA.last('joined')!.playerId;
  const wsB = await join(rm, b, { roomCode: code });
  const pidB = wsB.last('joined')!.playerId;
  const room = rm.rooms.get(code)!;
  room.stop();
  await until('записи входа легли', () => !rm.inflight.size);
  room.movedAt = 0; room.descend(pidA); room.castVote(pidB, true);
  expect(room.area).toBe('dungeon');
  const key = runLedgerKey(room.runConfig!);
  const w = room.session.world;
  for (const m of w.monsters) m.alive = false;
  const chestId = w.chests.find((c) => !c.opened)!.id;
  w.players[pidA]!.pos = { ...w.spawn }; w.players[pidB]!.pos = { ...w.spawn };
  room.movedAt = 0; room.returnTown(pidA); room.castVote(pidB, true);
  expect(room.area, 'пати в городе').toBe('town');
  await until('свод лёг', () => !room.ledgerPending());
  await leave(rm, wsA, a);
  await leave(rm, wsB, b);
  expect(db.chars.get(a)!.data.run, 'забег A припаркован').toBeTruthy();
  expect(db.chars.get(b)!.data.run, 'забег B припаркован').toBeTruthy();
  return { key, chestId, a, b, RA: await solo(rm, a), RB: await solo(rm, b) };
}
/** B в своей комнате продолжает K, открывает сундук узла, возвращается в город (свод лёг) и уходит — K свободен, сундук в своде. */
async function bLoots(rm: RMIn, RB: Awaited<ReturnType<typeof solo>>, b: string, key: string, chestId: number): Promise<void> {
  RB.room.movedAt = 0; RB.room.descend(RB.pid);
  await until('B продолжил K', () => RB.room.area === 'dungeon');
  expect(runLedgerKey(RB.room.runConfig!)).toBe(key);
  const w = RB.room.session.world;
  for (const m of w.monsters) m.alive = false;
  const chest = w.chests.find((c) => c.id === chestId)!;
  expect(chest.opened, 'сундук ещё закрыт').toBe(false);
  w.players[RB.pid]!.pos = { ...chest.pos };
  RB.room.openChest(RB.pid, chestId);
  expect(chest.opened, 'B открыл сундук').toBe(true);
  w.players[RB.pid]!.pos = { ...w.spawn };
  RB.room.movedAt = 0; RB.room.returnTown(RB.pid);
  expect(RB.room.area).toBe('town');
  await until('свод с сундуком лёг', () => !RB.room.ledgerPending() && !!db.ledger.get(key) && [...db.ledger.get(key)!.values()].some((r) => r.chests.includes(chestId)));
  await leave(rm, RB.ws, b);
  expect(RB.room.holdsRun(key), 'K свободен').toBe(false);
}
/** Открыт ли сундук на узле комнаты `room` (она в подземелье). */
const opened = (room: RoomIn, chestId: number): boolean | undefined => room.session.world.chests.find((c) => c.id === chestId)?.opened;

describe('⭐ Перепрогон R18: продолжение из города — свод после взятия забега', () => {
  it('взятие опоздало, а другая комната ноды за это время прошла узел и отдала забег — узел не собран по старому своду (сид 10250172)', async () => {
    const rm = manager();
    const { key, chestId, b, RA, RB } = await apart(rm, 'R18RA');
    holdNextClaim();
    RA.room.movedAt = 0; RA.room.descend(RA.pid);   // соло: голос прошёл, продолжение ждёт взятия в реестре
    await until('взятие RA ждёт реестр', () => !!reg.gate);
    await bLoots(rm, RB, b, key, chestId);
    reg.gate!(null);
    await until('RA ответил', () => RA.room.area === 'dungeon' || RA.ws.frames.some((f) => f.t === 'error'));
    if (RA.room.area === 'dungeon') {
      expect(opened(RA.room, chestId), 'сундук, открытый B, открыт и у A').toBe(true);
    } else {
      expect(RA.ws.last('error')?.code, '«позовите спуск снова»').toBe('busy');
      RA.room.movedAt = 0; RA.room.descend(RA.pid);
      await until('повтор продолжил', () => RA.room.area === 'dungeon');
      expect(opened(RA.room, chestId), 'повтор читает свод заново').toBe(true);
    }
  });

  it('свод прочитан, а ответ базы шёл, пока другая комната ноды взяла забег, прошла узел и отдала его, — отказ «позовите спуск снова», повтор со взятым', async () => {
    const rm = manager();
    const { key, chestId, b, RA, RB } = await apart(rm, 'R18RB');
    let open!: () => void;
    db.readGate = new Promise<void>((res) => { open = res; });
    RA.room.movedAt = 0; RA.room.descend(RA.pid);
    await until('чтение свода RA в пути', () => (RA.room as unknown as { resuming: boolean }).resuming);
    for (let i = 0; i < 20; i++) await tick();
    db.readGate = null;   // чтение свода B — сразу (его ответ уже не держим)
    await bLoots(rm, RB, b, key, chestId);
    open();
    await until('RA ответил', () => RA.room.area === 'dungeon' || RA.ws.frames.some((f) => f.t === 'error'));
    expect(RA.room.area, 'узел по своду без сундука не собран').toBe('town');
    expect(RA.ws.last('error')?.code).toBe('busy');
    RA.room.movedAt = 0; RA.room.descend(RA.pid);
    await until('повтор продолжил', () => RA.room.area === 'dungeon');
    expect(opened(RA.room, chestId), 'повтор читает свод заново').toBe(true);
  });
});

describe('⭐ Перепрогон R18: «Продолжить» в новую комнату — свод после взятия забега', () => {
  it('взятие опоздало, а другая комната ноды за это время прошла узел и отдала забег — новая комната со взятым сундуком (или «занято»)', async () => {
    const rm = manager();
    const { key, chestId, a, b, RA, RB } = await apart(rm, 'R18RC');
    await leave(rm, RA.ws, a);
    holdNextClaim();
    const ws = send(rm, a, { resume: true });
    await until('взятие «Продолжить» ждёт реестр', () => !!reg.gate);
    await bLoots(rm, RB, b, key, chestId);
    reg.gate!(null);
    await until('ответ на «Продолжить»', () => !!ws.last('joined') || !!ws.last('error'));
    let j = ws.last('joined');
    if (!j) {
      expect(ws.last('error')?.code, JSON.stringify(ws.last('error'))).toBe('busy');
      j = (await join(rm, a, { resume: true })).last('joined');
    }
    expect(j).toBeDefined();
    const room = rm.rooms.get(j!.roomCode)!;
    room.stop();
    expect(room.area).toBe('dungeon');
    expect(opened(room, chestId), 'сундук, открытый B, открыт и у A').toBe(true);
  });

  it('свод после взятия прочитан, а ответ базы шёл, пока другая комната ноды взяла забег и отдала его, — «занято», повтор со взятым', async () => {
    const rm = manager();
    const { key, chestId, a, b, RA, RB } = await apart(rm, 'R18RD');
    await leave(rm, RA.ws, a);
    holdNextClaim();
    const ws = send(rm, a, { resume: true });
    await until('взятие «Продолжить» ждёт реестр', () => !!reg.gate);
    let open!: () => void;
    db.readGate = new Promise<void>((res) => { open = res; });
    reg.gate!(null);   // взятие легло — «Продолжить» читает свод второй раз, ответ базы — в пути
    for (let i = 0; i < 20; i++) await tick();
    expect(ws.last('joined') ?? ws.last('error'), 'ответа ещё нет').toBeUndefined();
    db.readGate = null;
    await bLoots(rm, RB, b, key, chestId);
    open();
    await until('ответ на «Продолжить»', () => !!ws.last('joined') || !!ws.last('error'));
    expect(ws.last('joined'), 'узел по своду без сундука не собран').toBeUndefined();
    expect(ws.last('error')?.code).toBe('busy');
    const j = (await join(rm, a, { resume: true })).last('joined');
    expect(j).toBeDefined();
    const room = rm.rooms.get(j!.roomCode)!;
    room.stop();
    expect(opened(room, chestId), 'повтор со взятым сундуком').toBe(true);
  });
});

/**
 * ⭐ ПЕРЕПРОГОН ФАЗЗЕРОВ ПОСЛЕ РАУНДА 20 (сервер, фаззер кластера, сид 22010446): продолжение из города шлёт взятие забега (ответ реестра поздний),
 * а тем временем все вышли — комната ушла, и взятие, легшее позже её отпуска, держит строку забега за ней. Продолжение, получив ответ, сперва
 * ждало свод (слив чужого недолёгшего, чтение из базы — при медленной базе десятки секунд) и только потом видело, что комнаты нет, и отдавало
 * взятое: всё это время «Продолжить» соседней ноды получал отказ с кодом ушедшей комнаты. Теперь ушедшая отдаёт взятое сразу по ответу.
 */
describe('⭐ Перепрогон R20: продолжение из города, чья комната ушла, пока взятие забега шло в реестр', () => {
  it('взятое — назад по ответу реестра, не дожидаясь свода из медленной базы', async () => {
    const rm = manager();
    const { key, a, RA } = await apart(rm, 'R20RA');
    let open!: () => void;
    db.readGate = new Promise<void>((res) => { open = res; });   // свод из базы — медленно
    try {
      holdNextClaim();
      RA.room.movedAt = 0; RA.room.descend(RA.pid);   // соло: голос прошёл, продолжение ждёт взятия в реестре
      await until('взятие RA ждёт реестр', () => !!reg.gate);
      await leave(rm, RA.ws, a);
      expect(rm.rooms.has(RA.room.code), 'комната ушла').toBe(false);
      reg.released = [];
      reg.gate!(null);   // позднее взятие легло: строка забега — за ушедшей комнатой
      await until('взятое отдано', () => reg.released.some(([k, r]) => k === key && r === RA.room.code), 500);   // обороты цикла, не часы
      expect((RA.room as unknown as { resuming: boolean }).resuming, 'продолжение кончилось, не дожидаясь свода').toBe(false);
    } finally { open(); }
  });

  it('взятие легло сразу, а комната ушла, пока продолжение ждёт свод из медленной базы, — взятое отдано уходом комнаты', async () => {
    const rm = manager();
    const { key, a, RA } = await apart(rm, 'R20RB');
    let open!: () => void;
    db.readGate = new Promise<void>((res) => { open = res; });   // свод из базы — медленно
    try {
      reg.released = [];   // отпуски ухода пати из города (`apart`) — не в счёт
      RA.room.movedAt = 0; RA.room.descend(RA.pid);   // соло: голос прошёл, взятие легло, продолжение ждёт свод
      await until('продолжение ждёт свод', () => (RA.room as unknown as { resuming: boolean }).resuming);
      for (let i = 0; i < 20; i++) await tick();
      expect(reg.released.filter(([k]) => k === key), 'взятое пока держит').toEqual([]);
      await leave(rm, RA.ws, a);
      expect(rm.rooms.has(RA.room.code), 'комната ушла').toBe(false);
      await until('взятое отдано', () => reg.released.some(([k, r]) => k === key && r === RA.room.code), 500);   // обороты цикла, не часы
    } finally { open(); }
  });
});
