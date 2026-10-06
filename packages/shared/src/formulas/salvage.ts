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

/** ⭐ id ЧАРОДЕЙСКОЙ ЭССЕНЦИИ — валюты чар с разбора (`balance.salvage.essence`). Стопка в сумке и кошелёк сундука — как у сырья. */
export const ESSENCE_ID = 'ench-essence';
/** Семья эссенции: своя, ни с одной семьёй сырья не смешивается (лестница сорта, ковка и правила разбора её не видят). */
export const ESSENCE_FAMILY = 'ench';

/**
 * Материалы с убитого монстра.
 *
 * Берём `count` СЛУЧАЙНЫХ вещей из надетых, у каждой читаем её `salvageTo` и катаем количество.
 * Вещи без `salvageTo` пропускаются молча — это нормальный способ сказать «с этого ничего».
 *
 * ⚠ РАНЬШЕ БРАЛИСЬ ПЕРВЫЕ, и комментарий уверял, что `gearRolls` «уже перемешан генератором». Это
 * НЕВЕРНО: генератор тасует только то, каким слотам достанутся аффиксы (`restOrder`), а сам список
 * пишет в исходном порядке, где оружие стоит нулевым всегда (`monstergen.ts`). С обычного монстра
 * падает ровно одна вещь — значит это ВСЕГДА было оружие. ЗАМЕР на живом симе: 98.2 % прихода —
 * оружейное сырьё (железо 404, дерево 40), ткани и пластин за 3.3 часа игры НОЛЬ. Броня в игре есть,
 * монстры её носят, а сырья с неё не приходило вовсе.
 *
 * ⭐ ТЕЛО ДАЁТ ТОЛЬКО «ВЕТОШЬ» I СОРТА (предложение «Разбор, сырьё и чары» §10): семья — по надетой вещи, количество прежнее, а сорт —
 * всегда первый, какой бы редкости ни была вещь. Сорт сырья = ступень вещи, и у тела исключений нет; редкость монстра даёт больше
 * ВЕЩЕЙ с тела (`piecesDropped`), но не сорт. ⚠ Раньше сорт брался по редкости надетого (`rarityTier`), а уникальная редкость давала
 * «не разбирается» (0) — с тела босса, где все вещи уникальные, сырья не падало никогда (замер: 400 боссов — 0 сырья).
 * ⚠ R6-22: выключенное не падает: сорт I выключенной семьи — пусто.
 */
export function salvageFromMonster(
  rolls: readonly MonsterGearRoll[] | undefined,
  gearById: (id: string) => SalvageableGear | undefined,
  rng: IntRng,
  opts: { rarity?: string; knownMaterial?: (id: string) => boolean } = {},
): MaterialCost {
  const out: MaterialCost = {};
  if (!rolls || !rolls.length) return out;
  const count = Math.min(piecesDropped(opts.rarity, rng), rolls.length);
  // Перемешиваем ИНДЕКСЫ, а не сам массив: `rolls` — чужие данные (лежат в монстре и уходят в тултип),
  // и молча менять их порядок значило бы править чужое состояние ради своего броска.
  const order = rolls.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = rng.int(0, i); [order[i], order[j]] = [order[j]!, order[i]!]; }
  for (let k = 0; k < count; k++) {
    const roll = rolls[order[k]!];
    const gear = roll?.gearId ? gearById(roll.gearId) : undefined;
    for (const y of gear?.salvageTo ?? []) {
      const n = rng.int(Math.max(0, y.min), Math.max(0, y.max));
      if (n <= 0) continue;
      const id = gradeId(y.materialId, 1);
      if (opts.knownMaterial && !opts.knownMaterial(id)) continue;
      out[id] = (out[id] ?? 0) + n;
    }
  }
  return out;
}

/**
 * `iron-3` → сорт `grade` той же семьи (`iron-1`). Сорта такого нет (`known`) — СПУСКАЕМСЯ до ближайшего существующего ниже; ниже нет
 * ни одного — исходный id (`knownOnly` разбора и проверка тела его отсеют). Без `known` — id сорта как есть. Не «семья-N» — как есть.
 */
export function gradeId(id: string, grade: number, known?: (id: string) => boolean): string {
  const m = /^(.*)-(\d+)$/.exec(id);
  if (!m) return id;
  const g = Math.max(1, Math.floor(grade));
  if (!known) return `${m[1]}-${g}`;
  for (let s = g; s >= 1; s--) {
    const cand = `${m[1]}-${s}`;
    if (known(cand)) return cand;
  }
  return id;
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
  /**
   * Детали СКОВАННОЙ вещи. Есть — путь «по правилу» закрыт: скованное переплавляют (`meltReturn`),
   * иначе ковка стала бы прачечной — скуй дешёвую обычную, зачаруй, разбери как редкую за эссенцию.
   */
  parts?: unknown;
}

/** Числа разбора из `balance.salvage` (в части, важной для пути «по правилу»). */
export interface SalvageTuning {
  fieldYield: number;
  armorSlotMult: Record<string, number>;
  /** Разбираются ли уникальные (`balance.salvage.uniqueSalvage`): нет поля — нет (решение В2). */
  uniqueSalvage?: boolean;
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

/**
 * Во сколько раз КОЛИЧЕСТВО отличается от «нагрудник у кузнеца».
 * ⚠ Редкости здесь НЕТ намеренно: за редкость платит эссенция (`balance.salvage.essence`), а сорт сырья — ступень вещи.
 * Дай ей ещё и количество — редкая вещь платила бы дважды, и разбирать было бы выгоднее, чем носить.
 */
export function salvageMult(item: SalvageableItem, t: SalvageTuning, inField: boolean): number {
  const slot = item.kind === 'armor' ? (t.armorSlotMult[item.slot ?? ''] ?? 1) : 1;
  return slot * (inField ? t.fieldYield : 1);
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
  // Явный выключатель (`uniqueSalvage`), а не «ступень 0» у редкости: прежний `rarityTier.unique = 0` глушил заодно и тела боссов.
  if (item.rarity === 'unique' && !t.uniqueSalvage) return { ok: false, reason: UNIQUE_NO_SALVAGE };
  if (item.parts) return { ok: false, reason: 'Скованную вещь переплавляют, а не разбирают' };
  const rule = salvageRuleFor(item, weaponClass, rules);
  if (!rule?.yields?.length) return { ok: false, reason: 'Эту вещь не из чего разбирать' };
  if (salvageMult(item, t, inField) <= 0) return { ok: false, reason: 'Разбор ничего не даст' };
  return { ok: true };
}

/** Отказ разбора уникальной вещи — одна строка для кузницы, поля и карточки. */
export const UNIQUE_NO_SALVAGE = 'Уникальные вещи не разбираются — их можно продать';

/**
 * Что выйдет из вещи. Дробный выход округляется ВЕРОЯТНОСТНО (0.6 → шесть раз из десяти единица),
 * чтобы 30 % от одной доски не превращались в «всегда ноль» и не ломали мелкие вещи.
 * ⭐ СОРТ сырья — `opts.grade` (по ступени вещи: нижний сорт рецепта её ступени, `salvageGrades`), а не редкость. Правило разбора
 * пишет семью (`iron-1` — железо); сорта нет в конфиге — спускаемся до ближайшего ниже (`gradeId`). Нет `grade` — I.
 */
export function salvageFromItem(
  item: SalvageableItem,
  weaponClass: string | undefined,
  rules: readonly SalvageRule[],
  t: SalvageTuning,
  rng: SalvageRng,
  opts: { inField?: boolean; knownMaterial?: (id: string) => boolean; grade?: number } = {},
): MaterialCost {
  const out: MaterialCost = {};
  const rule = salvageRuleFor(item, weaponClass, rules);
  const mult = salvageMult(item, t, !!opts.inField);
  if (!rule?.yields?.length || mult <= 0 || item.parts || (item.rarity === 'unique' && !t.uniqueSalvage)) return out;
  const grade = Math.max(1, Math.floor(opts.grade ?? 1));
  for (const y of rule.yields) {
    const raw = rng.int(Math.max(0, y.min), Math.max(0, y.max)) * mult;
    const whole = Math.floor(raw);
    const n = whole + (rng.chance(raw - whole) ? 1 : 0);
    if (n <= 0) continue;
    const id = gradeId(y.materialId, grade, opts.knownMaterial);
    out[id] = (out[id] ?? 0) + n;
  }
  return out;
}
