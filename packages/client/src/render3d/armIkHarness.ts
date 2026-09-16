/**
 * СТЕНД РУКИ: кисть ведётся по траекториям, солв — тот же `limbSolve.solveLimbChain`, что в поз-редакторе,
 * полюс — тот же `limbIk.limbNaturalPole`. Меряет то, на что жаловались глазами: «локоть держит место и рука
 * выкручивается», перескок локтя за кадр, недолёт кисти, путь туда-обратно не возвращает локоть, где локоть
 * у опущенной и поднятой руки. Грузится только тестами (в сборку не попадает — его никто из рантайма не импортирует).
 *
 * Координаты траекторий — в долях длины руки L = L1 + L2 от плечевого сустава, во фрейме корпуса; `x` задан для ЛЕВОЙ
 * руки (наружу) и зеркалится для правой. Персонаж смотрит в +Z, вверх +Y.
 */
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';
import { limbNaturalPole, fadeSwivel, type ArmPoleFn } from './limbIk.js';
import { solveLimbChain, hingePlaneSwivel, type LimbEnv, type LimbChain } from './limbSolve.js';

type V3 = [number, number, number];
export interface ArmPath { name: string; closed: boolean; frames: number; keys: V3[]; loops?: number }

/** Траектории (доли L). `keys` — ломаная, между ключами — равномерно по длине; `loops` — окружность (центр, радиус в keys[0..1]). */
export const ARM_PATHS: ArmPath[] = [
  { name: 'row', closed: false, frames: 41, keys: [[0.05, -0.2, 0.9], [0.1, -0.35, 0.45], [0.15, -0.55, -0.15]] },
  { name: 'curl', closed: false, frames: 41, keys: [[0.05, -0.93, 0.15], [0.05, -0.65, 0.55], [0.05, -0.25, 0.6], [0.05, -0.05, 0.45]] },
  { name: 'sideIn', closed: false, frames: 41, keys: [[0.95, -0.05, 0], [0.6, -0.05, 0.7], [0, -0.05, 0.9], [-0.25, -0.05, 0.75]] },
  { name: 'toChest', closed: false, frames: 41, keys: [[0, 0, 0.95], [-0.15, -0.15, 0.65], [-0.35, -0.3, 0.35]] },
  { name: 'overhead', closed: false, frames: 41, keys: [[0, 0, 0.9], [0, 0.65, 0.6], [0, 0.9, 0.2], [0, 0.85, -0.3]] },
  { name: 'outBack', closed: true, frames: 81, keys: [[0.05, -0.95, 0], [-0.05, -0.75, 0.35], [-0.3, -0.35, 0.45], [-0.05, -0.75, 0.35], [0.05, -0.95, 0]] },
  { name: 'loop3', closed: true, frames: 181, keys: [[0.1, -0.3, 0.6], [0.25, 0, 0]], loops: 3 },
  { name: 'hipTouch', closed: false, frames: 41, keys: [[0.9, -0.3, 0], [0.55, -0.7, 0], [0.25, -0.85, -0.05]] },
  { name: 'behindHead', closed: false, frames: 41, keys: [[0.05, 0.9, 0.25], [-0.05, 0.75, -0.1], [-0.15, 0.55, -0.25]] },
];

/** Точка траектории на доле `t` ∈ [0,1] (доли L, левая рука). */
function pathAt(p: ArmPath, t: number): THREE.Vector3 {
  if (p.loops) {
    const c = new THREE.Vector3(...p.keys[0]!), r = p.keys[1]![0];
    const a = t * p.loops * 2 * Math.PI;
    return c.add(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
  }
  const pts = p.keys.map((k) => new THREE.Vector3(...k));
  const seg: number[] = []; let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = pts[i]!.distanceTo(pts[i - 1]!); seg.push(l); total += l; }
  let s = t * total;
  for (let i = 0; i < seg.length; i++) {
    if (s <= seg[i]! || i === seg.length - 1) return pts[i]!.clone().lerp(pts[i + 1]!, Math.min(1, s / Math.max(seg[i]!, 1e-9)));
    s -= seg[i]!;
  }
  return pts[pts.length - 1]!.clone();
}

export interface ArmRunOpts {
  env: LimbEnv;
  pole: ArmPoleFn;
  twistGuard: boolean;
  planeFromTwist: boolean;
  /** Ручная правка свивеля (рад) — как после оранжевой ручки. */
  swivel?: number;
  /** Затухание правки по ходу кисти (u на e-кратное ослабление), как `ARM_SWIVEL_FADE` в редакторе. Нет — правка вечная. */
  swivelFade?: number;
  /** Начинать не из T-позы: сперва подвести кисть к началу пути, ПОТОМ включить правку (как «поставил позу, потом тянешь»). */
  tweakAfterApproach?: boolean;
  /** Полюс подводки (нет — `pole`): поза «поставлена» другим полюсом, например прежним `armPoleLegacy`. */
  approachPole?: ArmPoleFn;
  /** После подводки СНЯТЬ свивель с позы — угол от натурали `pole` до плоскости шарнира, как `swivelFromHinge` в `syncEff`
   *  при клике по кисти. Перекрывает `swivel`. */
  captureSwivel?: boolean;
}
export interface ArmMetrics {
  /** Наибольшая прокрутка плеча вокруг своей оси за кадр, ° */ maxRoll: number;
  /** Суммарная прокрутка плеча за путь, ° */ totalRoll: number;
  /** Наибольший скачок локтя за кадр, u */ maxElbowJump: number;
  /** Наибольший недолёт кисти, u */ maxMiss: number;
  /** Путь туда-обратно: расстояние локтя конца от начала, u (для незамкнутых — 0) */ closure: number;
  /** Локоть «вперёд» от плеча (фрейм корпуса, u) — на кадрах, где кисть низко (u.y < −0.6): максимум */ lowElbowFwdMax: number;
  /** То же у поднятой руки (u.y > 0.7): минимум */ highElbowFwdMin: number;
  /** Локоть «вниз» от плеча у кисти перед грудью (|u.y| < 0.35, u.z > 0.5): максимум высоты, u */ frontElbowUpMax: number;
  /** Локоть НАРУЖУ от плеча (фрейм корпуса, u; меньше −3 — локоть лезет в грудную клетку): минимум по пути */ minElbowOut: number;
  /** Позиции локтя по кадрам (мир) — для сверки зеркала */ elbows: THREE.Vector3[];
  /** Ход кисти за путь, u */ travel: number;
  /** Отклонение плоскости локтя от анатомической (свивель 0) на последнем кадре, ° по модулю */ endPlaneDev: number;
  /** Свивель на старте пути (после правки или захвата), рад со знаком */ startSwivel: number;
  /** Прокрутка плеча на ПЕРВОМ кадре пути относительно позы после подводки, ° (в `maxRoll` не входит: там правка на старте — намеренная) */ startRoll: number;
}

const deg = (r: number): number => (r * 180) / Math.PI;
/** Прокрутка (°, 0…180) дельты мировых поворотов `prev → q` вокруг текущей оси кости `axis` (свинг-твист: минимальная дуга оси твиста не даёт). */
function rollDeg(q: THREE.Quaternion, prev: THREE.Quaternion, axis: THREE.Vector3): number {
  const d = q.clone().multiply(prev.clone().invert());
  const roll = Math.abs(deg(2 * Math.atan2(d.x * axis.x + d.y * axis.y + d.z * axis.z, d.w)));
  return roll > 180 ? 360 - roll : roll;
}

/** Прогнать одну руку по пути. Риг — в T-позе; сначала 20 кадров подводки к началу пути (не меряются). */
export function runArm(h: Humanoid, side: 1 | -1, path: ArmPath, o: ArmRunOpts): ArmMetrics {
  h.reset();
  const P = side > 0 ? 'Left' : 'Right';
  const chain: LimbChain = { root: h.bones.get(P + 'UpperArm')!, mid: h.bones.get(P + 'LowerArm')!, end: h.bones.get(P + 'Hand')!, world: h.root };
  h.root.updateMatrixWorld(true);
  const S = chain.root.getWorldPosition(new THREE.Vector3());
  const L = chain.mid.position.length() + chain.end.position.length();
  const frameQ = (h.bones.get('UpperChest') ?? h.hips).getWorldQuaternion(new THREE.Quaternion());
  const frameInv = frameQ.clone().invert();
  const toWorld = (f: THREE.Vector3): THREE.Vector3 => S.clone().add(new THREE.Vector3(f.x * side, f.y, f.z).multiplyScalar(L).applyQuaternion(frameQ));
  let sw = o.tweakAfterApproach ? 0 : (o.swivel ?? 0);
  let lastT: THREE.Vector3 | null = null;
  const natural = (target: THREE.Vector3, swivel: number, poleFn: ArmPoleFn = o.pole): THREE.Vector3 => {
    const toT = target.clone().sub(S);
    const u = toT.clone().applyQuaternion(frameInv).normalize();
    return (limbNaturalPole(u, side, false, swivel, toT.length() / L, poleFn) ?? new THREE.Vector3(0, -1, 0)).applyQuaternion(frameQ);
  };
  let poleNow: ArmPoleFn = o.approachPole ?? o.pole;
  const solveTo = (target: THREE.Vector3): { miss: number } => {
    if (o.swivelFade && lastT) sw = fadeSwivel(sw, target.distanceTo(lastT), o.swivelFade);   // ТА ЖЕ функция, что в редакторе
    lastT = target.clone();
    const p = natural(target, sw, poleNow).applyQuaternion(frameInv);
    const miss = solveLimbChain(chain, target, p.applyQuaternion(frameQ), { isFoot: false, planeFromTwist: o.planeFromTwist, twistGuard: o.twistGuard }, o.env);
    return { miss };
  };
  // подводка из T-позы к началу пути
  const start = toWorld(pathAt(path, 0));
  const tpose = chain.end.getWorldPosition(new THREE.Vector3());
  for (let i = 1; i <= 20; i++) solveTo(tpose.clone().lerp(start, i / 20));
  poleNow = o.pole;
  if (o.captureSwivel) sw = hingePlaneSwivel(chain, start, natural(start, 0), o.env) ?? 0;
  else if (o.tweakAfterApproach) sw = o.swivel ?? 0;
  h.root.updateMatrixWorld(true);
  const q0 = chain.root.getWorldQuaternion(new THREE.Quaternion());

  const m: ArmMetrics = { maxRoll: 0, totalRoll: 0, maxElbowJump: 0, maxMiss: 0, closure: 0, lowElbowFwdMax: -Infinity, highElbowFwdMin: Infinity, frontElbowUpMax: -Infinity, minElbowOut: Infinity, elbows: [], travel: 0, endPlaneDev: 0, startSwivel: sw, startRoll: 0 };
  let prevQ: THREE.Quaternion | null = null, prevE: THREE.Vector3 | null = null;
  for (let f = 0; f < path.frames; f++) {
    const fr = pathAt(path, f / (path.frames - 1));
    const target = toWorld(fr);
    if (lastT) m.travel += target.distanceTo(lastT);
    const { miss } = solveTo(target);
    h.root.updateMatrixWorld(true);
    const q = chain.root.getWorldQuaternion(new THREE.Quaternion());
    const E = chain.mid.getWorldPosition(new THREE.Vector3());
    m.elbows.push(E.clone());
    m.maxMiss = Math.max(m.maxMiss, miss);
    const axis = E.clone().sub(S).normalize();
    if (f === 0) m.startRoll = rollDeg(q, q0, axis);
    if (prevQ && prevE) {
      const r = rollDeg(q, prevQ, axis);
      m.maxRoll = Math.max(m.maxRoll, r); m.totalRoll += r;
      m.maxElbowJump = Math.max(m.maxElbowJump, E.distanceTo(prevE));
    }
    prevQ = q; prevE = E;
    const u = target.clone().sub(S).applyQuaternion(frameInv).normalize();
    const eLocal = E.clone().sub(S).applyQuaternion(frameInv);
    if (u.y < -0.6) m.lowElbowFwdMax = Math.max(m.lowElbowFwdMax, eLocal.z);
    if (u.y > 0.7) m.highElbowFwdMin = Math.min(m.highElbowFwdMin, eLocal.z);
    if (Math.abs(u.y) < 0.35 && u.z > 0.5) m.frontElbowUpMax = Math.max(m.frontElbowUpMax, eLocal.y);
    m.minElbowOut = Math.min(m.minElbowOut, eLocal.x * side);
  }
  if (path.closed) m.closure = m.elbows[0]!.distanceTo(m.elbows[m.elbows.length - 1]!);
  const endDev = lastT ? hingePlaneSwivel(chain, lastT, natural(lastT, 0), o.env) : null;
  m.endPlaneDev = endDev === null ? NaN : Math.abs(deg(endDev));
  return m;
}

export interface ArmSuiteRow { path: string; L: ArmMetrics; R: ArmMetrics; mirror: number }
/** Все пути обеими руками + сверка зеркала (локоть правой, отражённый по X, против левой). */
export function runArmSuite(makeRig: () => Humanoid, o: ArmRunOpts, paths: ArmPath[] = ARM_PATHS): ArmSuiteRow[] {
  const out: ArmSuiteRow[] = [];
  for (const p of paths) {
    const L = runArm(makeRig(), 1, p, o), R = runArm(makeRig(), -1, p, o);
    let mirror = 0;
    for (let i = 0; i < L.elbows.length; i++) mirror = Math.max(mirror, L.elbows[i]!.distanceTo(new THREE.Vector3(-R.elbows[i]!.x, R.elbows[i]!.y, R.elbows[i]!.z)));
    out.push({ path: p.name, L, R, mirror });
  }
  return out;
}

/** Короткая сводка без массивов позиций — для логов и отчётов. */
export function summarize(rows: ArmSuiteRow[]): Record<string, Record<string, number>> {
  const r2 = (x: number): number => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
  const o: Record<string, Record<string, number>> = {};
  for (const row of rows) for (const [s, m] of [['L', row.L], ['R', row.R]] as const) {
    o[`${row.path}.${s}`] = { maxRoll: r2(m.maxRoll), totalRoll: r2(m.totalRoll), jump: r2(m.maxElbowJump), miss: r2(m.maxMiss), closure: r2(m.closure), lowFwd: r2(m.lowElbowFwdMax), highFwd: r2(m.highElbowFwdMin), frontUp: r2(m.frontElbowUpMax), out: r2(m.minElbowOut), mirror: r2(row.mirror) };
  }
  return o;
}
