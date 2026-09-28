import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type PlayerInput } from '@dm/shared';
import { limits } from './rateLimit.js';

// Тесты ждут комнату оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решают мок базы и шаги комнаты.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ ФАЗЗЕРЫ, ПРОХОД ПРАВОК 1 (сервер), комната. Комната настоящая; база — маленькая честная (версии сейва), запись героя умеет зависнуть
 * до знака теста.
 *  • V-B2-04: вещь, выброшенная героем, лежит ещё и в его строке базы, пока его запись без неё не ляжет, — поднять её сосед по аккаунту не
 *    может ни командой, ни [E] (тиком): иначе она легла бы и в строку поднявшего, и падение процесса в этом окне раздало бы её обоим.
 *    Команда подъёма ждёт записи выбросившего (она встаёт в очередь сразу); копия выбросившего проиграла — вещь уходит с земли.
 */
const db = vi.hoisted(() => ({
  versions: new Map<string, number>(), data: new Map<string, SaveState>(),
  /** Следующая запись героя ждёт, пока тест не откроет. */
  gate: new Map<string, Promise<void>>(),
}));
vi.mock('../db/db.js', () => ({
  putCharacter: async (charId: string, _u: string, data: SaveState, version: number) => {
    const snap = structuredClone(data);   // снимок — в момент вызова, как `snapshotOf`
    const g = db.gate.get(charId);
    if (g) { db.gate.delete(charId); await g; }
    if (version !== (db.versions.get(charId) ?? 1)) return null;
    db.versions.set(charId, version + 1); db.data.set(charId, snap);
    return version + 1;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getCharacter: async (charId: string) => {
    const d = db.data.get(charId);
    return d ? { userId: 'user-f1r', data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null;
  },
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Drop = { id: number; pos: { x: number; y: number }; item?: { uid: string }; heldBy?: string };
type P = { alive: boolean; pos: { x: number; y: number }; save: SaveState };
type RoomIn = {
  session: { world: { players: Record<string, P>; drops: Drop[] } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
  setInput(pid: string, input: PlayerInput): void;
  persist(pid: string): Promise<string>;
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
  db.gate.clear();
  vi.restoreAllMocks();
});

class FakeWs {
  open = true; readonly ip = '127.0.0.1'; frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void {} onClose(): void {}
  result(id: number): Extract<ServerFrame, { t: 'cmdResult' }> | undefined {
    return this.frames.find((f): f is Extract<ServerFrame, { t: 'cmdResult' }> => f.t === 'cmdResult' && f.id === id);
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
const USER = 'user-f1r';
let seq = 0;
/** Герой аккаунта `USER`: оружие — в сумке (его и выбрасываем). */
function hero(): { save: SaveState; x: string } {
  const charId = `char-f1r-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  const w = s.equipment.weapon!;
  delete s.equipment.weapon;
  w.pos = { x: 0, y: 0 };
  s.inventory.push(w);
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return { save: s, x: w.uid };
}
const uids = (s: SaveState): string[] => [...s.inventory.map((i) => i.uid), ...Object.values(s.equipment).filter(Boolean).map((i) => i!.uid)];
const idle = (interact = false): PlayerInput => ({ move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact });

/** Два героя одного аккаунта в городской комнате; тик — только шагами теста. */
async function pair(): Promise<{ room: RoomIn; pa: string; pb: string; wsA: FakeWs; wsB: FakeWs; a: SaveState; b: SaveState; x: string }> {
  const room = new RoomCtor(`F1R${++seq}`, cfg, hooks);
  rooms.push(room);
  const A = hero(), B = hero();
  const wsA = new FakeWs(), wsB = new FakeWs();
  const pa = room.addPlayer(wsA, USER, A.save, 1);
  const pb = room.addPlayer(wsB, USER, B.save, 1);
  await settle();
  room.stop();
  for (const l of [limits.townCmd, limits.cmdResync]) l.reset(USER);
  return { room, pa, pb, wsA, wsB, a: A.save, b: B.save, x: A.x };
}
/** Запись героя повиснет до `open()`. */
function stall(charId: string): () => void {
  let open!: () => void;
  db.gate.set(charId, new Promise<void>((r) => { open = r; }));
  return () => open();
}

describe('⭐ V-B2-04: выброшенное — чужой руке только после записи выбросившего без него', () => {
  it('⭐ подъём соседа по аккаунту ждёт запись выбросившего (база медленная) — в базе вещь в одной строке', async () => {
    const { room, pa, pb, wsB, a, b, x } = await pair();
    const open = stall(a.charId);   // запись выброса повиснет
    await room.handleCmd(pa, { cmd: 'drop', uid: x }, 1);
    const d = room.session.world.drops.find((q) => q.item?.uid === x)!;
    expect(d.heldBy, 'помечена выбросившим').toBe(a.charId);
    room.session.world.players[pb]!.pos = { ...d.pos };
    const pick = room.handleCmd(pb, { cmd: 'pickup', dropId: d.id }, 1);
    await settle();
    expect(uids(room.session.world.players[pb]!.save), 'пока строка A держит вещь — у B её нет').not.toContain(x);
    open();
    await pick;
    expect(wsB.result(1), 'поднял, как только запись A легла').toMatchObject({ ok: true });
    expect(uids(db.data.get(a.charId)!), 'в строке A вещи уже нет').not.toContain(x);
    expect(await room.persist(pb)).toBe('ok');
    expect(uids(db.data.get(b.charId)!)).toContain(x);
  });

  it('⭐ [E] (подбор тиком) выброшенного соседом не берёт, пока его запись не легла', async () => {
    const { room, pa, pb, a, x } = await pair();
    const open = stall(a.charId);
    await room.handleCmd(pa, { cmd: 'drop', uid: x }, 1);
    const d = room.session.world.drops.find((q) => q.item?.uid === x)!;
    room.session.world.players[pb]!.pos = { ...d.pos };
    room.setInput(pb, idle(true));
    room.step();
    expect(uids(room.session.world.players[pb]!.save), '[E] не взял').not.toContain(x);
    expect(room.session.world.drops.some((q) => q.item?.uid === x)).toBe(true);
    open();
    await settle();
    expect(d.heldBy, 'запись A легла — метка снята').toBeUndefined();
    room.setInput(pb, idle(true));
    room.step();
    expect(uids(room.session.world.players[pb]!.save), 'теперь [E] берёт').toContain(x);
  });

  it('выбросивший поднимает своё обратно и до записи — вещь не уходит от него', async () => {
    const { room, pa, wsA, a, x } = await pair();
    const open = stall(a.charId);
    await room.handleCmd(pa, { cmd: 'drop', uid: x }, 1);
    const d = room.session.world.drops.find((q) => q.item?.uid === x)!;
    await room.handleCmd(pa, { cmd: 'pickup', dropId: d.id }, 2);
    expect(wsA.result(2)).toMatchObject({ ok: true });
    expect(uids(room.session.world.players[pa]!.save)).toContain(x);
    open();
    await settle();
  });

  it('⭐ копия выбросившего проиграла (строку обогнали) — вещь в его строке, и с земли она уходит: ни у кого второй', async () => {
    const { room, pa, pb, wsB, a, x } = await pair();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const open = stall(a.charId);
    await room.handleCmd(pa, { cmd: 'drop', uid: x }, 1);
    db.versions.set(a.charId, (db.versions.get(a.charId) ?? 1) + 1);   // строку A переписал кто-то другой (откат, отзыв)
    open();
    await settle();
    expect(room.session.world.drops.some((q) => q.item?.uid === x), 'с земли убрана').toBe(false);
    expect(uids(db.data.get(a.charId)!), 'в строке A — осталась').toContain(x);
    await room.handleCmd(pb, { cmd: 'pickup', dropId: 999 }, 1);
    expect(wsB.result(1)).toMatchObject({ ok: false });
    expect(uids(room.session.world.players[pb]!.save)).not.toContain(x);
  });
});
