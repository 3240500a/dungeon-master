/**
 * ЗАПЕКАНИЕ ПРОЦЕДУРКИ В КЛИПЫ (Ф2.1) — ядро всей затеи «инструмент для любого движка».
 *
 * Гоняем ТОТ ЖЕ `PosePlayer`, что и игра (одна истина походки), покадрово снимаем позу и прореживаем
 * её в разрежённые ключи. На выходе — обычный `Clip`, который дальше уезжает в glTF (clipToAnimation.ts).
 * После этого клиенту StepPlanner не нужен: он просто играет анимацию + свой foot-IK + свой рагдолл.
 *
 * ТРИ НЕОЧЕВИДНЫЕ ВЕЩИ:
 *
 * 1. ЦИКЛ ЗАМЫКАЕТСЯ ПО НОГЕ, А НЕ ПО ТАЙМЕРУ. Период походки зависит от скорости/каденции/шага, считать
 *    его формулой — значит продублировать половину pose.ts и разойтись с ней. Вместо этого ловим фронт
 *    «левая нога пошла в перенос» (`driver.swingLegs[0]` false→true): от одного фронта до следующего —
 *    ровно один цикл. Последний ключ = первый → шов не виден.
 *
 * 2. КЛИП IN-PLACE И БЕЗ FACING. `applyTorsoTwist` пишет в `Hips.rotation.y` ФЕЙСИНГ персонажа (rootYaw).
 *    Если оставить его в клипе, анимация будет «поворачивать» персонажа в чужом движке поверх его же
 *    поворота. Вычитаем `player.pelvisYaw` — остаётся только скрутка корпуса относительно таза (то, что
 *    и есть анимация), а направление держит игра. Для прямолинейных походок вычитание — no-op.
 *
 * 3. РАЗОГРЕВ ОБЯЗАТЕЛЕН. У планировщика есть инерция (планты, подшаг, torso-lead, сглаживание таза):
 *    первые ~1.5 с он выходит на режим из произвольной фазы. Снимать раньше — запечь переходный процесс.
 */
import { reduceKeyframes } from './clipBaker.js';
import type { Clip, Keyframe, Pose } from './clipModel.js';
import { setHipsOffset } from './clipModel.js';
import type { Humanoid } from './humanoid.js';
import type { PosePlayer } from './poseRuntime.js';

/** Максимальная скорость, к которой нормируются vx/vz спеки (как ползунок «Бег» в редакторе). */
export const BAKE_MAXSPD = 120;

export interface GaitSpec {
  name: string;                 // имя будущего клипа (walk_fwd, run_diag_L, …)
  vx: number;                   // боковая скорость −1..1 (правая — плюс)
  vz: number;                   // продольная −1..1 (вперёд — плюс)
  /** Прицел (рад). Не задан → лицом по движению (обычная ходьба/бег). Задан → страйф. */
  yaw?: number;
  /** Не задана → длительность определяется циклом ноги. Задана → снимаем ровно столько секунд. */
  durationSec?: number;
  loop?: boolean;               // по умолчанию true для циклических
  /** ⚠ Движок это имя НЕ спрашивает (`LOCO_NAMES`) — режим для экспорта в чужой движок, по умолчанию
   *  в набор запекания не входит. Не «выключено», а «не нужно нашему рантайму». */
  extra?: boolean;
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
    // Ищем ФРОНТ «левая нога пошла в перенос», затем снимаем до следующего такого же фронта.
    let prevSwing = player.driver.swingLegs[0];
    let started = false, t = 0, elapsed = 0;
    while (elapsed < maxSec) {
      player.step(dt); elapsed += dt;
      const sw = player.driver.swingLegs[0];
      const rising = sw && !prevSwing;
      prevSwing = sw;
      if (rising) {
        if (!started) { started = true; t = 0; }
        else { periodSec = +t.toFixed(4); cyclic = true; break; }
      }
      if (started) {
        dense.push({ t: +t.toFixed(4), pose: neutralizeFacing(read(), player.pelvisYaw) });
        t += dt;
      }
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
 * ДИАГОНАЛИ ОСТАВЛЕНЫ, НО ВЫКЛЮЧЕНЫ ПО УМОЛЧАНИЮ (`extra`): решение Ф0 — четыре направления, а
 * диагональ закрывает доворот таза. Они не удалены, потому что чужому движку при экспорте могут
 * понадобиться, а в редакторе их видно галочкой и понятно, что движок их не читает.
 *
 * ПОВОРОТОВ ЗДЕСЬ НЕТ ОСОЗНАННО: разворот — это вращение КОРНЯ (мировой facing), а наши клипы in-place.
 * Пока Root не анимируется (Ф1.4 завёл узел, но треков корня ещё нет), запечённый «поворот» был бы
 * либо пустым, либо содержал бы facing, который в чужом движке подрался бы с его собственным поворотом.
 */
const WALK = 0.42, RUN = 0.85;
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
  { name: 'walk_diag_FL', vx: -0.3, vz: 0.3, yaw: 0, extra: true },
  { name: 'walk_diag_FR', vx: 0.3, vz: 0.3, yaw: 0, extra: true },
  { name: 'walk_diag_BL', vx: -0.3, vz: -0.3, yaw: 0, extra: true },
  { name: 'walk_diag_BR', vx: 0.3, vz: -0.3, yaw: 0, extra: true },
  { name: 'run_diag_FL', vx: -0.6, vz: 0.6, yaw: 0, extra: true },
  { name: 'run_diag_FR', vx: 0.6, vz: 0.6, yaw: 0, extra: true },
] as const;

/** Имена, включённые по умолчанию: всё, кроме помеченного `extra` (движок их не спрашивает). */
export const defaultBakePick = (specs: readonly GaitSpec[] = GAIT_PRESETS): string[] =>
  specs.filter((s) => !s.extra).map((s) => s.name);

/** Запечь весь набор. Плеер переиспользуется — между режимами он сам выходит на новый через разогрев. */
export function bakeGaitSet(
  player: PosePlayer, human: Humanoid, opts: BakeGaitOptions,
  specs: readonly GaitSpec[] = GAIT_PRESETS,
): BakeGaitResult[] {
  return specs.map((s) => bakeGaitToClip(player, human, s, opts));
}
