import { describe, it, expect } from 'vitest';
import { buildHumanoid } from './humanoid.js';
import { GAIT } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';
import { groundFeet } from './footIk.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * ЗАЗЕМЛЕНИЕ ОБЯЗАНО ЗНАТЬ, КАКАЯ НОГА ОПОРНАЯ.
 *
 * Жалоба: «настройки в поз-редакторе на стопу не влияют никак». Ручки работали — их стирало
 * заземление: редактор звал `groundFeet` БЕЗ `support`, и тот угадывал опорность по высоте стопы
 * (`PLANT_MAX = 6`). Маховая стопа поднимается по синусу до `liftWalk = 7`, то есть В НАЧАЛЕ И В
 * КОНЦЕ ПЕРЕНОСА она ниже порога, признаётся опорной и кладётся ПЛОСКО — ровно в тех кадрах, где
 * подъём носка и нужен.
 *
 * Игра при этом опорность передавала всегда. То есть редактор показывал НЕ ТО, что игра, — ровно
 * то, ради чего он и существует ([[editor-equals-game]]).
 */
const DT = 1 / 60;
const G = (): { off: number } => ({ off: 0 });

/** Прогон ходьбы; на каждом маховом кадре сравниваем угол стопы до и после заземления. */
const run = (withSupport: boolean): { worst: number; frames: number; lowFrames: number } => {
  const h = buildHumanoid({});
  const d = new PoseDriver();
  const foot = h.bones.get('LeftFoot')!;
  const up = h.bones.get('LeftUpperLeg')!, lo = h.bones.get('LeftLowerLeg')!;
  let z = 0, worst = 0, frames = 0, lowFrames = 0;
  for (let i = 0; i < 260; i++) {
    z += 60 * DT;
    d.setWorld(0, z, 0, 0, 60);
    const t = d.update(DT);
    if (i < 200) continue;                       // разгон пропускаем: там приставные шаги и осадка стойки
    const sw = d.swingLegs;
    if (!sw[0]) continue;
    up.rotation.set(t.hipL, t.hipTwL, t.hipLatL);
    lo.rotation.set(t.knL, 0, 0);
    foot.rotation.set(t.ankL, 0, 0);
    h.root.updateMatrixWorld(true);
    const before = foot.rotation.x;
    groundFeet(h, h.hipsWorldY(), G(), 1e3, () => 0, withSupport ? [!sw[0], !sw[1]] : undefined);
    worst = Math.max(worst, Math.abs(foot.rotation.x - before));
    frames++;
    if (Math.abs(foot.rotation.x - before) > 1e-6) lowFrames++;
  }
  return { worst, frames, lowFrames };
};

describe('опорность из позы, а не угадывание по высоте', () => {
  it('⭐ С support угол маховой стопы НЕ трогается ни в одном кадре', () => {
    const r = run(true);
    expect(r.frames, 'маховых кадров должно набраться').toBeGreaterThan(15);
    expect(r.worst, 'заземление не смеет править маховую ногу').toBeLessThan(1e-9);
  });

  it('⚠ БЕЗ support — стирает, и это замер, а не опасение', () => {
    // Ровно этот случай и был в редакторе. Если однажды перестанет стирать (подняли PLANT_MAX,
    // изменили liftWalk) — тест упадёт и скажет, что страховка больше не нужна в этом виде.
    const r = run(false);
    expect(r.lowFrames, 'испорченных кадров').toBeGreaterThan(0);
    expect(r.worst, 'величина порчи').toBeGreaterThan(0.02);
  });

  it('порог опорности и подъём стопы всё ещё пересекаются — отсюда и берётся ошибка', () => {
    // PLANT_MAX = 6 (footIk), а подъём маховой стопы на ходьбе = liftWalk. Пока второе больше
    // первого лишь чуть-чуть, «угадывание по высоте» обязано ошибаться на концах переноса.
    expect(GAIT.liftWalk, 'подъём стопы на ходьбе').toBeGreaterThan(0);
    expect(GAIT.liftWalk, 'и он сопоставим с порогом опорности 6').toBeLessThan(20);
  });
});

describe('сторож: редактор действительно передаёт опорность', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pose-editor.ts'), 'utf8');

  it('вид манекена спрашивает опорность у планировщика', () => {
    // Мало, что `groundManikin` УМЕЕТ принимать support — его можно снова позвать пустым, и именно
    // так редактор и жил. Требуем, чтобы вызов в кадре реально передавал маховые ноги.
    // Аргумент берём до конца строки: у `lp().groundSupport` свои скобки, и `[^)]*` обрывался бы на `lp(`.
    const call = src.match(/groundManikin\([^;\n]*/g) ?? [];
    expect(call.length, 'вызовы должны находиться').toBeGreaterThan(0);
    const withSup = call.filter((c) => c.includes('groundSupport'));
    expect(withSup.length, `из ${call.length} вызовов с опорностью: ${withSup.length}`).toBeGreaterThanOrEqual(2);
  });

  it('опорность берётся у ТОГО ЖЕ плеера, что рисует позу', () => {
    // ⚠ Было `lp().driver.swingLegs` — флаги планировщика. Стало `lp().groundSupport`: на повороте на
    // месте клипом ноги у планировщика отобраны, он считает обе опорными, и маховую ногу клипа
    // заземление положило бы на пол. Опорность теперь решает плеер: обычно — планировщик, на
    // повороте — сам клип. Требование «тот же плеер, что рисует позу» при этом не изменилось.
    expect(src).toContain('lp().groundSupport');
    expect(src, '⚠ редактор снова читает флаги планировщика мимо плеера').not.toContain('lp().driver.swingLegs');
  });
});
