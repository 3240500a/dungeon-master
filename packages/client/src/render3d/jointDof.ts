/**
 * СТЕПЕНИ СВОБОДЫ СУСТАВА: **SWING-TWIST**, без вырождений.
 *
 * Поза сустава = три скаляра `[rP, rN, twist]`:
 *   swing = `exp(rP·plane + rN·normal)` — поворот, уводящий ОСЬ КОСТИ из покоя (вектор поворота, лог-карта);
 *   twist = поворот ВОКРУГ САМОЙ ОСИ кости.
 *   `q = swing · twist` — ровно разложение, которым живут Bullet, Jolt, PhysX, Blender-IK (`IK_QSwingSegment` +
 *   отдельный твист-сегмент). Пределы: асимметричный бокс по (rP, rN) + свой диапазон твиста — то же, что рисует
 *   `poseLimitGizmo`, и то же, чем клэмпит `jointClamp`.
 *
 * ПОЧЕМУ НЕ ЭЙЛЕР (было, откачено — юзер поймал живьём). Эйлерова цепочка удобна тем, что «одно кольцо = один
 * скаляр», но у неё ГИМБАЛ-ЛОК на ±90° средней оси, и он ДОСТИЖИМ: у плеча средняя ось — сгиб с пределом ±97.4°.
 * ЗАМЕР ровно в рабочей позе (рука занесена вперёд-вверх, сгиб 90°): угол между осями «подъём» и «твист» вырос
 * 90° → 180°, оси СХЛОПНУЛИСЬ, кольцо подъёма перестало двигать руку вообще (ось руки [0,0,−1] при любом угле).
 * Симптом юзера дословно: «плечо упирается и выше не поднимается, две оси становятся твистами со своим
 * ограничением, обратно в T-позу не вернуть». У swing-twist вырождение только при свинге 180° — недостижимо.
 *
 * ЧЕМ ПЛАТИМ И ПОЧЕМУ ЭТО НЕ ПРОБЛЕМА. Правка ОДНОГО скаляра свинга (`rP`) двигает кость не по кругу вокруг оси
 * `plane` — `rP`,`rN` компоненты ОДНОГО вектора поворота. Поэтому кольца свинга НЕ правят скаляр напрямую:
 * `swingRing()` делает ЧЕСТНЫЙ поворот вокруг нарисованной оси и убирает наведённый твист (Blender `RemoveTwist`).
 * Кость идёт ровно за кольцом, твист не появляется сам, а скаляры пересчитываются как следствие.
 *
 * Рест-фрейм наших костей = identity (`humanoid.ts` строит их без поворота), поэтому локальный кватернион кости и
 * есть отклонение от покоя — оси `plane/normal/twist` из `LimitView` заданы в нём же.
 *
 * Чистый модуль: только THREE + структурный тип предела (тип импортится type-only → node-тесты не тянут DOM).
 */
import * as THREE from 'three';
import type { LimitView } from './humanoidRagdoll.js';

/** Скаляры сустава (рад), ВСЕГДА в порядке [rP (вокруг plane), rN (вокруг normal), twist]. */
export type Dof = [number, number, number];
export type DofKind = 'plane' | 'normal' | 'twist' | 'locked';

export interface DofSpec {
  /** Ортонормированный ПРАВОСТОРОННИЙ базис в локальном (рест) фрейме кости: столбцы [plane, normal, twist]. */
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  kind: [DofKind, DofKind, DofKind];
  min: Dof; max: Dof;
  /** Ось заперта (шарнир): скаляр всегда 0, кольцо не рисуем. */
  locked: [boolean, boolean, boolean];
}

const V = (a: readonly number[]): THREE.Vector3 => new THREE.Vector3(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0).normalize();
const anyPerp = (d: THREE.Vector3): THREE.Vector3 => {
  const t = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  return t.addScaledVector(d, -t.dot(d)).normalize();
};

/** Разложить `LimitView` в спецификацию осей. Шарнир = 1 DOF: свинг заперт, работает только «твист» вокруг оси сгиба. */
export function dofSpec(view: LimitView): DofSpec {
  if (view.kind === 'hinge') {
    const ax = V(view.axis ?? [0, 1, 0]);
    const x = anyPerp(ax), y = new THREE.Vector3().crossVectors(ax, x).normalize();   // (x,y,ax) правосторонний
    return {
      axes: [x, y, ax], kind: ['locked', 'locked', 'twist'],
      min: [0, 0, view.min ?? 0], max: [0, 0, view.max ?? 0],
      locked: [true, true, false],
    };
  }
  // normal = cross(twist, plane) (так его строит humanoidRagdoll) ⇒ базис (plane, normal, twist) ПРАВОСТОРОННИЙ.
  return {
    axes: [V(view.plane ?? [0, 1, 0]), V(view.normal ?? [0, 0, 1]), V(view.twist ?? [1, 0, 0])],
    kind: ['plane', 'normal', 'twist'],
    min: [view.planeMin ?? 0, view.normalMin ?? 0, view.twistMin ?? 0],
    max: [view.planeMax ?? 0, view.normalMax ?? 0, view.twistMax ?? 0],
    locked: [false, false, false],
  };
}

const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _sv = new THREE.Vector3();
const _sw = new THREE.Quaternion(), _tw = new THREE.Quaternion(), _tmp = new THREE.Quaternion();

/** Кватернион свинга из его компонент: ось = направление вектора (rP,rN) в плоскости plane/normal, угол = его длина. */
function swingQuat(s: DofSpec, rP: number, rN: number, out: THREE.Quaternion): THREE.Quaternion {
  const mag = Math.hypot(rP, rN);
  if (mag < 1e-9) return out.identity();
  _v.copy(s.axes[0]).multiplyScalar(rP / mag).addScaledVector(s.axes[1], rN / mag);
  return out.setFromAxisAngle(_v, mag);
}

/** СОБРАТЬ кватернион кости из скаляров: `q = swing(rP,rN) · twist`. */
export function quatFromDof(view: LimitView, th: Dof): THREE.Quaternion {
  const s = dofSpec(view);
  swingQuat(s, th[0], th[1], _sw);
  _tw.setFromAxisAngle(s.axes[2], th[2]);
  return new THREE.Quaternion().copy(_sw).multiply(_tw);
}

/** Скалярный клэмп (диапазоны АСИММЕТРИЧНЫ; запертая ось → строго 0). Ветвей и перескоков тут нет. */
export function clampDof(view: LimitView, th: Dof): Dof {
  const s = dofSpec(view);
  const out: Dof = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = s.locked[i] ? 0 : Math.min(Math.max(th[i]!, s.min[i]!), s.max[i]!);
  return out;
}

/** Разложить `q` на swing·twist вокруг оси `T`: результат в `_sw`/`_tw` (оба приведены к кратчайшему знаку). */
function splitSwingTwist(q: THREE.Quaternion, T: THREE.Vector3): void {
  _v.set(q.x, q.y, q.z);
  const d = _v.dot(T);                                  // проекция мнимой части на ось твиста
  _tw.set(T.x * d, T.y * d, T.z * d, q.w);
  if (_tw.lengthSq() < 1e-12) _tw.identity(); else _tw.normalize();
  _sw.copy(q).multiply(_tmp.copy(_tw).conjugate());     // swing = q · twist⁻¹
  if (_sw.w < 0) { _sw.x = -_sw.x; _sw.y = -_sw.y; _sw.z = -_sw.z; _sw.w = -_sw.w; }
  if (_tw.w < 0) { _tw.x = -_tw.x; _tw.y = -_tw.y; _tw.z = -_tw.z; _tw.w = -_tw.w; }
}

/**
 * РАЗЛОЖИТЬ кватернион кости в скаляры — для импорта, выбора кости и клэмпа. Обратное к `quatFromDof`.
 * Разложение ОДНОЗНАЧНО (ветвей, как у эйлера, нет) и определено всюду, кроме свинга ровно 180° — недостижимо.
 * `prev` (если есть) выбирает ближайшую 2π-ветвь ТВИСТА — единственной величины, которая может накрутить обороты.
 */
export function dofFromQuat(view: LimitView, q: THREE.Quaternion, prev?: Dof): Dof {
  const s = dofSpec(view);
  splitSwingTwist(q, s.axes[2]);
  let tw = 2 * Math.atan2(_v.set(_tw.x, _tw.y, _tw.z).dot(s.axes[2]), _tw.w);
  if (prev) tw += Math.round((prev[2]! - tw) / (Math.PI * 2)) * (Math.PI * 2);
  if (s.locked[0] && s.locked[1]) return [0, 0, tw];                    // шарнир: свинг отбрасываем жёстко
  _sv.set(_sw.x, _sw.y, _sw.z);
  const l = _sv.length();
  if (l < 1e-9) return [0, 0, tw];
  const ang = 2 * Math.atan2(l, _sw.w);                                 // ∈ [0, π] — свинг уже кратчайший
  _sv.multiplyScalar(1 / l);
  return [ang * _sv.dot(s.axes[0]), ang * _sv.dot(s.axes[1]), tw];
}

const TAU2 = Math.PI * 4;   // период угла, восстановленного из кватерниона (q и −q — ОДИН поворот, отсюда 4π, не 2π)
/**
 * СЛОЙ ГИЗМО: дельта кольца → приращение накопителя ввода.
 *
 * `dq` — поворот прокси относительно точки захвата, выраженный в осях фрейма колец; `TransformControls` в режиме
 * `local` даёт ровно `axisAngle(unit[axis], φ)`, поэтому угол снимается точно: `φ = 2·atan2(q[axis], q.w)`.
 * Возвращает `[raw, step]`: `raw` — для следующего кадра, `step` — приращение накопителя.
 *
 * Накопитель обязателен: за пределом поза стоит, и если читать угол ИЗ ПОЗЫ, обратный ход начнётся сразу и
 * «туда-обратно» перестанет быть точным. Копим ЗАПРОШЕННЫЙ угол от захвата — так же снимает `irot` Blender.
 */
export function ringDelta(dq: THREE.Quaternion, axis: number, prevRaw: number): [number, number] {
  const c = axis === 0 ? dq.x : axis === 1 ? dq.y : dq.z;
  const raw = 2 * Math.atan2(c, dq.w), d = raw - prevRaw;
  return [raw, d - Math.round(d / TAU2) * TAU2];
}
/** Ось кольца по доминирующей компоненте — фолбэк, когда гизмо не назвало X/Y/Z (свободные кольца E/XYZE). */
export function ringAxis(dq: THREE.Quaternion): number {
  const x = Math.abs(dq.x), y = Math.abs(dq.y), z = Math.abs(dq.z);
  return x >= y && x >= z ? 0 : y >= z ? 1 : 2;
}

/**
 * ФРЕЙМ КОЛЕЦ ГИЗМО (относительно РОДИТЕЛЯ кости) = `swing · базис`.
 *
 * Кольцо обязано стоять там, где оно РЕАЛЬНО крутит, и здесь это выполняется ТОЧНО для всех трёх:
 *   Z = swing·twistAxis — ТЕКУЩАЯ ось кости (кольцо твиста обнимает кость в любой позе);
 *   X, Y = swing·plane, swing·normal — ровно те оси, вокруг которых поворачивает `swingRing`.
 * Никаких компромиссов «одно кольцо из трёх неточное», как было у эйлеровой цепочки: там истинные оси
 * неортогональны, а здесь фрейм ортонормирован по построению — потому что кольца задают ПОВОРОТ, а не скаляр.
 */
export function gimbalFrame(view: LimitView, th: Dof): THREE.Quaternion {
  const s = dofSpec(view);
  swingQuat(s, th[0], th[1], _sw);
  _m.makeBasis(s.axes[0], s.axes[1], s.axes[2]);
  return _sw.clone().multiply(_tmp.setFromRotationMatrix(_m));
}

/**
 * Свинг больше этого угла не строим. У вектора поворота на 180° МЕНЯЕТСЯ ЗНАК ОСИ: композиция «крутим кольцо
 * дальше» проходит через π и возвращается с другой стороны, кость срывается с упора и уезжает назад.
 * ЗАМЕР (живьём, плечо): 400° по кольцу подъёма давали свинг −40° вместо упора −108.9°, а ещё 60° — −100°.
 * Бокс пределов заведомо у́же этого потолка (у плеча max |свинг| = hypot(97.4, 108.9) ≈ 146°), так что упор
 * всегда ставит ПРЕДЕЛ, а не потолок; потолок лишь не даёт композиции провернуться.
 */
const SWING_CAP = Math.PI * 0.94;   // 169°

/**
 * ДРАГ КОЛЬЦА → новые скаляры. `th0` — скаляры на ЗАХВАТЕ, `ring` — индекс кольца, `phi` — НАКОПЛЕННЫЙ угол ввода.
 *
 * Кольцо твиста (2) правит свой скаляр напрямую — он и есть поворот вокруг оси кости.
 * Кольца свинга (0,1) делают ЧЕСТНЫЙ поворот вокруг нарисованной оси `swing0·axes[ring]`: тождество
 * `q·R(a,φ) = R(q·a,φ)·q` означает, что `swing0 · R(axes[ring], φ)` — это ровно поворот вокруг ТЕКУЩЕЙ (несомой
 * свингом) оси кольца. Кость идёт за кольцом один-в-один.
 *
 * ⚠ Композиция двух свингов свинг НЕ даёт (`swing·swing ≠ swing`, чистые свинги не образуют подгруппу SO(3)) —
 * она РОЖДАЕТ твист. Поэтому наведённый твист сразу отбрасывается, а твист берётся из `th0`: ровно то, что делает
 * Blender (`RemoveTwist` после каждой композиции), Jolt («leave out the x component in order to not introduce
 * twist») и Bullet («don't let cone response affect twist»). Направление кости от этого не меняется вообще
 * (`(swing·twist)·T = swing·T`), меняется только крен — тот, которым и не должен управлять свинг.
 */
export function swingRing(view: LimitView, th0: Dof, ring: number, phi: number): Dof {
  const s = dofSpec(view);
  if (ring === 2 || s.locked[0]) return [th0[0], th0[1], th0[2] + phi];
  const ax = s.axes[ring === 0 ? 0 : 1];
  /** Угол свинга (после снятия наведённого твиста) при вводе `t`; побочно оставляет свинг в `_sw`. */
  const swingAngle = (t: number): number => {
    swingQuat(s, th0[0], th0[1], _sw);
    _tmp.setFromAxisAngle(ax, t);
    splitSwingTwist(_sw.clone().multiply(_tmp), s.axes[2]);   // наведённый твист долой — им правит только своё кольцо
    return 2 * Math.atan2(Math.hypot(_sw.x, _sw.y, _sw.z), _sw.w);
  };
  // Не даём композиции провернуться через π. СМОТРИМ НА ПУТЬ, А НЕ НА КОНЕЦ: угол свинга растёт до 180° и потом
  // ПАДАЕТ обратно, уже с перевёрнутой осью, поэтому по конечному значению проворот неотличим от нормы — на этом
  // я и обжёгся (ввод −191° давал угол 169° < потолка, проверка молчала, а кость срывалась с упора на +108.9°).
  // Ищем ПЕРВОЕ пересечение потолка сканом с шагом ≤ 10° (полоса «выше потолка» шириной ~22° не проскакивает),
  // затем уточняем бисекцией. Скан не нужен вовсе, если и сумма углов до потолка не дотягивает.
  let use = phi;
  if (Math.hypot(th0[0], th0[1]) + Math.abs(phi) > SWING_CAP) {
    const n = Math.min(512, Math.max(32, Math.ceil(Math.abs(phi) / (10 / 180 * Math.PI))));
    let lo = 0, hi = phi;
    for (let i = 1; i <= n; i++) {
      const t = phi * (i / n);
      if (swingAngle(t) > SWING_CAP) { hi = t; break; }
      lo = t;
    }
    for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (swingAngle(m) > SWING_CAP) hi = m; else lo = m; }
    use = lo;
  }
  swingAngle(use);                                        // финальный свинг снова в `_sw`
  _sv.set(_sw.x, _sw.y, _sw.z);
  const l = _sv.length();
  if (l < 1e-9) return [0, 0, th0[2]!];
  const ang = 2 * Math.atan2(l, _sw.w);
  _sv.multiplyScalar(1 / l);
  return [ang * _sv.dot(s.axes[0]), ang * _sv.dot(s.axes[1]), th0[2]!];
}
