import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, effectiveLevel, itemFromBaseId, isDifficultyUnlocked, Cell, TILE,
  type ServerFrame, type SaveState, type RunPlan, type RunNode, type Item,
} from '@dm/shared';
import { limits } from './rateLimit.js';

// Тесты файла ждут комнату оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый такой оборот — шаг системного
// таймера (~15,6 мс). Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот потолок не прячет — они падают
// утверждением, а не временем.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Раунд 7 (сервер): то, что правка сервера обязана довезти через настоящую `Room` — мощь узла не сбрасывается снятым в
 * сумку снаряжением и не занижается узлом, заселённым под слабого (R7-02); ушедший спокойно не платит штраф за забег, который
 * пати увела в город (R7-03); сложность — только открытая зовущему (R7-06); «сбежал из боя» — только от настоящей угрозы
 * (R7-08); прилавок, сменивший поколение, не продаёт старое (R7-18). Сокет — фейковый, база — маленькая честная (версии).
 */
const db = vi.hoisted(() => ({
  /** charId → версия сейва в «базе». Нет записи — 1 (так персонажа отдаёт вход в тестах). */
  saves: new Map<string, number>(),
  /** charId → последний записанный сейв. */
  data: new Map<string, SaveState>(),
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
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const r of rooms.splice(0)) r.stop(); });

/** Шаг комнаты «через `ms`»: и настенные часы, и часы процесса (⭐ R15-06: сроки комнаты — по ним). */
function later(ms: number): void {
  const wall = Date.now() + ms, mono = performance.now() + ms;
  vi.spyOn(Date, 'now').mockReturnValue(wall);
  vi.spyOn(performance, 'now').mockReturnValue(mono);
}

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
}

type Pt = { x: number; y: number };
type Mon = { id: number; alive: boolean; hp: number; pos: Pt; aiState: string; windup: unknown; def: { level: number } };
type Ply = { pos: Pt; hp: number; alive: boolean; combatTimer: number; debuffs: Record<string, unknown>; save: SaveState };
/** Внутренности комнаты, до которых тесту приходится дотягиваться (это тест). */
type RoomIn = {
  area: string; movedAt: number; runPlan: RunPlan | null; runNodeId: string | null; difficultyId: string;
  runConfig: { tier: string } | null;
  decor: { kind: string; x: number; y: number }[];
  disconnected: Map<string, { fled: boolean }>;
  nodeState: { el: number } | null;
  expireGrace(): void;
  session: { world: { timeMs: number; grid: number[][]; spawn: Pt; exits?: Pt[]; monsters: Mon[]; players: Record<string, Ply> } };
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
  const charId = `char-r7s-${++seq}`;
  const uid = userId ?? `user-${charId}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(uid);
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, `H${seq}`, charId);
  s.level = level;
  s.gold = gold;
  db.saves.set(charId, 1);
  db.data.set(charId, structuredClone(s));
  return { save: s, userId: uid };
}
function newRoom(code = 'R7S'): Room {
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
/** Встать к выходу ребра на узел `to` (на финале — к порталу). */
function toExit(room: Room, pid: string, to?: string): void {
  const r = inner(room);
  const node = nodeNow(room);
  const i = Math.max(0, to ? node.edges.findIndex((e) => e.to === to) : 0);
  const at = node.edges.length === 0 ? r.decor.find((d) => d.kind === 'portal')! : r.session.world.exits![i]!;
  r.session.world.players[pid]!.pos = { x: at.x, y: at.y };
}
const toSpawn = (room: Room, pid: string): void => { const w = inner(room).session.world; w.players[pid]!.pos = { ...w.spawn }; };
/** Смертельный яд: следующий тик убивает. */
function kill(room: Room, pid: string): void {
  const w = inner(room).session.world;
  const p = w.players[pid]!;
  p.hp = 1;
  p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: w.timeMs + 5_000, mag: 10_000, mag2: 0 };
  for (let i = 0; i < 3 && p.alive; i++) room.step(false);
  expect(p.alive, 'убит').toBe(false);
}

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

describe('⭐ R7-02: мощь узла — не то, что герой снял на время спуска', () => {
  it('снял всё в сумку в городе и спустился — узел заселён по снаряжению, которое он несёт', async () => {
    const power = cfg.get('balance').power;
    const room = newRoom();
    const h = hero(30);
    gearUp(h.save);
    const { pid } = join(room, h);
    const geared = effectiveLevel(h.save, power).total;
    for (const slot of Object.keys(h.save.equipment)) await room.handleCmd(pid, { cmd: 'unequip', slot }, undefined);
    expect(Object.keys(h.save.equipment), 'снято всё').toEqual([]);
    expect(effectiveLevel(h.save, power).total, 'надетое — голое').toBeLessThan(geared);
    ready(room);
    room.descend(pid);
    expect(inner(room).area).toBe('dungeon');
    expect(inner(room).nodeState?.el, 'мощь узла — по снаряжению в сумке').toBe(geared);
  });

  it('снаряжение основного несёт альт того же аккаунта — узел всё равно по основному', () => {
    const power = cfg.get('balance').power;
    const room = newRoom();
    const main = hero(30, 10_000, 'user-r7s-acc');
    gearUp(main.save);
    const geared = effectiveLevel(main.save, power).total;
    const alt = hero(1, 10_000, 'user-r7s-acc');
    const a = join(room, main), b = join(room, alt);
    // «Передал» в городе: всё снаряжение основного — в сумке альта (подбор с земли того же аккаунта разрешён, R2-02).
    alt.save.inventory.push(...Object.values(main.save.equipment).filter((i): i is Item => !!i));
    main.save.equipment = {};
    ready(room);
    room.descend(a.pid);
    room.castVote(b.pid, true);
    expect(inner(room).area).toBe('dungeon');
    expect(inner(room).nodeState?.el).toBe(geared);
  });

  it('контроль: честный герой в своём снаряжении — мощь узла прежняя', () => {
    const power = cfg.get('balance').power;
    const room = newRoom();
    const h = hero(30);
    gearUp(h.save);
    const { pid } = join(room, h);
    ready(room);
    room.descend(pid);
    expect(inner(room).nodeState?.el).toBe(effectiveLevel(h.save, power).total);
  });

  it('узел, заселённый под альта в отсутствие основного, не открывает основному сложность этой глубиной', async () => {
    const power = cfg.get('balance').power;
    const room = newRoom();
    const alt = hero(1), main = hero(60);
    const a = join(room, alt);
    let m = join(room, main);
    ready(room);
    room.descend(a.pid);
    room.castVote(m.pid, true);
    expect(inner(room).nodeState?.el, 'первый узел — по основному (R6-27)').toBe(effectiveLevel(main.save, power).total);
    const w = inner(room).session.world;
    for (const mon of w.monsters) mon.hp = 0;
    for (let i = 0; i < 3; i++) room.step(false);
    toSpawn(room, a.pid); toSpawn(room, m.pid);
    ready(room);
    room.returnTown(m.pid);
    room.castVote(a.pid, true);
    expect(inner(room).area).toBe('town');
    await settle();
    await room.removePlayer(m.pid);                        // основной вышел из города — чисто, без грейса
    await settle();
    // Альт один: «Продолжить» узел 1 → к выходу → новый узел → в город.
    ready(room);
    room.descend(a.pid);
    await drained();   // R9-01: продолжение из города — после чтения свода забега из базы
    const to = nodeNow(room).edges[0]!.to;
    toExit(room, a.pid, to);
    ready(room);
    room.descend(a.pid, undefined, to);
    expect(inner(room).runNodeId).toBe(to);
    const depth = nodeNow(room).depth;
    const elAlt = inner(room).nodeState!.el;
    toSpawn(room, a.pid);
    ready(room);
    room.returnTown(a.pid);
    await settle();
    // Основной входит по коду (сейв из «базы») и вместе с альтом продолжает — узел по записи альта.
    const mainSave = structuredClone(db.data.get(main.save.charId)!);
    m = join(room, main, mainSave);
    const tier = mainSave.run!.config.tier;
    const before = mainSave.difficultyProgress[tier] ?? 0;
    expect(before, 'основной был только на первом узле').toBeLessThan(depth);
    ready(room);
    room.descend(a.pid);
    room.castVote(m.pid, true);
    expect(inner(room).runNodeId).toBe(to);
    const mainEl = effectiveLevel(mainSave, power).total;
    const credited = (mainSave.difficultyProgress[tier] ?? 0) >= depth;
    expect(inner(room).nodeState!.el >= mainEl || !credited,
      `узел заселён под альта (el ${elAlt}, основной ${mainEl}) — прогресс сложности основному за него не пишется`).toBe(true);
    expect(mainSave.difficultyProgress[tier] ?? 0).toBe(before);
  });

  it('контроль: основной был на узле, когда его заселяли, — прогресс ему пишется как прежде', () => {
    const room = newRoom();
    const alt = hero(1), main = hero(60);
    const a = join(room, alt), m = join(room, main);
    ready(room);
    room.descend(a.pid);
    room.castVote(m.pid, true);
    const to = nodeNow(room).edges[0]!.to;
    toExit(room, a.pid, to);
    ready(room);
    room.descend(a.pid, undefined, to);
    room.castVote(m.pid, true);
    expect(inner(room).runNodeId).toBe(to);
    expect(main.save.difficultyProgress[inner(room).difficultyId]).toBe(nodeNow(room).depth);
  });
});

/** Пати из двух: A хозяин, B сосед (1000 золота); забег начат. */
function party(): { room: Room; a: { pid: string; save: SaveState; userId: string }; b: { pid: string; save: SaveState; userId: string } } {
  const room = newRoom();
  const ha = hero(1), hb = hero(1, 1000);
  const a = join(room, ha), b = join(room, hb);
  ready(room);
  room.descend(a.pid);
  room.castVote(b.pid, true);
  expect(inner(room).area).toBe('dungeon');
  return { room, a: { pid: a.pid, ...ha }, b: { pid: b.pid, ...hb } };
}
/** B отключается спокойно — у портала входа, не в бою; A уводит пати в город. */
async function bCalmThenTown(room: Room, a: { pid: string }, b: { pid: string; save: SaveState }): Promise<void> {
  const w = inner(room).session.world;
  toSpawn(room, b.pid);
  w.players[b.pid]!.combatTimer = 0;
  await room.removePlayer(b.pid);
  await settle();
  expect(inner(room).disconnected.get(b.save.charId)?.fled, 'ушёл спокойно').toBe(false);
  toSpawn(room, a.pid);
  ready(room);
  room.returnTown(a.pid);
  expect(inner(room).area).toBe('town');
  await settle();
  expect(db.data.get(b.save.charId)!.gold).toBe(1000);
  expect(db.data.get(b.save.charId)!.run, 'забег B припаркован').toBeTruthy();
}

describe('⭐ R7-03: ушедший спокойно не платит за забег, который пати увела в город', () => {
  it('A вышел из города, грейс истёк — B без штрафа, забег припаркован', async () => {
    const { room, a, b } = party();
    await bCalmThenTown(room, a, b);
    await room.removePlayer(a.pid);
    await settle();
    expect(db.data.get(a.save.charId)!.run, 'A вышел из города со своим забегом').toBeTruthy();
    inner(room).expireGrace();
    await settle();
    expect(db.data.get(b.save.charId)!.gold, 'штрафа нет').toBe(1000);
    expect(db.data.get(b.save.charId)!.run, 'забег B цел').toBeTruthy();
  });

  it('A нырнул один и погиб — B без штрафа, забег припаркован', async () => {
    const { room, a, b } = party();
    await bCalmThenTown(room, a, b);
    ready(room);
    room.descend(a.pid);
    await drained();   // R9-01: продолжение из города — после чтения свода забега из базы
    expect(inner(room).area).toBe('dungeon');
    kill(room, a.pid);
    await settle();
    expect(db.data.get(b.save.charId)!.gold, 'штрафа нет').toBe(1000);
    expect(db.data.get(b.save.charId)!.run, 'забег B цел').toBeTruthy();
  });

  it('B в городе вошёл «заново» (новая комната) — страховочный бросок забега его не штрафует', async () => {
    const { room, a, b } = party();
    await bCalmThenTown(room, a, b);
    const f = await room.abandonAsDead(b.save.charId, true);
    await settle();
    expect(f.saved).toBe(true);
    expect(db.data.get(b.save.charId)!.gold, 'штрафа нет').toBe(1000);
    expect(db.data.get(b.save.charId)!.run, 'забег B цел').toBeTruthy();
    expect(inner(room).disconnected.has(b.save.charId), 'ждать больше некого').toBe(false);
  });

  it('контроль: «Завершить» сам — штраф, как за любой припаркованный забег', async () => {
    const { room, a, b } = party();
    await bCalmThenTown(room, a, b);
    await room.abandonAsDead(b.save.charId);
    await settle();
    expect(db.data.get(b.save.charId)!.gold).toBeLessThan(1000);
    expect(db.data.get(b.save.charId)!.run).toBeUndefined();
  });

  it('контроль: грейс, истёкший В ПОДЗЕМЕЛЬЕ, — штраф брошенного забега, как прежде', async () => {
    const { room, a, b } = party();
    toSpawn(room, b.pid);
    await room.removePlayer(b.pid);
    await room.removePlayer(a.pid);
    await settle();
    inner(room).expireGrace();
    await settle();
    expect(db.data.get(b.save.charId)!.gold).toBeLessThan(1000);
    expect(db.data.get(b.save.charId)!.run).toBeUndefined();
  });
});

describe('⭐ R7-06: сложность забега — только открытая зовущему', () => {
  const firstUnlocked = (): string => {
    const diffs = cfg.get('difficulties');
    return diffs.find((d, i) => d.enabled !== false && isDifficultyUnlocked(diffs, i, {}))!.id;
  };

  it('свежий герой без выбора, с «normal» и с «hard» — забег первой открытой сложности', () => {
    for (const pick of [undefined, 'normal', 'hard']) {
      const room = newRoom();
      const h = hero(1);
      h.save.difficultyProgress = {};
      const { pid } = join(room, h);
      ready(room);
      room.descend(pid, pick);
      expect(inner(room).runConfig?.tier, String(pick)).toBe(firstUnlocked());
      expect(Object.keys(h.save.difficultyProgress), String(pick)).toEqual([firstUnlocked()]);
    }
  });

  it('гость не наследует закрытую ему сложность прошлого забега комнаты', async () => {
    const room = newRoom();
    const ha = hero(40);
    ha.save.difficultyProgress = { easy: 5, normal: 10, hard: 20 };
    const a = join(room, ha);
    ready(room);
    room.descend(a.pid, 'nightmare');
    expect(inner(room).runConfig?.tier).toBe('nightmare');
    kill(room, a.pid);
    later(10_000);
    room.step(false);                                           // окно смерти прошло — вайп вернул в город
    vi.restoreAllMocks();
    expect(inner(room).area).toBe('town');
    const hb = hero(1);
    hb.save.difficultyProgress = {};
    const b = join(room, hb);
    await room.removePlayer(a.pid);
    for (const pick of [undefined, 'nightmare']) {
      ready(room);
      room.descend(b.pid, pick);
      expect(inner(room).runConfig?.tier, String(pick)).toBe(firstUnlocked());
      expect(hb.save.difficultyProgress.nightmare, String(pick)).toBeUndefined();
      kill(room, b.pid);
      later(10_000);
      room.step(false);
      vi.restoreAllMocks();
      expect(inner(room).area).toBe('town');
    }
  });

  it('контроль: открытая сложность — по выбору; без выбора — сложность прошлого забега, если открыта', () => {
    const room = newRoom();
    const h = hero(40);
    h.save.difficultyProgress = { easy: 5, normal: 10 };
    const { pid } = join(room, h);
    ready(room);
    room.descend(pid, 'hard');
    expect(inner(room).runConfig?.tier).toBe('hard');
  });
});

describe('⭐ R7-08: «сбежал из боя» — только от настоящей угрозы', () => {
  /** A вдали от порталов (400 px от входа — в ту сторону, где этаж шире), на полном здоровье; монстров нет. */
  function awayFromPortal(room: Room, pid: string): void {
    const w = inner(room).session.world;
    const right = w.spawn.x < (w.grid[0]!.length * TILE) / 2;
    w.players[pid]!.pos = { x: w.spawn.x + (right ? 400 : -400 - 8 * TILE), y: w.spawn.y };
    w.players[pid]!.combatTimer = 0;
    for (const m of w.monsters) m.alive = false;
  }
  const poison = (room: Room, pid: string, mag: number, sec: number): void => {
    const w = inner(room).session.world;
    w.players[pid]!.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: w.timeMs + sec * 1000, mag, mag2: 0 };
  };
  /**
   * Монстр гонится за A, но заперт в каморке закрытыми дверями (слух не спрашивает стен): ни прямой видимости, ни пути.
   * `sealed=false` — те же клетки открыты: монстр рядом и дойдёт.
   */
  function chasingFromCell(room: Room, pid: string, sealed: boolean): void {
    const w = inner(room).session.world;
    const p = w.players[pid]!;
    const pc = { cx: Math.floor(p.pos.x / TILE), cy: Math.floor(p.pos.y / TILE) };
    const mc = { cx: pc.cx + 3, cy: pc.cy };
    for (let dy = -2; dy <= 2; dy++) for (let dx = -1; dx <= 5; dx++) w.grid[pc.cy + dy]![pc.cx + dx] = Cell.Floor;
    if (sealed) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) w.grid[mc.cy + dy]![mc.cx + dx] = Cell.Door;
    const m = w.monsters[0]!;
    m.alive = true; m.hp = 100;
    m.pos = { x: mc.cx * TILE + TILE / 2, y: mc.cy * TILE + TILE / 2 };
    m.aiState = 'chase';
  }

  for (const how of ['town', 'descend'] as const) {
    it(`безвредный яд (2 с × 1 в секунду на полном здоровье) — не бегство: ${how === 'town' ? 'город' : 'спуск'} напарника не штрафует`, async () => {
      const { room, a, b } = party();
      awayFromPortal(room, b.pid);
      poison(room, b.pid, 1, 2);
      await room.removePlayer(b.pid);
      expect(inner(room).disconnected.get(b.save.charId)?.fled, 'не сбежал').toBe(false);
      ready(room);
      if (how === 'town') { toSpawn(room, a.pid); room.returnTown(a.pid); expect(inner(room).area).toBe('town'); }
      else { const to = nodeNow(room).edges[0]!.to; toExit(room, a.pid, to); room.descend(a.pid, undefined, to); expect(inner(room).runNodeId).toBe(to); }
      await settle();
      expect(db.data.get(b.save.charId)!.gold, 'штрафа нет').toBe(1000);
      expect(db.data.get(b.save.charId)!.run, 'забег цел').toBeTruthy();
    });
  }

  it('монстр «гонится» из запертой каморки (слышит сквозь стену) — не бегство; и спуск его голосу не отказывает', async () => {
    const { room, a, b } = party();
    awayFromPortal(room, b.pid);
    chasingFromCell(room, b.pid, true);
    await room.removePlayer(b.pid);
    expect(inner(room).disconnected.get(b.save.charId)?.fled, 'не сбежал').toBe(false);
    toSpawn(room, a.pid);
    ready(room);
    room.returnTown(a.pid);
    await settle();
    expect(db.data.get(b.save.charId)!.gold, 'штрафа нет').toBe(1000);
  });

  it('контроль: смертельный яд при 5 HP — бегство, город напарника хоронит со штрафом', async () => {
    const { room, a, b } = party();
    awayFromPortal(room, b.pid);
    inner(room).session.world.players[b.pid]!.hp = 5;
    poison(room, b.pid, 5, 3);
    await room.removePlayer(b.pid);
    expect(inner(room).disconnected.get(b.save.charId)?.fled).toBe(true);
    toSpawn(room, a.pid);
    ready(room);
    room.returnTown(a.pid);
    await settle();
    expect(db.data.get(b.save.charId)!.gold).toBeLessThan(1000);
    expect(db.data.get(b.save.charId)!.run).toBeUndefined();
  });

  it('контроль: тот же монстр, но каморка открыта (дойдёт) — бегство', async () => {
    const { room, b } = party();
    awayFromPortal(room, b.pid);
    chasingFromCell(room, b.pid, false);
    await room.removePlayer(b.pid);
    expect(inner(room).disconnected.get(b.save.charId)?.fled).toBe(true);
  });
});

describe('⭐ R7-18: прилавок, сменивший поколение, не продаёт старое', () => {
  const gearOf = (ws: FakeWs): Item[] => ws.last('shop')!.items.filter((i) => i.kind !== 'consumable');
  type Change = 'expiry' | 'levelUp';
  /**
   * H — хозяин городской комнаты X (сток S1), в ней же сосед A. H вышел; его сток сменился в другой комнате Y (срок вышел или
   * вырос уровень, R3-17). Возвращает X, соседа и вещь из S1.
   */
  async function staleStock(how: Change): Promise<{ x: Room; h: { save: SaveState; userId: string }; a: { ws: FakeWs; pid: string }; old: Item }> {
    const T0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const x = newRoom('R7X');
    const h = hero(10, 10_000_000), ha = hero(10, 10_000_000);
    const hx = join(x, h);
    const a = join(x, ha);
    const old = gearOf(hx.ws)[0]!;
    expect(old, 'в кузнице S1 есть снаряжение').toBeDefined();
    expect(gearOf(a.ws).map((i) => i.uid), 'сосед видит сток хозяина').toContain(old.uid);
    await x.removePlayer(hx.pid);
    await settle();
    const stored = structuredClone(db.data.get(h.save.charId)!);
    if (how === 'expiry') vi.setSystemTime(T0 + cfg.get('balance').townRestockSec * 1000 + 1_000);
    else { stored.level += 5; db.data.set(h.save.charId, structuredClone(stored)); }
    const y = newRoom('R7Y');
    const hy = join(y, h, stored);
    expect(gearOf(hy.ws).map((i) => i.uid), 'в Y — новое поколение').not.toContain(old.uid);
    await y.removePlayer(hy.pid);
    await settle();
    return { x, h, a, old };
  }

  for (const how of ['expiry', 'levelUp'] as const) {
    it(`${how === 'expiry' ? 'срок вышел' : 'вырос уровень'}: H вернулся в X по коду — вещи S1 ему не продают, прилавок X — не S1`, async () => {
      const { x, h, old } = await staleStock(how);
      const back = join(x, h, structuredClone(db.data.get(h.save.charId)!));
      expect(gearOf(back.ws).map((i) => i.uid), 'старого поколения на прилавке нет').not.toContain(old.uid);
      await x.handleCmd(back.pid, { cmd: 'buy', uid: old.uid }, 1);
      expect(back.ws.last('cmdResult')).toMatchObject({ id: 1, ok: false });
    });

    it(`${how === 'expiry' ? 'срок вышел' : 'вырос уровень'}: сосед в X покупает вещь S1 — «прилавок обновился», новый прилавок`, async () => {
      const { x, a, old } = await staleStock(how);
      const shops = a.ws.frames.filter((f) => f.t === 'shop').length;
      await x.handleCmd(a.pid, { cmd: 'buy', uid: old.uid }, 1);
      const r = a.ws.last('cmdResult')!;
      expect(r).toMatchObject({ id: 1, ok: false });
      expect(r.reason).toMatch(/Прилавок обновился/);
      expect(a.ws.frames.filter((f) => f.t === 'shop').length, 'новый прилавок пришёл').toBeGreaterThan(shops);
      expect(gearOf(a.ws).map((i) => i.uid)).not.toContain(old.uid);
    });
  }

  it('контроль: хозяин вышел, его сток — текущее поколение; сосед покупает с него, как прежде', async () => {
    const x = newRoom('R7Z');
    const h = hero(10, 10_000_000), ha = hero(10, 10_000_000);
    const hx = join(x, h);
    const a = join(x, ha);
    const item = gearOf(hx.ws)[0]!;
    await x.removePlayer(hx.pid);
    await settle();
    await x.handleCmd(a.pid, { cmd: 'buy', uid: item.uid }, 1);
    expect(a.ws.last('cmdResult')).toMatchObject({ id: 1, ok: true });
  });
});
