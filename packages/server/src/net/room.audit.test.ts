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

describe('⭐ С-аудит F1/F2/F4: в подземелье клиенту — только то, что видит пати', () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  type Mon = { id: number; alive: boolean; pos: { x: number; y: number }; def: Record<string, unknown> };
  type Inner = {
    area: string; inView: Set<number>;
    session: { world: { monsters: Mon[]; players: Record<string, { pos: { x: number; y: number } }> } };
    roomView(s: unknown): { monsters: { id: number }[]; drops: unknown[]; projectiles: unknown[] };
    eventVisible(e: SessionEvent): boolean;
  };
  async function dungeon(): Promise<{ room: Room; inner: Inner; a: ReturnType<typeof join> }> {
    const room = newRoom();
    const a = join(room, 'A');
    await settle();
    room.descend(a.pid);
    await settle();
    const inner = room as unknown as Inner;
    expect(inner.area, 'спустились').toBe('dungeon');
    return { room, inner, a };
  }

  it('монстр за пределами вида — не в кадре и без событий; подошёл — в кадре; гистерезис на кромке', async () => {
    const { inner, a } = await dungeon();
    const { serializeWorld } = await import('@dm/shared');
    const w = inner.session.world;
    const me = w.players[a.pid]!.pos;
    const live = w.monsters.filter((m) => m.alive);
    expect(live.length, 'на этаже есть монстры').toBeGreaterThan(1);
    const far = live[0]!, near = live[1]!;
    far.pos = { x: me.x + 5000, y: me.y };
    near.pos = { x: me.x + 200, y: me.y };
    const ids = (): number[] => inner.roomView(serializeWorld(w as never)).monsters.map((m) => m.id);
    expect(ids()).toContain(near.id);
    expect(ids(), 'далёкий монстр клиенту не уходит').not.toContain(far.id);
    // Кромка: вошёл — держится до выхода за радиус с запасом, а не мигает.
    near.pos = { x: me.x + 850, y: me.y };
    expect(ids(), 'чуть за радиусом входа, но уже в виде — держится').toContain(near.id);
    near.pos = { x: me.x + 2000, y: me.y };
    expect(ids(), 'ушёл далеко — выпал').not.toContain(near.id);
    // События о далёком монстре — тоже нет; о герое — всегда.
    expect(inner.eventVisible({ type: 'monster-swing', id: far.id, windupMs: 300, x: far.pos.x, y: far.pos.y, facing: 0 })).toBe(false);
    expect(inner.eventVisible({ type: 'monster-died', id: far.id, def: far.def as never, x: far.pos.x, y: far.pos.y })).toBe(false);
    expect(inner.eventVisible({ type: 'item-dropped', item: {} as never, x: me.x + 5000, y: me.y, from: 'monster' })).toBe(false);
    expect(inner.eventVisible({ type: 'item-dropped', item: {} as never, x: me.x + 50, y: me.y, from: 'monster' })).toBe(true);
    expect(inner.eventVisible({ type: 'player-died', playerId: a.pid })).toBe(true);
  });

  it('определение монстра клиенту — без восприятия, ИИ, опыта и свойств снаряжения', async () => {
    const { monsterDefView } = await import('@dm/shared');
    const { inner } = await dungeon();
    const def = inner.session.world.monsters[0]!.def as unknown as Parameters<typeof monsterDefView>[0];
    const v = monsterDefView(def) as unknown as Record<string, unknown>;
    for (const k of ['vision', 'visionAngle', 'hearing', 'ai', 'xp', 'hpRegen', 'resFire', 'armor', 'minDamage', 'maxDamage', 'attackSpeed', 'moveSpeed'])
      expect(v, k).not.toHaveProperty(k);
    expect(v).toMatchObject({ id: def.id, name: def.name, faction: def.faction, rarity: def.rarity, level: def.level });
    for (const g of (v.gearRolls as Record<string, unknown>[] | undefined) ?? []) expect(Object.keys(g).sort()).toEqual(expect.arrayContaining(['name', 'slot']));
    for (const g of (v.gearRolls as Record<string, unknown>[] | undefined) ?? []) { expect(g).not.toHaveProperty('mods'); expect(g).not.toHaveProperty('base'); }
    expect(monsterDefView(def, true), 'стенду — с восприятием').toHaveProperty('vision');
  });
});

describe('⭐ С7: команда станции города — только у станции', () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  type Res = Extract<ServerFrame, { t: 'cmdResult' }>;
  const last = (ws: FakeWs): Res | undefined => ws.frames.filter((f): f is Res => f.t === 'cmdResult').at(-1);
  it('кузница и сундук со спавна — отказ «подойдите»; у станции — исполняется; флаг стенда снимает проверку', async () => {
    const { TOWN_STATIONS, townStationAt, STATION_USE_R } = await import('@dm/shared');
    const prev = process.env.DM_STATION_CHECK;
    process.env.DM_STATION_CHECK = 'on';
    try {
      const room = newRoom();
      const a = join(room, 'A');
      await settle();
      const p = (room as unknown as { session: { world: { players: Record<string, { pos: { x: number; y: number } }> } } }).session.world.players[a.pid]!;
      const forge = townStationAt('forge')!, stash = townStationAt('stash')!;
      expect(TOWN_STATIONS.length).toBe(5);
      p.pos = { x: forge.x + STATION_USE_R + 40, y: forge.y };
      await room.handleCmd(a.pid, { cmd: 'forgeSalvage', uid: 'nope' }, 1);
      expect(last(a.ws), 'далеко от кузницы').toMatchObject({ ok: false, reason: 'Подойдите ближе: Кузница' });
      await room.handleCmd(a.pid, { cmd: 'stashMove', uid: 'nope', dst: 'inv', x: 0, y: 0 } as never, 2);
      expect(last(a.ws), 'далеко от сундука').toMatchObject({ ok: false, reason: 'Подойдите ближе: Сундук' });
      p.pos = { x: forge.x + 20, y: forge.y };
      await room.handleCmd(a.pid, { cmd: 'forgeSalvage', uid: 'nope' }, 3);
      expect(last(a.ws)?.reason, 'у кузницы — до вещи дошли (отказ уже про вещь)').not.toBe('Подойдите ближе: Кузница');
      // Сундук открывается и из кузницы (окно кузницы читает сырьё сундука), перекладка — только у сундука.
      await room.handleCmd(a.pid, { cmd: 'stashOpen' }, 4);
      expect(last(a.ws)?.reason).not.toBe('Подойдите ближе: Сундук');
      p.pos = { ...stash };
      await room.handleCmd(a.pid, { cmd: 'stashMove', uid: 'nope', dst: 'inv', x: 0, y: 0 } as never, 5);
      expect(last(a.ws)?.reason).not.toBe('Подойдите ближе: Сундук');
      // Стенд: флаг снимает проверку (в бою он игнорируется — `devFlags.stationCheckOff`).
      process.env.DM_STATION_CHECK = 'off';
      p.pos = { x: 5, y: 5 };
      await room.handleCmd(a.pid, { cmd: 'forgeSalvage', uid: 'nope' }, 6);
      expect(last(a.ws)?.reason).not.toBe('Подойдите ближе: Кузница');
    } finally {
      if (prev === undefined) delete process.env.DM_STATION_CHECK; else process.env.DM_STATION_CHECK = prev;
    }
  });

  it('⭐ С-аудит: мастер прокачки — станция: сбросы и мастерство только у мастера; в подземелье и на арене — «только в городе»', async () => {
    const { townStationAt, STATION_USE_R, allocPassive, passiveAllocCheck } = await import('@dm/shared');
    const prev = process.env.DM_STATION_CHECK;
    process.env.DM_STATION_CHECK = 'on';
    try {
      const room = newRoom();
      const a = join(room, 'A');
      await settle();
      type P = { pos: { x: number; y: number }; save: SaveState };
      const w = room as unknown as { area: string; movedAt: number; session: { world: { players: Record<string, P> } } };
      const p = w.session.world.players[a.pid]!;
      // вложение мастерства, которое команда исполнила бы: вход вложен, очки и золото есть
      const tree = cfg.get('mastery-tree');
      p.save.masteries[tree.entryNodes[0]!] = 1; p.save.unspentMasteryPoints = 3; p.save.gold = 1_000_000; p.save.level = 20;
      const node = tree.nodes.find((n) => allocPassive(cfg, structuredClone(p.save), n.id).ok)!;
      const chk = passiveAllocCheck(cfg, p.save, node.id);
      const cost = chk.ok ? chk.cost : 0;
      const cmds = [
        { cmd: 'respec', maxGold: 1_000_000 }, { cmd: 'respecPassives', maxGold: 1_000_000 }, { cmd: 'allocPassive', nodeId: node.id, maxGold: cost },
      ];
      const master = townStationAt('master')!;
      p.pos = { x: master.x + STATION_USE_R + 30, y: master.y };
      let id = 30;
      for (const cmd of cmds) {
        await room.handleCmd(a.pid, cmd, ++id);
        expect(last(a.ws), `${cmd.cmd} с края площади`).toMatchObject({ ok: false, reason: 'Подойдите ближе: Мастер прокачки' });
      }
      expect(p.save.masteries[node.id] ?? 0, 'отказ — ничего не вложено').toBe(node.id === tree.entryNodes[0] ? 1 : 0);
      p.pos = { x: master.x + 10, y: master.y };
      await room.handleCmd(a.pid, cmds[2]!, ++id);
      expect(last(a.ws), 'у мастера — исполняется').toMatchObject({ ok: true });
      // вне города — карта мест (`guard.ts`), до всякой станции; флаг стенда её не снимает
      process.env.DM_STATION_CHECK = 'off';
      w.movedAt = 0; room.descend(a.pid);
      await settle();
      expect(w.area).toBe('dungeon');
      for (const cmd of cmds) {
        await room.handleCmd(a.pid, cmd, ++id);
        expect(last(a.ws), `${cmd.cmd} в подземелье`).toMatchObject({ ok: false, reason: 'Это доступно только в городе' });
      }
      w.movedAt = 0; room.returnTown(a.pid);
      await settle();
      w.movedAt = 0; room.enterArena(a.pid);
      await settle();
      expect(w.area).toBe('arena');
      for (const cmd of cmds) {
        await room.handleCmd(a.pid, cmd, ++id);
        expect(last(a.ws), `${cmd.cmd} на арене`).toMatchObject({ ok: false, reason: 'Это доступно только в городе' });
      }
    } finally {
      if (prev === undefined) delete process.env.DM_STATION_CHECK; else process.env.DM_STATION_CHECK = prev;
    }
  });

  it('флаг стенда в бою игнорируется', async () => {
    const { stationCheckOff } = await import('./devFlags.js');
    expect(stationCheckOff({ DM_STATION_CHECK: 'off', NODE_ENV: 'production' })).toBe(false);
    expect(stationCheckOff({ DM_STATION_CHECK: 'off', NODE_ENV: ' Production ' })).toBe(false);
    expect(stationCheckOff({ DM_STATION_CHECK: 'off' })).toBe(true);
  });

  it('интерактивы области — с сервера: город — пять станций и портал, у каждой радиус и окно', async () => {
    const room = newRoom();
    const a = join(room, 'A');
    const joined = a.ws.frames.find((f): f is Extract<ServerFrame, { t: 'joined' }> => f.t === 'joined')!;
    const acts = joined.floor.interactables ?? [];
    expect(acts.map((x) => x.panel)).toEqual(['shop', 'forge', 'master', 'quests', 'stash', 'difficulty']);
    for (const x of acts) expect(x.radius).toBeGreaterThan(0);
  });
});

describe('⭐ С-аудит F5: этаж открывается по мере исследования', () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  it('вход на этаж — только куски у героя; подошёл к новому — кадр `reveal` с клетками и объектами; повторно не шлёт', async () => {
    const { REVEAL_CHUNK, chunkAt, chunkKey, TILE, Cell } = await import('@dm/shared');
    const room = newRoom();
    const a = join(room, 'A');
    await settle();
    room.descend(a.pid);
    await settle();
    const changed = a.ws.frames.filter((f): f is Extract<ServerFrame, { t: 'areaChanged' }> => f.t === 'areaChanged').at(-1)!;
    const f = changed.floor;
    expect(f.revealed?.length, 'открыты куски у входа').toBeGreaterThan(0);
    const w = (room as unknown as { session: { world: { grid: number[][]; chests: { pos: { x: number; y: number } }[]; players: Record<string, { pos: { x: number; y: number } }> } } }).session.world;
    const rows = w.grid.length, cols = w.grid[0]!.length;
    const total = Math.ceil(cols / REVEAL_CHUNK) * Math.ceil(rows / REVEAL_CHUNK);
    expect(f.revealed!.length, 'не весь этаж').toBeLessThan(total);
    expect(f.revealed, 'кусок героя открыт').toContain(chunkAt(w.players[a.pid]!.pos.x, w.players[a.pid]!.pos.y));
    // Клетка в неоткрытом куске (далеко от каймы) у клиента — стена, хотя у сервера там пол.
    const open = new Set(f.revealed);
    let hidden = 0, leaked = 0;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const near = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => open.has(chunkKey(Math.floor((x + dx) / REVEAL_CHUNK), Math.floor((y + dy) / REVEAL_CHUNK)))));
      if (near) continue;
      if (w.grid[y]![x] !== Cell.Wall) { hidden++; if (f.grid[y]![x] !== Cell.Wall) leaked++; }
    }
    expect(hidden, 'за туманом есть проходимые клетки').toBeGreaterThan(0);
    expect(leaked, 'ни одна из них клиенту не видна').toBe(0);
    for (const c of f.chests) expect(open.has(chunkAt(c.x, c.y)), 'сундук клиента — на открытом куске').toBe(true);
    expect(f.chests.length, 'не все сундуки этажа').toBeLessThanOrEqual(w.chests.length);
    // Шаг в неоткрытый кусок — кадр `reveal`.
    const far = [...Array(total).keys()].map((i) => i).find((i) => {
      const cx = i % Math.ceil(cols / REVEAL_CHUNK), cy = Math.floor(i / Math.ceil(cols / REVEAL_CHUNK));
      return !open.has(chunkKey(cx, cy));
    })!;
    const cx = far % Math.ceil(cols / REVEAL_CHUNK), cy = Math.floor(far / Math.ceil(cols / REVEAL_CHUNK));
    w.players[a.pid]!.pos = { x: (cx * REVEAL_CHUNK + REVEAL_CHUNK / 2) * TILE, y: (cy * REVEAL_CHUNK + REVEAL_CHUNK / 2) * TILE };
    a.ws.frames.length = 0;
    room.step(); room.step();   // кадр мира (и открытие перед ним) — на своей частоте, не на каждом тике
    const rev = a.ws.frames.filter((x): x is Extract<ServerFrame, { t: 'reveal' }> => x.t === 'reveal');
    expect(rev.length, 'кадр открытия').toBe(1);
    expect(rev[0]!.chunks).toContain(chunkKey(cx, cy));
    const pat = rev[0]!.patches.find((p) => p.x <= cx * REVEAL_CHUNK && p.y <= cy * REVEAL_CHUNK)!;
    expect(pat.cells.length).toBe(pat.w * pat.h);
    expect(pat.cells[0], 'клетки — сервера').toBe(w.grid[pat.y]![pat.x]);
    a.ws.frames.length = 0;
    room.step(); room.step();
    expect(a.ws.frames.filter((x) => x.t === 'reveal').length, 'открытое второй раз не шлётся').toBe(0);
  });
});

describe('⭐ С7: спуск и арена из города — у портала', () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  it('со спавна — отказ «Подойдите к порталу», у портала — голосование; интерактив портала несёт досягаемость', async () => {
    const { townPortalAt, STATION_USE_R } = await import('@dm/shared');
    const prev = process.env.DM_STATION_CHECK;
    process.env.DM_STATION_CHECK = 'on';
    try {
      const room = newRoom();
      const a = join(room, 'A');
      await settle();
      const w = (room as unknown as { area: string; session: { world: { grid: number[][]; players: Record<string, { pos: { x: number; y: number } }> } } });
      const portal = townPortalAt(w.session.world.grid as never)!;
      w.session.world.players[a.pid]!.pos = { x: portal.x - STATION_USE_R - 30, y: portal.y };
      room.descend(a.pid);
      expect(w.area, 'спуска нет').toBe('town');
      expect(a.ws.frames.filter((f) => f.t === 'error').at(-1)).toMatchObject({ code: 'far', msg: 'Подойдите к порталу' });
      room.enterArena(a.pid);
      expect(a.ws.frames.some((f) => f.t === 'voteStart'), 'и арены нет').toBe(false);
      w.session.world.players[a.pid]!.pos = { ...portal };
      room.descend(a.pid);
      await settle();
      expect(w.area, 'у портала — спуск (соло: голос проходит сразу)').toBe('dungeon');
      const joined = a.ws.frames.find((f): f is Extract<ServerFrame, { t: 'joined' }> => f.t === 'joined')!;
      const acts = joined.floor.interactables ?? [];
      expect(acts.find((x) => x.panel === 'difficulty')?.reach).toBe(STATION_USE_R);
      expect(acts.find((x) => x.panel === 'forge')?.reach).toBe(STATION_USE_R);
      expect(acts.find((x) => x.panel === 'master')?.reach, '⭐ С-аудит: мастер — станция, окно закрывается вдали').toBe(STATION_USE_R);
      expect(acts.find((x) => x.panel === 'quests')?.reach, 'задания — откуда угодно').toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.DM_STATION_CHECK; else process.env.DM_STATION_CHECK = prev;
    }
  });
});

/**
 * ⭐ С-аудит (29.10): ПОТОК «ЗА» НЕ ДОЛЖЕН СТОИТЬ ПОИСКОВ ПУТИ. Кадр `vote` платил только общий потолок кадров (80/с), а каждый — меру
 * опасности (поиск пути на каждого гонящегося монстра) и `voteUpdate` всей комнате, хотя голос давно засчитан.
 */
describe('⭐ С-аудит: голос и мера опасности — без умножения на частоту кадров', () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  type Danger = { inDanger(p: unknown): boolean; step(): void; session: { world: { timeMs: number; players: Record<string, unknown> } } };

  it('повтор «за» уже голосовавшего — без `voteUpdate` комнате; голос второго — как прежде', async () => {
    const room = newRoom();
    const a = join(room, 'A'), b = join(room, 'B');
    await settle();
    room.descend(a.pid);   // спуск из города: голосование, «за» — позвавший
    const updates = (ws: FakeWs): number => ws.frames.filter((f) => f.t === 'voteUpdate').length;
    expect(b.ws.frames.some((f) => f.t === 'voteStart'), 'голосование открыто').toBe(true);
    const before = updates(b.ws);
    for (let i = 0; i < 50; i++) room.castVote(a.pid, true);
    expect(updates(b.ws), 'повтор ничего не шлёт').toBe(before);
    room.castVote(b.pid, true);
    await settle();
    expect((room as unknown as { area: string }).area, 'оба «за» — спуск').toBe('dungeon');
  });

  it('мера опасности: поиск пути — один на пару точек за тик; новый тик, шаг героя, смена области — заново; кто гонится — как прежде', async () => {
    const room = newRoom();
    const a = join(room, 'A');
    await settle();
    room.descend(a.pid);
    await settle();
    type Mon = { alive: boolean; aiState: string; windup?: unknown; pos: { x: number; y: number } };
    const r = room as unknown as Danger & { reachesNow(f: unknown, t: unknown): boolean; session: { world: { monsters: Mon[] } } };
    const w = r.session.world;
    const p = w.players[a.pid] as { pos: { x: number; y: number } };
    expect(w.monsters.length, 'на этаже есть монстры').toBeGreaterThan(0);
    // ровно один гонится за героем (он ближайший — герой один)
    const chase = (): Mon => {
      for (const m of w.monsters) { m.aiState = 'idle'; delete m.windup; }
      const m = w.monsters[0]!;
      m.alive = true; m.aiState = 'chase'; m.pos = { x: p.pos.x + 60, y: p.pos.y };
      return m;
    };
    const m = chase();
    const spy = vi.spyOn(r, 'reachesNow');
    const first = r.inDanger(p);
    for (let i = 0; i < 100; i++) expect(r.inDanger(p)).toBe(first);
    expect(spy, 'сотня кадров в одном тике — один поиск').toHaveBeenCalledTimes(1);
    // дешёвая часть меры — на каждый вызов: оторвался — угрозы нет сразу, поиска нет
    m.aiState = 'idle';
    expect(r.inDanger(p)).toBe(false);
    m.aiState = 'chase';
    expect(r.inDanger(p)).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    // герой шагнул — другие точки, поиск заново
    p.pos = { x: p.pos.x + 1, y: p.pos.y };
    r.inDanger(p);
    expect(spy).toHaveBeenCalledTimes(2);
    // новый тик — заново
    const t0 = w.timeMs;
    r.step();
    expect(w.timeMs).toBeGreaterThan(t0);
    chase();
    r.inDanger(p); r.inDanger(p);
    expect(spy, 'новый тик — поиск заново').toHaveBeenCalledTimes(3);
    expect((room as unknown as { reachMemo: unknown }).reachMemo).not.toBeNull();
    (room as unknown as { movedAt: number }).movedAt = 0;
    room.returnTown(a.pid);
    await settle();
    expect((room as unknown as { reachMemo: unknown }).reachMemo, 'смена области — память сброшена').toBeNull();
    spy.mockRestore();
  });
});
