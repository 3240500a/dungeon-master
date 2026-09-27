import type { App } from '../../core/app.js';
import { skillRespecFee, type SaveState, type SkillTreeNode } from '@dm/shared';
import { COLORS, askHere, mk, attachTooltip } from '../../ui/kit.js';
import { activeTreeFor } from '../skills-active/allocate.js';
import { elementOf, elementColor, elementLabel } from './skillIcon.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** Состояние вида (пан/зум) сохраняется между перерисовками панели. */
const view = { scale: 0, tx: 0, ty: 0, inited: false };
/** Стартовый масштаб: на нём пассив в 10 единиц читается как 8 пикселей. */
const START_SCALE = 0.8;

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

/** Сколько очков скиллов вернёт сброс (Σ вложенных рангов). */
const skillRanks = (save: SaveState): number => Object.values(save.skills).reduce((a, r) => a + (r > 0 ? r : 0), 0);

/**
 * «Сбросить скиллы» — вопрос и команда. ⭐ R7-12: окно скилов (K) открывается и в подземелье, а `respecSkills` сервер
 * исполняет везде — вне города вопрос В ИГРЕ (`askHere`), а не `window.confirm`: замороженная страница оставляла героя под
 * ударами (R1-14). Пока висел вопрос, игра шла — после «да» перепроверка: сбрасывать ещё есть что, комиссия не выросла
 * (иначе сервер отказал бы «Цена изменилась» и клиент зря перечитал бы конфиг) и золота на неё хватает. Снятый игрой вопрос
 * (`dismissAsk`) — «нет», лог молчит. `true` — команда ушла.
 */
async function respecSkillsAsk(app: App, ranks: number, fee: number): Promise<boolean> {
  const state = app.state;
  if (!state || ranks === 0 || state.save.gold < fee) return false;
  if (!(await askHere(state.area === 'town', `Сбросить ВСЕ скиллы?\nВернётся ${ranks} очков скиллов, комиссия ${fee} зол.\nБинды скиллов будут очищены.`))) return false;
  const now = app.state;
  const feeNow = now ? skillRespecFee(app.config, now.save) : fee;
  const why = !now ? 'герой не в игре' : skillRanks(now.save) === 0 ? 'сбрасывать уже нечего'
    : feeNow > fee ? `комиссия выросла до ${feeNow} зол. — нажми снова` : now.save.gold < feeNow ? 'не хватает золота' : '';
  if (why) { app.bus.emit('log:message', { text: `Сброс отменён: ${why}`, kind: 'system' }); return false; }
  app.sendCmd({ cmd: 'respecSkills', maxGold: fee });   // R5-15: комиссия, названная в вопросе, — дороже сервер не возьмёт
  return true;
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
    `<span style="color:${COLORS.dim}">колесо — зум, перетаскивание — панорама, клик по доступному узлу — вложить очко · ` +
    `<b style="color:${COLORS.accent}">ромб</b> — вставка для сборки скилов</span>`;
  body.appendChild(header);

  // Сброс дерева скилов за золото: возвращает ВСЕ очки скиллов, берёт комиссию (за вложенное очко).
  const ranks = skillRanks(state.save);
  const fee = skillRespecFee(app.config, state.save);
  const reset = mk('button',
    'margin-bottom:8px;padding:6px 12px;font-size:12px;border-radius:6px;cursor:pointer;' +
    `border:1px solid ${COLORS.border};background:${COLORS.panel2};color:${COLORS.text}`) as HTMLButtonElement;
  reset.textContent = `Сбросить скиллы · вернёт ${ranks} очк., комиссия ${fee} зол.`;
  reset.disabled = ranks === 0 || state.save.gold < fee;
  if (reset.disabled) { reset.style.opacity = '0.5'; reset.style.cursor = 'default'; }
  reset.addEventListener('click', () => { void respecSkillsAsk(app, ranks, fee); });
  body.appendChild(reset);

  const wrap = mk('div',
    `position:relative;width:100%;height:min(70vh,720px);background:${COLORS.panel2};` +
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

  /**
   * Стартовый вид — ЧИТАЕМЫЙ МАСШТАБ У ЦЕНТРА, а не «вписать всё дерево».
   *
   * Раньше граф ужимался в 760×460, и на 32 ветках это давало масштаб 0.5: иконка в 15 единиц
   * превращалась в 8 пикселей. Причём расширение дерева этого НЕ лечило, а усугубляло — чем шире
   * мир, тем сильнее ужимает. Дерево смотрят через пан и зум, как карту, а не целиком.
   */
  if (!view.inited && nodes.length) {
    const boxW = wrap.clientWidth || 760;
    const boxH = wrap.clientHeight || 640;
    view.scale = START_SCALE;
    view.tx = boxW / 2;                      // центр дерева (0,0) — в центре холста
    view.ty = boxH / 2;
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
    // Узел-вставка — РОМБ цвета своего типа: в дереве его надо отличать с одного взгляда,
    // иначе вставка неотличима от обычной процентной пассивки и игрок её не ищет.
    const insId = n.effect.grantsInsert;
    const ins = insId ? app.config.get('skill-inserts').find((x) => x.id === insId) : undefined;
    const insColor = ins ? app.config.get('skill-insert-types').find((t) => t.id === ins.type)?.color : undefined;
    const accent = insColor ?? (isActive ? elementColor(elementOf(n)) : sideColor(br.resource, br.group));
    const size = notable ? 16 : isActive || ins ? 13 : 10;

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

    const half = size / 2;
    const rect = ins
      ? svg('polygon', {
        points: `${n.x},${n.y - half} ${n.x + half},${n.y} ${n.x},${n.y + half} ${n.x - half},${n.y}`,
        fill, stroke, 'stroke-width': sw,
      })
      : svg('rect', {
        x: n.x - half, y: n.y - half, width: size, height: size,
        rx: notable ? 5 : 3, fill, stroke, 'stroke-width': sw,
      });
    if (avail || alloc) rect.style.cursor = 'pointer';

    attachTooltip(rect, () => {
      const kindLbl = isActive ? 'Активный скилл' : ins ? 'Вставка для сборки скилов' : 'Пассивный скилл';
      const elLine = isActive
        ? `<div style="color:${elementColor(elementOf(n))}">Стихия: ${elementLabel(elementOf(n))}</div>` : '';
      const costLine = rank >= n.maxRank ? 'макс. ранг' : `след. ранг: ${n.cost.amount} очк.`;
      const lvlLine = state.save.level < n.levelReq
        ? `<div style="color:#d89b7c">требуется уровень ${n.levelReq}</div>` : '';
      // Узел-донор: ранг здесь открывает вставку для сборки скилов — иначе игрок её не найдёт.
      const insLine = ins
        ? `<div style="color:${COLORS.accent};margin-top:3px">\u25C6 Открывает вставку: ${ins.name}</div>` +
          `<div style="color:#c4bca8">${ins.description}</div>` : '';
      return `<div style="color:${notable ? COLORS.gold : COLORS.text};font-weight:bold">${n.name}</div>` +
        `<div style="color:#9aa">${kindLbl} · ${br.name}</div>` +
        `<div style="color:#c4bca8">${n.description}</div>` + elLine +
        `<div style="color:#9aa;margin-top:3px">ранг ${rank}/${n.maxRank} · ${costLine}</div>` + lvlLine + insLine;
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
    const lx = far.x + (far.x / len) * 44;
    const ly = far.y + (far.y / len) * 44;
    const anchor = lx < -20 ? 'end' : lx > 20 ? 'start' : 'middle';
    const t = svg('text', {
      x: lx, y: ly, 'text-anchor': anchor, 'dominant-baseline': 'central',
      'font-size': 13, fill: sideColor(br.resource, br.group), 'fill-opacity': 0.92,
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
