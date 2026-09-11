/**
 * ТРОФЕЙ С ТЕЛА — вещь ИГРОКА, похожая на то, что монстр носил.
 *
 * У монстров свой маленький пул снаряжения (`monster-gear`, 22 записи), у игрока свой большой
 * (`items.base`, 80+). Это сделано нарочно: иначе пришлось бы плодить вторую гору предметов
 * и вторую гору 3D-моделей под них. Но падать с трупа обязана вещь, которую игрок может НАДЕТЬ,
 * а не «зомби-топор» из чужого пула.
 *
 * Поэтому снаряжение монстра переводится в БЛИЖАЙШУЮ базу игрока: ржавый топор зомби → топор
 * из пула игрока, кольчуга → кольчуга. Точного соответствия может не быть (у зомби есть
 * метательный топор, у игрока дальнобойных топоров нет) — тогда берётся самое похожее по
 * сходству признаков, а не случайная вещь.
 *
 * ⚠ Соответствие НЕ хардкодится таблицей на 22 строки: она разъезжается при каждой правке
 * контента молча. Считается сходство по полям, а промах лечится явным `trophyBase` в конфиге.
 */

/** Что носил монстр — в части, важной для подбора трофея (структурно ⊆ `monster-gear`). */
export interface TrophySource {
  kind?: string;
  weaponClass?: string;
  armorClass?: string;
  slot?: string;
  hands?: number;
  attackType?: string;
  /** Явная замена: id базы игрока. Пишется в конфиг, когда автоподбор промахнулся. */
  trophyBase?: string;
}

/** База предмета игрока — в части, важной для подбора (структурно ⊆ `items.base`). */
export interface TrophyCandidate {
  id: string;
  enabled?: boolean;
  kind?: string;
  weaponClass?: string;
  armorClass?: string;
  slot?: string;
  hands?: number;
  attackType?: string;
}

/** Бросок для выбора среди одинаково подходящих. */
export interface PickRng { int(min: number, max: number): number }

/**
 * Сходство базы игрока с носимой вещью монстра. Больше — ближе.
 *
 * Веса подобраны так, чтобы КЛАСС вещи перевешивал всё остальное: топор обязан стать топором,
 * даже если по числу рук и дальности лучше подходит копьё. Дальше — число рук (двуручную секиру
 * не подменяем кинжалом), и только потом мелочи.
 * Разный `kind` — не кандидат вовсе: броня не может стать оружием ни при каком сходстве.
 */
export function trophyScore(src: TrophySource, cand: TrophyCandidate): number {
  if (cand.enabled === false) return -1;
  if ((cand.kind ?? '') !== (src.kind ?? '')) return -1;
  let s = 0;
  if (src.kind === 'weapon') {
    if (src.weaponClass && src.weaponClass === cand.weaponClass) s += 100;
    if ((src.hands ?? 1) === (cand.hands ?? 1)) s += 20;
    if (src.attackType && src.attackType === cand.attackType) s += 10;
  } else if (src.kind === 'armor') {
    if (src.armorClass && src.armorClass === cand.armorClass) s += 100;
    // У брони монстра слот может быть не указан — это нагрудник (`u-quilted` и подобные).
    if ((src.slot ?? 'chest') === (cand.slot ?? '')) s += 50;
  }
  return s;
}

/**
 * Трофей с тела: id базы игрока, ближайшей к носимой вещи. `undefined` — подходящей базы нет
 * вовсе (тогда зовущая сторона роняет обычный случайный дроп, а не ничего).
 *
 * Среди одинаково подходящих выбор случайный: у игрока по три топора на каждое число рук,
 * и всегда падающий первый из списка быстро надоел бы.
 */
export function trophyBaseFor(
  src: TrophySource,
  bases: readonly TrophyCandidate[],
  rng: PickRng,
): string | undefined {
  if (src.trophyBase && bases.some((b) => b.id === src.trophyBase)) return src.trophyBase;
  let best = 0;
  let pool: TrophyCandidate[] = [];
  for (const b of bases) {
    const s = trophyScore(src, b);
    if (s < 0) continue;
    if (s > best || !pool.length) { best = s; pool = [b]; } else if (s === best) pool.push(b);
  }
  if (!pool.length) return undefined;
  return pool[rng.int(0, pool.length - 1)]!.id;
}
