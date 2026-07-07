import Phaser from 'phaser';
import { generatePlaceholderTextures } from '../core/textures.js';

/** Первичная инициализация: генерирует тестовые текстуры, затем Preload. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    generatePlaceholderTextures(this);
    this.scene.start('Preload');
  }
}
