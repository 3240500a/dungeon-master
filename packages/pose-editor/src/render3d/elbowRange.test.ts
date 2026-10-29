import { describe, it, expect, afterEach } from 'vitest';
import { POSE, POSE_BASE } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';

/**
 * ⭐ ЛОКОТЬ: ПОЛЗУНОК НЕ ДОЛЖЕН УПИРАТЬСЯ В МЁРТВЫЙ ХОД, А УГОЛ — СКЛАДЫВАТЬСЯ ОБ НОЛЬ.
 *
 * Жалоба: «локти — ползунок стал мало реагировать, угол маленький от и до, и они опять
 * начали дёргаться туда-сюда».
 *
 * ДВЕ ПРИЧИНЫ, обе замерены:
 *
 * 1. СКЛАДКА ОБ НОЛЬ. У `o.elL` не было клампа, а ниже по потоку стоит `Math.abs(t.elL)`
 *    (`poseRuntime.ts:350/358`). Как только «локоть — амплитуда» перебирает базу, угол уходит
 *    в минус, и модуль ОТРАЖАЕТ кривую: локоть распрямляется в струну и отскакивает.
 *    ЗАМЕР: разворотов за 240 кадров 7 → 15, дно 0.1°, пик второй производной 0.609 → 14.102 (×23).
 *
 * 2. МЁРТВАЯ ВЕРХНЯЯ ЧЕТВЕРТЬ. Шарнир `ForeL`/`ForeR` физ-рига ограничен 2.4 рад (137.5°), а
 *    ползунок ходил до 3.2 — в ИГРЕ верхняя четверть не отрабатывала, и редактор показывал то,
 *    чего игра не даст. Это то же правило, что у `ankMax`/`armSwingMax`/`kneeDirMax`.
 *
 * ⚠ ТРЕТЬЯ ПРИЧИНА — НЕ В КОДЕ И ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ: авторская idle-стойка владеет руками с
 * весом `1 − sway·moveMag`, и при sway 0.2 ползунку остаётся пятая часть хода (183.3° → 36.7°).
 * Все тесты локтя гоняют ветку БЕЗ стойки, где у ручки полная власть, — поэтому дилюция мимо них
 * и проходила. Теперь про неё говорит сама панель «Бег».
 */
describe('локоть: диапазон и отсутствие складки', () => {
  const saved: Record<string, number> = {};
  const set = (k: string, v: number): void => {
    const p = POSE as unknown as Record<string, number>;
    if (!(k in saved)) saved[k] = p[k]!;
    p[k] = v;
  };
  afterEach(() => {
    const p = POSE as unknown as Record<string, number>;
    for (const k in saved) p[k] = saved[k]!;
    for (const k in saved) delete saved[k];
  });

  /** Прогон бега: след угла локтя из кадра привода. */
  function trace(frames = 240): number[] {
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0;
    const out: number[] = [];
    for (let i = 0; i < frames + 120; i++) {
      z += 90 / 60;
      d.setWorld(0, z, 0, 0, 90);
      d.update(1 / 60);
      // ⚠ МЕРИМ ТО, ЧТО ДОЕЗЖАЕТ ДО КОСТИ. Рантайм кладёт на кость `Math.abs(t.elL)`
      // (`poseRuntime.ts:350/358`), и ИМЕННО модуль складывает кривую. Сырой `out.elL` складки НЕ ВИДИТ
      // — первая версия этого теста проходила даже с вырезанным клампом.
      if (i >= 120) out.push(Math.abs(d.out.elL));
    }
    return out;
  }
  /** Сколько раз кривая меняет направление — прямая мера «дёргается туда-сюда». */
  const reversals = (t: number[]): number => {
    let n = 0;
    for (let i = 2; i < t.length; i++) {
      const a = t[i - 1]! - t[i - 2]!, b = t[i]! - t[i - 1]!;
      if (a * b < 0) n++;
    }
    return n;
  };

  it('потолок локтя = предел шарнира физ-рига (2.4 рад), а не 3.2 ползунка', () => {
    expect(POSE_BASE.elbowMax).toBe(2.4);
  });

  it('⭐ угол локтя НИКОГДА не уходит в минус — иначе Math.abs сложит кривую', () => {
    set('armEl', 0.3); set('armElRun', 0.3);
    set('armElAmp', 1.84); set('armElAmpRun', 1.84);   // амплитуда сильно больше базы — прежний сценарий складки
    const d = new PoseDriver(); d.setMove(1);
    let z = 0, lo = Infinity;
    for (let i = 0; i < 360; i++) { z += 90 / 60; d.setWorld(0, z, 0, 0, 90); d.update(1 / 60); if (i >= 120) lo = Math.min(lo, d.out.elL); }
    expect(lo, '⚠ вернулась складка об ноль: локоть отскакивает от нуля').toBeGreaterThanOrEqual(-1e-9);
  });

  it('⭐ и не дёргается: разворотов не больше, чем у ровного маха', () => {
    set('armEl', 1.2); set('armElRun', 1.2); set('armElAmp', 0.3); set('armElAmpRun', 0.3);
    const calm = reversals(trace());
    set('armEl', 0.3); set('armElRun', 0.3); set('armElAmp', 1.84); set('armElAmpRun', 1.84);
    const wild = reversals(trace());
    expect(wild, '⚠ большая амплитуда снова удваивает число разворотов — это и есть дёрганье').toBeLessThanOrEqual(calm + 1);
  });

  it('потолок реально режет: база выше предела не даёт угла больше предела', () => {
    set('armEl', 3.2); set('armElRun', 3.2); set('armElAmp', 0); set('armElAmpRun', 0);
    expect(Math.max(...trace()), '⚠ поза просит больше, чем даст шарнир призрака').toBeLessThanOrEqual(2.4 + 1e-9);
  });

  it('в рабочем диапазоне ручка по-прежнему работает 1:1 (ничего не сломали)', () => {
    set('armElAmp', 0); set('armElAmpRun', 0);
    const at = (v: number): number => { set('armEl', v); set('armElRun', v); return trace(30)[0]!; };
    expect(at(1.5) - at(0.5)).toBeCloseTo(1.0, 6);
  });
});
