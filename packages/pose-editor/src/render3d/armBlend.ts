/**
 * ⭐⭐ КАК КЛИП ХОДА И АВТОРСКАЯ СТОЙКА ДЕЛЯТ ВЕРХ ТЕЛА: якорь + аддитивный мах.
 *
 * Жалоба автора (19.09): «в анимациях он нормально машет руками; в игре, когда беру меч, почти перестаёт. Надо,
 * чтобы мах оставался, но не такой сильный, и если в левой руке ничего нет — чтобы она махала нормально. Должна
 * браться анимация бега и подмешиваться каждая рука в зависимости от того, что в ней».
 *
 * ⚠⚠ ПРИЧИНА БЫЛА В ОПЕРАТОРЕ, А НЕ В ЧИСЛЕ. Раньше рука собиралась как `slerp(клип(t), стойка, hw)`. Стойка
 * СТАТИЧНА, поэтому слерп к ней не сдвигает руку, а СЖИМАЕТ ВСЮ ДУГУ МАХА в `(1 − hw)` раз: у слерпа амплитуда и
 * смещение — один и тот же параметр, и «махать вполсилы, держа меч как настроено» им выразить нечем в принципе.
 * ЗАМЕР (`parityHarness.test.ts`, процедурный набор, бег 120 u/с, мировой размах плеча): клип 56.5°, доля 0.5 —
 * 19.8°, доля 0.2 (умолчание под мечом) — **6.2°**. Настройкой это не лечилось.
 *
 * ⭐ РЕШЕНИЕ — ТО ЖЕ, ЧТО В ИНДУСТРИИ: аддитивный слой (Unreal `Make Additive` / `Apply Additive`, аддитивный слой
 * Animator в Unity). Мах берётся как ДЕЛЬТА клипа к его собственной нейтрали и кладётся ПРАВЫМ УМНОЖЕНИЕМ поверх
 * якоря; дельта, наложенная умножением, дугу сжать не может по построению.
 *
 *   Δswing = ref⁻¹ · клип(t)               мах как дельта к нейтрали КЛИПА
 *   anchor = slerp(ref, стойка, a)         ГДЕ живёт покой руки: нейтраль клипа ↔ авторская стойка
 *   out    = anchor · slerp(I, Δswing, k)  мах аддитивно, с масштабом k
 *
 * Два числа, потому что автор просит две РАЗНЫЕ вещи: «оружие держится как я настроил» (это `a`) и «мах остаётся, но
 * не такой сильный» (это `k`). Одной ручкой они отбирают друг у друга — что и было.
 *
 * ОБА КОНЦА ТОЧНЫ ПО ПОСТРОЕНИЮ, а не по настройке:
 *   `a=0, k=1` → `ref · ref⁻¹ · клип = клип` — поза клипа БИТ В БИТ (это и есть «1 в 1 как во вкладке Анимация»);
 *   `a=1, k=0` → `стойка` — авторская стойка бит в бит, на бегу, с хватом;
 *   `a=1, k=0.5` → «держит оружие как поставил автор и машет вполсилы» — дословная просьба;
 *   амплитуда от `a` НЕ ЗАВИСИТ ВОВСЕ: она целиком в члене `slerp(I, Δswing, k)`.
 * Пустая рука — `a=0, k=1` без единой записи в конфиге, то есть машет ровно как в клипе.
 *
 * ⚠ НЕЙТРАЛЬ — СРЕДНЯЯ ПОЗА ЦИКЛА, А НЕ КАДР 0 И НЕ ЖИВОЕ ОКНО. Кадр 0 — это одна из крайних точек маха (замер:
 * снос до 39°), а нейтраль, посчитанная по ЖИВОМУ окну, компенсирует сама себя — рука застывает. Та же грабля уже
 * расписана у аддитива предметов: `resolveStancePose` берёт референс на ЗАМОРОЖЕННОМ `t=0` (`poseLayers.ts`).
 *
 * ⚠ НЕЙТРАЛЬ СЧИТАЕТСЯ ЛЕНИВО И КЭШИРУЕТСЯ НА КЛИПЕ. Так шов работает на УЖЕ опубликованных клипах, до того как
 * автор нажал «перезапечь набор»: правка рантайма развязана с перезапеканием, и проверить её глазами можно сразу.
 * Запечённое поле `Clip.swingRef` (когда появится) бьёт ленивый расчёт — оно снято на плотном потоке, а не на 24
 * сэмплах прореженного клипа.
 *
 * Модуль ЧИСТЫЙ (кватернионы и позы, без сцены и DOM) — тестируется в node.
 */
import * as THREE from 'three';
import { clipPoseAt, isAngleKey, type Clip, type Pose } from './clipModel.js';

/** Кости, у которых есть нейтраль маха. Ноги и таз сюда НЕ входят: ими клип владеет целиком, делить нечего. */
export const SWING_BONES: readonly string[] = [
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand',
  'Chest', 'UpperChest', 'Neck', 'Head',
];
/** Сколько сэмплов берётся на ленивую нейтраль. 24 — цикл ходьбы/бега (11–13 ключей) снимается с запасом. */
const REF_SAMPLES = 24;

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const qOf = (v: readonly [number, number, number], out: THREE.Quaternion): THREE.Quaternion =>
  out.setFromEuler(_e.set(v[0], v[1], v[2], 'XYZ'));
const eOf = (q: THREE.Quaternion): [number, number, number] => { _e.setFromQuaternion(q, 'XYZ'); return [_e.x, _e.y, _e.z]; };

/**
 * Среднее нескольких поз (кватернионное, со сведением знака).
 * ⚠ ЗНАК СВОДИТСЯ ОБЯЗАТЕЛЬНО: `q` и `−q` — один поворот, но покомпонентное среднее противоположных знаков даёт ноль,
 * то есть «нейтраль» уехала бы в тождество, а мах — на 90° мимо.
 */
export function meanPose(poses: readonly Pose[], bones: readonly string[] = SWING_BONES): Pose {
  const out: Pose = {};
  for (const nm of bones) {
    let acc: THREE.Quaternion | null = null, n = 0;
    for (const p of poses) {
      const v = p[nm]; if (!v) continue;
      qOf(v, _q);
      if (!acc) { acc = _q.clone(); n = 1; continue; }
      if (acc.dot(_q) < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
      n++;
      acc.set(acc.x + (_q.x - acc.x) / n, acc.y + (_q.y - acc.y) / n, acc.z + (_q.z - acc.z) / n, acc.w + (_q.w - acc.w) / n);
    }
    if (acc) out[nm] = eOf(acc.normalize());
  }
  return out;
}

/**
 * НЕЙТРАЛЬ МАХА клипа: запечённое поле либо ленивое среднее по циклу (кэш на самом клипе).
 * ⚠ Кэш — `WeakMap` по объекту клипа: библиотека пересоздаёт объекты при загрузке и правке, и кэш по ИМЕНИ пережил бы
 * правку клипа, отдавая нейтраль от прошлой версии.
 */
let _refCache = new WeakMap<object, Pose>();
export function swingRefOf(clip: Clip): Pose {
  if (clip.swingRef) return clip.swingRef;
  let r = _refCache.get(clip);
  if (!r) {
    const poses: Pose[] = [];
    for (let i = 0; i < REF_SAMPLES; i++) poses.push(clipPoseAt(clip, i / REF_SAMPLES));
    r = meanPose(poses);
    _refCache.set(clip, r);
  }
  return r;
}

/** Забыть ленивые нейтрали (тесты и перезапекание: клип правится на месте — объект тот же, содержимое другое). */
export function clearSwingRefCache(clip?: Clip): void {
  if (clip) _refCache.delete(clip); else _refCache = new WeakMap<object, Pose>();
}

export interface ArmWeights {
  /** ГДЕ покой: 0 — нейтраль клипа, 1 — авторская стойка. Амплитуду НЕ трогает. */
  a: number;
  /** СКОЛЬКО маха: 0 — рука стоит в якоре, 1 — полная дуга клипа. */
  k: number;
}
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * ⭐ ОДНА КОСТЬ: якорь + аддитивный мах. Возвращает эйлер, как и весь остальной конвейер поз.
 *
 * `ref`/`loco` — поза нейтрали и поза клипа этого кадра; `stance` — авторская стойка (нет её — якорем работает `ref`,
 * то есть `a` теряет смысл и остаётся только масштаб маха; именно так идут куклы без авторской стойки).
 *
 * ⚠ НЕУГЛОВЫЕ КЛЮЧИ (`__hipsD`, `__wpnMainP`…) — ЛИНЕЙНО: у смещения нет «дельты поворотом», и прогон его через
 * кватернион дал бы бессмыслицу. Признак — общий `isAngleKey` из `clipModel`, второй копии правила заводить нельзя.
 */
export function blendArmKey(key: string, ref: readonly [number, number, number] | undefined,
  loco: readonly [number, number, number] | undefined,
  stance: readonly [number, number, number] | undefined,
  w: ArmWeights): [number, number, number] | undefined {
  const a = clamp01(w.a), k = clamp01(w.k);
  if (!loco && !stance) return undefined;              // клип кость не ведёт и стойка её не знает — не трогаем
  // ⚠⚠ НЕТ ПОЗЫ КЛИПА — НЕТ И НЕЙТРАЛИ. Она снята с ЦЕЛОГО набора и несёт руки даже тогда, когда конкретный клип их
  // не ведёт (импортный пак часто несёт только ноги; запечённый набор несёт `swingRef` полем, а каналы рук у него
  // могли быть сняты). Прочитай её здесь — и рука уехала бы в беговую несущую позу вместо авторской стойки
  // (ЗАМЕР до правки: 51.9° от позы стоя). Нейтраль имеет смысл ТОЛЬКО как опора для дельты этого же клипа.
  const R = (loco ? ref : undefined) ?? loco ?? stance!;
  const L = loco ?? R;
  const S = stance ?? R;
  if (!isAngleKey(key)) {
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) { const anchor = R[i]! + (S[i]! - R[i]!) * a; out[i] = anchor + (L[i]! - R[i]!) * k; }
    return out;
  }
  // anchor = slerp(ref, стойка, a)
  const anchor = qOf(R, _q).clone();
  if (a > 0) anchor.slerp(qOf(S, _q2), a);
  if (k <= 0) return eOf(anchor);
  // Δswing = ref⁻¹ · клип; out = anchor · slerp(I, Δswing, k)
  const d = qOf(R, _q).invert().multiply(qOf(L, _q2));
  // ⚠ КОРОТКАЯ ДУГА: у `slerp` от тождества знак дельты решает, пойдёт ли она «через ноль» или кругом. На махе 56–100°
  // это разница между «рука машет» и «рука выворачивается назад». `THREE.Quaternion.slerp` сам знак НЕ сводит.
  if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
  if (k < 1) _q2.set(0, 0, 0, 1).slerp(d, k); else _q2.copy(d);
  return eOf(anchor.multiply(_q2));
}

/**
 * Весь верх разом: для каждой кости из `bones` берётся своя пара весов.
 * `out` дополняет позу на месте (остальные ключи не трогаются) — её дальше кладёт `applyUpper` по костям.
 */
export function blendArms(ref: Pose, loco: Pose, stance: Pose | null, weightOf: (bone: string) => ArmWeights,
  bones: readonly string[] = SWING_BONES, out: Pose = {}): Pose {
  for (const nm of bones) {
    const v = blendArmKey(nm, ref[nm], loco[nm], stance?.[nm], weightOf(nm));
    if (v) out[nm] = v;
  }
  return out;
}
