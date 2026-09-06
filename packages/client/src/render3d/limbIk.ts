/**
 * АНАЛИТИЧЕСКИЙ ДВУХКОСТНЫЙ IK КОНЕЧНОСТИ (Ф25.1) — чистая математика, без DOM, node-тесты.
 *
 * ПОЧЕМУ НЕ FABRIK. Конечность = плечо/бедро (сфера) + локоть/колено (ШАРНИР, одна ось) + кисть/стопа.
 * Позиционный солвер с шарниром посередине теряет непрерывность — это известная слабость
 * («each rotation limit decreases the stability and continuity of the FABRIK solver», FinalIK docs),
 * и замер на нашем риге это подтвердил: цель «кисть к бедру» — сгиб локтя 7° вместо 24° по закону
 * косинусов, недолёт 6u. Индустрия (Maya RP-handle, ozz-animation, Unity TwoBoneIK, UE TwoBoneIK)
 * решает конечность АНАЛИТИЧЕСКИ: три сустава лежат В ОДНОЙ ПЛОСКОСТИ, плоскость задаёт полюс,
 * угол в локте — закон косинусов. Кисть при повороте полюса стоит ПО ПОСТРОЕНИЮ.
 *
 * SOFT IK. У полного разгиба обычный IK «щёлкает»: цепь резко выпрямляется в струну. Индустрия
 * (Maya soft IK, Rigify) демпфирует дистанцию экспонентой у края: «the joint chain never goes
 * straight no matter how far the control goes». Конец тогда честно недоходит на разницу —
 * остаток отдаётся телу (Pull, Ф21.4), как в HumanIK.
 *
 * ЛОКОТЬ КАК ЭФФЕКТОР (`elbowGoal`). В HumanIK локоть/колено — auxiliary effectors: «translating
 * the Elbow and Knee effectors will replicate a Pole-vector constraint». При ПРИБИТОЙ кисти
 * желаемая точка локтя определяет, где должен оказаться сустав-корень (плечо): локоть обязан лежать
 * на сфере радиуса L2 вокруг кисти, а плечо — на сфере радиуса L1 вокруг локтя. Отсюда `Swant` —
 * ближайшее допустимое плечо; тянуть его туда — работа ключицы/корпуса (Ф25.3–Ф25.4).
 *
 * Все векторы — МИРОВЫЕ. Длины звеньев берутся с рига (`bone.position.length()`), а не из таблиц.
 */
import * as THREE from 'three';

export interface TwoBoneIn {
  /** сустав-корень: плечо/бедро (мир) */ S: THREE.Vector3;
  /** цель конца: кисть/стопа (мир) */ H: THREE.Vector3;
  /** направление полюса: куда смотрит локоть/колено (любой длины) */ pole: THREE.Vector3;
  /** длины звеньев: корень→середина, середина→конец */ L1: number; L2: number;
  /** доля длины цепи, на которой начинается soft-демпфирование (0 = выкл). Дефолт 0.1 */ soft?: number;
  /** запасное направление плоскости, если полюс лёг вдоль цепи (UE PBIK «preferred angle») */ prefer?: THREE.Vector3;
}
export interface TwoBoneOut {
  /** мировая точка локтя/колена */ E: THREE.Vector3;
  /** дистанция корень→цель ДО демпфирования */ d0: number;
  /** дистанция, на которую цепь реально вытянулась (после soft) */ d: number;
  /** угол СГИБА в шарнире, рад: 0 = прямая, π = сложена вдвое */ bend: number;
  /** цель в пределах L1+L2 */ reachable: boolean;
  /** нормаль плоскости сгиба (S, E, H) — для выравнивания оси шарнира */ n: THREE.Vector3;
}

/**
 * Доля длины цепи под soft-демпфированием ПО УМОЛЧАНИЮ — 0, то есть ВЫКЛ. Замер на 0.1: стоящая прямая нога
 * (стопа ровно на полном разгибе) получала колено 30° и отрыв стопы 1.23u; кисть на 98% вытяжения не доходила
 * до ручки 0.8u. Сгиб растёт как √недолёта, поэтому любой soft > 0 заметен на полном разгибе (0.02 → ещё 14°).
 * Для ПОЗИНГА точность важнее «попа» скорости локтя у края (в Maya soft тоже выкл по умолчанию); ключица/корпус
 * добирают недостижимое и без него. Функция остаётся как ручка для запекания клипов (там непрерывность важнее).
 */
export const LIMB_SOFT = 0;
const EPS = 1e-6;

/**
 * Демпфирование дистанции у полного разгиба (Maya soft IK).
 * До `L − ds` — как есть; дальше `d' = (L − ds) + ds·(1 − e^{−(d − (L − ds))/ds})`, то есть асимптота L,
 * которой цепь никогда не достигает — «попа» нет, производная непрерывна в точке стыка (= 1).
 */
export function softDistance(d: number, L: number, softFrac: number): number {
  const ds = L * softFrac;
  const knee = L - ds;
  if (ds <= EPS || d <= knee) return d;
  return knee + ds * (1 - Math.exp(-(d - knee) / ds));
}

/** Компонента `v`, перпендикулярная единичному `dir`. */
export function perpTo(v: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
  return v.clone().addScaledVector(dir, -v.dot(dir));
}

/** Любой единичный вектор ⊥ `dir` (для вырожденных случаев). */
function anyPerp(dir: THREE.Vector3): THREE.Vector3 {
  const t = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  return perpTo(t, dir).normalize();
}

export function solveTwoBone(i: TwoBoneIn): TwoBoneOut {
  const L1 = i.L1, L2 = i.L2, L = L1 + L2;
  const soft = i.soft ?? LIMB_SOFT;
  const toH = i.H.clone().sub(i.S);
  const d0 = toH.length();
  // Направление на цель. Цель В самом корне — направление берём из полюса/предпочтения, лишь бы было.
  const dir = d0 > EPS ? toH.multiplyScalar(1 / d0) : (i.prefer ?? i.pole).clone().normalize();
  // Дистанция: soft у края + жёсткие границы треугольника (|L1−L2| … L). Без верхней границы закон
  // косинусов даст NaN, без нижней — цепь «сложится сквозь себя».
  let d = softDistance(d0, L, soft);
  d = Math.min(Math.max(d, Math.abs(L1 - L2) + EPS), L - EPS);
  // Плоскость сгиба: полюс ⊥ dir; лёг вдоль цепи — предпочтительное направление; и оно — любой ⊥.
  let perp = perpTo(i.pole, dir);
  if (perp.lengthSq() < 1e-8 && i.prefer) perp = perpTo(i.prefer, dir);
  if (perp.lengthSq() < 1e-8) perp = anyPerp(dir); else perp.normalize();
  // Угол при корне между dir и звеном L1 (закон косинусов), затем локоть.
  const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
  const a = Math.acos(Math.min(1, Math.max(-1, cosA)));
  const E = i.S.clone().addScaledVector(dir, L1 * Math.cos(a)).addScaledVector(perp, L1 * Math.sin(a));
  // Внутренний угол в шарнире → сгиб (0 = прямая).
  const cosB = (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2);
  const bend = Math.PI - Math.acos(Math.min(1, Math.max(-1, cosB)));
  const n = new THREE.Vector3().crossVectors(dir, perp).normalize();
  return { E, d0, d, bend, reachable: d0 <= L, n };
}

export interface ElbowGoalOut {
  /** локоть на сфере предплечья вокруг прибитой кисти — ближайший к желаемому */ E: THREE.Vector3;
  /** где должен оказаться сустав-корень, чтобы локоть встал в E */ Swant: THREE.Vector3;
  /** требуемый сдвиг корня (`Swant − S`) — работа ключицы/корпуса */ shift: THREE.Vector3;
  /** полюс для `solveTwoBone`, воспроизводящий эту плоскость */ pole: THREE.Vector3;
}

/**
 * Обратная задача для локтя-эффектора: кисть ПРИБИТА в `H`, пользователь тянет локоть в `Ewant`.
 * Локоть не может быть где угодно — только на сфере L2 вокруг кисти; ставим его на ней ближе всего
 * к желаемому. Тогда корень обязан лежать на сфере L1 вокруг локтя — берём ближайшую к текущему
 * корню точку. Разница `Swant − S` и есть то, что надо добрать ключицей (Ф25.3) или корпусом.
 */
export function elbowGoal(S: THREE.Vector3, H: THREE.Vector3, Ewant: THREE.Vector3, L1: number, L2: number): ElbowGoalOut {
  let v = Ewant.clone().sub(H);
  if (v.lengthSq() < EPS) v = S.clone().sub(H);            // локоть «в кисти» — тянем вдоль цепи
  if (v.lengthSq() < EPS) v = new THREE.Vector3(0, 1, 0);
  const E = H.clone().addScaledVector(v.normalize(), L2);
  let u = S.clone().sub(E);
  if (u.lengthSq() < EPS) u = S.clone().sub(H);
  if (u.lengthSq() < EPS) u = new THREE.Vector3(0, 1, 0);
  const Swant = E.clone().addScaledVector(u.normalize(), L1);
  const dir = H.clone().sub(Swant); const dl = dir.length();
  const pole = dl > EPS ? perpTo(E.clone().sub(Swant), dir.multiplyScalar(1 / dl)) : E.clone().sub(Swant);
  return { E, Swant, shift: Swant.clone().sub(S), pole };
}
