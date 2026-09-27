import { isTextEntry } from '../ui/typingGuard.js';

/**
 * КЛАВИШИ ИГРЫ ВЕБ-3D → множество зажатых (`keys`: WASD/стрелки, пробел — рывок, Q/E, Shift, Alt). Слушает `online3d` на
 * `window`; `focus` — `document.activeElement`.
 *
 * ⭐ R11-16: не игра — только НАБОР в поле (`isTextEntry`: ник, пароль, имя героя, поиск). Раньше отсекался любой `<input>`:
 * игрок щёлкал галку «Тени от факелов» или тянул ползунок разрешения в ⚙ и возвращался в бой, не кликнув по канвасу, —
 * элемент оставался в фокусе, WASD не доходили (герой стоял), а пробел не отменялся и переключал галку вместо рывка.
 */
/** Клавиши игры, у которых у браузера своё действие: пробел жмёт кнопку/галку в фокусе, Tab уводит фокус, Alt — меню окна. */
const OWN = new Set(['Space', 'Tab', 'AltLeft', 'AltRight']);

export function gameKeyDown(e: Pick<KeyboardEvent, 'code' | 'preventDefault'>, focus: EventTarget | null, keys: Set<string>): void {
  if (isTextEntry(focus)) return;   // набор в поле — не игровой ключ
  keys.add(e.code);
  if (OWN.has(e.code)) e.preventDefault();
}

/**
 * Отпускание — ВСЕГДА (клавиша, зажатая в игре и отпущенная уже в поле, иначе залипла бы). Пробел вне поля отменяется и тут:
 * Firefox жмёт галку/кнопку в фокусе на ОТПУСКАНИИ пробела, отмены `keydown` ему мало (Chromium хватает и её).
 */
export function gameKeyUp(e: Pick<KeyboardEvent, 'code' | 'preventDefault'>, focus: EventTarget | null, keys: Set<string>): void {
  keys.delete(e.code);
  if (e.code === 'Space' && !isTextEntry(focus)) e.preventDefault();
}
