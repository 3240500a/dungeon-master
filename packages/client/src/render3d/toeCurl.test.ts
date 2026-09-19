import { describe, it, expect, afterEach } from 'vitest';
import { GAIT, GAIT_BASE } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';

/**
 * ⭐ ЗАГИБ НОСКА НА ОТРЫВЕ (`GAIT.toeOff`) — ЗНАК И СТОРОНА.
 *
 * Жалоба была двойная и с ДВУМЯ РАЗНЫМИ причинами:
 *  • «правая нога гнётся не вверх, а вниз» — ОБЩИЙ ЗНАК. ЗАМЕР на рест-позе по КОНЧИКУ ПАЛЬЦА
 *    (не по углу кости — угол читается неочевидно): `rotation.x = +0.8` → кончик −2.869 по Y,
 *    `−0.8` → +2.869, причём ОДИНАКОВО на обеих ногах. Значит вверх — это МИНУС.
 *  • «левая нога не реагирует вовсе» — НЕ знак и НЕ планировщик: авто-карта костей отдавала
 *    `LeftToes` вспомогалке скина `CC_Base_L_ToeBaseShareBone` (лист без детей). Это чинится
 *    в `retarget3d` и стережётся там же.
 *
 * ⚠ ЗЕРКАЛИТЬ СТОРОНУ НЕ НАДО: `LeftToes` и `RightToes` в нашем риге имеют ОДИН локальный базис
 * (обе кости `[0, −1, 6]` от стопы) — в отличие от рыска стопы и полюса колена, где зеркало есть.
 * Поэтому здесь проверяется, что обе ноги гнут носок В ОДНУ СТОРОНУ и в ПРОТИВОФАЗЕ по времени.
 */
describe('загиб носка на отрыве', () => {
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

  /** Прогон бега: покадровые углы кости носка обеих ног. */
  function run(frames = 240): { L: number[]; R: number[] } {
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0;
    const L: number[] = [], R: number[] = [];
    for (let i = 0; i < frames + 150; i++) {
      z += 90 / 60;
      d.setWorld(0, z, 0, 0, 90);
      d.update(1 / 60);
      if (i >= 150) { L.push(d.out.toeCurlL); R.push(d.out.toeCurlR); }
    }
    return { L, R };
  }

  it('умолчание 0 — кость носка в нуле, как было до ручки', () => {
    expect(GAIT_BASE.toeOff).toBe(0);
    expect(GAIT_BASE.toeOffRun).toBe(0);
    const { L, R } = run();
    expect(L.every((v) => v === 0) && R.every((v) => v === 0), '⚠ при нулевой ручке носок обязан стоять в нуле').toBe(true);
  });

  it('⭐ ПОЛОЖИТЕЛЬНАЯ ручка поднимает носок — то есть даёт ОТРИЦАТЕЛЬНЫЙ угол кости, на ОБЕИХ ногах', () => {
    set('toeOff', 0.8); set('toeOffRun', 0.8);
    const { L, R } = run();
    // ⚠ Мутация «убрать минус» валит именно это: угол уйдёт в плюс, то есть носок под пол.
    expect(Math.min(...L), '⚠ ЛЕВЫЙ носок не поднимается: угол не ушёл в минус').toBeLessThan(-0.3);
    expect(Math.min(...R), '⚠ ПРАВЫЙ носок не поднимается: угол не ушёл в минус').toBeLessThan(-0.3);
    // ⚠ Мутация «зеркалить сторону» (`i === 0 ? curl : -curl`) валит это: одна нога уйдёт в плюс.
    expect(Math.max(...L), '⚠ ЛЕВЫЙ носок где-то гнётся ВНИЗ — сторону зеркалить не надо').toBeLessThan(1e-9);
    expect(Math.max(...R), '⚠ ПРАВЫЙ носок где-то гнётся ВНИЗ — сторону зеркалить не надо').toBeLessThan(1e-9);
  });

  it('⭐ ноги в ПРОТИВОФАЗЕ и с одинаковой силой', () => {
    set('toeOff', 0.8); set('toeOffRun', 0.8);
    const { L, R } = run();
    const mnL = Math.min(...L), mnR = Math.min(...R);
    expect(Math.abs(mnL - mnR), '⚠ одна нога гнёт носок сильнее другой').toBeLessThan(Math.abs(mnL) * 0.25);
    const iL = L.indexOf(mnL);
    expect(Math.abs(R[iL]!), '⚠ на пике ЛЕВОГО носка правый обязан быть почти в нуле — иначе фазы совпали')
      .toBeLessThan(Math.abs(mnR) * 0.35);
  });

  it('окно нулевой ширины = ручка выключена (защита от `from === to`)', () => {
    set('toeOff', 0.8); set('toeOffRun', 0.8);
    set('toeOffFrom', 0.9); set('toeOffFromRun', 0.9);
    set('toeOffTo', 0.9); set('toeOffToRun', 0.9);
    const { L, R } = run();
    // ⚠ `-0` тоже ноль: знак минус перед амплитудой даёт именно его, а `toBe(0)` различает нули по знаку.
    expect(Math.max(...L.map(Math.abs), ...R.map(Math.abs)), '⚠ при схлопнутом окне носок обязан остаться в нуле').toBe(0);
  });
});
