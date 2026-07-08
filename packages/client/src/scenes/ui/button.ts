import Phaser from 'phaser';
import { FONT_TITLE } from '../../ui/kit.js';

/** Простая текстовая кнопка для сцен-меню (Phaser-объект). */
export function makeButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  onClick: () => void,
  opts: { enabled?: boolean } = {},
): Phaser.GameObjects.Text {
  const enabled = opts.enabled ?? true;
  const text = scene.add
    .text(x, y, label, {
      fontFamily: FONT_TITLE, // медиевальные капители в меню
      fontSize: '22px',
      color: enabled ? '#e6ddc9' : '#6a655c', // тёплый пергамент
      backgroundColor: '#1a1f29', // камень
      padding: { x: 18, y: 10 },
    })
    .setOrigin(0.5);

  if (enabled) {
    text.setInteractive({ useHandCursor: true });
    // Hover — текст загорается факельным амбером.
    text.on('pointerover', () => text.setBackgroundColor('#232a36').setColor('#e39a3c'));
    text.on('pointerout', () => text.setBackgroundColor('#1a1f29').setColor('#e6ddc9'));
    text.on('pointerdown', onClick);
  }
  return text;
}
