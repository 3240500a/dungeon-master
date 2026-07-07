import { rollAffixes, createRng, type Item } from '@dm/shared';
import type { App } from '../../core/app.js';
import type { PanelFactory } from '../../ui/domUi.js';
import { itemTooltipHtml } from '../inventory/itemView.js';
import { COLORS, mk, button, itemSlot, attachTooltip } from '../../ui/kit.js';

function commit(app: App): void {
  app.bus.emit('state:changed', {}); // сейв персистит сервер; локально только перерисовка
}

/** Улучшение: увеличивает плоские базовые статы предмета (+20%, минимум +1). */
function upgradeItem(item: Item): void {
  item.baseStats = item.baseStats.map((m) =>
    m.kind === 'flat'
      ? { ...m, value: Math.max(m.value + 1, Math.round(m.value * 1.2)) }
      : m,
  );
  if (!item.name.startsWith('★')) item.name = `★ ${item.name}`;
}

/** Реролл аффиксов: заново катит столько же аффиксов из пула. */
function rerollItem(app: App, item: Item): void {
  const rng = createRng((Date.now() & 0xffffff) >>> 0);
  const count = item.affixes.length || 1;
  item.affixes = rollAffixes(app.config.get('affixes'), count, item.itemLevel, rng);
}

/** Кузница: выбор предмета из инвентаря и операции улучшения/реролла за золото. */
export const forgePanel: PanelFactory = (app) => ({
  title: 'Кузница',
  render(body) {
    const state = app.state!;
    const prices = app.config.get('balance').forgePrices;

    const head = mk('div', 'margin-bottom:10px');
    head.innerHTML =
      `Золото: <b style="color:${COLORS.gold}">${state.save.gold}</b><br>` +
      `<span style="font-size:12px;color:${COLORS.dim}">Улучшение усиливает базовые статы, реролл перекатывает аффиксы.</span>`;
    body.appendChild(head);

    if (state.save.inventory.length === 0) {
      body.append(mk('div', 'color:#666', 'Нет предметов в инвентаре для работы.'));
      return;
    }

    for (const item of [...state.save.inventory]) {
      const row = mk('div',
        `display:flex;align-items:center;gap:10px;border:1px solid ${COLORS.border};border-radius:6px;padding:8px;margin:6px 0;background:${COLORS.bg}`);
      const cell = itemSlot(item, {});
      attachTooltip(cell, () => itemTooltipHtml(item));
      const name = mk('div', 'flex:1;font-size:13px', item.name);
      const upgrade = button(`Улучшить (${prices.upgradeTier})`, () => {
        if (state.save.gold < prices.upgradeTier) return;
        state.save.gold -= prices.upgradeTier;
        upgradeItem(item);
        commit(app);
      }, 'default', state.save.gold < prices.upgradeTier);
      const reroll = button(`Реролл (${prices.rerollAffix})`, () => {
        if (state.save.gold < prices.rerollAffix) return;
        state.save.gold -= prices.rerollAffix;
        rerollItem(app, item);
        commit(app);
      }, 'default', state.save.gold < prices.rerollAffix);
      row.append(cell, name, upgrade, reroll);
      body.appendChild(row);
    }
  },
});
