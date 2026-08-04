import { describeItem, slotSuffix, STAT_LABEL, SLOT_LABEL, consumableLines, type Item, type ItemLabels } from '@dm/shared';
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
}
let R: ItemLabels = { armorClass: (id) => id, weight: (id) => id, physSub: (id) => id, skill: (id) => id, dmgShort };
export function setItemLabelResolvers(r: ItemLabelResolvers): void { R = { ...r, dmgShort }; }

/** Строки тултипа (только текст) — для обратной совместимости. */
export function itemLines(item: Item): string[] { return describeItem(item, R).map((l) => l.text); }

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
  const color = rarityHex(item.rarity);
  const head = `<div style="color:${color};font-weight:bold;margin-bottom:4px">${item.name}${slotSuffix(item)}</div>`;
  const lines = describeItem(item, R).map((l) => `<div style="color:${lineColor(item, l.affix)}">${l.text}</div>`).join('');
  let cmp = '';
  if (compareTo && compareTo.uid !== item.uid) {
    const cLines = describeItem(compareTo, R).map((l) => `<div style="color:#6a655c">${l.text}</div>`).join('');
    cmp = `<div style="margin-top:6px;border-top:1px solid #2b323f;padding-top:4px"><div style="color:#8f897c">Сейчас надето: ${compareTo.name}</div>${cLines}</div>`;
  }
  return head + lines + cmp;
}
