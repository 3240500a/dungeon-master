/**
 * ТРУП МОНСТРА: ПАДЕНИЕ → ЗАПЕКАНИЕ. Смерть (`corpseStart`), кадр одного трупа (`corpseFrame`) и сам коллапс-луп
 * `online3d.ts` с бюджетами кадра (`collapseCorpses`).
 *
 * Вынесен (как `driveActor`), чтобы решение «падает ли труп и когда его печь» жило под сторожем на живом Jolt
 * (`corpseCollapse.test.ts`, кукла целиком) — вместе с бюджетами: луп и константы здесь, клиент их только зовёт.
 * Модуль не знает ни сцены, ни запекания: `true` = «осел, финальная поза нарисована — пеки», дальше `bakeCorpse` /
 * снос куклы делает клиент (колбэк `bake`).
 *
 * ⭐⭐ ВНЕ ОКНА ТРУП ТОЖЕ ПАДАЕТ. Было: за окном труп сразу усыплялся (тела вон из `pw.step`), часы шли, и через 1.1 с
 * `bakeCorpse` пёк ЗАМОРОЖЕННЫЙ меш — последний кадр, нарисованный до сна: стоя, там, где монстра усыпили. Игрок
 * подходил — стоит статуя. ЗАМЕР (живой Jolt, кукла монстра, 100 u/с; 60 / 144 Гц; стоя голова меша на 56.2u): убит за
 * окном — голова запечённого 55.5 / 55.4u, таз меша в 203 / 200u от точки смерти; умер в окне и через 0.2 с ушёл за
 * окно — голова 48.8 / 48.2u (запечён на лету). Теперь за окном труп падает в `pw.step` без рисования — ровно как
 * сверх бюджета рисования в окне — и перед запеканием дорисовывается один кадр: голова 5.9 / 6.0u и 5.5 / 5.4u
 * (эталон в окне 5.5 / 5.3u), таз меша в 16 / 15u от точки смерти.
 *
 * ⚠ Физика падения стоит как у живого монстра в физ-режиме (замер в node: 10 трупов — 2.6–3.9 мс на кадр, 10 живых —
 * 2.2–2.6 мс), поэтому за окном одновременно падают не больше `OFFSCREEN_FALL_BUDGET` трупов: остальные ждут очереди
 * усыплёнными, их часы стоят — задержка за экраном не видна. В окне падение не ограничено: там его видно — трупы в окне
 * очередь за окном НЕ тратят (иначе при масс-килле в окне 4-й и дальше стояли бы замороженными до 2.2 / 3.3 с).
 */

/** Сколько секунд труп падает до запекания. */
export const CORPSE_FALL_SEC = 1.1;
/** Макс. трупов В ОКНЕ, РЕНДЕРЯЩИХ падение за кадр (тяжёлый `update`); сверх — падают в `pw.step`, дорисуются перед запеканием (размазка спайка масс-килла). */
export const COLLAPSE_BUDGET = 6;
/** Макс. трупов ЗА ОКНОМ, одновременно падающих в `pw.step` (без рисования); остальные ждут очереди усыплёнными. */
export const OFFSCREEN_FALL_BUDGET = 3;

export interface CorpseDoll { update(dt: number): void; setSimEnabled?(on: boolean): void; setDead(d: boolean): void }
/** Состояние трупа у клиента: `dead` — секунд до запекания (`null`/`undefined` — жив), `dormant` — тела вынуты из мира. */
export interface Corpse { d: CorpseDoll; dead?: number; dormant?: boolean; bakeFailed?: boolean }
/**
 * Бюджеты на кадр, общие на весь луп (счётчики тратятся): `draw` — сколько трупов в окне рисуют падение (тяжёлый `update`),
 * `fall` — сколько трупов за окном падают в физике.
 */
export interface CorpseBudget { draw: number; fall: number }

/** Смерть: коллапс пошёл. `setDead(true)` будит спящую куклу — флаг `dormant` обязан это знать (см. `windowCull`). → false: уже труп. */
export function corpseStart(a: Corpse): boolean {
  if (a.dead != null) return false;
  a.dormant = false; a.d.setDead(true); a.dead = CORPSE_FALL_SEC;
  return true;
}

/** Кадр трупа. → true: осел, финальная поза нарисована — запекать. */
export function corpseFrame(a: Corpse, dt: number, inWin: boolean, budget: CorpseBudget): boolean {
  if (a.dead == null || a.bakeFailed) return false;   // жив / запечь уже не вышло → труп заморожен насовсем (без ретрая)
  if (a.dead <= 0) {                                  // осел → дорисовать финальную позу (кадры пропускались бюджетом / окном) → печь лежащего
    if (!a.dormant) a.d.update(1 / 60);
    return true;
  }
  if (!inWin && budget.fall <= 0) {                   // за окном и очередь занята → ждать усыплённым, часы стоят
    if (!a.dormant) { a.dormant = true; a.d.setSimEnabled?.(false); }
    return false;
  }
  if (!inWin) budget.fall--;
  if (a.dormant) { a.dormant = false; a.d.setSimEnabled?.(true); }   // вернулся в окно / дошла очередь → тела в физику, падение доигрывается
  a.dead -= dt;
  if (inWin && budget.draw > 0) { budget.draw--; a.d.update(dt); }   // в окне и в бюджете → кадр падения; иначе тело падает в `pw.step` без рисования
  return false;
}

const _budget: CorpseBudget = { draw: 0, fall: 0 };
/**
 * КОЛЛАПС-ЛУП КАДРА: все трупы клиента через `corpseFrame` с ОДНИМ бюджетом на кадр (заводится здесь, до цикла —
 * бюджет «на труп» снял бы очередь за окном). `inWin` — труп в окне (+ полоса); `bake` — запечь осевший труп и снести
 * куклу (сам удаляет его из `actors`), false — не вышло: труп заморожен насовсем (`bakeFailed`, без ретрая дорогого
 * clone+merge каждый кадр).
 */
export function collapseCorpses<A extends Corpse>(actors: Map<number, A>, dt: number, inWin: (a: A) => boolean, bake: (id: number, a: A) => boolean): void {
  _budget.draw = COLLAPSE_BUDGET; _budget.fall = OFFSCREEN_FALL_BUDGET;
  for (const [id, a] of actors) {
    if (!corpseFrame(a, dt, inWin(a), _budget)) continue;
    if (bake(id, a)) continue;
    a.bakeFailed = true;
    if (!a.dormant) { a.dormant = true; a.d.setSimEnabled?.(false); }
  }
}
