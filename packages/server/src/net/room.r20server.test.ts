import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, itemFromBaseId, addToInventory, type SaveState, type ServerFrame } from '@dm/shared';

/**
 * ⭐ РАУНД 20 (сервер), комната. Комната настоящая; база — маленькая честная (версии сейва) с задвижкой: запись героя висит, пока тест не откроет.
 *  • R20-07: ГЕРОЙ ПОГИБ, ПОКА ШЛА ЗАПИСЬ ПОДЪЁМА СВОЕГО ВЫБРОШЕННОГО. Подъём (`pickThrown`) сверял правила подъёма (жив, может действовать) только
 *    до записи; тик убивал героя, пока она шла, штраф смерти (`chargeDeaths`) катал сумку без вещи, а легшая запись клала вещь в сумку мёртвого —
 *    мимо броска потери и вопреки «мёртвые не поднимают» (C-13, R14-05). Цикл «выбросить — поднять» у края смерти прятал вещь от штрафа. Теперь
 *    вещь, чей подъём пережил смерть героя (или смерть и оживление — вайп и город, спуск пати), остаётся на земле за ним (`heldBy`), как любая,
 *    которую мёртвый поднять не может: его запись без неё метку снимает.
 */
const db = vi.hoisted(() => ({
  versions: new Map<string, number>(), data: new Map<string, unknown>(),
  /** Следующие записи героев ждут, пока тест не откроет. */
  gate: null as Promise<void> | null,
}));
vi.mock('../db/db.js', () => {
  const put = (charId: string, data: SaveState, v: number): Promise<number | null> => {
    const snap = structuredClone(data);   // снимок — в момент вызова, как `snapshotOf`
    const apply = (): number | null => {
      if (v !== (db.versions.get(charId) ?? 1)) return null;
      db.versions.set(charId, v + 1); db.data.set(charId, snap);
      return v + 1;
    };
    return db.gate ? db.gate.then(apply) : Promise.resolve(apply());
  };
  return {
    putCharacter: (charId: string, _u: string, data: SaveState, v: number) => put(charId, data, v),
    putCharacterOwned: (charId: string, _u: string, data: SaveState, v: number) => put(charId, data, v),
    putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
    getCharacter: (charId: string) => {
      const d = db.data.get(charId);
      return Promise.resolve(d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null);
    },
    landedVersion: () => Promise.resolve(null),
    getAccountStash: () => Promise.resolve(null),
    putAccountStash: () => Promise.resolve(),
    getRunLedger: () => Promise.resolve([]),
    mergeRunLedger: () => Promise.resolve(),
  };
});
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Drop = { id: number; kind: string; item?: { uid: string }; heldBy?: string };
type Pl = { hp: number; alive: boolean; debuffs: Record<string, unknown>; save: SaveState };
type RoomIn = {
  area: string;
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  descend(pid: string): void;
  enterTown(): void;
  handleCmd(pid: string, raw: unknown, id?: unknown): Promise<void>;
  step(emit?: boolean): void;
  stop(): void;
  session: { world: { players: Record<string, Pl>; drops: Drop[]; timeMs: number } };
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); db.gate = null; });

class FakeWs {
  open = true; readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void {} onClose(): void {}
}
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
let seq = 0;

/**
 * Герой в подземелье выбросил кольцо (запись выброса легла), задвижка закрыта, и он поднимает его: запись подъёма, несущая кольцо, висит. Дальше —
 * смертельный яд и шаг комнаты: герой погиб, штраф смерти взят с сумки без кольца.
 */
async function pickupThenDie(): Promise<{ room: RoomIn; ws: FakeWs; pid: string; p: Pl; uid: string; charId: string; open: () => void }> {
  const room = new RoomCtor(`R20R${++seq}`, cfg, hooks);
  rooms.push(room);
  room.stop();   // тик — только шагами теста
  const charId = `char-r20r-${seq}`;
  const save = newCharacterSave(cfg, 'warrior', `P${seq}`, charId);
  save.gold = 10_000;
  const ring = itemFromBaseId(cfg.get('items.base'), 'simple-ring', cfg.get('item-tiers'), 'drop')!;
  addToInventory(save.inventory, ring, cfg.get('balance').inventory);
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(save));
  const ws = new FakeWs();
  const pid = room.addPlayer(ws, `user-${charId}`, save, 1);
  await settle();
  room.descend(pid);
  await settle();
  expect(room.area).toBe('dungeon');
  const p = room.session.world.players[pid]!;
  await room.handleCmd(pid, { cmd: 'drop', uid: ring.uid }, 1);
  await settle();
  const d = room.session.world.drops.find((x) => x.kind === 'item' && x.item?.uid === ring.uid)!;
  expect(d, 'кольцо на земле').toBeTruthy();
  expect(d.heldBy, 'запись выброса легла').toBeUndefined();
  let open!: () => void;
  db.gate = new Promise<void>((r) => { open = r; });
  void room.handleCmd(pid, { cmd: 'pickup', dropId: d.id }, 2);
  await settle();
  expect(p.save.inventory.some((i) => i.uid === ring.uid), 'подъём ждёт своей записи').toBe(false);
  p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: room.session.world.timeMs + 60_000, mag: 1e9, mag2: 0 };
  room.step(true);
  expect(p.alive, 'герой погиб, пока шла запись подъёма').toBe(false);
  expect(p.save.gold, 'штраф смерти взят').toBeLessThan(10_000);
  return { room, ws, pid, p, uid: ring.uid, charId, open };
}

describe('⭐ R20-07: смерть посреди записи подъёма — вещь не в сумке мёртвого, а на земле за ним', () => {
  it('запись легла после смерти — кольцо не в сумке (броска потери оно не миновало), лежит за героем; его запись без кольца метку снимает', async () => {
    const { room, ws, p, uid, charId, open } = await pickupThenDie();
    open();
    await settle();
    db.gate = null;
    expect(p.save.inventory.some((i) => i.uid === uid), 'в сумке мёртвого поднятого нет').toBe(false);
    const d = room.session.world.drops.find((x) => x.kind === 'item' && x.item?.uid === uid);
    expect(d, 'кольцо на земле').toBeTruthy();
    const res = ws.frames.filter((f): f is Extract<ServerFrame, { t: 'cmdResult' }> => f.t === 'cmdResult' && f.id === 2);
    expect(res.map((r) => r.ok), 'подъём отказан').toEqual([false]);
    await settle();
    expect(d!.heldBy, 'запись героя без кольца легла — метка снята').toBeUndefined();
    expect((db.data.get(charId) as SaveState).inventory.some((i) => i.uid === uid), 'строка героя кольца не несёт').toBe(false);
  });

  it('…и погиб, и ожил (вайп — город), пока запись шла, — кольцо тоже на земле: смерть с её штрафом была', async () => {
    const { room, p, uid, open } = await pickupThenDie();
    room.enterTown();   // вайп: город оживляет
    expect(p.alive, 'ожил в городе').toBe(true);
    open();
    await settle();
    db.gate = null;
    expect(p.save.inventory.some((i) => i.uid === uid), 'поднятое мимо штрафа в сумку не легло').toBe(false);
    expect(room.session.world.drops.some((x) => x.kind === 'item' && x.item?.uid === uid), 'кольцо на земле города').toBe(true);
  });
});
