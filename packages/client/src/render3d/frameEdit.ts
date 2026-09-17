/**
 * ПРАВКА КАДРА В ПОЗ-РЕДАКТОРЕ — ЧИСТАЯ ЧАСТЬ (без DOM и сцены), чтобы её мерили node-тесты.
 *
 * Здесь четыре шва, которые раньше жили прямо в `pose-editor.ts` и потому были непроверяемы:
 *  • `poseRig`             — поставить позу КЛЮЧА на любой риг (манекен, призрак соседнего кадра);
 *  • `settleLikePhysGhost` — заземлить риг ТАК ЖЕ, как на паузе оседает физ-призрак, который ведёт меш;
 *  • `writeKeyPose`        — записать позу в ключ, не потеряв служебные каналы и не порвав шов цикла;
 *  • `aimBoneToPoint`      — хелпер взгляда, который на смене кадра НЕ переписывает шею и голову;
 *  • `rootPreviewAt` и Ко  — ПРЕДПРОСМОТР КОРНЯ клипа (галки «корень: поворот / смещение») — внизу файла.
 *
 * Разбор и замеры — `render3d/README.md`, раздел «Запись кадра, призраки соседних кадров, хват (17.09.2026)»
 * и «Предпросмотр корня: галки «корень: поворот / смещение» (17.09.2026)».
 */
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';
import type { LimitView } from './humanoidRagdoll.js';
import { groundFeet } from './footIk.js';
import { clampLocalToLimit } from './jointClamp.js';
import { hipsOffset, clipPoseAt, clipChannelAt, clipDur, clamp01, WPN_KEYS, WPN_POS, ROOT_YAW, ROOT_POS, HIPS_DEL, type Clip, type Pose } from './clipModel.js';
import { pelvisEulerToWorld, pelvisPoseToWorld } from './pelvisFrame.js';   // ⭐ таз на курсе — одна композиция с игрой
import { SWING_KEY } from './turnInPlace.js';

// ── Поза ключа на риг ─────────────────────────────────────────────────────────────────────────────

/**
 * Поставить позу ключа на риг: повороты (включая `Root`) + таз = rest + СОБСТВЕННЫЙ `__hipsD` ключа.
 *
 * ⚠ ОДНА ФУНКЦИЯ НА МАНЕКЕН И ПРИЗРАКИ СОСЕДНИХ КАДРОВ. У призраков была своя копия, и таз она брала
 * С МАНЕКЕНА (`h.bones.get('Hips').position.copy(human…)`) — наследие времени, когда офсета таза в кадре
 * не было. Ноги соседнего кадра висели на тазе ТЕКУЩЕГО, стопы уезжали ровно на разницу `__hipsD`.
 * ЗАМЕР (knight_06, опубликованные клипы, соседи на ±1…3 ключа): расхождение с позой того кадра `run_fwd` 0.76u,
 * `walk_back` 3.67u, `hit_sword_r_01` 5.08u; лодыжка по вертикали до 3.83u (`hit_none_r_01`); стопа/носок
 * призрака под полом до −3.63 (`walk_back`). С `poseRig` — 0.000000.
 */
export function poseRig(h: Humanoid, p: Pose): void {
  h.reset();
  for (const nm in p) {
    if (nm[0] === '_') continue;
    const b = h.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]);
  }
  const hd = hipsOffset(p, h.hipsRest.y);
  if (hd) h.hips.position.set(h.hipsRest.x + hd[0], h.hipsRest.y + hd[1], h.hipsRest.z + hd[2]);
}

// ── Заземление как у физ-призрака на паузе ────────────────────────────────────────────────────────

const LEG_BONES = ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'] as const;
const FLAT_FLOOR = (): number => 0;
/** Шаг призрака редактора (`renderRagdollGhost` в `stepPhysics`: `min(dt, 1/60)`; физика там шагает кадр целиком). */
export const GHOST_DT = 1 / 60;
/**
 * Предохранитель от зацикливания (опорность стопы может мигать на пороге высоты). Шагов столько, сколько нужно
 * интегратору: ЗАМЕР на опубликованных клипах — `gndLag` 15 до 29 шагов (≤0.4 мс на призрак), `gndLag` 1 до 355
 * (1.4–4.8 мс). Укрупнять шаг ради скорости пробовал: k ≥ 0.05 даёт ~130 шагов, но расхождение с видимой
 * фигурой растёт с 0.004u до 0.023u — `updateOnion` зовётся по событиям, а не каждый кадр, точность дороже.
 */
export const SETTLE_MAX_STEPS = 600;
/** Сдвиг таза за шаг меньше этого — осело. */
const SETTLE_EPS = 1e-5;

/**
 * Заземлить риг ТАК ЖЕ, как физ-призрак оседает на кадре, куда перешли (`goFrame` обнуляет `ghostGround.off`).
 *
 * Призрак (`renderRagdollGhost`) каждый кадр: ноги ровно по позе (`LEG_MESH`, match = 1), таз = таз позы + `gs.off`,
 * затем `groundFeet(…, { lag: GAIT.gndLag, still: true })` без флагов опоры. Интегратор `gs.off` с «стоим» оседает
 * НЕ на полный зазор, а на его часть: неподвижная точка `off = g·(1 − k/2)/(1.5 − k/2)`, `k = dt·lag` — около 2/3.
 * Одноразовый вызов с большим `dt` (как `groundManikin`) оставил бы таз на авторской высоте — ЗАМЕР (опубликованные
 * клипы, `gndLag` 15): таз мимо видимой фигуры до 2.85u (`run_back`), 0.68u (`walk_fwd`), кости до 5.96u. Поэтому
 * гоняем ТОТ ЖЕ `groundFeet` теми же шагами до сходимости: ≤0.0001u (`gndLag` 15) и ≤0.004u (`gndLag` 1) против
 * 10-секундной модели призрака. Одна опорная стопа (`holdIdle`) держит сдвиг как есть — у призрака после `goFrame` это 0.
 *
 * `lag` — `GAIT.gndLag`. Возвращает итоговый сдвиг таза и число шагов (для замеров).
 */
export function settleLikePhysGhost(h: Humanoid, lag: number, dt = GHOST_DT): { off: number; steps: number } {
  const gs = { off: 0 };
  h.root.updateMatrixWorld(true);
  const hy = h.hipsWorldY();
  const save = LEG_BONES.map((n) => h.bones.get(n)?.quaternion.clone() ?? null);
  let n = 0;
  while (n < SETTLE_MAX_STEPS) {
    LEG_BONES.forEach((nm, i) => { const b = h.bones.get(nm), q = save[i]; if (b && q) b.quaternion.copy(q); });
    const was = gs.off;
    h.setHipsWorldY(hy + gs.off); h.root.updateMatrixWorld(true);
    groundFeet(h, hy, gs, dt, FLAT_FLOOR, undefined, { lag, still: true });
    n++;
    if (Math.abs(gs.off - was) < SETTLE_EPS) break;
  }
  return { off: gs.off, steps: n };
}

// ── Запись позы в ключ ────────────────────────────────────────────────────────────────────────────

/**
 * Служебные каналы, которыми ВЛАДЕЕТ чтение позы редактора (`readPoseFull`): их отсутствие в свежей позе —
 * осознанное решение (галка «своя правка хвата» снята, маркер левой кисти убран, таз записан заново),
 * поэтому со старого ключа их НЕ переносим.
 */
const RECORD_OWNED: ReadonlySet<string> = new Set(['__hipsD', '__hipsP', '__wpnOverride', ...WPN_KEYS, ...WPN_POS, '__lgripP', '__lgripR']);

/**
 * Перенести со старого ключа служебные `__`-каналы, которых чтение позы НЕ производит.
 * ⚠ Запись кадра стирала их: `__swing` (опорность стоп из запекания — поворот на месте теряет разметку шага),
 * `__rootY`/`__rootP` (корень), `__match`/`__pinKp` (физ-настройки кадра). В опубликованных клипах
 * `__swing` и `__rootY` несут 191 ключ.
 */
export function keepChannels(fresh: Pose, old: Pose): Pose {
  for (const nm in old) {
    if (!nm.startsWith('__') || nm in fresh || RECORD_OWNED.has(nm)) continue;
    const v = old[nm]!; fresh[nm] = [v[0], v[1], v[2]];
  }
  return fresh;
}

/** Допуск «концы цикла совпадают»: поворот кости, рад. Запекание копирует ключ 0 в последний бит в бит. */
export const SEAM_TOL_RAD = 1e-4;
/** Допуск совпадения офсета таза, u. */
export const SEAM_TOL_HIPS = 1e-4;
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _ea = new THREE.Euler(), _eb = new THREE.Euler();
const ZERO: readonly [number, number, number] = [0, 0, 0];

/** Совпадают ли две позы ключа: каждая кость (нет ключа — rest) до `SEAM_TOL_RAD` и офсет таза до `SEAM_TOL_HIPS`. */
export function sameKeyPose(a: Pose, b: Pose): boolean {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const nm of names) {
    if (nm[0] === '_') continue;
    const va = a[nm] ?? ZERO, vb = b[nm] ?? ZERO;
    _qa.setFromEuler(_ea.set(va[0], va[1], va[2]));
    _qb.setFromEuler(_eb.set(vb[0], vb[1], vb[2]));
    if (_qa.angleTo(_qb) > SEAM_TOL_RAD) return false;
  }
  const ha = hipsOffset(a) ?? ZERO, hb = hipsOffset(b) ?? ZERO;
  return Math.abs(ha[0] - hb[0]) <= SEAM_TOL_HIPS && Math.abs(ha[1] - hb[1]) <= SEAM_TOL_HIPS && Math.abs(ha[2] - hb[2]) <= SEAM_TOL_HIPS;
}

const clonePose = (p: Pose): Pose => { const o: Pose = {}; for (const k in p) { const v = p[k]!; o[k] = [v[0], v[1], v[2]]; } return o; };

/**
 * ЗАПИСАТЬ ПОЗУ В КЛЮЧ `i`. Возвращает индексы ключей, которые изменились.
 *
 * 1. Служебные каналы старого ключа, которых нет в свежей позе, переносятся (`keepChannels`).
 * 2. ШОВ ЦИКЛА. У зацикленного клипа последний ключ — копия первого (так замыкает запекание). Запись одного
 *    из концов рвала шов: опубликованный `run_fwd` после правки ключа 0 прыгает на стыке на 19.4° (стопа)
 *    и 22.1° (голова), и игра это играет. Если ДО правки концы совпадали (`sameKeyPose`), свежая поза
 *    копируется и в парный ключ; разошедшиеся концы автор развёл сам — их не трогаем.
 */
export function writeKeyPose(c: Clip, i: number, fresh: Pose): number[] {
  const k = c.keys[i]; if (!k) return [];
  const last = c.keys.length - 1;
  const pair = c.loop && c.keys.length > 2 && (i === 0 || i === last) ? (i === 0 ? last : 0) : -1;
  const seamed = pair >= 0 && sameKeyPose(c.keys[0]!.pose, c.keys[last]!.pose);   // смотрим ДО записи
  k.pose = keepChannels(fresh, k.pose);
  if (!seamed) return [i];
  const pk = c.keys[pair]!;
  pk.pose = keepChannels(clonePose(k.pose), pk.pose);
  return [i, pair];
}

// ── Время таймлайна ↔ ключ ────────────────────────────────────────────────────────────────────────

/** Полкадра при 60 к/с: клик по линейке в пределах этого от ключа — это клик ПО КЛЮЧУ. */
export const KEY_SNAP_SEC = 1 / 120;
/** Индекс ключа, на время которого попадает `t` (ближайший в пределах `eps`), иначе −1. */
export function keyAtTime(c: Clip, t: number, eps = KEY_SNAP_SEC): number {
  let best = -1, bd = eps;
  c.keys.forEach((k, i) => { const d = Math.abs(k.t - t); if (d <= bd) { bd = d; best = i; } });
  return best;
}
/**
 * ГЕЙТ ЗАПИСИ КАДРА: время превью, если поза на манекене показана превью (`previewT`) НЕ на времени выбранного ключа `i`;
 * null — поза стоит на ключе `i` (или превью не было), запись разрешена. Нет такого ключа — тоже отказ.
 * Вынесено из `pose-editor.ts` ради node-теста: там гейт жил в DOM-коде, и РЕВЬЮ-МУТАЦИЯ «инверсия условия»
 * проходила все 37 тестов потока — запись после скраба снова молча уходила бы в чужой ключ.
 */
export function previewOffKey(c: Clip, i: number, previewT: number | null, eps = KEY_SNAP_SEC): number | null {
  if (previewT === null) return null;
  const k = c.keys[i];
  return k && Math.abs(k.t - previewT) <= eps ? null : previewT;
}

// ── Взгляд: смена кадра не переписывает шею и голову ─────────────────────────────────────────────

const _lookE = new THREE.Euler(), _aw = new THREE.Quaternion(), _ap = new THREE.Quaternion(), _af = new THREE.Quaternion(), _an = new THREE.Quaternion();
const _av = new THREE.Vector3(), _ac = new THREE.Vector3(), _aq = new THREE.Quaternion();
/** Базис взгляда по направлению `d`: +Z → `d` без крена относительно мировой вертикали (рыск, затем тангаж). */
export function lookBasis(d: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromEuler(_lookE.set(Math.asin(Math.min(1, Math.max(-1, -d.y))), Math.atan2(d.x, d.z), 0, 'YXZ'));
}
/** Точка взгляда «перед лицом ЭТОГО кадра»: голова + её СОБСТВЕННЫЙ «вперёд» × `dist`. */
export function faceTarget(h: Humanoid, head: string, fwd: THREE.Vector3, dist: number, out = new THREE.Vector3()): THREE.Vector3 | null {
  const hd = h.bones.get(head); if (!hd) return null;
  h.root.updateMatrixWorld(true);
  _ac.copy(fwd).applyQuaternion(hd.getWorldQuaternion(_aq));
  return out.copy(hd.getWorldPosition(_av)).addScaledVector(_ac, dist);
}
/**
 * СДВИГИ ПРИЦЕЛА по костям цепочки (Unity Multi-Aim «Maintain Offset»): «вперёд» кости в базисе взгляда на цель.
 *
 * ЗАЧЕМ. Цепочка шея 0.35 → голова 0.65 целит каждую кость СВОЕЙ осью «вперёд» в одну точку. У авторской позы
 * эти оси расходятся (голова наклонена относительно шеи), поэтому никакая точка не оставляет позу нетронутой:
 * переставить цель «перед лицом нового кадра» мало. ЗАМЕР на 24 опубликованных клипах (knight_06): только
 * перестановка цели — шея/голова меняются до 48.9° (`hit_none_r_01`), 16.2° на `run_fwd`; со сдвигами — 0.00°
 * везде. Сдвиг головы при цели на её же луче — тождество, то есть линия «голова → цель» остаётся честной,
 * а шея сохраняет авторский угол к направлению взгляда при любом повороте корпуса.
 */
export function captureAimOffsets(h: Humanoid, bones: readonly (readonly [string, number])[], target: THREE.Vector3, fwd: THREE.Vector3): Map<string, THREE.Vector3> {
  const out = new Map<string, THREE.Vector3>();
  h.root.updateMatrixWorld(true);
  for (const [nm] of bones) {
    const b = h.bones.get(nm); if (!b) continue;
    const want = _av.copy(target).sub(b.getWorldPosition(_ac));
    if (want.lengthSq() < 1e-6) continue;
    want.normalize();
    out.set(nm, fwd.clone().applyQuaternion(b.getWorldQuaternion(_aq)).applyQuaternion(lookBasis(want, _aw).invert()));
  }
  return out;
}
/** Меньше этого доворота (рад) — довернуть нечего: кость и клэмп предела не трогаем. */
export const AIM_NOOP_RAD = 1e-6;
/**
 * Довернуть кость своей осью `fwd` на точку с весом и клэмпом предела сустава (`limit`). `off` — сдвиг прицела
 * (`captureAimOffsets`), нет — целим осью ровно в точку.
 *
 * ⚠ НЕЧЕГО ДОВОРАЧИВАТЬ — НЕ КЛЭМПИМ. Иначе поза, где шея/голова стоят за пределом, менялась от одного включения
 * взгляда. ЗАМЕР: со сдвигами без этой проверки оставалось 40.3° (`hit_none_r_01`), 22.7° (`hit_sword_r_01`),
 * 27.8° (`turn_L_180`) — ровно клэмп авторских ключей, выходящих за предел.
 */
export function aimBoneToPoint(h: Humanoid, nm: string, target: THREE.Vector3, weight: number, fwd: THREE.Vector3,
  limit: (nm: string) => LimitView | null, off?: THREE.Vector3): void {
  const b = h.bones.get(nm); if (!b || !b.parent || weight <= 0) return;
  b.updateWorldMatrix(true, false);
  const wq = b.getWorldQuaternion(_aw).clone();
  const cur = fwd.clone().applyQuaternion(wq);
  const want = target.clone().sub(b.getWorldPosition(_av));
  if (want.lengthSq() < 1e-6) return;
  want.normalize();
  if (off) { lookBasis(want, _ap); want.copy(off).applyQuaternion(_ap); }   // базис — ДО перезаписи `want`
  const full = _af.setFromUnitVectors(cur, want);
  if (2 * Math.acos(Math.min(1, Math.abs(full.w))) * weight < AIM_NOOP_RAD) return;
  const nw = _an.identity().slerp(full, weight).multiply(wq);          // часть дуги, а не вся — отсюда распределение по цепи
  b.quaternion.copy(b.parent.getWorldQuaternion(_ap).invert().multiply(nw));
  const view = limit(nm);
  if (view) b.quaternion.copy(clampLocalToLimit(b.quaternion, view));
  b.updateMatrixWorld(true);
}

// ── ⭐ Предпросмотр корня: галки «корень: поворот / смещение» ─────────────────────────────────────

/**
 * КОРЕНЬ, ПОКАЗАННЫЙ В РЕДАКТОРЕ: рыск (рад, накопленный) и смещение по полу (u).
 *
 * Жалоба: «в анимациях поворота непонятно, как это будет выглядеть — он просто топчется на месте». Клип поворота
 * in-place: запекатель ВЫЧИТАЕТ рыск из таза и кладёт его рядом каналом `__rootY` (`clipBake.neutralizeFacing`,
 * `clipBaker`), а игра возвращает его через `turnYawAt`. Редактор каналы корня не читал вовсе — отсюда «топчется».
 * ЗАМЕР (все 6 `TURN_PRESETS`, процедурное запекание, кости против мировых позиций на запекании): показ на месте
 * расходится на 12.86u (45°) / 23.52u (90°) / 33.60u (180°), с поворотом корня — 0.021u, как у формулы игры.
 *
 * ⚠ Это ВИД, а не поза: в ключ, буфер, публикацию и запекание он не попадает — его держит отдельный шарнир-родитель
 * рига в сцене (`pose-editor.ts`, `rootTurn`), а все чтения позы локальные.
 */
export interface RootView { yaw: number; x: number; z: number }
export const ROOT_VIEW_ZERO: Readonly<RootView> = Object.freeze({ yaw: 0, x: 0, z: 0 });
/** Какие части корня показывать: галки `pe_prefs` ∩ каналы, которые клип вообще несёт. */
export interface RootWant { yaw: boolean; pos: boolean }

/** Несёт ли клип каналы корня. Флаг клипа (`rootYaw`/`rootPos`) ИЛИ канал хоть в одном ключе: флаги пишут не все пути. */
export function clipRootChannels(c: Clip | null | undefined): RootWant {
  const out = { yaw: !!c?.rootYaw, pos: !!c?.rootPos };
  for (const k of c?.keys ?? []) {
    if (out.yaw && out.pos) break;
    if (k.pose[ROOT_YAW]) out.yaw = true;
    if (k.pose[ROOT_POS]) out.pos = true;
  }
  return out;
}

/** Корень кадра по его СОБСТВЕННЫМ каналам (призраки соседних кадров). Нет канала — ноль этой части. */
export function rootViewOfPose(p: Pose, want: RootWant): RootView {
  const y = p[ROOT_YAW], q = p[ROOT_POS];
  return { yaw: want.yaw && y ? y[0] : 0, x: want.pos && q ? q[0] : 0, z: want.pos && q ? q[2] : 0 };
}

/**
 * Корень клипа на времени `t` (сек) — ТЕМ ЖЕ сэмплером, что игра (`turnInPlace.turnYawAt`: `clipPoseAt` по t / длит.).
 * `__rootY` накопленный и лерпится линейно (сплайн — по компонентам), поэтому разворот на 180°+ не сворачивается в ±π.
 * Зеркало клипа (`flipPose`) меняет знак `__rootY` и X у `__rootP` — здесь ничего особого не нужно.
 */
export function rootPreviewAt(c: Clip, t: number, want: RootWant, out: RootView = { yaw: 0, x: 0, z: 0 }): RootView {
  out.yaw = 0; out.x = 0; out.z = 0;
  if (!want.yaw && !want.pos) return out;
  // ⚠ Только каналы корня (`clipChannelAt`), а не `clipPoseAt` целиком: редактор зовёт это каждый кадр проигрывания, и
  // бленд всех костей ради одного числа был лишней позой на кадр (ревью 17.09). Значение то же — сторожит тест.
  const u = clamp01(t / (clipDur(c) || 1));
  if (want.yaw) { const y = clipChannelAt(c, u, ROOT_YAW, _rvCh); if (y) out.yaw = y[0]; }
  if (want.pos) { const q = clipChannelAt(c, u, ROOT_POS, _rvCh); if (q) { out.x = q[0]; out.z = q[2]; } }
  return out;
}
const _rvCh: [number, number, number] = [0, 0, 0];
/** Скопировать корень в `out` (у редактора `rootShown` — свой объект: на него не ссылаются, его переписывают). */
export function copyRootView(out: RootView, v: Readonly<RootView>): RootView { out.yaw = v.yaw; out.x = v.x; out.z = v.z; return out; }

/** На каком времени стоит показанная поза: время превью (скраб, проигрывание, кривая) или время выбранного ключа. */
export function rootViewTime(c: Clip, frameIdx: number, previewT: number | null): number | null {
  return previewT ?? c.keys[frameIdx]?.t ?? null;
}

export const sameRootView = (a: RootView, b: RootView, eps = 1e-9): boolean =>
  Math.abs(a.yaw - b.yaw) <= eps && Math.abs(a.x - b.x) <= eps && Math.abs(a.z - b.z) <= eps;

const _rvY = new THREE.Vector3(0, 1, 0), _rvQ = new THREE.Quaternion(), _rvM = new THREE.Matrix4();
/**
 * Матрица корня `T(x,0,z)·Ry(yaw)`: поворот вокруг ВЕРТИКАЛИ В ЛОГИЧЕСКОМ НАЧАЛЕ персонажа, а не вокруг таза. Таз
 * уходит с этой оси авторским `__hipsD` (выпад, перенос веса) — крутить вокруг него значило бы водить ось по кругу.
 */
export function rootViewMatrix(v: RootView, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out.makeRotationY(v.yaw).setPosition(v.x, 0, v.z);
}
/** Поставить корень на ШАРНИР (объект, у которого своего трансформа нет): позиция и рыск целиком. */
export function placeRootView(o: THREE.Object3D, v: RootView): void {
  o.position.set(v.x, 0, v.z); o.quaternion.setFromAxisAngle(_rvY, v.yaw);
  o.updateMatrixWorld(true);   // ⚠ дети (`human.root.updateMatrixWorld`) берут матрицу родителя как есть — устаревшая отстала бы на кадр
}
/**
 * Надеть корень ПОВЕРХ корня рига (призрак соседнего кадра стоит в сцене сам по себе): `Ry·Root`, смещение по полу.
 * Равно шарниру-родителю, пока у `Root` нет своего X/Z (его ставит только `goFrame`/`applyPoseTo` — в ноль).
 */
export function composeRootView(o: THREE.Object3D, v: RootView): void {
  o.position.x += v.x; o.position.z += v.z;
  o.quaternion.premultiply(_rvQ.setFromAxisAngle(_rvY, v.yaw));
}
/**
 * ПЕРЕНОС МИРОВОГО СОСТОЯНИЯ ПРАВКИ при смене показанного корня: `m` для точек (цели эффекторов, точка взгляда),
 * `q` для направлений и поворотов (полюса, ориентация стоп, ручка таза). Как если бы они были привязаны к персонажу —
 * тогда в кадре персонажа (под шарниром) они не меняются, и правка с галкой идёт ровно так же, как без неё.
 */
export function rootViewDelta(from: RootView, to: RootView, out = { m: new THREE.Matrix4(), q: new THREE.Quaternion() }): { m: THREE.Matrix4; q: THREE.Quaternion } {
  rootViewMatrix(to, out.m).multiply(rootViewMatrix(from, _rvM).invert());
  out.q.setFromAxisAngle(_rvY, to.yaw - from.yaw);
  return out;
}

/**
 * ⭐ МИР ↔ КАДР ПЕРСОНАЖА под корнем `v` (шарнир `T(x,0,z)·Ry(yaw)`, `rootViewMatrix`): точка, направление, поворот.
 * Все места редактора, где мировое встречается с локальным, зовут ЭТИ функции — драг и кламп таза, ручка вращения таза,
 * центр масс и опора баланса, снимок undo, точка взгляда. ⚠ Раньше это были обёртки прямо в `pose-editor.ts`, и семь
 * мутаций (забытый `invert`, обратная матрица вместо прямой, смещение мимо, «вперёд» мира вместо персонажа) проходили все
 * тесты: проверялось, ЧТО зовётся, а не что считается. Теперь математику сторожит `rootPreview.test.ts` против матриц
 * самого three (`Object3D.worldToLocal`/`localToWorld`/`getWorldQuaternion`). Все мутируют аргумент и возвращают его.
 */
export function rootPointToLocal(p: THREE.Vector3, v: Readonly<RootView>): THREE.Vector3 { p.x -= v.x; p.z -= v.z; return p.applyQuaternion(_rvYaw(-v.yaw)); }
export function rootPointToWorld(p: THREE.Vector3, v: Readonly<RootView>): THREE.Vector3 { p.applyQuaternion(_rvYaw(v.yaw)); p.x += v.x; p.z += v.z; return p; }
/** Направление (дельта драга, вектор кламп-сдвига, полюс) — только рыск, без смещения. */
export function rootDirToLocal(d: THREE.Vector3, v: Readonly<RootView>): THREE.Vector3 { return d.applyQuaternion(_rvYaw(-v.yaw)); }
export function rootDirToWorld(d: THREE.Vector3, v: Readonly<RootView>): THREE.Vector3 { return d.applyQuaternion(_rvYaw(v.yaw)); }
/** Поворот (ориентация стопы, ручка таза): рыск корня СЛЕВА — `Ry(∓yaw)·q`. */
export function rootQuatToLocal(q: THREE.Quaternion, v: Readonly<RootView>): THREE.Quaternion { return q.premultiply(_rvYaw(-v.yaw)); }
export function rootQuatToWorld(q: THREE.Quaternion, v: Readonly<RootView>): THREE.Quaternion { return q.premultiply(_rvYaw(v.yaw)); }
const _rvYaw = (yaw: number): THREE.Quaternion => _rvQ.setFromAxisAngle(_rvY, yaw);

/** Скачок корня, после которого физ-призрак ставится на позу, а не догоняет её (скраб, переход на кадр, галка). */
export const ROOT_SNAP_YAW = (15 * Math.PI) / 180;
export const ROOT_SNAP_POS = 4;
/**
 * Скачок ли. Кинематический таз куклы (`MoveKinematic`) за ОДИН шаг довернуть на 90–180° — это сотни рад/с: верх тела
 * хлещет, пока пины не соберут. Проигрывание поворота даёт единицы градусов на кадр и сюда не попадает.
 */
export const rootViewJump = (a: RootView, b: RootView): boolean =>
  Math.abs(a.yaw - b.yaw) > ROOT_SNAP_YAW || Math.hypot(a.x - b.x, a.z - b.z) > ROOT_SNAP_POS;

/**
 * ЦЕЛЬ ФИЗ-ПРИЗРАКА С РЫСКОМ КОРНЯ: `Hips := Ry(yaw)·Hips` (позу мутирует и возвращает её же) — та же композиция, что у игры
 * (`pelvisFrame.pelvisEulerToWorld`).
 *
 * Призрак стоит в сцене сам по себе, а не под шарниром: его таз берётся из физики В МИРЕ (кинематический таз = мировой
 * таз манекена, рыск уже в нём), а цель бленда (`renderRagdollGhost`, match ≈ 0.85) — ЛОКАЛЬНАЯ поза манекена без
 * рыска. Не повернуть цель — призрак (а с ним меш и оружие) довернулся бы только на ~15%. Нулевой рыск — поза как есть.
 */
export function turnHipsTarget(p: Pose, yaw: number): Pose {
  if (Math.abs(yaw) < 1e-12) return p;
  p['Hips'] = pelvisEulerToWorld(p['Hips'] ?? [0, 0, 0], yaw);
  return p;
}

const _gE = new THREE.Euler();
/**
 * ТАЗ КЛИПА ПОВОРОТА В ИГРЕ на курсе `course` — модель ветки поворота `PosePlayer` (вес клипа 1, шов погашен): поворот
 * `Ry(курс)·таз клипа`, X/Z — `Ry(курс)·(rest + __hipsD)` (`blendClipBones` кладёт таз в кадре персонажа, `applyTorsoTwist`
 * докладывает курс через `pelvisFrame.pelvisToWorld`; здесь — та же композиция позой, `pelvisPoseToWorld`). Без `__hipsD`
 * X/Z — база `gaitToHumanoid`, 0. Y не считаем.
 *
 * ⭐ ПОКАЗ = ИГРА ПО ПОСТРОЕНИЮ (ревью 17.09). Шарнир корня крутит персонажа целиком — `Ry(курс)` слева на таз и на его
 * X/Z, и игра теперь кладёт курс ТАК ЖЕ. Было — курс в слот Y эйлера: наклон таза вперёд-назад в мировой оси X, свой
 * рыск таза клипа выпадал, `__hipsD` X/Z в мировых осях. ЗАМЕР на настоящем `PosePlayer` (turn_R_180, наклон таза +15° на
 * всех ключах): игра против показа 30.0° → 0.00°; `__hipsD.x` +3 — 6u → 0.00u; на старте курсом 0 / 90 / 180 / −90 так же.
 * Предупреждение «в игре таз ляжет иначе» в свитке клипа и функции расхождения убраны: расхождение — ноль по построению.
 * Единственная разница моделей — клип БЕЗ `__hipsD` на риге с ненулевым X/Z реста (у всех нынешних ригов рест X/Z = 0):
 * игра держит таз в 0, шарнир — в ресте. Сторож — `rootPreview.test.ts` (настоящий `PosePlayer` против шарнира).
 */
export function turnHipsInGame(p: Pose, course: number, rest: THREE.Vector3, q: THREE.Quaternion, pos: THREE.Vector3): void {
  const hd = hipsOffset(p, rest.y);
  const w = pelvisPoseToWorld({ Hips: p['Hips'] ?? [0, 0, 0], ...(hd ? { [HIPS_DEL]: hd } : {}) }, course, rest);
  const h = w['Hips']!, d = w[HIPS_DEL];
  q.setFromEuler(_gE.set(h[0], h[1], h[2]));
  pos.set(d ? rest.x + d[0] : 0, 0, d ? rest.z + d[2] : 0);
}

/** Каналы ДВИЖЕНИЯ клипа во времени — корень и опорность стоп. Их задаёт таймлайн клипа, а не поза на манекене. */
export const MOTION_CHANNELS: readonly string[] = [ROOT_YAW, ROOT_POS, SWING_KEY];
/**
 * ЗАСЕЯТЬ КАНАЛЫ ДВИЖЕНИЯ в позу нового/заменённого ключа — значением клипа на времени `t` (зовётся ДО вставки/замены).
 *
 * ⚠ «+ кадр» вставлял `readPoseFull()` без `__rootY`/`__swing`, а бленд считает отсутствующий канал нулём
 * (`blendTwo`): на вставленном ключе поворот клипа проваливался в 0 — и в игре (`turnYawAt`), и теперь на виду
 * в редакторе. «◀ из пред.» / «из след. ▶» / «середина» копировали корень СОСЕДА. Каналы, которых клип не несёт, не добавляем.
 */
export function seedMotionChannels(fresh: Pose, c: Clip, t: number): Pose {
  const has = MOTION_CHANNELS.filter((k) => c.keys.some((kf) => kf.pose[k]));
  if (!has.length) return fresh;
  const at = clipPoseAt(c, clamp01(t / (clipDur(c) || 1)));
  for (const k of has) { const v = at[k]; if (v) fresh[k] = [v[0], v[1], v[2]]; }
  return fresh;
}
