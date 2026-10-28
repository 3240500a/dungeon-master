import type { ConfigRegistry } from '../config/registry.js';
import type { Seal } from '../config/schemas.js';
import { liveModStats, runModCount, NO_RUN_BUFFS, type RunModBuffs, type RunModStat } from '../dungeon/run/runModEffects.js';
import { WIRE_SEAL_SLOTS_MAX } from '../session/wireLimits.js';   // ⚠ только ЧИСЛО-граница, не схемы: цикла импортов нет
import { RUN_MOD_DANGER_STATS } from '../config/schemas.js';
import { addToInventory, type Dims } from '../inventory/grid.js';
import type { Item } from '../types/items.js';

/**
 * ⭐⭐ Ф5-1 (17.10): ПЕЧАТЬ ОТРЕЗКА — ПРЕДМЕТ.
 *
 * Решение владельца 16.10: печать — **не набор катаных свойств, а кусок контента, который сам по себе и угроза, и
 * награда**: «одна печать — это комната элитки, другая — увеличение пачек, и все такие». Отсюда три свойства,
 * которые держит этот модуль:
 *
 * 1. **В предмете лежат только ИД** — вид (`sealId`) и ступень (`sealTier`). Что печать делает, читается из конфига
 *    при каждом вопросе: правка баланса доезжает до печатей, УЖЕ лежащих в сумках и сундуках. Положи значения в
 *    предмет — и у старых печатей остались бы старые числа, то есть у одного и того же имени две разные силы.
 * 2. **Копии неотличимы → стек по паре «вид + ступень»** (шов `stackKeyOf`). Отдельные клетки были бы налогом на
 *    сумку, а разные ступени в одном стеке потеряли бы силу каждой штуки.
 * 3. **Двусоставность — инвариант СХЕМЫ, а не данных**: `danger.stat` берётся из `RUN_MOD_DANGER_STATS`,
 *    `reward.stat` — из `RUN_MOD_REWARD_STATS`. «Печать золота» без боя не собирается даже опиской.
 *
 * ⚠⚠ ЖИВОСТЬ ПЕЧАТИ = ЖИВОСТЬ ОБЕИХ ЕЁ СТОРОН (`sealLive`). Та же дисциплина, что у Ф5-0: статы, которые игра
 * применяет, объявлены швами кода и сужены таблицей `run-mod-stats` из редактора. Выключили стат — печать, которая
 * им живёт, исчезает из предложения и из дропа ЦЕЛИКОМ, а не превращается в половину обещания.
 */

/** Печати включены вообще (`balance.seals.enabled` — тумблер всей механики). */
export function sealsEnabled(reg: ConfigRegistry): boolean {
  return reg.get('balance').seals.enabled !== false;
}

/** Ступени печатей (`balance.seals.tiers`) — одна лестница на все виды. */
export function sealTiers(reg: ConfigRegistry) {
  return reg.get('balance').seals.tiers;
}

/** Ступень по id. Нет такой — `undefined` (данные могли её убрать, а печать лежит в сумке). */
export function sealTierDef(reg: ConfigRegistry, tierId: string | undefined) {
  return tierId ? sealTiers(reg).find((t) => t.id === tierId) : undefined;
}

/**
 * Множитель силы ступени. ⚠ Неизвестная ступень даёт 0, а НЕ 1: иначе печать с подделанной или удалённой ступенью
 * действовала бы как первая, то есть провод и данные могли бы молча создать работающую печать из ничего.
 */
export function sealTierMul(reg: ConfigRegistry, tierId: string | undefined): number {
  return sealTierDef(reg, tierId)?.mul ?? 0;
}

/**
 * ⭐⭐ 23.10: ДОПУСК СУММАРНОЙ ОПАСНОСТИ НА ОДНУ ПЕЧАТЬ (`balance.seals.dangerCapPerSeal`) — из ЗАМЕРА ttk.
 *
 * Потолок стата держит стопку одного вида; этот — связку РАЗНЫХ видов, которой потолки по статам не видели
 * вовсе (замер: четыре печати III четырёх видов = +320 % опасности, бой проигран в 20 прогонах из 20).
 */
export function sealDangerCapPerSeal(reg: ConfigRegistry): number {
  return reg.get('balance').seals.dangerCapPerSeal;
}

/** Размер стека печатей в одной клетке (`balance.seals.stackMax`). */
export function sealStackMax(reg: ConfigRegistry): number {
  return reg.get('balance').seals.stackMax;
}

/** Вид печати по id — только включённый. */
export function sealDef(reg: ConfigRegistry, id: string | undefined): Seal | undefined {
  if (!id) return undefined;
  const row = reg.get('seals').find((s) => s.id === id);
  return row && row.enabled !== false ? row : undefined;
}

/**
 * ⚠⚠ ОДИН ПРЕДИКАТ «МОЖНО ЛИ ПРИМЕНИТЬ ЭТУ ПЕЧАТЬ СЕЙЧАС» — на все пути: дроп, окно алтаря, оплата на сервере,
 * свод множителей. Правка 17.10 по ревизии: раньше `altarPick` собирал ответ из трёх кусков (`sealDef` +
 * `sealLive` + `sealTierMul`) и НЕ спрашивал тумблер механики — замер показал, что при `seals.enabled = false`
 * алтарь всё равно СПИСЫВАЛ связку из сумки, а множители выходили единичными: игрок платил и не получал ничего.
 *
 * Условий ровно четыре, и каждое — своя беда, если его забыть:
 *  1. тумблер механики (`balance.seals.enabled`) — иначе платим за выключенное;
 *  2. вид включён — иначе играем снятым контентом;
 *  3. ЖИВЫ ОБА СТАТА — односторонняя печать это обманка ровно того рода, из-за которой Ф5-0 шла первой;
 *  4. у ОБОИХ статов потолок больше нуля — `cap: 0` значит «не применяется», и замер показал, что печать с
 *     нулевым потолком опасной стороны превращается в ЧИСТУЮ НАГРАДУ (`{furious@t3:4}` → dropBias ×2.20 при
 *     опасности 0.00), то есть обходит правило «блага без опасности не бывает» через ручку редактора.
 */
export function sealLive(reg: ConfigRegistry, def: Seal, live?: ReadonlySet<string>): boolean {
  if (!sealsEnabled(reg) || def.enabled === false) return false;
  const set = live ?? liveModStats(reg);
  if (!set.has(def.danger.stat) || !set.has(def.reward.stat)) return false;
  if (!(sealCapOf(reg, def.danger.stat) > 0 && sealCapOf(reg, def.reward.stat) > 0)) return false;
  // ⭐⭐ 23.10 (правка по ревизии): У СЧЁТНОГО ВИДА ПРИБАВКА ОБЯЗАНА ПОКРЫВАТЬ ЦЕНУ СОБЫТИЯ.
  //
  // События выдаются округлением ВНИЗ по цене (`runModCount`), и вид, чья прибавка дешевле одного события,
  // списывался бы с игрока, не давая ничего, — ровно та ловушка, от которой избавлялись спасательным порогом.
  // Порог убран (он дарил событие дешевле цены), а ловушку закрывает ЖИВОСТЬ: такой вид не падает, не
  // предлагается на алтаре и не действует — как и любой другой мёртвый вид, и это видно в редакторе.
  const row = reg.get('run-mod-stats').find((s) => s.id === def.danger.stat);
  if (row?.unit === 'count' && def.danger.value + 1e-9 < row.perUnit) return false;
  const cap = sealCapOf(reg, def.danger.stat);
  if (row?.unit === 'count' && cap + 1e-9 < row.perUnit) return false;   // потолок ниже цены = события не бывает
  return true;
}

/**
 * ⭐⭐ 23.10 (Ф5-6′): ЖИВЁТ ЛИ ВИД В ЭТОМ БИОМЕ (`seals[].biomes`; пусто — везде).
 *
 * ⚠ Биом НЕ ЗНАЕМ (`undefined`) — это город, кузница, редактор и Unity-окно без забега: там печать видна и
 * перековывается как обычно. Фильтровать по «неизвестному биому» значило бы спрятать у кузнеца всё, что
 * привязано хоть к чему-нибудь.
 */
export function sealFitsBiome(def: Seal, biomeId?: string): boolean {
  return def.biomes.length === 0 || (biomeId !== undefined && def.biomes.includes(biomeId));
}

/** Ключ привязки вида к биомам — «чем является эта печать» для группировки (перековка складывает только своё). */
export function sealBiomeKey(def: Seal): string {
  return [...def.biomes].sort().join('+');
}

/**
 * Виды печатей, которые игра ДЕЙСТВИТЕЛЬНО применяет (включены, оба стата живы, и вид подходит биому).
 *
 * ⚠ `biomeId` задан — отдаём только то, что здесь живёт: это один и тот же список для дропа, окна алтаря и
 * множителей, иначе в одном месте вид есть, а в другом нет.
 */
export function liveSealDefs(reg: ConfigRegistry, biomeId?: string): Seal[] {
  if (!sealsEnabled(reg)) return [];
  const live = liveModStats(reg);
  return reg.get('seals').filter((s) => sealLive(reg, s, live) && (biomeId === undefined || sealFitsBiome(s, biomeId)));
}

/** Имя печати со ступенью: «Кишащий I». Ступени нет в данных — имя без неё, а не «undefined». */
export function sealName(def: Seal, tier?: { name: string }): string {
  return tier ? `${def.name} ${tier.name}` : def.name;
}

/**
 * ПРЕДМЕТ-ПЕЧАТЬ. Намеренно «пустой», как стек сырья: ни слота, ни аффиксов, ни статов — значит экипировка,
 * кузница, лавка и журнал предметов отсекают его уже существующими проверками, а не новыми условиями.
 */
export function sealItem(def: Seal, tierId: string, count: number, uid: string, name?: string): Item {
  return {
    uid,
    baseId: `seal:${def.id}`,
    kind: 'seal',
    sealId: def.id,
    sealTier: tierId,
    name: name ?? def.name,
    rarity: 'normal',
    itemLevel: 1,
    count: Math.max(1, Math.round(count)),
    requirements: {},
    affixes: [],
    baseStats: [],
    gridW: 1,
    gridH: 1,
    pos: null,
  };
}

/** Собрать печать по конфигу. `null` — вида нет, он выключен, стат мёртв или ступени нет в лестнице. */
export function buildSeal(reg: ConfigRegistry, sealId: string, tierId: string, count: number, uid: string): Item | null {
  const def = sealDef(reg, sealId);
  const tier = sealTierDef(reg, tierId);
  if (!def || !tier || !sealsEnabled(reg) || !sealLive(reg, def)) return null;
  return sealItem(def, tier.id, count, uid, sealName(def, tier));
}

/** Одна и та же печать? Стек сливается только по паре «вид + ступень». */
export function sameSeal(a: Item, b: Item): boolean {
  return a.kind === 'seal' && b.kind === 'seal' && !!a.sealId
    && a.sealId === b.sealId && (a.sealTier ?? '') === (b.sealTier ?? '');
}

/** Ключ связки: «вид@ступень». Тот же порядок, что у `stackKeyOf`, но без вида предмета. */
export function sealKey(sealId: string, tierId: string): string {
  return `${sealId}@${tierId}`;
}

/** Сколько печатей каждой пары «вид + ступень» лежит в сумке (по всем стекам). */
export function carriedSeals(inventory: readonly Item[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of inventory) {
    if (it.kind !== 'seal' || !it.sealId) continue;
    const k = sealKey(it.sealId, it.sealTier ?? '');
    out[k] = (out[k] ?? 0) + (it.count ?? 1);
  }
  return out;
}

/** Сколько печатей ровно этой пары лежит в сумке. */
export function carriedSealCount(inventory: readonly Item[], sealId: string, tierId: string): number {
  return carriedSeals(inventory)[sealKey(sealId, tierId)] ?? 0;
}

/**
 * ⭐⭐ Решение владельца 17.10: ЗАПАС ПЕЧАТЕЙ = СУМКА + СУНДУК АККАУНТА.
 *
 * Кузнец берёт ресурсы из обоих мест (так работают подъём тира, починка и обмен — `canAffordBoth`), и ждать от
 * «верстака» другого поведения игроку незачем: с сорока печатями в сундуке он читал бы «не хватает» как поломку.
 *
 * ⚠ Вкладки сундука — это ПРЕДМЕТЫ (`tabs`), а не кошелёк: печать там лежит такими же стеками, как в сумке.
 */
export function carriedSealsAll(inventory: readonly Item[], tabs?: readonly (readonly (Item | null)[])[]): Record<string, number> {
  const out = { ...carriedSeals(inventory) };
  for (const tab of tabs ?? []) {
    for (const it of tab) {
      if (!it || it.kind !== 'seal' || !it.sealId) continue;
      const k = sealKey(it.sealId, it.sealTier ?? '');
      out[k] = (out[k] ?? 0) + (it.count ?? 1);
    }
  }
  return out;
}

/**
 * СПИСАТЬ СВЯЗКУ ИЗ СУМКИ И СУНДУКА — «всё или ничего», СУМКА ПЕРВОЙ.
 *
 * Порядок не косметика: печати в сумке под угрозой смерти, а в сундуке — нет, и тратить сперва рискующее
 * выгоднее игроку (то же решение, что у сырья в `spendBoth`). Не хватило суммарно — `null`, и ничего не тронуто.
 */
export function spendSealsBoth(
  inventory: readonly Item[],
  tabs: readonly (readonly (Item | null)[])[] | undefined,
  picks: SealGains,
): { inventory: Item[]; tabs: Item[][] } | null {
  const need = new Map<string, number>();
  for (const [key, n] of Object.entries(picks)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    need.set(key, (need.get(key) ?? 0) + Math.floor(n));
  }
  const have = carriedSealsAll(inventory, tabs);
  for (const [key, n] of need) if ((have[key] ?? 0) < n) return null;

  const bag: Item[] = [];
  for (const it of inventory) {
    if (it.kind !== 'seal' || !it.sealId) { bag.push(it); continue }
    const key = sealKey(it.sealId, it.sealTier ?? '');
    const left = need.get(key) ?? 0;
    if (left <= 0) { bag.push(it); continue }
    const has = it.count ?? 1;
    const take = Math.min(has, left);
    need.set(key, left - take);
    if (has - take > 0) bag.push({ ...it, count: has - take });
  }
  const outTabs: Item[][] = [];
  for (const tab of tabs ?? []) {
    const row: Item[] = [];
    for (const it of tab) {
      if (!it) continue;
      if (it.kind !== 'seal' || !it.sealId) { row.push(it); continue }
      const key = sealKey(it.sealId, it.sealTier ?? '');
      const left = need.get(key) ?? 0;
      if (left <= 0) { row.push(it); continue }
      const has = it.count ?? 1;
      const take = Math.min(has, left);
      need.set(key, left - take);
      // ⚠⚠ 23.10, НАХОДКА ФАЗЗЕРА: ОПУСТЕВШИЙ СТЕК ПРОСТО УХОДИТ ИЗ СПИСКА. Здесь раньше вставлялся `null`
      // «чтобы не переложить вещи» — но вкладка сундука это НЕ СЕТКА, а СПИСОК вещей со своими `pos`
      // (`AccountStash.tabs: Item[][]`), и место вещи хранит она сама. `null` в списке ломал всех, кто вкладки
      // разворачивает: инварианты фаззера падали на `null.count`, а леджер предметов (`server/db/items.ts`)
      // разворачивает вкладки двойным циклом — то есть запись «сейв + сундук» после перековки из сундука.
      if (has - take > 0) row.push({ ...it, count: has - take });
    }
    outTabs.push(row);
  }
  return { inventory: bag, tabs: outTabs };
}

/** Сколько печатей каждой пары дать (ключ — `sealKey`). */
export type SealGains = Record<string, number>;

/**
 * КЛАДЁТ ПЕЧАТИ В СУМКУ стеками и возвращает ОСТАТОК, который не влез.
 *
 * ⚠ Остаток — не потеря: зовущая сторона обязана решить, что с ним делать (оставить лежать на земле), ровно как
 * у сырья. Молча уничтожать награду нельзя, иначе полная сумка превращает печать в ничто без единого сообщения.
 */
export function giveSealsTo(reg: ConfigRegistry, inventory: Item[], gains: SealGains, dims: Dims, uid: () => string): SealGains {
  const left: SealGains = {};
  const cap = sealStackMax(reg);
  for (const [key, n] of Object.entries(gains)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    const carrier = buildSeal(reg, key.slice(0, at), key.slice(at + 1), n, uid());
    if (!carrier) continue;                                // вида нет / выключен / стат мёртв — молча мимо
    addToInventory(inventory, carrier, dims, cap);
    if ((carrier.count ?? 0) > 0) left[key] = carrier.count!;
  }
  return left;
}

/**
 * СТРОКИ ПЕЧАТИ ДЛЯ ТУЛТИПА — обе стороны с числами из конфига.
 *
 * Названия статов берутся из таблицы `run-mod-stats` (та же, что решает, применяется ли стат вообще): одно имя
 * стата на всю игру, и выключенный стат нельзя описать как действующий.
 */
export function sealLines(reg: ConfigRegistry, item: Item): string[] {
  const def = sealDef(reg, item.sealId);
  const tier = sealTierDef(reg, item.sealTier);
  if (!def) return ['⚠ Печать неизвестного вида'];
  const mul = tier?.mul ?? 0;
  const rows = new Map(reg.get('run-mod-stats').map((s) => [s.id, s]));
  const label = (stat: string): string => rows.get(stat as RunModStat)?.name ?? stat;
  /**
   * ⭐⭐ 23.10: СТРОКА НАЗЫВАЕТ ТО, ЧТО ДАСТ ЭТА ПЕЧАТЬ, — ЧЕРЕЗ САМ `sealBuffs`, а не своей арифметикой.
   *
   * ⚠⚠ Было: `value × mul` сырыми процентами. Это ОБЕЩАНИЕ СВЕРХ ИГРЫ, и после потолка связки (23.10) разрыв
   * стал грубым: «Погоня III» показывала «+100 % золота» там, где одна печать даёт +60 %, а «Логово III» —
   * «+4 логова» при двух разрешённых потолком и одном выданном. Теперь считаем ровно то, что применит сервер
   * для СВЯЗКИ ИЗ ОДНОЙ ЭТОЙ ПЕЧАТИ: потолок стата, допуск связки и парная доля награды — всё включено.
   *
   * ⚠ Счётный стат (`unit: 'count'`) читается ШТУКАМИ тем же правилом, которым событие выдаёт шов заселения
   * (`runModCount` и цена `perUnit`): «Логова ×1.43» игрок не поймёт.
   */
  const alone = tier ? sealBuffs(reg, { [sealKey(def.id, tier.id)]: 1 }) : undefined;
  const side = (stat: string, value: number): string => {
    const row = rows.get(stat as RunModStat);
    const got = alone ? (alone as Record<string, number>)[stat] ?? 1 : 1 + value * mul;
    if (row?.unit === 'count') return `${label(stat)} +${runModCount(got, row.perUnit)}`;
    return `${label(stat)} +${Math.round((got - 1) * 100)} %`;
  };
  const out = [
    `Опаснее: ${side(def.danger.stat, def.danger.value)}`,
    `Богаче: ${side(def.reward.stat, def.reward.value)}`,
  ];
  if (def.desc) out.push(def.desc);
  if (!tier) out.push('⚠ Ступень этой печати из данных убрана — на алтаре она не подействует');
  else if (!sealLive(reg, def)) out.push('⚠ Эта печать сейчас не применяется (стат выключен в конфиге)');
  return out;
}

/**
 * СВЯЗКА ОДНОЙ СТРОКОЙ: «Логово II ×3, Кишащий I ×5» (слова владельца 16.10).
 *
 * Пусто — «идти как есть»: это законный выбор и он называется словами, а не отсутствием текста.
 */
export function sealBundleLine(reg: ConfigRegistry, picks: SealGains, empty = 'Идти как есть'): string {
  const parts: string[] = [];
  for (const [key, n] of Object.entries(picks)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const at = key.lastIndexOf('@');
    const def = sealDef(reg, at > 0 ? key.slice(0, at) : key);
    if (!def) continue;
    const tier = sealTierDef(reg, at > 0 ? key.slice(at + 1) : undefined);
    parts.push(`${sealName(def, tier)}${n > 1 ? ` ×${Math.floor(n)}` : ''}`);
  }
  return parts.length ? parts.join(', ') : empty;
}

// ── Ф5-2: откуда берутся печати ─────────────────────────────────────────────

/**
 * ⭐⭐ Ф5-2 (17.10): СТУПЕНЬ ДРОПА — БРОСОК ПО ВЕСАМ СРЕДИ ДОСТУПНЫХ НА ЭТОЙ ГЛУБИНЕ (`minDepth`).
 *
 * ⚠ Так «первое знакомство» живёт в ДАННЫХ, а не в коде: до глубины 8 доступна только I, и окно первой метки
 * объясняет ровно одну вещь. Поднять порог или открыть III с первого этажа — правка одного числа в редакторе.
 */
export function rollSealTier(reg: ConfigRegistry, depth: number, rng: { float(a: number, b: number): number }): string | null {
  const d = Number.isFinite(depth) ? Math.max(1, Math.floor(depth)) : 1;
  const open = sealTiers(reg).filter((t) => t.minDepth <= d && t.weight > 0);
  const total = open.reduce((s, t) => s + t.weight, 0);
  if (!open.length || total <= 0) return null;
  let r = rng.float(0, total);
  for (const t of open) { r -= t.weight; if (r <= 0) return t.id; }
  return open[open.length - 1]!.id;
}

/** Вид печати броском из ГОТОВОГО списка (все равновероятны: разнообразие связки — цель, а не случайность). */
export function rollSealKindAmong(kinds: readonly Seal[], rng: { int(a: number, b: number): number }): Seal | null {
  if (!kinds.length) return null;
  return kinds[rng.int(0, kinds.length - 1)] ?? null;
}

/**
 * Вид печати броском среди ЖИВЫХ. `biomeId` — биом забега: в подземелье падает только то, что здесь живёт.
 *
 * ⚠ Один бросок на одинаковых весах: если «редкие виды» когда-нибудь понадобятся, их место — вес в данных,
 * а не множитель в коде.
 */
export function rollSealKind(reg: ConfigRegistry, rng: { int(a: number, b: number): number }, biomeId?: string): Seal | null {
  return rollSealKindAmong(liveSealDefs(reg, biomeId), rng);
}

/** Множитель прихода от суммарной опасности отрезка (правило 4: риск оплачивает следующий риск). */
export function sealDropMul(reg: ConfigRegistry, danger: number): number {
  const d = Number.isFinite(danger) ? Math.max(0, danger) : 0;
  return 1 + reg.get('balance').seals.drop.dangerBonus * d;
}

/** Шанс печати с убитого монстра этой редкости (рядовой — 0 по форме данных, строки для него нет). */
export function sealKillChance(reg: ConfigRegistry, rarity: string | undefined, danger = 0): number {
  if (!sealsEnabled(reg)) return 0;
  const by = reg.get('balance').seals.drop.byRarity as Record<string, number | undefined>;
  const base = rarity ? by[rarity] : undefined;
  return base === undefined ? 0 : Math.min(1, base * sealDropMul(reg, danger));
}

/** Шанс печати из сундука. */
export function sealChestChance(reg: ConfigRegistry, danger = 0): number {
  if (!sealsEnabled(reg)) return 0;
  return Math.min(1, reg.get('balance').seals.drop.chestChance * sealDropMul(reg, danger));
}

/**
 * ГАРАНТИЯ С БОССА — по рангу лестницы (мини/крепкий/актовый). Приём PoE2: сустейн держат ГАРАНТИИ, а не дроп с
 * рядовых, иначе запас либо копится бесконечно, либо кончается в самый неподходящий момент.
 */
export function sealBossCount(reg: ConfigRegistry, rank: string | undefined): number {
  if (!sealsEnabled(reg) || !rank) return 0;
  const by = reg.get('balance').seals.drop.bossByRank as Record<string, number | undefined>;
  return by[rank] ?? 0;
}

/** Одна печать броском: вид × ступень. `null` — печатей нет (выключены, статы мёртвы, ступеней нет). */
export function rollSeal(
  reg: ConfigRegistry,
  depth: number,
  rng: { int(a: number, b: number): number; float(a: number, b: number): number },
  biomeId?: string,
): { sealId: string; tierId: string } | null {
  const def = rollSealKind(reg, rng, biomeId);
  const tier = rollSealTier(reg, depth, rng);
  return def && tier ? { sealId: def.id, tierId: tier } : null;
}

// ── Ф5-3: связка → множители отрезка ───────────────────────────────────────

/**
 * ⭐⭐ Ф5-3 (17.10): СКОЛЬКО ГНЁЗД ОТКРЫТО — по РЕКОРДУ ГЛУБИНЫ героя (`balance.seals.slots`).
 *
 * ⚠ Рекорд, а не текущая глубина: иначе каждый новый забег начинался бы с одного гнезда, и заработанное
 * пропадало бы при каждом «начать сначала».
 */
export function sealSlots(reg: ConfigRegistry, record: number): number {
  const r = Number.isFinite(record) ? Math.max(0, Math.floor(record)) : 0;
  let out = 0;
  for (const row of reg.get('balance').seals.slots) if (r >= row.fromRecord) out = Math.max(out, row.count);
  return out;
}

/** Потолок прибавки по стату за один этаж (`run-mod-stats[].cap`). Стата нет в таблице — потолка нет. */
export function sealCapOf(reg: ConfigRegistry, stat: string): number {
  const row = reg.get('run-mod-stats').find((s) => s.id === stat);
  return row ? row.cap : Infinity;
}

/** Разбор ключа связки: «вид@ступень» → пара. Мусор — `null`. */
export function parseSealKey(key: string): { sealId: string; tierId: string } | null {
  const at = key.lastIndexOf('@');
  if (at <= 0 || at === key.length - 1) return null;
  return { sealId: key.slice(0, at), tierId: key.slice(at + 1) };
}

/** Сколько печатей в связке всего (гнёзда считают ШТУКИ, а не виды). */
export function sealBundleSize(picks: SealGains): number {
  let n = 0;
  for (const v of Object.values(picks)) if (Number.isFinite(v) && v > 0) n += Math.floor(v);
  return n;
}

/**
 * ⭐⭐ Ф5-3: СВЯЗКА → МНОЖИТЕЛИ ЭТАЖА, С ПОТОЛКОМ ПО ТИПУ СВОЙСТВА.
 *
 * Складываем прибавки всех печатей по каждому стату (`value × mul ступени × штук`), зажимаем каждый стат его
 * потолком (`run-mod-stats[].cap`) и только потом превращаем в множитель. Отсюда и слова владельца: «хоть шесть
 * одинаковых поставь, выше определённого значения не станет».
 *
 * ⚠ СЧЁТ ПОЭТАЖНЫЙ: эти множители действуют на КАЖДОМ этаже отрезка целиком и ничего не переносят. Иначе выбор
 * схлопнулся бы в «жирное несу на последнее место перед боссом», и четыре алтаря из семи стали бы мёртвыми.
 *
 * ⚠ Мёртвые виды и неизвестные ступени молча пропускаются: связка в сейве могла пережить правку конфига, и
 * «печать есть, а стат выключили» обязано значить «не действует», а не «действует по старому».
 */
export function sealBuffs(reg: ConfigRegistry, picks: SealGains | undefined, biomeId?: string): RunModBuffs {
  const out: Record<string, number> = { ...NO_RUN_BUFFS };
  if (!picks || !sealsEnabled(reg)) return out as RunModBuffs;
  const live = liveModStats(reg);
  const dangerAdd: Record<string, number> = {};
  const rewardAdd: Record<string, number> = {};
  let liveCount = 0;   // штук, которые действительно действуют (ими же считается допуск связки)
  for (const [key, n] of Object.entries(picks)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const parsed = parseSealKey(key);
    if (!parsed) continue;
    const def = sealDef(reg, parsed.sealId);
    const mul = sealTierMul(reg, parsed.tierId);
    // ⚠ Чужой биом пропускается ровно как мёртвый вид: правило привязки одно на дроп, алтарь и множители.
    if (!def || mul <= 0 || !sealLive(reg, def, live) || !sealFitsBiome(def, biomeId)) continue;
    const k = Math.floor(n);
    liveCount += k;
    dangerAdd[def.danger.stat] = (dangerAdd[def.danger.stat] ?? 0) + def.danger.value * mul * k;
    rewardAdd[def.reward.stat] = (rewardAdd[def.reward.stat] ?? 0) + def.reward.value * mul * k;
  }
  // ⭐⭐ ПОТОЛКИ СЧИТАЮТСЯ ПАРОЙ (правка 17.10 по замеру ревизии).
  //
  // ⚠⚠ Было: каждый стат зажимался САМ ПО СЕБЕ — и как только опасная сторона насыщалась, лишние копии
  // продолжали растить НАГРАДУ. Замер: `{pursuit@t3:1}` → золото ×2.00 при опасности 0.40, `{pursuit@t3:2}` →
  // золото ×3.00 при ТОЙ ЖЕ опасности 0.40. То есть вторая копия давала благо ДАРОМ, и стопка одного вида
  // оказывалась втрое выгоднее разнообразия — ровно наоборот тому, зачем потолки вводились.
  //
  // Правило: ДОЛЯ РЕАЛИЗОВАННОЙ НАГРАДЫ НЕ БОЛЬШЕ ДОЛИ РЕАЛИЗОВАННОЙ ОПАСНОСТИ. Зарезали половину
  // опасности потолком — получите половину награды. Так «блага без опасности не бывает» держится не только
  // на бумаге вида, но и НА МАРЖЕ любой связки.
  let rawDanger = 0;
  let capDanger = 0;
  const capped: Record<string, number> = {};
  // ⭐⭐ 23.10 (находка ревизии): СЧЁТНОЕ СОБЫТИЕ ЗАЧИТЫВАЕТСЯ ПО ВЫДАННЫМ ШТУКАМ, А НЕ ПО ОПЛАЧЕННОЙ ДОЛЕ.
  //
  // ⚠⚠ Замер нашёл обе беды сразу: одна печать «Логово» зачитывала 0.6 единицы, а на этаж выходило логово
  // ценой 1.4 (даровое событие), и при этом вторая-третья копии не добавляли НИ ОДНОГО логова, но растили
  // награду (dropBias ×1.43 → ×1.86 → ×2.03). Теперь по стату-событию считается РОВНО то, что выйдет на
  // этаж: `runModCount × perUnit` — одно и то же число у шва заселения, у счёта опасности и у топлива дропа.
  //
  // ⚠ И события НЕ СЖИМАЮТСЯ допуском связки: сжать «полтора логова» нельзя, а урезать до нуля значило бы
  // вернуть ловушку «печать списана, события нет». Их держит СВОЙ потолок стата (`cap`), и он же — предел
  // связки по событиям: лишние копии и старшие ступени упираются в него, а не растят награду даром.
  const rows = new Map(reg.get('run-mod-stats').map((s) => [s.id as string, s]));
  const counted: Record<string, number> = {};
  for (const [stat, sum] of Object.entries(dangerAdd)) {
    const cap = sealCapOf(reg, stat);
    const row = rows.get(stat);
    rawDanger += sum;
    if (row?.unit === 'count') {
      // Выдано событий — по цене, из прибавки, зажатой потолком стата; зачитываем их полную цену.
      counted[stat] = runModCount(1 + Math.min(sum, cap), row.perUnit) * row.perUnit;
      capDanger += counted[stat]!;
      continue;
    }
    capped[stat] = Math.min(sum, cap);
    capDanger += capped[stat]!;
  }
  // ⭐⭐ 23.10, ПО ЗАМЕРУ ttk: ПОТОЛОК НА ВСЮ СВЯЗКУ, а не только по статам порознь.
  //
  // ⚠⚠ Потолки по статам не видят связки РАЗНЫХ видов: четыре гнезда — четыре разных стата, каждый далеко под
  // своим потолком, а В СУММЕ замер боем давал +320 % опасности и 20 смертей из 20 прогонов. Допуск —
  // «штук в связке × `dangerCapPerSeal`» (замер: бот держит +60 % на печать), и считается он по ЖИВЫМ штукам:
  // мёртвый вид (выключили стат) не должен приносить допуск, которым пользуются остальные.
  // ⚠ 23.10 (находка ревизии): ЧИСЛО ШТУК ЗАЖАТО ПОТОЛКОМ ГНЁЗД ПРОВОДА. Гнёзда проверяет алтарь при ОПЛАТЕ,
  // а связка живёт в сейве, где схема допускает до 32 ключей по 9 штук: сейв из другого времени (или
  // подделанный) раздувал бы допуск до 288 × 0.6 и снимал сжатие вовсе. Потолок — тот же, что у кадра алтаря.
  const allow = Math.min(liveCount, WIRE_SEAL_SLOTS_MAX) * sealDangerCapPerSeal(reg);
  // ⚠ Сжимаются только ДОЛЕВЫЕ статы: события дискретны (см. выше), их доля в `capDanger` уже равна
  // выданному и в сжатии не участвует — иначе сжатие уменьшало бы число, которое уже не изменить.
  let multDanger = 0;
  for (const c of Object.values(capped)) multDanger += c;
  const eventDanger = capDanger - multDanger;
  const allowMult = Math.max(0, allow - eventDanger);
  const squeeze = multDanger > allowMult && multDanger > 0 ? allowMult / multDanger : 1;
  for (const [stat, c] of Object.entries(capped)) if (stat in out) out[stat] = 1 + c * squeeze;
  for (const [stat, c] of Object.entries(counted)) if (stat in out) out[stat] = 1 + c;
  capDanger = eventDanger + multDanger * squeeze;
  /**
   * ⭐⭐ ДОЛЯ РЕАЛИЗОВАННОЙ НАГРАДЫ НЕ БОЛЬШЕ ДОЛИ РЕАЛИЗОВАННОЙ ОПАСНОСТИ — но доля применяется ДО потолка
   * награды (правка 23.10 по ревизии).
   *
   * ⚠⚠ Было `min(sum, cap) × share`, и это ЛОМАЛО ЛЕСТНИЦУ СТУПЕНЕЙ: при упёртом потолке опасности `capDanger`
   * стоит на месте, а `rawDanger` растёт множителем ступени — значит доля падает ×mul, тогда как числитель
   * награды уже зажат своим потолком. Замер: 19 пар «ступень выше — награды МЕНЬШЕ» (4 × «Кишащий II» → 0.600
   * против 0.450 у III; 3 × «Сторожевой I» → 2 чемпиона и xp ×2.30, а выменянный на них «Сторожевой II» → 1
   * чемпион и xp ×1.43). То есть перековка — единственный сток печатей — делала связку СЛАБЕЕ.
   *
   * Доля ДО потолка: `min(sum × share, cap)`. Тогда награда монотонна по ступени и по числу копий, а потолок
   * по-прежнему держит верх, и «блага без опасности» всё так же не бывает.
   */
  const share = rawDanger > 0 ? capDanger / rawDanger : 1;
  for (const [stat, sum] of Object.entries(rewardAdd)) {
    if (!(stat in out)) continue;
    out[stat] = 1 + Math.min(sum * share, sealCapOf(reg, stat));
  }
  return out as RunModBuffs;
}

/** Суммарная ОПАСНОСТЬ связки (после потолков) — топливо прихода печатей (Ф5-2, правило 4). */
export function sealDangerOf(reg: ConfigRegistry, picks: SealGains | undefined, biomeId?: string): number {
  const b = sealBuffs(reg, picks, biomeId);
  let sum = 0;
  for (const s of RUN_MOD_DANGER_STATS) sum += Math.max(0, (b as Record<string, number>)[s]! - 1);
  return sum;
}

/**
 * СПИСАТЬ СВЯЗКУ ИЗ СУМКИ. Возвращает `null`, если чего-то не хватает, — и тогда сумка НЕ ТРОНУТА (всё или
 * ничего): частично списанная связка означала бы «заплатил и не получил», то есть пропажу печатей молча.
 */
export function spendSeals(inventory: Item[], picks: SealGains): Item[] | null {
  const need = new Map<string, number>();
  for (const [key, n] of Object.entries(picks)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    need.set(key, (need.get(key) ?? 0) + Math.floor(n));
  }
  const have = carriedSeals(inventory);
  for (const [key, n] of need) if ((have[key] ?? 0) < n) return null;
  const out: Item[] = [];
  for (const it of inventory) {
    if (it.kind !== 'seal' || !it.sealId) { out.push(it); continue }
    const key = sealKey(it.sealId, it.sealTier ?? '');
    const left = need.get(key) ?? 0;
    if (left <= 0) { out.push(it); continue }
    const have1 = it.count ?? 1;
    const take = Math.min(have1, left);
    need.set(key, left - take);
    if (have1 - take > 0) out.push({ ...it, count: have1 - take });
  }
  return out;
}

// ── Ф5-6: перековка 3→1 ─────────────────────────────────────────────────────

/** Ручки перековки (`balance.seals.reforge`). */
export function sealReforgeRules(reg: ConfigRegistry) {
  return reg.get('balance').seals.reforge;
}

/**
 * ⭐ СЛЕДУЮЩАЯ СТУПЕНЬ ЛЕСТНИЦЫ — по порядку в данных, а не по имени id.
 *
 * ⚠ Порядок строк `balance.seals.tiers` и ЕСТЬ лестница: так автор добавляет ступень вставкой строки, не
 * переименовывая существующие. Верхняя ступень не имеет следующей — это не ошибка, а конец лестницы.
 */
export function sealNextTier(reg: ConfigRegistry, tierId: string | undefined) {
  const tiers = sealTiers(reg);
  const i = tiers.findIndex((t) => t.id === tierId);
  return i >= 0 && i + 1 < tiers.length ? tiers[i + 1] : undefined;
}

/** Отказы перековки — одной строкой на все места (карточка кузницы, кнопка Unity, отказ сервера). */
export const SEAL_REFORGE_OFF = 'Перековка печатей отключена';
export const SEAL_REFORGE_TOP = 'Это уже старшая ступень — перековывать некуда';
export const SEAL_REFORGE_MIX = 'Перековка берёт печати ОДНОГО вида и ступени';
export const SEAL_REFORGE_TIER = 'Перековка берёт печати одной ступени';
export const SEAL_REFORGE_BIOME = 'Перековка не смешивает печати разных биомов';
export const SEAL_REFORGE_FEW = 'Печатей не хватает';
export const SEAL_REFORGE_GOLD = 'Не хватает золота на пошлину';
export const SEAL_REFORGE_ROOM = 'В сумке нет места под новую печать';
export const SEAL_REFORGE_REPEAT = 'Заявка уже исполнена — повтор печатей не тратит';
export const SEAL_REFORGE_DEEP = 'Эту ступень надо сначала увидеть в подземелье — спустись глубже';

/** Что выйдет из перековки: ступень вверх и вид (при `sameTier` вид решает бросок, здесь — `null`). */
export interface SealReforgePlan {
  /** Сколько печатей уйдёт (всего). */
  spend: number;
  /** Ступень, которая получится. */
  tierId: string;
  /** Вид результата: при `sameKind` — тот же; при `sameTier` — `null` (решит бросок сервера). */
  sealId: string | null;
  /** Пошлина золотом. */
  gold: number;
  /** Привязка к биомам у отданных печатей (`sealBiomeKey`) — её же получит результат. */
  biomeKey: string;
}

/**
 * ⭐⭐ Ф5-6: МОЖНО ЛИ ПЕРЕКОВАТЬ — ОДИН ОТВЕТ для карточки кузницы, кнопки Unity и отказа сервера.
 *
 * То же решение, что у `canUpgradeItem`/`canSalvageItem`: окно и сервер обязаны говорить игроку одно и то же,
 * иначе кнопка обещает, а сервер отказывает (или наоборот — кнопка серая там, где можно).
 *
 * `picks` — связка «вид@ступень» → штук, ровно как на алтаре: один словарь на весь обмен печатями.
 */
export function canReforgeSeals(
  reg: ConfigRegistry,
  inventory: readonly Item[],
  picks: SealGains,
  gold: number,
  record = Infinity,
  tabs?: readonly (readonly (Item | null)[])[],
): { ok: false; reason: string } | { ok: true; plan: SealReforgePlan } {
  const rules = sealReforgeRules(reg);
  if (!sealsEnabled(reg) || rules.enabled === false) return { ok: false, reason: SEAL_REFORGE_OFF };
  const entries = Object.entries(picks).filter(([, n]) => Number.isFinite(n) && n > 0);
  if (!entries.length) return { ok: false, reason: SEAL_REFORGE_FEW };

  // Все отданные печати обязаны лежать на ОДНОЙ ступени: лестница идёт по ступеням, и смешивать их значило бы
  // считать «сколько это в единицах силы» — а сила ступени настраивается, и такой обмен стал бы прачечной.
  const live = liveModStats(reg);
  let tierId: string | undefined;
  let onlyKind: string | null = null;
  let biomeKey: string | undefined;
  let have = 0;
  for (const [key, n] of entries) {
    const parsed = parseSealKey(key);
    if (!parsed) return { ok: false, reason: SEAL_REFORGE_MIX };
    const def = sealDef(reg, parsed.sealId);
    if (!def || !sealLive(reg, def, live) || sealTierMul(reg, parsed.tierId) <= 0) return { ok: false, reason: SEAL_REFORGE_MIX };
    if (tierId === undefined) { tierId = parsed.tierId; onlyKind = parsed.sealId; biomeKey = sealBiomeKey(def) }
    else {
      if (parsed.tierId !== tierId) return { ok: false, reason: SEAL_REFORGE_TIER };
      // ⭐⭐ 23.10 (Ф5-6′): ПРИВЯЗКА К БИОМУ — ЧАСТЬ ТОВАРА, А НЕ УКРАШЕНИЕ. Сложить две крипты и пещеру
      // значило бы обменять «годится только в крипте» на «годится везде» (или наоборот) ЗАДАРОМ, а вид
      // результата всё равно пришлось бы брать с потолка. Поэтому складывается только ОДНА привязка.
      if (sealBiomeKey(def) !== biomeKey) return { ok: false, reason: SEAL_REFORGE_BIOME };
      if (parsed.sealId !== onlyKind) onlyKind = null;
    }
    have += Math.floor(n);
  }
  if (rules.mode === 'sameKind' && onlyKind === null) return { ok: false, reason: SEAL_REFORGE_MIX };
  const next = sealNextTier(reg, tierId);
  if (!next) return { ok: false, reason: SEAL_REFORGE_TOP };
  // ⚠ ВОРОТА ПО РЕКОРДУ: ступень, которую дроп ещё не даёт (`minDepth` глубже рекорда), кузнец не выдаёт:
  // иначе старшая сила собиралась бы в городе из мелкого мусора на первых этажах.
  if (rules.gateByRecord !== false && next.minDepth > record) return { ok: false, reason: SEAL_REFORGE_DEEP };
  if (have !== rules.need) return { ok: false, reason: `${SEAL_REFORGE_FEW}: нужно ровно ${rules.need}` };
  if (!carriedEnough(inventory, picks, tabs)) return { ok: false, reason: SEAL_REFORGE_FEW };
  if (gold < rules.goldCost) return { ok: false, reason: SEAL_REFORGE_GOLD };
  return { ok: true, plan: { spend: have, tierId: next.id, sealId: rules.mode === 'sameKind' ? onlyKind : null, gold: rules.goldCost, biomeKey: biomeKey ?? '' } };
}

/** Есть ли столько печатей каждой пары, сколько просят — в сумке И в сундуке. */
function carriedEnough(inventory: readonly Item[], picks: SealGains, tabs?: readonly (readonly (Item | null)[])[]): boolean {
  const have = carriedSealsAll(inventory, tabs);
  for (const [key, n] of Object.entries(picks)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    if ((have[key] ?? 0) < Math.floor(n)) return false;
  }
  return true;
}

/**
 * ⭐⭐ Ф5-6: ПЕРЕКОВАТЬ. Чистая: отдаёт НОВУЮ сумку и что вышло, а сейв меняет зовущий (сервер).
 *
 * ⚠ ВСЁ ИЛИ НИЧЕГО: не сложилось — вернётся отказ, и сумка останется прежней. Частичная перековка означала бы
 * «печати списаны, а новой нет», то есть пропажу награды молча.
 *
 * ⚠ При `mode: 'sameTier'` вид результата решает БРОСОК — и бросок делает зовущий (сервер своим потоком):
 * клиент не выбирает, что ему выпадет, иначе «случайный вид» стал бы целевым бесплатно.
 */
export function reforgeSeals(
  reg: ConfigRegistry,
  inventory: readonly Item[],
  picks: SealGains,
  gold: number,
  dims: Dims,
  rng: { int(a: number, b: number): number },
  uid: () => string,
  record = Infinity,
  tabs?: readonly (readonly (Item | null)[])[],
): { ok: false; reason: string } | { ok: true; inventory: Item[]; item: Item; gold: number; tabs?: Item[][] } {
  const can = canReforgeSeals(reg, inventory, picks, gold, record, tabs);
  if (!can.ok) return can;
  // ⚠ Списываем из СУМКИ И СУНДУКА, сумка первой (её забирает смерть). Копии: отказ ниже ничего не тронет.
  const spent = spendSealsBoth(inventory, tabs, picks);
  if (!spent) return { ok: false, reason: SEAL_REFORGE_FEW };
  const bag = spent.inventory;
  // Вид: при `sameKind` он известен, при `sameTier` решает БРОСОК ЗОВУЩЕГО (сервера) — клиент не выбирает.
  // ⚠ Бросок — только среди видов С ТОЙ ЖЕ привязкой к биому: иначе «три крипты» могли бы выдать печать пещер.
  const kindId = can.plan.sealId
    ?? rollSealKindAmong(liveSealDefs(reg).filter((d) => sealBiomeKey(d) === can.plan.biomeKey), rng)?.id;
  const item = kindId ? buildSeal(reg, kindId, can.plan.tierId, 1, uid()) : null;
  if (!item) return { ok: false, reason: SEAL_REFORGE_OFF };
  item.origin = 'craft';   // вышла из рук кузнеца, а не найдена: счёт находок её не считает
  // ⚠ МЕСТО — ЧАСТЬ СДЕЛКИ. Три печати уходят, но освободившаяся клетка не гарантирована (брали из стека в
  // пять), а новая ступень может не иметь своего стека. Не влезло — отказ, и сумка остаётся прежней: копию
  // `bag` мы просто выбрасываем, настоящую не трогали.
  if (!addToInventory(bag, item, dims, sealStackMax(reg))) return { ok: false, reason: SEAL_REFORGE_ROOM };
  // ⚠ Результат кладём в СУМКУ, а не в сундук: игрок видит, что получил, и несёт это на алтарь сам.
  return { ok: true, inventory: bag, item, gold: gold - can.plan.gold, ...(tabs ? { tabs: spent.tabs } : {}) };
}

// ── Ф5-6′ (23.10): перекат вида ───────────────────────────────────────────────

/** Ручки переката (`balance.seals.reroll`). */
export function sealRerollRules(reg: ConfigRegistry) {
  return reg.get('balance').seals.reroll;
}

export const SEAL_REROLL_OFF = 'Перекат печатей отключён';
export const SEAL_REROLL_ONE = 'Перекат берёт РОВНО одну печать';
export const SEAL_REROLL_ALONE = 'Другого вида этой привязки нет — перекатывать не во что';

/** Что выйдет из переката: та же ступень, другой вид (решит бросок сервера), цена золотом. */
export interface SealRerollPlan {
  /** Что перекатываем. */
  sealId: string;
  tierId: string;
  /** Пошлина золотом (× множитель ступени). */
  gold: number;
  /** Привязка к биомам — у результата та же. */
  biomeKey: string;
}

/** Пошлина переката печати этой ступени: база × множитель ступени (старшая печать дороже). */
export function sealRerollCost(reg: ConfigRegistry, tierId: string | undefined): number {
  return Math.round(sealRerollRules(reg).goldCost * Math.max(0, sealTierMul(reg, tierId)));
}

/**
 * ⭐⭐ Ф5-6′ (23.10): МОЖНО ЛИ ПЕРЕКАТИТЬ — ОДИН ОТВЕТ для карточки кузницы, кнопки Unity и отказа сервера
 * (та же дисциплина, что у `canReforgeSeals`: окно и сервер обязаны говорить игроку одно и то же).
 *
 * ⚠ РОВНО ОДНА ПЕЧАТЬ: перекат — это «не тот вид», а не обмен силы. Две печати за одну означали бы второй
 * путь наверх мимо перековки, и `need × mul` перестал бы что-либо держать.
 */
export function canRerollSeal(
  reg: ConfigRegistry,
  inventory: readonly Item[],
  picks: SealGains,
  gold: number,
  tabs?: readonly (readonly (Item | null)[])[],
): { ok: false; reason: string } | { ok: true; plan: SealRerollPlan } {
  const rules = sealRerollRules(reg);
  if (!sealsEnabled(reg) || rules.enabled === false) return { ok: false, reason: SEAL_REROLL_OFF };
  const entries = Object.entries(picks).filter(([, n]) => Number.isFinite(n) && n > 0);
  if (entries.length !== 1 || Math.floor(entries[0]![1]) !== 1) return { ok: false, reason: SEAL_REROLL_ONE };
  const parsed = parseSealKey(entries[0]![0]);
  if (!parsed) return { ok: false, reason: SEAL_REROLL_ONE };
  const def = sealDef(reg, parsed.sealId);
  if (!def || !sealLive(reg, def) || sealTierMul(reg, parsed.tierId) <= 0) return { ok: false, reason: SEAL_REROLL_OFF };
  const key = sealBiomeKey(def);
  // ⚠ Другой вид обязан СУЩЕСТВОВАТЬ: иначе игрок платит золото за ту же печать (`differs` держит это правилом).
  const others = liveSealDefs(reg).filter((d) => sealBiomeKey(d) === key && d.id !== def.id);
  if (rules.differs !== false && !others.length) return { ok: false, reason: SEAL_REROLL_ALONE };
  if (!carriedEnough(inventory, picks, tabs)) return { ok: false, reason: SEAL_REFORGE_FEW };
  const cost = sealRerollCost(reg, parsed.tierId);
  if (gold < cost) return { ok: false, reason: SEAL_REFORGE_GOLD };
  return { ok: true, plan: { sealId: def.id, tierId: parsed.tierId, gold: cost, biomeKey: key } };
}

/**
 * ⭐⭐ Ф5-6′: ПЕРЕКАТИТЬ ВИД. Чистая: отдаёт НОВУЮ сумку и что вышло, сейв меняет зовущий (сервер).
 *
 * ⚠ ВСЁ ИЛИ НИЧЕГО, как у перековки: не сложилось — отказ, и сумка прежняя.
 * ⚠ Ступень НЕ МЕНЯЕТСЯ, штука одна: сила до и после равна ровно сама себе, и проверять «не прачечная» тут
 * нечего по построению — но сторож на это всё равно есть (`sealReroll.test.ts`), потому что правило важнее кода.
 */
export function rerollSeal(
  reg: ConfigRegistry,
  inventory: readonly Item[],
  picks: SealGains,
  gold: number,
  dims: Dims,
  rng: { int(a: number, b: number): number },
  uid: () => string,
  tabs?: readonly (readonly (Item | null)[])[],
): { ok: false; reason: string } | { ok: true; inventory: Item[]; item: Item; gold: number; tabs?: Item[][] } {
  const can = canRerollSeal(reg, inventory, picks, gold, tabs);
  if (!can.ok) return can;
  const spent = spendSealsBoth(inventory, tabs, picks);
  if (!spent) return { ok: false, reason: SEAL_REFORGE_FEW };
  const bag = spent.inventory;
  const rules = sealRerollRules(reg);
  const pool = liveSealDefs(reg).filter((d) => sealBiomeKey(d) === can.plan.biomeKey && (rules.differs === false || d.id !== can.plan.sealId));
  const kindId = rollSealKindAmong(pool, rng)?.id;
  const item = kindId ? buildSeal(reg, kindId, can.plan.tierId, 1, uid()) : null;
  if (!item) return { ok: false, reason: SEAL_REROLL_ALONE };
  item.origin = 'craft';   // вышла из рук кузнеца, а не найдена
  if (!addToInventory(bag, item, dims, sealStackMax(reg))) return { ok: false, reason: SEAL_REFORGE_ROOM };
  return { ok: true, inventory: bag, item, gold: gold - can.plan.gold, ...(tabs ? { tabs: spent.tabs } : {}) };
}
