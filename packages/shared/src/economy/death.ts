import type { SaveState } from '../types/save.js';

export interface DeathSummary {
  goldLost: number;
  itemsLost: number;
}

/** Поля баланса штрафа смерти (структурно ⊆ balance.deathPenalty). */
export interface DeathPenaltyBalance {
  goldPercent: number;
  inventoryDropPercent: number;
}

/**
 * АВТОРИТЕТНЫЙ штраф за смерть над `SaveState`: теряется доля золота и доля
 * НЕэкипированного инвентаря (первые предметы списка). Экипировка/стеш/пояс СОХРАНЯЮТСЯ.
 * hp сущности НЕ трогает — возрождение решает сессия/комната (соло → город; кооп → на
 * следующем этаже). Возвращает сводку потерь для окна смерти. Порт клиентского
 * `death/penalty.ts` (потерянного при переходе на сервер) — см. docs/MULTIPLAYER.md.
 */
export function applyDeathPenalty(save: SaveState, penalty: DeathPenaltyBalance): DeathSummary {
  const goldLost = Math.floor(save.gold * penalty.goldPercent);
  save.gold = Math.max(0, save.gold - goldLost);
  const itemsLost = Math.floor(save.inventory.length * penalty.inventoryDropPercent);
  if (itemsLost > 0) save.inventory.splice(0, itemsLost);
  return { goldLost, itemsLost };
}
