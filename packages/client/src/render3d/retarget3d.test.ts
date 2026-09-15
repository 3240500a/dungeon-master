import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { autoBoneMap, mergeBoneMap, makeRetargetRig, measureBoneOffsets, FINGER_PARENT, OUR_BONES } from './retarget3d.js';
import { buildHumanoid } from './humanoid.js';

/**
 * ⚠ СОХРАНЁННАЯ КАРТА МОГЛА БЫ ОТМЕНИТЬ ПОЧИНКУ. Старая эвристика не только ошибалась — редактор её
 * результат СОХРАНЯЛ: в конфиге модели `knight_06_modular_rig` лежало `LeftToes: CC_Base_L_ToeBaseShareBone`.
 * Правка одной эвристики до модели бы не доехала, поэтому у свода своё правило: ЛИСТ НЕ ПОДМЕНЯЕТ
 * КОСТЬ-С-ДЕТЬМИ. Ручной выбор в остальном по-прежнему выигрывает — за тем он и сохраняется.
 */
describe('retarget3d — свод авто-карты с сохранённой', () => {
  /** Скелет: Foot → (ToeBase → Big) + ToeBaseShareBone(лист). */
  const tree = (): THREE.Object3D => {
    const bone = (n: string): THREE.Bone => { const b = new THREE.Bone(); b.name = n; return b; };
    const root = bone('CC_Base_Hip'), foot = bone('CC_Base_L_Foot');
    const toe = bone('CC_Base_L_ToeBase'), share = bone('CC_Base_L_ToeBaseShareBone');
    toe.add(bone('CC_Base_L_BigToe1')); foot.add(share, toe); root.add(foot);
    return root;
  };

  it('⭐ лист-вспомогалка из СТАРОГО стора не подменяет настоящую кость', () => {
    const out = mergeBoneMap({ LeftToes: 'CC_Base_L_ToeBase' }, { LeftToes: 'CC_Base_L_ToeBaseShareBone' }, tree());
    expect(out.LeftToes, '⚠ сохранённая кость-пустышка снова победила — починка карты до модели не доедет').toBe('CC_Base_L_ToeBase');
  });

  it('обычный ручной override выигрывает (в этом весь смысл стора)', () => {
    const out = mergeBoneMap({ LeftFoot: 'CC_Base_L_ToeBase' }, { LeftFoot: 'CC_Base_L_Foot' }, tree());
    expect(out.LeftFoot).toBe('CC_Base_L_Foot');
  });

  it('имени из стора в ЭТОМ скелете нет — игнорируем (экспорт суффиксит имена)', () => {
    const out = mergeBoneMap({ LeftToes: 'CC_Base_L_ToeBase' }, { LeftToes: 'CC_Base_L_ToeBase_4' }, tree());
    expect(out.LeftToes).toBe('CC_Base_L_ToeBase');
  });

  it('авто-кость сама лист — стору верим (терять нечего)', () => {
    const out = mergeBoneMap({ LeftToes: 'CC_Base_L_ToeBaseShareBone' }, { LeftToes: 'CC_Base_L_BigToe1' }, tree());
    expect(out.LeftToes).toBe('CC_Base_L_BigToe1');
  });
});

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

  it('⭐⭐ вспомогалка скина `*ShareBone` НЕ ЗАБИРАЕТ слот настоящей кости', () => {
    // ⚠ ЖИВОЙ СЛУЧАЙ, а не выдумка: у CC рядом с настоящей костью лежит лист-вспомогалка скина, и порядок
    // в файле РАЗНЫЙ по сторонам — слева `ShareBone` идёт РАНЬШЕ `ToeBase`, справа позже. Старое правило
    // «побеждает первый подходящий» отдавало `LeftToes` пустышке без детей, и ЗАМЕР это подтвердил:
    // поворот кости носка на +0.8 рад двигал носок модели справа и не двигал слева ВООБЩЕ (0.0000).
    // Видно стало только когда у носка появился свой канал (`GAIT.toeOff`) — до того кость стояла в нуле.
    const m = autoBoneMap(['CC_Base_Hip', 'CC_Base_L_Thigh', 'CC_Base_L_ThighTwist01', 'CC_Base_L_Calf', 'CC_Base_L_Foot',
      'CC_Base_L_ToeBaseShareBone', 'CC_Base_L_ToeBase',
      'CC_Base_R_Thigh', 'CC_Base_R_Calf', 'CC_Base_R_Foot', 'CC_Base_R_ToeBase', 'CC_Base_R_ToeBaseShareBone']);
    expect(m.LeftToes, '⚠ левый носок снова ведёт вспомогалку скина — правило «первый подходящий» вернулось').toBe('CC_Base_L_ToeBase');
    expect(m.RightToes).toBe('CC_Base_R_ToeBase');
    expect(m.LeftUpperLeg, '⚠ твист-кость забрала слот бедра').toBe('CC_Base_L_Thigh');
  });

  it('карта есть только у вспомогалки — берём её, возможности не теряем', () => {
    const m = autoBoneMap(['CC_Base_L_Foot', 'CC_Base_L_ToeBaseShareBone']);
    expect(m.LeftToes).toBe('CC_Base_L_ToeBaseShareBone');
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
    expect(m.Spine).toBe('spine_01');   // spine_01 = первая (не 1/2/3-конвенция)
  });

  it('Explosive (B_* префикс, Spine/Spine1/Spine2)', () => {
    const m = autoBoneMap(['Motion', 'B_Pelvis', 'B_Spine', 'B_Spine1', 'B_Spine2', 'B_Neck', 'B_Head',
      'B_L_Clavicle', 'B_L_UpperArm', 'B_L_Forearm', 'B_L_Hand', 'B_R_Clavicle', 'B_R_UpperArm', 'B_R_Forearm', 'B_R_Hand',
      'B_L_Thigh', 'B_L_Calf', 'B_L_Foot', 'B_L_Toe0', 'B_R_Thigh', 'B_R_Calf', 'B_R_Foot']);
    expect(m.Hips).toBe('B_Pelvis');
    expect(m.Spine).toBe('B_Spine'); expect(m.Chest).toBe('B_Spine1'); expect(m.UpperChest).toBe('B_Spine2');   // Spine/1/2 → Spine/Chest/UpperChest
    expect(m.Neck).toBe('B_Neck'); expect(m.Head).toBe('B_Head');
    expect(m.LeftShoulder).toBe('B_L_Clavicle'); expect(m.LeftUpperArm).toBe('B_L_UpperArm');
    expect(m.LeftLowerArm).toBe('B_L_Forearm'); expect(m.LeftHand).toBe('B_L_Hand');
    expect(m.RightUpperArm).toBe('B_R_UpperArm');
    expect(m.LeftUpperLeg).toBe('B_L_Thigh'); expect(m.LeftLowerLeg).toBe('B_L_Calf');
    expect(m.LeftFoot).toBe('B_L_Foot'); expect(m.LeftToes).toBe('B_L_Toe0');
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

describe('retarget3d — офсеты ПАЛЬЦЕВ снимаются с модели (Ф14.2)', () => {
  /** Скелетик: таз/голова/стопа задают масштаб, кисть и один палец — то, что проверяем. */
  const mkRig = (): THREE.Object3D => {
    const root = new THREE.Object3D();
    const mk = (name: string, parent: THREE.Object3D, p: [number, number, number]): THREE.Bone => {
      const b = new THREE.Bone(); b.name = name; b.position.set(...p); parent.add(b); return b;
    };
    const hips = mk('Hips', root, [0, 32, 0]);
    const spine = mk('Spine', hips, [0, 5, 0]);
    const chest = mk('Chest', spine, [0, 6, 0]);
    const upper = mk('UpperChest', chest, [0, 5, 0]);
    const neck = mk('Neck', upper, [0, 5, 0]);
    mk('Head', neck, [0, 4, 0]);
    const thigh = mk('LeftUpperLeg', hips, [4, -2, 0]);
    const shin = mk('LeftLowerLeg', thigh, [0, -15, 0]);
    mk('LeftFoot', shin, [0, -14, 0]);
    const clav = mk('LeftShoulder', upper, [3, 3, 0]);
    const arm = mk('LeftUpperArm', clav, [4, 0, 0]);
    const fore = mk('LeftLowerArm', arm, [13, 0, 0]);
    const hand = mk('LeftHand', fore, [11, 0, 0]);
    const prox = mk('LeftIndexProximal', hand, [3, 0, 1]);          // палец «в сторону и вперёд»
    const inter = mk('LeftIndexIntermediate', prox, [2, 0, 0]);
    mk('LeftIndexDistal', inter, [1.5, 0, 0]);
    root.updateMatrixWorld(true);
    return root;
  };
  const MAP: Record<string, string> = {
    Hips: 'Hips', Spine: 'Spine', Chest: 'Chest', UpperChest: 'UpperChest', Neck: 'Neck', Head: 'Head',
    LeftUpperLeg: 'LeftUpperLeg', LeftLowerLeg: 'LeftLowerLeg', LeftFoot: 'LeftFoot',
    LeftShoulder: 'LeftShoulder', LeftUpperArm: 'LeftUpperArm', LeftLowerArm: 'LeftLowerArm', LeftHand: 'LeftHand',
    LeftIndexProximal: 'LeftIndexProximal', LeftIndexIntermediate: 'LeftIndexIntermediate', LeftIndexDistal: 'LeftIndexDistal',
  };

  it('ГЛАВНОЕ: фаланги получают офсеты — раньше их не было вообще и рисовалась хардкод-кисть', () => {
    const off = measureBoneOffsets(mkRig(), MAP);
    for (const nm of ['LeftIndexProximal', 'LeftIndexIntermediate', 'LeftIndexDistal']) expect(off[nm], nm).toBeDefined();
  });

  it('офсет = мировая дельта «родитель → кость», нормированная к нашему росту', () => {
    const off = measureBoneOffsets(mkRig(), MAP);
    // Сверяем ПРОПОРЦИИ, а не абсолют: офсеты нормируются к нашему росту и округляются до 2 знаков,
    // поэтому осмысленно проверять именно соотношение звеньев модели (3 : 2 : 1.5 и Z:X = 1:3).
    const prox = off['LeftIndexProximal']!, inter = off['LeftIndexIntermediate']!, dist = off['LeftIndexDistal']!;
    expect(prox[0] / inter[0]).toBeCloseTo(3 / 2, 2);
    expect(dist[0] / inter[0]).toBeCloseTo(1.5 / 2, 2);
    expect(prox[2] / prox[0]).toBeCloseTo(1 / 3, 2);                 // Z не теряется — палец идёт и вперёд
    expect(inter[2]).toBeCloseTo(0, 6);
  });

  it('родитель фаланги известен и цепь замкнута на кисть', () => {
    expect(FINGER_PARENT['LeftIndexProximal']).toBe('LeftHand');
    expect(FINGER_PARENT['LeftIndexIntermediate']).toBe('LeftIndexProximal');
    expect(FINGER_PARENT['RightLittleDistal']).toBe('RightLittleIntermediate');
    expect(Object.keys(FINGER_PARENT).length).toBe(30);
  });

  it('телесные замеры не изменились от расширения цикла', () => {
    const off = measureBoneOffsets(mkRig(), MAP);
    expect(off['Hips']).toBeDefined();
    expect(off['LeftHand']).toBeDefined();
  });
});

describe('retarget3d — замер не искажает геометрию модели (Ф15.2)', () => {
  /** Скелет с ЗАВАЛЕННОЙ ВПЕРЁД шеей (как бинд CC) и БЕЗ UpperChest — ровно случай knight_05. */
  const mkRig = (): THREE.Object3D => {
    const root = new THREE.Object3D();
    const mk = (name: string, parent: THREE.Object3D, p: [number, number, number]): THREE.Bone => {
      const b = new THREE.Bone(); b.name = name; b.position.set(...p); parent.add(b); return b;
    };
    const hips = mk('Hips', root, [0, 32, 0]);
    const spine = mk('Spine', hips, [0, 5, 0]);
    const chest = mk('Chest', spine, [0, 6, 0]);
    // UpperChest в скелете НЕТ — шея и ключицы висят прямо на груди (два спайна, как у CC)
    const neck = mk('Neck', chest, [0, 10, 4]);          // ← ненулевой Z: голова завалена вперёд
    mk('Head', neck, [0, 4, 1.5]);
    mk('LeftShoulder', chest, [3, 8, 0]);
    const thigh = mk('LeftUpperLeg', hips, [4, -2, 0]);
    const shin = mk('LeftLowerLeg', thigh, [0, -15, 0]);
    mk('LeftFoot', shin, [0, -14, 0]);
    root.updateMatrixWorld(true);
    return root;
  };
  const MAP: Record<string, string> = {
    Hips: 'Hips', Spine: 'Spine', Chest: 'Chest', Neck: 'Neck', Head: 'Head',
    LeftShoulder: 'LeftShoulder', LeftUpperLeg: 'LeftUpperLeg', LeftLowerLeg: 'LeftLowerLeg', LeftFoot: 'LeftFoot',
  };   // UpperChest НЕ смаплен — его в модели нет

  it('ГЛАВНОЕ: несмапленная кость больше не убивает офсеты СВОИХ ДЕТЕЙ', () => {
    const off = measureBoneOffsets(mkRig(), MAP);
    for (const nm of ['UpperChest', 'Neck', 'LeftShoulder']) expect(off[nm], nm).toBeDefined();
  });

  it('цепь телескопируется: Chest→UpperChest→Neck складывается в реальный Chest→Neck модели', () => {
    const off = measureBoneOffsets(mkRig(), MAP);
    const sum = [0, 1, 2].map((i) => off['UpperChest']![i]! + off['Neck']![i]!);
    const k = sum[1]! / 10;                                        // масштаб нормировки (модельный Y = 10)
    expect(sum[0]!).toBeCloseTo(0, 2);
    expect(sum[2]! / k).toBeCloseTo(4, 1);                         // Z дошёл целиком
  });

  it('несмапленное звено встаёт ПО ДОЛЕ базового рига, а не в хардкод-точку', () => {
    const off = measureBoneOffsets(mkRig(), MAP);
    // В базе Chest→UpperChest = 5 и UpperChest→Neck = 5, значит ровно половина отрезка.
    const uc = off['UpperChest']!, nk = off['Neck']!;
    for (let i = 0; i < 3; i++) expect(uc[i]!).toBeCloseTo(nk[i]!, 1);
  });

  it('ГЛАВНОЕ: forward-Z осевой цепи больше не режется — длина сегмента сохраняется', () => {
    const off = measureBoneOffsets(mkRig(), MAP);
    const h = buildHumanoid({ boneOffsets: off });
    const neck = h.bones.get('Neck')!.getWorldPosition(new THREE.Vector3());
    const head = h.bones.get('Head')!.getWorldPosition(new THREE.Vector3());
    const segLen = neck.distanceTo(head);
    const modelLen = Math.hypot(0, 4, 1.5);                        // 4.27 в единицах модели
    const k = segLen / modelLen;
    expect(k).toBeGreaterThan(0.5);                                // нормировка, но НЕ обрезка
    expect(head.z - neck.z).toBeGreaterThan(0.5);                  // Z дожил до скелета (раньше был 0)
  });

  it('высота лодыжки собранного рига совпадает с базовой (заземление не подпрыгивает)', () => {
    const off = measureBoneOffsets(mkRig(), MAP);
    const h = buildHumanoid({ boneOffsets: off });
    const base = buildHumanoid({});
    const ankle = h.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()).y;
    const baseAnkle = base.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()).y;
    expect(ankle).toBeCloseTo(baseAnkle, 1);
  });
});
