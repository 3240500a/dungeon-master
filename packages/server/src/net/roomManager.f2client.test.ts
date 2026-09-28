import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ ФАЗЗЕРЫ, ПРОХОД ПРАВОК 2 (клиент), граница менеджера комнат. C-05, C-08: «ПРОДОЛЖИТЬ» ЗАБЕГА, КОТОРЫЙ ДЕРЖИТ ДРУГАЯ КОМНАТА, — ОТКАЗ С ЕЁ КОДОМ.
 * С V2 один забег ведёт одна комната, и «Продолжить» идёт только к ней. Отказ — «нет мест» (пати полна: вышел из города, его место занял
 * друг) и `run` (её держит другая нода кластера) — был строкой: код комнаты жил только в тексте, экран «Незавершённое прохождение» поля кода
 * не имеет, и у героя оставались «Забросить» (штраф смерти) или ждать. Теперь код держателя — полем кадра (`roomCode`): клиент ведёт по нему к
 * ноде держателя (`join { resume }` там) или показывает лобби с этим кодом, а «Соло» из лобби — город без штрафа, забег цел. Отказ `run` уходит
 * ПОСЛЕ снятия закрепления героя: клиент идёт по нему сразу, и гейтвей не должен вернуть его сюда по живому закреплению (R6-08).
 */
const TOK = 'c8'.repeat(32);
const USER = 'user-f2cl';
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number }>(),
  /** Порядок событий границы: снятие закрепления героя и кадры отказа. */
  order: [] as string[],
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => [],
  mergeRunLedger: async () => undefined,
  getSession: async () => 'user-f2cl',
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-f2cl', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data);
    await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = snap;
    return r.version;
  },
  landedVersion: async () => null,
  putCharacterWithStash: async (charId: string, _u: string, data: unknown, v: number, _st: unknown, sv: number) => {
    const snap = structuredClone(data);
    await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return { ok: false, conflict: 'save' };
    r.version = v + 1; r.data = snap;
    return { ok: true, version: r.version, stashVersion: sv + 1 };
  },
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: (charId: string) => { db.order.push(`release ${charId}`); return Promise.resolve(); },
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

class FakeConn implements GameConn {
  open = true;
  frames: ServerFrame[] = [];
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  constructor(readonly ip = '127.0.0.1', readonly tag = '') {}
  send(raw: string | Uint8Array): void {
    if (typeof raw !== 'string') return;
    const f = JSON.parse(raw) as ServerFrame;
    this.frames.push(f);
    if (f.t === 'error') db.order.push(`${this.tag} ← error ${f.code}`);
  }
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
const turns = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

type Pl = { pos: { x: number; y: number }; save: SaveState };
type RoomIn = {
  code: string; area: string; movedAt: number; stop(): void;
  descend(pid: string): void; castVote(pid: string, yes: boolean): void; returnTown(pid: string): void;
  seatsTaken(charId: string): number;
  runConfig: { id: string } | null;
  session: { world: { monsters: { alive: boolean }[]; spawn: { x: number; y: number }; players: Record<string, Pl> } };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; charOps: Map<string, unknown>;
  handleConnection(ws: GameConn): void;
};
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let setRunLockStore: typeof import('./roomManager.js').setRunLockStore;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor, setRunLockStore } = await import('./roomManager.js'));
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
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd]) l.reset(USER);
  db.order.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  setRunLockStore(null);
  vi.restoreAllMocks();
});

function seed(id: string): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.gold = 5000; s.attributes.vitality = 60;
  db.chars.set(id, { data: s, version: 1 });
}
const row = (id: string): SaveState => db.chars.get(id)!.data as SaveState;
let ipSeq = 0;
/** Кадр лобби с нового соединения; ждём ответа (вход или отказ). */
async function lobby(rm: RMIn, charId: string, how: { roomCode?: string; resume?: boolean; fresh?: boolean }): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`, charId);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...how });
  await until(`${charId}: ответ на вход`, () => !!ws.last('joined') || !!ws.last('error'));
  return ws;
}
/** A и B прошли узел вместе и вернулись в город комнаты A; B вышел из города — его забег припаркован (грейса нет). */
async function partyBackInTown(rm: RMIn, a: string, b: string): Promise<{ room: RoomIn; pidA: string }> {
  const wsA = await lobby(rm, a, { fresh: true });
  const room = rm.rooms.get(wsA.last('joined')!.roomCode)!;
  const pidA = wsA.last('joined')!.playerId;
  const wsB = await lobby(rm, b, { roomCode: room.code });
  const pidB = wsB.last('joined')!.playerId;
  await until('записи входа легли', () => !rm.inflight.size);
  room.movedAt = 0; room.descend(pidA); room.castVote(pidB, true);
  expect(room.area).toBe('dungeon');
  room.stop();   // тик — только шагами теста
  await until('записи спуска легли', () => !rm.inflight.size);
  const w = room.session.world;
  for (const m of w.monsters) m.alive = false;
  w.players[pidA]!.pos = { ...w.spawn }; w.players[pidB]!.pos = { ...w.spawn };
  room.movedAt = 0; room.returnTown(pidA); room.castVote(pidB, true);
  expect(room.area, 'пати в городе').toBe('town');
  wsB.close();
  await until('B вышел', () => !rm.live.has(b) && !rm.inflight.has(b) && !rm.charOps.has(b));
  expect(row(b).run, 'забег B припаркован').toBeDefined();
  return { room, pidA };
}

describe('⭐ C-05: пати забега полна — «Продолжить» отказывает с кодом её комнаты, «Соло» — город без штрафа', () => {
  it('⭐ вышел из города, его место занял друг: «нет мест» с кодом держателя; лобби «Соло» — город, забег цел; место освободилось — к пати', async () => {
    const rm = manager();
    for (const id of ['F2CA', 'F2CB', 'F2CC', 'F2CD', 'F2CE']) seed(id);
    const { room } = await partyBackInTown(rm, 'F2CA', 'F2CB');
    const guests: FakeConn[] = [];
    for (const id of ['F2CC', 'F2CD', 'F2CE']) guests.push(await lobby(rm, id, { roomCode: room.code }));
    expect(room.seatsTaken('F2CB'), 'пати полна: A и трое друзей').toBe(4);
    const gold = row('F2CB').gold;

    const r = await lobby(rm, 'F2CB', { resume: true });
    expect(r.last('joined'), '«Продолжить» — не в комнату сверх потолка').toBeUndefined();
    expect(r.last('error'), 'было: «В комнате нет мест» без кода — клиенту некуда идти, кроме «Забросить»').toMatchObject({ code: 'full', roomCode: room.code });
    await until('вход отпущен', () => !rm.charOps.has('F2CB'));

    // Лобби «Соло»: грейса у него нет — вход в новую комнату не бросает забег (страховки нет) и штрафа не берёт.
    const solo = await lobby(rm, 'F2CB', { fresh: true });
    expect(solo.last('joined')?.floor.area, JSON.stringify(solo.last('error'))).toBe('town');
    expect(solo.last('joined')!.save.run, 'забег припаркован и в новой комнате').toBeDefined();
    expect(solo.last('joined')!.save.gold, 'без штрафа').toBe(gold);
    solo.close();
    await until('B вышел из своей комнаты', () => !rm.live.has('F2CB') && !rm.charOps.has('F2CB'));

    // Друг ушёл — место есть: «Продолжить» ведёт к пати.
    guests[2]!.close();
    await until('гость вышел', () => !rm.live.has('F2CE') && !rm.charOps.has('F2CE'));
    const back = await lobby(rm, 'F2CB', { resume: true });
    expect(back.last('joined')?.roomCode, JSON.stringify(back.last('error'))).toBe(room.code);
    expect(row('F2CB').gold).toBe(gold);
  });
});

describe('⭐ C-08: забег держит комната другой ноды — отказ `run` с её кодом, после снятия закрепления', () => {
  it('⭐ «Продолжить» — `{code:"run", roomCode}`; закрепление героя снято ДО отказа (клиент идёт по коду сразу, гейтвей не вернёт сюда)', async () => {
    const foreign = new Map<string, string>();
    setRunLockStore({ claim: async (key) => foreign.get(key) ?? null, release: async () => undefined });
    const rm = manager();
    seed('F2CF');
    const ws1 = await lobby(rm, 'F2CF', { fresh: true });
    const room1 = rm.rooms.get(ws1.last('joined')!.roomCode)!;
    const pid1 = ws1.last('joined')!.playerId;
    await until('запись входа легла', () => !rm.inflight.size);
    room1.movedAt = 0; room1.descend(pid1);
    expect(room1.area).toBe('dungeon');
    const key = `id:${room1.runConfig!.id}`;
    const w = room1.session.world;
    w.players[pid1]!.pos = { ...w.spawn };
    room1.movedAt = 0; room1.returnTown(pid1);
    expect(room1.area).toBe('town');
    ws1.close();   // вышел из города — комната пуста и уходит: забег отпущен
    await until('комната ушла', () => !rm.rooms.size && !rm.charOps.has('F2CF'));
    await turns(10);

    foreign.set(key, 'BQQQQQQQ');   // его взяла комната другой ноды
    db.order.length = 0;
    const r = await lobby(rm, 'F2CF', { resume: true });
    expect(r.last('joined')).toBeUndefined();
    expect(r.last('error'), 'было: код держателя — только в тексте').toMatchObject({ code: 'run', roomCode: 'BQQQQQQQ' });
    expect(r.last('error')!.msg).toContain('BQQQQQQQ');
    const released = db.order.indexOf('release F2CF'), refused = db.order.indexOf('F2CF ← error run');
    expect(released, `порядок: ${db.order.join(' | ')}`).toBeGreaterThanOrEqual(0);
    expect(released, `закрепление снято до отказа: ${db.order.join(' | ')}`).toBeLessThan(refused);
    expect(rm.rooms.size, 'комнаты для чужого забега не завели').toBe(0);
  });
});
