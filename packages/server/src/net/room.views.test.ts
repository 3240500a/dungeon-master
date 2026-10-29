import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, heroNumbers, heroMelee, respecView, socketsView, socketNodes, bindView, materialsView, runReforgeView, townCommandSchema,
  allocPassive, allocActive, socketInsert, insertUnlocked,
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
    const v = heroes[0]!.view as { numbers: unknown; master: string; hudInfo: string; xp: { frac: number }; melee: { range: number; halfArc: number } | null };
    expect(v.numbers).toEqual(JSON.parse(JSON.stringify(heroNumbers(cfg, save, []))));
    // ⭐ С-аудит (29.10): конус взмаха — числа сервера (`heroMelee` = `meleeGeometry`, которой бьёт `meleeSwing`)
    expect(v.melee).toEqual(heroMelee(cfg, save));
    expect(v.melee!.range).toBeGreaterThan(0);
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

  it('древо мастерства (С4): «можно» вида = «можно» команды `allocPassive` на каждом узле, цена вида = её согласие', () => {
    const { room, ws, pid, save } = setup();
    const tree = cfg.get('mastery-tree');
    save.masteries[tree.entryNodes[0]!] = 1;
    save.unspentMasteryPoints = 3; save.gold = 1_000_000; save.level = 20;
    room.viewRequest(pid, 900, 'hero', { part: 'mastery' });
    const v = ws.all('view').find((f) => f.id === 900)!;
    expect(v.ok).toBe(true);
    const nodes = (v.view as { nodes: { id: string; clickable: boolean; refusal: string | null; cost: number | null; state: string }[] }).nodes;
    expect(nodes.length).toBe(tree.nodes.length);
    let yes = 0;
    for (const n of nodes) {
      const clone = structuredClone(save);
      const r = allocPassive(cfg, clone, n.id, n.cost ?? undefined);
      expect(r.ok, `узел ${n.id}: вид ${n.clickable && !n.refusal ? 'пускает' : `«${n.refusal}»`}, команда ${r.ok ? 'пускает' : `«${r.reason}»`}`).toBe(n.clickable && n.refusal === null);
      if (!r.ok) expect(r.reason).toBe(n.refusal);
      if (r.ok) yes++;
    }
    expect(yes, 'есть доступные узлы').toBeGreaterThan(0);
    expect(nodes.some((n) => n.state === 'closed')).toBe(true);
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
    const tv = ask('item', { part: 'tips', uids: [...uids, 'чужая-вещь'] }).view as { tips: Record<string, { wornSlot: string | null }>; worn: Record<string, { name: string }> };
    const tips = tv.tips;
    expect(Object.keys(tips).sort(), 'все свои — есть, чужой — нет').toEqual([...uids].sort());
    // ⭐ С-аудит (29.10): надетое для сравнения — по разу на слот (`worn`), подсказка ссылается на него `wornSlot`
    for (const t of Object.values(tips)) if (t.wornSlot !== null) expect(tv.worn[t.wornSlot], 'ссылка ведёт в `worn`').toBeDefined();
    for (const w of worn) expect(tips[w.uid]!.wornSlot, 'надетое с собой не сравнивается').toBeNull();
    expect(ask('item', { part: 'tips', uids: new Array(401).fill('x') }).ok, 'потолок запроса').toBe(false);
    const all = (ask('item', { part: 'tips' }).view as { tips: Record<string, unknown> }).tips;
    expect(Object.keys(all).sort(), 'без uids — всё показанное игроку').toEqual(expect.arrayContaining(uids));
    const ex = ask('exchange', { from: (save.inventory.find((it) => it.kind === 'material') ?? { materialId: null }).materialId ?? null });
    expect(ex.ok).toBe(true);
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

  it('окно ковки (С5): модель сервера, выбор приведён к допустимому; скованная — только своя; чужой класс — отказ', () => {
    const { room, ws, pid, save } = setup();
    const ask = asker(room, ws, pid);
    const v = ask('craft', { weaponClass: 'sword', hands: 1, parts: { strike: { id: 'нет-такой', step: 99 } }, finish: 7 });
    expect(v.ok).toBe(true);
    const view = v.view as { classes: { id: string; on: boolean }[]; slots: unknown[]; left: { craft: { disabled: boolean } }; state: { parts: Record<string, { id: string; step: number }>; finish: number }; verdict: string | null };
    expect(view.classes.find((c) => c.on)?.id).toBe('sword');
    expect(view.slots.length).toBe(4);
    expect(view.state.parts.strike!.id, 'несуществующая деталь — заменена допустимой').not.toBe('нет-такой');
    expect(view.state.parts.strike!.step).toBeLessThanOrEqual(5);
    expect(view.verdict).toBeNull();
    const own = Object.values(save.equipment).find((x) => !!x);
    const withOwn = ask('craft', { weaponClass: 'sword', crafted: own?.uid ?? 'x' });
    expect(withOwn.ok).toBe(true);
    const other = ask('craft', { weaponClass: 'sword', crafted: 'чужая-вещь' });
    expect((other.view as { state: { crafted: string | null } }).state.crafted, 'чужой uid — не скованная').toBeNull();
    expect(ask('craft', { weaponClass: 'нет-класса' }).ok).toBe(false);
  });

  it('дорогой вид платит лимиту дороже: верстак кузни исчерпывает всплеск в 8 раз быстрее подсказки', () => {
    const { room, ws, pid, save } = setup();
    const any = Object.values(save.equipment).find((x) => !!x)!;
    for (let i = 0; i < 20; i++) room.viewRequest(pid, 1000 + i, 'bench', { uid: any.uid });
    const refused = ws.all('view').filter((f) => f.id >= 1000 && f.reason === 'Слишком часто').length;
    expect(refused, 'всплеск 120 токенов — 15 верстаков, остальные — отказ').toBeGreaterThanOrEqual(5);
  });

  /** Поздний билд: уровень 100, `pts` очков — жадно в активки и доноров вставок (командой `allocActive`), вставки — в гнёзда. */
  function bigBuild(save: SaveState, pts: number): void {
    const tree = cfg.get('skill-tree');
    save.level = 100; save.unspentSkillPoints = pts;
    for (let guard = 0; guard < 2000 && save.unspentSkillPoints > 0; guard++) {
      const fresh = tree.nodes.filter((n) => (save.skills[n.id] ?? 0) === 0);
      const pref = [...fresh.filter((n) => n.effect.active), ...fresh.filter((n) => n.effect.grantsInsert), ...fresh];
      if (!pref.some((n) => allocActive(cfg, save, n.id).ok)) break;
    }
    let k = 0;
    for (const n of tree.nodes) {
      if (!n.effect.active || !((save.skills[n.id] ?? 0) > 0)) continue;
      for (const ins of cfg.get('skill-inserts')) if (insertUnlocked(cfg, save, ins.id)) socketInsert(cfg, save, n.id, (k++) % 3, ins.id);
    }
  }

  it('⭐ С-аудит: гнёзда платят по работе — 1 + ⌈выученных активок с гнёздами / 8⌉ (был 1 токен за 50–200 КБ)', () => {
    const { room, ws, pid, save } = setup();
    bigBuild(save, 110);
    const n = socketNodes(cfg, save).length;
    expect(n, 'поздний билд').toBeGreaterThan(20);
    const take = vi.spyOn(limits.viewReq, 'takeCost');
    room.viewRequest(pid, 700, 'hero', { part: 'sockets' });
    expect(take).toHaveBeenLastCalledWith(expect.any(String), 1 + Math.ceil(n / 8));
    const ans = ws.all('view').find((f) => f.id === 700)!;
    expect(ans.ok).toBe(true);
    expect(JSON.stringify(ans).length / (1 + Math.ceil(n / 8)), 'байт на токен — в правиле ≈ 11 КБ').toBeLessThanOrEqual(11_000);
    // подсказки — по числу вещей ответа, 20 на токен: без `uids` — сколько показано игроку
    room.viewRequest(pid, 701, 'item', { part: 'tips' });
    const seen = save.inventory.length + Object.values(save.equipment).filter(Boolean).length
      + (room as unknown as { shopListed(): Item[] }).shopListed().length;
    expect(take).toHaveBeenLastCalledWith(expect.any(String), 1 + Math.floor(seen / 20));
    room.viewRequest(pid, 702, 'item', { part: 'tips', uids: new Array(45).fill('x') });
    expect(take).toHaveBeenLastCalledWith(expect.any(String), 1 + Math.floor(45 / 20));
    take.mockRestore();
  });

  it('⭐ С-аудит: ответ длиннее своей цены доплачивает по байтам — в долг; бакет пуст, пока пополнение не покроет', () => {
    const { room, ws, pid } = setup();
    // вид «дешёвый» по цене (1 токен), а ответ — ≈ 600 КБ: ⌈600 000 / 11 000⌉ = 55 токенов
    const big = { ok: true, view: { blob: 'x'.repeat(600_000) } };
    const viewOf = vi.spyOn(room as unknown as { viewOf(): unknown }, 'viewOf').mockReturnValue(big);
    const charge = vi.spyOn(limits.viewReq, 'charge');
    for (let i = 0; i < 3; i++) room.viewRequest(pid, 800 + i, 'hero', { part: 'respec' });
    const extra = Math.ceil(JSON.stringify({ t: 'view', id: 800, kind: 'hero', ...big }).length / 11_000) - 1;
    expect(charge).toHaveBeenCalledTimes(3);
    expect(charge).toHaveBeenLastCalledWith(expect.any(String), extra);
    expect(ws.all('view').filter((f) => f.id >= 800 && f.id < 803 && f.ok).length, 'ответы ушли — доплата после').toBe(3);
    viewOf.mockRestore();
    // 120 − 3 × (1 + 54) < 0 — бакет в долгу: даже копеечный вид — отказ
    room.viewRequest(pid, 810, 'hero', { part: 'bind' });
    expect(ws.all('view').find((f) => f.id === 810)).toMatchObject({ ok: false, reason: 'Слишком часто' });
    // а честный короткий ответ не доплачивает ничего
    charge.mockClear();
    limits.viewReq.reset(`user-views-${seq}`);
    room.viewRequest(pid, 811, 'hero', { part: 'bind' });
    expect(ws.all('view').find((f) => f.id === 811)?.ok).toBe(true);
    expect(charge).not.toHaveBeenCalled();
    charge.mockRestore();
  });

  it('фаззер аргументов вида: любой мусор — ответ (вид или отказ), ни одного броска изнутри', () => {
    const { room, ws, pid, save } = setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let seed = 1;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const uids = [...save.inventory, ...Object.values(save.equipment)].filter((x): x is Item => !!x).map((x) => x.uid);
    const junk = (d = 0): unknown => {
      const r = rnd();
      if (r < 0.1) return null;
      if (r < 0.2) return Math.floor(rnd() * 2e6) - 1e6;
      if (r < 0.25) return rnd() * 1e9;
      if (r < 0.3) return NaN;
      if (r < 0.45) return uids[Math.floor(rnd() * uids.length)] ?? 'x';
      if (r < 0.55) return ['sword', 'bow', 'weapon', 'strike', 'tree', 'menu', 'tips', 'equip', 'materials', 'respec', '', '__proto__', 'constructor'][Math.floor(rnd() * 13)];
      if (r < 0.7 && d < 3) return Array.from({ length: Math.floor(rnd() * 5) }, () => junk(d + 1));
      if (d < 3) return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 5) }, () => [String(junk(d + 1)).slice(0, 20), junk(d + 1)]));
      return 'z'.repeat(Math.floor(rnd() * 300));
    };
    const keys = ['part', 'uid', 'uids', 'cell', 'from', 'to', 'n', 'biome', 'depth', 'picked', 'weaponClass', 'hands', 'parts', 'finish', 'sketchPick', 'crafted', 'pending'];
    const kinds = ['hero', 'item', 'bench', 'shop', 'exchange', 'portal', 'segment', 'reforge', 'map', 'craft'] as const;
    let n = 0;
    for (let i = 0; i < 1500; i++) {
      limits.viewReq.reset(`user-views-${seq}`);
      const args: Record<string, unknown> = {};
      for (const k of keys) if (rnd() < 0.35) args[k] = junk();
      room.viewRequest(pid, 5000 + i, kinds[i % kinds.length]!, args);
      n++;
    }
    const answers = ws.all('view').filter((f) => f.id >= 5000);
    expect(answers.length, 'на каждый запрос — ответ').toBe(n);
    expect(answers.filter((a) => a.reason === 'Ошибка сервера').length, 'броски изнутри вида').toBe(0);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('перековка по карточке: провод берёт карточку или связку; набирает связку сервер', () => {
    expect(townCommandSchema.safeParse({ cmd: 'sealReforge', card: 't1|any' }).success).toBe(true);
    expect(townCommandSchema.safeParse({ cmd: 'sealReforge', seals: { 'a@t1': 3 } }).success).toBe(true);
    expect(townCommandSchema.safeParse({ cmd: 'sealReforge', card: 'x' }).success, 'ключ короче рамки').toBe(false);
  });
});
