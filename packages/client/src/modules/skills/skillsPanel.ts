import type { App } from '../../core/app.js';
import type { Panel, PanelFactory } from '../../ui/domUi.js';
import { COLORS, mk } from '../../ui/kit.js';
import { buildBindBar } from '../../ui/bindBar.js';
import { renderSkillTree } from './skillTreeView.js';

/** Панель биндов (D2) внизу окна скиллов — та же, что в HUD. */
function renderBinds(app: App, body: HTMLElement): void {
  body.append(mk('h4', 'margin:12px 0 8px', 'Бинды действий'));
  body.append(buildBindBar(app).el);
  body.append(mk('div', 'font-size:11px;color:#666;margin-top:6px',
    'Клик по слоту → назначить скилл или «Атаку». ЛКМ/ПКМ + доп. слоты Shift/Space/Alt.'));
}

/**
 * Окно ДРЕВА СКИЛОВ (клавиша K): единый холст-граф — из центра ветви расходятся во все
 * стороны (слева боевые/выносливость, справа магия/мана, низ — броня, верх — класс).
 * Прокачка кликом по доступному узлу; бинды действий закреплены снизу.
 */
export const skillsPanel: PanelFactory = (app) => {
  const panel: Panel = {
    title: 'Древо скилов',
    render(body) {
      // Колонка: холст дерева (со своей шапкой очков) → закреплённые бинды.
      const wrap = mk('div', 'display:flex;flex-direction:column;max-height:82vh');
      renderSkillTree(app, wrap);

      const footer = mk('div', `flex:0 0 auto;border-top:1px solid ${COLORS.border};margin-top:8px;padding-top:4px`);
      renderBinds(app, footer);
      wrap.append(footer);

      body.append(wrap);
    },
  };
  return panel;
};
