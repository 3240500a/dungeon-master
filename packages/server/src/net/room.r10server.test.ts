import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, effectiveLevel, hasLineOfSight, worldToCell, cellToWorld, isBlockedCell, shopBuyPrice, PRICE_CHANGED,
  type ServerFrame, type SaveState, type RunPlan, type RunNode, type Item,
} from '@dm/shared';
import { limits } from './rateLimit.js';

// Тесты файла ждут комнату оборотами цикла и перебирают этажи (генерация — десятки мс на этаж); под нагрузкой полного прогона
// умолчание 5 с — лотерея. Гонки этот потолок не прячет — они падают утверждением, а не временем.
vi.setConfig({ testTimeout: 120_000 });

/**
 * Раунд 10 (сервер) через настоящую `Room`: переход «от выхода» — только со своей стороны стены (R10-01); отказ «цена
 * изменилась» не рассылает прилавок всей комнате (R10-06); вошедший, пока продолжение ждёт свод из базы, не уносится в чужой
 * забег (R10-07); ждущий реконнекта, чей забег пати увела в город, мощь новых узлов не задаёт (R10-08). Сокет — фейковый,
 * база — маленькая честная (версии сейва), чтение свода можно задержать (`ledgerGate`).
 */
const db = vi.hoisted(() => ({
  saves: new Map<string, number>(),
  data: new Map<string, SaveState>(),
  /** R10-07: чтение свода забега ждёт, пока тест его не отпустит (медленная база). */
  ledgerGate: null as Promise<void> | null,
}));
vi.mock('../db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    const snap = structuredClone(data);
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
  getRunLedger: async () => { if (db.ledgerGate) await db.ledgerGate; return []; },
  mergeRunLedger: () => Promise.resolve(),
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
  db.ledgerGate = null;
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
  all<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }>[] {
    return this.frames.filter((f) => f.t === t) as Extract<ServerFrame, { t: T }>[];
  }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    const a = this.all(t);
    return a[a.length - 1];
  }
}

type Pt = { x: number; y: number };
type RoomIn = {
  area: string; movedAt: number; resuming: boolean; runPlan: RunPlan | null; runNodeId: string | null;
  decor: { kind: string; x: number; y: number }[];
  shop: Item[];
  nodeState: { el: number } | null;
  disconnected: Map<string, { fled: boolean; safe?: boolean }>;
  session: {
    world: {
      grid: number[][]; spawn: Pt; exits?: Pt[];
      monsters: { alive: boolean; pos: Pt; aiState: string; def: { rarity: string } }[];
      players: Record<string, { pos: Pt; save: SaveState }>;
    };
  };
  enterNode(id: string, resumed?: boolean): void;
};
const inner = (room: Room): RoomIn => room as unknown as RoomIn;
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Продолжение из города ждёт свод из базы (у мока — готовые промисы): дождаться одних микрозадач. */
const drained = async (): Promise<void> => { for (let i = 0; i < 500; i++) await Promise.resolve(); };
const ready = (room: Room): void => { inner(room).movedAt = 0; };
let seq = 0;

function hero(level: number, gold = 10_000): { save: SaveState; userId: string } {
  const charId = `char-r10s-${++seq}`;
  const uid = `user-${charId}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(uid);
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, `H${seq}`, charId);
  s.level = level;
  s.gold = gold;
  db.saves.set(charId, 1);
  db.data.set(charId, structuredClone(s));
  return { save: s, userId: uid };
}
function newRoom(code: string): Room {
  const room = new RoomCtor(code, cfg, { onEmpty() {}, onGrace() {}, onUngrace() {}, onFarewell() {} });
  rooms.push(room);
  return room;
}
function join(room: Room, h: { save: SaveState; userId: string }, save = h.save): { ws: FakeWs; pid: string } {
  const ws = new FakeWs();
  const pid = room.addPlayer(ws as unknown as GameConn, h.userId, save, db.saves.get(save.charId) ?? 1);
  return { ws, pid };
}
const nodeNow = (room: Room): RunNode => inner(room).runPlan!.nodes.find((n) => n.id === inner(room).runNodeId)!;
const noMonsters = (room: Room): void => { for (const m of inner(room).session.world.monsters) m.alive = false; };
const place = (room: Room, pid: string, at: Pt): void => { inner(room).session.world.players[pid]!.pos = { x: at.x, y: at.y }; };

// ── R10-01 ────────────────────────────────────────────────────────────────────
type W = RoomIn['session']['world'];
/** Шаги по сетке (4-связность, закрытая дверь — стена) от клетки точки `from` до каждой достижимой клетки. */
function steps(w: W, from: Pt): Map<string, number> {
  const s = worldToCell(from.x, from.y);
  const d = new Map([[`${s.cx},${s.cy}`, 0]]);
  const q = [s];
  for (let h = 0; h < q.length; h++) {
    const c = q[h]!;
    const cd = d.get(`${c.cx},${c.cy}`)!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { cx: c.cx + dx, cy: c.cy + dy };
      if (isBlockedCell(w.grid as never, n.cx, n.cy) || d.has(`${n.cx},${n.cy}`)) continue;
      d.set(`${n.cx},${n.cy}`, cd + 1);
      q.push(n);
    }
  }
  return d;
}
/**
 * Клетка пола, куда герой ДОХОДИТ от входа, чей центр в двух тайлах (64 px) от точки `at`, но сама точка за стеной: не видна и
 * обход до неё длиннее `minDetour` клеток. `null` — на этом этаже такой нет.
 */
function behindWall(w: W, at: Pt, minDetour = 12): Pt | null {
  const fromSpawn = steps(w, w.spawn);
  const toAt = steps(w, at);
  let best: { c: Pt; walk: number } | null = null;
  for (const [k, walk] of fromSpawn) {
    const [cx, cy] = k.split(',').map(Number) as [number, number];
    const c = cellToWorld(cx, cy);
    if (Math.hypot(c.x - at.x, c.y - at.y) > 64) continue;
    if (hasLineOfSight(w.grid as never, c.x, c.y, at.x, at.y)) continue;
    if ((toAt.get(k) ?? Infinity) < minDetour) continue;
    if (!best || walk < best.walk) best = { c, walk };
  }
  return best?.c ?? null;
}
/** Точка в 30 px от `at` в соседней по стороне клетке пола — честное «подошёл и нажал» (клиент зовёт с 34/44 px). */
function besideSameSide(w: W, at: Pt): Pt | null {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const p = { x: at.x + dx * 30, y: at.y + dy * 30 };
    const c = worldToCell(p.x, p.y);
    if (!isBlockedCell(w.grid as never, c.cx, c.cy)) return p;
  }
  return null;
}
/** Солo-комната на лабиринте архива (биом «dungeon»: стены в клетку), короткая вылазка. */
function mazeRun(n: number): { room: Room; ws: FakeWs; pid: string } {
  const room = newRoom(`R10M${n}`);
  const { ws, pid } = join(room, hero(5));
  ready(room);
  room.descend(pid, 'easy', undefined, { biomeId: 'dungeon', templateId: 'crypt-short' });
  expect(inner(room).area).toBe('dungeon');
  noMonsters(room);
  return { room, ws, pid };
}
const farErrors = (ws: FakeWs): number => ws.all('error').filter((e) => e.code === 'far').length;

describe('⭐ R10-01: выход, портал и вход — только со своей стороны стены', () => {
  it('выход лабиринта из соседнего коридора через стену в клетку (64 px, не видно) — «подойдите к выходу», спуска нет; у выхода — спуск', () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const { room, ws, pid } = mazeRun(attempt);
      const w = inner(room).session.world;
      const node = nodeNow(room);
      for (let i = 0; i < node.edges.length && i < (w.exits?.length ?? 0); i++) {
        const exit = w.exits![i]!;
        const far = behindWall(w, exit);
        if (!far) continue;
        const from = node.id, to = node.edges[i]!.to;
        const progress = inner(room).session.world.players[pid]!.save.difficultyProgress.easy ?? 0;
        place(room, pid, far);
        ready(room);
        room.descend(pid, undefined, to);
        expect(inner(room).runNodeId, 'из-за стены спуска нет').toBe(from);
        expect(farErrors(ws), 'зовущему — «подойдите к выходу»').toBe(1);
        expect(inner(room).session.world.players[pid]!.save.difficultyProgress.easy ?? 0, 'глубина не засчитана').toBe(progress);
        // Тот же спуск без выбора ветки — тоже нет (выход «у которого стоит» ищется тем же правилом).
        ready(room);
        room.descend(pid);
        expect(inner(room).runNodeId).toBe(from);
        // Честно: подошёл к выходу со своей стороны (30 px) — спуск.
        const near = besideSameSide(w, exit)!;
        expect(near, 'у выхода есть клетка пола').toBeTruthy();
        place(room, pid, near);
        ready(room);
        room.descend(pid, undefined, to);
        expect(inner(room).runNodeId, 'со своей стороны — спуск').toBe(to);
        return;
      }
      room.stop();   // этаж не подошёл — комната не тикает до конца теста
    }
    throw new Error('за 60 этажей не нашлось выхода за стеной');
  });

  it('портал финала-лабиринта из-за стены — «подойдите к порталу», забег не завершён; у портала — завершён', () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { room, ws, pid } = mazeRun(100 + attempt);
      const fin = inner(room).runPlan!.nodes.find((x) => x.edges.length === 0)!;
      if ((fin.floorSpec as { algoParams?: { algorithm?: string } }).algoParams?.algorithm !== 'maze') { room.stop(); continue; }
      ready(room);
      inner(room).enterNode(fin.id);   // пати дошла до финала (честно — спусками; здесь — сразу, ради портала)
      noMonsters(room);
      const w = inner(room).session.world;
      const portal = inner(room).decor.find((d) => d.kind === 'portal');
      const far = portal && behindWall(w, portal);
      if (!portal || !far) { room.stop(); continue; }
      place(room, pid, far);
      ready(room);
      room.descend(pid);
      expect(inner(room).area, 'из-за стены забег не завершается').toBe('dungeon');
      expect(inner(room).runPlan, 'забег цел').not.toBeNull();
      expect(farErrors(ws), 'зовущему — «подойдите к порталу»').toBe(1);
      place(room, pid, portal);
      ready(room);
      room.descend(pid);
      expect(inner(room).area, 'у портала — завершён').toBe('town');
      return;
    }
    throw new Error('за 200 забегов не нашлось финала-лабиринта с порталом за стеной');
  });

  it('«в город» от точки входа из-за стены — отказ; у точки входа — уход', () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const { room, ws, pid } = mazeRun(400 + attempt);
      const w = inner(room).session.world;
      const far = behindWall(w, w.spawn, 8);
      if (!far) { room.stop(); continue; }
      place(room, pid, far);
      ready(room);
      room.returnTown(pid);
      expect(inner(room).area, 'из-за стены — не уходит').toBe('dungeon');
      expect(farErrors(ws)).toBe(1);
      place(room, pid, w.spawn);
      ready(room);
      room.returnTown(pid);
      expect(inner(room).area, 'у входа — в городе').toBe('town');
      return;
    }
    throw new Error('за 60 этажей не нашлось клетки за стеной у входа');
  });
});

// ── R10-06 ────────────────────────────────────────────────────────────────────
describe('⭐ R10-06: отказ «цена изменилась» — прилавок только зовущему и в меру', () => {
  /** Четверо в городе; первый вошедший (`a`, хозяин прилавка) зовёт покупку. */
  function party(code: string, gold = 0): { room: Room; a: { ws: FakeWs; pid: string }; peers: FakeWs[]; uid: string; price: number } {
    const room = newRoom(code);
    const a = join(room, hero(60, gold));
    const peers = [1, 2, 3].map(() => join(room, hero(5)).ws);
    const shop = a.ws.last('shop')!;
    const it = shop.items.find((i) => !i.use) ?? shop.items[0]!;
    return { room, a, peers, uid: it.uid, price: shop.prices![it.uid]! };
  }
  const shopsOf = (ws: FakeWs): number => ws.all('shop').length;

  it('поток buy{maxGold:0} без золота — соседям ни одного кадра прилавка, зовущему не больше лимита пересылок', async () => {
    const { room, a, peers, uid } = party('R10S1');
    const before = [shopsOf(a.ws), ...peers.map(shopsOf)];
    for (let i = 0; i < 120; i++) await room.handleCmd(a.pid, { cmd: 'buy', uid, maxGold: 0 }, i + 1);
    const reasons = a.ws.all('cmdResult').map((r) => r.reason ?? '');
    expect(reasons.length).toBe(120);
    expect(reasons.every((r) => r.startsWith(PRICE_CHANGED)), 'каждый отказ — «цена изменилась»').toBe(true);
    peers.forEach((ws, k) => expect(shopsOf(ws) - before[k + 1]!, `сосед ${k + 1}: кадров прилавка`).toBe(0));
    expect(shopsOf(a.ws) - before[0]!, 'зовущему — в меру лимита пересылок (5 подряд)').toBeLessThanOrEqual(5);
    expect(shopsOf(a.ws) - before[0]!, 'но хоть один — с правдой о цене').toBeGreaterThanOrEqual(1);
  });

  it('честный отказ (maxGold = цена − 1) — ровно один кадр прилавка покупателю, с ценой сервера; соседям — ничего', async () => {
    const { room, a, peers, uid, price } = party('R10S2', 1_000_000);
    const before = [shopsOf(a.ws), ...peers.map(shopsOf)];
    await room.handleCmd(a.pid, { cmd: 'buy', uid, maxGold: price - 1 }, 1);
    expect(a.ws.last('cmdResult')?.reason?.startsWith(PRICE_CHANGED)).toBe(true);
    expect(shopsOf(a.ws) - before[0]!).toBe(1);
    const frame = a.ws.last('shop')!;
    expect(frame.prices![uid], 'цена — сервера').toBe(shopBuyPrice(cfg, frame.items.find((i) => i.uid === uid)!));
    peers.forEach((ws, k) => expect(shopsOf(ws) - before[k + 1]!).toBe(0));
  });

  it('контроль: успешная покупка по-прежнему показывает новый прилавок всем', async () => {
    const { room, a, peers, uid, price } = party('R10S3', 1_000_000);
    const before = peers.map(shopsOf);
    await room.handleCmd(a.pid, { cmd: 'buy', uid, maxGold: price }, 1);
    expect(a.ws.last('cmdResult')?.ok).toBe(true);
    peers.forEach((ws, k) => expect(shopsOf(ws) - before[k]!, 'вещи на прилавке больше нет — видят все').toBe(1));
  });
});

// ── R10-07 ────────────────────────────────────────────────────────────────────
describe('⭐ R10-07: вошедший, пока продолжение ждёт свод из базы, в чужой забег не уносится', () => {
  /** Припарковать забег герою `h`: соло спуск в комнате `code`, у входа — в город, выход. Возвращает сейв из «базы». */
  async function parkRun(code: string, h: { save: SaveState; userId: string }): Promise<SaveState> {
    const room = newRoom(code);
    const a = join(room, h).pid;
    ready(room);
    room.descend(a, 'easy');
    expect(inner(room).area).toBe('dungeon');
    noMonsters(room);
    place(room, a, inner(room).session.world.spawn);
    ready(room);
    room.returnTown(a);
    expect(inner(room).area).toBe('town');
    await room.removePlayer(a);
    await settle();
    const parked = structuredClone(db.data.get(h.save.charId)!);
    expect(parked.run?.config, 'забег припаркован').toBeTruthy();
    return parked;
  }
  /** Хозяин со своим припаркованным забегом в свежей комнате зовёт спуск соло — голос прошёл, продолжение ждёт базу. */
  async function resumePending(code: string): Promise<{ room: Room; host: { ws: FakeWs; pid: string }; hostParked: SaveState; open: () => void }> {
    const hHost = hero(5);
    const hostParked = await parkRun(`${code}A`, hHost);
    const room = newRoom(code);
    const host = join(room, hHost, hostParked);
    let open!: () => void;
    db.ledgerGate = new Promise<void>((r) => { open = r; });
    ready(room);
    room.descend(host.pid);
    expect(inner(room).resuming, 'продолжение ждёт свод').toBe(true);
    expect(inner(room).area).toBe('town');
    return { room, host, hostParked, open };
  }

  it('вошёл по коду со СВОИМ припаркованным забегом — его забег цел, штрафа нет; продолжение отменено «пати изменилась»', async () => {
    const hJoin = hero(5);
    const joinParked = await parkRun('R10R1B', hJoin);
    const { room, host, hostParked, open } = await resumePending('R10R1');
    // Числа — ДО входа: сейв вошедшего комната ведёт тем же объектом.
    const ownSeed = joinParked.run!.config.seed, gold = joinParked.gold;
    expect(ownSeed).not.toBe(hostParked.run!.config.seed);
    const j = join(room, hJoin, joinParked);
    const js = inner(room).session.world.players[j.pid]!.save;
    open();
    await drained();
    await settle();
    expect(js.run?.config.seed, 'забег вошедшего — его').toBe(ownSeed);
    expect(js.gold, 'без штрафа — и без «Завершить»').toBe(gold);
    expect(inner(room).area, 'продолжения не было').toBe('town');
    expect(host.ws.all('error').some((e) => e.code === 'vote'), 'зовущим — «пати изменилась»').toBe(true);
  });

  it('вошёл без забега — тоже не уносится без голоса: продолжение отменено; позвали снова — идут вместе', async () => {
    const { room, host, hostParked, open } = await resumePending('R10R2');
    const j = join(room, hero(5));
    open();
    await drained();
    await settle();
    expect(inner(room).area).toBe('town');
    expect(inner(room).session.world.players[j.pid]!.save.run, 'без голоса в забег не записан').toBeUndefined();
    db.ledgerGate = null;
    ready(room);
    room.descend(host.pid);
    room.castVote(j.pid, true);
    await drained();
    await settle();
    expect(inner(room).area).toBe('dungeon');
    expect(inner(room).session.world.players[j.pid]!.save.run?.config.seed).toBe(hostParked.run!.config.seed);
  });

  it('контроль: вошедший ПОСЛЕ продолжения — как прежде: встаёт в забег комнаты', async () => {
    const { room, hostParked, open } = await resumePending('R10R3');
    open();
    await drained();
    await settle();
    expect(inner(room).area, 'продолжение прошло').toBe('dungeon');
    const j = join(room, hero(5));
    expect(inner(room).session.world.players[j.pid]!.save.run?.config.seed).toBe(hostParked.run!.config.seed);
  });
});

// ── R10-08 ────────────────────────────────────────────────────────────────────
describe('⭐ R10-08: ждущий реконнекта, чей забег пати увела в город, мощь новых узлов не задаёт', () => {
  const power = (): Parameters<typeof effectiveLevel>[1] => cfg.get('balance').power;
  /** Слабый A и сильный B спустились; B спокойно (у входа, монстров нет) закрыл вкладку. */
  async function strongLeft(code: string): Promise<{ room: Room; a: string; B: { save: SaveState; userId: string }; elA: number; elB: number }> {
    const room = newRoom(code);
    const hA = hero(1), hB = hero(60);
    const a = join(room, hA).pid, b = join(room, hB).pid;
    ready(room);
    room.descend(a, 'easy');
    room.castVote(b, true);
    expect(inner(room).area).toBe('dungeon');
    const elA = effectiveLevel(hA.save, power()).total, elB = effectiveLevel(hB.save, power()).total;
    expect(elA).toBeLessThan(elB);
    expect(inner(room).nodeState?.el, 'первый узел — по сильнейшему (R6-27)').toBe(elB);
    noMonsters(room);
    place(room, b, inner(room).session.world.spawn);
    await room.removePlayer(b);
    await settle();
    expect(inner(room).disconnected.get(hB.save.charId), 'ушёл спокойно').toMatchObject({ fled: false });
    return { room, a, B: hB, elA, elB };
  }
  /** Спуск A по первому ребру от его выхода. */
  function descendAlone(room: Room, a: string): string {
    const to = nodeNow(room).edges[0]!.to;
    place(room, a, inner(room).session.world.exits![0]!);
    ready(room);
    room.descend(a, undefined, to);
    expect(inner(room).runNodeId).toBe(to);
    noMonsters(room);
    return to;
  }

  it('A увёл забег в город (B «вышел из города») и спустился на НОВЫЙ узел — узел по мощи A, а не B', async () => {
    const { room, a, B, elA, elB } = await strongLeft('R10P1');
    place(room, a, inner(room).session.world.spawn);
    ready(room);
    room.returnTown(a);
    expect(inner(room).area).toBe('town');
    expect(inner(room).disconnected.get(B.save.charId), 'B — припаркован').toMatchObject({ safe: true });
    ready(room);
    room.descend(a);                 // продолжение забега A (со сводом из базы)
    await drained();
    expect(inner(room).area).toBe('dungeon');
    descendAlone(room, a);
    expect(inner(room).nodeState?.el, `новый узел — по A (${elA}), а не по B (${elB})`).toBe(elA);
    // B вернулся («Продолжить») — на этот узел, как вошедший по коду (R7-02: глубины за него нет); следующий новый узел — по нему.
    await settle();
    const back = new FakeWs();
    const pb = room.reconnect(back as unknown as GameConn, B.userId, structuredClone(db.data.get(B.save.charId)!), db.saves.get(B.save.charId)!);
    noMonsters(room);
    const to = nodeNow(room).edges[0]!.to;
    place(room, a, inner(room).session.world.exits![0]!);
    place(room, pb, inner(room).session.world.exits![0]!);
    ready(room);
    room.descend(a, undefined, to);
    room.castVote(pb, true);
    expect(inner(room).runNodeId).toBe(to);
    expect(inner(room).nodeState?.el, 'вернувшийся снова в счёте').toBe(elB);
  });

  it('контроль (R6-27): B отключился на ЭТОМ узле, пати спускается без города — новый узел всё равно по B', async () => {
    const { room, a, elB } = await strongLeft('R10P2');
    descendAlone(room, a);
    expect(inner(room).nodeState?.el).toBe(elB);
  });
});
