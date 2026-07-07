import { activeTreeModifiers, type ConfigRegistry, type StatModifier, type SkillAllocation } from '@dm/shared';

/**
 * Модификаторы статов от вложенных узлов активного дерева класса (мастерства) —
 * обёртка над чистой `activeTreeModifiers` из shared. Активные способности
 * (effect.active) статы не меняют, только `effect.modifiers`.
 */
export function activeModifiers(
  config: ConfigRegistry,
  classId: string,
  allocation: SkillAllocation,
): StatModifier[] {
  return activeTreeModifiers(config.get('skills-active'), classId, allocation);
}
