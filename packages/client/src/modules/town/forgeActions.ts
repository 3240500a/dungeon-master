import {
  upgradeCost, repairCost, upgradedItem, salvageRange, canSalvageItem, canRerollItem, canUpgradeItem, canEnchantItem, canAffordBoth,
  availableMaterials, nextTierOf, forgeGold, enchantCost, type ConfigRegistry, type Item,
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
  id: 'repair' | 'upgrade' | 'reroll' | 'enchant' | 'salvage';
  cmd: 'forgeRepair' | 'forgeUpgrade' | 'forgeReroll' | 'forgeEnchant' | 'forgeSalvage';
  /** Зачарование (R3-09): до какой редкости. У остальных действий нет. */
  rarity?: 'magic' | 'rare';
  title: string;
  sub: string;
  lines: CostLine[];
  enabled: boolean;
  /** Главное действие для ЭТОГО состояния вещи — всегда первое в списке. */
  primary: boolean;
  tip?: string;
  /**
   * ⭐ R5-15: цена в золоте, которую показывает карточка, — уходит в команду `maxGold`: дороже сервер не возьмёт (его
   * конфиг мог уйти вперёд клиентского). Нет — действие бесплатно (разбор) или недоступно.
   */
  gold?: number;
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
 *
 * ⚠ Выравнивание по LCS, а НЕ построчно по индексу. Строки не только меняются, но и ИСЧЕЗАЮТ:
 * у починки пропадает «⚠ Сломано», и сравнение по индексу сдвигало бы весь хвост — предпросмотр
 * показывал бы «Сломано → Урон», то есть чистый мусор. Совпавшие строки служат якорями, а
 * несовпавшие между ними спариваются по порядку («Урон: 9–22» → «Урон: 13–31»).
 */
export function diffStrings(a: readonly string[], b: readonly string[]): { was: string; will: string }[] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: { was: string; will: string }[] = [];
  let was: string[] = [];
  let will: string[] = [];
  const flush = (): void => {
    for (let t = 0; t < Math.max(was.length, will.length); t++) {
      out.push({ was: was[t] ?? '', will: will[t] ?? '' });
    }
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
 * Карточки в ФИКСИРОВАННОМ порядке: главное действие, реролл, [зачарование — у скованной], разбор.
 *
 * ⚠ Первая карточка не меняет МЕСТА, только смысл: целой вещи «Улучшить», сломанной «Починить».
 * Кнопки не прыгают под курсором, а какое действие сейчас главное — решает сама вещь.
 * ⚠ Разбор всегда последний: он уничтожает вещь, и ему нечего делать рядом с главным действием.
 * ⚠ R3-09: у СКОВАННОЙ вещи — ещё две карточки зачарования, и у зачарованной тоже (погашены): иначе после
 * зачарования разбор встал бы под курсор на место «✦ Магический».
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
    // ⚠ Цена считается ТОЙ ЖЕ `forgeGold`, которой её считает сервер: она зависит от ступени и
    // редкости вещи, и своя формула здесь молча разошлась бы с отказом сервера.
    const price = forgeGold(reg, item, 'repair');
    const goldOk = gold >= price;
    const matsOk = !Object.keys(cost).length || canAffordBoth(inventory, stashWallet, cost);
    out.push({
      id: 'repair', cmd: 'forgeRepair', title: '🔧 Починить', sub: 'снимет «сломано»',
      primary: true, enabled: goldOk && matsOk, gold: price,
      lines: [
        { text: `${price} золота`, state: goldOk ? 'ok' : 'miss' },
        ...costLines(cost, have, nameOf),
      ],
    });
  } else {
    // ⚠ R2-12: гаснет ТЕМ ЖЕ правилом, которым отказывает сервер (`canUpgradeItem`). Своя проверка (`nextTierOf` +
    // `upgradeCost`) скованной вещи не видела: карточка горела «до «Отличный»» с ценой, а сервер всегда отказывал.
    const can = canUpgradeItem(reg, item);
    const cost = can.ok ? upgradeCost(reg, item) : {};
    const nt = nextTierOf(reg, item);
    const price = forgeGold(reg, item, 'upgrade');
    const goldOk = gold >= price;
    out.push({
      id: 'upgrade', cmd: 'forgeUpgrade', title: '🔨 Улучшить',
      sub: item.parts ? 'скованная вещь' : nt ? `до «${nt.name}»` : 'вещь на потолке',
      primary: true,
      enabled: can.ok && goldOk && canAffordBoth(inventory, stashWallet, cost),
      gold: can.ok ? price : undefined,
      tip: can.ok ? 'Кузнечная вещь требует меньше атрибутов, чем найденная того же тира' : undefined,
      lines: !can.ok ? [{ text: can.reason ?? 'нельзя', state: 'dim' }]
        : [{ text: `${price} золота`, state: goldOk ? 'ok' : 'miss' }, ...costLines(cost, have, nameOf)],
    });
  }

  // Реролл: гаснет ТЕМ ЖЕ правилом, которым отказывает сервер (`canRerollItem`: сломана, перекатки кончились,
  // обычной и уникальной перекатывать нечего — R2-13), и говорит ПОЧЕМУ, а не просто серый. Цена — `forgeGold`
  // сервера: у скованной она уже с множителем формы (R2-10).
  const left = Math.max(0, prices.rerollLimit - (item.rerolls ?? 0));
  const rr = canRerollItem(reg, item);
  const rrPrice = forgeGold(reg, item, 'reroll');
  const rrGold = gold >= rrPrice;
  out.push({
    id: 'reroll', cmd: 'forgeReroll', title: '🎲 Реролл', sub: `осталось ${left} из ${prices.rerollLimit}`,
    primary: false, enabled: rr.ok && rrGold, gold: rr.ok ? rrPrice : undefined,
    lines: !rr.ok ? [{ text: rr.reason ?? 'нельзя', state: 'dim' }]
      : [{ text: `${rrPrice} золота`, state: rrGold ? 'ok' : 'miss' },
         { text: 'перекатит аффиксы', state: 'dim' }],
  });

  // ⭐ R3-09: ЗАЧАРОВАНИЕ СКОВАННОЙ. Раньше оно жило только в окне ковки и только для вещи, скованной в том же
  // состоянии окна: перезагрузка, другой герой или клик по детали — и зачаровать меч было негде. Гаснет ТЕМ ЖЕ
  // правилом, что отказ сервера: `canEnchantItem`, золото и `balance.craft.live` (закрытый кузнец не зачаровывает).
  if (item.parts) {
    const live = reg.get('balance').craft.live;
    for (const rarity of ['magic', 'rare'] as const) {
      const can = canEnchantItem(reg, item, rarity);
      const price = enchantCost(reg, item, rarity);
      const goldOk = gold >= price;
      const why = !live ? 'Кузнец ещё не зачаровывает' : can.ok ? undefined : can.reason ?? 'нельзя';
      out.push({
        id: 'enchant', cmd: 'forgeEnchant', rarity, title: rarity === 'magic' ? '✦ Магический' : '✦ Редкий',
        sub: rarity === 'magic' ? 'зачаровать до магической' : 'зачаровать до редкой',
        primary: false, enabled: !why && goldOk, gold: why ? undefined : price,
        lines: why ? [{ text: why, state: 'dim' }]
          : [{ text: `${price} золота`, state: goldOk ? 'ok' : 'miss' }, { text: 'свойства по форме вещи', state: 'dim' }],
      });
    }
  }

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
