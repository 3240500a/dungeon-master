import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  poseClipToAnimationClip, animationClipToPoseClip, clipBoneNames,
  boneRenamer, boneUnrenamer, clipManifest,
} from './clipToAnimation.js';
import { clipPoseAt, clipDur, hipsOffset, EASE_INOUT, type Clip, type Pose } from './clipModel.js';
import { buildHumanoid } from './humanoid.js';

const P = (o: Record<string, [number, number, number]>): Pose => o;
const mk = (keys: Clip['keys'], name = 'hit_sword'): Clip => ({ name, character: 'warrior', weapon: 'sword', loop: false, keys });

const SWING: Clip = mk([
  { pose: P({ Spine: [0, 0, 0], RightUpperArm: [0, 0, 0.2], RightLowerArm: [0, 0, -0.3], __hipsP: [0, 32, 0] }), t: 0 },
  { pose: P({ Spine: [0.3, -0.4, 0.1], RightUpperArm: [-1.2, 0.6, 1.1], RightLowerArm: [0, 0, -1.6], __hipsP: [1.5, 31, 3] }), t: 0.25 },
  { pose: P({ Spine: [-0.2, 0.5, -0.1], RightUpperArm: [0.9, -0.4, -0.8], RightLowerArm: [0, 0, -0.2], __hipsP: [-1, 32.5, -2] }), t: 0.5 },
  { pose: P({ Spine: [0, 0, 0], RightUpperArm: [0, 0, 0.2], RightLowerArm: [0, 0, -0.3], __hipsP: [0, 32, 0] }), t: 0.75 },
]);

/** Максимальное угловое расхождение поз (в градусах) по всем костям. */
function maxAngleDeg(a: Pose, b: Pose): number {
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), ea = new THREE.Euler(), eb = new THREE.Euler();
  let worst = 0;
  for (const nm of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (nm[0] === '_') continue;
    const va = a[nm] ?? [0, 0, 0], vb = b[nm] ?? [0, 0, 0];
    qa.setFromEuler(ea.set(va[0], va[1], va[2], 'XYZ'));
    qb.setFromEuler(eb.set(vb[0], vb[1], vb[2], 'XYZ'));
    worst = Math.max(worst, qa.angleTo(qb) * 180 / Math.PI);
  }
  return worst;
}

describe('clipToAnimation — сборка дорожек', () => {
  it('дорожка на каждую кость клипа + позиция таза; спец-ключи НЕ уезжают', () => {
    const anim = poseClipToAnimationClip(SWING);
    const names = anim.tracks.map((t) => t.name).sort();
    expect(names).toEqual(['Hips.position', 'RightLowerArm.quaternion', 'RightUpperArm.quaternion', 'Spine.quaternion']);
    expect(anim.duration).toBeCloseTo(0.75, 6);
    expect(clipBoneNames(SWING).sort()).toEqual(['RightLowerArm', 'RightUpperArm', 'Spine']);
  });

  it('спец-каналы (__match/__pinKp/__wpn*/__lgrip*) в дорожки не попадают', () => {
    const c = mk([
      { pose: P({ Spine: [0.1, 0, 0], __match: [0.5, 0, 0], __pinKp: [9000, 0, 0], __wpnMain: [1, 0, 0], __lgripP: [0, -14, 0] }), t: 0 },
      { pose: P({ Spine: [0.2, 0, 0], __match: [1, 0, 0], __pinKp: [12000, 0, 0], __wpnMain: [1.2, 0, 0], __lgripP: [0, -12, 0] }), t: 0.4 },
    ]);
    const names = poseClipToAnimationClip(c).tracks.map((t) => t.name);
    expect(names).toEqual(['Spine.quaternion']);
  });

  it('кватернионы приведены к одному полушарию (без «длинной дуги»)', () => {
    // Поворот на ~350° по одной оси между кадрами: без нормализации знака сосед уходит в другое полушарие.
    const c = mk([
      { pose: P({ Spine: [0, 0, 0] }), t: 0 },
      { pose: P({ Spine: [0, 0, Math.PI * 0.99] }), t: 0.2 },
      { pose: P({ Spine: [0, 0, -Math.PI * 0.99] }), t: 0.4 },
    ]);
    const tr = poseClipToAnimationClip(c).tracks[0]!;
    for (let i = 1; i < tr.times.length; i++) {
      let dot = 0;
      for (let k = 0; k < 4; k++) dot += tr.values[(i - 1) * 4 + k]! * tr.values[i * 4 + k]!;
      expect(dot).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('clipToAnimation — round-trip Clip → AnimationClip → Clip', () => {
  it('линейный клип возвращается ключ-в-ключ (< 0.01 рад)', () => {
    const anim = poseClipToAnimationClip(SWING);
    const back = animationClipToPoseClip(anim, { character: 'warrior', weapon: 'sword' });
    expect(back.keys.length).toBe(SWING.keys.length);
    for (let i = 0; i < SWING.keys.length; i++) {
      expect(back.keys[i]!.t).toBeCloseTo(SWING.keys[i]!.t, 4);
      expect(maxAngleDeg(SWING.keys[i]!.pose, back.keys[i]!.pose) * Math.PI / 180).toBeLessThan(0.01);
    }
  });

  it('офсет таза переживает round-trip (легаси-абсолют → glTF → дельта)', () => {
    // В glTF `Hips.position` абсолютна, у нас в клипе — дельта от rest. Сверяем в ОДНОМ пространстве.
    const back = animationClipToPoseClip(poseClipToAnimationClip(SWING), { character: 'warrior', weapon: 'sword' });
    for (let i = 0; i < SWING.keys.length; i++) {
      const want = hipsOffset(SWING.keys[i]!.pose)!, got = hipsOffset(back.keys[i]!.pose)!;
      for (let k = 0; k < 3; k++) expect(got[k]!).toBeCloseTo(want[k]!, 3);
    }
    expect(back.keys[0]!.pose['__hipsD']).toBeDefined();      // на выходе — новый ключ
    expect(back.keys[0]!.pose['__hipsP']).toBeUndefined();
  });

  it('rest-высота таза учитывается: ОДИН клип на двух телах = один и тот же присед', () => {
    // Смысл дельты: «таз на 1 юнит ниже стойки» остаётся тем же приседом и на высоком персонаже,
    // тогда как раньше абсолютные 31 на теле с rest 36 были бы приседом на пять юнитов.
    const crouch: Clip = mk([
      { pose: P({ Spine: [0, 0, 0], __hipsD: [0, 0, 0] }), t: 0 },
      { pose: P({ Spine: [0, 0, 0], __hipsD: [0, -1, 0] }), t: 0.5 },
    ]);
    const mid = poseClipToAnimationClip(crouch, { hipsRest: [0, 32, 0] }).tracks.find((t) => t.name === 'Hips.position')!;
    const tall = poseClipToAnimationClip(crouch, { hipsRest: [0, 36, 0] }).tracks.find((t) => t.name === 'Hips.position')!;
    expect(mid.values[1]!).toBeCloseTo(32, 3); expect(mid.values[4]!).toBeCloseTo(31, 3);     // стойка своя
    expect(tall.values[1]!).toBeCloseTo(36, 3); expect(tall.values[4]!).toBeCloseTo(35, 3);   // а присед — тот же
    const back = animationClipToPoseClip(poseClipToAnimationClip(crouch, { hipsRest: [0, 36, 0] }),
      { character: 'warrior', weapon: 'sword', hipsRest: [0, 36, 0] });
    expect(hipsOffset(back.keys[1]!.pose)![1]).toBeCloseTo(-1, 3);
  });

  it('легаси-абсолют читается ОТНОСИТЕЛЬНО того же rest — старые клипы не съезжают', () => {
    const anim = poseClipToAnimationClip(SWING, { hipsRest: [0, 36, 0] });
    const tr = anim.tracks.find((t) => t.name === 'Hips.position')!;
    expect(tr.values[1]!).toBeCloseTo(32, 3);                 // как было записано, ровно так и уехало
  });

  it('клип С КРИВЫМИ (ease) переносится по ФОРМЕ: расхождение по времени < 1°', () => {
    const eased: Clip = mk(SWING.keys.map((k, i) => ({ ...k, interp: i < SWING.keys.length - 1 ? 'ease' as const : undefined, ease: EASE_INOUT })));
    const back = animationClipToPoseClip(poseClipToAnimationClip(eased, { fps: 60, epsDeg: 0.3 }), { character: 'warrior', weapon: 'sword' });
    const dur = clipDur(eased);
    let worst = 0;
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      worst = Math.max(worst, maxAngleDeg(clipPoseAt(eased, u), clipPoseAt(back, u)));
    }
    expect(worst).toBeLessThan(1);
    expect(clipDur(back)).toBeCloseTo(dur, 3);
    expect(back.keys.length).toBeGreaterThan(eased.keys.length);   // кривая «впечена» доп. ключами
  });

  it('степовый клип едет дискретной дорожкой (форма «держать» сохраняется)', () => {
    const st = mk([
      { pose: P({ Spine: [0, 0, 0] }), t: 0, interp: 'step' },
      { pose: P({ Spine: [1, 0, 0] }), t: 0.3, interp: 'step' },
      { pose: P({ Spine: [0, 0, 0] }), t: 0.6 },
    ]);
    const anim = poseClipToAnimationClip(st);
    expect(anim.tracks[0]!.getInterpolation()).toBe(THREE.InterpolateDiscrete);
    expect(anim.tracks[0]!.times.length).toBe(3);   // без пересемпла
  });
});

describe('clipToAnimation — проигрывание через AnimationMixer (как в чужом движке)', () => {
  it('микшер three воспроизводит нашу позу с той же точностью, что наш плеер', () => {
    const h = buildHumanoid({});
    const anim = poseClipToAnimationClip(SWING);
    const mixer = new THREE.AnimationMixer(h.root);
    mixer.clipAction(anim).play();
    const eu = new THREE.Euler();
    let worst = 0;
    for (const u of [0, 0.2, 0.35, 0.5, 0.7, 1]) {
      const t = u * clipDur(SWING);
      mixer.setTime(0); mixer.setTime(t);          // setTime от нуля — детерминированно
      const want = clipPoseAt(SWING, u);
      for (const nm of clipBoneNames(SWING)) {
        eu.setFromQuaternion(h.bones.get(nm)!.quaternion, 'XYZ');
        const w = want[nm]!;
        const qa = new THREE.Quaternion().setFromEuler(new THREE.Euler(w[0], w[1], w[2], 'XYZ'));
        const qb = new THREE.Quaternion().setFromEuler(eu);
        worst = Math.max(worst, qa.angleTo(qb) * 180 / Math.PI);
      }
    }
    expect(worst).toBeLessThan(0.5);
  });

  it('дорожка таза двигает Hips.position, а Root остаётся на месте (in-place)', () => {
    const h = buildHumanoid({});
    const mixer = new THREE.AnimationMixer(h.root);
    mixer.clipAction(poseClipToAnimationClip(SWING)).play();
    mixer.setTime(0); mixer.setTime(0.25);
    expect(h.hips.position.x).toBeCloseTo(1.5, 2);
    expect(h.hips.position.z).toBeCloseTo(3, 2);
    expect(h.root.position.lengthSq()).toBe(0);   // персонаж не уехал
  });
});

describe('clipToAnimation — профили имён костей', () => {
  it('UE5: канон → mannequin, и обратно', () => {
    const to = boneRenamer('ue5'), from = boneUnrenamer('ue5');
    expect(to('LeftUpperArm')).toBe('upperarm_l');
    expect(to('Hips')).toBe('pelvis');
    expect(to('LeftToes')).toBe('ball_l');
    for (const b of ['Hips', 'Spine', 'LeftUpperArm', 'RightFoot', 'Head']) expect(from(to(b))).toBe(b);
  });

  it('Mixamo: своя схема спины, БЕЗ префикса mixamorig:', () => {
    const to = boneRenamer('mixamo'), from = boneUnrenamer('mixamo');
    expect(to('Chest')).toBe('Spine1');
    expect(to('LeftUpperLeg')).toBe('LeftUpLeg');
    for (const b of ['Hips', 'Chest', 'LeftUpperLeg', 'RightHand']) expect(from(to(b))).toBe(b);
  });

  it('имя дорожки РЕЗОЛВИТСЯ three в тот же узел — на всех профилях', () => {
    // ГРАБЛЯ: three считает ':' разделителем пути, так что 'mixamorig:Hips.quaternion' разбирается в nodeName='Hips'
    // и экспортёр ТИХО теряет дорожку. Любое имя кости обязано выживать разбор.
    for (const prof of ['canon', 'ue5', 'mixamo'] as const) {
      const to = boneRenamer(prof);
      for (const b of ['Hips', 'Spine', 'LeftUpperArm', 'RightFoot', 'Head']) {
        const node = to(b);
        const parsed = THREE.PropertyBinding.parseTrackName(node + '.quaternion');
        expect(parsed.nodeName, `${prof}: ${node}`).toBe(node);
      }
    }
  });

  it('«имена модели» берутся из boneMap импорта', () => {
    const map = { LeftUpperArm: 'CC_Base_L_Upperarm', Hips: 'CC_Base_Hip' };
    const to = boneRenamer('model', map);
    expect(to('LeftUpperArm')).toBe('CC_Base_L_Upperarm');
    expect(to('Neck')).toBe('Neck');   // нет в карте → как есть
    expect(boneUnrenamer('model', map)('CC_Base_Hip')).toBe('Hips');
  });

  it('переименование доезжает до имён дорожек', () => {
    const names = poseClipToAnimationClip(SWING, { renameBone: boneRenamer('ue5') }).tracks.map((t) => t.name).sort();
    expect(names).toEqual(['lowerarm_r.quaternion', 'pelvis.position', 'spine_01.quaternion', 'upperarm_r.quaternion']);
  });
});

describe('clipToAnimation — манифест', () => {
  it('вид клипа определяется по конвенции имени', () => {
    expect(clipManifest(mk([], 'idle_sword')).kind).toBe('idle');
    expect(clipManifest(mk([], 'combat_idle_sword')).kind).toBe('combat_idle');
    expect(clipManifest(mk([], 'hit_sword')).kind).toBe('hit');
    expect(clipManifest(mk([], 's_hit_sword')).kind).toBe('skill_hit');
    expect(clipManifest(mk([], 'walk_fwd')).kind).toBe('locomotion');   // запечённая походка
    expect(clipManifest(mk([], 'плащ_взмах')).kind).toBe('other');
    const m = clipManifest(SWING);
    expect(m.duration).toBeCloseTo(0.75, 4); expect(m.keys).toBe(4); expect(m.weapon).toBe('sword');
  });
});
