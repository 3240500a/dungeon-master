/**
 * ОПОРА КОНЕЧНОСТЕЙ НА ЗАПЕКАНИИ: снятие травела и пины кистей/стоп.
 *
 * ЗАЧЕМ. Смещение таза («перенос веса») без привязанных стоп — это не перенос веса, а езда всей фигурой:
 * ноги едут вместе с тазом, потому что запекатель их вообще не решал. И вторая беда, вскрытая замером:
 * травел вычитался ПОКАДРОВО по горизонтали стоп, а это неверно в принципе — см. `detrendTravel`.
 *
 * КАК В ИНДУСТРИИ.
 * - **HumanIK**: IK-эффекторы стоп приколоты по трансляции и повороту ПО УМОЛЧАНИЮ — «wrists and ankles
 *   remain in place even when the Hips are translated»; сила — параметр **Reach** 0..1.
 * - **UE5 IK Retargeter**: `Pelvis Motion` (смещение таза) + IK Goals на стопах + FBIK, укоренённый в тазу.
 *   ⚠ Их `Speed Planting` относится к IK-ЦЕЛЯМ (борьба со скольжением стопы), а НЕ к каналу таза — мы это
 *   перепутали и поплатились: см. числа в `detrendTravel`.
 * - **Наш редактор** живёт по той же модели: у ног `pin: true` по умолчанию, ползунок `pinPower`,
 *   и `clampHipsToPins` — «дальше не пущу»: таз проецируется в шар досягаемости вокруг запиненной стопы.
 *
 * ⭐ ГЛАВНОЕ ПРАВИЛО (обобщение Ф10 с таза на всю цепь и со смещения на поворот):
 * **вес части задаёт, сколько движения РОДИТЕЛЬСКОЙ ЦЕПИ ей принадлежит; остальное конечность обязана
 * отработать сгибом, а не уехать.** Родительская цепь ноги — таз; руки — таз и позвоночник.
 * Из этого правила само собой следует: вес конечности 1 → опорная поза = финальной → пин это no-op
 * (клип байт-в-байт как без опоры); вес 0 → конечность стоит в мире, пока корпус живёт своей жизнью.
 *
 * Здесь ровно это, но для запекания. Модуль зависит только от THREE + типа `Humanoid` (как `footIk.ts`),
 * поэтому целиком тестируется в node.
 */
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';
import { legGroundIK, legGeomFor, legReach, legBones, LEG_COUNT, FOOT_SOLE } from './footIk.js';
import { solveTwoBoneIK } from './poseRuntime.js';
import { slerpEuler, type Pose } from './clipModel.js';
import type { MaskPart } from './boneMask.js';

export type Vec3 = readonly [number, number, number];

// ── Травел: убираем ТРЕНД, а не опору ────────────────────────────────────────────────────────────
/**
 * Вычесть из горизонтали таза ЛИНЕЙНЫЙ ТРЕНД по всему клипу — то есть настоящий перенос персонажа,
 * а не покадровое положение стоп.
 *
 * ⚠ ЭТО ЗАМЕНА ПОКАДРОВОМУ ВЫЧИТАНИЮ ОПОРЫ, и замена куплена замером. Прежняя схема вычитала среднюю
 * горизонталь стоп КАЖДЫЙ КАДР. На in-place источнике (наш собственный `walk_fwd`) таз стоит — сырое
 * смещение ровно 0 на всех кадрах, — а стопы ходят ±12 юнитов. Любое покадровое вычитание опоры
 * ПРЕВРАЩАЕТ ход стоп в качание таза, которого в источнике нет:
 *   среднее по двум стопам → размах 3.95 юнита, по ОПОРНОЙ (Speed Planting) → 21.68, истина → 0.00.
 * Тренд же на таком клипе равен нулю и не трогает ничего, а на реально едущем мокапе снимает ровно
 * перенос персонажа, оставляя всю осцилляцию (это и есть перенос веса).
 *
 * Горизонталь ещё и привязывается к ПЕРВОМУ кадру: постоянный офсет (мокап заавторен в стороне от нуля)
 * — это не движение, а место съёмки.
 * Вертикаль не трогаем никогда: присед/подскок — движение тела, а не перенос персонажа.
 */
export function detrendTravel(hips: readonly Vec3[], mode: 'none' | 'vertical' | 'full'): [number, number, number][] {
  const n = hips.length;
  if (mode === 'none') return hips.map(() => [0, 0, 0]);
  if (mode === 'vertical' || n === 0) return hips.map((h) => [0, h[1], 0]);
  // Травел = ЧИСТОЕ СМЕЩЕНИЕ ЗА КЛИП, размазанное равномерно, — так извлекают root motion.
  // ⚠ Метод наименьших квадратов тут ХУЖЕ и это замерено: на клипе, где перенос веса делает одну дугу
  // туда-обратно, МНК видит в ней наклон и съедает ~15 % размаха (10.0 → 8.5). По концам такая дуга
  // возвращается в старт → снимается ровно ноль, а настоящий травел снимается целиком.
  const h0 = hips[0]!, hN = hips[n - 1]!, span = Math.max(1, n - 1);
  const sx = (hN[0] - h0[0]) / span, sz = (hN[2] - h0[2]) / span;
  return hips.map((h, i) => [h[0] - h0[0] - sx * i, h[1], h[2] - h0[2] - sz * i]);
}

// ── Конечности ───────────────────────────────────────────────────────────────────────────────────
export type LimbId = 'LH' | 'RH' | 'LF' | 'RF';
export interface LimbDef {
  id: LimbId;
  /** Подпись РОВНО как в редакторе («ПИНЫ (закрепить точку)») — одно понятие в двух местах. */
  label: string;
  /** Часть маски, чей вес решает, сколько движения цепи конечность «заказывала». */
  part: MaskPart;
  root: string; mid: string; end: string;
  /** РОДИТЕЛЬСКАЯ ЦЕПЬ — то, чего конечность не заказывала: у ноги таз, у руки таз + позвоночник. */
  chain: readonly string[];
  pole: readonly [number, number, number];
  /** Нога решается `legGroundIK` (он умеет пол и полюс колена), рука — `solveTwoBoneIK`. */
  leg: boolean;
}
const SPINE_CHAIN = ['Hips', 'Spine', 'Chest', 'UpperChest'] as const;
/** Полюсы взяты те же, что у эффекторов редактора (`pose-editor.ts` `rig.eff`), чтобы локоть/колено
 *  гнулись в ту же сторону, что и при ручном позинге. */
export const LIMBS: readonly LimbDef[] = [
  { id: 'LH', label: 'кисть Л', part: 'armL', root: 'LeftUpperArm', mid: 'LeftLowerArm', end: 'LeftHand', chain: SPINE_CHAIN, pole: [0, -1, -0.4], leg: false },
  { id: 'RH', label: 'кисть П', part: 'armR', root: 'RightUpperArm', mid: 'RightLowerArm', end: 'RightHand', chain: SPINE_CHAIN, pole: [0, -1, -0.4], leg: false },
  { id: 'LF', label: 'стопа Л', part: 'legL', root: 'LeftUpperLeg', mid: 'LeftLowerLeg', end: 'LeftFoot', chain: ['Hips'], pole: [0, 0, 1], leg: true },
  { id: 'RF', label: 'стопа П', part: 'legR', root: 'RightUpperLeg', mid: 'RightLowerLeg', end: 'RightFoot', chain: ['Hips'], pole: [0, 0, 1], leg: true },
];
/** Какие кости переписывает опора — ровно те три, что двигает солвер (плечо/носок не трогаем). */
export const limbBones = (L: LimbDef): string[] => [L.root, L.mid, L.end];
/** Индекс ноги (0 = Л, 1 = П) для `footIk`; у рук — −1. */
export const legIndexOf = (L: LimbDef): number => (L.leg ? (L.id === 'LF' ? 0 : 1) : -1);

const _rpQ = new THREE.Quaternion(), _rpE = new THREE.Euler();
/**
 * ОПОРНАЯ ПОЗА конечности: та же поза, но кости её РОДИТЕЛЬСКОЙ ЦЕПИ приведены к весу `w`
 * (`slerp(базовая, мокап, w)`). Смещение таза вызывающий масштабирует тем же весом.
 *
 * ⚠ Без этого пин держал стопу ОТНОСИТЕЛЬНО ВРАЩАЮЩЕГОСЯ ТАЗА: цель снималась с позы, куда уже был
 * положен мокап-поворот `Hips`, а стопы — потомки таза. Симптом: «добавляешь таз в маску — припиненные
 * стопы всё равно ездят». Для рук то же самое делает скрутка корпуса.
 */
export function refPose(pose: Pose, base: Pose | undefined, chain: readonly string[], w: number): Pose {
  if (w >= 1) return pose;                                   // конечность заказала цепь целиком — опорная = финальная
  const out: Pose = { ...pose };
  for (const nm of chain) {
    const cur = pose[nm]; if (!cur) continue;
    const b = base?.[nm] ?? [0, 0, 0];
    if (w <= 0) { out[nm] = [b[0], b[1], b[2]]; continue; }
    slerpEuler(_rpQ, b, cur, w); _rpE.setFromQuaternion(_rpQ);
    out[nm] = [_rpE.x, _rpE.y, _rpE.z];
  }
  return out;
}

// ── Пины ─────────────────────────────────────────────────────────────────────────────────────────
/** Цель одной конечности: мировая позиция кости конца + мировая ориентация. */
export interface FootTarget { pos: THREE.Vector3; quat: THREE.Quaternion }


/** Снять мировое положение конца конечности — это и есть цель пина, если риг стоит в ОПОРНОЙ позе. */
export function readLimbTarget(H: Humanoid, L: LimbDef): FootTarget | null {
  H.root.updateMatrixWorld(true);
  const b = H.bones.get(L.end);
  return b ? { pos: b.getWorldPosition(new THREE.Vector3()), quat: b.getWorldQuaternion(new THREE.Quaternion()) } : null;
}
/** Обе стопы разом (удобно тестам и заземлению целей). */
export function readFootTargets(H: Humanoid): (FootTarget | null)[] {
  H.root.updateMatrixWorld(true);
  const out: (FootTarget | null)[] = [];
  for (let i = 0; i < LEG_COUNT; i++) {
    const b = H.bones.get(legBones(i).f);
    out.push(b ? { pos: b.getWorldPosition(new THREE.Vector3()), quat: b.getWorldQuaternion(new THREE.Quaternion()) } : null);
  }
  return out;
}

/**
 * Поднять цели так, чтобы НИЖНЯЯ стояла на полу. Заземляем ЦЕЛИ, а не таз: с пинами лифт таза бессмыслен —
 * ноги всё равно вернут стопы в цели, и заземление, посчитанное до пинов, окажется неверным.
 * Обе цели двигаются на ОДНО число, иначе поехала бы взаимная геометрия стоп.
 */
export function groundTargets(targets: readonly (FootTarget | null)[], footLift = 0, floorY = 0): number {
  let lo = Infinity;
  for (const t of targets) if (t) lo = Math.min(lo, t.pos.y);
  if (!Number.isFinite(lo)) return 0;
  const lift = floorY + FOOT_SOLE + footLift - lo;
  for (const t of targets) if (t) t.pos.y += lift;
  return lift;
}

const _cp = new THREE.Vector3(), _cd = new THREE.Vector3();
/**
 * «ДАЛЬШЕ НЕ ПУЩУ»: подвинуть ТАЗ так, чтобы каждая запиненная стопа осталась в пределах длины своей ноги.
 * Порт `clampHipsToPins` из редактора: проекция корня цепи в шар досягаемости вокруг цели, 4 итерации
 * (несколько пинов = пересечение шаров, оно берётся итеративно, как в FABRIK). Так же делает foot-IK в играх:
 * «pelvis adjustment prevents the character from splitting». Альтернатива «таз главнее, стопа скользит» даёт
 * шпагат — поэтому укорачивается ПЕРЕНОС ВЕСА, а стопа не отрывается.
 * Возвращает суммарный сдвиг таза (юниты) — 0 значит, что всё и так доставало.
 * `margin` — АБСОЛЮТНЫЙ запас в юнитах, а не множитель: множитель 0.995 на ноге длиной 29 давал 0.145
 * «недосягаемости» в rest-позе, где нога выпрямлена ровно на свою длину и всё достижимо.
 */
export function clampHipsToFeet(H: Humanoid, targets: readonly (FootTarget | null)[], margin = 0): number {
  const before = H.hips.position.clone();
  for (let it = 0; it < 4; it++) {
    let moved = false;
    for (let i = 0; i < LEG_COUNT; i++) {
      const t = targets[i]; if (!t) continue;
      const root = H.bones.get(legBones(i).u); if (!root) continue;
      H.root.updateMatrixWorld(true);
      root.getWorldPosition(_cp);
      const reach = Math.max(0, legReach(H, i) - margin);
      const d = _cd.copy(t.pos).sub(_cp).length();
      if (d <= reach) continue;
      H.hips.position.addScaledVector(_cd.multiplyScalar(1 / (d || 1)), d - reach);
      moved = true;
    }
    if (!moved) break;
  }
  H.root.updateMatrixWorld(true);
  return H.hips.position.distanceTo(before);
}

const _lkP = new THREE.Vector3(), _lkPole = new THREE.Vector3(), _lkQ = new THREE.Quaternion(), _lkT = new THREE.Vector3();
/** Конец считается «уже в цели» — солвер не зовём. 0.01 юнита ≈ 0.3 мм на нашем масштабе. */
const PIN_EPS = 0.01, PIN_EPS_RAD = 0.001;
/** Запас до полного выпрямления руки на ЗАПЕКАНИИ (в игре 0.5, чтобы локоть не вставал в замок). */
const BAKE_GUARD = 0.02;
/**
 * Догнуть ноги так, чтобы стопы встали в цели. Вес `w` — это **Reach** из HumanIK: 1 = цель держится намертво,
 * 0 = стопа едет за телом (пина нет), между — цель лерпится к фактическому положению.
 * Сам солвер — существующий `footIk.legGroundIK`: он берёт мировую цель, полюс колена и мировую ориентацию
 * стопы и сам клэмпит по длине ноги, СНЯТОЙ С РИГА.
 * Возвращает худший остаточный отрыв (юниты) — по нему видно, упёрся ли перенос веса в длину ноги.
 */
export function lockLimb(H: Humanoid, L: LimbDef, t: FootTarget | null, w = 1): number {
  if (!t || w <= 0.001) return 0;
  const up = H.bones.get(L.root), mid = H.bones.get(L.mid), end = H.bones.get(L.end);
  if (!up || !mid || !end) return 0;
  H.root.updateMatrixWorld(true);
  // Полюс — направление сгиба В МИРЕ: локальный полюс конечности, повёрнутый КОРНЕМ. У ноги это перёд
  // бедра горизонтально (так же берёт `groundFeet`), у руки — «локоть вниз-назад», как в редакторе.
  _lkPole.set(L.pole[0], L.pole[1], L.pole[2]).applyQuaternion(up.getWorldQuaternion(_lkQ));
  if (L.leg) _lkPole.y = 0;
  if (_lkPole.lengthSq() < 1e-6) _lkPole.set(0, 0, 1);
  _lkPole.normalize();
  end.getWorldPosition(_lkP);
  // УЖЕ В ЦЕЛИ — не трогаем. Пин обязан исправлять ОТКЛОНЕНИЕ, а не пересчитывать конечность вхолостую:
  // оба солвера держат запас до полного выпрямления, и на прямой конечности холостой прогон подгибал бы
  // сустав на пустом месте (поймано инвариантом «вес конечности 1 → опора это no-op»).
  if (_lkP.distanceTo(t.pos) < PIN_EPS && end.getWorldQuaternion(_lkQ).angleTo(t.quat) < PIN_EPS_RAD) return 0;
  _lkT.copy(_lkP).lerp(t.pos, w);                                     // Reach по позиции
  end.getWorldQuaternion(_lkQ).slerp(t.quat, w);                      // Reach по ориентации
  const i = legIndexOf(L);
  if (i >= 0) legGroundIK(up, mid, end, _lkT, _lkPole, _lkQ, legGeomFor(H, i));   // маленький запас: точность важнее «не в замок»
  else solveTwoBoneIK(H, L.root, L.mid, L.end, _lkT, _lkQ, _lkPole, BAKE_GUARD);
  H.root.updateMatrixWorld(true);
  return end.getWorldPosition(_lkP).distanceTo(t.pos);
}
/** Обе стопы разом — прежняя сигнатура (тесты и заземление ходят через неё). */
export function lockFeet(H: Humanoid, targets: readonly (FootTarget | null)[], w = 1): number {
  let worst = 0;
  for (const L of LIMBS) {
    const i = legIndexOf(L); if (i < 0) continue;
    worst = Math.max(worst, lockLimb(H, L, targets[i] ?? null, w));
  }
  return worst;
}
