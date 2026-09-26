import type { PanelFactory } from '../../ui/domUi.js';
import { itemTooltipHtml } from '../inventory/itemView.js';
import { COLORS, button, mk, tabsBar } from '../../ui/kit.js';
import { shopCategory, type ShopCat } from './shopCats.js';
import { renderShopGrid } from './shopGrid.js';
import { forgeBench } from './forgeBench.js';

/** Модуль вкладки «Ковка» — грузится один раз на страницу, при первом открытии вкладки. */
type CraftTab = typeof import('./forgeCraftTab.js');
let craftTab: CraftTab | null = null;
let craftTabLoading = false;
let craftTabFailed = false;

/**
 * Кузница: диалог из трёх режимов.
 *  • Работа — ВЕРСТАК (`forgeBench.ts`): одна вещь в слоте, починка/улучшение/реролл/разбор
 *    карточками с полной ценой и предпросмотром. Все действия АВТОРИТЕТНЫ на сервере.
 *  • Ковка — оружие из деталей (docs/CRAFT_WEAPONS.md §17): окно `craftPanel` с игровым хозяином и
 *    3D-стендом. Тяжёлое, поэтому грузится динамическим `import()` (`forgeCraftTab.ts`). Пока в конфиге
 *    `balance.craft.live` выключен, сервер ковку отклоняет — и вкладка говорит это, окна не грузя.
 *  • Купить — магазин оружия/брони: 3 вкладки (ближний/дальний бой, броня), сетка «как инвентарь» (см. shopGrid).
 * Режим/вкладка/выбранная вещь живут в замыкании фабрики (переживают перерисовку панели).
 * Зелья — в лавке (shopPanel).
 */
export const forgePanel: PanelFactory = (app, ui) => {
  // Сырьё и журнал кузнеца живут в СУНДУКЕ аккаунта, а его слепок приходит только по запросу: без этой
  // строки кузница, открытая первой, считала бы кошелёк пустым и гасила все кнопки, а ковка — журнал.
  // ⚠ R2-34: запрос ЖДЁТ ответа. Сервер мог не прочесть сундук (база не ответила) — тогда кадра `stash` нет, и
  // без ответа вкладка «Ковка» вечно «листала журнал», а верстак считал сырьё сундука нулём до переоткрытия окна.
  // Отказ или тишина при пустом сундуке — «Сундук не загрузился» с кнопкой повтора.
  let stashLoad: 'wait' | 'failed' | 'done' = 'wait';
  const loadStash = (): void => {
    stashLoad = 'wait';
    void app.request({ cmd: 'stashOpen' }).then((r) => {
      stashLoad = r?.ok ? 'done' : 'failed';
      app.bus.emit('state:changed', {});
    });
  };
  loadStash();
  /** Сундука нет и ждать нечего: запрос отказан, потерян, или ответ пришёл без кадра. */
  const stashLost = (): boolean => !app.stash && stashLoad !== 'wait';
  // ⭐ Инвентарь открывается ВМЕСТЕ с кузницей: на верстак вещь кладут из сумки, и окно без неё
  // бесполезно. `DomUi` держит несколько окон одновременно — своего механизма не нужно.
  ui.openPanel('inventory');
  let mode: 'work' | 'craft' | 'buy' = 'work';
  let tab: ShopCat = 'melee';
  // ⚠ Выбранная вещь живёт ЗДЕСЬ, а не в `render`: тело окна перерисовывается на каждое
  // `state:changed` — то есть на каждую подобранную монету, — и слот очищался бы сам собой.
  let benchUid: string | null = null;
  // Что открыл последний разбор у кузнеца — пока на верстак не положили другую вещь.
  let benchNote = '';
  return {
    title: 'Кузница',
    render(body) {
      const state = app.state!;

      const draw = (): void => {
        body.innerHTML = '';
        const head = mk('div', 'margin-bottom:8px');
        head.innerHTML = `Золото: <b style="color:${COLORS.gold}">${state.save.gold}</b>`;
        body.appendChild(head);

        body.appendChild(tabsBar(
          [['work', '🔨 Работа'], ['craft', '⚒ Ковка'], ['buy', '🛒 Купить']] as const,
          mode, (k) => { mode = k; draw(); }));

        if (mode === 'buy') drawBuy();
        else if (mode === 'craft') drawCraft();
        else {
          // Без сундука верстак считает только сумку — сказать это, а не молча гасить карточки (R2-34).
          if (stashLost()) body.append(lostNote('Сундук не загрузился', 'Сырьё из сундука не учтено — цены ниже видят только сумку.'));
          body.appendChild(forgeBench(app, {
            uid: benchUid, setUid: (u) => { if (u && u !== benchUid) benchNote = ''; benchUid = u; },
            note: benchNote, setNote: (n) => { benchNote = n; },
          }));
        }
      };

      const note = (title: string, sub: string): HTMLElement => {
        const box = mk('div', `border:1px dashed ${COLORS.border};border-radius:8px;padding:22px;text-align:center`);
        box.append(mk('div', `font-size:14px;color:${COLORS.text}`, title));
        if (sub) box.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-top:6px`, sub));
        return box;
      };
      /** Сундук не пришёл (R2-34): что не так и повтор запроса — окно не нужно закрывать и открывать заново. */
      const lostNote = (title: string, sub: string): HTMLElement => {
        const box = note(title, sub);
        box.style.marginBottom = '10px';
        const row = mk('div', 'margin-top:10px');
        row.append(button('Повторить', () => { loadStash(); draw(); }));
        box.append(row);
        return box;
      };

      const drawCraft = (): void => {
        // D13: пока кузнец закрыт в конфиге, сервер откажет любой ковке — окно даже не грузим.
        if (!app.config.get('balance').craft.live) {
          // R3-11: эскизы копит разбор и при закрытой ковке — сказать, где их потратят, а не обещать в пустоту.
          const sketches = app.stash?.forgeJournal?.sketches ?? 0;
          body.append(note('Кузнец ещё не куёт', 'Ковка из деталей откроется позже. Разбор найденного оружия у кузнеца уже открывает его детали в журнале.'
            + (sketches > 0 ? ` Эскизов: ${sketches} — здесь откроешь ими детали на выбор, когда кузнец начнёт ковать.` : '')));
          return;
        }
        // Журнал приходит с кадром сундука (запрошен при открытии кузницы) — без него всё выглядело бы закрытым.
        // Ответ на запрос пришёл, а журнала нет (отказ, тишина) — не «листать» вечно, а сказать и дать повтор (R2-34).
        if (!app.stash?.forgeJournal) {
          body.append(stashLoad === 'wait' ? note('Кузнец листает журнал…', '')
            : lostNote('Журнал не загрузился', 'Сервер не отдал сундук аккаунта, а без журнала кузнец не знает, что открыто.'));
          return;
        }
        if (craftTab) {
          // Окно ковки читает живой конфиг целиком; сломанная строка данных не должна ронять перерисовку
          // ВСЕХ окон (`DomUi.refresh` идёт по ним подряд) — падает только эта вкладка, с причиной.
          try { craftTab.renderCraftTab(app, body); } catch (e) {
            console.error('[forge] окно ковки не нарисовалось:', e);
            body.append(note('Окно ковки не открылось', e instanceof Error ? e.message : String(e)));
          }
          return;
        }
        if (craftTabFailed) {
          body.append(note('Окно ковки не загрузилось', 'Нет связи с сервером игры? Переключи вкладку, чтобы попробовать ещё раз.'));
          craftTabFailed = false; // следующая перерисовка — новая попытка
          return;
        }
        body.append(note('Кузнец раскладывает инструмент…', ''));
        if (craftTabLoading) return;
        craftTabLoading = true;
        import('./forgeCraftTab.js')
          .then((m) => { craftTab = m; }, () => { craftTabFailed = true; })
          .finally(() => { craftTabLoading = false; app.bus.emit('state:changed', {}); });
      };

      const drawBuy = (): void => {
        body.appendChild(tabsBar(
          [['melee', '⚔ Ближний бой'], ['ranged', '🏹 Дальний бой'], ['armor', '🛡 Броня']] as const,
          tab, (k) => { tab = k; draw(); }));
        const stock = app.shopStock.filter((it) => shopCategory(it) === tab);
        const scroll = mk('div', 'max-height:56vh;overflow-y:auto;padding-right:4px');
        // R2-04: снаряжение — сток героя, он обновляется по сроку `balance.townRestockSec`, а не на каждый заход в город.
        const restockMin = Math.max(1, Math.round(app.config.get('balance').townRestockSec / 60));
        if (stock.length === 0) scroll.append(mk('div', 'color:#666', `Пусто в этой категории — кузнец завозит новый товар раз в ${restockMin} мин.`));
        else scroll.append(renderShopGrid(stock, {
          cols: 11, minRows: 4,
          // R4-37: цена — из кадра сервера (`app.shopPrice`), а не своя по конфигу.
          price: (it) => app.shopPrice(it),
          affordable: (it) => state.save.gold >= app.shopPrice(it),
          onBuy: (it) => app.sendCmd({ cmd: 'buy', uid: it.uid, maxGold: app.shopPrice(it) }),   // R6-16: цена кадра — потолок
          tooltip: (it) => itemTooltipHtml(it, it.slot ? state.save.equipment[it.slot] ?? null : null),
        }));
        body.appendChild(scroll);
        body.append(mk('div', 'font-size:11px;color:#666;margin-top:6px', 'Клик по предмету — купить. Зелья — в лавке.'));
      };

      draw();
    },
  };
};
