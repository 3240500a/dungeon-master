/**
 * GHOST-РИГ: генератор ЦЕЛЕВОЙ позы (углы суставов). Источник целей для физического рига:
 * `humanoidRagdoll.ts` скармливает эти углы моторам суставов (Jolt) — и для игрока, и для монстров
 * (единый 21-костный риг). Старый кинематический `actor.ts` снесён — рендер всегда физический.
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
  // Доп. оси суставов (нужны РУЧНОМУ редактору позы; в процедурной ходьбе = 0). Плечо: скрутка (Y),
  // разведение в стороны (Z). Бедро: скрутка (Y). Корпус: наклон вбок (Z). Голова: наклон/поворот/склон.
  shTwL: number; shTwR: number; shSpL: number; shSpR: number;
  hipTwL: number; hipTwR: number; leanSide: number;
  headNod: number; headTurn: number; headTilt: number;
  // Запястья (кисти-кости): X сгиб, Y скрутка (крутит меч вокруг оси руки), Z вбок. Нужны вооружённому/редактору.
  wLX: number; wLY: number; wLZ: number; wRX: number; wRY: number; wRZ: number;
}

const ATTACK_DUR = 0.62;   // взмах небыстрый: мотор рук физически не развернёт большой мах за 0.1с (иначе рука «зависает»)

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ── Походка с опорой ───────────────────────────────────────────────────────────
// Длины костей — строго по риг-таблице BONES: бедро 30→15, голень 15→1.5 (НЕ 15! иначе IK считает ногу
// длиннее, чем она есть, и стопа не достаёт до пола).
const L_THIGH = 15, L_SHIN = 13.5, LEG = L_THIGH + L_SHIN;
export const HIP_DX = 3.6;   // полуширина таза
export const FOOT_Y = 1.5;   // высота центра стопы, стоящей на полу
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
  standY: 30, pelvisMin: 26,                 // посадка таза: стойка / нижний предел приседа (подобрано глазами)
  stepBase: 30, stepK: 0.12, stepMax: 52,    // длина шага = clamp(base + speed·K, base, max)
  cadence: 1,                                // множитель частоты цикла: длину шага делим на cadence (>1 → короче шаг, чаще семенит). Антискольз-тюн бега В ИГРЕ; движение НЕ меняет.
  dutyWalk: 0.34, dutyRun: 0.2, speedWalk: 40, speedRun: 115,   // доля опоры ↔ скорость (бег = мал. доля)
  liftBase: 7, liftK: 0.11,                  // подъём маховой стопы = base + (speed−speedWalk)·K
  hipFwdLim: 0.95, hipFwdSoft: 0.3,          // мягкий потолок форвардного угла бедра
  // ВЫНОС СТОПЫ ВПЕРЁД: к базовому шаг·доля добавляем шаг·aheadMul + скорость·predictSec.
  // fixTarget=1 — цель фиксируется в момент отрыва (предсказание), 0 — едет за бедром каждый кадр.
  aheadMul: 0, predictSec: 0, fixTarget: 0,
  idleStep: 11,   // стоя: переступ, только если стопа уехала дальше этого (с гистерезисом) — против «топтания»
  footClear: 8,   // мин. зазор между стопами: цель ближе → уводится ВПЕРЁД, чтобы ноги обходили, а не влезали
  turnStep: 0.45, // поворот на месте: скорость вращения (рад/с) выше этой → считаем, что крутимся
  turnStepDist: 6, // поворот на месте: стопа отъехала от своего планта дальше этого (u) → приставной шаг ровно в плант
  turnLeadBias: 0.6, // внутренняя нога (в сторону поворота) шагает раньше: её порог = turnStepDist·turnLeadBias (меньше → заметнее ведёт)
  // ФОРМА СТОЙКИ (аддитивно, нейтральные дефолты). stanceWidth: базовый боковой развод стоп (u, + = шире).
  // strafeReach: множитель ТОЛЬКО боковой компоненты выноса (1 = как есть; <1 = нога меньше улетает вбок при страйфе).
  // crossClamp: предел захода стопы за среднюю линию тела (u; 99 = без ограничения).
  stanceWidth: 0, strafeReach: 1, crossClamp: 99,
};
const liftFor = (speed: number): number => GAIT.liftBase + Math.max(0, Math.min(speed, 130) - GAIT.speedWalk) * GAIT.liftK;

/**
 * ЖИВАЯ поза верха тела (руки/корпус) — те же ползунки панели, читается КАЖДЫЙ кадр (без пересборки куклы),
 * поэтому идеальна для подбора позы по скринам. Проблема «руки-сосиски»: слабый мотор плеча + нулевая база →
 * руки висят палками и отваливаются назад инерцией. Лечим базовой позой + жёстче мотор (MOTOR.arm* в ragdoll).
 * armSh: база плеча (− вперёд / + назад). armEl: база сгиба локтя в покое (больше = согнутее).
 * armSwing: амплитуда маха руками при ходьбе (× синус, анти-фаза ног). armElWalk: добавка сгиба локтя на ходу.
 */
export const POSE = {
  armSh: -0.22, armEl: 0.6, armSwing: 0.55, armElWalk: 0.2,
};

/**
 * ЖИВАЯ боевая idle-СТОЙКА «меч+щит» (только для вооружённого — `PoseDriver.setArmed`, монстры без неё).
 * Держится и в покое, и на ходу (щит/меч не болтаются). Крутится панелью G. X впер/наз, Z вбок, Y скрутка.
 * Левая — ЩИТ (вверх-вперёд гардом), правая — МЕЧ (отведена, клинок вперёд). Ноги-стойка — позже (планировщик).
 */
export const GUARD = {
  shLX: -0.5, shLY: 0, shLZ: 0.45, elL: 1.45,    // щит: плечо вперёд+вбок, локоть ~90°
  shRX: -0.35, shRY: 0, shRZ: 0.25, elR: 1.15,   // меч: плечо чуть вперёд+вбок, локоть согнут
  wRX: 0, wRY: 0, wRZ: 0,                         // запястье меча: X сгиб, Y скрутка (клинок вокруг оси руки), Z вбок
  lean: 0.12,                                    // корпус чуть вперёд
};

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

/** Catmull-Rom по опорным точкам [x,z] (равномерная, концы продублированы), параметр u∈[0,1]. 2 точки → прямой лерп. */
function crAt(pts: [number, number][], u: number): [number, number] {
  const n = pts.length;
  if (n <= 1) return pts[0] ?? [0, 0];
  if (n === 2) { const a = pts[0]!, b = pts[1]!; return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]; }
  const seg = (n - 1) * clamp(u, 0, 1); let i = Math.floor(seg); if (i > n - 2) i = n - 2; const t = seg - i;
  const p0 = pts[Math.max(0, i - 1)]!, p1 = pts[i]!, p2 = pts[i + 1]!, p3 = pts[Math.min(n - 1, i + 2)]!;
  const t2 = t * t, t3 = t2 * t;
  const cr = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])];
}

const SIDESTEP_DUR = 0.18;   // сек: длительность приставного шага (перенос стопы дугой к слоту стойки при повороте на месте)
const SETTLE_EPS = 2;        // u: стопы ближе этого к своим плантам → замираем (idle-поза); иначе footlock (стопа прибита к миру)

class StepPlanner {
  private legs: [Leg, Leg] = [
    { px: 0, pz: 0, sw: 0, fx: 0, fz: 0, tx: 0, tz: 0 },
    { px: 0, pz: 0, sw: 0, fx: 0, fz: 0, tx: 0, tz: 0 },
  ];
  private placed = false;
  private settled = false;   // стоим смирно (гистерезис против топтания на месте)
  private prevYaw = 0;       // рыск прошлого кадра
  private yawRate = 0;       // СГЛАЖЕННАЯ скорость поворота (рад/с) — сим 30Гц/физика 60Гц иначе мигает
  private hipY = STAND_Y;
  /** ФАКТИЧЕСКОЕ положение щиколоток из физики (мир). Плантуем туда, где нога реально стоит. */
  private actual: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  /** Фаза походки (рад): π = один шаг. Ей же машем руками, чтобы они шли в такт ногам. */
  phase = 0;
  /** Сглаженная «доля хода» 0..1+ от реальной скорости тела. Рэгдоллу setMove не зовут — руки машут от неё. */
  moveAmt = 0;
  /** Планировщик АКТИВНО переступает (идём или подшаг/разворот на месте) — потребителю: показывать ноги гейта, а не idle. */
  get stepping(): boolean { return !this.settled; }
  /** Какие ноги сейчас в переносе (для тестов/отладки порядка приставных шагов). */
  get swing(): [boolean, boolean] { return [this.legs[0]!.sw > 0, this.legs[1]!.sw > 0]; }

  setFeet(lx: number, lz: number, rx: number, rz: number): void {
    this.actual[0][0] = lx; this.actual[0][1] = lz;
    this.actual[1][0] = rx; this.actual[1][1] = rz;
  }

  /** Авторский сдвиг плант-цели (body-local: fwd вдоль facing, lat вправо) на ногу. Дефолт [0,0] → без эффекта. */
  private plantOff: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  setPlantOffset(lF: number, lL: number, rF: number, rL: number): void {
    this.plantOff[0][0] = lF; this.plantOff[0][1] = lL; this.plantOff[1][0] = rF; this.plantOff[1][1] = rL;
  }
  /** Точки ОБВОДА свинга на ногу (body-local fwd,lat от бедра): маховая летит liftoff → via… → плант, огибая опорную.
   *  Пусто → прямой свинг (нейтрально). Индексы: 0 = левая, 1 = правая. */
  private plantVia: [[number, number][], [number, number][]] = [[], []];
  setPlantVia(lVia: [number, number][], rVia: [number, number][]): void { this.plantVia[0] = lVia; this.plantVia[1] = rVia; }
  /** ПЛАНТ каждой ноги = ТОЧКА стопы в idle-стойке отн. таза (body-local): lat (X, знак = своя сторона) + fwd (Z).
   *  Дефолт = ±полуширина таза (нога 0/левая на +X — под её кость). Стоя стопы В ЭТИХ точках, поворот переступает в них. */
  private stanceLatL = HIP_DX; private stanceFwdL = 0; private stanceLatR = -HIP_DX; private stanceFwdR = 0;
  /** Базовая высота таза = высота таза в idle-стойке (замер). Гейт/подшаг НЕ поднимают таз выше неё → нет подскока. */
  private standY = GAIT.standY;
  setStance(latL: number, fwdL: number, latR: number, fwdR: number, standY?: number): void {
    this.stanceLatL = latL; this.stanceFwdL = fwdL; this.stanceLatR = latR; this.stanceFwdR = fwdR;
    if (standY !== undefined) { this.standY = standY; this.hipY = standY; }
  }
  /** Фаза приставного шага КАЖДОЙ ноги (0 = стоит, 0..1 = переносится к планту). */
  private sideT: [number, number] = [0, 0];
  private yawSigned = 0;                          // сглаженная скорость поворота СО ЗНАКОМ (>0 вправо/по часовой, <0 влево)
  /** Текущая плант-цель ноги i в мире (свинг-цель tx/tz или опорная px/pz) — для наземных маркеров редактора. */
  getTarget(i: number): [number, number] { const l = this.legs[i]!; return l.sw > 0 ? [l.tx, l.tz] : [l.px, l.pz]; }

  private reset(px: number, pz: number, fx: number, fz: number, rx: number, rz: number): void {
    for (let i = 0; i < 2; i++) {
      const lat = i === 0 ? this.stanceLatL : this.stanceLatR, fwd = i === 0 ? this.stanceFwdL : this.stanceFwdR;
      const l = this.legs[i]!;
      l.px = px + rx * lat + fx * fwd; l.pz = pz + rz * lat + fz * fwd; l.sw = 0;   // стартуем сразу в планте стойки
    }
    this.placed = true;
  }


  update(dt: number, px: number, pz: number, yaw: number, vx: number, vz: number): { l: LegAngles; r: LegAngles; bobY: number } {
    // Оси тела в мире: вперёд = локальный +Z, вправо = локальный +X.
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    if (!this.placed || Math.hypot(this.legs[0].px - px, this.legs[0].pz - pz) > 100) this.reset(px, pz, fx, fz, rx, rz);

    // Сглаженная скорость поворота (рад/с). Сырая мигает [0.1,0,0.1,0] из-за сим 30Гц / физика 60Гц.
    if (dt > 0) {
      let dyr = yaw - this.prevYaw;
      while (dyr > Math.PI) dyr -= Math.PI * 2; while (dyr < -Math.PI) dyr += Math.PI * 2;
      this.yawRate += (Math.abs(dyr) / dt - this.yawRate) * Math.min(1, dt * 10);
      this.yawSigned += (dyr / dt - this.yawSigned) * Math.min(1, dt * 10);   // со знаком: >0 вправо, <0 влево (для порядка шагов)
      this.prevYaw = yaw;
    }
    const speed = Math.hypot(vx, vz);
    // Доля хода для рук/наклона (0 стоя … ~1 быстрый шаг). Сглаживаем — сырая скорость мигает (сим 30/физ 60).
    if (dt > 0) this.moveAmt += (clamp(speed / GAIT.speedWalk, 0, 1.4) - this.moveAmt) * Math.min(1, dt * 8);
    const moving = speed > MOVE_EPS;
    const mx = moving ? vx / speed : 0, mz = moving ? vz / speed : 0;
    const stepLen = clamp(GAIT.stepBase + speed * GAIT.stepK, GAIT.stepBase, GAIT.stepMax) / Math.max(0.1, GAIT.cadence);   // cadence>1 → короче шаг → чаще семенит (частота цикла), путь px не трогаем

    // 1. РИТМ. Фаза едет от ПРОЙДЕННОГО ПУТИ: π = один шаг. Ноги чередуются строго по фазе.
    //    Раньше шаг запускался по накопленному отставанию — и пока одна нога в переносе, вторая ждала
    //    очереди и уезжала назад на весь шаг: нога плантовалась на +16, а уходила на −31, центр шага
    //    смещался за спину («семенит сзади тела»). При ритме опорная уходит назад ровно на полшага.
    // Стоим, но стопа уехала (добежали и встали) — доводим её ШАГОМ: крутим фазу, пока не переступит.
    // Раньше плант просто телепортировался под таз — это и был рывок «подшагивания» на медленном ходу.
    // ЗАМОРОЗКА СТОЙКИ. При duty<0.5 почти всегда одна нога в воздухе, поэтому «стоя» фаза сама не
    // остановится (окна переноса двух ног сдвинуты на π) — топчется вечно. Нужен явный флаг: стоим и стопы
    // под тазом → замираем (обе на земле, фаза стоит). Гистерезис ×1.7 против дёрганья у порога. idleStep — в панели.
    if (moving) {
      this.settled = false;
      this.sideT[0] = 0; this.sideT[1] = 0;                     // ход перебивает приставные шаги
      this.phase += (speed * dt / stepLen) * Math.PI;
    } else {
      // СТОИМ. Ноги держат ПЛАНТЫ idle-стойки (точки стоп отн. таза), приколотые к миру; таз крутится ОТНОСИТЕЛЬНО них.
      // Плант каждой ноги крутится вместе с yaw. Стопа отъехала от своего планта дальше turnStepDist — ПРИСТАВНОЙ ШАГ ровно
      // в плант (idl-стойка в новом фейсинге). Ноги НЕЗАВИСИМО (не ждут друг друга → опорная не перекручивается за таз = не X).
      const stanceX = (i: number): number => px + rx * (i === 0 ? this.stanceLatL : this.stanceLatR) + fx * (i === 0 ? this.stanceFwdL : this.stanceFwdR);
      const stanceZ = (i: number): number => pz + rz * (i === 0 ? this.stanceLatL : this.stanceLatR) + fz * (i === 0 ? this.stanceFwdL : this.stanceFwdR);
      const turning = this.yawRate > GAIT.turnStep;
      // ПРИОРИТЕТ ведущей ноги: внутренняя (в сторону поворота) шагает РАНЬШЕ — её порог × turnLeadBias, но БЕЗ ожидания второй.
      // По факту в игре: поворот ПРОТИВ часовой (сверху) → первой ЛЕВАЯ (нога 0); ПО часовой → правая (нога 1).
      const inside = this.yawSigned > 0 ? 0 : 1;
      for (let i = 0; i < 2; i++) {                            // 1) двигаем текущие переносы к планту
        const l = this.legs[i]!;
        if (l.sw <= 0) continue;
        let st = this.sideT[i]! + dt / SIDESTEP_DUR;
        if (st >= 1) { l.px = l.tx; l.pz = l.tz; l.sw = 0; st = 0; }
        else l.sw = clamp(st, 0.001, 1);
        this.sideT[i] = st;
      }
      const startStep = (i: number): void => { const l = this.legs[i]!; l.fx = l.px; l.fz = l.pz; l.tx = stanceX(i); l.tz = stanceZ(i); this.sideT[i] = 0; l.sw = 0.001; };
      // 2) FOOTLOCK: опорная стопа ЖЁСТКО стоит в мире (l.px не двигаем) при ЛЮБОЙ скорости поворота — не скользит.
      //    Шаг по РАССТОЯНИЮ стопа↔(повёрнутый) плант, а не по скорости: медленно крутишь → дистанция копится → подшаг.
      let maxDist = 0;
      for (let i = 0; i < 2; i++) {
        const l = this.legs[i]!; if (l.sw > 0) continue;
        const dist = Math.hypot(l.px - stanceX(i), l.pz - stanceZ(i));
        maxDist = Math.max(maxDist, dist);
        let thr = GAIT.turnStepDist;
        if (turning && i === inside) thr *= GAIT.turnLeadBias;   // ведущая (внутренняя) нога шагает раньше — только при повороте
        // Страховка от X: опорная стопа перешла среднюю линию (знак её body-local lat ≠ знаку планта) → форс-шаг.
        const plantLat = i === 0 ? this.stanceLatL : this.stanceLatR;
        const footLat = (l.px - px) * rx + (l.pz - pz) * rz;
        const crossed = Math.abs(plantLat) > 0.1 && Math.sign(footLat) !== Math.sign(plantLat) && Math.abs(footLat) > 1;
        if (dist > thr || crossed) startStep(i);
      }
      const anySwing = this.legs[0]!.sw > 0 || this.legs[1]!.sw > 0;
      // ЗАМИРАНИЕ (отпустить ноги в чистую idle-позу, legMag→0) — ТОЛЬКО когда обе стопы уже в своих плантах (без свинга).
      // Иначе не settled → рендер держит МИРОВУЮ (прибитую) стопу, а не idle-позу-за-тазом → при повороте стопа стоит, не едет.
      if (anySwing || maxDist > SETTLE_EPS) this.settled = false;
      else if (!this.settled) {                                // покой → замираем РОВНО В ПЛАНТАХ стойки (idl-точки)
        this.settled = true;
        for (let i = 0; i < 2; i++) { const l = this.legs[i]!; l.px = stanceX(i); l.pz = stanceZ(i); l.sw = 0; }
      }
    }

    // 2. ОКНА ОПОРЫ по доле. У ноги i опора отцентрована на фазе i·π и занимает 2π·duty цикла; остальное —
    //    перенос. duty<0.5 → между опорами обе ноги в воздухе (фаза полёта) — это и есть бег.
    const duty = clamp(GAIT.dutyWalk + (GAIT.dutyRun - GAIT.dutyWalk) * ((speed - GAIT.speedWalk) / (GAIT.speedRun - GAIT.speedWalk)), GAIT.dutyRun, GAIT.dutyWalk);
    // Вынос стопы вперёд (относительно бедра): база шаг·доля + ручки панели.
    const lead = stepLen * duty + stepLen * GAIT.aheadMul + speed * GAIT.predictSec;
    // Анти-столкновение стоп: если цель ноги i ближе footClear к ДРУГОЙ стопе — увести цель ВПЕРЁД
    // (обойти спереди), а не влезать в неё. Так приставной шаг перестаёт «врезаться нога в ногу».
    const avoid = (l: Leg, oi: number): void => {
      const o = this.legs[oi]!;
      const dx = l.tx - o.px, dz = l.tz - o.pz;
      const lat = Math.abs(dx * rx + dz * rz);          // боковой зазор
      if (lat >= GAIT.footClear) return;
      const fwdNeed = Math.sqrt(GAIT.footClear * GAIT.footClear - lat * lat);
      const fwd = dx * fx + dz * fz;                     // текущий продольный зазор
      if (Math.abs(fwd) >= fwdNeed) return;
      const add = (fwdNeed - Math.abs(fwd)) * (fwd >= 0 ? 1 : -1);
      l.tx += fx * add; l.tz += fz * add;
    };
    // Плант-цель ноги: вынос раскладываем на продольную/боковую компоненты по осям facing → форма стойки
    // (stanceWidth/strafeReach) + авторский offset (plantOff). Нейтрально при дефолтах: ортонормир. базис даёт
    // fx·(reach·mFwd) + rx·(reach·mLat) = reach·mx (и аналогично z) = прежняя цель hx + mx·reach.
    const mFwd = mx * fx + mz * fz, mLat = mx * rx + mz * rz;
    const plant = (l: Leg, i: number, hx: number, hz: number, reach: number): void => {
      const off = this.plantOff[i]!, side = i === 0 ? 1 : -1;   // нога 0 = ЛЕВАЯ на +X (см. якорь бедра)
      const fwdAmt = reach * mFwd + off[0];
      let latAmt = reach * mLat * GAIT.strafeReach + GAIT.stanceWidth * side + off[1];
      if (side * latAmt < -GAIT.crossClamp) latAmt = -side * GAIT.crossClamp;   // не заходить за среднюю линию дальше crossClamp
      l.tx = hx + fx * fwdAmt + rx * latAmt; l.tz = hz + fz * fwdAmt + rz * latAmt;
      avoid(l, 1 - i);
    };
    const TAU = Math.PI * 2, half = Math.PI * duty;
    if (!moving) { /* стоим: ноги ведёт стационарная логика выше (стойка / приставной шаг) — sw уже выставлен */ }
    else for (let i = 0; i < 2; i++) {
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
          const s = i === 0 ? HIP_DX : -HIP_DX;   // нога 0 = ЛЕВАЯ, её кость LeftUpperLeg сидит на +X (humanoid.ts) → якорь +X
          const hx = px + rx * s, hz = pz + rz * s;
          // fixTarget: цель фиксируется здесь. Прибавляем пролёт тела за перенос (1−доля)·2·шаг — к касанию
          // бедро будет там, стопа приземлится на `lead` впереди. Иначе цель едет за бедром (пересчёт ниже).
          const fly = GAIT.fixTarget ? stepLen * (1 - duty) * 2 : 0;
          plant(l, i, hx, hz, lead + fly);
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
      const s = i === 0 ? HIP_DX : -HIP_DX;   // нога 0 = ЛЕВАЯ, её кость LeftUpperLeg сидит на +X (humanoid.ts) → якорь +X
      const hx = px + rx * s, hz = pz + rz * s;
      maxLz = Math.max(maxLz, Math.abs((l.px - hx) * fx + (l.pz - hz) * fz));
    }
    const reach = LEG * 0.97;
    // База таза = this.standY (высота таза в idle-стойке). Кинематика может дать выше (нога прямее) — КЛАМПИМ к базе,
    // чтобы бег/подшаг НЕ поднимали таз выше стойки (тот самый подскок). Ниже базы просесть можно (разъезд ног).
    const wantY = anyStance
      ? clamp(FOOT_Y + Math.sqrt(Math.max(0, reach * reach - maxLz * maxLz)), GAIT.pelvisMin, this.standY)
      : this.standY;
    // Сглаживание: на бегу — всегда (вход/выход из полёта). На ШАГЕ асимметрично: ВНИЗ (ноги разъезжаются,
    // wantY плавно падает по геометрии) берём как есть — иначе таз запаздывает и волочит опорную ногу; а ВВЕРХ
    // (смена опорной — wantY скачком растёт) сглаживаем, иначе резкий дёрг таза вверх при ходьбе.
    const rising = wantY > this.hipY;
    const lag = speed > GAIT.speedWalk ? Math.min(1, dt * 14) : rising ? Math.min(1, dt * 10) : 1;
    this.hipY += (wantY - this.hipY) * lag;
    const hipY = this.hipY;
    const out: LegAngles[] = [];
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i]!;
      const s = i === 0 ? HIP_DX : -HIP_DX;   // нога 0 = ЛЕВАЯ, её кость LeftUpperLeg сидит на +X (humanoid.ts) → якорь +X
      const hx = px + rx * s, hz = pz + rz * s;
      let wx: number, wz: number, wy: number;
      if (l.sw > 0) {
        // Маховая. При fixTarget цель зафиксирована на отрыве (выше). Иначе — едет за бедром: держится
        // на `lead` впереди ТЕКУЩЕГО бедра (пересчёт каждый кадр).
        if (!GAIT.fixTarget && moving) plant(l, i, hx, hz, lead);   // стоя приставной шаг держит зафиксированную цель (слот стойки)
        const t = l.sw, e = t * t * (3 - 2 * t);
        const via = this.plantVia[i]!;
        if (via.length === 0) { wx = l.fx + (l.tx - l.fx) * e; wz = l.fz + (l.tz - l.fz) * e; }   // прямой свинг (нейтрально)
        else {   // ОБВОД: маховая летит liftoff → via (body-local fwd,lat от бедра) → плант, огибая опорную ногу
          const ctrl: [number, number][] = [[l.fx, l.fz]];
          for (const v of via) ctrl.push([hx + fx * v[0] + rx * v[1], hz + fz * v[0] + rz * v[1]]);
          ctrl.push([l.tx, l.tz]);
          const p = crAt(ctrl, e); wx = p[0]; wz = p[1];
        }
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
  private stanceLatL = HIP_DX; private stanceFwdL = 0; private stanceLatR = -HIP_DX; private stanceFwdR = 0; private standY = GAIT.standY;
  private w = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 };
  private armed = false;  // вооружён меч+щит → в покое/на ходу держит боевой ГАРД (не машет руками)
  readonly out: PoseTargets = {
    hipL: 0, hipR: 0, knL: 0, knR: 0, hipLatL: 0, hipLatR: 0, shL: 0, shR: 0, elL: 0, elR: 0,
    lean: 0, twist: 0, bobY: 0, splay: 0,
    shTwL: 0, shTwR: 0, shSpL: 0, shSpR: 0, hipTwL: 0, hipTwR: 0, leanSide: 0, headNod: 0, headTurn: 0, headTilt: 0,
    wLX: 0, wLY: 0, wLZ: 0, wRX: 0, wRY: 0, wRZ: 0,
  };

  setMove(s: number): void { this.move = Math.max(0, Math.min(1.4, s)); }
  /** Включает походку с опорой: позиция/рыск/скорость тела в мире (юниты, u/с). */
  setWorld(x: number, z: number, yaw: number, vx: number, vz: number): void {
    if (!this.planner) { this.planner = new StepPlanner(); this.planner.setStance(this.stanceLatL, this.stanceFwdL, this.stanceLatR, this.stanceFwdR, this.standY); }
    this.w.x = x; this.w.z = z; this.w.yaw = yaw; this.w.vx = vx; this.w.vz = vz;
  }
  /** Обратная связь от физики: где НА САМОМ ДЕЛЕ стоят щиколотки (мир). Плантуем по факту, а не по расчёту. */
  setFeet(lx: number, lz: number, rx: number, rz: number): void { this.planner?.setFeet(lx, lz, rx, rz); }
  /** Авторский сдвиг плант-цели (body-local fwd/lat) на ногу — для редактора. Дефолт 0 → без эффекта. */
  setPlantOffset(lF: number, lL: number, rF: number, rL: number): void { this.planner?.setPlantOffset(lF, lL, rF, rL); }
  /** Точки обвода свинга на ногу (body-local fwd,lat). Пусто → прямой свинг. */
  setPlantVia(lVia: [number, number][], rVia: [number, number][]): void { this.planner?.setPlantVia(lVia, rVia); }
  /** Планты стоп из idle-стойки: по каждой ноге body-local (lat, fwd) СО ЗНАКОМ + базовая высота таза standY (всё замер
   *  measureStancePlants). Стоя держит стопы в этих точках, при повороте переступает в них; таз не поднимается выше standY. */
  setStance(latL: number, fwdL: number, latR: number, fwdR: number, standY?: number): void {
    this.stanceLatL = latL; this.stanceFwdL = fwdL; this.stanceLatR = latR; this.stanceFwdR = fwdR;
    if (standY !== undefined) this.standY = standY;
    this.planner?.setStance(latL, fwdL, latR, fwdR, standY);
  }
  /** Текущая плант-цель ноги i в мире (для наземных маркеров редактора). */
  plantTarget(i: number): [number, number] { return this.planner ? this.planner.getTarget(i) : [0, 0]; }
  /** Планировщик активно переступает (ход / подшаг при развороте на месте). */
  get stepping(): boolean { return this.planner ? this.planner.stepping : false; }
  /** Какие ноги в переносе [левая, правая] — для тестов/отладки порядка приставных шагов. */
  get swingLegs(): [boolean, boolean] { return this.planner ? this.planner.swing : [false, false]; }
  attack(power = 1): void { if (!this.dead) { this.attackT = ATTACK_DUR; this.attackPow = power; } }
  setDead(d: boolean): void { this.dead = d; }
  get isDead(): boolean { return this.dead; }
  /** Вооружён меч+щит → боевой гард (GUARD) вместо расслабленных рук. */
  setArmed(on: boolean): void { this.armed = on; }
  /** Идёт ли взмах (для триггера VFX/звука). */
  get attacking(): boolean { return this.attackT > 0; }

  update(dt: number): PoseTargets {
    const o = this.out;
    // Доп. оси нужны только вооружённому (ГАРД меч+щит) — в процедурке всегда 0 (иначе стухшие значения «прилипнут»).
    o.shTwL = o.shTwR = o.shSpL = o.shSpR = 0; o.hipTwL = o.hipTwR = 0; o.leanSide = 0;
    o.headNod = o.headTurn = o.headTilt = 0;
    o.wLX = o.wLY = o.wLZ = o.wRX = o.wRY = o.wRZ = 0;
    if (this.dead) {
      o.splay = 1; o.bobY = -26; o.lean = 1.4; o.twist = 0;
      o.hipL = 0.7; o.hipR = -0.7; o.knL = 1.2; o.knR = 1.2; o.shL = 0.7; o.shR = -0.7; o.elL = 1.2; o.elR = 1.2;
      return o;
    }
    // «Ход» для рук/наклона: кинематике (монстры) — из setMove, рэгдоллу — из реальной скорости тела
    // (setMove ему не зовут), которую планировщик отдаёт сглаженной в moveAmt.
    let drive = this.move;

    if (this.planner) {
      const w = this.w;
      const g = this.planner.update(dt, w.x, w.z, w.yaw, w.vx, w.vz);
      o.hipL = g.l.hip; o.knL = g.l.knee; o.hipLatL = g.l.lat;
      o.hipR = g.r.hip; o.knR = g.r.knee; o.hipLatR = g.r.lat;
      o.bobY = g.bobY;
      this.phase = this.planner.phase;
      drive = this.planner.moveAmt;
    } else {
      const walk0 = this.move > 0.05;
      this.phase += (walk0 ? 2.2 + this.move * 3.2 : 1.3) * dt;
      const s0 = Math.sin(this.phase), s2 = Math.sin(this.phase * 2);
      const a0 = walk0 ? 0.45 + this.move * 0.4 : 0;
      o.hipL = s0 * a0; o.hipR = -s0 * a0;
      o.knL = Math.max(0, -s0) * a0 * 1.3 + (walk0 ? 0.12 : 0);
      o.knR = Math.max(0, s0) * a0 * 1.3 + (walk0 ? 0.12 : 0);
      o.bobY = walk0 ? Math.abs(s2) * 2.0 : Math.sin(this.phase) * 0.7;
    }

    const walking = drive > 0.05;
    const s = Math.sin(this.phase);
    const amp = walking ? 0.45 + drive * 0.4 : 0;
    o.lean = walking ? 0.05 + drive * 0.06 : 0.02;
    o.splay = 0;

    if (this.attackT <= 0 && this.armed) {
      // БОЕВОЙ ГАРД меч+щит: держим позу всегда (и в покое, и на ходу — не машем).
      // ⚠️ Риг L/R зеркальны: роль ЩИТ (GUARD.*L, визуально слева) шлём на R-кости, роль МЕЧ (GUARD.*R,
      // визуально справа) — на L-кости. Так панель («щит/меч») человеко-корректна, а стороны верные.
      o.shR = GUARD.shLX; o.shSpR = GUARD.shLZ; o.shTwR = GUARD.shLY; o.elR = GUARD.elL;   // ЩИТ (виз. слева)
      o.shL = GUARD.shRX; o.shSpL = GUARD.shRZ; o.shTwL = GUARD.shRY; o.elL = GUARD.elR;   // МЕЧ (виз. справа)
      o.wLX = GUARD.wRX; o.wLY = GUARD.wRY; o.wLZ = GUARD.wRZ;                              // запястье меча (L-кисть)
      o.lean = GUARD.lean; o.twist = 0;
    } else if (this.attackT <= 0) {
      // ПОЗА РУК (без оружия). База в покое: плечи чуть вперёд (POSE.armSh), локти согнуты (POSE.armEl) — чтобы
      // не висели палками. На ходу машем вокруг базы (анти-фаза ног), локоть добираем сгиб.
      const sw = amp * POSE.armSwing;
      o.shL = POSE.armSh - s * sw; o.shR = POSE.armSh + s * sw;
      o.elL = POSE.armEl + amp * POSE.armElWalk; o.elR = POSE.armEl + amp * POSE.armElWalk;
      o.twist = s * amp * 0.15;
    } else {
      this.attackT -= dt;
      const p = 1 - this.attackT / ATTACK_DUR;                 // 0..1 по ходу взмаха
      const ss = (t: number): number => { const c = clamp(t, 0, 1); return c * c * (3 - 2 * c); };
      // УДАР МЕЧОМ СВЕРХУ. Замах: правая рука вверх (плечо назад-вверх), локоть согнут, корпус чуть назад →
      // Удар: резко вниз-вперёд, локоть разгибается, корпус вперёд + доворот → Возврат в стойку.
      // Замах — ОТВЕДЕНИЕМ (плечо вбок-вверх, shSpR): плечо по X только машет назад-вперёд и упирается в конус,
      // а НАЗАД рука прячется за спину («тычок»). Отведение вбок видно с изо-камеры как поднятая рука. Удар —
      // по диагонали вниз-поперёк-вперёд (shSpR→0, shR→вперёд, локоть разгибается) — хлёсткий рубящий мах.
      let shR: number, shSp: number, elR: number;
      if (p < 0.36) {                                          // ЗАМАХ: рука вверх-вбок, локоть взведён
        const t = ss(p / 0.36);
        shR = lerp(POSE.armSh, -0.25, t); shSp = lerp(0, 1.2, t); elR = lerp(POSE.armEl, 1.35, t);
        o.lean = lerp(0.02, -0.06, t); o.twist = lerp(0, -0.2, t);
      } else if (p < 0.68) {                                   // УДАР: рука падает со стороны ВНИЗ-вперёд (диагональ)
        const t = ss((p - 0.36) / 0.32);
        shR = lerp(-0.25, -0.45, t); shSp = lerp(1.2, -0.1, t); elR = lerp(1.35, 0.15, t);
        o.lean = lerp(-0.06, 0.24, t); o.twist = lerp(-0.2, 0.26, t);
      } else {                                                 // ВОЗВРАТ в стойку
        const t = ss((p - 0.68) / 0.32);
        shR = lerp(-0.45, POSE.armSh, t); shSp = lerp(-0.1, 0, t); elR = lerp(0.15, POSE.armEl, t);
        o.lean = lerp(0.24, 0.02, t); o.twist = lerp(0.26, 0, t);
      }
      // ⚠️ Риг L/R зеркальны: МЕЧ визуально СПРАВА = L-кости. Машем L-рукой, twist зеркалим.
      o.shL = shR; o.shSpL = shSp; o.elL = elR;
      o.twist = -o.twist;
      if (this.armed) {   // off-рука (виз. слева = R-кости) держит щит-гард
        o.shR = GUARD.shLX; o.shSpR = GUARD.shLZ; o.shTwR = GUARD.shLY; o.elR = GUARD.elL;
      } else {
        o.shR = POSE.armSh; o.elR = POSE.armEl;                // не-бьющая рука в базовой позе
      }
    }
    return o;
  }
}
