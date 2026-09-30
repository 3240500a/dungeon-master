import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type PlayerInput } from '@dm/shared';

// Исходы решают мок базы и шаги комнаты, которые тест делает сам (`step`), а не часы; под нагрузкой полного прогона — запас.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ D4: ОДНО ПРАВИЛО ВРЕМЕНИ БАФФА (`shared/formulas/buffTiming.ts`) — и через переходы комнаты. Откат умения — время ГЕРОЯ, а не тела
 * (`shared/session/heroBody.ts`): тело арены в город не идёт, а взятое на ней — идёт.
 *  • Конец арены возвращал откаты тела города (минус время боя): бафф, скастованный на арене, в городе был готов снова — круг «город ↔ арена»
 *    давал два окна баффа на откат (до 2·действие / (откат + действие) времени под баффом — мимо правила).
 *  • Ушедший с арены раньше, чем она кончилась: запись ухода — тело города, и откаты арены пропадали так же.
 *  • Погибший на арене и оборвавшийся входит свежей сущностью («мёртвый в арене возрождается свежим») — и откаты пропадали вместе с телом.
 *  • Вход в ДРУГУЮ комнату (новая — свежая сущность; запись ухода, которую обогнал сейв другой комнаты, R12-02) заводил героя со всеми
 *    откатами готовыми: клич на арене → к другу и назад по коду → клич снова. Откаты теперь в сейве рядом с пулами (`vitals.cd`, R11-04).
 */
const db = vi.hoisted(() => ({ versions: new Map<string, number>(), data: new Map<string, unknown>() }));
vi.mock('../db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, version: number) => {
    if (version !== (db.versions.get(charId) ?? 1)) return Promise.resolve(null);
    db.versions.set(charId, version + 1); db.data.set(charId, structuredClone(data));
    return Promise.resolve(version + 1);
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getCharacter: (charId: string) => {
    const d = db.data.get(charId);
    return Promise.resolve(d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null);
  },
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type P = { alive: boolean; hp: number; save: SaveState; toggles: string[]; skillCd: Record<string, number>; skillBuffs: Record<string, number> };
type RoomIn = {
  area: string; movedAt: number;
  session: { world: { players: Record<string, P>; timeMs: number }; snapshotOf(pid: string): { derived: { maxHp: number } } | undefined };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): Promise<{ saved: boolean }>;
  enterArena(pid: string): void; returnTown(pid: string): void; castVote(pid: string, yes: boolean): void;
  setInput(pid: string, input: PlayerInput): void;
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
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); });

class FakeWs {
  open = true; readonly ip = '127.0.0.1'; frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void {} onClose(): void {}
}
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
const BUFF = 'b-class-warrior-a5';   // «Боевой клич»: 8 с баффа, откат 13.5 с на 1-м ранге
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
let seq = 0;
function newRoom(): RoomIn {
  const room = new RoomCtor(`D4S${++seq}`, cfg, hooks);
  rooms.push(room);
  return room;
}
function hero(): SaveState {
  const charId = `char-d4s-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  s.level = 40; s.gold = 5000; s.skills[BUFF] = 1;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const P = (room: RoomIn, pid: string): P => room.session.world.players[pid]!;
const fromDb = (charId: string): [SaveState, number] => [structuredClone(db.data.get(charId)) as SaveState, db.versions.get(charId)!];
/** Прокричать клич (кадр ввода и шаг комнаты): откат после шага. */
function shout(room: RoomIn, pid: string): number {
  room.setInput(pid, { ...idle, cast: BUFF });
  room.step();
  room.setInput(pid, idle);
  return P(room, pid).skillCd[BUFF] ?? 0;
}
/** Друг и герой в городе; комната шагает только шагами теста. */
async function pair(): Promise<{ room: RoomIn; pf: string; pid: string; h: SaveState }> {
  const room = newRoom();
  const pf = room.addPlayer(new FakeWs(), 'user-friend', hero(), 1);
  const h = hero();
  const pid = room.addPlayer(new FakeWs(), `user-${h.charId}`, h, 1);
  await settle();
  room.stop();
  return { room, pf, pid, h };
}
function toArena(room: RoomIn, pid: string, pf: string): void {
  room.movedAt = 0; room.enterArena(pid); room.castVote(pf, true);
  expect(room.area).toBe('arena');
}
function toTown(room: RoomIn, by: string, other?: string): void {
  room.movedAt = 0; room.returnTown(by);
  if (other) room.castVote(other, true);
  expect(room.area).toBe('town');
}

describe('⭐ D4: откаты — героя, а не тела (арена, обрыв)', () => {
  it('клич в городе → арена, пока откат города не кончился → клич на арене → город: откат арены с ним, клич не готов', async () => {
    const { room, pf, pid } = await pair();
    const cdTown = shout(room, pid);
    expect(cdTown, 'откат города идёт').toBeGreaterThan(13);
    toArena(room, pid, pf);
    for (let i = 0; i < Math.ceil(cdTown * 30) + 2; i++) room.step();
    expect(P(room, pid).skillCd[BUFF] ?? 0, 'откат города на арене прошёл').toBe(0);
    const cdArena = shout(room, pid);
    expect(P(room, pid).skillBuffs[BUFF], 'клич на арене встал').toBeGreaterThan(7);
    for (let i = 0; i < 30; i++) room.step();   // секунда боя
    toTown(room, pid, pf);
    const p = P(room, pid);
    expect(p.skillBuffs[BUFF], 'бафф арены — телом арены, в город не идёт').toBeUndefined();
    expect(p.skillCd[BUFF] ?? 0, 'а откат клича с арены — с героем (раньше: 0, клич готов снова)').toBeCloseTo(cdArena - 1, 1);
    room.setInput(pid, { ...idle, cast: BUFF });
    room.step();
    expect(P(room, pid).skillBuffs[BUFF], 'клич в городе не проходит до конца отката').toBeUndefined();
  });

  it('контроль: на арене клич не кричал — откат города стареет временем боя, как был (R16-07)', async () => {
    const { room, pf, pid } = await pair();
    const cdTown = shout(room, pid);
    toArena(room, pid, pf);
    for (let i = 0; i < 90; i++) room.step();   // 3 с боя
    toTown(room, pid, pf);
    expect(P(room, pid).skillCd[BUFF] ?? 0).toBeCloseTo(cdTown - 3, 1);
  });

  it('клич на арене → обрыв → арена кончилась без него → вход по коду: в городе, откат арены с ним (время для ушедшего стоит)', async () => {
    const { room, pf, pid, h } = await pair();
    toArena(room, pid, pf);
    const cdArena = shout(room, pid);
    expect(cdArena).toBeGreaterThan(13);
    await room.removePlayer(pid);
    await settle();
    toTown(room, pf);
    const [save, v] = fromDb(h.charId);
    const back = room.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    expect(room.area).toBe('town');
    expect(P(room, back).skillCd[BUFF] ?? 0, 'откат арены — с ним (раньше: откаты тела города на входе в арену — 0)').toBeCloseTo(cdArena, 1);
  });

  it('клич на арене → погиб → обрыв → вход по коду на ту же арену: свежей сущностью, но откат клича — его', async () => {
    const { room, pf, pid, h } = await pair();
    toArena(room, pid, pf);
    const cdArena = shout(room, pid);
    const p = P(room, pid);
    p.alive = false; p.hp = 0;   // погиб на арене — возрождение арены ещё не пришло
    await room.removePlayer(pid);
    await settle();
    const [save, v] = fromDb(h.charId);
    const back = room.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    expect(room.area).toBe('arena');
    expect(P(room, back).alive, 'мёртвый в арене возрождается свежим').toBe(true);
    expect(P(room, back).skillCd[BUFF] ?? 0, 'а откат — героя (раньше: свежая сущность без откатов, клич готов)').toBeCloseTo(cdArena, 1);
  });

  it('клич → выход → вход в НОВУЮ комнату: откат с ним (из сейва, минус время вне игры), клич не готов', async () => {
    const { room, pid, h } = await pair();
    const cd = shout(room, pid);
    await room.removePlayer(pid);
    await settle();
    const other = newRoom();
    const [save, v] = fromDb(h.charId);
    expect(save.vitals?.cd?.[BUFF] ?? 0, 'откат — в сейве рядом с пулами').toBeGreaterThan(13);
    const np = other.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    await settle();
    other.stop();
    const left = P(other, np).skillCd[BUFF] ?? 0;
    expect(left, 'откат с ним (раньше: свежая сущность — 0)').toBeGreaterThan(cd - 2);
    expect(left).toBeLessThanOrEqual(cd);
    other.setInput(np, { ...idle, cast: BUFF });
    other.step();
    expect(P(other, np).skillBuffs[BUFF], 'клич не готов').toBeUndefined();
  });

  it('клич на арене → обрыв → вход к другу (другая комната, сейв записан) → назад по коду на ту же арену: откат с ним (R12-02 — из сейва)', async () => {
    const { room, pf, pid, h } = await pair();
    toArena(room, pid, pf);
    const cdArena = shout(room, pid);
    await room.removePlayer(pid);
    await settle();
    const other = newRoom();
    const [s1, v1] = fromDb(h.charId);
    const op = other.addPlayer(new FakeWs(), `user-${h.charId}`, s1, v1);
    await settle();
    await new Promise((r) => setTimeout(r, 5));   // метка сейва другой комнаты — позже ухода с арены (R12-02: запись ухода устарела)
    await other.removePlayer(op);
    await settle();
    const [save, v] = fromDb(h.charId);
    const back = room.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    expect(room.area).toBe('arena');
    const left = P(room, back).skillCd[BUFF] ?? 0;
    expect(left, 'откат клича с арены — с ним (раньше: запись ухода устарела — откаты сняты, клич готов)').toBeGreaterThan(cdArena - 2);
    expect(left).toBeLessThanOrEqual(cdArena);
  });

  it('конец арены — снимок героя города сразу (стойка +15 % жизни), а не снимок арены: команда до следующего тика (зелье) меряется им', async () => {
    const { room, pf, pid } = await pair();
    const STANCE = 'b-stance-a5';
    P(room, pid).save.skills[STANCE] = 1;
    room.setInput(pid, { ...idle, cast: STANCE });
    room.step();
    room.setInput(pid, idle);
    room.step();
    expect(P(room, pid).toggles, 'стойка включена').toContain(STANCE);
    const town = room.session.snapshotOf(pid)!.derived.maxHp;
    toArena(room, pid, pf);
    room.step();
    expect(room.session.snapshotOf(pid)!.derived.maxHp, 'на арене стойки нет').toBeLessThan(town);
    toTown(room, pid, pf);
    expect(room.session.snapshotOf(pid)!.derived.maxHp, 'сразу после возврата — снимок со стойкой (раньше — арены до следующего тика)').toBeCloseTo(town, 6);
  });
});

/**
 * ⭐ R22-04: ОТКАТЫ ГЕРОЯ ПЕРЕЖИВАЮТ СМЕРТЬ И ОБРЫВ. Погибший в коопе, закрывший вкладку, пока ждал пати, писал сейв без `vitals` вовсе (мёртвому
 * пулы не нужны — оживёт полным), а с ними уходили и откаты (`vitals.cd`, D4). Смена этажа пати (спуск, город) снимала его мёртвую запись ухода
 * вместе с откатами тела и оживляла его заочно — и вход заводил свежую сущность с готовым кличем. Подключённый мёртвый (и напарник) переживал ту
 * же смену этажа со своими откатами: закрыть вкладку, будучи мёртвым, стоило одного полного отката баффа за смерть — мимо правила D4.
 */
describe('⭐ R22-04: погибший в коопе и оборвавшийся — откаты с ним через смену этажа пати', () => {
  type CoopRoom = RoomIn & {
    runNodeId: string | null;
    session: RoomIn['session'] & { world: RoomIn['session']['world'] & { spawn: { x: number; y: number }; exits?: { x: number; y: number }[]; monsters: { alive: boolean }[] } };
    descend(pid: string): void; onPlayerDeath(pid: string, touched: Set<string>): void;
  };
  /** A и B в подземелье (кооп), оба с кличем; монстры спят, тик — шагами теста. */
  async function coop(): Promise<{ room: CoopRoom; pa: string; pb: string; a: SaveState }> {
    const room = newRoom() as CoopRoom;
    const a = hero(), b = hero();
    const pa = room.addPlayer(new FakeWs(), `user-${a.charId}`, a, 1);
    const pb = room.addPlayer(new FakeWs(), `user-${b.charId}`, b, 1);
    await settle();
    room.movedAt = 0; room.descend(pa); room.castVote(pb, true);
    expect(room.area).toBe('dungeon');
    room.stop();
    const w = room.session.world;
    for (const m of w.monsters) m.alive = false;
    return { room, pa, pb, a };
  }
  /** Клич и сразу смерть (штраф — как у комнаты за тиком). */
  function shoutAndDie(room: CoopRoom, pid: string): number {
    const cd = shout(room, pid);
    expect(cd, 'клич прокричан — откат идёт').toBeGreaterThan(13);
    const p = P(room, pid);
    p.hp = 0; p.alive = false;
    room.onPlayerDeath(pid, new Set());
    return cd;
  }
  /** Пати (B) уходит с этажа: спуск на следующий узел или «В город»; `also` — подключённый напарник голосует «за». */
  function partyMoves(room: CoopRoom, pb: string, how: 'спуск' | 'город', also?: string): void {
    const w = room.session.world;
    room.movedAt = 0;
    if (how === 'спуск') {
      const node = room.runNodeId;
      (P(room, pb) as P & { pos: { x: number; y: number } }).pos = { ...w.exits![0]! };
      room.descend(pb);
      if (also) room.castVote(also, true);
      expect(room.runNodeId, 'пати спустилась').not.toBe(node);
    } else {
      (P(room, pb) as P & { pos: { x: number; y: number } }).pos = { ...w.spawn };
      room.returnTown(pb);
      if (also) room.castVote(also, true);
      expect(room.area).toBe('town');
    }
  }

  for (const how of ['спуск', 'город'] as const) {
    it(`A кричит клич, погибает, закрывает вкладку; пати — «${how}»; A входит снова из строки базы: откат клича с ним, клич не готов`, async () => {
      const { room, pa, pb, a } = await coop();
      const cd = shoutAndDie(room, pa);
      await room.removePlayer(pa);
      await settle();
      partyMoves(room, pb, how);
      await settle();
      const [save, v] = fromDb(a.charId);
      expect(save.vitals?.cd?.[BUFF] ?? 0, 'откаты мёртвого — в сейве (раньше: `vitals` сняты целиком)').toBeGreaterThan(13);
      const back = room.addPlayer(new FakeWs(), `user-${a.charId}`, save, v);
      expect(P(room, back).alive, 'пати ожила его сменой этажа').toBe(true);
      const left = P(room, back).skillCd[BUFF] ?? 0;
      expect(left, 'было — 0: свежая сущность, клич готов').toBeGreaterThan(cd - 2);
      expect(left).toBeLessThanOrEqual(cd);
      room.setInput(back, { ...idle, cast: BUFF });
      room.step();
      expect(P(room, back).skillBuffs[BUFF], 'клич не готов').toBeUndefined();
      expect(P(room, back).hp, 'пулы — полные: смерть позади').toBe(room.session.snapshotOf(back)!.derived.maxHp);
    });
  }

  it('контроль: погибший A не закрывал вкладку — спуск оживляет его с тем же откатом (так и должно быть у ушедшего)', async () => {
    const { room, pa, pb } = await coop();
    const cd = shoutAndDie(room, pa);
    partyMoves(room, pb, 'спуск', pa);
    expect(P(room, pa).alive).toBe(true);
    expect(P(room, pa).skillCd[BUFF] ?? 0).toBeCloseTo(cd, 1);
  });
});

/**
 * ⚠ R23-05: УШЕДШИЙ С АРЕНЫ РАНЬШЕ ЕЁ КОНЦА — откаты тела города старше на время, проведённое на арене. Тело города (`arenaHome`) снято на
 * входе в арену и стоит, а откат — время ГЕРОЯ (D4): бой на арене его старит, как у дождавшегося конца (`arenaReturn` вычитает время боя).
 * Раньше сейв с арены (`noteVitals` → `vitalsForSave`: уход, автосейв, дренаж ноды) писал откаты города, застывшие на входе в арену, — и вход в
 * другую комнату («Продолжить», по коду к другу, другая нода, рестарт) заводил героя с кличем в откате ≈ 13 с, хотя по его времени клич давно
 * готов; так же — запись ухода, которой конец арены делает тело города (`arenaAwayBody`), при входе по коду в ту же комнату. Против игрока, не
 * эксплойт (не больше самого длинного отката), но мимо правила «откат — время героя, в каком бы теле он его ни взял».
 */
describe('⚠ R23-05: ушедший с арены раньше конца — откаты города старше на время арены', () => {
  /** Клич в городе → арена → `sec` секунд боя (клич на арене не кричал). */
  async function shoutThenArena(sec: number): Promise<{ room: RoomIn; pf: string; pid: string; h: SaveState; cdTown: number }> {
    const { room, pf, pid, h } = await pair();
    const cdTown = shout(room, pid);
    expect(cdTown, 'откат города идёт').toBeGreaterThan(13);
    toArena(room, pid, pf);
    for (let i = 0; i < sec * 30; i++) room.step();
    return { room, pf, pid, h, cdTown };
  }
  /** Вход в НОВУЮ комнату сейвом из базы: откаты сущности и кадр `joined`. */
  async function joinElsewhere(h: SaveState): Promise<{ cd: number; joined?: Extract<ServerFrame, { t: 'joined' }> }> {
    const other = newRoom();
    const ws = new FakeWs();
    const [save, v] = fromDb(h.charId);
    const np = other.addPlayer(ws, `user-${h.charId}`, save, v);
    await settle();
    other.stop();
    return { cd: P(other, np).skillCd[BUFF] ?? 0, joined: ws.frames.find((f): f is Extract<ServerFrame, { t: 'joined' }> => f.t === 'joined') };
  }

  it('клич в городе → 20 с на арене (откат прошёл) → ушёл с арены → вход в новую комнату: клич готов', async () => {
    const { room, pid, h } = await shoutThenArena(20);
    expect(P(room, pid).skillCd[BUFF] ?? 0, 'на арене откат клича давно прошёл').toBe(0);
    await room.removePlayer(pid);   // ушёл с арены: меню, закрыл вкладку, к другу по коду
    await settle();
    const [save] = fromDb(h.charId);
    expect(save.vitals?.cd?.[BUFF] ?? 0, 'в сейве — откат по времени героя (раньше: откат города на входе в арену, ≈ 13.5 с)').toBe(0);
    const { cd, joined } = await joinElsewhere(h);
    expect(cd, 'клич готов (раньше: ≈ 13 с отката в новой комнате)').toBe(0);
    expect(joined?.cooldowns?.[BUFF], 'и экран не рисует отката').toBeUndefined();
  });

  it('5 с на арене → ушёл: в сейве откат города минус время боя, не застывший на входе', async () => {
    const { room, pid, h, cdTown } = await shoutThenArena(5);
    await room.removePlayer(pid);
    await settle();
    const [save] = fromDb(h.charId);
    expect(save.vitals?.cd?.[BUFF] ?? 0, 'откат — героя: минус 5 с боя').toBeCloseTo(cdTown - 5, 1);
    // Вход — минус время вне игры по часам сервера (сколько-то миллисекунд): не больше записанного, а застывший откат (≈ 13.5) — больше.
    const { cd } = await joinElsewhere(h);
    expect(cd).toBeLessThanOrEqual(cdTown - 5 + 1e-6);
  });

  it('автосейв посреди арены (дренаж, падение ноды) — тоже откат по времени героя', async () => {
    const { room, pid, h } = await shoutThenArena(20);
    await (room as unknown as { persist(pid: string): Promise<unknown> }).persist(pid);
    await settle();
    const [save] = fromDb(h.charId);
    expect(save.vitals?.cd?.[BUFF] ?? 0, 'раньше: откат города на входе в арену').toBe(0);
  });

  it('20 с на арене → ушёл → арена кончилась без него → вход по коду в ту же комнату: клич готов (запись ухода — тело города)', async () => {
    const { room, pf, pid, h } = await shoutThenArena(20);
    await room.removePlayer(pid);
    await settle();
    toTown(room, pf);   // конец арены: запись ушедшего — тело города (`arenaAwayBody`)
    const [save, v] = fromDb(h.charId);
    const back = room.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    expect(room.area).toBe('town');
    expect(P(room, back).skillCd[BUFF] ?? 0, 'раньше: откат города на входе в арену, ≈ 13.5 с').toBe(0);
  });

  it('5 с на арене → ушёл → арена кончилась → вход по коду: откат города минус 5 с боя (дальше время для ушедшего стоит, R4-06)', async () => {
    const { room, pf, pid, h, cdTown } = await shoutThenArena(5);
    await room.removePlayer(pid);
    await settle();
    for (let i = 0; i < 300; i++) room.step();   // ещё 10 с арены без него — ему время не идёт
    toTown(room, pf);
    const [save, v] = fromDb(h.charId);
    const back = room.addPlayer(new FakeWs(), `user-${h.charId}`, save, v);
    expect(P(room, back).skillCd[BUFF] ?? 0).toBeCloseTo(cdTown - 5, 1);
  });

  it('контроль: остался до конца арены — в городе клич готов, и в сейве тоже', async () => {
    const { room, pf, pid, h } = await shoutThenArena(20);
    toTown(room, pid, pf);
    expect(P(room, pid).skillCd[BUFF] ?? 0).toBe(0);
    await room.removePlayer(pid);
    await settle();
    expect(fromDb(h.charId)[0].vitals?.cd?.[BUFF] ?? 0).toBe(0);
  });
});
