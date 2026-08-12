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
const GROUND_LAG = 8;                // скорость сглаживания сдвига таза к полу (меньше → мягче/плавнее боб)
const IK_LEGS = [{ u: 'LeftUpperLeg', l: 'LeftLowerLeg', f: 'LeftFoot' }, { u: 'RightUpperLeg', l: 'RightLowerLeg', f: 'RightFoot' }];
const _DOWN = new THREE.Vector3(0, -1, 0), _UP = new THREE.Vector3(0, 1, 0);
const _iH = new THREE.Vector3(), _iT = new THREE.Vector3(), _iK = new THREE.Vector3(), _iDir = new THREE.Vector3();
const _iThigh = new THREE.Vector3(), _iShin = new THREE.Vector3(), _iBend = new THREE.Vector3(), _iPole = new THREE.Vector3(), _iFoot = new THREE.Vector3();
const _ipq = new THREE.Quaternion(), _iwq = new THREE.Quaternion(), _iFace = new THREE.Quaternion(), _iAxis = new THREE.Vector3();
const _fFwdL = new THREE.Vector3(), _fThirdL = new THREE.Vector3(), _fDir = new THREE.Vector3(), _fFwdW = new THREE.Vector3(), _fThirdW = new THREE.Vector3();
const _mL = new THREE.Matrix4(), _mW = new THREE.Matrix4(), _FWD_L = new THREE.Vector3(0, 0, 1);

/** Прицелить кость ПОЛНЫМ ФРЕЙМОМ (не кратчайшей дугой): ось сегмента → `dir`, а «перёд» кости (лок. +Z, ортогонал. к сегменту)
 *  → `fwd` (спроецированный ⊥ dir). Так ТВИСТ вокруг ноги ЗАДАН → колено смотрит вперёд и не разворачивается наружу при
 *  боковом дотяге (кратчайшая дуга `setFromUnitVectors` твист не задавала → заземление крутило колени). child=null → фолбэк −Y. */
function aimBoneFrame(bone: THREE.Object3D, child: THREE.Object3D | null, dir: THREE.Vector3, fwd: THREE.Vector3): void {
  _iAxis.copy(child ? child.position : _DOWN); if (_iAxis.lengthSq() < 1e-9) _iAxis.copy(_DOWN); else _iAxis.normalize();   // сегмент (лок.)
  _fFwdL.copy(_FWD_L).addScaledVector(_iAxis, -_FWD_L.dot(_iAxis));                       // лок. «перёд» +Z ⊥ сегмента
  if (_fFwdL.lengthSq() < 1e-6) { _fFwdL.set(1, 0, 0).addScaledVector(_iAxis, -_iAxis.x); }
  _fFwdL.normalize(); _fThirdL.crossVectors(_iAxis, _fFwdL);
  _fDir.copy(dir).normalize();
  _fFwdW.copy(fwd).addScaledVector(_fDir, -fwd.dot(_fDir));                                // мир. «перёд» (pole) ⊥ dir
  if (_fFwdW.lengthSq() < 1e-6) { _fFwdW.set(1, 0, 0).addScaledVector(_fDir, -_fDir.x); }
  _fFwdW.normalize(); _fThirdW.crossVectors(_fDir, _fFwdW);
  _mL.makeBasis(_iAxis, _fFwdL, _fThirdL); _mW.makeBasis(_fDir, _fFwdW, _fThirdW);
  _mL.transpose(); _mW.multiply(_mL);                                                      // Q_world = worldFrame · localFrame⁻¹
  bone.parent!.getWorldQuaternion(_ipq);
  bone.quaternion.setFromRotationMatrix(_mW); bone.quaternion.premultiply(_ipq.invert());  // локальный = parent⁻¹ · Q_world
}

/** Аналитический 2-костный IK ноги: гнём бедро+колено так, чтобы кость стопы встала в targetWorld.
 *  pole — направление сгиба колена (вперёд). Стопу ВЫРАВНИВАЕМ по faceQuat (плоско + носок по фейсингу тела): иначе
 *  твист от aimBoneDown не задан и стопа висит в фикс. мировой стороне. Длины костей фиксированы, кламп разгиба. */
export function legGroundIK(upper: THREE.Object3D, lower: THREE.Object3D, foot: THREE.Object3D, targetWorld: THREE.Vector3, pole: THREE.Vector3, faceQuat: THREE.Quaternion): void {
  upper.getWorldPosition(_iH);
  _iDir.subVectors(targetWorld, _iH);
  let dist = _iDir.length(); if (dist < 1e-3) return;
  dist = clamp(dist, IK_MIN, IK_MAX); _iDir.normalize();
  const a = Math.acos(clamp((IK_THIGH * IK_THIGH + dist * dist - IK_SHIN * IK_SHIN) / (2 * IK_THIGH * dist), -1, 1));
  _iBend.crossVectors(_iDir, pole);
  if (_iBend.lengthSq() < 1e-6) _iBend.set(1, 0, 0); else _iBend.normalize();
  _iThigh.copy(_iDir).applyAxisAngle(_iBend, a);       // бедро: линия к цели, отклонённая на a → колено вперёд
  aimBoneFrame(upper, lower, _iThigh, pole); upper.updateMatrixWorld(true);   // полный фрейм: колено смотрит на pole (не крутится наружу)
  _iK.copy(_iH).addScaledVector(_iThigh, IK_THIGH);    // колено в мире
  _iShin.subVectors(targetWorld, _iK).normalize();
  aimBoneFrame(lower, foot, _iShin, pole); lower.updateMatrixWorld(true);     // голень: тот же pole → без паразитного твиста
  lower.getWorldQuaternion(_ipq);                      // выровнять СТОПУ: мир-ориентация = faceQuat (плоско, носок по телу)
  foot.quaternion.copy(_ipq).invert().multiply(faceQuat);
  foot.updateMatrixWorld(true);
}

/**
 * Заземлить стопы меша (после физики+бленда+корня): пол под каждой стопой → цель = пол + SOLE. Таз поднимаем под самую
 * «провалившуюся» ОПОРНУЮ стопу (мгновенно вниз-провал, плавно оседая), затем per-foot IK плантит каждую опорную стопу
 * ровно на её пол + кладёт её плоско. МАХОВУЮ (в переносе) НЕ трогаем — её носок ведёт поза (иначе «лыжник»: стопа
 * плющится в воздухе на спуске). Опора = `support[i]` из позы (driver.swingLegs → !swing); нет позы → эвристика по высоте.
 * baseY = физ-Y таза; gs.off — сглаж. сдвиг корня.
 */
export function groundFeet(mesh: Humanoid, baseY: number, gs: { off: number }, dt: number, gnd: GroundQuery, support?: [boolean, boolean]): void {
  const hips = mesh.bones.get('Hips'); if (!hips) return;
  const sole = SOLE + (mesh.footLift ?? 0);   // подъём цели: кость-лодыжка выше на footLift → ПОДОШВА МЕША атласа на полу (не тонет)
  hips.getWorldQuaternion(_ipq); _iPole.set(0, 0, 1).applyQuaternion(_ipq); _iPole.y = 0;   // фронт тела = pole колена
  if (_iPole.lengthSq() < 1e-6) _iPole.set(0, 0, 1); else _iPole.normalize();
  _iFace.setFromAxisAngle(_UP, Math.atan2(_iPole.x, _iPole.z));   // рыск тела (плоско): стопа лежит и носок по фейсингу
  const tgt: number[] = [], sup: boolean[] = []; let worst = -Infinity;
  for (let i = 0; i < IK_LEGS.length; i++) {
    const fb = mesh.bones.get(IK_LEGS[i]!.f); if (!fb) { tgt.push(NaN); sup.push(false); continue; }
    fb.getWorldPosition(_iFoot);
    const ty = gnd(_iFoot.x, _iFoot.z) + sole; tgt.push(ty);
    const isSup = support ? support[i]! : (_iFoot.y - ty < PLANT_MAX);   // опора из позы (маховую не заземляем); фолбэк — по высоте
    sup.push(isSup);
    if (isSup) worst = Math.max(worst, ty - _iFoot.y);
  }
  if (Number.isFinite(worst)) {
    // Сдвиг корня СГЛАЖЕН в обе стороны (мягкий боб): даже если таз догоняет медленно, per-foot IK ниже плантит опорную
    // стопу коленом → она НЕ проваливается, пока таз плавно едет. Раньше был мгновенный рывок вверх на провале — дёрганый боб.
    gs.off += (worst - 0) * Math.min(1, dt * GROUND_LAG);
    mesh.root.position.y = baseY + gs.off; mesh.root.updateMatrixWorld(true);
  }
  for (let i = 0; i < IK_LEGS.length; i++) {                        // планти+кладём ТОЛЬКО опорные стопы; маховую ведёт поза
    if (!sup[i]) continue;
    const leg = IK_LEGS[i]!, ty = tgt[i]!; if (!Number.isFinite(ty)) continue;
    const ub = mesh.bones.get(leg.u), lb = mesh.bones.get(leg.l), fb = mesh.bones.get(leg.f);
    if (!ub || !lb || !fb) continue;
    fb.getWorldPosition(_iFoot);
    legGroundIK(ub, lb, fb, _iT.set(_iFoot.x, ty, _iFoot.z), _iPole, _iFace);
  }
}
