import type { Item } from '@dm/shared';
import type { App } from '../../core/app.js';
import type { PanelFactory } from '../../ui/domUi.js';
import { itemsOverlapping, type Dims } from '../inventory/grid.js';
import { renderGrid } from '../inventory/gridView.js';
import { getHeld, beginHold, clearHeld, resolveHeldOnClose } from '../inventory/heldItem.js';
import { itemTooltipHtml } from '../inventory/itemView.js';
import { COLORS, mk, tabsBar } from '../../ui/kit.js';

/**
 * Панель ОБЩЕГО (на аккаунт) сундука: вкладки + сетка активной вкладки. Раскладка авторитетна
 * на сервере (кадр `stash` → `app.stash`); клиент рисует и шлёт `stashMove`. Курсор общий с
 * инвентарём (`heldItem`) — предмет таскается инвентарь↔вкладка↔вкладка единым «взял/положил».
 * Сундук доступен всем героям аккаунта (перенос шмота между персонажами).
 */
export const stashPanel: PanelFactory = (app) => {
  let activeTab = 0;
  app.sendCmd({ cmd: 'stashOpen' }); // запросить актуальный слепок при открытии

  return {
    title: 'Сундук (общий на аккаунт)',
    render(body) {
      const s = app.stash;
      if (!s) { body.append(mk('div', `color:${COLORS.dim};font-size:13px`, 'Загрузка сундука…')); return; }
      const tabCount = s.tabCount || s.tabs.length || 1;
      if (activeTab >= tabCount) activeTab = 0;

      const tabs = Array.from({ length: tabCount }, (_, i) => [String(i), `Вкладка ${i + 1}`] as const);
      body.append(tabsBar(tabs, String(activeTab), (key) => { activeTab = Number(key); app.bus.emit('state:changed', {}); }));

      const dims: Dims = { cols: s.cols, rows: s.rows };
      const items = s.tabs[activeTab] ?? [];
      body.append(renderGrid(items, dims, {
        onPick: (col, row) => pick(app, items, col, row, activeTab),
        onPlace: (col, row) => place(app, dims, col, row, activeTab),
        tooltip: (item) => itemTooltipHtml(item),
      }));
      body.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-top:8px`,
        'Общий сундук аккаунта — доступен всем твоим героям. Клик — взять на курсор / положить.'));
    },
    dispose() { resolveHeldOnClose(app); },
  };
};

function pick(app: App, items: Item[], col: number, row: number, tab: number): void {
  const item = itemsOverlapping(items, col, row, 1, 1, '')[0];
  if (!item || !item.pos) return;
  beginHold(app, item, col - item.pos.x, row - item.pos.y, { tab });
}

/** Кладёт держимый предмет в активную вкладку: `stashMove dst:tab` (сервер найдёт источник — инвентарь/другая вкладка/эта). */
function place(app: App, dims: Dims, col: number, row: number, tab: number): void {
  const held = getHeld();
  if (!held) return;
  const { item, grabOx, grabOy } = held;
  const tx = col - grabOx;
  const ty = row - grabOy;
  clearHeld();
  if (tx < 0 || ty < 0 || tx + item.gridW > dims.cols || ty + item.gridH > dims.rows) { app.bus.emit('state:changed', {}); return; }
  app.sendCmd({ cmd: 'stashMove', uid: item.uid, dst: tab, x: tx, y: ty });
  app.bus.emit('state:changed', {});
}
