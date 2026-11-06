/**
 * ⭐ ВИД «ВЕЩЬ» — сервером: подсказка вещи (строки `describeItem`, подсказка стопки сырья, строка происхождения, сравнение с надетым),
 * подпись клетки сетки, меню сумки (ПКМ) и решение пупсика (куда ляжет вещь с курсора).
 *
 * Заменяет C#: `DmItem.Describe` / `DmItem.Tooltip` (модель, без rich-text), `DmItem.GridGlyph` / `IconGlyph`, `DmTown.ItemMenu`,
 * `DmTown.EquipRefusal` / `OffhandRefusal` / `PaperdollEquip`. Источники — веб `itemView.ts` (резолверы `App.refreshLabelResolvers`),
 * `heldItem.ts` (`glyphOf`), `inventoryPanel.ts` (`itemMenu`), `inventory/equip.ts` (`paperdollEquip`); правила — @dm/shared
 * (`describeItem`, `itemOriginNote`, `equipRefusal`, `offhandRefusal`) — те же, что исполняет сервер (`equip` → `equipPlan`).
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { AccountStash, EquipSlot, Item, SaveState } from '../types/index.js';
import { describeItem, slotSuffix, type ItemLabels, type ItemLine } from '../formulas/itemDescribe.js';
import { normalizeJournal, type CraftJournal } from '../formulas/craft.js';
import { itemOriginNote } from '../economy/salvagePreview.js';
import { equipRefusal, offhandRefusal } from '../economy/townActions.js';
import { debuffLabel } from '../world/debuffs.js';
import { materialNote } from './townMaterials.js';
import { disposePrompts, fieldSalvageEntry, fieldSalvageLines, salvageConsent, type TipLine } from './townSalvage.js';
import { cfgRowText, tr } from '../i18n/tr.js';
import { itemDisplayName } from '../formulas/itemDisplay.js';

/** Сундук аккаунта, как его видит вид: кошелёк сырья и журнал кузнеца. `null` — сундука нет (кадр не пришёл). */
export type StashView = Pick<AccountStash, 'materials' | 'forgeJournal'> | null | undefined;
/** Журнал кузнеца для правил: сундук есть — его журнал (`normalizeJournal`, как читает сервер); нет — `undefined` («кадра нет»). */
export const journalOf = (stash: StashView): CraftJournal | undefined => (stash ? normalizeJournal(stash.forgeJournal) : undefined);

/**
 * Резолверы подписей `describeItem` из ЖИВОГО конфига — ровно как их ставит клиент (`App.refreshLabelResolvers`): классы брони, веса,
 * физ-подтипы со статусом, имена скилов прока, короткие имена каналов урона (`damage-kinds` physical + `magic-subtypes`). Хват полуторного —
 * умолчание (`DEFAULT_GRIP`): тултип клиента резолвер хвата не ставит.
 */
export function itemLabels(reg: ConfigRegistry): ItemLabels {
  const short = new Map<string, string>();
  const phys = reg.get('damage-kinds').find((k) => k.id === 'physical');
  if (phys) short.set('physical', cfgRowText(reg, 'damage-kinds', phys, 'short'));
  for (const s of reg.get('magic-subtypes')) short.set(s.id, cfgRowText(reg, 'magic-subtypes', s, 'short'));
  return {
    // ⭐ i18n Ф1 (06.11): имена из конфига — на языке игрока (`cfgRowText` по строке таблицы)
    armorClass: (id) => cfgRowText(reg, 'armor-classes', reg.get('armor-classes').find((c) => c.id === id)) ?? id,
    weight: (id) => (cfgRowText(reg, 'weapon-weights', reg.get('weapon-weights').find((w) => w.id === id)) ?? id).toLowerCase(),
    physSub: (id) => {
      const sub = reg.get('phys-subtypes').find((s) => s.id === id);
      return sub ? `${cfgRowText(reg, 'phys-subtypes', sub).toLowerCase()} → ${debuffLabel(reg.get('debuffs'), sub.kind).toLowerCase()}` : id;
    },
    skill: (id) => cfgRowText(reg, 'skill-tree', reg.get('skill-tree').nodes.find((n) => n.id === id)) ?? id,
    dmgShort: (id) => short.get(id) ?? id,
  };
}

/** Строки описания вещи с признаком аффикса (C# `DmItem.Describe`; кортеж `(text, affix)` → DTO `{ text, affix }`). */
export function itemDescLines(reg: ConfigRegistry, item: Item): ItemLine[] {
  return describeItem(item, itemLabels(reg));
}

/** Глифы слотов клетки сетки (`heldItem.ts` GLYPH). */
export const SLOT_GLYPH: Readonly<Record<string, string>> = {
  get weapon() { return tr('srv:slotGlyph.weapon', 'Ор'); },
  get offhand() { return tr('srv:slotGlyph.offhand', 'Оф'); },
  get helm() { return tr('srv:slotGlyph.helm', 'Шл'); },
  get chest() { return tr('srv:slotGlyph.chest', 'На'); },
  get gloves() { return tr('srv:slotGlyph.gloves', 'Пе'); },
  get boots() { return tr('srv:slotGlyph.boots', 'Са'); },
  get belt() { return tr('srv:slotGlyph.belt', 'По'); },
  get ring() { return tr('srv:slotGlyph.ring', 'Ко'); },
  get amulet() { return tr('srv:slotGlyph.amulet', 'Ам'); },
};
/**
 * Подпись клетки сетки (C# `DmItem.GridGlyph`, веб `glyphOf`): сырьё — числом в стеке, широкая вещь — именем, зелье — 🧪.
 * ⭐ i18n Ф2 (06.11): с реестром имя — на языке игрока (`itemDisplayName`); без — испечённое.
 */
export function glyphOf(item: Item, reg?: ConfigRegistry): string {
  if (item.kind === 'material') return `${item.count ?? 1}`;
  if (item.gridW >= 2) return reg ? itemDisplayName(reg, item) : item.name;
  return item.kind === 'consumable' ? '🧪' : item.slot ? SLOT_GLYPH[item.slot] ?? '·' : '·';
}
/** Значок вещи в ячейке пупсика (C# `DmItem.IconGlyph`). */
export function iconGlyph(item: Item): string {
  return item.kind === 'consumable' ? '🧪' : item.slot ? SLOT_GLYPH[item.slot] ?? '?' : '?';
}

/**
 * Подсказка вещи — МОДЕЛЬ, а не rich-text (C# `DmItem.Tooltip` собирает строку сам): имя и подпись слота, цвет имени у стопки сырья
 * (цвет сорта; `null` — цвет редкости по теме клиента), строки описания (аффикс — цветом редкости), строки стопки сырья, происхождение,
 * сравнение с надетым в её слот (та же вещь — без сравнения). DTO Unity — новый класс `ItemTip` (поля ниже).
 */
export interface ItemTip {
  uid: string;
  name: string;
  /** Подпись слота после имени (« · Шлем»; у расходников пусто). */
  slot: string;
  /** Цвет имени (стопка сырья — цвет сорта); `null` — цвет редкости `rarity`. */
  color: string | null;
  rarity: string;
  glyph: string;
  icon: string;
  lines: ItemLine[];
  /** Строки подсказки стопки сырья (`materialNote`) — серым под описанием; не сырьё — `null`. */
  note: string[] | null;
  /** Строка происхождения («Куплено в лавке», «Ступень поднята кузнецом…»); находка — `null`. */
  origin: string | null;
  /**
   * ⭐ С-аудит (29.10): с чем сравнить — ключ слота пупсика в `ItemTipsView.worn` («Сейчас надето: …» и строки надетого, серым); нет
   * сравнения (слота нет, слот пуст, это и есть надетая вещь) — `null`. Раньше каждая подсказка несла строки надетого целиком (`worn`), и
   * 400 подсказок повторяли одни и те же девять вещей: ответ был вдвое длиннее.
   */
  wornSlot: string | null;
}
/** ⭐ С-аудит (29.10): надетая вещь для сравнения — один раз на слот (`ItemTipsView.worn`). */
export interface WornTip { name: string; lines: ItemLine[] }
/** ⭐ С-аудит (29.10): ответ вида `item/tips` — подсказки по `uid` и надетое, на которое они ссылаются (`ItemTip.wornSlot`). */
export interface ItemTipsView { tips: Record<string, ItemTip>; worn: Record<string, WornTip> }

function tipOf(reg: ConfigRegistry, labels: ItemLabels, item: Item, worn: Item | null | undefined): ItemTip {
  const mat = materialNote(reg, item);
  const tierName = (id: string): string | undefined => cfgRowText(reg, 'item-tiers', reg.get('item-tiers').find((t) => t.id === id));
  return {
    uid: item.uid,
    name: itemDisplayName(reg, item),   // ⭐ i18n Ф2: испечённое имя — на языке игрока
    slot: slotSuffix(item),
    color: mat?.color ?? null,
    rarity: item.rarity,
    glyph: glyphOf(item, reg),
    icon: iconGlyph(item),
    lines: describeItem(item, labels),
    note: mat ? mat.lines : null,
    origin: itemOriginNote(item, tierName),
    wornSlot: worn && worn.uid !== item.uid && item.slot ? item.slot : null,
  };
}
/** Подсказка одной вещи; `worn` — что надето в её слот (`wornFor`): есть и это другая вещь — `wornSlot` = слот вещи. */
export function itemTipView(reg: ConfigRegistry, item: Item, worn?: Item | null): ItemTip {
  return tipOf(reg, itemLabels(reg), item, worn);
}
/** Что надето в слот вещи (C# `DmItem.WornFor`) — для сравнения в подсказке. */
export const wornFor = (save: Pick<SaveState, 'equipment'>, item: Item): Item | null => (item.slot ? save.equipment[item.slot as EquipSlot] ?? null : null);
/**
 * Подсказки пачкой по `uid` (сумка, надетое, сундук, прилавок): у каждой — ссылка на надетое в её слот (`wornSlot`), а само надетое —
 * в `worn`, по разу на слот и только то, на что ссылаются. DTO — `{ tips: Dictionary<string, ItemTip>, worn: Dictionary<string, WornTip> }`.
 */
export function itemTipsView(reg: ConfigRegistry, save: Pick<SaveState, 'equipment'>, items: readonly Item[]): ItemTipsView {
  const labels = itemLabels(reg);
  const worn = new Map<string, WornTip>();
  const tips = items.map((it): [string, ItemTip] => {
    const w = wornFor(save, it);
    const tip = tipOf(reg, labels, it, w);
    if (w && tip.wornSlot !== null && !worn.has(tip.wornSlot)) worn.set(tip.wornSlot, { name: itemDisplayName(reg, w), lines: describeItem(w, labels) });
    return [it.uid, tip];
  });
  return { tips: Object.fromEntries(tips), worn: Object.fromEntries(worn) };
}

/**
 * Пункт меню сумки (C# `DmTown.MenuItem`): `act` — drink | belt | equip | drop | salvage; `null` — пункт-пояснение серым. У пункта
 * разбора — подсказка-карточка (`tip`), а у живого — ещё вопросы перед разбором (`prompts`) и готовая команда с согласием (`command`).
 * DTO: `tip` — `List<TipLine>` вместо кортежей; новые поля `prompts` (`List<string>`) и `command` (`JObject`).
 */
export interface MenuItem {
  label: string;
  act: 'drink' | 'belt' | 'equip' | 'drop' | 'salvage' | null;
  tip?: TipLine[];
  prompts?: string[];
  command?: { cmd: 'salvage'; uid: string; minYield: Record<string, number>; avgYield?: Record<string, number> };
}

/**
 * ⭐ МЕНЮ ВЕЩИ СУМКИ (C# `DmTown.ItemMenu`): зелье — «Выпить» / «В пояс»; сломанное — «Сломано — к кузнецу»; носимое — «Надеть» или почему
 * нельзя (`equipRefusal` — то, чем откажет `equip`); «Выбросить»; вне города — пункт разбора (`fieldSalvageEntry`) с карточкой разбора в
 * поле подсказкой. Вещи нет в сумке — пусто. `inTown` — герой в городе (у сервера — `area`).
 */
export function itemMenuView(reg: ConfigRegistry, save: SaveState, stash: StashView, uid: string, inTown: boolean): MenuItem[] {
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return [];
  const journal = journalOf(stash);
  const out: MenuItem[] = [];
  if (item.kind === 'consumable') out.push({ label: tr('srv:item.menuDrink', 'Выпить'), act: 'drink' }, { label: tr('srv:item.menuBelt', 'В пояс'), act: 'belt' });
  else if (item.broken) out.push({ label: tr('srv:item.menuBroken', 'Сломано — к кузнецу'), act: null });
  else if (item.slot) {
    const wear = equipRefusal(reg, save, item.uid);
    out.push(wear ? { label: tr('srv:item.menuNoWear', 'Надеть нельзя: {wear}', { wear }), act: null } : { label: tr('srv:item.menuWear', 'Надеть'), act: 'equip' });
  }
  out.push({ label: tr('srv:item.menuDrop', 'Выбросить'), act: 'drop' });
  const entry = inTown ? null : fieldSalvageEntry(reg, save.inventory, item);
  if (entry) {
    const m: MenuItem = { label: entry.label, act: entry.ok ? 'salvage' : null, tip: fieldSalvageLines(reg, item, journal ?? null, entry.reason) };
    if (entry.ok) {
      m.prompts = disposePrompts(reg, item, 'field', journal);
      m.command = { cmd: 'salvage', uid: item.uid, ...salvageConsent(reg, item, true) };
    }
    out.push(m);
  }
  return out;
}

/** Решение пупсика (C# кортеж `(refusal, target)` → DTO `{ refusal, target }`): отказ — вещь остаётся на курсоре; иначе `equip` с целью. */
export interface EquipVerdict { refusal: string | null; target: 'offhand' | null }
/**
 * ⭐ R11-02, R16-08: ВЕЩЬ С КУРСОРА В ЯЧЕЙКУ `cell` (C# `DmTown.PaperdollEquip`, веб `paperdollEquip`): вторая рука — по `offhandRefusal`,
 * прочая ячейка — только родной слот; дальше — `equipRefusal` (требования после смены, место под снятое) — то же, что исполнит `equip`.
 * `item` — вещь с курсора (обычно из сумки; не из сумки — «Предмет не в инвентаре», как скажет сервер).
 */
export function paperdollEquipView(reg: ConfigRegistry, save: SaveState, item: Item, cell: EquipSlot): EquipVerdict {
  let target: 'offhand' | null = null;
  if (cell === 'offhand') {
    const no = offhandRefusal(item, save.equipment.weapon);
    if (no) return { refusal: no, target: null };
    target = 'offhand';
  } else if (item.slot !== cell) return { refusal: tr('srv:equip.wrongSlot', 'Этот предмет не для этого слота'), target: null };
  return { refusal: equipRefusal(reg, save, item.uid, target ?? undefined), target };
}
