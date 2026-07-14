/**
 * Граф-редактор пассивного дерева (skills-passive) — визуальный, как в игре, вместо
 * плоского списка. Умеет: пан/зум, драг узлов (x/y), ПКМ по пустому → создать узел
 * (малый/крупный), клик по узлу → правка (что даёт / цена / ступени), ПКМ по узлу →
 * удалить / добавить связь, ПКМ по ребру → удалить связь. Мутирует объект конфига
 * НА МЕСТЕ (data['skills-passive']) — тулбар «Применить» валидирует и шлёт как обычно.
 *
 * Свой рендер (не дёргает глобальный render редактора), чтобы пан/зум/выделение жили
 * между правками. Пере-инициализируется на каждый заход на страницу.
 */

const SVGNS = 'http://www.w3.org/2000/svg';

interface Mod { stat: string; kind: 'flat' | 'increased'; value: number }
interface PNode {
  id: string; name: string; description: string;
  cost: { type: 'points' | 'gold'; amount: number };
  requires: string[]; maxRank: number; levelReq: number;
  effect: { modifiers?: Mod[] };
  x: number; y: number; kind: 'passive'; notable: boolean;
}
interface PTree { entryNodes: string[]; edges: [string, string][]; nodes: PNode[] }

/**
 * Палитра статов для узлов v2 — ТОЛЬКО проценты (без плоских атрибутов). У каждого стата
 * фиксирован `kind`: множители-доли с базой 0 (урон/статусы/резисты) складываются как `flat`,
 * а масштабирующие базовое значение (скорости/крит/пулы/реген) — как `increased`. И то и другое
 * показывается и вводится в ПРОЦЕНТАХ (value — доля: 5% → 0.05), моды множатся на ранг узла.
 */
const STAT_GROUPS: { group: string; stats: { stat: string; label: string; kind: 'flat' | 'increased' }[] }[] = [
  {
    group: 'Урон',
    stats: [
      { stat: 'damagePct', label: 'Ко всему урону', kind: 'flat' },
      { stat: 'physPct', label: 'К физ. урону', kind: 'flat' },
      { stat: 'firePct', label: 'К урону огнём', kind: 'flat' },
      { stat: 'coldPct', label: 'К урону холодом', kind: 'flat' },
      { stat: 'lightningPct', label: 'К урону молнией', kind: 'flat' },
      { stat: 'poisonPct', label: 'К урону ядом', kind: 'flat' },
      { stat: 'ailmentPct', label: 'К наложению статусов', kind: 'flat' },
    ],
  },
  {
    group: 'Скорость / крит',
    stats: [
      { stat: 'attackSpeed', label: 'Скор. атаки', kind: 'increased' },
      { stat: 'castSpeed', label: 'Скор. каста', kind: 'increased' },
      { stat: 'critChance', label: 'Шанс крита', kind: 'increased' },
      { stat: 'critMultiplier', label: 'Множ. крита', kind: 'increased' },
      { stat: 'moveSpeed', label: 'Скор. движения', kind: 'increased' },
      { stat: 'accuracy', label: 'Меткость', kind: 'increased' },
    ],
  },
  {
    group: 'Защита',
    stats: [
      { stat: 'armor', label: 'Броня', kind: 'increased' },
      { stat: 'evade', label: 'Уклонение', kind: 'increased' },
      { stat: 'blockChance', label: 'Блок', kind: 'increased' },
      { stat: 'interruptResist', label: 'Стойк. к прерыв.', kind: 'flat' },
      { stat: 'resFire', label: 'Сопр. огню', kind: 'flat' },
      { stat: 'resCold', label: 'Сопр. холоду', kind: 'flat' },
      { stat: 'resLightning', label: 'Сопр. молнии', kind: 'flat' },
      { stat: 'resPoison', label: 'Сопр. яду', kind: 'flat' },
    ],
  },
  {
    group: 'Здоровье / мана',
    stats: [
      { stat: 'maxHp', label: 'Здоровье', kind: 'increased' },
      { stat: 'maxMana', label: 'Мана', kind: 'increased' },
      { stat: 'hpRegen', label: 'Реген HP', kind: 'increased' },
      { stat: 'manaRegen', label: 'Реген маны', kind: 'increased' },
    ],
  },
];
const STAT_KIND: Record<string, 'flat' | 'increased'> = {};
const STAT_LABEL: Record<string, string> = {};
for (const g of STAT_GROUPS) for (const s of g.stats) { STAT_KIND[s.stat] = s.kind; STAT_LABEL[s.stat] = s.label; }

// ── Состояние вида (переживает локальные перерисовки) ──────────────────────────
let pan = { x: 0, y: 0 };
let zoom = 0;               // 0 = ещё не вписывали в экран
let inited = false;        // первичный «вписать» уже сделан (потом пан/зум сохраняются)
let selected: string | null = null;
let linkFrom: string | null = null;   // режим «добавить связь»: узел-источник

export function renderPassiveGraph(page: HTMLElement, data: Record<string, unknown>): void {
  const tree = data['skills-passive'] as PTree;
  if (!tree.edges) tree.edges = [];
  if (selected && !tree.nodes.some((n) => n.id === selected)) selected = null;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:12px;align-items:stretch;height:calc(100vh - 150px);min-height:460px';

  // Левая часть: холст графа.
  const host = document.createElement('div');
  host.style.cssText = 'flex:1;min-width:0;position:relative;background:#0e0e15;border:1px solid #2c2c3a;border-radius:8px;overflow:hidden';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.cssText = 'display:block;cursor:grab;touch-action:none';
  // Фон-подложка (в экранных координатах, вне vp) — надёжно ловит пан и ПКМ по пустому месту.
  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%');
  bg.setAttribute('fill', '#0e0e15');
  const vp = document.createElementNS(SVGNS, 'g');
  svg.append(bg, vp);
  host.appendChild(svg);

  const fitBtn = document.createElement('button');
  fitBtn.textContent = '⤢ Вписать';
  fitBtn.style.cssText = 'position:absolute;right:8px;top:8px;z-index:2;padding:5px 10px;cursor:pointer;background:#2c2c3a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:6px;font-size:12px';
  host.appendChild(fitBtn);

  const help = document.createElement('div');
  help.style.cssText = 'position:absolute;left:8px;bottom:6px;font-size:11px;color:#6a6f80;pointer-events:none;line-height:1.5';
  host.appendChild(help);

  // Правая часть: инспектор узла.
  const insp = document.createElement('div');
  insp.style.cssText = 'flex:0 0 300px;overflow-y:auto;background:#14141c;border:1px solid #2c2c3a;border-radius:8px;padding:10px';

  wrap.append(host, insp);
  page.appendChild(wrap);

  // ── Геометрия / трансформация ────────────────────────────────────────────────
  const node = (id: string): PNode | undefined => tree.nodes.find((n) => n.id === id);
  const neighbors = (id: string): string[] => {
    const out: string[] = [];
    for (const [a, b] of tree.edges) { if (a === id) out.push(b); else if (b === id) out.push(a); }
    return out;
  };
  const applyTransform = (): void => { vp.setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${zoom})`); };
  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = svg.getBoundingClientRect();
    return { x: (clientX - r.left - pan.x) / zoom, y: (clientY - r.top - pan.y) / zoom };
  };
  const fit = (): void => {
    const r = svg.getBoundingClientRect();
    const w = r.width || 800, h = r.height || 500;
    if (!tree.nodes.length) { zoom = 1; pan = { x: w / 2, y: h / 2 }; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of tree.nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
    const cw = Math.max(1, maxX - minX), ch = Math.max(1, maxY - minY);
    zoom = Math.min(3, Math.max(0.15, Math.min((w - 80) / cw, (h - 80) / ch)));
    pan = { x: w / 2 - ((minX + maxX) / 2) * zoom, y: h / 2 - ((minY + maxY) / 2) * zoom };
  };

  // ── Отрисовка ────────────────────────────────────────────────────────────────
  const nodeEls = new Map<string, { c: SVGCircleElement; t: SVGTextElement | null }>();
  interface EdgeEl { el: SVGLineElement; a: string; b: string }
  let edgeEls: EdgeEl[] = [];

  const isEntry = (id: string): boolean => tree.entryNodes.includes(id);
  const nodeRadius = (n: PNode): number => (isEntry(n.id) ? 13 : n.notable ? 10 : 6.5);
  const nodeFill = (n: PNode): string => (isEntry(n.id) ? '#c9a24a' : n.notable ? '#6a5330' : '#2b3550');
  const nodeStroke = (n: PNode): string => {
    if (n.id === linkFrom) return '#39d0d0';
    if (n.id === selected) return '#7fd67f';
    return isEntry(n.id) ? '#f0d590' : n.notable ? '#c9a24a' : '#4a597a';
  };

  function draw(): void {
    while (vp.firstChild) vp.removeChild(vp.firstChild);
    nodeEls.clear();
    edgeEls = [];
    if (!zoom) zoom = 1;
    applyTransform();

    const gEdges = document.createElementNS(SVGNS, 'g');
    const gNodes = document.createElementNS(SVGNS, 'g');
    vp.append(gEdges, gNodes);

    for (const [a, b] of tree.edges) {
      const na = node(a), nb = node(b);
      if (!na || !nb) continue;
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('x1', String(na.x)); line.setAttribute('y1', String(na.y));
      line.setAttribute('x2', String(nb.x)); line.setAttribute('y2', String(nb.y));
      line.setAttribute('stroke', '#3c4a68');
      line.setAttribute('stroke-width', '2');
      line.style.cursor = 'context-menu';
      line.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        showMenu(e.clientX, e.clientY, [{ label: '✕ Удалить связь', fn: () => { removeEdge(a, b); } }]);
      });
      gEdges.appendChild(line);
      edgeEls.push({ el: line, a, b });
    }

    for (const n of tree.nodes) {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', String(n.x)); c.setAttribute('cy', String(n.y));
      c.setAttribute('r', String(nodeRadius(n)));
      c.setAttribute('fill', nodeFill(n));
      c.setAttribute('stroke', nodeStroke(n));
      c.setAttribute('stroke-width', n.id === selected || n.id === linkFrom ? '3' : '1.5');
      c.style.cursor = 'pointer';
      const title = document.createElementNS(SVGNS, 'title');
      title.textContent = `${n.name} · ${modSummary(n)}`;
      c.appendChild(title);
      c.addEventListener('pointerdown', (e) => startNodeDrag(e, n));
      c.addEventListener('contextmenu', (e) => onNodeContext(e, n));
      gNodes.appendChild(c);

      let t: SVGTextElement | null = null;
      if (isEntry(n.id) || n.notable || n.id === selected) {
        t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('x', String(n.x));
        t.setAttribute('y', String(n.y - nodeRadius(n) - 4));
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('font-size', String(isEntry(n.id) ? 15 : 11));
        t.setAttribute('fill', isEntry(n.id) ? '#f0d590' : '#c9cdd8');
        t.style.pointerEvents = 'none';
        t.textContent = n.name;
        gNodes.appendChild(t);
      }
      nodeEls.set(n.id, { c, t });
    }
    help.innerHTML = `узлов: ${tree.nodes.length} · рёбер: ${tree.edges.length}<br>ПКМ по пустому — создать · ПКМ по узлу — меню · колесо — зум · тащить фон — панорама`;
  }

  /** Точечно обновить позицию узла и инцидентных рёбер (во время драга — без полного draw). */
  function refreshNode(id: string): void {
    const n = node(id); const els = nodeEls.get(id);
    if (!n || !els) return;
    els.c.setAttribute('cx', String(n.x)); els.c.setAttribute('cy', String(n.y));
    if (els.t) { els.t.setAttribute('x', String(n.x)); els.t.setAttribute('y', String(n.y - nodeRadius(n) - 4)); }
    for (const e of edgeEls) {
      if (e.a === id) { e.el.setAttribute('x1', String(n.x)); e.el.setAttribute('y1', String(n.y)); }
      if (e.b === id) { e.el.setAttribute('x2', String(n.x)); e.el.setAttribute('y2', String(n.y)); }
    }
  }

  // ── Драг узла vs выбор ────────────────────────────────────────────────────────
  function startNodeDrag(e: PointerEvent, n: PNode): void {
    if (e.button !== 0) return;                 // ЛКМ только
    e.preventDefault(); e.stopPropagation();
    closeMenu();
    // Режим связи: клик по второму узлу — создаём ребро.
    if (linkFrom && linkFrom !== n.id) { addEdge(linkFrom, n.id); linkFrom = null; draw(); return; }
    const start = { x: e.clientX, y: e.clientY };
    const orig = { x: n.x, y: n.y };
    let moved = false;
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - start.x) / zoom, dy = (ev.clientY - start.y) / zoom;
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3) moved = true;
      if (moved) { n.x = Math.round(orig.x + dx); n.y = Math.round(orig.y + dy); refreshNode(n.id); }
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) selectNode(n.id);
      else if (selected === n.id) renderInspector();  // синхронизировать поля x/y в инспекторе
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onNodeContext(e: MouseEvent, n: PNode): void {
    e.preventDefault(); e.stopPropagation();
    selectNode(n.id);
    showMenu(e.clientX, e.clientY, [
      { label: linkFrom === n.id ? '✓ Отменить связь' : '➜ Добавить связь…', fn: () => { linkFrom = linkFrom === n.id ? null : n.id; draw(); } },
      { label: isEntry(n.id) ? '★ Убрать точку входа' : '☆ Сделать точкой входа', fn: () => { toggleEntry(n.id); } },
      { label: n.notable ? '● Сделать малым' : '◆ Сделать крупным', fn: () => { n.notable = !n.notable; draw(); renderInspector(); } },
      { label: '✕ Удалить узел', fn: () => { deleteNode(n.id); } },
    ]);
  }

  // ── Пан / зум / ПКМ по пустому (на фон-подложке) ─────────────────────────────
  bg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    closeMenu();
    if (linkFrom) { linkFrom = null; draw(); }
    const start = { x: e.clientX, y: e.clientY };
    const orig = { ...pan };
    svg.style.cursor = 'grabbing';
    const move = (ev: PointerEvent): void => { pan = { x: orig.x + (ev.clientX - start.x), y: orig.y + (ev.clientY - start.y) }; applyTransform(); };
    const up = (): void => { svg.style.cursor = 'grab'; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nz = Math.min(4, Math.max(0.1, zoom * factor));
    pan = { x: mx - (mx - pan.x) * (nz / zoom), y: my - (my - pan.y) * (nz / zoom) };
    zoom = nz; applyTransform();
  }, { passive: false });
  bg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    showMenu(e.clientX, e.clientY, [
      { label: '● Создать малый узел', fn: () => createNode(w.x, w.y, false) },
      { label: '◆ Создать крупный узел', fn: () => createNode(w.x, w.y, true) },
    ]);
  });
  fitBtn.addEventListener('click', () => { fit(); applyTransform(); });

  // ── Мутации структуры ─────────────────────────────────────────────────────────
  function freshId(prefix: string): string {
    let i = 1; while (tree.nodes.some((n) => n.id === `${prefix}${i}`)) i += 1;
    return `${prefix}${i}`;
  }
  function createNode(x: number, y: number, notable: boolean): void {
    const id = freshId('n-');
    const n: PNode = {
      id, kind: 'passive', notable,
      name: notable ? 'Новый нотабль' : 'Новый узел',
      description: '',
      cost: { type: 'gold', amount: notable ? 600 : 100 },
      requires: [], maxRank: notable ? 1 : 3, levelReq: 1,
      effect: { modifiers: [{ stat: notable ? 'physPct' : 'physPct', kind: 'flat', value: notable ? 0.08 : 0.03 }] },
      x: Math.round(x), y: Math.round(y),
    };
    tree.nodes.push(n);
    selected = id;
    draw(); renderInspector();
  }
  function deleteNode(id: string): void {
    tree.nodes = tree.nodes.filter((n) => n.id !== id);
    tree.edges = tree.edges.filter(([a, b]) => a !== id && b !== id);
    tree.entryNodes = tree.entryNodes.filter((e) => e !== id);
    if (selected === id) selected = null;
    if (linkFrom === id) linkFrom = null;
    draw(); renderInspector();
  }
  function addEdge(a: string, b: string): void {
    if (a === b) return;
    if (tree.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) return;
    tree.edges.push([a, b]);
  }
  function removeEdge(a: string, b: string): void {
    tree.edges = tree.edges.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)));
    closeMenu(); draw(); renderInspector();
  }
  function toggleEntry(id: string): void {
    if (isEntry(id)) tree.entryNodes = tree.entryNodes.filter((e) => e !== id);
    else tree.entryNodes.push(id);
    draw(); renderInspector();
  }

  // ── Инспектор ──────────────────────────────────────────────────────────────────
  function selectNode(id: string): void {
    selected = id;
    // Обновить обводки без полной перерисовки.
    for (const [nid, els] of nodeEls) {
      const n = node(nid); if (!n) continue;
      els.c.setAttribute('stroke', nodeStroke(n));
      els.c.setAttribute('stroke-width', nid === selected || nid === linkFrom ? '3' : '1.5');
    }
    draw();          // чтобы у выбранного появилась подпись
    renderInspector();
  }

  function renderInspector(): void {
    insp.innerHTML = '';
    if (!selected) { insp.innerHTML = '<div style="color:#6a6f80;font-size:13px">Выберите узел (клик) или создайте: ПКМ по пустому месту холста.</div>'; return; }
    const n = node(selected);
    if (!n) { selected = null; renderInspector(); return; }

    insp.appendChild(hdr(`Узел ${n.id}`));
    insp.appendChild(field('Имя', textInput(n.name, (v) => { n.name = v; const els = nodeEls.get(n.id); if (els?.t) els.t.textContent = v; })));
    insp.appendChild(field('Тип', selectInput([['false', 'малый'], ['true', 'крупный']], String(n.notable), (v) => { n.notable = v === 'true'; draw(); })));
    insp.appendChild(checkRow('Точка входа (старт ветки)', isEntry(n.id), () => toggleEntry(n.id)));
    insp.appendChild(field('Описание', textInput(n.description, (v) => { n.description = v; })));

    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px';
    row.append(
      field('Цена (золото/ранг)', numInput(n.cost.amount, 1, (v) => { n.cost.type = 'gold'; n.cost.amount = Math.max(0, Math.round(v)); })),
      field('Ступеней (ранг)', numInput(n.maxRank, 1, (v) => { n.maxRank = Math.max(1, Math.round(v)); })),
    );
    insp.appendChild(row);
    insp.appendChild(field('Треб. уровень', numInput(n.levelReq, 1, (v) => { n.levelReq = Math.max(1, Math.round(v)); })));

    // Модификаторы.
    insp.appendChild(hdr('Даёт (за ранг)'));
    n.effect.modifiers ??= [];
    const modBox = document.createElement('div');
    n.effect.modifiers.forEach((m, i) => modBox.appendChild(modRow(n, m, i)));
    insp.appendChild(modBox);
    const addMod = smallBtn('+ модификатор', () => {
      n.effect.modifiers!.push({ stat: 'physPct', kind: 'flat', value: 0.03 });
      renderInspector();
    });
    insp.appendChild(addMod);

    // Связи.
    insp.appendChild(hdr(`Связи (${neighbors(n.id).length})`));
    const links = document.createElement('div');
    for (const nb of neighbors(n.id)) {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#c9cdd8;padding:2px 0';
      const nm = node(nb);
      r.append(txt(`${nm?.name ?? nb} · ${nb}`), smallBtn('✕', () => removeEdge(n.id, nb), '#4a2a2a'));
      links.appendChild(r);
    }
    if (!neighbors(n.id).length) links.appendChild(txt('нет — ПКМ по узлу → «Добавить связь»', '#6a6f80'));
    insp.appendChild(links);

    const del = smallBtn('✕ Удалить узел', () => deleteNode(n.id), '#4a2a2a');
    del.style.marginTop = '12px'; del.style.width = '100%';
    insp.appendChild(del);
  }

  function modRow(n: PNode, m: Mod, i: number): HTMLElement {
    const r = document.createElement('div');
    r.style.cssText = 'display:grid;grid-template-columns:1fr 62px 22px;gap:6px;align-items:center;margin-bottom:5px';
    // Выпадашка стата (с optgroup), авто-kind по стату.
    const sel = document.createElement('select');
    sel.style.cssText = inputCss;
    for (const g of STAT_GROUPS) {
      const og = document.createElement('optgroup'); og.label = g.group;
      for (const s of g.stats) {
        const o = document.createElement('option'); o.value = s.stat; o.textContent = s.label;
        if (s.stat === m.stat) o.selected = true;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.addEventListener('change', () => { m.stat = sel.value; m.kind = STAT_KIND[sel.value] ?? 'flat'; });
    // Значение в процентах (доля × 100).
    const val = document.createElement('input');
    val.type = 'number'; val.step = '0.5'; val.value = String(Math.round(m.value * 1000) / 10);
    val.style.cssText = inputCss;
    val.title = 'в процентах (× ранг)';
    val.addEventListener('input', () => { m.value = (parseFloat(val.value) || 0) / 100; });
    const rm = smallBtn('✕', () => { n.effect.modifiers!.splice(i, 1); renderInspector(); }, '#4a2a2a');
    r.append(sel, val, rm);
    return r;
  }

  draw();
  renderInspector();
  // Первый показ: вписать граф в экран после того, как элемент попал в DOM (получил размеры).
  if (!inited) requestAnimationFrame(() => { fit(); applyTransform(); inited = true; });
}

// ── Мелкие DOM-хелперы ──────────────────────────────────────────────────────────
const inputCss = 'width:100%;box-sizing:border-box;padding:5px 6px;background:#1c1c26;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:5px;font-size:12px';

function modSummary(n: PNode): string {
  return (n.effect.modifiers ?? []).map((m) => `${STAT_LABEL[m.stat] ?? m.stat} +${Math.round(m.value * 1000) / 10}%`).join(', ') || '—';
}
function hdr(text: string): HTMLElement {
  const h = document.createElement('div');
  h.textContent = text;
  h.style.cssText = 'font-weight:600;color:#e8e8f0;font-size:13px;margin:12px 0 6px;border-bottom:1px solid #2c2c3a;padding-bottom:3px';
  return h;
}
function field(label: string, input: HTMLElement): HTMLElement {
  const box = document.createElement('label');
  box.style.cssText = 'display:block;font-size:11px;color:#9aa0b0;margin:6px 0';
  const l = document.createElement('div'); l.textContent = label; l.style.marginBottom = '3px';
  box.append(l, input);
  return box;
}
function textInput(value: string, onInput: (v: string) => void): HTMLInputElement {
  const el = document.createElement('input'); el.type = 'text'; el.value = value; el.style.cssText = inputCss;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}
function numInput(value: number, step: number, onInput: (v: number) => void): HTMLInputElement {
  const el = document.createElement('input'); el.type = 'number'; el.step = String(step); el.value = String(value); el.style.cssText = inputCss;
  el.addEventListener('input', () => onInput(parseFloat(el.value) || 0));
  return el;
}
function selectInput(opts: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = document.createElement('select'); el.style.cssText = inputCss;
  for (const [v, label] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = label; if (v === value) o.selected = true; el.appendChild(o); }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}
function checkRow(label: string, checked: boolean, onToggle: () => void): HTMLElement {
  const box = document.createElement('label');
  box.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#c9cdd8;margin:8px 0;cursor:pointer';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked;
  cb.addEventListener('change', onToggle);
  box.append(cb, txt(label));
  return box;
}
function txt(s: string, color = '#c9cdd8'): HTMLElement {
  const el = document.createElement('span'); el.textContent = s; el.style.color = color; el.style.fontSize = '12px';
  return el;
}
function smallBtn(text: string, onClick: () => void, bg = '#2c2c3a'): HTMLButtonElement {
  const b = document.createElement('button'); b.textContent = text;
  b.style.cssText = `padding:4px 8px;cursor:pointer;background:${bg};color:#e8e8f0;border:1px solid #3c3c4a;border-radius:5px;font-size:12px`;
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return b;
}

// ── Контекстное меню ────────────────────────────────────────────────────────────
let menuEl: HTMLElement | null = null;
function closeMenu(): void { if (menuEl) { menuEl.remove(); menuEl = null; } }
function showMenu(clientX: number, clientY: number, items: { label: string; fn: () => void }[]): void {
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
  // Закрытие по клику вне меню.
  setTimeout(() => {
    const off = (e: MouseEvent): void => { if (menuEl && !menuEl.contains(e.target as Node)) { closeMenu(); window.removeEventListener('pointerdown', off, true); } };
    window.addEventListener('pointerdown', off, true);
  }, 0);
}
