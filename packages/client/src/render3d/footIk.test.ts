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
});
