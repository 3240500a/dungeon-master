import type { RunNode } from '@dm/shared';
import type { Panel, PanelFactory } from '../../ui/domUi.js';
import { COLORS, mk } from '../../ui/kit.js';
import { RUN_NODE_COLOR, runNodeLabel } from './runLabels.js';

/**
 * Панель «Карта забега» (v2, клавиша M). Рисует граф RunPlan из авторитетного кадра `runPlan`
 * (app.run): узлы по слоям (depth = столбец, lane = строка), рёбра-связи, текущий узел подсвечен,
 * достижимые следующие узлы (рёбра из текущего) выделены — «видно вперёд» как в Slay the Spire.
 * Только информация: спуск делается физически у выхода (голосование), не кликом по карте.
 */
const SVG = 'http://www.w3.org/2000/svg';
const COL_W = 96;
const ROW_H = 66;
const PAD = 28;
const R = 16;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
function hex(n: number): string { return '#' + n.toString(16).padStart(6, '0'); }

export const runMapPanel: PanelFactory = (app) => {
  const panel: Panel = {
    title: 'Карта забега',
    render(body) {
      const run = app.run;
      if (!run) {
        body.append(mk('div', `font-size:13px;color:${COLORS.dim};min-width:280px`, 'Забег не активен — карта появится в подземелье.'));
        return;
      }
      const { plan, currentNodeId } = run;
      const head = mk('div', 'margin-bottom:10px;font-size:12px');
      head.innerHTML =
        `Шаблон <b style="color:${COLORS.gold}">${plan.templateId}</b> · биом <b>${plan.biomeId}</b> · тир <b>${plan.tier}</b>` +
        ` <span style="color:${COLORS.dim}">· ${plan.nodes.length} узлов</span>`;
      body.append(head);

      // Раскладка: столбец = depth, строка = порядок узла внутри слоя (центрируем колонку).
      const byDepth = new Map<number, RunNode[]>();
      for (const n of plan.nodes) { const a = byDepth.get(n.depth) ?? []; a.push(n); byDepth.set(n.depth, a); }
      for (const a of byDepth.values()) a.sort((p, q) => p.lane - q.lane);
      const maxDepth = Math.max(...plan.nodes.map((n) => n.depth));
      const maxCol = Math.max(...[...byDepth.values()].map((a) => a.length));
      const width = PAD * 2 + maxDepth * COL_W;
      const height = PAD * 2 + (maxCol - 1) * ROW_H;
      const midY = PAD + (maxCol - 1) * ROW_H / 2;

      const pos = new Map<string, { x: number; y: number }>();
      for (const [depth, arr] of byDepth) {
        arr.forEach((n, i) => {
          const x = PAD + depth * COL_W;
          const y = midY + (i - (arr.length - 1) / 2) * ROW_H;
          pos.set(n.id, { x, y });
        });
      }

      const cur = plan.nodes.find((n) => n.id === currentNodeId);
      const nextIds = new Set(cur?.edges.map((e) => e.to) ?? []);

      const scroller = mk('div', `overflow:auto;max-width:78vw;max-height:70vh;border:1px solid ${COLORS.border};border-radius:8px;background:${COLORS.panel2}`);
      const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });
      svg.style.display = 'block';

      // Рёбра (сначала, под узлами). Достижимые из текущего — ярче.
      for (const n of plan.nodes) {
        const a = pos.get(n.id); if (!a) continue;
        for (const e of n.edges) {
          const b = pos.get(e.to); if (!b) continue;
          const hot = n.id === currentNodeId;
          svg.append(svgEl('line', {
            x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            stroke: hot ? COLORS.gold : '#4a4640', 'stroke-width': hot ? 2.5 : 1.5, 'stroke-opacity': hot ? 0.9 : 0.5,
          }));
        }
      }
      // Узлы.
      for (const n of plan.nodes) {
        const p = pos.get(n.id); if (!p) continue;
        const isCur = n.id === currentNodeId;
        const isNext = nextIds.has(n.id);
        const col = hex(RUN_NODE_COLOR[n.type] ?? 0x8a8f9a);
        const g = svgEl('g', {});
        if (isCur) g.append(svgEl('circle', { cx: p.x, cy: p.y, r: R + 6, fill: 'none', stroke: COLORS.gold, 'stroke-width': 3 }));
        g.append(svgEl('circle', {
          cx: p.x, cy: p.y, r: R, fill: col,
          stroke: isNext ? COLORS.gold : '#1a1a1a', 'stroke-width': isNext ? 2.5 : 1.5,
          'fill-opacity': isCur || isNext ? 1 : 0.82,
        }));
        const label = svgEl('text', {
          x: p.x, y: p.y + R + 13, 'text-anchor': 'middle', 'font-size': 10, fill: isCur ? COLORS.gold : '#c4bca8', 'font-family': 'system-ui',
        });
        label.textContent = runNodeLabel(n.type);
        g.append(label);
        if (n.modifiers.length) {
          const badge = svgEl('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', 'font-size': 11, fill: '#1a1a1a', 'font-weight': 'bold' });
          badge.textContent = '★';
          g.append(badge);
        }
        svg.append(g);
      }
      scroller.append(svg);
      body.append(scroller);

      const legend = mk('div', `margin-top:8px;font-size:11px;color:${COLORS.dim};display:flex;flex-wrap:wrap;gap:8px`);
      for (const t of ['combat', 'elite', 'boss', 'treasure', 'rest', 'finale'] as const) {
        const item = mk('span', 'display:inline-flex;align-items:center;gap:4px');
        const dot = mk('span', `width:10px;height:10px;border-radius:50%;background:${hex(RUN_NODE_COLOR[t])};display:inline-block`);
        item.append(dot, mk('span', '', runNodeLabel(t)));
        legend.append(item);
      }
      body.append(legend);
    },
  };
  return panel;
};
