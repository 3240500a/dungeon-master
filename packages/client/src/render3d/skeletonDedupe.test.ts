import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { dedupeSkeletons } from './skeletonDedupe.js';

/** Скелет из трёх костей вдоль +X. `suffix` имитирует копию из конвертера (`..._7`). */
function makeSkeleton(suffix = ''): { bones: THREE.Bone[]; root: THREE.Bone } {
  const names = ['Hips', 'Spine', 'Head'];
  const bones = names.map((n, i) => { const b = new THREE.Bone(); b.name = n + suffix; b.position.set(i ? 10 : 0, 0, 0); return b; });
  bones[0]!.add(bones[1]!); bones[1]!.add(bones[2]!);
  return { bones, root: bones[0]! };
}
/** Копия скелета ТАК ЖЕ, КАК В ФАЙЛЕ: каждая кость-двойник — ребёнок своего оригинала (`Spine → Spine_1 → Spine_2`),
 *  локальная трансформация тождественная. Поэтому копии повторяют движение канона — и схлопывание эквивалентно. */
function addCopy(src: THREE.Bone[], suffix: string): THREE.Bone[] {
  return src.map((b) => { const c = new THREE.Bone(); c.name = b.name.replace(/_\d+$/, '') + suffix; b.add(c); return c; });
}
/** Меш со скином (как приходит из конвертера: у каждого меша свой Skeleton). */
function makeSkinned(name: string, bones: THREE.Bone[], skel?: THREE.Skeleton): THREE.SkinnedMesh {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0], 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
  m.name = name;
  m.bind(skel ?? new THREE.Skeleton(bones));
  return m;
}
/** Мировые позиции вершин с учётом скиннинга — эталон «картинка не изменилась». */
function skinnedPoints(m: THREE.SkinnedMesh): number[] {
  m.updateMatrixWorld(true);
  const pos = m.geometry.getAttribute('position');
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i); m.applyBoneTransform(i, v); v.applyMatrix4(m.matrixWorld);
    out.push(+v.x.toFixed(5), +v.y.toFixed(5), +v.z.toFixed(5));
  }
  return out;
}

describe('skeletonDedupe — копии скелета схлопываются в один', () => {
  it('38 копий → 1 скелет, кости дублей удалены, меши пере-привязаны', () => {
    const root = new THREE.Group();
    const canon = makeSkeleton();
    root.add(canon.root);
    const meshes = [makeSkinned('m0', canon.bones)];
    root.add(meshes[0]!);
    let prev = canon.bones;
    for (let i = 1; i < 38; i++) {                       // копии нанизаны ПО-КОСТНО, как в файле
      prev = addCopy(prev, '_' + i);
      const m = makeSkinned('m' + i, prev); root.add(m); meshes.push(m);
    }
    const r = dedupeSkeletons(root);
    expect(r.skins).toBe(38);
    expect(r.rebound).toBe(37);
    expect(r.bonesBefore).toBe(38 * 3);
    expect(r.bonesAfter).toBe(3);                        // ← остался ОДИН скелет
    for (const m of meshes) expect(m.skeleton.bones).toEqual(canon.bones);   // общий скелет на всех
  });

  it('КАРТИНКА НЕ МЕНЯЕТСЯ: скиннинг до и после совпадает, в бинде и в позе', () => {
    const build = (): { root: THREE.Group; meshes: THREE.SkinnedMesh[]; canon: THREE.Bone[] } => {
      const root = new THREE.Group();
      const canon = makeSkeleton(); root.add(canon.root);
      const meshes = [makeSkinned('m0', canon.bones)]; root.add(meshes[0]!);
      let prev = canon.bones;
      for (let i = 1; i < 4; i++) {
        prev = addCopy(prev, '_' + i);
        const m = makeSkinned('m' + i, prev); root.add(m); meshes.push(m);
      }
      return { root, meshes, canon: canon.bones };
    };
    for (const pose of [false, true]) {
      const a = build(), b = build();
      if (pose) {   // одна и та же поза на канон-скелете обоих
        for (const s of [a, b]) s.canon[1]!.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
      }
      a.root.updateMatrixWorld(true); b.root.updateMatrixWorld(true);
      const before = a.meshes.map(skinnedPoints);
      dedupeSkeletons(b.root);
      const after = b.meshes.map(skinnedPoints);
      expect(after, pose ? 'в позе' : 'в бинде').toEqual(before);
    }
  });

  it('модель с ОДНИМ скелетом не трогается', () => {
    const root = new THREE.Group();
    const canon = makeSkeleton(); root.add(canon.root);
    const shared = new THREE.Skeleton(canon.bones);      // один скин на оба меша — как в правильно выгнанной модели
    const m1 = makeSkinned('a', canon.bones, shared), m2 = makeSkinned('b', canon.bones, shared);
    root.add(m1, m2);
    const r = dedupeSkeletons(root);
    expect(r.skins).toBe(1);
    expect(r.rebound).toBe(0);
    expect(r.bonesAfter).toBe(r.bonesBefore);
  });

  it('ЧУЖОЙ скелет (не копия) не схлопывается — имена не сходятся', () => {
    const root = new THREE.Group();
    const canon = makeSkeleton(); root.add(canon.root);
    root.add(makeSkinned('m0', canon.bones));
    const other = { bones: ['Root2', 'Mid2'].map((n, i) => { const b = new THREE.Bone(); b.name = n; b.position.set(i ? 5 : 0, 0, 0); return b; }) };
    other.bones[0]!.add(other.bones[1]!);
    root.add(other.bones[0]!);
    root.add(makeSkinned('m1', other.bones));
    const r = dedupeSkeletons(root);
    expect(r.rebound).toBe(0);
    expect(r.bonesAfter).toBe(5);                        // 3 канона + 2 чужих остались
  });

  it('поддерево с МЕШЕМ внутри костей не удаляется', () => {
    const root = new THREE.Group();
    const canon = makeSkeleton(); root.add(canon.root);
    root.add(makeSkinned('m0', canon.bones));
    const dup = addCopy(canon.bones, '_1');
    root.add(makeSkinned('m1', dup));
    dup[2]!.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()));   // навесное на кости
    const r = dedupeSkeletons(root);
    expect(r.rebound).toBe(1);                           // меш пере-привязан
    expect(r.removed).not.toContain('Head_1');           // ветку с навесным объектом не сняли
  });
});
