import { skillTreeModifiers, type ConfigRegistry, type StatModifier, type SkillAllocation } from '@dm/shared';

/**
 * Модификаторы статов от вложенных узлов ЕДИНОГО древа скилов (пассив-узлы + мастерства
 * на активках) — обёртка над чистой `skillTreeModifiers` из shared. Класс больше не нужен:
 * древо общее (гейт класс-веток — при использовании, не в статах).
 */
export function activeModifiers(
  config: ConfigRegistry,
  allocation: SkillAllocation,
): StatModifier[] {
  return skillTreeModifiers(config.get('skill-tree'), allocation);
}
