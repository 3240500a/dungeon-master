/**
 * ГУМАНОИД-СКЕЛЕТ (аналог общего гуманоида Unity, ~21 кость) в T-позе — фундамент pose-editor'а и будущего
 * ретаргета зариганых glTF-моделей. Кинематический: иерархия пивот-групп (крутим `.rotation` сустава = FK).
 * Конвенция как у Mixamo/Unity: лицом +Z, вверх +Y, **Left = +X** (правильный L/R, БЕЗ зеркала рэгдолла).
 * Масштаб: TILE=32u=1 м, рост ~1.9 м. Имена костей — Unity (`LeftUpperArm` и т.д.) для карты ретаргета.
 */
import * as THREE from 'three';
import { lenMult, pelvisHeight, girthMult, boneScaleOf, boneRegion, type BodyProfile, type BoneScale } from './bodyProfile.js';

/** Геометрия кисти: [отступ пястной кости от запястья, длины трёх фаланг]. Пальцы идут вдоль +X (наружу). */
export const FINGER_GEO: [string, [number, number, number], number[]][] = [
  ['Thumb', [1.3, -0.5, 1.7], [1.5, 1.2, 1.0]],
  ['Index', [3.5, 0.2, 1.5], [1.7, 1.1, 0.9]],
  ['Middle', [3.7, 0.2, 0.5], [1.9, 1.2, 0.9]],
  ['Ring', [3.5, 0.2, -0.5], [1.7, 1.1, 0.9]],
  ['Little', [3.1, 0.1, -1.4], [1.3, 0.9, 0.8]],
];
export const FINGER_SEG = ['Proximal', 'Intermediate', 'Distal'];
/** 30 фаланг (2 руки × 5 пальцев × 3). Правая сторона — зеркало по X (как весь риг: Left = +X). */
function fingerBones(): HBone[] {
  const out: HBone[] = [];
  for (const side of ['Left', 'Right'] as const) {
    const sx = side === 'Left' ? 1 : -1;
    for (const [chain, base, lens] of FINGER_GEO) {
      for (let i = 0; i < 3; i++) {
        const nm = side + chain + FINGER_SEG[i];
        const parent = i === 0 ? side + 'Hand' : side + chain + FINGER_SEG[i - 1];
        const pos: [number, number, number] = i === 0 ? [base[0] * sx, base[1], base[2]] : [lens[i - 1]! * sx, 0, 0];
        out.push({ name: nm!, parent, pos, r: chain === 'Thumb' ? 0.62 : 0.55, finger: true });
      }
    }
  }
  return out;
}

/** Кость: имя, родитель (или null=корень), смещение сустава от родителя (лок.), радиус сегмент-меша, форма. */
interface HBone {
  name: string;
  parent: string | null;
  pos: [number, number, number];
  r: number;
  shape?: 'pelvis' | 'head' | 'hand' | 'foot' | 'toe' | 'breast';   // спец-формы; иначе цилиндр к первому ребёнку
  female?: boolean;   // только для gender:'female' (breast-кости — вторичные/jiggle, вне гуманоида Unity)
  noMesh?: boolean;   // служебный узел без геометрии (Root): не рисуем и не берём в рейкаст
  finger?: boolean;   // фаланга: строится только при opts.fingers (30 костей на каждого гуманоида — платим только где надо)
}

/** Таблица в порядке «родитель раньше ребёнка». T-поза: руки вдоль X, ноги вниз, спина вверх.
 *  Торс: Hips→Spine→Chest→UpperChest→Neck→Head (UpperChest — Unity-опция, лучше изгиб; плечи/шея/грудь на ней). */
const BONES: HBone[] = [
  // КОРЕНЬ ≠ ТАЗ (индустриальный стандарт: CC_Base_BoneRoot, UE `root`, Mixamo Armature). Root — позиция персонажа
  // на полу; таз висит под ним и может анимироваться отдельно (мах/скрутка/присед В МЕСТЕ), не сдвигая персонажа.
  // Раньше `human.root` БЫЛ тазом, поэтому любой авторский офсет таза уезжал бы вместе с персонажем.
  { name: 'Root', parent: null, pos: [0, 0, 0], r: 0, noMesh: true },
  { name: 'Hips', parent: 'Root', pos: [0, 32, 0], r: 5, shape: 'pelvis' },
  { name: 'Spine', parent: 'Hips', pos: [0, 5, 0], r: 4.6 },
  { name: 'Chest', parent: 'Spine', pos: [0, 6, 0], r: 5.4 },
  { name: 'UpperChest', parent: 'Chest', pos: [0, 5, 0], r: 5.2 },
  { name: 'Neck', parent: 'UpperChest', pos: [0, 5, 0], r: 2.2 },
  { name: 'Head', parent: 'Neck', pos: [0, 4, 0], r: 5, shape: 'head' },
  // Левая рука (Left = +X) — плечи на UpperChest
  { name: 'LeftShoulder', parent: 'UpperChest', pos: [3, 3, 0], r: 2.4 },
  { name: 'LeftUpperArm', parent: 'LeftShoulder', pos: [4, 0, 0], r: 2.6 },
  { name: 'LeftLowerArm', parent: 'LeftUpperArm', pos: [13, 0, 0], r: 2.2 },
  { name: 'LeftHand', parent: 'LeftLowerArm', pos: [11, 0, 0], r: 2.2, shape: 'hand' },
  // Правая рука (Right = −X)
  { name: 'RightShoulder', parent: 'UpperChest', pos: [-3, 3, 0], r: 2.4 },
  { name: 'RightUpperArm', parent: 'RightShoulder', pos: [-4, 0, 0], r: 2.6 },
  { name: 'RightLowerArm', parent: 'RightUpperArm', pos: [-13, 0, 0], r: 2.2 },
  { name: 'RightHand', parent: 'RightLowerArm', pos: [-11, 0, 0], r: 2.2, shape: 'hand' },
  // Левая нога
  { name: 'LeftUpperLeg', parent: 'Hips', pos: [4, -2, 0], r: 3.3 },
  { name: 'LeftLowerLeg', parent: 'LeftUpperLeg', pos: [0, -15, 0], r: 2.8 },
  { name: 'LeftFoot', parent: 'LeftLowerLeg', pos: [0, -14, 0], r: 2.4, shape: 'foot' },
  { name: 'LeftToes', parent: 'LeftFoot', pos: [0, -1, 6], r: 1.8, shape: 'toe' },
  // Правая нога
  { name: 'RightUpperLeg', parent: 'Hips', pos: [-4, -2, 0], r: 3.3 },
  { name: 'RightLowerLeg', parent: 'RightUpperLeg', pos: [0, -15, 0], r: 2.8 },
  { name: 'RightFoot', parent: 'RightLowerLeg', pos: [0, -14, 0], r: 2.4, shape: 'foot' },
  { name: 'RightToes', parent: 'RightFoot', pos: [0, -1, 6], r: 1.8, shape: 'toe' },
  // ПАЛЬЦЫ (Ф3.1) — имена Unity Humanoid, по 3 фаланги на палец. Строятся только при opts.fingers:
  // это +30 групп на КАЖДЫЙ гуманоид (манекен + призрак + 2 ониона + источник атласа), и в игре
  // они не нужны — там хват уже впечён в клип. От запястья: +X наружу, +Z вперёд (ладонь вниз).
  ...fingerBones(),
  // Грудь (только female) — ВТОРИЧНЫЕ кости (jiggle), вне humanoid Unity. На UpperChest, вперёд-вбок-вверх.
  { name: 'LeftBreast', parent: 'UpperChest', pos: [2.6, 1, 4], r: 3, shape: 'breast', female: true },
  { name: 'RightBreast', parent: 'UpperChest', pos: [-2.6, 1, 4], r: 3, shape: 'breast', female: true },
];

export interface Humanoid {
  root: THREE.Group;                       // КОРЕНЬ (Root, не таз!) — ставится в сцену; его позиция = позиция персонажа
  bones: Map<string, THREE.Group>;         // имя → пивот-группа сустава (крутить .rotation = FK)
  meshes: THREE.Mesh[];                    // сегмент-меши (для рейкаст-выбора; mesh.userData.bone = имя)
  /** Шары-суставы скелет-вида (подмножество `meshes`). Пусто у solid-стиля. См. `scaleJointsToScreen`. */
  joints: THREE.Mesh[];
  boneNames: string[];
  /** Снимок поз покоя (T-поза) — для «сброса». */
  restQuat: Map<string, THREE.Quaternion>;
  /** Прочитать текущую позу: имя → эйлер [x,y,z] (рад). */
  readPose(): Record<string, [number, number, number]>;
  /** Сбросить в T-позу (повороты всех костей + rest-позиции; Root не трогаем — там позиция персонажа). */
  reset(): void;
  /** Кость таза (сахар: `bones.get('Hips')!`). Root ≠ таз, см. таблицу BONES. */
  hips: THREE.Group;
  /** REST-позиция таза этого тела (`pelvisHeight` профиля). Точка отсчёта офсета таза в позе:
   *  клип хранит ДЕЛЬТУ от неё, поэтому «присед на 1.5 юнита» остаётся приседом на любом росте. */
  hipsRest: THREE.Vector3;
  /** Поставить ТАЗ в мировую точку, сдвигая Root (авторский офсет таза и масштаб корня учтены).
   *  Нужна везде, где раньше писали `root.position = <мировая позиция таза>`. */
  setHipsWorld(x: number, y: number, z: number): void;
  /** То же по одной оси Y (заземление). */
  setHipsWorldY(y: number): void;
  /** Мировая высота таза (обратная к setHipsWorldY). */
  hipsWorldY(): number;
  /** Приведение БЕДРА (рад, splay бедра hip→колено) и КОЛЕНА (legAdductKnee, splay голени колено→лодыжка) для компенсации
   *  A-стойки бинда ФБХ: нога splay-ит наружу посегментно, поза-система считает «поворот 0 = прямо вниз». Гейт/стойка
   *  доворачивают оба сустава → нога вертикальна В ЛЮБОМ сгибе (один hip-доворот не хватает при согнутом колене). 0 у процедурных. */
  legAdduct: number;
  legAdductKnee: number;
  /** Подъём стопы (юниты): смещение цели заземления/стойки вверх, чтобы ПОДОШВА МЕША (не кость-лодыжка) легла на пол.
   *  У атласа лодыжка выше процедурной (FOOT_Y=1.5) → без подъёма стопы меша тонут. Per-персонаж из pe_phys.footLift;
   *  читают measureStancePlants (standY) и footIk.groundFeet (цель = пол + SOLE + footLift) → редактор ≡ игра. 0 у процедурных. */
  footLift: number;
  /**
   * ⭐ ВЫСОТА КОСТИ-ЛОДЫЖКИ В ПОКОЕ — СОБСТВЕННОЕ ЧИСЛО РИГА, и единственное, по которому считается пол.
   *
   * Риг строится из офсетов модели И морфа, поэтому это число само едет за телосложением. Константа
   * `FOOT_Y = 1.5` (высота лодыжки процедурного манекена) плюс сохранённый `footLift` за морфом НЕ едут:
   * ЗАМЕР в живом редакторе — рост 1.16 поднял таз 35.05 → 40.66 и всю цепь ноги, лодыжка встала на
   * 3.355, а `FOOT_Y + footLift` остался 2.900. Разница 0.455 — персонаж уезжал в пол ровно на неё.
   */
  ankleRest: number | null;
  /**
   * ⭐ РАЗМЕРЫ НОГИ ЭТОГО РИГА (юниты, покой) — чтобы планировщик шагов ничего о теле не предполагал.
   *
   * `null` у процедурного рига: там свои давние константы (`L_THIGH/L_SHIN/HIP_DX`), и на них стоят
   * замеры походки. У рига из модели — измеренные значения, они же едут за телосложением.
   * ЗАМЕР на рыцаре (морф нейтральный): бедро 14.088 против зашитых 15, голень 14.421 против 13.5,
   * полутаз 3.867 против 3.6. Длина ноги при этом совпала (28.509 против 28.5) — расходится РАЗБИВКА.
   */
  legRest: { thigh: number; shin: number; hipHalfW: number; hipDropY: number } | null;
}

/**
 * МИРОВАЯ высота кости-лодыжки в покое = таз + вся цепь вниз.
 *
 * ⚠ `restPos` хранит ЛОКАЛЬНЫЕ офсеты (у стопы это −14.4 — длина голени, а не высота над полом).
 * Взять его напрямую — ровно та ошибка, на которой я один раз и попался: пол уехал бы на −14.
 */
/**
 * ГЕОМЕТРИЯ НОГИ ПО САМОМУ РИГУ (офсеты уже с моделью и морфом).
 *
 * ⚠ `hipDropY` — не мелочь. СУСТАВ БЕДРА НЕ СОВПАДАЕТ С НАЧАЛОМ ТАЗА: у рыцаря он на
 * **3.67 ниже**. Планировщик якорит ногу в тазе, и без этой поправки он просит ногу длиной 28.51
 * покрыть 32.16 (замер: ТАЗ 35.049 → ЛОДЫЖКА 2.892) — не достаёт **3.648**, и IK каждый кадр
 * упирается в предел вытяжения. Оттуда «половина ползунков перестала реагировать»: их вклад
 * съедал упор. У процедурного манекена `legRest` = `null` → поправка 0, поведение бит в бит прежнее.
 */
function legRestOf(restPos: Map<string, THREE.Vector3>): { thigh: number; shin: number; hipHalfW: number; hipDropY: number } | null {
  const up = restPos.get('LeftUpperLeg'), lo = restPos.get('LeftLowerLeg'), ft = restPos.get('LeftFoot');
  if (!up || !lo || !ft) return null;
  const thigh = lo.length(), shin = ft.length();
  if (!(thigh > 1e-3) || !(shin > 1e-3)) return null;
  return { thigh, shin, hipHalfW: Math.abs(up.x), hipDropY: up.y };
}

function ankleRestY(restPos: Map<string, THREE.Vector3>): number | null {
  const hips = restPos.get('Hips'); if (!hips) return null;
  let y = hips.y;
  for (const n of ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot']) {
    const o = restPos.get(n); if (!o) return null;
    y += o.y;
  }
  return y;
}
const UP = new THREE.Vector3(0, 1, 0);

/** Цилиндр-сегмент от (0,0,0) до `to` (лок.), радиус r. */
function segment(to: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const len = to.length();
  const geo = new THREE.CylinderGeometry(r, r * 0.85, len, 8);
  const m = new THREE.Mesh(geo, mat);
  // цилиндр по умолчанию вдоль Y — доворачиваем к направлению `to`, центр на середине.
  m.quaternion.setFromUnitVectors(UP, to.clone().normalize());
  m.position.copy(to).multiplyScalar(0.5);
  return m;
}

/** Октаэдр-«кость» от сустава (0,0,0) до первого ребёнка `to` (лок.) — классический ромб арматуры Blender:
 *  остриё-голова у сустава, широкое кольцо на ~15% длины, длинный конус к ребёнку. Показывает направление кости. */
/**
 * Полуширина октаэдра по длине кости (Ф13.2). Пол АБСОЛЮТНЫЙ (0.8) работал, пока самая короткая кость
 * тела была 4 юнита; на фаланге в 0.9 он давал почти кубик — палец переставал читаться как палец.
 * Пол сделан ОТНОСИТЕЛЬНЫМ: при `len >= 4` он равен прежним 0.8 (тело не меняется ни на пиксель),
 * ниже — сжимается вместе с костью.
 */
export const boneWidth = (len: number): number => Math.min(3, Math.max(Math.min(0.8, len * 0.2), len * 0.14));

/**
 * Ф13.1: мировой радиус, дающий на экране ровно `px` пикселей на расстоянии `dist` от перспективной камеры.
 * `2·dist·tan(fov/2)` — высота кадра в мировых единицах на этой дистанции; делим на высоту вьюпорта в пикселях.
 * Чистая функция (без THREE) — тестируется в node.
 */
export const screenRadiusToWorld = (dist: number, fovDeg: number, viewportH: number, px: number): number =>
  (px * 2 * dist * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportH);

const _jp = new THREE.Vector3(), _js = new THREE.Vector3();
/**
 * Держать шары-суставы ПОСТОЯННОГО ЭКРАННОГО РАЗМЕРА — как контроллеры в Blender/Cascadeur/Maya.
 * Иначе жёсткий минимум радиуса (1.6 юнита) делает шар КРУПНЕЕ фаланги (0.8–1.9 юнита), и кисть
 * превращается в ком, по которому ещё и не попасть мышью. При постоянном экранном размере подлёт к кисти
 * автоматически делает шары мелкими ОТНОСИТЕЛЬНО пальцев, а отлёт оставляет их кликабельными.
 *
 * `px` может быть функцией от имени кости — так режим правки хвата поднимает фаланги и приглушает остальное.
 * Звать ПОСЛЕ обновления камеры (у OrbitControls включён демпфинг: до `update()` шары отстают на кадр).
 */
export function scaleJointsToScreen(
  // Ф20.4: требуется только `joints` — так та же функция держит экранный размер и шарам
  // вида костей модели (`boneView`), который не `Humanoid`. `Humanoid` остаётся присваиваемым.
  h: { joints: THREE.Mesh[] }, cam: THREE.PerspectiveCamera, viewportH: number,
  px: number | ((bone: string) => number), minR = 0.12, maxR = 3.2,
): void {
  for (const j of h.joints) {
    j.getWorldPosition(_jp);
    const want = typeof px === 'function' ? px(j.userData.bone as string) : px;
    const r = Math.min(maxR, Math.max(minR, screenRadiusToWorld(_jp.distanceTo(cam.position), cam.fov, viewportH, want)));
    // Делим на масштаб РОДИТЕЛЯ: в редакторе он единичный, но у игровой куклы root масштабируется
    // (`gamePlayerDoll`), и без деления шары там разъехались бы вместе с ростом персонажа.
    const ps = j.parent ? (_js.setFromMatrixScale(j.parent.matrixWorld).x || 1) : 1;
    j.scale.setScalar(r / ps);
  }
}

function octaBone(to: THREE.Vector3, mat: THREE.Material): THREE.Mesh {
  const len = to.length(), w = boneWidth(len);
  const g = new THREE.OctahedronGeometry(1, 0);            // 6 вершин, 8 граней
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {                      // тянем вдоль +Y: голова→0, кольцо→0.15·len, хвост→len
    const vy = p.getY(i);
    const yy = vy > 0.5 ? len : vy < -0.5 ? 0 : len * 0.15;
    p.setXYZ(i, p.getX(i) * w, yy, p.getZ(i) * w);
  }
  p.needsUpdate = true; g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.quaternion.setFromUnitVectors(UP, to.clone().normalize());   // ось кости +Y → направление `to` (как segment)
  return m;
}

/**
 * Гранёная (low-poly) голова с ЛИЦОМ вперёд (+Z): икосаэдр (детализация 1 → 80 граней) деформируем в «яйцо»
 * и добавляем асимметрию перёд/зад — выдвинутый лоб/нос спереди + подобранный подбородок + округлый затылок.
 * Только двигаем вершины валидного меша (топология цела) → не ломается; flatShading материала даёт грани.
 * Асимметрия перёд/зад делает направление взгляда читаемым СВЕРХУ (камера игры), в отличие от сферы.
 */
function makeHeadGeometry(R: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(R, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const d = v.length() || 1, nz = v.z / d, ny = v.y / d;   // направление вершины
    v.x *= 0.88;                                             // уже по бокам
    v.y *= 1.06;                                             // чуть выше макушка
    if (nz > 0.2) v.z += R * 0.24 * (nz - 0.2);              // лицо/нос — вперёд (главный указатель направления)
    if (nz > 0.2 && ny < -0.15) v.y -= R * 0.12;            // подбородок подобран (лицо-клин)
    if (nz < -0.2) v.z *= 1.10;                              // затылок круглее/длиннее
    p.setXYZ(i, v.x, v.y, v.z);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

export interface BuildScale { arm?: number; leg?: number; torso?: number; head?: number }
export function buildHumanoid(opts: { limb?: number; body?: number; head?: number; gender?: 'male' | 'female'; build?: BuildScale; style?: 'solid' | 'skeleton'; profile?: BodyProfile; boneScale?: BoneScale; boneOffsets?: Record<string, number[]>; fingers?: boolean } = {}): Humanoid {
  const skel = opts.style === 'skeleton';
  const matLimb = new THREE.MeshStandardMaterial({ color: opts.limb ?? 0x8a93ad, roughness: 0.6, metalness: 0.15 });
  const matBody = new THREE.MeshStandardMaterial({ color: opts.body ?? 0x6f7690, roughness: 0.62, metalness: 0.2 });
  const matHead = new THREE.MeshStandardMaterial({ color: opts.head ?? 0xd8c0a0, roughness: 0.75, flatShading: true });   // грани головы ловят свет (low-poly)
  // Скелет-вид (арматура Blender/Unity): каждый меш — свой материал, чтобы highlight() подсвечивал ровно один сустав/кость.
  const boneMat = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: 0x9fb4d8, emissive: 0x24406e, roughness: 0.5, metalness: 0.1 });
  const jointMat = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: 0xffcf66, emissive: 0x6e4a10, roughness: 0.5, metalness: 0.1 });
  // Масштаб толщины по группам (для разных телосложений персонажей). 1 = как база. profile.girth множит всё (толстый/худой).
  const bd = opts.build ?? {};
  const prof = opts.profile;
  const gir = girthMult(prof);
  // Регион берём из ОБЩЕЙ boneRegion (bodyProfile.ts), а не угадываем по подстрокам: иначе каждая
  // новая кость тихо падает в «торс» (LeftThumbProximal не содержит ни 'Arm', ни 'Leg' → палец толстел бы с животом).
  const sc = (name: string): number => {
    switch (boneRegion(name)) {
      case 'arm': return (bd.arm ?? 1) * gir;
      case 'leg': return (bd.leg ?? 1) * gir;
      case 'head': return bd.head ?? 1;   // голову girth не раздуваем
      default: return (bd.torso ?? 1) * gir;   // Spine/Chest/UpperChest/Hips/Breast
    }
  };
  // ДЛИНА/НАПРАВЛЕНИЕ звеньев. boneOffsets (ВЕКТОР rest-офсета из ФБХ) — приоритет: наш скелет ПОВТОРЯЕТ геометрию
  // модели 1:1 (направление+длина; чинит «раскоряку» — узкий-вниз хип ФБХ, а не широкий как у boneScale-скаляра).
  // Нет офсета кости → фолбэк base × boneScale-скаляр. Профиль (lenMult) — морф поверх. Таз — высота (заземление).
  const bsc = opts.boneScale, bo = opts.boneOffsets;
  // Ф15.2: ЗАМЕРЕННЫЙ офсет берётся КАК ЕСТЬ. Раньше у осевой цепи (спина→шея→голова) обнулялся forward-Z,
  // чтобы CC-бинд с наклоном головы не читался как горб — но обнуление РЕЖЕТ ДЛИНУ: (0, 4.63, 2.4) длиной
  // 5.21 превращалось в 4.63, минус 11%, и конформ переносил это укорочение на саму модель.
  // Скелет обязан совпадать с мешем; если у модели голова вперёд — рисуем вперёд.
  // (В хардкод-таблице у этих костей Z и так 0, так что для процедурного персонажа ничего не менялось.)
  const posOf = (b: HBone): [number, number, number] => {
    const off = bo?.[b.name];
    if (b.name === 'Hips') { const hy = off ? (off[1] ?? 0) * (prof?.leg ?? 1) * (prof?.height ?? 1) : pelvisHeight(prof, bsc); return [b.pos[0], hy, b.pos[2]]; }
    const region = lenMult(b.name, prof);
    if (off) return [(off[0] ?? 0) * region, (off[1] ?? 0) * region, (off[2] ?? 0) * region];   // ФБХ-офсет × профиль-морф
    const m = region * boneScaleOf(b.name, bsc);
    return [b.pos[0] * m, b.pos[1] * m, b.pos[2] * m];
  };

  // Female-кости (грудь) — только для gender:'female'. Иначе гуманоид без них (обязательный набор Unity).
  const table = BONES.filter((b) => (!b.female || opts.gender === 'female') && (!b.finger || opts.fingers === true));

  const bones = new Map<string, THREE.Group>();
  const meshes: THREE.Mesh[] = [];
  const joints: THREE.Mesh[] = [];   // только шары-суставы скелет-вида (Ф13.1: пересчёт экранного размера)
  const childrenOf = new Map<string, HBone[]>();
  for (const b of table) { if (b.parent) (childrenOf.get(b.parent) ?? childrenOf.set(b.parent, []).get(b.parent)!).push(b); }

  let root!: THREE.Group;
  for (const b of table) {
    const g = new THREE.Group();
    g.name = b.name;
    { const p = posOf(b); g.position.set(p[0], p[1], p[2]); }   // длина по profile (офсет × lenMult; таз — pelvisHeight)
    if (b.parent) bones.get(b.parent)!.add(g); else root = g;
    bones.set(b.name, g);

    if (b.noMesh) continue;   // служебный узел (Root): без геометрии и без рейкаста
    // Сегмент-меш кости: спец-форма или цилиндр к ПЕРВОМУ ребёнку (визуально «кость до сустава-ребёнка»).
    const s = sc(b.name);   // масштаб толщины группы
    if (skel) {   // СКЕЛЕТ-вид: шар-сустав (клик-цель) + октаэдр-кость к первому ребёнку (направление). Игнорируем спец-формы.
      // Шар строится ЕДИНИЧНЫМ, а радиус задаётся масштабом (Ф13.1) — тогда его можно пересчитывать
      // покадрово под экранный размер, не трогая геометрию. Без пересчёта scale = прежняя формула,
      // то есть вид ровно как раньше. Геометрия НЕ общая: `applyChar`/`rebuildManikin`/`disposeOnion`
      // делают сплошной `traverse(o => o.geometry.dispose())`, и общая сфера умерла бы на первой смене.
      const jr = Math.min(3.2, Math.max(1.6, b.r * s * 0.5));
      const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), jointMat());
      ball.scale.setScalar(jr);
      ball.userData.bone = b.name; ball.userData.joint = true; ball.userData.jr = jr;
      g.add(ball); meshes.push(ball); joints.push(ball);
      // КОСТЬ РИСУЕТСЯ К КАЖДОМУ РЕБЁНКУ, а не только к первому (Ф19) — как в Blender/Maya.
      // Именно из-за `kids[0]` у кисти рисовалась РОВНО ОДНА пястная кость — к большому пальцу
      // (он первый в `FINGER_GEO`), а четыре остальные ладонь не показывала вообще: пальцы казались
      // висящими в воздухе. Отдельных КОСТЕЙ-пястей в риге нет и быть не может (ни у Unity Humanoid,
      // ни у CC/AccuRIG их нет, драйвить нечем) — но СЕГМЕНТ запястье→костяшка задан офсетом
      // фаланги и рисуется бесплатно. Клик по нему выбирает КИСТЬ — то, что и крутит этот сегмент.
      // Попутно чинится таз (была только спина, теперь ещё два бедра) и грудь (шея + две ключицы).
      for (const c of childrenOf.get(b.name) ?? []) {
        const bone = octaBone(new THREE.Vector3(...posOf(c)), boneMat());
        bone.userData.bone = b.name; g.add(bone); meshes.push(bone);
      }
      if (b.shape === 'head') {   // нуб-указатель взгляда (в +Z) — направление головы читается
        const nub = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 4), boneMat());
        nub.position.set(0, 0, b.r * s * 0.6); nub.userData.bone = b.name; g.add(nub); meshes.push(nub);
      }
      continue;
    }
    let mesh: THREE.Mesh | null = null;
    if (b.shape === 'pelvis') { mesh = new THREE.Mesh(new THREE.BoxGeometry(9 * s, 5, 5 * s), matBody); mesh.position.y = -1; }
    else if (b.shape === 'head') { mesh = new THREE.Mesh(makeHeadGeometry(b.r * s), matHead); mesh.position.y = b.r * 0.7; }
    else if (b.shape === 'hand') { mesh = new THREE.Mesh(new THREE.BoxGeometry(3.6 * s, 2.2 * s, 5), matLimb); mesh.position.set(Math.sign(b.pos[0]) * 2.5, 0, 0); }
    else if (b.shape === 'foot') { mesh = new THREE.Mesh(new THREE.BoxGeometry(5 * s, 3, 11), matLimb); mesh.position.set(0, -1.5, 3); }
    else if (b.shape === 'toe') { mesh = new THREE.Mesh(new THREE.BoxGeometry(5 * s, 2.4, 4), matLimb); mesh.position.set(0, -0.6, 2); }
    else if (b.shape === 'breast') { mesh = new THREE.Mesh(new THREE.SphereGeometry(b.r * s, 12, 10), matBody); mesh.position.set(0, 0, b.r * 0.4); mesh.scale.set(0.9, 0.9, 1.1); }
    else {
      const kids = childrenOf.get(b.name);
      if (kids && kids.length) {
        const c = kids[0]!;   // первый ребёнок задаёт направление сегмента
        const mat = (b.name === 'Spine' || b.name === 'Chest') ? matBody : matLimb;
        mesh = segment(new THREE.Vector3(...posOf(c)), b.r * s, mat);
      }
    }
    if (mesh) { mesh.userData.bone = b.name; g.add(mesh); meshes.push(mesh); }
  }

  const restQuat = new Map<string, THREE.Quaternion>();
  const restPos = new Map<string, THREE.Vector3>();
  for (const [nm, g] of bones) { restQuat.set(nm, g.quaternion.clone()); restPos.set(nm, g.position.clone()); }

  // Углы приведения ПОСЕГМЕНТНО: бедро = наклон бедра (hip→колено) от вертикали, колено = наклон голени (колено→лодыжка).
  // ФБХ A-стойка splay-ит оба звена (~10°/7°); один hip-доворот верно верт-т ТОЛЬКО прямую ногу, при сгибе колена звенья
  // расходятся → нужен доворот и колена. Компенсируем каждое в СВОЁМ суставе (см. applyLegAdduct). 0 если нет boneOffsets.
  let legAdduct = 0, legAdductKnee = 0;
  if (bo) {
    const ll = bo['LeftLowerLeg'], lf = bo['LeftFoot'];
    if (ll) { const y = -(ll[1] ?? 0); if (y > 1e-3) legAdduct = Math.atan2(ll[0] ?? 0, y); }        // splay бедра (hip→колено)
    if (lf) { const y = -(lf[1] ?? 0); if (y > 1e-3) legAdductKnee = Math.atan2(lf[0] ?? 0, y); }     // splay голени (колено→лодыжка)
  }
  // Приведение РУК НЕ компенсируем в рантайме: модели биндятся в T-позе (руки горизонт, как ожидают клипы). A-позный бинд
  // недопустим — 46° доворота от бинда скин не тянет чисто (корёжит). Требование: экспортить скелет в T-позе (см. README ретаргета).

  const hips = bones.get('Hips')!;
  return {
    root, bones, meshes, joints, boneNames: table.map((b) => b.name), restQuat, legAdduct, legAdductKnee, footLift: 0, hips,
    hipsRest: restPos.get('Hips')!.clone(),
    // ⚠ СОБСТВЕННАЯ ВЫСОТА — ТОЛЬКО У РИГА ИЗ МОДЕЛИ. Там подошва модели стоит на нуле по построению
    // (высота таза замерена от рут-кости), поэтому мировая высота кости-лодыжки И ЕСТЬ искомый пол.
    // У процедурного рига своя давняя конвенция `FOOT_Y = 1.5` (его собственный рест — 1.0, меш стопы
    // свисает ниже кости), и её тут менять нельзя: на ней стоят замеры походки. Поэтому фолбэк.
    ankleRest: opts.boneOffsets ? ankleRestY(restPos) : null,
    legRest: opts.boneOffsets ? legRestOf(restPos) : null,
    readPose() {
      const out: Record<string, [number, number, number]> = {};
      for (const [nm, g] of bones) { const e = g.rotation; out[nm] = [+e.x.toFixed(3), +e.y.toFixed(3), +e.z.toFixed(3)]; }
      return out;
    },
    // Позиции ТОЖЕ возвращаем в rest — иначе после клипа/бега авторская высота таза оставалась от предыдущей позы
    // (клип без __hipsP наследовал чужой таз). Root пропускаем: там позиция персонажа, её сбрасывать нельзя.
    reset() {
      for (const [nm, g] of bones) {
        g.quaternion.copy(restQuat.get(nm)!);
        if (nm !== 'Root') g.position.copy(restPos.get(nm)!);
      }
    },
    setHipsWorld(x: number, y: number, z: number): void {
      const k = root.scale;   // Root без поворота → достаточно вычесть офсет таза с учётом масштаба корня
      root.position.set(x - hips.position.x * k.x, y - hips.position.y * k.y, z - hips.position.z * k.z);
    },
    setHipsWorldY(y: number): void { root.position.y = y - hips.position.y * root.scale.y; },
    hipsWorldY(): number { return root.position.y + hips.position.y * root.scale.y; },
  };
}
