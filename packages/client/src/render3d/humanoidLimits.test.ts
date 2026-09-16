import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';

// humanoidRagdoll тянет Jolt через ragdoll.ts (wasm + DOM) — для таблицы пределов он не нужен.
vi.mock('./ragdoll.js', () => ({ jolt: () => { throw new Error('jolt is not available in node'); } }));

import { limitViewForBone, jointLimitView, JOINT_DEF, jointOv, joltSwing, physSwingOf, type LimitView } from './humanoidRagdoll.js';
import { clampLocalToLimit } from './jointClamp.js';

/**
 * СТОРОЖ ПРЕДЕЛОВ СУСТАВОВ (жалоба 16.09.2026). Меряем не числа в таблице, а то, КУДА РЕАЛЬНО ДОХОДИТ КОСТЬ
 * через клэмп редактора: поворот на угол чуть больше предела обязан встать ровно на предел, а чуть меньше —
 * пройти нетронутым. Направления сверены пробой: риг смотрит в +Z, Left = +X, рест-кватернионы единичные.
 */
const D = Math.PI / 180;
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).normalize();

/** Угол, на котором кость реально встаёт при повороте вокруг `axis` (свип с шагом 1°, клэмп после каждого шага). */
function reach(bone: string, axis: THREE.Vector3, maxDeg = 175): number {
  const view = limitViewForBone(bone); if (!view) throw new Error('no limit for ' + bone);
  let got = 0;
  for (let d = 1; d <= maxDeg; d++) {
    const q = clampLocalToLimit(new THREE.Quaternion().setFromAxisAngle(axis, d * D), view);
    const a = 2 * Math.atan2(q.x * axis.x + q.y * axis.y + q.z * axis.z, q.w);
    if (a < got - 1e-6 || a < d * D - 1e-4) { got = Math.max(got, a); break; }
    got = a;
  }
  return got / D;
}

afterEach(() => { for (const k in jointOv) delete jointOv[k]; });

describe('носок: вверх больше, чем вниз', () => {
  it('кончик вверх (−X) 60°, вниз (+X) 40° — на обеих ногах', () => {
    for (const b of ['LeftToes', 'RightToes']) {
      expect(reach(b, V(-1, 0, 0))).toBeCloseTo(60.2, 0);
      expect(reach(b, V(1, 0, 0))).toBeCloseTo(40.1, 0);
    }
  });
  it('+X действительно опускает кончик носка', () => {
    const tip = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), 20 * D));
    expect(tip.y).toBeLessThan(0);
  });
  it('слайдер «сгиб» остался ВНИЗ: оверрайд {flex, hyperext} читается как раньше', () => {
    expect(JOINT_DEF.toe!.flex).toBeCloseTo(0.7, 6);
    expect(JOINT_DEF.toe!.hyperext).toBeCloseTo(1.05, 6);
    jointOv.toe = { flex: 0.6, hyperext: 0.15 };
    const v = jointLimitView('ToeR')!;
    expect(v.max).toBeCloseTo(0.6, 6);    // вниз
    expect(v.min).toBeCloseTo(-0.15, 6);  // вверх
  });
  it('колено и локоть: диапазоны и сторона сгиба не поменялись', () => {
    for (const [b, lo, hi] of [['ShinL', -0.05, 2.2], ['ShinR', -0.05, 2.2], ['ForeL', -2.4, 0.1], ['ForeR', -0.1, 2.4]] as const) {
      const v = jointLimitView(b)!;
      expect([v.min, v.max]).toEqual([lo, hi]);
    }
    jointOv.knee = { flex: 2.0, hyperext: 0.1 };
    expect(jointLimitView('ShinR')!.max).toBeCloseTo(2.0, 6);   // слайдер «сгиб» колена — по-прежнему max
  });
});

describe('стопа', () => {
  it('влево-вправо (рыск вокруг голени) ±45°', () => {
    for (const b of ['LeftFoot', 'RightFoot']) {
      expect(reach(b, V(0, 1, 0))).toBeCloseTo(45, 0);
      expect(reach(b, V(0, -1, 0))).toBeCloseTo(45, 0);
    }
  });
  it('носок вверх 40°, вниз 60°, крен ±30°', () => {
    for (const b of ['LeftFoot', 'RightFoot']) {
      expect(reach(b, V(-1, 0, 0))).toBeCloseTo(40.1, 0);
      expect(reach(b, V(1, 0, 0))).toBeCloseTo(60.2, 0);
      expect(reach(b, V(0, 0, 1))).toBeCloseTo(29.8, 0);
      expect(reach(b, V(0, 0, -1))).toBeCloseTo(29.8, 0);
    }
  });
});

describe('бедро: колено к животу', () => {
  it('сгиб (−X, колено вперёд) 130°, разгиб 51.6° — гейт машет ±0.7 и должен влезать', () => {
    for (const b of ['LeftUpperLeg', 'RightUpperLeg']) {
      expect(reach(b, V(-1, 0, 0))).toBeCloseTo(130.1, 0);
      expect(reach(b, V(1, 0, 0))).toBeCloseTo(51.6, 0);
    }
    const knee = new THREE.Vector3(0, -1, 0).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(V(-1, 0, 0), 120 * D));
    expect(knee.y).toBeGreaterThan(0.4);  // при 120° колено уже ВЫШЕ тазобедренного сустава
    expect(knee.z).toBeGreaterThan(0.8);  // и спереди
  });
});

describe('спина: три сегмента в сумме', () => {
  /** Составной поворот цепи Spine→Chest→UpperChest, каждый сегмент — до своего предела. */
  function chain(axis: THREE.Vector3): number {
    let total = 0;
    for (const b of ['Spine', 'Chest', 'UpperChest']) total += reach(b, axis);
    return total;
  }
  it('сгиб 90°, разгиб 50°, бок ±45°, скрутка ±60°', () => {
    expect(chain(V(1, 0, 0))).toBeCloseTo(90, 0);
    expect(chain(V(-1, 0, 0))).toBeCloseTo(49.8, 0);
    expect(chain(V(0, 0, 1))).toBeCloseTo(45.3, 0);
    expect(chain(V(0, 0, -1))).toBeCloseTo(45.3, 0);
    expect(chain(V(0, 1, 0))).toBeCloseTo(60.2, 0);
  });
  it('один сегмент поясницы — треть: 30° вперёд', () => {
    expect(reach('Spine', V(1, 0, 0))).toBeCloseTo(30, 0);
  });
});

describe('зеркало правой стороны при асимметричном тюне', () => {
  it('отведение бедра одинаково на обеих ногах (левое наружу = +Z, правое = −Z)', () => {
    jointOv.hip = { normalMin: -0.2, normalMax: 1.4 };
    expect(reach('LeftUpperLeg', V(0, 0, 1))).toBeCloseTo(80.2, 0);
    expect(reach('RightUpperLeg', V(0, 0, -1))).toBeCloseTo(80.2, 0);
    expect(reach('LeftUpperLeg', V(0, 0, -1))).toBeCloseTo(11.5, 0);
    expect(reach('RightUpperLeg', V(0, 0, 1))).toBeCloseTo(11.5, 0);
  });
  it('разворот носка наружу одинаков: левая +Y, правая −Y', () => {
    jointOv.ankle = { twistMin: -0.2, twistMax: 0.8 };
    const outL = reach('LeftFoot', V(0, 1, 0)), outR = reach('RightFoot', V(0, -1, 0));
    expect(outR).toBeCloseTo(outL, 3);
    const inL = reach('LeftFoot', V(0, -1, 0)), inR = reach('RightFoot', V(0, 1, 0));
    expect(inR).toBeCloseTo(inL, 3);
    expect(inL).not.toBeCloseTo(outL, 0);
  });
  it('плечо вперёд одинаково: левое −Y, правое +Y; подъём не переворачивается', () => {
    jointOv.shoulder = { planeMin: -0.3 };
    expect(reach('RightUpperArm', V(0, 1, 0))).toBeCloseTo(reach('LeftUpperArm', V(0, -1, 0)), 3);
    expect(reach('LeftUpperArm', V(0, -1, 0))).toBeCloseTo(17.2, 0);
    jointOv.shoulder = { normalMax: 0.5 };
    expect(reach('RightUpperArm', V(0, 0, -1))).toBeCloseTo(reach('LeftUpperArm', V(0, 0, 1)), 3);
  });
  it('сагиттальные асимметрии (сгиб бедра) правой ноге не переворачиваются', () => {
    const l = jointLimitView('ThighL')!, r = jointLimitView('ThighR')!;
    expect([r.planeMin, r.planeMax]).toEqual([l.planeMin, l.planeMax]);
  });
});

describe('joltSwing: рамка и имена конусов Jolt', () => {
  const rangesOf = (v: LimitView): { plane: [number, number]; normal: [number, number]; twist: [number, number] } =>
    ({ plane: [v.planeMin!, v.planeMax!], normal: [v.normalMin!, v.normalMax!], twist: [v.twistMin!, v.twistMax!] });
  it('наш plane-диапазон уходит в normal-конус Jolt (замер: Jolt plane-конус держит поворот вокруг normal)', () => {
    const v = jointLimitView('ThighL')!;
    const js = joltSwing(v.twist!, v.plane!, rangesOf(v));
    expect(js.normalHalfCone).toBeCloseTo((0.9 + 2.27) / 2, 6);
    expect(js.planeHalfCone).toBeCloseTo(1.4, 6);
  });
  it('сдвинутая рамка ставит конус ровно на [planeMin, planeMax]', () => {
    for (const bone of ['ThighL', 'ThighR', 'FootL', 'FootR', 'Torso', 'ArmR', 'ClavR']) {
      const v = jointLimitView(bone)!;
      const js = joltSwing(v.twist!, v.plane!, rangesOf(v));
      const t1 = new THREE.Vector3(...js.twist1), t2 = new THREE.Vector3(...js.twist2), pl = new THREE.Vector3(...js.plane);
      const angAt = (th: number): number => t1.angleTo(t2.clone().applyAxisAngle(pl, th));
      expect(angAt(v.planeMin!)).toBeCloseTo(js.normalHalfCone, 5);
      expect(angAt(v.planeMax!)).toBeCloseTo(js.normalHalfCone, 5);
      expect(angAt((v.planeMin! + v.planeMax!) / 2)).toBeCloseTo(0, 5);
      expect(angAt(v.planeMin! - 0.1)).toBeGreaterThan(js.normalHalfCone);
      expect(Math.abs(t1.dot(pl))).toBeLessThan(1e-9);    // ось twist осталась ⟂ plane — рамка Jolt ортонормальна
    }
  });
  it('в покое кукла внутри конуса (рест не за пределом)', () => {
    for (const bone of ['ThighL', 'FootL', 'Torso', 'Head', 'ArmL']) {
      const v = jointLimitView(bone)!;
      expect(v.planeMin!).toBeLessThanOrEqual(0);
      expect(v.planeMax!).toBeGreaterThanOrEqual(0);
    }
  });
  it('физ-потолок бедра: редактор 130°, кукла Jolt 60° (иначе в смерти складывается пополам)', () => {
    expect(jointLimitView('ThighL')!.planeMin).toBeCloseTo(-2.27, 6);
    for (const b of ['ThighL', 'ThighR']) {
      const js = physSwingOf(b)!;
      expect(js.normalHalfCone).toBeCloseTo((0.9 + 1.05) / 2, 6);                        // [−1.05, 0.9]
      const t1 = new THREE.Vector3(...js.twist1), t2 = new THREE.Vector3(...js.twist2), pl = new THREE.Vector3(...js.plane);
      expect(t1.angleTo(t2.clone().applyAxisAngle(pl, -1.05))).toBeCloseTo(js.normalHalfCone, 5);
    }
    // потолок только у сгиба бедра: стопа и спина в физике = редактор
    const f = jointLimitView('FootL')!, jf = physSwingOf('FootL')!;
    expect(jf.normalHalfCone).toBeCloseTo((f.planeMax! - f.planeMin!) / 2, 6);
    // ручной тюн уже потолка не расширяет физику, но и не сужается им сверх нужного
    jointOv.hip = { planeMin: -0.5 };
    expect(physSwingOf('ThighL')!.normalHalfCone).toBeCloseTo((0.9 + 0.5) / 2, 6);
  });
  it('твист правой ноги зеркален так же, как в клэмпе редактора', () => {
    jointOv.hip = { twistMin: -0.2, twistMax: 0.6 };
    const v = jointLimitView('ThighR')!;
    const js = joltSwing(v.twist!, v.plane!, rangesOf(v));
    expect([js.twistMin, js.twistMax]).toEqual([v.twistMin, v.twistMax]);
    expect(js.twistMin).toBeCloseTo(-0.6, 6);
  });
});
