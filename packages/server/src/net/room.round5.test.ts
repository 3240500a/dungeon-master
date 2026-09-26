import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type RunPlan, type RunNode, type SaveState, type Item } from '@dm/shared';
import { limits } from './rateLimit.js';

/**
 * Раунд 5 ревью сервера — комната. Настоящая `Room` с фейковым сокетом, база — маленькая ЧЕСТНАЯ (версии сейва проверяются
 * как в Postgres), как в `room.run.test.ts`: там же разобрано, зачем мок отдаёт промисы и снимок в момент вызова.
 */
const db = vi.hoisted(() => ({
  /** charId → версия сейва в «базе». Нет записи — 1 (так персонажа отдаёт вход в тестах). */
  saves: new Map<string, number>(),
  /** charId → последний записанный сейв. */
  data: new Map<string, SaveState>(),
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
    return Promise.resolve(d ? { userId: 'user', data: structuredClone(d), version: db.saves.get(charId) ?? 1 } : null);
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const r of rooms.splice(0)) r.stop(); });

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
  count(t: ServerFrame['t']): number { return this.frames.filter((f) => f.t === t).length; }
}

const rooms: Room[] = [];
let seq = 0;
const freshLimits = (userId: string): void => { limits.forgeCmd.reset(userId); limits.townCmd.reset(userId); limits.cmdResync.reset(userId); };
function makeRoom(userId: string, classId = cfg.get('classes')[0]!.id): { room: Room; ws: FakeWs; pid: string; save: SaveState } {
  freshLimits(userId);
  const room = new RoomCtor('R5', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(room);
  const ws = new FakeWs();
  const save = newCharacterSave(cfg, classId, 'Герой', `char-r5-${++seq}`);
  const pid = room.addPlayer(ws as unknown as GameConn, userId, save, 1);
  return { room, ws, pid, save };
}
function addPeer(room: Room, userId: string): { ws: FakeWs; pid: string; save: SaveState } {
  freshLimits(userId);
  const ws = new FakeWs();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Сосед', `char-r5-${++seq}`);
  const pid = room.addPlayer(ws as unknown as GameConn, userId, save, 1);
  return { ws, pid, save };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Снять паузу между переходами (R1-03): тесты проходят граф забега за миллисекунды. */
const ready = (room: Room): void => { (room as unknown as { movedAt: number }).movedAt = 0; };
const areaOf = (room: Room): string => (room as unknown as { area: string }).area;
const nodeOf = (plan: RunPlan, id: string): RunNode => plan.nodes.find((n) => n.id === id)!;
const nodeNow = (ws: FakeWs): RunNode => { const rp = ws.last('runPlan')!; return nodeOf(rp.plan, rp.currentNodeId); };
type Pt = { x: number; y: number };
type MonIn = { alive: boolean; pos: Pt; aiState: 'idle' | 'chase'; windup: unknown };
type PlayerIn = { pos: Pt; hp: number; alive: boolean; toggles: string[]; combatTimer: number; debuffs: Record<string, unknown> };
type WorldIn = { spawn: Pt; exits?: Pt[]; monsters: MonIn[]; players: Record<string, PlayerIn> };
const worldOf = (room: Room): WorldIn => (room as unknown as { session: { world: WorldIn } }).session.world;
const decorOf = (room: Room): { kind: string; x: number; y: number }[] => (room as unknown as { decor: { kind: string; x: number; y: number }[] }).decor;
const idle = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
/** Встать к выходу ребра на узел `to` (без `to` — первого ребра), на финале — к порталу. */
function toExit(room: Room, ws: FakeWs, pid: string, to?: string): void {
  const node = nodeNow(ws);
  const i = Math.max(0, to ? node.edges.findIndex((e) => e.to === to) : 0);
  const at = node.edges.length === 0 ? decorOf(room).find((d) => d.kind === 'portal')! : worldOf(room).exits![i]!;
  worldOf(room).players[pid]!.pos = { x: at.x, y: at.y };
}
/** Пати из двух: A хозяин, B сосед (1000 золота); забег начат, B голосует «за» каждый переход. */
async function party(tag: string) {
  const a = makeRoom(`user-${tag}-a`);
  const b = addPeer(a.room, `user-${tag}-b`);
  b.save.gold = 1000;
  await settle();
  a.room.descend(a.pid);
  a.room.castVote(b.pid, true);
  expect(areaOf(a.room)).toBe('dungeon');
  const down = (): void => {
    const cur = nodeNow(a.ws);
    ready(a.room);
    toExit(a.room, a.ws, a.pid, cur.edges[0]!.to);
    a.room.descend(a.pid, undefined, cur.edges[0]!.to);
    a.room.castVote(b.pid, true);
  };
  return { a, b, down };
}

/**
 * ⭐ R5-03: ТОГЛ (АУРА, СТОЙКА) — ОДНО НАЖАТИЕ, ОДНО ПЕРЕКЛЮЧЕНИЕ. Клиент шлёт каст тогла только в кадре нажатия, следующий кадр
 * уходит через период пейсера (33–50 мс). Тик, увидевший кадр, снимал из ввода только рывок и пояс — каст оставался, и
 * каждый тик без нового кадра (догон планировщика, 75 Гц / 50 FPS, джиттер, склейка нажатия с отпусканием R4-19) звал
 * переключение снова: аура включалась и тут же выключалась (на 60 Гц — в 14 % нажатий).
 */
describe('Room — раунд 5: тогл срабатывает один раз на нажатие (R5-03)', () => {
  const AURA = 'b-aura-a1';
  function auraHero(tag: string) {
    const h = makeRoom(`user-r503-${tag}`);
    h.save.skills[AURA] = 1;
    return { ...h, p: () => worldOf(h.room).players[h.pid]! };
  }

  it('⭐ кадр нажатия, затем три тика без нового кадра — аура включена (было: вкл-выкл-вкл)', () => {
    const { room, pid, p } = auraHero('held');
    room.setInput(pid, { ...idle, cast: AURA });
    for (let i = 0; i < 3; i++) {
      room.step(false);
      expect(p().toggles, `тик ${i + 1}: одно нажатие — одно переключение`).toEqual([AURA]);
    }
    room.setInput(pid, idle);
    room.step(false);
    expect(p().toggles).toEqual([AURA]);
  });

  it('⭐ нажатие и отпускание склеены в один тик (R4-19), дальше тик без кадра — включена; второе нажатие выключает', () => {
    const { room, pid, p } = auraHero('merged');
    room.setInput(pid, { ...idle, cast: AURA });
    room.setInput(pid, idle);
    room.step(false);
    room.step(false);
    expect(p().toggles, 'склеенное нажатие сработало ровно раз').toEqual([AURA]);
    room.setInput(pid, { ...idle, cast: AURA });
    room.step(false);
    room.step(false);
    expect(p().toggles, 'второе нажатие — выкл, и тик без кадра не включил её обратно').toEqual([]);
  });

  it('удержанный каст НЕ тогла по-прежнему держится между кадрами (снимается только тогл)', () => {
    const { room, pid } = auraHero('attack');
    room.setInput(pid, { ...idle, cast: 'b-axe1h-a1' });
    room.step(false);
    expect((room as unknown as { clients: Map<string, { input: { cast: string | null } }> }).clients.get(pid)!.input.cast).toBe('b-axe1h-a1');
  });
});

/** Натравить на героя живого монстра: встал рядом и гонится (цель монстра — ближайший живой игрок, как в `GameSession`). */
function chase(room: Room, pid: string): MonIn {
  const w = worldOf(room);
  const m = w.monsters.find((x) => x.alive) ?? w.monsters[0]!;
  m.alive = true;
  const at = w.players[pid]!.pos;
  m.pos = { x: at.x + 20, y: at.y };
  m.aiState = 'chase';
  return m;
}
const graceOf = (room: Room): Map<string, { fled: boolean }> => (room as unknown as { disconnected: Map<string, { fled: boolean }> }).disconnected;

/**
 * ⭐ R5-04: «ЗАВЕРШИТЬ ЗАБЕГ» НА ФИНАЛЕ — ТОЖЕ УХОД В ГОРОД. R4-14 закрыл голос «в город» издалека (только у портала или
 * мёртвым), а голос за завершение финала засчитывался откуда угодно: напарник у портала финала жмёт «Завершить», а герой
 * в трёх тысячах пикселей, посреди боя, с 1 HP голосует «за» — и уходит в город с золотом и добычей, забег закрыт.
 */
describe('Room — раунд 5: голос за уход с этажа (R5-04)', () => {
  async function atFinale(tag: string) {
    const pt = await party(tag);
    for (let g = 0; g < 40 && nodeNow(pt.a.ws).edges.length; g++) pt.down();
    expect(nodeNow(pt.a.ws).edges.length, 'дошли до финала').toBe(0);
    return pt;
  }

  it('⭐ финал: «за» завершение издалека и в бою — отказ «far», забег и золото целы; у портала — завершается', async () => {
    const { a, b } = await atFinale('r504');
    const w = worldOf(a.room);
    const pb = w.players[b.pid]!;
    pb.pos = { x: w.spawn.x + 3000, y: w.spawn.y + 3000 };
    pb.hp = 1;
    chase(a.room, b.pid);
    ready(a.room);
    toExit(a.room, a.ws, a.pid);                               // A у портала финала
    a.room.descend(a.pid);
    expect(a.ws.last('voteStart')?.kind).toBe('descend');
    b.ws.frames.length = 0;
    a.room.castVote(b.pid, true);
    expect(b.ws.last('error')?.code, 'издалека «за» не засчитано').toBe('far');
    expect(areaOf(a.room), 'забег не завершён').toBe('dungeon');
    expect(b.save.gold).toBe(1000);
    expect(b.save.run, 'забег B цел').toBeTruthy();
    const portal = decorOf(a.room).find((d) => d.kind === 'portal')!;
    pb.pos = { x: portal.x, y: portal.y };
    a.room.castVote(b.pid, true);
    expect(areaOf(a.room), 'у портала — завершено').toBe('town');
  });

  it('⭐ финал: «за», поданное у портала, снимается, если герой ушёл обратно в бой; мёртвый голосует откуда угодно', async () => {
    const { a, b } = await atFinale('r504b');
    const c = addPeer(a.room, 'user-r504b-c');
    const w = worldOf(a.room);
    const portal = decorOf(a.room).find((d) => d.kind === 'portal')!;
    for (const pid of [a.pid, b.pid, c.pid]) w.players[pid]!.pos = { x: portal.x, y: portal.y };
    ready(a.room);
    a.room.descend(a.pid);
    a.room.castVote(b.pid, true);
    w.players[b.pid]!.pos = { x: w.spawn.x + 3000, y: w.spawn.y };   // …и ушёл
    a.room.castVote(c.pid, true);
    expect(areaOf(a.room), 'B уже не у портала — завершения нет').toBe('dungeon');
    expect(b.ws.last('error')?.code).toBe('far');
    w.players[b.pid]!.alive = false; w.players[b.pid]!.hp = 0;       // погиб — ему уходить можно
    a.room.castVote(b.pid, true);
    expect(areaOf(a.room)).toBe('town');
  });

  it('⭐ обычный спуск: «за» от героя, на которого идёт монстр, вдали от выхода — отказ; вне опасности — откуда угодно', async () => {
    const { a, b } = await party('r504c');
    const w = worldOf(a.room);
    const cur = nodeNow(a.ws);
    w.players[b.pid]!.pos = { x: w.spawn.x + 3000, y: w.spawn.y + 3000 };
    const m = chase(a.room, b.pid);
    ready(a.room);
    toExit(a.room, a.ws, a.pid, cur.edges[0]!.to);
    a.room.descend(a.pid, undefined, cur.edges[0]!.to);
    b.ws.frames.length = 0;
    a.room.castVote(b.pid, true);
    expect(b.ws.last('error')?.code, 'посреди боя спуск не уносит').toBe('far');
    expect(nodeNow(a.ws).id, 'узел тот же').toBe(cur.id);
    m.aiState = 'idle';                                        // оторвался — угрозы нет
    a.room.castVote(b.pid, true);
    expect(nodeNow(a.ws).id, 'вне опасности — «за» засчитано откуда угодно').toBe(cur.edges[0]!.to);
  });
});

/**
 * ⭐ R5-11: «СБЕЖАЛ ИЗ БОЯ» — ЭТО НАСТОЯЩАЯ УГРОЗА, А НЕ ОКНО БОЕВОГО АЙДЛА. Мерой был `combatTimer`, который ставит и СВОЙ
 * замах героя на 15 с (`combatLingerSec` — окно анимации): добил последнего монстра, собрал добычу и спокойно закрыл
 * вкладку — пати ушла в город, и ушедший получал полный штраф смерти.
 */
describe('Room — раунд 5: сбежавший из боя — по настоящей угрозе (R5-11)', () => {
  it('⭐ монстров нет, B ударил раз, постоял секунду и вышел вдали от портала — ждёт в грейсе без штрафа', async () => {
    const { a, b } = await party('r511');
    const w = worldOf(a.room);
    for (const m of w.monsters) m.alive = false;
    a.room.setInput(b.pid, { ...idle, attack: true });
    for (let i = 0; i < 3; i++) a.room.step(false);
    a.room.setInput(b.pid, idle);
    for (let i = 0; i < 30; i++) a.room.step(false);
    expect(w.players[b.pid]!.combatTimer, 'окно боевого айдла ещё идёт — оно и было мерой').toBeGreaterThan(0);
    w.players[b.pid]!.pos = { x: w.spawn.x + 1400, y: w.spawn.y };
    await a.room.removePlayer(b.pid);
    expect(graceOf(a.room).get(b.save.charId)?.fled, 'не сбежал').toBe(false);
    ready(a.room);
    w.players[a.pid]!.pos = { ...w.spawn };
    a.room.returnTown(a.pid);
    expect(areaOf(a.room)).toBe('town');
    await settle();
    expect(graceOf(a.room).has(b.save.charId), 'B ждёт реконнекта').toBe(true);
    const inDb = db.data.get(b.save.charId)!;
    expect(inDb.gold, 'без штрафа').toBe(1000);
    expect(inDb.run, 'забег припаркован').toBeTruthy();
  });

  it('⭐ на B идёт монстр, когда он выходит, — сбежал: пати ушла в город — штраф брошенного забега', async () => {
    const { a, b } = await party('r511b');
    const w = worldOf(a.room);
    w.players[b.pid]!.pos = { x: w.spawn.x + 1400, y: w.spawn.y };
    chase(a.room, b.pid);
    await a.room.removePlayer(b.pid);
    expect(graceOf(a.room).get(b.save.charId)?.fled, 'сбежал из боя').toBe(true);
    ready(a.room);
    w.players[a.pid]!.pos = { ...w.spawn };
    a.room.returnTown(a.pid);
    await settle();
    const inDb = db.data.get(b.save.charId)!;
    expect(inDb.gold, 'штраф').toBeLessThan(1000);
    expect(inDb.run, 'забег снят').toBeUndefined();
  });
});

/**
 * ⭐ R5-19: С ДОСКИ, ПЕРЕЖИВШЕЙ СВОЙ СРОК, НЕ БЕРУТ. Доска катается только на заходе в город, и герой, простоявший в городе
 * дольше срока (ковал, разбирал сундук), брал задание со старой доски — поколение такой доски квота пишет «сейчас»
 * (`boardTime`), и следующая, честно скатанная доска отказывала в том же шаблоне весь свой срок: «доска обновится позже».
 */
describe('Room — раунд 5: доска, пережившая срок (R5-19)', () => {
  type QuestFrame = { id: string; objectives: { type: string }[] };
  const boardOf = (ws: FakeWs): QuestFrame[] => (ws.last('questBoard')?.quests ?? []) as QuestFrame[];
  const delveOf = (ws: FakeWs): QuestFrame | undefined => boardOf(ws).find((q) => q.objectives.some((o) => o.type === 'reach-floor'));
  const stockAt = (room: Room): number => (room as unknown as { stock: { at: number } }).stock.at;

  it('⭐ взял со старой доски — «доска обновилась», пришла новая; с неё — можно, поколение в квоте настоящее; следующая доска — тоже можно', async () => {
    const W = cfg.get('balance').townRestockSec * 1000;
    const T0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { room, ws, pid, save } = makeRoom('user-r519');
    await settle();
    const old = delveOf(ws)!;
    expect(old, 'на доске есть «достичь этажа»').toBeDefined();
    vi.setSystemTime(T0 + W + 2 * 60_000);                  // стоял в городе дольше срока доски
    const boards = ws.count('questBoard');
    await room.handleCmd(pid, { cmd: 'acceptQuest', questId: old.id }, 1);
    const r = ws.last('cmdResult')!;
    expect(r, 'со старой доски не берут').toMatchObject({ id: 1, ok: false });
    expect(r.reason).toMatch(/Доска обновилась/);
    expect(ws.count('questBoard'), 'новая доска пришла').toBeGreaterThan(boards);
    expect(save.quests.some((q) => q.questId === old.id), 'квест не взят').toBe(false);
    const fresh = delveOf(ws)!;
    expect(fresh.id).not.toBe(old.id);
    expect(stockAt(room), 'доска скатана сейчас').toBe(T0 + W + 2 * 60_000);
    await room.handleCmd(pid, { cmd: 'acceptQuest', questId: fresh.id }, 2);
    expect(ws.last('cmdResult'), 'с новой — можно').toMatchObject({ id: 2, ok: true });
    const prog = save.quests.find((q) => q.questId === fresh.id)!;
    expect(prog.boardAt, 'поколение — настоящее время доски').toBe(stockAt(room));
    prog.status = 'turned-in';
    vi.setSystemTime(T0 + 2 * W + 3 * 60_000);             // срок и этой доски вышел — заход в город катает следующую
    ready(room); room.enterArena(pid);
    ready(room); room.returnTown(pid);
    const next = delveOf(ws)!;
    expect(next.id).not.toBe(fresh.id);
    await room.handleCmd(pid, { cmd: 'acceptQuest', questId: next.id }, 3);
    expect(ws.last('cmdResult'), 'следующая честная доска — берётся сразу').toMatchObject({ id: 3, ok: true });
  });
});

/**
 * ⭐ R5-22: СТОК КУЗНИЦЫ — В СЕЙВЕ ГЕРОЯ, А НЕ В ПАМЯТИ ОДНОЙ НОДЫ. Карта стоков жила в процессе: в кластере вышел из города,
 * вошёл без кода на другую ноду (маршрут по букве любого кода) — и прилавок катался заново, бесплатно: N нод — N бросков за
 * срок, рестарт — ещё один. Теперь в сейве опознание стока (когда, сид, уровень, что куплено): любая нода и новый процесс
 * собирают тот же прилавок за вычетом купленного.
 */
describe('Room — раунд 5: сток кузницы переживает переход на другую ноду (R5-22)', () => {
  /** Вещь без личности: что это за бросок (uid у каждого броска свой — купленное не повторит чужой uid). */
  const sig = (it: Item): string => { const { uid: _u, ...rest } = it as Item & { uid: string }; return JSON.stringify(rest); };
  const gearOf = (ws: FakeWs): Item[] => ws.last('shop')!.items.filter((i) => i.kind !== 'consumable');
  /** «Другая нода»: модуль комнаты заново — своя карта стоков в памяти, как у отдельного процесса. */
  async function otherNode(): Promise<typeof import('./room.js').Room> {
    vi.resetModules();
    return (await import('./room.js')).Room;
  }
  function joinOn(Ctor: typeof import('./room.js').Room, save: SaveState, userId: string): { room: Room; ws: FakeWs; pid: string } {
    const room = new Ctor('R5N', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(room);
    const ws = new FakeWs();
    const pid = room.addPlayer(ws as unknown as GameConn, userId, save, db.saves.get(save.charId) ?? 1);
    return { room, ws, pid };
  }

  it('⭐ купил вещь, вышел, вошёл на другой ноде — тот же прилавок без купленного; вышел срок или вырос уровень — новый', async () => {
    const T0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const user = 'user-r522';
    const { room, ws, pid, save } = makeRoom(user);
    await settle();
    const first = gearOf(ws);
    expect(first.length, 'в кузнице есть снаряжение').toBeGreaterThan(2);
    save.gold = 10_000_000;
    const bought = first[1]!;
    await room.handleCmd(pid, { cmd: 'buy', uid: bought.uid }, 1);
    expect(ws.last('cmdResult'), JSON.stringify(ws.last('cmdResult'))).toMatchObject({ id: 1, ok: true });
    await room.removePlayer(pid);
    await settle();
    const stored = structuredClone(db.data.get(save.charId)!);
    const want = first.filter((i) => i.uid !== bought.uid).map(sig);

    const B = await otherNode();
    const b = joinOn(B, structuredClone(stored), user);
    await settle();
    expect(gearOf(b.ws).map(sig), 'та же витрина без купленного — перекатать сменой ноды нельзя').toEqual(want);
    await b.room.removePlayer(b.pid);
    await settle();

    const C = await otherNode();                            // и после рестарта процесса — то же
    const c = joinOn(C, structuredClone(db.data.get(save.charId)!), user);
    await settle();
    expect(gearOf(c.ws).map(sig)).toEqual(want);
    await c.room.removePlayer(c.pid);
    await settle();

    const up = structuredClone(db.data.get(save.charId)!);
    up.level += 5;
    const D = await otherNode();
    const d = joinOn(D, up, user);
    await settle();
    expect(gearOf(d.ws).map(sig), 'вырос уровень — снаряжение по новому уровню (R3-17)').not.toEqual(want);
    await d.room.removePlayer(d.pid);
    await settle();

    vi.setSystemTime(T0 + cfg.get('balance').townRestockSec * 1000 + 1);
    const E = await otherNode();
    const e = joinOn(E, structuredClone(stored), user);
    await settle();
    expect(gearOf(e.ws).map(sig), 'срок вышел — новый прилавок').not.toEqual(want);
  });
});
