import { describe, it, expect } from 'vitest';
import { CURVE_PRESETS, easeOfPreset, matchPreset, curveHitHandle, curveDrag, describeEase, easeOfKey, EASE_Y_MIN, EASE_Y_MAX, type Ease } from './curveEditor.js';
import { cubicBezier, EASE_INOUT, easeU, type Keyframe } from './clipModel.js';

const E = (a: number, b: number, c: number, d: number): Ease => [a, b, c, d];

describe('curveEditor — пресеты', () => {
  it('каждый пресет — валидная кривая: X ручек в 0..1, кривая монотонна по времени', () => {
    for (const p of CURVE_PRESETS) {
      expect(p.ease[0]).toBeGreaterThanOrEqual(0); expect(p.ease[0]).toBeLessThanOrEqual(1);
      expect(p.ease[2]).toBeGreaterThanOrEqual(0); expect(p.ease[2]).toBeLessThanOrEqual(1);
      expect(cubicBezier(p.ease[0], p.ease[1], p.ease[2], p.ease[3], 0)).toBe(0);
      expect(cubicBezier(p.ease[0], p.ease[1], p.ease[2], p.ease[3], 1)).toBe(1);
    }
  });

  it('пресеты помещаются в поле панели — иначе ручку не схватить обратно', () => {
    for (const p of CURVE_PRESETS) {
      expect(p.ease[1]).toBeGreaterThanOrEqual(EASE_Y_MIN); expect(p.ease[1]).toBeLessThanOrEqual(EASE_Y_MAX);
      expect(p.ease[3]).toBeGreaterThanOrEqual(EASE_Y_MIN); expect(p.ease[3]).toBeLessThanOrEqual(EASE_Y_MAX);
    }
  });

  it('«замах» реально уходит назад, «отскок» реально перелетает', () => {
    const anticip = easeOfPreset('anticip')!, back = easeOfPreset('back')!;
    expect(cubicBezier(anticip[0], anticip[1], anticip[2], anticip[3], 0.25)).toBeLessThan(0);      // ушёл в минус = назад
    expect(cubicBezier(back[0], back[1], back[2], back[3], 0.8)).toBeGreaterThan(1);                // перелетел цель
  });

  it('«рывок» проходит больше половины пути за первую четверть, «разгон» — меньше', () => {
    const snap = easeOfPreset('snap')!, ein = easeOfPreset('in')!;
    expect(cubicBezier(snap[0], snap[1], snap[2], snap[3], 0.25)).toBeGreaterThan(0.5);
    expect(cubicBezier(ein[0], ein[1], ein[2], ein[3], 0.25)).toBeLessThan(0.15);
  });

  it('неизвестный пресет — null, а не молчаливый дефолт', () => { expect(easeOfPreset('нет-такого')).toBeNull(); });

  it('распознаёт свой же пресет и не выдумывает его для ручной кривой', () => {
    expect(matchPreset(easeOfPreset('inout')!)).toBe('inout');
    expect(matchPreset(E(0.9, 0.1, 0.1, 0.9))).toBeNull();
  });
});

describe('curveEditor — ручки', () => {
  const e = E(0.42, 0, 0.58, 1);

  it('попадание в ближнюю ручку, мимо — −1', () => {
    expect(curveHitHandle(e, 0.42, 0.0)).toBe(0);
    expect(curveHitHandle(e, 0.58, 1.0)).toBe(1);
    expect(curveHitHandle(e, 0.5, 0.5)).toBe(-1);
  });

  it('на равном расстоянии выигрывает первая — выбор детерминирован', () => {
    expect(curveHitHandle(E(0.5, 0.5, 0.5, 0.5), 0.5, 0.5)).toBe(0);
  });

  it('перетаскивание зажимает X в 0..1 (иначе кривая перестаёт быть функцией времени)', () => {
    expect(curveDrag(e, 0, -3, 0.5)[0]).toBe(0);
    expect(curveDrag(e, 1, 9, 0.5)[2]).toBe(1);
  });

  it('Y пускает за пределы — это и есть замах/отскок', () => {
    expect(curveDrag(e, 0, 0.5, -0.3)[1]).toBeCloseTo(-0.3, 6);
    expect(curveDrag(e, 1, 0.5, 1.3)[3]).toBeCloseTo(1.3, 6);
    expect(curveDrag(e, 1, 0.5, 99)[3]).toBe(EASE_Y_MAX);          // но не дальше, чем видно в панели
    expect(curveDrag(e, 0, 0.5, -99)[1]).toBe(EASE_Y_MIN);
  });

  it('тянем одну ручку — вторая не шевелится, исходник не мутируется', () => {
    const src = E(0.42, 0, 0.58, 1);
    const out = curveDrag(src, 0, 0.1, 0.9);
    expect(out[2]).toBe(0.58); expect(out[3]).toBe(1);
    expect(src).toEqual([0.42, 0, 0.58, 1]);
  });

  it('перетащенная кривая остаётся решаемой (Ньютон+бисекция не разъезжаются)', () => {
    const out = curveDrag(curveDrag(E(0.5, 0.5, 0.5, 0.5), 0, 0, 1), 1, 1, 0);   // вырожденные ручки
    for (let u = 0; u <= 1.0001; u += 0.1) {
      const v = cubicBezier(out[0], out[1], out[2], out[3], u);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('curveEditor — связь с клипом', () => {
  it('ключ без ease читается как плавная — панель показывает то, что реально сыграет', () => {
    const k: Keyframe = { pose: {}, t: 0, interp: 'ease' };
    expect(easeOfKey(k)).toEqual([...EASE_INOUT]);
    expect(easeU(k, 0.5)).toBeCloseTo(cubicBezier(EASE_INOUT[0], EASE_INOUT[1], EASE_INOUT[2], EASE_INOUT[3], 0.5), 6);
  });

  it('ручки ключа доезжают до проигрывателя один-в-один', () => {
    const k: Keyframe = { pose: {}, t: 0, interp: 'ease', ease: [0.1, 0.9, 0.2, 1] };
    expect(easeU(k, 0.25)).toBeCloseTo(cubicBezier(0.1, 0.9, 0.2, 1, 0.25), 6);
    expect(easeU(k, 0.25)).toBeGreaterThan(0.5);                    // рывок: полпути за четверть времени
  });

  it('описание кривой человекочитаемо и не врёт про пресет', () => {
    expect(describeEase(easeOfPreset('inout')!)).toBe('плавно');
    expect(describeEase(E(0.9, 0.1, 0.1, 0.9))).toContain('вход');
  });
});
