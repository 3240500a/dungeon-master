import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { generateFloorParams } from './generateFloor.js';
import { Cell, cellToWorld, makeGrid, type Grid } from '../world/grid.js';
import { GameSession, type PlayerInput, type SessionEvent } from '../session/session.js';
import { newBotSave } from '../sim/playerBot.js';

/**
 * ⭐ Сундук — второй источник добычи, с ритмом, противоположным монстрам: вещь ГАРАНТИРОВАННО,
 * ЦЕЛАЯ и любого слота. Без него после Ч4 перчатки, сапоги, пояс и украшения остались бы
 * практически без источника (монстры носят только оружие, нагрудник, щит и шлем).
 */

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const chestOpts = { tiers: reg.get('chests'), perFloor: reg.get('balance').loot.chestsPerFloor };
/** Параметры этажа из первого описания конфига — тот же путь, что у сервера. */
const params = reg.get('floors')[0]!.algoParams;

function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

describe('сундуки на этаже', () => {
  it('ставятся, и их число в рамках конфига', () => {
    const per = reg.get('balance').loot.chestsPerFloor;
    for (let seed = 1; seed <= 30; seed++) {
      const L = generateFloorParams(params, seed, { chests: chestOpts });
      expect(L.chests.length).toBeGreaterThanOrEqual(Math.min(per.min, 1));
      expect(L.chests.length).toBeLessThanOrEqual(Math.max(per.max, 1) + 2); // +сокровищницы
      for (const c of L.chests) expect(reg.get('chests').some((t) => t.id === c.tier)).toBe(true);
    }
  });

  it('⚠ без конфига сундуков этаж генерится как раньше — геометрия не зависит от них', () => {
    const a = generateFloorParams(params, 7, {});
    const b = generateFloorParams(params, 7, { chests: chestOpts });
    expect(a.chests).toEqual([]);
    expect(b.grid).toEqual(a.grid);          // свой поток rng: сундуки не сдвигают карту
    expect(b.rooms.length).toBe(a.rooms.length);
  });

  it('сундук не ставится в комнате входа — иначе награда не заставляет никуда идти', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const L = generateFloorParams(params, seed, { chests: chestOpts });
      const entrance = L.rooms.find((r) => r.type === 'entrance');
      if (!entrance) continue;
      const c = { cx: Math.floor(entrance.x + entrance.w / 2), cy: Math.floor(entrance.y + entrance.h / 2) };
      const w = cellToWorld(c.cx, c.cy);
      expect(L.chests.some((ch) => ch.x === w.x && ch.y === w.y)).toBe(false);
    }
  });

  it('⭐ открытие даёт ЦЕЛУЮ вещь гарантированно', () => {
    const s = new GameSession(reg, 11, 'normal');
    const p = s.addPlayer('p1', newBotSave(reg, 'warrior'));
    const spawn = cellToWorld(6, 6);
    const chest = cellToWorld(6, 7); // соседняя клетка — внутри радиуса
    s.enterFloor(1, { grid: openField(20, 12), spawn, monsters: [], chests: [{ id: 1, x: chest.x, y: chest.y, tier: 'plain' }] });

    const all: SessionEvent[] = [];
    all.push(...s.tick(1 / 30, { p1: { ...idle, interact: true } }));
    const dropped = all.filter((e) => e.type === 'item-dropped');
    expect(dropped.length).toBeGreaterThan(0);
    for (const e of dropped) expect(e.type === 'item-dropped' && e.item.broken).toBeFalsy();
    expect(all.some((e) => e.type === 'chest-opened')).toBe(true);
    expect(p.alive).toBe(true);
  });

  it('⚠ второй раз тот же сундук не открывается', () => {
    const s = new GameSession(reg, 12, 'normal');
    s.addPlayer('p1', newBotSave(reg, 'warrior'));
    const spawn = cellToWorld(6, 6);
    const chest = cellToWorld(6, 7);
    s.enterFloor(1, { grid: openField(20, 12), spawn, monsters: [], chests: [{ id: 1, x: chest.x, y: chest.y, tier: 'plain' }] });
    expect(s.openChest('p1', 1)).toBe(true);
    expect(s.openChest('p1', 1)).toBe(false);
    expect(s.world.chests[0]!.opened).toBe(true);
  });

  it('⚠ издалека не открыть — это анти-чит, как у рычага', () => {
    const s = new GameSession(reg, 13, 'normal');
    s.addPlayer('p1', newBotSave(reg, 'warrior'));
    const far = cellToWorld(17, 9);
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(3, 3), monsters: [], chests: [{ id: 1, x: far.x, y: far.y, tier: 'rare' }] });
    expect(s.openChest('p1', 1)).toBe(false);
    expect(s.world.chests[0]!.opened).toBe(false);
  });

  it('редкий сундук даёт больше вещей, чем простой', () => {
    const count = (tier: string, seed: number): number => {
      const s = new GameSession(reg, seed, 'normal');
      s.addPlayer('p1', newBotSave(reg, 'warrior'));
      const c = cellToWorld(6, 7);
      s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [], chests: [{ id: 1, x: c.x, y: c.y, tier }] });
      s.openChest('p1', 1);
      return s.world.drops.length;
    };
    let plain = 0;
    let rare = 0;
    for (let seed = 1; seed <= 20; seed++) { plain += count('plain', seed); rare += count('rare', seed); }
    expect(rare).toBeGreaterThan(plain);
  });
});
