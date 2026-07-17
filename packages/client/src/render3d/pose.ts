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
export const STAND_Y = 27;   // высота таза стоя (ноги почти прямые)
const RIG_PELVIS_Y = 30;     // высота таза в опорной позе рига (таблица BONES в ragdoll.ts)
const PELVIS_MIN = 19;       // ниже не приседаем, даже если шаг просит
/**
 * Длина шага. При ФИКСИРОВАННОЙ высоте таза шире 28 не сделать: стопа не дотянется, IK упрётся в предел.
 * Поэтому таз ЕДЕТ ПО НОГЕ (см. ниже) — как у человека: разъехались ноги → таз просел, нога под тазом →
 * таз поднялся. Это и даёт широкий шаг вместо семенящего.
 */
const STEP_MIN = 30, STEP_MAX = 46;   // длина шага, юниты
const LIFT = 7;              // подъём маховой стопы
const MOVE_EPS = 8;          // ниже этой скорости (u/с) считаем, что стоим

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

interface Leg {
  px: number; pz: number;   // точка опоры в МИРЕ (стопа прибита сюда, пока нога опорная)
  sw: number;               // 0 — на земле, (0..1] — доля переноса
  fx: number; fz: number;   // откуда переносим
  tx: number; tz: number;   // куда переносим
}
interface LegAngles { hip: number; knee: number }

/**
 * 2-костная IK в сагиттальной плоскости тела: вектор от бедра к стопе в мире (dx,dz) + по высоте (dy<0).
 * Боковую составляющую игнорируем — бедро в риге машет только вокруг X (вперёд-назад), боковой баланс
 * будет отдельным этапом.
 */
function ik(dx: number, dz: number, dy: number, fx: number, fz: number): LegAngles {
  const lz = dx * fx + dz * fz;                         // вперёд-назад в теле
  const d = clamp(Math.hypot(lz, dy), 8, LEG - 0.6);    // не даём ноге «переразогнуться»
  const thFoot = Math.atan2(lz, -dy);                   // куда смотрит стопа от бедра (0 = прямо вниз)
  const alpha = Math.acos(clamp((L_THIGH * L_THIGH + d * d - L_SHIN * L_SHIN) / (2 * L_THIGH * d), -1, 1));
  const beta = Math.acos(clamp((L_THIGH * L_THIGH + L_SHIN * L_SHIN - d * d) / (2 * L_THIGH * L_SHIN), -1, 1));
  // Колено (сустав) при сгибе уходит ВПЕРЁД, а голень — назад (пятка к заду). Значит бедро отклонено от
  // линии «бедро→стопа» вперёд: θ_бедра = θ_стопы + α. Положительный hip уводит кость назад (−Z) →
  // hip = −θ_бедра. Проверка: стопа под бедром (d=25) → hip=−0.586, колено 1.17 → стопа ровно в цели.
  return { hip: -(thFoot + alpha), knee: Math.PI - beta };
}

class StepPlanner {
  private legs: [Leg, Leg] = [
    { px: 0, pz: 0, sw: 0, fx: 0, fz: 0, tx: 0, tz: 0 },
    { px: 0, pz: 0, sw: 0, fx: 0, fz: 0, tx: 0, tz: 0 },
  ];
  private swinging = -1;     // индекс ноги в переносе, -1 — обе на земле
  private placed = false;
  /** Фаза походки (рад): ей же машем руками, чтобы они шли в такт ногам. */
  phase = 0;

  private reset(px: number, pz: number, rx: number, rz: number): void {
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -HIP_DX : HIP_DX;
      const l = this.legs[i]!;
      l.px = px + rx * s; l.pz = pz + rz * s; l.sw = 0;
    }
    this.swinging = -1; this.placed = true;
  }

  update(dt: number, px: number, pz: number, yaw: number, vx: number, vz: number): { l: LegAngles; r: LegAngles; bobY: number } {
    // Оси тела в мире: вперёд = локальный +Z, вправо = локальный +X.
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    if (!this.placed || Math.hypot(this.legs[0].px - px, this.legs[0].pz - pz) > 100) this.reset(px, pz, rx, rz);

    const speed = Math.hypot(vx, vz);
    const moving = speed > MOVE_EPS;
    const mx = moving ? vx / speed : 0, mz = moving ? vz / speed : 0;
    const stepLen = clamp(STEP_MIN + speed * 0.12, STEP_MIN, STEP_MAX);
    const stepDur = clamp(stepLen / Math.max(speed, 1), 0.18, 0.5);

    // 1. Продвинуть перенос.
    if (this.swinging >= 0) {
      const l = this.legs[this.swinging]!;
      l.sw += dt / stepDur;
      if (l.sw >= 1) { l.px = l.tx; l.pz = l.tz; l.sw = 0; this.swinging = -1; }
    }
    // 2. Пора ли шагать? Берём ногу, которая сильнее всех отстала от своего бедра.
    if (this.swinging < 0) {
      let worst = -1, worstD = 0;
      for (let i = 0; i < 2; i++) {
        const l = this.legs[i]!;
        const s = i === 0 ? -HIP_DX : HIP_DX;
        const hx = px + rx * s, hz = pz + rz * s;
        const d = moving ? -((l.px - hx) * mx + (l.pz - hz) * mz) : Math.hypot(l.px - hx, l.pz - hz);
        if (d > worstD) { worstD = d; worst = i; }
      }
      // Триггер РАНЬШЕ полушага (0.38): физическая нога догоняет цель с задержкой, и на полушаге стопа
      // успевала уехать назад вдвое дальше, чем выносилась вперёд — шаг выходил несимметричным.
      if (worst >= 0 && worstD > (moving ? stepLen * 0.38 : 9)) {
        const l = this.legs[worst]!;
        const s = worst === 0 ? -HIP_DX : HIP_DX;
        l.fx = l.px; l.fz = l.pz;
        l.sw = 0.001;   // цель считаем каждый кадр ниже — она едет за тазом
        this.swinging = worst;
        this.phase += Math.PI;                     // руки — в такт шагам
      }
    }
    // 3. ТАЗ ЕДЕТ ПО ОПОРНОЙ НОГЕ (как у человека): ноги разъехались → таз просел, нога под тазом → таз
    //    поднялся. Без этого высота таза фиксирована, стопе некуда дотянуться и шаг вырождается в
    //    семенящее «болтание ногами». Именно проседание и даёт широкую амплитуду.
    let maxLz = 0;
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i]!;
      if (l.sw > 0) continue;                        // маховая нога вес не держит
      const s = i === 0 ? -HIP_DX : HIP_DX;
      const hx = px + rx * s, hz = pz + rz * s;
      maxLz = Math.max(maxLz, Math.abs((l.px - hx) * fx + (l.pz - hz) * fz));
    }
    const reach = LEG * 0.97;
    const hipY = clamp(FOOT_Y + Math.sqrt(Math.max(0, reach * reach - maxLz * maxLz)), PELVIS_MIN, STAND_Y);
    const out: LegAngles[] = [];
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i]!;
      const s = i === 0 ? -HIP_DX : HIP_DX;
      const hx = px + rx * s, hz = pz + rz * s;
      let wx: number, wz: number, wy: number;
      if (l.sw > 0) {
        // Маховая: цель ЕДЕТ ЗА ТАЗОМ (полшага впереди ТЕКУЩЕГО бедра). Прибей её в момент отрыва — таз
        // за время переноса уедет дальше вылета ноги, IK упрётся в предел и вытянет ногу в струну вперёд
        // («персонаж сидит на стуле»).
        l.tx = hx + mx * stepLen * 0.5; l.tz = hz + mz * stepLen * 0.5;
        const t = l.sw, e = t * t * (3 - 2 * t);
        wx = l.fx + (l.tx - l.fx) * e; wz = l.fz + (l.tz - l.fz) * e;
        wy = FOOT_Y + Math.sin(Math.PI * t) * LIFT;
      } else { wx = l.px; wz = l.pz; wy = FOOT_Y; }    // опорная: прибита к полу
      out.push(ik(wx - hx, wz - hz, wy - hipY, fx, fz));
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
  readonly out: PoseTargets = { hipL: 0, hipR: 0, knL: 0, knR: 0, shL: 0, shR: 0, elL: 0, elR: 0, lean: 0, twist: 0, bobY: 0, splay: 0 };

  setMove(s: number): void { this.move = Math.max(0, Math.min(1.4, s)); }
  /** Включает походку с опорой: позиция/рыск/скорость тела в мире (юниты, u/с). */
  setWorld(x: number, z: number, yaw: number, vx: number, vz: number): void {
    this.planner ??= new StepPlanner();
    this.w.x = x; this.w.z = z; this.w.yaw = yaw; this.w.vx = vx; this.w.vz = vz;
  }
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
      o.hipL = g.l.hip; o.knL = g.l.knee;
      o.hipR = g.r.hip; o.knR = g.r.knee;
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
