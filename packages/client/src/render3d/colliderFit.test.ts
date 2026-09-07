import { describe, it, expect } from 'vitest';
import { fitCollider, percentileSorted, type BodyPoint } from './colliderFit.js';

/** Цилиндр радиуса `r` длиной `len`, центр на `c`, плюс `outliers` далёких точек. */
function tube(r: number, len: number, c = 0, outliers = 0): BodyPoint[] {
  const p: BodyPoint[] = [];
  for (let i = 0; i < 200; i++) {
    const a = c - len / 2 + (len * i) / 199;
    const t = (i / 200) * Math.PI * 2 * 7;
    p.push({ a, u: Math.cos(t) * r, v: Math.sin(t) * r });
  }
  for (let i = 0; i < outliers; i++) p.push({ a: c, u: r * 6, v: 0 });   // шипы наплечника
  return p;
}

describe('обжатие коллайдера по вершинам (Ф28.3)', () => {
  it('перцентиль по краям и в середине', () => {
    const s = [0, 1, 2, 3, 4];
    expect(percentileSorted(s, 0)).toBe(0);
    expect(percentileSorted(s, 1)).toBe(4);
    expect(percentileSorted(s, 0.5)).toBe(2);
    expect(percentileSorted([], 0.5)).toBe(0);
    expect(percentileSorted([7], 0.9)).toBe(7);
  });

  it('чистая труба: радиус и длина совпадают с заданными', () => {
    const f = fitCollider(tube(3, 20));
    expect(f.r).toBeCloseTo(3, 5);
    expect(f.half).toBeCloseTo(10, 5);
    expect(f.center).toBeCloseTo(0, 5);
    expect(f.n).toBe(200);
  });

  it('ЦЕНТР ищется, а не предполагается: тело смещено вдоль оси', () => {
    const f = fitCollider(tube(2, 10, 7));
    expect(f.center).toBeCloseTo(7, 5);
    expect(f.half).toBeCloseTo(5, 5);
  });

  it('ВЫБРОСЫ НЕ РАЗДУВАЮТ ФОРМУ — ради этого и перцентиль, а не максимум', () => {
    const clean = fitCollider(tube(3, 20));
    const spiky = fitCollider(tube(3, 20, 0, 8));          // 8 вершин на радиусе 18
    expect(spiky.r).toBeLessThan(clean.r * 1.15);           // перцентиль их срезал
    const byMax = fitCollider(tube(3, 20, 0, 8), { pct: 1 });
    expect(byMax.r).toBeGreaterThan(clean.r * 5);           // а максимум — раздул бы вшестеро
  });

  it('ДЛИНА берётся по краям и выбросами не режется: конец кости обрезать нельзя', () => {
    const f = fitCollider(tube(3, 20), { pct: 0.5 });
    expect(f.half).toBeCloseTo(10, 5);                      // половина длины не зависит от перцентиля
  });

  it('раздутие масштабирует только поперечник (ткань — больше, рагдолл — меньше)', () => {
    const a = fitCollider(tube(3, 20), { inflate: 1.2 });
    const b = fitCollider(tube(3, 20), { inflate: 0.9 });
    expect(a.r).toBeCloseTo(3 * 1.2, 4);
    expect(b.r).toBeCloseTo(3 * 0.9, 4);
    expect(a.half).toBeCloseTo(b.half, 5);                  // длина не трогается
  });

  it('плоское тело: полуширина и полутолщина разные', () => {
    const pts: BodyPoint[] = [];
    for (let i = 0; i < 100; i++) pts.push({ a: i / 10, u: (i % 2 ? 4 : -4), v: (i % 3 ? 1 : -1) });
    const f = fitCollider(pts);
    expect(f.hu).toBeCloseTo(4, 4);
    expect(f.hv).toBeCloseTo(1, 4);
  });

  it('ДАЛЁКИЕ ВЕРШИНЫ ВДОЛЬ ОСИ срезаются `axPct` — именно они растягивали грудь вчетверо', () => {
    const pts = tube(2, 10);
    for (let i = 0; i < 4; i++) pts.push({ a: 30, u: 0, v: 0 });   // воротник, повисший на чужой кости
    expect(fitCollider(pts).half).toBeGreaterThan(17);              // честные края верят выбросу
    expect(fitCollider(pts, { axPct: 0.03 }).half).toBeCloseTo(5, 0);   // с подрезкой — настоящая длина
  });

  it('пустое облако не роняет и честно сообщает нулём', () => {
    const f = fitCollider([]);
    expect(f.n).toBe(0);
    expect(f.r).toBe(0);
  });
});
