import Phaser from 'phaser';
import type { Item } from '@dm/shared';
import { rarityColorNum, rarityHex } from './rarity.js';

/** Предмет, лежащий на земле. Подбор — кликом по нему или авто-фильтром при проходе. */
export class DroppedItem {
  readonly item: Item;
  readonly x: number;
  readonly y: number;
  /** До этого времени (мс) авто-подбор не срабатывает (после ручного выброса). */
  noPickupUntil = 0;
  readonly sprite: Phaser.GameObjects.Image;
  private label: Phaser.GameObjects.Text;
  private glow?: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene, x: number, y: number, item: Item) {
    this.item = item;
    this.x = x;
    this.y = y;
    // Свечение для редких/уникальных — заметнее на земле.
    if (item.rarity === 'rare' || item.rarity === 'unique') {
      this.glow = scene.add
        .image(x, y, 'pixel')
        .setTint(rarityColorNum(item.rarity))
        .setAlpha(0.35)
        .setScale(7)
        .setDepth(2);
      scene.tweens.add({
        targets: this.glow,
        alpha: 0.15,
        scale: 5,
        duration: 700,
        yoyo: true,
        repeat: -1,
      });
    }
    this.sprite = scene.add
      .image(x, y, 'drop-item')
      .setTint(rarityColorNum(item.rarity))
      .setDepth(3)
      .setData('drop', true)
      // Увеличенная зона клика — по предмету удобнее попасть.
      .setInteractive(new Phaser.Geom.Circle(6, 6, 16), Phaser.Geom.Circle.Contains);
    this.label = scene.add
      .text(x, y - 14, item.name, {
        fontSize: '11px',
        color: rarityHex(item.rarity),
        backgroundColor: '#000000aa',
        padding: { x: 3, y: 1 },
      })
      .setOrigin(0.5)
      .setDepth(3);
    // Подсветка при наведении — понятно, что кликабельно.
    this.sprite.on('pointerover', () => this.label.setScale(1.15));
    this.sprite.on('pointerout', () => this.label.setScale(1));
  }

  destroy(): void {
    this.glow?.destroy();
    this.sprite.destroy();
    this.label.destroy();
  }
}
