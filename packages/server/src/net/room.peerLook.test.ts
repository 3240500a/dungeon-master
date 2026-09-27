import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, craftWeapon, defaultParts, createRng, CRAFT_SLOT_LIST,
  type ServerFrame, type SaveState, type Item, type AccountStash, type PeerInfo,
} from '@dm/shared';

/**
 * ⭐ ДРУГИЕ ИГРОКИ ВИДЯТ СКОВАННОЕ (D22, К6) — серверная половина, настоящая `Room` с фейковыми сокетами.
 * Игрок надевает скованный меч → второй игрок получает кадр `peerInfo` с его видом: база и четыре детали
 * — и ни одного другого поля предмета (ни uid, ни статов, ни аффиксов). Новый вошедший видит то же в
 * `joined.peers`. Снял — вида нет.
 *
 * База замокана, как в `room.run.test.ts`: комнате нужны только записи сейва и сундука.
 */
vi.mock('../db/db.js', () => ({
  // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  putCharacter: (_c: string, _u: string, _d: SaveState, v: number) => Promise.resolve(v + 1),
  putCharacterWithStash: (_c: string, _u: string, _d: SaveState, v: number, _s: AccountStash, sv: number) =>
    Promise.resolve({ ok: true, version: v + 1, stashVersion: sv + 1 }),
  createCharacter: () => Promise.resolve(1),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
type Room = import('./room.js').Room;
let RoomCtor: typeof import('./room.js').Room;
let cfg: ConfigRegistry;

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  raw: string[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') { this.raw.push(raw); this.frames.push(JSON.parse(raw) as ServerFrame); } }
  close(): void { this.open = false; }
  onMessage(): void { /* комнату дёргают напрямую */ }
  onClose(): void { /* не проверяется */ }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) { const f = this.frames[i]!; if (f.t === t) return f as Extract<ServerFrame, { t: T }>; }
    return undefined;
  }
}

const rooms: Room[] = [];
let seq = 0;
function join(room: Room, userId: string): { ws: FakeWs; pid: string; save: SaveState } {
  const ws = new FakeWs();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, `Hero${++seq}`, `char-look-${seq}`);
  // Требования меча не должны мешать проверке вида.
  save.level = 60;
  for (const k of Object.keys(save.attributes) as (keyof SaveState['attributes'])[]) save.attributes[k] = 500;
  const pid = room.addPlayer(ws as unknown as GameConn, userId, save, 1);
  return { ws, pid, save };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
function forgedInBag(save: SaveState): Item {
  const parts = defaultParts(cfg, 'sword', 1, 2)!;
  const pv = craftWeapon(cfg, { weaponClass: 'sword', hands: 1, parts }, { rng: createRng(5) });
  expect(pv.ok, pv.reason).toBe(true);
  const it = { ...pv.item!, pos: { x: 0, y: 0 } };
  save.inventory.push(it);
  return it;
}
const peerOf = (frame: { peers: PeerInfo[] } | undefined, pid: string): PeerInfo | undefined => frame?.peers.find((p) => p.id === pid);

beforeAll(async () => {
  ({ Room: RoomCtor } = await import('./room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
afterEach(() => { for (const r of rooms) r.stop(); rooms.length = 0; });

describe('Room — вид оружия из деталей в статике игрока (D22)', () => {
  it('⭐ надел скованный меч — второй игрок видит базу и детали; ничего больше из вещи в кадр не уходит', async () => {
    const room = new RoomCtor('LOOK', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(room);
    const a = join(room, 'user-a');
    const b = join(room, 'user-b');
    await settle();
    // Меч ложится в сумку уже ПОСЛЕ входа: сейв на сервере — тот же объект (addPlayer не копирует).
    const sword = forgedInBag(a.save);

    await room.handleCmd(a.pid, { cmd: 'equip', uid: sword.uid }, 1);
    expect(a.ws.last('cmdResult')).toMatchObject({ cmd: 'equip', ok: true });
    const seen = peerOf(b.ws.last('peerInfo'), a.pid);
    expect(seen?.weaponKey).toBe('sword');
    expect(seen?.weaponLook).toEqual({
      main: { baseId: sword.baseId, parts: Object.fromEntries(CRAFT_SLOT_LIST.map((s) => [s, { id: sword.parts![s].id, step: sword.parts![s].step }])) },
    });
    // Сырой кадр — чёрный ящик: uid, статы и аффиксы вещи игрока наружу не уходят.
    const rawInfo = b.ws.raw.filter((r) => r.includes('"peerInfo"')).at(-1)!;
    for (const leak of [sword.uid, '"affixes"', '"baseStats"', '"baseRoll"', '"origin"']) expect(rawInfo).not.toContain(leak);

    // Новый игрок видит меч уже во входном кадре.
    const c = join(room, 'user-c');
    const joined = c.ws.last('joined');
    expect(peerOf(joined, a.pid)?.weaponLook?.main?.baseId).toBe(sword.baseId);
    expect(c.pid).toBeTruthy();

    // Снял — вида нет (и ключа нет: кукла вернётся к классу-дефолту).
    await room.handleCmd(a.pid, { cmd: 'unequip', slot: 'weapon' }, 2);
    const after = peerOf(b.ws.last('peerInfo'), a.pid);
    expect(after).toBeTruthy();
    expect(after).not.toHaveProperty('weaponLook');
  });

  it('⭐ R2-03: вошедший позже сразу получает кадр статики тех, кто уже в комнате, — без единой команды', async () => {
    const room = new RoomCtor('LATE', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(room);
    const a = join(room, 'user-late-a');
    await settle();
    const b = join(room, 'user-late-b');
    await settle();
    // Клиент заполняет статику игроков ТОЛЬКО из `peerInfo`/`peerJoined`: без кадра A для B — безымянный «воин».
    const seen = b.ws.frames.flatMap((f) => (f.t === 'peerInfo' ? f.peers : f.t === 'peerJoined' ? [f.peer] : []));
    expect(seen.find((p) => p.id === a.pid), 'статика A дошла до B').toMatchObject({ id: a.pid, classId: a.save.classId, name: a.save.name });
    expect(seen.find((p) => p.id === b.pid), 'и своя — тоже').toBeTruthy();
  });
});
