import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { GAIT, GAIT_BASE } from './gaitKnobs.js';
import { buildHumanoid } from './humanoid.js';

/**
 * ⭐⭐ ПЕРЕДАЧА ШАГА МЕЖДУ РЕЖИМАМИ: СТОПА НЕ ИМЕЕТ ПРАВА ОТМАТЫВАТЬСЯ НАЗАД.
 *
 * Жалоба: «бежишь, резко встал — нога, летевшая к своему планту, дёргается назад и падает под тело».
 * ЗАМЕР: стопа уезжала назад на **35 единиц за ОДИН кадр** при штатном максимуме 4.3 ед/кадр —
 * то есть в восемь раз больше всего, что бывает в движении.
 *
 * Причина: у планировщика два режима (фаза походки и приставные шаги), и ходовая ветка обнуляла
 * счётчик приставного шага КАЖДЫЙ кадр. На переходе стоячая ветка начинала перенос с нуля, а позиция
 * в переносе считается от точки ОТРЫВА — значит нога рисовалась почти там, откуда оторвалась.
 *
 * ⚠ ИНВАРИАНТ, КОТОРЫЙ ЭТО СТЕРЕЖЁТ: при смене режима стопа за кадр не смещается больше, чем в
 * штатном движении. Он проверяется НА ВСЕХ ФАЗАХ остановки, а не на одной: старый рывок зависел от
 * того, в какой точке дуги застала остановка, и одна выбранная фаза его пропускала.
 */
describe('передача шага при остановке', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    GAIT.stepCommit = GAIT_BASE.stepCommit!;
  });

  /** Путь обеих стоп по Z (мировой, с учётом тредмила). */
  function trace(plan: number[]): { L: number; R: number }[] {
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none',
      { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());
    p.setYaw(0);
    const foot = (b: string): number => {
      const o = h.bones.get('Hips')!.position.clone().set(0, 0, 0);
      h.bones.get(b)!.getWorldPosition(o);
      return o.z + p.posZ;
    };
    const out: { L: number; R: number }[] = [];
    for (const v of plan) { p.setVel(0, v); p.step(1 / 60); out.push({ L: foot('LeftFoot'), R: foot('RightFoot') }); }
    return out;
  }
  const seg = (...s: [number, number][]): number[] => s.flatMap(([n, v]) => new Array<number>(n).fill(v));

  /**
   * Худший сдвиг стопы за кадр в окне `[from, to)` (знак сохраняем: назад — отрицательный).
   *
   * ⚠ ОКНО, А НЕ «ДО КОНЦА». Дефект был РАЗРЫВОМ ровно на кадре смены режима; а позже, уже в стоячем
   * режиме, штатный приставной шаг законно двигает стопу назад в стойку — и быстрее, чем медленная
   * ходьба несёт её вперёд. Мерить одно правило на обоих отрезках значит запретить нормальный подшаг.
   */
  function worst(t: { L: number; R: number }[], from: number, to = t.length): { max: number; back: number } {
    let max = 0, back = 0;
    for (let i = Math.max(1, from); i < Math.min(to, t.length); i++) {
      for (const s of ['L', 'R'] as const) {
        const d = t[i]![s] - t[i - 1]![s];
        max = Math.max(max, Math.abs(d)); back = Math.min(back, d);
      }
    }
    return { max, back };
  }
  /** Штатный максимум скорости стопы на этой скорости — эталон, с которым сравниваем переход. */
  const steady = (v: number): number => worst(trace(seg([200, v])), 1).max;

  /** Скан ВСЕХ фаз остановки: останавливаемся на каждом из 24 кадров цикла. */
  function stopScan(speed: number, window = 4): { max: number; back: number } {
    let max = 0, back = 0;
    for (let off = 0; off < 24; off++) {
      const stop = 150 + off;
      const w = worst(trace(seg([stop, speed], [90, 0])), stop - 1, stop + window);
      max = Math.max(max, w.max); back = Math.min(back, w.back);
    }
    return { max, back };
  }
  /** Тот же скан, но по ВСЕМУ хвосту — чтобы грубый разрыв не спрятался за окном. */
  function stopScanAll(speed: number): number {
    let max = 0;
    for (let off = 0; off < 24; off++) { const stop = 150 + off; max = Math.max(max, worst(trace(seg([stop, speed], [90, 0])), stop - 1).max); }
    return max;
  }

  it('⭐⭐ БЕГ → РЕЗКИЙ СТОП: стопа не отматывается назад', () => {
    // ⚠ Мутация «не передавать прогресс шага» валит это: возвращается рывок в десятки единиц.
    const ref = steady(GAIT.speedRun);
    const s = stopScan(GAIT.speedRun);
    expect(-s.back, `⚠ СТОПА УЕХАЛА НАЗАД на ${(-s.back).toFixed(1)} ед за кадр (штатный максимум ${ref.toFixed(1)})`)
      .toBeLessThan(ref);
  });

  it('⭐ БЕГ → РЕЗКИЙ СТОП: скорости стопы не подскакивают', () => {
    // ⚠ Мутация «не переносить ТЕМП переноса» валит это: остаток дуги проигрывается за длительность
    // приставного шага, и стопа на переходе ускоряется вдвое (замер до правки — 8.7 против 4.3).
    const ref = steady(GAIT.speedRun);
    expect(stopScan(GAIT.speedRun).max, '⚠ на переходе стопа быстрее, чем когда-либо в беге').toBeLessThan(ref * 1.35);
  });

  it('⭐ ХОДЬБА → СТОП — тот же инвариант', () => {
    const ref = steady(GAIT.speedWalk);
    const s = stopScan(GAIT.speedWalk);
    expect(-s.back, '⚠ стопа уехала назад на смене режима').toBeLessThan(ref);
    expect(s.max, '⚠ скачок скорости стопы на смене режима').toBeLessThan(ref * 1.6);
  });

  it('⚠ и после перехода разрыва тоже нет — не только в окне смены режима', () => {
    // Окно в 4 кадра ловит сам разрыв; этот тест страхует, что хвост (приставной шаг, уход в idle)
    // не даёт скачка на порядок. Порог свободнее: подшаг ЗАКОННО быстрее медленной ходьбы.
    expect(stopScanAll(GAIT.speedRun)).toBeLessThan(steady(GAIT.speedRun) * 1.5);
    expect(stopScanAll(GAIT.speedWalk)).toBeLessThan(steady(GAIT.speedWalk) * 2);
  });

  it('⭐⭐ РУЧКА ТОЧКИ НЕВОЗВРАТА ДЕЙСТВУЕТ — и на обоих краях инвариант держится', () => {
    // 0 — доносим всегда, 1 — перецеливаем всегда. Оба пути обязаны быть непрерывными: если рывок
    // вылезает на краю, значит один из двух путей передачи сделан неверно.
    const ref = steady(GAIT.speedRun);
    for (const c of [0, 1]) {
      GAIT.stepCommit = c;
      const s = stopScan(GAIT.speedRun);
      expect(-s.back, `⚠ stepCommit=${c}: стопа уехала назад`).toBeLessThan(ref);
      expect(s.max, `⚠ stepCommit=${c}: скачок скорости стопы`).toBeLessThan(ref * 1.5);
    }
  });

  it('умолчание ручки — середина дуги', () => {
    expect(GAIT_BASE.stepCommit).toBeGreaterThan(0);
    expect(GAIT_BASE.stepCommit).toBeLessThan(1);
  });
});
