import type { RunNodeType } from '@dm/shared';

/**
 * Единые русские подписи и цвета типов узлов забега (v2). Используются рендером выходов
 * (2D `OnlineScene`/3D `online3d`), миникартой и панелью «Карта забега» — одна истина.
 */
export const RUN_NODE_LABEL: Record<RunNodeType, string> = {
  start: 'Вход',
  combat: 'Бой',
  elite: 'Чемпионы',
  boss: 'Босс',
  treasure: 'Сокровищница',
  event: 'Событие',
  shop: 'Лавка',
  rest: 'Привал',
  finale: 'Финал',
};

export const RUN_NODE_COLOR: Record<RunNodeType, number> = {
  start: 0x9fd0ff,
  combat: 0x8a8f9a,
  elite: 0xd0a040,
  boss: 0xd05050,
  treasure: 0xf0d070,
  event: 0x70b0f0,
  shop: 0x4a8f6a,
  rest: 0x8a5cff,
  finale: 0xff5c8a,
};

export function runNodeLabel(t: string): string {
  return RUN_NODE_LABEL[t as RunNodeType] ?? t;
}
export function runNodeColor(t: string): number {
  return RUN_NODE_COLOR[t as RunNodeType] ?? 0x8a8f9a;
}
