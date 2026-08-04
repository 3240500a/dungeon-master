import {
  ATTRIBUTES,
  DEFAULT_HP_MANA_SCALING,
  type Attribute,
  type Attributes,
  type DerivedStats,
  type HpManaScaling,
  type StatModifier,
} from '../types/attributes.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/** Справочные таблицы веса (из конфига) для расчёта массы игрока. */
export interface WeightTables {
  base: number;
  /** shieldClass → вес. */
  shield: Record<string, number>;
  armorClasses: { id: string; weight: number }[];
  weaponWeights: { id: string; weight: number }[];
}

/**
 * Вес (масса) игрока для расталкивания сущностей: база тела + вклад надетого — тип брони
 * (`armor-classes`), класс щита (`balance.weight.shield`), вес оружия (`weapon-weights`).
 * Чистая функция (переиспользует сервер в шаге коллизий).
 */
export function playerWeight(save: SaveState, t: WeightTables): number {
  let w = t.base;
  for (const it of Object.values(save.equipment)) {
    if (!it) continue;
    if (it.kind === 'weapon') w += t.weaponWeights.find((x) => x.id === it.weight)?.weight ?? 0;
    else if (it.kind === 'armor') w += t.armorClasses.find((x) => x.id === it.armorClass)?.weight ?? 0;
    else if (it.kind === 'shield') w += (it.shieldClass ? t.shield[it.shieldClass] : 0) ?? 0;
  }
  return w;
}

/** Собирает все модификаторы из экипировки. */
export function modifiersFromItems(items: Item[]): StatModifier[] {
  const mods: StatModifier[] = [];
  for (const item of items) {
    mods.push(...item.baseStats);
    for (const affix of item.affixes) if (affix.modifier) mods.push(affix.modifier);
  }
  return mods;
}

function isAttribute(stat: string): stat is Attribute {
  return (ATTRIBUTES as string[]).includes(stat);
}

/** Применяет flat/increased модификаторы к базовому значению по имени стата. */
function applyMods(base: number, stat: string, mods: StatModifier[]): number {
  let flat = 0;
  let increased = 0;
  for (const m of mods) {
    if (m.stat !== stat) continue;
    if (m.kind === 'flat') flat += m.value;
    else increased += m.value;
  }
  return (base + flat) * (1 + increased);
}

/** Итоговые атрибуты после модификаторов экипировки/пассивок. */
export function finalAttributes(
  base: Attributes,
  mods: StatModifier[],
): Attributes {
  const out = {} as Attributes;
  for (const attr of ATTRIBUTES) {
    out[attr] = Math.round(applyMods(base[attr], attr, mods));
  }
  return out;
}

/**
 * Производные характеристики из атрибутов и модификаторов.
 * Пулы HP/маны масштабируются per-класс (`scaling`, data-driven) и уровнем;
 * прочие коэффициенты простые — тонкая настройка идёт через balance/аффиксы.
 */
export function deriveStats(
  baseAttributes: Attributes,
  mods: StatModifier[] = [],
  scaling: HpManaScaling = DEFAULT_HP_MANA_SCALING,
  level = 1,
  moveSpeedBase = 120,
): DerivedStats {
  const attr = finalAttributes(baseAttributes, mods);
  const lvlGain = Math.max(0, level - 1); // 1-й уровень без прибавки за уровень

  const base: DerivedStats = {
    maxHp: scaling.hpBase + attr.vitality * scaling.hpPerVitality + lvlGain * scaling.hpPerLevel,
    maxMana: scaling.manaBase + attr.intelligence * scaling.manaPerIntelligence + attr.vitality * scaling.manaPerVitality + lvlGain * scaling.manaPerLevel,
    maxStamina: scaling.staminaBase + attr.strength * scaling.staminaPerStrength + attr.dexterity * scaling.staminaPerDexterity + lvlGain * scaling.staminaPerLevel,
    minDamage: 1,
    maxDamage: 2,
    attackSpeed: 1,
    // Скорость каста растёт от Интеллекта (0.008/ед → 100 INT ≈ ×1.8). Гир может добавить modifier `castSpeed`.
    castSpeed: 1 + attr.intelligence * 0.008,
    critChance: 0.05,
    critMultiplier: 1.5,
    armor: 0,
    armorPen: 0,
    moveSpeed: moveSpeedBase * scaling.moveSpeedMult,
    attackMoveMult: scaling.attackMoveMult,
    accuracy: 20 + attr.dexterity * 2 + lvlGain * scaling.accuracyPerLevel,
    evade: 10 + attr.dexterity * 1.5,
    blockChance: 0,
    addFire: 0,
    addCold: 0,
    addLightning: 0,
    addPoison: 0,
    damagePct: 0,
    physPct: 0,
    firePct: 0,
    coldPct: 0,
    lightningPct: 0,
    poisonPct: 0,
    ailmentPct: 0,
    ailmentDurPct: 0,
    woundChancePct: 0, woundPowerPct: 0, woundDurPct: 0,
    bleedChancePct: 0, bleedPowerPct: 0, bleedDurPct: 0,
    sunderChancePct: 0, sunderPowerPct: 0, sunderDurPct: 0,
    dazeChancePct: 0, dazePowerPct: 0, dazeDurPct: 0,
    burnChancePct: 0, burnPowerPct: 0, burnDurPct: 0,
    poisonChancePct: 0, poisonPowerPct: 0, poisonDurPct: 0,
    shockChancePct: 0, shockPowerPct: 0, shockDurPct: 0,
    freezeChancePct: 0, freezePowerPct: 0, freezeDurPct: 0,
    hpRegen: scaling.hpRegenBase + attr.vitality * scaling.hpRegenPerVitality,
    manaRegen: scaling.manaRegenBase + attr.intelligence * scaling.manaRegenPerIntelligence + attr.vitality * scaling.manaRegenPerVitality,
    staminaRegen: scaling.staminaRegenBase + attr.strength * scaling.staminaRegenPerStrength + attr.dexterity * scaling.staminaRegenPerDexterity,
    resFire: 0,
    resCold: 0,
    resLightning: 0,
    resPoison: 0,
    interruptResist: 0,
    lifeLeechPct: 0,
    manaLeechPct: 0,
    lifeOnKill: 0,
    manaOnKill: 0,
  };

  const out = {} as DerivedStats;
  for (const key of Object.keys(base) as (keyof DerivedStats)[]) {
    out[key] = applyMods(base[key], key, mods);
  }

  // Капы, как в ARPG: сопротивления/крит/блок ограничены.
  out.critChance = clamp(out.critChance, 0, 1);
  out.blockChance = clamp(out.blockChance, 0, 0.75);
  out.interruptResist = clamp(out.interruptResist, 0, 1);
  for (const r of ['resFire', 'resCold', 'resLightning', 'resPoison'] as const) {
    out[r] = clamp(out[r], -0.75, 0.75);
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Полный список стат-ключей (атрибуты + все производные) — единый источник для выпадашки `stat`
 * в редакторе (аффиксы/базовые статы/бафф-зелья). Выводится из DerivedStats, поэтому не дрейфует. */
export function allStatKeys(): string[] {
  const zero: Attributes = { strength: 0, dexterity: 0, intelligence: 0, vitality: 0 };
  return [...ATTRIBUTES, ...Object.keys(deriveStats(zero))];
}

/** Проверяет, хватает ли атрибутов для надевания предмета. */
export function meetsRequirements(item: Item, attrs: Attributes): boolean {
  for (const [attr, req] of Object.entries(item.requirements)) {
    if (req !== undefined && attrs[attr as Attribute] < req) return false;
  }
  return true;
}
