import type { Item } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ ПОЛУТОРНЫЙ ХВАТ: двуручное оружие, которое можно нести и ОДНОЙ рукой — со щитом, за штраф
 * (docs/CRAFT_WEAPONS.md §25).
 *
 * Как это было в Diablo II (проверено по `weapons.txt` 1.13): у оружия ДВА набора урона —
 * `mindam/maxdam` для одной руки и `2handmindam/2handmaxdam` для двух; флаг `1or2handed` разрешал
 * носить одной рукой (там — только варвару). Скорость и требования в обоих хватах ОДИНАКОВЫ, а
 * режим НЕ переключается кнопкой: занята вторая рука — значит одноручный хват.
 *
 * ⚠ Два отличия у нас, оба намеренные:
 * 1. **Один набор чисел, а не два.** У вещи катается вилка базы и работает доводка ковки: храни мы
 *    два набора — они разъехались бы между хватами, и подсказка начала бы врать. Поэтому авторим
 *    двуручный профиль, а одноручные числа СЧИТАЮТСЯ (`gripAdjust`).
 * 2. **Скорость тоже падает.** В Д2 разницы в скорости не было (одна колонка `speed`), и двуручный
 *    хват отличался только уроном. Нам нужен второй повод брать двумя руками, поэтому темп ×0.92.
 *
 * ⚠ Множитель урона НЕ копируется из Д2 (там ×0.52): у них двуручник вдвое сильнее одноручного, у
 * нас — в полтора раза. Возьми 0.52 — и одноручный хват станет заведомо хуже настоящего одноручника,
 * то есть мёртвой опцией. Инвариант, который на самом деле стоит порта: одноручный хват равен
 * хорошему одноручнику той же ступени, а платят за это требованиями (у нас сила 22 против 15).
 *
 * ⚠ ЧИСЛА ПОДОБРАНЫ ЗАМЕРОМ, а не выведены: вклад атрибутов размывает разницу оружия, поэтому
 * «на бумаге» ×0.88 урона и ×0.92 темпа дают −19 % ДПС, а в модели героя 30-го уровня — всего −12 %.
 * На замере (щит в офф-руке, воин 1/30/60 ур.): одноручный хват ≈ 0.99 длинного меча при требовании
 * силы 22 против 15, двуручный выгоднее одноручного в 1.13 раза. Обе величины стерегут тесты.
 */
export interface GripTuning {
  /** Урон одной рукой = базовый × это. */
  damage: number;
  /** Скорость оружия одной рукой = базовая × это. */
  speed: number;
}

/** Умолчание = `balance.versatile` в конфиге (для вызовов, которым конфиг не передан). */
export const DEFAULT_GRIP: GripTuning = { damage: 0.88, speed: 0.92 };

/**
 * Ручки `balance.versatile` → хват. ОДИН перевод для деривации (`playerModifiers`), удара и скилов сессии: ⚠ C-15 — сессия звала
 * `attackWeaponsOf` без хвата, и урон базового удара стоял на зашитом `DEFAULT_GRIP`, пока скорость и панели шли за ручкой.
 */
export function gripOf(v: { oneHandDamage: number; oneHandSpeed: number } | undefined): GripTuning {
  return v ? { damage: v.oneHandDamage, speed: v.oneHandSpeed } : DEFAULT_GRIP;
}

/** Полуторное ли оружие: родной хват — две руки, но разрешена одна. */
export function isVersatile(item: Item | undefined): boolean {
  return !!item && (item.hands ?? 1) >= 2 && !!item.versatile;
}

/** Держат ли ОДНОЙ рукой: полуторное оружие + занятая вторая рука. Режим не хранится нигде. */
export function oneHandGrip(save: SaveState, item: Item | undefined = save.equipment.weapon): boolean {
  return isVersatile(item) && !!save.equipment.offhand;
}

/**
 * Копия вещи с числами ОДНОЙ руки: урон ×`damage`, собственная скорость оружия ×`speed`.
 * Требования, вес, геометрия и аффиксы не трогаются — как в Д2, платой служат требования базы.
 */
export function gripAdjust(item: Item, k: GripTuning = DEFAULT_GRIP): Item {
  const stats: StatModifier[] = item.baseStats.map((m) => {
    if (m.kind === 'flat' && (m.stat === 'minDamage' || m.stat === 'maxDamage')) {
      return { ...m, value: Math.round(m.value * k.damage) };
    }
    // Скорость оружия — множитель, поэтому домножаем сам множитель: (1 + inc) × speed − 1.
    if (m.kind === 'increased' && m.stat === 'attackSpeed') {
      return { ...m, value: Math.round(((1 + m.value) * k.speed - 1) * 1000) / 1000 };
    }
    return { ...m };
  });
  // Своей скорости у базы нет — добавляем штраф отдельной строкой.
  if (!stats.some((m) => m.stat === 'attackSpeed' && m.kind === 'increased')) {
    stats.push({ stat: 'attackSpeed', kind: 'increased', value: Math.round((k.speed - 1) * 1000) / 1000 });
  }
  return { ...item, baseStats: stats };
}

/** Вещь как её держат сейчас: полуторное со щитом — урезанная копия, иначе та же вещь. */
export function asHeld(item: Item | undefined, save: SaveState, k: GripTuning = DEFAULT_GRIP): Item | undefined {
  if (!item || item.uid !== save.equipment.weapon?.uid || !oneHandGrip(save, item)) return item;
  return gripAdjust(item, k);
}
