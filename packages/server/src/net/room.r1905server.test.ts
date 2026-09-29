import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type RunConfig } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 19 (сервер), R19-05: КОМНАТА НЕ УХОДИТ С ИЗМЕНЁННЫМ, НО НЕ ЗАПИСАННЫМ СВОДОМ ЗАБЕГА. Сундук открыт (или убит монстр), пока запись героя
 * шла в базу, а запись вернулась отказом по версии (отзыв вещи или откат администратором посреди подземелья — `dropStale('lost')`; так же
 * «исход неизвестен» и R18-03 «чужой»): герой снят и ждёт в грейсе, комната на паузе, «Завершить» её снимает. Ни пауза, ни снятие свод не
 * дописывали (`flushLedger` — только чекпойнты: автосейв, узел, город, выход), а повтор по таймеру заводит только упавшая запись свода. Комната
 * навсегда оставалась в учёте недолёгшего (`ledgerOwing`) со всем своим миром; в кластере нода продлевала строку забега (`run_locks`) за
 * исчезнувшей комнатой: «Продолжить» напарника на соседней ноде — `run` с её кодом, вход по коду — «Комната не найдена», по кругу; падение
 * процесса — сундук закрыт снова. Теперь пауза (`enterGrace`) и снятие (`stop`) дописывают свод сразу; не лёг — повтор по таймеру, как у
 * любой упавшей записи свода.
 *
 * Менеджер и комнаты — настоящие; база — маленькая честная (версии строк, свод забега объединением), с крюком «пока запись героя в пути».
 */
const TOK = 'c5'.repeat(32);
const USER = 'user-r1905';
type Rec = { id: string; el: number; chests: number[]; killed: number[]; levers: number[] };
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: SaveState; version: number }>(),
  ledger: new Map<string, Map<string, { id: string; el: number; chests: number[]; killed: number[]; levers: number[] }>>(),
  ledgerDown: false,
  /** Запись героя `hookChar` в пути: крюк зовётся после снимка сейва, до ответа базы. */
  hookChar: '',
  hook: null as null | (() => void),
  /** R18-03: закрепления героев (`char_claims`): чья нода держит героя (нет строки — эта). */
  claims: new Map<string, string>(),
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async (key: string) => [...(db.ledger.get(key)?.values() ?? [])].map((r) => structuredClone(r)),
  mergeRunLedger: async (key: string, recs: Rec[]) => {
    await new Promise((res) => setTimeout(res, 1));
    if (db.ledgerDown) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    let m = db.ledger.get(key);
    if (!m) db.ledger.set(key, (m = new Map()));
    const u = (a: number[] = [], b: number[] = []): number[] => [...new Set([...a, ...b])].sort((x, y) => x - y);
    for (const r of recs) {
      const cur = m.get(r.id);
      m.set(r.id, cur ? { ...cur, chests: u(cur.chests, r.chests), killed: u(cur.killed, r.killed), levers: u(cur.levers, r.levers) } : structuredClone(r));
    }
  },
  landedVersion: async () => null,
  getSession: async (token: string) => (token === 'c5'.repeat(32) ? 'user-r1905' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r1905', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: SaveState, v: number) => {
    const json = JSON.stringify(data);   // снимок — в момент вызова, как `snapshotOf`
    if (db.hook && charId === db.hookChar) { const h = db.hook; db.hook = null; h(); }
    await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = JSON.parse(json) as SaveState;
    return r.version;
  },
  // R18-03: как в базе — владение и запись одним запросом: героя держит другая нода — `foreign`, не записано ничего.
  putCharacterOwned: async (charId: string, _u: string, data: SaveState, v: number, owner: { node: string }) => {
    const json = JSON.stringify(data);
    if (db.hook && charId === db.hookChar) { const h = db.hook; db.hook = null; h(); }
    await new Promise((res) => setTimeout(res, 1));
    if ((db.claims.get(charId) ?? owner.node) !== owner.node) return 'foreign';
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
type RoomIn = {
  code: string; area: string; movedAt: number; runConfig: RunConfig | null; nodeState: { id: string } | null; ledgerRetry: unknown;
  stop(): void; descend(pid: string): void; returnTown(pid: string): void; castVote(pid: string, yes: boolean): void; openChest(pid: string, id: number): void;
  ledgerPending(): boolean; persist(pid: string): Promise<string>;
  session: { world: { players: Record<string, Pl>; spawn: { x: number; y: number }; monsters: { alive: boolean }[]; chests: { id: number; pos: { x: number; y: number }; opened: boolean }[] } };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; charOps: Map<string, unknown>; graceByChar: Map<string, unknown>;
  handleConnection(ws: GameConn): void; heldRuns(): { key: string; room: string }[];
};
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let setRunLockStore: typeof import('./roomManager.js').setRunLockStore;
let runLedgerKey: (cfg: RunConfig) => string;
let ledgerOwingRooms: () => readonly unknown[];
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor, setRunLockStore } = await import('./roomManager.js'));
  ({ runLedgerKey, ledgerOwingRooms } = await import('./room.js') as unknown as { runLedgerKey: typeof runLedgerKey; ledgerOwingRooms: typeof ledgerOwingRooms });
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
  db.ledgerDown = false; db.hook = null;
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync, limits.stashRead]) l.reset(USER);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  db.ledgerDown = false;
  setRunLockStore(null);
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
/** Строка забега в реестре кластера (`run_locks`): взятия и отпуски. */
function lockStore(): { locks: Map<string, string>; released: string[] } {
  const locks = new Map<string, string>();
  const released: string[] = [];
  setRunLockStore({
    claim: async (key, room) => { locks.set(key, room); return null; },
    release: async (key, room) => { released.push(`${key}@${room}`); if (locks.get(key) === room) locks.delete(key); },
  });
  return { locks, released };
}

/**
 * A и B прошли узел вместе и вернулись в город; B вышел, A продолжил забег один. Пока автосейв A шёл в базу, администратор отозвал вещь
 * (версия строки +1), а бой шёл — A открыл сундук узла (`down` — и свод с этого мига база не принимает). Запись — отказ по версии: A снят и
 * ждёт в грейсе, комната на паузе. A жмёт «Завершить» — комната снята. `foreign` — вместо отзыва героя за это время взяла другая нода
 * (R18-03): запись — «чужой», A снят без грейса, и комната уходит сразу.
 */
async function staleTeardown(
  rm: RMIn, tag: string, down: boolean, foreign = false,
): Promise<{ room: RoomIn; code: string; key: string; nodeId: string; chestId: number }> {
  const A = `${tag}A`, B = `${tag}B`;
  seed(A); seed(B);
  const wsA = await join(rm, A);
  const code = wsA.last('joined')!.roomCode;
  const pidA = wsA.last('joined')!.playerId;
  const wsB = await join(rm, B, { roomCode: code });
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
  expect(room.area).toBe('town');
  await until('свод лёг', () => !room.ledgerPending());
  wsB.push({ t: 'leave' });
  await until('B вышел', () => !rm.live.has(B) && !rm.inflight.has(B) && !rm.charOps.has(B));
  room.movedAt = 0; room.descend(pidA);
  await until('A продолжил один', () => room.area === 'dungeon');
  room.stop();   // продолжение ставит комнату на тик заново — снова только шагами теста
  await until('свод входа в узел лёг', () => !room.ledgerPending());
  const nodeId = room.nodeState!.id;
  for (const m of room.session.world.monsters) m.alive = false;
  const chest = room.session.world.chests.find((c) => c.id === chestId)!;
  expect(chest.opened).toBe(false);
  db.hookChar = A;
  db.hook = () => {
    if (foreign) db.claims.set(A, 'node-B');   // героя взяла другая нода (простой машины, R18-03)
    else db.chars.get(A)!.version += 1;   // отзыв вещи администратором: строка героя обогнала копию
    room.session.world.players[pidA]!.pos = { ...chest.pos };
    room.openChest(pidA, chestId);
    if (down) db.ledgerDown = true;
  };
  expect(await room.persist(pidA), 'запись — отказ (и «чужой» — тоже отказ)').toBe('conflict');
  expect(chest.opened, 'сундук открыт, пока запись шла').toBe(true);
  if (foreign) {
    await until('комната ушла вместе с A', () => !rm.rooms.has(code));
    return { room, code, key, nodeId, chestId };
  }
  await until('A снят (4009) и ждёт в грейсе', () => !rm.live.has(A) && rm.graceByChar.has(A));
  const ab = new FakeConn('203.0.113.9');
  rm.handleConnection(ab);
  ab.push({ t: 'abandon', token: TOK, charId: A });
  await until('«Завершить» A', () => !!ab.last('abandoned') || !!ab.last('error'));
  expect(ab.last('abandoned'), JSON.stringify(ab.last('error'))).toBeDefined();
  await until('комната ушла', () => !rm.rooms.has(code));
  return { room, code, key, nodeId, chestId };
}
const chestInDb = (key: string, nodeId: string, chestId: number): boolean => !!db.ledger.get(key)?.get(nodeId)?.chests.includes(chestId);

describe('⭐ R19-05: комната уходит — свод забега дописан', () => {
  it('сундук, открытый пока запись шла, — в своде базы; ушедшая комната не в учёте недолёгшего, строка забега отпущена', async () => {
    const { locks, released } = lockStore();
    const rm = manager();
    const { room, code, key, nodeId, chestId } = await staleTeardown(rm, 'R19LT', false);
    await until('свод дописан', () => chestInDb(key, nodeId, chestId) && !ledgerOwingRooms().includes(room));
    expect(ledgerOwingRooms(), 'ушедшая комната не висит в учёте').not.toContain(room);
    expect(rm.heldRuns().map((r) => r.key), 'строку забега удар не продлевает').not.toContain(key);
    await until('строка забега отпущена', () => released.includes(`${key}@${code}`));
    expect(locks.has(key)).toBe(false);
    // Напарник продолжает — узел со взятым сундуком.
    const ws = await join(rm, 'R19LTB', { resume: true });
    const j = ws.last('joined');
    expect(j, JSON.stringify(ws.last('error'))).toBeDefined();
    const mine = rm.rooms.get(j!.roomCode)!;
    mine.stop();
    expect(mine.session.world.chests.find((c) => c.id === chestId)?.opened, 'сундук открыт').toBe(true);
  });

  it('свод в миг снятия база не принимает — у ушедшей комнаты повтор по таймеру; легло — учёт и строка забега отпущены', async () => {
    const { locks, released } = lockStore();
    const rm = manager();
    const retries: (() => void)[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 5_000) retries.push(fn);   // повтор свода (`LEDGER_RETRY_MS`)
      return Reflect.apply(realSetTimeout, globalThis, [fn, ms, ...rest]) as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const { room, code, key, nodeId, chestId } = await staleTeardown(rm, 'R19LD', true);
    await until('запись свода упала — повтор заведён', () => room.ledgerRetry != null);
    expect(ledgerOwingRooms(), 'должна базе').toContain(room);
    expect(room.ledgerRetry, 'повтор заведён').not.toBeNull();
    expect(rm.heldRuns().map((r) => r.key), 'строку держит, пока свод не лёг (R18-02)').toContain(key);
    expect(chestInDb(key, nodeId, chestId)).toBe(false);
    db.ledgerDown = false;
    expect(retries.length, 'таймер повтора').toBeGreaterThan(0);
    retries.at(-1)!();   // срок повтора вышел
    await until('повтор лёг', () => chestInDb(key, nodeId, chestId) && !ledgerOwingRooms().includes(room));
    expect(rm.heldRuns().map((r) => r.key), 'продлевать нечего').not.toContain(key);
    await until('строка забега отпущена', () => released.includes(`${key}@${code}`));
    expect(locks.has(key)).toBe(false);
  });

  it('R18-03 «чужой»: героя, чья запись в пути, взяла другая нода — комната уходит сразу (без грейса), и свод всё равно дописан', async () => {
    const { locks, released } = lockStore();
    const rm = manager();
    const node = process.env.DM_NODE_ID ?? 'node-0';
    const { setRowOwner } = await import('./room.js') as unknown as { setRowOwner(o: { node: string; leased: boolean } | null): void };
    setRowOwner({ node, leased: true });
    try {
      const { room, code, key, nodeId, chestId } = await staleTeardown(rm, 'R19LF', false, true);
      await until('свод дописан', () => chestInDb(key, nodeId, chestId) && !ledgerOwingRooms().includes(room));
      expect(rm.heldRuns().map((r) => r.key)).not.toContain(key);
      await until('строка забега отпущена', () => released.includes(`${key}@${code}`));
      expect(locks.has(key)).toBe(false);
    } finally { setRowOwner(null); db.claims.clear(); }
  });
});
