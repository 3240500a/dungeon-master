import Phaser from 'phaser';
import { App } from '../core/app.js';
import { makeButton } from './ui/button.js';

/**
 * Главное меню (D2R-стайл): «Играть» ведёт на выбор персонажа, если есть сессия аккаунта,
 * иначе на экран входа (валидность токена проверит уже CharacterSelect).
 */
export class MainMenuScene extends Phaser.Scene {
  constructor() {
    super('MainMenu');
  }

  create(): void {
    // Убираем игровой HUD, если пришли из активной сессии.
    if (this.scene.isActive('UI')) this.scene.stop('UI');
    const { width, height } = this.scale;
    this.add
      .text(width / 2, height * 0.28, 'Dungeon Master', {
        fontSize: '48px',
        color: '#e8e8f0',
      })
      .setOrigin(0.5);

    const cx = width / 2;
    let y = height * 0.5;
    const step = 60;

    makeButton(this, cx, y, 'Играть', () => this.scene.start(App.from(this).auth ? 'CharacterSelect' : 'Login'));
    y += step;
    makeButton(this, cx, y, 'Редактор', () => window.open('/editor/', '_blank'));
  }
}
