import { shopBuyPrice, shopSellPrice, type Item } from '@dm/shared';
import type { PanelFactory } from '../../ui/domUi.js';
import { itemTooltipHtml } from '../inventory/itemView.js';
import { COLORS, mk, itemSlot, attachTooltip } from '../../ui/kit.js';

/**
 * Магазин: ассортимент авторитетный (с сервера, `app.shopStock`). Покупка/продажа —
 * команды `buy`/`sell` серверу; тот меняет золото/инвентарь и присылает `SaveUpdate`
 * (+ обновлённый `shop`), панель перерисовывается. Клиент ничего не мутирует сам.
 */

/** Слот предмета с ценой под ним и тултипом. */
function pricedSlot(item: Item, priceText: string, priceColor: string, onClick: () => void, compareTo?: Item | null): HTMLElement {
  const col = mk('div', 'display:flex;flex-direction:column;align-items:center;gap:2px;width:52px');
  const cell = itemSlot(item, { onClick });
  attachTooltip(cell, () => itemTooltipHtml(item, compareTo));
  col.append(cell, mk('div', `font-size:10px;color:${priceColor};text-align:center`, priceText));
  return col;
}

export const shopPanel: PanelFactory = (app) => ({
  title: 'Магазин',
  render(body) {
    const state = app.state!;
    const rarities = app.config.get('rarities');

    const head = mk('div', 'margin-bottom:10px');
    head.innerHTML = `Золото: <b style="color:${COLORS.gold}">${state.save.gold}</b>`;
    body.appendChild(head);

    const grid = mk('div', 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start');

    // Продажа (→ команда sell).
    const left = mk('div');
    left.append(mk('h4', 'margin:0 0 8px', 'Продать'));
    const sellCells = mk('div', 'display:flex;flex-wrap:wrap;gap:8px');
    if (state.save.inventory.length === 0) left.append(mk('div', 'color:#666', 'Инвентарь пуст'));
    for (const item of state.save.inventory) {
      sellCells.appendChild(pricedSlot(item, `+${shopSellPrice(item, rarities)}`, COLORS.gold,
        () => app.sendCmd({ cmd: 'sell', uid: item.uid })));
    }
    left.appendChild(sellCells);

    // Покупка (→ команда buy; ассортимент с сервера).
    const right = mk('div');
    right.append(mk('h4', 'margin:0 0 8px', 'Купить'));
    const buyCells = mk('div', 'display:flex;flex-wrap:wrap;gap:8px');
    for (const item of app.shopStock) {
      const price = shopBuyPrice(item, rarities);
      const affordable = state.save.gold >= price;
      const equipped = item.slot ? state.save.equipment[item.slot] ?? null : null;
      buyCells.appendChild(pricedSlot(item, `${price}`, affordable ? COLORS.gold : COLORS.bad,
        () => app.sendCmd({ cmd: 'buy', uid: item.uid }), equipped));
    }
    right.appendChild(buyCells);

    grid.append(left, right);
    body.appendChild(grid);
    body.append(mk('div', 'font-size:11px;color:#666;margin-top:8px', 'Наведи на предмет — детали и сравнение с надетым.'));
  },
});
