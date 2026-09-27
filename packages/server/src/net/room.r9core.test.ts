import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, addToInventory, carriedMaterials, generateItem, newCharacterSave, createRng,
  type ServerFrame, type SaveState, type Item, type SessionEvent,
} from '@dm/shared';
import { limits } from './rateLimit.js';

// Команды комната исполняет асинхронно (оборотами цикла), а на Windows оборот таймера — ~15,6 мс: под нагрузкой полного
// прогона умолчание 5 с — лотерея. Гонки потолок не прячет: они падают утверждением, а не временем.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Раунд 9 (ядро): то, что правка ядра обязана довезти через настоящую `Room` — поток бросков сессии не выводится из сида
 * (R9-02), повтор разбора не перекатывает выход (R9-03), добитое статусом ушедшего роняет добычу партии (R9-06). Сокет —
 * фейковый, база — заглушка.
 */
vi.mock('../db/db.js', () => ({
  // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  putCharacter: (_c: string, _u: string, _d: SaveState, v: number) => Promise.resolve(v + 1),
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
/**
 * Криптоисточник под рукой теста: `fixedInt` — каждый `randomInt` (сиды комнаты, забега, городских бросков) отдаёт одно число;
 * `pattern` — `randomFillSync` заливает буфер счётчиком вместо случайных байт. Выключены — настоящие.
 */
const tap = vi.hoisted(() => ({ fixedInt: 0, pattern: 0, fills: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const randomInt = ((...a: unknown[]) => (tap.fixedInt ? tap.fixedInt : (real.randomInt as (...x: unknown[]) => number)(...a))) as typeof real.randomInt;
  const randomFillSync = (<T extends NodeJS.ArrayBufferView>(buf: T, ...rest: unknown[]): T => {
    tap.fills++;
    if (!tap.pattern) return (real.randomFillSync as (b: T, ...x: unknown[]) => T)(buf, ...rest);
    const u = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength >>> 2);
    for (let i = 0; i < u.length; i++) u[i] = tap.pattern++ >>> 0;
    return buf;
  }) as typeof real.randomFillSync;
  return { ...real, randomInt, randomFillSync, default: { ...real, randomInt, randomFillSync } };
});

type Room = import('./room.js').Room;
let RoomCtor: typeof import('./room.js').Room;
let sessionRng: typeof import('./room.js').sessionRng;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor, sessionRng } = await import('./room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: Room[] = [];
afterEach(() => { tap.fixedInt = 0; tap.pattern = 0; vi.restoreAllMocks(); for (const r of rooms.splice(0)) r.stop(); });

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
  events(): SessionEvent[] { return this.frames.flatMap((f) => (f.t === 'events' ? (f as { events: SessionEvent[] }).events : [])); }
}
type Vec = { x: number; y: number };
type Mon = { id: number; alive: boolean; hp: number; facing: number; pos: Vec; debuffs: Record<string, unknown>; dotBy?: Record<string, string>; dotHero?: Record<string, string> };
type World = {
  monsters: Mon[]; drops: { pos: Vec }[]; chests: { id: number; pos: Vec; opened: boolean }[]; timeMs: number;
  players: Record<string, { pos: Vec; save: SaveState }>;
};
type RoomIn = {
  area: string; movedAt: number; nodeState: { killed: number[] } | null; spawnIdx: Map<number, number>;
  session: { world: World; openChest(pid: string, id?: number): boolean; collectEvents(fn: () => void): SessionEvent[] };
};
const inner = (room: Room): RoomIn => room as unknown as RoomIn;
let seq = 0;
function makeRoom(): { room: Room; ws: FakeWs; pid: string; save: SaveState; userId: string } {
  const charId = `char-r9c-${++seq}`;
  const userId = `user-${charId}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(userId);
  const room = new RoomCtor('R9C', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(room);
  const save = newCharacterSave(cfg, 'warrior', 'Герой', charId);
  save.level = 20;
  const ws = new FakeWs();
  const pid = room.addPlayer(ws as unknown as GameConn, userId, save, 1);
  // `addPlayer` кладёт в мир копию сейва — дальше работаем с живой.
  return { room, ws, pid, save: inner(room).session.world.players[pid]!.save, userId };
}
/** Соло-комната сразу в подземелье: первый узел нового забега. */
function dungeonRoom(): ReturnType<typeof makeRoom> {
  const r = makeRoom();
  inner(r.room).movedAt = 0;
  r.room.descend(r.pid, 'easy');
  expect(inner(r.room).area).toBe('dungeon');
  return r;
}

describe('⭐ R9-02: поток бросков сессии комнаты — не из сида', () => {
  it('⭐ две комнаты с ОДНИМ сидом (и тем же забегом) — разные взгляды монстров и разное содержимое того же сундука', () => {
    tap.fixedInt = 123_456_789;   // все сиды обеих комнат — одно число: этаж, заселение и сундуки совпадут
    const a = dungeonRoom(), b = dungeonRoom();
    const wa = inner(a.room).session.world, wb = inner(b.room).session.world;
    expect(wb.chests.map((c) => c.pos), 'этаж тот же').toEqual(wa.chests.map((c) => c.pos));
    expect(wb.monsters.map((m) => m.pos), 'заселение то же').toEqual(wa.monsters.map((m) => m.pos));
    expect(wa.monsters.length).toBeGreaterThan(3);
    // Взгляд заселения — первые выходы потока сессии: у сидового потока они совпадали бы бит в бит, и по ним подбиралось состояние.
    expect(wb.monsters.map((m) => m.facing), 'было: тот же сид — тот же поток').not.toEqual(wa.monsters.map((m) => m.facing));
    const sig = (room: Room, pid: string): string[] => {
      const w = inner(room).session.world;
      const ch = w.chests.find((c) => !c.opened)!;
      w.players[pid]!.pos = { x: ch.pos.x + 20, y: ch.pos.y };
      return inner(room).session.collectEvents(() => { inner(room).session.openChest(pid, ch.id); })
        .filter((e): e is Extract<SessionEvent, { type: 'item-dropped' }> => e.type === 'item-dropped')
        .map((e) => JSON.stringify({ ...e.item, uid: undefined, pos: undefined }));
    };
    expect(wa.chests.length, 'сундук на этаже есть').toBeGreaterThan(0);
    const da = sig(a.room, a.pid), db = sig(b.room, b.pid);
    expect(da.length).toBeGreaterThan(0);
    expect(db, 'было: сундук считался наперёд — одинаковый у обеих комнат').not.toEqual(da);
  });

  it('`sessionRng`: каждое число — свежее слово криптоисточника (32 бита на бросок), состояния, которое можно подобрать, нет', () => {
    tap.pattern = 1;
    const fills = tap.fills;
    const rng = sessionRng();
    const got = Array.from({ length: 600 }, () => rng.next());
    expect(got.slice(0, 4)).toEqual([1, 2, 3, 4].map((w) => w / 4294967296));
    expect(got.every((v, i) => v === (i + 1) / 4294967296), 'подряд — слова источника, без перемешивания состоянием').toBe(true);
    expect(tap.fills - fills, 'буфер доливается из источника').toBeGreaterThan(1);
    tap.pattern = 0;
    const real = sessionRng();
    const vals = Array.from({ length: 2000 }, () => real.next());
    expect(vals.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(vals).size).toBeGreaterThan(1990);
    expect(Math.abs(vals.reduce((s, v) => s + v, 0) / vals.length - 0.5)).toBeLessThan(0.05);
    const i = real.int(3, 7), f = real.float(-2, 2);
    expect(i >= 3 && i <= 7 && Number.isInteger(i)).toBe(true);
    expect(f >= -2 && f < 2).toBe(true);
  });
});

describe('⭐ R9-03: разбор в поле через комнату — повтор не перекатывает выход', () => {
  it('⭐ 60 обычных кожаных поясов: каждый уходит с первой команды, в среднем ~треть единицы (было — ровно единица)', async () => {
    const { room, ws, pid, save, userId } = makeRoom();
    save.inventory = [];
    const bal = cfg.get('balance');
    const units = (): number => Object.values(carriedMaterials(save.inventory)).reduce((a, b) => a + b, 0);
    let got = 0, extra = 0, id = 1;
    const N = 60;
    for (let k = 0; k < N; k++) {
      const belt = generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'),
        { dropBias: 1, itemLevel: 5, baseId: 'leather-belt', tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'normal',
          maxReqTotal: bal.maxTotalRequirement, origin: 'drop' }, createRng(k + 1)) as Item;
      expect(addToInventory(save.inventory, belt, bal.inventory), 'место в сумке').toBe(true);
      const u0 = units();
      // Изменённый клиент: «жми, пока вещь не уйдёт». Лимит кузницы тест снимает — повтор ограничен только им.
      for (let click = 0; click < 30 && save.inventory.some((i) => i.uid === belt.uid); click++) {
        limits.forgeCmd.reset(userId);
        await room.handleCmd(pid, { cmd: 'salvage', uid: belt.uid }, id++);
        if (click > 0) extra++;
      }
      expect(save.inventory.some((i) => i.uid === belt.uid), `пояс ${k} разобран`).toBe(false);
      expect(ws.last('cmdResult'), JSON.stringify(ws.last('cmdResult'))).toMatchObject({ ok: true });
      got += units() - u0;
    }
    expect(extra, 'было: ~70 % поясов отказывали «ничего не дал бы» и перекатывались').toBe(0);
    expect(got / N, 'замысел — 0.3 (2..3 × 0.4 × 0.3); было 1.0').toBeLessThan(0.6);
  });
});

describe('⭐ R9-06: добитое статусом ушедшего — добыча партии, а не пустота', () => {
  beforeAll(() => {
    const bal = structuredClone(cfg.get('balance'));
    bal.loot.dropChance = 1; bal.loot.goldChance = 1;
    cfg.reload({ balance: bal });
  });

  for (const away of [false, true]) {
    it(`${away ? '⭐ повесивший яд отвалился (грейс)' : 'контроль: повесивший на месте'} — добыча падает${away ? ', опыта и «убийства» нет, узел помнит смерть' : ' и его опыт'}`, async () => {
      const A = makeRoom();
      const charB = `char-r9c-b-${++seq}`;
      for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(`user-${charB}`);
      const sb = newCharacterSave(cfg, 'mage', 'B', charB);
      const wsB = new FakeWs();
      const b = A.room.addPlayer(wsB as unknown as GameConn, `user-${charB}`, sb, 1);
      inner(A.room).movedAt = 0;
      A.room.descend(A.pid);
      A.room.castVote(b, true);
      expect(inner(A.room).area).toBe('dungeon');
      const w = inner(A.room).session.world;
      const m = w.monsters.find((x) => x.alive)!;
      const idx = inner(A.room).spawnIdx.get(m.id)!;
      m.hp = 0.5;
      m.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: w.timeMs + 60_000, mag: 50, mag2: 0 };
      m.dotBy = { poison: b };
      m.dotHero = { poison: charB };
      const xpB0 = w.players[b]!.save.xp;
      const drops0 = w.drops.length;
      if (away) await A.room.removePlayer(b);
      A.ws.frames.length = 0;
      A.room.step(true);
      expect(m.alive).toBe(false);
      const evs = A.ws.events();
      const died = evs.find((e): e is Extract<SessionEvent, { type: 'monster-died' }> => e.type === 'monster-died' && e.id === m.id);
      expect(died, 'смерть разослана').toBeTruthy();
      expect(w.drops.length - drops0, away ? 'было: 0 — добыча босса пропадала для всей партии' : 'добыча').toBeGreaterThan(0);
      expect(inner(A.room).nodeState!.killed, 'узел помнит смерть').toContain(idx);
      if (away) {
        expect(died!.by, 'убийства никому').toBeUndefined();
        expect(evs.some((e) => e.type === 'xp'), 'опыта никому').toBe(false);
      } else {
        expect(died!.by).toBe(b);
        expect(w.players[b]!.save.xp).toBeGreaterThan(xpB0);
      }
    });
  }
});
