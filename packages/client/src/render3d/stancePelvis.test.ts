import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import {
  PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride, measureStancePlants,
  type PoseContent, type UpperPose, type Pose,
} from './poseRuntime.js';
import { bakeGaitSet, bakeTurnSet, GAIT_PRESETS } from './clipBake.js';
import { clipPoseAt, type Clip } from './clipModel.js';
import { pelvisHeading } from './pelvisFrame.js';
import { GAIT, GAIT_BASE } from './pose.js';

/**
 * ⭐⭐ ТАЗ АВТОРСКОЙ СТОЙКИ В ИГРЕ (`GAIT.stancePelvis`, план §1).
 *
 * До этой правки из авторской стойки в игру приезжала ТОЛЬКО ВЫСОТА таза (`__hipsD.y` → `standY`): `gaitToHumanoid`
 * писал таз жёстко — `(0, 30 + bobY, 0)` и только процедурные наклон/крен. Наклон, крен, рыск и сдвиг по полу,
 * которые автор видит в поз-редакторе, игра выбрасывала целиком.
 *
 * ЧТО СТЕРЕЖЁТСЯ (одиннадцать случаев; у каждого своя мутация, каждая проверена в worktree):
 *  1. стойка ИГРАЕТ: рыск, наклон, крен и сдвиг XZ садятся на таз с весом ручки;
 *  2. ВЫСОТА НЕ УДВАИВАЕТСЯ: `__hipsD.y` на кость не кладётся — она уже приезжает `standY` → `bobY`;
 *  3. ГРУДЬ НА ПРИЦЕЛЕ: рыск таза уходит в отворот Spine..UpperChest (протокол `_open`), а не в курс;
 *  4. БЕГ НЕ ЗАДЕТ: вес = авторитет НОГ стойки, на бегу он ноль — кадр бит в бит с ручкой 0;
 *  5. НЕПРЕРЫВНОСТЬ ПО ЧАСТОТЕ КАДРОВ: вес едет рейт-лимитом (1/с одинаково на 60/120/144), а не ступенькой;
 *  6. ЗАПЕКАНИЕ НЕ НЕСЁТ ТАЗ СТОЙКИ: набор при ручке 1 бит в бит с набором при 0;
 *  7. ПЛАНТЫ МЕРЯЮТСЯ С ТАЗОМ: цели планировщика сходятся с НАРИСОВАННЫМИ стопами;
 *  8. ШОВ ПОВОРОТА НЕ ТРОНУТ: поворот таза за кадр в клипе поворота — тот же, что при ручке 0 (сдвиг едет дугой,
 *     и его шаг пропорционален dt — это геометрия, а не разрыв);
 *  9. `applyHipsTiltHold` ПРОТИВОВЕСИТ ТОЛЬКО ПРОЦЕДУРНЫЙ НАКЛОН: авторский он не трогает (спина и бёдра под ним
 *     уже спозированы автором);
 * 10. РУЧКА 0 — БИТ В БИТ: ни одна кость и ни одна координата таза не шевельнулась;
 * 11. РЫСК НЕ ПРИБАВЛЯЕТСЯ К КУРСУ: он уже в тазе (`pelvisToWorld` его сохраняет) — прибавь, и посчитается дважды.
 *
 * ⚠ ЗАМЕР НА ЖИВЫХ ДАННЫХ (рыцарь `knight_06`, ОПУБЛИКОВАННЫЙ воин), ручка 0 → 1:
 *  • боевая стойка: таз доворачивается на −8.37° и сдвигается на 1.19 u (`__hipsD` = (−1.00, −1.06, 0.65)),
 *    высота 33.801 → 33.801 (Δ = 0.00000), UpperChest съезжает на 0.17°, Chest — на 2.68° (перераспределение отворота);
 *  • на бегу 80 u/с вес 0.00000 и кадр совпадает до 1e−6 — и в клипах, и в процедурке;
 *  • планты против нарисованных стоп: 0.000 / 0.000 (мерили БЕЗ таза — 1.61 / 1.26);
 *  • запекание восьми клипов хода и шести поворотов при ручке 1 — БИТ В БИТ с ручкой 0.
 * ⚠⚠ И ГЛАВНОЕ ЧИСЛО ДЛЯ АВТОРА: у ОПУБЛИКОВАННОГО воина `idleSettle` = 0, то есть стоя ноги НЕ отдаются авторской
 * стойке вовсе (`legMag` = 1 даже смирно) — значит и таз стойки в планировщике получает вес 0, и ручка не покажет
 * НИЧЕГО. Она видна в «только клипы» и при `idleSettle` = 1. Это не дыра, а прямое следствие правила «таз получает
 * ровно ту власть, что уже есть у НОГ стойки»: при `idleSettle` 0 её нет и у ног. Сторож — «вес = авторитет ног».
 */
const GX = { armDown: 1.35, elbowBend: 0.25 };
const D = 180 / Math.PI;
/** Авторская стойка стенда: таз наклонён, накренён, довёрнут и сдвинут — все четыре канала сразу. */
const ST_PITCH = 0.12, ST_ROLL = -0.07, ST_YAW = -0.20, ST_DX = -1.0, ST_DY = -1.06, ST_DZ = 0.65;
const stancePose = (): Pose => ({
  Hips: [ST_PITCH, ST_YAW, ST_ROLL],
  __hipsD: [ST_DX, ST_DY, ST_DZ],
  // Ноги и корпус — чтобы стойка была НАСТОЯЩЕЙ (иначе `blendBone` уходит в чистый гейт, а планты — в фолбэк).
  LeftUpperLeg: [0.02, 0, 0.05], RightUpperLeg: [0.02, 0, -0.05],
  LeftLowerLeg: [0.03, 0, 0], RightLowerLeg: [0.03, 0, 0],
  LeftFoot: [-0.05, 0.1, 0], RightFoot: [-0.05, -0.1, 0],
  Chest: [0, 0, 0], UpperChest: [0, 0, 0], Spine: [0, 0, 0],
  LeftUpperArm: [0.3, 0, -0.6], RightUpperArm: [0.3, 0, 0.6],
});
let lib: Map<string, Clip>;
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
  } as Storage;
  Object.assign(GAIT, GAIT_BASE);
  const h = buildHumanoid({});
  const p = new PosePlayer(h, () => [], content(), 'none', GX, emptyGrid());
  lib = new Map(bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, GAIT_PRESETS).map((r) => [r.clip.name, r.clip]));
  for (const r of bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' })) lib.set(r.clip.name, r.clip);
});
afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
afterEach(() => { setLocoMixOverride(null); Object.assign(GAIT, GAIT_BASE); });

/** Контент стенда: авторская стойка со всеми четырьмя каналами таза + (по просьбе) запечённый набор клипов. */
function content(withClips = false): PoseContent {
  const base = localStorageContent('warrior');
  const up: UpperPose = { swing: 0.45, pose: stancePose() };
  const c: PoseContent = { ...base, resolveUpper: () => up };
  return withClips ? { ...c, locoClip: (names) => { for (const n of names) { const cl = lib.get(n); if (cl) return cl; } return null; } } : c;
}
interface Rig { p: PosePlayer; h: Humanoid }
function mk(knob: number, o: { yawK?: number; clips?: boolean } = {}): Rig {
  GAIT.stancePelvis = knob; GAIT.stancePelvisYaw = o.yawK ?? 1;
  const h = buildHumanoid({});
  return { p: new PosePlayer(h, () => [], content(o.clips), 'none', GX, emptyGrid()), h };
}
function run(r: Rig, vx: number, vz: number, aim: number, n: number, dt = 1 / 60): Rig {
  r.p.setYaw(aim); r.p.snapYaw();
  for (let i = 0; i < n; i++) { r.p.setVel(vx, vz); r.p.setYaw(aim); r.p.step(dt); }
  r.h.root.updateMatrixWorld(true);
  return r;
}
const hips = (r: Rig): THREE.Object3D => r.h.bones.get('Hips')!;
/** Мировой рыск кости (рад): рыск вектора «вперёд». */
const worldYaw = (h: Humanoid, b: string): number => {
  const q = h.bones.get(b)!.getWorldQuaternion(new THREE.Quaternion());
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return Math.atan2(f.x, f.z);
};
/** Курс ТАЗА — только через `pelvisHeading`: на СЛОЖЕННЫХ наклоне и крене голый atan2 «вперёд» уводит
 *  (шапка `pelvisFrame.pelvisHeading`) — у этой стойки на 0.08°. Игра меряет лёгший рыск тем же швом. */
const pelvisYawOf = (h: Humanoid): number => pelvisHeading(h.bones.get('Hips')!.getWorldQuaternion(new THREE.Quaternion()));
/**
 * ШУМ ПОВТОРНОГО ПРОГОНА САМОГО КОНВЕЙЕРА (°). ЗАМЕР НА HEAD, БЕЗ ЭТОЙ ПРАВКИ: два ОДИНАКОВЫХ
 * прогона одного и того же сценария расходятся на 4.8e−6° (голова, 110-й кадр). Поэтому «бит в бит»
 * сверяется ПОРЯДКОМ выше этого пола и всё равно на четыре порядка ниже любой из мутаций (те дают градусы).
 */
const NOISE_DEG = 1e-4;
/**
 * ДОПУСК РЫСКА ТАЗА (°). У стойки со СЛОЖЕННЫМИ наклоном и креном курс композиции НЕ равен слоту Y
 * эйлера — это свойство самого `pelvisHeading` (см. его шапку: наклон 15° + крен 10° → 1.3°). ЗДЕСЬ
 * (наклон 6.9°, крен −4.0°) ЗАМЕР даёт 0.081°. Именно поэтому игра рыск МЕРЯЕТ (`pelvisHeading` до/после),
 * а не считает как `w·Hips[1]`: отворот груди обязан совпасть с ТЕМ УГЛОМ, что реально лёг.
 * На ОПУБЛИКОВАННОЙ стойке воина (чистый рыск, наклона и крена нет) расхождение ровно 0.
 */
const YAW_EPS_DEG = 0.15;
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
/** Слепок ВСЕГО кадра: каждая кость + позиция таза. Им сверяется «бит в бит». */
function frame(h: Humanoid): { q: Map<string, THREE.Quaternion>; p: THREE.Vector3 } {
  const q = new Map<string, THREE.Quaternion>();
  for (const [nm, b] of h.bones) q.set(nm, b.quaternion.clone());
  return { q, p: h.bones.get('Hips')!.position.clone() };
}
function frameGap(a: ReturnType<typeof frame>, b: ReturnType<typeof frame>): { deg: number; bone: string; pos: number } {
  let deg = 0, bone = '';
  for (const [nm, qa] of a.q) { const qb = b.q.get(nm); if (!qb) continue; const d = qa.angleTo(qb) * D; if (d > deg) { deg = d; bone = nm; } }
  return { deg, bone, pos: a.p.distanceTo(b.p) };
}

describe('таз авторской стойки: игра', () => {
  it('1. ⭐⭐ СТОЙКА ИГРАЕТ: рыск, наклон, крен и сдвиг XZ садятся на таз (ручка 1)', () => {
    const a = run(mk(0), 0, 0, 0, 240), b = run(mk(1), 0, 0, 0, 240);
    // Рыск — мировой (курс 0), наклон/крен — локальные оси таза в кадре персонажа.
    expect(pelvisYawOf(a.h) * D, 'ручка 0: таз ровно на курсе').toBeCloseTo(0, 3);
    expect(Math.abs(pelvisYawOf(b.h) - ST_YAW) * D, 'ручка 1: таз довёрнут на авторский рыск').toBeLessThan(YAW_EPS_DEG);
    const eb = new THREE.Euler().setFromQuaternion(hips(b).quaternion, 'XYZ');
    expect(eb.x, 'наклон').toBeCloseTo(ST_PITCH, 3);
    expect(eb.z, 'крен').toBeCloseTo(ST_ROLL, 3);
    expect(hips(b).position.x - hips(a).position.x, 'сдвиг X').toBeCloseTo(ST_DX, 3);
    expect(hips(b).position.z - hips(a).position.z, 'сдвиг Z').toBeCloseTo(ST_DZ, 3);
    expect(b.p.stancePelvisW, 'вес стоя').toBeCloseTo(1, 3);
    expect(b.p.stancePelvisYaw, 'плеер отдаёт РОВНО тот рыск, что лёг на кость').toBeCloseTo(pelvisYawOf(b.h), 9);
    // …и ДОЛЯМИ: вес линейно ведёт и рыск, и сдвиг.
    for (const k of [0.25, 0.5, 0.75]) {
      const r = run(mk(k), 0, 0, 0, 240);
      expect(Math.abs(pelvisYawOf(r.h) - ST_YAW * k) * D, `доля ${k}: рыск`).toBeLessThan(YAW_EPS_DEG);
      expect(Math.hypot(r.h.bones.get('Hips')!.position.x - hips(a).position.x, r.h.bones.get('Hips')!.position.z - hips(a).position.z), `доля ${k}: сдвиг`)
        .toBeCloseTo(Math.hypot(ST_DX, ST_DZ) * k, 2);
    }
    // Отдельная доля рыска: сдвиг остаётся, рыск гаснет.
    // ⭐ СДВИГ — В КАДРЕ ПЕРСОНАЖА: на курсе он поворачивается вместе с телом (`pelvisToWorld` крутит X/Z таза).
    // ⚠ Мутация «сдвиг в мировых осях» (положить его ПОСЛЕ `applyTorsoTwist`) оставляет его на месте — ловится здесь.
    for (const aim of [37, 90, -120]) {
      const r0 = run(mk(0), 0, 0, aim / D, 240), r1 = run(mk(1), 0, 0, aim / D, 240);
      const dx = r1.h.bones.get('Hips')!.position.x - r0.h.bones.get('Hips')!.position.x;
      const dz = r1.h.bones.get('Hips')!.position.z - r0.h.bones.get('Hips')!.position.z;
      const c = Math.cos(aim / D), sn = Math.sin(aim / D);
      expect(dx, `курс ${aim}°: X сдвига`).toBeCloseTo(ST_DX * c + ST_DZ * sn, 3);
      expect(dz, `курс ${aim}°: Z сдвига`).toBeCloseTo(ST_DZ * c - ST_DX * sn, 3);
    }
    const y0 = run(mk(1, { yawK: 0 }), 0, 0, 0, 240);
    expect(pelvisYawOf(y0.h) * D, 'stancePelvisYaw 0: рыска нет').toBeCloseTo(0, 2);
    expect(hips(y0).position.x - hips(a).position.x, 'stancePelvisYaw 0: сдвиг на месте').toBeCloseTo(ST_DX, 3);
  });

  it('2. ⭐⭐ ВЫСОТА НЕ УДВАИВАЕТСЯ: `__hipsD.y` на кость не кладётся (она уже в standY)', () => {
    // КАНАЛ Y ИЗОЛИРОВАН: стойка, у которой из таза есть ТОЛЬКО высота — ни поворота, ни сдвига по полу.
    // Тогда разница высоты между ручками 0 и 1 может быть только от повторного учёта `__hipsD.y`.
    // ⚠ Мутация «Y тоже на кость» даёт ровно −1.06 — авторский офсет, посчитанный второй раз.
    const onlyY: Pose = { ...stancePose(), Hips: [0, 0, 0], __hipsD: [0, ST_DY, 0] };
    const mkY = (knob: number, clips: boolean): Rig => {
      GAIT.stancePelvis = knob; GAIT.stancePelvisYaw = 1;
      const hh = buildHumanoid({});
      const base = localStorageContent('warrior');
      const c: PoseContent = { ...base, resolveUpper: () => ({ swing: 0.45, pose: onlyY }),
        locoClip: clips ? (names) => { for (const n of names) { const cl = lib.get(n); if (cl) return cl; } return null; } : base.locoClip };
      return { p: new PosePlayer(hh, () => [], c, 'none', GX, emptyGrid()), h: hh };
    };
    for (const clips of [false, true]) {
      setLocoMixOverride(clips ? 1 : 0);
      const a = run(mkY(0, clips), 0, 0, 0, 240), b = run(mkY(1, clips), 0, 0, 0, 240);
      expect(b.p.stancePelvisW, `${clips ? 'только клипы' : 'планировщик'}: таз стойки включён`).toBeCloseTo(1, 3);
      expect(hips(b).position.y - hips(a).position.y, `${clips ? 'только клипы' : 'планировщик'}: высота таза`).toBeCloseTo(0, 6);
      setLocoMixOverride(null);
    }
    // …и высота ВСЁ РАВНО авторская: `standY` берёт её из той же `__hipsD.y` при ЛЮБОЙ ручке.
    const h = buildHumanoid({});
    expect(measureStancePlants(h, stancePose(), 0).standY, 'standY = rest + __hipsD.y').toBeCloseTo(h.hipsRest.y + ST_DY, 6);
    expect(measureStancePlants(h, stancePose(), 1).standY, 'вес таза на standY не влияет').toBeCloseTo(h.hipsRest.y + ST_DY, 6);
  });

  it('3. ⭐⭐ ГРУДЬ НА ПРИЦЕЛЕ: рыск таза уходит в отворот Spine..UpperChest, а не в курс', () => {
    // ⚠ Мутация «рыск не вычли из бюджета скрутки» (или «не отдали в отворот») уводит UpperChest на весь авторский
    // угол — 11.5°. Здесь он остаётся на месте с точностью долей градуса: ровно как у раскрытия `_open`.
    for (const aim of [0, 30, 90, 137, -100]) {
      const a = run(mk(0), 0, 0, aim / D, 240), b = run(mk(1), 0, 0, aim / D, 240);
      const dU = wrapPi(worldYaw(b.h, 'UpperChest') - worldYaw(a.h, 'UpperChest')) * D;
      expect(Math.abs(dU), `прицел ${aim}°: UpperChest сдвинулся на ${dU.toFixed(2)}°`).toBeLessThan(0.5);
      // …а сам таз — ровно на авторский рыск ОТНОСИТЕЛЬНО ПРИЦЕЛА, на любом курсе.
      expect(Math.abs(wrapPi(pelvisYawOf(b.h) - aim / D) - ST_YAW) * D, `прицел ${aim}°: таз`).toBeLessThan(YAW_EPS_DEG);
    }
  });

  it('4. ⭐⭐ ВЕС = АВТОРИТЕТ НОГ СТОЙКИ: на бегу его нет, и кадр бит в бит с ручкой 0', () => {
    for (const [nm, vx, vz, mix] of [['бег вперёд (клипы)', 0, 80, 1], ['бег вперёд (процедурка)', 0, 80, 0], ['ход вбок (клипы)', 40, 0, 1]] as const) {
      setLocoMixOverride(mix);
      const a = run(mk(0, { clips: true }), vx, vz, 0, 300), b = run(mk(1, { clips: true }), vx, vz, 0, 300);
      expect(b.p.stancePelvisW, `${nm}: вес`).toBeLessThan(1e-3);
      const g = frameGap(frame(a.h), frame(b.h));
      expect(g.deg, `${nm}: худшая кость ${g.bone}`).toBeLessThan(NOISE_DEG);
      expect(g.pos, `${nm}: позиция таза`).toBeLessThan(1e-6);
      setLocoMixOverride(null);
    }
    // …и ГЛАВНОЕ СЛЕДСТВИЕ ПРАВИЛА: `idleSettle` 0 (ноги стойке не отдаются вовсе) → таза стойки нет и стоя.
    GAIT.idleSettle = 0;
    expect(run(mk(1), 0, 0, 0, 240).p.stancePelvisW, 'idleSettle 0: ноги у планировщика, значит и таз').toBeLessThan(1e-3);
    GAIT.idleSettle = 1;
    expect(run(mk(1), 0, 0, 0, 240).p.stancePelvisW, 'idleSettle 1: ноги стойки → таз стойки').toBeCloseTo(1, 3);
  });

  it('5. ⭐ НЕПРЕРЫВНОСТЬ ПО ЧАСТОТЕ КАДРОВ: вес едет рейт-лимитом, одинаковым на 60 / 120 / 144', () => {
    // ⚠ Мутация «жёсткие ворота» (`legMag < 0.5 ? 1 : 0`) даёт Δвеса 1.0 за кадр на любой частоте — ступеньку,
    // которую кинематический таз физ-куклы отыгрывает рывком (ради этого был `9c1bb6b`).
    const rates: number[] = [];
    for (const hz of [60, 120, 144]) {
      setLocoMixOverride(1);
      const r = mk(1, { clips: true }); const dt = 1 / hz;
      r.p.setYaw(0); r.p.snapYaw();
      let maxW = 0, prevW = -1, maxP = 0, prevP: THREE.Vector3 | null = null;
      for (let i = 0; i < 4 * hz; i++) {
        const t = i * dt;
        const v = t < 1 ? 0 : t < 2.5 ? Math.min(80, (t - 1) * 320) : Math.max(0, 80 - (t - 2.5) * 320);
        r.p.setVel(0, v); r.p.setYaw(0); r.p.step(dt);
        if (prevW >= 0) maxW = Math.max(maxW, Math.abs(r.p.stancePelvisW - prevW));
        prevW = r.p.stancePelvisW;
        const pp = hips(r).position;
        if (prevP && i > 2) maxP = Math.max(maxP, pp.distanceTo(prevP));
        prevP = pp.clone();
      }
      rates.push(maxW * hz);
      expect(maxP * hz, `${hz} Гц: скорость таза, ед/с`).toBeLessThan(25);
      setLocoMixOverride(null);
    }
    // Скорость веса В СЕКУНДУ — одна и та же: порог задан ВРЕМЕНЕМ (`LOCO_FADE`), а не кадром.
    for (const r of rates) expect(r, `скорость веса ${rates.map((v) => v.toFixed(2)).join(' / ')} 1/с`).toBeCloseTo(rates[0]!, 1);
  });

  it('6. ⭐⭐ ЗАПЕКАНИЕ НЕ НЕСЁТ ТАЗ СТОЙКИ: набор при ручке 1 — БИТ В БИТ с набором при 0', () => {
    // ⚠ Мутация «не подавили при запекании» (`setStancePelvisOverride(0)` убран из `procedural`) впекает таз стойки
    // в клип, и при проигрывании он ложится ВТОРОЙ раз.
    const bake = (knob: number): Map<string, Clip> => {
      Object.assign(GAIT, GAIT_BASE); GAIT.stancePelvis = knob; GAIT.stancePelvisYaw = 1;
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], content(), 'none', GX, emptyGrid());
      const m = new Map(bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, GAIT_PRESETS).map((r) => [r.clip.name, r.clip]));
      for (const r of bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' })) m.set(r.clip.name, r.clip);
      return m;
    };
    const l0 = bake(0), l1 = bake(1);
    let worst = 0, worstAt = '';
    for (const [n, c0] of l0) {
      const c1 = l1.get(n); expect(c1, n).toBeTruthy();
      for (let i = 0; i <= 32; i++) {
        const u = i / 32, p0 = clipPoseAt(c0, u), p1 = clipPoseAt(c1!, u);
        for (const k of Object.keys(p0)) {
          const x = p0[k]!, y = p1[k]; if (!y) continue;
          const d = Math.max(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2]));
          if (d > worst) { worst = d; worstAt = `${n}/${k}`; }
        }
      }
    }
    expect(worst, `худшее расхождение ключа ${worstAt}`).toBeLessThan(1e-12);
  });

  it('7. ⭐⭐ ПЛАНТЫ МЕРЯЮТСЯ С ТАЗОМ: цели планировщика сходятся с НАРИСОВАННЫМИ стопами', () => {
    // ⚠ Мутация «планты меряем без таза» (вес 0 в `measureStance`) разводит цели и стопы ровно на авторский поворот.
    // ⚠ МЕРИМ ЦЕЛИ САМОГО ПЛАНИРОВЩИКА (`driver.plantTarget`), а не повторный вызов замера: иначе сторож проверял бы
    // сам замер, а не то, что `PosePlayer.measureStance` отдаёт планировщику ТУ ЖЕ долю, что кладёт на таз.
    const r = run(mk(1), 0, 0, 0, 300);
    const hp = hips(r).getWorldPosition(new THREE.Vector3());
    const foot = (nm: string): THREE.Vector3 => r.h.bones.get(nm)!.getWorldPosition(new THREE.Vector3());
    const tgt = (i: 0 | 1): [number, number] => { const t = r.p.driver.plantTarget(i); return [t[0] - r.p.posX, t[1] - r.p.posZ]; };
    const gap = (nm: string, i: 0 | 1): number => { const f = foot(nm), t = tgt(i); return Math.hypot(f.x - hp.x - t[0], f.z - hp.z - t[1]); };
    const gapL = gap('LeftFoot', 0), gapR = gap('RightFoot', 1);
    // …и то же при ручке 0 — там и цели, и стопы без авторского таза, расхождения тоже нет.
    const r0 = run(mk(0), 0, 0, 0, 300);
    const hp0 = hips(r0).getWorldPosition(new THREE.Vector3());
    const f0 = r0.h.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3());
    const t0 = r0.p.driver.plantTarget(0);
    const base = Math.hypot(f0.x - hp0.x - (t0[0] - r0.p.posX), f0.z - hp0.z - (t0[1] - r0.p.posZ));
    expect(base, 'ручка 0: цели и стопы сходятся (контроль стенда)').toBeLessThan(0.05);
    expect(gapL, `Л: цель планировщика против нарисованной стопы ${gapL.toFixed(3)}`).toBeLessThan(0.05);
    expect(gapR, `П: ${gapR.toFixed(3)}`).toBeLessThan(0.05);
    const p1 = measureStancePlants(buildHumanoid({}), stancePose(), 1), p0 = measureStancePlants(buildHumanoid({}), stancePose(), 0);
    expect(Math.hypot(p1.latL - p0.latL, p1.fwdL - p0.fwdL), 'без таза планты были бы заметно другими').toBeGreaterThan(0.3);
    // ⚠ СДВИГ В ПЛАНТЫ НЕ ИДЁТ — он сокращается: стопы дети таза. Мерим ТОЛЬКО поворот.
    const noMove = measureStancePlants(buildHumanoid({}), { ...stancePose(), __hipsD: [ST_DX + 7, ST_DY, ST_DZ - 5] }, 1);
    expect(noMove.latL, 'сдвиг таза плант не двигает').toBeCloseTo(p1.latL, 6);
    expect(noMove.fwdR, 'сдвиг таза плант не двигает').toBeCloseTo(p1.fwdR, 6);
  });

  it('8. ⭐ ШОВ ПОВОРОТА НЕ ТРОНУТ: поворот таза за кадр тот же, сдвиг едет ДУГОЙ (шаг ∝ dt)', () => {
    // ⚠ Мутация «слерп к авторскому тазу вместо композиции» разбавляет поворот клипа — поворот за кадр уезжает.
    const turn = (knob: number, hz: number): { rot: number; pos: number } => {
      setLocoMixOverride(1);
      const r = mk(knob, { clips: true });
      r.p.setYaw(0); r.p.snapYaw();
      for (let i = 0; i < hz; i++) { r.p.setVel(0, 0); r.p.setYaw(0); r.p.step(1 / hz); }
      let rot = 0, pos = 0; let pq: THREE.Quaternion | null = null, pp: THREE.Vector3 | null = null;
      for (let i = 0; i < 3 * hz; i++) {
        r.p.setVel(0, 0); r.p.setYaw(90 / D); r.p.step(1 / hz);
        const hb = hips(r);
        if (pq && pp) { rot = Math.max(rot, hb.quaternion.angleTo(pq) * D); pos = Math.max(pos, hb.position.distanceTo(pp)); }
        pq = hb.quaternion.clone(); pp = hb.position.clone();
      }
      setLocoMixOverride(null);
      return { rot, pos };
    };
    const a60 = turn(0, 60), b60 = turn(1, 60), b120 = turn(1, 120);
    expect(b60.rot, `поворот таза за кадр: ${b60.rot.toFixed(3)}° против ${a60.rot.toFixed(3)}°`).toBeCloseTo(a60.rot, 6);
    // Сдвиг: таз стоит в стороне от оси, и разворот проводит его по ДУГЕ радиусом |__hipsD| — шаг вдвое меньше на
    // вдвое большей частоте. Это геометрия, а не разрыв: ЗАМЕР на опубликованном воине 0.104 / 0.052 / 0.043
    // (60 / 120 / 144) против 0.310 — шага таза, который физика и так получает на бегу.
    expect(b60.pos, `дуга: ${b60.pos.toFixed(4)} против ${a60.pos.toFixed(4)} при ручке 0`).toBeGreaterThan(a60.pos * 1.5);
    expect(b120.pos, `дуга: ${b60.pos.toFixed(4)} на 60 Гц против ${b120.pos.toFixed(4)} на 120`).toBeCloseTo(b60.pos / 2, 2);
  });

  it('9. ⭐ `applyHipsTiltHold` ПРОТИВОВЕСИТ ТОЛЬКО ПРОЦЕДУРНЫЙ НАКЛОН: авторский он не трогает', () => {
    // ⚠ Мутация «удержанию отдали СУММАРНЫЙ угол» гнёт спину и бёдра под авторский наклон — а автор уже спозировал
    // их под ним. Здесь наклон/крен Spine и бёдер обязаны быть теми же, что при ручке 0.
    // ⚠ РЕЖИМ «ТОЛЬКО КЛИПЫ» НАРОЧНО: в планировщике ноги ведёт он сам, и повёрнутый таз двигает
    // планты → бёдра честно меняются (ЗАМЕР: 1.2e−4°), и сторож мерял бы не удержание, а реакцию планировщика.
    // В «только клипы» стоя ноги — чистая авторская стойка, и любое шевеление бёдер — это удержание.
    setLocoMixOverride(1);
    const a = run(mk(0, { clips: true }), 0, 0, 0, 240), b = run(mk(1, { clips: true }), 0, 0, 0, 240);
    expect(b.p.stancePelvisW, 'таз стойки включён').toBeCloseTo(1, 3);
    for (const nm of ['Spine', 'LeftUpperLeg', 'RightUpperLeg']) {
      const ea = new THREE.Euler().setFromQuaternion(a.h.bones.get(nm)!.quaternion, 'XYZ');
      const eb = new THREE.Euler().setFromQuaternion(b.h.bones.get(nm)!.quaternion, 'XYZ');
      expect(Math.abs(eb.x - ea.x) * D, `${nm}: наклон`).toBeLessThan(NOISE_DEG);
      expect(Math.abs(eb.z - ea.z) * D, `${nm}: крен`).toBeLessThan(NOISE_DEG);
    }
    setLocoMixOverride(null);
  });

  it('10. ⭐⭐ РУЧКА 0 — БИТ В БИТ: ни одна кость и ни одна координата таза не шевельнулись', () => {
    // ⚠ СВЕРЯЕМ НЕ «ДВА ОДИНАКОВЫХ ПРОГОНА» (они совпали бы и у сломанного кода), А ДВЕ СТОЙКИ: с авторским тазом и
    // с ОБНУЛЁННЫМИ его каналами (высота `__hipsD.y` — та же, иначе уехал бы `standY`). При ручке 0 игра не имеет права
    // прочитать ни рыск, ни наклон, ни сдвиг — значит кадры обязаны совпасть.
    // Сценарий со всем сразу: стоим → бежим → страйф → разворот на месте, в обоих режимах.
    const flat: Pose = { ...stancePose(), Hips: [0, 0, 0], __hipsD: [0, ST_DY, 0] };
    for (const mix of [0, 1]) {
      setLocoMixOverride(mix);
      const go = (pose: Pose): ReturnType<typeof frame>[] => {
        GAIT.stancePelvis = 0; GAIT.stancePelvisYaw = 1;
        const hh = buildHumanoid({});
        const bs = localStorageContent('warrior');
        const c: PoseContent = { ...bs, resolveUpper: () => ({ swing: 0.45, pose }),
          locoClip: (names) => { for (const n of names) { const cl = lib.get(n); if (cl) return cl; } return null; } };
        const r: Rig = { p: new PosePlayer(hh, () => [], c, 'none', GX, emptyGrid()), h: hh };
        r.p.setYaw(0); r.p.snapYaw();
        const out: ReturnType<typeof frame>[] = [];
        for (let i = 0; i < 360; i++) {
          const t = i / 60;
          const vz = t < 1 ? 0 : t < 3 ? 80 : 0, vx = t >= 3 && t < 4.5 ? 60 : 0;
          r.p.setVel(vx, vz); r.p.setYaw(t > 4.5 ? 90 / D : 0); r.p.step(1 / 60);
          out.push(frame(r.h));
        }
        return out;
      };
      const A = go(stancePose());
      GAIT.stancePelvisYaw = 0.37;   // вторая ручка при выключенной первой не смеет ничего менять
      const B = go(flat);
      for (let i = 0; i < A.length; i++) {
        const g = frameGap(A[i]!, B[i]!);
        expect(g.deg, `доля ${mix}, кадр ${i}: ${g.bone}`).toBeLessThan(NOISE_DEG);
        expect(g.pos, `доля ${mix}, кадр ${i}: таз`).toBeLessThan(1e-6);
      }
      setLocoMixOverride(null);
    }
  });

  it('11. ⭐⭐ РЫСК НЕ ПРИБАВЛЯЕТСЯ К КУРСУ: он уже в тазе, иначе посчитается дважды', () => {
    // ⚠ Мутация «прибавили к курсу» (`yaw = rootYaw + warp + legsOpen + stanceYaw`) даёт ДВОЙНОЙ угол.
    const b = run(mk(1), 0, 0, 0, 240);
    expect(Math.abs(pelvisYawOf(b.h) - ST_YAW) * D, 'мировой рыск таза = авторский, а НЕ его двойная доля').toBeLessThan(YAW_EPS_DEG);
    expect(b.p.pelvisYaw, 'приложенный курс рыска стойки НЕ несёт (его вычитает запекатель)').toBeCloseTo(0, 6);
    expect(Math.abs(b.p.pelvisYawWorld - ST_YAW) * D, 'мировой рыск — несёт').toBeLessThan(YAW_EPS_DEG);
    expect(pelvisYawOf(b.h), 'и он совпадает с тем, что видно на скелете').toBeCloseTo(b.p.pelvisYawWorld, 9);
  });
});
