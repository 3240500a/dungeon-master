import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { parseModel, exportGLB } from './modelAssets.js';
import { autoBoneMap, measureBoneOffsets, normalizeUpAxis, upAxisAngle, tPoseDeviation, enforceTPose, TPOSE_THRESHOLD_DEG, boneIndex, makeRetargetRig, parentOfOur, OUR_BONES, OUR_FINGERS } from './retarget3d.js';
import { buildHumanoid } from './humanoid.js';

/**
 * ⭐ ГЛАВНЫЙ СТОРОЖ ИМПОРТА: СКЕЛЕТ ПОСЛЕ ВСЕГО ПАЙПЛАЙНА = СКЕЛЕТ ФАЙЛА.
 *
 * Требование автора дословно: «загрузил модель — и всё встало на место, ничего никуда не уехало,
 * все размеры из модели; даже если на 0.00001 уезжает — значит что-то делаем не так».
 *
 * Здесь прогоняется РЕАЛЬНЫЙ путь импорта (`poseModelsTab.importAtlas` + рантайм-ретаргет) и сверяется
 * с сырым файлом художника: направление каждой кости и её длина. Метрика инвариантна к общему масштабу
 * (наш TILE≠см) — сравниваем ФОРМУ, а она обязана совпадать точно.
 *
 * ЧТО ЭТО ПОЙМАЛО (замеры до починки → после):
 *   • поза:  тело 15.78° → 0.00°   — `enforceTPose` целил кости художника в направления НАШЕЙ болванки;
 *   • ось:   пальцы 81.2° → 0.00°  — Y-up доворот был ВРЕМЕННЫМ, и в нашу систему модель затаскивал
 *                                    покостный привод; что он не тащит, оставалось в системе файла;
 *   • длины: 0.43 % → 6e-7 %       — офсеты костей округлялись до сотых.
 */
const SRC = 'C:/work/Games_Art/Games_Art/top_down/model_ai/char/knight_01/Modular_01/fbx/knight_06_modular_rig.fbx';

class NodeFileReader {
  result: ArrayBuffer | null = null; onloadend: (() => void) | null = null;
  readAsArrayBuffer(b: Blob): void { void b.arrayBuffer().then((ab) => { this.result = ab; this.onloadend?.(); }); }
}
(globalThis as unknown as { FileReader: unknown }).FileReader ??= NodeFileReader;
const read = (p: string): ArrayBuffer => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const D = 180 / Math.PI;
const BONES = [...OUR_BONES, ...OUR_FINGERS] as string[];

/** Направление (родитель→кость) и длина в мире. */
function seg(idx: Map<string, THREE.Object3D>, map: Record<string, string>, our: string): { dir: THREE.Vector3; len: number } | null {
  const p = parentOfOur(our); if (!p) return null;
  const cb = idx.get(map[our] ?? ''), pb = idx.get(map[p] ?? '');
  if (!cb || !pb) return null;
  const v = cb.getWorldPosition(new THREE.Vector3()).sub(pb.getWorldPosition(new THREE.Vector3()));
  const len = v.length(); if (len < 1e-6) return null;
  return { dir: v.multiplyScalar(1 / len), len };
}
/** Опорный пролёт таз→голова — тем же правилом, каким масштаб берёт прод (`modelSkin.scaleToSource`). */
function spanOf(idx: Map<string, THREE.Object3D>, m: Record<string, string>): number {
  const a = idx.get(m['Hips'] ?? ''), b = idx.get(m['Head'] ?? '');
  return a && b ? a.getWorldPosition(new THREE.Vector3()).distanceTo(b.getWorldPosition(new THREE.Vector3())) : 1;
}
const ourSpan = (h: { bones: Map<string, THREE.Object3D> }): number =>
  h.bones.get('Hips')!.getWorldPosition(new THREE.Vector3()).distanceTo(h.bones.get('Head')!.getWorldPosition(new THREE.Vector3()));

const pose = (o: THREE.Object3D): void => { o.traverse((c) => { const s = (c as THREE.SkinnedMesh).skeleton; if (s) s.pose(); }); };

describe.runIf(existsSync(SRC))('ИМПОРТ 1:1 С ФАЙЛОМ', () => {
  it('⭐ каждая кость приходит туда, где её поставил художник', async () => {
    // ЭТАЛОН — сырой файл, приведённый к Y-up (той же единственной функцией, что и импорт).
    const ref = await parseModel(read(SRC), 'fbx'); pose(ref); ref.updateMatrixWorld(true);
    const refMap = autoBoneMap([...boneIndex(ref).keys()]);
    normalizeUpAxis(ref, refMap);
    const refIdx = boneIndex(ref);
    const refSeg = new Map<string, { dir: THREE.Vector3; len: number }>();
    for (const b of BONES) { const s = seg(refIdx, refMap, b); if (s) refSeg.set(b, s); }

    // БОЕВОЙ ПУТЬ: importAtlas (нормализация оси → замер → экспорт GLB) + рантайм (загрузка → ретаргет).
    const g = await parseModel(read(SRC), 'fbx'); pose(g);
    const map = autoBoneMap([...boneIndex(g).keys()]);
    normalizeUpAxis(g, map);
    const boneOffsets = measureBoneOffsets(g, map);
    const loaded = await parseModel(await exportGLB(g), 'glb');
    const source = buildHumanoid({ boneOffsets, fingers: true });
    source.root.updateMatrixWorld(true);
    const k = ourSpan(source) / spanOf(boneIndex(loaded), map);   // тем же правилом, что прод (`scaleToSource`)
    makeRetargetRig(loaded, map, k, source).drive(source);
    loaded.updateMatrixWorld(true);
    const gotIdx = boneIndex(loaded);

    // Общий масштаб — по опорному пролёту таз→голова; форма обязана совпасть при нём точно.
    const span = (idx: Map<string, THREE.Object3D>, m: Record<string, string>): number =>
      idx.get(m['Hips'] ?? '')!.getWorldPosition(new THREE.Vector3()).distanceTo(idx.get(m['Head'] ?? '')!.getWorldPosition(new THREE.Vector3()));
    const K = span(gotIdx, map) / span(refIdx, refMap);

    // ⚠ СВЕРЯЕМ ВСЕ КОСТИ, А НЕ ТОЛЬКО 47 КАНОНИЧЕСКИХ. Твисты (`UpperarmTwist01`), `Waist`, `ToeBase`
    // и прочие служебные в карту не входят, но меш ведут они же — аудит по канону их бы не заметил.
    const all: string[] = [];
    for (const [nm, o] of refIdx) if (gotIdx.has(nm) && o.parent && refIdx.has(o.parent.name)) all.push(nm);
    const idMap: Record<string, string> = {}; for (const nm of all) idMap[nm] = nm;
    const parentName = new Map<string, string>(); for (const nm of all) parentName.set(nm, refIdx.get(nm)!.parent!.name);
    const segAny = (idx: Map<string, THREE.Object3D>, nm: string): { dir: THREE.Vector3; len: number } | null => {
      const cb = idx.get(nm), pb = idx.get(parentName.get(nm) ?? ''); if (!cb || !pb) return null;
      const v = cb.getWorldPosition(new THREE.Vector3()).sub(pb.getWorldPosition(new THREE.Vector3()));
      const len = v.length(); if (len < 1e-6) return null;
      return { dir: v.multiplyScalar(1 / len), len };
    };
    let worstAng = { b: '', v: 0 }, worstLen = { b: '', v: 0 }, n = 0;
    for (const b of all) {
      const r = segAny(refIdx, b), s = segAny(gotIdx, b); if (!r || !s) continue;
      n++;
      const ang = r.dir.angleTo(s.dir) * D, len = Math.abs(s.len / K / r.len - 1) * 100;
      if (ang > worstAng.v) worstAng = { b, v: ang };
      if (len > worstLen.v) worstLen = { b, v: len };
    }
    console.log(`сверено костей ${n} · макс угол ${worstAng.v.toExponential(2)}° (${worstAng.b}) · макс длина ${worstLen.v.toExponential(2)}% (${worstLen.b})`);
    expect(n, 'сверяется ВЕСЬ скелет, включая твисты и служебные').toBeGreaterThan(90);
    // Порог — машинная точность, а не «на глаз». До починки здесь было 15.78° и 81.16°.
    expect(worstAng.v, `⚠ кость уехала: ${worstAng.b}`).toBeLessThan(1e-3);
    expect(worstLen.v, `⚠ длина уехала: ${worstLen.b}`).toBeLessThan(1e-3);
  });

  it('⭐ и САМ МЕШ не поехал: каждая вершина там же, где в файле', async () => {
    // Кости — половина правды: меш ведут ВЕСА, и скин мог бы разъехаться при верных костях. Сверяем
    // скиннинг: берём каждую вершину, прогоняем через её кости и сравниваем с тем же в исходном файле.
    const ref = await parseModel(read(SRC), 'fbx'); pose(ref); ref.updateMatrixWorld(true);
    const refMap = autoBoneMap([...boneIndex(ref).keys()]);
    normalizeUpAxis(ref, refMap);

    const g = await parseModel(read(SRC), 'fbx'); pose(g);
    const map = autoBoneMap([...boneIndex(g).keys()]);
    normalizeUpAxis(g, map);
    const boneOffsets = measureBoneOffsets(g, map);
    const loaded = await parseModel(await exportGLB(g), 'glb');
    const source = buildHumanoid({ boneOffsets, fingers: true });
    source.root.updateMatrixWorld(true);
    const k = ourSpan(source) / spanOf(boneIndex(loaded), map);
    makeRetargetRig(loaded, map, k, source).drive(source);
    loaded.updateMatrixWorld(true);

    const skinned = (o: THREE.Object3D): Map<string, THREE.SkinnedMesh> => {
      const m = new Map<string, THREE.SkinnedMesh>();
      o.traverse((c) => { const sm = c as THREE.SkinnedMesh; if (sm.isSkinnedMesh) m.set(sm.name, sm); });
      return m;
    };
    const A = skinned(ref), B = skinned(loaded);
    // Размер модели — чтобы говорить о расхождении В ДОЛЯХ РОСТА, а не в абстрактных единицах.
    const refH = new THREE.Box3().setFromObject(ref); const H = refH.max.y - refH.min.y;
    let worst = 0, worstMesh = '', verts = 0, meshes = 0;
    const va = new THREE.Vector3(), vb = new THREE.Vector3();
    for (const [name, a] of A) {
      const b = B.get(name); if (!b) continue;
      const pa = a.geometry.getAttribute('position'), pb = b.geometry.getAttribute('position');
      if (pa.count !== pb.count) continue;
      meshes++;
      const step = Math.max(1, Math.floor(pa.count / 400));   // выборка: 38 мешей по десяткам тысяч вершин
      for (let i = 0; i < pa.count; i += step) {
        va.fromBufferAttribute(pa, i); a.applyBoneTransform(i, va); va.applyMatrix4(a.matrixWorld);
        vb.fromBufferAttribute(pb, i); b.applyBoneTransform(i, vb); vb.applyMatrix4(b.matrixWorld);
        vb.multiplyScalar(1 / k);                              // привести к единицам файла
        worst = Math.max(worst, va.distanceTo(vb)); verts++;
        if (worst === va.distanceTo(vb)) worstMesh = name;
      }
    }
    console.log(`мешей ${meshes} · вершин ${verts} · МАКС СДВИГ ${(worst / H * 100).toExponential(2)}% роста (${worstMesh})`);
    expect(meshes, 'сверены все части атласа').toBeGreaterThan(30);
    expect(worst / H * 100, '⚠ меш поехал относительно файла').toBeLessThan(1e-3);
  });

  it('ось «вверх» нормализуется ОДИН РАЗ и повторный вызов уже ничего не делает', async () => {
    const g = await parseModel(read(SRC), 'fbx'); pose(g);
    const map = autoBoneMap([...boneIndex(g).keys()]);
    expect(Math.abs(normalizeUpAxis(g, map)), 'файл CC приезжает Z-up — доворот нужен').toBeGreaterThan(1);
    expect(upAxisAngle(g, map), 'после нормализации модель уже Y-up').toBe(0);
    expect(normalizeUpAxis(g, map), 'идемпотентно').toBe(0);
  });

  it('⭐ приведение к T-позе трогает ТОЛЬКО кость, которая реально отклонена (порог Godot 15°)', async () => {
    // Без порога доворот применялся ВСЕГДА — даже на расхождении 0.0001°, и это генератор шума ровно того
    // порядка, на который жалуется автор. Godot ставит порог 15°; проверяем контракт буквально: кость с
    // отклонением НИЖЕ порога обязана остаться нетронутой, ВЫШЕ — доворачивается.
    //
    // Замер по этому файлу: плечо отклонено от оси X на 6°, запястье — на 15.8°. То есть при включённой
    // галке приведения тронется ровно запястье, а плечи — нет. Раньше двигалось и то, и другое.
    const g = await parseModel(read(SRC), 'fbx'); pose(g);
    const map = autoBoneMap([...boneIndex(g).keys()]);
    normalizeUpAxis(g, map);
    const idx = boneIndex(g); g.updateMatrixWorld(true);
    const devOf = (a2: string, b2: string, axis: THREE.Vector3): number => {
      const p1 = idx.get(map[a2] ?? '')!.getWorldPosition(new THREE.Vector3());
      const p2 = idx.get(map[b2] ?? '')!.getWorldPosition(new THREE.Vector3());
      return p2.sub(p1).normalize().angleTo(axis) * D;
    };
    const X = new THREE.Vector3(1, 0, 0);
    const armDev = devOf('LeftUpperArm', 'LeftLowerArm', X), wristDev = devOf('LeftLowerArm', 'LeftHand', X);
    expect(armDev, 'плечо уже почти по оси X').toBeLessThan(TPOSE_THRESHOLD_DEG);
    expect(wristDev, 'запястье отклонено сильнее порога').toBeGreaterThan(TPOSE_THRESHOLD_DEG);

    const snap = new Map<string, THREE.Quaternion>();
    for (const [nm, o] of idx) snap.set(nm, o.quaternion.clone());
    enforceTPose(g, map);
    const moved = (nm: string): number => snap.get(nm)!.angleTo(idx.get(nm)!.quaternion) * D;
    expect(moved(map['LeftUpperArm']!), '⚠ плечо ниже порога — трогать НЕЛЬЗЯ').toBeLessThan(1e-9);
    expect(moved(map['LeftLowerArm']!), 'запястье выше порога — доворачивается').toBeGreaterThan(1);
    // И ключицу не трогаем НИКОГДА: ни одно определение T-позы её не выпрямляет (у VRM «плечи опущены»).
    expect(moved(map['LeftShoulder']!), '⚠ ключица не входит в T-позу').toBeLessThan(1e-9);
  });

  it('замер «T-поза или A-поза» честно говорит, что этот файл в T-позе', async () => {
    const g = await parseModel(read(SRC), 'fbx'); pose(g);
    const map = autoBoneMap([...boneIndex(g).keys()]);
    // Именно на этом числе стоит решение «не трогать позу»: руки лежат почти горизонтально.
    expect(tPoseDeviation(g, map)).toBeLessThan(10);
  });
});
