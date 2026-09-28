import type { FloorInit, RunPlan } from '@dm/shared';
import { runNodeLabel } from './runLabels.js';

/**
 * ⭐ C-10: ВЫХОДЫ УЗЛА ЗАБЕГА — интерактивы «[E] Спуститься…» обоих веб-клиентов (2D `OnlineScene`, веб-3D `online3d`), одна истина.
 *
 * Подпись выхода на развилке — тип узла, куда он ведёт (see-ahead: «Спуститься: Лавка»), и берётся она из плана забега (`app.run`, кадр
 * `runPlan`) В МИГ ПОКАЗА, а не на постройке области. Раньше её считали один раз в `buildArea`, а сервер шлёт `joined` и `areaChanged` РАНЬШЕ
 * `runPlan` (город к тому же обнуляет `app.run`): на первом узле каждого забега и после любого (пере)входа все выходы подписывались «Спуститься
 * глубже», пока игрок не сменит этаж, — на развилке он выбирал ветку вслепую (карта забега M показывала граф, а мир — нет).
 */
export interface ExitInteract { readonly x: number; readonly y: number; readonly radius: number; readonly label: string; run: () => void }

/** Подпись `i`-го выхода узла `nodeId` (узел этажа, где стоишь): на развилке (>1 ребро) — тип целевого узла, иначе обычный спуск. */
export function exitLabel(plan: RunPlan | undefined, nodeId: string | undefined, i: number): string {
  const cur = plan?.nodes.find((n) => n.id === nodeId);
  if (cur && cur.edges.length > 1) {
    const to = cur.edges[i]?.to;
    const tn = to ? plan!.nodes.find((n) => n.id === to) : undefined;
    if (tn) return `Спуститься: ${runNodeLabel(tn.type)} (голосование)`;
  }
  return 'Спуститься глубже (голосование)';
}

/**
 * Интерактив `i`-го выхода этажа `floor` в точке `at`. `plan` — ЧТЕНИЕ плана забега (подпись — на каждый показ), `descend` — спуск по `i`-му
 * ребру (клиент читает граф в миг клика).
 */
export function exitInteract(at: { x: number; y: number }, floor: FloorInit, i: number, plan: () => RunPlan | undefined, descend: (i: number) => void): ExitInteract {
  return {
    x: at.x, y: at.y, radius: 34,
    get label(): string { return exitLabel(plan(), floor.runNodeId, i); },
    run: () => descend(i),
  };
}
