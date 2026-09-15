import { describe, it, expect, afterEach } from 'vitest';
import { PoseDriver, GAIT } from './pose.js';

/**
 * ⭐ ПОДЪЁМ И ЗАГИБ НОСКА — ТОЛЬКО ДЛЯ ШАГА ПОХОДКИ, НЕ ДЛЯ ДОВОРОТА.
 *
 * Жалоба: «он носки поднимает при повороте; я настраивал подъём носков на определённую фазу в беге
 * и ходьбе, это не должно ехать в повороты».
 *
 * ПРИЧИНА: на ПРИСТАВНОМ ШАГЕ (поворот на месте) нога тоже помечена маховой (`sw > 0`), а обе ручки
 * висят ровно на этом признаке — вот они и отыгрывали фазу, которой в довороте нет.
 *
 * ⚠ ГЕЙТ НЕ ПОРОГОВЫЙ И НЕ ПОЛНЫЙ `moveAmt`: порог щёлкал бы на старте, а полная доля хода урезала
 * бы ручки на медленной ходьбе (moveAmt 0.5 → подъём вдвое меньше, чего никто не просил).
 * Полная сила уже при `moveAmt` 0.2 — то есть на любом реальном ходе.
 */
describe('носок не ездит в поворот на месте', () => {
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

  /** Поворот НА МЕСТЕ: собрать углы голеностопа и носка за приставные шаги. */
  function turnInPlace(): { ank: number[]; toe: number[]; steps: number } {
    const d = new PoseDriver();
    d.setStance(8, 5.3, -7.4, -2.4, 24);
    d.setMove(0);
    let yaw = 0, steps = 0, wasSw = false;
    const ank: number[] = [], toe: number[] = [];
    for (let i = 0; i < 600; i++) {
      yaw += (i > 60 && i < 260) ? 0.6 / 60 : 0;          // медленный разворот, потом стоим
      d.setWorld(0, 0, yaw, 0, 0); d.setGoalYaw(yaw); d.update(1 / 60);
      const sw = d.swingLegs[0];
      if (sw && !wasSw) steps++;
      if (sw) { ank.push(d.out.ankL); toe.push(d.out.toeCurlL); }
      wasSw = sw;
    }
    return { ank, toe, steps };
  }

  /** Ходьба: те же каналы на настоящем шаге. */
  function walk(): { ank: number[]; toe: number[] } {
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0;
    const ank: number[] = [], toe: number[] = [];
    for (let i = 0; i < 400; i++) {
      z += 60 / 60; d.setWorld(0, z, 0, 0, 60); d.update(1 / 60);
      if (i > 150 && d.swingLegs[0]) { ank.push(d.out.ankL); toe.push(d.out.toeCurlL); }
    }
    return { ank, toe };
  }

  it('⭐ НА ПОВОРОТЕ подъём носка не действует (ручка выкручена — разницы нет)', () => {
    set('toeLift', 0); set('toeLiftRun', 0);
    const a = turnInPlace();
    expect(a.steps, 'подстраховка: приставные шаги вообще были').toBeGreaterThan(0);
    set('toeLift', 0.6); set('toeLiftRun', 0.6);
    const b = turnInPlace();
    expect(b.ank.length).toBe(a.ank.length);
    // ⚠ Мутация «убрать гейт» валит именно это: подъём поедет в доворот.
    const worst = Math.max(...a.ank.map((v, i) => Math.abs(v - b.ank[i]!)));
    expect(worst, '⚠ ПОДЪЁМ НОСКА ЕДЕТ В ПОВОРОТ — он настроен под фазу шага, которой тут нет').toBeLessThan(1e-9);
  });

  it('⭐ НА ПОВОРОТЕ загиб носка тоже молчит', () => {
    set('toeOff', 0.8); set('toeOffRun', 0.8);
    const { toe } = turnInPlace();
    expect(Math.max(...toe.map(Math.abs)), '⚠ ЗАГИБ НОСКА ЕДЕТ В ПОВОРОТ').toBeLessThan(1e-9);
  });

  it('⭐ НА ХОДУ обе ручки работают как работали', () => {
    set('toeLift', 0); set('toeLiftRun', 0);
    const a = walk();
    set('toeLift', 0.6); set('toeLiftRun', 0.6);
    const b = walk();
    // ⚠ Мутация «гейт всегда 0» валит это: ручки перестали бы действовать вообще.
    const worst = Math.max(...a.ank.map((v, i) => Math.abs(v - b.ank[i]!)));
    expect(worst, '⚠ подъём носка перестал действовать и на ходу').toBeGreaterThan(0.05);
    set('toeOff', 0.8); set('toeOffRun', 0.8);
    expect(Math.max(...walk().toe.map(Math.abs)), '⚠ загиб носка перестал действовать и на ходу').toBeGreaterThan(0.05);
  });
});
