import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams } from '../../config/schemas.js';
import { Cell, makeGrid, cellToWorld } from '../../world/grid.js';
import {
  type DungeonLayout, type Room,
  roomCenter, carveRoomShaped, pickShape, connectByNeighborGraph, pickSpawnExit, lockRoom, decorate,
} from '../floorCommon.js';
import { stampRoomPrefab } from '../prefab.js';
import type { FloorAlgoOpts } from './types.js';

/**
 * Алгоритм «комнаты + коридоры» (рефактор исходного генератора): rejection-sampling комнат,
 * MST-связь центров + петли, замок «дверь↔рычаг» на боссе, декор. Параметры (размер/число
 * комнат/шанс большой) приходят из биома, а не из глубины.
 */
export function roomsAlgorithm(params: FloorAlgoParams, rng: Rng, opts?: FloorAlgoOpts): DungeonLayout {
  if (params.algorithm !== 'rooms') throw new Error('roomsAlgorithm: неверные параметры');
  const lock = opts?.lock ?? true;
  const { cols, rows, roomCount, bigChance } = params;
  const grid = makeGrid(cols, rows, Cell.Wall);

  const rooms: Room[] = [];
  let attempts = 0;
  while (rooms.length < roomCount && attempts < 400) {
    attempts++;
    const big = rng.chance(bigChance);
    const w = big ? rng.int(10, 14) : rng.int(5, 8);
    const h = big ? rng.int(8, 11) : rng.int(4, 7);
    const x = rng.int(1, cols - w - 1);
    const y = rng.int(1, rows - h - 1);
    if (rooms.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) continue;
    rooms.push({ x, y, w, h, type: 'small' });
  }

  const n = rooms.length;
  // Спавн/выход — по режиму (по умолчанию самая дальняя пара: старт не в углу, выход разнесён).
  const [spawnIdx, exitIdx] = pickSpawnExit(rooms, params.spawnMode, rng);
  const treasureIdx = n > 3 ? ([0, 1, 2].find((i) => i !== spawnIdx && i !== exitIdx) ?? -1) : -1;
  rooms.forEach((r, i) => {
    r.type = i === spawnIdx ? 'entrance' : i === exitIdx ? 'boss' : i === treasureIdx ? 'treasure' : (r.w * r.h >= 80 ? 'large' : 'small');
    // Форма: спавн/выход — rect (чистые якоря + корректный lockRoom); прочие — по весам.
    r.shape = (i === spawnIdx || i === exitIdx) ? 'rect' : pickShape(params.shapes, rng);
  });
  // Карвинг: с шансом prefabChance ставим рукотворный room-префаб (если подходит по размеру), иначе форма.
  const decor: DungeonLayout['decor'] = [];
  const prefabs = opts?.prefabs ?? [];
  const prefabRooms = new Set<Room>();
  rooms.forEach((r, i) => {
    const anchor = i === spawnIdx || i === exitIdx;
    if (!anchor && params.prefabChance > 0 && prefabs.length && rng.chance(params.prefabChance) && stampRoomPrefab(grid, r, prefabs, decor, rng)) prefabRooms.add(r);
    else carveRoomShaped(grid, r, r.shape ?? 'rect', rng);
  });

  // Связность через граф соседства: проёмы между соседями + короткие коридоры, MST-база + браид-петли
  // (несколько путей старт↔финиш, без параллельных дублей). Запертый босс — вне петель; иначе выход браидим.
  if (n > 1) {
    connectByNeighborGraph(grid, rooms, {
      loops: params.loops,
      excludeIdx: lock ? exitIdx : -1,
      branch: lock ? [spawnIdx] : [spawnIdx, exitIdx],
    }, rng);
  }

  const doors: DungeonLayout['doors'] = [];
  const levers: DungeonLayout['levers'] = [];
  const boss = exitIdx !== spawnIdx ? rooms[exitIdx] : undefined;
  if (boss && lock) lockRoom(grid, boss, doors, levers, rng);

  // Декор: prefab-комнаты уже дали свой (из зон в stampRoomPrefab); прочие — процедурный.
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
