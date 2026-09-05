import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { clipPoseAt, clipDur, type Pose } from './clipModel.js';
import { bakeGaitToClip, bakeGaitSet, defaultReadPose, GAIT_PRESETS, BAKE_MAXSPD, type GaitSpec } from './clipBake.js';

/**
 * ГЛАВНАЯ ПРОВЕРКА Ф2: запечённый клип воспроизводит ЖИВУЮ походку.
 * Пока этот порог не выполняется — StepPlanner из клиентов резать нельзя.
 */

const GX = { armDown: 1.35, elbowBend: 0.25 };
const mkPlayer = (h: Humanoid): PosePlayer =>
  new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid());

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _ea = new THREE.Euler(), _eb = new THREE.Euler();
/** Макс. угловое расхождение двух поз по костям, в градусах. */
function maxAngleDeg(a: Pose, b: Pose): { deg: number; bone: string } {
  let deg = 0, bone = '—';
  for (const nm of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (nm[0] === '_') continue;
    const va = a[nm] ?? [0, 0, 0], vb = b[nm] ?? [0, 0, 0];
    _qa.setFromEuler(_ea.set(va[0], va[1], va[2], 'XYZ'));
    _qb.setFromEuler(_eb.set(vb[0], vb[1], vb[2], 'XYZ'));
    const d = _qa.angleTo(_qb) * 180 / Math.PI;
    if (d > deg) { deg = d; bone = nm; }
  }
  return { deg, bone };
}

/** Прогнать плеер до фронта «левая нога в перенос» — та же точка, с которой начинается запечённый клип. */
function runToCycleStart(p: PosePlayer, dt: number, warmSec: number, maxSec = 6): boolean {
  for (let t = 0; t < warmSec; t += dt) p.step(dt);
  let prev = p.driver.swingLegs[0];
  for (let t = 0; t < maxSec; t += dt) {
    p.step(dt);
    const sw = p.driver.swingLegs[0];
    if (sw && !prev) return true;
    prev = sw;
  }
  return false;
}

describe('clipBake — запекание походки', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  it('цикл ловится по ноге: период правдоподобен и клип замкнут', () => {
    const h = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(h), h, { name: 'walk_fwd', vx: 0, vz: 0.42 }, { character: 'warrior', weapon: 'sword' });
    expect(r.cyclic).toBe(true);
    expect(r.periodSec).toBeGreaterThan(0.25);
    expect(r.periodSec).toBeLessThan(2);
    expect(r.clip.loop).toBe(true);
    // последний ключ == первый (шов цикла не виден)
    const first = r.clip.keys[0]!.pose, last = r.clip.keys[r.clip.keys.length - 1]!.pose;
    expect(maxAngleDeg(first, last).deg).toBeLessThan(1e-3);
    expect(clipDur(r.clip)).toBeCloseTo(r.periodSec, 4);
  });

  it('прореживание реально сжимает: ключей заметно меньше кадров', () => {
    const h = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(h), h, { name: 'run_fwd', vx: 0, vz: 0.85 }, { character: 'warrior', weapon: 'sword' });
    expect(r.frames).toBeGreaterThan(10);
    expect(r.keys).toBeLessThan(r.frames);
  });

  it('фейсинг вычтен: у прямолинейной походки Hips.y ≈ 0 (клип не поворачивает персонажа)', () => {
    const h = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(h), h, { name: 'walk_fwd', vx: 0, vz: 0.42 }, { character: 'warrior', weapon: 'sword' });
    for (const k of r.clip.keys) expect(Math.abs(k.pose['Hips']?.[1] ?? 0)).toBeLessThan(0.02);
  });

  it('страйф с прицелом вперёд тоже не тащит фейсинг в клип', () => {
    const h = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(h), h, { name: 'strafe_R', vx: 0.5, vz: 0, yaw: 0 }, { character: 'warrior', weapon: 'sword' });
    for (const k of r.clip.keys) expect(Math.abs(k.pose['Hips']?.[1] ?? 0)).toBeLessThan(0.35);   // остаётся только скрутка таза
  });

  it('стойка (v=0) — один ключ, не цикл', () => {
    const h = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(h), h, { name: 'idle', vx: 0, vz: 0, loop: false }, { character: 'warrior', weapon: 'sword' });
    expect(r.cyclic).toBe(false);
    expect(r.clip.keys.length).toBe(1);
    expect(r.clip.loop).toBe(false);
  });

  it('фиксированное окно (durationSec) снимается по таймеру', () => {
    const h = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(h), h, { name: 'w', vx: 0, vz: 0.42, durationSec: 0.5 }, { character: 'warrior', weapon: 'sword', fps: 30 });
    expect(r.periodSec).toBeCloseTo(0.5, 3);
    expect(clipDur(r.clip)).toBeCloseTo(0.5, 3);
  });

  it('в позе клипа есть офсет таза и нет jiggle-костей груди', () => {
    const h = buildHumanoid({ gender: 'female' });
    const r = bakeGaitToClip(mkPlayer(h), h, { name: 'walk_fwd', vx: 0, vz: 0.42 }, { character: 'warrior', weapon: 'sword' });
    const p = r.clip.keys[0]!.pose;
    expect(p['__hipsP']).toBeDefined();
    expect(p['LeftBreast']).toBeUndefined();
    expect(p['RightBreast']).toBeUndefined();
  });

  it('defaultReadPose снимает позу текущего гуманоида', () => {
    const h = buildHumanoid({});
    h.bones.get('Spine')!.rotation.set(0.3, 0, 0);
    const p = defaultReadPose(h)();
    expect(p['Spine']![0]).toBeCloseTo(0.3, 3);
    expect(p['__hipsP']![1]).toBeCloseTo(h.hips.position.y, 2);
  });
});

describe('clipBake — ПАРИТЕТ: запечённый клип ≈ живая походка', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  const parity = (spec: GaitSpec, tolDeg: number): { worst: number; bone: string; period: number } => {
    const fps = 60, dt = 1 / fps, warm = 2;
    // 1) запечь
    const hb = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(hb), hb, spec, { character: 'warrior', weapon: 'sword', fps, epsDeg: 0.5, warmSec: warm });
    expect(r.cyclic).toBe(true);

    // 2) заново прогнать ЖИВОЙ гейт до той же точки цикла и сравнить кадр в кадр
    const hl = buildHumanoid({});
    const pl = mkPlayer(hl);
    const vx = spec.vx * BAKE_MAXSPD, vz = spec.vz * BAKE_MAXSPD;
    pl.setVel(vx, vz);
    pl.setYaw(spec.yaw ?? Math.atan2(vx, vz));
    pl.snapYaw(); pl.resetPos();
    expect(runToCycleStart(pl, dt, warm)).toBe(true);

    const read = defaultReadPose(hl);
    let worst = 0, bone = '—';
    for (let t = 0; t < r.periodSec - 1e-6; t += dt) {
      const live = read();
      const h = live['Hips']; if (h) live['Hips'] = [h[0], h[1] - pl.pelvisYaw, h[2]];   // тот же вычет фейсинга
      const baked = clipPoseAt(r.clip, t / r.periodSec);
      const d = maxAngleDeg(live, baked);
      if (d.deg > worst) { worst = d.deg; bone = d.bone; }
      pl.step(dt);
    }
    return { worst, bone, period: r.periodSec };
  };

  it('walk_fwd: расхождение по костям в пределах порога прореживания', () => {
    const { worst, bone } = parity({ name: 'walk_fwd', vx: 0, vz: 0.42 }, 3);
    expect(worst, `худшая кость: ${bone}`).toBeLessThan(3);
  });

  it('run_fwd: то же на беге (шире шаг, быстрее фаза)', () => {
    const { worst, bone } = parity({ name: 'run_fwd', vx: 0, vz: 0.85 }, 4);
    expect(worst, `худшая кость: ${bone}`).toBeLessThan(4);
  });

  it('strafe_R: боковой ход (прицел вперёд) тоже совпадает', () => {
    const { worst, bone } = parity({ name: 'strafe_R', vx: 0.5, vz: 0, yaw: 0 }, 4);
    expect(worst, `худшая кость: ${bone}`).toBeLessThan(4);
  });
});

describe('clipBake — набор пресетов', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  it('весь набор запекается, имена уникальны, циклические режимы замкнуты', () => {
    const h = buildHumanoid({});
    const p = mkPlayer(h);
    const out = bakeGaitSet(p, h, { character: 'warrior', weapon: 'sword', fps: 60, warmSec: 1.2 });
    expect(out.length).toBe(GAIT_PRESETS.length);
    expect(new Set(out.map((r) => r.clip.name)).size).toBe(out.length);
    for (const r of out) {
      expect(r.clip.keys.length).toBeGreaterThan(0);
      if (r.clip.loop) {
        const f = r.clip.keys[0]!.pose, l = r.clip.keys[r.clip.keys.length - 1]!.pose;
        expect(maxAngleDeg(f, l).deg, `цикл не замкнут: ${r.clip.name}`).toBeLessThan(1e-3);
      }
    }
  });

  it('в наборе НЕТ поворотов (они требуют вращения корня, а клипы in-place)', () => {
    expect(GAIT_PRESETS.some((s) => /turn/i.test(s.name))).toBe(false);
  });
});
