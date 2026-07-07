import { describe, it, expect } from 'vitest';
import { Cell, TILE, makeGrid, cellToWorld, isBlockedCell, isWalkableWorld, type Grid } from './grid.js';
import { moveWithCollision, type Vec2 } from './movement.js';
import { hasLineOfSight } from './lineOfSight.js';

/** Коридор: строка `row` из пола на столбцах [x0..x1], всё остальное — стены. */
function corridor(cols: number, rows: number, row: number, x0: number, x1: number): Grid {
  const g = makeGrid(cols, rows, Cell.Wall);
  for (let x = x0; x <= x1; x++) g[row]![x] = Cell.Floor;
  return g;
}

/** Прогоняет N тиков движения с постоянной скоростью. */
function run(pos: Vec2, vel: Vec2, r: number, grid: Grid, ticks: number, dt = 1 / 30): Vec2 {
  let p = pos;
  for (let i = 0; i < ticks; i++) p = moveWithCollision(p, vel, r, grid, dt);
  return p;
}

const R = 14;

describe('grid helpers', () => {
  it('isBlockedCell: стена/дверь/за пределами — непроходимо, пол — проходимо', () => {
    const g = corridor(4, 3, 1, 1, 2);
    expect(isBlockedCell(g, 1, 1)).toBe(false); // пол
    expect(isBlockedCell(g, 0, 1)).toBe(true); // стена
    expect(isBlockedCell(g, 1, 2)).toBe(true); // ряд-стена
    expect(isBlockedCell(g, -1, 1)).toBe(true); // за пределами
    g[1]![1] = Cell.Door;
    expect(isBlockedCell(g, 1, 1)).toBe(true); // закрытая дверь
  });

  it('isWalkableWorld: по пиксельной точке', () => {
    const g = corridor(4, 3, 1, 1, 2);
    const c = cellToWorld(1, 1);
    expect(isWalkableWorld(g, c.x, c.y)).toBe(true);
    const w = cellToWorld(0, 0);
    expect(isWalkableWorld(g, w.x, w.y)).toBe(false);
  });
});

describe('moveWithCollision', () => {
  it('свободно движется по полу', () => {
    const g = corridor(8, 3, 1, 1, 6);
    const start = cellToWorld(2, 1); // (80, 48)
    const p = moveWithCollision(start, { x: 100, y: 0 }, R, g, 0.1);
    expect(p.x).toBeCloseTo(90, 5); // dx = 10
    expect(p.y).toBe(start.y);
  });

  it('упирается в стену и прилипает к её грани (без проникновения)', () => {
    // Пол на столбцах 1..4 → правая стена начинается на столбце 5 (x=160).
    const g = corridor(8, 3, 1, 1, 4);
    const start = cellToWorld(2, 1);
    const p = run(start, { x: 300, y: 0 }, R, g, 60);
    expect(p.x).toBe(5 * TILE - R); // 160 - 14 = 146, ровно у грани
    expect(p.y).toBe(start.y);
  });

  it('скользит вдоль стены: заблокированная ось стоит, свободная идёт', () => {
    // Ряд 1 — пол (столбцы 1..4), ряд 2 — стена снизу.
    const g = corridor(8, 3, 1, 1, 4);
    const start = cellToWorld(1, 1);
    const p = run(start, { x: 200, y: 200 }, R, g, 60);
    expect(p.y).toBe(2 * TILE - R); // прижат к нижней стене: 64 - 14 = 50
    expect(p.x).toBe(5 * TILE - R); // и при этом доехал вправо до стены
    expect(p.x).toBeGreaterThan(start.x); // движение по свободной оси произошло
  });

  it('не выходит за пределы карты', () => {
    const g = corridor(8, 3, 1, 1, 6);
    const start = cellToWorld(2, 1);
    const p = run(start, { x: -500, y: 0 }, R, g, 60);
    expect(p.x).toBe(1 * TILE + R); // прижат к левой стене (столбец 0): 32 + 14 = 46
  });
});

describe('hasLineOfSight', () => {
  it('открытый коридор — видно, стена между — не видно', () => {
    const g = corridor(8, 3, 1, 1, 6);
    const a = cellToWorld(1, 1);
    const b = cellToWorld(6, 1);
    expect(hasLineOfSight(g, a.x, a.y, b.x, b.y)).toBe(true);
    g[1]![3] = Cell.Wall; // стена посередине коридора
    expect(hasLineOfSight(g, a.x, a.y, b.x, b.y)).toBe(false);
  });
});
