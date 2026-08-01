import type { Item, RolledAffix, Rarity } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { Rng } from './rng.js';

type ItemsBase = ConfigShapes['items.base'];
type Affixes = ConfigShapes['affixes'];
type Uniques = ConfigShapes['uniques'];
type ItemTiers = ConfigShapes['item-tiers'];

/** Статы базы, масштабируемые тиром (урон/броня). Прочие (скор.атаки/блок) — flat. */
const TIER_SCALED = new Set(['minDamage', 'maxDamage', 'armor']);

/**
 * Тир по уровню предмета, зажатый диапазоном [minTier, maxTier] базы. Лестница
 * сортируется по minItemLevel; берётся высший тир ≤ ilvl, но не ниже minTier и не
 * выше maxTier базы. Так «Ржавый нож» не станет Мифическим, а «мифрил» — Сломанным.
 */
function pickTierClamped(
  tiers: ItemTiers | undefined,
  itemLevel: number,
  minTierId: string,
  maxTierId: string,
): ItemTiers[number] | undefined {
  if (!tiers || tiers.length === 0) return undefined;
  // Выключенные тиры не выбираются (фолбэк на все, если вдруг всё выключено — чтобы предметы генерились).
  const usable = tiers.filter((t) => t.enabled !== false);
  const sorted = [...(usable.length ? usable : tiers)].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const idOf = (id: string): number => {
    const i = sorted.findIndex((t) => t.id === id);
    return i < 0 ? -1 : i;
  };
  let byLevel = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.minItemLevel <= itemLevel) byLevel = i;
  const loRaw = idOf(minTierId), hiRaw = idOf(maxTierId);
  const lo = loRaw < 0 ? 0 : loRaw;
  const hi = hiRaw < 0 ? sorted.length - 1 : hiRaw;
  const clamped = Math.min(Math.max(byLevel, Math.min(lo, hi)), Math.max(lo, hi));
  return sorted[clamped];
}

function scaleBaseStats(stats: StatModifier[], mult: number): StatModifier[] {
  if (mult === 1) return stats;
  return stats.map((m) =>
    m.kind === 'flat' && TIER_SCALED.has(m.stat) ? { ...m, value: Math.round(m.value * mult) } : m);
}

function scaleReqs(reqs: Item['requirements'], mult: number): Item['requirements'] {
  if (mult === 1) return reqs;
  const out: Item['requirements'] = {};
  for (const [k, v] of Object.entries(reqs)) {
    if (v !== undefined) out[k as keyof Item['requirements']] = Math.round(v * mult);
  }
  return out;
}

/** Согласует прилагательное-тир по роду названия базы (Крепкий → Крепкое/Крепкая/Крепкие). */
function declineTier(adj: string, gender: string | undefined): string {
  if (!adj || gender === 'm' || !gender) return adj;
  const stem = adj.replace(/(ый|ий|ой)$/, '');
  if (stem === adj) return adj; // не прилагательное — как есть
  if (gender === 'f') return stem + 'ая';
  if (gender === 'n') return stem + 'ое';
  if (gender === 'p') return stem + (/[кгхжшчщ]$/.test(stem) ? 'ие' : 'ые');
  return adj;
}

function tieredName(prefix: string, baseName: string, gender?: string): string {
  return prefix ? `${declineTier(prefix, gender)} ${baseName}` : baseName;
}

/** Поля экземпляра, зависящие от вида базы (сужение по kind), включая слот. */
function gearFields(base: ItemsBase[number]): Partial<Item> {
  if (base.kind === 'weapon') {
    return {
      slot: base.slot,
      attackType: base.attackType,
      damageKind: base.damageKind,
      damageType: base.damageType,
      hands: base.hands,
      weaponClass: base.weaponClass,
      weight: base.weight,
      physSub: base.physSub,
      stunChance: base.stunChance,
      armorPenPct: base.armorPenPct,
      arcMult: base.arcMult,
      reachMult: base.reachMult,
      lowHpBonusPct: base.lowHpBonusPct,
      knockback: base.knockback,
    };
  }
  if (base.kind === 'armor') return { slot: base.slot, armorClass: base.armorClass, beltSlots: base.beltSlots };
  if (base.kind === 'shield') return { slot: base.slot, shieldClass: base.shieldClass };
  if (base.kind === 'consumable') return { use: base.use }; // без слота — не экипируется
  return { slot: base.slot }; // jewelry — только слот + baseStats/requirements
}

/** Уровень предмета выводится из minTier (не задаётся руками): порог этого тира. */
function baseItemLevel(base: ItemsBase[number], tiers?: ItemTiers): number {
  return tiers?.find((t) => t.id === base.minTier)?.minItemLevel ?? 1;
}

type Rarities = ConfigShapes['rarities'];

let uidCounter = 0;
function nextUid(): string {
  return `it_${Date.now().toString(36)}_${(uidCounter++).toString(36)}`;
}

/**
 * ЕДИНАЯ сборка Item из базы — весь маппинг полей/сигнатур + масштаб тира в одном
 * месте. Все пути (старт, квест, магазин, дроп, уник) идут через него — без дублей.
 */
function buildItem(
  base: ItemsBase[number],
  o: { rarity: Rarity; name: string; itemLevel: number; statMult: number; reqMult: number; affixes: RolledAffix[] },
): Item {
  return {
    uid: nextUid(),
    baseId: base.id,
    kind: base.kind,
    name: o.name,
    ...gearFields(base),
    rarity: o.rarity,
    itemLevel: o.itemLevel,
    requirements: scaleReqs(base.requirements, o.reqMult),
    baseStats: scaleBaseStats(base.baseStats, o.statMult),
    affixes: o.affixes,
    gridW: base.gridW,
    gridH: base.gridH,
    pos: null,
  };
}

/**
 * Normal-предмет из базы через ЕДИНЫЙ конвейер: тир берётся по itemLevel базы (как
 * у дропа — никаких исключений), имя согласуется по роду. Без аффиксов. `tiers` не
 * передан → базовый тир (×1.0, без префикса).
 */
export function itemFromBase(base: ItemsBase[number], tiers?: ItemTiers): Item {
  const ilvl = baseItemLevel(base, tiers);
  // Расходники не тирятся (нет префикса «Сломанное зелье» и масштаба урона/брони).
  const tier = base.kind === 'consumable' ? undefined : pickTierClamped(tiers, ilvl, base.minTier, base.maxTier);
  return buildItem(base, {
    rarity: 'normal',
    name: tieredName(tier?.name ?? '', base.name, base.gender),
    itemLevel: ilvl,
    statMult: tier?.statMult ?? 1,
    reqMult: tier?.reqMult ?? 1,
    affixes: [],
  });
}

/** Ищет базу по id и создаёт normal-предмет (тир по уровню); null — база не найдена. */
export function itemFromBaseId(itemsBase: ItemsBase, baseId: string, tiers?: ItemTiers): Item | null {
  const base = itemsBase.find((b) => b.id === baseId);
  return base ? itemFromBase(base, tiers) : null;
}

/** Катит редкость с учётом смещения темы (dropBias повышает шанс редких). Пороги —
 * data-driven (rarities.threshold), каскад rarest-first (unique→rare→magic→normal). */
export function rollRarity(dropBias: number, rng: Rng, rarities: Rarities): Rarity {
  const r = rng.next() / Math.max(0.0001, dropBias);
  // Выключенные редкости не роллятся (их порог пропускается — дроп «падает» к следующей доступной).
  const ordered = rarities.filter((x) => x.enabled !== false).sort((a, b) => a.threshold - b.threshold);
  for (const rar of ordered) if (r < rar.threshold) return rar.id;
  return 'normal';
}

/** Катит `count` случайных аффиксов из пула для заданного iLvl (без повторов). */
export function rollAffixes(
  affixes: Affixes,
  count: number,
  itemLevel: number,
  rng: Rng,
): RolledAffix[] {
  const pool = affixes.filter((a) => a.enabled !== false); // выключенные аффиксы не роллятся
  const rolled: RolledAffix[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = rng.int(0, pool.length - 1);
    const [affix] = pool.splice(idx, 1);
    const r = affix ? rollAffix(affix, itemLevel, rng) : null;
    if (r) rolled.push(r);
  }
  return rolled;
}

/** Атрибуты — их бонусы всегда целые (округляем вверх). */
const ATTR_STATS = new Set(['strength', 'dexterity', 'intelligence', 'vitality']);

function rollAffix(
  affix: Affixes[number],
  itemLevel: number,
  rng: Rng,
): RolledAffix | null {
  const eligible = affix.tiers.filter((t) => t.ilvl <= itemLevel);
  if (eligible.length === 0) return null;
  const tier = eligible[eligible.length - 1]!; // лучший доступный тир
  const raw = rng.float(tier.min, tier.max);
  const value = ATTR_STATS.has(affix.stat) ? Math.ceil(raw) : Math.round(raw * 100) / 100;
  return {
    affixId: affix.id,
    kind: affix.kind,
    modifier: { stat: affix.stat, kind: affix.modKind, value },
  };
}

/**
 * Генерирует предмет из базы (или уникум) с учётом редкости, iLvl и ТИРА. По ilvl
 * дропа берётся высший доступный тир (`opts.tiers`): урон/броня базы масштабируются
 * `statMult`, требования — `reqMult`, имя получает префикс тира. Аффиксы — по ilvl.
 */
export function generateItem(
  itemsBase: ItemsBase,
  affixes: Affixes,
  uniques: Uniques,
  opts: { dropBias: number; itemLevel: number; baseId?: string; tiers?: ItemTiers; rarities: Rarities; categoryWeights?: Record<string, number> },
  rng: Rng,
): Item {
  const rarity = rollRarity(opts.dropBias, rng, opts.rarities);
  // Эффективный itemLevel дропа = уровень вызова (глубина/сложность), но не ниже
  // itemLevel самой базы. Влияет на тир (зажатый диапазоном базы), аффиксы, цену.
  const dropIlvl = Math.max(1, Math.round(opts.itemLevel));

  const uniquePool = uniques.filter((u) => u.enabled !== false); // выключенные уники не выпадают
  if (rarity === 'unique' && uniquePool.length > 0) {
    const unique = rng.pick(uniquePool);
    const base = itemsBase.find((b) => b.id === unique.baseId);
    if (base) {
      const ilvl = Math.max(baseItemLevel(base, opts.tiers), dropIlvl);
      const tier = pickTierClamped(opts.tiers, ilvl, base.minTier, base.maxTier);
      return buildItem(base, {
        rarity: 'unique',
        name: unique.name,
        itemLevel: ilvl,
        statMult: tier?.statMult ?? 1,
        reqMult: tier?.reqMult ?? 1,
        affixes: unique.fixedAffixes.map((fa) => ({ affixId: unique.id, kind: fa.kind, modifier: fa.modifier })),
      });
    }
  }

  // Выбор базы: по baseId (магазин/квест), иначе — взвешенно по категориям (`categoryWeights` из
  // balance.loot) × per-item `dropWeight`. Без weights — прежнее поведение (равномерно по экипу).
  // Выключенные базы (enabled:false) не выпадают из случайного дропа (явный baseId — можно).
  const enabledBase = itemsBase.filter((b) => b.enabled !== false);
  const equipPool = enabledBase.filter((b) => b.kind !== 'consumable');
  const base = opts.baseId
    ? itemsBase.find((b) => b.id === opts.baseId) ?? rng.pick(equipPool)
    : opts.categoryWeights
      ? pickDropBase(enabledBase, opts.categoryWeights, rng)
      : rng.pick(equipPool);

  // Расходники (колбы) не роллят редкость/аффиксы/тир — всегда normal.
  const isConsumable = base.kind === 'consumable';
  const ilvl = Math.max(baseItemLevel(base, opts.tiers), dropIlvl);
  const tier = isConsumable ? undefined : pickTierClamped(opts.tiers, ilvl, base.minTier, base.maxTier);
  const effRarity: Rarity = isConsumable ? 'normal' : rarity === 'unique' ? 'rare' : rarity;
  const rDef = opts.rarities.find((x) => x.id === effRarity);
  const count = isConsumable ? 0 : rng.int(rDef?.minAffixes ?? 0, rDef?.maxAffixes ?? 0);
  const rolled = rollAffixes(affixes, count, ilvl, rng);

  return buildItem(base, {
    rarity: effRarity,
    name: tieredName(tier?.name ?? '', base.name, base.gender),
    itemLevel: ilvl,
    statMult: tier?.statMult ?? 1,
    reqMult: tier?.reqMult ?? 1,
    affixes: rolled,
  });
}

/** Взвешенный индекс по массиву весов (роллит `rng.next()`); -1 при нулевой сумме. */
function weightedIndex(weights: number[], rng: Rng): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) return -1;
  let roll = rng.next() * total;
  for (let i = 0; i < weights.length; i++) { roll -= Math.max(0, weights[i]!); if (roll < 0) return i; }
  return weights.length - 1;
}

/**
 * Взвешенный выбор базы дропа в ДВА шага, чтобы доля категории НЕ зависела от числа баз в ней:
 * (1) выбрать КАТЕГОРИЮ по `categoryWeights` (доля категории целиком), (2) внутри — базу по её
 * `dropWeight` (тонкая настройка per-item). Категории с весом 0 или без баз не выпадают; при
 * нулевой сумме — фолбэк на равномерный выбор. Чистая функция.
 */
export function pickDropBase(itemsBase: ItemsBase, categoryWeights: Record<string, number>, rng: Rng): ItemsBase[number] {
  const byKind = new Map<string, ItemsBase[number][]>();
  for (const b of itemsBase) { const arr = byKind.get(b.kind) ?? []; arr.push(b); byKind.set(b.kind, arr); }
  const kinds = [...byKind.keys()].filter((k) => (categoryWeights[k] ?? 0) > 0);
  const ki = weightedIndex(kinds.map((k) => categoryWeights[k] ?? 0), rng);
  if (ki < 0) return rng.pick(itemsBase); // ни одной валидной категории → равномерно
  const pool = byKind.get(kinds[ki]!)!;
  const bi = weightedIndex(pool.map((b) => b.dropWeight ?? 1), rng);
  return pool[bi < 0 ? rng.int(0, pool.length - 1) : bi]!;
}
