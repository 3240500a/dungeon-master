/**
 * ⭐⭐ ДВИЖЕНИЕ ЖИВОЙ СТОЙКИ ИГРАЕТ БЕЗ РУЧКИ `GAIT.stancePelvis` (06.10).
 *
 * Жалоба владельца (Unity): «при идле ноги опять плавают, когда он чуть шевелится стоя на месте — мы это уже правили». Правили
 * 28.09 ДАННЫМИ: ручка таза стойки 1 в рабочей копии редактора. У опубликованного тюна она 0, а Unity читает только
 * опубликованное — и снова «таз стоит, стопы плавают». Теперь ручка решает только СТАТИКУ стойки (таз её нулевого кадра), а
 * ДВИЖЕНИЕ живой стойки — жёсткая дельта `S₀⁻¹·S(t)` — ложится всегда (`PosePlayer.applyStancePelvis`).
 *
 * Что стережётся:
 *  1. ручка 0 и живая стойка: таз ходит, и стопы ведут себя так же, как при ручке 1 (путь стоп совпадает до 1e-9 — тело отличается
 *     только постоянным поворотом статики);
 *  2. однокадровая стойка при ручке 0 — таз не тронут бит в бит (прежнее правило, его вид у опубликованных стоек не меняется);
 *  3. перекрытие запекания (`setStancePelvisOverride(0)`) гасит и движение — в клип таз стойки не печётся;
 *  4. кроссфейд боя между ДВУМЯ однокадровыми стойками при ручке 0 не рождает «движения»: опора дельты едет с боевой осью;
 *  5. вертикаль дыхания доезжает: таз по высоте ходит на `d(t).y − d₀.y` (её прежде срезала высота стоя на нулевом кадре).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { emptyGrid, setStancePelvisOverride, type PoseContent, type UpperPose } from './poseRuntime.js';
import { makeStand } from './parityHarness.js';
import { GAIT, GAIT_BASE } from './gaitKnobs.js';
import type { Pose } from './clipModel.js';

afterEach(() => { Object.assign(GAIT, GAIT_BASE); setStancePelvisOverride(null); });

/** Живая стойка: таз качается (наклон, рыск, крен) и ходит по полу и по высоте, ноги стоят «по-авторски». */
const livePose = (t: number): Pose => ({
  Hips: [0.04 + 0.05 * Math.sin(t), 0.1 + 0.12 * Math.sin(0.7 * t), -0.03 + 0.04 * Math.cos(t)],
  __hipsD: [-0.8 + 1.5 * Math.sin(t), -1.0 + 0.3 * Math.sin(1.3 * t), 0.4 + 0.9 * Math.cos(0.8 * t)],
  LeftUpperLeg: [0.02 - 0.05 * Math.sin(t), 0, 0.05], RightUpperLeg: [0.02 + 0.04 * Math.sin(t), 0, -0.05],
  LeftLowerLeg: [0.03, 0, 0], RightLowerLeg: [0.03, 0, 0],
  LeftFoot: [-0.05, 0.1, 0], RightFoot: [-0.05, -0.1, 0],
  Spine: [0, 0, 0], Chest: [0.03 * Math.sin(t), 0, 0],
});
const staticPose = (pitch: number, dx: number): Pose => ({ ...livePose(0), Hips: [pitch, 0.1, -0.03], __hipsD: [dx, -1.0, 0.4] });
const content = (fn: (t: number, combat: number) => Pose): PoseContent => ({
  charId: 'warrior',
  resolveUpper: (_w: string, c = 0, t = 0): UpperPose => ({ swing: 0, pose: fn(t, c) }),
} as unknown as PoseContent);

interface Run { hips: THREE.Vector3[]; hq: THREE.Quaternion[]; feet: THREE.Vector3[][] }
function run(c: PoseContent, knob: number, frames = 360, opts: { combatAt?: number } = {}): Run {
  GAIT.stancePelvis = knob;
  const st = makeStand({ content: c, grid: emptyGrid(), mix: 1 });
  const out: Run = { hips: [], hq: [], feet: [] };
  const fr = st.run({ warm: 30, frames, at: (p, i) => { if (opts.combatAt !== undefined && i === opts.combatAt) p.setCombat(true); } });
  st.human.root.updateMatrixWorld(true);
  for (const f of fr) out.feet.push([f.foot[0].clone(), f.foot[1].clone()]);
  // таз последнего кадра и по кадрам — второй прогон теми же входами (кадр стенда несёт только стопы и высоту)
  st.dispose();
  GAIT.stancePelvis = knob;
  const s2 = makeStand({ content: c, grid: emptyGrid(), mix: 1 });
  s2.run({ warm: 30, frames: 0 });
  for (let i = 0; i < frames; i++) {
    if (opts.combatAt !== undefined && i === opts.combatAt) s2.player.setCombat(true);
    s2.player.step(1 / 60);
    const hb = s2.human.bones.get('Hips')!;
    out.hips.push(hb.position.clone()); out.hq.push(hb.quaternion.clone());
  }
  s2.dispose();
  return out;
}
const pathOf = (r: Run, k: 0 | 1): number => { let s = 0; for (let i = 1; i < r.feet.length; i++) s += r.feet[i]![k]!.distanceTo(r.feet[i - 1]![k]!); return s; };
const spanOf = (vs: THREE.Vector3[], ax: 'x' | 'y' | 'z'): number => Math.max(...vs.map((v) => v[ax])) - Math.min(...vs.map((v) => v[ax]));

describe('движение живой стойки — без ручки таза стойки', () => {
  it('⭐⭐ РУЧКА 0: таз живой стойки ходит, и стопы ведут себя как при ручке 1 (прежде — «таз стоит, стопы плавают»)', () => {
    const c = content((t) => livePose(t));
    const k0 = run(c, 0), k1 = run(c, 1);
    expect(spanOf(k0.hips, 'x'), 'таз по X при ручке 0 обязан ходить').toBeGreaterThan(1.5);
    for (const k of [0, 1] as const) {
      expect(Math.abs(pathOf(k0, k) - pathOf(k1, k)), `стопа ${k}: путь при ручке 0 ≠ при ручке 1`).toBeLessThan(1e-6);
    }
    // а уход каждой стопы от её начала — тот же по модулю (тело отличается постоянным поворотом статики)
    for (const k of [0, 1] as const) for (let i = 0; i < k0.feet.length; i += 37) {
      const d0 = k0.feet[i]![k]!.distanceTo(k0.feet[0]![k]!), d1 = k1.feet[i]![k]!.distanceTo(k1.feet[0]![k]!);
      expect(Math.abs(d0 - d1), `стопа ${k}, кадр ${i}`).toBeLessThan(1e-6);
    }
  });

  it('⚠ ОДНОКАДРОВАЯ стойка при ручке 0 — таз не тронут (прежнее правило бит в бит)', () => {
    const r = run(content(() => staticPose(0.06, -1.0)), 0, 120);
    for (const p of r.hips) { expect(p.x).toBe(0); expect(p.z).toBe(0); }
    expect(spanOf(r.hips, 'y'), 'высота стоя постоянна').toBe(0);
  });

  it('⚠ ПЕРЕКРЫТИЕ ЗАПЕКАНИЯ (0) гасит и движение: таз живой стойки в клип не печётся', () => {
    setStancePelvisOverride(0);
    const r = run(content((t) => livePose(t)), 1, 120);
    for (const p of r.hips) { expect(p.x).toBe(0); expect(p.z).toBe(0); }
  });

  it('⭐ КРОССФЕЙД БОЯ между двумя однокадровыми стойками при ручке 0 не рождает «движения»', () => {
    // кроссфейд длинный (2 с): шаг оси за кадр 0.008 — меньше порога пере-замера высоты стоя (0.02), опору ведёт `step` сам
    GAIT.combatBlend = 2;
    const c = content((_t, combat) => staticPose(0.06 + 0.2 * combat, -1.0 + 2.5 * combat));
    const r = run(c, 0, 90, { combatAt: 10 });
    for (const p of r.hips) { expect(Math.abs(p.x)).toBeLessThan(1e-12); expect(Math.abs(p.z)).toBeLessThan(1e-12); }
  });

  it('⭐ ВЕРТИКАЛЬ ДЫХАНИЯ доезжает: таз по высоте ходит, сколько ходит `__hipsD.y` стойки', () => {
    const c = content((t) => ({ ...livePose(0), Hips: [0, 0, 0], __hipsD: [0, -1.0 + 0.3 * Math.sin(1.3 * t), 0] }));
    const r = run(c, 0, 360);
    expect(spanOf(r.hips, 'y'), 'размах высоты таза ≈ размах `__hipsD.y` (0.6)').toBeGreaterThan(0.55);
    expect(spanOf(r.hips, 'y')).toBeLessThan(0.61);
  });
});
