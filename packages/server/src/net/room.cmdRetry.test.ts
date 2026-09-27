import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, generateItem, createRng, forgeGold, type ServerFrame, type SaveState, type Item } from '@dm/shared';

// Тесты файла ждут комнату оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый такой оборот — шаг системного
// таймера (~15,6 мс): тест идёт 0,3–3 с и без нагрузки. Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот
// потолок не прячет — они падают утверждением, а не временем.
vi.setConfig({ testTimeout: 20_000 });

/**
 * ⭐ R4-23: ПОВТОР КОМАНДЫ ТЕМ ЖЕ НОМЕРОМ, ПОКА ПЕРВАЯ ЕЩЁ В ОЧЕРЕДИ. Клиент ждёт ответа 8 с, а сервер при медленной базе
 * держит команду дольше: она стоит в очереди записей игрока за автосейвом. Верстак кузницы после «нет ответа» шлёт
 * повтор ТЕМ ЖЕ номером (`client/modules/town/forgeBench.ts`) — здесь проверено, что сервер это понимает так, как
 * обещано игроку: кадры соединения идут по очереди, повтор ждёт первую и отвечает её ИТОГОМ, не исполняясь второй раз
 * (дедуп по номеру, Ф2.5). Раньше повтор уходил новым номером — две перекатки за двойную цену.
 *
 * База замокана как в `roomManager.test.ts`: версии сейва и сундука честные, `gate` держит записи в полёте.
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number }>(),
  stash: { data: null as unknown, version: 0 },
  gate: null as Promise<void> | null,
}));
vi.mock('../db/db.js', () => ({
  // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  getSession: async () => 'user-r423',
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r423', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data);
    if (db.gate) await db.gate;
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return null;
    r.version = v + 1; r.data = snap;
    return r.version;
  },
  putCharacterWithStash: async (charId: string, _u: string, data: unknown, v: number, stash: unknown, sv: number) => {
    const snap = structuredClone(data), st = structuredClone(stash);
    if (db.gate) await db.gate;
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return { ok: false, conflict: 'save' };
    if (sv !== db.stash.version) return { ok: false, conflict: 'stash' };
    r.version = v + 1; r.data = snap;
    db.stash = { data: st, version: sv + 1 };
    return { ok: true, version: r.version, stashVersion: db.stash.version };
  },
  getAccountStash: () => Promise.resolve(db.stash.version ? { data: structuredClone(db.stash.data), version: db.stash.version } : null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

const TOK = 'ab'.repeat(32);
class FakeConn implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { if (!this.open) return; this.open = false; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(JSON.stringify(frame)); }
  all<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }>[] { return this.frames.filter((f) => f.t === t) as Extract<ServerFrame, { t: T }>[]; }
}
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

interface RoomLike { area: string; stop(): void; persist(pid: string): Promise<unknown>; session: { world: { players: Record<string, { save: SaveState }> } } }
let rm: { rooms: Map<string, RoomLike>; handleConnection(c: GameConn): void };
let cfg: ConfigRegistry;
beforeAll(async () => {
  const { RoomManager } = await import('./roomManager.js');
  cfg = new ConfigRegistry();
  cfg.loadAll();
  rm = new RoomManager(cfg) as unknown as typeof rm;
});
afterAll(() => { for (const r of rm.rooms.values()) r.stop(); });

describe('⭐ R4-23: повтор команды тем же номером за медленной записью', () => {
  it('⭐ перекатка стоит за автосейвом; повтор ТЕМ ЖЕ номером — одна перекатка, одна цена, оба ответа — итог первой', async () => {
    const charId = 'r423-retry';
    const sword = {
      ...generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'),
        { dropBias: 1, itemLevel: 30, baseId: 'long-sword', tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'magic', origin: 'drop' }, createRng(11)),
      pos: { x: 0, y: 0 },
    } as Item;
    const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'R', charId) as SaveState;
    save.gold = 10_000;
    save.inventory.push(sword);
    db.chars.set(charId, { data: save, version: 1 });

    const ws = new FakeConn();
    rm.handleConnection(ws);
    ws.push({ t: 'join', token: TOK, charId, fresh: true });
    await settle();
    expect(ws.all('joined'), JSON.stringify(ws.all('error'))).toHaveLength(1);
    await settle();

    let room: RoomLike | undefined; let pid = '';
    for (const r of rm.rooms.values()) for (const [id, p] of Object.entries(r.session.world.players)) if (p.save.charId === charId) { room = r; pid = id; }
    expect(room?.area).toBe('town');
    const me = (): SaveState => room!.session.world.players[pid]!.save;
    const live = (): Item => me().inventory.find((i) => i.uid === sword.uid)!;
    const gold0 = me().gold;
    const cost = forgeGold(cfg, live(), 'reroll');

    // База медленная: автосейв игрока в полёте — команда встаёт в очередь записей за ним.
    let open!: () => void;
    db.gate = new Promise<void>((r) => { open = r; });
    void room!.persist(pid);
    await settle();
    ws.frames.length = 0;
    ws.push({ t: 'cmd', command: { cmd: 'forgeReroll', uid: sword.uid }, id: 101 });
    await settle();
    expect(ws.all('cmdResult'), 'первая ещё ждёт базу — клиент через 8 с скажет «нет ответа»').toHaveLength(0);
    // Повтор с верстака — ТЕМ ЖЕ номером.
    ws.push({ t: 'cmd', command: { cmd: 'forgeReroll', uid: sword.uid }, id: 101 });
    await settle();

    db.gate = null; open();
    await settle(30);
    const results = ws.all('cmdResult');
    expect(results.map((r) => [r.id, r.ok])).toEqual([[101, true], [101, true]]);
    expect(live().rerolls, 'перекатка одна').toBe(1);
    expect(me().gold, 'цена одна').toBe(gold0 - cost);
    ws.close();
    await settle();
  });
});

describe('⭐ R5-15: сервер не берёт больше цены, которую видел игрок', () => {
  it('перекатка с `maxGold` ниже цены сервера — отказ «Цена изменилась: N золота» до траты; с ценой сервера — перекатка', async () => {
    const charId = 'r515-price';
    const sword = {
      ...generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'),
        { dropBias: 1, itemLevel: 30, baseId: 'long-sword', tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'magic', origin: 'drop' }, createRng(12)),
      pos: { x: 0, y: 0 },
    } as Item;
    const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'P', charId) as SaveState;
    save.gold = 10_000;
    save.inventory.push(sword);
    db.chars.set(charId, { data: save, version: 1 });
    const ws = new FakeConn();
    rm.handleConnection(ws);
    ws.push({ t: 'join', token: TOK, charId, fresh: true });
    await settle();
    expect(ws.all('joined'), JSON.stringify(ws.all('error'))).toHaveLength(1);
    let room: RoomLike | undefined; let pid = '';
    for (const r of rm.rooms.values()) for (const [id, p] of Object.entries(r.session.world.players)) if (p.save.charId === charId) { room = r; pid = id; }
    const me = (): SaveState => room!.session.world.players[pid]!.save;
    const live = (): Item => me().inventory.find((i) => i.uid === sword.uid)!;
    const cost = forgeGold(cfg, live(), 'reroll');
    const before = JSON.stringify(me());
    ws.frames.length = 0;
    ws.push({ t: 'cmd', command: { cmd: 'forgeReroll', uid: sword.uid, maxGold: cost - 1 }, id: 201 });   // конфиг клиента устарел
    await settle(20);
    expect(ws.all('cmdResult').map((r) => [r.id, r.ok, r.reason])).toEqual([[201, false, `Цена изменилась: ${cost} золота`]]);
    expect(JSON.stringify(me()), 'было: сервер молча брал свою цену').toBe(before);
    ws.push({ t: 'cmd', command: { cmd: 'forgeReroll', uid: sword.uid, maxGold: cost }, id: 202 });
    await settle(20);
    expect(ws.all('cmdResult').at(-1)).toMatchObject({ id: 202, ok: true });
    expect(live().rerolls).toBe(1);
    expect(me().gold).toBe(10_000 - cost);
    ws.close();
    await settle();
  });
});

/**
 * ⭐ R6-24: ПОВТОР ТЕМ ЖЕ НОМЕРОМ ПОСЛЕ ПАЧКИ ДРУГИХ КОМАНД. Окно номеров было 64, а за перекаткой, стоящей за медленной
 * записью, в очереди соединения могли ждать сколько угодно команд (потолок команд города — всплеск 120): 64 перекладывания
 * вещей вытесняли номер перекатки, и повтор с верстака (тот же номер: вещь на клиенте не изменилась) исполнялся заново.
 */
describe('⭐ R6-24: повтор тем же номером за пачкой других команд', () => {
  it('перекатка за автосейвом, за ней 64 перекладывания, повтор тем же номером — одна перекатка, одна цена', async () => {
    const { limits } = await import('./rateLimit.js');
    limits.townCmd.reset('user-r423'); limits.forgeCmd.reset('user-r423'); limits.cmdResync.reset('user-r423');
    const charId = 'r624-retry';
    const sword = {
      ...generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'),
        { dropBias: 1, itemLevel: 30, baseId: 'long-sword', tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'magic', origin: 'drop' }, createRng(13)),
      pos: { x: 0, y: 0 },
    } as Item;
    const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'D', charId) as SaveState;
    save.gold = 100_000;
    save.inventory.push(sword);
    db.chars.set(charId, { data: save, version: 1 });
    const ws = new FakeConn();
    rm.handleConnection(ws);
    ws.push({ t: 'join', token: TOK, charId, fresh: true });
    await settle();
    expect(ws.all('joined'), JSON.stringify(ws.all('error'))).toHaveLength(1);
    await settle();
    let room: RoomLike | undefined; let pid = '';
    for (const r of rm.rooms.values()) for (const [id, p] of Object.entries(r.session.world.players)) if (p.save.charId === charId) { room = r; pid = id; }
    const me = (): SaveState => room!.session.world.players[pid]!.save;
    const live = (): Item => me().inventory.find((i) => i.uid === sword.uid)!;
    const gold0 = me().gold;
    const cost = forgeGold(cfg, live(), 'reroll');

    let open!: () => void;
    db.gate = new Promise<void>((r) => { open = r; });
    void room!.persist(pid);
    await settle();
    ws.frames.length = 0;
    ws.push({ t: 'cmd', command: { cmd: 'forgeReroll', uid: sword.uid, maxGold: cost }, id: 17 });
    await settle();
    expect(ws.all('cmdResult'), 'перекатка ждёт базу').toHaveLength(0);
    for (let k = 0; k < 64; k++) ws.push({ t: 'cmd', command: { cmd: 'moveItem', uid: sword.uid, x: k % 2 ? 0 : 4, y: 0 }, id: 18 + k });
    ws.push({ t: 'cmd', command: { cmd: 'forgeReroll', uid: sword.uid, maxGold: cost }, id: 17 });   // «нет ответа» — повтор
    await settle();
    db.gate = null; open();
    const answered = (): number => ws.all('cmdResult').filter((r) => r.cmd === 'forgeReroll').length;
    for (let i = 0; i < 100 && answered() < 2; i++) await settle();
    const rerolls = ws.all('cmdResult').filter((r) => r.cmd === 'forgeReroll');
    expect(rerolls.map((r) => [r.id, r.ok]), 'оба ответа — итог первой').toEqual([[17, true], [17, true]]);
    expect(live().rerolls, 'перекатка одна').toBe(1);
    expect(gold0 - me().gold, 'цена одна').toBe(cost);
    ws.close();
    await settle();
  }, 30_000);
});
