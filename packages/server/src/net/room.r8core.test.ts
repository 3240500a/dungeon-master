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
 * герою не надеть, а строка «вызов ур.» клиента получает уровень заселения узла (R8-10); выбор алтаря без дублей и без
 * модификаторов, чей эффект игра не применяет (R8-12). Сокет — фейковый, база — заглушка.
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

describe('⭐ R8-10: мощь узла — по тому, что герою надеть, и «вызов ур.» клиента — уровень заселения', () => {
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

  it('редкие находки этажа, которые герой не может надеть, в сумке — узел заселён по надетому, как и без них', async () => {
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
    // Строка «вызов ур.» — уровень, по которому заселён узел, и тир забега.
    const floor = ws.last('areaChanged')!.floor;
    const r = inner(room);
    expect(floor.difficultyId).toBe(r.difficultyId);
    expect(floor.challengeLevel).toBe(floorChallengeLevel(cfg, r.nodeState!.el, r.difficultyId, r.depth));
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
    expect(ws.last('areaChanged')!.floor.challengeLevel).toBe(floorChallengeLevel(cfg, r.nodeState!.el, r.difficultyId, r.depth));
  });

  it('город: уровня вызова в кадре нет — там нет узла', () => {
    const { ws } = makeRoom(5);
    const joined = ws.frames.find((f) => f.t === 'joined') as Extract<ServerFrame, { t: 'joined' }> | undefined;
    expect(joined?.floor.area).toBe('town');
    expect(joined?.floor.challengeLevel).toBeUndefined();
  });
});

describe('⚠ R8-12: выбор алтаря — без дублей и без модификаторов, чей эффект игра не применяет', () => {
  it('⭐ 32 × «Реликвия алчности» — ни в конфиг забега, ни в план, ни в этажи', () => {
    const { room, ws, pid } = makeRoom(5);
    room.descend(pid, 'easy', undefined, { templateId: 'crypt-short', modifiers: Array(32).fill('relic-greed') });
    const r = inner(room);
    expect(r.area).toBe('dungeon');
    expect(r.runConfig!.modifiers).toEqual([]);
    expect(r.runPlan!.runModifiers).toEqual([]);
    expect(ws.last('areaChanged')!.floor.floorModifiers ?? []).not.toContain('relic-greed');
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
