import type { RunNodeType } from '@dm/shared';
// ⭐ С1: подписи забега переехали в `@dm/shared` (`dungeon/run/labels.ts`) — их читает и сервер; здесь только цвета показа.
export { RUN_NODE_LABEL, runNodeLabel, waypointHint, bossLadderText } from '@dm/shared';

/**
 * Единые русские подписи и цвета типов узлов забега (v2). Используются рендером выходов
 * (2D `OnlineScene`/3D `online3d`), миникартой и панелью «Карта забега» — одна истина.
 */
export const RUN_NODE_COLOR: Record<RunNodeType, number> = {
  start: 0x9fd0ff,
  combat: 0x8a8f9a,
  elite: 0xd0a040,
  boss: 0xd05050,
  treasure: 0xf0d070,
  rest: 0x8a5cff,
};

export function runNodeColor(t: string): number {
  return RUN_NODE_COLOR[t as RunNodeType] ?? 0x8a8f9a;
}
