import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { limitLocalV2, limitSwing, limitTwist, limit1DOF, forgetDrag } from './jointLimitV2.js';
import type { LimitView } from './humanoidRagdoll.js';

// РЕАЛЬНЫЕ оси/пределы из humanoidRagdoll:
//   ArmL:  swing(plane ±1.7, normal ±1.9, twist ±1.6; twist=[1,0,0], plane=[0,1,0], normal=[0,0,1])
//   ForeL: hinge([-2.4, 0.1], axis=[0,1,0])
const SH = { kind: 'swing', group: 'arm', canon: 't', twist: [1, 0, 0], plane: [0, 1, 0], normal: [0, 0, 1],
  planeMin: -1.7, planeMax: 1.7, normalMin: -1.9, normalMax: 1.9, twistMin: -1.6, twistMax: 1.6 } as unknown as LimitView;
const EL = { kind: 'hinge', group: 'arm', canon: 't', axis: [0, 1, 0], hingeNormal: [1, 0, 0],
  min: -2.4, max: 0.1 } as unknown as LimitView;

const D = 180 / Math.PI;
const T = new THREE.Vector3(1, 0, 0), P = new THREE.Vector3(0, 1, 0), N = new THREE.Vector3(0, 0, 1);
const Q = (axis: THREE.Vector3, deg: number): THREE.Quaternion =>
  new THREE.Quaternion().setFromAxisAngle(axis, deg / D);
const bone = (q: THREE.Quaternion): THREE.Vector3 => T.clone().applyQuaternion(q);
/**
 * КРЕН кости относительно ПАРАЛЛЕЛЬНОГО ПЕРЕНОСА — то, что глазами читается как «руку закручивает».
 * Опорой берём минимальную дугу между старой и новой осью кости: это и есть перенос без кручения. Свободный
 * поворот вокруг оси, ПЕРПЕНДИКУЛЯРНОЙ кости, идёт ровно по этой дуге → крен 0; коррекция свинга в `limitSwing`
 * тоже минимальная дуга → крен 0. Ненулевым крен делает только твист, и это правильно.
 */
const roll = (from: THREE.Quaternion, to: THREE.Quaternion): number => {
  const n = bone(to);
  const transport = new THREE.Quaternion().setFromUnitVectors(bone(from), n);
  const ref = P.clone().applyQuaternion(from).applyQuaternion(transport);
  const got = P.clone().applyQuaternion(to);
  const a = ref.addScaledVector(n, -n.dot(ref)).normalize();
  const b = got.addScaledVector(n, -n.dot(got)).normalize();
  return a.angleTo(b) * D;
};

// ГЛАВНОЕ, РАДИ ЧЕГО ВТОРАЯ ВЕРСИЯ. В v1 поза пересобиралась из скаляров, и удержание скаляра твиста вдоль дуги
// свинга давало ГОЛОНОМИЮ: замер — подъём руки на 90° крутил кость вокруг своей оси на 60°. Жалоба юзера:
// «когда поднимаешь руку она крутится вокруг своей оси». Здесь поза = кватернион, предел только останавливает.
describe('jointLimitV2 — свободный поворот НЕ закручивает кость', () => {
  it('подъём руки из любой позы: крен ровно 0 (в v1 было до 60°)', () => {
    for (const start of [Q(P, 0), Q(P, 60), Q(N, -40), Q(P, 30).multiply(Q(T, 35))]) {
      for (const deg of [15, 45, 90]) {
        // кольца v2 ЛОКАЛЬНЫЕ (едут с костью) → ось кольца «подъём» = normal, несомая текущей позой
        const by = new THREE.Quaternion().setFromAxisAngle(N.clone().applyQuaternion(start), deg / D);
        const out = limitLocalV2(by.clone().multiply(start), SH);   // кость просто едет за кольцом
        expect(roll(start, out)).toBeLessThan(1e-4);
      }
    }
  });

  it('внутри пределов клэмп НЕ трогает позу вообще', () => {
    for (const q of [Q(P, 40), Q(N, -70), Q(T, 50), Q(P, 30).multiply(Q(T, 40))]) {
      expect(limitLocalV2(q, SH).angleTo(q) * D).toBeLessThan(1e-3);
    }
  });

  it('клэмп идемпотентен (солвер зовёт его в цикле)', () => {
    for (const q of [Q(P, 170), Q(N, 175), Q(T, 179), Q(P, 150).multiply(Q(T, 150))]) {
      const a = limitLocalV2(q, SH);
      expect(limitLocalV2(a, SH).angleTo(a) * D).toBeLessThan(1e-4);
    }
  });
});

describe('jointLimitV2 — предел свинга: тянет ОСЬ к границе, твист не трогает', () => {
  it('за границей ось кости встаёт на предел', () => {
    expect(bone(limitSwing(Q(P, 150), SH)).angleTo(bone(Q(P, 97.4))) * D).toBeLessThan(0.5);
    expect(bone(limitSwing(Q(N, -160), SH)).angleTo(bone(Q(N, -108.9))) * D).toBeLessThan(0.5);
  });

  it('коррекция свинга НЕ меняет крен (домножается слева)', () => {
    for (const tw of [0, 60, -80]) {
      const q = Q(P, 150).multiply(Q(T, tw));
      expect(roll(q, limitSwing(q, SH))).toBeLessThan(1e-4);   // свинг подвинул ТОЛЬКО ось, крен не тронул
    }
  });

  it('асимметрия соблюдается по каждой стороне', () => {
    const ang = (q: THREE.Quaternion): number => bone(q).angleTo(T) * D;
    expect(ang(limitSwing(Q(P, 179), SH))).toBeCloseTo(97.4, 0);
    expect(ang(limitSwing(Q(P, -179), SH))).toBeCloseTo(97.4, 0);
    expect(ang(limitSwing(Q(N, 179), SH))).toBeCloseTo(108.9, 0);
  });
});

describe('jointLimitV2 — предел твиста: откручивает крен, ОСЬ не трогает', () => {
  it('ось кости после клэмпа твиста та же', () => {
    for (const base of [Q(P, 0), Q(P, 70), Q(N, -90)]) {
      const q = base.clone().multiply(Q(T, 170));
      expect(bone(limitTwist(q, SH)).angleTo(bone(q)) * D).toBeLessThan(1e-6);
    }
  });

  it('крен зажимается в свой диапазон (±91.7°)', () => {
    for (const tw of [150, -150, 179]) {
      const q = Q(P, 30).multiply(Q(T, tw));
      expect(roll(Q(P, 30), limitTwist(q, SH))).toBeLessThan(91.7 + 0.5);
    }
  });
});

describe('jointLimitV2 — шарнир (локоть): ровно одна ось, упор без перескока', () => {
  it('limit1DOF выбрасывает всё, кроме оси сгиба', () => {
    const q = Q(new THREE.Vector3(0.3, 1, 0.4).normalize(), 70);
    const out = limit1DOF(q, new THREE.Vector3(0, 1, 0));
    expect(Math.abs(T.clone().applyQuaternion(out).dot(new THREE.Vector3(0, 1, 0)))).toBeLessThan(1e-6);
  });

  it('свободное вращение через ПОЛНЫЙ оборот — предел не отпускает (накопитель FinalIK)', () => {
    const key = {}; forgetDrag(key);
    let q = new THREE.Quaternion();
    const ax = new THREE.Vector3(0, 1, 0);
    const step = (deg: number): number => {
      q = Q(ax, deg).multiply(q);
      q = limitHingeAngle(q, key);
      return q === q ? angleOf(q, ax) : 0;
    };
    const angleOf = (x: THREE.Quaternion, a: THREE.Vector3): number => {
      const v = new THREE.Vector3(x.x, x.y, x.z);
      return 2 * Math.atan2(v.dot(a), x.w) * D;
    };
    const limitHingeAngle = (x: THREE.Quaternion, k: object): THREE.Quaternion => limitLocalV2(x, EL, k);
    for (let i = 0; i < 140; i++) step(-1);
    for (let i = 0; i < 300; i++) expect(step(-1)).toBeCloseTo(-137.5, 0);   // ещё 300° — держит
  });

  it('обратный ход отпускает и доходит до переразгиба', () => {
    const key = {}; forgetDrag(key);
    let q = new THREE.Quaternion();
    const ax = new THREE.Vector3(0, 1, 0);
    const ang = (x: THREE.Quaternion): number => 2 * Math.atan2(new THREE.Vector3(x.x, x.y, x.z).dot(ax), x.w) * D;
    for (let i = 0; i < 200; i++) q = limitLocalV2(Q(ax, -1).multiply(q), EL, key);
    expect(ang(q)).toBeCloseTo(-137.5, 0);
    for (let i = 0; i < 200; i++) q = limitLocalV2(Q(ax, 1).multiply(q), EL, key);
    expect(ang(q)).toBeCloseTo(5.7, 0);
  });

  it('накопитель ПОКОСТНЫЙ: соседний сустав не влияет', () => {
    const a = {}, b = {}; forgetDrag(a); forgetDrag(b);
    const ax = new THREE.Vector3(0, 1, 0);
    const ang = (x: THREE.Quaternion): number => 2 * Math.atan2(new THREE.Vector3(x.x, x.y, x.z).dot(ax), x.w) * D;
    let qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    for (let i = 0; i < 300; i++) qa = limitLocalV2(Q(ax, -1).multiply(qa), EL, a);
    for (let i = 0; i < 90; i++) qb = limitLocalV2(Q(ax, -1).multiply(qb), EL, b);
    expect(ang(qa)).toBeCloseTo(-137.5, 0);
    expect(ang(qb)).toBeCloseTo(-90, 0);
  });
});

/**
 * ТВИСТ ПОД ПРОТЯЖКОЙ — та же болезнь, что лечил накопитель у шарнира, только у свинга её не лечили.
 *
 * Жалоба: «опять могу перекрутить руку». У кватерниона нет «дальше 180°»: тянешь кольцо дальше — сырой угол
 * перескакивает с +π на −π, и предел послушно зажимает к ПРОТИВОПОЛОЖНОЙ границе. ЗАМЕР на плече (предел ±97°)
 * ДО правки: 200° → −97°, 258° → −97°, а 344° проходил ВООБЩЕ без клэмпа (−16° попадает внутрь). То есть рука
 * на полуобороте скачком уходила в зеркальную скрутку — ровно то, что видно глазами.
 *
 * ⚠ Драг здесь воспроизведён ТАК, КАК ЕГО ВЕДЁТ РЕДАКТОР: сырой поворот каждый кадр пересчитывается ОТ НАЧАЛА
 * протяжки (`deltaWorld · boneWorld0`), а не накручивается на уже зажатый результат. Иначе тест проверял бы не тот путь.
 */
describe('jointLimitV2 — твист под протяжкой кольца', () => {
  const twistOf = (q: THREE.Quaternion): number => {
    const n = bone(q);                                   // ось кости после поворота
    const t0 = P.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(T, n));
    const t1 = P.clone().applyQuaternion(q);
    t0.addScaledVector(n, -n.dot(t0)).normalize(); t1.addScaledVector(n, -n.dot(t1)).normalize();
    return Math.atan2(t0.clone().cross(t1).dot(n), t0.dot(t1)) * D;
  };
  const drag = (key: object, toDeg: number, stepDeg = 10): number[] => {
    const out: number[] = [];
    const n = Math.round(Math.abs(toDeg) / stepDeg), sgn = Math.sign(toDeg);
    for (let i = 0; i <= n; i++) out.push(twistOf(limitLocalV2(Q(T, sgn * i * stepDeg), SH, key)));
    return out;
  };

  it('⭐ два полных оборота кольца — рука стоит на упоре и НИ РАЗУ не выворачивается в зеркало', () => {
    const key = {}; forgetDrag(key);
    const got = drag(key, 720);
    const lim = 1.6 * D;
    expect(Math.max(...got), 'выше упора не пускает').toBeLessThan(lim + 0.5);
    expect(Math.min(...got), '⚠ и НЕ прыгает на противоположный упор').toBeGreaterThan(-0.5);
    expect(got[got.length - 1], 'в конце протяжки стоит ровно на упоре').toBeCloseTo(lim, 0);
  });

  it('⭐ ровно на 180° твиста кость не кувыркается (опора вырождалась)', () => {
    // Тангенсы там АНТИПАРАЛЛЕЛЬНЫ, и `setFromUnitVectors` брал ось ПРОИЗВОЛЬНО. Замер до правки:
    // на 180° и 540° твист падал в 0° при упоре 97° — то есть рука на ровном месте распрямлялась.
    const key = {}; forgetDrag(key);
    const got = drag(key, 720, 5);
    // Сверяем с момента, когда протяжка УЖЕ прошла упор (до него кость законно идёт за кольцом).
    let checked = 0;
    for (const [i, v] of got.entries()) { if (i * 5 <= 1.6 * D) continue; checked++; expect(v, `шаг ${i * 5}°`).toBeGreaterThan(1.6 * D - 1); }
    expect(checked, 'проверено шагов за упором').toBeGreaterThan(100);
  });

  it('обратный ход отпускает упор сразу, а не через оборот', () => {
    const key = {}; forgetDrag(key);
    drag(key, 360);
    const back = [0, -30, -60, -90].map((d) => twistOf(limitLocalV2(Q(T, 360 + d), SH, key)));
    expect(back[0], 'стоим на упоре').toBeCloseTo(1.6 * D, 0);
    expect(back[3], 'ушли на 90° назад — ровно на 90° и уехали').toBeCloseTo(1.6 * D - 90, 0);
  });

  it('накопитель ПОКОСТНЫЙ и у твиста тоже', () => {
    const a = {}, b = {}; forgetDrag(a); forgetDrag(b);
    drag(a, 720);
    const qb = limitLocalV2(Q(T, 40), SH, b);
    expect(twistOf(qb), 'соседний сустав не знает о чужой протяжке').toBeCloseTo(40, 0);
  });

  it('БЕЗ ключа (солверы) — клэмп ПО ДУГЕ, а не численный', () => {
    // Солвер зовёт предел по нескольку раз за проход, накопителю его итерации мерещились бы движениями мыши.
    // Но и там численный клэмп врал: 170° он кидал к −92°, хотя по дуге ближе +92°.
    expect(twistOf(limitLocalV2(Q(T, 170), SH)), 'ближняя по дуге граница').toBeCloseTo(1.6 * D, 0);
    expect(twistOf(limitLocalV2(Q(T, -170), SH)), 'и симметрично').toBeCloseTo(-1.6 * D, 0);
  });
});
