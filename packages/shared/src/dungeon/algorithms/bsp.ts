import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams } from '../../config/schemas.js';
import { Cell, makeGrid, cellToWorld } from '../../world/grid.js';
import {
  type DungeonLayout, type Room,
  roomCenter, dist2, carveRoom, carveCorridorSmart, lockRoom, decorate,
} from '../floorCommon.js';

interface Rect { x: number; y: number; w: number; h: number }
interface BspNode { rect: Rect; left?: BspNode; right?: BspNode; room?: Room }

/** Рекурсивно делит прямоугольник ПО ДЛИННОЙ оси, РЕЗ ближе к центру (0.4–0.6) — против «слайверов». */
function split(rect: Rect, depth: number, minLeaf: number, rng: Rng): BspNode {
  const node: BspNode = { rect };
  const canH = rect.w >= minLeaf * 2;
  const canV = rect.h >= minLeaf * 2;
  if (depth <= 0 || (!canH && !canV)) return node;
  let horizontal: boolean;
  if (canH && canV) horizontal = rect.w >= rect.h * 1.15 ? true : rect.h >= rect.w * 1.15 ? false : rng.chance(0.5);
  else horizontal = canH;
  // Рез в центральной трети [0.4..0.6], но не ближе minLeaf к краям.
  const cutIn = (len: number): number => {
    const lo = Math.max(minLeaf, Math.floor(len * 0.4));
    const hi = Math.min(len - minLeaf, Math.ceil(len * 0.6));
    return rng.int(Math.min(lo, hi), Math.max(lo, hi));
  };
  if (horizontal) {
    const cut = cutIn(rect.w);
    node.left = split({ x: rect.x, y: rect.y, w: cut, h: rect.h }, depth - 1, minLeaf, rng);
    node.right = split({ x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h }, depth - 1, minLeaf, rng);
  } else {
    const cut = cutIn(rect.h);
    node.left = split({ x: rect.x, y: rect.y, w: rect.w, h: cut }, depth - 1, minLeaf, rng);
    node.right = split({ x: rect.x, y: rect.y + cut, w: rect.w, h: rect.h - cut }, depth - 1, minLeaf, rng);
  }
  return node;
}

function leaves(node: BspNode, out: BspNode[]): void {
  if (node.left || node.right) {
    if (node.left) leaves(node.left, out);
    if (node.right) leaves(node.right, out);
  } else out.push(node);
}

/** Все комнаты поддерева. */
function collectRooms(node: BspNode, out: Room[]): void {
  if (node.room) out.push(node.room);
  if (node.left) collectRooms(node.left, out);
  if (node.right) collectRooms(node.right, out);
}
/** Ближайшая пара комнат из двух поддеревьев (короткий чистый коридор). */
function nearestPair(left: BspNode, right: BspNode): [Room, Room] | null {
  const ls: Room[] = [], rs: Room[] = [];
  collectRooms(left, ls); collectRooms(right, rs);
  if (!ls.length || !rs.length) return null;
  let best: [Room, Room] | null = null, bd = Infinity;
  for (const a of ls) for (const b of rs) { const d = dist2(a, b); if (d < bd) { bd = d; best = [a, b]; } }
  return best;
}
/** Соединяет БЛИЖАЙШИЕ комнаты левого/правого поддерева умным коридором (меньше режет чужие комнаты). */
function connect(node: BspNode, grid: DungeonLayout['grid'], allRooms: Room[], rng: Rng): void {
  if (node.left) connect(node.left, grid, allRooms, rng);
  if (node.right) connect(node.right, grid, allRooms, rng);
  if (node.left && node.right) {
    const pair = nearestPair(node.left, node.right);
    if (pair) carveCorridorSmart(grid, pair[0], pair[1], allRooms, rng);
  }
}

/**
 * Алгоритм BSP: бинарное разбиение (рез к центру, деление длинной оси) → комнаты в листьях с зазорами
 * → соединение ближайших комнат умными коридорами → 1–2 петли. Связность гарантирована деревом.
 */
export function bspAlgorithm(params: FloorAlgoParams, rng: Rng, opts?: { lock?: boolean }): DungeonLayout {
  if (params.algorithm !== 'bsp') throw new Error('bspAlgorithm: неверные параметры');
  const lock = opts?.lock ?? true;
  const { cols, rows, splitDepth, minLeaf, roomPad } = params;
  const grid = makeGrid(cols, rows, Cell.Wall);

  const root = split({ x: 1, y: 1, w: cols - 2, h: rows - 2 }, splitDepth, minLeaf, rng);
  const leafNodes: BspNode[] = [];
  leaves(root, leafNodes);

  const rooms: Room[] = [];
  for (const leaf of leafNodes) {
    const r = leaf.rect;
    const maxW = r.w - roomPad * 2, maxH = r.h - roomPad * 2;
    if (maxW < 4 || maxH < 4) continue; // лист слишком мал под комнату
    // Комнаты заполняют 0.5–0.85 листа → зазоры между комнатами (более «рукотворно»).
    const w = rng.int(Math.max(4, Math.floor(maxW * 0.5)), Math.max(4, Math.floor(maxW * 0.85)));
    const h = rng.int(Math.max(4, Math.floor(maxH * 0.5)), Math.max(4, Math.floor(maxH * 0.85)));
    const x = r.x + roomPad + rng.int(0, Math.max(0, maxW - w));
    const y = r.y + roomPad + rng.int(0, Math.max(0, maxH - h));
    const room: Room = { x, y, w, h, type: 'small' };
    leaf.room = room;
    rooms.push(room);
  }

  const n = rooms.length;
  if (n === 0) {
    const room: Room = { x: 2, y: 2, w: cols - 4, h: rows - 4, type: 'entrance' };
    carveRoom(grid, room);
    const c = roomCenter(room);
    const st = cellToWorld(c.cx + 1, c.cy);
    return { grid, rooms: [room], spawn: cellToWorld(c.cx, c.cy), stairsDown: st, exits: [st], decor: [], doors: [], levers: [] };
  }

  // Роли: entrance = 0, boss = самая дальняя, treasure = ещё одна, large по площади.
  let farIdx = 0, farD = -1;
  for (let i = 1; i < n; i++) { const d = dist2(rooms[0]!, rooms[i]!); if (d > farD) { farD = d; farIdx = i; } }
  const treasureIdx = n > 3 ? (farIdx === 1 ? 2 : 1) : -1;
  rooms.forEach((r, i) => {
    r.type = i === 0 ? 'entrance' : i === farIdx ? 'boss' : i === treasureIdx ? 'treasure' : (r.w * r.h >= 80 ? 'large' : 'small');
  });
  for (const r of rooms) carveRoom(grid, r);
  connect(root, grid, rooms, rng);

  // Петли: 1–2 доп. коридора между близкими не-босс комнатами (не-древовидная связность).
  if (n > 3) {
    const cand: [number, number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (i === farIdx || j === farIdx) continue; // босс — не в петлях (запирается)
      cand.push([i, j, dist2(rooms[i]!, rooms[j]!)]);
    }
    cand.sort((a, b) => a[2] - b[2]);
    const loops = Math.min(2, Math.max(1, Math.floor(n * 0.12)));
    // Берём пары чуть дальше самых близких (те обычно уже соединены деревом).
    for (let k = 0; k < loops && k + 2 < cand.length; k++) {
      const [i, j] = cand[k + 2]!;
      carveCorridorSmart(grid, rooms[i]!, rooms[j]!, rooms, rng);
    }
  }

  const doors: DungeonLayout['doors'] = [];
  const levers: DungeonLayout['levers'] = [];
  const boss = farIdx !== 0 ? rooms[farIdx] : undefined;
  if (boss && lock) lockRoom(grid, boss, doors, levers, rng);

  const decor: DungeonLayout['decor'] = [];
  for (const r of rooms) decorate(r, decor, rng, grid);

  const first = roomCenter(rooms[0]!);
  const last = roomCenter(boss ?? rooms[0]!);
  const stairsDown = cellToWorld(last.cx, last.cy);
  return {
    grid, rooms,
    spawn: cellToWorld(first.cx, first.cy),
    stairsDown, exits: [stairsDown],
    decor, doors, levers,
  };
}
