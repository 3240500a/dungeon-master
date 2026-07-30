import { DAMAGE_TYPES, emptyPacket } from '../types/combat.js';
import { weightScaleSplit } from './resolveWeapon.js';
import type { Attributes, DerivedStats } from '../types/attributes.js';
import type { CombatStats, DamagePacket, DamageType } from '../types/combat.js';
import type { Item, AttackType } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { Rng } from './rng.js';

type WeaponWeights = ConfigShapes['weapon-weights'];

/** Фолбэк-атрибут по типу атаки (безоружка/без веса). Реальный скейл задаёт вес оружия. */
export const WEAPON_ATTR: Record<AttackType, keyof Attributes> = {
  melee: 'strength',
  ranged: 'dexterity',
};

export interface TypedRange {
  min: number;
  max: number;
}

/**
 * Вклад атрибутов в урон. **Мели И дальний скейлятся по ВЕСУ оружия** (доли Сила/Ловк из `weapon-weights`:
 * тяжёлое→Сила, лёгкое→Ловк, промежуточные — между). **Магия — Интеллект.** Без оружия/веса — профильный
 * атрибут типа (`WEAPON_ATTR`). Отдельного `scaleAttr` у оружия НЕТ — скейл задаёт тип веса.
 */
function attrScaleBonus(
  attrs: Attributes,
  weapon: Item | undefined,
  at: AttackType,
  scaling: number,
  weights: WeaponWeights,
): number {
  if (weapon?.weight) {
    const sp = weightScaleSplit(weapon.weight, weights);
    return (attrs.strength * sp.strength + attrs.dexterity * sp.dexterity + attrs.intelligence * sp.intelligence) * scaling;
  }
  return attrs[WEAPON_ATTR[at]] * scaling;   // безоружка — фолбэк-атрибут типа атаки
}

/** Сумма плоского стата из baseStats + аффиксов конкретного предмета. */
export function flatOf(item: Item, stat: string): number {
  let v = 0;
  for (const m of item.baseStats) if (m.stat === stat && m.kind === 'flat') v += m.value;
  for (const a of item.affixes) if (a.modifier.stat === stat && a.modifier.kind === 'flat') v += a.modifier.value;
  return v;
}

/** Виды статусов для per-kind ailment-статов. */
const AILMENT_KINDS = ['wound', 'bleed', 'sunder', 'daze', 'burn', 'poison', 'shock', 'freeze'] as const;

/** Боевой стат-блок игрока для resolveAttack из уже посчитанных производных + уровня. */
export function combatStatsOf(d: DerivedStats, level: number): CombatStats {
  const num = (k: string): number => (d[k as keyof DerivedStats] as number) || 0;
  const chance: Record<string, number> = {}, power: Record<string, number> = {}, dur: Record<string, number> = {};
  for (const k of AILMENT_KINDS) {
    chance[k] = num(`${k}ChancePct`);                 // per-kind шанс (глобальный ailmentPct добавляет resolvePlayerHit)
    power[k] = num(`${k}PowerPct`);                    // per-kind сила
    dur[k] = d.ailmentDurPct + num(`${k}DurPct`);      // длительность = глобальная + per-kind
  }
  return {
    accuracy: d.accuracy,
    armorPen: d.armorPen,
    evade: d.evade,
    armor: d.armor,
    blockChance: d.blockChance,
    critChance: d.critChance,
    critMultiplier: d.critMultiplier,
    resFire: d.resFire,
    resCold: d.resCold,
    resLightning: d.resLightning,
    resPoison: d.resPoison,
    ailmentPct: d.ailmentPct,
    ailment: { chance, power, dur },
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

/** Множитель исходящего урона по типу: общий `damagePct` + свой `*Pct` (складываются). */
export function damageMultOf(d: DerivedStats, t: DamageType): number {
  const per: Record<DamageType, number> = {
    physical: d.physPct,
    fire: d.firePct,
    cold: d.coldPct,
    lightning: d.lightningPct,
    poison: d.poisonPct,
  };
  return 1 + d.damagePct + per[t];
}

/** Умножает пакет по типам на `damageMultOf` (мутирует и возвращает его же). */
function applyDamagePct(p: DamagePacket, d: DerivedStats): DamagePacket {
  for (const t of DAMAGE_TYPES) p[t] *= damageMultOf(d, t);
  return p;
}

/**
 * Пакет урона удара рукой: база оружия (в свой damageType) + вклад профильного
 * атрибута → тот же тип + глобальные стихийные добавки (add*). Без оружия — слабый физ.
 * В конце — множители исходящего урона (`damagePct`/`*Pct` из пассивок/гира).
 */
export function buildAttackPacket(
  d: DerivedStats,
  attrs: Attributes,
  weapon: Item | undefined,
  scaling: number,
  weights: WeaponWeights,
  rng: Rng,
): DamagePacket {
  const packet = emptyPacket();
  const at: AttackType = weapon?.attackType ?? 'melee';
  const dtype: DamageType = weapon?.damageType ?? 'physical';
  const min = weapon ? Math.max(1, flatOf(weapon, 'minDamage')) : 1;
  const max = weapon ? Math.max(min, flatOf(weapon, 'maxDamage')) : 2;
  const attrBonus = attrScaleBonus(attrs, weapon, at, scaling, weights);
  packet[dtype] += rng.float(min, max) + attrBonus;

  packet.fire += d.addFire;
  packet.cold += d.addCold;
  packet.lightning += d.addLightning;
  packet.poison += d.addPoison;
  return applyDamagePct(packet, d);
}

/** Разбивка урона базовой атаки по типам (без rng) — для листа персонажа/оценок. */
export function attackByType(
  d: DerivedStats,
  attrs: Attributes,
  weapon: Item | undefined,
  scaling: number,
  weights: WeaponWeights,
): Record<DamageType, TypedRange> {
  const at: AttackType = weapon?.attackType ?? 'melee';
  const dtype: DamageType = weapon?.damageType ?? 'physical';
  const min = weapon ? Math.max(1, flatOf(weapon, 'minDamage')) : 1;
  const max = weapon ? Math.max(min, flatOf(weapon, 'maxDamage')) : 2;
  const attrBonus = attrScaleBonus(attrs, weapon, at, scaling, weights);

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
  for (const t of DAMAGE_TYPES) {
    const m = damageMultOf(d, t);
    out[t].min *= m; out[t].max *= m;
  }
  return out;
}

/** Средний урон удара оружием (без разброса) — для описаний скиллов/скоринга гира. */
export function estimateAttack(
  d: DerivedStats,
  attrs: Attributes,
  weapon: Item | undefined,
  scaling: number,
  weights: WeaponWeights,
): number {
  const at: AttackType = weapon?.attackType ?? 'melee';
  const dtype: DamageType = weapon?.damageType ?? 'physical';
  const min = weapon ? Math.max(1, flatOf(weapon, 'minDamage')) : 1;
  const max = weapon ? Math.max(min, flatOf(weapon, 'maxDamage')) : 2;
  const attrBonus = attrScaleBonus(attrs, weapon, at, scaling, weights);
  // Каждый тип — со своим множителем (damagePct + свой *Pct), как в реальном пакете.
  return (
    ((min + max) / 2 + attrBonus) * damageMultOf(d, dtype) +
    d.addFire * damageMultOf(d, 'fire') +
    d.addCold * damageMultOf(d, 'cold') +
    d.addLightning * damageMultOf(d, 'lightning') +
    d.addPoison * damageMultOf(d, 'poison')
  );
}
