/**
 * ВРЕМЕННЫЙ ЗОНД (удаляется): ЦЕНА ПРАВКИ «убрать стопы/ноги из FULL_AIM_CHILD».
 * Ничего в исходниках не правит: варианты aim-таблицы собираются здесь и подставляются в enforceTPose.
 */
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import {
  autoBoneMap, enforceTPose, FULL_AIM_CHILD, TPOSE_THRESHOLD_DEG, boneIndex, upAxisAngle,
  tPoseDeviation, makeBakeRig, OUR_BONES, type OurBone,
} from './retarget3d.js';
import { bakeFromSource, type BakeSource } from './clipBaker.js';
import { clipPoseAt } from './clipModel.js';
import { buildHumanoid } from './humanoid.js';
import { poseRig } from './frameEdit.js';
import { MOCAP_SET } from './mocapSetMap.js';

const DIR = 'C:/work/Games_Art/Games_Art/top_down/dungeon/Assets/MovementAnimsetPro/Animations';
const FILE = 'MovementAnimsetPro.fbx';
const D = 180 / Math.PI;

/** КОПИЯ таблицы CANON_DIR из retarget3d.ts (она не экспортирована) — чтобы посчитать ТУ ЖЕ величину, что порог. */
const CANON_DIR: Partial<Record<string, [number, number, number]>> = {
  LeftUpperArm: [1, 0, 0], LeftLowerArm: [1, 0, 0],
  RightUpperArm: [-1, 0, 0], RightLowerArm: [-1, 0, 0],
  LeftUpperLeg: [0, -1, 0], LeftLowerLeg: [0, -1, 0],
  RightUpperLeg: [0, -1, 0], RightLowerLeg: [0, -1, 0],
  Spine: [0, 1, 0], Chest: [0, 1, 0], UpperChest: [0, 1, 0], Neck: [0, 1, 0],
};
/** КОПИЯ AIM_CHILD (атлас; тоже не экспортирована). */
const ATLAS_AIM: Partial<Record<string, string>> = {
  LeftUpperArm: 'LeftLowerArm', LeftLowerArm: 'LeftHand',
  RightUpperArm: 'RightLowerArm', RightLowerArm: 'RightHand',
};

const FEET: (keyof typeof FULL_AIM_CHILD)[] = ['LeftFoot', 'RightFoot'];
const LEGS: (keyof typeof FULL_AIM_CHILD)[] = ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'];
const without = (keys: readonly string[]): Partial<Record<OurBone, OurBone>> => {
  const o: Record<string, string> = { ...(FULL_AIM_CHILD as Record<string, string>) };
  for (const k of keys) delete o[k];
  return o as Partial<Record<OurBone, OurBone>>;
};

function yawPitch(v: THREE.Vector3, side: 1 | -1): [number, number] {
  return [Math.atan2(side * v.x, v.z) * D, Math.atan2(v.y, Math.hypot(v.x, v.z)) * D];
}

let BUF: Buffer | null = null;
const buf = (): Buffer => (BUF ??= readFileSync(path.join(DIR, FILE)));
const mkFile = (name = FILE): File => new File([readFileSync(path.join(DIR, name)) as unknown as BlobPart], name);

async function loadRaw(name = FILE): Promise<{ root: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  (globalThis as unknown as { window?: unknown }).window ??= { innerWidth: 1920, innerHeight: 1080 };
  const warn = console.warn; console.warn = (): void => {};
  const { loadAnimatedModelFile } = await import('./modelAssets.js');
  const r = await loadAnimatedModelFile(mkFile(name));
  console.warn = warn;
  r.root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.pose(); });
  r.root.updateMatrixWorld(true);
  return r;
}

/** ТОТ ЖЕ openBakeSource, но с ЛЮБОЙ aim-таблицей (копия шагов из clipBaker.openBakeSource). */
async function openWithAim(aim: Partial<Record<OurBone, OurBone>> | null, name = FILE): Promise<BakeSource> {
  const { root, animations } = await loadRaw(name);
  const { skeletonBoneNames } = await import('./modelAssets.js');
  const map = autoBoneMap(skeletonBoneNames(root));
  const byName = new Map<string, THREE.Object3D>();
  root.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o); });
  if (byName.size === 0) root.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
  if (aim) enforceTPose(root, map, aim);
  let loaded: THREE.Object3D = root;
  const hip = byName.get(map['Hips'] ?? ''), head = byName.get(map['Head'] ?? '');
  if (hip && head) {
    const ph = hip.getWorldPosition(new THREE.Vector3()), pd = head.getWorldPosition(new THREE.Vector3());
    if (Math.abs(pd.z - ph.z) > Math.abs(pd.y - ph.y)) { const wrap = new THREE.Group(); wrap.rotation.x = -Math.PI / 2; wrap.add(root); loaded = wrap; }
  }
  loaded.updateMatrixWorld(true);
  const bake = makeBakeRig(loaded, map);
  const snap: { o: THREE.Object3D; q: THREE.Quaternion; p: THREE.Vector3 }[] = [];
  loaded.traverse((o) => snap.push({ o, q: o.quaternion.clone(), p: o.position.clone() }));
  const restore = (): void => { for (const s of snap) { s.o.quaternion.copy(s.q); s.o.position.copy(s.p); } loaded.updateMatrixWorld(true); };
  return {
    fileName: name, root, loaded, animations, boneMap: map, bake, signature: 'probe', restore,
    report: { file: name, animations: animations.map((a, i) => ({ name: a.name || `anim ${i}`, dur: a.duration, tracks: a.tracks.length })), bones: byName.size, dupNames: [], mapped: [], unmapped: [], fingers: 0, tracks: [], restBefore: { arm: '', leg: '' }, restAfter: { arm: '', leg: '' } },
  };
}

/** Сегменты, по которым сравниваем «источник против нашего клипа». */
const SEG: [string, string][] = [
  ['Hips', 'Spine'], ['Spine', 'Chest'], ['Neck', 'Head'],
  ['LeftShoulder', 'LeftUpperArm'], ['LeftUpperArm', 'LeftLowerArm'], ['LeftLowerArm', 'LeftHand'],
  ['RightShoulder', 'RightUpperArm'], ['RightUpperArm', 'RightLowerArm'], ['RightLowerArm', 'RightHand'],
  ['LeftUpperLeg', 'LeftLowerLeg'], ['LeftLowerLeg', 'LeftFoot'], ['LeftFoot', 'LeftToes'],
  ['RightUpperLeg', 'RightLowerLeg'], ['RightLowerLeg', 'RightFoot'], ['RightFoot', 'RightToes'],
];

describe('ЦЕНА ПРАВКИ FULL_AIM_CHILD', () => {
  it('1. рест источника по КАЖДОЙ кости: отклонение от канона и кого реально трогает порог', async () => {
    const { root } = await loadRaw();
    const map = autoBoneMap((await import('./modelAssets.js')).skeletonBoneNames(root));
    const idx = boneIndex(root);
    const byName = idx.size ? new Map<string, THREE.Object3D>(idx) : new Map<string, THREE.Object3D>();
    if (!byName.size) root.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });

    const ax = upAxisAngle(root, map);
    console.log(`up-axis доворот источника: ${ax.toFixed(4)} рад (0 = файл уже Y-up); tPoseDeviation(руки) = ${tPoseDeviation(root, map).toFixed(2)}°`);
    const r0 = root.rotation.clone();
    if (ax) root.rotation.set(ax, 0, 0);
    root.updateMatrixWorld(true);

    const base = buildHumanoid(); base.root.updateMatrixWorld(true);
    const wdir = (a: string, b: string): THREE.Vector3 | null => {
      const A = byName.get(map[a] ?? ''), B = byName.get(map[b] ?? '');
      if (!A || !B) return null;
      const v = B.getWorldPosition(new THREE.Vector3()).sub(A.getWorldPosition(new THREE.Vector3()));
      return v.lengthSq() < 1e-9 ? null : v.normalize();
    };
    const bdir = (a: string, b: string): THREE.Vector3 | null => {
      const A = base.bones.get(a), B = base.bones.get(b);
      return A && B ? B.getWorldPosition(new THREE.Vector3()).sub(A.getWorldPosition(new THREE.Vector3())).normalize() : null;
    };

    console.log('\nкость              | ребёнок       | цель канона        | ОТКЛОН (то, что сравнивает порог) | рыск/тангаж источника | рыск/тангаж канона | порог 15° трогает?');
    for (const our of Object.keys(FULL_AIM_CHILD) as string[]) {
      const child = (FULL_AIM_CHILD as Record<string, string>)[our]!;
      const cur = wdir(our, child); if (!cur) { console.log(`${our.padEnd(18)} | ${child.padEnd(13)} | — нет в источнике`); continue; }
      const cd = CANON_DIR[our];
      const can = cd ? new THREE.Vector3(cd[0], cd[1], cd[2]) : bdir(our, child);
      if (!can) continue;
      const dev = cur.angleTo(can) * D;
      const side: 1 | -1 = our.startsWith('Left') ? 1 : -1;
      const [sy, sp] = yawPitch(cur, side), [cy, cp] = yawPitch(can, side);
      console.log(`${our.padEnd(18)} | ${child.padEnd(13)} | ${(cd ? `мир [${cd}]` : 'базовый риг').padEnd(18)} | ${dev.toFixed(2).padStart(8)}° | ${sy.toFixed(1).padStart(7)}/${sp.toFixed(1).padStart(7)} | ${cy.toFixed(1).padStart(7)}/${cp.toFixed(1).padStart(7)} | ${dev >= TPOSE_THRESHOLD_DEG ? 'ДА' : 'нет'}`);
    }
    root.rotation.copy(r0); root.updateMatrixWorld(true);

    // ЭМПИРИКА: кого enforceTPose реально шевельнул (снимок локальных кватернионов до/после).
    for (const [nm, aim] of [['FULL_AIM_CHILD (как в проде)', FULL_AIM_CHILD], ['FULL без стоп', without(FEET as string[])], ['FULL без ног целиком', without(LEGS as string[])], ['AIM_CHILD (атлас)', ATLAS_AIM]] as [string, Partial<Record<OurBone, OurBone>>][]) {
      const { root: r2 } = await loadRaw();
      const m2 = autoBoneMap((await import('./modelAssets.js')).skeletonBoneNames(r2));
      const i2 = new Map<string, THREE.Object3D>(boneIndex(r2));
      const snap = new Map<string, THREE.Quaternion>();
      for (const [k, o] of i2) snap.set(k, o.quaternion.clone());
      enforceTPose(r2, m2, aim);
      const moved: string[] = [];
      for (const [k, o] of i2) { const a = snap.get(k)!.angleTo(o.quaternion) * D; if (a > 1e-3) moved.push(`${k} ${a.toFixed(1)}°`); }
      console.log(`\n[${nm}] тронуто костей ${moved.length}: ${moved.join(', ') || '—'}`);
    }
  }, 300000);

  it('2. клип WalkFwdLoop: источник против нашего при трёх aim-таблицах', async () => {
    const TAKES = ['WalkFwdLoop', 'RunFwdLoop'];
    const variants: [string, Partial<Record<OurBone, OurBone>> | null][] = [
      ['A. FULL_AIM_CHILD (ПРОД)', FULL_AIM_CHILD],
      ['B. FULL без СТОП', without(FEET as string[])],
      ['C. FULL без НОГ целиком', without(LEGS as string[])],
      ['D. enforceTPose ВЫКЛЮЧЕН', null],
    ];
    const raw = await loadRaw();
    const rawMap = autoBoneMap((await import('./modelAssets.js')).skeletonBoneNames(raw.root));
    const rawBy = new Map<string, THREE.Object3D>(boneIndex(raw.root));
    const sdir = (a: string, b: string): THREE.Vector3 | null => {
      const A = rawBy.get(rawMap[a] ?? ''), B = rawBy.get(rawMap[b] ?? '');
      if (!A || !B) return null;
      const v = B.getWorldPosition(new THREE.Vector3()).sub(A.getWorldPosition(new THREE.Vector3()));
      return v.lengthSq() < 1e-9 ? null : v.normalize();
    };

    for (const TAKE of TAKES) {
      const rawClip = raw.animations.find((a) => a.name === TAKE)!;
      console.log(`\n\n######## ${TAKE} (dur ${rawClip.duration.toFixed(2)}с) ########`);
      // источник: снимем эталонные направления по 8 фазам
      const mixer = new THREE.AnimationMixer(raw.root);
      const act = mixer.clipAction(rawClip); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.play();
      const N = 8;
      const srcDirs: Map<string, THREE.Vector3>[] = [];
      const srcFoot: { ly: number; lp: number; ry: number; rp: number }[] = [];
      for (let i = 0; i < N; i++) {
        mixer.setTime((i / N) * rawClip.duration); raw.root.updateMatrixWorld(true);
        const hipI = rawBy.get(rawMap['Hips']!)!.getWorldQuaternion(new THREE.Quaternion()).invert();
        const m = new Map<string, THREE.Vector3>();
        for (const [a, b] of SEG) { const v = sdir(a, b); if (v) m.set(`${a}>${b}`, v.clone().applyQuaternion(hipI)); }
        srcDirs.push(m);
        const L = m.get('LeftFoot>LeftToes')!, R = m.get('RightFoot>RightToes')!;
        const [ly, lp] = yawPitch(L, 1), [ry, rp] = yawPitch(R, -1);
        srcFoot.push({ ly, lp, ry, rp });
      }
      mixer.stopAllAction();

      for (const [vname, aim] of variants) {
        const src = await openWithAim(aim);
        const i0 = src.animations.findIndex((a) => a.name === TAKE);
        const clip = bakeFromSource(src, {
          character: 'mocap', weapon: 'none', animationIndex: i0, name: TAKE, loop: true,
          locoSet: true, anchorIdle: false, fps: 60, epsDeg: 3, hips: 'full', ground: false, head: 'mocap',
          limbLock: { LF: false, RF: false }, rootYaw: false, yawFromFeet: false, rootPos: false,
        }).clip;
        const h = buildHumanoid({});
        const err = new Map<string, number>();
        const foot: { ly: number; lp: number; ry: number; rp: number }[] = [];
        for (let i = 0; i < N; i++) {
          poseRig(h, clipPoseAt(clip, i / N)); h.root.updateMatrixWorld(true);
          const hipI = h.bones.get('Hips')!.getWorldQuaternion(new THREE.Quaternion()).invert();
          const odir = (a: string, b: string): THREE.Vector3 | null => {
            const A = h.bones.get(a), B = h.bones.get(b);
            return A && B ? B.getWorldPosition(new THREE.Vector3()).sub(A.getWorldPosition(new THREE.Vector3())).normalize().applyQuaternion(hipI) : null;
          };
          for (const [a, b] of SEG) {
            const k = `${a}>${b}`; const sv = srcDirs[i]!.get(k); const ov = odir(a, b);
            if (!sv || !ov) continue;
            err.set(k, Math.max(err.get(k) ?? 0, sv.angleTo(ov) * D));
          }
          const L = odir('LeftFoot', 'LeftToes')!, R = odir('RightFoot', 'RightToes')!;
          const [ly, lp] = yawPitch(L, 1), [ry, rp] = yawPitch(R, -1);
          foot.push({ ly, lp, ry, rp });
        }
        console.log(`\n--- ${vname} ---`);
        console.log('  расхождение «источник → наш клип» по сегментам (макс по 8 фазам):');
        console.log('   ' + [...err].map(([k, v]) => `${k}=${v.toFixed(1)}°`).join('  '));
        const avg = (f: (x: typeof foot[0]) => number): string => (foot.reduce((s, x) => s + f(x), 0) / foot.length).toFixed(1).padStart(6);
        const savg = (f: (x: typeof srcFoot[0]) => number): string => (srcFoot.reduce((s, x) => s + f(x), 0) / srcFoot.length).toFixed(1).padStart(6);
        console.log(`  СТОПА (лодыжка→носок, среднее по фазам, + рыск = носок НАРУЖУ, + тангаж = носок ВВЕРХ):`);
        console.log(`    ЛЕВАЯ  наш рыск ${avg((x) => x.ly)}° тангаж ${avg((x) => x.lp)}°   | источник рыск ${savg((x) => x.ly)}° тангаж ${savg((x) => x.lp)}°`);
        console.log(`    ПРАВАЯ наш рыск ${avg((x) => x.ry)}° тангаж ${avg((x) => x.rp)}°   | источник рыск ${savg((x) => x.ry)}° тангаж ${savg((x) => x.rp)}°`);
        console.log('    по фазам (наш): ' + foot.map((x) => `${x.ly.toFixed(0)}/${x.lp.toFixed(0)}`).join(' ') + '  || правая: ' + foot.map((x) => `${x.ry.toFixed(0)}/${x.rp.toFixed(0)}`).join(' '));
      }
    }
  }, 300000);

  it('4. рест стопы: ПОЗА УЗЛОВ против БИНДА (какую видит пайплайн)', async () => {
    (globalThis as unknown as { window?: unknown }).window ??= { innerWidth: 1920, innerHeight: 1080 };
    const warn = console.warn; console.warn = (): void => {};
    const { loadAnimatedModelFile, skeletonBoneNames } = await import('./modelAssets.js');
    const { nodeVsBindGap } = await import('./retarget3d.js');
    const r = await loadAnimatedModelFile(mkFile());
    console.warn = warn;
    const map = autoBoneMap(skeletonBoneNames(r.root));
    const by = new Map<string, THREE.Object3D>(boneIndex(r.root));
    const show = (label: string): void => {
      r.root.updateMatrixWorld(true);
      const out: string[] = [];
      for (const [s, side] of [['Left', 1], ['Right', -1]] as [string, 1 | -1][]) {
        const A = by.get(map[s + 'Foot'] ?? ''), B = by.get(map[s + 'Toes'] ?? '');
        if (!A || !B) continue;
        const v = B.getWorldPosition(new THREE.Vector3()).sub(A.getWorldPosition(new THREE.Vector3())).normalize();
        const [y, p] = yawPitch(v, side);
        out.push(`${s}: рыск ${y.toFixed(1).padStart(6)}° тангаж ${p.toFixed(1).padStart(6)}°`);
      }
      console.log(`${label}: ${out.join('   |   ')}`);
    };
    show('ПОЗА УЗЛОВ (файл как есть, так мерил главный)');
    console.log(`nodeVsBindGap = ${nodeVsBindGap(r.root).toFixed(2)} ед файла (0 = узлы и бинд совпадают)`);
    r.root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.pose(); });
    show('БИНД (skeleton.pose() — ЭТО и делает openBakeSource перед снятием restW)');
  }, 300000);

  it('5. сторожа mocapSetPack под вариантом «без стоп»: шов цикла и переворот кости ноги', async () => {
    const { loopSeamGap } = await import('./clipImport.js');
    const { matchMocapSet } = await import('./mocapSetMap.js');
    const LEG = ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'];
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(DIR).filter((x) => x.toLowerCase().endsWith('.fbx')).sort();
    for (const [vname, aim] of [['A. ПРОД (FULL)', FULL_AIM_CHILD], ['B. без СТОП', without(FEET as string[])]] as [string, Partial<Record<OurBone, OurBone>>][]) {
      const seam: string[] = [], flip: string[] = [];
      const H = buildHumanoid();
      let maxFlip = 0, maxSeam = 0, nTakes = 0, nCore = 0;
      for (const f of files) {
      const src = await openWithAim(aim, f);
      const m = matchMocapSet(src.animations.map((a) => a.name));
      const takes = [...m.core, ...m.extra];
      nTakes += takes.length; nCore += m.core.length;
      for (const t of takes) {
        const i = src.animations.findIndex((a) => a.name === t.take);
        const dur = src.animations[i]!.duration;
        const r = bakeFromSource(src, {
          character: 'mocap', weapon: 'none', animationIndex: i, name: t.clip, loop: t.cyclic,
          locoSet: true, bakeId: 1, anchorIdle: false, fps: 60, epsDeg: 3, limbLock: { LF: false, RF: false },
          hips: 'full', ground: true, head: 'mocap',
          rootYaw: t.rootYaw ?? false, yawFromFeet: false, rootPos: true,
          startSec: t.trim ? t.trim[0] * dur : undefined, endSec: t.trim ? t.trim[1] * dur : undefined,
        });
        if (t.cyclic) {
          const g = loopSeamGap(r.clip);
          maxSeam = Math.max(maxSeam, g.deg);
          if (g.deg > (t.core ? 10 : 15) * 0.7) seam.push(`${t.clip} ${g.deg.toFixed(1)}° (${g.bone}, порог ${t.core ? 10 : 15})`);
        }
        if (!t.core) continue;
        for (const bone of LEG) {
          let prev: THREE.Quaternion | null = null, deg = 0, at = -1;
          r.clip.keys.forEach((k, j) => {
            for (const nm in k.pose) { if (nm[0] === '_') continue; const b = H.bones.get(nm); if (b) b.rotation.set(k.pose[nm]![0], k.pose[nm]![1], k.pose[nm]![2]); }
            H.root.updateMatrixWorld(true);
            const b = H.bones.get(bone); if (!b) return;
            const q = b.getWorldQuaternion(new THREE.Quaternion());
            if (prev) { const d = 2 * Math.acos(Math.min(1, Math.abs(prev.dot(q)))) * D; if (d > deg) { deg = d; at = j; } }
            prev = q;
          });
          maxFlip = Math.max(maxFlip, deg);
          if (deg >= 60) flip.push(`${t.clip}/${bone} ${deg.toFixed(0)}° (ключ ${at})`);
        }
      }
      }
      console.log(`\n=== ${vname} === тейков ${nTakes} (ядро ${nCore}), файлов ${files.length}`);
      console.log(`  ПЕРЕВОРОТ КОСТИ НОГИ: макс ${maxFlip.toFixed(1)}° (порог сторожа 90°). Близко к порогу: ${flip.join(', ') || '—'}`);
      console.log(`  ШОВ ЦИКЛА: макс ${maxSeam.toFixed(1)}°. Близко к порогу: ${seam.join(', ') || '—'}`);
    }
  }, 900000);

  it('3. сколько клипов придётся перепечь + метки', async () => {
    console.log(`MOCAP_SET: всего ${MOCAP_SET.length}, ядро ${MOCAP_SET.filter((t) => t.core).length}, доп ${MOCAP_SET.filter((t) => !t.core && !t.blocked).length}, заблокировано ${MOCAP_SET.filter((t) => t.blocked).length}`);
    console.log('цикличных (несут походку): ' + MOCAP_SET.filter((t) => t.cyclic).length);
    console.log(`наших костей всего: ${OUR_BONES.length}`);
  }, 60000);
});
