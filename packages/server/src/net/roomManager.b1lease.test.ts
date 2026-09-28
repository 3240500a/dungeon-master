import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type RunConfig } from '@dm/shared';
import { limits } from './rateLimit.js';
import { leaseBeat, leaseLost, LEASE_MS } from '../cluster/lease.js';

vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ ФАЗЗЕР КЛАСТЕРА B1, ПРОХОД ПРАВОК 1 (сервер), ENV1 — менеджер и комната под арендой ноды (`cluster/lease.ts`). Аренда кончилась (удар
 * сердца не доходил до реестра почти `NODE_DEAD_SEC`, процесс проснулся после заморозки) — героев и забеги ноды реестр вправе отдать другой:
 * ни входа, ни тика, ни записи строки. И забег, который реестр числит за другой нодой, комната отпускает — её героев снимают без записи.
 * Менеджер и комнаты — настоящие, база — маленькая честная (версии сейва).
 */
const TOK = 'b2'.repeat(32);
const USER = 'user-b1ls';
const db = vi.hoisted(() => ({ chars: new Map<string, { data: unknown; version: number }>(), pending: 0 }));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => [],
  mergeRunLedger: async () => undefined,
  landedVersion: async () => null,
  getSession: async (token: string) => (token === 'b2'.repeat(32) ? 'user-b1ls' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-b1ls', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data);
    db.pending++;
    try {
      await new Promise((res) => setTimeout(res, 1));
      const r = db.chars.get(charId);
      if (!r || v !== r.version) return null;
      r.version = v + 1; r.data = snap;
      return r.version;
    } finally { db.pending--; }
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
/** Записи сейвов в пути легли (живые записи менеджер не отслеживает; очередь записей героя ставит следующую сразу за легшей). */
async function settle(): Promise<void> {
  for (let quiet = 0; quiet < 5; quiet = db.pending ? 0 : quiet + 1) await tick();
}
async function until(what: string, ok: () => boolean, turns = 5_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}

type RoomIn = {
  code: string; area: string; movedAt: number; stop(): void; step(): void; runConfig: RunConfig | null;
  descend(pid: string): void; castVote(pid: string, yes: boolean): void;
  persist(pid: string): Promise<string>;
  session: { world: { timeMs: number; players: Record<string, { save: SaveState }> } };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>;
  handleConnection(ws: GameConn): void;
  fenceRuns(runs: readonly { key: string; room: string }[]): void;
};
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let runLedgerKey: typeof import('./room.js').runLedgerKey;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
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
beforeEach(() => {
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync, limits.stashRead]) l.reset(USER);
  for (let i = 1; i <= 400; i++) { limits.wsFrames.reset(`c${i}`); limits.lobbyConn.reset(`c${i}`); }
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  leaseBeat(Date.now());   // аренда жива (удар только что дошёл)
});
afterEach(() => {
  leaseBeat(Date.now());
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.restoreAllMocks();
});

function seed(id: string): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.gold = 5000;
  db.chars.set(id, { data: s, version: 1 });
}
let ipSeq = 0;
async function join(rm: RMIn, charId: string, roomCode?: string): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(roomCode ? { roomCode } : { fresh: true }) });
  await until(`${charId} вошёл`, () => !!ws.last('joined') || !!ws.last('error'));
  return ws;
}
/** Аренда ноды кончилась: часы процесса ушли дальше её конца, как у процесса, проснувшегося после заморозки (последний удар — в прошлом). */
function loseLease(): void {
  const now = Date.now() + LEASE_MS + 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  expect(leaseLost()).toBe(true);
}

describe('⭐ ENV1: аренда ноды кончилась — ни входа, ни тика, ни записи', () => {
  it('вход — «перезапускаемся», комната не тикает, запись строки не уходит', async () => {
    const rm = manager();
    seed('B1L1A'); seed('B1L1B');
    const wsA = await join(rm, 'B1L1A');
    const room = rm.rooms.get(wsA.last('joined')!.roomCode)!;
    room.stop();
    await until('вход записан', () => !rm.inflight.size && db.chars.get('B1L1A')!.version > 1);
    await settle();
    const pid = wsA.last('joined')!.playerId;
    const v0 = db.chars.get('B1L1A')!.version;
    const t0 = room.session.world.timeMs;
    loseLease();
    const wsB = await join(rm, 'B1L1B');
    expect(wsB.last('joined'), 'вход не прошёл').toBeUndefined();
    expect(wsB.last('error')?.code).toBe('busy');
    room.step();
    expect(room.session.world.timeMs, 'мир стоит').toBe(t0);
    expect(await room.persist(pid), 'запись не уходит').toBe('failed');
    expect(db.chars.get('B1L1A')!.version, 'строка не тронута').toBe(v0);
  });
});

describe('⭐ ENV1: забег комнаты числится за другой нодой — комната его отпускает', () => {
  it('герои комнаты сняты без записи (4009), комната ушла', async () => {
    const rm = manager();
    seed('B1L2A'); seed('B1L2B');
    const wsA = await join(rm, 'B1L2A');
    const code = wsA.last('joined')!.roomCode;
    const wsB = await join(rm, 'B1L2B', code);
    const room = rm.rooms.get(code)!;
    await until('записи входа легли', () => !rm.inflight.size);
    room.movedAt = 0; room.descend(wsA.last('joined')!.playerId); room.castVote(wsB.last('joined')!.playerId, true);
    expect(room.area).toBe('dungeon');
    room.stop();
    await until('записи спуска легли', () => !rm.inflight.size && !!(db.chars.get('B1L2B')!.data as SaveState).run);
    await settle();
    const va = db.chars.get('B1L2A')!.version, vb = db.chars.get('B1L2B')!.version;
    rm.fenceRuns([{ key: runLedgerKey(room.runConfig!), room: code }]);
    await until('сняты', () => !wsA.open && !wsB.open);
    expect([wsA.closedWith, wsB.closedWith]).toEqual([4009, 4009]);
    expect(rm.live.has('B1L2A') || rm.live.has('B1L2B'), 'живых сессий нет').toBe(false);
    expect(rm.rooms.has(code), 'комната ушла').toBe(false);
    expect([db.chars.get('B1L2A')!.version, db.chars.get('B1L2B')!.version], 'без записи: правда забега — у ноды, что его держит').toEqual([va, vb]);
  });
});
