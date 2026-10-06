import {
  upgradeCost, repairCost, upgradedItem, salvageMean, salvageRange, salvagePreview, canSalvageItem, canRerollItem, canUpgradeItem, canEnchantItem,
  canRepairItem, canAffordBoth, availableMaterials, nextTierOf, forgeGold, enchantCost, enchantMaterials, rerollMaterials, STARTER_KNOWN,
  type ConfigRegistry, type CraftJournal, type Item, type SalvageCardLine,
} from '@dm/shared';

/**
 * ЧТО КУЗНЕЦ ПРЕДЛАГАЕТ ДЕЛАТЬ С ВЕЩЬЮ — чистое решение, без единой строки DOM.
 *
 * Здесь живёт вся логика верстака: какое действие главное, что доступно, сколько стоит и чего
 * не хватает. `forgeBench.ts` рядом только рисует полученный список. Разделение не косметическое:
 * в node-прогоне DOM недоступен, и без него правило «сломанной вещи главное — починка» осталось бы
 * непроверяемым, а это ровно то, что игрок видит первым.
 */

/** `warn` — чего не будет и почему («Эссенция: нет — вещь куплена»): не «не хватает» (красный), а оговорка. */
export type LineState = 'ok' | 'miss' | 'gain' | 'dim' | 'warn';
/**
 * Строка карточки. `label` — подпись строки карточки разбора («Сырьё», «Эссенция», «Каталог», «Эскиз»): строка рисуется
 * «Подпись: текст» без значка — сам текст уже говорит «+ …» или «нет — …».
 */
export interface CostLine { text: string; state: LineState; label?: string }

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
  /** ⭐ R8-14: сырьё строк карточки (улучшение, починка; с §6.2 — эссенция перекатки и зачарования) — в команду `maxMaterials`: больше сервер не возьмёт. */
  materials?: Record<string, number>;
  /** ⭐ R8-14: низ вилки «от–до» разбора — в команду `minYield`: меньше сервер не даст, вещь останется цела. */
  minYield?: Record<string, number>;
  /** ⭐ R9-04: средний выход разбора — в команду `avgYield`: у дробной доли низ вилки — 0 при любой правке выхода. */
  avgYield?: Record<string, number>;
}

/**
 * ЧТО СТАНЕТ С ВЕЩЬЮ, если применить к ней главное действие, — источник предпросмотра.
 * Сломанной главное — починка (статы от неё не меняются, меняется «надеть нельзя → можно»),
 * целой — улучшение. `undefined` — менять нечего.
 */
export function benchTarget(reg: ConfigRegistry, item: Item): Item | undefined {
  // R7-19: сломанное, которое кузнец не чинит (уник), — предпросмотра нет: шапка и карточка говорят одно.
  if (item.broken) return canRepairItem(reg, item).ok ? { ...item, broken: false } : undefined;
  // ⭐ R14-12: и целое, которое кузнец не поднимает (`canUpgradeItem`: кольцо, амулет — R12-03), — предпросмотра нет. `upgradedItem`
  // о `tierMatters` не знает: шапка писала «после улучшения» над «Кузнец эту вещь не меняет» и погашенной карточкой.
  return canUpgradeItem(reg, item).ok ? upgradedItem(reg, item) : undefined;
}

/** Подпись шапки предпросмотра — тем же ответом, что `benchTarget` и главная карточка (R14-12). */
export function benchTargetLabel(reg: ConfigRegistry, item: Item, target: Item | undefined): string {
  if (item.broken) return target ? 'после починки' : 'кузнец не чинит';
  if (target) return 'после улучшения';
  if (item.parts) return 'скованную поднимает замена детали';
  return nextTierOf(reg, item) ? 'улучшать нечего' : 'улучшать больше некуда';
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

/**
 * Строка цены с отметкой «хватает / не хватает» — вместо серой кнопки без объяснения. ⭐ §15.4: «есть N» — ВСЕГДА (сумка + сундук), а не
 * только при нехватке: «Кордован 3 (есть 12)» говорит и цену, и запас, и сколько подъёмов ещё потянешь; нехватка — ещё «— не хватает».
 */
function costLines(
  cost: Record<string, number>,
  have: Record<string, number>,
  nameOf: (id: string) => string,
): CostLine[] {
  return Object.entries(cost).map(([id, n]) => {
    const got = have[id] ?? 0;
    return { text: `${nameOf(id)} ${n} (есть ${got})${got < n ? ' — не хватает' : ''}`, state: got >= n ? 'ok' : 'miss' };
  });
}

/** Строка карточки разбора (`salvagePreview`) → строка верстака: тон `gain` / `dim` / `warn`, подпись — своя. */
const cardLine = (l: SalvageCardLine): CostLine => ({ label: l.label, text: l.text, state: l.tone });

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
  journal?: CraftJournal | null,
): BenchAction[] {
  const prices = reg.get('balance').forgePrices;
  const have = availableMaterials(inventory, stashWallet);
  const defs = reg.get('craft-materials');
  const nameOf = (id: string): string => defs.find((m) => m.id === id)?.name ?? id;
  const out: BenchAction[] = [];

  if (item.broken) {
    // ⚠ R7-19: гаснет ТЕМ ЖЕ правилом, которым отказывает сервер (`canRepairItem`: уник кузнец не чинит), и говорит почему.
    // Прежде карточка у сломанного уника горела с ценой в одно золото (его лестница сырья пуста), и сервер её исполнял.
    const can = canRepairItem(reg, item);
    const cost = can.ok ? repairCost(reg, item) : {};
    // ⚠ Цена считается ТОЙ ЖЕ `forgeGold`, которой её считает сервер: она зависит от ступени и
    // редкости вещи, и своя формула здесь молча разошлась бы с отказом сервера.
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
    // ⚠ R2-12: гаснет ТЕМ ЖЕ правилом, которым отказывает сервер (`canUpgradeItem`). Своя проверка (`nextTierOf` +
    // `upgradeCost`) скованной вещи не видела: карточка горела «до «Отличный»» с ценой, а сервер всегда отказывал.
    const can = canUpgradeItem(reg, item);
    const cost = can.ok ? upgradeCost(reg, item) : {};
    const nt = nextTierOf(reg, item);
    const price = forgeGold(reg, item, 'upgrade');
    const goldOk = gold >= price;
    out.push({
      id: 'upgrade', cmd: 'forgeUpgrade', title: '🔨 Улучшить',
      // ⭐ R14-12: «до «…»» — только когда кузнец поднимает (`can`): `nextTierOf` о `tierMatters` не знает, и у кольца погашенная
      // карточка обещала «до «Отличный»» под строкой «Ступень этой вещи ничего не меняет».
      sub: item.parts ? 'скованная вещь' : !nt ? 'вещь на потолке' : can.ok ? `до «${nt.name}»` : 'кузнец не поднимает',
      primary: true,
      enabled: can.ok && goldOk && canAffordBoth(inventory, stashWallet, cost),
      gold: can.ok ? price : undefined, materials: can.ok ? cost : undefined,
      tip: can.ok ? 'Кузнечная вещь требует меньше атрибутов, чем найденная того же тира' : undefined,
      lines: !can.ok ? [{ text: can.reason ?? 'нельзя', state: 'dim' }]
        : [{ text: `${price} золота`, state: goldOk ? 'ok' : 'miss' }, ...costLines(cost, have, nameOf)],
    });
  }

  // Реролл: гаснет ТЕМ ЖЕ правилом, которым отказывает сервер (`canRerollItem`: сломана, перекатки кончились,
  // обычной и уникальной перекатывать нечего — R2-13), и говорит ПОЧЕМУ, а не просто серый. Цена — `forgeGold`
  // сервера: у скованной она уже с множителем формы (R2-10). ⭐ §6.2: и эссенция (`rerollMaterials`) — строкой «есть / не хватает».
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
      : [{ text: `${rrPrice} золота`, state: rrGold ? 'ok' : 'miss' },
         ...costLines(rrMats, have, nameOf),
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
      // ⭐ §6.2: и эссенция (`enchantMaterials`) — строкой «есть / не хватает», в команду — согласием `maxMaterials`.
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

  // ⭐ РАЗБОР — КАРТОЧКА ИЗ ЧЕТЫРЁХ СТРОК ВСЕГДА (предложение «Разбор, сырьё и чары» §15.2, `salvagePreview`): сырьё вилкой (выход
  // случаен), эссенция, каталог, эскиз — и у нулевой строки причина («Эссенция: нет — вещь куплена»). Скованную ПЕРЕПЛАВЛЯЮТ —
  // заголовок «Переплавить». Гаснет ТЕМ ЖЕ правилом, которым отказывает сервер (`canSalvageItem` с журналом кадра сундука: стартовый
  // набор, из которого каталогу нечего взять, — отказ ДО нажатия, §9.3). Журнала нет (кадр не пришёл) — как прежде: откажет сервер.
  const can = canSalvageItem(reg, item, false, journal);
  const card = salvagePreview(reg, item, journal ?? null, false);
  const rng = salvageRange(reg, item, false);
  const four = [card.materials, card.essence, ...(card.catalog ? [card.catalog] : []), ...(card.sketch ? [card.sketch] : [])].map(cardLine);
  out.push({
    id: 'salvage', cmd: 'forgeSalvage', title: card.verb === 'melt' ? '♻ Переплавить' : '♻ Разобрать', sub: 'вещь исчезнет',
    primary: false, enabled: can.ok,
    minYield: can.ok ? Object.fromEntries(Object.entries(rng.range).map(([id, r]) => [id, r.min])) : undefined,
    avgYield: (can.ok && salvageMean(reg, item, false)) || undefined,
    // Отказ — причиной; у стартового набора, из которого всё уже в каталоге, ещё и строкой каталога (что уже открыто).
    lines: can.ok ? four
      : [{ text: can.reason ?? 'нельзя', state: 'dim' }, ...(can.reason === STARTER_KNOWN && card.catalog ? [cardLine(card.catalog)] : [])],
  });

  return out;
}
