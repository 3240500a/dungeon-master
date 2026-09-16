/**
 * АНАЛИТИЧЕСКАЯ КОНЕЧНОСТЬ НА КОСТЯХ — солв поз-редактора без редактора (вынесено из `pose-editor.ts` 17.09.2026).
 *
 * Зачем отдельно. Сам солв жил в редакторе, куда node-тест не дотянуться, и каждую правку плоскости локтя/колена
 * проверяли пробой, КОПИРУЮЩЕЙ код построчно. Две такие пробы уже промахнулись мимо живого поведения (колено на
 * модели почти прямое — проба на процедурном риге этого не видела). Теперь редактор и тесты зовут ОДИН код;
 * пределы и клэмп передаются снаружи, потому что `humanoidRagdoll` в node без мока не грузится.
 *
 * Порядок шагов и все замеры — в комментариях при функциях; математика двухкостной цепи — `limbIk.ts`.
 */
import * as THREE from 'three';
import { solveTwoBone, hingePoleLocal, hingeBendSign, planeSwivel, perpTo, LIMB_SOFT } from './limbIk.js';
import type { LimitView } from './humanoidRagdoll.js';

const V = (): THREE.Vector3 => new THREE.Vector3();
const Q = (): THREE.Quaternion => new THREE.Quaternion();
const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);

/** Кости цепи + корень иерархии (для `updateMatrixWorld`). */
export interface LimbChain { root: THREE.Object3D; mid: THREE.Object3D; end: THREE.Object3D; world: THREE.Object3D }
export interface LimbEnv {
  /** Предел по ИМЕНИ кости (редактор — `limitViewForBone`). */
  limits: (bone: string) => LimitView | null;
  /** Клэмп локального кватерниона к пределу (редактор — `clampLocalToLimit`). */
  clamp: (q: THREE.Quaternion, view: LimitView) => THREE.Quaternion;
  /** Отладочные выключатели ступеней (`__pe.limbDbg`) — в проде все false. */
  dbg?: { noSwivel: boolean; noRootClamp: boolean; noMidClamp: boolean };
}

export const LIMB_PREFER_ARM = new THREE.Vector3(0, -1, -0.4);   // локоть назад-вниз (UE PBIK «preferred angle»)
export const LIMB_PREFER_LEG = new THREE.Vector3(0, 0, 1);       // колено вперёд
export const LIMB_ITERS = 3;

/** Направить КОРЕНЬ так, чтобы его КОНЕЦ цепи (кисть/стопа) смотрел в `target`. Сгиб шарнира уже выставлен, то есть
 *  длина |корень→конец| фиксирована — один поворот ставит конец НА ЦЕЛЬ (или на луч к ней, если длины не хватает). */
export function aimRootAtTarget(root: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3): void {
  if (!root.parent) return;
  root.updateMatrixWorld(true);
  const S = root.getWorldPosition(V());
  const cur = end.getWorldPosition(V()).sub(S), want = target.clone().sub(S);
  if (cur.lengthSq() < 1e-8 || want.lengthSq() < 1e-8) return;
  // ДЕЛЬТА-ПОВОРОТ, а НЕ `aimBoneAt`. `setFromUnitVectors` строит КВАТЕРНИОН ЦЕЛИКОМ минимальной дугой,
  // то есть СТИРАЕТ твист кости — а именно твистом задана плоскость сгиба. Замер: свивель честно уводил
  // колено на 13.1u при стоящей стопе (0.00u), а следующий аим возвращал колено РОВНО НА МЕСТО — оттого оранжевые
  // ручки и «ни на что не влияли». Дельта же поворачивает КАДР ЦЕЛИКОМ и сохраняет и свивель, и позу прошлого кадра
  // (как HumanIK/Unity, которые стартуют из текущей FK-позы).
  const w = root.getWorldQuaternion(Q()).premultiply(Q().setFromUnitVectors(cur.normalize(), want.normalize()));
  root.quaternion.copy(root.parent.getWorldQuaternion(Q()).invert().multiply(w));
  root.updateMatrixWorld(true);
}

/** СВИВЕЛЬ: повернуть корень ВОКРУГ линии корень→цель, чтобы локоть лёг на сторону полюса. Конец цепи
 *  лежит на этой же линии, значит ПО ПОСТРОЕНИЮ НЕ ДВИГАЕТСЯ (Ф23.1: замер — уход конца 0.00u за 120 кадров).
 *  `rootPoleLocal` (ноги) — текущая плоскость берётся из ТВИСТА КОРНЯ, а не из положения колена: у почти прямой
 *  ноги колено в полуюните от линии, и после пересборки шарнира (`setHingeBend`, голень сдвигается на ~4°)
 *  направление этого выноса шумит. Замер в живом редакторе на модели (колено в 0.52u от линии, idle_none_relax):
 *  сдвиг цели стопы на 0.01u проворачивал правое бедро на 19.3° (без свивеля — 1.9°); по плоскости шарнира шаг
 *  свивеля 0.03°, бедро 1.9°. Тот же полюс, что снимает `swivelFromHinge`, — захват и солв меряют одно и то же. */
export function swivelRootToPole(root: THREE.Object3D, mid: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3, rootPoleLocal: THREE.Vector3 | null = null): void {
  if (!root.parent) return;
  root.updateMatrixWorld(true);
  const S = root.getWorldPosition(V());
  const a = target.clone().sub(S); if (a.lengthSq() < 1e-8) return; a.normalize();
  const cur = rootPoleLocal ? perpTo(rootPoleLocal.clone().applyQuaternion(root.getWorldQuaternion(Q())), a) : perpTo(mid.getWorldPosition(V()).sub(S), a);
  const want = perpTo(pole, a);
  if ((rootPoleLocal ? cur.lengthSq() < 1e-8 : cur.length() < 0.3) || want.lengthSq() < 1e-8) return;   // почти прямая цепь (без твиста корня) — плоскость не определена
  cur.normalize(); want.normalize();
  let ang = Math.acos(clamp(cur.dot(want), -1, 1));
  if (V().crossVectors(cur, want).dot(a) < 0) ang = -ang;
  if (Math.abs(ang) < 1e-5) return;
  const w = root.getWorldQuaternion(Q()).premultiply(Q().setFromAxisAngle(a, ang));
  root.quaternion.copy(root.parent.getWorldQuaternion(Q()).invert().multiply(w));
  root.updateMatrixWorld(true);
}

/**
 * СГИБ ШАРНИРА НА ЗАДАННЫЙ УГОЛ, вокруг собственной оси сустава и в пределах таблицы. Знак — туда, куда сустав
 * вообще гнётся (у правого локтя диапазон [−6°, +138°], у левого зеркальный). Авторская поза может быть не ровно
 * прямой (бинд чужого рига), поэтому после установки СМОТРИМ ФАКТИЧЕСКИЙ сгиб и добираем разницу одним шагом
 * (абсолютный угол брать нельзя — тот же урок, что с бинд-избытком фаланг в Ф15).
 */
export function setHingeBend(mid: THREE.Object3D, end: THREE.Object3D, vm: LimitView | null, bend: number, env: LimbEnv): void {
  const aimMid = end.position.clone().normalize();
  if (!vm || vm.kind !== 'hinge' || !vm.axis || env.dbg?.noMidClamp) {
    if (mid.parent) { const d = aimMid.clone().applyQuaternion(Q().setFromAxisAngle(new THREE.Vector3(1, 0, 0), bend)); mid.quaternion.setFromUnitVectors(aimMid, d); mid.updateMatrixWorld(true); }
    return;
  }
  const ax = new THREE.Vector3(vm.axis[0], vm.axis[1], vm.axis[2]).normalize();
  const sign = hingeBendSign(vm);                                      // ⚠ это же правило читает `limbHingePoleLocal` — поодиночке не менять
  const put = (ang: number): number => {
    mid.quaternion.copy(env.clamp(Q().setFromAxisAngle(ax, clamp(ang, vm.min ?? 0, vm.max ?? 0)), vm));
    mid.updateMatrixWorld(true);
    const d = aimMid.clone().applyQuaternion(mid.quaternion);
    return Math.acos(clamp(d.dot(aimMid), -1, 1));                     // фактический сгиб относительно авторской позы
  };
  const want = sign * bend;
  const got = put(want);
  if (Math.abs(got - bend) > 1e-3) put(want + sign * (bend - got));    // один шаг Ньютона под бинд-смещение
}

/** Полюс шарнира в ЛОКАЛЬНОМ фрейме корня (куда выпирает колено/локоть при сгибе). Нет шарнира — `null`. */
export function limbHingePoleLocal(end: THREE.Object3D, vm: LimitView | null): THREE.Vector3 | null {
  if (!vm || vm.kind !== 'hinge' || !vm.axis) return null;
  return hingePoleLocal(new THREE.Vector3(vm.axis[0], vm.axis[1], vm.axis[2]).normalize(), hingeBendSign(vm), end.position.clone().normalize());
}

/** Свивель (рад) от натурального полюса `nat` до плоскости шарнира цепи вокруг линии корень→`H`. */
export function hingePlaneSwivel(c: LimbChain, H: THREE.Vector3, nat: THREE.Vector3, env: LimbEnv): number | null {
  const pl = limbHingePoleLocal(c.end, env.limits(c.mid.name)); if (!pl) return null;
  c.world.updateMatrixWorld(true);
  const S = c.root.getWorldPosition(V());
  const axis = H.clone().sub(S); if (axis.lengthSq() < 1e-8) return null;
  return planeSwivel(axis.normalize(), pl.applyQuaternion(c.root.getWorldQuaternion(Q())), nat);
}

export interface LimbSolveOpts {
  isFoot: boolean;
  /** Плоскость текущего корня мерить по его твисту (ноги) — см. `swivelRootToPole`. */
  planeFromTwist: boolean;
  /** Свивель только в пределах, которые корень реально может повернуть (`swivelFeasible`). */
  twistGuard?: boolean;
}

const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const GUARD_STEP = (2 * Math.PI) / 180;   // сетка поиска: 2°, край уточняется бисекцией
const GUARD_TOL = 1e-3;                   // рад: поворот «в пределе», если клэмп сдвигает его меньше
const GUARD_STAY = 0.3;                   // вес «остаться в текущей плоскости» при недопустимом желаемом (см. `swivelFeasible`)

/**
 * СВИВЕЛЬ В ДОПУСТИМОМ ДИАПАЗОНЕ (Tolani, Goswami, Badler 2000: пределы сустава дают допустимые интервалы угла свивеля,
 * из них берётся ближайший к желаемому). Без этого полюс, требующий твиста плеча за пределом, давал два сбоя сразу
 * (замер стенда, рука ~24u, предел твиста ±97°): клэмп срезал свивель, лучшим кадром оставался прицел с ПРОШЛОЙ
 * плоскостью — локоть «держал место», а рука выкручивалась; когда требование возвращалось в предел с другой стороны
 * круга, свивель перескакивал на 158–165° за кадр.
 * Все кандидаты — это текущий кадр корня, повёрнутый вокруг линии корень→цель, то есть конец цепи стоит на месте по
 * построению; допустимость проверяет ТОТ ЖЕ клэмп, что и солв (свинг и твист разом).
 */
export function swivelFeasible(root: THREE.Object3D, mid: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3, rootPoleLocal: THREE.Vector3 | null, vr: LimitView, env: LimbEnv): void {
  if (!root.parent) return;
  root.updateMatrixWorld(true);
  const S = root.getWorldPosition(V());
  const a = target.clone().sub(S); if (a.lengthSq() < 1e-8) return; a.normalize();
  const Qw = root.getWorldQuaternion(Q());
  const cur = rootPoleLocal ? perpTo(rootPoleLocal.clone().applyQuaternion(Qw), a) : perpTo(mid.getWorldPosition(V()).sub(S), a);
  const want = perpTo(pole, a);
  if ((rootPoleLocal ? cur.lengthSq() < 1e-8 : cur.length() < 0.3) || want.lengthSq() < 1e-8) return;
  cur.normalize(); want.normalize();
  const target0 = Math.atan2(V().crossVectors(cur, want).dot(a), cur.dot(want));   // желаемый поворот вокруг a
  const Pinv = root.parent.getWorldQuaternion(Q()).invert();
  const rot = (d: number): THREE.Quaternion => Pinv.clone().multiply(Q().setFromAxisAngle(a, d).multiply(Qw));
  const dev = (d: number): number => { const q = rot(d); return q.angleTo(env.clamp(q, vr)); };
  let best = target0;
  if (dev(target0) > GUARD_TOL) {
    // Ближайший допустимый к желаемому; допустимого нет вовсе — тот, что меньше всего режется клэмпом.
    // `GUARD_STAY` — лёгкая тяга к ТЕКУЩЕЙ плоскости: иначе, когда желаемое проходит запрещённую зону, выбор перескакивает
    // с края на край ровно на её середине. Замер стенда (правка оранжевой ручкой −92° и −115°, затухание 25u): кисть за
    // головой 153° → 2.6° за кадр, к груди 122° → 19.5°, вверх 112° → 4°; обычные пути не изменились. 1.0 уже мешает
    // законным поворотам (гребок и петли после правки −60°: 3° → 27–35°).
    const cost = (d: number): number => { const v = dev(d); return (v > GUARD_TOL ? 10 + 10 * v : 0) + Math.abs(wrapPi(d - target0)) + GUARD_STAY * Math.abs(wrapPi(d)); };
    let bc = cost(0); best = 0;
    for (let k = 0; k < 180; k++) { const d = -Math.PI + k * GUARD_STEP; const c = cost(d); if (c < bc) { bc = c; best = d; } }
    if (dev(best) <= GUARD_TOL) {
      // Край допустимого — бисекцией к желаемому: сетка в 2° иначе дрожала бы ступеньками кадр к кадру.
      let ok = best, bad = best + Math.sign(wrapPi(target0 - best)) * GUARD_STEP;
      if (dev(bad) > GUARD_TOL) for (let i = 0; i < 12; i++) { const m = (ok + bad) / 2; if (dev(m) <= GUARD_TOL) ok = m; else bad = m; }
      else ok = bad;
      best = ok;
    }
  }
  if (Math.abs(best) < 1e-6) return;
  root.quaternion.copy(rot(best));
  root.updateMatrixWorld(true);
}

/**
 * АНАЛИТИЧЕСКАЯ КОНЕЧНОСТЬ С ПРЕДЕЛАМИ (Ф25.2). Порядок — как в ozz-animation / Unity TwoBoneIK, и это
 * главное решение ФТ5:
 *   1) ШАРНИР СТАВИТСЯ УГЛОМ по закону косинусов ВОКРУГ СВОЕЙ ОСИ, а не «целься в точку и потом клэмп».
 *      Предыдущая версия целила предплечье минимальной дугой, а 1-DOF клэмп ВЫБРАСЫВАЕТ внеосевую часть —
 *      вместе с ней уходил СГИБ (замер «колено вверх»: 88° вместо 116°, недолёт 13.3u; без клэмпа — 116°/0.00u).
 *   2) КОРЕНЬ ЦЕЛИТ КОНЕЦ ЦЕПИ В ЦЕЛЬ (а не себя в локоть): длина |корень→конец| уже задана сгибом,
 *      поэтому один поворот ставит кисть РОВНО НА РУЧКУ. Именно это делает «рука улетела от хелпера» невозможным:
 *      предел плеча теперь забирает СТОРОНУ ЛОКТЯ, а не дотягивание.
 *   3) СВИВЕЛЬ к полюсу вокруг линии корень→цель — конец не двигается, меняется только плоскость сгиба.
 * Клэмп плеча/бедра после каждого шага может сбить конец — поэтому шаги 2–3 повторяются и хранится ЛУЧШИЙ
 * кадр (сходимость не гарантирована, когда полюс требует твиста за пределом).
 */
export function solveLimbChain(c: LimbChain, target: THREE.Vector3, pole: THREE.Vector3, opts: LimbSolveOpts, env: LimbEnv): number {
  const { root, mid, end } = c;
  if (!root.parent) return Infinity;
  c.world.updateMatrixWorld(true);
  const L1 = mid.position.length(), L2 = end.position.length();
  const S = root.getWorldPosition(V());
  const r = solveTwoBone({ S, H: target, pole, L1, L2, soft: LIMB_SOFT, prefer: opts.isFoot ? LIMB_PREFER_LEG : LIMB_PREFER_ARM });
  const vr = env.limits(root.name), vm = env.limits(mid.name);
  setHingeBend(mid, end, vm, r.bend, env);
  const rootPole = opts.planeFromTwist ? limbHingePoleLocal(end, vm) : null;
  const clampRoot = (): void => {
    if (!vr || env.dbg?.noRootClamp) return;
    root.quaternion.copy(env.clamp(root.quaternion, vr)); root.updateMatrixWorld(true);
  };
  let best = Infinity, bq = root.quaternion.clone(), bm = mid.quaternion.clone();
  // ЛУЧШИЙ КАДР СНИМАЕТСЯ ПОСЛЕ КАЖДОГО ШАГА, а не в конце итерации: полюс — ПОЖЕЛАНИЕ, цель — ТРЕБОВАНИЕ
  // (та же иерархия, что у pole vector в Maya). Замер без этого: «кисть к бедру» — прицеливание давало 0.00u,
  // но свивель требовал твист за пределом, клэмп уводил кисть — и записывался ИМЕННО испорченный кадр (9.3u).
  // НЕ ХУЖЕ — ЗНАЧИТ БЕРЁМ ПОЗДНИЙ. Свивель НЕ двигает конец (вращение вокруг линии корень→цель), то есть даёт
  // РОВНО ТОТ ЖЕ недолёт — и при строгом «лучше» его кадр отбрасывался всегда, когда цель достижима: оранжевая ручка
  // колена не двигала колено ВООБЩЕ (замер: 0.00u на тяге 6u) — та же жалоба, что в Ф23.
  const rec = (): number => {
    const m = end.getWorldPosition(V()).distanceTo(target);
    if (m < best + 1e-4) { best = Math.min(best, m); bq = root.quaternion.clone(); bm = mid.quaternion.clone(); }
    return m;
  };
  for (let it = 0; it < LIMB_ITERS; it++) {
    aimRootAtTarget(root, end, target); clampRoot(); rec();
    if (!env.dbg?.noSwivel) {
      if (opts.twistGuard && vr && !env.dbg?.noRootClamp) swivelFeasible(root, mid, target, pole, rootPole, vr, env);
      else swivelRootToPole(root, mid, target, pole, rootPole);
      clampRoot(); rec();
      aimRootAtTarget(root, end, target); clampRoot(); rec();
    }
    if (best < 1e-3) break;
  }
  root.quaternion.copy(bq); mid.quaternion.copy(bm); c.world.updateMatrixWorld(true);
  return best;
}
