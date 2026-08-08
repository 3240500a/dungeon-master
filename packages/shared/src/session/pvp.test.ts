import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { Cell, TILE, makeGrid, cellToWorld, worldToCell, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { arenaLayout } from '../dungeon/arena.js';
import { GameSession, type PlayerInput, type SessionEvent, type FloorLayout } from './session.js';

function reg(): ConfigRegistry { const r = new ConfigRegistry(); r.loadAll(); return r; }
function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

/** Два игрока-воина бок о бок; p1 бьёт p2. `pvp` — режим арены. Возвращает мир/сущности + события. */
function duel(pvp: boolean, prep?: (s: GameSession) => void): { events: SessionEvent[]; hpDrop: number; deaths: string[] } {
  const r = reg();
  const s = new GameSession(r, 42, 'normal');
  const p1 = s.addPlayer('p1', newBotSave(r, 'warrior'));
  const p2 = s.addPlayer('p2', newBotSave(r, 'warrior'));
  const grid = openField(20, 12);
  const layout: FloorLayout = { grid, spawn: cellToWorld(6, 6), monsters: [], pvp };
  s.enterFloor(1, layout);
  p1.pos = cellToWorld(6, 6);
  p2.pos = cellToWorld(7, 6); // одна клетка правее — в радиусе взмаха
  prep?.(s);
  const facing = Math.atan2(p2.pos.y - p1.pos.y, p2.pos.x - p1.pos.x);
  const hpBefore = p2.hp;
  const events: SessionEvent[] = [];
  for (let i = 0; i < 200; i++) events.push(...s.tick(1 / 30, { p1: { ...idle, facing, attack: true }, p2: { ...idle } }));
  return { events, hpDrop: hpBefore - p2.hp, deaths: events.filter((e) => e.type === 'player-died').map((e) => (e as { playerId: string }).playerId) };
}

describe('PvP — урон игрок↔игрок в арене', () => {
  it('в арене атака игрока ранит другого игрока', () => {
    const { hpDrop } = duel(true);
    expect(hpDrop).toBeGreaterThan(0);
  });

  it('вне арены атака игрока НЕ задевает другого игрока', () => {
    const { hpDrop, deaths } = duel(false);
    expect(hpDrop).toBe(0);
    expect(deaths).not.toContain('p2');
  });

  it('смерть в PvP даёт событие player-died (низкий HP цели)', () => {
    const { deaths } = duel(true, (s) => { s.world.players['p2']!.hp = 3; });
    expect(deaths).toContain('p2');
    expect(deaths).not.toContain('p1');
  });

  it('спавн-иммунитет держит урон', () => {
    const { hpDrop } = duel(true, (s) => { s.world.players['p2']!.spawnImmuneUntil = 1e9; });
    expect(hpDrop).toBe(0);
  });
});

describe('арена — геометрия круглого зала', () => {
  it('спавны на полу, в противоположных концах; центр — пол, углы — стены', () => {
    const a = arenaLayout(20);
    expect(a.spawns.length).toBe(2);
    for (const sp of a.spawns) {
      const c = worldToCell(sp.x, sp.y);
      expect(a.grid[c.cy]![c.cx]).toBe(Cell.Floor); // спавн стоит на полу
    }
    // Противоположные концы — далеко друг от друга (≈ через весь зал).
    expect(Math.hypot(a.spawns[0]!.x - a.spawns[1]!.x, a.spawns[0]!.y - a.spawns[1]!.y)).toBeGreaterThan(10 * TILE);
    expect(a.grid[10]![10]).toBe(Cell.Floor); // около центра — пол
    expect(a.grid[0]![0]).toBe(Cell.Wall);    // угол — стена (вне круга)
  });
});
