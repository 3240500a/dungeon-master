import { describe, it, expect, afterEach } from 'vitest';
import { PoseDriver, GAIT, GAIT_BASE } from './pose.js';

/**
 * ⭐ ПЛАВНОСТЬ БОБА ТАЗА И ОКНО ЗАЗЕМЛЕНИЯ — НАСТРОЙКИ, А НЕ ЗАШИТЫЕ ЧИСЛА.
 *
 * Жалоба: «боб таза как-то резко происходит», «заземление тоже резко». ЗАМЕР в живом редакторе
 * на бегу нашёл три независимые причины, и ни одна не была ручкой:
 *
 * 1. ФАЗА ПОЛЁТА. Опорной ноги нет → цель высоты таза прыгала на ПОЛНЫЙ рост стоя. Замер: верх
 *    дуги таза 34.757 при росте стоя 34.769, а в кадр касания таз падал на 0.223 ЗА КАДР. Доля
 *    полёта растёт со скоростью (0.107 → 0.507) и размах боба растёт ВМЕСТЕ с ней (0 → 0.761)
 *    при неизменной разножке стоп — то есть это был не боб, а артефакт полёта.
 * 2. СГЛАЖИВАНИЕ БЫЛО ЗАШИТО: `speed > speedWalk ? dt*14 : rising ? dt*10 : 1`. Третья ветка —
 *    вообще без фильтра (таз падает в цель за кадр), а сам порог давал разрыв на 39.9 → 40.1.
 * 3. ОПОРНОСТЬ — БУЛЕВА. В кадр переключения заземление хватало стопу на полную (замер: подошва
 *    3.655 → 1.710 за кадр).
 *
 * Сторож проверяет, что ручки РЕАЛЬНО правят каждую из трёх, а умолчания оставляют прежнее поведение.
 */
describe('боб таза и заземление — ручки, а не константы', () => {
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

  /** Прогон бега: вернуть след высоты таза и худший скачок между кадрами. */
  function run(speed: number, frames = 240): { trace: number[]; jump: number } {
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0;
    const trace: number[] = [];
    for (let i = 0; i < frames + 120; i++) {
      z += speed / 60;
      d.setWorld(0, z, 0, 0, speed);
      d.update(1 / 60);
      if (i >= 120) trace.push(d.out.bobY);
    }
    let jump = 0;
    for (let i = 1; i < trace.length; i++) jump = Math.max(jump, Math.abs(trace[i]! - trace[i - 1]!));
    return { trace, jump };
  }

  it('умолчания = прежние зашитые числа (бег 14/14, ходьба 10 вверх, полёт к стойке)', () => {
    expect(GAIT_BASE.bobLagUpRun).toBe(14);
    expect(GAIT_BASE.bobLagDownRun).toBe(14);
    expect(GAIT_BASE.bobLagUp).toBe(10);
    // ⚠ НЕ 60: см. комментарий в `pose.ts` — 60 протащило бы «ходьба без фильтра» в полосу ходьба↔бег и сделало её РЕЗЧЕ прежнего.
    expect(GAIT_BASE.bobLagDown).toBe(14);
    expect(GAIT_BASE.bobFlight).toBe(1);
    expect(GAIT_BASE.gndIn).toBe(0);
    expect(GAIT_BASE.gndOut).toBe(1);
  });

  it('⭐ «таз в полёте» РЕАЛЬНО убирает рывок в кадр касания', () => {
    const before = run(GAIT.speedRun).jump;
    set('bobFlight', 0);
    const after = run(GAIT.speedRun).jump;
    expect(after, '⚠ ручка полёта декоративна — цель по-прежнему прыгает к стойке').toBeLessThan(before * 0.75);
  });

  it('⭐ плавность боба РЕАЛЬНО меняет резкость', () => {
    const stiff = run(GAIT.speedRun).jump;
    set('bobLagUpRun', 2); set('bobLagDownRun', 2);
    const soft = run(GAIT.speedRun).jump;
    expect(soft, '⚠ скорость сглаживания взята мимо ручки').toBeLessThan(stiff * 0.8);
  });

  it('порога speedWalk больше нет: сглаживание непрерывно по скорости', () => {
    // Раньше 39.9 → 40.1 переключало множитель с «мгновенно» на dt·14 скачком.
    set('bobLagUp', 2); set('bobLagUpRun', 40);   // развели концы, чтобы разрыв был заметен
    set('bobLagDown', 2); set('bobLagDownRun', 40);
    const a = run(GAIT.speedWalk - 0.2).trace;
    const b = run(GAIT.speedWalk + 0.2).trace;
    const avg = (x: number[]): number => x.reduce((s, v) => s + v, 0) / x.length;
    expect(Math.abs(avg(a) - avg(b)), '⚠ у порога скорости снова разрыв').toBeLessThan(0.5);
  });

  it('⭐ вес заземления НЕПРЕРЫВЕН: окно даёт промежуточные значения, а не только 0 и 1', () => {
    set('gndIn', 0.3); set('gndInRun', 0.3);
    set('gndOut', 0.7); set('gndOutRun', 0.7);
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0;
    const mid: number[] = [];
    for (let i = 0; i < 400; i++) {
      z += GAIT.speedRun / 60;
      d.setWorld(0, z, 0, 0, GAIT.speedRun);
      d.update(1 / 60);
      for (const w of d.groundWeights) if (w > 1e-3 && w < 1 - 1e-3) mid.push(w);
    }
    expect(mid.length, '⚠ вес заземления снова булев — окно не работает').toBeGreaterThan(5);
  });

  it('окно по умолчанию = вес 1 на всей опоре (прежнее поведение)', () => {
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0;
    let bad = 0;
    for (let i = 0; i < 300; i++) {
      z += GAIT.speedRun / 60;
      d.setWorld(0, z, 0, 0, GAIT.speedRun);
      d.update(1 / 60);
      const sw = d.swingLegs, w = d.groundWeights;
      for (let k = 0; k < 2; k++) if (!sw[k] && Math.abs(w[k]! - 1) > 1e-6) bad++;   // опорная обязана весить ровно 1
    }
    expect(bad, '⚠ умолчания окна изменили поведение опорной ноги').toBe(0);
  });

  it('маховая нога весит 0 всегда — её заземлять нельзя ни при каком окне', () => {
    set('gndIn', 0.4); set('gndInRun', 0.4);
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0, bad = 0;
    for (let i = 0; i < 300; i++) {
      z += GAIT.speedRun / 60;
      d.setWorld(0, z, 0, 0, GAIT.speedRun);
      d.update(1 / 60);
      const sw = d.swingLegs, w = d.groundWeights;
      for (let k = 0; k < 2; k++) if (sw[k] && w[k] !== 0) bad++;
    }
    expect(bad, '⚠ маховую ногу тянет к полу — будет «лыжник»').toBe(0);
  });

  it('⭐⭐ СТОЯ ЗАЗЕМЛЕНИЕ ПОЛНОЕ — окно описывает фазу ШАГА, а не стойку', () => {
    // Жалоба: «в боевой, когда возвращается в idle, ноги висят в воздухе, таз зафиксирован».
    // ПРИЧИНА: стоя фаза опоры прибита к 1, то есть ровно в «выход из опоры», и вес окна выходил
    // НОЛЬ — ЗАМЕР `groundWeights` стоя и на развороте был [0, 0] при ОБЕИХ ногах опорных.
    // Заземление выключалось целиком: стопы висели там, где их оставил IK (замер на живом воине
    // в боевой стойке: левая 1.221 над полом), а таз стоял колом. После починки обе лодыжки
    // ровно на полу — отрыв 0.000 / 0.000.
    // ⚠ ОКНО ОБЯЗАНО БЫТЬ СУЖЕНО, иначе дефекта не воспроизвести: при умолчании (`gndIn` 0,
    // `gndOut` 1) обе рампы вырождаются в единицу и вес стоя выходит 1 САМ СОБОЙ. Беда живёт
    // ровно на настроенном окне — у воина стояло 0.9 / 0.24.
    set('gndIn', 0.9); set('gndInRun', 0.9); set('gndOut', 0.24); set('gndOutRun', 0.24);
    const d = new PoseDriver();
    d.setStance(9.7, 0, -8.9, 0, 34.6);          // ШИРОКАЯ боевая стойка
    d.setMove(0); d.setWorld(0, 0, 0, 0, 0);
    for (let i = 0; i < 200; i++) d.update(1 / 60);
    expect(d.swingLegs, 'подстраховка: стоя обе ноги опорные').toEqual([false, false]);
    expect(d.groundWeights, '⚠ СТОЯ ЗАЗЕМЛЕНИЕ ВЫКЛЮЧЕНО — стопы повиснут там, где их оставил IK').toEqual([1, 1]);
  });

  it('на ходу окно по-прежнему работает (стоячая ветка его не подменила)', () => {
    // ⚠ Умолчание окна РАСПАХНУТО (`gndIn` 0, `gndOut` 1) — при нём вес и так всегда ровно 1,
    // и проверять было бы нечего. Сужаем окно, как это делает живой тюн.
    set('gndIn', 0.3); set('gndInRun', 0.3); set('gndOut', 0.7); set('gndOutRun', 0.7);
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0, sawPartial = false;
    for (let i = 0; i < 400; i++) {
      z += 90 / 60; d.setWorld(0, z, 0, 0, 90); d.update(1 / 60);
      if (i > 150) for (const w of d.groundWeights) if (w > 1e-6 && w < 1 - 1e-6) sawPartial = true;
    }
    expect(sawPartial, '⚠ на ходу вес стал ступенькой 0/1 — окно перестало действовать').toBe(true);
  });
});
