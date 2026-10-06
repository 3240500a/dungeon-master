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
import { blendTwo, clipPoseAt, isAngleKey, HIPS_DEL, HIPS_ABS, type Pose } from './clipModel.js';
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

/**
 * ⭐⭐ КЛЮЧ «ПРЕДМЕТ В СЛОТЕ ОФФ-РУКИ, ГЛАВНАЯ ПУСТА»: `shield` → `none+shield`.
 *
 * Жалоба: «сделал два idle щиту без оружия, а к мечу не прицепилось». Причин оказалось ДВЕ, и обе
 * про одно — под каким ключом и на какой руке лежит авторская работа:
 *
 *  1. ⚠ КЛЮЧ. Панель собирает его из двух слотов и при пустой главной руке пишет `none+shield`,
 *     а слой предметов, разобрав `sword+shield`, искал офф-руку по ключу `shield`. Не находил.
 *  2. ⚠⚠ И ГЛАВНОЕ — ФОЛБЭК, УБИВАВШИЙ ВСЮ СБОРКУ. Поиск «нет позы на точный ключ — возьми БАЗОВОЕ
 *     оружие» (`sword+shield` → `sword`) отвечал на самый первый вопрос резолвера («есть авторская
 *     на точный ключ?»), и тот возвращал чистую стойку меча, не дойдя до слоёв. То есть щит не
 *     подмешивался НИКОГДА, если у меча была своя стойка, — под каким бы ключом он ни лежал.
 *     Фолбэк убран: у сборки он уже есть и правильный (нет безоружной базы → стойка главной руки),
 *     и там он не мешает подмешать офф-руку.
 */
export const offSlotKey = (item: string): string => 'none+' + item;

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

/**
 * Вес ключа в маске. Спец-ключи оружия (`__wpnMain`, `__lgripP`…) костями не являются — им маска не мешает: хват предмета
 * обязан доехать вместе с рукой.
 *
 * ⚠⚠ КРОМЕ КАНАЛОВ ТАЗА (`__hipsD`, `__hipsP`) — они идут с весом КОСТИ ТАЗА в маске. Раньше вес был 1 у любого `__`-ключа,
 * и слой РУКИ таскал за собой смещение таза своей стойки: ЗАМЕР на контенте владельца — `sword+shield` двигал таз на
 * (−2.00, 0.50, 1.30) от безоружного, ровно ДВА смещения одной стойки (−1.00, 0.25, 0.65), по одному от каждой руки. Таз —
 * часть тела, а не руки: у масок рук кости таза нет, и смещение остаётся базовым; полная маска (`fullMask`) таз держит.
 */
const PELVIS_KEYS: ReadonlySet<string> = new Set([HIPS_DEL, HIPS_ABS]);
const maskW = (mask: BoneMask, key: string): number =>
  (key.startsWith('__') ? (PELVIS_KEYS.has(key) ? boneWeight(mask, 'Hips') : 1) : boneWeight(mask, key));

/**
 * ⚠ СЛУЖЕБНЫЕ КАНАЛЫ НАБОРА ХОДА ИЗ ВСТАВКИ В СТОЙКУ НЕ ПУСКАЕМ. Вставка (`fidget`) — клип мокапа, и её
 * `__swing`/`__rootY`/`__rootP` подменили бы опору и курс. Смещение таза (`__hipsD`) — часть движения и остаётся.
 */
const onlyBody = (p: Pose): Pose => {
  let drop = false;
  for (const k in p) if (k.startsWith('__') && k !== '__hipsD') { drop = true; break; }
  if (!drop) return p;
  const o: Pose = {};
  for (const k in p) if (!k.startsWith('__') || k === '__hipsD') o[k] = p[k]!;
  return o;
};

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
//
// ⭐ ПАЛЬЦЫ — ЧАСТЬ РУКИ, КОТОРАЯ ДЕРЖИТ ПРЕДМЕТ (`handR`/`handL`). Пока стойка оружия была полной позой на точный ключ,
// хват её кисти ехал вместе с ней; теперь от стойки предмета берётся только рука — и пальцы обязаны ехать с ней, иначе
// стойка с АНИМИРОВАННЫМИ пальцами (живой хват её не перебивает, `fingersAnimated`) держала бы меч пальцами базы.
export const ARM_MAIN_MASK: BoneMask = { parts: { handR: 1 }, weights: { RightShoulder: 1, RightUpperArm: 1, RightLowerArm: 1, RightHand: 1, UpperChest: 0.25, Chest: 0.15, Spine: 0.08 } };
export const ARM_OFF_MASK: BoneMask = { parts: { handL: 1 }, weights: { LeftShoulder: 1, LeftUpperArm: 1, LeftLowerArm: 1, LeftHand: 1, UpperChest: 0.25, Chest: 0.15, Spine: 0.08 } };
/**
 * Обе руки ОДНОЙ позой — пара, заавторенная на точный ключ (`idle_sword+shield`). Один слой, а не два: каналы хвата и
 * корпус пары легли бы дважды. Корпус — та же доля, что у одной руки.
 */
export const ARM_BOTH_MASK: BoneMask = { parts: { handL: 1, handR: 1 }, weights: {
  RightShoulder: 1, RightUpperArm: 1, RightLowerArm: 1, RightHand: 1,
  LeftShoulder: 1, LeftUpperArm: 1, LeftLowerArm: 1, LeftHand: 1,
  UpperChest: 0.25, Chest: 0.15, Spine: 0.08,
} };
/** Двуручное владеет верхом целиком — маска на обе руки (с пальцами) и корпус. */
export const UPPER_ALL_MASK: BoneMask = { parts: { handL: 1, handR: 1 }, weights: {
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
 * ⭐⭐ ПРАВИЛО ВЛАДЕЛЬЦА (06.10): «в безоружном есть спокойная и боевая, с оружием берутся ОНИ, но подмешивается РУКА, в
 * которой что-то есть, — щит или оружие». То есть тело (ноги, таз, спина, шея, голова) — ВСЕГДА безоружная стойка нужной
 * оси, а от стойки предмета — только рука, которая его держит.
 *
 * ⚠ БЫЛО ИНАЧЕ ровно у одиночного предмета со своей стойкой (`sword`, `none+shield`): точный ключ отдавал её ЦЕЛИКОМ, и
 * живая база ложилась на неё дельтой полной маски. Ноги брались из стойки оружия (ЗАМЕР на контенте владельца: бёдра
 * 29°/41°, голени 13°, стопы 11°/27° от безоружной — её авторили от прежней однокадровой базы), а дельта дыхания базы,
 * положенная на ЧУЖИЕ ноги, — не жёсткая для стопы: опорные стопы в покое уезжали на 2–4 u за 10 с (безоружный — 0.15–0.35),
 * и Unity с вебом показывали это одинаково (порт 1:1). Составной ключ (`sword+shield`) уже собирался так — правило одно.
 *
 * Порядок решения:
 *  1. Есть безоружная база — она и есть стойка; сверху РУКИ предметов (дельтой к базе на нуле, маской руки с пальцами,
 *     корпус — малой долей). Рука предмета: точная поза ПАРЫ на ключ (обе руки одной позой) → поза главного предмета
 *     (`idle_sword`) → для офф-руки работа в её слоте (`none+shield`), иначе предмет зеркалом хвата. Двуручное — `override`
 *     на весь верх, офф-рука тогда не участвует — она занята. Таз и ноги стойки предмета не берутся НИКОГДА.
 *  2. Нет безоружной базы — авторская поза на точный ключ, иначе стойка главного предмета, иначе null (как было до слоёв:
 *     полный процедурный мах).
 */
export interface StanceOpts {
  /** Сила подмешивания предмета 0..1. Нет → 1. */
  weight?: (item: string) => number;
  /** Тип оверлея. Нет → двуручное `override`, остальное `additive`. */
  kind?: (item: string) => LayerKind;
  /** Рука предмета, если задана ЯВНО (факел в левой при пустой правой). Нет → по позиции в ключе. */
  hand?: (item: string) => 'main' | 'off' | undefined;
  /**
   * Куда сложить РЕАЛЬНЫЙ состав стойки: что, в какой руке, чем и с какой силой.
   *
   * ⚠ Это НЕ только для инспектора. Шов рук (`armBlend`) резолвит мах ПО ПРЕДМЕТУ В РУКЕ, и рука предмета решается
   * ЗДЕСЬ (`opts.hand` может сказать «факел в левой» при пустой правой) — спрашивать её вторым разбором значило бы
   * завести вторую правду ровно там, где она разойдётся молча. Массив очищается и заполняется здесь,
   * потому что пересчитывать состав на стороне инспектора значит завести вторую правду: она разойдётся
   * с первой ровно в тот день, когда правила сборки поменяются, и врать будет именно окно отладки.
   */
  trace?: StanceLayerInfo[];
  /**
   * ⭐⭐ РЕДКАЯ ВСТАВКА В ПОКОЙ этого кадра (планировщик — `idleFidget.ts`). Нет — ветка не берётся и
   * поведение прежнее бит в бит.
   *
   * `scope: 'base'` — вставка ПОДМЕНЯЕТ БЕЗОРУЖНУЮ БАЗУ, поэтому рука предмета ложится ПОВЕРХ: одна
   * пачка «переступил» играет со ВСЕМ оружием (тело с оружием — это и есть база).
   * `scope: 'item'` — это ПОЛНАЯ авторская поза С ПРЕДМЕТОМ (прокрут меча): крутить мечом нечем, если
   * позы меча во вставке нет, поэтому она блендится поверх УЖЕ СОБРАННОЙ стойки.
   *
   * ⚠ РЕФЕРЕНС ДЕЛЬТЫ ПРЕДМЕТА ОСТАЁТСЯ ЧИСТОЙ БАЗОЙ. Посчитать его от ПОДМЕНЁННОЙ базы — значит ровно
   * скомпенсировать вставку, и с оружием она пропадёт. Та же грабля, что с дыханием.
   */
  fidget?: { pose: Pose; scope: 'base' | 'item'; w: number };
}
/** Один подмешанный предмет: что, в какую руку, чем и с какой силой. */
export interface StanceLayerInfo {
  item: string; hand: 'main' | 'off'; kind: LayerKind; weight: number;
  /**
   * ⚠ ЛЁГ ЛИ СЛОЙ НА САМОМ ДЕЛЕ. Состав рук и «что применилось» — РАЗНЫЕ вопросы, и путать их дорого:
   * рука держит меч независимо от того, заавторена ли под него поза, а инспектор слоёв обязан показывать
   * только то, что действительно применено.
   */
  applied: boolean;
}

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
  /**
   * Вставка этого кадра, уже отфильтрованная от служебных каналов набора хода. ⚠ Фильтр обязателен:
   * `maskW` отдаёт любому `__`-ключу вес 1, и мокап-вставка отдала бы в стойку опору (`__swing`) и курс
   * (`__rootY`) — то есть подменила бы опорную ногу и развернула персонажа.
   */
  const fg = opts.fidget && opts.fidget.w > 1e-4 ? { ...opts.fidget, pose: onlyBody(opts.fidget.pose) } : null;
  /** База с подмешанной вставкой (`scope: 'base'`). Вес — огибающая планировщика. */
  const withFidget = (p: Pose | null): Pose | null =>
    (p && fg && fg.scope === 'base' ? blendTwo(p, fg.pose, Math.min(1, fg.w)) : p);
  /** Поза С ПРЕДМЕТОМ поверх уже собранной стойки (`scope: 'item'`). */
  const overItem = (p: Pose | null): Pose | null =>
    (p && fg && fg.scope === 'item' ? blendTwo(p, fg.pose, Math.min(1, fg.w)) : p);
  /**
   * ⭐⭐ СОСТАВ РУК — ИЗ КЛЮЧА ОРУЖИЯ, А НЕ ИЗ ТОГО, НАШЛАСЬ ЛИ ПОЗА ПРЕДМЕТА.
   *
   * ⚠ БЫЛО НАОБОРОТ, И ЭТО ЛОМАЛО ДВЕ ВЕЩИ СРАЗУ. Трасса заполнялась только там, где слой реально
   * складывался, поэтому: (а) при оружии со СВОЕЙ авторской стойкой точный ключ коротит сборку и трасса
   * оставалась ПУСТОЙ; (б) без заавторенной позы предмета слой не складывался тоже. ЗАМЕР: «есть точная
   * стойка sword» + оружие `sword` → главная «none»; «стойки нет» + `sword+shield` → обе «none».
   * Следствия были не косметические: панель маха рисует ручки только занятой руке (обе подписывались
   * «пусто — машет как в клипе»), а `frameSwing` РЕЗОЛВИТ МАХ ПО ЭТОМУ ЖЕ СОСТАВУ — то есть настройки
   * предмета не применялись и в игре, рука получала умолчания пустой.
   *
   * Теперь рука держит предмет ровно тогда, когда он есть в КЛЮЧЕ, а «лёг ли слой» — отдельное поле.
   */
  if (opts.trace) {
    const [mI, oI] = splitHands(weapon);
    const mK = mI !== 'none' ? kindOf(mI) : 'additive';
    if (mI !== 'none') {
      opts.trace.push({ item: mI, hand: opts.hand?.(mI) ?? 'main', kind: mK, weight: weightOf(mI), applied: false });
    }
    // Двуручное занимает ОБЕ руки: `override` владеет верхом, и офф-рука в сборке не участвует — но она ЗАНЯТА.
    if (oI !== 'none' && mK !== 'override') {
      opts.trace.push({ item: oI, hand: opts.hand?.(oI) ?? 'off', kind: kindOf(oI) === 'override' ? 'additive' : kindOf(oI), weight: weightOf(oI), applied: false });
    }
  }
  /** Отметить в трассе, что слой этого предмета реально лёг. */
  const markApplied = (item: string): void => {
    const e = opts.trace?.find((l) => l.item === item);
    if (e) e.applied = true;
  };
  const one = (kind: 'idle' | 'combat_idle'): Pose | null => {
    const at = (k: 'idle' | 'combat_idle', i: string, tt: number): Pose | null => find(k, i, tt) ?? (k === 'combat_idle' ? find('idle', i, tt) : null);
    const base = withFidget(at(kind, 'none', t));
    const [m, o] = splitHands(weapon);
    // 2. безоружной базы нет — стойка предмета целиком, как до слоёв: авторская на точный ключ, иначе главного предмета.
    if (!base) return overItem(find(kind, weapon, t) ?? at(kind, m, t));
    // ⚠ РЕФЕРЕНС ДЕЛЬТЫ — БАЗА НА НУЛЕ, а не живая. Если считать дельту от дышащей базы, она будет
    // ровно компенсировать дыхание, и рука с предметом застынет: на маске оверлея жизнь пропадёт.
    // Так же устроен `Make Additive` в Unreal — базовая поза аддитива фиксированная.
    const ref = at(kind, 'none', 0) ?? base;
    const layers: PoseLayer[] = [];
    const mKind = m !== 'none' ? kindOf(m) : 'additive';
    const two = mKind === 'override';                         // override владеет верхом → офф-руки нет
    /**
     * ПАРА, заавторенная на точный ключ (`idle_sword+shield`): обе руки держат то, что поставил автор, — ОДНОЙ позой и
     * одним слоем (два слоя одной позы положили бы хват и корпус дважды). Тело — всё равно база (правило владельца).
     * Одиночный предмет (`sword`, `none+shield`) сюда не попадает: его точный ключ и ЕСТЬ поза его руки ниже.
     */
    const pair = m !== 'none' && o !== 'none' ? find(kind, weapon, t) : null;
    if (pair) {
      layers.push(two ? { pose: pair, mask: UPPER_ALL_MASK, weight: 1, kind: 'override' }
        : { pose: pair, base: ref, mask: ARM_BOTH_MASK, weight: 1, kind: 'additive' });
      if (kind === 'idle') { markApplied(m); if (!two) markApplied(o); }
      return overItem(composeStance(base, layers));           // 1. база + обе руки пары
    }
    const mp = m !== 'none' ? at(kind, m, t) : null;
    // Рука предмета: обычно её задаёт позиция в ключе, но конфиг может сказать иначе (факел «в левой»
    // при пустой правой — предмет стоит на месте главного, а руку берёт вторую).
    const mHand = opts.hand?.(m) ?? 'main';
    if (mp) {
      const off = !two && mHand === 'off';
      layers.push({ pose: off ? asOffHandPose(mp) : mp, base: off ? asOffHandPose(ref) : ref,
        mask: two ? UPPER_ALL_MASK : off ? ARM_OFF_MASK : ARM_MAIN_MASK, weight: weightOf(m), kind: mKind });
      // Трассу пишем только на спокойном проходе: `one()` зовётся дважды (relax + combat), состав тот же.
      if (kind === 'idle') markApplied(m);
    }
    if (!two && o !== 'none') {
      // ⭐⭐ СНАЧАЛА ИЩЕМ РАБОТУ, СДЕЛАННУЮ В СЛОТЕ ОФФ-РУКИ (`none+щит`): она УЖЕ на левой руке,
      // и переносить её нельзя. Нет такой — берём предмет из главного слота и зеркалим, как раньше.
      // Так «настроил щит без оружия» само едет ко ВСЕМ оружиям, а точная поза пары (`sword+shield`)
      // кладёт обе руки сразу, выше по функции.
      const op = at(kind, offSlotKey(o), t) ?? at(kind, o, t);
      const off = (opts.hand?.(o) ?? 'off') === 'off';
      if (op) {
        const k2: LayerKind = kindOf(o) === 'override' ? 'additive' : kindOf(o);
        // ⚠ Отдельная ветка «не переносить, раз уже офф-рука» НЕ НУЖНА: `asOffHandPose` переименовывает
        // только ключи оружия и сразу выходит, если предмет уже заавторен как офф. Кости она не трогает
        // вовсе — маска и так берёт левую руку. Проверено мутацией: ветка ничего не меняла.
        layers.push({ pose: off ? asOffHandPose(op) : op, base: off ? asOffHandPose(ref) : ref,
          mask: off ? ARM_OFF_MASK : ARM_MAIN_MASK, weight: weightOf(o), kind: k2 });
        if (kind === 'idle') markApplied(o);
      }
    }
    return overItem(layers.length ? composeStance(base, layers) : base);   // 1. база + руки предметов (нет предметов → чистая база)
  };
  const relaxed = one('idle');
  if (!relaxed || combat <= 0.001) return relaxed;
  const fight = one('combat_idle');
  return fight ? blendTwo(relaxed, fight, combat) : relaxed;
}
