/**
 * БИБЛИОТЕКА ПОЗ И COPY-TOOLS (Ф7) — то, чем в Cascadeur пользуются каждый день.
 *
 * Три вещи, которых у нас не было:
 *
 *  1. БИБЛИОТЕКА ПОЗ. Именованная поза (целиком или только выделенные кости) с возможностью вставить
 *     её обратно — в том числе зеркально. Без неё каждый замах авторится с нуля.
 *
 *  2. INTERVAL EDIT («вставить в интервал», Ctrl+Alt+V у Cascadeur). Обычная вставка меняет ОДИН кадр.
 *     Вставка в интервал подмешивает позу во ВСЕ кадры диапазона с НАРАСТАЮЩИМ влиянием — именно так
 *     делают бесшовный луп (взял первый кадр, вставил в хвост) и плавный переход в новую позу.
 *
 *  3. MIRROR ≠ FLIP. Это РАЗНЫЕ операции, и путать их больно:
 *     • mirror — «подтянуть вторую сторону под первую» (левая рука → правая), поза остаётся той же;
 *     • flip   — перевернуть позу целиком, стороны меняются местами (шаг левой становится шагом правой).
 *     У нас была только первая, и называлась она «зеркало».
 *
 * Файл ЧИСТЫЙ — тестируется в node.
 */
import { blendTwo, mirrorSide, flipPose, cubicBezier, type Clip, type Keyframe, type Pose } from './clipModel.js';

// ── Библиотека ───────────────────────────────────────────────────────────────────────────────────
export interface SavedPose {
  id: string;
  label: string;
  pose: Pose;
  /** Какие кости входят в позу (пусто = все, что есть в `pose`). */
  bones?: string[];
}
export interface PoseLibrary { poses: Record<string, SavedPose> }
export const EMPTY_POSE_LIBRARY = (): PoseLibrary => ({ poses: {} });

/** Снять позу из набора костей (выделение) — то, что кладём в библиотеку. */
export function capturePose(full: Pose, bones?: readonly string[]): Pose {
  const out: Pose = {};
  for (const nm in full) {
    if (nm[0] === '_') continue;
    if (bones && bones.length && !bones.includes(nm)) continue;
    const v = full[nm]!; out[nm] = [v[0], v[1], v[2]];
  }
  return out;
}

/** Вставить сохранённую позу в кадр: перекрываются ТОЛЬКО кости позы, остальное не трогаем. */
export function pastePose(target: Pose, pose: Pose, weight = 1): Pose {
  if (weight >= 1) {
    const out: Pose = { ...target };
    for (const nm in pose) { const v = pose[nm]!; out[nm] = [v[0], v[1], v[2]]; }
    return out;
  }
  const merged: Pose = { ...target };
  for (const nm in pose) { const v = pose[nm]!; merged[nm] = [v[0], v[1], v[2]]; }
  return blendTwo(target, merged, weight);
}

// ── Interval Edit ────────────────────────────────────────────────────────────────────────────────
export type IntervalCurve = 'linear' | 'bezier';

/**
 * Вставить позу в ИНТЕРВАЛ кадров с нарастающим влиянием: на `from` вес 0, на `to` вес 1.
 * Именно это делает бесшовный луп: копируешь первый кадр и вставляешь в хвост — конец плавно
 * приходит в начало, без рывка на стыке.
 */
export function pasteIntoInterval(keys: Keyframe[], from: number, to: number, pose: Pose, curve: IntervalCurve = 'linear'): void {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  if (hi <= lo) { const k = keys[lo]; if (k) k.pose = pastePose(k.pose, pose, 1); return; }
  for (let i = lo; i <= hi; i++) {
    const k = keys[i]; if (!k) continue;
    const u = (i - lo) / (hi - lo);
    const w = curve === 'bezier' ? cubicBezier(0.42, 0, 0.58, 1, u) : u;
    k.pose = pastePose(k.pose, pose, w);
  }
}

// ── Mirror / Flip ────────────────────────────────────────────────────────────────────────────────
/** Подтянуть вторую сторону под первую (поза остаётся той же — просто становится симметричной). */
export const mirrorPoseSide = (p: Pose, from: 'Left' | 'Right' = 'Left'): Pose => mirrorSide(p, from);
/** Перевернуть позу: стороны меняются местами (шаг левой → шаг правой). */
export const flipPoseSides = (p: Pose): Pose => flipPose(p);

/** Перевернуть ВЕСЬ клип (частая операция: сделал удар справа — получил слева).
 *  Метки едут с ключами, но `footstep` меняет ногу: перевёрнутый шаг делает ДРУГАЯ нога. */
export function flipClip(c: Clip): Clip {
  // ⚠ ЗАПЕЧЁННЫЙ ПОВОРОТ ТАЗА МЕНЯЕТ ЗНАК ВМЕСТЕ С ПОЗОЙ: `flipPose` зеркалит и рыск таза, а число в клипе —
  // подпись к нему; оставь как было — и редактор написал бы «+10°» под клипом, где таз повёрнут на −10°.
  return { ...c, ...(c.hipsYawDeg ? { hipsYawDeg: -c.hipsYawDeg } : {}), keys: c.keys.map((k) => ({
    ...k, pose: flipPose(k.pose),
    marks: k.marks?.map((m) => (m.foot ? { ...m, foot: m.foot === 'L' ? 'R' as const : 'L' as const } : { ...m })),
  })) };
}
/** Отзеркалить одну сторону на другую во всех кадрах клипа. */
export function mirrorClip(c: Clip, from: 'Left' | 'Right' = 'Left'): Clip {
  return { ...c, keys: c.keys.map((k) => ({ ...k, pose: mirrorSide(k.pose, from), marks: k.marks?.map((m) => ({ ...m })) })) };
}

/** Сдвинуть фазу циклического клипа: полезно, чтобы луп начинался с нужной ноги. */
export function rotateClipPhase(c: Clip, shiftKeys: number): Clip {
  const n = c.keys.length;
  if (n < 2 || shiftKeys % n === 0) return { ...c, keys: c.keys.map((k) => ({ ...k })) };
  const s = ((shiftKeys % n) + n) % n;
  const times = c.keys.map((k) => k.t);
  const rot = [...c.keys.slice(s), ...c.keys.slice(0, s)];
  return { ...c, keys: rot.map((k, i) => ({ ...k, t: times[i]! })) };
}

// ── «А в игре так же?» ───────────────────────────────────────────────────────────────────────────
export interface PoseDiff { worstDeg: number; worstBone: string; perBone: { bone: string; deg: number }[] }
/**
 * Сравнить две позы по костям (в градусах). Нужен для требования «редактор ≡ игра»:
 * авторская поза против того, что реально показывает физ-призрак.
 */
export function comparePoses(a: Pose, b: Pose, quatAngle: (x: readonly number[], y: readonly number[]) => number): PoseDiff {
  const perBone: { bone: string; deg: number }[] = [];
  let worstDeg = 0, worstBone = '—';
  for (const nm of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (nm[0] === '_') continue;
    const deg = quatAngle(a[nm] ?? [0, 0, 0], b[nm] ?? [0, 0, 0]);
    perBone.push({ bone: nm, deg });
    if (deg > worstDeg) { worstDeg = deg; worstBone = nm; }
  }
  perBone.sort((x, y) => y.deg - x.deg);
  return { worstDeg, worstBone, perBone };
}
