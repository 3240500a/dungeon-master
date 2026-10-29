import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';

// humanoidRagdoll тянет Jolt через ragdoll.ts (wasm + DOM) — для таблицы пределов он не нужен.
vi.mock('./ragdoll.js', () => ({ jolt: () => { throw new Error('jolt is not available in node'); } }));

import { limitViewForBone, type LimitView } from './humanoidRagdoll.js';
import { clampLocalToLimit, limitVersion } from './jointClamp.js';
import { forgetDrag } from './jointLimitV2.js';
import { dofSpec } from './jointDof.js';

/**
 * ПАМЯТЬ ПРОТЯЖКИ СУСТАВА НЕ ПЕРЕЖИВАЕТ ДРАГ (жалоба 17.09.2026: «правка стопы на одном кадре появилась на других
 * кадрах, повёрнутая на тот же угол»).
 *
 * `jointLimitV2` копит угол драга по кости (`twistMem`/`hingeMem`, ключ — САМА кость). Кость у манекена одна на все
 * кадры и клипы, а `forgetDrag` не звал никто. Драг, упёршийся в предел, оставлял разрыв «кольцо ушло − кость встала»,
 * и первое же касание этой кости на ЛЮБОМ кадре доворачивало её на этот разрыв.
 *
 * Драг смоделирован как в `pose-editor.ts` (v2, родитель — единица): кольцо твиста крутит кость вокруг её ТЕКУЩЕЙ оси,
 * `newLocal = q0 · R(ось твиста, θ)`, каждое событие мыши — клэмп с ключом-костью.
 */
const D = Math.PI / 180;
const twistAxis = (v: LimitView): THREE.Vector3 => dofSpec(v).axes[2]!.clone().normalize();
/** Протяжка кольца твиста от позы `q0` шагами `steps` (градусы, накопленный угол). Возвращает позу на отпускании. */
function dragTwist(q0: THREE.Quaternion, view: LimitView, key: object, steps: number[]): THREE.Quaternion {
  const ax = twistAxis(view);
  let q = q0.clone();
  for (const deg of steps) q = clampLocalToLimit(q0.clone().multiply(new THREE.Quaternion().setFromAxisAngle(ax, deg * D)), view, key);
  return q;
}
/** Шаги мыши по `step`° до `to` включительно (последний шаг — ровно `to`). */
const ramp = (to: number, step = 1): number[] => { const r: number[] = []; for (let d = step; d < to - 1e-9; d += step) r.push(d); r.push(to); return r; };

describe('накопитель протяжки сустава (jointLimitV2) между драгами', () => {
  const view = limitViewForBone('LeftFoot')!;
  const hi = (view.twistMax ?? 0) / D;
  // Кадр 6 — другая поза той же кости (стопа чуть согнута): у манекена это тот же объект-ключ.
  const frame6 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 12 * D);

  const OVER = 25;   // насколько кольцо протянули ЗА упор

  it('предусловия: v2 по умолчанию, у стопы предел твиста ±45°', () => {
    expect(limitVersion()).toBe(2);
    expect(view.kind).not.toBe('hinge');
    expect(hi).toBeCloseTo(45, 0);
  });

  it('⭐ БЕЗ forgetDrag касание 0.2° на другом кадре поворачивает кость на разрыв прошлого драга (так было)', () => {
    const bone = new THREE.Object3D();
    const end = dragTwist(new THREE.Quaternion(), view, bone, ramp(hi + OVER));   // кадр 1: протянули на 25° за упор
    expect(end.angleTo(new THREE.Quaternion()) / D).toBeCloseTo(hi, 0);            // кость встала на упор
    const touched = dragTwist(frame6, view, bone, [0.2]);                          // кадр 6: едва коснулись
    const jump = touched.angleTo(frame6) / D;
    // ровно «тот же угол»: 0.2° касания минус 25° разрыва — ЗАМЕР 24.8°
    expect(jump, `прыжок ${jump.toFixed(2)}° при касании 0.2°`).toBeCloseTo(OVER - 0.2, 1);
  });

  it('⭐ С forgetDrag на старте драга касание сдвигает кость ровно на касание', () => {
    const bone = new THREE.Object3D();
    dragTwist(new THREE.Quaternion(), view, bone, ramp(hi + OVER));
    forgetDrag(bone);                                                              // `beginProxyDrag`
    const touched = dragTwist(frame6, view, bone, [0.2]);
    expect(touched.angleTo(frame6) / D).toBeLessThanOrEqual(0.2 + 1e-6);
  });

  it('забытый накопитель ВНУТРИ драга по-прежнему держит упор (протяжка на 200° не выворачивает в зеркало)', () => {
    const bone = new THREE.Object3D();
    forgetDrag(bone);
    const ax = twistAxis(view);
    for (const deg of ramp(200, 5)) {
      const q = clampLocalToLimit(new THREE.Quaternion().setFromAxisAngle(ax, deg * D), view, bone);
      let signed = 2 * Math.atan2(q.x * ax.x + q.y * ax.y + q.z * ax.z, q.w) / D;
      signed = ((signed + 540) % 360) - 180;                                        // (−180, 180]
      expect(signed, `на ${deg}° твист ушёл на ${signed.toFixed(1)}°`).toBeCloseTo(Math.min(deg, hi), 3);   // держит упор, в −упор не перескакивает
    }
  });
});

/** Тело функции по фигурным скобкам — от `{` заголовка до парной `}`. */
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pose-editor.ts'), 'utf8');
function bodyOf(name: string): string {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{`).exec(SRC);
  expect(m, `функция ${name} должна существовать`).toBeTruthy();
  let i = m!.index + m![0].length, depth = 1;
  for (; i < SRC.length && depth > 0; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') depth--; }
  return SRC.slice(m!.index, i);
}

describe('pose-editor забывает накопитель протяжки', () => {
  it('на старте FK-драга — у той кости, которую тянут', () => {
    expect(bodyOf('beginProxyDrag')).toMatch(/forgetDrag\(b\)/);
  });
  it('при замене позы (applyPose / lerpPose → onPoseReplaced) и в captureRig — у всех костей', () => {
    expect(bodyOf('forgetDragAll')).toMatch(/for \(const nm of human\.boneNames\)[\s\S]*forgetDrag\(/);
    expect(bodyOf('onPoseReplaced')).toMatch(/forgetDragAll\(\)/);
    expect(bodyOf('applyPose')).toMatch(/onPoseReplaced\(\)/);
    expect(bodyOf('lerpPose')).toMatch(/onPoseReplaced\(\)/);
    expect(bodyOf('captureRig')).toMatch(/forgetDragAll\(\)/);
  });
});
