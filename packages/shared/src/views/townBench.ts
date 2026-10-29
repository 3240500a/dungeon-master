/**
 * ⭐ ВИД «ВЕРСТАК КУЗНЕЦА» (кузница ▸ 🔨 Работа) — сервером: карточки действий над вещью на верстаке (починка / улучшение, перекатка,
 * зачарование скованной, разбор) с ценой строками, причиной отказа и ПОЛЯМИ СОГЛАСИЯ команды, и предпросмотр «было → станет».
 *
 * Заменяет C# `DmTown.BenchActions`, `BenchPreview` / `BenchTarget` / `BenchTargetLabel` / `DiffStrings` / `BaseLines`, а под ними —
 * `CanRepair`, `RepairCost`, `CanUpgrade`, `UpgradeCost`, `NextTierOf`, `ForgeGold`, `CanReroll`, `RerollMaterials`, `CanEnchant`,
 * `EnchantCost`, `EnchantMaterials`, `CanSalvage`, `SalvagePreviewCard`, `SalvageRange`, `SalvageMean`, `UpgradedItem` (DmTown*.cs) и
 * `DmTown.DisposePrompts(…, "forge")` у клика разбора (ForgePanel.cs). Источник — веб `client/modules/town/forgeActions.ts` + `forgeBench.ts`.
 *
 * ⚠ ЦЕНА = ФАКТ. Каждое число согласия (`gold` → `maxGold`, `materials` → `maxMaterials`, `minYield`, `avgYield`) считает ТА ЖЕ функция
 * @dm/shared, которой сервер исполняет команду (`forgeUpgrade` / `forgeRepair` / `forgeReroll` / `enchantAction` / `forgeSalvage`): клиент
 * копирует их из карточки, и «Цена изменилась» возможна только от правки конфига между видом и командой.
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { CraftJournal } from '../formulas/craft.js';
import type { Item, SaveState } from '../types/index.js';
import {
  STARTER_KNOWN, canEnchantItem, canRepairItem, canRerollItem, canSalvageItem, canUpgradeItem, enchantMaterials, forgeGold, nextTierOf,
  repairCost, rerollMaterials, salvageMean, salvageRange, upgradeCost, upgradedItem,
} from '../economy/townActions.js';
import { availableMaterials, canAffordBoth } from '../economy/materials.js';
import { salvagePreview, type SalvageCardLine } from '../economy/salvagePreview.js';
import { enchantCost } from '../formulas/craft.js';
import { itemDescLines, journalOf, type StashView } from './townItem.js';
import { disposePrompts } from './townSalvage.js';

/** Тон строки карточки: ok — хватает, miss — нет, gain — прибавка, dim — пояснение или причина отказа, warn — оговорка. */
export type LineState = 'ok' | 'miss' | 'gain' | 'dim' | 'warn';
/** C# `DmTown.CostLine`: `label` — подпись строки карточки разбора («Сырьё», «Эссенция», «Каталог», «Эскиз»). */
export interface CostLine { text: string; state: LineState; label?: string }

/** C# `DmTown.BenchAction` (+ `prompts` — вопросы перед разбором; DTO: добавить `public List<string> prompts;`). */
export interface BenchAction {
  id: 'repair' | 'upgrade' | 'reroll' | 'enchant' | 'salvage';
  cmd: 'forgeRepair' | 'forgeUpgrade' | 'forgeReroll' | 'forgeEnchant' | 'forgeSalvage';
  rarity?: 'magic' | 'rare';
  title: string;
  sub: string;
  lines: CostLine[];
  enabled: boolean;
  primary: boolean;
  tip?: string;
  /** → `maxGold`. */
  gold?: number;
  /** → `maxMaterials`. */
  materials?: Record<string, number>;
  /** → `minYield` (разбор). */
  minYield?: Record<string, number>;
  /** → `avgYield` (разбор; исходов больше предела — поля нет). */
  avgYield?: Record<string, number>;
  /** Вопросы перед разбором (`disposePrompts` 'forge': у скованной — два); только у карточки разбора. */
  prompts?: string[];
}

/** Что станет с вещью главным действием — источник предпросмотра: сломанной — починенная, целой — поднятая (если кузнец это делает). */
export function benchTarget(reg: ConfigRegistry, item: Item): Item | undefined {
  if (item.broken) return canRepairItem(reg, item).ok ? { ...item, broken: false } : undefined;
  return canUpgradeItem(reg, item).ok ? upgradedItem(reg, item) : undefined;
}

/** Подпись шапки предпросмотра — тем же ответом, что `benchTarget` и главная карточка (R14-12). */
export function benchTargetLabel(reg: ConfigRegistry, item: Item, target: Item | undefined): string {
  if (item.broken) return target ? 'после починки' : 'кузнец не чинит';
  if (target) return 'после улучшения';
  if (item.parts) return 'скованную поднимает замена детали';
  return nextTierOf(reg, item) ? 'улучшать нечего' : 'улучшать больше некуда';
}

/** Строка «было → станет» (C# кортеж `(was, will)` → DTO `{ was, will }`). */
export interface DiffRow { was: string; will: string }
/** Только изменившиеся строки — выравнивание по LCS; несовпавшие между якорями спариваются по порядку. */
export function diffStrings(a: readonly string[], b: readonly string[]): DiffRow[] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffRow[] = [];
  let was: string[] = [];
  let will: string[] = [];
  const flush = (): void => {
    for (let t = 0; t < Math.max(was.length, will.length); t++) out.push({ was: was[t] ?? '', will: will[t] ?? '' });
    was = []; will = [];
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) { will.push(b[j]!); j++; }
    else { was.push(a[i]!); i++; }
  }
  flush();
  return out;
}

/** Строки описания без аффиксов (кузнечное улучшение аффиксов не трогает — в предпросмотре они шумят). */
export const benchBaseLines = (reg: ConfigRegistry, item: Item): string[] => itemDescLines(reg, item).filter((l) => !l.affix).map((l) => l.text);

/** Предпросмотр верстака (C# кортеж `(label, rows)` → DTO `{ label, rows }`); `rows` пусто — «Кузнец эту вещь не меняет.». */
export interface BenchPreview { label: string; rows: DiffRow[] }
export function benchPreview(reg: ConfigRegistry, item: Item): BenchPreview {
  const target = benchTarget(reg, item);
  return { label: benchTargetLabel(reg, item, target), rows: target ? diffStrings(benchBaseLines(reg, item), benchBaseLines(reg, target)) : [] };
}

function costLines(cost: Record<string, number>, have: Record<string, number>, nameOf: (id: string) => string): CostLine[] {
  return Object.entries(cost).map(([id, n]) => {
    const got = have[id] ?? 0;
    return { text: `${nameOf(id)} ${n} (есть ${got})${got < n ? ' — не хватает' : ''}`, state: got >= n ? 'ok' : 'miss' };
  });
}
const cardLine = (l: SalvageCardLine): CostLine => ({ label: l.label, text: l.text, state: l.tone });

/**
 * ⭐ КАРТОЧКИ ВЕРСТАКА в ФИКСИРОВАННОМ порядке (C# `DmTown.BenchActions`): главное действие (сломанной — починка, целой — улучшение),
 * перекатка, у скованной — зачарование до магической и до редкой, разбор последним. `inventory` — сумка, `stashWallet` — кошелёк сундука
 * (цены — по их сумме, как спишет сервер: `spendBoth`), `journal` — журнал кузнеца (`undefined` — «кадра нет»).
 */
export function benchActions(
  reg: ConfigRegistry, item: Item, gold: number, inventory: readonly Item[], stashWallet: Record<string, number>, journal?: CraftJournal | null,
): BenchAction[] {
  const prices = reg.get('balance').forgePrices;
  const have = availableMaterials(inventory, stashWallet);
  const defs = reg.get('craft-materials');
  const nameOf = (id: string): string => defs.find((m) => m.id === id)?.name ?? id;
  const out: BenchAction[] = [];

  if (item.broken) {
    const can = canRepairItem(reg, item);
    const cost = can.ok ? repairCost(reg, item) : {};
    const price = forgeGold(reg, item, 'repair');
    const goldOk = gold >= price;
    const matsOk = !Object.keys(cost).length || canAffordBoth(inventory, stashWallet, cost);
    out.push({
      id: 'repair', cmd: 'forgeRepair', title: '🔧 Починить', sub: 'снимет «сломано»',
      primary: true, enabled: can.ok && goldOk && matsOk, gold: can.ok ? price : undefined, materials: can.ok ? cost : undefined,
      lines: !can.ok ? [{ text: can.reason ?? 'нельзя', state: 'dim' }] : [
        { text: `${price} золота`, state: goldOk ? 'ok' : 'miss' },
        ...costLines(cost, have, nameOf),
      ],
    });
  } else {
    const can = canUpgradeItem(reg, item);
    const cost = can.ok ? upgradeCost(reg, item) : {};
    const nt = nextTierOf(reg, item);
    const price = forgeGold(reg, item, 'upgrade');
    const goldOk = gold >= price;
    out.push({
      id: 'upgrade', cmd: 'forgeUpgrade', title: '🔨 Улучшить',
      sub: item.parts ? 'скованная вещь' : !nt ? 'вещь на потолке' : can.ok ? `до «${nt.name}»` : 'кузнец не поднимает',
      primary: true,
      enabled: can.ok && goldOk && canAffordBoth(inventory, stashWallet, cost),
      gold: can.ok ? price : undefined, materials: can.ok ? cost : undefined,
      tip: can.ok ? 'Кузнечная вещь требует меньше атрибутов, чем найденная того же тира' : undefined,
      lines: !can.ok ? [{ text: can.reason ?? 'нельзя', state: 'dim' }]
        : [{ text: `${price} золота`, state: goldOk ? 'ok' : 'miss' }, ...costLines(cost, have, nameOf)],
    });
  }

  const left = Math.max(0, prices.rerollLimit - (item.rerolls ?? 0));
  const rr = canRerollItem(reg, item);
  const rrPrice = forgeGold(reg, item, 'reroll');
  const rrGold = gold >= rrPrice;
  const rrMats = rr.ok ? rerollMaterials(reg, item) : {};
  out.push({
    id: 'reroll', cmd: 'forgeReroll', title: '🎲 Реролл', sub: `осталось ${left} из ${prices.rerollLimit}`,
    primary: false, enabled: rr.ok && rrGold && canAffordBoth(inventory, stashWallet, rrMats),
    gold: rr.ok ? rrPrice : undefined, materials: rr.ok ? rrMats : undefined,
    lines: !rr.ok ? [{ text: rr.reason ?? 'нельзя', state: 'dim' }]
      : [{ text: `${rrPrice} золота`, state: rrGold ? 'ok' : 'miss' }, ...costLines(rrMats, have, nameOf), { text: 'перекатит аффиксы', state: 'dim' }],
  });

  if (item.parts) {
    const live = reg.get('balance').craft.live;
    for (const rarity of ['magic', 'rare'] as const) {
      const can = canEnchantItem(reg, item, rarity);
      const price = enchantCost(reg, item, rarity);
      const goldOk = gold >= price;
      const why = !live ? 'Кузнец ещё не зачаровывает' : can.ok ? undefined : can.reason ?? 'нельзя';
      const ess = why ? {} : enchantMaterials(reg, item, rarity);
      out.push({
        id: 'enchant', cmd: 'forgeEnchant', rarity, title: rarity === 'magic' ? '✦ Магический' : '✦ Редкий',
        sub: rarity === 'magic' ? 'зачаровать до магической' : 'зачаровать до редкой',
        primary: false, enabled: !why && goldOk && canAffordBoth(inventory, stashWallet, ess),
        gold: why ? undefined : price, materials: why ? undefined : ess,
        lines: why ? [{ text: why, state: 'dim' }]
          : [{ text: `${price} золота`, state: goldOk ? 'ok' : 'miss' }, ...costLines(ess, have, nameOf), { text: 'свойства по форме вещи', state: 'dim' }],
      });
    }
  }

  const can = canSalvageItem(reg, item, false, journal);
  const card = salvagePreview(reg, item, journal ?? null, false);
  const rng = salvageRange(reg, item, false);
  const four = [card.materials, card.essence, ...(card.catalog ? [card.catalog] : []), ...(card.sketch ? [card.sketch] : [])].map(cardLine);
  out.push({
    id: 'salvage', cmd: 'forgeSalvage', title: card.verb === 'melt' ? '♻ Переплавить' : '♻ Разобрать', sub: 'вещь исчезнет',
    primary: false, enabled: can.ok,
    minYield: can.ok ? Object.fromEntries(Object.entries(rng.range).map(([id, r]) => [id, r.min])) : undefined,
    avgYield: (can.ok && salvageMean(reg, item, false)) || undefined,
    lines: can.ok ? four
      : [{ text: can.reason ?? 'нельзя', state: 'dim' }, ...(can.reason === STARTER_KNOWN && card.catalog ? [cardLine(card.catalog)] : [])],
    prompts: disposePrompts(reg, item, 'forge', journal),
  });
  return dropUndefined(out);
}

/** JSON без `undefined`-полей (как `JSON.stringify`): вид сравнивается с эталоном и уходит по проводу одинаково. */
function dropUndefined<T extends object>(list: T[]): T[] {
  return list.map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as T);
}

/** Вкладка «🔨 Работа» с вещью на верстаке (новый DTO `ForgeBenchView`). */
export interface ForgeBenchView {
  uid: string;
  preview: BenchPreview;
  actions: BenchAction[];
  /**
   * Сделка, которую игрок должен был додумать сам: у сломанной вещи, которую можно и починить, и разобрать, — «Починить за N и носить —
   * или разобрать…» (C# ForgePanel строит её сам из `ForgeGold(…, "repair")`); иначе `null`.
   */
  deal: string | null;
}
/**
 * ⭐ ВЕРСТАК ЦЕЛИКОМ для вещи `uid` из сумки героя (`save.inventory`): золото — `save.gold`, сырьё — сумка + кошелёк сундука, журнал —
 * журнал сундука. Вещи нет в сумке — `null` (верстак пустеет). `stash` = `null` — сундука нет: сырьё только из сумки, стартовый набор
 * откажет сервер (как у C# без кадра сундука).
 */
export function forgeBenchView(reg: ConfigRegistry, save: SaveState, stash: StashView, uid: string): ForgeBenchView | null {
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return null;
  const actions = benchActions(reg, item, save.gold, save.inventory, stash?.materials ?? {}, journalOf(stash));
  const deal = item.broken && actions.some((a) => a.id === 'salvage' && a.enabled)
    ? `Починить за ${forgeGold(reg, item, 'repair')} и носить — или разобрать и забрать сырьё. Улучшать можно только починенное.`
    : null;
  return { uid, preview: benchPreview(reg, item), actions, deal };
}
