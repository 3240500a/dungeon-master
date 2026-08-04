import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams, RoomPrefab } from '../../config/schemas.js';
import type { DungeonLayout } from '../floorCommon.js';

/** Опции прохода алгоритма. `lock` — замок дверь↔рычаг на выход (boss); `prefabs` — библиотека
 *  рукотворных префабов (room-scope для вставки комнат; floor-scope для алгоритма prefab). */
export interface FloorAlgoOpts {
  lock?: boolean;
  prefabs?: RoomPrefab[];
}

/**
 * Один «сырой» проход генерации этажа (без гарантии проходимости — её обеспечивает
 * `generateFloor` через `validate` + перегенерацию). Алгоритм читает СВОИ параметры
 * из дискриминированного `FloorAlgoParams` (по `algorithm`).
 */
export type FloorAlgorithm = (params: FloorAlgoParams, rng: Rng, opts?: FloorAlgoOpts) => DungeonLayout;
