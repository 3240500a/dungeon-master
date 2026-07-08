import Phaser from 'phaser';
import { generatePlaceholderTextures } from '../core/textures.js';

/** Первичная инициализация: генерирует тестовые текстуры, ждёт заголовочные шрифты, затем Preload. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    generatePlaceholderTextures(this);
    void this.awaitFontsThenPreload();
  }

  /**
   * Phaser рендерит текст в текстуру шрифтом, доступным НА МОМЕНТ создания, и не
   * перерисовывает его после подгрузки веб-шрифта. Поэтому дожидаемся Cinzel/Ruslan
   * Display до первого титра (в Preload). Ошибка/таймаут не блокируют игру — сработает фолбэк.
   */
  private async awaitFontsThenPreload(): Promise<void> {
    try {
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (fonts) {
        await Promise.race([
          Promise.all([fonts.load("16px 'Cinzel'"), fonts.load("16px 'Ruslan Display'")]),
          new Promise((r) => setTimeout(r, 2500)), // страховка от вечного ожидания
        ]);
      }
    } catch { /* фолбэк-шрифт из стека FONT_TITLE */ }
    this.scene.start('Preload');
  }
}
