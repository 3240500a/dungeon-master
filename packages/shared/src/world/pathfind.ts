import { isBlockedCell, worldToCell, cellToWorld, gridSize, type Grid } from './grid.js';
import type { Vec2 } from './movement.js';

/**
 * Поиск пути по сетке (BFS 4-связность) для навигации ботов/ИИ. Возвращает список
 * путевых точек (центры клеток) от старта к цели, исключая стартовую клетку; пусто —
 * если цель недостижима. Чистая функция; клиентский ИИ пока ходит напрямую, ботам
 * сима нужен обход стен, чтобы реально зачищать этажи.
 */
export function findPath(grid: Grid, from: Vec2, to: Vec2, maxNodes = 6000): Vec2[] {
  const { cols, rows } = gridSize(grid);
  if (cols === 0 || rows === 0) return [];
  const start = worldToCell(from.x, from.y);
  const goal = worldToCell(to.x, to.y);
  if (start.cx === goal.cx && start.cy === goal.cy) return [];

  // Если цель в стене (монстр вплотную к стене/за дверью) — целимся в ближайшую
  // проходимую клетку рядом с ней.
  let gx = goal.cx;
  let gy = goal.cy;
  if (isBlockedCell(grid, gx, gy)) {
    const near = nearestOpen(grid, gx, gy);
    if (!near) return [];
    gx = near.cx;
    gy = near.cy;
  }

  const idx = (cx: number, cy: number): number => cy * cols + cx;
  const prev = new Int32Array(cols * rows).fill(-1);
  const seen = new Uint8Array(cols * rows);
  const queue: number[] = [idx(start.cx, start.cy)];
  seen[idx(start.cx, start.cy)] = 1;
  const goalIdx = idx(gx, gy);
  let found = false;
  let visited = 0;

  for (let head = 0; head < queue.length && visited < maxNodes; head++) {
    const cur = queue[head]!;
    visited++;
    if (cur === goalIdx) { found = true; break; }
    const cx = cur % cols;
    const cy = (cur - cx) / cols;
    const neighbors = [
      [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1],
    ] as const;
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = idx(nx, ny);
      if (seen[ni] || isBlockedCell(grid, nx, ny)) continue;
      seen[ni] = 1;
      prev[ni] = cur;
      queue.push(ni);
    }
  }
  if (!found) return [];

  // Реконструкция пути от цели к старту, затем разворот.
  const path: Vec2[] = [];
  let cur = goalIdx;
  const startIdx = idx(start.cx, start.cy);
  while (cur !== startIdx && cur !== -1) {
    const cx = cur % cols;
    const cy = (cur - cx) / cols;
    path.push(cellToWorld(cx, cy));
    cur = prev[cur]!;
  }
  path.reverse();
  return path;
}

/** Ближайшая проходимая клетка к (cx,cy) кольцевым поиском (для целей у стен). */
function nearestOpen(grid: Grid, cx: number, cy: number): { cx: number; cy: number } | null {
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // только кольцо
        if (!isBlockedCell(grid, cx + dx, cy + dy)) return { cx: cx + dx, cy: cy + dy };
      }
    }
  }
  return null;
}
