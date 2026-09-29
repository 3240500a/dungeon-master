import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type RunConfig } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 17 (сервер), менеджер комнат. Менеджер и комнаты — настоящие; база — маленькая честная (версии строк).
 *  • R17-02: ЗАЛОЖНИК ЗАБЕГА (V2). A и B прошли узел вместе и вернулись в город — забег K припаркован у обоих. A вышел; B остался в городской
 *    комнате R (отошёл от компьютера, забыл вкладку или не хочет в забег). Комната R держала K (`holdsRun`: город, участник на месте), и
 *    «Продолжить» A садило его в город R: спуск ждал голоса B (голосование без срока), «Соло» и спуск — отказ «забег идёт в комнате R», и
 *    выходом оставалось «Забросить» — штраф смерти. Теперь один забег — одна комната только в ПОДЗЕМЕЛЬЕ: «Продолжить» живого участника
 *    забирает забег у комнаты, что держит его в городе или на арене (`Room.yieldRun`), — в новую комнату, прямо на его узел; спуск R потом —
 *    отказ `run` с кодом комнаты A (к пати — по коду). Погибший в забеге (K1: «мёртв, оплачено») по-прежнему входит к пати в город.
 *    ⭐ R18-04: только если B ОТОШЁЛ (не действовал `RUN_IDLE_MS`): действующий напарник забег не отдаёт — иначе перезагрузка в городе увозила
 *    вернувшегося одного на узел (`roomManager.r18server.test.ts`).
 */
const TOK = 'e7'.repeat(32);
const USER = 'user-r17rm';
const db = vi.hoisted(() => ({ chars: new Map<string, { data: SaveState; version: number }>() }));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => [],
  mergeRunLedger: async () => undefined,
  landedVersion: async () => null,
  getSession: async (token: string) => (token === 'e7'.repeat(32) ? 'user-r17rm' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r17rm', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: SaveState, v: number) => {
    const json = JSON.stringify(data);   // снимок — в момент вызова, как `snapshotOf`
    await new Promise((res) => setTimeout(res, 1));
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
  code: string; area: string; movedAt: number; vote: unknown; runConfig: RunConfig | null;
  clients: Map<string, { activeAt: number }>;
  stop(): void; descend(pid: string): void; returnTown(pid: string): void; castVote(pid: string, yes: boolean): void;
  holdsRun(key: string): boolean;
  session: { world: { players: Record<string, Pl>; spawn: { x: number; y: number }; monsters: { alive: boolean }[] } };
};
type RMIn = { rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; charOps: Map<string, unknown>; handleConnection(ws: GameConn): void };
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let runLedgerKey: (cfg: RunConfig) => string;
let RUN_IDLE_MS: number;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  ({ runLedgerKey, RUN_IDLE_MS } = await import('./room.js'));
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
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
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

/** A и B прошли узел вместе и вернулись в город (K припаркован у обоих); A вышел из города, B остался в комнате R и ничего не делает. */
async function hostage(rm: RMIn, a: string, b: string): Promise<{ room: RoomIn; key: string; wsB: FakeConn; pidB: string }> {
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
  w.players[pidA]!.pos = { ...w.spawn }; w.players[pidB]!.pos = { ...w.spawn };
  room.movedAt = 0; room.returnTown(pidA); room.castVote(pidB, true);
  expect(room.area, 'пати в городе').toBe('town');
  wsA.push({ t: 'leave' });
  await until('A вышел из города', () => !rm.live.has(a) && !rm.inflight.has(a) && !rm.charOps.has(a));
  expect(db.chars.get(a)!.data.run, 'у A забег припаркован в строке').toBeTruthy();
  expect(room.holdsRun(key), 'городская комната R держит забег (участник B на месте)').toBe(true);
  // ⭐ R18-04: заложник — ОТОШЕДШИЙ: B не действовал дольше `RUN_IDLE_MS`. Действующий напарник забег не отдаёт — вернувшийся садится к нему
  // (перезагрузка в городе, `roomManager.r18server.test.ts`).
  for (const c of room.clients.values()) c.activeAt -= RUN_IDLE_MS + 1_000;
  return { room, key, wsB, pidB };
}

describe('⭐ R17-02: партнёр, стоящий в городе, не держит припаркованный забег заложником', () => {
  it('«Продолжить» A — в НОВУЮ комнату, прямо на узел его забега (голоса B не нужно); спуск B из города — отказ `run` с кодом комнаты A', async () => {
    const rm = manager();
    const { room, key, wsB, pidB } = await hostage(rm, 'R17A', 'R17B');
    const wsA = await join(rm, 'R17A', { resume: true });
    const j = wsA.last('joined');
    expect(j, JSON.stringify(wsA.last('error'))).toBeDefined();
    expect(j!.roomCode, 'не в городскую комнату B').not.toBe(room.code);
    const mine = rm.rooms.get(j!.roomCode)!;
    mine.stop();
    expect(mine.area, 'сразу в подземелье').toBe('dungeon');
    expect(runLedgerKey(mine.runConfig!), 'своего забега').toBe(key);
    expect(mine.holdsRun(key), 'забег держит комната A').toBe(true);
    expect(room.holdsRun(key), 'городская комната B его отпустила').toBe(false);
    expect(room.session.world.players[pidB]!.save.run, 'у B забег остался припаркованным').toBeTruthy();
    // B позже зовёт спуск — забег идёт в подземелье комнаты A: отказ с её кодом (к пати — по коду, C-05), в городе B ничего не начинается.
    room.movedAt = 0;
    room.descend(pidB);
    expect(wsB.last('error'), 'спуск B').toMatchObject({ code: 'run' });
    expect(wsB.last('error')!.msg).toContain(mine.code);
    expect(room.area).toBe('town');
    // И к пати по коду — входит (участник того же забега).
    const wsB2 = await join(rm, 'R17B', { roomCode: mine.code });
    expect(wsB2.last('joined')?.roomCode, JSON.stringify(wsB2.last('error'))).toBe(mine.code);
  });

  it('контроль (K1): погибший в забеге («мёртв, оплачено») по-прежнему входит к пати в город — без забега, её спуск оживит его', async () => {
    const rm = manager();
    const { room, key } = await hostage(rm, 'R17C', 'R17D');
    const r = db.chars.get('R17C')!;
    r.data.run!.deadAt = r.data.run!.currentNodeId;   // погиб в этом забеге на его узле, штраф взят (как `Room.markDead`)
    const wsC = await join(rm, 'R17C', { resume: true });
    expect(wsC.last('joined')?.roomCode, JSON.stringify(wsC.last('error'))).toBe(room.code);
    expect(room.area).toBe('town');
    expect(room.holdsRun(key), 'город пати забег держит').toBe(true);
  });
});
