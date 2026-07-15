import Phaser from 'phaser';

/**
 * Игрок — чистый вид (спрайт + указатель взгляда). Движение и коллизии считает
 * авторитетная `GameSession` (и в городе, и в подземелье); драйвер (SessionController)
 * ставит позицию спрайта из `p.pos`. Здесь — только отрисовка позиции и направление
 * взгляда к курсору (его читает драйвер как `input.facing`).
 *
 * Логическая позиция хранится в `baseX/baseY`: её отдают геттеры x/y (VFX/туман/подбор —
 * стабильны) и за ней жёстко следует камера (через невидимый `anchor`). Видимый спрайт
 * лишь качается/подпрыгивает ВОКРУГ базовой точки — поэтому подскок не трясёт весь мир.
 */
/** Целевой размер спрайта игрока (по большей стороне), чтобы PNG любого размера были одинаковы.
 *  53 при зуме камеры 2.925 = тот же экранный размер, что 80 при зуме 1.95 (камеру приблизили на +50%,
 *  спрайт компенсирован, чтобы игрок остался прежним, а мир стал крупнее). */
const SPRITE_SIZE = 53;
/** Индикатор взгляда — еле заметная дуга «по краю зрения» в сторону курсора. */
const VISION_RADIUS = SPRITE_SIZE * 0.9;   // радиус дуги (чуть за спрайтом)
const VISION_HALF_ANGLE = 0.46;            // полураствор сектора (рад, ~26°)
const VISION_ALPHA = 0.25;                 // пик прозрачности (к концам гаснет до 0)
const VISION_WIDTH = 6;                     // толщина дуги (мировые px)
const VISION_SEGMENTS = 18;                 // сегментов дуги (для плавного гашения концов)
/** Амплитуда наклона «вразвалку» при ходьбе (рад) — мягкий, ~2.5°. */
const TILT_AMP = 0.045;
/** Высота подскока при ходьбе (мировые px) — лёгкий, в такт шагам (2 подскока на цикл качания). */
const BOUNCE_AMP = 3;

export class Player {
  readonly sprite: Phaser.GameObjects.Image;
  /** Невидимый якорь логической позиции — цель слежения камеры (спрайт прыгает, мир — нет). */
  private anchor: Phaser.GameObjects.Zone;
  private marker: Phaser.GameObjects.Graphics;
  /** Угол взгляда (к курсору) в радианах. */
  facing = 0;
  /** Идёт ли (по смещению позиции за кадр) — для качания/подскока при ходьбе. */
  private moving = false;
  private wobble = 0;
  /** Текущий подскок (мировые px, спрайт смещается вверх на это значение). */
  private bounce = 0;
  /** Логическая (авторитетная) позиция — вокруг неё спрайт качается/подпрыгивает. */
  private baseX: number;
  private baseY: number;

  constructor(scene: Phaser.Scene, x: number, y: number, texture: string) {
    this.sprite = scene.add.image(x, y, texture).setDepth(5);
    // Нормируем размер: PNG-спрайты любого размера → ~SPRITE_SIZE по большей стороне.
    const src = Math.max(this.sprite.width, this.sprite.height) || SPRITE_SIZE;
    this.sprite.setScale(SPRITE_SIZE / src);
    this.marker = scene.add.graphics().setDepth(6);
    this.anchor = scene.add.zone(x, y, 1, 1); // невидимый, только как цель камеры
    this.baseX = x;
    this.baseY = y;
  }

  /** Цель слежения камеры — стабильный якорь (не подпрыгивает вместе со спрайтом). */
  get cameraTarget(): Phaser.GameObjects.Zone {
    return this.anchor;
  }

  /** Обновляет угол взгляда к курсору, «нос»-указатель и качание/подскок при ходьбе. */
  update(pointer: Phaser.Input.Pointer, camera: Phaser.Cameras.Scene2D.Camera): void {
    // getWorldPoint учитывает зум/скролл камеры (иначе взгляд «уводит» при зуме != 1).
    const world = camera.getWorldPoint(pointer.x, pointer.y);
    this.facing = Math.atan2(world.y - this.baseY, world.x - this.baseX);

    // Пока идём: лёгкое качание-«вразвалку» (наклон ±TILT_AMP) + подскок в такт шагам
    // (|sin| даёт 2 подскока на один цикл качания = на каждый шаг). В покое — плавный возврат.
    if (this.moving) {
      this.wobble += 0.35;
      this.sprite.setRotation(Math.sin(this.wobble) * TILT_AMP);
      this.bounce = Math.abs(Math.sin(this.wobble)) * BOUNCE_AMP;
    } else {
      this.sprite.setRotation(this.sprite.rotation * 0.75);
      this.bounce *= 0.75;
    }
    this.sprite.setPosition(this.baseX, this.baseY - this.bounce);

    // Индикатор взгляда — еле заметная дуга «по краю зрения» в сторону курсора. Рисуем
    // короткими дуго-сегментами: прозрачность по параболе (ярче в центре, гаснет к концам).
    const cx = this.sprite.x, cy = this.sprite.y;
    this.marker.clear();
    for (let i = 0; i < VISION_SEGMENTS; i++) {
      const a0 = this.facing - VISION_HALF_ANGLE + (2 * VISION_HALF_ANGLE * i) / VISION_SEGMENTS;
      const a1 = this.facing - VISION_HALF_ANGLE + (2 * VISION_HALF_ANGLE * (i + 1)) / VISION_SEGMENTS;
      const t = ((i + 0.5) / VISION_SEGMENTS) * 2 - 1; // [-1..1] вдоль дуги
      this.marker.lineStyle(VISION_WIDTH, 0xffffff, VISION_ALPHA * (1 - t * t));
      this.marker.beginPath();
      this.marker.arc(cx, cy, VISION_RADIUS, a0, a1, false);
      this.marker.strokePath();
    }
  }

  /** Ставит позицию спрайта (драйвер — из авторитетной позиции сессии). Заодно ловит «идёт ли». */
  setPos(x: number, y: number): void {
    const dx = x - this.baseX, dy = y - this.baseY;
    this.moving = dx * dx + dy * dy > 0.25; // сместился > 0.5px за кадр → идёт
    this.baseX = x;
    this.baseY = y;
    this.anchor.setPosition(x, y);
    this.sprite.setPosition(x, y - this.bounce);
  }

  get x(): number {
    return this.baseX;
  }
  get y(): number {
    return this.baseY;
  }

  destroy(): void {
    this.marker.destroy();
    this.sprite.destroy();
    this.anchor.destroy();
  }
}
