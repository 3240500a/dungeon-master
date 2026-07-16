import type { ConfigShapes } from '../config/schemas.js';
import type { StatModifier } from '../types/attributes.js';
import type { SkillAllocation } from '../types/save.js';

/**
 * Чистые функции «дерево + раскладка → модификаторы статов» (модификатор × ранг).
 * Единое ДРЕВО СКИЛОВ (актив + пассив) общее для всех; модификаторы дают и пассивные
 * узлы, и мастерства на активных. Древо МАСТЕРСТВА — отдельная функция (passiveTreeModifiers).
 * Переиспользуется клиентом/сервером/симулятором одинаково.
 */
function treeModifiers(
  nodes: { id: string; effect: { modifiers?: StatModifier[] } }[],
  allocation: SkillAllocation,
): StatModifier[] {
  const mods: StatModifier[] = [];
  for (const node of nodes) {
    const rank = allocation[node.id] ?? 0;
    if (rank <= 0) continue;
    for (const m of node.effect.modifiers ?? []) {
      mods.push({ stat: m.stat, kind: m.kind, value: m.value * rank });
    }
  }
  return mods;
}

/** Модификаторы от вложенных узлов древа мастерства (бывшая пассивка). */
export function passiveTreeModifiers(
  tree: ConfigShapes['skills-passive'],
  allocation: SkillAllocation,
): StatModifier[] {
  return treeModifiers(tree.nodes, allocation);
}

/** Модификаторы от вложенных узлов ДРЕВА СКИЛОВ (пассив-узлы + мастерства на активках). */
export function skillTreeModifiers(
  tree: ConfigShapes['skill-tree'],
  allocation: SkillAllocation,
): StatModifier[] {
  return treeModifiers(tree.nodes, allocation);
}

/** Триггер мастерства, отскейленный рангом узла (готов к применению в бою). */
type Trigger = NonNullable<ConfigShapes['skill-tree']['nodes'][number]['effect']['triggers']>[number];
export interface ResolvedTrigger {
  on: Trigger['on'];
  condition?: Trigger['condition'];
  bonusDamagePct?: number;
  reflectPct?: number;
  reflectElement?: string;
  damageTakenReductionPct?: number;
}

/**
 * Реактивные триггеры игрока из ДРЕВА СКИЛОВ: числовые эффекты масштабируются рангом узла.
 * Условия (по цели/себе/toglу) проверяются в бою.
 */
export function skillTreeTriggers(
  tree: ConfigShapes['skill-tree'],
  allocation: SkillAllocation,
): ResolvedTrigger[] {
  const out: ResolvedTrigger[] = [];
  for (const node of tree.nodes) {
    const rank = allocation[node.id] ?? 0;
    if (rank <= 0) continue;
    for (const tr of node.effect.triggers ?? []) {
      const e = tr.effect;
      out.push({
        on: tr.on,
        condition: tr.condition,
        bonusDamagePct: e.bonusDamagePct != null ? e.bonusDamagePct * rank : undefined,
        reflectPct: e.reflectPct != null ? e.reflectPct * rank : undefined,
        reflectElement: e.reflectElement,
        damageTakenReductionPct: e.damageTakenReductionPct != null ? e.damageTakenReductionPct * rank : undefined,
      });
    }
  }
  return out;
}

/**
 * Условные «сет»-моды: узел даёт бонус, только если надет комплект брони одного класса.
 * Моды масштабируются рангом узла.
 */
export function skillTreeSetBonus(
  tree: ConfigShapes['skill-tree'],
  allocation: SkillAllocation,
  equipped: { armorClass?: string }[],
): StatModifier[] {
  const mods: StatModifier[] = [];
  for (const node of tree.nodes) {
    const rank = allocation[node.id] ?? 0;
    const set = node.effect.setBonus;
    if (rank <= 0 || !set) continue;
    const worn = equipped.filter((it) => it.armorClass === set.requireArmorClass).length;
    if (worn < set.minPieces) continue;
    for (const m of set.mods) mods.push({ stat: m.stat, kind: m.kind, value: m.value * rank });
  }
  return mods;
}
