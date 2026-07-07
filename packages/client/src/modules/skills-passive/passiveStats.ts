import { passiveTreeModifiers, type ConfigRegistry, type StatModifier, type SkillAllocation } from '@dm/shared';

/**
 * Модификаторы статов от вложенных пассивных узлов (обёртка над чистой
 * `passiveTreeModifiers` из shared). Результат домешивается в GameState.derived().
 */
export function passiveModifiers(
  config: ConfigRegistry,
  allocation: SkillAllocation,
): StatModifier[] {
  return passiveTreeModifiers(config.get('skills-passive'), allocation);
}
