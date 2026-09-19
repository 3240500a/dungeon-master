/**
 * GOLDEN-ГЕНЕРАТОР ПОХОДКИ (веб = источник истины). Гоняет батарею траекторий через PoseDriver (тот же путь,
 * что игра/редактор) и записывает ПЕР-КАДРОВЫЙ вход (x,z,yaw,vx,vz,goalYaw) + выход StepPlanner (углы ног + bobY).
 *
 * Назначение: Unity-порт (Assets/DM/PoseEditor/StepPlanner.cs) гоняет РОВНО ТЕ ЖЕ пер-кадровые входы и обязан
 * выдать те же углы (eps ≈ 0.02 рад). Так математика (Слой A) залочена на веб-эталон и не может молча разъехаться
 * (уже найден расход: C# lead брал dutyWalk вместо lerp(duty) → бег). Привязка к скелету (Слой B) — отдельно, в Unity.
 *
 * Кадры пишем АБСОЛЮТНО (не переинтегрируем в Unity) — чтобы изолировать чисто математику StepPlanner от разницы
 * интегрирования позиции. Непрерывные траектории (idle/walk/run/strafe/diag) — гладкие, ветвление стабильно →
 * чистый сигнал паритета. Повороты на месте (branch-heavy) проверяются поведенчески отдельно, не пер-кадрово.
 */
import { GAIT } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';

export interface GoldenFrame { dt: number; x: number; z: number; yaw: number; vx: number; vz: number; goalYaw: number | null }
export interface GoldenOut { hipL: number; hipR: number; knL: number; knR: number; hipLatL: number; hipLatR: number; bobY: number }
export interface GoldenStance { latL: number; fwdL: number; latR: number; fwdR: number; standY: number }
/** `gait` — ПЕРЕКРЫТИЯ GAIT на время кейса (нет поля = умолчания кода). Unity-гейт накатывает их на свой GaitParams. */
export interface GoldenCase { name: string; stance: GoldenStance; gait?: Record<string, number>; frames: GoldenFrame[]; out: GoldenOut[] }
export interface GoldenFile { version: number; params: Record<string, number>; cases: GoldenCase[] }

interface CaseSpec {
  name: string;
  n: number;
  vx?: number; vz?: number;
  yaw0?: number; yawRate?: number;      // рыск: старт + прирост/кадр
  goalYaw?: number | null;              // прицел (курсор) — если задан, шлём каждый кадр
  settle?: number;                      // префикс: N кадров стоя (v=0) для устаканивания стойки
  flipEvery?: number;                   // перекладка: каждые N кадров скорость меняет знак (резкая смена направления)
  stance?: Partial<GoldenStance>;
  /**
   * Перекрытия GAIT на время кейса (восстанавливаются после). Нужны ручкам, у которых умолчание = «выкл»:
   * иначе эталон их не видит вовсе и C#-порт мог бы разъехаться молча. Пишутся в JSON кейса (`gait`).
   */
  gait?: Record<string, number>;
  /** Частота кадров кейса (умолч. 60). `dt` пишется в каждый кадр JSON, C#-гейт берёт его оттуда — порт не трогается. */
  fps?: number;
}

const DEF_STANCE: GoldenStance = { latL: 3.6, fwdL: 0, latR: -3.6, fwdR: 0, standY: 30 };

function round(n: number): number { return Math.round(n * 1e6) / 1e6; }

function runCase(spec: CaseSpec): GoldenCase {
  const g = GAIT as unknown as Record<string, number>;
  const saved: Record<string, number> = {};
  for (const [k, v] of Object.entries(spec.gait ?? {})) { saved[k] = g[k]!; g[k] = v; }
  try { return runCaseWith(spec); } finally { Object.assign(g, saved); }
}

function runCaseWith(spec: CaseSpec): GoldenCase {
  const stance: GoldenStance = { ...DEF_STANCE, ...spec.stance };
  const d = new PoseDriver();
  d.setStance(stance.latL, stance.fwdL, stance.latR, stance.fwdR, stance.standY);
  const dt = 1 / (spec.fps ?? 60);   // ⚠ при 60 — то же число, что было: прежние кейсы байт в байт
  const frames: GoldenFrame[] = [];
  const out: GoldenOut[] = [];
  let x = 0, z = 0, yaw = spec.yaw0 ?? 0;
  const settle = spec.settle ?? 0;
  const total = settle + spec.n;
  for (let i = 0; i < total; i++) {
    const active = i >= settle;
    // Перекладка направления: знак скорости переворачивается каждые `flipEvery` кадров. Это РЕЖИМ,
    // а не помеха — именно на нём живут срочность шага и сглаживание планта (`stepFlip.test.ts`),
    // и именно его C#-порт обязан повторить, иначе разворот в Unity поедет иначе, чем в вебе.
    const sgn = spec.flipEvery && active && Math.floor((i - settle) / spec.flipEvery) % 2 ? -1 : 1;
    const vx = active ? (spec.vx ?? 0) * sgn : 0;
    const vz = active ? (spec.vz ?? 0) * sgn : 0;
    if (active && spec.yawRate) yaw += spec.yawRate;
    x += vx * dt; z += vz * dt;
    const goalYaw = spec.goalYaw ?? null;
    if (goalYaw !== null) d.setGoalYaw(goalYaw);
    d.setWorld(x, z, yaw, vx, vz);
    // АНАЛИТ. РЕЖИМ (как Unity-порт, без физики): на приземлении веб плантует в this.actual[i] (физ-фидбек setFeet).
    // Без физики кормим actual = текущими плант-целями планировщика → плант «в цель маха», ровно как C# StepPlanner.
    // Иначе actual=[0,0] → стопа телепортируется в ноль на приземлении (ложный разрыв ~1.5 рад).
    const fl = d.plantTarget(0), fr = d.plantTarget(1);
    d.setFeet(fl[0], fl[1], fr[0], fr[1]);
    const t = d.update(dt);
    frames.push({ dt, x: round(x), z: round(z), yaw: round(yaw), vx: round(vx), vz: round(vz), goalYaw });
    out.push({
      hipL: round(t.hipL), hipR: round(t.hipR), knL: round(t.knL), knR: round(t.knR),
      hipLatL: round(t.hipLatL), hipLatR: round(t.hipLatR), bobY: round(t.bobY),
    });
  }
  // ⚠ `gait` только у кейсов с перекрытиями — прежние кейсы в JSON остаются байт в байт.
  return { name: spec.name, stance, ...(spec.gait ? { gait: { ...spec.gait } } : {}), frames, out };
}

// Батарея. Непрерывные регимы (чистый пер-кадровый паритет). Скорости: 60 = ходьба (sb≈0.27), 110 = почти бег (sb≈0.93).
const SPECS: CaseSpec[] = [
  { name: 'idle', n: 150, settle: 0 },
  { name: 'walk_fwd', n: 120, vz: 60 },
  { name: 'run_fwd', n: 120, vz: 110 },
  { name: 'walk_back', n: 120, vz: -60 },
  { name: 'strafe_right', n: 120, vx: 60 },
  { name: 'strafe_left', n: 120, vx: -60 },
  { name: 'diag_fr', n: 120, vx: 60, vz: 60 },
  { name: 'diag_fl', n: 120, vx: -60, vz: 60 },
  { name: 'run_diag', n: 120, vx: 80, vz: 80 },
  // движение при повёрнутом рыске (страйф в мировых осях, но тело развёрнуто) — проверяет разложение fwd/lat по yaw
  { name: 'walk_yawed', n: 120, vz: 70, yaw0: 0.9 },
  { name: 'strafe_yawed', n: 120, vx: 70, yaw0: -0.6 },
  // ПОВОРОТ НА МЕСТЕ (branch-heavy: StandTurn — подшаги, ведущая нога, пределы). Стойка шире (9), settle 40 кадров.
  { name: 'turn_left', n: 160, settle: 40, yawRate: 0.03, stance: { latL: 9, latR: -9 } },
  { name: 'turn_right', n: 160, settle: 40, yawRate: -0.03, stance: { latL: 9, latR: -9 } },
  { name: 'turn_slow', n: 300, settle: 40, yawRate: 0.006, stance: { latL: 9, latR: -9 } },
  // ход + доворот (движение и StandTurn не пересекаются, но проверяет переход)
  { name: 'walk_turn', n: 160, vz: 60, yawRate: 0.02 },
  // Перекладка направления — три частоты вокруг длительности шага (на беге шаг ~0.38 с = 23 кадра).
  { name: 'flip_strafe_fast', n: 240, vx: 110, flipEvery: 9 },
  { name: 'flip_strafe_beat', n: 240, vx: 110, flipEvery: 20 },
  { name: 'flip_fwdback', n: 240, vz: 110, flipEvery: 20 },
  { name: 'flip_walk', n: 240, vx: 60, flipEvery: 30 },
  // ПРЕДЕЛ СКОРОСТИ ЦЕЛИ ВЫСОТЫ ТАЗА (`GAIT.bobSlew*`, умолчание 0 = выкл). Бег на скорости запекания 120 (sb = 1 →
  // берётся ровно `bobSlewRun`): цель таза прыгает на касании/отрыве, и именно здесь предел её режет.
  { name: 'run_fwd_slew', n: 120, vz: 120, gait: { bobSlewRun: 30 } },
  // ⚠ `run_fwd_slew` один ловит мало: sb = 1 (лерп ходьба/бег не виден), лаги бега вверх = вниз = 14 (направление
  // лага не видно), 60 fps (ед/с против «на кадр» не видно). Замер мутациями C#-порта против него: «порог вместо
  // лерпа», «вверх/вниз по сырой цели», «предел на кадр» — все ЗЕЛЁНЫЕ. Этот кейс: 80 u/с (sb ≈ 0.53), пары
  // предела и лагов разведены, 144 fps, боб ×2 — те же мутации красные (0.157 / 0.059 / 0.252 рад при eps 0.02).
  { name: 'mix_slew_144', n: 288, vz: 80, fps: 144, gait: { bobWalk: 2, bobRun: 2, bobSlew: 6, bobSlewRun: 30, bobLagUp: 3, bobLagUpRun: 4, bobLagDown: 40, bobLagDownRun: 60 } },
];

/** Снимок актуальных GAIT-параметров (для сверки, что Unity гоняет теми же). */
function paramSnapshot(): Record<string, number> {
  const g = GAIT as unknown as Record<string, number>;
  const keys = ['standY', 'pelvisMin', 'stepWalk', 'stepRun', 'bobWalk', 'bobRun', 'liftWalk', 'liftRun', 'cadence',
    'dutyWalk', 'dutyRun', 'speedWalk', 'speedRun', 'hipFwdLim', 'hipFwdSoft', 'aheadMul', 'predictSec', 'fixTarget',
    'footClear', 'turnStep', 'turnStepDist', 'turnLimitByAngle', 'turnLimitDeg', 'turnSettleTime', 'turnIdleTime',
    'stanceWidth', 'strafeReach', 'crossClamp', 'planSmooth', 'stepSlack', 'stepUrge', 'bobSlew', 'bobSlewRun'];
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = g[k]!;
  return out;
}

export function buildGaitGolden(): GoldenFile {
  return { version: 1, params: paramSnapshot(), cases: SPECS.map(runCase) };
}
