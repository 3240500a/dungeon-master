import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams, RoomPrefab } from '../../config/schemas.js';
import type { DungeonLayout } from '../floorCommon.js';

/** Опции прохода алгоритма. `lock` — замок дверь↔рычаг на выход (boss); `prefabs` — библиотека
 *  рукотворных префабов (room-scope для вставки комнат; floor-scope для алгоритма prefab). */
export interface FloorAlgoOpts {
  lock?: boolean;
  prefabs?: RoomPrefab[];
  /** ⭐ 13.10: свой поток rng ширины коридоров (`seed ^ CORRIDOR_WIDTH_STREAM` попытки, `generateFloorParams`) — читается, только если у
   *  параметров есть диапазон ширины (`corridorWidthMax`, `corridorWidths`); без него этаж байт-в-байт прежний. */
  corridorRng?: Rng;
}

/**
 * Один «сырой» проход генерации этажа (без гарантии проходимости — её обеспечивает
 * `generateFloor` через `validate` + перегенерацию). Алгоритм читает СВОИ параметры
 * из дискриминированного `FloorAlgoParams` (по `algorithm`).
 */
export type FloorAlgorithm = (params: FloorAlgoParams, rng: Rng, opts?: FloorAlgoOpts) => DungeonLayout;
