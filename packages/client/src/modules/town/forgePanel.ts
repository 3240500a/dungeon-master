import { shopBuyPrice } from '@dm/shared';
import type { PanelFactory } from '../../ui/domUi.js';
import { itemTooltipHtml } from '../inventory/itemView.js';
import { COLORS, mk, tabsBar } from '../../ui/kit.js';
import { shopCategory, type ShopCat } from './shopCats.js';
import { renderShopGrid } from './shopGrid.js';
import { forgeBench } from './forgeBench.js';

/**
 * Кузница: диалог из двух режимов.
 *  • Работа — ВЕРСТАК (`forgeBench.ts`): одна вещь в слоте, починка/улучшение/реролл/разбор
 *    карточками с полной ценой и предпросмотром. Все действия АВТОРИТЕТНЫ на сервере.
 *  • Купить — магазин оружия/брони: 3 вкладки (ближний/дальний бой, броня), сетка «как инвентарь» (см. shopGrid).
 * Режим/вкладка/выбранная вещь живут в замыкании фабрики (переживают перерисовку панели).
 * Зелья — в лавке (shopPanel).
 */
export const forgePanel: PanelFactory = (app, ui) => {
  // Сырьё живёт в СУНДУКЕ аккаунта, а его слепок приходит только по запросу: без этой строки
  // кузница, открытая первой, считала бы кошелёк пустым и гасила все кнопки.
  app.sendCmd({ cmd: 'stashOpen' });
  // ⭐ Инвентарь открывается ВМЕСТЕ с кузницей: на верстак вещь кладут из сумки, и окно без неё
  // бесполезно. `DomUi` держит несколько окон одновременно — своего механизма не нужно.
  ui.openPanel('inventory');
  let mode: 'work' | 'buy' = 'work';
  let tab: ShopCat = 'melee';
  // ⚠ Выбранная вещь живёт ЗДЕСЬ, а не в `render`: тело окна перерисовывается на каждое
  // `state:changed` — то есть на каждую подобранную монету, — и слот очищался бы сам собой.
  let benchUid: string | null = null;
  return {
    title: 'Кузница',
    render(body) {
      const state = app.state!;
      const rarities = app.config.get('rarities');

      const draw = (): void => {
        body.innerHTML = '';
        const head = mk('div', 'margin-bottom:8px');
        head.innerHTML = `Золото: <b style="color:${COLORS.gold}">${state.save.gold}</b>`;
        body.appendChild(head);

        body.appendChild(tabsBar(
          [['work', '🔨 Работа'], ['buy', '🛒 Купить']] as const,
          mode, (k) => { mode = k; draw(); }));

        if (mode === 'buy') drawBuy();
        else body.appendChild(forgeBench(app, { uid: benchUid, setUid: (u) => { benchUid = u; } }));
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

      draw();
    },
  };
};
