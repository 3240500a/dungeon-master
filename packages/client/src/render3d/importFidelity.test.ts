import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { autoBoneMap, enforceTPose, measureBoneOffsets, measureBoneScales, makeRetargetRig } from './retarget3d.js';
import { buildHumanoid } from './humanoid.js';
import { dedupeSkeletons } from './skeletonDedupe.js';
import { lowestSkinY, measureFootLift } from './footIk.js';
import { FOOT_Y } from './pose.js';
import MODELS from '@dm/shared/config/data/models.json' with { type: 'json' };

/**
 * ИМПОРТ НЕ ИМЕЕТ ПРАВА МЕНЯТЬ МОДЕЛЬ.
 *
 * Вопрос автора: «сделал скрин из макса — ноги вместе, пальцы выпрямлены; посмотри, когда он
 * заезжает к нам, там всё так же?». Отвечать на такое надо числом, а не «должно быть так же»,
 * поэтому здесь настоящий ассет прогоняется через настоящий импорт и сверяется с самим собой.
 *
 * Что проверяется:
 *  1) наш риг ПОВТОРЯЕТ бинд модели — бедро, голень, рука, фаланга (допуск 0.3°);
 *  2) `enforceTPose` не трогает НИЧЕГО, кроме рук (по умолчанию `AIM_CHILD` — только они);
 *  3) замеры, лежащие в конфиге, СОВПАДАЮТ с замерами живого файла.
 *
 * ⚠ Пункт 3 — про грабли, а не про код: геометрия рига берётся из `boneOffsets`, СОХРАНЁННЫХ
 * В КОНФИГ при импорте, а не меряется с GLB на каждой загрузке. Перезалил модель, но не
 * переимпортировал во вкладке «Модели» — редактор и игра продолжают строить скелет по старым
 * числам, и это выглядит как «модель приехала другой». Тест это ловит.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const GLB = join(HERE, '../../../server/assets/knight_05_modular_rig.glb');
const DEG = 180 / Math.PI;
const ENTRY = (MODELS as { id: string; url?: string; boneOffsets?: Record<string, [number, number, number]> }[])
  .find((m) => m.id === 'knight_05_modular_rig');

function load(): Promise<THREE.Group> {
  const buf = readFileSync(GLB);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new Promise((res, rej) => new GLTFLoader().parse(ab, '', (g) => res(g.scene as unknown as THREE.Group), rej));
}
/** Угол между направлениями двух звеньев, градусы. */
const between = (a: THREE.Vector3, b: THREE.Vector3): number => Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * DEG;

describe.runIf(existsSync(GLB))('импорт рыцаря повторяет модель', () => {
  it('⭐ риг встаёт в бинд модели: бедро, голень, рука и фаланга — с точностью до 0.3°', async () => {
    const root = await load();
    dedupeSkeletons(root);                                  // CC-экспорт даёт 38 копий скелета — как в рантайме
    root.updateMatrixWorld(true);
    const names: string[] = [];
    root.traverse((o) => { if ((o as THREE.Bone).isBone) names.push(o.name); });
    const map = autoBoneMap(names);
    const by = new Map<string, THREE.Object3D>();
    root.traverse((o) => { if (!by.has(o.name)) by.set(o.name, o); });
    const wp = (our: string): THREE.Vector3 => by.get(map[our] ?? '')!.getWorldPosition(new THREE.Vector3());
    const dir = (a: string, b: string): THREE.Vector3 => wp(b).clone().sub(wp(a)).normalize();

    // Файл Z-up: тот же доворот, что делает импорт (`detectUpFixX`), иначе «вертикаль» не вертикаль.
    const hip = wp('Hips'), head = wp('Head');
    const ax = Math.abs(head.z - hip.z) > Math.abs(head.y - hip.y) ? (head.z - hip.z > 0 ? -Math.PI / 2 : Math.PI / 2) : (head.y - hip.y < 0 ? Math.PI : 0);
    root.rotation.set(ax, 0, 0); root.updateMatrixWorld(true);
    // БИНД: кости по inverseBindMatrices — именно её меряет импорт, а не позу нод.
    root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.pose(); });
    root.updateMatrixWorld(true);

    const legBefore = between(dir('LeftUpperLeg', 'LeftLowerLeg'), new THREE.Vector3(0, -1, 0));
    enforceTPose(root, map);
    root.updateMatrixWorld(true);
    const src = {
      thigh: between(dir('LeftUpperLeg', 'LeftLowerLeg'), new THREE.Vector3(0, -1, 0)),
      shin: between(dir('LeftLowerLeg', 'LeftFoot'), new THREE.Vector3(0, -1, 0)),
      arm: between(dir('LeftUpperArm', 'LeftLowerArm'), new THREE.Vector3(1, 0, 0)),
      finger: between(dir('LeftIndexProximal', 'LeftIndexIntermediate'), dir('LeftHand', 'LeftIndexProximal')),
    };
    // enforceTPose по умолчанию целит ТОЛЬКО руки — ноги обязаны остаться как в файле.
    expect(src.thigh, 'enforceTPose не имеет права трогать ноги').toBeCloseTo(legBefore, 3);
    expect(src.arm, 'а руку — обязан поставить горизонтально').toBeLessThan(0.5);

    const h = buildHumanoid({ boneOffsets: measureBoneOffsets(root, map), boneScale: measureBoneScales(root, map), fingers: true });
    h.root.updateMatrixWorld(true);
    const hw = (n: string): THREE.Vector3 => h.bones.get(n)!.getWorldPosition(new THREE.Vector3());
    const hdir = (a: string, b: string): THREE.Vector3 => hw(b).clone().sub(hw(a)).normalize();
    const our = {
      thigh: between(hdir('LeftUpperLeg', 'LeftLowerLeg'), new THREE.Vector3(0, -1, 0)),
      shin: between(hdir('LeftLowerLeg', 'LeftFoot'), new THREE.Vector3(0, -1, 0)),
      arm: between(hdir('LeftUpperArm', 'LeftLowerArm'), new THREE.Vector3(1, 0, 0)),
      finger: between(hdir('LeftIndexProximal', 'LeftIndexIntermediate'), hdir('LeftHand', 'LeftIndexProximal')),
    };
    for (const k of ['thigh', 'shin', 'arm', 'finger'] as const) {
      expect(our[k], `${k}: наш риг обязан повторить модель (модель ${src[k].toFixed(2)}°)`).toBeCloseTo(src[k], 0.3);
    }
    // Свести замер к одному месту: приведение ног считается ИЗ МОДЕЛИ, а не назначено нами.
    expect(h.legAdduct * DEG, 'legAdduct = splay бедра САМОЙ МОДЕЛИ').toBeCloseTo(src.thigh, 1);
  });

  it('⭐ ПОДОШВА САМА ВСТАЁТ НА ПОЛ: высота таза берётся от корня арматуры', () => {
    // Жалоба: «в максе он идеально заземлён, а у нас с ногами под землёй». Так и было: высоту таза
    // подгоняли под лодыжку НАШЕГО базового рига (1.01), а у рыцаря лодыжка обязана стоять на 2.91 —
    // меш тонул ровно на эти 1.9. Теперь высота берётся из модели: корень арматуры стоит на полу,
    // значит «таз − корень» и есть высота таза. Никаких подгонок, ничего подкручивать не надо.
    return (async (): Promise<void> => {
      const root = await load();
      dedupeSkeletons(root);
      const names: string[] = [];
      root.traverse((o) => { if ((o as THREE.Bone).isBone) names.push(o.name); });
      const map = autoBoneMap(names);
      const by = new Map<string, THREE.Object3D>();
      root.traverse((o) => { if (!by.has(o.name)) by.set(o.name, o); });
      const wp = (n: string): THREE.Vector3 => by.get(map[n] ?? '')!.getWorldPosition(new THREE.Vector3());
      root.updateMatrixWorld(true);
      const hip = wp('Hips'), head = wp('Head');
      const ax = Math.abs(head.z - hip.z) > Math.abs(head.y - hip.y) ? (head.z - hip.z > 0 ? -Math.PI / 2 : Math.PI / 2) : (head.y - hip.y < 0 ? Math.PI : 0);
      root.rotation.set(ax, 0, 0);
      root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.pose(); });
      root.updateMatrixWorld(true);
      const off = measureBoneOffsets(root, map), bs = measureBoneScales(root, map);
      // Нормируем модель тем же множителем, что и замер офсетов (базовый размах / рост модели).
      const base0 = buildHumanoid({});
      const span = base0.bones.get('Head')!.getWorldPosition(new THREE.Vector3()).y - base0.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()).y;
      root.scale.setScalar(span / (wp('Head').y - wp('LeftFoot').y));
      root.updateMatrixWorld(true);
      const meshes: THREE.SkinnedMesh[] = [];
      root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
      const footBones = new Set(['LeftFoot', 'RightFoot', 'LeftToes', 'RightToes'].map((n) => map[n]).filter(Boolean));
      const sole = lowestSkinY(meshes, (b) => footBones.has(b.name));
      expect(sole, 'подошву обязаны найти по вершинам').not.toBeNull();
      const soleBelowAnkle = wp('LeftFoot').y - sole!;
      expect(soleBelowAnkle, 'у рыцаря толстые сабатоны — подошва далеко под лодыжкой').toBeCloseTo(2.90, 1);

      const h = buildHumanoid({ boneOffsets: off, boneScale: bs, fingers: true });
      h.root.updateMatrixWorld(true);
      const ourAnkle = h.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()).y;
      expect(ourAnkle, 'лодыжка встаёт на ту же высоту, что и в модели').toBeCloseTo(soleBelowAnkle, 1);
      expect(Math.abs(ourAnkle - soleBelowAnkle), '⭐ подошва НА ПОЛУ — без подъёмов и подкруток').toBeLessThan(0.1);

      // Заземление в рантайме целит лодыжку в `SOLE + footLift`. Оно обязано СОГЛАСОВЫВАТЬСЯ с ригом,
      // а не спорить с ним: цель — та же высота лодыжки, что у самой модели.
      const lift = measureFootLift(h, ourAnkle - soleBelowAnkle);
      expect(lift, 'подъём обязан замериться').not.toBeNull();
      expect(FOOT_Y + lift!, 'цель заземления = высота лодыжки модели').toBeCloseTo(soleBelowAnkle, 2);
    })();
  });

  it('⚠ ЗАМЕР ПОДОШВЫ ЗАВИСИТ ОТ ПОЗЫ — поэтому мерить его можно ТОЛЬКО в покое', async () => {
    // Жалоба «ноги над полом» с офсетом 2.15 в панели при геометрии 1.34. Разница — ровно поза:
    // вершины стопы едут за костью, и замер «лодыжка минус подошва» вместе с ними.
    const root = await load();
    dedupeSkeletons(root);
    const names: string[] = [];
    root.traverse((o) => { if ((o as THREE.Bone).isBone) names.push(o.name); });
    const map = autoBoneMap(names);
    const by = new Map<string, THREE.Object3D>();
    root.traverse((o) => { if (!by.has(o.name)) by.set(o.name, o); });
    const wp = (n: string): THREE.Vector3 => by.get(map[n] ?? '')!.getWorldPosition(new THREE.Vector3());
    root.updateMatrixWorld(true);
    const hip = wp('Hips'), head = wp('Head');
    const ax = Math.abs(head.z - hip.z) > Math.abs(head.y - hip.y) ? (head.z - hip.z > 0 ? -Math.PI / 2 : Math.PI / 2) : (head.y - hip.y < 0 ? Math.PI : 0);
    root.rotation.set(ax, 0, 0);
    root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.pose(); });
    root.updateMatrixWorld(true);
    const source = buildHumanoid({ boneOffsets: measureBoneOffsets(root, map), boneScale: measureBoneScales(root, map), fingers: true });
    const bb = new THREE.Box3(); root.traverse((o) => { if ((o as THREE.Bone).isBone) bb.expandByPoint(o.getWorldPosition(new THREE.Vector3())); });
    const sb = new THREE.Box3(); for (const b of source.bones.values()) sb.expandByPoint(b.getWorldPosition(new THREE.Vector3()));
    const rig = makeRetargetRig(root, map, (sb.max.y - sb.min.y) / Math.max(1e-3, bb.max.y - bb.min.y), source);
    const meshes: THREE.SkinnedMesh[] = [];
    root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
    const footBones = new Set(['LeftFoot', 'RightFoot', 'LeftToes', 'RightToes'].map((n) => map[n]).filter(Boolean));

    const at = (deg: number): number => {
      for (const n of ['LeftFoot', 'RightFoot']) source.bones.get(n)!.rotation.x = deg * Math.PI / 180;
      source.root.updateMatrixWorld(true);
      rig.drive(source);
      root.updateMatrixWorld(true);
      return measureFootLift(source, lowestSkinY(meshes, (b) => footBones.has(b.name))!)!;
    };
    const rest = at(0);
    expect(rest, 'в покое замер = геометрия модели').toBeCloseTo(1.34, 1);
    expect(at(10) - rest, '⚠ 10° носком вниз — и замер уехал больше чем на юнит').toBeGreaterThan(1);
    expect(at(20) - rest, 'на 20° — больше двух').toBeGreaterThan(2);
    at(0);
  });

  it('⚠ замеры в конфиге не отстали от файла (перезалил GLB — переимпортируй)', async () => {
    expect(ENTRY, 'запись рыцаря должна быть в models.json').toBeTruthy();
    const stored = ENTRY!.boneOffsets ?? {};
    expect(Object.keys(stored).length, 'офсеты должны быть замерены').toBeGreaterThan(20);
    const root = await load();
    dedupeSkeletons(root);
    const names: string[] = [];
    root.traverse((o) => { if ((o as THREE.Bone).isBone) names.push(o.name); });
    const map = autoBoneMap(names);
    root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.pose(); });
    enforceTPose(root, map);
    const fresh = measureBoneOffsets(root, map);
    const bad: string[] = [];
    for (const k of Object.keys(stored)) {
      const a = stored[k]!, b = fresh[k];
      if (!b) { bad.push(`${k}: в файле нет`); continue; }
      for (let i = 0; i < 3; i++) if (Math.abs(a[i]! - b[i]!) > 0.02) { bad.push(`${k}: конфиг ${a.join()} ≠ файл ${b.map((v) => +v.toFixed(2)).join()}`); break; }
    }
    expect(bad.slice(0, 6).join(' | '),
      'геометрия рига берётся из конфига, а не из GLB: расхождение = модель обновили, а импорт не переделали').toBe('');
  });
});
