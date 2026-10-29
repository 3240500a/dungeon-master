import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeIdenticalSkins } from './glbNormalize.js';
import { dedupeSkeletons } from './skeletonDedupe.js';

/**
 * ⭐⭐ ПЕРЕЖИВАЮТ ЛИ БЛЕНД-ШЕЙПЫ НАШ ПАЙПЛАЙН GLB.
 *
 * Вопрос решающий для модульной одежды: приём «плащ принимает форму поверх брони» весь стоит на morph
 * targets, и если наш круг «экспорт → нормализация → загрузка» их теряет, техника не заработает в принципе,
 * сколько её ни авторь. Мы ведь не просто экспортируем: `exportGLB` ещё и ПЕРЕСОБИРАЕТ бинарь
 * (`mergeIdenticalSkins` — один скин на скелет), а загрузка схлопывает скелеты (`dedupeSkeletons`).
 *
 * Здесь настоящий круг на синтетическом скиннед-меше с одним шейпом «раздуться».
 */
function skinnedWithMorphs(): { root: THREE.Object3D; mesh: THREE.SkinnedMesh } {
  const geo = new THREE.BoxGeometry(1, 2, 1, 1, 2, 1);
  const n = geo.attributes.position!.count;
  const fat = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { fat[i * 3] = 0.5; fat[i * 3 + 2] = 0.5; }   // шейп «раздуться» вбок
  geo.morphAttributes.position = [new THREE.BufferAttribute(fat, 3)];
  const skinIdx = new Uint16Array(n * 4), skinW = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) skinW[i * 4] = 1;
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIdx, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinW, 4));
  const bone = new THREE.Bone(); bone.name = 'Root';
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
  mesh.name = 'cloak';
  mesh.morphTargetDictionary = { overArmor: 0 };
  mesh.morphTargetInfluences = [0];
  const root = new THREE.Group();
  root.add(bone); root.add(mesh);
  mesh.bind(new THREE.Skeleton([bone]));
  return { root, mesh };
}

/** `GLTFExporter` в ноде требует `FileReader` — тот же обходной приём, что в `fbxRoundTrip.test.ts`. */
class NodeFileReader {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(b: Blob): void { void b.arrayBuffer().then((ab) => { this.result = ab; this.onloadend?.(); }); }
}
(globalThis as unknown as { FileReader: unknown }).FileReader ??= NodeFileReader;

const exportGlb = (obj: THREE.Object3D): Promise<ArrayBuffer> =>
  new Promise((res, rej) => new GLTFExporter().parse(obj, (r) => res(r as ArrayBuffer), (e) => rej(e), { binary: true, onlyVisible: false }));
const loadGlb = (buf: ArrayBuffer): Promise<THREE.Group> =>
  new Promise((res, rej) => new GLTFLoader().parse(buf, '', (g) => res((g as unknown as { scene: THREE.Group }).scene), (e) => rej(e)));
const firstMesh = (root: THREE.Object3D): THREE.Mesh | null => {
  let m: THREE.Mesh | null = null;
  root.traverse((o) => { const x = o as THREE.Mesh; if (!m && x.isMesh) m = x; });
  return m;
};

describe('⭐ бленд-шейпы через наш круг GLB', () => {
  it('экспорт → `mergeIdenticalSkins` → загрузка: шейп на месте, с именем и со смещениями', async () => {
    const { root } = skinnedWithMorphs();
    const { out } = mergeIdenticalSkins(await exportGlb(root));
    const back = firstMesh(await loadGlb(out));
    expect(back, 'меш пережил круг').toBeTruthy();
    const m = back!;
    expect(m.geometry.morphAttributes.position?.length ?? 0, 'число шейпов').toBe(1);
    expect(Object.keys(m.morphTargetDictionary ?? {}), '⚠ ИМЯ шейпа — по нему рантайм его и находит').toContain('overArmor');
    // ⚠ Мерить надо ПО ВСЕМУ мешу, а не по вершине 0: glTF хранит шейп ОТНОСИТЕЛЬНО базы, и у отдельной
    // вершины смещение законно бывает нулевым (первая проба этого сторожа села именно на такую).
    const d = m.geometry.morphAttributes.position![0]!;
    let sum = 0;
    for (let i = 0; i < d.count; i++) sum += Math.abs(d.getX(i)) + Math.abs(d.getY(i)) + Math.abs(d.getZ(i));
    expect(sum, 'смещения шейпа не обнулились').toBeGreaterThan(1);
    expect(m.geometry.morphTargetsRelative, 'после круга шейп относительный — так его и пишет glTF').toBe(true);
  });

  it('`dedupeSkeletons` (схлопывание скелетов на загрузке) шейпы не трогает', async () => {
    const { root } = skinnedWithMorphs();
    const loaded = await loadGlb((await exportGlb(root)));
    dedupeSkeletons(loaded);
    const m = firstMesh(loaded)!;
    expect(m.geometry.morphAttributes.position?.length ?? 0).toBe(1);
    expect((m as THREE.SkinnedMesh).morphTargetInfluences?.length ?? 0, 'веса шейпов у меша есть — их и крутит рантайм').toBe(1);
  });
});
