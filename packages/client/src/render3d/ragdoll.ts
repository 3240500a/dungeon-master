/**
 * АКТИВНЫЙ РЭГДОЛЛ на Jolt Physics (`jolt-physics` — wasm-порт движка из Horizon Forbidden West /
 * Death Stranding 2). Пришёл на смену Rapier: там в JS-биндингах моторы есть ТОЛЬКО у revolute
 * (dimforge/rapier.js#287), поэтому риг выходил одноосевым, а ведение к позе — рукописным.
 *
 * Здесь всё штатно:
 * - `Skeleton` + `RagdollSettings` — иерархия костей. Тело кости начинается В СУСТАВЕ (форма сдвинута
 *   `RotatedTranslatedShape`), поэтому кость вращается вокруг сустава, а не вокруг своего центра.
 * - Суставы анатомические: спина/шея/плечи/бёдра — `SwingTwist` (эллиптический конус + скрутка),
 *   колени/локти/щиколотки — `Hinge` с АСИММЕТРИЧНЫМИ лимитами (колено не выворачивается — by design).
 * - «Мышцы» — моторы суставов с `mMaxTorqueLimit`: предел силы по группам (ноги сильные, руки/спина
 *   слабые — рецепт Exanima: «minimized muscle strength so arms and spine are expressed naturally»).
 * - Ведение к позе ghost-рига (`pose.ts`) — встроенным `Ragdoll.DriveToPoseUsingMotors`.
 *
 * Авторитет сима не ломаем: ТАЗ — kinematic, стоит ровно там, где сказала игра; тело болтается вокруг.
 * Смерть → таз Dynamic + моторы Off → свободный коллапс.
 * Единицы: 32u = 1 м, гравитация -9.81*32. Допуски Jolt заданы в метрах — масштабируем их под наш мир.
 *
 * ⚠️ ГРАБЛИ emscripten: методы, возвращающие значение (`Quat.sIdentity()`, `Ragdoll.GetBodyID()`,
 * `Mat44.GetTranslation()` …), отдают ПЕРЕИСПОЛЬЗУЕМУЮ временную обёртку, а не свежий объект.
 * `J.destroy()` на такой — порча аллокатора (немой abort / «table index out of bounds» позже в Step),
 * а складывать её в массив бессмысленно (все элементы укажут на последнее значение).
 * Уничтожать можно ТОЛЬКО то, что создал сам через `new`; значения — копировать сразу.
 */
import * as THREE from 'three';
import initJolt from 'jolt-physics';
import { TILE, Cell, type DungeonLayout } from '@dm/shared';
import { PoseDriver, type PoseTargets } from './pose.js';
import { WALL_H } from './env3d.js';

type JoltNS = Awaited<ReturnType<typeof initJolt>>;
let J!: JoltNS;

/** Скретч-объекты: emscripten-обёртки живут в куче wasm — плодить их каждый кадр нельзя. */
let kPos!: InstanceType<JoltNS['RVec3']>, kRot!: InstanceType<JoltNS['Quat']>, zeroV!: InstanceType<JoltNS['Vec3']>;

export async function initPhysics(): Promise<void> {
  J = await initJolt();
  kPos = new J.RVec3(0, 0, 0);
  kRot = new J.Quat(0, 0, 0, 1);
  zeroV = new J.Vec3(0, 0, 0);
}

const LAYER_STATIC = 0, LAYER_DOLL = 1, NUM_LAYERS = 2;
const BP_STATIC = 0, BP_MOVING = 1, NUM_BP = 2;

/** Физмир + статика этажа. */
export class PhysWorld {
  readonly jolt: InstanceType<JoltNS['JoltInterface']>;
  readonly system: ReturnType<InstanceType<JoltNS['JoltInterface']>['GetPhysicsSystem']>;
  readonly bi: ReturnType<ReturnType<InstanceType<JoltNS['JoltInterface']>['GetPhysicsSystem']>['GetBodyInterface']>;
  private statics: InstanceType<JoltNS['BodyID']>[] = [];

  constructor() {
    const s = new J.JoltSettings();
    // Ассерты Jolt иначе прилетают немым abort() — включаем расшифровку (в release-сборке молчит).
    const str = (p: number): string => { let out = ''; for (let i = p; J.HEAPU8[i]; i++) out += String.fromCharCode(J.HEAPU8[i]!); return out; };
    const ah = new J.AssertFailedHandlerJS();
    ah.OnAssertFailed = (expr: number, msg: number, file: number, line: number): void => {
      console.error(`JOLT ASSERT: ${str(expr)} | ${str(msg)} @ ${str(file)}:${line}`);
    };
    s.mAssertFailedHandler = ah;
    const objFilter = new J.ObjectLayerPairFilterTable(NUM_LAYERS);
    objFilter.EnableCollision(LAYER_STATIC, LAYER_DOLL);
    objFilter.EnableCollision(LAYER_DOLL, LAYER_DOLL);   // самопересечение соседних костей глушит GroupFilter рэгдолла
    const bp = new J.BroadPhaseLayerInterfaceTable(NUM_LAYERS, NUM_BP);
    bp.MapObjectToBroadPhaseLayer(LAYER_STATIC, new J.BroadPhaseLayer(BP_STATIC));
    bp.MapObjectToBroadPhaseLayer(LAYER_DOLL, new J.BroadPhaseLayer(BP_MOVING));
    s.mObjectLayerPairFilter = objFilter;
    s.mBroadPhaseLayerInterface = bp;
    s.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bp, NUM_BP, objFilter, NUM_LAYERS);
    this.jolt = new J.JoltInterface(s);
    J.destroy(s);
    this.system = this.jolt.GetPhysicsSystem();
    this.bi = this.system.GetBodyInterface();

    const g = new J.Vec3(0, -9.81 * TILE, 0);
    this.system.SetGravity(g);
    J.destroy(g);
    // Допуски Jolt откалиброваны на метры; у нас метр = 32 юнита — иначе контакты «слишком точные».
    const ps = this.system.GetPhysicsSettings();
    ps.mSpeculativeContactDistance *= TILE;
    ps.mPenetrationSlop *= TILE;
    this.system.SetPhysicsSettings(ps);
  }

  private addBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
    const half = new J.Vec3(hx, hy, hz);
    const shape = new J.BoxShape(half, 0.5);
    const pos = new J.RVec3(cx, cy, cz);
    const rot = new J.Quat(0, 0, 0, 1);   // НЕ sIdentity(): его нельзя destroy (см. шапку файла)
    const bcs = new J.BodyCreationSettings(shape, pos, rot, J.EMotionType_Static, LAYER_STATIC);
    const body = this.bi.CreateBody(bcs);
    this.bi.AddBody(body.GetID(), J.EActivation_DontActivate);
    this.statics.push(body.GetID());
    J.destroy(bcs); J.destroy(rot); J.destroy(pos); J.destroy(half);
  }

  /** Пол + видимые стены (смежные с проходимой клеткой) как статические тела. */
  buildStatic(layout: DungeonLayout): void {
    this.clearStatic();
    const grid = layout.grid, rows = grid.length, cols = grid[0]!.length;
    const walk = (x: number, y: number): boolean => grid[y]?.[x] !== undefined && grid[y]![x] !== Cell.Wall;
    this.addBox((cols * TILE) / 2, -2, (rows * TILE) / 2, (cols * TILE) / 2, 2, (rows * TILE) / 2);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (grid[y]![x] !== Cell.Wall) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (walk(x + dx, y + dy)) { near = true; break; }
      if (!near) continue;
      this.addBox(x * TILE + TILE / 2, WALL_H / 2, y * TILE + TILE / 2, TILE / 2, WALL_H / 2, TILE / 2);
    }
  }

  clearStatic(): void {
    for (const id of this.statics) { this.bi.RemoveBody(id); this.bi.DestroyBody(id); }
    this.statics = [];
  }

  step(dt: number): void { this.jolt.Step(dt, 1); }
}

// ── Риг ────────────────────────────────────────────────────────────────────────
type Con =
  | { kind: 'swing'; twist: [number, number, number]; plane: [number, number, number]; normalCone: number; planeCone: number; twistLim: [number, number] }
  | { kind: 'hinge'; axis: [number, number, number]; normal: [number, number, number]; lim: [number, number] };

interface BoneDef {
  name: string;
  parent: number;
  /** Мировой якорь сустава в позе покоя = НАЧАЛО тела (кость свисает от него). */
  anchor: [number, number, number];
  /** Смещение формы/меша от якоря. */
  off: [number, number, number];
  shape: { k: 'capsule'; hh: number; r: number } | { k: 'box'; h: [number, number, number] } | { k: 'sphere'; r: number };
  mat: 'body' | 'limb' | 'head';
  con: Con | null;
  /** Угол ghost-позы, крутящий эту кость вокруг локальной X, и его знак. */
  key: keyof PoseTargets | null;
  sign: number;
  /** Предел момента мотора — «сила мышцы». */
  torque: number;
  /** Жёсткость мотора: частота (Гц) и затухание. */
  freq: number;
  damp: number;
}

const DOWN: [number, number, number] = [0, -1, 0];
const AX_X: [number, number, number] = [1, 0, 0];
const AX_Z: [number, number, number] = [0, 0, 1];

/**
 * Плотность. Jolt по умолчанию 1000 (кг/м³), но метр у нас = 32 юнита → объёмы больше в 32³ = 32768 раз,
 * и тела весили бы сотни тысяч «кг» (бедро ~600 000), а моторам понадобился бы момент ~1e9. Делим на 32³ —
 * получаем НАСТОЯЩИЕ килограммы (бедро ~18 кг) при гравитации −9.81·32 u/с², т.е. физику метрового мира.
 */
const DENSITY = 1000 / (TILE * TILE * TILE);
/**
 * Сила мышц (предел момента, кг·u²/с²). Порядок задан массой: удержать бедро (~18 кг) на плече ~7.5u
 * при g=314 → ~4e4. Ноги сильные, руки и спина слабые — тогда они махаются от инерции сами (рецепт Exanima).
 */
const T_LEG = 6e6, T_CORE = 3e6, T_ARM = 3e5, T_HEAD = 2e5;

/**
 * «Сила мышц» моторов по группам — крутятся дебаг-панелью (клавиша G). Читаются при СБОРКЕ сустава
 * (`makeConstraint`), поэтому смена значений применяется ПЕРЕСОЗДАНИЕМ куклы (править мотор у живого
 * сустава роняет wasm). Тут же лечатся руки-«сосиски»: поднять armFreq/armTorque, чтобы махали, а не висли.
 */
export const MOTOR = {
  legFreq: 20, legTorque: T_LEG,
  armFreq: 6, armTorque: T_ARM,
  coreFreq: 15, coreTorque: T_CORE,
  headFreq: 13, headTorque: T_HEAD,
};
type MGroup = 'leg' | 'arm' | 'core' | 'head';
const motorGroup = (name: string): MGroup =>
  name.startsWith('thigh') || name.startsWith('shin') || name.startsWith('foot') ? 'leg'
    : name.startsWith('arm') || name.startsWith('fore') ? 'arm'
      : name === 'head' ? 'head' : 'core';
const motorVals = (g: MGroup): [number, number] =>
  g === 'leg' ? [MOTOR.legFreq, MOTOR.legTorque]
    : g === 'arm' ? [MOTOR.armFreq, MOTOR.armTorque]
      : g === 'head' ? [MOTOR.headFreq, MOTOR.headTorque]
        : [MOTOR.coreFreq, MOTOR.coreTorque];

const swing = (planeCone: number, normalCone: number, twistLim: [number, number], twist = DOWN, plane = AX_X): Con =>
  ({ kind: 'swing', twist, plane, normalCone, planeCone, twistLim });
const hinge = (lim: [number, number]): Con => ({ kind: 'hinge', axis: AX_X, normal: DOWN, lim });

/** Кости в порядке скелета (родитель всегда раньше ребёнка — требование Jolt). */
const BONES: BoneDef[] = [
  { name: 'pelvis', parent: -1, anchor: [0, 30, 0], off: [0, 0, 0], shape: { k: 'box', h: [5, 4, 3] }, mat: 'body', con: null, key: null, sign: 1, torque: 0, freq: 0, damp: 0 },
  { name: 'torso', parent: 0, anchor: [0, 32, 0], off: [0, 8, 0], shape: { k: 'capsule', hh: 5, r: 5.5 }, mat: 'body', con: swing(0.7, 0.4, [-0.5, 0.5], [0, 1, 0]), key: 'lean', sign: 1, torque: T_CORE, freq: 15, damp: 1 },
  { name: 'head', parent: 1, anchor: [0, 51, 0], off: [0, 5, 0], shape: { k: 'sphere', r: 5 }, mat: 'head', con: swing(0.5, 0.4, [-0.6, 0.6], [0, 1, 0]), key: null, sign: 1, torque: T_HEAD, freq: 13, damp: 1 },
  { name: 'armL', parent: 1, anchor: [-7, 48, 0], off: [0, -5.5, 0], shape: { k: 'capsule', hh: 4, r: 2.8 }, mat: 'limb', con: swing(1.7, 1.2, [-0.8, 0.8]), key: 'shL', sign: 1, torque: T_ARM, freq: 6, damp: 0.8 },
  { name: 'armR', parent: 1, anchor: [7, 48, 0], off: [0, -5.5, 0], shape: { k: 'capsule', hh: 4, r: 2.8 }, mat: 'limb', con: swing(1.7, 1.2, [-0.8, 0.8]), key: 'shR', sign: 1, torque: T_ARM, freq: 6, damp: 0.8 },
  { name: 'foreL', parent: 3, anchor: [-7, 37, 0], off: [0, -5, 0], shape: { k: 'capsule', hh: 4, r: 2.4 }, mat: 'limb', con: hinge([-2.2, 0.05]), key: 'elL', sign: -1, torque: T_ARM, freq: 6, damp: 0.8 },
  { name: 'foreR', parent: 4, anchor: [7, 37, 0], off: [0, -5, 0], shape: { k: 'capsule', hh: 4, r: 2.4 }, mat: 'limb', con: hinge([-2.2, 0.05]), key: 'elR', sign: -1, torque: T_ARM, freq: 6, damp: 0.8 },
  { name: 'thighL', parent: 0, anchor: [-3.6, 30, 0], off: [0, -7.5, 0], shape: { k: 'capsule', hh: 6, r: 3.4 }, mat: 'limb', con: swing(0.9, 1.4, [-0.4, 0.4]), key: 'hipL', sign: 1, torque: T_LEG, freq: 20, damp: 1 },
  { name: 'thighR', parent: 0, anchor: [3.6, 30, 0], off: [0, -7.5, 0], shape: { k: 'capsule', hh: 6, r: 3.4 }, mat: 'limb', con: swing(0.9, 1.4, [-0.4, 0.4]), key: 'hipR', sign: 1, torque: T_LEG, freq: 20, damp: 1 },
  { name: 'shinL', parent: 7, anchor: [-3.6, 15, 0], off: [0, -7.5, 0], shape: { k: 'capsule', hh: 6, r: 2.9 }, mat: 'limb', con: hinge([-0.05, 2.2]), key: 'knL', sign: 1, torque: T_LEG, freq: 20, damp: 1 },
  { name: 'shinR', parent: 8, anchor: [3.6, 15, 0], off: [0, -7.5, 0], shape: { k: 'capsule', hh: 6, r: 2.9 }, mat: 'limb', con: hinge([-0.05, 2.2]), key: 'knR', sign: 1, torque: T_LEG, freq: 20, damp: 1 },
  { name: 'footL', parent: 9, anchor: [-3.6, 1.5, 0], off: [0, 0, 3], shape: { k: 'box', h: [3, 1.5, 5.5] }, mat: 'limb', con: hinge([-0.4, 0.4]), key: null, sign: 1, torque: T_LEG, freq: 20, damp: 1 },
  { name: 'footR', parent: 10, anchor: [3.6, 1.5, 0], off: [0, 0, 3], shape: { k: 'box', h: [3, 1.5, 5.5] }, mat: 'limb', con: hinge([-0.4, 0.4]), key: null, sign: 1, torque: T_LEG, freq: 20, damp: 1 },
];

/** Риг рождается СРАЗУ на месте спавна (x,z): иначе таз уедет к игроку один, а кости поволочёт через полкарты. */
export interface RagdollOpts { body?: number; limb?: number; head?: number; x?: number; z?: number }
export interface RagdollHandle {
  group: THREE.Group;
  /** Только для отладки из консоли (мостик кадров/драйв-тесты). */
  _dbg?: Record<string, unknown>;
  setPose(x: number, z: number, yaw: number): void;
  setMove(s: number): void;
  attack(power?: number): void;
  setDead(d: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

const PELVIS_Y = 30;
const FOOT_L = 11, FOOT_R = 12;   // индексы стоп в BONES

/**
 * Формы костей, СМЕЩЁННЫЕ от начала тела: начало тела = сустав, кость свисает от него.
 * Строятся ОДИН раз на всё приложение и переиспользуются всеми куклами (формы в Jolt неизменяемы
 * и共 разделяемы). Заодно снимает грабли: настройки форм уничтожать НЕЛЬЗЯ — они держат форму живой,
 * `destroy` после создания тел роняет wasm (проверено на стенде `joltTest.ts`).
 */
let SHAPES: InstanceType<JoltNS['Shape']>[] | null = null;
function shapes(): InstanceType<JoltNS['Shape']>[] {
  if (SHAPES) return SHAPES;
  SHAPES = BONES.map((b) => {
    const s = b.shape;
    let inner;
    if (s.k === 'capsule') inner = new J.CapsuleShapeSettings(s.hh, s.r);
    else if (s.k === 'sphere') inner = new J.SphereShapeSettings(s.r);
    else { const h = new J.Vec3(s.h[0], s.h[1], s.h[2]); inner = new J.BoxShapeSettings(h, 0.5); J.destroy(h); }
    inner.mDensity = DENSITY;   // иначе тела весят сотни тысяч «кг» и моторы бессильны
    const off = new J.Vec3(b.off[0], b.off[1], b.off[2]);
    const rot = new J.Quat(0, 0, 0, 1);   // НЕ sIdentity(): его нельзя destroy (см. шапку файла)
    const shape = new J.RotatedTranslatedShapeSettings(off, rot, inner).Create().Get();
    J.destroy(rot); J.destroy(off);
    return shape;
  });
  return SHAPES;
}

function makeGeo(b: BoneDef): THREE.BufferGeometry {
  const s = b.shape;
  if (s.k === 'capsule') return new THREE.CapsuleGeometry(s.r, s.hh * 2, 6, 10);
  if (s.k === 'sphere') return new THREE.SphereGeometry(s.r, 14, 14);
  return new THREE.BoxGeometry(s.h[0] * 2, s.h[1] * 2, s.h[2] * 2);
}

/** Настройки сустава: якорь один и тот же в мировых координатах позы покоя (Jolt сам выведет локальные оси). */
function makeConstraint(b: BoneDef, ox: number, oz: number): InstanceType<JoltNS['TwoBodyConstraintSettings']> {
  const ax = b.anchor[0] + ox, ay = b.anchor[1], az = b.anchor[2] + oz;
  const c = b.con!;
  // Сила/жёсткость мотора берётся из ЖИВОГО MOTOR по группе кости — чтобы дебаг-панель влияла на них при
  // пересоздании куклы (править мотор у уже живого сустава эти биндинги роняют wasm — только через сборку).
  const [mFreq, mTorque] = motorVals(motorGroup(b.name));
  const spring = (m: InstanceType<JoltNS['MotorSettings']>): void => {
    m.mSpringSettings.mMode = J.ESpringMode_FrequencyAndDamping;
    m.mSpringSettings.mFrequency = mFreq;
    m.mSpringSettings.mDamping = b.damp;
    m.mMinTorqueLimit = -mTorque;
    m.mMaxTorqueLimit = mTorque;
  };
  if (c.kind === 'hinge') {
    const s = new J.HingeConstraintSettings();
    const p1 = new J.RVec3(ax, ay, az), p2 = new J.RVec3(ax, ay, az);
    const h1 = new J.Vec3(...c.axis), h2 = new J.Vec3(...c.axis);
    const n1 = new J.Vec3(...c.normal), n2 = new J.Vec3(...c.normal);
    s.mPoint1 = p1; s.mPoint2 = p2;
    s.mHingeAxis1 = h1; s.mHingeAxis2 = h2;
    s.mNormalAxis1 = n1; s.mNormalAxis2 = n2;
    s.mLimitsMin = c.lim[0]; s.mLimitsMax = c.lim[1];
    spring(s.mMotorSettings);
    J.destroy(p1); J.destroy(p2); J.destroy(h1); J.destroy(h2); J.destroy(n1); J.destroy(n2);
    return s;
  }
  const s = new J.SwingTwistConstraintSettings();
  const p1 = new J.RVec3(ax, ay, az), p2 = new J.RVec3(ax, ay, az);
  const t1 = new J.Vec3(...c.twist), t2 = new J.Vec3(...c.twist);
  const pl1 = new J.Vec3(...c.plane), pl2 = new J.Vec3(...c.plane);
  s.mPosition1 = p1; s.mPosition2 = p2;
  s.mTwistAxis1 = t1; s.mTwistAxis2 = t2;
  s.mPlaneAxis1 = pl1; s.mPlaneAxis2 = pl2;
  // ПИРАМИДА, а не конус (по умолчанию Cone): круглый конус берёт ТОЛЬКО normalHalfCone и зажимает сустав
  // одним углом во все стороны. Для бедра это ±0.5 рад: назад хватает (бег задом выглядел нормально),
  // а вперёд нога упирается в предел и плетётся сзади. Пирамида уважает оба угла раздельно.
  s.mSwingType = J.ESwingType_Pyramid;
  s.mNormalHalfConeAngle = c.normalCone;
  s.mPlaneHalfConeAngle = c.planeCone;
  s.mTwistMinAngle = c.twistLim[0]; s.mTwistMaxAngle = c.twistLim[1];
  spring(s.mSwingMotorSettings); spring(s.mTwistMotorSettings);
  J.destroy(p1); J.destroy(p2); J.destroy(t1); J.destroy(t2); J.destroy(pl1); J.destroy(pl2);
  return s;
}

export function makeRagdoll(pw: PhysWorld, opts: RagdollOpts = {}): RagdollHandle {
  const group = new THREE.Group();
  const mats = {
    body: new THREE.MeshStandardMaterial({ color: opts.body ?? 0x8a93ad, roughness: 0.62, metalness: 0.25 }),
    limb: new THREE.MeshStandardMaterial({ color: opts.limb ?? 0x6f7690, roughness: 0.7, metalness: 0.15 }),
    head: new THREE.MeshStandardMaterial({ color: opts.head ?? 0xd8c0a0, roughness: 0.75 }),
  };

  // ── Скелет ──
  const skeleton = new J.Skeleton();
  for (const b of BONES) {
    const nm = new J.JPHString(b.name, b.name.length);
    skeleton.AddJoint(nm, b.parent);
    J.destroy(nm);
  }

  // ── Части + суставы ──
  const ox = opts.x ?? 0, oz = opts.z ?? 0;
  const shp = shapes();
  const settings = new J.RagdollSettings();
  settings.mSkeleton = skeleton;
  settings.mParts.resize(BONES.length);
  for (let i = 0; i < BONES.length; i++) {
    const b = BONES[i]!;
    const part = settings.mParts.at(i);
    const pos = new J.RVec3(b.anchor[0] + ox, b.anchor[1], b.anchor[2] + oz);
    const rot = new J.Quat(0, 0, 0, 1);   // НЕ sIdentity(): его нельзя destroy (см. шапку файла)
    part.SetShape(shp[i]!);
    part.mPosition = pos;
    part.mRotation = rot;
    part.mMotionType = i === 0 ? J.EMotionType_Kinematic : J.EMotionType_Dynamic;
    part.mObjectLayer = LAYER_DOLL;
    part.mAllowSleeping = false;
    if (b.con) part.mToParent = makeConstraint(b, ox, oz);
    J.destroy(rot); J.destroy(pos);
  }
  settings.Stabilize();                       // выправляет соотношения масс — иначе тонкие кости трясёт
  settings.DisableParentChildCollisions();    // соседние кости не толкаются, дальние — толкаются
  settings.CalculateBodyIndexToConstraintIndex();
  const ragdoll = settings.CreateRagdoll(0, 0, pw.system);
  ragdoll.AddToPhysicsSystem(J.EActivation_Activate);

  // ── Меши: тело начинается в суставе, форма/меш смещены на b.off ──
  const meshes = BONES.map((b) => {
    const m = new THREE.Mesh(makeGeo(b), mats[b.mat]);
    group.add(m);
    return m;
  });
  const offs = BONES.map((b) => new THREE.Vector3(b.off[0], b.off[1], b.off[2]));
  // BodyID КОПИРУЕМ по значению: биндинг отдаёт одну и ту же обёртку на каждый вызов —
  // сложив её в массив, получим 13 ссылок на последнее тело.
  const ids = BONES.map((_, i) => new J.BodyID(ragdoll.GetBodyID(i).GetIndexAndSequenceNumber()));

  // ── Поза ──
  const pose = new J.SkeletonPose();
  pose.SetSkeleton(skeleton);
  for (let i = 0; i < BONES.length; i++) {                 // локальные смещения позы покоя
    const b = BONES[i]!;
    const p: [number, number, number] = b.parent < 0 ? [0, 0, 0] : BONES[b.parent]!.anchor;
    const js = pose.GetJoint(i);
    js.mTranslation.Set(b.anchor[0] - p[0], b.anchor[1] - p[1], b.anchor[2] - p[2]);
    js.mRotation.Set(0, 0, 0, 1);
  }

  const driver = new PoseDriver();
  let px = ox, pz = oz, yawT = 0, dead = false;
  let prevX = ox, prevZ = oz, vx = 0, vz = 0;   // скорость тела — из разности позиций (сим её не отдаёт риг-у)
  let footLX = ox, footLZ = oz, footRX = ox, footRZ = oz;   // фактические щиколотки → планировщику шагов
  const q = new THREE.Quaternion(), e = new THREE.Euler(), tmp = new THREE.Vector3();

  /** Залить ghost-позу в SkeletonPose (локальные повороты костей вокруг своих суставов). */
  function writePose(t: PoseTargets): void {
    const root = pose.GetJoint(0);
    root.mTranslation.Set(0, PELVIS_Y + t.bobY, 0);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawT);
    root.mRotation.Set(q.x, q.y, q.z, q.w);
    for (let i = 1; i < BONES.length; i++) {
      const b = BONES[i]!;
      const ang = b.key ? (t[b.key] as number) * b.sign : 0;
      // Бёдрам — ещё и боковой вынос (вокруг Z): без него приставные шаги вырождаются в топтание.
      const lat = b.name === 'thighL' ? t.hipLatL : b.name === 'thighR' ? t.hipLatR : 0;
      e.set(ang, b.name === 'torso' ? t.twist : 0, lat);
      q.setFromEuler(e);
      pose.GetJoint(i).mRotation.Set(q.x, q.y, q.z, q.w);
    }
    kPos.Set(px, 0, pz);
    pose.SetRootOffset(kPos);
    pose.CalculateJointMatrices();
  }

  function setMotors(state: number): void {
    for (let i = 0; i < ragdoll.GetConstraintCount(); i++) {
      const c = ragdoll.GetConstraint(i);
      if (c.GetSubType() === J.EConstraintSubType_SwingTwist) {
        const st = J.castObject(c, J.SwingTwistConstraint);
        st.SetSwingMotorState(state); st.SetTwistMotorState(state);
      } else if (c.GetSubType() === J.EConstraintSubType_Hinge) {
        J.castObject(c, J.HingeConstraint).SetMotorState(state);
      }
    }
  }


  return {
    group,
    _dbg: { ragdoll, pose, ids, skeleton, J, driver },
    // NaN, попавший в физику, отравляет мир безвозвратно — не пускаем.
    setPose(x, z, yaw) { if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(yaw)) { px = x; pz = z; yawT = yaw; } },
    setMove(s) { driver.setMove(s); },
    attack(power = 1) { driver.attack(power); },
    setDead(d) {
      if (d === dead) return; dead = d;
      if (d) {   // моторы отпускаем, таз освобождаем → тело падает само
        setMotors(J.EMotorState_Off);
        pw.bi.SetMotionType(ids[0]!, J.EMotionType_Dynamic, J.EActivation_Activate);
      } else {
        setMotors(J.EMotorState_Position);
        pw.bi.SetMotionType(ids[0]!, J.EMotionType_Kinematic, J.EActivation_Activate);
      }
      driver.setDead(d);
    },
    update(dt) {
      if (dt > 0) {   // ноги шагают по МИРУ (планировщик шагов + IK), а не по синусу — иначе стопы едут юзом
        vx = (px - prevX) / dt; vz = (pz - prevZ) / dt;
        prevX = px; prevZ = pz;
        driver.setWorld(px, pz, yawT, vx, vz);
      }
      const t = driver.update(dt);
      if (!dead) {
        writePose(t);
        ragdoll.DriveToPoseUsingMotors(pose);
        kPos.Set(px, PELVIS_Y + t.bobY, pz);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawT);
        kRot.Set(q.x, q.y, q.z, q.w);
        pw.bi.MoveKinematic(ids[0]!, kPos, kRot, dt);
      }
      for (let i = 0; i < meshes.length; i++) {
        const p = pw.bi.GetPosition(ids[i]!), r = pw.bi.GetRotation(ids[i]!);
        const m = meshes[i]!;
        m.quaternion.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW());
        tmp.copy(offs[i]!).applyQuaternion(m.quaternion);
        m.position.set(p.GetX() + tmp.x, p.GetY() + tmp.y, p.GetZ() + tmp.z);
        // Начало тела стопы = щиколотка (форма смещена) — это ровно то, что нужно планировщику.
        if (i === FOOT_L) { footLX = p.GetX(); footLZ = p.GetZ(); }
        else if (i === FOOT_R) { footRX = p.GetX(); footRZ = p.GetZ(); }
      }
      driver.setFeet(footLX, footLZ, footRX, footRZ);
    },
    dispose() {
      ragdoll.RemoveFromPhysicsSystem();
      J.destroy(ragdoll); J.destroy(pose); J.destroy(settings);
      for (const m of meshes) m.geometry.dispose();
      group.clear();
    },
  };
}
