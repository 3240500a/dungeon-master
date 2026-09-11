/**
 * Общие DOM-хелперы граф-редакторов (пассивное древо мастерства + древо скилов):
 * поля-инпуты, заголовки, кнопки и всплывающее контекстное меню. Вынесены сюда, чтобы
 * не дублировать между `passiveGraph.ts` и `skillGraph.ts`.
 */

export const inputCss =
  'width:100%;box-sizing:border-box;padding:5px 6px;background:#1c1c26;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:5px;font-size:12px';

export function hdr(text: string): HTMLElement {
  const h = document.createElement('div');
  h.textContent = text;
  h.style.cssText = 'font-weight:600;color:#e8e8f0;font-size:13px;margin:12px 0 6px;border-bottom:1px solid #2c2c3a;padding-bottom:3px';
  return h;
}
export function field(label: string, input: HTMLElement): HTMLElement {
  const box = document.createElement('label');
  box.style.cssText = 'display:block;font-size:11px;color:#9aa0b0;margin:6px 0';
  const l = document.createElement('div'); l.textContent = label; l.style.marginBottom = '3px';
  box.append(l, input);
  return box;
}
export function textInput(value: string, onInput: (v: string) => void): HTMLInputElement {
  const el = document.createElement('input'); el.type = 'text'; el.value = value; el.style.cssText = inputCss;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}
export function numInput(value: number, step: number, onInput: (v: number) => void): HTMLInputElement {
  const el = document.createElement('input'); el.type = 'number'; el.step = String(step); el.value = String(value); el.style.cssText = inputCss;
  el.addEventListener('input', () => onInput(parseFloat(el.value) || 0));
  return el;
}
export function selectInput(opts: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = document.createElement('select'); el.style.cssText = inputCss;
  for (const [v, label] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = label; if (v === value) o.selected = true; el.appendChild(o); }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}
export function checkRow(label: string, checked: boolean, onToggle: () => void): HTMLElement {
  const box = document.createElement('label');
  box.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#c9cdd8;margin:8px 0;cursor:pointer';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked;
  cb.addEventListener('change', onToggle);
  box.append(cb, txt(label));
  return box;
}
export function txt(s: string, color = '#c9cdd8'): HTMLElement {
  const el = document.createElement('span'); el.textContent = s; el.style.color = color; el.style.fontSize = '12px';
  return el;
}
export function smallBtn(text: string, onClick: () => void, bg = '#2c2c3a'): HTMLButtonElement {
  const b = document.createElement('button'); b.textContent = text;
  b.style.cssText = `padding:4px 8px;cursor:pointer;background:${bg};color:#e8e8f0;border:1px solid #3c3c4a;border-radius:5px;font-size:12px`;
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return b;
}

// ── Контекстное меню (одно на всё приложение) ────────────────────────────────────
let menuEl: HTMLElement | null = null;
export function closeMenu(): void { if (menuEl) { menuEl.remove(); menuEl = null; } }
export function showMenu(clientX: number, clientY: number, items: { label: string; fn: () => void }[]): void {
  closeMenu();
  const m = document.createElement('div');
  m.style.cssText = `position:fixed;left:${clientX}px;top:${clientY}px;z-index:1000;background:#1c1c26;border:1px solid #3c3c4a;border-radius:6px;padding:4px;box-shadow:0 6px 18px rgba(0,0,0,.5);min-width:170px`;
  for (const it of items) {
    const b = document.createElement('div');
    b.textContent = it.label;
    b.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:13px;color:#e8e8f0;border-radius:4px';
    b.addEventListener('mouseenter', () => { b.style.background = '#33334a'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', () => { closeMenu(); it.fn(); });
    m.appendChild(b);
  }
  menuEl = m;
  document.body.appendChild(m);
  setTimeout(() => {
    const off = (e: MouseEvent): void => { if (menuEl && !menuEl.contains(e.target as Node)) { closeMenu(); window.removeEventListener('pointerdown', off, true); } };
    window.addEventListener('pointerdown', off, true);
  }, 0);
}

// ── КАНВАС ГРАФА ─────────────────────────────────────────────────────────────────────────────────
// Пан/зум/драг узлов и рисование рёбер — общая механика любого узлового редактора. До этого она жила
// внутри `skillGraph.ts`, сросшаяся с моделью древа скилов, и переиспользовать её было нельзя.
// Здесь она не знает НИЧЕГО о содержимом узла: снаружи дают позиции и рисуют начинку сами.
const SVGNS = 'http://www.w3.org/2000/svg';

/**
 * СЧЁТЧИК ДВОЙНОГО КЛИКА ПО УЗЛУ.
 *
 * Отдельно от DOM по двум причинам. Первая — его можно проверить. Вторая важнее: события `dblclick`
 * здесь НЕ БЫВАЕТ В ПРИНЦИПЕ, и это надо было где-то записать. Первый клик выделяет узел, выделение
 * перерисовывает холст, а перерисовка пересоздаёт ВСЕ узлы — значит второй клик приходит уже в другой
 * элемент, общего предка у пары нет, и браузер `dblclick` не выдаёт. Ловится только живой мышью:
 * синтетическое событие, посланное прямо на узел, проходит и создаёт ложное ощущение, что всё цело.
 */
export interface ClickTracker { hit(id: string, now: number): 'enter' | 'select'; reset(): void }
export function clickTracker(dblMs = 420): ClickTracker {
  let last = { id: '', t: -1e9 };
  return {
    hit(id, now) {
      if (last.id === id && now - last.t < dblMs) {
        last = { id: '', t: -1e9 };   // третий клик подряд — снова выбор, а не второй вход
        return 'enter';
      }
      last = { id, t: now };
      return 'select';
    },
    reset() { last = { id: '', t: -1e9 }; },   // перетащили узел — это не клик
  };
}

export interface GraphNodeView { id: string; x: number; y: number; w: number; h: number }
export interface GraphEdgeView {
  from: string;
  to: string;
  color?: string;
  /** Пунктир — для ВЫВОДИМЫХ рёбер (кто кого может перебить), сплошная — для авторских. */
  dashed?: boolean;
  label?: string;
}
export interface GraphCanvas {
  draw(nodes: GraphNodeView[], edges: GraphEdgeView[]): void;
  fit(): void;
  /** Слой для начинки узла: туда кладут текст/иконки поверх рамки. */
  layerFor(id: string): SVGGElement | null;
  el: SVGSVGElement;
}
export interface GraphCanvasOpts {
  onSelect?(id: string | null): void;
  onMove?(id: string, x: number, y: number): void;
  onContext?(id: string | null, clientX: number, clientY: number): void;
  selected?(): string | null;
  /** Двойной клик по узлу — ЗАЙТИ внутрь него (подмашина состояний в Unity открывается так же). */
  onEnter?(id: string): void;
}

/**
 * Канвас графа в `host`.
 *
 * Драг узла отличается от пана холста по тому, ГДЕ нажали: узел ловит событие первым и гасит
 * всплытие. Порог в 3 пикселя отделяет клик от перетаскивания — без него любой выбор узла сдвигал бы
 * его на пиксель и писал в конфиг.
 */
export function graphCanvas(host: HTMLElement, opts: GraphCanvasOpts = {}): GraphCanvas {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
  svg.style.cssText = 'display:block;cursor:grab;touch-action:none;background:#12151d;border:1px solid #39415a;border-radius:6px';
  // СЕТКА. На большом холсте без неё не видно ни пана, ни зума: узлы просто «прыгают» в пустоте.
  // Живёт в defs как паттерн и не входит в мировые координаты — иначе её пришлось бы перерисовывать.
  const defs = document.createElementNS(SVGNS, 'defs');
  const mkGrid = (id: string, step: number, color: string, w: string): SVGPatternElement => {
    const p = document.createElementNS(SVGNS, 'pattern');
    p.setAttribute('id', id); p.setAttribute('width', String(step)); p.setAttribute('height', String(step));
    p.setAttribute('patternUnits', 'userSpaceOnUse');
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', `M${step} 0 L0 0 0 ${step}`);
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', color); path.setAttribute('stroke-width', w);
    p.append(path); return p;
  };
  const gridS = mkGrid('gk-grid-s', 16, '#1a1f2c', '1');
  const gridL = mkGrid('gk-grid-l', 128, '#222939', '1');
  defs.append(gridS, gridL);
  const bgS = document.createElementNS(SVGNS, 'rect');
  const bgL = document.createElementNS(SVGNS, 'rect');
  for (const [r, f] of [[bgS, 'url(#gk-grid-s)'], [bgL, 'url(#gk-grid-l)']] as const) {
    r.setAttribute('x', '-100000'); r.setAttribute('y', '-100000');
    r.setAttribute('width', '200000'); r.setAttribute('height', '200000');
    r.setAttribute('fill', f);
  }
  const vp = document.createElementNS(SVGNS, 'g');
  const gEdges = document.createElementNS(SVGNS, 'g');
  const gNodes = document.createElementNS(SVGNS, 'g');
  vp.append(bgS, bgL, gEdges, gNodes); svg.append(defs, vp); host.appendChild(svg);

  let pan = { x: 20, y: 20 }, zoom = 1;
  let nodes: GraphNodeView[] = [], edges: GraphEdgeView[] = [];
  const clicks = clickTracker();   // «выбор или вход» — см. `clickTracker`, событие dblclick тут бесполезно
  const layers = new Map<string, SVGGElement>();
  const apply = (): void => vp.setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${zoom})`);
  const toLocal = (cx: number, cy: number): { x: number; y: number } => {
    const r = svg.getBoundingClientRect();
    return { x: (cx - r.left - pan.x) / zoom, y: (cy - r.top - pan.y) / zoom };
  };
  /**
   * Ребро — кубическая кривая, и она обязана выходить С ТОЙ СТОРОНЫ узла, куда идёт.
   *
   * Раньше выход был всегда правый, а вход всегда левый. Для горизонтального графа это верно, а для
   * СТОЛБИКА (стек слоёв) кривая уходила вправо и возвращалась влево, огибая узел петлёй — читалось
   * как ошибка. Направление выбираем по тому, что больше: разбег по вертикали или по горизонтали.
   * Возвращаем и точку подписи: у вертикального ребра она сбоку от середины, а не над ней.
   */
  const edgeGeom = (a: GraphNodeView, b: GraphNodeView): { d: string; lx: number; ly: number } => {
    const cxA = a.x + a.w / 2, cyA = a.y + a.h / 2, cxB = b.x + b.w / 2, cyB = b.y + b.h / 2;
    if (Math.abs(cyB - cyA) > Math.abs(cxB - cxA) * 1.2) {
      const up = cyB < cyA;
      const y1 = up ? a.y : a.y + a.h, y2 = up ? b.y + b.h : b.y;
      const k = Math.max(24, Math.abs(y2 - y1) * 0.5) * (up ? -1 : 1);
      return { d: `M${cxA} ${y1} C${cxA} ${y1 + k} ${cxB} ${y2 - k} ${cxB} ${y2}`, lx: (cxA + cxB) / 2 + 30, ly: (y1 + y2) / 2 + 3 };
    }
    const x1 = a.x + a.w, y1 = cyA, x2 = b.x, y2 = cyB;
    const dx = Math.max(30, Math.abs(x2 - x1) * 0.5);
    return { d: `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 - 4 };
  };

  const draw = (ns: GraphNodeView[], es: GraphEdgeView[]): void => {
    nodes = ns; edges = es;
    gEdges.replaceChildren(); gNodes.replaceChildren(); layers.clear();
    const by = new Map(ns.map((n) => [n.id, n]));
    for (const e of es) {
      const a = by.get(e.from), b = by.get(e.to);
      if (!a || !b) continue;
      const geom = edgeGeom(a, b);
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', geom.d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', e.color ?? '#4a5680');
      p.setAttribute('stroke-width', '1.5');
      if (e.dashed) p.setAttribute('stroke-dasharray', '4 4');
      gEdges.append(p);
      if (e.label) {
        const t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('x', String(geom.lx));
        t.setAttribute('y', String(geom.ly));
        t.setAttribute('fill', e.color ?? '#6b7180');
        t.setAttribute('font-size', '9');
        t.setAttribute('font-family', 'monospace');
        t.setAttribute('text-anchor', 'middle');
        t.textContent = e.label;
        gEdges.append(t);
      }
    }
    const sel = opts.selected?.() ?? null;
    for (const n of ns) {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('transform', `translate(${n.x} ${n.y})`);
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('width', String(n.w)); r.setAttribute('height', String(n.h)); r.setAttribute('rx', '6');
      r.setAttribute('fill', '#1b2030');
      r.setAttribute('stroke', n.id === sel ? '#ffd24a' : '#39415a');
      r.setAttribute('stroke-width', n.id === sel ? '2' : '1');
      g.append(r);
      const layer = document.createElementNS(SVGNS, 'g');
      g.append(layer); layers.set(n.id, layer);
      g.style.cursor = 'move';
      g.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        const s0 = toLocal(ev.clientX, ev.clientY), ox = s0.x - n.x, oy = s0.y - n.y;
        let moved = false;
        const mv = (e2: PointerEvent): void => {
          const q = toLocal(e2.clientX, e2.clientY);
          const nx = Math.round(q.x - ox), ny = Math.round(q.y - oy);
          if (!moved && Math.hypot(nx - n.x, ny - n.y) < 3) return;   // порог: клик это не перетаскивание
          moved = true; n.x = nx; n.y = ny;
          draw(nodes, edges);
        };
        const up = (): void => {
          window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
          if (moved) { opts.onMove?.(n.id, n.x, n.y); clicks.reset(); return; }
          if (clicks.hit(n.id, performance.now()) === 'enter') opts.onEnter?.(n.id);
          else opts.onSelect?.(n.id);
        };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
      });
      g.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); opts.onContext?.(n.id, ev.clientX, ev.clientY); });
      gNodes.append(g);
    }
    apply();
  };

  svg.addEventListener('pointerdown', (ev) => {
    const sx = ev.clientX, sy = ev.clientY, p0 = { ...pan };
    let moved = false;
    svg.style.cursor = 'grabbing';
    const mv = (e2: PointerEvent): void => {
      pan = { x: p0.x + (e2.clientX - sx), y: p0.y + (e2.clientY - sy) };
      if (Math.hypot(e2.clientX - sx, e2.clientY - sy) > 3) moved = true;
      apply();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      svg.style.cursor = 'grab';
      if (!moved) opts.onSelect?.(null);
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  svg.addEventListener('contextmenu', (ev) => { ev.preventDefault(); opts.onContext?.(null, ev.clientX, ev.clientY); });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const k = Math.exp(-ev.deltaY * 0.0015), nz = Math.min(3, Math.max(0.2, zoom * k));
    pan = { x: mx - (mx - pan.x) * (nz / zoom), y: my - (my - pan.y) * (nz / zoom) };
    zoom = nz; apply();
  }, { passive: false });

  const fit = (): void => {
    if (!nodes.length) { pan = { x: 20, y: 20 }; zoom = 1; apply(); return; }
    const r = svg.getBoundingClientRect(), w = r.width || 600, h = r.height || 400;
    const x0 = Math.min(...nodes.map((n) => n.x)), x1 = Math.max(...nodes.map((n) => n.x + n.w));
    const y0 = Math.min(...nodes.map((n) => n.y)), y1 = Math.max(...nodes.map((n) => n.y + n.h));
    zoom = Math.min(2, Math.max(0.2, Math.min((w - 40) / Math.max(1, x1 - x0), (h - 40) / Math.max(1, y1 - y0))));
    // ЦЕНТРИРУЕМ по той оси, где контент уже влез: узкий столбик, прижатый к левому краю огромного
    // поля, выглядит как обрезанный граф — человек начинает искать, что он не видит.
    const cw = (x1 - x0) * zoom, ch = (y1 - y0) * zoom;
    pan = { x: Math.max(20, (w - cw) / 2) - x0 * zoom, y: Math.max(20, (h - ch) / 2) - y0 * zoom };
    apply();
  };

  return { draw, fit, layerFor: (id) => layers.get(id) ?? null, el: svg };
}
