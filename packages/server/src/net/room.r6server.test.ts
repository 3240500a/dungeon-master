import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, effectiveLevel,
  type ServerFrame, type SaveState, type RunPlan, type RunNode,
} from '@dm/shared';
import { limits } from './rateLimit.js';

/**
 * Раунд 6 (сервер): то, что правка сервера обязана довезти через настоящую `Room` — сбежавший отключением не уходит живым
 * на следующий узел (R6-01), место в пати держит только тот, кто может вернуться на то же место (R6-14), мощь узла — по
 * сильнейшему герою забега, а не по первому вошедшему (R6-27). Сокет — фейковый, база — маленькая честная (версии сейва).
 */
const db = vi.hoisted(() => ({
  /** charId → версия сейва в «базе». Нет записи — 1 (так персонажа отдаёт вход в тестах). */
  saves: new Map<string, number>(),
  /** charId → последний записанный сейв. */
  data: new Map<string, SaveState>(),
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
afterEach(() => { vi.restoreAllMocks(); for (const r of rooms.splice(0)) r.stop(); });

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
type Mon = { alive: boolean; pos: Pt; aiState: string; def: { level: number } };
/** Внутренности комнаты, до которых тесту приходится дотягиваться (это тест). */
type RoomIn = {
  area: string; movedAt: number; runPlan: RunPlan | null; runNodeId: string | null; depth: number;
  decor: { kind: string; x: number; y: number }[];
  disconnected: Map<string, { fled: boolean }>;
  nodeState: { el: number } | null;
  session: { world: { spawn: Pt; exits?: Pt[]; monsters: Mon[]; players: Record<string, { pos: Pt; hp: number; alive: boolean; combatTimer: number; save: SaveState }> } };
};
const inner = (room: Room): RoomIn => room as unknown as RoomIn;
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
let seq = 0;

/** Комната и герои в ней (по герою на аккаунт); первый — хозяин комнаты. */
function roomWith(levels: number[], gold = 10_000): { room: Room; ws: FakeWs[]; pids: string[]; saves: SaveState[] } {
  const room = new RoomCtor('R6S', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {}, onFarewell() {} });
  rooms.push(room);
  const ws: FakeWs[] = [], pids: string[] = [], saves: SaveState[] = [];
  for (const level of levels) {
    const charId = `char-r6s-${++seq}`;
    const userId = `user-${charId}`;
    limits.townCmd.reset(userId); limits.forgeCmd.reset(userId); limits.cmdResync.reset(userId);
    const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, `H${seq}`, charId);
    s.level = level;
    s.gold = gold;
    const w = new FakeWs();
    pids.push(room.addPlayer(w as unknown as GameConn, userId, s, 1));
    ws.push(w); saves.push(s);
  }
  return { room, ws, pids, saves };
}
const nodeOf = (plan: RunPlan, id: string): RunNode => plan.nodes.find((n) => n.id === id)!;
const nodeNow = (room: Room): RunNode => nodeOf(inner(room).runPlan!, inner(room).runNodeId!);
/** Спуск из города: зовёт первый, остальные «за». */
function downFromTown(room: Room, pids: string[]): void {
  inner(room).movedAt = 0;
  room.descend(pids[0]!);
  for (const pid of pids.slice(1)) room.castVote(pid, true);
  expect(inner(room).area).toBe('dungeon');
}
/** Встать к выходу ребра на узел `to` (на финале — к порталу). */
function toExit(room: Room, pid: string, to?: string): void {
  const r = inner(room);
  const node = nodeNow(room);
  const i = Math.max(0, to ? node.edges.findIndex((e) => e.to === to) : 0);
  const at = node.edges.length === 0 ? r.decor.find((d) => d.kind === 'portal')! : r.session.world.exits![i]!;
  r.session.world.players[pid]!.pos = { x: at.x, y: at.y };
}
/** Герой при 1 HP вдали от выходов, на него идёт монстр — «в опасности» (R5-11). */
function cornered(room: Room, pid: string): void {
  const w = inner(room).session.world;
  const p = w.players[pid]!;
  p.pos = { x: w.spawn.x + 200, y: w.spawn.y };
  p.hp = 1;
  const m = w.monsters.find((x) => x.alive)!;
  m.pos = { x: p.pos.x + 20, y: p.pos.y };
  m.aiState = 'chase';
}

describe('⭐ R6-01: сбежавший из боя отключением не уходит живым на следующий узел', () => {
  it('напарник у выхода спускает, пока сбежавший в грейсе, — сбежавший похоронен со штрафом, забег снят, ждать его нечего', async () => {
    const { room, pids: [a, b], saves: [sa] } = roomWith([1, 1]);
    downFromTown(room, [a!, b!]);
    await settle();
    cornered(room, a!);
    await room.removePlayer(a!);
    await settle();
    expect(inner(room).disconnected.get(sa!.charId)?.fled, 'ушёл посреди боя').toBe(true);
    const to = nodeNow(room).edges[0]!.to;
    inner(room).movedAt = 0;
    toExit(room, b!, to);
    room.descend(b!, undefined, to);
    expect(inner(room).runNodeId, 'спуск прошёл').toBe(to);
    await settle();
    const row = db.data.get(sa!.charId)!;
    expect(row.gold, 'штраф брошенного забега — в базе').toBeLessThan(10_000);
    expect(row.run, 'забег снят: «Продолжить» не высадит его живым на новом узле').toBeUndefined();
    expect(inner(room).disconnected.has(sa!.charId), 'реконнекта в эту комнату нет').toBe(false);
  });

  it('голосование за спуск ждало его голоса — закрыл вкладку, спуск прошёл в тот же миг, и он всё равно похоронен', async () => {
    const { room, pids: [a, b], saves: [sa] } = roomWith([1, 1]);
    downFromTown(room, [a!, b!]);
    await settle();
    cornered(room, a!);
    const to = nodeNow(room).edges[0]!.to;
    inner(room).movedAt = 0;
    toExit(room, b!, to);
    room.descend(b!, undefined, to);
    expect(inner(room).runNodeId, 'ждём голоса A').not.toBe(to);
    const bye = room.removePlayer(a!);
    expect(inner(room).runNodeId, 'голос A больше не нужен — спуск прошёл').toBe(to);
    await bye;
    await settle();
    expect(db.data.get(sa!.charId)!.gold).toBeLessThan(10_000);
    expect(db.data.get(sa!.charId)!.run).toBeUndefined();
    expect(inner(room).disconnected.has(sa!.charId)).toBe(false);
  });

  it('контроль: ушёл спокойно (не в бою) — спуск его не хоронит: ждёт реконнекта, забег и золото целы', async () => {
    const { room, pids: [a, b], saves: [sa] } = roomWith([1, 1]);
    downFromTown(room, [a!, b!]);
    await settle();
    const w = inner(room).session.world;
    w.players[a!]!.pos = { ...w.spawn };
    await room.removePlayer(a!);
    await settle();
    expect(inner(room).disconnected.get(sa!.charId)?.fled).toBe(false);
    const to = nodeNow(room).edges[0]!.to;
    inner(room).movedAt = 0;
    toExit(room, b!, to);
    room.descend(b!, undefined, to);
    expect(inner(room).runNodeId).toBe(to);
    await settle();
    expect(inner(room).disconnected.has(sa!.charId), 'ждёт реконнекта').toBe(true);
    expect(db.data.get(sa!.charId)!.gold, 'штрафа нет').toBe(10_000);
    expect(db.data.get(sa!.charId)!.run, 'забег цел').toBeTruthy();
  });

  it('контроль: финал и город хоронят сбежавшего, как и прежде (R4-14)', async () => {
    for (const how of ['finish', 'town'] as const) {
      const { room, pids: [a, b], saves: [sa] } = roomWith([1, 1]);
      downFromTown(room, [a!, b!]);
      await settle();
      cornered(room, a!);
      await room.removePlayer(a!);
      await settle();
      if (how === 'finish') {
        for (let g = 0; g < 40 && nodeNow(room).edges.length; g++) {
          inner(room).movedAt = 0;
          const to = nodeNow(room).edges[0]!.to;
          toExit(room, b!, to);
          room.descend(b!, undefined, to);
        }
        inner(room).movedAt = 0;
        toExit(room, b!);
        room.descend(b!);
      } else {
        inner(room).movedAt = 0;
        inner(room).session.world.players[b!]!.pos = { ...inner(room).session.world.spawn };
        room.returnTown(b!);
      }
      expect(inner(room).area, how).toBe('town');
      await settle();
      expect(db.data.get(sa!.charId)!.gold, how).toBeLessThan(10_000);
      expect(db.data.get(sa!.charId)!.run, how).toBeUndefined();
    }
  });
});

describe('⭐ R6-14: место в пати держит только тот, кто может вернуться на то же место', () => {
  it('четвёртый отвалился спокойно; пока этаж тот же — место за ним, пати ушла в город — место свободно; вернуться он может всегда', async () => {
    const { room, pids, saves } = roomWith([1, 1, 1, 1]);
    downFromTown(room, pids);
    await settle();
    const w = inner(room).session.world;
    const d = pids[3]!;
    w.players[d]!.pos = { ...w.spawn };                       // у портала: ушёл спокойно, не сбежал
    await room.removePlayer(d);
    await settle();
    expect(inner(room).disconnected.get(saves[3]!.charId)?.fled).toBe(false);
    expect(room.seatsTaken('newcomer'), 'тот же этаж — его место держится').toBe(4);
    inner(room).movedAt = 0;
    for (const pid of pids.slice(0, 3)) w.players[pid]!.pos = { ...w.spawn };
    room.returnTown(pids[0]!);
    room.castVote(pids[1]!, true);
    room.castVote(pids[2]!, true);
    expect(inner(room).area).toBe('town');
    expect(inner(room).disconnected.has(saves[3]!.charId), 'ждёт реконнекта и в городе').toBe(true);
    expect(room.seatsTaken('newcomer'), 'пати ушла с этажа — места считаются по живым').toBe(3);
    const back = new FakeWs();
    const pidBack = room.reconnect(back as unknown as GameConn, `user-${saves[3]!.charId}`, structuredClone(db.data.get(saves[3]!.charId)!), db.saves.get(saves[3]!.charId)!);
    expect(back.last('joined')?.playerId, 'вернулся').toBe(pidBack);
  });
});

describe('⭐ R6-27: мощь узла — по сильнейшему герою забега, а не по хозяину комнаты', () => {
  it('хозяин — альт 1-го уровня, с ним основной 60-го: узел заселён по основному; и когда основной ждёт реконнекта', async () => {
    const power = cfg.get('balance').power;
    const { room, pids: [alt, main], saves: [, sMain] } = roomWith([1, 60]);
    const elMain = effectiveLevel(sMain!, power).total;
    downFromTown(room, [alt!, main!]);
    const levels = (): number[] => inner(room).session.world.monsters.map((m) => m.def.level);
    expect(inner(room).nodeState?.el, 'мощь первого узла — основного').toBe(elMain);
    expect(Math.min(...levels()), 'монстры — под основного, а не под альта').toBeGreaterThan(elMain - 10);
    await settle();
    // Основной ушёл спокойно (у портала) — его копия этого же забега ждёт реконнекта; альт спускается один.
    const w = inner(room).session.world;
    w.players[main!]!.pos = { ...w.spawn };
    await room.removePlayer(main!);
    const to = nodeNow(room).edges[0]!.to;
    inner(room).movedAt = 0;
    toExit(room, alt!, to);
    room.descend(alt!, undefined, to);
    expect(inner(room).runNodeId).toBe(to);
    expect(inner(room).nodeState?.el, 'отключился перед спуском — узел всё равно по нему').toBe(elMain);
  });
});
