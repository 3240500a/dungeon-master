/**
 * ПРЕДЕЛЫ СУСТАВА, ВЕРСИЯ 2 — ПОРТ **FinalIK `RotationLimit`** (RootMotion), один-в-один по структуре.
 *
 * ЗАЧЕМ ВТОРАЯ ВЕРСИЯ. Первая (`jointDof.ts`) хранила позу СКАЛЯРАМИ и пересобирала кватернион из них. Из этого
 * подхода вылезала бесконечная череда артефактов, и каждый чинился новым слоем: эйлер → гимбал-лок в рабочей позе
 * плеча; swing-twist со скалярами → при подъёме руки кость КРУТИЛО ВОКРУГ СВОЕЙ ОСИ до 60° (замер), потому что
 * удержание скаляра твиста вдоль дуги свинга — это не «нет крена», а голономия.
 *
 * ЗДЕСЬ ДРУГОЙ ПРИНЦИП, тот, которого юзер и просил: **поза — это кватернион, гизмо крутит кость СВОБОДНО, а
 * предел ТОЛЬКО ОСТАНАВЛИВАЕТ.** Никаких скаляров как источника истины, никакой пересборки. Предел — ПРОЕКЦИЯ:
 *   свинг за конусом → ось кости подтягивается к границе, ТВИСТ НЕ ТРОГАЕТСЯ (коррекция домножается СЛЕВА);
 *   твист за диапазоном → кость откручивается вокруг своей оси, ОСЬ НЕ ТРОГАЕТСЯ.
 * Ровно так устроен FinalIK, и там же сказано, почему без эйлера: «all rotation limits are quaternion and
 * axis-angle based to ensure consistency, continuity and minimize singularity issues».
 *
 * ИСХОДНИК (сверено дословно):
 *   `RotationLimit.LimitTwist`  — normal/orthoTangent/OrthoNormalize/FromToRotation/RotateTowards;
 *   `RotationLimit.Limit1DOF`   — `FromToRotation(rotation * axis, axis) * rotation`;
 *   `RotationLimitAngle.LimitSwing` — swingAxis → FromToRotation → RotateTowards(identity, …, limit) → toLimits;
 *   `RotationLimitHinge.LimitHinge` — Limit1DOF + НАКОПИТЕЛЬ `lastAngle`/`lastRotation` (у них он есть, и именно
 *   он даёт «additive limits exceeding 360°» и отсутствие перескоков).
 *
 * ДВЕ ОСОЗНАННЫЕ ПРАВКИ ПОД НАШИ ДАННЫЕ (у FinalIK пределы СИММЕТРИЧНЫ, у нас — нет):
 *   1) свинг: вместо одного угла `limit` — АСИММЕТРИЧНЫЙ бокс `[planeMin..planeMax] × [normalMin..normalMax]`.
 *      Допустимый угол считается ПО НАПРАВЛЕНИЮ свинга (граница прямоугольника) — ровно та зона, которую рисует
 *      `poseLimitGizmo`. Дальше всё как у них: `RotateTowards` + `toLimits` слева.
 *   2) твист: вместо `±twistLimit` — `[twistMin..twistMax]`, поэтому финальный `RotateTowards` заменён на точный
 *      знаковый клэмп относительно их же `fixedRotation` (позы с нулевым твистом). При симметричных пределах
 *      поведение совпадает с оригиналом.
 *
 * Рест-фрейм наших костей = identity, поэтому их `GetLimitedLocalRotation` (`inverse(defaultLocalRotation) * q`)
 * вырождается в «клэмпим локальный кватернион напрямую».
 *
 * Чистый модуль: только THREE + структурный тип предела (тип импортится type-only → node-тесты не тянут DOM).
 */
import * as THREE from 'three';
import type { LimitView } from './humanoidRagdoll.js';

const V = (a: readonly number[] | undefined, d: [number, number, number]): THREE.Vector3 =>
  new THREE.Vector3(a?.[0] ?? d[0], a?.[1] ?? d[1], a?.[2] ?? d[2]).normalize();

const _n = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _sa = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _id = new THREE.Quaternion();

/** `Vector3.OrthoNormalize(ref normal, ref tangent)` — тангенс становится единичным и перпендикулярным нормали. */
function orthoNormalize(normal: THREE.Vector3, tangent: THREE.Vector3): void {
  normal.normalize();
  tangent.addScaledVector(normal, -normal.dot(tangent));
  if (tangent.lengthSq() < 1e-12) tangent.copy(anyPerp(normal)); else tangent.normalize();
}
function anyPerp(d: THREE.Vector3): THREE.Vector3 {
  const t = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  return t.addScaledVector(d, -t.dot(d)).normalize();
}
/** Знаковый угол от `a` к `b` вокруг `normal` (оба уже ортонормированы к normal). */
function signedAngle(a: THREE.Vector3, b: THREE.Vector3, normal: THREE.Vector3): number {
  const c = Math.min(1, Math.max(-1, a.dot(b)));
  const s = _sa.crossVectors(a, b).dot(normal);
  return Math.atan2(s, c);
}
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * `RotationLimitAngle.LimitSwing`, обобщённый на асимметричный бокс.
 * Коррекция `toLimits` домножается СЛЕВА (в фрейме родителя) — поэтому она двигает ТОЛЬКО ось кости и физически
 * не может изменить твист. Это и есть «предел просто не даёт согнуться дальше».
 */
export function limitSwing(q: THREE.Quaternion, view: LimitView): THREE.Quaternion {
  const axis = V(view.twist, [1, 0, 0]), P = V(view.plane, [0, 1, 0]), N = V(view.normal, [0, 0, 1]);
  const swingAxis = axis.clone().applyQuaternion(q);
  const swingRotation = _q1.setFromUnitVectors(axis, swingAxis);
  const ang = 2 * Math.acos(Math.min(1, Math.abs(swingRotation.w)));
  if (ang < 1e-7) return q.clone();
  // направление свинга в осях (plane, normal) → допустимый угол = граница ПРЯМОУГОЛЬНИКА в этом направлении
  _sa.set(swingRotation.x, swingRotation.y, swingRotation.z).normalize();
  const u = _sa.dot(P), v = _sa.dot(N);
  const limU = u >= 0 ? (view.planeMax ?? 0) : -(view.planeMin ?? 0);
  const limV = v >= 0 ? (view.normalMax ?? 0) : -(view.normalMin ?? 0);
  const tU = Math.abs(u) > 1e-6 ? Math.max(0, limU) / Math.abs(u) : Infinity;
  const tV = Math.abs(v) > 1e-6 ? Math.max(0, limV) / Math.abs(v) : Infinity;
  const maxAng = Math.min(tU, tV);
  if (!(ang > maxAng)) return q.clone();
  const limited = _q2.copy(_id.identity()).rotateTowards(swingRotation, maxAng);   // Quaternion.RotateTowards
  const toLimits = new THREE.Quaternion().setFromUnitVectors(swingAxis, axis.clone().applyQuaternion(limited));
  return toLimits.multiply(q);
}

/**
 * `RotationLimit.LimitTwist` — каркас их, ОПОРА заменена (см. ниже). Асимметричный диапазон.
 * Строим их `fixedRotation` (поза с НУЛЕВЫМ твистом), меряем знаковый твист, зажимаем — коррекция идёт вокруг
 * `normal = q·axis`, то есть вокруг ТЕКУЩЕЙ оси кости, и ось кости не двигает.
 *
 * ⚠ ОТЛИЧИЕ ОТ ОРИГИНАЛА, куплено падающим тестом. FinalIK берёт опорой ПРОЕКЦИЮ рест-оси на плоскость ⊥ кости
 * (`OrthoNormalize(ref normal, ref orthoTangent)`). У этой опоры ВЫРОЖДЕНИЕ, когда кость смотрит вдоль самой
 * опорной оси, — а наше плечо туда дотягивается (предел подъёма 108.9°, сгиба 97.4°, обе оси достижимы). ЗАМЕР:
 * подъём руки на 90° из позы «вперёд 30° + твист 35°» давал 88° крена на ровном месте. У FinalIK это почти не
 * стреляет, потому что там `twistLimit = 180` по умолчанию, т.е. предел твиста выключен; у нас он всегда включён.
 * ОПОРА ЗДЕСЬ — рест-тангенс, перенесённый МИНИМАЛЬНОЙ ДУГОЙ `rest → текущая ось` (это и есть параллельный перенос
 * вдоль геодезической, то же, что даёт swing-twist разложение). Вырождение только при свинге 180° — недостижимо.
 */
export function limitTwist(q: THREE.Quaternion, view: LimitView): THREE.Quaternion {
  const axis = V(view.twist, [1, 0, 0]), ortho = V(view.plane, [0, 1, 0]);
  const lo = view.twistMin ?? 0, hi = view.twistMax ?? 0;
  _n.copy(axis).applyQuaternion(q);
  _q1.setFromUnitVectors(axis, _n);                              // минимальная дуга rest → текущая ось
  _t1.copy(ortho).applyQuaternion(_q1); orthoNormalize(_n, _t1); // опора: перенесённый рест-тангенс
  _t2.copy(ortho).applyQuaternion(q); orthoNormalize(_n, _t2);   // rotatedOrthoTangent (как у них)
  const ang = signedAngle(_t1, _t2, _n);
  const cl = clamp(ang, lo, hi);
  if (Math.abs(cl - ang) < 1e-9) return q.clone();
  const fixed = new THREE.Quaternion().setFromUnitVectors(_t2, _t1).multiply(q);   // FinalIK fixedRotation
  return new THREE.Quaternion().setFromAxisAngle(_n, cl).multiply(fixed);
}

/** `RotationLimit.Limit1DOF` — выбросить всё, кроме вращения вокруг `axis`. */
export function limit1DOF(q: THREE.Quaternion, axis: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(axis.clone().applyQuaternion(q), axis).multiply(q);
}

/** Состояние шарнира (их `lastAngle`/`lastRotation`) — по кости. Даёт накопление за 360° и упор без перескока. */
interface HingeMem { lastAngle: number; lastRaw: number }
const hingeMem = new WeakMap<object, HingeMem>();
/** Забыть накопитель шарнира (смена клипа/сброс позы). */
export function forgetHinge(key: object): void { hingeMem.delete(key); }

const TAU = Math.PI * 2;
const wrapPi = (a: number): number => { const x = (a + Math.PI) % TAU; return (x < 0 ? x + TAU : x) - Math.PI; };
/** Ближайшая по ДУГЕ граница (Blender `clamp_angle`) — фолбэк, когда накопителя нет (не-интерактивные вызовы). */
function clampArc(a: number, lo: number, hi: number): number {
  if (a >= lo && a <= hi) return a;
  return Math.abs(wrapPi(a - lo)) <= Math.abs(wrapPi(a - hi)) ? lo : hi;
}

/**
 * `RotationLimitHinge.LimitHinge` дословно (`addR = free1DOF · lastRotation⁻¹`, знак через cross, `lastAngle`
 * копится и зажимается). `key` — сама кость; без ключа накопителя нет и берётся клэмп по дуге (солверы зовут
 * предел по нескольку раз за проход, и их итерации накопителю мерещились бы «движениями мыши»).
 */
export function limitHinge(q: THREE.Quaternion, view: LimitView, key?: object): THREE.Quaternion {
  const axis = V(view.axis, [0, 1, 0]);
  const lo = view.min ?? 0, hi = view.max ?? 0;
  if (lo === 0 && hi === 0) return new THREE.Quaternion();
  const free = limit1DOF(q, axis);
  // сырой угол сгиба ∈ (−π, π]
  const sec = new THREE.Vector3(axis.z, axis.x, axis.y);
  _t1.copy(sec); _n.copy(axis); orthoNormalize(_n, _t1);
  _t2.copy(sec).applyQuaternion(free); _n.copy(axis); orthoNormalize(_n, _t2);
  const raw = signedAngle(_t1, _t2, axis);
  const mem = key ? hingeMem.get(key) : undefined;
  if (!mem) {
    const a = clampArc(raw, lo, hi);
    if (key) hingeMem.set(key, { lastAngle: a, lastRaw: raw });
    return new THREE.Quaternion().setFromAxisAngle(axis, a);
  }
  // ⚠ ОТЛИЧИЕ ОТ ОРИГИНАЛА, куплено замером. FinalIK берёт шаг как `Angle(identity, free1DOF · lastRotation⁻¹)`,
  // а этот угол всегда ≤180° и на обороте ввода МЕНЯЕТ ЗНАК: при перекруте локтя на 300° в один драг сустав
  // разворачивался обратно и уезжал с упора −137.5° до −77.5°. Шаг считаем РАЗВЁРТКОЙ сырого угла (кратчайший
  // шаг от прошлого сырого) — это устойчиво, пока кадровый шаг < 180°, а мышь столько за кадр не проходит.
  const step = wrapPi(raw - mem.lastRaw);
  const a = clamp(mem.lastAngle + step, lo, hi);
  mem.lastAngle = a; mem.lastRaw = raw;
  return new THREE.Quaternion().setFromAxisAngle(axis, a);
}

/**
 * ГЛАВНЫЙ ВХОД: зажать ЛОКАЛЬНЫЙ кватернион кости к пределу сустава (`RotationLimitAngle.LimitRotation`:
 * сперва свинг, потом твист). Возвращает НОВЫЙ кватернион, вход не мутируется.
 */
export function limitLocalV2(q: THREE.Quaternion, view: LimitView, key?: object): THREE.Quaternion {
  if (view.kind === 'hinge') return limitHinge(q, view, key);
  return limitTwist(limitSwing(q, view), view);
}
