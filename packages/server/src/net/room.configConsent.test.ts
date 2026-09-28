import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, addToInventory, itemFromBaseId, newCharacterSave, shopSellPrice, withConfigRev, PRICE_CHANGED,
  type Item, type ServerFrame, type SaveState, type TownCommand,
} from '@dm/shared';
import { limits } from './rateLimit.js';

/**
 * ⭐ V-B3-07 (фаззер паритета «окно ≡ сервер», B3): СОГЛАСИЕ НА КОНФИГ через настоящую `Room`. Согласие держало только цену
 * (`maxGold`, `maxMaterials`, `minYield`): правка хозяина живьём, не менявшая цены (вилка броска базы, скидка требований,
 * «кузнец закрыт»), — и окно по старому конфигу обещало одно, а сервер делал другое или отказывал не ценой, и клиент конфиг не
 * перечитывал. Теперь команды кузницы, скупки и разбора несут `cfgRev` (ревизию конфига окна, `ConfigRegistry.revision`); у
 * комнаты другая — отказ «Цена изменилась» ДО исполнения (сейв цел, сейв вдогонку не шлётся — отказ ранний); та же — как раньше;
 * без поля (Unity) — как раньше. Сокет — фейковый, база — маленькая честная (версии сейва).
 */
const db = vi.hoisted(() => ({ saves: new Map<string, number>(), data: new Map<string, SaveState>() }));
vi.mock('../db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve(null);
    db.saves.set(charId, v + 1);
    db.data.set(charId, structuredClone(data));
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

let seq = 0;
/** Комната со своим (живым) конфигом сервера и героем в городе; `client` — реестр вкладки, прочитавшей тот же конфиг. */
function town(): { room: Room; cfg: ConfigRegistry; client: ConfigRegistry; ws: FakeWs; pid: string; save: () => SaveState; item: Item } {
  const cfg = new ConfigRegistry();
  cfg.loadAll();
  const client = new ConfigRegistry();
  client.loadAll();
  client.reload(JSON.parse(JSON.stringify(cfg.snapshot())) as Record<string, unknown>);   // `App.syncConfig`
  const charId = `char-cfgrev-${++seq}`;
  const userId = `user-${charId}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(userId);
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, `C${seq}`, charId);
  s.gold = 5_000;
  const item = itemFromBaseId(cfg.get('items.base'), 'long-sword', cfg.get('item-tiers'), 'drop')!;   // на продажу
  expect(addToInventory(s.inventory, item, cfg.get('balance').inventory)).toBe(true);
  db.saves.set(charId, 1);
  db.data.set(charId, structuredClone(s));
  const room = new RoomCtor(`CFG${seq}`, cfg, { onEmpty() {}, onGrace() {}, onUngrace() {}, onFarewell() {} });
  rooms.push(room);
  const ws = new FakeWs();
  const pid = room.addPlayer(ws as unknown as GameConn, userId, s, 1);
  const save = (): SaveState => (room as unknown as { session: { world: { players: Record<string, { save: SaveState }> } } }).session.world.players[pid]!.save;
  return { room, cfg, client, ws, pid, save, item };
}
/** Правка хозяина живьём, цены не тронуты: вилка броска базы оружия (урон скованной вещи уже другой). */
function editLive(cfg: ConfigRegistry): void {
  const b = structuredClone(cfg.get('balance'));
  b.loot.baseRoll.weapon = b.loot.baseRoll.weapon === 0.3 ? 0.05 : 0.3;
  cfg.reload({ balance: b });
}

describe('⭐ V-B3-07: согласие на конфиг — команды кузницы и скупки сверяют ревизию конфига окна', () => {
  it('конфиг окна = конфиг комнаты — команда исполняется, как раньше', async () => {
    const t = town();
    const item = t.item;
    const price = shopSellPrice(t.cfg, item);
    const gold0 = t.save().gold;
    await t.room.handleCmd(t.pid, withConfigRev(t.client, { cmd: 'sell', uid: item.uid, minGold: price }), 1);
    expect(t.ws.last('cmdResult')).toMatchObject({ ok: true });
    expect(t.save().gold).toBe(gold0 + price);
  });

  it('⭐ правка живьём, клиент не перечитал: отказ «Цена изменилась» ДО исполнения — сейв цел; перечитал — исполняется', async () => {
    const t = town();
    const item = t.item;
    const price = shopSellPrice(t.cfg, item);
    editLive(t.cfg);
    expect(shopSellPrice(t.cfg, item), 'цена та же — согласие на цену его бы не остановило').toBe(price);
    // Сейв без `vitals` (их комната ставит сама при рассылке сейва — к команде отношения не имеют).
    const body = (): string => { const { vitals: _v, ...rest } = t.save(); return JSON.stringify(rest); };
    const before = body();
    const saves0 = t.ws.frames.filter((f) => f.t === 'saveUpdate').length;
    await t.room.handleCmd(t.pid, withConfigRev(t.client, { cmd: 'sell', uid: item.uid, minGold: price }), 1);
    const r = t.ws.last('cmdResult')!;
    expect(r.ok).toBe(false);
    expect(r.reason?.startsWith(PRICE_CHANGED), `причина — «Цена изменилась», клиент по ней перечитает конфиг: «${r.reason}»`).toBe(true);
    expect(body(), 'отказ сейв не тронул').toBe(before);
    expect(t.ws.frames.filter((f) => f.t === 'saveUpdate').length, 'ранний отказ — без сейва вдогонку').toBe(saves0);
    t.client.reload(JSON.parse(JSON.stringify(t.cfg.snapshot())) as Record<string, unknown>);   // перечитал `/api/config`
    await t.room.handleCmd(t.pid, withConfigRev(t.client, { cmd: 'sell', uid: item.uid, minGold: price }), 2);
    expect(t.ws.last('cmdResult')).toMatchObject({ ok: true });
  });

  it('отказ не ценой (кузнец закрыт живьём) у устаревшего окна — тоже «Цена изменилась»: иначе окно так и горело бы', async () => {
    const t = town();
    const b = structuredClone(t.cfg.get('balance'));
    b.craft.live = false;
    t.cfg.reload({ balance: b });
    const item = t.item;
    const cmd: TownCommand = { cmd: 'forgeEnchant', uid: item.uid, rarity: 'magic', maxGold: 1_000_000 };
    await t.room.handleCmd(t.pid, withConfigRev(t.client, cmd), 1);
    expect(t.ws.last('cmdResult')?.reason?.startsWith(PRICE_CHANGED)).toBe(true);
    // Перечитавшему — честная причина конфига сервера.
    t.client.reload(JSON.parse(JSON.stringify(t.cfg.snapshot())) as Record<string, unknown>);
    await t.room.handleCmd(t.pid, withConfigRev(t.client, cmd), 2);
    expect(t.ws.last('cmdResult')?.reason?.startsWith(PRICE_CHANGED), 'согласие прошло — отказ уже по правилу').toBe(false);
    expect(t.ws.last('cmdResult')?.ok).toBe(false);
  });

  it('без `cfgRev` (Unity, старые вкладки) — как раньше; прочие команды его не несут', async () => {
    const t = town();
    editLive(t.cfg);
    const item = t.item;
    await t.room.handleCmd(t.pid, { cmd: 'sell', uid: item.uid }, 1);
    expect(t.ws.last('cmdResult')).toMatchObject({ ok: true });
    expect('cfgRev' in withConfigRev(t.client, { cmd: 'equip', uid: 'x' })).toBe(false);
    expect('cfgRev' in withConfigRev(t.client, { cmd: 'buy', uid: 'x', maxGold: 1 }), 'покупка: вещь и цену прислал сервер').toBe(false);
  });
});
