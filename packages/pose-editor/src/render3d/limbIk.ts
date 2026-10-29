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

/**
 * УГОЛ СВИВЕЛЯ МЕЖДУ ДВУМЯ ПОЛЮСАМИ — на сколько (рад, со знаком) повернуть `nat` вокруг `axis`, чтобы он лёг на `cur`.
 * Оба сперва проецируются ⊥ оси (длина роли не играет — входы нормируются). Знак — ТОТ ЖЕ, что у применения
 * в `naturalPole`: `nat.applyQuaternion(Q().setFromAxisAngle(axis, угол))` ляжет на `cur`. `atan2`, а не `acos`:
 * у ±π знак не прыгает. Проекция вырождена (вектор вдоль оси) — `null`: плоскость не задана, прежний угол не трогать.
 */
export function planeSwivel(axis: THREE.Vector3, cur: THREE.Vector3, nat: THREE.Vector3): number | null {
  const a = axis.clone(); if (a.lengthSq() < 1e-12) return null; a.normalize();
  const c = perpTo(cur.clone().normalize(), a), n = perpTo(nat.clone().normalize(), a);
  if (c.lengthSq() < 1e-8 || n.lengthSq() < 1e-8) return null;
  return Math.atan2(new THREE.Vector3().crossVectors(n, c).dot(a), n.dot(c));
}

/**
 * КУДА ВЫПИРАЕТ СРЕДНИЙ СУСТАВ ПРИ СГИБЕ ШАРНИРА — в ЛОКАЛЬНОМ фрейме корня (бедра/плеча), из одной оси шарнира.
 * Сгиб на +θ·flexSign уводит дочернее звено вдоль `ось × звено`, значит сустав торчит в обратную сторону:
 * `−flexSign · (ось × звено)`. Колено: ось (1,0,0), +1, голень (0,−1,0) → (0,0,1). Зависит ТОЛЬКО от твиста корня,
 * а не от положения колена: у почти прямой ноги вынос колена от линии «бедро → лодыжка» — это внеосевой шум
 * ±0.043 рад, который `setHingeBend` всё равно срезает (замер: свивель по колену ошибался на 47–60°).
 * Ось ∥ звену — вектор нулевой (плоскость не задана), `planeSwivel` вернёт на нём `null`.
 */
export function hingePoleLocal(hingeAxis: THREE.Vector3, flexSign: 1 | -1, childRestDir: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3().crossVectors(hingeAxis, childRestDir).multiplyScalar(-flexSign).normalize();
}

/**
 * КУДА ШАРНИР ГНЁТСЯ В СОЛВЕ — по ЭФФЕКТИВНОМУ диапазону: сторона, где угол больше по модулю (+1 = max, −1 = min).
 * ОДНО правило на `setHingeBend` (ставит сгиб) и `swivelFromHinge` (читает плоскость): разойдутся — свивель встанет
 * на 180° мимо колена. Флаг `flex` каталога (какой слайдер зовётся «сгиб») сюда НЕ годится — пресета он не видит: у «дигитигра»
 * (колено: сгиб 10°, переразгиб 130° → [−2.27, 0.17]) флаг = +1, а солв гнёт ногу в −1 (замер: плоскость 180° мимо).
 */
export function hingeBendSign(range: { min?: number; max?: number }): 1 | -1 {
  return Math.abs(range.max ?? 0) >= Math.abs(range.min ?? 0) ? 1 : -1;
}

// ── НАТУРАЛЬНЫЙ ПОЛЮС (куда сам смотрит локоть/колено) ──────────────────────────────────────────────────────────
// Всё — во ФРЕЙМЕ ОПОРЫ (таз для ног, корпус для рук): `u` — единичное направление корень→цель в этом фрейме,
// x-компоненты предпочтений заданы для ЛЕВОЙ стороны и умножаются на `side` (+1 левая, −1 правая).

/** Предпочтение руки до 17.09.2026 (Ф26.7): ниже плеча — наружу-вниз-чуть вперёд, выше — вперёд-наружу. */
export const POLE_PREF_LOW = new THREE.Vector3(0.6, -1, 0.35);
export const POLE_PREF_HIGH = new THREE.Vector3(0.5, 0.15, 1);
export const POLE_PREF_LEG = new THREE.Vector3(0, 0, 1);            // колено строго вперёд
/** Предпочтение руки (не нормировано, не ⊥ `u`) по направлению тяги `u` и доле вытяжения `reach` = |корень→цель| / (L1+L2). */
export type ArmPoleFn = (u: THREE.Vector3, side: 1 | -1, reach: number) => THREE.Vector3;
export const armPoleLegacy: ArmPoleFn = (u, side) => {
  const t = Math.min(Math.max((u.y + 0.2) / 0.8, 0), 1);            // 0 = рука ниже плеча, 1 = высоко над ним
  return new THREE.Vector3(
    (POLE_PREF_LOW.x + (POLE_PREF_HIGH.x - POLE_PREF_LOW.x) * t) * side,
    POLE_PREF_LOW.y + (POLE_PREF_HIGH.y - POLE_PREF_LOW.y) * t,
    POLE_PREF_LOW.z + (POLE_PREF_HIGH.z - POLE_PREF_LOW.z) * t);
};
// ── ЛОКОТЬ «АНАТОМИЧЕСКИЙ» (17.09.2026) ──────────────────────────────────────────────────────────────────────────────────────────
// Жалоба: «тяну руку за кисть — локоть держит место и рука выкручивается; при сгибе локоть должен уходить НАЗАД».
// Выбрана из трёх независимых вариантов по стенду `armIkHarness` + 17 дополнительным путям (сторож `armElbow.test.ts`).
// Схема FinalIK LimbIK «Arm» bend modifier: таблица «направление тяги кисти → куда смотрит локоть» во фрейме корпуса,
// смешанная гладкими весами по близости направлений. Смешивается не вектор локтя (среднее противоположных схлопнулось бы
// в ноль), а УГОЛ СВИВЕЛЯ θ в одном общем касательном фрейме, поэтому поле непрерывно и без перескоков.
// Фрейм: «вниз» и «наружу-назад», заданные в опоре B = вперёд-наружу и перенесённые в u кратчайшим поворотом B→u.
// Он гладок всюду, кроме антипода B (кисть назад-внутрь СКВОЗЬ спину на уровне плеча): непрерывного поля локтя на всей
// сфере не бывает (теорема о причёсывании ежа), особую точку можно только спрятать — пределы плеча туда не пускают,
// до ближайшего допустимого направления 24°.
/** Сэмплы: [тяга кисти u (ЛЕВАЯ рука: x наружу, y вверх, z вперёд), куда смотрит локоть]. Подобраны по стенду `armIkHarness`
 *  в пределах плеча текущей таблицы (твист ±97°) — поменялись пределы или пропорции, прогнать стенд заново. */
const ARM_ANAT_SAMPLES: ReadonlyArray<readonly [readonly [number, number, number], readonly [number, number, number]]> = [
  // ниже плеча — локоть НАЗАД: сгиб в сагиттальной плоскости, плечо почти не прокручивается
  [[0, -1, 0], [0.21, 0, -0.98]],             // висит: назад, чуть наружу
  [[0, -0.71, 0.71], [-0.03, -0.71, -0.71]],  // низко впереди (сгиб): назад-вниз
  [[0.71, -0.71, 0], [0.04, 0.04, -1]],       // вниз-в сторону (к бедру): назад
  [[0.3, -0.7, -0.65], [-0.26, 0.59, -0.76]], // низко за корпусом (конец тяги): назад-вверх
  [[-0.71, -0.71, 0], [0.15, -0.15, -0.98]],  // вниз поперёк тела: назад
  // на уровне плеча
  [[0, 0, 1], [0.31, -0.95, 0]],              // вперёд: вниз, чуть наружу
  [[1, 0, 0], [0, 0, -1]],                    // в сторону: назад
  [[-0.71, 0, 0.71], [0.46, -0.75, 0.46]],    // поперёк груди: вниз-наружу-вперёд (не в рёбра)
  [[0, 0, -1], [-0.64, -0.77, 0]],            // строго назад (плечо не пускает): только ради гладкости поля
  // выше плеча — локоть наружу/вниз; за головой — назад (упор наружной ротации плеча)
  [[0, 0.71, 0.71], [0.45, -0.63, 0.63]],     // вперёд-вверх: вниз-вперёд-наружу
  [[0.71, 0.71, 0], [0.69, -0.69, -0.19]],    // вверх-в сторону: вниз-наружу
  [[0, 1, 0], [0.99, 0, 0.12]],               // над головой: наружу
  [[-0.6, 0.8, 0], [0.75, 0.56, 0.36]],       // над головой к другому плечу: наружу-вверх
  [[0, 0.71, -0.71], [0.24, -0.69, -0.69]],   // вверх-назад: назад
];
/** Резкость весов ((1 + u·d)/2)^POW: вес падает вдвое за ~22° от сэмпла. */
const ARM_ANAT_POW = 9;
/** Базис касательной плоскости в `u` (x, y, z — левая рука): e1 = «вниз» (0,−1,0), e2 = «наружу-назад» (s,0,−s), перенесённые
 *  из опоры B = (s,0,s) кратчайшим поворотом B→u (Родриг без тригонометрии: v·c + K×v + K·(K·v)/(1+c), K = B×u, c = B·u).
 *  Пишет [e1x, e1y, e1z, e2x, e2y, e2z] в `out`. Вырождается только в u = −B. */
function armAnatFrame(x: number, y: number, z: number, out: number[]): number[] {
  const s = Math.SQRT1_2, c = s * (x + z);
  const kx = -s * y, ky = s * (x - z), kz = s * y;
  const inv = 1 / Math.max(1 + c, 1e-9), k2 = s * (kx - kz) * inv;
  out[0] = kz - kx * ky * inv; out[1] = -c - ky * ky * inv; out[2] = -kx - kz * ky * inv;
  out[3] = s * (c - ky) + kx * k2; out[4] = s * (kz + kx) + ky * k2; out[5] = -s * (c + ky) + kz * k2;
  return out;
}
const ARM_ANAT_F = [0, 0, 0, 0, 0, 0];
/** Угол свивеля (рад) локтя `e` при тяге `d` в этом фрейме; одна ветвь вокруг 45° (все углы таблицы — 7…94°, смешивать можно). */
function armAnatAngle(d: readonly [number, number, number], e: readonly [number, number, number]): { dx: number; dy: number; dz: number; th: number } {
  const n = Math.hypot(d[0], d[1], d[2]), dx = d[0] / n, dy = d[1] / n, dz = d[2] / n;
  const f = armAnatFrame(dx, dy, dz, [0, 0, 0, 0, 0, 0]);
  const a = Math.atan2(e[0] * f[3]! + e[1] * f[4]! + e[2] * f[5]!, e[0] * f[0]! + e[1] * f[1]! + e[2] * f[2]!) - Math.PI / 4;
  return { dx, dy, dz, th: Math.PI / 4 + Math.atan2(Math.sin(a), Math.cos(a)) };
}
const ARM_ANAT_TABLE = ARM_ANAT_SAMPLES.map(([d, e]) => armAnatAngle(d, e));
/** «Кисть за головой»: чем СИЛЬНЕЕ согнута рука, тем дальше назад-наружу локоть (иначе предел наружной ротации плеча
 *  срезает свивель, и кисть недолетает). Конус 40° вокруг направления, по вытяжению 0.95 → 0.6. */
const ARM_ANAT_BEHIND_HEAD = { ...armAnatAngle([-0.44, 0.82, -0.37], [0.7, 0.06, -0.71]), cos: Math.cos((40 * Math.PI) / 180) };
const armAnatSmooth = (x: number): number => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
/** Куда смотрит локоть: единичный вектор ⊥ `u` (фрейм корпуса), непрерывный по `u` и `reach`, правая рука — зеркало левой. */
export const armPoleAnatomical: ArmPoleFn = (u, side, reach) => {
  const x = u.x * side, y = u.y, z = u.z;
  let sw = 0, st = 0;
  for (const s of ARM_ANAT_TABLE) { const w = Math.pow(Math.max(0, (1 + x * s.dx + y * s.dy + z * s.dz) / 2), ARM_ANAT_POW); sw += w; st += w * s.th; }
  let th = st / sw;                                                   // sw > 0: в пределах ~60° от любого u есть сэмпл
  const m = ARM_ANAT_BEHIND_HEAD, bent = armAnatSmooth((0.95 - (Number.isFinite(reach) ? reach : 1)) / 0.35);
  th += armAnatSmooth((x * m.dx + y * m.dy + z * m.dz - m.cos) / (1 - m.cos)) * bent * (m.th - th);
  const f = armAnatFrame(x, y, z, ARM_ANAT_F), c = Math.cos(th), s = Math.sin(th);
  return new THREE.Vector3((f[0]! * c + f[3]! * s) * side, f[1]! * c + f[4]! * s, f[2]! * c + f[5]! * s);
};

/** Ход кисти (u), за который ручная правка плоскости локтя слабеет в e раз (≈ длина руки). Один на редактор и стенд. */
export const ARM_SWIVEL_FADE = 25;
/**
 * ПРАВКА ПЛОСКОСТИ ЛОКТЯ ЗАТУХАЕТ ПО ХОДУ КИСТИ (вариант 4 разбора, 17.09.2026): `swivel · e^(−ход / fade)`. По пройденному
 * пути, а не по кадрам — от частоты кадров не зависит. Мелкий ход держит авторский локоть, большой возвращает анатомию.
 */
export function fadeSwivel(swivel: number, travel: number, fade = ARM_SWIVEL_FADE): number {
  return swivel && fade > 0 ? swivel * Math.exp(-Math.max(0, travel) / fade) : swivel;
}
/**
 * Полюс во фрейме опоры: предпочтение ⊥ линии тяги, повёрнутое на ручную правку `swivel` вокруг неё.
 * `null` — тянем точно вдоль предпочтения и вбок тоже нельзя: плоскость не задана, вызывающий берёт прежний полюс.
 */
export function limbNaturalPole(u: THREE.Vector3, side: 1 | -1, isFoot: boolean, swivel: number, reach: number, armPole: ArmPoleFn = armPoleLegacy): THREE.Vector3 | null {
  const pref = isFoot ? POLE_PREF_LEG.clone() : armPole(u, side, reach);
  let p = perpTo(pref.normalize(), u);
  if (p.lengthSq() < 1e-6) p = perpTo(new THREE.Vector3(side, 0, 0), u);         // тянем точно вдоль предпочтения
  if (p.lengthSq() < 1e-6) return null;
  p.normalize();
  if (swivel) p.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(u, swivel));   // ручная правка — УГЛОМ вокруг линии тяги
  return p;
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
