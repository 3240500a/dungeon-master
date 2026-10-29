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

  it('⭐ СЛУЖЕБНЫЙ КОРЕНЬ СКЕЛЕТА НЕ УНОСИТ ВСЮ АРМАТУРУ', () => {
    // Ровно эта форма пришла из AccuRIG/CC: верхний узел `RL_BoneRoot` — КОСТЬ, но в суставы скина
    // НЕ входит. Решение о сносе принималось по одному корню поддерева («сам не нужен, внутри одни
    // кости»), и снос уносил ВСЮ арматуру вместе с канон-копией: на knight_05.fbx 3801 кость → 0,
    // все 3800 повисли ВНЕ дерева. Дальше меш вёл скелет, которого нет в сцене, а экспорт писал
    // суставы, которых нет в файле, — и GLB не грузился ничем.
    const root = new THREE.Group();
    const armature = new THREE.Bone(); armature.name = 'RL_BoneRoot';   // кость, но НЕ сустав скина
    root.add(armature);
    const canon = makeSkeleton();
    armature.add(canon.root);                                          // вся арматура — под служебным корнем
    const copies = [addCopy(canon.bones, '_1'), addCopy(canon.bones, '_2')];
    const meshes = [makeSkinned('body', canon.bones), makeSkinned('helm', copies[0]!), makeSkinned('legs', copies[1]!)];
    for (const m of meshes) root.add(m);
    root.updateMatrixWorld(true);

    const rep = dedupeSkeletons(root);
    const inTree = new Set<THREE.Object3D>(); root.traverse((o) => inTree.add(o));
    expect(rep.skins, 'копий было три').toBe(3);
    expect(inTree.has(armature), 'служебный корень остался — под ним живые кости').toBe(true);
    for (const b of canon.bones) expect(inTree.has(b), `кость ${b.name} обязана остаться в дереве`).toBe(true);
    for (const m of meshes) for (const b of m.skeleton.bones) {
      expect(inTree.has(b), `⚠ ${m.name}: кость ${b.name} ведёт меш, но выпала из дерева`).toBe(true);
    }
    expect(rep.bonesAfter, 'дубли ушли, канон и его корень целы').toBe(canon.bones.length + 1);
  });

  it('⭐ ЧАСТИЧНЫЕ СКИНЫ (форма из макса): у каждого меша СВОЙ набор костей', () => {
    // knight_05 приехал из AccuRIG полными копиями скелета. Тот же файл, открытый в максе и
    // пересохранённый, приезжает иначе: 38 скинов по 6…36 костей — каждый меш скинится ТОЛЬКО на
    // нужные ему кости. Прежний алгоритм назначал каноном ОДИН скин и требовал, чтобы остальные
    // целиком в него влезли; скин из шести костей не мог принять меш из тридцати шести, поэтому не
    // схлопывалось НИЧЕГО (замер: 584 кости, 38 скелетов), меш ехал на случайной копии и разлетался.
    const root = new THREE.Group();
    const canon = makeSkeleton();
    root.add(canon.root);
    const copy = addCopy(canon.bones, '_1');
    // Меш А сидит на ВЕРХНИХ двух костях канона, меш Б — на НИЖНИХ двух, но из КОПИИ.
    // ⚠ Свой конструктор: у общего `makeSkinned` индексы весов жёстко 0/1/2 под три кости, а здесь
    // их ДВЕ — вершина с индексом 2 смотрела бы в пустоту (поймано падением на первом же замере).
    const part = (name: string, bones: THREE.Bone[]): THREE.SkinnedMesh => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
      const idx: number[] = [], w: number[] = [];
      for (let i = 0; i < 3; i++) { idx.push(i % bones.length, 0, 0, 0); w.push(1, 0, 0, 0); }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
      const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
      m.name = name; m.bind(new THREE.Skeleton(bones));
      return m;
    };
    const a = part('a', [canon.bones[0]!, canon.bones[1]!]);
    const b = part('b', [copy[1]!, copy[2]!]);
    root.add(a, b);
    root.updateMatrixWorld(true);
    const before = [skinnedPoints(a), skinnedPoints(b)];

    const r = dedupeSkeletons(root);

    expect(r.skins, 'скинов было два').toBe(2);
    const skels = new Set([a.skeleton, b.skeleton]);
    expect(skels.size, '⭐ на выходе ОДИН скелет на обоих').toBe(1);
    expect(a.skeleton.bones.length, 'и в нём объединение наборов').toBe(3);
    const inTree = new Set<THREE.Object3D>(); root.traverse((o) => inTree.add(o));
    for (const bone of a.skeleton.bones) expect(inTree.has(bone), `${bone.name} в дереве`).toBe(true);
    expect(r.bonesAfter, 'дубли ушли').toBe(3);
    // ГЛАВНОЕ: картинка не поехала. Перенумерация `skinIndex` — самое опасное место этой правки.
    expect(skinnedPoints(a), 'меш А на месте').toEqual(before[0]);
    expect(skinnedPoints(b), 'меш Б на месте').toEqual(before[1]);
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
    // ⚠ ЧУЖОЙ КЛАДЁТСЯ ПЕРВЫМ СПЕЦИАЛЬНО: арматура выбирается по РАЗМЕРУ поддерева, а не «первое
    // попавшееся». Положи чужого вторым — и подмена правила осталась бы незамеченной (проверено мутацией).
    const other = { bones: ['Root2', 'Mid2'].map((n, i) => { const b = new THREE.Bone(); b.name = n; b.position.set(i ? 5 : 0, 0, 0); return b; }) };
    other.bones[0]!.add(other.bones[1]!);
    root.add(other.bones[0]!);
    root.add(makeSkinned('m1', other.bones));
    const canon = makeSkeleton(); root.add(canon.root);
    const dup = addCopy(canon.bones, '_1');               // дубль — чтобы схлопывать было что
    root.add(makeSkinned('m0', canon.bones), makeSkinned('m2', dup));
    const r = dedupeSkeletons(root);
    expect(r.rebound, 'схлопнулся только дубль канона').toBe(1);
    expect(r.bonesAfter, '3 канона + 2 чужих остались').toBe(5);
    const m1 = root.children.find((c) => c.name === 'm1') as THREE.SkinnedMesh;
    expect(m1.skeleton.bones.map((b) => b.name), '⭐ чужой скелет не тронут').toEqual(['Root2', 'Mid2']);
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

  it('⭐ КОСТЬ БЕЗ ВЕСОВ ОСТАЁТСЯ В СКЕЛЕТЕ — общий набор это ВСЯ арматура', () => {
    // «Стало лучше, но поломались руки». Общий набор собирался из костей, У КОТОРЫХ ЕСТЬ ВЕСА.
    // На живой модели это девять ведущих костей в мусор: скин руки сидит на `UpperarmTwist01/02`,
    // ноги — на `ThighTwist`, а сами `Upperarm`/`Forearm`/`Thigh`/`Calf` не несут ни одной вершины
    // (замер по файлу: из 100 костей весят 61). В glTF костью становится ТОЛЬКО сустав скина —
    // значит выброшенная кость приезжала обратно обычным узлом, `autoBoneMap` её не находил, и
    // ретаргет просто переставал вести руку (экспорт: joints 61 против 100).
    //
    // Здесь та же форма в четырёх костях: веса есть у `Hips` и `SpineTwist`, а `Spine` и `Head`
    // между ними — «пустые». Они обязаны остаться: без `Spine` рука и висла.
    const root = new THREE.Group();
    const names = ['Hips', 'Spine', 'SpineTwist', 'Head'];
    const bones = names.map((n, i) => { const b = new THREE.Bone(); b.name = n; b.position.set(i ? 10 : 0, 0, 0); return b; });
    for (let i = 1; i < bones.length; i++) bones[i - 1]!.add(bones[i]!);
    root.add(bones[0]!);
    const part = (name: string, bs: THREE.Bone[]): THREE.SkinnedMesh => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
      const idx: number[] = [], w: number[] = [];
      for (let i = 0; i < 3; i++) { idx.push(i % bs.length, 0, 0, 0); w.push(1, 0, 0, 0); }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
      const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
      m.name = name; m.bind(new THREE.Skeleton(bs));
      return m;
    };
    const a = part('a', [bones[0]!]);              // только таз
    const b = part('b', [bones[2]!]);              // только твист
    root.add(a, b);
    root.updateMatrixWorld(true);
    const before = [skinnedPoints(a), skinnedPoints(b)];

    dedupeSkeletons(root);

    expect(a.skeleton, 'скелет один на обоих').toBe(b.skeleton);
    const got = a.skeleton.bones.map((x) => x.name).sort();
    expect(got, '⭐ в скине ВСЯ арматура, включая кости без единого веса').toEqual([...names].sort());
    expect(skinnedPoints(a), 'меш А не поехал').toEqual(before[0]);
    expect(skinnedPoints(b), 'меш Б не поехал').toEqual(before[1]);
  });
});
