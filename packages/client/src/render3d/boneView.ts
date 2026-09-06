/**
 * СКЕЛЕТ, НАРИСОВАННЫЙ ПО НАСТОЯЩИМ КОСТЯМ МОДЕЛИ (Ф20.3).
 *
 * Редактор рисовал ПРОЦЕДУРНЫЙ скелет (`buildHumanoid({style:'skeleton'})`), а меш деформируют другие
 * кости — настоящие кости внутри GLB. Замерено на knight_05: манекен расходился с ними на 0.86–2.72u,
 * то есть крутишь одно, а двигается другое. Так делает только наш редактор: Unity в настройке аватара
 * рисует кости модели сквозь меш, UE5 IK Retargeter держит во вьюпорте оба скелета и правит реальные
 * кости, MotionBuilder кладёт эффекторы контрол-рига поверх скелета персонажа, в Blender контрол- и
 * деформ-кости живут в ОДНОЙ арматуре. Приблизительный скелет рядом с настоящим не рисует никто.
 *
 * Вид — ПЛОСКАЯ группа в мировых координатах (без иерархии): каждый меш сам ставится по мировым
 * трансформам своей кости. Иерархию строить не надо и вредно — у модели между нашими костями сидят
 * промежуточные узлы (`Waist`, твист-кости), и повторять её пришлось бы точно, а нам нужна ровно наша
 * канон-топология.
 *
 * Ключи `userData` — ТЕ ЖЕ, что у манекена (`humanoid.ts`): `bone` (каноническое имя), `joint`, `jr`.
 * Поэтому выбор, подсветка, список костей и экранный размер шаров (`scaleJointsToScreen`) работают без
 * единой правки — им всё равно, чей это меш.
 */
import * as THREE from 'three';
import { boneWidth } from './humanoid.js';

/** Откуда вид берёт кости. Реализуется редактором поверх `modelsTab`/ретаргета. */
export interface BoneSource {
  /** Канонические имена в порядке родитель→ребёнок. */
  names: readonly string[];
  /** Канонический родитель (НАШ, не из иерархии модели). */
  parentOf(our: string): string | null;
  /** Настоящая кость модели по нашему имени, либо `null` — у модели её нет. */
  boneOf(our: string): THREE.Object3D | null;
}

export interface BoneView {
  group: THREE.Group;
  /** Все меши — набор для рейкаста (тот же контракт, что `Humanoid.meshes`). */
  meshes: THREE.Mesh[];
  /** Только шары-суставы — для `scaleJointsToScreen`. */
  joints: THREE.Mesh[];
  /** Имена, для которых у модели ЕСТЬ кость (что нарисовано). */
  mapped: string[];
  /** Пересобрать под текущий набор костей. Дёшево: зовётся на смене атласа, не покадрово. */
  rebuild(src: BoneSource): void;
  /** Обновить положение из настоящих костей. Звать ПОСЛЕ того, как модель отведена (`drive`). */
  update(src: BoneSource): void;
  dispose(): void;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * ЕДИНИЧНЫЙ октаэдр-кость: голова в 0, кольцо на 0.15, хвост на 1, полуширина 1 — ровно профиль
 * `humanoid.octaBone`, но не запечённый в длину. Длина/толщина задаются масштабом каждый кадр, потому
 * что у модели они меняются (конформ, морф), а пересобирать геометрию покадрово незачем.
 */
function unitOcta(): THREE.BufferGeometry {
  const g = new THREE.OctahedronGeometry(1, 0);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const vy = p.getY(i);
    p.setXYZ(i, p.getX(i), vy > 0.5 ? 1 : vy < -0.5 ? 0 : 0.15, p.getZ(i));
  }
  p.needsUpdate = true; g.computeVertexNormals();
  return g;
}

/** Ближайший предок, который ЕСТЬ у модели. Промежуточные несмапленные кости пропускаются, чтобы в
 *  цепи не появлялись дыры: у CC/AccuRIG нет `UpperChest`, и шея повисла бы в воздухе. */
export function mappedParent(src: BoneSource, our: string): string | null {
  let p = src.parentOf(our);
  while (p && !src.boneOf(p)) p = src.parentOf(p);
  return p;
}

export function makeBoneView(): BoneView {
  const group = new THREE.Group();
  group.name = 'boneView';
  const octa = unitOcta();                                  // общая геометрия — НЕ трогать в dispose
  const ball = new THREE.SphereGeometry(1, 12, 10);
  const meshes: THREE.Mesh[] = [], joints: THREE.Mesh[] = [];
  const mapped: string[] = [];
  /** меш кости → [родитель, ребёнок] в наших именах */
  const segs: { m: THREE.Mesh; from: string; to: string }[] = [];
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();

  const clear = (): void => {
    for (const m of meshes) (m.material as THREE.Material).dispose();
    group.clear();
    meshes.length = 0; joints.length = 0; segs.length = 0; mapped.length = 0;
  };

  return {
    group, meshes, joints, mapped,

    rebuild(src) {
      clear();
      for (const nm of src.names) {
        if (!src.boneOf(nm)) continue;                      // нет кости у модели — не рисуем (она и меш не двигает)
        mapped.push(nm);
        // Скелет-вид: свой материал на каждый меш — `highlight()` красит `emissive` ОДНОГО меша,
        // с общим материалом подсветился бы весь скелет.
        const j = new THREE.Mesh(ball, new THREE.MeshStandardMaterial({ color: 0xffcf66, emissive: 0x6e4a10, roughness: 0.5, metalness: 0.1 }));
        j.userData.bone = nm; j.userData.joint = true; j.userData.jr = 1;
        group.add(j); meshes.push(j); joints.push(j);

        const p = mappedParent(src, nm);
        if (!p) continue;
        // Кость принадлежит РОДИТЕЛЮ и смотрит на ребёнка — та же семантика, что у манекена,
        // поэтому клик по плечевой кости выбирает `LeftUpperArm`, а не `LeftLowerArm`.
        const m = new THREE.Mesh(octa, new THREE.MeshStandardMaterial({ color: 0x9fb4d8, emissive: 0x24406e, roughness: 0.5, metalness: 0.1 }));
        m.userData.bone = p;
        group.add(m); meshes.push(m); segs.push({ m, from: p, to: nm });
      }
    },

    update(src) {
      for (const j of joints) {
        const b = src.boneOf(j.userData.bone as string);
        if (!b) { j.visible = false; continue; }
        j.visible = true; b.getWorldPosition(_a); j.position.copy(_a);
        // scale НЕ трогаем — им владеет `scaleJointsToScreen` (постоянный экранный размер).
      }
      for (const s of segs) {
        const pb = src.boneOf(s.from), cb = src.boneOf(s.to);
        if (!pb || !cb) { s.m.visible = false; continue; }
        pb.getWorldPosition(_a); cb.getWorldPosition(_b);
        _d.copy(_b).sub(_a);
        const len = _d.length();
        if (len < 1e-6) { s.m.visible = false; continue; }
        s.m.visible = true;
        s.m.position.copy(_a);
        s.m.quaternion.setFromUnitVectors(UP, _d.divideScalar(len));
        const w = boneWidth(len);
        s.m.scale.set(w, len, w);
      }
      group.updateMatrixWorld(true);
    },

    dispose() { clear(); octa.dispose(); ball.dispose(); },
  };
}
