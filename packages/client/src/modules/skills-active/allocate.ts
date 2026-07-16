import type { ConfigRegistry, SkillTree } from '@dm/shared';
import type { GameState } from '../../core/gameState.js';

export interface AllocResult {
  ok: boolean;
  reason?: string;
}

/** Единое ДРЕВО СКИЛОВ (общее для всех; класс-ветки гейтятся по classId при аллокации/использовании). */
export function activeTreeFor(config: ConfigRegistry): SkillTree {
  return config.get('skill-tree');
}

function rankOf(state: GameState, nodeId: string): number {
  return state.save.activeSkills[nodeId] ?? 0;
}

function neighbors(tree: SkillTree, id: string): string[] {
  const out: string[] = [];
  for (const [a, b] of tree.edges) { if (a === id) out.push(b); else if (b === id) out.push(a); }
  return out;
}

/**
 * Локальное предсказание вложения очка в узел древа скилов (авторитет — сервер). Доступность —
 * по смежности от входа ветки; класс-ветка — только своему классу. При первом вложении активный
 * узел ставится в первый свободный слот хотбара.
 */
export function allocateActive(
  config: ConfigRegistry,
  state: GameState,
  nodeId: string,
): AllocResult {
  const tree = activeTreeFor(config);
  const node = tree.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: 'Узел не найден' };
  const branch = tree.branches.find((b) => b.id === node.branchId);
  if (branch?.classId && branch.classId !== state.save.classId) return { ok: false, reason: 'Ветка другого класса' };

  const rank = rankOf(state, nodeId);
  if (rank >= node.maxRank) return { ok: false, reason: 'Максимальный ранг' };
  if (state.save.level < node.levelReq) return { ok: false, reason: `Требуется уровень ${node.levelReq}` };
  const allocatable = rank > 0 || tree.entryNodes.includes(nodeId) || neighbors(tree, nodeId).some((n) => rankOf(state, n) > 0);
  if (!allocatable) return { ok: false, reason: 'Недоступен: нет входа или смежного узла' };
  if (node.cost.type !== 'points') return { ok: false, reason: 'Неверный тип стоимости' };
  if (state.save.unspentSkillPoints < node.cost.amount) return { ok: false, reason: 'Недостаточно очков скиллов' };

  state.save.unspentSkillPoints -= node.cost.amount;
  state.save.activeSkills[nodeId] = rank + 1;

  if (rank === 0 && node.effect.active) {
    const slot = state.save.hotbar.findIndex((s) => s === null);
    if (slot >= 0) state.save.hotbar[slot] = nodeId;
  }
  return { ok: true };
}

/** Привязывает активный узел к слоту хотбара. */
export function bindHotbar(state: GameState, slot: number, nodeId: string | null): void {
  if (slot < 0 || slot >= state.save.hotbar.length) return;
  state.save.hotbar[slot] = nodeId;
}
