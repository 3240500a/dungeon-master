import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { clampLocalToLimit, decomposeToLimit } from './jointClamp.js';
import type { LimitView } from './humanoidRagdoll.js';

// swing-twist клэмп: манекен обязан слушаться пределов. Гизмо рисуется той же параметризацией → совпадает.
const swingView = (o: Partial<LimitView> = {}): LimitView => ({
  kind: 'swing', group: 'arm', canon: 't', twist: [1, 0, 0], plane: [0, 1, 0], normal: [0, 0, 1],
  planeMin: -0.5, planeMax: 0.5, normalMin: -0.4, normalMax: 0.4, twistMin: -0.3, twistMax: 0.3, ...o,
});
const hingeView = (o: Partial<LimitView> = {}): LimitView => ({
  kind: 'hinge', group: 'arm', canon: 't', axis: [1, 0, 0], hingeNormal: [0, -1, 0], min: -1.0, max: 0.1, ...o,
});
const qAxis = (ax: [number, number, number], a: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax).normalize(), a);

describe('jointClamp — swing-twist клэмп', () => {
  it('swing за конусом → на границе (rP клэмпнут к planeMax)', () => {
    const v = swingView();
    const c = clampLocalToLimit(qAxis([0, 1, 0], 1.2), v);   // поворот вокруг plane-оси на 1.2 > planeMax 0.5
    const d = decomposeToLimit(c, v);
    expect(d.rP).toBeCloseTo(0.5, 2);
    expect(Math.abs(d.rN)).toBeLessThan(0.02);
  });

  it('swing внутри предела → почти без изменений', () => {
    const v = swingView();
    const q = qAxis([0, 1, 0], 0.3);   // 0.3 < planeMax 0.5
    const c = clampLocalToLimit(q, v);
    expect(c.angleTo(q)).toBeLessThan(0.02);
  });

  it('АСИММЕТРИЯ: −planeMin ограничивает меньше, чем +planeMax', () => {
    const v = swingView({ planeMin: -0.2, planeMax: 1.0 });
    const back = decomposeToLimit(clampLocalToLimit(qAxis([0, 1, 0], -1.5), v), v);   // «назад» — упор на −0.2
    const fwd = decomposeToLimit(clampLocalToLimit(qAxis([0, 1, 0], 1.5), v), v);     // «вперёд» — упор на 1.0
    expect(back.rP).toBeCloseTo(-0.2, 2);
    expect(fwd.rP).toBeCloseTo(1.0, 2);
  });

  it('twist клэмпится к диапазону', () => {
    const v = swingView();
    const d = decomposeToLimit(clampLocalToLimit(qAxis([1, 0, 0], 1.0), v), v);   // твист 1.0 > twistMax 0.3
    expect(d.twist).toBeCloseTo(0.3, 2);
  });

  it('hinge: за пределом → на границе + внеосевой wobble убран', () => {
    const v = hingeView();
    // поворот вокруг оси на −2.0 (< min −1.0) + паразитный наклон вокруг Z
    const q = qAxis([1, 0, 0], -2.0).multiply(qAxis([0, 0, 1], 0.3));
    const c = clampLocalToLimit(q, v);
    const d = decomposeToLimit(c, v);
    expect(d.twist).toBeCloseTo(-1.0, 2);   // угол шарнира на min
    // остаточный поворот только вокруг оси X → нет Z-компоненты
    const e = new THREE.Euler().setFromQuaternion(c, 'XYZ');
    expect(Math.abs(e.z)).toBeLessThan(0.02);
  });
});
