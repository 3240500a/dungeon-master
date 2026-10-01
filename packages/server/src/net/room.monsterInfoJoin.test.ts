import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type AccountStash } from '@dm/shared';

vi.setConfig({ testTimeout: 20_000 });

/**
 * ⭐ ОПРЕДЕЛЕНИЯ МОНСТРОВ ВОШЕДШЕМУ НА ЖИВОЙ ЭТАЖ (общий кадр комнаты, `DM_AOI_RADIUS=0` — умолчание). Список знакомых монстров —
 * на комнату: новых рассылают всем один раз, и тех, кого комната знала до входа игрока, рассылка ему не присылала никогда. Вошедший
 * по коду, «Продолжить» и реконнект на этаже оставались без определений уже живущих монстров: веб их не рисовал вовсе (куклу монстра
 * он заводит только по `monsterInfo`), Unity — капсулами до конца этажа. Правило: перед ПЕРВЫМ (полным) кадром мира клиента —
 * `monsterInfo` со всеми, кого комната уже знает; дублей рассылки новых нет.
 *
 * Комната настоящая, база замокана (как `room.peerLook.test.ts`). Сокет пишет и двоичные кадры — меткой, ради порядка.
 */
vi.mock('../db/db.js', () => ({
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

type MonsterInfo = Extract<ServerFrame, { t: 'monsterInfo' }>;
class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  /** Всё по порядку: управляющие кадры — разобранными, кадр мира — меткой `bin`. */
  log: (ServerFrame | 'bin')[] = [];
  send(raw: string | Uint8Array): void { this.log.push(typeof raw === 'string' ? JSON.parse(raw) as ServerFrame : 'bin'); }
  close(): void { this.open = false; }
  onMessage(): void { /* комнату дёргают напрямую */ }
  onClose(): void { /* не проверяется */ }
  /** id монстров из всех `monsterInfo` до первого кадра мира (и до индекса `upTo`). */
  infoIds(upTo = this.log.indexOf('bin')): number[] {
    const end = upTo < 0 ? this.log.length : upTo;
    return this.log.slice(0, end).filter((f): f is MonsterInfo => f !== 'bin' && f.t === 'monsterInfo').flatMap((f) => f.monsters.map((m) => m.id));
  }
  allInfoIds(): number[] { return this.infoIds(this.log.length); }
}

const rooms: Room[] = [];
let seq = 0;
function join(room: Room, userId: string, save?: SaveState): { ws: FakeWs; pid: string; save: SaveState } {
  const ws = new FakeWs();
  const s = save ?? newCharacterSave(cfg, cfg.get('classes')[0]!.id, `Hero${++seq}`, `char-mi-${seq}`);
  const pid = room.addPlayer(ws as unknown as GameConn, userId, s, 1);
  return { ws, pid, save: s };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const liveIds = (room: Room): number[] =>
  (room as unknown as { session: { world: { monsters: { id: number }[] } } }).session.world.monsters.map((m) => m.id).sort((a, b) => a - b);
const sorted = (a: number[]): number[] => [...new Set(a)].sort((x, y) => x - y);

beforeAll(async () => {
  ({ Room: RoomCtor } = await import('./room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
afterEach(() => { for (const r of rooms) r.stop(); rooms.length = 0; });

describe('Room — monsterInfo вошедшему на живой этаж (общий кадр комнаты)', () => {
  it('⭐ вошедший по коду и вернувшийся реконнектом получают определения ВСЕХ живых монстров до своего первого кадра мира', async () => {
    const room = new RoomCtor('MINFO', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(room);
    const a = join(room, 'user-mi-a');
    await settle();
    room.descend(a.pid);   // соло: голосование проходит сразу
    await settle();
    room.step();
    const live = liveIds(room);
    expect(live.length, 'на этаже есть монстры').toBeGreaterThan(0);
    expect(sorted(a.ws.allInfoIds()), 'первый на этаже узнаёт всех рассылкой новых').toEqual(live);

    // Вошедший по коду: комната всех уже знает — рассылка новых ему пуста.
    const b = join(room, 'user-mi-b');
    await settle();
    const aBefore = a.ws.allInfoIds().length;
    room.step();
    expect(b.ws.log.includes('bin'), 'вошедшему ушёл кадр мира').toBe(true);
    expect(sorted(b.ws.infoIds()), 'до первого кадра мира — определения всех живых').toEqual(liveIds(room));
    expect(a.ws.allInfoIds().length, 'давно вошедшему дублей нет').toBe(aBefore);

    // Следующий тик: определения уже не повторяются.
    const bAfter = b.ws.allInfoIds().length;
    room.step();
    expect(b.ws.allInfoIds().length, 'повтора нет').toBe(bAfter);

    // Реконнект того же героя (вкладка закрылась и вернулась): новый сокет — снова все определения до кадра мира.
    await room.removePlayer(b.pid);
    const b2 = join(room, 'user-mi-b', b.save);
    await settle();
    room.step();
    expect(sorted(b2.ws.infoIds()), 'реконнект — определения всех живых до кадра мира').toEqual(liveIds(room));
  });

  it('смена этажа: знакомых нет — определения приходят рассылкой новых, без второго списка', async () => {
    const room = new RoomCtor('MINF2', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(room);
    const a = join(room, 'user-mi-c');
    await settle();
    room.descend(a.pid);
    await settle();
    room.step();
    const ids = a.ws.allInfoIds();
    expect(sorted(ids), 'каждый монстр — ровно один раз').toEqual(ids.slice().sort((x, y) => x - y));
    expect(ids.length).toBe(liveIds(room).length);
  });
});
