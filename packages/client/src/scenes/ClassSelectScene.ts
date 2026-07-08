import Phaser from 'phaser';
import type { ClassDef } from '@dm/shared';
import { App } from '../core/app.js';
import { makeButton } from './ui/button.js';
import { listClasses } from '../modules/classes/index.js';
import { createCharacter } from '../modules/auth/authApi.js';
import { FONT_TITLE } from '../ui/kit.js';
import { reflowOnFontsReady } from './ui/fonts.js';

/**
 * Создание персонажа: имя (DOM-поле) + выбор класса → `POST /api/characters` (сервер строит
 * авторитетный стартовый сейв) → `app.pendingCharId` → вход в мир.
 */
export class ClassSelectScene extends Phaser.Scene {
  private nameInput?: HTMLInputElement;
  private errText?: Phaser.GameObjects.Text;
  private busy = false;

  constructor() { super('ClassSelect'); }

  create(): void {
    const app = App.from(this);
    if (!app.auth) { this.scene.start('Login'); return; }
    const { width, height } = this.scale;

    reflowOnFontsReady(this.add.text(width / 2, height * 0.12, 'Создание персонажа', { fontFamily: FONT_TITLE, fontSize: '32px', color: '#e0b45a' }).setOrigin(0.5));
    this.buildNameInput(height);

    const classes = listClasses(app.config);
    const cardW = 200;
    const gap = 40;
    const totalW = classes.length * cardW + (classes.length - 1) * gap;
    let x = width / 2 - totalW / 2 + cardW / 2;
    for (const cls of classes) { this.makeCard(cls, x, height * 0.52, cardW); x += cardW + gap; }

    this.errText = this.add.text(width / 2, height * 0.8, '', { fontSize: '14px', color: '#c85a48' }).setOrigin(0.5);
    makeButton(this, width / 2, height * 0.88, 'Назад', () => this.scene.start('CharacterSelect'));

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.nameInput?.remove());
  }

  private buildNameInput(height: number): void {
    this.add.text(this.scale.width / 2, height * 0.24, 'Имя героя:', { fontSize: '15px', color: '#8f897c' }).setOrigin(0.5);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Имя героя';
    input.maxLength = 16;
    input.style.cssText =
      `position:fixed;left:50%;transform:translateX(-50%);top:${Math.round(height * 0.28)}px;` +
      `width:220px;padding:8px 10px;font-size:15px;text-align:center;` +
      `background:#0f131a;color:#e6ddc9;border:1px solid #3e4756;border-radius:6px;outline:none;z-index:60`;
    document.getElementById('ui-root')?.appendChild(input);
    this.nameInput = input;
    setTimeout(() => input.focus(), 50);
  }

  private makeCard(cls: ClassDef, x: number, y: number, w: number): void {
    const h = 240;
    const container = this.add.container(x, y);
    const bg = this.add.rectangle(0, 0, w, h, 0x171b24).setStrokeStyle(2, 0x2b323f);
    bg.setInteractive({ useHandCursor: true });
    container.add(bg);
    container.add(this.add.image(0, -70, cls.sprite).setScale(2));
    container.add(this.add.text(0, -20, cls.name, { fontSize: '24px', color: '#e6ddc9' }).setOrigin(0.5));
    const a = cls.startAttributes;
    const stats = `Сила ${a.strength}\nЛовк. ${a.dexterity}\nИнт. ${a.intelligence}\nЖив. ${a.vitality}`;
    container.add(this.add.text(0, 40, stats, { fontSize: '15px', color: '#c4bca8', align: 'center', lineSpacing: 4 }).setOrigin(0.5));
    bg.on('pointerover', () => bg.setStrokeStyle(2, 0xe39a3c));
    bg.on('pointerout', () => bg.setStrokeStyle(2, 0x2b323f));
    bg.on('pointerdown', () => void this.startNewGame(cls));
  }

  private async startNewGame(cls: ClassDef): Promise<void> {
    if (this.busy) return;
    const app = App.from(this);
    const name = this.nameInput?.value.trim() || 'Герой';
    this.busy = true;
    this.errText?.setText('');
    try {
      const ch = await createCharacter(app.auth!.token, cls.id, name); // сервер строит авторитетный сейв
      app.pendingCharId = ch.charId;
      this.scene.start('Online');
    } catch (e) {
      const msg = (e as Error).message;
      if (/вход|401/i.test(msg)) { app.clearAuth(); this.scene.start('Login'); return; }
      this.errText?.setText(msg);
      this.busy = false;
    }
  }
}
