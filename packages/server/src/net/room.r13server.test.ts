import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  ConfigRegistry, newCharacterSave, generateItem, createRng, type Item, type ServerFrame, type SaveState,
} from '@dm/shared';

// Тесты ждут комнату оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решают мок базы и шаги
// комнаты, которые тест делает сам (`step`), а не часы.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ РАУНД 13 (сервер), комната. Комната настоящая; база — маленькая честная (версии сейва), умеет «лежать» по герою.
 *  • R13-01: мёртвый напарник держит вкладку — ушедший ПОСРЕДИ БОЯ ждёт весь грейс, а не 15 с возврата застрявших;
 *  • R13-02: «все мертвы или сбежали из боя» — это вайп: забег кончен у всех, а не припаркован мёртвому;
 *  • R13-03: ушёл посреди боя при живом напарнике — тело стоит в бою (`combatLogoutSec`), а не выходит из-под удара;
 *  • R13-04: «Завершить» (штраф брошенного забега) — смерть и для записи ухода: вход по коду не оживляет на месте боя;
 *  • R13-05: окно смерти — статусом (`status`), а не новой смертью с потерями 0/0;
 *  • R13-09: кузница уников не продаёт, а вещь вкладки — с базы этой вкладки;
 *  • R13-10: дописка прощальной записи из подземелья — с причинами по вещи (журнал вещей).
 */
type PutArgs = { charId: string; data: SaveState; version: number };
const db = vi.hoisted(() => ({
  versions: new Map<string, number>(), data: new Map<string, unknown>(),
  /** Записи сейва, по порядку: кто, какой версией, с какой причиной и картой причин по вещи. */
  puts: [] as { charId: string; version: number; reason?: string; reasons?: ReadonlyMap<string, string> }[],
  /** Эти герои: база «лежит» — запись падает отказом соединения. */
  down: new Set<string>(),
}));
vi.mock('../db/db.js', () => {
  const put = (a: PutArgs): number | null => {
    if (a.version !== (db.versions.get(a.charId) ?? 1)) return null;
    db.versions.set(a.charId, a.version + 1); db.data.set(a.charId, structuredClone(a.data));
    return a.version + 1;
  };
  return {
    putCharacter: async (charId: string, _u: string, data: SaveState, version: number, reason?: string, reasons?: ReadonlyMap<string, string>) => {
      db.puts.push({ charId, version, reason, reasons: reasons && new Map(reasons) });
      if (db.down.has(charId)) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      return put({ charId, data, version });
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
  };
});
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Mon = { alive: boolean; pos: { x: number; y: number }; aiState: string; windup: unknown };
type P = {
  hp: number; maxHp: number; alive: boolean; pos: { x: number; y: number }; save: SaveState;
  skillCd: Record<string, number>; debuffs: Record<string, unknown>;
};
type Info = { fled: boolean; safe?: boolean; paid: boolean; save: SaveState };
type RoomIn = {
  area: string; movedAt: number; runNodeId: string | null; strandAt: number; runPlan: unknown;
  disconnected: Map<string, Info>;
  session: { world: { players: Record<string, P>; spawn: { x: number; y: number }; timeMs: number; monsters: Mon[] } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  reconnect(ws: unknown, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): Promise<{ saved: boolean; retry?: () => Promise<{ saved: boolean }> }>;
  abandonAsDead(charId: string, insurance?: boolean): Promise<{ saved: boolean }>;
  returnTown(pid: string): void; castVote(pid: string, yes: boolean): void; descend(pid: string): void;
  onPlayerDeath(pid: string, touched: Set<string>): void;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
  rollGear(seed: number, heroLevel: number): Item[];
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
  db.down.clear();
  vi.restoreAllMocks();
});

class FakeWs {
  open = true; readonly ip = '127.0.0.1'; frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void {} onClose(): void {}
  died(): (Extract<ServerFrame, { t: 'died' }> & { status?: boolean; canLeave?: boolean })[] {
    return this.frames.filter((f) => f.t === 'died') as (Extract<ServerFrame, { t: 'died' }> & { status?: boolean; canLeave?: boolean })[];
  }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
let seq = 0;
function newRoom(h: object = hooks): RoomIn {
  const room = new RoomCtor(`R13S${++seq}`, cfg, h);
  rooms.push(room);
  return room;
}
function hero(): SaveState {
  const charId = `char-r13s-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  s.level = 30; s.gold = 5000; s.attributes.vitality = 60;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const ready = (room: RoomIn): void => { room.movedAt = 0; };
const P = (room: RoomIn, pid: string): P => room.session.world.players[pid]!;
/** Сейв героя из базы — как его читает вход (`RoomManager.join`). */
const fromDb = (charId: string): [SaveState, number] => [structuredClone(db.data.get(charId)) as SaveState, db.versions.get(charId)!];
const row = (charId: string): SaveState => db.data.get(charId) as SaveState;
const bal = (): { combatLogoutSec: number; reconnectGraceSec: number } => cfg.get('balance') as unknown as { combatLogoutSec: number; reconnectGraceSec: number };

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
/** A погиб при живом B — не вайп (штраф взят, окно смерти с потерями). */
function killA(room: RoomIn, pa: string): void {
  const p = P(room, pa);
  p.hp = 0; p.alive = false;
  room.onPlayerDeath(pa, new Set());
}
/** Героя целит живой монстр в погоне — вдали от портала входа. */
function hunted(room: RoomIn, pid: string): Mon {
  const w = room.session.world;
  const m = w.monsters.find((x) => Math.hypot(x.pos.x - w.spawn.x, x.pos.y - w.spawn.y) > 300)!;
  expect(m, 'на этаже есть монстр вдали от входа').toBeTruthy();
  m.alive = true; m.aiState = 'chase';
  P(room, pid).pos = { x: m.pos.x + 40, y: m.pos.y };
  return m;
}

describe('⭐ R13-09: кузница не продаёт уников, вещь вкладки — с её базы', () => {
  it('100 сидов × уровни 1/10/40/80: ни одного уника; каждая вещь — с базы пула своей вкладки', () => {
    const room = newRoom();
    const on = cfg.get('items.base').filter((b) => b.enabled !== false);
    const pools = [
      { n: 9, ids: new Set(on.filter((b) => b.kind === 'weapon' && b.attackType === 'melee').map((b) => b.id)) },
      { n: 6, ids: new Set(on.filter((b) => b.kind === 'weapon' && b.attackType === 'ranged').map((b) => b.id)) },
      { n: 9, ids: new Set(on.filter((b) => b.kind === 'armor' || b.kind === 'shield' || b.kind === 'jewelry').map((b) => b.id)) },
    ].filter((p) => p.ids.size > 0);
    let uniques = 0, off = 0, stocks = 0, withUnique = 0;
    for (const lvl of [1, 10, 40, 80]) {
      // Уник был почти на каждом втором прилавке: 400 прилавков без него — не случайность.
      for (let k = 0; k < 100; k++) {
        const gear = room.rollGear(9_000 + k, lvl);
        stocks++;
        let i = 0, had = false;
        for (const pool of pools) {
          for (let j = 0; j < pool.n; j++, i++) {
            const it = gear[i]!;
            if (it.rarity === 'unique') { uniques++; had = true; }
            if (!pool.ids.has(it.baseId)) off++;
          }
        }
        if (had) withUnique++;
      }
    }
    expect(uniques, `уников на ${withUnique} прилавках из ${stocks}`).toBe(0);
    expect(off, 'вещей не с базы своей вкладки').toBe(0);
  });
});

describe('⭐ R13-10: дописка прощальной записи из подземелья — с причинами по вещи', () => {
  /** Герой с найденным мечом в сумке — в подземелье; база легла; разбор на месте и уход — обе записи не легли. */
  async function salvagedAndGone(): Promise<{ room: RoomIn; charId: string; uid: string; fw: { saved: boolean; retry?: () => Promise<{ saved: boolean }> } }> {
    const s = hero();
    const base = cfg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'sword' && b.enabled !== false)!;
    const it: Item = generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'),
      { dropBias: 1, itemLevel: 5, baseId: base.id, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'normal',
        maxReqTotal: cfg.get('balance').maxTotalRequirement }, createRng(7));
    it.pos = { x: 0, y: 5 };
    s.inventory.push(it);
    db.data.set(s.charId, structuredClone(s));
    const room = newRoom();
    const pid = room.addPlayer(new FakeWs(), `user-${s.charId}`, s, 1);
    await settle();
    ready(room); room.descend(pid);
    expect(room.area).toBe('dungeon');
    room.stop();
    for (const m of room.session.world.monsters) m.alive = false;
    P(room, pid).pos = { ...room.session.world.spawn };
    db.down.add(s.charId);
    await room.handleCmd(pid, { cmd: 'salvage', uid: it.uid }, 1);
    await settle();
    expect(P(room, pid).save.inventory.some((i) => i.uid === it.uid), 'разобрано').toBe(false);
    const fw = await room.removePlayer(pid);
    expect(fw.saved, 'прощальная запись не легла').toBe(false);
    db.down.delete(s.charId);
    return { room, charId: s.charId, uid: it.uid, fw };
  }
  const why = (put: { reason?: string; reasons?: ReadonlyMap<string, string> }, uid: string): string =>
    (put.reasons ? put.reasons.get(uid) ?? put.reason ?? 'autosave' : put.reason ?? 'autosave');

  it('база вернулась — дописка прощальной копии подписывает разобранную вещь «salvage», а не «autosave»', async () => {
    const { charId, uid, fw } = await salvagedAndGone();
    const from = db.puts.length;
    expect((await fw.retry!()).saved).toBe(true);
    const put = db.puts.slice(from).filter((p) => p.charId === charId).at(-1)!;
    expect(why(put, uid)).toBe('salvage');
  });

  it('первая дописка не легла — запись «Завершить» той же копии всё равно подписывает вещь «salvage»', async () => {
    const { room, charId, uid } = await salvagedAndGone();
    const from = db.puts.length;
    expect((await room.abandonAsDead(charId)).saved).toBe(true);
    const put = db.puts.slice(from).filter((p) => p.charId === charId).at(-1)!;
    expect(why(put, uid)).toBe('salvage');
  });
});

describe('⭐ R13-04: «Завершить» — смерть и для записи ухода: вход по коду не оживляет на месте боя', () => {
  it('B ушёл при 5% с откатом → «новая игра» (страховка — штраф) → прошёл через другую комнату → вход по коду: мёртв или ранен, с откатом', async () => {
    const { room, pb, b } = await coop();
    const p = P(room, pb);
    const low = Math.max(1, Math.round(p.maxHp * 0.05));
    p.hp = low; p.skillCd = { 'probe-skill': 30 };
    const spot = { x: p.pos.x + 64, y: p.pos.y };
    p.pos = { ...spot };
    await room.removePlayer(pb);
    await settle();
    expect((await room.abandonAsDead(b.charId, true)).saved, 'штраф брошенного забега лёг').toBe(true);
    expect(row(b.charId).gold, 'штраф взят').toBeLessThan(5000);
    // Другая (городская) комната: вошёл и вышел — сейв с полными пулами и свежей меткой.
    await new Promise((r) => setTimeout(r, 5));
    const q = newRoom();
    const [s1, v1] = fromDb(b.charId);
    const qp = q.addPlayer(new FakeWs(), `user-${b.charId}`, s1, v1);
    await settle();
    await q.removePlayer(qp);
    await settle();
    const [save, v] = fromDb(b.charId);
    const back = room.addPlayer(new FakeWs(), `user-${b.charId}`, save, v);
    const e = P(room, back);
    if (e.alive) {
      expect(e.hp, `вернулся живым с ${e.hp} из ${e.maxHp}`).toBeLessThanOrEqual(low + 5);
      expect(e.skillCd['probe-skill'] ?? 0, 'откат цел').toBeGreaterThan(0);
    } else {
      expect(e.alive, 'ушёл «мёртвым» — вернулся мёртвым (R3-06)').toBe(false);
    }
  });

  it('вторая линия: запись ухода с точкой в подземелье, а сейв новее (другая комната) — пулы не выше записи, откаты её', async () => {
    const { room, pb, b } = await coop();
    const p = P(room, pb);
    const low = Math.max(1, Math.round(p.maxHp * 0.05));
    p.hp = low; p.skillCd = { 'probe-skill': 30 };
    await room.removePlayer(pb);
    await settle();
    await new Promise((r) => setTimeout(r, 5));
    const q = newRoom();   // сейв героя с тех пор писала другая комната — полным
    const [s1, v1] = fromDb(b.charId);
    s1.vitals = undefined;
    const qp = q.addPlayer(new FakeWs(), `user-${b.charId}`, s1, v1);
    await settle();
    await q.removePlayer(qp);
    await settle();
    const [save, v] = fromDb(b.charId);
    expect(save.vitals?.hp, 'в базе — полный').toBeGreaterThan(low);
    const back = room.reconnect(new FakeWs(), `user-${b.charId}`, save, v);
    expect(P(room, back).hp).toBeLessThanOrEqual(low + 5);
    expect(P(room, back).skillCd['probe-skill'], 'откат цел').toBe(30);
  });

  it('контроль (R4-06): ушёл раненым с откатом и вернулся, нигде больше не играв, — таким же', async () => {
    const { room, pb, b } = await coop();
    const p = P(room, pb);
    const hurt = Math.round(p.maxHp * 0.3);
    p.hp = hurt; p.skillCd = { 'probe-skill': 30 };
    await room.removePlayer(pb);
    await settle();
    const [save, v] = fromDb(b.charId);
    const back = room.reconnect(new FakeWs(), `user-${b.charId}`, save, v);
    expect(P(room, back).hp).toBe(hurt);
    expect(P(room, back).skillCd['probe-skill']).toBe(30);
  });
});

/** Срок возврата застрявших — через `ms` по часам сервера (`Date.now`, как у вайпа): шаг комнаты «тогда». */
function stepAt(room: RoomIn, ms: number): void {
  const now = Date.now() + ms;
  const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
  try { room.step(); } finally { spy.mockRestore(); }
}

describe('⭐ R13-01: ушедший посреди боя ждёт весь грейс, даже если мёртвый напарник держит вкладку', () => {
  it('A мёртв и подключён, B отвалился посреди боя: через 15 с (и 16) возврата нет, B ждёт; вернулся — живым на тот же узел', async () => {
    const { room, pa, pb, b, node } = await coop();
    killA(room, pa);
    hunted(room, pb);
    await room.removePlayer(pb);
    await settle();
    expect(room.disconnected.get(b.charId)?.fled, 'ушёл посреди боя').toBe(true);
    expect(room.strandAt - Date.now(), 'возврат застрявших — не через 15 с').toBeGreaterThan(60_000);
    stepAt(room, 16_000);
    await settle();
    expect(room.area, 'пати на узле').toBe('dungeon');
    expect(room.disconnected.has(b.charId), 'B ждёт реконнекта').toBe(true);
    expect(row(b.charId).gold, 'золото B цело').toBe(5000);
    expect(row(b.charId).run?.currentNodeId, 'забег B цел').toBe(node);
    const [save, v] = fromDb(b.charId);
    const back = room.reconnect(new FakeWs(), `user-${b.charId}`, save, v);
    expect(P(room, back).alive, 'вернулся живым').toBe(true);
    expect(room.runNodeId).toBe(node);
    expect(room.strandAt, 'живой вернулся — возврат снят').toBe(0);
  });

  it('A мёртв и ушёл, B отвалился посреди боя; A вернулся посмотреть — B всё так же ждёт грейс, а не 15 с', async () => {
    const { room, pa, pb, a, b } = await coop();
    killA(room, pa);
    hunted(room, pb);
    await room.removePlayer(pa);
    await room.removePlayer(pb);
    await settle();
    const [save, v] = fromDb(a.charId);
    room.reconnect(new FakeWs(), `user-${a.charId}`, save, v);
    room.stop();
    expect(room.strandAt - Date.now()).toBeGreaterThan(60_000);
    stepAt(room, 16_000);
    await settle();
    expect(room.area).toBe('dungeon');
    expect(room.disconnected.has(b.charId)).toBe(true);
    expect(row(b.charId).gold).toBe(5000);
  });

  it('грейс вышел, а A так и держит вкладку — B похоронен (R4-14), пати в городе', async () => {
    const { room, pa, pb, b } = await coop();
    killA(room, pa);
    hunted(room, pb);
    await room.removePlayer(pb);
    await settle();
    stepAt(room, bal().reconnectGraceSec * 1000 + 1_000);
    await settle();
    expect(room.area).toBe('town');
    expect(room.disconnected.has(b.charId), 'B похоронен').toBe(false);
    expect(row(b.charId).gold, 'штраф смерти').toBeLessThan(5000);
    expect(row(b.charId).run, 'забег B снят').toBeUndefined();
  });
});

describe('⭐ R13-02: «все мертвы или сбежали из боя» — это вайп, а не припаркованный забег', () => {
  it('A мёртв, B отвалился посреди боя; срок вышел — забег кончен у всех (как если бы B погиб)', async () => {
    const { room, pa, pb, a } = await coop();
    killA(room, pa);
    hunted(room, pb);
    await room.removePlayer(pb);
    await settle();
    room.strandAt = 1;   // срок вышел (грейс или иной)
    room.step();
    await settle();
    expect(room.area).toBe('town');
    expect(a.run, 'забег A кончен').toBeUndefined();
    expect(room.runPlan, 'план забега снят').toBeNull();
  });

  it('A мёртв, B отвалился посреди боя; A жмёт «В город» (`return` мёртвого) — B похоронен, забег кончен у всех', async () => {
    const { room, pa, pb, a, b } = await coop();
    killA(room, pa);
    hunted(room, pb);
    await room.removePlayer(pb);
    await settle();
    ready(room);
    room.returnTown(pa);
    await settle();
    expect(room.area).toBe('town');
    expect(a.run).toBeUndefined();
    expect(room.runPlan).toBeNull();
    expect(room.disconnected.has(b.charId), 'B похоронен').toBe(false);
    expect(row(b.charId).run).toBeUndefined();
  });

  it('контроль: B ушёл спокойно у портала — забег A припаркован, B `safe`', async () => {
    const { room, pa, pb, a, b, node } = await coop();
    killA(room, pa);
    await room.removePlayer(pb);
    await settle();
    expect(room.strandAt - Date.now(), 'спокойный уход — возврат через 15 с').toBeLessThanOrEqual(15_000);
    stepAt(room, 16_000);
    expect(room.area).toBe('town');
    expect(a.run?.currentNodeId, 'забег припаркован').toBe(node);
    expect(room.disconnected.get(b.charId)?.safe).toBe(true);
  });
});

describe('⭐ R13-05: окно смерти — статус, а не новая смерть с потерями 0/0', () => {
  it('A погиб (потери в первом кадре), B ушёл, вернулся, снова ушёл — A получает только статусы', async () => {
    const { room, pa, pb, b, wsA } = await coop();
    P(room, pa).save.gold = 5000;
    killA(room, pa);
    const first = wsA.died();
    expect(first.length).toBe(1);
    expect(first[0]!.goldLost, 'настоящие потери').toBeGreaterThan(0);
    expect(first[0]!.status).toBeUndefined();
    await room.removePlayer(pb);
    const [save, v] = fromDb(b.charId);
    const back = room.reconnect(new FakeWs(), `user-${b.charId}`, save, v);
    room.stop();
    await room.removePlayer(back);
    const later = wsA.died().slice(1);
    expect(later.length, 'статусы были').toBeGreaterThan(0);
    for (const f of later) expect(f.status, JSON.stringify(f)).toBe(true);
    expect(later.map((f) => f.toTown), 'в город → отбой → в город').toEqual([true, false, true]);
  });

  it('мёртвый вернулся в комнату — окно смерти статусом (потерь в нём нет: штраф уже взят)', async () => {
    const { room, pa, a } = await coop();
    killA(room, pa);
    await room.removePlayer(pa);
    await settle();
    const [save, v] = fromDb(a.charId);
    const ws = new FakeWs();
    room.reconnect(ws, `user-${a.charId}`, save, v);
    expect(ws.died().length).toBe(1);
    expect(ws.died()[0]!.status).toBe(true);
    expect(ws.died()[0]!.toTown).toBe(false);
  });

  it('застрял с отвалившимся посреди боя — статус предлагает «В город» (`canLeave`), а не «возвращаетесь»', async () => {
    const { room, pa, pb, wsA } = await coop();
    killA(room, pa);
    hunted(room, pb);
    await room.removePlayer(pb);
    const f = wsA.died().at(-1)!;
    expect(f.status).toBe(true);
    expect(f.toTown).toBe(false);
    expect(f.canLeave).toBe(true);
  });
});

describe('⭐ R13-03: ушёл посреди боя при живом напарнике — тело остаётся в бою', () => {
  /** A — вдали от входа, на 1 HP, вокруг него 4 монстра в погоне; B — у входа, неуязвим (бой идёт, пока A «вне игры»). */
  async function fight(): Promise<{ room: RoomIn; pa: string; pb: string; a: SaveState; b: SaveState }> {
    const { room, pa, pb, a, b } = await coop();
    const w = room.session.world;
    const far = w.monsters.slice().sort((m1, m2) => Math.hypot(m2.pos.x - w.spawn.x, m2.pos.y - w.spawn.y) - Math.hypot(m1.pos.x - w.spawn.x, m1.pos.y - w.spawn.y));
    const at = { ...far[0]!.pos };
    far.slice(0, 4).forEach((m, i) => { m.alive = true; m.aiState = 'chase'; m.pos = { x: at.x + (i % 2 ? 20 : -20), y: at.y + (i < 2 ? 20 : -20) }; });
    P(room, pa).pos = { ...at };
    P(room, pa).hp = 1;
    return { room, pa, pb, a, b };
  }
  const steps = (room: RoomIn, pb: string, sec: number): void => {
    for (let t = 0; t < 30 * sec; t++) { P(room, pb).hp = P(room, pb).maxHp; room.step(); }
  };

  it('A (1 HP) вышел посреди боя, 8 с боя без него, «Продолжить» — мёртв, штраф взят один раз, окно смерти', async () => {
    const { room, pa, pb, a } = await fight();
    await room.removePlayer(pa);
    steps(room, pb, 8);
    await settle();
    const info = room.disconnected.get(a.charId)!;
    expect(info.paid, 'погиб «вне игры» — штраф взят').toBe(true);
    expect(row(a.charId).gold, 'штраф в базе').toBeLessThan(5000);
    const gold = row(a.charId).gold;
    const [save, v] = fromDb(a.charId);
    const ws = new FakeWs();
    const back = room.reconnect(ws, `user-${a.charId}`, save, v);
    expect(P(room, back).alive, 'вернулся мёртвым').toBe(false);
    expect(ws.died().length, 'окно смерти').toBe(1);
    expect(P(room, back).save.gold, 'второго штрафа нет').toBe(gold);
  });

  it('вернулся посреди «вне игры» — встаёт тем телом, что стояло в бою: там же и с тем же здоровьем', async () => {
    const { room, pa, pb, a } = await fight();
    P(room, pa).hp = P(room, pa).maxHp;   // полный — пара ударов его не убьёт
    await room.removePlayer(pa);
    steps(room, pb, 0.5);
    const body = Object.values(room.session.world.players).find((p) => p.save.charId === a.charId);
    expect(body, 'тело ушедшего посреди боя — в мире').toBeTruthy();
    const hp = body!.hp, pos = { ...body!.pos };
    const [save, v] = fromDb(a.charId);
    const back = room.reconnect(new FakeWs(), `user-${a.charId}`, save, v);
    const bodies = Object.values(room.session.world.players).filter((p) => p.save.charId === a.charId);
    expect(bodies.length, 'одно тело на героя').toBe(1);
    expect(P(room, back).hp).toBe(hp);
    expect(P(room, back).pos).toEqual(pos);
  });

  it('напарник тоже вышел (комната на паузе) и вернулся первым — тело так и стоит в бою: мир продолжает бой с ним', async () => {
    const { room, pa, pb, a, b } = await fight();
    await room.removePlayer(pa);
    const bPos = { ...P(room, pb).pos };
    await room.removePlayer(pb);   // пусто — пауза грейса; тело A — в мире
    await settle();
    expect(Object.values(room.session.world.players).some((p) => p.save.charId === a.charId), 'тело A стоит').toBe(true);
    const [save, v] = fromDb(b.charId);
    const back = room.reconnect(new FakeWs(), `user-${b.charId}`, save, v);   // B вернулся первым — «увести» монстров
    room.stop();
    P(room, back).pos = bPos;
    steps(room, back, 8);
    await settle();
    expect(room.disconnected.get(a.charId)?.paid, 'бой дошёл до тела A').toBe(true);
    expect(row(a.charId).gold).toBeLessThan(5000);
  });

  it('напарник отбил (монстров на теле нет) — тело уходит; A ушёл спокойно: уход пати в город его не хоронит', async () => {
    const { room, pa, pb, a } = await fight();
    P(room, pa).hp = P(room, pa).maxHp;
    await room.removePlayer(pa);
    for (const m of room.session.world.monsters) m.alive = false;   // напарник добил
    room.step();
    expect(Object.values(room.session.world.players).some((p) => p.save.charId === a.charId), 'тело ушло').toBe(false);
    expect(room.disconnected.get(a.charId)?.fled, 'не бегство').toBe(false);
    P(room, pb).pos = { ...room.session.world.spawn };
    ready(room); room.returnTown(pb);
    expect(room.area).toBe('town');
    expect(room.disconnected.get(a.charId)?.safe, 'забег A припаркован, штрафа нет').toBe(true);
    await settle();
    expect(row(a.charId).gold).toBe(5000);
  });

  it('контроль: ушёл не в бою — тела в мире нет, вернулся с тем же здоровьем (R4-06)', async () => {
    const { room, pa, a } = await coop();
    const p = P(room, pa);
    const hurt = Math.round(p.maxHp * 0.4);
    p.hp = hurt;
    await room.removePlayer(pa);
    expect(Object.values(room.session.world.players).some((x) => x.save.charId === a.charId), 'тела нет').toBe(false);
    const [save, v] = fromDb(a.charId);
    const back = room.reconnect(new FakeWs(), `user-${a.charId}`, save, v);
    expect(P(room, back).hp).toBe(hurt);
  });

  // ⚠ R14-01: тело остаётся в мире и в соло (иначе вход альта по коду снимал паузу без него), а мир без живых подключённых стоит.
  it('контроль: соло (комната пуста) — мир на паузе, тело в мире не тронуто; вернулся — встал им', async () => {
    const s = hero();
    const room = newRoom();
    const pid = room.addPlayer(new FakeWs(), `user-${s.charId}`, s, 1);
    await settle();
    ready(room); room.descend(pid);
    room.stop();
    hunted(room, pid);
    const hp = P(room, pid).hp, t0 = room.session.world.timeMs;
    await room.removePlayer(pid);
    for (let i = 0; i < 30; i++) room.step();
    expect(room.session.world.timeMs, 'мир стоит').toBe(t0);
    const bodies = Object.values(room.session.world.players);
    expect(bodies.length, 'тело в мире').toBe(1);
    expect(bodies[0]!.hp).toBe(hp);
    const [save, v] = fromDb(s.charId);
    const back = room.reconnect(new FakeWs(), `user-${s.charId}`, save, v);
    expect(Object.keys(room.session.world.players), 'одно тело на героя — он сам').toEqual([back]);
    expect(P(room, back).hp).toBe(hp);
  });
});
