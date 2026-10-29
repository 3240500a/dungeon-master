import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { parseModel, exportGLB } from './modelAssets.js';
import { autoBoneMap, measureBoneOffsets, normalizeUpAxis, upAxisAngle, tPoseDeviation, enforceTPose, TPOSE_THRESHOLD_DEG, nodeVsBindGap, boneIndex, makeRetargetRig, parentOfOur, OUR_BONES, OUR_FINGERS } from './retarget3d.js';
import { buildHumanoid } from './humanoid.js';
import { LEG_CANON_TOE_MAX_DEG } from './legCanon.js';

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
 *
 * ⚠⚠ И ОДНО НАРОЧНОЕ ИСКЛЮЧЕНИЕ — ЦЕПЬ НОГ (07.10, `legCanon.ts`, «ноги — канон, а не копия бинда модели»).
 * У рыцаря в бинде колено согнуто ~3°, голень внутрь 2.4°, носок наружу 23.6°, а правило «ноль поворотов =
 * поза модели» садило этот развал В КАЖДЫЙ КАДР любого клипа. Решение: ноль поворотов — это ПРЯМЫЕ ноги и
 * НОСОК ВПЕРЁД на любой модели. Значит кости ног ОБЯЗАНЫ разойтись с файлом — ровно на развал его бинда.
 * Поэтому ниже требование раздвоено, и ни одна его половина не ослаблена:
 *   • всё, что НЕ нога, — 1:1 с файлом по-прежнему до машинной точности (замер: 2.8e-5°);
 *   • ДЛИНЫ — 1:1 у ВСЕХ костей, ног в том числе: канон вращает, а не растягивает (замер: 0.0000 %);
 *   • у ног сверяется САМ КАНОН — бедро и голень вертикально, носок вперёд, и правка не больше потолка
 *     самого канона (`LEG_CANON_TOE_MAX_DEG`). Смысл канона — ещё и в `legCanon.test.ts`, `importFidelity`,
 *     эталоне `unity_rig.json` (секция legCanon) и G2 на геометрии рыцаря.
 *
 * ⚠ И МЕТРИКА ИНВАРИАНТНА НЕ ТОЛЬКО К МАСШТАБУ, НО И К ПЕРЕНОСУ. Канон поднимает ТАЗ на прирост прямой
 * ноги (`canonLegOffsets`: «лодыжка в покое остаётся там же»), и это +0.0331 % роста ОДНИМ ПЕРЕНОСОМ —
 * одинаково у шлема, кисти и головы, где ног нет вовсе. Сравнение абсолютных мировых позиций считало
 * посадку модели «меш поехал»; сравниваем от таза.
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

/**
 * ⚠ РЕСТ — ЭТО ПОЗА УЗЛОВ, а не бинд. Раньше здесь стоял `skeleton.pose()` (и в импорте тоже), и
 * замер шёл по позе из `inverseBindMatrices`. У этого файла они РАЗНЫЕ: в узлах стопа под коленом
 * (нога прямая, как в Максе), в бинде отъезжает вбок на 14 единиц, и «вверх» там вообще другая ось.
 * Ничего не делаем — берём файл как есть, ровно как теперь делает импорт.
 */
const pose = (_o: THREE.Object3D): void => { /* позу файла не трогаем */ };

/** Вся ветка под суставами бёдер: голени, стопы, пальцы ног, твисты и служебные кости ног. */
function chainOf(idx: Map<string, THREE.Object3D>, m: Record<string, string>): Set<string> {
  const s = new Set<string>();
  for (const our of ['LeftUpperLeg', 'RightUpperLeg']) {
    const b = idx.get(m[our] ?? '');
    if (b) b.traverse((o) => { if (o.name) s.add(o.name); });
  }
  return s;
}

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
    // ЦЕПЬ НОГ — вся ветка под суставами бёдер (там же твисты, `KneeShareBone`, `ToeBase*` и пальцы ног).
    const legChain = chainOf(refIdx, refMap);
    let worstAng = { b: '', v: 0 }, worstLen = { b: '', v: 0 }, worstLeg = { b: '', v: 0 }, n = 0, nLeg = 0;
    for (const b of all) {
      const r = segAny(refIdx, b), s = segAny(gotIdx, b); if (!r || !s) continue;
      n++;
      const ang = r.dir.angleTo(s.dir) * D, len = Math.abs(s.len / K / r.len - 1) * 100;
      if (len > worstLen.v) worstLen = { b, v: len };             // длины — у ВСЕХ, ног в том числе
      if (legChain.has(b)) { nLeg++; if (ang > worstLeg.v) worstLeg = { b, v: ang }; }
      else if (ang > worstAng.v) worstAng = { b, v: ang };
    }
    console.log(`сверено костей ${n} (ног ${nLeg}) · макс угол ${worstAng.v.toExponential(2)}° (${worstAng.b}) · макс длина ${worstLen.v.toExponential(2)}% (${worstLen.b}) · канон ног ${worstLeg.v.toFixed(3)}° (${worstLeg.b})`);
    expect(n, 'сверяется ВЕСЬ скелет, включая твисты и служебные').toBeGreaterThan(90);
    expect(nLeg, 'цепь ног найдена (иначе исключение прикрыло бы весь скелет)').toBeGreaterThan(10);
    // Порог — машинная точность, а не «на глаз». До починки здесь было 15.78° и 81.16°.
    expect(worstAng.v, `⚠ кость уехала: ${worstAng.b}`).toBeLessThan(1e-3);
    expect(worstLen.v, `⚠ длина уехала: ${worstLen.b}`).toBeLessThan(1e-3);
    // Ноги: правка — это развал бинда, который канон убирает. Больше своего потолка канон не правит.
    expect(worstLeg.v, `⚠ нога уехала БОЛЬШЕ, чем канон вправе править: ${worstLeg.b}`).toBeLessThan(LEG_CANON_TOE_MAX_DEG);
    // И САМ КАНОН, дословно его правилом: бедро и голень вертикально, носок вперёд.
    for (const side of ['Left', 'Right'] as const) {
      const thigh = segAny(gotIdx, map[`${side}LowerLeg`] ?? ''), shin = segAny(gotIdx, map[`${side}Foot`] ?? '');
      const toe = segAny(gotIdx, map[`${side}Toes`] ?? '');
      expect(thigh && shin && toe, `${side}: цепь ноги не собралась`).toBeTruthy();
      expect(-thigh!.dir.y, `${side}: бедро не вертикально`).toBeGreaterThan(1 - 1e-6);
      expect(-shin!.dir.y, `${side}: голень не вертикальна`).toBeGreaterThan(1 - 1e-6);
      expect(Math.abs(toe!.dir.x), `${side}: носок развёрнут в сторону, а не вперёд`).toBeLessThan(1e-3);
    }
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
    // ⚠ ОТ ТАЗА, А НЕ ОТ НАЧАЛА МИРА: канон поднимает таз (прирост прямой ноги), и этот перенос — посадка
    // модели, а не «меш поехал». Замер: ровно +0.0331 % роста у ВСЕХ частей, включая шлемы без единого веса ноги.
    const refIdx = boneIndex(ref), gotIdx = boneIndex(loaded);
    const hipRef = refIdx.get(refMap['Hips'] ?? '')!.getWorldPosition(new THREE.Vector3());
    const shift = gotIdx.get(map['Hips'] ?? '')!.getWorldPosition(new THREE.Vector3()).multiplyScalar(1 / k).sub(hipRef);
    const legChain = chainOf(refIdx, refMap);
    let worst = 0, worstMesh = '', verts = 0, meshes = 0, legWorst = 0, legVerts = 0;
    const va = new THREE.Vector3(), vb = new THREE.Vector3();
    for (const [name, a] of A) {
      const b = B.get(name); if (!b) continue;
      const pa = a.geometry.getAttribute('position'), pb = b.geometry.getAttribute('position');
      if (pa.count !== pb.count) continue;
      meshes++;
      const skI = a.geometry.getAttribute('skinIndex'), skW = a.geometry.getAttribute('skinWeight');
      const step = Math.max(1, Math.floor(pa.count / 400));   // выборка: 38 мешей по десяткам тысяч вершин
      for (let i = 0; i < pa.count; i += step) {
        // Вершину ведёт нога, если на цепь ног есть ХОТЬ КАКОЙ-ТО вес: канон тянет и смеси у бедра.
        let onLeg = false;
        for (let j = 0; j < 4; j++)
          if ((skW.getComponent(i, j) as number) > 1e-6
            && legChain.has(a.skeleton.bones[skI.getComponent(i, j) as number]?.name ?? '')) { onLeg = true; break; }
        va.fromBufferAttribute(pa, i); a.applyBoneTransform(i, va); va.applyMatrix4(a.matrixWorld);
        vb.fromBufferAttribute(pb, i); b.applyBoneTransform(i, vb); vb.applyMatrix4(b.matrixWorld);
        vb.multiplyScalar(1 / k).sub(shift);                   // единицы файла и посадка файла
        const d = va.distanceTo(vb);
        if (onLeg) { legVerts++; legWorst = Math.max(legWorst, d); continue; }
        verts++;
        if (d > worst) { worst = d; worstMesh = name; }
      }
    }
    console.log(`мешей ${meshes} · вершин вне ног ${verts} (на ногах ${legVerts}) · МАКС СДВИГ ${(worst / H * 100).toExponential(2)}% роста (${worstMesh}) · канон ног ${(legWorst / H * 100).toFixed(3)}%`);
    expect(meshes, 'сверены все части атласа').toBeGreaterThan(30);
    // Исключение не вправе съесть проверку: вершин вне ног обязано остаться больше, чем на ногах.
    expect(verts, 'вершин вне ног больше, чем на ногах').toBeGreaterThan(legVerts);
    expect(worst / H * 100, '⚠ меш поехал относительно файла').toBeLessThan(1e-3);
    // Ноги: канон правит скин бедра/голени/носка — на этой модели 4.46 % роста. Больше — уже не канон.
    expect(legWorst / H * 100, '⚠ меш ног уехал БОЛЬШЕ, чем правит канон').toBeLessThan(5);
  });

  it('⭐ файл АВТОРСКИ Y-UP и в идеальной T-позе — приведению тут делать нечего', async () => {
    // Мы годы считали, что CC отдаёт Z-up и A-позу, и чинили это доворотом и приведением. Оказалось,
    // так выглядела только БИНД-поза, в которую мы сами же ставили скелет. Поза узлов (авторская,
    // её показывает Макс) — Y-up и ровная T. ЗАМЕРЫ: доворот оси 0°, отклонение рук от горизонтали
    // 0.04° (было 15.78°). Значит ни нормализация, ни приведение этот файл НЕ ТРОГАЮТ.
    const g = await parseModel(read(SRC), 'fbx');
    const map = autoBoneMap([...boneIndex(g).keys()]);
    expect(upAxisAngle(g, map), 'файл уже Y-up').toBe(0);
    expect(normalizeUpAxis(g, map), 'нормализация ничего не делает').toBe(0);
    expect(tPoseDeviation(g, map), 'руки уже горизонтальны').toBeLessThan(1);

    const idx = boneIndex(g); g.updateMatrixWorld(true);
    const snap = new Map<string, THREE.Quaternion>();
    for (const [nm, o] of idx) snap.set(nm, o.quaternion.clone());
    enforceTPose(g, map);                                 // с дефолтным порогом Godot (15°)
    let worst = 0;
    for (const [nm, o] of idx) worst = Math.max(worst, snap.get(nm)!.angleTo(o.quaternion) * D);
    expect(worst, '⚠ приведение тронуло кость, которая и так стоит верно').toBeLessThan(1e-4);   // 1e-4° — машинный ноль, глазами не существует
    expect(TPOSE_THRESHOLD_DEG).toBe(15);
  });

  it('⭐ бинд-поза этого файла НЕ СОВПАДАЕТ с авторской — и мы это видим, а не угадываем', async () => {
    // Ровно то, что два дня читалось как «риг кривой»: в узлах стопа под коленом (нога прямая),
    // в бинде уезжает вбок. Замер обязан быть заметным, иначе сторож ничего не стережёт.
    const g = await parseModel(read(SRC), 'fbx');
    const gap = nodeVsBindGap(g);
    expect(gap, 'расхождение поз у этого файла велико и должно быть видно').toBeGreaterThan(10);
    // И проверка, что замер НЕ ПОРТИТ модель: после него поза узлов на месте.
    const map = autoBoneMap([...boneIndex(g).keys()]);
    const idx = boneIndex(g); g.updateMatrixWorld(true);
    const foot = idx.get(map['LeftFoot'] ?? '')!.getWorldPosition(new THREE.Vector3());
    const knee = idx.get(map['LeftLowerLeg'] ?? '')!.getWorldPosition(new THREE.Vector3());
    expect(Math.abs(foot.x - knee.x), 'стопа под коленом — нога прямая, как в Максе').toBeLessThan(4);
  });

  it('замер «T-поза или A-поза» честно говорит, что этот файл в T-позе', async () => {
    const g = await parseModel(read(SRC), 'fbx'); pose(g);
    const map = autoBoneMap([...boneIndex(g).keys()]);
    // Именно на этом числе стоит решение «не трогать позу»: руки лежат почти горизонтально.
    expect(tPoseDeviation(g, map)).toBeLessThan(10);
  });
});
