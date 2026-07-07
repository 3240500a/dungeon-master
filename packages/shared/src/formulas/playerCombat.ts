import { emptyPacket } from '../types/combat.js';
import { weightScaleSplit } from './resolveWeapon.js';
import type { Attributes, DerivedStats } from '../types/attributes.js';
import type { CombatStats, DamagePacket, DamageType } from '../types/combat.js';
import type { Item, WeaponType } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { Rng } from './rng.js';

type WeaponWeights = ConfigShapes['weapon-weights'];

/** Профильный атрибут по типу оружия (скейл базового урона). */
export const WEAPON_ATTR: Record<WeaponType, keyof Attributes> = {
  melee: 'strength',
  ranged: 'dexterity',
  magic: 'intelligence',
};

export interface TypedRange {
  min: number;
  max: number;
}

/** Вклад атрибутов в урон: мели — по весу (Сила/Ловк доли из weapon-weights), иначе профильный атрибут. */
function attrScaleBonus(
  attrs: Attributes,
  weapon: Item | undefined,
  wt: WeaponType,
  scaling: Record<WeaponType, number>,
  weights: WeaponWeights,
): number {
  if (weapon?.weight && wt === 'melee') {
    const sp = weightScaleSplit(weapon.weight, weights);
    return (attrs.strength * sp.strength + attrs.dexterity * sp.dexterity) * scaling[wt];
  }
  return attrs[weapon?.scaleAttr ?? WEAPON_ATTR[wt]] * scaling[wt];
}

/** Сумма плоского стата из baseStats + аффиксов конкретного предмета. */
export function flatOf(item: Item, stat: string): number {
  let v = 0;
  for (const m of item.baseStats) if (m.stat === stat && m.kind === 'flat') v += m.value;
  for (const a of item.affixes) if (a.modifier.stat === stat && a.modifier.kind === 'flat') v += a.modifier.value;
  return v;
}

/** Боевой стат-блок игрока для resolveAttack из уже посчитанных производных + уровня. */
export function combatStatsOf(d: DerivedStats, level: number): CombatStats {
  return {
    accuracy: d.accuracy,
    evade: d.evade,
    armor: d.armor,
    blockChance: d.blockChance,
    critChance: d.critChance,
    critMultiplier: d.critMultiplier,
    resFire: d.resFire,
    resCold: d.resCold,
    resLightning: d.resLightning,
    resPoison: d.resPoison,
    level,
  };
}

/** Оружие рук для атаки: основное + offhand, если там второе оружие (дуал-вилд). */
export function attackWeaponsOf(save: SaveState): (Item | undefined)[] {
  const main = save.equipment.weapon;
  const off = save.equipment.offhand;
  const hands: (Item | undefined)[] = [main];
  if (off && off.slot === 'weapon') hands.push(off);
  return hands;
}

/**
 * Пакет урона удара рукой: база оружия (в свой damageType) + вклад профильного
 * атрибута → тот же тип + глобальные стихийные добавки (add*). Без оружия — слабый физ.
 */
export function buildAttackPacket(
  d: DerivedStats,
  attrs: Attributes,
  weapon: Item | undefined,
  scaling: Record<WeaponType, number>,
  weights: WeaponWeights,
  rng: Rng,
): DamagePacket {
  const packet = emptyPacket();
  const wt: WeaponType = weapon?.weaponType ?? 'melee';
  const dtype: DamageType = weapon?.damageType ?? 'physical';
  const min = weapon ? Math.max(1, flatOf(weapon, 'minDamage')) : 1;
  const max = weapon ? Math.max(min, flatOf(weapon, 'maxDamage')) : 2;
  const attrBonus = attrScaleBonus(attrs, weapon, wt, scaling, weights);
  packet[dtype] += rng.float(min, max) + attrBonus;

  packet.fire += d.addFire;
  packet.cold += d.addCold;
  packet.lightning += d.addLightning;
  packet.poison += d.addPoison;
  return packet;
}

/** Разбивка урона базовой атаки по типам (без rng) — для листа персонажа/оценок. */
export function attackByType(
  d: DerivedStats,
  attrs: Attributes,
  weapon: Item | undefined,
  scaling: Record<WeaponType, number>,
  weights: WeaponWeights,
): Record<DamageType, TypedRange> {
  const wt: WeaponType = weapon?.weaponType ?? 'melee';
  const dtype: DamageType = weapon?.damageType ?? 'physical';
  const min = weapon ? Math.max(1, flatOf(weapon, 'minDamage')) : 1;
  const max = weapon ? Math.max(min, flatOf(weapon, 'maxDamage')) : 2;
  const attrBonus = attrScaleBonus(attrs, weapon, wt, scaling, weights);

  const out: Record<DamageType, TypedRange> = {
    physical: { min: 0, max: 0 },
    fire: { min: 0, max: 0 },
    cold: { min: 0, max: 0 },
    lightning: { min: 0, max: 0 },
    poison: { min: 0, max: 0 },
  };
  out[dtype].min += min + attrBonus;
  out[dtype].max += max + attrBonus;
  out.fire.min += d.addFire; out.fire.max += d.addFire;
  out.cold.min += d.addCold; out.cold.max += d.addCold;
  out.lightning.min += d.addLightning; out.lightning.max += d.addLightning;
  out.poison.min += d.addPoison; out.poison.max += d.addPoison;
  return out;
}

/** Средний урон удара оружием (без разброса) — для описаний скиллов/скоринга гира. */
export function estimateAttack(
  d: DerivedStats,
  attrs: Attributes,
  weapon: Item | undefined,
  scaling: Record<WeaponType, number>,
  weights: WeaponWeights,
): number {
  const wt: WeaponType = weapon?.weaponType ?? 'melee';
  const min = weapon ? Math.max(1, flatOf(weapon, 'minDamage')) : 1;
  const max = weapon ? Math.max(min, flatOf(weapon, 'maxDamage')) : 2;
  const attrBonus = attrScaleBonus(attrs, weapon, wt, scaling, weights);
  const elemAdd = d.addFire + d.addCold + d.addLightning + d.addPoison;
  return (min + max) / 2 + attrBonus + elemAdd;
}
