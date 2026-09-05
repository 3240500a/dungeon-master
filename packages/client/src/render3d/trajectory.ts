/**
 * ТРАЕКТОРИИ (Ф10) — путь выбранной кости за клип, прямо во вьюпорте (как Trajectories в Cascadeur).
 *
 * Зачем: по позам в тайм-лайне не видно ДУГИ. Рука может идти «по прямой» между двумя правильными ключами,
 * и на манекене это выглядит нормально покадрово, но в движении читается как механика. Траектория показывает
 * форму пути и — по РАССТОЯНИЮ МЕЖДУ ТОЧКАМИ — скорость: сетка времени равномерная, значит точки густо =
 * медленно, редко = быстро. Это тот же приём, что и в Cascadeur, и он бесплатный: сэмплим уже готовый клип.
 *
 * Модуль чистый (сетка времён и метрики). Съём мировых позиций и отрисовка линии — в редакторе:
 * там для этого нужен манекен, а тащить сцену в тестируемый модуль незачем.
 */
import type { Clip } from './clipModel.js';
import { clipDur } from './clipModel.js';

/** Точка сетки: время и, если она ровно на ключе, его индекс (иначе −1). */
export interface TrajSample { t: number; key: number }

/**
 * Времена для съёмки: КЛЮЧИ ВСЕГДА В СЕТКЕ (иначе точка-ключ не совпала бы с изломом линии),
 * между ними — `per` промежуточных. Клип без длительности даёт один сэмпл, а не пустоту.
 */
export function trajectorySamples(clip: Clip, per = 5): TrajSample[] {
  const ks = clip.keys;
  if (!ks.length) return [];
  if (ks.length === 1 || clipDur(clip) <= 1e-6) return [{ t: ks[0]!.t, key: 0 }];
  const n = Math.max(1, Math.floor(per));
  const out: TrajSample[] = [];
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!.t, b = ks[i + 1]!.t;
    out.push({ t: a, key: i });
    for (let s = 1; s <= n; s++) out.push({ t: a + (b - a) * (s / (n + 1)), key: -1 });
  }
  out.push({ t: ks[ks.length - 1]!.t, key: ks.length - 1 });
  return out;
}

/** Длина ломаной (юниты рига) — читаут «сколько прошла кисть», удобно сверять удары между собой. */
export function polylineLength(pts: readonly (readonly [number, number, number])[]): number {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    sum += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return sum;
}

/**
 * Насколько путь ИЗОГНУТ: 1 = прямая (в т.ч. «туда и обратно» по той же линии), больше = дуга.
 * Полукруг ≈ 1.57, полный круг ≈ 1.57 — число читается одинаково для открытых и замкнутых движений.
 *
 * Почему не «длина / хорда»: удары у нас начинаются и кончаются В СТОЙКЕ, хорда там ≈ 0, и любой замах
 * показывал бы ×1.00 (проверено на `hit_axe_r_01`). Поэтому эталон — РАЗМАХ: для вернувшегося в старт пути
 * это удвоенное максимальное удаление от начала, для открытого — хорда.
 */
export function arcRatio(pts: readonly (readonly [number, number, number])[]): number {
  if (pts.length < 2) return 1;
  const a = pts[0]!, b = pts[pts.length - 1]!;
  const d = (p: readonly number[], q: readonly number[]): number => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
  let far = 0;
  for (const q of pts) far = Math.max(far, d(a, q));
  if (far < 1e-6) return 1;                                    // путь стоит на месте
  const closed = d(a, b) < far * 0.1;                          // вернулись в старт → эталон «туда и обратно»
  const ref = closed ? far * 2 : d(a, b);
  return polylineLength(pts) / Math.max(ref, 1e-6);
}

/** Максимальное удаление от стартовой точки (юниты) — «размах» движения. */
export function excursion(pts: readonly (readonly [number, number, number])[]): number {
  const a = pts[0]; if (!a) return 0;
  let far = 0;
  for (const q of pts) far = Math.max(far, Math.hypot(q[0] - a[0], q[1] - a[1], q[2] - a[2]));
  return far;
}
