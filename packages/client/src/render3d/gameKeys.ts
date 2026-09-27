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

/**
 * ⭐ R12-15: клавиши, которые читает игра веб-3D: ход (WASD и стрелки — `playerInput.moveFromKeys`), действия (пробел, Shift,
 * Q, Alt, [E] — `online3d.pumpInput`) и пояс 1–4 (`BeltBar`). При галке, ползунке или списке ⚙ в фокусе они ОТМЕНЯЮТСЯ:
 * иначе стрелка, ведя героя, ещё и листала ползунок разрешения (`onResScale` → pixelRatio посреди боя) или закрытый список
 * «Разрешение теней» (`onShadowRes` пересоздаёт все теневые карты), а цифра пояса с пустым слотом — поиском по пунктам списка
 * (`BeltBar` отменяет цифру, только когда выпил). Сторож «читает игра ⇒ есть здесь» — `gameKeys.test.ts`.
 */
const GAME = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE', 'AltLeft', 'AltRight',
  'Digit1', 'Digit2', 'Digit3', 'Digit4',
]);

/** Элемент, чьё ЗНАЧЕНИЕ листают клавиши: галка, ползунок, переключатель, список. Набор в поле (`isTextEntry`) отсечён раньше. */
function isValueControl(t: EventTarget | null): boolean {
  const tag = (t as { tagName?: unknown } | null)?.tagName;
  return tag === 'INPUT' || tag === 'SELECT';
}

export function gameKeyDown(e: Pick<KeyboardEvent, 'code' | 'preventDefault'>, focus: EventTarget | null, keys: Set<string>): void {
  if (isTextEntry(focus)) return;   // набор в поле — не игровой ключ
  keys.add(e.code);
  // Канвасу и странице стрелки и цифры — как были (отменяем, только если листать есть что).
  if (OWN.has(e.code) || (GAME.has(e.code) && isValueControl(focus))) e.preventDefault();
}

/**
 * Отпускание — ВСЕГДА (клавиша, зажатая в игре и отпущенная уже в поле, иначе залипла бы). Пробел вне поля отменяется и тут:
 * Firefox жмёт галку/кнопку в фокусе на ОТПУСКАНИИ пробела, отмены `keydown` ему мало (Chromium хватает и её).
 */
export function gameKeyUp(e: Pick<KeyboardEvent, 'code' | 'preventDefault'>, focus: EventTarget | null, keys: Set<string>): void {
  keys.delete(e.code);
  if (e.code === 'Space' && !isTextEntry(focus)) e.preventDefault();
}
