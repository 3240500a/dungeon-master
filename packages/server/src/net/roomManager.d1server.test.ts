import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type RunConfig } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ D1: ОДНО ПРАВИЛО ОБЩЕГО ПРИПАРКОВАННОГО ЗАБЕГА (docs/MULTIPLAYER.md, «Общий припаркованный забег»). Пять кругов ревью подряд (R17-02 → R18-04 →
 * R19-04 → R20-02/03/06, C-03/C-08, R16-01) латали и снова ломали, как участники пати продолжают забег, припаркованный в городе: «отдать забег
 * отошедшему», «кроме действующего», просьбы продолжить, их сроки и отказы. Теперь — одно правило с явным состоянием:
 *  1. «Продолжить» ведёт к комнате, что держит забег (город или подземелье; другая нода — отказ `run` с кодом), нет держателя — новая комната с ним;
 *  2. в городе держателя любой зовёт спуск, он проходит «за» всех подключённых; голос вне подземелья живёт `VOTE_TIMEOUT_MS` (⭐ R23-02: и в
 *     подземелье — там по сроку молчащие голос не держат, он проходит «за» ответивших);
 *  3. голос не прошёл («нет» другого, срок) — право «Соло» (`Room.soloRight`) и подсказка `solo` (⭐ R23-01: каждому участнику, сказавшему «за»,
 *     а не одному позвавшему); «Продолжить без пати»
 *     (`join{resume, solo}`) — бесплатно своя комната с забегом, сразу в подземелье; оставшиеся — с припаркованным, их спуск и «Продолжить» — к ней;
 *  4. в подземелье забег — в одной комнате кластера, остальные участники — туда (нет мест — код её комнаты);
 *  5. «Забросить» не нужно ни в одном из этих состояний.
 * Менеджер и комнаты — настоящие; база — маленькая честная (версии строк, свод забега объединением). Часы процесса (`performance.now`: срок
 * голосования, пауза голосований) — поддельные: время идёт только шагом теста (`later`).
 */
const TOK = 'd1'.repeat(32);
const USER = 'user-d1';
type Rec = { id: string; el: number; chests: number[]; killed: number[]; levers: number[] };
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: SaveState; version: number }>(),
  ledger: new Map<string, Map<string, { id: string; el: number; chests: number[]; killed: number[]; levers: number[] }>>(),
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async (key: string) => [...(db.ledger.get(key)?.values() ?? [])].map((r) => structuredClone(r)),
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
  getSession: async (token: string) => (token === 'd1'.repeat(32) ? 'user-d1' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-d1', data: structuredClone(r.data), version: r.version } : null;
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
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
/** Ждать условия оборотами цикла (не часами): записи мока идут кругами по миллисекунде. */
async function until(what: string, ok: () => boolean, turns = 5_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}

type Pl = { pos: { x: number; y: number }; save: SaveState; alive: boolean; hp: number; debuffs: Record<string, unknown> };
type RoomIn = {
  code: string; area: string; movedAt: number; runConfig: RunConfig | null; vote: { kind: string; by?: string } | null; runNodeId: string | null;
  clients: Map<string, unknown>;
  stop(): void; step(emit?: boolean): void; descend(pid: string): void; returnTown(pid: string): void; enterArena(pid: string): void;
  castVote(pid: string, yes: boolean): void; holdsRun(key: string): boolean; soloRight(charId: string, key: string): boolean; ledgerPending(): boolean;
  seatsTaken(charId: string): number;
  session: {
    world: {
      players: Record<string, Pl>; spawn: { x: number; y: number }; monsters: { alive: boolean }[]; exits?: { x: number; y: number }[]; timeMs: number;
    };
  };
};
type RMIn = { rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; charOps: Map<string, unknown>; handleConnection(ws: GameConn): void };
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let runLedgerKey: (cfg: RunConfig) => string;
let VOTE_TIMEOUT_MS: number;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  ({ runLedgerKey, VOTE_TIMEOUT_MS } = await import('./room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
function manager(): RMIn {
  // Часы процесса — поддельные на весь тест (стоят, пока тест их не сдвинет); интервалы менеджера — тоже (фоновых кругов нет).
  vi.useFakeTimers({ toFake: ['setInterval', 'performance'] });
  later(1_000_000);
  const rm = new RoomManagerCtor(cfg) as unknown as RMIn;
  managers.push(rm);
  return rm;
}
/** Прошло `ms` по часам процесса. */
function later(ms: number): void { vi.advanceTimersByTime(ms); }
beforeEach(() => {
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync, limits.stashRead]) l.reset(USER);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function seed(id: string): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.gold = 10_000; s.attributes.vitality = 60;
  db.chars.set(id, { data: s, version: 1 });
}
let ipSeq = 0;
type How = { roomCode?: string; resume?: boolean; solo?: boolean };
/** Кадр входа на сокете `ws` (новом или живом — как веб-клиент после `leave`) и ответ на него. */
async function joinOn(ws: FakeConn, charId: string, how: How): Promise<Extract<ServerFrame, { t: 'joined' }> | Extract<ServerFrame, { t: 'error' }>> {
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby]) l.reset(USER);   // лимиты входа — не предмет теста (часы стоят)
  const n = ws.frames.length;
  ws.push({ t: 'join', token: TOK, charId, ...(how.roomCode ? { roomCode: how.roomCode } : how.resume ? { resume: true, ...(how.solo ? { solo: true } : {}) } : { fresh: true }) });
  await until(`${charId}: ответ на вход`, () => ws.frames.slice(n).some((f) => f.t === 'joined' || f.t === 'error'));
  return ws.frames.slice(n).find((f) => f.t === 'joined' || f.t === 'error') as Extract<ServerFrame, { t: 'joined' }> | Extract<ServerFrame, { t: 'error' }>;
}
async function join(rm: RMIn, charId: string, how: How = {}): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  await joinOn(ws, charId, how);
  return ws;
}
async function gone(rm: RMIn, charId: string): Promise<void> {
  await until(`${charId} снят`, () => !rm.live.has(charId) && !rm.inflight.has(charId) && !rm.charOps.has(charId));
}
const errs = (ws: FakeConn, from = 0): Extract<ServerFrame, { t: 'error' }>[] =>
  ws.frames.slice(from).filter((f): f is Extract<ServerFrame, { t: 'error' }> => f.t === 'error');
const hints = (ws: FakeConn, from = 0): Extract<ServerFrame, { t: 'error' }>[] => errs(ws, from).filter((f) => f.code === 'vote' && f.solo === true);
/** «Продолжить без пати» веб-клиента (`EntryFlow.toEntry`): `leave` по живому сокету — и тем же сокетом `join{resume, solo}`. */
async function soloOut(rm: RMIn, ws: FakeConn, charId: string): Promise<Extract<ServerFrame, { t: 'joined' }> | Extract<ServerFrame, { t: 'error' }>> {
  ws.push({ t: 'leave' });
  const r = await joinOn(ws, charId, { resume: true, solo: true });
  expect(ws.open, 'соединение живо').toBe(true);
  void rm;
  return r;
}
/** Комната героя, куда он вошёл (тик — только шагами теста). */
function roomOf(rm: RMIn, f: { roomCode?: string } | undefined): RoomIn {
  const r = rm.rooms.get(f!.roomCode!)!;
  r.stop();
  return r;
}

/**
 * A и B прошли узел вместе и вернулись в город: забег K припаркован у обоих, городская комната A держит его. B вышел из города (чистый уход —
 * грейса в городе нет) и возвращается «Продолжить» — к A (правило 1).
 */
async function party(rm: RMIn, a: string, b: string): Promise<{ room: RoomIn; key: string; wsA: FakeConn; pidA: string; wsB: FakeConn; pidB: string }> {
  seed(a); seed(b);
  const wsA = await join(rm, a);
  const code = wsA.last('joined')!.roomCode;
  const pidA = wsA.last('joined')!.playerId;
  const wsB0 = await join(rm, b, { roomCode: code });
  const pidB0 = wsB0.last('joined')!.playerId;
  const room = rm.rooms.get(code)!;
  room.stop();   // тик — только шагами теста
  await until('записи входа легли', () => !rm.inflight.size);
  room.movedAt = 0; room.descend(pidA); room.castVote(pidB0, true);
  expect(room.area).toBe('dungeon');
  const key = runLedgerKey(room.runConfig!);
  const w = room.session.world;
  for (const m of w.monsters) m.alive = false;
  w.players[pidA]!.pos = { ...w.spawn }; w.players[pidB0]!.pos = { ...w.spawn };
  room.movedAt = 0; room.returnTown(pidA); room.castVote(pidB0, true);
  expect(room.area, 'пати в городе').toBe('town');
  await until('свод лёг', () => !room.ledgerPending());
  wsB0.push({ t: 'leave' });
  await gone(rm, b);
  expect(room.holdsRun(key), 'город A держит забег').toBe(true);
  // Правило 1: «Продолжить» — к держателю в город, сколько бы A ни стоял без дела (раньше R17-02 уводил забег от «отошедшего»).
  later(10 * 60_000);
  const wsB = await join(rm, b, { resume: true });
  const j = wsB.last('joined');
  expect(j, JSON.stringify(wsB.last('error'))).toBeDefined();
  expect(j!.roomCode, '«Продолжить» — к держателю, в город A').toBe(room.code);
  room.movedAt = 0;
  return { room, key, wsA, pidA, wsB, pidB: j!.playerId };
}
/** B зовёт спуск в городе A; окно голосования открыто. */
async function callDescend(ws: FakeConn): Promise<number> {
  const n0 = ws.frames.length;
  ws.push({ t: 'descend' });
  await until('окно голосования', () => ws.frames.slice(n0).some((f) => f.t === 'voteStart'));
  return n0;
}
/** Новая комната «Соло» B — сразу в подземелье его забега, держит его; город A отпустил; золото и забег B целы (без «Забросить»). */
function expectSoloRoom(rm: RMIn, j: { t: string; roomCode?: string }, room: RoomIn, key: string, charId: string, gold: number): RoomIn {
  expect(j.t, JSON.stringify(j)).toBe('joined');
  expect(j.roomCode, 'не в город A').not.toBe(room.code);
  const mine = roomOf(rm, j);
  expect(mine.area, 'сразу в подземелье').toBe('dungeon');
  expect(runLedgerKey(mine.runConfig!), 'его забег').toBe(key);
  expect(mine.holdsRun(key), 'забег держит его комната').toBe(true);
  expect(room.holdsRun(key), 'город A забег отпустил').toBe(false);
  const p = Object.values(mine.session.world.players).find((x) => x.save.charId === charId)!;
  expect(p.save.gold, 'бесплатно').toBe(gold);
  expect(p.save.run, 'забег цел').toBeTruthy();
  return mine;
}

describe('⭐ D1: правило 1–2 — «Продолжить» к держателю, спуск «за» всех', () => {
  it('B вернулся к стоящему без дела A (правило 1); спуск B, «за» A — вместе на узел того же забега', async () => {
    const rm = manager();
    const { room, key, wsA, pidA, wsB } = await party(rm, 'D1TA', 'D1TB');
    const n0 = await callDescend(wsB);
    expect(room.area, 'без голоса A спуска нет').toBe('town');
    room.castVote(pidA, true);
    await until('продолжение забега', () => room.area === 'dungeon');
    expect(runLedgerKey(room.runConfig!), 'тот же забег').toBe(key);
    expect(room.clients.size, 'вдвоём').toBe(2);
    expect(hints(wsB, n0), 'голос прошёл — «Соло» не предлагают').toEqual([]);
    expect(errs(wsA).filter((f) => f.code === 'run'), 'A не получал отказа `run`').toEqual([]);
  });

  it('контроль (K1): погибший в забеге («мёртв, оплачено») входит к пати в город — без забега, её спуск оживит его', async () => {
    const rm = manager();
    const r = await party(rm, 'D1KC', 'D1KD');
    r.wsB.push({ t: 'leave' });
    await gone(rm, 'D1KD');
    const row = db.chars.get('D1KD')!;
    row.data.run!.deadAt = row.data.run!.currentNodeId;   // погиб в этом забеге на его узле, штраф взят (как `Room.markDead`)
    const wsD = await join(rm, 'D1KD', { resume: true });
    expect(wsD.last('joined')?.roomCode, JSON.stringify(wsD.last('error'))).toBe(r.room.code);
    expect(wsD.last('joined')!.save.run, 'без забега').toBeUndefined();
    expect(r.room.holdsRun(r.key), 'город пати забег держит').toBe(true);
  });
});

describe('⭐ D1: правило 3 — голос не прошёл: «Соло» бесплатно, оставшиеся — к нему', () => {
  it('«нет» A: подсказка `solo` B сразу (A — нет); «Продолжить без пати» по тому же сокету — своя комната в подземелье; спуск и «Продолжить» A — к нему', async () => {
    const rm = manager();
    const { room, key, wsA, pidA, wsB } = await party(rm, 'D1NA', 'D1NB');
    const gold = db.chars.get('D1NB')!.data.gold;
    const n0 = await callDescend(wsB);
    wsA.push({ t: 'vote', accept: false });
    await until('голосование закрыто', () => wsB.frames.slice(n0).some((f) => f.t === 'voteEnd'));
    expect(room.area).toBe('town');
    expect(hints(wsB, n0), 'подсказка — сразу и одна').toHaveLength(1);
    expect(hints(wsA), 'отказавшему — нет').toEqual([]);
    expect(room.soloRight('D1NB', key), 'право «Соло» — явное состояние').toBe(true);
    const mine = expectSoloRoom(rm, await soloOut(rm, wsB, 'D1NB'), room, key, 'D1NB', gold);
    // Оставшийся: спуск — отказ `run` с кодом комнаты B (кадром — клиент предложит «Продолжить»), в его городе ничего не начинается.
    room.movedAt = 0;
    room.descend(pidA);
    expect(wsA.last('error'), 'спуск A').toMatchObject({ code: 'run', roomCode: mine.code });
    expect(room.area).toBe('town');
    // «Продолжить» A (кнопка веб-клиента: `leave` и `join{resume}`) — в подземелье к B, тот же забег, одна комната.
    wsA.push({ t: 'leave' });
    const jA = await joinOn(wsA, 'D1NA', { resume: true });
    expect(jA, JSON.stringify(jA)).toMatchObject({ t: 'joined', roomCode: mine.code });
    expect(mine.clients.size, 'вдвоём в подземелье').toBe(2);
    expect(db.chars.get('D1NA')!.data.gold, 'и A без штрафа').toBe(10_000);
  });

  it('A молчит (отошёл, не хочет): срок голосования — «нет» по сроку, подсказка B; «Соло» — своя комната в подземелье', async () => {
    const rm = manager();
    const { room, key, wsB } = await party(rm, 'D1IA', 'D1IB');
    const gold = db.chars.get('D1IB')!.data.gold;
    const n0 = await callDescend(wsB);
    later(VOTE_TIMEOUT_MS - 1_000);
    room.step(false);
    expect(room.vote, 'до срока — голосование открыто').not.toBeNull();
    expect(hints(wsB, n0), 'и без подсказки').toEqual([]);
    later(1_000);
    room.step(false);
    expect(room.vote, 'срок вышел — голос не прошёл').toBeNull();
    expect(wsB.frames.slice(n0).some((f) => f.t === 'voteEnd' && !f.passed)).toBe(true);
    expect(hints(wsB, n0)).toHaveLength(1);
    room.step(false);
    expect(hints(wsB, n0), 'не повторяется').toHaveLength(1);
    expectSoloRoom(rm, await soloOut(rm, wsB, 'D1IB'), room, key, 'D1IB', gold);
  });

  it('своя отмена («нет» на своё) права не даёт; «Соло» без права и простое «Продолжить» после провала — к держателю (пати не раскалывается)', async () => {
    const rm = manager();
    const { room, key, wsA, wsB } = await party(rm, 'D1CA', 'D1CB');
    let n0 = await callDescend(wsB);
    wsB.push({ t: 'vote', accept: false });   // передумал сам
    await until('голосование закрыто', () => room.vote === null);
    expect(hints(wsB, n0), 'своя отмена — не отказ пати').toEqual([]);
    expect(room.soloRight('D1CB', key)).toBe(false);
    let j = await soloOut(rm, wsB, 'D1CB');
    expect(j, '«Соло» без права — к держателю, как «Продолжить»').toMatchObject({ t: 'joined', roomCode: room.code });
    expect(room.holdsRun(key)).toBe(true);
    // Голос не прошёл («нет» A) — право есть; но B перезагрузился и нажал простое «Продолжить» (R20-02: давний отказ не раскалывает пати).
    later(2_000); room.movedAt = 0;
    n0 = await callDescend(wsB);
    wsA.push({ t: 'vote', accept: false });
    await until('подсказка', () => hints(wsB, n0).length > 0);
    wsB.close();
    await gone(rm, 'D1CB');
    expect(room.soloRight('D1CB', key), 'право переживает уход — «Соло» может прийти после `leave`').toBe(true);
    const ws2 = await join(rm, 'D1CB', { resume: true });
    expect(ws2.last('joined')?.roomCode, 'простое «Продолжить» — к пати').toBe(room.code);
    expect(room.soloRight('D1CB', key), 'вернулся к пати — право снято').toBe(false);
    expect(room.holdsRun(key)).toBe(true);
  });

  it('право снимает прошедший голос: провал, потом «за» обоих — вместе; права больше нет', async () => {
    const rm = manager();
    const { room, key, wsA, pidA, wsB } = await party(rm, 'D1PA', 'D1PB');
    const n0 = await callDescend(wsB);
    wsA.push({ t: 'vote', accept: false });
    await until('подсказка', () => hints(wsB, n0).length > 0);
    expect(room.soloRight('D1PB', key)).toBe(true);
    later(2_000); room.movedAt = 0;
    room.descend(pidA);
    wsB.push({ t: 'vote', accept: true });
    await until('вместе в подземелье', () => room.area === 'dungeon');
    expect(room.soloRight('D1PB', key), 'пати пошла вместе — права нет').toBe(false);
  });

  it('пока B выходил за «Соло», A один позвал спуск и ушёл в подземелье — «Соло» ведёт к нему (правило 4), второй комнаты у забега нет', async () => {
    const rm = manager();
    const { room, key, wsA, pidA, wsB } = await party(rm, 'D1RA', 'D1RB');
    const n0 = await callDescend(wsB);
    wsA.push({ t: 'vote', accept: false });
    await until('подсказка', () => hints(wsB, n0).length > 0);
    wsB.push({ t: 'leave' });
    await gone(rm, 'D1RB');
    later(2_000); room.movedAt = 0;
    room.descend(pidA);   // один в городе — голос проходит сразу
    await until('A продолжил забег', () => room.area === 'dungeon');
    const j = await joinOn(wsB, 'D1RB', { resume: true, solo: true });
    expect(j, 'к пати в подземелье, а не второй комнатой рядом').toMatchObject({ t: 'joined', roomCode: room.code });
    expect([...rm.rooms.values()].filter((r) => r.area === 'dungeon' && r.runConfig && runLedgerKey(r.runConfig) === key)).toHaveLength(1);
  });
});

describe('⭐ D1: спуск держателя — за его забег, кто бы ни вошёл раньше (фаззер коопа, сид 100127)', () => {
  it('гость со своим забегом вошёл в город, держащий чужой ему забег, раньше вернувшегося участника — спуск участника продолжает забег комнаты', async () => {
    const rm = manager();
    for (const id of ['D1GA', 'D1GB', 'D1GC']) seed(id);
    // C прошёл узел своего забега X в своей комнате и вышел из города: X припаркован у него.
    const wsC0 = await join(rm, 'D1GC');
    const rc = roomOf(rm, wsC0.last('joined'));
    const pidC0 = wsC0.last('joined')!.playerId;
    await until('запись входа C легла', () => !rm.inflight.size);
    rc.movedAt = 0; rc.descend(pidC0);
    expect(rc.area).toBe('dungeon');
    const keyX = runLedgerKey(rc.runConfig!);
    rc.session.world.players[pidC0]!.pos = { ...rc.session.world.spawn };
    rc.movedAt = 0; rc.returnTown(pidC0);
    expect(rc.area).toBe('town');
    wsC0.push({ t: 'leave' });
    await gone(rm, 'D1GC');
    // A и B — забег K; B отвалился в подземелье, A один увёл комнату в город (B там припаркован — комната держит K) и вышел.
    const wsA = await join(rm, 'D1GA');
    const room = roomOf(rm, wsA.last('joined'));
    const pidA = wsA.last('joined')!.playerId;
    const wsB = await join(rm, 'D1GB', { roomCode: room.code });
    const pidB = wsB.last('joined')!.playerId;
    await until('записи входа легли', () => !rm.inflight.size);
    room.movedAt = 0; room.descend(pidA); room.castVote(pidB, true);
    expect(room.area).toBe('dungeon');
    const key = runLedgerKey(room.runConfig!);
    const w = room.session.world;
    for (const m of w.monsters) m.alive = false;
    w.players[pidA]!.pos = { ...w.spawn }; w.players[pidB]!.pos = { ...w.spawn };
    wsB.close();
    await until('B ждёт реконнекта', () => !rm.live.has('D1GB') && !rm.inflight.has('D1GB'));
    room.movedAt = 0; room.returnTown(pidA);
    expect(room.area).toBe('town');
    wsA.push({ t: 'leave' });
    await gone(rm, 'D1GA');
    expect(room.holdsRun(key), 'город держит K: его участник B припаркован здесь').toBe(true);
    // C (свой X) входит по коду — первым; A «Продолжить» — к держателю, вторым.
    const wsC = await join(rm, 'D1GC', { roomCode: room.code });
    expect(wsC.last('joined')?.roomCode, JSON.stringify(wsC.last('error'))).toBe(room.code);
    const wsA2 = await join(rm, 'D1GA', { resume: true });
    expect(wsA2.last('joined')?.roomCode, 'правило 1: к держателю').toBe(room.code);
    room.stop();
    room.movedAt = 0;
    const n0 = await callDescend(wsA2);
    const v = wsA2.frames.slice(n0).find((f): f is Extract<ServerFrame, { t: 'voteStart' }> => f.t === 'voteStart');
    expect(v?.resume, 'спуск продолжает K (хозяин — участник A), а не X гостя').toMatchObject({ host: 'D1GA' });
    expect(errs(wsA2, n0).filter((f) => f.code === 'run'), 'было: «у вас незавершённый забег» — и «Продолжить» снова сюда').toEqual([]);
    // Гость со своим X не пойдёт (его «за» — отказ `run` с кнопкой «Продолжить свой»), и не отвечает — срок, и A уходит «Соло».
    later(VOTE_TIMEOUT_MS);
    room.step(false);
    await until('подсказка', () => hints(wsA2, n0).length > 0);
    const gold = db.chars.get('D1GA')!.data.gold;
    expectSoloRoom(rm, await soloOut(rm, wsA2, 'D1GA'), room, key, 'D1GA', gold);
    expect(db.chars.get('D1GC')!.data.run?.config && runLedgerKey(db.chars.get('D1GC')!.data.run!.config), 'X гостя цел').toBe(keyX);
  });
});

describe('⭐ D1: спуск в городе не заслоняется, арена и полная пати — не тупик', () => {
  it('A держит слот голосования ареной (открывает снова на каждый конец): спуск B — его «нет» арене и свой голос; «нет» A — «Соло»', async () => {
    const rm = manager();
    const { room, key, wsA, wsB } = await party(rm, 'D1HA', 'D1HB');
    const gold = db.chars.get('D1HB')!.data.gold;
    wsA.push({ t: 'arena' });
    await until('голосование за арену', () => room.vote?.kind === 'arena');
    const n0 = wsB.frames.length;
    wsB.push({ t: 'descend' });
    await until('голосование за спуск', () => room.vote?.kind === 'descend');
    wsA.push({ t: 'arena' });   // скрипт A открывает арену снова — слот занят спуском B: отказ
    await until('отказ A', () => errs(wsA).some((f) => f.code === 'vote'));
    expect(room.vote?.kind, 'слот — у спуска B').toBe('descend');
    wsA.push({ t: 'vote', accept: false });
    await until('подсказка', () => hints(wsB, n0).length > 0);
    expectSoloRoom(rm, await soloOut(rm, wsB, 'D1HB'), room, key, 'D1HB', gold);
  });

  it('держатель на арене: возврат в город B не принят («нет» A) — «Соло» из арены', async () => {
    const rm = manager();
    const { room, key, wsA, pidA, wsB, pidB } = await party(rm, 'D1AA', 'D1AB');
    const gold = db.chars.get('D1AB')!.data.gold;
    room.enterArena(pidA); room.castVote(pidB, true);
    expect(room.area).toBe('arena');
    expect(room.holdsRun(key), 'арена держит забег, как город').toBe(true);
    later(2_000); room.movedAt = 0;
    const n0 = wsB.frames.length;
    wsB.push({ t: 'return' });
    await until('голосование «в город»', () => room.vote?.kind === 'town');
    wsA.push({ t: 'vote', accept: false });
    await until('подсказка', () => hints(wsB, n0).length > 0);
    const mine = expectSoloRoom(rm, await soloOut(rm, wsB, 'D1AB'), room, key, 'D1AB', gold);
    void mine;
  });

  it('держатель в городе без свободного места — «Продолжить» участника само «Соло» (голоса там не позвать), а не «нет мест» навсегда', async () => {
    const rm = manager();
    const { room, key, wsB } = await party(rm, 'D1FA', 'D1FB');
    wsB.push({ t: 'leave' });
    await gone(rm, 'D1FB');
    for (const g of ['D1FC', 'D1FD', 'D1FE']) { seed(g); await join(rm, g, { roomCode: room.code }); }
    expect(room.seatsTaken('D1FB'), 'пати полна: A и трое по коду').toBe(4);
    const gold = db.chars.get('D1FB')!.data.gold;
    const ws = new FakeConn('198.51.100.250');
    rm.handleConnection(ws);
    expectSoloRoom(rm, await joinOn(ws, 'D1FB', { resume: true }), room, key, 'D1FB', gold);
  });
});

/**
 * ⭐ R22-05: ГОЛОС, ЗА КОТОРЫЙ УЖЕ ВСЕ, СРОКОМ НЕ ПРОВАЛИВАЕТСЯ. Переход ждёт транзакцию «сейв + сундук» напарника (R1-05: `saveHeld`, её `finally`
 * зовёт проверку снова); если срок голоса (`VOTE_TIMEOUT_MS`) выходил раньше её конца (медленная база, «за» у самого срока), шаг комнаты
 * проваливал голос как отказ: позвавшему — «Пати не идёт» и право «Соло», хотя «за» были все, а после транзакции голосования уже не было —
 * пати оставалась в городе, и «Соло» уводило забег от согласившегося напарника.
 */
describe('⭐ R22-05: голос «за» всех, отложенный транзакцией сундука, срок не проваливает', () => {
  const held = (room: RoomIn): Set<string> => (room as unknown as { session: { saveHeld: Set<string> } }).session.saveHeld;
  const checkVote = (room: RoomIn): void => { (room as unknown as { checkVote(): void }).checkVote(); };

  it('B зовёт спуск, A «за», пока его транзакция сундука в полёте; срок вышел — ни провала, ни «Соло»; транзакция кончилась — пати продолжает забег', async () => {
    const rm = manager();
    const { room, key, pidA, wsB } = await party(rm, 'D1HA', 'D1HB');
    const n0 = await callDescend(wsB);
    held(room).add(pidA);   // транзакция сундука A в полёте (`transact`)
    room.castVote(pidA, true);
    expect(room.area, 'все «за», но переход ждёт транзакцию').toBe('town');
    later(VOTE_TIMEOUT_MS + 1_000);
    room.step(false);
    expect(wsB.frames.slice(n0).some((f) => f.t === 'voteEnd' && !f.passed), 'было — voteEnd{passed:false}').toBe(false);
    expect(hints(wsB, n0), 'было — подсказка «Соло» позвавшему').toEqual([]);
    expect(room.soloRight('D1HB', key), 'и право «Соло»').toBe(false);
    expect(room.vote, 'голос ждёт конца транзакции').not.toBeNull();
    held(room).delete(pidA);
    checkVote(room);   // конец транзакции (`transact` → `finally`)
    await until('продолжение забега', () => room.area === 'dungeon');
    expect(runLedgerKey(room.runConfig!), 'тот же забег').toBe(key);
    expect(room.clients.size, 'вдвоём').toBe(2);
  });

  it('контроль: A не голосовал, его сейв удержан — срок проваливает голос, как прежде («Соло» позвавшему)', async () => {
    const rm = manager();
    const { room, key, pidA, wsB } = await party(rm, 'D1HC', 'D1HD');
    const n0 = await callDescend(wsB);
    held(room).add(pidA);
    later(VOTE_TIMEOUT_MS + 1_000);
    room.step(false);
    expect(room.vote).toBeNull();
    expect(wsB.frames.slice(n0).some((f) => f.t === 'voteEnd' && !f.passed)).toBe(true);
    expect(hints(wsB, n0)).toHaveLength(1);
    expect(room.soloRight('D1HD', key)).toBe(true);
    held(room).delete(pidA);
  });
});
/**
 * ⭐ R23-01: ПРАВО «СОЛО» — КАЖДОМУ УЧАСТНИКУ, ЧЬЁ «ЗА» НЕ ПРОШЛО, А НЕ ТОЛЬКО ПОЗВАВШЕМУ. Провал голоса за продолжение забега (срок, «нет» другого)
 * давал право и подсказку одному `v.by`. Третий в городе держателя — гость без своего забега (или альт того же аккаунта) — зовёт спуск снова на
 * каждый конец голосования: спуск продолжает забег комнаты (`parkedHost`), участник B говорит «за», напарник A молчит — и по сроку «Соло» не
 * получал никто (у гостя забега нет), а свой спуск B молча тонул в чужом голосовании (`votePending`); провал паузы не ставит — слот снова у гостя.
 * Скриптованный гость держал B заложником вечно: выходом оставалось «Забросить» (штраф смерти). То же на арене держателя с «в город». Теперь
 * провал даёт право и подсказку каждому подключённому живому участнику, сказавшему «за» (кроме отказавшего самого), — своё «за» он уже сказал.
 */
describe('⭐ R23-01: голос за продолжение не прошёл — «Соло» каждому «за», а не только позвавшему', () => {
  /** Пати A+B в городе держателя (забег припаркован у обоих) и гость G без забега, вошедший по коду. */
  async function withGuest(rm: RMIn, a: string, b: string, g: string): Promise<Awaited<ReturnType<typeof party>> & { wsG: FakeConn; pidG: string }> {
    const p = await party(rm, a, b);
    seed(g);
    const wsG = await join(rm, g, { roomCode: p.room.code });
    expect(wsG.last('joined')?.roomCode, JSON.stringify(wsG.last('error'))).toBe(p.room.code);
    p.room.stop();
    expect(wsG.last('joined')!.save.run, 'у гостя забега нет').toBeUndefined();
    return { ...p, wsG, pidG: wsG.last('joined')!.playerId };
  }

  it('гость G снова и снова зовёт спуск; B «за», A молчит: по сроку — подсказка и право B (было — ни того ни другого); «Соло» — его комната в подземелье', async () => {
    const rm = manager();
    const { room, key, wsA, wsB, pidB, wsG, pidG } = await withGuest(rm, 'R231A', 'R231B', 'R231G');
    const gold = db.chars.get('R231B')!.data.gold;
    const n0 = wsB.frames.length;
    room.movedAt = 0;
    room.descend(pidG);   // спуск гостя продолжает забег комнаты — хозяин спуска её участник
    expect(room.vote?.kind).toBe('descend');
    room.castVote(pidB, true);
    room.descend(pidB);   // свой спуск B: слот — у гостя, «за» B уже учтено
    expect(room.vote?.by, 'слот — у гостя').toBe(pidG);
    later(VOTE_TIMEOUT_MS + 1);
    room.step(false);
    expect(room.vote, 'срок вышел — голос не прошёл').toBeNull();
    expect(hints(wsB, n0), 'было — ни одной подсказки: право давалось только позвавшему (гостю без забега)').toHaveLength(1);
    expect(room.soloRight('R231B', key), 'право «Соло» — у сказавшего «за» участника').toBe(true);
    expect(hints(wsG), 'гостю без забега — нечего').toEqual([]);
    expect(hints(wsA), 'молчавшему — нет').toEqual([]);
    expect(room.soloRight('R231A', key)).toBe(false);
    room.descend(pidG);   // гость снова занял слот — право в силе (его снимает только прошедший голос, подземелье, отпуск забега, возврат)
    expect(room.vote?.by).toBe(pidG);
    expectSoloRoom(rm, await soloOut(rm, wsB, 'R231B'), room, key, 'R231B', gold);
  });

  it('«нет» A на спуск гостя — подсказка и право B, сказавшему «за»; отказавшему и гостю — нет', async () => {
    const rm = manager();
    const { room, key, wsA, pidA, wsB, pidB, wsG, pidG } = await withGuest(rm, 'R232A', 'R232B', 'R232G');
    const n0 = wsB.frames.length;
    room.movedAt = 0;
    room.descend(pidG);
    room.castVote(pidB, true);
    room.castVote(pidA, false);
    expect(room.vote).toBeNull();
    expect(hints(wsB, n0), 'было — ни одной').toHaveLength(1);
    expect(room.soloRight('R232B', key)).toBe(true);
    expect(hints(wsA), 'отказавшему — нет').toEqual([]);
    expect(room.soloRight('R232A', key)).toBe(false);
    expect(hints(wsG)).toEqual([]);
  });

  it('гость отменяет свой же спуск, едва B сказал «за» (и зовёт снова): отмена — его, не B: подсказка и право B', async () => {
    const rm = manager();
    const { room, key, wsB, pidB, pidG } = await withGuest(rm, 'R233A', 'R233B', 'R233G');
    const n0 = wsB.frames.length;
    room.movedAt = 0;
    room.descend(pidG);
    room.castVote(pidB, true);
    room.castVote(pidG, false);   // скрипт гостя: отмена сразу за чужим «за»
    expect(room.vote).toBeNull();
    expect(hints(wsB, n0), 'было — своя отмена позвавшего не давала никому ничего').toHaveLength(1);
    expect(room.soloRight('R233B', key)).toBe(true);
  });

  it('держатель на арене: гость G снова и снова зовёт «в город»; B «за», A молчит — по сроку «Соло» B из арены', async () => {
    const rm = manager();
    const { room, key, wsA, pidA, wsB, pidB, wsG, pidG } = await withGuest(rm, 'R234A', 'R234B', 'R234G');
    const gold = db.chars.get('R234B')!.data.gold;
    room.movedAt = 0;
    room.enterArena(pidB); room.castVote(pidA, true); room.castVote(pidG, true);
    expect(room.area).toBe('arena');
    expect(room.holdsRun(key), 'арена держит забег').toBe(true);
    const n0 = wsB.frames.length;
    later(2_000); room.movedAt = 0;
    room.returnTown(pidG);
    expect(room.vote?.kind).toBe('town');
    room.castVote(pidB, true);
    room.returnTown(pidB);
    expect(room.vote?.by, 'слот — у гостя').toBe(pidG);
    later(VOTE_TIMEOUT_MS + 1);
    room.step(false);
    expect(room.vote).toBeNull();
    expect(hints(wsB, n0), 'было — ни одной').toHaveLength(1);
    expect(hints(wsA)).toEqual([]);
    expect(hints(wsG)).toEqual([]);
    expectSoloRoom(rm, await soloOut(rm, wsB, 'R234B'), room, key, 'R234B', gold);
  });
});

/**
 * ⭐ R23-02: В ПОДЗЕМЕЛЬЕ МОЛЧАЩИЙ НАПАРНИК УЗЕЛ НЕ ДЕРЖИТ. Голос в подземелье был без срока, а проходит он «за» всех подключённых: напарник на
 * связи, но молчит (вкладка в фоне, отошёл, не хочет) — и спуск у выхода, «в город» у портала и завершение финала не проходили никогда. Уйти
 * было некуда: «Продолжить» (и «без пати») возвращало реконнектом в ту же комнату, вход в новую — отказ `run`, выход — «Завершить» со штрафом.
 * Теперь срок `VOTE_TIMEOUT_MS` и у голоса в подземелье: к сроку молчащие голос не держат — он проходит «за» ответивших, а молчащий идёт с пати,
 * как пошла бы копия отключённого (`Room.voteReady`). Две оговорки — те же правила, что у отключённого: молчащий, что бежал бы из боя (в опасности
 * не у выхода — для спуска, не у портала — для ухода; мера `fled`/`fledDescend`), голос держит, пока опасность не пройдёт (молчание — не бегство
 * без штрафа, а подключённого не хоронят); вперёд (спуск, завершение) пати ведут живые (R5-04, R14-02) — одних мёртвых «за» молчание живого не
 * дополняет, «в город» — дополняет. «Нет» того, кто здесь и ответил, — отказ, как было: пати ходит вместе.
 */
describe('⭐ R23-02: в подземелье молчащий напарник узел не держит', () => {
  /** A и B в подземелье забега, монстры узла мертвы (узел пройден). */
  async function dungeon(rm: RMIn, a: string, b: string): Promise<{ room: RoomIn; key: string; wsA: FakeConn; pidA: string; wsB: FakeConn; pidB: string; w: RoomIn['session']['world'] }> {
    seed(a); seed(b);
    const wsA = await join(rm, a);
    const room = roomOf(rm, wsA.last('joined'));
    const pidA = wsA.last('joined')!.playerId;
    const wsB = await join(rm, b, { roomCode: room.code });
    const pidB = wsB.last('joined')!.playerId;
    await until('записи входа легли', () => !rm.inflight.size);
    room.movedAt = 0; room.descend(pidA); room.castVote(pidB, true);
    expect(room.area).toBe('dungeon');
    const w = room.session.world;
    for (const m of w.monsters) m.alive = false;
    expect(w.exits?.length, 'у узла есть выход').toBeGreaterThan(0);
    return { room, key: runLedgerKey(room.runConfig!), wsA, pidA, wsB, pidB, w };
  }
  /** Герой `pid` — без штрафа, забег `key` цел (правда героя — копия комнаты). */
  const intact = (room: RoomIn, pid: string, key: string): void => {
    const s = room.session.world.players[pid]!.save;
    expect(s.gold, `${s.charId}: без штрафа`).toBe(10_000);
    expect(s.run && runLedgerKey(s.run.config), `${s.charId}: забег цел`).toBe(key);
  };

  it('B у выхода зовёт спуск, A на связи молчит вдали: до срока — ждём; по сроку — пати на следующем узле вместе с A, без штрафа', async () => {
    const rm = manager();
    const { room, key, pidA, pidB, w } = await dungeon(rm, 'R235A', 'R235B');
    w.players[pidB]!.pos = { ...w.exits![0]! };
    w.players[pidA]!.pos = { ...w.spawn };
    const node0 = room.runNodeId;
    room.movedAt = 0;
    room.descend(pidB);
    expect(room.vote?.kind).toBe('descend');
    later(VOTE_TIMEOUT_MS - 1_000);
    room.step(false);
    expect(room.vote, 'до срока — голос ждёт A').not.toBeNull();
    expect(room.runNodeId).toBe(node0);
    later(1_001);
    room.step(false);
    expect(room.vote, 'было — открыт и через полчаса').toBeNull();
    expect(room.runNodeId, 'пати на следующем узле').not.toBe(node0);
    expect(room.area).toBe('dungeon');
    expect(runLedgerKey(room.runConfig!), 'тот же забег').toBe(key);
    expect(room.clients.size, 'A пошёл с пати — подключённым').toBe(2);
    expect(room.session.world.players[pidA]?.alive).toBe(true);
    intact(room, pidA, key); intact(room, pidB, key);
  });

  it('B у портала зовёт «в город», A молчит у выхода: по сроку — вся пати в городе (A подключён), забег припаркован у обоих, без штрафа', async () => {
    const rm = manager();
    const { room, key, wsA, pidA, pidB, w } = await dungeon(rm, 'R236A', 'R236B');
    w.players[pidB]!.pos = { ...w.spawn };
    w.players[pidA]!.pos = { ...w.exits![0]! };
    room.movedAt = 0;
    room.returnTown(pidB);
    expect(room.vote?.kind).toBe('town');
    later(VOTE_TIMEOUT_MS + 1);
    room.step(false);
    expect(room.vote).toBeNull();
    expect(room.area, 'было — пати стояла на узле вечно').toBe('town');
    expect(room.clients.size).toBe(2);
    expect(room.holdsRun(key), 'город держит забег').toBe(true);
    expect(wsA.frames.some((f) => f.t === 'died'), 'A не хоронили').toBe(false);
    intact(room, pidA, key); intact(room, pidB, key);   // забег припаркован у обоих
  });

  it('молчащий в опасности вдали от выхода голос держит (молчание — не бегство из боя); опасность прошла — пати уходит при следующей сверке', async () => {
    const rm = manager();
    const { room, pidA, pidB, w } = await dungeon(rm, 'R237A', 'R237B');
    w.players[pidB]!.pos = { ...w.exits![0]! };
    const a = w.players[pidA]!;
    a.pos = { ...w.spawn };
    a.hp = 50;   // урон по времени его добьёт (`burning`): опасность без монстров — детерминированно
    a.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: w.timeMs + 120_000, mag: 1, mag2: 0 };
    const node0 = room.runNodeId;
    room.movedAt = 0;
    room.descend(pidB);
    later(VOTE_TIMEOUT_MS + 1);
    room.step(false);
    expect(room.vote, 'срок вышел, но молчащий в опасности — голос ждёт').not.toBeNull();
    expect(room.runNodeId).toBe(node0);
    later(5_000);
    room.step(false);
    expect(room.vote, 'и дальше ждёт, пока опасность не прошла').not.toBeNull();
    delete a.debuffs.poison;   // исцелился
    later(1_001);
    room.step(false);
    expect(room.vote).toBeNull();
    expect(room.runNodeId, 'опасность прошла — пати ушла').not.toBe(node0);
    expect(room.clients.size).toBe(2);
  });

  it('«нет» того, кто здесь и ответил, — отказ сразу, как было; срок его не отменяет', async () => {
    const rm = manager();
    const { room, pidA, pidB, w } = await dungeon(rm, 'R238A', 'R238B');
    w.players[pidB]!.pos = { ...w.exits![0]! };
    const node0 = room.runNodeId;
    room.movedAt = 0;
    room.descend(pidB);
    room.castVote(pidA, false);
    expect(room.vote).toBeNull();
    later(VOTE_TIMEOUT_MS + 1);
    room.step(false);
    expect(room.runNodeId).toBe(node0);
  });

  it('вперёд ведут живые: мёртвый у выхода зовёт спуск, живой молчит — не проходит и по сроку; «в город» мёртвого — проходит по сроку', async () => {
    const rm = manager();
    const { room, pidA, pidB, w } = await dungeon(rm, 'R239A', 'R239B');
    const b = w.players[pidB]!;
    b.pos = { ...w.exits![0]! };
    w.players[pidA]!.pos = { ...w.spawn };
    b.hp = 1;
    b.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: w.timeMs + 60_000, mag: 9999, mag2: 0 };
    for (let i = 0; i < 4 && b.alive; i++) room.step(false);
    expect(b.alive, 'B погиб').toBe(false);
    const node0 = room.runNodeId;
    room.movedAt = 0;
    room.descend(pidB);
    expect(room.vote?.kind).toBe('descend');
    later(VOTE_TIMEOUT_MS + 1);
    room.step(false);
    expect(room.vote, 'одни мёртвые «за» — молчание живого вперёд не ведёт').not.toBeNull();
    expect(room.runNodeId).toBe(node0);
    room.castVote(pidB, false);   // своя отмена
    room.movedAt = 0;
    room.returnTown(pidB);
    expect(room.vote?.kind).toBe('town');
    later(VOTE_TIMEOUT_MS + 1);
    room.step(false);
    expect(room.area, '«в город» — и мёртвому, молчащий живой идёт с пати').toBe('town');
    expect(room.clients.size).toBe(2);
  });
});
