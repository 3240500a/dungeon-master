import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, heroNumbers, type ServerFrame, type SaveState } from '@dm/shared';
import { limits } from './rateLimit.js';

/**
 * ⭐ С2 (29.10): ЛИСТ ГЕРОЯ — ОТ СЕРВЕРА. Кадр `hero` (статы, блок мастера, строка HUD, опыт) уходит сам — на входе и при смене сейва, аур и
 * области, тем же текстом не повторяется; лист персонажа и древо — видом `hero` по запросу (`view`), набранные очки — проверкой сервера.
 */
vi.mock('../db/db.js', () => ({
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  putCharacter: (_c: string, _u: string, _d: SaveState, v: number) => Promise.resolve(v + 1),
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: () => Promise.resolve(null),
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
const rooms: Room[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); });

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void { /* комнату дёргают напрямую */ }
  onClose(): void { /* не проверяется */ }
  all<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }>[] { return this.frames.filter((f): f is Extract<ServerFrame, { t: T }> => f.t === t); }
}
let seq = 0;
function setup(): { room: Room; ws: FakeWs; pid: string; save: SaveState } {
  const user = `user-views-${++seq}`;
  limits.viewReq.reset(user); limits.townCmd.reset(user);
  const room = new RoomCtor(`VW${seq}`, cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(room);
  const ws = new FakeWs();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Герой', `char-views-${seq}`);
  const pid = room.addPlayer(ws as unknown as GameConn, user, save, 1);
  return { room, ws, pid, save };
}

describe('⭐ С2: лист героя — от сервера', () => {
  it('кадр `hero` на входе: статы — как у сервера (`heroNumbers`), блок мастера, строка HUD, опыт; повтора тем же текстом нет', () => {
    const { room, ws, pid, save } = setup();
    const heroes = ws.all('hero');
    expect(heroes.length, 'на входе — один').toBe(1);
    const v = heroes[0]!.view as { numbers: unknown; master: string; hudInfo: string; xp: { frac: number } };
    expect(v.numbers).toEqual(JSON.parse(JSON.stringify(heroNumbers(cfg, save, []))));
    expect(v.master.length).toBeGreaterThan(0);
    expect(v.hudInfo).toContain('Ур.');
    expect(v.xp.frac).toBeGreaterThanOrEqual(0);
    (room as unknown as { sendSave(id: string): void }).sendSave(pid);
    expect(ws.all('hero').length, 'сейв тот же — лист тот же, второй раз не шлётся').toBe(1);
    save.attributes.strength += 5;
    (room as unknown as { sendSave(id: string): void }).sendSave(pid);
    expect(ws.all('hero').length, 'сила выросла — новый лист').toBe(2);
  });

  it('вид `hero`: лист персонажа (с набранными очками), древо скилов; кривой и лишний запрос — отказ', () => {
    const { room, ws, pid, save } = setup();
    save.unspentAttributePoints = 3;
    const ask = (id: number, args: Record<string, unknown>): Extract<ServerFrame, { t: 'view' }> => {
      room.viewRequest(pid, id, 'hero', args);
      return ws.all('view').find((f) => f.id === id)!;
    };
    const sheet = ask(1, { part: 'sheet' });
    expect(sheet.ok).toBe(true);
    const blocks = (sheet.view as { blocks: { rows: { cells: string[] }[] }[] }).blocks;
    expect(blocks.length).toBeGreaterThan(3);
    const staged = ask(2, { part: 'sheet', pending: { strength: 2 } });
    expect(staged.ok).toBe(true);
    expect(JSON.stringify(staged.view), 'превью набранного — «+Δ»').toMatch(/\+\d/);
    expect(ask(3, { part: 'sheet', pending: { strength: 4 } }), 'больше свободных очков').toMatchObject({ ok: false, reason: 'Столько свободных очков нет' });
    expect(ask(4, { part: 'sheet', pending: { luck: 1 } }).ok, 'нет такого атрибута').toBe(false);
    expect(ask(5, { part: 'sheet', pending: { strength: -1 } }).ok, 'минус').toBe(false);
    expect(ask(6, { part: 'sheet', pending: { strength: 1.5 } }).ok, 'дробь').toBe(false);
    const tree = ask(7, { part: 'tree' });
    expect(tree.ok).toBe(true);
    expect((tree.view as { nodes: unknown[] }).nodes.length).toBeGreaterThan(10);
    expect(ask(8, { part: 'x' }).ok).toBe(false);
  });
});
