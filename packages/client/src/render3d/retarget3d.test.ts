import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { autoBoneMap, makeRetargetRig, OUR_BONES } from './retarget3d.js';
import { buildHumanoid } from './humanoid.js';

describe('retarget3d — авто-карта костей', () => {
  it('AccuRIG / CC (CC_Base_*)', () => {
    const m = autoBoneMap(['CC_Base_Hip', 'CC_Base_Spine01', 'CC_Base_Head', 'CC_Base_L_Upperarm', 'CC_Base_R_Upperarm', 'CC_Base_L_Forearm', 'CC_Base_L_Hand', 'CC_Base_L_Thigh', 'CC_Base_L_Calf', 'CC_Base_L_Foot', 'CC_Base_L_ToeBase']);
    expect(m.Hips).toBe('CC_Base_Hip');
    expect(m.LeftUpperArm).toBe('CC_Base_L_Upperarm');
    expect(m.RightUpperArm).toBe('CC_Base_R_Upperarm');
    expect(m.LeftLowerArm).toBe('CC_Base_L_Forearm');
    expect(m.LeftUpperLeg).toBe('CC_Base_L_Thigh');
    expect(m.LeftLowerLeg).toBe('CC_Base_L_Calf');
    expect(m.LeftToes).toBe('CC_Base_L_ToeBase');
  });

  it('Mixamo (mixamorig:*)', () => {
    const m = autoBoneMap(['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:LeftArm', 'mixamorig:RightArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand', 'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot']);
    expect(m.Hips).toBe('mixamorig:Hips');
    expect(m.LeftUpperArm).toBe('mixamorig:LeftArm');
    expect(m.RightUpperArm).toBe('mixamorig:RightArm');
    expect(m.LeftLowerArm).toBe('mixamorig:LeftForeArm');
    expect(m.LeftUpperLeg).toBe('mixamorig:LeftUpLeg');
    expect(m.LeftLowerLeg).toBe('mixamorig:LeftLeg');
  });

  it('Unreal (upperarm_l / thigh_r)', () => {
    const m = autoBoneMap(['pelvis', 'spine_01', 'head', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'hand_l', 'thigh_l', 'calf_l', 'foot_l']);
    expect(m.Hips).toBe('pelvis');
    expect(m.LeftUpperArm).toBe('upperarm_l');
    expect(m.RightUpperArm).toBe('upperarm_r');
    expect(m.LeftUpperLeg).toBe('thigh_l');
  });
});

describe('retarget3d — драйв', () => {
  it('поворот нашей кости → цель поворачивается так же (rest цели = identity)', () => {
    const src = buildHumanoid();
    // цель: корень + одна кость arm_l (rest identity в мире)
    const root = new THREE.Object3D();
    const arm = new THREE.Bone(); arm.name = 'arm_l'; root.add(arm);
    root.updateMatrixWorld(true);
    const rig = makeRetargetRig(root, { LeftUpperArm: 'arm_l' } as Record<string, string>, 1);
    // повернём нашу LeftUpperArm на заметный угол
    src.bones.get('LeftUpperArm')!.rotation.set(0, 0, 0.9);
    src.root.updateMatrixWorld(true);
    rig.drive(src);
    const srcW = src.bones.get('LeftUpperArm')!.getWorldQuaternion(new THREE.Quaternion());
    const tgtW = arm.getWorldQuaternion(new THREE.Quaternion());
    expect(tgtW.angleTo(srcW)).toBeLessThan(0.01);   // цель повторила мировое вращение источника
    expect(OUR_BONES).toContain('LeftUpperArm');
  });
});
