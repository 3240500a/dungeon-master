/**
 * ПРОДЮСЕР golden-эталона КАРТЫ КОСТЕЙ и АТЛАСА ПЕРСОНАЖА для Unity-клиента (шаг R). На каждом `npm test` перегенерирует
 * `__golden__/unity_rig.json` из ТЕКУЩЕГО кода веба. Unity больше не зашивает имена `CC_Base_*`: карту «наша кость → кость
 * модели» строит по правилам веба, и эталон фиксирует, как их применил веб (`Assets/DM/PoseEditor/Tests/RigMapCheck.cs`,
 * меню DM ▸ Verify Rig Map):
 *  • `autoMap` — `retarget3d.autoBoneMap` (с пальцами `boneNames.mapFingerBones`) на списках имён: боевой рыцарь в порядке
 *    обхода + синтетика конвенций (Mixamo, UE5, Unity Humanoid, Bip01, Explosive, Rigify, Daz, VRM, CC с `*ShareBone`);
 *  • `trees` — иерархии (имя, кость ли, меш ли, родитель): `boneIndex` (кость-с-детьми, самый внешний дубль), `mergeBoneMap`
 *    (лист не подменяет кость-с-детьми) и полный разбор `mergeBoneMap(autoBoneMap(skeletonBoneNames(g)), stored, g)` —
 *    ровно то, что делает `modelSkin.resolveBoneMap`; первым — боевой рыцарь (как его разобрал `parseModel`);
 *  • `upAxis` — `retarget3d.upAxisAngle` (доворот к Y-up по тазу→голове, без костей-ориентиров — по габариту костей/мешей);
 *  • `models` — `modelSkin.resolveCharacterModel` (игрок: свой classId → без класса → первый; монстр — только свой);
 *  • `classify` — `modelSkin.classifySubmesh` (слот детали = префикс имени);
 *  • `atlas` — НАСТОЯЩИЙ `createModelSkin().setAtlas` на НАСТОЯЩЕМ GLB рыцаря: какие детали видны при данном выборе по
 *    слотам (точные имена, старые имена без префикса, незнакомый id, пустой слот, без ключа, hideHair, слоты из классификатора),
 *    плюс разрешённая карта костей, доворот к Y-up и масштаб под куклу-источник (`scaleToSource`);
 *  • `atlasSynthetic` — тот же `setAtlas` на синтетическом атласе: деталь без слота скрыта, слот из конфига у детали без
 *    префикса, перепутанный слот, волосы без префикса под hideHair;
 *  • `span` — пролёт таз→голова куклы-источника (`buildHumanoid` с офсетами/масштабами/профилем модели) — им Unity
 *    масштабирует модель, как веб;
 *  • `twist` (06.10) — твист-кости (`twistBones.findTwistChains` на модели в позе узлов + `driveTwistChains` покадрово): дерево с
 *    локальными TRS, цепи (узел, доля-приращение, ось в кадре родителя, рест) и кадры (крен src-костей куклы за ±π → локальные
 *    повороты твистов); рыцарь и синтетика UE (доля по положению, копия сабмеша, самодубль сегмента). Цепи игры (на модели,
 *    сконформленной `makeRetargetRig`) сверяются с позой узлов здесь же.
 * Скопировать в Unity: `python tools/unity-check/golden_sync.py` (репо Unity) → Assets/DM/PoseEditor/Tests/unity_rig_golden.json.
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';

const HERE = dirname(fileURLToPath(import.meta.url));
const KNIGHT_GLB = join(HERE, '../../../server/assets/knight_06_modular_rig.glb');

// Загрузчик модели в node: тот же `parseModel` (дедуп скелетов, проверка скина), но байты — с диска, а не по сети.
const glb = vi.hoisted(() => ({ buf: null as ArrayBuffer | null, make: null as (() => THREE.Group) | null }));
vi.mock('./modelAssets.js', async (orig) => {
  const m = await orig<typeof import('./modelAssets.js')>();
  return { ...m, loadModelUrl: async (): Promise<THREE.Group> => (glb.make ? glb.make() : m.parseModel(glb.buf!.slice(0), 'glb')) };
});

import { autoBoneMap, mergeBoneMap, boneIndex, upAxisAngle, makeRetargetRig, OUR_BONES, OUR_FINGERS } from './retarget3d.js';
import { findTwistChains, driveTwistChains } from './twistBones.js';
import { parseModel, skeletonBoneNames } from './modelAssets.js';
import { createModelSkin, resolveCharacterModel, classifySubmesh, type AssetConfig } from './modelSkin.js';
import { buildHumanoid } from './humanoid.js';
import { legCanonFix, legCanonPoints, type LegCanonPoints, type V3 } from './legCanon.js';
import MODELS from '@dm/shared/config/data/models.json' with { type: 'json' };

type Spec = { name: string; bone?: boolean; mesh?: boolean; pos?: [number, number, number]; box?: [number, number, number]; kids?: Spec[] };
interface FlatNode { name: string; bone: boolean; mesh: boolean; parent: number }

/** Собрать дерево THREE из описания: кость — `Bone`, меш — `Mesh` с коробкой, остальное — `Object3D`. */
function build(s: Spec): THREE.Object3D {
  const o = s.mesh ? new THREE.Mesh(new THREE.BoxGeometry(...(s.box ?? [1, 1, 1]))) : s.bone ? new THREE.Bone() : new THREE.Object3D();
  o.name = s.name;
  if (s.pos) o.position.set(...s.pos);
  for (const k of s.kids ?? []) o.add(build(k));
  return o;
}
/** Дерево плоским списком в порядке обхода (`traverse` = прямой обход в глубину): так же обходит Unity. */
function flatten(root: THREE.Object3D): { nodes: FlatNode[]; idx: Map<THREE.Object3D, number> } {
  const nodes: FlatNode[] = []; const idx = new Map<THREE.Object3D, number>();
  root.traverse((o) => {
    idx.set(o, nodes.length);
    nodes.push({ name: o.name, bone: !!(o as THREE.Bone).isBone, mesh: !!(o as THREE.Mesh).isMesh, parent: o.parent ? idx.get(o.parent) ?? -1 : -1 });
  });
  return { nodes, idx };
}
const bone = (name: string, kids: Spec[] = [], pos?: [number, number, number]): Spec => ({ name, bone: true, kids, pos });
const node = (name: string, kids: Spec[] = [], pos?: [number, number, number]): Spec => ({ name, kids, pos });
const mesh = (name: string, box?: [number, number, number], pos?: [number, number, number]): Spec => ({ name, mesh: true, box, pos });

/** Полный разбор карты над деревом — то, что делает `modelSkin.resolveBoneMap`, плюс кость-драйвер каждой нашей кости. */
function treeCase(label: string, root: THREE.Object3D, stored: Record<string, string>): Record<string, unknown> {
  root.updateMatrixWorld(true);
  const { nodes, idx } = flatten(root);
  const names = skeletonBoneNames(root);
  const auto = autoBoneMap(names);
  const merged = mergeBoneMap(auto, stored, root);
  const byName = boneIndex(root);
  const index: Record<string, number> = {};
  for (const [n, b] of byName) index[n] = idx.get(b)!;
  const drive: Record<string, number> = {};
  for (const our of [...OUR_BONES, ...OUR_FINGERS]) { const t = merged[our]; const b = t ? byName.get(t) : undefined; if (b) drive[our] = idx.get(b)!; }
  return { label, nodes, stored, names, auto, merged, index, drive };
}

// ── синтетические конвенции имён ─────────────────────────────────────────────────────────────────────────────────
const sideNames = (fmt: (side: 'L' | 'R', core: string) => string, cores: string[]): string[] =>
  (['L', 'R'] as const).flatMap((s) => cores.map((c) => fmt(s, c)));
const NAME_SETS: { label: string; names: string[] }[] = [
  { label: 'mixamo', names: ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2', 'mixamorig:Neck', 'mixamorig:Head', 'mixamorig:HeadTop_End',
    ...sideNames((s, c) => `mixamorig:${s === 'L' ? 'Left' : 'Right'}${c}`, ['Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase', 'Toe_End',
      'HandThumb1', 'HandThumb2', 'HandThumb3', 'HandThumb4', 'HandIndex1', 'HandIndex2', 'HandIndex3', 'HandIndex4', 'HandMiddle1', 'HandMiddle2', 'HandMiddle3', 'HandMiddle4',
      'HandRing1', 'HandRing2', 'HandRing3', 'HandRing4', 'HandPinky1', 'HandPinky2', 'HandPinky3', 'HandPinky4'])] },
  { label: 'ue5', names: ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05', 'neck_01', 'neck_02', 'head',
    ...sideNames((s, c) => `${c}_${s.toLowerCase()}`, ['clavicle', 'upperarm', 'lowerarm', 'hand', 'upperarm_twist_01', 'lowerarm_twist_01', 'thigh', 'calf', 'foot', 'ball',
      'thigh_twist_01', 'calf_twist_01', 'thumb_01', 'thumb_02', 'thumb_03', 'index_metacarpal', 'index_01', 'index_02', 'index_03', 'middle_01', 'middle_02', 'middle_03',
      'ring_01', 'ring_02', 'ring_03', 'pinky_01', 'pinky_02', 'pinky_03'])] },
  { label: 'unity-humanoid', names: ['Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
    ...sideNames((s, c) => `${s === 'L' ? 'Left' : 'Right'}${c}`, ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes',
      'ThumbProximal', 'ThumbIntermediate', 'ThumbDistal', 'IndexProximal', 'IndexIntermediate', 'IndexDistal', 'LittleProximal', 'LittleIntermediate', 'LittleDistal'])] },
  { label: 'bip01', names: ['Bip01', 'Bip01 Pelvis', 'Bip01 Spine', 'Bip01 Spine1', 'Bip01 Spine2', 'Bip01 Neck', 'Bip01 Head',
    ...sideNames((s, c) => `Bip01 ${s} ${c}`, ['Clavicle', 'UpperArm', 'Forearm', 'Hand', 'Thigh', 'Calf', 'Foot', 'Toe0', 'Finger0', 'Finger01', 'Finger1', 'Finger11'])] },
  { label: 'explosive', names: ['B_Pelvis', 'B_Spine', 'B_Spine1', 'B_Spine2', 'B_Neck', 'B_Head',
    ...sideNames((s, c) => `B_${s}_${c}`, ['Clavicle', 'UpperArm', 'Forearm', 'Hand', 'Thigh', 'Calf', 'Foot', 'Toe0', 'Index1', 'Index2', 'Index3'])] },
  { label: 'rigify', names: ['root', 'spine', 'spine.001', 'spine.002', 'spine.003', 'spine.004', 'spine.005', 'spine.006', 'DEF-spine',
    ...sideNames((s, c) => `${c}.${s}`, ['shoulder', 'upper_arm', 'forearm', 'hand', 'thigh', 'shin', 'foot', 'toe', 'thumb.01', 'thumb.02', 'thumb.03',
      'f_index.01', 'f_index.02', 'f_index.03', 'f_middle.01', 'f_pinky.01', 'palm.01'])] },
  { label: 'daz', names: ['hip', 'pelvis', 'abdomenLower', 'abdomenUpper', 'chestLower', 'chestUpper', 'neckLower', 'neckUpper', 'head',
    ...sideNames((s, c) => `${s.toLowerCase()}${c}`, ['Collar', 'ShldrBend', 'ShldrTwist', 'ForearmBend', 'ForearmTwist', 'Hand', 'ThighBend', 'ThighTwist', 'Shin', 'Foot', 'Toe',
      'Thumb1', 'Thumb2', 'Thumb3', 'Index1', 'Index2', 'Index3', 'Mid1', 'Mid2', 'Mid3', 'Pinky1'])] },
  { label: 'vrm', names: ['J_Bip_C_Hips', 'J_Bip_C_Spine', 'J_Bip_C_Chest', 'J_Bip_C_UpperChest', 'J_Bip_C_Neck', 'J_Bip_C_Head',
    ...sideNames((s, c) => `J_Bip_${s}_${c}`, ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'ToeBase', 'Thumb1', 'Thumb2', 'Thumb3', 'Little1'])] },
  // CC: вспомогалка скина `*ShareBone` у левой ноги стоит РАНЬШЕ настоящей кости, у правой — позже (как в файле рыцаря).
  { label: 'cc-sharebone', names: ['CC_Base_BoneRoot', 'CC_Base_Hip', 'CC_Base_Pelvis', 'CC_Base_L_Thigh', 'CC_Base_L_Calf', 'CC_Base_L_Foot', 'CC_Base_L_ToeBaseShareBone',
    'CC_Base_L_ToeBase', 'CC_Base_L_BigToe1', 'CC_Base_L_ThighTwist01', 'CC_Base_R_Thigh', 'CC_Base_R_Calf', 'CC_Base_R_Foot', 'CC_Base_R_ToeBase', 'CC_Base_R_ToeBaseShareBone',
    'CC_Base_Waist', 'CC_Base_Spine01', 'CC_Base_Spine02', 'CC_Base_NeckTwist02', 'CC_Base_NeckTwist01', 'CC_Base_Head', 'CC_Base_L_Clavicle', 'CC_Base_L_Upperarm',
    'CC_Base_L_UpperarmTwist01', 'CC_Base_L_Forearm', 'CC_Base_L_ForearmTwist01', 'CC_Base_L_Hand', 'CC_Base_L_Mid1', 'CC_Base_L_Mid2', 'CC_Base_L_Mid3', 'CC_Base_L_Pinky1'] },
  // сторона в конце имени (`_l`) снимается так же, как в начале: иначе «лишний» символ решает, чья кость ближе к ядру
  { label: 'сторона в конце и в начале', names: ['l_upperarm1', 'upperarm_l', 'r_thigh2', 'thigh_r', 'calf.l.001', 'calf.l'] },
  { label: 'empty', names: [] },
  { label: 'junk', names: ['Armature', 'Camera', 'Light', 'Scene', 'Collider_01', 'polySurface12'] },
];

// ── иерархии ────────────────────────────────────────────────────────────────────────────────────────────────────
/** CC «по-старому»: драйв-иерархия + ЛИСТЬЯ-референсы skin.joints с теми же именами под ней (зомби: 204 ноды на 100 суставов). */
function ccLeafRefs(): THREE.Object3D {
  return build(node('', [
    node('RL_BoneRoot', [bone('CC_Base_Hip', [
      bone('CC_Base_Pelvis', [
        bone('CC_Base_L_Thigh', [bone('CC_Base_L_Calf', [bone('CC_Base_L_Foot', [bone('CC_Base_L_ToeBaseShareBone'), bone('CC_Base_L_ToeBase', [bone('CC_Base_L_BigToe1')])]), bone('CC_Base_L_Calf')])]),
        bone('CC_Base_R_Thigh', [bone('CC_Base_R_Calf', [bone('CC_Base_R_Foot', [bone('CC_Base_R_ToeBase', [bone('CC_Base_R_BigToe1')]), bone('CC_Base_R_ToeBaseShareBone')])])]),
      ]),
      bone('CC_Base_Waist', [bone('CC_Base_Spine01', [bone('CC_Base_Spine02', [
        bone('CC_Base_NeckTwist01', [bone('CC_Base_NeckTwist02', [bone('CC_Base_Head', [bone('CC_Base_Head')])])]),
        bone('CC_Base_L_Clavicle', [bone('CC_Base_L_Upperarm', [bone('CC_Base_L_Forearm', [bone('CC_Base_L_Hand', [bone('CC_Base_L_Mid1')]), bone('CC_Base_L_Forearm')])])]),
        bone('CC_Base_R_Clavicle', [bone('CC_Base_R_Upperarm', [bone('CC_Base_R_Forearm', [bone('CC_Base_R_Hand', [bone('CC_Base_R_Mid1')])])])]),
      ])])]),
    ])]),
    mesh('chest_body_01'), mesh('head_01'),
  ]));
}
/** Старый экспорт рыцаря: копии скелета нанизаны ПО-КОСТНО (Upperarm → Upperarm → …), канон — самая ВНЕШНЯЯ. */
function nestedCopies(): THREE.Object3D {
  const chain = (name: string, depth: number, inner: Spec[]): Spec => (depth === 0 ? bone(name, inner) : bone(name, [chain(name, depth - 1, inner)]));
  return build(node('Scene', [
    bone('CC_Base_Hip', [
      chain('CC_Base_Spine01', 2, [chain('CC_Base_Spine02', 2, [
        chain('CC_Base_L_Clavicle', 1, [chain('CC_Base_L_Upperarm', 3, [chain('CC_Base_L_Forearm', 2, [bone('CC_Base_L_Hand')])])]),
        chain('CC_Base_NeckTwist01', 1, [bone('CC_Base_Head')]),
      ])]),
      chain('CC_Base_L_Thigh', 2, [bone('CC_Base_L_Calf', [bone('CC_Base_L_Foot')])]),
    ]),
    mesh('chest_01'),
  ]));
}
/** Анимация-ФБХ без скина (Explosive): ни одной `Bone` — «кости» берутся из именованных не-мешей. */
function noSkin(): THREE.Object3D {
  return build(node('Root', [
    node('B_Pelvis', [
      node('B_Spine', [node('B_Spine1', [node('B_Spine2', [node('B_Neck', [node('B_Head')]), node('B_L_Clavicle', [node('B_L_UpperArm', [node('B_L_Forearm', [node('B_L_Hand')])])])])])]),
      node('B_L_Thigh', [node('B_L_Calf', [node('B_L_Foot', [node('B_L_Toe0')])])]),
      node('B_R_Thigh', [node('B_R_Calf', [node('B_R_Foot')])]),
    ]),
    mesh('Body'), mesh('LeftArmMesh'),
  ]));
}
/** Mixamo со своими кистями (4 сегмента пальца) и мешем-ребёнком у кости. */
function mixamoTree(): THREE.Object3D {
  const fingers = (side: string): Spec[] => ['Thumb', 'Index'].map((f) => bone(`mixamorig:${side}Hand${f}1`, [bone(`mixamorig:${side}Hand${f}2`, [bone(`mixamorig:${side}Hand${f}3`, [bone(`mixamorig:${side}Hand${f}4`)])])]));
  return build(node('Armature', [
    bone('mixamorig:Hips', [
      bone('mixamorig:Spine', [bone('mixamorig:Spine1', [bone('mixamorig:Spine2', [
        bone('mixamorig:Neck', [bone('mixamorig:Head', [bone('mixamorig:HeadTop_End'), mesh('HelmetProp')])]),
        bone('mixamorig:LeftShoulder', [bone('mixamorig:LeftArm', [bone('mixamorig:LeftForeArm', [bone('mixamorig:LeftHand', fingers('Left'))])])]),
        bone('mixamorig:RightShoulder', [bone('mixamorig:RightArm', [bone('mixamorig:RightForeArm', [bone('mixamorig:RightHand', fingers('Right'))])])]),
      ])])]),
      bone('mixamorig:LeftUpLeg', [bone('mixamorig:LeftLeg', [bone('mixamorig:LeftFoot', [bone('mixamorig:LeftToeBase', [bone('mixamorig:LeftToe_End')])])])]),
      bone('mixamorig:RightUpLeg', [bone('mixamorig:RightLeg', [bone('mixamorig:RightFoot', [bone('mixamorig:RightToeBase')])])]),
    ]),
    mesh('Body'),
  ]));
}

// ── доворот к Y-up ──────────────────────────────────────────────────────────────────────────────────────────────
function upCase(label: string, root: THREE.Object3D, map: Record<string, string>): Record<string, unknown> {
  root.updateMatrixWorld(true);
  const byName = boneIndex(root);
  const w = (our: string): number[] | null => { const b = byName.get(map[our] ?? ''); return b ? b.getWorldPosition(new THREE.Vector3()).toArray() : null; };
  const bones = new THREE.Box3(); const v = new THREE.Vector3();
  root.traverse((o) => { if ((o as THREE.Bone).isBone) bones.expandByPoint(o.getWorldPosition(v)); });
  const meshBox = new THREE.Box3().setFromObject(root);
  return {
    label, hips: w('Hips'), head: w('Head'), neck: w('Neck'), chest: w('Chest'),
    bones: bones.isEmpty() ? null : [bones.min.toArray(), bones.max.toArray()],
    meshes: meshBox.isEmpty() ? null : [meshBox.min.toArray(), meshBox.max.toArray()],
    angle: upAxisAngle(root, map),
  };
}
const SPINE_MAP = { Hips: 'hip', Chest: 'chest', Neck: 'neck', Head: 'head' };
const spine = (hip: [number, number, number], chest: [number, number, number] | null, neck: [number, number, number] | null, head: [number, number, number] | null): THREE.Object3D =>
  build(node('', [bone('hip', [
    ...(chest ? [bone('chest', [], [chest[0] - hip[0], chest[1] - hip[1], chest[2] - hip[2]])] : []),
    ...(neck ? [bone('neck', [], [neck[0] - hip[0], neck[1] - hip[1], neck[2] - hip[2]])] : []),
    ...(head ? [bone('head', [], [head[0] - hip[0], head[1] - hip[1], head[2] - hip[2]])] : []),
  ], hip)]));

// ── выбор модели-атласа ─────────────────────────────────────────────────────────────────────────────────────────
type M = { id: string; kind?: string; url?: string; classId?: string };
const MODEL_SETS: { label: string; models: M[] }[] = [
  { label: 'стенд: один рыцарь без класса + тайлы', models: [{ id: 'knight', kind: 'character', url: '/k.glb' }, { id: 'tile', kind: 'part', url: '/t.glb', classId: '' }] },
  { label: 'свой, глобальный, маг', models: [{ id: 'm_war', kind: 'character', url: '/w.glb', classId: 'warrior' }, { id: 'm_glob', kind: 'character', url: '/g.glb' }, { id: 'm_mage', kind: 'character', url: '/m.glb', classId: 'mage' }] },
  { label: 'без глобального — первый', models: [{ id: 'm_war', kind: 'character', url: '/w.glb', classId: 'warrior' }, { id: 'm_mage', kind: 'character', url: '/m.glb', classId: 'mage' }] },
  { label: 'глобальный после классовых; пустой classId = без класса', models: [{ id: 'm_mage', kind: 'character', url: '/m.glb', classId: 'mage' }, { id: 'm_empty', kind: 'character', url: '/e.glb', classId: '' }, { id: 'm_glob', kind: 'character', url: '/g.glb' }] },
  { label: 'без url и не персонаж — мимо', models: [{ id: 'no_url', kind: 'character', classId: 'warrior' }, { id: 'part_war', kind: 'part', url: '/p.glb', classId: 'warrior' }, { id: 'no_kind', url: '/n.glb' }, { id: 'zombie', kind: 'character', url: '/z.glb', classId: 'undead' }] },
  { label: 'пусто', models: [] },
];
const MODEL_KEYS: (string | null)[] = ['warrior', 'mage', 'archer', 'undead', '', null];

describe('эталон карты костей и атласа для Unity', () => {
  it('пишет __golden__/unity_rig.json', async () => {
    expect(existsSync(KNIGHT_GLB), 'GLB рыцаря на месте').toBe(true);
    const buf = readFileSync(KNIGHT_GLB);
    glb.buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const entry = (MODELS as unknown as { id: string; url: string; kind: string; slots?: Record<string, string>; boneMap?: Record<string, string>; boneOffsets?: Record<string, number[]>; boneScale?: Record<string, number>; body?: Record<string, number> }[])
      .find((m) => m.id === 'knight_06_modular_rig')!;
    expect(entry, 'рыцарь в конфиге').toBeTruthy();

    // ── имена ──
    const knight = await parseModel(glb.buf.slice(0), 'glb');
    const knightNames = skeletonBoneNames(knight);
    const autoMap = [{ label: 'knight_06', names: knightNames }, ...NAME_SETS].map((s) => ({ label: s.label, names: s.names, map: autoBoneMap(s.names) }));
    expect((autoMap[0]!.map as Record<string, string>).LeftToes, 'вспомогалка не крадёт носок').toBe('CC_Base_L_ToeBase');

    // ── иерархии: боевой рыцарь (сохранённая карта из конфига и порченые), синтетика ──
    const stored = entry.boneMap ?? {};
    const trees = [
      treeCase('knight_06 + карта конфига', knight, stored),
      treeCase('knight_06 + лист вместо носка (старое сохранение)', knight, { ...stored, LeftToes: 'CC_Base_L_ToeBaseShareBone', RightToes: 'CC_Base_R_ToeBaseShareBone' }),
      treeCase('knight_06 + ручной выбор', knight, { Spine: 'CC_Base_Waist', Chest: 'CC_Base_Spine01', UpperChest: 'CC_Base_Spine02', LeftHand: 'nope', Neck: '' }),
      treeCase('knight_06 без сохранённой', knight, {}),
      treeCase('cc: листья-референсы', ccLeafRefs(), { LeftLowerLeg: 'CC_Base_L_Calf', Head: 'CC_Base_Head' }),
      treeCase('копии скелета по-костно', nestedCopies(), {}),
      treeCase('без скина (анимация)', noSkin(), { LeftToes: 'B_L_Toe0', RightToes: 'B_R_Foot' }),
      treeCase('mixamo', mixamoTree(), { LeftToes: 'mixamorig:LeftToe_End', RightUpperArm: 'mixamorig:RightShoulder' }),
    ];

    // ── доворот к Y-up ──
    const upAxis = [
      upCase('knight_06', knight, stored),
      upCase('y-up', spine([0, 90, 0], [0, 120, 2], [0, 140, 1], [0, 155, 3]), SPINE_MAP),
      upCase('z-up, голова +Z', spine([0, 0, 90], null, null, [0, 3, 155]), SPINE_MAP),
      upCase('z-up, голова −Z', spine([0, 0, -90], null, null, [0, -3, -155]), SPINE_MAP),
      upCase('вверх ногами', spine([0, 90, 0], null, null, [0, 20, 1]), SPINE_MAP),
      upCase('только шея', spine([0, 0, 90], null, [0, 1, 140], null), SPINE_MAP),
      upCase('только грудь, Y', spine([0, 90, 0], [0, 120, 2], null, null), SPINE_MAP),
      upCase('без таза — кости вытянуты по Z', build(node('', [bone('a', [], [0, 0, 0]), bone('b', [], [3, 10, 80]), mesh('m', [5, 5, 5])])), {}),
      upCase('без таза — кости по Y', build(node('', [bone('a', [], [0, 0, 0]), bone('b', [], [3, 80, 10])])), {}),
      upCase('без костей — меш лежит по Z', build(node('', [mesh('sword', [2, 4, 40])])), {}),
      upCase('без костей — меш чуть длиннее по Z', build(node('', [mesh('crate', [10, 10, 12])])), {}),
      upCase('пусто', build(node('', [])), {}),
    ];
    expect(upAxis[0]!.angle, 'рыцарь уже Y-up').toBe(0);

    // ── выбор модели ──
    const models: Record<string, unknown>[] = [];
    for (const s of MODEL_SETS) {
      const cfg = { models: s.models, materials: [], textures: [] } as unknown as AssetConfig;
      for (const key of MODEL_KEYS) for (const fb of [true, false]) {
        models.push({ label: s.label, models: s.models, key, allowFallback: fb, id: resolveCharacterModel(cfg, key ?? undefined, fb)?.id ?? null });
      }
    }

    // ── слот по префиксу ──
    const classify = ['helm_01', 'head_01', 'chest_01', 'gloves_01', 'boots_01', 'Helm_01', 'HELM.001', 'boots-2', '  chest_plate_01  ', 'head', 'helmet_01', 'heads_up',
      'chestnut', 'body_01', 'hair_01', 'helm_hair_01', 'gloves', 'gloves9', 'boots_', 'Boots Legs', 'chest\tx', 'шлем_01', 'helmй', ''].map((n) => ({ name: n, slot: classifySubmesh(n) }));

    // ── атлас: настоящий setAtlas на настоящем GLB ──
    const look = { profile: entry.body, boneScale: entry.boneScale, boneOffsets: entry.boneOffsets };
    // Пролёт таз→голова САМОЙ модели (поза узлов, масштаб 1) — знаменатель `scaleToSource`: масштаб = пролёт куклы / этот.
    knight.updateMatrixWorld(true);
    const firstBone = (n: string): THREE.Object3D | undefined => { let f: THREE.Object3D | undefined; knight.traverse((o) => { if (!f && (o as THREE.Bone).isBone && o.name === n) f = o; }); return f; };
    const impSpan = firstBone(stored.Hips ?? '')!.getWorldPosition(new THREE.Vector3()).distanceTo(firstBone(stored.Head ?? '')!.getWorldPosition(new THREE.Vector3()));
    async function atlasCase(label: string, visible: Record<string, string>, opt: { hideHair?: boolean; slots?: Record<string, string>; bare?: boolean } = {}): Promise<Record<string, unknown>> {
      const parent = new THREE.Group();
      const source = opt.bare ? buildHumanoid() : buildHumanoid(look);
      const skin = createModelSkin(parent, source);
      const model = { ...entry, slots: opt.slots ?? entry.slots, submeshMaterials: {} };
      const meshes = await skin.setAtlas(model as never, visible, { materials: [], textures: [] }, { hideHair: opt.hideHair });
      const shown: string[] = [];
      parent.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.visible) shown.push(o.name); });
      const exp = skin.atlasExport()!;
      source.root.updateMatrixWorld(true);
      const sp = source.bones.get('Hips')!.getWorldPosition(new THREE.Vector3()).distanceTo(source.bones.get('Head')!.getWorldPosition(new THREE.Vector3()));
      skin.dispose();
      return {
        label, visible, hideHair: !!opt.hideHair, slots: model.slots ?? null, meshes, shown, boneMap: exp.boneMap, upFix: exp.root.rotation.x,
        scale: exp.root.scale.x, srcSpan: sp, impSpan, look: opt.bare ? null : look,
      };
    }
    const partial = Object.fromEntries(Object.entries(entry.slots ?? {}).filter(([k]) => !k.startsWith('helm_')));
    const atlas = [
      await atlasCase('база воина — старые имена без префикса', { helm: 'hair_01', head: 'head_01', gloves: 'heand_01', chest: 'body_01', boots: 'legs_01' }),
      await atlasCase('точные имена', { helm: 'helm_salade_02', head: 'head_01', gloves: 'gloves_plate_gloves_01', chest: 'chest_plate_armor_01', boots: 'boots_plate_legs_01' }),
      await atlasCase('незнакомый id — первая деталь слота', { helm: 'no_such_helm', chest: 'zzz', head: 'head_01' }),
      await atlasCase('пустое значение — слот скрыт', { helm: '', head: 'head_01', chest: 'chest_body_01', gloves: '', boots: 'boots_legs_02' }),
      await atlasCase('без ключей — весь слот', {}),
      await atlasCase('hideHair: волосы прочь', { helm: 'hair_01', head: 'head_01', chest: 'chest_hauberk_01' }, { hideHair: true }),
      await atlasCase('hideHair при шлеме', { helm: 'helm_tophelm_02', head: 'head_01' }, { hideHair: true }),
      await atlasCase('слоты из классификатора (конфиг пуст)', { helm: 'hair_02', chest: 'leather_jacket_01' }, { slots: {} }),
      await atlasCase('часть слотов в конфиге, шлемы — префиксом', { helm: 'barbute_01', boots: 'nope' }, { slots: partial }),
      await atlasCase('слот перепутан в конфиге', { chest: 'helm_barbute_01', helm: 'helm_hair_01' }, { slots: { ...entry.slots, helm_barbute_01: 'chest', head_01: 'weird' } }),
      await atlasCase('кукла без офсетов модели', { helm: 'hair_01' }, { bare: true }),
    ];
    expect((atlas[0]!.shown as string[]).sort()).toEqual(['boots_legs_01', 'chest_body_01', 'gloves_heand_01', 'head_01', 'helm_hair_01']);

    // ── атлас-синтетика: детали без слота, слот из конфига у детали без префикса, перепутанный слот, волосы без префикса ──
    const SYN_MESHES = ['helm_a', 'helm_b', 'HairPiece', 'weird_thing', 'Body_unslotted', 'chest_x', 'chest_y', 'chest_Z', 'boots_1', 'gloves', 'head', 'Helm_C'];
    const synModel = (): THREE.Group => {
      const root = new THREE.Group();
      const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 90, 0);
      const spine = new THREE.Bone(); spine.name = 'Spine'; spine.position.set(0, 20, 0); hips.add(spine);
      const head = new THREE.Bone(); head.name = 'Head'; head.position.set(0, 40, 0); spine.add(head);
      root.add(hips); root.updateMatrixWorld(true);
      const skel = new THREE.Skeleton([hips, spine, head]);
      for (const n of SYN_MESHES) {
        const geo = new THREE.BoxGeometry(10, 10, 10);
        const cnt = geo.attributes.position!.count;
        geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(cnt * 4), 4));
        const w = new Float32Array(cnt * 4); for (let i = 0; i < cnt; i++) w[i * 4] = 1;
        geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
        const m = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial()); m.name = n; m.bind(skel);
        root.add(m);
      }
      return root;
    };
    const SYN_SLOTS = { HairPiece: 'helm', helm_b: 'boots', Body_unslotted: '', weird_thing: '' };
    async function synCase(label: string, visible: Record<string, string>, hideHair = false): Promise<Record<string, unknown>> {
      glb.make = synModel;
      const parent = new THREE.Group();
      const skin = createModelSkin(parent, buildHumanoid());
      const meshes = await skin.setAtlas({ id: 'syn', url: '/syn.glb', kind: 'character', slots: SYN_SLOTS, boneMap: {} } as never, visible, { materials: [], textures: [] }, { hideHair });
      const shown: string[] = [];
      parent.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.visible) shown.push(o.name); });
      skin.dispose(); glb.make = null;
      return { label, visible, hideHair, slots: SYN_SLOTS, meshes, shown };
    }
    const atlasSynthetic = [
      await synCase('без ключей: без слота — скрыто', {}),
      await synCase('слот из конфига у детали без префикса + hideHair', { helm: 'HairPiece', chest: 'nope', boots: 'b', gloves: '' }, true),
      await synCase('префикс-лечение и регистр', { helm: 'a', head: 'head', chest: 'chest_y' }),
      await synCase('перепутанный слот: деталь helm_b носится как сапоги', { boots: 'helm_b', helm: 'C' }),
      await synCase('незнакомый id — первая по КОДАМ символов (заглавная раньше строчной)', { chest: 'nope', helm: 'Piece' }),
    ];
    expect(atlasSynthetic[0]!.shown as string[]).not.toContain('weird_thing');

    // ── пролёт таз→голова куклы-источника ──
    const spanOf = (o: Parameters<typeof buildHumanoid>[0]): number => {
      const h = buildHumanoid(o); h.root.updateMatrixWorld(true);
      return h.bones.get('Hips')!.getWorldPosition(new THREE.Vector3()).distanceTo(h.bones.get('Head')!.getWorldPosition(new THREE.Vector3()));
    };
    const partOff = { ...entry.boneOffsets }; delete partOff.UpperChest; delete partOff.Head;
    const LOOKS: { label: string; look: { profile?: Record<string, number>; boneScale?: Record<string, number>; boneOffsets?: Record<string, number[]> } }[] = [
      { label: 'база', look: {} },
      { label: 'рыцарь как в игре', look },
      { label: 'профиль: рост и торс', look: { ...look, profile: { height: 1.1, torso: 0.9, arm: 1.2, leg: 0.8 } } },
      { label: 'офсеты частично + масштабы', look: { boneOffsets: partOff, boneScale: { Spine: 1.2, Head: 0.9, UpperChest: 1.1, Neck: 1.3 }, profile: { height: 0.95 } } },
      { label: 'только масштабы', look: { boneScale: { Spine: 1.381, Chest: 0.959, Head: 1.209 } } },
    ];
    const span = LOOKS.map((l) => ({ label: l.label, look: l.look, span: spanOf(l.look as never) }));

    // ── твист-кости (06.10, `twistBones.ts`): Unity их не вёл — кость-твист жёстко шла за родителем, и голенище сапога у
    // опорной стопы крутилось против неё (на повороте 180° — до 26° у лодыжки). Цепи ищутся на модели в позе узлов (как Unity на
    // привязке), доли и оси — оттуда; кадр — крен НАШЕЙ кости куклы, развёрнутый к прошлому кадру. Дерево — с локальными TRS (веб),
    // Unity строит из них своё (зеркало X) и сверяет и состав цепей, и повороты твистов покадрово.
    const twistCase = (label: string, root: THREE.Object3D, map: Record<string, string>, lookOf: Parameters<typeof buildHumanoid>[0]): Record<string, unknown> => {
      root.updateMatrixWorld(true);
      const { nodes, idx } = flatten(root);
      const trs: number[][] = [];
      root.traverse((o) => trs.push([...o.position.toArray(), ...o.quaternion.toArray(), ...o.scale.toArray()]));
      const byName = boneIndex(root) as unknown as Map<string, THREE.Object3D>;
      const drivers: Record<string, number> = {};
      for (const our of OUR_BONES) { const b = byName.get(map[our] ?? ''); if (b) drivers[our] = idx.get(b)!; }
      const chains = findTwistChains(byName, map);
      const chainOut = chains.map((ch) => ({
        src: ch.ourSrc, seg: ch.ourSeg, child: ch.ourChild,
        links: ch.nodes.map((t) => ({ i: idx.get(t.node)!, name: t.node.name, gain: t.gain, axis: t.axis.toArray(), rest: t.restLocal.toArray() })),
      }));
      // Кадры: крен src-костей куклы гуляет за ±π (развёртка) поверх «качания» в сторону; на выходе — локальные повороты твистов.
      const driver = buildHumanoid(lookOf);
      const SRC = [...new Set(chains.map((c) => c.ourSrc))];
      const frames: { src: Record<string, number[]>; out: number[][] }[] = [];
      for (let f = 0; f < 48; f++) {
        const src: Record<string, number[]> = {};
        SRC.forEach((nm, k) => {
          const ch = chains.find((c) => c.ourSrc === nm)!;
          const axis = driver.bones.get(ch.ourChild)!.position.clone().normalize();
          const roll = 0.35 * f * (k % 2 ? -1 : 1) + 0.2 * Math.sin(f * 0.7 + k);      // за 48 кадров — далеко за ±π
          const swing = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4 * Math.sin(f * 0.31 + k), 0.2 * Math.cos(f * 0.17), 0.3 * Math.sin(f * 0.23 - k), 'XYZ'));
          const q = swing.multiply(new THREE.Quaternion().setFromAxisAngle(axis, roll));
          if (f % 7 === 3) q.set(-q.x, -q.y, -q.z, -q.w);                                    // знак кватерниона — кратчайшее представление
          driver.bones.get(nm)!.quaternion.copy(q);
          src[nm] = q.toArray();
        });
        driveTwistChains(chains, driver);
        frames.push({ src, out: chains.flatMap((c) => c.nodes.map((t) => t.node.quaternion.toArray())) });
      }
      return { label, nodes, trs, map, drivers, look: lookOf, chains: chainOut, frames };
    };
    // Синтетика веток правил: UE-имена (`upperarm_twist_01_l`), твист ПОСЕРЕДИНЕ сегмента (доля по положению), копия сабмеша с
    // суффиксом (`_5` — не твист сегмента), самодубль сегмента в поддереве (не обходится), один твист на голени.
    const ueArm = (): THREE.Object3D => build(node('', [bone('pelvis', [
      bone('upperarm_l', [
        bone('upperarm_twist_01_l', [bone('upperarm_twist_01_l_5', [], [0, 0, 0])], [3, -12, 1]),
        bone('upperarm_l', [], [0, 0, 0]),
        bone('lowerarm_l', [bone('lowerarm_twist_01_l', [], [0.2, -6, 0.4]), bone('lowerarm_twist_02_l', [], [0.1, -11, 0.1]), bone('hand_l', [], [0, -24, 0])], [0, -27, 0]),
      ], [11, 40, 0]),
      bone('thigh_r', [bone('thigh_twist_01_r', [], [0, 0, 0]), bone('calf_r', [bone('calf_twist_01_r', [], [0, -19, 0]), bone('foot_r', [], [0, -38, 1])], [0, -40, 0])], [-9, -2, 0]),
    ], [0, 90, 0])]));
    const ueMap = { Hips: 'pelvis', LeftUpperArm: 'upperarm_l', LeftLowerArm: 'lowerarm_l', LeftHand: 'hand_l', RightUpperLeg: 'thigh_r', RightLowerLeg: 'calf_r', RightFoot: 'foot_r' };
    const knightTw = await parseModel(glb.buf.slice(0), 'glb');
    const twist = [
      twistCase('knight_06 + карта конфига', knightTw, mergeBoneMap(autoBoneMap(skeletonBoneNames(knightTw)), stored, knightTw), look),
      twistCase('ue: доля по положению, копия сабмеша, самодубль', ueArm(), ueMap, {}),
    ];
    // Игра ищет цепи на СКОНФОРМЛЕННОЙ модели (`makeRetargetRig` с куклой-источником) — у рыцаря итог обязан совпасть с позой узлов.
    {
      const g = await parseModel(glb.buf.slice(0), 'glb');
      const src = buildHumanoid(look);
      src.root.updateMatrixWorld(true);
      const sh = src.bones.get('Hips')!.getWorldPosition(new THREE.Vector3()).distanceTo(src.bones.get('Head')!.getWorldPosition(new THREE.Vector3()));
      const gameRig = makeRetargetRig(g, mergeBoneMap(autoBoneMap(skeletonBoneNames(g)), stored, g), sh / impSpan, src);   // масштаб — `scaleToSource`
      const want = (twist[0]!.chains as { links: { name: string; gain: number }[] }[]).flatMap((c) => c.links.map((l) => [l.name, l.gain]));
      const got = gameRig.twistBones().map((t) => [t.bone, t.gain]);
      expect(got.length, 'у рыцаря есть твист-цепи').toBeGreaterThan(8);
      expect(got.map(([n]) => n)).toEqual(want.map(([n]) => n));
      got.forEach(([, gn], i) => expect(Math.abs((gn as number) - (want[i]![1] as number)), String(want[i]![0])).toBeLessThan(1e-3));
    }

    // ⭐ РЕСТ НОГ МОДЕЛИ (07.10, `legCanon.ts`): точки суставов (мировые, кадр Y-вверх, лицом +Z) → поправки реста. Unity
    // `LegCanon.Fix` получает те же точки (свои, переведённые в кадр веба зеркалом X) и обязан выдать те же кватернионы.
    const legCanon: { label: string; points: LegCanonPoints; fix: Record<string, number[]> }[] = [];
    {
      const g = await parseModel(glb.buf.slice(0), 'glb');
      const mp = mergeBoneMap(autoBoneMap(skeletonBoneNames(g)), stored, g);
      g.rotation.set(upAxisAngle(g, mp), 0, 0); g.updateMatrixWorld(true);
      const by = boneIndex(g);
      const pts = legCanonPoints((our) => by.get(mp[our] ?? ''));
      const fix = legCanonFix(pts);
      expect(Object.keys(fix).length, 'у рыцаря поправлены все кости ног').toBe(8);
      legCanon.push({ label: 'knight_06 (поза узлов)', points: pts, fix });
      // синтетика: нога «как у рыцаря» (развал, сгиб, носок наружу), зеркало X (Unity), носок за 45°, ноги без носка/колена
      const leg = (side: 1 | -1, toeDeg: number, mx: number): Record<string, V3> => {
        const s = side * mx, a = toeDeg * Math.PI / 180 * side;
        const u: V3 = [4 * s, 30, 0], k: V3 = [u[0] + 0.5 * s, 16, 0.6], f: V3 = [k[0] - 0.6 * s, 2, -0.4];
        return { u, k, f, t: [f[0] + Math.sin(a) * 5 * mx, 0.5, f[2] + Math.cos(a) * 5] };
      };
      const synth = (toeDeg: number, mx: number): LegCanonPoints => {
        const L = leg(1, toeDeg, mx), Rr = leg(-1, toeDeg, mx);
        return { uL: L.u, kL: L.k, fL: L.f, tL: L.t, uR: Rr.u, kR: Rr.k, fR: Rr.f, tR: Rr.t };
      };
      const add = (label: string, p: LegCanonPoints): void => { legCanon.push({ label, points: p, fix: legCanonFix(p) }); };
      add('синтетика: носок наружу 23.6°', synth(23.6, 1));
      add('синтетика: зеркало X (Unity)', synth(23.6, -1));
      add('синтетика: носок 60° — стопу не трогать', synth(60, 1));
      { const p = synth(10, 1); delete p.tL; delete p.kR; add('синтетика: без левого носка и правого колена', p); }
    }

    const golden = {
      note: 'Эталон паритета Unity ↔ веб: карта костей модели (autoBoneMap/mergeBoneMap/boneIndex), доворот к Y-up, выбор атласа, видимость деталей и масштаб, твист-кости (findTwistChains/driveTwistChains), рест ног модели (legCanonFix). Генерит packages/client/src/render3d/unityRigGolden.gen.test.ts.',
      ourBones: [...OUR_BONES], ourFingers: [...OUR_FINGERS],
      autoMap, trees, upAxis, models, classify, atlas, atlasSynthetic, span, twist, legCanon,
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unity_rig.json'), JSON.stringify(golden));
  }, 60_000);
});
