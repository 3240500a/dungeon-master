import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, itemFromBaseId, findFree, type ServerFrame, type SaveState, type Item, type PlayerInput } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ K3 (ФАЗЗЕР КЛАСТЕРА B1, ПРОХОД ПРАВОК 2): ВЫБРОШЕННОЕ — В СУМКУ ТОЛЬКО ПОСЛЕ ЗАПИСИ ПОДНИМАЮЩЕГО. Передача вещи через землю — две записи:
 * уход из строки выбросившего (сразу, V-B2-04) и приход в строку поднявшего. Подъём клал вещь в сумку раньше второй, а та могла не лечь
 * вовсе (пауза C-07 после сбоя, упавшая запись без повтора, исход неизвестен — копия «на дописать», процесс умер на ней): процесс, умерший
 * в этом окне, уносил вещь, которой не было ни в одной строке. Правило: ВЕЩЬ В СУМКЕ — ТОЛЬКО ЕСЛИ ОНА В СТРОКЕ (или ещё лежит в строке
 * выбросившего); до записи она на земле, под замком.
 * Менеджер и комната — настоящие, база — маленькая честная (версии строк), с воротами записи, сбоем и неизвестным исходом фиксации.
 */
const TOK = 'c3'.repeat(32);
const USER = 'user-k3rm';
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: SaveState; version: number }>(),
  /** Запись строки героя падает сбоем базы (до фиксации). */
  fail: new Set<string>(),
  /** Следующая запись строки героя — исход фиксации неизвестен, и она НЕ легла. */
  unknown: new Set<string>(),
  /** Запись строки героя (снимок уже снят) ждёт, пока тест не откроет ворота. */
  gate: new Map<string, Promise<void>>(),
  /** Легшие записи строк героев — по порядку. */
  writes: [] as string[],
}));
vi.mock('../db/db.js', async () => {
  const { CommitUnknown } = await import('../db/errors.js');
  return {
    getRunLedger: async () => [],
    mergeRunLedger: async () => undefined,
    landedVersion: async (charId: string, json: string, v: number) => {
      const r = db.chars.get(charId);
      return r && r.version === v + 1 && JSON.stringify(r.data) === json ? r.version : null;
    },
    getSession: async (token: string) => (token === 'c3'.repeat(32) ? 'user-k3rm' : null),
    getCharacter: async (charId: string) => {
      const r = db.chars.get(charId);
      return r ? { userId: 'user-k3rm', data: structuredClone(r.data), version: r.version } : null;
    },
    putCharacter: async (charId: string, _u: string, data: SaveState, v: number) => {
      const json = JSON.stringify(data);   // снимок — в момент вызова, как `snapshotOf`
      await db.gate.get(charId);
      if (db.fail.has(charId)) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      if (db.unknown.delete(charId)) { const e = new CommitUnknown(new Error('Query read timeout')); e.sent = json; throw e; }
      const r = db.chars.get(charId);
      if (!r || v !== r.version) return null;
      r.version = v + 1; r.data = JSON.parse(json) as SaveState;
      db.writes.push(charId);
      return r.version;
    },
    putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
    getAccountStash: async () => null,
    putAccountStash: () => Promise.resolve(),
  };
});
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
  result(id: number): Extract<ServerFrame, { t: 'cmdResult' }> | undefined {
    return this.frames.find((f): f is Extract<ServerFrame, { t: 'cmdResult' }> => f.t === 'cmdResult' && f.id === id);
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(what: string, ok: () => boolean, turns = 5_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}
const turns = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

type Drop = { id: number; kind: string; item?: Item; pos: { x: number; y: number }; heldBy?: string };
type RoomIn = {
  code: string; stop(): void; step(): void; setInput(pid: string, input: PlayerInput): void;
  session: { world: { players: Record<string, { pos: { x: number; y: number }; save: SaveState }>; drops: Drop[] } };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; unsaved: Map<string, unknown>;
  handleConnection(ws: GameConn): void;
  retryUnsaved(now?: number): Promise<void>;
};
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
/** Свой менеджер на тест, без фоновой дописки копий по таймеру (R3-19): её зовёт тест. */
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
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db.fail.clear(); db.unknown.clear(); db.gate.clear(); db.writes = [];
});
afterEach(() => {
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function seed(id: string): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.gold = 5000;
  const sword = itemFromBaseId(cfg.get('items.base'), 'long-sword', cfg.get('item-tiers'), 'drop')!;
  s.inventory.push({ ...sword, pos: findFree(s.inventory, sword.gridW, sword.gridH, cfg.get('balance').inventory) });
  db.chars.set(id, { data: s, version: 1 });
}
const row = (id: string): SaveState => db.chars.get(id)!.data;
const has = (s: SaveState, uid: string): boolean => s.inventory.some((i) => i.uid === uid);
let ipSeq = 0;
async function join(rm: RMIn, charId: string, roomCode?: string): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(roomCode ? { roomCode } : { fresh: true }) });
  await until(`${charId} вошёл`, () => ws.frames.some((f) => f.t === 'joined' || f.t === 'error'));
  expect(ws.frames.find((f) => f.t === 'error'), `${charId}: вход`).toBeUndefined();
  return ws;
}
const joined = (ws: FakeConn): Extract<ServerFrame, { t: 'joined' }> => ws.frames.find((f): f is Extract<ServerFrame, { t: 'joined' }> => f.t === 'joined')!;

/**
 * Два героя одного аккаунта в городе одной комнаты; тик — только шагами теста. A выбросил меч, и его запись без меча легла (V-B2-04: вещь
 * отпущена) — из строки A он ушёл, поднять его может любой герой аккаунта.
 */
async function thrown(a: string, b: string): Promise<{ rm: RMIn; room: RoomIn; wsA: FakeConn; wsB: FakeConn; pidA: string; pidB: string; uid: string; drop: Drop }> {
  const rm = manager();
  seed(a); seed(b);
  const wsA = await join(rm, a);
  const room = rm.rooms.get(joined(wsA).roomCode)!;
  const wsB = await join(rm, b, room.code);
  room.stop();
  await until('записи входа легли', () => !rm.inflight.size);
  const pidA = joined(wsA).playerId, pidB = joined(wsB).playerId;
  const w = room.session.world;
  const uid = w.players[pidA]!.save.inventory.find((i) => i.baseId === 'long-sword')!.uid;
  wsA.push({ t: 'cmd', id: 1, command: { cmd: 'drop', uid } });
  await until('выброс записан — вещь отпущена', () => w.drops.some((d) => d.item?.uid === uid && d.heldBy === undefined));
  expect(has(row(a), uid), 'из строки A ушла').toBe(false);
  const drop = w.drops.find((d) => d.item?.uid === uid)!;
  w.players[pidA]!.pos = { ...drop.pos };
  w.players[pidB]!.pos = { ...drop.pos };
  return { rm, room, wsA, wsB, pidA, pidB, uid, drop };
}
/** ПРАВИЛО K3: вещь в сумке героя — только если она в его строке; иначе падение процесса в этот миг теряет уже записанную вещь. */
function inBagOnlyIfInRow(room: RoomIn, pid: string, charId: string, uid: string): void {
  const p = room.session.world.players[pid];
  if (p && has(p.save, uid)) expect(has(row(charId), uid), `вещь в сумке ${charId}, а в его строке её нет — падение процесса её потеряет`).toBe(true);
}
const onGround = (room: RoomIn, uid: string): Drop | undefined => room.session.world.drops.find((d) => d.item?.uid === uid);

describe('⭐ K3 (проход 2): выброшенное — в сумку только после записи поднимающего', () => {
  it('⭐ K3a: пока запись подъёма в пути, вещь на земле под замком (ни второго подъёма, ни соседа); легла — в сумке и в строке', async () => {
    const { room, wsA, wsB, pidA, pidB, uid, drop } = await thrown('K3AA', 'K3AB');
    let open!: () => void;
    db.gate.set('K3AB', new Promise<void>((r) => { open = r; }));
    wsB.push({ t: 'cmd', id: 2, command: { cmd: 'pickup', dropId: drop.id } });
    await turns(30);
    const pB = room.session.world.players[pidB]!;
    expect(has(pB.save, uid), 'запись в пути — в сумке вещи ещё нет (процесс, умерший сейчас, унёс бы её из сумки без строки)').toBe(false);
    expect(onGround(room, uid), 'она на земле').toBeDefined();
    // Сосед по аккаунту — отказ; сам поднимающий по [E] (кадры его соединения ждут команду в пути) второго подъёма не ставит.
    wsA.push({ t: 'cmd', id: 3, command: { cmd: 'pickup', dropId: drop.id } });
    await until('ответ соседу', () => !!wsA.result(3));
    expect(wsA.result(3), 'сосед — отказ').toMatchObject({ ok: false, reason: 'Вещь уже поднимают' });
    expect(has(room.session.world.players[pidA]!.save, uid), 'у соседа вещи нет').toBe(false);
    const writes = db.writes.length;
    room.setInput(pidB, { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: true });
    room.step();
    await turns(30);
    expect(has(pB.save, uid), '[E] в пути — тоже не в сумке').toBe(false);
    expect(db.writes.length, 'и второй записи нет').toBe(writes);
    db.gate.delete('K3AB');
    open();
    await until('подъём ответил', () => !!wsB.result(2));
    expect(wsB.result(2)).toMatchObject({ ok: true });
    expect(has(pB.save, uid), 'в сумке').toBe(true);
    expect(has(row('K3AB'), uid), 'и в строке').toBe(true);
    expect(onGround(room, uid), 'с земли долой').toBeUndefined();
    expect(pB.save.inventory.filter((i) => i.uid === uid), 'одна').toHaveLength(1);
  });

  it('⭐ K3b: запись подъёма упала — вещь осталась на земле свободной; в паузу C-07 подъём не пишет; после неё — поднимается', async () => {
    const { room, wsB, pidB, uid, drop } = await thrown('K3BA', 'K3BB');
    vi.useFakeTimers({ toFake: ['Date'] });
    db.fail.add('K3BB');
    const writes = db.writes.length;
    wsB.push({ t: 'cmd', id: 2, command: { cmd: 'pickup', dropId: drop.id } });
    await until('подъём ответил', () => !!wsB.result(2));
    expect(wsB.result(2), 'подъём не состоялся').toMatchObject({ ok: false });
    expect(wsB.result(2)!.reason).toMatch(/осталась на земле/);
    inBagOnlyIfInRow(room, pidB, 'K3BB', uid);
    expect(has(room.session.world.players[pidB]!.save, uid), 'в сумке её нет').toBe(false);
    expect(onGround(room, uid), 'она на земле').toBeDefined();
    expect(onGround(room, uid)!.heldBy, 'и свободна (строка B её не держит)').toBeUndefined();
    // База вернулась, но пауза после сбоя (C-07) ещё идёт: подъём не пишет на каждый клик и не кладёт в сумку.
    db.fail.delete('K3BB');
    wsB.push({ t: 'cmd', id: 3, command: { cmd: 'pickup', dropId: drop.id } });
    await until('ответ в паузу', () => !!wsB.result(3));
    expect(wsB.result(3)).toMatchObject({ ok: false });
    expect(db.writes.length, 'в паузу — ни одной записи').toBe(writes);
    inBagOnlyIfInRow(room, pidB, 'K3BB', uid);
    vi.setSystemTime(Date.now() + 6_000);
    const mono = performance.now() + 6_000;   // ⭐ R15-06: пауза C-07 — по часам процесса
    vi.spyOn(performance, 'now').mockReturnValue(mono);
    wsB.push({ t: 'cmd', id: 4, command: { cmd: 'pickup', dropId: drop.id } });
    await until('подъём после паузы', () => !!wsB.result(4));
    expect(wsB.result(4)).toMatchObject({ ok: true });
    expect(has(room.session.world.players[pidB]!.save, uid) && has(row('K3BB'), uid), 'в сумке и в строке').toBe(true);
  });

  it('⭐ K3c: исход записи подъёма неизвестен (не легла) — вещь на земле за поднимавшим, копия — без неё; дописка копии легла — вещь свободна', async () => {
    const { rm, room, wsA, wsB, pidA, uid, drop } = await thrown('K3CA', 'K3CB');
    db.unknown.add('K3CB');
    wsB.push({ t: 'cmd', id: 2, command: { cmd: 'pickup', dropId: drop.id } });
    await until('сессию B сняли', () => !wsB.open);
    expect(wsB.closedWith, 'исход неизвестен — сессия снята').toBe(4009);
    await until('копия B — у менеджера на дописать', () => rm.unsaved.has('K3CB'));
    expect(has(row('K3CB'), uid), 'в строке B вещи нет').toBe(false);
    expect(onGround(room, uid), 'вещь не в копии «на дописать», а на земле').toBeDefined();
    expect(onGround(room, uid)!.heldBy, 'за поднимавшим: его запись могла лечь').toBe('K3CB');
    // Сосед до дописки её не поднимет (вещь, может быть, уже в строке B).
    wsA.push({ t: 'cmd', id: 2, command: { cmd: 'pickup', dropId: drop.id } });
    await until('ответ соседу', () => !!wsA.result(2));
    expect(wsA.result(2)).toMatchObject({ ok: false });
    expect(has(room.session.world.players[pidA]!.save, uid)).toBe(false);
    // Дописка копии B (без вещи) легла: вещь больше ничьей строке не принадлежит — метка снята, поднимает любой герой аккаунта.
    await rm.retryUnsaved(Date.now() + 3_600_000);
    await until('копия дописана', () => !rm.unsaved.has('K3CB'));
    expect(has(row('K3CB'), uid), 'в строке B вещи нет и после дописки').toBe(false);
    expect(onGround(room, uid)?.heldBy, 'метка снята').toBeUndefined();
    wsA.push({ t: 'cmd', id: 3, command: { cmd: 'pickup', dropId: drop.id } });
    await until('подъём соседа', () => !!wsA.result(3));
    expect(wsA.result(3)).toMatchObject({ ok: true });
    expect(has(row('K3CA'), uid), 'в строке A').toBe(true);
    expect(has(row('K3CB'), uid), 'и больше нигде').toBe(false);
  });

  it('⭐ K3d: СВОЁ выброшенное (выброс лёг), поднятое, пока база лежит, — на земле, а не в сумке без строки', async () => {
    const { room, wsA, pidA, uid, drop } = await thrown('K3DA', 'K3DB');
    db.fail.add('K3DA');
    wsA.push({ t: 'cmd', id: 2, command: { cmd: 'pickup', dropId: drop.id } });
    await until('подъём ответил', () => !!wsA.result(2));
    expect(wsA.result(2)).toMatchObject({ ok: false });
    inBagOnlyIfInRow(room, pidA, 'K3DA', uid);
    expect(has(room.session.world.players[pidA]!.save, uid), 'в сумке её нет').toBe(false);
    expect(onGround(room, uid), 'она на земле').toBeDefined();
  });

  it('⭐ [E] тика тоже поднимает выброшенное записью: шаг вещь не берёт, легла запись — в сумке, в строке и у клиента', async () => {
    const { room, wsB, pidB, uid } = await thrown('K3EA', 'K3EB');
    const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
    room.setInput(pidB, { ...idle, interact: true });
    room.step();
    room.setInput(pidB, idle);
    const pB = room.session.world.players[pidB]!;
    expect(has(pB.save, uid), 'тик вещь в сумку не кладёт — сперва запись').toBe(false);
    inBagOnlyIfInRow(room, pidB, 'K3EB', uid);
    await until('подъём [E] лёг', () => has(pB.save, uid));
    expect(has(row('K3EB'), uid), 'в строке').toBe(true);
    expect(onGround(room, uid), 'с земли долой').toBeUndefined();
    const save = [...wsB.frames].reverse().find((f): f is Extract<ServerFrame, { t: 'saveUpdate' }> => f.t === 'saveUpdate');
    expect(save?.save.inventory.some((i) => i.uid === uid), 'клиент видит вещь в сумке').toBe(true);
  });
});
