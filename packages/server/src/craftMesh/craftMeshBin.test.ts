import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ConfigRegistry, defaultParts, familiesOf, weaponLookSig } from '@dm/shared';
import { CRAFT_MESH_DEPS } from '../../../client/src/modules/town/craftMesh/configVersion.js';
import { bakeCraftGlb, depsRegistry } from './bake.js';
import { bakeCraftBin, encodeCraftBin } from './encodeBin.js';
import { CRAFT_BIN_FORMAT, DMCM_FLAG_INDEX32, DMCM_H, DMCM_SLOTS, decodeCraftBin, type DmcmFile, type DmcmMaterial } from './binFormat.js';

/**
 * ⭐ 08.10 (Ф4, план «Unity — дом визуального контента»): ДВОИЧНЫЙ МЕШ DMCM v1 ПРОТИВ GLB. GLB — оракул: оба печёт одна сборка
 * (`buildForBake`), а GLB разбирает НАСТОЯЩИЙ загрузчик three (как `craftMeshBake.test.ts`) — значит, DMCM обязан дать ровно ту
 * геометрию, что видит загрузчик glTF: по каждому гнезду и материалу те же треугольники в том же порядке, позиции до 1e-4 см, нормали
 * до 1e-5, UV — бит в бит, те же PBR. Зеркальные клоны (масштаб −1 по X) в DMCM запечены — намотку там переворачивает кодер, и
 * сторож — согласие нормали грани с нормалями вершин именно у зеркальных треугольников.
 * Плюс: заголовок, габарит и конец (`tip`) честны; кривой файл декодер различает по причине; синтетика — неравномерный масштаб,
 * зеркало, геометрия без индексов и UV, мульти-материал, индексы u32. ЗАМЕР размеров GLB против DMCM — в выводе теста.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const CLASSES = reg.get('weapon-anatomy').map((a) => a.id);
const FAMILIES = CLASSES.flatMap((cls) => familiesOf(reg, cls).map((hands) => ({ cls, hands })));
const baseOf = (cls: string, hands: number) =>
  reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === cls && (b.hands ?? 1) === hands);
const bakeReg = depsRegistry(Object.fromEntries(CRAFT_MESH_DEPS.map((k) => [k, reg.get(k)])));

async function loadGlb(glb: Uint8Array): Promise<{ scene: THREE.Group; json: Record<string, unknown> }> {
  const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  const len = new DataView(ab).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, len))) as Record<string, unknown>;
  const gltf = await new GLTFLoader().parseAsync(ab, '');
  return { scene: gltf.scene, json };
}

function decoded(bin: Uint8Array): DmcmFile {
  const d = decodeCraftBin(bin);
  if (!d.ok) throw new Error(`DMCM не разобран: ${d.error} — ${d.detail}`);
  return d.file;
}

const f = Math.fround;
type Pbr = Omit<DmcmMaterial, 'alphaCutoff'>;
/** Ключ материала: имя + PBR во float32 — так их видит Unity (имена у `fixed:` бывают одинаковыми при разном металле). */
const matKey = (m: Pbr): string => [
  m.name, ...m.baseColor.map(f), f(m.metallic), f(m.roughness), ...m.emissive.map(f), f(m.emissiveStrength), m.alphaMode, m.doubleSided,
].join('|');

interface Tri { p: number[]; n: number[]; uv: number[]; mirrored: boolean }
/** гнездо → ключ материала (в порядке первой встречи) → треугольники по порядку. */
type Lists = Map<string, Map<string, Tri[]>>;

/** Треугольники GLB так, как их рисует three: мир узла, у узла с det < 0 — показ с обратной стороны (то есть (a, c, b)). */
function glbTris(scene: THREE.Group): { lists: Lists; parts: number } {
  scene.updateMatrixWorld(true);
  const root = scene.getObjectByName('craftWeapon')!;
  const lists: Lists = new Map();
  let parts = 0;
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const slot of DMCM_SLOTS) {
    const per = new Map<string, Tri[]>();
    lists.set(slot, per);
    root.children.find((c) => c.name === slot)!.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      parts++;
      const mat = m.material as THREE.MeshStandardMaterial;
      const key = matKey({
        name: mat.name, baseColor: [mat.color.r, mat.color.g, mat.color.b, mat.opacity], metallic: mat.metalness, roughness: mat.roughness,
        emissive: [mat.emissive.r, mat.emissive.g, mat.emissive.b], emissiveStrength: mat.emissiveIntensity,
        alphaMode: mat.transparent ? 'BLEND' : mat.alphaTest > 0 ? 'MASK' : 'OPAQUE', doubleSided: mat.side === THREE.DoubleSide,
      });
      let list = per.get(key);
      if (!list) { list = []; per.set(key, list); }
      const g = m.geometry;
      const P = g.getAttribute('position'), N = g.getAttribute('normal'), T = g.getAttribute('uv'), I = g.index;
      const mirrored = m.matrixWorld.determinant() < 0;
      nm.getNormalMatrix(m.matrixWorld);
      const count = I ? I.count : P.count;
      for (let t = 0; t < count; t += 3) {
        const c = [t, t + 1, t + 2].map((k) => (I ? I.getX(k) : k));
        const order = mirrored ? [c[0]!, c[2]!, c[1]!] : c;
        const tri: Tri = { p: [], n: [], uv: [], mirrored };
        for (const i of order) {
          v.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld); tri.p.push(v.x, v.y, v.z);
          v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); tri.n.push(v.x, v.y, v.z);
          tri.uv.push(T ? T.getX(i) : 0, T ? T.getY(i) : 0);
        }
        list.push(tri);
      }
    });
  }
  return { lists, parts };
}

function binTris(file: DmcmFile): Lists {
  const lists: Lists = new Map();
  for (const s of file.slots) {
    const per = new Map<string, Tri[]>();
    lists.set(s.name, per);
    for (const g of s.groups) {
      const key = matKey(file.materials[g.material]!);
      expect(per.has(key), `${s.name}: материал «${key}» — одна группа на гнездо`).toBe(false);
      const list: Tri[] = [];
      per.set(key, list);
      for (let t = 0; t < g.indexCount; t += 3) {
        const tri: Tri = { p: [], n: [], uv: [], mirrored: false };
        for (let k = 0; k < 3; k++) {
          const i = s.vertexStart + file.index[s.indexStart + g.indexStart + t + k]!;
          tri.p.push(file.position[i * 3]!, file.position[i * 3 + 1]!, file.position[i * 3 + 2]!);
          tri.n.push(file.normal[i * 3]!, file.normal[i * 3 + 1]!, file.normal[i * 3 + 2]!);
          tri.uv.push(file.uv[i * 2]!, file.uv[i * 2 + 1]!);
        }
        list.push(tri);
      }
    }
  }
  return lists;
}

/** Нормаль грани (по намотке) против суммы нормалей вершин: +1 согласна, −1 против, 0 — вырожденный или ребро на ребре. */
function facing(t: Tri): number {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.p as [number, number, number, number, number, number, number, number, number];
  const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
  const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const sx = t.n[0]! + t.n[3]! + t.n[6]!, sy = t.n[1]! + t.n[4]! + t.n[7]!, sz = t.n[2]! + t.n[5]! + t.n[8]!;
  const area = Math.hypot(nx, ny, nz), ns = Math.hypot(sx, sy, sz);
  if (area < 1e-8 || ns < 1e-6) return 0;
  const cos = (nx * sx + ny * sy + nz * sz) / (area * ns);
  return Math.abs(cos) < 0.05 ? 0 : Math.sign(cos);
}

/** PBR материалов GLB — из JSON файла, с умолчаниями glTF. */
function glbMaterials(json: Record<string, unknown>): string[] {
  type GM = { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number };
    emissiveFactor?: number[]; alphaMode?: string; alphaCutoff?: number; doubleSided?: boolean; extensions?: Record<string, { emissiveStrength?: number }> };
  return ((json.materials ?? []) as GM[]).map((m) => [
    matKey({
      name: m.name ?? '', baseColor: (m.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1]) as [number, number, number, number],
      metallic: m.pbrMetallicRoughness?.metallicFactor ?? 1, roughness: m.pbrMetallicRoughness?.roughnessFactor ?? 1,
      emissive: (m.emissiveFactor ?? [0, 0, 0]) as [number, number, number],
      emissiveStrength: m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
      alphaMode: (m.alphaMode ?? 'OPAQUE') as DmcmMaterial['alphaMode'], doubleSided: m.doubleSided ?? false,
    }),
    f(m.alphaMode === 'MASK' ? m.alphaCutoff ?? 0.5 : 0.5),
  ].join('|')).sort();
}

interface Case { cls: string; hands: number; step: number }
const CASES: Case[] = FAMILIES.flatMap(({ cls, hands }) => [1, 3, 5].map((step) => ({ cls, hands, step })));

async function bakeBoth(c: Case): Promise<{ glb: Uint8Array; bin: Uint8Array; look: string }> {
  const parts = defaultParts(reg, c.cls, c.hands, c.step)!;
  const look = weaponLookSig({ baseId: baseOf(c.cls, c.hands)?.id ?? '', parts });
  const meta = { look, rev: 'r-bin' };
  const glb = await bakeCraftGlb(bakeReg, c.cls, c.hands, parts, meta);
  const bin = await bakeCraftBin(bakeReg, c.cls, c.hands, parts, meta);
  expect(glb && bin, `${c.cls}/${c.hands}@${c.step}`).toBeTruthy();
  return { glb: glb!, bin: bin!, look };
}

describe('⭐ DMCM v1 против GLB: та же модель без потерь', () => {
  it('⭐ все 15 семейств × ступени 1/3/5: те же треугольники по гнезду и материалу, позиции ≤ 1e-4 см, нормали ≤ 1e-5, UV и PBR бит в бит, намотка зеркал', async () => {
    expect(FAMILIES.length, 'все 15 семейств').toBe(15);
    const rows: string[] = [];
    let mirroredTris = 0, mirroredAgree = 0, mirroredAgainst = 0, plainAgree = 0, plainAgainst = 0;
    for (const c of CASES) {
      const what = `${c.cls}/${c.hands}@${c.step}`;
      const { glb, bin } = await bakeBoth(c);
      const file = decoded(bin);
      const { scene, json } = await loadGlb(glb);
      const ref = glbTris(scene);
      const got = binTris(file);

      // PBR: таблица DMCM = материалы GLB (из JSON файла, с умолчаниями glTF), во float32.
      expect(file.materials.map((m) => [matKey(m), f(m.alphaCutoff)].join('|')).sort(), `${what}: PBR материалов`).toEqual(glbMaterials(json));

      let dp = 0, dn = 0, uvBad = 0;
      const perMat = new Map<string, [number, number]>();
      for (const slot of DMCM_SLOTS) {
        const r = ref.lists.get(slot)!, g = got.get(slot)!;
        expect([...g.keys()], `${what}/${slot}: материалы групп в порядке первой встречи`).toEqual([...r.keys()]);
        for (const [key, rt] of r) {
          const gt = g.get(key)!;
          expect(gt.length, `${what}/${slot}/${key}: треугольников`).toBe(rt.length);
          const pm = perMat.get(key) ?? [0, 0];
          perMat.set(key, [pm[0] + rt.length, pm[1] + gt.length]);
          for (let t = 0; t < rt.length; t++) {
            const a = rt[t]!, b = gt[t]!;
            for (let k = 0; k < 9; k++) { dp = Math.max(dp, Math.abs(a.p[k]! - b.p[k]!)); dn = Math.max(dn, Math.abs(a.n[k]! - b.n[k]!)); }
            for (let k = 0; k < 6; k++) if (f(a.uv[k]!) !== b.uv[k]) uvBad++;
            const s = facing(b);
            if (a.mirrored) { mirroredTris++; if (s > 0) mirroredAgree++; else if (s < 0) mirroredAgainst++; }
            else if (s > 0) plainAgree++; else if (s < 0) plainAgainst++;
          }
        }
      }
      for (const [key, [r, g]] of perMat) expect(g, `${what}: треугольников материала ${key}`).toBe(r);
      expect(dp, `${what}: позиции, см`).toBeLessThanOrEqual(1e-4);
      expect(dn, `${what}: нормали`).toBeLessThanOrEqual(1e-5);
      expect(uvBad, `${what}: UV`).toBe(0);

      if (c.step === 3) {
        const gz = (b: Uint8Array): number => gzipSync(b, { level: 9 }).byteLength;
        const kb = (n: number): string => (n / 1024).toFixed(1).padStart(6);
        rows.push(`${`${c.cls}/${c.hands}`.padEnd(12)} частей ${String(ref.parts).padStart(3)}  вершин ${String(file.vertexCount).padStart(6)}  треуг. ${String(file.indexCount / 3).padStart(6)}  `
          + `GLB ${kb(glb.byteLength)} КБ  DMCM ${kb(bin.byteLength)} КБ  ×${(bin.byteLength / glb.byteLength).toFixed(2)}  `
          + `gzip GLB ${kb(gz(glb))}  DMCM ${kb(gz(bin))}  индексы ${file.index32 ? 'u32' : 'u16'}`);
      }
    }
    console.log(`[DMCM замер, ступень 3]\n${rows.join('\n')}`);
    console.log(`[DMCM намотка] зеркальных треугольников ${mirroredTris}: согласны ${mirroredAgree}, против ${mirroredAgainst}; прочих: согласны ${plainAgree}, против ${plainAgainst}`);
    expect(mirroredTris, 'зеркальные части в прогоне есть').toBeGreaterThan(100);
    // Сторож намотки зеркал: без перестановки (b, c) у зеркальных треугольников согласие и несогласие поменялись бы местами.
    expect(mirroredAgree / Math.max(1, mirroredAgree + mirroredAgainst), 'зеркальные: грань смотрит по нормалям').toBeGreaterThan(0.9);
    expect(plainAgree / Math.max(1, plainAgree + plainAgainst), 'прочие: грань смотрит по нормалям').toBeGreaterThan(0.9);
  });

  it('заголовок: магия, версия, размер, метаданные; габарит и конец — по записанным позициям; конец у меча — в −Y', async () => {
    for (const { cls, hands } of FAMILIES) {
      const { glb, bin, look } = await bakeBoth({ cls, hands, step: 3 });
      const file = decoded(bin);
      const what = `${cls}/${hands}`;
      expect(String.fromCharCode(...bin.slice(0, 4))).toBe('DMCM');
      expect(file.version).toBe(CRAFT_BIN_FORMAT);
      expect(file.fileBytes).toBe(bin.byteLength);
      expect(bin.byteLength % 4).toBe(0);
      expect(file.meta, `${what}: метаданные`).toEqual({ v: 1, units: 'cm', grip: 'origin', workingEnd: '-Y', look, rev: 'r-bin' });
      expect(file.index32).toBe(file.slots.some((s) => s.vertexCount > 0xffff));
      expect(file.slots.map((s) => s.name)).toEqual(['strike', 'grip', 'bind', 'head']);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      let tip = [0, 0, 0], tipD = -1;
      for (const s of file.slots) {
        const smin = [Infinity, Infinity, Infinity], smax = [-Infinity, -Infinity, -Infinity];
        for (let i = s.vertexStart; i < s.vertexStart + s.vertexCount; i++) {
          const p = [file.position[i * 3]!, file.position[i * 3 + 1]!, file.position[i * 3 + 2]!];
          for (let k = 0; k < 3; k++) { smin[k] = Math.min(smin[k]!, p[k]!); smax[k] = Math.max(smax[k]!, p[k]!); }
          const d = p[0]! ** 2 + p[1]! ** 2 + p[2]! ** 2;
          if (d > tipD) { tipD = d; tip = p; }
        }
        if (s.vertexCount) {
          expect(s.bmin, `${what}/${s.name}: габарит гнезда`).toEqual(smin);
          expect(s.bmax).toEqual(smax);
          for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, smin[k]!); max[k] = Math.max(max[k]!, smax[k]!); }
        } else {
          expect(s.bmin, `${what}/${s.name}: пустое гнездо — нули`).toEqual([0, 0, 0]);
          expect(s.bmax).toEqual([0, 0, 0]);
        }
      }
      expect(file.bmin, `${what}: габарит`).toEqual(min);
      expect(file.bmax).toEqual(max);
      expect(file.tip, `${what}: конец — самая дальняя от хвата вершина`).toEqual(tip);
      // Габарит DMCM = габарит сцены GLB (загрузчик three).
      const { scene } = await loadGlb(glb);
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene, true);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(file.bmin[k]! - box.min.getComponent(k)), `${what}: bmin[${k}] против GLB`).toBeLessThan(1e-4);
        expect(Math.abs(file.bmax[k]! - box.max.getComponent(k)), `${what}: bmax[${k}] против GLB`).toBeLessThan(1e-4);
      }
      if (cls === 'sword') expect(file.tip[1], 'острие меча — в −Y').toBeLessThan(-50);
    }
  });

  it('⭐ кривой файл отказан, и причина различима: обрезан, чужая магия, чужая версия, неизвестный флаг, лишний хвост, кривая раскладка', async () => {
    const { bin } = await bakeBoth({ cls: 'sword', hands: 1, step: 3 });
    expect(decodeCraftBin(bin).ok).toBe(true);
    const err = (b: Uint8Array): string => { const d = decodeCraftBin(b); return d.ok ? 'ok' : d.error; };
    const patched = (fn: (dv: DataView, u8: Uint8Array) => void): Uint8Array => { const c = bin.slice(); fn(new DataView(c.buffer), c); return c; };
    expect(err(bin.slice(0, bin.byteLength - 4)), 'хвост отрезан').toBe('truncated');
    expect(err(bin.slice(0, 60)), 'короче заголовка').toBe('truncated');
    expect(err(bin.slice(0, 2)), 'короче магии').toBe('truncated');
    expect(err(new Uint8Array(0))).toBe('truncated');
    expect(err(patched((_, u8) => { u8[3] = 0x58; })), 'магия DMCX').toBe('magic');
    expect(err(patched((_, u8) => { u8.set([0x67, 0x6c, 0x54, 0x46]); })), 'это GLB').toBe('magic');
    expect(err(patched((dv) => dv.setUint16(DMCM_H.version, 2, true))), 'версия 2').toBe('version');
    expect(err(patched((dv) => dv.setUint16(DMCM_H.flags, 4, true))), 'неизвестный бит флагов').toBe('flags');
    const longer = new Uint8Array(bin.byteLength + 4); longer.set(bin);
    expect(err(longer), 'лишний хвост').toBe('length');
    expect(err(patched((dv) => dv.setUint32(DMCM_H.posOffset, dv.getUint32(DMCM_H.posOffset, true) + 2, true))), 'смещение не кратно 4').toBe('layout');
    expect(err(patched((dv) => dv.setUint16(DMCM_H.slotCount, 3, true))), 'гнёзд не 4').toBe('layout');
    expect(err(patched((dv) => {
      const idx = dv.getUint32(DMCM_H.idxOffset, true);
      dv.setUint16(idx, 0xffff, true);   // первый индекс гнезда strike — за его вершинами
    })), 'индекс вне гнезда').toBe('layout');
  });
});

describe('DMCM v1 на синтетике: запечённые узлы', () => {
  /** Корень с четырьмя гнёздами — форма результата построителя. */
  function rootWith(fill: Partial<Record<string, THREE.Object3D[]>>): THREE.Group {
    const root = new THREE.Group();
    for (const s of DMCM_SLOTS) { const g = new THREE.Group(); g.name = s; for (const o of fill[s] ?? []) g.add(o); root.add(g); }
    return root;
  }
  const std = (name: string, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial(o); m.name = name; return m;
  };

  it('⭐ неравномерный масштаб и зеркало: p = M·p, n = нормаль (M⁻¹)ᵀ, у зеркала перевёрнута намотка; без UV — нули; без индексов — по порядку', () => {
    const iron = std('iron:3', { color: 0x8899aa, metalness: 0.8, roughness: 0.3 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 1), iron);
    box.position.set(3, -5, 1); box.rotation.set(0.3, -0.7, 1.1); box.scale.set(2, 0.5, 3);
    const mirror = box.clone(); mirror.position.x = -mirror.position.x; mirror.scale.x = -mirror.scale.x;
    mirror.rotation.y = -mirror.rotation.y; mirror.rotation.z = -mirror.rotation.z;
    const flat = new THREE.BoxGeometry(1, 1, 1).toNonIndexed(); flat.deleteAttribute('uv');
    const loose = new THREE.Mesh(flat, iron);
    const holder = new THREE.Group(); holder.scale.set(1, 1.5, 0.75); holder.position.set(0, -10, 0); holder.add(loose);
    const root = rootWith({ strike: [box, mirror], bind: [holder] });
    const file = decoded(encodeCraftBin(root, { look: 'x', rev: 'r' }));
    expect(file.slots.map((s) => s.vertexCount)).toEqual([48, 0, 36, 0]);
    expect(file.slots[1]!.groups, 'пустое гнездо — без групп').toEqual([]);
    expect(file.materials.map((m) => m.name)).toEqual(['iron:3']);

    root.updateMatrixWorld(true);
    const check = (mesh: THREE.Mesh, vStart: number): void => {
      const P = mesh.geometry.getAttribute('position'), N = mesh.geometry.getAttribute('normal');
      const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      for (let i = 0; i < P.count; i++) {
        const p = new THREE.Vector3().fromBufferAttribute(P, i).applyMatrix4(mesh.matrixWorld);
        const n = new THREE.Vector3().fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
        const j = vStart + i;
        expect(Math.abs(file.position[j * 3]! - p.x) + Math.abs(file.position[j * 3 + 1]! - p.y) + Math.abs(file.position[j * 3 + 2]! - p.z)).toBeLessThan(1e-5);
        expect(Math.abs(file.normal[j * 3]! - n.x) + Math.abs(file.normal[j * 3 + 1]! - n.y) + Math.abs(file.normal[j * 3 + 2]! - n.z)).toBeLessThan(1e-6);
      }
    };
    check(box, 0);
    check(mirror, 24);
    check(loose, file.slots[2]!.vertexStart);
    // У куба нормаль вершины = нормаль грани: КАЖДЫЙ треугольник обязан смотреть по своим нормалям — и у зеркала тоже.
    const tris = binTris(file);
    let n = 0;
    for (const list of tris.values()) for (const l of list.values()) for (const t of l) { expect(facing(t)).toBe(1); n++; }
    expect(n).toBe(12 + 12 + 12);
    const bind = file.slots[2]!;
    expect([...file.uv.slice(bind.vertexStart * 2, (bind.vertexStart + bind.vertexCount) * 2)].every((x) => x === 0), 'без UV — нули').toBe(true);
    expect([...file.index.slice(bind.indexStart, bind.indexStart + bind.indexCount)], 'без индексов — по порядку')
      .toEqual(Array.from({ length: 36 }, (_, i) => i));
    // Зеркало: тот же треугольник куба, но (a, c, b) — и индексы относительно гнезда (вторые 24 вершины).
    const s = file.slots[0]!;
    const first = [...file.index.slice(s.indexStart, s.indexStart + 3)];
    expect([...file.index.slice(s.indexStart + 36, s.indexStart + 39)]).toEqual([first[0]! + 24, first[2]! + 24, first[1]! + 24]);
  });

  it('группы по материалу в порядке первой встречи; мульти-материал по группам геометрии; невидимое не пишется', () => {
    const a = std('iron:2'), b = std('wood:4', { emissive: 0x336699, emissiveIntensity: 0.45 }), c = std('fixed:aabbcc', { transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const m1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), a);
    const m2 = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 4), b);
    const m3 = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), a);
    const multi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [c, b, c, b, c, b]);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), c); hidden.visible = false;
    const root = rootWith({ grip: [m1, m2, m3, hidden], head: [multi] });
    const file = decoded(encodeCraftBin(root, { look: 'x', rev: 'r' }));
    const grip = file.slots[1]!;
    expect(grip.groups.map((g) => file.materials[g.material]!.name)).toEqual(['iron:2', 'wood:4']);
    expect(grip.groups.map((g) => g.indexCount)).toEqual([72, m2.geometry.index!.count]);
    expect(grip.vertexCount, 'невидимый меш не пишется').toBe(24 + m2.geometry.getAttribute('position').count + 24);
    const head = file.slots[3]!;
    expect(head.groups.map((g) => [file.materials[g.material]!.name, g.indexCount])).toEqual([['fixed:aabbcc', 18], ['wood:4', 18]]);
    const wood = file.materials.find((m) => m.name === 'wood:4')!;
    expect(wood.emissiveStrength).toBe(f(0.45));
    expect(wood.emissive).toEqual(new THREE.Color(0x336699).toArray().map(f));
    const glass = file.materials.find((m) => m.name === 'fixed:aabbcc')!;
    expect(glass).toMatchObject({ alphaMode: 'BLEND', doubleSided: true, alphaCutoff: 0.5 });
    expect(glass.baseColor[3]).toBe(0.5);
    expect(file.materials.find((m) => m.name === 'iron:2')!).toMatchObject({ alphaMode: 'OPAQUE', doubleSided: false, emissiveStrength: 1, emissive: [0, 0, 0] });
  });

  it('индексы u32 — когда в гнезде больше 65535 вершин (флаг в заголовке)', () => {
    const big = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 300, 300), std('iron:1'));   // 301² = 90601 вершин
    const file = decoded(encodeCraftBin(rootWith({ strike: [big] }), { look: 'x', rev: 'r' }));
    expect(file.index32).toBe(true);
    expect(file.flags & DMCM_FLAG_INDEX32).toBe(DMCM_FLAG_INDEX32);
    expect(file.index).toBeInstanceOf(Uint32Array);
    let top = 0;
    for (const x of file.index) top = Math.max(top, x);
    expect(top).toBe(90600);
  });

  it('корень не из четырёх гнёзд — громкий отказ, а не тихо кривой файл', () => {
    const root = rootWith({});
    root.add(new THREE.Group());
    expect(() => encodeCraftBin(root, { look: 'x', rev: 'r' })).toThrow(/гнёзда/);
  });
});
