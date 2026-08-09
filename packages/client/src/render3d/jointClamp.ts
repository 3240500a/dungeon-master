/**
 * КЛЭМП ЛОКАЛЬНОГО ПОВОРОТА КОСТИ К ПРЕДЕЛУ СУСТАВА (swing-twist декомпозиция, как the-orange-duck / Final IK).
 * Чтобы манекен в поз-редакторе ОБЯЗАТЕЛЬНО слушался пределов (иначе гизмо врёт — руку можно согнуть назад).
 * Кость упирается ровно в границу конуса/шарнира. Та же параметризация (rP,rN,twist) рисуется гизмо → гизмо=реальность.
 *
 * Чистый модуль: только THREE + СТРУКТУРНЫЙ тип предела (тип импортится type-only → node-тест не тянет DOM env3d).
 * Rest-фрейм костей гуманоида = identity (T-поза), поэтому клэмпим локальный кватернион напрямую (= отклонение от покоя).
 */
import * as THREE from 'three';
import type { LimitView } from './humanoidRagdoll.js';

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
const _v = new THREE.Vector3(), _sv = new THREE.Vector3(), _P = new THREE.Vector3(), _N = new THREE.Vector3(), _T = new THREE.Vector3(), _A = new THREE.Vector3();
const _tw = new THREE.Quaternion(), _sw = new THREE.Quaternion(), _out = new THREE.Quaternion();

/** Разложить q = swing · twist, где twist — вокруг оси `axis` (единичной). Результат в _sw/_tw (перезаписываются). */
function decompose(q: THREE.Quaternion, axis: THREE.Vector3): void {
  _v.set(q.x, q.y, q.z);
  const d = _v.dot(axis);                       // проекция мнимой части на ось твиста
  _tw.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  if (_tw.lengthSq() < 1e-12) _tw.identity(); else _tw.normalize();
  _sw.copy(q).multiply(_tw.clone().conjugate());   // swing = q · twist⁻¹
  if (_sw.w < 0) { _sw.x = -_sw.x; _sw.y = -_sw.y; _sw.z = -_sw.z; _sw.w = -_sw.w; }   // кратчайший (double-cover)
  if (_tw.w < 0) { _tw.x = -_tw.x; _tw.y = -_tw.y; _tw.z = -_tw.z; _tw.w = -_tw.w; }
}
/** Знаковый угол твиста (вокруг оси) из кватерниона твиста. */
function twistAngle(tw: THREE.Quaternion, axis: THREE.Vector3): number {
  const s = _v.set(tw.x, tw.y, tw.z).dot(axis);   // sin(θ/2) вдоль оси
  return 2 * Math.atan2(s, tw.w);
}

/** Клэмпнуть локальный кватернион `q` к пределу `view`. Возвращает НОВЫЙ THREE.Quaternion (q не мутируется). */
export function clampLocalToLimit(q: THREE.Quaternion, view: LimitView): THREE.Quaternion {
  if (view.kind === 'hinge') {
    _A.set(view.axis![0], view.axis![1], view.axis![2]).normalize();
    decompose(q, _A);
    const ha = clamp(twistAngle(_tw, _A), view.min ?? 0, view.max ?? 0);
    return _out.setFromAxisAngle(_A, ha).clone();   // шарнир 1-DOF: внеосевой swing отбрасываем (жёстко)
  }
  _T.set(view.twist![0], view.twist![1], view.twist![2]).normalize();
  _P.set(view.plane![0], view.plane![1], view.plane![2]).normalize();
  _N.set(view.normal![0], view.normal![1], view.normal![2]).normalize();
  decompose(q, _T);
  // twist
  const tw = clamp(twistAngle(_tw, _T), view.twistMin ?? 0, view.twistMax ?? 0);
  // swing → вектор поворота (лог-карта): rP вокруг plane, rN вокруг normal; клэмп к асимм. боксу
  _sv.set(_sw.x, _sw.y, _sw.z);
  const svl = _sv.length();
  const sAngle = 2 * Math.atan2(svl, _sw.w);       // ∈ [0, π] (swing уже кратчайший)
  let rP = 0, rN = 0;
  if (svl > 1e-8) { _sv.multiplyScalar(1 / svl); rP = sAngle * _sv.dot(_P); rN = sAngle * _sv.dot(_N); }
  rP = clamp(rP, view.planeMin ?? 0, view.planeMax ?? 0);
  rN = clamp(rN, view.normalMin ?? 0, view.normalMax ?? 0);
  const mag = Math.hypot(rP, rN);
  if (mag < 1e-8) _sw.identity();
  else _sw.setFromAxisAngle(_v.copy(_P).multiplyScalar(rP / mag).addScaledVector(_N, rN / mag), mag);
  _tw.setFromAxisAngle(_T, tw);
  return _out.copy(_sw).multiply(_tw).clone();      // q' = swing' · twist'
}

/** Разложить локальный кватернион на (rP, rN, twist) в осях предела — для ИНДИКАТОРА текущего положения в гизмо. */
export function decomposeToLimit(q: THREE.Quaternion, view: LimitView): { rP: number; rN: number; twist: number } {
  if (view.kind === 'hinge') { _A.set(view.axis![0], view.axis![1], view.axis![2]).normalize(); decompose(q, _A); return { rP: 0, rN: 0, twist: twistAngle(_tw, _A) }; }
  _T.set(view.twist![0], view.twist![1], view.twist![2]).normalize();
  _P.set(view.plane![0], view.plane![1], view.plane![2]).normalize();
  _N.set(view.normal![0], view.normal![1], view.normal![2]).normalize();
  decompose(q, _T);
  const tw = twistAngle(_tw, _T);
  _sv.set(_sw.x, _sw.y, _sw.z); const svl = _sv.length(); const sAngle = 2 * Math.atan2(svl, _sw.w);
  if (svl <= 1e-8) return { rP: 0, rN: 0, twist: tw };
  _sv.multiplyScalar(1 / svl);
  return { rP: sAngle * _sv.dot(_P), rN: sAngle * _sv.dot(_N), twist: tw };
}
