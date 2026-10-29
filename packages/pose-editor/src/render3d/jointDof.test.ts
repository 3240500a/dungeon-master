import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { dofSpec, quatFromDof, clampDof, dofFromQuat, ringDelta, ringAxis, gimbalFrame, swingRing, type Dof } from './jointDof.js';
import type { LimitView } from './humanoidRagdoll.js';

// РЕАЛЬНЫЕ оси/пределы из humanoidRagdoll (НЕ выдуманные — на этом уже обжигался):
//   ArmL:  swing([-1.7,1.7] plane, [-1.9,1.9] normal, [-1.6,1.6] twist, twist=[1,0,0], plane=[0,1,0])
//   ForeL: hinge([-2.4, 0.1], axis=[0,1,0])
const SH = { kind: 'swing', group: 'arm', canon: 't', twist: [1, 0, 0], plane: [0, 1, 0], normal: [0, 0, 1],
  planeMin: -1.7, planeMax: 1.7, normalMin: -1.9, normalMax: 1.9, twistMin: -1.6, twistMax: 1.6 } as unknown as LimitView;
const EL = { kind: 'hinge', group: 'arm', canon: 't', axis: [0, 1, 0], hingeNormal: [1, 0, 0],
  min: -2.4, max: 0.1 } as unknown as LimitView;

const D = 180 / Math.PI;
const T_AXIS = new THREE.Vector3(1, 0, 0);                     // ось плеча в T-позе (она же ось твиста)
const boneAxis = (view: LimitView, th: Dof): THREE.Vector3 =>
  dofSpec(view).axes[2].clone().applyQuaternion(quatFromDof(view, th));
const ringAxisOf = (view: LimitView, th: Dof, i: number): THREE.Vector3 =>
  new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyQuaternion(gimbalFrame(view, th));
/** Позы по всей рабочей области плеча, включая ту, где эйлер схлопывался (сгиб ≈ 90°). */
const POSES: [string, Dof][] = [
  ['T-поза', [0, 0, 0]],
  ['рука вниз', [0, -90 / D, 0]],
  ['рука вверх', [0, 90 / D, 0]],
  ['рука вперёд (сгиб 90) ← тут эйлер схлопывался', [90 / D, 0, 0]],
  ['занесена вперёд-вверх + твист', [88 / D, 55 / D, 40 / D]],
  ['у предела сгиба', [97 / D, -30 / D, -50 / D]],
];

describe('jointDof — параметризация замкнута и однозначна', () => {
  it('quatFromDof(dofFromQuat(q)) === q для произвольных поз', () => {
    for (const [a, b, c] of [[0.4, -0.3, 0.9], [1.2, 0.1, -0.7], [-1.5, 0.6, 0.2], [1.6, 1.8, 1.5]] as Dof[]) {
      const q = quatFromDof(SH, [a, b, c]);
      expect(quatFromDof(SH, dofFromQuat(SH, q)).angleTo(q)).toBeLessThan(1e-6);
    }
  });

  it('разложение однозначно: ветвей, как у эйлера, нет — второй прогон даёт то же', () => {
    for (const [, th] of POSES) {
      const q = quatFromDof(SH, th);
      const a = dofFromQuat(SH, q), b = dofFromQuat(SH, q, [0, 0, 0]);
      for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 9);
    }
  });

  it('шарнир = ОДНА степень свободы (две оси заперты)', () => {
    const s = dofSpec(EL);
    expect(s.locked.filter(Boolean).length).toBe(2);
    const q = quatFromDof(EL, [0, 0, -90 / D]);
    expect(Math.abs(new THREE.Vector3(1, 0, 0).applyQuaternion(q).dot(new THREE.Vector3(0, 1, 0)))).toBeLessThan(1e-6);
    expect(dofFromQuat(EL, q)[2]! * D).toBeCloseTo(-90, 3);
  });

  it('запертая ось всегда 0, даже если попросили угол', () => {
    expect(clampDof(EL, [1.0, 0, 0])[0]).toBe(0);
    expect(clampDof(EL, [0, 1.0, 0])[1]).toBe(0);
  });
});

// ГЛАВНЫЙ ТЕСТ ЭТОЙ МОДЕЛИ. Эйлерова цепочка (была до этого) вырождается на ±90° средней оси, и у плеча это
// ДОСТИЖИМО: средняя ось — сгиб с пределом ±97.4°. ЗАМЕР в рабочей позе (рука занесена вперёд, сгиб 90°): угол
// между осями «подъём» и «твист» вырос 90° → 180°, они схлопнулись, кольцо подъёма перестало двигать руку вообще.
// Жалоба юзера дословно: «плечо упирается и выше не поднимается, две оси стали твистами, в T-позу не вернуть».
describe('jointDof — ВЫРОЖДЕНИЙ НЕТ НИГДЕ (то, на чём сломался эйлер)', () => {
  it('оси колец ортогональны в ЛЮБОЙ позе — включая ту, где эйлер схлопывался', () => {
    for (const [name, th] of POSES) {
      const a = [0, 1, 2].map((i) => ringAxisOf(SH, th, i));
      expect(a[0]!.angleTo(a[1]!) * D, name).toBeCloseTo(90, 6);
      expect(a[1]!.angleTo(a[2]!) * D, name).toBeCloseTo(90, 6);
      expect(a[0]!.angleTo(a[2]!) * D, name).toBeCloseTo(90, 6);
    }
  });

  it('оба кольца свинга РЕАЛЬНО двигают кость, и в НЕЗАВИСИМЫХ направлениях', () => {
    for (const [name, th] of POSES) {
      const bone = boneAxis(SH, th);
      // мгновенное смещение оси кости от кольца i = axis_i × bone
      const d0 = new THREE.Vector3().crossVectors(ringAxisOf(SH, th, 0), bone);
      const d1 = new THREE.Vector3().crossVectors(ringAxisOf(SH, th, 1), bone);
      expect(d0.length(), `${name} кольцо 0 мертво`).toBeGreaterThan(0.9);
      expect(d1.length(), `${name} кольцо 1 мертво`).toBeGreaterThan(0.9);
      expect(d0.angleTo(d1) * D, `${name} кольца стали одним`).toBeCloseTo(90, 4);
    }
  });

  it('кольцо ТВИСТА обнимает кость в любой позе и оси кости не двигает', () => {
    for (const [name, th] of POSES) {
      expect(Math.abs(ringAxisOf(SH, th, 2).dot(boneAxis(SH, th))), name).toBeCloseTo(1, 9);
      for (const tw of [-80, 80]) {
        const moved = boneAxis(SH, [th[0], th[1], th[2] + tw / D]);
        expect(moved.angleTo(boneAxis(SH, th)) * D, `${name} твист ${tw}`).toBeLessThan(1e-6);
      }
    }
  });

  it('шарнир: единственное кольцо стоит на оси сгиба при любом угле', () => {
    for (const bend of [0, -60, -130]) {
      expect(Math.abs(ringAxisOf(EL, [0, 0, bend / D], 2).dot(new THREE.Vector3(0, 1, 0)))).toBeCloseTo(1, 9);
    }
  });
});

describe('jointDof — драг кольца: кость идёт РОВНО за кольцом, твист не появляется сам', () => {
  it('кольцо свинга поворачивает кость точно вокруг НАРИСОВАННОЙ оси', () => {
    for (const [name, th0] of POSES) {
      for (const ring of [0, 1]) {
        const axis = ringAxisOf(SH, th0, ring), before = boneAxis(SH, th0);
        for (const phi of [15, -40, 75]) {
          const want = before.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, phi / D));
          const got = boneAxis(SH, swingRing(SH, th0, ring, phi / D));
          expect(got.angleTo(want) * D, `${name} кольцо ${ring} ${phi}°`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('кольцо свинга НЕ наливает твист (это и было «предплечье выкручивает»)', () => {
    for (const [name, th0] of POSES) {
      for (const ring of [0, 1]) for (const phi of [30, -60]) {
        expect(swingRing(SH, th0, ring, phi / D)[2], `${name} кольцо ${ring}`).toBeCloseTo(th0[2]!, 12);
      }
    }
  });

  it('кольцо твиста правит только твист, свинг не трогает', () => {
    for (const [name, th0] of POSES) {
      const r = swingRing(SH, th0, 2, 50 / D);
      expect(r[0], name).toBeCloseTo(th0[0]!, 12);
      expect(r[1], name).toBeCloseTo(th0[1]!, 12);
      expect(r[2]! - th0[2]!, name).toBeCloseTo(50 / D, 12);
    }
  });

  it('драг туда-обратно в одном захвате возвращает ТОЧНО (накопитель, а не поза)', () => {
    for (const [name, th0] of POSES) for (const ring of [0, 1, 2]) {
      const back = swingRing(SH, th0, ring, 0);
      for (let i = 0; i < 3; i++) expect(back[i], `${name} кольцо ${ring}`).toBeCloseTo(th0[i]!, 9);
    }
  });
});

describe('jointDof — сценарии из жалоб', () => {
  /** Драг: угол копится от захвата, каждый кадр поза пересобирается из th0 + acc (как в редакторе). */
  const drag = (view: LimitView, th0: Dof, ring: number, deltasDeg: number[]): Dof[] => {
    const out: Dof[] = []; let acc = 0;
    for (const d of deltasDeg) { acc += d / D; out.push(clampDof(view, swingRing(view, th0, ring, acc))); }
    return out;
  };

  it('(а) из T-позы вниз 90° и обратно 90° → ТОЧНО исходное', () => {
    const seq = drag(SH, [0, 0, 0], 1, [...Array(90).fill(-1), ...Array(90).fill(1)] as number[]);
    expect(quatFromDof(SH, seq[seq.length - 1]!).angleTo(new THREE.Quaternion())).toBeLessThan(1e-9);
  });

  it('(б) рука вниз + ведём кольцо сгиба → твист остаётся РОВНО 0, кость идёт за кольцом', () => {
    const down: Dof = [0, -90 / D, 0];
    const axis = ringAxisOf(SH, down, 0), start = boneAxis(SH, down);
    let acc = 0;
    for (let i = 1; i <= 90; i++) {
      acc += 1 / D;
      const th = swingRing(SH, down, 0, acc);
      expect(th[2]).toBe(0);                                                   // ← твист не появляется вообще
      const want = start.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, acc));
      expect(boneAxis(SH, th).angleTo(want) * D).toBeLessThan(1e-6);           // ← и кость ровно на кольце
    }
  });

  it('(в) крутим дальше предела → упирается и НЕ перескакивает на противоположный', () => {
    const seq = drag(EL, [0, 0, 0], 2, Array(400).fill(-1) as number[]);
    for (let i = 140; i < seq.length; i++) expect(seq[i]![2]! * D).toBeCloseTo(-137.5, 0);
  });

  it('(в2) то же КОЛЬЦОМ СВИНГА: композиция не должна провернуться через 180°', () => {
    // ЗАМЕР живьём (без потолка): 400° по кольцу подъёма давали свинг −40° вместо упора −108.9°, а ещё 60° — −100°:
    // композиция свинга прошла через π, ось вектора поворота сменила знак, и кость сорвалась с упора.
    const seq = drag(SH, [0, 0, 0], 1, Array(400).fill(-1) as number[]);
    for (let i = 150; i < seq.length; i++) {
      expect(seq[i]![1]! * D, `шаг ${i}`).toBeCloseTo(-108.86, 1);   // стоит на пределе
      expect(Math.abs(seq[i]![0]! * D), `шаг ${i}`).toBeLessThan(1);  // и не уползает вбок
    }
  });

  it('(г) поза «топор занесён» (сгиб ≈ 90°): рука поднимается и ВОЗВРАЩАЕТСЯ в T-позу', () => {
    const axe: Dof = [88 / D, 55 / D, 40 / D];
    // подъём кольцом 1 работает — раньше в этой позе оно было мертво
    const up = drag(SH, axe, 1, Array(40).fill(1) as number[]);
    expect(boneAxis(SH, up[39]!).angleTo(boneAxis(SH, axe)) * D).toBeGreaterThan(30);
    // и обратно к T-позе: двумя кольцами свинга ось кости приводится к исходной
    let th: Dof = axe;
    for (let it = 0; it < 40; it++) {
      for (const ring of [0, 1]) {
        const axis = ringAxisOf(SH, th, ring);
        const cur = boneAxis(SH, th);
        const err = new THREE.Vector3().crossVectors(cur, T_AXIS);             // куда надо повернуть
        const phi = err.dot(axis) * 0.9;                                       // шаг вдоль этого кольца
        th = clampDof(SH, swingRing(SH, th, ring, phi));
      }
    }
    expect(boneAxis(SH, th).angleTo(T_AXIS) * D).toBeLessThan(1);
  });
});

describe('jointDof — слой гизмо (снятие угла с TransformControls)', () => {
  it('ось кольца распознаётся, угол снимается 1:1 и перебег через ±180° не рвётся', () => {
    const qStart = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 0.5, -0.8).normalize(), 1.1);
    const unit = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    for (let axis = 0; axis < 3; axis++) {
      let raw = 0, acc = 0, ax = -1;
      for (let i = 1; i <= 800; i++) {
        const phi = (400 / 800) * i / D;
        const qNow = qStart.clone().multiply(new THREE.Quaternion().setFromAxisAngle(unit[axis]!, phi)).normalize();
        const dq = qStart.clone().invert().multiply(qNow);
        if (ax < 0) ax = ringAxis(dq);
        const [r, step] = ringDelta(dq, ax, raw); raw = r; acc += step;
      }
      expect(ax).toBe(axis);
      expect(acc * D).toBeCloseTo(400, 4);
    }
  });
});
