import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type SessionEvent } from '@dm/shared';
import { limits } from './rateLimit.js';

/**
 * ⭐ С-аудит (29.10): «никаких дыр — клиент рисует то, что шлёт сервер». Что комната рассылает и кому: личное героя — только ему,
 * сейв — без ссылки на поколение прилавка, печати — криптоисточником. База замокана (`db.ts` открывает пул при импорте).
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
  events(): SessionEvent[] { return this.frames.flatMap((f) => (f.t === 'events' ? f.events : [])); }
}
let seq = 0;
function join(room: Room, tag: string): { ws: FakeWs; pid: string; save: SaveState } {
  const user = `user-audit-${tag}-${++seq}`;
  limits.townCmd.reset(user); limits.forgeCmd.reset(user); limits.stashRead.reset(user);
  const ws = new FakeWs();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, tag, `char-audit-${seq}`);
  const pid = room.addPlayer(ws as unknown as GameConn, user, save, 1);
  return { ws, pid, save };
}
function newRoom(): Room {
  const r = new RoomCtor(`AUD${++seq}`, cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(r);
  return r;
}

describe('⭐ С-аудит F8: личное героя — только ему', () => {
  it('золото с итогом кошелька, опыт, сырьё, подбор, задание, откат — только своему; взмах соседа — без его отката', () => {
    const room = newRoom();
    const a = join(room, 'A'), b = join(room, 'B');
    a.ws.frames.length = 0; b.ws.frames.length = 0;
    const ev: SessionEvent[] = [
      { type: 'gold', playerId: a.pid, amount: 7, total: 1234 },
      { type: 'xp', playerId: a.pid, amount: 50 },
      { type: 'materials', playerId: a.pid, gains: { 'iron-1': 3 }, x: 1, y: 2 },
      { type: 'cooldown', playerId: a.pid, ability: 'x', cooldownMs: 900 },
      { type: 'quest', playerId: a.pid, kind: 'progress', questId: 'q', name: 'Задание' },
      { type: 'swing', playerId: a.pid, ability: 'attack', windupMs: 100, cooldownMs: 800, lockMs: 400, x: 0, y: 0, facing: 0 },
      { type: 'levelup', playerId: a.pid, level: 2 },
      { type: 'player-died', playerId: a.pid },
    ];
    (room as unknown as { broadcastEvents(e: SessionEvent[]): void }).broadcastEvents(ev);
    const mine = a.ws.events(), theirs = b.ws.events();
    expect(mine.map((e) => e.type), 'своему — всё, по порядку').toEqual(ev.map((e) => e.type));
    expect(mine.find((e) => e.type === 'swing')).toMatchObject({ cooldownMs: 800, lockMs: 400 });
    expect(theirs.map((e) => e.type), 'соседу — только общее').toEqual(['swing', 'levelup', 'player-died']);
    expect(theirs.find((e) => e.type === 'swing'), 'откат чужого взмаха соседу не виден').toMatchObject({ cooldownMs: 0, windupMs: 100 });
    expect(JSON.stringify(b.ws.frames), 'кошелёк соседа не утёк').not.toContain('1234');
  });

  it('событие только общего — одной строкой всем, как прежде', () => {
    const room = newRoom();
    const a = join(room, 'A'), b = join(room, 'B');
    a.ws.frames.length = 0; b.ws.frames.length = 0;
    (room as unknown as { broadcastEvents(e: SessionEvent[]): void }).broadcastEvents([{ type: 'stun', id: 3 }, { type: 'floor-cleared' }]);
    expect(a.ws.events()).toEqual(b.ws.events());
    expect(a.ws.events().map((e) => e.type)).toEqual(['stun', 'floor-cleared']);
  });
});

describe('⭐ С-аудит F12: сейв клиенту — без поколения прилавка', () => {
  it('`joined.save` и `saveUpdate` не несут `townStock` (в нём сид стока и доски заданий)', () => {
    const room = newRoom();
    const a = join(room, 'A');
    const joined = a.ws.frames.find((f): f is Extract<ServerFrame, { t: 'joined' }> => f.t === 'joined')!;
    expect(joined.save, 'кадр входа').not.toHaveProperty('townStock');
    expect((room as unknown as { session: { world: { players: Record<string, { save: SaveState }> } } }).session.world.players[a.pid]!.save.townStock,
      'у сервера поколение прилавка есть').toBeTruthy();
    for (const f of a.ws.frames) if (f.t === 'saveUpdate') expect(f.save).not.toHaveProperty('townStock');
  });
});

describe('⭐ С-аудит F3: печати комнаты — криптоисточником', () => {
  it('у сессии комнаты свой источник печатей, и вход на этаж его не перезаводит', () => {
    const room = newRoom();
    join(room, 'A');
    const s = (room as unknown as { session: { sealRng: unknown; sealSource?: unknown } }).session;
    expect(s.sealSource, 'источник печатей дан сервером').toBeTruthy();
    expect(s.sealRng, 'поток печатей — он').toBe(s.sealSource);
  });
});
