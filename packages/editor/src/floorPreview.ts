import { generateFloorParams, Cell, type FloorAlgoParams, type FloorFeatures, type DungeonLayout, type RoomPrefab } from '@dm/shared';
import { drawFloor } from './runGen.js';

export interface FloorPreviewSpec { algo: FloorAlgoParams; features?: FloorFeatures; lock: boolean; prefabs?: RoomPrefab[] }

/**
 * Живой canvas-превью одного этажа по его `algoParams` (тюнинг прямо в редакторе): pan/zoom + реролл
 * сида + метрики (комнат / пол% / выходы / формы). `redraw()` перечитывает спеку и перерисовывает —
 * зови на любое изменение полей формы. Рендер клеток переиспользует `drawFloor` из runGen.
 */
export function mountFloorPreview(getSpec: () => FloorPreviewSpec): { el: HTMLElement; redraw: () => void } {
  let seed = 0x51ed270b >>> 0;
  let exitCount = 1;
  let pan = { x: 0, y: 0 }, zoom = 1, fitted = false;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;min-width:0';

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  const reroll = document.createElement('button');
  reroll.textContent = '🎲 Реролл сида';
  reroll.style.cssText = 'padding:5px 10px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:#1c1c26;color:#e8e8f0;font-size:12px';
  // Выбор числа выходов для превью (в игре задаётся графом забега; тут — чтобы посмотреть развилку/разброс).
  const exBox = document.createElement('div');
  exBox.style.cssText = 'display:flex;gap:2px;align-items:center;font-size:12px;color:#a8a8be';
  exBox.append(document.createTextNode('выходов:'));
  const exBtns: HTMLButtonElement[] = [];
  for (const n of [1, 2, 3]) {
    const b = document.createElement('button');
    b.textContent = String(n);
    b.style.cssText = 'padding:3px 8px;cursor:pointer;border-radius:5px;border:1px solid #2c2c3a;background:#1c1c26;color:#e8e8f0;font-size:12px';
    b.addEventListener('click', () => { exitCount = n; exBtns.forEach((x, i) => x.style.background = [1, 2, 3][i] === exitCount ? '#3a3a4c' : '#1c1c26'); redraw(); });
    exBtns.push(b); exBox.append(b);
  }
  const cap = document.createElement('div');
  cap.style.cssText = 'font-size:12px;color:#a8a8be';
  bar.append(reroll, exBox, cap);
  wrap.append(bar);

  const vp = document.createElement('div');
  vp.style.cssText = 'position:relative;overflow:hidden;border:1px solid #2c2c3a;border-radius:6px;background:#0d0d13;touch-action:none;cursor:grab;width:100%;height:440px';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;position:absolute;left:0;top:0;image-rendering:pixelated;transform-origin:0 0';
  vp.append(canvas);
  wrap.append(vp);

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:#71718a';
  hint.textContent = 'Колесо — зум, перетаскивание — пан. Меняй параметры слева — превью обновляется.';
  wrap.append(hint);

  const applyFT = (): void => { canvas.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`; };
  const fit = (): void => { const w = vp.clientWidth || 600, h = vp.clientHeight || 440; zoom = Math.min(w / canvas.width, h / canvas.height, 1) || 1; pan = { x: 0, y: 0 }; applyFT(); };
  const floorPct = (L: DungeonLayout): number => { let f = 0, t = 0; for (const row of L.grid) for (const c of row) { t++; if (c === Cell.Floor) f++; } return t ? Math.round((f / t) * 100) : 0; };

  const redraw = (): void => {
    exBtns.forEach((x, i) => { x.style.background = [1, 2, 3][i] === exitCount ? '#3a3a4c' : '#1c1c26'; });
    const spec = getSpec();
    let L: DungeonLayout;
    try { L = generateFloorParams(spec.algo, seed, { exitCount, lock: spec.lock, features: spec.features, prefabs: spec.prefabs }); }
    catch (e) { cap.textContent = '⚠ ' + (e instanceof Error ? e.message : String(e)); return; }
    drawFloor(canvas, L, [], '#7fa0d0');
    const sh: Record<string, number> = {};
    for (const r of L.rooms) { const s = r.shape ?? 'rect'; sh[s] = (sh[s] ?? 0) + 1; }
    const shStr = ['ell', 'blob', 'round', 'hall'].map((s) => (sh[s] ? `${s}:${sh[s]}` : '')).filter(Boolean).join(' ');
    cap.textContent = `комнат ${L.rooms.length} · пол ${floorPct(L)}% · выходов ${L.exits.length}${shStr ? ' · ' + shStr : ''}`;
    if (!fitted) { fitted = true; requestAnimationFrame(fit); }
  };

  reroll.addEventListener('click', () => { seed = ((seed * 2654435761 + 1) >>> 0) || 1; redraw(); });

  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  vp.addEventListener('pointerdown', (e) => { dragging = true; sx = e.clientX; sy = e.clientY; ox = pan.x; oy = pan.y; vp.style.cursor = 'grabbing'; vp.setPointerCapture?.(e.pointerId); });
  vp.addEventListener('pointermove', (e) => { if (!dragging) return; pan.x = ox + (e.clientX - sx); pan.y = oy + (e.clientY - sy); applyFT(); });
  vp.addEventListener('pointerup', () => { dragging = false; vp.style.cursor = 'grab'; });
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = vp.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const nz = Math.max(0.2, Math.min(5, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    pan.x = mx - (mx - pan.x) * (nz / zoom); pan.y = my - (my - pan.y) * (nz / zoom); zoom = nz; applyFT();
  }, { passive: false });

  redraw();
  return { el: wrap, redraw };
}
