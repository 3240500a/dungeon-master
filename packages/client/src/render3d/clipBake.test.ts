import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, getDirWarpOverride, isLocoClipFresh, LOCO_BAKE_REV, mirrorPlantCell, mirrorPlantDir, plantMirrorGaps } from './poseRuntime.js';
import { clipPoseAt, clipDur, hipsOffset, type Clip, type Pose } from './clipModel.js';
import { bakeGaitToClip, bakeGaitSet, bakeTurnSet, defaultReadPose, neutralizeFacing, GAIT_PRESETS, openStrafePresets, BAKE_MAXSPD, removeLoopDrift, type GaitSpec } from './clipBake.js';
import { locoPhaseU, LOCO_BAKE_WALK_SPD, LOCO_BAKE_RUN_SPD } from './locoBlend.js';
import { GAIT, GAIT_BASE, POSE, POSE_BASE } from './pose.js';

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

  it('страйф с прицелом вперёд тоже не тащит фейсинг в клип — и доворота таза в нём нет (кардинальный)', () => {
    // Было < 0.35 рад («остаётся скрутка таза»): порог пропускал впечённый доворот 20°. Клип хода — кардинальный.
    const h = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(h), h, { name: 'strafe_R', vx: 0.5, vz: 0, yaw: 0 }, { character: 'warrior', weapon: 'sword' });
    for (const k of r.clip.keys) expect(Math.abs(k.pose['Hips']?.[1] ?? 0)).toBeLessThan(0.02);
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
  interface Parity { worst: number; bone: string; period: number; feet: number; mean: number; p95: number; keys: number }
  const parity = (spec: GaitSpec, smooth = true): Parity => {
    const fps = 60, dt = 1 / fps, warm = 2;
    // 1) запечь
    const hb = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(hb), hb, spec, { character: 'warrior', weapon: 'sword', fps, epsDeg: 0.5, warmSec: warm, smooth });
    expect(r.cyclic).toBe(true);

    // 2) прогнать ЖИВОЙ гейт и на каждом кадре взять клип ТОЙ ЖЕ ФАЗОЙ, что и рантайм
    const hl = buildHumanoid({});
    const pl = mkPlayer(hl);
    const vx = spec.vx * BAKE_MAXSPD, vz = spec.vz * BAKE_MAXSPD;
    pl.setVel(vx, vz);
    pl.setYaw(spec.yaw ?? Math.atan2(vx, vz));
    pl.snapYaw(); pl.resetPos();
    for (let t = 0; t < warm; t += dt) pl.step(dt);

    // ⚠ ВЫЧИТАЕМ ТО ЖЕ, ЧТО ЗАПЕКАТЕЛЬ: у кардинального клипа это `pelvisYaw` (доворот на съёме 0, поэтому он же —
    // прицельный корень), у набора «таз открыт» — ТОЛЬКО прицельный корень: раскрытие обязано остаться в позе.
    const sub = (): number => (spec.hipsOpenDeg ? pl.aimRootYaw : pl.pelvisYaw);
    const read = defaultReadPose(hl);
    let worst = 0, bone = '—', feet = 0;
    const all: number[] = [];
    for (let t = 0; t < r.periodSec * 2; t += dt) {            // два цикла — чтобы шов тоже попал в сверку
      pl.step(dt);
      const live = read();
      neutralizeFacing(live, sub(), hl.hipsRest);                // тот же вычет фейсинга, что у запекателя
      const baked = clipPoseAt(r.clip, locoPhaseU(pl.driver.gaitPhase));
      const d = maxAngleDeg(live, baked, (b) => !FOOT(b));
      if (d.deg > worst) { worst = d.deg; bone = d.bone; }
      for (const b of Object.keys(live)) if (b[0] !== '_' && !FOOT(b)) all.push(maxAngleDeg({ [b]: live[b]! }, { [b]: baked[b] ?? [0, 0, 0] }).deg);
      feet = Math.max(feet, maxAngleDeg(live, baked, FOOT).deg);
    }
    all.sort((a, b) => a - b);
    const mean = all.reduce((s, v) => s + v, 0) / Math.max(1, all.length);
    return { worst, bone, period: r.periodSec, feet, mean, p95: all[Math.floor(all.length * 0.95)] ?? 0, keys: r.keys };
  };

  // ⚠ ПОРОГИ ЛОМАНОЙ — 4° на ЧЕСТНОМ контракте и ПО КОСТЯМ, КОТОРЫМИ ВЛАДЕЕТ КЛИП. Замер по группам (бег): таз 0.00°,
  // корпус 0.07°, руки ≤0.2°, ноги ≤2.4° — а стопы до 5.8° (ходьба до 10.4°). Стопа — исключение не случайное: её
  // угол у планировщика зависит не только от фазы, у живого гейта на смене опоры свой скачок стопы ~25.8° за кадр,
  // а в игре опорную стопу всё равно кладёт на пол заземление. Мутация «снимать по фронту ноги» даёт 60–64°.
  //
  // ⭐ СПЛАЙН (по умолчанию) — другой контракт, и пороги у него свои: подгонка СОЗНАТЕЛЬНО скругляет однокадровые
  // изломы планировщика (колено дёргается на 11–16° за кадр при касании другой ноги), поэтому максимум вырос —
  // ЗАМЕР худшей голени: ходьба 8.4°, бег 6.5°, боком 5.8°. Сверять только максимум значило бы сверять изломы, а
  // не контракт проигрывания, поэтому у сплайна главные — СРЕДНЕЕ и 95-й ПЕРЦЕНТИЛЬ по всем костям и кадрам: сдвиг
  // фазы (та мутация) поднимает среднее до ~6°, а скругление изломов — нет.
  const SMOOTH_LIMITS = { mean: 0.6, p95: 2.5, worst: 11, feet: 18 };
  const smoothParity = (name: string, spec: GaitSpec): void => {
    const r = parity(spec);
    const msg = `${name}: ключей ${r.keys}, среднее ${r.mean.toFixed(2)}°, 95 % ${r.p95.toFixed(2)}°, худшая ${r.bone} ${r.worst.toFixed(1)}°, стопы ${r.feet.toFixed(1)}°`;
    expect(r.mean, msg).toBeLessThan(SMOOTH_LIMITS.mean);
    expect(r.p95, msg).toBeLessThan(SMOOTH_LIMITS.p95);
    expect(r.worst, msg).toBeLessThan(SMOOTH_LIMITS.worst);
    expect(r.feet, msg).toBeLessThan(SMOOTH_LIMITS.feet);
  };
  // ⭐ СВЕРКА — НА СКОРОСТЯХ НАБОРА (`GAIT_PRESETS`, 40 / 120 u/с с 17.09), а не на прежних литералах 0.42 / 0.85: сторож
  // обязан стеречь то, что реально запекается. Контракт тот же (клип фазой планировщика = живой ход на той же скорости),
  // и на чистых скоростях он выполняется ЛУЧШЕ — у планировщика нет полусмеси ходьбы и бега. ЗАМЕР (среднее / 95 % /
  // худшая / стопы, °): walk_fwd 0.21 / 1.10 / 8.4 / 13.2 → 0.17 / 0.69 / 6.4 / 11.5; run_fwd 0.21 / 1.17 / 6.5 / 11.0 →
  // 0.19 / 1.02 / 5.9 / 9.3; run_strafe_R 0.19 / 0.97 / 5.8 / 6.4 → 0.19 / 0.91 / 6.7 / 5.2. Ломаная: худшая 3.68 / 2.42 →
  // 0.45 / 0.41, стопы 10.4 / 5.8 → 0.17 / 0.03.
  const preset = (name: string): GaitSpec => GAIT_PRESETS.find((s) => s.name === name)!;
  it('⭐⭐ walk_fwd: клип, сыгранный фазой планировщика, совпадает с живой ходьбой', () => {
    smoothParity('walk_fwd', preset('walk_fwd'));
  });

  it('⭐⭐ run_fwd: то же на беге (шире шаг, быстрее фаза)', () => {
    smoothParity('run_fwd', preset('run_fwd'));
  });

  it('⭐⭐ run_strafe_R: боковой ход (прицел вперёд) тоже совпадает', () => {
    smoothParity('run_strafe_R', preset('run_strafe_R'));
  });

  /**
   * ⭐ ПАРИТЕТ НОВЫХ РЕЖИМОВ. Прежние сверки шли с `warpOn` 0: тумблер доворота и «таз открыт» в них не участвовали
   * вовсе, а редактор обещает «без «только клипы» планировщик показывает то, что снимет кнопка».
   *  • доворот ВКЛ, сектора: на чистом боку доворот 0, но путь `stepDirWarp` работает и обязан не портить съём;
   *  • набор «таз открыт»: живой планировщик раскрывает таз на `hipsOpen`, и запечённый клип обязан совпасть с ним
   *    при вычете ПРИЦЕЛЬНОГО КОРНЯ (мутация «вычитать pelvisYaw» даёт клип с Hips 0, то есть «ровно»).
   */
  it('⭐ ПАРИТЕТ С ДОВОРОТОМ ВКЛ и с «таз открыт»: живой планировщик = запечённый клип', () => {
    // ⚠ Режим у живого прогона и у съёма ОДИН: «ровно» сверяем с кардинальным клипом, «открыт» — с клипом набора
    // `_open`. Смешать нельзя: при `hipsMode` 1 планировщик сам раскрывает таз на 35° (`legsOpen`), и кардинальный
    // клип против него честно разойдётся (замер: среднее 4.24°, бедро 44.8°) — это не дефект, а разные режимы.
    Object.assign(GAIT, GAIT_BASE, { warpOn: 1, warpMax: 45, hipsMode: 0, hipsOpen: 35, hipsOpenWalk: 10 });
    try {
      smoothParity('run_strafe_R (доворот ВКЛ)', preset('run_strafe_R'));
      GAIT.hipsMode = 1;
      smoothParity('run_strafe_R_open', { ...preset('run_strafe_R'), name: 'run_strafe_R_open', hipsOpenDeg: 35 });
    } finally { Object.assign(GAIT, GAIT_BASE); }
  });

  it('⭐ ЛОМАНАЯ (сплайн выключен) держит прежний строгий контракт: худшая кость < 4°, стопы < 12°', () => {
    // Было 3°, стало 4°: на ДВУХ циклах против живого гейта голень ходьбы даёт 3.68° (замер) — это неполная
    // периодичность планировщика, а не запекание (при eps 0 и 0.5 число то же).
    for (const spec of [preset('walk_fwd'), preset('run_fwd')]) {
      const r = parity(spec, false);
      expect(r.worst, `${spec.name}: худшая кость ${r.bone}`).toBeLessThan(4);
      expect(r.feet, `${spec.name}: стопы`).toBeLessThan(12);
    }
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

  it('⭐⭐ КАЖДЫЙ КЛИП ХОДА ПОМНИТ СКОРОСТЬ ЗАПЕКАНИЯ: ходьба 40, бег 120 u/с; стойка и повороты — без поля', () => {
    // Часы «только клипы» меряют цикл этой скоростью × период. Раньше её угадывали по имени (0.42 / 0.85 от 120), и
    // смена скоростей набора разошлась бы с уже запечённым молча.
    const h = buildHumanoid({});
    const p = mkPlayer(h);
    const out = bakeGaitSet(p, h, { character: 'warrior', weapon: 'sword', fps: 60, warmSec: 1.2 });
    for (const r of out) {
      if (r.clip.name === 'idle') { expect(r.clip.bakeSpeed, 'стойка').toBeUndefined(); continue; }
      const want = /^run_/.test(r.clip.name) ? LOCO_BAKE_RUN_SPD : LOCO_BAKE_WALK_SPD;
      expect(r.clip.bakeSpeed, r.clip.name).toBe(want);
    }
    for (const r of bakeTurnSet(p, h, { character: 'warrior', weapon: 'sword' })) expect(r.clip.bakeSpeed, r.clip.name).toBeUndefined();
  });

  it('⭐⭐ НАБОР ЧИСТЫЙ: на 40 u/с планировщик снимает ходьбу на sb 0, на 120 — бег на sb 1 (условие на ручки)', () => {
    // Было 50.4 / 102 → sb 0.139 / 0.827: «ходьба» несла 14 % беговых настроек, «бег» — 17 % шаговых. Чисто только пока
    // speedWalk ≥ 40 и speedRun ≤ 120 — умолчания (40 / 115) это держат; сдвинешь ручку за край — клип снова смесь.
    expect(GAIT.speedWalk, 'speedWalk ниже 40 — ходьба на 40 уже не чистая').toBeGreaterThanOrEqual(LOCO_BAKE_WALK_SPD);
    expect(GAIT.speedRun, 'speedRun выше 120 — бег на 120 уже не чистый').toBeLessThanOrEqual(LOCO_BAKE_RUN_SPD);
    for (const s of GAIT_PRESETS) {
      if (s.name === 'idle') continue;
      const h = buildHumanoid({});
      const p = mkPlayer(h);
      p.setVel(s.vx * BAKE_MAXSPD, s.vz * BAKE_MAXSPD); p.setYaw(s.yaw ?? Math.atan2(s.vx, s.vz)); p.snapYaw();
      for (let i = 0; i < 30; i++) p.step(1 / 60);
      const sb = (p.driver as unknown as { planner: { sb: number } }).planner.sb;
      expect(sb, `${s.name}: ось ходьба↔бег планировщика при съёме`).toBe(/^run_/.test(s.name) ? 1 : 0);
    }
  });

  /**
   * ⭐ КАЧАНИЕ ТАЗА ЛОЖИТСЯ В КАДР ПЕРСОНАЖА — ВБОК (X), А НЕ ПОД ДОВОРОТ (ревью 17.09, `pelvisFrame.ts`).
   *
   * Страйф игра ведёт с доворотом таза под движение (`warpMax` до 50°). Старый вычет фейсинга снимал курс только из
   * ПОВОРОТА таза, а X/Z `__hipsD` оставлял в осях мира — качание уезжало в клип уже повёрнутым, и игра, которая
   * теперь крутит `__hipsD` на `pelvisYaw`, положила бы доворот ВТОРОЙ раз. ЗАМЕР (рыцарь, доворот+качание включены):
   * старый вычет — `|__hipsD.z|` до 0.97u (ходьба) и 1.15u (бег) при `|x|` 0.81 / 0.97; новый — ≤ 0.0003u при `|x|` 1.26 / 1.50.
   */
  it('⭐ качание таза запекается ВБОК персонажа: у всей походки `__hipsD.z` ≈ 0 (доворот страйфа вычтен)', () => {
    Object.assign(GAIT, GAIT_BASE, { warpOn: 1, warpMax: 50 });          // без доворота и качания сторожить нечего
    Object.assign(POSE, POSE_BASE, { hipSway: 1.5, hipSwayRun: 1.5 });
    try {
      const h = buildHumanoid({});
      const out = bakeGaitSet(mkPlayer(h), h, { character: 'warrior', weapon: 'sword', fps: 60, warmSec: 1.2 }, GAIT_PRESETS.filter((sp) => sp.name !== 'idle'));
      for (const r of out) {
        let mx = 0, mz = 0;
        for (const k of r.clip.keys) { const d = hipsOffset(k.pose, h.hipsRest.y); if (!d) continue; mx = Math.max(mx, Math.abs(d[0])); mz = Math.max(mz, Math.abs(d[2])); }
        expect(mx, `${r.clip.name}: качание таза вбок`).toBeGreaterThan(0.5);
        expect(mz, `${r.clip.name}: качание таза ВПЕРЁД (доворот остался в клипе)`).toBeLessThan(0.02);
      }
    } finally { Object.assign(GAIT, GAIT_BASE); Object.assign(POSE, POSE_BASE); }
  });

  /**
   * ⭐ ЗАКРЫТО (было `it.todo` «перезапечь четыре страйфа»). Старый вычет клал качание таза уже повёрнутым на доворот,
   * и игра с композицией `pelvisFrame` крутила его второй раз — таз и голова уезжали на 0.26u на курсе 0. Теперь съём
   * идёт БЕЗ доворота (`warpFree` + `assertWarp`), круг «снял → сыграл» сходится (сторож выше и `pelvisFrame.test.ts`),
   * а СТАРЫЕ опубликованные клипы видны и коду, и автору: `isLocoClipFresh` = false → рантайм держит старую складку
   * доворота, редактор в списке съёма пишет «⚠ с доворотом — перезапеки» (user step 4).
   */
  it('⭐ перезапечённый набор лечит старый вычет: ревизия 2 и свежесть; клип БЕЗ ревизии рантайм и редактор считают старым', () => {
    Object.assign(GAIT, GAIT_BASE, { warpOn: 1, warpMax: 50 });
    Object.assign(POSE, POSE_BASE, { hipSway: 1.5, hipSwayRun: 1.5 });
    try {
      const h = buildHumanoid({});
      const out = bakeGaitSet(mkPlayer(h), h, { character: 'warrior', weapon: 'none', fps: 60, warmSec: 1.2 },
        GAIT_PRESETS.filter((sp) => /_strafe_/.test(sp.name)));
      for (const r of out) {
        expect(r.clip.bakeRev, `${r.clip.name}: ревизия`).toBe(LOCO_BAKE_REV);
        expect(isLocoClipFresh(r.clip), `${r.clip.name}: рантайм считает свежим`).toBe(true);
        // Опубликованный до 17.09 клип: `bakeSpeed` есть (наш съём), ревизии нет — это и есть «старый вычет».
        expect(isLocoClipFresh({ ...r.clip, bakeRev: undefined }), `${r.clip.name}: старый — не свежий`).toBe(false);
      }
      // Импорт мокапа (`bakeSpeed` пишет только наш запекатель) доворота в себе не несёт — он свежий по определению.
      expect(isLocoClipFresh({ name: 'walk_strafe_R', keys: [] } as unknown as Clip), 'импорт — свежий').toBe(true);
    } finally { Object.assign(GAIT, GAIT_BASE); Object.assign(POSE, POSE_BASE); }
  });

  it('в наборе НЕТ поворотов (они требуют вращения корня, а клипы in-place)', () => {
    expect(GAIT_PRESETS.some((s) => /turn/i.test(s.name))).toBe(false);
  });
});

/**
 * ⭐⭐ СТРАЙФЫ КАРДИНАЛЬНЫЕ, КАК БЫ И В КАКОМ ПОРЯДКЕ НИ ЗАПЕКАЛИ.
 *
 * Жалоба: «страйф выглядит как ход под 45°». ЗАМЕР опубликованного набора (рыцарь): ноги strafe_L / strafe_R шли
 * под −125° / +126° (бег −126 / +126) к корню клипа, в корпус впечена скрутка ±40°. Две причины сразу: съём шёл с
 * включённым доворотом таза (`warpOn` 1 у воина) и вычитал довёрнутый таз; а состояние доворота жило в ОДНОМ плеере
 * на весь набор, и флаг «назад» от `walk_back`/`run_back` доезжал до страйфов (гистерезис 78–102° держит его на 90°).
 * Сторож гоняет ровно тот случай, что у автора: доворот ВКЛ, один плеер на весь набор в порядке редактора.
 */
describe('clipBake — страйфы кардинальные при любом довороте и порядке', () => {
  const GAIT0 = { ...GAIT };
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
    GAIT.warpOn = 1; GAIT.warpMax = 40;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; Object.assign(GAIT, GAIT0); });

  /** Направление хода клипа от корня (°, atan2(x, z)): куда уезжает опорная (нижняя) стопа — с минусом. */
  const travelDeg = (c: Clip, h: Humanoid): number => {
    let sx = 0, sz = 0, prev: [THREE.Vector3, THREE.Vector3] | null = null, prevLow = -1;
    for (let k = 0; k <= 240; k++) {
      const p = clipPoseAt(c, k / 240);
      h.reset();
      for (const nm in p) { if (nm[0] === '_') continue; const b = h.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); }
      const d = hipsOffset(p, h.hipsRest.y); if (d) h.hips.position.set(h.hipsRest.x + d[0], h.hipsRest.y + d[1], h.hipsRest.z + d[2]);
      h.root.updateMatrixWorld(true);
      const fl = h.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()), fr = h.bones.get('RightFoot')!.getWorldPosition(new THREE.Vector3());
      const low = fl.y <= fr.y ? 0 : 1;
      if (prev && low === prevLow) { const cur = low === 0 ? fl : fr; sx -= cur.x - prev[low]!.x; sz -= cur.z - prev[low]!.z; }
      prev = [fl, fr]; prevLow = low;
    }
    return Math.atan2(sx, sz) * 180 / Math.PI;
  };
  const twistSumDeg = (c: Clip): number => {
    let s = 0;
    for (const k of c.keys) for (const b of ['Spine', 'Chest', 'UpperChest', 'Neck', 'Head']) s += k.pose[b]?.[1] ?? 0;
    return s / Math.max(1, c.keys.length) * 180 / Math.PI;
  };

  it('⭐⭐ один плеер на весь набор (как кнопка редактора), доворот ВКЛ: страйфы ±90° ± 8°, таз 0, скрутки нет', () => {
    // ⚠ Мутации: убрать `resetDirWarp` — ±125° (флаг «назад» доезжает от *_back); убрать перекрытие доворота — ±49°.
    const h = buildHumanoid({});
    const out = bakeGaitSet(mkPlayer(h), h, { character: 'warrior', weapon: 'none' });
    const rig = buildHumanoid({});
    for (const r of out.filter((x) => /_strafe_/.test(x.clip.name))) {
      const want = r.clip.name.endsWith('_R') ? 90 : -90;
      const got = travelDeg(r.clip, rig);
      // 8°: на манекене нижняя стопа даёт ходьбу ±87.9°, бег −85.0° / +85.2° (разброс метода, у рыцаря 88.8–90.5).
      expect(Math.abs(got - want), `${r.clip.name}: ход ${got.toFixed(1)}° вместо ${want}°`).toBeLessThan(8);
      for (const k of r.clip.keys) expect(Math.abs(k.pose['Hips']?.[1] ?? 0), `${r.clip.name}: Hips.y`).toBeLessThan(0.02);
      expect(Math.abs(twistSumDeg(r.clip)), `${r.clip.name}: скрутка Spine..Head`).toBeLessThan(2);
      expect(r.clip.bakeRev, `${r.clip.name}: ревизия запекания`).toBe(LOCO_BAKE_REV);
    }
    expect(getDirWarpOverride(), 'перекрытие доворота снято после съёма').toBe(null);
  });

  it('⭐ порядок запекания не влияет: набор одним плеером ≈ каждый клип свежим плеером (< 3° по костям)', () => {
    // ЗАМЕР (манекен): walk_back / walk_strafe_L/R / run_back / run_strafe_L — 0.000–0.012°, run_strafe_R — 1.88° (ход
    // 85.21° против 84.97°): планировщик за 2 с разогрева не до конца забывает шаг в обратную сторону. С утечкой
    // доворота расхождение — десятки градусов (ход ±126° против ±49°), поэтому порог 3° ловит именно её.
    const h = buildHumanoid({});
    const one = bakeGaitSet(mkPlayer(h), h, { character: 'warrior', weapon: 'none' });
    for (const r of one.filter((x) => /_strafe_|_back/.test(x.clip.name))) {
      const hf = buildHumanoid({});
      const fresh = bakeGaitToClip(mkPlayer(hf), hf, GAIT_PRESETS.find((s) => s.name === r.clip.name)!, { character: 'warrior', weapon: 'none' });
      let worst = 0;
      for (let k = 0; k <= 40; k++) worst = Math.max(worst, maxAngleDeg(clipPoseAt(r.clip, k / 40), clipPoseAt(fresh.clip, k / 40)).deg);
      expect(worst, `${r.clip.name}: набор одним плеером против свежего`).toBeLessThan(3);
    }
  });

  it('⭐ доворот выключен ПЕРЕКРЫТИЕМ: диагональ (вне набора) снимается без скрутки корпуса, ход 45°', () => {
    // На кардинальных пресетах секторный доворот и так 0 — сторож на них мутацию «не перекрывать доворот» не видит.
    // Диагональ видит: без перекрытия таз уходит на 40°, скрутка −40° впекается в корпус, ноги идут под 5° к корню.
    const h = buildHumanoid({});
    const r = bakeGaitToClip(mkPlayer(h), h, { name: 'walk_diag', vx: 0.3, vz: 0.3, yaw: 0 }, { character: 'warrior', weapon: 'none' });
    expect(Math.abs(twistSumDeg(r.clip)), 'скрутка Spine..Head').toBeLessThan(2);
    expect(Math.abs(travelDeg(r.clip, buildHumanoid({})) - 45), 'ход от корня').toBeLessThan(8);
  });

  it('⭐ доворот СБРОШЕН перед съёмом: плеер из живого превью (доворот 40°, медленное сглаживание) снимает чистый клип', () => {
    // ⚠ Мутация «не звать resetDirWarp» валит это: с `warpSmooth` 0.4 за 2 с разогрева остаётся 0.24° — съём падает.
    GAIT.warpSmooth = 0.4;
    const h = buildHumanoid({});
    const p = mkPlayer(h);
    p.setYaw(0); p.setVel(90, 90);
    for (let i = 0; i < 90; i++) p.step(1 / 60);
    expect(Math.abs(p.dirWarpDeg), 'превью действительно довернуло таз').toBeGreaterThan(20);
    const r = bakeGaitToClip(p, h, GAIT_PRESETS.find((s) => s.name === 'walk_strafe_R')!, { character: 'warrior', weapon: 'none' });
    for (const k of r.clip.keys) expect(Math.abs(k.pose['Hips']?.[1] ?? 0)).toBeLessThan(0.02);
  });

  it('⭐ ОДИНОЧНЫЙ СЪЁМ — ТОЖЕ ПРОЦЕДУРКА: при опубликованном `locoMix` 1 клип снимается с ПЛАНИРОВЩИКА, а не с себя', () => {
    // ⚠ Мутация «`bakeGaitToClip` без `procedural`»: у автора `locoMix` 1, плеер уходит в «только клипы», фаза
    // планировщика стоит, фронт цикла не ловится — и съём молча падает на окно 1 с, снятое С САМИХ КЛИПОВ.
    // Признак ровно такой: `cyclic` false и период РОВНО 1.000 у всех режимов.
    const h = buildHumanoid({});
    const p = mkPlayer(h);
    const lib = new Map<string, Clip>();
    for (const r of bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, GAIT_PRESETS.filter((s) => /_strafe_R|_fwd/.test(s.name)))) lib.set(r.clip.name, r.clip);
    // Плеер с библиотекой клипов и долей 1 — то, что стоит у автора.
    const h2 = buildHumanoid({});
    const content = { ...localStorageContent('warrior'), locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } };
    const p2 = new PosePlayer(h2, () => [], content, 'sword', GX, emptyGrid());
    GAIT.locoMix = 1;
    try {
      const r = bakeGaitToClip(p2, h2, GAIT_PRESETS.find((s) => s.name === 'run_strafe_R')!, { character: 'warrior', weapon: 'none' });
      expect(r.cyclic, 'цикл найден по фазе планировщика, а не окном 1 с').toBe(true);
      expect(Math.abs(r.periodSec - 1), `период ${r.periodSec} — ровно 1.000 значит «сняли окно с самих клипов»`).toBeGreaterThan(0.05);
    } finally { GAIT.locoMix = GAIT_BASE.locoMix!; }
  });

  it('⭐ ПОСЛЕ СЪЁМА НАБОРА (вместе с «таз открыт») ПЛЕЕР ЧИСТ: доворот 0, раскрытие 0, перекрытие снято', () => {
    // ⚠ `resetDirWarp` — не гигиена. Мутация «сделать его пустым» оставляет плеер с доворотом ±35° ПОСЛЕ съёма набора
    // «таз открыт», и живое превью «Бега» едет с него: таз 30.1 → 26.0 → 22.3° на первых кадрах после кнопки.
    const h = buildHumanoid({});
    const p = mkPlayer(h);
    bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, [...GAIT_PRESETS, ...openStrafePresets(35, 10)]);
    expect(p.dirWarpDeg, 'доворот плеера после съёма').toBe(0);
    expect(p.dirWarpOpen, 'доля раскрытия после съёма').toBe(0);
    expect(getDirWarpOverride(), 'перекрытие снято').toBe(null);
  });

  it('на кадрах съёма доворот ровно 0 даже с тумблером редактора ВКЛ, а тумблер после съёма не тронут', () => {
    const h = buildHumanoid({});
    const p = mkPlayer(h);
    const seen: number[] = [];
    const step = p.step.bind(p);
    p.step = (dt: number): void => { step(dt); seen.push(Math.abs(p.dirWarpDeg)); };
    bakeGaitToClip(p, h, GAIT_PRESETS.find((s) => s.name === 'run_strafe_R')!, { character: 'warrior', weapon: 'none' });
    expect(seen.length).toBeGreaterThan(60);
    expect(Math.max(...seen)).toBe(0);
    expect(GAIT.warpOn, 'тумблер редактора').toBe(1);
  });
});

/**
 * ⭐ ПЛАНТ-СЕТКА И СИММЕТРИЯ СТРАЙФОВ. Страйфы L / R снимаются по ячейкам 6 / 2, а сетка — данные автора. У воина
 * настроена только ячейка 2 (ходьба: Л [−9, 1.86] / П [5, 1.10]), ячейка 6 пустая. ЗАМЕР (рыцарь, опубликованный
 * конфиг, чистый съём): `walk_strafe_R` — разнос стоп вдоль тела 12.7, мин. зазор голеней 4.9; `walk_strafe_L` —
 * 1.5 и 0.30, голени ближе 3 ед. в 31 % кадров. Правка данных — кнопкой редактора «⇆ в зеркальную», не кодом.
 */
describe('плант-сетка: зеркало ячейки', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  it('зеркало: вправо ↔ влево, вп-вправо ↔ вп-влево, вперёд/назад сами в себя; дважды — исходная ячейка', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(mirrorPlantDir)).toEqual([0, 7, 6, 5, 4, 3, 2, 1]);
    const c = { l: [-9, 1.86] as [number, number], r: [5, 1.1] as [number, number], lVia: [[2, 12]] as [number, number][], rVia: [] };
    expect(mirrorPlantCell(c)).toEqual({ l: [5, -1.1], r: [-9, -1.86], lVia: [], rVia: [[2, -12]] });
    expect(mirrorPlantCell(mirrorPlantCell(c))).toEqual({ ...c, rVia: [] });
    const g = emptyGrid(); g.walk[2] = c;
    expect(plantMirrorGaps(g).map((x) => `${x.speed}:${x.i}-${x.j}`)).toEqual(['walk:2-6']);
    g.walk[6] = mirrorPlantCell(c);
    expect(plantMirrorGaps(g)).toEqual([]);
  });

  it('⭐ настроена одна сторона — страйфы разные; зеркальная ячейка — страйфы зеркальны (разнос стоп вдоль тела)', () => {
    // Меряем средний |z_Л − z_П| (разнос стоп вперёд-назад) на клипе: у зеркальных страйфов он совпадает.
    const sep = (c: Clip, h: Humanoid): number => {
      let s = 0;
      for (let k = 0; k < 120; k++) {
        const p = clipPoseAt(c, k / 120);
        h.reset();
        for (const nm in p) { if (nm[0] === '_') continue; const b = h.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); }
        const d = hipsOffset(p, h.hipsRest.y); if (d) h.hips.position.set(h.hipsRest.x + d[0], h.hipsRest.y + d[1], h.hipsRest.z + d[2]);
        h.root.updateMatrixWorld(true);
        s += Math.abs(h.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()).z - h.bones.get('RightFoot')!.getWorldPosition(new THREE.Vector3()).z);
      }
      return s / 120;
    };
    const bake = (name: string, g: ReturnType<typeof emptyGrid>): number => {
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, g);
      return sep(bakeGaitToClip(p, h, GAIT_PRESETS.find((s) => s.name === name)!, { character: 'warrior', weapon: 'none' }).clip, buildHumanoid({}));
    };
    const g = emptyGrid();
    g.walk[2] = { l: [-9, 1.86], r: [5, 1.1], lVia: [], rVia: [] };
    const oneR = bake('walk_strafe_R', g), oneL = bake('walk_strafe_L', g);
    expect(oneR - oneL, `одна сторона: R ${oneR.toFixed(1)} против L ${oneL.toFixed(1)}`).toBeGreaterThan(5);
    g.walk[6] = mirrorPlantCell(g.walk[2]!);
    const R = bake('walk_strafe_R', g), L = bake('walk_strafe_L', g);
    expect(Math.abs(R - L), `зеркально: R ${R.toFixed(2)} против L ${L.toFixed(2)}`).toBeLessThan(1);
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
