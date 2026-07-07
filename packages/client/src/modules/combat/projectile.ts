import Phaser from 'phaser';

export type ProjectileOwner = 'player' | 'monster';

/** Снаряд (стрела/магия/вражеский выстрел). Живёт ограниченное время. */
export class Projectile {
  readonly sprite: Phaser.Physics.Arcade.Image;
  readonly owner: ProjectileOwner;
  damage: number;
  private life: number;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    angle: number,
    speed: number,
    damage: number,
    owner: ProjectileOwner,
    tint = 0xffe680,
  ) {
    this.owner = owner;
    this.damage = damage;
    this.life = 1.5;
    this.sprite = scene.physics.add.image(x, y, 'projectile').setTint(tint);
    this.sprite.setDepth(6);
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    body.setCircle(4);
    (this.sprite as unknown as { proj: Projectile }).proj = this;
  }

  /** true, если снаряд истёк и уничтожен. */
  update(dt: number): boolean {
    this.life -= dt;
    if (this.life <= 0) {
      this.destroy();
      return true;
    }
    return false;
  }

  destroy(): void {
    this.sprite.destroy();
  }
}
