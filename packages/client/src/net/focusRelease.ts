/**
 * ⭐ R4-20: ОКНО ПОТЕРЯЛО ФОКУС — ЗАЖАТОЕ ОТПУЩЕНО. Alt-tab и переключение вкладки уносят `keyup` и `pointerup` в другое
 * окно: клиент считал W и ЛКМ зажатыми, пока их не нажмут снова, и слал это серверу — герой бежал и бил, пока игрок
 * отошёл (а скрытая вкладка кадров не шлёт вовсе: там сервер останавливает героя сам, `Room.step`). На `blur` окна и на
 * скрытие вкладки зовётся `release`: сбросить удержания и сразу отправить кадр «стою». Общий для 2D (`NetDriver`) и
 * веб-3D (`online3d`). Возвращает отписку.
 */
export function onFocusLost(win: EventTarget, doc: EventTarget & { readonly hidden: boolean }, release: () => void): () => void {
  const onBlur = (): void => { release(); };
  const onVisibility = (): void => { if (doc.hidden) release(); };
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
