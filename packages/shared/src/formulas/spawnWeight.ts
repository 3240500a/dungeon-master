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

/** 6-точечная (по числу тиров) кривая веса монстра: ручной оверрайд или столбец его силового тира. */
export function monsterDepthCurve(m: Monster, tiers: DepthTiers): number[] {
  if (Array.isArray(m.spawnCurve) && m.spawnCurve.length === tiers.length) return m.spawnCurve;
  const key = ((m.tier ?? 'medium') as PowerTier);
  return tiers.map((t) => t.weights[key] ?? 0);
}

/** Вес спавна монстра на этаже `floor`: интерполяция кривой между контрольными этажами (fromFloor). */
export function spawnWeightAt(m: Monster, tiers: DepthTiers, floor: number): number {
  if (!tiers.length) return 1;
  const curve = monsterDepthCurve(m, tiers);
  const xs = tiers.map((t) => t.fromFloor);
  if (floor <= xs[0]!) return Math.max(0, curve[0]!);
  const last = xs.length - 1;
  if (floor >= xs[last]!) return Math.max(0, curve[last]!);
  for (let i = 0; i < last; i++) {
    const a = xs[i]!, b = xs[i + 1]!;
    if (floor >= a && floor <= b) {
      const t = (floor - a) / (b - a || 1);
      return Math.max(0, curve[i]! + (curve[i + 1]! - curve[i]!) * t);
    }
  }
  return Math.max(0, curve[last]!);
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
