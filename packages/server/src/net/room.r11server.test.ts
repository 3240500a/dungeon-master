import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, type Item, type ServerFrame, type SaveState } from '@dm/shared';

/**
 * ⭐ РАУНД 11 (сервер), комната. Комната настоящая; база — маленькая честная (версии сейва), без часов.
 *  • R11-04: «город → арена → город» и «выйти из города → Продолжить» больше не лечат: здоровье, мана и выносливость — какими были
 *    (арена — отдельное тело на время боя), а вход в НОВУЮ комнату берёт их из сейва;
 *  • R11-13: выключенная в редакторе база зелья не лежит на прилавке и не продаётся.
 */
const db = vi.hoisted(() => ({ versions: new Map<string, number>(), data: new Map<string, unknown>() }));
vi.mock('../db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    const snap = structuredClone(data);
    if (v !== (db.versions.get(charId) ?? 1)) return Promise.resolve(null);
    db.versions.set(charId, v + 1); db.data.set(charId, snap);
    return Promise.resolve(v + 1);
  },
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: (charId: string) => {
    const d = db.data.get(charId);
    return Promise.resolve(d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null);
  },
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type P = { hp: number; mana: number; stamina: number; maxHp: number; alive: boolean; pos: { x: number; y: number }; save: SaveState };
type RoomIn = {
  area: string; movedAt: number; runNodeId: string | null;
  session: { world: { players: Record<string, P>; spawn: { x: number; y: number }; monsters: { aiState: string }[] } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  addPlayerResumeRun(ws: unknown, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): Promise<unknown>;
  enterArena(pid: string): void; returnTown(pid: string): void; descend(pid: string): void; castVote(pid: string, yes: boolean): void;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
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
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
let seq = 0;
function newRoom(reg = cfg): RoomIn {
  const room = new RoomCtor(`R11R${++seq}`, reg, hooks);
  rooms.push(room);
  return room;
}
function hero(): SaveState {
  const charId = `char-r11r-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  s.level = 30; s.gold = 5000; s.attributes.vitality = 60;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const ready = (room: RoomIn): void => { room.movedAt = 0; };
const P = (room: RoomIn, pid: string): P => room.session.world.players[pid]!;
/** Сколько здоровья даёт реген за время теста (тиков — единицы): щедрый потолок. */
const REGEN_SLACK = 5;

describe('⭐ R11-04: арена и новый вход не лечат даром', () => {
  it('в городе: HP 1, мана 0 → арена → город — какими были (урон арены не в счёт)', async () => {
    const room = newRoom();
    const pid = room.addPlayer(new FakeWs(), 'user-a', hero(), 1);
    await settle();
    room.step();
    const p = P(room, pid);
    p.hp = 1; p.mana = 0; p.stamina = 0;
    ready(room); room.enterArena(pid);
    expect(room.area).toBe('arena');
    expect(p.hp, 'на арене — полное тело').toBe(p.maxHp);
    ready(room); room.returnTown(pid);
    expect(room.area).toBe('town');
    expect(p.hp).toBeLessThanOrEqual(1 + REGEN_SLACK);
    expect(p.mana).toBeLessThanOrEqual(REGEN_SLACK);
  });

  it('урон PvP на арене в город не идёт: полным ушёл — полным вернулся', async () => {
    const room = newRoom();
    const pid = room.addPlayer(new FakeWs(), 'user-a', hero(), 1);
    await settle();
    room.step();
    const p = P(room, pid);
    const max = p.maxHp;
    ready(room); room.enterArena(pid);
    p.hp = 10;
    ready(room); room.returnTown(pid);
    expect(p.hp).toBe(max);
  });

  it('посреди забега: у портала 5% → город → арена → город → «Продолжить» того же узла — 5%', async () => {
    const room = newRoom();
    const pid = room.addPlayer(new FakeWs(), 'user-a', hero(), 1);
    await settle();
    ready(room); room.descend(pid);
    expect(room.area).toBe('dungeon');
    const node = room.runNodeId;
    room.step();
    const p = P(room, pid);
    const low = Math.max(1, Math.round(p.maxHp * 0.05));
    p.hp = low; p.mana = 0;
    for (const m of room.session.world.monsters) m.aiState = 'idle';
    p.pos = { ...room.session.world.spawn };
    ready(room); room.returnTown(pid);
    expect(room.area).toBe('town');
    ready(room); room.enterArena(pid);
    ready(room); room.returnTown(pid);
    ready(room); room.descend(pid);
    await settle();
    expect(room.area).toBe('dungeon');
    expect(room.runNodeId, 'тот же узел').toBe(node);
    expect(p.hp).toBeLessThanOrEqual(low + REGEN_SLACK);
  });

  it('посреди забега: у портала 5% → город → выйти → «Продолжить» в НОВОЙ комнате — 5%', async () => {
    const room = newRoom();
    const save = hero();
    const pid = room.addPlayer(new FakeWs(), `user-${save.charId}`, save, 1);
    await settle();
    ready(room); room.descend(pid);
    const node = room.runNodeId;
    room.step();
    const p = P(room, pid);
    const low = Math.max(1, Math.round(p.maxHp * 0.05));
    p.hp = low; p.mana = 0;
    for (const m of room.session.world.monsters) m.aiState = 'idle';
    p.pos = { ...room.session.world.spawn };
    ready(room); room.returnTown(pid);
    expect(room.area).toBe('town');
    await room.removePlayer(pid);
    await settle();
    const stored = structuredClone(db.data.get(save.charId)) as SaveState;
    expect(stored.run?.currentNodeId, 'забег припаркован').toBe(node);
    const room2 = newRoom();
    const pid2 = room2.addPlayerResumeRun(new FakeWs(), `user-${save.charId}`, stored, db.versions.get(save.charId)!);
    expect(room2.runNodeId).toBe(node);
    expect(P(room2, pid2).hp).toBeLessThanOrEqual(low + REGEN_SLACK);
    expect(P(room2, pid2).mana).toBeLessThanOrEqual(REGEN_SLACK);
  });

  it('время вне игры — реген, как если бы стоял в городе: только что вышел — ранен, спустя два часа — полон', async () => {
    const probe = newRoom();
    const s = hero();
    const max = P(probe, probe.addPlayer(new FakeWs(), 'user-p', s, 1)).maxHp;
    const low = Math.round(max * 0.1);
    const as = (tag: string, at: number): SaveState => {
      const c = structuredClone(s);
      c.charId = `${s.charId}-${tag}`;
      c.vitals = { hp: low, mana: 0, stamina: 0, at };
      return c;
    };
    const r1 = newRoom();
    expect(P(r1, r1.addPlayer(new FakeWs(), 'user-p', as('now', Date.now()), 1)).hp, 'только что вышел').toBeLessThanOrEqual(low + REGEN_SLACK);
    const r2 = newRoom();
    expect(P(r2, r2.addPlayer(new FakeWs(), 'user-p', as('old', Date.now() - 2 * 3_600_000), 1)).hp, 'два часа спустя').toBe(max);
  });

  it('кооп: A ушёл с арены (там — полный), пати вернулась в город — A по коду возвращается раненым, и в базе — раненым', async () => {
    const room = newRoom();
    const a = hero();
    const pa = room.addPlayer(new FakeWs(), `user-${a.charId}`, a, 1);
    const pb = room.addPlayer(new FakeWs(), 'user-b', hero(), 1);
    await settle();
    room.step();
    const low = Math.round(P(room, pa).maxHp * 0.2);
    P(room, pa).hp = low;
    ready(room); room.enterArena(pa); room.castVote(pb, true);
    expect(room.area).toBe('arena');
    expect(P(room, pa).hp, 'на арене — полное тело').toBe(P(room, pa).maxHp);
    await room.removePlayer(pa);   // ушёл с арены полным
    await settle();
    expect((db.data.get(a.charId) as SaveState & { vitals?: { hp: number } }).vitals?.hp, 'в базе — тело города').toBeLessThanOrEqual(low + REGEN_SLACK);
    ready(room); room.returnTown(pb);
    expect(room.area).toBe('town');
    const back = room.addPlayer(new FakeWs(), `user-${a.charId}`, structuredClone(db.data.get(a.charId)) as SaveState, db.versions.get(a.charId)!);
    expect(P(room, back).hp).toBeLessThanOrEqual(low + REGEN_SLACK);
  });
});

describe('⭐ R11-13: выключенное зелье не на прилавке и не продаётся', () => {
  const offReg = (ids: string[]): ConfigRegistry => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const base = structuredClone(reg.get('items.base')).map((b) => (ids.includes(b.id) ? { ...b, enabled: false } : b));
    reg.reload({ 'items.base': base } as never);
    return reg;
  };
  const shelf = (ws: FakeWs): Item[] => (ws.last('shop') as unknown as { items: Item[] }).items;

  it('контроль: с поставочными данными — все четыре зелья по пять', async () => {
    const room = newRoom();
    const ws = new FakeWs();
    room.addPlayer(ws, 'user-s', hero(), 1);
    await settle();
    for (const id of ['minor-healing-potion', 'healing-potion', 'mana-potion', 'antidote']) {
      expect(shelf(ws).filter((i) => i.baseId === id).length, id).toBe(5);
    }
  });

  it('«mana-potion» выключена — на прилавке её нет, остальные на месте', async () => {
    const reg = offReg(['mana-potion']);
    const room = newRoom(reg);
    const ws = new FakeWs();
    room.addPlayer(ws, 'user-s', hero(), 1);
    await settle();
    expect(shelf(ws).some((i) => i.baseId === 'mana-potion')).toBe(false);
    expect(shelf(ws).filter((i) => i.baseId === 'healing-potion').length).toBe(5);
  });

  it('выключили, пока прилавок стоит (правка редактора живьём), — покупка с прилавка отказана', async () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const room = newRoom(reg);
    const ws = new FakeWs();
    const save = hero();
    const pid = room.addPlayer(ws, 'user-s', save, 1);
    await settle();
    const mana = shelf(ws).find((i) => i.baseId === 'mana-potion')!;
    expect(mana).toBeTruthy();
    const base = structuredClone(reg.get('items.base')).map((b) => (b.id === 'mana-potion' ? { ...b, enabled: false } : b));
    reg.reload({ 'items.base': base } as never);
    await room.handleCmd(pid, { cmd: 'buy', uid: mana.uid }, 1);
    expect(ws.last('cmdResult')).toMatchObject({ ok: false });
    expect(save.inventory.some((i) => i.baseId === 'mana-potion')).toBe(false);
  });
});
