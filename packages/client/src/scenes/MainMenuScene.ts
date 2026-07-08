import Phaser from 'phaser';
import { App } from '../core/app.js';
import { makeButton } from './ui/button.js';
import { FONT_TITLE } from '../ui/kit.js';

/**
 * Главное меню (D2R-стайл). Фон — картинка `public/menu-bg.png` (если добавлена): вписывается ПО
 * ВЫСОТЕ и центрируется, недостающие бока заливаются чёрным (под градиент картинки к краям). Сверху
 * лёгкое затемнение для читаемости. Заголовок и кнопки перестраиваются при ресайзе окна (адаптив).
 */
export class MainMenuScene extends Phaser.Scene {
  private blackFill?: Phaser.GameObjects.Rectangle;
  private bg?: Phaser.GameObjects.Image;
  private overlay?: Phaser.GameObjects.Rectangle;
  private title?: Phaser.GameObjects.Text;
  private buttons: Phaser.GameObjects.Text[] = [];

  constructor() {
    super('MainMenu');
  }

  preload(): void {
    // Фон необязателен: при 404 Phaser не создаст текстуру (проверяем textures.exists ниже).
    this.load.image('menu-bg', 'menu-bg.png');
  }

  create(): void {
    // Убираем игровой HUD, если пришли из активной сессии.
    if (this.scene.isActive('UI')) this.scene.stop('UI');
    this.buttons = [];

    if (this.textures.exists('menu-bg')) {
      this.blackFill = this.add.rectangle(0, 0, 10, 10, 0x000000, 1).setDepth(-11); // бока/поля — чёрным
      this.bg = this.add.image(0, 0, 'menu-bg').setDepth(-10);
      this.overlay = this.add.rectangle(0, 0, 10, 10, 0x000000, 0.4).setDepth(-9); // затемнение под текст
    }

    this.title = this.add.text(0, 0, 'Dungeon Master', { fontFamily: FONT_TITLE, fontSize: '54px', color: '#e0b45a' }).setOrigin(0.5); // факельное золото
    this.buttons.push(
      makeButton(this, 0, 0, 'Играть', () => this.scene.start(App.from(this).auth ? 'CharacterSelect' : 'Login')),
    );
    this.buttons.push(makeButton(this, 0, 0, 'Редактор', () => window.open('/editor/', '_blank')));

    this.layout();
    this.scale.on('resize', this.layout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.scale.off('resize', this.layout, this));
  }

  /** Расставляет фон/заголовок/кнопки под текущий размер экрана (вызывается при старте и ресайзе). */
  private layout(): void {
    const { width, height } = this.scale;
    if (this.bg) {
      const src = this.textures.get('menu-bg').getSourceImage() as { width: number; height: number };
      this.bg.setPosition(width / 2, height / 2).setScale(height / src.height); // вписать по ВЫСОТЕ, центр
      this.blackFill?.setPosition(width / 2, height / 2).setSize(width, height);
      this.overlay?.setPosition(width / 2, height / 2).setSize(width, height);
    }
    this.title?.setPosition(width / 2, height * 0.28);
    let y = height * 0.5;
    for (const b of this.buttons) { b.setPosition(width / 2, y); y += 60; }
  }
}
