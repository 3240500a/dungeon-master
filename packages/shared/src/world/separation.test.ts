import { describe, it, expect } from 'vitest';
import { resolveEntityCollisions, type CollisionBody } from './separation.js';
import { Cell, makeGrid, TILE, type Grid } from './grid.js';

function open(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}
const dist = (a: CollisionBody, b: CollisionBody): number => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);

describe('resolveEntityCollisions', () => {
  const grid = open(30, 30);
  const mid = 15 * TILE;

  it('раздвигает пересекающиеся круги ~на сумму радиусов', () => {
    const a: CollisionBody = { pos: { x: mid, y: mid }, radius: 12, mass: 100 };
    const b: CollisionBody = { pos: { x: mid + 6, y: mid }, radius: 12, mass: 100 };
    resolveEntityCollisions([a, b], grid, 4);
    expect(dist(a, b)).toBeGreaterThanOrEqual(24 - 0.5);
  });

  it('тяжёлого двигает меньше, лёгкого — больше', () => {
    const light: CollisionBody = { pos: { x: mid, y: mid }, radius: 12, mass: 100 };
    const heavy: CollisionBody = { pos: { x: mid + 6, y: mid }, radius: 12, mass: 900 };
    const lx = light.pos.x, hx = heavy.pos.x;
    resolveEntityCollisions([light, heavy], grid, 2);
    expect(Math.abs(light.pos.x - lx)).toBeGreaterThan(Math.abs(heavy.pos.x - hx));
  });

  it('совпавшие центры расходятся без NaN', () => {
    const a: CollisionBody = { pos: { x: mid, y: mid }, radius: 12, mass: 100 };
    const b: CollisionBody = { pos: { x: mid, y: mid }, radius: 12, mass: 100 };
    resolveEntityCollisions([a, b], grid, 3);
    expect(Number.isFinite(a.pos.x) && Number.isFinite(b.pos.x)).toBe(true);
    expect(dist(a, b)).toBeGreaterThan(0);
  });

  it('толчок у стены клампится (центр не ближе радиуса к стене)', () => {
    const floorEdge = 1 * TILE; // столбец 0 — стена
    const a: CollisionBody = { pos: { x: floorEdge + 12, y: mid }, radius: 12, mass: 100 };
    const b: CollisionBody = { pos: { x: floorEdge + 16, y: mid }, radius: 12, mass: 100 };
    resolveEntityCollisions([a, b], grid, 4);
    expect(a.pos.x).toBeGreaterThanOrEqual(floorEdge + 12 - 0.5);
    expect(b.pos.x).toBeGreaterThanOrEqual(floorEdge + 12 - 0.5);
  });

  it('кластер: после достаточных релаксаций пары разведены (мягкий солвер сходится)', () => {
    const bodies: CollisionBody[] = [];
    for (let i = 0; i < 6; i++) bodies.push({ pos: { x: mid + i, y: mid + i * 0.5 }, radius: 12, mass: 100 });
    // В игре сепарация идёт каждый тик; для теста прогоняем достаточно итераций до сходимости.
    resolveEntityCollisions(bodies, grid, 40);
    let minPair = Infinity;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) minPair = Math.min(minPair, dist(bodies[i]!, bodies[j]!));
    }
    expect(minPair).toBeGreaterThan(22); // почти сумма радиусов (24)
  });
});
