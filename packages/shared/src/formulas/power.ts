import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import type { Item } from '../types/items.js';
import { ATTRIBUTES, type Attributes } from '../types/attributes.js';
import { unmetWorn } from './stats.js';

/** Одна запись сложности (из конфига difficulties). */
export type Difficulty = ConfigShapes['difficulties'][number];
/** Веса метрики мощи (balance.power). */
export type PowerConfig = ConfigShapes['balance']['power'];

/** Разбор эффективного уровня персонажа: уровень + гир + пассивы. */
export interface PowerBreakdown {
  level: number;
  gearBonus: number;
  passiveBonus: number;
  /** Итоговый эффективный уровень (EL). */
  total: number;
}

/** Вклад вещи в мощь: вес редкости × «в уровень» (перерос уровень не даёт сверх 1). */
function gearScore(item: Item, level: number, cfg: PowerConfig): number {
  const weight = cfg.gearRarityWeight[item.rarity] ?? 1;
  return weight * Math.min(1, item.itemLevel / level);
}

/**
 * ⭐ R8-10: АТРИБУТЫ, ДО КОТОРЫХ ГЕРОЙ ДОТЯНЕТСЯ ГДЕ УГОДНО: вложенные (не ниже атрибутов до сброса, `respecPeak`) плюс все
 * нераспределённые очки в КАЖДЫЙ атрибут — `allocAttr` и `respec` работают и в подземелье. Верхняя граница: занижать мощь
 * ею нельзя (очками, сбросом), завысить — только тому, кто держит очки нераспределёнными или сбрасывал.
 */
function reachableAttributes(save: SaveState): Attributes {
  const free = Math.max(0, save.unspentAttributePoints || 0);
  const out = {} as Attributes;
  for (const a of ATTRIBUTES) out[a] = Math.max(save.attributes?.[a] || 0, save.respecPeak?.[a] || 0) + free;
  return out;
}

/**
 * ⭐ R7-02: гир, который герой МОЖЕТ надеть: в каждый слот — лучшая по вкладу вещь из надетого и `spare` (сумка, пояс;
 * на сервере — и то, что несут герои его аккаунта рядом). Двуручник запирает вторую руку: руки — лучшее из «двуручник»
 * и «оружие + вторая рука». Сломанное из запаса не в счёт — его не надеть, пока не починят. Надетое считается по слоту,
 * в котором надето: без запаса итог ровно сумма надетого.
 *
 * ⚠ R8-10: и вещь запаса, чьи требования герою НЕ ЗАКРЫТЬ, не в счёт — раньше честный герой, несущий находки этажа в город,
 * заселял узлы сильнее (до +3 EL), хотя `equip` их отвергал. Правило то же, что держит надетое (`unmetWorn`, R4-08): вещь
 * встаёт, если её требования закрыты атрибутами и прибавками вещей, вставших раньше, — значит кольцо +Сила из сумки опирает
 * меч из сумки. Атрибуты — `reachableAttributes`. Одна и та же вещь (сервер кладёт в запас и надетое) опирает один раз.
 * Опору дают и две вещи одного слота разом (надетое кольцо и кольцо в сумке) — это может лишь ЗАВЫСИТЬ мощь (замер: +1 у
 * 8 героев из 1200), занизить её снятием и перекладкой нельзя: всё, что надевается по одной в каком-то порядке, встаёт.
 *
 * ⭐ R11-02: одноручное оружие встаёт и во ВТОРУЮ руку (дуал-вилд): руки — лучшее из «двуручник», «оружие + щит» и «два
 * одноручника». Раньше оружие шло только в основную руку, и второй одноручник из сумки мощь не поднимал — «в городе меч в
 * руке, кинжал в сумке — надел в подземелье» заселяло узел слабее. Полуторный одной рукой — только со щитом (§25).
 */
function wearableGear(save: SaveState, spare: Iterable<Item | null | undefined>, level: number, cfg: PowerConfig): number {
  const best = new Map<string, number>();
  let twoHanded = 0;
  const oneHanded: number[] = [];   // одноручное оружие: основная рука ИЛИ вторая
  const offer = (slot: string, item: Item): void => {
    const s = gearScore(item, level, cfg);
    if (slot === 'weapon' && (item.hands ?? 1) >= 2 && !item.versatile) { twoHanded = Math.max(twoHanded, s); return; }
    // Оружие, надетое во вторую руку, — всё равно оружие: в пару к основной, а не «щит».
    if (item.slot === 'weapon' && (item.hands ?? 1) < 2) { oneHanded.push(s); return; }
    if (s > (best.get(slot) ?? 0)) best.set(slot, s);
  };
  const worn = new Set<Item>();
  for (const [slot, item] of Object.entries(save.equipment)) if (item) { worn.add(item); offer(slot, item); }
  const extra = new Set<Item>();
  for (const item of spare) if (item?.slot && !item.broken && !worn.has(item)) extra.add(item);
  if (extra.size) {
    const unmet = new Set(unmetWorn(reachableAttributes(save), [...worn, ...extra]));
    for (const item of extra) if (!unmet.has(item)) offer(item.slot!, item);
  }
  const [first = 0, second = 0] = oneHanded.sort((a, b) => b - a);
  const main = Math.max(best.get('weapon') ?? 0, first);   // `weapon` здесь — только полуторное
  let raw = Math.max(twoHanded, main + (best.get('offhand') ?? 0), first + second);
  for (const [slot, s] of best) if (slot !== 'weapon' && slot !== 'offhand') raw += s;
  return raw;
}

/**
 * «Мощь персонажа» как эффективный уровень (EL) = уровень + бонус за надетый гир
 * (по itemLevel и редкости, с поправкой на актуальность уровню) + бонус за
 * вложенные пассивки. Оба бонуса ограничены каппами из конфига. Чистая функция:
 * используется и клиентом (выбор сложности/лист персонажа), и сервером (анти-чит).
 *
 * ⭐ R7-02: `spare` — вещи, которые герой может надеть в любой момент (сумка, пояс, снаряжение героев его аккаунта рядом):
 * гир считается по лучшему из надетого и запаса (`wearableGear`). Так сервер меряет мощь, заселяя узел: раньше считалось
 * только надетое, и «снял всё в городе — спустился — надел в подземелье» заселяло узел до `gearMax` уровней слабее.
 */
export function effectiveLevel(save: SaveState, cfg: PowerConfig, spare?: Iterable<Item | null | undefined>): PowerBreakdown {
  const level = Math.max(1, save.level);

  let gearRaw = 0;
  if (spare) gearRaw = wearableGear(save, spare, level, cfg);
  else for (const item of Object.values(save.equipment)) if (item) gearRaw += gearScore(item, level, cfg);
  const gearBonus = Math.min(cfg.gearMax, Math.round(gearRaw / cfg.gearDivisor));

  let ranks = 0;
  for (const r of Object.values(save.masteries)) ranks += r;
  const passiveBonus = Math.min(cfg.passiveMax, Math.round(ranks / cfg.passiveDivisor));

  return { level, gearBonus, passiveBonus, total: level + gearBonus + passiveBonus };
}

/**
 * ⭐ R8-10: ЗАПАС ГЕРОЯ ДЛЯ МОЩИ — сумка и пояс. С ним клиент (алтарь, лист персонажа) показывает ту же мощь, по которой
 * сервер заселяет узел соло-героя; сервер к нему добавляет снаряжение героев того же аккаунта рядом (`gearPool`).
 */
export function carriedGear(save: SaveState): Item[] {
  return [...save.inventory, ...(save.belt ?? []).filter((i): i is Item => !!i)];
}

/** Стартовый challengeLevel забега (этаж 1) от эфф. уровня и выбранной сложности. */
export function startChallenge(effLevel: number, diff: Difficulty): number {
  const cl = diff.offsetMode === 'percent'
    ? effLevel * (1 + diff.offset)
    : effLevel + diff.offset;
  return Math.max(1, Math.round(cl));
}

/** challengeLevel на конкретном этаже (1-based): старт + рамп за глубину. */
export function challengeAtFloor(startCL: number, diff: Difficulty, floor: number): number {
  const f = Math.max(1, floor);
  return Math.max(1, Math.round(startCL + (f - 1) * diff.floorStep));
}

/** Удобный «всё-в-одном»: challengeLevel забега для персонажа на этаже. */
export function runChallengeLevel(
  save: SaveState,
  diff: Difficulty,
  floor: number,
  cfg: PowerConfig,
): number {
  const el = effectiveLevel(save, cfg).total;
  return challengeAtFloor(startChallenge(el, diff), diff, floor);
}

/**
 * Разблокирована ли сложность: тир с unlockFloor > 0 требует, чтобы на предыдущем
 * тире была достигнута глубина ≥ unlockFloor. Тиры идут по порядку списка.
 */
export function isDifficultyUnlocked(
  diffs: Difficulty[],
  index: number,
  progress: Record<string, number>,
): boolean {
  const diff = diffs[index];
  if (!diff || diff.unlockFloor <= 0) return true;
  const prev = diffs[index - 1];
  if (!prev) return true;
  return (progress[prev.id] ?? 0) >= diff.unlockFloor;
}

/** Включённый тир, который не откроется никогда (см. `lockedDifficulties`). */
export interface LockedDifficulty {
  id: string;
  unlockFloor: number;
  /** Тир, на котором копится прогресс (предыдущий по списку). */
  prevId: string;
  /** depth — порог глубже самого глубокого узла забега; prev — предыдущий тир выключен или сам закрыт навсегда. */
  cause: 'depth' | 'prev';
}

/**
 * ⭐ R8-13: включённые тиры, которые НЕЛЬЗЯ открыть ни честно, ни читом. Прогресс сложности — только глубина узла забега
 * (`Room.enterNode`), а она не больше `maxDepth` (`runMaxDepth` по шаблонам): порог выше — замок навсегда. Так было с
 * «Кошмаром» — 20-й этаж «Сложной» при самом глубоком узле 15. Второй путь к тому же — предыдущий тир выключен (его не
 * выбрать, прогресс на нём не набрать) или сам закрыт навсегда. Сторож данных (тест) и проверка редактора зовут это же.
 */
export function lockedDifficulties(diffs: readonly Difficulty[], maxDepth: number): LockedDifficulty[] {
  const out: LockedDifficulty[] = [];
  let prevOpen = false;   // предыдущий тир можно играть (включён и открывается)
  diffs.forEach((diff, i) => {
    const prev = diffs[i - 1];
    let open = diff.enabled !== false;
    if (open && prev && diff.unlockFloor > 0) {
      const cause = !prevOpen ? 'prev' : diff.unlockFloor > maxDepth ? 'depth' : null;
      if (cause) { out.push({ id: diff.id, unlockFloor: diff.unlockFloor, prevId: prev.id, cause }); open = false; }
    }
    prevOpen = open;
  });
  return out;
}
