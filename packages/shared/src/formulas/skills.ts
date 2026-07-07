import type { ConfigShapes } from '../config/schemas.js';
import type { StatModifier } from '../types/attributes.js';
import type { SkillAllocation } from '../types/save.js';

/**
 * Чистые функции «дерево + раскладка → модификаторы статов» (модификатор × ранг).
 * Ранее жили в клиенте; вынесены в shared, чтобы их использовал и симулятор
 * (эконом-бот), и клиент (через тонкие обёртки в модулях skills-active/passive),
 * и анти-чит на сервере.
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

/** Модификаторы от вложенных пассивных узлов. */
export function passiveTreeModifiers(
  tree: ConfigShapes['skills-passive'],
  allocation: SkillAllocation,
): StatModifier[] {
  return treeModifiers(tree.nodes, allocation);
}

/** Модификаторы от вложенных узлов активного дерева класса (мастерства). */
export function activeTreeModifiers(
  trees: ConfigShapes['skills-active'],
  classId: string,
  allocation: SkillAllocation,
): StatModifier[] {
  const tree = trees.find((t) => t.classId === classId);
  return tree ? treeModifiers(tree.nodes, allocation) : [];
}

/** Триггер мастерства, отскейленный рангом узла (готов к применению в бою). */
type Trigger = NonNullable<ConfigShapes['skills-active'][number]['nodes'][number]['effect']['triggers']>[number];
export interface ResolvedTrigger {
  on: Trigger['on'];
  condition?: Trigger['condition'];
  bonusDamagePct?: number;
  reflectPct?: number;
  reflectElement?: string;
  damageTakenReductionPct?: number;
}

/**
 * Реактивные триггеры игрока из активного дерева (мастерства): числовые эффекты
 * масштабируются рангом узла. Условия (по цели/себе/toglу) проверяются в бою.
 */
export function playerTriggers(
  trees: ConfigShapes['skills-active'],
  classId: string,
  allocation: SkillAllocation,
): ResolvedTrigger[] {
  const tree = trees.find((t) => t.classId === classId);
  if (!tree) return [];
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
 * Условные «сет»-моды: узел даёт бонус, только если надет комплект брони одного
 * класса (напр. «полный латный доспех»). Моды масштабируются рангом узла.
 */
export function setBonusModifiers(
  trees: ConfigShapes['skills-active'],
  classId: string,
  allocation: SkillAllocation,
  equipped: { armorClass?: string }[],
): StatModifier[] {
  const tree = trees.find((t) => t.classId === classId);
  if (!tree) return [];
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
