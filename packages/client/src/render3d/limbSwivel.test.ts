import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';

// humanoidRagdoll тянет Jolt через ragdoll.ts (wasm + DOM) — для таблицы пределов он не нужен.
vi.mock('./ragdoll.js', () => ({ jolt: () => { throw new Error('jolt is not available in node'); } }));

import { buildHumanoid } from './humanoid.js';
import { planeSwivel, hingePoleLocal, hingeBendSign, perpTo } from './limbIk.js';
import { limitViewForBone, jointOv } from './humanoidRagdoll.js';
import { findPreset } from './jointLimits.js';

/**
 * СВИВЕЛЬ КОЛЕНА ИЗ ТВИСТА БЕДРА — сторож против «кручу любую кость, правая нога прыгает в непонятный угол».
 *
 * Запиненная нога дорешается `solveLimb` с полюсом `naturalPole` (колено вперёд по тазу + угол свивеля). Пока угол
 * не записан, авторская ротация бедра стирается: замер на клипах воина — правая нога 16–20°, ключ удара до 37°.
 * Редактор теперь пишет свивель = `planeSwivel(ось бедро→лодыжка, полюс шарнира, натураль)`, где полюс шарнира —
 * `hingePoleLocal` в фрейме бедра. Здесь проверяется, что этот угол, применённый ТАК ЖЕ, как в `naturalPole`,
 * воспроизводит плоскость колена точно, и что сама плоскость шарнира совпадает с реальным выносом колена.
 */
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const Q = (): THREE.Quaternion => new THREE.Quaternion();
const PI = Math.PI;
const rotAbout = (v: THREE.Vector3, axis: THREE.Vector3, a: number): THREE.Vector3 =>
  v.clone().applyQuaternion(Q().setFromAxisAngle(axis.clone().normalize(), a));
const unitPerp = (v: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 => perpTo(v, axis.clone().normalize()).normalize();

describe('planeSwivel — угол между полюсами вокруг оси', () => {
  it('знак — как в `naturalPole`: +Z вокруг +Y на +90° ложится на +X', () => {
    expect(planeSwivel(V(0, 1, 0), V(1, 0, 0), V(0, 0, 1))!).toBeCloseTo(PI / 2, 12);
    expect(planeSwivel(V(0, 1, 0), V(-1, 0, 0), V(0, 0, 1))!).toBeCloseTo(-PI / 2, 12);
    expect(planeSwivel(V(0, -1, 0), V(1, 0, 0), V(0, 0, 1))!).toBeCloseTo(-PI / 2, 12);   // ось перевернули — знак тоже
  });

  it('известные углы на произвольных осях: поворот натурали на результат даёт `cur`', () => {
    const axes = [V(0, 1, 0), V(0.3, -0.9, 0.2), V(-0.7, 0.1, 0.7), V(1, 1, 1)];
    const angs = [0, 0.3, -0.3, 1.2, -2.0, 2.9, -2.9, PI - 1e-4, -(PI - 1e-4)];
    for (const ax of axes) {
      const u = ax.clone().normalize();
      const nat = unitPerp(V(0.2, 0.4, 1), u);
      for (const a of angs) {
        const cur = rotAbout(nat, u, a);
        const sw = planeSwivel(ax, cur, nat)!;
        expect(sw, `ось ${ax.toArray()} угол ${a}`).toBeCloseTo(a, 9);
        expect(rotAbout(nat, u, sw).distanceTo(cur)).toBeLessThan(1e-9);
      }
    }
  });

  it('у ±π знак не прыгает: результат в (−π, π] и поворот на него всё равно попадает', () => {
    const u = V(0, 1, 0), nat = V(0, 0, 1);
    for (const a of [PI + 0.05, -PI - 0.05, 2 * PI - 0.1, PI]) {
      const cur = rotAbout(nat, u, a);
      const sw = planeSwivel(u, cur, nat)!;
      expect(sw).toBeGreaterThan(-PI - 1e-12); expect(sw).toBeLessThanOrEqual(PI + 1e-12);
      expect(rotAbout(nat, u, sw).distanceTo(cur)).toBeLessThan(1e-9);
    }
    expect(planeSwivel(u, rotAbout(nat, u, PI + 0.05), nat)!).toBeCloseTo(-PI + 0.05, 9);
    expect(planeSwivel(u, rotAbout(nat, u, -PI - 0.05), nat)!).toBeCloseTo(PI - 0.05, 9);
  });

  it('вырождение — null: вектор вдоль оси, нулевой вектор, нулевая ось', () => {
    const u = V(0, 1, 0);
    expect(planeSwivel(u, V(0, 5, 0), V(0, 0, 1))).toBeNull();
    expect(planeSwivel(u, V(1, 0, 0), V(0, -2, 0))).toBeNull();
    expect(planeSwivel(u, V(0, 0, 0), V(0, 0, 1))).toBeNull();
    expect(planeSwivel(V(0, 0, 0), V(1, 0, 0), V(0, 0, 1))).toBeNull();
    expect(planeSwivel(u, V(1e-6, 1, 0), V(0, 0, 1))).toBeNull();          // в пределах 1e-4 рад от оси — плоскости нет
  });

  it('инвариантен к не-перпендикулярным входам, их длине и длине оси', () => {
    const u = V(0.3, -0.9, 0.2).normalize();
    const nat = unitPerp(V(1, 0, 0), u), cur = rotAbout(nat, u, 0.7);
    const ref = planeSwivel(u, cur, nat)!;
    expect(ref).toBeCloseTo(0.7, 9);
    expect(planeSwivel(u, cur.clone().multiplyScalar(3).addScaledVector(u, 5), nat.clone().multiplyScalar(0.2).addScaledVector(u, -7))!).toBeCloseTo(ref, 9);
    expect(planeSwivel(u.clone().multiplyScalar(4), cur, nat)!).toBeCloseTo(ref, 9);
  });
});

describe('hingePoleLocal — куда выпирает средний сустав', () => {
  const near = (a: THREE.Vector3, b: THREE.Vector3): void => { expect(a.distanceTo(b), `${a.toArray()} vs ${b.toArray()}`).toBeLessThan(1e-12); };
  it('колено: ось (1,0,0), сгиб к max (+1), голень вниз → вперёд (0,0,1)', () => near(hingePoleLocal(V(1, 0, 0), 1, V(0, -1, 0)), V(0, 0, 1)));
  it('левый локоть: ось (0,1,0), сгиб к min (−1), предплечье +X → (0,0,−1)', () => near(hingePoleLocal(V(0, 1, 0), -1, V(1, 0, 0)), V(0, 0, -1)));
  it('правый локоть: ось (0,1,0), сгиб к max (+1), предплечье −X → (0,0,−1)', () => near(hingePoleLocal(V(0, 1, 0), 1, V(-1, 0, 0)), V(0, 0, -1)));
  it('длина звена не важна — результат единичный', () => near(hingePoleLocal(V(1, 0, 0), 1, V(0, -14, 0)), V(0, 0, 1)));
});

describe('круговой прогон на риге: свивель из шарнира воспроизводит плоскость колена', () => {
  // ⚠ Точная копия ножной ветки `naturalPole` (pose-editor.ts): предпочтение +Z во фрейме таза ⫫ линии тяги,
  // свивель — УГЛОМ вокруг линии тяги ВО ФРЕЙМЕ ТАЗА, потом обратно в мир. Знак проверяется именно этой композицией.
  const naturalLegPole = (hq: THREE.Quaternion, S: THREE.Vector3, target: THREE.Vector3, swivel: number): THREE.Vector3 => {
    const u = target.clone().sub(S).applyQuaternion(hq.clone().invert()).normalize();
    const p = perpTo(V(0, 0, 1), u).normalize();
    if (swivel) p.applyQuaternion(Q().setFromAxisAngle(u, swivel));
    return p.applyQuaternion(hq);
  };
  const KNEE_AXIS = V(1, 0, 0);                                  // ось шарнира ShinL/ShinR, диапазон [−0.05, 2.2] → сгиб к max, flexSign +1

  for (const side of ['Left', 'Right'] as const) {
    it(`${side}: бедро развёрнуто по Y, колено согнуто — 1e-6 по плоскости`, () => {
      let cases = 0;
      for (const twist of [-0.3, 0.3])
        for (const swing of [0, 0.35])
          for (const bend of [0.2, 0.8, 1.6])
            for (const hipsYaw of [0, 0.6]) {
              const h = buildHumanoid({});
              h.hips.rotation.set(0.1, hipsYaw, -0.05);
              const thigh = h.bones.get(`${side}UpperLeg`)!, shin = h.bones.get(`${side}LowerLeg`)!, foot = h.bones.get(`${side}Foot`)!;
              thigh.rotation.set(-swing, twist, 0);
              shin.quaternion.setFromAxisAngle(KNEE_AXIS, bend);
              h.root.updateMatrixWorld(true);
              const S = thigh.getWorldPosition(V(0, 0, 0)), K = shin.getWorldPosition(V(0, 0, 0)), H = foot.getWorldPosition(V(0, 0, 0));
              const axis = H.clone().sub(S).normalize();
              const hq = h.hips.getWorldQuaternion(Q());
              const pole = hingePoleLocal(KNEE_AXIS, 1, foot.position.clone().normalize()).applyQuaternion(thigh.getWorldQuaternion(Q()));
              // 1) плоскость шарнира = РЕАЛЬНЫЙ вынос колена от линии «бедро → лодыжка» (прямая в T-позе нога)
              expect(unitPerp(pole, axis).distanceTo(unitPerp(K.clone().sub(S), axis)), `шарнир vs колено tw=${twist} b=${bend}`).toBeLessThan(1e-6);
              // 2) угол от натурали, применённый как в `naturalPole`, возвращает ту же плоскость
              const sw = planeSwivel(axis, pole, naturalLegPole(hq, S, H, 0));
              expect(sw).not.toBeNull();
              const got = naturalLegPole(hq, S, H, sw!);
              expect(unitPerp(got, axis).distanceTo(unitPerp(pole, axis)), `круг tw=${twist} sw=${swing} b=${bend} yaw=${hipsYaw}`).toBeLessThan(1e-6);
              cases++;
            }
      expect(cases).toBe(24);
    });
  }

  it('развёрнутое бедро даёт НЕНУЛЕВОЙ свивель со знаком твиста, зеркальный у левой и правой', () => {
    const swOf = (side: 'Left' | 'Right', twist: number): number => {
      const h = buildHumanoid({});
      const thigh = h.bones.get(`${side}UpperLeg`)!, shin = h.bones.get(`${side}LowerLeg`)!, foot = h.bones.get(`${side}Foot`)!;
      thigh.rotation.set(0, twist, 0); shin.quaternion.setFromAxisAngle(KNEE_AXIS, 0.8);
      h.root.updateMatrixWorld(true);
      const S = thigh.getWorldPosition(V(0, 0, 0)), H = foot.getWorldPosition(V(0, 0, 0));
      const pole = hingePoleLocal(KNEE_AXIS, 1, foot.position.clone().normalize()).applyQuaternion(thigh.getWorldQuaternion(Q()));
      return planeSwivel(H.clone().sub(S), pole, naturalLegPole(h.hips.getWorldQuaternion(Q()), S, H, 0))!;
    };
    // Ось «бедро → лодыжка» смотрит ВНИЗ, поэтому твист по +Y читается свивелем с обратным знаком. Модуль — не меньше
    // половины твиста: именно столько `naturalPole` без свивеля и стирал (замер воина: правое бедро Y ≈ −0.28).
    for (const side of ['Left', 'Right'] as const) {
      const a = swOf(side, -0.3), b = swOf(side, 0.3);
      expect(Math.abs(a)).toBeGreaterThan(0.15);
      expect(a).toBeCloseTo(-b, 9);
      expect(Math.sign(a)).toBe(1);
    }
    expect(swOf('Left', 0)).toBeCloseTo(0, 9);
  });
});

describe('hingeBendSign — сторона сгиба та же, что гнёт `setHingeBend`', () => {
  afterEach(() => { for (const k in jointOv) delete jointOv[k]; });
  /** Колено согнуто РОВНО так, как его ставит солв (`setHingeBend`: знак × угол), бедро развёрнуто. Угол между
   *  полюсом шарнира и реальным выносом колена от линии «бедро → лодыжка», градусы. */
  const poleErrDeg = (side: 'Left' | 'Right', sign: 1 | -1): number => {
    const vm = limitViewForBone(`${side}LowerLeg`)!;
    const ax = V(vm.axis![0], vm.axis![1], vm.axis![2]).normalize();
    const h = buildHumanoid({});
    const thigh = h.bones.get(`${side}UpperLeg`)!, shin = h.bones.get(`${side}LowerLeg`)!, foot = h.bones.get(`${side}Foot`)!;
    thigh.rotation.set(-0.2, 0.3, 0); shin.quaternion.setFromAxisAngle(ax, hingeBendSign(vm) * 0.9);
    h.root.updateMatrixWorld(true);
    const S = thigh.getWorldPosition(V(0, 0, 0)), K = shin.getWorldPosition(V(0, 0, 0)), H = foot.getWorldPosition(V(0, 0, 0));
    const axis = H.clone().sub(S).normalize();
    const pole = hingePoleLocal(ax, sign, foot.position.clone().normalize()).applyQuaternion(thigh.getWorldQuaternion(Q()));
    return Math.acos(Math.max(-1, Math.min(1, unitPerp(pole, axis).dot(unitPerp(K.clone().sub(S), axis))))) * 180 / PI;
  };

  it('человек: колено гнётся в +1 на обеих ногах, полюс шарнира = реальное колено', () => {
    for (const side of ['Left', 'Right'] as const) {
      expect(hingeBendSign(limitViewForBone(`${side}LowerLeg`)!)).toBe(1);
      expect(poleErrDeg(side, 1)).toBeLessThan(1e-4);
    }
  });

  it('пресет «дигитигр»: нога гнётся в −1 — плоскость по диапазону, а с каталожным +1 она 180° мимо колена', () => {
    Object.assign(jointOv, findPreset('digitigrade')!.joints);
    for (const side of ['Left', 'Right'] as const) {
      const vm = limitViewForBone(`${side}LowerLeg`)!;
      expect(hingeBendSign(vm)).toBe(-1);
      expect(poleErrDeg(side, hingeBendSign(vm))).toBeLessThan(1e-4);
      expect(poleErrDeg(side, 1)).toBeGreaterThan(179.9);                         // так читал `flexSign` (+1 из каталога)
    }
  });
});
