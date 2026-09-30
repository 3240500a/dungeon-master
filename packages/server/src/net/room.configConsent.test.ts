import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, addToInventory, itemFromBaseId, newCharacterSave, shopSellPrice, withConfigRev, upgradedItem, upgradeCost, forgeGold,
  emptyStash, fullJournal, keySlotOf, keyVariantsByBase, variantsFor, CRAFT_SLOT_LIST,
  PRICE_CHANGED, type CraftParts, type Item, type ServerFrame, type SaveState, type TownCommand,
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
const db = vi.hoisted(() => ({
  saves: new Map<string, number>(), data: new Map<string, SaveState>(),
  /** ⭐ R22-03: сундук аккаунта (с сырьём) и удержание его чтения — окно, в которое ложится правка хозяина живьём. */
  stash: null as unknown, hold: null as Promise<void> | null, reading: 0,
}));
vi.mock('../db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve(null);
    db.saves.set(charId, v + 1);
    db.data.set(charId, structuredClone(data));
    return Promise.resolve(v + 1);
  },
  putCharacterWithStash: (charId: string, _u: string, data: SaveState, v: number, _st: unknown, sv: number) => {
    if (db.stash === null) return Promise.resolve({ ok: false, conflict: 'stash' });
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve({ ok: false, conflict: 'save' });
    db.saves.set(charId, v + 1);
    db.data.set(charId, structuredClone(data));
    return Promise.resolve({ ok: true, version: v + 1, stashVersion: sv + 1 });
  },
  getCharacter: () => Promise.resolve(null),
  getAccountStash: async () => {
    db.reading++;
    if (db.hold) await db.hold;
    return db.stash === null ? null : { data: structuredClone(db.stash), version: 1 };
  },
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

/**
 * ⭐ R22-03: СОГЛАСИЕ — ТАМ, ГДЕ ДЕЙСТВИЕ ИСПОЛНЯЕТСЯ. Ревизия конфига и сборки (и «кузнец куёт» у ковки и зачарования) сверялись ОДИН раз, до
 * очереди записей героя; дальше команда ждала очередь (автосейв, запись подъёма с кругами свода) и чтение сундука из базы, а правка хозяина
 * живьём (редактор, сверка конфига ноды раз в 3 с) правит тот же реестр на месте. Действие исполнялось по НОВОМУ конфигу: цена та же —
 * согласие на цену проходило, а игрок платил показанное за другую вещь (требования, статы, детали ковки) или ковал при закрытом кузнеце.
 */
describe('⭐ R22-03: согласие на конфиг — и после ожидания очереди и базы, перед самим действием', () => {
  afterEach(() => { db.stash = null; db.hold = null; db.reading = 0; });
  const body = (t: ReturnType<typeof town>): string => { const { vitals: _v, ...rest } = t.save(); return JSON.stringify(rest); };
  /** Удержать чтение сундука, дождаться, пока команда в него упрётся, — `edit` ложится в это окно, затем отпустить. */
  async function inWindow(t: ReturnType<typeof town>, cmd: TownCommand, edit: () => void): Promise<void> {
    let release!: () => void;
    db.hold = new Promise<void>((r) => { release = r; });
    const was = db.reading;
    const done = t.room.handleCmd(t.pid, cmd, 1);
    for (let i = 0; i < 200 && db.reading === was; i++) await new Promise((r) => setImmediate(r));
    expect(db.reading, 'команда дошла до чтения сундука').toBeGreaterThan(was);
    edit();
    db.hold = null;
    release();
    await done;
  }
  const wallet = (cfg: ConfigRegistry): Record<string, number> => Object.fromEntries(cfg.get('craft-materials').map((m) => [m.id, 99_999]));

  it('улучшение: скидка требований сменилась живьём в окне (цена та же) — «Цена изменилась», сейв цел, без сейва вдогонку', async () => {
    const t = town();
    db.stash = { version: 1, tabs: [], materials: wallet(t.cfg) };
    const shown = upgradedItem(t.client, t.item)!;
    const cmd = withConfigRev(t.client, { cmd: 'forgeUpgrade', uid: t.item.uid, maxGold: forgeGold(t.client, t.item, 'upgrade'), maxMaterials: upgradeCost(t.client, t.item) });
    const before = body(t);
    const saves0 = t.ws.frames.filter((f) => f.t === 'saveUpdate').length;
    await inWindow(t, cmd, () => {
      const b = structuredClone(t.cfg.get('balance'));
      b.forgePrices.upgradeReqDiscount = b.forgePrices.upgradeReqDiscount === 0 ? 0.2 : 0;
      t.cfg.reload({ balance: b });
      expect(forgeGold(t.cfg, t.item, 'upgrade'), 'цена та же — согласие на цену его бы не остановило').toBe(forgeGold(t.client, t.item, 'upgrade'));
      expect(upgradedItem(t.cfg, t.item)!.requirements, 'а вещь другая').not.toEqual(shown.requirements);
    });
    const r = t.ws.last('cmdResult')!;
    expect(r.ok, `было — ok, требования ${JSON.stringify(upgradedItem(t.cfg, t.item)?.requirements)} вместо показанных ${JSON.stringify(shown.requirements)}`).toBe(false);
    expect(r.reason?.startsWith(PRICE_CHANGED), `«${r.reason}»`).toBe(true);
    expect(body(t), 'сейв цел').toBe(before);
    expect(t.ws.frames.filter((f) => f.t === 'saveUpdate').length, 'отказ до действия — без сейва вдогонку').toBe(saves0);
  });

  /** Ковка меча ступени 4 (как `priceConsent.test.ts`): всё сырьё включено, журнал кузнеца открыт, в сундуке сырья вдоволь. */
  function forge(t: ReturnType<typeof town>): TownCommand {
    const d = structuredClone(t.cfg.snapshot()) as unknown as { 'craft-materials': { enabled: boolean }[] };
    for (const m of d['craft-materials']) m.enabled = true;
    t.cfg.reload({ 'craft-materials': d['craft-materials'] } as never);
    db.stash = { ...emptyStash(t.cfg), materials: wallet(t.cfg), forgeJournal: fullJournal(t.cfg) };
    const keySlot = keySlotOf(t.cfg, 'sword');
    const group = keyVariantsByBase(t.cfg, 'sword', 1).find((g) => g.variants.some((v) => v.stepMin <= 4 && 4 <= v.stepMax))!;
    const parts = {} as CraftParts;
    for (const slot of CRAFT_SLOT_LIST) {
      const pool = slot === keySlot ? group.variants : variantsFor(t.cfg, 'sword', slot, 1);
      const v = pool.find((x) => x.stepMin <= 4 && 4 <= x.stepMax)!;
      parts[slot] = { id: v.id, step: 4 };
    }
    return { cmd: 'craft', nonce: `r22-craft-${++seq}`, input: { weaponClass: 'sword', hands: 1, parts } };
  }

  it('ковка без `cfgRev` (Unity): кузнец закрыт живьём в окне — «Кузнец ещё не куёт», ничего не сковано; контроль без правки — куётся', async () => {
    const ctl = town();
    await inWindow(ctl, forge(ctl), () => undefined);
    expect(ctl.ws.last('cmdResult'), 'контроль: без правки ковка идёт').toMatchObject({ ok: true });
    const t = town();
    const cmd = forge(t);
    const before = body(t);
    await inWindow(t, cmd, () => {
      const b = structuredClone(t.cfg.get('balance'));
      b.craft.live = false;
      t.cfg.reload({ balance: b });
    });
    const r = t.ws.last('cmdResult')!;
    expect(r.ok, 'было — сковано при закрытом кузнеце').toBe(false);
    expect(r.reason).toBe('Кузнец ещё не куёт');
    expect(body(t), 'ни золота, ни вещи').toBe(before);
  });

  it('контроль: правки в окне нет — улучшение проходит, как раньше', async () => {
    const t = town();
    db.stash = { version: 1, tabs: [], materials: wallet(t.cfg) };
    const cmd = withConfigRev(t.client, { cmd: 'forgeUpgrade', uid: t.item.uid, maxGold: forgeGold(t.client, t.item, 'upgrade'), maxMaterials: upgradeCost(t.client, t.item) });
    await inWindow(t, cmd, () => undefined);
    expect(t.ws.last('cmdResult')).toMatchObject({ ok: true });
  });
});
