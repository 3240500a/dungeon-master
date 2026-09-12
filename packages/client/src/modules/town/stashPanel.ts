import type { Item } from '@dm/shared';
import type { App } from '../../core/app.js';
import type { PanelFactory } from '../../ui/domUi.js';
import { itemsOverlapping, type Dims } from '../inventory/grid.js';
import { renderGrid } from '../inventory/gridView.js';
import { getHeld, beginHold, clearHeld, resolveHeldOnClose } from '../inventory/heldItem.js';
import { itemTooltipHtml } from '../inventory/itemView.js';
import { COLORS, mk, button, tabsBar } from '../../ui/kit.js';
import { materialsView } from '../inventory/materialsView.js';
import { carriedMaterials } from '@dm/shared';

/**
 * Панель ОБЩЕГО (на аккаунт) сундука: вкладки + сетка активной вкладки. Раскладка авторитетна
 * на сервере (кадр `stash` → `app.stash`); клиент рисует и шлёт `stashMove`. Курсор общий с
 * инвентарём (`heldItem`) — предмет таскается инвентарь↔вкладка↔вкладка единым «взял/положил».
 * Сундук доступен всем героям аккаунта (перенос шмота между персонажами).
 */
export const stashPanel: PanelFactory = (app) => {
  // ⚠ Ключ вкладки теперь НЕ только число: у ресурсов он строковый и живёт ВНЕ `tabCount`,
  // иначе сервер выделил бы под неё пустую сетку, а `stashMove dst:N` стал бы валиден для неё.
  let activeTab: number | 'mats' = 0;
  app.sendCmd({ cmd: 'stashOpen' }); // запросить актуальный слепок при открытии

  return {
    title: 'Сундук (общий на аккаунт)',
    render(body) {
      const s = app.stash;
      if (!s) { body.append(mk('div', `color:${COLORS.dim};font-size:13px`, 'Загрузка сундука…')); return; }
      const tabCount = s.tabCount || s.tabs.length || 1;
      if (typeof activeTab === 'number' && activeTab >= tabCount) activeTab = 0;

      const carried = Object.values(carriedMaterials(app.state!.save.inventory)).reduce((a, b) => a + b, 0);
      const tabs = [
        ...Array.from({ length: tabCount }, (_, i) => [String(i), `Вкладка ${i + 1}`] as const),
        ['mats', carried > 0 ? `Ресурсы (+${carried})` : 'Ресурсы'] as const,
      ];
      body.append(tabsBar(tabs, String(activeTab), (key) => {
        activeTab = key === 'mats' ? 'mats' : Number(key);
        app.bus.emit('state:changed', {});
      }));

      if (activeTab === 'mats') {
        body.append(materialsView(app, s.materials));
        // ⭐ Сдача ОДНОЙ кнопкой: раскладывать полтора десятка стеков руками после каждого забега —
        // это не жанровая норма, а лишняя работа (в PoE ровно для этого сделана вкладка валюты).
        const row = mk('div', 'margin-top:10px');
        row.append(button(carried > 0 ? `Сдать всё сырьё (${carried})` : 'В сумке сырья нет',
          () => app.sendCmd({ cmd: 'depositMaterials' }), 'primary', carried <= 0));
        body.append(row);
        body.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-top:8px`,
          'Сырьё общее для всех твоих героев. Кузница тратит сперва из сумки, потом отсюда.'));
        return;
      }

      const dims: Dims = { cols: s.cols, rows: s.rows };
      const items = s.tabs[activeTab] ?? [];
      body.append(renderGrid(items, dims, {
        onPick: (col, row) => pick(app, items, col, row, activeTab as number),
        onPlace: (col, row) => place(app, dims, col, row, activeTab as number),
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
