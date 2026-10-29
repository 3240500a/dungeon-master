/**
 * АНАЛИЗАТОР ПОХОДКИ (Ф3): клип → настройки планировщика. Обратная операция к `clipBake.ts`.
 *
 * Зачем. Купленный пак локомоции — это чужая походка с чужими длиной шага, каденцией и шириной
 * стойки. Подгонять под неё два десятка ползунков руками — часы, и результат всё равно «на глаз».
 * Анализатор снимает эти числа С САМОГО КЛИПА, и дальше процедурная сторона и клип похожи ДО того,
 * как их начнут смешивать (Ф4) — иначе ползунок смешивания даёт двух персонажей в одном.
 *
 * ЧЕМ ЭТО ПРОВЕРЯЕТСЯ. У нас есть обе стороны, а значит есть круговой тест: `анализ(запекание(P)) ≈ P`.
 * Редкая возможность проверить инструмент им же самим — и она поймала не одну ошибку знака.
 *
 * ДВА НЕОЧЕВИДНЫХ РЕШЕНИЯ.
 *
 * 1. ДЛИНА ШАГА СЧИТАЕТСЯ ИЗ СКОРОСТИ И ПЕРИОДА, а не из размаха стопы. Фаза планировщика едет от
 *    ПРОЙДЕННОГО ПУТИ (`speed·dt/stepLen·π`), поэтому шаг занимает ровно `stepLen/speed` секунд, а
 *    цикл — вдвое больше. Отсюда `stepLen = speed·период/2` — точное равенство, а не оценка. Размах
 *    стопы тоже меряется, но идёт не в настройку, а в ДИАГНОСТИКУ: расхождение этих двух чисел и есть
 *    проскальзывание стопы. Спутать их — значит записать скольжение в длину шага и закрепить его.
 *
 * 2. СКОРОСТЬ БЕРЁТСЯ ИЗ КОРНЯ КЛИПА (Ф2). Клип in-place и сам по себе о скорости ничего не знает;
 *    именно за этим канал корня и заводился. Нет корня — скорость обязан сообщить вызывающий, иначе
 *    честного ответа нет, и мы его не выдумываем.
 *
 * Модуль чистый (three + модель клипа), поэтому целиком тестируется в node.
 */
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { clipDur, clipPoseAt, hipsOffset, rootMotion, type Clip, type Pose } from './clipModel.js';

export interface GaitMeasure {
  /** Длительность цикла (два шага), сек. */
  periodSec: number;
  /** Скорость, с которой клип был снят (ед/с). `null` — корня нет и снаружи не сказали. */
  speed: number | null;
  /** Длина шага, ед. Из скорости и периода — см. шапку. */
  stepLen: number | null;
  /** Размах стопы вдоль тела, ед. Диагностика, в настройку не идёт. */
  footRange: number;
  /** Проскальзывание 0..1: насколько размах стопы разошёлся с длиной шага. `null` без скорости. */
  slide: number | null;
  /** Доля опоры 0..1 (усреднена по ногам). */
  duty: number;
  /** Подъём маховой стопы над полом, ед. */
  lift: number;
  /** Размах таза по высоте, ед. */
  bob: number;
  /** Полуширина стойки: среднее боковое отстояние стопы от таза на опоре, ед. */
  stanceWidth: number;
  /** Амплитуда маха плеча (рад) и его средний угол. */
  armSwing: number;
  armSh: number;
  /** Средний сгиб локтя (рад). */
  armEl: number;
  /** Поворот персонажа за клип (рад) — для поворотных клипов. `null`, если корня нет. */
  turnRad: number | null;
  /** Сколько ШАГОВ в клипе: переходов «стопа оторвалась». Для поворотных — во сколько приёмов разворот. */
  steps: number;
  frames: number;
  /**
   * ⭐ НАПРАВЛЕНИЕ ХОДА клипа от корня, ° (atan2(x, z): 0 — вперёд, +90 — к +X, то есть `strafe_R`). Куда уезжает
   * ОПОРНАЯ стопа — с минусом. Контакт здесь без направления (см. `contactSpeedTol`): старый признак мерит скорость
   * только вдоль Z и на страйфе отбрасывает ВСЕ кадры опоры. `null` — опоры не нашлось.
   */
  travelDeg: number | null;
  /** Средняя впечённая скрутка корпуса ΣY(Spine..Head), °. У кардинального клипа хода ≈ 0 (доворот — дело рантайма). */
  torsoTwistDeg: number;
}

export interface AnalyzeOptions {
  /** Частота съёма. 60 — как игровой кадр; мельче не нужно, крупнее теряет контакт. */
  fps?: number;
  /** Готовый риг (чтобы не пересобирать на каждый клип пака). */
  human?: Humanoid;
  /** Скорость, если клип снят без корня. */
  speed?: number;
  /**
   * Порог контакта над полом — ДОЛЯ ДЛИНЫ НОГИ (а не подъёма стопы и не абсолют).
   *
   * ⚠ Доля ПОДЪЁМА тут не работает, и это замерено: на бегу подъём вдвое больше, порог растёт вместе
   * с ним и съедает ровно ту разницу, которую мы меряем — доля опоры выходила на бегу БОЛЬШЕ, чем на
   * ходьбе (0.32 против 0.28 при эталоне 0.20 против 0.34). Абсолют же не переносится на другой риг.
   * Доля ноги свободна от обоих пороков. Замер на воине: 0.105 даёт 0.34 и 0.20 — ровно эталон.
   */
  contactLegFrac?: number;
  /** Допуск на совпадение скорости стопы с −speed (доля). Замер: 0.45 попадает в эталон на обоих режимах. */
  contactSpeedTol?: number;
}

const _v = new THREE.Vector3();

/** Поставить риг в позу клипа: повороты костей + офсет таза. Спец-ключи (кроме таза) игнорируем. */
function applyPose(h: Humanoid, p: Pose): void {
  h.reset();
  for (const nm in p) {
    if (nm[0] === '_') continue;
    const b = h.bones.get(nm); if (!b) continue;
    const v = p[nm]!;
    b.rotation.set(v[0], v[1], v[2]);
  }
  const d = hipsOffset(p, h.hipsRest.y);
  if (d) h.hips.position.set(h.hipsRest.x + d[0], h.hipsRest.y + d[1], h.hipsRest.z + d[2]);
  h.root.updateMatrixWorld(true);
}

const world = (h: Humanoid, name: string): THREE.Vector3 => h.bones.get(name)!.getWorldPosition(_v).clone();

export function analyzeGait(clip: Clip, opts: AnalyzeOptions = {}): GaitMeasure {
  const fps = Math.max(10, opts.fps ?? 60);
  const dur = clipDur(clip);
  const n = Math.max(2, Math.round(dur * fps) + 1);
  const h = opts.human ?? buildHumanoid({});
  // Скорость нужна РАНЬШЕ контактов (по ней отличают опорную стопу от маховой), поэтому корень читаем
  // сразу — из первого и последнего кадра, до основного прохода.
  const rFirst = rootMotion(clipPoseAt(clip, 0)), rLast = rootMotion(clipPoseAt(clip, 1));
  const travel = rFirst && rLast ? Math.hypot(rLast[1] - rFirst[1], rLast[2] - rFirst[2]) : 0;
  const speed0 = opts.speed ?? (travel > 1e-6 && dur > 1e-6 ? travel / dur : null);
  // Длина ноги в rest — масштаб рига. От неё берётся порог контакта, иначе он не переносится на монстра.
  h.reset(); h.root.updateMatrixWorld(true);
  const legLen = world(h, 'LeftUpperLeg').distanceTo(world(h, 'LeftFoot')) || 28.5;

  // ── Проход: позиции стоп и таза по кадрам ──
  const footY: [number[], number[]] = [[], []];
  const footZ: [number[], number[]] = [[], []];
  const footX: [number[], number[]] = [[], []];
  const hipsY: number[] = [];
  let twistSum = 0;
  const shX: number[] = [], elY: number[] = [];

  for (let i = 0; i < n; i++) {
    const u = n > 1 ? i / (n - 1) : 0;
    const pose = clipPoseAt(clip, u);
    applyPose(h, pose);
    const hip = world(h, 'Hips');
    hipsY.push(hip.y);
    for (let leg = 0 as 0 | 1; leg < 2; leg = (leg + 1) as 0 | 1) {
      const f = world(h, leg === 0 ? 'LeftFoot' : 'RightFoot');
      footY[leg].push(f.y); footZ[leg].push(f.z - hip.z); footX[leg].push(f.x - hip.x);
    }
    for (const b of TWIST_CHAIN) twistSum += pose[b]?.[1] ?? 0;
    const sh = pose['LeftUpperArm'], el = pose['LeftLowerArm'];
    shX.push(sh ? sh[0] : 0); elY.push(el ? Math.abs(el[1]) : 0);
  }

  // ── Пол и контакты ──
  const groundY = Math.min(...footY[0], ...footY[1]);
  const peakY = Math.max(...footY[0], ...footY[1]);
  const lift = peakY - groundY;
  // ДВА ПРИЗНАКА, А НЕ ОДИН — так контакт и детектят в продакшене: стопа И низко, И стоит.
  // Высота одна не различает режимы (см. `contactLegFrac`), скорость одна размывает границу.
  const thr = groundY + legLen * (opts.contactLegFrac ?? 0.105);
  const tol = opts.contactSpeedTol ?? 0.45;
  const dtF = n > 1 ? dur / (n - 1) : 0;
  let contact = 0, total = 0, latSum = 0, latN = 0;
  for (let leg = 0 as 0 | 1; leg < 2; leg = (leg + 1) as 0 | 1) {
    for (let i = 1; i < n; i++) {
      total++;
      if (footY[leg][i]! > thr) continue;
      // Клип in-place: опорная стопа обязана уезжать назад ровно на скорость тела. Маховая идёт
      // вперёд и быстро — по этому признаку они и разделяются. Скорости нет → судим только по высоте.
      if (speed0 !== null && dtF > 1e-9) {
        const vz = (footZ[leg][i]! - footZ[leg][i - 1]!) / dtF;
        if (Math.abs(vz + speed0) > speed0 * tol) continue;
      }
      contact++; latSum += Math.abs(footX[leg][i]!); latN++;
    }
  }

  // ── НАПРАВЛЕНИЕ ХОДА: опорная стопа — низко И едет относительно таза со скоростью тела (модуль, без направления);
  // скорости нет — опорной считаем нижнюю из двух. Ход = минус её смещение.
  let tx = 0, tz = 0, tn = 0;
  for (let i = 1; i < n; i++) {
    for (let leg = 0 as 0 | 1; leg < 2; leg = (leg + 1) as 0 | 1) {
      const dx = footX[leg][i]! - footX[leg][i - 1]!, dz = footZ[leg][i]! - footZ[leg][i - 1]!;
      let stance: boolean;
      if (speed0 !== null && dtF > 1e-9) stance = footY[leg][i]! <= thr && Math.abs(Math.hypot(dx, dz) / dtF - speed0) <= speed0 * tol;
      else stance = footY[leg][i]! <= footY[leg === 0 ? 1 : 0][i]!;
      if (stance) { tx -= dx; tz -= dz; tn++; }
    }
  }
  const travelDeg = tn && Math.hypot(tx, tz) > 1e-6 ? Math.atan2(tx, tz) * 180 / Math.PI : null;

  // ── ШАГИ: считаем отрывы опорной стопы. Для поворотного клипа это «во сколько приёмов развернулись»,
  // и без этого числа угол на шаг из клипа не достать — а именно он и настраивает поворот на месте.
  let steps = 0;
  for (let leg = 0 as 0 | 1; leg < 2; leg = (leg + 1) as 0 | 1) {
    let was = false;
    for (let i = 1; i < n; i++) {
      const low = footY[leg][i]! <= thr;
      if (was && !low) steps++;
      was = low;
    }
  }

  // ── Размах стопы вдоль тела (диагностика скольжения) ──
  const range = (a: number[]): number => Math.max(...a) - Math.min(...a);
  const footRange = (range(footZ[0]) + range(footZ[1])) / 2;

  const speed = speed0;
  const stepLen = speed !== null && dur > 1e-6 ? speed * dur / 2 : null;
  const slide = stepLen !== null && stepLen > 1e-6 ? Math.abs(footRange - stepLen) / stepLen : null;
  const turnRad = rFirst && rLast ? rLast[0] - rFirst[0] : null;

  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  return {
    periodSec: dur,
    speed, stepLen, footRange, slide,
    duty: total ? contact / total : 0,
    lift,
    bob: range(hipsY),
    stanceWidth: latN ? latSum / latN : 0,
    armSwing: range(shX) / 2,
    armSh: mean(shX),
    armEl: mean(elY),
    turnRad,
    steps,
    frames: n,
    travelDeg,
    torsoTwistDeg: twistSum / n * 180 / Math.PI,
  };
}
const TWIST_CHAIN = ['Spine', 'Chest', 'UpperChest', 'Neck', 'Head'];

/**
 * ⭐ ПРЕДУПРЕЖДЕНИЕ ПО КЛИПУ ХОДА: направление и впечённая скрутка против оси из имени. Кардинальный клип (`bakeRev` 2)
 * идёт ровно по своей оси и без скрутки; снятый с доворотом таза — нет (страйфы воина до перезапекания: ход ±126°,
 * скрутка ±40°). `null` — клип не из набора хода или всё в допуске (10° по ходу, 5° по скрутке).
 */
export function locoClipWarning(name: string, m: Pick<GaitMeasure, 'travelDeg' | 'torsoTwistDeg'>): string | null {
  const mm = /^(walk|run)_(fwd|back|strafe_L|strafe_R)$/.exec(name);
  if (!mm) return null;
  const want = { fwd: 0, back: 180, strafe_R: 90, strafe_L: -90 }[mm[2] as 'fwd' | 'back' | 'strafe_R' | 'strafe_L'];
  const out: string[] = [];
  if (m.travelDeg !== null) {
    const err = ((m.travelDeg - want + 540) % 360) - 180;
    if (Math.abs(err) > 10) out.push(`ход ${m.travelDeg.toFixed(0)}° вместо ${want}°`);
  }
  if (Math.abs(m.torsoTwistDeg) > 5) out.push(`в корпус впечена скрутка ${m.torsoTwistDeg.toFixed(0)}°`);
  return out.length ? `⚠ ${out.join(', ')} — клип снят с доворотом таза, перезапеки набор` : null;
}

/** Одна настройка: что меняем, как было, как станет. Применение — отдельным шагом и по кнопке. */
export interface GaitSuggestion { key: string; label: string; was: number; now: number }

/**
 * Замер → предложения настроек. НЕ применяет ничего сам: инструмент, который молча переписывает
 * двадцать ползунков, доверия не заслуживает — сперва «было → стало», потом кнопка.
 *
 * `fast` выбирает колонку (бег или ходьба): у каждого параметра формы есть run-двойник, и анализ
 * бегового клипа обязан ложиться в беговую колонку, иначе он затрёт настроенную ходьбу.
 */
export function gaitSuggestions(m: GaitMeasure, cur: Record<string, number>, fast: boolean, clipName = ''): GaitSuggestion[] {
  const out: GaitSuggestion[] = [];
  // ⚠ СТРАЙФ И ХОД СПИНОЙ В ОСНОВНЫЕ КОЛОНКИ НЕ ИДУТ: шаг и размах меряются вдоль Z (у страйфа их нет), а доля опоры
  // и подъём у них — колонки «страйф» / «назад». Предложить их как основные значило бы затереть настроенный ход вперёд.
  if (/_(strafe_[LR]|back)$|^strafe_[LR]$/.test(clipName)) return out;   // набора `_open` больше нет (снят 19.09)
  const put = (key: string, label: string, now: number | null): void => {
    if (now === null || !Number.isFinite(now)) return;
    const was = cur[key] ?? 0;
    if (Math.abs(was - now) < 1e-4) return;    // уже такое — не засоряем список
    out.push({ key, label, was, now: +now.toFixed(3) });
  };
  const S = (w: string, r: string): string => (fast ? r : w);
  put(S('stepWalk', 'stepRun'), 'длина шага', m.stepLen);
  put(S('dutyWalk', 'dutyRun'), 'доля опоры', m.duty);
  put(S('liftWalk', 'liftRun'), 'подъём стопы', m.lift);
  put(S('bobWalk', 'bobRun'), 'боб таза ×', m.bob > 1e-6 ? 1 : 0);
  put(S('stanceWidth', 'stanceWidthRun'), 'ширина стойки', m.stanceWidth);
  put(S('speedWalk', 'speedRun'), fast ? 'порог бега' : 'порог ходьбы', m.speed);
  put(S('armSwing', 'armSwingRun'), 'амплитуда маха', m.armSwing);
  put(S('armSh', 'armShRun'), 'база плеча', m.armSh);
  put(S('armEl', 'armElRun'), 'локоть — база', m.armEl);
  // ── ПОВОРОТ НА МЕСТЕ (Ф5). Только если клип действительно поворотный: у прямой походки корень почти
  // не крутится, и подсовывать оттуда «настройки поворота» значило бы испортить их шумом.
  if (m.turnRad !== null && Math.abs(m.turnRad) > 0.35 && m.periodSec > 1e-3) {
    const rate = Math.abs(m.turnRad) / m.periodSec;           // средняя скорость доворота, рад/с
    // Порог «мы крутимся» ставим НИЖЕ средней скорости: на самой средней он срабатывал бы ровно в
    // половине кадров клипа и мигал. Треть — запас, при котором поворот опознаётся с начала движения.
    put('turnStep', 'порог поворота (рад/с)', rate * 0.35);
    if (m.steps > 0) put('turnLimitDeg', 'угол на приставной шаг (°)', Math.abs(m.turnRad) * 180 / Math.PI / m.steps);
  }
  return out;
}
