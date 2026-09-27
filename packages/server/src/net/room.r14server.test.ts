import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  ConfigRegistry, newCharacterSave, generateItem, generateRunPlan, generateFloor, decorSpecsFor, createRng, hasLineOfSight, isWalkableWorld,
  type Item, type ServerFrame, type SaveState, type RunPlan, type RunConfig, type Grid,
} from '@dm/shared';
import { counters, renderMetrics } from './metrics.js';

// Тесты ждут комнату оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решают мок базы и шаги
// комнаты, которые тест делает сам (`step`), а не часы.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ РАУНД 14 (сервер), комната. Комната настоящая; база — маленькая честная (версии сейва).
 *  • R14-01: тело ушедшего посреди боя остаётся в мире ВСЕГДА (не только «при живом напарнике»), а мир идёт, только пока подключён
 *    ЖИВОЙ: мёртвый напарник не держит мир на ходу (тело не гибнет «вне игры», пока некому его защитить), а вход по коду или
 *    «Продолжить» другого снимает паузу вместе с телом в бою;
 *  • R14-02: пати без живых подключённых не уходит с этажа спуском и завершением финала (мёртвый у выхода оживал на новом узле);
 *  • R14-05: мёртвый вещей не бросает;
 *  • R14-09: снаряжение выключенной живьём базы — не на прилавке и не продаётся;
 *  • R14-10: сиды забега и этажей клиенту не уходят, а этажи узлов — от секрета забега, которого у клиента нет;
 *  • R14-13: отказы потолка чтений сундука — свой счётчик, не счётчик кузницы.
 */
type PutArgs = { charId: string; data: SaveState; version: number };
const db = vi.hoisted(() => ({
  versions: new Map<string, number>(), data: new Map<string, unknown>(),
}));
vi.mock('../db/db.js', () => {
  const put = (a: PutArgs): number | null => {
    if (a.version !== (db.versions.get(a.charId) ?? 1)) return null;
    db.versions.set(a.charId, a.version + 1); db.data.set(a.charId, structuredClone(a.data));
    return a.version + 1;
  };
  return {
    putCharacter: async (charId: string, _u: string, data: SaveState, version: number) => put({ charId, data, version }),
    putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
    getCharacter: async (charId: string) => {
      const d = db.data.get(charId);
      return d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null;
    },
    getAccountStash: async () => null,
    putAccountStash: () => Promise.resolve(),
    getRunLedger: async () => [],
    mergeRunLedger: () => Promise.resolve(),
  };
});
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Mon = { alive: boolean; pos: { x: number; y: number }; aiState: string; windup: unknown };
type P = { hp: number; maxHp: number; alive: boolean; pos: { x: number; y: number }; save: SaveState };
type Info = { fled: boolean; safe?: boolean; paid: boolean; save: SaveState };
type Drop = { id: number; item?: { uid: string } };
type RoomIn = {
  area: string; movedAt: number; runNodeId: string | null; strandAt: number; wipeAt: number;
  runPlan: RunPlan | null; runConfig: RunConfig | null; vote: unknown;
  decor: { kind: string; x: number; y: number }[];
  disconnected: Map<string, Info>; lingering: Map<string, unknown>;
  session: {
    world: {
      players: Record<string, P>; spawn: { x: number; y: number }; timeMs: number; monsters: Mon[];
      exits?: { x: number; y: number }[]; drops: Drop[]; grid: Grid;
    };
  };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  reconnect(ws: unknown, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): Promise<{ saved: boolean }>;
  returnTown(pid: string): void; castVote(pid: string, yes: boolean): void; descend(pid: string): void;
  onPlayerDeath(pid: string, touched: Set<string>): void;
  enterNode(nodeId: string): void;
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
  vi.restoreAllMocks();
});

class FakeWs {
  open = true; readonly ip = '127.0.0.1'; frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void {} onClose(): void {}
  all<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }>[] {
    return this.frames.filter((f) => f.t === t) as Extract<ServerFrame, { t: T }>[];
  }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined { return this.all(t).at(-1); }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
let seq = 0;
function newRoom(reg: ConfigRegistry = cfg): RoomIn {
  const room = new RoomCtor(`R14S${++seq}`, reg, hooks);
  rooms.push(room);
  return room;
}
function hero(gold = 5000): SaveState {
  const charId = `char-r14s-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  s.level = 30; s.gold = gold; s.attributes.vitality = 60;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const ready = (room: RoomIn): void => { room.movedAt = 0; };
const P = (room: RoomIn, pid: string): P => room.session.world.players[pid]!;
const fromDb = (charId: string): [SaveState, number] => [structuredClone(db.data.get(charId)) as SaveState, db.versions.get(charId)!];
const row = (charId: string): SaveState => db.data.get(charId) as SaveState;
const bodyOf = (room: RoomIn, charId: string): P | undefined => Object.values(room.session.world.players).find((p) => p.save.charId === charId);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Кооп A+B в подземелье; монстры «спят» (тик комнаты — только шагами теста). */
async function coop(): Promise<{ room: RoomIn; pa: string; pb: string; a: SaveState; b: SaveState; wsA: FakeWs; wsB: FakeWs; node: string | null }> {
  const room = newRoom();
  const a = hero(), b = hero();
  const wsA = new FakeWs(), wsB = new FakeWs();
  const pa = room.addPlayer(wsA, `user-${a.charId}`, a, 1);
  const pb = room.addPlayer(wsB, `user-${b.charId}`, b, 1);
  await settle();
  ready(room); room.descend(pa); room.castVote(pb, true);
  expect(room.area).toBe('dungeon');
  room.stop();   // тик — только шагами теста
  const w = room.session.world;
  for (const m of w.monsters) m.alive = false;
  P(room, pa).pos = { ...w.spawn }; P(room, pb).pos = { ...w.spawn };
  return { room, pa, pb, a: P(room, pa).save, b: P(room, pb).save, wsA, wsB, node: room.runNodeId };
}
/** Соло A в подземелье; монстры «спят». */
async function solo(): Promise<{ room: RoomIn; pa: string; a: SaveState }> {
  const room = newRoom();
  const a = hero();
  const pa = room.addPlayer(new FakeWs(), `user-${a.charId}`, a, 1);
  await settle();
  ready(room); room.descend(pa);
  expect(room.area).toBe('dungeon');
  room.stop();
  for (const m of room.session.world.monsters) m.alive = false;
  return { room, pa, a: P(room, pa).save };
}
/** A погиб при живом B — не вайп (штраф взят, окно смерти с потерями). */
function killA(room: RoomIn, pa: string): void {
  const p = P(room, pa);
  p.hp = 0; p.alive = false;
  room.onPlayerDeath(pa, new Set());
}
/** Точки перехода этажа (вход, выходы, порталы) — от них «загнанный» далеко. */
const gates = (room: RoomIn): { x: number; y: number }[] =>
  [room.session.world.spawn, ...(room.session.world.exits ?? []), ...room.decor.filter((d) => d.kind === 'portal')];
/**
 * Героя целят `n` живых монстров в погоне — вдали от входа, выходов и порталов. Этаж у каждого забега свой (сид и ключ этажей —
 * случайные): точки героя и монстров — проходимые и на виду у первого монстра, иначе «погоня» шла бы в обход стены весь тест.
 */
function hunted(room: RoomIn, pid: string, n = 1): Mon[] {
  const w = room.session.world;
  const open = (at: { x: number; y: number }, from: { x: number; y: number }): boolean =>
    isWalkableWorld(w.grid, at.x, at.y) && hasLineOfSight(w.grid, from.x, from.y, at.x, at.y);
  const offs = [[40, 0], [-40, 0], [0, 40], [0, -40], [28, 28], [-28, 28], [28, -28], [-28, -28]] as const;
  const far = w.monsters.filter((x) => gates(room).every((g) => dist(x.pos, g) > 300));
  const lead = far.find((m) => offs.some(([dx, dy]) => open({ x: m.pos.x + dx, y: m.pos.y + dy }, m.pos)));
  expect(lead, 'на этаже есть монстр вдали от переходов с открытым местом рядом').toBeTruthy();
  const at = { ...lead!.pos };
  const [dx, dy] = offs.find(([ox, oy]) => open({ x: at.x + ox, y: at.y + oy }, at))!;
  const mons = [lead!, ...far.filter((m) => m !== lead).slice(0, n - 1)];
  expect(mons.length, 'монстров хватает').toBe(n);
  mons.forEach((m, i) => {
    m.alive = true; m.aiState = 'chase';
    if (!i) return;
    const spot = offs.map(([ox, oy]) => ({ x: at.x + ox * 0.6, y: at.y + oy * 0.6 })).filter((q) => open(q, at))[i - 1] ?? at;
    m.pos = { ...spot };
  });
  P(room, pid).pos = { x: at.x + dx, y: at.y + dy };
  return mons;
}
/** Шаги мира; живым подключённым (`keep`) — полное здоровье каждый шаг: бой идёт, пока тело «вне игры». */
function steps(room: RoomIn, n: number, keep: string[] = []): void {
  for (let t = 0; t < n; t++) { for (const pid of keep) { const p = P(room, pid); if (p.alive) p.hp = p.maxHp; } room.step(); }
}

describe('⭐ R14-01: тело ушедшего посреди боя — в мире всегда; мир идёт, только пока подключён живой', () => {
  it('(а) A мёртв и подключён, B (30%) отвалился посреди боя — 8 с мира: тело B цело, штрафа и вайпа нет; вернулся — тем же, бой идёт', async () => {
    const { room, pa, pb, b, node } = await coop();
    killA(room, pa);
    const mons = hunted(room, pb, 3);
    const p = P(room, pb);
    p.hp = Math.round(p.maxHp * 0.3);
    const hp = p.hp, spot = { ...p.pos };
    await room.removePlayer(pb);   // F5 посреди боя
    steps(room, 240);
    await settle();
    expect(room.disconnected.get(b.charId)?.paid, 'тело B не погибло «вне игры»').toBe(false);
    expect(row(b.charId).gold, 'золото B цело').toBe(5000);
    expect(row(b.charId).run?.currentNodeId, 'забег B цел').toBe(node);
    expect(room.runPlan, 'вайпа нет').not.toBeNull();
    expect(room.area).toBe('dungeon');
    const [save, v] = fromDb(b.charId);
    const back = room.reconnect(new FakeWs(), `user-${b.charId}`, save, v);
    expect(P(room, back).alive, 'вернулся живым').toBe(true);
    expect(P(room, back).hp, 'с тем же здоровьем').toBe(hp);
    expect(dist(P(room, back).pos, spot), 'на том же месте').toBeLessThan(1);
    expect(mons.some((m) => m.alive && m.aiState === 'chase'), 'бой не кончился — монстры в погоне').toBe(true);
  });

  it('(б) соло: A (5 HP) в погоне закрыл вкладку последним — тело в мире; альт B вошёл по коду — бой идёт с телом: A вернулся мёртвым или ниже 5 HP', async () => {
    const { room, pa, a } = await solo();
    hunted(room, pa, 3);
    P(room, pa).hp = 5;
    await room.removePlayer(pa);
    expect(room.lingering.size, 'тело ушедшего посреди боя — в мире и в соло').toBe(1);
    const b = hero();
    const pb = room.addPlayer(new FakeWs(), `user-${b.charId}`, b, 1);   // вход по коду снимает паузу
    room.stop();
    P(room, pb).pos = { ...room.session.world.spawn };
    steps(room, 150, [pb]);
    await settle();
    const [save, v] = fromDb(a.charId);
    const back = room.reconnect(new FakeWs(), `user-${a.charId}`, save, v);
    const e = P(room, back);
    expect(!e.alive || e.hp < 5, `A вернулся ${e.alive ? `живым с ${e.hp} HP` : 'мёртвым'}`).toBe(true);
    if (!e.alive) expect(row(a.charId).gold, 'погиб — штраф взят').toBeLessThan(5000);
  });

  it('(б) пати: B ушёл спокойно первым, A (5 HP) в погоне — последним; «Продолжить» B — бой идёт с телом A', async () => {
    const { room, pa, pb, a, b } = await coop();
    hunted(room, pa, 3);
    P(room, pa).hp = 5;
    await room.removePlayer(pb);   // у входа, монстров на нём нет
    await room.removePlayer(pa);
    await settle();
    expect(room.lingering.size, 'тело A — в мире, хоть он и ушёл последним').toBe(1);
    const [sb, vb] = fromDb(b.charId);
    const back = room.reconnect(new FakeWs(), `user-${b.charId}`, sb, vb);
    room.stop();
    P(room, back).pos = { ...room.session.world.spawn };
    steps(room, 150, [back]);
    await settle();
    const [sa, va] = fromDb(a.charId);
    const e = P(room, room.reconnect(new FakeWs(), `user-${a.charId}`, sa, va));
    expect(!e.alive || e.hp < 5, `A вернулся ${e.alive ? `живым с ${e.hp} HP` : 'мёртвым'}`).toBe(true);
  });

  it('A и B живы, B ушёл посреди боя, потом A погиб — мир встал (тело B цело), возврат застрявших ждёт грейс; B вернулся тем же', async () => {
    const { room, pa, pb, b } = await coop();
    hunted(room, pb, 3);
    const p = P(room, pb);
    p.hp = Math.round(p.maxHp * 0.3);
    const hp = p.hp;
    await room.removePlayer(pb);
    expect(room.lingering.size).toBe(1);
    killA(room, pa);
    expect(room.strandAt - Date.now(), 'пати застряла, но ждёт отвалившегося посреди боя весь грейс').toBeGreaterThan(60_000);
    steps(room, 240);
    await settle();
    expect(room.disconnected.get(b.charId)?.paid).toBe(false);
    expect(bodyOf(room, b.charId)?.hp, 'тело B — не тронуто').toBe(hp);
    const [save, v] = fromDb(b.charId);
    const back = room.reconnect(new FakeWs(), `user-${b.charId}`, save, v);
    expect(P(room, back).alive).toBe(true);
    expect(P(room, back).hp).toBe(hp);
    expect(room.strandAt, 'живой вернулся — возврат снят').toBe(0);
  });

  it('контроль: соло F5 посреди боя (30%) — мир на паузе, вернулся тем же, без штрафа', async () => {
    const { room, pa, a } = await solo();
    hunted(room, pa, 3);
    const p = P(room, pa);
    p.hp = Math.round(p.maxHp * 0.3);
    const hp = p.hp, spot = { ...p.pos };
    await room.removePlayer(pa);
    steps(room, 240);   // шаг комнаты без живых подключённых мир не двигает
    await settle();
    const [save, v] = fromDb(a.charId);
    const back = room.reconnect(new FakeWs(), `user-${a.charId}`, save, v);
    expect(P(room, back).alive).toBe(true);
    expect(P(room, back).hp).toBe(hp);
    expect(dist(P(room, back).pos, spot)).toBeLessThan(1);
    expect(row(a.charId).gold).toBe(5000);
    expect(room.lingering.size, 'вернулся — тело снова он').toBe(0);
  });

  it('контроль (R13-03): живой напарник подключён — тело в бою гибнет, штраф ему', async () => {
    const { room, pa, pb, a } = await coop();
    hunted(room, pa, 4);
    P(room, pa).hp = 1;
    await room.removePlayer(pa);
    steps(room, 240, [pb]);
    await settle();
    expect(room.disconnected.get(a.charId)?.paid).toBe(true);
    expect(row(a.charId).gold).toBeLessThan(5000);
  });
});

describe('⭐ R14-02: пати без живых подключённых не уходит с этажа спуском и завершением', () => {
  it('A мёртв у выхода, B (1 HP) отвалился посреди боя: `descend` мёртвого A — отказ; узел тот же, A не ожил; срок вышел — вайп', async () => {
    const { room, pa, pb, a, node } = await coop();
    const w = room.session.world;
    P(room, pa).pos = { ...w.exits![0]! };
    killA(room, pa);
    hunted(room, pb);
    P(room, pb).hp = 1;
    await room.removePlayer(pb);
    await settle();
    ready(room);
    room.descend(pa);
    await settle();
    expect(room.runNodeId, 'спуска нет').toBe(node);
    expect(P(room, pa).alive, 'A не ожил').toBe(false);
    expect(a.run?.currentNodeId).toBe(node);
    expect(room.vote, 'голосование не открыто').toBeNull();
    room.strandAt = 1;   // срок возврата застрявших вышел
    room.step();
    await settle();
    expect(room.area).toBe('town');
    expect(a.run, 'спокойно ушедших нет — вайп: забег A кончен').toBeUndefined();
  });

  it('голосование за спуск открыл живой B у выхода и ушёл; мёртвый A «за» — перехода нет', async () => {
    const { room, pa, pb, a, node } = await coop();
    const w = room.session.world;
    killA(room, pa);
    P(room, pb).pos = { ...w.exits![0]! };
    ready(room);
    room.descend(pb);
    expect(room.vote, 'голосование открыто').not.toBeNull();
    await room.removePlayer(pb);
    await settle();
    room.castVote(pa, true);
    await settle();
    expect(room.runNodeId).toBe(node);
    expect(P(room, pa).alive).toBe(false);
    expect(a.run?.currentNodeId).toBe(node);
    expect(room.vote).toBeNull();
  });

  it('финал: A мёртв у портала, B ушёл — «завершить» мёртвого A отказано, забег не завершён', async () => {
    const { room, pa, pb, a } = await coop();
    room.enterNode(room.runPlan!.finaleId!);
    room.stop();
    const w = room.session.world;
    for (const m of w.monsters) m.alive = false;
    const portal = room.decor.find((d) => d.kind === 'portal');
    expect(portal, 'на финале есть портал').toBeTruthy();
    P(room, pa).pos = { x: portal!.x, y: portal!.y };
    P(room, pb).pos = { ...w.spawn };
    killA(room, pa);
    await room.removePlayer(pb);
    await settle();
    ready(room);
    room.descend(pa);
    await settle();
    expect(room.area, 'забег не завершён').toBe('dungeon');
    expect(room.runPlan).not.toBeNull();
    expect(P(room, pa).alive).toBe(false);
    expect(a.run?.currentNodeId).toBe(room.runPlan!.finaleId);
  });

  it('контроль: B жив и подключён у выхода — мёртвый A зовёт спуск, B «за»: узел следующий, A ожил', async () => {
    const { room, pa, pb, node } = await coop();
    const w = room.session.world;
    P(room, pa).pos = { ...w.exits![0]! };
    P(room, pb).pos = { ...w.exits![0]! };
    killA(room, pa);
    ready(room);
    room.descend(pa);
    room.castVote(pb, true);
    expect(room.runNodeId).not.toBe(node);
    expect(P(room, pa).alive, 'A ожил на новом узле').toBe(true);
  });
});

/** Итоги команд (`cmdResult`) клиенту — по порядку. */
const results = (ws: FakeWs): { ok: boolean; reason?: string }[] => ws.all('cmdResult') as unknown as { ok: boolean; reason?: string }[];

describe('⭐ R14-05: мёртвый вещей не бросает', () => {
  it('кооп: A погиб с вещью в сумке — `drop` отказан, вещь в сумке, на земле ничего', async () => {
    const { room, pa, wsA, a } = await coop();
    const base = cfg.get('items.base').find((b) => b.kind === 'weapon' && b.enabled !== false)!;
    const it: Item = generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'),
      { dropBias: 1, itemLevel: 5, baseId: base.id, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'normal',
        maxReqTotal: cfg.get('balance').maxTotalRequirement }, createRng(7));
    killA(room, pa);   // штраф смерти берёт вещи сумки наугад — наша ложится после
    it.pos = { x: 0, y: 5 };
    a.inventory.push(it);
    const drops = room.session.world.drops.length;
    await room.handleCmd(pa, { cmd: 'drop', uid: it.uid }, 900);
    expect(results(wsA).at(-1)).toMatchObject({ ok: false });
    expect(a.inventory.some((i) => i.uid === it.uid), 'вещь в сумке').toBe(true);
    expect(room.session.world.drops.length, 'на земле ничего').toBe(drops);
  });
});

describe('⭐ R14-09: снаряжение выключенной живьём базы — не на прилавке и не продаётся', () => {
  it('базу вещи с прилавка выключили в редакторе — покупка отказана (золото и сумка целы), на прилавке её больше нет', async () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const room = newRoom(reg);
    const ws = new FakeWs();
    const s = hero(10_000_000);
    const pid = room.addPlayer(ws, `user-${s.charId}`, s, 1);
    await settle();
    const shelf = (ws.last('shop') as unknown as { items: Item[] }).items;
    const gear = shelf.find((i) => i.kind === 'weapon' || i.kind === 'armor');
    expect(gear, 'на прилавке есть снаряжение').toBeTruthy();
    const base = structuredClone(reg.get('items.base')).map((b) => (b.id === gear!.baseId ? { ...b, enabled: false } : b));
    reg.reload({ 'items.base': base } as never);
    const gold = s.gold, bag = s.inventory.length;
    await room.handleCmd(pid, { cmd: 'buy', uid: gear!.uid }, 1);
    expect(results(ws).at(-1)).toMatchObject({ ok: false });
    expect(s.gold, 'золото цело').toBe(gold);
    expect(s.inventory.length, 'в сумке ничего нового').toBe(bag);
    const after = (ws.last('shop') as unknown as { items: Item[] }).items;
    expect(after.some((i) => i.baseId === gear!.baseId), 'выключенной базы на прилавке нет').toBe(false);
    // Контроль: вещь включённой базы покупается как прежде.
    const other = after.find((i) => (i.kind === 'weapon' || i.kind === 'armor') && i.baseId !== gear!.baseId)!;
    await room.handleCmd(pid, { cmd: 'buy', uid: other.uid, maxGold: 10_000_000 }, 2);
    expect(results(ws).at(-1)).toMatchObject({ ok: true });
  });
});

describe('⭐ R14-10: сиды забега и этажей клиенту не уходят', () => {
  it('кадры `runPlan`, `joined` и `saveUpdate` — без сидов и ключа этажей', async () => {
    const { room, wsA, pb, b } = await coop();
    const plans = wsA.all('runPlan');
    expect(plans.length, 'план пришёл').toBeGreaterThan(0);
    for (const f of plans) {
      const plan = f.plan as unknown as Record<string, unknown> & { nodes: { floorSpec: Record<string, unknown> }[] };
      expect('seed' in plan, 'сид забега в плане').toBe(false);
      for (const n of plan.nodes) expect('seed' in n.floorSpec, 'сид этажа в плане').toBe(false);
    }
    const saves = wsA.all('saveUpdate').map((f) => f.save);
    expect(saves.some((s) => s.run), 'сейв с забегом приходил').toBe(true);
    for (const s of saves) {
      const c = s.run?.config as unknown as Record<string, unknown> | undefined;
      if (c) { expect('seed' in c).toBe(false); expect('floorKey' in c).toBe(false); }
    }
    // Вошедший посреди забега (по коду, реконнект) — то же.
    await room.removePlayer(pb);
    await settle();
    const ws = new FakeWs();
    const [save, v] = fromDb(b.charId);
    expect(save.run?.config.seed, 'в базе сид есть — он серверный').toBeTypeOf('number');
    room.reconnect(ws, `user-${b.charId}`, save, v);
    const c = ws.last('joined')!.save.run?.config as unknown as Record<string, unknown>;
    expect(c, 'забег в сейве входа').toBeTruthy();
    expect('seed' in c).toBe(false);
    expect('floorKey' in c).toBe(false);
    expect('seed' in (ws.last('runPlan')!.plan as unknown as Record<string, unknown>)).toBe(false);
  });

  it('⭐ зная всё, кроме ключа этажей (даже сид забега), этаж узла впереди наперёд не собрать; сервер собирает его сам', async () => {
    const { room } = await coop();
    const run = room.runConfig!;
    expect(typeof (run as { floorKey?: unknown }).floorKey, 'у нового забега есть ключ этажей').toBe('string');
    const snap = cfg.snapshot();
    const floorOf = (spec: RunPlan['nodes'][number]['floorSpec']) => {
      const biome = snap.biomes.find((x) => x.id === spec.biomeId) ?? snap.biomes[0]!;
      const f = generateFloor(spec, snap['room-prefabs'], decorSpecsFor(snap.objects, snap.models, biome.id), undefined,
        { tiers: snap.chests, perFloor: snap.balance.loot.chestsPerFloor });
      return JSON.stringify({ spawn: f.spawn, exits: f.exits, chests: f.chests });
    };
    // Самый сильный клиент: сид забега подобран (или утёк), граф и узлы — те же; ключа этажей нет.
    const guess = generateRunPlan(cfg, { ...run, floorKey: undefined } as RunConfig);
    const cur = room.runPlan!.nodes.find((n) => n.id === room.runNodeId)!;
    let differ = 0;
    for (const e of cur.edges) {
      const mine = room.runPlan!.nodes.find((n) => n.id === e.to)!;
      const theirs = guess.nodes.find((n) => n.id === e.to)!;
      expect(theirs.type, 'граф тот же').toBe(mine.type);
      if (floorOf(mine.floorSpec) !== floorOf(theirs.floorSpec)) differ++;
    }
    expect(differ, 'ни один этаж впереди не совпал с догадкой клиента').toBe(cur.edges.length);
    // Текущий этаж комнаты — именно серверный (от ключа), а не догадка клиента.
    const here = JSON.parse(floorOf(cur.floorSpec)) as { spawn: { x: number; y: number } };
    expect(room.session.world.spawn).toEqual(here.spawn);
  });
});

describe('⭐ R14-13: отказы потолка чтений сундука — свой счётчик', () => {
  it('поток «открыть сундук» — растёт счётчик сундука, а не кузницы; поток разборов у кузнеца — только кузницы', async () => {
    const s = hero();
    const room = newRoom();
    const pid = room.addPlayer(new FakeWs(), `user-${s.charId}`, s, 1);
    await settle();
    const c0 = counters as unknown as Record<string, number>;
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    try {
      const forge0 = c0.cmdRateLimited!, stash0 = c0.cmdStashRateLimited ?? 0;
      for (let i = 0; i < 60; i++) await room.handleCmd(pid, { cmd: 'stashOpen' }, 10 + i);
      expect((c0.cmdStashRateLimited ?? 0) - stash0, 'отказы потолка сундука').toBeGreaterThanOrEqual(20);
      expect(c0.cmdRateLimited! - forge0, 'счётчик кузницы не тронут').toBe(0);
      const s2 = hero();
      const pid2 = room.addPlayer(new FakeWs(), `user-${s2.charId}`, s2, 1);
      await settle();
      const forge1 = c0.cmdRateLimited!, stash1 = c0.cmdStashRateLimited ?? 0;
      for (let i = 0; i < 10; i++) await room.handleCmd(pid2, { cmd: 'forgeSalvage', uid: 'nope' }, 100 + i);
      expect(c0.cmdRateLimited! - forge1, 'отказы потолка кузницы').toBe(5);
      expect((c0.cmdStashRateLimited ?? 0) - stash1).toBe(0);
    } finally { clock.mockRestore(); }
    const text = renderMetrics();
    expect(text).toMatch(/^# HELP dm_cmd_stash_rate_limited_total .*R12-13/m);
    expect(text).toMatch(/^dm_cmd_stash_rate_limited_total \d+$/m);
    expect(text).toMatch(/^# HELP dm_farewell_forgotten_total .*R12-04/m);
  });
});
