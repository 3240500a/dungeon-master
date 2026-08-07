import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams } from '../../config/schemas.js';
import { Cell, makeGrid, cellToWorld } from '../../world/grid.js';
import {
  type DungeonLayout, type Room,
  roomCenter, carveRoom, carveRoomShaped, pickShape, connectByNeighborGraph, pickSpawnExit, lockRoom, decorate,
} from '../floorCommon.js';
import { stampRoomPrefab } from '../prefab.js';
import type { FloorAlgoOpts } from './types.js';

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

/**
 * Алгоритм BSP: бинарное разбиение (рез к центру, деление длинной оси) → комнаты в листьях с зазорами
 * → связность через граф соседства (проёмы между смежными листьями + браид-петли).
 */
export function bspAlgorithm(params: FloorAlgoParams, rng: Rng, opts?: FloorAlgoOpts): DungeonLayout {
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

  // Спавн/выход — по режиму (по умолчанию самая дальняя пара: старт не в углу, выход разнесён).
  const [spawnIdx, exitIdx] = pickSpawnExit(rooms, params.spawnMode, rng);
  const treasureIdx = n > 3 ? ([0, 1, 2].find((i) => i !== spawnIdx && i !== exitIdx) ?? -1) : -1;
  rooms.forEach((r, i) => {
    r.type = i === spawnIdx ? 'entrance' : i === exitIdx ? 'boss' : i === treasureIdx ? 'treasure' : (r.w * r.h >= params.largeRoomArea ? 'large' : 'small');
    r.shape = (i === spawnIdx || i === exitIdx) ? 'rect' : pickShape(params.shapes, rng);
  });
  // Карвинг: с шансом prefabChance ставим рукотворный room-префаб (если подходит), иначе процедурная форма.
  const decor: DungeonLayout['decor'] = [];
  const prefabs = opts?.prefabs ?? [];
  const prefabRooms = new Set<Room>();
  rooms.forEach((r, i) => {
    const anchor = i === spawnIdx || i === exitIdx;
    if (!anchor && params.prefabChance > 0 && prefabs.length && rng.chance(params.prefabChance) && stampRoomPrefab(grid, r, prefabs, decor, rng)) prefabRooms.add(r);
    else carveRoomShaped(grid, r, r.shape ?? 'rect', rng);
  });
  // Связность через граф соседства: проёмы между смежными листьями + короткие коридоры, MST-база +
  // браид-петли (несколько путей, без параллельных дублей). Запертый босс — вне петель; иначе выход браидим.
  connectByNeighborGraph(grid, rooms, {
    loops: params.loops,
    excludeIdx: lock ? exitIdx : -1,
    branch: lock ? [spawnIdx] : [spawnIdx, exitIdx],
  }, rng);

  const doors: DungeonLayout['doors'] = [];
  const levers: DungeonLayout['levers'] = [];
  const boss = exitIdx !== spawnIdx ? rooms[exitIdx] : undefined;
  if (boss && lock) lockRoom(grid, boss, doors, levers, rng);

  // Декор: prefab-комнаты дали свой (из зон); прочие — процедурный.
  for (const r of rooms) if (!prefabRooms.has(r)) decorate(r, decor, rng, grid);

  const first = roomCenter(rooms[spawnIdx]!);
  const last = roomCenter(boss ?? rooms[spawnIdx]!);
  const stairsDown = cellToWorld(last.cx, last.cy);
  return {
    grid, rooms,
    spawn: cellToWorld(first.cx, first.cy),
    stairsDown, exits: [stairsDown],
    decor, doors, levers,
  };
}
