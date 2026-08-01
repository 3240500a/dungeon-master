import { createRng } from '../formulas/rng.js';
import { Cell, makeGrid, cellToWorld } from '../world/grid.js';
import { type DungeonLayout, type Room, carveRoom, carveCorridor, roomCenter } from './floorCommon.js';

/**
 * Компактный город-хаб (rest-узел): ОДНА центральная комната-вход (spawn + портал в город + сундук)
 * и РОВНО `exitCount` комнат-выходов вокруг, каждая соединена коротким коридором с входом. Без
 * промежуточных комнат, без монстров и замков. Проходимость — по конструкции. `exits[i]` = центр
 * i-й комнаты-выхода (соответствует i-му ребру узла).
 */
export function townFloor(exitCount: number, seed: number): DungeonLayout {
  const rng = createRng((seed >>> 0) || 1);
  const n = Math.max(1, exitCount);
  const R = 11; // радиус кольца комнат-выходов от центра
  const cols = 2 * (R + 5) + 8;
  const rows = 2 * (R + 5) + 6;
  const cx = Math.floor(cols / 2), cy = Math.floor(rows / 2);
  const grid = makeGrid(cols, rows, Cell.Wall);

  const entrance: Room = { x: cx - 3, y: cy - 3, w: 7, h: 6, type: 'entrance' };
  carveRoom(grid, entrance);
  const rooms: Room[] = [entrance];
  const exits: { x: number; y: number }[] = [];

  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n; // первый выход — вверх, остальные по кругу
    let rx = cx + Math.round(R * Math.cos(ang)) - 2;
    let ry = cy + Math.round(R * Math.sin(ang)) - 2;
    rx = Math.max(1, Math.min(cols - 1 - 5, rx));
    ry = Math.max(1, Math.min(rows - 1 - 4, ry));
    const room: Room = { x: rx, y: ry, w: 5, h: 4, type: 'small' };
    carveRoom(grid, room);
    carveCorridor(grid, entrance, room, rng);
    rooms.push(room);
    const c = roomCenter(room);
    exits.push(cellToWorld(c.cx, c.cy));
  }

  const ec = roomCenter(entrance);
  const decor: DungeonLayout['decor'] = [
    { ...cellToWorld(ec.cx, ec.cy - 1), kind: 'portal' }, // портал в город
    { ...cellToWorld(ec.cx + 2, ec.cy + 1), kind: 'stash' }, // общий сундук
  ];
  const spawn = cellToWorld(ec.cx, ec.cy + 1);

  return {
    grid, rooms,
    spawn,
    stairsDown: exits[0] ?? spawn,
    exits,
    decor, doors: [], levers: [],
  };
}
