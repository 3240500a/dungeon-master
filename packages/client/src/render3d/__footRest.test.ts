/** ВРЕМЕННЫЙ ЗАМЕР (удаляется): рест-стопа НАШЕГО рига против рест-стопы источника + ошибка стопы в клипе. */
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { autoBoneMap } from './retarget3d.js';
import { openBakeSource, bakeFromSource } from './clipBaker.js';
import { clipPoseAt } from './clipModel.js';
import { buildHumanoid } from './humanoid.js';
import { poseRig } from './frameEdit.js';

const DIR = 'C:/work/Games_Art/Games_Art/top_down/dungeon/Assets/MovementAnimsetPro/Animations';
const D = 180 / Math.PI;
const FILE = 'MovementAnimsetPro.fbx';

/** Рыск (в стороны) и тангаж (носок вверх/вниз) вектора: +yaw = наружу для ЛЕВОЙ (наш канон: Left на +X). */
function yawPitch(v: THREE.Vector3, side: 1 | -1): [number, number] {
  const yaw = Math.atan2(side * v.x, v.z) * D;         // 0 = строго вперёд, + = носок наружу
  const pitch = Math.atan2(v.y, Math.hypot(v.x, v.z)) * D;  // + = носок вверх
  return [yaw, pitch];
}

describe('углы стопы', () => {
  it('замер', async () => {
    (globalThis as unknown as { window?: unknown }).window ??= { innerWidth: 1920, innerHeight: 1080 };
    const buf = readFileSync(path.join(DIR, FILE));
    const warn = console.warn; console.warn = (): void => {};
    const { loadAnimatedModelFile, skeletonBoneNames } = await import('./modelAssets.js');
    const raw = await loadAnimatedModelFile(new File([buf as unknown as BlobPart], FILE));
    const names = skeletonBoneNames(raw.root);
    const map = autoBoneMap(names);
    const byName = new Map<string, THREE.Object3D>();
    raw.root.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
    console.warn = warn;

    console.log('карта ноги:', ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes', 'RightFoot', 'RightToes']
      .map((k) => `${k}→${map[k] ?? '—'}`).join('  '));

    // ── 1. РЕСТ ИСТОЧНИКА (как он лежит в файле, БЕЗ enforceTPose) ──
    raw.root.updateMatrixWorld(true);
    const sdir = (a: string, b: string): THREE.Vector3 | null => {
      const A = byName.get(map[a] ?? ''), B = byName.get(map[b] ?? '');
      if (!A || !B) return null;
      return B.getWorldPosition(new THREE.Vector3()).sub(A.getWorldPosition(new THREE.Vector3())).normalize();
    };
    console.log('\n=== РЕСТ ИСТОЧНИКА (файл как есть) ===');
    for (const [s, side] of [['Left', 1], ['Right', -1]] as [string, 1 | -1][]) {
      const f = sdir(s + 'Foot', s + 'Toes'); const sh = sdir(s + 'LowerLeg', s + 'Foot');
      if (f) { const [y, p] = yawPitch(f, side); console.log(`  ${s}: стопа(лодыжка→носок) рыск ${y.toFixed(1).padStart(6)}° (+ наружу), тангаж ${p.toFixed(1).padStart(6)}° (+ носок вверх)`); }
      if (sh) { const [y, p] = yawPitch(sh, side); console.log(`  ${s}: голень(колено→лодыжка) рыск ${y.toFixed(1).padStart(6)}°, тангаж ${p.toFixed(1).padStart(6)}°`); }
    }

    // ── 2. РЕСТ НАШЕГО КАНОН-РИГА ──
    const H0 = buildHumanoid({}); H0.reset(); H0.root.updateMatrixWorld(true);
    const odir = (h: ReturnType<typeof buildHumanoid>, a: string, b: string): THREE.Vector3 | null => {
      const A = h.bones.get(a), B = h.bones.get(b);
      if (!A || !B) return null;
      return B.getWorldPosition(new THREE.Vector3()).sub(A.getWorldPosition(new THREE.Vector3())).normalize();
    };
    console.log('\n=== РЕСТ НАШЕГО РИГА (buildHumanoid({}), reset) ===');
    for (const [s, side] of [['Left', 1], ['Right', -1]] as [string, 1 | -1][]) {
      const f = odir(H0, s + 'Foot', s + 'Toes'); const sh = odir(H0, s + 'LowerLeg', s + 'Foot');
      if (f) { const [y, p] = yawPitch(f, side); console.log(`  ${s}: стопа рыск ${y.toFixed(1).padStart(6)}°, тангаж ${p.toFixed(1).padStart(6)}°`); }
      if (sh) { const [y, p] = yawPitch(sh, side); console.log(`  ${s}: голень рыск ${y.toFixed(1).padStart(6)}°, тангаж ${p.toFixed(1).padStart(6)}°`); }
    }
    console.log(`  legAdduct=${H0.legAdduct} legAdductKnee=${H0.legAdductKnee} footLift=${H0.footLift} ankleRest=${String(H0.ankleRest)}`);

    // ── 3. РЕСТ ИСТОЧНИКА ПОСЛЕ enforceTPose (его снимает openBakeSource) ──
    const src = await openBakeSource(new File([buf as unknown as BlobPart], FILE));
    const sb = new Map<string, THREE.Object3D>();
    src.loaded.traverse((o) => { if (o.name && !sb.has(o.name)) sb.set(o.name, o); });
    src.loaded.updateMatrixWorld(true);
    console.log('\n=== РЕСТ ИСТОЧНИКА ПОСЛЕ enforceTPose (по нему снимается restW) ===');
    for (const [s, side] of [['Left', 1], ['Right', -1]] as [string, 1 | -1][]) {
      const A = sb.get(map[s + 'Foot'] ?? ''), B = sb.get(map[s + 'Toes'] ?? '');
      const C = sb.get(map[s + 'LowerLeg'] ?? '');
      if (A && B) { const [y, p] = yawPitch(B.getWorldPosition(new THREE.Vector3()).sub(A.getWorldPosition(new THREE.Vector3())).normalize(), side); console.log(`  ${s}: стопа рыск ${y.toFixed(1).padStart(6)}°, тангаж ${p.toFixed(1).padStart(6)}°`); }
      if (C && A) { const [y, p] = yawPitch(A.getWorldPosition(new THREE.Vector3()).sub(C.getWorldPosition(new THREE.Vector3())).normalize(), side); console.log(`  ${s}: голень рыск ${y.toFixed(1).padStart(6)}°, тангаж ${p.toFixed(1).padStart(6)}°`); }
    }

    // ── 4. КЛИП: стопа в кадре, источник против нашего ──
    for (const TAKE of ['WalkFwdLoop', 'RunFwdLoop']) {
      const i0 = src.animations.findIndex((a) => a.name === TAKE);
      const rawClip = raw.animations.find((a) => a.name === TAKE)!;
      src.restore();
      const clip = bakeFromSource(src, {
        character: 'mocap', weapon: 'none', animationIndex: i0, name: TAKE, loop: true,
        locoSet: true, anchorIdle: false, fps: 60, epsDeg: 3, hips: 'full', ground: false, head: 'mocap',
        limbLock: { LF: false, RF: false }, rootYaw: false, yawFromFeet: false, rootPos: false,
      }).clip;
      const mixer = new THREE.AnimationMixer(raw.root);
      const act = mixer.clipAction(rawClip); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.play();
      const h = buildHumanoid({});
      console.log(`\n=== ${TAKE}: рыск/тангаж стопы (лодыжка→носок) В СИСТЕМЕ ТАЗА ===`);
      console.log('  фаза |    ЛЕВАЯ ист рыск/танг |    ЛЕВАЯ наш рыск/танг |   ПРАВАЯ ист |   ПРАВАЯ наш');
      const acc = { ly: 0, lp: 0, ry: 0, rp: 0 };
      const N = 8;
      for (let i = 0; i < N; i++) {
        const t01 = i / N;
        mixer.setTime(t01 * rawClip.duration); raw.root.updateMatrixWorld(true);
        const sHip = byName.get(map['Hips']!)!.getWorldQuaternion(new THREE.Quaternion()).invert();
        poseRig(h, clipPoseAt(clip, t01)); h.root.updateMatrixWorld(true);
        const oHip = h.bones.get('Hips')!.getWorldQuaternion(new THREE.Quaternion()).invert();
        const out: string[] = [];
        for (const [s, side] of [['Left', 1], ['Right', -1]] as [string, 1 | -1][]) {
          const sv = sdir(s + 'Foot', s + 'Toes')!.clone().applyQuaternion(sHip);
          const ov = odir(h, s + 'Foot', s + 'Toes')!.clone().applyQuaternion(oHip);
          const [sy, sp] = yawPitch(sv, side); const [oy, op] = yawPitch(ov, side);
          out.push(`${sy.toFixed(1).padStart(6)}/${sp.toFixed(1).padStart(6)}`, `${oy.toFixed(1).padStart(6)}/${op.toFixed(1).padStart(6)}`);
          if (s === 'Left') { acc.ly = Math.max(acc.ly, Math.abs(oy - sy)); acc.lp = Math.max(acc.lp, Math.abs(op - sp)); }
          else { acc.ry = Math.max(acc.ry, Math.abs(oy - sy)); acc.rp = Math.max(acc.rp, Math.abs(op - sp)); }
        }
        console.log(`  ${t01.toFixed(2)} | ${out.join(' | ')}`);
      }
      console.log(`  МАКС расхождение: ЛЕВАЯ рыск ${acc.ly.toFixed(1)}° тангаж ${acc.lp.toFixed(1)}°   ПРАВАЯ рыск ${acc.ry.toFixed(1)}° тангаж ${acc.rp.toFixed(1)}°`);
    }
  }, 300000);
});
