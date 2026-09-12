import type { App } from '../../core/app.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';
import { CELL, GAP } from './heldItem.js';
import { carriedMaterials } from '@dm/shared';

/**
 * СКЛАД МАТЕРИАЛОВ — вторая вкладка панели инвентаря, В ТОМ ЖЕ месте, что и сетка вещей.
 *
 * Материалы ХРАНЯТСЯ кошельком (`SaveState.materials`), а не предметами: стекирования в игре нет
 * нигде, и сетка 10×6 забилась бы за один забег. Но ВЫГЛЯДЕТЬ они обязаны складом — иначе награда,
 * которая теперь составляет основной поток добычи, для игрока просто невидима (docs/ECONOMY.md, Ч1).
 *
 * ⚠ Рисуем ВСЕ материалы конфига, а не только имеющиеся: склад с пустыми ячейками показывает,
 * что вообще бывает и чего не хватает. Показывай мы только ненулевые — новый персонаж видел бы
 * пустое место и не понял бы, что кошелёк вообще есть.
 *
 * Раскладка — строка на семью, столбец на ступень, и столбец подписан РЕДКОСТЬЮ: ступень материала
 * задаёт редкость вещи, с которой он падает, и она же решает, какую вещь им можно улучшить.
 * Клетка ростом с клетку инвентаря (`CELL`), чтобы вкладки не прыгали.
 */

/** Цвет по ступени: 1 — сталь, 2 — синева, 3 — латунь. Пока иконок нет, цвет и есть опознание. */
const TIER_HEX = ['#9aa6b2', '#7fb6e0', '#d0a24a'];

/**
 * ⭐ Главное, что подпись обязана объяснить: ступень материала = РЕДКОСТЬ вещи, с которой он падает,
 * и она же решает, какую вещь этим материалом можно улучшить. Без этой строки склад выглядит
 * как «три непонятные колонки», и связь «жёлтая вещь → калёная сталь → улучшение жёлтых» не видна.
 */
const NEEDED_FOR: Record<number, string> = {
  1: 'Падает с обычных вещей. Нужен для улучшения ЛЮБЫХ.',
  2: 'Падает с магических. Нужен для улучшения магических и редких.',
  3: 'Падает с редких. Нужен для улучшения редких.',
};

/** Человеческое имя семьи: в конфиге у неё только id. */
const FAMILY_LABEL: Record<string, string> = {
  iron: 'Железо',
  wood: 'Дерево',
  cloth: 'Ткань',
  hide: 'Кожа',
  plate: 'Пластины',
};

/**
 * @param stashWallet сырьё СУНДУКА аккаунта (общее для всех героев). Не передано — показываем
 *        только то, что игрок несёт в сумке: панель инвентаря в забеге сундука не видит.
 */
export function materialsView(app: App, stashWallet?: Record<string, number>): HTMLElement {
  const wallet = stashWallet ?? {};
  const carried = carriedMaterials(app.state!.save.inventory);
  const defs = app.config.get('craft-materials').filter((d) => d.enabled);

  const box = mk('div');
  if (defs.length === 0) { // конфиг ещё не доехал (старый сервер) — говорим прямо, а не молчим
    box.append(mk('div', 'font-size:12px;color:#666', 'Материалы не настроены в конфиге.'));
    return box;
  }

  // Порядок семей — как они впервые встречаются в конфиге: склад не должен прыгать между открытиями.
  const families: string[] = [];
  for (const d of defs) if (!families.includes(d.family)) families.push(d.family);

  const grid = mk('div', `display:flex;flex-direction:column;gap:${GAP}px`);

  // Шапка столбцов: она и есть ответ на «почему три колонки» — каждая отвечает своей редкости.
  const head = mk('div', `display:flex;align-items:center;gap:${GAP}px;margin-bottom:2px`);
  head.append(mk('div', 'width:72px'));
  for (const [i, label] of ['обычные', 'магические', 'редкие'].entries()) {
    head.append(mk('div', `width:72px;text-align:center;font-size:10px;color:${TIER_HEX[i]}99`, label));
  }
  grid.append(head);

  for (const fam of families) {
    const row = mk('div', `display:flex;align-items:center;gap:${GAP}px`);
    row.append(mk('div', `width:72px;font-size:11px;color:${COLORS.dim};text-align:right;padding-right:4px`,
      FAMILY_LABEL[fam] ?? fam));
    for (const d of defs.filter((x) => x.family === fam).sort((a, b) => a.tier - b.tier)) {
      // ⭐ Две цифры в клетке: сколько лежит в сундуке и сколько НЕСЁШЬ. Несомое под угрозой
      // смерти, и игрок должен видеть это, не открывая инвентарь.
      const inStash = wallet[d.id] ?? 0;
      const onHand = carried[d.id] ?? 0;
      const have = inStash + onHand;
      const hex = TIER_HEX[Math.min(TIER_HEX.length, Math.max(1, d.tier)) - 1]!;
      const cell = mk('div',
        `width:72px;height:${CELL}px;box-sizing:border-box;border-radius:6px;` +
        `display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;` +
        `background:${COLORS.panel2};border:1px solid ${have > 0 ? `${hex}88` : COLORS.border};` +
        `color:${have > 0 ? hex : '#4a4a4a'}`);
      cell.append(mk('span', `width:9px;height:9px;border-radius:2px;display:inline-block;background:${have > 0 ? hex : '#3a3a3a'}`));
      cell.append(mk('b', '', String(inStash)));
      if (onHand > 0) cell.append(mk('span', 'font-size:10px;color:#7fd07f', `+${onHand}`));
      attachTooltip(cell, () =>
        `<b style="color:${hex}">${d.name}</b><br>В сундуке ${inStash}`
        + (onHand > 0 ? `<br><span style="color:#7fd07f">В сумке ${onHand} — потеряешь часть при смерти</span>` : '') +
        `<br>${NEEDED_FOR[d.tier] ?? ''}` +
        (d.sellPrice > 0 ? `<br>Продажа: ${d.sellPrice} за штуку` : ''));
      row.append(cell);
    }
    grid.append(row);
  }
  box.append(grid);
  return box;
}

/** Сколько всего материалов в кошельке — для подписи на вкладке. */
export function materialsTotal(app: App): number {
  // С ч7 сырьё в сейве больше не хранится: считаем ТО, ЧТО ИГРОК НЕСЁТ в сумке.
  return Object.values(carriedMaterials(app.state!.save.inventory)).reduce((a, b) => a + b, 0);
}
