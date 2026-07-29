/**
 * ГУМАНОИД-СКЕЛЕТ (аналог общего гуманоида Unity, ~21 кость) в T-позе — фундамент pose-editor'а и будущего
 * ретаргета зариганых glTF-моделей. Кинематический: иерархия пивот-групп (крутим `.rotation` сустава = FK).
 * Конвенция как у Mixamo/Unity: лицом +Z, вверх +Y, **Left = +X** (правильный L/R, БЕЗ зеркала рэгдолла).
 * Масштаб: TILE=32u=1 м, рост ~1.9 м. Имена костей — Unity (`LeftUpperArm` и т.д.) для карты ретаргета.
 */
import * as THREE from 'three';

/** Кость: имя, родитель (или null=корень), смещение сустава от родителя (лок.), радиус сегмент-меша, форма. */
interface HBone {
  name: string;
  parent: string | null;
  pos: [number, number, number];
  r: number;
  shape?: 'pelvis' | 'head' | 'hand' | 'foot' | 'toe' | 'breast';   // спец-формы; иначе цилиндр к первому ребёнку
  female?: boolean;   // только для gender:'female' (breast-кости — вторичные/jiggle, вне гуманоида Unity)
}

/** Таблица в порядке «родитель раньше ребёнка». T-поза: руки вдоль X, ноги вниз, спина вверх.
 *  Торс: Hips→Spine→Chest→UpperChest→Neck→Head (UpperChest — Unity-опция, лучше изгиб; плечи/шея/грудь на ней). */
const BONES: HBone[] = [
  { name: 'Hips', parent: null, pos: [0, 32, 0], r: 5, shape: 'pelvis' },
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
  // Грудь (только female) — ВТОРИЧНЫЕ кости (jiggle), вне humanoid Unity. На UpperChest, вперёд-вбок-вверх.
  { name: 'LeftBreast', parent: 'UpperChest', pos: [2.6, 1, 4], r: 3, shape: 'breast', female: true },
  { name: 'RightBreast', parent: 'UpperChest', pos: [-2.6, 1, 4], r: 3, shape: 'breast', female: true },
];

export interface Humanoid {
  root: THREE.Group;                       // корень (Hips) — ставится в сцену
  bones: Map<string, THREE.Group>;         // имя → пивот-группа сустава (крутить .rotation = FK)
  meshes: THREE.Mesh[];                    // сегмент-меши (для рейкаст-выбора; mesh.userData.bone = имя)
  boneNames: string[];
  /** Снимок поз покоя (T-поза) — для «сброса». */
  restQuat: Map<string, THREE.Quaternion>;
  /** Прочитать текущую позу: имя → эйлер [x,y,z] (рад). */
  readPose(): Record<string, [number, number, number]>;
  /** Сбросить в T-позу. */
  reset(): void;
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

export interface BuildScale { arm?: number; leg?: number; torso?: number; head?: number }
export function buildHumanoid(opts: { limb?: number; body?: number; head?: number; gender?: 'male' | 'female'; build?: BuildScale } = {}): Humanoid {
  const matLimb = new THREE.MeshStandardMaterial({ color: opts.limb ?? 0x8a93ad, roughness: 0.6, metalness: 0.15 });
  const matBody = new THREE.MeshStandardMaterial({ color: opts.body ?? 0x6f7690, roughness: 0.62, metalness: 0.2 });
  const matHead = new THREE.MeshStandardMaterial({ color: opts.head ?? 0xd8c0a0, roughness: 0.75 });
  // Масштаб толщины по группам (для разных телосложений персонажей). 1 = как база.
  const bd = opts.build ?? {};
  const sc = (name: string): number => {
    if (name.includes('Arm') || name === 'LeftHand' || name === 'RightHand' || name.includes('Shoulder')) return bd.arm ?? 1;
    if (name.includes('Leg') || name.includes('Foot') || name.includes('Toes')) return bd.leg ?? 1;
    if (name === 'Head' || name === 'Neck') return bd.head ?? 1;
    return bd.torso ?? 1;   // Spine/Chest/UpperChest/Hips/Breast
  };

  // Female-кости (грудь) — только для gender:'female'. Иначе гуманоид без них (обязательный набор Unity).
  const table = BONES.filter((b) => !b.female || opts.gender === 'female');

  const bones = new Map<string, THREE.Group>();
  const meshes: THREE.Mesh[] = [];
  const childrenOf = new Map<string, HBone[]>();
  for (const b of table) { if (b.parent) (childrenOf.get(b.parent) ?? childrenOf.set(b.parent, []).get(b.parent)!).push(b); }

  let root!: THREE.Group;
  for (const b of table) {
    const g = new THREE.Group();
    g.name = b.name;
    g.position.set(b.pos[0], b.pos[1], b.pos[2]);
    if (b.parent) bones.get(b.parent)!.add(g); else root = g;
    bones.set(b.name, g);

    // Сегмент-меш кости: спец-форма или цилиндр к ПЕРВОМУ ребёнку (визуально «кость до сустава-ребёнка»).
    const s = sc(b.name);   // масштаб толщины группы
    let mesh: THREE.Mesh | null = null;
    if (b.shape === 'pelvis') { mesh = new THREE.Mesh(new THREE.BoxGeometry(9 * s, 5, 5 * s), matBody); mesh.position.y = -1; }
    else if (b.shape === 'head') { mesh = new THREE.Mesh(new THREE.SphereGeometry(b.r * s, 16, 14), matHead); mesh.position.y = b.r * 0.7; }
    else if (b.shape === 'hand') { mesh = new THREE.Mesh(new THREE.BoxGeometry(3.6 * s, 2.2 * s, 5), matLimb); mesh.position.set(Math.sign(b.pos[0]) * 2.5, 0, 0); }
    else if (b.shape === 'foot') { mesh = new THREE.Mesh(new THREE.BoxGeometry(5 * s, 3, 11), matLimb); mesh.position.set(0, -1.5, 3); }
    else if (b.shape === 'toe') { mesh = new THREE.Mesh(new THREE.BoxGeometry(5 * s, 2.4, 4), matLimb); mesh.position.set(0, -0.6, 2); }
    else if (b.shape === 'breast') { mesh = new THREE.Mesh(new THREE.SphereGeometry(b.r * s, 12, 10), matBody); mesh.position.set(0, 0, b.r * 0.4); mesh.scale.set(0.9, 0.9, 1.1); }
    else {
      const kids = childrenOf.get(b.name);
      if (kids && kids.length) {
        const c = kids[0]!;   // первый ребёнок задаёт направление сегмента
        const mat = (b.name === 'Spine' || b.name === 'Chest') ? matBody : matLimb;
        mesh = segment(new THREE.Vector3(c.pos[0], c.pos[1], c.pos[2]), b.r * s, mat);
      }
    }
    if (mesh) { mesh.userData.bone = b.name; g.add(mesh); meshes.push(mesh); }
  }

  const restQuat = new Map<string, THREE.Quaternion>();
  for (const [nm, g] of bones) restQuat.set(nm, g.quaternion.clone());

  return {
    root, bones, meshes, boneNames: table.map((b) => b.name), restQuat,
    readPose() {
      const out: Record<string, [number, number, number]> = {};
      for (const [nm, g] of bones) { const e = g.rotation; out[nm] = [+e.x.toFixed(3), +e.y.toFixed(3), +e.z.toFixed(3)]; }
      return out;
    },
    reset() { for (const [nm, g] of bones) g.quaternion.copy(restQuat.get(nm)!); },
  };
}
