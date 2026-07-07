/**
 * Сетка мира клиента — теперь тонкий реэкспорт каноничной headless-сетки из
 * `@dm/shared` (одна модель для игры, сима и будущего сервера). Значения `Cell`
 * прежние (Floor=0, Wall=1, Door=2).
 */
export {
  TILE,
  Cell,
  gridSize,
  cellToWorld,
  worldToCell,
  makeGrid,
  cellAt,
  isBlockedCell,
  isWalkableWorld,
  type Grid,
} from '@dm/shared';
