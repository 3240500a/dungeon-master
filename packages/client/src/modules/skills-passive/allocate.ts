import type { App } from '../../core/app.js';
import type { GameState } from '../../core/gameState.js';
import { passiveEntriesFor, type PassiveSkillTree } from '@dm/shared';
import type { AllocResult } from '../skills-active/allocate.js';

function rankOf(state: GameState, nodeId: string): number {
  return state.save.passiveSkills[nodeId] ?? 0;
}

/** Соседи узла по неориентированным рёбрам. */
export function neighborsOf(tree: PassiveSkillTree, nodeId: string): string[] {
  const out: string[] = [];
  for (const [a, b] of tree.edges) {
    if (a === nodeId) out.push(b);
    else if (b === nodeId) out.push(a);
  }
  return out;
}

/**
 * Узел доступен к прокачке, если он входной ИЛИ смежен (по ребру) с уже вложенным
 * узлом — как в дереве пассивок PoE. Первый ранг «раскрывает» соседей.
 */
export function isAllocatable(
  tree: PassiveSkillTree,
  state: GameState,
  nodeId: string,
  allowedEntries?: string[],
): boolean {
  if (rankOf(state, nodeId) > 0) return true; // уже начат — можно докачивать
  // Вход доступен, только если он в наборе класса (`allowedEntries`); без набора — любой вход.
  if ((allowedEntries ?? tree.entryNodes).includes(nodeId)) return true;
  return neighborsOf(tree, nodeId).some((n) => rankOf(state, n) > 0);
}

/** Цена следующего ранга: base × mult^текущий_ранг (геометрический рост, адаптивно). */
export function passiveNodeCost(baseAmount: number, currentRank: number, mult: number): number {
  return Math.round(baseAmount * Math.pow(mult, currentRank));
}

/**
 * Вкладывает ранг в пассивный узел общего дерева. Стоимость — ЗОЛОТО (растёт
 * геометрически с рангом, balance.passiveRankCostMult) + 1 ОЧКО пассивов
 * (unspentPassivePoints, 2/уровень). Правило — смежность (входной или сосед уже
 * вложен). Модификаторы применяются через GameState.derived() (passiveStats.ts).
 */
export function allocatePassive(
  app: App,
  state: GameState,
  nodeId: string,
): AllocResult {
  const tree = app.config.get('skills-passive');
  const node = tree.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: 'Узел не найден' };

  const rank = rankOf(state, nodeId);
  if (rank >= node.maxRank) return { ok: false, reason: 'Максимальный ранг' };
  if (!isAllocatable(tree, state, nodeId, passiveEntriesFor(app.config, state.save)))
    return { ok: false, reason: 'Недоступный вход или нет смежного узла' };
  if (node.cost.type !== 'gold') return { ok: false, reason: 'Неверный тип стоимости' };
  if (state.save.unspentPassivePoints < 1) return { ok: false, reason: 'Нет очков пассивов' };

  const mult = app.config.get('balance').passiveRankCostMult;
  const cost = passiveNodeCost(node.cost.amount, rank, mult);
  if (state.save.gold < cost) return { ok: false, reason: 'Недостаточно золота' };

  state.save.gold -= cost;
  state.save.unspentPassivePoints -= 1;
  state.save.passiveSkills[nodeId] = rank + 1;
  return { ok: true };
}
