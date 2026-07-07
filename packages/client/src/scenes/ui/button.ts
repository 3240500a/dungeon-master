import Phaser from 'phaser';

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
      fontSize: '22px',
      color: enabled ? '#e8e8f0' : '#666',
      backgroundColor: '#1c1c26',
      padding: { x: 18, y: 10 },
    })
    .setOrigin(0.5);

  if (enabled) {
    text.setInteractive({ useHandCursor: true });
    text.on('pointerover', () => text.setBackgroundColor('#2c2c3a'));
    text.on('pointerout', () => text.setBackgroundColor('#1c1c26'));
    text.on('pointerdown', onClick);
  }
  return text;
}
