import Phaser from 'phaser';
import { FONT_TITLE } from '../ui/kit.js';
import { reflowOnFontsReady } from './ui/fonts.js';

/**
 * Экран загрузки. Ассетов пока нет (тестовая графика генерируется в Boot),
 * поэтому просто показываем заголовок и переходим в главное меню.
 * Здесь позже появятся loader-бар и загрузка атласов/звуков.
 */
export class PreloadScene extends Phaser.Scene {
  constructor() {
    super('Preload');
  }

  create(): void {
    const { width, height } = this.scale;
    const title = this.add
      .text(width / 2, height / 2, 'Dungeon Master', {
        fontFamily: FONT_TITLE,
        fontSize: '34px',
        color: '#e0b45a',
      })
      .setOrigin(0.5);
    reflowOnFontsReady(title);
    this.time.delayedCall(300, () => this.scene.start('MainMenu'));
  }
}
