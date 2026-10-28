import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, effectiveLevel, floorChallengeLevel, itemFromBaseId,
  type ServerFrame, type SaveState, type Item, type RunConfig, type RunPlan,
} from '@dm/shared';
import { limits } from './rateLimit.js';

// Команды комната исполняет асинхронно (оборотами цикла), а на Windows оборот таймера — ~15,6 мс: под нагрузкой полного
// прогона умолчание 5 с — лотерея. Гонки потолок не прячет: они падают утверждением, а не временем.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Раунд 8 (ядро): то, что правка ядра обязана довезти через настоящую `Room` — мощь узла не поднимают вещи сумки, которые
 * герою не надеть, а строка HUD получает уровень, по которому узел заселён (R8-10); выбор алтаря без дублей и без
 * модификаторов, чей эффект игра не применяет (R8-12). Сокет — фейковый, база — заглушка.
 * ⭐⭐ 13.10 (Г1): уровень монстров этажа — от ОДНОЙ ГЛУБИНЫ (`floorMonsterLevel`), мощь узла (`nodeState.el`) в него не
 * входит. Сторожа мощи остались (на ней ворота прогресса сложности), но ожидания строки HUD — числом от глубины.
 */
vi.mock('../db/db.js', () => ({
  // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const r of rooms.splice(0)) r.stop(); });

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void { /* комнату дёргают напрямую */ }
  onClose(): void { /* не проверяется */ }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}
type RoomIn = {
  area: string; movedAt: number; depth: number; difficultyId: string;
  nodeState: { el: number } | null; runConfig: RunConfig | null; runPlan: RunPlan | null; runNodeId: string | null;
};
const inner = (room: Room): RoomIn => room as unknown as RoomIn;
let seq = 0;
function makeRoom(level: number): { room: Room; ws: FakeWs; pid: string; save: SaveState } {
  const charId = `char-r8c-${++seq}`;
  const userId = `user-${charId}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(userId);
  const room = new RoomCtor('R8C', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(room);
  const save = newCharacterSave(cfg, 'warrior', 'Герой', charId);
  save.level = level;
  const ws = new FakeWs();
  const pid = room.addPlayer(ws as unknown as GameConn, userId, save, 1);
  // `addPlayer` кладёт в мир копию сейва — дальше работаем с живой.
  const live = (room as unknown as { session: { world: { players: Record<string, { save: SaveState }> } } }).session.world.players[pid]!.save;
  return { room, ws, pid, save: live };
}

describe('⭐ R8-10: мощь узла — по тому, что герою надеть; строка HUD — уровень монстров этажа (Г1: от глубины)', () => {
  /** Магическое в уровень героя во все слоты, без требований (как у героя в обычном снаряжении). */
  function wearMagic(s: SaveState): void {
    for (const b of cfg.get('items.base')) {
      const slot = (b as { slot?: string }).slot as keyof SaveState['equipment'] | undefined;
      if (!slot || b.kind === 'consumable' || b.enabled === false || s.equipment[slot]) continue;
      const it = itemFromBaseId(cfg.get('items.base'), b.id, cfg.get('item-tiers'), 'drop') as Item;
      it.rarity = 'magic'; it.itemLevel = s.level; it.requirements = {}; it.hands = 1; delete it.versatile;
      s.equipment[slot] = it;
    }
  }

  it('редкие находки этажа, которые герой не может надеть, в сумке — мощь узла записана по надетому, как и без них', async () => {
    const power = cfg.get('balance').power;
    const { room, ws, pid, save } = makeRoom(12);
    wearMagic(save);
    // Находки этажа: редкие, на уровень выше, с Силой сверх героя — `equip` их отвергает.
    let x = 0;
    for (const slot of ['helm', 'chest', 'gloves', 'boots', 'belt', 'ring', 'amulet'] as const) {
      const it = structuredClone(save.equipment[slot]!);
      it.uid = `loot-${slot}`; it.rarity = 'rare'; it.itemLevel = 13;
      it.requirements = { strength: save.attributes.strength + 25 };
      it.pos = { x: x++, y: 0 }; it.gridW = 1; it.gridH = 1;
      save.inventory.push(it);
    }
    for (const it of [...save.inventory]) {
      await room.handleCmd(pid, { cmd: 'equip', uid: it.uid }, undefined);
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      expect(ws.last('cmdResult'), it.uid).toMatchObject({ ok: false, reason: 'Недостаточно атрибутов' });
    }
    const equipped = effectiveLevel(save, power).total;   // то, что показывал HUD
    expect(effectiveLevel(save, power, save.inventory).total, 'было: сумка поднимала мощь').toBe(equipped);
    inner(room).movedAt = 0;
    room.descend(pid);
    expect(inner(room).area).toBe('dungeon');
    expect(inner(room).nodeState?.el, 'мощь узла — по надетому').toBe(equipped);
    // Строка HUD — уровень монстров этажа (по нему же заселён узел) и тир забега.
    const floor = ws.last('areaChanged')!.floor;
    const r = inner(room);
    expect(floor.difficultyId).toBe(r.difficultyId);
    // ⭐ 13.10 (Г1): уровень монстров этажа — от ГЛУБИНЫ, мощь узла (`nodeState.el`) в него не входит. Сверяем и
    // вызовом (подпись), и ЧИСЛОМ: вызов один и тот же ловит только смену подписи, а не смену закона.
    expect(floor.challengeLevel).toBe(floorChallengeLevel(cfg, r.difficultyId, r.depth));
    expect(floor.challengeLevel, 'этаж N → монстры N уровня (normal: startLevel 1, floorStep 1)').toBe(r.depth);
    expect(floor.challengeLevel, 'мощь узла его не поднимает').not.toBe(r.nodeState!.el + r.depth - 1);
  });

  it('контроль: то, что герой надеть может, в сумке — в счёте (R7-02), и строка вызова — по нему же', () => {
    const power = cfg.get('balance').power;
    const { room, ws, pid, save } = makeRoom(12);
    wearMagic(save);
    const chest = structuredClone(save.equipment.chest!);
    chest.uid = 'loot-chest'; chest.rarity = 'unique'; chest.pos = { x: 0, y: 0 }; chest.gridW = 1; chest.gridH = 1;
    save.inventory.push(chest);
    const withBag = effectiveLevel(save, { ...power, gearDivisor: 1, gearMax: 99 }, save.inventory).total;
    expect(withBag, 'уникальная в сумке сильнее надетой').toBeGreaterThan(effectiveLevel(save, { ...power, gearDivisor: 1, gearMax: 99 }).total);
    inner(room).movedAt = 0;
    room.descend(pid);
    expect(inner(room).nodeState?.el).toBe(effectiveLevel(save, power, save.inventory).total);
    const r = inner(room);
    expect(ws.last('areaChanged')!.floor.challengeLevel).toBe(floorChallengeLevel(cfg, r.difficultyId, r.depth));
    expect(ws.last('areaChanged')!.floor.challengeLevel, 'Г1: уровень монстров = номер этажа, мощь в сумке его не двигает').toBe(r.depth);
  });

  it('город: уровня вызова в кадре нет — там нет узла', () => {
    const { ws } = makeRoom(5);
    const joined = ws.frames.find((f) => f.t === 'joined') as Extract<ServerFrame, { t: 'joined' }> | undefined;
    expect(joined?.floor.area).toBe('town');
    expect(joined?.floor.challengeLevel).toBeUndefined();
  });
});

describe('⚠ R8-12 / ⭐⭐ Ф7 (17.10): ИЗ ГОРОДА МОДИФИКАТОРОВ НЕ БЫВАЕТ ВОВСЕ — даже подделанным вызовом', () => {
  /**
   * ⚠⚠ ПОЧЕМУ ЭТО СТАЛО ВАЖНЕЕ. До Ф5 выбор города был безвредным: эффекты не применялись нигде, и сторож ловил
   * лишь дубли и «не действует». После Ф5-0 эффекты ДЕЙСТВУЮТ, и тот же набор «опасность + благо», за который на
   * алтаре метки платят ПЕЧАТЬЮ и получают только на ОДИН отрезок, приезжал бы из кадра спуска ДАРОМ и сразу на
   * весь забег — то есть печати были бы налогом для тех, кто играет честно.
   *
   * Закрыто ПРАВИЛОМ: поля нет ни в схеме кадра, ни в типе выбора, и сервер его не спрашивает (`altarOf`).
   * Поэтому замер идёт ПОДДЕЛАННЫМ вызовом (мимо типа): так сторож ловит возврат поля любым путём.
   */
  it('⭐ 32 × «Реликвия алчности» подделанным вызовом — ни в конфиг забега, ни в план, ни в этажи', () => {
    const { room, ws, pid } = makeRoom(5);
    room.descend(pid, 'easy', undefined, { modifiers: Array(32).fill('relic-greed') } as never);
    const r = inner(room);
    expect(r.area).toBe('dungeon');
    expect(r.runConfig!.modifiers, 'модификаторы доехали до конфига забега').toEqual([]);
    expect(r.runPlan!.runModifiers, 'и до плана').toEqual([]);
    expect(ws.last('areaChanged')!.floor.floorModifiers ?? [], 'и до этажа').not.toContain('relic-greed');
  });

  it('⭐⭐ и ЧЕСТНЫЙ выбор опасности с благом из города тоже не проходит — это цена печати, а не галочка', () => {
    const { room, ws, pid } = makeRoom(5);
    // Пара «опасность + благо» — ровно то, что `pickRunModifiers` раньше пропускал как законную связку.
    room.descend(pid, 'easy', undefined, { modifiers: ['pack-swarm', 'greedy-vault'] } as never);
    const r = inner(room);
    expect(r.runConfig!.modifiers).toEqual([]);
    expect(r.runPlan!.runModifiers).toEqual([]);
    expect(ws.last('areaChanged')!.floor.floorModifiers ?? []).toEqual([]);
  });
});

describe('R8-10: кадр возврата в город', () => {
  it('запись узла ждёт продолжения, но в кадре города уровня вызова нет', () => {
    const { room, ws, pid } = makeRoom(5);
    inner(room).movedAt = 0;
    room.descend(pid);
    expect(ws.last('areaChanged')!.floor.challengeLevel, 'в подземелье — есть').toBeGreaterThan(0);
    const w = (room as unknown as { session: { world: { spawn: { x: number; y: number }; monsters: { hp: number }[]; players: Record<string, { pos: { x: number; y: number } }> } } }).session.world;
    for (const m of w.monsters) m.hp = 0;
    for (let i = 0; i < 3; i++) room.step(false);
    w.players[pid]!.pos = { ...w.spawn };
    inner(room).movedAt = 0;
    room.returnTown(pid);
    expect(inner(room).area).toBe('town');
    expect(inner(room).nodeState, 'запись узла цела').not.toBeNull();
    const f = ws.last('areaChanged')!.floor;
    expect(f.area).toBe('town');
    expect(f.challengeLevel).toBeUndefined();
    expect(f.difficultyId).toBeUndefined();
  });
});
