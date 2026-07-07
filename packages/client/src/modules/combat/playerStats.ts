import {
  attackByType,
  attackWeaponsOf,
  buildAttackPacket,
  combatStatsOf,
  estimateAttack,
  type Attributes,
  type CombatStats,
  type ConfigShapes,
  type DamagePacket,
  type DamageType,
  type Item,
  type Rng,
  type TypedRange,
  type WeaponType,
} from '@dm/shared';
import type { GameState } from '../../core/gameState.js';

type WeaponWeights = ConfigShapes['weapon-weights'];

export type { TypedRange };

/**
 * Тонкие обёртки над чистыми функциями боя игрока из `@dm/shared` (playerCombat).
 * GameState даёт производные/атрибуты (с учётом гира+скиллов), сам матан — в shared,
 * чтобы симулятор считал урон ровно так же. Сигнатуры сохранены для вызывающих.
 */

/** Боевой стат-блок игрока для resolveAttack. */
export function playerCombatStats(state: GameState): CombatStats {
  return combatStatsOf(state.derived(), state.save.level);
}

/** Оружие рук для атаки: основное + offhand, если там второе оружие (дуал-вилд). */
export function attackWeapons(state: GameState): (Item | undefined)[] {
  return attackWeaponsOf(state.save);
}

/** Тип атаки (паттерн ЛКМ) — по основному оружию. */
export function playerWeaponType(state: GameState): WeaponType {
  return state.save.equipment.weapon?.weaponType ?? 'melee';
}

/** Пакет урона для удара конкретной рукой (см. buildAttackPacket в shared). */
export function buildWeaponPacket(
  state: GameState,
  weapon: Item | undefined,
  scaling: Record<WeaponType, number>,
  weights: WeaponWeights,
  rng: Rng,
): DamagePacket {
  return buildAttackPacket(state.derived(), state.effectiveAttributes(), weapon, scaling, weights, rng);
}

/** Разбивка урона базовой атаки по типам; attrsOverride — для превью (лист персонажа). */
export function attackDamageByType(
  state: GameState,
  scaling: Record<WeaponType, number>,
  weights: WeaponWeights,
  attrsOverride?: Attributes,
): Record<DamageType, TypedRange> {
  return attackByType(
    state.derived(),
    attrsOverride ?? state.effectiveAttributes(),
    state.save.equipment.weapon,
    scaling,
    weights,
  );
}

/** Средний урон удара оружием (без разброса) — для оценок в описаниях скиллов. */
export function estimateWeaponDamage(
  state: GameState,
  weapon: Item | undefined,
  scaling: Record<WeaponType, number>,
  weights: WeaponWeights,
): number {
  return estimateAttack(state.derived(), state.effectiveAttributes(), weapon, scaling, weights);
}
