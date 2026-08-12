import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { legGroundIK, groundFeet } from './footIk.js';

// FOOT-IK заземлитель: аналитический 2-костный IK должен ставить кость стопы РОВНО в целевую точку (в пределах длины ноги).
describe('legGroundIK — заземляющий IK ставит стопу в цель', () => {
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  it('стопа достигает целевой точки под бедром', () => {
    const h = buildHumanoid({ gender: 'male', build: {} });
    h.root.position.set(0, 30, 0); h.root.updateMatrixWorld(true);
    const upper = h.bones.get('LeftUpperLeg')!, lower = h.bones.get('LeftLowerLeg')!, foot = h.bones.get('LeftFoot')!;
    const hip = upper.getWorldPosition(V(0, 0, 0));
    const target = V(hip.x, hip.y - 25, hip.z + 2);                 // 25 вниз + 2 вперёд (в пределах разгиба 29)
    legGroundIK(upper, lower, foot, target, V(0, 0, 1), new THREE.Quaternion());
    h.root.updateMatrixWorld(true);
    expect(foot.getWorldPosition(V(0, 0, 0)).distanceTo(target)).toBeLessThan(1.5);
  });

  it('стопа ниже пола → IK поднимает её на пол (не тонет)', () => {
    const h = buildHumanoid({ gender: 'male', build: {} });
    h.root.position.set(0, 20, 0); h.root.updateMatrixWorld(true);   // таз низко → прямая нога, стопа уходит ниже 0
    const upper = h.bones.get('LeftUpperLeg')!, lower = h.bones.get('LeftLowerLeg')!, foot = h.bones.get('LeftFoot')!;
    const fw0 = foot.getWorldPosition(V(0, 0, 0));
    expect(fw0.y).toBeLessThan(1.5);                                 // до IK — стопа под полом
    legGroundIK(upper, lower, foot, V(fw0.x, 1.5, fw0.z), V(0, 0, 1), new THREE.Quaternion());   // цель — на пол в той же XZ
    h.root.updateMatrixWorld(true);
    const fw1 = foot.getWorldPosition(V(0, 0, 0));
    expect(Math.abs(fw1.y - 1.5)).toBeLessThan(1.0);                // стопа поднялась к полу
    expect(Math.hypot(fw1.x - fw0.x, fw1.z - fw0.z)).toBeLessThan(2); // XZ почти не съехала
  });

  it('groundFeet: обе стопы не ниже пола (таз поднимается + IK плантит на пол)', () => {
    const h = buildHumanoid({ gender: 'male', build: {} });
    const baseY = 20; h.root.position.set(0, baseY, 0); h.root.updateMatrixWorld(true);   // таз низко → стопы под полом
    const footY = (n: string): number => h.bones.get(n)!.getWorldPosition(V(0, 0, 0)).y;
    expect(Math.min(footY('LeftFoot'), footY('RightFoot'))).toBeLessThan(0);              // до: тонут
    groundFeet(h, baseY, { off: 0 }, 1 / 60, () => 0);                                    // плоский пол y=0
    const minAfter = Math.min(footY('LeftFoot'), footY('RightFoot'));
    expect(minAfter).toBeGreaterThan(-0.1);   // НЕ ниже пола (не тонут)
    expect(minAfter).toBeLessThan(2.5);        // сели на пол (~SOLE=1.5), не улетели
  });

  it('legGroundIK: боковой дотяг НЕ разворачивает колено наружу (перёд голени = pole)', () => {
    const h = buildHumanoid({ gender: 'male', build: {} });
    h.root.position.set(0, 30, 0); h.root.updateMatrixWorld(true);
    const upper = h.bones.get('LeftUpperLeg')!, lower = h.bones.get('LeftLowerLeg')!, foot = h.bones.get('LeftFoot')!;
    const hip = upper.getWorldPosition(V(0, 0, 0));
    legGroundIK(upper, lower, foot, V(hip.x + 8, 2, hip.z), V(0, 0, 1), new THREE.Quaternion());   // цель ВБОК+вниз, pole=вперёд
    h.root.updateMatrixWorld(true);
    const fwd = V(0, 0, 1).applyQuaternion(lower.getWorldQuaternion(new THREE.Quaternion()));       // «перёд» голени (лок +Z в мире)
    expect(fwd.z).toBeGreaterThan(0.6);        // смотрит ВПЕРЁД (по pole), а не завёрнут вбок
    expect(Math.abs(fwd.x)).toBeLessThan(0.5);
  });

  it('groundFeet: footLift поднимает цель заземления (подошва меша атласа на полу, а не тонет)', () => {
    const mk = (): ReturnType<typeof buildHumanoid> => { const h = buildHumanoid({ gender: 'male', build: {} }); h.root.position.set(0, 20, 0); h.root.updateMatrixWorld(true); return h; };
    const footMinY = (h: ReturnType<typeof buildHumanoid>): number => Math.min(h.bones.get('LeftFoot')!.getWorldPosition(V(0, 0, 0)).y, h.bones.get('RightFoot')!.getWorldPosition(V(0, 0, 0)).y);
    const h0 = mk(); groundFeet(h0, 20, { off: 0 }, 1 / 60, () => 0); const y0 = footMinY(h0);
    const h1 = mk(); h1.footLift = 3; groundFeet(h1, 20, { off: 0 }, 1 / 60, () => 0); const y1 = footMinY(h1);
    expect(y1 - y0).toBeGreaterThan(2);   // footLift=3 → кость стопы ~на 3 выше (лодыжка атласа выше → подошва меша на полу)
  });

  it('groundFeet: МАХОВУЮ (support=false) не выравнивает — её ориентацию ведёт поза (нет «лыжника»)', () => {
    const h = buildHumanoid({ gender: 'male', build: {} });
    h.root.position.set(0, 20, 0);
    const rf = h.bones.get('RightFoot')!;
    rf.rotation.set(-0.8, 0, 0);                                  // задрать носок (как в переносе маховой)
    h.root.updateMatrixWorld(true);
    const before = rf.quaternion.clone();
    groundFeet(h, 20, { off: 0 }, 1 / 60, () => 0, [true, false]); // левая ОПОРА, правая МАХ
    expect(rf.quaternion.angleTo(before)).toBeLessThan(0.02);     // маховая стопа НЕ тронута (носок остался задран)
    const lf = h.bones.get('LeftFoot')!.getWorldPosition(V(0, 0, 0));
    expect(Math.abs(lf.y - 1.5)).toBeLessThan(1.0);              // опорная — заземлена на пол
  });
});
