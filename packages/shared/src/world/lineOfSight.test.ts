import { describe, it, expect } from 'vitest';
import { Cell, makeGrid, cellToWorld, TILE, type Grid } from './grid.js';
import { hasLineOfSight } from './lineOfSight.js';
import { moveWithCollision, type Vec2 } from './movement.js';

/**
 * ⚠ R10-02: «ДИАГОНАЛЬНЫЙ ШОВ» — две клетки пола, касающиеся только углом, обе боковые — стены. Bresenham шагал по диагонали
 * сразу в дальнюю клетку и боковых не смотрел: видимость проходила, а тело (круг) угол не проходит никогда. Монстр видел героя,
 * в обход не шёл (путь ищется только без видимости) и застревал у угла в 37–42 px — дальше своего удара (30–33), а мили героя
 * (52 px) доставал через угол: безопасная точка на половине этажей подземелья.
 */
describe('⚠ R10-02: диагональный шов не просвечивает', () => {
  /** Поле 10×10 пола; `walls` — клетки-стены. */
  const field = (...walls: [number, number][]): Grid => {
    const g = makeGrid(10, 10, Cell.Floor);
    for (const [x, y] of walls) g[y]![x] = Cell.Wall;
    return g;
  };
  const los = (g: Grid, a: [number, number], b: [number, number]): boolean => {
    const p = cellToWorld(a[0], a[1]), q = cellToWorld(b[0], b[1]);
    return hasLineOfSight(g, p.x, p.y, q.x, q.y);
  };

  it('⭐ пол (5,5) и (6,6), стены (6,5) и (5,6) — не видно; в обе стороны и по всем четырём диагоналям', () => {
    expect(los(field([6, 5], [5, 6]), [5, 5], [6, 6])).toBe(false);
    expect(los(field([6, 5], [5, 6]), [6, 6], [5, 5])).toBe(false);
    expect(los(field([4, 5], [5, 6]), [5, 5], [4, 6])).toBe(false);
    expect(los(field([6, 5], [5, 4]), [5, 5], [6, 4])).toBe(false);
    expect(los(field([4, 5], [5, 4]), [5, 5], [4, 4])).toBe(false);
  });

  it('одна боковая стена — видно (тело проходит, скользя по стене)', () => {
    expect(los(field([6, 5]), [5, 5], [6, 6])).toBe(true);
    expect(los(field([5, 6]), [5, 5], [6, 6])).toBe(true);
    expect(los(field(), [5, 5], [6, 6])).toBe(true);
  });

  it('шов посреди длинной линии тоже режет её; колонна (Pillar) и закрытая дверь — такие же стены', () => {
    expect(los(field([4, 3], [3, 4]), [1, 1], [7, 7])).toBe(false);
    const g = field();
    g[3]![4] = Cell.Pillar;
    g[4]![3] = Cell.Door;
    expect(los(g, [1, 1], [7, 7])).toBe(false);
    g[4]![3] = Cell.Floor;   // дверь открыта — проход есть
    expect(los(g, [1, 1], [7, 7])).toBe(true);
  });

  it('⭐ правило совпадает с телами: через шов не проходит круг, с одной стеной — проходит', () => {
    const push = (g: Grid, from: Vec2, to: Vec2, r: number): Vec2 => {
      let p = from;
      for (let i = 0; i < 300; i++) {
        const dx = to.x - p.x, dy = to.y - p.y, d = Math.hypot(dx, dy);
        if (d < 1) break;
        const v = Math.min(90, d * 30);   // последний шаг — ровно в цель, без перелёта
        p = moveWithCollision(p, { x: (dx / d) * v, y: (dy / d) * v }, r, g, 1 / 30);
      }
      return p;
    };
    const a = cellToWorld(5, 5), b = cellToWorld(6, 6);
    for (const r of [12, 14, 15]) {
      const sealed = push(field([6, 5], [5, 6]), a, b, r);
      expect(Math.floor(sealed.x / TILE) === 6 && Math.floor(sealed.y / TILE) === 6, `r=${r}: шов`).toBe(false);
      const open = push(field([6, 5]), a, b, r);
      expect(Math.hypot(open.x - b.x, open.y - b.y), `r=${r}: одна стена`).toBeLessThan(1);
    }
  });
});
