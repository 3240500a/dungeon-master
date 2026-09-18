/**
 * ЗАПЕКАНИЕ ПРОЦЕДУРКИ В КЛИПЫ (Ф2.1) — ядро всей затеи «инструмент для любого движка».
 *
 * Гоняем ТОТ ЖЕ `PosePlayer`, что и игра (одна истина походки), покадрово снимаем позу и прореживаем
 * её в разрежённые ключи. На выходе — обычный `Clip`, который дальше уезжает в glTF (clipToAnimation.ts).
 * После этого клиенту StepPlanner не нужен: он просто играет анимацию + свой foot-IK + свой рагдолл.
 *
 * ТРИ НЕОЧЕВИДНЫЕ ВЕЩИ:
 *
 * 1. ⭐⭐ ЦИКЛ СНИМАЕТСЯ ПО ФАЗЕ ПЛАНИРОВЩИКА — ТЕМИ ЖЕ ЧАСАМИ, КОТОРЫМИ ЕГО ПОТОМ ИГРАЮТ.
 *    Рантайм читает клип как «нормализованное время = фаза шага / 2π» (`locoPhaseU`). Значит и снимать
 *    обязано в той же координате: начало клипа = фаза 0, конец = 2π, ключи — равномерно ПО ФАЗЕ.
 *
 *    ⚠ РАНЬШЕ цикл ловился фронтом «левая пошла в перенос», а это фаза u≈0.126, а не 0: клип играл
 *    на 45° не в такт с ногами планировщика. ЗАМЕР (бег, та же фаза, что в рантайме): расхождение с
 *    живым бегом до 63° и в среднем 5.7° — стоп-IK и подтяжка стопы тянули опорную ногу туда, где клип
 *    её не ставил, отсюда «на вкладке Бег плавно, а запечённое дёргано». Со съёмом по фазе — ≈0.3°.
 *    Старый паритет-тест этого не видел: он выравнивал живой бег по тому же фронту, то есть проверял
 *    «клип совпадает сам с собой», а не контракт проигрывания.
 *
 * 1б. ШОВ ЦИКЛА — РАЗНЕСЕНИЕ ДРЕЙФА, А НЕ ПОДМЕНА ПОСЛЕДНЕГО КАДРА. Раньше последний ключ просто
 *    заменялся первым. Со съёмом по фронту ноги это давало скачок скорости на шве 25.9°/кадр (замер) —
 *    но почти весь он был от самого фронта: окно съёма не совпадало с циклом фазы. Со съёмом по фазе
 *    остаётся настоящий дрейф планировщика — от цикла к циклу поза в фазе 0 гуляет на 0.2–3.4° (подгонка
 *    шага, скрутка корпуса). Подмена сжала бы его в ОДИН кадр; вместо этого разница разносится линейно по
 *    циклу (так делает «Loop Pose» в Unity и «cycle» в пакетах мокапа). Замер шва по костям на ходьбе:
 *    1.0–1.1° → 0.16–0.35°. На беге дрейф и без того мал (0.3–0.7°), и разница там в пределах шума стоп.
 *
 * 2. КЛИП IN-PLACE И БЕЗ FACING. `applyTorsoTwist` кладёт на таз ФЕЙСИНГ персонажа (`pelvisFrame.pelvisToWorld`:
 *    `Ry(курс)` слева на поворот и на X/Z таза). Если оставить его в клипе, анимация будет «поворачивать» персонажа
 *    в чужом движке поверх его же поворота. Снимаем `player.pelvisYaw` обратной композицией (`neutralizeFacing`) —
 *    остаётся таз в кадре персонажа (то, что и есть анимация), а направление держит игра. Для прямолинейных
 *    походок без доворота вычет — no-op.
 *
 * 2б. ⭐⭐ КЛИП ХОДА — КАРДИНАЛЬНЫЙ: СНИМАЕТСЯ БЕЗ ДОВОРОТА ТАЗА И СО СВЕЖИМ ЕГО СОСТОЯНИЕМ (`bakeRev` 2).
 *    ⚠ Было: съём шёл с включённым доворотом (у воина `warpOn` 1, `warpMax` 40), вычитался `pelvisYaw` = курс +
 *    доворот, и в клип впекалась скрутка корпуса 40°, а ноги шагали под 90° ∓ 40° к корню. Хуже того, доворот
 *    жил в ОДНОМ плеере на весь набор, и флаг «назад» от `walk_back`/`run_back` доезжал до страйфов (гистерезис
 *    78°–102° держит его на 90°): страйфы вышли под ±125–128° — диагональ назад. Теперь на каждый пресет доворот
 *    сброшен (`resetDirWarp`) и выключен (`setDirWarpOverride(0)`), а на каждом кадре съёма проверяется, что он 0.
 *    Доворот — дело рантайма (`stepDirWarp`), в клипе его быть не должно: чужой движок доворачивает сам.
 *
 * 3. РАЗОГРЕВ ОБЯЗАТЕЛЕН. У планировщика есть инерция (планты, подшаг, torso-lead, сглаживание таза):
 *    первые ~1.5 с он выходит на режим из произвольной фазы. Снимать раньше — запечь переходный процесс.
 */
import * as THREE from 'three';
import { reduceKeyframes } from './clipBaker.js';
import type { Clip, Keyframe, Pose } from './clipModel.js';
import { setHipsOffset, blendTwo, isAngleKey, ROOT_YAW, HIPS_DEL } from './clipModel.js';
import { pelvisEulerToWorld, pelvisOffsetToWorld } from './pelvisFrame.js';   // ⭐ вычет фейсинга — обратная композиция игры
import type { Humanoid } from './humanoid.js';
import { setLocoMixOverride, getLocoMixOverride, setDirWarpOverride, getDirWarpOverride, setStancePelvisOverride, getStancePelvisOverride, LOCO_BAKE_REV, OPEN_SUFFIX, openCounterWeights, blendTwist, type PosePlayer } from './poseRuntime.js';
import { TURN_ANGLES_DEG, turnClipName, SWING_KEY } from './turnInPlace.js';
import { LOCO_BAKE_MAXSPD, LOCO_WALK, LOCO_RUN } from './locoBlend.js';
import { fitSmoothLoop } from './clipFit.js';

/**
 * ⚠ ЗАПЕКАЕТСЯ ВСЕГДА ПРОЦЕДУРКА. Если в редакторе включена локомоция клипами, плеер сам заиграл бы
 * уже запечённые клипы (а на месте — клипы поворота, которые ведут таз), и новый клип сняли бы с
 * самого себя. Поэтому на время съёма доля клипа принудительно 0, а после — как было.
 *
 * ⚠ И МЕТКИ НА ВРЕМЯ СЪЁМА МОЛЧАТ. Съём гоняет плеер сотнями кадров за один вызов, и каждый его шаг (`onMark`)
 * прозвучал бы разом — пачкой в момент нажатия «запечь».
 *
 * ⚠⚠ И ТАЗ АВТОРСКОЙ СТОЙКИ ПОДАВЛЕН (`setStancePelvisOverride(0)`, тем же приёмом, что доворот). Он — дело
 * РАНТАЙМА: попав в клип, он применился бы ВТОРОЙ РАЗ при проигрывании (клип кладёт таз, а поверх ложится
 * стойка). Сторож — `stancePelvis.test.ts`: запекание при ручке 1 обязано быть бит в бит с запеканием при 0.
 * ⚠ ПЛАНТЫ ПЕРЕ-МЕРЯЕТ САМ ПЛЕЕР, А НЕ МЫ: они снимаются С поворотом авторского таза (`measureStancePlants`), и под
 * перекрытием их надо снять заново — но ЯВНЫЙ вызов `measureStance()` отсюда менял бы сами клипы, потому что
 * `StepPlanner.setStance` снапает `hipY`/`hipWant` (ЗАМЕР: до 3.46° на колене `run_fwd` между клипами набора).
 * Поэтому `PosePlayer.step` ловит смену доли сам (`stanceKnob`) — ровно на первом кадре разогрева.
 */
function procedural<T>(player: PosePlayer, fn: () => T): T {
  const was = getLocoMixOverride(), mark = player.onMark, stance = getStancePelvisOverride();
  setLocoMixOverride(0);
  setStancePelvisOverride(0);
  player.onMark = null;
  player.cancelTurn();
  try { return warpFree(player, 0, fn); } finally { setLocoMixOverride(was); setStancePelvisOverride(stance); player.onMark = mark; }
}
/**
 * ⭐⭐ СЪЁМ БЕЗ ДОВОРОТА ТАЗА (см. пункт 2б шапки): доворот выключен перекрытием (тумблер редактора не трогаем) и
 * сброшен — флаг сектора от прошлого пресета не доезжает до следующего. Вложенный вызов безопасен: восстанавливаем
 * то, что было на входе.
 */
function warpFree<T>(player: PosePlayer, warpRad: number, fn: () => T): T {
  const was = getDirWarpOverride();
  setDirWarpOverride(warpRad);
  player.resetDirWarp();
  // После съёма — тоже сброс: иначе живое превью стартовало бы с доворота последнего пресета (±раскрытие «таз открыт»).
  try { return fn(); } finally { setDirWarpOverride(was); player.resetDirWarp(); }
}
/**
 * Кадр съёма с чужим тазом — ошибка запекания, а не «чуть кривой клип»: пусть редактор не запишет его вовсе.
 * `wantDeg` — 0 у кардинального клипа, ±раскрытие у набора «таз открыт». Живого раскрытия (`hipsMode`) на съёме быть не
 * должно: перекрытие доворота его гасит.
 */
function assertWarp(player: PosePlayer, wantDeg: number, name: string): void {
  const got = (player.pelvisYaw - player.aimRootYaw) * 180 / Math.PI;
  if (Math.abs(player.dirWarpDeg - wantDeg) > 1e-6 || Math.abs(got - wantDeg) > 1e-6) {
    throw new Error(`запекание «${name}»: таз от прицела ${got.toFixed(3)}° вместо ${wantDeg}° на кадре съёма — клип вышел бы не кардинальным`);
  }
}

/** Максимальная скорость, к которой нормируются vx/vz спеки (как ползунок «Бег» в редакторе). */
export const BAKE_MAXSPD = LOCO_BAKE_MAXSPD;

export interface GaitSpec {
  name: string;                 // имя будущего клипа (walk_fwd, run_strafe_L, …)
  vx: number;                   // боковая скорость −1..1 (правая — плюс)
  vz: number;                   // продольная −1..1 (вперёд — плюс)
  /** Прицел (рад). Не задан → лицом по движению (обычная ходьба/бег). Задан → страйф. */
  yaw?: number;
  /** Не задана → длительность определяется циклом ноги. Задана → снимаем ровно столько секунд. */
  durationSec?: number;
  loop?: boolean;               // по умолчанию true для циклических
  /**
   * ⭐ «ТАЗ ОТКРЫТ» (набор `*_strafe_*_open`), °: на съёме таз повёрнут К ХОДУ ровно на столько (знак — по `vx`), и
   * вычитается ТОЛЬКО прицельный корень — раскрытие (Hips.y) и отворот Spine..UpperChest остаются В КЛИПЕ. Клип
   * канонический: сыгранный как есть, держит грудь на прицеле. Нет/0 — кардинальный клип (доворот на съёме 0).
   */
  hipsOpenDeg?: number;
}

export interface BakeGaitOptions {
  fps?: number;                 // частота съёма (по умолч. 60 — как игровой кадр)
  epsDeg?: number;              // порог прореживания в градусах (по умолч. 1.5)
  warmSec?: number;             // разогрев до съёма (по умолч. 2)
  maxSec?: number;              // предохранитель от бесконечного поиска цикла (по умолч. 6)
  character: string;
  weapon: string;
  /** Чем читать позу. По умолчанию — повороты костей + офсет таза. Редактор может подсунуть свой readPoseFull. */
  readPose?: () => Pose;
  /**
   * ГЛАДКИЕ КЛЮЧИ ДЛЯ ЦИКЛА (сплайн, `interp: 'smooth'`, `clipFit.fitSmoothLoop`) — по умолчанию ВКЛ. Выкл —
   * ломаная через `reduceKeyframes`, как было. `epsDeg: 0` — без прореживания вовсе (все кадры, для сверок).
   */
  smooth?: boolean;
  /** Допуск подгонки сплайна к слегка сглаженному проходу, ° (по умолч. `SMOOTH_EPS_DEG`). */
  smoothEpsDeg?: number;
  /** Сглаживание прохода перед подгонкой, ДОЛЯ ПЕРИОДА цикла (по умолч. `SMOOTH_SIGMA_CYCLE`). */
  smoothSigmaCycle?: number;
  /**
   * ⭐ НОМЕР СЪЁМА (обычно `Date.now()`), общий на весь прогон кнопки. Пишется в клипы ХОДА (`Clip.bakeId`) и отвечает
   * на один вопрос: набор «таз открыт» снят ТОЙ ЖЕ походкой, что кардинальный, или остался от старой?
   * ⚠ Без него редактор сравнивал только УГОЛ раскрытия: правишь плант-сетку или ползунки бега в режиме «ровно»,
   * перезапекаешь — `_open` остаётся со старой походкой, и «ровно» ↔ «открыт» сравнивают две РАЗНЫЕ настройки молча.
   */
  bakeId?: number;
}
/** Допуск подгонки сплайна, °: 11–13 ключей на цикл против 27–35 у ломаной, средняя ошибка 0.2° (замер в README). */
export const SMOOTH_EPS_DEG = 2;
/**
 * Сглаживание прохода — 2.4 % периода: ~20 мс на беге, ~35 мс на ходьбе. Снимает однокадровые изломы планировщика.
 * ⚠ ДОЛЯ ЦИКЛА, А НЕ СЕКУНДЫ: бег вдвое короче ходьбы, и одно и то же время скругляло бы его мах колена вдвое сильнее.
 */
export const SMOOTH_SIGMA_CYCLE = 0.024;

export interface BakeGaitResult {
  clip: Clip;
  frames: number;               // сколько плотных кадров снято
  keys: number;                 // сколько осталось после прореживания
  periodSec: number;            // найденный период цикла
  cyclic: boolean;              // цикл найден по ноге (false — снимали по таймеру)
  /** Гладкие ключи: ошибка к сглаженному проходу и отклонение от исходного, ° (нет — ломаная). */
  fitErrDeg?: number;
  rawErrDeg?: number;
}

/** Съём позы по умолчанию: повороты всех костей + авторский офсет таза (`__hipsP`). */
export function defaultReadPose(h: Humanoid): () => Pose {
  return (): Pose => {
    const p = h.readPose() as Pose;
    delete p['LeftBreast']; delete p['RightBreast'];          // вторичные jiggle-кости — не часть анимации
    const hp = h.hips.position;
    const hr = h.hipsRest;
    setHipsOffset(p, [+(hp.x - hr.x).toFixed(3), +(hp.y - hr.y).toFixed(3), +(hp.z - hr.z).toFixed(3)]);   // Ф12: дельта от rest — запечённая походка переносима
    return p;
  };
}

/**
 * Убрать фейсинг из позы (см. пункт 2 в шапке файла) — ТОЧНОЕ обратное композиции игры (`pelvisFrame.pelvisToWorld`):
 * таз `Ry(−pelvisYaw)·Q`, X/Z `__hipsD` — `Ry(−pelvisYaw)·(rest + d) − rest`. `rest` — `hipsRest` рига.
 *
 * ⚠ БЫЛО `Hips.y − pelvisYaw` в слоте эйлера и `__hipsD` как есть. Верно, пока у таза нет наклона и сдвига по полу:
 * при наклоне игра раскрывает эйлер (Y в [−90°, 90°]), и вычет в слоте ломается — ЗАМЕР (игра с новой композицией играет
 * старое запекание с `hipsPitchSwing` 0.15): 7.6° на курсе 40°, 120° на 90°, 17° на 180° (сторож `pelvisFrame.test.ts` на
 * живом плеере: 7.27° / 0.97u уже на 40°). А качание таза страйфа (доворот 40°) ложилось в клип повёрнутым на доворот —
 * `__hipsD.z` до 0.27 при `z/x = tan 40°`.
 * Нулевой наклон — прежний путь бит в бит (вычет в слоте Y, округление 1e-4); наклон — канонический разбор, округлён так же.
 */
export function neutralizeFacing(p: Pose, pelvisYaw: number, rest: THREE.Vector3): Pose {
  const r4 = (v: number): number => +v.toFixed(4);
  const h = p['Hips'];
  if (h) { const n = pelvisEulerToWorld(h, -pelvisYaw); p['Hips'] = h[0] === 0 ? [n[0], r4(n[1]), n[2]] : [r4(n[0]), r4(n[1]), r4(n[2])]; }
  if (pelvisOffsetToWorld(p, -pelvisYaw, rest)) { const d = p[HIPS_DEL]!; p[HIPS_DEL] = [r4(d[0]), d[1], r4(d[2])]; }
  return p;
}

const TAU = Math.PI * 2;
const _dq0 = new THREE.Quaternion(), _dq1 = new THREE.Quaternion(), _dqc = new THREE.Quaternion(), _dqu = new THREE.Quaternion();
const _de = new THREE.Euler(), _dI = new THREE.Quaternion();

/**
 * ⭐ ЗАМЫКАНИЕ ЦИКЛА РАЗНЕСЕНИЕМ ДРЕЙФА: последний кадр сетки (фаза 2π) обязан совпасть с первым (фаза 0).
 * Разница между ними распределяется ЛИНЕЙНО по фазе на все кадры — на кадр приходится её доля, а не вся.
 *
 * Повороты — поправкой слева `slerp(I, q0·q2π⁻¹, u)·q(u)`: на u=0 это ровно q0, на u=1 — тоже q0.
 * Скаляры (офсет таза и прочие `__…`) — прибавкой `(v0 − v2π)·u`.
 */
export function removeLoopDrift(grid: Pose[]): void {
  const n = grid.length - 1;
  if (n < 1) return;
  const first = grid[0]!, last = grid[n]!;
  for (const key of Object.keys(first)) {
    const v0 = first[key]!, v1 = last[key];
    if (!v1) continue;
    if (isAngleKey(key)) {
      _dq0.setFromEuler(_de.set(v0[0], v0[1], v0[2], 'XYZ'));
      _dq1.setFromEuler(_de.set(v1[0], v1[1], v1[2], 'XYZ'));
      _dqc.copy(_dq0).multiply(_dq1.invert());               // поправка, которая переводит конец в начало
      for (let k = 1; k <= n; k++) {
        const v = grid[k]![key]; if (!v) continue;
        _dqu.copy(_dI).slerp(_dqc, k / n).multiply(_dq1.setFromEuler(_de.set(v[0], v[1], v[2], 'XYZ')));
        _de.setFromQuaternion(_dqu, 'XYZ');
        grid[k]![key] = [_de.x, _de.y, _de.z];
      }
    } else {
      const d = [v0[0] - v1[0], v0[1] - v1[1], v0[2] - v1[2]];
      for (let k = 1; k <= n; k++) {
        const v = grid[k]![key]; if (!v) continue;
        const u = k / n;
        grid[k]![key] = [v[0] + d[0]! * u, v[1] + d[1]! * u, v[2] + d[2]! * u];
      }
    }
  }
}

export type LoopKeyOpts = Pick<BakeGaitOptions, 'fps' | 'epsDeg' | 'smooth' | 'smoothEpsDeg' | 'smoothSigmaCycle'>;
/**
 * Плотные кадры цикла → ключи клипа: гладкие (сплайн, `fitSmoothLoop`) или ломаная, и замыкание цикла ключом на периоде.
 */
function loopKeys(dense: Keyframe[], periodSec: number, cyclic: boolean, loop: boolean, fps: number, opts: LoopKeyOpts): { reduced: Keyframe[]; fit: { errDeg: number; rawErrDeg: number } | null } {
  const eps = opts.epsDeg ?? 1.5;
  // ⭐ ЦИКЛ — ГЛАДКИМИ КЛЮЧАМИ (см. `clipFit.ts`): ломаная держала 28–35 ключей не из-за допуска, а из-за
  // однокадровых изломов планировщика; сплайн, подогнанный к слегка сглаженному проходу, обходится 11–13.
  let fit: { errDeg: number; rawErrDeg: number } | null = null;
  let reduced: Keyframe[];
  if (cyclic && loop && (opts.smooth ?? true) && eps > 0 && dense.length >= 5) {
    const r = fitSmoothLoop([...dense, { t: periodSec, pose: dense[0]!.pose }],
      { epsDeg: opts.smoothEpsDeg ?? SMOOTH_EPS_DEG, sigmaFrames: (opts.smoothSigmaCycle ?? SMOOTH_SIGMA_CYCLE) * periodSec * fps });
    reduced = r.keys; fit = r;
  } else reduced = reduceKeyframes(dense, eps);
  // Замкнуть цикл: последний ключ = первый, ровно в момент периода. Иначе на стыке будет рывок.
  if (loop && reduced.length > 1 && periodSec > 0) {
    const first = reduced[0]!;
    const closing: Pose = {}; for (const k in first.pose) { const v = first.pose[k]!; closing[k] = [v[0], v[1], v[2]]; }
    const last = reduced[reduced.length - 1]!;
    if (Math.abs(last.t - periodSec) < 1e-4) reduced[reduced.length - 1] = { t: periodSec, pose: closing };
    else reduced.push({ t: periodSec, pose: closing });
  }
  return { reduced, fit };
}

/**
 * Запечь один режим походки в клип. `player` и `human` должны быть уже связаны
 * (плеер построен на этом же гуманоиде), иначе снимем чужую позу.
 */
export function bakeGaitToClip(player: PosePlayer, human: Humanoid, spec: GaitSpec, opts: BakeGaitOptions): BakeGaitResult {
  // ⚠ ПРОЦЕДУРКА И БЕЗ ДОВОРОТА — И У ОДИНОЧНОГО СЪЁМА, а не только у набора (`bakeGaitSet`). Было: одиночный вызов
  // при опубликованном `locoMix` 1 шёл в «только клипы», фаза планировщика стояла, фронт не ловился — и клип молча
  // снимался окном 1 с С САМИХ ЗАПЕЧЁННЫХ клипов (поймано зондом: период ровно 1.000 у всех страйфов).
  const openDeg = (spec.hipsOpenDeg ?? 0) * Math.sign(spec.vx || 0);
  assertOpenBudget(player, spec, openDeg);
  return procedural(player, () => warpFree(player, openDeg * Math.PI / 180, () => bakeGaitWarpFree(player, human, spec, opts, openDeg)));
}
/**
 * ⭐ РАСКРЫТИЕ БОЛЬШЕ БЮДЖЕТА СКРУТКИ — ОТКАЗ В СЪЁМЕ, А НЕ ТИХО КРИВОЙ КЛИП.
 *
 * Контракт `_open`: клип КАНОНИЧЕСКИЙ — таз раскрыт на `a`, отворот `−a` запечён в Spine..UpperChest, и любой движок,
 * сыгравший его как есть, держит грудь на прицеле. Отворот кладёт `step` числом `clamp(residual − раскрытие, ±maxTwist)`:
 * при `maxTwist` меньше раскрытия он УПИРАЕТСЯ в предел, и в клип уходит отворота меньше, чем просили, — на
 * `(раскрытие − maxTwist) × c3`, где `c3` — сумма весов Spine/Chest/UpperChest. ЗАМЕР (манекен, веса 0.15/0.25/0.3,
 * c3 = 0.7, раскрытие 35°, бег 120 u/с вбок): при `maxTwist` 80° клип, сыгранный КАК ЕСТЬ, держит грудь на 0.0° от
 * прицела и наш рантайм на 0.2°; при `maxTwist` 20° — 10.5° и 5.1° соответственно, ровно `(35 − 20) × 0.7`.
 * ⚠ Записать «сколько получилось» вместо «сколько просили» мало: клип станет самосогласованным, но грудь всё равно
 * будет мимо прицела. Единственный честный выход — сказать это автору: подними предел или опусти раскрытие.
 */
function assertOpenBudget(player: PosePlayer, spec: GaitSpec, openDeg: number): void {
  if (!openDeg) return;
  const tw = blendTwist(player.twistStates, Math.hypot(spec.vx, spec.vz) * BAKE_MAXSPD);
  const maxDeg = tw.maxTwist * 180 / Math.PI;
  if (Math.abs(openDeg) <= maxDeg + 1e-6) return;
  const c3 = (tw.weights[0] ?? 0) + (tw.weights[1] ?? 0) + (tw.weights[2] ?? 0);
  const offDeg = (Math.abs(openDeg) - maxDeg) * c3;   // столько отворота не влезло — ровно на столько уедет грудь
  throw new Error(`запекание «${spec.name}»: раскрытие ${Math.abs(openDeg).toFixed(0)}° больше «макс. скрутка верха» `
    + `${maxDeg.toFixed(0)}° — верх не отвернётся обратно, и клип вышел бы НЕ каноническим: грудь мимо прицела `
    + `на ${offDeg.toFixed(1)}°. Подними «макс. скрутка верха» или опусти раскрытие.`);
}
function bakeGaitWarpFree(player: PosePlayer, human: Humanoid, spec: GaitSpec, opts: BakeGaitOptions, openDeg: number): BakeGaitResult {
  const fps = Math.max(1, opts.fps ?? 60);
  const dt = 1 / fps;
  const warm = opts.warmSec ?? 2;
  const maxSec = opts.maxSec ?? 6;
  const read = opts.readPose ?? defaultReadPose(human);

  const vx = spec.vx * BAKE_MAXSPD, vz = spec.vz * BAKE_MAXSPD;
  const moving = Math.hypot(vx, vz) > 1;
  const yaw = spec.yaw ?? (moving ? Math.atan2(vx, vz) : 0);

  player.setVel(vx, vz);
  player.setYaw(yaw);
  player.snapYaw();
  player.resetPos();

  for (let t = 0; t < warm; t += dt) player.step(dt);         // выход на режим (планты/подшаг/torso-lead устаканиваются)

  const dense: Keyframe[] = [];
  let periodSec = spec.durationSec ?? 0;
  let cyclic = false;
  // Вычитаем ПРИЦЕЛЬНЫЙ корень: у кардинального клипа таз с ним совпадает (доворот 0), у «таз открыт» раскрытие остаётся в клипе.
  const take = (): Pose => { assertWarp(player, openDeg, spec.name); return neutralizeFacing(read(), player.aimRootYaw, human.hipsRest); };

  if (spec.durationSec !== undefined || !moving) {
    // Нецикличный (или стойка): снимаем фиксированное окно. Для стойки хватает пары кадров.
    const dur = spec.durationSec ?? 0;
    if (dur <= 0) { dense.push({ t: 0, pose: take() }); periodSec = 0; }
    else {
      for (let t = 0; t <= dur + 1e-9; t += dt) {
        dense.push({ t: +t.toFixed(4), pose: take() });
        player.step(dt);
      }
      periodSec = dur;
    }
  } else {
    // ⭐⭐ СЪЁМ ПО ФАЗЕ (см. пункт 1 шапки): ждём перехода фазы через кратное 2π и пишем кадры вместе с
    // их фазой, пока не пройдём полный оборот. Кадры приходятся на произвольные фазы, поэтому дальше
    // они ПЕРЕСЭМПЛИРУЮТСЯ на равномерную сетку по фазе — ровно так, как клип будут читать.
    const rec: { ph: number; t: number; pose: Pose }[] = [];
    let prevPh = player.driver.gaitPhase, prevPose = take();
    let base = NaN, elapsed = 0;
    while (elapsed < maxSec) {
      player.step(dt); elapsed += dt;
      const ph = player.driver.gaitPhase;
      const pose = take();
      if (Number.isNaN(base) && Math.floor(ph / TAU) > Math.floor(prevPh / TAU)) {
        base = Math.floor(ph / TAU) * TAU;
        rec.push({ ph: prevPh - base, t: elapsed - dt, pose: prevPose });   // кадр ДО перехода — чтобы поймать ровно фазу 0
      }
      if (!Number.isNaN(base)) {
        rec.push({ ph: ph - base, t: elapsed, pose });
        if (ph - base >= TAU) { cyclic = true; break; }
      }
      prevPh = ph; prevPose = pose;
    }
    if (cyclic) {
      const at = (phi: number): { pose: Pose; t: number } => {
        let i = 0; while (i < rec.length - 2 && rec[i + 1]!.ph < phi) i++;
        const a = rec[i]!, b = rec[i + 1]!, w = b.ph > a.ph ? Math.min(1, Math.max(0, (phi - a.ph) / (b.ph - a.ph))) : 0;
        return { pose: blendTwo(a.pose, b.pose, w), t: a.t + (b.t - a.t) * w };
      };
      const start = at(0), end = at(TAU);
      periodSec = +(end.t - start.t).toFixed(4);
      const n = Math.max(8, Math.round(periodSec * fps));
      const grid: Pose[] = [];
      for (let k = 0; k <= n; k++) grid.push(at(TAU * k / n).pose);
      removeLoopDrift(grid);
      for (let k = 0; k < n; k++) dense.push({ t: +(periodSec * k / n).toFixed(4), pose: grid[k]! });
    }
    if (!cyclic) {   // фронт не пойман (очень медленная походка/патология) — падаем на окно 1 с
      dense.length = 0;
      for (let k = 0; k <= fps; k++) { dense.push({ t: +(k * dt).toFixed(4), pose: take() }); player.step(dt); }
      periodSec = 1;
    }
  }

  const loop = spec.loop ?? cyclic;
  const { reduced, fit } = loopKeys(dense, periodSec, cyclic, loop, fps, opts);

  // ⭐ СКОРОСТЬ ЗАПЕКАНИЯ ЕДЕТ В КЛИП (u/с): часы «только клипы» меряют цикл ею × период (`bakedLocoSpeed`). Раньше
  // её угадывали по имени (`run_*` 102, прочее 50.4), и смена скоростей набора молча расходилась бы с уже запечённым.
  // Стоя (стойка, повороты) скорости нет — и поля нет: у них часы не путевые.
  const bakeSpeed = moving ? +Math.hypot(vx, vz).toFixed(4) : 0;
  // Ревизия — тоже только у клипов хода: у стойки нет доворота, её и перезапекать незачем.
  // «Таз открыт»: угол и доли отворота, с которыми он запечён, — рантайм снимает отворот ровно ими, даже если `pe_twist` поменяют.
  const counterW = openDeg ? openCounterWeights(blendTwist(player.twistStates, Math.hypot(vx, vz)).weights) : null;
  return {
    clip: { name: spec.name, character: opts.character, weapon: opts.weapon, loop, keys: reduced,
      ...(bakeSpeed > 0 ? { bakeSpeed, bakeRev: LOCO_BAKE_REV, ...(opts.bakeId ? { bakeId: opts.bakeId } : {}) } : {}),
      ...(openDeg && counterW ? { hipsOpenDeg: Math.abs(openDeg), hipsOpenW: counterW.map((v) => +v.toFixed(4)) } : {}) },
    frames: dense.length, keys: reduced.length, periodSec, cyclic,
    ...(fit ? { fitErrDeg: +fit.errDeg.toFixed(2), rawErrDeg: +fit.rawErrDeg.toFixed(2) } : {}),
  };
}

/**
 * ⭐⭐ СТАНДАРТНЫЙ НАБОР ПОХОДКИ = РОВНО ТО, ЧТО ДВИЖОК СПРАШИВАЕТ (`LOCO_NAMES`), плюс стойка.
 *
 * ⚠ РАНЬШЕ ЭТИ ДВА СПИСКА РАСХОДИЛИСЬ, и половина работы уходила в никуда: запекались `strafe_L`,
 * `strafe_R` и шесть диагоналей, а рантайм просил `walk_strafe_L`/`run_strafe_L`/`run_back`… — из
 * восьми имён набор покрывал ТРИ. То есть «переключил бег на клипы» давало клипы только вперёд,
 * назад и бег вперёд, а страйф и бег назад молча падали обратно на планировщик.
 *
 * ⚠ СКОРОСТЬ ЗАПЕКАНИЯ ПОМНИТ САМ КЛИП (`bakeSpeed`). Играть его можно и на другой скорости: в «только клипы»
 * часы идут по пройденному пути с циклом «скорость запекания × период», поэтому бег, снятый на 120, на 80 u/с
 * играет медленнее (темп 80/120), а стопы стоят.
 *
 * ДИАГОНАЛЕЙ ЗДЕСЬ НЕТ: решение Ф0 — ЧЕТЫРЕ направления, диагональ закрывает доворот таза (`stepDirWarp`: ход
 * складывается к ближайшей из четырёх осей, доворачивается только остаток ≤ 45°). Восемь клипов — это 4 направления ×
 * ходьба/бег, а не 8 направлений; второй набор на восемь направлений не нужен и заводить его не надо.
 * ⚠ Поэтому каждый клип обязан идти РОВНО по своей оси (страйф ±90°, таз 0, скрутки нет) — см. пункт 2б шапки.
 *
 * ПОВОРОТОВ ЗДЕСЬ НЕТ ОСОЗНАННО: разворот — это вращение КОРНЯ (мировой facing), а наши клипы in-place.
 * Пока Root не анимируется (Ф1.4 завёл узел, но треков корня ещё нет), запечённый «поворот» был бы
 * либо пустым, либо содержал бы facing, который в чужом движке подрался бы с его собственным поворотом.
 */
/**
 * ⭐⭐ СКОРОСТИ НАБОРА — 40 и 120 u/с (`LOCO_BAKE_WALK_SPD` / `LOCO_BAKE_RUN_SPD`, решение автора, см. `locoBlend.ts`).
 * Доли максимума: 1/3 и 1. Каждый клип хода запоминает свою скорость (`Clip.bakeSpeed`) — её и читают часы.
 *
 * ⚠ «ЧИСТО» — ПРИ УСЛОВИИ: ось планировщика `sb = (v − speedWalk) / (speedRun − speedWalk)` даёт ровно 0 на 40 u/с,
 * только если `speedWalk ≥ 40`, и ровно 1 на 120 u/с, только если `speedRun ≤ 120`. Умолчания (40 / 115) и настройки
 * воина (40 / 115) условие держат: ходьба снимается с 0 % беговых настроек, бег — со 100 %. Было 50.4 / 102 →
 * sb 0.139 / 0.827: ходьба несла 14 % бега, бег 17 % ходьбы. Сдвинул `speedWalk` ниже 40 или `speedRun` выше 120 —
 * клип снова станет смесью (сторож в `clipBake.test.ts` проверяет условие на умолчаниях).
 */
const WALK = LOCO_WALK, RUN = LOCO_RUN;
export const GAIT_PRESETS: readonly GaitSpec[] = [
  { name: 'idle', vx: 0, vz: 0, durationSec: 0.5, loop: true },
  { name: 'walk_fwd', vx: 0, vz: WALK },
  // ХОД СПИНОЙ: обязателен yaw:0. Без него facing берётся ПО ДВИЖЕНИЮ (atan2 → пол-оборота), и получается
  // «развернулся и пошёл вперёд» — та же походка, а не ход назад. Ловится тем, что период совпадает с walk_fwd.
  { name: 'walk_back', vx: 0, vz: -WALK, yaw: 0 },
  { name: 'walk_strafe_L', vx: -WALK, vz: 0, yaw: 0 },
  { name: 'walk_strafe_R', vx: WALK, vz: 0, yaw: 0 },
  { name: 'run_fwd', vx: 0, vz: RUN },
  { name: 'run_back', vx: 0, vz: -RUN, yaw: 0 },
  { name: 'run_strafe_L', vx: -RUN, vz: 0, yaw: 0 },
  { name: 'run_strafe_R', vx: RUN, vz: 0, yaw: 0 },
] as const;

/**
 * ⭐ НАБОР «ТАЗ ОТКРЫТ»: четыре страйфа с раскрытием таза к ходу, имена `<страйф>_open`. Снимается тем же планировщиком,
 * что и кардинальный, только таз на съёме повёрнут к ходу: ноги шагают диагональю ОТНОСИТЕЛЬНО ТАЗА (колени за тазом), в
 * мире — ровно вбок. Угол 0 — клип не нужен: колонка этой скорости играет кардинальный. Живой вид того же набора —
 * «Бег» без «только клипы» в режиме «таз открыт».
 */
export const openStrafePresets = (runDeg: number, walkDeg: number): GaitSpec[] =>
  GAIT_PRESETS.filter((s) => /_strafe_/.test(s.name))
    .map((s) => ({ ...s, name: s.name + OPEN_SUFFIX, hipsOpenDeg: /^run_/.test(s.name) ? runDeg : walkDeg }))
    .filter((s) => s.hipsOpenDeg > 0.5);


/** Имена, включённые по умолчанию, — ВЕСЬ набор (походка и повороты на месте): лишнего в нём нет. */
export const defaultBakePick = (specs: readonly { name: string }[] = [...GAIT_PRESETS, ...TURN_PRESETS]): string[] =>
  specs.map((s) => s.name);

/** Запечь весь набор. Плеер переиспользуется — между режимами он сам выходит на новый через разогрев. */
export function bakeGaitSet(
  player: PosePlayer, human: Humanoid, opts: BakeGaitOptions,
  specs: readonly GaitSpec[] = GAIT_PRESETS,
): BakeGaitResult[] {
  return procedural(player, () => specs.map((s) => bakeGaitToClip(player, human, s, opts)));
}

// ── ПОВОРОТЫ НА МЕСТЕ ─────────────────────────────────────────────────────────────────────────────

/** Поворот на месте: имя клипа и угол СО ЗНАКОМ (+ = вправо, та же сторона, что у `strafe_R`). */
export interface TurnSpec { name: string; deg: number }

/**
 * ⭐ НАБОР ПОВОРОТОВ = РОВНО ТО, ЧТО СПРАШИВАЕТ РАНТАЙМ (`TURN_NAMES`): 45° / 90° / 180° в обе стороны.
 *
 * ⚠ 180° СНИМАЕТСЯ КАК 179.5°. Ровно пол-оборота — вырожденный случай: сторону доворота решает то,
 * как `wrapPi` сворачивает ±π. Нынешний (`atan2(sin, cos)`) знак сохраняет — мутацией проверено, сейчас
 * без полградуса тоже работает. Но в этом же клиенте живут ДВА других `wrapPi` (`jointClamp.ts`,
 * `jointLimitV2.ts`), которые +π сворачивают в −π, и стоит унифицировать — `turn_R_180` молча станет
 * левым. Полградуса задают сторону явно; остаток уйдёт в скрутку корпуса.
 */
export const TURN_PRESETS: readonly TurnSpec[] = TURN_ANGLES_DEG.flatMap((d) => {
  const a = d >= 180 ? d - 0.5 : d;
  return [{ name: turnClipName(d, false), deg: -a }, { name: turnClipName(d, true), deg: a }];
});

/** Сколько стоять после поворота, прежде чем закончить съём: ноги дома, таз встал. */
const TURN_TAIL_SEC = 0.25;

/**
 * Запечь ПОВОРОТ НА МЕСТЕ: стоим, прицел прыгает на угол, снимаем, как планировщик переступает, пока
 * таз не встанет на новый курс и ноги не успокоятся.
 *
 * В клип кладутся ДВА канала сверх позы, и оба нужны проигрыванию:
 *  • `__rootY` — накопленный курс таза от начала: по нему рантайм ведёт таз, чтобы стопы и корпус не
 *    разошлись (связь «угол ↔ момент шага» есть только внутри клипа);
 *  • `__swing` — какая нога в воздухе: заземление по нему решает, кого прижимать к полу.
 *
 * ⭐ КЛЮЧИ — ГЛАДКИЕ ПРОРЕЖЕННЫЕ, КАК У ЦИКЛА ПОХОДКИ (`clipFit`, режим `loop: false`). Раньше это был отдельный
 * путь: плотный поток резался на отрезки по сменам опоры и каждый прореживался ЛОМАНОЙ с допуском 0.5° —
 * 28–47 ключей на клип (201 на шесть) против 11–15 у цикла. Теперь тот же сплайн и тот же допуск
 * (`SMOOTH_EPS_DEG` 2°), сигма — те же 2.4 % длины клипа, что у цикла.
 *
 * ⚠ ЧТО ЗАМЕНЯЕТ РЕЗКУ НА ОТРЕЗКИ: подгонка меряет ошибку по костям, позициям и КУРСУ КОРНЯ, а флаги переноса
 * для неё «не движение» — она бы их размазала. Поэтому времена смены опоры уходят в подгонку ОБЯЗАТЕЛЬНЫМИ
 * ключами (`pin`, обе стороны смены — флаг переключается за один кадр, как и раньше), а концы клипа
 * закрепляются значением: на них стоят `turnYawAt(dur)`, `turnSupportAt(0/dur)` и шов поворота.
 */
export function bakeTurnToClip(player: PosePlayer, human: Humanoid, spec: TurnSpec, opts: BakeGaitOptions): BakeGaitResult {
  return procedural(player, () => {
    const fps = Math.max(1, opts.fps ?? 60), dt = 1 / fps;
    const read = opts.readPose ?? defaultReadPose(human);
    const maxSec = opts.maxSec ?? 6;
    player.setVel(0, 0); player.setYaw(0); player.snapYaw(); player.resetPos();
    for (let t = 0; t < (opts.warmSec ?? 2); t += dt) player.step(dt);
    const y0 = player.pelvisYaw, aim = y0 + spec.deg * Math.PI / 180;
    player.setYaw(aim);
    const dense: Keyframe[] = [];
    const frame = (t: number): void => {
      assertWarp(player, 0, spec.name);
      const p = neutralizeFacing(read(), player.pelvisYaw, human.hipsRest);
      p[ROOT_YAW] = [+(player.pelvisYaw - y0).toFixed(5), 0, 0];
      const sw = player.driver.swingLegs;
      p[SWING_KEY] = [sw[0] ? 1 : 0, sw[1] ? 1 : 0, 0];
      dense.push({ t: +t.toFixed(4), pose: p });
    };
    frame(0);
    let t = 0, calm = 0, prevYaw = player.pelvisYaw;
    while (t < maxSec) {
      player.step(dt); t += dt; frame(t);
      const sw = player.driver.swingLegs;
      // КОНЕЦ ПОВОРОТА = ТАЗ ОСТАНОВИЛСЯ и ноги на полу. ⚠ Не «таз дошёл до прицела»: у доворота есть
      // мёртвая зона (замер: на 90° таз встаёт на 88.8°), и такой съём шёл до `maxSec` — клип на 6 с, из них
      // пять стояния. И не по `driver.stepping`: при выключенном «уходе в idle» он не гаснет вовсе.
      const still = Math.abs(player.pelvisYaw - prevYaw) < 0.02 * Math.PI / 180;
      prevYaw = player.pelvisYaw;
      const settled = still && !sw[0] && !sw[1] && Math.abs(player.pelvisYaw - y0) > 1e-3;
      calm = settled ? calm + dt : 0;
      if (calm >= TURN_TAIL_SEC) break;
    }
    // Смены опоры — обязательные ключи, обе стороны: флаг переключается ровно за кадр, как при резке на отрезки.
    const swingOf = (k: Keyframe): string => (k.pose[SWING_KEY] ?? [0, 0, 0]).join();
    const pin: number[] = [];
    for (let i = 1; i < dense.length; i++) if (swingOf(dense[i]!) !== swingOf(dense[i - 1]!)) pin.push(i - 1, i);
    const eps = opts.epsDeg ?? 0.5;
    let keys: Keyframe[];
    if ((opts.smooth ?? true) && eps > 0 && dense.length >= 5) {
      const durSec = dense[dense.length - 1]!.t;
      keys = fitSmoothLoop(dense, {
        epsDeg: opts.smoothEpsDeg ?? SMOOTH_EPS_DEG, sigmaFrames: (opts.smoothSigmaCycle ?? SMOOTH_SIGMA_CYCLE) * durSec * fps,
        loop: false, pin,
      }).keys;
    } else {
      // Ломаная (ручной режим редактора и плотный проход `epsDeg: 0`) — по отрезкам между сменами опоры: их концы
      // прореживатель сохраняет всегда, иначе флаги размазались бы.
      keys = [];
      let from = 0;
      for (let i = 1; i <= dense.length; i++) {
        if (i < dense.length && swingOf(dense[i]!) === swingOf(dense[i - 1]!)) continue;
        const seg = reduceKeyframes(dense.slice(from, i), eps);
        for (const k of seg) if (!keys.length || k.t > keys[keys.length - 1]!.t) keys.push(k);
        from = i;
      }
    }
    return {
      clip: { name: spec.name, character: opts.character, weapon: opts.weapon, loop: false, rootYaw: true, keys },
      frames: dense.length, keys: keys.length, periodSec: t, cyclic: false,
    };
  });
}

/** Запечь набор поворотов (по умолчанию — все шесть). */
export function bakeTurnSet(player: PosePlayer, human: Humanoid, opts: BakeGaitOptions, specs: readonly TurnSpec[] = TURN_PRESETS): BakeGaitResult[] {
  return specs.map((s) => bakeTurnToClip(player, human, s, opts));
}
