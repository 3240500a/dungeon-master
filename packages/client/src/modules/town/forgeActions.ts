import {
  upgradeCost, repairCost, upgradedItem, salvageRange, canSalvageItem, canAffordBoth,
  availableMaterials, nextTierOf, type ConfigRegistry, type Item,
} from '@dm/shared';

/**
 * ЧТО КУЗНЕЦ ПРЕДЛАГАЕТ ДЕЛАТЬ С ВЕЩЬЮ — чистое решение, без единой строки DOM.
 *
 * Здесь живёт вся логика верстака: какое действие главное, что доступно, сколько стоит и чего
 * не хватает. `forgeBench.ts` рядом только рисует полученный список. Разделение не косметическое:
 * в node-прогоне DOM недоступен, и без него правило «сломанной вещи главное — починка» осталось бы
 * непроверяемым, а это ровно то, что игрок видит первым.
 */

export type LineState = 'ok' | 'miss' | 'gain' | 'dim';
export interface CostLine { text: string; state: LineState }

export interface BenchAction {
  id: 'repair' | 'upgrade' | 'reroll' | 'salvage';
  cmd: 'forgeRepair' | 'forgeUpgrade' | 'forgeReroll' | 'forgeSalvage';
  title: string;
  sub: string;
  lines: CostLine[];
  enabled: boolean;
  /** Главное действие для ЭТОГО состояния вещи — всегда первое в списке. */
  primary: boolean;
  tip?: string;
}

/**
 * ЧТО СТАНЕТ С ВЕЩЬЮ, если применить к ней главное действие, — источник предпросмотра.
 * Сломанной главное — починка (статы от неё не меняются, меняется «надеть нельзя → можно»),
 * целой — улучшение. `undefined` — менять нечего.
 */
export function benchTarget(reg: ConfigRegistry, item: Item): Item | undefined {
  return item.broken ? { ...item, broken: false } : upgradedItem(reg, item);
}

/**
 * Диффер строк описания: показываем ТОЛЬКО то, что изменилось.
 *
 * Работает на готовых строках, а не на статах, намеренно — предпросмотр обязан говорить ровно
 * теми же словами, что тултип вещи, иначе окно спорит само с собой.
 */
export function diffStrings(a: readonly string[], b: readonly string[]): { was: string; will: string }[] {
  const out: { was: string; will: string }[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const was = a[i] ?? '';
    const will = b[i] ?? '';
    if (was !== will) out.push({ was, will });
  }
  return out;
}

/** Строка цены с отметкой «хватает / не хватает» — вместо серой кнопки без объяснения. */
function costLines(
  cost: Record<string, number>,
  have: Record<string, number>,
  nameOf: (id: string) => string,
): CostLine[] {
  return Object.entries(cost).map(([id, n]) => {
    const got = have[id] ?? 0;
    return { text: `${nameOf(id)} ${n}${got < n ? ` (есть ${got})` : ''}`, state: got >= n ? 'ok' : 'miss' };
  });
}

/**
 * Три карточки в ФИКСИРОВАННОМ порядке: главное действие, реролл, разбор.
 *
 * ⚠ Первая карточка не меняет МЕСТА, только смысл: целой вещи «Улучшить», сломанной «Починить».
 * Кнопки не прыгают под курсором, а какое действие сейчас главное — решает сама вещь.
 * ⚠ Разбор всегда последний: он уничтожает вещь, и ему нечего делать рядом с главным действием.
 */
export function benchActions(
  reg: ConfigRegistry,
  item: Item,
  gold: number,
  inventory: readonly Item[],
  stashWallet: Record<string, number>,
): BenchAction[] {
  const prices = reg.get('balance').forgePrices;
  const have = availableMaterials(inventory, stashWallet);
  const defs = reg.get('craft-materials');
  const nameOf = (id: string): string => defs.find((m) => m.id === id)?.name ?? id;
  const out: BenchAction[] = [];

  if (item.broken) {
    const cost = repairCost(reg, item);
    const goldOk = gold >= prices.repairBroken;
    const matsOk = !Object.keys(cost).length || canAffordBoth(inventory, stashWallet, cost);
    out.push({
      id: 'repair', cmd: 'forgeRepair', title: '🔧 Починить', sub: 'снимет «сломано»',
      primary: true, enabled: goldOk && matsOk,
      lines: [
        { text: `${prices.repairBroken} золота`, state: goldOk ? 'ok' : 'miss' },
        ...costLines(cost, have, nameOf),
      ],
    });
  } else {
    const cost = upgradeCost(reg, item);
    const nt = nextTierOf(reg, item);
    const goldOk = gold >= prices.upgradeTier;
    const known = Object.keys(cost).length > 0;
    out.push({
      id: 'upgrade', cmd: 'forgeUpgrade', title: '🔨 Улучшить',
      sub: nt ? `до «${nt.name}»` : 'вещь на потолке',
      primary: true,
      enabled: !!nt && known && goldOk && canAffordBoth(inventory, stashWallet, cost),
      tip: nt && known ? 'Кузнечная вещь требует меньше атрибутов, чем найденная того же тира' : undefined,
      lines: !nt ? [{ text: 'лучше уже не сделать', state: 'dim' }]
        : !known ? [{ text: 'эту вещь кузнец не улучшает', state: 'dim' }]
        : [{ text: `${prices.upgradeTier} золота`, state: goldOk ? 'ok' : 'miss' }, ...costLines(cost, have, nameOf)],
    });
  }

  // Реролл: сервер отказывает сломанному — карточка говорит ПОЧЕМУ, а не просто гаснет.
  const left = Math.max(0, prices.rerollLimit - (item.rerolls ?? 0));
  const rrGold = gold >= prices.rerollAffix;
  out.push({
    id: 'reroll', cmd: 'forgeReroll', title: '🎲 Реролл', sub: `осталось ${left} из ${prices.rerollLimit}`,
    primary: false, enabled: !item.broken && left > 0 && rrGold,
    lines: item.broken ? [{ text: 'сперва почини', state: 'dim' }]
      : left <= 0 ? [{ text: 'перекаток больше нет', state: 'dim' }]
      : [{ text: `${prices.rerollAffix} золота`, state: rrGold ? 'ok' : 'miss' },
         { text: 'перекатит аффиксы', state: 'dim' }],
  });

  // ⚠ Гаснет ТЕМ ЖЕ правилом, которым отказывает сервер (`canSalvageItem`), — иначе кнопка
  // предлагала бы то, что сервер отклонит. Выход показываем вилкой: он случаен.
  const can = canSalvageItem(reg, item, false);
  const rng = salvageRange(reg, item, false);
  out.push({
    id: 'salvage', cmd: 'forgeSalvage', title: '♻ Разобрать', sub: 'вещь исчезнет',
    primary: false, enabled: can.ok,
    lines: !can.ok ? [{ text: can.reason ?? 'нельзя', state: 'dim' }]
      : Object.entries(rng.range).map(([id, r]) => ({
        text: `${nameOf(id)} ${r.min === r.max ? r.min : `${r.min}–${r.max}`}`,
        state: 'gain' as const,
      })),
  });

  return out;
}
