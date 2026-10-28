import type { Panel, PanelFactory } from '../../ui/domUi.js';
import { button, COLORS, mk } from '../../ui/kit.js';
import { RUN_NODE_COLOR, runNodeLabel } from './runLabels.js';
import { LEGEND_TYPES, runMapView } from './runMapLayout.js';

/**
 * Панель «Карта забега» (v2, клавиша M). Рисует граф RunPlan из авторитетного кадра `runPlan`
 * (app.run): узлы по слоям (depth = столбец, lane = строка), рёбра-связи, текущий узел подсвечен,
 * достижимые следующие узлы (рёбра из текущего) выделены — «видно вперёд» как в Slay the Spire.
 * Спуск делается физически у выхода (голосование), не кликом по карте.
 *
 * ⭐⭐ 14.10 (Г5): САМА РАСКЛАДКА ЗДЕСЬ БОЛЬШЕ НЕ ЖИВЁТ — она в чистом `runMapLayout.ts`, который зовут И эта панель,
 * И генератор эталона для порта Unity. Прежде генератор держал КОПИЮ раскладки, а от расхождения сторожил список строк
 * исходника: числа, которые сверяет Unity, имели два источника. Панель теперь только рисует.
 *
 * ⭐ Г5: НОМЕРА ЭТАЖЕЙ НАД СТОЛБЦАМИ (и метка-привал среди них). В конечном забеге номер был не нужен, в бесконечном
 * спуске окно сидит на произвольной глубине — без номера карта не отвечает на свой единственный вопрос.
 *
 * ⭐⭐ 14.10 (Г3, В5): ЗДЕСЬ ЖЕ — «ЗАВЕРШИТЬ ЗАБЕГ», ЕДИНСТВЕННАЯ ДВЕРЬ К `finishRun`. До Г2 забег завершался сам на
 * финале (узел без выходов), с Г2 таких узлов нет — и завершить забег стало НЕЛЬЗЯ: уход в город его лишь паркует.
 * Кнопка — панелью, а не интерактивом у портала, потому что интерактив выбирается по БЛИЖАЙШЕМУ (`updateInteractions`):
 * второе действие в той же точке, что «Вернуться в город», было бы недостижимо. Сервер судит место сам
 * (`Room.finish` → `canLeave`: портал узла, точка входа или мёртвый) и отвечает `error{code:'far'}`.
 */
const SVG = 'http://www.w3.org/2000/svg';

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
      const access = app.config.get('balance').dungeonAccess;
      const view = runMapView(run?.plan, run?.currentNodeId, access.portalsAt, access.contentCycle);
      if (view.empty !== undefined) {
        body.append(mk('div', `font-size:13px;color:${COLORS.dim};min-width:280px`, view.empty));
        return;
      }
      const head = mk('div', 'margin-bottom:10px;font-size:12px');
      // Шапку собирает раскладка (её сверяет порт Unity) — здесь только разметка: жирное имя шаблона и приглушённый хвост.
      const [main, tail] = ((): [string, string] => {
        const at = view.head.indexOf(' · этажи ');
        return at < 0 ? [view.head, ''] : [view.head.slice(0, at), view.head.slice(at)];
      })();
      head.append(mk('span', `color:${COLORS.gold}`, main), mk('span', `color:${COLORS.dim}`, `${tail} (дальше — за развилкой)`));
      body.append(head);

      const scroller = mk('div', `overflow:auto;max-width:78vw;max-height:70vh;border:1px solid ${COLORS.border};border-radius:8px;background:${COLORS.panel2}`);
      const svg = svgEl('svg', { width: view.width, height: view.height, viewBox: `0 0 ${view.width} ${view.height}` });
      svg.style.display = 'block';

      // ⭐ Г5: полоса номеров этажей. Столбец пати — золотом, столбец метки — с «⌂» (портал в город): игрок видит,
      // через сколько этажей выход, не открывая HUD.
      for (const c of view.cols) {
        const t = svgEl('text', {
          x: c.x, y: 14, 'text-anchor': 'middle', 'font-size': 11, 'font-family': 'system-ui',
          fill: c.current ? COLORS.gold : COLORS.dim, 'font-weight': c.current ? 'bold' : 'normal',
        });
        t.textContent = c.waypoint ? `${c.label} ⌂` : c.label;
        svg.append(t);
      }

      // Рёбра (сначала, под узлами). Достижимые из текущего — ярче.
      for (const e of view.edges) {
        const a = view.nodes.find((n) => n.id === e.from);
        const b = view.nodes.find((n) => n.id === e.to);
        if (!a || !b) continue;
        svg.append(svgEl('line', {
          x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          stroke: e.stroke, 'stroke-width': e.width, 'stroke-opacity': e.opacity,
        }));
      }
      // Узлы.
      for (const n of view.nodes) {
        const g = svgEl('g', {});
        if (n.ring) g.append(svgEl('circle', { cx: n.x, cy: n.y, r: n.ring.r, fill: 'none', stroke: n.ring.stroke, 'stroke-width': n.ring.width }));
        g.append(svgEl('circle', { cx: n.x, cy: n.y, r: view.r, fill: n.fill, stroke: n.stroke, 'stroke-width': n.strokeWidth, 'fill-opacity': n.fillOpacity }));
        const label = svgEl('text', { x: n.x, y: n.labelY, 'text-anchor': 'middle', 'font-size': 10, fill: n.labelColor, 'font-family': 'system-ui' });
        label.textContent = n.label;
        g.append(label);
        if (n.star) {
          const badge = svgEl('text', { x: n.x, y: n.y + 4, 'text-anchor': 'middle', 'font-size': 11, fill: '#1a1a1a', 'font-weight': 'bold' });
          badge.textContent = '★';
          g.append(badge);
        }
        svg.append(g);
      }
      scroller.append(svg);
      body.append(scroller);

      const legend = mk('div', `margin-top:8px;font-size:11px;color:${COLORS.dim};display:flex;flex-wrap:wrap;gap:8px`);
      for (const t of LEGEND_TYPES) {
        const item = mk('span', 'display:inline-flex;align-items:center;gap:4px');
        const dot = mk('span', `width:10px;height:10px;border-radius:50%;background:${hex(RUN_NODE_COLOR[t])};display:inline-block`);
        item.append(dot, mk('span', '', runNodeLabel(t)));
        legend.append(item);
      }
      legend.append(mk('span', `color:${COLORS.dim}`, `⌂ — привал с порталом в город (места ${access.portalsAt.join(', ')} круга из ${access.contentCycle})`));
      body.append(legend);

      // ⭐ 14.10 (Г3, правка 7): В ГОРОДЕ КНОПКИ НЕТ — ТАМ ОНА НЕ РАБОТАЕТ. План забега остаётся в странице после ухода
      // в город (`core/app.ts` обнуляет `run` только в `forgetSession`), поэтому карта в городе открывается и рисуется, а
      // `Room.finish` вне подземелья отказывает: кнопка жалась впустую. Отказ сервера теперь внятный (кадр `error`, код
      // `far` — он правда для ВСЕХ клиентов, включая Unity), но правильный порядок — не предлагать человеку того, чего
      // нельзя: в городе забег закрывает «Забросить» в лобби, и строка ниже про это говорит.
      const fin = mk('div', `margin-top:12px;padding-top:10px;border-top:1px solid ${COLORS.border};display:flex;flex-direction:column;gap:5px`);
      if (app.state?.area === 'dungeon') {
        fin.append(button('Завершить забег (голосование)', () => { app.net.send({ t: 'finish' }); }, 'danger'));
        fin.append(mk('div', `font-size:11px;color:${COLORS.dim};font-style:italic;max-width:420px`,
          'Жать у портала привала или у точки входа. Уход в город порталом забег ПАРКУЕТ — его можно продолжить с того же узла; «Завершить» снимает забег у всей пати, и следующий спуск начнётся с выбранной на алтаре метки.'));
      } else {
        fin.append(mk('div', `font-size:11px;color:${COLORS.dim};font-style:italic;max-width:420px`,
          'Забег ПРИПАРКОВАН: спуск из города продолжит его с этого узла. Завершить его здесь нельзя — в городе это «Забросить» в лобби; «Завершить забег» появится в подземелье, у портала привала или у точки входа.'));
      }
      body.append(fin);
    },
  };
  return panel;
};
