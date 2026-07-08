import Phaser from 'phaser';
import { App } from '../core/app.js';
import { makeButton } from './ui/button.js';
import { listCharacters, deleteCharacter, logout, type CharacterSummary } from '../modules/auth/authApi.js';
import { FONT_TITLE } from '../ui/kit.js';
import { reflowOnFontsReady } from './ui/fonts.js';

const MAX_CHARS = 5;

/**
 * Экран выбора персонажа (D2R-стайл). Ростер — АВТОРИТЕТНЫЙ, из `GET /api/characters`
 * (не из localStorage). «Играть» ставит `app.pendingCharId` → полный сейв придёт в `joined`.
 * Протухший токен (401) → сброс сессии и возврат на вход.
 */
export class CharacterSelectScene extends Phaser.Scene {
  private selected = 0;
  private chars: CharacterSummary[] = [];

  constructor() { super('CharacterSelect'); }

  create(): void {
    const app = App.from(this);
    if (!app.auth) { this.scene.start('Login'); return; }
    this.info('Загрузка персонажей…');
    void this.loadRoster();
  }

  private async loadRoster(): Promise<void> {
    const app = App.from(this);
    try {
      this.chars = await listCharacters(app.auth!.token);
      this.selected = Math.min(this.selected, Math.max(0, this.chars.length - 1));
      this.buildUI();
    } catch (e) {
      const msg = (e as Error).message;
      if (/вход|401/i.test(msg)) { app.clearAuth(); this.scene.start('Login'); return; }
      this.info(`Ошибка: ${msg}`, true);
    }
  }

  private className(classId: string): string {
    return App.from(this).config.get('classes').find((c) => c.id === classId)?.name ?? classId;
  }
  private classSprite(classId: string): string {
    return App.from(this).config.get('classes').find((c) => c.id === classId)?.sprite ?? 'player-warrior';
  }

  /** Простой экран статуса (загрузка/ошибка) с кнопкой назад. */
  private info(text: string, retry = false): void {
    this.children.removeAll(true);
    const { width, height } = this.scale;
    this.add.text(width / 2, height * 0.45, text, { fontSize: '18px', color: '#c4bca8', align: 'center' }).setOrigin(0.5);
    if (retry) makeButton(this, width / 2, height * 0.58, 'Повторить', () => { this.info('Загрузка…'); void this.loadRoster(); });
    makeButton(this, width * 0.12, height * 0.9, 'Назад', () => this.scene.start('MainMenu'));
  }

  private buildUI(): void {
    this.children.removeAll(true);
    const { width, height } = this.scale;
    const app = App.from(this);

    reflowOnFontsReady(this.add.text(width / 2, height * 0.1, 'Выбор персонажа', { fontFamily: FONT_TITLE, fontSize: '32px', color: '#e0b45a' }).setOrigin(0.5));
    this.add.text(width * 0.88, height * 0.1, app.auth!.username, { fontSize: '14px', color: '#8f897c' }).setOrigin(0.5);

    // ── Список слева ─────────────────────────────────────
    const listX = width * 0.26;
    const top = height * 0.24;
    const rowH = 62;
    this.chars.forEach((c, i) => this.slotRow(c, i, listX, top + i * rowH));
    if (this.chars.length === 0) {
      this.add.text(listX, top, '— Нет персонажей —', { fontSize: '14px', color: '#6a655c', fontStyle: 'italic' }).setOrigin(0.5);
    }
    makeButton(this, listX, top + MAX_CHARS * rowH + 24, '+ Создать персонажа',
      () => this.scene.start('ClassSelect'), { enabled: this.chars.length < MAX_CHARS });

    // ── Аватар справа ────────────────────────────────────
    const sel = this.chars[this.selected] ?? null;
    const ax = width * 0.68;
    if (sel) this.renderAvatar(sel, ax, height);
    else this.add.text(ax, height * 0.45, 'Создайте персонажа.', { fontSize: '18px', color: '#8f897c', align: 'center' }).setOrigin(0.5);

    // ── Кнопки снизу ─────────────────────────────────────
    makeButton(this, width * 0.6, height * 0.9, 'Играть', () => this.play(), { enabled: !!sel });
    makeButton(this, width * 0.78, height * 0.9, 'Удалить', () => void this.deleteSelected(), { enabled: !!sel });
    makeButton(this, width * 0.12, height * 0.9, 'Назад', () => this.scene.start('MainMenu'));
    makeButton(this, width * 0.9, height * 0.9, 'Выйти', () => void this.doLogout());
  }

  private slotRow(c: CharacterSummary, i: number, x: number, y: number): void {
    const w = 300;
    const h = 54;
    const container = this.add.container(x, y);
    const bg = this.add.rectangle(0, 0, w, h, 0x171b24)
      .setStrokeStyle(this.selected === i ? 2 : 1, this.selected === i ? 0xe39a3c : 0x2b323f);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerdown', () => { this.selected = i; this.buildUI(); });
    container.add(bg);
    container.add(this.add.image(-w / 2 + 26, 0, this.classSprite(c.classId)));
    container.add(this.add.text(-w / 2 + 50, -12, c.name, { fontSize: '16px', color: '#e6ddc9' }));
    container.add(this.add.text(-w / 2 + 50, 8, `${this.className(c.classId)} · Ур. ${c.level}`, { fontSize: '12px', color: '#8f897c' }));
  }

  private renderAvatar(c: CharacterSummary, x: number, height: number): void {
    this.add.image(x, height * 0.34, this.classSprite(c.classId)).setScale(6);
    this.add.text(x, height * 0.5, c.name, { fontSize: '26px', color: '#e6ddc9' }).setOrigin(0.5);
    this.add.text(x, height * 0.56, `${this.className(c.classId)} · Уровень ${c.level}`, { fontSize: '15px', color: '#8f897c' }).setOrigin(0.5);
  }

  private play(): void {
    const app = App.from(this);
    const sel = this.chars[this.selected];
    if (!sel) return;
    app.pendingCharId = sel.charId; // полный сейв придёт с сервера в кадре joined
    this.scene.start('Online');
  }

  private async deleteSelected(): Promise<void> {
    const app = App.from(this);
    const sel = this.chars[this.selected];
    if (!sel) return;
    if (!confirm(`Удалить персонажа «${sel.name}» безвозвратно?`)) return;
    try {
      await deleteCharacter(app.auth!.token, sel.charId);
      await this.loadRoster();
    } catch (e) { this.info(`Ошибка удаления: ${(e as Error).message}`, true); }
  }

  private async doLogout(): Promise<void> {
    const app = App.from(this);
    try { await logout(app.auth!.token); } catch { /* всё равно выходим */ }
    app.clearAuth();
    this.scene.start('Login');
  }
}
