import type { App } from '../../core/app.js';
import type { SkillTreeNode } from '@dm/shared';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';
import { activeTreeFor } from '../skills-active/allocate.js';
import { elementOf, elementColor, elementLabel } from './skillIcon.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** Состояние вида (пан/зум) сохраняется между перерисовками панели. */
const view = { scale: 0, tx: 0, ty: 0, inited: false };

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Цвет стороны единого древа по ресурсу/группе (боевые слева, магия справа, класс сверху). */
function sideColor(resource: string, group: string): string {
  if (group === 'class') return '#d0a94e';   // классовые — золото
  if (resource === 'mana') return '#5478b0'; // магия — синий
  if (resource === 'stamina') return '#8a9a3e'; // боевые — жёлто-зелёный
  return '#8a7d64';                           // none (броня) — тан
}

/** Сброс вида (напр. при смене персонажа). */
export function resetSkillTreeView(): void {
  view.inited = false;
}

/**
 * Единое ДРЕВО СКИЛОВ как холст-граф (по образцу пассивки): из центра ветви расходятся
 * во все стороны — слева боевые (выносливость), справа магия (мана), низ — броня, верх — класс.
 * Узлы-квадраты (актив крупнее и с цветом стихии, пассив — тон стороны, нотабли крупнее).
 * Пан (перетаскивание) + зум (колесо). Клик по доступному узлу вкладывает очко скилла.
 * В игре видны универсальные ветки + сигнатурная ветка своего класса.
 */
export function renderSkillTree(app: App, body: HTMLElement): void {
  const state = app.state!;
  const tree = activeTreeFor(app.config);
  const own = state.save.classId;

  // Видимые ветки: универсальные + своя классовая. Узлы/рёбра фильтруем по ним.
  const visBranch = new Map(
    tree.branches.filter((b) => !b.classId || b.classId === own).map((b) => [b.id, b] as const),
  );
  const nodes = (tree.nodes as SkillTreeNode[]).filter((n) => visBranch.has(n.branchId));
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  const edges = tree.edges.filter(([a, b]) => nodeById.has(a) && nodeById.has(b));

  const rankOf = (id: string): number => state.save.skills[id] ?? 0;
  const neighbors = (id: string): string[] =>
    edges.flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []));
  const entrySet = new Set(tree.entryNodes);
  const isAvail = (n: SkillTreeNode): boolean =>
    entrySet.has(n.id) || neighbors(n.id).some((x) => rankOf(x) > 0);

  const header = mk('div', 'margin-bottom:8px;font-size:13px');
  header.innerHTML =
    `Очки скиллов: <b style="color:${COLORS.gold}">${state.save.unspentSkillPoints}</b> · ` +
    `<span style="color:${COLORS.dim}">колесо — зум, перетаскивание — панорама, клик по доступному узлу — вложить очко</span>`;
  body.appendChild(header);

  const wrap = mk('div',
    `position:relative;width:100%;height:460px;background:${COLORS.panel2};` +
    `border:1px solid ${COLORS.border};border-radius:8px;overflow:hidden;cursor:grab`);

  // Ярлыки сторон (оверлей поверх холста, не двигаются при пане/зуме).
  const sideLbl = (txt: string, pos: string, color: string): void => {
    const d = mk('div',
      `position:absolute;${pos};font-size:12px;font-weight:700;color:${color};` +
      `opacity:0.85;pointer-events:none;text-shadow:0 1px 2px #000;z-index:2`);
    d.textContent = txt;
    wrap.appendChild(d);
  };
  sideLbl('◀ Боевые · выносливость', 'left:10px;top:8px', '#9aa63c');
  sideLbl('Магия · мана ▶', 'right:10px;top:8px', '#7fa6d8');
  sideLbl('▲ Классовые', 'left:50%;top:8px;transform:translateX(-50%)', '#e0b45a');

  const root = svg('svg', { width: '100%', height: '100%' });
  const g = svg('g', {});
  root.appendChild(g);
  wrap.appendChild(root);
  body.appendChild(wrap);

  // Инициализация вида: вписать граф по bbox видимых узлов (один раз на сессию).
  if (!view.inited && nodes.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const pad = 50;
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

  // ── Рёбра (цвет — золото, если оба вложены; иначе приглушённый тон стороны) ──
  for (const [a, b] of edges) {
    const na = nodeById.get(a)!;
    const nb = nodeById.get(b)!;
    const both = rankOf(a) > 0 && rankOf(b) > 0;
    const br = visBranch.get(na.branchId)!;
    const line = svg('line', {
      x1: na.x, y1: na.y, x2: nb.x, y2: nb.y,
      stroke: both ? '#d9b45a' : sideColor(br.resource, br.group),
      'stroke-width': both ? 3 : 1.4,
      'stroke-opacity': both ? 1 : 0.45,
    });
    g.appendChild(line);
  }

  // ── Узлы-квадраты ──
  for (const n of nodes) {
    const rank = rankOf(n.id);
    const alloc = rank > 0;
    const avail = !alloc && isAvail(n);
    const isActive = !!n.effect.active;
    const notable = !!n.notable;
    const br = visBranch.get(n.branchId)!;
    const accent = isActive ? elementColor(elementOf(n)) : sideColor(br.resource, br.group);
    const size = notable ? 22 : isActive ? 18 : 15;

    let fill = '#141821';
    let stroke = '#333a48';
    let sw = notable ? 2.4 : 1.6;
    if (alloc) { fill = accent; stroke = '#f2d792'; sw = notable ? 3 : 2.2; }
    else if (avail) {
      const lowLvl = state.save.level < n.levelReq;
      fill = lowLvl ? '#241d17' : '#1c2430';
      stroke = lowLvl ? '#6b563a' : accent;
      sw = notable ? 3 : 2;
    }
    if (entrySet.has(n.id) && !alloc) stroke = COLORS.gold; // вход ветки — золотой контур

    const rect = svg('rect', {
      x: n.x - size / 2, y: n.y - size / 2, width: size, height: size,
      rx: notable ? 6 : 4, fill, stroke, 'stroke-width': sw,
    });
    if (avail || alloc) rect.style.cursor = 'pointer';

    attachTooltip(rect, () => {
      const kindLbl = isActive ? 'Активный скилл' : 'Пассивный скилл';
      const elLine = isActive
        ? `<div style="color:${elementColor(elementOf(n))}">Стихия: ${elementLabel(elementOf(n))}</div>` : '';
      const costLine = rank >= n.maxRank ? 'макс. ранг' : `след. ранг: ${n.cost.amount} очк.`;
      const lvlLine = state.save.level < n.levelReq
        ? `<div style="color:#d89b7c">требуется уровень ${n.levelReq}</div>` : '';
      return `<div style="color:${notable ? COLORS.gold : COLORS.text};font-weight:bold">${n.name}</div>` +
        `<div style="color:#9aa">${kindLbl} · ${br.name}</div>` +
        `<div style="color:#c4bca8">${n.description}</div>` + elLine +
        `<div style="color:#9aa;margin-top:3px">ранг ${rank}/${n.maxRank} · ${costLine}</div>` + lvlLine;
    });

    rect.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dragMoved) return;
      app.sendCmd({ cmd: 'allocSkill', nodeId: n.id });
    });
    g.appendChild(rect);
  }

  // ── Подписи веток у внешнего края (цвет — по стороне) ──
  for (const br of visBranch.values()) {
    const bn = nodes.filter((n) => n.branchId === br.id);
    if (!bn.length) continue;
    let far = bn[0]!;
    let fd = far.x * far.x + far.y * far.y;
    for (const n of bn) {
      const d = n.x * n.x + n.y * n.y;
      if (d > fd) { fd = d; far = n; }
    }
    const len = Math.max(1, Math.hypot(far.x, far.y));
    const lx = far.x + (far.x / len) * 26;
    const ly = far.y + (far.y / len) * 26;
    const anchor = lx < -20 ? 'end' : lx > 20 ? 'start' : 'middle';
    const t = svg('text', {
      x: lx, y: ly, 'text-anchor': anchor, 'dominant-baseline': 'central',
      'font-size': 15, fill: sideColor(br.resource, br.group), 'fill-opacity': 0.92,
    });
    t.textContent = br.name;
    g.appendChild(t);
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
    view.tx = mx - ((mx - view.tx) * newScale) / view.scale;
    view.ty = my - ((my - view.ty) * newScale) / view.scale;
    view.scale = newScale;
    applyTransform();
  }, { passive: false });
}
