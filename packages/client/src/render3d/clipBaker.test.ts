import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeRetargetRig, makeBakeRig } from './retarget3d.js';
import { buildHumanoid } from './humanoid.js';
import { reduceKeyframes, poseReconstructError } from './clipBaker.js';
import type { Keyframe } from './poseRuntime.js';

/** Минимальный импорт-скелет (Bone-иерархия) для round-trip: цепочка торс+левая рука с нашими оффсетами. */
function boneChain(): { root: THREE.Object3D; map: Record<string, string> } {
  const mk = (name: string, pos: [number, number, number], parent: THREE.Object3D): THREE.Bone => {
    const b = new THREE.Bone(); b.name = name; b.position.set(pos[0], pos[1], pos[2]); parent.add(b); return b;
  };
  const root = new THREE.Object3D();
  const hips = mk('t_Hips', [0, 32, 0], root);
  const spine = mk('t_Spine', [0, 6, 0], hips);
  const chest = mk('t_Chest', [0, 6, 0], spine);
  const uc = mk('t_UpperChest', [0, 5, 0], chest);
  const sh = mk('t_LShoulder', [3, 3, 0], uc);
  const ua = mk('t_LUpperArm', [4, 0, 0], sh);
  mk('t_LLowerArm', [13, 0, 0], ua);
  root.updateMatrixWorld(true);
  const map: Record<string, string> = {
    Hips: 't_Hips', Spine: 't_Spine', Chest: 't_Chest', UpperChest: 't_UpperChest',
    LeftShoulder: 't_LShoulder', LeftUpperArm: 't_LUpperArm', LeftLowerArm: 't_LLowerArm',
  };
  return { root, map };
}

describe('clipBaker — обратный ретаргет (makeBakeRig)', () => {
  it('round-trip: forward drive → inverse bake восстанавливает позу', () => {
    const { root, map } = boneChain();
    const bake = makeBakeRig(root, map);          // restW снят на bind (до drive)
    const rig = makeRetargetRig(root, map, 1);    // тот же bind
    const src = buildHumanoid();
    const P: Record<string, [number, number, number]> = {
      Spine: [0.1, 0, 0.05], Chest: [0, 0.2, 0], UpperChest: [0.05, 0, 0],
      LeftUpperArm: [0, 0, 0.9], LeftLowerArm: [0, 0.6, 0],
    };
    for (const k of Object.keys(P)) { const p = P[k]!; src.bones.get(k)!.rotation.set(p[0], p[1], p[2]); }
    src.root.updateMatrixWorld(true);
    rig.drive(src);                               // наша поза → импорт-скелет
    const dst = buildHumanoid();
    bake.sampleInto(dst);                         // импорт-скелет → наши кости (инверсия)
    const out = dst.readPose();
    for (const k of Object.keys(P)) {
      const p = P[k]!, o = out[k]!;
      const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(p[0], p[1], p[2]));
      const q2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(o[0], o[1], o[2]));
      expect(q1.angleTo(q2)).toBeLessThan(0.02);  // поза вернулась (сравнение кватернионами)
    }
  });
});

describe('clipBaker — прореживание (reduceKeyframes)', () => {
  const eul = (z: number): [number, number, number] => { const e = new THREE.Euler(0, 0, z); return [e.x, e.y, e.z]; };

  it('чистая slerp-дуга сворачивается к двум концам; eps=0 не режет', () => {
    const qa = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0));
    const qb = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 1.2));
    const dense: Keyframe[] = [];
    for (let i = 0; i <= 30; i++) {
      const u = i / 30; const q = qa.clone().slerp(qb, u); const e = new THREE.Euler().setFromQuaternion(q);
      dense.push({ t: u, pose: { LeftUpperArm: [e.x, e.y, e.z] } });
    }
    expect(reduceKeyframes(dense, 2).length).toBe(2);        // slerp по построению → нулевая ошибка → только концы
    expect(reduceKeyframes(dense, 0).length).toBe(31);       // все кадры
  });

  it('излом траектории добавляет ключ в вершине', () => {
    const dense: Keyframe[] = [];
    for (let i = 0; i <= 20; i++) { const t = i / 20; const z = i <= 10 ? (i / 10) * 1.0 : 1.0 - ((i - 10) / 10) * 1.0; dense.push({ t, pose: { LeftUpperArm: eul(z) } }); }
    const red = reduceKeyframes(dense, 5);
    expect(red.length).toBeGreaterThanOrEqual(3);            // треугольная траектория → ≥3 ключа
    expect(red.length).toBeLessThan(21);
  });

  it('poseReconstructError: середина линейной дуги ≈ 0', () => {
    const a: Keyframe = { t: 0, pose: { X: [0, 0, 0] } };
    const b: Keyframe = { t: 1, pose: { X: eul(1.0) } };
    const qMid = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0)).slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 1.0)), 0.5);
    const em = new THREE.Euler().setFromQuaternion(qMid);
    const c: Keyframe = { t: 0.5, pose: { X: [em.x, em.y, em.z] } };
    expect(poseReconstructError(a, b, c)).toBeLessThan(0.5);  // ° — почти совпадает со slerp-реконструкцией
  });
});
