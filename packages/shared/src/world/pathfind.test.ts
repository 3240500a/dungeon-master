import { describe, it, expect } from 'vitest';
import { Cell, TILE, makeGrid, cellToWorld, worldToCell, type Grid } from './grid.js';
import { buildNavMask, findPath, navMaskFor, segmentHits, NAV_CELL, NAV_DOWN, NAV_RIGHT } from './pathfind.js';
import type { Obstacle } from './state.js';

/**
 * ⭐ 08.10: навигационная маска декора (`pathfind.ts`) — путь BFS обходит преграды напольного декора (ревью 08.10: монстр без видимости шёл
 * по пути сквозь костёр крипты и стоял у огня 20 с+). Сторожа: какие клетки/рёбра закрывает круг и бокс, обход костра, клетки старта и цели
 * под преградой, коридор у ниши статуи не глухой, без маски — путь прежний, зажатая цель — путь как без маски.
 */
function room(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Wall);
  for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) g[y]![x] = Cell.Floor;
  return g;
}
const cellsOf = (path: { x: number; y: number }[]): string[] => path.map((p) => { const c = worldToCell(p.x, p.y); return `${c.cx},${c.cy}`; });
/** Костёр крипты: круг 0.9 клетки в центре следа 2×2 (угол клеток) — как `placeDressing` в комнате чётной ширины. */
const pitAt = (cx: number, cy: number): Obstacle => ({ x: cx * TILE, y: cy * TILE, shape: 'circle', r: 0.9 * TILE, blocksSight: false });

describe('⭐ 08.10: маска навигации декора', () => {
  it('костёр 2×2 на углу клеток: закрыты четыре клетки следа и рёбра в них; кольцо вокруг и рёбра по кольцу открыты', () => {
    const g = room(12, 12);
    const m = buildNavMask(12, 12, [pitAt(6, 6)])!;
    const at = (x: number, y: number): number => m.bits[y * 12 + x]!;
    for (const [x, y] of [[5, 5], [6, 5], [5, 6], [6, 6]] as const) expect(at(x, y) & NAV_CELL, `клетка ${x},${y}`).toBeTruthy();
    for (let y = 3; y <= 8; y++) for (let x = 3; x <= 8; x++) {
      if (x >= 5 && x <= 6 && y >= 5 && y <= 6) continue;
      expect(at(x, y) & NAV_CELL, `кольцо ${x},${y}`).toBe(0);
    }
    expect(at(4, 5) & NAV_RIGHT, 'ребро кольцо → след').toBeTruthy();
    expect(at(4, 4) & NAV_RIGHT, 'ребро по кольцу').toBe(0);
    expect(at(4, 5) & NAV_DOWN, 'ребро по кольцу (вертикаль)').toBe(0);
    // путь насквозь через костёр — по кольцу
    const p = findPath(g, cellToWorld(2, 5), cellToWorld(9, 5), undefined, m);
    expect(p.length).toBeGreaterThan(0);
    for (const c of cellsOf(p)) expect(['5,5', '6,5', '5,6', '6,6']).not.toContain(c);
    expect(cellsOf(findPath(g, cellToWorld(2, 5), cellToWorld(9, 5))).some((c) => c === '5,5' || c === '6,5'), 'без маски — прямо сквозь').toBe(true);
  });

  it('костёр по центру клетки (комната нечётной ширины): закрыта клетка центра и рёбра сквозь него; соседи открыты', () => {
    const o: Obstacle = { x: 6.5 * TILE, y: 6.5 * TILE, shape: 'circle', r: 0.9 * TILE };
    const m = buildNavMask(13, 13, [o])!;
    const at = (x: number, y: number): number => m.bits[y * 13 + x]!;
    expect(at(6, 6) & NAV_CELL).toBeTruthy();
    for (const [x, y] of [[5, 6], [7, 6], [6, 5], [6, 7], [5, 5], [7, 7]] as const) expect(at(x, y) & NAV_CELL, `${x},${y}`).toBe(0);
    expect(at(5, 5) & NAV_RIGHT, 'ребро (5,5)→(6,5): в 32 px от центра — мимо круга 28.8').toBe(0);
    const p = findPath(room(13, 13), cellToWorld(2, 6), cellToWorld(10, 6), undefined, m);
    expect(cellsOf(p)).not.toContain('6,6');
  });

  it('бокс ниши статуи у стены коридора шириной в клетку: коридор для пути не глухой (тело радиуса 12 проходит)', () => {
    const g = makeGrid(12, 3, Cell.Wall);
    for (let x = 1; x < 11; x++) g[1]![x] = Cell.Floor;
    // ниша на северной стене над клетками (5,1),(6,1): бокс 2 клетки × 0.45 клетки по грани стены (как статуи крипты)
    const statue: Obstacle = { x: 6 * TILE, y: 1 * TILE, shape: 'box', hw: TILE, hh: 0.225 * TILE, yaw: 0 };
    const m = buildNavMask(12, 3, [statue]);
    expect(m === null || (m.bits[1 * 12 + 5]! & NAV_CELL) === 0).toBe(true);
    expect(findPath(g, cellToWorld(1, 1), cellToWorld(10, 1), undefined, m).length).toBe(9);
    expect(segmentHits(statue, 5.5 * TILE, 1.1 * TILE, 5.5 * TILE, 1.1 * TILE)).toBe(true);   // у самой грани — внутри бокса
  });

  it('старт и цель под преградой: из клетки выйти и в клетку цели войти можно (их маска не запирает)', () => {
    const g = room(12, 12);
    const m = buildNavMask(12, 12, [pitAt(6, 6)])!;
    const corner = { x: 5 * TILE + 2, y: 5 * TILE + 2 };   // вытолкнут на внешний угол клетки следа (5,5)
    const out = findPath(g, corner, cellToWorld(9, 9), undefined, m);
    expect(out.length).toBeGreaterThan(0);
    expect(cellsOf(out).slice(0, -1).some((c) => ['5,5', '6,5', '5,6', '6,6'].includes(c))).toBe(false);
    const into = findPath(g, cellToWorld(9, 9), { x: 7 * TILE - 2, y: 7 * TILE - 2 }, undefined, m);   // герой прижат к костру в клетке (6,6)
    expect(cellsOf(into).at(-1)).toBe('6,6');
    expect(cellsOf(into).slice(0, -1).some((c) => ['5,5', '6,5', '5,6'].includes(c))).toBe(false);
  });

  it('обойти нельзя (цель зажата преградами в тупике) — путь как без маски; без маски и с пустой маской — путь байт-в-байт прежний', () => {
    const g = makeGrid(10, 3, Cell.Wall);
    for (let x = 1; x < 9; x++) g[1]![x] = Cell.Floor;
    const plug: Obstacle = { x: 5.5 * TILE, y: 1.5 * TILE, shape: 'circle', r: 12 };   // пробка в коридоре
    const m = buildNavMask(10, 3, [plug])!;
    const a = cellToWorld(1, 1), b = cellToWorld(8, 1);
    expect(findPath(g, a, b, undefined, m)).toEqual(findPath(g, a, b));
    const r = room(14, 10);
    for (const [from, to] of [[[1, 1], [12, 8]], [[3, 7], [10, 2]], [[12, 1], [1, 8]]] as const) {
      const p = cellToWorld(from[0], from[1]), q = cellToWorld(to[0], to[1]);
      expect(findPath(r, p, q, undefined, null)).toEqual(findPath(r, p, q));
      expect(findPath(r, p, q, undefined, buildNavMask(14, 10, []))).toEqual(findPath(r, p, q));
    }
  });

  it('navMaskFor: один расчёт на массив преград; нет преград — null; другой размер этажа — пересчёт', () => {
    const g = room(12, 12);
    const obs = [pitAt(6, 6)];
    const a = navMaskFor(g, obs);
    expect(a).not.toBeNull();
    expect(navMaskFor(g, obs)).toBe(a);
    expect(navMaskFor(g, [])).toBeNull();
    expect(navMaskFor(g, undefined)).toBeNull();
    const b = navMaskFor(room(20, 20), obs);
    expect(b).not.toBe(a);
    expect(b!.cols).toBe(20);
    // маска чужого размера в findPath не применяется
    expect(findPath(room(20, 20), cellToWorld(2, 5), cellToWorld(9, 5), undefined, a)).toEqual(findPath(room(20, 20), cellToWorld(2, 5), cellToWorld(9, 5)));
  });

  it('segmentHits: касание границы — не внутри; отрезок сквозь бокс под поворотом', () => {
    const c: Obstacle = { x: 0, y: 0, shape: 'circle', r: 10 };
    expect(segmentHits(c, -20, 10, 20, 10)).toBe(false);
    expect(segmentHits(c, -20, 9.9, 20, 9.9)).toBe(true);
    const box: Obstacle = { x: 0, y: 0, shape: 'box', hw: 10, hh: 2, yaw: Math.PI / 2 };   // вытянут вдоль y
    expect(segmentHits(box, -5, 8, 5, 8)).toBe(true);
    expect(segmentHits(box, 3, -20, 3, 20)).toBe(false);
    expect(segmentHits(box, -20, 11, 20, 11)).toBe(false);
  });
});
