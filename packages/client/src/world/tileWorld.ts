import Phaser from 'phaser';
import { TILE, Cell, gridSize, type Grid } from './grid.js';

export interface RenderedWorld {
  walls: Phaser.Physics.Arcade.StaticGroup;
  /** ВСЕ созданные тайлы (пол/стены/тени) — чтобы вызывающий уничтожил их при пересборке области. */
  objects: Phaser.GameObjects.GameObject[];
  widthPx: number;
  heightPx: number;
}

/**
 * Рисует сетку мира: пол — тайл-спрайты, стены — статические физические тела.
 * Используется и городом (ручная сетка), и подземельем (сгенерированная сетка).
 */
export function renderGrid(scene: Phaser.Scene, grid: Grid): RenderedWorld {
  const { cols, rows } = gridSize(grid);
  const walls = scene.physics.add.staticGroup();
  const objects: Phaser.GameObjects.GameObject[] = [];

  // Лёгкая вариативность оттенков, чтобы пол/стены читались лучше.
  const floorTints = [0xffffff, 0xf0f0f5, 0xe4e4ee, 0xf6f0e6];
  const wallTints = [0xffffff, 0xe8e8f0, 0xd8d8e2];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = x * TILE + TILE / 2;
      const py = y * TILE + TILE / 2;
      const noise = (x * 928371 + y * 1237) % 4;
      if (grid[y]![x] === Cell.Floor || grid[y]![x] === Cell.Door || grid[y]![x] === Cell.Pillar) {
        // Под колонной (Pillar) тоже рисуем пол — спрайт колонны кладёт сцена поверх.
        objects.push(scene.add.image(px, py, 'tile-floor').setTint(floorTints[noise]!).setDepth(-10));
      } else if (grid[y]![x] === Cell.Wall) {
        const wall = scene.add.image(px, py, 'tile-wall').setTint(wallTints[noise % wallTints.length]!);
        // Подсветка «грани» стены, если под ней пол (псевдо-объём).
        if (grid[y + 1]?.[x] === Cell.Floor) {
          objects.push(scene.add.image(px, py + TILE / 2 - 2, 'pixel').setTint(0x000000).setAlpha(0.35).setScale(TILE / 4, 1).setDepth(-9));
        }
        walls.add(wall);
        objects.push(wall);
      }
    }
  }

  const widthPx = cols * TILE;
  const heightPx = rows * TILE;
  scene.physics.world.setBounds(0, 0, widthPx, heightPx);
  scene.cameras.main.setBounds(0, 0, widthPx, heightPx);

  return { walls, objects, widthPx, heightPx };
}
