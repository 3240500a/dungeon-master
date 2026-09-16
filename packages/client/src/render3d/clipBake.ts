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
 * 2. КЛИП IN-PLACE И БЕЗ FACING. `applyTorsoTwist` пишет в `Hips.rotation.y` ФЕЙСИНГ персонажа (rootYaw).
 *    Если оставить его в клипе, анимация будет «поворачивать» персонажа в чужом движке поверх его же
 *    поворота. Вычитаем `player.pelvisYaw` — остаётся только скрутка корпуса относительно таза (то, что
 *    и есть анимация), а направление держит игра. Для прямолинейных походок вычитание — no-op.
 *
 * 3. РАЗОГРЕВ ОБЯЗАТЕЛЕН. У планировщика есть инерция (планты, подшаг, torso-lead, сглаживание таза):
 *    первые ~1.5 с он выходит на режим из произвольной фазы. Снимать раньше — запечь переходный процесс.
 */
import * as THREE from 'three';
import { reduceKeyframes } from './clipBaker.js';
import type { Clip, Keyframe, Pose } from './clipModel.js';
import { setHipsOffset, blendTwo, isAngleKey, ROOT_YAW } from './clipModel.js';
import type { Humanoid } from './humanoid.js';
import { setLocoMixOverride, getLocoMixOverride, type PosePlayer } from './poseRuntime.js';
import { TURN_ANGLES_DEG, turnClipName, SWING_KEY } from './turnInPlace.js';
import { LOCO_BAKE_MAXSPD, LOCO_WALK, LOCO_RUN } from './locoBlend.js';

/**
 * ⚠ ЗАПЕКАЕТСЯ ВСЕГДА ПРОЦЕДУРКА. Если в редакторе включена локомоция клипами, плеер сам заиграл бы
 * уже запечённые клипы (а на месте — клипы поворота, которые ведут таз), и новый клип сняли бы с
 * самого себя. Поэтому на время съёма доля клипа принудительно 0, а после — как было.
 */
function procedural<T>(player: PosePlayer, fn: () => T): T {
  const was = getLocoMixOverride();
  setLocoMixOverride(0);
  player.cancelTurn();
  try { return fn(); } finally { setLocoMixOverride(was); }
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
}

export interface BakeGaitResult {
  clip: Clip;
  frames: number;               // сколько плотных кадров снято
  keys: number;                 // сколько осталось после прореживания
  periodSec: number;            // найденный период цикла
  cyclic: boolean;              // цикл найден по ноге (false — снимали по таймеру)
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

/** Убрать фейсинг из позы: `Hips.y` содержит rootYaw (см. пункт 2 в шапке файла). */
function neutralizeFacing(p: Pose, pelvisYaw: number): Pose {
  const h = p['Hips'];
  if (h) p['Hips'] = [h[0], +(h[1] - pelvisYaw).toFixed(4), h[2]];
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

/**
 * Запечь один режим походки в клип. `player` и `human` должны быть уже связаны
 * (плеер построен на этом же гуманоиде), иначе снимем чужую позу.
 */
export function bakeGaitToClip(player: PosePlayer, human: Humanoid, spec: GaitSpec, opts: BakeGaitOptions): BakeGaitResult {
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

  if (spec.durationSec !== undefined || !moving) {
    // Нецикличный (или стойка): снимаем фиксированное окно. Для стойки хватает пары кадров.
    const dur = spec.durationSec ?? 0;
    if (dur <= 0) { dense.push({ t: 0, pose: neutralizeFacing(read(), player.pelvisYaw) }); periodSec = 0; }
    else {
      for (let t = 0; t <= dur + 1e-9; t += dt) {
        dense.push({ t: +t.toFixed(4), pose: neutralizeFacing(read(), player.pelvisYaw) });
        player.step(dt);
      }
      periodSec = dur;
    }
  } else {
    // ⭐⭐ СЪЁМ ПО ФАЗЕ (см. пункт 1 шапки): ждём перехода фазы через кратное 2π и пишем кадры вместе с
    // их фазой, пока не пройдём полный оборот. Кадры приходятся на произвольные фазы, поэтому дальше
    // они ПЕРЕСЭМПЛИРУЮТСЯ на равномерную сетку по фазе — ровно так, как клип будут читать.
    const rec: { ph: number; t: number; pose: Pose }[] = [];
    let prevPh = player.driver.gaitPhase, prevPose = neutralizeFacing(read(), player.pelvisYaw);
    let base = NaN, elapsed = 0;
    while (elapsed < maxSec) {
      player.step(dt); elapsed += dt;
      const ph = player.driver.gaitPhase;
      const pose = neutralizeFacing(read(), player.pelvisYaw);
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
      for (let k = 0; k <= fps; k++) { dense.push({ t: +(k * dt).toFixed(4), pose: neutralizeFacing(read(), player.pelvisYaw) }); player.step(dt); }
      periodSec = 1;
    }
  }

  const reduced = reduceKeyframes(dense, opts.epsDeg ?? 1.5);
  const loop = spec.loop ?? cyclic;
  // Замкнуть цикл: последний ключ = первый, ровно в момент периода. Иначе на стыке будет рывок.
  if (loop && reduced.length > 1 && periodSec > 0) {
    const first = reduced[0]!;
    const closing: Pose = {}; for (const k in first.pose) { const v = first.pose[k]!; closing[k] = [v[0], v[1], v[2]]; }
    const last = reduced[reduced.length - 1]!;
    if (Math.abs(last.t - periodSec) < 1e-4) reduced[reduced.length - 1] = { t: periodSec, pose: closing };
    else reduced.push({ t: periodSec, pose: closing });
  }

  return {
    clip: { name: spec.name, character: opts.character, weapon: opts.weapon, loop, keys: reduced },
    frames: dense.length, keys: reduced.length, periodSec, cyclic,
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
 * ⚠ СКОРОСТЬ ЗАПЕКАНИЯ = СКОРОСТЬ ПРОИГРЫВАНИЯ. Ходьба/бег выбираются порогом по `sb` (ось
 * ходьба→бег), поэтому клип, который будет играть на беге, обязан быть снят НА БЕГОВОЙ скорости:
 * иначе каденция клипа и фаза планировщика разойдутся, и стопы поедут.
 *
 * ДИАГОНАЛЕЙ ЗДЕСЬ НЕТ: решение Ф0 — ЧЕТЫРЕ направления, диагональ закрывает доворот таза (`stepDirWarp`,
 * замерено: на 30–60° и 120–135° цифры совпадают с прямым бегом). Восемь клипов — это 4 направления ×
 * ходьба/бег, а не 8 направлений; второй набор на восемь направлений не нужен и заводить его не надо.
 *
 * ПОВОРОТОВ ЗДЕСЬ НЕТ ОСОЗНАННО: разворот — это вращение КОРНЯ (мировой facing), а наши клипы in-place.
 * Пока Root не анимируется (Ф1.4 завёл узел, но треков корня ещё нет), запечённый «поворот» был бы
 * либо пустым, либо содержал бы facing, который в чужом движке подрался бы с его собственным поворотом.
 */
const WALK = LOCO_WALK, RUN = LOCO_RUN;   // те же числа читают часы «только клипы» (`bakedLocoSpeed`)
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
 * ⚠ ПРОРЕЖИВАНИЕ — ПО ОТРЕЗКАМ МЕЖДУ СМЕНАМИ ОПОРЫ. Прореживатель меряет ошибку только по костям и
 * позициям, флаги переноса для него «не движение» — и он бы их размазал. Режем по кадрам, где
 * меняется опора: концы отрезков он сохраняет всегда.
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
      const p = neutralizeFacing(read(), player.pelvisYaw);
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
    // Прореживание по отрезкам между сменами опоры (см. шапку функции).
    const keys: Keyframe[] = [];
    let from = 0;
    const swingOf = (k: Keyframe): string => (k.pose[SWING_KEY] ?? [0, 0, 0]).join();
    for (let i = 1; i <= dense.length; i++) {
      if (i < dense.length && swingOf(dense[i]!) === swingOf(dense[i - 1]!)) continue;
      const seg = reduceKeyframes(dense.slice(from, i), opts.epsDeg ?? 0.5);
      for (const k of seg) if (!keys.length || k.t > keys[keys.length - 1]!.t) keys.push(k);
      from = i;
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
