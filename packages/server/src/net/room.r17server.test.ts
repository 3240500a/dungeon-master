import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, type Item, type ServerFrame, type SaveState } from '@dm/shared';

/**
 * ⭐ РАУНД 17 (сервер), комната. Комната настоящая; база — маленькая честная (версии сейва), без часов.
 *  • R17-04: прилавок в кадре — по тому же правилу, что продажа. База выключена живьём (редактор), пока прилавок стоит: зелье раньше
 *    оставалось в кадре после ЛЮБОЙ другой покупки (`showShop` фильтровал только снаряжение, R14-09), а вошедший по коду без перекатки
 *    получал закэшированный прилавок — с выключенным зельем и снаряжением. Клиент горел ценником «по карману», а сервер отказывал «нет в
 *    ассортименте» (фаззер «окно ≡ сервер», `parity:enabled-refused:buy:rule`). Теперь кадр собирается в миг отправки — зелья по
 *    `shopConsumableIds`, снаряжение по `gearOn`, и ценник — по тому же списку.
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

type RoomIn = {
  area: string;
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
  stop(): void;
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
/** Комната на своём реестре конфига (правка живьём — `reload`); тик — только шагами теста. */
function newRoom(reg: ConfigRegistry): RoomIn {
  const room = new RoomCtor(`R17R${++seq}`, reg, hooks);
  rooms.push(room);
  room.stop();
  return room;
}
function hero(): SaveState {
  const charId = `char-r17r-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  s.level = 30; s.gold = 10_000_000;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const liveReg = (): ConfigRegistry => { const reg = new ConfigRegistry(); reg.loadAll(); return reg; };
/** Правка редактора живьём: база `id` выключена (`on` — включена снова). */
function toggle(reg: ConfigRegistry, id: string, on: boolean): void {
  reg.reload({ 'items.base': structuredClone(reg.get('items.base')).map((b) => (b.id === id ? { ...b, enabled: on } : b)) } as never);
}
type Shelf = { items: Item[]; prices: Record<string, number> };
const shelf = (ws: FakeWs): Shelf => ws.last('shop') as unknown as Shelf;
/** Кадр прилавка без базы `id` — ни вещи, ни ценника. */
function lacks(f: Shelf, id: string, why: string): void {
  const uids = new Set(f.items.filter((i) => i.baseId === id).map((i) => i.uid));
  expect(uids.size, `${why}: вещей выключенной базы «${id}» на прилавке нет`).toBe(0);
  expect(Object.keys(f.prices).filter((u) => !f.items.some((i) => i.uid === u)), `${why}: ценник — только у выставленного`).toEqual([]);
}
const gearOf = (f: Shelf): Item | undefined => f.items.find((i) => i.kind === 'weapon' || i.kind === 'armor');

describe('⭐ R17-04: прилавок в кадре — по тому же правилу, что продажа (база выключена живьём)', () => {
  it('зелье выключили, пока прилавок стоит, — после покупки ДРУГОГО зелья его нет в кадре (раньше оставалось до отказа покупки)', async () => {
    const reg = liveReg();
    const room = newRoom(reg);
    const ws = new FakeWs();
    const pid = room.addPlayer(ws, 'user-r17a', hero(), 1);
    await settle();
    expect(shelf(ws).items.some((i) => i.baseId === 'antidote'), 'контроль: противоядие на прилавке').toBe(true);
    toggle(reg, 'antidote', false);
    const mana = shelf(ws).items.find((i) => i.baseId === 'mana-potion')!;
    await room.handleCmd(pid, { cmd: 'buy', uid: mana.uid, maxGold: 10_000_000 }, 1);
    expect(ws.last('cmdResult'), 'зелье маны куплено').toMatchObject({ ok: true });
    lacks(shelf(ws), 'antidote', 'кадр после покупки');
    expect(shelf(ws).items.some((i) => i.baseId === 'mana-potion'), 'остальные зелья — на месте').toBe(true);
  });

  it('снаряжение выключили, пока прилавок стоит, — вошедший по коду (без перекатки) получает прилавок без него', async () => {
    const reg = liveReg();
    const room = newRoom(reg);
    const wsA = new FakeWs();
    room.addPlayer(wsA, 'user-r17b', hero(), 1);
    await settle();
    const gear = gearOf(shelf(wsA));
    expect(gear, 'на прилавке есть снаряжение').toBeTruthy();
    toggle(reg, gear!.baseId, false);
    const wsB = new FakeWs();
    room.addPlayer(wsB, 'user-r17c', hero(), 1);
    await settle();
    lacks(shelf(wsB), gear!.baseId, 'кадр входа');
    // R14-09: включили обратно до срока — вещь снова на прилавке, как была (сток её не забыл).
    toggle(reg, gear!.baseId, true);
    const wsC = new FakeWs();
    room.addPlayer(wsC, 'user-r17d', hero(), 1);
    await settle();
    expect(shelf(wsC).items.some((i) => i.uid === gear!.uid), 'включили — снова на прилавке').toBe(true);
    expect(shelf(wsC).prices[gear!.uid], 'и с ценником').toBeGreaterThan(0);
  });

  it('зелье выключили, пока прилавок стоит, — вошедший по коду получает прилавок без него', async () => {
    const reg = liveReg();
    const room = newRoom(reg);
    room.addPlayer(new FakeWs(), 'user-r17e', hero(), 1);
    await settle();
    toggle(reg, 'mana-potion', false);
    const wsB = new FakeWs();
    room.addPlayer(wsB, 'user-r17f', hero(), 1);
    await settle();
    lacks(shelf(wsB), 'mana-potion', 'кадр входа');
    expect(shelf(wsB).items.filter((i) => i.baseId === 'healing-potion').length, 'остальные зелья — на месте').toBe(5);
  });
});
