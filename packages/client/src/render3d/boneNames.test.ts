import { describe, it, expect } from 'vitest';
import { parseBoneName, sideOfName, mapFingerBones, allFingerBones, fingerBoneName, FINGER_CHAINS } from './boneNames.js';

/** Наборы пальцевых имён семи популярных ригов (см. шапку boneNames.ts). */
const RIGS: Record<string, string[]> = {
  'CC / AccuRIG': ['CC_Base_L_Thumb1', 'CC_Base_L_Thumb2', 'CC_Base_L_Thumb3', 'CC_Base_L_Index1', 'CC_Base_L_Index2', 'CC_Base_L_Index3',
    'CC_Base_L_Mid1', 'CC_Base_L_Mid2', 'CC_Base_L_Mid3', 'CC_Base_L_Ring1', 'CC_Base_L_Ring2', 'CC_Base_L_Ring3',
    'CC_Base_L_Pinky1', 'CC_Base_L_Pinky2', 'CC_Base_L_Pinky3'],
  'Mixamo': ['mixamorig:LeftHandThumb1', 'mixamorig:LeftHandThumb2', 'mixamorig:LeftHandThumb3', 'mixamorig:LeftHandThumb4',
    'mixamorig:LeftHandIndex1', 'mixamorig:LeftHandIndex2', 'mixamorig:LeftHandIndex3', 'mixamorig:LeftHandIndex4',
    'mixamorig:LeftHandMiddle1', 'mixamorig:LeftHandMiddle2', 'mixamorig:LeftHandMiddle3', 'mixamorig:LeftHandMiddle4',
    'mixamorig:LeftHandRing1', 'mixamorig:LeftHandRing2', 'mixamorig:LeftHandRing3', 'mixamorig:LeftHandRing4',
    'mixamorig:LeftHandPinky1', 'mixamorig:LeftHandPinky2', 'mixamorig:LeftHandPinky3', 'mixamorig:LeftHandPinky4'],
  'UE5 Mannequin': ['thumb_01_l', 'thumb_02_l', 'thumb_03_l', 'index_01_l', 'index_02_l', 'index_03_l',
    'middle_01_l', 'middle_02_l', 'middle_03_l', 'ring_01_l', 'ring_02_l', 'ring_03_l', 'pinky_01_l', 'pinky_02_l', 'pinky_03_l'],
  'Unity Humanoid': ['LeftThumbProximal', 'LeftThumbIntermediate', 'LeftThumbDistal', 'LeftIndexProximal', 'LeftIndexIntermediate', 'LeftIndexDistal',
    'LeftMiddleProximal', 'LeftMiddleIntermediate', 'LeftMiddleDistal', 'LeftRingProximal', 'LeftRingIntermediate', 'LeftRingDistal',
    'LeftLittleProximal', 'LeftLittleIntermediate', 'LeftLittleDistal'],
  'VRM 1.0': ['leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal', 'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
    'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal', 'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
    'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal'],
  'Blender Rigify': ['thumb.01.L', 'thumb.02.L', 'thumb.03.L', 'f_index.01.L', 'f_index.02.L', 'f_index.03.L',
    'f_middle.01.L', 'f_middle.02.L', 'f_middle.03.L', 'f_ring.01.L', 'f_ring.02.L', 'f_ring.03.L',
    'f_pinky.01.L', 'f_pinky.02.L', 'f_pinky.03.L'],
  'Daz G8/G9': ['lThumb1', 'lThumb2', 'lThumb3', 'lIndex1', 'lIndex2', 'lIndex3', 'lMid1', 'lMid2', 'lMid3',
    'lRing1', 'lRing2', 'lRing3', 'lPinky1', 'lPinky2', 'lPinky3'],
};

describe('boneNames — сторона', () => {
  it('слово left/right, одиночный сегмент l/r, приставка Daz', () => {
    expect(sideOfName('CC_Base_L_Thumb1')).toBe('l');
    expect(sideOfName('CC_Base_R_Thumb1')).toBe('r');
    expect(sideOfName('thumb_01_l')).toBe('l');
    expect(sideOfName('mixamorig:LeftHandIndex1')).toBe('l');
    expect(sideOfName('f_pinky.01.R')).toBe('r');
    expect(sideOfName('lThumb1')).toBe('l');
    expect(sideOfName('rIndex2')).toBe('r');
    expect(sideOfName('Spine')).toBe('');
  });
});

describe('boneNames — разбор пальцев по семи ригам', () => {
  for (const [rig, names] of Object.entries(RIGS)) {
    it(`${rig}: все 5 цепей × 3 сегмента смаплены`, () => {
      const m = mapFingerBones(names);
      for (const ch of FINGER_CHAINS) for (let i = 0; i < 3; i++) {
        const canon = fingerBoneName('l', ch, i as 0 | 1 | 2);
        expect(m[canon], `${rig} → ${canon}`).toBeDefined();
      }
      expect(Object.keys(m).length).toBe(15);   // одна сторона × 5 цепей × 3
    });
  }

  it('Mixamo: четвёртый сегмент (кончик) ОТБРОШЕН, а не взят за Distal', () => {
    const m = mapFingerBones(RIGS['Mixamo']!);
    expect(m['LeftIndexProximal']).toBe('mixamorig:LeftHandIndex1');
    expect(m['LeftIndexIntermediate']).toBe('mixamorig:LeftHandIndex2');
    expect(m['LeftIndexDistal']).toBe('mixamorig:LeftHandIndex3');
    expect(Object.values(m)).not.toContain('mixamorig:LeftHandIndex4');
  });

  it('VRM 1.0: большой палец с Metacarpal не съезжает (первые три по порядку)', () => {
    const m = mapFingerBones(RIGS['VRM 1.0']!);
    expect(m['LeftThumbProximal']).toBe('leftThumbMetacarpal');
    expect(m['LeftThumbIntermediate']).toBe('leftThumbProximal');
    expect(m['LeftThumbDistal']).toBe('leftThumbDistal');
  });

  it('синонимы цепи: mid→Middle, pinky→Little', () => {
    expect(parseBoneName('CC_Base_L_Mid2').chain).toBe('Middle');
    expect(parseBoneName('CC_Base_L_Pinky2').chain).toBe('Little');
    expect(parseBoneName('LeftLittleDistal').chain).toBe('Little');
    expect(parseBoneName('f_middle.01.L').chain).toBe('Middle');
  });

  it('обе стороны разбираются независимо', () => {
    const both = [...RIGS['CC / AccuRIG']!, ...RIGS['CC / AccuRIG']!.map((n) => n.replace('_L_', '_R_'))];
    const m = mapFingerBones(both);
    expect(Object.keys(m).length).toBe(30);
    expect(m['RightThumbProximal']).toBe('CC_Base_R_Thumb1');
  });

  it('не-пальцы не попадают в карту пальцев', () => {
    const m = mapFingerBones(['CC_Base_Hip', 'CC_Base_L_Hand', 'CC_Base_L_Upperarm', 'spine_01', 'head']);
    expect(Object.keys(m).length).toBe(0);
  });
});

describe('boneNames — твисты', () => {
  it('индекс твиста разбирается, и твист не считается пальцем', () => {
    expect(parseBoneName('CC_Base_L_UpperarmTwist01').twist).toBe(1);
    expect(parseBoneName('CC_Base_L_ForearmTwist02').twist).toBe(2);
    expect(parseBoneName('upperarm_twist_01_l').twist).toBe(1);
    expect(parseBoneName('CC_Base_L_Thumb1').twist).toBe(null);
  });

  it('твист-кость в цепи пальца (гипотетическая) не ломает карту пальцев', () => {
    const m = mapFingerBones([...RIGS['CC / AccuRIG']!, 'CC_Base_L_IndexTwist01']);
    expect(m['LeftIndexProximal']).toBe('CC_Base_L_Index1');
    expect(m['LeftIndexDistal']).toBe('CC_Base_L_Index3');
  });
});

describe('boneNames — канон', () => {
  it('30 пальцевых костей, имена Unity Humanoid', () => {
    const all = allFingerBones();
    expect(all.length).toBe(30);
    expect(all).toContain('LeftThumbProximal');
    expect(all).toContain('RightLittleDistal');
    expect(all).toContain('LeftMiddleIntermediate');
    expect(new Set(all).size).toBe(30);
  });
});

describe('boneNames — ложные срабатывания синонимов (регресс)', () => {
  it('Forearm/Foarm НЕ считается указательным пальцем', () => {
    // 'fore' как синоним index съедал предплечье: LeftLowerArm пропадал из карты на CC/Mixamo/Explosive.
    for (const n of ['CC_Base_L_Forearm', 'mixamorig:LeftForeArm', 'B_L_Forearm', 'lowerarm_l', 'L_Foarm']) {
      expect(parseBoneName(n).chain, n).toBe(null);
    }
  });

  it('обычные кости торса/ног не ловятся цепями пальцев', () => {
    for (const n of ['CC_Base_Hip', 'spine_01', 'CC_Base_L_Thigh', 'CC_Base_L_Calf', 'foot_l', 'CC_Base_Head',
      'CC_Base_L_Clavicle', 'CC_Base_L_Upperarm', 'CC_Base_L_Hand', 'CC_Base_L_ToeBase']) {
      expect(parseBoneName(n).chain, n).toBe(null);
    }
  });
});
