import { describe, it, expect } from 'vitest';
import { hasLineOfSight } from './lineOfSight.js';
import { Cell, TILE, makeGrid } from './grid.js';

const C = (n: number) => n * TILE + TILE / 2; // центр клетки n

describe('hasLineOfSight', () => {
  it('видит по открытому полу', () => {
    const grid = makeGrid(10, 3, Cell.Floor);
    expect(hasLineOfSight(grid, C(0), C(1), C(9), C(1))).toBe(true);
  });

  it('стена между точками блокирует обзор', () => {
    const grid = makeGrid(10, 3, Cell.Floor);
    grid[1]![5] = Cell.Wall;
    expect(hasLineOfSight(grid, C(0), C(1), C(9), C(1))).toBe(false);
  });

  it('стена сбоку не мешает прямой видимости', () => {
    const grid = makeGrid(10, 3, Cell.Floor);
    grid[0]![5] = Cell.Wall; // другой ряд
    expect(hasLineOfSight(grid, C(0), C(1), C(9), C(1))).toBe(true);
  });

  it('диагональная видимость через открытую зону', () => {
    const grid = makeGrid(6, 6, Cell.Floor);
    expect(hasLineOfSight(grid, C(0), C(0), C(5), C(5))).toBe(true);
  });
});
