/**
 * ⭐ ВИД «РАЗБОР И ВОПРОСЫ ПЕРЕД ИСЧЕЗНОВЕНИЕМ ВЕЩИ» — сервером: пункт «Разобрать здесь» меню сумки с подсказкой-карточкой, вопросы
 * перед разбором и продажей, согласие разбора (`minYield` / `avgYield`).
 *
 * Заменяет C# `DmTown.FieldSalvageEntry`, `FieldSalvageLines`, `DisposePrompts`, `JournalGainsOf`, а для команды — `SalvageRange` /
 * `SalvageMean` (InventoryPanel.SalvageInField). Источник — веб `client/modules/inventory/disposeConfirm.ts`; правила под ним —
 * @dm/shared (`canSalvageItem`, `fieldSalvageFits`, `salvagePreview`, `salvageJournalGains`, `salvageRange`, `salvageMean`) — те же,
 * которыми сервер разбирает (`fieldSalvage` / `forgeSalvage` → `yieldDropped`): согласие, скопированное из вида, = факт.
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { Item } from '../types/index.js';
import type { CraftJournal } from '../formulas/craft.js';
import {
  fieldSalvageFullText, canSalvageItem, fieldSalvageFits, salvageMean, salvageRange,
} from '../economy/townActions.js';
import { salvageJournalGains, salvagePreview, type SalvageCardLine } from '../economy/salvagePreview.js';
import { tr } from '../i18n/tr.js';
import { itemDisplayName } from '../formulas/itemDisplay.js';

/** Строка подсказки (C# сейчас — кортеж `(string text, string tone)`; DTO: класс `{ text, tone }`). tone: title | gain | dim | warn | hint. */
export interface TipLine { text: string; tone: SalvageCardLine['tone'] | 'title' | 'hint' }

/** Что добавил бы в каталог разбор у кузнеца (`salvageJournalGains`) — строками; журнала нет — как пустой. */
export function journalGainsOf(reg: ConfigRegistry, item: Item, journal: CraftJournal | null | undefined): string[] {
  return salvageJournalGains(reg, item, journal);
}

/**
 * Карточка разбора В ПОЛЕ строками — подсказка пункта «Разобрать здесь (30 %)» (C# `FieldSalvageLines`). `refusal` — то, чего карточка
 * сама не знает (сумка полна): причина после заголовка и карточка целиком; разбор невозможен вовсе — заголовок и причина.
 */
export function fieldSalvageLines(reg: ConfigRegistry, item: Item, journal: CraftJournal | null | undefined, refusal?: string): TipLine[] {
  const c = salvagePreview(reg, item, journal, true);
  const line = (l: SalvageCardLine): TipLine => ({ text: `${l.label}: ${l.text}`, tone: l.tone });
  const no = c.verb === 'melt' ? tr('srv:salvage.meltNo', 'Переплавить нельзя') : tr('srv:salvage.salvageNo', 'Разобрать нельзя');
  if (!c.ok) return [{ text: no, tone: 'title' }, { text: c.reason ?? refusal ?? tr('srv:bench.cannot', 'нельзя'), tone: 'warn' }];
  return [
    { text: refusal ? no : c.title, tone: 'title' },
    ...(refusal ? [{ text: refusal, tone: 'warn' as const }] : []),
    line(c.materials),
    line(c.essence),
    ...(c.catalog ? [line(c.catalog)] : []),
    ...(c.sketch ? [line(c.sketch)] : []),
    ...(c.hint ? [{ text: c.hint[0]!.toUpperCase() + c.hint.slice(1), tone: 'hint' as const }] : []),
  ];
}

/** Пункт разбора меню в поле (C# кортеж `(label, ok, reason)`); зелья и сырьё — `null` (разбор к ним не относится). */
export interface FieldSalvageEntry { label: string; ok: boolean; reason?: string }
export function fieldSalvageEntry(reg: ConfigRegistry, inventory: readonly Item[], item: Item): FieldSalvageEntry | null {
  if (item.kind === 'consumable' || item.kind === 'material') return null;
  const can = canSalvageItem(reg, item, true);
  if (!can.ok) {
    const reason = can.reason ?? tr('srv:salvage.nothingToSalvage', 'Эту вещь не из чего разбирать');
    return { label: tr('srv:salvage.fieldNo', 'Разобрать нельзя: {reason}', { reason }), ok: false, reason };
  }
  if (!fieldSalvageFits(reg, inventory, item)) return { label: tr('srv:salvage.fieldNoRoom', 'Разобрать нельзя: сумка полна'), ok: false, reason: fieldSalvageFullText() };
  return { label: tr('srv:salvage.fieldHere', 'Разобрать здесь ({pct} %)', { pct: Math.round(reg.get('balance').salvage.fieldYield * 100) }), ok: true };
}

export type DisposeAct = 'field' | 'forge' | 'sell';
/**
 * ⭐ ВОПРОСЫ ПРЕЖДЕ, ЧЕМ ВЕЩЬ ИСЧЕЗНЕТ (C# `DisposePrompts`): скованная — два; вещь, которую кузнец записал бы в каталог, в поле и в
 * лавке — один; у кузнеца — ни одного. `price` — цена скупки (лавка).
 */
export function disposePrompts(reg: ConfigRegistry, item: Item, act: DisposeAct, journal: CraftJournal | null | undefined, price?: number): string[] {
  const out: string[] = [];
  const priced = price !== undefined ? tr('srv:salvage.pricedFor', ' за {price} золота', { price }) : '';
  const name = itemDisplayName(reg, item);   // ⭐ i18n Ф2 (06.11): испечённое имя — на языке игрока
  if (item.parts) {
    out.push(
      act === 'sell' ? tr('srv:salvage.promptSellCrafted', 'Продать скованную «{name}»{priced}? Скованное лавочник берёт как любую вещь.', { name, priced })
      : act === 'field' ? tr('srv:salvage.promptFieldCrafted', 'Переплавить скованную «{name}» прямо здесь? В поле вернётся лишь малая доля сырья.', { name })
      : tr('srv:salvage.promptMeltCrafted', 'Переплавить скованную «{name}»? Кузнец вернёт лишь часть сырья, доводка не вернётся.', { name }),
      tr('srv:salvage.promptSure', 'Точно? «{name}» исчезнет навсегда — скованную вещь не вернуть.', { name }),
    );
  }
  if (act !== 'forge') {
    const gains = journalGainsOf(reg, item, journal);
    if (gains.length) {
      out.push(act === 'field'
        ? tr('srv:salvage.promptFieldGains', 'Разбор в поле журнал кузнеца не пополняет, а у кузнеца эта вещь дала бы:\n({gains})\nЗасчитывает только разбор у кузнеца в городе. Разобрать здесь всё равно?', { gains: gains.join(', ') })
        : tr('srv:salvage.promptSellGains', 'Продажа журнал кузнеца не пополняет, а разбор у кузнеца дал бы:\n({gains})\nПродать «{name}»{priced} всё равно?', { gains: gains.join(', '), name, priced }));
    }
  }
  return out;
}

/** Согласие разбора: низ вилки (`minYield`) и средний выход (`avgYield`; исходов больше предела — поля нет). Сервер сверит тем же (`yieldDropped`). */
export interface SalvageConsent { minYield: Record<string, number>; avgYield?: Record<string, number> }
export function salvageConsent(reg: ConfigRegistry, item: Item, inField: boolean): SalvageConsent {
  const minYield = Object.fromEntries(Object.entries(salvageRange(reg, item, inField).range).map(([id, r]) => [id, r.min]));
  const avg = salvageMean(reg, item, inField);
  return { minYield, ...(avg ? { avgYield: avg } : {}) };
}
