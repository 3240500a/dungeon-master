import Phaser from 'phaser';

/**
 * Анимированный факел (клиент-вид, процедурно, без PNG): держатель + пульсирующее пламя +
 * поднимающиеся искры + тёплое аддитивное свечение. Отдаёт `flicker` — множитель радиуса
 * динамического света (см. Lighting), чтобы свет «дышал» синхронно с огнём.
 */
export class Torch {
  readonly x: number;
  readonly y: number;
  private base: Phaser.GameObjects.Image;
  private flame: Phaser.GameObjects.Image;
  private glow: Phaser.GameObjects.Image;
  private sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private glowScale: number;
  /** Свои фаза и период фликера — чтобы факелы колебались ВРАЗНОБОЙ, не в такт. */
  private phase = Math.random() * Math.PI * 2;
  private period = 110 + Math.random() * 80;
  /** Текущий множитель радиуса света (~0.92..1.0). */
  flicker = 1;

  constructor(scene: Phaser.Scene, x: number, y: number, glowScale = 1) {
    this.x = x;
    this.y = y;
    this.glowScale = glowScale;
    // Держатель — под тьмой (виден в луже света); пламя/искры/свечение — НАД тьмой (37/37/36), под туманом(40).
    this.base = scene.add.image(x, y + 5, 'torch-base').setDepth(5);
    this.flame = scene.add.image(x, y - 4, 'torch-flame').setDepth(37);
    this.glow = scene.add.image(x, y - 4, 'torch-glow').setDepth(36)
      .setBlendMode(Phaser.BlendModes.ADD).setScale(glowScale).setAlpha(0.5);
    this.sparks = scene.add.particles(x, y - 7, 'spark', {
      lifespan: 650, speedY: { min: -42, max: -16 }, speedX: { min: -9, max: 9 },
      scale: { start: 1, end: 0 }, alpha: { start: 0.9, end: 0 },
      frequency: 85, quantity: 1, tint: [0xffce7a, 0xff8a3a], blendMode: 'ADD',
    }).setDepth(37);
  }

  /** Каждый кадр: мягкий фликер вразнобой (своя фаза/период) + лёгкий шум. */
  update(timeMs: number): void {
    const s = Math.sin(timeMs / this.period + this.phase);
    const f = 0.96 + 0.04 * s + (Math.random() - 0.5) * 0.03;
    this.flicker = f;
    this.flame.setScale(f).setAlpha(0.82 + Math.random() * 0.12);
    this.glow.setScale(this.glowScale * f).setAlpha(0.46 + 0.06 * s);
  }

  destroy(): void {
    this.base.destroy();
    this.flame.destroy();
    this.glow.destroy();
    this.sparks.destroy();
  }
}
