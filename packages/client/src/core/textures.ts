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

  // Тайлы подземелья (тёплый факельный камень). ВАЖНЫЙ ИНВАРИАНТ ЧИТАЕМОСТИ: стена
  // заметно светлее пола И чёрного тумана (иначе не отличить стену от неисследованной
  // клетки — «стены, сквозь которые ходишь»). Порядок яркости: стена ≫ пол ≫ туман(0x000000).
  rect('tile-floor', 32, 32, 0x241f28, 0x15131a); // тёмный тёплый камень-пол
  rect('tile-wall', 32, 32, 0x54504a, 0x776f5f);  // освещённая факелом кладка (светлее пола)
  rect('tile-stairs', 32, 32, 0xdca94b, 0x7a5e24); // факельное золото
  rect('tile-door', 32, 32, 0x7c5228, 0x40280f);   // тёмное дерево

  // Декор и предметы мира.
  rect('decor-pillar', 24, 24, 0x413c38, 0x1c1a18); // тёплая колонна (между полом и стеной)
  circle('decor-torch', 6, 0xffb24a);               // пламя факела
  rect('decor-chest', 22, 16, 0xc99a48, 0x6e5420);
  circle('decor-arena', 40, 0x582530);              // кровавый ритуальный круг
  rect('key', 14, 8, 0xe8c24a, 0x8a6a20);

  // Прочее.
  rect('drop-item', 12, 12, 0xdca94b, 0x8a6a20);    // палитровое золото лута
  rect('projectile', 8, 8, 0xf0d98a, 0x8a6a20);
  rect('portal', 32, 40, 0x5b6fb8, 0x2a3550);       // арканная сталь-луна
  rect('npc', 24, 28, 0x6f9bcf, 0x2a4a6a);          // стальной силуэт NPC
  rect('pixel', 4, 4, 0xffffff);
  // Ластик тумана (полноразмерный тайл без рамки).
  g.clear();
  g.fillStyle(0xffffff, 1);
  g.fillRect(0, 0, 34, 34);
  g.generateTexture('fog-eraser', 34, 34);

  g.destroy();
}
