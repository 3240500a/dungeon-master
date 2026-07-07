import Phaser from 'phaser';
import { TILE, gridSize, type Grid } from './grid.js';
import { hasLineOfSight } from './lineOfSight.js';

/**
 * Туман войны: чёрный слой поверх мира, который постепенно «стирается» в клетках,
 * которые игрок увидел (в радиусе + по прямой видимости). Раскрытие постоянное
 * (как во многих roguelike). Дешёвый пересчёт — раз в ~100 мс, только новые клетки.
 */
export class FogOfWar {
  private rt: Phaser.GameObjects.RenderTexture;
  private grid: Grid;
  private explored: Uint8Array;
  private cols: number;
  private rows: number;
  private accum = 0;

  constructor(scene: Phaser.Scene, grid: Grid, widthPx: number, heightPx: number) {
    this.grid = grid;
    const { cols, rows } = gridSize(grid);
    this.cols = cols;
    this.rows = rows;
    this.explored = new Uint8Array(cols * rows);
    this.rt = scene.add.renderTexture(0, 0, widthPx, heightPx).setOrigin(0, 0).setDepth(40);
    this.rt.fill(0x000000, 1);
  }

  /** Раскрывает клетки вокруг игрока (throttle). radiusTiles — радиус обзора. */
  update(px: number, py: number, dtMs: number, radiusTiles = 7): void {
    this.accum += dtMs;
    if (this.accum < 100) return;
    this.accum = 0;
    this.reveal(px, py, radiusTiles);
  }

  /**
   * Немедленно раскрывает область (без throttle) — вызывается на спавне, чтобы игрок
   * никогда не стартовал в полностью чёрном экране (страховка от «тёмного» этажа).
   * Стартовый пятачок раскрываем без проверки LoS (радиус поменьше), затем по LoS.
   */
  revealSpawn(px: number, py: number, radiusTiles = 7): void {
    this.reveal(px, py, radiusTiles);
    // Гарантированный пятачок 2 клетки вокруг спавна — даже если LoS капризничает.
    const pcx = Math.floor(px / TILE);
    const pcy = Math.floor(py / TILE);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const tx = pcx + dx;
        const ty = pcy + dy;
        if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) continue;
        const idx = ty * this.cols + tx;
        if (this.explored[idx]) continue;
        this.explored[idx] = 1;
        this.rt.erase('fog-eraser', tx * TILE - 1, ty * TILE - 1);
      }
    }
  }

  private reveal(px: number, py: number, r: number): void {
    const pcx = Math.floor(px / TILE);
    const pcy = Math.floor(py / TILE);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const tx = pcx + dx;
        const ty = pcy + dy;
        if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) continue;
        const idx = ty * this.cols + tx;
        if (this.explored[idx]) continue;
        const cx = tx * TILE + TILE / 2;
        const cy = ty * TILE + TILE / 2;
        if (!hasLineOfSight(this.grid, px, py, cx, cy)) continue;
        this.explored[idx] = 1;
        this.rt.erase('fog-eraser', tx * TILE - 1, ty * TILE - 1);
      }
    }
  }

  destroy(): void {
    this.rt.destroy();
  }
}
