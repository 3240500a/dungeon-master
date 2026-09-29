import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type RunConfig } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 19 (сервер), R19-04: ДЕЙСТВУЮЩИЙ НАПАРНИК В ГОРОДЕ НЕ ДЕРЖИТ ОБЩИЙ ЗАБЕГ ЗАЛОЖНИКОМ. R18-04 оставил забег городу, где подключённый
 * участник ДЕЙСТВУЕТ (`runActive`), — чтобы вернувшийся после перезагрузки сел к пати. Но действие — любой кадр ввода с движением раз в две
 * минуты: нежелающий идти (или тролль) держал забег сколько хотел. «Продолжить» напарника садило в его город, спуск ждал его голоса (у
 * голосования нет срока), «Соло» и спуск — отказ `run` с кодом его комнаты (по коду — снова в его город), и выходом оставалось «Забросить» —
 * штраф смерти. Теперь спуск, позванный участником забега в городе держателя и отказанный другим («нет») или не принятый за `RUN_ASK_MS`,
 * даёт позвавшему забег: его следующее «Продолжить» уводит его в новую комнату на узел забега (как R17-02), а напарнику спуск отвечает `run`
 * с её кодом (к пати — по коду). Перезагрузка без такой просьбы садит к пати, как R18-04.
 *
 * Менеджер и комнаты — настоящие; база — маленькая честная (как в `roomManager.r18server.test.ts`). Часы процесса (`performance.now`:
 * активность, срок просьбы, пауза голосований) — поддельные: время идёт только шагом теста (`later`).
 */
const TOK = 'f9'.repeat(32);
const USER = 'user-r1904';
type Rec = { id: string; el: number; chests: number[]; killed: number[]; levers: number[] };
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: SaveState; version: number }>(),
  ledger: new Map<string, Map<string, { id: string; el: number; chests: number[]; killed: number[]; levers: number[] }>>(),
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async (key: string) => [...(db.ledger.get(key)?.values() ?? [])].map((r) => structuredClone(r)),
  mergeRunLedger: async (key: string, recs: Rec[]) => {
    await new Promise((res) => setTimeout(res, 1));
    let m = db.ledger.get(key);
    if (!m) db.ledger.set(key, (m = new Map()));
    const u = (a: number[] = [], b: number[] = []): number[] => [...new Set([...a, ...b])].sort((x, y) => x - y);
    for (const r of recs) {
      const cur = m.get(r.id);
      m.set(r.id, cur ? { ...cur, chests: u(cur.chests, r.chests), killed: u(cur.killed, r.killed), levers: u(cur.levers, r.levers) } : structuredClone(r));
    }
  },
  landedVersion: async () => null,
  getSession: async (token: string) => (token === 'f9'.repeat(32) ? 'user-r1904' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r1904', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: SaveState, v: number) => {
    const json = JSON.stringify(data);   // снимок — в момент вызова, как `snapshotOf`
    await new Promise((res) => setTimeout(res, 1));
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = JSON.parse(json) as SaveState;
    return r.version;
  },
  putCharacterOwned: async () => 'foreign',
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

class FakeConn implements GameConn {
  open = true;
  frames: ServerFrame[] = [];
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  constructor(readonly ip = '127.0.0.1') {}
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { if (!this.open) return; this.open = false; this.onEnd(); }
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

type Pl = { pos: { x: number; y: number }; save: SaveState; alive: boolean };
type RoomIn = {
  code: string; area: string; movedAt: number; runConfig: RunConfig | null;
  clients: Map<string, unknown>;
  stop(): void; step(emit?: boolean): void; descend(pid: string): void; returnTown(pid: string): void; castVote(pid: string, yes: boolean): void;
  holdsRun(key: string): boolean; runActive(key: string): boolean; ledgerPending(): boolean;
  session: { world: { players: Record<string, Pl>; spawn: { x: number; y: number }; monsters: { alive: boolean }[] } };
};
type RMIn = { rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>; charOps: Map<string, unknown>; handleConnection(ws: GameConn): void };
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let runLedgerKey: (cfg: RunConfig) => string;
let RUN_IDLE_MS: number;
let RUN_ASK_MS: number;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  ({ runLedgerKey, RUN_IDLE_MS, RUN_ASK_MS } = await import('./room.js') as unknown as { runLedgerKey: typeof runLedgerKey; RUN_IDLE_MS: number; RUN_ASK_MS: number });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
function manager(): RMIn {
  // Часы процесса — поддельные на весь тест (стоят, пока тест их не сдвинет); интервалы менеджера — тоже (фоновых кругов нет).
  vi.useFakeTimers({ toFake: ['setInterval', 'performance'] });
  later(1_000_000);
  const rm = new RoomManagerCtor(cfg) as unknown as RMIn;
  managers.push(rm);
  return rm;
}
/** Прошло `ms` по часам процесса. */
function later(ms: number): void { vi.advanceTimersByTime(ms); }
beforeEach(() => {
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync, limits.stashRead]) l.reset(USER);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function seed(id: string): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.gold = 10_000; s.attributes.vitality = 60;
  db.chars.set(id, { data: s, version: 1 });
}
let ipSeq = 0;
async function join(rm: RMIn, charId: string, how: { roomCode?: string; resume?: boolean } = {}): Promise<FakeConn> {
  for (const l of [limits.roomJoin, limits.roomCreate]) l.reset(USER);   // лимиты входа — не предмет теста (часы стоят)
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(how.roomCode ? { roomCode: how.roomCode } : how.resume ? { resume: true } : { fresh: true }) });
  await until(`${charId}: ответ на вход`, () => !!ws.last('joined') || !!ws.last('error'));
  return ws;
}
async function gone(rm: RMIn, charId: string): Promise<void> {
  await until(`${charId} снят`, () => !rm.live.has(charId) && !rm.inflight.has(charId) && !rm.charOps.has(charId));
}
/** Действует: кадр ввода с движением (любой такой кадр — действие, `Client.activeAt`). */
function act(ws: FakeConn): void {
  ws.push({ t: 'input', input: { move: { x: 1, y: 0 }, facing: 0, attack: false, interact: false, cast: null } });
}
const errs = (ws: FakeConn, from = 0): Extract<ServerFrame, { t: 'error' }>[] =>
  ws.frames.slice(from).filter((f): f is Extract<ServerFrame, { t: 'error' }> => f.t === 'error');

/**
 * A и B прошли узел вместе и вернулись в город: забег K припаркован у обоих, городская комната A держит его. B вышел из города; A стоит там
 * и действует (кадр ввода с движением раз в минуту — `minutes` минут), но спускаться не хочет.
 */
async function obstructed(rm: RMIn, a: string, b: string, minutes: number): Promise<{ room: RoomIn; key: string; wsA: FakeConn; pidA: string }> {
  seed(a); seed(b);
  const wsA = await join(rm, a);
  const code = wsA.last('joined')!.roomCode;
  const pidA = wsA.last('joined')!.playerId;
  const wsB = await join(rm, b, { roomCode: code });
  const pidB = wsB.last('joined')!.playerId;
  const room = rm.rooms.get(code)!;
  room.stop();   // тик — только шагами теста
  await until('записи входа легли', () => !rm.inflight.size);
  room.movedAt = 0; room.descend(pidA); room.castVote(pidB, true);
  expect(room.area).toBe('dungeon');
  const key = runLedgerKey(room.runConfig!);
  const w = room.session.world;
  for (const m of w.monsters) m.alive = false;
  w.players[pidA]!.pos = { ...w.spawn }; w.players[pidB]!.pos = { ...w.spawn };
  room.movedAt = 0; room.returnTown(pidA); room.castVote(pidB, true);
  expect(room.area, 'пати в городе').toBe('town');
  await until('свод лёг', () => !room.ledgerPending());
  wsB.push({ t: 'leave' });
  await gone(rm, b);
  expect(room.holdsRun(key), 'город A держит забег').toBe(true);
  for (let i = 0; i < minutes; i++) { later(60_000); act(wsA); }
  expect(room.runActive(key), 'A действует').toBe(true);
  return { room, key, wsA, pidA };
}

describe('⭐ R19-04: действующий напарник в городе не держит общий забег заложником', () => {
  it('A действует и молчит 10 минут; спуск B в его городе не принят за срок — следующее «Продолжить» B уводит забег на узел, A — отказ `run` с кодом', async () => {
    const rm = manager();
    const { room, key, wsA, pidA } = await obstructed(rm, 'R19HA', 'R19HB', 10);
    // Перезагрузка без просьбы — к пати, как R18-04.
    const wsB = await join(rm, 'R19HB', { resume: true });
    const j = wsB.last('joined');
    expect(j, JSON.stringify(wsB.last('error'))).toBeDefined();
    expect(j!.roomCode, 'к действующему A').toBe(room.code);
    // B зовёт продолжить забег; A не отвечает (и продолжает действовать).
    room.movedAt = 0;
    const n0 = wsB.frames.length;
    wsB.push({ t: 'descend' });
    await until('окно голосования', () => wsB.frames.slice(n0).some((f) => f.t === 'voteStart'));
    expect(room.area, 'без голоса A спуска нет').toBe('town');
    later(30_000); act(wsA);
    room.step(false);
    expect(errs(wsB, n0).filter((f) => f.code === 'vote'), 'до срока — без подсказки').toEqual([]);
    later(RUN_ASK_MS); act(wsA);
    room.step(false);
    expect(room.area).toBe('town');
    expect(room.runActive(key), 'A всё ещё действует').toBe(true);
    const hints = errs(wsB, n0).filter((f) => f.code === 'vote');
    expect(hints.length, 'подсказка «продолжить без пати» — один раз').toBe(1);
    expect(hints[0]!.msg).toMatch(/Продолжить/);
    room.step(false);
    expect(errs(wsB, n0).filter((f) => f.code === 'vote').length, 'не повторяется').toBe(1);
    // «Соло» и спуск — по-прежнему отказ с кодом держателя (путь — «Продолжить»).
    wsB.push({ t: 'leave' });
    await gone(rm, 'R19HB');
    const solo = await join(rm, 'R19HB');
    const soloRoom = rm.rooms.get(solo.last('joined')!.roomCode)!;
    soloRoom.stop();
    soloRoom.movedAt = 0;
    solo.push({ t: 'descend' });
    await until('отказ спуска «Соло»', () => !!solo.last('error'));
    expect(solo.last('error')).toMatchObject({ code: 'run', roomCode: room.code });
    // «Продолжить» — забег у B, на его узле, без «Забросить».
    const wsB2 = await join(rm, 'R19HB', { resume: true });
    const j2 = wsB2.last('joined');
    expect(j2, JSON.stringify(wsB2.last('error'))).toBeDefined();
    expect(j2!.roomCode, 'не в город A').not.toBe(room.code);
    const mine = rm.rooms.get(j2!.roomCode)!;
    mine.stop();
    expect(mine.area, 'прямо на узел забега').toBe('dungeon');
    expect(runLedgerKey(mine.runConfig!)).toBe(key);
    expect(mine.holdsRun(key)).toBe(true);
    expect(room.holdsRun(key), 'город A забег отдал').toBe(false);
    expect(db.chars.get('R19HB')!.data.run, 'забег B цел — без «Забросить»').toBeTruthy();
    // A — отказ с кодом комнаты B: к пати по коду. Голосование B (осталось открытым и без него) A принимает — тот же отказ; свой спуск — тоже.
    const nA = wsA.frames.length;
    wsA.push({ t: 'vote', accept: true });
    await until('ответ A', () => errs(wsA, nA).length > 0);
    expect(errs(wsA, nA)[0], '«за» A').toMatchObject({ code: 'run', roomCode: mine.code });
    expect(room.area).toBe('town');
    room.movedAt = 0;
    room.descend(pidA);
    expect(wsA.last('error'), 'спуск A').toMatchObject({ code: 'run', roomCode: mine.code });
  });

  it('A отвечает «нет» — подсказка B сразу, и его «Продолжить» уводит забег, не дожидаясь срока', async () => {
    const rm = manager();
    const { room, key, wsA } = await obstructed(rm, 'R19NA', 'R19NB', 3);
    const wsB = await join(rm, 'R19NB', { resume: true });
    expect(wsB.last('joined')!.roomCode).toBe(room.code);
    room.movedAt = 0;
    const n0 = wsB.frames.length;
    wsB.push({ t: 'descend' });
    await until('окно голосования', () => wsB.frames.slice(n0).some((f) => f.t === 'voteStart'));
    wsA.push({ t: 'vote', accept: false });
    await until('голосование закрыто', () => wsB.frames.slice(n0).some((f) => f.t === 'voteEnd'));
    expect(room.area).toBe('town');
    const hints = errs(wsB, n0).filter((f) => f.code === 'vote');
    expect(hints.length, 'подсказка — сразу').toBe(1);
    expect(hints[0]!.msg).toMatch(/Продолжить/);
    expect(errs(wsA).filter((f) => f.code === 'vote'), 'отказавшему — нет').toEqual([]);
    wsB.push({ t: 'leave' });
    await gone(rm, 'R19NB');
    const wsB2 = await join(rm, 'R19NB', { resume: true });
    const j2 = wsB2.last('joined');
    expect(j2, JSON.stringify(wsB2.last('error'))).toBeDefined();
    expect(j2!.roomCode).not.toBe(room.code);
    const mine = rm.rooms.get(j2!.roomCode)!;
    mine.stop();
    expect(mine.area).toBe('dungeon');
    expect(mine.holdsRun(key)).toBe(true);
  });

  it('контроль (честная игра — как R18-04): B позвал, A не ответил, вкладка B перезагрузилась до срока — «Продолжить» к A; «за» A — пати идёт вместе', async () => {
    const rm = manager();
    const { room, key, wsA, pidA } = await obstructed(rm, 'R19CA', 'R19CB', 1);
    const wsB = await join(rm, 'R19CB', { resume: true });
    expect(wsB.last('joined')!.roomCode).toBe(room.code);
    room.movedAt = 0;
    const n0 = wsB.frames.length;
    wsB.push({ t: 'descend' });
    await until('окно голосования', () => wsB.frames.slice(n0).some((f) => f.t === 'voteStart'));
    later(RUN_ASK_MS - 20_000); act(wsA);
    wsB.close();   // F5: из города — чистый уход
    await gone(rm, 'R19CB');
    const wsB2 = await join(rm, 'R19CB', { resume: true });
    const j2 = wsB2.last('joined');
    expect(j2, JSON.stringify(wsB2.last('error'))).toBeDefined();
    expect(j2!.roomCode, 'к пати').toBe(room.code);
    expect(room.holdsRun(key)).toBe(true);
    // Голосование B открыто и после перезагрузки: «за» обоих — вместе на узел.
    room.castVote(pidA, true);
    room.castVote(j2!.playerId, true);
    await until('продолжение забега', () => room.area === 'dungeon');
    expect(runLedgerKey(room.runConfig!), 'тот же забег').toBe(key);
    expect(room.clients.size, 'вдвоём').toBe(2);
  });

  it('срок бездействия и срок просьбы — разные: просьба короче (действующий отвечает быстрее, чем уходит от компьютера)', () => {
    expect(RUN_ASK_MS).toBeGreaterThan(0);
    expect(RUN_ASK_MS).toBeLessThan(RUN_IDLE_MS);
  });
});

/**
 * ⭐ РАУНД 20, R20-02: ПРОСЬБА — О СВОЁМ ГОЛОСОВАНИИ И НЕНАДОЛГО. Просьба жила до входа в забег или его отпуска: переживала своё же «нет» (отмена),
 * конец голосования без отказа другого, возврат к пати — и через `RUN_ASK_MS` после ПЕРВОЙ просьбы сама становилась «отказом». Любая перезагрузка
 * позвавшего потом, хоть через полчаса дружной игры в городе, увозила его одного на узел, а напарник оставался с отказом `run` (раскол R18-04).
 * Теперь своя отмена и конец голосования без «нет» другого просьбу снимают, срок меряется от её голосования, отказ — только сказанный позвавшему
 * и в силе `RUN_ASK_MS` после того, как сказан.
 */
describe('⭐ R20-02: давняя просьба не раскалывает пати на перезагрузке', () => {
  it('B позвал и сам отменил своё голосование; 5 минут оба играют в городе — перезагрузка B садит его к A, забег у города A', async () => {
    const rm = manager();
    const { room, key, wsA } = await obstructed(rm, 'R20SA', 'R20SB', 1);
    const wsB = await join(rm, 'R20SB', { resume: true });
    expect(wsB.last('joined')!.roomCode).toBe(room.code);
    room.movedAt = 0;
    const n0 = wsB.frames.length;
    wsB.push({ t: 'descend' });
    await until('окно голосования', () => wsB.frames.slice(n0).some((f) => f.t === 'voteStart'));
    later(1_000);
    wsB.push({ t: 'vote', accept: false });   // передумал сразу
    await until('голосование закрыто', () => wsB.frames.slice(n0).some((f) => f.t === 'voteEnd'));
    for (let i = 0; i < 5; i++) { later(60_000); act(wsA); act(wsB); room.step(false); }
    expect(errs(wsB, n0).filter((f) => f.code === 'vote'), 'отказа не было — и подсказки нет').toEqual([]);
    wsB.close();   // F5
    await gone(rm, 'R20SB');
    const wsB2 = await join(rm, 'R20SB', { resume: true });
    const j2 = wsB2.last('joined');
    expect(j2, JSON.stringify(wsB2.last('error'))).toBeDefined();
    expect(j2!.roomCode, 'к A').toBe(room.code);
    expect(room.holdsRun(key), 'забег у города A').toBe(true);
  });

  it('A ответил «нет» («подожди, починюсь»), 30 минут оба играют в городе — перезагрузка B садит его к A: отказ давно не в силе', async () => {
    const rm = manager();
    const { room, key, wsA } = await obstructed(rm, 'R20NA', 'R20NB', 1);
    const wsB = await join(rm, 'R20NB', { resume: true });
    expect(wsB.last('joined')!.roomCode).toBe(room.code);
    room.movedAt = 0;
    const n0 = wsB.frames.length;
    wsB.push({ t: 'descend' });
    await until('окно голосования', () => wsB.frames.slice(n0).some((f) => f.t === 'voteStart'));
    wsA.push({ t: 'vote', accept: false });
    await until('подсказка B', () => errs(wsB, n0).some((f) => f.code === 'vote'));
    for (let i = 0; i < 30; i++) { later(60_000); act(wsA); act(wsB); room.step(false); }
    wsB.close();
    await gone(rm, 'R20NB');
    const wsB2 = await join(rm, 'R20NB', { resume: true });
    const j2 = wsB2.last('joined');
    expect(j2, JSON.stringify(wsB2.last('error'))).toBeDefined();
    expect(j2!.roomCode, 'к A').toBe(room.code);
    expect(room.holdsRun(key)).toBe(true);
  });

  it('B позвал и закрыл вкладку до срока, а вернулся после — к A: отказ, которого ему никто не сказал, не в силе', async () => {
    const rm = manager();
    const { room, key, wsA } = await obstructed(rm, 'R20TA', 'R20TB', 1);
    const wsB = await join(rm, 'R20TB', { resume: true });
    room.movedAt = 0;
    const n0 = wsB.frames.length;
    wsB.push({ t: 'descend' });
    await until('окно голосования', () => wsB.frames.slice(n0).some((f) => f.t === 'voteStart'));
    later(20_000); act(wsA);
    wsB.close();   // F5 — и надолго в меню
    await gone(rm, 'R20TB');
    later(RUN_ASK_MS); act(wsA); room.step(false);
    const wsB2 = await join(rm, 'R20TB', { resume: true });
    const j2 = wsB2.last('joined');
    expect(j2, JSON.stringify(wsB2.last('error'))).toBeDefined();
    expect(j2!.roomCode, 'к A').toBe(room.code);
    expect(room.holdsRun(key)).toBe(true);
  });
});

/**
 * ⭐ R20-03: ДЕРЖАТЕЛЬ ЗАНИМАЕТ СЛОТ ГОЛОСОВАНИЯ. Просьба записывалась, только когда спуск открывал голосование, а спуск при открытом голосовании —
 * отказ `VOTE_PENDING` до неё: держатель, открывающий арену заново на каждый `voteEnd`, не давал напарнику попросить никогда, и «Продолжить»
 * снова и снова садило к нему. Теперь спуск участника забега — просьба и тогда, когда слот занят чужим голосованием.
 */
describe('⭐ R20-03: занятый слот голосования не прячет просьбу', () => {
  it('A держит слот голосованием за арену (открывает снова на каждый конец); спуск B — просьба, через срок подсказка, «Продолжить» уводит забег', async () => {
    const rm = manager();
    const { room, key, wsA } = await obstructed(rm, 'R20VA', 'R20VB', 3);
    const wsB = await join(rm, 'R20VB', { resume: true });
    expect(wsB.last('joined')!.roomCode).toBe(room.code);
    room.movedAt = 0;
    const r = room as unknown as { vote: { kind: string } | null };
    wsA.push({ t: 'arena' });
    await until('голосование за арену', () => r.vote?.kind === 'arena');
    const n0 = wsB.frames.length;
    for (let round = 0; round < 3; round++) {
      const n1 = wsB.frames.length;
      wsB.push({ t: 'descend' });   // слот занят — отказ `vote`, но просьба записана
      await until('ответ на спуск B', () => errs(wsB, n1).some((f) => f.code === 'vote'));
      expect(r.vote?.kind, 'слот — у арены A').toBe('arena');
      wsB.push({ t: 'vote', accept: false });
      await until('голосование закрыто', () => r.vote === null);
      wsA.push({ t: 'arena' });   // скрипт A открывает снова
      await until('арена снова', () => r.vote?.kind === 'arena');
      later(RUN_ASK_MS / 3 + 1); act(wsA); room.step(false);
    }
    expect(room.runActive(key), 'A действует').toBe(true);
    const hints = errs(wsB, n0).filter((f) => f.code === 'vote' && /Продолжить/.test(f.msg));
    expect(hints.length, 'подсказка «продолжить без пати» — через срок просьбы').toBe(1);
    wsB.push({ t: 'leave' });
    await gone(rm, 'R20VB');
    const wsB2 = await join(rm, 'R20VB', { resume: true });
    const j2 = wsB2.last('joined');
    expect(j2, JSON.stringify(wsB2.last('error'))).toBeDefined();
    expect(j2!.roomCode, 'не к A').not.toBe(room.code);
    const mine = rm.rooms.get(j2!.roomCode)!;
    mine.stop();
    expect(mine.area).toBe('dungeon');
    expect(mine.holdsRun(key)).toBe(true);
    expect(room.holdsRun(key), 'город A забег отдал').toBe(false);
  });
});

/**
 * ⭐ R20-06: ДЕРЖАТЕЛЬ НЕ ЗАБИРАЕТ ОТКАЗ ЗА СПИНОЙ ПОЗВАВШЕГО. B позвал, A ответил «нет», B пошёл за подсказкой в меню — а A, оставшись в городе один,
 * звал спуск: голос проходил сразу, продолжение брало забег (`takeRun` стирал просьбы), и «Продолжить» B садило в подземелье A (подземелье
 * забег не отдаёт), где каждый спуск ждал голоса A. Теперь, пока отказ ушедшему в силе, продолжить этот забег в городе нельзя: он его.
 */
describe('⭐ R20-06: отказ ушедшему держит забег за ним', () => {
  it('B позвал, A «нет», B вышел в меню — спуск A отказан, «Продолжить» B уводит забег в новую комнату, A — `run` с её кодом', async () => {
    const rm = manager();
    const { room, key, wsA, pidA } = await obstructed(rm, 'R20DA', 'R20DB', 3);
    const wsB = await join(rm, 'R20DB', { resume: true });
    expect(wsB.last('joined')!.roomCode).toBe(room.code);
    room.movedAt = 0;
    const n0 = wsB.frames.length;
    wsB.push({ t: 'descend' });
    await until('окно голосования', () => wsB.frames.slice(n0).some((f) => f.t === 'voteStart'));
    wsA.push({ t: 'vote', accept: false });
    await until('подсказка B', () => errs(wsB, n0).some((f) => f.code === 'vote' && /Продолжить/.test(f.msg)));
    wsB.push({ t: 'leave' });
    await gone(rm, 'R20DB');
    room.movedAt = 0;
    const nA = wsA.frames.length;
    wsA.push({ t: 'descend' });   // A один в городе: голос прошёл бы сразу
    await until('ответ на спуск A', () => errs(wsA, nA).length > 0 || room.area !== 'town');
    expect(room.area, 'забег не продолжен за спиной B').toBe('town');
    expect(errs(wsA, nA).map((f) => f.code)).toContain('vote');
    expect(room.holdsRun(key)).toBe(true);
    const wsB2 = await join(rm, 'R20DB', { resume: true });
    const j2 = wsB2.last('joined');
    expect(j2, JSON.stringify(wsB2.last('error'))).toBeDefined();
    expect(j2!.roomCode, 'не к A').not.toBe(room.code);
    const mine = rm.rooms.get(j2!.roomCode)!;
    mine.stop();
    expect(mine.area).toBe('dungeon');
    expect(mine.holdsRun(key)).toBe(true);
    room.movedAt = 0;
    room.descend(pidA);
    expect(wsA.last('error'), 'спуск A — к пати по коду').toMatchObject({ code: 'run', roomCode: mine.code });
  });

  it('контроль: B так и не нажал «Продолжить» — отказ истёк через срок, и A продолжает забег сам', async () => {
    const rm = manager();
    const { room, key, wsA } = await obstructed(rm, 'R20EA', 'R20EB', 3);
    const wsB = await join(rm, 'R20EB', { resume: true });
    room.movedAt = 0;
    const n0 = wsB.frames.length;
    wsB.push({ t: 'descend' });
    await until('окно голосования', () => wsB.frames.slice(n0).some((f) => f.t === 'voteStart'));
    wsA.push({ t: 'vote', accept: false });
    await until('подсказка B', () => errs(wsB, n0).some((f) => f.code === 'vote'));
    wsB.push({ t: 'leave' });
    await gone(rm, 'R20EB');
    later(RUN_ASK_MS); act(wsA); room.step(false);
    room.movedAt = 0;
    wsA.push({ t: 'descend' });
    await until('A продолжил забег', () => room.area === 'dungeon');
    expect(runLedgerKey(room.runConfig!)).toBe(key);
  });
});

/**
 * ⭐ R20-04: ПУТЬ ВЕБ-КЛИЕНТА — ПО ТОМУ ЖЕ СОКЕТУ. Подсказка звала «в меню входа», а выйти туда из мира веб-клиентам было нечем (кадр `leave` не
 * слал никто). Теперь кнопка «Продолжить без пати» шлёт `leave` по живому сокету, потом статус забега и «Продолжить» — всё тем же соединением.
 * Подсказке — поле `solo`: кнопку клиент вешает по нему, а не по тексту.
 */
describe('⭐ R20-04: «Продолжить без пати» — `leave`, статус забега и «Продолжить» по тому же сокету', () => {
  it('A ответил «нет» — подсказка с `solo`; B выходит кадром `leave`, статус — «есть забег», «Продолжить» уводит забег на узел; A — `run` с кодом', async () => {
    const rm = manager();
    const { room, key, wsA, pidA } = await obstructed(rm, 'R2004A', 'R2004B', 3);
    const wsB = await join(rm, 'R2004B', { resume: true });
    expect(wsB.last('joined')!.roomCode).toBe(room.code);
    room.movedAt = 0;
    const n0 = wsB.frames.length;
    wsB.push({ t: 'descend' });
    await until('окно голосования', () => wsB.frames.slice(n0).some((f) => f.t === 'voteStart'));
    wsA.push({ t: 'vote', accept: false });
    await until('подсказка B', () => errs(wsB, n0).some((f) => f.code === 'vote'));
    const hints = errs(wsB, n0).filter((f) => f.code === 'vote');
    expect(hints).toHaveLength(1);
    expect(hints[0], 'было: только текст — кнопке не за что зацепиться').toMatchObject({ solo: true });
    expect(hints[0]!.msg, 'без кнопки (старая вкладка, Unity) — путь, который есть у всех').toMatch(/F5/);
    // Кнопка веба живёт `SOLO_OFFER_MS` = 45 с (`client/net/entryFlow.ts`) — с запасом короче срока отказа: позже «Продолжить» садит к пати.
    expect(RUN_ASK_MS, 'срок отказа укоротили — укоротите и кнопку веба (`SOLO_OFFER_MS`)').toBeGreaterThanOrEqual(60_000);

    // Кнопка: `leave` — и тем же сокетом статус забега.
    for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby]) l.reset(USER);
    const n2 = wsB.frames.length;
    wsB.push({ t: 'leave' });
    wsB.push({ t: 'runStatus', token: TOK, charId: 'R2004B' });
    await until('статус забега', () => wsB.frames.slice(n2).some((f) => f.t === 'runStatus' || f.t === 'error'));
    expect(wsB.open, 'соединение живо').toBe(true);
    expect(room.clients.size, 'B вышел из города A').toBe(1);
    const st = wsB.frames.slice(n2).find((f) => f.t === 'runStatus');
    expect(st, JSON.stringify(wsB.frames.slice(n2))).toMatchObject({ t: 'runStatus', hasRun: true });
    // «Продолжить» — тем же сокетом: новая комната прямо на узле забега, без «Забросить».
    const n3 = wsB.frames.length;
    wsB.push({ t: 'join', token: TOK, charId: 'R2004B', resume: true });
    await until('ответ на «Продолжить»', () => wsB.frames.slice(n3).some((f) => f.t === 'joined' || f.t === 'error'));
    const j = wsB.frames.slice(n3).find((f): f is Extract<ServerFrame, { t: 'joined' }> => f.t === 'joined');
    expect(j, JSON.stringify(wsB.frames.slice(n3).find((f) => f.t === 'error'))).toBeDefined();
    expect(j!.roomCode, 'не в город A').not.toBe(room.code);
    const mine = rm.rooms.get(j!.roomCode)!;
    mine.stop();
    expect(mine.area, 'прямо на узел забега').toBe('dungeon');
    expect(mine.holdsRun(key)).toBe(true);
    expect(room.holdsRun(key), 'город A забег отдал').toBe(false);
    expect(db.chars.get('R2004B')!.data.run, 'забег B цел').toBeTruthy();
    room.movedAt = 0;
    room.descend(pidA);
    expect(wsA.last('error'), 'спуск A — к пати по коду').toMatchObject({ code: 'run', roomCode: mine.code });
  });
});
