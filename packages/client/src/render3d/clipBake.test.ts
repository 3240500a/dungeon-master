import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { clipPoseAt, clipDur, type Pose } from './clipModel.js';
import { bakeGaitToClip, bakeGaitSet, defaultReadPose, GAIT_PRESETS, BAKE_MAXSPD, removeLoopDrift, type GaitSpec } from './clipBake.js';
import { locoPhaseU } from './locoBlend.js';

/**
 * ГЛАВНАЯ ПРОВЕРКА Ф2: запечённый клип воспроизводит ЖИВУЮ походку.
 * Пока этот порог не выполняется — StepPlanner из клиентов резать нельзя.
 */

const GX = { armDown: 1.35, elbowBend: 0.25 };
const mkPlayer = (h: Humanoid): PosePlayer =>
  new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid());

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _ea = new THREE.Euler(), _eb = new THREE.Euler();
/** Макс. угловое расхождение двух поз по костям, в градусах. */
function maxAngleDeg(a: Pose, b: Pose, only?: (bone: string) => boolean): { deg: number; bone: string } {
  let deg = 0, bone = '—';
  for (const nm of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (nm[0] === '_') continue;
    if (only && !only(nm)) continue;
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

  it('цикл снимается по фазе: период правдоподобен и клип замкнут', () => {
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
    expect(p['__hipsD']).toBeDefined();          // Ф12: дельта от rest, а не абсолютная высота таза
    expect(p['__hipsP']).toBeUndefined();        // старый абсолютный ключ бейк больше не пишет
    expect(p['LeftBreast']).toBeUndefined();
    expect(p['RightBreast']).toBeUndefined();
  });

  it('defaultReadPose снимает позу текущего гуманоида', () => {
    const h = buildHumanoid({});
    h.bones.get('Spine')!.rotation.set(0.3, 0, 0);
    const p = defaultReadPose(h)();
    expect(p['Spine']![0]).toBeCloseTo(0.3, 3);
    expect(p['__hipsD']![1]).toBeCloseTo(h.hips.position.y - h.hipsRest.y, 2);
  });
});

/**
 * ⭐⭐ ПАРИТЕТ ПРОВЕРЯЕТ КОНТРАКТ ПРОИГРЫВАНИЯ, А НЕ «КЛИП СОВПАДАЕТ САМ С СОБОЙ».
 *
 * ⚠ ЗДЕСЬ БЫЛО ДРУГОЕ ВЫРАВНИВАНИЕ, и оно прятало настоящий дефект. Живой бег сводился с клипом по
 * тому же фронту «левая пошла в перенос», по которому клип и снимался, — и тест доказывал только
 * то, что запись совпадает с записью. А рантайм читает клип ФАЗОЙ ПЛАНИРОВЩИКА (`locoPhaseU`), и
 * фронт этот стоял на фазе u≈0.126, а не 0: клип играл на 45° не в такт ногам. ЗАМЕР на беге,
 * выровненном по фазе: расхождение до 63° (в среднем 5.7°) — «на вкладке Бег плавно, а запечённое
 * дёргано». Теперь запекатель снимает ПО ФАЗЕ, и паритет сверяет ровно так, как клип играют.
 */
describe('clipBake — ПАРИТЕТ: запечённый клип ≈ живая походка', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  /** Стопа и носок: ими владеет заземление рантайма, а не клип (см. комментарий к порогам ниже). */
  const FOOT = (b: string): boolean => /Foot|Toe/.test(b);
  const parity = (spec: GaitSpec, tolDeg: number): { worst: number; bone: string; period: number; feet: number } => {
    const fps = 60, dt = 1 / fps, warm = 2;
    // 1) запечь
    const hb = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(hb), hb, spec, { character: 'warrior', weapon: 'sword', fps, epsDeg: 0.5, warmSec: warm });
    expect(r.cyclic).toBe(true);

    // 2) прогнать ЖИВОЙ гейт и на каждом кадре взять клип ТОЙ ЖЕ ФАЗОЙ, что и рантайм
    const hl = buildHumanoid({});
    const pl = mkPlayer(hl);
    const vx = spec.vx * BAKE_MAXSPD, vz = spec.vz * BAKE_MAXSPD;
    pl.setVel(vx, vz);
    pl.setYaw(spec.yaw ?? Math.atan2(vx, vz));
    pl.snapYaw(); pl.resetPos();
    for (let t = 0; t < warm; t += dt) pl.step(dt);

    const read = defaultReadPose(hl);
    let worst = 0, bone = '—', feet = 0;
    for (let t = 0; t < r.periodSec * 2; t += dt) {            // два цикла — чтобы шов тоже попал в сверку
      pl.step(dt);
      const live = read();
      const h = live['Hips']; if (h) live['Hips'] = [h[0], h[1] - pl.pelvisYaw, h[2]];   // тот же вычет фейсинга
      const baked = clipPoseAt(r.clip, locoPhaseU(pl.driver.gaitPhase));
      const d = maxAngleDeg(live, baked, (b) => !FOOT(b));
      if (d.deg > worst) { worst = d.deg; bone = d.bone; }
      feet = Math.max(feet, maxAngleDeg(live, baked, FOOT).deg);
    }
    return { worst, bone, period: r.periodSec, feet };
  };

  // ⚠ ПОРОГИ — 4° (раньше 3° ходьба / 4° бег), но теперь на ЧЕСТНОМ контракте, и ПО КОСТЯМ, КОТОРЫМИ
  // ВЛАДЕЕТ КЛИП. Замер по группам (бег): таз 0.00°, корпус 0.07°, руки ≤0.2°, ноги ≤2.4° — а стопы
  // до 5.8° (ходьба до 10.4°). Стопа — единственное исключение, и не случайное: её угол у планировщика
  // зависит не только от фазы (передача шага, цель лодыжки), у живого гейта на смене опоры есть свой
  // скачок стопы ~25.8° за кадр, а в игре опорную стопу всё равно кладёт на пол заземление. Поэтому
  // стопам — свой, мягкий порог. Прореживание ключей на это не влияет вовсе (eps 0.5 и 0 — одно и то же).
  // Мутация «снимать по фронту ноги» даёт по ногам 60–64° и проваливает оба порога.
  it('⭐⭐ walk_fwd: клип, сыгранный фазой планировщика, совпадает с живой ходьбой', () => {
    // Было 3°, стало 4°: на ДВУХ циклах против живого гейта голень ходьбы даёт 3.68° (замер) — это
    // неполная периодичность планировщика, а не запекание (при eps 0 и 0.5 число то же).
    const { worst, bone, feet } = parity({ name: 'walk_fwd', vx: 0, vz: 0.42 }, 4);
    expect(worst, `худшая кость: ${bone}`).toBeLessThan(4);
    expect(feet, 'стопы').toBeLessThan(12);
  });

  it('⭐⭐ run_fwd: то же на беге (шире шаг, быстрее фаза)', () => {
    const { worst, bone, feet } = parity({ name: 'run_fwd', vx: 0, vz: 0.85 }, 4);
    expect(worst, `худшая кость: ${bone}`).toBeLessThan(4);
    expect(feet, 'стопы').toBeLessThan(12);
  });

  it('⭐⭐ run_strafe_R: боковой ход (прицел вперёд) тоже совпадает', () => {
    const { worst, bone, feet } = parity({ name: 'run_strafe_R', vx: 0.85, vz: 0, yaw: 0 }, 4);
    expect(worst, `худшая кость: ${bone}`).toBeLessThan(4);
    expect(feet, 'стопы').toBeLessThan(12);
  });

  it('⭐ ШОВ ЦИКЛА БЕЗ РЫВКА: шаг позы через шов такой же, как сразу после начала', () => {
    // Дрейф планировщика за цикл (0.2–3.4° от цикла к циклу) раньше сжимался в ОДИН кадр на шве.
    // Теперь он разнесён по циклу. Меряем там, где он заметен, — на ходьбе: без разнесения шов даёт
    // 1.0–1.1° разницы шага по костям ног, с разнесением 0.16–0.35°. Стопы не берём: ими владеет
    // заземление, и на беге их шум сам по себе до 0.7°.
    // ⚠ Мутация «не звать removeLoopDrift» валит это.
    for (const name of ['walk_fwd', 'walk_back', 'walk_strafe_L', 'walk_strafe_R']) {
      const spec = GAIT_PRESETS.find((s) => s.name === name)!;
      const hb = buildHumanoid({});
      const r = bakeGaitToClip(mkPlayer(hb), hb, spec, { character: 'warrior', weapon: 'sword', epsDeg: 0 });
      const step = 1 / Math.round(r.periodSec * 60);
      const a0 = clipPoseAt(r.clip, 0), a1 = clipPoseAt(r.clip, step), z1 = clipPoseAt(r.clip, 1 - step), z0 = clipPoseAt(r.clip, 1);
      let worst = 0, bone = '—';
      for (const b of Object.keys(a0)) {
        if (b[0] === '_' || /Foot|Toe/.test(b)) continue;
        const d = Math.abs(maxAngleDeg({ [b]: z1[b]! }, { [b]: z0[b]! }).deg - maxAngleDeg({ [b]: a0[b]! }, { [b]: a1[b]! }).deg);
        if (d > worst) { worst = d; bone = b; }
      }
      expect(worst, `${name}: рывок на шве ${worst.toFixed(2)}° (${bone})`).toBeLessThan(0.6);
    }
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

describe('removeLoopDrift — замыкание цикла разнесением дрейфа', () => {
  it('⭐ конец становится началом, а дрейф ложится на кадры ДОЛЯМИ, а не весь в последний', () => {
    // Скаляр: 0 → … → 1 (дрейф 1). Поворот: 0 → … → 0.2 рад (дрейф 0.2).
    const n = 10;
    const grid = Array.from({ length: n + 1 }, (_, k) => ({ Spine: [0.2 * k / n, 0, 0] as [number, number, number], __hipsP: [k / n, 0, 0] as [number, number, number] }));
    removeLoopDrift(grid);
    expect(grid[n]!.__hipsP[0], 'скаляр: конец = началу').toBeCloseTo(0, 9);
    expect(grid[n]!.Spine[0], 'поворот: конец = началу').toBeCloseTo(0, 6);
    // Ровная рампа после вычета дрейфа — константа: ни один кадр не несёт весь дрейф разом.
    for (let k = 1; k < n; k++) {
      expect(Math.abs(grid[k]!.__hipsP[0] - grid[k - 1]!.__hipsP[0]), `шаг скаляра на кадре ${k}`).toBeLessThan(1e-9);
      expect(Math.abs(grid[k]!.Spine[0] - grid[k - 1]!.Spine[0]), `шаг поворота на кадре ${k}`).toBeLessThan(1e-6);
    }
    expect(grid[0]!.Spine[0], 'начало не трогается').toBe(0);
  });
});
