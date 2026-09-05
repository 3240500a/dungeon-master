import { describe, it, expect } from 'vitest';
import { deriveFingerAxes, canonicalFingerOffsets, canonicalFingerAxes, fingerAxesOf, type Vec3 } from './fingerAxes.js';

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const len = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);
/** Повернуть все офсеты — имитация «кисть модели смотрит в другую сторону». */
const rotY = (v: Vec3, a: number): Vec3 => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];

describe('fingerAxes — канонический манекен', () => {
  const ax = canonicalFingerAxes();

  it('оси выданы всем 30 фалангам', () => { expect(Object.keys(ax).length).toBe(30); });

  it('ГЛАВНОЕ: ось сгиба — Z, а не Y (вокруг Y палец уезжает ВБОК по ладони)', () => {
    for (const nm of ['LeftIndexProximal', 'LeftMiddleIntermediate', 'RightLittleDistal', 'RightIndexProximal']) {
      const p = ax[nm]!.plane;
      expect(Math.abs(p[2])).toBeGreaterThan(0.9);    // почти чистый ±Z
      expect(Math.abs(p[1])).toBeLessThan(0.2);       // и точно не Y, как было зашито
    }
  });

  it('ось «вдоль пальца» смотрит наружу кисти: у левой +X, у правой −X', () => {
    expect(ax['LeftIndexProximal']!.twist[0]).toBeGreaterThan(0.9);
    expect(ax['RightIndexProximal']!.twist[0]).toBeLessThan(-0.9);
  });

  it('тройка ортонормирована — иначе клэмп и гизмо посчитают ерунду', () => {
    for (const nm in ax) {
      const { twist, plane, normal } = ax[nm]!;
      for (const v of [twist, plane, normal]) expect(len(v)).toBeCloseTo(1, 6);
      expect(dot(twist, plane)).toBeCloseTo(0, 6);
      expect(dot(twist, normal)).toBeCloseTo(0, 6);
      expect(dot(plane, normal)).toBeCloseTo(0, 6);
    }
  });

  it('сгиб по этой оси ведёт кончик К ЛАДОНИ (в −Y), а не поперёк', () => {
    // Поворот вектора «вдоль пальца» вокруг оси сгиба на +θ (правило правой руки) — куда уедет кончик.
    const { twist, plane } = ax['LeftIndexProximal']!;
    const th = 0.5;
    const k = dot(plane, twist);
    const rot = twist.map((_, i) =>
      twist[i]! * Math.cos(th) + [plane[1]! * twist[2]! - plane[2]! * twist[1]!, plane[2]! * twist[0]! - plane[0]! * twist[2]!, plane[0]! * twist[1]! - plane[1]! * twist[0]!][i]! * Math.sin(th) + plane[i]! * k * (1 - Math.cos(th)));
    expect(rot[1]!).toBeLessThan(-0.1);              // ушёл вниз, к ладони (большой палец на −Y)
    expect(Math.abs(rot[2]!)).toBeLessThan(0.1);     // и НЕ вбок
  });
});

describe('fingerAxes — оси едут за геометрией', () => {
  it('повернули кисть — оси повернулись вместе с ней', () => {
    const base = canonicalFingerOffsets();
    const a = Math.PI / 3;
    const turned: Record<string, Vec3> = {};
    for (const k in base) turned[k] = rotY(base[k]!, a);
    const ax = deriveFingerAxes((b) => turned[b] ?? null);
    const canon = canonicalFingerAxes();
    const want = rotY(canon['LeftIndexProximal']!.plane, a);
    const got = ax['LeftIndexProximal']!.plane;
    for (let i = 0; i < 3; i++) expect(got[i]!).toBeCloseTo(want[i]!, 6);
  });

  it('зеркальные кисти: ОСЬ сгиба противоположна, поэтому ОДИН И ТОТ ЖЕ угол гнёт обе в кулак', () => {
    // Ровно это правило решает, где нужен пер-сторонний множитель, а где он всё сломает.
    // M = diag(−1,1,1) — наше зеркало L↔R. Тогда cross(Mu, Mv) = −M(u×v), а ладонь у обеих кистей
    // смотрит в −Y (X-компоненты нет) → plane_R = −plane_L. Знак «зашит» в саму ось.
    const ax = canonicalFingerAxes();
    const l = ax['LeftIndexProximal']!, r = ax['RightIndexProximal']!;
    expect(l.twist[0]).toBeCloseTo(-r.twist[0]!, 6);   // «вдоль пальца» — ПОЛЯРНЫЙ вектор: знак меняется
    expect(l.plane[2]).toBeCloseTo(-r.plane[2]!, 6);   // ось сгиба тоже противоположна…

    // …и именно поэтому положительный угол вокруг неё уводит кончик к ладони НА ОБЕИХ кистях:
    // у сгиба пер-стороннего множителя быть НЕ должно (а у твиста большого пальца — должен).
    const tipAfter = (a: typeof l): number[] => {
      const th = 0.5, { twist: t, plane: p } = a;
      const k = p[0] * t[0] + p[1] * t[1] + p[2] * t[2];
      const c: number[] = [p[1] * t[2] - p[2] * t[1], p[2] * t[0] - p[0] * t[2], p[0] * t[1] - p[1] * t[0]];
      return t.map((_, i) => t[i]! * Math.cos(th) + c[i]! * Math.sin(th) + p[i]! * k * (1 - Math.cos(th)));
    };
    expect(tipAfter(l)[1]!).toBeLessThan(-0.1);
    expect(tipAfter(r)[1]!).toBeLessThan(-0.1);
  });
});

describe('fingerAxes — вырождения и фолбэк', () => {
  it('нет костей — нет осей, без падения', () => { expect(deriveFingerAxes(() => null)).toEqual({}); });

  it('схлопнутая ладонь (все корни совпали) не даёт NaN — кость просто пропускается', () => {
    const flat: Record<string, Vec3> = {};
    for (const k in canonicalFingerOffsets()) flat[k] = [1, 0, 0];
    const ax = deriveFingerAxes((b) => flat[b] ?? null);
    for (const nm in ax) for (const v of [ax[nm]!.twist, ax[nm]!.plane, ax[nm]!.normal]) for (const c of v) expect(Number.isFinite(c)).toBe(true);
  });

  it('fingerAxesOf падает на канон, если для кости вывода нет', () => {
    expect(fingerAxesOf('LeftIndexProximal', {})).toEqual(canonicalFingerAxes()['LeftIndexProximal']);
    expect(fingerAxesOf('Spine')).toBeNull();
  });
});
