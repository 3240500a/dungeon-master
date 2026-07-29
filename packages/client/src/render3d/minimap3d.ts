/**
 * Миникарта 3D-клиента: DOM-канвас в углу с планом текущего этажа (стены из `floor.grid`), игроком
 * (треугольник по facing), монстрами (красные), пирами (голубые) и метками мира (NPC/портал/лестница/
 * рычаги/двери). North-up, вся карта целиком. Данные — из online3d каждый кадр. Тумана войны пока нет
 * (показываем весь этаж); раскрытие по видимости — отдельная доработка.
 */
import { Cell, TILE, type Grid } from '@dm/shared';

export interface MiniMark { x: number; y: number; kind: 'portal' | 'lever' | 'npc' | 'door' }
export interface MiniActor { x: number; z: number }

export interface Minimap3d {
  setFloor(grid: Grid): void;
  render(px: number, pz: number, facing: number, monsters: MiniActor[], peers: MiniActor[], marks: MiniMark[]): void;
  setVisible(v: boolean): void;
}

export function mountMinimap(root: HTMLElement): Minimap3d {
  const SIZE = 190;
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:fixed;top:70px;right:12px;z-index:55;width:${SIZE}px;height:${SIZE}px;` +
    'border:1px solid #3a4460;border-radius:8px;overflow:hidden;background:rgba(8,10,16,0.72);display:none;pointer-events:none';
  const cv = document.createElement('canvas'); cv.width = SIZE; cv.height = SIZE;
  cv.style.cssText = 'width:100%;height:100%;display:block';
  wrap.appendChild(cv); root.appendChild(wrap);
  const g = cv.getContext('2d')!;
  let grid: Grid | null = null, cols = 0, rows = 0, scale = 1, offX = 0, offY = 0;

  const setFloor = (gr: Grid): void => {
    grid = gr; rows = gr.length; cols = gr[0]?.length ?? 0;
    const wW = cols * TILE, wH = rows * TILE;
    scale = Math.min(SIZE / wW, SIZE / wH) * 0.94;                 // вписать весь этаж с полями
    offX = (SIZE - wW * scale) / 2; offY = (SIZE - wH * scale) / 2;
  };
  const mx = (worldX: number): number => offX + worldX * scale;   // мир(x) → канвас
  const my = (worldZ: number): number => offY + worldZ * scale;   // мир(y/z) → канвас (north-up)
  const dot = (x: number, z: number, r: number, color: string): void => { g.fillStyle = color; g.beginPath(); g.arc(mx(x), my(z), r, 0, 6.283); g.fill(); };

  const render = (px: number, pz: number, facing: number, monsters: MiniActor[], peers: MiniActor[], marks: MiniMark[]): void => {
    if (!grid) return;
    g.clearRect(0, 0, SIZE, SIZE);
    const cs = TILE * scale + 0.6;
    for (let y = 0; y < rows; y++) {
      const rowArr = grid[y]!;
      for (let x = 0; x < cols; x++) {
        const c = rowArr[x]; if (c === undefined) continue;
        g.fillStyle = c === Cell.Wall ? '#2b3242' : '#12161f';     // стена / пол
        g.fillRect(mx(x * TILE), my(y * TILE), cs, cs);
      }
    }
    for (const m of marks) dot(m.x, m.y, 3, m.kind === 'portal' ? '#8a5cff' : m.kind === 'lever' ? '#dca94b' : m.kind === 'door' ? '#6a4a2a' : '#6fd0ff');
    for (const mo of monsters) dot(mo.x, mo.z, 2.3, '#d8583e');
    for (const pr of peers) dot(pr.x, pr.z, 2.6, '#5aa0ff');
    const cx = mx(px), cy = my(pz);                                // игрок — треугольник по facing
    g.save(); g.translate(cx, cy); g.rotate(facing);
    g.fillStyle = '#f2ede1'; g.beginPath(); g.moveTo(6, 0); g.lineTo(-4, -3.5); g.lineTo(-4, 3.5); g.closePath(); g.fill();
    g.restore();
  };
  const setVisible = (v: boolean): void => { wrap.style.display = v ? 'block' : 'none'; };
  return { setFloor, render, setVisible };
}
