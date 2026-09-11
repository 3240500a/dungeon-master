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
import { blendTwo, clipPoseAt, isAngleKey, type Pose } from './clipModel.js';
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

/**
 * Поза стойки на момент `t` (сек).
 *
 * Один кадр — держим его, как было всегда. Несколько — стойка ЖИВАЯ и играет циклом: дышит,
 * переминается. Раньше это было физически невозможно — резолвер брал `keys[0]` и на этом всё,
 * поэтому импортированный из FBX idle показывал ровно первый кадр и выглядел как «создалась
 * копия в один кадр».
 */
export function stancePoseAt(clip: { keys: { pose: Pose; t: number }[] }, t = 0): Pose | null {
  const n = clip.keys.length;
  if (!n) return null;
  const dur = clip.keys[n - 1]!.t;
  if (n === 1 || dur <= 1e-4 || !Number.isFinite(t)) return clip.keys[0]!.pose;
  const u = ((t % dur) + dur) % dur / dur;
  return clipPoseAt(clip as never, u);
}

/** Как достать авторскую позу: вид стойки + ключ предмета («none» = безоружная база) + время (сек). */
export type StanceLookup = (kind: 'idle' | 'combat_idle', item: string, t: number) => Pose | null;

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
export interface StanceOpts {
  /** Сила подмешивания предмета 0..1. Нет → 1. */
  weight?: (item: string) => number;
  /** Тип оверлея. Нет → двуручное `override`, остальное `additive`. */
  kind?: (item: string) => LayerKind;
  /** Рука предмета, если задана ЯВНО (факел в левой при пустой правой). Нет → по позиции в ключе. */
  hand?: (item: string) => 'main' | 'off' | undefined;
  /**
   * Куда сложить РЕАЛЬНЫЙ состав стойки — для инспектора слоёв. Массив очищается и заполняется здесь,
   * потому что пересчитывать состав на стороне инспектора значит завести вторую правду: она разойдётся
   * с первой ровно в тот день, когда правила сборки поменяются, и врать будет именно окно отладки.
   */
  trace?: StanceLayerInfo[];
}
/** Один подмешанный предмет: что, в какую руку, чем и с какой силой. */
export interface StanceLayerInfo { item: string; hand: 'main' | 'off'; kind: LayerKind; weight: number }

export function resolveStancePose(
  find: StanceLookup,
  weapon: string,
  combat: number,
  opts: StanceOpts = {},
  t = 0,
): Pose | null {
  const weightOf = opts.weight ?? ((): number => 1);
  if (opts.trace) opts.trace.length = 0;
  const kindOf = (i: string): LayerKind => opts.kind?.(i) ?? (isTwoHanded(i) ? 'override' : 'additive');
  const one = (kind: 'idle' | 'combat_idle'): Pose | null => {
    const exact = find(kind, weapon, t);
    if (exact) return exact;                                  // 1. авторская на точный ключ
    const at = (k: 'idle' | 'combat_idle', i: string, tt: number): Pose | null => find(k, i, tt) ?? (k === 'combat_idle' ? find('idle', i, tt) : null);
    const base = at(kind, 'none', t);
    const [m, o] = splitHands(weapon);
    if (!base) return at(kind, m, t);                         // 3. базы нет — старое поведение
    // ⚠ РЕФЕРЕНС ДЕЛЬТЫ — БАЗА НА НУЛЕ, а не живая. Если считать дельту от дышащей базы, она будет
    // ровно компенсировать дыхание, и рука с предметом застынет: на маске оверлея жизнь пропадёт.
    // Так же устроен `Make Additive` в Unreal — базовая поза аддитива фиксированная.
    const ref = at(kind, 'none', 0) ?? base;
    const layers: PoseLayer[] = [];
    const mKind = m !== 'none' ? kindOf(m) : 'additive';
    const two = mKind === 'override';                         // override владеет верхом → офф-руки нет
    const mp = m !== 'none' ? at(kind, m, t) : null;
    // Рука предмета: обычно её задаёт позиция в ключе, но конфиг может сказать иначе (факел «в левой»
    // при пустой правой — предмет стоит на месте главного, а руку берёт вторую).
    const mHand = opts.hand?.(m) ?? 'main';
    if (mp) {
      const off = !two && mHand === 'off';
      layers.push({ pose: off ? asOffHandPose(mp) : mp, base: off ? asOffHandPose(ref) : ref,
        mask: two ? UPPER_ALL_MASK : off ? ARM_OFF_MASK : ARM_MAIN_MASK, weight: weightOf(m), kind: mKind });
      // Трассу пишем только на спокойном проходе: `one()` зовётся дважды (relax + combat), состав тот же.
      if (opts.trace && kind === 'idle') opts.trace.push({ item: m, hand: off ? 'off' : 'main', kind: mKind, weight: weightOf(m) });
    }
    if (!two && o !== 'none') {
      const op = at(kind, o, t);
      const off = (opts.hand?.(o) ?? 'off') === 'off';
      if (op) {
        const k2: LayerKind = kindOf(o) === 'override' ? 'additive' : kindOf(o);
        layers.push({ pose: off ? asOffHandPose(op) : op, base: off ? asOffHandPose(ref) : ref,
          mask: off ? ARM_OFF_MASK : ARM_MAIN_MASK, weight: weightOf(o), kind: k2 });
        if (opts.trace && kind === 'idle') opts.trace.push({ item: o, hand: off ? 'off' : 'main', kind: k2, weight: weightOf(o) });
      }
    }
    return layers.length ? composeStance(base, layers) : base;   // 2. сборка (нет предметов → чистая база)
  };
  const relaxed = one('idle');
  if (!relaxed || combat <= 0.001) return relaxed;
  const fight = one('combat_idle');
  return fight ? blendTwo(relaxed, fight, combat) : relaxed;
}
