import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';

/** Одна запись сложности (из конфига difficulties). */
export type Difficulty = ConfigShapes['difficulties'][number];
/** Веса метрики мощи (balance.power). */
export type PowerConfig = ConfigShapes['balance']['power'];

/** Разбор эффективного уровня персонажа: уровень + гир + пассивы. */
export interface PowerBreakdown {
  level: number;
  gearBonus: number;
  passiveBonus: number;
  /** Итоговый эффективный уровень (EL). */
  total: number;
}

/**
 * «Мощь персонажа» как эффективный уровень (EL) = уровень + бонус за надетый гир
 * (по itemLevel и редкости, с поправкой на актуальность уровню) + бонус за
 * вложенные пассивки. Оба бонуса ограничены каппами из конфига. Чистая функция:
 * используется и клиентом (выбор сложности/лист персонажа), и сервером (анти-чит).
 */
export function effectiveLevel(save: SaveState, cfg: PowerConfig): PowerBreakdown {
  const level = Math.max(1, save.level);

  let gearRaw = 0;
  for (const item of Object.values(save.equipment)) {
    if (!item) continue;
    const weight = cfg.gearRarityWeight[item.rarity] ?? 1;
    // Насколько предмет «в уровень»: перерос уровень не даёт сверх 1.
    const currency = Math.min(1, item.itemLevel / level);
    gearRaw += weight * currency;
  }
  const gearBonus = Math.min(cfg.gearMax, Math.round(gearRaw / cfg.gearDivisor));

  let ranks = 0;
  for (const r of Object.values(save.masteries)) ranks += r;
  const passiveBonus = Math.min(cfg.passiveMax, Math.round(ranks / cfg.passiveDivisor));

  return { level, gearBonus, passiveBonus, total: level + gearBonus + passiveBonus };
}

/** Стартовый challengeLevel забега (этаж 1) от эфф. уровня и выбранной сложности. */
export function startChallenge(effLevel: number, diff: Difficulty): number {
  const cl = diff.offsetMode === 'percent'
    ? effLevel * (1 + diff.offset)
    : effLevel + diff.offset;
  return Math.max(1, Math.round(cl));
}

/** challengeLevel на конкретном этаже (1-based): старт + рамп за глубину. */
export function challengeAtFloor(startCL: number, diff: Difficulty, floor: number): number {
  const f = Math.max(1, floor);
  return Math.max(1, Math.round(startCL + (f - 1) * diff.floorStep));
}

/** Удобный «всё-в-одном»: challengeLevel забега для персонажа на этаже. */
export function runChallengeLevel(
  save: SaveState,
  diff: Difficulty,
  floor: number,
  cfg: PowerConfig,
): number {
  const el = effectiveLevel(save, cfg).total;
  return challengeAtFloor(startChallenge(el, diff), diff, floor);
}

/**
 * Разблокирована ли сложность: тир с unlockFloor > 0 требует, чтобы на предыдущем
 * тире была достигнута глубина ≥ unlockFloor. Тиры идут по порядку списка.
 */
export function isDifficultyUnlocked(
  diffs: Difficulty[],
  index: number,
  progress: Record<string, number>,
): boolean {
  const diff = diffs[index];
  if (!diff || diff.unlockFloor <= 0) return true;
  const prev = diffs[index - 1];
  if (!prev) return true;
  return (progress[prev.id] ?? 0) >= diff.unlockFloor;
}
