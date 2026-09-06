import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { solveTwoBone, softDistance, elbowGoal, perpTo } from './limbIk.js';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const DEG = 180 / Math.PI;
/** Кисть, к которой приводит решение: E + L2 вдоль (H − E). Проверяем, что она попадает в H. */
const handOf = (S: THREE.Vector3, E: THREE.Vector3, H: THREE.Vector3, L2: number): THREE.Vector3 =>
  E.clone().addScaledVector(H.clone().sub(E).normalize(), L2);

describe('limbIk — аналитический двухкостный IK (Ф25.1)', () => {
  const S = V(-10, 60, 0), L1 = 13, L2 = 12, pole = V(0, -1, -0.4);

  it('ГЛАВНОЕ: цель внутри досягаемости — кисть ТОЧНО на цели, длины звеньев сохранены', () => {
    for (const H of [V(-14, 46, 8), V(-2, 60, 12), V(-24, 50, -3), V(-10, 40, 4)]) {
      const r = solveTwoBone({ S, H, pole, L1, L2, soft: 0 });
      expect(r.reachable).toBe(true);
      expect(r.E.distanceTo(S), 'L1').toBeCloseTo(L1, 6);
      expect(r.E.distanceTo(H), 'L2').toBeCloseTo(L2, 6);
      expect(handOf(S, r.E, H, L2).distanceTo(H), 'кисть').toBeLessThan(1e-6);
    }
  });

  it('сгиб — по закону косинусов (тот самый случай «к бедру»: 24°, а не 7° у FABRIK)', () => {
    // замер Ф25: цель на 28.4u при L1+L2 = 33 → ожидание ~24°
    const H = S.clone().add(V(0, -28.4, 0));
    const r = solveTwoBone({ S, H, pole, L1: 16.5, L2: 16.5, soft: 0 });
    const expectBend = 180 - Math.acos((16.5 ** 2 + 16.5 ** 2 - 28.4 ** 2) / (2 * 16.5 * 16.5)) * DEG;
    expect(r.bend * DEG).toBeCloseTo(expectBend, 1);
    expect(r.bend * DEG).toBeGreaterThan(20);
  });

  it('локоть лежит в плоскости полюса и уходит В СТОРОНУ полюса', () => {
    const H = V(-10, 42, 0);                                   // прямо вниз от плеча
    const fwd = solveTwoBone({ S, H, pole: V(0, 0, 1), L1, L2, soft: 0 });
    const back = solveTwoBone({ S, H, pole: V(0, 0, -1), L1, L2, soft: 0 });
    expect(fwd.E.z).toBeGreaterThan(1);                        // локоть вперёд
    expect(back.E.z).toBeLessThan(-1);                         // локоть назад
    expect(fwd.E.x).toBeCloseTo(S.x, 6);                       // и ни капли вбок — плоскость чистая
    // нормаль плоскости ⊥ и цепи, и локтю
    expect(Math.abs(fwd.n.dot(H.clone().sub(S).normalize()))).toBeLessThan(1e-6);
    expect(Math.abs(fwd.n.dot(fwd.E.clone().sub(S).normalize()))).toBeLessThan(1e-6);
  });

  it('полюс лёг вдоль цепи — берётся запасное направление, решение не ломается', () => {
    const H = V(-10, 42, 0);
    const r = solveTwoBone({ S, H, pole: V(0, -1, 0), L1, L2, soft: 0, prefer: V(0, 0, 1) });   // полюс ∥ цепи
    expect(Number.isFinite(r.E.x) && Number.isFinite(r.E.y) && Number.isFinite(r.E.z)).toBe(true);
    expect(r.E.z).toBeGreaterThan(1);                          // ушёл в prefer
  });

  it('SOFT IK: у полного разгиба цепь НИКОГДА не выпрямляется в струну и нет скачка', () => {
    const L = L1 + L2;
    let prevBend = Infinity, prevD = 0;
    for (let k = 0.5; k <= 1.6; k += 0.02) {                   // от полуразгиба до далеко за пределом
      const H = S.clone().add(V(0, -L * k, 0));
      const r = solveTwoBone({ S, H, pole, L1, L2, soft: 0.1 });
      expect(r.bend, `k=${k}`).toBeGreaterThan(0.01);          // не струна
      expect(r.bend, `монотонно k=${k}`).toBeLessThanOrEqual(prevBend + 1e-9);
      expect(r.d, `дистанция растёт k=${k}`).toBeGreaterThanOrEqual(prevD - 1e-9);
      expect(r.d).toBeLessThan(L);
      prevBend = r.bend; prevD = r.d;
    }
  });

  it('по умолчанию soft ВЫКЛ: полный разгиб точен — стоящая прямая нога не сгибается, стопа не отрывается', () => {
    const L = L1 + L2;
    const H = S.clone().add(V(0, -L, 0));
    const r = solveTwoBone({ S, H, pole, L1, L2 });
    expect(r.bend * DEG).toBeLessThan(0.5);
    expect(handOf(S, r.E, H, L2).distanceTo(H)).toBeLessThan(1e-3);
  });

  it('softDistance: до колена — тождество, дальше — асимптота L, стык гладкий', () => {
    const L = 25, f = 0.1, knee = L * (1 - f);
    expect(softDistance(10, L, f)).toBe(10);
    expect(softDistance(knee, L, f)).toBeCloseTo(knee, 9);
    expect(softDistance(2 * L, L, f)).toBeLessThan(L);       // асимптота: близко к L, но не L
    expect(softDistance(2 * L, L, f)).toBeGreaterThan(L - 1e-3);
    expect(softDistance(1000, L, f)).toBeLessThanOrEqual(L);  // далеко — в пределах float сливается с L, но НЕ больше
    const h = 1e-4;                                            // производная в стыке ≈ 1 (нет излома)
    expect((softDistance(knee + h, L, f) - softDistance(knee - h, L, f)) / (2 * h)).toBeCloseTo(1, 2);
    expect(softDistance(10, L, 0)).toBe(10);                   // soft=0 — выкл
  });

  it('зеркало Л/П: отражённая задача даёт отражённое решение', () => {
    const H = V(-16, 48, 6);
    const r = solveTwoBone({ S, H, pole, L1, L2, soft: 0 });
    const m = (v: THREE.Vector3): THREE.Vector3 => V(-v.x, v.y, v.z);
    const rm = solveTwoBone({ S: m(S), H: m(H), pole: m(pole), L1, L2, soft: 0 });
    expect(rm.E.distanceTo(m(r.E))).toBeLessThan(1e-6);
  });
});

describe('limbIk — локоть как эффектор (Ф25.1, `elbowGoal`)', () => {
  const S = V(-10, 60, 0), L1 = 13, L2 = 12;

  it('ГЛАВНОЕ: локоть на сфере L2 вокруг кисти, корень на сфере L1 вокруг локтя', () => {
    const H = V(-14, 46, 8);
    for (const Ewant of [V(-20, 55, -6), V(-6, 50, 14), V(-30, 60, 0)]) {
      const g = elbowGoal(S, H, Ewant, L1, L2);
      expect(g.E.distanceTo(H), 'L2').toBeCloseTo(L2, 6);
      expect(g.Swant.distanceTo(g.E), 'L1').toBeCloseTo(L1, 6);
      expect(g.shift.distanceTo(g.Swant.clone().sub(S))).toBeLessThan(1e-9);
    }
  });

  it('локоть уже там, где просят — сдвиг корня НОЛЬ (ничего не дёргается)', () => {
    const H = V(-14, 46, 8);
    const r = solveTwoBone({ S, H, pole: V(0, -1, -0.4), L1, L2, soft: 0 });
    const g = elbowGoal(S, H, r.E, L1, L2);                  // просим ровно текущий локоть
    expect(g.E.distanceTo(r.E)).toBeLessThan(1e-6);
    expect(g.shift.length()).toBeLessThan(1e-6);
  });

  it('полюс из elbowGoal воспроизводит тот же локоть, если корень встал в Swant', () => {
    const H = V(-14, 46, 8), Ewant = V(-22, 52, -8);
    const g = elbowGoal(S, H, Ewant, L1, L2);
    const r = solveTwoBone({ S: g.Swant, H, pole: g.pole, L1, L2, soft: 0 });
    expect(r.E.distanceTo(g.E)).toBeLessThan(1e-5);
  });

  it('локоть в кисти / корень в локте — вырожденности не роняют', () => {
    const H = V(-14, 46, 8);
    expect(() => elbowGoal(S, H, H.clone(), L1, L2)).not.toThrow();
    const g = elbowGoal(S, H, H.clone(), L1, L2);
    expect(Number.isFinite(g.Swant.x)).toBe(true);
    expect(g.E.distanceTo(H)).toBeCloseTo(L2, 6);
  });

  it('perpTo: результат ⊥ направлению', () => {
    const d = V(0.3, -0.9, 0.2).normalize();
    expect(Math.abs(perpTo(V(1, 2, 3), d).dot(d))).toBeLessThan(1e-9);
  });
});
