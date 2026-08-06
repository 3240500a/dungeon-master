import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { GameSession, type PlayerInput, type FloorLayout } from './session.js';

function reg(): ConfigRegistry { const r = new ConfigRegistry(); r.loadAll(); return r; }
function open(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

describe('коллизии сущностей в сессии', () => {
  it('монстры, заспавненные в одной точке, расталкиваются (не слипаются)', () => {
    const r = reg();
    const s = new GameSession(r, 42, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior')); // игрок далеко → монстры в покое, не преследуют
    const grid = open(30, 20);
    const spawn = cellToWorld(3, 10);
    const mrng = createRng(5);
    const baseId = r.get('biomes')[0]!.monsterPool[0]!;
    const mk = () => generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 1 }, mrng);
    const at = cellToWorld(20, 10); // далеко от игрока (в покое)
    const monsters = [
      { def: mk(), x: at.x, y: at.y },
      { def: mk(), x: at.x + 2, y: at.y },       // почти в той же точке
      { def: mk(), x: at.x, y: at.y + 2 },
    ];
    s.enterFloor(1, { grid, spawn, monsters } as FloorLayout);

    for (let i = 0; i < 30; i++) s.tick(1 / 30, { p1: idle });

    const ms = s.world.monsters;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const d = Math.hypot(ms[i]!.pos.x - ms[j]!.pos.x, ms[i]!.pos.y - ms[j]!.pos.y);
        expect(d).toBeGreaterThan(ms[i]!.radius); // больше не в одной точке
      }
    }
  });

  it('выключенные коллизии (balance.collision.enabled=false) не расталкивают', () => {
    const r = reg();
    r.reload({ balance: { ...r.get('balance'), collision: { enabled: false, iterations: 2, uniqueWeightMult: 2 } } });
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = open(30, 20);
    const spawn = cellToWorld(3, 10);
    const mrng = createRng(1);
    const baseId = r.get('biomes')[0]!.monsterPool[0]!;
    const mk = () => generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 1 }, mrng);
    const at = cellToWorld(20, 10);
    s.enterFloor(1, { grid, spawn, monsters: [{ def: mk(), x: at.x, y: at.y }, { def: mk(), x: at.x + 2, y: at.y }] } as FloorLayout);
    for (let i = 0; i < 10; i++) s.tick(1 / 30, { p1: idle });
    const [a, b] = s.world.monsters;
    expect(Math.hypot(a!.pos.x - b!.pos.x, a!.pos.y - b!.pos.y)).toBeLessThan(a!.radius); // остались слипшимися
  });
});
