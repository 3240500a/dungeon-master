import Phaser from 'phaser';
import { type DebuffKind, type DebuffState, type MonsterEntity, type MonsterView, type ScaledMonster, newDebuffState, DEBUFF_ICON } from '@dm/shared';

export type MonsterState = 'idle' | 'chase';

/**
 * Вид монстра (только отрисовка). Авторитет — headless `GameSession`: она двигает,
 * решает бой и восприятие, а этот класс лишь синхронит спрайт/HP/дебаффы/значки из
 * `MonsterEntity` каждый кадр (`sync`) и рисует табличку (`drawStatus`). ИИ/урон тут
 * больше нет — см. `shared/src/session`.
 */
export class Monster {
  readonly sprite: Phaser.GameObjects.Sprite;
  readonly def: ScaledMonster;
  debuffs: DebuffState = newDebuffState();
  hp: number;
  alive = true;
  state: MonsterState = 'idle';
  facing: number;
  private stunTimer = 0;
  private bar?: Phaser.GameObjects.Graphics;
  private nose?: Phaser.GameObjects.Graphics;
  private alertIcon?: Phaser.GameObjects.Text;
  private nameText?: Phaser.GameObjects.Text;
  private statsText?: Phaser.GameObjects.Text;
  private debuffText?: Phaser.GameObjects.Text;
  private readonly special: boolean;
  private readonly nameColor: string;

  constructor(scene: Phaser.Scene, x: number, y: number, def: ScaledMonster) {
    this.def = def;
    this.hp = def.hp;
    this.special = def.rarity === 'champion' || def.affixes.length > 0;
    this.nameColor = def.rarity === 'champion' ? '#ffd24b' : this.special ? '#7cc4ff' : '#cfcfcf';
    this.facing = Math.random() * Math.PI * 2;
    const tex = scene.textures.exists(def.sprite) ? def.sprite : 'mob-skeleton';
    this.sprite = scene.add.sprite(x, y, tex).setDepth(4);
    if (def.rarity === 'champion') {
      this.sprite.setScale(1.6);
      this.sprite.setTint(0xffe27a);
    }
  }

  /** Синхронизирует вид из состояния сессии (позиция/HP/дебаффы/стан/агро). */
  sync(e: MonsterEntity): void {
    this.hp = e.hp;
    this.alive = e.alive;
    this.facing = e.facing;
    this.state = e.aiState === 'chase' ? 'chase' : 'idle';
    this.stunTimer = e.stunTimer;
    this.debuffs = e.debuffs;
    this.sprite.setPosition(e.pos.x, e.pos.y);
  }

  /** Синхронизирует вид из СЕТЕВОГО снапшота (онлайн — авторитет на сервере). */
  syncView(v: MonsterView): void {
    this.hp = v.hp;
    this.alive = v.alive;
    this.facing = v.facing;
    this.stunTimer = v.stun ? 1 : 0;
    this.debuffs = v.debuffs;
    this.sprite.setPosition(v.x, v.y);
  }

  /** Короткая вспышка при попадании (вызывает боевой драйвер по событию hit). */
  flash(): void {
    if (!this.alive) return;
    this.sprite.setTintFill(0xffffff);
    this.sprite.scene.time.delayedCall(60, () => {
      if (this.sprite.active) {
        this.sprite.clearTint();
        if (this.def.rarity === 'champion') this.sprite.setTint(0xffe27a);
      }
    });
  }

  private statsLine(): string {
    const d = this.def;
    const parts = [`⚔ ${Math.round(d.minDamage)}–${Math.round(d.maxDamage)}`];
    if (d.armor > 0) parts.push(`🛡 ${Math.round(d.armor)}`);
    const res: [number, string][] = [
      [d.resFire, '🔥'], [d.resCold, '❄'], [d.resLightning, '⚡'], [d.resPoison, '☠'],
    ];
    const rp = res.filter(([v]) => v !== 0).map(([v, i]) => `${i}${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
    if (rp.length) parts.push(rp.join(' '));
    return parts.join('  ');
  }

  /** Рисует табличку (имя + HP-бар + характеристики особых) и значки. Каждый кадр. */
  drawStatus(): void {
    if (!this.alive) return;
    const scene = this.sprite.scene;
    // «Нос» — куда смотрит монстр (важно для будущей графики/восприятия).
    if (!this.nose) this.nose = scene.add.graphics().setDepth(5);
    const nx = this.sprite.x + Math.cos(this.facing) * 16;
    const ny = this.sprite.y + Math.sin(this.facing) * 16;
    this.nose.clear();
    this.nose.lineStyle(2, 0xff8a6a, 0.8);
    this.nose.lineBetween(this.sprite.x, this.sprite.y, nx, ny);
    const cx = this.sprite.x;
    const half = this.sprite.displayHeight / 2;
    const barY = this.sprite.y - half - 8;
    const nameY = barY - 9;
    const w = this.def.rarity === 'champion' ? 34 : 26;
    const frac = Phaser.Math.Clamp(this.hp / this.def.hp, 0, 1);

    if (!this.nameText) {
      this.nameText = scene.add
        .text(0, 0, this.def.name, {
          fontSize: this.def.rarity === 'champion' ? '11px' : '10px',
          color: this.nameColor,
          fontStyle: this.special ? 'bold' : 'normal',
        })
        .setOrigin(0.5)
        .setDepth(7);
    }
    this.nameText.setPosition(cx, nameY);

    if (!this.bar) this.bar = scene.add.graphics().setDepth(7);
    this.bar.clear();
    const bx = cx - w / 2;
    this.bar.fillStyle(0x000000, 0.6).fillRect(bx - 1, barY - 1, w + 2, 5);
    this.bar.fillStyle(frac > 0.5 ? 0x6ac06a : frac > 0.25 ? 0xd0b040 : 0xcf4b4b, 1);
    this.bar.fillRect(bx, barY, w * frac, 3);

    if (this.special) {
      if (!this.statsText) {
        this.statsText = scene.add
          .text(0, 0, this.statsLine(), { fontSize: '9px', color: '#c8c8d0' })
          .setOrigin(0.5)
          .setDepth(7);
      }
      this.statsText.setPosition(cx, this.sprite.y + half + 6);
    }

    const dstr = (Object.keys(this.debuffs) as DebuffKind[])
      .map((k) => (this.debuffs[k] ? `${DEBUFF_ICON[k]}${this.debuffs[k]!.stacks}` : ''))
      .filter(Boolean).join(' ');
    if (dstr) {
      if (!this.debuffText) {
        this.debuffText = scene.add.text(0, 0, '', { fontSize: '9px', color: '#ffd0b0' }).setOrigin(0.5).setDepth(7);
      }
      this.debuffText.setText(dstr).setPosition(cx, this.sprite.y + half + (this.special ? 16 : 6)).setVisible(true);
    } else {
      this.debuffText?.setVisible(false);
    }

    if (this.stunTimer > 0 || this.state === 'chase') {
      if (!this.alertIcon) {
        this.alertIcon = scene.add
          .text(0, 0, '', { fontSize: '14px', fontStyle: 'bold' })
          .setDepth(7)
          .setOrigin(0.5);
      }
      const stunned = this.stunTimer > 0;
      this.alertIcon.setText(stunned ? '✷' : '!').setColor(stunned ? '#ffe27a' : '#ff5b5b');
      this.alertIcon.setPosition(cx, nameY - 11).setVisible(true);
    } else {
      this.alertIcon?.setVisible(false);
    }
  }

  destroy(): void {
    this.bar?.destroy();
    this.nose?.destroy();
    this.alertIcon?.destroy();
    this.nameText?.destroy();
    this.statsText?.destroy();
    this.debuffText?.destroy();
    this.sprite.destroy();
  }
}
