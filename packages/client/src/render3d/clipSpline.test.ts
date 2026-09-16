import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { clipPoseAt, clipSegmentAt, easeU, poseErrorDeg, type Clip, type Keyframe, type Pose } from './clipModel.js';
import { fitSmoothLoop, smoothLoopFrames } from './clipFit.js';
import { buildHumanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { bakeGaitToClip, GAIT_PRESETS, SMOOTH_EPS_DEG, SMOOTH_SIGMA_CYCLE } from './clipBake.js';
import { reduceKeyframes } from './clipBaker.js';
import { poseClipToAnimationClip } from './clipToAnimation.js';

/**
 * ⭐⭐ «34 КЛЮЧА НА БЕГ НАЗАД — МОЖНО В 2–3 РАЗА МЕНЬШЕ, И ЧТОБЫ МЕЖДУ НИМИ БЫЛ ПЛАВНЫЙ ПЕРЕХОД?»
 *
 * Два шва: `interp: 'smooth'` (сплайн через ключи, скорость на ключе без излома) и подгонка ключей к циклу
 * (`clipFit`). Стережём и то, и другое, и сам итог — ключей в разы меньше ломаной на всём наборе.
 */
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const ang = (a: readonly number[], b: readonly number[]): number => {
  _q1.setFromEuler(_e.set(a[0]!, a[1]!, a[2]!)); _q2.setFromEuler(_e.set(b[0]!, b[1]!, b[2]!));
  return _q1.angleTo(_q2) * 180 / Math.PI;
};
const clip = (keys: Keyframe[], loop: boolean): Clip => ({ name: 'c', character: 'w', weapon: 'none', loop, keys });
/** Цикл «нога»: плавный мах по X с перекосом по Z + боб таза. */
const legPose = (ph: number): Pose => ({
  LeftUpperLeg: [0.7 * Math.sin(ph), 0, 0.15 * Math.sin(2 * ph)],
  RightUpperLeg: [-0.7 * Math.sin(ph), 0.1, 0],
  __hipsD: [0, 0.8 * Math.cos(2 * ph), 0],
  __match: [0.3 + 0.2 * Math.sin(ph), 0, 0],
});

describe('сплайн между ключами', () => {
  const T = [0, 0.2, 0.45, 0.6, 0.8, 1];
  const keysOf = (interp: Keyframe['interp']): Keyframe[] => T.map((t, i) => ({ t, pose: legPose(t * 2 * Math.PI), ...(i < T.length - 1 && interp ? { interp } : {}) }));

  it('⭐ ПРОХОДИТ ЧЕРЕЗ КЛЮЧИ — ключ на тайм-лайне значит ровно то, что в нём записано', () => {
    for (const loop of [true, false]) {
      const c = clip(keysOf('smooth'), loop);
      for (const k of c.keys) {
        const p = clipPoseAt(c, k.t);
        for (const b of ['LeftUpperLeg', 'RightUpperLeg']) expect(ang(p[b]!, k.pose[b]!), `цикл ${loop}, ${b} на ${k.t}`).toBeLessThan(1e-3);
        expect(Math.abs(p['__hipsD']![1] - k.pose['__hipsD']![1])).toBeLessThan(1e-9);
      }
    }
  });

  it('⭐⭐ СКОРОСТЬ НА КЛЮЧЕ БЕЗ ИЗЛОМА (у ломаной — излом), и на шве цикла тоже', () => {
    // ⚠ Мутация «касательная ноль (ease-in-out на каждом ключе)» и «касательная без соседа через шов» валят это.
    const vel = (c: Clip, t: number, side: -1 | 1): number => {
      const h = 1e-4, a = clipPoseAt(c, Math.min(1, Math.max(0, t + (side > 0 ? 0 : -h)))), b = clipPoseAt(c, Math.min(1, Math.max(0, t + (side > 0 ? h : 0))));
      return (b['LeftUpperLeg']![0] - a['LeftUpperLeg']![0]) / h;
    };
    const smooth = clip(keysOf('smooth'), true), linear = clip(keysOf(undefined), true);
    for (const t of [0.2, 0.45, 0.6, 0.8]) {
      const l = vel(smooth, t, -1), r = vel(smooth, t, 1);
      expect(Math.abs(l - r) / Math.max(1e-6, Math.abs(l) + Math.abs(r)), `сплайн на ключе ${t}: ${l.toFixed(3)} слева, ${r.toFixed(3)} справа`).toBeLessThan(0.01);
    }
    const lj = Math.abs(vel(linear, 0.45, -1) - vel(linear, 0.45, 1));
    expect(lj, 'у ломаной на ключе излом скорости есть — иначе проверка выше была бы пустой').toBeGreaterThan(0.5);
    // ⚠ Непрерывность можно подделать НУЛЁМ скорости на каждом ключе (ease-in-out): слева и справа будет одинаковый
    // ноль. Поэтому форма между ключами сверяется с настоящей кривой — у «замирающего на ключах» сплайна она уходит.
    // ЗАМЕР на 9 ключах: сплайн 0.97°, ломаная 3.33°, сплайн с односторонней касательной 2.31°.
    const even = (interp: Keyframe['interp']): Clip => clip(Array.from({ length: 9 }, (_, i) => ({ t: i / 8, pose: legPose((i / 8) * 2 * Math.PI), ...(i < 8 && interp ? { interp } : {}) })), true);
    let worst = 0, worstLin = 0;
    for (let u = 0; u <= 1; u += 0.01) {
      const truth = legPose(u * 2 * Math.PI)['LeftUpperLeg']!;
      worst = Math.max(worst, ang(clipPoseAt(even('smooth'), u)['LeftUpperLeg']!, truth));
      worstLin = Math.max(worstLin, ang(clipPoseAt(even(undefined), u)['LeftUpperLeg']!, truth));
    }
    expect(worst, `сплайн отходит от кривой на ${worst.toFixed(2)}° (ломаная — на ${worstLin.toFixed(2)}°)`).toBeLessThan(worstLin / 2.5);
    // Шов: скорость в конце цикла = скорость в начале.
    const end = vel(smooth, 1, -1), start = vel(smooth, 0, 1);
    expect(Math.abs(end - start) / (Math.abs(end) + Math.abs(start)), `шов: ${end.toFixed(3)} против ${start.toFixed(3)}`).toBeLessThan(0.01);
  });

  it('⚠ КРАТЧАЙШАЯ ДУГА: соседние ключи с кватернионами разного знака не проворачивают кость', () => {
    // X = ±π — одна и та же поза с противоположным знаком кватерниона после перевода из Эйлера.
    const c = clip([
      { t: 0, pose: { Spine: [3.1, 0, 0] }, interp: 'smooth' }, { t: 0.33, pose: { Spine: [-3.1, 0, 0] }, interp: 'smooth' },
      { t: 0.66, pose: { Spine: [3.05, 0.05, 0] }, interp: 'smooth' }, { t: 1, pose: { Spine: [-3.12, 0, 0] } },
    ], false);
    let prev = clipPoseAt(c, 0)['Spine']!, worst = 0;
    for (let u = 0.01; u <= 1; u += 0.01) { const p = clipPoseAt(c, u)['Spine']!; worst = Math.max(worst, ang(prev, p)); prev = p; }
    expect(worst, '⚠ поворот между соседними пробами — кость крутится длинной дугой').toBeLessThan(2);
  });

  it('⚠ ВЕСА И ФЛАГИ НЕ ПЕРЕЛЕТАЮТ: прочие скаляры у сплайна линейны', () => {
    const c = clip([
      { t: 0, pose: { __swing: [0, 0, 0], __hipsD: [0, 0, 0] }, interp: 'smooth' }, { t: 0.3, pose: { __swing: [1, 0, 0], __hipsD: [0, 2, 0] }, interp: 'smooth' },
      { t: 0.6, pose: { __swing: [1, 0, 0], __hipsD: [0, 2, 0] }, interp: 'smooth' }, { t: 1, pose: { __swing: [0, 0, 0], __hipsD: [0, 0, 0] } },
    ], false);
    for (let u = 0; u <= 1; u += 0.02) {
      const s = clipPoseAt(c, u)['__swing']![0];
      expect(s, `флаг опоры на ${u.toFixed(2)}`).toBeGreaterThanOrEqual(-1e-9);
      expect(s).toBeLessThanOrEqual(1 + 1e-9);
    }
    // А таз (позиция движения) — гладкий: на середине второго интервала кубика отличается от прямой.
    expect(clipPoseAt(c, 0.15)['__hipsD']![1], 'таз по сплайну, а не по прямой').not.toBeCloseTo(1, 3);
  });

  it('фаза сплайна не ремапится кривой ключа, а ломаная и «плавно» — как раньше', () => {
    expect(easeU({ t: 0, pose: {}, interp: 'smooth' }, 0.3)).toBe(0.3);
    expect(easeU({ t: 0, pose: {}, interp: 'linear' }, 0.3)).toBe(0.3);
    expect(easeU({ t: 0, pose: {}, interp: 'ease' }, 0.3)).not.toBe(0.3);
    const c = clip(keysOf('smooth'), true);
    expect(clipSegmentAt(c, 0.5)!.u).toBeCloseTo((0.5 - 0.45) / 0.15, 9);
  });

  it('⭐ РЕДАКТОР, ОБРЕЗКА И ТРАЕКТОРИЯ ИГРАЮТ СПЛАЙН ТЕМ ЖЕ ПРОИГРЫВАТЕЛЕМ, что игра', () => {
    // Иначе редактор показывал бы ломаную там, где игра играет сплайн.
    const ed = fs.readFileSync(path.join(__dirname, 'pose-editor.ts'), 'utf8');
    const preview = ed.slice(ed.indexOf('function preview(time: number)'), ed.indexOf('function preview(time: number)') + 700);
    expect(preview, '⚠ превью клипа не знает сплайна').toMatch(/interp === 'smooth'[^\n]*segmentPose\(c, seg\)/);
    const traj = ed.slice(ed.indexOf('function updateTrajectory'), ed.indexOf('function updateTrajectory') + 1800);
    expect(traj, '⚠ траектория кости считается мимо общего проигрывателя').toMatch(/segmentPose\(c, seg\)/);
    const imp = fs.readFileSync(path.join(__dirname, 'clipImport.ts'), 'utf8');
    expect(imp.slice(imp.indexOf('export function poseAtSec'), imp.indexOf('export function poseAtSec') + 300), '⚠ обрезка клипа ломает сплайн').toMatch(/segmentPose\(c, seg\)/);
  });

  it('экспорт в glTF пересемплирует сплайн (в glTF нет «сплайна через соседей» на смешанных ключах)', () => {
    const c = clip(keysOf('smooth'), true);
    const anim = poseClipToAnimationClip(c, { fps: 30, epsDeg: 0.25 });
    const tr = anim.tracks.find((t) => t.name === 'LeftUpperLeg.quaternion')!;
    // Значение дорожки в точке между ключами совпадает со сплайном, а не с ломаной.
    const u = 0.52, interp = tr.createInterpolant(); const v = interp.evaluate(u) as Float32Array;
    _q1.set(v[0]!, v[1]!, v[2]!, v[3]!).normalize();
    const want = clipPoseAt(c, u)['LeftUpperLeg']!;
    _q2.setFromEuler(_e.set(want[0], want[1], want[2]));
    expect(_q1.angleTo(_q2) * 180 / Math.PI, 'экспорт повторяет сплайн').toBeLessThan(0.5);
  });
});

describe('подгонка гладких ключей к циклу', () => {
  /** Цикл 60 кадров с замыканием. */
  const frames = (pose: (ph: number) => Pose, n = 60, dur = 1): Keyframe[] =>
    Array.from({ length: n + 1 }, (_, i) => ({ t: (dur * i) / n, pose: pose((2 * Math.PI * (i % n)) / n) }));

  it('⭐ ГЛАДКИЙ ЦИКЛ — ГОРСТЬ КЛЮЧЕЙ, и ошибка в допуске ТЕМ ЖЕ проигрывателем', () => {
    const f = frames(legPose);
    const r = fitSmoothLoop(f, { epsDeg: 1, sigmaFrames: 0 });
    expect(r.keys.length, `ключей ${r.keys.length}`).toBeLessThanOrEqual(9);
    const c = clip(r.keys, true);
    let worst = 0; for (const k of f) worst = Math.max(worst, poseErrorDeg(k.pose, clipPoseAt(c, k.t)));
    expect(worst, 'проверка проигрывателем, а не моделью подгонки').toBeLessThanOrEqual(1 + 1e-6);
    expect(r.keys.slice(0, -1).every((k) => k.interp === 'smooth') && !r.keys.at(-1)!.interp, 'все интервалы — сплайн').toBe(true);
    expect(r.keys.at(-1)!.t).toBe(1);
    expect(ang(r.keys[0]!.pose['LeftUpperLeg']!, r.keys.at(-1)!.pose['LeftUpperLeg']!), 'цикл замкнут').toBeLessThan(1e-6);
  });

  it('⭐⭐ ОДНОКАДРОВЫЙ ИЗЛОМ НЕ ДИКТУЕТ ЧИСЛО КЛЮЧЕЙ — и не раскачивает кривую вокруг себя', () => {
    // Как стопа планировщика: −26° и за один кадр в 0.
    // ⚠ Мутация «подгонять без сглаживания прохода» валит счёт ключей: сплайн садит их на излом.
    const snap = (ph: number): Pose => ({ ...legPose(ph), LeftFoot: [ph > 2 && ph < 4 ? -0.45 : 0, 0, 0] });
    const f = frames(snap);
    const smooth = fitSmoothLoop(f, { epsDeg: 2, sigmaFrames: 1.44 });
    const bare = fitSmoothLoop(f, { epsDeg: 2, sigmaFrames: 0 });
    expect(smooth.keys.length, `со сглаживанием ${smooth.keys.length}, без — ${bare.keys.length}`).toBeLessThan(bare.keys.length);
    const c = clip(smooth.keys, true);
    let over = 0;
    for (let u = 0; u <= 1; u += 0.005) { const x = clipPoseAt(c, u)['LeftFoot']![0]; over = Math.max(over, x - 0, -0.45 - x); }
    expect(over * 180 / Math.PI, '⚠ перелёт стопы за пределы излома').toBeLessThan(4);
  });

  it('сглаживание цикла: σ=0 — тот же проход, замыкание сохраняется', () => {
    const f = frames(legPose, 24);
    expect(smoothLoopFrames(f, 0).map((k) => k.pose['LeftUpperLeg'])).toEqual(f.map((k) => k.pose['LeftUpperLeg']));
    const s = smoothLoopFrames(f, 1.5);
    expect(ang(s[0]!.pose['LeftUpperLeg']!, s.at(-1)!.pose['LeftUpperLeg']!)).toBeLessThan(1e-9);
  });
});

describe('запечённый набор — ключей в разы меньше', () => {
  beforeAll(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  it('⭐⭐ КАЖДЫЙ КЛИП ХОДЬБЫ И БЕГА — МИНИМУМ ВДВОЕ МЕНЬШЕ КЛЮЧЕЙ, ЧЕМ ЛОМАНОЙ, при средней ошибке в доли градуса', () => {
    // ЗАМЕР (тот же проход): ломаная 27–35 ключей, сплайн 11–13; среднее отклонение от прохода 0.16–0.19°, у ног
    // в 95 % кадров ≤ 2.7°; максимум — на однокадровых изломах планировщика, их подгонка скругляет сознательно.
    // ⚠ Мутация «ломаная по умолчанию» валит это.
    const GX = { armDown: 1.35, elbowBend: 0.25 };
    for (const s of GAIT_PRESETS) {
      if (s.name === 'idle') continue;
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
      // ⚠ Ломаную и сплайн сравниваем на ОДНОМ проходе: два запекания отличаются стартовой фазой планировщика,
      // и счёт ключей гулял бы на ±3 сам по себе.
      const raw = bakeGaitToClip(p, h, s, { character: 'warrior', weapon: 'none', epsDeg: 0 });
      const frames = raw.clip.keys, dur = raw.periodSec;
      const lin = reduceKeyframes(frames.slice(0, -1), 1.5).length + 1;           // + замыкание, как у запекателя
      const fit = fitSmoothLoop(frames, { epsDeg: SMOOTH_EPS_DEG, sigmaFrames: SMOOTH_SIGMA_CYCLE * dur * 60 });
      expect(fit.keys.length * 2, `${s.name}: сплайн ${fit.keys.length} ключей против ${lin} у ломаной`).toBeLessThanOrEqual(lin);
      const fc = clip(fit.keys, true);
      let sum = 0, n = 0;
      for (const k of frames) for (const b of Object.keys(k.pose)) {
        if (b[0] === '_' || /Foot|Toes/.test(b)) continue;
        sum += poseErrorDeg({ [b]: k.pose[b]! }, clipPoseAt(fc, k.t / dur)); n++;
      }
      expect(sum / n, `${s.name}: среднее отклонение от прохода`).toBeLessThan(0.35);
      // И запекатель по умолчанию идёт именно этим путём.
      const def = bakeGaitToClip(p, h, s, { character: 'warrior', weapon: 'none' });
      expect(def.clip.keys.slice(0, -1).every((k) => k.interp === 'smooth'), `${s.name}: ⚠ по умолчанию запеклась ломаная`).toBe(true);
      expect(def.keys, `${s.name}: ключей по умолчанию`).toBeLessThanOrEqual(16);
    }
  });
});
