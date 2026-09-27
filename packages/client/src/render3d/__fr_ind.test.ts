/** ВРЕМЕННЫЙ ЗАМЕР (удаляется): «как это делает индустрия» — эмуляция правила Unity Enforce T-Pose на стопах
 *  Kubold + критерий «разворот в бинде против разворота в движении» (ось стопы по МЕШУ, угол прогрессии стопы). */
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { autoBoneMap, TPOSE_THRESHOLD_DEG } from './retarget3d.js';
import { buildHumanoid } from './humanoid.js';

const DIR = 'C:/work/Games_Art/Games_Art/top_down/dungeon/Assets/MovementAnimsetPro/Animations';
const FILE = 'MovementAnimsetPro.fbx';
const D = 180 / Math.PI;
const f2 = (x: number): string => x.toFixed(1).padStart(7);

function yawPitch(v: THREE.Vector3, outSign: number): [number, number] {
  return [Math.atan2(outSign * v.x, v.z) * D, Math.atan2(v.y, Math.hypot(v.x, v.z)) * D];
}
/** Unity MakeBoneAlignmentValid: доля доворота = clamp01(1.05 − maxAngle/delta). */
function unityAdjust(deltaDeg: number, maxAngle: number): { fires: boolean; amount: number; residual: number } {
  const fires = deltaDeg > maxAngle * 0.99;
  const amount = fires ? Math.min(1, Math.max(0, 1.05 - maxAngle / deltaDeg)) : 0;
  return { fires, amount, residual: deltaDeg * (1 - amount) };
}

describe('индустрия: стопа', () => {
  it('замер', async () => {
    (globalThis as unknown as { window?: unknown }).window ??= { innerWidth: 1920, innerHeight: 1080 };
    const buf = readFileSync(path.join(DIR, FILE));
    const warn = console.warn; console.warn = (): void => {};
    const { loadAnimatedModelFile, skeletonBoneNames } = await import('./modelAssets.js');
    const raw = await loadAnimatedModelFile(new File([buf as unknown as BlobPart], FILE));
    const map = autoBoneMap(skeletonBoneNames(raw.root));
    console.warn = warn;
    const byName = new Map<string, THREE.Object3D>();
    raw.root.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
    raw.root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.pose(); });
    raw.root.updateMatrixWorld(true);

    const bone = (our: string): THREE.Object3D | undefined => byName.get(map[our] ?? '');
    const wp = (our: string): THREE.Vector3 | null => { const b = bone(our); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
    const dir = (a: string, b: string): THREE.Vector3 | null => {
      const A = wp(a), B = wp(b); return A && B ? B.sub(A).normalize() : null;
    };

    // Какая ось «влево» у ИСТОЧНИКА и у НАС (наружу = +для левой по этой оси)
    const srcLeftX = wp('LeftUpperLeg')!.x - wp('Hips')!.x;
    const H0 = buildHumanoid({}); H0.reset(); H0.root.updateMatrixWorld(true);
    const ourLeftX = H0.bones.get('LeftUpperLeg')!.getWorldPosition(new THREE.Vector3()).x
      - H0.bones.get('Hips')!.getWorldPosition(new THREE.Vector3()).x;
    console.log(`ось «влево»: источник x=${srcLeftX.toFixed(2)} (Left на ${srcLeftX > 0 ? '+X' : '-X'}), наш риг x=${ourLeftX.toFixed(2)} (Left на ${ourLeftX > 0 ? '+X' : '-X'})`);
    const sOut = (s: string): number => (s === 'Left' ? Math.sign(srcLeftX) : -Math.sign(srcLeftX));
    const oOut = (s: string): number => (s === 'Left' ? Math.sign(ourLeftX) : -Math.sign(ourLeftX));

    // ───── 1. РЕСТ ИСТОЧНИКА: направление кости стопы (лодыжка→носок) ─────
    console.log('\n=== 1. РЕСТ ИСТОЧНИКА (файл как есть, skeleton.pose()) ===');
    const restSrc: Record<string, { v: THREE.Vector3; yaw: number; pitch: number }> = {};
    for (const s of ['Left', 'Right']) {
      const v = dir(s + 'Foot', s + 'Toes')!;
      const [y, p] = yawPitch(v, sOut(s));
      restSrc[s] = { v: v.clone(), yaw: y, pitch: p };
      console.log(`  ${s.padEnd(5)}: кость стопы рыск ${f2(y)}° (+наружу)  тангаж ${f2(p)}° (+носок вверх)`);
    }
    const restOur: Record<string, { v: THREE.Vector3; yaw: number; pitch: number }> = {};
    for (const s of ['Left', 'Right']) {
      const A = H0.bones.get(s + 'Foot')!.getWorldPosition(new THREE.Vector3());
      const B = H0.bones.get(s + 'Toes')!.getWorldPosition(new THREE.Vector3());
      const v = B.sub(A).normalize(); const [y, p] = yawPitch(v, oOut(s));
      restOur[s] = { v, yaw: y, pitch: p };
      console.log(`  НАШ ${s.padEnd(5)}: кость стопы рыск ${f2(y)}°  тангаж ${f2(p)}°  (лодыжка y=${A.clone().add(v).y.toFixed(2)}…) `);
    }
    {
      const a = H0.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3());
      const b = H0.bones.get('LeftToes')!.getWorldPosition(new THREE.Vector3());
      const sa = wp('LeftFoot')!, sb = wp('LeftToes')!;
      console.log(`  ГЕОМЕТРИЯ: НАШ лодыжка y=${a.y.toFixed(2)} носок y=${b.y.toFixed(2)} (лодыжка выше носка на ${(a.y - b.y).toFixed(2)} u, длина ${a.distanceTo(b).toFixed(2)} u)`);
      console.log(`  ГЕОМЕТРИЯ: ИСТОЧНИК лодыжка y=${sa.y.toFixed(2)} носок y=${sb.y.toFixed(2)} (лодыжка выше носка на ${(sa.y - sb.y).toFixed(2)} u, длина ${sa.distanceTo(sb).toFixed(2)} u)`);
    }

    // ───── 2. ПРАВИЛО UNITY против НАШЕГО на этих же числах ─────
    console.log('\n=== 2. Enforce T-Pose: правило Unity (рыск-только, maxAngle 20, доворот частичный) против нашего (полный 3D, порог 15) ===');
    const UNITY_GOAL_YAW = Math.atan2(0.05, 1) * D;   // sBonePoses[LeftFoot].direction = (-0.05,0,1) → 2.86° наружу
    for (const s of ['Left', 'Right']) {
      // Unity: dir проецируется на плоскость planeNormal=up → сравнивается ТОЛЬКО рыск
      const dYaw = Math.abs(restSrc[s]!.yaw - UNITY_GOAL_YAW);
      const u = unityAdjust(dYaw, 20);
      // Наш: полный угол между 3D-направлениями (рыск+тангаж), доворот ПОЛНЫЙ
      const ang = restSrc[s]!.v.angleTo(new THREE.Vector3(
        restOur[s]!.v.x * Math.sign(srcLeftX) * Math.sign(ourLeftX), restOur[s]!.v.y, restOur[s]!.v.z)) * D;
      console.log(`  ${s.padEnd(5)}: UNITY Δрыск=${f2(dYaw)}° (цель ${UNITY_GOAL_YAW.toFixed(1)}°, порог ${(20 * 0.99).toFixed(1)}°) → ${u.fires ? `срабатывает, доля ${u.amount.toFixed(3)}, остаток ${u.residual.toFixed(1)}°` : 'НЕ СРАБАТЫВАЕТ, стопа остаётся как в файле'};  тангаж Unity не смотрит вовсе; носок (Toes) в таблице = null`);
      console.log(`  ${s.padEnd(5)}: НАШ   Δ3D  =${f2(ang)}° (порог ${TPOSE_THRESHOLD_DEG}°) → ${ang > TPOSE_THRESHOLD_DEG ? 'СРАБАТЫВАЕТ, доворот ПОЛНЫЙ → рыск и тангаж стопы переписаны в наш канон' : 'не срабатывает'}`);
    }
    // то же для голени/бедра — Unity их правит, но мировой поворот СТОПЫ восстанавливает
    for (const s of ['Left', 'Right']) {
      const up = dir(s + 'UpperLeg', s + 'LowerLeg')!, lo = dir(s + 'LowerLeg', s + 'Foot')!;
      const gUp = new THREE.Vector3(-0.05 * Math.sign(srcLeftX) * (s === 'Left' ? 1 : -1), -1, 0).normalize();
      const gLo = new THREE.Vector3(-0.05 * Math.sign(srcLeftX) * (s === 'Left' ? 1 : -1), -1, -0.15).normalize();
      console.log(`  ${s.padEnd(5)}: Unity бедро Δ=${f2(up.angleTo(gUp) * D)}° (max 15) ${unityAdjust(up.angleTo(gUp) * D, 15).fires ? 'срабатывает' : 'нет'};  голень Δ=${f2(lo.angleTo(gLo) * D)}° (max 20) ${unityAdjust(lo.angleTo(gLo) * D, 20).fires ? 'срабатывает' : 'нет'}`);
    }

    // ───── 3. ОСЬ СТОПЫ ПО МЕШУ в бинде (кость ≠ ось стопы?) ─────
    console.log('\n=== 3. ОСЬ СТОПЫ ПО МЕШУ (бинд): длинная ось облака вершин стопы+носка в плоскости XZ ===');
    const skins: THREE.SkinnedMesh[] = [];
    raw.root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh) skins.push(sm); });
    console.log(`  скин-мешей в файле: ${skins.length}`);
    for (const s of ['Left', 'Right']) {
      const want = new Set([map[s + 'Foot'], map[s + 'Toes']].filter(Boolean) as string[]);
      const pts: THREE.Vector3[] = [];
      for (const sm of skins) {
        const g = sm.geometry; const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
        if (!pos || !si || !sw) continue;
        const names = sm.skeleton.bones.map((b) => b.name);
        for (let i = 0; i < pos.count; i++) {
          let w = 0;
          for (let k = 0; k < 4; k++) {
            const idx = si.getComponent(i, k) as number, wt = sw.getComponent(i, k) as number;
            if (wt > 0 && want.has(names[idx] ?? '')) w += wt;
          }
          if (w > 0.6) pts.push(new THREE.Vector3().fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(sm.matrixWorld));
        }
      }
      if (pts.length < 20) { console.log(`  ${s}: вершин стопы ${pts.length} — меша нет/мало, ось по мешу не измерить`); continue; }
      // ось стопы по мешу = (самая передняя точка носка) − (центр пятки), в бинде
      const ankle = wp(s + 'Foot')!, toe = wp(s + 'Toes')!;
      const fwd = new THREE.Vector3(0, 0, 1);
      let tip = pts[0]!, heel = pts[0]!;
      for (const p of pts) { if (p.dot(fwd) > tip.dot(fwd)) tip = p; if (p.dot(fwd) < heel.dot(fwd)) heel = p; }
      const axMesh = tip.clone().sub(heel);
      const [ym] = yawPitch(axMesh.clone().normalize(), sOut(s));
      const yTip = tip.y, loY = Math.min(...pts.map((p) => p.y)), hiY = Math.max(...pts.map((p) => p.y));
      console.log(`  ${s.padEnd(5)}: вершин ${pts.length}; пятка→носок по МЕШУ рыск ${f2(ym)}° (+наружу)  ← кость ${f2(restSrc[s]!.yaw)}°  РАЗНИЦА ${f2(ym - restSrc[s]!.yaw)}°`);
      console.log(`  ${s.padEnd(5)}: высоты в бинде (u): низ меша ${loY.toFixed(2)}  верх ${hiY.toFixed(2)}  лодыжка ${ankle.y.toFixed(2)}  носок(кость) ${toe.y.toFixed(2)}  кончик меша ${yTip.toFixed(2)}  → лодыжка над носком на ${(ankle.y - toe.y).toFixed(2)} u`);
    }

    // ───── 4. ДВИЖЕНИЕ: абсолютный угол стопы против дельты от собственного реста ─────
    for (const TAKE of ['WalkFwdLoop', 'RunFwdLoop']) {
      const clip = raw.animations.find((a) => a.name === TAKE);
      if (!clip) { console.log(`\n(нет тейка ${TAKE})`); continue; }
      const mixer = new THREE.AnimationMixer(raw.root);
      const act = mixer.clipAction(clip); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.play();
      const N = 60;
      const rows: Record<string, { yaw: number[]; pitch: number[]; y: number[] }> = {
        Left: { yaw: [], pitch: [], y: [] }, Right: { yaw: [], pitch: [], y: [] },
      };
      for (let i = 0; i < N; i++) {
        mixer.setTime((i / N) * clip.duration); raw.root.updateMatrixWorld(true);
        const hipQ = bone('Hips')!.getWorldQuaternion(new THREE.Quaternion()).invert();
        for (const s of ['Left', 'Right']) {
          const v = dir(s + 'Foot', s + 'Toes')!.applyQuaternion(hipQ);
          const [y, p] = yawPitch(v, sOut(s));
          rows[s]!.yaw.push(y); rows[s]!.pitch.push(p); rows[s]!.y.push(wp(s + 'Foot')!.y);
        }
      }
      // рест в системе таза (таз в ресте)
      raw.root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.pose(); });
      mixer.stopAllAction();
      console.log(`\n=== 4. ${TAKE}: угол стопы в системе таза, ${N} кадров ===`);
      for (const s of ['Left', 'Right']) {
        const r = rows[s]!;
        const mean = (a: number[]): number => a.reduce((x, y2) => x + y2, 0) / a.length;
        // опорная фаза = 40% кадров с самой низкой лодыжкой
        const order = r.y.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
        const stance = order.slice(0, Math.round(N * 0.4)).map(([, i]) => i);
        const sy = stance.map((i) => r.yaw[i]!), sp = stance.map((i) => r.pitch[i]!);
        console.log(`  ${s.padEnd(5)} АБСОЛЮТНЫЙ: рыск ср ${f2(mean(r.yaw))}° [${f2(Math.min(...r.yaw))}..${f2(Math.max(...r.yaw))}]  тангаж ср ${f2(mean(r.pitch))}° [${f2(Math.min(...r.pitch))}..${f2(Math.max(...r.pitch))}]`);
        console.log(`  ${s.padEnd(5)} ОПОРНАЯ ФАЗА (низ 40% по лодыжке): рыск ср ${f2(mean(sy))}°   тангаж ср ${f2(mean(sp))}°`);
        console.log(`  ${s.padEnd(5)} ДЕЛЬТА ОТ СВОЕГО РЕСТА: рыск ср ${f2(mean(sy) - restSrc[s]!.yaw)}°   тангаж ср ${f2(mean(sp) - restSrc[s]!.pitch)}°`);
      }
      const asymAbs = Math.abs(
        (rows['Left']!.yaw.reduce((a, b) => a + b, 0) / N) - (rows['Right']!.yaw.reduce((a, b) => a + b, 0) / N));
      console.log(`  АСИММЕТРИЯ Л−П: абсолютный рыск ${f2(asymAbs)}°   рест кости ${f2(restSrc['Left']!.yaw - restSrc['Right']!.yaw)}°`);
    }
  }, 300000);
});
