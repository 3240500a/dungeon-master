/**
 * GHOST-РИГ: генератор ЦЕЛЕВОЙ позы (углы суставов). Единый источник для обоих ригов:
 * - кинематический (`actor.ts`) — ставит углы напрямую (дешёвый LOD, монстры);
 * - физический (`ragdoll.ts`) — скармливает углы моторам суставов (Jolt, игрок).
 * Все углы — маховые, вокруг локальной оси X кости (как и суставы рига).
 * Знаки: колено гнётся НАЗАД (+), локоть — ВПЕРЁД (в риге применяется с минусом).
 *
 * Ноги умеют два режима:
 * - `setMove(speed01)` — СИНУС по времени. Дёшево, но стопы скользят: нога не знает про землю.
 * - `setWorld(x, z, yaw, vx, vz)` — ПОХОДКА С ОПОРОЙ: шаги планируются в мире (опорная стопа приколота
 *   к точке на полу, маховая переносится дугой), углы бедра/колена даёт 2-костная IK. Стопы не едут.
 */

export interface PoseTargets {
  hipL: number; hipR: number; knL: number; knR: number;
  /** Боковой вынос бедра (+ = наружу/вправо). Без него приставные шаги вырождаются в топтание. */
  hipLatL: number; hipLatR: number;
  shL: number; shR: number; elL: number; elR: number;
  lean: number; twist: number; bobY: number; splay: number;
}

const ATTACK_DUR = 0.42;

/** Взмах правой: замах назад → удар вперёд → возврат. */
function attackCurve(p: number): number {
  if (p < 0.28) return (p / 0.28) * -1.1;
  if (p < 0.62) return -1.1 + ((p - 0.28) / 0.34) * 2.8;
  return 1.7 - ((p - 0.62) / 0.38) * 1.55;
}

// ── Походка с опорой ───────────────────────────────────────────────────────────
// Длины костей — строго по риг-таблице BONES: бедро 30→15, голень 15→1.5 (НЕ 15! иначе IK считает ногу
// длиннее, чем она есть, и стопа не достаёт до пола).
const L_THIGH = 15, L_SHIN = 13.5, LEG = L_THIGH + L_SHIN;
const HIP_DX = 3.6;          // полуширина таза
const FOOT_Y = 1.5;          // высота центра стопы, стоящей на полу
/**
 * Высота таза в стойке. КРИТИЧНО: заметно МЕНЬШЕ длины ноги (30). При таз=30 нога выпрямлена в струну,
 * стопа дотягивается только до точки прямо под тазом — шаг невозможен в принципе. 26.5 → колени чуть
 * согнуты (как у человека) и появляется вылет стопы ~17u, т.е. шаг ~1 м.
 */
export const STAND_Y = 27;   // высота таза стоя (для init позы; живая — в GAIT.standY)
const RIG_PELVIS_Y = 30;     // высота таза в опорной позе рига (таблица BONES в ragdoll.ts)
const MOVE_EPS = 8;          // ниже этой скорости (u/с) считаем, что стоим

/**
 * ЖИВЫЕ настройки походки — крутятся дебаг-панелью в 3D-клиенте (`window.__gait`, клавиша G).
 * Дефолты = коммит d523b26. Пока ползунок не двинут, поведение ровно как было.
 */
export const GAIT = {
  standY: 27, pelvisMin: 19,                 // посадка таза: стойка / нижний предел приседа
  stepBase: 30, stepK: 0.12, stepMax: 52,    // длина шага = clamp(base + speed·K, base, max)
  dutyWalk: 0.5, dutyRun: 0.34, speedWalk: 40, speedRun: 115,   // доля опоры ↔ скорость (бег = мал. доля)
  liftBase: 7, liftK: 0.11,                  // подъём маховой стопы = base + (speed−speedWalk)·K
  hipFwdLim: 0.95, hipFwdSoft: 0.3,          // мягкий потолок форвардного угла бедра
  // ВЫНОС СТОПЫ ВПЕРЁД (то, что домучиваем): к базовому шаг·доля добавляем шаг·aheadMul + скорость·predictSec.
  // fixTarget=1 — цель фиксируется в момент отрыва (предсказание), 0 — едет за бедром каждый кадр.
  aheadMul: 0, predictSec: 0, fixTarget: 0,
};
const liftFor = (speed: number): number => GAIT.liftBase + Math.max(0, Math.min(speed, 130) - GAIT.speedWalk) * GAIT.liftK;

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

interface Leg {
  px: number; pz: number;   // точка опоры в МИРЕ (стопа прибита сюда, пока нога опорная)
  sw: number;               // 0 — на земле, (0..1] — доля переноса
  fx: number; fz: number;   // откуда переносим
  tx: number; tz: number;   // куда переносим
}
interface LegAngles { hip: number; knee: number; lat: number }

/**
 * 2-костная IK в сагиттальной плоскости тела: вектор от бедра к стопе в мире (dx,dz) + по высоте (dy<0).
 * Боковую составляющую игнорируем — бедро в риге машет только вокруг X (вперёд-назад), боковой баланс
 * будет отдельным этапом.
 */
function ik(dx: number, dz: number, dy: number, fx: number, fz: number, rx: number, rz: number): LegAngles {
  const lz = dx * fx + dz * fz;                         // вперёд-назад в теле
  const lx = dx * rx + dz * rz;                         // вбок в теле (+ = вправо)
  const d = clamp(Math.hypot(lz, lx, dy), 8, LEG - 0.6);   // не даём ноге «переразогнуться»
  const thFoot = Math.atan2(lz, -dy);                   // куда смотрит стопа от бедра (0 = прямо вниз)
  const alpha = Math.acos(clamp((L_THIGH * L_THIGH + d * d - L_SHIN * L_SHIN) / (2 * L_THIGH * d), -1, 1));
  const beta = Math.acos(clamp((L_THIGH * L_THIGH + L_SHIN * L_SHIN - d * d) / (2 * L_THIGH * L_SHIN), -1, 1));
  // Колено (сустав) при сгибе уходит ВПЕРЁД, а голень — назад (пятка к заду). Значит бедро отклонено от
  // линии «бедро→стопа» вперёд: θ_бедра = θ_стопы + α. Положительный hip уводит кость назад (−Z) →
  // hip = −θ_бедра. Проверка: стопа под бедром (d=25) → hip=−0.586, колено 1.17 → стопа ровно в цели.
  // Боковой вынос — отдельным углом вокруг Z (положительный уводит кость вправо, +X).
  let hip = -(thFoot + alpha);
  // МЯГКИЙ ПОТОЛОК ВПЕРЁД (hip<0 = нога вперёд). При постановке стопы далеко впереди IK выдаёт шип до
  // −1.9 рад (109°) — мотор такой скачок не тянет: недобирает и опаздывает на 2-3 кадра, нога плетётся
  // сзади. Живая нога выносится ~50°. tanh-насыщение делает форвардную цель плавной и достижимой, зад
  // (hip>0, отработан идеально) не трогаем.
  const lim = GAIT.hipFwdLim, soft = GAIT.hipFwdSoft;
  if (hip < -lim) hip = -(lim + soft * Math.tanh((-hip - lim) / soft));
  return { hip, knee: Math.PI - beta, lat: Math.atan2(lx, -dy) };
}

class StepPlanner {
  private legs: [Leg, Leg] = [
    { px: 0, pz: 0, sw: 0, fx: 0, fz: 0, tx: 0, tz: 0 },
    { px: 0, pz: 0, sw: 0, fx: 0, fz: 0, tx: 0, tz: 0 },
  ];
  private placed = false;
  private hipY = STAND_Y;
  /** ФАКТИЧЕСКОЕ положение щиколоток из физики (мир). Плантуем туда, где нога реально стоит. */
  private actual: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  /** Фаза походки (рад): π = один шаг. Ей же машем руками, чтобы они шли в такт ногам. */
  phase = 0;

  setFeet(lx: number, lz: number, rx: number, rz: number): void {
    this.actual[0][0] = lx; this.actual[0][1] = lz;
    this.actual[1][0] = rx; this.actual[1][1] = rz;
  }

  private reset(px: number, pz: number, rx: number, rz: number): void {
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -HIP_DX : HIP_DX;
      const l = this.legs[i]!;
      l.px = px + rx * s; l.pz = pz + rz * s; l.sw = 0;
    }
    this.placed = true;
  }


  update(dt: number, px: number, pz: number, yaw: number, vx: number, vz: number): { l: LegAngles; r: LegAngles; bobY: number } {
    // Оси тела в мире: вперёд = локальный +Z, вправо = локальный +X.
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    if (!this.placed || Math.hypot(this.legs[0].px - px, this.legs[0].pz - pz) > 100) this.reset(px, pz, rx, rz);

    const speed = Math.hypot(vx, vz);
    const moving = speed > MOVE_EPS;
    const mx = moving ? vx / speed : 0, mz = moving ? vz / speed : 0;
    const stepLen = clamp(GAIT.stepBase + speed * GAIT.stepK, GAIT.stepBase, GAIT.stepMax);

    // 1. РИТМ. Фаза едет от ПРОЙДЕННОГО ПУТИ: π = один шаг. Ноги чередуются строго по фазе.
    //    Раньше шаг запускался по накопленному отставанию — и пока одна нога в переносе, вторая ждала
    //    очереди и уезжала назад на весь шаг: нога плантовалась на +16, а уходила на −31, центр шага
    //    смещался за спину («семенит сзади тела»). При ритме опорная уходит назад ровно на полшага.
    // Стоим, но стопа уехала (добежали и встали) — доводим её ШАГОМ: крутим фазу, пока не переступит.
    // Раньше плант просто телепортировался под таз — это и был рывок «подшагивания» на медленном ходу.
    let needStep = false;
    for (let i = 0; i < 2 && !moving; i++) {
      const l = this.legs[i]!;
      const s = i === 0 ? -HIP_DX : HIP_DX;
      if (Math.hypot(l.px - (px + rx * s), l.pz - (pz + rz * s)) > 7) needStep = true;
    }
    if (moving) this.phase += (speed * dt / stepLen) * Math.PI;
    else if (needStep || this.legs.some((l) => l.sw > 0)) this.phase += dt * 5;   // переступ на месте

    // 2. ОКНА ОПОРЫ по доле. У ноги i опора отцентрована на фазе i·π и занимает 2π·duty цикла; остальное —
    //    перенос. duty<0.5 → между опорами обе ноги в воздухе (фаза полёта) — это и есть бег.
    const duty = clamp(GAIT.dutyWalk + (GAIT.dutyRun - GAIT.dutyWalk) * ((speed - GAIT.speedWalk) / (GAIT.speedRun - GAIT.speedWalk)), GAIT.dutyRun, GAIT.dutyWalk);
    // Вынос стопы вперёд (относительно бедра): база шаг·доля + ручки панели.
    const lead = stepLen * duty + stepLen * GAIT.aheadMul + speed * GAIT.predictSec;
    const TAU = Math.PI * 2, half = Math.PI * duty;
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i]!;
      let c = (this.phase - i * Math.PI) % TAU; if (c < 0) c += TAU;
      if (c < half || c > TAU - half) {              // ОПОРА
        if (l.sw > 0) {                              // приземление: плантуем ТУДА, ГДЕ НОГА РЕАЛЬНО СТОИТ
          const a = this.actual[i]!;                 // (плант «по расчёту» тащил отстающую ногу рывком)
          l.px = a[0]; l.pz = a[1];
        }
        l.sw = 0;
      } else {                                       // ПЕРЕНОС
        if (l.sw === 0) {                             // отрыв
          l.fx = l.px; l.fz = l.pz;
          const s = i === 0 ? -HIP_DX : HIP_DX;
          const hx = px + rx * s, hz = pz + rz * s;
          // fixTarget: цель фиксируется здесь. Прибавляем пролёт тела за перенос (1−доля)·2·шаг — к касанию
          // бедро будет там, стопа приземлится на `lead` впереди. Иначе цель едет за бедром (пересчёт ниже).
          const fly = GAIT.fixTarget ? stepLen * (1 - duty) * 2 : 0;
          l.tx = hx + mx * (lead + fly); l.tz = hz + mz * (lead + fly);
        }
        l.sw = clamp((c - half) / (TAU - 2 * half), 0.001, 1);
      }
    }

    // 3. ТАЗ ЕДЕТ ПО ОПОРНОЙ НОГЕ (как у человека): ноги разъехались → таз просел, нога под тазом → таз
    //    поднялся. В фазе полёта опорной нет — тело идёт на полной высоте. Сглаживаем, чтобы не «щёлкало».
    let maxLz = 0, anyStance = false;
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i]!;
      if (l.sw > 0) continue;                        // маховая нога вес не держит
      anyStance = true;
      const s = i === 0 ? -HIP_DX : HIP_DX;
      const hx = px + rx * s, hz = pz + rz * s;
      maxLz = Math.max(maxLz, Math.abs((l.px - hx) * fx + (l.pz - hz) * fz));
    }
    const reach = LEG * 0.97;
    const wantY = anyStance
      ? clamp(FOOT_Y + Math.sqrt(Math.max(0, reach * reach - maxLz * maxLz)), GAIT.pelvisMin, GAIT.standY)
      : GAIT.standY;
    // Сглаживание нужно только бегу (вход/выход из полёта). На шаге оно даёт запаздывание таза, геометрия
    // опорной ноги плывёт и её волочит — поэтому на малой скорости берём высоту как есть.
    const lag = speed > GAIT.speedWalk ? Math.min(1, dt * 14) : 1;
    this.hipY += (wantY - this.hipY) * lag;
    const hipY = this.hipY;
    const out: LegAngles[] = [];
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i]!;
      const s = i === 0 ? -HIP_DX : HIP_DX;
      const hx = px + rx * s, hz = pz + rz * s;
      let wx: number, wz: number, wy: number;
      if (l.sw > 0) {
        // Маховая. При fixTarget цель зафиксирована на отрыве (выше). Иначе — едет за бедром: держится
        // на `lead` впереди ТЕКУЩЕГО бедра (пересчёт каждый кадр).
        if (!GAIT.fixTarget) { l.tx = hx + mx * lead; l.tz = hz + mz * lead; }
        const t = l.sw, e = t * t * (3 - 2 * t);
        wx = l.fx + (l.tx - l.fx) * e; wz = l.fz + (l.tz - l.fz) * e;
        wy = FOOT_Y + Math.sin(Math.PI * t) * liftFor(speed);
      } else { wx = l.px; wz = l.pz; wy = FOOT_Y; }    // опорная: прибита к полу
      out.push(ik(wx - hx, wz - hz, wy - hipY, fx, fz, rx, rz));
    }
    return { l: out[0]!, r: out[1]!, bobY: hipY - RIG_PELVIS_Y };
  }
}

export class PoseDriver {
  private phase = Math.random() * 6.283;
  private move = 0;
  private attackT = 0;
  private attackPow = 1;
  private dead = false;
  private planner: StepPlanner | null = null;
  private w = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 };
  readonly out: PoseTargets = { hipL: 0, hipR: 0, knL: 0, knR: 0, hipLatL: 0, hipLatR: 0, shL: 0, shR: 0, elL: 0, elR: 0, lean: 0, twist: 0, bobY: 0, splay: 0 };

  setMove(s: number): void { this.move = Math.max(0, Math.min(1.4, s)); }
  /** Включает походку с опорой: позиция/рыск/скорость тела в мире (юниты, u/с). */
  setWorld(x: number, z: number, yaw: number, vx: number, vz: number): void {
    this.planner ??= new StepPlanner();
    this.w.x = x; this.w.z = z; this.w.yaw = yaw; this.w.vx = vx; this.w.vz = vz;
  }
  /** Обратная связь от физики: где НА САМОМ ДЕЛЕ стоят щиколотки (мир). Плантуем по факту, а не по расчёту. */
  setFeet(lx: number, lz: number, rx: number, rz: number): void { this.planner?.setFeet(lx, lz, rx, rz); }
  attack(power = 1): void { if (!this.dead) { this.attackT = ATTACK_DUR; this.attackPow = power; } }
  setDead(d: boolean): void { this.dead = d; }
  get isDead(): boolean { return this.dead; }
  /** Идёт ли взмах (для триггера VFX/звука). */
  get attacking(): boolean { return this.attackT > 0; }

  update(dt: number): PoseTargets {
    const o = this.out;
    if (this.dead) {
      o.splay = 1; o.bobY = -26; o.lean = 1.4; o.twist = 0;
      o.hipL = 0.7; o.hipR = -0.7; o.knL = 1.2; o.knR = 1.2; o.shL = 0.7; o.shR = -0.7; o.elL = 1.2; o.elR = 1.2;
      return o;
    }
    const walking = this.move > 0.05;

    if (this.planner) {
      const w = this.w;
      const g = this.planner.update(dt, w.x, w.z, w.yaw, w.vx, w.vz);
      o.hipL = g.l.hip; o.knL = g.l.knee; o.hipLatL = g.l.lat;
      o.hipR = g.r.hip; o.knR = g.r.knee; o.hipLatR = g.r.lat;
      o.bobY = g.bobY;
      this.phase = this.planner.phase;
    } else {
      this.phase += (walking ? 2.2 + this.move * 3.2 : 1.3) * dt;
      const s0 = Math.sin(this.phase), s2 = Math.sin(this.phase * 2);
      const a0 = walking ? 0.45 + this.move * 0.4 : 0;
      o.hipL = s0 * a0; o.hipR = -s0 * a0;
      o.knL = Math.max(0, -s0) * a0 * 1.3 + (walking ? 0.12 : 0);
      o.knR = Math.max(0, s0) * a0 * 1.3 + (walking ? 0.12 : 0);
      o.bobY = walking ? Math.abs(s2) * 2.0 : Math.sin(this.phase) * 0.7;
    }

    const s = Math.sin(this.phase);
    const amp = walking ? 0.45 + this.move * 0.4 : 0;
    o.lean = walking ? 0.05 + this.move * 0.06 : 0.02;
    o.splay = 0;

    if (this.attackT <= 0) {
      o.shL = -s * amp * 0.85; o.shR = s * amp * 0.85;
      o.elL = 0.35 + amp * 0.2; o.elR = 0.35 + amp * 0.2;
      o.twist = s * amp * 0.15;
    } else {
      this.attackT -= dt;
      const p = 1 - this.attackT / ATTACK_DUR, sw = attackCurve(p) * this.attackPow;
      o.shR = sw; o.elR = 0.5 + Math.max(0, sw) * 0.7;
      o.shL = -sw * 0.3; o.elL = 0.35;
      o.twist = sw * 0.28; o.lean = 0.1 + Math.max(0, sw) * 0.1;
    }
    return o;
  }
}
