import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, itemFromBaseId, newCharacterSave, type ServerFrame, type SaveState } from '@dm/shared';
import { limits } from './rateLimit.js';

/**
 * ⚠ C-11 (бафф-зелья) — серверная половина: команда `useConsumable` настоящей `Room` пьёт зелье-бафф. Схема расходника принимает
 * `use.buffMods` + `buffDurationSec` (редактор их предлагает, подсказка обещает «Бафф на N сек»), а сервер их не применял: команда
 * отвечала «Нет эффекта» на зелье-бафф всегда, и оно лежало мёртвым грузом. Эффект — `session.drink` (тот же, что у пояса ввода),
 * база выпитого передаётся ему — её бафф и есть действие. Сокет — фейковый, база — маленькая честная (версии сейва).
 */
const db = vi.hoisted(() => ({ saves: new Map<string, number>() }));
vi.mock('../db/db.js', () => ({
  putCharacter: (charId: string, _u: string, _d: SaveState, v: number) => {
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve(null);
    db.saves.set(charId, v + 1);
    return Promise.resolve(v + 1);
  },
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Room = import('./room.js').Room;
let RoomCtor: typeof import('./room.js').Room;
beforeAll(async () => { ({ Room: RoomCtor } = await import('./room.js')); });
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
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    return this.frames.filter((f) => f.t === t).at(-1) as Extract<ServerFrame, { t: T }> | undefined;
  }
}

const WARD = 'test-ward-potion';   // только бафф: броня +100 на 30 с
type Live = { hp: number; skillBuffs: Record<string, number>; save: SaveState };

let seq = 0;
function room(): { room: Room; ws: FakeWs; pid: string; live: () => Live; armor: () => number } {
  const cfg = new ConfigRegistry();
  cfg.loadAll();
  const tpl = cfg.get('items.base').find((b) => b.id === 'healing-potion')!;
  cfg.reload({
    'items.base': [...cfg.get('items.base'), {
      ...structuredClone(tpl), id: WARD, name: WARD,
      use: { heal: 0, healPct: 0, mana: 0, manaPct: 0, cure: false, buffMods: [{ stat: 'armor', kind: 'flat', value: 100 }], buffDurationSec: 30 },
    }],
  });
  const charId = `char-potbuff-${++seq}`;
  const userId = `user-${charId}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(userId);
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, `P${seq}`, charId);
  s.belt = [itemFromBaseId(cfg.get('items.base'), WARD, undefined, 'shop')!];
  db.saves.set(charId, 1);
  const r = new RoomCtor(`POT${seq}`, cfg, { onEmpty() {}, onGrace() {}, onUngrace() {}, onFarewell() {} });
  rooms.push(r);
  const ws = new FakeWs();
  const pid = r.addPlayer(ws as unknown as GameConn, userId, s, 1);
  const session = (r as unknown as { session: { world: { players: Record<string, Live> }; snapshotOf(id: string): { derived: { armor: number } } | undefined } }).session;
  return { room: r, ws, pid, live: () => session.world.players[pid]!, armor: () => session.snapshotOf(pid)!.derived.armor };
}

describe('⚠ C-11 (бафф-зелья): команда `useConsumable` пьёт зелье-бафф', () => {
  it('⭐ полное здоровье, зелье только с баффом — выпито, бафф висит; повтор при полном баффе — «Нет эффекта», не тратится', async () => {
    const t = room();
    t.room.step(false);
    const armor0 = t.armor();
    const ward = t.live().save.belt[0]!;
    await t.room.handleCmd(t.pid, { cmd: 'useConsumable', uid: ward.uid }, 1);
    expect(t.ws.last('cmdResult'), 'было: «Нет эффекта» всегда').toMatchObject({ id: 1, ok: true });
    expect(t.live().save.belt[0] ?? null, 'выпито').toBeNull();
    t.room.step(false);
    expect(t.armor(), 'бафф на броне').toBeCloseTo(armor0 + 100, 9);

    const again = itemFromBaseId((t.room as unknown as { cfg: ConfigRegistry }).cfg.get('items.base'), WARD, undefined, 'shop')!;
    t.live().save.belt[0] = again;
    t.live().skillBuffs[`pot:${WARD}`] = 30;   // бафф полный
    await t.room.handleCmd(t.pid, { cmd: 'useConsumable', uid: again.uid }, 2);
    expect(t.ws.last('cmdResult')).toMatchObject({ id: 2, ok: false, reason: 'Нет эффекта' });
    expect(t.live().save.belt[0]?.uid, 'зелье цело').toBe(again.uid);
  });
});
