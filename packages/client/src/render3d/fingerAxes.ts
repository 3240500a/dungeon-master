/**
 * ОСИ СУСТАВОВ ПАЛЬЦА — ВЫВОДЯТСЯ ИЗ ГЕОМЕТРИИ, А НЕ ЗАШИТЫ (Ф14.4).
 *
 * Раньше и пределы (`jointLimits.fingerJoints`), и хваты (`gripPoses.gripToPose`) считали, что палец
 * лежит вдоль ±X, а сгибается вокруг Y. Первое верно для нашего процедурного манекена, второе — НЕТ:
 * корни пальцев разложены по Z (Index z=+1.5 … Little z=−1.4), кисть тонкая по Y, значит плоскость
 * ладони — X–Z, и «в кулак» это вращение вокруг Z. Вокруг Y палец уезжал ВБОК по ладони.
 * На импортированной модели всё ещё хуже: там палец смотрит куда угодно, и никакая фиксированная ось
 * не подходит в принципе.
 *
 * Здесь ось выводится из САМИХ КОСТЕЙ, поэтому одна формула работает и на нашем манекене, и на чужом риге:
 *
 *   along      — направление фаланги (офсет её первого ребёнка);
 *   spread     — поперёк ладони (корень мизинца − корень указательного);
 *   palmN      — нормаль ладони = along(средний) × spread;
 *   palmInward — та сторона ладони, где большой палец (он всегда с ладонной стороны);
 *   plane      — ОСЬ СГИБА = along × palmInward;   twist = along;   normal = twist × plane.
 *
 * Тройка ортонормирована по построению — это важно: `jointClamp.clampLocalToLimit` раскладывает свинг
 * скалярными произведениями и на косой тройке дал бы неверный клэмп, а `dofBasis` в редакторе строит
 * из неё матрицу поворота напрямую.
 *
 * Модуль ЧИСТЫЙ (числа, без THREE и без сцены) — целиком тестируется в node.
 */
import { FINGER_CHAINS, FINGER_SEGMENTS, type FingerChain } from './boneNames.js';
import { FINGER_GEO } from './humanoid.js';

export type Vec3 = [number, number, number];
export interface FingerAxes { twist: Vec3; plane: Vec3; normal: Vec3 }

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 | null => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null; };
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** Rest-офсет кости относительно родителя. `null` — кости нет. */
export type OffsetOf = (bone: string) => Vec3 | null;

const boneName = (side: 'Left' | 'Right', chain: FingerChain, seg: 0 | 1 | 2): string => side + chain + FINGER_SEGMENTS[seg];

/** Канонические офсеты фаланг из `FINGER_GEO` — ровно то, что строит `humanoid.fingerBones()`. */
export function canonicalFingerOffsets(): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  for (const side of ['Left', 'Right'] as const) {
    const sx = side === 'Left' ? 1 : -1;
    for (const [chain, base, lens] of FINGER_GEO) {
      for (let i = 0; i < 3; i++) {
        out[side + chain + FINGER_SEGMENTS[i]] = i === 0
          ? [base[0] * sx, base[1], base[2]]
          : [(lens[i - 1] ?? 1) * sx, 0, 0];
      }
    }
  }
  return out;
}

/**
 * Оси всех 30 фаланг. Если геометрия вырождена (ладонь схлопнута, палец совпал с нормалью ладони) —
 * для этой кости оси не выдаются: пусть вызывающий возьмёт канонические, чем получить NaN в клэмпе.
 */
export function deriveFingerAxes(offsetOf: OffsetOf): Record<string, FingerAxes> {
  const out: Record<string, FingerAxes> = {};
  for (const side of ['Left', 'Right'] as const) {
    // Направление фаланги = офсет её ПЕРВОГО РЕБЁНКА. У дистальной ребёнка нет — берём её собственный
    // офсет (направление предыдущего звена): у прямого пальца это то же направление.
    const along = (chain: FingerChain, seg: 0 | 1 | 2): Vec3 | null =>
      norm((seg < 2 ? offsetOf(boneName(side, chain, (seg + 1) as 0 | 1 | 2)) : offsetOf(boneName(side, chain, seg))) ?? [0, 0, 0]);

    const rootOf = (chain: FingerChain): Vec3 | null => offsetOf(boneName(side, chain, 0));
    const idx = rootOf('Index'), lit = rootOf('Little'), mid = rootOf('Middle'), thu = rootOf('Thumb');
    const midAlong = along('Middle', 0);
    if (!idx || !lit || !mid || !thu || !midAlong) continue;

    const palmN = norm(cross(midAlong, sub(lit, idx)));
    if (!palmN) continue;
    const s = dot(sub(thu, mid), palmN);            // большой палец — с ЛАДОННОЙ стороны
    if (Math.abs(s) < 1e-9) continue;
    const palmInward = scale(palmN, Math.sign(s));

    for (const chain of FINGER_CHAINS) {
      for (let seg = 0 as 0 | 1 | 2; seg <= 2; seg = (seg + 1) as 0 | 1 | 2) {
        const t = along(chain, seg); if (!t) continue;
        const plane = norm(cross(t, palmInward)); if (!plane) continue;   // палец вдоль нормали ладони — вырождение
        const normal = norm(cross(t, plane)); if (!normal) continue;
        out[boneName(side, chain, seg)] = { twist: t, plane, normal };
      }
    }
  }
  return out;
}

/** Канонические оси (наш процедурный манекен) — считаются один раз. */
let _canon: Record<string, FingerAxes> | null = null;
export const canonicalFingerAxes = (): Record<string, FingerAxes> => (_canon ??= deriveFingerAxes((b) => canonicalFingerOffsets()[b] ?? null));

/** Оси кости с фолбэком на канон. Один вход для пределов, хватов и гизмо. */
export function fingerAxesOf(bone: string, derived?: Record<string, FingerAxes> | null): FingerAxes | null {
  return derived?.[bone] ?? canonicalFingerAxes()[bone] ?? null;
}
