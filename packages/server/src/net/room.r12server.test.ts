import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ConfigRegistry, newCharacterSave, generateRunPlan, materialItem, packInventory, type Item, type ServerFrame, type SaveState,
} from '@dm/shared';
import { CommitUnknown } from '../db/errors.js';

/**
 * ⭐ РАУНД 12 (сервер), комната. Комната настоящая; база — маленькая честная (версии сейва), без часов.
 *  • R12-02: вход по коду в комнату, откуда герой ушёл РАНЬШЕ, больше не лечит: запись ухода (R4-06) старше сейва, который с тех пор
 *    писала другая комната, — пулы из сейва («больница»: друг или вторая вкладка держит комнату, герой бьётся где-то ещё и
 *    возвращается к нему полным).
 */
type PutArgs = { charId: string; data: SaveState; version: number; reason?: string; reasons?: ReadonlyMap<string, string> };
const db = vi.hoisted(() => ({
  versions: new Map<string, number>(), data: new Map<string, unknown>(),
  /** Записи сейва (обе ручки), по порядку: кто, какой версией, с какой причиной и картой причин по вещи. */
  puts: [] as { kind: 'save' | 'stash'; charId: string; version: number; reason?: string; reasons?: ReadonlyMap<string, string> }[],
  /** R12-11: свод забега и запись «сейв + сундук» — ждут, пока тест не откроет. */
  ledgerGate: null as Promise<void> | null,
  stashGate: null as Promise<void> | null,
  /** Что ответит запись «сейв + сундук» (по умолчанию — сундук обогнали, D8). */
  stashImpl: null as ((a: { charId: string; data: SaveState; version: number; stash: unknown }) => Promise<unknown>) | null,
  /** Сундуки аккаунтов (их пишет `stashImpl`, если хочет): userId → строка. */
  stashes: new Map<string, { data: unknown; version: number }>(),
  /** R12-13: сколько раз сундук аккаунта читался из базы. */
  stashReads: 0,
}));
vi.mock('../db/db.js', () => {
  const put = (a: PutArgs): number | null => {
    if (a.version !== (db.versions.get(a.charId) ?? 1)) return null;
    db.versions.set(a.charId, a.version + 1); db.data.set(a.charId, structuredClone(a.data));
    return a.version + 1;
  };
  return {
    putCharacter: (charId: string, _u: string, data: SaveState, version: number, reason?: string, reasons?: ReadonlyMap<string, string>) => {
      db.puts.push({ kind: 'save', charId, version, reason, reasons: reasons && new Map(reasons) });
      return Promise.resolve(put({ charId, data, version }));
    },
    putCharacterWithStash: async (
      charId: string, userId: string, data: SaveState, version: number, stash: unknown, _sv: number, reason?: string, reasons?: ReadonlyMap<string, string>,
    ) => {
      db.puts.push({ kind: 'stash', charId, version, reason, reasons: reasons && new Map(reasons) });
      if (db.stashGate) await db.stashGate;
      if (db.stashImpl) {
        const r = await db.stashImpl({ charId, data, version, stash }) as { ok?: boolean; stashVersion?: number };
        if (r.ok) db.stashes.set(userId, { data: structuredClone(stash), version: r.stashVersion ?? 1 });
        return r;
      }
      return { ok: false, conflict: 'stash' };
    },
    getCharacter: (charId: string) => {
      const d = db.data.get(charId);
      return Promise.resolve(d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null);
    },
    getAccountStash: (userId: string) => {
      db.stashReads++;
      const r = db.stashes.get(userId);
      return Promise.resolve(r ? { data: structuredClone(r.data), version: r.version } : null);
    },
    putAccountStash: () => Promise.resolve(),
    getRunLedger: async () => { if (db.ledgerGate) await db.ledgerGate; return []; },
    mergeRunLedger: () => Promise.resolve(),
  };
});
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type P = {
  hp: number; mana: number; stamina: number; maxHp: number; alive: boolean; pos: { x: number; y: number }; save: SaveState;
  skillCd: Record<string, number>; debuffs: Record<string, unknown>;
};
type RoomIn = {
  area: string; movedAt: number; runNodeId: string | null; strandAt: number;
  disconnected: Map<string, { fled: boolean; safe?: boolean; paid: boolean }>;
  session: {
    saveHeld: Set<string>;
    world: { players: Record<string, P>; spawn: { x: number; y: number }; timeMs: number; monsters: { alive: boolean }[] };
  };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  reconnect(ws: unknown, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): Promise<{ saved: boolean; retry?: () => Promise<{ saved: boolean }> }>;
  enterArena(pid: string): void; returnTown(pid: string): void; castVote(pid: string, yes: boolean): void; descend(pid: string): void;
  onPlayerDeath(pid: string, touched: Set<string>): void;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
  resuming: boolean;
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
  db.ledgerGate = null; db.stashGate = null; db.stashImpl = null;
});

class FakeWs {
  open = true; readonly ip = '127.0.0.1'; frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void {} onClose(): void {}
  died(): Extract<ServerFrame, { t: 'died' }>[] { return this.frames.filter((f) => f.t === 'died') as Extract<ServerFrame, { t: 'died' }>[]; }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Часы сервера сдвинулись (метка `save.vitals.at` — `Date.now`): запись другой комнаты позже ухода отсюда. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
let seq = 0;
function newRoom(): RoomIn {
  const room = new RoomCtor(`R12S${++seq}`, cfg, hooks);
  rooms.push(room);
  return room;
}
function hero(): SaveState {
  const charId = `char-r12s-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  s.level = 30; s.gold = 5000; s.attributes.vitality = 60;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const ready = (room: RoomIn): void => { room.movedAt = 0; };
const P = (room: RoomIn, pid: string): P => room.session.world.players[pid]!;
/** Сейв героя из базы — как его читает вход (`RoomManager.join`). */
const fromDb = (charId: string): [SaveState, number] => [structuredClone(db.data.get(charId)) as SaveState, db.versions.get(charId)!];
/** Сколько здоровья даёт реген за время теста (тиков — единицы): щедрый потолок. */
const REGEN_SLACK = 5;

/** Герой ранен в ДРУГОЙ комнате и ушёл оттуда: в базе — низкие пулы. Возвращает, сколько здоровья записано. */
async function hurtElsewhere(h: SaveState): Promise<number> {
  await tick();
  const other = newRoom();
  const [save, v] = fromDb(h.charId);
  const pid = other.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
  await settle();
  const p = P(other, pid);
  const low = Math.max(1, Math.round(p.maxHp * 0.05));
  p.hp = low; p.mana = 0; p.stamina = 0;
  await other.removePlayer(pid);
  await settle();
  expect((db.data.get(h.charId) as SaveState).vitals?.hp, 'в базе — раненым').toBeLessThanOrEqual(low + REGEN_SLACK);
  return low;
}

describe('⭐ R12-02: «больница» — вход по коду в комнату, откуда ушёл раньше, не лечит', () => {
  it('ушёл из города друга полным → ранен в другой комнате → вход по коду к другу: пулы из сейва, а не полные', async () => {
    const t = newRoom();
    t.addPlayer(new FakeWs(), 'user-friend', hero(), 1);   // друг держит комнату
    const h = hero();
    const pid = t.addPlayer(new FakeWs(), `user-${h.charId}`, h, 1);
    await settle();
    const max = P(t, pid).maxHp;
    expect(P(t, pid).hp).toBe(max);
    await t.removePlayer(pid);   // запись ухода: полный
    await settle();
    const low = await hurtElsewhere(h);
    const [save, v] = fromDb(h.charId);
    const back = t.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    expect(P(t, back).hp, `полный ${max}, в сейве ${low}`).toBeLessThanOrEqual(low + REGEN_SLACK);
    expect(P(t, back).mana).toBeLessThanOrEqual(REGEN_SLACK);
    await settle();
    expect((db.data.get(h.charId) as SaveState).vitals?.hp, 'и в базе — раненым').toBeLessThanOrEqual(low + REGEN_SLACK);
  });

  it('обратное: ушёл раненым с откатами → отдохнул в другой комнате до полного → вход по коду: полный, без старых откатов', async () => {
    const t = newRoom();
    t.addPlayer(new FakeWs(), 'user-friend', hero(), 1);
    const h = hero();
    const pid = t.addPlayer(new FakeWs(), `user-${h.charId}`, h, 1);
    await settle();
    const p = P(t, pid);
    const max = p.maxHp;
    p.hp = Math.round(max * 0.1); p.skillCd = { 'probe-skill': 30 };
    await t.removePlayer(pid);
    await settle();
    await tick();
    const rest = newRoom();   // отдохнул: вошёл полным (реген за время вне игры) и вышел
    const [s1, v1] = fromDb(h.charId);
    const rp = rest.addPlayer(new FakeWs(), `user-${h.charId}`, s1, v1);
    await settle();
    P(rest, rp).hp = max;
    await rest.removePlayer(rp);
    await settle();
    const [save, v] = fromDb(h.charId);
    const back = t.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    expect(P(t, back).hp).toBe(max);
    expect(P(t, back).skillCd['probe-skill'] ?? 0, 'старые откаты этой комнаты — не его').toBe(0);
  });

  it('контроль (R4-06): ушёл раненым с откатами и вернулся, нигде больше не играв, — таким же: здоровье и откаты', async () => {
    const t = newRoom();
    t.addPlayer(new FakeWs(), 'user-friend', hero(), 1);
    const h = hero();
    const pid = t.addPlayer(new FakeWs(), `user-${h.charId}`, h, 1);
    await settle();
    const p = P(t, pid);
    const hurt = Math.round(p.maxHp * 0.3);
    p.hp = hurt; p.skillCd = { 'probe-skill': 30 };
    await t.removePlayer(pid);
    await settle();
    await tick();
    const [save, v] = fromDb(h.charId);
    const back = t.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    expect(P(t, back).hp).toBe(hurt);
    expect(P(t, back).skillCd['probe-skill']).toBe(30);
  });

  it('арена: ушёл с арены (дома — полный) → ранен в другой комнате → арена кончилась → вход по коду: пулы из сейва', async () => {
    const t = newRoom();
    const pf = t.addPlayer(new FakeWs(), 'user-friend', hero(), 1);
    const h = hero();
    const pid = t.addPlayer(new FakeWs(), `user-${h.charId}`, h, 1);
    await settle();
    ready(t); t.enterArena(pid); t.castVote(pf, true);
    expect(t.area).toBe('arena');
    await t.removePlayer(pid);
    await settle();
    const low = await hurtElsewhere(h);
    ready(t); t.returnTown(pf);
    expect(t.area).toBe('town');
    const [save, v] = fromDb(h.charId);
    const back = t.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    expect(P(t, back).hp).toBeLessThanOrEqual(low + REGEN_SLACK);
  });

  it('арена: ушёл с арены → ранен в другой комнате → вернулся на ТУ ЖЕ арену → бой кончился: в городе — пулы из сейва', async () => {
    const t = newRoom();
    const pf = t.addPlayer(new FakeWs(), 'user-friend', hero(), 1);
    const h = hero();
    const pid = t.addPlayer(new FakeWs(), `user-${h.charId}`, h, 1);
    await settle();
    ready(t); t.enterArena(pid); t.castVote(pf, true);
    expect(t.area).toBe('arena');
    await t.removePlayer(pid);
    await settle();
    const low = await hurtElsewhere(h);
    const [save, v] = fromDb(h.charId);
    const back = t.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    expect(t.area).toBe('arena');
    ready(t); t.returnTown(pf); t.castVote(back, true);
    expect(t.area).toBe('town');
    expect(P(t, back).hp).toBeLessThanOrEqual(low + REGEN_SLACK);
  });
});

/**
 * ⭐ R12-07: КООП — ПОГИБ, А ПОСЛЕДНИЙ ЖИВОЙ УШЁЛ. Раньше решение «вайп» принималось только на смерти: A погиб при живом B (ждёт
 * пати), B закрыл вкладку — и A стоял мёртвым в подземелье вечно (тик шёл, возврата не было), а «Продолжить» возвращало его в то же
 * мёртвое ожидание. Выход был только «Завершить» (штраф за забег) — или модифицированный клиент с `return`. Теперь такая пати уходит
 * в город сама, как ушла бы голосованием: забег припаркован, спокойно ушедший — `safe`, сбежавший из боя — похоронен.
 */
describe('⭐ R12-07: мёртвый, оставшийся в подземелье один, уходит с пати в город', () => {
  async function coop(): Promise<{ room: RoomIn; pa: string; pb: string; a: SaveState; b: SaveState; wsA: FakeWs; node: string | null; gold: number }> {
    const room = newRoom();
    const a = hero(), b = hero();
    const wsA = new FakeWs();
    const pa = room.addPlayer(wsA, `user-${a.charId}`, a, 1);
    const pb = room.addPlayer(new FakeWs(), `user-${b.charId}`, b, 1);
    await settle();
    ready(room); room.descend(pa); room.castVote(pb, true);
    expect(room.area).toBe('dungeon');
    const w = room.session.world;
    for (const m of w.monsters) m.alive = false;   // «спокойно»: на B никто не идёт (тик комнаты идёт и в ожиданиях теста)
    P(room, pb).pos = { ...w.spawn };
    const p = P(room, pa);
    p.hp = 0; p.alive = false;
    room.onPlayerDeath(pa, new Set());   // A погиб при живом B — не вайп
    expect(wsA.died().at(-1)?.toTown).toBe(false);
    return { room, pa, pb, a: P(room, pa).save, b: P(room, pb).save, wsA, node: room.runNodeId, gold: P(room, pa).save.gold };
  }
  /** Срок возврата вышел (часы комнаты — `Date.now`, как у вайпа). */
  const due = (room: RoomIn): void => { expect(room.strandAt, 'возврат назначен').toBeGreaterThan(0); room.strandAt = 1; room.step(); };

  it('B ушёл спокойно — A (мёртвый, один) с пати в городе: жив, забег припаркован, второго штрафа нет; B — `safe`', async () => {
    const { room, pa, pb, a, b, wsA, node, gold } = await coop();
    await room.removePlayer(pb);
    expect(wsA.died().at(-1)?.toTown, 'окно смерти: «возвращаетесь в город»').toBe(true);
    due(room);
    expect(room.area).toBe('town');
    expect(P(room, pa).alive).toBe(true);
    expect(a.run?.currentNodeId, 'забег припаркован, а не снят').toBe(node);
    expect(a.gold, 'штраф взят один раз — на смерти').toBe(gold);
    expect(room.disconnected.get(b.charId)?.safe, 'B ушёл у портала: его забег тоже припаркован').toBe(true);
  });

  // ⚠ R13-01..03: ушедший посреди боя ждёт весь грейс (а не 15 с возврата), его тело стоит в бою (`combatLogoutSec`), а пати, где все
  // мертвы или сбежали, — это вайп. Раньше здесь стерегли «похоронен через 15 с, забег A припаркован» — это и были R13-01 и R13-02.
  // ⚠ R14-01: подключены одни мёртвые — мир стоит (тело «вне игры» защитить некому), и яд добивает B, когда он вернётся: раньше здесь
  // стерегли «тело добито ядом, пока B перезагружал страницу», — это и была R14-01 (у честного F5 с мёртвым напарником — штраф и вайп).
  it('B ушёл посреди боя (яд добьёт) — возврата через 15 с нет; мир ждёт B; вернулся — яд добивает: штраф B, и раз живых нет — вайп', async () => {
    const { room, pb, a, b, gold } = await coop();
    room.stop();   // тик — только шагами теста
    const w = room.session.world;
    const pB = P(room, pb);
    pB.pos = { x: w.spawn.x + 300, y: w.spawn.y };
    pB.debuffs = { poison: { stacks: 10, mag: 1000, expiresAt: w.timeMs + 60_000 } };
    await room.removePlayer(pb);
    expect(room.disconnected.get(b.charId)?.fled, 'ушёл посреди боя').toBe(true);
    expect(room.strandAt - Date.now(), 'ушедший посреди боя ждёт грейс, а не 15 с').toBeGreaterThan(60_000);
    for (let i = 0; i < 30 * 5; i++) room.step();   // подключён один мёртвый A — мир стоит
    await settle();
    expect(room.disconnected.has(b.charId), 'B ждёт').toBe(true);
    expect((db.data.get(b.charId) as SaveState).gold, 'золото B цело, пока его нет').toBe(5000);
    const [save, v] = fromDb(b.charId);
    const back = room.reconnect(new FakeWs(), `user-${b.charId}`, save, v);
    room.stop();
    for (let i = 0; i < 30 * 5 && P(room, back)?.alive; i++) room.step();   // яд никуда не делся
    await settle();
    expect(P(room, back).alive, 'яд добил B').toBe(false);
    expect((db.data.get(b.charId) as SaveState).gold, 'штраф B').toBeLessThan(5000);
    expect(a.run, 'вайп: забег A окончен').toBeUndefined();
    expect(a.gold, 'штраф A — один раз, на смерти').toBe(gold);
  });

  it('A ушёл мёртвым, потом ушёл B; A вернулся «Продолжить» — не мёртвое ожидание по кругу, а возврат в город', async () => {
    const { room, pa, pb, a } = await coop();
    await room.removePlayer(pa);
    await room.removePlayer(pb);
    await settle();
    const [save, v] = fromDb(a.charId);
    const ws = new FakeWs();
    const back = room.reconnect(ws, `user-${a.charId}`, save, v);
    expect(P(room, back).alive, 'вернулся мёртвым (R3-06)').toBe(false);
    expect(ws.died().map((d) => d.toTown), 'окно смерти — «возвращаетесь в город»').toEqual([true]);
    due(room);
    expect(room.area).toBe('town');
    expect(P(room, back).alive).toBe(true);
  });

  it('B ушёл (возврат назначен), A отключился до срока и вернулся — возврат в силе, окно смерти то же', async () => {
    const { room, pa, pb, a } = await coop();
    await room.removePlayer(pb);
    await room.removePlayer(pa);
    await settle();
    const [save, v] = fromDb(a.charId);
    const ws = new FakeWs();
    const back = room.reconnect(ws, `user-${a.charId}`, save, v);
    expect(ws.died().map((d) => d.toTown)).toEqual([true]);
    due(room);
    expect(room.area).toBe('town');
    expect(P(room, back).alive).toBe(true);
  });

  it('контроль: A мёртв, B жив и в комнате — возврата нет, A ждёт пати', async () => {
    const { room, pa } = await coop();
    expect(room.strandAt).toBe(0);
    room.step();
    expect(room.area).toBe('dungeon');
    expect(P(room, pa).alive).toBe(false);
  });

  it('контроль: возврат назначен, но живой вернулся до срока — возврата нет, мёртвому — прежнее окно', async () => {
    const { room, pb, b, wsA } = await coop();
    await room.removePlayer(pb);
    expect(room.strandAt).toBeGreaterThan(0);
    const [save, v] = fromDb(b.charId);
    room.reconnect(new FakeWs(), `user-${b.charId}`, save, v);
    expect(room.strandAt, 'живой вернулся — отбой').toBe(0);
    expect(wsA.died().at(-1)?.toTown).toBe(false);
    room.step();
    expect(room.area).toBe('dungeon');
  });
});

/** Ждать условия оборотами цикла (комната исполняет команды асинхронно). */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 0)); }
  throw new Error(`не дождались: ${what}`);
}
const results = (ws: FakeWs): { ok: boolean; reason?: string }[] =>
  ws.frames.filter((f) => f.t === 'cmdResult') as unknown as { ok: boolean; reason?: string }[];

/**
 * ⭐ R12-11: ПРОДОЛЖЕНИЕ ЗАБЕГА ИЗ ГОРОДА ЖДЁТ СВОД — И ТРАНЗАКЦИЯ СУНДУКА В ЭТО ОКНО НЕ НАЧИНАЕТСЯ. Барьер R1-05 (переход не идёт,
 * пока запись «сейв + сундук» держит сейв) стоял только в `checkVote`: голос за продолжение проходил, пока ничего не держалось, а
 * переход случался позже — после чтения свода из базы. В это окно команда сундука (вклад материалов, перекладка, кузница) брала сейв
 * на удержание, комната уходила в подземелье с удержанным сейвом, а неудача записи (сундук обогнал второй герой аккаунта, D8)
 * откатывала сейв к городскому снимку — вместе со штрафом смерти, опытом и квестами, взятыми уже в подземелье.
 */
describe('⭐ R12-11: пока продолжение забега ждёт базу, команды сундука отказаны — переход не уносит удержанный сейв', () => {
  it('вклад материалов в окне продолжения — отказ «повторите»; смерть в подземелье потом не откатывается', async () => {
    const s = hero();
    s.gold = 1000;
    const tpl = cfg.get('run-templates').find((t) => t.enabled !== false)!;
    const biome = cfg.get('biomes').find((b) => b.enabled !== false)!;
    const config = { templateId: tpl.id, biomeId: biome.id, tier: 'normal', seed: 4242, modifiers: [], id: randomUUID() };
    const plan = generateRunPlan(cfg, config as never);
    s.run = { templateId: tpl.id, config, currentNodeId: plan.startId, visited: [plan.startId] } as never;
    const stack = materialItem(cfg.get('craft-materials')[0]!, 5, `${randomUUID()}_0`);
    stack.pos = null;
    s.inventory.push(stack);
    packInventory(s.inventory, cfg.get('balance').inventory);
    db.data.set(s.charId, structuredClone(s));
    const room = newRoom();
    const ws = new FakeWs();
    const pid = room.addPlayer(ws, `user-${s.charId}`, s, 1);
    await settle();
    let openLedger!: () => void;
    db.ledgerGate = new Promise<void>((r) => { openLedger = r; });
    let openStash!: () => void;
    db.stashGate = new Promise<void>((r) => { openStash = r; });
    ready(room); room.descend(pid);
    expect(room.resuming, 'голос прошёл — продолжение ждёт свод').toBe(true);
    const cmd = room.handleCmd(pid, { cmd: 'depositMaterials' }, 1);
    await settle();
    openLedger();
    await until('комната в подземелье', () => room.area === 'dungeon');
    const held = room.session.saveHeld.has(pid);
    const p = P(room, pid);
    p.hp = 0; p.alive = false;
    room.onPlayerDeath(pid, new Set());
    const dead = p.save.gold;
    openStash();
    await cmd;
    await settle();
    expect(held, 'в подземелье — без удержанного сейва').toBe(false);
    expect(results(ws).at(-1), 'команда отказана').toMatchObject({ ok: false });
    expect(dead, 'штраф смерти взят').toBeLessThan(1000);
    expect(p.save.gold, 'и не откатан').toBe(dead);
  });
});

/**
 * ⭐ R12-12: ДОПИСКА КОПИИ С НЕИЗВЕСТНЫМ ИСХОДОМ ФИКСАЦИИ (R11-03) — С ПРИЧИНАМИ ПО ВЕЩИ (R2-21). Раньше дописка шла одной причиной
 * действия: купленное и поднятое с прошлой записи журнал вещей подписывал ковкой (перекладкой, разбором), и аудит видел «кузнеца-выброс»
 * вместо добычи. Теперь — снимок карты причин той записи; откат к «до действия» (сундук обогнали) — без вещей самого действия.
 */
describe('⭐ R12-12: дописка копии «исход неизвестен» подписывает вещи их причинами', () => {
  /** Причина вещи в журнале — как её возьмёт `syncItems` (db/items.ts). */
  const why = (put: { reason?: string; reasons?: ReadonlyMap<string, string> }, uid: string): string =>
    (put.reasons ? put.reasons.get(uid) ?? 'autosave' : put.reason ?? 'autosave');
  const land = (a: { charId: string; data: SaveState; version: number }): unknown => {
    if (a.version !== db.versions.get(a.charId)) return { ok: false, conflict: 'save' };
    db.versions.set(a.charId, a.version + 1); db.data.set(a.charId, structuredClone(a.data));
    return { ok: true, version: a.version + 1, stashVersion: 2 };
  };
  async function unknownStashMove(): Promise<{ bought: Item; moved: Item; farewell: { saved: boolean; retry?: () => Promise<{ saved: boolean }> } }> {
    const s = hero();
    s.gold = 1_000_000;
    const room = newRoom();
    const ws = new FakeWs();
    const pid = room.addPlayer(ws, `user-${s.charId}`, s, 1);
    await settle();
    const live = P(room, pid).save;
    const shelf = (ws.frames.filter((f) => f.t === 'shop').at(-1) as unknown as { items: Item[] }).items;
    const buy = async (it: Item, id: number): Promise<Item> => {
      const had = new Set(live.inventory.map((i) => i.uid));
      await room.handleCmd(pid, { cmd: 'buy', uid: it.uid }, id);
      const got = live.inventory.find((i) => !had.has(i.uid));
      expect(got, `куплено: ${JSON.stringify(results(ws).at(-1))}`).toBeTruthy();
      return got!;
    };
    const bought = await buy(shelf[0]!, 1);
    const moved = await buy(shelf[1]!, 2);
    let calls = 0;
    db.stashImpl = () => { calls++; return Promise.reject(new CommitUnknown(new Error('обрыв на COMMIT'))); };
    await room.handleCmd(pid, { cmd: 'stashMove', uid: moved.uid, dst: 0, x: 0, y: 0 }, 3);
    expect(calls, 'запись «сейв + сундук» была').toBe(1);
    const farewell = await room.removePlayer(pid);   // закрытие сокета снятой сессии: прощание — копия «на дописать»
    expect(farewell.saved).toBe(false);
    return { bought, moved, farewell };
  }

  it('дописка легла: купленное — «autosave», переложенное — «stash»', async () => {
    const { bought, moved, farewell } = await unknownStashMove();
    db.stashImpl = (a) => Promise.resolve(land(a));
    const from = db.puts.length;
    expect((await farewell.retry!()).saved).toBe(true);
    const put = db.puts.slice(from).find((x) => x.kind === 'stash')!;
    expect(put, 'дописка — записью «сейв + сундук»').toBeTruthy();
    expect(why(put, bought.uid), 'покупка — не перекладка').toBe('autosave');
    expect(why(put, moved.uid)).toBe('stash');
  });

  it('сундук обогнали — дописывается сейв ДО действия: вещь действия без его причины, остальное — со своими', async () => {
    const { bought, moved, farewell } = await unknownStashMove();
    db.stashImpl = () => Promise.resolve({ ok: false, conflict: 'stash' });
    const from = db.puts.length;
    expect((await farewell.retry!()).saved).toBe(true);
    const put = db.puts.slice(from).find((x) => x.kind === 'save')!;
    expect(put, 'дописка — сейвом до действия').toBeTruthy();
    expect(put.reasons, 'карта причин, а не одна причина на всё').toBeDefined();
    expect(why(put, moved.uid), 'перекладки не было').toBe('autosave');
    expect(why(put, bought.uid)).toBe('autosave');
  });
});

/**
 * ⭐ R12-13: ЧТЕНИЕ СУНДУКА АККАУНТА — ПОД СВОИМ ПОТОЛКОМ. Команды, читающие весь сундук из базы (открыть сундук, переложить, вклад
 * материалов, кузница), держал только общий потолок команд города (всплеск 120, 10 в секунду): и отказ, и «открыть» платили полное
 * чтение (и кадр сундука до ~340 КБ в ответ) — десять в секунду с аккаунта. Теперь — всплеск 40, дальше 4 в секунду: человек у
 * сундука столько не нажмёт, а поток упирается до базы.
 */
describe('⭐ R12-13: чтение сундука аккаунта — под своим потолком', () => {
  it('200 «открыть сундук» подряд (часы стоят) — чтений сундука не больше всплеска потолка', async () => {
    const s = hero();
    const room = newRoom();
    const ws = new FakeWs();
    const pid = room.addPlayer(ws, `user-${s.charId}`, s, 1);
    await settle();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    try {
      const r0 = db.stashReads;
      for (let i = 0; i < 200; i++) await room.handleCmd(pid, { cmd: 'stashOpen' }, 10 + i);
      expect(db.stashReads - r0, `чтений сундука: ${db.stashReads - r0}`).toBeLessThanOrEqual(40);
      expect(results(ws).some((r) => !r.ok && r.reason === 'Слишком часто')).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it('контроль: 20 быстрых перекладок сундук ↔ сумка подряд — все проходят', async () => {
    const s = hero();
    const room = newRoom();
    const ws = new FakeWs();
    const pid = room.addPlayer(ws, `user-${s.charId}`, s, 1);
    await settle();
    db.stashImpl = (a) => {
      if (a.version !== db.versions.get(a.charId)) return Promise.resolve({ ok: false, conflict: 'save' });
      db.versions.set(a.charId, a.version + 1); db.data.set(a.charId, structuredClone(a.data));
      return Promise.resolve({ ok: true, version: a.version + 1, stashVersion: a.version + 1 });
    };
    const live = P(room, pid).save;
    const had = new Set(live.inventory.map((i) => i.uid));
    const shelf = (ws.frames.filter((f) => f.t === 'shop').at(-1) as unknown as { items: Item[] }).items;
    await room.handleCmd(pid, { cmd: 'buy', uid: shelf[0]!.uid }, 1);
    const it0 = live.inventory.find((i) => !had.has(i.uid))!;
    expect(it0, 'в сумке есть вещь').toBeTruthy();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    try {
      const from = results(ws).length;
      // Туда (вкладка 0) и обратно (сумка), в левый верхний угол: он свободен, пока вещь на другой стороне.
      for (let i = 0; i < 20; i++) await room.handleCmd(pid, { cmd: 'stashMove', uid: it0.uid, dst: i % 2 ? 'inv' : 0, x: 0, y: 0 }, 100 + i);
      const got = results(ws).slice(from);
      expect(got.filter((r) => r.reason === 'Слишком часто'), 'отказов «часто»').toEqual([]);
      expect(got.filter((r) => r.ok).length, `перекладки прошли: ${JSON.stringify(got.filter((r) => !r.ok).slice(0, 2))}`).toBe(20);
    } finally { clock.mockRestore(); }
  });
});
