import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, heroNumbers, respecView, socketsView, bindView, materialsView, runReforgeView, townCommandSchema,
  type ServerFrame, type SaveState, type Item,
} from '@dm/shared';
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

describe('⭐ С4/С6: виды города и забега — от сервера', () => {
  type Ans = Extract<ServerFrame, { t: 'view' }>;
  const asker = (room: Room, ws: FakeWs, pid: string) => {
    let id = 100;
    return (kind: Parameters<Room['viewRequest']>[2], args: Record<string, unknown> = {}): Ans => {
      const n = ++id;
      room.viewRequest(pid, n, kind, args);
      return ws.all('view').find((f) => f.id === n)!;
    };
  };

  it('стойки героя: сбросы, журнал заданий, гнёзда, бинды — ровно функции `shared/views` от сейва сервера', () => {
    const { room, ws, pid, save } = setup();
    const ask = asker(room, ws, pid);
    const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
    expect(ask('hero', { part: 'respec' })).toMatchObject({ ok: true, view: json(respecView(cfg, save)) });
    expect(ask('hero', { part: 'sockets' })).toMatchObject({ ok: true, view: json(socketsView(cfg, save)) });
    expect(ask('hero', { part: 'bind' })).toMatchObject({ ok: true, view: json(bindView(cfg, save)) });
    const q = ask('hero', { part: 'quests' });
    expect(q.ok).toBe(true);
    expect(q.view).toHaveProperty('active');
  });

  it('вещь: меню, подсказки, пупсик, сырьё; чужой или кривой uid — отказ, подсказки — только того, что игроку показано', () => {
    const { room, ws, pid, save } = setup();
    const ask = asker(room, ws, pid);
    const worn = Object.values(save.equipment).filter((x): x is Item => !!x);
    const bag = save.inventory[0];
    if (bag) {
      const menu = ask('item', { part: 'menu', uid: bag.uid });
      expect(menu.ok).toBe(true);
      expect(Array.isArray((menu.view as { items: unknown[] }).items)).toBe(true);
    }
    expect(ask('item', { part: 'menu', uid: 'нет-такой' }).ok).toBe(false);
    const uids = [...save.inventory, ...worn].map((it) => it.uid);
    const tips = (ask('item', { part: 'tips', uids: [...uids, 'чужая-вещь'] }).view as { tips: Record<string, unknown> }).tips;
    expect(Object.keys(tips).sort(), 'все свои — есть, чужой — нет').toEqual([...uids].sort());
    expect(ask('item', { part: 'tips', uids: new Array(401).fill('x') }).ok, 'потолок запроса').toBe(false);
    if (worn[0]) {
      const eq = ask('item', { part: 'equip', uid: worn[0].uid, cell: 'weapon' });
      expect(eq.ok).toBe(true);
    }
    expect(ask('item', { part: 'equip', uid: uids[0] ?? 'x', cell: 'tail' }).ok, 'нет такой клетки').toBe(false);
    expect(ask('item', { part: 'materials' })).toMatchObject({ ok: true, view: JSON.parse(JSON.stringify(materialsView(cfg, null, save.inventory))) });
    expect(ask('item', { part: '?' }).ok).toBe(false);
  });

  it('кузня, прилавок, обмен; алтарь, отрезок, перековка, карта — отвечают; вне подземелья карта пуста, отрезка нет', () => {
    const { room, ws, pid, save } = setup();
    const ask = asker(room, ws, pid);
    const any = [...save.inventory, ...Object.values(save.equipment).filter((x): x is Item => !!x)][0];
    if (any) expect(ask('bench', { uid: any.uid }).ok !== undefined).toBe(true);
    expect(ask('bench', { uid: 'нет-такой' })).toMatchObject({ ok: false, reason: 'Вещи нет' });
    const shop = ask('shop');
    expect(shop.ok).toBe(true);
    expect(shop.view).toHaveProperty('buy');
    expect(ask('exchange', { from: null, to: null }).ok).toBe(true);
    expect(ask('portal').ok).toBe(true);
    const seg = ask('segment');
    expect(seg.ok).toBe(true);
    expect((seg.view as { seals: unknown[] }).seals).toEqual([]);
    expect(ask('segment', { picked: { 'x@t1': -1 } }).ok, 'кривой набор печатей').toBe(false);
    const ref = ask('reforge');
    expect(ref).toMatchObject({ ok: true, view: JSON.parse(JSON.stringify(runReforgeView(cfg, save, null))) });
    expect(ref.view).toHaveProperty('source');
    const map = ask('map');
    expect(map.ok).toBe(true);
    expect((map.view as { empty: string | null; legendNote: string }).empty).toBeTruthy();
    expect((map.view as { legendNote: string }).legendNote).toContain('⌂');
  });

  it('окно смерти и вопрос голосования — сервером, каждому свой: потери помнятся, статус окно не открывает', () => {
    const { room, ws } = setup();
    const send = (f: ServerFrame): void => (room as unknown as { send(w: GameConn, f: ServerFrame): void }).send(ws as unknown as GameConn, f);
    send({ t: 'died', goldLost: 7, itemsLost: 2, toTown: false });
    const d1 = ws.all('died').at(-1)!;
    expect(d1.opens).toBe(true);
    expect(d1.view?.loss).toContain('7');
    send({ t: 'died', goldLost: 0, itemsLost: 0, toTown: false, status: true });
    const d2 = ws.all('died').at(-1)!;
    expect(d2.opens, 'статус — окно, закрытое «Смотреть», не встаёт').toBe(false);
    expect(d2.view?.loss, 'потери кадра смерти не подменяются нулями').toContain('7');
    send({ t: 'voteStart', kind: 'town', by: 'x', needed: 2 });
    expect(ws.all('voteStart').at(-1)!.question).toBe('Вернуться в город?');
  });

  it('перековка по карточке: провод берёт карточку или связку; набирает связку сервер', () => {
    expect(townCommandSchema.safeParse({ cmd: 'sealReforge', card: 't1|any' }).success).toBe(true);
    expect(townCommandSchema.safeParse({ cmd: 'sealReforge', seals: { 'a@t1': 3 } }).success).toBe(true);
    expect(townCommandSchema.safeParse({ cmd: 'sealReforge', card: 'x' }).success, 'ключ короче рамки').toBe(false);
  });
});
