import { shopBuyPrice } from '@dm/shared';
import type { PanelFactory } from '../../ui/domUi.js';
import { itemTooltipHtml } from '../inventory/itemView.js';
import { COLORS, mk, button, itemSlot, attachTooltip, tabsBar } from '../../ui/kit.js';
import { shopCategory, type ShopCat } from './shopCats.js';
import { renderShopGrid } from './shopGrid.js';

/**
 * Кузница: диалог из двух режимов.
 *  • Улучшить — список предметов инвентаря: улучшение базовых статов / реролл аффиксов (АВТОРИТЕТНО на сервере —
 *    команды `forgeUpgrade`/`forgeReroll`, раньше клиент мутировал локально и это откатывалось сейвом).
 *  • Купить — магазин оружия/брони: 3 вкладки (ближний/дальний бой, броня), сетка «как инвентарь» (см. shopGrid).
 * Режим/вкладка живут в замыкании фабрики (переживают перерисовку панели). Зелья — в лавке (shopPanel).
 */
export const forgePanel: PanelFactory = (app) => {
  let mode: 'upgrade' | 'buy' = 'upgrade';
  let tab: ShopCat = 'melee';
  return {
    title: 'Кузница',
    render(body) {
      const state = app.state!;
      const rarities = app.config.get('rarities');
      const prices = app.config.get('balance').forgePrices;

      const draw = (): void => {
        body.innerHTML = '';
        const head = mk('div', 'margin-bottom:8px');
        head.innerHTML = `Золото: <b style="color:${COLORS.gold}">${state.save.gold}</b>`;
        body.appendChild(head);

        body.appendChild(tabsBar(
          [['upgrade', '🔨 Улучшить'], ['buy', '🛒 Купить']] as const,
          mode, (k) => { mode = k; draw(); }));

        if (mode === 'buy') drawBuy();
        else drawUpgrade();
      };

      const drawBuy = (): void => {
        body.appendChild(tabsBar(
          [['melee', '⚔ Ближний бой'], ['ranged', '🏹 Дальний бой'], ['armor', '🛡 Броня']] as const,
          tab, (k) => { tab = k; draw(); }));
        const stock = app.shopStock.filter((it) => shopCategory(it) === tab);
        const scroll = mk('div', 'max-height:56vh;overflow-y:auto;padding-right:4px');
        if (stock.length === 0) scroll.append(mk('div', 'color:#666', 'Пусто в этой категории — загляни после следующего захода в город.'));
        else scroll.append(renderShopGrid(stock, {
          cols: 11, minRows: 4,
          price: (it) => shopBuyPrice(it, rarities),
          affordable: (it) => state.save.gold >= shopBuyPrice(it, rarities),
          onBuy: (it) => app.sendCmd({ cmd: 'buy', uid: it.uid }),
          tooltip: (it) => itemTooltipHtml(it, it.slot ? state.save.equipment[it.slot] ?? null : null),
        }));
        body.appendChild(scroll);
        body.append(mk('div', 'font-size:11px;color:#666;margin-top:6px', 'Клик по предмету — купить. Зелья — в лавке.'));
      };

      const drawUpgrade = (): void => {
        body.append(mk('div', `font-size:12px;color:${COLORS.dim};margin:2px 0 6px`, 'Улучшение усиливает базовые статы (+20%), реролл перекатывает аффиксы.'));
        if (state.save.inventory.length === 0) { body.append(mk('div', 'color:#666', 'Нет предметов в инвентаре для работы.')); return; }
        const list = mk('div', 'max-height:56vh;overflow-y:auto;padding-right:4px');
        for (const item of state.save.inventory) {
          const row = mk('div', `display:flex;align-items:center;gap:10px;border:1px solid ${COLORS.border};border-radius:6px;padding:8px;margin:6px 0;background:${COLORS.bg}`);
          const cell = itemSlot(item, {});
          attachTooltip(cell, () => itemTooltipHtml(item));
          const name = mk('div', 'flex:1;font-size:13px', item.name);
          const up = button(`Улучшить (${prices.upgradeTier})`,
            () => app.sendCmd({ cmd: 'forgeUpgrade', uid: item.uid }), 'default', state.save.gold < prices.upgradeTier);
          const rr = button(`Реролл (${prices.rerollAffix})`,
            () => app.sendCmd({ cmd: 'forgeReroll', uid: item.uid }), 'default', state.save.gold < prices.rerollAffix);
          row.append(cell, name, up, rr);
          list.appendChild(row);
        }
        body.appendChild(list);
      };

      draw();
    },
  };
};
