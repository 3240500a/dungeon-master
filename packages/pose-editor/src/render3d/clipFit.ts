/**
 * ⭐⭐ ПОДГОНКА ГЛАДКИХ КЛЮЧЕЙ — «ключей в 2–3 раза меньше, между ними плавный переход».
 *
 * Запечённый `run_back` шёл 28–34 ключами, и дело было не в допуске. ЗАМЕР: гладкий сплайн, проведённый ЧЕРЕЗ кадры
 * прохода, требовал столько же ключей, сколько ломаная (26–40 против 28–35). Держали их однокадровые ИЗЛОМЫ
 * планировщика: стопа на постановке прыгает из −26° в 0 за кадр, упирается в предел сустава, колено дёргается на
 * 11–16° в момент касания другой ноги. Через излом не пройдёт никакая гладкая кривая — ключи садятся на каждый.
 *
 * Как это делают инструменты сжатия кривых (Simplify Curve в Maya/MotionBuilder, keyframe reduction в Unity): кривая
 * не обязана проходить через кадры — она ПОДГОНЯЕТСЯ к ним с допуском. Здесь так же, в три шага:
 *  1. проход чуть сглаживается гауссом (`sigma` ~1.5 кадра = 25 мс): однокадровые изломы — артефакт
 *     планировщика, а не движение, и решать, сколько будет ключей, они не должны;
 *  2. на выбранных временах значения ключей подбираются МЕТОДОМ НАИМЕНЬШИХ КВАДРАТОВ: сплайн линеен по значениям
 *     ключей, поэтому это одна маленькая система на все кости (кватернионы — по компонентам, как их и интерполирует
 *     рантайм), а не перебор;
 *  3. время худшего кадра становится новым ключом, пока ошибка к сглаженному проходу выше допуска; затем лишние
 *     ключи пробуются на удаление.
 *
 * ⭐ ЦИКЛ И ОТКРЫТЫЙ КЛИП — ОДНА ПОДГОНКА (`loop`). Повороты на месте запекались отдельным путём — покадровой
 * ломаной с допуском 0.5° (28–47 ключей на клип против 11–15 у цикла походки). Разница между режимами ровно в том,
 * что у цикла ЗАМКНУТО ПО КРУГУ, а у открытого клипа — ЗАЖАТО НА КОНЦАХ, и это ровно те же пять мест, где
 * проигрыватель различает `loop` (`clipModel.splineIndex/splineTime`):
 *  • гаусс: сосед за краем — не «через шов», а повтор крайнего кадра;
 *  • строка сплайна: неизвестных не `U`, а `U+1` (последний ключ независим), касательные на концах односторонние;
 *  • последний ключ не копируется из первого;
 *  • проба ошибки строится клипом `loop: false`;
 *  • сигма задаётся В КАДРАХ — у поворота нет периода, долей которого её можно взять.
 * ⚠ ГАРАНТИЯ: на циклах подгонка обязана остаться БИТ В БИТ (сторож `clipTurnFit.test.ts` перезапекает походку и
 * сверяет ключи числом в число). Поэтому все ветки `loop: false` добавлены РЯДОМ с прежними, а не вместо них.
 *
 * ⚠ КОНЦЫ ОТКРЫТОГО КЛИПА ЗАКРЕПЛЕНЫ (первый и последний ключ = кадр прохода, бит в бит). На них стоят контракты
 * поворота: `turnYawAt(dur)` — это последний ключ `__rootY`, `turnSupportAt(0/dur)` — первый и последний `__swing`,
 * а шов поворота (`easeSeamHips`) читает ровно `clipPoseAt(clip, 0)`. МНК без закрепления «размазывает» концы на
 * доли градуса — и контракт становится «примерно».
 *
 * ⚠ ОШИБКА МЕРЯЕТСЯ ТЕМ ЖЕ ПРОИГРЫВАТЕЛЕМ, ЧТО В ИГРЕ (`clipPoseAt`), а не моделью подгонки: нормировка
 * кватернионов и перевод в Эйлер между ними — и допуск гарантирован по построению, а не «примерно».
 *
 * Файл чистый (THREE-математика, без сцены) — тестируется в node.
 */
import * as THREE from 'three';
import { clipPoseAt, isAngleKey, MOTION_POS_KEYS, poseErrorDeg, ROOT_YAW, type Clip, type Keyframe, type Pose } from './clipModel.js';
import { SWING_KEY } from './turnInPlace.js';

export interface SmoothFitOptions {
  /** Допуск к сглаженному проходу, ° (позиции таза — через `POS_DEG_PER_UNIT`, курс корня — рад→°). */
  epsDeg: number;
  /** Сглаживание прохода перед подгонкой, в кадрах (гаусс). 0 — без сглаживания. */
  sigmaFrames: number;
  /** Цикл (по умолч.) или ОТКРЫТЫЙ клип: концы зажимаются и закрепляются вместо замыкания по кругу. */
  loop?: boolean;
  /** Индексы кадров, которые ОБЯЗАНЫ стать ключами и которых проход удаления не трогает (смены опоры). */
  pin?: readonly number[];
}
export interface SmoothFitResult {
  /** Ключи: у цикла последний повторяет первый; у всех, кроме последнего, `interp: 'smooth'`. */
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
const clonePose = (p: Pose): Pose => { const o: Pose = {}; for (const k in p) { const v = p[k]!; o[k] = [v[0], v[1], v[2]]; } return o; };

/**
 * ⭐ КУРС КОРНЯ — ТОЖЕ ОШИБКА. `poseErrorDeg` меряет ПОЗУ (кости + позиционные каналы движения), а `__rootY` —
 * не поза, это накопленный разворот клипа в РАДИАНАХ, и в `ERROR_POS_KEYS` его нет нарочно (там «юниты × 5°»,
 * для радиан это бессмыслица). Но для поворота на месте разворот и ЕСТЬ анимация: без этого члена подгонка
 * молча теряет градусы курса, а `turnYawAt` этого не увидит — вот отдельный член меры, рад→°.
 * Здесь, а не в `poseErrorDeg`: та — общий контракт «расхождение поз» (её читают сторожа паритета и редактор),
 * и курс клипа в него не входит; здесь же он ровно то, что выбирает ключи.
 * ⚠ Мутация «убрать член» — подгонка теряет курс (сторож `clipTurnFit.test.ts`).
 */
function fitErrorDeg(ref: Pose, got: Pose): number {
  const e = poseErrorDeg(ref, got);
  const a = ref[ROOT_YAW], b = got[ROOT_YAW];
  if (!a || !b) return e;
  return Math.max(e, Math.abs(a[0] - b[0]) * 180 / Math.PI);
}

/**
 * Сгладить проход гауссом. Цикл: `frames` — кадры с замыканием (последний повторяет первый), сосед за краем берётся
 * через шов. Открытый клип (`loop: false`): замыкания нет, сосед за краем — повтор крайнего кадра (зажим).
 * Кватернионы — в полушарии текущего кадра по компонентам с нормировкой (для окна в пару кадров это то же, что
 * среднее на сфере).
 * ⚠ `__swing` (флаги опоры) ИЗ СГЛАЖИВАНИЯ ИСКЛЮЧЁН: это не движение, а «какая нога в воздухе», и размазанный
 * флаг сдвинул бы времена смены опоры. `__match`, `__pinKp` — обычные скаляры, их сглаживание не трогает ключи.
 *
 * ⭐ У ОТКРЫТОГО КЛИПА ОКНО СУЖАЕТСЯ К КРАЮ СИММЕТРИЧНО (на самом краю — ноль, то есть кадр как есть).
 * ЗАМЕР (рыцарь, `turn_R_90`): при простом зажиме (повторе крайнего кадра) первый кадр уезжал на 8.4° — съём
 * поворота начинается НЕ со статики, прицел уже прыгнул, и окно тянуло край за разгоном. А первый и последний
 * кадр — ЗАКРЕПЛЁННЫЕ ключи, и подгонка меряла бы этот перекос как свою неустранимую ошибку: она добирала ключи
 * до последнего кадра, не могла опуститься ниже 8.4° и ровно на столько же ПОДНИМАЛА порог прохода удаления —
 * итог 9–17 ключей с ошибкой 42° к проходу. Симметричное окно края не смещает вовсе.
 */
export function smoothLoopFrames(frames: readonly Keyframe[], sigma: number, loop = true): Keyframe[] {
  const n = loop ? frames.length - 1 : frames.length;
  if (sigma <= 0 || n < 3) return frames.map((f) => ({ t: f.t, pose: { ...f.pose } }));
  const R = Math.min(Math.ceil(sigma * 3), Math.floor((n - 1) / 2));
  const at = loop ? (i: number): number => ((i % n) + n) % n : (i: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i);
  const w: number[] = [];
  for (let d = -R; d <= R; d++) w.push(Math.exp(-(d * d) / (2 * sigma * sigma)));
  const out: Keyframe[] = [];
  for (let i = 0; i < n; i++) {
    const Ri = loop ? R : Math.min(R, i, n - 1 - i);      // у цикла окно всегда полное — цикл бит в бит
    const pose: Pose = {};
    for (const key in frames[i]!.pose) {
      const own = frames[i]!.pose[key]!;
      if (key === SWING_KEY) { pose[key] = [own[0], own[1], own[2]]; continue; }
      if (isAngleKey(key)) {
        const ref = quatOf(own), acc: Q4 = [0, 0, 0, 0];
        for (let d = -Ri; d <= Ri; d++) {
          const q = quatOf(frames[at(i + d)]!.pose[key] ?? own);
          const sg = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? -1 : 1;
          for (let c = 0; c < 4; c++) acc[c] = acc[c]! + sg * q[c]! * w[d + R]!;
        }
        pose[key] = eulerOf(acc);
      } else {
        const acc = [0, 0, 0]; let ws = 0;
        for (let d = -Ri; d <= Ri; d++) {
          const v = frames[at(i + d)]!.pose[key] ?? own;
          for (let c = 0; c < 3; c++) acc[c]! += v[c]! * w[d + R]!;
          ws += w[d + R]!;
        }
        pose[key] = [acc[0]! / ws, acc[1]! / ws, acc[2]! / ws];
      }
    }
    out.push({ t: frames[i]!.t, pose });
  }
  if (loop) out.push({ t: frames[n]!.t, pose: out[0]!.pose });
  return out;
}

/**
 * Строка коэффициентов сплайна: значение в момент `t` = Σ coef·V[ключ]. Ключи — `T` (уникальные; у цикла последний
 * `T[U] = dur` повторяет первый, у открытого клипа последний ключ независим). Ровно та же формула, что у
 * `splinePose`: Эрмит + касательные по трём точкам, на краю открытого клипа — односторонние.
 */
function splineRow(T: readonly number[], dur: number, t: number, loop: boolean): [number, number][] {
  const U = T.length - 1;
  let i = 0; while (i < T.length - 2 && T[i + 1]! <= t) i++;
  const tt = loop
    ? (j: number): number => (j < 0 ? T[U + j]! - dur : j > U ? T[j - U]! + dur : T[j]!)
    : (j: number): number => T[j < 0 ? 0 : j > U ? U : j]!;
  const h = tt(i + 1) - tt(i), u = h > 1e-9 ? Math.min(1, Math.max(0, (t - tt(i)) / h)) : 0;
  const s2 = u * u, s3 = s2 * u;
  const row = new Map<number, number>();
  const fold = loop ? (j: number): number => ((j % U) + U) % U : (j: number): number => (j < 0 ? 0 : j > U ? U : j);
  const add = (j: number, c: number): void => { const k = fold(j); row.set(k, (row.get(k) ?? 0) + c); };
  const tan = (j: number, scale: number): void => {               // m_j = a·V[j−1] + b·V[j] + c·V[j+1]
    const d1 = tt(j) - tt(j - 1), d2 = tt(j + 1) - tt(j);
    if (d1 <= 1e-9 || d2 <= 1e-9) {          // край открытого клипа: односторонняя касательная — как у `tangent` плеера
      if (d1 > 1e-9) { add(j - 1, -scale / d1); add(j, scale / d1); }
      else if (d2 > 1e-9) { add(j, -scale / d2); add(j + 1, scale / d2); }
      return;
    }
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

/**
 * Значения ключей на временах `ks` (индексы кадров прохода) по МНК ко всему проходу `fit`.
 * `fixed` — готовые позы ключей (концы открытого клипа): их значения не подбираются, а ПЕРЕНОСЯТСЯ В ПРАВУЮ ЧАСТЬ,
 * то есть система решается по остальным ключам точно, а не «почти». Без закреплений путь ровно прежний.
 */
function fitValues(fit: readonly Keyframe[], ks: readonly number[], loop: boolean, fixed?: ReadonlyMap<number, Pose>): Keyframe[] {
  const n = loop ? fit.length - 1 : fit.length, dur = fit[fit.length - 1]!.t, U = ks.length - 1;
  const K = loop ? U : U + 1;                                    // сколько ключей подбираем (у цикла последний — копия первого)
  const T = ks.map((i) => fit[i]!.t);
  const rows = fit.slice(0, n).map((f) => splineRow(T, dur, f.t, loop));
  // Свободные неизвестные и перенос закреплённых в правую часть.
  const idx = new Int32Array(K).fill(-1); let free = 0;
  for (let j = 0; j < K; j++) if (!fixed?.has(j)) idx[j] = free++;
  const rowsFree = rows.map((r) => r.filter(([j]) => idx[j]! >= 0).map(([j, c]) => [idx[j]!, c] as [number, number]));
  const rowsFix = rows.map((r) => r.filter(([j]) => idx[j]! < 0));
  const solve = normalSolver(rowsFree, free);
  /** Решить один канал: `val(кадр)` — правая часть, `at(ключ)` — значение закреплённого ключа. */
  const solveCh = (val: (f: number) => number, at: (j: number) => number): number[] => {
    const rhs = rows.map((_, f) => { let s = val(f); for (const [j, c] of rowsFix[f]!) s -= c * at(j); return s; });
    const x = solve(rhs), out: number[] = [];
    for (let j = 0; j < K; j++) out.push(idx[j]! >= 0 ? x[idx[j]!]! : at(j));
    return out;
  };
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
      // Закреплённый ключ — в ТО ЖЕ полушарие, что кадр под ним, иначе он потянет кривую длинной дугой.
      const fq = new Map<number, Q4>();
      fixed?.forEach((p, j) => {
        const near = qs[Math.min(n - 1, ks[j]!)]!; let q = quatOf(p[key] ?? fit[ks[j]!]!.pose[key] ?? [0, 0, 0]);
        if (q[0] * near[0] + q[1] * near[1] + q[2] * near[2] + q[3] * near[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
        fq.set(j, q);
      });
      const comp = [0, 1, 2, 3].map((c) => solveCh((f) => qs[f]![c]!, (j) => fq.get(j)?.[c] ?? 0));
      for (let j = 0; j < K; j++) keys[j]!.pose[key] = eulerOf([comp[0]![j]!, comp[1]![j]!, comp[2]![j]!, comp[3]![j]!]);
    } else if (MOTION_POS_KEYS.has(key)) {
      const comp = [0, 1, 2].map((c) => solveCh((f) => (fit[f]!.pose[key] ?? [0, 0, 0])[c]!, (j) => (fixed?.get(j)?.[key] ?? fit[ks[j]!]!.pose[key] ?? [0, 0, 0])[c]!));
      for (let j = 0; j < K; j++) keys[j]!.pose[key] = [comp[0]![j]!, comp[1]![j]!, comp[2]![j]!];
    } else for (let j = 0; j < K; j++) { const v = fit[ks[j]!]!.pose[key]!; keys[j]!.pose[key] = [v[0], v[1], v[2]]; }   // прочие скаляры — линейны, значение кадра
  }
  // Закреплённые ключи — бит в бит кадром прохода (в т.ч. флаги и скаляры), а не через кватернионный круг.
  fixed?.forEach((p, j) => { keys[j]!.pose = clonePose(p); });
  if (loop) keys[U]!.pose = { ...keys[0]!.pose };
  for (let j = 0; j < U; j++) keys[j]!.interp = 'smooth';
  return keys;
}

/** Худшая ошибка ключей `keys` к проходу `ref` — тем же проигрывателем, что в игре. */
function worstError(ref: readonly Keyframe[], keys: Keyframe[], loop: boolean, skip?: ReadonlySet<number>): { err: number; at: number } {
  const clip: Clip = { name: '', character: '', weapon: '', loop, keys };
  const dur = ref[ref.length - 1]!.t;
  const last = loop ? ref.length - 1 : ref.length;
  let err = 0, at = -1, errAll = 0;
  for (let f = 0; f < last; f++) {
    const e = fitErrorDeg(ref[f]!.pose, clipPoseAt(clip, dur > 0 ? ref[f]!.t / dur : 0));
    if (e > errAll) errAll = e;
    if (e > err && !skip?.has(f)) { err = e; at = f; }
  }
  return { err: errAll, at };
}

/**
 * Подогнать гладкие ключи к проходу `frames`: цикл (кадры с замыканием: последний повторяет первый) или
 * ОТКРЫТЫЙ клип (`loop: false` — кадры как есть, концы закрепляются).
 * Меньше 5 кадров — подгонять нечего, ключи = кадры.
 */
export function fitSmoothLoop(frames: readonly Keyframe[], opts: SmoothFitOptions): SmoothFitResult {
  const loop = opts.loop !== false;
  const n = loop ? frames.length - 1 : frames.length;            // независимых кадров прохода
  const end = loop ? n : n - 1;                                  // индекс последнего кадра-кандидата в ключи
  const target = smoothLoopFrames(frames, opts.sigmaFrames, loop);
  if (n < 5) {
    const keys = target.map((f, i) => ({ t: f.t, pose: { ...f.pose }, ...(i < end ? { interp: 'smooth' as const } : {}) }));
    return { keys, errDeg: 0, rawErrDeg: worstError(frames, keys, loop).err };
  }
  // Обязательные ключи: концы + просимые времена (смены опоры). Проход удаления их не трогает.
  const hold = new Set<number>([0, end]);
  for (const i of opts.pin ?? []) if (i > 0 && i < end) hold.add(i);
  // Закреплённые ЗНАЧЕНИЯ — только концы открытого клипа, и ровно кадром ИСХОДНОГО прохода (не сглаженного).
  const fixed = loop ? undefined : new Map<number, Pose>();
  const ks = [...new Set([0, Math.round(end / 4), Math.round(end / 2), Math.round((3 * end) / 4), end, ...hold])].sort((a, b) => a - b);
  const pinAt = (list: readonly number[]): ReadonlyMap<number, Pose> | undefined => {
    if (!fixed) return undefined;
    fixed.clear(); fixed.set(0, frames[0]!.pose); fixed.set(list.length - 1, frames[end]!.pose);
    return fixed;
  };
  let keys = fitValues(target, ks, loop, pinAt(ks)), cur = worstError(target, keys, loop, new Set(ks));
  while (cur.err > opts.epsDeg && cur.at >= 0 && ks.length <= end) {
    ks.push(cur.at); ks.sort((a, b) => a - b);
    keys = fitValues(target, ks, loop, pinAt(ks));
    cur = worstError(target, keys, loop, new Set(ks));
  }
  // Проход удаления: подгонка добавляла ключи по одному, и часть из них после соседей стала лишней.
  for (let j = 1; j < ks.length - 1 && ks.length > 4;) {
    if (hold.has(ks[j]!)) { j++; continue; }
    const trial = ks.filter((_, i) => i !== j);
    const tk = fitValues(target, trial, loop, pinAt(trial)), te = worstError(target, tk, loop);
    if (te.err <= Math.max(opts.epsDeg, cur.err)) { ks.splice(j, 1); keys = tk; cur = { err: te.err, at: -1 }; }
    else j++;
  }
  return { keys, errDeg: worstError(target, keys, loop).err, rawErrDeg: worstError(frames, keys, loop).err };
}
