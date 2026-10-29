/**
 * ⭐ R6-03: НАБОР В ПОЛЕ ВВОДА — НЕ ИГРОВЫЕ КЛАВИШИ (2D).
 *
 * Phaser слушает клавиатуру на `window` и глотает (`preventDefault`) каждую перехваченную клавишу без модификатора, не
 * глядя, где фокус; перехват один на страницу и переживает сцену. Драйвер 2D перехватывал W/A/S/D/E/Q и пробел, сцена —
 * E: в код комнаты в лобби не набиралась «a» (а код каждой комнаты одиночного процесса начинается с A), после ухода на
 * вход (R4-22) в ник, пароль и имя героя не набирались w/a/s/d/q/e и пробел — до F5. Буквы теперь не перехватываются
 * вовсе, а пробел/Shift/Alt — только пока жив драйвер (`NetDriver`); сторож — страховка поверх: нажатие в поле
 * обрывается на `document` и до `window` не доходит — ни перехват Phaser, ни игровые клавиши ([E] у NPC, WASD, рывок)
 * его не видят, какие бы клавиши кто ни перехватил.
 *
 * ⚠ Только `keydown`: отпускание идёт дальше — клавиша, зажатая в игре и отпущенная уже в поле, иначе залипла бы
 * (герой шёл бы, пока её не нажмут снова). Отпускание браузер ничего не набирает — его перехват набору не мешает.
 */

/**
 * Типы `<input>`, в которые НАБИРАЮТ (`''` — заглушка без типа; у браузера такое поле — `text`). ⭐ R11-16: галка, ползунок,
 * переключатель, кнопка, цвет, файл — не набор: раньше «поле» было любым `INPUT`, и галка настроек веб-3D (⚙), оставшаяся в
 * фокусе после клика, глотала WASD, а пробел переключал её посреди боя вместо рывка.
 */
const TYPED = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time']);

/**
 * Поле, куда набирают текст: текстовый `input` (см. `TYPED`), `textarea`, редактируемый элемент. Одно правило на все
 * клавиши страницы — сторож 2D, клавиши игры веб-3D (`render3d/gameKeys.ts`), пояс, хоткеи окон, F3 отладки.
 */
export function isTextEntry(t: EventTarget | null): boolean {
  const el = t as (HTMLElement & { type?: unknown }) | null;
  if (!el) return false;
  if (el.tagName === 'INPUT') return TYPED.has(typeof el.type === 'string' ? el.type.toLowerCase() : '');
  return el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}

/** Поставить сторожа на `doc` (2D — на `document` при старте страницы); возвращает снятие. */
export function guardTyping(doc: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): () => void {
  const onKey = (e: Event): void => { if (isTextEntry(e.target)) e.stopPropagation(); };
  doc.addEventListener('keydown', onKey);
  return () => doc.removeEventListener('keydown', onKey);
}
