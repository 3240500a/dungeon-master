import { describeItem, itemOriginNote, slotSuffix, STAT_LABEL, SLOT_LABEL, consumableLines, type Item, type ItemLabels } from '@dm/shared';
import { rarityHex } from '../loot/rarity.js';
import { dmgShort } from '../../core/damageTypes.js';

// Общий форматтер строк живёт в @dm/shared (identical рендер в игре и редакторе). Ре-экспорт подписей
// для обратной совместимости (panels импортит STAT_LABEL).
export { STAT_LABEL, SLOT_LABEL, consumableLines };

/** Динамические резолверы имён (App ставит из живых конфигов). dmgShort — статикой из core. */
export interface ItemLabelResolvers {
  armorClass: (id: string) => string;
  weight: (id: string) => string;
  physSub: (id: string) => string;
  /** Имя активного скилла по id узла (для прока «шанс каста»). */
  skill: (id: string) => string;
  /** Имя ступени по id (`item-tiers`) — для строки происхождения «ступень поднята кузнецом (была «Отличный»)». */
  tierName?: (id: string) => string | undefined;
  /** Стопка сырья: цвет сорта и строки «семья · сорт / откуда / куда / цена» (`materialNote`, materialsModel.ts). */
  materialNote?: (item: Item) => { color: string; lines: string[] } | null;
}
let R: ItemLabels = { armorClass: (id) => id, weight: (id) => id, physSub: (id) => id, skill: (id) => id, dmgShort };
/** Резолверы подсказки, которых нет в общем форматтере (`describeItem` их не знает): происхождение и сырьё. */
let extra: Pick<ItemLabelResolvers, 'tierName' | 'materialNote'> = {};
export function setItemLabelResolvers(r: ItemLabelResolvers): void {
  const { tierName, materialNote, ...labels } = r;
  R = { ...labels, dmgShort };
  extra = { tierName, materialNote };
}

/**
 * ⭐ СТРОКА ПРОИСХОЖДЕНИЯ (предложение «Разбор, сырьё и чары» §15.3): «Куплено в лавке», «Награда за задание», «Стартовый набор»,
 * «Скована кузнецом», «Вещь из прежней версии», «ступень поднята кузнецом (была «Отличный»)» — у всего, что не находка (`itemOriginNote`).
 * Без неё две одинаковые с виду сабли разбирались бы по-разному (купленная — не выше III сорта, без эссенции) без объяснения.
 */
export function originLine(item: Item): string | null {
  return itemOriginNote(item, (id) => extra.tierName?.(id));
}

/** Строки тултипа (только текст) — для обратной совместимости. */
export function itemLines(item: Item): string[] { return describeItem(item, R).map((l) => l.text); }

/**
 * Строки С ПРИЗНАКОМ АФФИКСА — для предпросмотра кузницы: он диффит те же строки, что видит
 * игрок в тултипе, а аффиксы отбрасывает (кузнечное улучшение их не трогает). Свой форматтер
 * там завёл бы второй источник правды, который разошёлся бы на первой правке describeItem.
 */
export function itemDescLines(item: Item): { text: string; affix: boolean }[] { return describeItem(item, R); }

const BASE_COLOR = '#eaeaea';                                    // базовые свойства — белым
const lineColor = (item: Item, affix: boolean): string => (affix ? rarityHex(item.rarity) : BASE_COLOR); // аффиксы — цветом редкости

/** DOM-карточка предмета с тултипом. */
export function itemCard(item: Item, onClick?: () => void): HTMLElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    border: `1px solid ${rarityHex(item.rarity)}`, borderRadius: '6px', padding: '6px 8px', margin: '4px 0',
    cursor: onClick ? 'pointer' : 'default', background: '#171b24',
  } satisfies Partial<CSSStyleDeclaration>);
  const title = document.createElement('div');
  title.textContent = `${item.name}${slotSuffix(item)}`;
  title.style.color = rarityHex(item.rarity);
  title.style.fontWeight = 'bold';
  el.appendChild(title);
  for (const l of describeItem(item, R)) {
    const p = document.createElement('div');
    p.textContent = l.text; p.style.fontSize = '12px'; p.style.color = lineColor(item, l.affix);
    el.appendChild(p);
  }
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/** HTML для тултипа; при `compareTo` показывает, что сейчас надето. */
export function itemTooltipHtml(item: Item, compareTo?: Item | null): string {
  // Стопка сырья — именем цвета СОРТА (металлическая шкала склада), а не редкости: у сырья редкости нет (§15.4).
  const mat = extra.materialNote?.(item) ?? null;
  const color = mat?.color ?? rarityHex(item.rarity);
  const head = `<div style="color:${color};font-weight:bold;margin-bottom:4px">${item.name}${slotSuffix(item)}</div>`;
  const origin = originLine(item);
  const lines = describeItem(item, R).map((l) => `<div style="color:${lineColor(item, l.affix)}">${l.text}</div>`).join('')
    + (mat ? mat.lines.map((l) => `<div style="color:#8f897c">${l}</div>`).join('') : '')
    + (origin ? `<div style="color:#8f897c;font-style:italic;margin-top:3px">${origin}</div>` : '');
  let cmp = '';
  if (compareTo && compareTo.uid !== item.uid) {
    const cLines = describeItem(compareTo, R).map((l) => `<div style="color:#6a655c">${l.text}</div>`).join('');
    cmp = `<div style="margin-top:6px;border-top:1px solid #2b323f;padding-top:4px"><div style="color:#8f897c">Сейчас надето: ${compareTo.name}</div>${cLines}</div>`;
  }
  return head + lines + cmp;
}
