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

import type { MonsterGearRoll } from '../types/world.js';

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

// ── Трофей по ВСЕМ слотам, а не только по надетым ────────────────────────────────────────────────

/**
 * ⭐ С МОНСТРА ПАДАЕТ И ТО, ЧЕГО НА НЁМ НЕ ВИДНО — кольца, амулеты, пояса, перчатки, сапоги.
 *
 * Иначе пять слотов из девяти живут только сундуками: монстры носят лишь оружие, нагрудник,
 * щит и шлем. Но ненадетое выбирается НЕ наугад — оно подчиняется «стилю» монстра: с зомби
 * в кожаной броне не падают латные перчатки, с латника — тряпичные.
 *
 * Так сохраняется главное обещание системы («по виду врага понятно, что с него выпадет»)
 * и при этом закрываются все слоты.
 */

/** Во что монстр одет — по классу его брони. Нагрудник главнее шлема: он крупнее и заметнее. */
export function trophyProfile(
  rolls: readonly MonsterGearRoll[] | undefined,
  gearById: (id: string) => TrophySource | undefined,
): { armorClass?: string } {
  let fromHelm: string | undefined;
  for (const r of rolls ?? []) {
    const g = r.gearId ? gearById(r.gearId) : undefined;
    if (!g || g.kind !== 'armor' || !g.armorClass) continue;
    if ((g.slot ?? 'chest') === 'chest') return { armorClass: g.armorClass };
    fromHelm ??= g.armorClass;
  }
  return { armorClass: fromHelm };
}

/** Слоты брони, по которым раскладывается категория `armor`. */
const ARMOR_SLOTS = ['chest', 'helm', 'gloves', 'boots', 'belt'] as const;

/**
 * База трофея с конкретного монстра: категория по весам (`loot.categoryWeights`), затем слот,
 * затем база. Надетый слот берёт ВЕЩЬ МОНСТРА (через сходство), ненадетый — базу того же класса
 * брони. Расходники в трофеи не идут: их роняет не труп, а сундук.
 */
export function monsterTrophyBase(
  rolls: readonly MonsterGearRoll[] | undefined,
  gearById: (id: string) => TrophySource | undefined,
  bases: readonly TrophyCandidate[],
  rng: PickRng,
  categoryWeights: Record<string, number> = {},
): string | undefined {
  const usable = bases.filter((b) => b.enabled !== false && b.kind !== 'consumable');
  if (!usable.length) return undefined;
  const wornOf = (pred: (g: TrophySource) => boolean): TrophySource | undefined => {
    for (const r of rolls ?? []) {
      const g = r.gearId ? gearById(r.gearId) : undefined;
      if (g && pred(g)) return g;
    }
    return undefined;
  };
  const pick = <T>(arr: readonly T[]): T | undefined => (arr.length ? arr[rng.int(0, arr.length - 1)] : undefined);

  // Категория — взвешенно. Ноль весов (или все нулевые) → равномерно по тому, что есть.
  const cats = ['weapon', 'armor', 'shield', 'jewelry'] as const;
  const have = cats.filter((c) => usable.some((b) => b.kind === c));
  if (!have.length) return undefined;
  const total = have.reduce((s, c) => s + Math.max(0, categoryWeights[c] ?? 0), 0);
  let cat = have[have.length - 1]!;
  if (total > 0) {
    let r = rng.int(1, Math.round(total));
    for (const c of have) { r -= Math.max(0, categoryWeights[c] ?? 0); if (r <= 0) { cat = c; break; } }
  } else {
    cat = pick(have)!;
  }

  if (cat === 'weapon') {
    const worn = wornOf((g) => g.kind === 'weapon');
    return worn ? trophyBaseFor(worn, usable, rng) : pick(usable.filter((b) => b.kind === 'weapon'))?.id;
  }
  if (cat === 'shield') {
    const worn = wornOf((g) => g.kind === 'shield');
    return worn ? trophyBaseFor(worn, usable, rng) : pick(usable.filter((b) => b.kind === 'shield'))?.id;
  }
  if (cat === 'jewelry') {
    // У украшений класса брони нет — стиль монстра на них не влияет, и это нормально.
    return pick(usable.filter((b) => b.kind === 'jewelry'))?.id;
  }

  const slot = ARMOR_SLOTS[rng.int(0, ARMOR_SLOTS.length - 1)]!;
  const worn = wornOf((g) => g.kind === 'armor' && (g.slot ?? 'chest') === slot);
  if (worn) return trophyBaseFor(worn, usable, rng);
  // ⚠ Ненадетый слот — в СТИЛЕ монстра: с кожаного зомби не падают латные перчатки.
  // Нет базы такого класса в этом слоте (контент не полон) — берём любую, но слот держим.
  const cls = trophyProfile(rolls, gearById).armorClass;
  const inSlot = usable.filter((b) => b.kind === 'armor' && b.slot === slot);
  const styled = cls ? inSlot.filter((b) => b.armorClass === cls) : [];
  return (pick(styled) ?? pick(inSlot))?.id;
}
