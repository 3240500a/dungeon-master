import Phaser from 'phaser';

/**
 * Тестовая графика: генерируем плейсхолдер-текстуры кодом (цветные фигуры),
 * чтобы не тащить ассеты. Позже заменяется на настоящие спрайты/атласы.
 */
export function generatePlaceholderTextures(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 });

  const rect = (key: string, w: number, h: number, color: number, border = 0x000000) => {
    g.clear();
    g.fillStyle(color, 1);
    g.fillRect(0, 0, w, h);
    g.lineStyle(2, border, 1);
    g.strokeRect(1, 1, w - 2, h - 2);
    g.generateTexture(key, w, h);
  };

  const circle = (key: string, r: number, color: number) => {
    g.clear();
    g.fillStyle(color, 1);
    g.fillCircle(r, r, r);
    g.generateTexture(key, r * 2, r * 2);
  };

  // Персонажи (по классам).
  circle('player-warrior', 14, 0xcf4b4b);
  circle('player-mage', 14, 0x4b7bcf);
  circle('player-archer', 14, 0x4bcf6a);

  // Монстры.
  circle('mob-skeleton', 12, 0xe8e8e8);
  circle('mob-zombie', 13, 0x6a8f3c);
  circle('mob-archer', 12, 0x9a4bcf);

  // Тайлы подземелья. Стена — заметно светлее пола и чёрного тумана (иначе не отличить
  // стену от неисследованной клетки — «стены, сквозь которые ходишь»).
  rect('tile-floor', 32, 32, 0x2a2a33, 0x1e1e26);
  rect('tile-wall', 32, 32, 0x4a4d63, 0x666a86);
  rect('tile-stairs', 32, 32, 0xcaa64b, 0x7a6420);
  rect('tile-door', 32, 32, 0x8a5a2a, 0x4a2f14);

  // Декор и предметы мира.
  rect('decor-pillar', 24, 24, 0x3a3a46, 0x1e1e26);
  circle('decor-torch', 6, 0xffb040);
  rect('decor-chest', 22, 16, 0xcaa64b, 0x7a6420);
  circle('decor-arena', 40, 0x5a2a3a);
  rect('key', 14, 8, 0xffe066, 0x8a7020);

  // Прочее.
  rect('drop-item', 12, 12, 0xffd24b, 0x8a7020);
  rect('projectile', 8, 8, 0xffe680, 0x8a7020);
  rect('portal', 32, 40, 0x7b4bcf, 0x3a1f6a);
  rect('npc', 24, 28, 0x4bb0cf, 0x1f5a6a);
  rect('pixel', 4, 4, 0xffffff);
  // Ластик тумана (полноразмерный тайл без рамки).
  g.clear();
  g.fillStyle(0xffffff, 1);
  g.fillRect(0, 0, 34, 34);
  g.generateTexture('fog-eraser', 34, 34);

  g.destroy();
}
