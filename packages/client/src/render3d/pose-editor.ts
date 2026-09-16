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
import { makeHumanoidRagdoll, type HumanoidRagdoll, PHYS, LIMITS, MOTOR, loadRagdollConfig, saveRagdollConfig, PIN_SRC, RAG_NAMES, weaponHandMasses, renderRagdollGhost, newGhostGround, canonOfHuman, jointOv, JOINT_DEF, limitViewForBone, registerExtraLimits, applyPhysProfile, physSetCost, PHYS_CATALOG, PHYS_LABEL, PHYS_SET, PHYS_SIZES, physBodies, bodyAxis, physCatalogOff, physCatalogHalf, clothColliderCount, RAG_OF_HUMAN, type PhysSize, type LimitView } from './humanoidRagdoll.js';
import { PHYS_PRESETS, presetBodies } from './physRig.js';
import { scaleJointsToScreen } from './humanoid.js';                       // Ф13.1: суставы постоянного экранного размера
import { PLAYER_RADIUS, MONSTER_RADIUS } from '@dm/shared';                // Ф13.4: тот же радиус, что у сервера   // Ф11: набор физ-тел настраивается в редакторе
import { extraLimitView, LIMIT_PRESETS, findPreset } from './jointLimits.js';
import { solveBalance, type BalanceProbe } from './balanceSolve.js';   // Ф26.6в: перенос веса решается от АВТОРСКОЙ позы
import { makeFullBodyIk, type FbikRig } from './fullBodyIk.js';
import { solveTwoBone, elbowGoal, perpTo, LIMB_SOFT } from './limbIk.js';
import { makeTimelinePanel, setKeyTimes, setInterp, scaleKeys, MARK_COLOR, type TimelinePanel } from './timelinePanel.js';
import { MARK_TRACK, duplicateClipKeys, freeClipNameIn, type MarkType , idleEndsSource } from './clipModel.js';
import { clampClip, clampSummary } from './clipClamp.js';   // ⭐ пределы суставов: та же функция, что на импорте
import { MASK_PARTS, type MaskPart } from './boneMask.js';
import { makeCurvePanel, CURVE_PRESETS, easeOfKey, matchPreset, type CurvePanel, type Ease } from './curveEditor.js';   // Ф10: безье-ручки
import { trajectorySamples, polylineLength, arcRatio, excursion } from './trajectory.js';                                          // Ф10: траектория кости
import { requestGeneration, checkHealth, looksLikeBvh, generatedClipName, DEFAULT_AI_CONFIG, type AiConfig } from './poseAiTab.js';   // Ф9: хук под AI-генерацию
import { capturePose, pastePose, pasteIntoInterval, mirrorPoseSide, flipPoseSides, flipClip, mirrorClip,
  rotateClipPhase, comparePoses, EMPTY_POSE_LIBRARY, type PoseLibrary } from './poseLibrary.js';   // Ф7: библиотека поз и copy-tools   // Ф6: тайм-лайн с дорожками
import { MORPH_PRESETS, MORPH_REGIONS, DEFAULT_MORPH, morphToProfile, morphToBuild, morphToBoneScale,
  mergeBoneScale, applyMorphChange, sampleMorph, rangeWarnings, type BodyMorph, type MorphKey, type MorphRange } from './bodyMorph.js';   // Ф8: морфинг тела   // Ф4: пины + full-body IK
import { findGrip, gripToPose, resolveGripPose, effectiveWeaponGrip, applyGripPose, mirrorHandPose, isHandBone, bakeGripIntoClip, EMPTY_GRIP_CONFIG, type GripConfig, type WeaponGrip } from './gripPoses.js';   // Ф3.5: хват — отдельный канал   // Ф3.3: пределы без физ-тела (пальцы) + пресеты скелета
registerExtraLimits((b) => extraLimitView(b, fingerAxes()));   // до первого limitViewForBone; Ф14.4 — оси из ЭТОГО рига
import { deriveFingerAxes, bindCurlReport, type FingerAxes } from './fingerAxes.js';
import { fitCollider, type BodyPoint } from './colliderFit.js';   // Ф28.3: обжатие по вершинам — чистая математика, node-тест
import { groundFeet, lowestSkinY, measureFootLift } from './footIk.js';   // Ф20.5: заземление попадает в ЗАПИСАННУЮ позу — ОБЩИЙ код с игрой
import { parentOfOur } from './retarget3d.js';   // НАШа канон-топология: вид скелета строится по ней, а не по иерархии модели
import { makeBoneView, type BoneSource } from './boneView.js';   // Ф20.3: скелет по НАСТОЯЩИМ костям модели   // Ф14.4: оси сгиба пальцев из геометрии рига; Ф16 — отчёт о поджатости бинда
import { makeLimitGizmo } from './poseLimitGizmo.js';
import { clampLocalToLimit, decomposeToLimit, setLimitVersion, limitVersion } from './jointClamp.js';
import { dofSpec, quatFromDof, clampDof, dofFromQuat, ringDelta, ringAxis, gimbalFrame, swingRing, type Dof } from './jointDof.js';
import { ASYM, STRAFE, BACK, COMBAT, foldElbow, PoseDriver, GAIT, POSE, HIP_DX, type PoseTargets } from './pose.js';
import { PosePlayer, gaitToHumanoid as rtGaitToHumanoid, baseWeapon as rtBaseWeapon, measureStancePlants, blendVia, migratePoseName, retargetClipName, solveTwoBoneIK, stepTorsoLead, applyTorsoTwist, twistTorso, bendTorso, BEND_W, TWIST_BONES, applyHeadLookAt, applyBaseGrip, renderMatchWeight, TWIST_DEFAULT, TWIST_STATES_DEFAULT, blendTwist, resolveTwistStates, DEFAULT_MATCH, type TwistProfile, type TwistStates, type TwistCfgStored, type PoseContent, weaponChain } from './poseRuntime.js';
import { WEAPONS, OFFHANDS, attachWeapons , hostWeaponOnHand} from './weapon3d.js';
import { CLASS_CHARS, MONSTER_CHARS, type Char } from './chars3d.js';
import { savePoseKey, setPublishPrepare } from './poseServer.js';
import { resolveStancePose, splitHands, isTwoHanded, stancePoseAt } from './poseLayers.js';
import { readAnimCfg, defaultStanceName, type AnimCfg, type AnimItem, type AnimStore } from './animConfig.js';
import { createAnimGraphPanel } from './animGraphPanel.js';
import { createLayerTraceView, type LayerTraceView } from './layerTraceView.js';
import { createTestTab } from './testTab.js';
import { analyzeGait, gaitSuggestions, type GaitSuggestion } from './gaitAnalyze.js';
import { buildInventory, inventorySummary } from './animInventory.js';
import { createPublishButton } from './publishPanel.js';
import { configDirtyKeys, publishConfigEdits } from './configEdits.js';
import { makeHistory } from './history.js';
import { bakeGaitSet, bakeTurnSet, defaultReadPose, GAIT_PRESETS, TURN_PRESETS, defaultBakePick } from './clipBake.js';   // Ф2.1: процедурка → клипы
import { TURN_NAMES } from './turnInPlace.js';
import { findLocoClip, LOCO_NAMES, locoClipNames, LOCO_DIRS } from './locoBlend.js';           // Ф4: какой клип локомоции читает движок
import { exportClipsToGLB, downloadFile } from './clipExport.js';                              // Ф2.3: клипы → GLB + манифест
import type { NameProfile } from './clipToAnimation.js';   // Ф1.3: единый откат — и поза, и структура клипа/библиотеки
import { hipsOffset, setHipsOffset, normalizeClipHips } from './clipModel.js';   // Ф12: офсет таза — ДЕЛЬТА от rest, а не абсолют
import { blendTwo, clipPoseAt, clipSegmentAt, clipDur, slerpEuler, lerpAng, mirrorSide, migrateClip, WPN_KEYS, WPN_POS, DEF_GAP,
  type Pose, type Keyframe, type Clip } from './clipModel.js';   // Ф1.1: одна модель клипа на редактор и игру
import { createModelsTab } from './poseModelsTab.js';

import type { ImportPanel } from './clipImportPanel.js';
import { getPref, setPref, migrateFromUi } from './editorPrefs.js';

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);

/**
 * СОСТОЯНИЕ ИНТЕРФЕЙСА (`pe_ui`) — ОДИН словарь на всё (Ф26.2). Было два независимых чтения того же ключа
 * и запись целиком — любое новое поле затирало бы соседей. Здесь же живут прозрачности и (дальше) свёрнутость свитков.
 */
interface UiState { pro?: boolean; posMark?: boolean; aSkel?: number; aHandle?: number; open?: Record<string, boolean>; clipKind?: string; clipSort?: string; panelW?: number }
const ui: UiState = (() => { try { return JSON.parse(localStorage.getItem('pe_ui') || '{}') as UiState; } catch { return {}; } })();
migrateFromUi(ui as Record<string, unknown>);   // разовый переезд: прозрачности/свитки уже настроены — не терять
/**
 * ⚠ Это ЛИЧНЫЕ настройки рабочего места, а не контент: пишем в `pe_prefs` (он же `UserSettings` из Unity —
 * «can't be checked into source control and shared between users») и НЕ публикуем на сервер. Раньше они
 * ехали в `pe_ui` вместе с контентом и вторая машина перетирала их своими.
 */
function saveUi(): void {
  for (const k of Object.keys(ui) as (keyof UiState)[]) setPref(k, ui[k] as never);
}
/** Прозрачность скелета и ручек: по жалобе «скелет слишком активный, не видно, как выглядит меш». */
let aSkel = ui.aSkel ?? 0.55, aHandle = ui.aHandle ?? 0.7;
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
/**
 * ШАГ ГИЗМО (снап). Включён по умолчанию — в круглые значения попадать проще; Shift во время драга
 * его отключает для точной правки.
 *
 * Величины — НАСТРОЙКА РАБОЧЕГО МЕСТА (`pe_prefs`), а не контент: они не меняют того, как выглядит
 * игра, и на сервер не уезжают (см. шапку `editorPrefs.ts`). Раньше 1 ед и 5° были зашиты числами,
 * и подобрать шаг под задачу было негде: кость таза и фалангу пальца двигаешь одним шагом.
 *
 * Ноль или отрицательное = снап по этой оси выключен: three ждёт `null`, а шаг 0 подвесил бы драг.
 */
let snapOn = getPref('snap', true);
let snapMove = getPref('snapMove', 1);      // ед. мира
let snapRot = getPref('snapRot', 5);        // градусы
function applySnap(off = false): void {
  const on = snapOn && !off;
  gizmo.setTranslationSnap(on && snapMove > 0 ? snapMove : null);
  gizmo.setRotationSnap(on && snapRot > 0 ? THREE.MathUtils.degToRad(snapRot) : null);
}
applySnap();
// ── FK-ГИЗМО ПО ОСЯМ СУСТАВА (локальное, а не мировое): гизмо цепляется к ПРОКСИ, ориентированному по DOF-осям сустава
//    (twist/plane/normal из jointLimitView — те же, что рисует гизмо пределов). Кольцо twist охватывает ось кости → удобно
//    твистить/сгибать сустав. Дельта прокси (мир) → лок. поворот кости → клэмп. Кость без сустава → оси самой кости. ──
const boneProxy = new THREE.Object3D(); boneProxy.name = '__boneProxy'; scene.add(boneProxy);
let dragUndo: State | null = null;   // снимок позы на НАЧАЛЕ драга — иначе откат отставал на шаг (писали уже изменённое состояние)
let fkProxyBone: string | null = null;
let _dofBase: Dof | null = null;          // углы осей сустава, снятые на ЗАХВАТЕ кольца (драг правит их скалярно)
let _dragAxis = -1, _dragAcc = 0, _dragRaw = 0;   // ось ведомого кольца + НАКОПЛЕННЫЙ угол ввода (как оператор Blender)
const _dDof = new THREE.Quaternion(), _parW = new THREE.Quaternion();
const _pBase = new THREE.Quaternion(), _pBaseInv = new THREE.Quaternion(), _bBase = new THREE.Quaternion();
const _parInv = new THREE.Quaternion(), _dq = new THREE.Quaternion(), _nw = new THREE.Quaternion();

const _m4V2 = new THREE.Matrix4(), _rdofV2 = new THREE.Quaternion();
const AXI: Readonly<Record<string, number>> = { X: 0, Y: 1, Z: 2 };
/** Пере-выставить прокси на ТЕКУЩУЮ кость: DOF-базис в мире · её мир-ориентация + позиция сустава. Зов при attach и старте драга. */
/**
 * РИГ, КОТОРЫЙ РЕАЛЬНО ВЕДЁТ МЕШ (Ф20.2) — ровно тот же выбор, что в `modelsTab.drive(…)`.
 *
 * Ретаргет ведёт кости модели И ПОЗИЦИОННО (`posDrive`, retarget3d.ts), то есть суставы модели
 * НАСИЛЬНО садятся на суставы ведущего рига. Замерено на knight_05 с ВЫКЛЮЧЕННОЙ физикой:
 * расхождение тела с манекеном ровно 0.000u (даже при сильном пер-костном морфе), пальцы 0.01u.
 *
 * Значит расхождение, которое видел юзер (колено 18.4°, корень +0.26u), — НЕ ошибка ретаргета и не
 * бленд физики, а то, что ВЕДУЩИЙ РИГ НЕ ТОТ, КОТОРЫЙ МЫ ПОКАЗЫВАЕМ: при включённой физике
 * меш ведёт ЗАЗЕМЛЁННЫЙ призрак, а виджеты читают НЕзаземлённый `human`.
 *
 * ПОЭТОМУ: всё, что ПОКАЗЫВАЕТ (позиции гизмо/хэндлов/фокуса), берёт координаты ОТСЮДА,
 * а всё, что ПРАВИТ позу (`syncEff`, `solveRig`, дельта-математика прокси, разложение по пределам),
 * ОСТАЁТСЯ на `human` — только в его фрейме эта математика верна.
 */
function viewRig(): Humanoid { return physOn && ghostHuman ? ghostHuman : human; }

/**
 * ВИД СКЕЛЕТА ПО НАСТОЯЩИМ КОСТЯМ МОДЕЛИ (Ф20.4). Пока атлас не загружен, его нет и
 * всё работает как раньше: манекен И ЕСТЬ модель, рисовать поверх нечего.
 */
const boneView = makeBoneView();
scene.add(boneView.group);
const boneSrc: BoneSource = {
  get names() { return human.boneNames; },              // порядок родитель→ребёнок уже гарантирован таблицей костей
  parentOf: (n) => parentOfOur(n) ?? null,
  boneOf: (n) => modelsTab.atlasBone(n),
};
/** Рисуем ли сейчас кости модели (а не манекена). */
const onModelBones = (): boolean => boneView.group.visible;
/** Меши для рейкаста/подсветки — чьи кости видны, тех и кликаем. */
const boneMeshes = (): THREE.Mesh[] => (onModelBones() ? boneView.meshes : human.meshes);
let lastAtlasRoot: THREE.Object3D | null | undefined;   // undefined = ещё не смотрели
let lastBoneKey = -1;                                   // размер набора костей манекена (хват добавляет фаланги)
/** Кость ведущего рига по имени (фолбэк на манекен) — только для ОТРИСОВКИ. */
function viewBone(nm: string): THREE.Object3D | null { return viewRig().bones.get(nm) ?? human.bones.get(nm) ?? null; }

/**
 * ПРИПАРКОВАТЬ прокси: `parentWorld · gimbalFrame` + позиция сустава. Зовётся КАЖДЫЙ КАДР вне драга (см. `loop`).
 *
 * Два «почему» вместо одного:
 * 1) **Гимбал-фрейм, а не фрейм кости и не фрейм родителя.** Кольцо обязано стоять там, где оно РЕАЛЬНО крутит;
 *    у эйлеровой цепочки это разные фреймы для разных углов (разбор и цена компромисса — в `jointDof.gimbalFrame`).
 *    `boneWorld·dof` (было до Ф2) верен только для твиста, неподвижный `parentWorld·dof` (был в Ф2) — только для
 *    внешнего угла, и на отпускании кольца ПРЫГАЛИ, меняясь местами.
 * 2) **Каждый кадр, а не на захвате.** `TransformControls` снимает свою точку отсчёта в `pointerDown` — ДО того, как
 *    выстрелит `dragging-changed`. Выставлять прокси в обработчике захвата бесполезно: первое же движение мыши
 *    вернёт его на снятое ТС значение. Значит прокси обязан стоять на месте ЗАРАНЕЕ.
 */
function parkProxy(): void {
  if (!fkProxyBone || gizmo.dragging) return;
  const b = human.bones.get(fkProxyBone); if (!b) return;
  b.parent!.getWorldQuaternion(_parW);
  const vw = limitViewForBone(fkProxyBone);
  if (limitVersion() === 2 || !vw) {
    // v2 (FinalIK) и кость без сустава: драг — СВОБОДНЫЙ поворот, значит и кольца просто ЛОКАЛЬНЫЕ, на кости.
    // Гимбал-фрейм тут не нужен и был бы вреден: там кольца подгонялись под оси скалярной модели, которой нет.
    b.getWorldQuaternion(boneProxy.quaternion);
    // Базис — ИЗ `dofSpec`, а не из полей `plane/normal/twist` напрямую: у ШАРНИРА их нет вовсе (там `axis`),
    // и кольцо вставало мимо оси сгиба — локоть от своего единственного кольца не гнулся (замер: угол 0°).
    if (vw) { const a = dofSpec(vw).axes; boneProxy.quaternion.multiply(_rdofV2.setFromRotationMatrix(_m4V2.makeBasis(a[0], a[1], a[2]))); }
  } else {
    // ГИМБАЛ-ФРЕЙМ (`jointDof.gimbalFrame` — там же разобрано, почему именно он и чем платим).
    // ПОЧЕМУ НЕ ПРОСТО ФРЕЙМ РОДИТЕЛЯ (я так и сделал сначала — юзер поймал): в эйлеровой цепочке ТОЛЬКО ВНЕШНИЙ угол
    // крутит вокруг оси родителя. Средний крутит вокруг оси, уже повёрнутой внешним, а твист — вокруг ТЕКУЩЕЙ оси кости.
    // ЗАМЕР (рука поднята, кость смотрит [0,1,0]): пока держишь кольцо, Z(твист) = [0,1,0] — вдоль кости, верно; а
    // парковка в фрейм родителя ставила Z = [1,0,0] поперёк, и вдоль кости вставал X(сгиб). Кольца буквально менялись
    // местами на отпускании — «оси уезжают, скрутка стала вращением, руку вверх не поднять».
    // Внутренний угол (твист) выкидываем: он ось не двигает, а без него фрейм совпадает с осями средней и внутренней
    // ровно всегда, а с внешней — когда средний угол 0 (это и есть неортогональность гимбала, ортонормировать нечем).
    boneProxy.quaternion.copy(_parW).multiply(gimbalFrame(vw, dofFromQuat(vw, b.quaternion, _dofBase ?? undefined)));
  }
  (viewBone(fkProxyBone) ?? b).getWorldPosition(boneProxy.position);   // Ф20.2: позиция — с ВЕДУЩЕГО рига (там кость модели)
  boneProxy.updateMatrixWorld(true);
}
/** ЗАХВАТ кольца: снять углы сустава (единственное разложение за весь драг) и обнулить накопитель ввода. */
function beginProxyDrag(): void {
  if (!fkProxyBone) return;
  const b = human.bones.get(fkProxyBone); if (!b) return;
  human.root.updateMatrixWorld(true);
  b.getWorldQuaternion(_bBase);
  b.parent!.getWorldQuaternion(_parW); _parInv.copy(_parW).invert();
  _pBase.copy(boneProxy.quaternion); _pBaseInv.copy(_pBase).invert();   // ровно то, что снял ТС в pointerDown
  const vw = limitViewForBone(fkProxyBone);
  // `_dofBase` прошлого драга — ветвь для анроллинга: без неё зажатый −137° прочитался бы как +222° и поза прыгнула бы.
  _dofBase = vw ? dofFromQuat(vw, b.quaternion, _dofBase ?? undefined) : null;
  _dragAxis = -1; _dragAcc = 0; _dragRaw = 0;
}
/** Прицепить гизмо вращения к кости ЧЕРЕЗ прокси (кольца по осям сустава). Замена прямого gizmo.attach(bone). */
function attachBoneGizmo(nm: string): void {
  if (fkProxyBone !== nm) _dofBase = null;   // другая кость — своя ветвь углов, память прошлой не годится
  fkProxyBone = nm; parkProxy();
  const vw = limitViewForBone(nm);
  const lk = vw ? dofSpec(vw).locked : [false, false, false];   // шарнир: две оси заперты → рисуем ОДНО кольцо
  gizmo.showX = !lk[0]; gizmo.showY = !lk[1]; gizmo.showZ = !lk[2];
  gizmo.setSpace('local'); gizmo.setMode('rotate'); gizmo.attach(boneProxy);
}
gizmo.addEventListener('dragging-changed', (e) => { const dragging = (e as unknown as { value: boolean }).value; orbit.enabled = !dragging; if (dragging) { if (gizmo.object === boneProxy && fkProxyBone) beginProxyDrag(); dragUndo = plantDrag >= 0 ? null : snapshot(); return; } if (plantDrag >= 0) { plantDrag = -1; dragMark = null; gizmo.detach(); saveGaitCfg(); } else { bakeBodyFollow(); if (dragUndo) { const before = dragUndo, after = snapshot(); history.push('правка позы', () => restore(before), () => restore(after)); dragUndo = null; } if (!wpnOverride && weaponGroups.includes(gizmo.object as THREE.Group)) saveGripBase(); } });   // правка оружия без галки → авто в БАЗУ pe_grip

const limitGizmo = makeLimitGizmo(); scene.add(limitGizmo.group);   // гизмо предела выбранного сустава (на манекене)
let showLimits = getPref('limitGizmo', true);                       // рисовать пределы выбранного сустава (дефолт вкл)
let clampFk = getPref('clampFk', true);                             // FK-драг клэмпит кость к пределу сустава (дефолт вкл)
let human!: Humanoid;
// Ф14.4: ОСИ ПАЛЬЦЕВ ЭТОГО РИГА (у импортированной модели кисть смотрит куда угодно — фиксированная ось
// врёт). Кэш на объекте `Humanoid`: пересборка манекена создаёт новый объект → вывод обновляется сам,
// а внутри кадра `limitViewForBone` зовётся десятки раз (FABRIK) и не должен пересчитывать оси.
const _fingerAxCache = new WeakMap<Humanoid, Record<string, FingerAxes>>();
function fingerAxes(): Record<string, FingerAxes> | null {
  const h = human as Humanoid | undefined; if (!h) return null;
  let a = _fingerAxCache.get(h);
  if (!a) {
    a = deriveFingerAxes((b) => { const g = h.bones.get(b); return g ? [g.position.x, g.position.y, g.position.z] : null; });
    _fingerAxCache.set(h, a);
  }
  return a;
}
/**
 * ОДИН ИНСТРУМЕНТ ПОЗИНГА (Ф21.1). Было два ВЗАИМНО ИСКЛЮЧАЮЩИХ режима: в IK можно было
 * только двигать ручки (кости не кликались вообще), в FK — только крутить кости (ручки были спрятаны).
 * Из-за этого шесть мест в UI вынужденно дёргали `setMode('fk')`, а гизмо предела в IK не показывалось
 * никогда (оно рисуется по `selected`, а `selected` в IK всегда был `null`).
 *
 * Теперь инструмент ОДИН: клик рейкастит И ручки, И кости сразу (ручки приоритетнее — они мельче
 * и лежат поверх), а `ikOn` — ПРОСТО ТУМБЛЕР инверсной кинематики, как в Cascadeur, где IK/FK —
 * настройка контроллера, а не глобальный режим мыши.
 */
let ikOn = true;
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
  // Ф13.3: на фаланге зона предела (радиус 14u, под кости тела) закрыла бы весь вид — ужимаем ТОЛЬКО её.
  // Ф20.2: ПОЗИЦИЯ — с ведущего рига (гизмо садится на ВИДИМУЮ кость), а КВАТЕРНИОН РОДИТЕЛЯ
  // и `decomposeToLimit` ниже — с `human`: отсчёт предела задан в его фрейме, иначе зона и угол поедут.
  limitGizmo.place((viewBone(selected) ?? b).getWorldPosition(V()), b.parent ? b.parent.getWorldQuaternion(Q()) : Q(), isHandBone(selected) ? 0.18 : 1);
  const d = decomposeToLimit(b.quaternion, curLimitView);
  limitGizmo.mark(curLimitView, d.rP, d.rN, d.twist);
}
let hipsMode: 'translate' | 'rotate' = getPref<'translate' | 'rotate'>('hipsMode', 'translate');
let bodyFollow = 0.45;
let pinPower = 1;                                            // сила привязки (Ф26.7): 1 = точка держится насмерть, 0 = едет за телом

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
/** 2B: КАЖДЫЙ кадр оружие висит на кисти ВИДИМОГО атлас-меша. Вся логика — в `weapon3d.hostWeaponOnHand`,
 *  ОДНА на игру и редактор: раньше это были две копии, и починка одной развела бы хват редактора с игрой. */
function syncWeaponHost(): void {
  for (const g of weaponGroups) {
    const hn = g.userData.handBone as string | undefined; if (!hn) continue;
    hostWeaponOnHand(g, modelsTab.handBone(hn), (ghostHuman ?? human).bones.get(hn) ?? human.bones.get(hn) ?? null);
  }
}

// ── FK-подсветка ──
let selected: string | null = null; let selMesh: THREE.Mesh | null = null; let selEmis = 0;
function highlight(m: THREE.Mesh | null): void {
  if (selMesh) (selMesh.material as THREE.MeshStandardMaterial).emissive.setHex(selEmis);
  selMesh = m; if (m) { const mat = m.material as THREE.MeshStandardMaterial; selEmis = mat.emissive.getHex(); mat.emissive.setHex(0x2e6cff); }
}

// ── IK-риг ──
interface Eff { root: string; mid: string; end: string; pole: THREE.Vector3; swivel: number; bodyApplied: [number, number, number]; keepRot: boolean; isFoot: boolean; pin: boolean; ik: boolean; target: THREE.Vector3; prev: THREE.Vector3; footQuat: THREE.Quaternion; handle: THREE.Mesh; poleHandle: THREE.Mesh; viewOff: THREE.Vector3 }
const LIMB_OF: Record<string, string> = { LeftUpperArm: 'LH', LeftLowerArm: 'LH', LeftHand: 'LH', RightUpperArm: 'RH', RightLowerArm: 'RH', RightHand: 'RH', LeftUpperLeg: 'LF', LeftLowerLeg: 'LF', RightUpperLeg: 'RF', RightLowerLeg: 'RF' };
/** ВСЕ ручки-хелперы в одном списке — чтобы прозрачность применялась одним проходом и никого не забывала. */
const allHandles: THREE.Mesh[] = [];
const mkHandle = (color: number, r: number, box = false): THREE.Mesh => { const m = new THREE.Mesh(box ? new THREE.BoxGeometry(r * 1.6, r * 1.6, r * 1.6) : new THREE.SphereGeometry(r, 12, 10), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 })); m.renderOrder = 999; scene.add(m); allHandles.push(m); return m; };
/**
 * ПРОЗРАЧНОСТЬ СКЕЛЕТА И РУЧЕК (Ф26.2). Приём взят у онион-скина: `transparent` + `opacity` +
 * `depthWrite = false` (иначе прозрачные кости режут друг друга по Z). Непрозрачное состояние (a ≈ 1) возвращает запись в Z,
 * чтобы не платить за сортировку там, где она не нужна. Зовётся после любой пересборки манекена/костей модели.
 */
function applyAlpha(): void {
  const put = (mat: THREE.Material, a: number): void => {
    const m = mat as THREE.MeshStandardMaterial;
    m.transparent = a < 0.999; m.opacity = a; m.depthWrite = a >= 0.999; m.needsUpdate = true;
  };
  for (const m of human.meshes) put(m.material as THREE.Material, aSkel);
  for (const m of boneView.meshes) put(m.material as THREE.Material, aSkel);
  for (const h of allHandles) put(h.material as THREE.Material, aHandle);
}
const rig = {
  hipsPos: V(), hipsQuat: Q(), hipsHandle: mkHandle(0xf0c020, 2.3, true),
  /**
   * ⭐ ГДЕ РУЧКА ТАЗА БЫЛА В ПРОШЛОМ КАДРЕ — опора для дельты драга.
   *
   * Раньше дельта считалась от `hipsPos` (ЖЕЛАНИЕ), а рисовалась ручка тоже по нему. Но помощь
   * баланса (`applyBalance`, до **9 единиц** вбок) двигает КОСТЬ и не трогает желание — значит ручка
   * оставалась на авторском месте, а таз уезжал: «хелпер улетает в бок». Теперь ручка рисуется НА
   * КОСТИ, а драг считает дельту от её же прошлого положения — тогда он верен при любом сдвиге
   * (баланс, кламп по пинам, гейт), а «желание» остаётся отдельной величиной для математики.
   */
  hipsHandleAt: V(),
  eff: {
    LH: { root: 'LeftUpperArm', mid: 'LeftLowerArm', end: 'LeftHand', pole: new THREE.Vector3(0, -1, -0.4), swivel: 0, bodyApplied: [0, 0, 0] as [number, number, number], keepRot: false, isFoot: false, pin: false, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x4a8cff, 1.7), poleHandle: mkHandle(0xff8c3a, 1.3), viewOff: V() },
    RH: { root: 'RightUpperArm', mid: 'RightLowerArm', end: 'RightHand', pole: new THREE.Vector3(0, -1, -0.4), swivel: 0, bodyApplied: [0, 0, 0] as [number, number, number], keepRot: false, isFoot: false, pin: false, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x4a8cff, 1.7), poleHandle: mkHandle(0xff8c3a, 1.3), viewOff: V() },
    LF: { root: 'LeftUpperLeg', mid: 'LeftLowerLeg', end: 'LeftFoot', pole: new THREE.Vector3(0, 0, 1), swivel: 0, bodyApplied: [0, 0, 0] as [number, number, number], keepRot: true, isFoot: true, pin: true, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x46d07a, 1.7), poleHandle: mkHandle(0xff8c3a, 1.3), viewOff: V() },
    RF: { root: 'RightUpperLeg', mid: 'RightLowerLeg', end: 'RightFoot', pole: new THREE.Vector3(0, 0, 1), swivel: 0, bodyApplied: [0, 0, 0] as [number, number, number], keepRot: true, isFoot: true, pin: true, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x46d07a, 1.7), poleHandle: mkHandle(0xff8c3a, 1.3), viewOff: V() },
  } as Record<string, Eff>,
};
const effList = (): Eff[] => Object.values(rig.eff);
/**
 * ХЕЛПЕРЫ ПЛЕЧ (Ф26.3) — ручка на плечевом суставе тянет КЛЮЧИЦУ в её пределах (±20° вперёд-назад,
 * ±15° вверх-вниз, ±10° твист — `jointLimits.ts`). Тот же шов, которым локтевой хелпер Ф25 опускает ключицу
 * автоматом — теперь его можно дёрнуть рукой.
 */
const shoulderHandles: Record<string, THREE.Mesh> = { LH: mkHandle(0xb07aff, 1.5), RH: mkHandle(0xb07aff, 1.5) };

/**
 * ХЕЛПЕР ВЗГЛЯДА (Ф24.2) — aim-констрейнт на голову с распределением по цепочке.
 *
 * Индустрия (Unity Animation Rigging, Multi-Aim): «chain multiple aim constraints — head, neck,
 * upper spine — each with DECREASING weights», иначе вся дуга садится на одну кость; и «set
 * generous limits (45–60 degrees per bone) to prevent the OWL NECK look». Пределы берём не из
 * воздуха, а из той же таблицы суставов, что и весь редактор (`limitViewForBone`).
 *
 * Хранится ОПОРНАЯ ПОЗА шеи/головы (тот же приём, что у `pullBase` в Ф22.3): каждый кадр
 * взгляд СНИМАЕТСЯ и считается заново от авторской позы — иначе довороты копятся и голова
 * «уплывает». Правишь шею/голову руками — опора забывается, твой угол становится новой базой.
 */
const GAZE_BONES: readonly [string, number][] = [['Neck', 0.35], ['Head', 0.65]];   // веса растут к голове
const GAZE_DIST = 55;                                        // как далеко перед лицом встаёт ручка при включении
const GAZE_FWD = new THREE.Vector3(0, 0, 1);                 // в нашем риге вперёд = +Z
let gazeOn = false;
const gazeTarget = V();
const gazeHandle = mkHandle(0xf2f2f2, 1.5);
gazeHandle.visible = false;
/** Луч «голова → точка взгляда»: без него белый шар перед лицом читается как «что-то висит», а не как цель. */
const gazeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(), V()]), new THREE.LineBasicMaterial({ color: 0xf2f2f2, depthTest: false, transparent: true, opacity: 0.35 }));
gazeLine.renderOrder = 998; gazeLine.visible = false; scene.add(gazeLine);
let gazeBase: Map<string, THREE.Quaternion> | null = null;
/** Снять взгляд: вернуть шею/голову в опорную позу (точный откат). */
function gazeRelax(): void {
  if (!gazeBase) return;
  for (const [n, q] of gazeBase) human.bones.get(n)?.quaternion.copy(q);
  human.root.updateMatrixWorld(true);
}
/** Забыть опору: текущий поворот шеи/головы стал АВТОРСКИМ. */
function gazeForget(): void { gazeBase = null; }
/** Довернуть кость своей осью «вперёд» на точку с весом и клэмпом по пределу сустава. */
function aimBoneToPoint(nm: string, target: THREE.Vector3, weight: number): void {
  const b = human.bones.get(nm); if (!b || !b.parent || weight <= 0) return;
  b.updateWorldMatrix(true, false);
  const wq = b.getWorldQuaternion(Q());
  const cur = GAZE_FWD.clone().applyQuaternion(wq);
  const want = target.clone().sub(b.getWorldPosition(V()));
  if (want.lengthSq() < 1e-6) return;
  want.normalize();
  const full = Q().setFromUnitVectors(cur, want);
  const nw = Q().slerp(full, weight).multiply(wq);          // часть дуги, а не вся — отсюда распределение по цепи
  b.quaternion.copy(b.parent.getWorldQuaternion(Q()).invert().multiply(nw));
  const view = limitViewForBone(nm);
  if (view) b.quaternion.copy(clampLocalToLimit(b.quaternion, view));
  b.updateMatrixWorld(true);
}
/** Навести взгляд на `gazeTarget`. Звать ПОСЛЕ солва и ПОСЛЕ `gazeRelax`. */
function applyGaze(): void {
  if (!gazeOn || !human.bones.get('Head')) return;
  if (!gazeBase) { gazeBase = new Map(); for (const [n] of GAZE_BONES) { const b = human.bones.get(n); if (b) gazeBase.set(n, b.quaternion.clone()); } }
  // Два прохода: после клэмпа шеи голове остаётся добрать остаток.
  for (let it = 0; it < 2; it++) for (const [n, w] of GAZE_BONES) aimBoneToPoint(n, gazeTarget, w);
}
/** Вкл/выкл хелпера. При включении цель встаёт ПЕРЕД ЛИЦОМ по МИРОВОМУ вперёд. */
function setGaze(on: boolean): void {
  gazeOn = on; gazeHandle.visible = on || ikOn; gazeLine.visible = gazeHandle.visible; gazeForget();
  gazeB?.classList.toggle('on', on);   // Ф26.3: взгляд включается и КЛИКОМ ПО РУЧКЕ ГОЛОВЫ — кнопка должна это показывать
  if (on) {
    const hd = human.bones.get('Head');
    if (hd) { human.root.updateMatrixWorld(true); gazeTarget.copy(hd.getWorldPosition(V())).add(new THREE.Vector3(0, 0, GAZE_DIST)); }
    gazeHandle.position.copy(gazeTarget);
  }
  refreshPose();
}
const _q = Q();
function aimBoneAt(bone: THREE.Object3D, aim: THREE.Vector3, t: THREE.Vector3): void {
  bone.updateMatrixWorld();
  const bp = bone.getWorldPosition(V());
  const pq = bone.parent!.getWorldQuaternion(_q).clone().invert();
  const desired = t.clone().sub(bp).normalize().applyQuaternion(pq);
  bone.quaternion.setFromUnitVectors(aim, desired); bone.updateMatrixWorld();
}
// Восстановить МИРОВУЮ ориентацию конца эффектора (кисть/стопа) после солва: solve2Bone целит плечо/предплечье
// минимальной дугой (`setFromUnitVectors`) → даёт ПРОИЗВОЛЬНУЮ скрутку, и кисть (с оружием) разворачивало. Держим
// захваченную ориентацию (footQuat) — как у стоп. Так drag руки в IK больше не «сбрасывает» углы и не крутит топор.
/**
 * СВИВЕЛЬ ЛОКТЯ/КОЛЕНА — АНАЛИТИЧЕСКИ, а не через FABRIK (Ф23.1).
 *
 * Свивель — это вращение всей цепи ВОКРУГ ЛИНИИ корень→конец. Оба конца лежат НА этой
 * оси, поэтому кисть/стопа ОСТАЁТСЯ НА МЕСТЕ ПО ПОСТРОЕНИЮ — достаточно повернуть ОДНУ
 * кость-корень (плечо/бедро), остальное поедет за ней как жёсткое тело.
 *
 * Замер до: попытка отдать свивель солверу (полюс → `placeHingeMids`) увозила кисть на 7.07u:
 * принудительный свивель загоняет твист плеча за предел (±80°), клэмп режет — и рука
 * перестаёт целиться (та же причина, что в Ф21.5). Поэтому свивель ставится точной формулой,
 * а солвер после него только ДОБИРАЕТ то, что срезал клэмп.
 */
const SWIVEL_STEPS = 12;                                     // шагов доворота: мельче шаг — точнее упор в предел
const SWIVEL_SLACK = 0.3;                                    // насколько конец вообще вправе сойти с места
function applySwivel(e: Eff): void {
  const root = human.bones.get(e.root), mid = human.bones.get(e.mid), end = human.bones.get(e.end);
  if (!root || !mid || !end || !root.parent) return;
  human.root.updateMatrixWorld(true);
  const ep0 = end.getWorldPosition(V()).clone();
  const rp = root.getWorldPosition(V()), mp = mid.getWorldPosition(V());
  const axis = ep0.clone().sub(rp); if (axis.lengthSq() < 1e-6) return; axis.normalize();
  const perp = (v: THREE.Vector3): THREE.Vector3 => v.addScaledVector(axis, -v.dot(axis));
  const cur = perp(mp.sub(rp)), want = perp(e.pole.clone());
  if (cur.lengthSq() < 1e-6 || want.lengthSq() < 1e-6) return;   // прямая конечность — свивеля нет по определению
  cur.normalize(); want.normalize();
  let ang = Math.acos(clamp(cur.dot(want), -1, 1));
  if (V().crossVectors(cur, want).dot(axis) < 0) ang = -ang;
  if (Math.abs(ang) < 1e-4) return;
  // МАЛЫМИ ШАГАМИ С КЛЭМПОМ И ОТКАТОМ. Сам по себе свивель конец не двигает (оба конца
  // на оси вращения), но КЛЭМП ПЛЕЧА двигает: замер одним большим шагом — сгиб сохранялся
  // точно (110°→110°), а кисть уезжала на 22–29u. Поэтому та же семантика, что у фиксаторов
  // таза (Ф22.4): шагнули → зажали по пределу → если конец сошёл с места, шаг откатили и СТОП.
  // Свивель доворачивается до анатомического предела и там упирается, конец стоит.
  const view = limitViewForBone(e.root);
  for (let i = 0; i < SWIVEL_STEPS; i++) {
    const q0 = root.quaternion.clone();
    const ax = end.getWorldPosition(V()).sub(root.getWorldPosition(V()));
    if (ax.lengthSq() < 1e-6) break;
    const w = root.getWorldQuaternion(Q()).premultiply(Q().setFromAxisAngle(ax.normalize(), ang / SWIVEL_STEPS));
    root.quaternion.copy(root.parent.getWorldQuaternion(Q()).invert().multiply(w));
    if (view) root.quaternion.copy(clampLocalToLimit(root.quaternion, view));
    human.root.updateMatrixWorld(true);
    if (end.getWorldPosition(V()).distanceTo(ep0) > SWIVEL_SLACK) { root.quaternion.copy(q0); human.root.updateMatrixWorld(true); break; }
  }
}
function setEndOrient(e: Eff): void {
  const end = human.bones.get(e.end)!; end.updateMatrixWorld();
  const pInv = end.parent!.getWorldQuaternion(Q()).invert();
  end.quaternion.copy(pInv.multiply(e.footQuat));
  // Ф21.5: КЛЭМП. Держать МИРОВУЮ ориентацию при повороте плеча на 90° значит вывернуть
  // запястье на те же 90°. Живое запястье так не умеет: оно держит ориентацию НАСКОЛЬКО МОЖЕТ.
  const view = limitViewForBone(e.end);
  if (view) end.quaternion.copy(clampLocalToLimit(end.quaternion, view));
  end.updateMatrixWorld();
}
// Захватить цель И полюс (направление изгиба локтя/колена) из ТЕКУЩЕЙ позы кости —
// чтобы возврат в IK воспроизводил позу, а не сбрасывал ручную докрутку сустава.
/**
 * СМЕЩЕНИЕ РУЧКИ ОТ СУСТАВА К ВИДИМОЙ ТОЧКЕ (только кисти). Кость `LeftHand` — это ЗАПЯСТЬЕ, а глазами кисть
 * находится дальше по ладони, и ручка выглядела «уехавшей в сторону» от руки (жалоба со скрина). Сдвигаем ЛИШЬ
 * ОТРИСОВКУ: цель ИК остаётся на суставе, драг вычитает то же смещение обратно — иначе рука прыгала бы на него.
 * Ориентир — основание среднего пальца ВИДИМОГО рига; нет пальцев → доля вдоль оси кисти.
 */
function handleViewOff(e: Eff, out: THREE.Vector3): THREE.Vector3 {
  out.set(0, 0, 0);
  if (e.isFoot) return out;
  const end = viewBone(e.end); if (!end) return out;
  const ep = end.getWorldPosition(V());
  const mid = viewBone(e.end.replace('Hand', 'MiddleProximal'));
  if (mid) return out.copy(mid.getWorldPosition(V())).sub(ep).multiplyScalar(0.75);
  const fore = viewBone(e.mid); if (!fore) return out;
  const dir = ep.clone().sub(fore.getWorldPosition(V()));
  return dir.lengthSq() > 1e-6 ? out.copy(dir).normalize().multiplyScalar(2.2) : out;
}
function syncEff(e: Eff): void {
  const root = human.bones.get(e.root)!, mid = human.bones.get(e.mid)!, end = human.bones.get(e.end)!;
  root.updateMatrixWorld(); mid.updateMatrixWorld(); end.updateMatrixWorld();
  const rp = root.getWorldPosition(V()), mp = mid.getWorldPosition(V()), ep = end.getWorldPosition(V());
  e.target.copy(ep); e.prev.copy(ep);
  const dir = ep.clone().sub(rp);
  if (dir.lengthSq() > 1e-6) { const perp = mp.clone().sub(rp).sub(dir.clone().multiplyScalar(mp.clone().sub(rp).dot(dir) / dir.lengthSq())); if (perp.lengthSq() > 1) e.pole.copy(perp.normalize()); }   // прямая рука → полюс не трогаем
  e.footQuat.copy(end.getWorldQuaternion(Q()));   // ориентация КОНЦА (кисть/стопа) — восстановим после солва (иначе IK крутит скрутку)
}
/**
 * РУЧКИ ГОНЯТСЯ ЗА КОСТЯМИ (каждый кадр вне драга). Позу НЕ трогает.
 *
 * ЗАПИНЕННЫЕ ЦЕЛИ НЕ ОБНОВЛЯЮТСЯ (Ф22.1) — в этом весь смысл пина. Раньше `captureRig`
 * звался каждый кадр и тянул `syncEff` для ВСЕХ — то есть стоило отпустить мышь, как цель пина
 * переезжала на то место, куда точку как раз увезло. Пин отменял сам себя.
 */
function syncHandles(): void {
  // АВТОРСКИЙ ПОВОРОТ ТАЗА ЗДЕСЬ НЕ ПЕРЕЧИТЫВАЕТСЯ (Ф26.7). Было `rig.hipsQuat.copy(hips.quaternion)` — и доворот
  // таза от тяги тела каждый кадр ВПИТЫВАЛСЯ в авторскую позу (замер: 3.2° → 6.2° → 9.1° → 14.2° за пять кадров),
  // плечо уезжало вместе с ним, и тяга, меряемая от плеча, таяла — корпус САМ РАСПРЯМЛЯЛСЯ за несколько кадров
  // (жалоба «он выпрямляет корпус и руки уезжают»). Авторский таз меняют ручка таза, FK-правка и смена позы — они пишут явно.
  const hips = human.bones.get('Hips')!; rig.hipsPos.copy(hips.position).sub(balanceOff);   // Ф26.6б: без вычета сдвиг баланса впитался бы в позу и персонаж уползал
  human.root.updateMatrixWorld(true);
  // Ф25.5: без исключения `activePole` — вне драга оно только мешало: ручка кисти не садилась на кисть
  // до следующего клика (замер: расхождение 1.8u держалось после отпускания).
  for (const e of effList()) if (!(e.ik && e.pin)) syncEff(e);
}
/** Поза ЗАМЕНЕНА (клип/кадр/T-поза/undo): всё перечитываем заново, включая пины и опору корпуса. */
function captureRig(): void {
  pullForget(); gazeForget(); girdleForget(); hipsGood = null; pinBase = 0; goodPose.clear();
  for (const e of effList()) { e.bodyApplied[0] = 0; e.bodyApplied[1] = 0; e.bodyApplied[2] = 0; }   // поза заменена — она авторская целиком
  // ⚠ ВЫЧИТАЕМ СДВИГ БАЛАНСА, КАК `syncHandles`. Раньше здесь его не было, и `rig.hipsPos` (ЖЕЛАНИЕ)
  // расходился с ним же на следующем кадре: ЗАМЕР — кость (0, 32, 0), а желание уезжало в (−3, 32, −2)
  // на «мёртвый» сдвиг от ПРЕДЫДУЩЕЙ позы. Ручка таза прыгала туда же — «улетает в бок», и следом
  // кривилась поза, потому что желание и есть то, куда тянут таз.
  const hips = human.bones.get('Hips')!; rig.hipsPos.copy(hips.position).sub(balanceOff); rig.hipsQuat.copy(hips.quaternion);
  human.root.updateMatrixWorld(true);
  for (const e of effList()) syncEff(e);
}
// Ф4: FULL-BODY IK. Пересобирается вместе с манекеном (смена персонажа/пальцев/пропорций).
let fbik: FbikRig | null = null;
let fbikFor: Humanoid | null = null;
/**
 * СОЛВЕР КОНЕЧНОСТЕЙ (Ф25.6). Дефолт — АНАЛИТИКА (`limbIk.ts`): двухкостная цепь по закону
 * косинусов с полюсом и soft IK, как в Maya/Unity/UE. FABRIK оставлен за Про-кнопкой на один релиз
 * для сравнения: на шарнире локтя/колена он теряет непрерывность (замер: «кисть к бедру» —
 * сгиб 7° вместо 24°, недолёт 6u).
 */
let solverMode: 'analytic' | 'fabrik' = getPref<'analytic' | 'fabrik'>('solver', 'analytic');
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
/**
 * ОПОРНАЯ ПОЗА КОРПУСА ДЛЯ PULL (Ф22.3) — кватернионы [Spine..Head] ДО того, как Pull
 * впервые довернул корпус.
 *
 * Было число `pullTwist` («сколько я накрутил в ЭТОМ драге»), и его обнулял `captureRig` —
 * а он звался КАЖДЫЙ КАДР вне драга. Следствие, на которое и пожаловался юзер: завёл руку
 * назад → корпус довернулся → отпустил мышь → скрутка ЗАПЕКЛАСЬ в позу и снять её было уже нечем;
 * двигаешь руку обратно — корпус стоит скрученный.
 *
 * Модель взята из HumanIK Stiffness: часть тела «resists transformation and tries to maintain its
 * INITIAL FK ANGLES» — то есть у корпуса есть ОПОРНЫЕ УГЛЫ, к которым он возвращается, а не
 * накопитель поворотов. Опора ЖИВЁТ МЕЖДУ ДРАГАМИ и забывается только когда корпус правят
 * РУКАМИ или меняют позу целиком. Авторский изгиб руки/ноги при этом НЕ трогается вовсе:
 * восстанавливаются ТОЛЬКО кости цепочки скрутки.
 */
let pullBase: Map<string, THREE.Quaternion> | null = null;
/** ОПОРНАЯ ПОЗА КЛЮЧИЦЫ (Ф25.3) — тот же приём, что `pullBase`: плечевой пояс каждый солв стартует
 *  из авторской позы, и ключица сама возвращается, когда рука достаёт без неё. */
let girdleBase: Map<string, THREE.Quaternion> | null = null;
function girdleRelax(): void {
  if (!girdleBase) return;
  for (const [n, q] of girdleBase) human.bones.get(n)?.quaternion.copy(q);
  human.root.updateMatrixWorld(true);
}
function girdleForget(): void { girdleBase = null; }
/** Вернуть корпус в опорную позу (точный откат, без накопления ошибки). */
function pullRelax(): void {
  if (!pullBase) return;
  for (const [n, q] of pullBase) human.bones.get(n)?.quaternion.copy(q);
  human.hips.quaternion.copy(rig.hipsQuat);   // Ф26.6: таз тоже участвует в тяге — его авторское состояние в `rig.hipsQuat`
  human.root.updateMatrixWorld(true);
}
/**
 * ЗАПЕЧАТАТЬ ТЯГУ ТЕЛА В ПОЗУ (Ф26.7) — зовётся на отпускании мыши. Согнутый корпус становится АВТОРСКИМ
 * (`pullForget`), а вклад каждой руки запоминается — чтобы следующий солв не добавил то же самое второй раз.
 * Так поза держится при любом следующем действии (голова, клик мимо, другая рука), но не накапливается.
 */
function bakeBodyFollow(): void {
  for (const k in rig.eff) {
    const e = rig.eff[k]!; if (!e.ik || e.isFoot) continue;
    const a = bodyFollowAngles(e) ?? [0, 0, 0];
    e.bodyApplied[0] = a[0]; e.bodyApplied[1] = a[1]; e.bodyApplied[2] = a[2];
  }
  pullForget();
}
/** Забыть опору: текущий поворот корпуса стал АВТОРСКИМ и откатывать его больше нельзя. */
function pullForget(): void { pullBase = null; }
function solveRig(): void {
  const hips = human.hips;
  hips.position.copy(rig.hipsPos); hips.quaternion.copy(rig.hipsQuat); hips.updateMatrixWorld(true);
  pullRelax(); girdleRelax();                                               // Ф22.3: корпус всегда стартует из опорной позы — и сам распрямляется, когда рука достаёт
  clampHipsToPins();                                         // Ф22.2: таз не уезжает дальше, чем пускают заколотые конечности
  if (solverMode === 'fabrik') solveRigFabrik(); else solveRigAnalytic();
  // ОРИЕНТАЦИЯ КОНЦА — ОТДЕЛЬНЫЙ КАНАЛ ОТ ПОЗИЦИИ (Ф24.1), как Reach T / Reach R в HumanIK:
  // «adjust the percentage of translation and rotation reach… using the Reach T and Reach R sliders».
  //
  // До Ф24 держалось ВСЕГДА (Reach R жёстко = 1), и из-за этого кисть, опущенная из T-позы,
  // оставалась ПАРАЛЛЕЛЬНОЙ ПОЛУ и выкручивала руку: замер — опустили кисть на 21.5u,
  // запястье вывернулось на 51.3° от нейтрали.
  //
  // СТОПЫ держат (`keepRot`): подошва обязана стоять плоско на полу. КИСТИ — НЕТ: их локальный
  // поворот остаётся нетронутым, и кисть едет за предплечьем — то самое «естественное положение».
  // Для оружия есть тумблер на конечность — включил, и кисть снова держит мировой угол. В FBIK-пути `setEndOrient` не звался ни разу —
  // только в старом двухкостном фолбэке. Из-за этого кисть с оружием крутилась за предплечьем, а стопа
  // на запиненной ноге разворачивалась на полу. Держим захваченную ориентацию только там, где её
  // действительно просят: у перетаскиваемого и у запиненных.
  human.root.updateMatrixWorld(true);
  for (const k in rig.eff) { const e = rig.eff[k]!; if (e.ik && e.keepRot && (k === activeKey || e.pin)) setEndOrient(e); }

  // Стопы/кисти без цели едут за телом — подтягиваем их ручки к фактическому положению костей.
  human.root.updateMatrixWorld(true);
  for (const k in rig.eff) {
    const e = rig.eff[k]!;
    // Ф23.1: ЦЕЛЬ НЕ ПЛЫВЁТ ПРИ ДРАГЕ ПОЛЮСА. Без `k !== activePole` цель той же конечности
    // переписывалась каждый кадр на текущее место кисти — удерживать было НЕЧЕГО, и свивель
    // увозил конец на 20–26u вместо того, чтобы вращать локоть вокруг него.
    if (!e.pin && k !== activeKey && k !== activePole) e.target.copy(human.bones.get(e.end)!.getWorldPosition(V()));
    if (e.isFoot) e.footQuat.copy(human.bones.get(e.end)!.getWorldQuaternion(Q()));
  }
  // ЖЕЛАНИЕ НЕ ЗАТИРАЕМ ФАКТОМ (Ф22.4). Здесь стояло `rig.hipsPos.copy(human.hips.position)`, и кламп
  // дрался с драгом: `moveHips` считает дельту ОТ `rig.hipsPos`, а тот уезжал под кламп.
  // Теперь `rig.hipsPos` = ЖЕЛАНИЕ (куда тянешь), кость = РЕЗУЛЬТАТ — точно как у ручки кисти,
  // которая может быть вне досягаемости. `syncHandles` вне драга схлопывает желание к факту.
}

/** Старый путь (Ф21–Ф24): FABRIK по дереву с маской/жёсткими костями. Живёт за Про-кнопкой для сравнения (Ф25.6). */
function solveRigFabrik(): void {
  const plan = solvePlan();
  const anchorBone = plan.anchorBone;
  if (plan.targets.size) {
    const f = getFbik();
    const anchor = { bone: anchorBone, pos: plan.anchorPos ?? human.hips.getWorldPosition(V()) };
    f.solve(plan.targets, anchor, plan.mask, plan.poles, plan.rigid);
    if (activeKey === 'hips') hipsFollowPins();   // Ф22.4: таз не уйдёт туда, откуда ноги не дотянутся
    // PULL — ВТОРАЯ ПОПЫТКА ПО ФАКТИЧЕСКОМУ НЕДОЛЁТУ, а не по расчётной длине цепи (Ф21.4).
    //
    // Первая версия сравнивала дистанцию до цели с суммой длин звеньев — то есть видела только «далеко»
    // и не видела «не в ту сторону». А главный случай юзера («правую руку тяну налево») ПО ДИСТАНЦИИ
    // ДОСТИЖИМ: цель ближе длины руки, просто за серединой тела — и корпус не подключался никогда.
    //
    // Теперь критерий — РЕЗУЛЬТАТ: решили одну конечность → посмотрели, где кисть ФАКТИЧЕСКИ оказалась.
    // Не дошла — неважно почему (длины не хватило или ПРЕДЕЛ СУСТАВА не пустил) — подключаем корпус
    // и решаем ещё раз. Это и есть HumanIK-семантика Pull, только честная: «эффект виден, когда вытянутой
    // руки НЕ ХВАТАЕТ до цели». `bodyFollow` задаёт СИЛУ: корпус закрывает только его долю недолёта,
    // поэтому при pull &lt; 1 кисть честно не дотягивается до ручки.
    const pull = plan.pull;
    if (pull && bodyFollow > 0 && missOf(pull) > PULL_SLACK) {
      // ШАГ 1 — СКРУТКА. Горизонтальный угол недолёта, видимый ИЗ ТАЗА, размазывается по спине
      // тем же швом, что и скрутка в походке. НЕ через FABRIK: позиционный солвер на тяге
      // кисти вбок выдаёт БОКОВОЙ НАКЛОН (замер: Spine z=23°, y=−1°), а человек СКРУЧИВАЕТСЯ.
      if (pullTwistToward(pull.end, pull.goal)) f.solve(plan.targets, anchor, plan.mask, plan.poles, plan.rigid);   // плечо уехало — дорешаем руку
      // ФАБРИКА ПО СПИНЕ ЗДЕСЬ НЕ ДЕЛАЕТСЯ, и это ЗАМЕРЕННОЕ решение, а не лень. Была вторая
      // ступень: «если после скрутки всё ещё не дотянулись — добавить корпус в маску FABRIK«. Замер на тяге
      // кисти на 40u: недолёт стал ХУЖЕ (6.96 → 9.38), а спина получила Chest [10, 20, 24] — тот самый
      // боковой наклон с роллом, на который жаловался юзер, и левая кисть улетала на 43u. Позиционный солвер
      // на развилке корпуса (две руки + шея от UpperChest) усредняет суб-базу — известная слабость FABRIK.
      // Не дотянулся скруткой — значит честно не дотянулся (как Pull в HumanIK); наклониться — ручка таза.
    }
  }
}

/** Недолёт конца конечности до своей цели (мир). */
function limbMiss(e: Eff): number {
  human.root.updateMatrixWorld(true);
  return human.bones.get(e.end)!.getWorldPosition(V()).distanceTo(e.target);
}
/**
 * PULL-СКРУТКА КОРПУСА К ЦЕЛИ (Ф21.4, вынесено в Ф25). Горизонтальный угол недолёта кости `endName`
 * до `goal`, видимый из таза, размазывается по спине тем же швом, что и скрутка в походке. НЕ через FABRIK:
 * позиционный солвер на тяге кисти вбок выдаёт БОКОВОЙ НАКЛОН, а человек СКРУЧИВАЕТСЯ. Сила — `bodyFollow`.
 * Возвращает true, если корпус реально довернулся (значит, конечность надо дорешать).
 */
function pullTwistToward(endName: string, goal: THREE.Vector3): boolean {
  const hp = human.hips.getWorldPosition(V());
  const got = human.bones.get(endName)!.getWorldPosition(V());
  const a = Math.atan2(goal.x - hp.x, goal.z - hp.z) - Math.atan2(got.x - hp.x, got.z - hp.z);
  const res = clamp(Math.atan2(Math.sin(a), Math.cos(a)) * bodyFollow, -PULL_TWIST, PULL_TWIST);
  if (Math.abs(res) <= 1e-3) return false;
  if (!pullBase) { pullBase = new Map(); for (const n of TWIST_BONES) { const b = human.bones.get(n); if (b) pullBase.set(n, b.quaternion.clone()); } }
  twistTorso(human, res, PULL_W);
  human.root.updateMatrixWorld(true);
  return true;
}

/**
 * ТЕЛО ЕДЕТ ЗА РУКОЙ (Ф26.6) — три степени свободы плюс доворот таза.
 *
 * Жалоба юзера: «оттянул руку вверх и назад — тело почти не едет, а хочется завести руку назад и чтобы
 * корпус довернул и выгнулся назад, естественно». Две причины, почему раньше не ехало:
 *  1) КОГДА: старый Pull включался ТОЛЬКО по НЕДОЛЁТУ (Ф21.4) — а замах руке ДОСТУПЕН, значит корпус
 *     не подключался НИКОГДА. Теперь ведёт НАТЯЖЕНИЕ: с 70% вытяжения руки и плавно до 1 на полном
 *     (недолёт остался вторым драйвером — цель вне досягаемости тоже тянет тело).
 *  2) ЧТО: была одна ось — осевая скрутка. Прогиба назад в коде не было вообще (`bendTorso`, Ф26.6).
 *
 * Направление тяги считается В ФРЕЙМЕ ТАЗА от НЕЙТРАЛИ РУКИ (вбок, ±X), а не от «вперёд»: рука,
 * разведённая в сторону, корпус не крутит, а вынесенная вперёд/назад — крутит (анатомия плечевого пояса).
 * Каждая ось клэмпится своим анатомическим пределом, потом размазывается по спине весами (`bendTorso`).
 */
/**
 * ТЯГА ТЕЛА ОТ ВСЕХ РУК СРАЗУ (Ф26.7). Раньше корпус гнула ТОЛЬКО перетаскиваемая конечность —
 * и стоило тронуть голову (или любую другую ручку), как `pullRelax()` в начале солва ВЫПРЯМЛЯЛ корпус
 * обратно (жалоба: «делаю что-то с головой — он выпрямляет корпус и руки уезжают»). Теперь поза корпуса —
 * ДЕТЕРМИНИРОВАННАЯ ФУНКЦИЯ ЦЕЛЕЙ ВСЕХ РУК: что бы ты ни трогал, она пересчитывается та же самая.
 * Вклады рук складываются и клэмпятся общим пределом — две руки в разные стороны гасят друг друга, как и должны.
 */
function applyBodyFollow(boostKey?: string, boost = 0): boolean {
  if (bodyFollow <= 0) return false;
  let tw = 0, pitch = 0, roll = 0;
  for (const k in rig.eff) {
    const e = rig.eff[k]!; if (!e.ik || e.isFoot) continue;
    const a = bodyFollowAngles(e, k === boostKey ? boost : 0) ?? [0, 0, 0];
    // ПРИМЕНЯЕТСЯ ДЕЛЬТА К УЖЕ ЗАПЕЧАТАННОМУ ВКЛАДУ этой руки (`bodyApplied`), и только пока рука «живая»
    // (тянем или она запинена). Свободная рука едет вместе с корпусом, её цель тянется следом — если такую
    // считать драйвером, тяга разгоняет сама себя (замер: −21° → −30° → −45° в предел за пять кадров); если НЕ считать
    // и ничего не запечатывать — клик мимо распрямляет готовый замах. Поэтому на отпускании мыши вклад
    // ЗАПЕЧАТЫВАЕТСЯ в авторскую позу (`bakeBodyFollow`), и дальше дельта = 0.
    const live = e.pin || k === activeKey || k === activePole;
    if (live) { tw += a[0] - e.bodyApplied[0]; pitch += a[1] - e.bodyApplied[1]; roll += a[2] - e.bodyApplied[2]; }
    else { e.bodyApplied[0] = a[0]; e.bodyApplied[1] = a[1]; e.bodyApplied[2] = a[2]; }
  }
  tw = clamp(tw, -PULL_TWIST * flexTw, PULL_TWIST * flexTw);
  pitch = clamp(pitch, -BEND_EXT * flexBend, BEND_FLEX * flexBend);
  roll = clamp(roll, -BEND_ROLL * flexBend, BEND_ROLL * flexBend);
  if (Math.abs(tw) < 1e-3 && Math.abs(pitch) < 1e-3 && Math.abs(roll) < 1e-3) return false;
  if (!pullBase) { pullBase = new Map(); for (const n of TWIST_BONES) { const b = human.bones.get(n); if (b) pullBase.set(n, b.quaternion.clone()); } }
  bendTorso(human, tw, pitch, roll, PULL_W, BEND_W);
  if (pelvisFollow > 0 && Math.abs(tw) > 1e-3) human.hips.rotateY(tw * pelvisFollow * flexPelvis);
  human.root.updateMatrixWorld(true);
  return true;
}
function bodyFollowAngles(e: Eff, missDrive = 0): [number, number, number] | null {
  if (e.isFoot || bodyFollow <= 0) return null;
  const root = human.bones.get(e.root), mid = human.bones.get(e.mid), end = human.bones.get(e.end);
  if (!root || !mid || !end) return null;
  human.root.updateMatrixWorld(true);
  const L = mid.position.length() + end.position.length();
  const S = root.getWorldPosition(V());
  const v = e.target.clone().sub(S).applyQuaternion(human.hips.getWorldQuaternion(Q()).invert());   // в фрейме таза: +X влево, +Z вперёд
  const side = e.root.startsWith('Left') ? 1 : -1;
  // СИЛА ТЯГИ — МАКСИМУМ ТРЁХ ПРИЗНАКОВ «поза стала крайней»:
  //  * ВЫНОС руки от анатомической нейтрали (рука вдоль тела) — ГЛАВНЫЙ: настоящий замах делают
  //    СОГНУТОЙ рукой, и по одной дистанции он не отличается от руки у груди (замер: одно натяжение
  //    давало 0.37 и прогиб всего 2.2° на замахе);
  //  * НАТЯЖЕНИЕ по длине (решение юзера: с 70% вытяжения);
  //  * НЕДОЛЁТ (цель вне досягаемости) — поведение Ф21.4, чтобы не потерять старый случай.
  const neutral = V().set(0.35 * side, -1, 0).normalize();   // рука висит вдоль тела, чуть отведена
  const exc = Math.acos(clamp(v.clone().normalize().dot(neutral), -1, 1)) / Math.PI;
  // Натяжение ГАСИТСЯ у нейтрали: рука, висящая вдоль тела, тоже почти полностью вытянута — без этого
  // гейта просто стоящий персонаж клонило вперёд на 10.5° (замер).
  const dirGate = clamp((exc - 0.15) / 0.2, 0, 1);
  const follow = Math.max(
    clamp((exc - 0.25) / 0.45, 0, 1),                                            // первые ~45 градусов выноса тело игнорирует
    clamp((S.distanceTo(e.target) / L - PULL_START) / (1 - PULL_START), 0, 1) * dirGate,
    missDrive);
  const amt = follow * bodyFollow;
  if (amt < 0.02) return null;
  const horiz = Math.hypot(v.x, v.z) || 1e-6;
  const elev = Math.atan2(v.y, horiz);                       // выше плеча → прогиб назад
  const yaw = Math.atan2(v.z, v.x * side);                   // 0 = рука вбок (нейтраль), + вперёд, − назад
  const cross = Math.min(0, (v.x * side) / L);               // рука ушла ЗА СРЕДИНУ тела → боковой наклон
  return [-side * yaw * gTwist * amt, -elev * gPitch * amt, -side * cross * BEND_ROLL * 2 * gRoll * amt];
}
/**
 * ЦЕНТР МАСС ПО ФИЗ-ТЕЛАМ (Ф26.6б). Масса тела = объём его формы × плотность, положение — центр формы
 * на ТЕКУЩЕЙ позе (кость цепи + смещение, повёрнутое её мировым кватернионом). Плюс масса оружия в кистях —
 * топор реально тянет центр масс туда, куда его вынесли.
 *
 * Почему по физ-телам, а не по «примерным весам костей»: после Ф26.5 тела сняты с костей и едут за
 * морфом — значит центр масс автоматически верен для толстого, худого и высокого без отдельной таблицы.
 */
function massCenter(): { p: THREE.Vector3; m: number } {
  const p = V(); let m = 0;
  human.root.updateMatrixWorld(true);
  for (const pb of physBodies()) {
    const sh = pb.shape;
    const vol = sh.k === 'box' ? 8 * sh.h[0]! * sh.h[1]! * sh.h[2]!
      : sh.k === 'sphere' ? (4 / 3) * Math.PI * sh.r ** 3
      : sh.k === 'cylinder' ? Math.PI * sh.r ** 2 * sh.half * 2
      : Math.PI * sh.r ** 2 * sh.half * 2 + (4 / 3) * Math.PI * sh.r ** 3;
    const bone = human.bones.get((pb.chain.length ? pb.chain : [pb.name])[0]!); if (!bone) continue;
    const c = bone.getWorldPosition(V()).add(V().set(pb.off[0], pb.off[1], pb.off[2]).applyQuaternion(bone.getWorldQuaternion(Q())));
    p.addScaledVector(c, vol); m += vol;
  }
  const [lw, rw] = weaponHandMasses(weapon);                                    // оружие в кг → в тех же единицах объёма
  for (const [nm, kg] of [['LeftHand', lw], ['RightHand', rw]] as const) {
    if (kg <= 0) continue;
    const b = human.bones.get(nm); if (!b) continue;
    const vol = kg / 1000 * 32 * 32 * 32;   // кг → объём в юнитах при метре = 32u (та же плотность, что у тел)
    p.addScaledVector(b.getWorldPosition(V()), vol); m += vol;
  }
  if (m > 1e-6) p.multiplyScalar(1 / m);
  return { p, m };
}
/** ОПОРА: прямоугольник в плане по стоящим стопам (запиненным или лежащим на полу). Нет таких — баланс не работает. */
function supportRect(): { x0: number; x1: number; z0: number; z1: number } | null {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, n = 0;
  for (const k of ['LF', 'RF'] as const) {
    const e = rig.eff[k]; if (!e) continue;
    const f = human.bones.get(e.end); if (!f) continue;
    const p = f.getWorldPosition(V());
    if (p.y > SOLE_STAND) continue;                                             // ОПОРА — ЭТО ВЫСОТА, А НЕ ПИН: заколотая в воздухе стопа ничего не держит
    x0 = Math.min(x0, p.x - FOOT_HALF); x1 = Math.max(x1, p.x + FOOT_HALF);
    z0 = Math.min(z0, p.z - FOOT_HALF); z1 = Math.max(z1, p.z + FOOT_HALF * 1.6);   // носок длиннее пятки
    n++;
  }
  return n ? { x0, x1, z0, z1 } : null;
}
const SOLE_STAND = 4;      // выше этого над полом стопа считается поднятой
const FOOT_HALF = 3;       // полуширина стопы в плане
const balanceOff = V();    // ВЕСЬ сдвиг таза, сделанный помощью (НЕ авторский! см. `syncHandles`)
/** Как решатель переноса веса видит сцену (`balanceSolve.ts` — там же замеры и обе причины «улетает в бок»). */
const BAL_PROBE: BalanceProbe = {
  com: () => { const { p } = massCenter(); return { x: p.x, z: p.z }; },
  sup: () => supportRect(),
  move: (dx, dz) => { human.hips.position.x += dx; human.hips.position.z += dz; human.root.updateMatrixWorld(true); },
};
let balanceOn = getPref('balance', true), weightShift = 0.6;
/**
 * ПЕРЕНОС ВЕСА (Ф26.6б) — таз сдвигается так, чтобы проекция центра масс оставалась над опорой.
 * Это то, что в Cascadeur делает физический риг: тянешь руку далеко вбок — человек отставляет таз в другую.
 *
 * Сдвиг живёт в ОТДЕЛЬНОМ `balanceOff`, а НЕ в `rig.hipsPos`: от авторской позиции считается дельта драга
 * таза (урок Ф22.4), а `syncHandles` её перечитывает с живой кости — без вычета смещение впиталось бы в позу
 * каждый кадр и персонаж уползал (та же утечка, что была у доворота таза в Ф26.7).
 */
function applyBalance(): void {
  // ⭐⭐ РЕШАЕМ ОТ АВТОРСКОЙ ПОЗЫ, А НЕ ОТ ПРОШЛОГО ПРОМАХА. Прошлый сдвиг снимается ВНУТРИ
  // (`solveBalance`), поэтому звать надо и с ВЫКЛЮЧЕННОЙ помощью — иначе выключатель ничего не
  // выключит. Замеры («таз уезжает по 1.74 за каждую правку», «опора едет вместе с тазом») — в `balanceSolve.ts`.
  const off = solveBalance(BAL_PROBE, balanceOn ? weightShift : 0, { x: balanceOff.x, z: balanceOff.z });
  balanceOff.set(off.x, 0, off.z);
  if (!balanceOn || weightShift <= 0) return;
  const bx = human.hips.position.x, bz = human.hips.position.z;
  clampHipsToPins();                                                            // таз не уедет туда, откуда ноги не дотянутся (Ф22.2)
  // ⚠ КЛАМП — ТОЖЕ РАБОТА ПОМОЩИ, и он обязан попасть в запись: иначе на следующей правке его не снимут,
  // «желание = кость − запись» недовычтет, и он въестся в авторскую позу — ровно та же утечка.
  balanceOff.x += human.hips.position.x - bx; balanceOff.z += human.hips.position.z - bz;
}
const LIMB_PREFER_ARM = new THREE.Vector3(0, -1, -0.4);   // локоть назад-вниз (UE PBIK «preferred angle»)
const LIMB_PREFER_LEG = new THREE.Vector3(0, 0, 1);       // колено вперёд
/**
 * ТВИСТ КОРНЯ ПОД ПЛОСКОСТЬ СГИБА (Ф25.2). `aimBoneAt` целит минимальной дугой — твист плеча/бедра
 * получается ПРОИЗВОЛЬНЫЙ. А ось шарнира локтя/колена задана в фрейме корня, то есть твист корня
 * решает, в КАКОЙ плоскости сможет согнуться шарнир. Не совместишь её с плоскостью (корень, локоть, цель) —
 * клэмп шарнира выбросит внеосевую часть и кисть промахнётся. Знак оси — в сторону, куда шарнир вообще гнётся.
 */
/** Отладочные выключатели ступеней `solveLimb` (через `__pe.limbDbg`) — для замеров, в проде все false. */
const limbDbg = { noSwivel: false, noRootClamp: false, noMidClamp: false };
const LIMB_ITERS = 3;

/** Направить КОРЕНЬ так, чтобы его КОНЕЦ цепи (кисть/стопа) смотрел в `target`. Сгиб шарнира уже выставлен, то есть
 *  длина |корень→конец| фиксирована — один поворот ставит конец НА ЦЕЛЬ (или на луч к ней, если длины не хватает). */
function aimRootAtTarget(root: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3): void {
  if (!root.parent) return;
  root.updateMatrixWorld(true);
  const S = root.getWorldPosition(V());
  const cur = end.getWorldPosition(V()).sub(S), want = target.clone().sub(S);
  if (cur.lengthSq() < 1e-8 || want.lengthSq() < 1e-8) return;
  // ДЕЛЬТА-ПОВОРОТ, а НЕ `aimBoneAt`. `setFromUnitVectors` строит КВАТЕРНИОН ЦЕЛИКОМ минимальной дугой,
  // то есть СТИРАЕТ твист кости — а именно твистом задана плоскость сгиба. Замер: свивель честно уводил
  // колено на 13.1u при стоящей стопе (0.00u), а следующий аим возвращал колено РОВНО НА МЕСТО — оттого оранжевые
  // ручки и «ни на что не влияли». Дельта же поворачивает КАДР ЦЕЛИКОМ и сохраняет и свивель, и позу прошлого кадра
  // (как HumanIK/Unity, которые стартуют из текущей FK-позы).
  const w = root.getWorldQuaternion(Q()).premultiply(Q().setFromUnitVectors(cur.normalize(), want.normalize()));
  root.quaternion.copy(root.parent.getWorldQuaternion(Q()).invert().multiply(w));
  root.updateMatrixWorld(true);
}
/** СВИВЕЛЬ: повернуть корень ВОКРУГ линии корень→цель, чтобы локоть лёг на сторону полюса. Конец цепи
 *  лежит на этой же линии, значит ПО ПОСТРОЕНИЮ НЕ ДВИГАЕТСЯ (Ф23.1: замер — уход конца 0.00u за 120 кадров). */
function swivelRootToPole(root: THREE.Object3D, mid: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): void {
  if (!root.parent) return;
  root.updateMatrixWorld(true);
  const S = root.getWorldPosition(V());
  const a = target.clone().sub(S); if (a.lengthSq() < 1e-8) return; a.normalize();
  const cur = perpTo(mid.getWorldPosition(V()).sub(S), a), want = perpTo(pole, a);
  if (cur.length() < 0.3 || want.lengthSq() < 1e-8) return;   // почти прямая цепь — плоскость не определена
  cur.normalize(); want.normalize();
  let ang = Math.acos(clamp(cur.dot(want), -1, 1));
  if (V().crossVectors(cur, want).dot(a) < 0) ang = -ang;
  if (Math.abs(ang) < 1e-5) return;
  const w = root.getWorldQuaternion(Q()).premultiply(Q().setFromAxisAngle(a, ang));
  root.quaternion.copy(root.parent.getWorldQuaternion(Q()).invert().multiply(w));
  root.updateMatrixWorld(true);
}
/**
 * АНАЛИТИЧЕСКАЯ КОНЕЧНОСТЬ С ПРЕДЕЛАМИ (Ф25.2). Порядок — как в ozz-animation / Unity TwoBoneIK, и это
 * главное решение ФТ5:
 *   1) ШАРНИР СТАВИТСЯ УГЛОМ по закону косинусов ВОКРУГ СВОЕЙ ОСИ, а не «целься в точку и потом клэмп».
 *      Предыдущая версия целила предплечье минимальной дугой, а 1-DOF клэмп ВЫБРАСЫВАЕТ внеосевую часть —
 *      вместе с ней уходил СГИБ (замер «колено вверх»: 88° вместо 116°, недолёт 13.3u; без клэмпа — 116°/0.00u).
 *   2) КОРЕНЬ ЦЕЛИТ КОНЕЦ ЦЕПИ В ЦЕЛЬ (а не себя в локоть): длина |корень→конец| уже задана сгибом,
 *      поэтому один поворот ставит кисть РОВНО НА РУЧКУ. Именно это делает «рука улетела от хелпера» невозможным:
 *      предел плеча теперь забирает СТОРОНУ ЛОКТЯ, а не дотягивание.
 *   3) СВИВЕЛЬ к полюсу вокруг линии корень→цель — конец не двигается, меняется только плоскость сгиба.
 * Клэмп плеча/бедра после каждого шага может сбить конец — поэтому шаги 2–3 повторяются и хранится ЛУЧШИЙ
 * кадр (сходимость не гарантирована, когда полюс требует твиста за пределом).
 */
function solveLimb(e: Eff, target: THREE.Vector3, pole: THREE.Vector3): number {
  const root = human.bones.get(e.root), mid = human.bones.get(e.mid), end = human.bones.get(e.end);
  if (!root || !mid || !end || !root.parent) return Infinity;
  human.root.updateMatrixWorld(true);
  const L1 = mid.position.length(), L2 = end.position.length();
  const S = root.getWorldPosition(V());
  const r = solveTwoBone({ S, H: target, pole, L1, L2, soft: LIMB_SOFT, prefer: e.isFoot ? LIMB_PREFER_LEG : LIMB_PREFER_ARM });
  const vr = limitViewForBone(e.root), vm = limitViewForBone(e.mid);
  setHingeBend(mid, end, vm, r.bend);
  const clampRoot = (): void => {
    if (!vr || limbDbg.noRootClamp) return;
    root.quaternion.copy(clampLocalToLimit(root.quaternion, vr)); root.updateMatrixWorld(true);
  };
  let best = Infinity, bq = root.quaternion.clone(), bm = mid.quaternion.clone();
  // ЛУЧШИЙ КАДР СНИМАЕТСЯ ПОСЛЕ КАЖДОГО ШАГА, а не в конце итерации: полюс — ПОЖЕЛАНИЕ, цель — ТРЕБОВАНИЕ
  // (та же иерархия, что у pole vector в Maya). Замер без этого: «кисть к бедру» — прицеливание давало 0.00u,
  // но свивель требовал твист за пределом, клэмп уводил кисть — и записывался ИМЕННО испорченный кадр (9.3u).
  // НЕ ХУЖЕ — ЗНАЧИТ БЕРЁМ ПОЗДНИЙ. Свивель НЕ двигает конец (вращение вокруг линии корень→цель), то есть даёт
  // РОВНО ТОТ ЖЕ недолёт — и при строгом «лучше» его кадр отбрасывался всегда, когда цель достижима: оранжевая ручка
  // колена не двигала колено ВООБЩЕ (замер: 0.00u на тяге 6u) — та же жалоба, что в Ф23.
  const rec = (): number => {
    const m = end.getWorldPosition(V()).distanceTo(target);
    if (m < best + 1e-4) { best = Math.min(best, m); bq = root.quaternion.clone(); bm = mid.quaternion.clone(); }
    return m;
  };
  for (let it = 0; it < LIMB_ITERS; it++) {
    aimRootAtTarget(root, end, target); clampRoot(); rec();
    if (!limbDbg.noSwivel) {
      swivelRootToPole(root, mid, target, pole); clampRoot(); rec();
      aimRootAtTarget(root, end, target); clampRoot(); rec();
    }
    if (best < 1e-3) break;
  }
  root.quaternion.copy(bq); mid.quaternion.copy(bm); human.root.updateMatrixWorld(true);
  return best;
}
/**
 * СГИБ ШАРНИРА НА ЗАДАННЫЙ УГОЛ, вокруг собственной оси сустава и в пределах таблицы. Знак — туда, куда сустав
 * вообще гнётся (у правого локтя диапазон [−6°, +138°], у левого зеркальный). Авторская поза может быть не ровно
 * прямой (бинд чужого рига), поэтому после установки СМОТРИМ ФАКТИЧЕСКИЙ сгиб и добираем разницу одним шагом
 * (абсолютный угол брать нельзя — тот же урок, что с бинд-избытком фаланг в Ф15).
 */
function setHingeBend(mid: THREE.Object3D, end: THREE.Object3D, vm: LimitView | null, bend: number): void {
  const aimMid = end.position.clone().normalize();
  if (!vm || vm.kind !== 'hinge' || !vm.axis || limbDbg.noMidClamp) {
    if (mid.parent) { const d = aimMid.clone().applyQuaternion(Q().setFromAxisAngle(new THREE.Vector3(1, 0, 0), bend)); mid.quaternion.setFromUnitVectors(aimMid, d); mid.updateMatrixWorld(true); }
    return;
  }
  const ax = new THREE.Vector3(vm.axis[0], vm.axis[1], vm.axis[2]).normalize();
  const sign = Math.abs(vm.max ?? 0) >= Math.abs(vm.min ?? 0) ? 1 : -1;
  const put = (ang: number): number => {
    mid.quaternion.copy(clampLocalToLimit(Q().setFromAxisAngle(ax, clamp(ang, vm.min ?? 0, vm.max ?? 0)), vm));
    mid.updateMatrixWorld(true);
    const d = aimMid.clone().applyQuaternion(mid.quaternion);
    return Math.acos(clamp(d.dot(aimMid), -1, 1));                     // фактический сгиб относительно авторской позы
  };
  const want = sign * bend;
  const got = put(want);
  if (Math.abs(got - bend) > 1e-3) put(want + sign * (bend - got));    // один шаг Ньютона под бинд-смещение
}
/**
 * ПЛЕЧЕВОЙ ПОЯС (Ф25.3): довернуть ключицу так, чтобы плечевой сустав подошёл к `wantS` — в пределах
 * ключицы (Ф21.4: ±20° выведение, ±15° подъём, ±10° твист). Зовётся ТОЛЬКО когда рука сама не достаёт
 * или когда локоть-эффектор просит сдвинуть плечо — иначе ключица «плавала» бы при каждом драге кисти.
 * Порядок «ключица → корпус» — анатомия и HumanIK (Reach у плечевого пояса). Ногам не нужно: их «пояс» — таз.
 */
function shoulderGirdle(e: Eff, wantS: THREE.Vector3): void {
  if (e.isFoot) return;
  const root = human.bones.get(e.root); const clav = root?.parent;
  if (!root || !clav || !human.bones.get(clav.name) || !clav.parent) return;
  if (!girdleBase) girdleBase = new Map();
  if (!girdleBase.has(clav.name)) girdleBase.set(clav.name, clav.quaternion.clone());
  aimBoneAt(clav, root.position.clone().normalize(), wantS);
  const v = limitViewForBone(clav.name);
  if (v) clav.quaternion.copy(clampLocalToLimit(clav.quaternion, v));
  human.root.updateMatrixWorld(true);
}
/**
 * КОНЕЧНОСТЬ + ПОМОЩЬ ТЕЛА (Ф25.3). Сначала сама конечность; не дотянулась — ключица, потом корпус (Pull).
 *
 * КАЖДАЯ СТУПЕНЬ ДЕРЖИТСЯ ТОЛЬКО ЕСЛИ СТАЛО ЛУЧШЕ — тот же урок, что с тазом в Ф22.4. Недолёт бывает двух родов:
 * «далеко» (длины не хватило — ключица реально помогает) и «предел сустава» (там любое движение пояса может СДЕЛАТЬ
 * ХУЖЕ). Замер без гварда на дуге кисти за спину: прыжок локтя 4.25u за кадр и недолёт 8.8u против 1.6u/6.4u
 * у голой конечности — именно это чувствуется как «рука улетела от хелпера».
 */
function solveLimbAssisted(e: Eff, torso: boolean): number {
  // ПОРЯДОК: ТЕЛО ПОДХВАТЫВАЕТ ДО РЕШЕНИЯ РУКИ (Ф26.6). Эта часть зависит только от ЦЕЛИ, а не от
  // результата солва — значит детерминирована и метаться не может. Когда тяга шла ПОСЛЕ солва и сравнивалась
  // сама с собой по «стало ли лучше», у полного вытяжения возникал цикл «согнулся → плечо уехало →
  // откат» через кадр (замер на дуге: скачки до 29.7° между соседними кадрами).
  let miss = solveLimb(e, e.target, naturalPole(e, e.target));
  if (miss <= PULL_SLACK) return miss;
  const root = human.bones.get(e.root), clav = root?.parent;
  if (!e.isFoot && root && clav) {
    const q0 = clav.quaternion.clone();
    const got = human.bones.get(e.end)!.getWorldPosition(V());
    shoulderGirdle(e, root.getWorldPosition(V()).add(e.target.clone().sub(got)));   // ключица на величину недолёта
    const m2 = solveLimb(e, e.target, naturalPole(e, e.target));
    if (m2 < miss - 1e-3) miss = m2;
    else { clav.quaternion.copy(q0); human.root.updateMatrixWorld(true); miss = solveLimb(e, e.target, naturalPole(e, e.target)); }
  }
  // Цель ВНЕ досягаемости — корпус добавляет СВЕРХ эстетики (поведение Pull из Ф21.4). Здесь откат уместен:
  // добавка существует ИМЕННО ради дотягивания — не помогла, возвращаемся к чисто эстетической позе.
  if (torso && miss > PULL_SLACK && bodyFollow > 0) {
    const base = miss;
    const key = Object.keys(rig.eff).find((k) => rig.eff[k] === e);
    pullRelax(); applyBodyFollow(key, clamp(miss / PULL_MISS_FULL, 0, 1));
    const m2 = solveLimb(e, e.target, naturalPole(e, e.target));
    if (m2 < base - 1e-3) miss = m2;
    else { pullRelax(); applyBodyFollow(); miss = solveLimb(e, e.target, naturalPole(e, e.target)); }
  }
  return miss;
}
/**
 * ЛОКОТЬ/КОЛЕНО КАК ЭФФЕКТОР (Ф25.4) — HumanIK auxiliary effector: «translating the Elbow and Knee
 * effectors will replicate a Pole-vector constraint», кисть при этом ПРИБИТА. Сценарий юзера: рука
 * поднята, ключица выгнута вверх — тянешь локоть вниз, не меняя кулак, и ключица опускается.
 * Цепочка: желаемый локоть → где должно быть плечо (`elbowGoal`) → ключица → корпус (Pull, если ещё
 * не хватило и `bodyFollow > 0`) → аналитика с полюсом из той же задачи. Прямая рука тоже сгибается
 * от локтя — у полюса-свивеля этого не было. У ног «пояс» = таз, поэтому колено задаёт только плоскость.
 */
function solveElbowEffector(e: Eff): void {
  const root = human.bones.get(e.root), mid = human.bones.get(e.mid), end = human.bones.get(e.end);
  if (!root || !mid || !end) return;
  human.root.updateMatrixWorld(true);
  const L1 = mid.position.length(), L2 = end.position.length();
  const H = e.target.clone(), Ewant = e.poleHandle.position.clone();
  let g = elbowGoal(root.getWorldPosition(V()), H, Ewant, L1, L2);
  // КИСТЬ ВАЖНЕЕ ЛОКТЯ втрое: тянешь локоть — кулак стоит (HumanIK: aux-эффектор не имеет права срывать прибитый
  // конец). Без веса ключица «выкупала» сближение локтя ценой ухода кисти на 1.16u.
  const score = (): number => { human.root.updateMatrixWorld(true); return mid.getWorldPosition(V()).distanceTo(g.E) + 3 * end.getWorldPosition(V()).distanceTo(H); };
  solveLimb(e, H, g.pole);
  let best = score();
  if (g.shift.length() > PULL_SLACK && !e.isFoot) {
    const clav = root.parent;
    const q0 = clav ? clav.quaternion.clone() : null;
    shoulderGirdle(e, g.Swant);                                                  // 1) ключица тянет плечо туда, где оно обязано быть
    g = elbowGoal(root.getWorldPosition(V()), H, Ewant, L1, L2);
    solveLimb(e, H, g.pole);
    if (score() < best - 1e-3) best = score();
    else if (q0 && clav) { clav.quaternion.copy(q0); human.root.updateMatrixWorld(true); g = elbowGoal(root.getWorldPosition(V()), H, Ewant, L1, L2); solveLimb(e, H, g.pole); }
    if (g.shift.length() > PULL_SLACK && bodyFollow > 0 && pullTwistToward(e.root, g.Swant)) {   // 2) корпус
      g = elbowGoal(root.getWorldPosition(V()), H, Ewant, L1, L2);
      solveLimb(e, H, g.pole);
      if (score() >= best - 1e-3) { pullRelax(); g = elbowGoal(root.getWorldPosition(V()), H, Ewant, L1, L2); solveLimb(e, H, g.pole); }
    }
  }
  poleFromPose(e); swivelFromPose(e);                          // человек выбрал плоскость руками — запоминаем ЕЁ УГЛОМ от натурали
}
/**
 * АНАТОМИЧЕСКИЙ ПОЛЮС (Ф26.7) — куда САМ смотрит локоть/колено при данном направлении руки.
 *
 * Жалоба: «тянешь руку вверх — локоть уходит за спину, вниз его не сделать». Причина — полюс хранился
 * МИРОВЫМ ВЕКТОРОМ (дефолт «вниз-назад»). Пока рука опущена — это верно, но когда кисть уходит вверх,
 * тот же вектор уводит локоть НАЗАД ЗА КОРПУС, и вернуть его ручкой нельзя: следующий же драг кисти
 * снова берёт старый вектор.
 *
 * Теперь полюс = НАТУРАЛЬНОЕ направление + УГОЛ СВИВЕЛЯ (`e.swivel`), как в ригах с pole-контроллером
 * на теле: натураль едет вместе с рукой, а ручная правка сохраняется ОТНОСИТЕЛЬНО неё, а не в мире.
 * Предпочтительное направление (в фрейме таза): рука — НАРУЖУ-вниз-чуть вперёд (локоть не лезет через туловище
 * и не уходит за спину), нога — ВПЕРЁД (колено гнётся вперёд всегда).
 */
// КУДА СМОТРИТ ЛОКОТЬ — ЗАВИСИТ ОТ ВЫСОТЫ РУКИ, и это анатомия, а не вкус. Рука ниже плеча — локоть
// вниз-наружу. Рука НАД плечом (замах, трофейная поза) — локоть ВПЕРЁД-наружу: за спину его не увести,
// плечевой сустав так не работает. Без этого переключения любое «вниз»-предпочтение при поднятой руке даёт ровно
// противоположную сторону круга свивеля — локоть за спиной (замер на замахе: 14.6u позади плеча).
const POLE_PREF_LOW = new THREE.Vector3(0.6, -1, 0.35);      // рука ниже плеча: наружу (× side), вниз, чуть вперёд
const POLE_PREF_HIGH = new THREE.Vector3(0.5, 0.15, 1);      // рука выше плеча: вперёд-наружу
const POLE_PREF_LEG = new THREE.Vector3(0, 0, 1);            // колено строго вперёд
function naturalPole(e: Eff, target: THREE.Vector3): THREE.Vector3 {
  const root = human.bones.get(e.root); if (!root) return e.pole.clone();
  human.root.updateMatrixWorld(true);
  const hq = human.hips.getWorldQuaternion(Q());
  const S = root.getWorldPosition(V());
  const u = target.clone().sub(S).applyQuaternion(hq.clone().invert());          // направление тяги во фрейме таза
  if (u.lengthSq() < 1e-8) return e.pole.clone();
  u.normalize();
  const side = e.root.startsWith('Left') ? 1 : -1;
  let pref: THREE.Vector3;
  if (e.isFoot) pref = POLE_PREF_LEG.clone();
  else {
    const t = clamp((u.y + 0.2) / 0.8, 0, 1);                                    // 0 = рука ниже плеча, 1 = высоко над ним
    pref = new THREE.Vector3(
      (POLE_PREF_LOW.x + (POLE_PREF_HIGH.x - POLE_PREF_LOW.x) * t) * side,
      POLE_PREF_LOW.y + (POLE_PREF_HIGH.y - POLE_PREF_LOW.y) * t,
      POLE_PREF_LOW.z + (POLE_PREF_HIGH.z - POLE_PREF_LOW.z) * t);
  }
  let p = perpTo(pref.normalize(), u);
  if (p.lengthSq() < 1e-6) p = perpTo(new THREE.Vector3(side, 0, 0), u);         // тянем точно вдоль предпочтения
  if (p.lengthSq() < 1e-6) return e.pole.clone();
  p.normalize();
  if (e.swivel) p.applyQuaternion(Q().setFromAxisAngle(u, e.swivel));            // ручная правка — УГЛОМ вокруг линии тяги
  return p.applyQuaternion(hq);                                                  // обратно в мир
}
/** Запомнить СВИВЕЛЬ (угол от натурали), а не мировой вектор — тогда правка переживает перемещение руки. */
function swivelFromPose(e: Eff): void {
  const root = human.bones.get(e.root), mid = human.bones.get(e.mid), end = human.bones.get(e.end);
  if (!root || !mid || !end) return;
  human.root.updateMatrixWorld(true);
  const S = root.getWorldPosition(V()), Ep = mid.getWorldPosition(V()), Hp = end.getWorldPosition(V());
  const axis = Hp.clone().sub(S); if (axis.lengthSq() < 1e-6) return; axis.normalize();
  const cur = perpTo(Ep.sub(S), axis); if (cur.length() < 0.5) return;            // почти прямая — плоскость ненадёжна
  const sw0 = e.swivel; e.swivel = 0;
  const nat = perpTo(naturalPole(e, Hp), axis);
  e.swivel = sw0;
  if (nat.lengthSq() < 1e-6) return;
  cur.normalize(); nat.normalize();
  let a = Math.acos(clamp(nat.dot(cur), -1, 1));
  if (V().crossVectors(nat, cur).dot(axis) < 0) a = -a;
  e.swivel = a;
}
/**
 * ПОЛЮС ИЗ ФАКТИЧЕСКОГО ЛОКТЯ — непрерывность плоскости сгиба между кадрами драга (Unity TwoBoneIK без hint берёт
 * плоскость из текущего локтя, HumanIK стартует из текущей FK-позы). ФИКСИРОВАННОЕ направление полюса вырождается,
 * как только цепь ложится вдоль него: замер «кисть к голове» с полюсом «локоть вниз» — остаток ⫫ цепи смотрел ВНУТРЬ,
 * локоть уходил через грудь (плечо +162°). Прямая цепь плоскость не задаёт — оставляем прежний полюс.
 */
function poleFromPose(e: Eff): void {
  const root = human.bones.get(e.root), mid = human.bones.get(e.mid), end = human.bones.get(e.end);
  if (!root || !mid || !end) return;
  human.root.updateMatrixWorld(true);
  const S = root.getWorldPosition(V()), Ep = mid.getWorldPosition(V()), Hp = end.getWorldPosition(V());
  const dir = Hp.sub(S);
  if (dir.lengthSq() < 1e-6) return;
  const p = perpTo(Ep.sub(S), dir.normalize());
  // СВИВЕЛЬ ЗДЕСЬ НЕ ЗАПИСЫВАЕМ (Ф26.7): это фактическая плоскость, а она часто ЗАЖАТА пределом плеча.
  // Запишешь её как «ручную правку» — и анатомическое предпочтение будет перебито НАВСЕГДА (замер: натураль выдавала
  // «вперёд-вверх», но после первого же солва свивель становился ≈180° и полюс навсегда смотрел назад). Свивель пишет
  // только ОРАНЖЕВАЯ РУЧКА (`solveElbowEffector`) — то есть когда человек действительно выбрал плоскость руками.
  if (p.length() > 0.5) e.pole.copy(p.normalize());          // < 0.5u от линии — почти прямая, плоскость ненадёжна
}
/**
 * НОВЫЙ ПУТЬ (Ф25): каждая конечность — своя аналитическая цепь. Маска/жёсткие кости не нужны:
 * солвер трогает ровно две кости (+ ключицу по Ф25.3), изоляция Ф21.3 получается сама собой.
 *
 *  А) тянешь оранжевую ручку — локоть/колено как эффектор (Ф25.4);
 *  Б) тянешь кисть/стопу — конечность, при недолёте: ключица → корпус (Pull) → дорешать;
 *  В) запиненные конечности держат свои точки ПРИ ЛЮБОЙ манипуляции (таз, FK-кость, скрутка корпуса) —
 *     при FK-вращении кости самой конечности её авторский угол не трогаем (догоняет только шарнир).
 */
function solveRigAnalytic(): void {
  applyBodyFollow();                                                            // Ф26.7: корпус держит тягу ОТ ВСЕХ рук — что бы ты ни трогал
  if (activePole) { const e = rig.eff[activePole]; if (e && e.ik) solveElbowEffector(e); }
  const ae = activeKey && activeKey !== 'hips' ? rig.eff[activeKey] ?? null : null;
  if (ae && ae.ik) { solveLimbAssisted(ae, true); poleFromPose(ae); }
  for (const k in rig.eff) {
    const e = rig.eff[k]!;
    if (!e.ik || !e.pin || k === activeKey || k === activePole) continue;
    if (fkProxyBone === e.end) continue;
    if (fkProxyBone === e.root || fkProxyBone === e.mid) {                       // крутят саму конечность — догоняет только шарнир
      const mid = human.bones.get(e.mid), end = human.bones.get(e.end); if (!mid || !end) continue;
      aimBoneAt(mid, end.position.clone().normalize(), e.target);
      const vm = limitViewForBone(e.mid); if (vm) { mid.quaternion.copy(clampLocalToLimit(mid.quaternion, vm)); mid.updateMatrixWorld(true); }
      continue;
    }
    solveLimbAssisted(e, false);                                                // корпус добирает только под перетаскиваемую (тяга от всех уже применена выше)
  }
  if (activeKey !== 'hips') applyBalance();                                      // Ф26.6б: центр масс над опорой (при драге таза командует человек)
  if (holdPins() > PULL_SLACK && pinPower >= 1 && pullBase) {                    // пин не удержался — виновата тяга корпуса, снимаем её
    pullRelax();
    if (ae && ae.ik) solveLimb(ae, ae.target, naturalPole(ae, ae.target));
    holdPins();
  }
  if (activeKey === 'hips') hipsFollowPins();                                   // Ф22.4: таз не уйдёт туда, откуда ноги не дотянутся
}
/**
 * ЖЁСТКИЕ ПИНЫ (Ф26.7). Жалоба: «делаю что-то с головой — запиненная рука улетает; нужно, чтобы
 * пины были зафиксированы при любом раскладе». Последний проход солва: каждая запиненная конечность
 * дорешается в СВОЮ точку — уже после того, как корпус/ключица/таз встали окончательно.
 *
 * `pinPower` (ползунок «сила привязки»): 1 = точка держится насмерть, а если дотянуться нечем —
 * ОТКАТЫВАЕМ тягу корпуса (именно она чаще всего срывает пин); 0 = пин лишь «советует» и едет за телом.
 */
function holdPins(): number {
  let worst = 0;
  for (const k in rig.eff) {
    const e = rig.eff[k]!;
    if (!e.ik || !e.pin || k === activeKey || fkProxyBone === e.end) continue;
    const m = solveLimb(e, e.target, naturalPole(e, e.target));
    worst = Math.max(worst, m);
    if (pinPower < 1) {                                                          // мягкий пин: точка частично едет за телом
      const got = human.bones.get(e.end)!.getWorldPosition(V());
      e.target.lerp(got, (1 - pinPower) * 0.5); e.prev.copy(e.target);
    }
  }
  return worst;
}
/**
 * КОРНИ ЦЕПЕЙ (аналог Chain Length в Blender). Рука решается до КЛЮЧИЦЫ, нога — до ТАЗА.
 * До Ф21 цепи не было вовсе: решался весь скелет, и тяга правой кисти на 3u увозила ЛЕВУЮ на 13.3u.
 */
const CHAIN_ROOT: Record<string, string> = { LH: 'LeftShoulder', RH: 'RightShoulder', LF: 'Hips', RF: 'Hips' };
/** Цепь имён от конца до корня включительно (по РЕАЛЬНОЙ иерархии скелета, не по таблице). */
function boneChain(end: string, root: string): string[] {
  const out: string[] = [];
  for (let b = human.bones.get(end); b; b = b.parent && human.bones.get(b.parent.name) ? b.parent as THREE.Group : undefined) {
    out.push(b.name);
    if (b.name === root) break;
  }
  return out;
}
/**
 * МАСКА РЕШЕНИЯ + PULL (Ф21.3). Собирается каждый кадр драга.
 *
 * В маску входят: цепь перетаскиваемого эффектора и цепи всех ЗАПИНЕННЫХ (их надо удержать —
 * значит, решать). НИКОГДА не входят фаланги: ими владеет канал хвата (Ф16–Ф19), и солвер
 * с ним дрался бы каждый кадр.
 *
 * PULL — модель Maya HumanIK: тело подключается НЕ всегда, а когда цель ВНЕ ДОСЯГАЕМОСТИ
 * («the pull effect is only visible if the effector is so far that straightening the arm doesn’t reach»).
 * Дотягиваешься рукой рядом — корпус стоит; тянешься дальше руки — в маску входит спина.
 */
const PULL_SLACK = 0.5;                                      // меньше полуюнита недолёта — корпус не дёргаем
const PULL_TWIST = 45 * Math.PI / 180;                       // анатомический предел осевой скрутки туловища (поясничный ~10° + грудной ~35°)
/** Веса скрутки по [Spine, Chest, UpperChest, Neck, Head]. Голова/шея — НОЛЬ: тянешься рукой, а не отворачиваешься. */
const PULL_W: [number, number, number, number, number] = [0.2, 0.4, 0.4, 0, 0];
// ТЕЛО ЗА РУКОЙ (Ф26.6). Анатомические пределы грудо-поясничного отдела: разгиб (прогиб назад) меньше
// сгиба вперёд — поэтому два разных числа, а не симметричный клэмп.
const PULL_START = 0.7;                                      // натяжение начинается с 70% вытяжения руки (решение юзера)
const PULL_MISS_FULL = 6;                                    // недолёт в эти юниты = полная сила (цель вне досягаемости)
const BEND_EXT = 35 * Math.PI / 180;                         // прогиб назад
const BEND_FLEX = 40 * Math.PI / 180;                        // наклон вперёд
const BEND_ROLL = 35 * Math.PI / 180;                        // боковой наклон
let gTwist = 0.7, gPitch = 0.6, gRoll = 0.5;              // доли угла тяги, которые берёт корпус (Про-ползунки)
let pelvisFollow = 0.15;                                     // доля скрутки, уходящая в таз (в реальном замахе таз всегда участвует)
/** Насколько конец НЕ дошёл до своей цели ПОСЛЕ солва (мир). Критерий Pull — ФАКТ, а не расчёт длины цепи. */
function missOf(p: { end: string; goal: THREE.Vector3 }): number {
  human.root.updateMatrixWorld(true);
  return human.bones.get(p.end)!.getWorldPosition(V()).distanceTo(p.goal);
}
/** Результат сборки: какие кости решаем, куда ведём и что проверить на недолёт (Pull). */
interface SolvePlan {
  mask: Set<string>; targets: Map<string, THREE.Vector3>;
  /** ОПОРА внутри маски (Ф22.1): участвует в цепи, но свой угол НЕ меняет. */
  rigid: Set<string>;
  anchorBone: string; anchorPos: THREE.Vector3 | null;
  pull: { end: string; goal: THREE.Vector3 } | null; poles: Map<string, THREE.Vector3>;
}
/** Предки кости включительно её самой (до корня скелета). */
function boneAndAncestors(nm: string): string[] { return boneChain(nm, 'Root'); }
/**
 * СКОЛЬКО ЦЕПЬ ВООБЩЕ ДОСТАЁТ от своего корня (сумма длин звеньев).
 * `boneChain` идёт от конца к корню, а `bone.position.length()` — расстояние ДО РОДИТЕЛЯ,
 * поэтому корень в сумму не входит.
 */
function chainReach(chain: string[]): number {
  let sum = 0;
  for (let i = 0; i < chain.length - 1; i++) { const b = human.bones.get(chain[i]!); if (b) sum += b.position.length(); }
  return sum;
}
/**
 * ТАЗ НЕ УЕЗЖАЕТ ЗА ПРЕДЕЛ ДОСЯГАЕМОСТИ ЗАПИНЕННЫХ (Ф22.2).
 *
 * Замерено до: тянешь ручку таза вверх на 120u при запиненных стопах — стопа едет за ним 1:1
 * (длина ноги 41.2u). Солвер при этом НЕ виноват: он честно вытягивает ногу в струну, больше ему
 * делать нечего. Ограничивать надо САМО ДВИЖЕНИЕ ТАЗА — так же делает foot-IK в играх
 * («pelvis adjustment prevents the character from splitting»).
 *
 * Геометрия: корень цепи жёстко связан с тазом, значит сдвиг таза на Δ сдвигает и его на Δ.
 * Значит корень обязан остаться в ШАРЕ радиуса `reach` вокруг цели — проецируем на него.
 * Несколько пинов — пересечение шаров, берётся итерациями (как в FABRIK): 4 прохода сходятся.
 */
const HIP_SLACK = 0.995;                                     // пара промилле запаса: строго прямая конечность — сингулярность для IK
const PIN_SLACK = 1.5;                                       // допуск на ТРАНЗИЕНТ солвера. 0.25 было СЛИШКОМ СТРОГО:
// мелкий рабочий промах читался как срыв фиксатора, откат шёл каждый кадр и таз не двигался вовсе
// (замер: y = 36.7 на пяти разных тягах подряд). Настоящий срыв — это десятки юнитов, его этот порог ловит.                                      // меньше четверти юнита недолёта — таз не дёргаем
/**
 * ПРЕД-КЛАМП по шару досягаемости — грубый, но дешёвый первый шаг.
 *
 * Меняет ТОЛЬКО `human.hips.position`, а НЕ `rig.hipsPos`. Это важно: `rig.hipsPos` — ЭТО ЖЕЛАНИЕ
 * ПОЛЬЗОВАТЕЛЯ (туда он тянет ручку), а позиция кости — РЕЗУЛЬТАТ, как у любого эффектора.
 * Первая версия писала в `rig.hipsPos`, и кламп дрался с драгом: `moveHips` считает дельту
 * ОТ `rig.hipsPos`, а кламп его же сдвигал — ручка уезжала от таза. `syncHandles` вне драга
 * схлопывает желание к факту, так что после отпускания мыши ручка сама возвращается на таз.
 */
function clampHipsToPins(): void {
  const lim: { root: string; goal: THREE.Vector3; reach: number }[] = [];
  for (const k in rig.eff) {
    const e = rig.eff[k]!;
    if (!e.ik || !e.pin) continue;
    const chain = boneChain(e.end, CHAIN_ROOT[k] ?? 'Hips');
    lim.push({ root: chain[chain.length - 1]!, goal: e.target, reach: chainReach(chain) * HIP_SLACK });
  }
  if (!lim.length) return;
  for (let it = 0; it < 4; it++) {
    let moved = 0;
    for (const L of lim) {
      human.root.updateMatrixWorld(true);
      const r = human.bones.get(L.root)?.getWorldPosition(V()); if (!r) continue;
      const d = r.distanceTo(L.goal);
      if (d <= L.reach) continue;
      human.hips.position.addScaledVector(r.sub(L.goal).multiplyScalar(1 / d), L.reach - d);
      moved = Math.max(moved, d - L.reach);
    }
    if (moved < 1e-3) break;
  }
  human.root.updateMatrixWorld(true);
}
/**
 * ТАЗ ОСТАНАВЛИВАЕТСЯ ТАМ, ГДЕ ФИКСАТОРЫ ЕЩЁ ДЕРЖАЛИСЬ (Ф22.4). Зовётся ПОСЛЕ солва.
 *
 * Почему шара досягаемости НЕ ХВАТАЕТ: он ловит только «слишком далеко». А на приседе цель
 * недостижима по СЛИШКОМ БЛИЗКО и по УГЛУ в суставах — шар этого не видит, и таз спокойно
 * уходил ПОД ПОЛ, утаскивая стопы (замер без этой функции: стопа на y = −34.6, отрыв 37.6u).
 *
 * ПОЧЕМУ ИМЕННО ОТКАТ, А НЕ ПОИСК МИНИМУМА. Первая версия двигала таз на вектор недолёта и
 * пересолвливала. Беда в том, что цель стопы достижима ДВУМЯ разными позами — ПРИСЕДОМ и СТОЙКОЙ,
 * — и поиск минимума уводил в стойку: тянешь таз ВНИЗ, а персонаж ВЫПРЯМЛЯЕТСЯ (замер: колено
 * 126° → 0.4°, таз 19.5 → 25.5). Демпфер шага проблему не решил, а размазал: перещёлк ушёл
 * дальше по глубине, зато отрыв пинов вырос до 5–8u.
 *
 * Правильная семантика фиксатора — НЕ «найди лучшее положение», а «ДАЛЬШЕ НЕ ПУЩУ». Поэтому
 * во время драга помним ПОСЛЕДНЕЕ ХОРОШЕЕ положение таза и откатываемся к нему, как только
 * пин срывается. Таз упирается в предел и стоит, ветка решения не перещёлкивается, отрыв ≈ 0.
 */
let hipsGood: THREE.Vector3 | null = null;
let pinBase = 0;
const goodPose = new Map<string, THREE.Quaternion>();        // поза решаемых костей в тот же момент                                             // отрыв пинов НА НАЧАЛО драга: двигать таз можно, пока не становится ХУЖЕ                   // последняя позиция таза, при которой фиксаторы держались
/** Запомнить текущий кадр как ХОРОШИЙ: позицию таза И позу всех костей цепей пинов. */
function markHipsGood(bones?: Iterable<string>): void {
  hipsGood = human.hips.position.clone();
  goodPose.clear();
  const list = bones ?? (function* (): Generator<string> {
    for (const k in rig.eff) { const e = rig.eff[k]!; if (e.ik && e.pin) yield* boneChain(e.end, 'Hips'); }
  })();
  for (const n of list) { const b = human.bones.get(n); if (b) goodPose.set(n, b.quaternion.clone()); }
}
/** Максимальный отрыв запиненного конца от своей цели (мир). */
function pinMiss(): number {
  human.root.updateMatrixWorld(true);
  let worst = 0;
  for (const k in rig.eff) {
    const e = rig.eff[k]!;
    if (!e.ik || !e.pin) continue;
    worst = Math.max(worst, human.bones.get(e.end)!.getWorldPosition(V()).distanceTo(e.target));
  }
  return worst;
}
function hipsFollowPins(): void {
  if (!effList().some((e) => e.ik && e.pin)) { hipsGood = null; return; }
  // КРИТЕРИЙ — «НЕ УХУДШАТЬ», а не «быть идеальным». С абсолютным порогом таз ЗАСТРЕВАЛ:
  // солвер не идеален, отрыв 1.3u оставался с прошлого драга, порог 0.25 не достигался никогда
  // — и каждый кадр шёл откат, таз навечно прибивало к одной точке (замер: y = 24.7 на ЛЮБОЙ тяге).
  const m = pinMiss();
  if (m <= pinBase + PIN_SLACK) {
    // Снимок ЦЕЛИКОМ, а не одна позиция таза: откат только таза оставлял ноги в испорченной
    // конфигурации — замер: при ТОМ ЖЕ тазе y = 22.7 отрыв был то 1.32, то 10.3 (колено 113° → 119°).
    pinBase = Math.min(pinBase, m); markHipsGood();
    return;
  }
  if (!hipsGood) return;                                     // срыв был ещё до драга — откатываться некуда
  human.hips.position.copy(hipsGood);
  for (const [n, q] of goodPose) human.bones.get(n)?.quaternion.copy(q);
  human.root.updateMatrixWorld(true);
}

/**
 * МАСКА РЕШЕНИЯ + PULL (Ф21.3). Собирается каждый кадр драга.
 *
 * ПРАВИЛО, выведенное ЗАМЕРОМ, а не рассуждением:
 *
 * 1. Цепь перетаскиваемого — всегда. Рука решается до КЛЮЧИЦЫ, нога — до ТАЗА (Chain Length).
 * 2. Цепи ЗАПИНЕННЫХ — ТОЛЬКО если в маске есть ТАЗ, то есть его тянут. Это оказалось
 *    главным: пока ноги входили в маску всегда (стопы запинены по умолчанию), вместе с ними
 *    в маску попадал `Hips` — таз становился СВОБОДНЫМ, и тяга кисти уносила всю фигуру.
 *    При неподвижном тазе запиненная стопа и так не может уехать — решать ногу незачем.
 * 3. Фаланги — НИКОГДА: ими владеет канал хвата (Ф16–Ф19), солвер дрался бы с ним каждый кадр.
 * 4. Конечность с `ik = false` не входит вовсе — тумблер «рука Л: FK» наконец работает.
 *
 * PULL решается НЕ ЗДЕСЬ, а в `solveRig` — по ФАКТИЧЕСКОМУ недолёту после первого солва
 * (там же и причина, почему расчёт по длине цепи оказался негодным). Здесь только готовим `pull`.
 * ТАЗ в PULL НЕ ВХОДИТ: спина гнётся ОТ НЕПОДВИЖНОГО таза, иначе уезжает весь персонаж.
 */
function solvePlan(): SolvePlan {
  const mask = new Set<string>();
  const targets = new Map<string, THREE.Vector3>();
  const add = (c: string[]): void => { for (const n of c) mask.add(n); };
  const rigid = new Set<string>();
  const ae = activeKey && activeKey !== 'hips' ? rig.eff[activeKey] ?? null : null;
  let anchorBone = (activeKey && activeKey !== 'hips') ? rig.eff[activeKey]!.end : 'Hips';
  let anchorPos: THREE.Vector3 | null = null;
  let pull: { end: string; goal: THREE.Vector3 } | null = null;

  // КРУТИМ КОСТЬ В FK, А КОНЕЧНОСТИ ЗАПИНЕНЫ (Ф22.1) — держим их на месте.
  //
  // До Ф22 этого не было вовсе: солвер звался только на драге РУЧКИ. Замер: при всех четырёх
  // запиненных точках поворот `Hips` на 40° увозил ОБЕ кисти на 26.1u, `Spine` — тоже на 26.1u.
  // В Cascadeur фиксатор (R) прибивает точку и при любой манипуляции — оба режима там работают
  // одновременно («both these modes are supported simultaneously»).
  //
  // КЛЮЧ: кость, которую крутят, и ВСЕ ЕЁ ПРЕДКИ — ЖЁСТКИЕ (`rigid`). В маске они остаются
  // (иначе цепь до руки рвётся и forward-проход до неё не дойдёт), но СВОЙ угол не меняют — иначе
  // корпус КОМПЕНСИРОВАЛ бы твоё же вращение и крутить кость стало бы бессмысленно.
  if (!ae && activeKey !== 'hips' && fkProxyBone && human.bones.get(fkProxyBone)) {
    const frozen = new Set(boneAndAncestors(fkProxyBone));
    for (const k in rig.eff) {
      const e = rig.eff[k]!;
      if (!e.ik || !e.pin) continue;
      add(boneChain(e.end, 'Hips'));                                    // покрытие: цепь связна до таза
      targets.set(e.end, e.target.clone());
    }
    for (const n of mask) {
      // решаемые = только собственные цепи конечностей (кисть→ключица, стопа→таз) вне «заморозки»
      let solvable = false;
      for (const k in rig.eff) {
        const e = rig.eff[k]!;
        if (!e.ik || !e.pin) continue;
        if (boneChain(e.end, CHAIN_ROOT[k] ?? 'Hips').includes(n) && !frozen.has(n)) { solvable = true; break; }
      }
      if (!solvable) rigid.add(n);
    }
    anchorBone = 'Hips'; anchorPos = human.hips.getWorldPosition(V());
    for (const n of [...mask]) if (isHandBone(n)) mask.delete(n);
    const poles0 = new Map<string, THREE.Vector3>();
    // В СОЛВЕР ПОЛЮС ИДЁТ ТОЛЬКО ДЛЯ НОГ (Ф23.1).
  //
  // Колено смотрит вперёд — это АНАТОМИЯ, а не «ручная докрутка». Без полюса сторона сгиба
  // берётся из ЗНАКА ПРЕДЕЛА через ось шарнира В МИРЕ, а она зависит от ориентации бедра —
  // получается самоподдерживающийся ФЛИП. Замер на приседе: сгиб колена 70.4° → ВНЕЗАПНО 2.3°,
  // таз проваливался на 20u, нога уходила вбок — «шпагат» со скрина юзера. У рук включённый
  // всегда полюс, наоборот, ронял недолёт с 0 до 15–17u (Ф21.5) — поэтому разделённо.
  for (const k in rig.eff) { const e = rig.eff[k]!; if (e.ik && e.isFoot && mask.has(e.mid)) poles0.set(e.mid, e.pole.clone()); }
    return { mask, targets, rigid, anchorBone, anchorPos, pull: null, poles: poles0 };
  }

  // ТЯНЕМ ОРАНЖЕВУЮ РУЧКУ ЛОКТЯ/КОЛЕНА (Ф23.1).
  //
  // До этого полюс был РОВНО БЕСПОЛЕЗЕН, и причина была не в солвере: при драге полюса
  // `activeKey` и `fkProxyBone` ОБА `null`, поэтому ни одна ветка плана не срабатывала —
  // маска пустая, `plan.targets.size === 0`, и `solve` не звался ВООБЩЕ. Оранжевая точка
  // таскалась, `e.pole` честно менялся — и никто его не читал до следующего драга кисти.
  //
  // Цель конца остаётся где была: свивель — это вращение ЛОКТЯ ВОКРУГ линии плечо→кисть,
  // кисть при этом стоит. Поэтому якорь и цель — конец на своём же `target`.
  const ap = activePole ? rig.eff[activePole] ?? null : null;
  if (ap && ap.ik) {
    add(boneChain(ap.end, CHAIN_ROOT[activePole!] ?? 'Hips'));
    targets.set(ap.end, ap.target.clone());
    anchorBone = ap.end; anchorPos = ap.target.clone();
    for (const n of [...mask]) if (isHandBone(n)) mask.delete(n);
    // Полюс ИМЕННО ЭТОЙ конечности — всегда: его прямо сейчас тянет пользователь.
    const polesP = new Map<string, THREE.Vector3>([[ap.mid, ap.pole.clone()]]);
    for (const k in rig.eff) { const e = rig.eff[k]!; if (k !== activePole && e.ik && e.isFoot && mask.has(e.mid)) polesP.set(e.mid, e.pole.clone()); }
    return { mask, targets, rigid, anchorBone, anchorPos, pull: null, poles: polesP };
  }

  if (ae && ae.ik) {
    add(boneChain(ae.end, CHAIN_ROOT[activeKey!] ?? 'Hips'));
    const goal = ae.target.clone();
    targets.set(ae.end, goal);
    anchorPos = goal.clone();
    pull = { end: ae.end, goal: goal.clone() };
  } else if (activeKey === 'hips') {
    // ТАЗ ЖЁСТКИЙ, КОГДА ЕГО ТЯНЕШЬ САМ (Ф22.2). В маске он нужен для связности цепей,
    // но его ПОЗИЦИЯ АВТОРИТЕТНА: её уже ограничил `clampHipsToPins`. Без этой пометки FABRIK
    // через `writeHipsPosition` тянул таз ОБРАТНО к стопам, кламп поднимал его снова,
    // и система уравновешивалась на месте: тянешь на 20u — таз едет на 1.8u и стоит.
    add(['Hips']); rigid.add('Hips');
  }

  // Запиненные цепи — только когда таз в решении (иначе им негде сдвинуться).
  if (mask.has('Hips')) {
    for (const k in rig.eff) {
      const e = rig.eff[k]!;
      if (!e.ik || !e.pin || k === activeKey) continue;
      add(boneChain(e.end, CHAIN_ROOT[k] ?? 'Hips'));
      targets.set(e.end, e.target.clone());
    }
  }
  for (const n of [...mask]) if (isHandBone(n)) mask.delete(n);   // фаланги — территория хвата
  // ПОЛЮСЫ только для того, что решаем: чужой полюс для жёсткой кости всё равно не применится.
  //
  // РУКАМ ПОЛЮС В СОЛВЕР НЕ ПЕРЕДАЁТСЯ ВООБЩЕ (Ф23.1). Свивель руки ставится `applySwivel` —
  // точной формулой в момент драга оранжевой ручки, и остаётся в позе как авторский угол.
  // Зафиксированный ЖЕ в солвере свивель загоняет твист плеча за предел (±80°), клэмп режет —
  // и рука перестаёт целиться: замер на тяге кисти поперёк тела — недолёт 0 → 10.5u.
  // У НОГ полюс в солвере НУЖЕН: он чинит ФЛИП КОЛЕНА (Ф22.4), а стопа от него не страдает.
  const poles = new Map<string, THREE.Vector3>();
  // В СОЛВЕР ПОЛЮС ИДЁТ ТОЛЬКО ДЛЯ НОГ (Ф23.1).
  //
  // Колено смотрит вперёд — это АНАТОМИЯ, а не «ручная докрутка». Без полюса сторона сгиба
  // берётся из ЗНАКА ПРЕДЕЛА через ось шарнира В МИРЕ, а она зависит от ориентации бедра —
  // получается самоподдерживающийся ФЛИП. Замер на приседе: сгиб колена 70.4° → ВНЕЗАПНО 2.3°,
  // таз проваливался на 20u, нога уходила вбок — «шпагат» со скрина юзера. У рук включённый
  // всегда полюс, наоборот, ронял недолёт с 0 до 15–17u (Ф21.5) — поэтому разделённо.
  for (const k in rig.eff) { const e = rig.eff[k]!; if (e.ik && e.isFoot && mask.has(e.mid)) poles.set(e.mid, e.pole.clone()); }
  return { mask, targets, rigid, anchorBone, anchorPos, pull, poles };
}
function moveHips(delta: THREE.Vector3, except: Eff | null): void { rig.hipsPos.add(delta); for (const e of effList()) if (!e.isFoot && !e.pin && e !== except) e.target.add(delta); }

// ── Пикинг ──
const ray = new THREE.Raycaster(); let activeKey: string | null = null; let activePole: string | null = null; let activeGaze = false;
let activeShoulder: string | null = null;   // Ф26.3: тянем ручку плеча (ключ конечности LH/RH)
canvas.addEventListener('pointerdown', (ev) => {
  if (gizmo.dragging) return;
  if (shiftRings && !ev.shiftKey) shiftReset();   // Ф23.2: состояние колец протухло (потерян keyup) — чиним до пикинга
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
  // РУЧКИ СНАЧАЛА (Ф21.1). Один пикинг вместо двух веток: ручки проверяем первыми,
  // потому что они мельче костей и рисуются поверх (depthTest:false) — по картинке они сверху,
  // значит и в пикинге должны быть сверху. Невидимые (IK выкл) не ловятся — `visible` уважает raycast.
  //
  // ⚠ В РЕЖИМЕ ХВАТА РУЧЕК НЕТ ВОВСЕ, и это не придирка. Ручка-эффектор руки сидит РОВНО НА КИСТИ,
  // камера в хвате подлетает к кисти вплотную, а ручки рисуются поверх всего и ПОСТОЯННОГО ЭКРАННОГО
  // размера — то есть вблизи закрывают собой всю кисть. Каждый клик попадал в ручку, ветка выходила
  // сразу (`return`), и фаланги «не реагировали никак» — ровно то, на что жалоба. По дизайну Ф13.3 в
  // хвате кликаются ТОЛЬКО кости кисти, значит конкурировать за клик тут нечему.
  if (!gripMode) {
    const list: THREE.Object3D[] = [rig.hipsHandle, gazeHandle];
    for (const k in shoulderHandles) list.push(shoulderHandles[k]!);
    for (const e of effList()) list.push(e.handle, e.poleHandle);
    const hit = ray.intersectObjects(list, false)[0];
    if (hit) {
      // Голова и плечи — НЕ эффекторы конечностей: берёмся за них — НАМЕРЕНИЕ по руке сохраняется,
      // иначе клик по точке взгляда снимал бы тягу тела и корпус распрямлялся прямо под рукой.
      const shK = Object.keys(shoulderHandles).find((k) => shoulderHandles[k] === hit.object);
      const keepIntent = !!shK || hit.object === gazeHandle;
      if (!keepIntent) { activeKey = null; activePole = null; }
      activeGaze = false; activeShoulder = null;
      if (shK) { activeShoulder = shK; if (!gazeOn) girdleForget(); gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(shoulderHandles[shK]!); }
      else if (hit.object === gazeHandle) { activeGaze = true; if (!gazeOn) setGaze(true); gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(gazeHandle); }
      else if (hit.object === rig.hipsHandle) { activeKey = 'hips'; pinBase = pinMiss(); markHipsGood(); gizmo.setSpace('world'); gizmo.setMode(hipsMode); if (hipsMode === 'rotate') rig.hipsHandle.quaternion.copy(rig.hipsQuat); gizmo.attach(rig.hipsHandle); }
      else {
        const endK = Object.keys(rig.eff).find((k) => rig.eff[k]!.handle === hit.object);
        const polK = Object.keys(rig.eff).find((k) => rig.eff[k]!.poleHandle === hit.object);
        if (endK) { const e = rig.eff[endK]!; e.ik = true; syncEff(e); refreshLimbs(); activeKey = endK; gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(e.handle); }
        else if (polK) { const e = rig.eff[polK]!; e.ik = true; syncEff(e); refreshLimbs(); activePole = polK; gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(e.poleHandle); }
      }
      fkProxyBone = null; highlight(null); selected = null; refreshPose();
      return;
    }
  }
  activeKey = null; activePole = null; activeGaze = false; activeShoulder = null;
  // Кости + меши оружия (оружие — вращение вокруг хвата).
  // Ф13.3: ФАЛАНГИ кликабельны ТОЛЬКО в режиме хвата, и тогда — только они (плюс сама кисть).
  // Иначе клик по кисти постоянно попадал бы в палец, а в режиме хвата оружие перехватывало бы
  // пальцы, обёрнутые вокруг рукояти (меш оружия — сплошной бокс вокруг точки хвата).
  const pickable = (nm: string | undefined): boolean =>
    gripMode ? (!!nm && (isHandBone(nm) || nm === 'LeftHand' || nm === 'RightHand')) : !(nm && isHandBone(nm));
  const meshes: THREE.Mesh[] = boneMeshes().filter((m) => pickable(m.userData.bone as string | undefined));   // Ф20.4: кликаем то, что видно
  if (!gripMode) for (const g of weaponGroups) g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const hit = ray.intersectObjects(meshes, false)[0];
  if (hit) {
    const obj = hit.object as THREE.Mesh;
    // Открыта панель импорта → клик по кости ПЕРЕКЛЮЧАЕТ ЧАСТЬ МАСКИ (пикер по манекену, а не список галок).
    if (obj.userData.bone && importPanel?.togglePartOfBone(obj.userData.bone as string)) { /* маска переключена */ }
    else if (obj.userData.bone) { const nm = obj.userData.bone as string; selected = nm; highlight(obj); attachBoneGizmo(nm); refreshPose(); }
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
  if (activeGaze) { gazeTarget.copy(gazeHandle.position); return; }   // Ф24.2: тянем точку взгляда
  // ХЕЛПЕР ПЛЕЧА (Ф26.3): тянем плечевой сустав → доворачиваем ключицу туда же, в её пределах.
  // `girdleForget()` ПОСЛЕ правки обязателен: иначе следующий же `solveRig` сделает `girdleRelax()` и вернёт
  // ключицу в опорную позу — ручка бы не держала (та же логика, что у FK-правки ключицы ниже).
  if (activeShoulder) {
    const e = rig.eff[activeShoulder]!;
    shoulderGirdle(e, shoulderHandles[activeShoulder]!.position);
    girdleForget();
    if (e.pin || effList().some((x) => x.ik && x.pin)) solveRig(); else syncEff(e);
    return;
  }
  if (gizmo.object === boneProxy || !(activeKey || activePole)) {
    if (gizmo.object === boneProxy && fkProxyBone) {           // кольцо правит ОДИН СКАЛЯР сустава (см. jointDof.ts)
      const nm = fkProxyBone; const b = human.bones.get(nm);
      if (b) {
        const view = limitViewForBone(nm);
        if (view && limitVersion() === 2) {
          // v2 (FinalIK): кость просто едет за кольцом, а предел ТОЛЬКО останавливает. Никакой пересборки из
          // скаляров — именно она давала и гимбал-лок, и «руку крутит вокруг своей оси» при подъёме.
          _dq.copy(boneProxy.quaternion).multiply(_pBaseInv);   // deltaWorld = proxyNow · pBase⁻¹
          _nw.copy(_dq).multiply(_bBase);                       // newBoneWorld = deltaWorld · boneWorld0
          b.quaternion.copy(_parInv).multiply(_nw);             // newBoneLocal = parent⁻¹ · newBoneWorld
          if (clampFk) b.quaternion.copy(clampLocalToLimit(b.quaternion, view, b));
        } else if (view && _dofBase) {
          // ДЕЛЬТА ГИЗМО В ОСЯХ КОЛЕЦ. ТС вращает прокси вокруг его ЛОКАЛЬНОЙ X/Y/Z (`space:'local'`,
          // `q = qStart · axisAngle(unit, φ)`), а локальные оси прокси мы САМИ поставили на оси сустава,
          // несомые свингом (`parkProxy` → `gimbalFrame`). Значит `qStart⁻¹ · qNow` — чистый поворот вокруг ОДНОЙ
          // нарисованной оси, и его угол — ровно ввод пользователя. Что с ним делать, решает `swingRing`:
          // кольцо твиста правит свой скаляр, кольца свинга КРУТЯТ кость вокруг своей оси и гасят наведённый твист.
          _dDof.copy(_pBaseInv).multiply(boneProxy.quaternion);
          if (_dragAxis < 0) _dragAxis = AXI[gizmo.axis ?? ''] ?? ringAxis(_dDof);   // E/XYZE (свободные кольца) — по доминирующей оси
          const [raw, step] = ringDelta(_dDof, _dragAxis, _dragRaw);
          _dragAcc += step; _dragRaw = raw;
          const th = swingRing(view, _dofBase, _dragAxis, _dragAcc);
          b.quaternion.copy(quatFromDof(view, clampFk ? clampDof(view, th) : th));
        } else {
          // Кость без сустава (таз): степеней свободы не объявлено — старая композиция, клэмпить нечем.
          _dq.copy(boneProxy.quaternion).multiply(_pBaseInv);   // deltaWorld = proxyNow · pBase⁻¹
          _nw.copy(_dq).multiply(_bBase);                       // newBoneWorld = deltaWorld · boneWorld0
          b.quaternion.copy(_parInv).multiply(_nw);             // newBoneLocal = parent⁻¹ · newBoneWorld
        }
        // АВТО-FK, НО ПИН ВАЖНЕЕ (Ф22.1). Поворот кости конечности раньше ВСЕГДА гасил её IK —
        // и заколотая кисть теряла фиксатор от одного касания плеча. Заколота — значит держим.
        const lk = LIMB_OF[nm]; if (lk && !rig.eff[lk]!.pin) { rig.eff[lk]!.ik = false; refreshLimbs(); }
        // Правишь корпус руками — этот поворот стал АВТОРСКИМ, Pull больше не вправе его откатывать (Ф22.3).
        if ((TWIST_BONES as readonly string[]).includes(nm)) pullForget();
        if (nm === 'Neck' || nm === 'Head') gazeForget();   // Ф24.2: твой угол головы — новая база взгляда
        if (nm === 'LeftShoulder' || nm === 'RightShoulder') girdleForget();   // Ф25.3: ключицу правят руками — это новая база
        if (nm === 'Hips') rig.hipsQuat.copy(b.quaternion); const fk = nm === 'LeftFoot' ? 'LF' : nm === 'RightFoot' ? 'RF' : null; if (fk) rig.eff[fk]!.footQuat.copy(b.getWorldQuaternion(Q()));
      }
    }
    return;   // оружие/маркер (gizmo.object = группа) вращается гизмо напрямую — доп. обработки не нужно
  }
  if (!ikOn && activeKey !== 'hips') return;   // тумблер выкл: ручки спрятаны, но таз — нет; его ветка ниже работает всегда
  if (activePole) { const e = rig.eff[activePole]!; const rp = human.bones.get(e.root)!.getWorldPosition(V()); const pv = e.poleHandle.position.clone().sub(rp); if (pv.lengthSq() > 1e-6) e.pole.copy(pv.normalize()); return; }   // угол свивеля снимется в solveElbowEffector по ФАКТУ
  if (activeKey === 'hips') {
    if (hipsMode === 'translate') { moveHips(rig.hipsHandle.position.clone().sub(rig.hipsHandleAt), null); rig.hipsHandleAt.copy(rig.hipsHandle.position); }
    else rig.hipsQuat.copy(rig.hipsHandle.quaternion);
  }
  else {
    // Ф21.4: ТЯГА КИСТИ БОЛЬШЕ НЕ ДВИГАЕТ ТАЗ. Здесь стояло `moveHips(дельта × bodyFollow)` — КАЖДЫЙ
    // кадр драга весь персонаж ехал на 0.45 смещения руки, а запиненные стопы держали — это и есть
    // «раскорячивает». Теперь тело идёт за рукой СКРУТКОЙ КОРПУСА (см. PULL в `solveRig`), а таз
    // двигается только своей ручкой — как в Cascadeur, где таз отдельный контроллер.
    const e = rig.eff[activeKey!]!; const nt = e.handle.position.clone().sub(e.viewOff);   // ручка нарисована на ладони — цель на суставе
    e.target.copy(nt); e.prev.copy(nt);
  }
});

// ── Позы / клипы / undo ── (типы, blendTwo/clipPoseAt/migrateClip — из clipModel.ts)
function loadLib(): Clip[] { try { const s = localStorage.getItem('pe_clips'); if (!s) return []; return (JSON.parse(s) as unknown[]).map(migrateClip); } catch { return []; } }
/** Ключ клипа в библиотеке. Игра ищет ровно по этой тройке (`localStorageContent.find`). */
const clipKey = (c: { name: string; character: string; weapon: string }): string => `${c.name}|${c.character}|${c.weapon}`;
/** Индекс клипа с такой же тройкой (−1 = свободно). */
const clipIndexOf = (c: { name: string; character: string; weapon: string }): number =>
  library.findIndex((x) => x.name === c.name && x.character === c.character && x.weapon === c.weapon);
/** Свободное имя для тройки: `имя`, `имя_2`, `имя_3`… — в пределах того же персонажа и оружия. */
function freeClipName(nm: string, character: string, weapon: string): string {
  let n = nm;
  for (let i = 2; clipIndexOf({ name: n, character, weapon }) >= 0; i++) n = nm + '_' + i;
  return n;
}
/**
 * ЕДИНСТВЕННЫЙ ШОВ ЗАПИСИ КЛИПА В БИБЛИОТЕКУ.
 *
 * Раньше `library.push` стоял в дюжине мест, и у каждого была своя проверка на существующий клип —
 * или никакой. Отсюда дубли: в опубликованных данных `idle_dual` лежит в восьми экземплярах,
 * `hit_dual` тоже. Дедупа на чтении нет, игра берёт ПЕРВОЕ совпадение — значит семь копий из восьми
 * мёртвые, а редактор при этом может править совсем не ту, что читает игра.
 *
 * Режимы столкновения: `replace` — перезаписать молча (запекания, «взять за основу»);
 * `rename` — рядом под свободным именем (импорт, дубликат); `ask` — спросить, отказ = ничего не делать.
 * Возвращает записанный клип либо null, если пользователь отказался.
 */
function putClip(c: Clip, onExisting: 'replace' | 'rename' | 'ask' = 'ask'): Clip | null {
  const i = clipIndexOf(c);
  if (i < 0) { library.push(c); return c; }
  if (onExisting === 'rename') { c.name = freeClipName(c.name, c.character, c.weapon); library.push(c); return c; }
  if (onExisting === 'ask' && !confirm(`Клип «${c.name}» (${c.character} · ${c.weapon}) уже есть — перезаписать?`)) return null;
  library[i] = c;
  return c;
}
function saveLib(): void {
  // Превью импорта живёт В БИБЛИОТЕКЕ (чтобы даром получить скраб/таймлайн/призрака), но наружу его пускать нельзя.
  const out = library.filter((c) => c.name !== IMPORT_PREVIEW);
  // СТОРОЖ ДУБЛЕЙ. Сохранять не мешаем — иначе уже накопленные копии заблокировали бы работу целиком,
  // а чистит их автор сам. Но молчать нельзя: дубль означает, что правишь не тот клип, который читает игра.
  const dups = duplicateClipKeys(out);
  if (dups.length) console.warn('[pe_clips] ДУБЛИ (игра возьмёт первый, остальные мертвы):', dups.join(', '));
  try { localStorage.setItem('pe_clips', JSON.stringify(out)); savePoseKey('pe_clips'); } catch { /* */ }
}
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
/**
 * ЗАЗЕМЛЕНИЕ ПОПАДАЕТ В ЗАПИСАННУЮ ПОЗУ (Ф20.5). Решение юзера: «заземление в поз-редакторе
 * как раз и надо, чтобы делать позы, которые уже полу-соответствуют, а в игре подгонится, если пол кривой».
 *
 * ОДНИМ ШВОМ НА ЧТЕНИИ, а НЕ покадрово. Покадровое заземление манекена крутилось бы на
 * собственном выходе (`gs.off` — интегратор без затухания), после первого кадра стёрло бы
 * авторские углы ног и отменяло правки IK — следующий кадр возвращал бы ногу на пол.
 * Здесь же: заземлили → прочитали → вернули как было. Авторская поза в редакторе не меняется.
 *
 * Свой `GhostGround` — делить его с призраком нельзя: два рига на одном интеграторе удваивают шаг.
 */
const LEG_BONES = ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'];
const _manGround = newGhostGround();
/**
 * ⚠ `support` ОБЯЗАТЕЛЕН В ЛОКО. Без него `groundFeet` угадывает опорность по высоте стопы
 * (`PLANT_MAX = 6`), а маховая стопа поднимается по синусу до `liftWalk = 7` — то есть В НАЧАЛЕ И
 * В КОНЦЕ ПЕРЕНОСА она ниже порога, признаётся опорной и КЛАДЁТСЯ ПЛОСКО. Замер: угол голеностопа
 * 0.144 → 0.187 и −0.941 → −0.719, и стирается он ровно в тех кадрах, где подъём носка и нужен.
 *
 * Призрак рядом (`renderRagdollGhost`) опорность передаёт всегда — из-за этого манекен показывал
 * НЕ ТО, что игра, то есть ровно то, ради чего редактор и существует.
 */
function groundManikin(support?: [boolean, boolean]): (() => void) | null {
  if (!footGround) return null;
  const save = LEG_BONES.map((n) => human.bones.get(n)?.quaternion.clone() ?? null);
  const rootY = human.root.position.y;
  _manGround.off = 0;                                   // одноразовый шаг: интегратор с нуля…
  // ⚠ ВЕС ОКНА — ТОТ ЖЕ, что у призрака и в игре: иначе манекен снова покажет НЕ ТО, ради чего редактор и живёт.
  groundFeet(human, human.hipsWorldY(), _manGround, 1e3, () => 0, support,
    { w: locoOn ? lp().groundWeights : undefined,
      flat: locoOn ? lp().plantWeights : undefined,
      still: locoOn ? lp().moveMag < 0.02 : true });   // …и большой dt → полное схождение за один вызов
  return () => {
    LEG_BONES.forEach((n, i) => { const b = human.bones.get(n), q = save[i]; if (b && q) b.quaternion.copy(q); });
    human.root.position.y = rootY; human.root.updateMatrixWorld(true);
  };
}

/**
 * Ф27.5 — МАНЕКЕН РИСУЕТСЯ ЗАЗЕМЛЁННЫМ, КАК ПРИЗРАК И МЕШ — НО ТОЛЬКО НА ОТРИСОВКУ.
 *
 * Зазор между авторской позой и тем, что видно, — ЭТО НЕ РАССИНХРОН РИГОВ, а ПОДЪЁМ СТОПЫ
 * (`pe_phys.footLift`). Замер: при `footLift = 1.4` сдвиг призрака вверх 1.11u, при `footLift = 0`
 * он падает до −0.29u. Призрак поднимает лодыжку, чтобы ПОДОШВА МЕША лежала на полу, а манекен этот
 * подъём не применял вообще: его `footLift` читает только `groundFeet`, а его на манекене никто не звал.
 *
 * ПОЧЕМУ НЕЛЬЗЯ ЗАЗЕМЛИТЬ НАСОВСЕМ — две причины, обе уже куплены багами:
 *  1. `groundFeet` ПИШЕТ УГЛЫ опорных ног — авторский сгиб колена стирался бы каждый кадр
 *     (ровно то, против чего написана шапка `groundManikin` выше).
 *  2. Сдвинуть манекен на `gs.off` призрака тоже нельзя: физика берёт цель таза С МАНЕКЕНА,
 *     и сдвиг вернётся в следующий `gs.off` с обратным знаком — автоколебатель с усилением −1
 *     (та же семья ошибок, что утечка таза в Ф26.7 и самокормящаяся подгонка в Ф26.8).
 *
 * Поэтому: ЗАЗЕМЛИЛИ → НАРИСОВАЛИ → ВЕРНУЛИ, всё в ОДНОМ синхронном блоке. Между ними нет
 * ни `await`, ни событий, так что СОЛВЕР, ФИЗИКА, ПИНЫ и ЗАПИСЬ КАДРА видят только авторскую позу.
 * Работает ЛИШЬ ПРИ ВКЛЮЧЁННОЙ ФИЗИКЕ: без призрака сравнивать не с чем, а отрывать ручки от костей зря.
 */
let manGroundView = getPref('floorMannequin', true);
function groundManikinForView(): (() => void) | null {
  if (!manGroundView || !physOn || !ghostHuman) return null;
  const y0 = human.root.position.y;
  // ⚠ `lp()` в конструкторе зовёт measureStance → human.reset() и сбил бы позу в Позы/Анимации,
  // поэтому спрашиваем опорность ТОЛЬКО в локо — тот же гейт, что у призрака.
  const un = groundManikin(locoOn ? lp().groundSupport : undefined); if (!un) return null;   // опорность — тот же разбор, что в игре (на повороте клипом — из клипа)
  const dy = human.root.position.y - y0;
  // РУЧКИ ЦЕЛЕЙ ЕДУТ ВМЕСТЕ С КОСТЬЮ: они стоят на `e.target` в АВТОРСКОМ пространстве,
  // и без этого сдвига синяя ручка оторвалась бы от кисти на те же 1.4u. Полюсные и плечевые НЕ трогаем:
  // при включённой физике они уже стоят на ПРИЗРАКЕ (`viewBone`), то есть уже в заземлённом пространстве.
  const moved: THREE.Object3D[] = [rig.hipsHandle, ...effList().map((e) => e.handle)];
  for (const o of moved) o.position.y += dy;
  return () => { for (const o of moved) o.position.y -= dy; un(); };
}

function readPoseFull(): Pose {
  const ungroundManikin = groundManikin(locoOn ? lp().groundSupport : undefined);   // Ф20.5: читаем ЗАЗЕМЛЁННУЮ позу (опорность — как на экране), потом возвращаем манекен как был
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
  // Ф17: ФАЛАНГИ В КАДР НЕ ПОПАДАЮТ НИКОГДА. Раньше писались те, что ОТЛИЧАЮТСЯ от текущего
  // хвата — и любая правка формулы хвата превращала старые совпадения в расхождения, то есть в мёртвые
  // ключи, которые глушат хват навсегда. Канал хвата теперь единственный источник позы пальцев;
  // в клип они попадают только НА ЭКСПОРТЕ (`bakeGripIntoClip`), где это осознанный выбор пользователя.
  for (const nm in p) if (isHandBone(nm)) delete p[nm];
  // Офсет таза — ДЕЛЬТА от rest тела (Ф12): абсолют зависел от телосложения — «присед» среднего был бы «цыпочками» высокого.
  { const hp = human.hips.position, hr = human.hipsRest; setHipsOffset(p, [+(hp.x - hr.x).toFixed(2), +(hp.y - hr.y).toFixed(2), +(hp.z - hr.z).toFixed(2)]); }
  ungroundManikin?.();   // заземление двигает КОРЕНЬ, а не `hips.position`, так что в `__hipsD` выше оно не течёт
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
function applyPose(p: Pose): void { human.reset(); balanceOff.set(0, 0, 0);   // ⚠ reset убрал сдвиг баланса ИЗ КОСТИ — значит и запись о нём недействительна (см. `captureRig`)
   for (const nm in p) { if (nm[0] === '_') continue; const b = human.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); } { const hd = hipsOffset(p, human.hipsRest.y); if (hd) human.hips.position.set(human.hipsRest.x + hd[0], human.hipsRest.y + hd[1], human.hipsRest.z + hd[2]); } applyGripOver(p); applyWeaponPose(p); applyFramePhys(p); }   // восстановить авторский офсет таза (иначе после бега остаётся gait-standY → провал скелета)
// Интерп ПОВОРОТОВ кадров — КВАТЕРНИОННЫЙ SLERP (истинная кратчайшая дуга, без gimbal). Покомпонентный лерп эйлеров
// (даже с обёрткой углов в [-π,π]) на многоосевых кадрах даёт «прокрутку» руки (эйлеры далеки, хотя поворот близок).
// slerp учитывает двойное покрытие (q и −q = один поворот) → всегда короткий путь. lerpAng оставлен для скаляров/маркера.
function lerpPose(a: Pose, b: Pose, t: number): void {
  human.reset(); balanceOff.set(0, 0, 0);   // ⚠ тот же инвариант, что в `applyPose`: сдвига в кости больше нет
  for (const nm of human.boneNames) { const pa = a[nm] ?? [0, 0, 0], pb = b[nm] ?? [0, 0, 0]; slerpEuler(human.bones.get(nm)!.quaternion, pa, pb, t); }
  weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    if (rk) { const pa = a[rk], pb = b[rk]; if (pa && pb) slerpEuler(g.quaternion, pa, pb, t); else if (pa) g.rotation.set(pa[0], pa[1], pa[2]); }
    if (pk) { const pa = a[pk], pb = b[pk]; if (pa && pb) g.position.set(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t); else if (pa) g.position.set(pa[0], pa[1], pa[2]); }
  });
  const ip = (k: string, d: number): number => { const va = a[k]?.[0] ?? d, vb = b[k]?.[0] ?? va; return va + (vb - va) * t; };
  PHYS.match = ip('__match', physMatchBase); PHYS.pinKp = ip('__pinKp', DEF_PINKP);   // per-кадр физ скользит в проигрывании
  { // Офсет таза скользит по кадрам (иначе провал/рывок при скрабе). Обе формы ключа приводятся к дельте ДО лерпа
    // — иначе клип со смешанными кадрами (часть перезаписана) дал бы скачок на границе.
    const hr = human.hipsRest;
    const da = hipsOffset(a, hr.y), db = hipsOffset(b, hr.y);
    if (da || db) {
      const p0 = da ?? db!, p1 = db ?? da!;
      human.hips.position.set(hr.x + p0[0] + (p1[0] - p0[0]) * t, hr.y + p0[1] + (p1[1] - p0[1]) * t, hr.z + p0[2] + (p1[2] - p0[2]) * t);
    }
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
  if (ikOn) captureRig();
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

interface State { pose: Pose; hips: { p: [number, number, number]; q: [number, number, number, number] }; eff: Record<string, { t: [number, number, number]; fq: [number, number, number, number]; pl: [number, number, number]; ik: boolean; pin: boolean; kr?: boolean }> }
function snapshot(): State {
  const eff: State['eff'] = {};
  for (const k in rig.eff) { const e = rig.eff[k]!; eff[k] = { t: e.target.toArray() as [number, number, number], fq: e.footQuat.toArray() as [number, number, number, number], pl: e.pole.toArray() as [number, number, number], ik: e.ik, pin: e.pin, kr: e.keepRot }; }
  return { pose: readPoseFull(), hips: { p: rig.hipsPos.toArray() as [number, number, number], q: rig.hipsQuat.toArray() as [number, number, number, number] }, eff };
}
function restore(s: State): void {
  applyPose(s.pose); rig.hipsPos.fromArray(s.hips.p); rig.hipsQuat.fromArray(s.hips.q);
  for (const k in s.eff) { const e = rig.eff[k]; const d = s.eff[k]!; if (e) { e.target.fromArray(d.t); e.footQuat.fromArray(d.fq); if (d.pl) e.pole.fromArray(d.pl); e.ik = d.ik; e.pin = d.pin; if (d.kr !== undefined) e.keepRot = d.kr; } }
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
  if (ikOn) captureRig();
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
/**
 * СТАРТОВОЕ КАДРИРОВАНИЕ: смотрим на ГОЛОВУ и чуть ВПЕРЁД, а не в таз.
 *
 * Было зашито `orbit.target.set(0, 34, 0)` — высота таза. Орбита крутилась вокруг низа фигуры:
 * персонаж уезжал в верх кадра, а под ним оставалось полэкрана пустого пола.
 *
 * Высота берётся С КОСТИ ГОЛОВЫ, а не числом: у персонажей разный рост (морф, профиль атласа), и
 * зашитая цифра для кого-то снова оказалась бы «под персонажем». Нет кости — остаёмся на прежней
 * высоте, то есть ровно как было.
 *
 * `FWD` — сдвиг к камере (наш манекен смотрит в +Z, камера тоже стоит по +Z): взгляд попадает
 * перед лицом, а не в затылок сквозь голову.
 */
const CAM_FWD = 14;      // насколько точка выносится вперёд от головы, ед.
const CAM_BACK = 150;    // отлёт камеры от точки
const CAM_UP = 10;       // подъём камеры над точкой — фигура ложится в кадр ниже центра
function frameOnHead(): void {
  const head = human?.bones.get('Head');
  const p = head ? head.getWorldPosition(V()) : new THREE.Vector3(0, 34, 0);
  orbit.target.set(p.x, p.y, p.z + CAM_FWD);
  camera.position.set(orbit.target.x, orbit.target.y + CAM_UP, orbit.target.z + CAM_BACK);
  orbit.update();
}

function camFocus(obj?: THREE.Object3D | null): void {
  const o = obj ?? (selected ? viewBone(selected) : null) ?? viewRig().hips;   // Ф20.2: летим к ВИДИМОЙ кости
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
    case 's': case 'S': case 'ы': case 'Ы': snapOn = !snapOn; setPref('snap', snapOn); applySnap(); renderAnim(); break;
    // Анимационные клавиши — только на вкладке «Анимация» и только когда есть клип (иначе пробел «проглатывался»
    // на других вкладках, а Del удалял бы кадр там, где кадров вообще нет).
    case ' ': if (!animKeys()) return; togglePlay(); break;
    case 'ArrowLeft': if (!animKeys()) return; goFrame(Math.max(0, frameIdx - 1)); break;
    case 'ArrowRight': if (!animKeys()) return; { const c = curClip()!; goFrame(Math.min(c.keys.length - 1, frameIdx + 1)); } break;
    case 'i': case 'I': case 'ш': case 'Ш': if (!animKeys()) return; recordFrame(); break;
    case 'Delete': if (!animKeys()) return; deleteFrame(); break;
    default: return;
  }
  e.preventDefault();
});
/** Клавиши правки клипа активны только там, где они имеют смысл. */
const animKeys = (): boolean => tab === 'anim' && !!curClip()?.keys.length;
function togglePlay(): void { playBtn.click(); }
/** `i` — записать текущую позу в кадр (концы-стойка неприкосновенны, как и у кнопки). */
function recordFrame(): void {
  const c = curClip(); if (!c || isEndFrame(c, frameIdx)) return;
  histLib('записать кадр', () => { if (c.keys[frameIdx]) c.keys[frameIdx]!.pose = readPoseFull(); saveLib(); });
}
/** Del — удалить кадр (те же ограничения, что у кнопки «− кадр»). */
function deleteFrame(): void {
  const c = curClip(); if (!c || isEndFrame(c, frameIdx)) return;
  const lock = !!c.idleEnds || isAttackClip(c);
  if (c.keys.length <= (lock ? 3 : 1)) return;
  histLib('удалить кадр', () => { c.keys.splice(frameIdx, 1); frameIdx = Math.min(frameIdx, c.keys.length - 1); saveLib(); refreshAll(); });
}
/** Крайний кадр клипа-удара/импорта = idle-стойка: правится в стойке, а не тут. */
const isEndFrame = (c: Clip, i: number): boolean =>
  (!!c.idleEnds || isAttackClip(c)) && (i === 0 || i === c.keys.length - 1);
/**
 * КОЛЬЦА ПО УДЕРЖАНИЮ SHIFT (Ф21.1). Двигать и крутить надо ОДНИМ инструментом, но два
 * постоянных набора ручек на экране — каша и промахи мышью. Держишь Shift → гизмо становится
 * КОЛЬЦАМИ кости (той, что выбрана, или КОНЦА той ручки, за которую держишься), отпустил —
 * вернулись стрелки. Со снапом (тот же Shift) конфликта нет: снап важен ВО ВРЕМЯ драга, кольца — ДО него,
 * поэтому переключение гейтится по `gizmo.dragging`.
 */
let shiftRings: { key: string | null; pole: string | null; sel: string | null } | null = null;
/** Кость, чьи кольца показать: выбранная напрямую — или та, к которой относится активная ручка. */
function ringBone(): string | null {
  if (selected) return selected;
  if (activeKey === 'hips') return 'Hips';
  if (activeKey) return rig.eff[activeKey]!.end;
  if (activePole) return rig.eff[activePole]!.mid;
  return null;
}
const hiMesh = (nm: string | null): void => highlight(nm ? boneMeshes().find((x) => x.userData.bone === nm) ?? null : null);
function ringsOn(): void {
  if (shiftRings || gizmo.dragging) return;
  const nm = ringBone(); if (!nm || !human.bones.get(nm)) return;
  shiftRings = { key: activeKey, pole: activePole, sel: selected };
  activeKey = null; activePole = null; selected = nm;
  hiMesh(nm); attachBoneGizmo(nm); refreshPose();
}
function ringsOff(): void {
  const r = shiftRings; if (!r) return;
  shiftRings = null;
  if (gizmo.dragging) return;   // крутит кольца прямо сейчас — не выдёргиваем гизмо из-под руки
  fkProxyBone = null; selected = r.sel; activeKey = r.key; activePole = r.pole; hiMesh(r.sel);
  if (r.key === 'hips') { gizmo.setSpace('world'); gizmo.setMode(hipsMode); if (hipsMode === 'rotate') rig.hipsHandle.quaternion.copy(rig.hipsQuat); gizmo.attach(rig.hipsHandle); }
  else if (r.key) { gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(rig.eff[r.key]!.handle); }
  else if (r.pole) { gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(rig.eff[r.pole]!.poleHandle); }
  else if (r.sel) attachBoneGizmo(r.sel);
  else gizmo.detach();
  refreshPose();
}
addEventListener('keydown', (e) => { if (e.key === 'Shift') { applySnap(true); ringsOn(); } });
addEventListener('keyup', (e) => { if (e.key === 'Shift') { applySnap(); ringsOff(); } });
/**
 * АВАРИЙНЫЙ СБРОС «ЗАЛИПШЕГО» SHIFT (Ф23.2).
 *
 * `keyup` может НЕ ПРИЙТИ вообще: Alt+Tab, клик мимо окна, переключение вкладки —
 * окно теряет фокус с зажатой клавишей. Тогда `shiftRings` оставался непустым НАВСЕГДА,
 * `ringsOn` каждый раз выходил по первой же строке — и кольца больше не появлялись. Именно
 * так выглядит жалоба «через какое-то время пропал Shift и вращение»: вращение и ЕСТЬ кольца.
 * Снап залипал точно так же — поэтому сбрасываем оба.
 */
function shiftReset(): void { ringsOff(); applySnap(); }
addEventListener('blur', shiftReset);
document.addEventListener('visibilitychange', () => { if (document.hidden) shiftReset(); });
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) history.redo(); else history.undo(); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); history.redo(); } });

// ── Физ-настройки per-персонаж (pe_phys): вес совпадения рендера с манекеном (RB2) — редактор пишет, игра читает. ──
const DEF_PINKP = PHYS.pinKp;   // дефолт жёсткости пинов (фолбэк для кадров без __pinKp)
let physMatchBase = DEFAULT_MATCH;   // база match персонажа (pe_phys) — фолбэк для кадров БЕЗ __match (и для покоя/бега в игре); дефолт = игровой (DEFAULT_MATCH)
/**
 * ПРОФИЛЬ ГИБКОСТИ КОРПУСА (Ф26.6, пер-персонаж) — множители анатомических пределов тяги тела.
 * Тяжёлый воин в доспехе скованнее, ассассин гибче — при одном и том же ползунке «тело за рукой».
 * Лежит в `pe_phys[char]` рядом с match/footLift: та же секция уже ездит на сервер и читается игрой.
 */
let flexTw = 1, flexBend = 1, flexPelvis = 1;
let physFootLift = 0;   // подъём стопы персонажа (pe_phys.footLift) — ставится на human/ghostHuml после сборки; standY+заземление подошвы меша на пол
interface PhysPer { match?: number; footLift?: number; flex?: [number, number, number] }
function loadPhys(id: string): void {
  try {
    const c = JSON.parse(localStorage.getItem('pe_phys') || '{}') as Record<string, PhysPer>;
    physMatchBase = c[id]?.match ?? DEFAULT_MATCH; physFootLift = c[id]?.footLift ?? 0;
    const f = c[id]?.flex; flexTw = f?.[0] ?? 1; flexBend = f?.[1] ?? 1; flexPelvis = f?.[2] ?? 1;
  } catch { physMatchBase = DEFAULT_MATCH; physFootLift = 0; flexTw = flexBend = flexPelvis = 1; }
  PHYS.match = physMatchBase; PHYS.pinKp = DEF_PINKP;
}
function saveFlex(): void {
  try {
    const c = JSON.parse(localStorage.getItem('pe_phys') || '{}') as Record<string, PhysPer>;
    (c[curCharId] ??= {}).flex = [+flexTw.toFixed(2), +flexBend.toFixed(2), +flexPelvis.toFixed(2)];
    localStorage.setItem('pe_phys', JSON.stringify(c)); savePoseKey('pe_phys');
  } catch { /* офлайн — норм */ }
}
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
    const c = JSON.parse(localStorage.getItem('pe_phys') || '{}') as Record<string, PhysPer>;
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
/**
 * ── Ф27: ОДИН РЕЦЕПТ СКЕЛЕТА НА ВСЕ РИГИ ──────────────────────────────────────────────
 *
 * В редакторе живут ЧЕТЫРЕ рига ОДНОЙ анатомии: авторский манекен `human`, физ-призрак
 * `ghostHuman` (он же `solid` игры — именно он ведёт МЕШ), онион-призраки соседних кадров и
 * риг-источник модели внутри вкладки «Модели». Входы у них одни и те же, а ПОВОД пересборки
 * был у каждого СВОЙ — и любой повод, поднявший только один, разводил их по РАЗНЫМ скелетам:
 *
 *  • смена вида манекена (`setManView` → `rebuildManikin`) поднимала ТОЛЬКО манекен — замер:
 *    плечо 10.80u против 15.60u у призрака, кисть уезжала на 4.71u, стопа на 4.91u;
 *  • сторож в цикле сравнивал офсеты атласа ПО ССЫЛКЕ, а их лечение ДОПИСЫВАЕТ тот же объект —
 *    смена не замечалась, и ОБА рига оставались процедурными, хотя офсеты готовы на 366-й мс;
 *  • гейт `if (pw)` молча пропускал пересборку призрака, пометив смену применённой.
 *
 * Лечение: рецепт становится ЗНАЧЕНИЕМ с ключом ПО СОДЕРЖИМОМУ, ключ штампуется НА САМОМ риге,
 * а `syncRigs()` раз в кадр поднимает те, чей ключ устарел. Поводов больше нет — есть один ключ.
 */
type RigRecipe = {
  gender: 'male' | 'female'; build: ReturnType<typeof morphBuild>; boneScale: ReturnType<typeof morphBoneScale>;
  boneOffsets: ReturnType<typeof atlasOff>; profile: ReturnType<typeof atlasProfile>; fingers: boolean;
};
function rigRecipe(): RigRecipe {
  const c = curChar();
  return { gender: c.gender, build: morphBuild(c), boneScale: morphBoneScale(), boneOffsets: atlasOff(), profile: atlasProfile(), fingers: wantFingers() };
}
/** Ключ ПО СОДЕРЖИМОМУ: ссылка на офсеты при их лечении НЕ меняется, а числа — меняются. */
const recipeKey = (r: RigRecipe): string => JSON.stringify([r.gender, r.build, r.boneScale, r.boneOffsets, r.profile, r.fingers]);
/** Ключ, которым риг ФАКТИЧЕСКИ построен — хранится на нём же, поэтому не теряется ни при какой пересборке. */
const rigKeyOf = (h: Humanoid): string => (h.root.userData.rigKey as string) ?? '';
function stampRig<T extends Humanoid>(h: T): T { h.root.userData.rigKey = recipeKey(rigRecipe()); return h; }
/**
 * Раз в кадр: поднять риги, чей рецепт устарел. Манекен ПЕРВЫМ (с него читают позу
 * призрак и модель), затем призрак, затем онионы и риг-источник модели.
 * В покое не делает НИЧЕГО — иначе выбор кости слетал бы каждый кадр (`rebuildManikin` сбрасывает `selected`).
 */
const RIG_SETTLE = 6;            // кадров покоя ключа до пересборки (~0.1 с)
let pendKey = '', pendN = 0;
function syncRigs(): void {
  const key = recipeKey(rigRecipe());
  // КЛЮЧ ОБЯЗАН ОТСТОЯТЬСЯ. Слайдеры морфа пишут значение на `oninput`, а пересобирать риги
  // положено на ОТПУСКАНИИ (правило Ф26.5) — без этой выдержки протяжка ползунка роста
  // пересобирала бы все четыре рига КАЖДЫЙ КАДР и сбрасывала выбор кости.
  if (key !== pendKey) { pendKey = key; pendN = 0; return; }
  if (pendN < RIG_SETTLE) { pendN++; return; }
  let touched = false;
  if (human && rigKeyOf(human) !== key) { rebuildManikin(); touched = true; }
  if (pw && (!ghostHuman || rigKeyOf(ghostHuman) !== key)) { buildGhost(); touched = true; }
  if ((onionPrev && rigKeyOf(onionPrev) !== key) || (onionNext && rigKeyOf(onionNext) !== key)) { disposeOnion(); touched = true; }
  // РИГ-ИСТОЧНИК МОДЕЛИ СЮДА НЕ ВХОДИТ ОСОЗНАННО: он строится ПРЯМО из атласа (`curAtlas()`),
  // то есть всегда актуален, а морф ему довозит `refreshProfile()`. Замер (Ф27): до починки манекена
  // расхождение с костями модели было 5.07u ИМЕННО из-за манекена. Пересобирать его по ключу ВРЕДНО:
  // `rebuildAsm()` дизпоузит скин и тянет GLB заново — меш исчезал на несколько секунд на каждой смене рецепта.
  // ФИЗ-ТЕЛА ПЕРЕСНИМАЮТСЯ ВМЕСТЕ С РИГАМИ. Их `off` — это НАПРАВЛЕНИЕ КОСТИ, снятое один раз.
  // После Ф27 риги переезжают с процедурной геометрии на АТЛАСНУЮ, где бедро идёт `[3.03, −16.27, 2.59]`,
  // а не строго вниз — старые `off` оставались вертикальными, и боксы висели мимо кости.
  if (touched) { updateWeapon(); refitPhysIfFitted(); refreshAll(); }   // оружие висело на старом риге; панель читает геометрию
}
/** Кости, по которым меряется расхождение ригов (без фаланг: их ведёт отдельный канал хвата). */
const DELTA_BONES = ['Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head', 'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'];
/**
 * РАСХОЖДЕНИЕ РИГОВ (Ф27.2) — максимум по костям, в юнитах. Два РАЗНЫХ числа:
 *  • `ghost` — манекен против призрака. ЧЕСТНАЯ разница: призрак заземлён и блендится к позе
 *    по `PHYS.match`, то есть показывает то же, что увидит игра. При выключенной физике обязана быть 0.
 *  • `mesh` — призрак против НАСТОЯЩИХ костей загруженной модели. ОБЯЗАНА быть 0 ВСЕГДА:
 *    серое тело — это тот самый риг, которым ведётся меш, и врать про него оно не имеет права.
 */
function rigDelta(): { ghost: number; ground: number; pose: number; mesh: number | null; bones: number } {
  let g = 0, m = 0, n = 0, ps = 0;
  // ВЕРТИКАЛЬ ТАЗА = ЗАЗЕМЛЕНИЕ, а не рассинхрон. Призрак стоит на полу (foot-IK + `gs.off`),
  // авторская поза — нет; в игре видно только заземлённое тело, поэтому разницу важно ПОКАЗАТЬ ОТДЕЛЬНО:
  // без этого честный параллельный перенос читается как поломка ригов.
  const hm = human?.bones.get('Hips'), hg = ghostHuman?.bones.get('Hips');
  const gy = (hm && hg) ? hg.getWorldPosition(V()).y - hm.getWorldPosition(V()).y : 0;
  for (const nm of DELTA_BONES) {
    const a = human?.bones.get(nm); if (!a) continue;
    const gb = ghostHuman?.bones.get(nm);
    if (gb) {
      const d = gb.getWorldPosition(V()).sub(a.getWorldPosition(V()));
      g = Math.max(g, d.length());
      d.y -= gy; ps = Math.max(ps, d.length());     // без вертикали заземления — чистая разница ПОЗЫ (физ-бленд по `match`)
    }
    const mb = modelsTab.atlasBone(nm);
    // СЧЁТЧИК СРАВНЁННЫХ КОСТЕЙ ОБЯЗАТЕЛЕН: без него метрика врёт самым опасным способом —
    // показывает бодрый 0.00u там, где модель просто не загружена и сравнивать не с чем (поймано контрольным замером).
    //
    // ⚠ СРАВНИВАЕМ С ТЕМ РИГОМ, КОТОРЫЙ МЕШ И ВЕДЁТ (`modelsTab.drive(physOn && ghost ? ghost : human)`),
    // а не «с призраком, если он есть». При выключенной физике меш ведёт МАНЕКЕН, а призрак стоит
    // непозированным — и метрика показывала его расхождение как «меш уехал». Ровно на это я и купился.
    const drv = (physOn && gb) ? gb : a;
    if (mb) { n++; m = Math.max(m, drv.getWorldPosition(V()).distanceTo(mb.getWorldPosition(V()))); }
  }
  return { ghost: +g.toFixed(2), ground: +gy.toFixed(2), pose: +ps.toFixed(2), mesh: n ? +m.toFixed(2) : null, bones: n };
}
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
// Ф13.3: РЕЖИМ ХВАТА. По пальцам кликаем ТОЛЬКО в нём — иначе, целясь в кисть, хватаешь фалангу.
// НЕ зависит от Простой/Про: настройка хвата нужна любому. НЕ персистится: иначе после F5
// открываешь редактор с камерой в ладони и не понимаешь, почему не выбирается ни одна кость тела.
let gripMode = false;
let gripSide: 'Left' | 'Right' = 'Right';
// ОДИН размер шара на все кости и все режимы. Было `10px пальцам / 4px остальному` в режиме хвата —
// разница в 2.5 раза читалась как «на пальцах шары намного больше», а не как подсказка.
// 7px при дефолтном кадре = ровно прежние ~1.6 юнита, то есть тело выглядит как раньше.
const JOINT_PX = 7;
let gripCamBack: { pos: THREE.Vector3; tgt: THREE.Vector3 } | null = null;   // куда вернуть камеру на выходе
let limitPresetId = 'human';
// ── Ф7: БИБЛИОТЕКА ПОЗ И COPY-TOOLS ──
let poseLib: PoseLibrary = (() => { try { return { ...EMPTY_POSE_LIBRARY(), ...(JSON.parse(localStorage.getItem('pe_poselib') || '{}') as PoseLibrary) }; } catch { return EMPTY_POSE_LIBRARY(); } })();
function savePoseLib(): void { try { localStorage.setItem('pe_poselib', JSON.stringify(poseLib)); savePoseKey('pe_poselib'); } catch { /* */ } }
let poseBuf: Pose | null = null;   // буфер «копировать позу» (выделенные кости либо всё тело)
// ХВАТ КИСТИ (Ф3.5) — не часть клипа: привязан к ключу оружия, накладывается поверх.
// Кадр, в котором фаланги ЗАДАНЫ явно (Про-режим крутил их руками), хват не перебивает.
let gripCfg: GripConfig = (() => { try { return { ...EMPTY_GRIP_CONFIG(), ...(JSON.parse(localStorage.getItem('pe_gripposes') || '{}') as GripConfig) }; } catch { return EMPTY_GRIP_CONFIG(); } })();
function saveGrips(): void { try { localStorage.setItem('pe_gripposes', JSON.stringify(gripCfg)); savePoseKey('pe_gripposes'); } catch { /* */ } }
(function migrateGripBinds(): void {
  // Ф17: выбор пресета больше не хранится — тип хвата выводится из ключа оружия. В старых записях
  // лежат id встроенных пресетов, которые туда ЗАМОРАЖИВАЛО само открытие панели — отличить их от
  // осознанного выбора невозможно, и именно они держали старый хват при смене оружия. Свои кисти
  // (`c_*`, сохранённые кнопкой) — явный выбор, их оставляем. Идемпотентно.
  let ch = false;
  for (const char of Object.keys(gripCfg.byWeapon)) {
    const byW = gripCfg.byWeapon[char]!;
    for (const w of Object.keys(byW)) {
      const e = byW[w]!;
      const keepL = e.L?.startsWith('c_') ? e.L : undefined, keepR = e.R?.startsWith('c_') ? e.R : undefined;
      if (!keepL && !keepR) { delete byW[w]; ch = true; continue; }
      if (e.L !== keepL || e.R !== keepR) { byW[w] = { L: keepL, R: keepR, closeL: e.closeL, closeR: e.closeR }; ch = true; }
    }
    if (!Object.keys(byW).length) { delete gripCfg.byWeapon[char]; ch = true; }
  }
  if (ch) saveGrips();
})();
// Ф17: запись оверрайдов для ТЕКУЩЕГО оружия — СОЗДАЁТСЯ ПУСТОЙ. Раньше сюда сразу ложился
// `defaultWeaponGrip(weapon)`, то есть АВТО-выбор замораживался в конфиг при ПЕРВОМ же показе панели.
// Действующий хват считает `effectiveWeaponGrip` — всегда от КЛЮЧА ОРУЖИЯ, поверх — только явно сохранённое.
const weaponGripBind = (): WeaponGrip =>
  (gripCfg.byWeapon[curCharId] ??= {})[weapon] ??= {};
/**
 * ⭐ УРОВЕНЬ ПРАВКИ ХВАТА: «клип» (умолчание) или «оружие».
 *
 * Хват ключевался ТОЛЬКО оружием — отсюда жалоба «настроил для релакс-idle, потом для incombat, а он
 * применился ко всему». Спокойная и боевая стойка (и каждый удар) держат оружие по-разному, и это
 * нормально. Уровень оружия остаётся как ОБЩАЯ база: цепочка клип → оружие → авто, по полям.
 */
let gripScope: 'clip' | 'weapon' = 'clip';
/** Части тела для кнопки «зажать пределами» (умолчание — голова, см. панель импорта). */
let clampSel: MaskPart[] = ['head'];
let clampNote = '';   // отчёт последнего клампа — переживает перерисовку панели
/** Имя клипа, на который сейчас пишем/читаем хват (null — правим уровень оружия). */
const gripClipName = (): string | null => (gripScope === 'clip' ? (curClip()?.name ?? null) : null);
/** Запись хвата на ТОТ уровень, который выбран. */
const gripBind = (): WeaponGrip => {
  const nm = gripClipName();
  if (!nm) return weaponGripBind();
  return ((gripCfg.byClip ??= {})[curCharId] ??= {})[nm] ??= {};
};
/** Что действует сейчас (авто по оружию + оверрайды оружия + оверрайды клипа). */
const gripNow = (): ReturnType<typeof effectiveWeaponGrip> => effectiveWeaponGrip(gripCfg, curCharId, weapon, curClip()?.name);
/** Поза пальцев для текущего персонажа/оружия/КЛИПА. */
const curGripPose = (): Pose => resolveGripPose(gripCfg, curCharId, weapon, fingerAxes(), curClip()?.name);
/**
 * СНЯТЬ КОНЕЦ СЛАЙДЕРА С ЖИВОЙ КИСТИ (Ф18): что выставили руками — то и будет на 0 или на 1.
 *
 * Это замена процедурной математики там, где она не угадывает: вместо того чтобы нагромождать
 * проверки на каждую особенность чужого рига, даём выставить оба конца глазами и снять их.
 * Снятый конец хранится готовыми углами и НИЧЕМ больше не корректируется.
 */
function saveHandEnd(side: 'Left' | 'Right', end: 'open' | 'fist'): void {
  const sfx = side === 'Left' ? 'L' : 'R';
  const id = `c_${curCharId}_${weapon}_${sfx}_${end}`.replace(/[^\w+]/g, '_');
  const pose: Pose = {};
  for (const nmb of human.boneNames) if (isHandBone(nmb) && nmb.startsWith(side)) { const r = human.bones.get(nmb)!.rotation; pose[nmb] = [+r.x.toFixed(4), +r.y.toFixed(4), +r.z.toFixed(4)]; }
  if (!Object.keys(pose).length) return;
  gripCfg.custom[id] = { id, label: `${weapon} ${sfx} ${end === 'open' ? 'ладонь' : 'кулак'}`, pose };
  const b = gripBind();
  if (end === 'open') { if (side === 'Left') b.openL = id; else b.openR = id; }
  else { if (side === 'Left') b.L = id; else b.R = id; }
  saveGrips(); goFrame(frameIdx); refreshAll();
}
/** Вернуть кисть на авто: оба конца снова считаются (выпрямленная ладонь ↔ пресет по оружию). */
function resetHandEnds(side: 'Left' | 'Right'): void {
  const b = gripBind();
  if (side === 'Left') { delete b.L; delete b.openL; } else { delete b.R; delete b.openR; }
  saveGrips(); goFrame(frameIdx); refreshAll();
}

/**
 * Наложить хват. Ф17: ХВАТ ВЕДЁТ ФАЛАНГИ ВСЕГДА, без оглядки на позу кадра.
 *
 * Было: кадр с явно записанными фалангами хват не перебивал — и именно это выглядело как
 * «на левой хват работает, на правой нет, причём только на топоре»: в `idle_axe` все 15 фаланг правой
 * кисти оказались записаны почти-нулями (осадок прошлой формулы), и рука намертво стояла в бинде.
 *
 * По дизайну (шапка `gripPoses.ts`) хват — ОТДЕЛЬНЫЙ КАНАЛ, а не часть клипа; исключение «кроме
 * случаев, когда канал всё-таки часть клипа» создавало невидимую ловушку без единого признака в UI.
 * Ручная правка пальцев не потеряна — она сохраняется кнопкой «запомнить эту кисть» в тот же канал.
 */
function applyGripOver(_p?: Pose): void {
  if (!wantFingers()) return;
  const g = curGripPose();
  applyGripPose(human.bones, g);
  if (ghostHuman) applyGripPose(ghostHuman.bones, g);   // см. `applyGripToGhost`
}
/**
 * ХВАТ НАДО КЛАСТЬ И НА ПРИЗРАКА (Ф19) — именно он ведёт МЕШ, когда физика включена.
 *
 * Фаланги не имеют физ-тел в базовом наборе, поэтому `renderRagdollGhost` их не трогает и они
 * остаются в rest — то есть в БИНДЕ модели. Замерено на knight_05: фаланга призрака расходилась
 * с манекеном на 5.8°, кончик — на 1.1u, и это НЕ зависело от `PHYS.match` (при match = 1 то же самое).
 * Со стороны это выглядело как «включаю физику — меш съезжает, а кости стоят».
 */
/**
 * ⭐ ХВАТ УЕЗЖАЕТ В ИГРУ ЗАПЕЧЁННЫМ В КЛИПЫ — решение автора: «из редактора будут отправляться
 * готовые анимации».
 *
 * До этого канал хвата был ЧИСТО РЕДАКТОРСКИМ: `resolveGripPose` звал только поз-редактор, а игра
 * фаланг не трогала вовсе — в клипах их обычно нет, и кисть оставалась в БИНДЕ модели. То есть кисть
 * была единственным местом, где редактор рисовал не то, что игра.
 *
 * Запекаем НА ПУБЛИКАЦИИ, а не в рабочую копию: канал должен остаться правимым (ползунок «ладонь ↔
 * хват», снятые концы), поэтому локальные клипы чистые, а наружу уезжает результат. `bakeGripIntoClip`
 * заполняет только ПУСТЫЕ фаланги — поза, выставленная руками в кадре, сильнее.
 *
 * ⚠ Изменил хват — опубликуй заново: в игре живёт запечённое, а не живой канал.
 */
setPublishPrepare((key, value) => {
  if (key !== 'pe_clips' || !Array.isArray(value)) return value;
  const axes = fingerAxes();
  return (value as Clip[]).map((c) => bakeGripIntoClip(
    { ...c, keys: (c.keys ?? []).map((k) => ({ ...k, pose: clonePose(k.pose) })) },
    resolveGripPose(gripCfg, c.character, c.weapon, axes, c.name)));   // ⭐ хват КЛИПА (см. `GripConfig.byClip`)
});

function applyGripToGhost(): void {
  if (ghostHuman && wantFingers()) applyGripPose(ghostHuman.bones, curGripPose());
}   // выбранный пресет пределов скелета (Ф3.3)
// ТРИ НЕЗАВИСИМЫХ причины построить пальцы, объединённые OR, а не один флаг на всех:
// выход из режима хвата не должен сносить пальцы, включённые кнопкой ✋ или пришедшие с моделью.
function wantFingers(): boolean { return fingersForced || gripMode || modelsTab.hasFingers(); }   // профиль тела (модульные пропорции) — как игра строит solid/target; редактор строит манекен/призрак им (P3: opts 1:1)
/** Скелет-манекен ПОВЕРХ импортного меша (depthTest off) — виден и кликается сквозь модель. Только для skeleton-стиля. */
function manikinOnTop(): void {
  if (curHumanStyle !== 'skeleton') return;
  for (const m of human.meshes) { const mat = m.material as THREE.MeshStandardMaterial; mat.depthTest = false; m.renderOrder = 998; }
}
/** То же для вида костей модели: без этого кости тонут внутри скина и по ним не попасть мышью. */
function boneViewOnTop(): void {
  for (const m of boneView.meshes) { const mat = m.material as THREE.MeshStandardMaterial; mat.depthTest = false; m.renderOrder = 998; }
}

/** Ф12: перевести клипы персонажа в дельта-форму офсета таза. Зовётся тогда, когда rest-высота
 *  ИМЕННО ЭТОГО тела уже посчитана — именно этого контекста не было у чистой `migratePose`, из-за чего
 *  миграцию и откладывали. Чтение всё равно терпимое (`hipsOffset`), так что даже немигрированный клип играет верно. */
function normalizeHipsOfChar(charId: string): void {
  let changed = false;
  for (const c of library) if (c.character === charId && normalizeClipHips(c, human.hipsRest.y)) changed = true;
  if (changed) saveLib();
}
function applyChar(id: string): void {
  curCharId = id; const c = curChar(); weapon = c.weapon;
  loadPhys(id);                                               // физ-настройки (match) этого персонажа
  loadShieldMix(id);                                          // вес подмешивания щита этого персонажа
  loadTwistCfg(id);                                           // профиль скрутки корпуса (torso-lead) этого персонажа
  applyGaitCfg(id);                                            // свой настроенный бег у каждого персонажа
  if (human) { scene.remove(human.root); human.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  gizmo.detach(); selMesh = null; selected = null; activeKey = null; weaponGroups = [];
  human = stampRig(buildHumanoid({ ...rigRecipe(), style: manStyle() })); curHumanStyle = manStyle();   // Ф27: геометрия — только из рецепта
  normalizeHipsOfChar(id);   // Ф12: rest-высота ЭТОГО тела только что стала известна — переводим его клипы в дельту
  modelsTab.refreshProfile();   // Ф15.1: морф этого персонажа обязан уехать И в риг-источник, иначе меш не поедет за скелетом
  human.footLift = physFootLift;                              // подъём стопы персонажа (standY через measureStancePlants)
  scene.add(human.root); human.root.visible = manView !== 'hidden'; manikinOnTop(); applyAlpha();
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
  const pose = readPoseFull();
  scene.remove(human.root); human.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
  gizmo.detach(); selMesh = null; selected = null;
  human = stampRig(buildHumanoid({ ...rigRecipe(), style: manStyle() })); curHumanStyle = manStyle();   // Ф27: геометрия — только из рецепта
  human.footLift = physFootLift;                              // подъём стопы сохраняется при пересборке стиля манекена
  scene.add(human.root); human.root.visible = manView !== 'hidden'; manikinOnTop(); applyAlpha();
  applyPose(pose); if (ikOn) captureRig();   // оружие на физ-призраке — манекен-стиль его не трогает
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
const charSel = document.createElement('select'); charSel.onchange = () => { applyChar(charSel.value); refitPhysIfFitted(); };   // Ф26.5: у нового персонажа свои длины костей
const wpnSel = document.createElement('select');
for (const w of WEAPONS) { const o = document.createElement('option'); o.value = w; o.textContent = w; wpnSel.append(o); }
const offSel = document.createElement('select');   // офф-рука: нет / щит / второе оружие → ключ main+off
for (const o of OFFHANDS) { const op = document.createElement('option'); op.value = o; op.textContent = o === 'none' ? '—' : o; offSel.append(op); }
const composeWeapon = (): void => { const m = wpnSel.value, o = offSel.value; setWeapon(o === 'none' ? m : m + '+' + o); };
wpnSel.onchange = composeWeapon; offSel.onchange = composeWeapon;
let ikB!: HTMLButtonElement, gazeB!: HTMLButtonElement, hipsB!: HTMLButtonElement;
/**
 * ТУМБЛЕР ИНВЕРСНОЙ КИНЕМАТИКИ (Ф21.2). В отличие от старого `setMode` НИЧЕГО НЕ СБРАСЫВАЕТ:
 * выбор кости, подсветка и гизмо остаются на месте — меняется только то, решается ли цепь.
 * РУЧКА ТАЗА ОСТАЁТСЯ ВИДНОЙ всегда: таз — не IK, это корень персонажа, его двигают и в чистом FK.
 */
function setIk(on: boolean): void {
  ikOn = on;
  for (const e of effList()) { e.handle.visible = on; e.poleHandle.visible = on; }
  for (const k in shoulderHandles) shoulderHandles[k]!.visible = on;   // Ф26.3: плечи — такая же ручка, живёт с тумблером IK
  gazeHandle.visible = on || gazeOn; gazeLine.visible = gazeHandle.visible;   // голова видна и без кнопки 
  if (!on && (activeKey && activeKey !== 'hips' || activePole || activeShoulder)) { gizmo.detach(); activeKey = null; activePole = null; activeShoulder = null; }
  if (on) captureRig();
  ikB.textContent = on ? 'IK ●' : 'IK ○'; ikB.classList.toggle('on', on);
  ikB.title = on ? 'Инверсная кинематика ВКЛ: тянешь синюю/зелёную ручку — цепь решается' : 'Инверсная кинематика ВЫКЛ: чистый FK, ручки конечностей скрыты (таз остаётся)';
  refreshPose();
}
ikB = mkBtn('IK ●', () => setIk(!ikOn));
gazeB = mkBtn('👁 взгляд', () => setGaze(!gazeOn));
gazeB.title = 'Голова смотрит в точку-хелпер (белый шар перед лицом): взгляд держится вперёд, как бы ни скручивался корпус';
hipsB = mkBtn('таз: ' + (hipsMode === 'translate' ? 'двигать' : 'вращать'), () => { hipsMode = hipsMode === 'translate' ? 'rotate' : 'translate'; setPref('hipsMode', hipsMode); hipsB.textContent = 'таз: ' + (hipsMode === 'translate' ? 'двигать' : 'вращать'); if (activeKey === 'hips') { gizmo.setMode(hipsMode); if (hipsMode === 'rotate') rig.hipsHandle.quaternion.copy(rig.hipsQuat); } });
const physB = mkBtn('физ: выкл', () => { void ensurePhysics().then(() => setPhys(!physOn)); });
const modeB = mkBtn('', () => { uiPro = !uiPro; ui.pro = uiPro; saveUi(); syncModeB(); refreshAll(); });
function syncModeB(): void { modeB.textContent = uiPro ? '⚙ Про' : '○ Простой'; modeB.title = uiPro ? 'Про: все настройки (лимиты, моторы, физика, тюнинг походки)' : 'Простой: только позинг и клипы — инженерные панели скрыты (их значения действуют)'; modeB.classList.toggle('on', uiPro); }
const manB = mkBtn('манекен: скелет', () => { manView = manView === 'skel' ? 'solid' : manView === 'solid' ? 'hidden' : 'skel'; setPref('mannequin', manView); setManView(); });
/**
 * ИНСПЕКТОР СЛОЁВ — накладка поверх вьюпорта, а не вкладка.
 *
 * Вкладкой он был бы бесполезен: вопрос «почему персонаж выглядит так» возникает в тот момент, когда
 * ты крутишь ручку и смотришь на куклу, — то есть смотреть надо ОДНОВРЕМЕННО, а не переключаться.
 * Поэтому он виден на любой вкладке и не занимает колонку настроек.
 */
let traceView: LayerTraceView | null = null;
const traceHost = document.createElement('div');
traceHost.style.cssText = 'grid-area:2 / 1 / 3 / 2;align-self:end;justify-self:start;margin:0 0 10px 10px;z-index:6;pointer-events:none;display:none';
document.body.append(traceHost);
const traceB = mkBtn('◫ слои', () => {
  if (traceView) { traceView.dispose(); traceView = null; traceHost.style.display = 'none'; }
  else { traceView = createLayerTraceView(); traceHost.append(traceView.el); traceHost.style.display = 'block'; }
  setPref('layerTrace', !!traceView);
  traceB.classList.toggle('on', !!traceView);
});
traceB.title = 'Что играет сейчас и с каким весом: ноги, стойка, предметы в руках, слот действия. Видно на любой вкладке.';
if (getPref('layerTrace', false)) { traceView = createLayerTraceView(); traceHost.append(traceView.el); traceHost.style.display = 'block'; traceB.classList.add('on'); }
// Ф13.3/13.4: режим хвата и точка серверной позиции — ОБА видны всегда, без привязки к Про.
const gripB = mkBtn('✋ хват', () => cycleGrip());
gripB.title = 'Правка хвата: камера на кисть, кликабельны ТОЛЬКО фаланги. Клики: правая → левая → выкл.';
const posB = mkBtn('⌖ позиция', () => { posMarkOn = !posMarkOn; ui.posMark = posMarkOn; saveUi(); syncPosMark(); });
posB.title = 'Точка и круг коллизии, которые сервер считает позицией персонажа. Это НЕ таз: таз в кадре может быть смещён (выпад удара), и в игре точно так же.';
// Тумблер ростера: персонажи (классы) ↔ монстры. Переключает список выбора персонажа и грузит первого из ростера.
let personaB!: HTMLButtonElement;
personaB = mkBtn('◧ персонажи', () => {
  persona = persona === 'class' ? 'monster' : 'class';
  personaB.textContent = persona === 'class' ? '◧ персонажи' : '◧ монстры';
  personaB.classList.toggle('on', persona === 'monster');
  const first = rosterChars()[0];
  if (first) applyChar(first.id); else refreshAll();
});
/**
 * ПУБЛИКАЦИЯ (Ф12): рабочая копия живёт локально и не пропадает, на сервер уходит по этой кнопке.
 * Счётчик = сколько разделов правлено с прошлой публикации; «⟳ на сервере новее» = кто-то опередил.
 */
const pubBtn = createPublishButton({ extraDirty: () => configDirtyKeys(), publishExtra: () => publishConfigEdits() });

bar.append(personaB, document.createTextNode('Персонаж'), charSel, document.createTextNode('Оружие'), wpnSel, document.createTextNode('офф'), offSel, sep(), ikB, gazeB, hipsB, sep(),
  mkBtn('зеркало L→R', () => histPose('зеркало L→R', mirrorLR)), mkBtn('T-поза', () => histPose('T-поза', () => { human.reset(); if (ikOn) captureRig(); })), sep(),
  mkBtn('↶ undo', () => { history.undo(); }), mkBtn('↷ redo', () => { history.redo(); }), sep(), physB, manB, gripB, posB, traceB, sep(), pubBtn.el, modeB);

// ── Панель-вкладки (Анимация = клипы+кадры+поза; Бег = 2D бленд локомоции; Персонаж = setup) ──
// РЕЖИМ ИНТЕРФЕЙСА (Ф1.5). Не два разных UI, а один с прогрессивным раскрытием: «Про» ДОБАВЛЯЕТ инженерные
// панели (лимиты суставов, моторы, PHYS, тюнинг походки), ничего не переставляя. В Простом все эти
// настройки ПРОДОЛЖАЮТ действовать со своими значениями — просто не показываются.
let uiPro = ui.pro === true;
let posMarkOn = ui.posMark === true;

// ── Ф13.4: ТОЧКА ПОЗИЦИИ ПЕРСОНАЖА (та, что едет на сервер) ────────────────────────
// Сервер знает персонажа как ЦЕНТР КРУГА на полу (`PlayerView {x, y, r}`): по этому кругу решаются
// столкновения и дистанции боя. Высоты у него нет вообще. В редакторе `human.root` закреплён в начале
// координат и НИКОГДА не двигается (бег — тредмилл, едет пол), поэтому маркер статичен — и это не лень,
// а главное свойство: таз НАМЕРЕННО уезжает с этой точки (`__hipsD`, выпад удара), и в игре тоже.
// Визуальный язык — как у дебаг-слоя игры (`debug3d.circle`: плоское кольцо на y=2, без depth-теста).
const POS_COL = 0x39d0ff;
const posMat = (): THREE.LineBasicMaterial => new THREE.LineBasicMaterial({ color: POS_COL, depthTest: false, transparent: true, opacity: 0.85 });
const posRing = new THREE.LineLoop(new THREE.BufferGeometry(), posMat());
const posCross = new THREE.LineSegments(new THREE.BufferGeometry(), posMat());
const posMark = new THREE.Group();
posMark.add(posRing, posCross); posMark.position.y = 2; posMark.visible = false; scene.add(posMark);
for (const o of [posRing, posCross]) { o.renderOrder = 999; o.frustumCulled = false; }
let posMarkR = -1;
/** Радиус берём ИЗ SHARED, а не переписываем число — иначе кольцо разъедется с сервером на первом же тюне. */
const curRadius = (): number => (persona === 'monster' ? MONSTER_RADIUS : PLAYER_RADIUS);
function syncPosMark(): void {
  const r = curRadius();
  if (r !== posMarkR) {
    posMarkR = r;
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; ring.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
    posRing.geometry.dispose(); posRing.geometry = new THREE.BufferGeometry().setFromPoints(ring);
    const c = 2.5;
    posCross.geometry.dispose();
    posCross.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-c, 0, 0), new THREE.Vector3(c, 0, 0), new THREE.Vector3(0, 0, -c), new THREE.Vector3(0, 0, c),
    ]);
  }
  posMark.visible = posMarkOn;
  posB.textContent = posMarkOn ? `⌖ позиция r=${r}` : '⌖ позиция';
  posB.classList.toggle('on', posMarkOn);
}

// ── Ф13.3: РЕЖИМ ХВАТА ────────────────────────────────────────────────────────
/** Клики по кнопке: выкл → правая кисть → левая → выкл. */
function cycleGrip(): void {
  if (!gripMode) setGripMode(true, 'Right');
  else if (gripSide === 'Right') setGripMode(true, 'Left');
  else setGripMode(false);
}
function setGripMode(on: boolean, side?: 'Left' | 'Right'): void {
  const was = gripMode, hadFingers = wantFingers();
  gripMode = on; if (side) gripSide = side;
  if (on && !was) gripCamBack = { pos: camera.position.clone(), tgt: orbit.target.clone() };   // Ф21.1: режима больше нет, кости кликаются всегда
  // Пальцы могли уже стоять (модель/кнопка ✋) — пересобираем ТОЛЬКО когда набор костей реально меняется.
  if (wantFingers() !== hadFingers) { rebuildManikin(); if (pw) buildGhost(); disposeOnion(); }
  if (on) focusHand();
  else if (gripCamBack) { camera.position.copy(gripCamBack.pos); orbit.target.copy(gripCamBack.tgt); orbit.update(); gripCamBack = null; }
  syncGripB(); refreshAll();
}
function syncGripB(): void {
  gripB.textContent = gripMode ? `✋ хват: ${gripSide === 'Left' ? 'Л' : 'П'}` : '✋ хват';
  gripB.classList.toggle('on', gripMode);
}
/** Подлететь к кисти. НЕ `camFocus`: тот сохраняет дистанцию, а здесь нужно именно приблизиться. */
function focusHand(): void {
  const b = viewBone(gripSide + 'Hand'); if (!b) return;   // Ф20.2: камера летит к ВИДИМОЙ кисти
  const p = b.getWorldPosition(new THREE.Vector3());
  orbit.target.copy(p);
  camera.position.copy(p).add(new THREE.Vector3(gripSide === 'Left' ? 9 : -9, 4, 11));   // ~15u: кисть занимает больше половины кадра
  orbit.update();
}
let tab: 'anim' | 'loco' | 'turn' | 'char' | 'models' | 'ai' | 'graph' | 'test' = 'anim';
const tabBar = document.createElement('div'); tabBar.style.cssText = 'display:flex;gap:3px;margin-bottom:6px';
let body: HTMLElement = document.createElement('div');
const panelRoot = body;
panel.append(tabBar, body);
// ШИРИНА ПАНЕЛИ — тянется за левый край и помнится (Ф26.4): со свитками и списком клипов в 288px тесно.
{
  const grip = document.getElementById('panelgrip');
  const setW = (w: number): void => { document.body.style.setProperty('--panelw', Math.round(clamp(w, 240, 620)) + 'px'); };
  if (ui.panelW) setW(ui.panelW);
  grip?.addEventListener('pointerdown', (ev: PointerEvent) => {
    ev.preventDefault(); grip.setPointerCapture(ev.pointerId);
    const move = (m: PointerEvent): void => { const w = window.innerWidth - m.clientX; setW(w); ui.panelW = Math.round(clamp(w, 240, 620)); };
    const up = (): void => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); saveUi(); window.dispatchEvent(new Event('resize')); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
  });
}
const el = (t: string, css: string): HTMLElement => { const e = document.createElement(t); e.style.cssText = css; return e; };
/**
 * СВИТОК (Ф26.4) — сворачиваемый раздел, как в эдит-поли 3ds Max. Состояние живёт в `pe_ui.open`
 * и переживает перезагрузку. Внутри `draw()` цель аппенда (`body`) временно подменена на контейнер свитка —
 * поэтому весь старый код секций работает без правок. Прототип приёма — группы в дереве костей (Ф21).
 */
function rollout(key: string, title: string, draw: () => void, def = false): void {
  const open = (ui.open ??= {})[key] ?? def;
  const hdr = pbtn(`${open ? '▾' : '▸'} ${title}`, () => { (ui.open ??= {})[key] = !open; saveUi(); renderAnim(); }, open);
  hdr.style.cssText += ';width:100%;text-align:left;margin-top:5px';
  body.append(hdr);
  if (!open) return;
  const box = el('div', 'padding:1px 0 3px 5px;border-left:2px solid #2a3350;margin-left:2px');
  body.append(box);
  const outer = body; body = box;
  try { draw(); } finally { body = outer; }
}
const pbtn = (label: string, fn: () => void, on = false): HTMLButtonElement => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = `margin:2px 3px 2px 0;padding:3px 7px;background:${on ? '#3a5030' : '#2a3350'};color:#cfd3e0;border:1px solid #4a5680;border-radius:4px;cursor:pointer;font:11px monospace`; b.onclick = fn; return b; };
// Вкладка «Повороты» авто-включает превью бега (`renderTurn`: locoOn=true). При уходе на не-локо вкладку его НАДО
// выключить, иначе гейт продолжает вести манекен и перекрывает воспроизведение клипов («после Поворотов анимации не работают»).
//
// Ф26.1 — ПОРЯДОК ЗДЕСЬ РЕШАЕТ, и это была НАСТОЯЩАЯ причина «персонаж взлетел». Раньше `goFrame` звался ДО
// `tab = k`, а он внутри дёргает `refreshAll()` — то есть перерисовывал ЕЩЁ СТАРУЮ вкладку, а `renderTurn` снова
// ставил `locoOn = true`. Превью походки НИКОГДА не выключалось: гейт продолжал каждый кадр ставить таз
// в `30 + bobY` (`gaitToHumanoid`), а при авторской высоте таза ~40 это выглядит как «персонаж провалился/взлетел»
// (замер: таз 40.28 → 30.0, стопа 1.84 → −8.63 под полом).
const tabSwitch = (k: typeof tab): void => {
  const stop = locoOn && k !== 'turn' && k !== 'loco';
  tab = k;                                                   // СНАЧАЛА переключаем вкладку, ПОТОМ гасим превью — см. ниже
  if (stop) {
    locoOn = false; ghostGround.off = 0; goFrame(frameIdx);
    // ⚠⚠ ПЕРЕСНЯТЬ ТАЗ ПОСЛЕ ПРЕВЬЮ. Гейт двигает КОСТЬ таза каждый кадр (`30 + bobY`, боковое
    // качание `bobX`), а `rig.hipsPos` — ЖЕЛАНИЕ, куда тянут, — остаётся прежним. `goFrame` спасает
    // только когда есть выбранный клип: без него поза не восстанавливается вовсе, и расхождение
    // переживает возврат на вкладку. ЗАМЕР: после пробежки кость (−0.17, 30.7, 0) против ручки
    // (0, 32, 0) — 1.31 ед., и ручка так и висела сбоку, а драг считал дельту от мёртвого желания.
    const hp = human.bones.get('Hips')!;
    if (ikOn) captureRig();
    else { rig.hipsPos.copy(hp.position).sub(balanceOff); rig.hipsQuat.copy(hp.quaternion); }
  }
  refreshAll();
};
for (const [k, lbl] of [['anim', 'Анимация'], ['loco', 'Бег'], ['turn', 'Повороты'], ['graph', 'Граф'], ['test', '▶ Тест'], ['char', 'Персонаж'], ['models', 'Модели'], ['ai', 'ИИ']] as const) { const b = document.createElement('button'); b.textContent = lbl; b.style.cssText = 'flex:1;padding:4px;background:#20242f;color:#cfd3e0;border:1px solid #39415a;border-radius:4px;cursor:pointer;font:11px monospace'; b.onclick = () => tabSwitch(k); b.dataset.tab = k; tabBar.append(b); }
// Вкладка «Модели» (C5): импорт скинед-меша → live-ретаргет нашей позой → экспорт GLB + запись в конфиг.
// Ф15.1 + Ф20.1: риг-источник строится ТЕМ ЖЕ профилем И ТЕМ ЖЕ boneScale, что манекен —
// иначе кости модели стоят не там, где нарисованы кости редактора (колено расходилось на 2.37u).
const modelsTab = createModelsTab(scene, () => atlasProfile(), () => morphBoneScale());

function refreshAll(): void { for (const b of Array.from(tabBar.children) as HTMLButtonElement[]) b.style.background = b.dataset.tab === tab ? '#3a5030' : '#20242f'; charSel.innerHTML = ''; for (const c of rosterChars()) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; o.selected = c.id === curCharId; charSel.append(o); } { const [wm, wo] = splitWeapon(weapon); wpnSel.value = wm; offSel.value = wo; } if (tab === 'anim') renderAnim(); else if (tab === 'loco') renderLoco(); else if (tab === 'turn') renderTurn(); else if (tab === 'char') renderChar(); else if (tab === 'ai') renderAi(); else if (tab === 'graph') renderGraph(); else if (tab === 'test') renderTest(); else modelsTab.render(body); if (tab !== 'graph' && graphField) graphField.style.display = 'none'; syncTestTab(); refreshTimeline(); updateOnion(); updateTrajectory(); updateLimitGizmo(); syncPosMark(); }
function refreshPose(): void { if (tab === 'anim') renderAnim(); }
/** Пересчитать позу без перерисовки панели — для `oninput` ползунков (перерисовка отобрала бы у мыши захваченный бегунок). */
function refreshLive(): void { if (ikOn) solveRig(); }
function refreshLimbs(): void { if (tab === 'anim') renderAnim(); }

// Инструменты позы (аппендятся в общую панель «Анимация»; правка позы = правка текущего кадра)
const limbLabels: Record<string, string> = { LH: 'рука Л', RH: 'рука П', LF: 'нога Л', RF: 'нога П' };
function poseTools(): void {
  const info = el('div', 'color:#9ae6a0;margin:10px 0 4px;border-top:1px solid #39415a;padding-top:8px'); info.textContent = selected ? 'выбрано: ' + selected + '  (Shift — кольца)' : (activeKey || activePole ? 'ручка: ' + (activeKey ?? activePole) + '  (Shift — кольца кости)' : 'клик по кости, ручке или оружию'); body.append(info);
  const lh = el('div', 'color:#8fb7ff;font-weight:bold;margin:6px 0 2px'); lh.textContent = 'КОНЕЧНОСТИ IK/FK'; body.append(lh);
  const lr = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(lr);
  for (const k of ['LH', 'RH', 'LF', 'RF']) { const e = rig.eff[k]!; lr.append(pbtn(`${limbLabels[k]}: ${e.ik ? 'IK' : 'FK'}`, () => { e.ik = !e.ik; if (e.ik) syncEff(e); renderAnim(); }, e.ik)); }
  const ph = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); ph.textContent = 'ПИНЫ (закрепить точку)'; body.append(ph);
  { const hint = el('div', 'color:#6b7180;font-size:10px'); hint.textContent = solverMode === 'analytic' ? 'приколотое не двигается: крути таз — стопы стоят' : 'солвер: FABRIK (старый) — только для сравнения'; body.append(hint); }
  const pr = el('div', 'display:flex;flex-wrap:wrap;gap:6px'); body.append(pr);
  for (const [k, lb] of [['LH', 'кисть Л'], ['RH', 'кисть П'], ['LF', 'стопа Л'], ['RF', 'стопа П']] as const) { const lab = el('label', 'font-size:11px'); const cb = el('input', '') as HTMLInputElement; cb.type = 'checkbox'; cb.checked = rig.eff[k]!.pin; cb.onchange = () => { rig.eff[k]!.pin = cb.checked; }; lab.append(cb, document.createTextNode(lb)); pr.append(lab); }
  {   // СИЛА ПРИВЯЗКИ (Ф26.7): 1 — точка держится при любой манипуляции, меньше — пин поддаётся телу
    const row = el('label', 'display:flex;align-items:center;gap:6px');
    row.innerHTML = `<span style="flex:0 0 86px">сила привязки</span>`;
    const out = el('span', 'width:32px;text-align:right;color:#9ae6a0'); out.textContent = pinPower.toFixed(2);
    const r = el('input', 'flex:1') as HTMLInputElement; r.type = 'range'; r.min = '0'; r.max = '1'; r.step = '0.05'; r.value = String(pinPower);
    r.oninput = () => { pinPower = parseFloat(r.value); out.textContent = pinPower.toFixed(2); refreshLive(); };
    row.append(r, out); body.append(row);
  }
  // Reach R (Ф24.1): держать мировой угол конца или пустить его за цепью. Стопы — держат, кисти — нет.
  const rrh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); rrh.textContent = 'ДЕРЖАТЬ ПОВОРОТ КОНЦА (Reach R)'; body.append(rrh);
  { const hint = el('div', 'color:#6b7180;font-size:10px'); hint.textContent = 'выкл — кисть/стопа едет за цепью (естественно); вкл — держит мировой угол (оружие, подошва)'; body.append(hint); }
  const rr = el('div', 'display:flex;flex-wrap:wrap;gap:6px'); body.append(rr);
  for (const [k, lb] of [['LH', 'кисть Л'], ['RH', 'кисть П'], ['LF', 'стопа Л'], ['RF', 'стопа П']] as const) { const lab = el('label', 'font-size:11px'); const cb = el('input', '') as HTMLInputElement; cb.type = 'checkbox'; cb.checked = rig.eff[k]!.keepRot; cb.onchange = () => { const e = rig.eff[k]!; e.keepRot = cb.checked; if (e.keepRot) syncEff(e); }; lab.append(cb, document.createTextNode(lb)); rr.append(lab); }
  if (uiPro) body.append(pbtn(solverMode === 'analytic' ? 'солвер: аналитика' : 'солвер: FABRIK (старый)', () => { solverMode = solverMode === 'analytic' ? 'fabrik' : 'analytic'; setPref('solver', solverMode); renderAnim(); }, solverMode === 'analytic'));
  const rh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); rh.textContent = 'ТЕЛО ЗА РУКОЙ (замах)'; body.append(rh);
  const bf = el('input', 'width:100%') as HTMLInputElement; bf.type = 'range'; bf.min = '0'; bf.max = '1'; bf.step = '0.05'; bf.value = String(bodyFollow); bf.oninput = () => { bodyFollow = parseFloat(bf.value); }; body.append(bf);
  {   // Ф26.6 — Про: раздельно скрутка / прогиб / наклон + доля таза; в простом режиме всё ведёт один ползунок выше
    const grow = (label: string, get: () => number, set: (v: number) => void, max: number, fin?: () => void): void => {
      const row = el('label', 'display:flex;align-items:center;gap:6px');
      row.innerHTML = `<span style="flex:0 0 86px">${label}</span>`;
      const out = el('span', 'width:32px;text-align:right;color:#9ae6a0'); out.textContent = get().toFixed(2);
      const r = el('input', 'flex:1') as HTMLInputElement; r.type = 'range'; r.min = '0'; r.max = String(max); r.step = '0.05'; r.value = String(get());
      r.oninput = () => { set(parseFloat(r.value)); out.textContent = get().toFixed(2); refreshLive(); };
      if (fin) r.onchange = fin;
      row.append(r, out); body.append(row);
    };
    if (uiPro) {
      grow('скрутка', () => gTwist, (v) => { gTwist = v; }, 1.5);
      grow('прогиб', () => gPitch, (v) => { gPitch = v; }, 1.5);
      grow('наклон', () => gRoll, (v) => { gRoll = v; }, 1.5);
      grow('таз доворачивает', () => pelvisFollow, (v) => { pelvisFollow = v; }, 0.5);
    }
    const br = el('div', 'display:flex;flex-wrap:wrap;gap:3px;margin-top:3px'); body.append(br);
    br.append(pbtn(balanceOn ? 'баланс: вкл' : 'баланс: выкл', () => { balanceOn = !balanceOn; setPref('balance', balanceOn); refreshLive(); renderAnim(); }, balanceOn));
    if (uiPro) grow('перенос веса', () => weightShift, (v) => { weightShift = v; }, 1);
    const gh = el('div', 'color:#6b7180;font-size:10px;margin-top:4px'); gh.textContent = 'гибкость персонажа (доспех сковывает, акробат гибче)'; body.append(gh);
    grow('гибк. скрутка', () => flexTw, (v) => { flexTw = v; }, 2, saveFlex);
    grow('гибк. наклоны', () => flexBend, (v) => { flexBend = v; }, 2, saveFlex);
    grow('гибк. таз', () => flexPelvis, (v) => { flexPelvis = v; }, 2, saveFlex);
  }
  if (weaponGroups.length) {
    const wh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); wh.textContent = 'ОРУЖИЕ · ⟳ вращать / ✥ двигать (в кадр)'; body.append(wh);
    const wr = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(wr);
    const wlbl = ['осн', 'офф'];
    const pickWeapon = (g: THREE.Object3D, m: 'rotate' | 'translate'): void => { fkProxyBone = null; selected = null; highlight(null); gizmo.setSpace('local'); gizmo.setMode(m); gizmo.attach(g); };
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
      if (on) { const pickGrip = (m: 'rotate' | 'translate'): void => { const mk = ensureLgripMark(); if (!mk) return; fkProxyBone = null; selected = null; highlight(null); mk.visible = true; gizmo.setSpace('local'); gizmo.setMode(m); gizmo.attach(mk); }; gr.append(pbtn('хват ✥', () => pickGrip('translate')), pbtn('хват ⟳', () => pickGrip('rotate'))); }
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
  rollout('physrig', 'НАБОР ФИЗ-ТЕЛ (пересборка)', physRigSection);
  rollout('physsize', 'РАЗМЕРЫ ФИЗ-ТЕЛ', physSizeSection);
  // ★ = per-frame (в позе кадра); 0 = физика, 1 = ровно твоя поза
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
    pbtn(showLimits ? 'гизмо предела: вкл' : 'гизмо предела: выкл', () => { showLimits = !showLimits; setPref('limitGizmo', showLimits); renderAnim(); }, showLimits),
    pbtn(clampFk ? 'клэмп FK: вкл' : 'клэмп FK: выкл', () => { clampFk = !clampFk; setPref('clampFk', clampFk); renderAnim(); }, clampFk),
    // ДВЕ СИСТЕМЫ СУСТАВОВ РЯДОМ, чтобы сравнить живьём и лишнюю выкинуть (см. jointLimitV2.ts):
    //   v2 (FinalIK) — кость едет за кольцом свободно, предел только останавливает;
    //   v1 (скаляры) — кольцо правит скаляр, кватернион пересобирается.
    pbtn(limitVersion() === 2 ? 'суставы: v2 FinalIK' : 'суставы: v1 скаляры', () => {
      setLimitVersion(limitVersion() === 2 ? 1 : 2);
      if (fkProxyBone) attachBoneGizmo(fkProxyBone);   // кольца живут в разных фреймах → пере-прицепить
      renderAnim();
    }, limitVersion() === 2),
    pbtn(footGround ? 'заземл. стоп: вкл' : 'заземл. стоп: выкл', () => { footGround = !footGround; setPref('groundFeet', footGround); renderAnim(); }, footGround),
    pbtn(manGroundView ? 'манекен на полу: вкл' : 'манекен на полу: выкл', () => { manGroundView = !manGroundView; setPref('floorMannequin', manGroundView); renderAnim(); }, manGroundView),
    pbtn(snapOn ? 'шаг (S): вкл' : 'шаг (S): выкл', () => { snapOn = !snapOn; setPref('snap', snapOn); applySnap(); renderAnim(); }, snapOn),
  );
  {   // ШАГ ГИЗМО: своё число на перемещение и на поворот. Shift во время драга снап временно снимает.
    const srow = el('div', 'display:flex;align-items:center;gap:6px;margin-top:3px;font-size:10px');
    const num = (label: string, get: () => number, set: (v: number) => void, step: number, max: number): void => {
      const w = el('label', 'display:flex;align-items:center;gap:3px;color:#9aa3b8'); w.append(label);
      const i = el('input', `width:56px;background:#0e1016;color:${snapOn ? '#cfd3e0' : '#6b7180'};border:1px solid #39415a;border-radius:3px;font:10px monospace;text-align:right`) as HTMLInputElement;
      i.type = 'number'; i.min = '0'; i.max = String(max); i.step = String(step); i.value = String(get());
      i.oninput = () => { const v = parseFloat(i.value); if (!Number.isFinite(v)) return; set(Math.max(0, Math.min(max, v))); applySnap(); };
      w.append(i); srow.append(w);
    };
    num('перемещение, ед', () => snapMove, (v) => { snapMove = v; setPref('snapMove', v); }, 0.1, 50);
    num('поворот, °', () => snapRot, (v) => { snapRot = v; setPref('snapRot', v); }, 0.5, 90);
    const h = el('span', 'color:#6b7180'); h.textContent = snapOn ? '0 = без шага по этой оси · Shift снимает' : 'шаг выключен';
    srow.append(h);
    body.append(srow);
  }
  {   // Ф26.2 — ПРОЗРАЧНОСТЬ: скелет перестаёт забивать меш (жалоба «слишком активный»), ручки не рябят
    const arow = (label: string, get: () => number, set: (v: number) => void): void => {
      const row = el('label', 'display:flex;align-items:center;gap:6px');
      row.innerHTML = `<span style="flex:0 0 72px;color:#9ae6a0">${label}</span>`;
      const out = el('span', 'width:32px;text-align:right;color:#cfd3e0'); out.textContent = get().toFixed(2);
      const r = el('input', 'flex:1') as HTMLInputElement; r.type = 'range'; r.min = '0.15'; r.max = '1'; r.step = '0.05'; r.value = String(get());
      r.oninput = () => { set(parseFloat(r.value)); out.textContent = get().toFixed(2); applyAlpha(); };
      r.onchange = () => { ui.aSkel = aSkel; ui.aHandle = aHandle; saveUi(); };
      row.append(r, out); body.append(row);
    };
    const ah = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); ah.textContent = 'ПРОЗРАЧНОСТЬ'; body.append(ah);
    arow('скелет', () => aSkel, (v) => { aSkel = v; });
    arow('хелперы', () => aHandle, (v) => { aHandle = v; });
  }
  {   // Ф27.2 — РАСХОЖДЕНИЕ РИГОВ числом, а не по скриншоту. «призрак↔меш» обязано быть 0.00u ВСЕГДА;
      // «манекен↔призрак» — честная разница заземления и физ-бленда по `match` (то, что увидит игра).
    const d = rigDelta();
    const row = el('div', 'font-size:10px;margin-top:3px');
    row.innerHTML = '<span style="color:#6b7180">расхождение</span> '
      + '<span style="color:' + (d.pose > 0.05 ? '#e6a05a' : '#6b7180') + '">манекен↔призрак ' + d.ghost.toFixed(2) + 'u (заземл. ' + d.ground.toFixed(2) + ' · поза ' + d.pose.toFixed(2) + ')</span> · '
      + (d.mesh === null ? '<span style="color:#6b7180">призрак↔меш: модель не загружена</span>'
        : '<span style="color:' + (d.mesh > 0.05 ? '#ff6b6b' : '#9ae6a0') + '">призрак↔меш ' + d.mesh.toFixed(2) + 'u (' + d.bones + ' костей)</span>');
    body.append(row);
  }
  // Офсет заземления стоп (per-персонаж, pe_phys.footLift): цель foot-IK = пол + SOLE + офсет. + поднять (стопы тонут под пол),
  // − опустить (парят над полом). Живо, per-персонаж, держится после бега. Тот же офсет читает игра (loadFootLift).
  {
    // ⚠ ПОЛЗУНОК — ФОЛБЭК, А НЕ ГЛАВНАЯ РУЧКА. Все пять читателей берут `mesh.ankleRest ?? (SOLE + footLift)`
    // — это `??`, а не сумма: как только риг собран по модели (есть `boneOffsets`), `ankleRest` ЗАТЕНЯЕТ и
    // `SOLE`, и офсет целиком. Раньше строка об этом молчала, и ползунок выглядел сломанным.
    const rigFloor = (ghostHuman ?? human).ankleRest;
    const row = el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px');
    row.innerHTML = `<span style="flex:1;color:${rigFloor === null ? '#9ae6a0' : '#6b7180'}">офсет заземл. стоп (± под/над пол)${rigFloor === null ? '' : ' — НЕ ДЕЙСТВУЕТ'}</span>`;
    const s = el('input', 'width:120px') as HTMLInputElement; s.type = 'range'; s.min = '-4'; s.max = '8'; s.step = '0.1'; s.value = String(physFootLift);
    const v = el('span', 'width:44px;text-align:right;color:#9ae6a0'); v.textContent = physFootLift.toFixed(1);
    s.oninput = () => {
      physFootLift = parseFloat(s.value); v.textContent = physFootLift.toFixed(1);
      human.footLift = physFootLift; if (ghostHuman) ghostHuman.footLift = physFootLift;
      stanceMeasuredFor = '';   // пере-замерить стойку под новый офсет (без __hipsP — фолбэк-высота; с __hipsP не трогает стойку)
      saveFootLift(); renderAnim();
    };
    row.append(s, v); body.append(row);
    // ЗАМЕР вместо подбора глазами. Кнопка, а не молчаливая автоподстановка при каждом открытии:
    // офсет мог быть доведён руками, и затирать чужую правку замером — хуже, чем не замерять.
    const mrow = el('div', 'display:flex;align-items:center;gap:6px;margin-top:2px;font-size:10px');
    mrow.append(pbtn('замерить по модели', () => {
      const m = measureSoleOffset();
      if (m === null) { alert('Модель не загружена или вершин стопы не нашлось — офсет оставлен как есть.'); return; }
      physFootLift = +m.toFixed(2);
      human.footLift = physFootLift; if (ghostHuman) ghostHuman.footLift = physFootLift;
      stanceMeasuredFor = ''; saveFootLift(); renderAnim();
    }));
    const mh = el('span', 'color:#6b7180');
    const got = soleShown; mh.textContent = got === null ? 'считается по подошве меша, а не по низу модели' : `замер даёт ${got.toFixed(2)}`;
    mrow.append(mh); body.append(mrow);
    // ОТКУДА ВЗЯТ ПОЛ НА САМОМ ДЕЛЕ. Без этой строки «ползунок 1.4 / замер даёт 2.57» читается как
    // поломка, хотя оба числа просто не участвуют: пол берёт риг.
    if (rigFloor !== null) {
      const rr = el('div', 'font-size:10px;margin-top:1px;color:#8fb3d9');
      rr.textContent = `пол лодыжки берётся ИЗ РИГА: ankleRest = ${rigFloor.toFixed(3)} (замер рест-позы модели). Офсет выше — фолбэк для ригов без замера.`;
      body.append(rr);
    }
    // ⭐ ГЛАВНОЕ ЧИСЛО: стоит ли он НА ПОЛУ. Всё остальное в этом блоке — средства, а это результат.
    {
      const now = soleHeightNow();
      const r2 = el('div', 'font-size:10px;margin-top:1px');
      if (now === null) { r2.style.color = '#6b7180'; r2.textContent = 'подошва: модель не загружена'; }
      else {
        const ok = Math.abs(now) < 0.25;
        r2.style.color = ok ? '#9ae6a0' : '#e0a05a';
        r2.textContent = `подошва сейчас: ${now >= 0 ? '+' : ''}${now.toFixed(2)} `
          + (ok ? '— на полу' : now > 0 ? '— ПАРИТ над полом' : '— ТОНЕТ под полом');
      }
      body.append(r2);
    }
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
  );
  if (uiPro) phb.append(
    pbtn('дёрг (удар)', () => { void ensurePhysics().then(() => { setPhys(true); if (ragdoll) { ragdoll.hit('Torso', 0, 0.3, 1, 1.4); ragdoll.hit('Head', 0, 0.3, 1, 0.8); } }); }),
    pbtn(physDead ? 'встать' : 'упасть', () => { void ensurePhysics().then(() => { setPhys(true); if (!ragdoll) return; if (physDead) { const h = ragdoll.bodyPos('Hips'); reviveFrom.set(h[0], h[1], h[2]); reviveT = 0; ragdoll.setDead(false); physDead = false; } else { ragdoll.setDead(true); physDead = true; reviveT = -1; } renderAnim(); }); }, physDead),
  );
  rollout('poses', 'ПОЗЫ И БУФЕР', poseLibSection);
  rollout('grip', 'ХВАТ КИСТИ', gripSection);
  rollout('bones', 'КОСТИ (FK)', boneTreeSection);
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
    pbtn('↺ перевернуть позу', () => histPose('перевернуть позу', () => { applyPose(flipPoseSides(readPoseFull())); if (ikOn) captureRig(); })),
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
    // ⭐⭐ ЗАЖАТЬ ТЕКУЩИЙ КЛИП ПРЕДЕЛАМИ СУСТАВОВ — то же, что делает импорт, но для УЖЕ загруженного.
    //
    // Кламп живёт на импорте, и это правильное место для новых клипов; но старые (например `hit_sword_r_01`
    // с шеей −52° при пределе головы ±40°) переимпортировать ради этого — лишняя работа, а иногда и
    // невозможная: исходного FBX может уже не быть.
    //
    // ⚠ ЧАСТИ ТЕ ЖЕ И ВЫБИРАЮТСЯ ТАК ЖЕ, как в панели импорта: предел настроен под физику и ручной
    // позинг, и на руках-ногах он вполне может испортить мокап. Умолчание — только голова.
    {
      const cr = el('div', 'display:flex;flex-wrap:wrap;align-items:center;margin-top:3px'); body.append(cr);
      const cap = el('span', 'font-size:10px;color:#9aa3b8;margin-right:4px'); cap.textContent = 'зажать пределами:'; cr.append(cap);
      const note = el('div', 'font-size:10px;color:#6b7180;margin-top:2px');
      const redraw = (): void => { refreshAll(); };   // кнопки-тумблеры перерисовываются вместе с панелью
      for (const mp of MASK_PARTS) {
        cr.append(pbtn(mp.label, () => { clampSel = clampSel.includes(mp.id) ? clampSel.filter((x) => x !== mp.id) : [...clampSel, mp.id]; redraw(); }, clampSel.includes(mp.id)));
      }
      cr.append(pbtn('⊓ применить к клипу', () => {
        const c = curClip(); if (!c) { clampNote = 'клип не выбран'; note.textContent = clampNote; return; }
        // ⚠ Через историю: правка молча меняет авторскую работу, откат обязан быть в одно нажатие.
        histLib('зажать пределами', () => {
          clampNote = clampSummary(clampClip(c, clampSel, limitViewForBone));
          note.textContent = clampNote;
          saveLib(); goFrame(frameIdx);
        });
      }));
      body.append(note);
      if (clampNote) note.textContent = clampNote;   // отчёт переживает перерисовку панели
    }
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
  const bind = gripBind();
  const eff = gripNow();
  {
    // ⚠ ВИДНО, НА ЧТО ПИШЕМ. Молчаливый уровень — ровно то, из-за чего хват «применялся ко всему».
    const nm = gripClipName();
    const sc = el('div', 'display:flex;align-items:center;gap:5px;margin:2px 0 4px'); body.append(sc);
    sc.append(pbtn(nm ? `правим хват КЛИПА «${nm}»` : `правим хват ОРУЖИЯ «${weapon}» (общая база)`,
      () => { gripScope = gripScope === 'clip' ? 'weapon' : 'clip'; renderAnim(); }, gripScope === 'clip'));
    const hint = el('div', 'color:#7a869e;font-size:10px;margin-bottom:4px');
    hint.textContent = nm
      ? 'клип перекрывает оружие по полям; не тронутое поле берётся с уровня оружия'
      : 'общая база для всех клипов этого оружия — клипы могут перекрыть её каждый своим';
    body.append(hint);
  }
  const hand = (side: 'L' | 'R', label: string): void => {
    // Ф17: СПИСКА ПРЕСЕТОВ НЕТ. Хват выводится из ключа оружия (`defaultWeaponGrip`), потому что
    // редактор и так знает, что в руках. Список был не просто лишним: открытие панели ЗАМОРАЖИВАЛО
    // текущий выбор в конфиг, и дальше смена оружия хват уже не меняла.
    const row = el('div', 'display:flex;align-items:baseline;gap:5px;margin-top:3px'); body.append(row);
    const lb = el('span', 'width:52px;font-size:11px'); lb.textContent = label; row.append(lb);
    const id = (side === 'L' ? eff.L : eff.R) ?? 'open';
    const openId = side === 'L' ? eff.openL : eff.openR;
    const ownFist = !!gripCfg.custom[id], ownOpen = !!(openId && gripCfg.custom[openId]);
    const nm2 = el('span', `flex:1;font-size:11px;color:${ownFist || ownOpen ? '#c8b06a' : '#9ae6a0'}`);
    nm2.textContent = ownFist || ownOpen
      ? `свои: ${ownOpen ? '✅ ладонь' : 'ладонь авто'} · ${ownFist ? '✅ кулак' : 'кулак авто'}`
      : (findGrip(id)?.label ?? id) + ' — по оружию';
    row.append(nm2);
    // Ф16: слайдер «раскрытая ладонь ↔ хват» — своя строка с подписями концов и числом.
    // Раньше это был безымянный ползунок в 70px, и его смысл (а на нуле теперь ВЫПРЯМЛЕНИЕ, а не
    // бинд модели) прочитать было неоткуда.
    const row2 = el('div', 'display:flex;align-items:center;gap:5px;margin:0 0 3px 56px'); body.append(row2);
    const cap = (t: string): HTMLElement => { const e = el('span', 'font-size:10px;color:#8a90a0;white-space:nowrap'); e.textContent = t; return e; };
    const num = el('span', 'font-size:10px;color:#cfd6e6;width:26px;text-align:right;font-variant-numeric:tabular-nums');
    const sl = el('input', 'flex:1;min-width:60px') as HTMLInputElement;
    sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.05';
    sl.value = String(side === 'L' ? eff.closeL : eff.closeR);
    sl.title = '0 = ладонь принудительно выпрямлена (бинд-сгиб модели вычтен), 1 = хват как в пресете';
    const show = (): void => { num.textContent = Math.round(parseFloat(sl.value) * 100) + '%'; };
    show();
    sl.oninput = () => { const v = parseFloat(sl.value); if (side === 'L') bind.closeL = v; else bind.closeR = v; show(); applyGripOver(curClip()?.keys[frameIdx]?.pose); };
    sl.onchange = () => saveGrips();
    row2.append(cap('ладонь'), sl, cap('хват'), num);
    // Ф18: КОНЦЫ СЛАЙДЕРА СНИМАЮТСЯ С ЖИВОЙ КИСТИ. Выставил пальцы руками (FK, режим ✦ хват) —
    // нажал соответствующую кнопку. Снятый конец воспроизводится бит-в-бит, без каких-либо поправок.
    const row3 = el('div', 'display:flex;gap:3px;margin:0 0 5px 56px'); body.append(row3);
    const S = side === 'L' ? 'Left' : 'Right';
    row3.append(
      pbtn('✋ снять ладонь', () => saveHandEnd(S, 'open'), ownOpen),
      pbtn('✊ снять кулак', () => saveHandEnd(S, 'fist'), ownFist),
      pbtn('✕ авто', () => resetHandEnds(S)),
    );
  };
  {
    // Фаланги кликаются по ВИДИМОМУ ригу: с атласом это кости МОДЕЛИ, и если в её карте костей
    // пальцев нет, нажимать физически не по чему. Молчать про это нельзя — снаружи неотличимо от поломки.
    const pickableFingers = boneMeshes().filter((m) => isHandBone(m.userData.bone as string | undefined ?? '')).length;
    const t = el('div', `color:${pickableFingers ? '#6b7180' : '#e0a05a'};font-size:10px;margin:1px 0 2px`);
    t.textContent = pickableFingers
      ? 'крути фаланги FK и снимай концы — слайдер пойдёт между ними'
      : '⚠ фаланг на видимом скелете нет — кликать нечего. У модели не размечены кости пальцев (переимпортируй атлас) либо выключен вид костей.';
    body.append(t);
  }
  hand('R', 'правая'); hand('L', 'левая');
  // Насколько кисти пришли поджатыми. Хват это выпрямляет молча, но цифра объясняет, почему кисть
  // в модели и кисть в редакторе выглядят по-разному — и что Л с П в модели РАЗНЫЕ (у CC так всегда).
  {
    const ax = fingerAxes();
    const l = bindCurlReport('Left', ax), r = bindCurlReport('Right', ax);
    const d = el('div', 'color:#6b7180;font-size:10px;margin-top:2px');
    d.textContent = (l.max < 1 && r.max < 1)
      ? 'бинд-кисть модели прямая — выпрямлять нечего'
      : `бинд модели поджат: Л ${l.avg.toFixed(0)}° (макс ${l.max.toFixed(0)}°), П ${r.avg.toFixed(0)}° (макс ${r.max.toFixed(0)}°) — вычитается из хвата`;
    body.append(d);
  }
  if (uiPro) {
    const row = el('div', 'margin-top:3px'); body.append(row);
    row.append(
      pbtn('⇄ зеркало П→Л', () => histPose('зеркало хвата', () => {
        // Ф16: зеркало живёт в `gripPoses.mirrorHandPose` — кроме канон-знаков `[x, −y, −z]` оно добавляет
        // разницу бинд-избытков: у модели кисти поджаты ПО-РАЗНОМУ, и голое зеркало углов давало бы
        // левую кисть с другим абсолютным сгибом (на knight_05 — на 8° в MCP указательного).
        const src: Pose = {};
        for (const nmb of human.boneNames) if (isHandBone(nmb) && nmb.startsWith('Right')) { const r = human.bones.get(nmb)!.rotation; src[nmb] = [r.x, r.y, r.z]; }
        applyGripPose(human.bones, mirrorHandPose(src, 'Right', fingerAxes()));
      })),
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
    b.onclick = () => { selected = nm; highlight(boneMeshes().find((x) => x.userData.bone === nm) ?? null); attachBoneGizmo(nm); renderAnim(); };
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
// РУЧНЫЕ КАРТЫ КОСТЕЙ ПО СИГНАТУРЕ РИГА: правишь карту один раз — следующий файл того же пакета
// (Mixamo/CC выгоняют все клипы одним скелетом) подхватывает её сам.
let boneMaps: Record<string, Record<string, string>> = (() => { try { return JSON.parse(localStorage.getItem('pe_bonemaps') ?? '{}') as Record<string, Record<string, string>>; } catch { return {}; } })();
function saveBoneMaps(): void { try { localStorage.setItem('pe_bonemaps', JSON.stringify(boneMaps)); savePoseKey('pe_bonemaps'); } catch { /* */ } }

/** Превью импорта живёт в библиотеке под зарезервированным именем: так оно бесплатно получает скраб,
 *  таймлайн и физ-призрака. `saveLib` это имя фильтрует, поэтому превью физически не попадает ни в
 *  localStorage, ни на сервер. */
const IMPORT_PREVIEW = '__import_preview';
let importPanel: ImportPanel | null = null;

/** Показать/убрать превью-клип импорта (колбэк панели). */
/** Куда вернуть выбор, когда превью убрано (импорт отменили или приняли). */
let importPrevSel: { clip: number; frame: number } | null = null;
function setImportPreview(c: Clip | null): void {
  const i = library.findIndex((x) => x.name === IMPORT_PREVIEW);
  if (i >= 0) library.splice(i, 1);
  if (c) {
    if (!importPrevSel) importPrevSel = { clip: clipIdx, frame: frameIdx };
    // `loop: true` НАСИЛЬНО: превью надо СМОТРЕТЬ в цикле, а не ловить один прогон. Это выброшенная копия —
    // в библиотеку уходит `last.clip` из панели, у него свой честный флаг цикла.
    putClip({ ...c, name: IMPORT_PREVIEW, character: curCharId, weapon, loop: true }, 'replace');
    clipIdx = clipsHere().findIndex((x) => x.name === IMPORT_PREVIEW);
    frameIdx = 0;
    // ⚠ Превью бега ГЛУШИТ проигрывание клипа: в цикле кадра стоит `if (locoOn) stepGait(...) else if (playing)`.
    // Если его не снять, галки в панели переключаются, а в вьюпорте по-прежнему бежит гейт — «не видно анимации».
    if (locoOn) { locoOn = false; }
    // САМО ПРОИГРЫВАНИЕ — главное, ради чего превью существует: без него клип стоит на первом кадре
    // и «все настройки есть, а на что они влияют — не видно».
    playT = 0; playing = true; playBtn.textContent = '⏸';
    refreshAll();
    preview(playT);
  } else {
    playing = false; playBtn.textContent = '▶';
    if (importPrevSel) { clipIdx = importPrevSel.clip; frameIdx = importPrevSel.frame; importPrevSel = null; }
    clipIdx = Math.min(clipIdx, Math.max(0, clipsHere().length - 1));
    frameIdx = Math.min(frameIdx, Math.max(0, (curClip()?.keys.length ?? 1) - 1));
    refreshAll();
    goFrame(frameIdx);
  }
}

/** Позы-кандидаты в базовый слой: обычная стойка, боевая стойка, любой клип этого оружия (его первый кадр). */
function importBasePoses(): { id: string; label: string; pose: Pose }[] {
  const out: { id: string; label: string; pose: Pose }[] = [];
  const relaxed = resolveUpper(weapon, 0)?.pose, combat = resolveUpper(weapon, 1)?.pose;
  if (relaxed) out.push({ id: 'idle', label: 'обычная стойка (idle)', pose: relaxed });
  if (combat) out.push({ id: 'combat', label: 'боевая стойка (combat_idle)', pose: combat });
  for (const c of clipsHere()) {
    const k = c.keys[0]; if (!k || c.name === IMPORT_PREVIEW) continue;
    out.push({ id: 'clip:' + c.name, label: 'клип «' + c.name + '» (кадр 1)', pose: k.pose });
  }
  return out;
}

async function showImportPanel(file: File): Promise<void> {
  const { openClipImportPanel } = await import('./clipImportPanel.js');
  importPanel?.close();
  camFocus(human.hips);   // камера на персонажа: настраивать импорт, не видя фигуры, бессмысленно
  importPanel = openClipImportPanel(file, {
    title: `${curChar().name} \u00b7 ${weapon}`,
    basePoses: importBasePoses,
    preview: setImportPreview,
    togglePlay: () => { playBtn.click(); },
    isPlaying: () => playing,
    loadBoneMap: (sig) => boneMaps[sig],
    saveBoneMap: (sig, map) => { boneMaps[sig] = map; saveBoneMaps(); },
    commit: (clip) => {
      histLib('импорт анимации', () => {
        clip.name = (clip.name || 'anim').replace(/[^\w\u0430-\u044f\u0410-\u042f0-9:+._-]/g, '_');
        clip.character = curCharId; clip.weapon = weapon;
        if (clip.idleEnds) syncAttackEnds(clip);   // концы = актуальная стойка (единый источник), дальше синкаются при правке стойки
        putClip(clip, 'rename'); saveLib();        // импорт НИКОГДА не затирает — встаёт рядом под свободным именем
        clipIdx = clipsHere().findIndex((x) => x.name === clip.name); frameIdx = 0; refreshAll();
      });
    },
  });
}

/**
 * Ф11: НАБОР ФИЗ-ТЕЛ — настройка, а не запрет.
 * В поз-плеере на экране ВСЕГДА один персонаж, а результат всё равно запекается в клип — значит физика
 * здесь инструмент авторинга, и её объём — выбор автора. Стоимость показываем честно (тела + замер шага).
 */
/**
 * КОНЦЫ ФИЗ-ТЕЛА ПО КОСТЯМ (Ф26.5). Цепь ретаргета тела (`chain`) даёт начало; конец — среднее по ДЕТЯМ
 * последней кости цепи (у кисти это середина оснований пальцев = конец ладони). Нет детей (голова, носок) —
 * продлеваем от родителя на текущую длину тела.
 *
 * ЗАМЕР ИДЁТ В Т-ПОЗЕ, а не в текущей: анкеры физ-рига заданы именно в рест-фрейме (там же живут
 * оси суставов и рест-трансляции констрейнтов). А вот ДЛИНЫ в Т-позе уже с морфом и профилем атласа —
 * именно поэтому после авто-подгонки тела едут за телосложением.
 */
function fitPhysToBones(): void {
  const snap = new Map<string, THREE.Quaternion>();
  for (const [n, b] of human.bones) snap.set(n, b.quaternion.clone());
  const hp = human.hips.position.clone();
  human.reset(); human.root.updateMatrixWorld(true);                     // → Т-поза с текущими длинами костей
  try {
    const v3 = (w: THREE.Vector3): [number, number, number] => [+w.x.toFixed(2), +w.y.toFixed(2), +w.z.toFixed(2)];
    const leaves: { ov: PhysSize; tip: THREE.Vector3; dir: THREE.Vector3; cat: number }[] = [];
    const ratios: number[] = [];
    // ПРОХОД 1 — тела, у которых конец цепи ИМЕЕТ детей: длина честно снимается со скелета.
    for (const pb of physBodies()) {
      const chain = pb.chain.length ? pb.chain : [pb.name];
      const first = human.bones.get(chain[0]!); if (!first) continue;
      const last = human.bones.get(chain[chain.length - 1]!) ?? first;
      const a = first.getWorldPosition(V());
      const ov = (PHYS_SIZES[pb.name] ??= {});
      // АНКЕР ПИШЕМ ВСЕГДА, даже у таза с вырожденной длиной: рест-трансляции констрейнтов считаются
      // КАК РАЗНИЦА АНКЕРОВ (`anchor − parentAnchor`), и пропущенный родитель сдвинул бы ВСЮ цепь на свою
      // ошибку (замер: таз оставался каталожным на 6.7u ниже кости — кукла дралась бы сама с собой).
      ov.anchor = v3(a);
      const co = physCatalogOff(pb.name);
      const cat = co ? Math.hypot(co[0], co[1], co[2]) : 0;
      const kids = (last.children as THREE.Object3D[]).filter((c) => human.bones.get(c.name) === c);
      // СТУПИЦА (таз): в каталоге выноса нет, а среднее по детям вырождено — ноги идут вниз, спина вверх,
      // и они гасят друг друга (замер: половина 0.35u → таз становился блином 0.35u толщиной).
      // Такому телу скелет длины НЕ ДАЁТ ВООБЩЕ — чистим прежнюю и оставляем каталожную форму.
      if (cat < 0.3) { delete ov.off; delete ov.len; continue; }
      if (!kids.length) {                       // лист (голова/кисть/носок) — во второй проход
        const par = last.parent ? last.parent.getWorldPosition(V()) : a.clone();
        const dir = last.getWorldPosition(V()).sub(par);
        leaves.push({ ov, tip: last.getWorldPosition(V()), dir: dir.lengthSq() > 1e-6 ? dir.normalize() : V().set(0, 1, 0), cat });
        continue;
      }
      // ДЕТИ БЕРУТСЯ НЕ ВСЕ, А ТОЛЬКО ПРОДОЛЖАЮЩИЕ ОСЬ ТЕЛА (Ф28.1). Среднее по ВСЕМ детям верно там, где они
      // расходятся веером вокруг оси (кисть → пять пальцев), и неверно там, где ребёнок уходит ПОПЕРЁК:
      // у `UpperChest` дети — шея (вверх) и две ключицы (вбок), и среднее валило тело на 20.9° и укорачивало
      // его с 5.6u до 4.2u. Критерий — каталожное направление тела: оно и есть авторская ось.
      const axis = V().set(co![0], co![1], co![2]).normalize();
      const along = kids.filter((k) => k.getWorldPosition(V()).sub(a).normalize().dot(axis) > 0.75);   // 0.5 МАЛО: ключица поднимается 2.8u при выносе 4u, дот ровно 0.50 и она проходила
      const use = along.length ? along : kids;                      // никто не совпал — ведём себя как раньше
      const b2 = V(); for (const k of use) b2.add(k.getWorldPosition(V())); b2.multiplyScalar(1 / use.length);
      const half = b2.sub(a).multiplyScalar(0.5);
      if (half.length() < 0.3) { delete ov.off; delete ov.len; continue; }
      ov.off = v3(half); ov.len = +half.length().toFixed(2);
      ratios.push(half.length() / cat);
    }
    // ПРОХОД 2 — ЛИСТЬЯ. У последней кости нет детей, то есть СКЕЛЕТ ДЛИНЫ НЕ СОДЕРЖИТ. Раньше её брали
    // как `|pb.off| * 2` — из ТЕКУЩЕГО тела, которое само же и подогнано: замер кормился своим выходом и
    // голова росла на 2.45u за каждую переподгонку (4 → 57.11u, шар улетал над персонажем).
    // Теперь длина = КАТАЛОЖНАЯ, масштабированная МЕДИАНОЙ отношений «замер / каталог» по измеримым телам
    // (то есть ростом текущего телосложения). Операция идемпотентна: второй прогон даёт те же числа.
    ratios.sort((x, y) => x - y);
    const s = ratios.length ? ratios[ratios.length >> 1]! : 1;
    for (const lf of leaves) {
      const half = lf.dir.multiplyScalar(lf.cat * s);
      lf.ov.off = v3(half); lf.ov.len = +half.length().toFixed(2);
    }
  } finally {
    for (const [n, q] of snap) human.bones.get(n)?.quaternion.copy(q);
    human.hips.position.copy(hp); human.root.updateMatrixWorld(true);
  }
  saveRagdollConfig(); savePoseKey('pe_ragdoll'); rebuildRagdoll(); renderAnim();
}
/**
 * ОБЖАТЬ ФИЗ-ТЕЛА ПО ВЕРШИНАМ МЕША (Ф28.3) — то, чего не умела подгонка по костям.
 *
 * Кости дают только ДЛИНУ и НАПРАВЛЕНИЕ; толщина оставалась ручным множителем «на глаз».
 * В Unreal PhysicsAsset тела генерятся по ВЕРШИНАМ, взвешенным на кость (`Vertex Weighting Type`),
 * и только поэтому коллайдер повторяет тело. Здесь то же самое.
 *
 * ТРИ ГРАБЛИ, каждая могла тихо испортить замер:
 *  1. Кость вершины резолвится ТОЛЬКО через `mesh.skeleton.bones[idx]` ЭТОГО меша: после дедупа
 *     скелетов у меша может быть СВОЙ `Skeleton` поверх общих костей — глобального индекса НЕТ.
 *  2. Замер идёт В Т-ПОЗЕ и по МИРОВЫМ вершинам (`applyBoneTransform` + `matrixWorld`), потому что
 *     так не надо угадывать ни бинд-матрицы, ни масштаб импорта: ретаргет и так ведёт кости модели
 *     НА наши (замер Ф27: 0.00u), значит мировой фрейм — общий.
 *  3. Размеры хранятся МНОЖИТЕЛЯМИ к каталогу, а замер даёт юниты — делим на каталожную полуось.
 *
 * Сначала всегда идёт подгонка ПО КОСТЯМ: она даёт анкер и ось, а вершины уточняют толщину,
 * длину и центр. Без загруженной модели возвращает null и оставляет подгонку по костям.
 */
function fitPhysToMesh(inflate = 0.95, pct = 0.95): { bodies: number; verts: number } | null {
  const ex = modelsTab.exportTarget(); if (!ex) return null;
  const meshes: THREE.SkinnedMesh[] = [];
  ex.root.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && m.geometry.getAttribute('skinWeight')) meshes.push(m); });
  if (!meshes.length) return null;
  const ourOf: Record<string, string> = {};                       // кость модели → наша кость
  for (const our in ex.boneMap) ourOf[ex.boneMap[our]!] = our;

  fitPhysToBones();                                               // анкеры и оси — с костей, как раньше
  const snap = new Map<string, THREE.Quaternion>();
  for (const [n, b] of human.bones) snap.set(n, b.quaternion.clone());
  const hp = human.hips.position.clone();
  human.reset(); human.root.updateMatrixWorld(true);
  modelsTab.drive(human);                                         // меш в Т-позе ровно по нашим костям
  const cloud = new Map<string, number[]>();                      // физ-тело → [x,y,z, x,y,z, …] в МИРЕ
  let verts = 0;
  try {
    const v = new THREE.Vector3();
    for (const m of meshes) {
      const pos = m.geometry.getAttribute('position'), si = m.geometry.getAttribute('skinIndex'), sw = m.geometry.getAttribute('skinWeight');
      if (!pos || !si || !sw) continue;
      m.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i++) {
        let bi = si.getX(i), bw = sw.getX(i);                      // ДОМИНАНТНЫЙ вес (Dominant Weight в UE): без двойного учёта
        if (sw.getY(i) > bw) { bw = sw.getY(i); bi = si.getY(i); }
        if (sw.getZ(i) > bw) { bw = sw.getZ(i); bi = si.getZ(i); }
        if (sw.getW(i) > bw) { bw = sw.getW(i); bi = si.getW(i); }
        if (bw <= 0) continue;
        const bone = m.skeleton.bones[bi]; if (!bone) continue;    // ГРАБЛЯ 1: только скелет ЭТОГО меша
        // ГРАБЛЯ 4: СКИН ВИСИТ НА ТВИСТ-КОСТЯХ. У CC/UE-ригов большая часть вершин руки взвешена
        // не на `UpperArm`, а на `UpperarmTwist01/02`, которых в нашей карте нет. Без подъёма по родителям
        // руки и ноги НЕ ОБЖИМАЛИСЬ вовсе (замер: из 21 тела получилось 10, и ни одной конечности).
        let our = ourOf[bone.name], up: THREE.Object3D | null = bone;
        while (!our && up) { up = up.parent; if (up) our = ourOf[up.name]; }
        if (!our) continue;
        const body = RAG_OF_HUMAN[our]; if (!body) continue;
        v.fromBufferAttribute(pos, i); m.applyBoneTransform(i, v); v.applyMatrix4(m.matrixWorld);
        let arr = cloud.get(body); if (!arr) { arr = []; cloud.set(body, arr); }
        arr.push(v.x, v.y, v.z); verts++;
      }
    }
    // Облако в МИРЕ → фрейм тела → обжатие → множители.
    let done = 0;
    const eU = V(), eV = V(), eA = V(), rel = V();
    for (const pb of physBodies()) {
      const arr = cloud.get(pb.name); if (!arr || arr.length < 30) continue;
      const half = physCatalogHalf(pb.name); if (!half || half.u < 1e-3) continue;
      const chain = pb.chain.length ? pb.chain : [pb.name];
      const first = human.bones.get(chain[0]!), last = human.bones.get(chain[chain.length - 1]!) ?? first;
      if (!first || !last) continue;
      const org = first.getWorldPosition(V());
      eA.set(pb.off[0], pb.off[1], pb.off[2]).applyQuaternion(last.getWorldQuaternion(Q()));
      if (eA.lengthSq() < 1e-8) continue;
      eA.normalize();
      eU.set(0, 1, 0); if (Math.abs(eU.dot(eA)) > 0.9) eU.set(1, 0, 0);
      eU.addScaledVector(eA, -eU.dot(eA)).normalize(); eV.crossVectors(eA, eU).normalize();
      const pts: BodyPoint[] = [];
      for (let i = 0; i < arr.length; i += 3) {
        rel.set(arr[i]!, arr[i + 1]!, arr[i + 2]!).sub(org);
        pts.push({ a: rel.dot(eA), u: rel.dot(eU), v: rel.dot(eV) });
      }
      const f = fitCollider(pts, { pct, inflate, axPct: 0.02 });   // 2% с каждого конца — против воротника на груди
      if (!f.n || f.half < 0.2) continue;
      const ov = (PHYS_SIZES[pb.name] ??= {});
      const cur0 = pb.shape.k;
      // ЗАМЕР ПО ВЕРШИНАМ ОГРАНИЧИВАЕТСЯ ДЛИНОЙ КОСТИ. Скиннинг не обязан совпадать с нашей сегментацией:
      // у CC-рига почти весь торс висит на ОДНОЙ кости груди, и облако растягивало тело с 2.82u до 9.12u,
      // съедая только что сделанное разделение спины. Кости дают длину точно (замер Ф28.1: 0.0° и длина
      // в длину), вершины — толщину, которую кости не знают. Коридор ±60% оставляет мешу право уточнить
      // край там, где он честно длиннее кости (стопа за лодыжкой, череп за шеей).
      const boneHalf = Math.hypot(pb.off[0], pb.off[1], pb.off[2]);
      const lim = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
      ov.len = +lim(f.half, boneHalf * 0.6, boneHalf * 1.6).toFixed(2);
      const w = lim(f.hu / half.u, 0.3, 2.5);
      ov.w = +w.toFixed(3);
      // У конуса `d` — СУЖЕНИЕ, и его тоже можно снять с вершин: отношение радиусов крайних четвертей.
      ov.d = cur0 === 'taper' && f.rNear > 1e-3
        ? +lim(f.rFar / f.rNear, 0.3, 2.5).toFixed(3)
        : +lim((f.hv / half.v) / w, 0.3, 2.5).toFixed(3);
      // ЦЕНТР ФОРМЫ СДВИГАЕТСЯ `pos`, А НЕ `off`: `off` задаёт ещё и разворот формы,
      // а `anchor` — вообще сустав. Смещение считается в ФРЕЙМЕ ТЕЛА, поэтому мировую ось возвращаем обратно.
      const d = f.center - Math.hypot(pb.off[0], pb.off[1], pb.off[2]);
      const loc = V().set(pb.off[0], pb.off[1], pb.off[2]).normalize().multiplyScalar(d);
      ov.pos = [+loc.x.toFixed(2), +loc.y.toFixed(2), +loc.z.toFixed(2)];
      done++;
    }
    saveRagdollConfig(); savePoseKey('pe_ragdoll');
    return { bodies: done, verts };
  } finally {
    for (const [n, q] of snap) human.bones.get(n)?.quaternion.copy(q);
    human.hips.position.copy(hp); human.root.updateMatrixWorld(true);
    rebuildRagdoll(); renderAnim();
  }
}
/**
 * Переснять тела с костей, ЕСЛИ пользователь уже снимал их раньше (Ф26.5). Анкеры/длины хранятся
 * АБСОЛЮТНО и в ГЛОБАЛЬНОМ `pe_ragdoll` (один на всех), а телосложение у каждого своё — значит при смене
 * персонажа или морфа их надо пересчитать, иначе кукла останется от чужого тела. Ручные множители
 * ширины/толщины и выбранные формы при этом СОХРАНЯЮТСЯ — переснимается только геометрия костей.
 */
/**
 * ⚠ И ПО УМОЛЧАНИЮ ТОЖЕ — «не снимал раньше» НЕ ЗНАЧИТ «оставить каталожные».
 *
 * Раньше подгонка шла ТОЛЬКО если анкер уже проставлен, то есть если автор хоть раз нажал «снять с костей».
 * После «чистого листа» `PHYS_SIZES` пуст — анкеров нет — и тела оставались в размерах БАЗОВОГО рига из
 * каталога, на модели с совсем другой геометрией. Глазами это ровно «ноги не совпадают с костями»: капсулы
 * ног уже мешевых и стоят уже, чем ноги. ЗАМЕР при этом говорил, что риг-то верный: наш скелет повторяет
 * кости модели с точностью 0.02 % длины ноги — расходились именно ТЕЛА.
 *
 * Пустой набор = автор ничего не настраивал, и честный дефолт тут — «с костей», а не число из каталога.
 * Ручная доводка (ширина/толщина/форма) по-прежнему переживает переснятие, поэтому настроившего это не трогает.
 */
function refitPhysIfFitted(): void {
  if (!ragdoll) return;
  const sizes = Object.values(PHYS_SIZES);
  if (sizes.some((v) => v.anchor) || sizes.length === 0) fitPhysToBones();
}
/** РАЗМЕРЫ ФИЗ-ТЕЛ (Ф26.5): форма + длина/ширина/толщина на тело, плюс авто-подгонка по костям. */
let sizeBody = 'Torso';
let meshFitNote = '';   // Ф28.3: что ответила подгонка по мешу
function physSizeSection(): void {
  const bodies = physBodies();
  if (!bodies.length) { const e = el('div', 'color:#d0a060;font-size:11px'); e.textContent = 'Нет активных тел.'; body.append(e); return; }
  if (!bodies.some((b) => b.name === sizeBody)) sizeBody = bodies[0]!.name;
  const cur = bodies.find((b) => b.name === sizeBody)!;
  const ov = PHYS_SIZES[sizeBody] ?? {};
  const apply = (fn: (o: PhysSize) => void, rebuild = true): void => {
    fn(PHYS_SIZES[sizeBody] ??= {});
    saveRagdollConfig(); savePoseKey('pe_ragdoll');
    if (rebuild) { rebuildRagdoll(); renderAnim(); }
  };
  const r1 = el('div', 'display:flex;gap:3px;align-items:center'); body.append(r1);
  const bsel = document.createElement('select'); bsel.style.cssText = impInput + ';flex:1';
  for (const b2 of bodies) { const o = document.createElement('option'); o.value = b2.name; o.textContent = PHYS_LABEL[b2.name] ?? b2.name; o.selected = b2.name === sizeBody; bsel.append(o); }
  bsel.onchange = () => { sizeBody = bsel.value; renderAnim(); };
  const ksel = document.createElement('select'); ksel.style.cssText = impInput;
  for (const [v, lb] of [['box', 'бокс'], ['sphere', 'шар'], ['cylinder', 'цилиндр'], ['capsule', 'пилюля'], ['taper', 'конус (ткань)']] as const) { const o = document.createElement('option'); o.value = v; o.textContent = lb; o.selected = cur.shape.k === v; ksel.append(o); }
  ksel.onchange = () => apply((o) => { o.k = ksel.value as PhysSize['k']; });
  r1.append(bsel, ksel);
  const srow = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px');
    row.innerHTML = `<span style="flex:0 0 74px">${label}</span>`;
    const out = el('span', 'width:38px;text-align:right;color:#9ae6a0'); out.textContent = get().toFixed(2);
    const r = el('input', 'flex:1') as HTMLInputElement; r.type = 'range'; r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(get());
    r.oninput = () => { out.textContent = parseFloat(r.value).toFixed(2); };
    r.onchange = () => set(parseFloat(r.value));   // пересборка куклы — ПО ОТПУСКАНИЮ (на каждый тик было бы дорого)
    row.append(r, out); body.append(row);
  };
  const ax = bodyAxis(cur);
  const curLen = cur.shape.k === 'box' ? cur.shape.h[ax]! : cur.shape.k === 'sphere' ? cur.shape.r : cur.shape.half;
  if (cur.shape.k !== 'sphere') srow('длина (½)', () => ov.len ?? curLen, (v) => apply((o) => { o.len = v; }), 0.5, 20, 0.1);
  srow(cur.shape.k === 'sphere' ? 'радиус ×' : 'ширина ×', () => ov.w ?? 1, (v) => apply((o) => { o.w = v; }), 0.3, 2.5, 0.05);
  if (cur.shape.k === 'box') srow('толщина ×', () => ov.d ?? 1, (v) => apply((o) => { o.d = v; }), 0.3, 2.5, 0.05);
  // У конуса то же поле `d` значит СУЖЕНИЕ к дальнему концу (у круглых второй поперечник бессмыслен).
  if (cur.shape.k === 'taper') srow('сужение ×', () => ov.d ?? 1, (v) => apply((o) => { o.d = v; }), 0.3, 2.5, 0.05);
  // Ф28.2 — СДВИГ И ПОВОРОТ ФОРМЫ, мимо сустава. Анкер трогать нельзя: он же точка констрейнта
  // и рест-трансляция скелета — сдвинув его, сдвинешь сустав и всю цепь ниже. В Unreal точно так же:
  // тело стоит на кости, а примитив внутри него имеет свой Center/Rotation.
  {
    const AX = ['X', 'Y', 'Z'] as const;
    const g = el('div', 'color:#6b7180;font-size:10px;margin-top:4px'); g.textContent = 'сдвиг формы (сустав не трогается)'; body.append(g);
    for (let i = 0; i < 3; i++) srow('сдвиг ' + AX[i], () => ov.pos?.[i] ?? 0,
      (v) => apply((o) => { const a = (o.pos ??= [0, 0, 0]) as number[]; a[i] = +v.toFixed(2); }), -12, 12, 0.1);
    const g2 = el('div', 'color:#6b7180;font-size:10px;margin-top:4px'); g2.textContent = 'поворот формы, градусы'; body.append(g2);
    for (let i = 0; i < 3; i++) srow('поворот ' + AX[i], () => +((ov.rot?.[i] ?? 0) * 180 / Math.PI).toFixed(0),
      (v) => apply((o) => { const a = (o.rot ??= [0, 0, 0]) as number[]; a[i] = +(v * Math.PI / 180).toFixed(4); }), -90, 90, 1);
  }
  const r2 = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(r2);
  r2.append(
    pbtn('⚖ снять с костей', () => fitPhysToBones()),
    pbtn('◉ обжать по мешу', () => { const r = fitPhysToMesh(); meshFitNote = r ? `обжато тел: ${r.bodies}, вершин: ${r.verts}` : 'модель не загружена — осталась подгонка по костям'; renderAnim(); }),
    pbtn('сброс тела', () => { delete PHYS_SIZES[sizeBody]; saveRagdollConfig(); savePoseKey('pe_ragdoll'); rebuildRagdoll(); renderAnim(); }),
    pbtn('сброс всех', () => { for (const k in PHYS_SIZES) delete PHYS_SIZES[k]; saveRagdollConfig(); savePoseKey('pe_ragdoll'); rebuildRagdoll(); renderAnim(); }),
    pbtn(showBoxes ? 'боксы: видны' : 'боксы: скрыты', () => { void ensurePhysics().then(() => { showBoxes = !showBoxes; setPref('boxes', showBoxes); applyBoxVis(); renderAnim(); }); }, showBoxes),
  );
  const hint = el('div', 'color:#6b7180;font-size:10px');
  hint.textContent = '«С костей» даёт анкер и ось. «По мешу» ещё и толщину — по вершинам кости, как в Unreal.'; body.append(hint);
  if (meshFitNote) { const n = el('div', 'color:#9ae6a0;font-size:10px'); n.textContent = meshFitNote; body.append(n); }
}
function physRigSection(): void {
  const on = new Set(PHYS_SET.bodies);
  const fingerNames = PHYS_CATALOG.filter((n) => n.tier === 'opt').map((n) => n.name);
  const apply = (names: string[]): void => {
    applyPhysProfile(names);
    saveRagdollConfig(); savePoseKey('pe_ragdoll');
    if (ragdoll) rebuildRagdoll();
    renderAnim();
  };
  const cost = physSetCost();
  const c = el('div', 'color:#6b7180;font-size:10px;margin-top:2px');
  c.textContent = `тел: ${cost.bodies} · суставов: ${cost.constraints} · шаг симуляции ~${physMs.toFixed(2)} мс`;
  body.append(c);
  {   // Ф28.4: ткань видит ТОЛЬКО сферы и капсулы, боксы для неё прозрачны — показываем заранее
    const cl = clothColliderCount();
    const t = el('div', 'font-size:10px');
    t.innerHTML = '<span style="color:#6b7180">для ткани (шары и капсулы): </span>'
      + '<span style="color:' + (cl.ok > cl.limit ? '#ff6b6b' : '#9ae6a0') + '">' + cl.ok + ' из ' + cl.limit + '</span>'
      + (cl.box ? '<span style="color:#e6a05a"> · боксом ' + cl.box + ' (ткань их НЕ видит)</span>' : '');
    body.append(t);
  }
  if (!uiPro) return;                       // в Простом режиме — только читаут, без галок

  const ph = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); ph.textContent = 'НАБОР ФИЗ-ТЕЛ (пересборка)'; body.append(ph);
  const prow = el('div', 'display:flex;align-items:center;gap:4px'); body.append(prow);
  const lab = el('span', 'flex:1;font-size:11px'); lab.textContent = 'пресет'; prow.append(lab);
  const sel = document.createElement('select'); sel.style.cssText = impInput;
  for (const pr of PHYS_PRESETS) { const o = document.createElement('option'); o.value = pr.id; o.textContent = pr.label; o.title = pr.hint; sel.append(o); }
  { const o = document.createElement('option'); o.value = 'custom'; o.textContent = 'Свой'; sel.append(o); }
  sel.value = PHYS_SET.id;
  sel.onchange = () => { if (sel.value !== 'custom') apply(presetBodies(PHYS_CATALOG, sel.value)); };
  prow.append(sel);

  const grid = el('div', 'display:flex;flex-wrap:wrap;gap:2px 8px;margin-top:3px'); body.append(grid);
  for (const n of PHYS_CATALOG) {
    if (n.tier === 'opt') continue;                            // фаланги — одной галкой ниже (30 штук поштучно нечитаемы)
    const l = el('label', 'font-size:11px;display:flex;align-items:center;gap:3px');
    const cb = el('input', '') as HTMLInputElement; cb.type = 'checkbox';
    cb.checked = on.has(n.name); cb.disabled = n.parent === null;   // таз — корень, выключить нельзя
    cb.onchange = () => { const next = new Set(on); if (cb.checked) next.add(n.name); else next.delete(n.name); apply([...next]); };
    l.append(cb, document.createTextNode(PHYS_LABEL[n.name] ?? n.name)); grid.append(l);
  }
  { // Пальцы — одним тумблером на 30 тел.
    const fingersOn = fingerNames.every((n) => on.has(n));
    const l = el('label', 'font-size:11px;display:flex;align-items:center;gap:3px;margin-top:2px');
    const cb = el('input', '') as HTMLInputElement; cb.type = 'checkbox'; cb.checked = fingersOn;
    cb.onchange = () => {
      const next = new Set(on);
      for (const n of fingerNames) { if (cb.checked) next.add(n); else next.delete(n); }
      apply([...next]);
    };
    l.append(cb, document.createTextNode(`пальцы (${fingerNames.length} тел)`));
    l.title = 'Фаланги с физикой: тяжело, но честный контакт с рукоятью. Пределы у пальца ОДНИ и те же — есть тело или нет.';
    body.append(l);
    if (fingersOn && !wantFingers()) {
      const w = el('div', 'color:#ffcf66;font-size:10px');
      w.textContent = '⚠ у манекена пальцев нет — включи их в персонаже, иначе физ-фаланги нечем вести';
      body.append(w);
    }
  }
  const note = el('div', 'color:#6b7180;font-size:10px');
  note.textContent = 'Выключенное тело не теряется: его угол сливается в ближайшего потомка. Клип это не трогает.';
  body.append(note);
}
/**
 * Вкладка «Анимация» — свитки (Ф26.4). Скролл ПАНЕЛИ СОХРАНЯЕТСЯ: эта функция зовётся НА КАЖДЫЙ
 * клик по кости/ручке (`refreshPose`/`refreshLimbs`), и без восстановления панель прыгала бы вверх после каждого тыка.
 */
function renderAnim(): void {
  const top = panel.scrollTop;
  body = panelRoot; body.innerHTML = '';
  rollout('clips', 'КЛИПЫ И КАДРЫ', clipSection, true);
  rollout('export', 'ЭКСПОРТ АНИМАЦИЙ → GLB', animExportSection);
  poseTools();
  panel.scrollTop = top;
}

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
      .finally(() => { applyPose(saved); if (ikOn) captureRig(); renderAnim(); });
  };

  const cur = curClip();
  row.append(
    pbtn('⬇ клип', () => { if (cur) doExport([cur], cur.name); }),
    pbtn('⬇ все клипы персонажа', () => doExport(library.filter((x) => x.character === curCharId), curCharId + '_anims')),
  );
  if (expStatus) { const st = el('div', 'font-size:10px;margin-top:3px;color:' + (expStatus[0] === '✗' ? '#e08080' : '#9ae6a0')); st.textContent = expStatus; body.append(st); }
}
/** Вид клипа для групп/фильтра — теми же префиксами, что читает игра и экспорт (`clipToAnimation`), чтобы UI и данные не разъехались. */
type ClipKind = 'stance' | 'hit' | 'gait' | 'other';
// ⚠ Повороты на месте (`turn_*`) — тоже «ходьба»: их пишет тот же бейк с вкладки «Бег», и в общем
// списке шесть клипов поворота заслоняли стойки и удары, которые правят руками.
const clipKind = (n: string): ClipKind =>
  /^(combat_)?idle_/.test(n) ? 'stance'
  : /^(s_)?hit_/.test(n) ? 'hit'
  : /^(idle|walk|run|strafe|turn)(_|$)/.test(n) ? 'gait' : 'other';
const KIND_LABEL: Record<ClipKind, string> = { stance: 'стойки', hit: 'удары', gait: 'ходьба', other: 'прочее' };
/**
 * СПИСОК КЛИПОВ (Ф26.4) — вертикальный, со СВОИМ скроллом, поиском, чипсами вида и сортировкой.
 * Запечённая ходьба (`walk_*`/`run_*`/`strafe_*`) и повороты на месте (`turn_*`) — ОТДЕЛЬНОЙ группой,
 * свёрнутой по умолчанию: их пишет бейк с вкладки «Бег» десятками клипов, и вручную там делать обычно нечего.
 */
function clipList(list: Clip[]): void {
  const f = el('div', 'display:flex;gap:3px;align-items:center;margin-top:4px'); body.append(f);
  const inp = el('input', 'flex:1;min-width:60px;' + impInput) as HTMLInputElement;
  inp.type = 'search'; inp.placeholder = 'поиск'; inp.value = clipFilter;
  inp.oninput = () => { clipFilter = inp.value; renderAnim(); const el2 = panel.querySelector('input[type=search]') as HTMLInputElement | null; if (el2) { el2.focus(); el2.setSelectionRange(el2.value.length, el2.value.length); } };
  const sel = document.createElement('select'); sel.style.cssText = impInput;
  for (const [v, lb] of [['name', 'а→я'], ['kind', 'по виду'], ['len', 'по кадрам']] as const) { const o = document.createElement('option'); o.value = v; o.textContent = lb; o.selected = clipSort === v; sel.append(o); }
  sel.onchange = () => { clipSort = sel.value as typeof clipSort; ui.clipSort = clipSort; saveUi(); renderAnim(); };
  f.append(inp, sel);
  const chips = el('div', 'display:flex;flex-wrap:wrap;gap:2px;margin-top:2px'); body.append(chips);
  for (const k of ['все', 'stance', 'hit', 'gait', 'other'] as const) {
    const on = clipKindF === k;
    chips.append(pbtn(k === 'все' ? 'все' : KIND_LABEL[k], () => { clipKindF = k; ui.clipKind = k; saveUi(); renderAnim(); }, on));
  }
  const q = clipFilter.trim().toLowerCase();
  const shown = list.filter((c) => (!q || c.name.toLowerCase().includes(q)) && (clipKindF === 'все' || clipKind(c.name) === clipKindF));
  const cmp = clipSort === 'len' ? (a: Clip, b2: Clip) => b2.keys.length - a.keys.length
    : clipSort === 'kind' ? (a: Clip, b2: Clip) => clipKind(a.name).localeCompare(clipKind(b2.name)) || a.name.localeCompare(b2.name)
    : (a: Clip, b2: Clip) => a.name.localeCompare(b2.name);
  const gait = shown.filter((c) => clipKind(c.name) === 'gait').sort(cmp);
  const main = shown.filter((c) => clipKind(c.name) !== 'gait').sort(cmp);
  const box = el('div', 'max-height:186px;overflow-y:auto;margin-top:3px;border:1px solid #2a3350;border-radius:4px;padding:2px'); body.append(box);
  const row = (cl: Clip): void => {
    const i = list.indexOf(cl), act = i === clipIdx;
    const r = el('div', `display:flex;align-items:center;gap:4px;padding:1px 3px;border-radius:3px;cursor:pointer;background:${act ? '#3a5030' : 'transparent'}`);
    const nm = el('span', `flex:1;font-size:11px;color:${act ? '#eaf3de' : '#cfd3e0'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);
    nm.textContent = cl.name; nm.title = cl.name + ' · ' + KIND_LABEL[clipKind(cl.name)];
    const cnt = el('span', 'font-size:10px;color:#6b7180'); cnt.textContent = String(cl.keys.length);
    const del = el('span', 'font-size:10px;color:#8a6a6a;padding:0 2px'); del.textContent = '✗'; del.title = 'удалить';
    del.onclick = (ev) => { ev.stopPropagation(); if (confirm('Удалить «' + cl.name + '»?')) delClip(cl); };
    r.onclick = () => { clipIdx = i; frameIdx = 0; goFrame(0); };
    r.append(nm, cnt, del); box.append(r);
  };
  for (const cl of main) row(cl);
  if (gait.length) {
    const open = (ui.open ??= {})['gaitGroup'] ?? false;
    const g = pbtn(`${open ? '▾' : '▸'} ходьба (запечённая) · ${gait.length}`, () => { (ui.open ??= {})['gaitGroup'] = !open; saveUi(); renderAnim(); }, open);
    g.style.cssText += ';width:100%;text-align:left'; box.append(g);
    if (open) for (const cl of gait) row(cl);
  }
  if (!shown.length) { const e = el('div', 'color:#d0a060;font-size:11px'); e.textContent = list.length ? 'Ничего не нашлось — сними фильтр.' : 'Нет клипов для этого оружия. «+ новый» создаёт из текущей позы.'; box.append(e); }
}
let clipFilter = '';
let clipKindF: 'все' | ClipKind = (ui.clipKind as 'все' | ClipKind) ?? 'все';
let clipSort: 'name' | 'kind' | 'len' = (ui.clipSort as 'name' | 'kind' | 'len') ?? 'name';
/**
 * ЧТО ИГРА РЕАЛЬНО СЫГРАЕТ НА ЭТОМ КЛЮЧЕ ОРУЖИЯ.
 *
 * Жалоба, из которой это выросло: «сделал стойку и удар мечом, взял щит — удар пропадает». Он не
 * пропадал: игра ищет удары по ЦЕПОЧКЕ `sword+shield → sword` и находит их там же. Пустым был
 * СПИСОК В РЕДАКТОРЕ — он фильтровал строго по точному ключу, и автор видел ноль клипов.
 *
 * ⚠ Наследование ВСЁ-ИЛИ-НИЧЕГО: есть хоть один свой `hit_` на точном ключе — игра берёт ТОЛЬКО
 * их, а унаследованные не подмешивает. Поэтому «добавлю один удар со щитом» тихо отключает
 * остальные, и об этом здесь написано прямо.
 */
function inheritedHits(): { from: string; clips: Clip[] } | null {
  const mine = library.filter((c) => c.character === curCharId && c.weapon === weapon && c.name.startsWith('hit_'));
  if (mine.length) return null;                       // свои есть → игра возьмёт их, наследовать нечего
  for (const cand of weaponChain(weapon).slice(1)) {
    const set = library.filter((c) => c.character === curCharId && c.weapon === cand && c.name.startsWith('hit_'));
    if (set.length) return { from: cand, clips: set.slice().sort((a, b) => a.name.localeCompare(b.name)) };
  }
  return null;
}

function clipSection(): void {
  const list = clipsHere();
  const info = el('div', 'color:#9ae6a0;margin-bottom:4px'); info.textContent = `${curChar().name} · ${weapon} · клипов: ${list.length}`; body.append(info);
  const inh = inheritedHits();
  if (inh) {
    const b = el('div', 'margin:2px 0 6px;padding:4px 6px;border:1px solid #3f5a33;border-radius:4px;background:#1a2016;font-size:10px;color:#9ae6a0');
    const t = el('div', ''); t.textContent = `Удары НАСЛЕДУЮТСЯ от «${inh.from}»: ${inh.clips.map((c) => c.name).join(', ')}`;
    const h = el('div', 'color:#7a869e;margin-top:2px');
    h.textContent = 'Своих ударов на этом ключе нет — игра сыграет эти. Щит/вторая рука подмешиваются поверх, переписывать удары не нужно.';
    b.append(t, h);
    b.append(pbtn('сделать свои копии (отвяжет от «' + inh.from + '»)', () => {
      if (!confirm(`Скопировать ${inh.clips.length} удар(ов) на «${weapon}»?\n\nПосле этого игра перестанет брать удары «${inh.from}» — правки там сюда доезжать НЕ БУДУТ.`)) return;
      histLib('копии ударов на ' + weapon, () => {
        for (const c of inh.clips) {
          const nm = retargetClipName(c.name, c.weapon, weapon);
          putClip({ name: nm, character: curCharId, weapon, loop: c.loop, keys: c.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) }, 'replace');
        }
        saveLib(); refreshAll();
      });
    }));
    body.append(b);
  }
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
      putClip(nc, 'replace');   // столкновение уже разрулено выше (nameFree / отдельный confirm)
      if (clipBufWasAtk) { const arr = ((atkCfgs[curCharId] ??= {})[weapon] ??= []); if (!arr.includes(name)) { arr.push(name); saveAtk(); } }
      saveLib(); clipIdx = Math.max(0, clipsHere().findIndex((x) => x.name === name)); frameIdx = 0; refreshAll();
    });
  };
  row1.append(pbtn('+ новый', () => { const nm = prompt('имя клипа (действие)', 'clip' + (list.length + 1)); if (!nm) return; histLib('новый клип', () => { putClip({ name: nm, character: curCharId, weapon, loop: false, keys: [{ pose: readPoseFull(), t: 0 }] }, 'rename'); clipIdx = list.length; frameIdx = 0; saveLib(); refreshAll(); }); }));
  row1.append(pbtn('📥 из FBX/BVH', () => openImportAnimModal()));   // импорт мокап/AI-анимации → наш клип (запекатель)
  if (clipBuf) row1.append(pbtn('⎘ вставить: ' + retargetClipName(clipBuf.name, clipBuf.weapon, weapon), pasteHere));   // буфер переживает смену оружия/персонажа
  const c = curClip();
  if (c) {
    row1.append(
      pbtn('⎘ копир', () => { clipBuf = { name: c.name, character: curCharId, weapon, loop: c.loop, keys: c.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) }; clipBufWasAtk = atkList().includes(c.name); refreshAll(); }),
      pbtn('дубл', () => histLib('дублировать клип', () => { putClip({ name: c.name + '_copy', character: curCharId, weapon, loop: c.loop, keys: c.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) }, 'rename'); saveLib(); refreshAll(); })),
      pbtn('переим', () => {
        const nm = prompt('имя клипа', c.name); if (!nm || nm === c.name) return;
        if (library.some((x) => x !== c && x.name === nm && x.character === curCharId && x.weapon === weapon)) { alert('Клип «' + nm + '» на этом оружии уже есть — выберите другое имя.'); return; }
        // ⚠ СТОЙКА ПЕРЕИМЕНОВАНИЯ НЕ БОИТСЯ: если клип был назначен ролью, привязка едет за новым именем
        // (ниже). Предупреждаем только про УДАРЫ — их рантайм по-прежнему ищет сканом префикса `hit_`.
        const wasHit = ['hit_', 's_hit_'].some((p) => c.name === p + weapon), stillHit = ['hit_', 's_hit_'].some((p) => nm === p + weapon);
        if (wasHit && !stillHit && !confirm('«' + c.name + '» — конвенционное имя удара, игра ищет удары по префиксу «hit_». Переименование уберёт клип из набора ударов. Продолжить?')) return;
        const wasIdle = stanceName(weapon) === c.name, wasCombat = combatStanceName(weapon) === c.name;
        histLib('переименовать клип', () => { const old = c.name; c.name = nm; const arr = atkCfgs[curCharId]?.[weapon]; if (arr) { const j = arr.indexOf(old); if (j >= 0) { arr[j] = nm; saveAtk(); } }
        if (wasIdle) setStanceRole('idle', nm); if (wasCombat) setStanceRole('combat_idle', nm);   // роль едет за именем
        saveLib(); refreshAll(); });
      }),
      pbtn('удалить', () => { if (confirm('Удалить клип «' + c.name + '»?')) delClip(c); }),
      // РОЛЬ КЛИПА. Игра ищет стойку по ПРИВЯЗКЕ, а не по имени, поэтому назначить ролью можно любой
      // клип как угодно названный — и делается это здесь, где его и называют, а не на другой вкладке.
      roleBtn(c, 'idle', '🧍 спокойная'),
      roleBtn(c, 'combat_idle', '⚔ боевая'),
      pbtn(c.loop ? '↻ луп' : '→ 1 раз', () => histLib('луп клипа', () => { c.loop = !c.loop; saveLib(); refreshAll(); }), c.loop),
      pbtn('⚙ запечь физику', () => { void bakeCurrentClip(); }),
    );
  }
  clipList(list);
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
    if (onionOn) vr.append(pbtn('±' + onionSpan, () => { onionSpan = onionSpan >= 3 ? 1 : onionSpan + 1; refreshAll(); }));
    trajBtn = pbtn(trajLabel(), () => { trajOn = !trajOn; refreshAll(); }, trajOn);
    trajBtn.title = 'Путь выбранной кости за весь клип. Расстояние между точками = скорость (сетка времени равномерная).';
    vr.append(trajBtn); }
  rollout('curve', 'КРИВАЯ ПЕРЕХОДА', () => curveSection(c));
  rollout('marks', 'МЕТКИ КАДРА', () => marksSection(c));
  }
  const eh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); eh.textContent = 'ЭКСПОРТ / ИМПОРТ'; body.append(eh);
  const ta = el('textarea', 'width:100%;height:70px;background:#0e1016;color:#9ae6a0;border:1px solid #39415a;border-radius:4px;font:10px monospace') as HTMLTextAreaElement; body.append(ta);
  const er = el('div', ''); body.append(er);
  er.append(pbtn('клип', () => { if (c) ta.value = JSON.stringify(c); }), pbtn('всё', () => { ta.value = JSON.stringify(library); }), pbtn('копир клипы', () => navigator.clipboard?.writeText(ta.value)), pbtn('импорт клипы', () => histLib('импорт JSON', () => { try { const d = JSON.parse(ta.value); const arr = Array.isArray(d) ? d : [d]; const cl = arr.map(migrateClip); if (Array.isArray(d)) library = cl; else for (const c of cl) putClip(c, 'ask'); saveLib(); refreshAll(); } catch { /* */ } })));
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
/** Ключ доступа к сервису — из ЛИЧНЫХ настроек: `pe_prefs` на сервер не уходит вовсе. */
const aiKey = (): string => getPref<string>('aiKey', '');

/**
 * Общий хвост: ответ сервиса → клип в библиотеке (тем же запекателем, что и ручной импорт FBX/BVH).
 *
 * ДВА ФОРМАТА ОДНИМ ПУТЁМ. Текстовый BVH отдают text-to-motion модели и экспорт Kimodo;
 * скелетный GLB — `kimodo.cpp`. Конвертер между ними не нужен: запекатель читает оба,
 * различая их по расширению файла — поэтому вся разница сводится к имени и типу `File`.
 */
async function aiResultToClip(data: string | ArrayBuffer, label: string): Promise<void> {
  const isBvh = typeof data === 'string';
  if (isBvh && !looksLikeBvh(data)) { aiStatus = '✗ это не похоже на BVH'; refreshAll(); return; }
  const { bakeAnimationToClip } = await import('./clipBaker.js');
  const file = isBvh
    ? new File([data], 'ai.bvh', { type: 'text/plain' })
    : new File([data], 'ai.glb', { type: 'model/gltf-binary' });
  const idle = resolveUpper(weapon)?.pose;
  const name = generatedClipName(label, library.filter((c) => c.character === curCharId && c.weapon === weapon).map((c) => c.name));
  try {
    const r = await bakeAnimationToClip(file, { character: curCharId, weapon, name, idlePose: idle, anchorIdle: !!idle });
    histLib('ИИ: добавить клип', () => { putClip(r.clip, 'rename'); clipIdx = clipsHere().length - 1; frameIdx = 0; saveLib(); });
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

  // КЛЮЧ — В ЛИЧНЫХ НАСТРОЙКАХ, НЕ В `pe_ai`. Адрес сервиса общий для всех машин и едет в рабочей
  // копии, а рабочая копия публикуется на сервер целиком — учётным данным там не место.
  const keyRow = el('label', 'display:flex;align-items:center;gap:5px;margin-bottom:3px');
  keyRow.innerHTML = '<span style="width:52px;font-size:11px">ключ</span>';
  const keyIn = el('input', 'flex:1;' + impInput) as HTMLInputElement;
  keyIn.type = 'password'; keyIn.placeholder = 'ANIM_KEY сервиса'; keyIn.value = aiKey();
  keyIn.onchange = () => { setPref('aiKey', keyIn.value.trim()); };
  keyRow.append(keyIn); body.append(keyRow);

  const pingBtn = pbtn('⌘ проверить связь', () => {
    aiStatus = '… проверка'; refreshAll();
    void checkHealth(aiCfg, aiKey()).then((h) => {
      aiStatus = h.error ? '✗ ' + h.error
        : '✓ ' + [h.backend, h.model, h.device].filter(Boolean).join(' · ');
      refreshAll();
    });
  });
  pingBtn.disabled = !aiCfg.url; pingBtn.style.opacity = aiCfg.url ? '1' : '0.45';
  pingBtn.title = 'Спросить у сервиса, жив ли он и какой движок поднят';
  body.append(pingBtn);

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
  // Ф12.6: кнопка, которой нужен ВНЕШНИЙ сервис, не должна выглядеть рабочей, пока адрес не задан —
  // иначе «непонятно, какие кнопки работают»: жмёшь, и вместо результата ошибка.
  const genBtn = pbtn('✦ сгенерировать', () => {
    aiStatus = '… запрос'; refreshAll();
    void requestGeneration(aiCfg, { prompt: pr.value, seconds: aiCfg.seconds, character: curCharId, weapon }, aiKey()).then(async (r) => {
      if (r.error) { aiStatus = '✗ ' + r.error; refreshAll(); return; }
      if (r.clip) { histLib('ИИ: добавить клип', () => { putClip(migrateClip(r.clip), 'rename'); saveLib(); }); aiStatus = '✓ клип принят'; refreshAll(); return; }
      await aiResultToClip(r.glb ?? r.bvh ?? '', pr.value);
    });
  });
  genBtn.disabled = !aiCfg.url;
  genBtn.title = aiCfg.url ? 'Отправить запрос сервису генерации' : 'Нужен внешний сервис генерации: впиши его адрес в поле «сервис» выше. Путь «↑ BVH из файла» работает без него.';
  genBtn.style.opacity = aiCfg.url ? '1' : '0.45';
  genBtn.style.cursor = aiCfg.url ? 'pointer' : 'not-allowed';
  row.append(genBtn);
  // Путь «из файла» — чтобы вся цепочка проверялась без сервиса.
  const fi = el('input', 'display:none') as HTMLInputElement;
  fi.type = 'file'; fi.accept = '.bvh,text/plain';
  fi.onchange = () => { const f = fi.files?.[0]; if (f) void f.text().then((t) => aiResultToClip(t, pr.value || f.name)); };
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
/** Морф меняет ДЛИНЫ КОСТЕЙ — значит и физ-тела надо пересобрать (Ф26.5): раньше кукла оставалась от старого телосложения. */
function rebuildForMorph(): void {
  applyChar(curCharId);
  // Физ-тела едут за морфом (Ф26.5). Размеры хранятся АБСОЛЮТНО (анкер + полудлина), иначе ручная
  // доводка потеряла бы смысл — поэтому после смены телосложения их надо ПЕРЕСНЯТЬ с костей. Ширина/толщина
  // — множители, они переживают переснятие.
  if (ragdoll) { if (Object.values(PHYS_SIZES).some((v) => v.anchor)) fitPhysToBones(); else rebuildRagdoll(); }
  tab = 'char'; refreshAll();
}
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
/** Якоря скорости на паде: центр→ходьба, край→бег. Те же числа у 16 точек плант-сетки и у переключателя режима. */
const PAD_WALK = 0.34, PAD_RUN = 0.95;
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
      const th = i * DIR_STEP, mag = run ? PAD_RUN : PAD_WALK; const [px, py] = velToPad(Math.sin(th) * mag, Math.cos(th) * mag);
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
  const goDir = (i: number, run: boolean): void => { gaitFaceMove = false; gaitYawManual = 0; const th = i * DIR_STEP, mag = run ? PAD_RUN : PAD_WALK; locoVz = Math.cos(th) * mag; locoVx = Math.sin(th) * mag; plantDirSel = i; plantSpeedRun = run; if (!locoOn) { locoOn = true; gaitPx = 0; gaitPz = 0; locoPlayer?.resetPos(); void ensurePhysics(); } renderLoco(); };
  const hitPlantPoint = (ev: PointerEvent): boolean => {
    const r = cv.getBoundingClientRect(); const mx = (ev.clientX - r.left) / r.width * PAD, my = (ev.clientY - r.top) / r.height * PAD;
    let best = -1, bestRun = true, bestD = 15;   // порог попадания в точку, px
    for (const run of [false, true]) for (let i = 0; i < 8; i++) { const th = i * DIR_STEP, mag = run ? PAD_RUN : PAD_WALK; const [px, py] = velToPad(Math.sin(th) * mag, Math.cos(th) * mag); const d = Math.hypot(mx - px, my - py); if (d < bestD) { bestD = d; best = i; bestRun = run; } }
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
  // ДОВОРОТ ТАЗА ПОД ДВИЖЕНИЕ (Ф0, прототип): низ разворачивается к ходу и шагает «вперёд», верх
  // продолжает целиться. Тумблер живёт ЗДЕСЬ, а не в «Про»-тюнинге: ради него всё и заводится —
  // включил, поводил точку по паду, выключил, сравнил. Ответ на вопрос «4 направления или 8».
  const wb = el('div', 'margin-top:6px;border:1px solid #39415a;border-radius:6px;padding:5px'); body.append(wb);
  const wr = el('div', 'display:flex;gap:6px;align-items:center'); wb.append(wr);
  wr.append(pbtn(GAIT.warpOn ? 'доворот таза: ВКЛ' : 'доворот таза: выкл',
    () => { GAIT.warpOn = GAIT.warpOn ? 0 : 1; saveGaitCfg(); renderLoco(); }, !!GAIT.warpOn));
  warpReadout = el('span', 'color:#9ae6a0;font-size:11px'); warpReadout.textContent = 'таз 0°'; wr.append(warpReadout);
  if (GAIT.warpOn) {
    const wsl = (label: string, key: 'warpMax' | 'warpSmooth', max: number, step: number, unit: string): void => {
      const row = el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px');
      const nm = el('span', 'flex:1;font-size:11px'); nm.textContent = label; row.append(nm);
      const sl = el('input', 'flex:2') as HTMLInputElement;
      sl.type = 'range'; sl.min = '0'; sl.max = String(max); sl.step = String(step); sl.value = String(GAIT[key]);
      const v = el('span', 'width:46px;text-align:right;color:#9ae6a0;font-size:11px'); v.textContent = GAIT[key] + unit;
      sl.oninput = () => { GAIT[key] = parseFloat(sl.value); v.textContent = GAIT[key] + unit; saveGaitCfg(); };
      row.append(sl, v); wb.append(row);
    };
    wsl('потолок доворота', 'warpMax', 80, 5, '°');
    wsl('сглаживание', 'warpSmooth', 0.4, 0.01, ' с');
    const wn = el('div', 'color:#7a869e;font-size:10px;margin-top:3px');
    wn.textContent = 'Остаток сверх потолка остаётся боковым выносом — это и есть переход на страйф.';
    wb.append(wn);
  }
  bakeGaitSection();
  if (uiPro) renderGaitTune();   // тюнинг походки (24 ползунка GAIT/POSE/GX) — только Про
  renderUpperPanel();
  renderAttackPanel();
}
/** Панель настройки процедурного бега (GX/POSE/GAIT). Меняет живые объекты + пишет per-character в pe_gait. */
// Ф2.1: запечь процедурную походку в обычные клипы (после этого клиенту StepPlanner не нужен)
let bakeStatus = '';
/**
 * ⭐ ЧТО ИМЕННО ЗАПЕКАТЬ — НАСТРОЙКА, А НЕ КОНСТАНТА. Список режимов хранится per-персонаж
 * (`pe_gaitbake`), потому что и сама походка настраивается per-персонаж.
 *
 * Пустая запись = умолчание (`defaultBakePick`): всё, что спрашивает движок, без диагоналей.
 */
type BakePick = Record<string, string[]>;
let bakePick: BakePick = (() => { try { return JSON.parse(localStorage.getItem('pe_gaitbake') || '{}') as BakePick; } catch { return {}; } })();
const bakeList = (): string[] => bakePick[curCharId] ?? defaultBakePick();
const setBakeList = (names: string[]): void => {
  bakePick = { ...bakePick, [curCharId]: names };
  try { localStorage.setItem('pe_gaitbake', JSON.stringify(bakePick)); savePoseKey('pe_gaitbake'); } catch { /* приватный режим */ }
};

function bakeGaitSection(): void {
  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); h.textContent = 'ЗАПЕЧЬ ПОХОДКУ В КЛИПЫ'; body.append(h);
  const picked = bakeList();
  const info = el('div', 'color:#6b7180;font-size:10px');
  info.textContent = weapon === 'none'
    ? 'БЕЗ ОРУЖИЯ = базовый набор: работает со всеми оружиями, пока им не запечён свой'
    : `набор для «${weapon}» — перекроет безоружный только для этого оружия`;
  body.append(info);

  // ── Список режимов: что запекаем ────────────────────────────────────────────────────────────
  // Видно сразу две вещи: что включено и что уже запечено (и под каким оружием найдётся). Набор —
  // это стойка и ЧЕТЫРЕ направления × ходьба/бег: диагональ закрывает доворот таза, восьми
  // направлений нам не нужно. Галки здесь — чтобы перезапечь ЧАСТЬ набора, не трогая остальное.
  const listBox = el('div', 'margin:4px 0;border:1px solid #39415a;border-radius:6px;padding:4px 6px');
  const addRow = (nameStr: string, hint: string): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:1px 0;font-size:11px');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = picked.includes(nameStr);
    cb.addEventListener('change', () => {
      const next = cb.checked ? [...bakeList(), nameStr] : bakeList().filter((n) => n !== nameStr);
      setBakeList(next); refreshAll();   // список живёт на вкладке «Бег» — перерисовываем её, а не «Анимации»
    });
    const have = findLocoClip(library, nameStr, curCharId, weapon);
    const name = el('span', 'flex:1'); name.textContent = nameStr;
    const speed = el('span', 'color:#6b7180'); speed.textContent = hint;
    const mark = el('span', have ? 'color:#9ae6a0' : 'color:#6b7180');
    mark.textContent = have ? (have.weapon === weapon ? '✓ есть' : `✓ ${have.weapon}`) : '—';
    row.append(cb, name, speed, mark);
    listBox.append(row);
  };
  for (const s of GAIT_PRESETS) addRow(s.name, s.durationSec !== undefined ? 'стойка' : `${Math.round(Math.hypot(s.vx, s.vz) * 100)}%`);
  // ⭐ ПОВОРОТЫ НА МЕСТЕ: играют, пока стоишь с локомоцией клипами, — по порогу скрутки корпуса, сами
  // ведут таз (`turnInPlace.ts`). Не запечены — поворот на месте остаётся за планировщиком.
  const th = el('div', 'color:#8fb7ff;font-size:10px;margin-top:4px'); th.textContent = 'повороты на месте'; listBox.append(th);
  for (const s of TURN_PRESETS) addRow(s.name, `${s.deg > 0 ? '→' : '←'} ${Math.round(Math.abs(s.deg))}°`);
  body.append(listBox);
  // Сторож расхождения ГЛАЗАМИ: чего из нужного движку в выборке нет.
  const miss = [...LOCO_NAMES, ...TURN_NAMES].filter((n) => !picked.includes(n));
  if (miss.length) {
    const w = el('div', 'color:#e0b050;font-size:10px;margin-bottom:2px');
    w.textContent = `⚠ движок спрашивает, а в наборе нет: ${miss.join(', ')} — это останется на планировщике`;
    body.append(w);
  }

  body.append(pbtn(`⚙ запечь набор походки (${picked.length})`, () => {
    const wasLoco = locoOn; locoOn = false;                   // бейк сам гоняет плеера — цикл не должен мешать
    const player = lp();
    if (player.weapon !== weapon) player.setWeapon(weapon);
    player.gx = GX; player.plant = gaitPlant; player.twistStates = editorTwistStates;
    const t0 = performance.now();
    const opts = { character: curCharId, weapon, readPose: defaultReadPose(human) };
    const out = [
      ...bakeGaitSet(player, human, opts, GAIT_PRESETS.filter((s) => bakeList().includes(s.name))),
      ...bakeTurnSet(player, human, opts, TURN_PRESETS.filter((s) => bakeList().includes(s.name))),
    ];
    const ms = performance.now() - t0;
    histLib('запечь походку', () => {
      for (const r of out) putClip(r.clip, 'replace');   // перезапекание набора — это осознанная перезапись
      saveLib();
    });
    const keys = out.reduce((a, r) => a + r.keys, 0), frames = out.reduce((a, r) => a + r.frames, 0);
    bakeStatus = `✓ ${out.length} клипов, ${frames} кадров → ${keys} ключей, ${ms.toFixed(0)} мс`;
    locoOn = wasLoco;
    refreshAll();
  }));
  if (bakeStatus) { const st = el('div', 'font-size:10px;margin-top:2px;color:#9ae6a0'); st.textContent = bakeStatus; body.append(st); }
}

/**
 * ТЮНИНГ ПОХОДКИ. Три правила, ради которых панель переписана:
 *  1. Ходьба и бег больше НЕ перемешаны. Вверху переключатель — правишь один режим, видишь его ползунки.
 *     Переключение ставит и превью на соответствующую скорость, чтобы крутить и сразу смотреть.
 *  2. У КАЖДОГО ползунка две стороны, Л и П. Совпадают — храним одно число (как раньше); развели —
 *     пара уезжает в `ASYM`, и это видно по метке «Л≠П» на строке.
 *  3. Плечевой пояс настраивается. Раньше ключицы на ходу сводились в ноль и жили сами по себе.
 */
function renderGaitTune(): void {
  const box = el('div', 'margin-top:8px;border:1px solid #39415a;border-radius:6px;padding:6px');
  const grp = (t: string): void => { const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 1px;font-size:11px'); h.textContent = t; box.append(h); };
  const GXo = GX as unknown as NumRec, POSEo = POSE as unknown as NumRec, GAITo = GAIT as unknown as NumRec;
  // Run-твины, которых может не быть в старом сохранённом конфиге: садим из ходьбы → поведение не меняется.
  for (const [r, w] of [['armDownRun', 'armDown'], ['elbowBendRun', 'elbowBend']] as const) if (GXo[r] === undefined) GXo[r] = GXo[w]!;

  // ── Режим ───────────────────────────────────────────────────────────────────────────────────────
  const modeRow = el('div', 'display:flex;gap:4px;align-items:center'); box.append(modeRow);
  // Переключить режим = И правим его ползунки, И персонаж в кадре реально идёт/бежит: точка на паде
  // встаёт на ту же скорость, ячейка плант-сетки — тоже, превью включается, если было выключено.
  // Иначе крутишь «бег», а перед тобой стоит идл — и непонятно, что ты вообще настроил.
  // Смена любой из осей = И правим её ползунки, И персонаж в кадре реально так идёт: точка на паде
  // встаёт на ту же скорость и то же направление, ячейка плант-сетки — тоже, превью включается, если
  // было выключено. Иначе крутишь «бег назад», а перед тобой стоит идл — и непонятно, что настроил.
  const applyView = (): void => {
    const v = gaitSpeed === 'walk' ? PAD_WALK : PAD_RUN;
    // СТРАЙФ и НАЗАД показываем честно: тело смотрит ВПЕРЁД, а едет вбок или спиной. Иначе «лицом по
    // движению» разворачивает персонажа, и оба режима превращаются в обычный бег вперёд.
    if (gaitDir === 'str') { gaitFaceMove = false; gaitYawManual = 0; locoVx = v; locoVz = 0; plantDirSel = 2; }
    else if (gaitDir === 'back') { gaitFaceMove = false; gaitYawManual = 0; locoVx = 0; locoVz = -v; plantDirSel = 4; }
    else { locoVx = 0; locoVz = v; plantDirSel = 0; }
    plantSpeedRun = gaitSpeed === 'run';
    // Бой — это НЕ второй набор ног, а те же ноги с другими числами. Поэтому вьюпорт просто уходит в
    // боевую стойку: смотреть надо на ту же походку, а не на другую.
    editorCombat = gaitDir === 'cbt' ? 1 : 0;
    if (!locoOn) { locoOn = true; gaitPx = 0; gaitPz = 0; locoPlayer?.resetPos(); void ensurePhysics(); }
    renderLoco();
  };
  const setSpeed = (v: 'walk' | 'run'): void => { gaitSpeed = v; applyView(); };
  const setDir = (d: 'fwd' | 'back' | 'str' | 'cbt'): void => { gaitDir = d; applyView(); };
  const sp = el('span', 'color:#7a869e;font-size:10px'); sp.textContent = 'скорость';
  modeRow.append(sp,
    pbtn('ХОДЬБА', () => setSpeed('walk'), gaitSpeed === 'walk'),
    pbtn('БЕГ', () => setSpeed('run'), gaitSpeed === 'run'));
  const dv = el('span', 'color:#7a869e;font-size:10px;margin-left:8px'); dv.textContent = 'направление';
  modeRow.append(dv,
    pbtn('ВПЕРЁД', () => setDir('fwd'), gaitDir === 'fwd'),
    pbtn('НАЗАД', () => setDir('back'), gaitDir === 'back'),
    pbtn('СТРАЙФ', () => setDir('str'), gaitDir === 'str'),
    pbtn('БОЙ', () => setDir('cbt'), gaitDir === 'cbt'));
  const linkBtn = pbtn(gaitLinkLR ? 'Л/П: связаны' : 'Л/П: раздельно', () => { gaitLinkLR = !gaitLinkLR; renderLoco(); }, gaitLinkLR);
  modeRow.append(linkBtn);
  const asymN = Object.keys(gaitAsym).filter((k) => !COL_SFX.some((x) => k.endsWith(x))).length;
  if (asymN) modeRow.append(pbtn(`сброс асимметрии (${asymN})`, () => { for (const k of Object.keys(gaitAsym)) if (!COL_SFX.some((x) => k.endsWith(x))) delete gaitAsym[k]; saveGaitCfg(); renderLoco(); }));
  const strN = Object.keys(gaitStrafe).length + Object.keys(gaitAsym).filter((k) => k.endsWith('@s')).length;
  if (strN) modeRow.append(pbtn(`сброс страйфа (${strN})`, () => {
    for (const k of Object.keys(gaitStrafe)) delete gaitStrafe[k];
    for (const k of Object.keys(gaitAsym)) if (k.endsWith('@s')) delete gaitAsym[k];
    saveGaitCfg(); renderLoco();
  }));
  const bckN = Object.keys(gaitBack).length + Object.keys(gaitAsym).filter((k) => k.endsWith('@b')).length;
  if (bckN) modeRow.append(pbtn(`сброс «назад» (${bckN})`, () => {
    for (const k of Object.keys(gaitBack)) delete gaitBack[k];
    for (const k of Object.keys(gaitAsym)) if (k.endsWith('@b')) delete gaitAsym[k];
    saveGaitCfg(); renderLoco();
  }));
  const cbtN = Object.keys(gaitCombat).length + Object.keys(gaitAsym).filter((k) => k.endsWith('@c')).length;
  if (cbtN) modeRow.append(pbtn(`сброс боя (${cbtN})`, () => {
    for (const k of Object.keys(gaitCombat)) delete gaitCombat[k];
    for (const k of Object.keys(gaitAsym)) if (k.endsWith('@c')) delete gaitAsym[k];
    saveGaitCfg(); renderLoco();
  }));
  const mh = el('div', 'color:#7a869e;font-size:10px;margin-top:2px');
  const spName = gaitSpeed === 'run' ? 'БЕГ' : 'ХОДЬБУ';
  mh.textContent = gaitDir === 'fwd'
    ? `Правишь ${spName} ВПЕРЁД — это база. Между ходьбой и бегом всё интерполируется по скорости.`
    : gaitDir === 'str'
      ? `Правишь ${spName} ВБОК. Отдельная колонка: подмешивается по боковитости хода и ход вперёд не трогает. Ползунок, который ты не тронул, здесь не задан — работает значение «вперёд».`
      : gaitDir === 'back'
        ? `Правишь ${spName} НАЗАД. Отдельная колонка — затем и заведена, что наклон корпуса вперёд при ходе спиной складывается с посадкой тела и персонаж горбится. Не тронул ползунок — работает значение «вперёд».`
        : `Правишь БОЙ (${gaitSpeed === 'run' ? 'бег' : 'ходьба'}). Набор ног ОДИН — бой не второй набор, а те же ноги с другими числами: шире стойка, короче шаг. Подмешивается по боевому состоянию поверх направления; не тронул ползунок — в бою он как вне боя.`;
  box.append(mh);

  /**
   * Строка с ДВУМЯ ползунками: левая сторона и правая.
   * `kw`/`kr` — ключи ходьбы и бега; какой правится, решает переключатель режима.
   * Связаны — пишем общее число и стираем запись асимметрии; разведены — пишем пару в `ASYM`.
   */
  /**
   * Текущее значение ключа С УЧЁТОМ режима и сторон — «а работает ли сейчас эта ручка вообще».
   * Берём МАКСИМУМ по модулю: одной ненулевой стороны хватает, чтобы множитель было на что множить.
   */
  const effAbs = (obj: NumRec, kw: string, kr: string | null): number => {
    const key = gaitSpeed === 'run' && kr ? kr : kw;
    const p = gaitAsym[key];
    const v = p ? Math.max(Math.abs(p[0]), Math.abs(p[1])) : Math.abs(+obj[key]! || 0);
    if (gaitDir === 'fwd') return v;
    const sv = colMapOf(gaitDir)[key];
    return sv !== undefined ? Math.abs(sv) : v;
  };
  /**
   * Строка-ручка.
   *
   * `opts.dep` — ключи АМПЛИТУД, на которые эта ручка множится. Ручка фазы — это множитель, и если
   * множить нечего, она честно ничего не делает: так и было с «фазой плеч» (качание и подъём пояса
   * стояли в нуле, и ползунок выглядел сломанным). Поэтому строка сама говорит, чего ей не хватает,
   * а не молчит. `opts.body` — ручка тела, а не стороны: Л/П у неё не бывает.
   */
  const row2 = (label: string, obj: NumRec, kw: string, kr: string | null, min: number, max: number, step: number,
    opts?: { dep?: [NumRec, string, string | null][]; depLabel?: string; body?: boolean }): void => {
    const onCol = gaitDir !== 'fwd';                 // правим колонку, а не базу («вперёд» — это база)
    const sparse: NumRec = colMapOf(gaitDir);       // какую разрежённую колонку правим
    //  ⚠ НЕ `col`: так зовётся цвет ползунка в строке ниже, и затенение прошло бы молча.
    const sfx = colSfxOf(gaitDir);
    const dead = !!opts?.dep && opts.dep.every(([o, a, b]) => effAbs(o, a, b) < 1e-9);
    const solo = gaitLinkLR || !!opts?.body;
    // В режиме страйфа правится РАЗРЕЖЕННАЯ колонка: ключ страйфа хранится отдельно, пары сторон — под
    // суффиксом `@s`. Нет записи → значение НЕ ЗАДАНО, и ползунок показывает то, что реально играет
    // сейчас (беговое), чтобы первое касание ничего не дёрнуло: он создаёт оверрайд с тем же числом.
    // ⭐ Ключ пары выбирает СКОРОСТЬ — и для базы, и для колонки. Отсюда «шесть конфигов»: у страйфа
    // и у «назад» появились своя ходьба и свой бег вместо одного числа на обе скорости.
    const key = gaitSpeed === 'run' && kr ? kr : kw;
    // Затравка = то, что РЕАЛЬНО играет сейчас: колонка не задана → значение «вперёд» на той же
    // скорости. Первое касание ползунка тогда ничего не дёргает — оно лишь создаёт оверрайд тем же числом.
    const seed = +obj[key]!;
    const setOn = onCol && (sparse[key] !== undefined || gaitAsym[key + sfx] !== undefined);
    const base = onCol ? sparse[key] ?? seed : seed;
    const pair = gaitAsym[onCol ? key + sfx : key];
    const head = el('div', 'display:flex;align-items:baseline;gap:6px;margin-top:6px');
    const nm = el('span', `font-size:11px;color:${dead ? '#6b7180' : onCol && !setOn ? '#6b7180' : '#cfd3e0'}`); nm.textContent = label; head.append(nm);
    if (pair) { const mk = el('span', 'color:#ffd24a;font-size:10px'); mk.textContent = 'Л≠П'; head.append(mk); }
    if (dead) { const mk = el('span', 'color:#c08a50;font-size:10px'); mk.textContent = `нечего вращать: ${opts!.depLabel} = 0`; head.append(mk); }
    if (onCol) {
      const what = gaitDir === 'cbt' ? 'бой' : gaitDir === 'back' ? 'назад' : 'страйф';
      const mk = el('span', `color:${setOn ? '#9ae6a0' : '#6b7180'};font-size:10px`);
      mk.textContent = setOn ? `${what} задан` : 'не задан (= как вперёд)';
      head.append(mk);
    }
    box.append(head);
    /** Одна строка ручки: ползунок ВО ВСЮ ШИРИНУ + поле, куда можно вбить точное число. */
    const one = (i: 0 | 1, col: string, tag: string): void => {
      const row = el('div', 'display:flex;align-items:center;gap:5px;margin-top:2px');
      if (tag) { const t = el('span', `width:12px;font-size:10px;color:${col}`); t.textContent = tag; row.append(t); }
      const sl = el('input', 'flex:1 1 auto;min-width:0;accent-color:' + col) as HTMLInputElement;
      sl.type = 'range'; sl.min = String(min); sl.max = String(max); sl.step = String(step);
      sl.value = String(pair ? pair[i] : base);
      // Поле-число: у широких диапазонов ползунком в точное значение не попасть, а вбить — всегда.
      const num = el('input', `width:54px;background:#0e1016;color:${col};border:1px solid #39415a;border-radius:3px;font:10px monospace;text-align:right`) as HTMLInputElement;
      num.type = 'number'; num.min = String(min); num.max = String(max); num.step = String(step); num.value = sl.value;
      const put = (nv: number): void => {
        if (onCol) {
          if (solo) { sparse[key] = nv; delete gaitAsym[key + sfx]; }
          else { const cur: [number, number] = gaitAsym[key + sfx] ?? [base, base]; cur[i] = nv; gaitAsym[key + sfx] = cur; }
        } else if (solo) { obj[key] = nv; delete gaitAsym[key]; }
        else { const cur = gaitAsym[key] ?? [base, base]; cur[i] = nv; gaitAsym[key] = cur; }
        saveGaitCfg();
        if (onCol && !setOn) renderLoco();   // «не задан» → «задан»: перерисовать метку строки
      };
      sl.oninput = () => { const nv = parseFloat(sl.value); num.value = sl.value; put(nv); };
      num.oninput = () => { const nv = parseFloat(num.value); if (!Number.isFinite(nv)) return; sl.value = String(nv); put(nv); };
      row.append(sl, num); box.append(row);
    };
    // Связаны — ОДИН длинный ползунок на всю ширину (стороны всё равно равны). Развели — два, и каждый
    // всё равно во всю ширину, просто в своей строке: ход важнее экономии высоты.
    if (solo && !pair) one(0, '#9ae6a0', '');
    else { one(0, '#5aa0ff', 'Л'); one(1, '#ff6a6a', 'П'); }
  };
  /** Ползунок БЕЗ сторон и без режима — то, чего у тела ровно одно. */
  const one1 = (label: string, obj: NumRec, key: string, min: number, max: number, step: number): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px');
    const nm = el('span', 'flex:0 0 138px;font-size:11px'); nm.textContent = label; row.append(nm);
    const sl = el('input', 'flex:1 1 auto;min-width:0') as HTMLInputElement; sl.type = 'range'; sl.min = String(min); sl.max = String(max); sl.step = String(step); sl.value = String(obj[key]);
    const v = el('span', 'width:42px;text-align:right;color:#9ae6a0;font-size:11px'); v.textContent = (+obj[key]!).toFixed(2);
    sl.oninput = () => { obj[key] = parseFloat(sl.value); v.textContent = obj[key]!.toFixed(2); saveGaitCfg(); };
    row.append(sl, v); box.append(row);
  };
  const hint = el('div', 'color:#7a869e;font-size:10px;margin-top:4px');
  hint.textContent = 'В каждой строке два ползунка: СИНИЙ — левая сторона, КРАСНЫЙ — правая.';
  box.append(hint);

  grp('поза (ретаргет)');
  row2('руки вниз', GXo, 'armDown', 'armDownRun', 0, 3, 0.01);
  grp('руки (мах)');
  // ⚠ ПОЧЕМУ РУЧКИ РУК «МАЛО РЕАГИРУЮТ». Если у оружия есть авторская idle-стойка, верх тела
  // блендится к ней с весом `hw = 1 − sway·moveMag` (`poseRuntime.applyUpper`), и гейту остаётся РОВНО
  // `sway·moveMag`. При sway 0.2 это пятая часть хода ползунка (ЗАМЕР: «локоть — база» край→край даёт
  // 183.3° без стойки и всего 36.7° с ней). Раньше об этом нигде не говорилось, и ручка выглядела сломанной.
  {
    const st = stanceClip(weapon);
    if (st) {
      const note = el('div', 'font-size:10px;margin:2px 0 3px');
      const say = (sw: number): void => {
        note.style.color = sw < 0.35 ? '#e0a05a' : '#7a869e';
        note.textContent = '⚠ руками владеет авторская стойка «' + st.name + '» на ' + Math.round((1 - sw) * 100)
          + ' %, ползункам ниже остаётся ' + Math.round(sw * 100) + ' % хода (на полном ходу; стоя стойка владеет целиком). '
          + 'Видимый угол = ' + sw.toFixed(2) + '·гейт + ' + (1 - sw).toFixed(2) + '·стойка.';
      };
      say(swayOf(weapon));
      box.append(note);
      // ⭐ ДОЛЯ ГЕЙТА НАД РУКАМИ — ЗДЕСЬ, А НЕ ТОЛЬКО НА «АНИМАЦИИ». Это ТОТ ЖЕ `pe_sway`, не копия:
      // ручка живёт там, где ею пользуются. Без неё «локоть на максимуме, а согнут чуть-чуть» не лечится
      // вообще ничем на этой вкладке — потолок ставит не ползунок локтя, а вес стойки.
      // ЗАМЕР (рыцарь+топор, обе скорости на максимуме): sway 0.30 → сгиб 63.2°, ход ручки 41.3°.
      const swRow = el('label', 'display:flex;align-items:center;gap:6px;margin:0 0 5px');
      swRow.innerHTML = '<span style="flex:1;font-size:11px;color:#9ae6a0">доля гейта над руками (остаточный мах)</span>';
      const swS = el('input', 'width:120px') as HTMLInputElement;
      swS.type = 'range'; swS.min = '0'; swS.max = '1'; swS.step = '0.05'; swS.value = String(swayOf(weapon));
      const swV = el('span', 'width:34px;text-align:right;color:#9ae6a0;font-size:11px');
      swV.textContent = swayOf(weapon).toFixed(2);
      swS.oninput = () => {
        const nv = parseFloat(swS.value);
        (swayCfg[curCharId] ??= {})[weapon] = nv;
        swV.textContent = nv.toFixed(2); say(nv); saveSway();
      };
      swRow.append(swS, swV); box.append(swRow);
    }
  }
  row2('база плеча (− вперёд / + назад)', POSEo, 'armSh', 'armShRun', -1.6, 1.6, 0.01);
  row2('амплитуда маха', POSEo, 'armSwing', 'armSwingRun', 0, 3, 0.01);
  // ⚠ Потолок = предел сустава плеча (±1.7…1.9). Выше π рука заворачивается и «скачет назад».
  one1('потолок маха плеча (предел сустава)', POSEo, 'armSwingMax', 0.2, 3.1, 0.01);
  row2('фаза маха рук (−1 зеркально)', POSEo, 'armPhase', 'armPhaseRun', -1, 1, 0.05,
    { dep: [[POSEo, 'armSwing', 'armSwingRun']], depLabel: 'амплитуда маха' });
  // ЛОКОТЬ: ровно две ручки вместо трёх. База — средний угол, амплитуда — насколько и КОГДА он гнётся
  // (в такт маху: вперёд подбирается, назад распрямляется). Прежние «сгиб локтя» и «добавка на ходу»
  // сложены в базу при загрузке (`foldElbow`) — угол тот же, ползунков меньше.
  row2('локоть — база', POSEo, 'armEl', 'armElRun', 0, 2.4, 0.01);   // 2.4 = предел шарнира ForeL/ForeR, см. POSE.elbowMax
  row2('локоть — амплитуда', POSEo, 'armElAmp', 'armElAmpRun', -2, 2, 0.01);
  // НАПРАВЛЕНИЕ сгиба (полюс), а не величина: крутит плечо вдоль кости — локти «крыльями» или прижаты.
  // Потолка нет осознанно: сустав плеча по твисту свободен (±π), упираться не во что — в отличие от колена.
  row2('разворот локтя (+ наружу / − внутрь)', POSEo, 'elbowDir', 'elbowDirRun', -1.6, 1.6, 0.01);
  grp('плечи (ключицы)');
  row2('подъём плеча', POSEo, 'shoUp', 'shoUpRun', -1.2, 1.2, 0.01);
  row2('вынос вперёд', POSEo, 'shoFwd', 'shoFwdRun', -1.2, 1.2, 0.01);
  row2('скрутка', POSEo, 'shoTw', 'shoTwRun', -1.2, 1.2, 0.01);
  row2('качание за рукой', POSEo, 'shoSwing', 'shoSwingRun', 0, 3, 0.01);
  row2('подъём за рукой', POSEo, 'shoLift', 'shoLiftRun', 0, 3, 0.01);
  row2('фаза плеч (−1 к руке в противофазу)', POSEo, 'shoPhase', 'shoPhaseRun', -1, 1, 0.05,
    { dep: [[POSEo, 'shoSwing', 'shoSwingRun'], [POSEo, 'shoLift', 'shoLiftRun']], depLabel: 'качание/подъём за рукой' });
  const sn = el('div', 'color:#7a869e;font-size:10px;margin-top:2px');
  sn.textContent = '⚠ Эти ручки двигают КАЖДУЮ ключицу отдельно (пожатие плечом). «Одно плечо вперёд, другое назад» — это НЕ здесь, это скрутка корпуса ниже. Фаза — множитель: пока качание и подъём в нуле, крутить ей нечего.';
  box.append(sn);
  grp('корпус: скрутка в такт шагу');
  row2('скрутка — поясница', POSEo, 'twistSwing', 'twistSwingRun', -1.2, 1.2, 0.01, { body: true });
  row2('скрутка — грудь', POSEo, 'twistChest', 'twistChestRun', -1.2, 1.2, 0.01, { body: true });
  row2('скрутка — ВЕРХНЯЯ грудь (плечи)', POSEo, 'twistUpper', 'twistUpperRun', -1.2, 1.2, 0.01, { body: true });
  row2('фаза скрутки (−1 зеркально)', POSEo, 'twistPhase', 'twistPhaseRun', -1, 1, 0.05,
    { body: true, dep: [[POSEo, 'twistSwing', 'twistSwingRun'], [POSEo, 'twistChest', 'twistChestRun'], [POSEo, 'twistUpper', 'twistUpperRun']], depLabel: 'скрутка' });
  const tn = el('div', 'color:#7a869e;font-size:10px;margin-top:2px');
  tn.textContent = 'ЭТО и есть «рука вперёд → ключица назад»: корпус крутится, плечи разъезжаются. Три яруса — где именно гнётся: поясница крутит всё тело, ВЕРХНЯЯ ГРУДЬ сидит под самыми ключицами и разводит плечи, не трогая талию. Раньше был один зашитый ярус на 8° — потому и «не скручивается».';
  box.append(tn);

  grp('корпус: наклон и живость');
  row2('наклон вперёд на ходу', POSEo, 'leanWalk', 'leanWalkRun', -0.6, 0.9, 0.01, { body: true });
  row2('наклон от скорости', POSEo, 'leanSpeed', 'leanSpeedRun', -0.6, 0.9, 0.01, { body: true });
  row2('боковое качание', POSEo, 'leanSideSwing', 'leanSideSwingRun', -0.8, 0.8, 0.01, { body: true });
  one1('наклон стоя', POSEo, 'leanIdle', -0.4, 0.6, 0.01);
  one1('амплитуда качания: база', POSEo, 'swingBase', 0, 2, 0.01);
  one1('амплитуда качания: от скорости', POSEo, 'swingSpeed', 0, 2, 0.01);
  const an = el('div', 'color:#7a869e;font-size:10px;margin-top:2px');
  an.textContent = 'Амплитуда качания множится на ВСЁ сразу — руки, плечи, скрутку, боковое качание. Ею регулируется «живость» походки целиком, не трогая каждую ось.';
  box.append(an);

  grp('ноги / посадка');
  row2('присед (мин. таз)', GAITo, 'pelvisMin', 'pelvisMinRun', 6, 40, 0.25);
  // ⭐ ГЕОМЕТРИЯ, А НЕ СТИЛЬ: таз опускается ровно настолько, чтобы стопа доставала до пола.
  // Лечит «в боевом idle ноги висят в воздухе»: боевая стойка ШИРЕ, а просадка ширину не видит.
  row2('таз по досягаемости ног (0 = как было)', GAITo, 'pelvisReach', 'pelvisReachRun', 0, 1, 0.05);
  row2('длина шага', GAITo, 'stepWalk', 'stepRun', 2, 140, 0.5);
  row2('боб таза ×', GAITo, 'bobWalk', 'bobRun', 0, 5, 0.02);
  // ПРОСАДКА. Высота таза на ходу отсчитывается от АВТОРСКОЙ СТОЙКИ, а её авторят почти на
  // прямых ногах — бег выходил «на ходулях». `присед` ниже — только ПРЕДЕЛ, он не опускает.
  row2('просадка таза от стойки (на ходу)', GAITo, 'crouchWalk', 'crouchRun', 0, 8, 0.05, { body: true });
  // ТАЗ В ДВУХ ПЛОСКОСТЯХ + боковой перевал. Раньше таз умел только вверх-вниз.
  row2('качание таза вбок (юниты)', POSEo, 'hipSway', 'hipSwayRun', -4, 4, 0.05, { body: true });
  row2('крен таза (вбок)', POSEo, 'hipsRollSwing', 'hipsRollSwingRun', -0.5, 0.5, 0.01, { body: true });
  row2('наклон таза (вперёд/назад)', POSEo, 'hipsPitchSwing', 'hipsPitchSwingRun', -0.5, 0.5, 0.01, { body: true });
  // Крен/наклон таза наследуются ВСЕМ телом (Hips — корневая кость). Эти две ручки держат корпус
  // вертикальным и не дают ногам гулять за тазом. 1 = держим, 0 = наследует как есть.
  one1('при крене таза: держать КОРПУС вертикально', POSEo, 'hipsTiltHoldBody', 0, 1, 0.05);
  one1('при крене таза: держать НОГИ', POSEo, 'hipsTiltHoldLegs', 0, 1, 0.05);
  // ПЛАВНОСТЬ БОБА. Числа были зашиты (14 / 10 / без фильтра), причём «вниз на ходьбе» шло БЕЗ
  // фильтра вовсе, а порог `speedWalk` переключал скорость скачком. Теперь это обычная пара ходьба/бег.
  row2('плавность боба ↑ (меньше = мягче)', GAITo, 'bobLagUp', 'bobLagUpRun', 1, 60, 0.5, { body: true });
  row2('плавность боба ↓ (меньше = мягче)', GAITo, 'bobLagDown', 'bobLagDownRun', 1, 60, 0.5, { body: true });
  one1('таз в полёте тянется к стойке (0 = держит высоту отрыва)', GAITo, 'bobFlight', 0, 1, 0.02);
  const bobNote = el('div', 'color:#7a869e;font-size:10px;margin-top:2px');
  bobNote.textContent = 'В полёте опорной ноги нет, и раньше таз тянуло на ПОЛНЫЙ рост стоя, а в кадр касания срывало вниз. Замер на бегу: верх дуги 34.757 при росте стоя 34.769, падение 0.223 за кадр. Убавь — и рывок в касании уходит.';
  box.append(bobNote);
  grp('заземление стоп');
  one1('плавность заземления (меньше = мягче)', GAITo, 'gndLag', 1, 40, 0.5);
  row2('окно: вход в опору (доля фазы)', GAITo, 'gndIn', 'gndInRun', 0, 0.9, 0.01, { body: true });
  row2('окно: выход из опоры (доля фазы)', GAITo, 'gndOut', 'gndOutRun', 0.1, 1, 0.01, { body: true });
  // ⭐ ОТДЕЛЬНО ОТ ОКНА: то правит ВЫСОТУ, а это — УГОЛ («стопа приколачивается к полу»).
  row2('мягкость постановки стопы (доля фазы)', GAITo, 'footPlant', 'footPlantRun', 0, 0.45, 0.01, { body: true });
  const gndNote = el('div', 'color:#7a869e;font-size:10px;margin-top:2px');
  gndNote.textContent = '0 = касание, 1 = отрыв. Заземление набирает силу на отрезке [0 … вход] и отпускает на [выход … 1]. Вход 0 и выход 1 = как было: опора БУЛЕВА, и стопа падала на пол за один кадр (замер: 3.655 → 1.710). Подними вход и опусти выход — стопа будет подходить к полу и уходить с него плавно.';
  box.append(gndNote);
  row2('подъём стопы', GAITo, 'liftWalk', 'liftRun', 0, 45, 0.25);
  row2('доля опоры', GAITo, 'dutyWalk', 'dutyRun', 0.05, 0.9, 0.005);
  row2('потолок бедра', GAITo, 'hipFwdLim', 'hipFwdLimRun', 0.1, 2.2, 0.01);
  row2('амплитуда бедра', GAITo, 'hipSwing', 'hipSwingRun', 0.2, 3, 0.01);
  // ГОЛЕНОСТОП. Правит ТОЛЬКО маховую ногу: опорную забирает заземление и кладёт плоско на пол,
  // поэтому ручки «носок в опоре» здесь нет — она была бы мёртвой.
  row2('держать подошву (0 = болтается за голенью)', GAITo, 'ankLevel', 'ankLevelRun', 0, 1.4, 0.01);
  // ⭐ ОКНО УДЕРЖАНИЯ: держать не весь перенос, а отрезок. Рампы СНАРУЖИ окна → умолчание [0,1] = как было.
  row2('держать: начало окна (0 = отрыв)', GAITo, 'ankHoldFrom', 'ankHoldFromRun', 0, 1, 0.01, { body: true });
  row2('держать: конец окна (1 = касание)', GAITo, 'ankHoldTo', 'ankHoldToRun', 0, 1, 0.01, { body: true });
  row2('держать: плавность краёв окна', GAITo, 'ankHoldEase', 'ankHoldEaseRun', 0, 0.5, 0.01, { body: true });
  {
    // ⚠ ЗАКРЫТОЕ ОКНО МОЛЧА ВЫКЛЮЧАЕТ УДЕРЖАНИЕ. Живой случай: `from` 0.08 при `to` 0 — и ручка
    // «держать подошву», выкрученная в 1.4, не делала ничего. Пишем прямо, а не оставляем гадать.
    const closed = (GAITo['ankHoldTo'] ?? 1) <= (GAITo['ankHoldFrom'] ?? 0)
      || (GAITo['ankHoldToRun'] ?? 1) <= (GAITo['ankHoldFromRun'] ?? 0);
    if (closed) {
      const warn = el('div', 'color:#e08080;font-size:10px;margin:2px 0 6px');
      warn.textContent = '⚠ окно удержания ЗАКРЫТО (конец ≤ начала) — «держать подошву» сейчас не действует вовсе.';
      box.append(warn);
    }
  }
  row2('подъём носка поверх удержания', GAITo, 'toeLift', 'toeLiftRun', 0, 1.2, 0.01);
  // ЗАГИБ НОСКА НА ПЕРЕКАТЕ. Отдельно от «подъёма носка»: тот даёт клиренс В ПЕРЕНОСЕ и по
  // построению ноль на отрыве, поэтому провал носка под пол им было не вылечить.
  row2('загиб носка на отрыве', GAITo, 'toeOff', 'toeOffRun', 0, 1.2, 0.01);
  row2('загиб: начало окна (1 = отрыв)', GAITo, 'toeOffFrom', 'toeOffFromRun', 0, 2, 0.02, { body: true });
  row2('загиб: конец окна', GAITo, 'toeOffTo', 'toeOffToRun', 0, 2, 0.02, { body: true });
  row2('где пик подъёма (0.5 = середина)', GAITo, 'toeLiftPhase', 'toeLiftPhaseRun', 0.05, 0.95, 0.01,
    { dep: [[GAITo, 'toeLift', 'toeLiftRun']], depLabel: 'подъём носка' });
  // ⚠ Потолок = предел сустава физ-рига (±0.45). Выше — манекен покажет то, чего призрак не даст.
  one1('потолок голеностопа (предел сустава)', GAITo, 'ankMax', 0.05, 1.2, 0.01);
  // НАПРАВЛЕНИЕ сгиба колена (полюс): крутит бедро вдоль кости, стопа едет за ним («носки врозь»).
  row2('разворот колена (+ наружу / − внутрь)', GAITo, 'kneeDir', 'kneeDirRun', -0.9, 0.9, 0.01);
  // ⚠ Потолок = твист-предел сустава бедра (±0.7). Выше — манекен покажет то, чего призрак не даст.
  one1('потолок разворота колена (предел сустава)', GAITo, 'kneeDirMax', 0.05, 1.2, 0.01);
  // ТРИ НЕЗАВИСИМЫЕ ОСИ «НАРУЖУ/ВНУТРЬ». Раньше была одна — колено, а оно крутит бедро,
  // то есть уводит ВСЮ ногу вместе со стопой. Теперь носок и развод бёдер правятся отдельно.
  row2('разворот СТОПЫ / носок (+ наружу / − внутрь)', POSEo, 'footTurn', 'footTurnRun', -0.9, 0.9, 0.01);
  row2('развод БЁДЕР — вся нога от бедра (+ наружу)', POSEo, 'hipSplay', 'hipSplayRun', -0.5, 0.5, 0.01);
  row2('ширина стойки', GAITo, 'stanceWidth', 'stanceWidthRun', -20, 30, 0.25);
  row2('вынос вбок (страйф)', GAITo, 'strafeReach', 'strafeReachRun', 0, 3, 0.02);
  row2('предел кроссовера', GAITo, 'crossClamp', 'crossClampRun', 0, 99, 1);
  one1('мягкость потолка бедра', GAITo, 'hipFwdSoft', 0.01, 1.2, 0.01);
  one1('вынос стопы вперёд ×шаг', GAITo, 'aheadMul', -1, 1.5, 0.01);
  one1('предсказание по скорости (с)', GAITo, 'predictSec', 0, 0.5, 0.005);
  one1('цель фиксируется на отрыве', GAITo, 'fixTarget', 0, 1, 1);
  one1('зазор между стопами', GAITo, 'footClear', 0, 24, 0.5);
  grp('общее (одно на тело)');
  one1('скорость анимации бега (антискольз.)', GAITo, 'cadence', 0.2, 4, 0.02);
  one1('порог ходьбы (u/с)', GAITo, 'speedWalk', 5, 150, 1);
  one1('порог бега (u/с)', GAITo, 'speedRun', 20, 400, 1);
  one1('страйф от (°)', GAITo, 'strafeFrom', 0, 89, 1);
  one1('страйф до (°)', GAITo, 'strafeTo', 1, 90, 1);
  grp('резкая смена направления');
  one1('усреднение направления (с)', GAITo, 'planSmooth', 0, 1.2, 0.01);
  one1('запас выноса до «пора шагать»', GAITo, 'stepSlack', 0.1, 1.2, 0.05);
  one1('ускорение просроченного шага', GAITo, 'stepUrge', 0, 30, 0.5);
  const fn = el('div', 'color:#7a869e;font-size:10px;margin-top:2px');
  fn.textContent = 'Нули = старое поведение: нога вылетает на полную длину, если попасть падом в такт шага.';
  box.append(fn);
  // ── ОБУЧЕНИЕ НА КЛИПЕ (Ф3) ──────────────────────────────────────────────────────────────────────
  // Ставится ЗДЕСЬ, а не в панели импорта, ровно по одной причине: оно правит эти самые ползунки,
  // и «было → стало» надо видеть рядом с ними. Ничего не применяется молча — сперва список, потом кнопка.
  // ── ПРОЦЕДУРНО ↔ КЛИП (Ф4) ──────────────────────────────────────────────────────────────────────
  grp('процедурно ↔ клип');
  one1('доля клипа локомоции', GAITo, 'locoMix', 0, 1, 0.01);
  {
    const n2 = el('div', 'color:#7a869e;font-size:10px;margin-top:2px');
    n2.textContent = '0 — только процедурная походка (ровно как было, бит в бит). К 1 подмешивается клип '
      + '`walk_fwd` / `run_strafe_L` и т.п. по направлению и режиму. ⚠ Планировщик остаётся ЧАСАМИ: клип '
      + 'сэмплируется его фазой, поэтому длина шага, доля опоры и каденция продолжают на него влиять — '
      + 'это и есть «из купленного пака много вариантов». Опорная стопа подтягивается к планту, чтобы не скользила.';
    box.append(n2);
  }

  grp('обучить на клипе');
  {
    const mine = [...new Set(library.filter((c) => c.character === curCharId).map((c) => c.name))].sort();
    const row = el('div', 'display:flex;gap:4px;align-items:center;margin-top:3px');
    const sel = el('select', 'flex:1 1 auto;min-width:0;background:#0e1016;color:#cfd3e0;border:1px solid #39415a;border-radius:3px;font:10px monospace') as HTMLSelectElement;
    for (const n of mine) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.append(o); }
    if (learnClip && mine.includes(learnClip)) sel.value = learnClip;
    sel.onchange = () => { learnClip = sel.value; };
    row.append(sel); box.append(row);
    const spRow = el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px');
    const spN = el('span', 'flex:0 0 138px;font-size:11px'); spN.textContent = 'скорость клипа (ед/с)'; spRow.append(spN);
    const spI = el('input', 'width:64px;background:#0e1016;color:#9ae6a0;border:1px solid #39415a;border-radius:3px;font:10px monospace;text-align:right') as HTMLInputElement;
    spI.type = 'number'; spI.step = '1'; spI.value = String(learnSpeed);
    spI.oninput = () => { learnSpeed = parseFloat(spI.value) || 0; };
    spRow.append(spI); box.append(spRow);
    const sn2 = el('div', 'color:#7a869e;font-size:10px;margin-top:2px');
    sn2.textContent = 'Клип in-place и сам о скорости не знает. Есть канал корня (галка при импорте) — она берётся оттуда, иначе укажи здесь.';
    box.append(sn2);
    box.append(pbtn('замерить', () => {
      const c = library.find((x) => x.name === (learnClip || sel.value) && x.character === curCharId);
      if (!c) { learnInfo = 'клип не найден'; learnList = null; renderLoco(); return; }
      const m = analyzeGait(c, { human, speed: learnSpeed > 0 ? learnSpeed : undefined });
      const cur: NumRec = { ...(GAIT as unknown as NumRec), ...(POSE as unknown as NumRec) };
      learnList = gaitSuggestions(m, cur, gaitSpeed === 'run');
      learnInfo = `период ${m.periodSec.toFixed(2)} с · шаг ${m.stepLen === null ? '—' : m.stepLen.toFixed(1)}`
        + ` · опора ${(m.duty * 100) | 0}% · подъём ${m.lift.toFixed(1)}`
        + (m.slide === null ? '' : ` · скольжение ${(m.slide * 100) | 0}%`)
        + (m.turnRad ? ` · поворот ${(m.turnRad * 180 / Math.PI).toFixed(0)}°` : '');
      renderLoco();
    }));
    if (learnInfo) { const i2 = el('div', 'color:#9ae6a0;font-size:10px;margin-top:3px;font-family:monospace'); i2.textContent = learnInfo; box.append(i2); }
    if (learnList) {
      if (!learnList.length) { const e2 = el('div', 'color:#7a869e;font-size:10px;margin-top:3px'); e2.textContent = 'всё уже совпадает — менять нечего'; box.append(e2); }
      for (const g of learnList) {
        const r2 = el('div', 'display:flex;gap:6px;font:10px monospace;margin-top:1px');
        const n2 = el('span', 'flex:1 1 auto;color:#cfd3e0'); n2.textContent = g.label;
        const w2 = el('span', 'color:#7a869e'); w2.textContent = g.was.toFixed(2);
        const a2 = el('span', 'color:#6b7180'); a2.textContent = '→';
        const v2 = el('span', 'color:#9ae6a0'); v2.textContent = g.now.toFixed(2);
        r2.append(n2, w2, a2, v2); box.append(r2);
      }
      if (learnList.length) {
        box.append(pbtn('применить всё', () => {
          for (const g of learnList!) {
            if (g.key in (GAIT as unknown as NumRec)) (GAIT as unknown as NumRec)[g.key] = g.now;
            else (POSE as unknown as NumRec)[g.key] = g.now;
          }
          saveGaitCfg(); learnList = null; learnInfo = 'применено'; renderLoco();
        }, true));
      }
    }
  }

  box.append(pbtn('сброс настроек бега', () => { delete gaitCfgs[curCharId]; try { localStorage.setItem('pe_gait', JSON.stringify(gaitCfgs)); savePoseKey('pe_gait'); } catch { /* */ } applyGaitCfg(curCharId); renderLoco(); }));
  const twNote = el('div', 'color:#7a869e;font-size:10px;margin-top:6px'); twNote.textContent = 'Скрутка корпуса и приставной шаг при повороте — на вкладке «Повороты».'; box.append(twNote);
  // Экспорт/импорт настроек бега ВСЕХ персонажей (pe_gait) — портируемый артефакт (бэкап + вход для Ф5).
  const eh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px;font-size:11px'); eh.textContent = 'НАСТРОЙКИ БЕГА → JSON (все персонажи)'; box.append(eh);
  const ga = el('textarea', 'width:100%;height:56px;background:#0e1016;color:#9ae6a0;border:1px solid #39415a;border-radius:4px;font:10px monospace') as HTMLTextAreaElement; box.append(ga);
  const gr = el('div', 'display:flex;gap:2px;margin-top:2px'); box.append(gr);
  gr.append(
    pbtn('экспорт', () => { saveGaitCfg(); ga.value = JSON.stringify(gaitCfgs); }),
    pbtn('копир походку', () => navigator.clipboard?.writeText(ga.value)),
    pbtn('импорт походку', () => { try { const d = JSON.parse(ga.value) as typeof gaitCfgs; if (d && typeof d === 'object') { gaitCfgs = d; localStorage.setItem('pe_gait', JSON.stringify(gaitCfgs)); savePoseKey('pe_gait'); applyGaitCfg(curCharId); renderLoco(); } } catch { /* */ } }),
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
    // Кольцо цели — мысль ПЛАНИРОВЩИКА. В «только клипы» его нет, и кольцо стояло бы в нуле мира — прячем.
    const planner = !lp().clipOnly;
    cur.visible = show; goal.visible = show && planner;
    if (!show) continue;
    const fb = viewBone(i === 0 ? 'LeftFoot' : 'RightFoot');   // ТЕКУЩАЯ позиция стопы — сфера; Ф20.2: где СТОИТ видимая нога
    if (fb) { const fp = fb.getWorldPosition(V()); setXZ(cur, fp.x, fp.z); }
    if (!planner) continue;
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

  // ── СТОЙКА: спокойная ↔ боевая ────────────────────────────────────────────────────────────────
  // Та же ручка, что у превью на вкладке «Бег» (`editorCombat` → `player.setCombat`), поэтому
  // переключение видно и в походке, и здесь. Смотреть надо именно ЗДЕСЬ: боевая стойка НИЖЕ и ШИРЕ,
  // и пока планировщик мерил её как спокойную, поворот на месте ПОДНИМАЛ таз к спокойной высоте.
  const stRow = el('div', 'display:flex;gap:4px;margin:2px 0 4px;align-items:center'); box.append(stRow);
  stRow.append(
    pbtn('спокойная', () => { editorCombat = 0; renderTurn(); }, !editorCombat),
    pbtn('боевая', () => { editorCombat = 1; renderTurn(); }, !!editorCombat),
  );
  {
    // ЖИВОЙ ЗАМЕР той самой стойки, которую получает планировщик — чтобы «работает ли» читалось
    // числом, а не на глаз. Это ровно `PosePlayer.measureStance()`: тот же резолвер, тот же combat.
    const p0 = measureStancePlants(human, resolveUpper(weapon, 0, 0)?.pose ?? null);
    const p1 = measureStancePlants(human, resolveUpper(weapon, 1, 0)?.pose ?? null);
    const cur = editorCombat ? p1 : p0;
    const num = (v: number): string => v.toFixed(2);
    const line = el('div', 'color:#9ae6a0;font-size:10px;margin-bottom:6px');
    line.innerHTML = `стойка сейчас: таз <b>${num(cur.standY)}</b> · стопы ${num(cur.latL)} / ${num(cur.latR)}`
      + `<span style="color:#7a869e"> &nbsp;(спокойная ${num(p0.standY)} · ${num(p0.latL)}/${num(p0.latR)}`
      + ` &nbsp;боевая ${num(p1.standY)} · ${num(p1.latL)}/${num(p1.latR)})</span>`;
    box.append(line);
    const hint = el('div', 'color:#7a869e;font-size:10px;margin-bottom:6px');
    hint.textContent = 'Крутись на месте (веди курсором вокруг) и смотри на таз: он обязан держаться на высоте ТЕКУЩЕЙ стойки. '
      + 'Раньше планировщик всегда получал спокойную — и в бою таз на повороте подскакивал.';
    box.append(hint);
  }

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
  // ⭐ ТОЧКА НЕВОЗВРАТА ШАГА: раньше неё резкая остановка перецеливает летящую ногу в стойку, позже — даёт ей донести шаг.
  sl('точка невозврата шага', () => GAITo['stepCommit']!, (v) => { GAITo['stepCommit'] = v; }, 0, 1, 0.05, saveGaitCfg);
  // ⭐ ТУМБЛЕР «УХОД В IDLE». Выключенным видно походку БЕЗ перехода планировщик→авторская стойка —
  // того самого, который читается как «доступил, а потом раздвигается и ступни скручиваются».
  box.append(pbtn(GAITo['idleSettle'] ? '✔ уход в idle-позу: вкл' : '✖ уход в idle-позу: выкл',
    () => { GAITo['idleSettle'] = GAITo['idleSettle'] ? 0 : 1; saveGaitCfg(); renderTurn(); }, !!GAITo['idleSettle']));
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
  sep(),
  // Ретайминг ВСЕГО клипа: выделять все ключи ради этого — лишний шаг, а операция частая (подогнать
  // длительность под окно атаки). Метки едут вместе с ключами, отрезки (`dur`) масштабируются так же.
  mkBtn('⟷ клип ×1.25', () => retimeClip(1.25)),
  mkBtn('⟷ клип ×0.8', () => retimeClip(0.8)),
  sep(),
  mkBtn('⧉ копир. кадры', () => { const c = curClip(); if (!c) return; keyBuf = tlSel().map((i) => c.keys[i]).filter((k): k is Keyframe => !!k).map(cloneKeyDeep); }),
  mkBtn('⤓ вставить кадры', () => pasteKeys()),
);
/** Буфер копирования кадров (переживает переключение клипа/оружия — тем и полезен). */
let keyBuf: Keyframe[] = [];
const cloneKeyDeep = (k: Keyframe): Keyframe => ({ ...k, pose: clonePose(k.pose), marks: k.marks?.map((m) => ({ ...m })) });
/** Растянуть/сжать клип целиком вокруг нуля. Метки-отрезки масштабируются вместе с временем. */
function retimeClip(f: number): void {
  const c = curClip(); if (!c || c.keys.length < 2) return;
  histLib('ретайминг клипа', () => {
    for (const k of c.keys) {
      k.t = +(k.t * f).toFixed(4);
      for (const m of k.marks ?? []) if (m.dur !== undefined) m.dur = +(m.dur * f).toFixed(4);
    }
    saveLib(); refreshAll();
  });
}
/** Вставить скопированные кадры ПОСЛЕ текущего, сохранив их взаимные интервалы. */
function pasteKeys(): void {
  const c = curClip(); if (!c || !keyBuf.length) return;
  histLib('вставить кадры', () => {
    const t0 = keyBuf[0]!.t, at = c.keys[frameIdx]?.t ?? 0;
    const add = keyBuf.map((k) => ({ ...cloneKeyDeep(k), t: +(at + (k.t - t0) + DEF_GAP).toFixed(4) }));
    c.keys.push(...add); sortKeys(c); saveLib(); refreshAll();
  });
}

let keyDragUndo: LibState | null = null;   // снимок на НАЧАЛЕ драга ключей (см. `curveUndo` — та же грабля)
const tl: TimelinePanel = makeTimelinePanel(tlBody, {
  clip: () => curClip(),
  frameIdx: () => frameIdx,
  playT: () => playT,
  pro: () => uiPro,
  onSelectFrame: (i) => goFrame(i),
  onScrub: (t) => { playT = t; preview(t); if (ikOn) captureRig(); },
  // Драг ключей: тот же паттерн, что у ручек кривой — снимок ДО первой правки, одна запись в историю на отпускании.
  // Пока тащим — только время и перерисовка: ни сортировки (перетасует массив под драгом), ни `saveLib`
  // (это POST всей библиотеки на каждое движение мыши, и он fire-and-forget → порядок прихода не гарантирован).
  onMoveKeys: (moves) => { const c = curClip(); if (!c) return; if (!keyDragUndo) keyDragUndo = libSnap(); setKeyTimes(moves); tl.draw(); },
  onMoveEnd: () => {
    const c = curClip(); if (!c) return;
    sortKeys(c); saveLib();
    if (keyDragUndo) { const before = keyDragUndo, after = libSnap(); history.push('сдвиг кадров', () => libRestore(before), () => libRestore(after)); keyDragUndo = null; }
    refreshAll();
  },
  onSelectionChange: () => { /* кнопки читают выделение лениво, перерисовка не нужна */ },
});
function refreshTimeline(): void {
  const c = curClip();
  tlName.textContent = c ? c.name : '(нет клипа)';
  tl.draw();   // Ф6: ключи/дорожки/плейхед рисует канвас-панель
  if (!c) return;
}
/**
 * ВСТАТЬ НА КАДР — и ОБЯЗАТЕЛЬНО НА ПОЛ (Ф26.1). Раньше восстанавливалась только ПОЗА (повороты костей),
 * а два вертикальных состояния жили своей жизнью: сдвиг заземления призрака (`ghostGround.off`) и корень манекена
 * (`human.reset()` НЕ трогает `Root` — см. `humanoid.ts`). Нет клипа/кадра (сменили оружие на вкладке «Бег») —
 * тем более надо снять высоту: именно там раньше был ранний `return` и персонаж оставался в гейт-позе.
 */
/** Кнопка «этот клип — такая-то стойка». Горит, когда клип и есть текущая роль (по привязке ИЛИ по имени). */
function roleBtn(c: Clip, kind: 'idle' | 'combat_idle', label: string): HTMLElement {
  const on = (kind === 'idle' ? stanceName(weapon) : combatStanceName(weapon)) === c.name;
  const b = pbtn(label, () => { setStanceRole(kind, on ? undefined : c.name); refreshAll(); }, on);
  b.title = on
    ? `«${c.name}» сейчас ${kind === 'idle' ? 'спокойная' : 'боевая'} стойка для «${weapon}». Снять — если имя конвенционное, роль останется за ним по имени.`
    : `назначить «${c.name}» ${kind === 'idle' ? 'спокойной' : 'боевой'} стойкой для «${weapon}» (привязка по ссылке — имя любое)`;
  return b;
}
function goFrame(i: number): void {
  ghostGround.off = 0; human.root.position.y = 0;
  const c = curClip(); if (!c) return;
  frameIdx = i; if (c.keys[i]) applyPose(c.keys[i]!.pose);
  if (ikOn) captureRig();
  refreshAll();
}
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
let manView: 'skel' | 'solid' | 'hidden' = getPref<'skel' | 'solid' | 'hidden'>('mannequin', 'skel');   // вид манекена (личная настройка)
let curHumanStyle: 'solid' | 'skeleton' = 'skeleton';   // с каким стилем реально построен human (чтобы не пересобирать зря)
let showBoxes = getPref('boxes', false);   // дебаг: сырые физ-боксы рэгдолла (по умолчанию — только силуэт-призрак)
/**
 * ВИДИМОСТЬ СЫРЫХ ФИЗ-БОКСОВ — ОДИН ШОВ (Ф26.8). Кукла ПЕРЕСОБИРАЕТСЯ на каждую правку размера/формы
 * (`rebuildRagdoll` → новая `ragdoll.group`), и новая группа приходила в сцену ВСЕГДА скрытой — боксы
 * «пропадали» ровно в тот момент, когда на них и смотрят. Теперь видимость выставляется из `showBoxes`
 * везде, где группа появляется в сцене, а кнопки только переключают флаг.
 */
function applyBoxVis(): void { if (ragdoll) ragdoll.group.visible = showBoxes; }
let footGround = getPref('groundFeet', true);   // заземление стоп (foot-IK) на физ-теле; выкл → авторская ротация стопы видна
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
// Какой режим правим. Страйф — ТРЕТИЙ, а не «бег вбок»: у него своя разреженная колонка (см. `STRAFE`),
// потому что раньше страйф и бег делили одни числа, и настройка одного ломала другое.
/**
 * ЧТО ИМЕННО ПРАВИМ — ДВЕ НЕЗАВИСИМЫЕ ОСИ, а не один ряд кнопок.
 *
 * Раньше «ходьба / бег / страйф / бой» стояли в одном ряду, и это путало: первые две — СКОРОСТЬ,
 * вторые две — КОЛОНКА. Из-за склейки у страйфа не было своей ходьбы и своего бега: одно число
 * работало на обе скорости, и настроить бег назад отдельно от шага назад было негде.
 *
 * Теперь скорость выбирается отдельно от направления: 2 × 3 = ШЕСТЬ конфигов локомоции
 * (вперёд/назад/страйф × ходьба/бег), плюс бой — четвёртая колонка поверх любого из них.
 */
let gaitSpeed: 'walk' | 'run' = 'run';
let gaitDir: 'fwd' | 'back' | 'str' | 'cbt' = 'fwd';
// Обучение на клипе (Ф3): что меряем, с какой скоростью, и что намерили. Ничего не применяется само.
let learnClip = '';
let learnSpeed = 50;
let learnList: GaitSuggestion[] | null = null;
let learnInfo = '';
let gaitLinkLR = true;       // связаны ли стороны: связаны → одно число на обе, иначе пара в ASYM
const gaitAsym = ASYM;       // ссылка на карту асимметрии рантайма (правим её же, что читает игра)
const gaitStrafe = STRAFE;   // ссылка на страйф-колонку рантайма (та же, что читает игра)
const gaitBack = BACK;       // колонка хода спиной — устроена так же и живёт там же
const gaitCombat = COMBAT;   // боевая колонка (Ф6) — устроена так же и живёт там же
/** Суффиксы сторон у КОЛОНОК: всё остальное в `ASYM` — асимметрия базы (хода вперёд). */
const COL_SFX = ['@s', '@b', '@c'] as const;
/** Карта и суффикс колонки по направлению. «Вперёд» колонки не имеет — это и есть база. */
const colMapOf = (d: 'fwd' | 'back' | 'str' | 'cbt'): NumRec => (d === 'cbt' ? gaitCombat : d === 'back' ? gaitBack : gaitStrafe);
const colSfxOf = (d: 'fwd' | 'back' | 'str' | 'cbt'): string => (d === 'cbt' ? '@c' : d === 'back' ? '@b' : '@s');
let warpReadout: HTMLElement | null = null;                // живой угол доворота таза (Ф0) — глазами его на диагонали не отличить
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
const PLANT_BLUE = 0x4aa0ff, PLANT_RED = 0xff5a4a, MAX_VIA = 3, MARK_Y = 1.5;
/** Полуширина таза ДЛЯ МАРКЕРОВ — та же, что у планировщика (`StepPlanner.hipHalf`), иначе точка рисуется не там, куда идёт нога. */
const hipDxE = (): number => human?.legRest?.hipHalfW ?? HIP_DX;
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
/** Стационарный body-референс: forward=(sin yaw,cos yaw), right=(cos yaw,−sin yaw); хип ноги на ±полутаз РИГА вбок.
 *  Точно совпадает с плант-целью планировщика: tx−gaitPx == refPos(foot, fwdAmt, latAmt). */
function refPos(foot: 0 | 1, fwd: number, lat: number): [number, number] {
  const hx = hipDxE();
  const s = Math.sin(gaitYaw), c = Math.cos(gaitYaw), side = foot === 0 ? hx : -hx;
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
    // Живой: реальная цель ПЛАНИРОВЩИКА, тредмилл-ремап. В «только клипы» его нет — метку не показываем (стояла бы в нуле).
    const lm = liveMarks[i]!; lm.visible = show && !lp().clipOnly;
    if (lm.visible) { const [tx, tz] = lp().driver.plantTarget(foot); setXZ(lm, tx - gaitPx, tz - gaitPz); }
  }
}
/** Ретаргет-крутилки редактора (сверх GAIT/POSE): ширина ног, база «рука вниз», база сгиба локтя, множитель боба. Передаются в общий poseRuntime. */
const GX = { armDown: 1.35, elbowBend: 0.25 };   // legWidth убран (дубль «ширина стойки»); боб таза — в GAIT.bobWalk/bobRun
// Живой контент редактора (библиотека + swayCfg). shieldOverlay — поза щита per-оружие (idle_<wk> → фолбэк idle_shield)
// + вес shieldMixFor(wk) (ползунок), подмешивается ТАК ЖЕ, как в игре: превью '+shield'-оружия показывает микс.
const editorContent: PoseContent = {
  resolveUpper: (w, combat, t) => resolveUpper(w, combat, t),   // t — часы живой стойки (редактор ≡ игра)
  shieldOverlay: (wk) => { const c = stanceClip(wk) ?? stanceClip('shield'); return c && c.keys[0] ? { pose: c.keys[0].pose, mix: shieldMixFor(wk) } : null; },
  /**
   * ⚠⚠ ЭТОГО НЕ БЫЛО ВОВСЕ, и ползунок «доля клипа локомоции» в редакторе крутился ВХОЛОСТУЮ:
   * контент редактора не умел отдавать клип локомоции, поэтому игра играла запечённое, а редактор —
   * всегда процедурку. Проверять запечённый бег было негде — ровно то, что запрещает «редактор ≡ игра».
   *
   * Правило разбора ОБЩЕЕ с игрой (`findLocoClip`): точный набор оружия → безоружный → любой.
   * Разными остаются только источники клипов: здесь живая библиотека, там localStorage.
   */
  locoClip: (names, w) => {
    for (const n of names) { const c = findLocoClip(library, migratePoseName(n), curCharId, w); if (c) return c; }
    return null;
  },
};
// ── Верх тела по оружию (Феча 2): idle-СТОЙКА = клип «idle_<оружие>» (правится в Анимации) + остаточный мах (pe_sway) ──
interface UpperPose { pose: Pose; swing: number }
/** Конфиг контроллера (`pe_anim`): настройка предметов (чем подмешивается, в какой руке, с какой силой)
 *  и привязка клипов ПО ССЫЛКЕ — поэтому переименовывать существующие клипы не нужно. */
let animStore: AnimStore = (() => { try { return JSON.parse(localStorage.getItem('pe_anim') || '{}') as AnimStore; } catch { return {}; } })();
const saveAnim = (): void => { try { localStorage.setItem('pe_anim', JSON.stringify(animStore)); savePoseKey('pe_anim'); } catch { /* */ } };
/** Запись предмета текущего персонажа (создаётся по требованию — пустой конфиг = поведение по умолчанию). */
const animItem = (item: string): AnimItem => (((animStore[curCharId] ??= {}).items ??= {})[item] ??= {});
const animCfg = (): AnimCfg => readAnimCfg(animStore, curCharId);
/**
 * ИМЯ КЛИПА-СТОЙКИ — ИЗ ПРИВЯЗКИ, а не из конвенции.
 *
 * Жалоба: «сделай чтобы не было хардкода имён, что я назначил — то и цепляется». Привязка в
 * рантайме была с самого Ф1.2 (`pe_anim` → `clipName`, конвенция лишь фолбэк), а редактор всё равно
 * лез за именем в `'idle_' + оружие` — поэтому «захватить стойку» создавала НОВЫЙ `idle_none` рядом
 * с авторским клипом, как бы тот ни назывался.
 *
 * ⚠ Через эти две функции идут ВСЕ пути редактора: захват и перезахват, сброс, «основа: оружие»,
 * синк концов ударов, заголовок панели, сид. Поэтому хватает одного шва — и «что назначил, то и
 * цепляется» работает везде разом, а не в том месте, где вспомнили.
 */
const stanceName = (w: string): string => animCfg().clipName('idle', w);
/** Назначить клип ролью стойки (или снять привязку, `undefined` → снова конвенция). */
function setStanceRole(kind: 'idle' | 'combat_idle', clip: string | undefined, item = weapon): void {
  // Безоружная база живёт отдельным полем: от неё строятся стойки ВСЕХ комбинаций (сборка по рукам).
  if (item === 'none') { const b = ((animStore[curCharId] ??= {}).base ??= {}); if (kind === 'idle') b.idle = clip; else b.combatIdle = clip; }
  else { const c = animItem(item); if (kind === 'idle') c.idle = clip; else c.combatIdle = clip; }
  saveAnim();
}
// ⚠ ПО ВСЕМ КАНДИДАТАМ ИМЕНИ (привязка → нынешняя конвенция → историческая) — тот же порядок, что в игре.
function stanceClip(w: string): Clip | null {
  for (const nm of animCfg().clipNames('idle', w)) { const c = library.find((x) => x.name === nm && x.character === curCharId && x.weapon === w); if (c) return c; }
  return null;
}
function loadSway(): Record<string, Record<string, number>> { try { return JSON.parse(localStorage.getItem('pe_sway') || '{}') as Record<string, Record<string, number>>; } catch { return {}; } }
let swayCfg: Record<string, Record<string, number>> = loadSway();
function saveSway(): void { try { localStorage.setItem('pe_sway', JSON.stringify(swayCfg)); savePoseKey('pe_sway'); } catch { /* */ } }
const swayOf = (w: string): number => swayCfg[curCharId]?.[w] ?? 0.2;   // остаточный мах поверх idle (физпокачивание)
const combatStanceName = (w: string): string => animCfg().clipName('combat_idle', w);
function combatStanceClip(w: string): Clip | null {
  for (const nm of animCfg().clipNames('combat_idle', w)) { const c = library.find((x) => x.name === nm && x.character === curCharId && x.weapon === w); if (c) return c; }
  return null;
}
let editorCombat = 0;   // превью боевой стойки в редакторе (0/1)
/** Стойка под экипировку — ТОТ ЖЕ резолвер, что в игре (`resolveStancePose`): авторская на точный
 *  ключ в приоритете, иначе сборка из безоружной базы и дельт предметов по рукам. */
function resolveUpper(wpn: string, combat = 0, t = 0): UpperPose | null {
  const cfg = animCfg();
  const look = (kind: 'idle' | 'combat_idle', item: string, tt: number): Pose | null => {
    const nm = cfg.clipName(kind, item);
    const c = library.find((x) => x.name === nm && x.character === curCharId)
      ?? (kind === 'idle' ? stanceClip(item) : combatStanceClip(item));   // нет привязки — конвенция
    return c ? stancePoseAt(c, tt) : null;   // многокадровая стойка играет циклом — как в игре
  };
  const pose = resolveStancePose(look, wpn, combat,
    { weight: (it) => cfg.weightOf(it), kind: (it) => cfg.kindOf(it), hand: (it) => cfg.handOf(it) }, t);
  if (pose) { const wk = stanceClip(wpn) ? wpn : rtBaseWeapon(wpn); return { pose, swing: swayOf(wk) }; }
  // Сборка не сложилась (нет ни точной позы, ни безоружной базы) — прежний фолбэк по базовому оружию класса.
  let c = stanceClip(wpn); let wk = wpn;
  if (!c) { wk = rtBaseWeapon(wpn); c = stanceClip(wk); }
  if (!c) { const base = rtBaseWeapon(curChar().weapon); if (base !== wk) { c = stanceClip(base); wk = base; } }
  if (!c || !c.keys[0]) return null;
  let p2 = c.keys[0]!.pose;
  if (combat > 0.001) { const cc = combatStanceClip(wpn) ?? combatStanceClip(rtBaseWeapon(wpn)); if (cc && cc.keys[0]) p2 = blendTwo(p2, cc.keys[0]!.pose, combat); }
  return { pose: p2, swing: swayOf(wk) };
}
// Удары — клипы «hit_<w>» (базовый) и «s_hit_<w>» (спец/скил) из 6 кадров; кадры 1 и последний = idle-стойка (не редактируются, синк ОДНОСТОРОННЕ idle→удар).
const isAttackClip = (c: Clip): boolean => c.name.startsWith('hit_') || c.name.startsWith('s_hit_');
function syncAttackEnds(c: Clip): void {
  // ⭐ БЕРЁМ ТУ БАЗУ, К КОТОРОЙ КЛИП И ПРИВЯЗАЛИ (`idleEndsFrom`). Раньше здесь ВСЕГДА стояла
  // `stanceClip` — обычная стойка, — и выбор «боевая» в панели импорта терялся на сохранении.
  const src = idleEndsSource(c, {
    // ⚠ ДЛЯ ОТМЕЧЕННЫХ КЛИПОВ — ТОТ ЖЕ ИСТОЧНИК, ЧТО ПРЕДЛАГАЛА ПАНЕЛЬ ИМПОРТА (`resolveUpper`,
    // то есть СОБРАННАЯ стойка с дельтами предметов), иначе «боевая» в панели и «боевая» здесь —
    // две разные позы. Без отметки (удары, старые клипы) — прежний сырой `stanceClip`, бит в бит.
    stance: (w, combat) => (c.idleEndsFrom
      ? (resolveUpper(w, combat > 0.5 ? 1 : 0, 0)?.pose ?? null)
      : (stanceClip(w)?.keys[0]?.pose ?? null)),
    clip: (nm) => library.find((x) => x.name === nm && x.character === curCharId)?.keys[0]?.pose ?? null,
  });
  if (!src || c.keys.length < 2) return;
  c.keys[0]!.pose = JSON.parse(JSON.stringify(src)) as Pose;
  c.keys[c.keys.length - 1]!.pose = JSON.parse(JSON.stringify(src)) as Pose;
}
function syncAllAttackEnds(): void { for (const c of library) if (c.character === curCharId && (isAttackClip(c) || c.idleEnds)) syncAttackEnds(c); }
function captureUpper(nm: string = stanceName(weapon)): void {   // снять ВСЮ позу манекена (ноги+торс+верх+оружие) → клип-стойка (idle_ или combat_idle_)
  if (locoOn || playing) { alert('Идёт превью/воспроизведение — сначала останови (⏸), иначе схватишь кадр бега, а не стойку.'); return; }
  const exists = clipIndexOf({ name: nm, character: curCharId, weapon }) >= 0;
  if (exists && !confirm(`Перезаписать «${nm}» текущей позой манекена?`)) return;   // защита от случайной перезаписи idle
  // Структурная правка: перезаписывает клип-стойку И концы ВСЕХ её ударов → откат должен вернуть всю библиотеку.
  histLib('захватить стойку', () => {
    const pose = readPoseFull();
    putClip({ name: nm, character: curCharId, weapon, loop: false, keys: [{ pose, t: 0 }] }, 'replace');
    syncAllAttackEnds();   // стойка изменилась → концы всех её ударов подхватывают
    saveLib();
  });
}
// ── Удары на бегу (Феча 3): авторский клип-удар поверх бегущих ног, физически ведомый (моторы гонят рэгдолл к цели) ──
let attackSpeed = 1;   // множитель темпа удара (ползунок) → player.atkTempo
/**
 * ОКНО АТАКИ ДЛЯ ПРЕВЬЮ = то, что сервер пришлёт как `lockMs`. У базовой атаки это ровно цикл
 * атаки (`session.ts`: `emitSwing(p,'attack', windup, attackCd, attackCd)`), а вайндап — его доля `baseWindupFrac`.
 * Зачем в редакторе: тайм-варп метки `impact` работает только от этой пары, и без неё превью бы
 * показывало НЕ то, что увидит игрок (требование «редактор ≡ игра»).
 */
let atkWindow = 0.8;
const BASE_WINDUP_FRAC = 0.35;   // = balance.melee.baseWindupFrac на сервере
const atkWindowSec = (): number => atkWindow;
const atkWindupSec = (): number => atkWindow * BASE_WINDUP_FRAC;
function triggerAttack(c: Clip): void {   // запустить удар через ТОТ ЖЕ PosePlayer, что игра; включить физику → физ-призрак = верный замах
  syncAttackEnds(c);   // концы = актуальная стойка (на случай если стойку поправили)
  lp().triggerAttack(c, atkWindowSec(), atkWindupSec()); lp().atkTempo = attackSpeed;   // ТОТ ЖЕ вход, что у игры: окно + вайндап сервера, а ползунок — множитель ПОВЕРХ
  void ensurePhysics().then(() => setPhys(true));
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
(function stripFingerKeys(): void {
  // Ф17: фаланги больше НЕ хранятся в клипах (канал хвата — единственный источник). Старые записи
  // их несут и ГЛУШАТ хват насмерть — именно поэтому на топоре правая кисть не реагировала на слайдер,
  // а левая (без таких ключей) реагировала. Идемпотентно.
  let ch = false;
  for (const c of library) for (const k of c.keys) for (const nm of Object.keys(k.pose)) if (isHandBone(nm)) { delete k.pose[nm]; ch = true; }
  if (ch) saveLib();
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
  const put = (c: Clip, replace: boolean): void => { if (replace || clipIndexOf(c) < 0) putClip(c, 'replace'); };
  for (const c of s.stances) put(c, forceStances);
  for (const c of s.attacks) put(c, true);   // удары — в 6-кадровую структуру
  swayCfg.warrior = forceStances ? s.sway : { ...s.sway, ...(swayCfg.warrior ?? {}) }; saveSway();
  const am = (atkCfgs.warrior ??= {});
  for (const c of s.attacks) { const arr = (am[c.weapon] ??= []); if (!arr.includes(c.name)) arr.push(c.name); }
  saveAtk();
  syncAllAttackEnds();   // концы ударов = актуальные стойки (пользовательские, если стойку не форсили)
  saveLib();
}
/**
 * ⚠ АВТОПОСЕВА БОЛЬШЕ НЕТ, и это не упрощение, а починка.
 *
 * Раньше здесь стояло: «нет флага `pe_seeded4` → залить 16 стоек и 16 ударов Волкодава». Флаг лежал
 * в том же `pe_*`, что и контент, поэтому ЛЮБАЯ чистка сносила и его — и редактор на следующей же
 * загрузке считал себя новым и засевал всё обратно. Жалоба «нажал чистый лист, а настройки и модели
 * остались» — это ровно он: третий источник, возвращавший данные (два других — сид сервера и
 * `models.json` в памяти процесса).
 *
 * Сид никуда не делся, он просто стал ЯВНЫМ: кнопка «↺ сид Волкодава» на вкладке «Бег». Это и есть
 * то, что просили: «загрузил модель — и с чистого листа, ничего ниоткуда не тянем».
 */
function ensureSeed(): void {
  localStorage.removeItem('pe_upper');   // старый формат idle-стора не используется
}
/**
 * Вкладка «Граф» — узловой редактор контроллера (Ф1.3b).
 *
 * Панель живёт отдельным модулем и НИЧЕГО не знает про редактор: ей дают персонажа, живой конфиг,
 * список клипов и способ проиграть состояние. Так её можно будет показать и из игры, если понадобится.
 */
const animGraph = createAnimGraphPanel({
  charId: () => curCharId,
  store: () => animStore,
  save: () => saveAnim(),
  clipNames: () => [...new Set(library.filter((c) => c.character === curCharId).map((c) => c.name))].sort(),
  trigger: (state) => {
    const cfg = readAnimCfg(animStore, curCharId).stateCfg(state);
    const c = library.find((x) => x.name === cfg.clip && x.character === curCharId);
    if (c) triggerAttack(c); else alert(`Клипа «${cfg.clip}» у персонажа нет — привяжи его в инспекторе.`);
  },
  active: () => lp().attacking,
}, {
  el: (tag: string, css?: string, text?: string) => { const e = el(tag, css ?? ''); if (text) e.textContent = text; return e; },
  btn: (label: string, fn: () => void, on = false) => pbtn(label, fn, on),
});
/**
 * БОЛЬШОЕ ПОЛЕ ГРАФА. Живёт не в колонке настроек, а НА МЕСТЕ ВЬЮПОРТА (та же ячейка сетки, что у
 * канваса): в 340-пиксельной колонке узловой редактор не читается вообще. Как окно Animator в Unity,
 * пришвартованное к той же группе, что и Scene — открыто, значит сцены не видно, и это правильно:
 * в этот момент правят граф, а не позу. Инспектор остаётся справа, как Inspector в Unity.
 */
let graphField: HTMLElement | null = null;
function graphFieldEl(): HTMLElement {
  if (!graphField) {
    graphField = document.createElement('div');
    graphField.style.cssText = 'grid-area:2 / 1 / 3 / 2;background:#12151d;overflow:hidden;z-index:4';
    document.body.append(graphField);
  }
  return graphField;
}
/** Поле показывается ТОЛЬКО на своей вкладке — иначе оно закрыло бы куклу на всех остальных. */
function syncGraphField(): void {
  const f = graphFieldEl();
  const on = tab === 'graph';
  f.style.display = on ? 'flex' : 'none';
  if (on) animGraph.renderField(f);
}
function renderGraph(): void {
  body.innerHTML = '';
  const info = el('div', 'color:#9ae6a0;margin-bottom:4px');
  info.textContent = `${curChar().name} · контроллер анимаций`;
  body.append(info);
  const box = el('div', 'border:1px solid #39415a;border-radius:6px;padding:6px');
  body.append(box);
  animGraph.renderInspector(box);
  renderInventory(body);
  syncGraphField();
}

/**
 * ВКЛАДКА «ТЕСТ». Персонаж откликается на ввод ровно как в клиенте: движение — настоящее серверное
 * ядро, ввод и привод куклы — те же модули, что в игре. Вся склейка живёт в `testTab.ts`, здесь
 * только монтаж: своя логика в редакторе — это второе поведение, ради отсутствия которого всё и затеяно.
 */
const testTab = createTestTab({
  scene, camera, canvas,
  physics: async () => { await ensurePhysics(); return pw; },
  charId: () => curCharId,
  weapon: () => weapon,
  setOrbit: (on) => { orbit.enabled = on; },
});
/**
 * Вкладка открыта — тест живёт; ушли — он обязан отпустить клавиатуру и убрать куклу.
 *
 * ⚠ ГЕЙТ ПО `wanted`, А НЕ ПО `active`. `active` поднимается в КОНЦЕ сборки куклы (физика + конфиг +
 * GLB — это секунды), поэтому раньше здесь было две дыры сразу: уход с вкладки во время загрузки не
 * звал `stop()` вовсе (условие `else if (testTab.active)` было ложным), а любая перерисовка панели в
 * том же окне запускала ВТОРУЮ сборку. Обе оставляли в сцене лишнюю куклу — белую, в бинд-позе,
 * в начале координат. Жалоба «после того как нажал тест, появился ещё один меш» — это она.
 */
function syncTestTab(): void {
  if (tab === 'test') { if (!testTab.wanted) void testTab.start(); }
  else if (testTab.wanted) testTab.stop();
}
let testStatus: HTMLElement | null = null;
function renderTest(): void {
  body.innerHTML = '';
  const h = el('div', 'color:#9ae6a0;margin-bottom:4px');
  h.textContent = `${curChar().name} · ${weapon}`;
  body.append(h);
  const info = el('div', 'color:#cfd3e0;font-size:11px;line-height:1.5');
  info.innerHTML = '<b>WASD</b> — ход (относительно экрана)<br><b>мышь</b> — прицел<br><b>ЛКМ</b> — атака'
    + '<br><b>Пробел</b> — уклонение<br><b>колесо</b> — зум';
  body.append(info);
  const note = el('div', 'color:#7a869e;font-size:10px;margin-top:6px');
  note.textContent = 'Движение считает НАСТОЯЩЕЕ серверное ядро (те же 30 Гц и тот же ввод, что уходит в игре), '
    + 'кукла — та же, что в бою. Поэтому увиденное здесь и есть то, что будет в клиенте.';
  body.append(note);
  testStatus = el('div', 'color:#9ae6a0;font-size:10px;margin-top:6px;font-family:monospace');
  body.append(testStatus);
  body.append(pbtn('в центр', () => testTab.rebuild()));
  const hint = el('div', 'color:#7a869e;font-size:10px;margin-top:8px');
  hint.textContent = 'Веса слоёв — тумблер «◫ слои» в тулбаре: он работает и здесь, и в игре.';
  body.append(hint);
}

/**
 * ИНВЕНТАРЬ АНИМАЦИЙ (Ф7): что есть, чего не хватает, что задублировано и что ссылается в никуда.
 *
 * Стоит ЗДЕСЬ, рядом с графом, потому что именно здесь клипы и привязывают: «чего не хватает» нужно
 * видеть в момент привязки, а не на отдельной странице, куда надо идти.
 *
 * ⚠ И здесь он ЧЕСТНЕЕ, чем в конфиг-редакторе: тот на другом origin и видит только опубликованное
 * на сервере, а поз-редактор — ЛОКАЛЬНУЮ рабочую копию, то есть то, что ты правишь прямо сейчас.
 * Считает при этом один и тот же модуль: две правды спорили бы, которая врёт.
 */
let invOpen = false;
function renderInventory(host: HTMLElement): void {
  const rows = buildInventory({
    clips: library.map((c) => ({ name: c.name, character: c.character, weapon: c.weapon, keys: c.keys })),
    anim: animStore as Record<string, { states?: Record<string, unknown> } | undefined>,
    refs: locoNodes.map((n) => ({ where: 'pe_loco', character: n.character, ref: n.clip })),
  });
  const head = el('div', 'margin-top:8px;display:flex;gap:6px;align-items:center');
  head.append(pbtn(invOpen ? '▾ НАБОР АНИМАЦИЙ' : '▸ НАБОР АНИМАЦИЙ', () => { invOpen = !invOpen; renderGraph(); }, invOpen));
  const sum = el('span', 'color:#9aa3b8;font-size:10px'); sum.textContent = inventorySummary(rows); head.append(sum);
  host.append(head);
  if (!invOpen) return;

  const me = rows.find((r) => r.character === curCharId);
  const box = el('div', 'margin-top:4px;border:1px solid #39415a;border-radius:6px;padding:6px;font:10px monospace');
  host.append(box);
  if (!me) { const e = el('div', 'color:#7a869e'); e.textContent = 'у этого персонажа клипов нет вовсе'; box.append(e); return; }

  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin-bottom:3px');
  h.textContent = `${curChar().name}: ${me.done} из ${me.need} · всего клипов ${me.total}`;
  box.append(h);
  for (const g of me.groups) {
    const r = el('div', 'display:flex;gap:6px;margin-top:1px');
    const n = el('span', 'flex:0 0 150px;color:#cfd3e0'); n.textContent = g.group; r.append(n);
    const v = el('span', g.missing.length ? 'color:#c08a50' : 'color:#9ae6a0');
    v.textContent = g.missing.length ? `нет: ${g.missing.join(', ')}` : `все ${g.have.length}`;
    r.append(v); box.append(r);
  }
  const bad = (title: string, items: string[], color: string): void => {
    if (!items.length) return;
    const t = el('div', `color:${color};margin-top:4px`);
    t.textContent = `${title}: ${items.join(' · ')}`;
    box.append(t);
  };
  // Дубли называем числом ЛИШНИХ копий: «idle_dual ×8» это семь мёртвых записей, и живёт только первая.
  bad('ДУБЛИ (живёт только первая запись)', me.dups.map((d) => `${d.key} ×${d.count}`), '#c05050');
  bad('ссылки в никуда', me.broken.map((b) => `${b.where} → ${b.ref}`), '#c05050');
  bad('пустые клипы (кадров нет)', me.empty, '#c08a50');
}

function renderUpperPanel(): void {   // панель idle-стойки по оружию (Феча 2): захват в клип, остаточный мах, «взять за основу»
  const box = el('div', 'margin-top:8px;border:1px solid #39415a;border-radius:6px;padding:6px');
  const st = stanceClip(weapon); const has = !!st;
  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin-bottom:2px;font-size:11px');
  h.textContent = `IDLE-СТОЙКА · ${weapon}` + (has ? ' (клип «' + stanceName(weapon) + '»)' : ' — не задана (полный мах)'); box.append(h);
  box.append(pbtn(has ? '⟳ перезахватить стойку (в клип)' : '✎ захватить стойку (в клип)', () => { captureUpper(); renderLoco(); }));
  // ── КОНТРОЛЛЕР: привязка клипов и настройка подмешивания ──────────────────────────────────────
  // Стойка комбинации собирается из безоружной базы и дельт предметов по рукам. Здесь задаётся,
  // КАКИМИ клипами описан предмет (по ссылке — переименовывать ничего не надо) и КАК он подмешивается.
  {
    const cfg = animCfg();
    const [mainIt, offIt] = splitHands(weapon);
    const items = ['none', mainIt, ...(cfg.kindOf(mainIt) === 'override' ? [] : [offIt])]
      .filter((v, i, a) => v !== 'none' || i === 0).filter((v, i, a) => a.indexOf(v) === i);
    const ch = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px;font-size:11px');
    ch.textContent = 'КОНТРОЛЛЕР · клипы и подмешивание'; box.append(ch);
    const mine = library.filter((c) => c.character === curCharId).map((c) => c.name).filter((v, i, a) => a.indexOf(v) === i).sort();
    /** Выпадашка привязки: «по конвенции» = записи нет, имя берётся из `idle_<item>`. */
    const bindSel = (item: string, kind: 'idle' | 'combat_idle', label: string): void => {
      const row = el('label', 'display:flex;align-items:center;gap:5px;margin-top:2px');
      const nm = el('span', 'flex:0 0 104px;font-size:10px;color:#9aa3b8'); nm.textContent = label; row.append(nm);
      const sel = el('select', 'flex:1 1 auto;min-width:0;background:#0e1016;color:#cfd3e0;border:1px solid #39415a;border-radius:3px;font:10px monospace') as HTMLSelectElement;
      const conv = defaultStanceName(kind, item);
      const o0 = document.createElement('option'); o0.value = ''; o0.textContent = `— по конвенции (${conv}) —`; sel.append(o0);
      for (const n of mine) { const o = document.createElement('option'); o.value = n; o.textContent = n + (n === conv ? '  ✓' : ''); sel.append(o); }
      const cur = cfg.clipName(kind, item);
      sel.value = cur === conv && !cfg.has(item) ? '' : cur;
      sel.onchange = () => { setStanceRole(kind, sel.value || undefined, item); renderLoco(); };
      // Привязали к несуществующему клипу — это ошибка данных, и молчать про неё нельзя.
      if (sel.value && !mine.includes(sel.value)) { sel.style.borderColor = '#c05050'; nm.title = 'клипа с таким именем у персонажа нет'; }
      row.append(sel); box.append(row);
    };
    for (const it of items) {
      const head = el('div', 'display:flex;align-items:center;gap:5px;margin-top:6px');
      const t = el('span', 'font-size:11px;color:#cfd3e0'); t.textContent = it === 'none' ? 'безоружная база' : it; head.append(t);
      if (it !== 'none') {
        // Тип: дельта на свою руку или замена верха целиком (двуручное). Рука: главная или вторая.
        const k = cfg.kindOf(it);
        head.append(pbtn(k === 'override' ? 'замена верха' : 'добавка к руке',
          () => { animItem(it).kind = k === 'override' ? 'additive' : 'override'; saveAnim(); renderLoco(); }, k === 'override'));
        const h = cfg.handOf(it) ?? (it === mainIt ? 'main' : 'off');
        head.append(pbtn(h === 'off' ? 'рука: вторая' : 'рука: главная',
          () => { animItem(it).hand = h === 'off' ? 'main' : 'off'; saveAnim(); renderLoco(); }, h === 'off'));
      }
      box.append(head);
      bindSel(it, 'idle', 'спокойная');
      bindSel(it, 'combat_idle', 'боевая');
      if (it !== 'none') {
        const row = el('label', 'display:flex;align-items:center;gap:5px;margin-top:2px');
        const nm = el('span', 'flex:0 0 104px;font-size:10px;color:#9aa3b8'); nm.textContent = 'сила подмешив.'; row.append(nm);
        const sl = el('input', 'flex:1 1 auto;min-width:0') as HTMLInputElement;
        sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.02'; sl.value = String(cfg.weightOf(it));
        const v = el('span', 'width:34px;text-align:right;color:#9ae6a0;font-size:10px'); v.textContent = (+sl.value).toFixed(2);
        sl.oninput = () => { const nv = parseFloat(sl.value); v.textContent = nv.toFixed(2); animItem(it).weight = nv; saveAnim(); };
        row.append(sl, v); box.append(row);
      }
    }
    const note = el('div', 'color:#7a869e;font-size:10px;margin-top:4px');
    note.textContent = has
      ? `На «${weapon}» есть авторская стойка целиком — она СИЛЬНЕЕ сборки, и настройки ниже на неё не влияют. Удали её, чтобы собирать из базы.`
      : '0 — предмет не влияет на стойку, 1 — поза предмета целиком. Привязка идёт по ССЫЛКЕ: переименовывать клипы не нужно.';
    box.append(note);
  }
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
    r1.append(sel, pbtn('основа: оружие', () => { if (sel.value === weapon) return; const src = stanceClip(sel.value); if (src) { const nm = stanceName(weapon); const i = library.findIndex((c) => c.name === nm && c.character === curCharId && c.weapon === weapon); putClip({ name: nm, character: curCharId, weapon, loop: false, keys: [{ pose: clonePose(src.keys[0]!.pose), t: 0 }] }, 'replace'); (swayCfg[curCharId] ??= {})[weapon] = swayCfg[curCharId]?.[sel.value] ?? 0.2; saveLib(); saveSway(); renderLoco(); } })); box.append(r1);
  }
  const srcC = allChars().filter((c) => c.id !== curCharId && library.some((cl) => cl.character === c.id && cl.name.startsWith('idle_')));
  if (srcC.length) {   // взять ВЕСЬ набор (стойки+удары) с другого КЛАССА
    const r2 = el('div', 'display:flex;gap:2px;margin-top:4px'); const sel = el('select', 'flex:1;background:#20242f;color:#cfe;border:1px solid #39415a;border-radius:4px;font-size:11px') as HTMLSelectElement;
    srcC.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; sel.append(o); });
    r2.append(sel, pbtn('основа: класс (весь верх)', () => { const src = sel.value; for (const cl of library.filter((c) => c.character === src && (c.name.startsWith('idle_') || c.name.startsWith('hit_') || c.name.startsWith('s_hit_')))) putClip(cloneClipTo(cl, curCharId), 'replace'); swayCfg[curCharId] = { ...(swayCfg[src] ?? {}) }; atkCfgs[curCharId] = JSON.parse(JSON.stringify(atkCfgs[src] ?? {})); saveLib(); saveSway(); saveAtk(); renderLoco(); })); box.append(r2);
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
    const wr = el('label', 'display:flex;align-items:center;gap:6px;margin-top:4px'); wr.innerHTML = '<span style="flex:1;font-size:11px">окно атаки (lockMs), сек</span>';
    const wi = el('input', 'width:60px') as HTMLInputElement; wi.type = 'number'; wi.step = '0.05'; wi.min = '0.1'; wi.value = String(atkWindow);
    const wv = el('span', 'color:#9ae6a0;font-size:10px'); const setW = (): void => { wv.textContent = 'вайндап ' + atkWindupSec().toFixed(2) + 'с'; }; setW();
    wi.oninput = () => { atkWindow = Math.max(0.1, parseFloat(wi.value) || 0.8); setW(); };
    wr.title = 'Сервер шлёт lockMs (весь клип за него) и windupMs (момент урона). Кадр с меткой «удар» садится ровно на вайндап.';
    wr.append(wi, wv); box.append(wr);
    const hint = el('div', 'color:#8fb7ff;font-size:10px;margin-top:3px'); hint.textContent = 'Удар ведётся физикой (моторы гонят рэгдолл к позам) — смотри на призрака. Сила — в панели ФИЗИКА.'; box.append(hint);
  }
  body.append(box);
}
// Настройки бега per персонаж (GAIT+POSE+GX): сохраняем/грузим при смене персонажа → у каждого класса свой бег.
const GAIT_KEYS = ['pelvisMin', 'stepWalk', 'stepRun', 'bobWalk', 'bobRun', 'liftWalk', 'liftRun', 'cadence', 'dutyWalk', 'dutyRun', 'speedWalk', 'speedRun', 'hipFwdLim', 'stanceWidth', 'strafeReach', 'crossClamp', 'turnStep', 'turnStepDist', 'turnLimitByAngle', 'turnLimitDeg', 'turnSettleTime', 'turnIdleTime', 'stepCommit', 'idleSettle', 'combatBlend', 'warpOn', 'warpMax', 'warpSmooth', 'planSmooth', 'stepSlack', 'stepUrge',
  'pelvisMinRun', 'hipFwdLimRun', 'stanceWidthRun', 'strafeReachRun', 'crossClampRun',
  'hipSwing', 'hipSwingRun', 'strafeFrom', 'strafeTo',
  'hipFwdSoft', 'aheadMul', 'predictSec', 'fixTarget', 'footClear', 'locoMix',
  'pelvisReach', 'pelvisReachRun',
  'ankLevel', 'ankLevelRun', 'ankHoldFrom', 'ankHoldFromRun', 'ankHoldTo', 'ankHoldToRun', 'ankHoldEase', 'ankHoldEaseRun',
  'toeLift', 'toeLiftRun', 'toeLiftPhase', 'toeLiftPhaseRun', 'ankMax',
  'kneeDir', 'kneeDirRun', 'kneeDirMax', 'crouchWalk', 'crouchRun',
  // Плавность боба таза и окно заземления (см. «БОБ ТАЗА И ЗАЗЕМЛЕНИЕ» в render3d/README.md).
  'bobLagUp', 'bobLagUpRun', 'bobLagDown', 'bobLagDownRun', 'bobFlight',
  'gndLag', 'gndIn', 'gndInRun', 'gndOut', 'gndOutRun', 'footPlant', 'footPlantRun',
  'toeOff', 'toeOffRun', 'toeOffFrom', 'toeOffFromRun', 'toeOffTo', 'toeOffToRun'] as const;   // длина шага/боб/подъём — раздельно ходьба/бег; standY убран (база из стойки)
// ⚠ Run-твины рук РАНЬШЕ НЕ СОХРАНЯЛИСЬ: ползунки их правили, а в `pe_gait` они не попадали и молча
// читались как «бег = ходьба». Теперь сохраняются вместе с плечевым поясом.
const POSE_KEYS = ['armSh', 'armEl', 'armSwing', 'armElWalk', 'armShRun', 'armElRun', 'armSwingRun',
  'shoUp', 'shoFwd', 'shoTw', 'shoSwing', 'shoLift',
  'shoUpRun', 'shoFwdRun', 'shoTwRun', 'shoSwingRun', 'shoLiftRun',
  'armPhase', 'armPhaseRun', 'shoPhase', 'shoPhaseRun', 'armElAmp', 'armElAmpRun',
  'twistSwing', 'twistSwingRun', 'twistChest', 'twistChestRun', 'twistUpper', 'twistUpperRun',
  'twistPhase', 'twistPhaseRun', 'leanIdle', 'leanWalk', 'leanSpeed', 'leanWalkRun', 'leanSpeedRun',
  'leanSideSwing', 'leanSideSwingRun', 'swingBase', 'swingSpeed', 'armSwingMax', 'elbowMax', 'elbowDir', 'elbowDirRun',
  'footTurn', 'footTurnRun', 'hipSplay', 'hipSplayRun',
  'hipSway', 'hipSwayRun', 'hipsRollSwing', 'hipsRollSwingRun', 'hipsPitchSwing', 'hipsPitchSwingRun',
  'hipsTiltHoldBody', 'hipsTiltHoldLegs'] as const;
const GX_KEYS = ['armDown', 'elbowBend', 'armDownRun', 'elbowBendRun'] as const;
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
let gaitCfgs: Record<string, { gait: NumRec; pose: NumRec; gx: NumRec; plant?: PlantStored; asym?: Record<string, [number, number]>; strafe?: NumRec; back?: NumRec; combat?: NumRec }> = (() => { try { return JSON.parse(localStorage.getItem('pe_gait') || '{}'); } catch { return {}; } })();
function loadPlant(p: PlantStored | undefined): void {          // читаем новый {walk,run} ИЛИ старый {l,r} (→ размазать во все ячейки)
  const g = emptyGrid();
  if (p?.walk && p?.run) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) { const e = p[sp]![i]; if (e) g[sp][i] = { l: [...(e.l ?? [0, 0])] as XY, r: [...(e.r ?? [0, 0])] as XY, lVia: cloneVia(e.lVia), rVia: cloneVia(e.rVia) }; } }
  else if (p?.l && p?.r) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) g[sp][i] = { l: [...p.l] as XY, r: [...p.r] as XY, lVia: [], rVia: [] }; }
  gaitPlant.walk = g.walk; gaitPlant.run = g.run;
}
function applyGaitCfg(id: string): void {   // выставить GAIT/POSE/GX/plant/асимметрию под персонажа (или дефолты)
  const c = gaitCfgs[id];
  Object.assign(GAIT, GAIT_DEF, c?.gait ?? {});
  Object.assign(POSE, POSE_DEF, c?.pose ?? {});
  Object.assign(GX, GX_DEF, c?.gx ?? {});
  // Асимметрия — тоже пер-персонаж: чистим прошлого и заливаем своего (пусто → симметрия).
  for (const k of Object.keys(ASYM)) delete ASYM[k];
  for (const [k, v] of Object.entries(c?.asym ?? {})) if (Array.isArray(v) && v.length === 2) ASYM[k] = [v[0]!, v[1]!];
  // Страйф-колонка — тоже пер-персонаж и тоже разреженная (пусто → страйф ведёт себя как бег).
  for (const k of Object.keys(STRAFE)) delete STRAFE[k];
  for (const [k, v] of Object.entries(c?.strafe ?? {})) if (typeof v === 'number') STRAFE[k] = v;
  for (const k of Object.keys(BACK)) delete BACK[k];
  for (const [k, v] of Object.entries(c?.back ?? {})) if (typeof v === 'number') BACK[k] = v;
  for (const k of Object.keys(COMBAT)) delete COMBAT[k];
  for (const [k, v] of Object.entries(c?.combat ?? {})) if (typeof v === 'number') COMBAT[k] = v;
  // Три места сгиба локтя → одна база. Тот же вызов в игре (`applyGaitConfig`) — иначе клиенты разъедутся.
  foldElbow(GX as unknown as { elbowBend: number; elbowBendRun?: number });
  loadPlant(c?.plant);
}
function saveGaitCfg(): void {
  const gait: NumRec = {}, pose: NumRec = {}, gx: NumRec = {};
  for (const k of GAIT_KEYS) gait[k] = (GAIT as NumRec)[k]!;
  for (const k of POSE_KEYS) pose[k] = (POSE as NumRec)[k]!;
  for (const k of GX_KEYS) gx[k] = (GX as NumRec)[k]!;
  const cp = (arr: Leg2[]): Leg2[] => arr.map((e) => ({ l: [...e.l] as XY, r: [...e.r] as XY, lVia: cloneVia(e.lVia), rVia: cloneVia(e.rVia) }));
  const asym: Record<string, [number, number]> = {};
  for (const [k, v] of Object.entries(ASYM)) asym[k] = [v[0], v[1]];   // пусто = стороны одинаковы
  const strafe: NumRec = { ...STRAFE };                                // пусто = страйф не настраивали
  const back: NumRec = { ...BACK };                                    // пусто = ход спиной как ход вперёд
  const combat: NumRec = { ...COMBAT };                                // пусто = бой ничего не меняет
  gaitCfgs[curCharId] = { gait, pose, gx, plant: { walk: cp(gaitPlant.walk), run: cp(gaitPlant.run) }, asym, strafe, back, combat };
  try { localStorage.setItem('pe_gait', JSON.stringify(gaitCfgs)); savePoseKey('pe_gait'); } catch { /* */ }
}
let stanceMeasuredFor = '';   // замеряем ширину стойки один раз на текущее оружие (мутирует human → только на смене)
/**
 * ЗАМЕР ОФСЕТА ЗАЗЕМЛЕНИЯ ПО ЗАГРУЖЕННОЙ МОДЕЛИ.
 *
 * Раньше офсет подбирался глазами ползунком, хотя он ИЗМЕРИМ: это «высота лодыжки над её
 * собственной подошвой» минус наш процедурный `SOLE`. Возвращает null, если атласа нет или
 * вершин стопы не нашлось — тогда ползунок остаётся как был, молча ничего не портя.
 *
 * ⚠ Берём вершины ТОЛЬКО стопы: у мага пола плаща висит ниже подошвы, и «низ модели» поднял бы
 * персонажа в воздух на длину полы. Кость вершины резолвим ВВЕРХ ПО РОДИТЕЛЯМ — у CC/UE-ригов
 * скин висит на твист-костях, которых в нашей карте нет.
 */
const FOOT_OUR = new Set(['LeftFoot', 'RightFoot', 'LeftToes', 'RightToes']);
/**
 * ГДЕ ПОДОШВА МЕША ПРЯМО СЕЙЧАС, в мировых единицах: 0 = стоит на полу, + = парит, − = тонет.
 *
 * ⚠ Это ЕДИНСТВЕННОЕ число, которое отвечает на вопрос «он на полу?» — и его не было видно нигде.
 * Спор «ноги под землёй / ноги над землёй» шёл по скриншотам, а на скриншоте не различить пол
 * редактора и дальний край плоскости. Теперь оно всегда в панели, рядом с ползунком офсета.
 */
function soleHeightNow(): number | null {
  const meshes = atlasFootMeshes();
  return meshes ? lowestSkinY(meshes.list, meshes.isFoot) : null;
}
/** Меши атласа + предикат «кость стопы» — общая часть замера подошвы. */
function atlasFootMeshes(): { list: THREE.SkinnedMesh[]; isFoot: (b: THREE.Object3D) => boolean } | null {
  const ex = modelsTab.exportTarget(); if (!ex) return null;
  const ourOf: Record<string, string> = {};
  for (const our in ex.boneMap) ourOf[ex.boneMap[our]!] = our;
  const list: THREE.SkinnedMesh[] = [];
  ex.root.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && m.geometry.getAttribute('skinWeight')) list.push(m); });
  if (!list.length) return null;
  const isFoot = (b: THREE.Object3D): boolean => {
    let our = ourOf[b.name], up: THREE.Object3D | null = b;
    while (!our && up) { up = up.parent; if (up) our = ourOf[up.name]; }
    return !!our && FOOT_OUR.has(our);
  };
  return { list, isFoot };
}
function measureSoleOffset(): number | null {
  const mm = atlasFootMeshes(); if (!mm) return null;
  // ⚠⚠ ЗАМЕР ИДЁТ ПО ПОКОЮ, А НЕ ПО ТЕКУЩЕЙ ПОЗЕ. Офсет — свойство ГЕОМЕТРИИ («насколько лодыжка
  // выше собственной подошвы»), но меряется он по вершинам, а вершины едут за позой. Замер
  // чувствительности: поворот стопы на 10° двигает результат на +1.12, на 20° — на +2.2. То есть
  // замеренный на позе с опущенным носком офсет задирает персонажа над полом, и это читается как
  // «он парит». Ровно это и было: в панели стояло 2.15 там, где геометрия даёт 1.34.
  //
  // Поэтому на время замера кладём манекен в ПОКОЙ, ведём им меш, меряем — и возвращаем всё назад.
  // Манекен, а не призрак: призрака ведёт физика, его в покой не поставить, а геометрия у них одна.
  const saved = readPoseFull();
  const y0 = human.root.position.y;
  human.reset(); human.root.position.y = 0; human.root.updateMatrixWorld(true);
  modelsTab.drive(human);
  const soleY = lowestSkinY(mm.list, mm.isFoot);
  const lift = soleY === null ? null : measureFootLift(human, soleY);
  applyPose(saved); human.root.position.y = y0; human.root.updateMatrixWorld(true);
  modelsTab.drive((physOn && ghostHuman) ? ghostHuman : human);   // вернуть кадр как был
  return lift;
}

/**
 * АВТОЗАСЕВ ОФСЕТА ЗАЗЕМЛЕНИЯ. Один раз на персонажа и ТОЛЬКО если в `pe_phys` его ещё нет:
 * замер — это стартовое значение, а не хозяин ползунка. Доведённое руками число не трогаем никогда.
 */
let soleSeededFor = '';
let soleRev = 0;                 // `importRev` вкладки «Модели», под который замерен подъём стопы
let soleShown: number | null = null;   // последний замер — показываем рядом с кнопкой
/**
 * ⚠ ПЕРЕИМПОРТ МОДЕЛИ ОБНУЛЯЕТ СТАРЫЙ ЗАМЕР. Подъём стопы замерен ПО ГЕОМЕТРИИ: у рыцаря подошва
 * ниже лодыжки на 2.90 ед при норме 1.5, то есть без замера меш тонет на 1.4 ед («ноги чуть-чуть
 * под землёй»). Раньше сохранённое значение побеждало ВСЕГДА — поэтому после импорта новой модели
 * оставалось число от старой, и заземление молча врало. Ручная настройка живёт до СЛЕДУЮЩЕГО
 * импорта; обычная загрузка из конфига `importRev` не двигает и настройку не трогает.
 */
function seedSoleOffset(): void {
  const rev = modelsTab.importRev();
  const key = curCharId + '#' + rev;
  if (soleSeededFor === key) return;
  const m = measureSoleOffset();
  if (m === null) return;                       // атлас ещё грузится — попробуем на следующем кадре
  const reimported = rev !== soleRev;           // атлас только что импортировали → замер старой модели протух
  soleSeededFor = key; soleRev = rev; soleShown = m;
  let saved: number | undefined;
  try { saved = (JSON.parse(localStorage.getItem('pe_phys') || '{}') as Record<string, { footLift?: number }>)[curCharId]?.footLift; } catch { /* */ }
  if (saved !== undefined && !reimported) return;   // офсет задан руками — замер только показываем
  physFootLift = +m.toFixed(2);
  human.footLift = physFootLift; if (ghostHuman) ghostHuman.footLift = physFootLift;
  stanceMeasuredFor = ''; saveFootLift(); renderAnim();
}
function stepGait(dt: number): void {
  const player = lp();
  // Живые правки редактора → в плеер (ТЕ ЖЕ ссылки, что читает игра): gx/plant/twist/скорость удара/боевая — ползунки между кадрами.
  player.gx = GX; player.plant = gaitPlant; player.twistStates = editorTwistStates; player.atkTempo = attackSpeed;
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
  if (warpReadout && warpReadout.isConnected) warpReadout.textContent = `таз ${player.dirWarpDeg.toFixed(0)}°`;
  if (plantDrag < 0 && spd > 1) {   // активная ячейка плант-сетки следит за падом (body-локальное направление движения)
    const fwdC = vx * Math.sin(editorRootYaw) + vz * Math.cos(editorRootYaw), latC = vx * Math.cos(editorRootYaw) - vz * Math.sin(editorRootYaw);
    let a = Math.atan2(latC, fwdC) / DIR_STEP; a = ((a % 8) + 8) % 8;
    plantDirSel = (Math.round(a) % 8 + 8) % 8; plantSpeedRun = clamp((spd - GAIT.speedWalk) / Math.max(1, GAIT.speedRun - GAIT.speedWalk), 0, 1) >= 0.5;
  }
  if (gaitReadout && gaitReadout.isConnected) {              // живой индикатор скорости + режим ходьба↔бег
    // Режим — по РЕАЛЬНОМУ блену (sb), а не по «спид ≥ порога ходьбы»: на якоре ходьбы (41 u/с при
    // пороге 40) старая формула писала «бег», хотя параметры там ещё целиком ходьбы.
    const sbNow = clamp((spd - GAIT.speedWalk) / Math.max(1, GAIT.speedRun - GAIT.speedWalk), 0, 1);
    const mode = spd < 5 ? 'стоит' : sbNow < 0.12 ? 'ходьба' : sbNow > 0.88 ? 'бег' : `ходьба→бег ${Math.round(sbNow * 100)}%`;
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
  // Физ-тело = ОСНОВНОЙ рендер как `solid` в игре (единый путь редактор↔игра): те же цвета (body/limb дефолты buildHumanoid),
  // НЕПРОЗРАЧНОЕ. Скелет-манекен (октаэдры) рисуется поверх (manikinOnTop, depthTest off) — кликается для позинга.
  // Ф27: тот ЖЕ рецепт, что у манекена — иначе призрак врёт про меш, который сам же и ведёт.
  ghostHuman = stampRig(buildHumanoid({ ...rigRecipe(), body: 0x8a93ad, limb: 0x6f7690 }));
  ghostHuman.footLift = physFootLift;                           // подъём стопы: заземление физ-тела на пол (footIk.groundFeet)
  ghostHuman.meshes.forEach((m) => { m.castShadow = true; });   // тени как у игрового solid
  scene.add(ghostHuman.root); ghostHuman.root.visible = physOn;
  applyGripToGhost();                                           // свежесобранный призрак — в rest; без этого кадр до первого шага физики с бинд-кистью
}
/**
 * ЕДИНАЯ ТОЧКА ПРАВДЫ О ФИЗИКЕ: состояние + видимость призрака + МЕТКА КНОПКИ (Ф20.2).
 *
 * Раньше `physOn` выставлялся из шести мест, а метку тулбар-кнопки обновляло только одно из них.
 * Хуже того, стартовое `ensurePhysics().then(() => physOn = true)` резолвится через секунды (WASM) —
 * если за это время успеть выключить физику, промис молча включал её обратно, а кнопка продолжала
 * показывать «выкл». На этом легко ошибиться при замерах: видишь «выкл», а меш ведёт призрак.
 */
let physTouched = false;                                        // юзер уже трогал тумблер — стартовый промис его не перебивает
function setPhys(on: boolean, byUser = true): void {
  if (byUser) { physTouched = true; setPref('phys', on); } else if (physTouched) return;   // авто-включение после загрузки WASM не трогает выбор юзера
  physOn = on;
  if (ghostHuman) ghostHuman.root.visible = on;
  physB.textContent = 'физ: ' + (on ? 'вкл' : 'выкл');
  physB.classList.toggle('on', on);
}
// ── Онион-скин: полупрозрачные призраки соседних кадров (пред=синий, след=оранжевый) при позинге в «Анимации» ──
let onionOn = false; let onionPrev: Humanoid | null = null; let onionNext: Humanoid | null = null;
/** Сколько кадров назад/вперёд показывать призраками. Больше 1 нужно на быстрых замахах: соседний кадр там
 *  почти совпадает с текущим, и «след» движения виден только через 2-3 ключа. */
let onionSpan = 1;
/**
 * ПРИЗРАК СОСЕДНЕГО КАДРА.
 *
 * ⚠ С ЗАГРУЖЕННЫМ АТЛАСОМ РИСУЕМ СКЕЛЕТОМ, а не телом. Раньше онионы при атласе просто ГАСИЛИСЬ
 * (`aad37c2`, по жалобе «куча ненужных скелетов, оставить только скелет и модель»): два
 * полупрозрачных процедурных ТЕЛА поверх меша действительно мешали. Но с тех пор манекен и сам стал
 * скелетом, и тонкие октаэдры соседних кадров меш уже не загораживают — гасить нечего, а инструмент
 * возвращается. Тумблер включён, а призраков нет — это читается как поломка, и читалось.
 *
 * Сквозь меш рисуем намеренно (`depthTest = false`): призрак внутри модели не виден, то есть
 * бесполезен. `renderOrder` ниже манекена (998) — текущая поза обязана оставаться поверх соседних.
 */
function mkOnion(tint: number): Humanoid {
  const skel = !!atlasBS();
  const h = stampRig(buildHumanoid({ ...rigRecipe(), style: skel ? 'skeleton' : undefined, limb: tint, body: tint, head: tint }));
  for (const m of h.meshes) {
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.transparent = true; mat.depthWrite = false; mat.emissive.setHex(tint); mat.emissiveIntensity = 0.25;
    // Скелет тоньше тела: на 0.32 октаэдры почти не читались, поэтому ему своя прозрачность.
    mat.opacity = skel ? 0.45 : 0.32;
    if (skel) { mat.depthTest = false; m.renderOrder = 996; }
  }
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
/**
 * МЕТКИ КАДРА (модель Unreal Notify / Notify State).
 *
 * Клип несёт только «ЧТО и КОГДА», обработчик решает «КАК» — поэтому звук и эффект здесь это ИДЕНТИФИКАТОРЫ,
 * а не пути к файлам. Звук/эффект — ПОЛЯ метки, а не отдельные метки: ставить три штуки на один кадр удара
 * незачем. `dur` превращает метку в отрезок (взмах = свист клинка + след меча на одних границах).
 */
const MARK_KINDS: { type: MarkType; label: string; hint: string; range?: boolean }[] = [
  { type: 'impact', label: '⚔ удар', hint: 'Кадр самого удара: на него садится windupMs сервера, тут же играются звук и искра. Ставить на кадр МАКСИМАЛЬНОЙ скорости оружия.' },
  { type: 'swing', label: '〰 взмах', hint: 'ОТРЕЗОК: свист клинка (звук) + след меча (эффект). Начало = меч пошёл, конец = меч встал.', range: true },
  { type: 'footstep', label: '👣 шаг', hint: 'Материал поверхности знает мир, клип говорит только «шаг, левая/правая».' },
  { type: 'camshake', label: '📷 тряска', hint: 'Сила отдельным числом — чтобы масштабировать от тяжести удара.' },
  { type: 'sfx', label: '🔊 звук', hint: 'Прочие звуки: выкрик, лязг щита, шорох брони.' },
  { type: 'vfx', label: '✨ эффект', hint: 'Прочие эффекты.' },
  { type: 'combo', label: '⛓ окно комбо', hint: 'ОТРЕЗОК: branch point — пока играет он, удержанная атака уходит в следующий удар минуя стойку.', range: true },
  { type: 'windup', label: '↖ замах', hint: 'Начало замаха: с этой точки стартует ВТОРОЙ и следующие удары цепочки (idle-вход пропускается).' },
  { type: 'recover', label: '↘ отработка', hint: 'Конец отработки удара.' },
];
function marksSection(c: Clip): void {
  const k = c.keys[frameIdx];
  if (!k) return;
  const note = el('div', 'color:#6b7180;font-size:10px;margin-bottom:3px');
  note.textContent = 'Метка едет за кадром при ретайминге и переживает прореживание. Отрезок задаётся длительностью.';
  body.append(note);
  const add = el('div', 'display:flex;flex-wrap:wrap;gap:2px'); body.append(add);
  for (const kind of MARK_KINDS) {
    const b = pbtn('+ ' + kind.label, () => histLib('метка: ' + kind.label, () => {
      const kk = curClip()?.keys[frameIdx]; if (!kk) return;
      (kk.marks ??= []).push(kind.range ? { type: kind.type, dur: 0.15 } : { type: kind.type });
      saveLib(); refreshAll();
    }));
    b.title = kind.hint; add.append(b);
  }
  if (!k.marks?.length) { const e = el('div', 'color:#6b7180;font-size:10px;margin-top:4px'); e.textContent = 'на этом кадре меток нет'; body.append(e); return; }
  k.marks.forEach((m, i) => {
    const kind = MARK_KINDS.find((x) => x.type === m.type);
    const r = el('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:3px;margin-top:3px;padding:3px;background:#171b26;border-radius:4px'); body.append(r);
    const tag = el('span', `min-width:86px;font-size:11px;color:${MARK_COLOR[MARK_TRACK[m.type]]}`); tag.textContent = kind?.label ?? m.type; r.append(tag);
    const upd = (fn: () => void): void => histLib('правка метки', () => { fn(); saveLib(); refreshTimeline(); });
    if (m.dur !== undefined) {
      const d = el('input', 'width:56px') as HTMLInputElement; d.type = 'number'; d.step = '0.02'; d.min = '0.02'; d.value = String(m.dur);
      d.title = 'Длительность отрезка (сек клипа). Тайм-варп удара растягивает её вместе с анимацией.';
      d.onchange = () => upd(() => { m.dur = Math.max(0.02, parseFloat(d.value) || 0.15); });
      const dl = el('span', 'font-size:10px;color:#9aa3b8'); dl.textContent = 'длит'; r.append(dl, d);
    }
    if (m.type === 'footstep') {
      r.append(pbtn(m.foot === 'R' ? 'правая' : 'левая', () => upd(() => { m.foot = m.foot === 'R' ? 'L' : 'R'; })));
    }
    if (m.type === 'camshake') {
      const n = el('input', 'width:56px') as HTMLInputElement; n.type = 'number'; n.step = '0.1'; n.value = String(m.num ?? 1);
      n.onchange = () => upd(() => { m.num = parseFloat(n.value) || 1; });
      const nl = el('span', 'font-size:10px;color:#9aa3b8'); nl.textContent = 'сила'; r.append(nl, n);
    }
    for (const f of ['sfx', 'vfx'] as const) {
      if (m.type === 'combo' || m.type === 'windup' || m.type === 'recover' || m.type === 'footstep' || m.type === 'camshake') continue;
      const t = el('input', 'width:104px') as HTMLInputElement; t.style.cssText += ';' + impInput; t.placeholder = f === 'sfx' ? 'id звука' : 'id эффекта';
      t.value = m[f] ?? ''; t.onchange = () => upd(() => { const v = t.value.trim(); if (v) m[f] = v; else delete m[f]; });
      r.append(t);
    }
    r.append(pbtn('✕', () => histLib('удалить метку', () => {
      const kk = curClip()?.keys[frameIdx]; if (!kk?.marks) return;
      kk.marks.splice(i, 1); if (!kk.marks.length) delete kk.marks;
      saveLib(); refreshAll();
    })));
  });
}

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
    { const hd = hipsOffset(pose, human.hipsRest.y); if (hd) human.hips.position.set(human.hipsRest.x + hd[0], human.hipsRest.y + hd[1], human.hipsRest.z + hd[2]); }
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
  const c = onionOn && tab === 'anim' ? curClip() : null;
  if (!c || c.keys.length < 2) { if (onionPrev) onionPrev.root.visible = false; if (onionNext) onionNext.root.visible = false; return; }
  if (!onionPrev) { onionPrev = mkOnion(0x4a8cff); onionNext = mkOnion(0xff8c3a); }
  const pv = c.keys[Math.max(0, frameIdx - onionSpan)], nx = c.keys[Math.min(c.keys.length - 1, frameIdx + onionSpan)];
  const havePv = frameIdx > 0, haveNx = frameIdx < c.keys.length - 1;
  if (pv && havePv) { applyPoseTo(onionPrev!, pv.pose); onionPrev!.root.visible = true; } else onionPrev!.root.visible = false;
  if (nx && haveNx) { applyPoseTo(onionNext!, nx.pose); onionNext!.root.visible = true; } else onionNext!.root.visible = false;
}
async function ensurePhysics(): Promise<void> {
  if (pw) return;
  await initPhysics();
  pw = new PhysWorld();
  pw.addGround(300);                                        // плоский пол (верх на y=0)
  loadRagdollConfig();                                      // RB3: лимиты/моторы из pe_ragdoll ДО создания рэгдолла
  ragdoll = makeHumanoidRagdoll(pw);
  syncPinArrays();
  scene.add(ragdoll.group); applyBoxVis();   // боксы по флагу; по умолчанию скрыты — показываем гуманоид-призрак
  buildGhost();
  refitPhysIfFitted();                                      // Ф26.5: тела сняты с костей — приводим их к ТЕКУЩЕМУ телосложению
  updateWeapon();   // до физики оружие висело на манекене (fallback) → переносим на свежий физ-призрак
}
// RB3: пересборка рэгдолла с текущими LIMITS/MOTOR (они читаются при СОЗДАНИИ в makeCon; live-правка сустава роняет wasm).
function rebuildRagdoll(): void {
  if (!pw || !ragdoll) return;
  // Ф26.5: активный набор тел `B` собирается ТОЛЬКО в `applyPhysProfile` — именно там впекаются
  // размеры/формы из `PHYS_SIZES`. Без этого вызова правка размера сохранялась в конфиг, но кукла пересобиралась со СТАРЫМИ
  // телами (замер: после «снять с костей» анкеры не сдвинулись ни на юнит).
  applyPhysProfile([...PHYS_SET.bodies]);
  scene.remove(ragdoll.group); ragdoll.dispose();
  ragdoll = makeHumanoidRagdoll(pw);
  syncPinArrays();   // Ф11: набор тел мог смениться — длина массивов пинов другая
  scene.add(ragdoll.group); applyBoxVis();   // Ф26.8: пересборка НЕ гасит боксы, если они включены
}
// ДЛИНА зависит от набора тел (Ф11) — пересобираем вместе с куклой, иначе пины уедут на чужие индексы.
let pinVecs: THREE.Vector3[] = []; let pinArr: (THREE.Vector3 | null)[] = [];
function syncPinArrays(): void { pinVecs = RAG_NAMES.map(() => new THREE.Vector3()); pinArr = RAG_NAMES.map(() => null); }
syncPinArrays();
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
    const sup = locoOn ? lp().groundSupport : undefined;   // опорность — тот же разбор, что в игре
    const gOpts = { w: locoOn ? lp().groundWeights : undefined, lag: GAIT.gndLag,
      flat: locoOn ? lp().plantWeights : undefined,
      still: locoOn ? lp().moveMag < 0.02 : true };   // окно/плавность/укладка/«стоим» — те же, что в игре
    const rMatch = physDead ? 0 : (locoOn ? renderMatchWeight(physMatchBase, lp().attackWeight, lp().attackMatch) : PHYS.match);
    renderRagdollGhost(ghostHuman, ragdoll, ghostGround, Math.min(dt, 1 / 60), 0, !physDead,
      rMatch > 0.001 ? human.readPose() : null, rMatch, undefined, sup, footGround, gOpts);
    applyGripToGhost();   // призрак пересобирает позу каждый кадр — хват кладём после него, иначе фаланги уедут в бинд
  }
}
const ghostGround = newGhostGround();
/** Ф4 — ЗАПЕКАНИЕ: прогнать клип через физику, покадрово снять физ-результат → обычная покадровая анимация. */
async function bakeCurrentClip(): Promise<void> {
  await ensurePhysics();
  const c = curClip(); if (!c || !ragdoll) return;
  setPhys(true);
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
    putClip({ name: c.name + '_baked', character: curCharId, weapon, loop: c.loop, keys: baked }, 'replace');   // перезапёк ту же физику — заменяем, а не плодим
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
applyChar(curCharId); setIk(true); tab = 'anim'; syncModeB(); setManView(); refreshAll();   // setManView: применить
frameOnHead();   // стартовый взгляд — ПОСЛЕ applyChar: до него рига ещё нет и высоту головы брать негде
// запомненный вид манекена (личная настройка) — кнопка создаётся с дефолтной подписью, а состояние приходит из `pe_prefs`
void ensurePhysics().then(() => setPhys(getPref('phys', true), false));   // дефолт — физ-силуэт вокруг скелета; выбор юзера помнится
                                                                          // (`byUser=false` — не перебивает ручное выключение в те ~2 c, пока грузится WASM)
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
  else {
    // Солвим IK ТОЛЬКО когда реально тянешь ручку. Иначе (вхолостую) солвер пересчитывал руки/ноги из
    // позиций эффекторов и ТЕРЯЛ скрутку плеча/ориентацию — та же поза выглядела иначе, чем в FK.
    // Ф21.1: гейт теперь по ТОМУ, ЧТО ТЯНЕШЬ (ручка, а не кость), а не по глобальному режиму:
    // в одном инструменте драг кости (FK) и драг ручки (IK) идут через один и тот же гизмо.
    const onHandle = !!(activeKey || activePole);
    // Ф23.1: свивель ставится ТОЧНОЙ ФОРМУЛОЙ до солва — он сохраняет конец по построению.
    // ПРИ ДРАГЕ ПОЛЮСА — ТОЛЬКО СВИВЕЛЬ, без FABRIK. Свивель точен по построению
    // (сгиб сохраняется 110°→110°), а солвер после него его же и ломал: замер с FABRIK —
    // сгиб 106°→138° и конец на 15–26u в стороне.
    if (gizmo.dragging && activePole && ikOn) { if (solverMode === 'fabrik') applySwivel(rig.eff[activePole]!); else solveRig(); }   // Ф25.4: локоть — эффектор
    else if (gizmo.dragging && onHandle && (ikOn || activeKey === 'hips')) solveRig();
    // Ф22.1: ФИКСАТОРЫ ДЕЙСТВУЮТ И ПРИ FK-ВРАЩЕНИИ КОСТИ. Раньше солвер звался только
    // на драге РУЧКИ, поэтому пины при повороте кости не держали вообще (замер: `Hips` на 40°
    // — кисти уезжали на 26.1u). В Cascadeur фиксатор держит точку при ЛЮБОЙ манипуляции.
    else if (gizmo.dragging && ikOn && (fkProxyBone || activeShoulder) && effList().some((e) => e.ik && e.pin)) solveRig();
    // НЕ тянем — ручки ГОНЯТСЯ ЗА КОСТЯМИ (Ф21.1). Раньше этого не требовалось: в FK-режиме ручки
    // были спрятаны целиком. Теперь они видны всегда, и без этого синяя ручка оставалась висеть в воздухе
    // после поворота плеча кольцами.
    else if (!gizmo.dragging) syncHandles();
    const active = gizmo.dragging ? gizmo.object : null;
    if (gazeHandle !== active) gazeHandle.position.copy(gazeTarget);
    // ⭐ РУЧКА ТАЗА — НА САМОМ ТАЗЕ. Рисовать её по «желанию» значило показывать не то, чем она
    // управляет: помощь баланса уводит КОСТЬ до 9 ед. вбок, и ручка оставалась висеть в стороне.
    if (rig.hipsHandle !== active) { human.bones.get('Hips')!.getWorldPosition(rig.hipsHandle.position); rig.hipsHandleAt.copy(rig.hipsHandle.position); }
    for (const e of effList()) { handleViewOff(e, e.viewOff); if (e.handle !== active) e.handle.position.copy(e.target).add(e.viewOff); if (e.poleHandle !== active) e.poleHandle.position.copy((viewBone(e.mid) ?? human.bones.get(e.mid)!).getWorldPosition(V())); }
    for (const k in shoulderHandles) { const h = shoulderHandles[k]!; if (h !== active) h.position.copy((viewBone(rig.eff[k]!.root) ?? human.bones.get(rig.eff[k]!.root)!).getWorldPosition(V())); }
    if (gazeLine.visible) { const hd = viewBone('Head') ?? human.bones.get('Head'); if (hd) (gazeLine.geometry as THREE.BufferGeometry).setFromPoints([hd.getWorldPosition(V()), gazeTarget]); }
    // Ф24.2: взгляд — ПОВЕРХ всего (солвера, скрутки, FK): сняли прошлый доворот и навели заново.
    gazeRelax(); applyGaze();   // Ф20.2: полюс — на ВИДИМОМ суставе
  }
  if (!locoOn) applyLgripPreview();   // Анимация: левая кисть IK-ом на маркер хвата (в Бег это делает gaitToHumanoid)
  updatePlantMarks();
  updateTurnPlants();   // вкладка «Повороты»: живые плант-цели стоп (куда стремятся ноги)
  scrollFloor();   // тредмилл-пол под бегущим (тянется по gaitPx/gaitPz)
  stepPhysics(dt);
  jiggle(dt);   // вторичное движение груди (female)
  // Атлас загрузился/сменился → пересобрать манекен/призрак/онион под пропорции ФБХ (boneScale), чтобы скелет
  // совпадал с мешем. Сравнение по ссылке (меняется только на импорте/загрузке конфига — редко).
  // Ф14.1: следим И за появлением пальцев. Раньше сравнивалась только ссылка `boneScale`, а она меняется
  // РАНЬШЕ, чем догрузится GLB — манекен пересобирался с `fingers:false`, и пальцы не появлялись, пока
  // не нажмёшь ✋. Со стороны это выглядело как «пальцы не работают».
  syncRigs();   // Ф27: все риги с ОДНИМ рецептом; панель перерисуется там же
  // Атлас-скин ведём ФИЗ-телом (ghostHuman) — как игра (скин на solid) → превью атласа = игра. Физ off → манекеном.
  // ghostHuman позирован stepPhysics выше (физ-бленд по PHYS.match), у него та же геометрия атласа (buildGhost).
  modelsTab.drive(physOn && ghostHuman ? ghostHuman : human);   // «Модели»: импортный скелет ведётся позой физ-тела (== игра) / манекена
  // Ф20.2: гизмо предела ставится ПОСЛЕ `drive` — до него локальные трансформы костей модели
  // держат вывод ПРОШЛОГО кадра, и гизмо отставало на кадр при перетаскивании.
  placeLimitGizmo(); parkProxy();   // кольца FK стоят в том же фрейме, что и зона предела
  syncWeaponHost();   // 2B: оружие на кисть ВИДИМОГО атлас-меша (после drive — кисть уже позирована)
  // В тесте манекен редактора прячем целиком: в кадре должна быть ИГРОВАЯ кукла и только она,
  // иначе рядом с ней стоит второй персонаж и сравнивать не с чем.
  const hideMan = testTab.active || (tab === 'models' && modelsTab.hideMannequin());   // прятать манекен/призрак
  human.root.visible = !hideMan;
  // Ф20.4: ВИД КОСТЕЙ МОДЕЛИ. Пересобираем по ИДЕНТИЧНОСТИ корня атласа: `exportTarget()`
  // аллоцирует НОВУЮ обёртку на каждый вызов, сравнивать её бесполезно. `rebuildAsm` дизпоузит
  // геометрию GLB — старые ссылки на кости мертвы, а перезагрузка асинхронна, так что
  // есть окно в несколько кадров без атласа — тогда возвращаемся на манекен.
  {
    const ar = modelsTab.exportTarget()?.root ?? null;
    // ⚠ Пересобирать надо И при смене НАБОРА КОСТЕЙ, не только атласа. Вход в режим хвата пересобирает манекен
    // с фалангами (23 → 53 кости), а вид костей оставался старым — в нём пальцев НЕТ, и кликать в хвате было
    // НЕ ПО ЧЕМУ (замер: `boneMeshes` = 41 меш, из них пальцев 0). Именно по этому набору идёт пикинг.
    const bkey = human.boneNames.length;
    if (ar !== lastAtlasRoot || bkey !== lastBoneKey) {
      lastAtlasRoot = ar; lastBoneKey = bkey;
      boneView.rebuild(boneSrc);
      boneViewOnTop(); applyAlpha();
      selMesh = null; highlight(null);                     // материал выбранного меша мог быть дизпоузнут
      if (selected) highlight(boneMeshes().find((x) => x.userData.bone === selected) ?? null);
    }
    const show = !!ar && !hideMan && curHumanStyle === 'skeleton' && boneView.mapped.length > 0;
    boneView.group.visible = show;
    if (show) boneView.update(boneSrc);
    // Манекен прячем ПОМЕШНО, а не целиком: его трансформы всё ещё нужны физике, гизмо и jiggle.
    for (const m of human.meshes) m.visible = !show;
  }
  // Загружен атлас → прячем ФИЗ-ПРИЗРАКА: это сплошное процедурное ТЕЛО, и оно закрывает меш.
  // ⚠ ОНИОНЫ СЮДА БОЛЬШЕ НЕ ВХОДЯТ, и это главное в этой строке. Видимостью призраков соседних
  // кадров владеет РОВНО ОДИН `updateOnion()`. Здесь жила ВТОРАЯ заслонка, и она гасила их КАЖДЫЙ КАДР
  // после того, как `updateOnion` их показал (он зовётся не каждый кадр, а по событиям) — то есть тумблер
  // включался, а призраков не было. С атласом они рисуются СКЕЛЕТОМ (`mkOnion`) и меш не закрывают.
  const atlasOn = !!atlasBS();
  if (ghostHuman) ghostHuman.root.visible = physOn && !hideMan && !atlasOn;
  orbit.update();
  // Ф13.1: шары-суставы — постоянного экранного размера. СТРОГО ПОСЛЕ orbit.update(): у контролов
  // включён демпфинг, и до него камера ещё не на месте — шары отставали бы на кадр и «дышали» при вращении.
  // В режиме хвата фаланги поднимаются, а остальной скелет приглушается — без возни с материалами.
  if (onModelBones()) scaleJointsToScreen(boneView, camera, canvas.clientHeight || 1, JOINT_PX);
  else if (curHumanStyle === 'skeleton' && human.root.visible) scaleJointsToScreen(human, camera, canvas.clientHeight || 1, JOINT_PX);
  outline.selectedObjects = selMesh ? [selMesh] : [];   // Ф5: обводка выбранной кости
  seedSoleOffset();   // атлас грузится асинхронно — засеваем офсет, как только появились вершины
  const ungroundView = groundManikinForView();   // Ф27.5: рисуем ЗАЗЕМЛЁННЫЙ манекен…
  // Ф27.6: боксы физ-тел — НА ТОМ ЖЕ СКЕЛЕТЕ, что виден. Сырое физ-состояние не заземлено и
  // не сбленжено к позе по `match`, поэтому оверлей висел ниже призрака на 1.15u и стоял
  // под своим углом (1.2–14.8°) — жалоба «бокс вертикальный, а кость под углом».
  if (showBoxes && ragdoll) ragdoll.poseShapes(physOn && ghostHuman ? ghostHuman : human);
  if (testTab.active) {
    testTab.frame(Math.min(dt, 0.1));
    if (testStatus && testStatus.isConnected) testStatus.textContent = testTab.status();
  }
  traceView?.update();   // трасса заполняется в шаге куклы выше — здесь только рисуем
  if (useComposer) composer.render(); else renderer.render(scene, camera);
  ungroundView?.();                              // …и ТУТ ЖЕ возвращаем — авторская поза не тронута
  requestAnimationFrame(loop);
}
loop();

(window as unknown as { __pe: unknown }).__pe = { scene, camera, renderer, gizmo, rig, setComposer: (on: boolean): void => { useComposer = on; }, get human() { return human; }, get library() { return library; }, get weapons() { return weaponGroups; }, render: () => renderer.render(scene, camera), setIk, solvePlan, syncHandles, applySwivel, setGaze, applyGaze, gazeRelax, get gazeTarget() { return gazeTarget; }, get solverMode() { return solverMode; }, physBodies, PHYS_SIZES, fitPhysToBones, fitPhysToMesh, bodyAxis, rebuildForMorph, massCenter, supportRect, applyBalance, get balanceOff() { return balanceOff; }, get balance() { return { on: balanceOn, shift: weightShift }; }, setBalance: (on: boolean, sh: number): void => { balanceOn = on; weightShift = sh; }, bakeBodyFollow, naturalPole, applyBodyFollow, holdPins, get pinPower() { return pinPower; }, set pinPower(v: number) { pinPower = v; }, bodyFollowAngles, get bodyFollow() { return bodyFollow; }, set bodyFollow(v: number) { bodyFollow = v; }, get gains() { return { gTwist, gPitch, gRoll, pelvisFollow }; }, setGains: (t: number, p: number, r: number, pv: number): void => { gTwist = t; gPitch = p; gRoll = r; pelvisFollow = pv; }, get flex() { return { tw: flexTw, bend: flexBend, pelvis: flexPelvis }; }, setFlex: (t: number, b: number, p: number): void => { flexTw = t; flexBend = b; flexPelvis = p; }, applyAlpha, get alpha() { return { skel: aSkel, handle: aHandle }; }, rigDelta, syncRigs, rigRecipe, recipeKey, get ghost() { return ghostHuman; }, groundManikinForView, get manGroundView() { return manGroundView; }, set manGroundView(v: boolean) { manGroundView = v; }, setAlpha: (sk: number, hd: number): void => { aSkel = sk; aHandle = hd; applyAlpha(); }, shoulderHandles, gazeHandle, get activeShoulder() { return activeShoulder; }, get ghostGround() { return ghostGround; }, get locoOn() { return locoOn; }, get physOn() { return physOn; }, get tab() { return tab; }, tabSwitch, setSolver: (m: 'analytic' | 'fabrik'): void => { solverMode = m; }, solveLimb, shoulderGirdle, limbDbg, limitViewForBone, setActive: (k: string | null, p: string | null): void => { activeKey = k; activePole = p; }, aimBoneAt, clampLocalToLimit, setHingeBend, swivelRootToPole, get activeKey() { return activeKey; }, get activePole() { return activePole; }, applyChar, setWeapon, solveRig, captureRig, syncEff, get selected() { return selected; }, get gripMode() { return gripMode; }, pickSet: () => ({ onModelBones: onModelBones(), meshes: boneMeshes().length, fingers: boneMeshes().filter((m) => isHandBone(m.userData.bone as string)).length, visible: boneMeshes().filter((m) => m.visible).length }), pose: () => readPoseFull(), wpos: (b: string) => human.bones.get(b)!.getWorldPosition(V()).toArray().map((v) => +v.toFixed(1)),
  ensurePhysics, bakeCurrentClip, PHYS, LIMITS, MOTOR, rebuildRagdoll, jiggle, get pw() { return pw; }, get ragdoll() { return ragdoll; },
  get player() { return lp(); }, locoSetVel: (x: number, z: number): void => { locoVx = x; locoVz = z; }, locoStep: (dt: number): void => stepLoco(dt), locoGaitStep: (dt: number): void => stepGait(dt), get locoNodes() { return locoNodes; }, locoAdd: (clip: string, vx: number, vz: number): void => { locoNodes.push({ character: curCharId, weapon, clip, vx, vz }); },
  setPlantCell: (dir: number, run: boolean, lF: number, lL: number, rF: number, rL: number): void => { const cell = (run ? gaitPlant.run : gaitPlant.walk)[((dir % 8) + 8) % 8]!; cell.l = [lF, lL]; cell.r = [rF, rL]; }, get plant() { return gaitPlant; }, get plantSel() { return { dir: plantDirSel, run: plantSpeedRun }; },
  captureUpper, get sway() { return swayCfg; }, resolveUpper: (w: string, combat = 0, t = 0): unknown => resolveUpper(w, combat, t), get stances() { return library.filter((c) => c.name.startsWith('idle_')); },
  get lgrip() { return lgripMark; }, lgripEnsure: (): unknown => ensureLgripMark(), lgripPreview: (): void => applyLgripPreview(),   // двуручный хват: маркер + off-hand IK превью (дебаг)
  goFrame, writeFramePhys, get frameIdx() { return frameIdx; },   // per-кадр физ (match/pinKp) — дебаг: goFrame читает, writeFramePhys фиксирует
  gaitAttack: (name: string): void => { const c = clipsHere().find((x) => x.name === name) ?? library.find((x) => x.name === name); if (c) triggerAttack(c); }, get attackT() { return lp().atk.t; }, markAttack: (name: string): void => toggleAtk(name),
  physStep: (dt: number, n: number): unknown => { if (!pw || !ragdoll) return null; physOn = true; for (let i = 0; i < n; i++) { stepPhysics(dt); } return { Hips: ragdoll.bodyPos('Hips'), Head: ragdoll.bodyPos('Head'), HandL: ragdoll.bodyPos('HandL'), HandR: ragdoll.bodyPos('HandR'), FootL: ragdoll.bodyPos('FootL'), Torso: ragdoll.bodyPos('Torso') }; },
  modelsTab, modelsImport: (url: string): Promise<void> => modelsTab.importUrl(url), modelsDebug: (): unknown => modelsTab.debug() };   // E: импорт атласа персонажа (дебаг-хуки)
