import type { ConfigShapes } from '../config/schemas.js';

/**
 * Вес спавна монстра по ГЛУБИНЕ (тиры глубины) — сверх скейла от уровня/гира. Гибрид: кривая монстра
 * автозаполняется по его силовому тиру (столбец `weights[tier]` по рядам depth-tiers) ИЛИ берётся его
 * ручной `spawnCurve`. Вес на конкретном этаже — линейная интерполяция кривой между контрольными
 * этажами тиров (`fromFloor`). Так «этажи 1–3 = почти только weak», а boss копится к бездне. Чистая.
 */

type DepthTiers = ConfigShapes['depth-tiers'];
type Monster = ConfigShapes['monsters'][number];

type PowerTier = 'weak' | 'medium' | 'strong' | 'boss';

/** Настройки кривой «глубина → редкость монстров» (`balance.loot.depthRarity`). */
export interface DepthRarity {
  freeDepth: number; step: number; k: number; maxBoost: number;
  maxRare: number; minNormal: number;
}

/**
 * ВО СКОЛЬКО РАЗ ГЛУБИНА ПОДНИМАЕТ ШАНС МАГИЧЕСКИХ/РЕДКИХ МОНСТРОВ.
 *
 * ⚠ Зачем вообще: ступень сырья задаёт РЕДКОСТЬ надетой на монстре вещи, а глубина в этот расчёт
 * не входит ни одним слагаемым — замер по этажам 1/5/10/20 даёт один и тот же состав. Значит в
 * бесконечном забеге глубина 500 платила бы ровно тем же, чем глубина 5, и спускаться было бы незачем.
 *
 * ⭐ Двигаем РЕДКОСТЬ, а не ступень сырья напрямую. Правило «редкость → ступень» остаётся
 * нетронутым и читаемым (цвет имени монстра видно сразу), одна ручка даёт две награды — сырьё
 * И трофеи, — и объяснять игроку отдельную механику не нужно.
 *
 * ⚠ Обычные забеги не трогаем: до `freeDepth` буст равен единице, а самый длинный шаблон доходит
 * до 15-го этажа. Дальше растёт со степенью `k` (<1) и упирается в `maxBoost` — тот же ручник,
 * что у ступеней вещей. Замер: на глубине 200 состав 10/30/9 против 40/4/1 на пятой, а ОБЪЁМ
 * сырья не меняется вовсе (44…49 за этаж на любой глубине). Глубина покупает КАЧЕСТВО, не
 * количество, — ровно этим Яма в Д4 платит вместо шмота, и ферма «побольше» здесь бессмысленна.
 */
export function depthRarityBoost(depth: number, c: DepthRarity): number {
  const over = depth - c.freeDepth;
  if (over <= 0 || c.step <= 0) return 1;
  return 1 + Math.min(c.maxBoost, Math.pow(over / c.step, c.k));
}

/**
 * Шансы редкости пачки с учётом глубины.
 *
 * ⚠ `minNormal` — НЕ косметика. Перемноженные шансы легко уходят в сумме за единицу, и тогда
 * обычных монстров не остаётся вовсе; вместе с ними умирает ржавое железо, потому что ступень
 * сырья задаёт редкость надетой вещи. То есть глубина убила бы НИЖНЮЮ ступень лестницы, а на ней
 * держится вся починка и первая ступень улучшений. Доля обычных резервируется до всех расчётов,
 * и если magic+rare в неё не влезают — оба ужимаются ПРОПОРЦИОНАЛЬНО, сохраняя их соотношение.
 */
export function rarityAtDepth(
  magicChance: number, rareChance: number, depth: number, c: DepthRarity,
): { magic: number; rare: number } {
  const b = depthRarityBoost(depth, c);
  let rare = Math.min(c.maxRare, Math.max(0, rareChance) * b);
  let magic = Math.max(0, magicChance) * b;
  const room = Math.max(0, 1 - c.minNormal);
  if (rare + magic > room) {
    const k = (rare + magic) > 0 ? room / (rare + magic) : 0;
    rare *= k; magic *= k;
  }
  return { magic, rare };
}

/** 6-точечная (по числу тиров) кривая веса монстра: ручной оверрайд или столбец его силового тира. */
export function monsterDepthCurve(m: Monster, tiers: DepthTiers): number[] {
  if (Array.isArray(m.spawnCurve) && m.spawnCurve.length === tiers.length) return m.spawnCurve;
  const key = ((m.tier ?? 'medium') as PowerTier);
  return tiers.map((t) => t.weights[key] ?? 0);
}

/**
 * Доля слота монстра (`spawnShare`, 0…1; нет поля — 1). ⭐ Двойники — та же заготовка с другим оружием —
 * делят вес источника: доли группы дают в сумме 1, и состав пачек по роли и тиру не сдвигается. Мусор
 * (NaN, минус, больше 1) прижимается в [0, 1]: кривой конфиг не должен раздувать вес монстра.
 */
export function spawnShareOf(m: { spawnShare?: number }): number {
  const s = m.spawnShare;
  if (s === undefined) return 1;
  return Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0;
}

/** Вес спавна монстра на этаже `floor`: интерполяция кривой между контрольными этажами (fromFloor) × доля слота. */
export function spawnWeightAt(m: Monster, tiers: DepthTiers, floor: number): number {
  const share = spawnShareOf(m);
  if (!tiers.length) return share;
  const curve = monsterDepthCurve(m, tiers);
  const xs = tiers.map((t) => t.fromFloor);
  if (floor <= xs[0]!) return Math.max(0, curve[0]!) * share;
  const last = xs.length - 1;
  if (floor >= xs[last]!) return Math.max(0, curve[last]!) * share;
  for (let i = 0; i < last; i++) {
    const a = xs[i]!, b = xs[i + 1]!;
    if (floor >= a && floor <= b) {
      const t = (floor - a) / (b - a || 1);
      return Math.max(0, curve[i]! + (curve[i + 1]! - curve[i]!) * t) * share;
    }
  }
  return Math.max(0, curve[last]!) * share;
}

/**
 * Взвешенный выбор id монстра по весам глубины на этаже. Если суммарный вес 0 (все кривые = 0 на этой
 * глубине) — равномерный фолбэк (спавн не должен пропадать). `rand` ∈ [0,1) (обычно rng.float(0,1)).
 */
export function weightedPickId(
  ids: string[],
  weightOf: (id: string) => number,
  rand: number,
  fallback: (r: number) => string,
): string {
  if (!ids.length) return fallback(rand);
  let total = 0;
  for (const id of ids) total += Math.max(0, weightOf(id));
  if (total <= 0) return fallback(rand);
  let r = rand * total; // ∈ [0, total); строгое r<w → кандидат с весом 0 не выбирается никогда
  for (const id of ids) {
    const w = Math.max(0, weightOf(id));
    if (r < w) return id;
    r -= w;
  }
  return ids[ids.length - 1]!;
}
