import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, gainXp, xpForLevel, type ServerFrame, type SaveState, type RunPlan, type RunNode } from '@dm/shared';
import { limits } from './rateLimit.js';

// Тесты файла ждут менеджер оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый такой оборот — шаг системного
// таймера (~15,6 мс). Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот потолок не прячет.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Раунд 9 (сервер), граница менеджера комнат: взятое на узлах забега принадлежит забегу — старая копия «якоря» не собирает
 * пройденные без него узлы свежими (R9-01); уровень героя вход не опускает — медленнее кривая опыта не платит очки уровней
 * второй раз (R9-05); бакеты частоты, чей ключ — соединение, закрытие соединения снимает (R9-11). База — маленькая честная
 * (версии сейва, свод записей забегов — объединением, как `run_ledger`), у каждого героя свой аккаунт и токен (`tok`).
 */
type Rec = { id: string; el: number; chests: number[]; killed: number[]; levers: number[] };
const db = vi.hoisted(() => ({
  chars: new Map<string, { userId: string; data: unknown; version: number }>(),
  /** Токен → аккаунт. Нет в карте — сессии нет. */
  sessions: new Map<string, string>(),
  /** Свод записей забегов: ключ забега → узел → запись (как `run_ledger`: списки объединением, мощь — первой записи). */
  ledger: new Map<string, Map<string, Rec>>(),
}));
vi.mock('../db/db.js', () => ({
  getSession: async (token: string) => db.sessions.get(token) ?? null,
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: r.userId, data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data);
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = snap;
    return r.version;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async (key: string) => [...(db.ledger.get(key)?.values() ?? [])].map((r) => structuredClone(r)),
  mergeRunLedger: async (key: string, recs: Rec[]) => {
    let run = db.ledger.get(key);
    if (!run) db.ledger.set(key, (run = new Map()));
    const u = (a: number[], b: number[]): number[] => [...new Set([...a, ...b])].sort((x, y) => x - y);
    for (const r of recs) {
      const cur = run.get(r.id);
      run.set(r.id, cur ? { ...cur, chests: u(cur.chests, r.chests), killed: u(cur.killed, r.killed), levers: u(cur.levers, r.levers) } : structuredClone(r));
    }
  },
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

let RM: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
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
}
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

type RoomIn = { stop(): void; session: { world: { players: Record<string, { save: SaveState }> } } };
let rm: InstanceType<typeof RM>;
const rooms = (): RoomIn[] => [...(rm as unknown as { rooms: Map<string, RoomIn> }).rooms.values()];

let seq = 0;
function seedChar(prefix: string, patch?: (s: SaveState) => void): { charId: string; userId: string; token: string } {
  const charId = `${prefix}-${++seq}`;
  const uid = `user-${charId}`;
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, prefix.slice(0, 12), charId) as SaveState;
  patch?.(save);
  db.chars.set(charId, { userId: uid, data: save, version: 1 });
  db.sessions.set(tok(uid), uid);
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(uid);
  return { charId, userId: uid, token: tok(uid) };
}
let ipSeq = 0;
/** Соединение со своего адреса: лимиты адреса у каждого теста свои. */
function conn(): FakeConn { const ws = new FakeConn(`198.51.100.${++ipSeq}`); rm.handleConnection(ws); return ws; }
async function joined(h: { charId: string; token: string }, extra: Record<string, unknown> = { fresh: true }): Promise<FakeConn> {
  const ws = conn();
  ws.push({ t: 'join', token: h.token, charId: h.charId, ...extra });
  await settle();
  expect(ws.last('joined'), `${h.charId} вошёл: ${JSON.stringify(ws.last('error'))}`).toBeDefined();
  return ws;
}
/** Сейв героя в живой комнате (авторитетный объект — его и меняет сессия). */
function liveSave(charId: string): SaveState {
  for (const r of rooms()) for (const p of Object.values(r.session.world.players)) if (p.save.charId === charId) return p.save;
  throw new Error(`${charId} не в комнате`);
}

beforeAll(async () => {
  ({ RoomManager: RM } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
  vi.useFakeTimers({ toFake: ['setInterval'] });   // без фоновой дописи копий по таймеру (R3-19)
  try { rm = new RM(cfg); } finally { vi.useRealTimers(); }
});
beforeEach(() => { /* лимиты адреса — свои у каждого соединения (`conn`) */ });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { for (const r of rooms()) r.stop(); });

describe('⭐ R9-05: медленнее кривая опыта — вход уровень не опускает, и очки уровней не платятся второй раз', () => {
  const pts = (s: SaveState): number[] => [s.unspentAttributePoints, s.unspentSkillPoints, s.unspentMasteryPoints];

  it('герой 50-го уровня, кривая ×1.1: вход — 50-й; добрал опыт до нового 50-го — очков столько же; 51-й — ровно за один уровень', async () => {
    const b0 = structuredClone(cfg.get('balance'));
    const per = [b0.attributePointsPerLevel, b0.skillPointsPerLevel, b0.masteryPointsPerLevel];
    let paid: number[] = [];
    const h = seedChar('r905', (s) => {
      gainXp(s, b0, xpForLevel(50, b0.xpTable));
      paid = pts(s);
    });
    expect(paid, 'очки за 49 уровней').toEqual(per.map((p) => p * 49));
    try {
      const slow = structuredClone(b0);
      slow.xpTable = b0.xpTable.map((x) => Math.round(x * 1.1));
      cfg.reload({ balance: slow });
      const ws = await joined(h);
      expect(ws.last('joined')!.save.level, 'вход уровень не опускает').toBe(50);
      const save = liveSave(h.charId);
      gainXp(save, cfg.get('balance'), xpForLevel(50, slow.xpTable) - save.xp);
      expect(save.level).toBe(50);
      expect(pts(save), 'уровни 49→50 уже оплачены — второй раз не платятся').toEqual(paid);
      gainXp(save, cfg.get('balance'), xpForLevel(51, slow.xpTable) - save.xp);
      expect(save.level).toBe(51);
      expect(pts(save), '51-й — ровно за один уровень').toEqual(paid.map((p, i) => p + per[i]!));
    } finally {
      cfg.reload({ balance: b0 });
    }
  });

  it('потолок уровня срезан и возвращён: герой 90-го входит 90-м, а после возврата потолка очки за 81–90 не платятся снова', async () => {
    const b0 = structuredClone(cfg.get('balance'));
    const cap = b0.xpTable.length - 1;
    let paid: number[] = [];
    const h = seedChar('r905cap', (s) => { gainXp(s, b0, xpForLevel(cap, b0.xpTable)); paid = pts(s); });
    try {
      const cut = structuredClone(b0);
      cut.xpTable = b0.xpTable.slice(0, cap - 9);
      cfg.reload({ balance: cut });
      const ws = await joined(h);
      expect(ws.last('joined')!.save.level).toBe(cap);
      cfg.reload({ balance: b0 });
      const save = liveSave(h.charId);
      gainXp(save, cfg.get('balance'), 1);
      expect(save.level).toBe(cap);
      expect(pts(save)).toEqual(paid);
    } finally {
      cfg.reload({ balance: b0 });
    }
  });
});

describe('⭐ R9-11: бакеты частоты с ключом соединения живут не дольше соединения', () => {
  /** Ключи бакета, начинающиеся с `prefix` (внутренность лимитера — это тест). */
  const keysOf = (l: unknown, prefix: string): string[] =>
    [...(l as { buckets: Map<string, unknown> }).buckets.keys()].filter((k) => k.startsWith(prefix));

  it('1000 анонимных «открыл — кадр лобби и ввода — закрыл»: бакеты кадров, ввода и лобби возвращаются к исходному размеру', async () => {
    const before = { frames: limits.wsFrames.size, input: limits.wsInput.size, lobby: limits.lobbyConn.size };
    for (let i = 0; i < 1000; i++) {
      const ws = new FakeConn('203.0.113.77');
      rm.handleConnection(ws);
      ws.push({ t: 'runStatus', token: 'a'.repeat(64), charId: 'c-0' });
      ws.push('{"t":"input","input":{"move":{"x":0,"y":0},"facing":0,"attack":false,"cast":null,"interact":false}}');
      ws.close();
    }
    await settle(20);
    expect(limits.wsFrames.size, 'потолок кадров').toBe(before.frames);
    expect(limits.wsInput.size, 'потолок ввода').toBe(before.input);
    expect(limits.lobbyConn.size, 'потолок кадров лобби').toBe(before.lobby);
  });

  it('промах кода комнаты вошедшим: бакет соединения (`conn:`) снимается с закрытием, бакет аккаунта — живёт', async () => {
    const h = seedChar('r911');
    const before = keysOf(limits.roomCodeMiss, 'conn:').length;
    const ws = conn();
    ws.push({ t: 'join', token: h.token, charId: h.charId, roomCode: 'Z9Z9Z9' });
    await settle();
    expect(ws.last('error')?.code).toBe('no-room');
    expect(keysOf(limits.roomCodeMiss, 'conn:').length, 'промах записан на соединение').toBe(before + 1);
    ws.close();
    await settle();
    expect(keysOf(limits.roomCodeMiss, 'conn:').length).toBe(before);
    expect(keysOf(limits.roomCodeMiss, `user:${h.userId}`).length, 'аккаунт помнит промах').toBe(1);
  });

  it('контроль: живое соединение свой бакет держит — выход кадром `leave` его не снимает, закрытие — снимает', async () => {
    const h = seedChar('r911live');
    const ws = await joined(h);
    const key = (rm as unknown as { connKeys: WeakMap<GameConn, string> }).connKeys.get(ws)!;
    for (let i = 0; i < 50; i++) ws.push({ t: 'ping', id: i });
    ws.push({ t: 'leave' });
    await settle();
    expect(keysOf(limits.wsFrames, key), 'соединение открыто — бакет на месте (потолок кадров выходом из комнаты не обнулить)').toContain(key);
    ws.close();
    await settle();
    expect(keysOf(limits.wsFrames, key)).not.toContain(key);
  });
});

/**
 * ⭐ R9-01: ВЗЯТОЕ НА УЗЛАХ ЗАБЕГА — ЗАБЕГУ, А НЕ ТОМУ, У КОГО ЖИВА КОПИЯ. Записи узлов жили только в сейвах участников: «якорь» A
 * выходит из города на глубине d, напарник B один проходит узлы глубже и бросает свою копию («Завершить», финал, вайп), — а
 * «Продолжить» A и вход B по коду давали эти узлы свежими: сундуки, боссы, опыт — по кругу, пока жива старая копия A.
 */
describe('⭐ R9-01: старая копия «якоря» не собирает узлы, пройденные без него, свежими', () => {
  type Pt = { x: number; y: number };
  type RoomX = {
    code: string; area: string; movedAt: number; runPlan: RunPlan | null; runNodeId: string | null;
    nodeState: { id: string; killed: number[]; chests: number[] } | null;
    descend(pid: string, diff?: string, to?: string): void; castVote(pid: string, yes: boolean): void; returnTown(pid: string): void;
    openChest(pid: string, id: number): void;
    noteNode(e: unknown): boolean; syncNodeState(): void;
    session: { world: { spawn: Pt; exits?: Pt[]; chests: { id: number; pos: Pt; opened: boolean }[]; monsters: { id: number; alive: boolean; def: unknown }[]; players: Record<string, { pos: Pt; save: SaveState }> } };
  };
  const at = (ws: FakeConn): { pid: string; room: RoomX } => {
    const c = (rm as unknown as { conns: Map<GameConn, { pid: string; room: RoomX }> }).conns.get(ws);
    if (!c) throw new Error('соединение не в комнате');
    return c;
  };
  const nodeNow = (r: RoomX): RunNode => r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
  const calm = (r: RoomX): void => { for (const m of r.session.world.monsters) m.alive = false; };
  function descendNext(r: RoomX, pids: string[]): string {
    const to = nodeNow(r).edges[0]!.to;
    for (const pid of pids) r.session.world.players[pid]!.pos = { ...r.session.world.exits![0]! };
    r.movedAt = 0;
    r.descend(pids[0]!, undefined, to);
    for (const pid of pids.slice(1)) r.castVote(pid, true);
    expect(r.runNodeId).toBe(to);
    return to;
  }
  function toTown(r: RoomX, pids: string[]): void {
    for (const pid of pids) r.session.world.players[pid]!.pos = { ...r.session.world.spawn };
    r.movedAt = 0;
    r.returnTown(pids[0]!);
    for (const pid of pids.slice(1)) r.castVote(pid, true);
    expect(r.area).toBe('town');
  }
  /** Спуск из города: новый забег сразу, продолжение припаркованного — после чтения свода из базы (R9-01). */
  async function fromTown(r: RoomX, pids: string[]): Promise<void> {
    r.movedAt = 0;
    r.descend(pids[0]!);
    for (const pid of pids.slice(1)) r.castVote(pid, true);
    for (let i = 0; i < 500 && r.area !== 'dungeon'; i++) await Promise.resolve();
    expect(r.area).toBe('dungeon');
  }

  it('A выходит из города на глубине d; B один берёт сундук и босса глубже и бросает забег; «Продолжить» A + вход B — узел взят', async () => {
    const A = seedChar('r901a', (s) => { s.level = 30; });
    const B = seedChar('r901b', (s) => { s.level = 30; });
    const wa = await joined(A);
    const code1 = at(wa).room.code;
    const wb = await joined(B, { roomCode: code1 });
    const r1 = at(wa).room;
    const a1 = at(wa).pid, b1 = at(wb).pid;
    await fromTown(r1, [a1, b1]);
    calm(r1);
    while (nodeNow(r1).depth < 2) { descendNext(r1, [a1, b1]); calm(r1); }
    const d = r1.runNodeId!;
    toTown(r1, [a1, b1]);
    wa.close();                                                   // «якорь» выходит из города: его копия припаркована на d
    await settle();
    expect((db.chars.get(A.charId)!.data as SaveState).run?.currentNodeId).toBe(d);

    // B один: продолжает с d, спускается глубже, берёт сундук и убивает монстра из заселения.
    await fromTown(r1, [b1]);
    expect(r1.runNodeId).toBe(d);
    const deep = descendNext(r1, [b1]);
    const w = r1.session.world;
    const chest = w.chests[0]!;
    w.players[b1]!.pos = { ...chest.pos };
    r1.openChest(b1, chest.id);
    expect(chest.opened, 'сундук открыт').toBe(true);
    const mon = w.monsters.find((m) => m.alive)!;
    mon.alive = false;
    expect(r1.noteNode({ type: 'monster-died', id: mon.id, def: mon.def, x: 0, y: 0 }), 'убит монстр заселения').toBe(true);
    r1.syncNodeState();
    const killed = [...r1.nodeState!.killed];
    calm(r1);
    toTown(r1, [b1]);
    wb.close();
    await settle();
    const wz = conn();                                            // «Завершить»: копия B выброшена
    wz.push({ t: 'abandon', token: B.token, charId: B.charId });
    await settle();
    expect(wz.last('abandoned'), JSON.stringify(wz.last('error'))).toBeDefined();
    expect((db.chars.get(B.charId)!.data as SaveState).run, 'у B забега больше нет').toBeUndefined();

    // A «Продолжить» — новая комната на d; B входит по коду; оба в город, A уходит, B спускается снова.
    const wa2 = await joined(A, { resume: true });
    const r2 = at(wa2).room;
    expect(r2.runNodeId).toBe(d);
    const wb2 = await joined(B, { roomCode: r2.code });
    const a2 = at(wa2).pid, b2 = at(wb2).pid;
    calm(r2);
    toTown(r2, [a2, b2]);
    wa2.close();
    await settle();
    await fromTown(r2, [b2]);
    calm(r2);
    expect(descendNext(r2, [b2])).toBe(deep);
    const again = r2.session.world.chests.find((c) => c.id === chest.id)!;
    expect(again.opened, 'сундук, открытый без «якоря», открыт и для его копии').toBe(true);
    expect(r2.nodeState!.killed, 'убитый не встал').toEqual(expect.arrayContaining(killed));
  });

  it('контроль: честное «Продолжить» своего забега без чужих записей — узлы как оставил, лишнего не взято', async () => {
    const C = seedChar('r901c', (s) => { s.level = 30; });
    const wc = await joined(C);
    const r = at(wc).room;
    const c = at(wc).pid;
    await fromTown(r, [c]);
    calm(r);
    const d = descendNext(r, [c]);
    toTown(r, [c]);
    wc.close();
    await settle();
    const wc2 = await joined(C, { resume: true });
    const r2 = at(wc2).room;
    expect(r2.runNodeId).toBe(d);
    expect(r2.session.world.chests.filter((x) => x.opened).map((x) => x.id), 'сундуки, которых не открывал, закрыты').toEqual([]);
  });
});
