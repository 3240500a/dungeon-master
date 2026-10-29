import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { POSE, POSE_BASE } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';

/**
 * ПОТОЛОК МАХА ПЛЕЧА.
 *
 * Жалоба: «задираешь ползунок маха — руки скачут куда-то назад, как будто угла не хватает и они
 * возвращаются в начальное положение».
 *
 * ⚠ Угла действительно не хватает, и это не сбой. Замер: при `armSwing = 3` угол плеча уходил
 * в **−186°**, то есть ЗА ПОЛ-ОБОРОТА. Поворот на −186° — ТА ЖЕ ОРИЕНТАЦИЯ, что +174°: рука
 * оказывается впереди-вверху вместо того, чтобы идти дальше назад. У ориентации нет «дальше 180°».
 *
 * Вдобавок видимый меш ведёт физ-призрак, а сустав плеча ограничен ±1.7…1.9 рад (±97…109°) —
 * всё, что просят сверх, до экрана всё равно не доедет.
 */
const DT = 1 / 60;
const KNOBS = ['armSwing', 'armSwingRun', 'armSwingMax'] as const;
const restore = (): void => { for (const k of KNOBS) (POSE as unknown as Record<string, number>)[k] = (POSE_BASE as unknown as Record<string, number>)[k]!; };

/** Диапазон угла плеча за установившийся цикл ходьбы. */
const shoulderRange = (swing: number): { min: number; max: number; frames: number } => {
  POSE.armSwing = swing; POSE.armSwingRun = swing;
  const d = new PoseDriver();
  let z = 0, min = Infinity, max = -Infinity, frames = 0;
  for (let i = 0; i < 300; i++) {
    z += 60 * DT;
    d.setWorld(0, z, 0, 0, 60);
    const t = d.update(DT);
    if (i < 200) continue;
    min = Math.min(min, t.shL, t.shR); max = Math.max(max, t.shL, t.shR); frames++;
  }
  return { min, max, frames };
};

describe('почему рука «скакала назад» — механика заворота', () => {
  it('поворот на 186° и на −174° — ОДНА И ТА ЖЕ ориентация', () => {
    // Это и есть причина. Не баг кода, а свойство поворотов: за пол-оборота «дальше» не бывает.
    const X = new THREE.Vector3(1, 0, 0);
    const a = new THREE.Quaternion().setFromAxisAngle(X, 186 * Math.PI / 180);
    const b = new THREE.Quaternion().setFromAxisAngle(X, -174 * Math.PI / 180);
    const v = new THREE.Vector3(0, -10, 0);
    const pa = v.clone().applyQuaternion(a), pb = v.clone().applyQuaternion(b);
    expect(pa.distanceTo(pb), 'кисть встаёт в ту же точку').toBeLessThan(1e-6);
  });
});

describe('потолок держит угол по эту сторону пол-оборота', () => {
  beforeEach(restore);

  it('⭐ при любой амплитуде угол не выходит за потолок', () => {
    for (const s of [1, 2, 2.5, 3]) {
      const r = shoulderRange(s);
      expect(r.frames, `swing=${s}`).toBeGreaterThan(50);
      expect(Math.abs(r.min), `swing=${s}: минимум`).toBeLessThanOrEqual(POSE.armSwingMax + 1e-9);
      expect(Math.abs(r.max), `swing=${s}: максимум`).toBeLessThanOrEqual(POSE.armSwingMax + 1e-9);
    }
  });

  it('⭐ и НИКОГДА не заворачивается — даже если потолок выкрутить за π', () => {
    // Внутренняя страховка: сколько бы ни выставили в ручке, за пол-оборота не пускаем.
    POSE.armSwingMax = 10;
    const r = shoulderRange(3);
    expect(Math.abs(r.min), 'минимум по эту сторону π').toBeLessThan(Math.PI);
    expect(Math.abs(r.max), 'максимум по эту сторону π').toBeLessThan(Math.PI);
  });

  it('потолок реально достигается — иначе проверять было бы нечего', () => {
    const r = shoulderRange(3);
    expect(Math.max(Math.abs(r.min), Math.abs(r.max))).toBeCloseTo(POSE.armSwingMax, 6);
  });

  it('настроенные значения НЕ задеты: на рабочих амплитудах потолок не участвует', () => {
    // У воина в конфиге `armSwing` = 0.5. Ничьи настройки не должны сдвинуться ни на единицу.
    const r = shoulderRange(0.5);
    expect(Math.max(Math.abs(r.min), Math.abs(r.max)), 'далеко до потолка').toBeLessThan(POSE.armSwingMax - 0.3);
  });

  it('потолок настраивается — поднимаем ручку, растёт и размах', () => {
    POSE.armSwingMax = 0.6;
    const tight = shoulderRange(3);
    POSE.armSwingMax = 1.9;
    const wide = shoulderRange(3);
    expect(Math.abs(tight.min)).toBeCloseTo(0.6, 6);
    expect(Math.abs(wide.min)).toBeGreaterThan(Math.abs(tight.min));
  });
});
