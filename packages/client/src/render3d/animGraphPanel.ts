/**
 * ГРАФ АНИМАЦИЙ (Ф1.3b) — узловой редактор контроллера.
 *
 * Что здесь авторится: состояния слота действия (удар, стаггер, падение, подъём, каст…) и то, как они
 * уживаются друг с другом. До этого всё это были константы в коде, а после Ф1.3a — поля в JSON, которые
 * приходилось править руками.
 *
 * ЧТО ОЗНАЧАЮТ РЁБРА. Их два вида, и путать их нельзя:
 *  • СПЛОШНЫЕ — авторские цепочки (`next`): «после этого удара может пойти вот этот». Это комбо.
 *  • ПУНКТИР — ВЫВОДИМЫЕ рёбра «кто кого перебивает». Их никто не рисует руками: они следуют из
 *    приоритетов и прерываемости, и показаны ровно затем, чтобы ошибка в приоритетах была ВИДНА,
 *    а не выяснялась в бою.
 *
 * Базовые слои (стойка и локомоция) показаны отдельными узлами слева и НЕ редактируются здесь: у них
 * своя панель («Бег»), а в графе они нужны как точка отсчёта — из них выходит всё остальное.
 */
import { graphCanvas, type GraphCanvas, type GraphEdgeView, type GraphNodeView } from '../ui/graphKit.js';
import { readAnimCfg, type AnimState, type AnimStore } from './animConfig.js';
import { graphEdges, graphNodes, graphStates, type GraphNode } from './animGraphModel.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const NODE_W = 132, NODE_H = 46;
/** Цвет ребра по виду: авторская цепочка зелёная, выводимое «перебьёт» — тревожное, служебное — тусклое. */
const EDGE_COLOR = { 'from-base': '#2f374a', chain: '#46d07a', interrupt: '#c07050' } as const;

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
  render(body: HTMLElement): void;
}

export function createAnimGraphPanel(host: AnimGraphHost, ui: Ui): AnimGraphPanel {
  let selected: string | null = null;
  let canvas: GraphCanvas | null = null;

  const graph = (): { states: Record<string, string | AnimState>; layout: Layout } => {
    const g = (host.store()[host.charId()] ??= {});
    g.states ??= {};
    g.layout ??= {};
    return { states: g.states, layout: g.layout };
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

  /** Раскладка по умолчанию: колонкой справа от базовых слоёв, чтобы граф не начинался с кучи в углу. */
  const posOf = (id: string, i: number): { x: number; y: number } => {
    const { layout } = graph();
    return layout[id] ?? { x: 230 + (i % 2) * 170, y: 20 + Math.floor(i / 2) * 78 };
  };

  const model = (): GraphNode[] => graphNodes(host.store(), host.charId(), host.clipNames());

  const buildNodes = (): GraphNodeView[] => {
    let i = 0;
    return model().map((n) => {
      if (n.id === '#stance') return { id: n.id, x: 20, y: 20, w: NODE_W, h: NODE_H };
      if (n.id === '#loco') return { id: n.id, x: 20, y: 98, w: NODE_W, h: NODE_H };
      const p = posOf(n.id, i++);
      return { id: n.id, x: p.x, y: p.y, w: NODE_W, h: NODE_H };
    });
  };

  const buildEdges = (): GraphEdgeView[] => graphEdges(host.store(), host.charId()).map((e) => ({
    from: e.from, to: e.to, color: EDGE_COLOR[e.kind],
    dashed: e.kind === 'interrupt',
    label: e.kind === 'chain' ? 'цепочка' : e.kind === 'interrupt' ? 'перебьёт' : undefined,
  }));

  const label = (id: string): string => (id === '#stance' ? 'СТОЙКА' : id === '#loco' ? 'ЛОКОМОЦИЯ' : id);

  const paint = (): void => {
    if (!canvas) return;
    const nodes = buildNodes();
    canvas.draw(nodes, buildEdges());
    const info = new Map(model().map((m) => [m.id, m]));
    for (const n of nodes) {
      const g = canvas.layerFor(n.id); if (!g) continue;
      const t1 = document.createElementNS(SVGNS, 'text');
      t1.setAttribute('x', '8'); t1.setAttribute('y', '17'); t1.setAttribute('fill', '#cfd3e0');
      t1.setAttribute('font-size', '11'); t1.setAttribute('font-family', 'monospace');
      t1.textContent = label(n.id).slice(0, 17);
      g.append(t1);
      if (n.id.startsWith('#')) {
        const t2 = document.createElementNS(SVGNS, 'text');
        t2.setAttribute('x', '8'); t2.setAttribute('y', '33'); t2.setAttribute('fill', '#6b7180');
        t2.setAttribute('font-size', '9'); t2.setAttribute('font-family', 'monospace');
        t2.textContent = n.id === '#stance' ? 'настройки — «Бег»' : 'планировщик шагов';
        g.append(t2);
        continue;
      }
      const c = info.get(n.id); if (!c) continue;
      const t2 = document.createElementNS(SVGNS, 'text');
      t2.setAttribute('x', '8'); t2.setAttribute('y', '31'); t2.setAttribute('fill', c.missing ? '#c05050' : '#9ae6a0');
      t2.setAttribute('font-size', '9'); t2.setAttribute('font-family', 'monospace');
      t2.textContent = (c.missing ? '✗ ' : '') + c.clip.slice(0, 18);
      g.append(t2);
      const t3 = document.createElementNS(SVGNS, 'text');
      t3.setAttribute('x', '8'); t3.setAttribute('y', '42'); t3.setAttribute('fill', '#7a869e');
      t3.setAttribute('font-size', '9'); t3.setAttribute('font-family', 'monospace');
      t3.textContent = `prio ${c.priority}${c.interruptible ? '' : ' · замок'} · ноги ${c.legs}`;
      g.append(t3);
    }
  };

  const inspector = (box: HTMLElement): void => {
    const { el, btn } = ui;
    if (!selected || selected.startsWith('#')) {
      const t = el('div', 'color:#7a869e;font-size:10px;margin-top:6px',
        selected === '#stance' ? 'Стойка и предметы настраиваются на вкладке «Бег» — там же, где их видно.'
          : selected === '#loco' ? 'Локомоция — процедурный планировщик шагов, его ручки на вкладке «Бег».'
            : 'Выбери узел состояния, чтобы настроить. ПКМ по холсту — добавить состояние.');
      box.append(t); return;
    }
    const id = selected;
    const cfg = readAnimCfg(host.store(), host.charId()).stateCfg(id);
    const row = (lab: string): HTMLElement => {
      const r = el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px');
      const n = el('span', 'flex:0 0 118px;font-size:11px;color:#9aa3b8'); n.textContent = lab; r.append(n);
      box.append(r); return r;
    };
    const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:6px 0 2px;font-size:11px'); h.textContent = 'СОСТОЯНИЕ · ' + id; box.append(h);

    // Клип: выпадашка по библиотеке персонажа + «как называется состояние».
    const sel = el('select', 'flex:1 1 auto;min-width:0;background:#0e1016;color:#cfd3e0;border:1px solid #39415a;border-radius:3px;font:10px monospace') as HTMLSelectElement;
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = `— по имени состояния (${id}) —`; sel.append(o0);
    for (const n of host.clipNames()) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.append(o); }
    sel.value = cfg.clip === id ? '' : cfg.clip;
    if (sel.value && !host.clipNames().includes(sel.value)) sel.style.borderColor = '#c05050';
    sel.onchange = () => { stateObj(id).clip = sel.value || undefined; host.save(); paint(); };
    row('клип').append(sel);

    const num = (lab: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number): void => {
      const r = row(lab);
      const sl = el('input', 'flex:1 1 auto;min-width:0') as HTMLInputElement;
      sl.type = 'range'; sl.min = String(min); sl.max = String(max); sl.step = String(step); sl.value = String(get());
      const v = el('span', 'width:40px;text-align:right;color:#9ae6a0;font-size:10px'); v.textContent = String(get());
      sl.oninput = () => { const nv = parseFloat(sl.value); v.textContent = String(nv); set(nv); host.save(); paint(); };
      r.append(sl, v);
    };
    num('приоритет', () => cfg.priority, (v) => { stateObj(id).priority = v; }, 0, 20, 1);
    num('кроссфейд (с)', () => cfg.blendSec, (v) => { stateObj(id).blendSec = v; }, 0, 1, 0.01);

    const r2 = row('прерываемость');
    r2.append(btn(cfg.interruptible ? 'можно прервать' : 'ЗАМОК (нельзя)',
      () => { stateObj(id).interruptible = !cfg.interruptible; host.save(); paint(); }, !cfg.interruptible));
    const r3 = row('ноги');
    for (const m of ['auto', 'never', 'always'] as const) {
      r3.append(btn(m === 'auto' ? 'по скорости' : m === 'never' ? 'только верх' : 'всегда низ',
        () => { stateObj(id).legs = m === 'auto' ? undefined : m; host.save(); paint(); }, cfg.legs === m));
    }

    // Цепочки: какие состояния могут пойти ПОСЛЕ этого.
    const st = stateObj(id);
    const cur = Array.isArray(st.next) ? st.next : [];
    const r4 = row('цепочка после');
    const wrap = el('div', 'display:flex;flex-wrap:wrap;gap:3px;flex:1 1 auto'); r4.append(wrap);
    for (const other of allStates()) {
      if (other === id) continue;
      wrap.append(btn(other, () => {
        const nx = new Set(cur); if (nx.has(other)) nx.delete(other); else nx.add(other);
        st.next = nx.size ? [...nx] : undefined; host.save(); paint();
      }, cur.includes(other)));
    }

    const r5 = row('проверить');
    r5.append(btn('▶ проиграть', () => host.trigger(id)));
    r5.append(btn('удалить состояние', () => {
      const { states, layout } = graph();
      delete states[id]; delete layout[id];
      selected = null; host.save(); paint(); render(lastBody!);
    }));
  };

  let lastBody: HTMLElement | null = null;
  const render = (body: HTMLElement): void => {
    lastBody = body;
    const { el, btn } = ui;
    const head = el('div', 'display:flex;gap:4px;align-items:center;margin-bottom:4px'); body.append(head);
    head.append(btn('вписать', () => canvas?.fit()));
    head.append(btn('+ состояние', () => {
      const nm = prompt('имя состояния (например hit_react_F, cast_release)', 'state');
      if (!nm) return;
      stateObj(nm); selected = nm; host.save(); render(body);
    }));
    const hint = el('div', 'color:#7a869e;font-size:10px');
    hint.textContent = 'зелёные — цепочки, пунктир — «перебьёт»';
    head.append(hint);

    const holder = el('div', 'width:100%;height:300px;position:relative'); body.append(holder);
    canvas = graphCanvas(holder, {
      selected: () => selected,
      onSelect: (id) => { selected = id; render(body); },
      onMove: (id, x, y) => { if (!id.startsWith('#')) { graph().layout[id] = { x, y }; host.save(); } },
    });
    paint();
    canvas.fit();

    const box = el('div', 'margin-top:6px;border:1px solid #39415a;border-radius:6px;padding:6px'); body.append(box);
    inspector(box);

    const st = el('div', 'color:#7a869e;font-size:10px;margin-top:6px');
    st.textContent = host.active() ? 'сейчас играет действие' : 'слот действия пуст';
    body.append(st);
  };

  return { render };
}
