import { describe, it, expect } from 'vitest';
import { PosePlayer, measureStancePlants, emptyGrid, type PoseContent, type UpperPose } from './poseRuntime.js';
import { buildHumanoid } from './humanoid.js';
import { setHipsOffset } from './clipModel.js';
import type { Pose } from './clipModel.js';

/**
 * ⭐ ПОВОРОТ НА МЕСТЕ В БОЕВОЙ СТОЙКЕ НЕ ДОЛЖЕН ПОДНИМАТЬ ТАЗ.
 *
 * Жалоба: «когда крутишься на месте, он приподнимает таз, а должен оставлять его согласно позе,
 * в какой находится — комбат или релакс».
 *
 * ПРИЧИНА: `measureStance()` звал `resolveUpper(weapon)` БЕЗ `combat`, то есть с умолчанием 0 —
 * планировщик всегда получал РЕЛАКС-стойку. ЗАМЕР на живом воине с топором: релакс даёт таз
 * **31.72** и планты 3.86 / −3.27, бой — **30.72** и 6.74 / −5.62.
 *
 * ⚠ Пока ноги ведёт САМА ПОЗА, расхождение не видно — оно вылезает ровно на ПОВОРОТЕ НА МЕСТЕ,
 * где ноги забирает планировщик (`legMag` → 1) и высоту таза диктует его `standY`.
 */
describe('боевая стойка и поворот на месте', () => {
  const DROP = 1.2;                                  // насколько боевая стойка ниже релакса

  /** Стойка: таз опущен на `dy` относительно рест-высоты. */
  const stance = (dy: number): Pose => { const p: Pose = {}; setHipsOffset(p, [0, dy, 0]); return p; };
  /** Контент: боевая стойка НИЖЕ релакса, высота едет линейно по `combat`. */
  const content: PoseContent = {
    resolveUpper: (_w: string, combat = 0): UpperPose | null => ({ pose: stance(-DROP * combat), swing: 0 }),
  };

  const mk = (): PosePlayer =>
    new PosePlayer(buildHumanoid({}), () => [], content, 'none', { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());

  /** Высота таза, которую даст замер стойки при данном `combat`. */
  const measured = (combat: number): number =>
    measureStancePlants(buildHumanoid({}), content.resolveUpper('none', combat)!.pose).standY;

  /** Прогон «стоим и крутимся на месте»: максимум высоты таза за оборот. */
  function spin(p: PosePlayer): number {
    p.setVel(0, 0);
    let top = -1e9, yaw = 0;
    for (let i = 0; i < 240; i++) {
      yaw += 0.05;                                   // разворот на месте — подшаг отдаёт ноги планировщику
      p.setYaw(yaw); p.step(1 / 60);
      if (i > 60) top = Math.max(top, 30 + p.driver.out.bobY);
    }
    return top;
  }

  it('замер стойки вообще зависит от боевой оси (иначе тест ниже бессмыслен)', () => {
    expect(measured(0) - measured(1)).toBeCloseTo(DROP, 3);
  });

  it('⭐ в БОЮ поворот на месте держит таз на боевой высоте, а не на релакс-высоте', () => {
    const p = mk();
    p.setYaw(0); p.setCombat(true);
    for (let i = 0; i < 240; i++) p.step(1 / 60);     // дождаться кроссфейда стойки
    expect(p.combat, '⚠ боевая стойка не набралась — тест ничего не проверяет').toBeGreaterThan(0.99);
    // ⚠ Мутация «мерить стойку без combat» валит именно это: таз уедет на релакс-высоту, то есть на DROP выше.
    expect(spin(p), '⚠ ТАЗ ПОДНИМАЕТСЯ НА ПОВОРОТЕ: планировщику дали релакс-стойку')
      .toBeLessThan(measured(1) + 0.05);
  });

  it('в РЕЛАКСЕ поведение прежнее — таз на релакс-высоте', () => {
    const p = mk();
    p.setYaw(0);
    for (let i = 0; i < 60; i++) p.step(1 / 60);
    const top = spin(p);
    expect(top).toBeLessThan(measured(0) + 0.05);
    expect(top, '⚠ в релаксе таз не должен просесть до боевой высоты').toBeGreaterThan(measured(1) + 0.05);
  });

  it('переключение туда-обратно возвращает прежнюю высоту', () => {
    const p = mk();
    p.setYaw(0); p.setCombat(true);
    for (let i = 0; i < 240; i++) p.step(1 / 60);
    p.setCombat(false);
    for (let i = 0; i < 240; i++) p.step(1 / 60);
    expect(p.combat).toBeLessThan(0.01);
    expect(spin(p)).toBeLessThan(measured(0) + 0.05);
  });
});
