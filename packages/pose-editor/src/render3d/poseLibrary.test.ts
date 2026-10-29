import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  capturePose, pastePose, pasteIntoInterval, mirrorPoseSide, flipPoseSides,
  flipClip, mirrorClip, rotateClipPhase, comparePoses, EMPTY_POSE_LIBRARY,
} from './poseLibrary.js';
import { clipPoseAt, type Clip, type Keyframe, type Pose } from './clipModel.js';

const P = (o: Record<string, [number, number, number]>): Pose => o;
const mk = (keys: Keyframe[]): Clip => ({ name: 'c', character: 'a', weapon: 'sword', loop: true, keys });

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const angDeg = (a: readonly number[], b: readonly number[]): number => {
  _qa.setFromEuler(new THREE.Euler(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, 'XYZ'));
  _qb.setFromEuler(new THREE.Euler(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, 'XYZ'));
  return _qa.angleTo(_qb) * 180 / Math.PI;
};

describe('poseLibrary — снятие и вставка', () => {
  const full = P({ Spine: [0.1, 0, 0], LeftUpperArm: [1, 0, 0], RightUpperArm: [-1, 0, 0], __hipsP: [0, 32, 0] });

  it('снимает только выделенные кости и выкидывает спец-ключи', () => {
    const p = capturePose(full, ['LeftUpperArm']);
    expect(Object.keys(p)).toEqual(['LeftUpperArm']);
    expect(capturePose(full)['__hipsP']).toBeUndefined();
  });

  it('вставка перекрывает ТОЛЬКО кости позы', () => {
    const t = pastePose(full, P({ LeftUpperArm: [0, 0, 0] }));
    expect(t['LeftUpperArm']).toEqual([0, 0, 0]);
    expect(t['Spine']).toEqual([0.1, 0, 0]);          // не тронуто
    expect(t['__hipsP']).toEqual([0, 32, 0]);         // спец-ключи целы
  });

  it('вставка с весом смешивает, а не подменяет', () => {
    const t = pastePose(P({ Spine: [0, 0, 0] }), P({ Spine: [1, 0, 0] }), 0.5);
    expect(t['Spine']![0]).toBeGreaterThan(0.4);
    expect(t['Spine']![0]).toBeLessThan(0.6);
  });
});

describe('poseLibrary — Interval Edit (вставка в интервал)', () => {
  const keys = (): Keyframe[] => [0, 1, 2, 3, 4].map((i) => ({ pose: P({ Spine: [0, 0, 0] }), t: i * 0.2 }));

  it('влияние нарастает от 0 на начале до 1 на конце', () => {
    const k = keys();
    pasteIntoInterval(k, 0, 4, P({ Spine: [1, 0, 0] }));
    const xs = k.map((x) => x.pose['Spine']![0]);
    expect(xs[0]!).toBeCloseTo(0, 3);
    expect(xs[4]!).toBeCloseTo(1, 3);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);   // монотонно
  });

  it('делает бесшовный луп: хвост приходит в позу первого кадра', () => {
    const c = mk([
      { pose: P({ Spine: [0, 0, 0] }), t: 0 },
      { pose: P({ Spine: [0.8, 0, 0] }), t: 0.3 },
      { pose: P({ Spine: [1.4, 0, 0] }), t: 0.6 },
      { pose: P({ Spine: [1.9, 0, 0] }), t: 0.9 },
    ]);
    const seamBefore = angDeg(clipPoseAt(c, 1)['Spine']!, c.keys[0]!.pose['Spine']!);
    expect(seamBefore).toBeGreaterThan(20);                       // до правки шов огромный
    pasteIntoInterval(c.keys, 1, 3, capturePose(c.keys[0]!.pose));
    const seamAfter = angDeg(clipPoseAt(c, 1)['Spine']!, c.keys[0]!.pose['Spine']!);
    expect(seamAfter).toBeLessThan(0.01);                         // после — шва нет
  });

  it('кривая bezier даёт более мягкий вход, чем linear', () => {
    const kl = keys(), kb = keys();
    pasteIntoInterval(kl, 0, 4, P({ Spine: [1, 0, 0] }), 'linear');
    pasteIntoInterval(kb, 0, 4, P({ Spine: [1, 0, 0] }), 'bezier');
    expect(kb[1]!.pose['Spine']![0]).toBeLessThan(kl[1]!.pose['Spine']![0]);
  });

  it('вырожденный интервал (один кадр) = обычная вставка', () => {
    const k = keys();
    pasteIntoInterval(k, 2, 2, P({ Spine: [1, 0, 0] }));
    expect(k[2]!.pose['Spine']![0]).toBeCloseTo(1, 6);
    expect(k[1]!.pose['Spine']![0]).toBe(0);
  });
});

describe('poseLibrary — mirror ≠ flip', () => {
  const p = P({ Hips: [0, 0.3, 0], LeftUpperArm: [1, 0.5, -0.2], RightUpperArm: [0, 0, 0] });

  it('mirror подтягивает вторую сторону, поза остаётся «той же»', () => {
    const m = mirrorPoseSide(p, 'Left');
    expect(m['LeftUpperArm']).toEqual([1, 0.5, -0.2]);   // источник цел
    expect(m['RightUpperArm']).toEqual([1, -0.5, 0.2]);  // подтянута
    expect(m['Hips']).toEqual([0, 0.3, 0]);              // центр не тронут
  });

  it('flip меняет стороны местами и отражает центр', () => {
    const f = flipPoseSides(p);
    expect(f['RightUpperArm']).toEqual([1, -0.5, 0.2]);  // левая уехала в правую
    expect(f['LeftUpperArm']).toEqual([0, -0, -0]);      // и наоборот
    expect(f['Hips']).toEqual([0, -0.3, -0]);            // центр отражён
  });

  it('это РАЗНЫЕ операции (результаты не совпадают)', () => {
    expect(JSON.stringify(mirrorPoseSide(p))).not.toBe(JSON.stringify(flipPoseSides(p)));
  });
});

describe('poseLibrary — операции над клипом', () => {
  const c = mk([
    { pose: P({ LeftUpperLeg: [0.5, 0, 0], RightUpperLeg: [-0.5, 0, 0] }), t: 0 },
    { pose: P({ LeftUpperLeg: [-0.5, 0, 0], RightUpperLeg: [0.5, 0, 0] }), t: 0.5 },
  ]);

  it('flipClip переворачивает каждый кадр, а времена не трогает', () => {
    const f = flipClip(c);
    expect(f.keys.map((k) => k.t)).toEqual([0, 0.5]);
    expect(f.keys[0]!.pose['RightUpperLeg']).toEqual([0.5, -0, -0]);
    expect(c.keys[0]!.pose['RightUpperLeg']).toEqual([-0.5, 0, 0]);   // исходник цел
  });

  it('flipClip дважды = исходный клип', () => {
    const back = flipClip(flipClip(c));
    for (let i = 0; i < c.keys.length; i++)
      for (const nm in c.keys[i]!.pose)
        expect(angDeg(back.keys[i]!.pose[nm]!, c.keys[i]!.pose[nm]!)).toBeLessThan(1e-3);   // градусы: acos возле 1 шумит на ~2e-6
  });

  it('mirrorClip симметризует все кадры', () => {
    const m = mirrorClip(c, 'Left');
    expect(m.keys[0]!.pose['RightUpperLeg']).toEqual([0.5, -0, -0]);
  });

  it('сдвиг фазы переставляет позы, сохраняя сетку времён', () => {
    const c3 = mk([0, 1, 2].map((i) => ({ pose: P({ Spine: [i, 0, 0] }), t: i * 0.3 })));
    const r = rotateClipPhase(c3, 1);
    expect(r.keys.map((k) => k.t)).toEqual([0, 0.3, 0.6]);
    expect(r.keys.map((k) => k.pose['Spine']![0])).toEqual([1, 2, 0]);
  });

  it('сдвиг на длину клипа = тождество', () => {
    const c3 = mk([0, 1, 2].map((i) => ({ pose: P({ Spine: [i, 0, 0] }), t: i * 0.3 })));
    expect(rotateClipPhase(c3, 3).keys.map((k) => k.pose['Spine']![0])).toEqual([0, 1, 2]);
  });
});

describe('poseLibrary — сравнение поз («а в игре так же?»)', () => {
  it('находит худшую кость и сортирует по расхождению', () => {
    const a = P({ Spine: [0, 0, 0], LeftHand: [0, 0, 0], Head: [0, 0, 0] });
    const b = P({ Spine: [0.05, 0, 0], LeftHand: [0.6, 0, 0], Head: [0.01, 0, 0] });
    const d = comparePoses(a, b, angDeg);
    expect(d.worstBone).toBe('LeftHand');
    expect(d.worstDeg).toBeGreaterThan(30);
    expect(d.perBone[0]!.bone).toBe('LeftHand');
    expect(d.perBone[d.perBone.length - 1]!.bone).toBe('Head');
  });

  it('одинаковые позы дают ноль', () => {
    const a = P({ Spine: [0.2, 0.1, 0] });
    expect(comparePoses(a, a, angDeg).worstDeg).toBeLessThan(1e-3);   // градусы: acos возле 1 шумит на ~2e-6
  });
});

describe('poseLibrary — контейнер', () => {
  it('пустая библиотека создаётся', () => { expect(EMPTY_POSE_LIBRARY().poses).toEqual({}); });
});
