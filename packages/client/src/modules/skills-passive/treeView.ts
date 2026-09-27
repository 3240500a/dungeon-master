import type { App } from '../../core/app.js';
import type { CmdReply } from '../../net/cmdReplies.js';
import { passiveRespecFee, passiveEntriesFor, type TownCommand } from '@dm/shared';
import { isAllocatable, passiveNodeCost } from './allocate.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** Состояние вида (пан/зум) сохраняется между перерисовками панели. */
const view = { scale: 0, tx: 0, ty: 0, inited: false };

function commit(app: App): void {
  app.bus.emit('state:changed', {}); // онлайн: сейв авторитетен на сервере
}

/** R7-21: узлы, чей ранг в полёте, — по приложению: окно перерисовывается и собирает узлы заново. */
const allocInFlight = new WeakMap<object, Set<string>>();

/**
 * ⭐ R7-21: РАНГ УЗЛА — ОДНА ЗАЯВКА ЗА РАЗ. Цена карточки (`maxGold`, R6-16) считается от ранга, с которым окно нарисовано,
 * а перерисовывается окно только сейвом: двойной клик быстрее ответа уходил ДВУМЯ командами с ценой ранга r — сервер
 * поднимал ранг первой, а вторую отказывал «Цена изменилась» (ранг r+1 вдвое дороже): ложный отказ и зря перечитанный
 * конфиг. Теперь клик по узлу, чей ранг в полёте, молчит; ответ сервера идёт ПОСЛЕ сейва — окно уже нарисовано по новому
 * рангу, и следующий клик несёт его цену. Ответ-отказ — строкой в лог (ждущему окну `App` его не пишет); ответа нет — узел
 * снова кликается. Другие узлы не ждут: цена каждого — от его собственного ранга.
 */
function allocOnce(app: App, command: Extract<TownCommand, { cmd: 'allocPassive' }>): void {
  let busy = allocInFlight.get(app);
  if (!busy) allocInFlight.set(app, (busy = new Set()));
  if (busy.has(command.nodeId)) return;
  const nodes = busy;
  nodes.add(command.nodeId);
  let reply: Promise<CmdReply | null>;
  try { reply = app.request(command); } catch { reply = Promise.resolve(null); }
  void reply.catch(() => null).then((r) => {
    nodes.delete(command.nodeId);
    if (r && !r.ok && r.reason) app.bus.emit('log:message', { text: `Не вышло: ${r.reason}`, kind: 'system' });
  });
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
  const tree = app.config.get('mastery-tree');

  const header = mk('div', 'margin-bottom:8px;font-size:13px');
  header.innerHTML =
    `Очки мастерства: <b style="color:${COLORS.accent}">${state.save.unspentMasteryPoints}</b> · ` +
    `Золото: <b style="color:${COLORS.gold}">${state.save.gold}</b> · ` +
    `<span style="color:${COLORS.dim}">колесо — зум, перетаскивание — панорама, клик по доступному узлу — прокачать (очко + золото)</span>`;
  body.appendChild(header);

  // Сброс пассивов: возвращает очки (Σ рангов), НЕ возвращает вложенное золото; комиссия
  // растёт с прокачкой (доля вложенного, `balance.passiveRespecCostPct`).
  const ranks = Object.values(state.save.masteries).reduce((a, r) => a + (r > 0 ? r : 0), 0);
  const fee = passiveRespecFee(app.config, state.save);
  const reset = mk('button',
    'margin-bottom:8px;padding:6px 12px;font-size:12px;border-radius:6px;cursor:pointer;' +
    `border:1px solid ${COLORS.border};background:${COLORS.panel2};color:${COLORS.text}`) as HTMLButtonElement;
  reset.textContent = `Сбросить мастерства · вернёт ${ranks} очк., комиссия ${fee} зол.`;
  reset.disabled = ranks === 0 || state.save.gold < fee;
  if (reset.disabled) { reset.style.opacity = '0.5'; reset.style.cursor = 'default'; }
  reset.addEventListener('click', () => {
    if (ranks === 0 || state.save.gold < fee) return;
    if (!window.confirm(`Сбросить ВСЕ мастерства?\nВернётся ${ranks} очков мастерства.\nЗолото за узлы НЕ возвращается, комиссия: ${fee} зол.`)) return;
    app.sendCmd({ cmd: 'respecPassives', maxGold: fee });   // R5-15: комиссия, названная в вопросе, — дороже сервер не возьмёт
  });
  body.appendChild(reset);

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
    const bothOn = (state.save.masteries[a] ?? 0) > 0 && (state.save.masteries[b] ?? 0) > 0;
    const line = svg('line', {
      x1: na.x, y1: na.y, x2: nb.x, y2: nb.y,
      stroke: bothOn ? '#8aa84a' : '#3e4756',
      'stroke-width': bothOn ? 3 : 1.5,
    });
    g.appendChild(line);
  }

  // Доступные входы этого класса (остальные входы — серые/недоступные).
  const allowedEntries = passiveEntriesFor(app.config, state.save);

  // Узлы.
  for (const node of tree.nodes) {
    const rank = state.save.masteries[node.id] ?? 0;
    const allocated = rank > 0;
    const available = !allocated && isAllocatable(tree, state, node.id, allowedEntries);
    const isEntry = tree.entryNodes.includes(node.id);
    const lockedEntry = isEntry && !allowedEntries.includes(node.id);
    const r = node.notable ? 15 : isEntry ? 12 : 9;

    // ⚠ R10-11: «Треб. уровень» узла — как у древа скилов (`skillTreeView`): доступный, но не по уровню — приглушён.
    const lowLvl = state.save.level < node.levelReq;
    let fill = '#1a1f29';
    let stroke = '#3e4756';
    if (allocated) { fill = node.notable ? COLORS.gold : '#8aa84a'; stroke = '#0a0a0a'; }
    else if (available) { fill = lowLvl ? '#241d17' : '#1e2a3a'; stroke = lowLvl ? '#6b563a' : '#6f9bcf'; }
    if (isEntry && !allocated) stroke = COLORS.gold;         // доступный вход класса — золотой
    if (lockedEntry) { fill = '#241a1a'; stroke = '#5a3a3a'; } // чужой вход — заблокирован

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
      const lvlLine = state.save.level < node.levelReq
        ? `<div style="color:#d89b7c">требуется уровень ${node.levelReq}</div>` : '';
      return `<div style="color:${node.notable ? COLORS.gold : COLORS.text};font-weight:bold">${node.name}</div>` +
        `<div style="color:#c4bca8">${node.description}</div>` +
        `<div style="color:#9aa;margin-top:3px">ранг ${rank}/${maxRank} · ${costLine}</div>` + lvlLine +
        (eff ? `<div style="color:#8fd">${eff}</div>` : '');
    });

    circle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dragMoved) return;
      // R6-16: цена карточки «след. ранг» — дороже сервер не возьмёт (отказ «Цена изменилась», клиент перечитает конфиг).
      // R7-21: пока ранг этого узла в полёте, второй клик молчит (`allocOnce`).
      allocOnce(app, { cmd: 'allocPassive', nodeId: node.id, maxGold: passiveNodeCost(node.cost.amount, rank, mult) });
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
