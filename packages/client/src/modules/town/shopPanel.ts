import { shopBuyPrice, shopSellPrice, type Item } from '@dm/shared';
import type { PanelFactory } from '../../ui/domUi.js';
import { itemTooltipHtml } from '../inventory/itemView.js';
import { COLORS, mk, itemSlot, attachTooltip } from '../../ui/kit.js';
import { shopCategory } from './shopCats.js';
import { renderShopGrid } from './shopGrid.js';

/**
 * Лавка зелий: ассортимент авторитетный (с сервера, `app.shopStock`) — здесь только расходники (зелья/свитки).
 * Оружие/броня — в кузнице. Покупка/продажа — команды `buy`/`sell` серверу (он меняет золото/инвентарь и
 * шлёт `SaveUpdate`+`shop`, панель перерисовывается). Лавочник — универсальный скупщик: продать можно ЛЮБОЙ предмет.
 */

/** Слот предмета с ценой под ним и тултипом. */
function pricedSlot(item: Item, priceText: string, priceColor: string, onClick: () => void): HTMLElement {
  const col = mk('div', 'display:flex;flex-direction:column;align-items:center;gap:2px;width:52px');
  const cell = itemSlot(item, { onClick });
  attachTooltip(cell, () => itemTooltipHtml(item));
  col.append(cell, mk('div', `font-size:10px;color:${priceColor};text-align:center`, priceText));
  return col;
}

export const shopPanel: PanelFactory = (app) => ({
  title: 'Лавка зелий',
  render(body) {
    const state = app.state!;
    const rarities = app.config.get('rarities');

    const head = mk('div', 'margin-bottom:10px');
    head.innerHTML = `Золото: <b style="color:${COLORS.gold}">${state.save.gold}</b>`;
    body.appendChild(head);

    const grid = mk('div', 'display:grid;grid-template-columns:auto 1fr;gap:18px;align-items:start');

    // Купить — только зелья/расходники, сетка «как инвентарь».
    const left = mk('div');
    left.append(mk('h4', 'margin:0 0 8px', 'Купить'));
    const potions = app.shopStock.filter((it) => shopCategory(it) === 'potion');
    if (potions.length === 0) left.append(mk('div', 'color:#666', 'Нет зелий в продаже'));
    else left.append(renderShopGrid(potions, {
      cols: 6, minRows: 3,
      price: (it) => shopBuyPrice(it, rarities),
      affordable: (it) => state.save.gold >= shopBuyPrice(it, rarities),
      onBuy: (it) => app.sendCmd({ cmd: 'buy', uid: it.uid }),
      tooltip: (it) => itemTooltipHtml(it),
    }));

    // Продать — любой предмет (универсальный скупщик).
    const right = mk('div');
    right.append(mk('h4', 'margin:0 0 8px', 'Продать (любой предмет)'));
    const sellCells = mk('div', 'display:flex;flex-wrap:wrap;gap:8px');
    if (state.save.inventory.length === 0) right.append(mk('div', 'color:#666', 'Инвентарь пуст'));
    for (const item of state.save.inventory) {
      sellCells.appendChild(pricedSlot(item, `+${shopSellPrice(item, rarities)}`, COLORS.gold,
        () => app.sendCmd({ cmd: 'sell', uid: item.uid })));
    }
    right.appendChild(sellCells);

    grid.append(left, right);
    body.appendChild(grid);
    body.append(mk('div', 'font-size:11px;color:#666;margin-top:8px', 'Оружие и броня — в кузнице (вкладка «Купить»). Наведи на предмет — детали.'));
  },
});
