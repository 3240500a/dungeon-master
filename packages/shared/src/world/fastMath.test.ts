import { describe, it, expect } from 'vitest';
import { vecLen, dist, dist2, wrapAngle, normalizeAngle } from './fastMath.js';

/**
 * Быстрая математика горячих циклов (Ф0.11). Главное требование: результат совпадает
 * со встроенными функциями на ИГРОВЫХ величинах — иначе «оптимизация» тихо меняет баланс.
 */
describe('fastMath', () => {
  it('vecLen совпадает с Math.hypot на игровых величинах', () => {
    for (let i = 0; i < 500; i++) {
      const dx = (Math.random() - 0.5) * 4000;
      const dy = (Math.random() - 0.5) * 4000;
      expect(vecLen(dx, dy)).toBeCloseTo(Math.hypot(dx, dy), 9);
    }
  });

  it('dist совпадает с Math.hypot по разнице координат', () => {
    for (let i = 0; i < 200; i++) {
      const a = { x: Math.random() * 2048, y: Math.random() * 1536 };
      const b = { x: Math.random() * 2048, y: Math.random() * 1536 };
      expect(dist(a.x, a.y, b.x, b.y)).toBeCloseTo(Math.hypot(b.x - a.x, b.y - a.y), 9);
    }
  });

  it('dist2 — это квадрат dist', () => {
    expect(dist2(0, 0, 3, 4)).toBe(25);
    expect(Math.sqrt(dist2(10, 10, 13, 14))).toBeCloseTo(5, 12);
  });

  it('wrapAngle приводит в (−π, π]', () => {
    for (let i = 0; i < 500; i++) {
      const a = (Math.random() - 0.5) * 100;
      const w = wrapAngle(a);
      expect(w).toBeGreaterThanOrEqual(-Math.PI - 1e-9);
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-9);
      // тот же угол с точностью до полного оборота
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9);
    }
  });

  it('wrapAngle совпадает со старой формулой atan2(sin, cos) вне границы ±π', () => {
    for (let i = 0; i < 500; i++) {
      const a = (Math.random() - 0.5) * 20;
      // у границы поведение отличается только знаком, см. комментарий в fastMath.ts
      if (Math.abs(Math.abs(wrapAngle(a)) - Math.PI) < 1e-6) continue;
      expect(wrapAngle(a)).toBeCloseTo(Math.atan2(Math.sin(a), Math.cos(a)), 9);
    }
  });

  /** ⚠ R7-01: `wrapAngle` на |a| ≳ 1e16 отдаёт 0 для любого направления — угол извне приводит `normalizeAngle`. */
  it('⭐ R7-01: normalizeAngle — любая конечная величина в [−π, π] тем же направлением; честный угол как есть', () => {
    expect(wrapAngle(1e17 + 1), 'грабля, которую закрывает normalizeAngle').toBe(0);
    for (const a of [1e17, -1e17, 1e20, 1e300, -1e300, 2 ** 60, 1e6, 7, -4]) {
      const n = normalizeAngle(a);
      expect(Math.abs(n), `${a}`).toBeLessThanOrEqual(Math.PI);
      expect(n, `${a}`).toBe(Math.atan2(Math.sin(a), Math.cos(a)));
    }
    for (const a of [0, -0, 1.2, -3, Math.PI, -Math.PI]) expect(Object.is(normalizeAngle(a), a), `${a}`).toBe(true);
    expect(normalizeAngle(NaN)).toBeNaN();
  });

  it('нулевой вектор не даёт NaN', () => {
    expect(vecLen(0, 0)).toBe(0);
    expect(dist(5, 5, 5, 5)).toBe(0);
    expect(wrapAngle(0)).toBe(0);
  });
});
