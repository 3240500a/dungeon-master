import type Phaser from 'phaser';

/**
 * Phaser печёт canvas-текст в текстуру шрифтом, доступным НА МОМЕНТ создания. Если веб-шрифт
 * заголовков (Cinzel/Forum) догрузился позже (холодный кэш) — текст остаётся фолбэком, пока
 * текстуру что-нибудь не пересоберёт (напр. hover — потому и «менялось при наведении»). Этот
 * хелпер форсит перерисовку, как только `document.fonts` готовы → без мигания и без ожидания hover.
 */
export function reflowOnFontsReady(text: Phaser.GameObjects.Text): void {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.ready) return;
  fonts.ready
    .then(() => { try { text.updateText(); } catch { /* объект уже уничтожен */ } })
    .catch(() => { /* игнор */ });
}
