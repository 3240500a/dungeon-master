import type { App } from '../../core/app.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';
import { CELL, GAP } from './heldItem.js';
import { materialsModel, type MaterialCell } from './materialsModel.js';

/**
 * СКЛАД МАТЕРИАЛОВ — вкладка «Ресурсы» СУНДУКА (кошелёк аккаунта, общий для всех героев) и полоса сырья верстака кузницы.
 *
 * ⚠ В панели инвентаря этого склада НЕТ и быть не должно: с ч7 сырьё лежит в самой сетке сумки
 * стеками, и вторая вкладка дублировала бы её. Здесь показывается то, что НАКОПЛЕНО в сундуке,
 * плюс справочно то, что игрок несёт при себе.
 *
 * Что и как показывать — решает чистая модель (`materialsModel.ts`, её же сверяет эталон Unity): строка на семью, столбец на СОРТ
 * I–V с подписью «с каких вещей», металлическая шкала цветов, эссенция — отдельной плашкой под сеткой, строка-правило внизу.
 * Здесь только DOM. Клетка ростом с клетку инвентаря (`CELL`), чтобы вкладки не прыгали; `compact` — низкая клетка для полосы под
 * верстаком кузницы (там склад — справка к ценам, а не главное окно).
 */

/** Подсказка строками → HTML: заголовок цветом сорта, остальное как есть; строка «В сумке…» — зелёным (несомое под угрозой смерти). */
function tipHtml(c: MaterialCell): string {
  const [title, ...rest] = c.tip;
  return `<b style="color:${c.color}">${title ?? c.name}</b>` + rest.map((l) =>
    (l.startsWith('В сумке ') ? `<br><span style="color:#7fd07f">${l}</span>` : `<br>${l}`)).join('');
}

/** Ширина клетки и подписи семьи. */
const COL_W = 72;

/** @param stashWallet сырьё СУНДУКА аккаунта (общее для всех героев). */
export function materialsView(app: App, stashWallet: Record<string, number>, opts: { compact?: boolean } = {}): HTMLElement {
  const m = materialsModel(app.config, stashWallet, app.state!.save.inventory);
  const h = opts.compact ? 24 : CELL;
  const box = mk('div');
  if (!m.rows.length && !m.essence) { // конфиг ещё не доехал (старый сервер) — говорим прямо, а не молчим
    box.append(mk('div', 'font-size:12px;color:#666', 'Материалы не настроены в конфиге.'));
    return box;
  }

  const grid = mk('div', `display:flex;flex-direction:column;gap:${opts.compact ? 3 : GAP}px`);
  // Шапка столбцов: «I сорт» и под ним мелко — с каких вещей он идёт. Она и есть ответ на «почему столько колонок».
  const head = mk('div', `display:flex;align-items:flex-end;gap:${GAP}px;margin-bottom:2px`);
  head.append(mk('div', `width:${COL_W}px;flex:0 0 auto`));
  for (const hd of m.heads) {
    const col = mk('div', `width:${COL_W}px;flex:0 0 auto;text-align:center;line-height:1.15`);
    col.append(mk('div', `font-size:11px;color:${hd.color};${hd.bold ? 'font-weight:700' : ''}`, hd.label));
    if (!opts.compact) col.append(mk('div', `font-size:9px;color:${COLORS.dim};margin-top:1px`, hd.sub));
    attachTooltip(col, () => `<b style="color:${hd.color}">${hd.label}</b><br>С каких вещей: ${hd.sub}`);
    head.append(col);
  }
  grid.append(head);

  for (const row of m.rows) {
    const line = mk('div', `display:flex;align-items:center;gap:${GAP}px`);
    line.append(mk('div', `width:${COL_W}px;flex:0 0 auto;font-size:11px;color:${COLORS.dim};text-align:right;padding-right:4px;box-sizing:border-box`, row.label));
    for (const c of row.cells) line.append(c ? cellEl(c, h) : mk('div', `width:${COL_W}px;height:${h}px;flex:0 0 auto`));
    grid.append(line);
  }
  box.append(grid);

  // ⭐ Эссенция — ОТДЕЛЬНОЙ плашкой под сеткой: строкой в сетке её прочли бы как сырьё I сорта.
  if (m.essence) {
    const e = m.essence;
    const plate = mk('div',
      `display:inline-flex;align-items:center;gap:8px;margin-top:${opts.compact ? 6 : 10}px;padding:${opts.compact ? 2 : 6}px 12px;` +
      `border-radius:6px;border:1px solid ${e.have ? `${e.color}aa` : COLORS.border};background:${COLORS.panel2};font-size:12px;` +
      `color:${e.have ? e.color : COLORS.dim}`);
    plate.append(mk('span', '', `✦ ${e.name}:`), mk('b', '', String(e.stash)));
    if (e.hand > 0) plate.append(mk('span', 'font-size:10px;color:#7fd07f', `+${e.hand}`));
    attachTooltip(plate, () => tipHtml(e));
    box.append(plate);
  }
  box.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-top:${opts.compact ? 4 : 8}px`, m.rule));
  return box;
}

/** Клетка сорта: квадратик цвета сорта, сколько в сундуке и «+N» несомого. */
function cellEl(c: MaterialCell, h: number): HTMLElement {
  const el = mk('div',
    `width:${COL_W}px;height:${h}px;flex:0 0 auto;box-sizing:border-box;border-radius:6px;` +
    `display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;` +
    `background:${COLORS.panel2};border:1px solid ${c.have ? `${c.color}88` : COLORS.border};` +
    `color:${c.have ? c.color : '#4a4a4a'};${c.bold ? 'font-weight:700' : ''}`);
  el.append(mk('span', `width:9px;height:9px;border-radius:2px;display:inline-block;background:${c.have ? c.color : '#3a3a3a'}`));
  // ⭐ Две цифры в клетке: сколько лежит в сундуке и сколько НЕСЁШЬ. Несомое под угрозой смерти, и игрок должен видеть это,
  // не открывая инвентарь.
  el.append(mk('b', '', String(c.stash)));
  if (c.hand > 0) el.append(mk('span', 'font-size:10px;color:#7fd07f', `+${c.hand}`));
  attachTooltip(el, () => tipHtml(c));
  return el;
}
