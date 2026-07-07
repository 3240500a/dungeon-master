/**
 * Сетка инвентаря — тонкий реэкспорт каноничной чистой версии из `@dm/shared`
 * (одна модель для клиента и авторитетного сервера). Логика — там.
 */
export {
  type Dims,
  cellFree,
  findFree,
  packInventory,
  addToInventory,
  hasSpace,
  itemsOverlapping,
  placeWithDisplacement,
} from '@dm/shared';
