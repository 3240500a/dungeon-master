import type { RunPlan } from './types.js';
import type { RunNodeType } from '../../config/schemas.js';
import { waypointGap, type WaypointPlaces } from '../../formulas/power.js';
import { tr } from '../../i18n/tr.js';

/**
 * ⭐ С1 (29.10): ПОДПИСИ ЗАБЕГА — ОДНА ИСТИНА ДЛЯ СЕРВЕРА И ВСЕХ КЛИЕНТОВ. Жили в веб-клиенте (`client/modules/run/runLabels.ts`,
 * `runExits.ts`), и серверный сторож окна плана (`room.g2window.test.ts`) брал их оттуда относительным путём: сервер не проверялся без
 * веб-клиента. Текст — здесь; цвета узлов (показ) остались у клиента.
 */
export const RUN_NODE_LABEL: Record<RunNodeType, string> = {
  get start() { return tr('srv:runNode.start', 'Вход'); },
  get combat() { return tr('srv:runNode.combat', 'Бой'); },
  get elite() { return tr('srv:runNode.elite', 'Элита'); },
  get boss() { return tr('srv:runNode.boss', 'Босс'); },
  get treasure() { return tr('srv:runNode.treasure', 'Сокровищница'); },
  get rest() { return tr('srv:runNode.rest', 'Привал'); },
};

export function runNodeLabel(t: string): string {
  return RUN_NODE_LABEL[t as RunNodeType] ?? t;
}

/**
 * ⭐ Г3 (В6): строка HUD про метку. Арифметику считает `waypointGap` (та же каденция, что у генератора).
 * ⚠ Без склонения намеренно («до метки 2 эт.»): шаг каденции — число баланса, падежи пришлось бы считать на каждом кадре HUD.
 */
export function waypointHint(depth: number, places: WaypointPlaces, cycle: number): string {
  const gap = waypointGap(depth, places, cycle);
  return gap === 0 ? tr('srv:run.waypointHere', 'метка здесь') : tr('srv:run.waypointGap', 'до метки {gap} эт.', { gap });
}

/**
 * ⭐⭐ Г8-2 (15.10): подпись лестницы боссов — «5 · 14 · 20 полосы». Лестница живёт в данных (`balance.dungeonAccess.bossLadder`).
 * ⚠ Определена всюду: её зовут и на синтетических конфигах стендов, где `dungeonAccess` собран частично. Нет лестницы — «нет».
 */
export function bossLadderText(ladder: readonly { at: number; rank: string }[] | undefined | null): string {
  const at = (Array.isArray(ladder) ? ladder : [])
    .map((x) => Math.floor(Number(x?.at)))
    .filter((x) => Number.isFinite(x) && x >= 1)
    .sort((a, b) => a - b);
  return at.length ? tr('srv:run.bossLadder', '{at} полосы', { at: at.join(' · ') }) : tr('srv:run.bossLadderNone', 'нет');
}

/**
 * ⭐ C-10: подпись `i`-го выхода узла `nodeId` (узел этажа, где стоишь): на развилке (>1 ребро) — тип целевого узла (see-ahead:
 * «Спуститься: Лавка»), иначе обычный спуск. Берётся из плана забега В МИГ ПОКАЗА.
 */
export function exitLabel(plan: RunPlan | undefined, nodeId: string | undefined, i: number): string {
  const cur = plan?.nodes.find((n) => n.id === nodeId);
  if (cur && cur.edges.length > 1) {
    const to = cur.edges[i]?.to;
    const tn = to ? plan!.nodes.find((n) => n.id === to) : undefined;
    if (tn) return tr('srv:run.exitTo', 'Спуститься: {type} (голосование)', { type: runNodeLabel(tn.type) });
  }
  return tr('srv:run.exitDeeper', 'Спуститься глубже (голосование)');
}
