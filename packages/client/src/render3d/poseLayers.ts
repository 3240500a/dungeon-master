/**
 * СЛОИ ПОЗЫ: аддитивные оверлеи предметов поверх ОДНОЙ безоружной базы (Ф1.1).
 *
 * Зачем. Сегодня стойка — полная поза на КАЖДЫЙ ключ оружия: `idle_sword`, `idle_sword+shield`,
 * `idle_axe+dagger`, … Комбинаций рук больше, чем можно заавторить руками, поэтому половина ключей
 * пустует (дуал вообще остаётся без стойки — клип назван `idle_dual`, а игра ищет `idle_sword+dagger`),
 * а щит прибит отдельным захардкоженным оверлеем.
 *
 * Как в индустрии. Поза предмета хранится не сама по себе, а как ДЕЛЬТА к базовой:
 * `Δмеч = стойка_с_мечом − базовая_безоружная`. Дельты складываются, поэтому «меч + щит» не нужно
 * авторить — оно получается из Δмеч (правая рука) и Δщит (левая). В Unreal это `Make Additive` +
 * `Apply Additive` с альфой, в Unity — Additive-слой; альфа и есть «сила смешивания» ползунком.
 *
 * Почему аддитивно, а не бленд. Бленд двух рук дерётся на общих костях (корпус): вторая рука
 * затирает первую. Дельта не зависит от того, что под ней, — один и тот же оверлей меча ложится
 * и на idle, и на ходьбу, и на бег.
 *
 * ГЛАВНОЕ СВОЙСТВО, ради которого выбрана именно правая дельта (`Δ = base⁻¹ · item`):
 * наложение Δ предмета на его же базу возвращает АВТОРСКУЮ позу предмета бит в бит. То есть
 * «собрано из слоёв» и «заавторено целиком» совпадают, пока предмет один. Это и проверяет тест.
 *
 * Файл ЧИСТЫЙ (только математика поз и маски) — тестируется в node.
 */
import * as THREE from 'three';
import { blendTwo, isAngleKey, type Pose } from './clipModel.js';
import { boneWeight, type BoneMask } from './boneMask.js';

/** Двуручное держится ОБЕИМИ руками: его поза — не добавка к свободной руке, а другой верх целиком. */
export const TWO_HANDED = new Set(['greatsword', 'greataxe', 'greatmaul', 'halberd', 'spear', 'staff', 'bow', 'crossbow']);
export const isTwoHanded = (item: string): boolean => TWO_HANDED.has(item);

/** Ключ оружия → [главная рука, офф-рука]. `sword+shield` → ['sword','shield']; `axe` → ['axe','none']. */
export function splitHands(weapon: string): [string, string] {
  const w = weapon === 'dual' ? 'sword+dagger' : weapon;      // легаси-ключ дуала
  const i = w.lastIndexOf('+');
  return i > 0 ? [w.slice(0, i), w.slice(i + 1)] : [w, 'none'];
}

export type LayerKind = 'additive' | 'override';
export interface PoseLayer {
  /** Авторская поза предмета (полная). */
  pose: Pose;
  /** База, ОТНОСИТЕЛЬНО которой считается дельта. Для `override` не нужна. */
  base?: Pose;
  mask: BoneMask;
  /** Сила подмешивания 0..1 — та самая ручка. */
  weight: number;
  kind: LayerKind;
}

const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qD = new THREE.Quaternion(), _qI = new THREE.Quaternion();
const _eT = new THREE.Euler();
const q = (e: readonly [number, number, number], out: THREE.Quaternion): THREE.Quaternion =>
  out.setFromEuler(_eT.set(e[0], e[1], e[2], 'XYZ'));
const toEuler = (qq: THREE.Quaternion): [number, number, number] => {
  _eT.setFromQuaternion(qq, 'XYZ');
  return [_eT.x, _eT.y, _eT.z];
};
const ZERO: [number, number, number] = [0, 0, 0];

/**
 * Дельта одной кости: `Δ = base⁻¹ · item` для углов, простая разность для позиций и скаляров.
 * Ключ есть только у предмета (база про него не знает) — дельта считается от нуля.
 */
function keyDelta(key: string, item: readonly [number, number, number], base: readonly [number, number, number]): [number, number, number] {
  if (!isAngleKey(key)) return [item[0] - base[0], item[1] - base[1], item[2] - base[2]];
  q(base, _qB).invert().multiply(q(item, _qA));
  return toEuler(_qB);
}

/** Наложить дельту кости с весом `w`: углы — правым умножением на slerp(1, Δ, w), остальное — сложением. */
function keyAdd(key: string, cur: readonly [number, number, number], delta: readonly [number, number, number], w: number): [number, number, number] {
  if (w <= 0) return [cur[0], cur[1], cur[2]];
  if (!isAngleKey(key)) return [cur[0] + delta[0] * w, cur[1] + delta[1] * w, cur[2] + delta[2] * w];
  _qI.identity().slerp(q(delta, _qD), Math.min(1, w));
  return toEuler(q(cur, _qA).multiply(_qI));
}

/** Бленд кости к целевой позе с весом (для `override`-слоёв: двуручное, лук). */
function keyBlend(key: string, cur: readonly [number, number, number], to: readonly [number, number, number], w: number): [number, number, number] {
  if (w <= 0) return [cur[0], cur[1], cur[2]];
  if (!isAngleKey(key)) return [cur[0] + (to[0] - cur[0]) * w, cur[1] + (to[1] - cur[1]) * w, cur[2] + (to[2] - cur[2]) * w];
  return toEuler(q(cur, _qA).slerp(q(to, _qB), Math.min(1, w)));
}

/** Вес ключа в маске. Спец-ключи (`__wpnMain`, `__hipsD`…) костями не являются — им маска не мешает. */
const maskW = (mask: BoneMask, key: string): number => (key.startsWith('__') ? 1 : boneWeight(mask, key));

/**
 * Собрать стойку: база плюс слои по порядку.
 *
 * Порядок — это контракт: главная рука кладётся раньше офф-руки, поэтому на общих костях корпуса
 * офф-рука досыпает свою долю поверх, а не затирает (в этом весь смысл аддитива).
 */
export function composeStance(base: Pose, layers: readonly PoseLayer[]): Pose {
  const out: Pose = {};
  for (const k in base) out[k] = [...base[k]!] as [number, number, number];
  for (const L of layers) {
    if (L.weight <= 0) continue;
    if (L.kind === 'override') {
      for (const k in L.pose) {
        const w = maskW(L.mask, k) * L.weight;
        if (w <= 0) continue;
        out[k] = keyBlend(k, out[k] ?? L.pose[k]!, L.pose[k]!, w);
      }
      continue;
    }
    const lb = L.base ?? base;
    for (const k in L.pose) {
      const w = maskW(L.mask, k) * L.weight;
      if (w <= 0) continue;
      const d = keyDelta(k, L.pose[k]!, lb[k] ?? ZERO);
      out[k] = keyAdd(k, out[k] ?? lb[k] ?? ZERO, d, w);
    }
  }
  return out;
}

// ── Маски рук ────────────────────────────────────────────────────────────────────────────────────
// Главное оружие крепится к `RightHand`, щит/второе оружие — к `LeftHand` (`weapon3d.attachWeapons`).
// Затухание на корпус небольшое: предмет ведёт руку, а корпус лишь слегка подворачивается за ней —
// иначе два оверлея вдвоём перекрутят грудь.
export const ARM_MAIN_MASK: BoneMask = { parts: {}, weights: { RightShoulder: 1, RightUpperArm: 1, RightLowerArm: 1, RightHand: 1, UpperChest: 0.25, Chest: 0.15, Spine: 0.08 } };
export const ARM_OFF_MASK: BoneMask = { parts: {}, weights: { LeftShoulder: 1, LeftUpperArm: 1, LeftLowerArm: 1, LeftHand: 1, UpperChest: 0.25, Chest: 0.15, Spine: 0.08 } };
/** Двуручное владеет верхом целиком — маска на обе руки и корпус. */
export const UPPER_ALL_MASK: BoneMask = { parts: {}, weights: {
  RightShoulder: 1, RightUpperArm: 1, RightLowerArm: 1, RightHand: 1,
  LeftShoulder: 1, LeftUpperArm: 1, LeftLowerArm: 1, LeftHand: 1,
  UpperChest: 1, Chest: 1, Spine: 0.5,
} };

/**
 * Поза предмета, заавторенного как ОСНОВНОЕ оружие, — в роли офф-руки.
 *
 * Хват лежит в `__wpnMain`/`__wpnMainP`, потому что при авторинге предмет был единственным и висел
 * на главной руке. В офф-руке его группа — вторая, и читается она из `__wpnOff`. Без переименования
 * кинжал в левой руке забрал бы хват меча в правой. Тот же трюк уже делает щит-оверлей.
 */
export function asOffHandPose(pose: Pose): Pose {
  if (pose['__wpnOff'] || pose['__wpnOffP']) return pose;      // уже заавторено как офф — не трогаем
  const out: Pose = {};
  for (const k in pose) {
    const nk = k === '__wpnMain' ? '__wpnOff' : k === '__wpnMainP' ? '__wpnOffP' : k;
    out[nk] = pose[k]!;
  }
  return out;
}

/** Как достать авторскую позу: вид стойки + ключ предмета («none» = безоружная база). */
export type StanceLookup = (kind: 'idle' | 'combat_idle', item: string) => Pose | null;

/**
 * СТОЙКА ПОД ЭКИПИРОВКУ — одна реализация на игру и редактор (правило «редактор ≡ игра»).
 *
 * Порядок решения:
 *  1. Есть авторская поза РОВНО на этот ключ (`idle_sword+shield`) — берём её. Явное намерение автора
 *     всегда сильнее сборки, и старые данные продолжают работать бит в бит.
 *  2. Нет — собираем: безоружная база + дельта предмета главной руки + дельта предмета офф-руки.
 *     Двуручное кладётся `override`-ом на весь верх, и офф-рука тогда не участвует — она занята.
 *  3. Нет даже безоружной базы — возвращаем то, что найдётся по ключу/базовому оружию, иначе null
 *     (как было до слоёв: полный процедурный мах).
 */
export function resolveStancePose(
  find: StanceLookup,
  weapon: string,
  combat: number,
  weightOf: (item: string) => number = () => 1,
): Pose | null {
  const one = (kind: 'idle' | 'combat_idle'): Pose | null => {
    const exact = find(kind, weapon);
    if (exact) return exact;                                  // 1. авторская на точный ключ
    const base = find(kind, 'none') ?? (kind === 'idle' ? null : find('idle', 'none'));
    const [m, o] = splitHands(weapon);
    if (!base) return find(kind, m);                          // 3. базы нет — старое поведение
    const layers: PoseLayer[] = [];
    const two = isTwoHanded(m);
    const mp = m !== 'none' ? (find(kind, m) ?? find('idle', m)) : null;
    if (mp) layers.push({ pose: mp, base, mask: two ? UPPER_ALL_MASK : ARM_MAIN_MASK, weight: weightOf(m), kind: two ? 'override' : 'additive' });
    if (!two && o !== 'none') {
      const op = find(kind, o) ?? find('idle', o);
      if (op) layers.push({ pose: asOffHandPose(op), base, mask: ARM_OFF_MASK, weight: weightOf(o), kind: 'additive' });
    }
    return layers.length ? composeStance(base, layers) : base;   // 2. сборка (нет предметов → чистая база)
  };
  const relaxed = one('idle');
  if (!relaxed || combat <= 0.001) return relaxed;
  const fight = one('combat_idle');
  return fight ? blendTwo(relaxed, fight, combat) : relaxed;
}
