import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  ConfigRegistry, isWaypoint, nextWaypointAfter, newCharacterSave, buildSeal, sealKey, sealSlots, carriedSealCount,
  sealBuffs, liveSealDefs, type Item, type SaveState, type ServerFrame,
} from '@dm/shared';

/**
 * ⭐⭐ Ф4 (16.10, решение владельца): ОТРЕЗОК — «модификаторы действуют ДО СЛЕДУЮЩЕЙ МЕТКИ, а не на весь забег».
 *
 * ⚠⚠ ЗАМЕР, РАДИ КОТОРОГО ЭТОТ СТОРОЖ СУЩЕСТВУЕТ. `Room.enterNode` пересобирает `s.run` ЦЕЛИКОМ литералом на
 * каждом входе в узел: любое новое поле, дописанное «где-то рядом», теряется на первом же спуске МОЛЧА — ровно
 * так умер бы оплаченный отрезок. Поэтому сторож идёт ногами: оплатил на метке → спустился → поле на месте и
 * модификаторы доехали до этажа; ушёл за `to` → поля нет и этаж снова на умолчаниях.
 *
 * База замокана: `db.ts` открывает пул к Postgres при импорте.
 */
const db = vi.hoisted(() => ({ versions: new Map<string, number>(), data: new Map<string, unknown>() }));
vi.mock('../db/db.js', () => ({
  putCharacter: async (charId: string, _u: string, data: SaveState, version: number) => {
    if (version !== (db.versions.get(charId) ?? 1)) return null;
    db.versions.set(charId, version + 1); db.data.set(charId, structuredClone(data));
    return version + 1;
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

type RoomIn = {
  area: string;
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  descend(pid: string, difficultyId?: string, targetNodeId?: string, cfg?: unknown, startDepth?: number): void;
  enterNode(nodeId: string): void;
  /** Внутренности: уронить героя, подвести его к алтарю, посмотреть на отрезок. */
  session: {
    world: {
      spawn: { x: number; y: number };
      players: Record<string, { alive: boolean; hp: number; pos: { x: number; y: number }; save: SaveState }>;
    };
  };
  tick?(): void;
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): void;
  altarPick(pid: string, picks?: Record<string, number>): void;
  stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
beforeAll(async () => {
  const mod = (await import('./room.js')) as unknown as { Room: typeof RoomCtor };
  RoomCtor = mod.Room;
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); });

class FakeWs {
  open = true; readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; } onMessage(): void {} onClose(): void {}
  /** Последний присланный сейв — в нём и живёт отрезок. */
  save(): SaveState {
    for (let i = this.frames.length - 1; i >= 0; i--) { const f = this.frames[i]!; if (f.t === 'saveUpdate') return f.save as SaveState; }
    throw new Error('кадра `saveUpdate` не было');
  }
  /** Модификаторы ТЕКУЩЕГО этажа — как их видит клиент. */
  floorMods(): string[] {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.t === 'areaChanged') return (f.floor as { floorModifiers?: string[] }).floorModifiers ?? [];
    }
    throw new Error('кадра `areaChanged` не было');
  }
}

/** Печати в сумку стенда: по `n` штук каждого живого вида первой ступени. */
function withSeals(save: SaveState, n: number): string[] {
  const live = liveSealDefs(cfg);
  const keys: string[] = [];
  live.forEach((def, i) => {
    const it = buildSeal(cfg, def.id, cfg.get('balance').seals.tiers[0]!.id, n, `seal-${i}`) as Item;
    it.pos = { x: i, y: 0 };
    save.inventory.push(it);
    keys.push(sealKey(def.id, cfg.get('balance').seals.tiers[0]!.id));
  });
  return keys;
}

/**
 * ⭐⭐ 17.10: ПОДВЕСТИ ГЕРОЯ К АЛТАРЮ. Сервер проверяет близость и видимость (как у рычага и сундука), поэтому
 * «настроить отрезок из любой точки этажа» больше не работает — и сторож обязан идти ногами, как игрок.
 *
 * Точка алтаря — та же, что сервер кладёт в кадр этажа (`spawn + 64` по X).
 */
function walkToAltar(room: RoomIn, pid: string): void {
  const w = room.session.world;
  const p = w.players[pid];
  if (p) p.pos = { x: w.spawn.x + 64, y: w.spawn.y };
}

/** Комната с одним героем, уже в подземелье на глубине `at`. */
function stand(code: string, at: number, seals = 0): { room: RoomIn; ws: FakeWs; pid: string; keys: string[] } {
  const room = new RoomCtor(code, cfg, { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {}, onFarewell: () => {} });
  rooms.push(room);
  const charId = `char-${code}`;
  const save = newCharacterSave(cfg, 'warrior', 'Seg', charId);
  save.level = 30;
  // Рекорд тира открывает метку старта: иначе сервер зажал бы спуск ко входу (`waypointStart`).
  save.difficultyProgress = { [cfg.get('difficulties').find((d) => d.enabled !== false)!.id]: at + 40 };
  const keys = seals > 0 ? withSeals(save, seals) : [];
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(save));
  const ws = new FakeWs();
  const pid = room.addPlayer(ws as never, `user-${charId}`, save, 1);
  room.descend(pid, undefined, undefined, undefined, at);
  walkToAltar(room, pid);
  return { room, ws, pid, keys };
}

describe('⭐⭐ Ф4 + Ф5-3: отрезок алтаря живёт от метки до метки и несёт ПЕЧАТИ', () => {
  const access = (() => { const r = new ConfigRegistry(); r.loadAll(); return r.get('balance').dungeonAccess; })();
  const MARK = access.portalsAt[1]!;   // вторая метка круга: за ней есть и следующая

  it('⭐⭐ оплата на метке ставит отрезок, спуск его НЕ ТЕРЯЕТ, выход за край — снимает', () => {
    const to = nextWaypointAfter(MARK, access.portalsAt, access.contentCycle);
    expect(isWaypoint(MARK, access.portalsAt, access.contentCycle), 'стенд стоит на метке').toBe(true);

    const { room, ws, pid, keys } = stand('F4SEG', MARK, 3);
    expect(room.area, 'в подземелье').toBe('dungeon');
    room.altarPick(pid, { [keys[0]!]: 1 });
    const seg = ws.save().run!.segment!;
    console.log(`Ф5-3 ОТРЕЗОК: метка ${MARK} → [${seg.from}..${seg.to}], связка ${JSON.stringify(seg.seals)}`);
    expect(seg.from, 'отрезок начинается СО СЛЕДУЮЩЕГО этажа — метка уже заселена').toBe(MARK + 1);
    expect(seg.to, 'и кончается на следующей метке').toBe(to);
    expect(seg.seals[keys[0]!], 'вставленная печать в отрезке').toBe(1);

    room.enterNode(`n${MARK + 1}_0`);
    expect(ws.save().run!.segment, '⚠ литерал `s.run` не съел поле').toBeDefined();
    expect(ws.save().run!.segment!.seals[keys[0]!], 'и связка доехала через спуск').toBe(1);

    room.enterNode(`n${to + 1}_0`);
    expect(ws.save().run!.segment, 'за следующей меткой отрезок снят').toBeUndefined();
  });

  it('⭐⭐ ПЕЧАТЬ СПИСАНА ИЗ СУМКИ — ровно вставленное, ни больше ни меньше', () => {
    const { room, ws, pid, keys } = stand('F5SPEND', MARK, 3);
    const [sealId, tierId] = keys[0]!.split('@') as [string, string];
    expect(carriedSealCount(ws.save().inventory, sealId, tierId), 'стенд дал три печати').toBe(3);
    room.altarPick(pid, { [keys[0]!]: 2 });
    expect(carriedSealCount(ws.save().inventory, sealId, tierId), 'списано ровно две').toBe(1);
    expect(ws.save().run!.segment!.seals[keys[0]!]).toBe(2);
  });

  it('⚠⚠ ВСЁ ИЛИ НИЧЕГО: печатей в сумке меньше, чем вставляют — сумка не тронута и отрезка нет', () => {
    const { room, ws, pid, keys } = stand('F5SHORT', MARK, 1);
    const [sealId, tierId] = keys[0]!.split('@') as [string, string];
    room.altarPick(pid, { [keys[0]!]: 1, [keys[1]!]: 1 });   // вторая печать есть
    const okSeg = ws.save().run!.segment!;
    expect(Object.keys(okSeg.seals).length, 'связка из двух прошла').toBe(2);
    const { room: r2, ws: w2, pid: p2, keys: k2 } = stand('F5SHORT2', MARK, 1);
    r2.altarPick(p2, { [k2[0]!]: 5 });                       // а пяти нет
    expect(w2.save().run!.segment, 'связка не по карману — отрезка нет').toBeUndefined();
    expect(carriedSealCount(w2.save().inventory, sealId, tierId), 'и сумка не тронута').toBe(1);
  });

  it('⭐⭐ ГНЁЗДА: вставить больше, чем открыто рекордом, нельзя — и ничего не списано', () => {
    const slots = sealSlots(cfg, MARK + 40);
    const { room, ws, pid, keys } = stand('F5SLOTS', MARK, 9);
    const [sealId, tierId] = keys[0]!.split('@') as [string, string];
    room.altarPick(pid, { [keys[0]!]: slots + 1 });
    expect(ws.save().run!.segment, `гнёзд ${slots}, а вставили ${slots + 1}`).toBeUndefined();
    expect(carriedSealCount(ws.save().inventory, sealId, tierId), 'сумка не тронута').toBe(9);
    room.altarPick(pid, { [keys[0]!]: slots });
    expect(ws.save().run!.segment!.seals[keys[0]!], 'ровно по гнёздам — прошло').toBe(slots);
  });

  it('⭐ «идти как есть» — законный выбор и ничего не стоит', () => {
    const { room, ws, pid, keys } = stand('F5PLAIN', MARK, 3);
    const [sealId, tierId] = keys[0]!.split('@') as [string, string];
    room.altarPick(pid, {});
    expect(Object.keys(ws.save().run!.segment!.seals), 'связка пуста').toEqual([]);
    expect(carriedSealCount(ws.save().inventory, sealId, tierId), 'заход на алтарь списал печать').toBe(3);
  });

  it('⚠⚠ ОПЛАЧЕННОЕ НЕ ОТМЕНЯЕТСЯ ЗАДАРОМ: второй заход не сжигает связку — ни свою, ни чужую', () => {
    const { room, ws, pid, keys } = stand('F5PAID', MARK, 3);
    const [sealId, tierId] = keys[0]!.split('@') as [string, string];
    room.altarPick(pid, { [keys[0]!]: 2 });
    expect(ws.save().run!.segment!.seals[keys[0]!], 'связка оплачена').toBe(2);
    // Замер ревизии: до правки ЛЮБОЙ повтор (в коопе — любого участника) перезаписывал отрезок, и оплаченные
    // печати исчезали молча. Теперь алтарь этой метки закрыт, пока отрезок оплачен.
    room.altarPick(pid, {});
    expect(ws.save().run!.segment!.seals[keys[0]!], '⚠ пустой кадр сжёг оплаченное').toBe(2);
    room.altarPick(pid, { [keys[0]!]: 1 });
    expect(ws.save().run!.segment!.seals[keys[0]!], '⚠ повторная оплата перезаписала связку').toBe(2);
    expect(carriedSealCount(ws.save().inventory, sealId, tierId), 'и ни одной печати больше не списано').toBe(1);
  });

  it('⚠ алтарь работает ТОЛЬКО на метке', () => {
    const { room, ws, pid, keys } = stand('F4NOT', MARK, 3);
    room.enterNode(`n${MARK + 1}_0`);   // обычный этаж
    room.altarPick(pid, { [keys[0]!]: 1 });
    expect(ws.save().run!.segment, 'на обычном этаже алтаря нет').toBeUndefined();
  });

  it('⚠ выдуманная печать и выдуманная ступень отвергаются кадром целиком', () => {
    const { room, ws, pid, keys } = stand('F5FAKE', MARK, 3);
    const [sealId, tierId] = keys[0]!.split('@') as [string, string];
    room.altarPick(pid, { 'нет-такого@t1': 1 });
    expect(ws.save().run!.segment, 'вид из воздуха').toBeUndefined();
    room.altarPick(pid, { [`${sealId}@t99`]: 1 });
    expect(ws.save().run!.segment, 'ступень из воздуха').toBeUndefined();
    room.altarPick(pid, { 'безступени': 1 });
    expect(ws.save().run!.segment, 'мусорный ключ').toBeUndefined();
    expect(carriedSealCount(ws.save().inventory, sealId, tierId), 'ни одна попытка не списала печать').toBe(3);
  });

  it('⭐⭐ Ф5-5: СМЕРТЬ СЖИГАЕТ ВСТАВЛЕННОЕ — связка не достаётся новому забегу бесплатно', () => {
    const { room, ws, pid, keys } = stand('F5BURN', MARK, 3);
    room.altarPick(pid, { [keys[0]!]: 2 });
    expect(ws.save().run!.segment!.seals[keys[0]!], 'связка оплачена').toBe(2);

    // Вайп пати: единственный герой лёг. Сервер хоронит забег — вместе с ним обязан сгореть и отрезок.
    const me = room.session.world.players[pid]!;
    me.hp = 0; me.alive = false;
    (room as unknown as { onPlayerDeath(pid: string, touched?: Set<string>): void }).onPlayerDeath(pid, new Set());

    // ⚠ Смотрим ЖИВОЙ сейв сервера, а не последний кадр: кадра saveUpdate после вайпа может и не быть
    // (пати уезжает в город отдельным шагом), а правило — про то, что держит сервер.
    expect(room.session.world.players[pid]?.save.run, 'забег похоронен').toBeUndefined();
    const held = (room as unknown as { segment?: unknown }).segment;
    expect(held, '⚠ поле комнаты пережило смерть — связка досталась бы НОВОМУ забегу бесплатно').toBeUndefined();
  });

  it('⭐⭐ ПЕЧАТЬ ДЕЙСТВУЕТ: множители этажа отрезка выросли, а за `to` вернулись к единице', () => {
    const { room, ws, pid, keys } = stand('F5ACT', MARK, 4);
    const to = nextWaypointAfter(MARK, access.portalsAt, access.contentCycle);
    room.altarPick(pid, { [keys[0]!]: 2 });
    const seg = ws.save().run!.segment!;
    // ⚠ 23.10: С БИОМОМ, как зовут живые швы (без него сторож повторял бы прежнюю ошибку сервера).
    const buffs = sealBuffs(cfg, seg.seals, cfg.get('biomes').find((b) => b.enabled !== false)!.id);
    const grown = Object.entries(buffs).filter(([, v]) => v > 1).map(([k, v]) => `${k} ×${v.toFixed(2)}`);
    console.log(`Ф5-3 СВЯЗКА ДЕЙСТВУЕТ: ${grown.join(', ')}`);
    expect(grown.length, 'связка не меняет ни одного стата — печать была бы обманкой').toBeGreaterThan(1);
    expect(sealBuffs(cfg, {}), 'пустая связка нейтральна').toEqual(sealBuffs(cfg, undefined));
    room.enterNode(`n${to + 1}_0`);
    expect(ws.save().run!.segment, 'за краем отрезка — умолчания').toBeUndefined();
  });
});

describe('⭐⭐ Решение владельца 17.10: отрезок настраивает ТОТ, КТО НАЧАЛ ЗАБЕГ', () => {
  const access = (() => { const r = new ConfigRegistry(); r.loadAll(); return r.get('balance').dungeonAccess; })();
  const MARK = access.portalsAt[1]!;

  it('⭐⭐ спутник не настраивает отрезок, пока владелец забега в комнате', () => {
    const { room, ws, pid, keys } = stand('F5OWN', MARK, 3);
    // Второй герой в той же комнате: свои печати есть, но забег начал не он.
    const charId = 'char-F5OWN-2';
    const mate = newCharacterSave(cfg, 'warrior', 'Mate', charId);
    mate.level = 30;
    mate.difficultyProgress = { [cfg.get('difficulties').find((d) => d.enabled !== false)!.id]: MARK + 40 };
    withSeals(mate, 3);
    db.versions.set(charId, 1); db.data.set(charId, structuredClone(mate));
    const ws2 = new FakeWs();
    const pid2 = room.addPlayer(ws2 as never, `user-${charId}`, mate, 1);
    walkToAltar(room, pid2);

    room.altarPick(pid2, { [keys[0]!]: 1 });
    expect(ws.save().run!.segment, 'спутник настроил отрезок за всех').toBeUndefined();
    expect(carriedSealCount(room.session.world.players[pid2]!.save.inventory, keys[0]!.split('@')[0]!, keys[0]!.split('@')[1]!),
      'и печати спутника целы').toBe(3);

    // А владелец забега настраивает.
    room.altarPick(pid, { [keys[0]!]: 1 });
    expect(ws.save().run!.segment!.seals[keys[0]!], 'владелец забега настроил').toBe(1);
  });

  it('⚠ владелец ушёл — алтарь открывается остальным (чужой обрыв связи не наказывает пати)', () => {
    const { room, pid, keys } = stand('F5LEFT', MARK, 3);
    const charId = 'char-F5LEFT-2';
    const mate = newCharacterSave(cfg, 'warrior', 'Mate', charId);
    mate.level = 30;
    mate.difficultyProgress = { [cfg.get('difficulties').find((d) => d.enabled !== false)!.id]: MARK + 40 };
    const mateKeys = withSeals(mate, 3);
    db.versions.set(charId, 1); db.data.set(charId, structuredClone(mate));
    const ws2 = new FakeWs();
    const pid2 = room.addPlayer(ws2 as never, `user-${charId}`, mate, 1);
    walkToAltar(room, pid2);

    room.removePlayer(pid);   // владелец забега вышел
    room.altarPick(pid2, { [mateKeys[0]!]: 1 });
    expect(ws2.save().run?.segment?.seals[mateKeys[0]!], 'оставшийся не смог настроить отрезок').toBe(1);
  });
});

/**
 * ⭐⭐ Ф5-6′ (23.10): ПЕЧАТЬ ЧУЖОГО БИОМА НЕ ВСТАВЛЯЕТСЯ. Правило привязки обязано держаться на ВСЕХ трёх путях
 * (дроп, алтарь, множители) — ядро стережёт `shared/economy/sealBiome.test.ts`, здесь СЕРВЕР.
 *
 * ⚠ Без этого случая привязка была бы только фильтром дропа: печать пещер, попавшая в сумку (другим забегом,
 * перековкой, подарком будущей торговли), вставлялась бы в крипте, СПИСЫВАЛАСЬ и не делала ничего —
 * ровно та беда «заплатил и не получил», из-за которой в `sealLive` появился тумблер механики.
 */
describe('⭐⭐ Ф5-6′: алтарь и привязка печати к биому', () => {
  const access = (() => { const r = new ConfigRegistry(); r.loadAll(); return r.get('balance').dungeonAccess; })();
  const MARK = access.portalsAt[1]!;

  it('⚠ печать чужого биома алтарь не берёт — и из сумки её не списывает', () => {
    const sealsBak = structuredClone(cfg.get('seals'));
    try {
      // Первый вид привязываем к ДРУГОМУ биому; забег идёт в первом включённом (крипта).
      const rows = cfg.get('seals');
      cfg.reload({ seals: rows.map((s, i) => (i === 0 ? { ...s, biomes: ['caves'] } : s)) });
      const { room, ws, pid, keys } = stand('F56BIOME', MARK, 3);
      const alien = keys[0]!;
      const mine = keys[1]!;
      room.altarPick(pid, { [alien]: 1 });
      expect(ws.save().run!.segment, 'отрезок на чужой печати не ставится').toBeUndefined();
      // А своя — ставится: отказ именно про привязку, а не «алтарь сломался».
      room.altarPick(pid, { [mine]: 1 });
      expect(ws.save().run!.segment!.seals[mine], 'своя печать вставляется как обычно').toBe(1);
    } finally {
      cfg.reload({ seals: sealsBak });
    }
  });
});
