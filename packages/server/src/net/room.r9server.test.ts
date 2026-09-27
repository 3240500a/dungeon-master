import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave,
  type ServerFrame, type SaveState, type RunPlan, type RunNode,
} from '@dm/shared';
import { limits } from './rateLimit.js';

// Тесты файла ждут комнату оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый такой оборот — шаг системного
// таймера (~15,6 мс). Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот потолок не прячет — они падают
// утверждением, а не временем.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Раунд 9 (сервер): то, что правка сервера обязана довезти через настоящую `Room` — отключившийся посреди боя, которого пати
 * унесла спуском, на новом узле уже не «сбежавший» (R9-07); вернувшийся со стойкой +жизни — с тем здоровьем, с каким ушёл
 * (R9-14); доска квестов стока — та же на любой ноде, как и снаряжение (R9-13); окно спуска из города говорит, что начнётся,
 * и начнётся ровно это (R9-08). Сокет — фейковый, база — маленькая честная (версии сейва).
 */
const db = vi.hoisted(() => ({
  /** charId → версия сейва в «базе». Нет записи — 1 (так персонажа отдаёт вход в тестах). */
  saves: new Map<string, number>(),
  /** charId → последний записанный сейв. */
  data: new Map<string, SaveState>(),
  /** R9-01: свод записей забегов (как `run_ledger`): ключ → узел → запись (списки объединением, мощь — первой записи). */
  ledger: new Map<string, Map<string, { id: string; el: number; chests: number[]; killed: number[]; levers: number[] }>>(),
  /** R9-01: следующее чтение свода откажет (база не ответила). */
  ledgerDown: false,
}));
vi.mock('../db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    const snap = structuredClone(data);          // снимок в момент вызова — как и настоящая запись
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve(null);
    db.saves.set(charId, v + 1);
    db.data.set(charId, snap);
    return Promise.resolve(v + 1);
  },
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: (charId: string) => {
    const d = db.data.get(charId);
    return Promise.resolve(d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.saves.get(charId) ?? 1 } : null);
  },
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
  getRunLedger: (key: string) => {
    if (db.ledgerDown) { db.ledgerDown = false; return Promise.reject(new Error('connection terminated')); }
    return Promise.resolve([...(db.ledger.get(key)?.values() ?? [])].map((r) => structuredClone(r)));
  },
  mergeRunLedger: (key: string, recs: { id: string; el: number; chests: number[]; killed: number[]; levers: number[] }[]) => {
    let run = db.ledger.get(key);
    if (!run) db.ledger.set(key, (run = new Map()));
    const u = (a: number[], b: number[]): number[] => [...new Set([...a, ...b])].sort((x, y) => x - y);
    for (const r of recs) {
      const cur = run.get(r.id);
      run.set(r.id, cur ? { ...cur, chests: u(cur.chests, r.chests), killed: u(cur.killed, r.killed), levers: u(cur.levers, r.levers) } : structuredClone(r));
    }
    return Promise.resolve();
  },
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Room = import('./room.js').Room;
let RoomCtor: typeof import('./room.js').Room;
let forgetTownStocks: typeof import('./room.js').forgetTownStocks;
let runLedgerKey: typeof import('./room.js').runLedgerKey;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor, forgetTownStocks, runLedgerKey } = await import('./room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: Room[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const r of rooms.splice(0)) r.stop();
});

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void { /* комнату дёргают напрямую */ }
  onClose(): void { /* не проверяется */ }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
  all<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }>[] {
    return this.frames.filter((f) => f.t === t) as Extract<ServerFrame, { t: T }>[];
  }
}

type Pt = { x: number; y: number };
type Mon = { alive: boolean; hp: number; pos: Pt; aiState: string };
type Ply = { pos: Pt; hp: number; maxHp: number; mana: number; alive: boolean; toggles: string[]; debuffs: Record<string, unknown>; save: SaveState };
/** Внутренности комнаты, до которых тесту приходится дотягиваться (это тест). */
type RoomIn = {
  area: string; movedAt: number; runPlan: RunPlan | null; runNodeId: string | null;
  vote: unknown;
  decor: { kind: string; x: number; y: number }[];
  disconnected: Map<string, { fled: boolean; fledDescend: boolean; safe?: boolean }>;
  session: {
    world: { timeMs: number; spawn: Pt; exits?: Pt[]; monsters: Mon[]; players: Record<string, Ply> };
  };
};
const inner = (room: Room): RoomIn => room as unknown as RoomIn;
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
/**
 * R9-01: продолжение из города ждёт свод забега из базы (у мока — готовые промисы): дождаться одних микрозадач, без оборотов
 * таймеров — планировщик не успевает сдвинуть мир.
 */
const drained = async (): Promise<void> => { for (let i = 0; i < 500; i++) await Promise.resolve(); };
const ready = (room: Room): void => { inner(room).movedAt = 0; };
let seq = 0;

/** Герой в «базе» (версия 1) со своим аккаунтом `user-<charId>`. */
function hero(level: number, gold = 10_000): { save: SaveState; userId: string } {
  const charId = `char-r9s-${++seq}`;
  const uid = `user-${charId}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(uid);
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, `H${seq}`, charId);
  s.level = level;
  s.gold = gold;
  db.saves.set(charId, 1);
  db.data.set(charId, structuredClone(s));
  return { save: s, userId: uid };
}
function newRoom(code = 'R9S'): Room {
  const room = new RoomCtor(code, cfg, { onEmpty() {}, onGrace() {}, onUngrace() {}, onFarewell() {} });
  rooms.push(room);
  return room;
}
function join(room: Room, h: { save: SaveState; userId: string }, save = h.save): { ws: FakeWs; pid: string } {
  const ws = new FakeWs();
  const pid = room.addPlayer(ws as unknown as GameConn, h.userId, save, db.saves.get(save.charId) ?? 1);
  return { ws, pid };
}
const nodeOf = (plan: RunPlan, id: string): RunNode => plan.nodes.find((n) => n.id === id)!;
const nodeNow = (room: Room): RunNode => nodeOf(inner(room).runPlan!, inner(room).runNodeId!);
/** Встать к выходу ребра на узел `to`. */
function toExit(room: Room, pid: string, to: string): void {
  const r = inner(room);
  const i = Math.max(0, nodeNow(room).edges.findIndex((e) => e.to === to));
  const at = r.session.world.exits![i]!;
  r.session.world.players[pid]!.pos = { x: at.x, y: at.y };
}
const toSpawn = (room: Room, pid: string): void => { const w = inner(room).session.world; w.players[pid]!.pos = { ...w.spawn }; };
const noMonsters = (room: Room): void => { for (const m of inner(room).session.world.monsters) m.alive = false; };
/** Спуск по первому ребру от выхода: пати `pids` (первый зовёт) — все у выхода. */
function descendNext(room: Room, pids: string[]): string {
  const to = nodeNow(room).edges[0]!.to;
  for (const pid of pids) toExit(room, pid, to);
  ready(room);
  room.descend(pids[0]!, undefined, to);
  for (const pid of pids.slice(1)) room.castVote(pid, true);
  expect(inner(room).runNodeId).toBe(to);
  noMonsters(room);
  return to;
}

describe('⭐ R9-07: унесённый спуском отключившийся на новом узле — не «сбежавший из боя»', () => {
  /** Пати A+B спустилась; у A 1 HP, рядом монстр гонится за ним, A стоит у выхода 0 (там «за» спуск ему засчитали бы). */
  async function carried(code: string): Promise<{ room: Room; b: string; A: SaveState }> {
    const room = newRoom(code);
    const ha = hero(1), hb = hero(1);
    const a = join(room, ha).pid, b = join(room, hb).pid;
    ready(room);
    room.descend(a);
    room.castVote(b, true);
    expect(inner(room).area).toBe('dungeon');
    const w = inner(room).session.world;
    w.players[b]!.pos = { ...w.spawn };
    const p = w.players[a]!;
    p.pos = { ...w.exits![0]! }; p.hp = 1;
    const mon = w.monsters.find((x) => x.alive)!;
    mon.pos = { ...w.exits![0]! }; mon.aiState = 'chase';
    await room.removePlayer(a);
    await settle();
    expect(inner(room).disconnected.get(ha.save.charId), 'загнан: в город — бегство, спуском — нет').toMatchObject({ fled: true, fledDescend: false });
    descendNext(room, [b]);                                  // напарник уносит его на новый узел (R8-07)
    await settle();
    expect(db.data.get(ha.save.charId)!.gold, 'спуск его не хоронит').toBe(10_000);
    return { room, b, A: ha.save };
  }

  it('на новом узле напарник спокойно уходит в город от портала — унесённого не хоронят: без штрафа, забег припаркован', async () => {
    const { room, b, A } = await carried('R9SA');
    toSpawn(room, b);
    ready(room);
    room.returnTown(b);
    expect(inner(room).area).toBe('town');
    await settle();
    expect(db.data.get(A.charId)!.gold, 'штрафа нет').toBe(10_000);
    expect(db.data.get(A.charId)!.run, 'забег припаркован').toBeTruthy();
    expect(inner(room).disconnected.get(A.charId), 'ждёт — как вышедший из города').toMatchObject({ safe: true });
  });

  it('напарник доходит до финала и завершает забег — унесённому забег снимается без штрафа', async () => {
    const { room, b, A } = await carried('R9SB');
    while (nodeNow(room).edges.length > 0) descendNext(room, [b]);
    const portal = inner(room).decor.find((d) => d.kind === 'portal')!;
    inner(room).session.world.players[b]!.pos = { x: portal.x, y: portal.y };
    ready(room);
    room.descend(b);
    expect(inner(room).area).toBe('town');
    await settle();
    expect(db.data.get(A.charId)!.gold, 'штрафа нет').toBe(10_000);
    expect(db.data.get(A.charId)!.run, 'забег окончен').toBeUndefined();
  });

  it('контроль (R8-07): загнанный на ЭТОМ узле у портала входа — спуск напарника его хоронит', async () => {
    const room = newRoom('R9SC');
    const ha = hero(1), hb = hero(1);
    const a = join(room, ha).pid, b = join(room, hb).pid;
    ready(room);
    room.descend(a);
    room.castVote(b, true);
    const w = inner(room).session.world;
    const p = w.players[a]!;
    p.pos = { ...w.spawn }; p.hp = 1;
    const mon = w.monsters.find((x) => x.alive)!;
    mon.pos = { ...w.spawn }; mon.aiState = 'chase';
    await room.removePlayer(a);
    await settle();
    descendNext(room, [b]);
    await settle();
    expect(db.data.get(ha.save.charId)!.gold).toBeLessThan(10_000);
  });
});

describe('⭐ R9-14: вернувшийся со стойкой +жизни — с тем здоровьем, с каким ушёл', () => {
  const STANCE = 'b-stance-a5';
  /** Воин 40-го уровня со стойкой +15% жизни, стойка включена, здоровье полное (с ней). */
  function stanced(room: Room): { h: { save: SaveState; userId: string }; pid: string } {
    const h = hero(40);
    h.save.skills[STANCE] = 1;
    const { pid } = join(room, h);
    room.setInput(pid, { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: STANCE, interact: false });
    room.step(false);
    const p = inner(room).session.world.players[pid]!;
    expect(p.toggles, 'стойка включена').toContain(STANCE);
    room.step(false);
    p.hp = p.maxHp;
    return { h, pid };
  }
  const player = (room: Room, pid: string): Ply => inner(room).session.world.players[pid]!;

  it('город: вышел с полным здоровьем при стойке, вошёл снова — после тика здоровье полное со стойкой', async () => {
    const room = newRoom('R9SD');
    join(room, hero(5));                                   // держит комнату живой
    const { h, pid } = stanced(room);
    const left = { hp: player(room, pid).hp, maxHp: player(room, pid).maxHp };
    await room.removePlayer(pid);
    await settle();
    const back = join(room, h).pid;
    room.step(false);
    const q = player(room, back);
    expect(q.toggles).toContain(STANCE);
    expect(q.maxHp).toBe(left.maxHp);
    expect(q.hp, `было ${left.hp} из ${left.maxHp}`).toBeCloseTo(left.hp, 1);
  });

  it('подземелье: обрыв и реконнект — здоровье со стойкой не срезается до базового максимума', async () => {
    const room = newRoom('R9SE');
    const other = join(room, hero(40)).pid;
    const { h, pid } = stanced(room);
    ready(room);
    room.descend(pid);
    room.castVote(other, true);
    expect(inner(room).area).toBe('dungeon');
    noMonsters(room);
    const p = player(room, pid);
    room.step(false);
    p.hp = p.maxHp;
    const left = { hp: p.hp, maxHp: p.maxHp };
    await room.removePlayer(pid);
    await settle();
    const ws = new FakeWs();
    const back = room.reconnect(ws as unknown as GameConn, h.userId, structuredClone(db.data.get(h.save.charId)!), db.saves.get(h.save.charId)!);
    room.step(false);
    const q = player(room, back);
    expect(q.toggles).toContain(STANCE);
    expect(q.hp, `было ${left.hp} из ${left.maxHp}`).toBeCloseTo(left.hp, 1);
  });

  it('контроль (R4-06): ушёл с 40% здоровья — вернулся с 40%, а не с полным', async () => {
    const room = newRoom('R9SF');
    join(room, hero(5));
    const { h, pid } = stanced(room);
    const p = player(room, pid);
    p.hp = p.maxHp * 0.4;
    const hp = p.hp;
    await room.removePlayer(pid);
    await settle();
    const back = join(room, h).pid;
    room.step(false);
    expect(player(room, back).hp).toBeLessThan(hp + 1);
    expect(player(room, back).hp).toBeGreaterThan(hp - 1);
  });

  it('контроль: ушёл со стойкой, а максимум с тех пор упал (стойку сбросили) — выше нового максимума здоровья нет', async () => {
    const room = newRoom('R9SG');
    join(room, hero(5));
    const { h, pid } = stanced(room);
    await room.removePlayer(pid);
    await settle();
    delete h.save.skills[STANCE];                           // сброс скилов в другой комнате: стойки больше нет
    const back = join(room, h).pid;
    room.step(false);
    const q = player(room, back);
    expect(q.toggles).not.toContain(STANCE);
    expect(q.hp).toBeLessThanOrEqual(q.maxHp);
  });
});

/**
 * ⭐ R9-13: ДОСКА КВЕСТОВ СТОКА — ТА ЖЕ НА ЛЮБОЙ НОДЕ, КАК И СНАРЯЖЕНИЕ (R5-22). Снаряжение собиралось из сида стока в сейве, а
 * доска на ноде без кэша катилась заново: вошёл к альту по коду на соседней ноде — и выбирай лучшую из N досок того же
 * поколения (квота R3-10 не даёт взять шаблон дважды, но не мешает выбрать, какой бросок взять).
 */
describe('⭐ R9-13: доска квестов собирается из опознания стока, а не катается заново на другой ноде', () => {
  type Q = { id: string; objectives: unknown; reward: unknown };
  const boardOf = (ws: FakeWs): Q[] => (ws.last('questBoard')!.quests as Q[]).map(({ id, objectives, reward }) => ({ id, objectives, reward }));
  /** «Другая нода»: кэш стоков процесса пуст, как у отдельного процесса или после рестарта (шов R5-22). */
  function onOtherNode(save: SaveState, userId: string): { room: Room; ws: FakeWs; pid: string } {
    forgetTownStocks();
    const room = newRoom('R9SN');
    const ws = new FakeWs();
    const pid = room.addPlayer(ws as unknown as GameConn, userId, save, db.saves.get(save.charId) ?? 1);
    return { room, ws, pid };
  }

  it('шесть входов на «другие ноды» — одна и та же доска (id, цели, награды); вырос уровень — доска та же; вышел срок — новая', async () => {
    const T0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const h = hero(10);
    const first = onOtherNode(h.save, h.userId);
    const board = boardOf(first.ws);
    expect(board.length, 'на доске есть задания').toBeGreaterThan(0);
    await first.room.removePlayer(first.pid);
    await settle();
    for (let i = 0; i < 5; i++) {
      const n = onOtherNode(structuredClone(db.data.get(h.save.charId)!), h.userId);
      expect(boardOf(n.ws), `вход ${i + 2}: та же доска`).toEqual(board);
      await n.room.removePlayer(n.pid);
      await settle();
    }
    const up = structuredClone(db.data.get(h.save.charId)!);
    up.level += 5;                                          // R3-17: снаряжение перекатится, доска и срок — прежние
    const grown = onOtherNode(up, h.userId);
    expect(boardOf(grown.ws), 'вырос уровень — доска та же').toEqual(board);
    await grown.room.removePlayer(grown.pid);
    await settle();
    const again = onOtherNode(structuredClone(db.data.get(h.save.charId)!), h.userId);
    expect(boardOf(again.ws), 'и после перекатки снаряжения — та же на новой ноде').toEqual(board);
    await again.room.removePlayer(again.pid);
    await settle();
    vi.setSystemTime(T0 + cfg.get('balance').townRestockSec * 1000 + 1);
    const later = onOtherNode(structuredClone(db.data.get(h.save.charId)!), h.userId);
    expect(boardOf(later.ws), 'срок вышел — новая доска').not.toEqual(board);
  });
});

/**
 * ⭐ R9-08: ОКНО СПУСКА ИЗ ГОРОДА ГОВОРИТ, ЧТО НАЧНЁТСЯ. Кадр `voteStart` нёс только «спуск», и оба веб-клиента спрашивали
 * «Спуск на след. этаж?»: зовущий с открытым «кошмаром» звал «кошмар» по «глубокой экспедиции», а принявшие входили в тир,
 * которого не открывали и не выбирали; продолжится ли чей-то припаркованный забег — тоже не видно.
 */
describe('⭐ R9-08: окно спуска из города — тир, шаблон, биом, модификаторы и продолжение; начнётся ровно показанное', () => {
  /** Герой с открытыми тирами до «кошмара». */
  function veteran(): { save: SaveState; userId: string } {
    const h = hero(40);
    h.save.difficultyProgress = { easy: 20, normal: 20, hard: 20 };
    return h;
  }

  it('новый забег: окно принявшего — «кошмар», «глубокая экспедиция», биом и модификаторы; начался ровно он', () => {
    const room = newRoom('R9SH');
    const a = join(room, veteran()), b = join(room, hero(1));
    ready(room);
    room.descend(a.pid, 'nightmare', undefined, { templateId: 'deep-expedition' });
    const f = b.ws.last('voteStart')!;
    expect(f).toMatchObject({ kind: 'descend', difficultyId: 'nightmare', templateId: 'deep-expedition', modifiers: [] });
    expect(typeof f.biomeId, 'биом — решённый сервером').toBe('string');
    expect(f.resume, 'новый забег, а не продолжение').toBeUndefined();
    room.castVote(b.pid, true);
    expect(inner(room).area).toBe('dungeon');
    const run = inner(room).session.world.players[b.pid]!.save.run!.config;
    expect({ tier: run.tier, templateId: run.templateId, biomeId: run.biomeId }).toEqual({ tier: 'nightmare', templateId: 'deep-expedition', biomeId: f.biomeId });
  });

  it('припаркованный забег: окно — «продолжение» с именем хозяина и глубиной, тир — тир его забега, а не выбор зовущего', async () => {
    const first = newRoom('R9SI');
    const hp = hero(5), hq = hero(5);
    const p = join(first, hp), q = join(first, hq);
    ready(first);
    first.descend(p.pid, 'easy');
    first.castVote(q.pid, true);
    noMonsters(first);
    descendNext(first, [p.pid, q.pid]);
    const depth = nodeNow(first).depth;
    toSpawn(first, p.pid); toSpawn(first, q.pid);
    ready(first);
    first.returnTown(p.pid);
    first.castVote(q.pid, true);
    expect(inner(first).area).toBe('town');
    await first.removePlayer(p.pid);
    await settle();
    const parked = structuredClone(db.data.get(hp.save.charId)!);
    expect(parked.run?.config.tier).toBe('easy');
    const room = newRoom('R9SJ');
    const host = join(room, hp, parked);
    const c = join(room, veteran());
    ready(room);
    room.descend(c.pid, 'nightmare');
    expect(c.ws.last('voteStart')).toMatchObject({ kind: 'descend', difficultyId: 'easy', resume: { host: parked.name, depth } });
    room.castVote(host.pid, true);
    await drained();   // R9-01: продолжение из города — после чтения свода забега из базы
    expect(inner(room).area).toBe('dungeon');
    expect(inner(room).session.world.players[c.pid]!.save.run!.config.tier, 'начался показанный забег').toBe('easy');
  });

  it('пока голосовали, вошёл герой с припаркованным забегом (спуск продолжил бы ЕГО) — голосование отменяется, а не проходит вслепую', async () => {
    const first = newRoom('R9SK');
    const hd = hero(5), he = hero(5);
    const d0 = join(first, hd), e0 = join(first, he);
    ready(first);
    first.descend(d0.pid, 'easy');
    first.castVote(e0.pid, true);
    toSpawn(first, d0.pid); toSpawn(first, e0.pid);
    noMonsters(first);
    ready(first);
    first.returnTown(d0.pid);
    first.castVote(e0.pid, true);
    await first.removePlayer(d0.pid);
    await settle();
    const parked = structuredClone(db.data.get(hd.save.charId)!);
    expect(parked.run).toBeTruthy();

    const room = newRoom('R9SL');
    const a = join(room, veteran()), b = join(room, hero(1));
    ready(room);
    room.descend(a.pid, 'nightmare');
    expect(b.ws.last('voteStart')).toMatchObject({ difficultyId: 'nightmare' });
    const d = join(room, hd, parked);                        // вошёл по коду посреди голосования (R8-08: ему — то же окно)
    room.castVote(b.pid, true);
    room.castVote(d.pid, true);
    expect(inner(room).area, 'показанный «новый кошмар» уже не то, что начнётся, — перехода нет').toBe('town');
    expect(b.ws.last('voteEnd')).toEqual({ t: 'voteEnd', passed: false });
    expect(b.ws.all('error').map((x) => x.code)).toContain('vote');
    ready(room);
    room.descend(a.pid, 'nightmare');
    expect(b.ws.last('voteStart'), 'новое окно — честное: продолжение забега вошедшего').toMatchObject({ difficultyId: 'easy', resume: { host: parked.name } });
  });
});

/**
 * ⭐ R9-01: СВОД ЗАПИСЕЙ ЗАБЕГА УХОДИТ В БАЗУ ДО ТОГО, КАК КОПИИ СНИМУТСЯ. Финал выбрасывает копии подключённых сразу: сундук,
 * открытый на финале за секунду до портала, жил только в них — и старая копия ушедшего раньше собирала финал свежим.
 */
describe('⭐ R9-01: комната пишет свод записей забега в базу — и финал не уносит взятое на нём', () => {
  it('открыл сундук финала и сразу ушёл порталом — сундук в своде базы под ключом забега', async () => {
    const room = newRoom('R9SM');
    const hb = hero(30);
    const b = join(room, hb).pid;
    ready(room);
    room.descend(b);
    noMonsters(room);
    const cfgRun = structuredClone(inner(room).session.world.players[b]!.save.run!.config);
    expect(typeof cfgRun.id, 'у нового забега — личность').toBe('string');
    while (nodeNow(room).edges.length > 0) descendNext(room, [b]);
    const finale = inner(room).runNodeId!;
    const w = inner(room).session.world as unknown as { chests: { id: number; pos: Pt; opened: boolean }[]; players: Record<string, Ply> };
    const chest = w.chests[0]!;
    w.players[b]!.pos = { ...chest.pos };
    room.openChest(b, chest.id);
    expect(chest.opened).toBe(true);
    const portal = inner(room).decor.find((d) => d.kind === 'portal')!;
    w.players[b]!.pos = { x: portal.x, y: portal.y };
    ready(room);
    room.descend(b);
    expect(inner(room).area, 'финал пройден — в городе').toBe('town');
    expect(inner(room).session.world.players[b]!.save.run, 'копия снята').toBeUndefined();
    await settle();
    expect(db.ledger.get(runLedgerKey(cfgRun))?.get(finale)?.chests, 'взятое на финале — в своде забега').toContain(chest.id);
  });

  it('«якорь» всё это время стоял в городской комнате: продолжение там читает свод из базы — узел, взятый без него, взят', async () => {
    const r1 = newRoom('R9SN1');
    const ha = hero(30), hb = hero(30);
    const a = join(r1, ha).pid, b = join(r1, hb).pid;
    ready(r1);
    r1.descend(a);
    r1.castVote(b, true);
    noMonsters(r1);
    const d = descendNext(r1, [a, b]);
    toSpawn(r1, a); toSpawn(r1, b);
    ready(r1);
    r1.returnTown(a);
    r1.castVote(b, true);
    expect(inner(r1).area).toBe('town');
    await r1.removePlayer(b);                                // B уходит из города, A стоит в комнате со своей копией
    await settle();

    // B продолжает в другой комнате, берёт сундук глубже и уходит; его копия больше не нужна.
    const r2 = newRoom('R9SN2');
    const b2 = join(r2, hb, structuredClone(db.data.get(hb.save.charId)!)).pid;
    ready(r2);
    r2.descend(b2);
    await drained();
    expect(inner(r2).runNodeId).toBe(d);
    noMonsters(r2);
    const deep = descendNext(r2, [b2]);
    const w2 = inner(r2).session.world as unknown as { chests: { id: number; pos: Pt; opened: boolean }[]; players: Record<string, Ply> };
    const chest = w2.chests[0]!;
    w2.players[b2]!.pos = { ...chest.pos };
    r2.openChest(b2, chest.id);
    expect(chest.opened).toBe(true);
    await r2.removePlayer(b2);
    await settle();

    // B без забега входит к A по коду; A зовёт спуск — продолжение его копии, прочитанной ДО прохода B.
    const bare = structuredClone(db.data.get(hb.save.charId)!);
    delete bare.run;
    const b3 = join(r1, hb, bare).pid;
    ready(r1);
    r1.descend(a);
    r1.castVote(b3, true);
    await drained();
    expect(inner(r1).runNodeId).toBe(d);
    noMonsters(r1);
    expect(descendNext(r1, [a, b3])).toBe(deep);
    const w1 = inner(r1).session.world as unknown as { chests: { id: number; opened: boolean }[] };
    expect(w1.chests.find((c) => c.id === chest.id)?.opened, 'сундук, открытый без «якоря», открыт и в его комнате').toBe(true);
  });

  it('база не ответила на чтение свода — продолжения старой копией нет: «занято», комната в городе; повтор продолжает', async () => {
    const room = newRoom('R9SO');
    const h = hero(10);
    const p = join(room, h).pid;
    ready(room);
    room.descend(p);
    noMonsters(room);
    const node = inner(room).runNodeId;
    toSpawn(room, p);
    ready(room);
    room.returnTown(p);
    expect(inner(room).area).toBe('town');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.ledgerDown = true;
    ready(room);
    room.descend(p);
    await drained();
    expect(inner(room).area, 'без свода — не продолжаем').toBe('town');
    const ws = (inner(room) as unknown as { clients: Map<string, { ws: FakeWs }> }).clients.get(p)!.ws;
    expect(ws.last('error')?.code).toBe('busy');
    err.mockRestore();
    ready(room);
    room.descend(p);
    await drained();
    expect(inner(room).area).toBe('dungeon');
    expect(inner(room).runNodeId, 'продолжен тот же узел').toBe(node);
  });

  it('ключ свода — личность забега; у забега без неё (старый сейв) — отпечаток того, из чего пересобирается граф', () => {
    const base = { templateId: 't', biomeId: 'b', tier: 'normal', seed: 7, modifiers: ['m2', 'm1'] };
    expect(runLedgerKey({ ...base, id: 'abc' })).toBe('id:abc');
    expect(runLedgerKey(base)).toBe(runLedgerKey({ ...base, modifiers: ['m1', 'm2'] }));
    expect(runLedgerKey(base)).not.toBe(runLedgerKey({ ...base, seed: 8 }));
    expect(runLedgerKey(base)).toMatch(/^seed:[0-9a-f]{40}$/);
  });
});
