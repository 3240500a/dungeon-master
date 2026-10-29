import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { legCanonFix, canonLegOffsets, type LegCanonPoints, type V3 } from './legCanon.js';
import { makeRetargetRig } from './retarget3d.js';
import { buildHumanoid } from './humanoid.js';

/**
 * ⭐⭐ РЕСТ НОГ МОДЕЛИ — В КАНОН (07.10). Жалоба: «пингвин, ноги согнуты больше, оси стопы сдвинуты». У рыцаря в бинде колено
 * согнуто ~3°, голень внутрь 2.4°, носок наружу 23.6° — и всё это садилось в каждый кадр, потому что «ноль поворотов» = бинд.
 */
const D = Math.PI / 180;
const rot = (q: [number, number, number, number], piv: V3, x: V3): THREE.Vector3 =>
  new THREE.Vector3(...x).sub(new THREE.Vector3(...piv)).applyQuaternion(new THREE.Quaternion(...q)).add(new THREE.Vector3(...piv));

/** Нога «как у рыцаря»: бедро наружу, колено согнуто вперёд, голень внутрь, носок наружу на `toeDeg`. `mx` = −1 — зеркало X (Unity). */
function leg(side: 1 | -1, toeDeg: number, mx = 1): { u: V3; k: V3; f: V3; t: V3 } {
  const s = side * mx;
  const u: V3 = [4 * s, 30, 0];
  const k: V3 = [u[0] + 0.5 * s, 16, 0.6];
  const f: V3 = [k[0] - 0.6 * s, 2, -0.4];
  const a = toeDeg * D * side;
  const t: V3 = [f[0] + Math.sin(a) * 5 * mx, 0.5, f[2] + Math.cos(a) * 5];
  return { u, k, f, t };
}
function pts(toeDeg: number, mx = 1): LegCanonPoints {
  const L = leg(1, toeDeg, mx), R = leg(-1, toeDeg, mx);
  return { uL: L.u, kL: L.k, fL: L.f, tL: L.t, uR: R.u, kR: R.k, fR: R.f, tR: R.t };
}

describe('legCanonFix — поправка реста ног модели', () => {
  it('после поправки: бедро и голень вертикально, носок прямо вперёд, наклон носка сохранён', () => {
    const p = pts(23.6), q = legCanonFix(p);
    for (const [s, k] of [['Left', 'L'], ['Right', 'R']] as const) {
      const u = p[`u${k}`]!, kn = p[`k${k}`]!, f = p[`f${k}`]!, t = p[`t${k}`]!;
      // ЦЕПЬ, как у костей: поправка — это смена ОРИЕНТАЦИИ звена, позиции ребёнка идут от родителя
      const k1 = rot(q[`${s}UpperLeg`]!, u, kn);
      expect(k1.x - u[0], `${s}: колено под бедром`).toBeCloseTo(0, 9);
      expect(k1.z - u[2]).toBeCloseTo(0, 9);
      const f2 = rot(q[`${s}LowerLeg`]!, kn, f).sub(new THREE.Vector3(...kn)).add(k1);
      expect(f2.x - k1.x, `${s}: лодыжка под коленом`).toBeCloseTo(0, 9);
      expect(f2.z - k1.z).toBeCloseTo(0, 9);
      const d = rot(q[`${s}Foot`]!, f, t).sub(new THREE.Vector3(...f));
      expect(Math.atan2(d.x, d.z) / D, `${s}: носок прямо вперёд`).toBeCloseTo(0, 6);
      const before = new THREE.Vector3(...t).sub(new THREE.Vector3(...f));
      expect(Math.asin(d.y / d.length()), `${s}: тангаж носка не тронут`).toBeCloseTo(Math.asin(before.y / before.length()), 6);
    }
  });
  it('⭐ ЗЕРКАЛЬНАЯ модель (Unity, X отражён): перёд не переворачивается, носок — вперёд', () => {
    const p = pts(23.6, -1), q = legCanonFix(p);
    for (const [s, k] of [['Left', 'L'], ['Right', 'R']] as const) {
      const d = rot(q[`${s}Foot`]!, p[`u${k}`]!, p[`t${k}`]!).sub(rot(q[`${s}Foot`]!, p[`u${k}`]!, p[`f${k}`]!));
      expect(d.z, `${s}: носок смотрит в +Z, а не назад`).toBeGreaterThan(0);
      expect(Math.atan2(d.x, d.z) / D).toBeCloseTo(0, 6);
    }
  });
  it('носок дальше 45° — не рест: стопа остаётся как в бинде (поправки нет), ноги выпрямляются как обычно', () => {
    const q = legCanonFix(pts(60));
    expect(q['LeftFoot']).toBeUndefined();
    expect(q['LeftLowerLeg']).toBeDefined();
  });
  it('нет носка — рыск не определить, стопа как в бинде; нет колена — поправки ноги нет вовсе', () => {
    const p = pts(10); delete p.tL; delete p.kR;
    const q = legCanonFix(p);
    expect(q['LeftFoot']).toBeUndefined();
    expect(q['LeftToes']).toBeUndefined();
    expect(q['RightUpperLeg']).toBeUndefined();
  });
});

describe('canonLegOffsets — офсеты рига', () => {
  it('голень и бедро вертикально с длинами модели, носок вперёд с горизонталью и наклоном модели, прочее как есть', () => {
    const bo = { Hips: [0, 35, 0], LeftLowerLeg: [0.01, -14.08, 0.29], LeftFoot: [-0.61, -14.4, -0.43], LeftToes: [2.09, -1.79, 4.78], Spine: [0, 5, 1] };
    const c = canonLegOffsets(bo)!;
    // прямая нога выше: таз поднят на прирост вертикали — лодыжка в покое там же, где у модели
    const gain = Math.hypot(0.01, 14.08, 0.29) - 14.08 + Math.hypot(0.61, 14.4, 0.43) - 14.4;
    expect(c['Hips']![1]).toBeCloseTo(35 + gain, 12);
    expect(c['Hips']![1]! + c['LeftLowerLeg']![1]! + c['LeftFoot']![1]!).toBeCloseTo(35 - 14.08 - 14.4, 12);
    expect(c['LeftLowerLeg']).toEqual([0, -Math.hypot(0.01, 14.08, 0.29), 0]);
    expect(c['LeftFoot']).toEqual([0, -Math.hypot(0.61, 14.4, 0.43), 0]);
    expect(c['LeftToes']).toEqual([0, -1.79, Math.hypot(2.09, 4.78)]);
    expect(c['Spine']).toEqual([0, 5, 1]);
    expect(bo['LeftToes'], 'вход не тронут').toEqual([2.09, -1.79, 4.78]);
  });
});

describe('makeRetargetRig — модель с «пингвином» в бинде на прямой кукле стоит прямо', () => {
  it('⭐⭐ кукла в нуле → колено модели под бедром, носок модели вперёд (было: носок наружу на весь развал бинда)', () => {
    // Синтетическая модель: скелет нашими именами, ноги «как у рыцаря»
    const root = new THREE.Group();
    const mk = (name: string, parent: THREE.Object3D, worldPos: V3): THREE.Bone => {
      const b = new THREE.Bone(); b.name = name; parent.add(b);
      parent.updateMatrixWorld(true);
      b.position.copy(parent.worldToLocal(new THREE.Vector3(...worldPos)));
      b.updateMatrixWorld(true);
      return b;
    };
    const hips = mk('Hips', root, [0, 32, 0]);
    mk('Head', mk('Neck', mk('Spine', hips, [0, 38, 0]), [0, 50, 0]), [0, 55, 0]);
    for (const [s, side] of [['Left', 1], ['Right', -1]] as const) {
      const g = leg(side, 23.6);
      const u = mk(s + 'UpperLeg', hips, g.u), k = mk(s + 'LowerLeg', u, g.k), f = mk(s + 'Foot', k, g.f);
      mk(s + 'Toes', f, g.t);
    }
    root.updateMatrixWorld(true);
    const map: Record<string, string> = {};
    root.traverse((o) => { if ((o as THREE.Bone).isBone) map[o.name] = o.name; });
    const rig = makeRetargetRig(root, map);
    const driver = buildHumanoid({});
    rig.drive(driver);
    root.updateMatrixWorld(true);
    const w = (n: string): THREE.Vector3 => root.getObjectByName(n)!.getWorldPosition(new THREE.Vector3());
    for (const s of ['Left', 'Right']) {
      const knee = w(s + 'LowerLeg').sub(w(s + 'UpperLeg')).normalize();
      expect(knee.y, `${s}: бедро модели вертикально`).toBeLessThan(-0.99999);
      const shin = w(s + 'Foot').sub(w(s + 'LowerLeg')).normalize();
      expect(shin.y, `${s}: голень модели вертикально`).toBeLessThan(-0.99999);
      const toe = w(s + 'Toes').sub(w(s + 'Foot'));
      expect(Math.atan2(toe.x, toe.z) / D, `${s}: носок модели вперёд`).toBeCloseTo(0, 4);
    }
  });
});
