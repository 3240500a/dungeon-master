/**
 * ⭐⭐ ТАЗ: КАДР ПЕРСОНАЖА ↔ МИР — ОДНА КОМПОЗИЦИЯ на игру, запекатель, импорт и модель редактора (ревью 17.09).
 *
 * Таз клипа (эйлер `Hips`, сдвиг `__hipsD`) автор правит В КАДРЕ ПЕРСОНАЖА: «наклон вперёд», «шаг таза вправо». На
 * курсе `yaw` мир получает ЖЁСТКИЙ поворот этого кадра вокруг вертикали: `Hips = Ry(yaw)·Q`, X/Z = `Ry(yaw)·(x, z)`.
 * Так кладёт таз шарнир корня редактора (`frameEdit.placeRootView`) и так клал таз удара `applyAttackPelvis`.
 *
 * ⚠ БЫЛО (игра, `applyTorsoTwist`): курс писался В СЛОТ Y ЭЙЛЕРА — `Rx(наклон)·Ry(курс)·Rz(крен)`. Наклон таза
 * вперёд-назад оставался в МИРОВОЙ оси X, собственный рыск таза клипа выпадал, а X/Z таза (`__hipsD` клипа) не
 * поворачивались с телом. ЗАМЕР (рыцарь, опубликованный warrior, старт курсом 0 / 90 / 180 против 0):
 *  • клип поворота с наклоном таза +15°: таз, грудь и бедро 21.2° / 30.0°, стопа 11.8 / 16.4u; сдвиг (+3, +2) — 5.1 / 7.2u;
 *  • ОПУБЛИКОВАННЫЙ бег «только клипы»: качание таза `__hipsD.x` ≤ 0.40 шло по мировой X — таз 0.58 / 0.82u;
 *  • процедурка с `hipsPitchSwing` 0.15: таз 12.1 / 14.9°, грудь 13.4 / 26.8° (`applyHipsTiltHold` гасит в осях детей).
 * Крен совпадал всегда (`Rx(0)·Ry·Rz = Ry·Rz`). С этой композицией всё перечисленное — 0.00° / 0.00u на любом курсе.
 *
 * ⭐ БЫСТРЫЙ ПУТЬ ТОЧНЫЙ, А НЕ ПРИБЛИЖЁННЫЙ: при нулевом наклоне `Ry(yaw)·Rx(0)·Ry(y)·Rz(z) = Ry(y + yaw)·Rz(z)` —
 * курс ложится сложением в слот Y. Держит нераскрытый эйлер (запекатель вычитает курс обратно ровно так же) и даёт
 * бит в бит прежнее там, где у таза нет наклона и своего рыска: процедурка, стоячие удары, стойки.
 *
 * Файл чистый (только three и типы клипа) — тестируется в node-vitest, `PosePlayer` сюда не импортируется.
 */
import * as THREE from 'three';
import { hipsOffset, setHipsOffset, type Pose } from './clipModel.js';

const _UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _e = new THREE.Euler(), _f = new THREE.Vector3();

/** X/Z на курсе `yaw` (поворот вокруг вертикали, как у `Ry` three): `x·cos + z·sin`, `z·cos − x·sin`. */
function yawXZ(x: number, z: number, yaw: number, out: { x: number; z: number }): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.x = x * c + z * s; out.z = z * c - x * s;
}
const _xz = { x: 0, z: 0 };

/**
 * КОСТЬ ТАЗА ИЗ КАДРА ПЕРСОНАЖА В МИР на курсе `yaw` (мутирует кость). Поворот — `Ry(yaw)` слева, X/Z позиции —
 * `Ry(yaw)` вокруг начала родителя (у `Hips` это логическая точка персонажа, `Root`). Y не трогается.
 * Обратно — тот же вызов с `−yaw`. Зовётся ОДИН раз за кадр, там, где игра ставит курс (`applyTorsoTwist`).
 */
export function pelvisToWorld(hips: THREE.Object3D, yaw: number): void {
  if (hips.rotation.x === 0) hips.rotation.y += yaw;                  // точно: Ry(yaw)·Ry(y)·Rz(z) = Ry(y + yaw)·Rz(z)
  else hips.quaternion.premultiply(_qy.setFromAxisAngle(_UP, yaw));
  const p = hips.position;
  if (p.x !== 0 || p.z !== 0) { yawXZ(p.x, p.z, yaw, _xz); p.x = _xz.x; p.z = _xz.z; }   // ноль не крутим: −0 не рождается
}

/** Эйлер таза (XYZ) на курсе `yaw`: `Ry(yaw)·E`. Нулевой наклон — сложением в слот Y (см. шапку), иначе канонический разбор. */
export function pelvisEulerToWorld(e: readonly [number, number, number], yaw: number): [number, number, number] {
  if (e[0] === 0) return [e[0], e[1] + yaw, e[2]];
  _q.setFromEuler(_e.set(e[0], e[1], e[2], 'XYZ')).premultiply(_qy.setFromAxisAngle(_UP, yaw));
  _e.setFromQuaternion(_q, 'XYZ');
  return [_e.x, _e.y, _e.z];
}

/**
 * ТАЗ ПОЗЫ (эйлер `Hips` и сдвиг `__hipsD`) на курсе `yaw` — мутирует и возвращает `p`. Сдвиг крутится ВМЕСТЕ С
 * рест-точкой таза (`rest`, `hipsRest` рига): в игре X/Z кости — `rest + __hipsD`, поворачивается сумма. Каналов нет —
 * нечего и крутить. Обратно (запекатель, импорт) — `pelvisPoseToChar`.
 */
export function pelvisPoseToWorld(p: Pose, yaw: number, rest: THREE.Vector3): Pose {
  if (yaw === 0) return p;
  const h = p['Hips'];
  if (h) p['Hips'] = pelvisEulerToWorld(h, yaw);
  pelvisOffsetToWorld(p, yaw, rest);
  return p;
}
/** Только сдвиг таза позы (`__hipsD` X/Z) на курсе `yaw`: `Ry(yaw)·(rest + d) − rest`. true — канал был и повёрнут. */
export function pelvisOffsetToWorld(p: Pose, yaw: number, rest: THREE.Vector3): boolean {
  const d = yaw === 0 ? null : hipsOffset(p, rest.y);
  if (!d || (d[0] === 0 && d[2] === 0 && rest.x === 0 && rest.z === 0)) return false;
  yawXZ(rest.x + d[0], rest.z + d[2], yaw, _xz);
  setHipsOffset(p, [_xz.x - rest.x, d[1], _xz.z - rest.z]);
  return true;
}
/** Обратное `pelvisPoseToWorld`: мировой таз позы на курсе `yaw` → кадр персонажа (вычет фейсинга при запекании). */
export function pelvisPoseToChar(p: Pose, yaw: number, rest: THREE.Vector3): Pose {
  return pelvisPoseToWorld(p, -yaw, rest);
}

/**
 * КУРС ТАЗА — рад, в (−π, π]. Не слот Y эйлера: разбор XYZ держит Y в [−90°, 90°], и разворот за 90° читался бы
 * отражённым. Основа — рыск вектора «вперёд» (+Z кости): на позе `Ry(курс)·Rx(наклон)·Rz(крен)` он даёт курс ТОЧНО.
 *
 * ⚠ ГРАБЛЯ ВЕРТИКАЛИ (ревью 17.09): за наклоном ±90° «вперёд» смотрит в пол/небо, его проекция на пол МЕНЯЕТ ЗНАК —
 * и голый `atan2` отдавал курс + π, НАВСЕГДА. Накопитель вызывающего (`clipBaker`, галка «корень: поворот») принимал
 * это за настоящий разворот: ЗАМЕР на синтетическом источнике, курс таза постоянный 20°, падение ничком 0 → 120° —
 * `__rootY` [0, …, 0.06, −179.83, −179.97] (шаг 179.9° за кадр). Мировая поза при этом верна (`Ry(__rootY)`·таз клипа
 * против мокапа 0.04°): 180° уходят в кость таза и компенсируются — портится САМ канал корня, а показ «корень:
 * поворот» разворачивает манекен на 180° на кадре, где таз проходит вертикаль. В игре нокдаун и подъём такие кадры
 * дают, и `bakeFromSource` берёт ЛЮБОЙ мокап, так что «вызывающий такие кадры не кормит» держать было нельзя.
 *
 * ⭐ ОПОРА У ВЕРТИКАЛИ — РЫСК-ТВИСТ `2·atan2(q.y, q.w)`: он непрерывен через вертикаль и на `Ry·Rx` и `Ry·Rz` ТОЧЕН
 * при любом наклоне (свинг-твист-разбор). Он же снимает ветвь ±π у «вперёд». Цена — на СЛОЖЕННЫХ наклоне и крене
 * твист уводит (наклон 15° + крен 10° → 1.3°), поэтому он не заменяет «вперёд», а страхует его:
 *  • проекция «вперёд» на пол короче `S_LO` (конус ±87°, направление тонет в округлении) — только твист;
 *  • поправка «вперёд» гасится, когда расходится с твистом больше `D_LO`: у такой позы ветвь ±π неразличима.
 * ЗАМЕР: чистый наклон ±180° и |наклон| ≤ 60° с креном до 89° — курс точен (1e-13°); полный переворот таза 0 → 360°
 * при кренах 0…120° идёт шагами ≤ 2.4° на 0.25° поворота (было — скачок 180°); падение ничком: `__rootY` ≤ 0.04°.
 * Совсем вверх ногами (крен 179°) курса у таза нет: там остаётся шаг до 56°, но это уже не разворот, а переворот.
 *
 * Накопление через ±π — дело вызывающего (разность кадров свёрнутая в (−π, π]).
 */
export function pelvisHeading(q: THREE.Quaternion): number {
  const tw = wrapPi(2 * Math.atan2(q.y, q.w));                      // рыск-твист: непрерывен через вертикаль
  _f.set(0, 0, 1).applyQuaternion(q);
  const s = Math.hypot(_f.x, _f.z);
  if (s <= S_LO) return tw;                                         // «вперёд» смотрит в пол/небо — курса у него нет
  let d = wrapPi(Math.atan2(_f.x, _f.z) - tw);
  if (Math.abs(d) > Math.PI / 2) d = wrapPi(d + Math.PI);           // ветвь «вперёд» за вертикалью — по твисту
  const kS = Math.min(1, (s - S_LO) / (S_HI - S_LO));
  const kD = Math.min(1, Math.max(0, (Math.PI / 2 - Math.abs(d)) / (Math.PI / 2 - D_LO)));
  return wrapPi(tw + kS * kD * d);                                  // обе доли = 1 (обычные позы) → ровно «вперёд»
}
/** Конус вертикали (0.05 ≈ наклон 87°, 0.25 ≈ 75°) и расхождение с твистом, за которым ветвь ±π неразличима. */
const S_LO = 0.05, S_HI = 0.25, D_LO = Math.PI / 3;
/** Угол в (−π, π]. */
function wrapPi(a: number): number { return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; }
