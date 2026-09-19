import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { GAIT } from './gaitKnobs.js';
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

  /** Удар на ходу со скоростью, рябящей ВОКРУГ `center`. Возвращает число переключений затвора. */
  const flips = (center: number, ripple: number, frames = 180): number => {
    const p = mk();
    p.setYaw(0);
    p.triggerAttack(clip());
    let n = 0, prev: boolean | null = null;
    for (let i = 0; i < frames; i++) {
      const k = center + (i % 2 ? ripple : -ripple);   // худший случай: рябь ЧЕРЕЗ КАДР
      p.setVel(0, GAIT.speedWalk * k);
      p.step(1 / 60);
      if (prev !== null && p.attackLegsHeld !== prev) n++;
      prev = p.attackLegsHeld;
    }
    return n;
  };

  it('⭐⭐ РЯБЬ СКОРОСТИ НЕ ДРЕБЕЗЖИТ ЗАТВОРОМ — НИ НА КАКОЙ СКОРОСТИ', () => {
    // ⚠ Мутация «один порог на вход и выход» валит это: на скорости, попавшей ровно на порог,
    // затвор переключается КАЖДЫЙ КАДР. Проверяем весь диапазон, а не одну точку: где именно стоит
    // порог — дело реализации, а дребезжать он не имеет права нигде.
    for (const c of [0.04, 0.08, 0.12, 0.16, 0.2, 0.5, 0.95]) {
      expect(flips(c, 0.04), `⚠ ЗАТВОР ДРЕБЕЗЖИТ на скорости ${c} — ноги будут дёргаться`).toBeLessThanOrEqual(1);
    }
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

  it('⭐⭐ БЬЁМ И КРУТИМСЯ НА МЕСТЕ — НОГИ У ПЛАНИРОВЩИКА (иначе стопы плывут без подшагов)', () => {
    // Жалоба: «если бить и крутиться на месте, ноги плывут, подшагов нет». Скорость при этом НОЛЬ,
    // поэтому старое правило `1 − moveMag` отдавало ноги клипу — и планировщику нечем было
    // переступать. ⚠ Мутация «не смотреть на поворот» валит этот тест.
    const p = mk();
    p.setYaw(0); p.setVel(0, 0);
    p.triggerAttack(clip());
    for (let i = 0; i < 30; i++) { p.setVel(0, 0); p.step(1 / 60); }
    expect(p.attackLegsHeld, 'стоя и не крутясь — ноги у клипа').toBe(true);
    const seen: boolean[] = [];
    for (let i = 0; i < 90; i++) { p.setYaw(i * 0.05); p.setVel(0, 0); p.step(1 / 60); seen.push(p.attackLegsHeld); }
    // ⚠ МЕРИМ ХВОСТ, А НЕ ВЕСЬ ПРОГОН. У доворота таза своя мёртвая зона (пока прицел ушёл на
    // считанные градусы, таз не двигается и переступать нечем) — первые ~0.2 с ноги законно у клипа.
    // Важно другое: как только таз ПОШЁЛ, ноги обязаны быть у планировщика и остаться там.
    const tail = seen.slice(30);
    expect(tail.filter(Boolean).length, `⚠ клип держал ноги ${tail.filter(Boolean).length} кадров из ${tail.length}, пока персонаж крутился`).toBe(0);
  });

  it('⭐ ПОВОРОТ КОНЧИЛСЯ — ноги возвращаются клипу', () => {
    const p = mk();
    p.setYaw(0); p.triggerAttack(clip());
    for (let i = 0; i < 60; i++) { p.setYaw(i * 0.05); p.setVel(0, 0); p.step(1 / 60); }
    const yaw = 59 * 0.05;
    for (let i = 0; i < 180; i++) { p.setYaw(yaw); p.setVel(0, 0); p.step(1 / 60); }
    expect(p.attackLegsHeld, '⚠ после поворота ноги так и не вернулись в анимацию').toBe(true);
  });

  it('⚠ ПОЛУМЕРЫ НЕТ: на ходу клип не владеет ногами ЧАСТИЧНО', () => {
    // Старое `1 − moveMag` на шаге давало ровно половину статичной позы поверх шагающей походки —
    // «то шаг, то резко улетают». Правило двоичное: либо клип, либо планировщик.
    const p = mk();
    p.setYaw(0); p.triggerAttack(clip());
    for (let i = 0; i < 90; i++) { p.setVel(0, GAIT.speedWalk * 0.5); p.step(1 / 60); }
    expect(p.attackLegsHeld, '⚠ на половинной скорости ноги всё ещё у клипа').toBe(false);
  });

  it('удара нет — ноги всегда у планировщика', () => {
    const p = mk();
    p.setYaw(0);
    for (let i = 0; i < 30; i++) { p.setVel(0, 0); p.step(1 / 60); }
    expect(p.attackLegsHeld).toBe(false);
  });
});
