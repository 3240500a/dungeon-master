import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { POSE, POSE_BASE } from './pose.js';
import { applyHipsTiltHold } from './poseRuntime.js';

/**
 * ⭐ КРЕН И НАКЛОН ТАЗА НЕ ДОЛЖНЫ ТАЩИТЬ ЗА СОБОЙ КОРПУС И НОГИ.
 *
 * Жалоба: «крен таза качает всё тело — хочу, чтобы гулял только таз, а корпус стоял вертикально
 * и жил своими настройками».
 *
 * ПРИЧИНА СТРУКТУРНАЯ: `Hips` — КОРНЕВАЯ кость, а `Spine` и оба бедра её ПРЯМЫЕ ДЕТИ
 * (`humanoid.ts`), поэтому любой поворот таза наследуется телом один в один.
 * ЗАМЕР в живом редакторе (крен 0.3 на бегу): грудь кренилась на те же **34.7°**, колено гуляло
 * на **9.07**. После компенсации — грудь **0.28°**, колено **1.40**.
 *
 * ⚠ ЧЕГО КОМПЕНСАЦИЯ НЕ УБИРАЕТ: крен физически поднимает одно бедро и опускает другое (замер:
 * суставы ходят на 2.73 при 0.3, теория `2·полутаз·sin 0.3 = 2.29`). Это и ЕСТЬ крен таза. Платой
 * за удержание ног становится чуть больший ход стопы по Y (замер: 4.28 → 5.58 на манекене);
 * опорную стопу переставляет заземление.
 */
describe('крен таза: корпус и ноги остаются на месте', () => {
  const saved: Record<string, number> = {};
  const set = (k: string, v: number): void => {
    const o = POSE as unknown as Record<string, number>;
    if (!(k in saved)) saved[k] = o[k]!;
    o[k] = v;
  };
  afterEach(() => {
    const o = POSE as unknown as Record<string, number>;
    for (const k in saved) o[k] = saved[k]!;
    for (const k in saved) delete saved[k];
  });

  /** Манекен с ЗАДАННЫМ креном таза; вернуть мировой крен кости в градусах. */
  function tilt(roll: number, pitch: number, bone: string): number {
    const h = buildHumanoid({ style: 'skeleton' });
    h.reset();
    h.bones.get('Hips')!.rotation.z = roll;
    h.bones.get('Hips')!.rotation.x = pitch;
    applyHipsTiltHold(h, roll, pitch);
    h.root.updateMatrixWorld(true);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(h.bones.get(bone)!.getWorldQuaternion(new THREE.Quaternion()));
    return Math.atan2(-up.x, up.y) * 180 / Math.PI;
  }

  it('умолчание — держим и корпус, и ноги (но сам крен по умолчанию 0, поэтому это нейтрально)', () => {
    expect(POSE_BASE.hipsTiltHoldBody).toBe(1);
    expect(POSE_BASE.hipsTiltHoldLegs).toBe(1);
  });

  it('⭐ КОРПУС остаётся вертикальным при крене таза', () => {
    set('hipsTiltHoldBody', 1); set('hipsTiltHoldLegs', 1);
    expect(Math.abs(tilt(0.3, 0, 'Spine')), '⚠ корпус снова кренится вместе с тазом').toBeLessThan(0.5);
  });

  it('⭐ НОГИ держат своё направление', () => {
    set('hipsTiltHoldBody', 1); set('hipsTiltHoldLegs', 1);
    expect(Math.abs(tilt(0.3, 0, 'LeftUpperLeg')), '⚠ ноги снова гуляют за тазом').toBeLessThan(0.5);
    expect(Math.abs(tilt(0.3, 0, 'RightUpperLeg')), '⚠ ноги снова гуляют за тазом').toBeLessThan(0.5);
  });

  it('держим 0 → прежнее поведение: наследуют целиком', () => {
    set('hipsTiltHoldBody', 0); set('hipsTiltHoldLegs', 0);
    const deg = 0.3 * 180 / Math.PI;
    expect(Math.abs(tilt(0.3, 0, 'Spine'))).toBeCloseTo(deg, 1);
    expect(Math.abs(tilt(0.3, 0, 'LeftUpperLeg'))).toBeCloseTo(deg, 1);
  });

  it('ручки независимы: можно держать корпус, отпустив ноги', () => {
    set('hipsTiltHoldBody', 1); set('hipsTiltHoldLegs', 0);
    expect(Math.abs(tilt(0.3, 0, 'Spine')), '⚠ корпус не удержан').toBeLessThan(0.5);
    expect(Math.abs(tilt(0.3, 0, 'LeftUpperLeg')), '⚠ ноги удержались, хотя их отпустили').toBeGreaterThan(10);
  });

  it('НАКЛОН таза компенсируется тем же швом, что и крен', () => {
    set('hipsTiltHoldBody', 1);
    const h = buildHumanoid({ style: 'skeleton' });
    h.reset();
    h.bones.get('Hips')!.rotation.x = 0.3;
    applyHipsTiltHold(h, 0, 0.3);
    h.root.updateMatrixWorld(true);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(h.bones.get('Spine')!.getWorldQuaternion(new THREE.Quaternion()));
    expect(Math.abs(Math.atan2(up.z, up.y) * 180 / Math.PI), '⚠ наклон таза по-прежнему клонит корпус').toBeLessThan(0.5);
  });

  it('нулевой крен — функция не трогает НИ ОДНУ кость (поведение бит в бит прежнее)', () => {
    const h = buildHumanoid({ style: 'skeleton' });
    h.reset();
    const names = ['Spine', 'LeftUpperLeg', 'RightUpperLeg'];
    const before = names.map((n) => h.bones.get(n)!.rotation.clone());
    applyHipsTiltHold(h, 0, 0);
    names.forEach((n, i) => {
      const r = h.bones.get(n)!.rotation;
      expect(r.x).toBe(before[i]!.x); expect(r.z).toBe(before[i]!.z);
    });
  });
});
