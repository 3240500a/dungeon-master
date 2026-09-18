import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride, type PoseContent } from './poseRuntime.js';
import { bakeGaitToClip, GAIT_PRESETS } from './clipBake.js';
import { clipPoseAt, type Clip, type Pose } from './clipModel.js';
import { makeStand, arcDeg, jumpDeg, poseErrorDeg, footDrift, meanPose, quantile, GROUPS, HARNESS_GX, DEG } from './parityHarness.js';

/**
 * СТОРОЖА САМОГО СТЕНДА ЗАМЕРОВ.
 *
 * ⚠ Здесь НЕ проверяется, «правильно ли ведёт себя анимация» — здесь проверяется, что МЕРКА не врёт. Иначе получится
 * худшее из возможного: неверная мерка, которой верят, потому что «она же под тестом». Каждая мерка проверяется на
 * входе с ЗАРАНЕЕ ИЗВЕСТНЫМ ответом (неподвижная поза → размах 0, клип против самого себя → расхождение 0, заданное
 * скольжение → ровно оно).
 *
 * Плюс печатается базовая таблица «клип / игра по оружию» — числа, от которых отсчитываются следующие этапы.
 */
const STANCE: Pose = {
  LeftUpperArm: [0.3, 0.1, -0.6], RightUpperArm: [0.25, -0.1, 0.7], LeftLowerArm: [0, -0.9, 0], RightLowerArm: [0, 1.1, 0],
  LeftShoulder: [0.05, 0, -0.1], RightShoulder: [0.05, 0, 0.12], LeftHand: [0.2, 0.1, 0.3], RightHand: [-0.3, 0.2, -0.25],
  Chest: [0.1, 0.05, 0], UpperChest: [0.08, -0.04, 0.02], Neck: [0.12, 0.1, 0], Head: [-0.1, 0.15, 0.05],
};
const R = 120;
let lib: Map<string, Clip>;

beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
  } as Storage;
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', HARNESS_GX, emptyGrid());
  lib = new Map();
  for (const s of GAIT_PRESETS) lib.set(s.name, bakeGaitToClip(p, h, s, { character: 'warrior', weapon: 'none' }).clip);
});
afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
afterEach(() => { setLocoMixOverride(null); });

/** Контент стенда: набор хода + авторская стойка с легаси-долей маха (`swing`). */
const content = (swing: number | null): PoseContent => ({
  ...localStorageContent('warrior'),
  locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; },
  ...(swing === null ? {} : { resolveUpper: () => ({ swing, pose: STANCE }) }),
});

describe('стенд замеров: мерки не врут', () => {
  it('⭐ РАЗМАХ: у неподвижной позы ноль, у клипа — его собственный, и обе величины не зависят от длины прогона', () => {
    const still = makeStand({ content: content(null) });
    const a = still.run({ vz: 0, warm: 60, frames: 120 });
    still.dispose();
    expect(arcDeg(a, 'RightUpperArm'), 'стоя рука не машет — мерка обязана дать ноль').toBeLessThan(0.01);

    const go = makeStand({ content: content(null) });
    const b1 = go.run({ vz: R, warm: 240, frames: 90 });
    const b2 = go.run({ vz: R, warm: 0, frames: 180 });
    go.dispose();
    // Полный цикл укладывается и в 90 кадров, и в 180 — размах один и тот же (это НЕ сумма по кадрам).
    expect(arcDeg(b2, 'RightUpperArm')).toBeGreaterThan(20);
    expect(arcDeg(b1, 'RightUpperArm')).toBeCloseTo(arcDeg(b2, 'RightUpperArm'), 0);
  });

  it('⭐⭐ РАСХОЖДЕНИЕ С ЭТАЛОНОМ: клип против самого себя — НОЛЬ; сдвиг фазы мерка видит', () => {
    const st = makeStand({ content: content(null) });   // стойки нет → верх ведёт клип целиком
    const fr = st.run({ vz: R, warm: 240, frames: 120 });
    st.dispose();
    const clip = lib.get('run_fwd')!;
    const err = poseErrorDeg(fr, clip, GROUPS['руки']!);
    expect(err.max, '⚠ мерка паритета врёт: без стойки руки ОБЯЗАНЫ совпадать с клипом').toBeLessThan(0.01);
    // …и она действительно чувствительна: сдвинем эталон на четверть цикла — расхождение обязано вылезти.
    const shifted: typeof fr = fr.map((f) => ({ ...f, u: (f.u + 0.25) % 1 }));
    expect(poseErrorDeg(shifted, clip, GROUPS['руки']!).max, 'сдвиг фазы мерка не заметила — она пустая').toBeGreaterThan(20);
  });

  it('УХОД ОПОРНОЙ СТОПЫ: берётся ХУДШИЙ отрезок опоры, а не среднее по прогону', () => {
    // Синтетический вход с известным ответом: одна нога «опорная» и уезжает на 5 ед, потом отрыв и новая опора на 1 ед.
    const mk = (x: number, sup: boolean): Parameters<typeof footDrift>[0][number] => ({
      local: new Map(), dir: new Map(), hipsY: 0, u: 0,
      foot: [new THREE.Vector3(x, 0, 0), new THREE.Vector3(0, 0, 0)], support: [sup, false],
    });
    expect(footDrift([mk(0, true), mk(2, true), mk(5, true), mk(9, false), mk(100, true), mk(101, true)])).toBeCloseTo(5, 6);
    expect(footDrift([mk(0, false), mk(50, false)]), 'нет опоры — нет ухода').toBe(0);
  });

  it('СКАЧОК ЗА КАДР и КВАНТИЛЬ: единичный выброс виден в максимуме и НЕ виден в p50', () => {
    const q = (a: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
    const fr = [0, 0, 0, 1.0, 1.0, 1.0].map((a) => ({
      local: new Map([['Hips', q(a)]]), dir: new Map(), hipsY: 0, u: 0,
      foot: [new THREE.Vector3(), new THREE.Vector3()] as [THREE.Vector3, THREE.Vector3], support: [true, true] as [boolean, boolean],
    }));
    expect(jumpDeg(fr, ['Hips'])).toBeCloseTo(1.0 * DEG, 4);
    expect(quantile([1, 1, 1, 1, 50], 0.5)).toBe(1);
    expect(quantile([1, 1, 1, 1, 50], 1)).toBe(50);
  });

  it('СРЕДНЯЯ ПОЗА: у постоянного входа — он сам; знак кватерниона сведён (иначе среднее уезжает в ноль)', () => {
    const one: Pose = { RightUpperArm: [0.25, -0.1, 0.7] };
    const m = meanPose([one, one, one], ['RightUpperArm']);
    for (let i = 0; i < 3; i++) expect(m['RightUpperArm']![i]).toBeCloseTo(one['RightUpperArm']![i]!, 9);
    // Поворот на ±170° вокруг Y: у кватернионов противоположные знаки. Среднее обязано лежать МЕЖДУ ними (у ±180°),
    // а не схлопнуться в тождество — это классическая грабля покомпонентного усреднения.
    const a: Pose = { Hips: [0, 170 / DEG, 0] }, b: Pose = { Hips: [0, -170 / DEG, 0] };
    const mid = meanPose([a, b], ['Hips'])['Hips']!;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(mid[0], mid[1], mid[2], 'XYZ'));
    expect(q.angleTo(new THREE.Quaternion()) * DEG, '⚠ среднее схлопнулось в ноль — знак не сведён').toBeGreaterThan(170);
  });

  it('стенд гоняет НАСТОЯЩУЮ игровую связку: режим «только клипы», состояние между прогонами сохраняется', () => {
    const st = makeStand({ content: content(null) });
    const a = st.run({ vz: R, warm: 240, frames: 2 });
    const b = st.run({ vz: R, warm: 0, frames: 2 });   // продолжение, а не новый разгон
    st.dispose();
    expect(a[0]!.u).not.toBeCloseTo(b[0]!.u, 3);
    expect(footDrift(a), 'в «только клипы» опорная стопа не скользит').toBeLessThan(0.5);
  });
});

describe('стенд: базовая таблица (числа, от которых отсчитываются этапы)', () => {
  it('клип против игры по оружию — печать', () => {
    const clip = lib.get('run_fwd')!;
    const clipArc = (bone: string): number => {
      const v: THREE.Vector3[] = [];
      for (let i = 0; i < 60; i++) {
        const h = buildHumanoid({}); const p = clipPoseAt(clip, i / 60);
        for (const nm in p) { const b = h.bones.get(nm); const e = p[nm]!; if (b) b.rotation.set(e[0], e[1], e[2]); }
        h.root.updateMatrixWorld(true);
        v.push(new THREE.Vector3(1, 0, 0).applyQuaternion(h.bones.get(bone)!.getWorldQuaternion(new THREE.Quaternion())));
      }
      let m = 0; for (const x of v) for (const y of v) m = Math.max(m, x.angleTo(y));
      return m * DEG;
    };
    const rows = ['источник                    плечо Л   плечо П   локоть П   руки↔клип'];
    rows.push(`клип run_fwd (потолок)      ${clipArc('LeftUpperArm').toFixed(1).padStart(7)}°  ${clipArc('RightUpperArm').toFixed(1).padStart(7)}°  ${clipArc('RightLowerArm').toFixed(1).padStart(7)}°          —`);
    for (const [label, swing] of [['стойки нет', null], ['стойка, доля 1.0', 1], ['стойка, доля 0.5 (=none)', 0.5], ['стойка, доля 0.2 (=меч)', 0.2]] as const) {
      const st = makeStand({ content: content(swing) });
      const fr = st.run({ vz: R, warm: 240, frames: 120 });
      st.dispose();
      const e = poseErrorDeg(fr, clip, GROUPS['руки']!);
      rows.push(`${label.padEnd(26)}${arcDeg(fr, 'LeftUpperArm').toFixed(1).padStart(7)}°  ${arcDeg(fr, 'RightUpperArm').toFixed(1).padStart(7)}°  ${arcDeg(fr, 'RightLowerArm').toFixed(1).padStart(7)}°  ${e.mean.toFixed(2).padStart(7)}°`);
    }
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n') + '\n');
    // ⭐ ЕДИНСТВЕННЫЙ АССЕРТ ЗДЕСЬ — ИНВАРИАНТ, КОТОРЫЙ ОБЯЗАН ПЕРЕЖИТЬ ЛЮБУЮ ПРАВКУ ШВА: при полном весе хода
    // верх идёт РОВНО клипом. Сами величины обвала под мечом здесь только печатаются: они меняются вместе со швом,
    // и держать их ассертом тут значило бы переписывать сторож СТЕНДА вместо сторожа поведения.
    const full = makeStand({ content: content(1) });
    const err = poseErrorDeg(full.run({ vz: R, warm: 240, frames: 120 }), clip, GROUPS['руки']!);
    full.dispose();
    expect(err.max, '⚠ при полном весе хода руки обязаны быть клипом бит в бит').toBeLessThan(0.01);
  }, 300000);
});
