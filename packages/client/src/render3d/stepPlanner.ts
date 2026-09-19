/**
 * ⭐⭐ ПРОЦЕДУРНЫЙ ПЛАНИРОВЩИК ШАГОВ И ЕГО ПРИВОД (`StepPlanner` + `PoseDriver`).
 *
 * Генератор ЦЕЛЕВОЙ позы (углы суставов) без клипов: шаги планируются в мире (опорная стопа
 * приколота к точке на полу, маховая переносится дугой), углы бедра/колена даёт 2-костная IK. Стопы не едут.
 * Все углы — маховые, вокруг локальной оси X кости. Знаки: колено гнётся НАЗАД (+), локоть — ВПЕРЁД.
 *
 * ⚠⚠ КОМУ ЭТОТ МОДУЛЬ НУЖЕН. Редактор (вкладка «Бег») и ЗАПЕКАТЕЛЬ: именно отсюда берётся
 * движение, которое запекается в клипы. Игра ходит КЛИПАМИ и планировщик НЕ исполняет.
 *
 * Разрезано из `pose.ts` (Э11). Зависимость СТРОГО ОДНОСТОРОННЯЯ: отсюда в `gaitKnobs.ts`, никогда обратно.
 * Константы и хелперы ниже (`ATTACK_DUR`, `lerp`, `walkingAmp`, длины костей, `STAND_Y`, `RIG_PELVIS_Y`,
 * `MOVE_EPS`, `smooth01`) лежали в блоке ручек, но читал их ТОЛЬКО планировщик — переехали сюда вместе с ним.
 *
 * Файл ЧИСТЫЙ: ни THREE, ни DOM.
 */
import {
  GAIT, POSE, ASYM, STRAFE, STRAFE_R, STRAFE_L, BACK, COMBAT,
  HIP_DX, FOOT_Y, STRAFE_SIDE_BAND, GUARD,
  clamp, locoVal, sideLerp, sideOf, strafeSideOf, strafeSide, strafeMix, backMix, toeCurve, foldElbow,
  type PoseTargets, type StanceFoot, type LocoMix,
} from './gaitKnobs.js';

const ATTACK_DUR = 0.62;   // взмах небыстрый: мотор рук физически не развернёт большой мах за 0.1с (иначе рука «зависает»)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Амплитуда маха по «доле хода»: 0 стоя, растёт с движением. Одна на руки и на плечевой пояс. */
/**
 * ОБЩАЯ АМПЛИТУДА МАХА от «доли хода»: база плюс прибавка от скорости. Была зашита числами
 * `0.45 + drive·0.4`, теперь это две ручки — на неё множится ВСЁ качание (руки, плечи, скрутка),
 * поэтому ею регулируется «живость» походки целиком, не трогая каждую ось по отдельности.
 */
const walkingAmp = (drive: number): number => (drive > 0.05 ? POSE.swingBase + drive * POSE.swingSpeed : 0);
// ── Походка с опорой ───────────────────────────────────────────────────────────
// Длины костей — строго по риг-таблице BONES: бедро 30→15, голень 15→1.5 (НЕ 15! иначе IK считает ногу
// длиннее, чем она есть, и стопа не достаёт до пола).
// ⚠ Это размеры ПРОЦЕДУРНОГО манекена и только его. У модели длины берутся из рига
// (`Humanoid.legRest` → `StepPlanner.legRest`), см. `thighL`/`shinL`/`hipHalf` ниже.
const L_THIGH = 15, L_SHIN = 13.5, LEG = L_THIGH + L_SHIN;
/**
 * Высота таза в стойке. КРИТИЧНО: заметно МЕНЬШЕ длины ноги (30). При таз=30 нога выпрямлена в струну,
 * стопа дотягивается только до точки прямо под тазом — шаг невозможен в принципе. 26.5 → колени чуть
 * согнуты (как у человека) и появляется вылет стопы ~17u, т.е. шаг ~1 м.
 */
export const STAND_Y = 27;   // высота таза стоя (для init позы; живая — в GAIT.standY)
const RIG_PELVIS_Y = 30;     // высота таза в опорной позе рига (таблица BONES в ragdoll.ts)
const MOVE_EPS = 8;          // ниже этой скорости (u/с) считаем, что стоим
/** Сглаженная ступенька 0..1 (smoothstep): нулевая производная на обоих концах — вход в опору без рывка. */
const smooth01 = (t: number): number => t * t * (3 - 2 * t);

interface Leg {
  px: number; pz: number;   // точка опоры в МИРЕ (стопа прибита сюда, пока нога опорная)
  sw: number;               // 0 — на земле, (0..1] — доля переноса
  fx: number; fz: number;   // откуда переносим
  tx: number; tz: number;   // куда переносим
}
interface LegAngles { hip: number; knee: number; lat: number; ank: number }

/**
 * 2-костная IK в сагиттальной плоскости тела: вектор от бедра к стопе в мире (dx,dz) + по высоте (dy<0).
 * Боковую составляющую игнорируем — бедро в риге машет только вокруг X (вперёд-назад), боковой баланс
 * будет отдельным этапом.
 */
function ik(dx: number, dz: number, dy: number, fx: number, fz: number, rx: number, rz: number, fwdLim: number,
            th: number = L_THIGH, sh: number = L_SHIN): LegAngles {
  const lz = dx * fx + dz * fz;                         // вперёд-назад в теле
  const lx = dx * rx + dz * rz;                         // вбок в теле (+ = вправо)
  const d = clamp(Math.hypot(lz, lx, dy), 8, th + sh - 0.6);   // не даём ноге «переразогнуться»
  const thFoot = Math.atan2(lz, -dy);                   // куда смотрит стопа от бедра (0 = прямо вниз)
  const alpha = Math.acos(clamp((th * th + d * d - sh * sh) / (2 * th * d), -1, 1));
  const beta = Math.acos(clamp((th * th + sh * sh - d * d) / (2 * th * sh), -1, 1));
  // Колено (сустав) при сгибе уходит ВПЕРЁД, а голень — назад (пятка к заду). Значит бедро отклонено от
  // линии «бедро→стопа» вперёд: θ_бедра = θ_стопы + α. Положительный hip уводит кость назад (−Z) →
  // hip = −θ_бедра. Проверка: стопа под бедром (d=25) → hip=−0.586, колено 1.17 → стопа ровно в цели.
  // Боковой вынос — отдельным углом вокруг Z (положительный уводит кость вправо, +X).
  let hip = -(thFoot + alpha);
  // МЯГКИЙ ПОТОЛОК ВПЕРЁД (hip<0 = нога вперёд). При постановке стопы далеко впереди IK выдаёт шип до
  // −1.9 рад (109°) — мотор такой скачок не тянет: недобирает и опаздывает на 2-3 кадра, нога плетётся
  // сзади. Живая нога выносится ~50°. tanh-насыщение делает форвардную цель плавной и достижимой, зад
  // (hip>0, отработан идеально) не трогаем.
  const lim = fwdLim, soft = GAIT.hipFwdSoft;
  if (hip < -lim) hip = -(lim + soft * Math.tanh((-hip - lim) / soft));
  return { hip, knee: Math.PI - beta, lat: Math.atan2(lx, -dy), ank: 0 };
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
/**
 * ⭐ ДОСТУПАТЬ ШАГОМ ВСЁ, ЧТО ЗАМЕТНО. Раньше доводка шла по `SETTLE_EPS` = 2 u: стопа ближе двух
 * юнитов к планту просто ТЕЛЕПОРТИРОВАЛАСЬ в idle-стойку (`l.px = stanceX(i)`), и этот рывок до
 * двух единиц читался как «останавливаешься, а он доезжает ногами в стойку». Теперь всё дальше
 * четверти юнита доводится НАСТОЯЩИМ приставным шагом, а прибитая стопа не двигается вовсе.
 */
const SETTLE_STEP_EPS = 0.25;
const MAX_GOAL_LEAD = Math.PI * 0.4;   // рад (~72°): максимум, на сколько подшаг целит ВПЕРЁД таза к прицелу — флик курсора не даёт стопе скачок-прыжок

class StepPlanner {
  private legs: [Leg, Leg] = [
    { px: 0, pz: 0, sw: 0, fx: 0, fz: 0, tx: 0, tz: 0 },
    { px: 0, pz: 0, sw: 0, fx: 0, fz: 0, tx: 0, tz: 0 },
  ];
  private placed = false;
  private settled = false;   // стоим смирно (гистерезис против топтания на месте)
  private plantYaw: [number, number] = [0, 0];   // yaw таза в момент планта каждой стопы (предел ПО УГЛУ)
  private stableFor = 0;     // сек: сколько таз почти не крутится (для «доступить по времени»)
  private idleFor = 0;       // сек: сколько обе стопы дома и не крутимся (для ухода в idle по времени)
  private turnLead = -1;     // чья очередь шагать при повороте (внутренняя первой; чередование). -1 = поворот не начат
  private prevYaw = 0;       // рыск прошлого кадра
  sb = 0;                    // блен ходьба(0)↔бег(1) — читает PoseDriver для раздельных рук walk/run
  st = 0;                    // боковитость 0 (вперёд/назад) … 1 (чистый страйф) — колонка страйфа
  stR = 0; stL = 0;          // ДОЛИ боковитости по сторонам хода (сумма = st) — колонки `STRAFE_R`/`STRAFE_L`
  bt = 0;                    // назадность 0 (вперёд/вбок) … 1 (чистый ход спиной) — колонка «назад»
  combat = 0;                // мирно(0) ↔ бой(1) — ЧЕТВЁРТАЯ колонка: шире стойка, короче шаг (Ф6)
  private yawRate = 0;       // СГЛАЖЕННАЯ скорость поворота (рад/с) — сим 30Гц/физика 60Гц иначе мигает
  private hipY = STAND_Y;
  /** Цель высоты таза ПОСЛЕ предела скорости (`GAIT.bobSlew`). При пределе 0 всегда = сырой цели. */
  private hipWant = STAND_Y;
  private mAvgX = 0; private mAvgZ = 0; private mAvgOn = false;   // сглаженный вектор хода (направление планта)
  /**
   * РАЗМЕРЫ НОГИ РИГА — бедро, голень, полуширина таза. Ставит рантайм из `Humanoid.legRest`
   * (замер рест-позы модели); `null` = процедурный манекен → прежние константы бит в бит.
   *
   * ⚠ Раньше здесь стоял ЗАМЕРЕННЫЙ коэффициент `rigK`: планировщик считал в своих единицах
   * (нога 28.5, полутаз 3.6), а стопы приходили фидбэком из рига, и он подгонял одно под другое
   * отношением «факт/намерение» на каждом приземлении. Теперь подгонять нечего — обе стороны в
   * мире модели, и второй масштаб поверх настоящих длин считал бы поправку ДВАЖДЫ.
   */
  legRest: { thigh: number; shin: number; hipHalfW: number; hipDropY: number } | null = null;
  private get thighL(): number { return this.legRest?.thigh ?? L_THIGH; }
  private get shinL(): number { return this.legRest?.shin ?? L_SHIN; }
  private get hipHalf(): number { return this.legRest?.hipHalfW ?? HIP_DX; }
  /** Сустав бедра ниже начала таза (у рыцаря −3.67). Без неё нога просится на 3.6 длиннее, чем есть. */
  private get hipDrop(): number { return this.legRest?.hipDropY ?? 0; }
  /** Диагностика (редактор/тесты): во сколько раз сейчас ускорена фаза (`urgency`). */
  get debugUrge(): number { return this.lastUrge; }
  private lastUrge = 1;
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
  /**
   * ДОЛЯ ПРОЙДЕННОЙ ОПОРНОЙ ФАЗЫ каждой ноги: 0 = только что коснулась, 1 = вот-вот оторвётся.
   *
   * Заземлению нужен НЕПРЕРЫВНЫЙ вес, а `swing` — булев: в кадр его переключения стопа падала на пол
   * рывком. Фаза считается из того же `c`, по которому решается сама опорность (см. цикл ниже), так
   * что окно заземления и окно опоры — ОДНО И ТО ЖЕ, а не два разъезжающихся порога.
   * ⚠ Вне гейта (стоим, приставной шаг) цикла нет — отдаём 1: стоять надо твёрдо, на полном весе.
   */
  private supPhase: [number, number] = [1, 1];
  get supportPhase(): [number, number] { return [this.supPhase[0], this.supPhase[1]]; }
  /**
   * ВЕС ЗАЗЕМЛЕНИЯ на ногу 0..1 — окно опоры `GAIT.gndIn`/`gndOut` в долях опорной фазы.
   * Считается ЗДЕСЬ, а не у заземлителя, потому что здесь и фаза опоры, и колонки настроек
   * (`locoVal`: ходьба/бег, страйф, назад, бой) — иначе окно разъехалось бы с самой походкой.
   * Маховая нога — строго 0. Умолчания 0 и 1 дают вес 1 на всей опоре = прежнее поведение.
   */
  private gndW: [number, number] = [1, 1];
  get groundWeights(): [number, number] { return [this.gndW[0], this.gndW[1]]; }
  /**
   * ВЕС ПОСТАНОВКИ СТОПЫ 0..1: 0 = только коснулась (подошву ещё держит голеностоп), 1 = лежит на
   * полу целиком. Ramp длиной `GAIT.footPlant` от начала опорной фазы; 0 = мгновенно, как было.
   * Маховая нога — 1 (её заземление не трогает вовсе, а голеностоп ведёт своей формулой).
   */
  private plantW: [number, number] = [1, 1];
  get plantWeights(): [number, number] { return [this.plantW[0], this.plantW[1]]; }

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
   *  Дефолт = ±полуширина таза РИГА (нога 0/левая на +X — под её кость). Стоя стопы В ЭТИХ точках, поворот переступает в них. */
  private latL: number | null = null; private stanceFwdL = 0; private latR: number | null = null; private stanceFwdR = 0;
  private get stanceLatL(): number { return this.latL ?? this.hipHalf; }
  private get stanceLatR(): number { return this.latR ?? -this.hipHalf; }
  /** Базовая высота таза = высота таза в idle-стойке (замер). Гейт/подшаг НЕ поднимают таз выше неё → нет подскока. */
  private standY = GAIT.standY;
  /** Ориентация и ВЫСОТА стопы авторской стойки — планировщику нужна высота (см. `StanceFoot.lift`). */
  stanceFoot: StanceFoot = { pitchL: 0, yawL: 0, pitchR: 0, yawR: 0, liftL: 0, liftR: 0 };
  setStance(latL: number, fwdL: number, latR: number, fwdR: number, standY?: number, foot?: StanceFoot): void {
    if (foot) this.stanceFoot = foot;
    this.latL = latL; this.stanceFwdL = fwdL; this.latR = latR; this.stanceFwdR = fwdR;
    if (standY !== undefined) { this.standY = standY; this.hipY = standY; this.hipWant = standY; }
  }
  /**
   * НОГИ ЗАНЯТЫ СЛОТОМ ДЕЙСТВИЯ (удар с места делает подшаг из клипа).
   *
   * Пока это так, планировщик не начинает приставной шаг: иначе он потащит стопу «домой» прямо
   * посреди замаха и будет драться с клипом за ту же ногу. Уже начатый перенос доигрывается —
   * обрывать его посреди дуги хуже, чем дать закончить.
   */
  private legsHeld = false;
  setLegsHeld(v: boolean): void { this.legsHeld = v; }
  /**
   * ПЕРЕСАДИТЬ СТОПЫ В СТОЙКУ на следующем кадре (на курсе, который придёт в `update`).
   *
   * Нужна, когда ногами владел КЛИП, который сам развернул тело (поворот на месте): клип кончается в
   * idle-стойке уже на новом курсе, а планты планировщика остались на старом. Не пересадить — и он на
   * первом же кадре увидит стопы «за пределом угла» и сделает лишние подшаги прямо после поворота.
   */
  replant(): void { this.placed = false; }
  /** Фаза приставного шага КАЖДОЙ ноги (0 = стоит, 0..1 = переносится к планту). */
  private sideT: [number, number] = [0, 0];
  /**
   * ⚠ ДОВОДКА — ОДИН РАЗ ЗА ПОВОРОТ. Защёлка на ногу: доступили — больше не доступаем, пока таз
   * снова не начнёт крутиться. Без неё порог доводки в четверть юнита превращается в ТОПТАНИЕ:
   * шаг сажает стопу домой, таз доворачивает на градус, порог снова пройден — и так вечно
   * (ровно та беда, от которой в коде стоит «заморозка стойки»).
   */
  private settleStepped: [boolean, boolean] = [false, false];
  private yawSigned = 0;                          // сглаженная скорость поворота СО ЗНАКОМ (>0 вправо/по часовой, <0 влево)
  private goalYaw: number | null = null;          // фейсинг ПРИЦЕЛА (куда доворачивает таз): подшаг целит стопу в идл-стойку НА НЁМ, не в промежуточный таз. null → текущий yaw
  private bodyX = 0; private bodyZ = 0; private curYaw = 0;   // последняя позиция/поворот таза — для stanceAtGoal (целевые маркеры редактора)
  setGoalYaw(y: number | null): void { this.goalYaw = y; }
  /** Текущая плант-цель ноги i в мире (свинг-цель tx/tz или опорная px/pz) — для наземных маркеров редактора. */
  getTarget(i: number): [number, number] { const l = this.legs[i]!; return l.sw > 0 ? [l.tx, l.tz] : [l.px, l.pz]; }
  /** Гол = прицел, но не дальше MAX_GOAL_LEAD впереди таза (флик курсора не даёт стопе скачок). null goalYaw → текущий yaw. */
  private clampedGoal(yaw: number): number {
    if (this.goalYaw === null) return yaw;
    const d = Math.atan2(Math.sin(this.goalYaw - yaw), Math.cos(this.goalYaw - yaw));
    return yaw + clamp(d, -MAX_GOAL_LEAD, MAX_GOAL_LEAD);
  }
  /** Идл-стойка ноги i в мире НА ГОЛ-ФЕЙСИНГЕ (прицел) — куда приземлится подшаг. Для целевых маркеров редактора «Повороты». */
  stanceAtGoal(i: number): [number, number] {
    const gy = this.clampedGoal(this.curYaw);
    const gfx = Math.sin(gy), gfz = Math.cos(gy), grx = Math.cos(gy), grz = -Math.sin(gy);
    const lat = i === 0 ? this.stanceLatL : this.stanceLatR, fwd = i === 0 ? this.stanceFwdL : this.stanceFwdR;
    return [this.bodyX + grx * lat + gfx * fwd, this.bodyZ + grz * lat + gfz * fwd];
  }

  /**
   * СРОЧНОСТЬ ШАГА: множитель к скорости фазы, когда ОПОРНАЯ нога вынеслась дальше, чем должна.
   *
   * Зачем. Фаза едет от пройденного пути, и в ровном ходе этого достаточно: стопа ставится на `lead`
   * впереди бедра, за окно опоры тело проезжает ровно два `lead`, и нога уходит на столько же назад —
   * вынос симметричен. Но на РЕЗКОЙ СМЕНЕ НАПРАВЛЕНИЯ тело уезжает в сторону, которую нога не
   * предполагала, и весь проезд ложится в одну сторону: вынос удваивается, упирается в длину ноги,
   * IK выпрямляет её в палку — это и есть «шагает неестественно широко».
   *
   * Разворот предсказать нельзя, поэтому подстраивается ТАЙМИНГ: маховая обязана приземлиться раньше
   * и снять нагрузку с растянутой опорной. В робототехнике это step timing adaptation и стоит рядом с
   * выбором точки постановки (capture point); в анимации ту же работу делает отдельный клип pivot,
   * который обрывает текущий шаг.
   *
   * Порог ОТНОСИТЕЛЬНЫЙ (доля от `lead`), а не геометрический: в нашей настройке нога и в ровном беге
   * идёт почти на пределе длины, так что от геометрии триггер срабатывал бы всегда.
   */
  private urgency(px: number, pz: number, rx: number, rz: number, lead: number): number {
    if (GAIT.stepUrge <= 0) return 1;
    // Мера — вынос ОПОРНОЙ стопы от своего бедра. В ровном ходе он не выходит за `lead`: стопа приходит
    // на `lead` впереди и уходит на столько же назад. На развороте тело уезжает прочь от планта, и вынос
    // растёт без предела — вот это и ловим. Второго масштаба здесь НЕ нужно: `lead` считается из длины
    // шага и скорости, а якорь бедра — из `hipHalf` рига, то есть обе стороны уже в мире модели.
    const lim = Math.max(1, lead * (1 + GAIT.stepSlack));
    let over = 0;
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i]!;
      if (l.sw > 0) continue;                               // маховая вес не держит — её вынос не в счёт
      const s = i === 0 ? this.hipHalf : -this.hipHalf;
      over = Math.max(over, Math.hypot(l.px - (px + rx * s), l.pz - (pz + rz * s)) / lim);
    }
    this.lastUrge = 1 + clamp(over - 1, 0, 1) * GAIT.stepUrge;
    return this.lastUrge;
  }

  /**
   * ⭐⭐ ЧЕЙ ЭТО ПЕРЕНОС: начат ПОХОДКОЙ (true) или приставным шагом (false).
   *
   * Без этого флага смена режима «идём → стоим» не может отличить ногу, летящую по дуге походки, от
   * ноги, которую стоячая логика уже ведёт сама, — и перезапускала ПЕРВУЮ с нуля.
   */
  private swGait: [boolean, boolean] = [false, false];
  /**
   * ⭐ ТЕМП ПЕРЕНОСА КАЖДОЙ НОГИ (доля дуги в секунду). У приставного шага он постоянный
   * (`1 / SIDESTEP_DUR`), а у походки зависит от скорости — и на ДОНЕСЕННОМ шаге надо сохранить
   * именно походочный, иначе стопа на переходе ускоряется скачком. ЗАМЕР до правки: 8.7 ед/кадр
   * против штатных 4.3, то есть ровно вдвое.
   */
  private sideRate: [number, number] = [1 / SIDESTEP_DUR, 1 / SIDESTEP_DUR];
  private swRate: [number, number] = [0, 0];
  private reset(px: number, pz: number, fx: number, fz: number, rx: number, rz: number, yaw: number): void {
    for (let i = 0; i < 2; i++) {
      const lat = i === 0 ? this.stanceLatL : this.stanceLatR, fwd = i === 0 ? this.stanceFwdL : this.stanceFwdR;
      const l = this.legs[i]!;
      l.px = px + rx * lat + fx * fwd; l.pz = pz + rz * lat + fz * fwd; l.sw = 0;   // стартуем сразу в планте стойки
      this.plantYaw[i] = yaw;   // предел ПО УГЛУ отсчитывается от свежего yaw (иначе спавн при повёрнутом yaw → ложный шаг)
    }
    this.placed = true; this.turnLead = -1;
  }


  /**
   * ⚠ ВЫСОТА КОСТИ-ЛОДЫЖКИ, КОГДА ПОДОШВА НА ПОЛУ — ЧИСЛО РИГА, А НЕ КОНСТАНТА.
   *
   * Здесь стоял голый `FOOT_Y = 1.5` — высота лодыжки ПРОЦЕДУРНОГО манекена. У модели она своя:
   * ЗАМЕР на рыцаре — лодыжка стоит на 2.916 над собственной подошвой. Заземление (`footIk.groundFeet`)
   * это учитывало (`SOLE + footLift`), а планировщик шагов — НЕТ: он прибивал опорную стопу к 1.5,
   * заземление тянуло её к 2.916, и каждый кадр они спорили на 1.4 единицы. Глазами — «ходьба дёргается
   * вверх-вниз», а нога при этом почти всё время в упоре, из-за чего половина ручек походки переставала
   * что-либо менять.
   *
   * Ставится рантаймом из рига (`PoseDriver.footFloor`); у процедурного персонажа равно `FOOT_Y`,
   * и тогда всё считается бит в бит как раньше.
   */
  footFloor = FOOT_Y;

  /**
   * ⭐⭐ `yaw` — ЕДИНСТВЕННЫЙ КАДР ПЛАНИРОВЩИКА: и оси, по которым раскладывается ход, и оси, по которым
   * складывается вынос, и оси якоря бедра. Двух кадров здесь быть НЕ ДОЛЖНО.
   *
   * ⚠ 19.09 их было два: авторский ПОВОРОТ таза лежал в `yaw`, а доли направления считались от отдельного
   * `mixYaw` (курс без поворота) — иначе ручка мерила сама себя и на 35° уходила в мигание с периодом 2 кадра.
   * Разводка чинила петлю, но оставляла РАСХОЖДЕНИЕ КАДРОВ: ход раскладывался в одном базисе, а вынос
   * собирался в другом, и плант уезжал от хода ровно на угол ручки (ЗАМЕР: 0.00 → 20.00 → 35.00°). Теперь
   * поворот таза до планировщика не доезжает вовсе (он ТОЛЬКО на кости, см. `POSE.hipsTurn`), кадр снова один,
   * и петли нет по построению — мерить `st` больше нечем, кроме неповёрнутого курса.
   */
  update(dt: number, px: number, pz: number, yaw: number, vx: number, vz: number): { l: LegAngles; r: LegAngles; bobY: number; toeCurl: [number, number] } {
    // Оси тела в мире: вперёд = локальный +Z, вправо = локальный +X.
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    this.bodyX = px; this.bodyZ = pz; this.curYaw = yaw;   // для stanceAtGoal (целевые маркеры редактора)
    if (!this.placed || Math.hypot(this.legs[0].px - px, this.legs[0].pz - pz) > 100) this.reset(px, pz, fx, fz, rx, rz, yaw);

    // Сглаженная скорость поворота (рад/с). Сырая мигает [0.1,0,0.1,0] из-за сим 30Гц / физика 60Гц.
    if (dt > 0) {
      let dyr = yaw - this.prevYaw;
      while (dyr > Math.PI) dyr -= Math.PI * 2; while (dyr < -Math.PI) dyr += Math.PI * 2;
      this.yawRate += (Math.abs(dyr) / dt - this.yawRate) * Math.min(1, dt * 10);
      this.yawSigned += (dyr / dt - this.yawSigned) * Math.min(1, dt * 10);   // со знаком: >0 вправо, <0 влево (для порядка шагов)
      this.prevYaw = yaw;
    }
    const speed = Math.hypot(vx, vz);
    const sb = clamp((speed - GAIT.speedWalk) / Math.max(1, GAIT.speedRun - GAIT.speedWalk), 0, 1);   // 0 ходьба … 1 бег → раздельные длина шага/боб/подъём
    this.sb = sb;   // отдаём наружу (PoseDriver блендит руки walk/run по нему)
    // Доля хода для рук/наклона (0 стоя … ~1 быстрый шаг). Сглаживаем — сырая скорость мигает (сим 30/физ 60).
    if (dt > 0) this.moveAmt += (clamp(speed / GAIT.speedWalk, 0, 1.4) - this.moveAmt) * Math.min(1, dt * 8);
    const moving = speed > MOVE_EPS;
    const mx = moving ? vx / speed : 0, mz = moving ? vz / speed : 0;
    // НАПРАВЛЕНИЕ, ПОД КОТОРОЕ СТАВИТСЯ СТОПА, — усреднённое, а не мгновенное (см. GAIT.planSmooth).
    // Сглаживаем ВЕКТОР, а не угол: у мечущегося направления средний вектор сам сжимается к нулю, и
    // плант съезжает под таз — ровно то, что нужно. На первом кадре хода берём как есть, чтобы старт
    // с места не отличался от прежнего ни на градус.
    if (!moving) this.mAvgOn = false;
    else if (!this.mAvgOn) { this.mAvgX = mx; this.mAvgZ = mz; this.mAvgOn = true; }
    else {
      const k = GAIT.planSmooth > 1e-4 ? Math.min(1, dt / GAIT.planSmooth) : 1;
      this.mAvgX += (mx - this.mAvgX) * k; this.mAvgZ += (mz - this.mAvgZ) * k;
    }
    const pmx = this.mAvgOn ? this.mAvgX : mx, pmz = this.mAvgOn ? this.mAvgZ : mz;
    // БОКОВИТОСТЬ. Считается от СГЛАЖЕННОГО направления и от осей ТАЗА (а не прицела): при включённом
    // довороте (Ф0) таз уже развёрнут под движение, поэтому диагональ здесь честно читается как ход
    // вперёд и страйф-колонку не поднимает — ровно так, как показал замер 4-против-8 направлений.
    // ⚠ ОСИ БОКОВИТОСТИ — ТЕ ЖЕ `fx/fz/rx/rz`, что у выноса и якоря бедра (см. шапку `update`): один кадр на всё.
    const mFwd = pmx * fx + pmz * fz, mLat = pmx * rx + pmz * rz;
    this.st = moving ? strafeMix(mFwd, mLat) : 0;
    // СТОРОНА СТРАЙФА. Доли делят ровно `st` (сумма = `st`), поэтому включение сторон ничего не
    // прибавляет само по себе: пока карты сторон пусты, `locoVal` даёт прежнее число бит в бит.
    // `mLat` берётся от СГЛАЖЕННОГО направления (тот же `pmx/pmz`, что у боковитости) — мгновенный
    // вектор на диагонали мигает знаком, и сторона щёлкала бы вместе с ним.
    const sr = moving ? strafeSide(mLat) : 0;
    this.stR = this.st * sr; this.stL = this.st * (1 - sr);
    // НАЗАДНОСТЬ — по тем же осям таза и через ту же боковитость, поэтому колонки не спорят.
    // Стоим — обе нули: у стояния направления нет, и подмешивать ему «назад» не за что.
    this.bt = moving ? backMix(mFwd, mLat) : 0;
    const m: LocoMix = { sb, st: this.st, stR: this.stR, stL: this.stL, bt: this.bt, ct: this.combat };
    /**
     * ⭐⭐ ДЛИНА ШАГА РИТМА — ИЗ БАЗЫ, БЕЗ КОЛОНОК НАПРАВЛЕНИЯ. И это НЕ НЕДОСМОТР, см. ниже.
     *
     * ЖАЛОБА АВТОРА (19.09): «длина шага странно работает: вперёд-назад всё норм, а на страйфах что-то
     * странное». ЗАМЕР (рыцарь, опубликованный воин): РИТМ (эта строка) считается от голой базы, а ВЫНОС ноги —
     * от колоночного `sl(i)`. Вперёд колонка И ЕСТЬ база, поэтому там ручка двигает и то и другое: 15 → шаг
     * ровно 15.0 ед., 45 → ровно 45.0 (контракт «шаг = скорость × период / 2»). В колонке «СТРАЙФ» ручка меняет
     * ТОЛЬКО вынос: 15 → шаг остался 25.0 (вынос 16.2 → 11.7), 45 → шаг те же 25.0 (вынос 25.9).
     *
     * ⚠ И ВЫНОС НА СТРАЙФЕ УХОДИТ ВБОК, А НЕ ВПЕРЁД: `plant` раскладывает его на `reach·mFwd` (вдоль хода) и
     * `reach·mLat` (вбок), а на чистом боку `mFwd` = 0 — то есть «длина шага» страйфа шире/уже РАЗВОДИТ стопы,
     * а не удлиняет шаг. Отсюда и «что-то странное»: ручка называется одинаково, а делает разное.
     *
     * ⚠⚠ ПОЧЕМУ РИТМ НЕ ПЕРЕВЕЛИ НА КОЛОНКИ (пробовали, ЗАМЕРЕНО, откатили). Ритм у походки ОДИН, а доли
     * направления (`st`/`bt`) ездят вместе с доворотом таза — значит темп шага поехал бы вместе с ними. Замер на
     * опубликованном воине: у него `back.stepWalk` 18.5 против базы 25, и на стенде `torsoJitter` (прямой бег
     * вперёд 80 u/с, боевая каденция) `bt` доходит до 1.000 — длина шага прыгала на 25.5 ед., а рывок груди
     * (p99 d²) шёл 2062 → 16437 °/с² при 60 Гц, то есть ровно тот класс беды, который этот стенд и запрещает.
     * Чтобы дать колонкам ритм, сначала нужен ПЛАВНЫЙ переход темпа (как у клипов кроссфейд), а это отдельная
     * работа. Пока — база; панель «Бег» пишет об этом прямо под ползунком.
     */
    const stepLen = lerp(GAIT.stepWalk, GAIT.stepRun, sb) / Math.max(0.1, GAIT.cadence);   // cadence>1 → короче/чаще (путь px не трогаем)
    const duty = lerp(GAIT.dutyWalk, GAIT.dutyRun, sb);   // доля опоры ходьба↔бег (sb уже в [0,1])
    // Вынос стопы вперёд (относительно бедра): база шаг·доля + ручки панели.
    const lead = stepLen * duty + stepLen * GAIT.aheadMul + speed * GAIT.predictSec;
    // ── ТО ЖЕ, НО НА СТОРОНУ. Симметрия (`ASYM` пуст) → числа те же, что выше, бит в бит.
    // Фаза остаётся ОДНА на обе ноги: две независимые фазы — это уже не походка, а два человека.
    // Асимметрия живёт в геометрии шага (длина, подъём, доля опоры, ширина), и этого хватает на хромоту.
    const sl = (i: 0 | 1): number => locoVal('stepWalk', 'stepRun', GAIT.stepWalk, GAIT.stepRun, i, m) / Math.max(0.1, GAIT.cadence);
    const dutyS = (i: 0 | 1): number => locoVal('dutyWalk', 'dutyRun', GAIT.dutyWalk, GAIT.dutyRun, i, m);
    const liftS = (i: 0 | 1): number => locoVal('liftWalk', 'liftRun', GAIT.liftWalk, GAIT.liftRun, i, m);
    const leadS = (i: 0 | 1): number => sl(i) * dutyS(i) + sl(i) * GAIT.aheadMul + speed * GAIT.predictSec;
    const fwdLimS = (i: 0 | 1): number => locoVal('hipFwdLim', 'hipFwdLimRun', GAIT.hipFwdLim, GAIT.hipFwdLimRun, i, m);
    const hipSwS = (i: 0 | 1): number => locoVal('hipSwing', 'hipSwingRun', GAIT.hipSwing, GAIT.hipSwingRun, i, m);
    const ankLvlS = (i: 0 | 1): number => locoVal('ankLevel', 'ankLevelRun', GAIT.ankLevel, GAIT.ankLevelRun, i, m);
    /** Вес удержания подошвы по фазе ПЕРЕНОСА (0 = отрыв, 1 = касание): плато `[from,to]`, рампы СНАРУЖИ. */
    const ankHoldS = (sw: number, i: 0 | 1): number => {
      const f = locoVal('ankHoldFrom', 'ankHoldFromRun', GAIT.ankHoldFrom, GAIT.ankHoldFromRun, i, m);
      const t = locoVal('ankHoldTo', 'ankHoldToRun', GAIT.ankHoldTo, GAIT.ankHoldToRun, i, m);
      // ⚠ ОКНО ЗАКРЫТО (`to` ≤ `from`) = УДЕРЖАНИЕ ВЫКЛЮЧЕНО, и это НЕ опечатка кода, а явная
      // семантика: иначе пришлось бы гадать, что имел в виду автор. Но молчать об этом нельзя —
      // живой случай: у воина стояло `from` 0.08 при `to` 0, и выкрученная в 1.4 ручка «держать
      // подошву» не делала НИЧЕГО. Панель «Бег» теперь пишет об этом прямо под ползунками.
      if (t <= f) return 0;
      if (sw >= f && sw <= t) return 1;                       // ВНУТРИ окна — ровно 1 (умолчание [0,1] = весь перенос)
      const e = Math.max(0, locoVal('ankHoldEase', 'ankHoldEaseRun', GAIT.ankHoldEase, GAIT.ankHoldEaseRun, i, m));
      if (e <= 1e-4) return 0;                                 // плавность 0 → жёсткий край окна
      return sw < f ? smooth01(clamp((sw - (f - e)) / e, 0, 1))
                    : smooth01(clamp(((t + e) - sw) / e, 0, 1));
    };
    const toeLiftS = (i: 0 | 1): number => locoVal('toeLift', 'toeLiftRun', GAIT.toeLift, GAIT.toeLiftRun, i, m);
    const toePhS = (i: 0 | 1): number => locoVal('toeLiftPhase', 'toeLiftPhaseRun', GAIT.toeLiftPhase, GAIT.toeLiftPhaseRun, i, m);

    /**
     * ⭐ ГДЕ МАХОВАЯ СТОПА СЕЙЧАС — ОДНА ФОРМУЛА НА КАДР. Её читает и передача шага между режимами
     * (ниже), и решатель ног в конце `update`. Вторая копия здесь была бы прямой дорогой к расхождению:
     * передача поставила бы ногу в одну точку, а нарисовалась бы она в другой — то есть к тому же
     * рывку, который мы и чиним.
     */
    const swingXZ = (i: number): [number, number] => {
      const l = this.legs[i]!;
      const s = i === 0 ? this.hipHalf : -this.hipHalf;
      const hx = px + rx * s, hz = pz + rz * s;
      const t = l.sw, e = t * t * (3 - 2 * t);
      const via = this.plantVia[i]!;
      if (via.length === 0) return [l.fx + (l.tx - l.fx) * e, l.fz + (l.tz - l.fz) * e];
      const ctrl: [number, number][] = [[l.fx, l.fz]];
      for (const v of via) ctrl.push([hx + fx * v[0] + rx * v[1], hz + fz * v[0] + rz * v[1]]);
      ctrl.push([l.tx, l.tz]);
      return crAt(ctrl, e);
    };

    // 1. РИТМ. Фаза едет от ПРОЙДЕННОГО ПУТИ: π = один шаг. Ноги чередуются строго по фазе.
    //    Раньше шаг запускался по накопленному отставанию — и пока одна нога в переносе, вторая ждала
    //    очереди и уезжала назад на весь шаг: нога плантовалась на +16, а уходила на −31, центр шага
    //    смещался за спину («семенит сзади тела»). При ритме опорная уходит назад ровно на полшага.
    // Стоим, но стопа уехала (добежали и встали) — доводим её ШАГОМ: крутим фазу, пока не переступит.
    // Раньше плант просто телепортировался под таз — это и был рывок «подшагивания» на медленном ходу.
    // ЗАМОРОЗКА СТОЙКИ. При duty<0.5 почти всегда одна нога в воздухе, поэтому «стоя» фаза сама не
    // остановится (окна переноса двух ног сдвинуты на π) — топчется вечно. Нужен явный флаг: стоим и стопы
    // под тазом → замираем (обе на земле, фаза стоит). Порог переступа стоя — turnStepDist / turnLimitDeg
    // на вкладке «Повороты» (было ещё поле `idleStep`, но его не читал НИКТО — удалено).
    if (moving) {
      this.settled = false;
      this.sideT[0] = 0; this.sideT[1] = 0;                     // ход перебивает приставные шаги
      this.phase += (speed * dt / stepLen) * Math.PI * this.urgency(px, pz, rx, rz, lead);
    } else {
      // СТОИМ. Планты (дом стопы отн. ТАЗА) крутятся с yaw; стопа прибита к миру. Шаг — когда стопа отъехала на ПРЕДЕЛ
      // (по ДИСТАНЦИИ turnStepDist ИЛИ по УГЛУ turnLimitDeg — тумблер turnLimitByAngle). Внутренняя нога (в сторону
      // вращения) ВСЕГДА первой, строгое чередование (turnLead), без одновременного двойного свинга. Плюс «доступить»
      // когда таз перестал крутиться (turnSettleTime) и уход в idle-позу по времени (turnIdleTime).
      // ПЛАНТ стойки — на фейсинге ПРИЦЕЛА (gy = гол, кламп лида), а НЕ текущего таза: подшаг ведёт стопу туда, где встанет
      // идл-стойка ПОСЛЕ доворота (таз догонит), а не в промежуточную точку. goalYaw=null (тесты/чистое движение) → gy=yaw → как было.
      const gy = this.clampedGoal(yaw);
      const gfx = Math.sin(gy), gfz = Math.cos(gy), grx = Math.cos(gy), grz = -Math.sin(gy);
      const stanceX = (i: number): number => px + grx * (i === 0 ? this.stanceLatL : this.stanceLatR) + gfx * (i === 0 ? this.stanceFwdL : this.stanceFwdR);
      const stanceZ = (i: number): number => pz + grz * (i === 0 ? this.stanceLatL : this.stanceLatR) + gfz * (i === 0 ? this.stanceFwdL : this.stanceFwdR);
      const turning = this.yawRate > GAIT.turnStep;
      const inside = this.yawSigned >= 0 ? 0 : 1;               // нога в сторону вращения (ведущая)
      this.stableFor = this.yawRate < 0.02 ? this.stableFor + dt : 0;   // таз ПРАКТИЧЕСКИ стоит (~1°/с) → плант стабилен (медленный поворот НЕ считается стоянием)
      // ⭐⭐ ПЕРЕДАЧА ШАГА ИЗ ПОХОДКИ В СТОЯЧИЙ РЕЖИМ — «точка невозврата».
      //
      // ЖАЛОБА: «бежишь, резко встал — нога, летевшая к своему планту, дёргается назад и падает под
      // тело». ЗАМЕР: стопа за ОДИН кадр уезжала назад на **35 единиц** при том, что её максимальная
      // штатная скорость переноса — 4.3 ед/кадр, то есть в ВОСЕМЬ раз больше всего, что бывает в
      // движении. Причина: стоячая ветка начинала перенос со счётчика `sideT`, который ходовая ветка
      // обнуляет КАЖДЫЙ кадр («ход перебивает приставные шаги»). Нога, прошедшая полдуги, получала
      // `sw ≈ 0.006`, а позиция в переносе считается от точки ОТРЫВА — значит рисовалась почти там,
      // откуда оторвалась. Смена режима не передавала состояние, а перезапускала его.
      //
      // ЛЕЧЕНИЕ (приём индустрии — окно коммита + retarget от ТЕКУЩЕЙ позиции):
      //  • прошли меньше `stepCommit` — ПЕРЕЦЕЛИВАЕМ: началом дуги становится ТЕКУЩАЯ позиция стопы,
      //    целью — плант стойки. Нога уходит туда, где встанет, без лишнего шага;
      //  • прошли больше — ДОНОСИМ: цель и дуга те же, на таймлайн приставного шага переносится
      //    ПРОГРЕСС. Нога доигрывает шаг и приземляется впереди, а домой её штатно доводит подшаг.
      //
      // ⚠ ГЛАВНЫЙ ИНВАРИАНТ ОБОИХ ПУТЕЙ: начало дуги — это всегда точка, где стопа НАРИСОВАНА СЕЙЧАС.
      // Ни один переход не имеет права отматывать её назад.
      for (let i = 0; i < 2; i++) {
        const l = this.legs[i]!;
        if (l.sw <= 0 || !this.swGait[i]) continue;
        this.swGait[i] = false;
        if (l.sw >= clamp(GAIT.stepCommit, 0, 1)) {
          // ДОНОСИМ: цель и дуга те же, переносим ПРОГРЕСС и — обязательно — ТЕМП. Без темпа остаток
          // дуги проигрывается за длительность приставного шага, и стопа на переходе ускоряется.
          this.sideT[i] = l.sw;
          this.sideRate[i] = Math.max(this.swRate[i]!, 0.2);
          continue;
        }
        const cur = swingXZ(i);                                                          // ПЕРЕЦЕЛИВАЕМ: дуга с текущего места
        l.fx = cur[0]; l.fz = cur[1];
        l.tx = stanceX(i); l.tz = stanceZ(i);
        this.sideT[i] = 0; l.sw = 0.001; this.sideRate[i] = 1 / SIDESTEP_DUR;
      }
      for (let i = 0; i < 2; i++) {                            // двигаем текущие переносы к планту; на приземлении фиксируем plantYaw
        const l = this.legs[i]!;
        if (l.sw <= 0) continue;
        let st = this.sideT[i]! + dt * this.sideRate[i]!;
        if (st >= 1) { l.px = l.tx; l.pz = l.tz; l.sw = 0; st = 0; this.plantYaw[i] = gy; } else l.sw = clamp(st, 0.001, 1);   // приземлилась на гол-фейсинге → угловой предел мерит от него
        this.sideT[i] = st;
      }
      const startStep = (i: number): void => { const l = this.legs[i]!; l.fx = l.px; l.fz = l.pz; l.tx = stanceX(i); l.tz = stanceZ(i); this.sideT[i] = 0; l.sw = 0.001; this.swGait[i] = false; this.sideRate[i] = 1 / SIDESTEP_DUR; };
      const homeDist = (i: number): number => Math.hypot(this.legs[i]!.px - stanceX(i), this.legs[i]!.pz - stanceZ(i));
      const angleOver = (i: number): boolean => Math.abs(Math.atan2(Math.sin(gy - this.plantYaw[i]!), Math.cos(gy - this.plantYaw[i]!))) > GAIT.turnLimitDeg * Math.PI / 180;   // разворот ПРИЦЕЛА отн. приземления стопы
      // ПРЕДЕЛ переступа: по УГЛУ разворота таза отн. прибитой стопы ИЛИ по ДИСТАНЦИИ отъезда — берём ОБА (что раньше сработает).
      // Для УЗКОЙ стойки (меч: планты близко к центру тела) homeDist почти не растёт → одна дистанция НЕ переступает, и нога
      // сметается к центру до срабатывания `crossed` (стойка схлопывается). Угловой предел переступает вовремя → ширина держится.
      // turnLimitByAngle=1 оставлен как «ТОЛЬКО угол» для сравнения фила в редакторе.
      const beyondLimit = (i: number): boolean => GAIT.turnLimitByAngle ? angleOver(i) : (angleOver(i) || homeDist(i) > GAIT.turnStepDist);
      const crossed = (i: number): boolean => {                // страховка от X: опорная перешла среднюю линию
        const l = this.legs[i]!; const plantLat = i === 0 ? this.stanceLatL : this.stanceLatR;
        const footLat = (l.px - px) * grx + (l.pz - pz) * grz;   // средняя линия — по гол-фейсингу (куда встаём)
        return Math.abs(plantLat) > 0.1 && Math.sign(footLat) !== Math.sign(plantLat) && Math.abs(footLat) > 1;
      };
      const settleReady = this.stableFor > GAIT.turnSettleTime;   // таз стоит → доступить не дожидаясь предела
      if (turning) { this.settleStepped[0] = false; this.settleStepped[1] = false; }   // снова крутимся → доводка опять разрешена
      // ⚠ ДОВОДКА ЖДЁТ, ПОКА ТАЗ ВСТАНЕТ (`settleReady`). Пробовал отпустить её на «не крутимся
      // быстро» — чтобы доводка работала и в медленном повороте: тогда она СРАБАТЫВАЕТ РАНЬШЕ
      // угловогo предела, golden поехал уже в ТРЁХ поворотных кейсах и упал сторож «шаг при
      // повороте таза примерно на turnLimitDeg». Пределы угла и дистанции ведут поворот, доводка —
      // только его конец.
      const wantSettle = (i: number): boolean => settleReady && !this.settleStepped[i] && homeDist(i) > SETTLE_STEP_EPS;
      const wantStep = (i: number): boolean => !this.legsHeld && this.legs[i]!.sw <= 0 && (beyondLimit(i) || crossed(i) || wantSettle(i));
      // ПОРЯДОК: очередь turnLead (внутренняя первой), одновременный двойной свинг запрещён, строгое чередование.
      // Латчим ТОЛЬКО когда реально крутимся (yawSigned уже с чётким знаком); стоя латч сброшен, ведущая берётся вживую.
      if (turning && this.turnLead < 0) this.turnLead = inside;
      if (!turning) this.turnLead = -1;
      const lead = this.turnLead >= 0 ? this.turnLead : inside, other = lead === 0 ? 1 : 0;
      if (wantStep(lead) && this.legs[other]!.sw <= 0) { if (wantSettle(lead)) this.settleStepped[lead] = true; startStep(lead); if (this.turnLead >= 0) this.turnLead = other; }
      else if (wantStep(other) && this.legs[lead]!.sw <= 0 && homeDist(lead) <= SETTLE_STEP_EPS) { if (wantSettle(other)) this.settleStepped[other] = true; startStep(other); if (this.turnLead >= 0) this.turnLead = lead; }
      const anySwing = this.legs[0]!.sw > 0 || this.legs[1]!.sw > 0;
      const maxDist = Math.max(homeDist(0), homeDist(1));
      // УХОД В IDLE ПО ВРЕМЕНИ: обе стопы дома + не крутимся + нет свинга → копим idleFor; через turnIdleTime → idle-поза.
      // ⚠ ГЕЙТ «УСПОКОИЛИСЬ» ОСТАЁТСЯ НА `SETTLE_EPS`. Он правит `stepping` → `legMag`, то есть КТО
      // ведёт ноги: планировщик или авторская поза. Сузил его до четверти юнита — и golden-вектор
      // поехал на 1.44 по тазу в кейсе `turn_slow` (ноги перестали отдаваться позе). Доводку шагом
      // сужать можно и нужно, а этот гейт — нет.
      if (anySwing || maxDist > SETTLE_EPS || turning) { this.settled = false; this.idleFor = 0; }
      else {
        this.idleFor += dt;
        // ⚠ ТУМБЛЕР ОБЯЗАН И СНИМАТЬ состояние, а не только не пускать в него: выключили на ходу —
        // ноги должны вернуться планировщику ТУТ ЖЕ. Поймано живой проверкой: подпись менялась,
        // а `settled` оставался с прошлого раза, и ничего не происходило.
        if (GAIT.idleSettle <= 0.5) { this.settled = false; }
        else if (this.idleFor > GAIT.turnIdleTime && !this.settled) {
          // ⚠ СТОПЫ НЕ ДВИГАЕМ. Раньше здесь был ТЕЛЕПОРТ в idle-стойку — рывок до `SETTLE_EPS` = 2 u
          // ровно в момент «успокоились». Доводка теперь идёт приставным шагом (см. `SETTLE_STEP_EPS`),
          // поэтому к этому моменту стопы уже НА стойке: остаётся зафиксировать угол приземления.
          this.settled = true; this.turnLead = -1;
          for (let i = 0; i < 2; i++) { this.legs[i]!.sw = 0; this.plantYaw[i] = yaw; }
        }
      }
    }

    // 2. ОКНА ОПОРЫ по доле. У ноги i опора отцентрована на фазе i·π и занимает 2π·duty цикла; остальное —
    //    перенос. duty<0.5 → между опорами обе ноги в воздухе (фаза полёта) — это и есть бег.
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
    const plant = (l: Leg, i: number, hx: number, hz: number, reach: number): void => {
      const off = this.plantOff[i]!, side = i === 0 ? 1 : -1;   // нога 0 = ЛЕВАЯ на +X (см. якорь бедра)
      const fwdAmt = reach * mFwd + off[0];
      const j = i as 0 | 1;
      const reachK = locoVal('strafeReach', 'strafeReachRun', GAIT.strafeReach, GAIT.strafeReachRun, j, m);
      const width = locoVal('stanceWidth', 'stanceWidthRun', GAIT.stanceWidth, GAIT.stanceWidthRun, j, m);
      const cross = locoVal('crossClamp', 'crossClampRun', GAIT.crossClamp, GAIT.crossClampRun, j, m);
      let latAmt = reach * mLat * reachK + width * side + off[1];
      if (side * latAmt < -cross) latAmt = -side * cross;   // не заходить за среднюю линию дальше crossClamp
      l.tx = hx + fx * fwdAmt + rx * latAmt; l.tz = hz + fz * fwdAmt + rz * latAmt;
      avoid(l, 1 - i);
    };
    const TAU = Math.PI * 2;
    if (!moving) { this.supPhase[0] = 1; this.supPhase[1] = 1; this.plantW[0] = 1; this.plantW[1] = 1; /* стоим: ноги ведёт стационарная логика выше — sw уже выставлен, опора полная */ }
    else for (let i = 0; i < 2; i++) {
      const l = this.legs[i]!;
      const half = Math.PI * dutyS(i as 0 | 1);      // своя доля опоры → одна нога может стоять дольше другой
      let c = (this.phase - i * Math.PI) % TAU; if (c < 0) c += TAU;
      if (c < half || c > TAU - half) {              // ОПОРА
        if (l.sw > 0) {                              // приземление: плантуем ТУДА, ГДЕ НОГА РЕАЛЬНО СТОИТ
          const a = this.actual[i]!;                 // (плант «по расчёту» тащил отстающую ногу рывком)
          l.px = a[0]; l.pz = a[1];
        }
        l.sw = 0;
        // Опора идёт через 0: сначала хвост [TAU−half, TAU), потом голова [0, half). Склеиваем в 0..1.
        this.supPhase[i] = c > half ? (c - (TAU - half)) / (2 * half) : (c + half) / (2 * half);
      } else {                                       // ПЕРЕНОС
        if (l.sw === 0) {                             // отрыв
          l.fx = l.px; l.fz = l.pz; this.swGait[i] = true;   // перенос НАЧАТ ПОХОДКОЙ (см. передачу шага выше)
          const s = i === 0 ? this.hipHalf : -this.hipHalf;   // нога 0 = ЛЕВАЯ, её кость LeftUpperLeg сидит на +X (humanoid.ts) → якорь +X
          const hx = px + rx * s, hz = pz + rz * s;
          // fixTarget: цель фиксируется здесь. Прибавляем пролёт тела за перенос (1−доля)·2·шаг — к касанию
          // бедро будет там, стопа приземлится на `lead` впереди. Иначе цель едет за бедром (пересчёт ниже).
          const fly = GAIT.fixTarget ? sl(i as 0 | 1) * (1 - dutyS(i as 0 | 1)) * 2 : 0;
          plant(l, i, hx, hz, leadS(i as 0 | 1) + fly);
        }
        const nsw = clamp((c - half) / (TAU - 2 * half), 0.001, 1);
        this.swRate[i] = dt > 1e-6 ? Math.max(0, (nsw - l.sw) / dt) : this.swRate[i]!;   // темп походки — пригодится при передаче шага
        l.sw = nsw;
        this.supPhase[i] = 1;   // в переносе опоры нет — вес заземления возьмёт 0 по `sw`
      }
    }

    // 3. ТАЗ ЕДЕТ ПО ОПОРНОЙ НОГЕ (как у человека): ноги разъехались → таз просел, нога под тазом → таз
    //    поднялся. В фазе полёта опорной нет — тело идёт на полной высоте. Сглаживаем, чтобы не «щёлкало».
    let maxLz = 0, maxHoriz = 0, anyStance = false, stanceLeg: 0 | 1 = 0;
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i]!;
      if (l.sw > 0) continue;                        // маховая нога вес не держит
      if (!anyStance) stanceLeg = i as 0 | 1;
      anyStance = true;
      const s = i === 0 ? this.hipHalf : -this.hipHalf;   // нога 0 = ЛЕВАЯ, её кость LeftUpperLeg сидит на +X (humanoid.ts) → якорь +X
      const hx = px + rx * s, hz = pz + rz * s;
      maxLz = Math.max(maxLz, Math.abs((l.px - hx) * fx + (l.pz - hz) * fz));
      // ⚠ И ПОЛНОЕ ГОРИЗОНТАЛЬНОЕ УДАЛЕНИЕ — вместе с БОКОВЫМ. `maxLz` берёт только составляющую
      // «вперёд», поэтому ШИРОКАЯ стойка (боевая) не давала просадки вовсе и ноги висели в воздухе.
      maxHoriz = Math.max(maxHoriz, Math.hypot(l.px - hx, l.pz - hz));
    }
    const reach = (this.thighL + this.shinL) * 0.97;
    // База таза = this.standY (высота стойки idle = где юзер поставил таз). ПРОСАДКА привязана к standY, а НЕ к абсолютной
    // геометрии ног (было `FOOT_Y + sqrt(reach²−maxLz²)` → потолок ~29 НЕЗАВИСИМО от standY → бег систематически ниже idle).
    // dip = насколько нога-`reach` просела бы при разножке стоп на maxLz вперёд (0 когда стопы под тазом). bobMult масштабирует
    // ТОЛЬКО просадку (верх шага всегда = standY = idle). Ниже pelvisMin не проседаем.
    const dip = reach - Math.sqrt(Math.max(0, reach * reach - maxLz * maxLz));
    // Боб и нижний предел приседа берём у ОПОРНОЙ ноги: таз проседает на ту ногу, которая держит вес,
    // поэтому хромота — это разный боб на левой и правой опоре, а не два таза.
    const bobMult = locoVal('bobWalk', 'bobRun', GAIT.bobWalk, GAIT.bobRun, stanceLeg, m);
    const floorY = locoVal('pelvisMin', 'pelvisMinRun', GAIT.pelvisMin, GAIT.pelvisMinRun, stanceLeg, m);
    // ВЕС ЗАЗЕМЛЕНИЯ: сглаженная ступенька на входе в опору и на выходе из неё.
    for (let i = 0; i < 2; i++) {
      const j = i as 0 | 1;
      if (this.legs[i]!.sw > 0) { this.gndW[i] = 0; this.plantW[i] = 1; continue; }   // маховую не заземляем вовсе
      // ⭐⭐ СТОЯ ОПОРА ПОЛНАЯ. Окно `gndIn`/`gndOut` описывает ФАЗУ ШАГА, а стоя фаза прибита к 1
      // (см. ветку `!moving` выше) — то есть ровно в «выход из опоры», и вес выходил НОЛЬ:
      // ЗАМЕР `groundWeights` стоя и на развороте = [0, 0] при обеих ногах опорных. Заземление было
      // выключено целиком, поэтому стопы висели там, где их оставил IK, а таз стоял колом.
      // Жалоба «в боевом idle ноги висят в воздухе, таз зафиксирован» — про это.
      if (!moving) { this.gndW[i] = 1; this.plantW[i] = 1; continue; }
      const inK = clamp(locoVal('gndIn', 'gndInRun', GAIT.gndIn, GAIT.gndInRun, j, m), 0, 1);
      const outK = clamp(locoVal('gndOut', 'gndOutRun', GAIT.gndOut, GAIT.gndOutRun, j, m), 0, 1);
      const u = clamp(this.supPhase[i]!, 0, 1);
      const rise = inK <= 1e-4 ? 1 : smooth01(clamp(u / inK, 0, 1));      // вход: 0 → gndIn
      const fall = outK >= 1 - 1e-4 ? 1 : smooth01(clamp((1 - u) / (1 - outK), 0, 1));   // выход: gndOut → 1
      this.gndW[i] = rise * fall;
      // МЯГКОСТЬ ПОСТАНОВКИ — своя рампа: она про УГОЛ стопы, а не про высоту (см. `GAIT.footPlant`).
      // ⚠ СИММЕТРИЧНАЯ: растёт на касании И спадает к отрыву. Первая версия рампила только вход — и почти
      // ничего не дала: ХУДШИЙ СКАЧОК ОКАЗАЛСЯ НА ОТРЫВЕ (замер: `ank` 0 → −0.45 за кадр,
      // наклон подошвы −29.98° → −6.6°, то есть 23.38°), а не на касании. Стопа обязана и ОТПУСКАТЬСЯ
      // заранее — это и есть перекат «пятка → плашмя → носок».
      // Потолок 0.45: выше вход и выход начали бы перекрываться и стопа не ложилась бы вовсе.
      const pl = clamp(locoVal('footPlant', 'footPlantRun', GAIT.footPlant, GAIT.footPlantRun, j, m), 0, 0.45);
      this.plantW[i] = pl <= 1e-4 ? 1
        : smooth01(clamp(u / pl, 0, 1)) * smooth01(clamp((1 - u) / pl, 0, 1));
    }

    // ФАЗА ПОЛЁТА. Опорной нет → раньше цель прыгала на полный рост стоя (`standY`) и срывалась вниз
    // в кадр касания. `bobFlight` говорит, НАСКОЛЬКО тянуть к стойке: 1 = как было, 0 = держать ту
    // высоту, с которой оторвались (тогда разрыва в касании нет вовсе).
    // ПРОСАДКА: опускаем саму базу (не предел), и только по мере хода — стоя таз остаётся в стойке.
    const crouch = locoVal('crouchWalk', 'crouchRun', GAIT.crouchWalk, GAIT.crouchRun, stanceLeg, m) * clamp(this.moveAmt, 0, 1);
    const baseY = this.standY - crouch;
    // ⭐⭐ ТАЗ НЕ ВЫШЕ, ЧЕМ ДОСТАЁТ ОПОРНАЯ НОГА. Просадка выше — это СТИЛЬ (её масштабирует `bobWalk`),
    // а это — ГЕОМЕТРИЯ: от тазобедренного сустава до планта по прямой не больше длины ноги, иначе
    // стопа до пола просто не дотягивается и повисает. Жалоба «в боевом идле ноги висят в воздухе»
    // ровно про это: боевая стойка ШИРЕ (стопы 9.69 / −8.88 против 8.03 / −7.42), а ширину просадка
    // не видела. Предел СРАБАТЫВАЕТ ТОЛЬКО когда нога иначе не достанет: в ходьбе и беге таз и так
    // ниже, поэтому числа там прежние.
    //
    // ⚠ Сустав бедра снесён от центра таза (`hipDrop`, см. `legRest`) — считаем от СУСТАВА, иначе
    // предел уедет ровно на этот снос.
    //
    // ⚠⚠ РУЧКОЙ, А НЕ ВСЕГДА. Замер: безусловный предел сдвинул golden-вектор и уронил 6 сторожей —
    // значит в обычной ходьбе таз РЕГУЛЯРНО стоит выше досягаемости, и IK это гасит клампом (так
    // походка и настраивалась). Включать такое молча — сломать чужой тюн. Умолчание 0 = прежнее
    // поведение бит в бит; 1 = таз всегда опускается настолько, чтобы стопа доставала до пола.
    const reachY = Math.sqrt(Math.max(0, reach * reach - maxHoriz * maxHoriz));
    const maxHipY = this.footFloor + reachY - this.hipDrop;
    const want0 = clamp(baseY - dip * bobMult, floorY, baseY);
    const grab = locoVal('pelvisReach', 'pelvisReachRun', GAIT.pelvisReach, GAIT.pelvisReachRun, stanceLeg, m);
    const stanceY = want0 > maxHipY ? want0 - (want0 - maxHipY) * clamp(grab, 0, 1) : want0;
    const wantY = anyStance ? stanceY : this.hipY + (baseY - this.hipY) * clamp(GAIT.bobFlight, 0, 1);
    // ⭐ ПРЕДЕЛ СКОРОСТИ ЦЕЛИ (`GAIT.bobSlew`): ступенька `wantY` на касании/отрыве (замер 32.08 → 26.57 за
    // кадр) превращается в рампу не круче `slew` ед/с — и только ПОТОМ идёт в лаг. Лаг по ступеньке давал
    // мгновенную смену скорости таза (max |a| 1112 ед/с²), по рампе — только излом скорости, который он же
    // скругляет (лаги 3/2.5, предел 30: 122 ед/с², размах 0.79 → 0.50; тюн warrior, бег 120, предел 20: 1436 → 469).
    // 0 = без предела: цель как была, бит в бит.
    // ⚠ Предел — на ЦЕЛИ, а не на самом тазе: ограничь скорость таза — и лаг снова упрётся в тот же угол.
    const slew = locoVal('bobSlew', 'bobSlewRun', GAIT.bobSlew, GAIT.bobSlewRun, stanceLeg, m);
    if (slew > 0) { const s = slew * dt; this.hipWant += clamp(wantY - this.hipWant, -s, s); }
    else this.hipWant = wantY;
    const tgtY = this.hipWant;
    // Сглаживание: вверх и вниз своими скоростями, и у каждой — своя пара ходьба/бег.
    // ⚠ Раньше здесь стоял ПОРОГ `speed > GAIT.speedWalk`: 39.9 → 40.1 переключало скорость скачком.
    // `locoVal` блендит по `sb` (та же ось, что у длины шага и подъёма стопы) — разрыва нет.
    const rising = tgtY > this.hipY;
    const rate = rising
      ? locoVal('bobLagUp', 'bobLagUpRun', GAIT.bobLagUp, GAIT.bobLagUpRun, stanceLeg, m)
      : locoVal('bobLagDown', 'bobLagDownRun', GAIT.bobLagDown, GAIT.bobLagDownRun, stanceLeg, m);
    this.hipY += (tgtY - this.hipY) * Math.min(1, dt * Math.max(0, rate));
    const hipY = this.hipY;
    const out: LegAngles[] = [];
    const toeCurl: [number, number] = [0, 0];
    /**
     * ⭐ ГЕЙТ «ЭТО ШАГ ПОХОДКИ». Подъём носка и загиб носка настраиваются ПОД ФАЗУ ШАГА, но на
     * ПРИСТАВНОМ ШАГЕ (поворот на месте) нога тоже считается маховой — и обе ручки ехали в доворот,
     * которого они не описывают: «носки поднимает при повороте, а я настраивал их только для бега».
     *
     * ⚠ Не жёсткий 0/1 и не полный `moveAmt`: порог даёт щелчок на старте, а полная доля хода
     * урезала бы ручки на медленной ходьбе (moveAmt 0.5 → подъём вдвое меньше, чего никто не просил).
     * Полная сила уже при `moveAmt` 0.2 — то есть на любом реальном ходе.
     */
    const gaitStep = clamp(this.moveAmt / 0.2, 0, 1);
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i]!;
      const s = i === 0 ? this.hipHalf : -this.hipHalf;   // нога 0 = ЛЕВАЯ, её кость LeftUpperLeg сидит на +X (humanoid.ts) → якорь +X
      const hx = px + rx * s, hz = pz + rz * s;
      let wx: number, wz: number, wy: number;
      if (l.sw > 0) {
        // Маховая. При fixTarget цель зафиксирована на отрыве (выше). Иначе — едет за бедром: держится
        // на `lead` впереди ТЕКУЩЕГО бедра (пересчёт каждый кадр).
        if (!GAIT.fixTarget && moving) plant(l, i, hx, hz, leadS(i as 0 | 1));   // стоя приставной шаг держит зафиксированную цель (слот стойки)
        const t = l.sw;
        const p = swingXZ(i); wx = p[0]; wz = p[1];   // ⭐ ТА ЖЕ формула, что у передачи шага (см. `swingXZ`)
        wy = this.footFloor + Math.sin(Math.PI * t) * liftS(i as 0 | 1);
      } else {
        // ОПОРНАЯ: прибита к полу. ⭐ В ПОКОЕ — на АВТОРСКОЙ высоте (`StanceFoot.lift`): автор ставит
        // стопы не строго на пол, и пока планировщик клал обе ровно на него, колено выходило иначе
        // авторского, а заземление на передаче ног позе поднимало тело. Вес гаснет с движением.
        const lift = i === 0 ? this.stanceFoot.liftL : this.stanceFoot.liftR;
        wx = l.px; wz = l.pz; wy = this.footFloor + lift * (1 - clamp(this.moveAmt, 0, 1));
      }
      const a = ik(wx - hx, wz - hz, wy - (hipY + this.hipDrop), fx, fz, rx, rz, fwdLimS(i as 0 | 1), this.thighL, this.shinL);
      // АМПЛИТУДА БЕДРА. Подъём маховой стопы IK отдаёт почти целиком колену: бедро висит, нога
      // «поджимается и болтается». Сравниваем решение с решением ДЛЯ ТОЙ ЖЕ ТОЧКИ, НО НА ПОЛУ, и
      // масштабируем разницу — колено берём настоящее, поэтому бедро уводит ногу выше, а колено
      // догоняет. На отрыве и на приземлении стопа и так на полу → добавка ровно 0: стопа не едет,
      // опорная не трогается вовсе. hipSwing = 1 → g отбрасывается и числа прежние бит в бит.
      const k = hipSwS(i as 0 | 1);
      if (l.sw > 0 && k !== 1) {
        const g = ik(wx - hx, wz - hz, this.footFloor - (hipY + this.hipDrop), fx, fz, rx, rz, fwdLimS(i as 0 | 1), this.thighL, this.shinL);
        a.hip = g.hip + (a.hip - g.hip) * k;
      }
      // ГОЛЕНОСТОП. Только маховая: опорную забирает заземление и кладёт плоско (см. PoseTargets.ankL).
      //
      // Первое слагаемое — УДЕРЖАНИЕ ПОДОШВЫ. Наклон стопы в риге складывается из бедра и колена
      // (замерено покадрово), поэтому гасим ровно их сумму: подошва перестаёт болтаться вслед за
      // голенью. Это и убирает чирканье — носок уходил под пол не «мало поднимался», а был жёстко
      // приварен к голени, наклонённой на отрыве на 54°.
      //
      // Второе — добавка носком вверх поверх удержания. Знак МИНУС ЗАМЕРЕН: он поднимает носок.
      // ЗАГИБ НОСКА. Фаза сквозь отрыв: опора 0..1, отрыв = 1, перенос 1..2 (см. `GAIT.toeOff`).
      {
        const j2 = i as 0 | 1;
        const amt = locoVal('toeOff', 'toeOffRun', GAIT.toeOff, GAIT.toeOffRun, j2, m);
        if (Math.abs(amt) > 1e-6) {
          const f = locoVal('toeOffFrom', 'toeOffFromRun', GAIT.toeOffFrom, GAIT.toeOffFromRun, j2, m);
          const to = locoVal('toeOffTo', 'toeOffToRun', GAIT.toeOffTo, GAIT.toeOffToRun, j2, m);
          const x = l.sw > 0 ? 1 + clamp(l.sw, 0, 1) : clamp(this.supPhase[i]!, 0, 1);
          const span = to - f;
          const tt = span > 1e-4 ? clamp((x - f) / span, 0, 1) : 0;
          // ⚠ ЗНАК МИНУС ЗАМЕРЕН — ровно как у голеностопа строкой ниже: `+x` на кости носка его ОПУСКАЕТ.
          // Замер на рест-позе по КОНЧИКУ ПАЛЬЦА (не по углу кости!): ±0.8 рад → −2.869 / +2.869 по Y,
          // ОДИНАКОВО на обеих ногах. Зеркалить сторону НЕ НАДО: `LeftToes` и `RightToes` у нас с одним
          // локальным базисом ([0,−1,6] обе) — жалоба «правая гнётся вниз» была про ОБЩИЙ знак, а левая
          // не двигалась вовсе по другой причине (карта костей вела вспомогалку `*ShareBone`, см. retarget3d).
          toeCurl[i] = -amt * Math.sin(Math.PI * tt) * gaitStep;   // горб: ноль на обоих концах окна; вне ходьбы — 0
        }
      }
      const hold = -(a.hip + a.knee) * ankLvlS(i as 0 | 1);   // удержание подошвы (без носка)
      if (l.sw > 0) {
        // ⚠ ОКНО — только на УДЕРЖАНИЕ. У подъёма носка своя фаза (`toeLiftPhase`), и мешать их нельзя:
        // удержание гасит наклон ГОЛЕНИ, а подъём носка — это стиль поверх него.
        const want = hold * ankHoldS(l.sw, i as 0 | 1) - toeLiftS(i as 0 | 1) * toeCurve(l.sw, toePhS(i as 0 | 1)) * gaitStep;
        // Зажимаем В ПРЕДЕЛ СУСТАВА: см. `ankMax`. Манекен не должен просить того, чего физика не даст.
        a.ank = clamp(want, -GAIT.ankMax, GAIT.ankMax);
      } else if (this.plantW[i]! < 1) {
        // ⭐ ОТПУСКАЕМ ПОДОШВУ НЕ ЗА КАДР. Раньше на касании удержание пропадало мгновенно и стопа
        // наследовала наклон голени (замер: 0.19° → 12.93° за кадр). Теперь голеностоп отдаёт её
        // заземлению за `GAIT.footPlant` опорной фазы. При footPlant = 0 вес сразу 1 → ветка не
        // выполняется, и числа прежние бит в бит.
        // ⚠ ТОТ ЖЕ ВЕС НА ОТРЫВЕ (`sw = 0`), иначе опора кончится полным удержанием, а перенос начнётся
        // урезанным — ступенька ровно в той точке, которую и чиним.
        a.ank = clamp(hold * (1 - this.plantW[i]!) * ankHoldS(0, i as 0 | 1), -GAIT.ankMax, GAIT.ankMax);
      }
      out.push(a);
    }
    return { l: out[0]!, r: out[1]!, bobY: hipY - RIG_PELVIS_Y, toeCurl };   // gaitToHumanoid: 30 + bobY = hipY (актуальная высота таза; bobMult уже в dip)
  }
}

export class PoseDriver {
  private phase = Math.random() * 6.283;
  private move = 0;
  private attackT = 0;
  private attackPow = 1;
  private dead = false;
  private planner: StepPlanner | null = null;
  private stanceLatL: number | null = null; private stanceFwdL = 0; private stanceLatR = 0; private stanceFwdR = 0; private standY = GAIT.standY;
  /**
   * ⭐ ОРИЕНТАЦИЯ СТОПЫ ИЗ АВТОРСКОЙ СТОЙКИ. Планты планировщик брал оттуда давно, а стопу держал
   * «прямо» — и на передаче ног позе стопы ДОВОРАЧИВАЛИСЬ. ЗАМЕР расхождения поза↔планировщик
   * в покое: левая стопа по рыску 0.502 рад (28.8°), правая −0.296 (17°) и по наклону −0.314 (18°);
   * у бедра и голени — сотые. То есть «ступни скручиваются» — это почти целиком стопа, и расхождение
   * СТАТИЧЕСКОЕ, не от поворота.
   *
   * ⚠ Вес — `1 − moveAmt`: на ходу стопу ведёт походка (`footTurn`, голеностоп, заземление).
   * Умолчание — нули: `PoseDriver` без `setStance` (golden-харнесс, тесты) бит в бит как раньше.
   */
  private stanceFoot: StanceFoot = { pitchL: 0, yawL: 0, pitchR: 0, yawR: 0, liftL: 0, liftR: 0 };
  private w = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 };
  private armed = false;  // вооружён меч+щит → в покое/на ходу держит боевой ГАРД (не машет руками)
  private combat = 0;     // мирно(0) ↔ бой(1): боевая колонка настроек (Ф6). Нет записей — ведёт себя как раньше.
  /** Боевое состояние 0..1 — ИЗ ИГРЫ (серверный `inCombat`), тот же, что блендит стойку. */
  /** Высота кости-лодыжки при подошве на полу — из рига (см. `StepPlanner.footFloor`). */
  footFloor = FOOT_Y;
  /** Размеры ноги рига (см. `StepPlanner.legRest`). `null` — процедурный манекен, прежние константы. */
  legRest: { thigh: number; shin: number; hipHalfW: number; hipDropY: number } | null = null;
  setCombat(c: number): void { this.combat = Math.max(0, Math.min(1, c)); if (this.planner) this.planner.combat = this.combat; }
  readonly out: PoseTargets = {
    hipL: 0, hipR: 0, knL: 0, knR: 0, hipLatL: 0, hipLatR: 0, ankL: 0, ankR: 0, shL: 0, shR: 0, elL: 0, elR: 0,
    lean: 0, twist: 0, bobY: 0, splay: 0, twChest: 0, twUpper: 0,
    shTwL: 0, shTwR: 0, shSpL: 0, shSpR: 0, hipTwL: 0, hipTwR: 0, leanSide: 0, headNod: 0, headTurn: 0, headTilt: 0,
    ankYawL: 0, ankYawR: 0, hipSplayL: 0, hipSplayR: 0, bobX: 0, hipsRoll: 0, hipsPitch: 0, hipsYaw: 0,
    toeCurlL: 0, toeCurlR: 0,
    shoLX: 0, shoLY: 0, shoLZ: 0, shoRX: 0, shoRY: 0, shoRZ: 0,
    wLX: 0, wLY: 0, wLZ: 0, wRX: 0, wRY: 0, wRZ: 0,
  };

  setMove(s: number): void { this.move = Math.max(0, Math.min(1.4, s)); }
  /** Включает походку с опорой: позиция/рыск/скорость тела в мире (юниты, u/с). */
  setWorld(x: number, z: number, yaw: number, vx: number, vz: number): void {
    if (!this.planner) {
      this.planner = new StepPlanner();
      // Стойку передаём ТОЛЬКО замеренную: иначе планировщик возьмёт полутаз рига, а не нашу константу.
      if (this.stanceLatL !== null) this.planner.setStance(this.stanceLatL, this.stanceFwdL, this.stanceLatR, this.stanceFwdR, this.standY, this.stanceFoot);
    }
    this.planner.footFloor = this.footFloor;   // пол для лодыжки — из рига, см. `StepPlanner.footFloor`
    this.planner.legRest = this.legRest;       // длины бедра/голени и полутаз — из рига, не из констант
    this.w.x = x; this.w.z = z; this.w.yaw = yaw; this.w.vx = vx; this.w.vz = vz;
  }
  /** Обратная связь от физики: где НА САМОМ ДЕЛЕ стоят щиколотки (мир). Плантуем по факту, а не по расчёту. */
  setFeet(lx: number, lz: number, rx: number, rz: number): void { this.planner?.setFeet(lx, lz, rx, rz); }
  /** Ноги сейчас ведёт слот действия (подшаг из клипа) — планировщик не возвращает стопу домой. */
  setLegsHeld(v: boolean): void { this.planner?.setLegsHeld(v); }
  /** См. `StepPlanner.replant`. */
  replant(): void { this.planner?.replant(); }
  /**
   * ⭐⭐ ВЫБРОСИТЬ ПЛАНИРОВЩИК ЦЕЛИКОМ — состояние походки с нуля (ЗАПЕКАНИЕ). `setWorld` соберёт новый и вернёт
   * ему замеренную стойку, пол и длины рига; фаза стартует с 0, а не с `Math.random()`.
   *
   * ⚠ ЗАЧЕМ ЭТО НУЖНО СЪЁМУ (ЗАМЕР 19.09): `bakeGaitSet` гоняет ВСЕ пресеты через ОДИН `PosePlayer`, а разогрев
   * 2 с фазу и планты НЕ обнуляет — и правка одной ручки сдвигала КАЖДЫЙ клип, снятый ПОСЛЕ неё. Замер: ручка
   * колонки `STRAFE_L` двигала `run_back` на 22.48°, а `walk_strafe_R` на 2.22°, при том что всё, снятое ДО неё,
   * оставалось 0.00° — то есть порядок кнопок в списке влиял на содержимое чужих клипов. Контрольный опыт с
   * ручкой колонки `BACK` дал ту же картину, значит беда не в сторонах страйфа, а в общем состоянии плеера.
   */
  resetPlanner(): void { this.planner = null; this.phase = 0; this.turnNow = 0; }
  /** Авторский сдвиг плант-цели (body-local fwd/lat) на ногу — для редактора. Дефолт 0 → без эффекта. */
  setPlantOffset(lF: number, lL: number, rF: number, rL: number): void { this.planner?.setPlantOffset(lF, lL, rF, rL); }
  /** Точки обвода свинга на ногу (body-local fwd,lat). Пусто → прямой свинг. */
  setPlantVia(lVia: [number, number][], rVia: [number, number][]): void { this.planner?.setPlantVia(lVia, rVia); }
  /** Планты стоп из idle-стойки: по каждой ноге body-local (lat, fwd) СО ЗНАКОМ + базовая высота таза standY (всё замер
   *  measureStancePlants). Стоя держит стопы в этих точках, при повороте переступает в них; таз не поднимается выше standY. */
  setStance(latL: number, fwdL: number, latR: number, fwdR: number, standY?: number, foot?: StanceFoot): void {
    this.stanceLatL = latL; this.stanceFwdL = fwdL; this.stanceLatR = latR; this.stanceFwdR = fwdR;
    if (foot) this.stanceFoot = foot;
    if (standY !== undefined) this.standY = standY;
    this.planner?.setStance(latL, fwdL, latR, fwdR, standY, foot ?? this.stanceFoot);
  }
  /** Текущая плант-цель ноги i в мире (для наземных маркеров редактора). */
  plantTarget(i: number): [number, number] { return this.planner ? this.planner.getTarget(i) : [0, 0]; }
  /** Фаза походки (рад, π на шаг) — ею Ф4 сэмплирует клип локомоции, а не своим таймером. */
  get gaitPhase(): number { return this.phase; }
  /**
   * ⭐⭐ СТАТИЧЕСКИЙ ПОВОРОТ ТАЗА этого кадра (рад, + = вправо) — ЭТО ПОЗА, А НЕ КУРС, и её КЛАДЁТ НЕ ЗДЕСЬ.
   *
   * Читает это число `PosePlayer.step` и кладёт его на кость таза ПОСЛЕДНИМ швом (`applyHipsTurn`) — уже после
   * того, как снят фидбэк фактических стоп. Планировщик о повороте не знает НИ ОДНИМ путём: ни курсом, ни через
   * стопы. Требование автора (19.09): «поворот таза не влияет на планты и на движение ног».
   *
   * ⚠ СТОЯ — НОЛЬ (гейт `gaitStepD`, как у `kneeDir`/`hipSplay`/носка): это ручка ПОХОДКИ, и разворачивать
   * ею авторскую стойку нельзя — «эталонная стойка при прокрутке на месте должна быть idle 1:1».
   * ⚠ ЗДЕСЬ ТОЛЬКО ЧТЕНИЕ. Считает и двигает его `stepHipsTurn` внутри `update` — угол нужен с ПРЕДЕЛОМ
   * СКОРОСТИ, а значит со своим состоянием и с `dt`.
   */
  get hipsTurn(): number { return this.turnNow; }
  private turnNow = 0;
  /**
   * ⭐⭐ ПРЕДЕЛ СКОРОСТИ ПОВОРОТА ТАЗА — ТОТ ЖЕ `GAIT.warpRate` (°/с, 0 = без предела), что у доворота: это
   * один и тот же физический канал (рыск таза), и держать для него два разных потолка не за что.
   *
   * ⚠ ЗАЧЕМ. Ручка умножается на боковитость `st` и на долю стороны, а НИ ОДНА ИЗ НИХ НЕ СГЛАЖЕНА ПО ВРЕМЕНИ:
   *  • отпустил страйф — инерции у сервера нет, скорость 80 → 0 за тик, `st` — жёсткое `moving ? … : 0`, и
   *    ±35° (ровно то, что пишет `migrateHipsOpen`) умирали ЗА ОДИН КАДР: 2100 °/с при 60 Гц, 5040 при 144;
   *  • разворот A↔D — `mLat` берётся от сглаженного вектора, `st` держится на 1.000, а полоса сторон ±3.44°
   *    проскакивается за ~1.4 кадра: шаг до 26.4° за кадр, и он РАСТЁТ с частотой кадров — ровно тот класс
   *    беды, который запрещает `torsoJitter.test.ts`.
   * Предел стоит НА ВЫХОДЕ (после гейта и колонок), поэтому ловит оба случая одним швом.
   */
  private stepHipsTurn(dt: number, m: LocoMix, gate: number): number {
    // ⚠ БЕЗ ПЛАНИРОВЩИКА (монстры, превью) — НОЛЬ, как и раньше: `POSE` глобален, и без этой строки ручка
    // игрока разворачивала бы таз каждому бегущему монстру.
    const want = this.planner && gate > 0 ? locoVal('hipsTurn', 'hipsTurnRun', POSE.hipsTurn, POSE.hipsTurnRun, 0, m) * gate : 0;
    const lim = GAIT.warpRate > 0 ? GAIT.warpRate * Math.PI / 180 * Math.max(0, dt) : Infinity;
    this.turnNow += clamp(want - this.turnNow, -lim, lim);
    return this.turnNow;
  }
  /** Фейсинг ПРИЦЕЛА (куда доворачивает таз) — подшаг целит стопу в идл-стойку НА НЁМ. null → текущий yaw (как было). */
  setGoalYaw(y: number | null): void { this.planner?.setGoalYaw(y); }
  /** Идл-стойка ноги i на гол-фейсинге (прицел) — куда приземлится подшаг. Целевые маркеры редактора «Повороты». */
  stanceAtGoal(i: number): [number, number] { return this.planner ? this.planner.stanceAtGoal(i) : [0, 0]; }
  /** Планировщик активно переступает (ход / подшаг при развороте на месте). */
  get stepping(): boolean { return this.planner ? this.planner.stepping : false; }
  /** Какие ноги в переносе [левая, правая] — для тестов/отладки порядка приставных шагов. */
  get swingLegs(): [boolean, boolean] { return this.planner ? this.planner.swing : [false, false]; }
  /** Доля пройденной опорной фазы каждой ноги 0..1 (см. `StepPlanner.supportPhase`) — для окна заземления. */
  get supportPhase(): [number, number] { return this.planner ? this.planner.supportPhase : [1, 1]; }
  /** ВЕС заземления на ногу 0..1 — ОДИН шов на игру и редактор (см. `StepPlanner.groundWeights`). */
  get groundWeights(): [number, number] { return this.planner ? this.planner.groundWeights : [1, 1]; }
  /** ВЕС ПОСТАНОВКИ стопы на ногу 0..1 (см. `StepPlanner.plantWeights`) — мягкость укладки подошвы. */
  get plantWeights(): [number, number] { return this.planner ? this.planner.plantWeights : [1, 1]; }
  /** Во сколько раз сейчас ускорена фаза — диагностика срочности шага. */
  get debugUrge(): number { return this.planner ? this.planner.debugUrge : 1; }
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
    o.ankYawL = o.ankYawR = 0; o.hipSplayL = o.hipSplayR = 0; o.bobX = 0; o.hipsRoll = 0; o.hipsPitch = 0; o.hipsYaw = 0;
    o.toeCurlL = o.toeCurlR = 0;
    o.twChest = o.twUpper = 0;
    o.headNod = o.headTurn = o.headTilt = 0;
    o.wLX = o.wLY = o.wLZ = o.wRX = o.wRY = o.wRZ = 0;
    if (this.dead) {
      o.splay = 1; o.bobY = -26; o.lean = 1.4; o.twist = 0;
      o.hipL = 0.7; o.hipR = -0.7; o.knL = 1.2; o.knR = 1.2; o.shL = 0.7; o.shR = -0.7; o.elL = 1.2; o.elR = 1.2;
      this.turnNow = 0;   // у трупа поворота таза нет: иначе он замер бы на угле последнего страйфа
      return o;
    }
    // «Ход» для рук/наклона: кинематике (монстры) — из setMove, рэгдоллу — из реальной скорости тела
    // (setMove ему не зовут), которую планировщик отдаёт сглаженной в moveAmt.
    let drive = this.move;

    if (this.planner) {
      const w = this.w;
      const g = this.planner.update(dt, w.x, w.z, w.yaw, w.vx, w.vz);
      o.hipL = g.l.hip; o.knL = g.l.knee; o.hipLatL = g.l.lat; o.ankL = g.l.ank;
      o.hipR = g.r.hip; o.knR = g.r.knee; o.hipLatR = g.r.lat; o.ankR = g.r.ank;
      o.bobY = g.bobY;
      o.toeCurlL = g.toeCurl[0]; o.toeCurlR = g.toeCurl[1];
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
      o.ankL = 0; o.ankR = 0;   // без планировщика фазы переноса нет — стопа плоская, как и было
    }

    const walking = drive > 0.05;
    const s = Math.sin(this.phase);
    const amp = walkingAmp(drive);   // ОДНА формула на всё качание (раньше та же строка стояла дважды)
    o.splay = 0;
    // Раздельные руки ходьба↔бег: sb (0 ходьба … 1 бег) из планировщика (игрок), у монстра (без планировщика) — из drive.
    const sb = this.planner?.sb ?? clamp((drive - 1) / 0.4, 0, 1);
    o.sb = sb;
    // Направление хода: у монстров планировщика нет — им колонки направления не положены
    // (st = bt = 0, то есть ровно прежнее поведение).
    const st = this.planner?.st ?? 0, bt = this.planner?.bt ?? 0;
    // Стороны страйфа — оттуда же. Нет планировщика → обе нули (карты сторон и не спросят).
    const stR = this.planner?.stR ?? 0, stL = this.planner?.stL ?? 0;
    o.st = st; o.bt = bt;
    const m: LocoMix = { sb, st, stR, stL, bt, ct: this.combat };
    o.mix = m;   // ⭐ полная смесь наружу: ею читают колонки те ручки, что живут в `poseRuntime` (см. `PoseTargets.mix`)
    // Руки — на сторону (ASYM/STRAFE пусты → оба значения одинаковы и это ровно прежние числа).
    const armSh = (i: 0 | 1): number => locoVal('armSh', 'armShRun', POSE.armSh, POSE.armShRun, i, m);
    const armEl = (i: 0 | 1): number => locoVal('armEl', 'armElRun', POSE.armEl, POSE.armElRun, i, m);
    const armSwing = (i: 0 | 1): number => locoVal('armSwing', 'armSwingRun', POSE.armSwing, POSE.armSwingRun, i, m);
    // ФАЗА. `armPhase` крутит саму руку (и пояс едет за ней), `shoPhase` — только пояс относительно
    // своей руки. −1 переворачивает мах, 0 гасит. Умножаются, а не складываются: это множители фазы.
    const armPh = (i: 0 | 1): number => locoVal('armPhase', 'armPhaseRun', POSE.armPhase, POSE.armPhaseRun, i, m);
    const shoPh = (i: 0 | 1): number => locoVal('shoPhase', 'shoPhaseRun', POSE.shoPhase, POSE.shoPhaseRun, i, m);
    const elAmp = (i: 0 | 1): number => locoVal('armElAmp', 'armElAmpRun', POSE.armElAmp, POSE.armElAmpRun, i, m);
    // НАПРАВЛЕНИЕ СГИБА КОЛЕН И ЛОКТЕЙ (полюс). Крутим вышележащую кость вдоль её оси: бедро
    // разворачивает колено, плечо — локоть. Знак ЗЕРКАЛЕН по сторонам (риг: Left на +X, см.
    // [[humanoid-rig-mirror]]), поэтому ОДНА ручка разводит ОБА сустава наружу, а не уводит оба влево.
    //
    // ⭐ ЗНАКИ ЗАМЕРЕНЫ, а не выведены — и у рук он ОКАЗАЛСЯ ОБРАТНЫМ к ногам (рука висит вниз
    // через поворот по Z, и тот же твист по Y даёт другой знак). Поэтому у рук стоит минус: без него
    // один и тот же «+» разводил бы колени наружу, а локти прижимал к телу. Замер полюса (вынос
    // среднего сустава от линии бедро→стопа / плечо→кисть), 0.4 рад, единицы по X:
    //   колени  Л +1.13  П −1.13   локти  Л +1.78  П −1.65   — оба разводятся наружу.
    // (у рук числа не строго равны: мах в противофазе, и полюс зависит от текущего сгиба локтя.)
    const knMax = Math.min(Math.abs(GAIT.kneeDirMax), Math.PI - 1e-3);
    const elMax = Math.PI - 1e-3;   // потолок-ручки нет (сустав свободен) — только страховка от заворота
    /** Тот же гейт «это шаг походки», что в планировщике: полная сила уже на любом реальном ходе. */
    const gaitStepD = clamp((this.planner ? this.planner.moveAmt : this.move) / 0.2, 0, 1);
    const kneeDir = (i: 0 | 1): number => clamp(locoVal('kneeDir', 'kneeDirRun', GAIT.kneeDir, GAIT.kneeDirRun, i, m), -knMax, knMax);
    const elbowDir = (i: 0 | 1): number => clamp(locoVal('elbowDir', 'elbowDirRun', POSE.elbowDir, POSE.elbowDirRun, i, m), -elMax, elMax);
    // ⭐ СТОЯ НИЧЕГО НЕ ДОБАВЛЯЕМ К НОГАМ. Полюс колена — ручка ПОХОДКИ; на приставном шаге (поворот
    // на месте) её незачем класть поверх авторской стойки: «эталонная стойка при прокрутке на месте
    // должна быть idle 1:1». Тот же гейт, что у носка (`gaitStepD`).
    o.hipTwL = kneeDir(0) * gaitStepD; o.hipTwR = -kneeDir(1) * gaitStepD;
    // Носок и разведение бедра — те же колонки настроек и то же зеркало, что у колена.
    const footTurn = (i: 0 | 1): number => locoVal('footTurn', 'footTurnRun', POSE.footTurn, POSE.footTurnRun, i, m);
    const hipSplay = (i: 0 | 1): number => locoVal('hipSplay', 'hipSplayRun', POSE.hipSplay, POSE.hipSplayRun, i, m);
    // ⚠ ЗНАК ЗАМЕРЕН ПО ПАЛЬЦУ, А НЕ ПО УГЛУ. Угол кости читается неочевидно, поэтому мерили ВЫНОС
    // ПАЛЬЦА ОТ ЛОДЫЖКИ по X у ЛЕВОЙ стопы: база +2.06, при −кнопке +4.42 (наружу), при +кнопке −1.00 (внутрь).
    // Значит для «+ = наружу» (как у `kneeDir`) нужен ПРЯМОЙ знак слева и зеркало справа.
    // ⭐ СТОПА: КРОССФЕЙД «АВТОРСКАЯ СТОЙКА ↔ ПОХОДКА» (см. `stanceFoot`).
    // ⚠ Именно КРОССФЕЙД, а не прибавка: `footTurn` — ходовая ручка, и в покое она продолжала крутить
    // стопу поверх авторской. ЗАМЕР (у воина `footTurn` = −0.36): авторский рыск слева +0.142, а на
    // выходе стояло −0.218 — ровно на ползунок мимо. Теперь стоя выход = авторская стопа РОВНО.
    const mv = clamp(this.planner ? this.planner.moveAmt : this.move, 0, 1);
    o.ankYawL = footTurn(0) * mv + this.stanceFoot.yawL * (1 - mv);
    o.ankYawR = -footTurn(1) * mv + this.stanceFoot.yawR * (1 - mv);
    o.ankL += this.stanceFoot.pitchL * (1 - mv); o.ankR += this.stanceFoot.pitchR * (1 - mv);
    // Развод бёдер идёт ОТДЕЛЬНЫМ каналом, а не прибавкой к решению IK: прибавка уводила стопу
    // с планта на 19 ед (замер), то есть ломала походку вместо разведения колен.
    o.hipSplayL = hipSplay(0) * gaitStepD; o.hipSplayR = hipSplay(1) * gaitStepD;   // развод бёдер — тоже ходовая ручка (см. `gaitStepD`)
    // Локти — ДО веток: боевой ГАРД ниже перезапишет твист своей авторской стойкой, и это верно.
    o.shTwL = -elbowDir(0); o.shTwR = elbowDir(1);
    // Ручки ТЕЛА (не стороны): берём сторону 0 — ASYM для них панель не разводит.
    // ⚠ Раньше здесь стоял вызов БЕЗ боевой колонки, и семь ручек (весь наклон и вся скрутка)
    // в бою читались мирными: панель их писала, рантайм не читал. Теперь цепочка одна на всех.
    const body = (kw: string, kr: string, bw: number, br: number): number => locoVal(kw, kr, bw, br, 0, m);
    o.lean = walking
      ? body('leanWalk', 'leanWalkRun', POSE.leanWalk, POSE.leanWalkRun)
        + drive * body('leanSpeed', 'leanSpeedRun', POSE.leanSpeed, POSE.leanSpeedRun)
      : POSE.leanIdle;
    o.leanSide = s * amp * body('leanSideSwing', 'leanSideSwingRun', POSE.leanSideSwing, POSE.leanSideSwingRun);
    // ТАЗ. Та же фаза `s * amp`, что у рук и скрутки корпуса: перевал на опорную ногу идёт в такт шагу.
    o.bobX = s * amp * body('hipSway', 'hipSwayRun', POSE.hipSway, POSE.hipSwayRun);
    o.hipsRoll = s * amp * body('hipsRollSwing', 'hipsRollSwingRun', POSE.hipsRollSwing, POSE.hipsRollSwingRun);
    o.hipsPitch = s * amp * body('hipsPitchSwing', 'hipsPitchSwingRun', POSE.hipsPitchSwing, POSE.hipsPitchSwingRun);
    // РЫСК — та же фаза и та же амплитуда, что у крена и наклона. ⚠ ЗДЕСЬ ТОЛЬКО КАЧАНИЕ: статический поворот
    // тоже идёт на кость, но ОТДЕЛЬНЫМ швом (`PosePlayer.applyHipsTurn`) и ПОСЛЕ того, как снят фидбэк стоп, —
    // иначе планировщик увидит повёрнутые стопы и погонится за ними (см. `PoseDriver.hipsTurn`).
    o.hipsYaw = s * amp * body('hipsYawSwing', 'hipsYawSwingRun', POSE.hipsYawSwing, POSE.hipsYawSwingRun);
    this.stepHipsTurn(dt, m, gaitStepD);   // угол этого кадра (с пределом скорости) → `hipsTurn`
    const eArmSh = armSh(0), eArmEl = armEl(0);   // для веток, где стороны не разводятся (удар/гард)
    // ── КЛЮЧИЦЫ. Плечевой пояс больше не «сводится в ноль» на ходу: у него своя поза и своё качание.
    // dev — отклонение плеча своей руки от базы (<0 = рука ушла вперёд). Пояс идёт за рукой вперёд
    // (shoSwing) и одновременно чуть поднимается (shoLift) — так плечо катится, а не едет по прямой.
    const sPh = s, ampS = amp;   // фаза и амплитуда у пояса ТЕ ЖЕ, что у рук — иначе ручка чинит половину
    for (let i = 0 as 0 | 1; i < 2; i = (i + 1) as 0 | 1) {
      const dev = (i === 0 ? -1 : 1) * sPh * ampS * armSwing(i) * armPh(i) * shoPh(i);
      // ⚠⚠ ЧЕРЕЗ `locoVal`, А НЕ `sideLerp`. Пять ручек пояса читались `sideLerp`, у которого `LocoMix` нет в
      // принципе — то есть КОЛОНКУ НАПРАВЛЕНИЯ они не спрашивали вовсе. Редактор при этом честно рисовал их на
      // вкладках «НАЗАД», «СТРАЙФ», «БОЙ», запись уходила в карту колонки, и её никто не читал: ползунок был
      // МЁРТВЫМ. Жалоба автора «на назад половина настроек не работает» — про это.
      // ⚠ Разрыв был ВНУТРИ ОДНОЙ СВЯЗКИ: `armSh`/`armEl` строкой выше колонку читают, а пояс, который идёт за
      // той же рукой и множится на то же `dev`, — нет. Настраиваешь половину связки, вторая молчит.
      const up = locoVal('shoUp', 'shoUpRun', POSE.shoUp, POSE.shoUpRun, i, m)
        + locoVal('shoLift', 'shoLiftRun', POSE.shoLift, POSE.shoLiftRun, i, m) * -dev;
      const fwd = locoVal('shoFwd', 'shoFwdRun', POSE.shoFwd, POSE.shoFwdRun, i, m)
        + locoVal('shoSwing', 'shoSwingRun', POSE.shoSwing, POSE.shoSwingRun, i, m) * -dev;
      const tw = locoVal('shoTw', 'shoTwRun', POSE.shoTw, POSE.shoTwRun, i, m);
      // Риг зеркальный (Left на +X): подъём = вокруг Z со знаком стороны, вынос вперёд = вокруг −Y, скрутка = вдоль X.
      const sg = i === 0 ? 1 : -1;
      if (i === 0) { o.shoLX = sg * tw; o.shoLY = -sg * fwd; o.shoLZ = sg * up; }
      else { o.shoRX = sg * tw; o.shoRY = -sg * fwd; o.shoRZ = sg * up; }
    }

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
      const swL = s * amp * armSwing(0) * armPh(0), swR = s * amp * armSwing(1) * armPh(1);
      // ⚠ ЗАЖИМАЕМ В ПОТОЛОК: см. `armSwingMax`. Без этого большой мах переваливает за пол-оборота, и
      // рука «прыгает назад» — не от сбоя, а потому что у ориентации нет «дальше 180°».
      const shMax = Math.min(Math.abs(POSE.armSwingMax), Math.PI - 1e-3);
      o.shL = clamp(armSh(0) - swL, -shMax, shMax);
      o.shR = clamp(armSh(1) + swR, -shMax, shMax);
      // ЛОКОТЬ: база + КОЛЕБАНИЕ в такт маху. «Вперёд» у руки — это меньший угол плеча (замер: плечо
      // −0.5 уводит кисть на +11.2 по Z, и слева, и справа), поэтому вынос вперёд левой = +swL, правой
      // = −swR. На переднем махе локоть подбирается, на заднем распрямляется — то самое «в какой момент».
      // ⚠ КЛАМП, А НЕ СКЛАДКА: снизу 0 (локоть назад не гнётся), сверху предел шарнира — см. `elbowMax`.
      const ebMax = Math.min(Math.abs(POSE.elbowMax), Math.PI - 1e-3);
      o.elL = clamp(armEl(0) + swL * elAmp(0), 0, ebMax);
      o.elR = clamp(armEl(1) - swR * elAmp(1), 0, ebMax);
      // СКРУТКА КОРПУСА тремя ярусами под одной фазой. Поясница — как было (0.15 по умолчанию), грудь и
      // верхняя грудь — сверху и по нулям, пока их не тронут. Верхняя и есть «ключица вперёд/назад»:
      // она сидит прямо под ключицами, поэтому разводит плечи, а не гнёт талию.
      const twA = s * amp * body('twistPhase', 'twistPhaseRun', POSE.twistPhase, POSE.twistPhaseRun);
      o.twist = twA * body('twistSwing', 'twistSwingRun', POSE.twistSwing, POSE.twistSwingRun);
      o.twChest = twA * body('twistChest', 'twistChestRun', POSE.twistChest, POSE.twistChestRun);
      o.twUpper = twA * body('twistUpper', 'twistUpperRun', POSE.twistUpper, POSE.twistUpperRun);
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
        shR = lerp(eArmSh, -0.25, t); shSp = lerp(0, 1.2, t); elR = lerp(eArmEl, 1.35, t);
        o.lean = lerp(0.02, -0.06, t); o.twist = lerp(0, -0.2, t);
      } else if (p < 0.68) {                                   // УДАР: рука падает со стороны ВНИЗ-вперёд (диагональ)
        const t = ss((p - 0.36) / 0.32);
        shR = lerp(-0.25, -0.45, t); shSp = lerp(1.2, -0.1, t); elR = lerp(1.35, 0.15, t);
        o.lean = lerp(-0.06, 0.24, t); o.twist = lerp(-0.2, 0.26, t);
      } else {                                                 // ВОЗВРАТ в стойку
        const t = ss((p - 0.68) / 0.32);
        shR = lerp(-0.45, eArmSh, t); shSp = lerp(-0.1, 0, t); elR = lerp(0.15, eArmEl, t);
        o.lean = lerp(0.24, 0.02, t); o.twist = lerp(0.26, 0, t);
      }
      // ⚠️ Риг L/R зеркальны: МЕЧ визуально СПРАВА = L-кости. Машем L-рукой, twist зеркалим.
      o.shL = shR; o.shSpL = shSp; o.elL = elR;
      o.twist = -o.twist;
      if (this.armed) {   // off-рука (виз. слева = R-кости) держит щит-гард
        o.shR = GUARD.shLX; o.shSpR = GUARD.shLZ; o.shTwR = GUARD.shLY; o.elR = GUARD.elL;
      } else {
        o.shR = eArmSh; o.elR = eArmEl;                // не-бьющая рука в базовой позе
      }
    }
    return o;
  }
}
