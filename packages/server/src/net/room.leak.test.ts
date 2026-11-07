import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, defaultConfigData, pseudoLocales, cyrillicLeaks, decodeWorldFrame, generateItem, createRng, monsterDefView, HIT_BY_BLAST, HIT_BY_ENEMY,
  type ServerFrame, type SaveState, type Item, type Locales, type SessionEvent, type ScaledMonster, type QuestDef, type WireFrame,
} from '@dm/shared';
import { unityViewsSample } from '@dm/shared/views/unityViews.testkit.js';
import { counters } from './metrics.js';
import { limits } from './rateLimit.js';
import { inTextLang } from './textScope.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐⭐ i18n Ф2 (06.11): СТОРОЖ УТЕЧЕК — ВЕСЬ ПРОВОД ИГРОКА НА ПСЕВДОЯЗЫКЕ. В таблицу языков добавлен `xx` (включён), в котором КАЖДЫЙ ключ
 * корпуса (`cfg:` конфига и `srv:` кода) переведён транслитом (`pseudoLocales`): кириллицы в нём нет ни в одной строке. Игрок `xx` проходит
 * город и подземелье настоящей комнатой — вход, лист героя, все виды окон, отказы команд города, сейв, сундук, прилавок, доска заданий,
 * голосование, окно смерти, этаж, монстры, события и двоичные кадры мира с добычей, — и ни в одном кадре нет ни одной кириллической
 * буквы. Каждая найденная утечка — текст, собранный мимо шва (литерал без `tr`, текст конфига без `cfgText`, запечённое имя без показа).
 *
 * ⚠ РАЗРЕШЕНО ЯВНО (и только это): имена героев — их набирает игрок (`ALLOW`).
 *
 * Плюс цена: в русской комнате ни один кадр не пересобирается и кадр мира кодируется один раз (`textFramesLocalized`,
 * `worldLangEncodes` — ноль), а в смешанной русские получают ровно то же, что получили бы без иноязычного соседа.
 */
const db = vi.hoisted(() => ({ versions: new Map<string, number>() }));
vi.mock('../db/db.js', () => ({
  putCharacter: async (charId: string, _u: string, _d: SaveState, v: number) => {
    if (v !== (db.versions.get(charId) ?? 1)) return null;
    db.versions.set(charId, v + 1);
    return v + 1;
  },
  putCharacterOwned: async () => null,
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getCharacter: async () => null,
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

/** Имена героев — набраны игроком, перевода у них нет и быть не может. */
const ALLOW = ['Образец', 'Сосед'];

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  raw: string[] = [];
  bins: Uint8Array[] = [];
  send(m: string | Uint8Array): void {
    if (typeof m === 'string') { this.raw.push(m); this.frames.push(JSON.parse(m) as ServerFrame); } else this.bins.push(m);
  }
  close(): void { this.open = false; }
  onMessage(): void { /* комнату дёргают напрямую */ }
  onClose(): void { /* не проверяется */ }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}

type RoomIn = {
  session: { world: { players: Record<string, { pos: { x: number; y: number }; save: SaveState; hp: number; alive: boolean }>; monsters: { id: number; def: ScaledMonster; alive: boolean }[]; drops: unknown[] } };
  questBoard: QuestDef[];
  addPlayer(ws: GameConn, userId: string, save: SaveState, version: number): string;
  setLang(pid: string, lang: string | undefined, announce?: boolean): string;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
  viewRequest(pid: string, id: number, kind: string, args: Record<string, unknown> | undefined): void;
  descend(pid: string): void;
  step(emit?: boolean): void;
  stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
let xx: Locales;
const rooms: RoomIn[] = [];
const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
let seq = 0;

beforeAll(async () => {
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
  xx = pseudoLocales(cfg.get('locales'), defaultConfigData);
  cfg.reload({ locales: xx });
});
afterEach(() => { for (const r of rooms) r.stop(); rooms.length = 0; });

/** Богатый сейв эталона окон (сумка всех видов, сырьё, печати, задания, гнёзда) — тот же, что рендерит сторож видов shared. */
function richSave(nick: string): SaveState {
  const s = unityViewsSample(cfg).save;
  s.name = nick;
  s.charId = `leak-${++seq}`;
  return s;
}
/** Вход как у менеджера комнат: в области языка соединения (`join.lang`), потом `setLang` (из `seat`). */
function join(room: RoomIn, lang: string | undefined, nick: string): { ws: FakeWs; pid: string } {
  const ws = new FakeWs();
  const userId = `user-leak-${++seq}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync, limits.viewReq, limits.stashRead]) l.reset(userId);
  const pid = inTextLang(lang ? xx : undefined, lang, () => room.addPlayer(ws, userId, richSave(nick), 1));
  room.setLang(pid, lang);
  return { ws, pid };
}
function makeRoom(): RoomIn {
  const r = new RoomCtor(`LK${++seq}`, cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(r);
  return r;
}
/** Утечки в тексте кадров (без разрешённых имён героев). */
const leaksOf = (texts: readonly string[]): string[] => texts.flatMap((t) => cyrillicLeaks(t, ALLOW)).slice(0, 25);
/** Двоичные кадры мира → их вещи-добыча (имена). */
const worldItems = (bins: readonly Uint8Array[]): Item[] => bins.flatMap((b) => {
  const f: WireFrame = decodeWorldFrame(b);
  return (f.delta.du ?? []).flatMap((d) => (d.kind === 'item' ? [d.item] : []));
});
/** Вещи кадров мира по разу (полный кадр по расписанию повторяет уже показанную добычу). */
const uniqItems = (bins: readonly Uint8Array[]): Item[] => [...new Map(worldItems(bins).map((it) => [it.uid, it])).values()];

const VIEWS: Array<[string, Record<string, unknown> | undefined]> = [
  ['hero', { part: 'sheet' }], ['hero', { part: 'sheet', pending: { strength: 1 } }], ['hero', { part: 'tree' }], ['hero', { part: 'respec' }],
  ['hero', { part: 'quests' }], ['hero', { part: 'sockets' }], ['hero', { part: 'bind' }], ['hero', { part: 'mastery' }],
  ['item', { part: 'tips' }], ['item', { part: 'materials' }], ['shop', {}], ['exchange', {}], ['portal', {}], ['segment', { picked: {} }],
  ['reforge', {}], ['map', {}], ['craft', { weaponClass: 'sword' }], ['craft', { weaponClass: 'axe', hands: 2 }],
];

describe('⭐⭐ i18n Ф2: сторож утечек — провод игрока на псевдоязыке без кириллицы', () => {
  it('⭐⭐ город: вход, лист героя, все виды окон, отказы команд, сейв, сундук, прилавок, доска заданий — ни одной кириллической буквы', async () => {
    const room = makeRoom();
    const a = join(room, 'xx', 'Образец');
    const b = join(room, undefined, 'Сосед');
    await settle();
    const save = room.session.world.players[a.pid]!.save;
    const bag = save.inventory;
    const weapon = bag.find((it) => it.slot === 'weapon')!;
    const mat = bag.find((it) => it.kind === 'material')!;
    // виды: каждый вид города и забега + меню и примерка каждой вещи сумки
    let id = 0;
    for (const [kind, args] of VIEWS) room.viewRequest(a.pid, ++id, kind, args);
    for (const it of bag) room.viewRequest(a.pid, ++id, 'item', { part: 'menu', uid: it.uid });
    room.viewRequest(a.pid, ++id, 'item', { part: 'equip', uid: weapon.uid, cell: 'weapon' });
    room.viewRequest(a.pid, ++id, 'item', { part: 'equip', uid: weapon.uid, cell: 'boots' });
    room.viewRequest(a.pid, ++id, 'bench', { uid: weapon.uid });
    room.viewRequest(a.pid, ++id, 'exchange', { from: mat.materialId, n: 3 });
    room.viewRequest(a.pid, ++id, 'nope', {});
    // отказы команд города (кривые uid, нет денег, нет очков, чужой слот…) и итоги (сундук, перекладка)
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
    // сейв и лист героя после правок (сдвинутая вещь — `saveUpdate`)
    await room.handleCmd(a.pid, { cmd: 'moveItem', uid: weapon.uid, x: weapon.pos!.x, y: weapon.pos!.y }, ++id);
    await settle();
    const kinds = new Set(a.ws.frames.map((f) => f.t));
    for (const t of ['joined', 'hero', 'view', 'cmdResult', 'shop', 'questBoard', 'peerInfo'] as const) expect(kinds.has(t), `кадр ${t}`).toBe(true);
    expect(a.ws.frames.filter((f) => f.t === 'cmdResult' && !f.ok).length, 'отказов набрано').toBeGreaterThan(25);
    const views = a.ws.frames.filter((f): f is Extract<ServerFrame, { t: 'view' }> => f.t === 'view');
    expect(views.filter((v) => v.ok).length, 'виды ответили моделями, а не отказами').toBeGreaterThanOrEqual(VIEWS.length + bag.length);
    expect(leaksOf(a.ws.raw)).toEqual([]);
    // ⚠ контроль сторожа: русский сосед ТОЙ ЖЕ комнаты видит русское — то есть сторож кириллицу видит, и нулём выше он обязан шву
    expect(leaksOf(b.ws.raw).length).toBeGreaterThan(0);
    expect(b.ws.raw.some((t) => /[а-яё]/i.test(t) && t.includes('"t":"shop"'))).toBe(true);
  });

  it('⭐⭐ подземелье: голосование, этаж, монстры, события, кадры мира с добычей, окно смерти — без кириллицы; русскому — русское', async () => {
    const room = makeRoom();
    const a = join(room, 'xx', 'Образец');
    const b = join(room, undefined, 'Сосед');
    await settle();
    room.descend(a.pid);   // двое — голосование (`voteStart` каждому на его языке)
    expect(a.ws.last('voteStart')).toBeDefined();
    (room as unknown as { castVote(pid: string, yes: boolean): void }).castVote(b.pid, true);
    await settle();
    expect(a.ws.last('areaChanged')?.floor.area, 'спустились').toBe('dungeon');
    for (let i = 0; i < 3; i++) room.step();
    expect(a.ws.last('monsterInfo')?.monsters.length, 'определения монстров пришли').toBeGreaterThan(0);

    // добыча на полу рядом с героем — уходит в двоичном кадре мира (`du`); событие выпадения и смерть монстра — кадром событий
    const world = room.session.world;
    const me = world.players[a.pid]!;
    const rng = createRng(11);
    const gen = (rarity: 'normal' | 'magic' | 'rare' | 'unique'): Item => generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'), {
      dropBias: 0, itemLevel: 20, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: rarity, rareNames: cfg.get('rare-names'),
    }, rng);
    const loot = [gen('normal'), gen('magic'), gen('rare'), gen('unique')];
    const binsA = a.ws.bins.length, binsB = b.ws.bins.length;
    loot.forEach((item, i) => world.drops.push({ id: 900_000 + i, pos: { x: me.pos.x + 4 * i, y: me.pos.y }, kind: 'item', item }));
    const mon = world.monsters.find((m) => m.alive)!;
    const events: SessionEvent[] = [
      ...loot.map((item): SessionEvent => ({ type: 'item-dropped', item, x: me.pos.x, y: me.pos.y, from: 'monster' })),
      { type: 'monster-died', id: mon.id, def: mon.def, x: me.pos.x, y: me.pos.y },
      { type: 'item-picked', playerId: a.pid, item: loot[1]!, x: me.pos.x, y: me.pos.y },
    ];
    (room as unknown as { broadcastEvents(e: SessionEvent[]): void }).broadcastEvents(events);
    for (let i = 0; i < 4; i++) room.step();   // кадр мира уходит не на каждом шаге
    const itemsA = uniqItems(a.ws.bins.slice(binsA)), itemsB = uniqItems(b.ws.bins.slice(binsB));
    expect(itemsA.length, 'добыча в кадре мира иноязычного').toBe(loot.length);
    expect(itemsA.map((it) => it.name).join(' | ')).not.toMatch(/[Ѐ-ӿ]/);
    expect(itemsB.map((it) => it.name), 'русскому — испечённые имена, побайтово').toEqual(loot.map((it) => it.name));
    // смерть героя — окно смерти (личный кадр) на его языке
    Object.assign(me, { hp: 0, alive: false });
    (room as unknown as { onPlayerDeath(pid: string, t: Set<string>): void }).onPlayerDeath(a.pid, new Set());
    await settle();
    expect(a.ws.last('died'), 'окно смерти').toBeDefined();
    const kinds = new Set(a.ws.frames.map((f) => f.t));
    for (const t of ['voteStart', 'areaChanged', 'monsterInfo', 'events', 'runPlan', 'saveUpdate', 'died'] as const) expect(kinds.has(t), `кадр ${t}`).toBe(true);
    expect(leaksOf(a.ws.raw)).toEqual([]);
    // монстры русскому — испечёнными именами
    const defB = b.ws.frames.filter((f): f is Extract<ServerFrame, { t: 'monsterInfo' }> => f.t === 'monsterInfo').flatMap((f) => f.monsters);
    const live = new Map(world.monsters.map((m) => [m.id, m.def.name]));
    for (const m of defB.slice(0, 20)) if (live.has(m.id)) expect(m.def.name).toBe(live.get(m.id));
  });

  it('⭐ цена: русская комната не пересобирает ни одного кадра и кодирует кадр мира раз на всех; смешанная — лишний буфер только на тике с добычей', async () => {
    // ── русская комната ──
    const ru = makeRoom();
    const r1 = join(ru, undefined, 'Образец'), r2 = join(ru, undefined, 'Сосед');
    await settle();
    ru.descend(r1.pid);
    (ru as unknown as { castVote(pid: string, yes: boolean): void }).castVote(r2.pid, true);
    await settle();
    const before = { t: counters.textFramesLocalized, w: counters.worldLangEncodes };
    const w = ru.session.world;
    const me = w.players[r1.pid]!;
    const item = generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'), {
      dropBias: 0, itemLevel: 10, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'rare', rareNames: cfg.get('rare-names'),
    }, createRng(3));
    const n1 = r1.ws.bins.length, n2 = r2.ws.bins.length;
    w.drops.push({ id: 910_000, pos: { ...me.pos }, kind: 'item', item });
    for (let i = 0; i < 5; i++) ru.step();
    await ru.handleCmd(r1.pid, { cmd: 'sell', uid: 'no-such' }, 1);
    ru.viewRequest(r1.pid, 2, 'item', { part: 'tips' });
    expect({ t: counters.textFramesLocalized - before.t, w: counters.worldLangEncodes - before.w }, 'русская комната: ни одной лишней сборки').toEqual({ t: 0, w: 0 });
    const s1 = r1.ws.bins.slice(n1), s2 = r2.ws.bins.slice(n2);
    expect(s1.length).toBe(s2.length);
    s1.forEach((buf, i) => expect(buf, `кадр мира ${i}: один буфер на всех`).toBe(s2[i]));

    // ── смешанная: русские — тот же буфер, иноязычный — свой только там, где добыча ──
    const mix = makeRoom();
    const m1 = join(mix, 'xx', 'Образец'), m2 = join(mix, undefined, 'Сосед');
    await settle();
    mix.descend(m1.pid);
    (mix as unknown as { castVote(pid: string, yes: boolean): void }).castVote(m2.pid, true);
    await settle();
    mix.step();
    const mw = mix.session.world;
    const k1 = m1.ws.bins.length, k2 = m2.ws.bins.length, enc0 = counters.worldLangEncodes;
    mw.drops.push({ id: 920_000, pos: { ...mw.players[m1.pid]!.pos }, kind: 'item', item });
    for (let i = 0; i < 4; i++) mix.step();
    const x1 = m1.ws.bins.slice(k1), x2 = m2.ws.bins.slice(k2);
    expect(x1.length).toBe(x2.length);
    // свой буфер — РОВНО там, где в кадре добыча (тик её появления; и полный кадр по расписанию, если он выпал на окно), остальное — общий
    const own = x1.filter((buf, i) => buf !== x2[i]);
    expect(own.length, 'свой буфер на тике появления добычи').toBeGreaterThanOrEqual(1);
    x1.forEach((buf, i) => expect(worldItems([buf]).length > 0, `кадр ${i}: свой буфер ⇔ в нём добыча`).toBe(buf !== x2[i]));
    expect(counters.worldLangEncodes - enc0, 'лишних кодирований — по одному на свой буфер').toBe(own.length);
    expect(uniqItems(x2).map((it) => it.name), 'русскому — испечённое').toEqual([item.name]);
    expect(uniqItems(x1)[0]!.name).not.toBe(item.name);
  });

  it('⚠ смерть монстра в событии и сеть: имя определения монстра — на языке получателя, русскому — испечённое (`monsterDefView` как был)', async () => {
    const room = makeRoom();
    const a = join(room, 'xx', 'Образец');
    const b = join(room, undefined, 'Сосед');
    await settle();
    room.descend(a.pid);
    (room as unknown as { castVote(pid: string, yes: boolean): void }).castVote(b.pid, true);
    await settle();
    const mon = room.session.world.monsters.find((m) => m.alive)!;
    const at = room.session.world.players[a.pid]!.pos;   // смерть — у героя: событие видно пати (`eventVisible`), где бы ни стоял монстр
    (room as unknown as { broadcastEvents(e: SessionEvent[]): void }).broadcastEvents([{ type: 'monster-died', id: mon.id, def: mon.def, x: at.x, y: at.y }]);
    const ea = a.ws.last('events')!.events.find((e) => e.type === 'monster-died') as Extract<SessionEvent, { type: 'monster-died' }>;
    const eb = b.ws.last('events')!.events.find((e) => e.type === 'monster-died') as Extract<SessionEvent, { type: 'monster-died' }>;
    const view = monsterDefView(mon.def);
    expect(eb.def.name, 'русскому — испечённое имя').toBe(view.name);
    expect(eb.def.gearRolls?.map((g) => g.name), 'и снаряжение — испечённое').toEqual(view.gearRolls?.map((g) => g.name));
    expect(ea.def.name).not.toMatch(/[Ѐ-ӿ]/);
    expect(JSON.stringify(ea.def.gearRolls ?? [])).not.toMatch(/[Ѐ-ӿ]/);
  });
});

describe('⭐ i18n (07.11, хвосты Ф1): удар по герою — имя нападающего (`hit.by`) на языке получателя', () => {
  type Priv = {
    monsterMelee(m: unknown, p: unknown): void; monsterShoot(m: unknown, p: unknown): void;
    monsterPacket(m: unknown): { packet: unknown; attacker: unknown; debuffs: unknown[] };
    hitPlayer(p: unknown, packet: unknown, attacker: unknown, onHit: unknown[], by: string, source?: unknown): void;
  };
  type Hit = Extract<SessionEvent, { type: 'hit' }>;
  const hitsOn = (ws: FakeWs, pid: string, from: number): Hit[] => ws.frames.slice(from)
    .flatMap((f) => (f.t === 'events' ? f.events : []))
    .filter((e): e is Hit => e.type === 'hit' && e.target === 'player' && e.id === pid);

  it('⭐⭐ монстр бьёт героя `xx` — вблизи, снарядом, взрывом, «Враг»: в его кадрах ни одной кириллической буквы; русскому — испечённое; id игрока — как есть', async () => {
    const room = makeRoom();
    const a = join(room, 'xx', 'Образец');
    const b = join(room, undefined, 'Сосед');
    await settle();
    room.descend(a.pid);
    (room as unknown as { castVote(pid: string, yes: boolean): void }).castVote(b.pid, true);
    await settle();
    room.step();
    const world = room.session.world as RoomIn['session']['world'] & { projectiles: { ownerId?: number; pos: { x: number; y: number }; vel: { x: number; y: number } }[] };
    const me = world.players[a.pid]!;
    Object.assign(me, { hp: 1e9 });   // герой переживёт все удары: смерть сменила бы кадры
    const mon = world.monsters.find((m) => m.alive)!;
    const session = room.session as unknown as Priv & { collectEvents(fn: () => void): SessionEvent[] };
    const fromA = a.ws.frames.length, fromB = b.ws.frames.length, rawA = a.ws.raw.length;
    const broadcast = (e: SessionEvent[]): void => (room as unknown as { broadcastEvents(e: SessionEvent[]): void }).broadcastEvents(e);

    // вблизи — настоящий удар монстра (`monsterMelee`), рассылка — настоящая (`broadcastEvents`)
    broadcast(session.collectEvents(() => session.monsterMelee(mon, me)));
    // взрыв конструкта и снаряд без имени стрелка — теми же строками, что кладёт сессия (`HIT_BY_BLAST`, `HIT_BY_ENEMY`)
    const pk = session.monsterPacket(mon);
    broadcast(session.collectEvents(() => session.hitPlayer(me, pk.packet, pk.attacker, [], `${mon.def.name}${HIT_BY_BLAST}`, mon)));
    broadcast(session.collectEvents(() => session.hitPlayer(me, pk.packet, pk.attacker, [], HIT_BY_ENEMY, mon)));
    // снаряд — тиком: монстр стреляет, снаряд — у героя (летит в нём же), столкновение — шагом комнаты
    session.monsterShoot(mon, me);
    const shot = world.projectiles.find((p) => p.ownerId === mon.id)!;
    Object.assign(shot, { pos: { ...me.pos }, vel: { x: 0, y: 0 } });
    room.step();
    // PvP: `by` — id игрока, его не трогают
    broadcast([{ type: 'hit', target: 'player', id: a.pid, by: b.pid, x: me.pos.x, y: me.pos.y, hit: true, blocked: false, crit: false, amount: 1, byType: {} as never, mat: 'flesh' as never }]);

    const ha = hitsOn(a.ws, a.pid, fromA), hb = hitsOn(b.ws, a.pid, fromB);
    expect(hb.map((e) => e.by), 'русскому — испечённое, слово в слово').toEqual(expect.arrayContaining([mon.def.name, `${mon.def.name}${HIT_BY_BLAST}`, HIT_BY_ENEMY, b.pid]));
    expect(hb.filter((e) => e.by === mon.def.name).length, 'вблизи и снарядом').toBeGreaterThanOrEqual(2);
    expect(ha.length).toBe(hb.length);
    expect(ha.map((e) => e.by).join(' | ')).not.toMatch(/[Ѐ-ӿ]/);
    expect(ha.some((e) => e.by === b.pid), 'id игрока — как есть').toBe(true);
    expect(ha.find((e) => e.by?.endsWith(' (vzryv)')), 'хвост взрыва — шаблоном языка').toBeDefined();
    expect(leaksOf(a.ws.raw.slice(rawA))).toEqual([]);
  });
});
