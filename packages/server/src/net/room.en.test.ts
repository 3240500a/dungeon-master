import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, cyrillicLeaks, generateItem, createRng, newCharacterSave, itemFromBaseId, decodeWorldFrame,
  type ServerFrame, type SaveState, type Item, type SessionEvent, type ScaledMonster, type QuestDef, type Locales, type WireFrame,
} from '@dm/shared';
import { unityViewsSample } from '@dm/shared/views/unityViews.testkit.js';
import { limits } from './rateLimit.js';
import { inTextLang } from './textScope.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐⭐ i18n (07.11, этап 1): НАСТОЯЩИЙ АНГЛИЙСКИЙ НА ПРОВОДЕ. Сторож утечек `room.leak.test.ts` гонит провод на псевдоязыке `xx` (каждый ключ
 * корпуса — транслитом); здесь — ТОТ ЖЕ проход на живой таблице языков, где английский включён и переведён целиком (`locales.json`, 100 %):
 * пропущенный или пустой перевод, ключ, которого нет в пакете, текст мимо шва — всё это русская буква на проводе английского игрока.
 *
 * Игрок `en`: вход, лист героя и строка HUD (ауры, имена статусов), все виды окон, отказы команд города, сейв, сундук, прилавок, доска,
 * подписи [E], «Поднято: …» сырья; смена языка русского игрока на английский — сейв, сундук, прилавок, доска заново (этап 1, A);
 * подземелье — голосование, этаж, монстры, события, кадры мира с добычей, окно смерти; лобби (ошибки входа, кадр `lang`); HTTP — ростер
 * (`className`, `classNames`) и отказы ручек аккаунта. Ни одной кириллической буквы.
 *
 * ⚠ РАЗРЕШЕНО ЯВНО (и только это): имена героев — их набирает игрок (`ALLOW`). Инструменты разработчика (`/api/dev/*`, оверлей DBG/F3 Unity —
 * решение владельца 07.11: русский) сюда не входят: игроку они не отвечают. Контроль сторожа: русский сосед той же комнаты — русский.
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { userId: string; data: unknown; version: number }>(),
  sessions: new Map<string, string>(),
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
  getSession: async (token: string) => db.sessions.get(token) ?? null,
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: r.userId, data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const r = db.chars.get(charId);
    if (!r) return v + 1;   // комната напрямую (без менеджера): героя в «базе» нет — запись проходит
    if (v !== r.version) return null;
    r.version = v + 1; r.data = structuredClone(data);
    return r.version;
  },
  putCharacterOwned: async () => null,
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
  listCharacters: async (userId: string) => [...db.chars].filter(([, r]) => r.userId === userId)
    .map(([charId, r]) => { const s = r.data as SaveState; return { charId, name: s.name, classId: s.classId, level: s.level }; }),
  countCharacters: async (userId: string) => [...db.chars.values()].filter((r) => r.userId === userId).length,
  createCharacter: async (charId: string, userId: string, data: unknown) => { db.chars.set(charId, { userId, data, version: 1 }); return 1; },
  deleteCharacter: async (charId: string) => { db.chars.delete(charId); },
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

/** Имена героев — набраны игроком, перевода у них нет и быть не может. */
const ALLOW = ['Образец', 'Сосед', 'Пришлый'];
const cyr = /[Ѐ-ӿ]/;
const leaksOf = (texts: readonly string[]): string[] => texts.flatMap((t) => cyrillicLeaks(t, ALLOW)).slice(0, 25);

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  raw: string[] = [];
  bins: Uint8Array[] = [];
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  send(m: string | Uint8Array): void {
    if (typeof m === 'string') { this.raw.push(m); this.frames.push(JSON.parse(m) as ServerFrame); } else this.bins.push(m);
  }
  close(): void { if (!this.open) return; this.open = false; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(JSON.stringify(frame)); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}

type RoomIn = {
  session: { world: { players: Record<string, { pos: { x: number; y: number }; save: SaveState; hp: number; alive: boolean; toggles: string[] }>; monsters: { id: number; def: ScaledMonster; alive: boolean }[]; drops: unknown[] } };
  questBoard: QuestDef[];
  clients: Map<string, { stashSeen?: unknown }>;
  addPlayer(ws: GameConn, userId: string, save: SaveState, version: number): string;
  setLang(pid: string, lang: string | undefined, announce?: boolean): string;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
  viewRequest(pid: string, id: number, kind: string, args: Record<string, unknown> | undefined): void;
  descend(pid: string): void;
  castVote(pid: string, yes: boolean): void;
  pushHero(pid: string): void;
  broadcastEvents(e: SessionEvent[]): void;
  onPlayerDeath(pid: string, t: Set<string>): void;
  step(emit?: boolean): void;
  stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
const rooms: RoomIn[] = [];
const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const until = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};
let seq = 0;

beforeAll(async () => {
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
afterEach(() => { for (const r of rooms) r.stop(); rooms.length = 0; });

/** Богатый сейв эталона окон (сумка всех видов, сырьё, печати, задания, гнёзда). */
function richSave(nick: string): SaveState {
  const s = unityViewsSample(cfg).save;
  s.name = nick;
  s.charId = `en-${++seq}`;
  return s;
}
/** Вход как у менеджера комнат: в области языка соединения, потом `setLang` (из `seat`). */
function join(room: RoomIn, lang: string | undefined, nick: string): { ws: FakeWs; pid: string; userId: string } {
  const ws = new FakeWs();
  const userId = `user-en-${++seq}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync, limits.viewReq, limits.stashRead]) l.reset(userId);
  const pid = inTextLang(lang ? cfg.get('locales') as Locales : undefined, lang, () => room.addPlayer(ws, userId, richSave(nick), 1));
  room.setLang(pid, lang);
  return { ws, pid, userId };
}
function makeRoom(): RoomIn {
  const r = new RoomCtor(`EN${++seq}`, cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(r);
  return r;
}

const VIEWS: Array<[string, Record<string, unknown> | undefined]> = [
  ['hero', { part: 'sheet' }], ['hero', { part: 'sheet', pending: { strength: 1 } }], ['hero', { part: 'tree' }], ['hero', { part: 'respec' }],
  ['hero', { part: 'quests' }], ['hero', { part: 'sockets' }], ['hero', { part: 'bind' }], ['hero', { part: 'mastery' }],
  ['item', { part: 'tips' }], ['item', { part: 'materials' }], ['shop', {}], ['exchange', {}], ['portal', {}], ['segment', { picked: {} }],
  ['reforge', {}], ['map', {}], ['craft', { weaponClass: 'sword' }], ['craft', { weaponClass: 'axe', hands: 2 }],
];

describe('⭐⭐ i18n (07.11, этап 1): английский игрок — ни одной русской буквы на проводе', () => {
  it('⭐⭐ город: вход, лист и HUD, все виды, отказы команд, сейв, сундук, прилавок, доска, подписи [E], «Поднято» — по-английски', async () => {
    const room = makeRoom();
    const a = join(room, 'en', 'Образец');
    const b = join(room, undefined, 'Сосед');
    await settle();
    expect(a.ws.last('joined')!.floor.interactables?.length, 'подписи [E] города').toBeGreaterThan(5);
    const save = room.session.world.players[a.pid]!.save;
    const bag = save.inventory;
    const weapon = bag.find((it) => it.slot === 'weapon')!;
    const mat = bag.find((it) => it.kind === 'material')!;
    // HUD: ауры и стойки включены — строка аур на языке игрока, имена статусов — в кадре `hero`
    const auras = cfg.get('skill-tree').nodes.filter((n) => n.effect.active?.category === 'aura' || n.effect.active?.category === 'stance').slice(0, 2);
    for (const pid of [a.pid, b.pid]) { room.session.world.players[pid]!.toggles = auras.map((n) => n.id); room.pushHero(pid); }
    let id = 0;
    for (const [kind, args] of VIEWS) room.viewRequest(a.pid, ++id, kind, args);
    for (const it of bag) room.viewRequest(a.pid, ++id, 'item', { part: 'menu', uid: it.uid });
    room.viewRequest(a.pid, ++id, 'item', { part: 'equip', uid: weapon.uid, cell: 'weapon' });
    room.viewRequest(a.pid, ++id, 'item', { part: 'equip', uid: weapon.uid, cell: 'boots' });
    room.viewRequest(a.pid, ++id, 'bench', { uid: weapon.uid });
    room.viewRequest(a.pid, ++id, 'exchange', { from: mat.materialId, n: 3 });
    room.viewRequest(a.pid, ++id, 'nope', {});
    const cmds: unknown[] = [
      { cmd: 'buy', uid: 'no-such' }, { cmd: 'sell', uid: 'no-such' }, { cmd: 'sell', uid: weapon.uid, minGold: 999_999 },
      { cmd: 'forgeUpgrade', uid: 'no-such' }, { cmd: 'forgeReroll', uid: weapon.uid }, { cmd: 'forgeRepair', uid: weapon.uid },
      { cmd: 'forgeSalvage', uid: 'no-such' }, { cmd: 'salvage', uid: mat.uid }, { cmd: 'forgeEnchant', uid: weapon.uid, rarity: 'rare', maxGold: 0 },
      { cmd: 'forgeSketch', variantId: 'no-such' }, { cmd: 'forgeExchange', from: mat.materialId, to: 'no-such', n: 1 },
      { cmd: 'sealReforge', seals: {} }, { cmd: 'equip', uid: mat.uid }, { cmd: 'unequip', slot: 'ring' }, { cmd: 'allocAttr', attr: 'luck' },
      { cmd: 'allocAttr', attr: 'strength', n: 99 }, { cmd: 'respec', maxGold: 0 }, { cmd: 'respecPassives', maxGold: 0 }, { cmd: 'respecSkills', maxGold: 0 },
      { cmd: 'allocPassive', nodeId: 'no-such' }, { cmd: 'allocSkill', nodeId: 'no-such' }, { cmd: 'socketInsert', nodeId: 'no-such', slot: 0, insertId: 'x' },
      { cmd: 'socketClear', nodeId: 'no-such', slot: 0 }, { cmd: 'useConsumable', uid: weapon.uid }, { cmd: 'moveBelt', uid: weapon.uid },
      { cmd: 'moveItem', uid: weapon.uid, x: 99, y: 99 }, { cmd: 'stashOpen' }, { cmd: 'stashMove', uid: weapon.uid, dst: 9, x: 0, y: 0 },
      { cmd: 'bind', slot: 99, value: 'x' }, { cmd: 'drop', uid: 'no-such' }, { cmd: 'acceptQuest', questId: 'no-such' },
      { cmd: 'turnInQuest', questId: 'no-such' }, { cmd: 'depositMaterials' }, { cmd: 'craft', nonce: 'n1', input: { weaponClass: 'sword', hands: 1, parts: {} } },
      { cmd: 'what' }, 42,
    ];
    for (const c of cmds) await room.handleCmd(a.pid, c, ++id);
    await room.handleCmd(a.pid, { cmd: 'moveItem', uid: weapon.uid, x: weapon.pos!.x, y: weapon.pos!.y }, ++id);
    // сырьё с трупа — своё событие с готовой строкой журнала
    const mats = cfg.get('craft-materials').filter((m) => m.enabled !== false).slice(0, 3);
    room.broadcastEvents([
      { type: 'materials', playerId: a.pid, gains: Object.fromEntries(mats.map((m, i) => [m.id, i + 1])), x: 1, y: 1 },
      { type: 'materials', playerId: b.pid, gains: { [mats[0]!.id]: 2 }, x: 1, y: 1 },
    ]);
    await settle();
    const kinds = new Set(a.ws.frames.map((f) => f.t));
    for (const t of ['joined', 'hero', 'view', 'cmdResult', 'shop', 'questBoard', 'stash', 'saveUpdate', 'events'] as const) expect(kinds.has(t), `кадр ${t}`).toBe(true);
    expect(a.ws.frames.filter((f) => f.t === 'cmdResult' && !f.ok).length, 'отказов набрано').toBeGreaterThan(25);
    const views = a.ws.frames.filter((f): f is Extract<ServerFrame, { t: 'view' }> => f.t === 'view');
    expect(views.filter((v) => v.ok).length, 'виды ответили моделями').toBeGreaterThanOrEqual(VIEWS.length + bag.length);
    // HUD и «Поднято» — явно (их же ловит и общий сторож ниже)
    type HeroV = { auraLine: string; debuffLabels: Record<string, string> };
    const ha = a.ws.last('hero')!.view as HeroV, hb = b.ws.last('hero')!.view as HeroV;
    expect(ha.auraLine).toMatch(/^◈ \S.*   ◈ \S/);
    expect(hb.auraLine, 'русскому — имена конфига').toBe(`◈ ${auras.map((n) => n.name).join('   ◈ ')}`);
    expect(Object.keys(ha.debuffLabels).length).toBe(8);
    const pick = a.ws.frames.flatMap((f) => (f.t === 'events' ? f.events : [])).find((e) => e.type === 'materials') as Extract<SessionEvent, { type: 'materials' }>;
    expect(pick.text).toMatch(/^Picked up: /);
    expect(leaksOf(a.ws.raw)).toEqual([]);
    // ⚠ контроль сторожа: русский сосед ТОЙ ЖЕ комнаты видит русское — сторож кириллицу видит, и нулём выше он обязан шву
    expect(leaksOf(b.ws.raw).length).toBeGreaterThan(0);
    const pickB = b.ws.frames.flatMap((f) => (f.t === 'events' ? f.events : [])).find((e) => e.type === 'materials') as Extract<SessionEvent, { type: 'materials' }>;
    expect(pickB.text).toBe(`Поднято: ${mats[0]!.name} ×2`);
  });

  it('⭐ смена языка русского игрока на английский: лист, сейв, сундук, прилавок, доска, подписи — заново и без русских букв', async () => {
    const room = makeRoom();
    const c = join(room, undefined, 'Пришлый');
    await settle();
    // слепок сундука, который клиент видел (база в тесте сундука не даёт) — с вещью из сумки
    const it = itemFromBaseId(cfg.get('items.base'), cfg.get('items.base').find((x) => 'slot' in x && x.slot === 'chest' && x.enabled !== false)!.id, undefined, 'shop')!;
    room.clients.get(c.pid)!.stashSeen = { version: 1, tabs: [[it]], materials: {} };
    expect(leaksOf(c.ws.raw).length, 'до смены — русский').toBeGreaterThan(0);
    const from = c.ws.raw.length;
    room.setLang(c.pid, 'en', true);
    await settle();
    const after = c.ws.frames.slice(c.ws.frames.length - (c.ws.raw.length - from)).map((f) => f.t);
    for (const t of ['hero', 'saveUpdate', 'stash', 'shop', 'questBoard', 'langChanged', 'interactables'] as const) expect(after.includes(t), `кадр ${t}`).toBe(true);
    expect(leaksOf(c.ws.raw.slice(from))).toEqual([]);
  });

  it('⭐⭐ подземелье: голосование, этаж, монстры, события, кадры мира с добычей, окно смерти — по-английски; русскому — русское', async () => {
    const room = makeRoom();
    const a = join(room, 'en', 'Образец');
    const b = join(room, undefined, 'Сосед');
    await settle();
    room.descend(a.pid);
    expect(a.ws.last('voteStart')).toBeDefined();
    room.castVote(b.pid, true);
    await settle();
    expect(a.ws.last('areaChanged')?.floor.area, 'спустились').toBe('dungeon');
    for (let i = 0; i < 3; i++) room.step();
    expect(a.ws.last('monsterInfo')?.monsters.length, 'определения монстров пришли').toBeGreaterThan(0);
    const world = room.session.world;
    const me = world.players[a.pid]!;
    const rng = createRng(11);
    const gen = (rarity: 'normal' | 'magic' | 'rare' | 'unique'): Item => generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'), {
      dropBias: 0, itemLevel: 20, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: rarity, rareNames: cfg.get('rare-names'),
    }, rng);
    const loot = [gen('normal'), gen('magic'), gen('rare'), gen('unique')];
    loot.forEach((item, i) => world.drops.push({ id: 900_000 + i, pos: { x: me.pos.x + 4 * i, y: me.pos.y }, kind: 'item', item }));
    const mon = world.monsters.find((m) => m.alive)!;
    room.broadcastEvents([
      ...loot.map((item): SessionEvent => ({ type: 'item-dropped', item, x: me.pos.x, y: me.pos.y, from: 'monster' })),
      { type: 'monster-died', id: mon.id, def: mon.def, x: me.pos.x, y: me.pos.y },
      { type: 'item-picked', playerId: a.pid, item: loot[1]!, x: me.pos.x, y: me.pos.y },
    ]);
    for (let i = 0; i < 4; i++) room.step();
    // двоичные кадры мира: вновь показанная добыча (`du`) — с английскими именами, русскому — испечённые
    const binItems = (bins: readonly Uint8Array[]): Item[] => [...new Map(bins.flatMap((buf) => {
      const f: WireFrame = decodeWorldFrame(buf);
      return (f.delta.du ?? []).flatMap((d) => (d.kind === 'item' ? [d.item] : []));
    }).map((it) => [it.uid, it])).values()];
    const itemsA = binItems(a.ws.bins), itemsB = binItems(b.ws.bins);
    expect(itemsA.length, 'добыча в кадре мира английского').toBe(loot.length);
    expect(itemsA.map((it) => it.name).join(' | ')).not.toMatch(cyr);
    expect(itemsB.map((it) => it.name), 'русскому — испечённые имена, побайтово').toEqual(loot.map((it) => it.name));
    Object.assign(me, { hp: 0, alive: false });
    room.onPlayerDeath(a.pid, new Set());
    await settle();
    expect(a.ws.last('died'), 'окно смерти').toBeDefined();
    const kinds = new Set(a.ws.frames.map((f) => f.t));
    for (const t of ['voteStart', 'areaChanged', 'monsterInfo', 'events', 'runPlan', 'saveUpdate', 'died'] as const) expect(kinds.has(t), `кадр ${t}`).toBe(true);
    expect(leaksOf(a.ws.raw)).toEqual([]);
    expect(leaksOf(b.ws.raw).length).toBeGreaterThan(0);
  });
});

// ── лобби и HTTP: менеджер комнат и ручки аккаунта — настоящие ──
describe('⭐ i18n (07.11, этап 1): лобби и HTTP по-английски — ошибки входа, ростер (`className`, `classNames`)', () => {
  let RM: typeof import('./roomManager.js').RoomManager;
  let rm: InstanceType<typeof RM>;
  let server: Server;
  let base = '';
  const tok = (userId: string): string => createHash('sha256').update(userId).digest('hex');
  function seed(prefix: string): { charId: string; userId: string; token: string } {
    const charId = `${prefix}-${++seq}`;
    const userId = `user-${charId}`;
    const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Образец', charId) as SaveState;
    db.chars.set(charId, { userId, data: save, version: 1 });
    db.sessions.set(tok(userId), userId);
    for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.viewReq, limits.stashRead, limits.charCreate]) l.reset(userId);
    return { charId, userId, token: tok(userId) };
  }
  beforeAll(async () => {
    ({ RoomManager: RM } = await import('./roomManager.js'));
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try { rm = new RM(cfg); } finally { vi.useRealTimers(); }
    const { installAccountRoutes } = await import('./accountRoutes.js');
    const app = express();
    installAccountRoutes(app, { config: cfg });
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server?.close();
    for (const r of (rm as unknown as { rooms: Map<string, { stop(): void }> }).rooms.values()) r.stop();
  });

  it('⭐ кадр `lang` до входа и ошибки лобби — по-английски; вход в `en` — кадры входа без русских букв', async () => {
    for (const n of ['lobbyIp', 'roomCodeMiss', 'roomCodeMissIp']) (limits as unknown as Record<string, { reset(k: string): void }>)[n]?.reset('ip:127.0.0.1');
    const h = seed('en-lobby');
    const ws = new FakeWs();
    rm.handleConnection(ws);
    ws.push({ t: 'lang', lang: 'en' });
    await until(() => !!ws.last('langChanged'));
    expect(ws.last('langChanged')).toEqual({ t: 'langChanged', lang: 'en' });
    ws.push({ t: 'join', token: h.token, charId: h.charId, roomCode: 'ZZZZZ' });
    await until(() => !!ws.last('error'));
    expect(ws.last('error')!.code).toBe('no-room');
    ws.push({ t: 'join', token: 'f'.repeat(64), charId: h.charId, fresh: true });
    await until(() => ws.frames.filter((f) => f.t === 'error').length >= 2);
    ws.push({ t: 'join', token: h.token, charId: h.charId, fresh: true, lang: 'en' });
    await until(() => !!ws.last('joined'));
    await settle();
    expect(ws.last('joined')).toBeDefined();
    expect(leaksOf(ws.raw)).toEqual([]);
    ws.close();
    await settle();
  });

  it('⭐ ростер: `className` у героя и `classNames` экрана создания — на языке запроса; русскому — имена конфига; отказы — по-английски', async () => {
    const h = seed('en-roster');
    const get = async (lang?: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> => {
      const r = await fetch(`${base}/api/characters`, { headers: { authorization: `Bearer ${h.token}`, ...(lang ? { 'accept-language': lang } : {}) } });
      const text = await r.text();
      return { status: r.status, body: JSON.parse(text) as Record<string, unknown>, text };
    };
    const cls = cfg.get('classes')[0]!;
    const ru = await get();
    type Row = { charId: string; name: string; classId: string; level: number; className: string };
    const ruRow = (ru.body.characters as Row[])[0]!;
    expect(ruRow, 'прежние поля — как были, плюс имя класса').toMatchObject({ charId: h.charId, classId: cls.id, level: 1, className: cls.name });
    expect(ru.body.classNames).toEqual(Object.fromEntries(cfg.get('classes').map((c) => [c.id, c.name])));
    const en = await get('en-US,en;q=0.9');
    const enRow = (en.body.characters as Row[])[0]!;
    expect(enRow.className).not.toBe(cls.name);
    expect(enRow.className).not.toMatch(cyr);
    expect(Object.keys(en.body.classNames as object)).toEqual(cfg.get('classes').map((c) => c.id));
    expect(cyrillicLeaks(en.text, ALLOW)).toEqual([]);
    // создание: ответ — с именем класса; отказы ручек — на языке запроса
    const post = async (body: unknown, lang = 'en'): Promise<{ status: number; text: string }> => {
      const r = await fetch(`${base}/api/characters`, {
        method: 'POST', body: JSON.stringify(body),
        headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json', 'accept-language': lang },
      });
      return { status: r.status, text: await r.text() };
    };
    const made = await post({ classId: cls.id, name: 'Пришлый' });
    expect(made.status).toBe(200);
    expect((JSON.parse(made.text) as { character: Row }).character.className).toBe(enRow.className);
    const refusals = [
      await post({ classId: 'no-such-class', name: 'Пришлый' }),
      await post({ classId: cls.id, name: '' }),
      { status: 0, text: await (await fetch(`${base}/api/characters`, { headers: { 'accept-language': 'en' } })).text() },
      { status: 0, text: await (await fetch(`${base}/api/characters/%00`, { method: 'DELETE', headers: { authorization: `Bearer ${h.token}`, 'accept-language': 'en' } })).text() },
      { status: 0, text: await (await fetch(`${base}/api/characters/00000000-0000-4000-8000-000000000000`, { method: 'DELETE', headers: { authorization: `Bearer ${h.token}`, 'accept-language': 'en' } })).text() },
    ];
    for (const r of refusals) expect((JSON.parse(r.text) as { error?: string }).error, r.text).toBeTruthy();
    expect(refusals.flatMap((r) => cyrillicLeaks(r.text, ALLOW))).toEqual([]);
  });
});
