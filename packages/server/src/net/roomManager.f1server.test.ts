import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, emptyStash, findFree, type ServerFrame, type SaveState, type AccountStash } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ ФАЗЗЕРЫ, ПРОХОД ПРАВОК 1 (сервер), граница менеджера комнат. Менеджер и комнаты — настоящие; база — маленькая честная (версии сейва):
 * запись героя умеет зависнуть до знака теста и кончиться «исход фиксации неизвестен» — легла (`landed`) или нет (`lost`), по очереди исходов.
 *  • V3: две записи копии подряд с неизвестным исходом — легла первая, вторая нет: отказ по версии узнаёт легшую по ЛЮБОМУ из снимков
 *    (живая сессия — `write`, снятая с неизвестным исходом — `keepUnknown`, ждущая реконнекта — `persistDisconnected`), а не по последнему;
 *  • V1: погибший в коопе, чью сессию сняла запись (4009), ждёт реконнекта в своей комнате (мёртвым), а «мёртв, оплачено» — ещё и в сейве:
 *    «Завершить» не берёт второй штраф, «Продолжить» не оживляет в новой комнате;
 *  • V2: один забег — одна комната: «Продолжить» без грейса ведёт в комнату пати, спуск из другой комнаты — отказ с её кодом; забег,
 *    который держит комната другой ноды (кластер, `setRunLockStore`), — тоже.
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number; json?: string }>(),
  /** Следующая запись героя ждёт, пока тест не откроет. */
  gate: new Map<string, Promise<void>>(),
  /** Исходы следующих записей героя по порядку: легла с потерянным ответом или не легла с потерянным ответом. */
  faults: new Map<string, ('landed' | 'lost')[]>(),
  /** То же для записей «сейв + сундук». */
  stashFaults: new Map<string, ('landed' | 'lost')[]>(),
  /** Сундук аккаунта — JSON и версия (D8). */
  stash: new Map<string, { data: unknown; version: number }>(),
  log: [] as string[],
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => [],
  mergeRunLedger: async () => undefined,
  getSession: async () => 'user-f1rm',
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-f1rm', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data), json = JSON.stringify(data);   // снимок — в момент вызова, как `snapshotOf`
    const g = db.gate.get(charId);
    if (g) { db.gate.delete(charId); await g; } else await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    const f = db.faults.get(charId)?.shift();
    if (f) {
      const { CommitUnknown } = await import('../db/errors.js');
      if (f === 'landed' && r && v === r.version) { r.version = v + 1; r.data = snap; r.json = json; }
      db.log.push(`${charId} v${v} COMMIT-UNKNOWN (${f})`);
      const e = new CommitUnknown(new Error('Connection terminated unexpectedly'), false);
      e.sent = json;
      throw e;
    }
    if (!r || v !== r.version) { db.log.push(`${charId} v${v} CONFLICT`); return null; }
    r.version = v + 1; r.data = snap; r.json = json;
    db.log.push(`${charId} v${v}->v${r.version}`);
    return r.version;
  },
  landedVersion: async (charId: string, json: string, v: number) => {
    const r = db.chars.get(charId);
    return r && r.version === v + 1 && r.json === json ? r.version : null;
  },
  putCharacterWithStash: async (charId: string, userId: string, data: unknown, v: number, stash: unknown, sv: number) => {
    const snap = structuredClone(data), json = JSON.stringify(data), st = structuredClone(stash);
    await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    const cur = db.stash.get(userId);
    const f = db.stashFaults.get(charId)?.shift();
    const fits = !!r && v === r.version && sv === (cur?.version ?? 0);
    if (f) {
      const { CommitUnknown } = await import('../db/errors.js');
      if (f === 'landed' && fits) { r!.version = v + 1; r!.data = snap; r!.json = json; db.stash.set(userId, { data: st, version: sv + 1 }); }
      db.log.push(`${charId} v${v} +сундук COMMIT-UNKNOWN (${f})`);
      const e = new CommitUnknown(new Error('Connection terminated unexpectedly'), false);
      e.sent = json;
      throw e;
    }
    if (!r || v !== r.version) { db.log.push(`${charId} v${v} +сундук CONFLICT save`); return { ok: false, conflict: 'save' }; }
    if (sv !== (cur?.version ?? 0)) { db.log.push(`${charId} v${v} +сундук CONFLICT stash`); return { ok: false, conflict: 'stash' }; }
    r.version = v + 1; r.data = snap; r.json = json;
    db.stash.set(userId, { data: st, version: sv + 1 });
    db.log.push(`${charId} v${v}->v${r.version} +сундук`);
    return { ok: true, version: r.version, stashVersion: sv + 1 };
  },
  getAccountStash: async (userId: string) => {
    const st = db.stash.get(userId);
    return st ? { data: structuredClone(st.data), version: st.version } : null;
  },
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

const TOK = 'f1'.repeat(32);
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

type Pl = {
  hp: number; maxHp: number; alive: boolean; pos: { x: number; y: number }; save: SaveState;
  debuffs: Record<string, unknown>;
};
type RoomIn = {
  code: string; area: string; movedAt: number; stop(): void; step(): void;
  persist(pid: string): Promise<string>;
  descend(pid: string): void; castVote(pid: string, yes: boolean): void;
  lingering: Map<string, unknown>; disconnected: Map<string, unknown>;
  session: { world: { monsters: { alive: boolean }[]; spawn: { x: number; y: number }; players: Record<string, Pl>; timeMs: number } };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; unsaved: Map<string, unknown>;
  charOps: Map<string, unknown>;
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
/** Свой менеджер на тест, без фоновой дописки копий по таймеру (R3-19): её зовёт тест (`retryUnsaved`). */
function manager(): RMIn {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try {
    const rm = new RoomManagerCtor(cfg) as unknown as RMIn;
    managers.push(rm);
    return rm;
  } finally { vi.useRealTimers(); }
}
beforeEach(() => {
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync, limits.stashRead]) l.reset('user-f1rm');
  // Сбои записи здесь — нарочные: лог комнаты о них тесту не нужен.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  db.gate.clear(); db.faults.clear(); db.stashFaults.clear(); db.stash.clear();
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.restoreAllMocks();
});

function seed(id: string, patch?: (s: SaveState) => void): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  patch?.(s);
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
/** Запись героя повиснет до `open()`. */
function stall(charId: string): () => void {
  let open!: () => void;
  db.gate.set(charId, new Promise<void>((r) => { open = r; }));
  return () => open();
}
const heroLog = (id: string): string => db.log.filter((l) => l.startsWith(id)).join(' | ');
/** Дописать копии, которые база не приняла, — фоном менеджера, мимо паузы между попытками. */
async function retry(rm: RMIn): Promise<void> {
  await rm.retryUnsaved(Date.now() + 3_600_000);
  await turns(30);
}

describe('⭐ V3: две записи копии подряд с неизвестным исходом (легла, потом нет) — копия продолжает легшую, а не выбрасывается', () => {
  it('⭐ ждущий реконнекта (`persistDisconnected`): прощальная легла, запись штрафа тела в бою — нет; штраф смерти — в строке', async () => {
    const rm = manager();
    seed('F1A', (s) => { s.level = 30; s.attributes.vitality = 60; });
    seed('F1B', (s) => { s.level = 30; s.gold = 5000; s.attributes.vitality = 60; });
    const wsA = await join(rm, 'F1A');
    const code = wsA.last('joined')!.roomCode;
    const pidA = wsA.last('joined')!.playerId;
    const wsB = await join(rm, 'F1B', { roomCode: code });
    const pidB = wsB.last('joined')!.playerId;
    const room = rm.rooms.get(code)!;
    await until('записи входа легли', () => !rm.inflight.size);
    room.movedAt = 0; room.descend(pidA); room.castVote(pidB, true);
    expect(room.area).toBe('dungeon');
    room.stop();   // тик — только шагами теста
    await until('записи спуска легли', () => !rm.inflight.size);
    await turns(30);
    const w = room.session.world;
    for (const m of w.monsters) m.alive = false;
    // B отравлен насмерть (урон по времени его добьёт — он «в опасности»): закрыл вкладку — тело остаётся в бою.
    const b = w.players[pidB]!;
    b.hp = 1;
    b.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: w.timeMs + 60_000, mag: 9999, mag2: 0 };
    db.faults.set('F1B', ['landed', 'lost']);   // прощальная — легла (ответ потерян); следующая (штраф тела) — не легла
    wsB.close();
    await until('тело в бою', () => room.lingering.size === 1);
    await until('прощальная запись вернулась', () => db.log.some((l) => l.startsWith('F1B') && l.includes('(landed)')));
    await turns(30);
    expect(row('F1B').gold, 'легла копия до смерти').toBe(5000);
    for (let t = 0; t < 30 && room.lingering.size; t++) room.step();
    expect(room.lingering.size, 'тело погибло').toBe(0);
    await until('запись штрафа вернулась', () => db.log.some((l) => l.startsWith('F1B') && l.includes('(lost)')));
    await turns(30);
    expect(rm.unsaved.has('F1B'), 'копия со штрафом ждёт дописки').toBe(true);
    await retry(rm);
    expect(row('F1B').gold, `штраф смерти в строке: ${heroLog('F1B')}`).toBeLessThan(5000);
    expect(rm.unsaved.has('F1B')).toBe(false);
  });

  it('⭐ ушедший из города (`write`): автосейв лёг с потерянным ответом, прощальная — не легла; в строке — прощальная копия', async () => {
    const rm = manager();
    seed('F1C', (s) => { s.gold = 1000; });
    const ws = await join(rm, 'F1C');
    const pid = ws.last('joined')!.playerId;
    const room = rm.rooms.get(ws.last('joined')!.roomCode)!;
    await until('запись входа легла', () => !rm.inflight.size);
    await turns(30);
    const open = stall('F1C');
    db.faults.set('F1C', ['landed', 'lost']);
    const autosave = room.persist(pid);   // снимок: золото 1000 — и фиксация повисла
    await tick();
    room.session.world.players[pid]!.save.gold = 1234;   // пока висит — копия ушла дальше (продал, купил)
    ws.push({ t: 'leave' });   // вышел из города: прощальная запись встала за повисшей
    await until('сессия снята', () => !rm.live.has('F1C'));
    open();
    expect(await autosave).toBe('unknown');
    await until('прощальная запись вернулась', () => db.log.some((l) => l.includes('(lost)')));
    await until('менеджер держит копию', () => rm.unsaved.has('F1C') && !rm.inflight.has('F1C'));
    expect(row('F1C').gold, 'легла копия автосейва').toBe(1000);
    await retry(rm);
    expect(row('F1C').gold, `в строке — прощальная копия: ${heroLog('F1C')}`).toBe(1234);
    expect(rm.unsaved.has('F1C')).toBe(false);
  });

  it('⭐ снятый с неизвестным исходом (`keepUnknown`): фиксация легла, первая дописка — нет; вторая пишет копию поверх легшей', async () => {
    const rm = manager();
    seed('F1D', (s) => { s.gold = 1000; });
    const ws = await join(rm, 'F1D');
    const pid = ws.last('joined')!.playerId;
    const room = rm.rooms.get(ws.last('joined')!.roomCode)!;
    await until('запись входа легла', () => !rm.inflight.size);
    await turns(30);
    const open = stall('F1D');
    db.faults.set('F1D', ['landed', 'lost']);
    const autosave = room.persist(pid);   // снимок: золото 1000 — и фиксация повисла
    await tick();
    room.session.world.players[pid]!.save.gold = 777;   // пока висит — копия ушла дальше
    open();
    expect(await autosave).toBe('unknown');
    await until('сессия снята (4009)', () => ws.closedWith === 4009);
    await until('менеджер держит копию', () => rm.unsaved.has('F1D') && !rm.inflight.has('F1D') && !rm.charOps.has('F1D'));
    expect(row('F1D').gold, 'легла копия до снятия').toBe(1000);
    await retry(rm);   // первая дописка — исход неизвестен, не легла
    expect(db.log.filter((l) => l.startsWith('F1D') && l.includes('(lost)')).length).toBe(1);
    expect(rm.unsaved.has('F1D'), 'копия всё ещё ждёт').toBe(true);
    await retry(rm);   // вторая: отказ по версии — легла первая фиксация, копия пишется поверх неё
    expect(row('F1D').gold, `в строке — копия: ${heroLog('F1D')}`).toBe(777);
    expect(rm.unsaved.has('F1D')).toBe(false);
  });

  it('⭐ снятый с неизвестным исходом, запись с сундуком: сундук обогнали, лёг сейв «до действия» — поверх не пишется сейв ПОСЛЕ действия', async () => {
    const rm = manager();
    let X = '';
    seed('F1E', (s) => { const w = s.equipment.weapon!; delete s.equipment.weapon; X = w.uid; const st = emptyStash(cfg); w.pos = { x: 0, y: 0 }; st.tabs[0]!.push(w); db.stash.set('user-f1rm', { data: st, version: 1 }); });
    const ws = await join(rm, 'F1E');
    const pid = ws.last('joined')!.playerId;
    const room = rm.rooms.get(ws.last('joined')!.roomCode)!;
    await until('запись входа легла', () => !rm.inflight.size);
    await turns(30);
    const save = room.session.world.players[pid]!.save;
    const it0 = (db.stash.get('user-f1rm')!.data as AccountStash).tabs[0]![0]!;
    const at = findFree(save.inventory, it0.gridW, it0.gridH, cfg.get('balance').inventory)!;
    // Перенос X из сундука в сумку: запись «сейв + сундук» — исход неизвестен, не легла.
    db.stashFaults.set('F1E', ['lost']);
    ws.push({ t: 'cmd', command: { cmd: 'stashMove', uid: X, dst: 'inv', x: at.x, y: at.y }, id: 1 });
    await until('сессия снята (4009)', () => ws.closedWith === 4009);
    await until('менеджер держит копию', () => rm.unsaved.has('F1E') && !rm.inflight.has('F1E') && !rm.charOps.has('F1E'));
    // Другой герой аккаунта тронул сундук: запись с ним больше не ляжет — дописывается сейв ДО действия, и он ложится с потерянным ответом.
    db.stash.get('user-f1rm')!.version++;
    db.faults.set('F1E', ['landed']);
    await retry(rm);
    expect(rm.unsaved.has('F1E'), 'копия всё ещё ждёт').toBe(true);
    await retry(rm);
    const inStash = (db.stash.get('user-f1rm')!.data as AccountStash).tabs.flat().some((i) => i.uid === X);
    const inRow = [...row('F1E').inventory, ...Object.values(row('F1E').equipment)].some((i) => i?.uid === X);
    expect(inStash, 'X в сундуке — перенос не лёг').toBe(true);
    expect(inRow, `X не в строке героя — иначе он у двоих: ${heroLog('F1E')}`).toBe(false);
    expect(rm.unsaved.has('F1E')).toBe(false);
  });
});

// ── V1, V2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Кооп A + B в подземелье комнаты A; монстры «спят», тик — только шагами теста. */
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
  room.stop();   // тик — только шагами теста
  await until('записи спуска легли', () => !rm.inflight.size);
  await turns(30);
  const w = room.session.world;
  for (const m of w.monsters) m.alive = false;
  w.players[pidA]!.pos = { ...w.spawn }; w.players[pidB]!.pos = { ...w.spawn };
  return { room, pidA, pidB, wsA, wsB };
}
/** Герой погиб в бою (смертельный яд — весь путь «событие → штраф → ожидание мёртвым»). */
function kill(room: RoomIn, pid: string): void {
  const p = room.session.world.players[pid]!;
  p.hp = 1;
  p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: room.session.world.timeMs + 60_000, mag: 9999, mag2: 0 };
  for (let t = 0; t < 10 && p.alive; t++) room.step();
  expect(p.alive, 'погиб').toBe(false);
}
/** Автосейв героя — исход фиксации неизвестен и НЕ лёг: сессию снимают (4009). */
async function dropByWrite(rm: RMIn, room: RoomIn, pid: string, charId: string, ws: FakeConn): Promise<void> {
  db.faults.set(charId, ['lost']);
  expect(await room.persist(pid)).toBe('unknown');
  await until('сессия снята (4009)', () => ws.closedWith === 4009);
  await until('менеджер отпустил героя', () => !rm.live.has(charId) && !rm.inflight.has(charId) && !rm.charOps.has(charId));
}
/** Кадр лобби героя с нового сокета — до ответа. */
async function lobby(rm: RMIn, frame: Record<string, unknown>, done: (ws: FakeConn) => boolean): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ ...frame, token: TOK });
  await until(`ответ на ${String(frame.t)}`, () => done(ws));
  return ws;
}

describe('⭐ V1: погибший в коопе, снятый записью (4009), ждёт реконнекта в своей комнате; «мёртв, оплачено» — и в сейве', () => {
  it('⭐ «Завершить» после снятия — второго штрафа за ту же смерть нет', async () => {
    const rm = manager();
    seed('F1V1A', (s) => { s.level = 30; s.gold = 5000; s.attributes.vitality = 60; });
    seed('F1V1B', (s) => { s.level = 30; s.attributes.vitality = 60; });
    const { room, pidA, wsA } = await coopDungeon(rm, 'F1V1A', 'F1V1B');
    kill(room, pidA);
    const paidGold = room.session.world.players[pidA]!.save.gold;
    expect(paidGold, 'штраф смерти взят').toBeLessThan(5000);
    await dropByWrite(rm, room, pidA, 'F1V1A', wsA);
    expect(room.disconnected.has('F1V1A'), 'снятый ждёт реконнекта в своей комнате').toBe(true);
    const ws = await lobby(rm, { t: 'abandon', charId: 'F1V1A' }, (w) => !!w.last('abandoned') || !!w.last('error'));
    expect(ws.last('abandoned'), JSON.stringify(ws.last('error'))).toBeDefined();
    expect(row('F1V1A').run, 'забег завершён').toBeUndefined();
    expect(row('F1V1A').gold, `ровно один штраф: ${heroLog('F1V1A')}`).toBe(paidGold);
  });

  it('⭐ «Продолжить» после снятия — мёртвым в своей комнате на том же этаже, а не живым в новой', async () => {
    const rm = manager();
    seed('F1V1C', (s) => { s.level = 30; s.attributes.vitality = 60; });
    seed('F1V1D', (s) => { s.level = 30; s.attributes.vitality = 60; });
    const { room, pidB, wsB } = await coopDungeon(rm, 'F1V1C', 'F1V1D');
    const node = (room as unknown as { runNodeId: string }).runNodeId;
    kill(room, pidB);
    await dropByWrite(rm, room, pidB, 'F1V1D', wsB);
    const ws = await lobby(rm, { t: 'join', resume: true, charId: 'F1V1D' }, (w) => !!w.last('joined') || !!w.last('error'));
    const j = ws.last('joined');
    expect(j, JSON.stringify(ws.last('error'))).toBeDefined();
    expect(j!.roomCode, 'в свою комнату').toBe(room.code);
    expect(rm.rooms.size, 'новой комнаты нет').toBe(1);
    expect((room as unknown as { runNodeId: string }).runNodeId).toBe(node);
    expect(room.session.world.players[j!.playerId]!.alive, 'этаж тот же — мёртв').toBe(false);
  });
});

describe('⭐ V1: снятый записью посреди боя — не бегство (снял его сервер, а не игрок)', () => {
  it('пати уходит в город — снятого не хоронят: без штрафа, забег припаркован', async () => {
    const rm = manager();
    seed('F1V1E', (s) => { s.level = 30; s.gold = 5000; s.attributes.vitality = 60; });
    seed('F1V1F', (s) => { s.level = 30; s.attributes.vitality = 60; });
    const { room, pidA, pidB, wsA } = await coopDungeon(rm, 'F1V1E', 'F1V1F');
    const a = room.session.world.players[pidA]!;
    a.hp = 5;   // яд его добьёт — он «в опасности» (R7-08), и уйди он сам — это было бы бегство
    a.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: room.session.world.timeMs + 60_000, mag: 9999, mag2: 0 };
    await dropByWrite(rm, room, pidA, 'F1V1E', wsA);
    const info = room.disconnected.get('F1V1E') as { fled: boolean; fledDescend: boolean } | undefined;
    expect(info, 'ждёт реконнекта').toMatchObject({ fled: false, fledDescend: false });
    room.movedAt = 0; (room as unknown as { returnTown(pid: string): void }).returnTown(pidB);
    expect(room.area).toBe('town');
    await until('записи ушли', () => !rm.inflight.has('F1V1E'));
    await retry(rm);
    expect(row('F1V1E').gold, `без штрафа: ${heroLog('F1V1E')}`).toBe(5000);
    expect(row('F1V1E').run, 'забег припаркован').toBeDefined();
  });
});

describe('⭐ V2: один забег — одна комната', () => {
  /** A и B прошли узел, вернулись в город; B вышел из города, A продолжил забег в своей комнате. */
  async function partyResumedWithoutB(rm: RMIn, a: string, b: string): Promise<{ room: RoomIn; wsA: FakeConn }> {
    const { room, pidA, pidB, wsA, wsB } = await coopDungeon(rm, a, b);
    const r = room as unknown as { returnTown(pid: string): void; runNodeId: string | null };
    room.movedAt = 0; r.returnTown(pidA); room.castVote(pidB, true);
    expect(room.area, 'пати в городе').toBe('town');
    wsB.close();   // вышел из города — забег припаркован
    await until('B вышел', () => !rm.live.has(b) && !rm.inflight.has(b) && !rm.charOps.has(b));
    room.movedAt = 0; room.descend(pidA);
    await until('пати продолжила забег', () => room.area === 'dungeon');
    return { room, wsA };
  }

  it('⭐ «Соло» и спуск, пока забег идёт у пати, — отказ с кодом её комнаты; вторая комната в забег не уходит', async () => {
    const rm = manager();
    seed('F1V2A', (s) => { s.level = 30; s.attributes.vitality = 60; });
    seed('F1V2B', (s) => { s.level = 30; s.attributes.vitality = 60; });
    const { room } = await partyResumedWithoutB(rm, 'F1V2A', 'F1V2B');
    const wsB = await join(rm, 'F1V2B');
    const other = rm.rooms.get(wsB.last('joined')!.roomCode)!;
    expect(other).not.toBe(room);
    expect(wsB.last('joined')!.save.run, 'забег B припаркован').toBeDefined();
    other.movedAt = 0;
    wsB.push({ t: 'descend' });
    await until('ответ спуску', () => !!wsB.last('error') || other.area === 'dungeon');
    expect(wsB.last('error')).toMatchObject({ code: 'run' });
    expect(wsB.last('error')!.msg).toContain(room.code);
    await turns(30);
    expect(other.area, 'вторая комната — в городе').toBe('town');
  });

  it('⭐ «Продолжить» без грейса, пока забег идёт у пати, — в её комнату, а не в новую рядом', async () => {
    const rm = manager();
    seed('F1V2C', (s) => { s.level = 30; s.attributes.vitality = 60; });
    seed('F1V2D', (s) => { s.level = 30; s.attributes.vitality = 60; });
    const { room } = await partyResumedWithoutB(rm, 'F1V2C', 'F1V2D');
    const ws = await lobby(rm, { t: 'join', resume: true, charId: 'F1V2D' }, (w) => !!w.last('joined') || !!w.last('error'));
    expect(ws.last('joined'), JSON.stringify(ws.last('error'))).toBeDefined();
    expect(ws.last('joined')!.roomCode, 'к пати').toBe(room.code);
    expect(rm.rooms.size, 'новой комнаты нет').toBe(1);
  });

  it('⭐ забег держит комната ДРУГОЙ ноды (кластер) — «Продолжить» и спуск отказывают с её кодом; отпущен — продолжается', async () => {
    const { setRunLockStore } = await import('./roomManager.js');
    const foreign = new Map<string, string>();
    const claims: string[] = [], releases: string[] = [];
    setRunLockStore({
      claim: async (key, room) => { claims.push(`${key}@${room}`); return foreign.get(key) ?? null; },
      release: async (key, room) => { releases.push(`${key}@${room}`); },
    });
    try {
      const rm = manager();
      seed('F1V2E', (s) => { s.level = 30; s.attributes.vitality = 60; });
      const ws1 = await join(rm, 'F1V2E');
      const room1 = rm.rooms.get(ws1.last('joined')!.roomCode)!;
      const pid1 = ws1.last('joined')!.playerId;
      await until('запись входа легла', () => !rm.inflight.size);
      room1.movedAt = 0; room1.descend(pid1);
      expect(room1.area).toBe('dungeon');
      const key = `id:${(room1 as unknown as { runConfig: { id: string } }).runConfig.id}`;
      await turns(10);
      expect(claims, 'новый забег взят за нодой').toContain(`${key}@${room1.code}`);
      const w = room1.session.world;
      w.players[pid1]!.pos = { ...w.spawn };
      room1.movedAt = 0; (room1 as unknown as { returnTown(pid: string): void }).returnTown(pid1);
      expect(room1.area).toBe('town');
      ws1.close();   // вышел из города — комната пуста и уходит: забег отпущен
      await until('комната ушла', () => !rm.rooms.size && !rm.charOps.has('F1V2E'));
      await turns(10);
      expect(releases, 'комната ушла — забег отпущен в кластере').toContain(`${key}@${room1.code}`);

      foreign.set(key, 'BQQQQQQ');   // его взяла комната другой ноды
      const r1 = await lobby(rm, { t: 'join', resume: true, charId: 'F1V2E' }, (x) => !!x.last('joined') || !!x.last('error'));
      expect(r1.last('joined'), '«Продолжить» — не здесь').toBeUndefined();
      expect(r1.last('error')).toMatchObject({ code: 'run' });
      expect(r1.last('error')!.msg).toContain('BQQQQQQ');
      await until('вход отпущен', () => !rm.charOps.has('F1V2E'));
      expect(rm.rooms.size, 'комнаты для чужого забега не завели').toBe(0);

      const ws2 = await join(rm, 'F1V2E');   // «Соло» — город, забег припаркован
      const room2 = rm.rooms.get(ws2.last('joined')!.roomCode)!;
      room2.movedAt = 0;
      ws2.push({ t: 'descend' });
      await until('ответ спуску', () => !!ws2.last('error') || room2.area === 'dungeon');
      expect(ws2.last('error')).toMatchObject({ code: 'run' });
      expect(ws2.last('error')!.msg).toContain('BQQQQQQ');
      expect(room2.area).toBe('town');

      foreign.delete(key);   // та комната забег отпустила
      room2.movedAt = 0;
      ws2.push({ t: 'descend' });
      await until('забег продолжен', () => room2.area === 'dungeon');
      expect(`id:${(room2 as unknown as { runConfig: { id: string } }).runConfig.id}`).toBe(key);
    } finally { setRunLockStore(null); }
  });
});
