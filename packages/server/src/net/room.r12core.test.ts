import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, effectiveLevel, forgeUpgrade, generateItem, shapeFoundWeapon, createRng,
  type ServerFrame, type SaveState, type Item,
} from '@dm/shared';
import { limits } from './rateLimit.js';

// Команды комната исполняет асинхронно (оборотами цикла): под нагрузкой полного прогона умолчание 5 с — лотерея.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Раунд 12 (ядро): то, что правка ядра обязана довезти через настоящую `Room`. R12-09 — вещь, поднятая у кузнеца, хранит уровень
 * НАХОДКИ, и мощь героя мерила её по нему: комплект, найденный на 5-м уровне и поднятый до t4, заселял узлы героя 60-го уровня
 * как голый (EL 61 против 66 у того же комплекта, найденного на t4). Сокет — фейковый, база — заглушка.
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const r of rooms.splice(0)) r.stop(); });

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void { /* комнату дёргают напрямую */ }
  onClose(): void { /* не проверяется */ }
}
type RoomIn = { area: string; movedAt: number; nodeState: { el: number } | null };
const inner = (room: Room): RoomIn => room as unknown as RoomIn;
let seq = 0;
function makeRoom(level: number): { room: Room; pid: string; save: SaveState } {
  const charId = `char-r12c-${++seq}`;
  const userId = `user-${charId}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(userId);
  const room = new RoomCtor('R12C', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(room);
  const save = newCharacterSave(cfg, 'warrior', 'Герой', charId);
  save.level = level;
  const pid = room.addPlayer(new FakeWs() as unknown as GameConn, userId, save, 1);
  // `addPlayer` кладёт в мир копию сейва — дальше работаем с живой.
  const live = (room as unknown as { session: { world: { players: Record<string, { save: SaveState }> } } }).session.world.players[pid]!.save;
  return { room, pid, save: live };
}

describe('⭐ R12-09: узел заселяется по ступени поднятых у кузнеца вещей, а не по уровню их находки', () => {
  const KIT = { weapon: 'long-sword', offhand: 'buckler', helm: 'leather-cap', chest: 'leather-armor', gloves: 'leather-gloves', boots: 'leather-boots', belt: 'leather-belt' } as const;

  /** Редкая, найдена на 5-м уровне (t0), поднята до t4 НАСТОЯЩИМ `forgeUpgrade`. Требования сняты: мощь их не читает у надетого. */
  function forgedUp(baseId: string): Item {
    const bal = cfg.get('balance');
    const it = shapeFoundWeapon(cfg, generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'), {
      dropBias: 1, itemLevel: 5, tierLevel: 5, baseId, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), rareNames: cfg.get('rare-names'),
      forceRarity: 'rare', maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
    }, createRng(baseId.length * 13)));
    const bag = { gold: 1e9, inventory: [{ ...it, pos: { x: 0, y: 0 } }] } as unknown as SaveState;
    const wallet = Object.fromEntries(cfg.get('craft-materials').map((m) => [m.id, 99_999]));
    while (bag.inventory[0]!.tier !== 't4') expect(forgeUpgrade(cfg, bag, it.uid, wallet).ok, baseId).toBe(true);
    return { ...bag.inventory[0]!, pos: null, requirements: {} };
  }

  it('герой 60-го уровня в комплекте, поднятом до t4: EL узла — как у того же комплекта, найденного на t4', () => {
    const power = cfg.get('balance').power;
    const { room, pid, save } = makeRoom(60);
    const t4 = cfg.get('item-tiers').find((t) => t.id === 't4')!;
    const twin = structuredClone(save);
    for (const [slot, id] of Object.entries(KIT)) {
      const it = forgedUp(id);
      expect(it.itemLevel).toBe(5);
      (save.equipment as Record<string, Item>)[slot] = it;
      (twin.equipment as Record<string, Item>)[slot] = { ...it, itemLevel: t4.minItemLevel };
    }
    const found = effectiveLevel(twin, power, twin.inventory).total;
    expect(found, 'комплект t4 весит').toBeGreaterThan(effectiveLevel(save, power, save.inventory).total);
    inner(room).movedAt = 0;
    room.descend(pid);
    expect(inner(room).area).toBe('dungeon');
    expect(inner(room).nodeState?.el, 'было: по уровню находки — как голый').toBeGreaterThanOrEqual(found);
    expect(inner(room).nodeState?.el).toBe(effectiveLevel(save, power, save.inventory, cfg.get('item-tiers')).total);
  });
});
