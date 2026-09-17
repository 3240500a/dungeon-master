import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { pelvisToWorld, pelvisPoseToWorld, pelvisPoseToChar, pelvisHeading } from './pelvisFrame.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride } from './poseRuntime.js';
import { GAIT, GAIT_BASE, POSE, POSE_BASE } from './pose.js';
import { bakeGaitSet, defaultReadPose, neutralizeFacing, GAIT_PRESETS } from './clipBake.js';
import { poseRig } from './frameEdit.js';
import { hipsOffset, setHipsOffset, type Clip, type Pose } from './clipModel.js';

/**
 * ⭐⭐ ТАЗ: КАДР ПЕРСОНАЖА ↔ МИР (ревью 17.09, `pelvisFrame.ts`).
 *
 * Игра писала курс в слот Y эйлера таза (`Hips.rotation.y = курс`): наклон таза оставался в мировой оси X, свой рыск таза
 * клипа выпадал, X/Z таза не поворачивались с телом — таз В КАДРЕ ПЕРСОНАЖА зависел от того, куда персонаж смотрит.
 * Здесь: (1) сама композиция против матриц three и её точный обратный ход; (2) настоящий `PosePlayer` на курсах 0 / 90 /
 * 180 / −90 — таз, грудь, бедро и стопа в кадре персонажа от курса НЕ зависят (клипы бега с наклоном и сдвигом таза,
 * смешанный режим, процедурный наклон, удар на наклонённой базе); (3) вычет фейсинга запекателя — обратное игре на живом
 * плеере с наклоном и доворотом. Сторож «игра = шарнир редактора» на поворотах — `rootPreview.test.ts`.
 */
const D = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const yawQ = (a: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(UP, a);
/** Угол в градусах, свёрнутый в (−180°, 180°]. */
const wrapDeg = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;

describe('композиция таза — против матриц three', () => {
  const POSES: [number, number, number][] = [[0, 0, 0], [0, 0.3, -0.2], [0.26, 0, 0], [0.26, 0.17, 0.17], [-0.4, 1.2, 2.9], [1.4, -0.3, 0.05]];
  const YAWS = [0, 0.4, Math.PI / 2, Math.PI, -2.3, 3.7, -7];

  it('⭐ кость: `pelvisToWorld` = таз кадра персонажа под родителем `Ry(yaw)` (поворот и X/Z; Y не трогается)', () => {
    for (const e of POSES) for (const yaw of YAWS) {
      const h = new THREE.Object3D(); h.rotation.set(e[0], e[1], e[2]); h.position.set(2.5, 33, -1.25);
      const parent = new THREE.Object3D(); parent.quaternion.copy(yawQ(yaw));
      const ref = new THREE.Object3D(); ref.rotation.set(e[0], e[1], e[2]); ref.position.copy(h.position); parent.add(ref); parent.updateMatrixWorld(true);
      pelvisToWorld(h, yaw);
      const msg = `эйлер ${e.join(',')} курс ${yaw}`;
      expect(h.quaternion.angleTo(ref.getWorldQuaternion(new THREE.Quaternion())), msg).toBeLessThan(1e-7);
      expect(h.position.distanceTo(ref.getWorldPosition(new THREE.Vector3())), msg).toBeLessThan(1e-9);
      expect(h.rotation.order).toBe('XYZ');
    }
  });

  it('быстрый путь без наклона — ТОЧНО прежнее `rotation.y = курс` там, где своего рыска нет (бит в бит)', () => {
    for (const roll of [0, 0.2, -1.1]) for (const yaw of YAWS) {
      const a = new THREE.Object3D(), b = new THREE.Object3D();
      a.rotation.set(0, 0, roll); b.rotation.set(0, 0, roll);
      a.rotation.y = yaw;                                        // как было в `applyTorsoTwist`
      pelvisToWorld(b, yaw);
      expect([b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]).toEqual([a.quaternion.x, a.quaternion.y, a.quaternion.z, a.quaternion.w]);
      expect(b.position.toArray()).toEqual([0, 0, 0]);          // ноль не крутим: без −0
    }
  });

  it('контроль: слот Y эйлера (как было) с наклоном таза — мимо на удвоенный наклон при развороте', () => {
    const a = new THREE.Object3D(), b = new THREE.Object3D();
    a.rotation.set(15 * D, 0, 0); b.rotation.set(15 * D, 0, 0);
    a.rotation.y = Math.PI; pelvisToWorld(b, Math.PI);
    expect(a.quaternion.angleTo(b.quaternion) / D).toBeCloseTo(30, 6);
  });

  it('поза: `pelvisPoseToWorld` = кость; `pelvisPoseToChar` — точный обратный ход (эйлер, `__hipsD`, рест X/Z ≠ 0)', () => {
    const rest = new THREE.Vector3(1.5, 32, -0.7);
    for (const e of POSES) for (const yaw of YAWS) {
      const p: Pose = { Hips: [...e], LeftUpperLeg: [0.3, 0, 0], __hipsD: [2, -1.5, 0.75] };
      const w = pelvisPoseToWorld(structuredClone(p), yaw, rest);
      const bone = new THREE.Object3D(); bone.rotation.set(e[0], e[1], e[2]); bone.position.set(rest.x + 2, rest.y - 1.5, rest.z + 0.75);
      pelvisToWorld(bone, yaw);
      const wh = w['Hips']!, wd = hipsOffset(w, rest.y)!;
      const msg = `эйлер ${e.join(',')} курс ${yaw}`;
      expect(new THREE.Quaternion().setFromEuler(new THREE.Euler(wh[0], wh[1], wh[2])).angleTo(bone.quaternion), msg).toBeLessThan(1e-7);
      expect(Math.hypot(rest.x + wd[0] - bone.position.x, rest.z + wd[2] - bone.position.z), msg).toBeLessThan(1e-9);
      expect(wd[1], 'Y сдвига не крутится').toBe(-1.5);
      expect(w['LeftUpperLeg'], 'кости, кроме таза, не трогаются').toEqual([0.3, 0, 0]);
      const back = pelvisPoseToChar(w, yaw, rest), bh = back['Hips']!, bd = hipsOffset(back, rest.y)!;
      expect(new THREE.Quaternion().setFromEuler(new THREE.Euler(bh[0], bh[1], bh[2])).angleTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2]))), msg).toBeLessThan(1e-7);
      expect(Math.hypot(bd[0] - 2, bd[2] - 0.75), msg).toBeLessThan(1e-9);
    }
    const none: Pose = { Spine: [0.1, 0, 0] };
    expect(pelvisPoseToWorld(none, 1.2, new THREE.Vector3(0, 32, 0))).toEqual({ Spine: [0.1, 0, 0] });   // каналов таза нет — крутить нечего
  });

  it('курс таза — по вектору «вперёд»: точно на наклоне и крене, за ±90° не отражается (слот Y эйлера — отражается)', () => {
    for (const a of [0, 30, 89, 91, 135, 170, 180, -100, -179]) for (const [b, c] of [[0, 0], [15, 0], [-25, 10], [40, -30]] as const) {
      const q = yawQ(a * D).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(b * D, 0, c * D)));
      const h = pelvisHeading(q) / D;
      expect(Math.abs(((h - a + 540) % 360) - 180), `курс ${a}°, наклон ${b}°, крен ${c}°`).toBeLessThan(1e-9);
    }
    const e = new THREE.Euler().setFromQuaternion(yawQ(170 * D).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(15 * D, 0, 0))));
    expect(Math.abs(e.y / D), 'контроль: слот Y разбора XYZ держит [−90°, 90°]').toBeLessThan(90);
  });

  /**
   * ⚠ ТАЗ ПРОХОДИТ ВЕРТИКАЛЬ (нокдаун, подъём): голый `atan2` вектора «вперёд» отражал курс на 180° НАВСЕГДА, и
   * накопитель `clipBaker` принимал это за разворот. Сторож на САМ курс: `Ry(курс)·таз` мировую позу держит и с
   * отражением (180° уходят в кость таза), поэтому проверка мировой позы эту беду НЕ ЛОВИТ — нужна эта.
   */
  it('⭐ падение ничком/навзничь: курс держится на наклоне за ±90° (голый `atan2` отражал его на 180°)', () => {
    const tilt = (p: number, r = 0): THREE.Quaternion => new THREE.Quaternion().setFromEuler(new THREE.Euler(p * D, 0, r * D));
    let flips = 0;
    for (const a of [0, 20, 90, -100, 170]) for (let p = -180; p <= 180; p += 1) {
      const q = yawQ(a * D).multiply(tilt(p));
      expect(Math.abs(wrapDeg(pelvisHeading(q) / D - a)), `курс ${a}°, наклон ${p}°`).toBeLessThan(1e-6);
      const naked = new THREE.Vector3(0, 0, 1).applyQuaternion(q);            // контроль: как читалось до правки
      if (Math.abs(wrapDeg(Math.atan2(naked.x, naked.z) / D - a)) > 90) flips++;
    }
    expect(flips, 'контроль: голому `atan2` тут есть на чём отражаться').toBeGreaterThan(300);

    // НЕПРЕРЫВНОСТЬ: полный переворот таза 0 → 360° при каждом крене — курс идёт шагами, а не скачком на 180°.
    // Вверх ногами (наклон 120°…240°) курс таза — уже не «куда смотрит», а условность, и там шаг допускаем крупнее.
    for (const r of [0, 5, 15, 25, 45, 60, 89, -30, 120]) {
      let worst = 0, at = 0, worstUp = 0, atUp = 0, prev = pelvisHeading(yawQ(20 * D).multiply(tilt(0, r))) / D;
      for (let p = 0.25; p <= 360; p += 0.25) {
        const h = pelvisHeading(yawQ(20 * D).multiply(tilt(p, r))) / D, step = Math.abs(wrapDeg(h - prev));
        if (step > worst) { worst = step; at = p; }
        if (step > worstUp && (p < 120 || p > 240)) { worstUp = step; atUp = p; }
        prev = h;
      }
      expect(worstUp, `крен ${r}°: худший шаг курса на наклоне ${atUp}° (таз не перевёрнут)`).toBeLessThan(3);
      expect(worst, `крен ${r}°: худший шаг курса на наклоне ${at}°`).toBeLessThan(12);
    }
  });
});

// ── Настоящий `PosePlayer`: таз в кадре персонажа от курса не зависит ────────────────────────────────

const GX = { armDown: 1.35, elbowBend: 0.25 };
const DT = 1 / 60;
/** Доворот таза под движение и качание таза вбок — по умолчанию выключены, а без них сторожить нечего (X/Z и курс ≠ прицел). */
const WARP: Partial<typeof GAIT> = { warpOn: 1, warpMax: 50 };
const SWAY: Partial<typeof POSE> = { hipSway: 1.5, hipSwayRun: 1.5 };
const setCfg = (gait: Partial<typeof GAIT> = {}, pose: Partial<typeof POSE> = {}): void => { Object.assign(GAIT, GAIT_BASE, gait); Object.assign(POSE, POSE_BASE, pose); };
let libMemo: Clip[] | null = null;
/** Ходьба вперёд и боком (доворот таза, качание), запечённые с процедурки этого же рига. */
function bakedLoco(): Clip[] {
  if (!libMemo) {
    setCfg(WARP, SWAY);
    const h = buildHumanoid({}), p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    libMemo = bakeGaitSet(p, h, { character: 'warrior', weapon: 'none' }, GAIT_PRESETS.filter((s) => s.name === 'walk_fwd' || s.name === 'walk_strafe_R')).map((r) => r.clip);
  }
  return libMemo;
}
/** Правка таза автора на ВСЕХ ключах: прибавка к эйлеру и сдвиг по X/Z (кадр персонажа). */
const editHips = (clips: Clip[], dh: readonly [number, number, number], dx: number, dz: number): Clip[] => clips.map((c) => ({ ...c, keys: c.keys.map((k) => {
  const pose = structuredClone(k.pose), h = pose['Hips'] ?? [0, 0, 0];
  pose['Hips'] = [h[0] + dh[0], h[1] + dh[1], h[2] + dh[2]];
  const d = hipsOffset(pose) ?? [0, 0, 0]; setHipsOffset(pose, [d[0] + dx, d[1], d[2] + dz]);
  return { ...k, pose };
}) }));
/** Удар с махом и переносом таза (дельта от первого кадра, `applyAttackPelvis`). */
const HIT: Clip = { name: 'hit_none_r_01', character: 'warrior', weapon: 'none', loop: false, keys: [
  { t: 0, pose: { Hips: [0, 0, 0], __hipsD: [0, 0, 0] } },
  { t: 0.3, pose: { Hips: [0.2, 0.35, 0.1], __hipsD: [2, -1, 3] } },
  { t: 0.7, pose: { Hips: [0, 0, 0], __hipsD: [0, 0, 0] } },
] };

interface Scn { mix: number; clips: Clip[] | null; pose?: Partial<typeof POSE>; spd: number; rel: number; attack?: boolean }
interface Frame { q: THREE.Quaternion[]; hips: THREE.Vector3; foot: THREE.Vector3 }
const REL = ['Hips', 'Chest', 'LeftUpperLeg'] as const;
/** Прогон со старта курсом `h0` (°): ход под углом `rel` к прицелу. Кадр — таз/грудь/бедро и таз/стопа в кадре персонажа. */
function run(s: Scn, h0: number): Frame[] {
  setCfg(WARP, { ...SWAY, ...s.pose });
  const h: Humanoid = buildHumanoid({});
  const lib = s.clips;
  const content = { ...localStorageContent('warrior'), ...(lib ? { locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.find((x) => x.name === n); if (c) return c; } return null; } } : {}) };
  const p = new PosePlayer(h, () => [], content, 'none', GX, emptyGrid());
  setLocoMixOverride(s.mix);
  const a = (h0 + s.rel) * D;
  const drive = (): void => { p.setVel(s.spd * Math.sin(a), s.spd * Math.cos(a)); p.setYaw(h0 * D); };
  drive(); p.snapYaw();
  for (let i = 0; i < 150; i++) { drive(); p.step(DT); }
  const out: Frame[] = [];
  for (let i = 0; i < 140; i++) {
    drive(); if (s.attack && i === 5) p.triggerAttack(HIT);
    p.step(DT);
    h.root.updateMatrixWorld(true);
    const inv = yawQ(-p.pelvisYaw), r = h.root.getWorldPosition(new THREE.Vector3());
    const at = (n: string): THREE.Vector3 => h.bones.get(n)!.getWorldPosition(new THREE.Vector3()).sub(r).applyQuaternion(inv);
    out.push({ q: REL.map((n) => h.bones.get(n)!.getWorldQuaternion(new THREE.Quaternion()).premultiply(inv)), hips: at('Hips'), foot: at('LeftFoot') });
  }
  return out;
}
/** Наибольшее расхождение с курсом 0 по курсам 90 / 180 / −90: угол (°, таз/грудь/бедро), таз X/Z и стопа (u). */
function headingGap(s: Scn): { deg: number; hips: number; foot: number } {
  const base = run(s, 0);
  let deg = 0, hips = 0, foot = 0;
  for (const h0 of [90, 180, -90]) {
    const f = run(s, h0);
    for (let i = 0; i < base.length; i++) {
      for (let k = 0; k < REL.length; k++) deg = Math.max(deg, f[i]!.q[k]!.angleTo(base[i]!.q[k]!) / D);
      hips = Math.max(hips, Math.hypot(f[i]!.hips.x - base[i]!.hips.x, f[i]!.hips.z - base[i]!.hips.z));
      foot = Math.max(foot, f[i]!.foot.distanceTo(base[i]!.foot));
    }
  }
  return { deg, hips, foot };
}

describe('⭐ настоящий `PosePlayer`: таз в кадре персонажа от курса не зависит', () => {
  afterEach(() => { setLocoMixOverride(null); setCfg(); });
  const TILT = [10 * D, 0, 0] as const;
  const CASES: [string, () => Scn][] = [
    ['«только клипы», ход вперёд: наклон таза +10° и сдвиг (+2, +1) в клипах', () => ({ mix: 1, clips: editHips(bakedLoco(), TILT, 2, 1), spd: 40, rel: 0 })],
    ['«только клипы», ход боком (доворот таза): те же правки', () => ({ mix: 1, clips: editHips(bakedLoco(), TILT, 2, 1), spd: 40, rel: 90 })],
    ['«только клипы», запечённое как есть (качание таза `__hipsD.x`)', () => ({ mix: 1, clips: bakedLoco(), spd: 40, rel: 0 })],
    ['смешанный режим 0.99, ход боком: наклон и сдвиг в клипах', () => ({ mix: 0.99, clips: editHips(bakedLoco(), TILT, 2, 1), spd: 40, rel: 90 })],
    ['процедурка, `hipsPitchSwing` 0.15, ход вперёд', () => ({ mix: 0, clips: null, pose: { hipsPitchSwing: 0.15, hipsPitchSwingRun: 0.15 }, spd: 60, rel: 0 })],
    ['процедурка с наклоном, медленный шаг + удар с махом и переносом таза', () => ({ mix: 0, clips: null, pose: { hipsPitchSwing: 0.15, hipsPitchSwingRun: 0.15 }, spd: 12, rel: 0, attack: true })],
  ];
  for (const [name, mk] of CASES) {
    it(name, () => {
      const g = headingGap(mk());
      const msg = `${name}: ${g.deg.toFixed(4)}° / таз ${g.hips.toFixed(4)}u / стопа ${g.foot.toFixed(4)}u`;
      expect(g.deg, msg).toBeLessThan(0.05);
      expect(g.hips, msg).toBeLessThan(0.01);
      expect(g.foot, msg).toBeLessThan(0.05);
    }, 60_000);
  }
});

describe('⭐ вычет фейсинга запекателя (`neutralizeFacing`) — обратное композиции игры на живом плеере', () => {
  afterEach(() => { setCfg(); });
  it('процедурка с наклоном таза, курсы 40 / 90 / 180 / −135, вперёд и боком: снятая поза + курс = таз игры', () => {
    for (const [aim, rel] of [[40, 0], [90, 0], [180, 90], [-135, 90]] as const) {
      setCfg(WARP, { ...SWAY, hipsPitchSwing: 0.15, hipsPitchSwingRun: 0.15 });
      const h = buildHumanoid({}), p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
      const a = (aim + rel) * D, read = defaultReadPose(h), fresh = buildHumanoid({});
      p.setVel(50 * Math.sin(a), 50 * Math.cos(a)); p.setYaw(aim * D); p.snapYaw();
      let worstDeg = 0, worstU = 0, warp = 0;
      for (let i = 0; i < 240; i++) {
        p.step(DT);
        if (i < 60) continue;
        warp = Math.max(warp, Math.abs(p.pelvisYaw - aim * D));
        const pose = neutralizeFacing(read(), p.pelvisYaw, h.hipsRest);
        poseRig(fresh, pose); pelvisToWorld(fresh.hips, p.pelvisYaw);
        worstDeg = Math.max(worstDeg, fresh.hips.quaternion.angleTo(h.hips.quaternion) / D);
        worstU = Math.max(worstU, Math.hypot(fresh.hips.position.x - h.hips.position.x, fresh.hips.position.z - h.hips.position.z));
      }
      const msg = `курс ${aim}°, ход ${rel}°: ${worstDeg.toFixed(3)}° / ${worstU.toFixed(4)}u (доворот до ${(warp / D).toFixed(1)}°)`;
      if (rel) expect(warp / D, `${msg}: доворот таза был`).toBeGreaterThan(10);
      expect(worstDeg, `${msg} — чтение позы округлено до 1e-3 рад`).toBeLessThan(0.15);
      expect(worstU, `${msg} — сдвиг округлён до 1e-3`).toBeLessThan(0.003);
    }
  }, 60_000);
});
