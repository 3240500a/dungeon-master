import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, itemFromBaseId, type ServerFrame, type SaveState, type RunConfig, type Item } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ R16 (КЛИЕНТ), C-09: СТАТУС ЗАБЕГА ГОВОРИТ, ЧТО СМЕРТЬ В НЁМ ОПЛАЧЕНА. Экран «Продолжить / Забросить» твердил «Забросить — персонаж
 * считается погибшим (штраф золота и части предметов)» и тому, кто в этом забеге уже погиб: штраф взят смертью, «Завершить» второго не берёт
 * (V1 — по грейс-копии и по строке базы, `run.deadAt`), а «Продолжить» вернёт его мёртвым ждать пати (K1). Бесплатный выход выглядел
 * платным. Кадр `runStatus` нёс только «есть ли забег» — теперь и `dead`, по тому же правилу, что сам кадр `abandon`: обещание экрана и
 * исход «Завершить» сверяются здесь попарно (штраф взят ⇔ `dead` не сказан).
 * Менеджеры и комнаты — настоящие (два менеджера — слитая нода и соседняя), база — маленькая честная (версии строк).
 */
const TOK = 'c9'.repeat(32);
const USER = 'user-r16c09';
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number }>(),
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => [],
  mergeRunLedger: async () => { await new Promise((res) => setTimeout(res, 1)); },
  landedVersion: async () => null,
  getSession: async (token: string) => (token === 'c9'.repeat(32) ? 'user-r16c09' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r16c09', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data);   // снимок — в момент вызова, как `snapshotOf`
    await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = snap;
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
  code: string; area: string; movedAt: number; runConfig: RunConfig | null; runNodeId: string | null;
  stop(): void; step(): void; descend(pid: string): void; castVote(pid: string, yes: boolean): void; returnTown(pid: string): void;
  disconnected: Map<string, unknown>;
  session: { world: { monsters: { alive: boolean }[]; spawn: { x: number; y: number }; players: Record<string, Pl>; timeMs: number } };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; charOps: Map<string, unknown>;
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
/** Кадр лобби с нового соединения (экран входа): ответ — `want` или ошибка. */
async function lobby(rm: RMIn, frame: Record<string, unknown>, want: ServerFrame['t']): Promise<FakeConn> {
  const ws = new FakeConn(`203.0.113.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ ...frame, token: TOK });
  await until(`ответ на ${String(frame.t)}`, () => !!ws.last(want) || !!ws.last('error'));
  return ws;
}
const idle = (rm: RMIn, id: string): boolean => !rm.live.has(id) && !rm.inflight.has(id) && !rm.charOps.has(id);
/** Кооп A + B в подземелье комнаты A; монстры «спят» (уход — не бегство из боя), тик — только шагами теста, оба у точки входа. */
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
type Status = Extract<ServerFrame, { t: 'runStatus' }>;
/**
 * Экран входа героя `charId`: статус забега (что обещает экран) → «Завершить» → строка базы. Обещание сверяется с исходом попарно:
 * `dead` — штрафа нет (золото и вещи те же), без `dead` — штраф взят.
 */
async function statusThenAbandon(rm: RMIn, charId: string): Promise<{ status: Status; goldBefore: number; goldAfter: number; itemsBefore: number; itemsAfter: number }> {
  const st = (await lobby(rm, { t: 'runStatus', charId }, 'runStatus')).last('runStatus');
  expect(st, 'статус забега ответил').toBeDefined();
  expect(st!.hasRun, 'забег есть').toBe(true);
  await until('копии легли', () => idle(rm, charId));
  const before = row(charId);
  const ws = await lobby(rm, { t: 'abandon', charId }, 'abandoned');
  expect(ws.last('abandoned'), JSON.stringify(ws.last('error'))).toBeDefined();
  await until('«Завершить» записано', () => idle(rm, charId));
  const after = row(charId);
  expect(after.run, '«Завершить» завершило').toBeUndefined();
  const penalized = after.gold < before.gold || after.inventory.length < before.inventory.length;
  expect(penalized, `экран обещал ${st!.dead ? '«без штрафа»' : '«штраф»'} — «Завершить» ${penalized ? 'взяло' : 'не взяло'} штраф`).toBe(!st!.dead);
  return { status: st!, goldBefore: before.gold, goldAfter: after.gold, itemsBefore: before.inventory.length, itemsAfter: after.inventory.length };
}

describe('⭐ R16 C-09: статус забега — погиб ли герой в нём (штраф взят), и «Завершить» держит это обещание', () => {
  it('⭐ погиб в коопе, закрыл вкладку (грейс): статус — `dead`, «Завершить» — без второго штрафа', async () => {
    const rm = manager();
    seed('C09GA'); seed('C09GB');
    const { room, pidB, wsB } = await coopDungeon(rm, 'C09GA', 'C09GB');
    kill(room, pidB);
    wsB.close();
    await until('B ждёт реконнекта', () => room.disconnected.has('C09GB') && idle(rm, 'C09GB'));
    const r = await statusThenAbandon(rm, 'C09GB');
    expect(r.status.dead, 'было: поля нет — экран пугал штрафом').toBe(true);
    expect(r.goldAfter).toBe(r.goldBefore);
  });

  it('жив, спокойно закрыл вкладку в подземелье (грейс): статус без `dead`, «Завершить» — штраф', async () => {
    const rm = manager();
    seed('C09LA'); seed('C09LB');
    const { room, wsB } = await coopDungeon(rm, 'C09LA', 'C09LB');
    wsB.close();
    await until('B ждёт реконнекта', () => room.disconnected.has('C09LB') && idle(rm, 'C09LB'));
    const r = await statusThenAbandon(rm, 'C09LB');
    expect(r.status.dead).toBe(false);
    expect(r.goldAfter).toBeLessThan(r.goldBefore);
  });

  it('⭐ погиб, процесс слит (строка — «мёртв, оплачено», `run.deadAt`): статус на соседней ноде — `dead`, «Завершить» — без штрафа', async () => {
    const rm1 = manager();
    seed('C09DA'); seed('C09DB');
    const { room, pidB } = await coopDungeon(rm1, 'C09DA', 'C09DB');
    kill(room, pidB);
    await rm1.flushAll(3_000);
    expect(row('C09DB').run?.deadAt, 'в строке — «мёртв, оплачено»').toBe(room.runNodeId);
    const rm2 = manager();   // соседняя нода: грейса нет, правда — строка базы
    const r = await statusThenAbandon(rm2, 'C09DB');
    expect(r.status.dead, 'было: поля нет — экран пугал штрафом').toBe(true);
  });

  it('погиб, закрыл вкладку, а пати ушла в город (смена этажа оживляет ждущих): статус уже без `dead`, «Завершить» — штраф', async () => {
    const rm = manager();
    seed('C09TA'); seed('C09TB');
    const { room, pidA, pidB, wsB } = await coopDungeon(rm, 'C09TA', 'C09TB');
    kill(room, pidB);
    wsB.close();
    await until('B ждёт реконнекта', () => room.disconnected.has('C09TB') && idle(rm, 'C09TB'));
    room.movedAt = 0; room.returnTown(pidA);
    expect(room.area).toBe('town');
    await until('копия ждущего записана', () => !rm.inflight.size && row('C09TB').run?.deadAt === undefined);
    const r = await statusThenAbandon(rm, 'C09TB');
    expect(r.status.dead, 'смерть «отжита» пати — обещать «без штрафа» нельзя').toBe(false);
  });
});
