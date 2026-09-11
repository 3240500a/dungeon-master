/**
 * ГРАФ АНИМАЦИЙ (Ф1.3b) — узловой редактор контроллера, по образцу окна Animator в Unity.
 *
 * ТРИ ВЕЩИ, КОТОРЫЕ ВЗЯТЫ ИМЕННО ОТТУДА, и каждая решает конкретную жалобу:
 *  • БОЛЬШОЕ ПОЛЕ. Граф живёт не в колонке настроек, а во всю площадь вьюпорта: в узком окне узлы
 *    не читаются, и любое их количество превращается в кашу.
 *  • ЗАХОД ВНУТРЬ, А НЕ НОВОЕ ОКНО. Двойной клик по слою открывает его содержимое В ТОМ ЖЕ поле, а
 *    путь показан хлебными крошками — ровно как подмашины состояний в Animator.
 *  • ИНСПЕКТОР СБОКУ. Выбранный узел настраивается в правой панели, а не в модалке поверх графа.
 *
 * КОРЕНЬ — НЕ КУЧА УЗЛОВ, А СТЕК СЛОЁВ. Он и есть контракт системы («нижний слой не знает о верхних»),
 * поэтому показывается первым: локомоция → поза верха → главная рука → вторая рука → действие.
 *
 * ЧТО ОЗНАЧАЮТ РЁБРА внутри слоя действия. Их два вида, и путать нельзя:
 *  • СПЛОШНЫЕ — авторские цепочки (`next`): «после этого удара может пойти вот этот». Это комбо.
 *  • ПУНКТИР — ВЫВОДИМЫЕ рёбра «кто кого перебивает». Их никто не рисует руками: они следуют из
 *    приоритетов и прерываемости, и показаны ровно затем, чтобы ошибка в приоритетах была ВИДНА,
 *    а не выяснялась в бою.
 */
import { graphCanvas, type GraphCanvas, type GraphEdgeView, type GraphNodeView } from '../ui/graphKit.js';
import { readAnimCfg, type AnimItem, type AnimState, type AnimStore } from './animConfig.js';
import { levelEdges, levelNodes, graphStates, LAYER_DEFS, LEVEL_TITLE, type GraphNode, type LevelId } from './animGraphModel.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const NODE_W = 196, NODE_H = 54;   // подпись слоя и имя клипа должны влезать ЦЕЛИКОМ: обрезка врёт про привязку
/** Цвет ребра по виду: авторская цепочка зелёная, выводимое «перебьёт» — тревожное, служебное — тусклое. */
const EDGE_COLOR = { 'from-base': '#3d4762', chain: '#46d07a', interrupt: '#c07050' } as const;

export interface AnimGraphHost {
  /** Кого правим. */
  charId(): string;
  /** Живой конфиг (тот же объект, что читает рантайм) + сохранение. */
  store(): AnimStore;
  save(): void;
  /** Имена всех клипов персонажа — для выпадашки привязки. */
  clipNames(): string[];
  /** Проиграть состояние на кукле прямо сейчас (кнопка-триггер). */
  trigger(state: string): void;
  /** Идёт ли сейчас действие — для подсветки активного узла. */
  active(): boolean;
}

interface Ui {
  el(tag: string, css?: string, text?: string): HTMLElement;
  btn(label: string, fn: () => void, on?: boolean): HTMLButtonElement;
}

/** Позиции узлов живут в конфиге рядом с состояниями — раскладка это тоже авторская работа. */
interface Layout { [id: string]: { x: number; y: number } }

export interface AnimGraphPanel {
  /** БОЛЬШОЕ ПОЛЕ: крошки + холст. Занимает всю площадь, которую ему дали. */
  renderField(host: HTMLElement): void;
  /** ИНСПЕКТОР выбранного узла — в правую панель, как Inspector рядом с окном Animator. */
  renderInspector(box: HTMLElement): void;
  /** Текущий уровень (для заголовка вкладки). */
  level(): LevelId;
}

export function createAnimGraphPanel(host: AnimGraphHost, ui: Ui): AnimGraphPanel {
  let selected: string | null = null;
  let canvas: GraphCanvas | null = null;
  /** Путь по уровням: пусто — корень (стек слоёв). Заходим двойным кликом, выходим крошкой. */
  let path: LevelId[] = [];
  const cur = (): LevelId => path[path.length - 1] ?? '';

  const graph = (): { states: Record<string, string | AnimState>; items: Record<string, AnimItem>; layout: Layout } => {
    const g = (host.store()[host.charId()] ??= {});
    g.states ??= {};
    g.items ??= {};
    g.layout ??= {};
    return { states: g.states, items: g.items, layout: g.layout };
  };
  /** Запись состояния в полной форме — короткую (строку-имя) разворачиваем при первой же правке. */
  const stateObj = (id: string): AnimState => {
    const { states } = graph();
    const raw = states[id];
    if (typeof raw === 'string') states[id] = { clip: raw };
    else if (!raw || typeof raw !== 'object') states[id] = {};
    return states[id] as AnimState;
  };
  const allStates = (): string[] => graphStates(host.store(), host.charId());

  /**
   * Ключ раскладки. У слоя действия он ГОЛЫЙ — там уже лежат сохранённые позиции, и менять ключ
   * значило бы разбросать чужой граф. Остальные уровни живут под своим префиксом.
   */
  const layKey = (id: string): string => (cur() === 'action' ? id : `${cur()}/${id}`);
  /** Раскладка по умолчанию: колонкой, чтобы граф не начинался с кучи в углу. */
  const posOf = (id: string, i: number): { x: number; y: number } => {
    const { layout } = graph();
    const saved = layout[layKey(id)];
    if (saved) return saved;
    // Стек слоёв рисуем СНИЗУ ВВЕРХ, как он и наложен: локомоция внизу, действие сверху.
    if (cur() === '') return { x: 60, y: 30 + (LAYER_DEFS.length - 1 - i) * 96 };
    // Служебные узлы — своей колонкой слева, состояния — сеткой справа. Шаг сетки считается ОТ РАЗМЕРА
    // УЗЛА: с фиксированным шагом узлы налезали друг на друга и прятали ребро между собой.
    if (cur() === 'action') {
      if (id.startsWith('#')) return { x: 20, y: 30 + i * (NODE_H + 24) };
      const k = i - 2;
      return { x: NODE_W + 90 + (k % 2) * (NODE_W + 70), y: 30 + Math.floor(k / 2) * (NODE_H + 34) };
    }
    return i === 0 ? { x: 30, y: 40 } : { x: NODE_W + 110, y: 30 + (i - 1) * (NODE_H + 26) };   // база слева, содержимое справа
  };

  const model = (): GraphNode[] => levelNodes(host.store(), host.charId(), host.clipNames(), cur());

  const buildNodes = (): GraphNodeView[] => model().map((n, i) => {
    const p = posOf(n.id, i);
    return { id: n.id, x: p.x, y: p.y, w: NODE_W, h: NODE_H };
  });

  const buildEdges = (): GraphEdgeView[] => levelEdges(host.store(), host.charId(), cur()).map((e) => ({
    from: e.from, to: e.to, color: EDGE_COLOR[e.kind],
    dashed: e.kind === 'interrupt',
    label: cur() === '' ? 'поверх' : e.kind === 'chain' ? 'цепочка' : e.kind === 'interrupt' ? 'перебьёт' : undefined,
  }));

  const label = (n: GraphNode): string => {
    if (cur() === '') return LAYER_DEFS.find((l) => '#' + l.id === n.id)?.title ?? n.id;
    if (n.id === '#relax') return 'idle_relax';
    if (n.id === '#incombat') return 'idle_incombat';
    if (n.id === '#base') return 'БЕЗ ОРУЖИЯ';
    if (n.id === '#stance') return 'СТОЙКА';
    if (n.id === '#loco') return cur() === 'loco' ? 'ПЛАНИРОВЩИК' : 'ЛОКОМОЦИЯ';
    return n.id;
  };

  const text = (g: SVGGElement, x: number, y: number, fill: string, size: number, s: string): void => {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', String(x)); t.setAttribute('y', String(y)); t.setAttribute('fill', fill);
    t.setAttribute('font-size', String(size)); t.setAttribute('font-family', 'monospace');
    t.textContent = s;
    g.append(t);
  };

  const paint = (): void => {
    if (!canvas) return;
    const nodes = buildNodes();
    canvas.draw(nodes, buildEdges());
    const info = new Map(model().map((m) => [m.id, m]));
    for (const n of nodes) {
      const g = canvas.layerFor(n.id); if (!g) continue;
      const c = info.get(n.id); if (!c) continue;
      text(g, 8, 18, c.enter ? '#8fb7ff' : '#cfd3e0', 11, label(c).slice(0, 24));
      if (c.clip) text(g, 8, 33, c.missing ? '#c05050' : '#9ae6a0', 9, (c.missing ? '✗ ' : '') + c.clip.slice(0, 29));
      const second = c.sub ?? `prio ${c.priority}${c.interruptible ? '' : ' · замок'} · ноги ${c.legs}`;
      text(g, 8, c.clip ? 46 : 33, '#7a869e', 9, second.slice(0, 32));
      if (c.enter) text(g, NODE_W - 14, 18, '#8fb7ff', 12, '›');
    }
  };

  /** Хлебные крошки: клик по любой — выйти на тот уровень. Это и есть «не новое окно, а заход внутрь». */
  const crumbs = (bar: HTMLElement): void => {
    const { el, btn } = ui;
    bar.append(btn('Контроллер', () => { path = []; selected = null; redraw(); }, path.length === 0));
    for (let i = 0; i < path.length; i++) {
      const sep = el('span', 'color:#4a5680;font-size:11px'); sep.textContent = '›'; bar.append(sep);
      const lvl = path[i]!;
      bar.append(btn(LEVEL_TITLE[lvl], () => { path = path.slice(0, i + 1); selected = null; redraw(); }, i === path.length - 1));
    }
  };

  const enter = (id: string): void => {
    const n = model().find((m) => m.id === id);
    if (!n?.enter) return;
    path = [...path, n.enter]; selected = null; redraw();
  };

  // ── Инспектор ────────────────────────────────────────────────────────────────────────────────
  const row = (box: HTMLElement, lab: string): HTMLElement => {
    const r = ui.el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px');
    const n = ui.el('span', 'flex:0 0 118px;font-size:11px;color:#9aa3b8'); n.textContent = lab; r.append(n);
    box.append(r); return r;
  };

  /** Инспектор предмета: чем подмешивается, в какой руке, с какой силой (то самое «настроить силу»). */
  const itemInspector = (box: HTMLElement, item: string): void => {
    const { el, btn } = ui;
    const cfg = readAnimCfg(host.store(), host.charId());
    const it = (graph().items[item] ??= {});
    const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:6px 0 2px;font-size:11px'); h.textContent = 'ПРЕДМЕТ · ' + item; box.append(h);
    const r1 = row(box, 'подмешивание');
    for (const k of ['additive', 'override'] as const) {
      r1.append(btn(k === 'additive' ? 'дельта на руку' : 'замена верха',
        () => { it.kind = k; host.save(); redraw(); }, cfg.kindOf(item) === k));
    }
    const r2 = row(box, 'рука');
    for (const k of ['main', 'off'] as const) {
      r2.append(btn(k === 'main' ? 'главная' : 'вторая', () => { it.hand = k; host.save(); redraw(); }, cfg.handOf(item) === k));
    }
    const r3 = row(box, 'сила');
    const sl = el('input', 'flex:1 1 auto;min-width:0') as HTMLInputElement;
    sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.01'; sl.value = String(cfg.weightOf(item));
    const v = el('span', 'width:40px;text-align:right;color:#9ae6a0;font-size:10px'); v.textContent = sl.value;
    sl.oninput = () => { v.textContent = sl.value; it.weight = parseFloat(sl.value); host.save(); paint(); };
    r3.append(sl, v);
    const note = el('div', 'color:#7a869e;font-size:10px;margin-top:4px');
    note.textContent = 'Дельта считается от безоружной базы, поэтому комбинации («меч+щит») не авторятся — они складываются сами.';
    box.append(note);
  };

  const stateInspector = (box: HTMLElement, id: string): void => {
    const { el, btn } = ui;
    const cfg = readAnimCfg(host.store(), host.charId()).stateCfg(id);
    const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:6px 0 2px;font-size:11px'); h.textContent = 'СОСТОЯНИЕ · ' + id; box.append(h);

    // Клип: выпадашка по библиотеке персонажа + «как называется состояние».
    const sel = el('select', 'flex:1 1 auto;min-width:0;background:#0e1016;color:#cfd3e0;border:1px solid #39415a;border-radius:3px;font:10px monospace') as HTMLSelectElement;
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = `— по имени состояния (${id}) —`; sel.append(o0);
    for (const n of host.clipNames()) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.append(o); }
    sel.value = cfg.clip === id ? '' : cfg.clip;
    if (sel.value && !host.clipNames().includes(sel.value)) sel.style.borderColor = '#c05050';
    sel.onchange = () => { stateObj(id).clip = sel.value || undefined; host.save(); paint(); };
    row(box, 'клип').append(sel);

    const num = (lab: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number): void => {
      const r = row(box, lab);
      const sl = el('input', 'flex:1 1 auto;min-width:0') as HTMLInputElement;
      sl.type = 'range'; sl.min = String(min); sl.max = String(max); sl.step = String(step); sl.value = String(get());
      const v = el('span', 'width:40px;text-align:right;color:#9ae6a0;font-size:10px'); v.textContent = String(get());
      sl.oninput = () => { const nv = parseFloat(sl.value); v.textContent = String(nv); set(nv); host.save(); paint(); };
      r.append(sl, v);
    };
    num('приоритет', () => cfg.priority, (v) => { stateObj(id).priority = v; }, 0, 20, 1);
    num('кроссфейд (с)', () => cfg.blendSec, (v) => { stateObj(id).blendSec = v; }, 0, 1, 0.01);

    row(box, 'прерываемость').append(btn(cfg.interruptible ? 'можно прервать' : 'ЗАМОК (нельзя)',
      () => { stateObj(id).interruptible = !cfg.interruptible; host.save(); redraw(); }, !cfg.interruptible));
    const r3 = row(box, 'ноги');
    for (const m of ['auto', 'never', 'always'] as const) {
      r3.append(btn(m === 'auto' ? 'по скорости' : m === 'never' ? 'только верх' : 'всегда низ',
        () => { stateObj(id).legs = m === 'auto' ? undefined : m; host.save(); redraw(); }, cfg.legs === m));
    }

    // Цепочки: какие состояния могут пойти ПОСЛЕ этого.
    const st = stateObj(id);
    const cur2 = Array.isArray(st.next) ? st.next : [];
    const r4 = row(box, 'цепочка после');
    const wrap = el('div', 'display:flex;flex-wrap:wrap;gap:3px;flex:1 1 auto'); r4.append(wrap);
    for (const other of allStates()) {
      if (other === id) continue;
      wrap.append(btn(other, () => {
        const nx = new Set(cur2); if (nx.has(other)) nx.delete(other); else nx.add(other);
        st.next = nx.size ? [...nx] : undefined; host.save(); redraw();
      }, cur2.includes(other)));
    }

    const r5 = row(box, 'проверить');
    r5.append(btn('▶ проиграть', () => host.trigger(id)));
    r5.append(btn('удалить состояние', () => {
      const { states, layout } = graph();
      delete states[id]; delete layout[id];
      selected = null; host.save(); redraw();
    }));
  };

  const renderInspector = (box: HTMLElement): void => {
    const { el } = ui;
    const lvl = cur();
    if (!selected) {
      const t = el('div', 'color:#7a869e;font-size:10px;margin-top:6px',
        lvl === '' ? 'Двойной клик по слою — зайти внутрь. Выйти — крошкой сверху.'
          : 'Выбери узел, чтобы настроить. ПКМ по холсту — добавить состояние.');
      box.append(t); return;
    }
    if (lvl === 'action' && !selected.startsWith('#')) { stateInspector(box, selected); return; }
    if ((lvl === 'main' || lvl === 'off') && !selected.startsWith('#')) { itemInspector(box, selected); return; }
    const why: Record<string, string> = {
      '#loco': 'Ноги и таз ведёт планировщик шагов — все его ручки на вкладке «Бег», там же их видно на кукле.',
      '#base': 'Безоружная база: от неё считаются дельты всех предметов. Её клип — на вкладке «Бег».',
      '#relax': 'Спокойная базовая стойка. Привязка клипа — в панели стойки на вкладке «Бег».',
      '#incombat': 'Боевая базовая стойка: подмешивается по `combat` 0..1.',
    };
    const node = model().find((n) => n.id === selected);
    const t = el('div', 'color:#7a869e;font-size:10px;margin-top:6px',
      why[selected] ?? (node?.enter ? 'Двойной клик по узлу — зайти внутрь слоя.' : 'Служебный узел.'));
    box.append(t);
  };

  // ── Большое поле ─────────────────────────────────────────────────────────────────────────────
  let lastField: HTMLElement | null = null;
  let lastBox: HTMLElement | null = null;
  const redraw = (): void => {
    if (lastField) renderField(lastField);
    if (lastBox) { lastBox.innerHTML = ''; renderInspector(lastBox); }
  };

  const renderField = (fieldHost: HTMLElement): void => {
    lastField = fieldHost;
    const { el, btn } = ui;
    fieldHost.innerHTML = '';
    fieldHost.style.display = 'flex';
    fieldHost.style.flexDirection = 'column';

    const bar = el('div', 'display:flex;gap:4px;align-items:center;padding:4px 6px;background:#12141c;border-bottom:1px solid #39415a;flex:0 0 auto;flex-wrap:wrap');
    crumbs(bar);
    const spacer = el('div', 'flex:1 1 auto'); bar.append(spacer);
    bar.append(btn('вписать', () => canvas?.fit()));
    if (cur() === 'action') {
      bar.append(btn('+ состояние', () => {
        const nm = prompt('имя состояния (например hit_react_F, cast_release)', 'state');
        if (!nm) return;
        stateObj(nm); selected = nm; host.save(); redraw();
      }));
    }
    const hint = el('div', 'color:#7a869e;font-size:10px');
    hint.textContent = cur() === ''
      ? 'стек слоёв снизу вверх · двойной клик — зайти внутрь'
      : cur() === 'action' ? 'зелёные — цепочки, пунктир — «перебьёт»' : 'ребро — «подмешивается к базе»';
    bar.append(hint);
    fieldHost.append(bar);

    const holder = el('div', 'flex:1 1 auto;min-height:0;position:relative'); fieldHost.append(holder);
    canvas = graphCanvas(holder, {
      selected: () => selected,
      onSelect: (id) => { selected = id; if (lastBox) { lastBox.innerHTML = ''; renderInspector(lastBox); } paint(); },
      onEnter: (id) => enter(id),
      onMove: (id, x, y) => { graph().layout[layKey(id)] = { x, y }; host.save(); },
    });
    paint();
    canvas.fit();

    const foot = el('div', 'flex:0 0 auto;padding:3px 6px;color:#7a869e;font-size:10px;background:#12141c;border-top:1px solid #39415a');
    foot.textContent = host.active() ? 'сейчас играет действие' : 'слот действия пуст';
    fieldHost.append(foot);
  };

  return {
    renderField,
    renderInspector: (box) => { lastBox = box; renderInspector(box); },
    level: cur,
  };
}
