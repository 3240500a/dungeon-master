import type { Rng } from '../../formulas/rng.js';
import type { FloorAlgoParams } from '../../config/schemas.js';
import type { DungeonLayout } from '../floorCommon.js';

/** Опции прохода алгоритма. `lock` — ставить ли замок дверь↔рычаг на выход (только boss). */
export interface FloorAlgoOpts {
  lock?: boolean;
}

/**
 * Один «сырой» проход генерации этажа (без гарантии проходимости — её обеспечивает
 * `generateFloor` через `validate` + перегенерацию). Алгоритм читает СВОИ параметры
 * из дискриминированного `FloorAlgoParams` (по `algorithm`).
 */
export type FloorAlgorithm = (params: FloorAlgoParams, rng: Rng, opts?: FloorAlgoOpts) => DungeonLayout;
