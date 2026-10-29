import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { GAIT, GAIT_BASE } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';
import { buildHumanoid } from './humanoid.js';
import { legGroundIK } from './footIk.js';

/**
 * ⭐ СТОПА НЕ ДОЛЖНА ПРИКОЛАЧИВАТЬСЯ К ПОЛУ ЗА ОДИН КАДР.
 *
 * Жалоба: «ступня к полу резко приколачивается, можно сделать плавно или ползунок отдельный».
 *
 * ПРИЧИН БЫЛО ДВЕ, и обе мгновенные:
 * 1. ПОЗА: голеностоп держал подошву ровно ТОЛЬКО в переносе (`if (l.sw > 0)`), а на границе
 *    переключался за кадр. ЗАМЕР на бегу: наклон подошвы 0.19° → 12.93° на КАСАНИИ и, что важнее,
 *    ХУДШИЙ скачок **23.39°** — на ОТРЫВЕ (`ank` 0 → −0.45 за кадр, наклон −29.98° → −6.6°).
 * 2. ЗАЗЕМЛЕНИЕ: `legGroundIK` клало стопу плашмя на 100 % в тот же кадр, без веса.
 *
 * ⚠ ПЕРВАЯ ВЕРСИЯ РАМПЫ БЫЛА ТОЛЬКО НА ВХОД — и почти ничего не дала (23.39 → 23.35), потому что
 * рвалось на ВЫХОДЕ. Рампа обязана быть СИММЕТРИЧНОЙ: стопа ложится после касания и отпускается
 * до отрыва — это и есть перекат «пятка → плашмя → носок».
 *
 * ЗАМЕР ПОСЛЕ (скачок наклона за кадр): 0 → 23.39°, 0.15 → 14.45°, 0.30 → 6.38°, 0.45 → **3.76°**.
 */
describe('мягкость постановки стопы', () => {
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

  /** Прогон бега: худший скачок угла голеностопа за кадр + все веса постановки. */
  function run(frames = 300): { jump: number; weights: number[] } {
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0, prev = 0, jump = 0;
    const weights: number[] = [];
    for (let i = 0; i < frames + 150; i++) {
      z += 90 / 60;
      d.setWorld(0, z, 0, 0, 90);
      d.update(1 / 60);
      if (i >= 150) {
        jump = Math.max(jump, Math.abs(d.out.ankL - prev));
        weights.push(d.plantWeights[0]);
      }
      prev = d.out.ankL;
    }
    return { jump, weights };
  }

  it('умолчание 0 — мгновенно, как было (веса постановки все ровно 1)', () => {
    expect(GAIT_BASE.footPlant).toBe(0);
    expect(GAIT_BASE.footPlantRun).toBe(0);
    const { weights } = run();
    expect(weights.every((w) => w === 1), '⚠ при нулевой ручке вес постановки обязан быть ровно 1').toBe(true);
  });

  it('⭐ голеностоп ОТПУСКАЕТ подошву постепенно, а не за кадр', () => {
    // ⚠ МЕРИМ ИМЕННО ЭТО, а не «скачок за кадр»: в node-прогоне нет `setFeet` (обратной связи
    // от физики), поэтому на приземлении плант прыгает в (0,0) и сам даёт ступеньку — артефакт харнесса,
    // не продукта. В ЖИВОМ РЕДАКТОРЕ, где `setFeet` есть, ручка дала скачок наклона
    // 23.39° → 14.45° → 6.38° → 3.76° при footPlant 0 / 0.15 / 0.30 / 0.45.
    const firstSupport = (v: number): number[] => {
      set('footPlant', v); set('footPlantRun', v);
      const d = new PoseDriver(); d.setMove(1);
      let z = 0, wasSwing = false;
      const out: number[] = [];
      for (let i = 0; i < 600; i++) {
        z += 90 / 60; d.setWorld(0, z, 0, 0, 90); d.update(1 / 60);
        const sw = d.swingLegs[0];
        if (i > 150 && wasSwing && !sw) out.length = 0;          // кадр касания — начинаем запись
        if (i > 150 && !sw && out.length < 8) out.push(Math.abs(d.out.ankL));
        wasSwing = sw;
      }
      return out;
    };
    const hard = firstSupport(0), soft = firstSupport(0.4);
    expect(Math.max(...hard), '⚠ при нуле голеностоп обязан отпускать подошву СРАЗУ (прежнее поведение)').toBeLessThan(1e-9);
    expect(Math.max(...soft), '⚠ ручка не действует: удержания после касания нет').toBeGreaterThan(0.05);
    expect(soft[soft.length - 1]!, '⚠ удержание не затухает — стопа так и не ляжет').toBeLessThan(soft[0]!);
  });

  it('⭐ рампа СИММЕТРИЧНА: внутри ОДНОЙ опоры вес растёт И СПАДАЕТ', () => {
    // ⚠ ПЕРВАЯ ВЕРСИЯ РАМПИЛА ТОЛЬКО ВХОД — и почти ничего не дала (23.39 → 23.35),
    // потому что худший скачок — НА ОТРЫВЕ. Проверяем именно траекторию ВНУТРИ опоры:
    // только так видно, что стопа ещё и ОТПУСКАЕТСЯ перед отрывом (перекат пятка→носок).
    set('footPlant', 0.4); set('footPlantRun', 0.4);
    const d = new PoseDriver(); d.setMove(1);
    let z = 0, wasSwing = false;
    const phase: number[] = [];
    for (let i = 0; i < 600 && phase.length < 400; i++) {
      z += 90 / 60; d.setWorld(0, z, 0, 0, 90); d.update(1 / 60);
      const sw = d.swingLegs[0];
      if (i > 150 && wasSwing && !sw) phase.length = 0;        // новая опора — начинаем заново
      if (i > 150 && !sw) phase.push(d.plantWeights[0]);
      if (i > 150 && !wasSwing && sw && phase.length > 4) break;   // отрыв — фаза собрана
      wasSwing = sw;
    }
    expect(phase.length, '⚠ не удалось собрать опорную фазу').toBeGreaterThan(5);
    const peak = Math.max(...phase);
    expect(peak, '⚠ вес нигде не доходит до максимума — стопа не ложится').toBeGreaterThan(0.5);
    expect(phase[0]!, '⚠ на касании вес обязан быть малым').toBeLessThan(peak * 0.5);
    expect(phase[phase.length - 1]!, '⚠ К ОТРЫВУ ВЕС НЕ СПАДАЕТ — рампа снова только на вход').toBeLessThan(peak * 0.5);
  });

  it('⚠ потолок 0.45: выше вход и выход перекрылись бы и стопа не легла бы вовсе', () => {
    set('footPlant', 5); set('footPlantRun', 5);   // заведомо больше потолка
    const { weights } = run();
    expect(Math.max(...weights), '⚠ кламп потолка снят — стопа перестанет ложиться на пол').toBeGreaterThan(0.9);
  });

  it('⭐ ЗАЗЕМЛЕНИЕ: вес укладки оставляет стопе часть авторского наклона', () => {
    const mk = (flat: number): THREE.Quaternion => {
      const h = buildHumanoid({ style: 'skeleton' });
      h.reset();
      const fb = h.bones.get('LeftFoot')!;
      fb.rotation.set(0.4, 0, 0);                    // заметный авторский наклон стопы
      h.root.updateMatrixWorld(true);
      const tgt = fb.getWorldPosition(new THREE.Vector3());
      legGroundIK(h.bones.get('LeftUpperLeg')!, h.bones.get('LeftLowerLeg')!, fb,
        tgt, new THREE.Vector3(0, 0, 1), new THREE.Quaternion(), undefined, flat);
      return fb.quaternion.clone();
    };
    const full = mk(1), none = mk(0), half = mk(0.5);
    const deg = (a: THREE.Quaternion, b: THREE.Quaternion): number =>
      2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180 / Math.PI;
    expect(deg(none, full), '⚠ вес укладки не действует — стопа всегда кладётся плашмя').toBeGreaterThan(5);
    expect(deg(half, full), '⚠ половинный вес совпал с полным').toBeGreaterThan(1);
    expect(deg(half, none), '⚠ половинный вес совпал с нулевым').toBeGreaterThan(1);
  });
});
