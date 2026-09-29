import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type RunConfig } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 18 (сервер), менеджер комнат. Менеджер и комнаты — настоящие; база — маленькая честная (версии строк, свод забега объединением).
 *  • R18-04: ПЕРЕЗАГРУЗКА В ГОРОДЕ НЕ ОТРЫВАЕТ ОТ ПАТИ. После R17-02 любое «Продолжить» живого участника из города (F5, вылет, обрыв сети) забирало
 *    забег у городской комнаты, где его ждал подключённый напарник, и высаживало вернувшегося одного на узел; напарнику — отказ `run` на каждый
 *    спуск. Сервер не отличал честную перезагрузку от заложника (R17-02: напарник отошёл от компьютера). Теперь держатель в городе забег
 *    отдаёт, только если никто из его подключённых участников забега не действовал `RUN_IDLE_MS` (заложник — отошедший); иначе «Продолжить» —
 *    к пати, как V2. Отказ спуска в городе — с кодом держателя полем кадра (`roomCode`).
 *  • R18-02: СВОД ЗАБЕГА, НЕ ЛЁГШИЙ В БАЗУ, НЕ ОБХОДИТСЯ «ПРОДОЛЖИТЬ». Запись свода упала (блокировка, таймаут), пачка ждала повтора в очереди
 *    комнаты (`ledgerOut`) — а вход ждал только записей в полёте (`runLedgerSettled`) и собирал узел по базе: открытый сундук закрыт снова,
 *    убитые живы — добыча и опыт ещё раз. Теперь вход и продолжение сперва дописывают недолёгшее любой комнаты процесса (и ушедшей), и если
 *    оно так и не легло — «занято», а не узел по базе; держатель с недолёгшим сводом забег не отдаёт.
 */
const TOK = 'f1'.repeat(32);
const USER = 'user-r18rm';
type Rec = { id: string; el: number; chests: number[]; killed: number[]; levers: number[] };
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: SaveState; version: number }>(),
  ledger: new Map<string, Map<string, { id: string; el: number; chests: number[]; killed: number[]; levers: number[] }>>(),
  ledgerDown: false,
  ledgerFails: 0,
  /** R18-03: закрепления героев (`char_claims`): чья нода держит героя. */
  claims: new Map<string, string>(),
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async (key: string) => [...(db.ledger.get(key)?.values() ?? [])].map((r) => structuredClone(r)),
  mergeRunLedger: async (key: string, recs: Rec[]) => {
    await new Promise((res) => setTimeout(res, 1));
    if (db.ledgerDown) { db.ledgerFails++; throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }); }
    let m = db.ledger.get(key);
    if (!m) db.ledger.set(key, (m = new Map()));
    const u = (a: number[] = [], b: number[] = []): number[] => [...new Set([...a, ...b])].sort((x, y) => x - y);
    for (const r of recs) {
      const cur = m.get(r.id);
      m.set(r.id, cur ? { ...cur, chests: u(cur.chests, r.chests), killed: u(cur.killed, r.killed), levers: u(cur.levers, r.levers) } : structuredClone(r));
    }
  },
  landedVersion: async () => null,
  getSession: async (token: string) => (token === 'f1'.repeat(32) ? 'user-r18rm' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r18rm', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: SaveState, v: number) => {
    const json = JSON.stringify(data);   // снимок — в момент вызова, как `snapshotOf`
    await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = JSON.parse(json) as SaveState;
    return r.version;
  },
  // ⭐ R18-03: как в базе — владение и запись одним запросом: закрепление героя не за этой нодой — `foreign`, не записано ничего.
  putCharacterOwned: async (charId: string, _u: string, data: SaveState, v: number, owner: { node: string }) => {
    const json = JSON.stringify(data);
    await new Promise((res) => setTimeout(res, 1));
    if (db.claims.get(charId) !== owner.node) return 'foreign';
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = JSON.parse(json) as SaveState;
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
type ClientIn = { activeAt: number };
type RoomIn = {
  code: string; area: string; movedAt: number; runConfig: RunConfig | null;
  clients: Map<string, ClientIn>;
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
let runLedgerKey: (cfg: RunConfig) => string;
let RUN_IDLE_MS: number;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  ({ runLedgerKey, RUN_IDLE_MS } = await import('./room.js') as unknown as { runLedgerKey: typeof runLedgerKey; RUN_IDLE_MS: number });
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
beforeEach(() => {
  db.ledgerDown = false; db.ledgerFails = 0;
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync, limits.stashRead]) l.reset(USER);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  db.ledgerDown = false;
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.restoreAllMocks();
});
function seed(id: string): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.gold = 10_000; s.attributes.vitality = 60;
  db.chars.set(id, { data: s, version: 1 });
}
let ipSeq = 0;
async function join(rm: RMIn, charId: string, how: { roomCode?: string; resume?: boolean } = {}): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(how.roomCode ? { roomCode: how.roomCode } : how.resume ? { resume: true } : { fresh: true }) });
  await until(`${charId}: ответ на вход`, () => !!ws.last('joined') || !!ws.last('error'));
  return ws;
}
/** Отошёл от компьютера: подключённые комнаты не действовали дольше `RUN_IDLE_MS`. */
function afk(room: RoomIn): void {
  for (const c of room.clients.values()) c.activeAt -= RUN_IDLE_MS + 1_000;
}

/** A и B прошли узел вместе (сундук узла — `chestId`) и вернулись в город: забег K припаркован у обоих, городская комната держит его. */
async function party(rm: RMIn, a: string, b: string): Promise<{ room: RoomIn; key: string; wsA: FakeConn; wsB: FakeConn; pidA: string; pidB: string; chestId: number }> {
  seed(a); seed(b);
  const wsA = await join(rm, a);
  const code = wsA.last('joined')!.roomCode;
  const pidA = wsA.last('joined')!.playerId;
  const wsB = await join(rm, b, { roomCode: code });
  const pidB = wsB.last('joined')!.playerId;
  const room = rm.rooms.get(code)!;
  room.stop();   // тик — только шагами теста
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
  return { room, key, wsA, wsB, pidA, pidB, chestId };
}

describe('⭐ R18-04: перезагрузка в городе — «Продолжить» к напарнику, который ждёт в городе', () => {
  it('A и B в городе, вкладка B перезагрузилась — «Продолжить» садит B к A; спуск пати проходит голосом обоих', async () => {
    const rm = manager();
    const { room, key, wsA, wsB, pidA } = await party(rm, 'R18F5A', 'R18F5B');
    const n0 = wsA.frames.length;
    wsB.close();   // F5: сокет закрыт, в городе грейса нет — чистый уход
    await until('B снят', () => !rm.live.has('R18F5B') && !rm.inflight.has('R18F5B') && !rm.charOps.has('R18F5B'));
    expect(room.clients.size, 'A ждёт в городе').toBe(1);
    expect(room.holdsRun(key)).toBe(true);
    const wsB2 = await join(rm, 'R18F5B', { resume: true });
    const j = wsB2.last('joined');
    expect(j, JSON.stringify(wsB2.last('error'))).toBeDefined();
    expect(j!.roomCode, 'к напарнику, а не в новую комнату одному').toBe(room.code);
    expect(room.holdsRun(key), 'забег — у пати').toBe(true);
    room.movedAt = 0;
    room.descend(pidA);
    room.castVote(j!.playerId, true);
    await until('продолжение забега', () => room.area === 'dungeon');
    expect(runLedgerKey(room.runConfig!), 'тот же забег').toBe(key);
    expect(wsA.frames.slice(n0).some((f) => f.t === 'error' && f.code === 'run'), 'A не получал отказа `run`').toBe(false);
  });

  it('контроль R17-02: напарник в городе отошёл (не действовал дольше срока) — «Продолжить» уводит в новую комнату; спуск A — отказ с кодом полем кадра', async () => {
    const rm = manager();
    const { room, key, wsA, wsB, pidA } = await party(rm, 'R18AFA', 'R18AFB');
    wsB.close();
    await until('B снят', () => !rm.live.has('R18AFB') && !rm.inflight.has('R18AFB') && !rm.charOps.has('R18AFB'));
    afk(room);
    const wsB2 = await join(rm, 'R18AFB', { resume: true });
    const j = wsB2.last('joined');
    expect(j, JSON.stringify(wsB2.last('error'))).toBeDefined();
    expect(j!.roomCode, 'новая комната').not.toBe(room.code);
    const mine = rm.rooms.get(j!.roomCode)!;
    mine.stop();
    expect(mine.area).toBe('dungeon');
    expect(mine.holdsRun(key)).toBe(true);
    room.movedAt = 0;
    room.descend(pidA);
    const err = wsA.last('error');
    expect(err, 'спуск A').toMatchObject({ code: 'run', roomCode: mine.code });
  });
});

/** A продолжает забег один (B вышел из города), открывает сундук узла и возвращается в город; свод этой записи в базу не ложится. */
async function lootAlone(rm: RMIn, tag: string, opts: { aLeaves: boolean }): Promise<{ room: RoomIn; key: string; chestId: number; wsA: FakeConn }> {
  const { room, key, wsA, wsB, pidA, chestId } = await party(rm, `${tag}A`, `${tag}B`);
  wsB.push({ t: 'leave' });
  await until('B вышел', () => !rm.live.has(`${tag}B`) && !rm.inflight.has(`${tag}B`) && !rm.charOps.has(`${tag}B`));
  db.ledgerDown = true;
  room.movedAt = 0; room.descend(pidA);
  await until('A продолжил один', () => room.area === 'dungeon');
  const w = room.session.world;
  for (const m of w.monsters) m.alive = false;
  const chest = w.chests.find((c) => c.id === chestId)!;
  w.players[pidA]!.pos = { ...chest.pos };
  room.openChest(pidA, chestId);
  expect(chest.opened, 'A открыл сундук').toBe(true);
  w.players[pidA]!.pos = { ...w.spawn };
  room.movedAt = 0; room.returnTown(pidA);
  expect(room.area).toBe('town');
  await until('свод не лёг', () => db.ledgerFails >= 1);
  if (opts.aLeaves) {
    wsA.push({ t: 'leave' });
    await until('A ушёл', () => !rm.live.has(`${tag}A`), 20_000);
  } else afk(room);   // A стоит в городе, отошёл: держатель забег отдал бы (R17-02)
  return { room, key, chestId, wsA };
}
/** Что увидел бы B: «Продолжить» — вошёл (и открыт ли сундук на узле его комнаты) или отказ. */
async function resumeB(rm: RMIn, tag: string, room: RoomIn, chestId: number): Promise<{ code?: string; opened?: boolean; err?: string }> {
  const ws = await join(rm, `${tag}B`, { resume: true });
  const j = ws.last('joined');
  if (!j) return { err: ws.last('error')!.code };
  const mine = rm.rooms.get(j.roomCode)!;
  mine.stop();
  if (mine === room && room.area === 'town') return { code: j.roomCode };
  return { code: j.roomCode, opened: mine.session.world.chests.find((c) => c.id === chestId)?.opened };
}

describe('⭐ R18-02: недолёгший свод забега — «Продолжить» не собирает узел по базе', () => {
  it('контроль: свод лёг — новая комната B видит сундук открытым', async () => {
    const rm = manager();
    const { room, chestId } = await (async () => {
      const r = await party(rm, 'R18L0A', 'R18L0B');
      r.wsB.push({ t: 'leave' });
      await until('B вышел', () => !rm.live.has('R18L0B') && !rm.inflight.has('R18L0B') && !rm.charOps.has('R18L0B'));
      r.room.movedAt = 0; r.room.descend(r.pidA);
      await until('A продолжил один', () => r.room.area === 'dungeon');
      const w = r.room.session.world;
      for (const m of w.monsters) m.alive = false;
      const chest = w.chests.find((c) => c.id === r.chestId)!;
      w.players[r.pidA]!.pos = { ...chest.pos };
      r.room.openChest(r.pidA, r.chestId);
      w.players[r.pidA]!.pos = { ...w.spawn };
      r.room.movedAt = 0; r.room.returnTown(r.pidA);
      await until('свод лёг', () => !r.room.ledgerPending());
      afk(r.room);
      return r;
    })();
    expect(await resumeB(rm, 'R18L0', room, chestId)).toMatchObject({ opened: true });
  });

  it('свод не лёг, A стоит в городе (отошёл) — B не получает узел с закрытым сундуком: «занято» или сундук открыт', async () => {
    const rm = manager();
    const { room, chestId } = await lootAlone(rm, 'R18L1', { aLeaves: false });
    const r = await resumeB(rm, 'R18L1', room, chestId);
    expect(r.opened === true || r.err === 'busy', JSON.stringify(r)).toBe(true);
    // База вернулась — «Продолжить» сам дописывает недолёгшее (не ждёт повтора по таймеру) и идёт, со взятым сундуком.
    db.ledgerDown = false;
    if (r.err) expect(await resumeB(rm, 'R18L1', room, chestId)).toMatchObject({ opened: true });
  });

  it('свод не лёг, A ушёл из города (комната снята с недолёгшим сводом) — «занято» или сундук открыт', async () => {
    const rm = manager();
    const { room, chestId } = await lootAlone(rm, 'R18L2', { aLeaves: true });
    const r = await resumeB(rm, 'R18L2', room, chestId);
    expect(r.opened === true || r.err === 'busy', JSON.stringify(r)).toBe(true);
    db.ledgerDown = false;   // и свод ушедшей комнаты «Продолжить» дописывает сам
    if (r.err) expect(await resumeB(rm, 'R18L2', room, chestId)).toMatchObject({ opened: true });
  });
});

describe('⭐ R18-02 (кластер): нода держит строку забега за недолёгшим сводом', () => {
  it('комната ушла с недолёгшим сводом — строка забега не отпущена (удар её продлевает), свод лёг — отпущена', async () => {
    const { setRunLockStore } = await import('./roomManager.js');
    const locks = new Map<string, string>();
    const released: string[] = [];
    setRunLockStore({
      claim: async (key, room) => { locks.set(key, room); return null; },
      release: async (key, room) => { released.push(`${key}@${room}`); if (locks.get(key) === room) locks.delete(key); },
    });
    try {
      const rm = manager();
      const { room, key } = await lootAlone(rm, 'R18LC', { aLeaves: true });
      await until('комната ушла', () => !rm.rooms.has(room.code));
      const held = (rm as unknown as { heldRuns(): { key: string; room: string }[] }).heldRuns();
      expect(held.map((r) => r.key), 'строку продлевает удар сердца').toContain(key);
      expect(locks.has(key), 'строка за нодой').toBe(true);
      expect(released.some((r) => r.startsWith(`${key}@`)), 'и не отпущена').toBe(false);
      db.ledgerDown = false;
      await (room as unknown as { flushOwed(): Promise<void> }).flushOwed();   // повтор свода лёг
      const again = (rm as unknown as { heldRuns(): { key: string; room: string }[] }).heldRuns();
      expect(again.map((r) => r.key), 'свод лёг — продлевать нечего').not.toContain(key);
      await until('строка отпущена', () => released.some((r) => r.startsWith(`${key}@`)));
      expect(await resumeProbe(rm, 'R18LCB'), '«Продолжить» идёт').toBe(true);
    } finally { setRunLockStore(null); }
  });
});
/** «Продолжить» героя `charId` — вошёл ли. */
async function resumeProbe(rm: RMIn, charId: string): Promise<boolean> {
  const ws = await join(rm, charId, { resume: true });
  const j = ws.last('joined');
  if (j) rm.rooms.get(j.roomCode)?.stop();
  return !!j;
}

describe('⭐ R18-03: «Завершить» по строке базы — только пока героя держит эта нода', () => {
  /** A вышел из города с припаркованным забегом (грейса нет): «Завершить» пишет штраф по строке базы (`abandonStored`). */
  async function parked(rm: RMIn, tag: string): Promise<string> {
    const { wsA } = await party(rm, `${tag}A`, `${tag}B`);
    wsA.push({ t: 'leave' });
    await until('A вышел', () => !rm.live.has(`${tag}A`) && !rm.inflight.has(`${tag}A`) && !rm.charOps.has(`${tag}A`));
    expect(db.chars.get(`${tag}A`)!.data.run, 'забег A припаркован в строке').toBeTruthy();
    return `${tag}A`;
  }
  async function abandon(rm: RMIn, charId: string): Promise<FakeConn> {
    const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
    rm.handleConnection(ws);
    ws.push({ t: 'abandon', token: TOK, charId });
    await until(`${charId}: ответ на «Завершить»`, () => !!ws.last('abandoned') || !!ws.last('error'));
    return ws;
  }
  let setRowOwner: (o: { node: string; leased: boolean } | null) => void;
  beforeAll(async () => { ({ setRowOwner } = await import('./room.js') as unknown as { setRowOwner: typeof setRowOwner }); });
  afterEach(() => { setRowOwner(null); db.claims.clear(); });

  it('закрепление ушло другой ноде, пока «Завершить» ждал базу (простой машины), — штраф на её героя не пишется, ответ «сохраняем»', async () => {
    const rm = manager();
    const a = await parked(rm, 'R18SA');
    setRowOwner({ node: process.env.DM_NODE_ID ?? 'node-0', leased: true });
    db.claims.set(a, 'node-B');
    const before = structuredClone(db.chars.get(a)!);
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...x: unknown[]) => { errs.push(x.map(String).join(' ')); });
    const ws = await abandon(rm, a);
    expect(ws.last('abandoned'), 'не «завершено»').toBeUndefined();
    expect(ws.last('error')?.code, '«сохраняем, повторите»').toBe('busy');
    expect(db.chars.get(a)!.version, 'строка не тронута').toBe(before.version);
    expect(db.chars.get(a)!.data.run, 'забег цел').toBeTruthy();
    expect(db.chars.get(a)!.data.gold).toBe(before.data.gold);
    expect(errs.some((l) => /ИНЦИДЕНТ/.test(l)), errs.join(' | ')).toBe(true);
  });

  it('контроль: героя держит эта нода — штраф и снятие забега по строке, «завершено»', async () => {
    const rm = manager();
    const a = await parked(rm, 'R18SB');
    const node = process.env.DM_NODE_ID ?? 'node-0';
    setRowOwner({ node, leased: true });
    db.claims.set(a, node);
    const gold0 = db.chars.get(a)!.data.gold;
    const ws = await abandon(rm, a);
    expect(ws.last('abandoned'), JSON.stringify(ws.last('error'))).toBeDefined();
    expect(db.chars.get(a)!.data.run).toBeUndefined();
    expect(db.chars.get(a)!.data.gold).toBeLessThan(gold0);
  });
});

/**
 * ⚠ R19-01: СЕЙВ СТАРШЕ R18-07 (старта не помнит — в базе таких все, кто создан до правки) ПОЛУЧАЕТ СТАРТ ПРИ ВХОДЕ — по строке класса
 * того мига, не выше своих атрибутов (`legacyStartAttributes`), до любой будущей правки. Раньше старт писал только сброс — по строке и очкам
 * за уровень ЖИВОГО конфига: после правки хозяина сброс терял вложенное или дарил очки, и навсегда.
 */
describe('⚠ R19-01: старт сейва старше R18-07 пишет вход', () => {
  it('вход записывает старт: строка класса, а где атрибут ниже неё (герой создан при прежней строке) — сам атрибут', async () => {
    const rm = manager();
    const id = 'R19LEG';
    const cls = cfg.get('classes')[0]!;
    const s = newCharacterSave(cfg, cls.id, id, id) as SaveState;
    delete s.startAttributes;
    s.level = 10; s.unspentAttributePoints = 0; s.gold = 10_000;
    s.attributes.strength += 45;
    s.attributes.vitality = cls.startAttributes.vitality - 3;
    db.chars.set(id, { data: s, version: 1 });
    const ws = await join(rm, id);
    const joined = ws.last('joined');
    expect(joined, JSON.stringify(ws.last('error'))).toBeDefined();
    expect(joined!.save.startAttributes).toEqual({ ...cls.startAttributes, vitality: cls.startAttributes.vitality - 3 });
    expect(joined!.save.attributes, 'атрибуты вход не трогает').toEqual(s.attributes);
  });
});
