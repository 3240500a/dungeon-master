import type { MonsterGearRoll } from '../types/world.js';
import type { MaterialCost } from '../economy/materials.js';

/**
 * ЧТО МОНСТР НОСИТ — ТО С НЕГО И ПАДАЕТ (docs/ECONOMY.md).
 *
 * Материалы берутся не из общей таблицы, а из КОНКРЕТНОГО снаряжения убитого: у зомби в
 * ржавой кольчуге падают пластины, у зомби с топором — железо и дерево. Связь описана
 * полем `salvageTo` прямо в записях `monster-gear`, поэтому «носит → даёт» видно в одном
 * месте, а модульный персонаж начинает работать как ПРЕДПРОСМОТР ЛУТА: видно, кого бить.
 *
 * ⚠ ПАДАЕТ НЕ ВЕСЬ ГИР. У зомби с мечом, щитом, бронёй и шлемом выпадает один предмет;
 * у редкого — один-два; у уникального — два. Иначе с жирного монстра сыпется всё разом
 * и трофей перестаёт быть событием.
 */

/** Что даёт одна вещь снаряжения при разборе: сколько какого материала. */
export interface SalvageYield {
  materialId: string;
  min: number;
  max: number;
}

/** Запись снаряжения монстра в части, важной для разбора (структурно ⊆ `monster-gear`). */
export interface SalvageableGear {
  id: string;
  salvageTo?: SalvageYield[];
}

/** Бросок целых чисел — совместим с `Rng.int` сессии. */
export interface IntRng { int(min: number, max: number): number }

/** Сколько ВЕЩЕЙ снаряжения роняется, по редкости монстра. */
export function piecesDropped(rarity: string | undefined, rng: IntRng): number {
  if (rarity === 'unique') return 2;
  if (rarity === 'rare') return rng.int(1, 2);
  return 1;
}

/**
 * Материалы с убитого монстра.
 *
 * Берём `count` вещей из надетых (по порядку `gearRolls`, который уже перемешан генератором,
 * поэтому дополнительного шаффла не надо), у каждой читаем её `salvageTo` и катаем количество.
 * Вещи без `salvageTo` пропускаются молча — это нормальный способ сказать «с этого ничего».
 *
 * `tierShift` поднимает ступень материала на глубине: на id вида `iron-1` прибавка даёт `iron-2`.
 * ⚠ Сдвиг применяется ТОЛЬКО если такой id есть в конфиге — иначе остаётся исходный. Без этой
 * проверки глубокий забег ронял бы несуществующие материалы, и они молча пропадали бы.
 */
export function salvageFromMonster(
  rolls: readonly MonsterGearRoll[] | undefined,
  gearById: (id: string) => SalvageableGear | undefined,
  rng: IntRng,
  opts: { rarity?: string; tierShift?: number; knownMaterial?: (id: string) => boolean } = {},
): MaterialCost {
  const out: MaterialCost = {};
  if (!rolls || !rolls.length) return out;
  const count = Math.min(piecesDropped(opts.rarity, rng), rolls.length);
  for (let i = 0; i < count; i++) {
    const gear = rolls[i]?.gearId ? gearById(rolls[i]!.gearId!) : undefined;
    for (const y of gear?.salvageTo ?? []) {
      const n = rng.int(Math.max(0, y.min), Math.max(0, y.max));
      if (n <= 0) continue;
      const id = shiftTier(y.materialId, opts.tierShift ?? 0, opts.knownMaterial);
      out[id] = (out[id] ?? 0) + n;
    }
  }
  return out;
}

/**
 * `iron-1` + 1 → `iron-2`. Если такой ступени нет — СПУСКАЕМСЯ до ближайшей существующей.
 *
 * ⚠ Именно спускаемся, а не возвращаем исходный id: иначе прыжок за потолок откатывал бы
 * к ПЕРВОЙ ступени, и глубина 24+ снова роняла бы `iron-1` — хуже, чем глубина 16.
 * Без `known` проверять нечем — отдаём сдвинутый id как есть.
 */
export function shiftTier(id: string, shift: number, known?: (id: string) => boolean): string {
  if (shift <= 0) return id;
  const m = /^(.*)-(\d+)$/.exec(id);
  if (!m) return id;
  const base = Number(m[2]);
  if (!known) return `${m[1]}-${base + shift}`;
  for (let s = shift; s > 0; s--) {
    const cand = `${m[1]}-${base + s}`;
    if (known(cand)) return cand;
  }
  return id;
}

// ── Разбор ВЕЩИ ИГРОКА (Ч3) ──────────────────────────────────────────────────────────────────────

/**
 * РАЗОБРАТЬ МОЖНО В ДВУХ МЕСТАХ, И ЭТО РАЗНЫЕ СДЕЛКИ (docs/ECONOMY.md, Ч3).
 *
 * В поле выход неполный (`balance.salvage.fieldYield`), зато ничего не надо нести и нечего
 * терять при смерти. У кузнеца выход полный, но трофей всю дорогу занимает клетку и уходит
 * вместе с половиной сумки, если тебя убьют. Отсюда живое решение на КАЖДЫЙ трофей — и именно
 * поэтому доля поля 0.3, а не 0.6: при 0.6 нести невыгодно никогда, и выбора нет.
 *
 * Из чего вещь сделана — задаётся ПРАВИЛАМИ (`salvage-rules`), а не таблицей на каждую из 84 баз.
 */

/** Правило разбора в части, важной для формулы (структурно ⊆ конфига `salvage-rules`). */
export interface SalvageRule {
  id?: string;
  enabled?: boolean;
  kind?: string;
  weaponClass?: string;
  armorClass?: string;
  slot?: string;
  yields?: SalvageYield[];
}

/** Предмет в части, важной для разбора. `weaponClass` живёт на БАЗЕ, в предмете его нет. */
export interface SalvageableItem {
  kind?: string;
  slot?: string;
  armorClass?: string;
  rarity: string;
  itemLevel: number;
}

/** Числа разбора из `balance.salvage`. */
export interface SalvageTuning {
  fieldYield: number;
  rarityMult: Record<string, number>;
  armorSlotMult: Record<string, number>;
  tierUpEveryItemLevel: number;
}

/** Бросок для разбора: целые + вероятностное округление дробного остатка. */
export interface SalvageRng extends IntRng {
  chance(p: number): boolean;
}

/** Первое подошедшее правило сверху вниз. Пустое поле условия не проверяется вовсе. */
export function salvageRuleFor(
  item: SalvageableItem,
  weaponClass: string | undefined,
  rules: readonly SalvageRule[],
): SalvageRule | undefined {
  return rules.find(
    (r) =>
      r.enabled !== false &&
      (r.kind === undefined || r.kind === item.kind) &&
      (r.weaponClass === undefined || r.weaponClass === weaponClass) &&
      (r.armorClass === undefined || r.armorClass === item.armorClass) &&
      (r.slot === undefined || r.slot === item.slot),
  );
}

/** Во сколько раз выход отличается от «нагрудник, обычная редкость, кузница». */
export function salvageMult(item: SalvageableItem, t: SalvageTuning, inField: boolean): number {
  const rar = t.rarityMult[item.rarity] ?? 1;
  const slot = item.kind === 'armor' ? (t.armorSlotMult[item.slot ?? ''] ?? 1) : 1;
  return rar * slot * (inField ? t.fieldYield : 1);
}

/**
 * ⚠ МОЖНО ЛИ ВООБЩЕ РАЗБИРАТЬ. Проверять ОБЯЗАТЕЛЬНО до разбора: он уничтожает вещь, и «правила
 * нет / множитель 0» молча съели бы предмет в обмен на пустоту. Уникальные не разбираются
 * намеренно (решение В2): нашёл как есть, лишний уходит торговцу за золото.
 */
export function canSalvage(
  item: SalvageableItem,
  weaponClass: string | undefined,
  rules: readonly SalvageRule[],
  t: SalvageTuning,
  inField: boolean,
): { ok: boolean; reason?: string } {
  if ((t.rarityMult[item.rarity] ?? 1) <= 0) return { ok: false, reason: 'Уникальные вещи не разбираются' };
  const rule = salvageRuleFor(item, weaponClass, rules);
  if (!rule?.yields?.length) return { ok: false, reason: 'Эту вещь не из чего разбирать' };
  if (salvageMult(item, t, inField) <= 0) return { ok: false, reason: 'Разбор ничего не даст' };
  return { ok: true };
}

/**
 * Что выйдет из вещи. Дробный выход округляется ВЕРОЯТНОСТНО (0.6 → шесть раз из десяти единица),
 * чтобы 30 % от одной доски не превращались в «всегда ноль» и не ломали мелкие вещи.
 * Ступень материала поднимает УРОВЕНЬ ПРЕДМЕТА — по той же лестнице, что глубина у монстров,
 * и с той же защитой: несуществующая ступень не выдаётся.
 */
export function salvageFromItem(
  item: SalvageableItem,
  weaponClass: string | undefined,
  rules: readonly SalvageRule[],
  t: SalvageTuning,
  rng: SalvageRng,
  opts: { inField?: boolean; knownMaterial?: (id: string) => boolean } = {},
): MaterialCost {
  const out: MaterialCost = {};
  const rule = salvageRuleFor(item, weaponClass, rules);
  const mult = salvageMult(item, t, !!opts.inField);
  if (!rule?.yields?.length || mult <= 0) return out;
  const per = t.tierUpEveryItemLevel;
  const shift = per > 0 ? Math.floor(item.itemLevel / per) : 0;
  for (const y of rule.yields) {
    const raw = rng.int(Math.max(0, y.min), Math.max(0, y.max)) * mult;
    const whole = Math.floor(raw);
    const n = whole + (rng.chance(raw - whole) ? 1 : 0);
    if (n <= 0) continue;
    const id = shiftTier(y.materialId, shift, opts.knownMaterial);
    out[id] = (out[id] ?? 0) + n;
  }
  return out;
}
