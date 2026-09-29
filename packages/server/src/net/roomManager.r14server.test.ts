import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, hasLineOfSight, isWalkableWorld, type ServerFrame, type SaveState, type Grid } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла, слив — своими паузами между кругами; под нагрузкой полного прогона умолчание 5 с — лотерея.
// Исходы решает мок базы (легла ли фиксация, упал ли свод), а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 14 (сервер), граница менеджера комнат. Менеджер и комнаты — настоящие; база — маленькая честная (версии сейва): запись героя
 * умеет зависнуть до знака теста и лечь с потерянным ответом (`CommitUnknown`), свод забега — упасть.
 *  • R14-04: запись с неизвестным исходом ЛЕГЛА, а копия в памяти ушла дальше её снимка (выброс соседу по аккаунту, смерть тела в
 *    бою) — дописка сверяет строку с отправленным снимком и пишет поверх легшей версии, а не выбрасывается «правдой в базе»;
 *  • R14-07: слив ноды ждёт и свод записей забега, а не только сейвы.
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number; json?: string }>(),
  /** Следующая запись героя ждёт, пока тест не откроет. */
  gate: new Map<string, Promise<void>>(),
  /** Следующая запись героя ляжет, а ответ потеряется (`CommitUnknown` со снимком, как у `db.ts`). */
  landUnknown: new Set<string>(),
  log: [] as string[],
  /** R14-07: столько следующих записей свода упадут (блокировка строки другой нодой). */
  ledgerFails: 0,
  ledgerCalls: 0,
  ledgerOk: 0,
  /** ⭐ R20-01: следующая запись свода висит, пока тест не откроет (база медленная, моргнула), — и кончается по `ledgerFails`. */
  ledgerGate: null as null | Promise<void>,
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => [],
  mergeRunLedger: async () => {
    db.ledgerCalls++;
    const g = db.ledgerGate;
    if (g) { db.ledgerGate = null; await g; } else await new Promise((res) => setTimeout(res, 1));
    if (db.ledgerFails > 0) { db.ledgerFails--; throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }); }
    db.ledgerOk++;
  },
  getSession: async () => 'user-r14rm',
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r14rm', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data), json = JSON.stringify(data);   // снимок — в момент вызова, как `snapshotOf`
    const g = db.gate.get(charId);
    if (g) { db.gate.delete(charId); await g; } else await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    if (db.landUnknown.delete(charId)) {
      const { CommitUnknown } = await import('../db/errors.js');
      if (r && v === r.version) { r.version = v + 1; r.data = snap; r.json = json; }
      db.log.push(`${charId} v${v} COMMIT-UNKNOWN (landed)`);
      const e = new CommitUnknown(new Error('Connection terminated unexpectedly'), false);
      e.sent = json;
      throw e;
    }
    if (!r || v !== r.version) { db.log.push(`${charId} v${v} CONFLICT`); return null; }
    r.version = v + 1; r.data = snap; r.json = json;
    db.log.push(`${charId} v${v}->v${r.version}`);
    return r.version;
  },
  landedVersion: async (charId: string, json: string, v: number) => {
    const r = db.chars.get(charId);
    return r && r.version === v + 1 && r.json === json ? r.version : null;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

const TOK = 'f4'.repeat(32);
class FakeConn implements GameConn {
  open = true;
  frames: ServerFrame[] = [];
  closedWith?: number;
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  constructor(readonly ip = '127.0.0.1') {}
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(code?: number): void { if (!this.open) return; this.open = false; this.closedWith = code; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(JSON.stringify(frame)); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Ждать условия оборотами цикла (не часами): записи мока идут кругами по миллисекунде. */
async function until(what: string, ok: () => boolean, turns = 5_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}

type Drop = { id: number; pos: { x: number; y: number }; item?: { uid: string } };
type Mon = { alive: boolean; pos: { x: number; y: number }; aiState: string };
type Pl = { hp: number; maxHp: number; alive: boolean; pos: { x: number; y: number }; save: SaveState };
type RoomIn = {
  code: string; area: string; movedAt: number; stop(): void; step(): void;
  persist(pid: string): Promise<string>;
  descend(pid: string): void; castVote(pid: string, yes: boolean): void; markLedger(id?: string): void;
  endRun(): void; enterTown(): void; ledgerPending(): boolean; flushOwed(): Promise<void>;
  lingering: Map<string, unknown>; ledgerOut: Map<string, unknown>;
  session: { world: { drops: Drop[]; monsters: Mon[]; spawn: { x: number; y: number }; players: Record<string, Pl>; grid: Grid } };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; unsaved: Map<string, unknown>;
  charOps: Map<string, unknown>;
  handleConnection(ws: GameConn): void;
  flushAll(budgetMs?: number): Promise<unknown>;
};
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
/** Свой менеджер на тест: слив замораживает его навсегда (как процесс, который уходит). */
function manager(): RMIn {
  vi.useFakeTimers({ toFake: ['setInterval'] });   // без фоновой дописи копий по таймеру (R3-19): её зовёт вход
  try {
    const rm = new RoomManagerCtor(cfg) as unknown as RMIn;
    managers.push(rm);
    return rm;
  } finally { vi.useRealTimers(); }
}
beforeEach(() => {
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync]) l.reset('user-r14rm');
});
afterEach(() => {
  db.gate.clear(); db.landUnknown.clear(); db.ledgerFails = 0; db.ledgerGate = null;
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.restoreAllMocks();
});

function seed(id: string, patch?: (s: SaveState) => void): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  patch?.(s);
  db.chars.set(id, { data: s, version: 1 });
}
const row = (id: string): SaveState => db.chars.get(id)!.data as SaveState;
const uidsOf = (s: SaveState): string[] => [
  ...Object.values(s.equipment).filter(Boolean).map((i) => i!.uid), ...s.inventory.map((i) => i.uid), ...s.belt.filter(Boolean).map((i) => i!.uid),
];
let ipSeq = 0;
async function joinFresh(rm: RMIn, charId: string, roomCode?: string): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(roomCode ? { roomCode } : { fresh: true }) });
  await until(`${charId} вошёл`, () => !!ws.last('joined') || !!ws.last('error'));
  return ws;
}
/** Запись героя повиснет до `open()` и ляжет с потерянным ответом. */
function stall(charId: string): () => void {
  let open!: () => void;
  db.gate.set(charId, new Promise<void>((r) => { open = r; }));
  db.landUnknown.add(charId);
  return () => open();
}

describe('⭐ R14-04: фиксация с неизвестным исходом легла — дописка пишет поверх неё, а не выбрасывается', () => {
  it('⭐ A выбросил X, ПОКА висела его запись со снимком «X в сумке»: B поднимет X только после копии A поверх легшей — X только у B', async () => {
    const rm = manager();
    let X = '';
    seed('R14A', (s) => { const w = s.equipment.weapon!; delete s.equipment.weapon; w.pos = { x: 0, y: 0 }; s.inventory.push(w); X = w.uid; });
    seed('R14B');
    const wsA = await joinFresh(rm, 'R14A');
    const code = wsA.last('joined')!.roomCode;
    const pidA = wsA.last('joined')!.playerId;
    const wsB = await joinFresh(rm, 'R14B', code);
    const pidB = wsB.last('joined')!.playerId;
    const room = rm.rooms.get(code)!;
    await until('записи входа легли', () => !rm.inflight.size);
    for (let i = 0; i < 30; i++) await tick();

    // Автосейв A снял снимок (X в сумке) — и фиксация повисла.
    const open = stall('R14A');
    const wA = room.persist(pidA);
    await tick();
    // Пока висит: A бросил X, B тянется поднять. ⭐ V-B2-04: строка A держит X (легла повисшая — с ним), подъём ждёт записи A без него.
    wsA.push({ t: 'cmd', command: { cmd: 'drop', uid: X }, id: 1 });
    await until('X на земле', () => room.session.world.drops.some((d) => d.item?.uid === X));
    const drop = room.session.world.drops.find((d) => d.item?.uid === X)!;
    room.session.world.players[pidB]!.pos = { ...drop.pos };
    wsB.push({ t: 'cmd', command: { cmd: 'pickup', dropId: drop.id }, id: 1 });
    // Фиксация A легла (снимок с X), ответ потерян.
    open();
    expect(await wA).toBe('unknown');
    const landed = db.chars.get('R14A')!.version;
    await until('A снят (4009)', () => wsA.closedWith === 4009);
    await until('подъём B отвечен', () => wsB.frames.some((f) => f.t === 'cmdResult' && f.id === 1));
    expect(wsB.last('cmdResult'), 'копия A без X ещё не легла — X не поднять').toMatchObject({ id: 1, ok: false });
    expect(uidsOf(room.session.world.players[pidB]!.save)).not.toContain(X);
    await until('менеджер отпустил A', () => !rm.live.has('R14A') && !rm.inflight.has('R14A') && !rm.charOps.has('R14A'));

    // A входит снова: копия «на дописать» дописывается (поверх легшей), потом строка читается.
    const ws2 = await joinFresh(rm, 'R14A');
    expect(ws2.last('error'), JSON.stringify(ws2.last('error'))).toBeUndefined();
    // Копия A без X легла — X больше не его строки: B поднимает, запись B ложится.
    wsB.push({ t: 'cmd', command: { cmd: 'pickup', dropId: drop.id }, id: 2 });
    await until('X у B', () => uidsOf(room.session.world.players[pidB]!.save).includes(X));
    expect(await room.persist(pidB)).toBe('ok');
    const log = db.log.filter((l) => l.startsWith('R14A')).join(' | ');
    expect(uidsOf(row('R14B')), 'X в строке B').toContain(X);
    expect(uidsOf(row('R14A')), `X не в строке A: ${log}`).not.toContain(X);
    expect(db.chars.get('R14A')!.version, 'копия записана поверх легшей версии').toBeGreaterThan(landed);
    expect(uidsOf(ws2.last('joined')!.save as SaveState)).not.toContain(X);
  });

  it('⭐ тело в бою: прощальная запись легла с потерянным ответом, тело погибло — штраф смерти в строке', async () => {
    const rm = manager();
    seed('R14L', (s) => { s.level = 30; s.gold = 5000; s.attributes.vitality = 60; });
    seed('R14M', (s) => { s.level = 30; s.attributes.vitality = 60; });
    const wsA = await joinFresh(rm, 'R14L');
    const code = wsA.last('joined')!.roomCode;
    const pidA = wsA.last('joined')!.playerId;
    const wsB = await joinFresh(rm, 'R14M', code);
    const pidB = wsB.last('joined')!.playerId;
    const room = rm.rooms.get(code)!;
    await until('записи входа легли', () => !rm.inflight.size);
    room.movedAt = 0; room.descend(pidA); room.castVote(pidB, true);
    expect(room.area).toBe('dungeon');
    room.stop();   // тик — только шагами теста
    await until('записи спуска легли', () => !rm.inflight.size);
    for (let i = 0; i < 30; i++) await tick();
    const w = room.session.world;
    for (const m of w.monsters) m.alive = false;
    // A — на проходимом месте в виду у монстра вдали от входа (этаж у забега случайный), ещё трое — рядом с ним.
    const far = w.monsters.slice().sort((m1, m2) => Math.hypot(m2.pos.x - w.spawn.x, m2.pos.y - w.spawn.y) - Math.hypot(m1.pos.x - w.spawn.x, m1.pos.y - w.spawn.y));
    const offs = [[30, 0], [-30, 0], [0, 30], [0, -30], [21, 21], [-21, 21], [21, -21], [-21, -21]] as const;
    const clear = (x: number, y: number, from: { x: number; y: number }): boolean => isWalkableWorld(w.grid, x, y) && hasLineOfSight(w.grid, from.x, from.y, x, y);
    const lead = far.find((m) => offs.some(([dx, dy]) => clear(m.pos.x + dx, m.pos.y + dy, m.pos)))!;
    const at = { ...lead.pos };
    const [dx, dy] = offs.find(([ox, oy]) => clear(at.x + ox, at.y + oy, at))!;
    [lead, ...far.filter((m) => m !== lead).slice(0, 3)].forEach((m) => { m.alive = true; m.aiState = 'chase'; if (m !== lead) m.pos = { ...at }; });
    w.players[pidA]!.pos = { x: at.x + dx, y: at.y + dy };
    w.players[pidA]!.hp = 1;
    w.players[pidB]!.pos = { ...w.spawn };

    const open = stall('R14L');
    wsA.close();   // ушёл посреди боя: тело остаётся в бою, прощальная запись повисла
    await until('тело в бою', () => room.lingering.size === 1);
    open();
    await until('прощальная запись вернулась', () => db.log.some((l) => l.startsWith('R14L') && l.includes('COMMIT-UNKNOWN')));
    for (let i = 0; i < 30; i++) await tick();
    const landedGold = row('R14L').gold;
    expect(landedGold, 'легла копия до смерти').toBe(5000);
    for (let t = 0; t < 30 * 8 && room.lingering.size; t++) { w.players[pidB]!.hp = w.players[pidB]!.maxHp; room.step(); }
    expect(room.lingering.size, 'тело погибло').toBe(0);
    for (let i = 0; i < 100; i++) await tick();   // запись штрафа — кругами мока по миллисекунде
    expect(row('R14L').gold, `штраф смерти в строке: ${db.log.filter((l) => l.startsWith('R14L')).join(' | ')}`).toBeLessThan(5000);
  });
});

describe('⭐ R14-07: слив ноды ждёт и свод записей забега', () => {
  it('первая запись свода на сливе упала (блокировка строки), сейвы легли — слив пробует снова, свод в базе, очередь пуста', async () => {
    const rm = manager();
    seed('R14D');
    const ws = await joinFresh(rm, 'R14D');
    const room = rm.rooms.get(ws.last('joined')!.roomCode)!;
    room.movedAt = 0;
    ws.push({ t: 'descend' });
    await until('подземелье', () => room.area === 'dungeon');
    await until('записи спуска легли', () => !rm.inflight.size);
    for (let i = 0; i < 50; i++) await tick();
    room.markLedger();   // узел изменился (сундук, убитый) — запись свода ждёт чекпойнта
    db.ledgerCalls = 0; db.ledgerOk = 0; db.ledgerFails = 1;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await rm.flushAll(3_000);
    expect(db.ledgerCalls, 'свод пробовался ещё раз').toBeGreaterThanOrEqual(2);
    expect(db.ledgerOk, 'свод дописан до выхода процесса').toBeGreaterThan(0);
    expect(room.ledgerOut.size, 'очередь свода комнаты пуста').toBe(0);
  });

  // ⭐ K2 (фаззер кластера B1): строка героя не обгоняет свод его забега — свод не ложится, не ложится и сейв, чей снимок несёт его записи
  // (иначе продолжение забега другим собрало бы узел без взятого: сундук и опыт второй раз). Раньше здесь сейвы ложились без свода.
  it('свод не ложится весь бюджет — ИНЦИДЕНТ в лог и +1 к dm_ledger_drain_lost_total; сейв героя забега — тоже ИНЦИДЕНТ, а не запись поперёд свода', async () => {
    const rm = manager();
    seed('R14E');
    const ws = await joinFresh(rm, 'R14E');
    const room = rm.rooms.get(ws.last('joined')!.roomCode)!;
    room.movedAt = 0;
    ws.push({ t: 'descend' });
    await until('подземелье', () => room.area === 'dungeon');
    await until('записи спуска легли', () => !rm.inflight.size);
    for (let i = 0; i < 50; i++) await tick();
    room.markLedger();
    db.ledgerFails = 1_000_000;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const { counters } = await import('./metrics.js');
    const lost0 = counters.ledgerDrainLost, forgot0 = counters.farewellForgotten;
    const v0 = db.chars.get('R14E')!.version;
    await rm.flushAll(400);
    expect(counters.ledgerDrainLost - lost0).toBe(1);
    expect(counters.farewellForgotten - forgot0, 'K2: сейв героя забега без свода не лёг — ИНЦИДЕНТ и на героя').toBe(1);
    expect(db.chars.get('R14E')!.version, 'K2: строка героя не обогнала свод').toBe(v0);
    expect(errors.some((l) => l.includes('ИНЦИДЕНТ') && l.includes(room.code) && l.includes('свод')), errors.join(' | ')).toBe(true);
  });

  /**
   * ⭐ R20-01: пати кончила забег (финал, вайп — `endRun`), пачка свода ушла в базу и там висит (`ledgerGate`: база медленная, моргнула при
   * деплое), а последний вышел из города — комната снята (`stop`). Сейв героя забег больше не несёт — его прощание свод не ждёт (K2). Раньше снятая
   * комната с пачкой в пути выпадала из учёта недолёгшего (`ledgerOwing` считал только очередь), и слив её не видел: выход за миллисекунды, пачка
   * падала после — записей узлов в базе нет, ИНЦИДЕНТА нет, а «Продолжить» участника с припаркованной копией собирал узел по неполному своду.
   */
  async function tornDown(rm: RMIn, id: string): Promise<{ room: RoomIn; open: () => void }> {
    const { ledgerOwingRooms } = await import('./room.js');
    for (const r of ledgerOwingRooms()) await (r as unknown as RoomIn).flushOwed();   // недолёгшее прошлых тестов — не в счёт слива
    seed(id);
    const ws = await joinFresh(rm, id);
    const room = rm.rooms.get(ws.last('joined')!.roomCode)!;
    room.movedAt = 0;
    ws.push({ t: 'descend' });
    await until('подземелье', () => room.area === 'dungeon');
    await until('записи спуска легли', () => !rm.inflight.size);
    await until('свод спуска лёг', () => !room.ledgerPending());
    room.markLedger();   // узел изменился (сундук, убитый)
    let open!: () => void;
    db.ledgerGate = new Promise<void>((r) => { open = r; });
    db.ledgerCalls = 0; db.ledgerOk = 0;
    room.endRun();   // финал (вайп): свод — в базу
    room.enterTown();
    await until('пачка свода в пути', () => db.ledgerCalls >= 1);
    ws.close();   // последний закрыл вкладку в городе
    await until('прощание легло', () => !rm.inflight.size);
    expect(rm.rooms.has(room.code), 'комната снята').toBe(false);
    expect(room.ledgerPending(), 'её свод — в пути').toBe(true);
    return { room, open };
  }

  it('⭐ R20-01: пачка свода снятой комнаты в пути — слив ждёт её (а не выходит за миллисекунды) и выходит, когда она легла', async () => {
    const rm = manager();
    const { room, open } = await tornDown(rm, 'R20A');
    let drained = false;
    const d = rm.flushAll(30_000).then(() => { drained = true; });
    for (let i = 0; i < 200; i++) await tick();
    expect(drained, 'слив не вышел, пока пачка свода в пути').toBe(false);
    open();
    await d;
    expect(db.ledgerOk, 'пачка легла до выхода процесса').toBeGreaterThanOrEqual(1);
    expect(room.ledgerPending(), 'у снятой комнаты свод в базе').toBe(false);
  });

  it('⭐ R20-01: …а пачка падает весь бюджет — снятая комната пишет её снова, в конце ИНЦИДЕНТ и +1 к dm_ledger_drain_lost_total', async () => {
    const rm = manager();
    const { room, open } = await tornDown(rm, 'R20B');
    db.ledgerFails = 1_000_000;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const { counters } = await import('./metrics.js');
    const lost0 = counters.ledgerDrainLost;
    let drained = false;
    const d = rm.flushAll(3_000).then(() => { drained = true; });
    for (let i = 0; i < 20; i++) await tick();
    expect(drained, 'слив не вышел, пока пачка свода в пути').toBe(false);
    open();
    await d;
    expect(db.ledgerCalls, 'пачку снятой комнаты слив пробовал снова').toBeGreaterThanOrEqual(2);
    expect(counters.ledgerDrainLost - lost0).toBe(1);
    expect(errors.some((l) => l.includes('ИНЦИДЕНТ') && l.includes(room.code) && l.includes('свод')), errors.join(' | ')).toBe(true);
    db.ledgerFails = 0;
    await room.flushOwed();   // база вернулась — снятая комната дописала своё (следующим тестам её свод не мешает)
    expect(room.ledgerPending()).toBe(false);
  });
});
