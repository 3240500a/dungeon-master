import { describe, it, expect } from 'vitest';
import { generateDungeon } from './generate.js';
import { Cell, gridSize, worldToCell, type Grid } from '../world/grid.js';

/** Клетки, достижимые от (sx,sy) только по полу (двери/стены — барьеры). */
function reachable(grid: Grid, sx: number, sy: number): Set<string> {
  const { cols, rows } = gridSize(grid);
  const seen = new Set<string>([`${sx},${sy}`]);
  const q: [number, number][] = [[sx, sy]];
  for (let h = 0; h < q.length; h++) {
    const [x, y] = q[h]!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (grid[ny]![nx] !== Cell.Floor) continue;
      const k = `${nx},${ny}`;
      if (!seen.has(k)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

describe('generateDungeon — гарантия проходимости (инвариант)', () => {
  it('на сотнях сидов: каждый рычаг достижим при закрытых дверях, у каждой двери есть рычаг, лестница достижима', () => {
    for (let i = 0; i < 300; i++) {
      const depth = 1 + (i % 8);
      const L = generateDungeon(5000 + i, depth);
      const s = worldToCell(L.spawn.x, L.spawn.y);
      const st = worldToCell(L.stairsDown.x, L.stairsDown.y);

      // (1) каждый рычаг достижим от входа при ВСЕХ закрытых дверях (рычаг не за дверью)
      const closed = reachable(L.grid, s.cx, s.cy);
      for (const lv of L.levers) {
        const c = worldToCell(lv.x, lv.y);
        expect(closed.has(`${c.cx},${c.cy}`)).toBe(true);
      }
      // (2) у каждой двери есть свой рычаг (иначе её не открыть → софт-лок)
      for (const d of L.doors) expect(L.levers.some((lv) => lv.doorId === d.id)).toBe(true);
      // (3) лестница достижима, когда все двери открыты
      const g = L.grid.map((r) => r.slice());
      for (const d of L.doors) for (const c of d.cells) g[c.cy]![c.cx] = Cell.Floor;
      expect(reachable(g, s.cx, s.cy).has(`${st.cx},${st.cy}`)).toBe(true);
    }
  });

  it('детерминирован при одном сиде', () => {
    const a = generateDungeon(123, 3);
    const b = generateDungeon(123, 3);
    expect(a.stairsDown).toEqual(b.stairsDown);
    expect(a.spawn).toEqual(b.spawn);
    expect(a.doors.length).toBe(b.doors.length);
    expect(a.levers.length).toBe(b.levers.length);
  });
});
