import Phaser from 'phaser';

interface LightSrc { x: number; y: number; radius: number; }

/**
 * Динамический свет (лайтмап): затемняющий слой во весь этаж (`RenderTexture`, depth 35 — под туманом),
 * в котором каждый кадр «прожигаются» мягкие круги света у игрока и факелов (blend ERASE). Тёплое
 * свечение факелов рисуют отдельные ADD-спрайты (см. Torch). Чисто клиент-вид; тьма — по конфигу
 * `balance.lighting` (растёт с глубиной). Слои: мир(1) < сущности(4-6) < СВЕТ(35) < туман(40) < UI.
 */
export class Lighting {
  private rt: Phaser.GameObjects.RenderTexture;
  private brush: Phaser.GameObjects.Image;
  private ambient: number;
  private readonly DARK = 0x0a0a16; // сине-фиолетовая тьма (под настроение)
  private readonly BASE = 256;      // размер текстуры light-soft

  constructor(scene: Phaser.Scene, widthPx: number, heightPx: number, ambient: number) {
    this.ambient = ambient;
    this.rt = scene.add.renderTexture(0, 0, widthPx, heightPx).setOrigin(0, 0).setDepth(35);
    // Кисть света вне дисплей-листа (add:false) — `rt.erase(brush)` прожигает тьму в мягкий круг
    // (как туман войны). Масштаб кисти задаёт радиус света.
    this.brush = scene.make.image({ x: 0, y: 0, key: 'light-soft', add: false });
  }

  /** Перерисовать тьму: залить ambient и прожечь свет у игрока + факелов (radius уже с фликером). */
  update(playerX: number, playerY: number, playerRadius: number, torches: LightSrc[]): void {
    this.rt.clear();
    this.rt.fill(this.DARK, this.ambient);
    this.erase(playerX, playerY, playerRadius);
    for (const t of torches) this.erase(t.x, t.y, t.radius);
  }

  private erase(x: number, y: number, radius: number): void {
    if (radius <= 0) return;
    this.brush.setPosition(x, y).setScale((radius * 2) / this.BASE);
    this.rt.erase(this.brush);
  }

  destroy(): void {
    this.rt.destroy();
    this.brush.destroy();
  }
}
