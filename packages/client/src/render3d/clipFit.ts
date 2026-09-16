/**
 * ⭐⭐ ПОДГОНКА ГЛАДКИХ КЛЮЧЕЙ К ЦИКЛУ — «ключей в 2–3 раза меньше, между ними плавный переход».
 *
 * Запечённый `run_back` шёл 28–34 ключами, и дело было не в допуске. ЗАМЕР: гладкий сплайн, проведённый ЧЕРЕЗ кадры
 * прохода, требовал столько же ключей, сколько ломаная (26–40 против 28–35). Держали их однокадровые ИЗЛОМЫ
 * планировщика: стопа на постановке прыгает из −26° в 0 за кадр, упирается в предел сустава, колено дёргается на
 * 11–16° в момент касания другой ноги. Через излом не пройдёт никакая гладкая кривая — ключи садятся на каждый.
 *
 * Как это делают инструменты сжатия кривых (Simplify Curve в Maya/MotionBuilder, keyframe reduction в Unity): кривая
 * не обязана проходить через кадры — она ПОДГОНЯЕТСЯ к ним с допуском. Здесь так же, в три шага:
 *  1. проход чуть сглаживается гауссом по циклу (`sigma` ~1.5 кадра = 25 мс): однокадровые изломы — артефакт
 *     планировщика, а не движение, и решать, сколько будет ключей, они не должны;
 *  2. на выбранных временах значения ключей подбираются МЕТОДОМ НАИМЕНЬШИХ КВАДРАТОВ: сплайн линеен по значениям
 *     ключей, поэтому это одна маленькая система на все кости (кватернионы — по компонентам, как их и интерполирует
 *     рантайм), а не перебор;
 *  3. время худшего кадра становится новым ключом, пока ошибка к сглаженному проходу выше допуска; затем лишние
 *     ключи пробуются на удаление.
 *
 * ⚠ ОШИБКА МЕРЯЕТСЯ ТЕМ ЖЕ ПРОИГРЫВАТЕЛЕМ, ЧТО В ИГРЕ (`clipPoseAt`), а не моделью подгонки: нормировка
 * кватернионов и перевод в Эйлер между ними — и допуск гарантирован по построению, а не «примерно».
 *
 * Файл чистый (THREE-математика, без сцены) — тестируется в node.
 */
import * as THREE from 'three';
import { clipPoseAt, isAngleKey, MOTION_POS_KEYS, poseErrorDeg, type Clip, type Keyframe, type Pose } from './clipModel.js';

export interface SmoothFitOptions {
  /** Допуск к сглаженному проходу, ° (позиции таза — через `POS_DEG_PER_UNIT`). */
  epsDeg: number;
  /** Сглаживание прохода перед подгонкой, в кадрах (гаусс по циклу). 0 — без сглаживания. */
  sigmaFrames: number;
}
export interface SmoothFitResult {
  /** Ключи цикла: последний повторяет первый, у всех, кроме последнего, `interp: 'smooth'`. */
  keys: Keyframe[];
  /** Итоговая ошибка к сглаженному проходу, °. */
  errDeg: number;
  /** Отклонение от ИСХОДНОГО прохода, ° (максимум — на изломах планировщика, их скругляет сглаживание). */
  rawErrDeg: number;
}

const _q = new THREE.Quaternion(), _e = new THREE.Euler();
type Q4 = [number, number, number, number];
const quatOf = (v: readonly number[]): Q4 => { _q.setFromEuler(_e.set(v[0]!, v[1]!, v[2]!)); return [_q.x, _q.y, _q.z, _q.w]; };
const eulerOf = (q: Q4): [number, number, number] => {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  _q.set(q[0] / len, q[1] / len, q[2] / len, q[3] / len); _e.setFromQuaternion(_q);
  return [_e.x, _e.y, _e.z];
};

/**
 * Сгладить ЦИКЛ гауссом. `frames` — кадры цикла с замыканием (последний повторяет первый). Кватернионы — в
 * полушарии текущего кадра по компонентам с нормировкой (для окна в пару кадров это то же, что среднее на сфере).
 */
export function smoothLoopFrames(frames: readonly Keyframe[], sigma: number): Keyframe[] {
  const n = frames.length - 1;
  if (sigma <= 0 || n < 3) return frames.map((f) => ({ t: f.t, pose: { ...f.pose } }));
  const R = Math.min(Math.ceil(sigma * 3), Math.floor((n - 1) / 2));
  const w: number[] = [];
  for (let d = -R; d <= R; d++) w.push(Math.exp(-(d * d) / (2 * sigma * sigma)));
  const out: Keyframe[] = [];
  for (let i = 0; i < n; i++) {
    const pose: Pose = {};
    for (const key in frames[i]!.pose) {
      const own = frames[i]!.pose[key]!;
      if (isAngleKey(key)) {
        const ref = quatOf(own), acc: Q4 = [0, 0, 0, 0];
        for (let d = -R; d <= R; d++) {
          const q = quatOf(frames[((i + d) % n + n) % n]!.pose[key] ?? own);
          const sg = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? -1 : 1;
          for (let c = 0; c < 4; c++) acc[c] = acc[c]! + sg * q[c]! * w[d + R]!;
        }
        pose[key] = eulerOf(acc);
      } else {
        const acc = [0, 0, 0]; let ws = 0;
        for (let d = -R; d <= R; d++) {
          const v = frames[((i + d) % n + n) % n]!.pose[key] ?? own;
          for (let c = 0; c < 3; c++) acc[c]! += v[c]! * w[d + R]!;
          ws += w[d + R]!;
        }
        pose[key] = [acc[0]! / ws, acc[1]! / ws, acc[2]! / ws];
      }
    }
    out.push({ t: frames[i]!.t, pose });
  }
  out.push({ t: frames[n]!.t, pose: out[0]!.pose });
  return out;
}

/**
 * Строка коэффициентов сплайна цикла: значение в момент `t` = Σ coef·V[ключ]. Ключи — `T` (уникальные, последний
 * `T[U] = dur` повторяет первый). Ровно та же формула, что у `splinePose`: Эрмит + касательные по трём точкам.
 */
function splineRow(T: readonly number[], dur: number, t: number): [number, number][] {
  const U = T.length - 1;
  let i = 0; while (i < T.length - 2 && T[i + 1]! <= t) i++;
  const tt = (j: number): number => (j < 0 ? T[U + j]! - dur : j > U ? T[j - U]! + dur : T[j]!);
  const h = tt(i + 1) - tt(i), u = h > 1e-9 ? Math.min(1, Math.max(0, (t - tt(i)) / h)) : 0;
  const s2 = u * u, s3 = s2 * u;
  const row = new Map<number, number>();
  const add = (j: number, c: number): void => { const k = ((j % U) + U) % U; row.set(k, (row.get(k) ?? 0) + c); };
  const tan = (j: number, scale: number): void => {               // m_j = a·V[j−1] + b·V[j] + c·V[j+1]
    const d1 = tt(j) - tt(j - 1), d2 = tt(j + 1) - tt(j);
    add(j - 1, scale * (-d2 / (d1 * (d1 + d2))));
    add(j, scale * ((d2 / d1 - d1 / d2) / (d1 + d2)));
    add(j + 1, scale * (d1 / (d2 * (d1 + d2))));
  };
  add(i, 2 * s3 - 3 * s2 + 1); add(i + 1, -2 * s3 + 3 * s2);
  tan(i, (s3 - 2 * s2 + u) * h); tan(i + 1, (s3 - s2) * h);
  return [...row];
}

/** LU нормальной системы — одна на все каналы: матрица зависит только от времён ключей. */
function normalSolver(rows: readonly [number, number][][], U: number): (rhs: readonly number[]) => number[] {
  const M = Array.from({ length: U }, () => new Float64Array(U));
  for (const r of rows) for (const [i, ci] of r) for (const [j, cj] of r) M[i]![j]! += ci * cj;
  for (let i = 0; i < U; i++) M[i]![i]! += 1e-10;
  const piv = new Int32Array(U).map((_, i) => i);
  for (let c = 0; c < U; c++) {
    let p = c; for (let r = c + 1; r < U; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (p !== c) { [M[c], M[p]] = [M[p]!, M[c]!]; [piv[c], piv[p]] = [piv[p]!, piv[c]!]; }
    for (let r = c + 1; r < U; r++) { const f = (M[r]![c]! /= M[c]![c]!); for (let k = c + 1; k < U; k++) M[r]![k]! -= f * M[c]![k]!; }
  }
  return (rhs) => {
    const b = new Float64Array(U);
    rows.forEach((r, n) => { for (const [i, ci] of r) b[i]! += ci * rhs[n]!; });
    const x = new Float64Array(U);
    for (let i = 0; i < U; i++) { let s = b[piv[i]!]!; for (let k = 0; k < i; k++) s -= M[i]![k]! * x[k]!; x[i] = s; }
    for (let i = U - 1; i >= 0; i--) { let s = x[i]!; for (let k = i + 1; k < U; k++) s -= M[i]![k]! * x[k]!; x[i] = s / M[i]![i]!; }
    return Array.from(x);
  };
}

/** Значения ключей на временах `ks` (индексы кадров цикла) по МНК ко всему проходу `fit`. */
function fitValues(fit: readonly Keyframe[], ks: readonly number[]): Keyframe[] {
  const n = fit.length - 1, dur = fit[n]!.t, U = ks.length - 1;
  const T = ks.map((i) => fit[i]!.t);
  const rows = fit.slice(0, n).map((f) => splineRow(T, dur, f.t));
  const solve = normalSolver(rows, U);
  const keys: Keyframe[] = ks.map((i) => ({ t: fit[i]!.t, pose: {} }));
  for (const key in fit[0]!.pose) {
    if (isAngleKey(key)) {
      // Кватернионы кадров — одной непрерывной цепочкой полушарий: так их видит и рантайм (сосед к соседу).
      const qs: Q4[] = []; let prev: Q4 | null = null;
      for (let f = 0; f < n; f++) {
        let q = quatOf(fit[f]!.pose[key] ?? [0, 0, 0]);
        if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
        qs.push(q); prev = q;
      }
      const comp = [0, 1, 2, 3].map((c) => solve(qs.map((q) => q[c]!)));
      for (let j = 0; j < U; j++) keys[j]!.pose[key] = eulerOf([comp[0]![j]!, comp[1]![j]!, comp[2]![j]!, comp[3]![j]!]);
    } else if (MOTION_POS_KEYS.has(key)) {
      const comp = [0, 1, 2].map((c) => solve(fit.slice(0, n).map((f) => (f.pose[key] ?? [0, 0, 0])[c]!)));
      for (let j = 0; j < U; j++) keys[j]!.pose[key] = [comp[0]![j]!, comp[1]![j]!, comp[2]![j]!];
    } else for (let j = 0; j < U; j++) { const v = fit[ks[j]!]!.pose[key]!; keys[j]!.pose[key] = [v[0], v[1], v[2]]; }   // прочие скаляры — линейны, значение кадра
  }
  keys[U]!.pose = { ...keys[0]!.pose };
  for (let j = 0; j < U; j++) keys[j]!.interp = 'smooth';
  return keys;
}

/** Худшая ошибка ключей `keys` к проходу `ref` — тем же проигрывателем, что в игре. */
function worstError(ref: readonly Keyframe[], keys: Keyframe[], skip?: ReadonlySet<number>): { err: number; at: number } {
  const clip: Clip = { name: '', character: '', weapon: '', loop: true, keys };
  const dur = ref[ref.length - 1]!.t;
  let err = 0, at = -1, errAll = 0;
  for (let f = 0; f < ref.length - 1; f++) {
    const e = poseErrorDeg(ref[f]!.pose, clipPoseAt(clip, dur > 0 ? ref[f]!.t / dur : 0));
    if (e > errAll) errAll = e;
    if (e > err && !skip?.has(f)) { err = e; at = f; }
  }
  return { err: errAll, at };
}

/**
 * Подогнать гладкие ключи к циклу `frames` (кадры с замыканием: последний повторяет первый).
 * Меньше 5 кадров — подгонять нечего, ключи = кадры.
 */
export function fitSmoothLoop(frames: readonly Keyframe[], opts: SmoothFitOptions): SmoothFitResult {
  const n = frames.length - 1;
  const target = smoothLoopFrames(frames, opts.sigmaFrames);
  if (n < 5) {
    const keys = target.map((f, i) => ({ t: f.t, pose: { ...f.pose }, ...(i < n ? { interp: 'smooth' as const } : {}) }));
    return { keys, errDeg: 0, rawErrDeg: worstError(frames, keys).err };
  }
  const ks = [0, Math.round(n / 4), Math.round(n / 2), Math.round((3 * n) / 4), n].filter((v, i, a) => a.indexOf(v) === i);
  let keys = fitValues(target, ks), cur = worstError(target, keys, new Set(ks));
  while (cur.err > opts.epsDeg && cur.at >= 0 && ks.length <= n) {
    ks.push(cur.at); ks.sort((a, b) => a - b);
    keys = fitValues(target, ks);
    cur = worstError(target, keys, new Set(ks));
  }
  // Проход удаления: подгонка добавляла ключи по одному, и часть из них после соседей стала лишней.
  for (let j = 1; j < ks.length - 1 && ks.length > 4;) {
    const trial = ks.filter((_, i) => i !== j);
    const tk = fitValues(target, trial), te = worstError(target, tk);
    if (te.err <= Math.max(opts.epsDeg, cur.err)) { ks.splice(j, 1); keys = tk; cur = { err: te.err, at: -1 }; }
    else j++;
  }
  return { keys, errDeg: worstError(target, keys).err, rawErrDeg: worstError(frames, keys).err };
}
