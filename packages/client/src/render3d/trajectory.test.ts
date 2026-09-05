import { describe, it, expect } from 'vitest';
import { trajectorySamples, polylineLength, arcRatio, excursion } from './trajectory.js';
import type { Clip, Keyframe } from './clipModel.js';

const mk = (ts: number[]): Clip => ({
  name: 'c', character: 'a', weapon: 'sword', loop: true,
  keys: ts.map((t): Keyframe => ({ pose: {}, t })),
});

describe('trajectory — сетка съёмки', () => {
  it('ключи ВСЕГДА попадают в сетку и помечены индексом', () => {
    const s = trajectorySamples(mk([0, 0.3, 0.7]), 4);
    const keys = s.filter((x) => x.key >= 0);
    expect(keys.map((x) => x.t)).toEqual([0, 0.3, 0.7]);
    expect(keys.map((x) => x.key)).toEqual([0, 1, 2]);
  });

  it('между ключами ровно `per` промежуточных точек', () => {
    const s = trajectorySamples(mk([0, 1]), 3);
    expect(s.length).toBe(2 + 3);
    expect(s.filter((x) => x.key < 0).length).toBe(3);
  });

  it('времена строго возрастают и лежат внутри клипа', () => {
    const s = trajectorySamples(mk([0, 0.2, 0.25, 1.4]), 5);
    for (let i = 1; i < s.length; i++) expect(s[i]!.t).toBeGreaterThan(s[i - 1]!.t);
    expect(s[0]!.t).toBe(0);
    expect(s[s.length - 1]!.t).toBeCloseTo(1.4, 9);
  });

  it('неравные интервалы сэмплятся по СВОЕЙ длине — густота точек = скорость', () => {
    const s = trajectorySamples(mk([0, 0.1, 1.1]), 1);
    const gaps = s.slice(1).map((x, i) => x.t - s[i]!.t);
    expect(gaps[0]).toBeCloseTo(0.05, 9);      // короткий интервал — мелкий шаг
    expect(gaps[2]).toBeCloseTo(0.5, 9);       // длинный — крупный
  });

  it('вырожденные клипы не роняют и не дают пустоту', () => {
    expect(trajectorySamples(mk([]), 5)).toEqual([]);
    expect(trajectorySamples(mk([0.4]), 5)).toEqual([{ t: 0.4, key: 0 }]);
    expect(trajectorySamples(mk([0, 0]), 5)).toEqual([{ t: 0, key: 0 }]);   // нулевая длительность
    expect(trajectorySamples(mk([0, 1]), 0).length).toBe(3);                // per<1 → минимум одна промежуточная
  });
});

describe('trajectory — метрики дуги', () => {
  const line = [[0, 0, 0], [1, 0, 0], [2, 0, 0]] as const;
  const arc = [[0, 0, 0], [1, 1, 0], [2, 0, 0]] as const;
  const halfCircle = Array.from({ length: 33 }, (_, i) => {
    const a = Math.PI * (i / 32);
    return [Math.cos(a) - 1, Math.sin(a), 0] as [number, number, number];
  });
  const thereAndBack = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [1, 0, 0], [0, 0, 0]] as const;

  it('длина ломаной складывается по сегментам', () => {
    expect(polylineLength(line)).toBeCloseTo(2, 9);
    expect(polylineLength([])).toBe(0);
  });

  it('прямая = 1, дуга > 1 — по этому числу видно «механическое» движение', () => {
    expect(arcRatio(line)).toBeCloseTo(1, 9);
    expect(arcRatio(arc)).toBeGreaterThan(1.4);
  });

  it('полукруг ≈ π/2 — шкала предсказуема', () => { expect(arcRatio(halfCircle)).toBeCloseTo(Math.PI / 2, 2); });

  it('ГЛАВНОЕ: удар, вернувшийся в стойку, НЕ выглядит прямым', () => {
    // Хорда тут ≈ 0 (старт = финиш), и старое «длина/хорда» давало ×1.00 на любом замахе.
    const swing = [...halfCircle, ...halfCircle.slice(0, -1).reverse().map((p) => [p[0], -p[1], 0] as [number, number, number])];
    expect(arcRatio(swing)).toBeGreaterThan(1.4);
    expect(arcRatio(thereAndBack)).toBeCloseTo(1, 6);   // а прямая «туда-обратно» — всё ещё прямая
  });

  it('размах = максимальное удаление от старта', () => {
    expect(excursion(thereAndBack)).toBeCloseTo(2, 9);
    expect(excursion([])).toBe(0);
  });

  it('путь на месте не делит на ноль', () => {
    expect(arcRatio([[0, 0, 0], [0, 0, 0], [0, 0, 0]])).toBe(1);
    expect(arcRatio([[0, 0, 0]])).toBe(1);
  });
});
