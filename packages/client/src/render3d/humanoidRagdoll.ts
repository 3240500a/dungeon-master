/**
 * РЭГДОЛЛ НА ГУМАНОИД-СКЕЛЕТЕ (Ф2 системы физ-анимации) — единый риг для редактора и, позже, игры.
 * Строится на пропорциях гуманоида (`humanoid.ts`) в T-ПОЗЕ: 15 физ-костей (таз/торс/голова + по стороне
 * плечо/предплечье/кисть/бедро/голень/стопа). Боксы вместо капсул — сегмент задаётся половинами по осям, не
 * нужен разворот формы (руки идут по X, ноги по −Y). Ведение к позе — штатным `Ragdoll.DriveToPoseUsingMotors`,
 * таз kinematic-авторитет (как в игре). Оси суставов: ноги/торс/голова — как в игровом `ragdoll.ts`; руки в
 * T-позе — плечо twist ±X, локоть — шарнир по Y.
 *
 * Переиспользует Jolt-инстанс и PhysWorld из `ragdoll.ts` (единый wasm). Грабли emscripten — см. шапку
 * `ragdoll.ts`: не destroy'ить временные-по-значению, копировать BodyID, общий кэш форм не трогать.
 */
import * as THREE from 'three';
import { TILE } from '@dm/shared';
import { jolt, type PhysWorld, type JoltNS } from './ragdoll.js';
import type { Humanoid } from './humanoid.js';   // только тип (без цикла: humanoid не импортирует рэгдолл)
import { groundFeet, type GroundQuery } from './footIk.js';

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
type Vec3 = [number, number, number];
type Con =
  | { kind: 'swing'; twist: Vec3; plane: Vec3; pCone: number; nCone: number; twistLim: [number, number] }
  | { kind: 'hinge'; axis: Vec3; normal: Vec3; lim: [number, number] };
type MGroup = 'leg' | 'arm' | 'core' | 'head';

interface HBone {
  name: string; parent: number;
  anchor: Vec3;                 // мировой сустав в T-позе покоя = начало тела
  off: Vec3;                    // смещение формы/меша от сустава (кость свисает/тянется от него)
  shape: { k: 'box'; h: Vec3 } | { k: 'sphere'; r: number };
  con: Con | null;
  group: MGroup;
  damp: number;
}

const swing = (pCone: number, nCone: number, twistLim: [number, number], twist: Vec3, plane: Vec3): Con =>
  ({ kind: 'swing', twist, plane, pCone, nCone, twistLim });
const hinge = (lim: [number, number], axis: Vec3, normal: Vec3): Con => ({ kind: 'hinge', axis, normal, lim });

// Кости в порядке скелета (родитель раньше ребёнка — требование Jolt). Пропорции = гуманоид T-поза.
const B: HBone[] = [
  { name: 'Hips', parent: -1, anchor: [0, 32, 0], off: [0, 0, 0], shape: { k: 'box', h: [5, 3, 3] }, con: null, group: 'core', damp: 1 },
  { name: 'Torso', parent: 0, anchor: [0, 35, 0], off: [0, 8.5, 0], shape: { k: 'box', h: [5, 8.5, 3.2] }, con: swing(0.7, 0.4, [-0.5, 0.5], [0, 1, 0], [1, 0, 0]), group: 'core', damp: 1 },
  { name: 'Head', parent: 1, anchor: [0, 53, 0], off: [0, 4, 0], shape: { k: 'sphere', r: 5 }, con: swing(0.5, 0.4, [-0.6, 0.6], [0, 1, 0], [1, 0, 0]), group: 'head', damp: 1 },
  { name: 'ArmL', parent: 1, anchor: [6, 51, 0], off: [7, 0, 0], shape: { k: 'box', h: [6.8, 2.6, 2.6] }, con: swing(1.7, 1.2, [-0.8, 0.8], [1, 0, 0], [0, 1, 0]), group: 'arm', damp: 0.9 },
  { name: 'ArmR', parent: 1, anchor: [-6, 51, 0], off: [-7, 0, 0], shape: { k: 'box', h: [6.8, 2.6, 2.6] }, con: swing(1.7, 1.2, [-0.8, 0.8], [-1, 0, 0], [0, 1, 0]), group: 'arm', damp: 0.9 },
  { name: 'ForeL', parent: 3, anchor: [20, 51, 0], off: [5.5, 0, 0], shape: { k: 'box', h: [5.5, 2.2, 2.2] }, con: hinge([-2.4, 0.1], [0, 1, 0], [1, 0, 0]), group: 'arm', damp: 0.9 },
  { name: 'ForeR', parent: 4, anchor: [-20, 51, 0], off: [-5.5, 0, 0], shape: { k: 'box', h: [5.5, 2.2, 2.2] }, con: hinge([-0.1, 2.4], [0, 1, 0], [-1, 0, 0]), group: 'arm', damp: 0.9 },
  { name: 'ThighL', parent: 0, anchor: [4, 30, 0], off: [0, -7.5, 0], shape: { k: 'box', h: [3.4, 7.5, 3.4] }, con: swing(0.9, 1.4, [-0.4, 0.4], [0, -1, 0], [1, 0, 0]), group: 'leg', damp: 1 },
  { name: 'ThighR', parent: 0, anchor: [-4, 30, 0], off: [0, -7.5, 0], shape: { k: 'box', h: [3.4, 7.5, 3.4] }, con: swing(0.9, 1.4, [-0.4, 0.4], [0, -1, 0], [1, 0, 0]), group: 'leg', damp: 1 },
  { name: 'ShinL', parent: 7, anchor: [4, 15, 0], off: [0, -7, 0], shape: { k: 'box', h: [2.9, 7, 2.9] }, con: hinge([-0.05, 2.2], [1, 0, 0], [0, -1, 0]), group: 'leg', damp: 1 },
  { name: 'ShinR', parent: 8, anchor: [-4, 15, 0], off: [0, -7, 0], shape: { k: 'box', h: [2.9, 7, 2.9] }, con: hinge([-0.05, 2.2], [1, 0, 0], [0, -1, 0]), group: 'leg', damp: 1 },
  { name: 'FootL', parent: 9, anchor: [4, 1, 0], off: [0, 0, 3], shape: { k: 'box', h: [3, 1.5, 5.5] }, con: hinge([-0.4, 0.4], [1, 0, 0], [0, -1, 0]), group: 'leg', damp: 1 },
  { name: 'FootR', parent: 10, anchor: [-4, 1, 0], off: [0, 0, 3], shape: { k: 'box', h: [3, 1.5, 5.5] }, con: hinge([-0.4, 0.4], [1, 0, 0], [0, -1, 0]), group: 'leg', damp: 1 },
  { name: 'HandL', parent: 5, anchor: [31, 51, 0], off: [2, 0, 0], shape: { k: 'sphere', r: 2.6 }, con: swing(1.0, 1.0, [-1.2, 1.2], [1, 0, 0], [0, 1, 0]), group: 'arm', damp: 0.8 },
  { name: 'HandR', parent: 6, anchor: [-31, 51, 0], off: [-2, 0, 0], shape: { k: 'sphere', r: 2.6 }, con: swing(1.0, 1.0, [-1.2, 1.2], [-1, 0, 0], [0, 1, 0]), group: 'arm', damp: 0.8 },
];
/** Имя физ-кости → индекс (для ретаргета humanoid-поза → цели, Ф3). */
export const RAG_INDEX: Record<string, number> = Object.fromEntries(B.map((b, i) => [b.name, i]));
/** Имена физ-костей по порядку индексов. */
export const RAG_NAMES: string[] = B.map((b) => b.name);

/**
 * Ретаргет: физ-кость ← сумма локальных углов гуманоид-костей под-цепочки. Все rest-фреймы мировые/identity
 * (и у гуманоида, и у физ-рига в T-позе), поэтому локальные эйлеры складываются напрямую (для мелких/соосных
 * поворотов — точно; для крупных — приближение, физика/лимиты сглаживают). Слитые кости: торс = Spine+Chest+
 * UpperChest, голова = Neck+Head, плечо = Shoulder+UpperArm.
 */
const RETARGET: Record<string, string[]> = {
  Torso: ['Spine', 'Chest', 'UpperChest'], Head: ['Neck', 'Head'],
  ArmL: ['LeftShoulder', 'LeftUpperArm'], ArmR: ['RightShoulder', 'RightUpperArm'],
  ForeL: ['LeftLowerArm'], ForeR: ['RightLowerArm'],
  ThighL: ['LeftUpperLeg'], ThighR: ['RightUpperLeg'],
  ShinL: ['LeftLowerLeg'], ShinR: ['RightLowerLeg'],
  FootL: ['LeftFoot'], FootR: ['RightFoot'], HandL: ['LeftHand'], HandR: ['RightHand'],
};
const _rtQ = new THREE.Quaternion(), _rtQ2 = new THREE.Quaternion(), _rtE = new THREE.Euler();
export function retargetHumanoidPose(pose: Record<string, [number, number, number]>): (Vec3 | null)[] {
  return B.map((b) => {
    const src = RETARGET[b.name]; if (!src) return null;
    // КОМПОЗИЦИЯ кватернионов под-цепочки (parent→child), а не сумма эйлеров: для КРУПНЫХ углов
    // (занос топора, глубокий присед) сумма промахивалась — физика целилась мимо позы. Кватернионы точны.
    _rtQ.identity();
    for (const nm of src) { const p = pose[nm]; if (p) { _rtE.set(p[0], p[1], p[2]); _rtQ2.setFromEuler(_rtE); _rtQ.multiply(_rtQ2); } }
    _rtE.setFromQuaternion(_rtQ);
    return [_rtE.x, _rtE.y, _rtE.z];
  });
}
/** Инверсный ретаргет (для запекания): физ-кость → ОСНОВНАЯ humanoid-кость, куда лечь её локальному повороту.
 *  Слитые кости пишутся в одну (торс→Spine, голова→Neck, плечо→UpperArm); остальные при applyPose = покой. */
const PRIMARY: Record<string, string> = {
  Torso: 'Spine', Head: 'Neck', ArmL: 'LeftUpperArm', ArmR: 'RightUpperArm', ForeL: 'LeftLowerArm', ForeR: 'RightLowerArm',
  ThighL: 'LeftUpperLeg', ThighR: 'RightUpperLeg', ShinL: 'LeftLowerLeg', ShinR: 'RightLowerLeg',
  FootL: 'LeftFoot', FootR: 'RightFoot', HandL: 'LeftHand', HandR: 'RightHand',
};
/** Цель ПИНА (позиц. подтяжка тела к анимации, идея PuppetMaster): физ-кость → humanoid-сустав (его мир-позиция). */
export const PIN_SRC: Record<string, string> = {
  Torso: 'Spine', Head: 'Neck', ArmL: 'LeftUpperArm', ArmR: 'RightUpperArm', ForeL: 'LeftLowerArm', ForeR: 'RightLowerArm',
  ThighL: 'LeftUpperLeg', ThighR: 'RightUpperLeg', ShinL: 'LeftLowerLeg', ShinR: 'RightLowerLeg',
  FootL: 'LeftFoot', FootR: 'RightFoot', HandL: 'LeftHand', HandR: 'RightHand',
};
/** Живые тюн-параметры физики (панель редактора). Пины = пружина к позиции цели; muscle = вес ведения к позе;
 *  match = вес совпадения РЕНДЕРА с манекеном (0 физика … 1 ровно поза-цель) — обрабатывается в renderRagdollGhost. */
export const PHYS = { pin: 1, pinKp: 4200, pinKd: 260, muscle: 1, load: 1, match: 0 };
/** Масса оружия (условные кг) → доп. вес на кисть, оттягивает руку (Ragdoll Animator «item heaviness»). */
export const WEAPON_MASS: Record<string, number> = {
  sword: 6, dagger: 3, axe: 12, mace: 13, staff: 5, spear: 8, greatsword: 15, greataxe: 20, greatmaul: 24,
  halberd: 16, bow: 4, crossbow: 9, shield: 11,
};
/** Масса рук [правая, левая] по ключу оружия main(+off). Обобщённо: главное → правая, офф (щит/оружие) → левая. */
export function weaponHandMasses(weapon: string): [number, number] {
  if (weapon === 'dual') weapon = 'sword+dagger';
  if (!weapon || weapon === 'none') return [0, 0];
  if (weapon === 'bow') return [0, WEAPON_MASS.bow!];            // лук в левой руке
  if (weapon === 'crossbow') return [WEAPON_MASS.crossbow!, 0];  // арбалет в правой (меш там же)
  if (weapon === 'shield') return [0, WEAPON_MASS.shield!];      // одинокий щит — левая
  const i = weapon.lastIndexOf('+');
  if (i > 0) return [WEAPON_MASS[weapon.slice(0, i)] ?? 6, WEAPON_MASS[weapon.slice(i + 1)] ?? 6];
  return [WEAPON_MASS[weapon] ?? 6, 0];
}

const LAYER_DOLL = 1;                                     // как в PhysWorld (STATIC=0, DOLL=1)
const DENSITY = 1000 / (TILE * TILE * TILE);              // настоящие кг при метре=32u (см. ragdoll.ts)
const PELVIS_Y = 32;
const GRAV = 9.81 * TILE;                                 // u/с² (метр=32u) — для веса оружия на кисти
// «Сила мышц» и жёсткость по группам (кг·u²/с², Гц) — ЖИВОЙ тюн (панель редактора, RB3), применяется ПЕРЕСБОРКОЙ куклы.
// Ноги сильные; руки крепкие — держат T-позу горизонтально. Экспорт мутабелен: правит редактор/игра перед созданием рэгдолла.
export const MOTOR: Record<MGroup, [number, number]> = { leg: [20, 6e6], arm: [20, 6e6], core: [15, 3e6], head: [13, 2e5] };
// ЛИМИТЫ суставов — МНОЖИТЕЛЬ конусов swing / диапазонов hinge по группам (RB3): >1 = сгибается сильнее (дотянуться до
// экстремальных поз), <1 = жёстче. Применяется при СОЗДАНИИ (makeCon) → смена = пересборка куклы. Глобально на всех гуманоидов.
export const LIMITS: Record<MGroup, number> = { leg: 1, arm: 1, core: 1, head: 1 };
/** Загрузить лимиты/моторы (localStorage `pe_ragdoll`, ГЛОБАЛЬНО на всех) в LIMITS/MOTOR — ЗВАТЬ ДО создания рэгдолла. */
export function loadRagdollConfig(): void {
  try {
    const c = JSON.parse(localStorage.getItem('pe_ragdoll') || '{}') as { limits?: Partial<Record<MGroup, number>>; motor?: Partial<Record<MGroup, [number, number]>> };
    const gs: MGroup[] = ['leg', 'arm', 'core', 'head'];
    if (c.limits) for (const g of gs) if (typeof c.limits[g] === 'number') LIMITS[g] = c.limits[g]!;
    if (c.motor) for (const g of gs) if (Array.isArray(c.motor[g])) MOTOR[g] = c.motor[g]!;
  } catch { /* */ }
}
export function saveRagdollConfig(): void {
  try { localStorage.setItem('pe_ragdoll', JSON.stringify({ limits: { ...LIMITS }, motor: { ...MOTOR } })); } catch { /* */ }
}

export interface HumanoidRagdoll {
  group: THREE.Group;                                     // призрак-меши (полупрозрачные)
  /** Задать целевые локальные повороты физ-костей (эйлер по индексу). null-элемент = покой. */
  setTarget(target: (Vec3 | null)[]): void;
  /** Цель из АВТОРСКОЙ humanoid-позы (эйлеры костей) через ретаргет. */
  setPoseTarget(pose: Record<string, [number, number, number]>): void;
  /** Мировой транзформ таза (kinematic-авторитет) — обычно = Hips манекена. */
  setPelvis(pos: THREE.Vector3, quat: THREE.Quaternion): void;
  /** Мировые цели ПИНОВ по индексу физ-кости (обычно = мир-позиции суставов манекена). null = без пина. */
  setPinTargets(targets: (THREE.Vector3 | null)[]): void;
  /** Per-bone веса: pin (позиц. подтяжка) и muscle (ведение к позе), по имени физ-кости. */
  setWeights(name: string, pin: number, muscle: number): void;
  /** Доп. вес (кг) на кость — вес оружия оттягивает кисть. */
  setLoad(name: string, kg: number): void;
  /** Дёрг: импульс в кость (мир-направление·сила). */
  hit(name: string, dx: number, dy: number, dz: number, power?: number): void;
  /** Смерть: моторы off + таз dynamic + пины off → свободный коллапс (и обратно). */
  setDead(d: boolean): void;
  /** Жёстко поставить тела на текущую позу-цель + обнулить скорости (спавн без перехлёста T-поза→стойка). */
  snapToPose(): void;
  /** Окно-culling: on=false → RemoveFromPhysicsSystem (тела вон из pw.step); on=true → AddToPhysicsSystem+Activate. */
  setSimEnabled(on: boolean): void;
  update(dt: number): void;                               // ведём к цели + двигаем kinematic-таз + синк мешей
  bodyPos(name: string): [number, number, number];        // мировая позиция тела (дебаг/тест)
  /** Снять ФИЗ-результат как humanoid-позу (локальные эйлеры костей) — для запекания. */
  readBakedPose(): Record<string, [number, number, number]>;
  dispose(): void;
}

export function makeHumanoidRagdoll(pw: PhysWorld): HumanoidRagdoll {
  const J = jolt();
  const group = new THREE.Group();

  // ── Формы (смещённые от сустава) ──
  const shapes = B.map((b) => {
    const s = b.shape;
    let inner;
    if (s.k === 'sphere') inner = new J.SphereShapeSettings(s.r);
    else { const h = new J.Vec3(s.h[0], s.h[1], s.h[2]); inner = new J.BoxShapeSettings(h, 0.2); J.destroy(h); }
    inner.mDensity = DENSITY;
    const off = new J.Vec3(b.off[0], b.off[1], b.off[2]);
    const rot = new J.Quat(0, 0, 0, 1);
    const shape = new J.RotatedTranslatedShapeSettings(off, rot, inner).Create().Get();
    J.destroy(rot); J.destroy(off);
    return shape;
  });

  // ── Скелет ──
  const skeleton = new J.Skeleton();
  for (const b of B) { const nm = new J.JPHString(b.name, b.name.length); skeleton.AddJoint(nm, b.parent); J.destroy(nm); }

  // ── Суставы ──
  const makeCon = (b: HBone): InstanceType<JoltNS['TwoBodyConstraintSettings']> => {
    const [ax, ay, az] = b.anchor;
    const [freq, torque] = MOTOR[b.group]; const L = LIMITS[b.group];   // L = множитель лимитов группы (RB3)
    const c = b.con!;
    const spring = (m: InstanceType<JoltNS['MotorSettings']>): void => {
      m.mSpringSettings.mMode = J.ESpringMode_FrequencyAndDamping;
      m.mSpringSettings.mFrequency = freq; m.mSpringSettings.mDamping = b.damp;
      m.mMinTorqueLimit = -torque; m.mMaxTorqueLimit = torque;
    };
    if (c.kind === 'hinge') {
      const s = new J.HingeConstraintSettings();
      const p1 = new J.RVec3(ax, ay, az), p2 = new J.RVec3(ax, ay, az);
      const h1 = new J.Vec3(...c.axis), h2 = new J.Vec3(...c.axis);
      const n1 = new J.Vec3(...c.normal), n2 = new J.Vec3(...c.normal);
      s.mPoint1 = p1; s.mPoint2 = p2; s.mHingeAxis1 = h1; s.mHingeAxis2 = h2; s.mNormalAxis1 = n1; s.mNormalAxis2 = n2;
      s.mLimitsMin = clamp(c.lim[0] * L, -3.1, 3.1); s.mLimitsMax = clamp(c.lim[1] * L, -3.1, 3.1);
      spring(s.mMotorSettings);
      J.destroy(p1); J.destroy(p2); J.destroy(h1); J.destroy(h2); J.destroy(n1); J.destroy(n2);
      return s;
    }
    const s = new J.SwingTwistConstraintSettings();
    const p1 = new J.RVec3(ax, ay, az), p2 = new J.RVec3(ax, ay, az);
    const t1 = new J.Vec3(...c.twist), t2 = new J.Vec3(...c.twist);
    const pl1 = new J.Vec3(...c.plane), pl2 = new J.Vec3(...c.plane);
    s.mPosition1 = p1; s.mPosition2 = p2; s.mTwistAxis1 = t1; s.mTwistAxis2 = t2; s.mPlaneAxis1 = pl1; s.mPlaneAxis2 = pl2;
    s.mSwingType = J.ESwingType_Pyramid;
    s.mNormalHalfConeAngle = clamp(c.nCone * L, 0, 3.0); s.mPlaneHalfConeAngle = clamp(c.pCone * L, 0, 3.0);
    s.mTwistMinAngle = clamp(c.twistLim[0] * L, -3.1, 3.1); s.mTwistMaxAngle = clamp(c.twistLim[1] * L, -3.1, 3.1);
    spring(s.mSwingMotorSettings); spring(s.mTwistMotorSettings);
    J.destroy(p1); J.destroy(p2); J.destroy(t1); J.destroy(t2); J.destroy(pl1); J.destroy(pl2);
    return s;
  };

  // ── Части ──
  const settings = new J.RagdollSettings();
  settings.mSkeleton = skeleton;
  settings.mParts.resize(B.length);
  for (let i = 0; i < B.length; i++) {
    const b = B[i]!;
    const part = settings.mParts.at(i);
    const pos = new J.RVec3(b.anchor[0], b.anchor[1], b.anchor[2]);
    const rot = new J.Quat(0, 0, 0, 1);
    part.SetShape(shapes[i]!);
    part.mPosition = pos; part.mRotation = rot;
    part.mMotionType = i === 0 ? J.EMotionType_Kinematic : J.EMotionType_Dynamic;
    part.mObjectLayer = LAYER_DOLL;
    part.mAllowSleeping = false;
    if (b.con) part.mToParent = makeCon(b);
    J.destroy(rot); J.destroy(pos);
  }
  settings.Stabilize();
  settings.DisableParentChildCollisions();
  settings.CalculateBodyIndexToConstraintIndex();
  const ragdoll = settings.CreateRagdoll(0, 0, pw.system);
  ragdoll.AddToPhysicsSystem(J.EActivation_Activate);

  const ids = B.map((_, i) => new J.BodyID(ragdoll.GetBodyID(i).GetIndexAndSequenceNumber()));   // копируем BodyID

  // ── Поза покоя (локальные смещения костей) ──
  const pose = new J.SkeletonPose();
  pose.SetSkeleton(skeleton);
  for (let i = 0; i < B.length; i++) {
    const b = B[i]!;
    const p: Vec3 = b.parent < 0 ? [0, 0, 0] : B[b.parent]!.anchor;
    const js = pose.GetJoint(i);
    js.mTranslation.Set(b.anchor[0] - p[0], b.anchor[1] - p[1], b.anchor[2] - p[2]);
    js.mRotation.Set(0, 0, 0, 1);
  }

  // ── Призрак-меши (полупрозрачные, поверх кинематического манекена) ──
  const ghostMat = new THREE.MeshStandardMaterial({ color: 0x39d0ff, transparent: true, opacity: 0.45, roughness: 0.5 });
  const meshes = B.map((b) => {
    const s = b.shape;
    const geo = s.k === 'sphere' ? new THREE.SphereGeometry(s.r, 12, 10) : new THREE.BoxGeometry(s.h[0] * 2, s.h[1] * 2, s.h[2] * 2);
    const m = new THREE.Mesh(geo, ghostMat); group.add(m); return m;
  });
  const offs = B.map((b) => new THREE.Vector3(...b.off));

  const kPos = new J.RVec3(0, 0, 0), kRot = new J.Quat(0, 0, 0, 1), force = new J.Vec3(0, 0, 0);
  const q = new THREE.Quaternion(), qi = new THREE.Quaternion(), e = new THREE.Euler(), tmp = new THREE.Vector3();
  const wq = B.map(() => new THREE.Quaternion()), invQ = new THREE.Quaternion(), locQ = new THREE.Quaternion(), eb = new THREE.Euler();
  let target: (Vec3 | null)[] = B.map(() => null);
  let pinTargets: (THREE.Vector3 | null)[] = B.map(() => null);
  const pinW = B.map(() => 1), muscleW = B.map(() => 1);   // per-bone веса
  const limp = B.map(() => 0);                             // 0..1 временная «отпущенность» (дёрг от удара, затухает)
  const load = B.map(() => 0);                             // доп. вес (кг) на кость — оружие оттягивает кисть
  let dead = false;
  const pelvisPos = new THREE.Vector3(0, PELVIS_Y, 0), pelvisQuat = new THREE.Quaternion();
  const conState = (c: ReturnType<typeof ragdoll.GetConstraint>, state: number): void => {
    if (c.GetSubType() === J.EConstraintSubType_SwingTwist) { const st = J.castObject(c, J.SwingTwistConstraint); st.SetSwingMotorState(state); st.SetTwistMotorState(state); }
    else if (c.GetSubType() === J.EConstraintSubType_Hinge) J.castObject(c, J.HingeConstraint).SetMotorState(state);
  };
  const setMotors = (state: number): void => { for (let i = 0; i < ragdoll.GetConstraintCount(); i++) conState(ragdoll.GetConstraint(i), state); };
  // Мотор одной кости (индекс сустава = индекс кости − 1, т.к. таз без сустава). Off = кость свободна (дёрг виден).
  const setBoneMotor = (bi: number, on: boolean): void => conState(ragdoll.GetConstraint(bi - 1), on ? J.EMotorState_Position : J.EMotorState_Off);

  function sync(): void {
    for (let i = 0; i < meshes.length; i++) {
      const p = pw.bi.GetPosition(ids[i]!), r = pw.bi.GetRotation(ids[i]!);
      const m = meshes[i]!;
      m.quaternion.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW());
      tmp.copy(offs[i]!).applyQuaternion(m.quaternion);
      m.position.set(p.GetX() + tmp.x, p.GetY() + tmp.y, p.GetZ() + tmp.z);
    }
  }
  sync();
  let simOn = true;   // окно-culling: тела в физ-мире (pw.step считает). false → RemoveFromPhysicsSystem, меш замерзает.

  return {
    group,
    setTarget(t) { target = t; },
    setPoseTarget(p) { target = retargetHumanoidPose(p); },
    setPelvis(pos, quat) { if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) { pelvisPos.copy(pos); pelvisQuat.copy(quat); } },
    setPinTargets(t) { pinTargets = t; },
    setWeights(name, pin, muscle) { const i = RAG_INDEX[name]; if (i !== undefined) { pinW[i] = pin; muscleW[i] = muscle; } },
    setLoad(name, kg) { const i = RAG_INDEX[name]; if (i !== undefined) load[i] = kg; },
    hit(name, dx, dy, dz, power = 1) {
      const i = RAG_INDEX[name]; if (i === undefined) return;
      const s = 9000 * power; force.Set(dx * s, dy * s, dz * s); pw.bi.AddImpulse(ids[i]!, force);
      // «отпустить» задетую зону (верх тела), чтобы дёрг был виден и затем вернулся пинами
      for (const n of ['Torso', 'Head', 'ArmL', 'ArmR', 'ForeL', 'ForeR', 'HandL', 'HandR']) { const k = RAG_INDEX[n]; if (k !== undefined) limp[k] = 1; }
    },
    setDead(d) {
      if (d === dead) return; dead = d;
      setMotors(d ? J.EMotorState_Off : J.EMotorState_Position);
      pw.bi.SetMotionType(ids[0]!, d ? J.EMotionType_Dynamic : J.EMotionType_Kinematic, J.EActivation_Activate);
    },
    snapToPose() {   // жёстко на позу-цель (SetPose) + скорости в ноль — старт сразу в стойке, без флейла
      const root = pose.GetJoint(0);
      root.mTranslation.Set(pelvisPos.x, pelvisPos.y, pelvisPos.z); root.mRotation.Set(pelvisQuat.x, pelvisQuat.y, pelvisQuat.z, pelvisQuat.w);
      for (let i = 1; i < B.length; i++) {
        const t = target[i];
        if (t) { e.set(t[0], t[1], t[2]); q.setFromEuler(e); pose.GetJoint(i).mRotation.Set(q.x, q.y, q.z, q.w); }
        else pose.GetJoint(i).mRotation.Set(0, 0, 0, 1);
      }
      kPos.Set(0, 0, 0); pose.SetRootOffset(kPos); pose.CalculateJointMatrices();
      ragdoll.SetPose(pose, true);
      force.Set(0, 0, 0);
      for (let i = 0; i < B.length; i++) { pw.bi.SetLinearVelocity(ids[i]!, force); pw.bi.SetAngularVelocity(ids[i]!, force); }
    },
    setSimEnabled(on) {   // окно-culling: вон из/в физ-мир (pw.step). Пробуждённого тут же активируем — снап к позе делает вызывающий (snapNext).
      if (on === simOn) return; simOn = on;
      if (on) ragdoll.AddToPhysicsSystem(J.EActivation_Activate);
      else ragdoll.RemoveFromPhysicsSystem();
    },
    update(dt) {
      for (let i = 0; i < B.length; i++) if (limp[i]! > 0) limp[i] = Math.max(0, limp[i]! - dt / 0.4);   // дёрг затухает ~0.4с
      const root = pose.GetJoint(0);
      root.mTranslation.Set(pelvisPos.x, pelvisPos.y, pelvisPos.z); root.mRotation.Set(pelvisQuat.x, pelvisQuat.y, pelvisQuat.z, pelvisQuat.w);
      for (let i = 1; i < B.length; i++) {
        const t = target[i];
        if (t) {
          e.set(t[0], t[1], t[2]); q.setFromEuler(e);
          const mw = clamp(muscleW[i]! * PHYS.muscle * (1 - limp[i]!), 0, 1);   // вес мышцы (и временный дёрг): слабая мышца ведёт меньше
          if (mw < 0.999) { qi.identity(); qi.slerp(q, mw); q.copy(qi); }
          pose.GetJoint(i).mRotation.Set(q.x, q.y, q.z, q.w);
        } else pose.GetJoint(i).mRotation.Set(0, 0, 0, 1);
      }
      kPos.Set(0, 0, 0); pose.SetRootOffset(kPos); pose.CalculateJointMatrices();
      if (!dead) {
        ragdoll.DriveToPoseUsingMotors(pose);
        for (let i = 1; i < B.length; i++) setBoneMotor(i, limp[i]! < 0.5);   // отпущенные кости — мотор off (дёрг), вернулись — on
      }
      // ПИНЫ (PuppetMaster-стиль): пружина AddForce тянет тело к позиции цели — держит силуэт, убирает провисание.
      if (!dead && PHYS.pin > 0) {
        for (let i = 1; i < B.length; i++) {
          const tp = pinTargets[i]; const w = pinW[i]! * PHYS.pin * (1 - limp[i]!);
          if (!tp || w <= 0) continue;
          const bp = pw.bi.GetPosition(ids[i]!), bv = pw.bi.GetLinearVelocity(ids[i]!);
          force.Set(((tp.x - bp.GetX()) * PHYS.pinKp - bv.GetX() * PHYS.pinKd) * w * dt,   // импульс = сила·dt (AddImpulse надёжнее биндинга AddForce)
            ((tp.y - bp.GetY()) * PHYS.pinKp - bv.GetY() * PHYS.pinKd) * w * dt,
            ((tp.z - bp.GetZ()) * PHYS.pinKp - bv.GetZ() * PHYS.pinKd) * w * dt);
          pw.bi.AddImpulse(ids[i]!, force);
        }
      }
      if (!dead && PHYS.load > 0) {   // вес оружия: доп. гравитация на нагруженную кисть → руку оттягивает
        for (let i = 1; i < B.length; i++) { const ld = load[i]!; if (ld > 0) { force.Set(0, -ld * GRAV * PHYS.load * dt, 0); pw.bi.AddImpulse(ids[i]!, force); } }
      }
      kPos.Set(pelvisPos.x, pelvisPos.y, pelvisPos.z); kRot.Set(pelvisQuat.x, pelvisQuat.y, pelvisQuat.z, pelvisQuat.w);
      if (!dead) pw.bi.MoveKinematic(ids[0]!, kPos, kRot, dt);
      sync();
    },
    bodyPos(name) { const i = RAG_INDEX[name]!; const p = pw.bi.GetPosition(ids[i]!); return [+p.GetX().toFixed(1), +p.GetY().toFixed(1), +p.GetZ().toFixed(1)]; },
    readBakedPose() {
      const out: Record<string, [number, number, number]> = {};
      for (let i = 0; i < B.length; i++) { const r = pw.bi.GetRotation(ids[i]!); wq[i]!.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW()); }
      eb.setFromQuaternion(wq[0]!); out['Hips'] = [eb.x, eb.y, eb.z];   // таз (мировой = кинематический)
      for (let i = 1; i < B.length; i++) {
        invQ.copy(wq[B[i]!.parent]!).invert(); locQ.copy(invQ).multiply(wq[i]!);   // локальный поворот = parent⁻¹·world
        eb.setFromQuaternion(locQ);
        out[PRIMARY[B[i]!.name]!] = [+eb.x.toFixed(4), +eb.y.toFixed(4), +eb.z.toFixed(4)];
      }
      return out;
    },
    dispose() {
      if (simOn) ragdoll.RemoveFromPhysicsSystem();   // спящий (окно-culling) уже вынут — второй Remove крашит wasm
      // формы/settings/ragdoll не destroy'им (кэш/крэш wasm) — утечка копеечная
      J.destroy(pose);
      for (const m of meshes) m.geometry.dispose();
      group.clear();
    },
  };
}

// ── ЕДИНЫЙ РЕНДЕР ФИЗ-ПРИЗРАКА (редактор + игра) ─────────────────────────────────────
const _gq = new THREE.Quaternion(), _gqT = new THREE.Quaternion(), _geu = new THREE.Euler();

/** Состояние заземления призрака — сглаженный вертикальный сдвиг корня. По одному на куклу/призрак. */
export interface GhostGround { off: number }
export const newGhostGround = (): GhostGround => ({ off: 0 });


/**
 * Ведём humanoid-МЕШ результатом рэгдолла: `readBakedPose()` → локальные повороты костей,
 * `bodyPos('Hips')` → мир-позиция корня, + ЗАЗЕМЛЕНИЕ низшей стопы к полу. Реконструкция 21-костного
 * меша из 15-костной физики чуть промахивается по длине ног (стопа уходит вниз) — прижим корня по
 * низшей стопе это чинит (сглажено, чтобы не дёргалось). ОДИН код для редакторного призрака и игровой куклы.
 * @param floorY уровень пола (0 в редакторе и в игре — верх статики на y=0).
 * @param ground true на стоянке/беге (клампить стопу к полу); false на смерти/полёте (прижим затухает, физика летит).
 * @param targetPose 21-костная поза-цель (манекен) для бленда; null → чистая физика.
 * @param match 0..1 — вес совпадения с манекеном (RB2): 0 = физрезультат, 1 = ровно поза-цель (физика лишь для реакций/ударов).
 * @param groundAt высота пола (мир) в точке XZ — рейкаст. Не задан → плоский floorY. FOOT-IK ставит стопу на этот пол.
 * @param support [лев, прав] — какая нога ОПОРНАЯ (из позы: !swing). Заземляем/кладём плоско ТОЛЬКО опорные, маховую
 *   ведёт поза (носок задран). Не задан → эвристика по высоте стопы.
 */
export function renderRagdollGhost(
  mesh: Humanoid, rag: HumanoidRagdoll, gs: GhostGround, dt: number, floorY = 0, ground = true,
  targetPose: Record<string, [number, number, number]> | null = null, match = 0, groundAt?: GroundQuery,
  support?: [boolean, boolean],
): void {
  const gnd = groundAt ?? ((): number => floorY);
  const bp = rag.readBakedPose(); mesh.reset();
  if (match > 0.001 && targetPose) {   // БЛЕНД физрезультат → цель по match: точное совпадение с манекеном
    for (const nm in targetPose) {
      const b = mesh.bones.get(nm); if (!b) continue;
      const t = targetPose[nm]!; _geu.set(t[0], t[1], t[2]); _gqT.setFromEuler(_geu);   // цель (манекен)
      const baked = bp[nm];
      if (baked) { _geu.set(baked[0], baked[1], baked[2]); _gq.setFromEuler(_geu); } else _gq.copy(b.quaternion);   // физика (или покой у слитых костей)
      b.quaternion.copy(_gq).slerp(_gqT, match);
    }
  } else {
    for (const nm in bp) { const b = mesh.bones.get(nm); if (b) b.rotation.set(bp[nm]![0], bp[nm]![1], bp[nm]![2]); }
  }
  const hp = rag.bodyPos('Hips');
  if (!ground) gs.off += (0 - gs.off) * Math.min(1, dt * 8);         // смерть/полёт: прижим затухает
  mesh.root.position.set(hp[0], hp[1] + gs.off, hp[2]);
  mesh.root.updateMatrixWorld(true);
  if (ground) groundFeet(mesh, hp[1], gs, dt, gnd, support);   // FOOT-IK: заземляем ОПОРНЫЕ стопы (маховую ведёт поза)
}
