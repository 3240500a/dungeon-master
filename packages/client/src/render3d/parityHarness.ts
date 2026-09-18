/**
 * ⭐⭐ СТЕНД ЗАМЕРОВ: одна мерка на все правки анимации.
 *
 * Зачем. Каждая правка локомоции до сих пор мерилась СВОИМ одноразовым зондом: один считал размах по эйлеру, другой
 * по мировому направлению, третий по кватерниону — и числа из разных правок сравнивать было нельзя. А без общего
 * числа «стало лучше» неотличимо от «стало иначе».
 *
 * ⚠ СТЕНД НИЧЕГО НЕ ЧИНИТ И НИЧЕГО НЕ ЗНАЕТ ПРО ПРАВИЛЬНО. Он строит НАСТОЯЩУЮ игровую связку (тот же `PosePlayer`,
 * тот же контент, тот же режим) и снимает с неё числа. Любая «поправка» внутри стенда — это вторая правда, и врать
 * начнёт именно мерка, которой верят в спорной ситуации (тот же довод, что у инспектора слоёв).
 *
 * ⚠ РАЗМАХ МЕРИТСЯ ПО МИРОВОМУ НАПРАВЛЕНИЮ КОСТИ, а не по её локальному эйлеру: локальный угол у плеча и у предплечья
 * живёт в разных осях (у предплечья сгиб по Y, см. `applyUpper`), и складывать их нельзя. Мировое направление —
 * одна величина для любой кости и ровно то, что видно глазами.
 *
 * ⚠ ПАРИТЕТ МЕРИТСЯ НА ОДНОЙ ФАЗЕ. Клип в игре сэмплируется фазой плеера (`clipPhase`), а не своим временем, поэтому
 * эталон берётся ровно на той же фазе — иначе замер покажет расхождение там, где его нет (это сдвиг во времени).
 */
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, emptyGrid, setLocoMixOverride, type GXKnobs, type PoseContent } from './poseRuntime.js';
import { locoPhaseU } from './locoBlend.js';
import { clipPoseAt, type Clip, type Pose } from './clipModel.js';

export const DEG = 180 / Math.PI;
/** Ручки ретаргета по умолчанию — те же, с которыми работают все стенды и запекатель. */
export const HARNESS_GX: GXKnobs = { armDown: 1.35, elbowBend: 0.25 };

/** Группы костей, по которым считается расхождение с клипом. Раздельно: у них РАЗНЫЕ хозяева и разные причины промаха. */
export const GROUPS: Readonly<Record<string, readonly string[]>> = {
  руки: ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand'],
  'таз+спина': ['Hips', 'Spine', 'Chest', 'UpperChest'],
  голова: ['Neck', 'Head'],
  ноги: ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'],
};

export interface StandOpts {
  content: PoseContent;
  weapon?: string;
  /** Плант-сетка. Умолчание — пустая: в «только клипы» она не читается. */
  grid?: ReturnType<typeof emptyGrid>;
  gx?: GXKnobs;
  /** Доля клипа: 1 — как в игре («только клипы»), 0 — планировщик, null — как настроено. */
  mix?: number | null;
}

export interface RunOpts {
  /** Скорость вдоль +Z (вперёд) и +X (в свою ЛЕВУЮ — см. таблицу истины в `pose.ts`). */
  vz?: number;
  vx?: number;
  /** Прицел (рад). Умолчание — вдоль хода вперёд. */
  aim?: number;
  /** Кадров разогрева (в замер не идут) и кадров замера. */
  warm?: number;
  frames?: number;
  dt?: number;
  combat?: boolean;
  /** Зовётся ПЕРЕД каждым шагом замера: `i` — номер кадра. Так задаются остановки, развороты, смена оружия. */
  at?: (p: PosePlayer, i: number) => void;
}

/** Снимок одного кадра: локальные повороты, мировые направления костей, мировые позиции стоп и таза. */
interface Frame {
  local: Map<string, THREE.Quaternion>;
  dir: Map<string, THREE.Vector3>;
  foot: [THREE.Vector3, THREE.Vector3];
  hipsY: number;
  /** Фаза цикла клипа 0..1 — по ней берётся эталон. */
  u: number;
  support: [boolean, boolean];
}

export interface Stand {
  human: Humanoid;
  player: PosePlayer;
  /** Прогнать и снять кадры. Между вызовами состояние плеера СОХРАНЯЕТСЯ — так меряются переходы. */
  run(o?: RunOpts): Frame[];
  dispose(): void;
}

const V0 = new THREE.Vector3(1, 0, 0);

export function makeStand(o: StandOpts): Stand {
  const human = buildHumanoid({});
  const player = new PosePlayer(human, () => [], o.content, o.weapon ?? 'none', o.gx ?? HARNESS_GX, o.grid ?? emptyGrid());
  setLocoMixOverride(o.mix === undefined ? 1 : o.mix);
  player.setYaw(0); player.snapYaw(); player.setVel(0, 0);
  const snap = (): Frame => {
    human.root.updateMatrixWorld(true);
    const local = new Map<string, THREE.Quaternion>(), dir = new Map<string, THREE.Vector3>();
    for (const g of Object.values(GROUPS)) for (const nm of g) {
      const b = human.bones.get(nm); if (!b) continue;
      local.set(nm, b.quaternion.clone());
      dir.set(nm, V0.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion())));
    }
    const foot = (['LeftFoot', 'RightFoot'] as const).map((nm) => {
      const w = human.bones.get(nm)!.getWorldPosition(new THREE.Vector3());
      return new THREE.Vector3(w.x + player.posX, w.y, w.z + player.posZ);   // мир: локальная поза + пройденный путь
    }) as [THREE.Vector3, THREE.Vector3];
    const sup = player.groundSupport;
    return { local, dir, foot, hipsY: human.bones.get('Hips')!.getWorldPosition(new THREE.Vector3()).y,
      u: locoPhaseU(player.clipPhaseNow), support: [sup[0]!, sup[1]!] };
  };
  return {
    human, player,
    run(r: RunOpts = {}): Frame[] {
      const dt = r.dt ?? 1 / 60;
      player.setVel(r.vx ?? 0, r.vz ?? 0);
      player.setYaw(r.aim ?? 0);
      player.setCombat(!!r.combat);
      for (let i = 0; i < (r.warm ?? 240); i++) { r.at?.(player, -1); player.step(dt); }
      const out: Frame[] = [];
      for (let i = 0; i < (r.frames ?? 180); i++) { r.at?.(player, i); player.step(dt); out.push(snap()); }
      return out;
    },
    dispose(): void { setLocoMixOverride(null); },
  };
}

// ── Мерки ────────────────────────────────────────────────────────────────────────────────────────

/** Размах кости за прогон: наибольший угол между её МИРОВЫМИ направлениями, °. */
export function arcDeg(fr: readonly Frame[], bone: string): number {
  const v = fr.map((f) => f.dir.get(bone)).filter(Boolean) as THREE.Vector3[];
  let m = 0;
  for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) m = Math.max(m, v[i]!.angleTo(v[j]!));
  return m * DEG;
}

/** Наибольший шаг позы ЗА КАДР по группе, ° — им ловятся щелчки и рывки. */
export function jumpDeg(fr: readonly Frame[], bones: readonly string[]): number {
  let m = 0;
  for (let i = 1; i < fr.length; i++) for (const nm of bones) {
    const a = fr[i - 1]!.local.get(nm), b = fr[i]!.local.get(nm);
    if (a && b) m = Math.max(m, a.angleTo(b) * DEG);
  }
  return m;
}

/** Квантиль набора чисел (0..1). Для p95 скачка: единичный выброс на первом кадре — не то же, что постоянная дрожь. */
export const quantile = (xs: readonly number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};

/**
 * Расхождение позы с ЭТАЛОНОМ КЛИПА на той же фазе, ° (максимум и среднее по группе).
 * Кость, которой в клипе нет, в счёт не идёт: её эталон — не ноль, а «клип её не ведёт».
 */
export function poseErrorDeg(fr: readonly Frame[], clip: Clip, bones: readonly string[]): { max: number; mean: number } {
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  let max = 0, sum = 0, n = 0;
  for (const f of fr) {
    const want = clipPoseAt(clip, f.u);
    for (const nm of bones) {
      const w = want[nm], got = f.local.get(nm);
      if (!w || !got) continue;
      const d = got.angleTo(q.setFromEuler(e.set(w[0], w[1], w[2], 'XYZ'))) * DEG;
      max = Math.max(max, d); sum += d; n++;
    }
  }
  return { max, mean: n ? sum / n : 0 };
}

/**
 * ⭐ УХОД ОПОРНОЙ СТОПЫ, ед: сколько она проехала по полу, ПОКА считалась опорной.
 * Считается по отрезкам непрерывной опоры и берётся ХУДШИЙ — усреднение по всему прогону прячет ровно тот случай,
 * ради которого мерка и заведена (одна плохая постановка среди десяти хороших).
 */
export function footDrift(fr: readonly Frame[]): number {
  let worst = 0;
  for (let leg = 0; leg < 2; leg++) {
    let from: THREE.Vector3 | null = null, run = 0;
    for (const f of fr) {
      if (f.support[leg]) { const p = f.foot[leg]!; if (!from) { from = p; run = 0; } else run = Math.max(run, Math.hypot(p.x - from.x, p.z - from.z)); }
      else { worst = Math.max(worst, run); from = null; run = 0; }
    }
    worst = Math.max(worst, run);
  }
  return worst;
}

/** Средняя поза набора кадров (кватернионное усреднение со сведением знака) — нейтраль цикла. */
export function meanPose(poses: readonly Pose[], bones: readonly string[]): Pose {
  const out: Pose = {};
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  for (const nm of bones) {
    let acc: THREE.Quaternion | null = null; let n = 0;
    for (const p of poses) {
      const v = p[nm]; if (!v) continue;
      q.setFromEuler(e.set(v[0], v[1], v[2], 'XYZ'));
      if (!acc) { acc = q.clone(); n = 1; continue; }
      // ⚠ СВЕДЕНИЕ ЗНАКА: q и −q — один поворот, но усреднять их покомпонентно нельзя (дадут ноль).
      if (acc.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      n++;
      acc.set(acc.x + (q.x - acc.x) / n, acc.y + (q.y - acc.y) / n, acc.z + (q.z - acc.z) / n, acc.w + (q.w - acc.w) / n);
    }
    if (!acc) continue;
    acc.normalize(); e.setFromQuaternion(acc, 'XYZ');
    out[nm] = [e.x, e.y, e.z];
  }
  return out;
}
