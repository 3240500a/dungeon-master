import type { FloorAlgorithm } from './types.js';
import { roomsAlgorithm } from './rooms.js';
import { bspAlgorithm } from './bsp.js';
import { cellularAlgorithm } from './cellular.js';
import { mazeAlgorithm } from './maze.js';

/**
 * Реестр поклеточных алгоритмов по id (совпадает с `FloorAlgoParams.algorithm`). Новый биом
 * ссылается на алгоритм этой картой. `prefab` — задел (пока фолбэк на `rooms` в generateFloor).
 */
export const ALGORITHMS: Record<string, FloorAlgorithm> = {
  rooms: roomsAlgorithm,
  bsp: bspAlgorithm,
  cellular: cellularAlgorithm,
  maze: mazeAlgorithm,
};

export type { FloorAlgorithm } from './types.js';
export { roomsAlgorithm } from './rooms.js';
export { bspAlgorithm } from './bsp.js';
export { cellularAlgorithm } from './cellular.js';
export { mazeAlgorithm } from './maze.js';
