import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type PlayerInput } from '@dm/shared';

// Исходы решают мок базы и шаги комнаты, которые тест делает сам (`step`), а не часы; под нагрузкой полного прогона — запас.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ R21-05: ОТКАТЫ, КОТОРЫЕ СЕРВЕР ВЕРНУЛ НА ВХОДЕ, — И ЭКРАНУ. Реконнект в ту же комнату (запись ухода, R4-06), вход в другую (⭐ D4: откаты из
 * сейва, `vitals.cd`) и вторая вкладка ставят герою откаты умений, а клиент узнавал об откате только из события каста (`swing`/`cooldown`): новая
 * страница (F5, другое устройство, вход по коду) рисовала слот готовым, а каст сервер молча отбрасывал до конца скрытого отката. Теперь кадр входа
 * несёт откаты героя (`joined.cooldowns`: остаток и полный, мс) — тем же правилом, по которому их считает каст (`GameSession.cooldownsOf`).
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

type P = { skillCd: Record<string, number>; skillBuffs: Record<string, number>; save: SaveState };
type RoomIn = {
  session: { world: { players: Record<string, P> } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): Promise<{ saved: boolean }>;
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
type Joined = Extract<ServerFrame, { t: 'joined' }>;
const joinedOf = (ws: FakeWs): Joined => ws.frames.find((f): f is Joined => f.t === 'joined')!;
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
const BUFF = 'b-class-warrior-a5';   // «Боевой клич»: 8 с баффа, откат 13.5 с на 1-м ранге (D4)
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
let seq = 0;
function newRoom(): RoomIn {
  const room = new RoomCtor(`R21C${++seq}`, cfg, hooks);
  rooms.push(room);
  return room;
}
function hero(): SaveState {
  const charId = `char-r21c-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  s.level = 40; s.gold = 5000; s.skills[BUFF] = 1;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const fromDb = (charId: string): [SaveState, number] => [structuredClone(db.data.get(charId)) as SaveState, db.versions.get(charId)!];
/** Герой в городе, клич прокричан (кадр ввода и шаг комнаты): откат после шага, с. */
async function shouted(): Promise<{ room: RoomIn; pid: string; h: SaveState; ws: FakeWs; cd: number }> {
  const room = newRoom();
  const h = hero();
  const ws = new FakeWs();
  const pid = room.addPlayer(ws, `user-${h.charId}`, h, 1);
  await settle();
  room.stop();
  room.setInput(pid, { ...idle, cast: BUFF });
  room.step();
  room.setInput(pid, idle);
  const cd = room.session.world.players[pid]!.skillCd[BUFF] ?? 0;
  expect(cd, 'клич прокричан — откат идёт').toBeGreaterThan(13);
  return { room, pid, h, ws, cd };
}

describe('⭐ R21-05: кадр входа несёт откаты героя, которые сервер вернул', () => {
  it('первый вход без откатов — поля нет', async () => {
    const room = newRoom();
    const ws = new FakeWs();
    room.addPlayer(ws, 'user-x', hero(), 1);
    await settle();
    expect(joinedOf(ws).cooldowns, 'нечего слать — кадр прежний').toBeUndefined();
  });

  it('клич → обрыв → реконнект в ту же комнату (запись ухода): `joined` несёт остаток и полный откат клича', async () => {
    const { room, pid, h, cd } = await shouted();
    await room.removePlayer(pid);
    await settle();
    const [save, v] = fromDb(h.charId);
    const ws = new FakeWs();
    const back = room.addPlayer(ws, `user-${h.charId}`, save, v);
    const left = room.session.world.players[back]!.skillCd[BUFF] ?? 0;
    expect(left, 'сервер вернул откат (R4-06)').toBeGreaterThan(cd - 1);
    const got = joinedOf(ws).cooldowns?.[BUFF];
    expect(got, 'было: кадр входа без откатов — слот новой страницы готов, каст молча отброшен').toBeDefined();
    expect(Math.abs(got!.leftMs - left * 1000), 'остаток — как держит сервер (мс, целые)').toBeLessThanOrEqual(0.5);
    expect(got!.fullMs, 'полный — откат клича на его ранге (13.5 с, D4)').toBeCloseTo(13_500, 0);
  });

  it('клич → выход → вход в НОВУЮ комнату (D4: откат из сейва, минус время вне игры): `joined` несёт его', async () => {
    const { room, pid, h, cd } = await shouted();
    await room.removePlayer(pid);
    await settle();
    const [save, v] = fromDb(h.charId);
    expect(save.vitals?.cd?.[BUFF] ?? 0, 'откат — в сейве').toBeGreaterThan(13);
    const other = newRoom();
    const ws = new FakeWs();
    const np = other.addPlayer(ws, `user-${h.charId}`, save, v);
    const left = other.session.world.players[np]!.skillCd[BUFF] ?? 0;   // кадр входа ушёл внутри `addPlayer` — до первого тика
    other.stop();
    expect(left).toBeGreaterThan(cd - 2);
    const got = joinedOf(ws).cooldowns?.[BUFF];
    expect(got, 'было: новая комната — кадр без откатов').toBeDefined();
    expect(Math.abs(got!.leftMs - left * 1000), 'остаток — как держит сервер (мс, целые)').toBeLessThanOrEqual(0.5);
    expect(got!.fullMs).toBeGreaterThanOrEqual(got!.leftMs);
  });

  it('вторая вкладка того же героя (живая сущность выселена): новая вкладка получает откат кадром входа', async () => {
    const { room, h } = await shouted();
    const [save, v] = fromDb(h.charId);
    const ws = new FakeWs();
    room.addPlayer(ws, `user-${h.charId}`, save, v);
    expect(joinedOf(ws).cooldowns?.[BUFF]?.leftMs ?? 0, 'откат сущности, которую сменила вкладка').toBeGreaterThan(13_000);
  });

  it('полный откат кадра входа — тот же, что каст кладёт в `skillCd` (одно правило): на 8-м ранге клича — короче первого', async () => {
    const room = newRoom();
    const h = hero();
    h.skills[BUFF] = 8;
    db.data.set(h.charId, structuredClone(h));
    const pid = room.addPlayer(new FakeWs(), `user-${h.charId}`, h, 1);
    await settle();
    room.stop();
    room.setInput(pid, { ...idle, cast: BUFF });
    room.step();
    room.setInput(pid, idle);
    const cast = room.session.world.players[pid]!.skillCd[BUFF]!;
    const ws = new FakeWs();
    room.addPlayer(ws, `user-${h.charId}`, structuredClone(room.session.world.players[pid]!.save), 1);
    const got = joinedOf(ws).cooldowns?.[BUFF];
    // Каст кладёт в `skillCd` полный откат; тик, в котором он прошёл, мог уже отнять от него свой шаг.
    expect(got!.fullMs, 'полный — как у каста на этом ранге').toBeGreaterThanOrEqual(cast * 1000 - 1);
    expect(got!.fullMs).toBeLessThanOrEqual(cast * 1000 + 1000 / 30 + 1);
    expect(got!.fullMs, 'ранг режет откат баффа (D4)').toBeLessThan(13_000);
    expect(got!.leftMs).toBeLessThanOrEqual(got!.fullMs);
  });
});
