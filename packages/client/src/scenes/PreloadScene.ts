import Phaser from 'phaser';

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
    this.add
      .text(width / 2, height / 2, 'Dungeon Master', {
        fontSize: '32px',
        color: '#e8e8f0',
      })
      .setOrigin(0.5);
    this.time.delayedCall(300, () => this.scene.start('MainMenu'));
  }
}
