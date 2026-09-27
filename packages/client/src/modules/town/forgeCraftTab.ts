import { anatomyOf } from '@dm/shared';
import type { App } from '../../core/app.js';
import { COLORS, mk } from '../../ui/kit.js';
import { craftWindow, initialCraftState, type CraftWindowState } from './craftPanel.js';
import { gameCraftHost } from './craftHost.js';
import { resumePreview3d, weaponPreview3d } from './craftPreview3d.js';
import { craftMeshConfigVersion } from './craftMesh/configVersion.js';

/**
 * ВКЛАДКА «КОВКА» КУЗНИЦЫ ГОРОДА — окно ковки (`craftPanel.ts`) с игровым хозяином (`craftHost.ts`)
 * и 3D-стендом сборки рядом. Модуль ТЯЖЁЛЫЙ (окно, three и `craftMesh` ≈ 5.6 тыс. строк), поэтому
 * `forgePanel.ts` грузит его динамическим `import()` при первом открытии вкладки, а не на старте игры.
 *
 * Состояние окна (выбор деталей, скованная вещь, «куём…») живёт ЗДЕСЬ, на уровне модуля: тело кузницы
 * перерисовывается на каждый кадр сейва, а закрыть и открыть кузницу — не повод терять сборку.
 *
 * ⭐ R7-22: но оно ЧЬЁ-ТО — аккаунта и героя (`owner`). Страница без перезагрузки входит другим аккаунтом или героем
 * (R4-22 / R5-17), и новый видел строку прежнего «Скована: … бросок N %» (имя его вещи, бросок) и его сборку: `App`
 * забывал сундук, прилавок и доску (`forgetSession`), а это окно — нет. Другой владелец — окно с чистого листа.
 */

let st: CraftWindowState | null = null;
/** R7-22: чьё окно — `userId|charId`; другой — состояние прочь. */
let owner = '';
/**
 * Стенд последней сборки: одинаковую сборку заново не строим — модель мигала бы на каждый кадр сейва. В ключе и
 * версия конфига модели: правка детали (конфиг сервера, live-apply редактора) приходит в тот же реестр (R1-22).
 */
let stand: { key: string; el: HTMLElement } | null = null;

/** Размер стенда в окне кузницы — уже, чем колонка песочницы редактора. */
const STAND = { width: 200, height: 340 };

/** Первое открытие — класс того, что в руках (если его куют), иначе меч. */
function startClass(app: App): string {
  const cls = app.state?.save.equipment.weapon?.weaponClass;
  return cls && anatomyOf(app.config, cls) ? cls : 'sword';
}

export function renderCraftTab(app: App, body: HTMLElement): void {
  const reg = app.config;
  const who = `${app.auth?.userId ?? ''}|${app.state?.save.charId ?? ''}`;
  if (who !== owner) { st = null; owner = who; }
  if (!st) st = initialCraftState(reg, startClass(app));
  const row = mk('div', 'display:flex;gap:10px;align-items:flex-start');
  const winBox = mk('div', 'flex:1;min-width:0');
  const side = mk('div', `flex:0 0 ${STAND.width + 18}px`);
  const show3d = (w: CraftWindowState): void => {
    const key = JSON.stringify([craftMeshConfigVersion(reg), w.weaponClass, w.hands, w.parts]);
    if (stand?.key !== key) {
      let el: HTMLElement;
      // Стенд — украшение: сломался (нет WebGL, деталь без модели) — окно ковки работает и без него.
      try { el = weaponPreview3d(reg, w, STAND); } catch { el = mk('div', `color:${COLORS.dim};font-size:11px`, 'Модель сборки не строится'); }
      stand = { key, el };
    }
    if (stand.el.parentElement !== side) side.replaceChildren(stand.el);
    resumePreview3d();
  };
  // После ответа сервера — перерисовать всю кузницу: новый сейв уже пришёл, а окно ждало только итога.
  winBox.append(craftWindow(app, gameCraftHost(app), st, () => app.bus.emit('state:changed', {}), show3d));
  row.append(winBox, side);
  body.append(row);
  resumePreview3d(); // стенд снова на странице (перерисовка, возврат на вкладку) — зажечь цикл
}
