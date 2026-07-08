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
    for (const affix of item.affixes) mods.push(affix.modifier);
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
): DerivedStats {
  const attr = finalAttributes(baseAttributes, mods);
  const lvlGain = Math.max(0, level - 1); // 1-й уровень без прибавки за уровень

  const base: DerivedStats = {
    maxHp: scaling.hpBase + attr.vitality * scaling.hpPerVitality + lvlGain * scaling.hpPerLevel,
    maxMana: scaling.manaBase + attr.intelligence * scaling.manaPerIntelligence + lvlGain * scaling.manaPerLevel,
    minDamage: 1,
    maxDamage: 2,
    attackSpeed: 1,
    critChance: 0.05,
    critMultiplier: 1.5,
    armor: 0,
    moveSpeed: 120,
    accuracy: 20 + attr.dexterity * 2 + lvlGain * scaling.accuracyPerLevel,
    evade: 10 + attr.dexterity * 1.5,
    blockChance: 0,
    addFire: 0,
    addCold: 0,
    addLightning: 0,
    addPoison: 0,
    hpRegen: 0.5 + attr.vitality * 0.05,
    manaRegen: 0.5 + attr.intelligence * 0.05,
    resFire: 0,
    resCold: 0,
    resLightning: 0,
    resPoison: 0,
    interruptResist: 0,
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

/** Проверяет, хватает ли атрибутов для надевания предмета. */
export function meetsRequirements(item: Item, attrs: Attributes): boolean {
  for (const [attr, req] of Object.entries(item.requirements)) {
    if (req !== undefined && attrs[attr as Attribute] < req) return false;
  }
  return true;
}
