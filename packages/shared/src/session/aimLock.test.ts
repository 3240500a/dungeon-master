import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { createRng } from '../formulas/rng.js';
import { GameSession, type PlayerInput, type FloorLayout } from './session.js';

/**
 * ⭐ С-аудит F6 (29.10): ВЗГЛЯД НА ЗАМАХЕ ЗАПЕРТ. Удар берёт направление мига НАЧАЛА замаха (его несёт событие `swing`), а не мига разжатия:
 * изменённый клиент больше не доворачивает взмах на цель в последний тик и не держит взгляд по ходу весь замах, обходя штраф бега спиной.
 */
function open(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

describe('⭐ С-аудит F6: взгляд заперт на замахе', () => {
  it('во время замаха ввод взгляда не двигает героя; после замаха — снова двигает', () => {
    const r = new ConfigRegistry(); r.loadAll();
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: open(40, 20), spawn: cellToWorld(5, 10), monsters: [] } as unknown as FloorLayout);
    const p = s.world.players.p1!;
    s.tick(1 / 30, { p1: { ...idle, facing: 0.5 } });
    expect(p.facing).toBeCloseTo(0.5, 6);
    // Начат замах (как его ставит удар): взгляд — тот, с которым начали.
    p.windup = { kind: 'attack', remaining: 10, loadout: '' } as typeof p.windup;
    for (const f of [2.5, -1.7, 3.0]) {
      s.tick(1 / 30, { p1: { ...idle, facing: f } });
      expect(p.facing, `замах идёт — взгляд ${f} не принят`).toBeCloseTo(0.5, 6);
    }
    p.windup = null;
    s.tick(1 / 30, { p1: { ...idle, facing: -1.2 } });
    expect(p.facing, 'замаха нет — взгляд снова от ввода').toBeCloseTo(-1.2, 6);
  });

  it('⭐ С-аудит F3: источник печатей сервера не перезаводится входом на этаж', () => {
    const r = new ConfigRegistry(); r.loadAll();
    const src = createRng(123);
    const s = new GameSession(r, 7, 'normal', { sealRng: src });
    const layout = { grid: open(20, 10), spawn: cellToWorld(5, 5), monsters: [], runId: 'run-1' } as unknown as FloorLayout;
    s.enterFloor(3, layout);
    const inner = s as unknown as { sealRng: unknown };
    expect(inner.sealRng, 'после входа на этаж — тот же источник').toBe(src);
    s.enterFloor(3, layout);
    expect(inner.sealRng, 'и после повторного входа на тот же этаж').toBe(src);
    // Без источника (сим, тесты) — прежний сидовый поток этажа, воспроизводимый.
    const sim = new GameSession(r, 7, 'normal');
    sim.enterFloor(3, layout);
    const a = (sim as unknown as { sealRng: { float(): number } }).sealRng.float();
    sim.enterFloor(3, layout);
    expect((sim as unknown as { sealRng: { float(): number } }).sealRng.float(), 'сим: тот же этаж — тот же поток').toBe(a);
  });
});
