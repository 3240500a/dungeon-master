import Phaser from 'phaser';
import { FONT_TITLE } from '../ui/kit.js';
import { reflowOnFontsReady } from './ui/fonts.js';
import { PLAYER_SPRITE_COLORS, ensurePlayerCircle } from '../core/textures.js';

/**
 * Экран загрузки. Пробует подгрузить PNG-спрайты персонажей (public/sprites/<ключ>.png);
 * отсутствующие заменяются кружком-фолбэком в create(). Затем — в главное меню.
 */
export class PreloadScene extends Phaser.Scene {
  constructor() {
    super('Preload');
  }

  preload(): void {
    // Спрайты игрока: PNG из public/sprites/. Нет файла → loaderror (не крешит), рисуем кружок ниже.
    for (const key of Object.keys(PLAYER_SPRITE_COLORS)) this.load.image(key, `sprites/${key}.png`);
  }

  create(): void {
    // Для спрайтов без PNG — кружок-фолбэк (тот же ключ, что в class.sprite).
    for (const key of Object.keys(PLAYER_SPRITE_COLORS)) ensurePlayerCircle(this, key);

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
