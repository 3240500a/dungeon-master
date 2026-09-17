/**
 * ОКНО-CULLING ЖИВОГО МОНСТРА: спать или нет. Кадр одного монстра из лупа `online3d.ts`.
 *
 * Вынесен (как `driveActor` / `corpseFrame`), чтобы сон и пробуждение жили под сторожем на живом Jolt
 * (`windowCull.test.ts`: кадр online3d целиком — окно, нокдаун, смерть, коллапс трупа). Модуль не знает ни сцены, ни
 * снапшота: окно (`inWin`) и окно с полосой гистерезиса (`inBand`) считает клиент.
 *
 * Инвариант: `a.dormant` === «кукла спит» (`setSimEnabled(false)`). Будить куклу мимо этого флага нельзя — луп её
 * больше не поведёт (так было с нокдауном: `knockdown` будил спящую, флаг оставался true, часы нокдауна стояли, тела
 * лежали в `pw.step` за окном, а смерть без удара падала с места нокдауна — ЗАМЕР в `gamePlayerDoll`). Теперь нокдаун
 * спящую не будит; будит только этот шов и смерть (`corpseStart`, флаг там же).
 */

export interface CullDoll { update(dt: number): void; setSimEnabled?(on: boolean): void }
/** Монстр у клиента: `dormant` — кукла спит (тела вне `pw.step`, меш заморожен). */
export interface CullActor { d: CullDoll; dormant?: boolean }
/** Бюджет на кадр, общий на весь луп (тратится): `wake` — пробуждений (AddToPhysicsSystem — спайк у пачки). */
export interface CullBudget { wake: number }

/**
 * Кадр живого монстра. Спящего будим строго по входу в окно (`inWin`) и в пределах бюджета; бодрствующего усыпляем
 * лишь за окном + полосой (`inBand`) — нет флаттера на кромке. → true: активен (тяжёлый шаг — по temporal-LOD
 * вызывающего); false: спит — и тогда `update(dt)` зовётся ЗДЕСЬ: у спящей куклы это только часы нокдауна (дёшево).
 */
export function cullActor(a: CullActor, inWin: boolean, inBand: boolean, dt: number, budget: CullBudget): boolean {
  let active = a.dormant ? inWin : inBand;
  if (active && a.dormant) {
    if (budget.wake > 0) { budget.wake--; a.dormant = false; a.d.setSimEnabled?.(true); }
    else active = false;   // бюджет исчерпан → спит ещё кадр (в запасе окна, за кадром — не видно)
  } else if (!active && !a.dormant) { a.dormant = true; a.d.setSimEnabled?.(false); }   // выход за окно → вон из физики, меш заморожен
  if (!active) a.d.update(dt);   // ⭐ спит: часы нокдауна идут — проснётся в фазе сервера (см. `gamePlayerDoll`)
  return active;
}
