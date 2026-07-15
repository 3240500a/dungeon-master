import Phaser from 'phaser';

/**
 * Игрок — чистый вид (спрайт + указатель взгляда). Движение и коллизии считает
 * авторитетная `GameSession` (и в городе, и в подземелье); драйвер (SessionController)
 * ставит позицию спрайта из `p.pos`. Здесь — только отрисовка позиции и направление
 * взгляда к курсору (его читает драйвер как `input.facing`).
 */
/** Целевой размер спрайта игрока (по большей стороне), чтобы PNG любого размера были одинаковы. */
const SPRITE_SIZE = 40;

export class Player {
  readonly sprite: Phaser.GameObjects.Image;
  private marker: Phaser.GameObjects.Graphics;
  /** Угол взгляда (к курсору) в радианах. */
  facing = 0;
  /** Идёт ли (по смещению позиции за кадр) — для «подёргивания» при ходьбе. */
  private moving = false;
  private wobble = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, texture: string) {
    this.sprite = scene.add.image(x, y, texture).setDepth(5);
    // Нормируем размер: PNG-спрайты любого размера → ~SPRITE_SIZE по большей стороне.
    const src = Math.max(this.sprite.width, this.sprite.height) || SPRITE_SIZE;
    this.sprite.setScale(SPRITE_SIZE / src);
    this.marker = scene.add.graphics().setDepth(6);
  }

  /** Обновляет угол взгляда к курсору, «нос»-указатель и лёгкое покачивание при ходьбе. */
  update(pointer: Phaser.Input.Pointer, camera: Phaser.Cameras.Scene2D.Camera): void {
    // getWorldPoint учитывает зум/скролл камеры (иначе взгляд «уводит» при зуме != 1).
    const world = camera.getWorldPoint(pointer.x, pointer.y);
    this.facing = Math.atan2(world.y - this.sprite.y, world.x - this.sprite.x);
    const nx = this.sprite.x + Math.cos(this.facing) * 22;
    const ny = this.sprite.y + Math.sin(this.facing) * 22;
    this.marker.clear();
    this.marker.lineStyle(3, 0xffffff, 0.9);
    this.marker.lineBetween(this.sprite.x, this.sprite.y, nx, ny);
    this.marker.fillStyle(0xffffff, 0.9);
    this.marker.fillCircle(nx, ny, 3);

    // Покачивание-«вразвалку» пока идём (наклон ±~7°), плавный возврат к 0 в покое. Без анимации.
    if (this.moving) {
      this.wobble += 0.35;
      this.sprite.setRotation(Math.sin(this.wobble) * 0.12);
    } else {
      this.sprite.setRotation(this.sprite.rotation * 0.75);
    }
  }

  /** Ставит позицию спрайта (драйвер — из авторитетной позиции сессии). Заодно ловит «идёт ли». */
  setPos(x: number, y: number): void {
    const dx = x - this.sprite.x, dy = y - this.sprite.y;
    this.moving = dx * dx + dy * dy > 0.25; // сместился > 0.5px за кадр → идёт
    this.sprite.setPosition(x, y);
  }

  get x(): number {
    return this.sprite.x;
  }
  get y(): number {
    return this.sprite.y;
  }

  destroy(): void {
    this.marker.destroy();
    this.sprite.destroy();
  }
}
