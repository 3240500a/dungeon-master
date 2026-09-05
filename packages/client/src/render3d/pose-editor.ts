/**
 * POSE-EDITOR (мини-Каскадёр) — 3-зонный UI (тулбар / вьюпорт / панель-вкладки / таймлайн).
 * IK-риг Cascadeur-стиль: свободный таз + эффекторы кистей/стоп с пинами + планта стоп (footQuat) + per-limb IK/FK.
 * Персонажи (классы игры + ручные пресеты: пропорции/гендер/оружие) · оружие в руках · клипы per персонаж+оружие
 * (localStorage) · undo/redo · плей/скраб таймлайна. Экспорт JSON поз/клипов — аниматор вшивает в игру.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';   // Ф5: честная обводка выделения
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildHumanoid, type Humanoid, type BuildScale } from './humanoid.js';
import type { BoneScale, BodyProfile } from './bodyProfile.js';
import { initPhysics, PhysWorld } from './ragdoll.js';
import { makeHumanoidRagdoll, type HumanoidRagdoll, PHYS, LIMITS, MOTOR, loadRagdollConfig, saveRagdollConfig, PIN_SRC, RAG_NAMES, weaponHandMasses, renderRagdollGhost, newGhostGround, canonOfHuman, jointOv, JOINT_DEF, limitViewForBone, registerExtraLimits, type LimitView } from './humanoidRagdoll.js';
import { extraLimitView, LIMIT_PRESETS, findPreset } from './jointLimits.js';
import { makeFullBodyIk, type FbikRig } from './fullBodyIk.js';
import { makeTimelinePanel, moveKeys, setInterp, scaleKeys, type TimelinePanel } from './timelinePanel.js';
import { makeCurvePanel, CURVE_PRESETS, easeOfKey, matchPreset, type CurvePanel, type Ease } from './curveEditor.js';   // Ф10: безье-ручки
import { trajectorySamples, polylineLength, arcRatio, excursion } from './trajectory.js';                                          // Ф10: траектория кости
import { requestGeneration, looksLikeBvh, generatedClipName, DEFAULT_AI_CONFIG, type AiConfig } from './poseAiTab.js';   // Ф9: хук под AI-генерацию
import { capturePose, pastePose, pasteIntoInterval, mirrorPoseSide, flipPoseSides, flipClip, mirrorClip,
  rotateClipPhase, comparePoses, EMPTY_POSE_LIBRARY, type PoseLibrary } from './poseLibrary.js';   // Ф7: библиотека поз и copy-tools   // Ф6: тайм-лайн с дорожками
import { MORPH_PRESETS, MORPH_REGIONS, DEFAULT_MORPH, morphToProfile, morphToBuild, morphToBoneScale,
  mergeBoneScale, applyMorphChange, sampleMorph, rangeWarnings, type BodyMorph, type MorphKey, type MorphRange } from './bodyMorph.js';   // Ф8: морфинг тела   // Ф4: пины + full-body IK
import { BUILTIN_GRIPS, findGrip, gripToPose, resolveGripPose, defaultWeaponGrip, applyGripPose, isHandBone, bakeGripIntoClip, EMPTY_GRIP_CONFIG, type GripConfig } from './gripPoses.js';   // Ф3.5: хват — отдельный канал   // Ф3.3: пределы без физ-тела (пальцы) + пресеты скелета
registerExtraLimits(extraLimitView);   // до первого limitViewForBone
import { makeLimitGizmo } from './poseLimitGizmo.js';
import { clampLocalToLimit, decomposeToLimit } from './jointClamp.js';
import { PoseDriver, GAIT, POSE, type PoseTargets } from './pose.js';
import { PosePlayer, gaitToHumanoid as rtGaitToHumanoid, baseWeapon as rtBaseWeapon, measureStancePlants, blendVia, migratePoseName, retargetClipName, solveTwoBoneIK, stepTorsoLead, applyTorsoTwist, applyHeadLookAt, applyBaseGrip, renderMatchWeight, TWIST_DEFAULT, TWIST_STATES_DEFAULT, blendTwist, resolveTwistStates, DEFAULT_MATCH, type TwistProfile, type TwistStates, type TwistCfgStored, type PoseContent } from './poseRuntime.js';
import { WEAPONS, OFFHANDS, attachWeapons } from './weapon3d.js';
import { CLASS_CHARS, MONSTER_CHARS, type Char } from './chars3d.js';
import { savePoseKey } from './poseServer.js';
import { makeHistory } from './history.js';
import { bakeGaitSet, defaultReadPose, GAIT_PRESETS } from './clipBake.js';                    // Ф2.1: процедурка → клипы
import { exportClipsToGLB, downloadFile } from './clipExport.js';                              // Ф2.3: клипы → GLB + манифест
import type { NameProfile } from './clipToAnimation.js';   // Ф1.3: единый откат — и поза, и структура клипа/библиотеки
import { blendTwo, clipPoseAt, clipSegmentAt, clipDur, slerpEuler, lerpAng, mirrorSide, migrateClip, WPN_KEYS, WPN_POS, DEF_GAP,
  type Pose, type Keyframe, type Clip } from './clipModel.js';   // Ф1.1: одна модель клипа на редактор и игру
import { createModelsTab } from './poseModelsTab.js';
import { bakeAnimationToClip, listAnimations } from './clipBaker.js';

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
const V = (): THREE.Vector3 => new THREE.Vector3();
const Q = (): THREE.Quaternion => new THREE.Quaternion();

const canvas = document.getElementById('app') as HTMLCanvasElement;
const bar = document.getElementById('toolbar')!, panel = document.getElementById('panel')!, timeline = document.getElementById('timeline')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio));
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x1a1d26);
const camera = new THREE.PerspectiveCamera(45, 1, 1, 4000); camera.position.set(0, 44, 150);
const orbit = new OrbitControls(camera, canvas); orbit.target.set(0, 34, 0); orbit.enableDamping = true; orbit.dampingFactor = 0.1;
scene.add(new THREE.HemisphereLight(0xbfd0ff, 0x3a3a44, 0.9));
const kl = new THREE.DirectionalLight(0xffffff, 1.6); kl.position.set(60, 120, 90); scene.add(kl);
const flt = new THREE.DirectionalLight(0x9fb0d0, 0.5); flt.position.set(-80, 40, -40); scene.add(flt);
// Непрозрачный ШАХМАТНЫЙ пол — прокручивается при беге (тредмилл), чтобы видеть, скользят ли стопы по земле (как в игре).
const FLOOR_SIZE = 400, FLOOR_TILE = 20;   // мир: одна плитка текстуры = FLOOR_TILE (в ней 2×2 клетки → клетка = 10u)
const checkerTex = ((): THREE.Texture => {
  const cvf = document.createElement('canvas'); cvf.width = cvf.height = 64; const cx = cvf.getContext('2d')!;
  cx.fillStyle = '#2b3142'; cx.fillRect(0, 0, 64, 64); cx.fillStyle = '#232838'; cx.fillRect(0, 0, 32, 32); cx.fillRect(32, 32, 32, 32);
  const t = new THREE.CanvasTexture(cvf); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(FLOOR_SIZE / FLOOR_TILE, FLOOR_SIZE / FLOOR_TILE); t.magFilter = THREE.NearestFilter; return t;
})();
const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), new THREE.MeshStandardMaterial({ map: checkerTex, roughness: 0.96, metalness: 0 }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
function scrollFloor(): void { checkerTex.offset.set(gaitPx / FLOOR_TILE, -gaitPz / FLOOR_TILE); }   // тредмилл: пол едет под бегущим (V текстуры смотрит в −Z из-за поворота пола → Z со знаком минус)

// ── Ф5: ВЬЮПОРТ-КИТ ──
// Обводка выделения через OutlinePass вместо подмены emissive: emissive-хак работал только
// в скелет-стиле (там у каждой кости свой материал); в solid материалы ОБЩИЕ и подсвечивалась
// вся конечность сразу. Обводка не зависит от материалов вообще.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const outline = new OutlinePass(new THREE.Vector2(1, 1), scene, camera);
outline.edgeStrength = 4; outline.edgeGlow = 0; outline.edgeThickness = 1.2;
outline.visibleEdgeColor.set('#ffcf66'); outline.hiddenEdgeColor.set('#6b4a10');
composer.addPass(outline);
composer.addPass(new OutputPass());   // ОБЯЗАТЕЛЬНЫЙ последний пасс: буферы композера линейные, без него картинка темнее
let useComposer = true;   // аварийный тумблер: если постобработка где-то врёт — рисуем напрямую, как раньше

// Сетка поверх пола-шахматки: даёт чувство масштаба и осей (TILE = 32 юнита = 1 м).
const grid = new THREE.GridHelper(320, 10, 0x4a5680, 0x2a3040);
grid.position.y = 0.02; (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.35;
scene.add(grid);
const axes = new THREE.AxesHelper(20); axes.position.y = 0.03; scene.add(axes);

const gizmo = new TransformControls(camera, canvas); gizmo.setSpace('world'); scene.add(gizmo.getHelper());
// СНАП: в Простом режиме включён (5° / 1 юнит) — новичку проще попадать в круглые значения;
// Shift во время драга снап отключает (точная правка). Раньше setTranslationSnap не звался ни разу.
let snapOn = true;
function applySnap(off = false): void {
  const on = snapOn && !off;
  gizmo.setTranslationSnap(on ? 1 : null);
  gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(5) : null);
}
applySnap();
// ── FK-ГИЗМО ПО ОСЯМ СУСТАВА (локальное, а не мировое): гизмо цепляется к ПРОКСИ, ориентированному по DOF-осям сустава
//    (twist/plane/normal из jointLimitView — те же, что рисует гизмо пределов). Кольцо twist охватывает ось кости → удобно
//    твистить/сгибать сустав. Дельта прокси (мир) → лок. поворот кости → клэмп. Кость без сустава → оси самой кости. ──
const boneProxy = new THREE.Object3D(); boneProxy.name = '__boneProxy'; scene.add(boneProxy);
let dragUndo: State | null = null;   // снимок позы на НАЧАЛЕ драга — иначе откат отставал на шаг (писали уже изменённое состояние)
let fkProxyBone: string | null = null;                       // кость, редактируемая через прокси (null = прокси не активен)
const _pBase = new THREE.Quaternion(), _pBaseInv = new THREE.Quaternion(), _bBase = new THREE.Quaternion();
const _parInv = new THREE.Quaternion(), _rdof = new THREE.Quaternion(), _dq = new THREE.Quaternion(), _nw = new THREE.Quaternion();
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _m4 = new THREE.Matrix4();
/** DOF-базис сустава кости nm (правосторонний): X=normal, Y=twist(green), Z=plane. Hinge → ось сгиба на Y. Нет сустава → identity. */
function dofBasis(nm: string, out: THREE.Quaternion): void {
  const v = limitViewForBone(nm);   // физ-риг, иначе без-физическая таблица (фаланги)
  if (v && v.kind === 'swing' && v.twist && v.plane && v.normal) {   // X=normal,Y=twist,Z=plane → Z=X×Y=plane (правостор.)
    _bx.set(v.normal[0], v.normal[1], v.normal[2]).normalize();
    _by.set(v.twist[0], v.twist[1], v.twist[2]).normalize();
    _bz.set(v.plane[0], v.plane[1], v.plane[2]).normalize();
    _m4.makeBasis(_bx, _by, _bz); out.setFromRotationMatrix(_m4); return;
  }
  if (v && v.kind === 'hinge' && v.axis) {                    // шарнир: ось сгиба на Y, X/Z — любой перпендикуляр
    _by.set(v.axis[0], v.axis[1], v.axis[2]).normalize();
    _bx.set(1, 0, 0); if (Math.abs(_by.dot(_bx)) > 0.9) _bx.set(0, 0, 1);
    _bx.addScaledVector(_by, -_by.dot(_bx)).normalize(); _bz.crossVectors(_bx, _by).normalize();
    _m4.makeBasis(_bx, _by, _bz); out.setFromRotationMatrix(_m4); return;
  }
  out.identity();
}
/** Пере-выставить прокси на ТЕКУЩУЮ кость: DOF-базис в мире · её мир-ориентация + позиция сустава. Зов при attach и старте драга. */
function rebaselineProxy(): void {
  if (!fkProxyBone) return;
  const b = human.bones.get(fkProxyBone); if (!b) return;
  human.root.updateMatrixWorld(true);
  b.getWorldQuaternion(_bBase);
  b.parent!.getWorldQuaternion(_parInv); _parInv.invert();
  dofBasis(fkProxyBone, _rdof);
  _pBase.copy(_bBase).multiply(_rdof); _pBaseInv.copy(_pBase).invert();
  boneProxy.quaternion.copy(_pBase); b.getWorldPosition(boneProxy.position); boneProxy.updateMatrixWorld(true);
}
/** Прицепить гизмо вращения к кости ЧЕРЕЗ прокси (кольца по осям сустава). Замена прямого gizmo.attach(bone). */
function attachBoneGizmo(nm: string): void { fkProxyBone = nm; rebaselineProxy(); gizmo.setSpace('local'); gizmo.setMode('rotate'); gizmo.attach(boneProxy); }
gizmo.addEventListener('dragging-changed', (e) => { const dragging = (e as unknown as { value: boolean }).value; orbit.enabled = !dragging; if (dragging) { if (gizmo.object === boneProxy && fkProxyBone) rebaselineProxy(); dragUndo = plantDrag >= 0 ? null : snapshot(); return; } if (plantDrag >= 0) { plantDrag = -1; dragMark = null; gizmo.detach(); saveGaitCfg(); } else { if (dragUndo) { const before = dragUndo, after = snapshot(); history.push('правка позы', () => restore(before), () => restore(after)); dragUndo = null; } if (!wpnOverride && weaponGroups.includes(gizmo.object as THREE.Group)) saveGripBase(); } });   // правка оружия без галки → авто в БАЗУ pe_grip

const limitGizmo = makeLimitGizmo(); scene.add(limitGizmo.group);   // гизмо предела выбранного сустава (на манекене)
let showLimits = true;                                              // рисовать пределы выбранного сустава (дефолт вкл)
let clampFk = true;                                                 // FK-драг клэмпит кость к пределу сустава (дефолт вкл)
let human!: Humanoid;
let mode: 'fk' | 'ik' = 'ik';
// Перестроить гизмо предела под ВЫБРАННЫЙ сустав (FK-кость → rag-кость → эффективные лимиты). Дёшево — на выбор/правку.
let curLimitView: LimitView | null = null;
function updateLimitGizmo(): void {
  const nm = tab === 'anim' && showLimits && selected ? selected : null;
  curLimitView = nm ? limitViewForBone(nm) : null;
  limitGizmo.set(curLimitView);
}
// Поставить гизмо на сустав манекена: позиция сустава (мир) + ориентация РОДИТЕЛЬСКОЙ кости (лимиты заданы от родителя).
// + индикатор текущего положения кости в зоне (декомпозиция локального кватерниона в оси предела).
function placeLimitGizmo(): void {
  if (!limitGizmo.group.visible || !selected || !curLimitView) return;
  const b = human.bones.get(selected); if (!b) return;
  limitGizmo.place(b.getWorldPosition(V()), b.parent ? b.parent.getWorldQuaternion(Q()) : Q());
  const d = decomposeToLimit(b.quaternion, curLimitView);
  limitGizmo.mark(curLimitView, d.rP, d.rN, d.twist);
}
let hipsMode: 'translate' | 'rotate' = 'translate';
let bodyFollow = 0.45;

// ── Персонажи (реестр — общий с игрой, chars3d.ts) ──
function loadChars(): Char[] { try { const s = localStorage.getItem('pe_chars'); if (s) return JSON.parse(s) as Char[]; } catch { /* */ } return []; }
let customChars: Char[] = loadChars();
let persona: 'class' | 'monster' = 'class';                     // режим ростера: персонажи (классы) ↔ монстры
const allChars = (): Char[] => [...CLASS_CHARS, ...customChars, ...MONSTER_CHARS];   // для поиска curChar по id
const rosterChars = (): Char[] => persona === 'class' ? [...CLASS_CHARS, ...customChars] : MONSTER_CHARS;   // что показывать в выпадашке
let curCharId = CLASS_CHARS[0]!.id;
const curChar = (): Char => allChars().find((c) => c.id === curCharId) ?? CLASS_CHARS[0]!;
let weapon = curChar().weapon;

// ── Оружие (меши в руках) — общий модуль weapon3d.ts (редактор и игра рисуют одинаково) ──
let weaponGroups: THREE.Group[] = [];
function updateWeapon(): void {
  if (weaponGroups.some((g) => gizmo.object === g)) gizmo.detach();   // не держать гизмо на удаляемом оружии
  for (const g of weaponGroups) { g.parent?.remove(g); g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  // Атлас-режим: физ-призрак СКРЫТ (виден меш), поэтому оружие на нём было бы невидимо → крепим к манекену (меш с ним
  // совпадает, driveAsm ведёт корень) → оружие ложится на кисть меша. Иначе (без атласа) — на физ-призрак, как в игре.
  const wpnHost = atlasBS() ? human : (ghostHuman ?? human);
  weaponGroups = attachWeapons(wpnHost, weapon);                       // старт: на манекен/призрак (fallback); syncWeaponHost переносит на кисть атласа
  applyBaseGrip(weaponGroups, curCharId, weapon);                     // ЕДИНЫЙ базовый хват pe_grip → g.userData.baseRot/basePos (поверх weapon-type дефолта)
  seedGripBaseFromIdle();                                             // миграция: pe_grip пуст → сид из idle-хвата (не терять уже настроенное)
  lgripMark = null;                                                   // маркер хвата был ребёнком старого груп — пересоздастся из позы
}
/** Если базы хвата ещё нет в pe_grip — сидим её из idle-хвата (старые покадровые __wpnMain), чтобы не терять настроенное. */
function seedGripBaseFromIdle(): void {
  try {
    const c = JSON.parse(localStorage.getItem('pe_grip') || '{}') as Record<string, Record<string, unknown>>;
    if (c[curCharId]?.[weapon]) return;   // база уже есть
    const idle = editorContent.resolveUpper(weapon)?.pose; if (!idle) return;
    let any = false;
    weaponGroups.forEach((g, i) => { const rk = WPN_KEYS[i], pk = WPN_POS[i]; if (rk && idle[rk]) { g.rotation.set(idle[rk]![0], idle[rk]![1], idle[rk]![2]); any = true; } if (pk && idle[pk]) { g.position.set(idle[pk]![0], idle[pk]![1], idle[pk]![2]); any = true; } });
    if (any) saveGripBase();
  } catch { /* */ }
}
/** Сохранить ТЕКУЩИЙ хват (rotation/position групп оружия) в базу pe_grip[char][weapon] → применяется во всех позах без override. */
function saveGripBase(): void {
  try {
    const c = JSON.parse(localStorage.getItem('pe_grip') || '{}') as Record<string, Record<string, { main?: unknown; off?: unknown }>>;
    const slot = ((c[curCharId] ??= {})[weapon] ??= {}) as Record<string, { r: number[]; p: number[] }>;
    const KEY = ['main', 'off'];
    weaponGroups.forEach((g, i) => { const k = KEY[i]; if (!k) return; const e = g.rotation, q = g.position; slot[k] = { r: [+e.x.toFixed(3), +e.y.toFixed(3), +e.z.toFixed(3)], p: [+q.x.toFixed(2), +q.y.toFixed(2), +q.z.toFixed(2)] }; });
    localStorage.setItem('pe_grip', JSON.stringify(c)); savePoseKey('pe_grip');
    applyBaseGrip(weaponGroups, curCharId, weapon);   // база в userData обновлена → все позы без override берут её
  } catch { /* */ }
}
/** 2B: КАЖДЫЙ кадр переносим оружие на кисть ВИДИМОГО атлас-меша (asmSkin, физ-ведомый) — иначе оно на манекене и плавает
 *  относительно модели покадрово. `.add` сохраняет локаль (авторский хват), меняет мир. Нет атласа/не загружен → на призраке. */
const _wsA = new THREE.Vector3(), _wsF = new THREE.Vector3();
function syncWeaponHost(): void {
  for (const g of weaponGroups) {
    const hn = g.userData.handBone as string | undefined; if (!hn) continue;
    const fallback = (ghostHuman ?? human).bones.get(hn) ?? human.bones.get(hn);
    const atlasHand = modelsTab.handBone(hn);
    const target = atlasHand ?? fallback;
    if (target && g.parent !== target) target.add(g);
    // Компенсация масштаба: кисть атласа несёт импорт-скейл (ФБХ ~0.35×) → оружие мельчало. Держим размер как на манекене:
    // локаль-скейл = мир-скейл манекен-кисти / мир-скейл атлас-кисти (мир-размер оружия = как на физ-теле).
    if (atlasHand && fallback) {
      atlasHand.updateWorldMatrix(true, false); fallback.updateWorldMatrix(true, false);
      atlasHand.getWorldScale(_wsA); fallback.getWorldScale(_wsF);
      if (_wsA.x > 1e-6 && _wsA.y > 1e-6 && _wsA.z > 1e-6) g.scale.set(_wsF.x / _wsA.x, _wsF.y / _wsA.y, _wsF.z / _wsA.z);
    } else if (g.scale.x !== 1) g.scale.set(1, 1, 1);
  }
}

// ── FK-подсветка ──
let selected: string | null = null; let selMesh: THREE.Mesh | null = null; let selEmis = 0;
function highlight(m: THREE.Mesh | null): void {
  if (selMesh) (selMesh.material as THREE.MeshStandardMaterial).emissive.setHex(selEmis);
  selMesh = m; if (m) { const mat = m.material as THREE.MeshStandardMaterial; selEmis = mat.emissive.getHex(); mat.emissive.setHex(0x2e6cff); }
}

// ── IK-риг ──
interface Eff { root: string; mid: string; end: string; pole: THREE.Vector3; isFoot: boolean; pin: boolean; ik: boolean; target: THREE.Vector3; prev: THREE.Vector3; footQuat: THREE.Quaternion; handle: THREE.Mesh; poleHandle: THREE.Mesh }
const LIMB_OF: Record<string, string> = { LeftUpperArm: 'LH', LeftLowerArm: 'LH', LeftHand: 'LH', RightUpperArm: 'RH', RightLowerArm: 'RH', RightHand: 'RH', LeftUpperLeg: 'LF', LeftLowerLeg: 'LF', RightUpperLeg: 'RF', RightLowerLeg: 'RF' };
const mkHandle = (color: number, r: number, box = false): THREE.Mesh => { const m = new THREE.Mesh(box ? new THREE.BoxGeometry(r * 1.6, r * 1.6, r * 1.6) : new THREE.SphereGeometry(r, 12, 10), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 })); m.renderOrder = 999; scene.add(m); return m; };
const rig = {
  hipsPos: V(), hipsQuat: Q(), hipsHandle: mkHandle(0xf0c020, 3.4, true),
  eff: {
    LH: { root: 'LeftUpperArm', mid: 'LeftLowerArm', end: 'LeftHand', pole: new THREE.Vector3(0, -1, -0.4), isFoot: false, pin: false, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x4a8cff, 2.6), poleHandle: mkHandle(0xff8c3a, 2.0) },
    RH: { root: 'RightUpperArm', mid: 'RightLowerArm', end: 'RightHand', pole: new THREE.Vector3(0, -1, -0.4), isFoot: false, pin: false, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x4a8cff, 2.6), poleHandle: mkHandle(0xff8c3a, 2.0) },
    LF: { root: 'LeftUpperLeg', mid: 'LeftLowerLeg', end: 'LeftFoot', pole: new THREE.Vector3(0, 0, 1), isFoot: true, pin: true, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x46d07a, 2.6), poleHandle: mkHandle(0xff8c3a, 2.0) },
    RF: { root: 'RightUpperLeg', mid: 'RightLowerLeg', end: 'RightFoot', pole: new THREE.Vector3(0, 0, 1), isFoot: true, pin: true, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x46d07a, 2.6), poleHandle: mkHandle(0xff8c3a, 2.0) },
  } as Record<string, Eff>,
};
const effList = (): Eff[] => Object.values(rig.eff);
const _q = Q();
function aimBoneAt(bone: THREE.Object3D, aim: THREE.Vector3, t: THREE.Vector3): void {
  bone.updateMatrixWorld();
  const bp = bone.getWorldPosition(V());
  const pq = bone.parent!.getWorldQuaternion(_q).clone().invert();
  const desired = t.clone().sub(bp).normalize().applyQuaternion(pq);
  bone.quaternion.setFromUnitVectors(aim, desired); bone.updateMatrixWorld();
}
function solve2Bone(rootN: string, midN: string, endN: string, target: THREE.Vector3, pole: THREE.Vector3): void {
  const root = human.bones.get(rootN)!, mid = human.bones.get(midN)!, end = human.bones.get(endN)!;
  const aimRoot = mid.position.clone().normalize(), aimMid = end.position.clone().normalize();
  const L1 = mid.position.length(), L2 = end.position.length();
  root.updateMatrixWorld();
  const rp = root.getWorldPosition(V());
  const toT = target.clone().sub(rp);
  let d = toT.length(); d = clamp(d, Math.abs(L1 - L2) + 0.5, L1 + L2 - 0.5);
  const dir = toT.normalize();
  const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const bend = V().crossVectors(dir, pole); if (bend.lengthSq() < 1e-6) bend.set(0, 0, 1); else bend.normalize();
  const midPos = rp.clone().addScaledVector(dir.clone().applyAxisAngle(bend, a), L1);
  aimBoneAt(root, aimRoot, midPos); aimBoneAt(mid, aimMid, target.clone());
}
// Восстановить МИРОВУЮ ориентацию конца эффектора (кисть/стопа) после солва: solve2Bone целит плечо/предплечье
// минимальной дугой (`setFromUnitVectors`) → даёт ПРОИЗВОЛЬНУЮ скрутку, и кисть (с оружием) разворачивало. Держим
// захваченную ориентацию (footQuat) — как у стоп. Так drag руки в IK больше не «сбрасывает» углы и не крутит топор.
function setEndOrient(e: Eff): void { const end = human.bones.get(e.end)!; end.updateMatrixWorld(); const pInv = end.parent!.getWorldQuaternion(Q()).invert(); end.quaternion.copy(pInv.multiply(e.footQuat)); end.updateMatrixWorld(); }
// Захватить цель И полюс (направление изгиба локтя/колена) из ТЕКУЩЕЙ позы кости —
// чтобы возврат в IK воспроизводил позу, а не сбрасывал ручную докрутку сустава.
function syncEff(e: Eff): void {
  const root = human.bones.get(e.root)!, mid = human.bones.get(e.mid)!, end = human.bones.get(e.end)!;
  root.updateMatrixWorld(); mid.updateMatrixWorld(); end.updateMatrixWorld();
  const rp = root.getWorldPosition(V()), mp = mid.getWorldPosition(V()), ep = end.getWorldPosition(V());
  e.target.copy(ep); e.prev.copy(ep);
  const dir = ep.clone().sub(rp);
  if (dir.lengthSq() > 1e-6) { const perp = mp.clone().sub(rp).sub(dir.clone().multiplyScalar(mp.clone().sub(rp).dot(dir) / dir.lengthSq())); if (perp.lengthSq() > 1) e.pole.copy(perp.normalize()); }   // прямая рука → полюс не трогаем
  e.footQuat.copy(end.getWorldQuaternion(Q()));   // ориентация КОНЦА (кисть/стопа) — восстановим после солва (иначе IK крутит скрутку)
}
function captureRig(): void {
  const hips = human.bones.get('Hips')!; rig.hipsPos.copy(hips.position); rig.hipsQuat.copy(hips.quaternion);
  human.root.updateMatrixWorld(true);
  for (const e of effList()) syncEff(e);
}
// Ф4: FULL-BODY IK. Пересобирается вместе с манекеном (смена персонажа/пальцев/пропорций).
let fbik: FbikRig | null = null;
let fbikFor: Humanoid | null = null;
let fbikOn = true;   // выкл → старый двухкостный режим (сравнение/аварийный фолбэк)
function getFbik(): FbikRig {
  if (!fbik || fbikFor !== human) { fbik = makeFullBodyIk(human, { limits: limitViewForBone }); fbikFor = human; }
  return fbik;
}
/**
 * Решить позу под текущее состояние контроллеров.
 *
 * Раньше здесь гнались ЧЕТЫРЕ НЕЗАВИСИМЫЕ двухкостные цепи, а «пин» в решение не входил вообще
 * (он только фильтровал `moveHips`) — отсюда и «кручу таз, а ноги едут за ним».
 * Теперь: якорь = то, что тянет пользователь, цели = пины + перетаскиваемый эффектор,
 * решается всё тело сразу и с учётом пределов суставов (они же задают плоскость сгиба колена/локтя).
 */
function solveRig(): void {
  const hips = human.hips;
  hips.position.copy(rig.hipsPos); hips.quaternion.copy(rig.hipsQuat); hips.updateMatrixWorld(true);
  if (!fbikOn) {   // фолбэк: старые независимые цепи
    for (const e of effList()) { if (e.ik) { solve2Bone(e.root, e.mid, e.end, e.target, e.pole); setEndOrient(e); } else e.target.copy(human.bones.get(e.end)!.getWorldPosition(V())); }
    return;
  }
  const targets = new Map<string, THREE.Vector3>();
  for (const k in rig.eff) {
    const e = rig.eff[k]!;
    if (e.pin || k === activeKey) targets.set(e.end, e.target.clone());   // пин держит, перетаскиваемый ведёт
  }
  const anchorBone = (activeKey && activeKey !== 'hips') ? rig.eff[activeKey]!.end : 'Hips';
  const anchorPos = anchorBone === 'Hips' ? human.hips.getWorldPosition(V()) : rig.eff[activeKey!]!.target.clone();
  if (targets.size) getFbik().solve(targets, { bone: anchorBone, pos: anchorPos });
  // Стопы/кисти без цели едут за телом — подтягиваем их ручки к фактическому положению костей.
  human.root.updateMatrixWorld(true);
  for (const k in rig.eff) {
    const e = rig.eff[k]!;
    if (!e.pin && k !== activeKey) e.target.copy(human.bones.get(e.end)!.getWorldPosition(V()));
    if (e.isFoot) e.footQuat.copy(human.bones.get(e.end)!.getWorldQuaternion(Q()));
  }
  rig.hipsPos.copy(human.hips.position);   // солвер мог сдвинуть таз (пины его ограничивают)
}
function moveHips(delta: THREE.Vector3, except: Eff | null): void { rig.hipsPos.add(delta); for (const e of effList()) if (!e.isFoot && !e.pin && e !== except) e.target.add(delta); }

// ── Пикинг ──
const ray = new THREE.Raycaster(); let activeKey: string | null = null; let activePole: string | null = null;
canvas.addEventListener('pointerdown', (ev) => {
  if (gizmo.dragging) return;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
  if (editPlant && locoOn && locoGait) {                     // режим правки: тянем АВТОРСКИЕ маркеры (плант/обвод), кости не трогаем
    const hit = ray.intersectObjects(authMarks.map((a) => a.mesh), false)[0];
    const am = hit && authMarks.find((a) => a.mesh === hit.object);
    if (am) {
      dragMark = am; plantDrag = 0;
      plantEditDir = plantDirSel; plantEditRun = plantSpeedRun;   // заморозить активную ячейку на время драга
      plantGrab.copy(am.mesh.position);
      const cell = activeCell();
      const base = am.kind === 'plant' ? (am.foot === 0 ? cell.l : cell.r) : (am.foot === 0 ? cell.lVia! : cell.rVia!)[am.k]!;
      plantOff0 = [base[0], base[1]];
      gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(am.mesh);
    }
    return;
  }
  if (mode === 'ik') {
    const list: THREE.Object3D[] = [rig.hipsHandle];
    for (const e of effList()) list.push(e.handle, e.poleHandle);
    const hit = ray.intersectObjects(list, false)[0];
    if (hit) {
      activeKey = null; activePole = null;
      if (hit.object === rig.hipsHandle) { activeKey = 'hips'; gizmo.setSpace('world'); gizmo.setMode(hipsMode); if (hipsMode === 'rotate') rig.hipsHandle.quaternion.copy(rig.hipsQuat); gizmo.attach(rig.hipsHandle); }
      else {
        const endK = Object.keys(rig.eff).find((k) => rig.eff[k]!.handle === hit.object);
        const polK = Object.keys(rig.eff).find((k) => rig.eff[k]!.poleHandle === hit.object);
        if (endK) { const e = rig.eff[endK]!; e.ik = true; syncEff(e); refreshLimbs(); activeKey = endK; gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(e.handle); }
        else if (polK) { const e = rig.eff[polK]!; e.ik = true; syncEff(e); refreshLimbs(); activePole = polK; gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(e.poleHandle); }
      }
      return;
    }
    gizmo.detach(); activeKey = null; activePole = null; return;
  }
  // FK: кости + меши оружия (оружие — вращение вокруг хвата)
  const meshes: THREE.Mesh[] = [...human.meshes];
  for (const g of weaponGroups) g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const hit = ray.intersectObjects(meshes, false)[0];
  if (hit) {
    const obj = hit.object as THREE.Mesh;
    if (obj.userData.bone) { const nm = obj.userData.bone as string; selected = nm; highlight(obj); attachBoneGizmo(nm); refreshPose(); }
    else { let g: THREE.Object3D | null = obj; while (g && !(weaponGroups as THREE.Object3D[]).includes(g)) g = g.parent; if (g) { fkProxyBone = null; selected = null; highlight(null); gizmo.setSpace('local'); gizmo.setMode('rotate'); gizmo.attach(g); refreshPose(); } }
  }
  else { fkProxyBone = null; gizmo.detach(); highlight(null); selected = null; refreshPose(); }
});
// Вкладка «Повороты»: прицел = точка пола под курсором (как курсор в игре). Только читаем позицию, орбиту не трогаем.
canvas.addEventListener('pointermove', (ev) => {
  if (tab !== 'turn') return;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObject(floor, false)[0];
  if (hit) turnAim = Math.atan2(hit.point.x, hit.point.z);   // yaw к точке: forward=+Z → atan2(x,z)
});
gizmo.addEventListener('objectChange', () => {
  if (dragMark) {                                            // тянем авторский маркер (плант/обвод): мировая дельта → body-local (fwd,lat)
    const d = dragMark.mesh.position.clone().sub(plantGrab);
    const s = Math.sin(gaitYaw), c = Math.cos(gaitYaw);
    const cell = activeCell();
    const dst = dragMark.kind === 'plant' ? (dragMark.foot === 0 ? cell.l : cell.r) : (dragMark.foot === 0 ? cell.lVia! : cell.rVia!)[dragMark.k]!;
    dst[0] = plantOff0[0] + (d.x * s + d.z * c);              // fwd вдоль facing
    dst[1] = plantOff0[1] + (d.x * c - d.z * s);              // lat вправо
    return;
  }
  if (mode === 'fk') {
    if (gizmo.object === boneProxy && fkProxyBone) {           // прокси-вращение ПО ОСЯМ СУСТАВА: дельта прокси (мир) → лок. кость → клэмп
      const nm = fkProxyBone; const b = human.bones.get(nm);
      if (b) {
        _dq.copy(boneProxy.quaternion).multiply(_pBaseInv);     // deltaWorld = proxyNow · pBase⁻¹
        _nw.copy(_dq).multiply(_bBase);                         // newBoneWorld = deltaWorld · boneWorld0
        b.quaternion.copy(_parInv).multiply(_nw);               // newBoneLocal = parent⁻¹ · newBoneWorld
        if (clampFk) { const view = limitViewForBone(nm); if (view) b.quaternion.copy(clampLocalToLimit(b.quaternion, view)); }
        const lk = LIMB_OF[nm]; if (lk) { rig.eff[lk]!.ik = false; refreshLimbs(); } if (nm === 'Hips') rig.hipsQuat.copy(b.quaternion); const fk = nm === 'LeftFoot' ? 'LF' : nm === 'RightFoot' ? 'RF' : null; if (fk) rig.eff[fk]!.footQuat.copy(b.getWorldQuaternion(Q()));
      }
    }
    return;   // оружие (gizmo.object = группа) вращается гизмо напрямую — доп. обработки не нужно
  }
  if (mode !== 'ik' || (!activeKey && !activePole)) return;
  if (activePole) { const e = rig.eff[activePole]!; const rp = human.bones.get(e.root)!.getWorldPosition(V()); const pv = e.poleHandle.position.clone().sub(rp); if (pv.lengthSq() > 1e-6) e.pole.copy(pv.normalize()); return; }
  if (activeKey === 'hips') { if (hipsMode === 'translate') moveHips(rig.hipsHandle.position.clone().sub(rig.hipsPos), null); else rig.hipsQuat.copy(rig.hipsHandle.quaternion); }
  else { const e = rig.eff[activeKey!]!; const nt = e.handle.position.clone(); if (!e.isFoot && bodyFollow > 0) moveHips(nt.clone().sub(e.prev).multiplyScalar(bodyFollow), e); e.target.copy(nt); e.prev.copy(nt); }
});

// ── Позы / клипы / undo ── (типы, blendTwo/clipPoseAt/migrateClip — из clipModel.ts)
function loadLib(): Clip[] { try { const s = localStorage.getItem('pe_clips'); if (!s) return []; return (JSON.parse(s) as unknown[]).map(migrateClip); } catch { return []; } }
function saveLib(): void { try { localStorage.setItem('pe_clips', JSON.stringify(library)); savePoseKey('pe_clips'); } catch { /* */ } }
let library: Clip[] = loadLib();
let clipBuf: Clip | null = null;      // буфер «копировать позу» — переживает переключение оружия/персонажа (вставка в другое оружие)
let clipBufWasAtk = false;            // был ли исходник в буфере помечен ударом (перенести метку при вставке)
let clipIdx = 0, frameIdx = 0;
const clipsHere = (): Clip[] => library.filter((c) => c.character === curCharId && c.weapon === weapon);
const curClip = (): Clip | null => clipsHere()[clipIdx] ?? null;
function sortKeys(c: Clip): void { const cur = c.keys[frameIdx]; c.keys.sort((a, b) => a.t - b.t); if (cur) frameIdx = c.keys.indexOf(cur); }
// Поза оружия относительно хвата пишется спец-ключами (не кости): поворот __wpn{Main|Off}, позиция __wpn{Main|Off}P.
// ── Двуручный хват: маркер точки, где ЛЕВАЯ кисть держит оружие (ребёнок груп[0]); ключи позы __lgripP/__lgripR (локаль оружия) ──
let lgripMark: THREE.Mesh | null = null;
function ensureLgripMark(): THREE.Mesh | null {
  const wg = weaponGroups[0]; if (!wg) return null;
  if (!lgripMark || lgripMark.parent !== wg) {
    if (lgripMark && gizmo.object === lgripMark) gizmo.detach();
    lgripMark = new THREE.Mesh(new THREE.SphereGeometry(1.7, 12, 8), new THREE.MeshBasicMaterial({ color: 0x33ddff, transparent: true, opacity: 0.55, depthTest: false }));
    lgripMark.renderOrder = 998; lgripMark.name = '__lgrip'; wg.add(lgripMark);
  }
  return lgripMark;
}
const hasLgrip = (): boolean => { const k = curClip()?.keys[frameIdx]?.pose; return !!k?.['__lgripP']; };
/** Живой превью: левая кисть IK-ом держит маркер (Анимация; в Бег tab это делает gaitToHumanoid). */
function applyLgripPreview(): void {
  if (!lgripMark || !lgripMark.visible || !weaponGroups[0]) return;
  human.root.updateMatrixWorld(true);
  const target = lgripMark.getWorldPosition(V()), q = lgripMark.getWorldQuaternion(Q());
  const sh = human.bones.get('LeftUpperArm')!.getWorldPosition(V()), toEl = human.bones.get('LeftLowerArm')!.getWorldPosition(V()).sub(sh);
  const line = target.clone().sub(sh); toEl.addScaledVector(line, -(toEl.dot(line) / Math.max(1e-6, line.lengthSq())));
  const pole = toEl.lengthSq() > 0.5 ? toEl.normalize() : V().set(0, -1, -0.4);
  solveTwoBoneIK(human, 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', target, q, pole);
}
function readPoseFull(): Pose {
  const p = human.readPose();
  delete p['LeftBreast']; delete p['RightBreast'];           // jiggle груди — рантайм, не пишем в позу

  if (wpnOverride) {   // хват пишем в позу ТОЛЬКО при галке «своя правка (кадр)»; иначе поза берёт БАЗУ pe_grip (единый хват)
    p['__wpnOverride'] = [1, 0, 0];
    weaponGroups.forEach((g, i) => {
      const rk = WPN_KEYS[i], pk = WPN_POS[i];
      if (rk) { const e = g.rotation; p[rk] = [+e.x.toFixed(3), +e.y.toFixed(3), +e.z.toFixed(3)]; }
      if (pk) { const q = g.position; p[pk] = [+q.x.toFixed(2), +q.y.toFixed(2), +q.z.toFixed(2)]; }
    });
  }
  if (lgripMark && lgripMark.parent === weaponGroups[0]) {   // точка хвата левой (локаль оружия) — если включена
    const lp = lgripMark.position, lr = lgripMark.rotation;
    p['__lgripP'] = [+lp.x.toFixed(2), +lp.y.toFixed(2), +lp.z.toFixed(2)];
    p['__lgripR'] = [+lr.x.toFixed(3), +lr.y.toFixed(3), +lr.z.toFixed(3)];
  }
  // Фаланги попадают в кадр ТОЛЬКО если отличаются от текущего хвата: иначе каждый кадр запомнил бы
  // дефолтный хват и смена оружия перестала бы на нём работать (весь смысл отдельного канала).
  { const g = curGripPose();
    for (const nm in p) if (isHandBone(nm)) { const gv = g[nm]; const v = p[nm]!;
      if (gv && Math.abs(gv[0] - v[0]) < 1e-3 && Math.abs(gv[1] - v[1]) < 1e-3 && Math.abs(gv[2] - v[2]) < 1e-3) delete p[nm]; } }
  { const hp = human.hips.position; p['__hipsP'] = [+hp.x.toFixed(2), +hp.y.toFixed(2), +hp.z.toFixed(2)]; }   // ПОЛНЫЙ авторский офсет таза (Root ≠ таз): Y = база стойки (standY), X/Z = мах/сдвиг таза В МЕСТЕ. Раньше писали только Y — X/Z молча терялись
  return p;
}
let wpnOverride = false;   // галка «хват: своя правка (кадр)» текущего кадра (иначе — БАЗА pe_grip, единый хват во всех позах)
function applyWeaponPose(p: Pose): void {
  wpnOverride = !!p['__wpnOverride'];   // синк галки с кадром
  weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    const br = g.userData.baseRot as THREE.Euler | undefined, bp = g.userData.basePos as THREE.Vector3 | undefined;
    if (wpnOverride && rk && p[rk]) g.rotation.set(p[rk]![0], p[rk]![1], p[rk]![2]); else if (br) g.rotation.copy(br);   // override → своя; иначе база
    if (wpnOverride && pk && p[pk]) g.position.set(p[pk]![0], p[pk]![1], p[pk]![2]); else if (bp) g.position.copy(bp);
  });
  if (p['__lgripP']) { const m = ensureLgripMark(); if (m) { const lp = p['__lgripP']!, lr = p['__lgripR'] ?? [0, 0, 0]; m.position.set(lp[0], lp[1], lp[2]); m.rotation.set(lr[0], lr[1], lr[2]); m.visible = true; } }
  else if (lgripMark) lgripMark.visible = false;             // нет хвата в кадре → маркер скрыт (обычная FK-левая рука)
}
function applyPose(p: Pose): void { human.reset(); for (const nm in p) { if (nm[0] === '_') continue; const b = human.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); } { const hp = p['__hipsP']; if (hp) human.hips.position.set(hp[0], hp[1], hp[2]); } applyGripOver(p); applyWeaponPose(p); applyFramePhys(p); }   // восстановить авторский офсет таза (иначе после бега остаётся gait-standY → провал скелета)
// Интерп ПОВОРОТОВ кадров — КВАТЕРНИОННЫЙ SLERP (истинная кратчайшая дуга, без gimbal). Покомпонентный лерп эйлеров
// (даже с обёрткой углов в [-π,π]) на многоосевых кадрах даёт «прокрутку» руки (эйлеры далеки, хотя поворот близок).
// slerp учитывает двойное покрытие (q и −q = один поворот) → всегда короткий путь. lerpAng оставлен для скаляров/маркера.
function lerpPose(a: Pose, b: Pose, t: number): void {
  human.reset();
  for (const nm of human.boneNames) { const pa = a[nm] ?? [0, 0, 0], pb = b[nm] ?? [0, 0, 0]; slerpEuler(human.bones.get(nm)!.quaternion, pa, pb, t); }
  weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    if (rk) { const pa = a[rk], pb = b[rk]; if (pa && pb) slerpEuler(g.quaternion, pa, pb, t); else if (pa) g.rotation.set(pa[0], pa[1], pa[2]); }
    if (pk) { const pa = a[pk], pb = b[pk]; if (pa && pb) g.position.set(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t); else if (pa) g.position.set(pa[0], pa[1], pa[2]); }
  });
  const ip = (k: string, d: number): number => { const va = a[k]?.[0] ?? d, vb = b[k]?.[0] ?? va; return va + (vb - va) * t; };
  PHYS.match = ip('__match', physMatchBase); PHYS.pinKp = ip('__pinKp', DEF_PINKP);   // per-кадр физ скользит в проигрывании
  if (a['__hipsP'] || b['__hipsP']) {   // офсет таза скользит по кадрам (иначе провал/рывок при скрабе клипа)
    const hp = human.hips.position, ipn = (k: string, i: number, d: number): number => { const va = a[k]?.[i] ?? d, vb = b[k]?.[i] ?? va; return va + (vb - va) * t; };
    hp.set(ipn('__hipsP', 0, hp.x), ipn('__hipsP', 1, hp.y), ipn('__hipsP', 2, hp.z));
  }
  if (a['__lgripP'] || b['__lgripP']) { const m = ensureLgripMark(); if (m) {   // точка хвата скользит по кадрам (перехват)
    const pa = a['__lgripP'] ?? b['__lgripP']!, pb = b['__lgripP'] ?? pa, ra = a['__lgripR'] ?? [0, 0, 0], rb = b['__lgripR'] ?? ra;
    m.position.set(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t);
    m.rotation.set(lerpAng(ra[0], rb[0], t), lerpAng(ra[1], rb[1], t), lerpAng(ra[2], rb[2], t)); m.visible = true;
  } } else if (lgripMark) lgripMark.visible = false;
}
function mirrorLR(): void {   // «подтянуть правую сторону под левую» (общая чистая mirrorSide из clipModel)
  const m = mirrorSide(human.readPose(), 'Left');
  for (const nm of human.boneNames) { if (!nm.startsWith('Right')) continue; const b = human.bones.get(nm); const s = m[nm]; if (b && s) b.rotation.set(s[0], s[1], s[2]); }
  if (mode === 'ik') captureRig();
}

// ── Локомоция: 2D бленд-дерево (Unity-стиль VelX/VelZ) ──
interface LocoNode { character: string; weapon: string; clip: string; vx: number; vz: number }
function loadLoco(): LocoNode[] { try { const s = localStorage.getItem('pe_loco'); return s ? JSON.parse(s) as LocoNode[] : []; } catch { return []; } }
let locoNodes: LocoNode[] = loadLoco();
function saveLoco(): void { try { localStorage.setItem('pe_loco', JSON.stringify(locoNodes)); savePoseKey('pe_loco'); } catch { /* */ } }
const locoHere = (): LocoNode[] => locoNodes.filter((n) => n.character === curCharId && n.weapon === weapon);
function locoWeights(nodes: LocoNode[], vx: number, vz: number): number[] {   // веса = обратный квадрат расстояния (норм.)
  const w = nodes.map((n) => 1 / ((n.vx - vx) ** 2 + (n.vz - vz) ** 2 + 0.03));
  const s = w.reduce((a, b) => a + b, 0) || 1; return w.map((x) => x / s);
}
function blendLocoPose(nodes: LocoNode[], weights: number[], phase: number): Pose {   // Σ вес·поза_i(фаза)
  const out: Pose = {};
  nodes.forEach((n, idx) => {
    const wt = weights[idx]!; if (wt < 0.002) return;
    const clip = library.find((c) => c.name === n.clip && c.character === n.character && c.weapon === n.weapon); if (!clip) return;
    const p = clipPoseAt(clip, phase);
    for (const k in p) { const cur = out[k] ?? [0, 0, 0]; out[k] = [cur[0] + p[k]![0] * wt, cur[1] + p[k]![1] * wt, cur[2] + p[k]![2] * wt]; }
  });
  return out;
}
type BoneOv = Record<string, [number, number, number]>;
/** Болванка цикла бега (стартовая, редактируемая): чередование ног/рук + наклон. 5 кадров (0..0.8), луп. */
function makeRunCycle(): Keyframe[] {
  const saved = readPoseFull(); human.reset(); const base = readPoseFull(); applyPose(saved);   // чистая T-база
  const K = (t: number, ov: BoneOv): Keyframe => { const p: Pose = {}; for (const k in base) p[k] = base[k]!.slice() as [number, number, number]; for (const k in ov) p[k] = ov[k]!; return { pose: p, t }; };
  const dL = -1.35, dR = 1.35;   // руки вниз (z)
  const k0: BoneOv = { LeftUpperLeg: [-0.5, 0, 0], LeftLowerLeg: [0.15, 0, 0], RightUpperLeg: [0.35, 0, 0], RightLowerLeg: [0.7, 0, 0], LeftUpperArm: [0.4, 0, dL], RightUpperArm: [-0.5, 0, dR], LeftLowerArm: [0, -0.7, 0], RightLowerArm: [0, 0.7, 0], Spine: [0.15, 0, 0] };
  const k1: BoneOv = { LeftUpperLeg: [0.2, 0, 0], LeftLowerLeg: [0.25, 0, 0], RightUpperLeg: [-0.1, 0, 0], RightLowerLeg: [1.1, 0, 0], LeftUpperArm: [0, 0, dL], RightUpperArm: [0, 0, dR], LeftLowerArm: [0, -0.6, 0], RightLowerArm: [0, 0.6, 0], Spine: [0.15, 0, 0] };
  const mir = (o: BoneOv): BoneOv => { const m: BoneOv = {}; for (const key in o) { const rk = key.startsWith('Left') ? 'Right' + key.slice(4) : key.startsWith('Right') ? 'Left' + key.slice(5) : key; const v = o[key]!; m[rk] = [v[0], -v[1], -v[2]]; } return m; };
  return [K(0, k0), K(0.2, k1), K(0.4, mir(k0)), K(0.6, mir(k1)), K(0.8, k0)];
}

interface State { pose: Pose; hips: { p: [number, number, number]; q: [number, number, number, number] }; eff: Record<string, { t: [number, number, number]; fq: [number, number, number, number]; pl: [number, number, number]; ik: boolean; pin: boolean }> }
function snapshot(): State {
  const eff: State['eff'] = {};
  for (const k in rig.eff) { const e = rig.eff[k]!; eff[k] = { t: e.target.toArray() as [number, number, number], fq: e.footQuat.toArray() as [number, number, number, number], pl: e.pole.toArray() as [number, number, number], ik: e.ik, pin: e.pin }; }
  return { pose: readPoseFull(), hips: { p: rig.hipsPos.toArray() as [number, number, number], q: rig.hipsQuat.toArray() as [number, number, number, number] }, eff };
}
function restore(s: State): void {
  applyPose(s.pose); rig.hipsPos.fromArray(s.hips.p); rig.hipsQuat.fromArray(s.hips.q);
  for (const k in s.eff) { const e = rig.eff[k]; const d = s.eff[k]!; if (e) { e.target.fromArray(d.t); e.footQuat.fromArray(d.fq); if (d.pl) e.pole.fromArray(d.pl); e.ik = d.ik; e.pin = d.pin; } }
  refreshLimbs();
}
const history = makeHistory(100);
// Два уровня снимка в ОДНОЙ истории (Ctrl+Z идёт по ним единым порядком):
//  • поза — дёшево, на каждую правку кости/эффектора;
//  • библиотека — на структурные операции (кадр добавить/удалить/сдвинуть, клип создать/удалить/вставить,
//    импорт, бейк), которые раньше были неоткатны ВООБЩЕ. Снимок = JSON библиотеки + позиция курсора клип/кадр.
interface LibState { lib: string; clipIdx: number; frameIdx: number }
const libSnap = (): LibState => ({ lib: JSON.stringify(library), clipIdx, frameIdx });
function libRestore(s: LibState): void {
  library = (JSON.parse(s.lib) as unknown[]).map(migrateClip);
  clipIdx = s.clipIdx; frameIdx = s.frameIdx;
  saveLib();
  const c = curClip(); const k = c?.keys[frameIdx]; if (k) applyPose(k.pose);
  if (mode === 'ik') captureRig();
  refreshAll();
}
/** Правка ПОЗЫ (кости/эффекторы/оружие) — записать «до/после» в историю. */
const histPose = (label: string, act: () => void): void => history.run(label, snapshot, restore, act);
/** СТРУКТУРНАЯ правка (кадры/клипы/библиотека) — записать «до/после» в историю. */
const histLib = (label: string, act: () => void): void => history.run(label, libSnap, libRestore, act);
// Ф5: виды камеры и фокус — без них каждый ракурс крутился мышью вручную
function camView(dir: [number, number, number]): void {
  const t = orbit.target.clone();
  const d = camera.position.distanceTo(t) || 150;
  camera.position.set(t.x + dir[0] * d, t.y + dir[1] * d, t.z + dir[2] * d);
  camera.lookAt(t); orbit.update();
}
function camFocus(obj?: THREE.Object3D | null): void {
  const o = obj ?? (selected ? human.bones.get(selected) : null) ?? human.hips;
  const p = o.getWorldPosition(V());
  const off = camera.position.clone().sub(orbit.target);
  orbit.target.copy(p); camera.position.copy(p).add(off); orbit.update();
}
addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLElement | null;
  if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;   // не перехватываем набор текста
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case '1': camView([0, 0, 1]); break;                      // спереди
    case '3': camView([1, 0, 0]); break;                      // сбоку
    case '7': camView([0, 1, 0.001]); break;                  // сверху
    case 'f': case 'F': case 'а': case 'А': camFocus(); break;   // фокус на выбранной кости
    case '.': camFocus(human.hips); break;
    case 'w': case 'W': case 'ц': case 'Ц': gizmo.setMode('translate'); break;
    case 'e': case 'E': case 'у': case 'У': gizmo.setMode('rotate'); break;
    case 's': case 'S': case 'ы': case 'Ы': snapOn = !snapOn; applySnap(); break;
    default: return;
  }
  e.preventDefault();
});
addEventListener('keydown', (e) => { if (e.key === 'Shift') applySnap(true); });
addEventListener('keyup', (e) => { if (e.key === 'Shift') applySnap(); });
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) history.redo(); else history.undo(); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); history.redo(); } });

// ── Физ-настройки per-персонаж (pe_phys): вес совпадения рендера с манекеном (RB2) — редактор пишет, игра читает. ──
const DEF_PINKP = PHYS.pinKp;   // дефолт жёсткости пинов (фолбэк для кадров без __pinKp)
let physMatchBase = DEFAULT_MATCH;   // база match персонажа (pe_phys) — фолбэк для кадров БЕЗ __match (и для покоя/бега в игре); дефолт = игровой (DEFAULT_MATCH)
let physFootLift = 0;   // подъём стопы персонажа (pe_phys.footLift) — ставится на human/ghostHuml после сборки; standY+заземление подошвы меша на пол
function loadPhys(id: string): void { try { const c = JSON.parse(localStorage.getItem('pe_phys') || '{}') as Record<string, { match?: number; footLift?: number }>; physMatchBase = c[id]?.match ?? DEFAULT_MATCH; physFootLift = c[id]?.footLift ?? 0; } catch { physMatchBase = DEFAULT_MATCH; physFootLift = 0; } PHYS.match = physMatchBase; PHYS.pinKp = DEF_PINKP; }
// per-кадр физ-настройки match/pinKp хранятся в позе кадра (__match/__pinKp = [v,0,0]); интерполируются как обычные ключи позы.
// applyFramePhys: поза кадра → PHYS (для превью-физики и ползунков). Нет ключа → база персонажа / дефолт.
function applyFramePhys(p: Pose): void { PHYS.match = p['__match'] ? p['__match']![0] : physMatchBase; PHYS.pinKp = p['__pinKp'] ? p['__pinKp']![0] : DEF_PINKP; }
// writeFramePhys: «зафиксировать» текущие ползунки match/pinKp в ТЕКУЩИЙ кадр. Раз тронул — заполняем ВСЕ кадры (база/дефолт),
// иначе union-лерп (blendTwo) между кадром с ключом и без тянет значение к 0 (лимп-пины / нулевой match) на соседнем сегменте.
function writeFramePhys(): void {
  const c = curClip(); const kk = c?.keys[frameIdx]; if (!c || !kk) return;
  for (const k of c.keys) { if (!k.pose['__match']) k.pose['__match'] = [+physMatchBase.toFixed(3), 0, 0]; if (!k.pose['__pinKp']) k.pose['__pinKp'] = [DEF_PINKP, 0, 0]; }
  kk.pose['__match'] = [+PHYS.match.toFixed(3), 0, 0]; kk.pose['__pinKp'] = [Math.round(PHYS.pinKp), 0, 0];
  saveLib();
}
// Подъём стопы per-персонаж → pe_phys[char].footLift (та же секция, что RB2-match; читает игра loadFootLift → редактор ≡ игра).
function saveFootLift(): void {
  try {
    const c = JSON.parse(localStorage.getItem('pe_phys') || '{}') as Record<string, { match?: number; footLift?: number }>;
    (c[curCharId] ??= {}).footLift = +physFootLift.toFixed(3);
    localStorage.setItem('pe_phys', JSON.stringify(c)); savePoseKey('pe_phys');
  } catch { /* офлайн — норм */ }
}
// ── Вес подмешивания ЩИТА per-(персонаж, оружие) (pe_shield): поза щита наслаивается на позу оружия с этим весом. ──
// Хранилище: { [char]: { mix?: базовый; perWeapon?: {[weaponKey]: number} } }. Старый {char:{mix}} читается как база-фолбэк.
type ShieldCfg = { mix?: number; perWeapon?: Record<string, number> };
let shieldCfgAll: Record<string, ShieldCfg> = {};
function loadShieldMix(_id: string): void { try { shieldCfgAll = JSON.parse(localStorage.getItem('pe_shield') || '{}') as Record<string, ShieldCfg>; } catch { shieldCfgAll = {}; } }
const shieldMixFor = (wk: string): number => { const c = shieldCfgAll[curCharId]; return c?.perWeapon?.[wk] ?? c?.mix ?? 0.85; };   // per-оружие → база → дефолт
function setShieldMix(wk: string, v: number): void { const c = (shieldCfgAll[curCharId] ??= {}); if (wk.endsWith('+shield')) (c.perWeapon ??= {})[wk] = v; else c.mix = v; }   // '+shield'-ключ → per-оружие, иначе база
function saveShield(): void { try { localStorage.setItem('pe_shield', JSON.stringify(shieldCfgAll)); savePoseKey('pe_shield'); } catch { /* */ } }

// ── Персонаж: пересборка ──
/** Пер-костные пропорции загруженного атласа (ФБХ). Редакторные скелеты (манекен/призрак/онион) СТРОЯТСЯ ими →
 *  совпадают с мешем 1:1. Нет атласа → undefined (база, как раньше; классы/монстры без атласа не трогаем). */
function atlasBS(): BoneScale | undefined { return modelsTab.boneScale(); }
function atlasOff(): Record<string, number[]> | undefined { return modelsTab.boneOffsets(); }   // полные rest-офсеты ФБХ (приоритет над boneScale)
// ── Ф8: МОРФ ТЕЛА — СВОЙСТВО ПЕРСОНАЖА, НЕ АНИМАЦИИ (инвариант Ф1.6) ──
// Вариация персонажа = ТОТ ЖЕ меш + набор чисел. Меш на сервере один, персонажей на нём сколько угодно.
let morphCfg: Record<string, BodyMorph> = (() => { try { return (JSON.parse(localStorage.getItem('pe_morph') || '{}') as Record<string, BodyMorph>); } catch { return {}; } })();
let morphRanges: Record<string, MorphRange> = (() => { try { return (JSON.parse(localStorage.getItem('pe_morph_range') || '{}') as Record<string, MorphRange>); } catch { return {}; } })();
let morphPinned = new Set<string>();
const curMorph = (): BodyMorph => (morphCfg[curCharId] ??= {});
function saveMorph(): void {
  try { localStorage.setItem('pe_morph', JSON.stringify(morphCfg)); savePoseKey('pe_morph'); } catch { /* */ }
  try { localStorage.setItem('pe_morph_range', JSON.stringify(morphRanges)); savePoseKey('pe_morph_range'); } catch { /* */ }
}
function atlasProfile(): BodyProfile | undefined {
  const base = modelsTab.profile();
  const m = curMorph();
  const mp = morphToProfile(m);
  if (!base) return mp;
  return { height: (base.height ?? 1) * (mp.height ?? 1), arm: (base.arm ?? 1) * (mp.arm ?? 1), leg: (base.leg ?? 1) * (mp.leg ?? 1), torso: (base.torso ?? 1) * (mp.torso ?? 1), girth: (base.girth ?? 1) * (mp.girth ?? 1) };
}
/** Пропорции модели × морф персонажа (перемножаются). */
/** Толщина: ручные слайдеры персонажа × морф (обхваты по регионам). */
function morphBuild(c: Char): BuildScale {
  const b = morphToBuild(curMorph());
  return { arm: (c.build.arm ?? 1) * (b.arm ?? 1), leg: (c.build.leg ?? 1) * (b.leg ?? 1), torso: (c.build.torso ?? 1) * (b.torso ?? 1), head: (c.build.head ?? 1) * (b.head ?? 1) };
}
function morphBoneScale(): BoneScale | undefined {
  const merged = mergeBoneScale(atlasBS(), morphToBoneScale(curMorph()));
  return Object.keys(merged).length ? merged : undefined;
}
// Пальцы строим только когда они есть у ЗАГРУЖЕННОЙ модели либо юзер включил их руками:
// +30 групп на КАЖДЫЙ гуманоид (манекен + призрак + 2 ониона) без нужды — пустая цена.
let fingersForced = false;
let limitPresetId = 'human';
// ── Ф7: БИБЛИОТЕКА ПОЗ И COPY-TOOLS ──
let poseLib: PoseLibrary = (() => { try { return { ...EMPTY_POSE_LIBRARY(), ...(JSON.parse(localStorage.getItem('pe_poselib') || '{}') as PoseLibrary) }; } catch { return EMPTY_POSE_LIBRARY(); } })();
function savePoseLib(): void { try { localStorage.setItem('pe_poselib', JSON.stringify(poseLib)); savePoseKey('pe_poselib'); } catch { /* */ } }
let poseBuf: Pose | null = null;   // буфер «копировать позу» (выделенные кости либо всё тело)
// ХВАТ КИСТИ (Ф3.5) — не часть клипа: привязан к ключу оружия, накладывается поверх.
// Кадр, в котором фаланги ЗАДАНЫ явно (Про-режим крутил их руками), хват не перебивает.
let gripCfg: GripConfig = (() => { try { return { ...EMPTY_GRIP_CONFIG(), ...(JSON.parse(localStorage.getItem('pe_gripposes') || '{}') as GripConfig) }; } catch { return EMPTY_GRIP_CONFIG(); } })();
function saveGrips(): void { try { localStorage.setItem('pe_gripposes', JSON.stringify(gripCfg)); savePoseKey('pe_gripposes'); } catch { /* */ } }
const weaponGripBind = (): { L?: string; R?: string; closeL?: number; closeR?: number } =>
  (gripCfg.byWeapon[curCharId] ??= {})[weapon] ??= defaultWeaponGrip(weapon);
/** Поза пальцев для текущего персонажа/оружия. */
const curGripPose = (): Pose => resolveGripPose(gripCfg, curCharId, weapon);
/** Наложить хват на те фаланги, которые НЕ заданы позой кадра. */
function applyGripOver(p?: Pose): void {
  if (!wantFingers()) return;
  const g = curGripPose(); const out: Pose = {};
  for (const nm in g) if (!p || p[nm] === undefined) out[nm] = g[nm]!;
  applyGripPose(human.bones, out);
}   // выбранный пресет пределов скелета (Ф3.3)
function wantFingers(): boolean { return fingersForced || modelsTab.hasFingers(); }   // профиль тела (модульные пропорции) — как игра строит solid/target; редактор строит манекен/призрак им (P3: opts 1:1)
/** Скелет-манекен ПОВЕРХ импортного меша (depthTest off) — виден и кликается сквозь модель. Только для skeleton-стиля. */
function manikinOnTop(): void {
  if (curHumanStyle !== 'skeleton') return;
  for (const m of human.meshes) { const mat = m.material as THREE.MeshStandardMaterial; mat.depthTest = false; m.renderOrder = 998; }
}
function applyChar(id: string): void {
  curCharId = id; const c = curChar(); weapon = c.weapon;
  loadPhys(id);                                               // физ-настройки (match) этого персонажа
  loadShieldMix(id);                                          // вес подмешивания щита этого персонажа
  loadTwistCfg(id);                                           // профиль скрутки корпуса (torso-lead) этого персонажа
  applyGaitCfg(id);                                            // свой настроенный бег у каждого персонажа
  if (human) { scene.remove(human.root); human.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  gizmo.detach(); selMesh = null; selected = null; activeKey = null; weaponGroups = [];
  human = buildHumanoid({ gender: c.gender, build: morphBuild(c), style: manStyle(), boneScale: morphBoneScale(), boneOffsets: atlasOff(), profile: atlasProfile(), fingers: wantFingers() }); curHumanStyle = manStyle();
  human.footLift = physFootLift;                              // подъём стопы персонажа (standY через measureStancePlants)
  scene.add(human.root); human.root.visible = manView !== 'hidden'; manikinOnTop();
  if (pw) buildGhost();                                       // призрак под новые пропорции (оружие крепится К НЕМУ)
  updateWeapon(); captureRig();                               // оружие — на свежий физ-призрак
  disposeOnion();                                             // онион-призраки пересоберутся под новые пропорции
  clipIdx = 0; frameIdx = 0; history.clear();
  syncAllAttackEnds();                                        // концы ударов этого персонажа = его стойки
  refreshAll();
}
function setWeapon(w: string): void { weapon = w; updateWeapon(); clipIdx = 0; frameIdx = 0; refreshAll(); }
function manStyle(): 'solid' | 'skeleton' { return manView === 'skel' ? 'skeleton' : 'solid'; }
// Лёгкая пересборка манекена под новый стиль (скелет↔тело) С СОХРАНЕНИЕМ позы/оружия (в отличие от applyChar — без сброса клипа/undo).
function rebuildManikin(): void {
  fbik = null;   // солвер связан с КОНКРЕТНЫМ скелетом (топология/длины) — пересобрать
  const c = curChar(); const pose = readPoseFull();
  scene.remove(human.root); human.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
  gizmo.detach(); selMesh = null; selected = null;
  human = buildHumanoid({ gender: c.gender, build: morphBuild(c), style: manStyle(), boneScale: morphBoneScale(), boneOffsets: atlasOff(), profile: atlasProfile(), fingers: wantFingers() }); curHumanStyle = manStyle();
  human.footLift = physFootLift;                              // подъём стопы сохраняется при пересборке стиля манекена
  scene.add(human.root); human.root.visible = manView !== 'hidden'; manikinOnTop();
  applyPose(pose); if (mode === 'ik') captureRig();   // оружие на физ-призраке — манекен-стиль его не трогает
}
function setManView(): void {
  const lbl = { skel: 'манекен: скелет', solid: 'манекен: тело', hidden: 'манекен: скрыт' } as const;
  if (manView !== 'hidden' && human && curHumanStyle !== manStyle()) rebuildManikin();
  if (human) human.root.visible = manView !== 'hidden';
  manB.textContent = lbl[manView]; manB.classList.toggle('on', manView !== 'skel');
}
const splitWeapon = (w: string): [string, string] => { if (w === 'dual') w = 'sword+dagger'; const i = w.lastIndexOf('+'); return i > 0 ? [w.slice(0, i), w.slice(i + 1)] : [w, 'none']; };   // 'main+off' → [main, off]

// ══ UI ══
const mkBtn = (label: string, fn: () => void, cls = 'tbtn'): HTMLButtonElement => { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.onclick = fn; return b; };
const sep = (): HTMLElement => { const s = document.createElement('div'); s.className = 'tb-sep'; return s; };

// ── Тулбар ──
const charSel = document.createElement('select'); charSel.onchange = () => applyChar(charSel.value);
const wpnSel = document.createElement('select');
for (const w of WEAPONS) { const o = document.createElement('option'); o.value = w; o.textContent = w; wpnSel.append(o); }
const offSel = document.createElement('select');   // офф-рука: нет / щит / второе оружие → ключ main+off
for (const o of OFFHANDS) { const op = document.createElement('option'); op.value = o; op.textContent = o === 'none' ? '—' : o; offSel.append(op); }
const composeWeapon = (): void => { const m = wpnSel.value, o = offSel.value; setWeapon(o === 'none' ? m : m + '+' + o); };
wpnSel.onchange = composeWeapon; offSel.onchange = composeWeapon;
let fkB!: HTMLButtonElement, ikB!: HTMLButtonElement, hipsB!: HTMLButtonElement;
function setMode(m: 'fk' | 'ik'): void { mode = m; gizmo.detach(); fkProxyBone = null; highlight(null); selected = null; activeKey = null; activePole = null; for (const e of effList()) { e.handle.visible = m === 'ik'; e.poleHandle.visible = m === 'ik'; } rig.hipsHandle.visible = m === 'ik'; if (m === 'ik') captureRig(); fkB.classList.toggle('on', m === 'fk'); ikB.classList.toggle('on', m === 'ik'); refreshPose(); }
ikB = mkBtn('IK', () => setMode('ik')); fkB = mkBtn('FK', () => setMode('fk'));
hipsB = mkBtn('таз: двигать', () => { hipsMode = hipsMode === 'translate' ? 'rotate' : 'translate'; hipsB.textContent = 'таз: ' + (hipsMode === 'translate' ? 'двигать' : 'вращать'); if (activeKey === 'hips') { gizmo.setMode(hipsMode); if (hipsMode === 'rotate') rig.hipsHandle.quaternion.copy(rig.hipsQuat); } });
const physB = mkBtn('физ: выкл', () => { void ensurePhysics().then(() => { physOn = !physOn; physB.textContent = 'физ: ' + (physOn ? 'вкл' : 'выкл'); physB.classList.toggle('on', physOn); setPhysVis(physOn); }); });
const modeB = mkBtn('', () => { uiPro = !uiPro; saveUi(); syncModeB(); refreshAll(); });
function syncModeB(): void { modeB.textContent = uiPro ? '⚙ Про' : '○ Простой'; modeB.title = uiPro ? 'Про: все настройки (лимиты, моторы, физика, тюнинг походки)' : 'Простой: только позинг и клипы — инженерные панели скрыты (их значения действуют)'; modeB.classList.toggle('on', uiPro); }
const manB = mkBtn('манекен: скелет', () => { manView = manView === 'skel' ? 'solid' : manView === 'solid' ? 'hidden' : 'skel'; setManView(); });
// Тумблер ростера: персонажи (классы) ↔ монстры. Переключает список выбора персонажа и грузит первого из ростера.
let personaB!: HTMLButtonElement;
personaB = mkBtn('◧ персонажи', () => {
  persona = persona === 'class' ? 'monster' : 'class';
  personaB.textContent = persona === 'class' ? '◧ персонажи' : '◧ монстры';
  personaB.classList.toggle('on', persona === 'monster');
  const first = rosterChars()[0];
  if (first) applyChar(first.id); else refreshAll();
});
bar.append(personaB, document.createTextNode('Персонаж'), charSel, document.createTextNode('Оружие'), wpnSel, document.createTextNode('офф'), offSel, sep(), ikB, fkB, hipsB, sep(),
  mkBtn('зеркало L→R', () => histPose('зеркало L→R', mirrorLR)), mkBtn('T-поза', () => histPose('T-поза', () => { human.reset(); if (mode === 'ik') captureRig(); })), sep(),
  mkBtn('↶ undo', () => { history.undo(); }), mkBtn('↷ redo', () => { history.redo(); }), sep(), physB, manB, sep(), modeB);

// ── Панель-вкладки (Анимация = клипы+кадры+поза; Бег = 2D бленд локомоции; Персонаж = setup) ──
// РЕЖИМ ИНТЕРФЕЙСА (Ф1.5). Не два разных UI, а один с прогрессивным раскрытием: «Про» ДОБАВЛЯЕТ инженерные
// панели (лимиты суставов, моторы, PHYS, тюнинг походки), ничего не переставляя. В Простом все эти
// настройки ПРОДОЛЖАЮТ действовать со своими значениями — просто не показываются.
let uiPro: boolean = (() => { try { return (JSON.parse(localStorage.getItem('pe_ui') || '{}') as { pro?: boolean }).pro === true; } catch { return false; } })();
function saveUi(): void { try { localStorage.setItem('pe_ui', JSON.stringify({ pro: uiPro })); savePoseKey('pe_ui'); } catch { /* */ } }
let tab: 'anim' | 'loco' | 'turn' | 'char' | 'models' | 'ai' = 'anim';
const tabBar = document.createElement('div'); tabBar.style.cssText = 'display:flex;gap:3px;margin-bottom:6px';
const body = document.createElement('div');
panel.append(tabBar, body);
const el = (t: string, css: string): HTMLElement => { const e = document.createElement(t); e.style.cssText = css; return e; };
const pbtn = (label: string, fn: () => void, on = false): HTMLButtonElement => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = `margin:2px 3px 2px 0;padding:3px 7px;background:${on ? '#3a5030' : '#2a3350'};color:#cfd3e0;border:1px solid #4a5680;border-radius:4px;cursor:pointer;font:11px monospace`; b.onclick = fn; return b; };
// Вкладка «Повороты» авто-включает превью бега (updateTurnTest: locoOn=true). При уходе на не-локо вкладку его НАДО
// выключить, иначе гейт продолжает вести манекен и перекрывает воспроизведение клипов («после Поворотов анимации не работают»).
const tabSwitch = (k: typeof tab): void => { if (k !== 'turn' && k !== 'loco' && locoOn) { locoOn = false; goFrame(frameIdx); } tab = k; refreshAll(); };
for (const [k, lbl] of [['anim', 'Анимация'], ['loco', 'Бег'], ['turn', 'Повороты'], ['char', 'Персонаж'], ['models', 'Модели'], ['ai', 'ИИ']] as const) { const b = document.createElement('button'); b.textContent = lbl; b.style.cssText = 'flex:1;padding:4px;background:#20242f;color:#cfd3e0;border:1px solid #39415a;border-radius:4px;cursor:pointer;font:11px monospace'; b.onclick = () => tabSwitch(k); b.dataset.tab = k; tabBar.append(b); }
// Вкладка «Модели» (C5): импорт скинед-меша → live-ретаргет нашей позой → экспорт GLB + запись в конфиг.
const modelsTab = createModelsTab(scene);
let lastBS: BoneScale | undefined;   // последний применённый boneScale атласа (детект смены → пересборка скелетов)

function refreshAll(): void { for (const b of Array.from(tabBar.children) as HTMLButtonElement[]) b.style.background = b.dataset.tab === tab ? '#3a5030' : '#20242f'; charSel.innerHTML = ''; for (const c of rosterChars()) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; o.selected = c.id === curCharId; charSel.append(o); } { const [wm, wo] = splitWeapon(weapon); wpnSel.value = wm; offSel.value = wo; } if (tab === 'anim') renderAnim(); else if (tab === 'loco') renderLoco(); else if (tab === 'turn') renderTurn(); else if (tab === 'char') renderChar(); else if (tab === 'ai') renderAi(); else modelsTab.render(body); refreshTimeline(); updateOnion(); updateTrajectory(); updateLimitGizmo(); }
function refreshPose(): void { if (tab === 'anim') renderAnim(); }
function refreshLimbs(): void { if (tab === 'anim') renderAnim(); }

// Инструменты позы (аппендятся в общую панель «Анимация»; правка позы = правка текущего кадра)
const limbLabels: Record<string, string> = { LH: 'рука Л', RH: 'рука П', LF: 'нога Л', RF: 'нога П' };
function poseTools(): void {
  const info = el('div', 'color:#9ae6a0;margin:10px 0 4px;border-top:1px solid #39415a;padding-top:8px'); info.textContent = mode === 'ik' ? 'IK: таз/кисти/стопы + оранж. локти/колени' : (selected ? 'выбрано: ' + selected : 'FK: клик по кости или оружию'); body.append(info);
  const lh = el('div', 'color:#8fb7ff;font-weight:bold;margin:6px 0 2px'); lh.textContent = 'КОНЕЧНОСТИ IK/FK'; body.append(lh);
  const lr = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(lr);
  for (const k of ['LH', 'RH', 'LF', 'RF']) { const e = rig.eff[k]!; lr.append(pbtn(`${limbLabels[k]}: ${e.ik ? 'IK' : 'FK'}`, () => { e.ik = !e.ik; if (e.ik) syncEff(e); renderAnim(); }, e.ik)); }
  const ph = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); ph.textContent = 'ПИНЫ (закрепить точку)'; body.append(ph);
  { const hint = el('div', 'color:#6b7180;font-size:10px'); hint.textContent = fbikOn ? 'приколотое не двигается: крути таз — стопы стоят' : ' ⚠ full-body IK выключен — пины не работают'; body.append(hint); }
  const pr = el('div', 'display:flex;flex-wrap:wrap;gap:6px'); body.append(pr);
  for (const [k, lb] of [['LH', 'кисть Л'], ['RH', 'кисть П'], ['LF', 'стопа Л'], ['RF', 'стопа П']] as const) { const lab = el('label', 'font-size:11px'); const cb = el('input', '') as HTMLInputElement; cb.type = 'checkbox'; cb.checked = rig.eff[k]!.pin; cb.onchange = () => { rig.eff[k]!.pin = cb.checked; }; lab.append(cb, document.createTextNode(lb)); pr.append(lab); }
  if (uiPro) body.append(pbtn(fbikOn ? 'IK: всё тело' : 'IK: по конечностям', () => { fbikOn = !fbikOn; renderAnim(); }, fbikOn));
  const rh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); rh.textContent = 'REACH (тело за рукой)'; body.append(rh);
  const bf = el('input', 'width:100%') as HTMLInputElement; bf.type = 'range'; bf.min = '0'; bf.max = '1'; bf.step = '0.05'; bf.value = String(bodyFollow); bf.oninput = () => { bodyFollow = parseFloat(bf.value); }; body.append(bf);
  if (weaponGroups.length) {
    const wh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); wh.textContent = 'ОРУЖИЕ · ⟳ вращать / ✥ двигать (в кадр)'; body.append(wh);
    const wr = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(wr);
    const wlbl = ['осн', 'офф'];
    const pickWeapon = (g: THREE.Object3D, m: 'rotate' | 'translate'): void => { setMode('fk'); fkProxyBone = null; selected = null; highlight(null); gizmo.setSpace('local'); gizmo.setMode(m); gizmo.attach(g); };
    weaponGroups.forEach((g, i) => { const nm = wlbl[i] ?? ('о' + (i + 1)); wr.append(pbtn(nm + ' ⟳', () => pickWeapon(g, 'rotate')), pbtn(nm + ' ✥', () => pickWeapon(g, 'translate'))); });
    wr.append(pbtn('сброс', () => { updateWeapon(); renderAnim(); }));   // пересборка = базовый хват pe_grip
    // ХВАТ = единая БАЗА pe_grip (во всех анимациях одинаково). Правишь оружие с ВЫКЛ галкой → авто-в базу. Галка ВКЛ →
    // хват правится ОТДЕЛЬНО на этот кадр (override поверх базы; удар может двигать оружие только с галкой).
    const ovrLab = el('label', 'font-size:11px;display:flex;align-items:center;gap:4px;margin-top:4px');
    const ovrCb = el('input', '') as HTMLInputElement; ovrCb.type = 'checkbox'; ovrCb.checked = wpnOverride;
    ovrCb.onchange = () => {
      wpnOverride = ovrCb.checked; const c = curClip(); const kk = c?.keys[frameIdx];
      if (kk) {
        if (wpnOverride) kk.pose = readPoseFull();   // захватить текущий хват как override ЭТОГО кадра
        else { delete kk.pose['__wpnOverride']; for (const k of [...WPN_KEYS, ...WPN_POS]) delete kk.pose[k]; applyWeaponPose(kk.pose); }   // убрать → база
        saveLib();
      }
      renderAnim();
    };
    ovrLab.append(ovrCb, document.createTextNode('хват: своя правка (этот кадр)')); body.append(ovrLab);
    body.append(pbtn('★ хват → БАЗА (все анимации)', () => { saveGripBase(); renderAnim(); }));
    if (weaponGroups.length === 1 && !weapon.includes('+')) {            // двуручка: левая кисть держит оружие в точке хвата (покадрово, IK)
      const gh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); gh.textContent = 'ДВУРУЧНЫЙ ХВАТ · левая кисть на оружии (IK)'; body.append(gh);
      const gr = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(gr);
      const on = hasLgrip();
      gr.append(pbtn(on ? '− левый хват' : '+ левый хват', () => {
        const c = curClip(); if (!c) return;
        if (on) { for (const k of c.keys) { delete k.pose['__lgripP']; delete k.pose['__lgripR']; } if (lgripMark) lgripMark.visible = false; if (gizmo.object === lgripMark) gizmo.detach(); }
        else { const def: [number, number, number] = [0, -14, 0]; for (const k of c.keys) { if (!k.pose['__lgripP']) { k.pose['__lgripP'] = [...def]; k.pose['__lgripR'] = [0, 0, 0]; } } const m = ensureLgripMark(); if (m) { m.position.set(def[0], def[1], def[2]); m.rotation.set(0, 0, 0); m.visible = true; } }
        saveLib(); renderAnim();
      }, on));
      if (on) { const pickGrip = (m: 'rotate' | 'translate'): void => { const mk = ensureLgripMark(); if (!mk) return; setMode('fk'); fkProxyBone = null; selected = null; highlight(null); mk.visible = true; gizmo.setSpace('local'); gizmo.setMode(m); gizmo.attach(mk); }; gr.append(pbtn('хват ✥', () => pickGrip('translate')), pbtn('хват ⟳', () => pickGrip('rotate'))); }
    }
  }
  // ── ФИЗИКА (PuppetMaster-стиль: пины/мышцы + дёрг/падение) ── только Про
  if (uiPro) {
  const phh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); phh.textContent = 'ФИЗИКА (мышцы/пины)'; body.append(phh);
  const phRow = (label: string, key: 'pin' | 'pinKp' | 'muscle' | 'load' | 'match', min: number, max: number, step: number): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px'); row.innerHTML = `<span style="flex:1">${label}</span>`;
    const s = el('input', 'width:100px') as HTMLInputElement; s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(PHYS[key]);
    const v = el('span', 'width:44px;text-align:right;color:#9ae6a0'); v.textContent = String(PHYS[key]);
    s.oninput = () => { PHYS[key] = parseFloat(s.value); v.textContent = s.value; if (key === 'match' || key === 'pinKp') writeFramePhys(); };   // match/pinKp — фиксируются в ТЕКУЩИЙ кадр (per-frame)
    row.append(s, v); body.append(row);
  };
  phRow('пины (сила)', 'pin', 0, 1, 0.05); phRow('★ пин · жёсткость (кадр)', 'pinKp', 0, 12000, 200); phRow('мышцы (ведение)', 'muscle', 0, 1, 0.05); phRow('вес оружия', 'load', 0, 3, 0.1);
  phRow('★ совпадение с манекеном (кадр)', 'match', 0, 1, 0.05);
  { // Стоимость набора физ-тел — чтобы решение «добавить тел» было осознанным, а не сюрпризом.
    const c = el('div', 'color:#6b7180;font-size:10px;margin-top:2px');
    c.textContent = `тел: ${RAG_NAMES.length} · шаг симуляции ~${physMs.toFixed(2)} мс` + (wantFingers() ? ' · пальцы кинематические (без физ-тел)' : '');
    body.append(c);
  }   // ★ = per-frame (в позе кадра); 0 = физика, 1 = ровно твоя поза
  // ── ЛИМИТЫ/МОТОРЫ суставов (RB3): множитель конусов/диапазонов + сила моторов. Применяется ПЕРЕСБОРКОЙ куклы на отпускание. ──
  const rgh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); rgh.textContent = 'ЛИМИТЫ/МОТОРЫ (пересборка)'; body.append(rgh);
  const ragRow = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px'); row.innerHTML = `<span style="flex:1">${label}</span>`;
    const s = el('input', 'width:100px') as HTMLInputElement; s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(get());
    const v = el('span', 'width:44px;text-align:right;color:#9ae6a0'); v.textContent = String(get());
    s.oninput = () => { v.textContent = s.value; };
    s.onchange = () => { set(parseFloat(s.value)); saveRagdollConfig(); savePoseKey('pe_ragdoll'); if (ragdoll) rebuildRagdoll(); updateLimitGizmo(); };   // пересборка на отпускание (+ конус под новый ×)
    row.append(s, v); body.append(row);
  };
  ragRow('лимит: рука ×', () => LIMITS.arm, (v) => { LIMITS.arm = v; }, 0.4, 2.5, 0.05);
  ragRow('лимит: нога ×', () => LIMITS.leg, (v) => { LIMITS.leg = v; }, 0.4, 2.5, 0.05);
  ragRow('лимит: торс ×', () => LIMITS.core, (v) => { LIMITS.core = v; }, 0.4, 2.5, 0.05);
  ragRow('лимит: голова ×', () => LIMITS.head, (v) => { LIMITS.head = v; }, 0.4, 2.5, 0.05);
  ragRow('мотор рука · сила', () => MOTOR.arm[1], (v) => { MOTOR.arm[1] = v; }, 1e6, 2e7, 5e5);
  ragRow('мотор нога · сила', () => MOTOR.leg[1], (v) => { MOTOR.leg[1] = v; }, 1e6, 2e7, 5e5);
  ragRow('мотор торс · сила', () => MOTOR.core[1], (v) => { MOTOR.core[1] = v; }, 5e5, 1e7, 5e5);
  body.append(pbtn('сброс лимитов/моторов', () => { LIMITS.arm = LIMITS.leg = LIMITS.core = LIMITS.head = 1; MOTOR.leg = [20, 6e6]; MOTOR.arm = [20, 6e6]; MOTOR.core = [15, 3e6]; MOTOR.head = [13, 2e5]; saveRagdollConfig(); savePoseKey('pe_ragdoll'); if (ragdoll) rebuildRagdoll(); renderAnim(); }));
  // ── ПРЕСЕТЫ СКЕЛЕТА (Ф3.3): человек / обратные колени / свободный / без пределов ──
  // Пресет = набор оверрайдов в тот же jointOv, что и ручная правка. Обратные колени работают без нового кода
  // ровно потому, что диапазоны асимметричные (min/max), а не симметричный конус.
  {
    const prow = el('div', 'display:flex;align-items:center;gap:4px;margin-top:6px'); body.append(prow);
    const lab = el('span', 'flex:1;font-size:11px'); lab.textContent = 'пресет скелета'; prow.append(lab);
    const sel = document.createElement('select'); sel.style.cssText = impInput;
    for (const pr of LIMIT_PRESETS) { const o = document.createElement('option'); o.value = pr.id; o.textContent = pr.label; o.title = pr.hint; sel.append(o); }
    sel.value = limitPresetId;
    sel.onchange = () => {
      limitPresetId = sel.value;
      const pr = findPreset(limitPresetId);
      for (const k in jointOv) delete jointOv[k];
      if (pr) for (const k in pr.joints) jointOv[k] = { ...pr.joints[k]! };
      saveRagdollConfig(); savePoseKey('pe_ragdoll'); if (ragdoll) rebuildRagdoll(); updateLimitGizmo(); renderAnim();
    };
    prow.append(sel);
    const hint = el('div', 'color:#6b7180;font-size:10px'); hint.textContent = findPreset(limitPresetId)?.hint ?? ''; body.append(hint);
  }
  // ── ПРЕДЕЛЫ СУСТАВА: тумблеры + пер-сустав диапазоны (правится симметрично L/R; групповой × выше — множитель) ──
  const lt = el('div', 'display:flex;flex-wrap:wrap;gap:3px;margin-top:4px'); body.append(lt);
  lt.append(
    pbtn(showLimits ? 'гизмо предела: вкл' : 'гизмо предела: выкл', () => { showLimits = !showLimits; renderAnim(); }, showLimits),
    pbtn(clampFk ? 'клэмп FK: вкл' : 'клэмп FK: выкл', () => { clampFk = !clampFk; renderAnim(); }, clampFk),
    pbtn(footGround ? 'заземл. стоп: вкл' : 'заземл. стоп: выкл', () => { footGround = !footGround; renderAnim(); }, footGround),
  );
  // Офсет заземления стоп (per-персонаж, pe_phys.footLift): цель foot-IK = пол + SOLE + офсет. + поднять (стопы тонут под пол),
  // − опустить (парят над полом). Живо, per-персонаж, держится после бега. Тот же офсет читает игра (loadFootLift).
  {
    const row = el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px'); row.innerHTML = `<span style="flex:1;color:#9ae6a0">офсет заземл. стоп (± под/над пол)</span>`;
    const s = el('input', 'width:120px') as HTMLInputElement; s.type = 'range'; s.min = '-4'; s.max = '8'; s.step = '0.1'; s.value = String(physFootLift);
    const v = el('span', 'width:44px;text-align:right;color:#9ae6a0'); v.textContent = physFootLift.toFixed(1);
    s.oninput = () => {
      physFootLift = parseFloat(s.value); v.textContent = physFootLift.toFixed(1);
      human.footLift = physFootLift; if (ghostHuman) ghostHuman.footLift = physFootLift;
      stanceMeasuredFor = '';   // пере-замерить стойку под новый офсет (без __hipsP — фолбэк-высота; с __hipsP не трогает стойку)
      saveFootLift(); renderAnim();
    };
    row.append(s, v); body.append(row);
  }
  // Сустав выбранной кости: сначала физ-риг, иначе без-физический (фаланги — у них тела нет и не будет).
  const canon = (tab === 'anim' && selected) ? (canonOfHuman(selected) ?? limitViewForBone(selected)?.canon ?? null) : null;
  const canonDef = canon ? (JOINT_DEF[canon] ?? (selected ? extraLimitView(selected) && { kind: 'swing' as const, group: 'arm' as const, planeMin: extraLimitView(selected)!.planeMin, planeMax: extraLimitView(selected)!.planeMax, normalMin: extraLimitView(selected)!.normalMin, normalMax: extraLimitView(selected)!.normalMax, twistMin: extraLimitView(selected)!.twistMin, twistMax: extraLimitView(selected)!.twistMax } : null)) : null;
  if (canon && canonDef) {
    const def = canonDef;
    const jh = el('div', 'color:#ffcf66;font-weight:bold;margin:6px 0 2px'); jh.textContent = `СУСТАВ: ${selected} → ${canon} (симметрия L/R)`; body.append(jh);
    const D = 180 / Math.PI, r2d = (r: number): number => Math.round(r * D), d2r = (d: number): number => d / D;
    type JF = 'planeMin' | 'planeMax' | 'normalMin' | 'normalMax' | 'twistMin' | 'twistMax' | 'flex' | 'hyperext';
    const jRow = (label: string, field: JF, min: number, max: number): void => {
      const cur = (jointOv[canon]?.[field] ?? def[field] ?? 0);
      const row = el('label', 'display:flex;align-items:center;gap:6px'); row.innerHTML = `<span style="flex:1">${label}</span>`;
      const s = el('input', 'width:96px') as HTMLInputElement; s.type = 'range'; s.min = String(min); s.max = String(max); s.step = '1'; s.value = String(r2d(cur));
      const v = el('span', 'width:44px;text-align:right;color:#9ae6a0'); v.textContent = s.value + '°';
      s.oninput = () => { v.textContent = s.value + '°'; (jointOv[canon] ??= {})[field] = d2r(parseFloat(s.value)); updateLimitGizmo(); };   // живая зона, без пересборки
      s.onchange = () => { saveRagdollConfig(); savePoseKey('pe_ragdoll'); if (ragdoll) rebuildRagdoll(); };   // пересборка куклы на отпускание
      row.append(s, v); body.append(row);
    };
    if (def.kind === 'swing') {   // асимметрично по осям: план (питч/вперёд-назад), норм (крен/вбок), твист (осевое)
      jRow('план −', 'planeMin', -180, 0); jRow('план +', 'planeMax', 0, 180);
      jRow('норм −', 'normalMin', -180, 0); jRow('норм +', 'normalMax', 0, 180);
      jRow('твист −', 'twistMin', -180, 0); jRow('твист +', 'twistMax', 0, 180);
    } else { jRow('сгиб', 'flex', 0, 170); jRow('переразгиб', 'hyperext', 0, 60); }
    body.append(pbtn('сброс сустава', () => { delete jointOv[canon]; saveRagdollConfig(); savePoseKey('pe_ragdoll'); if (ragdoll) rebuildRagdoll(); updateLimitGizmo(); renderAnim(); }));
  } else if (tab === 'anim') { const hint = el('div', 'color:#6b7180;font-size:10px;margin:4px 0'); hint.textContent = 'выбери кость (FK) — покажется предел её сустава'; body.append(hint); }
  }   // конец блока «только Про»
  updateLimitGizmo();
  const phb = el('div', 'display:flex;flex-wrap:wrap;gap:3px;margin-top:4px'); body.append(phb);
  phb.append(
    pbtn('физика вкл/выкл', () => { void ensurePhysics().then(() => { physOn = !physOn; setPhysVis(physOn); }); }, physOn),
  );
  if (uiPro) phb.append(
    pbtn('дёрг (удар)', () => { void ensurePhysics().then(() => { physOn = true; setPhysVis(true); if (ragdoll) { ragdoll.hit('Torso', 0, 0.3, 1, 1.4); ragdoll.hit('Head', 0, 0.3, 1, 0.8); } }); }),
    pbtn(physDead ? 'встать' : 'упасть', () => { void ensurePhysics().then(() => { physOn = true; setPhysVis(true); if (!ragdoll) return; if (physDead) { const h = ragdoll.bodyPos('Hips'); reviveFrom.set(h[0], h[1], h[2]); reviveT = 0; ragdoll.setDead(false); physDead = false; } else { ragdoll.setDead(true); physDead = true; reviveT = -1; } renderAnim(); }); }, physDead),
    pbtn('боксы физтела', () => { void ensurePhysics().then(() => { showBoxes = !showBoxes; if (ragdoll) ragdoll.group.visible = showBoxes; renderAnim(); }); }, showBoxes),
  );
  poseLibSection();
  gripSection();
  boneTreeSection();
}

// ── Ф7: ПОЗЫ / КОПИРОВАНИЕ / ЗЕРКАЛО ──
// mirror и flip — РАЗНЫЕ операции: mirror подтягивает вторую сторону под первую (поза та же),
// flip меняет стороны местами (удар справа становится ударом слева). Раньше была только первая.
function poseLibSection(): void {
  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); h.textContent = 'ПОЗЫ И КОПИРОВАНИЕ'; body.append(h);
  const r1 = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(r1);
  const selBones = (): string[] | undefined => (selected ? [selected] : undefined);
  r1.append(
    pbtn(selected ? '⌘ копир кость' : '⌘ копир позу', () => { poseBuf = capturePose(readPoseFull(), selBones()); renderAnim(); }),
    pbtn('⤓ вставить', () => { if (!poseBuf) return; histLib('вставить позу', () => { const c = curClip(); const k = c?.keys[frameIdx]; if (k) { k.pose = pastePose(k.pose, poseBuf!); saveLib(); goFrame(frameIdx); } }); }),
    pbtn('⇄ зеркало Л→П', () => histPose('зеркало Л→П', mirrorLR)),
    pbtn('↺ перевернуть позу', () => histPose('перевернуть позу', () => { applyPose(flipPoseSides(readPoseFull())); if (mode === 'ik') captureRig(); })),
  );
  if (poseBuf) {
    const hint = el('div', 'color:#6b7180;font-size:10px'); hint.textContent = `в буфере: ${Object.keys(poseBuf).length} костей`; body.append(hint);
    const r2 = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(r2);
    // INTERVAL EDIT: влияние нарастает от начала диапазона к концу — это и делает бесшовный луп.
    const intoInterval = (curve: 'linear' | 'bezier'): void => histLib('вставить в интервал', () => {
      const c = curClip(); if (!c || !poseBuf) return;
      const sl = tl.selection();
      const from = sl.length ? Math.min(...sl) : frameIdx;
      const to = sl.length ? Math.max(...sl) : c.keys.length - 1;
      pasteIntoInterval(c.keys, from, to, poseBuf); void curve;
      saveLib(); goFrame(frameIdx);
    });
    r2.append(pbtn('⤓⤓ вставить В ИНТЕРВАЛ', () => intoInterval('linear')));
    const ih = el('div', 'color:#6b7180;font-size:10px'); ih.textContent = 'влияние нарастает к концу диапазона (выдели ключи на тайм-лайне)'; body.append(ih);
  }
  // Сохранённые позы
  const r3 = el('div', 'display:flex;flex-wrap:wrap;gap:3px;margin-top:3px'); body.append(r3);
  r3.append(pbtn('★ в библиотеку', () => {
    const nm = prompt('имя позы', 'поза ' + (Object.keys(poseLib.poses).length + 1)); if (!nm) return;
    const id = 'p' + Date.now().toString(36);
    poseLib.poses[id] = { id, label: nm, pose: capturePose(readPoseFull(), selBones()) };
    savePoseLib(); renderAnim();
  }));
  for (const sp of Object.values(poseLib.poses)) {
    const g = el('div', 'display:inline-flex;align-items:center'); r3.append(g);
    g.append(
      pbtn(sp.label, () => histLib('поза из библиотеки', () => { const c = curClip(); const k = c?.keys[frameIdx]; if (k) { k.pose = pastePose(k.pose, sp.pose); saveLib(); goFrame(frameIdx); } })),
      pbtn('⇄', () => histLib('поза зеркально', () => { const c = curClip(); const k = c?.keys[frameIdx]; if (k) { k.pose = pastePose(k.pose, flipPoseSides(sp.pose)); saveLib(); goFrame(frameIdx); } })),
      pbtn('✕', () => { delete poseLib.poses[sp.id]; savePoseLib(); renderAnim(); }),
    );
  }
  if (uiPro) {
    const r4 = el('div', 'display:flex;flex-wrap:wrap;gap:3px;margin-top:3px'); body.append(r4);
    const onClip = (label: string, fn: (c: Clip) => Clip): HTMLButtonElement => pbtn(label, () => histLib(label, () => {
      const c = curClip(); if (!c) return;
      const i = library.indexOf(c); if (i < 0) return;
      library[i] = fn(c); saveLib(); goFrame(frameIdx);
    }));
    r4.append(
      onClip('↺ перевернуть КЛИП', (c) => flipClip(c)),
      onClip('⇄ зеркало КЛИПА', (c) => mirrorClip(c, 'Left')),
      onClip('↻ фаза +1', (c) => rotateClipPhase(c, 1)),
    );
    // «А в игре так же?» — требование «редактор ≡ игра» становится ИЗМЕРИМЫМ, а не на глаз.
    body.append(pbtn('⚖ сверить с физ-призраком', () => {
      if (!ghostHuman) { alert('Включи физику — без призрака сверять не с чем.'); return; }
      const d = comparePoses(human.readPose() as Pose, ghostHuman.readPose() as Pose, (x, y) => {
        const qa = new THREE.Quaternion().setFromEuler(new THREE.Euler(x[0] ?? 0, x[1] ?? 0, x[2] ?? 0, 'XYZ'));
        const qb = new THREE.Quaternion().setFromEuler(new THREE.Euler(y[0] ?? 0, y[1] ?? 0, y[2] ?? 0, 'XYZ'));
        return qa.angleTo(qb) * 180 / Math.PI;
      });
      alert('Расхождение авторской позы и физ-призрака (градусы):\n\n'
        + d.perBone.slice(0, 8).map((x) => `${x.bone}: ${x.deg.toFixed(1)}°`).join('\n')
        + `\n\nхудшая: ${d.worstBone} ${d.worstDeg.toFixed(1)}°`);
    }));
  }
}

// ── Ф3.5: ХВАТ КИСТИ ──
// Простой режим: выпадашка + один слайдер на кисть — пальцы трогать руками не надо вообще.
// Про: плюс сохранить текущие фаланги своим пресетом и зеркало на вторую кисть.
function gripSection(): void {
  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); h.textContent = 'ХВАТ КИСТИ'; body.append(h);
  if (!wantFingers()) {
    const hint = el('div', 'color:#6b7180;font-size:10px');
    hint.textContent = 'пальцы выключены — включаются автоматически для модели с пальцами (или кнопкой ✋ в Про)';
    body.append(hint); return;
  }
  const bind = weaponGripBind();
  const options = (): HTMLOptionElement[] => [
    ...BUILTIN_GRIPS.map((g) => { const o = document.createElement('option'); o.value = g.id; o.textContent = g.label; return o; }),
    ...Object.values(gripCfg.custom).map((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = '★ ' + c.label; return o; }),
  ];
  const hand = (side: 'L' | 'R', label: string): void => {
    const row = el('div', 'display:flex;align-items:center;gap:4px;margin-top:2px'); body.append(row);
    const lb = el('span', 'width:52px;font-size:11px'); lb.textContent = label; row.append(lb);
    const sel = document.createElement('select'); sel.style.cssText = impInput + ';flex:1';
    for (const o of options()) sel.append(o);
    sel.value = (side === 'L' ? bind.L : bind.R) ?? 'open';
    sel.onchange = () => { if (side === 'L') bind.L = sel.value; else bind.R = sel.value; saveGrips(); goFrame(frameIdx); };
    row.append(sel);
    const sl = el('input', 'width:70px') as HTMLInputElement;
    sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.05';
    sl.value = String((side === 'L' ? bind.closeL : bind.closeR) ?? 1);
    sl.title = 'сжатие: 0 = раскрытая кисть, 1 = пресет как есть';
    sl.oninput = () => { const v = parseFloat(sl.value); if (side === 'L') bind.closeL = v; else bind.closeR = v; applyGripOver(curClip()?.keys[frameIdx]?.pose); };
    sl.onchange = () => saveGrips();
    row.append(sl);
  };
  hand('R', 'правая'); hand('L', 'левая');
  if (uiPro) {
    const row = el('div', 'margin-top:3px'); body.append(row);
    row.append(
      pbtn('★ сохранить свой', () => {
        const nm = prompt('имя хвата', 'хват ' + (Object.keys(gripCfg.custom).length + 1)); if (!nm) return;
        const id = 'c_' + Date.now().toString(36);
        const pose: Pose = {}; for (const nmb of human.boneNames) if (isHandBone(nmb)) { const r = human.bones.get(nmb)!.rotation; pose[nmb] = [+r.x.toFixed(4), +r.y.toFixed(4), +r.z.toFixed(4)]; }
        gripCfg.custom[id] = { id, label: nm, pose };
        bind.L = id; bind.R = id; saveGrips(); refreshAll();
      }),
      pbtn('⇄ зеркало П→Л', () => histPose('зеркало хвата', () => {
        for (const nmb of human.boneNames) { if (!isHandBone(nmb) || !nmb.startsWith('Right')) continue;
          const dst = human.bones.get('Left' + nmb.slice(5)); const src = human.bones.get(nmb)!.rotation;
          if (dst) dst.rotation.set(-src.x, -src.y, src.z); }
      })),
      pbtn('✕ сброс привязки', () => { delete (gripCfg.byWeapon[curCharId] ?? {})[weapon]; saveGrips(); goFrame(frameIdx); refreshAll(); }),
    );
  }
}

// ── Ф3.7: ДЕРЕВО КОСТЕЙ ──
// Плоская сетка кнопок читалась на 22 костях и стала нечитаемой на 52 (с пальцами).
// Группы сворачиваются; в Простом режиме кисти скрыты целиком (там хват выбирается пресетом).
const BONE_GROUPS: [string, (n: string) => boolean][] = [
  ['Торс', (n) => ['Root', 'Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head'].includes(n)],
  ['Рука Л', (n) => /^Left(Shoulder|UpperArm|LowerArm|Hand)$/.test(n)],
  ['Кисть Л', (n) => /^Left(Thumb|Index|Middle|Ring|Little)/.test(n)],
  ['Рука П', (n) => /^Right(Shoulder|UpperArm|LowerArm|Hand)$/.test(n)],
  ['Кисть П', (n) => /^Right(Thumb|Index|Middle|Ring|Little)/.test(n)],
  ['Нога Л', (n) => /^Left(UpperLeg|LowerLeg|Foot|Toes)$/.test(n)],
  ['Нога П', (n) => /^Right(UpperLeg|LowerLeg|Foot|Toes)$/.test(n)],
];
const boneGroupOpen: Record<string, boolean> = { 'Торс': true };
let boneFilter = '';
function boneTreeSection(): void {
  const head = el('div', 'display:flex;align-items:center;gap:4px;margin:8px 0 2px'); body.append(head);
  const t = el('span', 'color:#8fb7ff;font-weight:bold;flex:1'); t.textContent = 'FK · КОСТИ'; head.append(t);
  const f = el('input', 'width:88px;' + impInput) as HTMLInputElement;
  f.placeholder = 'поиск'; f.value = boneFilter;
  f.oninput = () => { boneFilter = f.value.trim().toLowerCase(); renderAnim(); const again = body.querySelector('input[placeholder="поиск"]') as HTMLInputElement | null; if (again) { again.focus(); again.selectionStart = again.value.length; } };
  head.append(f);
  if (uiPro) head.append(pbtn(wantFingers() ? '✋ пальцы' : '✋ нет', () => { fingersForced = !fingersForced; rebuildManikin(); if (pw) buildGhost(); disposeOnion(); refreshAll(); }, wantFingers()));

  const known = new Set<string>();
  const mkBoneBtn = (nm: string): HTMLButtonElement => {
    const b = document.createElement('button'); b.textContent = nm;
    b.style.cssText = `font-size:10px;padding:1px 4px;border-radius:3px;cursor:pointer;border:1px solid #39415a;background:${nm === selected ? '#3a5030' : '#20242f'};color:#b8bec8`;
    b.onclick = () => { setMode('fk'); selected = nm; highlight(human.meshes.find((x) => x.userData.bone === nm) ?? null); attachBoneGizmo(nm); renderAnim(); };
    return b;
  };
  for (const [label, match] of BONE_GROUPS) {
    const hand = label.startsWith('Кисть');
    if (hand && !uiPro) continue;                                    // Простой: пальцы поштучно не показываем
    const all = human.boneNames.filter(match);
    for (const n of all) known.add(n);
    const list = boneFilter ? all.filter((n) => n.toLowerCase().includes(boneFilter)) : all;
    if (!list.length) continue;
    const open = boneFilter ? true : (boneGroupOpen[label] ?? false);
    const hdr = pbtn(`${open ? '▾' : '▸'} ${label} (${list.length})`, () => { boneGroupOpen[label] = !open; renderAnim(); }, open);
    hdr.style.width = '100%'; hdr.style.textAlign = 'left';
    body.append(hdr);
    if (!open) continue;
    const row = el('div', 'display:flex;flex-wrap:wrap;gap:2px;margin:0 0 3px 8px'); body.append(row);
    for (const nm of list) row.append(mkBoneBtn(nm));
  }
  const rest = human.boneNames.filter((n) => !known.has(n) && (!boneFilter || n.toLowerCase().includes(boneFilter)));
  if (rest.length) {
    const hdr = el('div', 'color:#6b7180;font-size:10px;margin-top:3px'); hdr.textContent = 'прочее'; body.append(hdr);
    const row = el('div', 'display:flex;flex-wrap:wrap;gap:2px;margin-left:8px'); body.append(row);
    for (const nm of rest) row.append(mkBoneBtn(nm));
  }
}

// Вкладка АНИМАЦИЯ = клипы + кадры(с временем) + инструменты позы (правишь позу = правишь текущий кадр)
function delClip(cl: Clip): void { histLib('удалить клип', () => delClipRaw(cl)); }
function delClipRaw(cl: Clip): void {   // удалить позу/анимацию из библиотеки (+ снять пометку удара, если была)
  const idx = library.indexOf(cl); if (idx < 0) return;
  library.splice(idx, 1);
  const am = atkCfgs[cl.character]?.[cl.weapon]; if (am) { const j = am.indexOf(cl.name); if (j >= 0) { am.splice(j, 1); saveAtk(); } }
  clipIdx = 0; frameIdx = 0; saveLib(); refreshAll();
}
// ── ИМПОРТ АНИМАЦИИ (FBX/GLB/BVH → наш Clip): запекатель clipBaker (обратный ретаргет + прореживание). Клип
//    ложится в library для ТЕКУЩИХ персонажа+оружия, дальше правится штатным таймлайном. Физика не трогается —
//    клип это поза-цель, рэгдолл догоняет её (как сейчас). См. docs/ANIM_AI_RESEARCH.md ЧАСТЬ II. ──
function openImportAnimModal(): void {
  const file = document.createElement('input'); file.type = 'file'; file.accept = '.fbx,.glb,.gltf,.bvh';
  file.onchange = () => { const f = file.files?.[0]; if (f) void showImportPanel(f); };
  file.click();
}
const impInput = 'background:#0f1119;color:#dfe3ee;border:1px solid #39415a;border-radius:4px;padding:2px 5px;font:11px monospace';
async function showImportPanel(file: File): Promise<void> {
  const ov = el('div', 'position:fixed;inset:0;background:rgba(6,8,14,.6);z-index:99999;display:flex;align-items:center;justify-content:center');
  const box = el('div', 'background:#141824;border:1px solid #39415a;border-radius:8px;padding:14px;width:380px;font:12px monospace;color:#dfe3ee;box-shadow:0 8px 32px rgba(0,0,0,.5)');
  ov.append(box); document.body.append(ov);
  const title = el('div', 'color:#8fb7ff;font-weight:bold;margin-bottom:8px'); title.textContent = '📥 Импорт анимации: ' + file.name; box.append(title);
  const row = (label: string): HTMLElement => { const r = el('label', 'display:flex;align-items:center;gap:8px;margin:6px 0'); const s = el('span', 'flex:1;color:#9aa3b8'); s.textContent = label; r.append(s); return r; };

  const animSel = document.createElement('select'); animSel.style.cssText = impInput + ';flex:2';
  const animRow = row('анимация'); animRow.append(animSel); box.append(animRow);

  const fpsIn = document.createElement('input'); fpsIn.type = 'number'; fpsIn.min = '5'; fpsIn.max = '120'; fpsIn.value = '30'; fpsIn.style.cssText = impInput + ';width:70px';
  const fpsRow = row('семпл fps'); fpsRow.append(fpsIn); box.append(fpsRow);

  const epsIn = document.createElement('input'); epsIn.type = 'range'; epsIn.min = '0'; epsIn.max = '50'; epsIn.step = '0.5'; epsIn.value = '3'; epsIn.style.flex = '2';
  const epsVal = el('span', 'color:#c8b06a;min-width:64px;text-align:right'); const setEps = (): void => { const e = parseFloat(epsIn.value); epsVal.textContent = e === 0 ? 'все кадры' : e.toFixed(1) + '°'; }; epsIn.oninput = setEps; setEps();
  const epsRow = row('детализация'); epsRow.append(epsIn, epsVal); box.append(epsRow);

  const loopChk = document.createElement('input'); loopChk.type = 'checkbox';
  const loopRow = row('зациклить (walk/run/idle)'); loopRow.append(loopChk); box.append(loopRow);

  const bodySel = document.createElement('select'); bodySel.style.cssText = impInput + ';flex:2';
  for (const [v, t] of [['full', 'всё тело'], ['upper', 'только ВЕРХ (торс+руки)'], ['lower', 'только НИЗ (таз+ноги)']] as [string, string][]) { const o = document.createElement('option'); o.value = v; o.textContent = t; bodySel.append(o); }
  const bodyRow = row('тело (маска)'); bodyRow.append(bodySel); box.append(bodyRow);

  const idleChk = document.createElement('input'); idleChk.type = 'checkbox'; idleChk.checked = true;
  const idleRow = row('встроить idle (ноги + старт/финиш)'); idleRow.title = 'Не-двигаемые кости (напр. ноги при маске «верх») берутся из нашей idle-стойки; idle идёт первым и последним ключом → клип idle→движение→idle.'; idleRow.append(idleChk); box.append(idleRow);

  const status = el('div', 'color:#c8b06a;font-size:11px;margin:8px 0 4px;min-height:14px'); box.append(status);
  const btns = el('div', 'display:flex;gap:6px;margin-top:6px;justify-content:flex-end');
  const bakeBtn = pbtn('Запечь', () => void doBake());
  btns.append(pbtn('Отмена', () => ov.remove()), bakeBtn); box.append(btns);

  status.textContent = 'чтение анимаций…';
  try {
    const anims = await listAnimations(file);
    animSel.innerHTML = '';
    anims.forEach((n, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = n; animSel.append(o); });
    const first = anims[0] ?? ''; if (/walk|run|idle|ход|бег|цикл|loop/i.test(first)) loopChk.checked = true;
    status.textContent = anims.length ? `${curChar().name} · ${weapon} · анимаций: ${anims.length}` : 'в файле нет анимаций';
  } catch (e) { status.textContent = 'ошибка чтения: ' + (e as Error).message; }

  async function doBake(): Promise<void> {
    bakeBtn.disabled = true; status.textContent = 'запекаю…';
    try {
      const res = await bakeAnimationToClip(file, {
        character: curCharId, weapon,
        animationIndex: parseInt(animSel.value, 10) || 0,
        fps: parseFloat(fpsIn.value) || 30,
        epsDeg: parseFloat(epsIn.value) || 0,
        loop: loopChk.checked,
        body: bodySel.value as 'full' | 'upper' | 'lower',
        idlePose: idleChk.checked ? (editorContent.resolveUpper(weapon)?.pose ?? undefined) : undefined,
        anchorIdle: idleChk.checked,
      });
      let nm = (res.clip.name || 'anim').replace(/[^\wа-яА-Я0-9:+._-]/g, '_'); const base = nm;
      for (let i = 2; library.some((x) => x.name === nm && x.character === curCharId && x.weapon === weapon); i++) nm = base + '_' + i;
      res.clip.name = nm; res.clip.character = curCharId; res.clip.weapon = weapon;
      if (res.clip.idleEnds) syncAttackEnds(res.clip as Clip);   // концы = актуальная стойка (единый источник), дальше синкаются при правке стойки
      library.push(res.clip); saveLib();
      clipIdx = clipsHere().findIndex((x) => x.name === nm); frameIdx = 0; refreshAll();
      status.textContent = `готово: «${nm}» — ${res.frames} кадров → ${res.keys} ключей`;
      setTimeout(() => ov.remove(), 1100);
    } catch (e) { status.textContent = 'ошибка: ' + (e as Error).message; bakeBtn.disabled = false; }
  }
}

function renderAnim(): void { body.innerHTML = ''; clipSection(); animExportSection(); poseTools(); }

// ── Ф2.3: ВЫВОЗ КЛИПОВ НАРУЖУ (GLB с анимациями + манифест) ──
// Цель экспорта — ЗАГРУЖЕННЫЙ атлас (скин + его скелет), если он есть; иначе наш канон-манекен
// (тогда GLB — эталонный скелет с анимациями, ретаргетится в любом движке).
let expProfile: NameProfile = 'canon';
let expStatus = '';
let expBakeFingers = true;   // по умолчанию впекаем: принимающему движку не должна быть нужна наша система хватов
function animExportSection(): void {
  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:10px 0 2px;border-top:1px solid #39415a;padding-top:8px');
  h.textContent = 'АНИМАЦИИ → GLB'; body.append(h);
  const tgt = modelsTab.exportTarget();
  const info = el('div', 'color:#6b7180;font-size:10px;margin-bottom:3px');
  info.textContent = tgt ? 'цель: загруженная модель (со скином)' : 'цель: канон-манекен (атлас не загружен)';
  body.append(info);
  const row = el('div', 'display:flex;flex-wrap:wrap;gap:4px;align-items:center'); body.append(row);
  const sel = document.createElement('select'); sel.style.cssText = impInput;
  const opts: [NameProfile, string][] = [['canon', 'имена: канон (Unity)'], ['model', 'имена: как в модели'], ['ue5', 'имена: UE5 Mannequin'], ['mixamo', 'имена: Mixamo']];
  for (const [v, lb] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = lb; o.selected = v === expProfile; sel.append(o); }
  sel.onchange = () => { expProfile = sel.value as NameProfile; };
  row.append(sel);

  if (wantFingers()) row.append(pbtn(expBakeFingers ? 'пальцы: впечь' : 'пальцы: пресетом', () => { expBakeFingers = !expBakeFingers; renderAnim(); }, expBakeFingers));

  const doExport = (clips0: Clip[], fname: string): void => {
    if (!clips0.length) { expStatus = 'нечего экспортировать'; renderAnim(); return; }
    // Хват впекается в КОПИЮ клипов — библиотека остаётся чистой (инвариант Ф1.6: клип = только углы костей).
    const clips = (expBakeFingers && wantFingers())
      ? clips0.map((c) => bakeGripIntoClip({ ...c, keys: c.keys.map((k) => ({ ...k, pose: clonePose(k.pose) })) }, curGripPose()))
      : clips0;
    // Манекен отдаём В T-ПОЗЕ: бинд-поза в GLB должна быть канонической, иначе в чужом движке
    // все клипы приедут со смещением от той случайной позы, в которой был манекен в момент клика.
    const saved = readPoseFull();
    const target = tgt ? tgt.root : (human.reset(), human.root);
    void exportClipsToGLB(target, clips, {
      profile: tgt ? expProfile : (expProfile === 'model' ? 'canon' : expProfile),
      nativeProfile: tgt ? 'model' : 'canon',   // атлас уже в своих именах, манекен — в каноне
      boneMap: tgt?.boneMap,
    })
      .then((res) => {
        downloadFile(fname + '.glb', res.glb, 'model/gltf-binary');
        downloadFile(fname + '.manifest.json', JSON.stringify(res.manifest, null, 2), 'application/json');
        expStatus = `✓ ${clips.length} клип(ов), ${(res.glb.byteLength / 1024).toFixed(0)} КБ`
          + (res.lostTracks.length ? ` ⚠ потеряно дорожек: ${res.lostTracks.length} (имена костей не совпали)` : '');
      })
      .catch((e: unknown) => { expStatus = '✗ ' + String(e); })
      .finally(() => { applyPose(saved); if (mode === 'ik') captureRig(); renderAnim(); });
  };

  const cur = curClip();
  row.append(
    pbtn('⬇ клип', () => { if (cur) doExport([cur], cur.name); }),
    pbtn('⬇ все клипы персонажа', () => doExport(library.filter((x) => x.character === curCharId), curCharId + '_anims')),
  );
  if (expStatus) { const st = el('div', 'font-size:10px;margin-top:3px;color:' + (expStatus[0] === '✗' ? '#e08080' : '#9ae6a0')); st.textContent = expStatus; body.append(st); }
}
function clipSection(): void {
  const list = clipsHere();
  const info = el('div', 'color:#9ae6a0;margin-bottom:4px'); info.textContent = `${curChar().name} · ${weapon} · клипов: ${list.length}`; body.append(info);
  const row1 = el('div', ''); body.append(row1);
  const nameFree = (nm: string): string => { let n = nm, i = 2; while (library.some((x) => x.name === n && x.character === curCharId && x.weapon === weapon)) n = nm + '_' + i++; return n; };
  // Вставить позу из буфера в ТЕКУЩЕЕ оружие: глубокий клон кадров + ретаргет имени (idle_меч→idle_топор). Игра подхватит.
  const pasteHere = (): void => {
    if (!clipBuf) return;
    let name = retargetClipName(clipBuf.name, clipBuf.weapon, weapon);
    const taken = (nm: string): boolean => library.some((x) => x.name === nm && x.character === curCharId && x.weapon === weapon);
    if (clipBuf.weapon === weapon) name = nameFree(name);                                   // то же оружие = дубликат → не затирать
    else if (taken(name) && !confirm('Клип «' + name + '» на «' + weapon + '» уже есть — перезаписать?')) return;
    const nc: Clip = { name, character: curCharId, weapon, loop: clipBuf.loop, keys: clipBuf.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) };
    histLib('вставить клип', () => {
      const i = library.findIndex((x) => x.name === name && x.character === curCharId && x.weapon === weapon);
      if (i >= 0) library[i] = nc; else library.push(nc);
      if (clipBufWasAtk) { const arr = ((atkCfgs[curCharId] ??= {})[weapon] ??= []); if (!arr.includes(name)) { arr.push(name); saveAtk(); } }
      saveLib(); clipIdx = Math.max(0, clipsHere().findIndex((x) => x.name === name)); frameIdx = 0; refreshAll();
    });
  };
  row1.append(pbtn('+ новый', () => { const nm = prompt('имя клипа (действие)', 'clip' + (list.length + 1)); if (!nm) return; histLib('новый клип', () => { library.push({ name: nameFree(nm), character: curCharId, weapon, loop: false, keys: [{ pose: readPoseFull(), t: 0 }] }); clipIdx = list.length; frameIdx = 0; saveLib(); refreshAll(); }); }));
  row1.append(pbtn('📥 из FBX/BVH', () => openImportAnimModal()));   // импорт мокап/AI-анимации → наш клип (запекатель)
  if (clipBuf) row1.append(pbtn('⎘ вставить: ' + retargetClipName(clipBuf.name, clipBuf.weapon, weapon), pasteHere));   // буфер переживает смену оружия/персонажа
  const c = curClip();
  if (c) {
    row1.append(
      pbtn('⎘ копир', () => { clipBuf = { name: c.name, character: curCharId, weapon, loop: c.loop, keys: c.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) }; clipBufWasAtk = atkList().includes(c.name); refreshAll(); }),
      pbtn('дубл', () => histLib('дублировать клип', () => { library.push({ name: nameFree(c.name + '_copy'), character: curCharId, weapon, loop: c.loop, keys: c.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) }); saveLib(); refreshAll(); })),
      pbtn('переим', () => {
        const nm = prompt('имя клипа', c.name); if (!nm || nm === c.name) return;
        if (library.some((x) => x !== c && x.name === nm && x.character === curCharId && x.weapon === weapon)) { alert('Клип «' + nm + '» на этом оружии уже есть — выберите другое имя.'); return; }
        const wasConv = ['idle_', 'hit_', 's_hit_'].some((p) => c.name === p + weapon), stillConv = ['idle_', 'hit_', 's_hit_'].some((p) => nm === p + weapon);
        if (wasConv && !stillConv && !confirm('«' + c.name + '» — конвенционное имя, игра ищет позу по нему. Переименование отвяжет её от оружия. Продолжить?')) return;
        histLib('переименовать клип', () => { const old = c.name; c.name = nm; const arr = atkCfgs[curCharId]?.[weapon]; if (arr) { const j = arr.indexOf(old); if (j >= 0) { arr[j] = nm; saveAtk(); } }
        saveLib(); refreshAll(); });
      }),
      pbtn('удалить', () => { if (confirm('Удалить клип «' + c.name + '»?')) delClip(c); }),
      pbtn(c.loop ? '↻ луп' : '→ 1 раз', () => histLib('луп клипа', () => { c.loop = !c.loop; saveLib(); refreshAll(); }), c.loop),
      pbtn('⚙ запечь физику', () => { void bakeCurrentClip(); }),
    );
  }
  const selr = el('div', 'display:flex;flex-wrap:wrap;gap:3px;margin-top:5px'); body.append(selr);
  list.forEach((cl, i) => {   // клип = кнопка выбора + ✗ удалить (любую позу/анимацию прямо из списка)
    const grp = el('div', 'display:inline-flex;align-items:center');
    grp.append(pbtn(cl.name, () => { clipIdx = i; frameIdx = 0; goFrame(0); }, i === clipIdx));
    grp.append(pbtn('✗', () => { if (confirm('Удалить «' + cl.name + '»?')) delClip(cl); }));
    selr.append(grp);
  });
  if (!list.length) { const e = el('div', 'color:#d0a060;font-size:11px'); e.textContent = 'Нет клипов для этого оружия. «+ новый» создаёт из текущей позы.'; body.append(e); }
  if (c) {
    const isAtk = isAttackClip(c); const lockEnds = isAtk || !!c.idleEnds; const lastI = c.keys.length - 1;   // концы = стойка (удар hit_ ИЛИ импорт с idleEnds)
    const isEnd = (i: number): boolean => lockEnds && (i === 0 || i === lastI);
    const fh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); fh.textContent = `КАДРЫ (${c.keys.length}) · длит. ${clipDur(c).toFixed(2)}с` + (lockEnds ? ' · 🔒кадры 1/' + (lastI + 1) + ' из стойки' : ''); body.append(fh);
    const fr = el('div', 'display:flex;flex-wrap:wrap;gap:2px'); body.append(fr);
    c.keys.forEach((kf, i) => fr.append(pbtn(`${isEnd(i) ? '🔒' : ''}${i + 1}·${kf.t.toFixed(2)}`, () => goFrame(i), i === frameIdx)));
    const kf = c.keys[frameIdx];
    if (kf) {
      const tr = el('label', 'display:flex;align-items:center;gap:6px;margin-top:4px'); tr.innerHTML = '<span style="flex:1">время кадра (с)</span>';
      const ti = el('input', 'width:70px') as HTMLInputElement; ti.type = 'number'; ti.min = '0'; ti.step = '0.05'; ti.value = kf.t.toFixed(2);
      ti.onchange = () => histLib('время кадра', () => { kf.t = Math.max(0, parseFloat(ti.value) || 0); sortKeys(c); saveLib(); refreshAll(); });
      tr.append(ti); body.append(tr);
    }
    const act = el('div', 'margin-top:5px'); body.append(act);
    const atEnd = isEnd(frameIdx);
    act.append(
      atEnd
        ? pbtn('🔒 кадр из стойки', () => { alert('Крайние кадры — это idle-стойка, тут не редактируются. Правь стойку: таб «Бег» → «захватить стойку», концы всех клипов (удары + импорт) подхватят.'); })
        : pbtn('◉ записать кадр', () => histLib('записать кадр', () => { if (c.keys[frameIdx]) c.keys[frameIdx]!.pose = readPoseFull(); saveLib(); })),
      pbtn('+ кадр', () => histLib('добавить кадр', () => { const insAt = lockEnds ? Math.max(1, Math.min(frameIdx + 1, lastI)) : frameIdx + 1; const a = c.keys[insAt - 1], b = c.keys[insAt]; const nt = (a && b) ? (a.t + b.t) / 2 : (a ? a.t + DEF_GAP : 0); c.keys.splice(insAt, 0, { pose: readPoseFull(), t: nt }); frameIdx = insAt; saveLib(); refreshAll(); })),   // концы-стойка неприкосновенны → вставка в середину
      pbtn('− кадр', () => histLib('удалить кадр', () => { if (!atEnd && c.keys.length > (lockEnds ? 3 : 1)) { c.keys.splice(frameIdx, 1); frameIdx = Math.min(frameIdx, c.keys.length - 1); saveLib(); refreshAll(); } })),   // концы не удалить
    );
    // подтянуть позу в текущий кадр из соседнего (строить замах/удар от концов-idle, потом править)
    if (!atEnd) {
      const pr2 = el('div', 'margin-top:3px'); body.append(pr2);
      const pull = (get: () => Pose): void => histLib('поза из соседнего кадра', () => { const kk = c.keys[frameIdx]; if (kk) { kk.pose = get(); saveLib(); goFrame(frameIdx); } });
      if (frameIdx > 0) pr2.append(pbtn('◀ из пред.', () => pull(() => clonePose(c.keys[frameIdx - 1]!.pose))));
      if (frameIdx < lastI) pr2.append(pbtn('из след. ▶', () => pull(() => clonePose(c.keys[frameIdx + 1]!.pose))));
      if (frameIdx > 0 && frameIdx < lastI) pr2.append(pbtn('⇄ середина (пред+след)', () => pull(() => blendTwo(c.keys[frameIdx - 1]!.pose, c.keys[frameIdx + 1]!.pose, 0.5))));
    }
    { const vr = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(vr);
    vr.append(pbtn('🧅 призраки соседних кадров', () => { onionOn = !onionOn; refreshAll(); }, onionOn));
    trajBtn = pbtn(trajLabel(), () => { trajOn = !trajOn; refreshAll(); }, trajOn);
    trajBtn.title = 'Путь выбранной кости за весь клип. Расстояние между точками = скорость (сетка времени равномерная).';
    vr.append(trajBtn); }
  curveSection(c);
  }
  const eh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); eh.textContent = 'ЭКСПОРТ / ИМПОРТ'; body.append(eh);
  const ta = el('textarea', 'width:100%;height:70px;background:#0e1016;color:#9ae6a0;border:1px solid #39415a;border-radius:4px;font:10px monospace') as HTMLTextAreaElement; body.append(ta);
  const er = el('div', ''); body.append(er);
  er.append(pbtn('клип', () => { if (c) ta.value = JSON.stringify(c); }), pbtn('всё', () => { ta.value = JSON.stringify(library); }), pbtn('копир', () => navigator.clipboard?.writeText(ta.value)), pbtn('импорт', () => histLib('импорт JSON', () => { try { const d = JSON.parse(ta.value); const arr = Array.isArray(d) ? d : [d]; const cl = arr.map(migrateClip); if (Array.isArray(d)) library = cl; else library.push(...cl); saveLib(); refreshAll(); } catch { /* */ } })));
}

// Сохранение внешности персонажа: конфиг-персонаж/фракция (builtin) → серверный pe_appearance (ростер-СПИСОК остаётся
// из конфига, тут лишь пол/телосложение/оружие); свой персонаж → pe_chars. Оба уходят на сервер (единая истина).
function loadAppearanceRaw(): Record<string, unknown> { try { return (JSON.parse(localStorage.getItem('pe_appearance') || '{}') as Record<string, unknown>) || {}; } catch { return {}; } }
function saveCharEdit(c: Char): void {
  if (c.builtin) {
    const ap = loadAppearanceRaw();
    ap[c.id] = { gender: c.gender, build: c.build, weapon: c.weapon };
    localStorage.setItem('pe_appearance', JSON.stringify(ap)); savePoseKey('pe_appearance');
  } else {
    localStorage.setItem('pe_chars', JSON.stringify(customChars)); savePoseKey('pe_chars');
  }
}

// Вкладка ПЕРСОНАЖ
function renderChar(): void {
  body.innerHTML = '';
  const c = curChar();
  const info = el('div', 'color:#9ae6a0;margin-bottom:6px'); info.textContent = `${c.name}${c.builtin ? ' (из конфига)' : ' (свой)'} · ${c.gender} · ${c.weapon}`; body.append(info);
  const sl = (label: string, key: keyof BuildScale): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px'); row.innerHTML = `<span style="flex:1">${label}</span>`;
    const s = el('input', 'width:110px') as HTMLInputElement; s.type = 'range'; s.min = '0.6'; s.max = '1.4'; s.step = '0.02'; s.value = String(c.build[key] ?? 1);
    const v = el('span', 'width:36px;text-align:right;color:#9ae6a0'); v.textContent = String(c.build[key] ?? 1);
    s.oninput = () => { c.build[key] = parseFloat(s.value); v.textContent = s.value; applyChar(c.id); tab = 'char'; refreshAll(); };
    s.onchange = () => saveCharEdit(c);   // персист внешности на отпускание (без спама сервера на каждый пиксель)
    row.append(s, v); body.append(row);
  };
  const th = el('div', 'color:#8fb7ff;font-weight:bold;margin:6px 0 2px'); th.textContent = 'ТЕЛОСЛОЖЕНИЕ'; body.append(th);
  sl('руки', 'arm'); sl('ноги', 'leg'); sl('торс', 'torso'); sl('голова', 'head');
  const gh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); gh.textContent = 'ПОЛ'; body.append(gh);
  body.append(pbtn('male', () => { c.gender = 'male'; saveCharEdit(c); applyChar(c.id); tab = 'char'; refreshAll(); }, c.gender === 'male'), pbtn('female', () => { c.gender = 'female'; saveCharEdit(c); applyChar(c.id); tab = 'char'; refreshAll(); }, c.gender === 'female'));
  const wh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); wh.textContent = 'ОРУЖИЕ ПО УМОЛЧАНИЮ'; body.append(wh);
  const wsel = el('select', 'margin:2px 0') as HTMLSelectElement;
  const wopts = WEAPONS.includes(c.weapon) ? WEAPONS : [c.weapon, ...WEAPONS];   // combo-дефолт (напр. sword+shield) сохраняем опцией
  for (const w of wopts) { const o = document.createElement('option'); o.value = w; o.textContent = w; if (w === c.weapon) o.selected = true; wsel.append(o); }
  wsel.onchange = () => { c.weapon = wsel.value; saveCharEdit(c); setWeapon(c.weapon); tab = 'char'; refreshAll(); };   // дефолт-оружие класса/фракции (игра берёт его)
  body.append(wsel);
  // Подмешивание ЩИТА per-оружие: при выбранной офф-руке «щит» вес хранится под ключом main+shield; иначе редактируется база.
  const isShieldKey = weapon.endsWith('+shield');
  const sh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); sh.textContent = 'ПОДМЕШИВАНИЕ ЩИТА' + (isShieldKey ? ' — ' + weapon : ' (база)'); body.append(sh);
  const shRow = el('label', 'display:flex;align-items:center;gap:6px'); shRow.innerHTML = '<span style="flex:1">вес (поза щита → рука+корпус)</span>';
  const shs = el('input', 'width:110px') as HTMLInputElement; shs.type = 'range'; shs.min = '0'; shs.max = '1'; shs.step = '0.05'; shs.value = String(shieldMixFor(weapon));
  const shv = el('span', 'width:36px;text-align:right;color:#9ae6a0'); shv.textContent = shieldMixFor(weapon).toFixed(2);
  shs.oninput = () => { setShieldMix(weapon, parseFloat(shs.value)); shv.textContent = parseFloat(shs.value).toFixed(2); };   // превью бега с '+shield'-оружием читает живьём
  shs.onchange = () => saveShield();
  shRow.append(shs, shv); body.append(shRow);
  const shHint = el('div', 'color:#8f897c;font-size:10px;margin-top:2px'); shHint.textContent = isShieldKey
    ? 'позу щита дотюнь для ЭТОГО оружия: авторь клип «idle_' + weapon + '» (иначе берётся базовая «idle_shield»).'
    : 'база: авторь «idle_shield» (оружие «shield» → левая рука → «захватить стойку»). Для тюна под оружие выбери офф-руку «щит».'; body.append(shHint);
  morphSection();
  const ah = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); ah.textContent = 'СВОИ ПЕРСОНАЖИ'; body.append(ah);
  body.append(pbtn('+ создать из текущего', () => { const nm = prompt('имя персонажа', 'char' + (customChars.length + 1)); if (!nm) return; const id = 'c' + Date.now(); customChars.push({ id, name: nm, gender: c.gender, build: { ...c.build }, weapon }); localStorage.setItem('pe_chars', JSON.stringify(customChars)); savePoseKey('pe_chars'); applyChar(id); }));
  if (!c.builtin) body.append(pbtn('удалить персонажа', () => { customChars = customChars.filter((x) => x.id !== c.id); localStorage.setItem('pe_chars', JSON.stringify(customChars)); savePoseKey('pe_chars'); applyChar(CLASS_CHARS[0]!.id); }));
}

// ── Ф9: ВКЛАДКА ИИ ──
// Никакой новой инфраструктуры: запрос → сервис → BVH → УЖЕ СУЩЕСТВУЮЩИЙ запекатель → клип в библиотеке.
// Сервиса у нас пока нет, поэтому есть и режим «из файла» — чтобы весь путь проверялся уже сейчас.
let aiCfg: AiConfig = (() => { try { return { ...DEFAULT_AI_CONFIG(), ...(JSON.parse(localStorage.getItem('pe_ai') || '{}') as AiConfig) }; } catch { return DEFAULT_AI_CONFIG(); } })();
let aiStatus = '';
function saveAi(): void { try { localStorage.setItem('pe_ai', JSON.stringify(aiCfg)); savePoseKey('pe_ai'); } catch { /* */ } }

/** Общий хвост: BVH-текст → клип в библиотеке (тем же запекателем, что и ручной импорт FBX/BVH). */
async function aiBvhToClip(bvh: string, label: string): Promise<void> {
  if (!looksLikeBvh(bvh)) { aiStatus = '✗ это не похоже на BVH'; refreshAll(); return; }
  const { bakeAnimationToClip } = await import('./clipBaker.js');
  const file = new File([bvh], 'ai.bvh', { type: 'text/plain' });
  const idle = resolveUpper(weapon)?.pose;
  const name = generatedClipName(label, library.filter((c) => c.character === curCharId && c.weapon === weapon).map((c) => c.name));
  try {
    const r = await bakeAnimationToClip(file, { character: curCharId, weapon, name, idlePose: idle, anchorIdle: !!idle });
    histLib('ИИ: добавить клип', () => { library.push(r.clip); clipIdx = clipsHere().length - 1; frameIdx = 0; saveLib(); });
    aiStatus = `✓ «${r.clip.name}»: ${r.frames} кадров → ${r.keys} ключей`;
  } catch (e) { aiStatus = '✗ ' + String(e); }
  refreshAll();
}

function renderAi(): void {
  body.innerHTML = '';
  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin-bottom:4px'); h.textContent = 'ГЕНЕРАЦИЯ АНИМАЦИИ'; body.append(h);
  const hint = el('div', 'color:#6b7180;font-size:10px;margin-bottom:5px');
  hint.textContent = 'ответ ожидается BVH (его отдают text-to-motion модели) либо JSON с нашим клипом';
  body.append(hint);

  const urlRow = el('label', 'display:flex;align-items:center;gap:5px;margin-bottom:3px');
  urlRow.innerHTML = '<span style="width:52px;font-size:11px">сервис</span>';
  const url = el('input', 'flex:1;' + impInput) as HTMLInputElement;
  url.placeholder = 'https://…/generate'; url.value = aiCfg.url;
  url.onchange = () => { aiCfg.url = url.value.trim(); saveAi(); };
  urlRow.append(url); body.append(urlRow);

  const pr = el('textarea', 'width:100%;height:52px;box-sizing:border-box;' + impInput) as HTMLTextAreaElement;
  pr.placeholder = 'опиши движение: «широкий замах двуручным топором сверху вниз»';
  pr.value = aiCfg.prompt; pr.onchange = () => { aiCfg.prompt = pr.value; saveAi(); };
  body.append(pr);

  const secRow = el('label', 'display:flex;align-items:center;gap:5px;margin:3px 0');
  secRow.innerHTML = '<span style="flex:1;font-size:11px">длительность, с</span>';
  const sec = el('input', 'width:56px;' + impInput) as HTMLInputElement;
  sec.type = 'number'; sec.step = '0.5'; sec.min = '0.5'; sec.value = String(aiCfg.seconds);
  sec.onchange = () => { aiCfg.seconds = parseFloat(sec.value) || 2; saveAi(); };
  secRow.append(sec); body.append(secRow);

  const row = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(row);
  row.append(pbtn('✦ сгенерировать', () => {
    aiStatus = '… запрос'; refreshAll();
    void requestGeneration(aiCfg, { prompt: pr.value, seconds: aiCfg.seconds, character: curCharId, weapon }).then(async (r) => {
      if (r.error) { aiStatus = '✗ ' + r.error; refreshAll(); return; }
      if (r.clip) { histLib('ИИ: добавить клип', () => { library.push(migrateClip(r.clip)); saveLib(); }); aiStatus = '✓ клип принят'; refreshAll(); return; }
      await aiBvhToClip(r.bvh ?? '', pr.value);
    });
  }));
  // Путь «из файла» — чтобы вся цепочка проверялась без сервиса.
  const fi = el('input', 'display:none') as HTMLInputElement;
  fi.type = 'file'; fi.accept = '.bvh,text/plain';
  fi.onchange = () => { const f = fi.files?.[0]; if (f) void f.text().then((t) => aiBvhToClip(t, pr.value || f.name)); };
  body.append(fi);
  row.append(pbtn('↑ BVH из файла', () => fi.click()));
  if (aiStatus) { const st = el('div', 'font-size:10px;margin-top:4px;color:' + (aiStatus[0] === '✗' ? '#e08080' : '#9ae6a0')); st.textContent = aiStatus; body.append(st); }
  const note = el('div', 'color:#6b7180;font-size:10px;margin-top:6px');
  note.textContent = 'сгенерированный клип — обычный: правь кадры, кривые и позы руками, потом экспортируй как всё остальное';
  body.append(note);
}

// ── Ф8: МОРФИНГ ТЕЛА ──
// Простой: сетка пресетов 3×3 + два глобальных слайдера — меняется всё тело сразу.
// Про: замеры по регионам + ЗАКРЕПЛЕНИЕ параметра (пресет его не перебивает) + диапазоны для монстров.
function rebuildForMorph(): void { applyChar(curCharId); tab = 'char'; refreshAll(); }
function morphSection(): void {
  const m = curMorph();
  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:10px 0 2px;border-top:1px solid #39415a;padding-top:8px');
  h.textContent = 'ТЕЛОСЛОЖЕНИЕ (морф)'; body.append(h);

  const grid = el('div', 'display:grid;grid-template-columns:repeat(3,1fr);gap:2px'); body.append(grid);
  for (const pr of MORPH_PRESETS) {
    grid.append(pbtn(pr.label, () => {
      morphCfg[curCharId] = applyMorphChange(m, pr.morph, morphPinned);
      saveMorph(); rebuildForMorph();
    }));
  }

  const knob = (key: MorphKey, label: string, min = 0.7, max = 1.4): void => {
    const row = el('label', 'display:flex;align-items:center;gap:5px'); 
    const lb = el('span', 'flex:1;font-size:11px'); lb.textContent = label; row.append(lb);
    if (uiPro) {
      const pin = pbtn(morphPinned.has(key) ? '●' : '○', () => { if (morphPinned.has(key)) morphPinned.delete(key); else morphPinned.add(key); renderChar(); }, morphPinned.has(key));
      pin.title = 'закрепить: пресеты и глобальные ручки этот параметр не трогают';
      pin.style.padding = '1px 4px'; row.append(pin);
    }
    const s = el('input', 'width:92px') as HTMLInputElement;
    s.type = 'range'; s.min = String(min); s.max = String(max); s.step = '0.01';
    s.value = String(m[key] ?? DEFAULT_MORPH[key]);
    const v = el('span', 'width:34px;text-align:right;color:#9ae6a0'); v.textContent = (m[key] ?? 1).toFixed(2);
    s.oninput = () => { m[key] = parseFloat(s.value); v.textContent = s.value; };
    s.onchange = () => { saveMorph(); rebuildForMorph(); };
    row.append(s, v); body.append(row);
  };
  knob('height', 'рост', 0.75, 1.25);
  knob('weight', 'худой ↔ полный', 0.7, 1.4);

  if (uiPro) {
    for (const reg of MORPH_REGIONS) {
      const rh = el('div', 'color:#6b7180;font-size:10px;margin-top:4px'); rh.textContent = reg.label; body.append(rh);
      for (const k of reg.keys) knob(k, k);
    }
    // Разброс для монстров: значение экземпляра берётся по СИДУ от его id — клиент и сервер видят одно и то же.
    const rg = (morphRanges[curCharId] ??= {});
    const rh2 = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); rh2.textContent = 'РАЗБРОС (экземпляры монстров)'; body.append(rh2);
    const rr = (key: MorphKey): void => {
      const cur = rg[key] ?? [1, 1];
      const row = el('div', 'display:flex;align-items:center;gap:4px'); body.append(row);
      const lb = el('span', 'flex:1;font-size:11px'); lb.textContent = key; row.append(lb);
      for (const i of [0, 1] as const) {
        const inp = el('input', 'width:46px;' + impInput) as HTMLInputElement;
        inp.type = 'number'; inp.step = '0.01'; inp.value = String(cur[i]);
        inp.onchange = () => { const nx: [number, number] = [cur[0], cur[1]]; nx[i] = parseFloat(inp.value) || 1; rg[key] = nx; saveMorph(); renderChar(); };
        row.append(inp);
      }
    };
    rr('height'); rr('weight');
    for (const w of rangeWarnings(rg)) { const e2 = el('div', 'color:#d0a060;font-size:10px'); e2.textContent = '⚠ ' + w; body.append(e2); }
    body.append(pbtn('≈ показать 6 случайных', () => {
      const rows = [0, 1, 2, 3, 4, 5].map((i) => { const sm = sampleMorph(rg, curCharId + '#' + i); return `${i}: рост ${(sm.height ?? 1).toFixed(2)} · полнота ${(sm.weight ?? 1).toFixed(2)}`; });
      alert('Экземпляры по сиду (один id — всегда один вид):\n' + rows.join('\n'));
    }));
  }

  const act = el('div', 'margin-top:4px'); body.append(act);
  act.append(
    pbtn('➕ сохранить как нового персонажа', () => {
      const c0 = curChar();
      const nm = prompt('имя вариации', c0.name + ' вариант'); if (!nm) return;
      const id = 'c' + Date.now();
      // ТОТ ЖЕ меш и та же сборка — меняется только набор чисел. Ноль дублирования мегабайт.
      customChars.push({ id, name: nm, gender: c0.gender, build: { ...c0.build }, weapon });
      morphCfg[id] = JSON.parse(JSON.stringify(m)) as BodyMorph;
      localStorage.setItem('pe_chars', JSON.stringify(customChars)); savePoseKey('pe_chars'); saveMorph();
      applyChar(id); tab = 'char'; refreshAll();
    }),
    pbtn('✕ сброс морфа', () => { morphCfg[curCharId] = {}; morphPinned = new Set(); saveMorph(); rebuildForMorph(); }),
  );
}

// Вкладка БЕГ — 2D бленд-дерево локомоции (Unity-стиль): узлы-клипы на VelX/VelZ, красная точка-семпл, превью на месте
const PAD = 240, PADM = 24;
const velToPad = (vx: number, vz: number): [number, number] => [PAD / 2 + vx * (PAD / 2 - PADM), PAD / 2 - vz * (PAD / 2 - PADM)];
const padToVel = (px: number, py: number): [number, number] => [clamp((px - PAD / 2) / (PAD / 2 - PADM), -1, 1), clamp(-(py - PAD / 2) / (PAD / 2 - PADM), -1, 1)];
function drawPad(cv: HTMLCanvasElement): void {
  const ctx = cv.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0, 0, PAD, PAD); ctx.fillStyle = '#181b24'; ctx.fillRect(0, 0, PAD, PAD);
  ctx.strokeStyle = '#2a3040'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const p = PADM + i * (PAD - 2 * PADM) / 4; ctx.beginPath(); ctx.moveTo(p, PADM); ctx.lineTo(p, PAD - PADM); ctx.moveTo(PADM, p); ctx.lineTo(PAD - PADM, p); ctx.stroke(); }
  ctx.strokeStyle = '#3a4258'; ctx.beginPath(); ctx.moveTo(PAD / 2, PADM); ctx.lineTo(PAD / 2, PAD - PADM); ctx.moveTo(PADM, PAD / 2); ctx.lineTo(PAD - PADM, PAD / 2); ctx.stroke();
  ctx.fillStyle = '#5a6478'; ctx.font = '9px monospace'; ctx.fillText('вперёд', PAD / 2 + 3, PADM + 9); ctx.fillText('назад', PAD / 2 + 3, PAD - PADM - 3); ctx.fillText('П', PAD - PADM - 8, PAD / 2 - 3); ctx.fillText('Л', PADM + 2, PAD / 2 - 3);
  if (editPlant) {   // 16 точек-ячеек плантов: внешнее кольцо (mag .95) = БЕГ, внутреннее (.34) = ХОДЬБА; активная подсвечена
    for (const run of [false, true]) for (let i = 0; i < 8; i++) {
      const th = i * DIR_STEP, mag = run ? 0.95 : 0.34; const [px, py] = velToPad(Math.sin(th) * mag, Math.cos(th) * mag);
      const on = i === plantDirSel && run === plantSpeedRun;
      ctx.beginPath(); ctx.arc(px, py, on ? 6 : 4, 0, 7); ctx.fillStyle = on ? '#ffd24a' : run ? '#46d07a' : '#357a52'; ctx.fill();
      if (on) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
    }
  }
  const [sx, sy] = velToPad(locoVx, locoVz); ctx.fillStyle = '#ff5a4a'; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();   // красная точка = вектор скорости/направление
}
function renderLoco(): void {
  body.innerHTML = '';
  const info = el('div', 'color:#9ae6a0;margin-bottom:4px'); info.textContent = `${curChar().name} · ${weapon} · бег = idle-стойка + физпокачивание + физ-ноги`; body.append(info);
  const cv = document.createElement('canvas'); cv.width = PAD; cv.height = PAD; cv.style.cssText = 'width:100%;max-width:250px;display:block;border:1px solid #39415a;border-radius:6px;touch-action:none;cursor:crosshair'; body.append(cv);
  const redraw = (): void => drawPad(cv); redraw();
  // Выбор ЯЧЕЙКИ планта = клик по одной из 16 точек на квадрате (8 внешних = бег, 8 внутренних = ходьба).
  const goDir = (i: number, run: boolean): void => { gaitFaceMove = false; gaitYawManual = 0; const th = i * DIR_STEP, mag = run ? 0.95 : 0.34; locoVz = Math.cos(th) * mag; locoVx = Math.sin(th) * mag; plantDirSel = i; plantSpeedRun = run; if (!locoOn) { locoOn = true; gaitPx = 0; gaitPz = 0; locoPlayer?.resetPos(); void ensurePhysics(); } renderLoco(); };
  const hitPlantPoint = (ev: PointerEvent): boolean => {
    const r = cv.getBoundingClientRect(); const mx = (ev.clientX - r.left) / r.width * PAD, my = (ev.clientY - r.top) / r.height * PAD;
    let best = -1, bestRun = true, bestD = 15;   // порог попадания в точку, px
    for (const run of [false, true]) for (let i = 0; i < 8; i++) { const th = i * DIR_STEP, mag = run ? 0.95 : 0.34; const [px, py] = velToPad(Math.sin(th) * mag, Math.cos(th) * mag); const d = Math.hypot(mx - px, my - py); if (d < bestD) { bestD = d; best = i; bestRun = run; } }
    if (best >= 0) { goDir(best, bestRun); return true; }
    return false;
  };
  let drag = false;
  const setFrom = (ev: PointerEvent): void => { const r = cv.getBoundingClientRect(); [locoVx, locoVz] = padToVel((ev.clientX - r.left) / r.width * PAD, (ev.clientY - r.top) / r.height * PAD); redraw(); };
  cv.addEventListener('pointerdown', (ev) => { if (editPlant && hitPlantPoint(ev)) return; drag = true; cv.setPointerCapture(ev.pointerId); setFrom(ev); });   // в режиме плантов клик по точке = выбор ячейки
  cv.addEventListener('pointermove', (ev) => { if (drag) setFrom(ev); });
  cv.addEventListener('pointerup', () => { drag = false; });
  body.append(pbtn(locoOn ? '⏸ стоп' : '▶ превью бега', () => { locoOn = !locoOn; if (locoOn) { gaitPx = 0; gaitPz = 0; locoPlayer?.resetPos(); void ensurePhysics(); } else goFrame(frameIdx); renderLoco(); }, locoOn));   // стоп → вернуть манекен к авторскому кадру (не застывать на шаге)
  const tr = el('label', 'display:flex;align-items:center;gap:6px;margin-top:6px'); tr.innerHTML = '<span style="flex:1">скорость просмотра (замедл./×)</span>';
  const ts = el('input', 'flex:2') as HTMLInputElement; ts.type = 'range'; ts.min = '0.1'; ts.max = '2'; ts.step = '0.05'; ts.value = String(locoTempo);
  const tv = el('span', 'width:34px;text-align:right;color:#9ae6a0'); tv.textContent = locoTempo.toFixed(2);
  ts.oninput = () => { locoTempo = parseFloat(ts.value); tv.textContent = locoTempo.toFixed(2); }; tr.append(ts, tv); body.append(tr);
  // Facing: тумблер «по движению»(поворот) / «фикс»(страйф) + угол при фиксе.
  const fr = el('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;align-items:center'); body.append(fr);
  fr.append(pbtn(gaitFaceMove ? 'лицом: по движению' : 'лицом: фикс (страйф)', () => { gaitFaceMove = !gaitFaceMove; renderLoco(); }, gaitFaceMove));
  fr.append(pbtn('редакт. планты', () => { editPlant = !editPlant; if (!editPlant && plantDrag >= 0) { plantDrag = -1; dragMark = null; gizmo.detach(); } renderLoco(); }, editPlant));
  if (editPlant) {   // ячейку выбираешь КЛИКОМ по точке на квадрате; правка — тянешь маркеры в сцене (плант + точки обвода via)
    const cb = el('div', 'flex:1 1 100%;margin-top:3px;border:1px solid #39415a;border-radius:6px;padding:4px'); fr.append(cb);
    const hint = el('div', 'font-size:11px;color:#8fb7ff'); hint.textContent = `${DIR8[plantDirSel]} · ${plantSpeedRun ? 'бег' : 'шаг'} — плант: СИНИЙ=Л / КРАСНЫЙ=П (тяни). Точки обвода — тех же цветов, мельче. Жёлтый = живая цель (динамика).`; cb.append(hint);
    const vr = el('div', 'display:flex;gap:2px;margin-top:3px;align-items:center'); cb.append(vr);
    const vl = el('span', 'font-size:11px;color:#9ae6a0'); vl.textContent = 'обвод (via):'; vr.append(vl);
    vr.append(pbtn('нога: ' + (viaLeg === 0 ? 'Л' : 'П'), () => { viaLeg = viaLeg === 0 ? 1 : 0; renderLoco(); }, true));
    vr.append(
      pbtn('+ точка', () => { const c = selCell(); const arr = viaLeg === 0 ? (c.lVia ??= []) : (c.rVia ??= []); if (arr.length < MAX_VIA) { arr.push([2, viaLeg === 0 ? 12 : -12]); saveGaitCfg(); renderLoco(); } }),
      pbtn('− точка', () => { const c = selCell(); const arr = viaLeg === 0 ? c.lVia : c.rVia; if (arr && arr.length) { arr.pop(); saveGaitCfg(); renderLoco(); } }),
    );
    const rr = el('div', 'display:flex;gap:2px;margin-top:3px'); cb.append(rr);
    rr.append(
      pbtn('сброс ячейки', () => { (plantSpeedRun ? gaitPlant.run : gaitPlant.walk)[plantDirSel] = zeroLeg(); saveGaitCfg(); }),
      pbtn('сброс всех', () => { Object.assign(gaitPlant, emptyGrid()); saveGaitCfg(); renderLoco(); }),
    );
  }
  if (!gaitFaceMove) {
    const yr = el('label', 'display:flex;align-items:center;gap:6px;flex:1 1 100%'); yr.innerHTML = '<span style="flex:1">угол (°)</span>';
    const ys = el('input', 'flex:2') as HTMLInputElement; ys.type = 'range'; ys.min = '-180'; ys.max = '180'; ys.step = '5'; ys.value = String(Math.round(gaitYawManual * 180 / Math.PI));
    const yv = el('span', 'width:40px;text-align:right;color:#9ae6a0'); yv.textContent = ys.value + '°';
    ys.oninput = () => { gaitYawManual = parseFloat(ys.value) * Math.PI / 180; yv.textContent = ys.value + '°'; }; yr.append(ys, yv); fr.append(yr);
  }
  gaitReadout = el('div', 'color:#8fb7ff;font-size:11px;margin-top:4px'); gaitReadout.textContent = 'скорость: — (пад: центр → шаг, край → бег)'; body.append(gaitReadout);
  bakeGaitSection();
  if (uiPro) renderGaitTune();   // тюнинг походки (24 ползунка GAIT/POSE/GX) — только Про
  renderUpperPanel();
  renderAttackPanel();
}
/** Панель настройки процедурного бега (GX/POSE/GAIT). Меняет живые объекты + пишет per-character в pe_gait. */
// Ф2.1: запечь процедурную походку в обычные клипы (после этого клиенту StepPlanner не нужен)
let bakeStatus = '';
function bakeGaitSection(): void {
  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); h.textContent = 'ЗАПЕЧЬ ПОХОДКУ В КЛИПЫ'; body.append(h);
  const info = el('div', 'color:#6b7180;font-size:10px'); info.textContent = `${GAIT_PRESETS.length} режимов (стойка/шаг/бег/страйф/диагонали) → обычные клипы для текущего оружия`; body.append(info);
  body.append(pbtn('⚙ запечь набор походки', () => {
    const wasLoco = locoOn; locoOn = false;                   // бейк сам гоняет плеера — цикл не должен мешать
    const player = lp();
    if (player.weapon !== weapon) player.setWeapon(weapon);
    player.gx = GX; player.plant = gaitPlant; player.twistStates = editorTwistStates;
    const t0 = performance.now();
    const out = bakeGaitSet(player, human, { character: curCharId, weapon, readPose: defaultReadPose(human) });
    const ms = performance.now() - t0;
    histLib('запечь походку', () => {
      for (const r of out) {
        const i = library.findIndex((x) => x.name === r.clip.name && x.character === curCharId && x.weapon === weapon);
        if (i >= 0) library[i] = r.clip; else library.push(r.clip);
      }
      saveLib();
    });
    const keys = out.reduce((a, r) => a + r.keys, 0), frames = out.reduce((a, r) => a + r.frames, 0);
    bakeStatus = `✓ ${out.length} клипов, ${frames} кадров → ${keys} ключей, ${ms.toFixed(0)} мс`;
    locoOn = wasLoco;
    refreshAll();
  }));
  if (bakeStatus) { const st = el('div', 'font-size:10px;margin-top:2px;color:#9ae6a0'); st.textContent = bakeStatus; body.append(st); }
}

function renderGaitTune(): void {
  const box = el('div', 'margin-top:8px;border:1px solid #39415a;border-radius:6px;padding:6px');
  const gsl = (label: string, obj: NumRec, key: string, min: number, max: number, step: number): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px');
    const nm = el('span', 'flex:1;font-size:11px'); nm.textContent = label; row.append(nm);
    const s = el('input', 'flex:2') as HTMLInputElement; s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(obj[key]);
    const v = el('span', 'width:42px;text-align:right;color:#9ae6a0;font-size:11px'); v.textContent = (+obj[key]!).toFixed(2);
    s.oninput = () => { obj[key] = parseFloat(s.value); v.textContent = obj[key]!.toFixed(2); saveGaitCfg(); };
    row.append(s, v); box.append(row);
  };
  const grp = (t: string): void => { const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:6px 0 1px;font-size:11px'); h.textContent = t; box.append(h); };
  const GXo = GX as unknown as NumRec, POSEo = POSE as unknown as NumRec, GAITo = GAIT as unknown as NumRec;
  // Руки РАЗДЕЛЬНО ходьба/бег (интерп по скорости sb, как ноги). Run-твины GX сидим из ходьбы, если ещё не заданы.
  if (GXo['armDownRun'] === undefined) GXo['armDownRun'] = GXo['armDown'] ?? 1.35;
  if (GXo['elbowBendRun'] === undefined) GXo['elbowBendRun'] = GXo['elbowBend'] ?? 0.25;
  grp('поза (ретаргет)');
  gsl('руки вниз (ходьба)', GXo, 'armDown', 0.6, 1.8, 0.01);
  gsl('руки вниз (бег)', GXo, 'armDownRun', 0.6, 1.8, 0.01);
  gsl('сгиб локтя (ходьба)', GXo, 'elbowBend', 0, 1.2, 0.02);
  gsl('сгиб локтя (бег)', GXo, 'elbowBendRun', 0, 1.2, 0.02);
  grp('руки (мах)');
  gsl('плечо база (ходьба)', POSEo, 'armSh', -0.8, 0.4, 0.02);
  gsl('плечо база (бег)', POSEo, 'armShRun', -0.8, 0.4, 0.02);
  gsl('локоть база (ходьба)', POSEo, 'armEl', 0, 1.4, 0.02);
  gsl('локоть база (бег)', POSEo, 'armElRun', 0, 1.4, 0.02);
  gsl('амплитуда маха (ходьба)', POSEo, 'armSwing', 0, 1.2, 0.02);
  gsl('амплитуда маха (бег)', POSEo, 'armSwingRun', 0, 1.2, 0.02);
  grp('ноги / посадка');
  // «высота таза» убрана — база берётся из idle-стойки (measureStancePlants.standY), чтобы бег/подшаг не подскакивали.
  gsl('присед (мин.таз)', GAITo, 'pelvisMin', 16, 34, 0.5);
  gsl('длина шага (ходьба)', GAITo, 'stepWalk', 10, 70, 1);
  gsl('длина шага (бег)', GAITo, 'stepRun', 10, 70, 1);
  gsl('боб таза × (ходьба)', GAITo, 'bobWalk', 0, 2, 0.05);
  gsl('боб таза × (бег)', GAITo, 'bobRun', 0, 2, 0.05);
  gsl('подъём стопы (ходьба)', GAITo, 'liftWalk', 2, 20, 0.5);
  gsl('подъём стопы (бег)', GAITo, 'liftRun', 2, 20, 0.5);
  gsl('скорость анимации бега (в игре, антискольз.)', GAITo, 'cadence', 0.5, 2, 0.05);
  gsl('доля опоры (ходьба)', GAITo, 'dutyWalk', 0.15, 0.5, 0.01);
  gsl('доля опоры (бег)', GAITo, 'dutyRun', 0.1, 0.35, 0.01);
  gsl('потолок бедра', GAITo, 'hipFwdLim', 0.4, 1.4, 0.02);
  gsl('ширина стойки', GAITo, 'stanceWidth', -6, 14, 0.5);
  gsl('вынос вбок (страйф)', GAITo, 'strafeReach', 0, 1.5, 0.05);
  gsl('предел кроссовера', GAITo, 'crossClamp', 0, 99, 1);
  box.append(pbtn('сброс настроек бега', () => { delete gaitCfgs[curCharId]; try { localStorage.setItem('pe_gait', JSON.stringify(gaitCfgs)); savePoseKey('pe_gait'); } catch { /* */ } applyGaitCfg(curCharId); renderLoco(); }));
  const twNote = el('div', 'color:#7a869e;font-size:10px;margin-top:6px'); twNote.textContent = 'Скрутка корпуса и приставной шаг при повороте — на вкладке «Повороты».'; box.append(twNote);
  // Экспорт/импорт настроек бега ВСЕХ персонажей (pe_gait) — портируемый артефакт (бэкап + вход для Ф5).
  const eh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px;font-size:11px'); eh.textContent = 'НАСТРОЙКИ БЕГА → JSON (все персонажи)'; box.append(eh);
  const ga = el('textarea', 'width:100%;height:56px;background:#0e1016;color:#9ae6a0;border:1px solid #39415a;border-radius:4px;font:10px monospace') as HTMLTextAreaElement; box.append(ga);
  const gr = el('div', 'display:flex;gap:2px;margin-top:2px'); box.append(gr);
  gr.append(
    pbtn('экспорт', () => { saveGaitCfg(); ga.value = JSON.stringify(gaitCfgs); }),
    pbtn('копир', () => navigator.clipboard?.writeText(ga.value)),
    pbtn('импорт', () => { try { const d = JSON.parse(ga.value) as typeof gaitCfgs; if (d && typeof d === 'object') { gaitCfgs = d; localStorage.setItem('pe_gait', JSON.stringify(gaitCfgs)); savePoseKey('pe_gait'); applyGaitCfg(curCharId); renderLoco(); } } catch { /* */ } }),
  );
  body.append(box);
}

// ── Вкладка «Повороты»: тест torso-lead как в игре (прицел=курсор) + приставные шаги + видимые планты ──
// Скорость превью каждой кнопки = РЕАЛЬНЫЙ якорь скорости (стой 0 / ходьба speedWalk / бег speedRun), нормировано на MAXSPD.
// Тогда blendTwist в этой точке отдаёт РОВНО профиль выбранного состояния → тюнишь кнопку и видишь её чистой (не смешанной).
function turnNormSpd(m: 'stand' | 'walk' | 'run'): number {
  return m === 'stand' ? 0 : (m === 'walk' ? GAIT.speedWalk : GAIT.speedRun) / GAIT_MAXSPD;
}
function updateTurnTest(_dt: number): void {
  gaitFaceMove = false; gaitYawManual = turnAim;                 // прицел = точка под курсором (голова/верх ведут за ним)
  const spd = turnNormSpd(turnTestMove);
  // Идём туда, куда смотрит ТАЗ (как в игре: тело идёт по своему фейсингу, а таз догоняет прицел с мёртвой зоной).
  if (spd > 0) { locoVx = Math.sin(editorRootYaw) * spd; locoVz = Math.cos(editorRootYaw) * spd; } else { locoVx = 0; locoVz = 0; }
}
function updateTurnPlants(): void {
  const show = tab === 'turn' && showTurnPlants && locoOn;
  for (let i = 0; i < 2; i++) {
    const cur = turnPlantMarks[i]!, goal = goalStanceMarks[i]!;
    cur.visible = show; goal.visible = show;
    if (!show) continue;
    const fb = human.bones.get(i === 0 ? 'LeftFoot' : 'RightFoot');   // ТЕКУЩАЯ позиция стопы (где нога сейчас) — сфера
    if (fb) { const fp = fb.getWorldPosition(V()); setXZ(cur, fp.x, fp.z); }
    const [gx, gz] = lp().driver.stanceAtGoal(i as 0 | 1);           // ЦЕЛЬ: идл-стойка на ПРИЦЕЛЕ (куда шагнёт после доворота) — кольцо
    setXZ(goal, gx - gaitPx, gz - gaitPz);
  }
}
function renderTurn(): void {
  body.innerHTML = '';
  if (!locoOn) { locoOn = true; gaitPx = 0; gaitPz = 0; locoPlayer?.resetPos(); void ensurePhysics(); }   // включаем превью
  const box = body;
  const info = el('div', 'color:#9ae6a0;margin-bottom:6px;font-size:12px'); info.innerHTML = 'Веди <b>курсором над сценой</b> — персонаж целится за ним (как в игре). Стоя: голова/плечи ведут, таз догоняет поочерёдными шагами. На ходу: таз идёт по движению, верх скручен к прицелу. Маркеры (синий Л / красный П): <b>сфера</b> = где стопа сейчас, <b>кольцо</b> = идл-стойка на прицеле (куда подшаг приземлится ПОСЛЕ доворота).';
  box.append(info);
  const mv = el('div', 'display:flex;gap:4px;margin:2px 0 6px;align-items:center'); box.append(mv);
  const lblMv: Record<'stand' | 'walk' | 'run', string> = { stand: 'стой', walk: 'ходьба', run: 'бег' };
  for (const k of ['stand', 'walk', 'run'] as const) mv.append(pbtn(lblMv[k], () => { turnTestMove = k; renderTurn(); }, turnTestMove === k));
  mv.append(pbtn(showTurnPlants ? '👣 планты вкл' : '👣 планты выкл', () => { showTurnPlants = !showTurnPlants; renderTurn(); }, showTurnPlants));

  const R2D = 180 / Math.PI;
  const grpT = (t: string): void => { const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 1px;font-size:11px'); h.textContent = t; box.append(h); };
  const sl = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number, save: () => void, fmt: (v: number) => string = (v) => v.toFixed(2)): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px');
    const nm = el('span', 'flex:1;font-size:11px'); nm.textContent = label; row.append(nm);
    const s = el('input', 'flex:2') as HTMLInputElement; s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(get());
    const v = el('span', 'width:44px;text-align:right;color:#9ae6a0;font-size:11px'); v.textContent = fmt(get());
    s.oninput = () => { set(parseFloat(s.value)); v.textContent = fmt(get()); save(); };
    row.append(s, v); box.append(row);
  };
  const deg = (v: number): string => `${Math.round(v)}°`;
  // Скрутка корпуса (pe_twist per-char) — ОТДЕЛЬНО для стой/ходьба/бег (кнопки выше); в игре плавный бленд по скорости.
  grpT(`скрутка корпуса — ${lblMv[turnTestMove]} (кнопки ↑ переключают режим)`);
  sl('порог таза (°)', () => editTwist().threshold * R2D, (d) => { editTwist().threshold = d / R2D; }, 5, 90, 1, saveTwistCfg, deg);
  sl('скорость доворота (рад/с)', () => editTwist().turnRate, (v) => { editTwist().turnRate = v; }, 1, 8, 0.25, saveTwistCfg);
  sl('макс. скрутка верха (°)', () => editTwist().maxTwist * R2D, (d) => { editTwist().maxTwist = d / R2D; }, 20, 120, 5, saveTwistCfg, deg);
  sl('выравнивание, прицел стабилен (с)', () => editTwist().relaxTime, (v) => { editTwist().relaxTime = v; }, 0.2, 3, 0.1, saveTwistCfg);
  sl('голова: смотреть на прицел (0=с телом, 1=на курсор)', () => editTwist().headLook, (v) => { editTwist().headLook = v; }, 0, 1, 0.05, saveTwistCfg);
  sl('голова: кивок (°, − вниз, 0 ровно)', () => editTwist().headPitch * R2D, (d) => { editTwist().headPitch = d / R2D; }, -30, 15, 1, saveTwistCfg, deg);
  const WNAMES = ['Spine', 'Chest', 'UpperChest', 'Neck', 'Head'];
  for (let i = 0; i < 5; i++) sl(`вес: ${WNAMES[i]}`, () => editTwist().weights[i]!, (v) => { editTwist().weights[i] = v; }, 0, 1, 0.05, saveTwistCfg);
  const twHint = el('div', 'color:#7a869e;font-size:10px;margin-top:3px'); twHint.textContent = 'ползунки правят ВЫБРАННЫЙ режим (стой/ходьба/бег); в игре профиль блендится плавно по скорости. веса — распределение по сегментам (сумма ~1 → голова доходит до прицела).'; box.append(twHint);
  // Приставной шаг (GAIT per-char через pe_gait)
  grpT('приставной шаг при повороте (планировщик стоп)');
  const GAITo = GAIT as unknown as NumRec;
  box.append(pbtn(GAITo['turnLimitByAngle'] ? 'предел шага: по УГЛУ' : 'предел шага: по ДИСТАНЦИИ', () => { GAITo['turnLimitByAngle'] = GAITo['turnLimitByAngle'] ? 0 : 1; saveGaitCfg(); renderTurn(); }, !!GAITo['turnLimitByAngle']));
  sl('порог поворота (рад/с)', () => GAITo['turnStep']!, (v) => { GAITo['turnStep'] = v; }, 0.1, 1.5, 0.05, saveGaitCfg);
  if (GAITo['turnLimitByAngle']) sl('предел: угол таза (°)', () => GAITo['turnLimitDeg']!, (v) => { GAITo['turnLimitDeg'] = v; }, 10, 90, 1, saveGaitCfg, deg);
  else sl('предел: дистанция (u)', () => GAITo['turnStepDist']!, (v) => { GAITo['turnStepDist'] = v; }, 2, 16, 0.5, saveGaitCfg);
  sl('доступить, таз стоит (с)', () => GAITo['turnSettleTime']!, (v) => { GAITo['turnSettleTime'] = v; }, 0.1, 3, 0.1, saveGaitCfg);
  sl('уход в idle, стоя (с)', () => GAITo['turnIdleTime']!, (v) => { GAITo['turnIdleTime'] = v; }, 0, 2, 0.1, saveGaitCfg);
  box.append(pbtn(`сброс скрутки (${lblMv[turnTestMove]})`, () => { editorTwistStates[turnTestMove] = TWIST_DEFAULT(); saveTwistCfg(); renderTurn(); }));
}

// ── Таймлайн ──
let playing = false, playT = 0, playSpeed = 1;
const tlName = el('span', 'color:#9ae6a0;min-width:90px');
const playBtn = mkBtn('▶', () => { const c = curClip(); if (!playing && c && playT >= clipDur(c)) playT = 0; playing = !playing; playBtn.textContent = playing ? '⏸' : '▶'; });
const spd = el('input', 'width:80px') as HTMLInputElement; spd.type = 'range'; spd.min = '0.2'; spd.max = '3'; spd.step = '0.1'; spd.value = '1'; spd.oninput = () => { playSpeed = parseFloat(spd.value); };
// Ф6: верхняя строка — транспорт и действия над ключами, нижняя — сам тайм-лайн (канвас)
timeline.style.flexDirection = 'column'; timeline.style.alignItems = 'stretch';
const tlTop = el('div', 'display:flex;align-items:center;gap:5px;flex-wrap:wrap');
const tlBody = el('div', 'flex:1;min-height:34px;position:relative');
timeline.append(tlTop, tlBody);
tlTop.append(playBtn, tlName, document.createTextNode('скор'), spd);

/** Ключи, над которыми работают кнопки: выделение на тайм-лайне, иначе текущий кадр. */
const tlSel = (): number[] => { const s2 = tl.selection(); return s2.length ? s2 : [frameIdx]; };
const tlAct = (label: string, hint: string, fn: (c: Clip, sel: number[]) => void): HTMLButtonElement => {
  const b = mkBtn(label, () => { const c = curClip(); if (!c) return; histLib(hint, () => { fn(c, tlSel()); sortKeys(c); saveLib(); refreshAll(); }); });
  b.title = hint; return b;
};
tlTop.append(
  sep(),
  tlAct('↗ плавно', 'кривая: плавно (ease)', (c, sl) => setInterp(c.keys, sl, 'ease', [0.42, 0, 0.58, 1])),
  tlAct('╱ резко', 'кривая: линейно', (c, sl) => setInterp(c.keys, sl, 'linear')),
  tlAct('■ держать', 'кривая: ступенька (stepped-блокинг)', (c, sl) => setInterp(c.keys, sl, 'step')),
  sep(),
  tlAct('⧉ дубль', 'дублировать кадры', (c, sl) => {
    const add = sl.map((i) => c.keys[i]).filter((k): k is Keyframe => !!k)
      .map((k) => ({ pose: clonePose(k.pose), t: k.t + 0.05, interp: k.interp, ease: k.ease }));
    c.keys.push(...add);
  }),
  tlAct('✕ удалить', 'удалить кадры', (c, sl) => {
    const drop = new Set(sl);
    const kept = c.keys.filter((_, i) => !drop.has(i));
    if (kept.length >= 1) { c.keys.length = 0; c.keys.push(...kept); frameIdx = Math.min(frameIdx, c.keys.length - 1); }
  }),
  tlAct('⇔ ×1.25', 'растянуть выделение по времени', (c, sl) => scaleKeys(c.keys, sl, 1.25)),
  tlAct('⇔ ×0.8', 'сжать выделение по времени', (c, sl) => scaleKeys(c.keys, sl, 0.8)),
);

const tl: TimelinePanel = makeTimelinePanel(tlBody, {
  clip: () => curClip(),
  frameIdx: () => frameIdx,
  playT: () => playT,
  pro: () => uiPro,
  onSelectFrame: (i) => goFrame(i),
  onScrub: (t) => { playT = t; preview(t); if (mode === 'ik') captureRig(); },
  onMoveKeys: (moves) => { const c = curClip(); if (!c) return; moveKeys(c.keys, moves); saveLib(); tl.draw(); },
  onSelectionChange: () => { /* кнопки читают выделение лениво, перерисовка не нужна */ },
});
function refreshTimeline(): void {
  const c = curClip();
  tlName.textContent = c ? c.name : '(нет клипа)';
  tl.draw();   // Ф6: ключи/дорожки/плейхед рисует канвас-панель
  if (!c) return;
}
function goFrame(i: number): void { const c = curClip(); if (!c) return; frameIdx = i; if (c.keys[i]) applyPose(c.keys[i]!.pose); if (mode === 'ik') captureRig(); refreshAll(); }
function preview(time: number): void {   // time в секундах
  // Интервал и фазу (уже отремапленную кривой кадра — linear/ease/step) считает ОБЩИЙ clipSegmentAt,
  // тот же, что у игрового clipPoseAt → редактор и игра гнут кривые одинаково.
  const c = curClip(); if (!c) return;
  const seg = clipSegmentAt(c, time); if (!seg) return;
  if (seg.a === seg.b) { applyPose(seg.a.pose); return; }
  lerpPose(seg.a.pose, seg.b.pose, seg.u);
}

// ── Физика (Ф2b: рэгдолл на гуманоид-скелете — призрак, ведомый моторами к позе) ──
let pw: PhysWorld | null = null; let physOn = false; let physDead = false;
let physMs = 0;   // среднее время физ-шага, мс (Ф3.4: стоимость набора тел видна, а не угадывается)
let manView: 'skel' | 'solid' | 'hidden' = 'skel';   // вид манекена: скелет-арматура / солид-тело / скрыт (дефолт — скелет)
let curHumanStyle: 'solid' | 'skeleton' = 'skeleton';   // с каким стилем реально построен human (чтобы не пересобирать зря)
let showBoxes = false;   // дебаг: показать сырые физ-боксы рэгдолла (по умолчанию — только силуэт-призрак)
let footGround = true;   // заземление стоп (foot-IK) на физ-теле; выкл → авторская ротация стопы видна
let ragdoll: HumanoidRagdoll | null = null;
let reviveT = -1; const reviveFrom = new THREE.Vector3(); const reviveDur = 0.9;   // плавное вставание с пола
let locoOn = false, locoPhase = 0, locoVx = 0, locoVz = 0.7, locoTempo = 1, locoGait = true;   // превью локомоции (движок: gait/бленд)
// ── Превью бега/поворотов: ТОТ ЖЕ PosePlayer, что и игра (единый пайплайн, Ф2) — редактор ≡ игра 1:1, без второй реализации.
//    lp() лениво (пере)создаёт плеер, когда меняется `human` (смена персонажа/стиля/пропорций пересобирает манекен).
let locoPlayer: PosePlayer | null = null; let locoPlayerHuman: Humanoid | null = null;
function lp(): PosePlayer {
  if (!locoPlayer || locoPlayerHuman !== human) {
    locoPlayer = new PosePlayer(human, () => weaponGroups, editorContent, weapon, GX, gaitPlant, editorTwistStates);
    locoPlayerHuman = human;
  }
  return locoPlayer;
}
let gaitPx = 0, gaitPz = 0; const GAIT_MAXSPD = 120;   // зеркало тредмила плеера (posX/posZ) — для скролла пола/оффсета маркеров
let gaitMoveMag = 0, gaitLegMag = 0;   // зеркало moveMag/legMag плеера (ридаут/маркеры)
let gaitYaw = 0, gaitYawManual = 0, gaitFaceMove = true;   // facing (прицел): по движению (поворот) / ручной угол (страйф) → в setYaw
let gaitReadout: HTMLElement | null = null;                // живой индикатор скорости/режима (ходьба↔бег)
let editorRootYaw = 0;                                      // зеркало pelvisYaw плеера (updateTurnTest идёт по тазу)
let editorTwistStates: TwistStates = TWIST_STATES_DEFAULT();   // 3 профиля скрутки (стой/ходьба/бег) текущего персонажа
const editTwist = (): TwistProfile => editorTwistStates[turnTestMove];   // редактируемый профиль = ВЫБРАННОЕ состояние (кнопка стой/ходьба/бег)
let twistCfgs: Record<string, TwistCfgStored> = (() => { try { return JSON.parse(localStorage.getItem('pe_twist') || '{}') as Record<string, TwistCfgStored>; } catch { return {}; } })();
function loadTwistCfg(id: string): void { editorTwistStates = resolveTwistStates(twistCfgs[id]); }   // легаси плоский → на все 3
// Сохраняем ПО СОСТОЯНИЯМ { stand, walk, run } — в игре эффективный профиль блендится плавно по скорости (blendTwist).
function saveTwistCfg(): void { twistCfgs[curCharId] = { stand: editorTwistStates.stand, walk: editorTwistStates.walk, run: editorTwistStates.run }; try { localStorage.setItem('pe_twist', JSON.stringify(twistCfgs)); savePoseKey('pe_twist'); } catch { /* */ } }
// ── Маркеры планта + точки ОБВОДА (via) свинга. Авторские = СТАТИЧЕСКИЕ (не тредмиллят), тянутся гизмо → body-local offset.
// Левая нога — СИНИЙ, правая — КРАСНЫЙ. via — те же цвета, поменьше. Живой индикатор (жёлтый мелкий) ездит по факту (динамика).
let editPlant = false;
let viaLeg: 0 | 1 = 0;                                          // какую ногу авторим кнопками + / − обвод
const PLANT_BLUE = 0x4aa0ff, PLANT_RED = 0xff5a4a, MAX_VIA = 3, HIP_DXE = 3.6, MARK_Y = 1.5;
const plantMarks = [mkHandle(PLANT_BLUE, 3, true), mkHandle(PLANT_RED, 3, true)];   // [0]=L плант, [1]=R плант (авторские)
const viaMarks: THREE.Mesh[][] = [[], []];
for (let i = 0; i < 2; i++) for (let k = 0; k < MAX_VIA; k++) viaMarks[i]!.push(mkHandle(i === 0 ? PLANT_BLUE : PLANT_RED, 2, false));
const liveMarks = [mkHandle(0xffe04a, 1.4, false), mkHandle(0xffe04a, 1.4, false)];   // живые точки (динамика): куда реально идёт стопа
const turnPlantMarks = [mkHandle(PLANT_BLUE, 3, false), mkHandle(PLANT_RED, 3, false)];   // «Повороты»: ТЕКУЩИЕ позиции стоп (где ноги сейчас; Л синий/П красный)
// «Повороты»: КОЛЬЦА = идл-стойка на прицеле (куда приземлится подшаг ПОСЛЕ доворота) — «те, куда стопы стремятся».
const mkRing = (color: number): THREE.Mesh => { const m = new THREE.Mesh(new THREE.RingGeometry(2.3, 3.5, 24), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide })); m.rotation.x = -Math.PI / 2; m.renderOrder = 999; scene.add(m); return m; };
const goalStanceMarks = [mkRing(PLANT_BLUE), mkRing(PLANT_RED)];
[plantMarks[0]!, plantMarks[1]!, ...viaMarks.flat(), liveMarks[0]!, liveMarks[1]!, turnPlantMarks[0]!, turnPlantMarks[1]!, goalStanceMarks[0]!, goalStanceMarks[1]!].forEach((m) => { m.visible = false; });
// ── Тест поворотов (вкладка «Повороты»): прицел = курсор над сценой; движение = стой/ходьба/бег ──
let turnTestMove: 'stand' | 'walk' | 'run' = 'stand';
let turnAim = 0;         // прицел (угол к точке под курсором)
let showTurnPlants = true;
type AuthMark = { mesh: THREE.Mesh; foot: 0 | 1; kind: 'plant' | 'via'; k: number };   // реестр перетаскиваемых авторских точек
let authMarks: AuthMark[] = [];
let plantDrag = -1; let dragMark: AuthMark | null = null; const plantGrab = V(); let plantOff0: [number, number] = [0, 0];
let gaitSpd = 0;   // фактическая скорость гейта (для точного референса планта — маркер совпадает с ногой)
const selCell = (): Leg2 => (plantSpeedRun ? gaitPlant.run : gaitPlant.walk)[plantDirSel]!;   // ВЫБРАННАЯ ячейка (панель)
const setXZ = (m: THREE.Mesh, x: number, z: number): void => { m.position.set(x, MARK_Y, z); };
/** Стационарный body-референс: forward=(sin yaw,cos yaw), right=(cos yaw,−sin yaw); хип ноги на ±HIP_DXE вбок.
 *  Точно совпадает с плант-целью планировщика: tx−gaitPx == refPos(foot, fwdAmt, latAmt). */
function refPos(foot: 0 | 1, fwd: number, lat: number): [number, number] {
  const s = Math.sin(gaitYaw), c = Math.cos(gaitYaw), side = foot === 0 ? HIP_DXE : -HIP_DXE;
  return [c * side + s * fwd + c * lat, -s * side + c * fwd - s * lat];
}
/** Референс-позиция ПЛАНТА выбранной ячейки = РЕАЛЬНАЯ плант-цель (как в pose.ts plant()): hip + fwd·(lead·mFwd+off) +
 *  right·(lead·mLat·strafeReach + stanceWidth·side + off). Считаем по фактической скорости гейта → маркер совпадает с ногой. */
function plantRef(foot: 0 | 1, off: [number, number]): [number, number] {
  const th = plantDirSel * (Math.PI / 4), mFwd = Math.cos(th), mLat = Math.sin(th);
  const speed = gaitSpd > 1 ? gaitSpd : (plantSpeedRun ? GAIT.speedRun : GAIT.speedWalk);
  const dr = clamp((speed - GAIT.speedWalk) / Math.max(1, GAIT.speedRun - GAIT.speedWalk), 0, 1);
  const stepLen = (GAIT.stepWalk + (GAIT.stepRun - GAIT.stepWalk) * dr) / Math.max(0.1, GAIT.cadence);
  const duty = GAIT.dutyWalk + (GAIT.dutyRun - GAIT.dutyWalk) * dr;
  const lead = stepLen * duty + stepLen * GAIT.aheadMul + speed * GAIT.predictSec;
  const side = foot === 0 ? 1 : -1;
  return refPos(foot, lead * mFwd + off[0], lead * mLat * GAIT.strafeReach + GAIT.stanceWidth * side + off[1]);
}
function updatePlantMarks(): void {
  const show = editPlant && locoOn && locoGait;
  authMarks = [];
  const cell = (plantSpeedRun ? gaitPlant.run : gaitPlant.walk)[plantDirSel]!;   // авторим выбранную ячейку (при драге авто-слежение выкл → совпадает с замороженной)
  for (let i = 0; i < 2; i++) {
    const foot = i as 0 | 1;
    const off = foot === 0 ? cell.l : cell.r;
    const pm = plantMarks[i]!; pm.visible = show;
    if (show) { authMarks.push({ mesh: pm, foot, kind: 'plant', k: 0 });
      if (dragMark?.mesh !== pm) { const p = plantRef(foot, off); setXZ(pm, p[0], p[1]); } }
    const via = (foot === 0 ? cell.lVia : cell.rVia) ?? [];
    for (let k = 0; k < MAX_VIA; k++) {
      const vm = viaMarks[i]![k]!; const on = show && k < via.length; vm.visible = on;
      if (on) { authMarks.push({ mesh: vm, foot, kind: 'via', k });
        if (dragMark?.mesh !== vm) { const p = refPos(foot, via[k]![0], via[k]![1]); setXZ(vm, p[0], p[1]); } }
    }
    const lm = liveMarks[i]!; lm.visible = show;                 // живой: реальная цель, тредмилл-ремап
    if (show) { const [tx, tz] = lp().driver.plantTarget(foot); setXZ(lm, tx - gaitPx, tz - gaitPz); }
  }
}
/** Ретаргет-крутилки редактора (сверх GAIT/POSE): ширина ног, база «рука вниз», база сгиба локтя, множитель боба. Передаются в общий poseRuntime. */
const GX = { armDown: 1.35, elbowBend: 0.25 };   // legWidth убран (дубль «ширина стойки»); боб таза — в GAIT.bobWalk/bobRun
// Живой контент редактора (библиотека + swayCfg). shieldOverlay — поза щита per-оружие (idle_<wk> → фолбэк idle_shield)
// + вес shieldMixFor(wk) (ползунок), подмешивается ТАК ЖЕ, как в игре: превью '+shield'-оружия показывает микс.
const editorContent: PoseContent = {
  resolveUpper: (w, combat) => resolveUpper(w, combat),
  shieldOverlay: (wk) => { const c = stanceClip(wk) ?? stanceClip('shield'); return c && c.keys[0] ? { pose: c.keys[0].pose, mix: shieldMixFor(wk) } : null; },
};
// ── Верх тела по оружию (Феча 2): idle-СТОЙКА = клип «idle_<оружие>» (правится в Анимации) + остаточный мах (pe_sway) ──
interface UpperPose { pose: Pose; swing: number }
const stanceName = (w: string): string => 'idle_' + w;
function stanceClip(w: string): Clip | null { return library.find((c) => c.name === stanceName(w) && c.character === curCharId && c.weapon === w) ?? null; }
function loadSway(): Record<string, Record<string, number>> { try { return JSON.parse(localStorage.getItem('pe_sway') || '{}') as Record<string, Record<string, number>>; } catch { return {}; } }
let swayCfg: Record<string, Record<string, number>> = loadSway();
function saveSway(): void { try { localStorage.setItem('pe_sway', JSON.stringify(swayCfg)); savePoseKey('pe_sway'); } catch { /* */ } }
const swayOf = (w: string): number => swayCfg[curCharId]?.[w] ?? 0.2;   // остаточный мах поверх idle (физпокачивание)
const combatStanceName = (w: string): string => 'combat_idle_' + w;
function combatStanceClip(w: string): Clip | null { return library.find((c) => c.name === combatStanceName(w) && c.character === curCharId && c.weapon === w) ?? null; }
let editorCombat = 0;   // превью боевой стойки в редакторе (0/1)
function resolveUpper(wpn: string, combat = 0): UpperPose | null {   // idle-поза: ПОЛНАЯ per-оружие (idle_<wpn>) в приоритете (щит/дуал целиком), иначе по БАЗОВОМУ + оверлей; combat>0 → блендим к combat_idle
  let c = stanceClip(wpn); let wk = wpn;
  if (!c) { wk = rtBaseWeapon(wpn); c = stanceClip(wk); }
  if (!c) { const base = rtBaseWeapon(curChar().weapon); if (base !== wk) { c = stanceClip(base); wk = base; } }
  if (!c || !c.keys[0]) return null;
  let pose = c.keys[0]!.pose;
  if (combat > 0.001) { const cc = combatStanceClip(wpn) ?? combatStanceClip(rtBaseWeapon(wpn)); if (cc && cc.keys[0]) pose = blendTwo(pose, cc.keys[0]!.pose, combat); }
  return { pose, swing: swayOf(wk) };
}
// Удары — клипы «hit_<w>» (базовый) и «s_hit_<w>» (спец/скил) из 6 кадров; кадры 1 и последний = idle-стойка (не редактируются, синк ОДНОСТОРОННЕ idle→удар).
const isAttackClip = (c: Clip): boolean => c.name.startsWith('hit_') || c.name.startsWith('s_hit_');
function syncAttackEnds(c: Clip): void {
  const st = stanceClip(c.weapon); if (!st || !st.keys[0] || c.keys.length < 2) return;
  const pose = JSON.parse(JSON.stringify(st.keys[0].pose)) as Pose;
  c.keys[0]!.pose = pose; c.keys[c.keys.length - 1]!.pose = JSON.parse(JSON.stringify(st.keys[0].pose)) as Pose;
}
function syncAllAttackEnds(): void { for (const c of library) if (c.character === curCharId && (isAttackClip(c) || c.idleEnds)) syncAttackEnds(c); }
function captureUpper(nm: string = stanceName(weapon)): void {   // снять ВСЮ позу манекена (ноги+торс+верх+оружие) → клип-стойка (idle_ или combat_idle_)
  if (locoOn || playing) { alert('Идёт превью/воспроизведение — сначала останови (⏸), иначе схватишь кадр бега, а не стойку.'); return; }
  const i = library.findIndex((c) => c.name === nm && c.character === curCharId && c.weapon === weapon);
  if (i >= 0 && !confirm(`Перезаписать «${nm}» текущей позой манекена?`)) return;   // защита от случайной перезаписи idle
  // Структурная правка: перезаписывает клип-стойку И концы ВСЕХ её ударов → откат должен вернуть всю библиотеку.
  histLib('захватить стойку', () => {
    const pose = readPoseFull();
    const clip: Clip = { name: nm, character: curCharId, weapon, loop: false, keys: [{ pose, t: 0 }] };
    if (i >= 0) library[i] = clip; else library.push(clip);
    syncAllAttackEnds();   // стойка изменилась → концы всех её ударов подхватывают
    saveLib();
  });
}
// ── Удары на бегу (Феча 3): авторский клип-удар поверх бегущих ног, физически ведомый (моторы гонят рэгдолл к цели) ──
let attackSpeed = 1;   // множитель темпа удара (ползунок) → player.atkSpeed
function triggerAttack(c: Clip): void {   // запустить удар через ТОТ ЖЕ PosePlayer, что игра; включить физику → физ-призрак = верный замах
  syncAttackEnds(c);   // концы = актуальная стойка (на случай если стойку поправили)
  lp().triggerAttack(c); lp().atkSpeed = attackSpeed;
  void ensurePhysics().then(() => { physOn = true; setPhysVis(true); });
}
// Пометка клипов как ударов (per char×weapon) — их кнопки появляются в превью бега.
function loadAtk(): Record<string, Record<string, string[]>> { try { return JSON.parse(localStorage.getItem('pe_attacks') || '{}') as Record<string, Record<string, string[]>>; } catch { return {}; } }
let atkCfgs: Record<string, Record<string, string[]>> = loadAtk();
function saveAtk(): void { try { localStorage.setItem('pe_attacks', JSON.stringify(atkCfgs)); savePoseKey('pe_attacks'); } catch { /* */ } }
(function migrateDual(): void {   // единая офф-рука: старый ключ оружия 'dual' → 'sword+dagger' (клипы/атаки/sway). Идемпотентно.
  let changed = false;
  for (const c of library) if (c.weapon === 'dual') { c.weapon = 'sword+dagger'; changed = true; }
  for (const map of [swayCfg as Record<string, Record<string, unknown>>, atkCfgs as Record<string, Record<string, unknown>>]) {
    for (const ch of Object.keys(map)) { const byW = map[ch]!; if (byW['dual'] !== undefined && byW['sword+dagger'] === undefined) { byW['sword+dagger'] = byW['dual']; delete byW['dual']; changed = true; } }
  }
  if (changed) { try { localStorage.setItem('pe_clips', JSON.stringify(library)); savePoseKey('pe_clips'); localStorage.setItem('pe_sway', JSON.stringify(swayCfg)); savePoseKey('pe_sway'); localStorage.setItem('pe_attacks', JSON.stringify(atkCfgs)); savePoseKey('pe_attacks'); } catch { /* */ } }
})();
(function migratePoseNames(): void {   // старая конвенция имён стойка_/удар_ → idle_/hit_ (идемпотентно): клипы + метки-удары + loco-узлы. Игра тоже нормализует на чтении.
  let clipsCh = false, atkCh = false, locoCh = false;
  for (const c of library) { const nn = migratePoseName(c.name); if (nn !== c.name) { c.name = nn; clipsCh = true; } }
  for (const ch of Object.keys(atkCfgs)) { const byW = atkCfgs[ch]!; for (const w of Object.keys(byW)) { const arr = byW[w]!; for (let i = 0; i < arr.length; i++) { const nn = migratePoseName(arr[i]!); if (nn !== arr[i]) { arr[i] = nn; atkCh = true; } } } }
  for (const n of locoNodes) { const nn = migratePoseName(n.clip); if (nn !== n.clip) { n.clip = nn; locoCh = true; } }
  if (clipsCh) saveLib();
  if (atkCh) saveAtk();
  if (locoCh) saveLoco();
})();
function atkList(): string[] { return atkCfgs[curCharId]?.[weapon] ?? []; }
function toggleAtk(name: string): void { const byC = (atkCfgs[curCharId] ??= {}); const arr = (byC[weapon] ??= []); const i = arr.indexOf(name); if (i >= 0) arr.splice(i, 1); else arr.push(name); saveAtk(); }
const clonePose = (p: Pose): Pose => JSON.parse(JSON.stringify(p)) as Pose;
const cloneClipTo = (c: Clip, char: string): Clip => ({ name: c.name, character: char, weapon: c.weapon, loop: c.loop, keys: c.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) });

// ── СИД «Волкодав»: idle-стойка (клип «idle_<w>») + удар (клип «hit_<w>», начинается ИЗ idle) на КАЖДОЕ из 16 оружий (+ без оружия) ──
type V3 = [number, number, number];
function buildWarriorSeed(): { stances: Clip[]; attacks: Clip[]; sway: Record<string, number> } {
  const P = (rua: V3, rla: V3, lua: V3, lla: V3, ex?: Record<string, V3>): Pose => ({ RightUpperArm: rua, RightLowerArm: rla, LeftUpperArm: lua, LeftLowerArm: lla, ...(ex ?? {}) });
  // idle-шаблоны по типу оружия: (правое плечо, правый локоть, левое плечо, левый локоть), sway = остаточный мах (физпокачивание)
  const IDLE: Record<string, { pose: Pose; sway: number }> = {
    melee1h: { pose: P([-0.35, 0, 1.15], [-0.7, 0, 0], [-0.15, 0, -1.25], [-0.35, 0, 0]), sway: 0.22 },   // меч/кинжал/топор/булава в правой
    shield1h: { pose: P([-0.3, 0, 1.1], [-0.7, 0, 0], [-0.75, 0, -0.6], [-1.4, 0, 0]), sway: 0.15 },       // меч+щит: щит-гард слева
    dual: { pose: P([-0.4, 0, 1.05], [-0.75, 0, 0], [-0.4, 0, -1.05], [-0.75, 0, 0]), sway: 0.2 },         // парное: обе к бою
    twoH: { pose: P([-0.25, 0.95, 0.5], [-1.2, -0.3, 0], [-0.15, -1.05, -0.35], [-1.5, 0.3, 0]), sway: 0.12 },   // двуручка вперёд-по диагонали
    staff: { pose: P([-0.2, 0.8, 0.7], [-1.0, 0, 0], [-0.2, -0.9, -0.4], [-1.3, 0.2, 0]), sway: 0.14 },
    bow: { pose: P([-0.5, 0.9, 0.6], [-1.9, 0, 0], [-0.1, -1.35, -0.35], [-0.15, 0, 0]), sway: 0.1 },      // лук: левая вперёд держит, правая у подбородка
    crossbow: { pose: P([-0.4, 0.7, 0.6], [-1.0, 0, 0], [-0.3, -0.8, -0.4], [-1.1, 0, 0]), sway: 0.1 },    // арбалет вперёд, две руки
    shield: { pose: P([-0.3, 0, 1.0], [-0.8, 0, 0], [-0.75, 0, -0.6], [-1.4, 0, 0]), sway: 0.15 },
    unarmed: { pose: P([-1.0, 0.5, 0.55], [-1.7, 0, 0], [-1.0, -0.5, -0.55], [-1.7, 0, 0]), sway: 0.25 },  // без оружия: кулаки у груди (гард)
  };
  // удар: [замах, удар] (idle-кадр добавим первым/последним снаружи). Не-двигающаяся рука = из idle.
  const ATK: Record<string, [Pose, Pose]> = {
    melee1h: [P([-2.0, 0, 0.4], [-1.0, 0, 0], [-0.15, 0, -1.25], [-0.35, 0, 0], { Chest: [0, 0.25, 0] }), P([0.5, 0, 0.9], [-0.2, 0, 0], [-0.15, 0, -1.25], [-0.35, 0, 0], { Chest: [0.15, -0.35, 0] })],
    shield1h: [P([-2.0, 0, 0.4], [-1.0, 0, 0], [-0.75, 0, -0.6], [-1.4, 0, 0], { Chest: [0, 0.25, 0] }), P([0.5, 0, 0.9], [-0.2, 0, 0], [-0.75, 0, -0.6], [-1.4, 0, 0], { Chest: [0.15, -0.35, 0] })],
    dual: [P([-1.9, 0, 0.4], [-0.9, 0, 0], [-0.4, 0, -1.05], [-0.75, 0, 0], { Chest: [0, 0.2, 0] }), P([0.5, 0, 0.9], [-0.3, 0, 0], [-0.5, 0, -0.9], [-0.9, 0, 0], { Chest: [0.1, -0.3, 0] })],
    twoH: [P([-2.1, 0, 0.5], [-0.8, 0, 0], [-2.0, 0, -0.4], [-0.9, 0, 0], { Chest: [0, 0.3, 0] }), P([0.4, 0, 0.7], [-0.3, 0, 0], [0.3, 0, -0.5], [-0.4, 0, 0], { Chest: [0.2, -0.4, 0] })],
    staff: [P([-2.0, 0, 0.5], [-1.0, 0, 0], [-1.5, 0, -0.5], [-1.2, 0, 0], { Chest: [0, 0.2, 0] }), P([0.3, 0, 0.8], [-0.4, 0, 0], [-0.3, 0, -0.5], [-1.3, 0, 0], { Chest: [0.15, -0.3, 0] })],
    bow: [P([-0.55, 0.6, 0.55], [-2.2, 0, 0], [-0.1, -1.4, -0.3], [-0.1, 0, 0], { Chest: [0, -0.1, 0] }), P([-0.4, 0.3, 0.5], [-2.4, 0, 0], [-0.1, -1.45, -0.28], [-0.05, 0, 0], { Chest: [0, -0.22, 0] })],   // натяг: правая к подбородку
    crossbow: [P([-0.42, 0.7, 0.6], [-0.9, 0, 0], [-0.3, -0.8, -0.4], [-1.1, 0, 0], { Chest: [0, 0, 0] }), P([-0.45, 0.7, 0.6], [-1.0, 0, 0], [-0.3, -0.8, -0.4], [-1.1, 0, 0], { Chest: [-0.1, 0, 0] })],   // выстрел + отдача
    shield: [P([-0.3, 0, 1.0], [-0.8, 0, 0], [-0.75, 0, -0.4], [-1.2, 0, 0], { Chest: [0, 0.15, 0] }), P([-0.3, 0, 1.0], [-0.8, 0, 0], [-1.4, 0, -0.2], [-0.6, 0, 0], { Chest: [0.12, -0.2, 0] })],   // удар щитом
    unarmed: [P([-1.2, 0.4, 0.5], [-1.9, 0, 0], [-1.0, -0.5, -0.55], [-1.7, 0, 0], { Chest: [0, 0.2, 0] }), P([-1.4, 0.2, 0.4], [-0.15, 0, 0], [-1.0, -0.5, -0.55], [-1.7, 0, 0], { Chest: [0.1, -0.3, 0] })],   // прямой правой
  };
  const MAP: Record<string, string> = { none: 'unarmed', sword: 'melee1h', dagger: 'melee1h', axe: 'melee1h', mace: 'melee1h', 'sword+shield': 'shield1h', dual: 'dual', greatsword: 'twoH', greataxe: 'twoH', greatmaul: 'twoH', halberd: 'twoH', spear: 'twoH', staff: 'staff', bow: 'bow', crossbow: 'crossbow', shield: 'shield' };
  const stances: Clip[] = [], attacks: Clip[] = [], sway: Record<string, number> = {};
  for (const w in MAP) {
    const tpl = MAP[w]!; const idle = IDLE[tpl]!, a = ATK[tpl]!;
    sway[w] = idle.sway;
    stances.push({ name: stanceName(w), character: 'warrior', weapon: w, loop: false, keys: [{ pose: clonePose(idle.pose), t: 0 }] });
    // удар = 6 кадров: idle → замах½ → замах-макс → удар½ → удар-финиш → idle. Полукадры — интерполяция (blendTwo).
    const wUp = a[0], strike = a[1];
    attacks.push({ name: 'hit_' + w, character: 'warrior', weapon: w, loop: false, keys: [
      { pose: clonePose(idle.pose), t: 0 },
      { pose: blendTwo(idle.pose, wUp, 0.5), t: 0.10 },
      { pose: clonePose(wUp), t: 0.22 },
      { pose: blendTwo(wUp, strike, 0.5), t: 0.34 },
      { pose: clonePose(strike), t: 0.46 },
      { pose: clonePose(idle.pose), t: 0.62 },
    ] });
  }
  return { stances, attacks, sway };
}
function seedWarrior(forceStances: boolean): void {   // сид Волкодава: удары ВСЕГДА пересобрать (6 кадров), стойки — добавить недостающие (force=перезаписать)
  const s = buildWarriorSeed();
  const put = (c: Clip, replace: boolean): void => { const i = library.findIndex((x) => x.name === c.name && x.character === 'warrior' && x.weapon === c.weapon); if (i >= 0) { if (replace) library[i] = c; } else library.push(c); };
  for (const c of s.stances) put(c, forceStances);
  for (const c of s.attacks) put(c, true);   // удары — в 6-кадровую структуру
  swayCfg.warrior = forceStances ? s.sway : { ...s.sway, ...(swayCfg.warrior ?? {}) }; saveSway();
  const am = (atkCfgs.warrior ??= {});
  for (const c of s.attacks) { const arr = (am[c.weapon] ??= []); if (!arr.includes(c.name)) arr.push(c.name); }
  saveAtk();
  syncAllAttackEnds();   // концы ударов = актуальные стойки (пользовательские, если стойку не форсили)
  saveLib();
}
function ensureSeed(): void {   // первый запуск: 16 стоек + 16 ударов (6 кадров, концы из стойки). Флаг pe_seeded4 (миграция 4→6 кадров)
  localStorage.removeItem('pe_upper');   // старый формат idle-стора не используется
  if (localStorage.getItem('pe_seeded4')) return;
  seedWarrior(false);   // новый юзер → всё; старый сид → стойки сохранить, удары пересобрать в 6 кадров
  localStorage.setItem('pe_seeded4', '1');
}
function renderUpperPanel(): void {   // панель idle-стойки по оружию (Феча 2): захват в клип, остаточный мах, «взять за основу»
  const box = el('div', 'margin-top:8px;border:1px solid #39415a;border-radius:6px;padding:6px');
  const st = stanceClip(weapon); const has = !!st;
  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin-bottom:2px;font-size:11px');
  h.textContent = `IDLE-СТОЙКА · ${weapon}` + (has ? ' (клип «' + stanceName(weapon) + '»)' : ' — не задана (полный мах)'); box.append(h);
  box.append(pbtn(has ? '⟳ перезахватить стойку (в клип)' : '✎ захватить стойку (в клип)', () => { captureUpper(); renderLoco(); }));
  if (curCharId === 'warrior') box.append(pbtn('↺ сид Волкодава (16 стоек + 16 ударов)', () => { if (confirm('Перезаписать все стойки и удары Волкодава примерным сидом?')) { seedWarrior(true); renderLoco(); } }));
  // Боевая стойка (combat_idle): в игре включается в бою (своя атака / монстр целится в тебя). Фолбэк на idle, если не задана.
  const hasC = !!combatStanceClip(weapon);
  const ch = el('div', 'color:#ff9f6b;font-weight:bold;margin:6px 0 2px;font-size:11px'); ch.textContent = `БОЕВАЯ СТОЙКА · ${weapon}` + (hasC ? ' (combat_idle)' : ' — нет (фолбэк на idle)'); box.append(ch);
  const crow = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); box.append(crow);
  crow.append(
    pbtn(hasC ? '⟳ перезахватить боевую' : '✎ захватить боевую (в клип)', () => { captureUpper(combatStanceName(weapon)); renderLoco(); }),
    pbtn(editorCombat ? '👁 превью боевой: вкл' : '👁 превью боевой', () => { editorCombat = editorCombat ? 0 : 1; renderLoco(); }, !!editorCombat),
  );
  if (hasC) crow.append(pbtn('сброс боевой', () => { library = library.filter((c) => !(c.name === combatStanceName(weapon) && c.character === curCharId && c.weapon === weapon)); saveLib(); renderLoco(); }));
  { const cbrow = el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px'); cbrow.innerHTML = '<span style="flex:1;font-size:11px">кроссфейд боевой (с)</span>';
    const cbs = el('input', 'flex:2') as HTMLInputElement; cbs.type = 'range'; cbs.min = '0.02'; cbs.max = '0.6'; cbs.step = '0.02'; cbs.value = String(GAIT.combatBlend);
    const cbv = el('span', 'width:34px;text-align:right;color:#9ae6a0;font-size:11px'); cbv.textContent = GAIT.combatBlend.toFixed(2);
    cbs.oninput = () => { GAIT.combatBlend = parseFloat(cbs.value); cbv.textContent = GAIT.combatBlend.toFixed(2); saveGaitCfg(); }; cbrow.append(cbs, cbv); box.append(cbrow); }
  if (has) {
    const row = el('label', 'display:flex;align-items:center;gap:6px;margin-top:4px'); row.innerHTML = '<span style="flex:1;font-size:11px">остаточный мах (сверх физики)</span>';
    const s = el('input', 'flex:2') as HTMLInputElement; s.type = 'range'; s.min = '0'; s.max = '1'; s.step = '0.05'; s.value = String(swayOf(weapon));
    const v = el('span', 'width:34px;text-align:right;color:#9ae6a0;font-size:11px'); v.textContent = swayOf(weapon).toFixed(2);
    s.oninput = () => { (swayCfg[curCharId] ??= {})[weapon] = parseFloat(s.value); v.textContent = parseFloat(s.value).toFixed(2); saveSway(); }; row.append(s, v); box.append(row);
    box.append(pbtn('сброс стойки', () => { library = library.filter((c) => !(c.name === stanceName(weapon) && c.character === curCharId && c.weapon === weapon)); saveLib(); renderLoco(); }));
  }
  {   // взять стойку с другого ОРУЖИЯ — единый список оружия (как в тулбаре); копирование в себя = no-op
    const r1 = el('div', 'display:flex;gap:2px;margin-top:4px'); const sel = el('select', 'flex:1;background:#20242f;color:#cfe;border:1px solid #39415a;border-radius:4px;font-size:11px') as HTMLSelectElement;
    WEAPONS.forEach((w) => { const o = document.createElement('option'); o.value = w; o.textContent = w; sel.append(o); });
    r1.append(sel, pbtn('основа: оружие', () => { if (sel.value === weapon) return; const src = stanceClip(sel.value); if (src) { const nm = stanceName(weapon); const i = library.findIndex((c) => c.name === nm && c.character === curCharId && c.weapon === weapon); const nc: Clip = { name: nm, character: curCharId, weapon, loop: false, keys: [{ pose: clonePose(src.keys[0]!.pose), t: 0 }] }; if (i >= 0) library[i] = nc; else library.push(nc); (swayCfg[curCharId] ??= {})[weapon] = swayCfg[curCharId]?.[sel.value] ?? 0.2; saveLib(); saveSway(); renderLoco(); } })); box.append(r1);
  }
  const srcC = allChars().filter((c) => c.id !== curCharId && library.some((cl) => cl.character === c.id && cl.name.startsWith('idle_')));
  if (srcC.length) {   // взять ВЕСЬ набор (стойки+удары) с другого КЛАССА
    const r2 = el('div', 'display:flex;gap:2px;margin-top:4px'); const sel = el('select', 'flex:1;background:#20242f;color:#cfe;border:1px solid #39415a;border-radius:4px;font-size:11px') as HTMLSelectElement;
    srcC.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; sel.append(o); });
    r2.append(sel, pbtn('основа: класс (весь верх)', () => { const src = sel.value; for (const cl of library.filter((c) => c.character === src && (c.name.startsWith('idle_') || c.name.startsWith('hit_') || c.name.startsWith('s_hit_')))) { const i = library.findIndex((c) => c.character === curCharId && c.name === cl.name && c.weapon === cl.weapon); const nc = cloneClipTo(cl, curCharId); if (i >= 0) library[i] = nc; else library.push(nc); } swayCfg[curCharId] = { ...(swayCfg[src] ?? {}) }; atkCfgs[curCharId] = JSON.parse(JSON.stringify(atkCfgs[src] ?? {})); saveLib(); saveSway(); saveAtk(); renderLoco(); })); box.append(r2);
  }
  body.append(box);
}
function renderAttackPanel(): void {   // Феча 3: пометить клипы ударами + кнопки запуска поверх бега (физ-ведомо)
  const box = el('div', 'margin-top:8px;border:1px solid #5a3946;border-radius:6px;padding:6px');
  const h = el('div', 'color:#d08fbf;font-weight:bold;margin-bottom:2px;font-size:11px'); h.textContent = 'УДАРЫ НА БЕГУ (клип → физ-удар)'; box.append(h);
  const clips = clipsHere().filter((c) => !c.loop);   // удары — не-loop клипы (беговой цикл loop — отдельно)
  if (!clips.length) { const w = el('div', 'color:#d0a060;font-size:11px'); w.textContent = 'Нет клипов-ударов. Сделай удар во вкладке «Анимация» → вернись и отметь его тут.'; box.append(w); }
  const marks = atkList();
  clips.forEach((c) => {
    const isAtk = marks.includes(c.name);
    const r = el('div', 'display:flex;gap:2px;margin-top:2px;align-items:center'); box.append(r);
    r.append(pbtn(isAtk ? '⚔' : '—', () => { toggleAtk(c.name); renderLoco(); }, isAtk));
    const nm = el('span', 'flex:1;font-size:11px'); nm.textContent = c.name; r.append(nm);
    if (isAtk) r.append(pbtn('▶ удар', () => { if (!locoOn) { locoOn = true; gaitPx = 0; gaitPz = 0; locoPlayer?.resetPos(); } triggerAttack(c); }));
  });
  if (marks.length) {
    const tr = el('label', 'display:flex;align-items:center;gap:6px;margin-top:4px'); tr.innerHTML = '<span style="flex:1;font-size:11px">скорость удара</span>';
    const s = el('input', 'flex:2') as HTMLInputElement; s.type = 'range'; s.min = '0.3'; s.max = '2'; s.step = '0.1'; s.value = String(attackSpeed);
    const v = el('span', 'width:30px;text-align:right;color:#9ae6a0;font-size:11px'); v.textContent = attackSpeed.toFixed(1);
    s.oninput = () => { attackSpeed = parseFloat(s.value); v.textContent = attackSpeed.toFixed(1); }; tr.append(s, v); box.append(tr);
    const hint = el('div', 'color:#8fb7ff;font-size:10px;margin-top:3px'); hint.textContent = 'Удар ведётся физикой (моторы гонят рэгдолл к позам) — смотри на призрака. Сила — в панели ФИЗИКА.'; box.append(hint);
  }
  body.append(box);
}
// Настройки бега per персонаж (GAIT+POSE+GX): сохраняем/грузим при смене персонажа → у каждого класса свой бег.
const GAIT_KEYS = ['pelvisMin', 'stepWalk', 'stepRun', 'bobWalk', 'bobRun', 'liftWalk', 'liftRun', 'cadence', 'dutyWalk', 'dutyRun', 'speedWalk', 'speedRun', 'hipFwdLim', 'stanceWidth', 'strafeReach', 'crossClamp', 'turnStep', 'turnStepDist', 'turnLeadBias', 'turnLimitByAngle', 'turnLimitDeg', 'turnSettleTime', 'turnIdleTime', 'combatBlend'] as const;   // длина шага/боб/подъём — раздельно ходьба/бег; standY убран (база из стойки)
const POSE_KEYS = ['armSh', 'armEl', 'armSwing', 'armElWalk'] as const;
const GX_KEYS = ['armDown', 'elbowBend'] as const;
type NumRec = Record<string, number>;
const GAIT_DEF: NumRec = {}, POSE_DEF: NumRec = {}, GX_DEF = { ...GX };
for (const k of GAIT_KEYS) GAIT_DEF[k] = (GAIT as NumRec)[k]!;
for (const k of POSE_KEYS) POSE_DEF[k] = (POSE as NumRec)[k]!;
// Авторский сдвиг плант-цели (body-local fwd,lat) на ногу — СЕТКА 8 направлений × 2 скорости (шаг/бег).
// lVia/rVia — точки ОБВОДА свинга (body-local fwd,lat): маховая летит через них, огибая опорную. Пусто = прямой свинг.
type XY = [number, number];
type Leg2 = { l: XY; r: XY; lVia?: XY[]; rVia?: XY[] };
type PlantGrid = { walk: Leg2[]; run: Leg2[] };   // walk/run — по 8 ячеек (направление 0=вперёд, шаг 45°)
type PlantStored = Partial<PlantGrid> & { l?: XY; r?: XY };   // старый одиночный {l,r} ИЛИ новый {walk,run}
const DIR8 = ['вперёд', 'вп-вправо', 'вправо', 'назад-вправо', 'назад', 'назад-влево', 'влево', 'вп-влево'];
const DIR_STEP = Math.PI / 4;
const cloneVia = (v: XY[] | undefined): XY[] => (v ?? []).map((p) => [p[0], p[1]] as XY);
const zeroLeg = (): Leg2 => ({ l: [0, 0], r: [0, 0], lVia: [], rVia: [] });
const emptyGrid = (): PlantGrid => ({ walk: Array.from({ length: 8 }, zeroLeg), run: Array.from({ length: 8 }, zeroLeg) });
const gaitPlant: PlantGrid = emptyGrid();                       // живая сетка (интерполируется в stepGait)
let plantDirSel = 0, plantSpeedRun = true;                     // активная ячейка для правки (направление 0-7, бег/шаг)
let plantEditDir = 0, plantEditRun = true;                     // замороженная ячейка на время драга маркера
const activeCell = (): Leg2 => (plantEditRun ? gaitPlant.run : gaitPlant.walk)[plantEditDir]!;
let gaitCfgs: Record<string, { gait: NumRec; pose: NumRec; gx: NumRec; plant?: PlantStored }> = (() => { try { return JSON.parse(localStorage.getItem('pe_gait') || '{}'); } catch { return {}; } })();
function loadPlant(p: PlantStored | undefined): void {          // читаем новый {walk,run} ИЛИ старый {l,r} (→ размазать во все ячейки)
  const g = emptyGrid();
  if (p?.walk && p?.run) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) { const e = p[sp]![i]; if (e) g[sp][i] = { l: [...(e.l ?? [0, 0])] as XY, r: [...(e.r ?? [0, 0])] as XY, lVia: cloneVia(e.lVia), rVia: cloneVia(e.rVia) }; } }
  else if (p?.l && p?.r) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) g[sp][i] = { l: [...p.l] as XY, r: [...p.r] as XY, lVia: [], rVia: [] }; }
  gaitPlant.walk = g.walk; gaitPlant.run = g.run;
}
function applyGaitCfg(id: string): void {   // выставить GAIT/POSE/GX/plant под персонажа (или дефолты)
  const c = gaitCfgs[id];
  Object.assign(GAIT, GAIT_DEF, c?.gait ?? {});
  Object.assign(POSE, POSE_DEF, c?.pose ?? {});
  Object.assign(GX, GX_DEF, c?.gx ?? {});
  loadPlant(c?.plant);
}
function saveGaitCfg(): void {
  const gait: NumRec = {}, pose: NumRec = {}, gx: NumRec = {};
  for (const k of GAIT_KEYS) gait[k] = (GAIT as NumRec)[k]!;
  for (const k of POSE_KEYS) pose[k] = (POSE as NumRec)[k]!;
  for (const k of GX_KEYS) gx[k] = (GX as NumRec)[k]!;
  const cp = (arr: Leg2[]): Leg2[] => arr.map((e) => ({ l: [...e.l] as XY, r: [...e.r] as XY, lVia: cloneVia(e.lVia), rVia: cloneVia(e.rVia) }));
  gaitCfgs[curCharId] = { gait, pose, gx, plant: { walk: cp(gaitPlant.walk), run: cp(gaitPlant.run) } };
  try { localStorage.setItem('pe_gait', JSON.stringify(gaitCfgs)); savePoseKey('pe_gait'); } catch { /* */ }
}
let stanceMeasuredFor = '';   // замеряем ширину стойки один раз на текущее оружие (мутирует human → только на смене)
function stepGait(dt: number): void {
  const player = lp();
  // Живые правки редактора → в плеер (ТЕ ЖЕ ссылки, что читает игра): gx/plant/twist/скорость удара/боевая — ползунки между кадрами.
  player.gx = GX; player.plant = gaitPlant; player.twistStates = editorTwistStates; player.atkSpeed = attackSpeed;
  player.setCombat(!!editorCombat);
  if (player.weapon !== weapon) { player.setWeapon(weapon); stanceMeasuredFor = weapon; }   // смена оружия → пере-замер стойки внутри
  else if (stanceMeasuredFor !== weapon) { player.measureStance(); stanceMeasuredFor = weapon; }   // idle-поза правится живьём → пере-замер
  const vx = locoVx * GAIT_MAXSPD, vz = locoVz * GAIT_MAXSPD;   // квадрат = скорость движения (центр→ходьба, край→бег)
  const spd = Math.hypot(vx, vz); gaitSpd = spd;   // gaitSpd → точный референс плант-маркера
  // Facing (прицел): «лицом по движению» (тело поворачивается к скорости) / фикс. угол `gaitYawManual` (страйф).
  if (gaitFaceMove) { if (spd > 1) gaitYaw = Math.atan2(vx, vz); } else gaitYaw = gaitYawManual;
  player.setVel(vx, vz); player.setYaw(gaitYaw); player.step(dt);   // ЕДИНЫЙ пайплайн (Ф2): гейт+idle+удар+torso-lead+голова — как в игре
  // Зеркалим состояние плеера для маркеров/скролла пола/ридаута.
  gaitMoveMag = player.moveMag; gaitLegMag = player.legMag;
  gaitPx = player.posX; gaitPz = player.posZ; editorRootYaw = player.pelvisYaw;
  if (plantDrag < 0 && spd > 1) {   // активная ячейка плант-сетки следит за падом (body-локальное направление движения)
    const fwdC = vx * Math.sin(editorRootYaw) + vz * Math.cos(editorRootYaw), latC = vx * Math.cos(editorRootYaw) - vz * Math.sin(editorRootYaw);
    let a = Math.atan2(latC, fwdC) / DIR_STEP; a = ((a % 8) + 8) % 8;
    plantDirSel = (Math.round(a) % 8 + 8) % 8; plantSpeedRun = clamp((spd - GAIT.speedWalk) / Math.max(1, GAIT.speedRun - GAIT.speedWalk), 0, 1) >= 0.5;
  }
  if (gaitReadout && gaitReadout.isConnected) {              // живой индикатор скорости + режим ходьба↔бег
    const mode = spd < 5 ? 'стоит' : spd < GAIT.speedWalk ? 'ходьба' : 'бег';
    gaitReadout.textContent = `скорость: ${spd.toFixed(0)} u/с · ${mode}` + (gaitFaceMove ? '' : ` · страйф ${Math.round(gaitYaw * 180 / Math.PI)}°`);
  }
}
function stepLoco(dt: number): void {
  const nodes = locoHere(); if (!nodes.length) return;
  const mag = Math.min(1, Math.hypot(locoVx, locoVz));
  locoPhase = (locoPhase + dt * 1.6 * (0.12 + 0.88 * mag) * locoTempo) % 1;          // на idle почти стоит, на бегу быстрые ноги
  const pose = blendLocoPose(nodes, locoWeights(nodes, locoVx, locoVz), locoPhase);
  if (Object.keys(pose).length) applyPose(pose);
}
let ghostHuman: Humanoid | null = null;   // физ-призрак — ТАКОЙ ЖЕ гуманоид (форма/пропорции), ведомый результатом физики
function buildGhost(): void {
  if (ghostHuman) { scene.remove(ghostHuman.root); ghostHuman.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  const c = curChar();
  // Физ-тело = ОСНОВНОЙ рендер как `solid` в игре (единый путь редактор↔игра): те же цвета (body/limb дефолты buildHumanoid),
  // НЕПРОЗРАЧНОЕ. Скелет-манекен (октаэдры) рисуется поверх (manikinOnTop, depthTest off) — кликается для позинга.
  ghostHuman = buildHumanoid({ gender: c.gender, build: morphBuild(c), boneScale: morphBoneScale(), boneOffsets: atlasOff(), body: 0x8a93ad, limb: 0x6f7690, profile: atlasProfile(), fingers: wantFingers() });
  ghostHuman.footLift = physFootLift;                           // подъём стопы: заземление физ-тела на пол (footIk.groundFeet)
  ghostHuman.meshes.forEach((m) => { m.castShadow = true; });   // тени как у игрового solid
  scene.add(ghostHuman.root); ghostHuman.root.visible = physOn;
}
function setPhysVis(on: boolean): void { if (ghostHuman) ghostHuman.root.visible = on; }
// ── Онион-скин: полупрозрачные призраки соседних кадров (пред=синий, след=оранжевый) при позинге в «Анимации» ──
let onionOn = false; let onionPrev: Humanoid | null = null; let onionNext: Humanoid | null = null;
function mkOnion(tint: number): Humanoid {
  const c = curChar();
  const h = buildHumanoid({ gender: c.gender, build: morphBuild(c), boneScale: morphBoneScale(), boneOffsets: atlasOff(), limb: tint, body: tint, head: tint, fingers: wantFingers() });
  for (const m of h.meshes) { const mat = m.material as THREE.MeshStandardMaterial; mat.transparent = true; mat.opacity = 0.32; mat.depthWrite = false; mat.emissive.setHex(tint); mat.emissiveIntensity = 0.25; }
  scene.add(h.root); h.root.visible = false; return h;
}
function disposeOnion(): void {
  for (const h of [onionPrev, onionNext]) if (h) { scene.remove(h.root); h.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  onionPrev = onionNext = null;
}
function applyPoseTo(h: Humanoid, p: Pose): void {   // применить позу (без оружия) к произвольному гуманоиду, выровняв таз к манекену
  h.reset();
  for (const nm in p) { if (nm[0] === '_') continue; const b = h.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); }
  h.bones.get('Hips')!.position.copy(human.bones.get('Hips')!.position);
}

// Ф10: ГРАФ КРИВОЙ — ручки безье вместо трёх кнопок-пресетов. Редактируется РЕМАП ФАЗЫ интервала
// (общий на все кости): клип хранит ПОЗУ ЦЕЛИКОМ на ключ, а не дорожки на кость — см. шапку curveEditor.ts.
let curvePanel: CurvePanel | null = null;
let curveUndo: LibState | null = null;   // снимок на НАЧАЛЕ таскания ручки (та же грабля, что у гизмо: писать после = откат отстаёт на шаг)
function curveSection(c: Clip): void {
  if (!uiPro || !c.keys.length) return;
  const hh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); hh.textContent = 'КРИВАЯ ПЕРЕХОДА'; body.append(hh);
  if (frameIdx >= c.keys.length - 1) {
    const t = el('div', 'color:#6b7180;font-size:10px'); t.textContent = 'Последний кадр — исходящего интервала нет. Кривая живёт на НАЧАЛЕ перехода.';
    body.append(t); return;
  }
  const host = el('div', 'height:132px;background:#0e1016;border:1px solid #39415a;border-radius:4px;margin-bottom:3px'); body.append(host);
  curvePanel?.dispose();
  const keyAt = (): Keyframe | null => curClip()?.keys[frameIdx] ?? null;
  curvePanel = makeCurvePanel(host, {
    key: keyAt,
    onChange: (ease: Ease, live: boolean) => {
      const cc = curClip(); const kk = cc?.keys[frameIdx]; if (!cc || !kk) return;
      if (live && !curveUndo) curveUndo = libSnap();      // снимок ДО первой правки драга
      kk.interp = 'ease'; kk.ease = ease;
      if (!live) {
        saveLib();
        if (curveUndo) { const before = curveUndo, after = libSnap(); history.push('кривая перехода', () => libRestore(before), () => libRestore(after)); curveUndo = null; }
      }
      refreshTimeline();
    },
    onPreview: (u: number) => { const cc = curClip(); const a = cc?.keys[frameIdx], b = cc?.keys[frameIdx + 1]; if (a && b) preview(a.t + (b.t - a.t) * u); },
  });
  const row = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(row);
  const cur = keyAt();
  const active = cur && cur.interp === 'ease' ? matchPreset(easeOfKey(cur)) : null;
  for (const pr of CURVE_PRESETS) {
    const b = pbtn(pr.label, () => histLib('кривая: ' + pr.label, () => {
      const cc = curClip(); if (!cc) return;
      const sl = tl.selection(); const idx = sl.length ? sl : [frameIdx];
      setInterp(cc.keys, idx, 'ease', [...pr.ease] as Ease);
      saveLib(); refreshAll();
    }), active === pr.id);
    b.title = pr.hint; row.append(b);
  }
  const note = el('div', 'color:#6b7180;font-size:10px;margin-top:2px');
  note.textContent = 'Форма общая на весь интервал: ключ хранит позу целиком, а не дорожки на кость.';
  body.append(note);
}

// Ф10: ТРАЕКТОРИЯ выбранной кости во вьюпорте (Cascadeur Trajectories).
// Сэмплим тем же clipSegmentAt, что и проигрыватель — линия показывает РЕАЛЬНЫЙ путь, вместе с кривыми.
let trajOn = false; let trajBtn: HTMLButtonElement | null = null;
let trajLine: THREE.Line | null = null, trajDots: THREE.Points | null = null, trajKeys: THREE.Points | null = null;
let trajArc = 0, trajLen = 0, trajSpan = 0;
function trajLabel(): string { return trajOn && trajLen > 0 ? `↷ дуга ×${trajArc.toFixed(2)} · размах ${trajSpan.toFixed(0)} · путь ${trajLen.toFixed(0)}` : '↷ траектория кости'; }
function trajVisible(v: boolean): void { for (const o of [trajLine, trajDots, trajKeys]) if (o) o.visible = v; }
function updateTrajectory(): void {
  const c = trajOn && tab === 'anim' ? curClip() : null;
  const boneName = selected && human.bones.get(selected) ? selected : 'LeftHand';
  const bone = human.bones.get(boneName);
  if (!c || c.keys.length < 2 || !bone) { trajVisible(false); trajLen = 0; if (trajBtn) trajBtn.textContent = trajLabel(); return; }
  // СНИМОК позы манекена: сэмплить будем на НЁМ (второй гуманоид = ещё 30-60 групп на каждый рефреш)
  const snapQ = human.boneNames.map((n) => human.bones.get(n)!.quaternion.clone());
  const snapHip = human.hips.position.clone();
  const pts: THREE.Vector3[] = [], kpts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (const smp of trajectorySamples(c, 5)) {
    const seg = clipSegmentAt(c, smp.t); if (!seg) continue;
    const pose = seg.a === seg.b ? seg.a.pose : blendTwo(seg.a.pose, seg.b.pose, seg.u);
    human.reset();
    for (const nm in pose) { if (nm[0] === '_') continue; const b = human.bones.get(nm); if (b) b.rotation.set(pose[nm]![0], pose[nm]![1], pose[nm]![2]); }
    { const hp = pose['__hipsP']; if (hp) human.hips.position.set(hp[0], hp[1], hp[2]); }
    human.root.updateMatrixWorld(true);
    bone.getWorldPosition(v);
    pts.push(v.clone()); if (smp.key >= 0) kpts.push(v.clone());
  }
  human.boneNames.forEach((n, i) => human.bones.get(n)!.quaternion.copy(snapQ[i]!));
  human.hips.position.copy(snapHip); human.root.updateMatrixWorld(true);

  const arr = pts.map((q) => [q.x, q.y, q.z] as [number, number, number]);
  trajLen = polylineLength(arr); trajArc = arcRatio(arr); trajSpan = excursion(arr);
  if (!trajLine) {
    trajLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x9ae6a0, depthTest: false, transparent: true, opacity: 0.9 }));
    trajDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x9ae6a0, size: 1.1, depthTest: false, transparent: true, opacity: 0.75 }));
    trajKeys = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffcf66, size: 2.6, depthTest: false }));
    for (const o of [trajLine, trajDots, trajKeys]) { o.renderOrder = 6; o.frustumCulled = false; scene.add(o); }
  }
  trajLine.geometry.dispose(); trajLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  trajDots!.geometry.dispose(); trajDots!.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  trajKeys!.geometry.dispose(); trajKeys!.geometry = new THREE.BufferGeometry().setFromPoints(kpts);
  trajVisible(true);
  if (trajBtn) trajBtn.textContent = trajLabel();
}
function updateOnion(): void {
  if (atlasBS()) { if (onionPrev) onionPrev.root.visible = false; if (onionNext) onionNext.root.visible = false; return; }   // атлас → только скелет+модель
  const c = onionOn && tab === 'anim' ? curClip() : null;
  if (!c || c.keys.length < 2) { if (onionPrev) onionPrev.root.visible = false; if (onionNext) onionNext.root.visible = false; return; }
  if (!onionPrev) { onionPrev = mkOnion(0x4a8cff); onionNext = mkOnion(0xff8c3a); }
  const pv = c.keys[frameIdx - 1], nx = c.keys[frameIdx + 1];
  if (pv) { applyPoseTo(onionPrev!, pv.pose); onionPrev!.root.visible = true; } else onionPrev!.root.visible = false;
  if (nx) { applyPoseTo(onionNext!, nx.pose); onionNext!.root.visible = true; } else onionNext!.root.visible = false;
}
async function ensurePhysics(): Promise<void> {
  if (pw) return;
  await initPhysics();
  pw = new PhysWorld();
  pw.addGround(300);                                        // плоский пол (верх на y=0)
  loadRagdollConfig();                                      // RB3: лимиты/моторы из pe_ragdoll ДО создания рэгдолла
  ragdoll = makeHumanoidRagdoll(pw);
  scene.add(ragdoll.group); ragdoll.group.visible = false;   // боксы-физтела скрыты — показываем гуманоид-призрак
  buildGhost();
  updateWeapon();   // до физики оружие висело на манекене (fallback) → переносим на свежий физ-призрак
}
// RB3: пересборка рэгдолла с текущими LIMITS/MOTOR (они читаются при СОЗДАНИИ в makeCon; live-правка сустава роняет wasm).
function rebuildRagdoll(): void {
  if (!pw || !ragdoll) return;
  scene.remove(ragdoll.group); ragdoll.dispose();
  ragdoll = makeHumanoidRagdoll(pw);
  scene.add(ragdoll.group); ragdoll.group.visible = false;
}
const pinVecs = RAG_NAMES.map(() => new THREE.Vector3()); const pinArr: (THREE.Vector3 | null)[] = RAG_NAMES.map(() => null);
function stepPhysics(dt: number): void {
  if (!pw || !physOn || !ragdoll) return;
  human.root.updateMatrixWorld(true);                        // манекен = целевая поза (правка или интерполяция клипа)
  const hips = human.bones.get('Hips')!;
  const stand = hips.getWorldPosition(V()); const standQ = hips.getWorldQuaternion(Q());
  if (reviveT >= 0) {                                         // вставание: плавно поднимаем таз с пола к стойке
    reviveT += dt; const t = Math.min(1, reviveT / reviveDur), e = t * t * (3 - 2 * t);
    ragdoll.setPelvis(reviveFrom.clone().lerp(stand, e), standQ);
    if (t >= 1) reviveT = -1;
  } else ragdoll.setPelvis(stand, standQ);
  ragdoll.setPoseTarget(human.readPose());
  for (let i = 0; i < RAG_NAMES.length; i++) {               // цели пинов = мир-позиции суставов манекена
    const src = PIN_SRC[RAG_NAMES[i]!]; const b = src ? human.bones.get(src) : undefined;
    if (b) { b.getWorldPosition(pinVecs[i]!); pinArr[i] = pinVecs[i]!; } else pinArr[i] = null;
  }
  ragdoll.setPinTargets(pinArr);
  const [mHR, mHL] = weaponHandMasses(weapon);   // масса рук по main+off (щит/второе оружие → левая)
  ragdoll.setLoad('HandR', mHR); ragdoll.setLoad('HandL', mHL);
  if (locoOn) PHYS.pinKp = lp().attackPinKp ?? DEF_PINKP;   // удар в локо ужесточает пины per-кадр (авторский __pinKp) — ТОЧНО как игра
  const _t0 = performance.now();
  ragdoll.update(dt);   // моторы ведут к позе + пины + вес оружия + kinematic-таз
  pw.step(Math.min(dt, 1 / 60));
  physMs = physMs * 0.9 + (performance.now() - _t0) * 0.1;   // скользящее среднее шага симуляции
  // призрак-гуманоид = физ-результат + заземление стопы (ОБЩИЙ код с игрой) + БЛЕНД к позе-цели. В ЛОКО — ЕДИНЫЙ с игрой effMatch
  // (per-кадр __match удара + ATK_MATCH-рамп поверх базы); в Позы/Анимации — PHYS.match (applyFramePhys). «Упал» → 0 (свободный коллапс).
  if (ghostHuman) {
    // lp() ТОЛЬКО в локо: его конструктор зовёт measureStance→human.reset() (мутирует манекен) — в Позы/Анимации это сбило бы позу.
    const sw = locoOn ? lp().driver.swingLegs : ([false, false] as [boolean, boolean]);
    const rMatch = physDead ? 0 : (locoOn ? renderMatchWeight(physMatchBase, lp().attackWeight, lp().attackMatch) : PHYS.match);
    renderRagdollGhost(ghostHuman, ragdoll, ghostGround, Math.min(dt, 1 / 60), 0, !physDead,
      rMatch > 0.001 ? human.readPose() : null, rMatch, undefined, locoOn ? [!sw[0], !sw[1]] : undefined, footGround);
  }
}
const ghostGround = newGhostGround();
/** Ф4 — ЗАПЕКАНИЕ: прогнать клип через физику, покадрово снять физ-результат → обычная покадровая анимация. */
async function bakeCurrentClip(): Promise<void> {
  await ensurePhysics();
  const c = curClip(); if (!c || !ragdoll) return;
  physOn = true; setPhysVis(true);
  const dur = clipDur(c) || 0.5, dt = 1 / 60, sampleEvery = 2;   // сэмпл 30 к/с
  const baked: Keyframe[] = [];
  preview(0); for (let i = 0; i < 40; i++) stepPhysics(dt);       // устаканиться на стартовой позе
  let simT = 0, step = 0;
  while (simT <= dur + 1e-6) {
    preview(Math.min(simT, dur));                                // манекен = интерполированная авторская поза
    stepPhysics(dt);
    if (step % sampleEvery === 0) baked.push({ pose: ragdoll.readBakedPose(), t: +simT.toFixed(3) });
    simT += dt; step++;
  }
  histLib('запечь физику', () => {
    library.push({ name: c.name + '_baked', character: curCharId, weapon, loop: c.loop, keys: baked });
    clipIdx = clipsHere().length - 1; frameIdx = 0; saveLib(); refreshAll();
  });
}

// ── Вторичное движение (jiggle груди) — пружина от вертик./бокового ускорения груди (основа под плащ/волосы) ──
const JIG = { stiff: 360, damp: 34, scale: 0.0016, max: 0.5 };
let jY = 0, jVy = 0, jX = 0, jVx = 0;
const jAng = { L: 0, R: 0 }, jVel = { L: 0, R: 0 }, jAngX = { L: 0, R: 0 }, jVelX = { L: 0, R: 0 };
function jiggle(dt: number): void {
  const uc = human.bones.get('UpperChest'); const bl = human.bones.get('LeftBreast');
  if (!uc || !bl || dt <= 0) return;                         // только female (есть breast-кости)
  const p = uc.getWorldPosition(V());
  const vy = (p.y - jY) / dt, ay = (vy - jVy) / dt; jY = p.y; jVy = vy;
  const vx = (p.x - jX) / dt, ax = (vx - jVx) / dt; jX = p.x; jVx = vx;
  for (const s of ['L', 'R'] as const) {
    const b = human.bones.get(s === 'L' ? 'LeftBreast' : 'RightBreast'); if (!b) continue;
    jVel[s] += (-JIG.stiff * jAng[s] - JIG.damp * jVel[s] - ay * JIG.scale) * dt; jAng[s] += jVel[s] * dt;   // питч от верт. ускор.
    jVelX[s] += (-JIG.stiff * jAngX[s] - JIG.damp * jVelX[s] - ax * JIG.scale) * dt; jAngX[s] += jVelX[s] * dt;   // свэй от бок. ускор.
    b.rotation.set(clamp(jAng[s], -JIG.max, JIG.max), 0, clamp(jAngX[s], -JIG.max, JIG.max));
  }
}

// ── Цикл ──
ensureSeed();   // первый запуск: залить примерный контент Волкодава (idle-стойки + удары по оружию)
applyChar(curCharId); setMode('ik'); tab = 'anim'; syncModeB(); refreshAll();
void ensurePhysics().then(() => { physOn = true; setPhysVis(true); });   // по умолчанию — полупрозрачное физ-тело (силуэт) вокруг скелета
function resize(): void {
  const w = canvas.clientWidth || 800, h = canvas.clientHeight || 600;
  renderer.setSize(w, h, false); composer.setSize(w, h); outline.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); new ResizeObserver(resize).observe(canvas); resize();
let last = performance.now();
function loop(): void {
  const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
  const c = curClip();
  if (tab === 'turn' && locoOn) updateTurnTest(dt);   // вкладка «Повороты»: прицел=курсор, движение=стой/ходьба/бег
  if (locoOn) stepGait(dt * locoTempo);   // бег = процедурный гейт (ноги) + idle-стойка + физ; locoTempo = скорость ПРОСМОТРА (slow-mo/×)
  else if (playing && c) {
    const dur = clipDur(c);
    if (dur < 1e-3 || c.keys.length < 2) { playing = false; playBtn.textContent = '▶'; }
    else { playT += dt * playSpeed; if (playT > dur) { if (c.loop) playT %= dur; else { playT = dur; playing = false; playBtn.textContent = '▶'; } } preview(playT); tl.draw(); }
  }
  else if (mode === 'ik') {
    // Солвим IK ТОЛЬКО когда реально тянешь эффектор. Иначе (вхолостую) 2-костный IK пересчитывал руки/ноги из
    // позиций эффекторов и ТЕРЯЛ скрутку плеча/ориентацию — та же поза выглядела иначе, чем в FK. Теперь FK-поза
    // сохраняется, а солв идёт лишь на перетаскивании (тогда правка осознанная).
    if (gizmo.dragging) solveRig();
    const active = gizmo.dragging ? gizmo.object : null;
    if (rig.hipsHandle !== active) rig.hipsHandle.position.copy(rig.hipsPos);
    for (const e of effList()) { if (e.handle !== active) e.handle.position.copy(e.target); if (e.poleHandle !== active) e.poleHandle.position.copy(human.bones.get(e.mid)!.getWorldPosition(V())); }
  }
  if (!locoOn) applyLgripPreview();   // Анимация: левая кисть IK-ом на маркер хвата (в Бег это делает gaitToHumanoid)
  updatePlantMarks();
  updateTurnPlants();   // вкладка «Повороты»: живые плант-цели стоп (куда стремятся ноги)
  placeLimitGizmo();    // гизмо предела едет за выбранным суставом манекена
  scrollFloor();   // тредмилл-пол под бегущим (тянется по gaitPx/gaitPz)
  stepPhysics(dt);
  jiggle(dt);   // вторичное движение груди (female)
  // Атлас загрузился/сменился → пересобрать манекен/призрак/онион под пропорции ФБХ (boneScale), чтобы скелет
  // совпадал с мешем. Сравнение по ссылке (меняется только на импорте/загрузке конфига — редко).
  { const bs = modelsTab.boneScale(); if (bs !== lastBS) { lastBS = bs; rebuildManikin(); if (pw) buildGhost(); disposeOnion(); } }
  // Атлас-скин ведём ФИЗ-телом (ghostHuman) — как игра (скин на solid) → превью атласа = игра. Физ off → манекеном.
  // ghostHuman позирован stepPhysics выше (физ-бленд по PHYS.match), у него та же геометрия атласа (buildGhost).
  modelsTab.drive(physOn && ghostHuman ? ghostHuman : human);   // «Модели»: импортный скелет ведётся позой физ-тела (== игра) / манекена
  syncWeaponHost();   // 2B: оружие на кисть ВИДИМОГО атлас-меша (после drive — кисть уже позирована)
  const hideMan = tab === 'models' && modelsTab.hideMannequin();   // прятать манекен/призрак — виден только импорт
  human.root.visible = !hideMan;
  // Загружен атлас → «только скелет + модель»: прячем ЛИШНИЕ процедурные тела (физ-призрак, онион). Меш = визуал тела.
  const atlasOn = !!atlasBS();
  if (ghostHuman) ghostHuman.root.visible = physOn && !hideMan && !atlasOn;
  if (atlasOn) { if (onionPrev) onionPrev.root.visible = false; if (onionNext) onionNext.root.visible = false; }
  orbit.update();
  outline.selectedObjects = selMesh ? [selMesh] : [];   // Ф5: обводка выбранной кости
  if (useComposer) composer.render(); else renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();

(window as unknown as { __pe: unknown }).__pe = { scene, camera, renderer, gizmo, rig, setComposer: (on: boolean): void => { useComposer = on; }, get human() { return human; }, get library() { return library; }, get weapons() { return weaponGroups; }, render: () => renderer.render(scene, camera), setMode, applyChar, setWeapon, solveRig, captureRig, syncEff, pose: () => readPoseFull(), wpos: (b: string) => human.bones.get(b)!.getWorldPosition(V()).toArray().map((v) => +v.toFixed(1)),
  ensurePhysics, bakeCurrentClip, PHYS, LIMITS, MOTOR, rebuildRagdoll, jiggle, get pw() { return pw; }, get ragdoll() { return ragdoll; },
  locoSetVel: (x: number, z: number): void => { locoVx = x; locoVz = z; }, locoStep: (dt: number): void => stepLoco(dt), locoGaitStep: (dt: number): void => stepGait(dt), get locoNodes() { return locoNodes; }, locoAdd: (clip: string, vx: number, vz: number): void => { locoNodes.push({ character: curCharId, weapon, clip, vx, vz }); },
  setPlantCell: (dir: number, run: boolean, lF: number, lL: number, rF: number, rL: number): void => { const cell = (run ? gaitPlant.run : gaitPlant.walk)[((dir % 8) + 8) % 8]!; cell.l = [lF, lL]; cell.r = [rF, rL]; }, get plant() { return gaitPlant; }, get plantSel() { return { dir: plantDirSel, run: plantSpeedRun }; },
  captureUpper, get sway() { return swayCfg; }, resolveUpper: (w: string): unknown => resolveUpper(w), get stances() { return library.filter((c) => c.name.startsWith('idle_')); },
  get lgrip() { return lgripMark; }, lgripEnsure: (): unknown => ensureLgripMark(), lgripPreview: (): void => applyLgripPreview(),   // двуручный хват: маркер + off-hand IK превью (дебаг)
  goFrame, writeFramePhys, get frameIdx() { return frameIdx; },   // per-кадр физ (match/pinKp) — дебаг: goFrame читает, writeFramePhys фиксирует
  gaitAttack: (name: string): void => { const c = clipsHere().find((x) => x.name === name) ?? library.find((x) => x.name === name); if (c) triggerAttack(c); }, get attackT() { return lp().atk.t; }, markAttack: (name: string): void => toggleAtk(name),
  physStep: (dt: number, n: number): unknown => { if (!pw || !ragdoll) return null; physOn = true; for (let i = 0; i < n; i++) { stepPhysics(dt); } return { Hips: ragdoll.bodyPos('Hips'), Head: ragdoll.bodyPos('Head'), HandL: ragdoll.bodyPos('HandL'), HandR: ragdoll.bodyPos('HandR'), FootL: ragdoll.bodyPos('FootL'), Torso: ragdoll.bodyPos('Torso') }; },
  modelsTab, modelsImport: (url: string): Promise<void> => modelsTab.importUrl(url), modelsDebug: (): unknown => modelsTab.debug() };   // E: импорт атласа персонажа (дебаг-хуки)
