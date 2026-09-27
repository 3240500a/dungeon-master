import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, effectiveLevel, itemFromBaseId, isDifficultyUnlocked,
  type ServerFrame, type SaveState, type RunPlan, type RunNode, type Item,
} from '@dm/shared';
import { limits } from './rateLimit.js';

// Тесты файла ждут комнату оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый такой оборот — шаг системного
// таймера (~15,6 мс). Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот потолок не прячет — они падают
// утверждением, а не временем.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Раунд 8 (сервер): то, что правка сервера обязана довезти через настоящую `Room` — откат транзакции аккаунта не снимает
 * сток кузницы и записи забега, переписанные чужим ходом (R8-01); продолжение забега не открывает сложность глубиной, которую
 * герой не проходил (R8-02); голосование не переживает смену области и вайп (R8-03); мощь узла помнит снаряжение, надетое в
 * этом забеге (R8-04); «сбежал из боя» при спуске — по правилу спуска (R8-07); вошедший при открытом голосовании его видит, а
 * второй переход — отказ с причиной (R8-08). Сокет — фейковый, база — маленькая честная (версии), запись «сейв + сундук» ждёт
 * решения теста (`db.gate`).
 */
const db = vi.hoisted(() => ({
  /** charId → версия сейва в «базе». Нет записи — 1 (так персонажа отдаёт вход в тестах). */
  saves: new Map<string, number>(),
  /** charId → последний записанный сейв. */
  data: new Map<string, SaveState>(),
  /** Записи «сейв + сундук», ждущие теста: `true` — легла, `false` — сундук обогнал другой герой аккаунта (D8). */
  gate: [] as ((ok: boolean) => void)[],
}));
vi.mock('../db/db.js', () => ({
  // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    const snap = structuredClone(data);          // снимок в момент вызова — как и настоящая запись
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve(null);
    db.saves.set(charId, v + 1);
    db.data.set(charId, snap);
    return Promise.resolve(v + 1);
  },
  putCharacterWithStash: (charId: string, _u: string, data: SaveState, v: number) => {
    const snap = structuredClone(data);
    return new Promise((resolve) => db.gate.push((ok) => {
      if (!ok) { resolve({ ok: false, conflict: 'stash' }); return; }
      if (v !== (db.saves.get(charId) ?? 1)) { resolve({ ok: false, conflict: 'save' }); return; }
      db.saves.set(charId, v + 1);
      db.data.set(charId, snap);
      resolve({ ok: true, version: v + 1, stashVersion: 1 });
    }));
  },
  getCharacter: (charId: string) => {
    const d = db.data.get(charId);
    return Promise.resolve(d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.saves.get(charId) ?? 1 } : null);
  },
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Room = import('./room.js').Room;
let RoomCtor: typeof import('./room.js').Room;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor } = await import('./room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: Room[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const open of db.gate.splice(0)) open(false);   // зависшая запись теста не держит следующий
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
type Ply = { pos: Pt; hp: number; alive: boolean; debuffs: Record<string, unknown>; save: SaveState };
/** Внутренности комнаты, до которых тесту приходится дотягиваться (это тест). */
type RoomIn = {
  area: string; movedAt: number; runPlan: RunPlan | null; runNodeId: string | null;
  runConfig: { tier: string; seed: number } | null;
  vote: unknown;
  stock: { at: number; seed: number } | null;
  decor: { kind: string; x: number; y: number }[];
  disconnected: Map<string, unknown>;
  nodeState: { el: number } | null;
  stockStale(): boolean;
  validDifficulty(pid: string, id?: string): string;
  session: {
    saveHeld: Set<string>;
    world: { timeMs: number; spawn: Pt; exits?: Pt[]; monsters: Mon[]; drops: { id: number }[]; players: Record<string, Ply> };
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

/** Герой в «базе» (версия 1) со своим аккаунтом `user-<charId>` (или общим `userId`). */
function hero(level: number, gold = 10_000, userId?: string): { save: SaveState; userId: string } {
  const charId = `char-r8s-${++seq}`;
  const uid = userId ?? `user-${charId}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(uid);
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, `H${seq}`, charId);
  s.level = level;
  s.gold = gold;
  db.saves.set(charId, 1);
  db.data.set(charId, structuredClone(s));
  return { save: s, userId: uid };
}
function newRoom(code = 'R8S'): Room {
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
/** Смертельный яд: следующий тик убивает. */
function poisonToDeath(room: Room, pid: string): void {
  const w = inner(room).session.world;
  const p = w.players[pid]!;
  p.hp = 1;
  p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: w.timeMs + 5_000, mag: 10_000, mag2: 0 };
}
const noMonsters = (room: Room): void => { for (const m of inner(room).session.world.monsters) m.alive = false; };
const unlocked = (s: SaveState, id: string): boolean => {
  const diffs = cfg.get('difficulties');
  return isDifficultyUnlocked(diffs, diffs.findIndex((d) => d.id === id), s.difficultyProgress ?? {});
};
/** Уникальные вещи в уровень героя — в каждый пустой слот (как у героя в хорошем снаряжении). */
function gearUp(s: SaveState): void {
  for (const b of cfg.get('items.base')) {
    const slot = (b as { slot?: string }).slot as keyof SaveState['equipment'] | undefined;
    if (!slot || b.kind === 'consumable' || b.enabled === false || s.equipment[slot]) continue;
    const it = itemFromBaseId(cfg.get('items.base'), b.id, cfg.get('item-tiers'), 'drop') as Item;
    it.rarity = 'unique'; it.itemLevel = s.level; it.requirements = {} as Item['requirements']; it.hands = 1; delete it.versatile;
    s.equipment[slot] = it;
  }
}
const potion = (): Item => itemFromBaseId(cfg.get('items.base'), 'minor-healing-potion', undefined, 'shop') as Item;

describe('⭐ R8-01: откат транзакции аккаунта не снимает сток и записи забега, переписанные чужим ходом', () => {
  const gearOf = (ws: FakeWs): Item[] => ws.last('shop')!.items.filter((i) => i.kind !== 'consumable');

  /**
   * H — хозяин городской комнаты, B — его сосед (тот же аккаунт); срок стока H вышел. H переносит зелье в сундук, и запись
   * «сейв + сундук» ждёт базу (сейв H — на удержании). Возвращает ожидание команды H и срок его прежнего стока.
   */
  async function heldHost(code: string): Promise<{
    room: Room; h: { ws: FakeWs; pid: string }; b: { ws: FakeWs; pid: string }; H: SaveState; pot: Item; at0: number; pending: Promise<void>;
  }> {
    const T0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const room = newRoom(code);
    const acc = `user-r8s-acc-${++seq}`;
    const hh = hero(40, 10_000_000, acc), hb = hero(40, 10_000_000, acc);
    const pot = potion();
    hh.save.inventory.push(pot);
    const h = join(room, hh), b = join(room, hb);
    const at0 = hh.save.townStock!.at;
    vi.setSystemTime(T0 + cfg.get('balance').townRestockSec * 1000 + 1_000);
    const pending = room.handleCmd(h.pid, { cmd: 'stashMove', uid: pot.uid, dst: 0, x: 0, y: 0 }, 1);
    await settle();
    expect(db.gate.length, 'запись H ждёт базу').toBe(1);
    expect(inner(room).session.saveHeld.size, 'сейв H на удержании').toBe(1);
    return { room, h, b, H: hh.save, pot, at0, pending };
  }

  it('B покупает у протухшего прилавка во время удержания, запись H не легла — у H сток прилавка, купленное помнится, третьего броска нет', async () => {
    const { room, h, b, H, pot, at0, pending } = await heldHost('R8S1');
    await room.handleCmd(b.pid, { cmd: 'buy', uid: gearOf(b.ws)[0]!.uid }, 2);
    expect(b.ws.last('cmdResult')!.reason).toMatch(/Прилавок обновился/);
    const renewed = { at: inner(room).stock!.at, seed: inner(room).stock!.seed };
    expect(renewed.at, 'новое поколение').not.toBe(at0);
    // Покупка с нового поколения, пока запись H ждёт базу: номер купленного — в опознание стока H (R5-22).
    const bought = gearOf(b.ws)[0]!;
    await room.handleCmd(b.pid, { cmd: 'buy', uid: bought.uid }, 3);
    expect(b.ws.last('cmdResult'), 'купил').toMatchObject({ id: 3, ok: true });
    const idx = [...H.townStock!.bought];
    expect(idx.length, 'купленное помечено в стоке хозяина').toBe(1);

    db.gate.shift()!(false);   // сундук обогнал другой герой аккаунта — запись H откатывается
    await pending;
    await settle();
    expect(h.ws.last('cmdResult'), 'перенос H не состоялся').toMatchObject({ id: 1, ok: false });
    expect(H.inventory.some((i) => i.uid === pot.uid), 'зелье вернулось в сумку').toBe(true);
    expect({ at: H.townStock!.at, seed: H.townStock!.seed }, 'опознание стока H — то, что на прилавке').toEqual(renewed);
    expect(H.townStock!.bought, 'купленное во время удержания не забыто').toEqual(idx);
    expect(inner(room).stockStale(), 'сток текущий').toBe(false);

    const next = gearOf(b.ws)[0]!;
    await room.handleCmd(b.pid, { cmd: 'buy', uid: next.uid }, 4);
    expect(b.ws.last('cmdResult'), 'покупка с того же поколения идёт').toMatchObject({ id: 4, ok: true });
    expect(inner(room).stock!.seed, 'третьего броска нет').toBe(renewed.seed);
  });

  it('третий герой входит во время удержания (прилавок сменился на входе), запись H не легла — у H сток прилавка', async () => {
    const { room, H, pending } = await heldHost('R8S2');
    const c = join(room, hero(40));
    const renewed = { at: inner(room).stock!.at, seed: inner(room).stock!.seed };
    expect(c.ws.last('shop'), 'вошедшему — прилавок').toBeDefined();
    db.gate.shift()!(false);
    await pending;
    await settle();
    expect({ at: H.townStock!.at, seed: H.townStock!.seed }).toEqual(renewed);
    expect(inner(room).stockStale()).toBe(false);
  });

  it('сосед по забегу входит во время удержания со своей записью узла — откат H её не стирает', async () => {
    const room = newRoom('R8S3');
    const acc = `user-r8s-acc-${++seq}`;
    const hh = hero(10, 10_000, acc);
    const pot = potion();
    hh.save.inventory.push(pot);
    const h = join(room, hh);
    ready(room);
    room.descend(h.pid, 'easy');
    expect(inner(room).area).toBe('dungeon');
    toSpawn(room, h.pid);
    ready(room);
    room.returnTown(h.pid);
    expect(inner(room).area).toBe('town');
    const run = hh.save.run!;
    const other = inner(room).runPlan!.nodes.find((n) => n.id !== run.currentNodeId)!;
    // Сосед C того же забега прошёл узел `other` в другой комнате: его запись комнате ещё не известна.
    const hc = hero(10);
    hc.save.run = { ...structuredClone(run), visited: [...run.visited, other.id], nodes: [{ id: other.id, el: 7, chests: [0], killed: [1, 2], levers: [] }] };
    const pending = room.handleCmd(h.pid, { cmd: 'stashMove', uid: pot.uid, dst: 0, x: 0, y: 0 }, 1);
    await settle();
    expect(db.gate.length).toBe(1);
    join(room, hc);
    expect(hh.save.run!.nodes?.some((n) => n.id === other.id), 'запись соседа разошлась и по H').toBe(true);
    db.gate.shift()!(false);
    await pending;
    await settle();
    expect(h.ws.last('cmdResult')).toMatchObject({ id: 1, ok: false });
    expect(hh.save.run!.nodes?.find((n) => n.id === other.id), 'запись узла соседа пережила откат H').toMatchObject({ killed: [1, 2], chests: [0] });
  });

  it('контроль: запись H легла — сток H и перенос в сундук как есть', async () => {
    const { room, H, pot, pending } = await heldHost('R8S4');
    const st = { at: inner(room).stock!.at, seed: inner(room).stock!.seed };
    db.gate.shift()!(true);
    await pending;
    await settle();
    expect(H.inventory.some((i) => i.uid === pot.uid), 'зелье ушло в сундук').toBe(false);
    expect({ at: H.townStock!.at, seed: H.townStock!.seed }).toEqual(st);
  });
});

describe('⭐ R8-02: продолжение забега не открывает сложность глубиной, которой герой не проходил', () => {
  /** H проходит «normal» до глубины 10 и выходит в город у портала входа — забег припаркован. */
  function deepParked(): { room: Room; h: { ws: FakeWs; pid: string }; H: SaveState; deep: number } {
    const room = newRoom('R8S5');
    const hh = hero(20);
    hh.save.difficultyProgress = { easy: 5 };
    const h = join(room, hh);
    ready(room);
    room.descend(h.pid, 'normal', undefined, { templateId: 'deep-expedition' });
    expect(inner(room).runConfig?.tier).toBe('normal');
    while (nodeNow(room).depth < 10) {
      const to = nodeNow(room).edges[0]!.to;
      toExit(room, h.pid, to);
      ready(room);
      room.descend(h.pid, undefined, to);
      expect(inner(room).runNodeId).toBe(to);
    }
    const deep = nodeNow(room).depth;
    toSpawn(room, h.pid);
    ready(room);
    room.returnTown(h.pid);
    expect(inner(room).area).toBe('town');
    expect(hh.save.difficultyProgress.normal).toBe(deep);
    return { room, h, H: hh.save, deep };
  }

  it('свежий герой продолжает глубокий забег хозяина и уходит у портала входа — «hard» ему не открыт', async () => {
    const { room, h, deep } = deepParked();
    const hg = hero(1);
    hg.save.difficultyProgress = {};
    const g = join(room, hg);
    ready(room);
    room.descend(g.pid);
    room.castVote(h.pid, true);
    await drained();   // R9-01: продолжение из города — после чтения свода забега из базы
    expect(inner(room).area).toBe('dungeon');
    expect(nodeNow(room).depth, 'продолжен глубокий узел').toBe(deep);
    toSpawn(room, g.pid); toSpawn(room, h.pid);
    ready(room);
    room.returnTown(g.pid);
    room.castVote(h.pid, true);
    expect(inner(room).area).toBe('town');
    expect(hg.save.difficultyProgress.normal, 'глубины, которой не проходил, в прогрессе нет').toBeUndefined();
    expect(unlocked(hg.save, 'hard')).toBe(false);
    expect(inner(room).validDifficulty(g.pid, 'hard')).not.toBe('hard');
  });

  it('контроль: спустились с глубокого узла на НОВЫЙ вместе — его глубина гостю засчитана', async () => {
    const { room, h, deep } = deepParked();
    const hg = hero(1);
    hg.save.difficultyProgress = {};
    const g = join(room, hg);
    ready(room);
    room.descend(g.pid);
    room.castVote(h.pid, true);
    await drained();   // R9-01: продолжение из города — после чтения свода забега из базы
    noMonsters(room);
    const to = nodeNow(room).edges[0]!.to;
    toExit(room, h.pid, to);
    ready(room);
    room.descend(h.pid, undefined, to);
    room.castVote(g.pid, true);
    expect(inner(room).runNodeId).toBe(to);
    expect(hg.save.difficultyProgress.normal, 'новый узел — в прогресс').toBe(deep + 1);
  });
});

describe('⭐ R8-03: голосование не переживает вайп и смену области', () => {
  /** H (открыт «hard») и свежий гость G в «hard»; G у выхода зовёт спуск, H не голосует. */
  function pendingDescend(code: string): { room: Room; h: { ws: FakeWs; pid: string }; g: { ws: FakeWs; pid: string }; G: SaveState } {
    const room = newRoom(code);
    const hh = hero(30);
    hh.save.difficultyProgress = { easy: 5, normal: 10 };
    const hg = hero(1);
    hg.save.difficultyProgress = {};
    const h = join(room, hh), g = join(room, hg);
    ready(room);
    room.descend(h.pid, 'hard');
    room.castVote(g.pid, true);
    expect(inner(room).runConfig?.tier).toBe('hard');
    noMonsters(room);
    const to = nodeNow(room).edges[0]!.to;
    toExit(room, g.pid, to);
    ready(room);
    room.descend(g.pid, undefined, to);
    expect(inner(room).vote, 'голосование открыто').toBeTruthy();
    return { room, h, g, G: hg.save };
  }
  function wipe(room: Room, ...pids: string[]): void {
    for (const pid of pids) poisonToDeath(room, pid);
    for (let i = 0; i < 3; i++) room.step(false);
    expect(pids.every((pid) => !inner(room).session.world.players[pid]!.alive), 'пати погибла').toBe(true);
  }

  it('вайп вернул в город — голосование закрыто; хозяин вышел — гость остаётся в городе, «hard» ему не достался', async () => {
    const { room, h, g, G } = pendingDescend('R8S6');
    wipe(room, h.pid, g.pid);
    const progress = structuredClone(G.difficultyProgress);
    expect(inner(room).vote, 'вайп закрыл голосование').toBeNull();
    expect(g.ws.last('voteEnd'), 'и сказал об этом').toEqual({ t: 'voteEnd', passed: false });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    room.step(false);
    vi.restoreAllMocks();
    expect(inner(room).area).toBe('town');
    await room.removePlayer(h.pid);
    await settle();
    expect(inner(room).area, 'старое «за» гостя не уводит его в забег').toBe('town');
    expect(G.difficultyProgress, 'и прогресса в «hard» гостю не прибавилось').toEqual(progress);
  });

  it('в окне вайпа голоса мёртвых не начинают новый забег', () => {
    const { room, h, g } = pendingDescend('R8S7');
    const seed = inner(room).runConfig!.seed;
    wipe(room, h.pid, g.pid);
    expect(inner(room).runPlan, 'вайп окончил забег').toBeNull();
    room.castVote(h.pid, true);
    expect(inner(room).runPlan, 'нового забега нет').toBeNull();
    expect(inner(room).runConfig, 'и его сида тоже').toBeNull();
    expect(seed).toBeGreaterThan(0);
    expect(inner(room).session.world.players[h.pid]!.alive || inner(room).session.world.players[g.pid]!.alive, 'мёртвые не ожили').toBe(false);
  });

  it('контроль: голосование, открытое в городе после вайпа, работает как прежде', () => {
    const { room, h, g } = pendingDescend('R8S8');
    wipe(room, h.pid, g.pid);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    room.step(false);
    vi.restoreAllMocks();
    expect(inner(room).area).toBe('town');
    ready(room);
    room.descend(h.pid, 'easy');
    room.castVote(g.pid, true);
    expect(inner(room).area).toBe('dungeon');
  });
});

describe('⭐ R8-04: мощь узла помнит снаряжение, надетое в этом забеге', () => {
  it('основной отдаёт снаряжение альту с чужим забегом, тот ждёт реконнекта — следующий узел всё равно по снаряжению основного', async () => {
    const power = cfg.get('balance').power;
    const acc = `user-r8s-acc-${++seq}`;
    const M = hero(40, 10_000, acc), T = hero(1, 10_000, acc);
    T.save.equipment = {}; T.save.inventory = [];   // у альта — только то, что ему передадут
    gearUp(M.save);
    const geared = effectiveLevel(M.save, power).total;
    // У альта свой припаркованный забег — вход по коду его не трогает (`joinRun`), и в грейсе он не «этого забега».
    T.save.run = { templateId: 'crypt-short', config: { templateId: 'crypt-short', biomeId: 'crypt', tier: 'easy', seed: 4242, modifiers: [] }, currentNodeId: 'n1_0', visited: ['n1_0'] } as SaveState['run'];
    const room = newRoom('R8S9');
    const m = join(room, M);
    const t = join(room, T);
    const w = inner(room).session.world;
    const handOver = async (from: string, to: string, save: SaveState): Promise<void> => {
      for (const slot of Object.keys(save.equipment)) await room.handleCmd(from, { cmd: 'unequip', slot }, undefined);
      w.players[to]!.pos = { ...w.players[from]!.pos };
      for (const it of [...save.inventory]) await room.handleCmd(from, { cmd: 'drop', uid: it.uid }, undefined);
      for (const d of [...w.drops]) await room.handleCmd(to, { cmd: 'pickup', dropId: d.id }, undefined);
    };
    await handOver(m.pid, t.pid, M.save);
    expect(M.save.inventory.length + Object.keys(M.save.equipment).length, 'основной гол').toBe(0);
    await room.removePlayer(t.pid);          // из города — чистый выход
    await settle();
    ready(room);
    room.descend(m.pid, 'easy');
    expect(inner(room).area).toBe('dungeon');
    // Альт входит по коду со снаряжением и отдаёт его; основной надевает и бьёт узел.
    const t2 = join(room, T, structuredClone(db.data.get(T.save.charId)!));
    const tSave = inner(room).session.world.players[t2.pid]!.save;
    await handOver(t2.pid, m.pid, tSave);
    for (const it of [...M.save.inventory]) await room.handleCmd(m.pid, { cmd: 'equip', uid: it.uid }, undefined);
    expect(effectiveLevel(M.save, power).total, 'основной в снаряжении').toBe(geared);
    // Перед выходом — снова альту, альт отключается у входа (грейс, забег у него свой).
    await handOver(m.pid, t2.pid, M.save);
    noMonsters(room);                        // альт уходит спокойно: на него никто не идёт (R8-07)
    toSpawn(room, t2.pid);
    await room.removePlayer(t2.pid);
    await settle();
    expect(inner(room).disconnected.has(T.save.charId), 'альт ждёт реконнекта со снаряжением').toBe(true);
    const to = nodeNow(room).edges[0]!.to;
    toExit(room, m.pid, to);
    ready(room);
    room.descend(m.pid, undefined, to);
    expect(inner(room).runNodeId).toBe(to);
    expect(inner(room).nodeState!.el, 'узел — по снаряжению, которое основной носил в этом забеге').toBeGreaterThanOrEqual(geared);
  });

  it('контроль: мощь прошлого забега новый забег не наследует — после вайпа голый герой спускается по своей мощи', () => {
    const power = cfg.get('balance').power;
    const room = newRoom('R8SA');
    const M = hero(40);
    gearUp(M.save);
    const geared = effectiveLevel(M.save, power).total;
    const m = join(room, M);
    ready(room);
    room.descend(m.pid, 'easy');
    expect(inner(room).nodeState!.el).toBe(geared);
    poisonToDeath(room, m.pid);
    for (let i = 0; i < 3; i++) room.step(false);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    room.step(false);
    vi.restoreAllMocks();
    expect(inner(room).area).toBe('town');
    expect(M.save.run, 'вайп окончил забег').toBeUndefined();
    M.save.equipment = {};                  // продал и разобрал — снаряжения больше нет
    const naked = effectiveLevel(M.save, power, []).total;
    ready(room);
    room.descend(m.pid, 'easy');
    expect(inner(room).nodeState!.el).toBe(naked);
  });
});

describe('⭐ R8-07: отключившийся посреди боя при спуске пати — по правилу спуска, а не выхода в город', () => {
  /** Пати A+B спустилась; у A 1 HP, рядом монстр гонится за ним, A стоит в `at`. */
  function cornered(code: string, where: 'spawn' | 'exit'): { room: Room; a: string; b: string; A: SaveState } {
    const room = newRoom(code);
    const ha = hero(1), hb = hero(1);
    const a = join(room, ha).pid, b = join(room, hb).pid;
    ready(room);
    room.descend(a);
    room.castVote(b, true);
    expect(inner(room).area).toBe('dungeon');
    const w = inner(room).session.world;
    const at = where === 'spawn' ? w.spawn : w.exits![0]!;
    w.players[b]!.pos = { ...(where === 'spawn' ? w.exits![0]! : w.spawn) };   // напарник — в другом конце
    const p = w.players[a]!;
    p.pos = { ...at }; p.hp = 1;
    const mon = w.monsters.find((x) => x.alive)!;
    mon.pos = { ...at }; mon.aiState = 'chase';                              // вплотную: дойдёт наверняка
    return { room, a, b, A: ha.save };
  }
  async function partnerDescends(room: Room, b: string): Promise<void> {
    const to = nodeNow(room).edges[0]!.to;
    toExit(room, b, to);
    ready(room);
    room.descend(b, undefined, to);
    expect(inner(room).runNodeId).toBe(to);
    await settle();
  }

  it('загнан у выхода (там «за» спуск ему можно) — спуск напарника его не хоронит, ждёт реконнекта', async () => {
    const { room, a, b, A } = cornered('R8SB', 'exit');
    await room.removePlayer(a);
    await settle();
    await partnerDescends(room, b);
    expect(inner(room).disconnected.has(A.charId), 'ждёт').toBe(true);
    expect(db.data.get(A.charId)!.gold, 'штрафа нет').toBe(10_000);
    expect(db.data.get(A.charId)!.run, 'забег цел').toBeTruthy();
  });

  it('загнан у портала входа (там «за» спуск ему нельзя) — спуск напарника хоронит со штрафом', async () => {
    const { room, a, b, A } = cornered('R8SC', 'spawn');
    await room.removePlayer(a);
    await settle();
    await partnerDescends(room, b);
    expect(inner(room).disconnected.has(A.charId)).toBe(false);
    expect(db.data.get(A.charId)!.gold).toBeLessThan(10_000);
    expect(db.data.get(A.charId)!.run).toBeUndefined();
  });

  it('контроль: загнан у выхода — уход пати в город хоронит, как прежде (уйти в город можно только от портала)', async () => {
    const { room, a, b, A } = cornered('R8SD', 'exit');
    await room.removePlayer(a);
    await settle();
    toSpawn(room, b);
    ready(room);
    room.returnTown(b);
    expect(inner(room).area).toBe('town');
    await settle();
    expect(db.data.get(A.charId)!.gold).toBeLessThan(10_000);
    expect(db.data.get(A.charId)!.run).toBeUndefined();
  });

  it('контроль: загнан у портала входа — уход пати в город его не хоронит', async () => {
    const { room, a, b, A } = cornered('R8SE', 'spawn');
    await room.removePlayer(a);
    await settle();
    toSpawn(room, b);
    ready(room);
    room.returnTown(b);
    await settle();
    expect(db.data.get(A.charId)!.gold).toBe(10_000);
  });
});

describe('⭐ R8-08: вошедший при открытом голосовании его видит; второй переход — отказ с причиной', () => {
  it('город: C вошёл по коду — ему голосование и новый счёт; B и C «за» — спуск; спуск и арена C до того — отказ «vote»', () => {
    const room = newRoom('R8SF');
    const a = join(room, hero(5)), b = join(room, hero(5));
    ready(room);
    room.descend(a.pid, 'easy');
    expect(inner(room).vote).toBeTruthy();
    const c = join(room, hero(5));
    expect(c.ws.last('voteStart'), 'вошедшему — окно голосования').toMatchObject({ kind: 'descend', needed: 3 });
    expect(c.ws.last('voteUpdate')).toEqual({ t: 'voteUpdate', yes: 1, total: 3 });
    expect(b.ws.last('voteUpdate'), 'остальным — новый счёт').toEqual({ t: 'voteUpdate', yes: 1, total: 3 });
    ready(room);
    room.descend(c.pid, 'easy');
    room.enterArena(c.pid);
    const codes = c.ws.all('error').map((f) => f.code);
    expect(codes, 'второй переход — отказ с причиной').toEqual(['vote', 'vote']);
    room.castVote(b.pid, true);
    expect(inner(room).area).toBe('town');
    room.castVote(c.pid, true);
    expect(c.ws.last('voteEnd')).toEqual({ t: 'voteEnd', passed: true });
    expect(inner(room).area).toBe('dungeon');
  });

  it('подземелье: D вернулся «Продолжить» при открытом голосовании — ему окно с целью спуска; «за» всех — спуск', async () => {
    const room = newRoom('R8SG');
    const ha = hero(5), hb = hero(5), hd = hero(5);
    const a = join(room, ha), b = join(room, hb), d = join(room, hd);
    ready(room);
    room.descend(a.pid, 'easy');
    room.castVote(b.pid, true);
    room.castVote(d.pid, true);
    expect(inner(room).area).toBe('dungeon');
    noMonsters(room);
    const to = nodeNow(room).edges[0]!.to;
    toExit(room, a.pid, to);
    ready(room);
    room.descend(a.pid, undefined, to);
    expect(inner(room).vote).toBeTruthy();
    toSpawn(room, d.pid);
    await room.removePlayer(d.pid);
    await settle();
    expect(inner(room).vote, 'голосование ждёт B').toBeTruthy();
    const ws = new FakeWs();
    const back = room.reconnect(ws as unknown as GameConn, hd.userId, structuredClone(db.data.get(hd.save.charId)!), db.saves.get(hd.save.charId)!);
    expect(ws.last('voteStart'), 'вернувшемуся — окно с целью').toMatchObject({ kind: 'descend', needed: 3, targetNodeId: to });
    expect(ws.last('voteUpdate')).toEqual({ t: 'voteUpdate', yes: 1, total: 3 });
    room.castVote(b.pid, true);
    room.castVote(back, true);
    expect(inner(room).runNodeId).toBe(to);
  });

  it('контроль: зовущий повторно — без шума (его «за» уже учтено)', () => {
    const room = newRoom('R8SH');
    const a = join(room, hero(5));
    join(room, hero(5));
    ready(room);
    room.descend(a.pid, 'easy');
    room.descend(a.pid, 'easy');
    expect(a.ws.all('error')).toEqual([]);
  });
});
