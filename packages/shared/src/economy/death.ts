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

/** Бросок для выбора жертв и дробной доли потерь — детерминизм по сиду важен и для тестов, и для воспроизводимости. */
export interface DeathRng { int(min: number, max: number): number; chance(p: number): boolean }

/**
 * ⚠ R5-21: ДОЛЯ — БРОСКОМ, А НЕ ВНИЗ (как множитель сырья с монстров): целая часть `raw` теряется всегда, дробная — с её
 * вероятностью, и в среднем уходит ровно настроенная доля при любом размере. Без броска — ближайшее целое. Допуск 1e-9:
 * 10 × 0.3 в плавающей — это 3.0000000000000004, а не «три с хвостиком». Одно правило — числу жертв и доле стека (R13-13).
 */
function byChance(raw: number, rng?: DeathRng): number {
  const whole = Math.floor(raw + 1e-9);
  const frac = raw - whole > 1e-9 ? raw - whole : 0;
  return whole + (frac > 0 && (rng ? rng.chance(frac) : frac >= 0.5) ? 1 : 0);
}

/**
 * АВТОРИТЕТНЫЙ штраф за смерть над `SaveState`: теряется доля золота и доля
 * НЕэкипированного инвентаря (жертвы — случайные, дробная доля — броском). Экипировка/стеш/пояс СОХРАНЯЮТСЯ.
 * hp сущности НЕ трогает — возрождение решает сессия/комната (соло → город; кооп → на
 * следующем этаже). Возвращает сводку потерь для окна смерти. Порт клиентского
 * `death/penalty.ts` (потерянного при переходе на сервер) — см. docs/MULTIPLAYER.md.
 */
export function applyDeathPenalty(save: SaveState, penalty: DeathPenaltyBalance, rng?: DeathRng): DeathSummary {
  // ⭐ R11-04: смерть — следующая жизнь с полными пулами: записанные здоровье и мана (`vitals`) к ней не относятся (штраф взят).
  // ⭐ R22-04: а откаты умений — время героя, не тела (D4): смерть их не обнуляет, иначе «погиб — и клич готов» в новой комнате.
  const cd = save.vitals?.cd;
  if (cd && Object.keys(cd).length) save.vitals = { cd, ...(save.vitals?.at !== undefined ? { at: save.vitals.at } : {}) };
  else delete save.vitals;
  const goldLost = Math.floor(save.gold * penalty.goldPercent);
  save.gold = Math.max(0, save.gold - goldLost);

  // ⚠ R5-21: ДОЛЯ — БРОСКОМ, А НЕ ВНИЗ (`byChance`): `floor` оставлял одну вещь в сумке без риска вовсе (0 потерь при доле
  // 0.5), а нечётная сумка всегда теряла меньше: из трёх — одну (33 %), из пяти — две.
  const n = byChance(save.inventory.length * penalty.inventoryDropPercent, rng);
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
    // ⚠ R13-13: и эта доля — броском (`byChance`), как число жертв. Было `max(1, round(n × доля))`: вверх от половины и не
    // меньше единицы, и при живых 0.5 × 0.5 (цель — четверть любого стека) одна единица теряла 50 %, три — 33 %, пять — 30 %:
    // мелкий запас (ценное сырьё высокой ступени) платил за смерть до двух настроенных долей. Бросок оставил всё — стек цел.
    if (it.kind === 'material') {
      const have = it.count ?? 1;
      const lost = Math.min(have, byChance(have * penalty.materialStackLossPercent, rng));
      materialsLost += lost;
      const left = have - lost;
      if (left > 0) { if (lost > 0) it.count = left; keep.push(it); }
      return;
    }
    itemsLost++;
  });
  save.inventory = keep;
  return { goldLost, itemsLost, materialsLost };
}
