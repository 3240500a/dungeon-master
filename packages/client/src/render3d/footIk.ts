// ── FOOT-IK ЗАЗЕМЛИТЕЛЬ (как Grounder/Final IK в Unity) ──────────────────────────────
// Рейкаст пола под каждой стопой → цель кости стопы = пол + подошва; 2-костный IK ноги догибает колено ровно на пол,
// таз опускается под нижнюю опору. Стопа не тонет и не висит. Только THREE + тип Humanoid (без физ-цепочки) → тестируемо.
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';

/** Запрос высоты пола (мир) в точке XZ. Сейчас плоский (floorY); позже — рейкаст по коллизии 3д-пола. */
export type GroundQuery = (x: number, z: number) => number;

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
const SOLE = 1.5;                    // высота кости стопы над полом, когда подошва на полу (= FOOT_Y в pose.ts)
const IK_THIGH = 15, IK_SHIN = 14;   // фактические длины костей ноги из BONES (UpperLeg→LowerLeg, LowerLeg→Foot)
const IK_MAX = IK_THIGH + IK_SHIN - 0.5, IK_MIN = Math.abs(IK_THIGH - IK_SHIN) + 0.5;
const PLANT_MAX = 6;                 // стопа выше своего пола меньше этого → ОПОРНАЯ (планти на пол); выше → маховая (не трогаем)
const IK_LEGS = [{ u: 'LeftUpperLeg', l: 'LeftLowerLeg', f: 'LeftFoot' }, { u: 'RightUpperLeg', l: 'RightLowerLeg', f: 'RightFoot' }];
const _DOWN = new THREE.Vector3(0, -1, 0);
const _iH = new THREE.Vector3(), _iT = new THREE.Vector3(), _iK = new THREE.Vector3(), _iDir = new THREE.Vector3();
const _iThigh = new THREE.Vector3(), _iShin = new THREE.Vector3(), _iBend = new THREE.Vector3(), _iPole = new THREE.Vector3(), _iFoot = new THREE.Vector3();
const _ipq = new THREE.Quaternion(), _iwq = new THREE.Quaternion();

/** Прицелить кость так, чтобы её локальная ось −Y (ось конечности в риге) смотрела в мировое направление dir. */
function aimBoneDown(bone: THREE.Object3D, dir: THREE.Vector3): void {
  bone.parent!.getWorldQuaternion(_ipq);
  _iwq.setFromUnitVectors(_DOWN, dir);                 // мировой поворот: −Y → dir
  bone.quaternion.copy(_ipq).invert().multiply(_iwq);  // локальный = parent⁻¹ · мировой
}

/** Аналитический 2-костный IK ноги: гнём бедро+колено так, чтобы кость стопы встала в targetWorld.
 *  pole — направление сгиба колена (вперёд). Длины костей фиксированы, кламп разгиба против дрожи. */
export function legGroundIK(upper: THREE.Object3D, lower: THREE.Object3D, targetWorld: THREE.Vector3, pole: THREE.Vector3): void {
  upper.getWorldPosition(_iH);
  _iDir.subVectors(targetWorld, _iH);
  let dist = _iDir.length(); if (dist < 1e-3) return;
  dist = clamp(dist, IK_MIN, IK_MAX); _iDir.normalize();
  const a = Math.acos(clamp((IK_THIGH * IK_THIGH + dist * dist - IK_SHIN * IK_SHIN) / (2 * IK_THIGH * dist), -1, 1));
  _iBend.crossVectors(_iDir, pole);
  if (_iBend.lengthSq() < 1e-6) _iBend.set(1, 0, 0); else _iBend.normalize();
  _iThigh.copy(_iDir).applyAxisAngle(_iBend, a);       // бедро: линия к цели, отклонённая на a → колено вперёд
  aimBoneDown(upper, _iThigh); upper.updateMatrixWorld(true);
  _iK.copy(_iH).addScaledVector(_iThigh, IK_THIGH);    // колено в мире
  _iShin.subVectors(targetWorld, _iK).normalize();
  aimBoneDown(lower, _iShin); lower.updateMatrixWorld(true);
}

/**
 * Заземлить стопы меша (после физики+бленда+корня): пол под каждой стопой → цель = пол + SOLE. Таз поднимаем под самую
 * «провалившуюся» ОПОРНУЮ стопу (мгновенно вниз-провал, плавно оседая), затем per-foot IK плантит каждую опорную стопу
 * ровно на её пол (маховую, задранную выше PLANT_MAX, не трогаем). baseY = физ-Y таза; gs.off — сглаж. сдвиг корня.
 */
export function groundFeet(mesh: Humanoid, baseY: number, gs: { off: number }, dt: number, gnd: GroundQuery): void {
  const hips = mesh.bones.get('Hips'); if (!hips) return;
  hips.getWorldQuaternion(_ipq); _iPole.set(0, 0, 1).applyQuaternion(_ipq); _iPole.y = 0;   // фронт тела = pole колена
  if (_iPole.lengthSq() < 1e-6) _iPole.set(0, 0, 1); else _iPole.normalize();
  const tgt: number[] = []; let worst = -Infinity;
  for (const leg of IK_LEGS) {
    const fb = mesh.bones.get(leg.f); if (!fb) { tgt.push(NaN); continue; }
    fb.getWorldPosition(_iFoot);
    const ty = gnd(_iFoot.x, _iFoot.z) + SOLE; tgt.push(ty);
    if (_iFoot.y - ty < PLANT_MAX) worst = Math.max(worst, ty - _iFoot.y);   // опорная (не задранная маховая)
  }
  if (Number.isFinite(worst)) {
    gs.off += worst > 0 ? worst : worst * Math.min(1, dt * 10);     // провал → мгновенно вверх; выше пола → плавно вниз
    mesh.root.position.y = baseY + gs.off; mesh.root.updateMatrixWorld(true);
  }
  for (let i = 0; i < IK_LEGS.length; i++) {                        // планти опорные стопы на их пол
    const leg = IK_LEGS[i]!, ty = tgt[i]!; if (!Number.isFinite(ty)) continue;
    const ub = mesh.bones.get(leg.u), lb = mesh.bones.get(leg.l), fb = mesh.bones.get(leg.f);
    if (!ub || !lb || !fb) continue;
    fb.getWorldPosition(_iFoot);
    if (_iFoot.y - ty < PLANT_MAX) legGroundIK(ub, lb, _iT.set(_iFoot.x, ty, _iFoot.z), _iPole);
  }
}
