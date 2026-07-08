import type { App } from '../../core/app.js';
import { isAllocatable, passiveNodeCost } from './allocate.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** Состояние вида (пан/зум) сохраняется между перерисовками панели. */
const view = { scale: 0, tx: 0, ty: 0, inited: false };

function commit(app: App): void {
  app.bus.emit('state:changed', {}); // онлайн: сейв авторитетен на сервере
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * Визуальный граф пассивного дерева: узлы-круги, рёбра-линии, пан (перетаскивание)
 * и зум (колесо). Клик по доступному узлу качает его за золото. Цвет = состояние:
 * вложен / доступен (смежен) / заблокирован; нотабли крупнее.
 */
export function renderPassiveTree(app: App, body: HTMLElement): void {
  const state = app.state!;
  const tree = app.config.get('skills-passive');

  const header = mk('div', 'margin-bottom:8px;font-size:13px');
  header.innerHTML =
    `Очки пассивов: <b style="color:${COLORS.accent}">${state.save.unspentPassivePoints}</b> · ` +
    `Золото: <b style="color:${COLORS.gold}">${state.save.gold}</b> · ` +
    `<span style="color:${COLORS.dim}">колесо — зум, перетаскивание — панорама, клик по доступному узлу — прокачать (очко + золото)</span>`;
  body.appendChild(header);

  const wrap = mk('div',
    `position:relative;width:100%;height:460px;background:${COLORS.panel2};` +
    `border:1px solid ${COLORS.border};border-radius:8px;overflow:hidden;cursor:grab`);
  const root = svg('svg', { width: '100%', height: '100%' });
  const g = svg('g', {});
  root.appendChild(g);
  wrap.appendChild(root);
  body.appendChild(wrap);

  const nodeById = new Map(tree.nodes.map((n) => [n.id, n]));

  // Инициализация вида: вписать граф по bbox (один раз на сессию).
  if (!view.inited) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of tree.nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const pad = 60;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const boxW = wrap.clientWidth || 760;
    const boxH = 460;
    view.scale = Math.min(boxW / w, boxH / h);
    view.tx = boxW / 2 - ((minX + maxX) / 2) * view.scale;
    view.ty = boxH / 2 - ((minY + maxY) / 2) * view.scale;
    view.inited = true;
  }

  const applyTransform = () => g.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.scale})`);
  applyTransform();

  // Рёбра.
  for (const [a, b] of tree.edges) {
    const na = nodeById.get(a);
    const nb = nodeById.get(b);
    if (!na || !nb) continue;
    const bothOn = (state.save.passiveSkills[a] ?? 0) > 0 && (state.save.passiveSkills[b] ?? 0) > 0;
    const line = svg('line', {
      x1: na.x, y1: na.y, x2: nb.x, y2: nb.y,
      stroke: bothOn ? '#8aa84a' : '#3e4756',
      'stroke-width': bothOn ? 3 : 1.5,
    });
    g.appendChild(line);
  }

  // Узлы.
  for (const node of tree.nodes) {
    const rank = state.save.passiveSkills[node.id] ?? 0;
    const allocated = rank > 0;
    const available = !allocated && isAllocatable(tree, state, node.id);
    const isEntry = tree.entryNodes.includes(node.id);
    const r = node.notable ? 15 : isEntry ? 12 : 9;

    let fill = '#1a1f29';
    let stroke = '#3e4756';
    if (allocated) { fill = node.notable ? COLORS.gold : '#8aa84a'; stroke = '#0a0a0a'; }
    else if (available) { fill = '#1e2a3a'; stroke = '#6f9bcf'; }
    if (isEntry && !allocated) stroke = COLORS.gold;

    const circle = svg('circle', {
      cx: node.x, cy: node.y, r,
      fill, stroke, 'stroke-width': node.notable ? 3 : 2,
    });
    if (available || allocated) circle.style.cursor = 'pointer';

    const maxRank = node.maxRank;
    const mult = app.config.get('balance').passiveRankCostMult;
    attachTooltip(circle, () => {
      const eff = (node.effect.modifiers ?? [])
        .map((m) => `${m.kind === 'increased' ? '+' + Math.round(m.value * 100) + '%' : '+' + m.value} ${m.stat}`)
        .join(', ');
      const nextCost = passiveNodeCost(node.cost.amount, rank, mult);
      const costLine = rank >= maxRank
        ? 'макс. ранг'
        : `след. ранг: ${nextCost} зол. + 1 очко`;
      return `<div style="color:${node.notable ? COLORS.gold : COLORS.text};font-weight:bold">${node.name}</div>` +
        `<div style="color:#c4bca8">${node.description}</div>` +
        `<div style="color:#9aa;margin-top:3px">ранг ${rank}/${maxRank} · ${costLine}</div>` +
        (eff ? `<div style="color:#8fd">${eff}</div>` : '');
    });

    circle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dragMoved) return;
      app.sendCmd({ cmd: 'allocPassive', nodeId: node.id });
    });
    g.appendChild(circle);
  }

  // ── Пан/зум ────────────────────────────────────────────
  let dragging = false;
  let dragMoved = false;
  let lastX = 0;
  let lastY = 0;

  wrap.addEventListener('pointerdown', (e) => {
    dragging = true;
    dragMoved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    wrap.style.cursor = 'grabbing';
  });
  window.addEventListener('pointerup', () => {
    dragging = false;
    wrap.style.cursor = 'grab';
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
    view.tx += dx;
    view.ty += dy;
    lastX = e.clientX;
    lastY = e.clientY;
    applyTransform();
  });
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.max(0.2, Math.min(3, view.scale * factor));
    // Зум вокруг курсора.
    view.tx = mx - ((mx - view.tx) * newScale) / view.scale;
    view.ty = my - ((my - view.ty) * newScale) / view.scale;
    view.scale = newScale;
    applyTransform();
  }, { passive: false });
}

/** Сброс вида (напр. при открытии новой игры). */
export function resetPassiveView(): void {
  view.inited = false;
}
