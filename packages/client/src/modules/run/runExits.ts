import { exitLabel, type FloorInit, type RunPlan } from '@dm/shared';
// ⭐ С1: подпись выхода — `@dm/shared` (её читает и сервер).
export { exitLabel } from '@dm/shared';

/**
 * ⭐ C-10: ВЫХОДЫ УЗЛА ЗАБЕГА — интерактивы «[E] Спуститься…» обоих веб-клиентов (2D `OnlineScene`, веб-3D `online3d`), одна истина.
 *
 * Подпись выхода на развилке — тип узла, куда он ведёт (see-ahead: «Спуститься: Лавка»), и берётся она из плана забега (`app.run`, кадр
 * `runPlan`) В МИГ ПОКАЗА, а не на постройке области. Раньше её считали один раз в `buildArea`, а сервер шлёт `joined` и `areaChanged` РАНЬШЕ
 * `runPlan` (город к тому же обнуляет `app.run`): на первом узле каждого забега и после любого (пере)входа все выходы подписывались «Спуститься
 * глубже», пока игрок не сменит этаж, — на развилке он выбирал ветку вслепую (карта забега M показывала граф, а мир — нет).
 */
export interface ExitInteract { readonly x: number; readonly y: number; readonly radius: number; readonly label: string; run: () => void }

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
