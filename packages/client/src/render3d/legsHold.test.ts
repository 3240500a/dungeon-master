import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { GAIT } from './pose.js';
import { buildHumanoid } from './humanoid.js';
import type { Clip, Pose } from './clipModel.js';

/**
 * ⭐⭐ ЗАТВОР «НОГИ У КЛИПА УДАРА» НЕ ИМЕЕТ ПРАВА ДРЕБЕЗЖАТЬ.
 *
 * Жалоба: «зажимаешь атаку и идёшь — ноги странно дёргаются». Затвор двоичный
 * (`setLegsHeld`: планировщик либо ведёт ногу, либо не трогает), а вход у него — СКОРОСТЬ, которая
 * рябит: снапшоты идут 30 раз в секунду, кадров 60+. ЗАМЕР на старом приводе — **107 переключений
 * за 1.8 с** на скорости у самой границы порога. Планировщик то отпускал ногу, то забирал.
 *
 * Лечится гистерезисом: разные пороги на вход и выход. Это стандартный приём развязки дребезга,
 * а не подгонка числа.
 */
describe('затвор ног у удара', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  const clip = (): Clip => ({
    name: 'hit_none_r_01', character: 'warrior', weapon: 'none', loop: true,
    keys: [{ t: 0, pose: {} as Pose }, { t: 0.5, pose: {} as Pose }, { t: 4, pose: {} as Pose }],
  } as unknown as Clip);

  const mk = (): PosePlayer => new PosePlayer(buildHumanoid({}), () => [], localStorageContent('warrior'), 'none',
    { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());

  /** Удар на ходу со скоростью, рябящей вокруг границы. Возвращает число переключений затвора. */
  const flips = (ripple: number, frames = 180): number => {
    const p = mk();
    p.setYaw(0);
    p.triggerAttack(clip());
    let n = 0, prev: boolean | null = null;
    for (let i = 0; i < frames; i++) {
      const k = 0.94 + (i % 2 ? ripple : -ripple);     // худший случай: рябь ЧЕРЕЗ КАДР
      p.setVel(0, GAIT.speedWalk * k);
      p.step(1 / 60);
      if (prev !== null && p.attackLegsHeld !== prev) n++;
      prev = p.attackLegsHeld;
    }
    return n;
  };

  it('⭐⭐ РЯБЬ СКОРОСТИ НЕ ДРЕБЕЗЖИТ ЗАТВОРОМ', () => {
    // ⚠ Мутация «один порог на вход и выход» валит это: возвращаются десятки переключений.
    expect(flips(0.03), '⚠ ЗАТВОР ДРЕБЕЗЖИТ — ноги будут дёргаться').toBeLessThanOrEqual(1);
  });

  it('⭐ СТОЯЧИЙ УДАР ЗАБИРАЕТ НОГИ (иначе подшаг из клипа не сыграет)', () => {
    const p = mk();
    p.setYaw(0); p.setVel(0, 0);
    p.triggerAttack(clip());
    for (let i = 0; i < 30; i++) { p.setVel(0, 0); p.step(1 / 60); }
    expect(p.attackLegsHeld, '⚠ стоя ноги остались у планировщика — подшаг удара пропадёт').toBe(true);
  });

  it('⭐ НА ПОЛНОМ ХОДУ НОГИ У ПЛАНИРОВЩИКА', () => {
    const p = mk();
    p.setYaw(0);
    p.triggerAttack(clip());
    for (let i = 0; i < 60; i++) { p.setVel(0, GAIT.speedWalk * 2); p.step(1 / 60); }
    expect(p.attackLegsHeld, '⚠ на бегу клип удара держит ноги — походка собьётся').toBe(false);
  });

  it('⚠ ПЕРЕХОД ЕСТЬ, а не «затвор навсегда залип»', () => {
    const p = mk();
    p.setYaw(0); p.triggerAttack(clip());
    for (let i = 0; i < 30; i++) { p.setVel(0, 0); p.step(1 / 60); }
    expect(p.attackLegsHeld).toBe(true);
    for (let i = 0; i < 90; i++) { p.setVel(0, GAIT.speedWalk * 2); p.step(1 / 60); }
    expect(p.attackLegsHeld, '⚠ затвор не отпустил ноги при разгоне').toBe(false);
  });

  it('удара нет — ноги всегда у планировщика', () => {
    const p = mk();
    p.setYaw(0);
    for (let i = 0; i < 30; i++) { p.setVel(0, 0); p.step(1 / 60); }
    expect(p.attackLegsHeld).toBe(false);
  });
});
