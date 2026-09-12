import type { SaveState } from '../types/save.js';

export interface DeathSummary {
  goldLost: number;
  itemsLost: number;
  /** Единиц сырья, рассыпанных при смерти (стеки теряют долю, а не пропадают целиком). */
  materialsLost: number;
}

/** Поля баланса штрафа смерти (структурно ⊆ balance.deathPenalty). */
export interface DeathPenaltyBalance {
  goldPercent: number;
  inventoryDropPercent: number;
  /** Какая доля СТЕКА сырья теряется, если он попал под раздачу. См. пояснение в функции. */
  materialStackLossPercent: number;
}

/** Бросок для выбора жертв — детерминизм по сиду важен и для тестов, и для воспроизводимости. */
export interface DeathRng { int(min: number, max: number): number }

/**
 * АВТОРИТЕТНЫЙ штраф за смерть над `SaveState`: теряется доля золота и доля
 * НЕэкипированного инвентаря (первые предметы списка). Экипировка/стеш/пояс СОХРАНЯЮТСЯ.
 * hp сущности НЕ трогает — возрождение решает сессия/комната (соло → город; кооп → на
 * следующем этаже). Возвращает сводку потерь для окна смерти. Порт клиентского
 * `death/penalty.ts` (потерянного при переходе на сервер) — см. docs/MULTIPLAYER.md.
 */
export function applyDeathPenalty(save: SaveState, penalty: DeathPenaltyBalance, rng?: DeathRng): DeathSummary {
  const goldLost = Math.floor(save.gold * penalty.goldPercent);
  save.gold = Math.max(0, save.gold - goldLost);

  const n = Math.floor(save.inventory.length * penalty.inventoryDropPercent);
  let itemsLost = 0;
  let materialsLost = 0;
  // ⚠ Жертвы выбираются СЛУЧАЙНО, а не «первые по списку». Прежний `splice(0, N)` означал, что
  // потери решает порядок в сумке: подобранное раньше терялось первым. Игрок этой логики не видит
  // и читает её как баг — особенно когда стек из 800 железа «почему-то» всегда пропадает.
  const idx = save.inventory.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = rng ? rng.int(0, i) : i;
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const doomed = new Set(idx.slice(0, n));
  const keep: typeof save.inventory = [];
  save.inventory.forEach((it, i) => {
    if (!doomed.has(i)) { keep.push(it); return; }
    // ⭐ Стек сырья теряет ПОЛОВИНУ, а не пропадает целиком: стек — это не «одна вещь», и
    // лотерея «весь запас забега или ничего» ощущалась бы как поломка, а не как цена смерти.
    if (it.kind === 'material') {
      const have = it.count ?? 1;
      const lost = Math.max(1, Math.round(have * penalty.materialStackLossPercent));
      materialsLost += Math.min(lost, have);
      const left = have - lost;
      if (left > 0) { it.count = left; keep.push(it); }
      return;
    }
    itemsLost++;
  });
  save.inventory = keep;
  return { goldLost, itemsLost, materialsLost };
}
