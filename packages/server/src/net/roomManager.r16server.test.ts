import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, itemFromBaseId, findFree, addToInventory,
  type ServerFrame, type SaveState, type Item, type PlayerInput, type QuestDef, type RunConfig,
} from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ R16 (СЕРВЕР): подъём выброшенного (K3) и соседи по его записи, бегство гостя с чужим забегом, очередь записей при лежащей базе.
 *  • C-01: подъём выброшенного, начатый тиком, не кладёт вещь поверх занятой клетки: клетку, пока писали, заняла команда (покупка, подъём
 *    добычи по id) — вещь в первую свободную, а нет её — остаётся на земле за поднимавшим (её строка уже держит вещь), и запись без неё
 *    снимает метку. Раньше — `?? pos`: две вещи в клетке и сумка сверх ёмкости, повторяемо. И в начале работы — те же правила, что у
 *    `pickable` (жив, рядом): ушедший, пока подъём ждал очередь, вещь не поднимает.
 *  • C-04: подъём выброшенного (`pickup` по id) не держит кадры соединения и сейв героя на время записи: ответ — когда запись ляжет, а
 *    зелье пояса, следующие команды и переход по голосованию — сразу (R2-14 для подъёма).
 *  • C-12: подъём кликом (`pickup` добычи) идёт тем же путём событий, что тик: сбор для заданий, наблюдения, события золота и сырья.
 *  • C-03: вход по коду в подземелье ЧУЖОГО забега с припаркованным своим — отказ `run` (как голос за спуск, R4-25): в подземелье каждый —
 *    участник его забега, и бегство из боя платит штраф (раньше гость с запаркованным забегом уходил из любого боя даром).
 *  • C-06: автосейв не множит записи в очереди героя (одна ждёт — вторая не встаёт), а свод, который база только что не приняла
 *    `LEDGER_FIRST_ROUNDS` раз подряд, запись сейва не ждёт таймаутом каждого круга.
 *  • R16-01: вход без «Продолжить» (новая комната, по коду) при грейсе, чей бросок стоил бы штрафа, — отказ `run`, а не штраф и снятие забега
 *    молча: Unity шлёт статус забега и `join{fresh}` подряд, не читая ответа, и любой обрыв посреди подземелья стоил ему смерти.
 *  • R16-06: бюджет слива (`flushAll`) — по часам процесса: шаг настенных часов не растягивает дописку за предохранитель ноды и не обрывает её.
 * Менеджер и комната — настоящие, база — маленькая честная (версии строк), с воротами записи и сбоем свода.
 */
const TOK = 'e6'.repeat(32);
const USER = 'user-r16rm';
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: SaveState; version: number }>(),
  /** Запись строки героя (снимок уже снят) ждёт, пока тест не откроет ворота. */
  gate: new Map<string, Promise<void>>(),
  /** Легшие записи строк героев — по порядку. */
  writes: [] as string[],
  /** Попытки записи строк (и не легшие) — по герою. */
  tries: new Map<string, number>(),
  /** Свод забега не ложится (база отказывает). */
  ledgerDown: false,
  /** Попытки записи свода. */
  ledgerTries: 0,
  /** ⭐ R16-06: запись строки героя падает (база лежит); `onDown` — зовётся на каждом таком сбое. */
  down: false,
  onDown: null as null | (() => void),
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => [],
  mergeRunLedger: async () => {
    db.ledgerTries++;
    await new Promise((res) => setTimeout(res, 1));
    if (db.ledgerDown) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  },
  landedVersion: async () => null,
  getSession: async (token: string) => (token === 'e6'.repeat(32) ? 'user-r16rm' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r16rm', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: SaveState, v: number) => {
    const json = JSON.stringify(data);   // снимок — в момент вызова, как `snapshotOf`
    db.tries.set(charId, (db.tries.get(charId) ?? 0) + 1);
    if (db.down) { db.onDown?.(); throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }); }
    await db.gate.get(charId);
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = JSON.parse(json) as SaveState;
    db.writes.push(charId);
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
  result(id: number): Extract<ServerFrame, { t: 'cmdResult' }> | undefined {
    return this.frames.find((f): f is Extract<ServerFrame, { t: 'cmdResult' }> => f.t === 'cmdResult' && f.id === id);
  }
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

type Drop = { id: number; kind: string; item?: Item; gold?: number; owner?: string; pos: { x: number; y: number }; heldBy?: string };
type Pl = { pos: { x: number; y: number }; save: SaveState; hp: number; alive: boolean };
type RoomIn = {
  code: string; area: string; movedAt: number; lastSaveAt: number; consumables: Item[]; runConfig: RunConfig | null;
  carrying: Set<unknown>;
  clients: Map<string, { tm: { items: number; gold: number } }>;
  stop(): void; step(): void; setInput(pid: string, input: PlayerInput): void;
  descend(pid: string): void; returnTown(pid: string): void; enterArena(pid: string): void; castVote(pid: string, yes: boolean): void;
  persist(pid: string): Promise<unknown>; persistAll(): Promise<unknown>; markLedger(id?: string): void;
  session: {
    saveHeld: Set<string>;
    world: { players: Record<string, Pl>; drops: Drop[]; nextId: number; spawn: { x: number; y: number }; monsters: { alive: boolean }[] };
  };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; unsaved: Map<string, unknown>; live: Map<string, unknown>;
  graceByChar: Map<string, RoomIn>;
  handleConnection(ws: GameConn): void; flushAll(budgetMs?: number): Promise<void>;
};
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
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
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync, limits.stashRead, limits.forgeCmd]) l.reset(USER);
  for (let i = 1; i <= 400; i++) { limits.wsFrames.reset(`c${i}`); limits.lobbyConn.reset(`c${i}`); }
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db.gate.clear(); db.writes = []; db.tries.clear(); db.ledgerDown = false; db.ledgerTries = 0; db.down = false; db.onDown = null;
});
afterEach(() => {
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const dims = (): { cols: number; rows: number } => cfg.get('balance').inventory;
const potion = (): Item => itemFromBaseId(cfg.get('items.base'), 'healing-potion', undefined, 'drop')!;
/** Герой в базе. `full` — сумка забита зельями 1×1 до отказа (одна клетка на вещь). */
function seed(id: string, opts: { full?: boolean } = {}): SaveState {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.gold = 50_000;
  if (opts.full) {
    s.inventory = [];
    for (;;) { const it = potion(); expect([it.gridW, it.gridH]).toEqual([1, 1]); if (!addToInventory(s.inventory, it, dims())) break; }
    expect(s.inventory).toHaveLength(dims().cols * dims().rows);
  } else {
    const sword = itemFromBaseId(cfg.get('items.base'), 'long-sword', cfg.get('item-tiers'), 'drop')!;
    s.inventory.push({ ...sword, pos: findFree(s.inventory, sword.gridW, sword.gridH, dims()) });
  }
  db.chars.set(id, { data: s, version: 1 });
  return s;
}
const row = (id: string): SaveState => db.chars.get(id)!.data;
const has = (s: SaveState, uid: string): boolean => s.inventory.some((i) => i.uid === uid);
let ipSeq = 0;
async function join(rm: RMIn, charId: string, roomCode?: string): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(roomCode ? { roomCode } : { fresh: true }) });
  await until(`${charId} ответ на вход`, () => ws.frames.some((f) => f.t === 'joined' || f.t === 'error'));
  return ws;
}
const joined = (ws: FakeConn): Extract<ServerFrame, { t: 'joined' }> => ws.frames.find((f): f is Extract<ServerFrame, { t: 'joined' }> => f.t === 'joined')!;
/** Герой вошёл один в свою комнату (город), тик — только шагами теста. */
async function solo(rm: RMIn, id: string): Promise<{ room: RoomIn; ws: FakeConn; pid: string; p: Pl }> {
  const ws = await join(rm, id);
  expect(ws.last('error'), `${id}: вход`).toBeUndefined();
  const room = rm.rooms.get(joined(ws).roomCode)!;
  room.stop();
  await until('запись входа легла', () => !rm.inflight.size && !db.gate.size && db.writes.includes(id));
  await turns(10);
  const pid = joined(ws).playerId;
  return { room, ws, pid, p: room.session.world.players[pid]! };
}
let cmdSeq = 100;
/** Выбросить вещь и дождаться записи выброса (V-B2-04: метка снята — вещь отпущена). */
async function throwOut(room: RoomIn, ws: FakeConn, p: Pl, uid: string): Promise<Drop> {
  const id = ++cmdSeq;
  ws.push({ t: 'cmd', id, command: { cmd: 'drop', uid } });
  await until('выброс записан — вещь отпущена', () => room.session.world.drops.some((d) => d.item?.uid === uid && d.heldBy === undefined));
  const d = room.session.world.drops.find((x) => x.item?.uid === uid)!;
  p.pos = { ...d.pos };
  return d;
}
/** Ворота на запись строки героя: следующая его запись (её снимок уже снят) ждёт `open()`. */
function hold(charId: string): () => void {
  let open!: () => void;
  db.gate.set(charId, new Promise<void>((r) => { open = () => { db.gate.delete(charId); r(); }; }));
  return () => open();
}
/** Сетка сумки: каждая вещь в своих клетках, внутри сетки, без наложений; вещей не больше клеток. */
function gridOk(s: SaveState, where: string): void {
  const { cols, rows } = dims();
  const taken = new Map<string, string>();
  for (const it of s.inventory) {
    expect(it.pos, `${where}: «${it.name}» без клетки`).toBeTruthy();
    const { x, y } = it.pos!;
    expect(x >= 0 && y >= 0 && x + it.gridW <= cols && y + it.gridH <= rows, `${where}: «${it.name}» вне сетки`).toBe(true);
    for (let cx = x; cx < x + it.gridW; cx++) for (let cy = y; cy < y + it.gridH; cy++) {
      const k = `${cx},${cy}`;
      expect(taken.get(k), `${where}: две вещи в клетке ${k}`).toBeUndefined();
      taken.set(k, it.uid);
    }
  }
  expect(s.inventory.length, `${where}: вещей больше клеток`).toBeLessThanOrEqual(cols * rows);
}
const idleInput: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
/** Тик дотянулся до выброшенного ([E]): `session.pickThrown` → подъём с записью (K3). */
function pressE(room: RoomIn, pid: string): void {
  room.setInput(pid, { ...idleInput, interact: true });
  room.step();
  room.setInput(pid, idleInput);
}
const onGround = (room: RoomIn, uid: string): Drop | undefined => room.session.world.drops.find((d) => d.item?.uid === uid);

describe('⭐ R16 C-01: подъём выброшенного не кладёт вещь поверх занятой клетки', () => {
  it('сумка полна, выброшено одно зелье; пока запись подъёма ([E]) в пути, клетку заняла покупка — вещь не ложится поверх, сумка не сверх ёмкости', async () => {
    const rm = manager();
    seed('R16A1', { full: true });
    const { room, ws, pid, p } = await solo(rm, 'R16A1');
    expect(room.area).toBe('town');
    const uid = p.save.inventory.at(-1)!.uid;
    const d = await throwOut(room, ws, p, uid);
    const open = hold('R16A1');
    pressE(room, pid);
    await turns(20);
    expect(room.carrying.has(d), 'подъём в пути').toBe(true);
    // Покупка зелья с прилавка — команда города, мимо очереди записей: занимает освободившуюся клетку.
    const shopPotion = room.consumables[0]!;
    ws.push({ t: 'cmd', id: ++cmdSeq, command: { cmd: 'buy', uid: shopPotion.uid } });
    const buyId = cmdSeq;
    await until('покупка ответила', () => !!ws.result(buyId));
    expect(ws.result(buyId), 'покупка прошла').toMatchObject({ ok: true });
    open();
    await until('подъём кончился', () => !room.carrying.size);
    await turns(30);
    gridOk(p.save, 'сумка');
    expect(has(p.save, uid), 'места нет — в сумку не легла').toBe(false);
    // Строка героя вещь уже держит (запись подъёма легла): на земле она — за ним, а запись без неё метку снимает (V-B2-04).
    const g = onGround(room, uid);
    expect(g, 'вещь осталась на земле').toBeDefined();
    await until('запись без вещи легла — метка снята', () => onGround(room, uid)?.heldBy === undefined && !has(row('R16A1'), uid));
    gridOk(row('R16A1'), 'строка');
  });

  it('повторяемо: подъём добычи по id во время записи подъёма выброшенного — вещей в сумке не больше клеток', async () => {
    const rm = manager();
    seed('R16A2', { full: true });
    const { room, ws, pid, p } = await solo(rm, 'R16A2');
    for (let round = 0; round < 5; round++) {
      room.session.world.drops.splice(0);   // прошлый круг — позади (иначе [E] тянется к оставшемуся на земле, а не к новому)
      const uid = p.save.inventory.find((i) => i.pos)!.uid;
      const d = await throwOut(room, ws, p, uid);
      // Добыча с земли (без хозяина) под ногами.
      const loot = potion();
      const w = room.session.world;
      w.drops.push({ id: w.nextId++, kind: 'item', pos: { ...p.pos }, item: loot });
      const lootId = w.nextId - 1;
      const open = hold('R16A2');
      pressE(room, pid);
      await turns(20);
      expect(room.carrying.has(d)).toBe(true);
      ws.push({ t: 'cmd', id: ++cmdSeq, command: { cmd: 'pickup', dropId: lootId } });
      const pickId = cmdSeq;
      await until('подъём добычи ответил', () => !!ws.result(pickId));
      open();
      await until('подъём кончился', () => !room.carrying.size);
      await until('записи легли', () => !db.gate.size && room.session.world.drops.every((x) => x.heldBy === undefined));
      gridOk(p.save, `сумка, круг ${round}`);
    }
    await room.persist(pid);
    await turns(20);
    gridOk(row('R16A2'), 'строка');
  });

  it('ушёл от вещи, пока подъём ждал очередь записей, — подъёма нет: вещь на земле, записи с ней не было', async () => {
    const rm = manager();
    seed('R16A3');
    const { room, ws, pid, p } = await solo(rm, 'R16A3');
    const sword = p.save.inventory.find((i) => i.baseId === 'long-sword')!;
    const d = await throwOut(room, ws, p, sword.uid);
    // В очереди записей героя уже стоит запись (выброс второй вещи — запись сразу), и она в пути.
    const extra = potion();
    p.save.inventory.push({ ...extra, pos: findFree(p.save.inventory, 1, 1, dims()) });
    const open = hold('R16A3');
    ws.push({ t: 'cmd', id: ++cmdSeq, command: { cmd: 'drop', uid: extra.uid } });
    await turns(20);
    pressE(room, pid);   // подъём встал в очередь за ней
    await turns(20);
    expect(room.carrying.has(d)).toBe(true);
    p.pos = { x: p.pos.x + 2000, y: p.pos.y };   // ушёл далеко
    const tries = db.tries.get('R16A3') ?? 0;
    open();
    await until('подъём кончился', () => !room.carrying.size);
    await turns(30);
    expect(has(p.save, sword.uid), 'не в сумке').toBe(false);
    expect(onGround(room, sword.uid), 'на земле').toBeDefined();
    expect(has(row('R16A3'), sword.uid), 'и не в строке').toBe(false);
    expect(db.tries.get('R16A3'), 'записи с поднимаемым не было').toBe(tries);
  });
});

describe('⭐ R16 C-04: подъём выброшенного не держит кадры и сейв героя на время записи', () => {
  it('ответ — когда запись ляжет, а следующая команда соединения, зелье пояса и переход по голосованию — сразу', async () => {
    const rm = manager();
    seed('R16B1'); seed('R16B2');
    const wsA = await join(rm, 'R16B1');
    const room = rm.rooms.get(joined(wsA).roomCode)!;
    const wsB = await join(rm, 'R16B2', room.code);
    room.stop();
    await until('записи входа легли', () => !rm.inflight.size);
    await turns(10);
    const pidA = joined(wsA).playerId, pidB = joined(wsB).playerId;
    const pB = room.session.world.players[pidB]!;
    const sword = pB.save.inventory.find((i) => i.baseId === 'long-sword')!;
    const d = await throwOut(room, wsB, pB, sword.uid);
    const open = hold('R16B2');
    wsB.push({ t: 'cmd', id: 2, command: { cmd: 'pickup', dropId: d.id } });
    // Следующая команда того же соединения (привязка пояса) — ответ, не дожидаясь записи подъёма.
    wsB.push({ t: 'cmd', id: 3, command: { cmd: 'bind', slot: 0, value: null } });
    await until('ответ на следующую команду (раньше — только после записи подъёма)', () => !!wsB.result(3), 300);
    expect(wsB.result(2), 'подъём ещё пишется — ответа нет').toBeUndefined();
    expect(room.session.saveHeld.has(pidB), 'сейв героя не на удержании').toBe(false);
    // Повтор того же номера (клиент не дождался) — не «команда уже получена», а итог оригинала, когда он будет.
    wsB.push({ t: 'cmd', id: 2, command: { cmd: 'pickup', dropId: d.id } });
    await turns(20);
    expect(wsB.result(2), 'повтору — тоже после записи').toBeUndefined();
    // Зелье пояса посреди записи подъёма — выпито сразу (раньше тик его пропускал, а нажатие снималось).
    const flask = potion();
    pB.save.belt[0] = flask;
    pB.hp = 5;
    room.setInput(pidB, { ...idleInput, useBelt: 0 });
    room.step();
    room.setInput(pidB, idleInput);
    expect(pB.save.belt[0], 'зелье выпито').toBeNull();
    // Переход по голосованию (на арену) не ждёт записи подъёма.
    room.movedAt = 0;
    room.enterArena(pidA);
    room.castVote(pidB, true);
    expect(room.area, 'переход состоялся').toBe('arena');
    open();
    await until('подъём и повтор ответили', () => wsB.frames.filter((f) => f.t === 'cmdResult' && f.id === 2).length === 2);
    expect(wsB.frames.filter((f) => f.t === 'cmdResult' && f.id === 2), 'оба ответа — итог подъёма').toEqual([
      expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true }),
    ]);
    expect(has(pB.save, sword.uid) && has(row('R16B2'), sword.uid), 'в сумке и в строке').toBe(true);
    gridOk(pB.save, 'сумка');
  });
});

describe('⭐ R16 C-12: подъём кликом — тем же путём событий, что тик', () => {
  it('добыча кликом двигает задание «собрать», золото кликом — событие и наблюдение', async () => {
    const rm = manager();
    const s = seed('R16C1');
    const base = 'healing-potion';
    const quest: QuestDef = {
      id: 'r16-collect', name: 'Собрать зелья', description: '', reward: { gold: 1 },
      objectives: [{ id: 'o1', type: 'collect-item', target: base, amount: 2 }],
    };
    s.activeQuestDefs = [...s.activeQuestDefs, quest];
    s.quests = [...s.quests, { questId: quest.id, status: 'active', counters: {} }];
    db.chars.set('R16C1', { data: s, version: 1 });
    const { room, ws, pid, p } = await solo(rm, 'R16C1');
    const w = room.session.world;
    const loot = potion();
    w.drops.push({ id: w.nextId++, kind: 'item', pos: { ...p.pos }, item: loot });
    ws.push({ t: 'cmd', id: ++cmdSeq, command: { cmd: 'pickup', dropId: w.nextId - 1 } });
    const id1 = cmdSeq;
    await until('подъём ответил', () => !!ws.result(id1));
    expect(ws.result(id1)).toMatchObject({ ok: true });
    expect(has(p.save, loot.uid)).toBe(true);
    expect(p.save.quests.find((q) => q.questId === quest.id)?.counters.o1, 'сбор засчитан').toBe(1);
    expect(room.clients.get(pid)!.tm.items, 'наблюдение: вещь поднята').toBe(1);
    w.drops.push({ id: w.nextId++, kind: 'gold', gold: 37, pos: { ...p.pos } });
    const gold0 = p.save.gold;
    const n0 = ws.frames.length;
    ws.push({ t: 'cmd', id: ++cmdSeq, command: { cmd: 'pickup', dropId: w.nextId - 1 } });
    const id2 = cmdSeq;
    await until('подъём золота ответил', () => !!ws.result(id2));
    expect(p.save.gold).toBe(gold0 + 37);
    const ev = ws.frames.slice(n0).flatMap((f) => (f.t === 'events' ? f.events : []));
    expect(ev.some((e) => e.type === 'gold' && e.amount === 37), 'событие золота дошло до клиента').toBe(true);
    expect(room.clients.get(pid)!.tm.gold, 'наблюдение: золото').toBe(37);
  });
});

describe('⭐ R16 C-03: в подземелье — только участники его забега', () => {
  it('вход по коду в подземелье чужого забега с припаркованным своим — отказ `run`, свой забег цел; без забега — вход и забег комнаты', async () => {
    const rm = manager();
    seed('R16G'); seed('R16H'); seed('R16F');
    // G паркует свой забег X: этаж соло, портал в город, закрыл вкладку в городе.
    const g1 = await solo(rm, 'R16G');
    g1.room.movedAt = 0; g1.room.descend(g1.pid);
    expect(g1.room.area).toBe('dungeon');
    g1.p.pos = { ...g1.room.session.world.spawn };
    g1.room.movedAt = 0; g1.room.returnTown(g1.pid);
    expect(g1.room.area).toBe('town');
    g1.ws.close();
    await until('G ушёл, забег припаркован в строке', () => !rm.live.has('R16G') && !rm.inflight.size && !!row('R16G').run);
    const parked = JSON.stringify(row('R16G').run);
    // H в подземелье своего забега Y.
    const h = await solo(rm, 'R16H');
    h.room.movedAt = 0; h.room.descend(h.pid);
    expect(h.room.area).toBe('dungeon');
    await until('записи спуска легли', () => !rm.inflight.size);
    // G — к H по коду: отказ с кодом `run`, в комнату не сел.
    const wsG = await join(rm, 'R16G', h.room.code);
    expect(wsG.last('joined'), 'не сел в подземелье чужого забега').toBeUndefined();
    expect(wsG.last('error'), JSON.stringify(wsG.last('error'))).toMatchObject({ code: 'run' });
    expect(h.room.clients.size, 'в комнате только H').toBe(1);
    await until('записи легли', () => !rm.inflight.size);
    expect(JSON.stringify(row('R16G').run), 'свой забег цел').toBe(parked);
    // F без забега входит по коду и становится участником забега комнаты.
    const wsF = await join(rm, 'R16F', h.room.code);
    expect(wsF.last('joined'), JSON.stringify(wsF.last('error'))).toBeDefined();
    const pF = h.room.session.world.players[joined(wsF).playerId]!;
    expect(pF.save.run?.config.id, 'забег комнаты').toBe(h.room.runConfig?.id);
  });

  // ⭐ E2E 28.09 (большой прогон фаззера коопа, сид 60995): подземелье без забега — окно вайпа (`wipe` снял забег, до города 4 с, монстры
  // этажа живы). Проверка требовала забег у комнаты и пускала гостя со своим — и уход из боя отпускался даром (`foreignRun`).
  it('окно вайпа: забег комнаты снят, этаж стоит — вход по коду со своим забегом тоже отказ `run`', async () => {
    const rm = manager();
    seed('R16W'); seed('R16V');
    const w1 = await solo(rm, 'R16W');
    w1.room.movedAt = 0; w1.room.descend(w1.pid);
    expect(w1.room.area).toBe('dungeon');
    w1.p.pos = { ...w1.room.session.world.spawn };
    w1.room.movedAt = 0; w1.room.returnTown(w1.pid);
    expect(w1.room.area).toBe('town');
    w1.ws.close();
    await until('W ушёл, забег припаркован в строке', () => !rm.live.has('R16W') && !rm.inflight.size && !!row('R16W').run);
    const parked = JSON.stringify(row('R16W').run);
    // V спускается один и гибнет смертельным ядом (весь путь «событие → штраф → вайп»): забега у комнаты нет, этаж ещё стоит.
    const v = await solo(rm, 'R16V');
    v.room.movedAt = 0; v.room.descend(v.pid);
    expect(v.room.area).toBe('dungeon');
    const world = v.room.session.world as unknown as { timeMs: number };
    v.p.hp = 1;
    (v.p as unknown as { debuffs: Record<string, unknown> }).debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: world.timeMs + 60_000, mag: 9999, mag2: 0 };
    for (let i = 0; i < 4 && v.p.alive; i++) v.room.step();
    expect(v.p.alive, 'V погиб').toBe(false);
    expect([v.room.area, v.room.runConfig], 'окно вайпа: подземелье без забега').toEqual(['dungeon', null]);
    await until('записи смерти легли', () => !rm.inflight.size);
    const wsW = await join(rm, 'R16W', v.room.code);
    expect(wsW.last('joined'), 'не сел в подземелье без его забега').toBeUndefined();
    expect(wsW.last('error'), JSON.stringify(wsW.last('error'))).toMatchObject({ code: 'run' });
    expect(v.room.clients.size, 'в комнате только V').toBe(1);
    await until('записи легли', () => !rm.inflight.size);
    expect(JSON.stringify(row('R16W').run), 'свой забег цел').toBe(parked);
  });
});

describe('⭐ R16 C-06: очередь записей героя при лежащей базе', () => {
  it('автосейв не множит записи: пока одна ждёт очереди, новые к ней не добавляются', async () => {
    const rm = manager();
    seed('R16D1');
    const { room, pid } = await solo(rm, 'R16D1');
    const open = hold('R16D1');
    void room.persist(pid);   // запись в пути (ворота)
    await turns(10);
    const tries0 = db.tries.get('R16D1') ?? 0;
    for (let i = 0; i < 8; i++) { void room.persistAll(); await turns(2); }
    open();
    await until('очередь пуста', () => !db.gate.size);
    await turns(50);
    expect((db.tries.get('R16D1') ?? 0) - tries0, 'за записью в пути — одна слитая, а не восемь').toBeLessThanOrEqual(1);
  });

  it('свод забега не лёг `LEDGER_FIRST_ROUNDS` раз подряд — следующие записи сейва не ставят ему новых кругов с ожиданием базы', async () => {
    const rm = manager();
    seed('R16D2');
    const { room, pid } = await solo(rm, 'R16D2');
    room.movedAt = 0; room.descend(pid);
    expect(room.area).toBe('dungeon');
    await until('записи спуска легли', () => !rm.inflight.size);
    await turns(30);
    db.ledgerDown = true;
    room.markLedger();   // свод забега изменился — запись сейва героя сперва его дописывает (K2)
    const v0 = db.chars.get('R16D2')!.version;
    await room.persist(pid);
    const first = db.ledgerTries;
    expect(first, 'первая запись — круги свода, как прежде').toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 4; i++) await room.persist(pid);
    expect(db.ledgerTries, 'следующие — без новых кругов: база только что их не приняла').toBe(first);
    expect(db.chars.get('R16D2')!.version, 'строка не обогнала свод').toBe(v0);
    // База вернулась: чекпойнт дописывает свод, и запись сейва ложится.
    db.ledgerDown = false;
    await room.persistAll();
    await until('автосейв лёг', () => db.chars.get('R16D2')!.version > v0);
  });
});

describe('⭐ R16-01: вход без «Продолжить» не бросает забег за штраф', () => {
  /** Герой спустился один и ушёл обрывом из подземелья: грейс, в строке — забег. */
  async function dropped(rm: RMIn, id: string): Promise<{ room: RoomIn; before: SaveState }> {
    seed(id);
    const u = await solo(rm, id);
    u.room.movedAt = 0; u.room.descend(u.pid);
    expect(u.room.area).toBe('dungeon');
    await until('записи спуска легли', () => !rm.inflight.size);
    u.ws.close();
    await until('в грейсе, прощальная запись легла', () => rm.graceByChar.get(id) === u.room && !rm.inflight.size);
    const before = structuredClone(row(id));
    expect(before.run, 'забег в строке').toBeTruthy();
    return { room: u.room, before };
  }
  const kit = (s: SaveState): string[] =>
    [...s.inventory.map((i) => i.uid), ...Object.values(s.equipment).filter((i): i is Item => !!i).map((i) => i.uid)].sort();

  it('Unity: статус забега и `join{fresh}` подряд, не читая ответа, — отказ `run`: золото, вещи и забег целы, грейс ждёт; «Продолжить» — в ту же комнату', async () => {
    const rm = manager();
    const { room, before } = await dropped(rm, 'R16U1');
    const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
    rm.handleConnection(ws);
    // `NetClient.Connect` Unity: статус забега и вход «Соло» — подряд, ответ на статус не читается.
    ws.push({ t: 'runStatus', token: TOK, charId: 'R16U1' });
    ws.push({ t: 'join', token: TOK, charId: 'R16U1', fresh: true });
    await until('ответ на вход', () => ws.frames.some((f) => f.t === 'joined' || f.t === 'error'));
    expect(ws.last('runStatus'), 'статус: забег есть').toMatchObject({ hasRun: true });
    expect(ws.last('joined'), 'в новую комнату не вошёл').toBeUndefined();
    expect(ws.last('error'), JSON.stringify(ws.last('error'))).toMatchObject({ code: 'run' });
    await turns(30);
    expect(rm.inflight.size, 'записей в пути нет').toBe(0);
    const after = row('R16U1');
    expect(after.gold, 'золото цело').toBe(before.gold);
    expect(kit(after), 'вещи целы').toEqual(kit(before));
    expect(after.run, 'забег цел').toEqual(before.run);
    expect(rm.graceByChar.get('R16U1'), 'грейс ждёт реконнекта').toBe(room);
    // «Продолжить» — в ту же грейс-комнату.
    ws.push({ t: 'join', token: TOK, charId: 'R16U1', resume: true });
    await until('вернулся', () => !!ws.last('joined'));
    expect(joined(ws).roomCode).toBe(room.code);
    expect(room.area).toBe('dungeon');
  });

  it('вход по коду к другу — тот же отказ; бросить забег за штраф — только «Завершить», после него «Соло» входит', async () => {
    const rm = manager();
    const { before } = await dropped(rm, 'R16U2');
    seed('R16U3');
    const friend = await solo(rm, 'R16U3');
    const byCode = await join(rm, 'R16U2', friend.room.code);
    expect(byCode.last('joined'), 'к другу не сел').toBeUndefined();
    expect(byCode.last('error'), JSON.stringify(byCode.last('error'))).toMatchObject({ code: 'run' });
    expect(friend.room.clients.size, 'у друга он один').toBe(1);
    await turns(30);
    expect(row('R16U2').gold, 'золото цело').toBe(before.gold);
    expect(row('R16U2').run, 'забег цел').toEqual(before.run);
    // «Завершить» — явный бросок: штраф, забег снят.
    const ab = new FakeConn(`198.51.100.${++ipSeq % 250}`);
    rm.handleConnection(ab);
    ab.push({ t: 'abandon', token: TOK, charId: 'R16U2' });
    await until('брошен', () => !!ab.last('abandoned') || !!ab.last('error'));
    expect(ab.last('abandoned'), JSON.stringify(ab.last('error'))).toBeDefined();
    await until('штраф лёг', () => !rm.inflight.size && !rm.graceByChar.has('R16U2'));
    expect(row('R16U2').gold, '«Завершить» штрафует').toBeLessThan(before.gold);
    expect(row('R16U2').run).toBeUndefined();
    const fresh = await join(rm, 'R16U2');
    expect(fresh.last('joined'), JSON.stringify(fresh.last('error'))).toBeDefined();
  });

  it('страховка без штрафа цела: погибший в коопе (смерть оплачена) — `join{fresh}` входит в город, забег снят без второго штрафа', async () => {
    const rm = manager();
    seed('R16K1'); seed('R16K2');
    const a = await solo(rm, 'R16K1');
    const wsB = await join(rm, 'R16K2', a.room.code);
    const pidB = joined(wsB).playerId;
    a.room.movedAt = 0; a.room.descend(a.pid); a.room.castVote(pidB, true);
    expect(a.room.area).toBe('dungeon');
    await until('записи спуска легли', () => !rm.inflight.size);
    const pb = a.room.session.world.players[pidB]!;
    const world = a.room.session.world as unknown as { timeMs: number };
    pb.hp = 1;
    (pb as unknown as { debuffs: Record<string, unknown> }).debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: world.timeMs + 60_000, mag: 9999, mag2: 0 };
    for (let i = 0; i < 4 && pb.alive; i++) a.room.step();
    expect(pb.alive, 'B погиб, ждёт пати').toBe(false);
    wsB.close();
    await until('B в грейсе, записи легли', () => rm.graceByChar.get('R16K2') === a.room && !rm.inflight.size);
    const paid = row('R16K2').gold;
    const ws = await join(rm, 'R16K2');
    expect(ws.last('joined'), JSON.stringify(ws.last('error'))).toBeDefined();
    expect(joined(ws).roomCode).not.toBe(a.room.code);
    await until('записи легли', () => !rm.inflight.size);
    expect(row('R16K2').gold, 'второго штрафа нет').toBe(paid);
    expect(row('R16K2').run, 'забег снят').toBeUndefined();
  });
});

describe('⭐ R16-06: бюджет слива — по часам процесса', () => {
  /**
   * Герой вышел из города, база лежит — копия ждёт дописки (`unsaved`); слив с бюджетом `budget`, и на первом же сбое записи настенные
   * часы шагают на `stepMs`. Сколько слив шёл по часам процесса, сколько раз пробовал и сказал ли ИНЦИДЕНТ.
   */
  async function drainWithStep(id: string, stepMs: number, budget = 2_000): Promise<{ took: number; incident: boolean; tries: number }> {
    const rm = manager();
    seed(id);
    const { ws } = await solo(rm, id);
    db.down = true;
    ws.close();
    await until('копия не легла — ждёт дописки', () => rm.unsaved.has(id) && !rm.inflight.size);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    let stepped = false;
    db.onDown = () => { if (!stepped) { stepped = true; vi.setSystemTime(Date.now() + stepMs); } };
    const tries0 = db.tries.get(id) ?? 0;
    const t0 = performance.now();
    let doneAt: number | undefined;
    void rm.flushAll(budget).then(() => { doneAt = performance.now(); });
    for (let i = 0; i < 400 && doneAt === undefined; i++) await vi.advanceTimersByTimeAsync(50);
    expect(stepped, 'часы шагнули посреди слива').toBe(true);
    const incident = vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes(`слив не дописал героя ${id}`));
    return { took: (doneAt ?? Infinity) - t0, incident, tries: (db.tries.get(id) ?? 0) - tries0 };
  }

  it('часы шагнули на минуту назад — слив кончается с бюджетом по часам процесса (не на минуту позже, за предохранителем ноды), с ИНЦИДЕНТОМ', async () => {
    const r = await drainWithStep('R16S1', -60_000);
    expect(r.took, 'в бюджет, а не на минуту дольше').toBeLessThanOrEqual(2_600);
    expect(r.took).toBeGreaterThanOrEqual(1_500);
    expect(r.incident, 'недописанное — ИНЦИДЕНТ').toBe(true);
  });

  it('часы шагнули на минуту вперёд — слив не бросает дописку сразу: круги идут весь бюджет', async () => {
    const r = await drainWithStep('R16S2', 60_000);
    expect(r.took, 'весь бюджет').toBeGreaterThanOrEqual(1_500);
    expect(r.took).toBeLessThanOrEqual(2_600);
    expect(r.tries, 'кругов дописки больше одного').toBeGreaterThan(1);
    expect(r.incident).toBe(true);
  });
});
