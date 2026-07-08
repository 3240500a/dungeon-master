import Phaser from 'phaser';
import { levelForXp, xpForLevel, effectiveLevel, startChallenge, challengeAtFloor, activeToggleInfos, DEBUFF_ICON, type DebuffKind } from '@dm/shared';
import { App } from '../core/app.js';
import { ActionBar } from '../ui/actionBar.js';
import { BeltBar } from '../ui/beltBar.js';

/**
 * Постоянный оверлей HUD поверх Town/Dungeon: полосы HP/маны/опыта, уровень,
 * глубина, счётчик очков. Работает как отдельная параллельная сцена. Модальные
 * панели (инвентарь/скиллы/магазин) — DOM-оверлей (подключаются в M8+).
 */
export class UIScene extends Phaser.Scene {
  private app!: App;
  private hpBar!: Phaser.GameObjects.Graphics;
  private manaBar!: Phaser.GameObjects.Graphics;
  private xpBar!: Phaser.GameObjects.Graphics;
  private label!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private hpText!: Phaser.GameObjects.Text;
  private manaText!: Phaser.GameObjects.Text;
  private debuffText!: Phaser.GameObjects.Text;
  private auraText!: Phaser.GameObjects.Text;
  private actionBar?: ActionBar;
  private beltBar?: BeltBar;

  constructor() {
    super('UI');
  }

  create(): void {
    this.app = App.from(this);
    this.hpBar = this.add.graphics();
    this.manaBar = this.add.graphics();
    this.xpBar = this.add.graphics();
    this.label = this.add.text(16, 12, '', { fontSize: '17px', color: '#e6ddc9' });
    this.hpText = this.add.text(0, 0, '', { fontSize: '13px', color: '#f2ede1', fontStyle: 'bold' }).setOrigin(0.5);
    this.manaText = this.add.text(0, 0, '', { fontSize: '12px', color: '#f2ede1' }).setOrigin(0.5);
    this.debuffText = this.add.text(16, 104, '', { fontSize: '17px', color: '#e8907c' });
    // Индикатор активных аур/стоек (тоглов) под полосами — факельным амбером.
    this.auraText = this.add.text(16, 124, '', { fontSize: '14px', color: '#e39a3c' });
    // Подсказка — в правый-нижний угол (origin 1,1): бинды и так подписаны на панели действий,
    // а левый-нижний занят поясом/чатом. Держим строку короткой, чтобы не лезла в панель биндов.
    this.hint = this.add
      .text(0, 0, 'WASD — движение · E — действие · I — инвентарь · K — скиллы', {
        fontSize: '14px',
        color: '#8f897c',
      })
      .setOrigin(1, 1);
    this.scale.on('resize', () => this.layoutHint());
    this.layoutHint();

    // DOM-панель биндов (D2) внизу по центру — живёт с этой сценой.
    const root = document.getElementById('ui-root');
    if (root) { this.actionBar = new ActionBar(this.app, root); this.beltBar = new BeltBar(this.app, root); }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.actionBar?.destroy(); this.actionBar = undefined;
      this.beltBar?.destroy(); this.beltBar = undefined;
    });
  }

  private layoutHint(): void {
    this.hint?.setPosition(this.scale.width - 12, this.scale.height - 8);
  }

  private drawBar(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    frac: number,
    color: number,
  ): void {
    g.clear();
    g.fillStyle(0x000000, 0.5).fillRect(x, y, w, h);
    g.fillStyle(color, 1).fillRect(x, y, w * Phaser.Math.Clamp(frac, 0, 1), h);
    g.lineStyle(1, 0x000000, 0.8).strokeRect(x, y, w, h);
  }

  /** Полоса маны с зоной резерва (справа приглушённая — недоступная из-за аур/стоек). */
  private drawManaBar(x: number, y: number, w: number, h: number, mana: number, maxMana: number, reservedFrac: number): void {
    const g = this.manaBar;
    g.clear();
    g.fillStyle(0x000000, 0.5).fillRect(x, y, w, h);
    if (reservedFrac > 0) {
      const rw = w * Phaser.Math.Clamp(reservedFrac, 0, 1);
      g.fillStyle(0x2a3550, 0.9).fillRect(x + w - rw, y, rw, h); // зарезервированная доля
    }
    const frac = maxMana > 0 ? mana / maxMana : 0;
    g.fillStyle(0x5b83b8, 1).fillRect(x, y, w * Phaser.Math.Clamp(frac, 0, 1), h);
    g.lineStyle(1, 0x000000, 0.8).strokeRect(x, y, w, h);
  }

  override update(): void {
    const state = this.app.state;
    if (!state) {
      this.label.setText('');
      this.hpBar.clear();
      this.manaBar.clear();
      this.xpBar.clear();
      this.hpText.setText('');
      this.manaText.setText('');
      this.debuffText.setText('');
      this.auraText.setText('');
      return;
    }
    const d = state.derived();
    const xpTable = this.app.config.get('balance').xpTable;
    const lvl = state.save.level;
    const xpThis = xpForLevel(lvl, xpTable);
    const xpNext = xpForLevel(lvl + 1, xpTable);
    const xpFrac = xpNext > xpThis ? (state.save.xp - xpThis) / (xpNext - xpThis) : 1;

    const reservedFrac = state.reservedManaFracProvider();
    const reserved = Math.round(d.maxMana * reservedFrac);
    this.drawBar(this.hpBar, 16, 38, 280, 20, state.hp / d.maxHp, 0xc85a48);
    this.drawManaBar(16, 64, 280, 16, state.mana, d.maxMana, reservedFrac);
    this.drawBar(this.xpBar, 16, 84, 280, 8, xpFrac, 0xdca94b);
    this.hpText.setPosition(16 + 140, 38 + 10).setText(`${Math.round(state.hp)} / ${Math.round(d.maxHp)}`);
    this.manaText.setPosition(16 + 140, 64 + 8).setText(
      reserved > 0
        ? `${Math.round(state.mana)} / ${Math.round(d.maxMana)}  (−${reserved} рез.)`
        : `${Math.round(state.mana)} / ${Math.round(d.maxMana)}`,
    );

    // Индикатор активных аур/стоек.
    const auras = activeToggleInfos(this.app.config, state.save.classId, state.toggles);
    this.auraText.setText(auras.length ? '◈ ' + auras.map((a) => a.name).join('   ◈ ') : '');

    // Дебаффы на игроке (иконка + стаки).
    const dstr = (Object.keys(state.debuffs) as DebuffKind[])
      .map((k) => (state.debuffs[k] ? `${DEBUFF_ICON[k]}${state.debuffs[k]!.stacks}` : ''))
      .filter(Boolean).join('  ');
    this.debuffText.setText(dstr);

    let loc = 'Город';
    if (state.depth > 0) {
      const diffs = this.app.config.get('difficulties');
      const diff = diffs.find((dd) => dd.id === state.difficultyId) ?? diffs.find((dd) => dd.id === 'normal') ?? diffs[0]!;
      const el = effectiveLevel(state.save, this.app.config.get('balance').power).total;
      const cl = challengeAtFloor(startChallenge(el, diff), diff, state.depth);
      loc = `Этаж ${state.depth} · ${diff.name} · вызов ур.${cl}`;
    }
    this.label.setText(
      `Ур. ${lvl}   ${loc}   Золото: ${state.save.gold}   Очки: атр ${state.save.unspentAttributePoints} / скилл ${state.save.unspentSkillPoints}`,
    );
    // Панель биндов рисует DOM ActionBar (см. create()).
  }
}
