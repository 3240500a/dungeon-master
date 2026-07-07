import type { ConfigRegistry, ActiveSkillTree, SkillNode } from '@dm/shared';
import type { GameState } from '../../core/gameState.js';

export interface AllocResult {
  ok: boolean;
  reason?: string;
}

/** Активное дерево класса игрока. */
export function activeTreeFor(
  config: ConfigRegistry,
  classId: string,
): ActiveSkillTree | undefined {
  return config.get('skills-active').find((t) => t.classId === classId);
}

function rankOf(state: GameState, nodeId: string): number {
  return state.save.activeSkills[nodeId] ?? 0;
}

function prereqsMet(state: GameState, node: SkillNode): boolean {
  return node.requires.every((r) => rankOf(state, r) > 0);
}

/**
 * Вкладывает очко в активный узел класса. Стоимость — очки скиллов. При первом
 * вложении способность автоматически ставится в первый свободный слот хотбара.
 */
export function allocateActive(
  config: ConfigRegistry,
  state: GameState,
  nodeId: string,
): AllocResult {
  const tree = activeTreeFor(config, state.save.classId);
  const node = tree?.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: 'Узел не найден' };

  const rank = rankOf(state, nodeId);
  if (rank >= node.maxRank) return { ok: false, reason: 'Максимальный ранг' };
  if (state.save.level < node.levelReq)
    return { ok: false, reason: `Требуется уровень ${node.levelReq}` };
  if (!prereqsMet(state, node)) return { ok: false, reason: 'Не выполнены требования' };
  if (node.cost.type !== 'points')
    return { ok: false, reason: 'Неверный тип стоимости' };
  if (state.save.unspentSkillPoints < node.cost.amount)
    return { ok: false, reason: 'Недостаточно очков скиллов' };

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
