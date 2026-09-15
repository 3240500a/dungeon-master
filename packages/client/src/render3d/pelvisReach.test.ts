import { describe, it, expect, afterEach } from 'vitest';
import { PoseDriver, GAIT, GAIT_BASE } from './pose.js';

/**
 * ⭐ ТАЗ ЕДЕТ ПО ДОСЯГАЕМОСТИ ОПОРНОЙ НОГИ (`GAIT.pelvisReach`).
 *
 * Жалоба: «в боевой, когда возвращается в idle, ноги висят в воздухе; надо, чтобы таз мог ездить
 * вверх-вниз, а не был зафиксирован, и персонаж всегда стоял ногами на полу».
 *
 * ПРИЧИНА: просадка таза (`dip`) считает ТОЛЬКО продольную разножку — берётся составляющая «вперёд»
 * (`maxLz`), а боковая отбрасывается. Боевая стойка ШИРЕ спокойной (замер на воине с топором:
 * стопы 9.69 / −8.88 против 8.03 / −7.42), и эта ширина не давала просадки ВООБЩЕ. Плюс `dip`
 * масштабируется стилевым `bobWalk` (у воина 0.48), то есть даже продольная часть половинчатая.
 *
 * ⚠⚠ ПОЧЕМУ РУЧКА, А НЕ ВСЕГДА: безусловный предел сдвинул golden-вектор и уронил 6 сторожей —
 * в обычной ходьбе таз РЕГУЛЯРНО стоит выше досягаемости, и это гасит кламп IK; на этом настроена
 * вся походка. Умолчание 0 = прежнее поведение бит в бит.
 */
describe('таз по досягаемости ног', () => {
  const saved: Record<string, number> = {};
  const set = (k: string, v: number): void => {
    const g = GAIT as unknown as Record<string, number>;
    if (!(k in saved)) saved[k] = g[k]!;
    g[k] = v;
  };
  afterEach(() => {
    const g = GAIT as unknown as Record<string, number>;
    for (const k in saved) g[k] = saved[k]!;
    for (const k in saved) delete saved[k];
  });

  /** Стоим в заданной стойке и ждём, пока таз устоится. Возвращает его высоту. */
  const pelvis = (halfWidth: number, k: number): number => {
    set('pelvisReach', k); set('pelvisReachRun', k);
    const d = new PoseDriver();
    d.setStance(halfWidth, 0, -halfWidth, 0, 34.6);    // стойка: только ШИРИНА, разножки вперёд нет
    d.setMove(0); d.setWorld(0, 0, 0, 0, 0);
    for (let i = 0; i < 200; i++) d.update(1 / 60);
    return 30 + d.out.bobY;
  };
  const WIDE = 9.7, NARROW = 4;

  it('умолчание 0 — ручка выключена', () => {
    expect(GAIT_BASE.pelvisReach).toBe(0);
    expect(GAIT_BASE.pelvisReachRun).toBe(0);
  });

  it('⭐ ВОТ ОН ДЕФЕКТ: при выключенной ручке ширина стойки таз не опускает ВООБЩЕ', () => {
    // Просадка видит только продольную разножку, поэтому узкая и широкая стойки дают ОДНУ высоту —
    // ноги в широкой просто не достают до пола.
    expect(pelvis(WIDE, 0)).toBeCloseTo(pelvis(NARROW, 0), 6);
  });

  it('⭐ с ручкой 1 ширина опускает таз, и чем шире — тем ниже', () => {
    const wide = pelvis(WIDE, 1), narrow = pelvis(NARROW, 1);
    // ⚠ Мутация «считать по maxLz, без боковой» валит это: ширина снова станет невидимой.
    expect(wide, '⚠ ШИРИНА СТОЙКИ СНОВА НЕ ВИДНА — таз не опускается').toBeLessThan(narrow - 0.5);
    expect(wide, '⚠ ручка не действует относительно выключенного состояния').toBeLessThan(pelvis(WIDE, 0) - 0.5);
  });

  it('ползунок действует пропорционально: половина — между', () => {
    const off = pelvis(WIDE, 0), half = pelvis(WIDE, 0.5), full = pelvis(WIDE, 1);
    expect(half).toBeLessThan(off - 0.1);
    expect(half).toBeGreaterThan(full + 0.1);
  });

  it('⚠ узкая стойка при включённой ручке тоже не выше досягаемости (иначе ноги висят и там)', () => {
    expect(pelvis(NARROW, 1)).toBeLessThan(pelvis(NARROW, 0));
  });
});
