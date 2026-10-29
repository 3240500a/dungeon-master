import { describe, it, expect } from 'vitest';
import { rigSignature, trimClip, poseAtSec, poseGap, loopSeamGap, closeLoopSeam, isStaticBake } from './clipImport.js';
import { clipDur, type Clip, type Pose } from './clipModel.js';
import { poseReconstructError, reduceKeyframes, POS_DEG_PER_UNIT } from './clipBaker.js';

const P = (o: Record<string, [number, number, number]>): Pose => o;
const clip = (keys: { t: number; pose: Pose }[]): Clip => ({ name: 'c', character: 'ch', weapon: 'w', loop: false, keys });
const D = Math.PI / 180;

describe('clipImport — сигнатура рига', () => {
  it('порядок обхода не влияет (у разных конвертеров он разный, скелет тот же)', () => {
    expect(rigSignature(['Hips', 'Spine', 'Head'])).toBe(rigSignature(['Head', 'Hips', 'Spine']));
  });
  it('ДУБЛИ скелета сигнатуру не меняют — иначе карта костей не подхватилась бы', () => {
    expect(rigSignature(['Hips', 'Spine'])).toBe(rigSignature(['Hips', 'Spine', 'Hips_1', 'Spine_1', 'Hips_7']));
  });
  it('другой скелет — другая сигнатура', () => {
    expect(rigSignature(['Hips', 'Spine'])).not.toBe(rigSignature(['Hips', 'Spine', 'Tail']));
    expect(rigSignature(['mixamorig:Hips'])).not.toBe(rigSignature(['CC_Base_Hip']));
  });
  it('номер В ИМЕНИ кости не срезается (Twist01 ≠ Twist)', () => {
    expect(rigSignature(['Twist01'])).not.toBe(rigSignature(['Twist']));
  });
});

describe('clipImport — обрезка', () => {
  const c = clip([
    { t: 0, pose: P({ Spine: [0, 0, 0] }) },
    { t: 1, pose: P({ Spine: [1, 0, 0] }) },
    { t: 2, pose: P({ Spine: [2, 0, 0] }) },
  ]);

  it('границы становятся ключами с ИНТЕРПОЛИРОВАННОЙ позой, время съезжает к нулю', () => {
    const t = trimClip(c, 0.5, 1.5);
    expect(clipDur(t)).toBeCloseTo(1);
    expect(t.keys[0]!.t).toBe(0);
    expect(t.keys[0]!.pose['Spine']![0]).toBeCloseTo(0.5, 2);
    expect(t.keys[t.keys.length - 1]!.pose['Spine']![0]).toBeCloseTo(1.5, 2);
    expect(t.keys.length).toBe(3);          // граница + средний ключ t=1 + граница
  });

  it('исходник не мутируется', () => {
    trimClip(c, 0.5, 1.5);
    expect(c.keys.map((k) => k.t)).toEqual([0, 1, 2]);
    expect(c.keys[0]!.pose['Spine']![0]).toBe(0);
  });

  it('перевёрнутые границы — то же самое, что прямые', () => {
    expect(trimClip(c, 1.5, 0.5).keys.map((k) => k.t)).toEqual(trimClip(c, 0.5, 1.5).keys.map((k) => k.t));
  });

  it('границы за пределами клипа зажимаются', () => {
    const t = trimClip(c, -5, 99);
    expect(clipDur(t)).toBeCloseTo(clipDur(c));
    expect(t.keys.length).toBe(3);
  });

  it('нулевой интервал → один кадр (клип не исчезает)', () => {
    const t = trimClip(c, 1, 1);
    expect(t.keys.length).toBe(1);
    expect(t.keys[0]!.pose['Spine']![0]).toBeCloseTo(1, 3);
  });

  it('метки едут с уцелевшими ключами', () => {
    const withMark = clip([
      { t: 0, pose: P({ Spine: [0, 0, 0] }) },
      { t: 1, pose: P({ Spine: [1, 0, 0] }) },
      { t: 2, pose: P({ Spine: [2, 0, 0] }) },
    ]);
    withMark.keys[1]!.marks = [{ type: 'impact', sfx: 'hit_flesh' }];
    const t = trimClip(withMark, 0.5, 1.5);
    expect(t.keys[1]!.marks?.[0]?.type).toBe('impact');
    expect(t.keys[1]!.marks).not.toBe(withMark.keys[1]!.marks);   // копия, а не общая ссылка
  });
});

describe('clipImport — шов цикла', () => {
  const loopy = (): Clip => clip([
    { t: 0, pose: P({ Spine: [0, 0, 0] }) },
    { t: 0.5, pose: P({ Spine: [40 * D, 0, 0] }) },
    { t: 1, pose: P({ Spine: [20 * D, 0, 0] }) },     // ≠ первому → шов рвётся
  ]);

  it('ошибка шва меряется в градусах между первым и последним кадром', () => {
    const g = loopSeamGap(loopy());
    expect(g.deg).toBeCloseTo(20, 0);
    expect(g.bone).toBe('Spine');
  });

  it('жёсткая сшивка (blend 0) закрывает шов В НОЛЬ', () => {
    const c = closeLoopSeam(loopy(), 0);
    expect(loopSeamGap(c).deg).toBeCloseTo(0, 4);
    expect(c.keys[1]!.pose['Spine']![0]).toBeCloseTo(40 * D, 5);   // середину не тронули
  });

  it('мягкая сшивка тянет ХВОСТ к первому кадру с нарастающим весом (нет рывка на стыке)', () => {
    const c = closeLoopSeam(clip([
      { t: 0, pose: P({ Spine: [0, 0, 0] }) },
      { t: 0.4, pose: P({ Spine: [40 * D, 0, 0] }) },
      { t: 0.7, pose: P({ Spine: [30 * D, 0, 0] }) },
      { t: 1, pose: P({ Spine: [20 * D, 0, 0] }) },
    ]), 0.7);
    expect(loopSeamGap(c).deg).toBeCloseTo(0, 4);                  // конец пришёл в начало
    expect(c.keys[0]!.pose['Spine']![0]).toBeCloseTo(0, 5);         // первый кадр неприкосновенен
    expect(c.keys[1]!.pose['Spine']![0]).toBeCloseTo(40 * D, 5);    // НАЧАЛО интервала — вес 0, иначе был бы рывок
    expect(c.keys[2]!.pose['Spine']![0]).toBeLessThan(30 * D);      // середина уже подтянута
    expect(c.keys[2]!.pose['Spine']![0]).toBeGreaterThan(0);
  });

  it('исходник не мутируется', () => {
    const c = loopy();
    closeLoopSeam(c, 0.6);
    expect(c.keys[2]!.pose['Spine']![0]).toBeCloseTo(20 * D, 5);
  });
});

describe('clipImport — прореживание и позиционный канал (регрессия Ф3)', () => {
  const key = (t: number, spine: number, hipsY: number) =>
    ({ t, pose: { Spine: [spine, 0, 0], __hipsD: [0, hipsY, 0] } as Pose });

  it('офсет таза НЕ читается как 86° ошибки — иначе прореживание перестало бы прореживать', () => {
    // Кадр РОВНО на прямой: и угол, и таз интерполируются точно → ошибка ноль.
    const e = poseReconstructError(key(0, 0, 0), key(1, 0, -3), key(0.5, 0, -1.5));
    expect(e).toBeCloseTo(0, 6);
  });

  it('но настоящий излом таза прореживание УДЕРЖИВАЕТ (перенос веса не съедается)', () => {
    const e = poseReconstructError(key(0, 0, 0), key(1, 0, 0), key(0.5, 0, -1.5));
    expect(e).toBeCloseTo(1.5 * POS_DEG_PER_UNIT, 4);
    const dense = [key(0, 0, 0), key(0.5, 0, -1.5), key(1, 0, 0)];
    expect(reduceKeyframes(dense, 3).length).toBe(3);            // 7.5° > 3° → средний кадр остаётся
  });

  it('скаляры настроек (__pinKp до 12000) плотность ключей НЕ задают', () => {
    const k = (t: number, kp: number) => ({ t, pose: { Spine: [0, 0, 0], __pinKp: [kp, 0, 0] } as Pose });
    expect(poseReconstructError(k(0, 0), k(1, 0), k(0.5, 12000))).toBeCloseTo(0, 6);
  });

  it('прямая линия углов схлопывается в 2 ключа (базовое поведение не изменилось)', () => {
    const dense = Array.from({ length: 11 }, (_, i) => key(i / 10, i / 10 * 40 * D, 0));
    expect(reduceKeyframes(dense, 3).length).toBe(2);
  });
});

describe('clipImport — статичность запекания', () => {
  it('порог 2°: ниже — «анимация не дошла до костей»', () => {
    expect(isStaticBake({ frames: 30, keys: 2, maxMoveDeg: 0.4, worstBone: 'Spine' })).toBe(true);
    expect(isStaticBake({ frames: 30, keys: 9, maxMoveDeg: 44, worstBone: 'Spine' })).toBe(false);
  });
});

describe('clipImport — poseAtSec = то же, чем ходит проигрыватель', () => {
  it('на ключе — поза ключа, между — интерполяция', () => {
    const c = clip([{ t: 0, pose: P({ Spine: [0, 0, 0] }) }, { t: 1, pose: P({ Spine: [1, 0, 0] }) }]);
    expect(poseAtSec(c, 0)['Spine']![0]).toBeCloseTo(0);
    expect(poseAtSec(c, 1)['Spine']![0]).toBeCloseTo(1);
    expect(poseAtSec(c, 0.25)['Spine']![0]).toBeCloseTo(0.25, 2);
  });
  it('poseGap игнорирует спец-каналы (они не кости)', () => {
    expect(poseGap({ __hipsD: [0, -9, 0] }, { __hipsD: [0, 9, 0] }).deg).toBe(0);
  });
});
