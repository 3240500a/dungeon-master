import { availableMaterials, forgeGold, type Item } from '@dm/shared';
import type { App } from '../../core/app.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';
import { itemTooltipHtml, itemDescLines } from '../inventory/itemView.js';
import { rarityHex } from '../loot/rarity.js';
import { CELL, glyphOf, getHeld, clearHeld } from '../inventory/heldItem.js';
import { benchActions, benchTarget, diffStrings, type BenchAction } from './forgeActions.js';

/**
 * ВЕРСТАК КУЗНЕЦА: одна вещь в слоте вместо списка из пятнадцати строк с шестьюдесятью кнопками.
 *
 * Почему слот, а не список: решение всегда про ОДНУ вещь, а список заставлял искать её глазами
 * среди одинаковых рядов, где цена была втиснута в подпись кнопки. Освободившееся место ушло на
 * то, чего в списке не было вовсе, — предпросмотр результата и построчную цену с «чего не хватает».
 *
 * ⚠ ВЕЩЬ НЕ УХОДИТ ИЗ СУМКИ. Слот держит только `uid`: положить — это ВЫБРАТЬ, а не переложить.
 * Поэтому серверной команды на «положить» нет, откатывать нечего, и закрытое окно ничего не теряет.
 *
 * Здесь только отрисовка: что предлагать и что почём — решает чистый `forgeActions.ts`.
 */

/** Цвет «стало» — та же мшистая зелень, что у положительных строк в остальном UI. */
const GOOD = COLORS.good;

export interface BenchOpts {
  /** Выбранная вещь (по uid) и как её сменить. ⚠ Состояние живёт в ПАНЕЛИ: тело окна
   *  перерисовывается на каждое `state:changed`, и локальная переменная очищала бы слот сама. */
  uid: string | null;
  setUid: (uid: string | null) => void;
}

/** Строки описания без аффиксов: кузнечное улучшение их не трогает, в предпросмотре они шумят. */
const baseLines = (item: Item): string[] =>
  itemDescLines(item).filter((l) => !l.affix).map((l) => l.text);

function previewBlock(rows: { was: string; will: string }[]): HTMLElement {
  const box = mk('div', 'display:flex;flex-direction:column;gap:3px;margin-top:8px');
  for (const r of rows) {
    const line = mk('div', 'display:flex;align-items:baseline;gap:8px;font-size:12px');
    line.append(
      mk('div', `flex:1;min-width:0;color:${COLORS.dim}`, r.was || '—'),
      mk('div', `color:${COLORS.dim};font-size:11px`, '→'),
      mk('div', `flex:1;min-width:0;color:${GOOD}`, r.will || '—'),
    );
    box.append(line);
  }
  return box;
}

/** Карточка действия: заголовок, подзаголовок и построчная цена — вместо цены внутри подписи. */
function actionCard(a: BenchAction, onClick: () => void): HTMLElement {
  const border = a.primary && a.enabled ? COLORS.accent : COLORS.border;
  const card = mk('div',
    `flex:1;min-width:0;box-sizing:border-box;border:${a.primary && a.enabled ? '2px' : '1px'} solid ${border};` +
    `border-radius:8px;padding:10px;background:${a.enabled ? COLORS.panel : COLORS.panel2};` +
    `cursor:${a.enabled ? 'pointer' : 'default'};${a.enabled ? '' : 'opacity:0.55'}`);
  card.append(mk('div', `font-size:13px;color:${a.enabled ? COLORS.text : COLORS.dim}`, a.title));
  card.append(mk('div', `font-size:11px;color:${COLORS.dim};margin:2px 0 8px`, a.sub));
  for (const l of a.lines) {
    const color = l.state === 'miss' ? COLORS.bad : l.state === 'gain' ? GOOD : l.state === 'dim' ? COLORS.dim : COLORS.text;
    const mark = l.state === 'ok' ? '✓ ' : l.state === 'miss' ? '✕ ' : l.state === 'gain' ? '+ ' : '';
    card.append(mk('div', `font-size:12px;line-height:1.7;color:${color}`, `${mark}${l.text}`));
  }
  if (a.enabled) {
    card.addEventListener('click', onClick);
    card.addEventListener('mouseenter', () => { card.style.borderColor = COLORS.accent; });
    card.addEventListener('mouseleave', () => { card.style.borderColor = border; });
  }
  if (a.tip) attachTooltip(card, () => a.tip!);
  return card;
}

/** Полоса сырья: сумка + сундук одним числом — цены выше считаются по тому же итогу. */
function materialsStrip(app: App): HTMLElement {
  const have = availableMaterials(app.state!.save.inventory, app.stash?.materials ?? {});
  const box = mk('div', `border-top:1px solid ${COLORS.border};padding-top:8px;margin-top:12px`);
  box.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:6px`, 'Сырьё — в сумке и сундуке'));
  const row = mk('div', 'display:flex;flex-wrap:wrap;gap:6px');
  for (const d of app.config.get('craft-materials').filter((m) => m.enabled)) {
    const n = have[d.id] ?? 0;
    row.append(mk('div',
      `font-size:12px;padding:2px 9px;border-radius:6px;border:1px solid ${n > 0 ? COLORS.borderHi : COLORS.border};` +
      `background:${COLORS.panel2};color:${n > 0 ? COLORS.text : '#4a4a4a'}`,
      `${d.name} ${n}`));
  }
  box.append(row);
  return box;
}

/** Взять держимый предмет на верстак: он остаётся в сумке, слот запоминает только выбор. */
function takeHeld(app: App, o: BenchOpts): boolean {
  const h = getHeld();
  if (!h) return false;
  o.setUid(h.item.uid);
  clearHeld();
  app.bus.emit('state:changed', {});
  return true;
}

function emptyBench(app: App, o: BenchOpts): HTMLElement {
  const box = mk('div', `border:1px dashed ${COLORS.border};border-radius:8px;padding:22px;text-align:center;cursor:pointer`);
  box.append(mk('div', `font-size:13px;color:${COLORS.dim}`, 'Положи вещь на верстак'));
  box.append(mk('div', 'font-size:11px;color:#5a5a5a;margin-top:4px',
    'Клик по вещи в инвентаре, затем клик сюда. Из сумки она не пропадёт.'));
  box.addEventListener('click', () => { takeHeld(app, o); });
  return box;
}

/** Верстак целиком — готовый блок для тела панели кузницы. */
export function forgeBench(app: App, o: BenchOpts): HTMLElement {
  const state = app.state!;
  const root = mk('div');
  const item = o.uid ? state.save.inventory.find((i) => i.uid === o.uid) ?? null : null;
  // Вещь могла исчезнуть (разобрали, продали, потеряли на смерти) — слот молча пустеет, иначе
  // окно показывало бы цену за то, чего уже нет.
  if (o.uid && !item) o.setUid(null);
  if (!item) { root.append(emptyBench(app, o), materialsStrip(app)); return root; }

  // ── Шапка: слот + имя + предпросмотр ─────────────────────────────────────────
  const head = mk('div',
    `display:flex;gap:14px;align-items:flex-start;border:1px solid ${COLORS.border};` +
    `border-radius:8px;padding:12px;background:${COLORS.panel}`);

  const left = mk('div', 'text-align:center;flex:0 0 auto');
  const cell = mk('div',
    `width:${CELL + 16}px;height:${CELL + 16}px;box-sizing:border-box;border-radius:6px;cursor:pointer;` +
    `display:flex;align-items:center;justify-content:center;font-size:12px;` +
    `border:2px solid ${item.broken ? COLORS.bad : rarityHex(item.rarity)};` +
    `color:${item.broken ? COLORS.bad : rarityHex(item.rarity)};background:${COLORS.panel2}`,
    glyphOf(item));
  attachTooltip(cell, () => itemTooltipHtml(item));
  // Клик занятым слотом меняет вещь на держимую, а с пустым курсором — снимает с верстака.
  cell.addEventListener('click', () => {
    if (takeHeld(app, o)) return;
    o.setUid(null);
    app.bus.emit('state:changed', {});
  });
  left.append(cell, mk('div', `font-size:11px;margin-top:4px;color:${item.broken ? COLORS.bad : COLORS.dim}`,
    item.broken ? 'сломано' : 'снять'));

  const info = mk('div', 'flex:1;min-width:0');
  info.append(mk('div', `font-size:14px;color:${rarityHex(item.rarity)}`, item.name));
  const target = benchTarget(app.config, item);
  const rows = target ? diffStrings(baseLines(item), baseLines(target)) : [];
  info.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-top:2px`,
    item.broken ? 'после починки' : target ? 'после улучшения' : 'улучшать больше некуда'));
  info.append(rows.length
    ? previewBlock(rows)
    : mk('div', `font-size:12px;color:${COLORS.dim};margin-top:8px`, 'Кузнец эту вещь не меняет.'));

  head.append(left, info);
  root.append(head);

  // ── Карточки действий ────────────────────────────────────────────────────────
  const actions = benchActions(app.config, item, state.save.gold, state.save.inventory, app.stash?.materials ?? {});
  const cards = mk('div', 'display:flex;gap:10px;margin-top:10px;align-items:stretch');
  for (const a of actions) cards.append(actionCard(a, () => app.sendCmd({ cmd: a.cmd, uid: item.uid })));
  root.append(cards);

  // Сделка, которую до этого игрок должен был додумать сам (docs/ECONOMY.md, Ч3/Ч4).
  if (item.broken && actions.some((a) => a.id === 'salvage' && a.enabled)) {
    const price = forgeGold(app.config, item, 'repair');
    root.append(mk('div',
      `font-size:12px;color:${COLORS.dim};border:1px solid ${COLORS.border};border-radius:6px;` +
      `padding:8px 10px;margin-top:10px;background:${COLORS.panel2}`,
      `Починить за ${price} и носить — или разобрать и забрать сырьё. Улучшать можно только починенное.`));
  }

  root.append(materialsStrip(app));
  return root;
}
