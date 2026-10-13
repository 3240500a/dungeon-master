import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { GameSession, type PlayerInput } from './session.js';
import { serializeWorld, peerInfoOf, floorInit } from './serialize.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}
function field(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

describe('serializeWorld / removePlayer', () => {
  it('снапшот содержит игроков и монстров по id, без тяжёлого save', () => {
    const r = reg();
    const s = new GameSession(r, 5, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.addPlayer('p2', newBotSave(r, 'mage'));
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
      { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(1));
    const mp = cellToWorld(7, 6);
    s.enterFloor(1, { grid: field(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: mp.x, y: mp.y }] });
    s.tick(1 / 30, { p1: idle, p2: idle });

    const snap = serializeWorld(s.world);
    expect(snap.players.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect(snap.players[0]).not.toHaveProperty('save'); // тяжёлый сейв не едет
    // Ф1.1: СТАТИКА (класс, имя, макс. HP, радиус, внешность) в снапшоте больше не едет —
    // она уходит отдельным кадром `peerInfo` при входе и при изменении, а не 20 раз в секунду.
    for (const field of ['classId', 'name', 'maxHp', 'r', 'weaponKey', 'armorModels']) {
      expect(snap.players[0]).not.toHaveProperty(field);
    }
    // ...но динамика на месте.
    for (const field of ['x', 'y', 'facing', 'hp', 'mana', 'stamina', 'alive']) {
      expect(snap.players[0]).toHaveProperty(field);
    }
    // ...а статика доступна отдельно.
    const pi = peerInfoOf(s.world.players['p1']!, r);
    expect(pi.id).toBe('p1');
    expect(typeof pi.classId).toBe('string');
    expect(pi.maxHp).toBeGreaterThan(0);
    expect(pi.r).toBeGreaterThan(0);
    expect(snap.monsters.length).toBe(1);
    expect(snap.monsters[0]).toHaveProperty('hp');
    expect(typeof snap.tick).toBe('number');
  });

  it('removePlayer убирает игрока и tick не падает', () => {
    const r = reg();
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.addPlayer('p2', newBotSave(r, 'archer'));
    s.enterFloor(1, { grid: field(20, 12), spawn: cellToWorld(6, 6), monsters: [] });
    s.removePlayer('p1');
    expect(Object.keys(s.world.players)).toEqual(['p2']);
    expect(() => s.tick(1 / 30, { p2: idle })).not.toThrow();
    expect(serializeWorld(s.world).players.map((p) => p.id)).toEqual(['p2']);
  });
});

/**
 * ⭐ 13.10 (владелец: «пусть сундук не пропадает»): `FloorInit.chests` — ВСЕ сундуки этажа, открытый — с `opened: true`, у закрытого поля
 * нет (кадр прежний). Было — открытые отбрасывались, и вошедший посреди этажа / продолжение узла видели комнату без сундука. Открыть его
 * второй раз нельзя ни по id, ни ближайшим ([E] 2D-клиента и бота) — правило ядра, клиент ему не нужен.
 */
describe('⭐ 13.10: floorInit — сундуки этажа все, открытый с `opened: true`', () => {
  it('закрытый — без поля, открытый — с полем и на своём месте; повторное открытие — отказ без добычи', () => {
    const r = reg();
    const s = new GameSession(r, 3, 'normal', { rewards: true });
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    const tier = r.get('chests')[0]!.id;
    const a = cellToWorld(5, 5), b = cellToWorld(12, 5);
    s.enterFloor(3, { grid: field(20, 12), spawn: cellToWorld(6, 6), monsters: [], chests: [{ id: 1, ...a, tier }, { id: 2, ...b, tier }] });
    const before = floorInit('dungeon', s.world, []).chests;
    expect(before).toEqual([{ id: 1, x: a.x, y: a.y, tier }, { id: 2, x: b.x, y: b.y, tier }]);
    for (const c of before) expect(c, 'у закрытого поля нет — кадр прежний').not.toHaveProperty('opened');

    s.world.players.p1!.pos = { ...a };
    expect(s.openChest('p1', 1), 'открылся').toBe(true);
    const dropped = s.world.drops.length;
    expect(dropped, 'высыпал добычу').toBeGreaterThan(0);
    const after = floorInit('dungeon', s.world, []).chests;
    expect(after.map((c) => c.id), 'открытый не пропал').toEqual([1, 2]);
    expect(after[0]).toEqual({ id: 1, x: a.x, y: a.y, tier, opened: true });
    expect(after[1], 'соседний закрытый — без поля').not.toHaveProperty('opened');
    expect(JSON.parse(JSON.stringify(after)), 'по проводу — то же').toEqual(after);

    expect(s.openChest('p1', 1), 'второй раз по id — отказ').toBe(false);
    expect(s.openChest('p1'), 'и ближайшим без id ([E]) — тоже').toBe(false);
    expect(s.world.drops.length, 'второй добычи нет').toBe(dropped);
  });

  it('продолжение узла (`opened` в раскладке) — открыт с первого кадра; город и этаж без сундуков — пусто', () => {
    const r = reg();
    const s = new GameSession(r, 3, 'normal', { rewards: true });
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    const tier = r.get('chests')[0]!.id;
    const a = cellToWorld(5, 5);
    s.enterFloor(3, { grid: field(20, 12), spawn: cellToWorld(6, 6), monsters: [], chests: [{ id: 7, ...a, tier, opened: true }] });
    expect(floorInit('dungeon', s.world, []).chests).toEqual([{ id: 7, x: a.x, y: a.y, tier, opened: true }]);
    s.world.players.p1!.pos = { ...a };
    expect(s.openChest('p1', 7)).toBe(false);
    expect(s.world.drops).toHaveLength(0);
    s.enterFloor(1, { grid: field(20, 12), spawn: cellToWorld(6, 6), monsters: [] });
    expect(floorInit('town', s.world, []).chests).toEqual([]);
  });
});
