import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { GameSession, type PlayerInput } from './session.js';
import { serializeWorld } from './serialize.js';

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
    const def = generateMonster(r.get('monsters'), r.get('monster-affixes'),
      { baseId: r.get('dungeons')[0]!.monsterPool[0]!, depth: 1 }, createRng(1));
    const mp = cellToWorld(7, 6);
    s.enterFloor(1, { grid: field(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: mp.x, y: mp.y }] });
    s.tick(1 / 30, { p1: idle, p2: idle });

    const snap = serializeWorld(s.world);
    expect(snap.players.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect(snap.players[0]).toHaveProperty('classId');
    expect(snap.players[0]).not.toHaveProperty('save'); // тяжёлый сейв не едет
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
