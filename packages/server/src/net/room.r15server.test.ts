import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  ConfigRegistry, newCharacterSave, itemFromBaseId, findFree, hasLineOfSight, isWalkableWorld,
  type ServerFrame, type SaveState, type PlayerInput,
} from '@dm/shared';

// Тесты ждут комнату оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решают мок базы и шаги
// комнаты, которые тест делает сам (`step`), а не часы.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ РАУНД 15 (сервер), комната. Комната настоящая; база — маленькая честная (версии сейва) с воротами записи.
 *  • R15-02: прощальная запись уходящего — ПОСЛЕДНЯЯ запись его сессии: не склеивается с ждущим автосейвом (R16 C-06), за которым уже
 *    встала запись выброса или разбора. Раньше та ложилась после прощания: копия ждущего реконнекта отставала от строки на версию, и
 *    штраф смерти тела в бою (R13-03) отклонялся по версии — смерть выходила бесплатной.
 *  • R15-09: выход с арены не режет здоровье (ману, выносливость) по снимку арены, где стойки уже нет (+15 % к здоровью): вернулся — с
 *    тем, с чем ушёл (R9-14, R11-04).
 *  • R16-07: и временные баффы (скилов, печатей вставок, зелий) за время арены стареют, как откаты: раньше круг «город → арена → город»
 *    возвращал бафф полным, а откат — готовым, и каждый круг давал лишнее окно баффа.
 */
const db = vi.hoisted(() => ({
  versions: new Map<string, number>(), data: new Map<string, unknown>(),
  /** Ворота записи строки героя — по попытке (снимок уже снят): `null` — без ожидания. */
  holds: new Map<string, (Promise<void> | null)[]>(),
  /** Легшие и отклонённые записи — по порядку (`charId v→v'` / `charId REJECT v`). */
  log: [] as string[],
}));
vi.mock('../db/db.js', () => ({
  putCharacter: async (charId: string, _u: string, data: SaveState, version: number) => {
    const json = JSON.stringify(data);   // снимок — в момент вызова
    const g = db.holds.get(charId)?.shift();
    if (g) await g;
    const cur = db.versions.get(charId) ?? 1;
    if (version !== cur) { db.log.push(`${charId} REJECT v${version} (db v${cur})`); return null; }
    db.versions.set(charId, version + 1); db.data.set(charId, JSON.parse(json));
    db.log.push(`${charId} v${version}->v${version + 1}`);
    return version + 1;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getCharacter: async (charId: string) => {
    const d = db.data.get(charId);
    return d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null;
  },
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Mon = { alive: boolean; pos: { x: number; y: number }; aiState: string };
type P = {
  hp: number; maxHp: number; mana: number; stamina: number; alive: boolean; toggles: string[];
  pos: { x: number; y: number }; save: SaveState;
};
type Info = { paid: boolean; saveVersion: number; save: SaveState };
type RoomIn = {
  area: string; movedAt: number;
  decor: { kind: string; x: number; y: number }[];
  disconnected: Map<string, Info>; lingering: Map<string, unknown>;
  session: {
    world: { players: Record<string, P>; spawn: { x: number; y: number }; monsters: Mon[]; exits?: { x: number; y: number }[]; grid: never };
    snapshotOf(pid: string): { derived: { maxHp: number; maxMana: number; maxStamina: number } } | undefined;
  };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): Promise<{ saved: boolean }>;
  persist(pid: string): Promise<unknown>;
  castVote(pid: string, yes: boolean): void; descend(pid: string): void; enterArena(pid: string): void; returnTown(pid: string): void;
  setInput(pid: string, input: PlayerInput): void;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
  step(): void; stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => {
  for (const r of rooms.splice(0)) r.stop();
  db.holds.clear(); db.log = [];
  vi.restoreAllMocks();
});

class FakeWs {
  open = true; readonly ip = '127.0.0.1'; frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void {} onClose(): void {}
}
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
let seq = 0;
function newRoom(): RoomIn {
  const room = new RoomCtor(`R15S${++seq}`, cfg, hooks);
  rooms.push(room);
  return room;
}
function hero(gold = 5000): SaveState {
  const charId = `char-r15s-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  s.level = 30; s.gold = gold; s.attributes.vitality = 60;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const P = (room: RoomIn, pid: string): P => room.session.world.players[pid]!;
const row = (charId: string): SaveState => db.data.get(charId) as SaveState;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
/** Ворота на следующие записи строки героя (по порядку попыток; `false` — без ожидания). Возвращает, чем их открыть. */
function holds(charId: string, pattern: boolean[]): (() => void)[] {
  const opens: (() => void)[] = [];
  db.holds.set(charId, pattern.map((h) => {
    if (!h) return null;
    return new Promise<void>((r) => { opens.push(r); });
  }));
  return opens;
}

/** Кооп A+B в подземелье; монстры «спят» (тик комнаты — только шагами теста). */
async function coop(): Promise<{ room: RoomIn; pa: string; pb: string; a: SaveState }> {
  const room = newRoom();
  const a = hero(), b = hero();
  const pa = room.addPlayer(new FakeWs(), `user-${a.charId}`, a, 1);
  const pb = room.addPlayer(new FakeWs(), `user-${b.charId}`, b, 1);
  await settle();
  room.movedAt = 0; room.descend(pa); room.castVote(pb, true);
  expect(room.area).toBe('dungeon');
  room.stop();
  const w = room.session.world;
  for (const m of w.monsters) m.alive = false;
  P(room, pa).pos = { ...w.spawn }; P(room, pb).pos = { ...w.spawn };
  await settle(30);
  return { room, pa, pb, a: P(room, pa).save };
}
/** Героя целят `n` живых монстров в погоне — вдали от входа, выходов и порталов (как в R14: «посреди боя», не у перехода). */
function hunted(room: RoomIn, pid: string, n = 1): void {
  const w = room.session.world;
  const gates = [w.spawn, ...(w.exits ?? []), ...room.decor.filter((d) => d.kind === 'portal')];
  const open = (at: { x: number; y: number }, from: { x: number; y: number }): boolean =>
    isWalkableWorld(w.grid, at.x, at.y) && hasLineOfSight(w.grid, from.x, from.y, at.x, at.y);
  const offs = [[40, 0], [-40, 0], [0, 40], [0, -40], [28, 28], [-28, 28], [28, -28], [-28, -28]] as const;
  const far = w.monsters.filter((x) => gates.every((g) => dist(x.pos, g) > 300));
  const lead = far.find((m) => offs.some(([dx, dy]) => open({ x: m.pos.x + dx, y: m.pos.y + dy }, m.pos)));
  expect(lead, 'на этаже есть монстр вдали от переходов с открытым местом рядом').toBeTruthy();
  const at = { ...lead!.pos };
  const [dx, dy] = offs.find(([ox, oy]) => open({ x: at.x + ox, y: at.y + oy }, at))!;
  const mons = [lead!, ...far.filter((m) => m !== lead).slice(0, n - 1)];
  for (const m of mons) { m.alive = true; m.aiState = 'chase'; }
  P(room, pid).pos = { x: at.x + dx, y: at.y + dy };
}

describe('⭐ R15-02: прощальная запись — последняя запись сессии (не склеивается с ждущим автосейвом)', () => {
  it('запись в пути, автосейв ждёт очереди, за ним выброс; ушёл посреди боя — копия ждущего на версии базы, смерть тела в бою записана со штрафом', async () => {
    const { room, pa, pb, a } = await coop();
    const pot = itemFromBaseId(cfg.get('items.base'), 'healing-potion', undefined, 'drop')!;
    a.inventory.push({ ...pot, pos: findFree(a.inventory, pot.gridW, pot.gridH, cfg.get('balance').inventory) });
    hunted(room, pa, 3);
    // W0 — запись в пути (ворота), J1 — автосейв ждёт очереди (склеенный, `persisting`), W1 — выброс (`writeSoon`) встал за ним.
    const [openW0] = holds(a.charId, [true]);
    void room.persist(pa);
    await settle(2);
    void room.persist(pa);
    await room.handleCmd(pa, { cmd: 'drop', uid: pot.uid }, 901);
    // Уход посреди боя (F5): тело остаётся в бою (R13-03), прощальная — за всем, что уже в очереди.
    void room.removePlayer(pa);
    expect(room.lingering.size, 'тело ушедшего посреди боя — в мире').toBe(1);
    openW0!();
    await settle(60);
    const info = room.disconnected.get(a.charId)!;
    expect(info.saveVersion, `копия ждущего реконнекта — на версии базы (${db.log.join(' | ')})`).toBe(db.versions.get(a.charId));
    // Тело в бою гибнет — штраф смерти и метка «погиб в забеге» ложатся копией ждущего.
    const body = Object.values(room.session.world.players).find((p) => p.save.charId === a.charId)!;
    body.hp = 0; body.alive = false;
    P(room, pb).hp = P(room, pb).maxHp;
    room.step();
    await settle(60);
    expect(db.log.some((l) => l.includes('REJECT')), `ни одной записи мимо версии: ${db.log.join(' | ')}`).toBe(false);
    expect(row(a.charId).gold, 'штраф смерти записан').toBeLessThan(5000);
    expect(row(a.charId).run?.deadAt, 'метка «погиб в забеге» записана').toBeTruthy();
    expect(room.disconnected.get(a.charId)?.saveVersion, 'копия и строка — одной версии').toBe(db.versions.get(a.charId));
  });
});

describe('⭐ R15-06: сроки комнаты — по монотонным часам (шаг настенных часов их не двигает)', () => {
  /** Часы процесса «через `ms`», а настенные — на `wallStep` от настоящих (шаг chrony, миграция ВМ). */
  function later(ms: number, wallStep: number): void {
    const mono = performance.now() + ms, wall = Date.now() + wallStep + ms;
    vi.spyOn(performance, 'now').mockReturnValue(mono);
    vi.spyOn(Date, 'now').mockReturnValue(wall);
  }
  async function soloTown(): Promise<{ room: RoomIn; pa: string; a: SaveState }> {
    const room = newRoom();
    const a = hero();
    const pa = room.addPlayer(new FakeWs(), `user-${a.charId}`, a, 1);
    await settle();
    room.stop();
    return { room, pa, a };
  }

  it('спуск, часы шагнули на минуту назад, 1,6 с спустя — голос за возврат в город проходит (пауза R1-03 не растянулась на минуту)', async () => {
    const { room, pa } = await soloTown();
    room.movedAt = 0; room.descend(pa);
    expect(room.area).toBe('dungeon');
    for (const m of room.session.world.monsters) m.alive = false;
    P(room, pa).pos = { ...room.session.world.spawn };
    later(1_600, -60_000);
    room.returnTown(pa);
    expect(room.area, 'возврат не отказан «Подождите немного»').toBe('town');
  });

  it('часы шагнули назад — автосейв идёт в свой срок (10 с по часам процесса), а не через минуту', async () => {
    const { room, a } = await soloTown();
    await settle(30);
    const writes = (): number => db.log.filter((l) => l.startsWith(`${a.charId} v`)).length;
    room.step();
    await settle(10);
    const w0 = writes();
    later(10_500, -60_000);
    room.step();
    await settle(20);
    expect(writes(), 'автосейв состоялся').toBeGreaterThan(w0);
  });

  it('вайп, часы шагнули назад — возврат в город через 4 с по часам процесса', async () => {
    const { room, pa } = await soloTown();
    room.movedAt = 0; room.descend(pa);
    expect(room.area).toBe('dungeon');
    for (const m of room.session.world.monsters) m.alive = false;
    const p = P(room, pa);
    p.hp = 0; p.alive = false;
    (room as unknown as { onPlayerDeath(pid: string, touched: Set<string>): void }).onPlayerDeath(pa, new Set());
    later(4_500, -60_000);
    room.step();
    expect(room.area, 'вайп вернул в город в срок').toBe('town');
  });
});

describe('⭐ R15-09: выход с арены — не по снимку арены (там стойки нет)', () => {
  const STANCE = 'b-stance-a5';
  const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
  /** Воин 40-го уровня в городе, стойка +15 % жизни включена, здоровье полное (с ней). */
  async function stanced(): Promise<{ room: RoomIn; pid: string; charId: string }> {
    const room = newRoom();
    const a = hero();
    a.level = 40; a.skills[STANCE] = 1;
    const pid = room.addPlayer(new FakeWs(), `user-${a.charId}`, a, 1);
    await settle();
    room.stop();
    room.setInput(pid, { ...idle, cast: STANCE });
    room.step();
    room.setInput(pid, idle);
    room.step();
    const p = P(room, pid);
    expect(p.toggles, 'стойка включена').toContain(STANCE);
    p.hp = p.maxHp;
    return { room, pid, charId: a.charId };
  }
  /** Арена и назад; `arenaSec` — сколько шла арена (часы мира комнаты). */
  function arenaTrip(room: RoomIn, pid: string, arenaSec = 0): void {
    room.movedAt = 0; room.enterArena(pid);
    expect(room.area).toBe('arena');
    room.step();
    expect(P(room, pid).toggles, 'на арене стойка снята').toEqual([]);
    const homes = (room as unknown as { arenaHome: Map<string, { at: number }> }).arenaHome;
    for (const h of homes.values()) h.at -= arenaSec * 1000;
    room.movedAt = 0; room.returnTown(pid);
    expect(room.area).toBe('town');
  }

  it('ушёл на арену в стойке с полным здоровьем, в ней её не включал — вернулся с полным (со стойкой), а не с ~87 %', async () => {
    const { room, pid } = await stanced();
    const before = P(room, pid).hp;
    arenaTrip(room, pid);
    const p = P(room, pid);
    expect(p.toggles, 'стойка вернулась').toContain(STANCE);
    expect(p.hp, 'сразу после арены — то же здоровье').toBeCloseTo(before, 1);
    room.step();
    expect(p.hp, 'и после тика').toBeCloseTo(before, 1);
    expect(p.hp, 'не выше честного максимума').toBeLessThanOrEqual(p.maxHp + 1e-9);
  });

  it('арена шла 10 минут — выносливость не выше пула за вычетом резерва стойки (тик подрезает её лишь в регене — после ввода)', async () => {
    const { room, pid } = await stanced();
    const p = P(room, pid);
    p.hp = p.maxHp * 0.5;
    arenaTrip(room, pid, 600);
    const d = room.session.snapshotOf(pid)!.derived;
    expect(p.stamina, 'резерв стойки (20 %) соблюдён').toBeLessThanOrEqual(d.maxStamina * 0.8 + 1e-6);
    expect(p.hp, 'здоровье — с регеном за арену, до максимума со стойкой').toBeGreaterThan(d.maxHp);
    room.step();
    expect(p.hp, 'тик: максимум со стойкой').toBeCloseTo(p.maxHp, 1);
  });
});

describe('⭐ R16-07: арена — время города и для временных баффов', () => {
  const BUFF = 'b-class-warrior-a5';   // «Боевой клич»: 8 с баффа, откат 12 с
  const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
  type Timers = { skillBuffs: Record<string, number>; skillCd: Record<string, number> };
  /** Воин 40-го уровня в городе только что прокричал клич: бафф и откат — полные. */
  async function shouted(): Promise<{ room: RoomIn; pid: string; t: Timers; buff0: number; cd0: number }> {
    const room = newRoom();
    const a = hero();
    a.level = 40; a.skills[BUFF] = 1;
    const pid = room.addPlayer(new FakeWs(), `user-${a.charId}`, a, 1);
    await settle();
    room.stop();
    room.setInput(pid, { ...idle, cast: BUFF });
    room.step();
    room.setInput(pid, idle);
    const t = P(room, pid) as unknown as Timers;
    const buff0 = t.skillBuffs[BUFF] ?? 0, cd0 = t.skillCd[BUFF] ?? 0;
    expect(buff0, 'бафф идёт').toBeGreaterThan(7.5);
    expect(cd0, 'откат идёт').toBeGreaterThan(11.5);
    return { room, pid, t, buff0, cd0 };
  }
  /** Арена и назад; `arenaSec` — сколько шла арена (часы мира комнаты). */
  function arenaTrip(room: RoomIn, pid: string, arenaSec: number): Timers {
    room.movedAt = 0; room.enterArena(pid);
    expect(room.area).toBe('arena');
    room.step();
    const homes = (room as unknown as { arenaHome: Map<string, { at: number }> }).arenaHome;
    for (const h of homes.values()) h.at -= arenaSec * 1000;
    room.movedAt = 0; room.returnTown(pid);
    expect(room.area).toBe('town');
    return P(room, pid) as unknown as Timers;
  }

  it('30 с на арене — бафф кончился, как и его откат (раньше бафф возвращался полным, а откат — готовым: лишнее окно баффа за круг)', async () => {
    const { room, pid } = await shouted();
    const t = arenaTrip(room, pid, 30);
    expect(t.skillCd[BUFF] ?? 0, 'откат прошёл').toBe(0);
    expect(t.skillBuffs[BUFF], 'и бафф — тоже: время арены для него шло, как в городе').toBeUndefined();
  });

  it('3 с на арене — бафф и откат постарели одинаково, как если бы герой стоял в городе', async () => {
    const { room, pid, buff0, cd0 } = await shouted();
    const t = arenaTrip(room, pid, 3);
    expect(t.skillCd[BUFF] ?? 0).toBeCloseTo(cd0 - 3, 1);
    expect(t.skillBuffs[BUFF] ?? 0, 'бафф — на те же 3 с меньше').toBeCloseTo(buff0 - 3, 1);
    expect((t.skillCd[BUFF] ?? 0) - (t.skillBuffs[BUFF] ?? 0), 'зазор «бафф кончился — откат ещё идёт» тот же').toBeCloseTo(cd0 - buff0, 1);
  });
});
