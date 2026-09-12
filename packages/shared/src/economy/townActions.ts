import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import type { Item, EquipSlot, Rarity, ConsumableUse } from '../types/items.js';
import { ATTRIBUTES, type Attribute, type Attributes } from '../types/attributes.js';
import { finalAttributes, meetsRequirements, modifiersFromItems } from '../formulas/stats.js';
import { rollAffixes, nextTier, retierItem } from '../formulas/itemgen.js';
import type { Rng } from '../formulas/rng.js';
import { addToInventory, hasSpace, placeWithDisplacement, type Dims } from '../inventory/grid.js';
import type { DebuffState } from '../world/debuffs.js';
import { socketsOpen, insertById, insertUnlocked, insertFits } from '../session/inserts.js';
import { canSalvage, salvageFromItem, salvageRuleFor, tierOfRarity, type SalvageRng } from '../formulas/salvage.js';
import { canAffordBoth, giveMaterials, missingForBoth, spendBoth, depositCarried,
  type MaterialCost, type MaterialWallet } from './materials.js';
import { uuidv7 } from '../formulas/uuid.js';

/**
 * АВТОРИТЕТНЫЕ операции города над `SaveState` (магазин/экип/распределение) — чистые,
 * для сервера (анти-чит: клиент шлёт команду, сервер исполняет здесь). Переиспользуют
 * общие формулы/сетку инвентаря; та же истина, что раньше правил клиент. Мутируют `save`,
 * возвращают `{ok, reason?}`.
 */
export interface ActionResult {
  ok: boolean;
  reason?: string;
}

/** Живые витальные поля цели зелья (общий тип для клиента-GameState и серверного PlayerEntity). */
export interface Vitals { hp: number; mana: number; debuffs: DebuffState; }

/**
 * Применяет мгновенный эффект расходника (лечение/мана/снятие статусов) к витальным
 * полям — ЕДИНАЯ истина для клиента и сервера. Возвращает false, если ничего не
 * изменилось (полное HP у чистого лечения). Бафф-моды (buffMods) обрабатываются
 * отдельно на стороне вызывающего (у клиента и сервера — разные каналы).
 */
export function applyConsumable(t: Vitals, use: ConsumableUse, maxHp: number, maxMana: number): boolean {
  let did = false;
  const heal = (use.heal ?? 0) + (use.healPct ?? 0) * maxHp;
  if (heal > 0 && t.hp < maxHp) { t.hp = Math.min(maxHp, t.hp + heal); did = true; }
  const mana = (use.mana ?? 0) + (use.manaPct ?? 0) * maxMana;
  if (mana > 0 && t.mana < maxMana) { t.mana = Math.min(maxMana, t.mana + mana); did = true; }
  if (use.cure) {
    const keys = Object.keys(t.debuffs);
    if (keys.length) { for (const k of keys) delete (t.debuffs as Record<string, unknown>)[k]; did = true; }
  }
  return did;
}

// ── Цены (совпадают с бывшим town/pricing.ts) ────────────────────────────────
type Rarities = ConfigShapes['rarities'];
const priceMult = (rarities: Rarities, id: Rarity): number => rarities.find((r) => r.id === id)?.priceMult ?? 1;
/** Оценочная стоимость предмета в магазине (учёт iLvl + кол-ва аффиксов + редкости). */
export function shopItemValue(item: Item, rarities: Rarities): number {
  return Math.round((15 + item.itemLevel * 4 + item.affixes.length * 12) * priceMult(rarities, item.rarity));
}
export function shopSellPrice(item: Item, rarities: Rarities): number {
  return Math.max(1, Math.floor(shopItemValue(item, rarities) * 0.4));
}
export function shopBuyPrice(item: Item, rarities: Rarities): number {
  return shopItemValue(item, rarities);
}

const dimsOf = (reg: ConfigRegistry): Dims => reg.get('balance').inventory;
const stackOf = (reg: ConfigRegistry): number => reg.get('balance').inventory.materialStack;
const equippedItems = (save: SaveState): Item[] => Object.values(save.equipment).filter(Boolean) as Item[];

/**
 * АВТОРИТЕТНАЯ перекладка предмета инвентаря в клетку (x,y) с вытеснением одного предмета (D2).
 * Раскладка инвентаря считается на сервере: клиент шлёт `moveItem`, сервер применяет здесь и
 * возвращает `saveUpdate` — единая истина, без расхождения client/server.
 */
export function moveInventoryItem(reg: ConfigRegistry, save: SaveState, uid: string, x: number, y: number): ActionResult {
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  return placeWithDisplacement(save.inventory, item, x, y, dimsOf(reg))
    ? { ok: true }
    : { ok: false, reason: 'Не помещается' };
}

/** Эфф. атрибуты по надетому (кроме `exclude`) — для проверки требований экипа. */
function effectiveAttrs(save: SaveState, exclude?: Item): Attributes {
  const items = equippedItems(save).filter((i) => i.uid !== exclude?.uid);
  return finalAttributes(save.attributes, modifiersFromItems(items));
}

// ── Магазин ──────────────────────────────────────────────────────────────────
export function buyItem(reg: ConfigRegistry, save: SaveState, item: Item): ActionResult {
  const price = shopBuyPrice(item, reg.get('rarities'));
  if (save.gold < price) return { ok: false, reason: 'Недостаточно золота' };
  if (!hasSpace(save.inventory, item.gridW, item.gridH, dimsOf(reg))) return { ok: false, reason: 'Нет места' };
  save.gold -= price;
  addToInventory(save.inventory, item, dimsOf(reg));
  return { ok: true };
}

export function sellItem(reg: ConfigRegistry, save: SaveState, uid: string): ActionResult {
  const idx = save.inventory.findIndex((i) => i.uid === uid);
  if (idx < 0) return { ok: false, reason: 'Предмет не в инвентаре' };
  const [it] = save.inventory.splice(idx, 1);
  save.gold += shopSellPrice(it!, reg.get('rarities'));
  return { ok: true };
}

// ── Кузница (авторитетно; раньше мутировал клиент → откатывалось сейвом) ──────
/**
 * ЦЕНА УЛУЧШЕНИЯ В МАТЕРИАЛАХ — лестница по редкости вещи (docs/ECONOMY.md, Ч5).
 *
 * Обычная просит только ржавое, магическая — ржавое И чистое, редкая — ржавое, чистое И калёное.
 * Каждая следующая редкость ДОБАВЛЯЕТ ступень: убери среднюю у редких — и чистое железо станет
 * мусором ровно тогда, когда игрок перерос магические вещи, а приходить не перестанет.
 *
 * СЕМЬЯ материала берётся из ПРАВИЛА РАЗБОРА той же вещи: меч чинится железом, лук — деревом,
 * латы — пластинами. Одна таблица описывает и что вещь даёт, и что она стоит, поэтому разойтись
 * они не могут. Берётся первая (главная) семья правила: у топора это железо, дерево — довесок.
 *
 * Пустая цена (нет правила / редкость с нулевой ступенью) — значит улучшать нечем, и это ОТКАЗ,
 * а не «бесплатно»: иначе уники чинились бы даром.
 */
export function upgradeCost(reg: ConfigRegistry, item: Item): MaterialCost {
  const u = reg.get('balance').forgePrices.upgradeMaterials;
  return materialLadder(reg, item, [u.tier1, u.tier2, u.tier3]);
}

/**
 * ЛЕСТНИЦА ПО РЕДКОСТИ — общий расчёт цены для улучшения и починки.
 *
 * Обычная вещь просит только первую ступень, магическая — первую И вторую, редкая — все три:
 * каждая следующая редкость ДОБАВЛЯЕТ ступень. Семья материала берётся из ПРАВИЛА РАЗБОРА той же
 * вещи, поэтому меч чинится железом, лук деревом, латы пластинами — и «что вещь даёт» и «что
 * она стоит» описаны одной таблицей, разойтись они не могут.
 *
 * Пустой результат — «кузнец эту вещь не трогает» (уник либо нет правила), и это ОТКАЗ,
 * а не «бесплатно».
 */
function materialLadder(reg: ConfigRegistry, item: Item, need: readonly number[]): MaterialCost {
  const bal = reg.get('balance');
  const tier = tierOfRarity(item.rarity, bal.salvage.rarityTier);
  const rule = salvageRuleFor(item, weaponClassOf(reg, item), reg.get('salvage-rules'));
  const first = rule?.yields?.[0]?.materialId;
  if (tier <= 0 || !first) return {};
  const mats = reg.get('craft-materials');
  const family = mats.find((m) => m.id === first)?.family;
  if (!family) return {};
  const out: MaterialCost = {};
  for (let t = 1; t <= Math.min(tier, need.length); t++) {
    const n = need[t - 1]!;
    const mat = mats.find((m) => m.family === family && m.tier === t && m.enabled);
    if (n > 0 && mat) out[mat.id] = n;
  }
  return out;
}

/**
 * ⭐ УЛУЧШЕНИЕ = ПОДЪЁМ ТИРА на одну ступень (Убогий → Старый → … → потолок базы).
 *
 * Раньше здесь была заглушка: статы множились ×1.2 без предела, хотя ключ цены всегда назывался
 * `upgradeTier`. Причина — у предмета не было поля тира вовсе, и поднимать было нечего.
 *
 * Лестница КОНЕЧНА по построению: потолок задаёт сама база (`maxTier`), поэтому «бесконечное
 * улучшение» невозможно, а не ограничено бюджетом. Статы и требования пересчитываются ОТ БАЗЫ,
 * так что кузнечный «Отличный» равен найденному «Отличному» — иначе тир перестал бы значить.
 */
export function forgeUpgrade(reg: ConfigRegistry, save: SaveState, uid: string, wallet: MaterialWallet): ActionResult {
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  if (item.broken) return { ok: false, reason: 'Сперва почини' };
  if (!reg.get('items.base').some((b) => b.id === item.baseId)) {
    return { ok: false, reason: 'Кузнец не знает такой вещи' };
  }
  // ⚠ Результат считает `upgradedItem` — ТА ЖЕ функция, которой кузница рисует предпросмотр
  // «было → станет». Будь здесь своя копия расчёта, скидка на требования или потолок их суммы
  // разъехались бы молча, и окно обещало бы игроку не то, за что он платит.
  const next = upgradedItem(reg, item);
  if (!next) return { ok: false, reason: 'Лучше эту вещь уже не сделать' };
  const gold = reg.get('balance').forgePrices.upgradeTier;
  const mats = upgradeCost(reg, item);
  if (!Object.keys(mats).length) return { ok: false, reason: 'Эту вещь кузнец не улучшает' };
  if (save.gold < gold) return { ok: false, reason: 'Недостаточно золота' };
  if (!canAffordBoth(save.inventory, wallet, mats)) {
    return { ok: false, reason: `Не хватает материалов: ${describeCost(reg, missingForBoth(save.inventory, wallet, mats))}` };
  }
  // ⚠ Списываем ОБА ресурса и только потом меняем предмет: иначе отказ на середине оставил бы
  // игрока без золота и без улучшения.
  save.gold -= gold;
  spendBoth(save.inventory, wallet, mats);
  Object.assign(item, next);
  return { ok: true };
}

/** Какой тир будет следующим (для подписи кнопки) — или `undefined`, если вещь на потолке. */
export function nextTierOf(reg: ConfigRegistry, item: Item): { id: string; name: string } | undefined {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  return base ? nextTier(reg.get('item-tiers'), base, item.tier) : undefined;
}

/**
 * КАКОЙ СТАНЕТ ВЕЩЬ ПОСЛЕ УЛУЧШЕНИЯ — источник предпросмотра «было → станет» И самого
 * улучшения (`forgeUpgrade` зовёт эту же функцию). `undefined` — нет базы либо вещь на потолке.
 */
export function upgradedItem(reg: ConfigRegistry, item: Item): Item | undefined {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base) return undefined;
  const tier = nextTier(reg.get('item-tiers'), base, item.tier);
  if (!tier) return undefined;
  const bal = reg.get('balance');
  return retierItem(base, item, tier, {
    reqDiscount: bal.forgePrices.upgradeReqDiscount,
    maxReqTotal: bal.maxTotalRequirement,
  });
}

/**
 * СКОЛЬКО ДАСТ РАЗБОР — вилкой «от и до».
 *
 * ⚠ Выход случаен, поэтому одно число было бы враньём, а своя формула среднего — вторым
 * источником правды. Вместо этого дважды зовём НАСТОЯЩИЙ расчёт (`salvageYield`): сперва с
 * броском, всегда дающим минимум, потом — максимум. Разойтись с реальным разбором он не может.
 */
export function salvageRange(
  reg: ConfigRegistry, item: Item, inField: boolean,
): ActionResult & { range: Record<string, { min: number; max: number }> } {
  const lo = salvageYield(reg, item, { int: (a) => a, chance: () => false }, inField);
  if (!lo.ok) return { ...lo, range: {} };
  const hi = salvageYield(reg, item, { int: (_a, b) => b, chance: () => true }, inField);
  const range: Record<string, { min: number; max: number }> = {};
  for (const id of new Set([...Object.keys(lo.gains), ...Object.keys(hi.gains)])) {
    const min = lo.gains[id] ?? 0;
    range[id] = { min, max: Math.max(hi.gains[id] ?? 0, min) };
  }
  return { ok: true, range };
}

/**
 * СДАТЬ ВСЁ СЫРЬЁ ИЗ СУМКИ В СУНДУК. Одной кнопкой намеренно: раскладывать полтора десятка стеков
 * руками после каждого забега — это не жанровая норма, а лишняя работа (в PoE ровно для этого
 * и сделана вкладка валюты). Возвращает, сколько единиц ушло.
 */
export function depositMaterials(save: SaveState, wallet: MaterialWallet): ActionResult & { moved: number } {
  const moved = depositCarried(save.inventory, wallet);
  return moved > 0 ? { ok: true, moved } : { ok: false, reason: 'Сырья в сумке нет', moved: 0 };
}

/** «Ржавое железо 12 · Чистое железо 5» — одна подпись для кнопки, тултипа и текста отказа. */
export function describeCost(reg: ConfigRegistry, cost: MaterialCost): string {
  const defs = reg.get('craft-materials');
  return Object.entries(cost)
    .map(([id, n]) => `${defs.find((m) => m.id === id)?.name ?? id} ${n}`)
    .join(' · ');
}
/** Реролл аффиксов: заново катит столько же аффиксов из пула (rng — от вызывающего). Цена `forgePrices.rerollAffix`. */
export function forgeReroll(reg: ConfigRegistry, save: SaveState, uid: string, rng: Rng): ActionResult {
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  if (item.broken) return { ok: false, reason: 'Сперва почини' };
  // ⚠ ПРЕДЕЛ ПЕРЕКАТОК. Подъём тира ограничен потолком базы сам по себе, а перекатка крутит
  // случайность: без предела её жмут, пока не выпадет идеал, и редкость аффиксов перестаёт
  // что-либо значить. Считаем потраченное, чтобы отсутствие поля значило «ни разу».
  const limit = reg.get('balance').forgePrices.rerollLimit;
  if ((item.rerolls ?? 0) >= limit) return { ok: false, reason: 'Эту вещь перекатывать больше нельзя' };
  const cost = reg.get('balance').forgePrices.rerollAffix;
  if (save.gold < cost) return { ok: false, reason: 'Недостаточно золота' };
  save.gold -= cost;
  item.rerolls = (item.rerolls ?? 0) + 1;
  const rDef = reg.get('rarities').find((r) => r.id === item.rarity);
  item.affixes = rollAffixes(
    reg.get('affixes'),
    { kind: item.kind ?? '', slot: item.slot, attackType: item.attackType, damageKind: item.damageKind },
    item.rarity,
    { minAffixes: rDef?.minAffixes ?? 1, maxAffixes: rDef?.maxAffixes ?? 1, maxPrefix: rDef?.maxPrefix ?? 3, maxSuffix: rDef?.maxSuffix ?? 3 },
    item.itemLevel, rng);
  return { ok: true };
}

/**
 * РАЗБОР У КУЗНЕЦА — полный выход материалов (docs/ECONOMY.md, Ч3). Полевой разбор той же
 * формулой, но с долей `balance.salvage.fieldYield`, живёт в сессии: там есть мир и позиция.
 * ⚠ Отказ ДО списания: разбор уничтожает вещь, и «правила нет» не должно съедать её впустую.
 */
export function forgeSalvage(reg: ConfigRegistry, save: SaveState, uid: string, rng: SalvageRng): ActionResult {
  const idx = save.inventory.findIndex((i) => i.uid === uid);
  if (idx < 0) return { ok: false, reason: 'Предмет не в инвентаре' };
  const item = save.inventory[idx]!;
  const gains = salvageYield(reg, item, rng, false);
  if (!gains.ok) return gains;
  save.inventory.splice(idx, 1);
  // Вещь уже снята с полки — место под сырьё освободилось, и оно почти всегда доливается в стек.
  giveMaterials(save, gains.gains, reg.get('craft-materials'), dimsOf(reg), stackOf(reg), uuidv7);
  return { ok: true };
}

/**
 * РАЗБОР НА МЕСТЕ, прямо в подземелье: та же формула, но выход `balance.salvage.fieldYield`.
 * Ни верстака, ни возврата в город — выделил трофей и переработал. Мира и позиции не требует,
 * поэтому живёт здесь, рядом с кузнечным близнецом, а не в сессии.
 */
export function fieldSalvage(reg: ConfigRegistry, save: SaveState, uid: string, rng: SalvageRng): ActionResult {
  const idx = save.inventory.findIndex((i) => i.uid === uid);
  if (idx < 0) return { ok: false, reason: 'Предмет не в инвентаре' };
  const out = salvageYield(reg, save.inventory[idx]!, rng, true);
  if (!out.ok) return out;
  save.inventory.splice(idx, 1);
  giveMaterials(save, out.gains, reg.get('craft-materials'), dimsOf(reg), stackOf(reg), uuidv7);
  return { ok: true };
}

/**
 * Общий расчёт разбора для кузницы и поля: находит правило, проверяет допустимость и катает выход.
 * Один шов — чтобы «что даст разбор» в подсказке и то, что реально начислится, не разошлись.
 */
export function salvageYield(
  reg: ConfigRegistry,
  item: Item,
  rng: SalvageRng,
  inField: boolean,
): ActionResult & { gains: Record<string, number> } {
  const can = canSalvageItem(reg, item, inField);
  if (!can.ok) return { ...can, gains: {} };
  const rules = reg.get('salvage-rules');
  const tuning = reg.get('balance').salvage;
  const mats = reg.get('craft-materials');
  const gains = salvageFromItem(item, weaponClassOf(reg, item), rules, tuning, rng, {
    inField,
    knownMaterial: (id) => mats.some((c) => c.id === id && c.enabled),
  });
  if (!Object.keys(gains).length) return { ok: false, reason: 'Разбор ничего не дал бы', gains: {} };
  return { ok: true, gains };
}

/**
 * МОЖНО ЛИ РАЗОБРАТЬ — ОДИН ответ для кнопки в UI и для отказа сервера. Если развести их по
 * двум местам, кнопка будет предлагать то, что сервер отклоняет.
 */
export function canSalvageItem(reg: ConfigRegistry, item: Item, inField: boolean): ActionResult {
  return canSalvage(item, weaponClassOf(reg, item), reg.get('salvage-rules'), reg.get('balance').salvage, inField);
}

/**
 * Класс оружия правилам разбора нужен. Сперва берём его ИЗ САМОГО ПРЕДМЕТА (`buildItem`
 * копирует его с базы): тогда вещь в сумке остаётся разбираемой, даже если её базу убрали
 * из конфига. База — запасной путь для старых сейвов, где поля ещё нет.
 */
function weaponClassOf(reg: ConfigRegistry, item: Item): string | undefined {
  if (item.weaponClass) return item.weaponClass;
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  return base && base.kind === 'weapon' ? base.weaponClass : undefined;
}

/** Цена починки сломанного трофея: та же лестница по редкости, что у улучшения, но дешевле. */
export function repairCost(reg: ConfigRegistry, item: Item): MaterialCost {
  const m = reg.get('balance').forgePrices.repairMaterials;
  return materialLadder(reg, item, [m.tier1, m.tier2, m.tier3]);
}

/**
 * ПОЧИНКА СЛОМАННОГО ТРОФЕЯ — золото + материалы. После неё это обычная вещь своего тира,
 * её можно носить и улучшать.
 *
 * ⚠ Чинить дороже, чем даёт разбор той же вещи: иначе разбор не выбирали бы никогда.
 * Платим за ВЕЩЬ, а не за материалы в ней.
 */
export function forgeRepair(reg: ConfigRegistry, save: SaveState, uid: string, wallet: MaterialWallet): ActionResult {
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  if (!item.broken) return { ok: false, reason: 'Вещь цела' };
  const gold = reg.get('balance').forgePrices.repairBroken;
  const mats = repairCost(reg, item);
  if (save.gold < gold) return { ok: false, reason: 'Недостаточно золота' };
  if (Object.keys(mats).length && !canAffordBoth(save.inventory, wallet, mats)) {
    return { ok: false, reason: `Не хватает материалов: ${describeCost(reg, missingForBoth(save.inventory, wallet, mats))}` };
  }
  save.gold -= gold;
  spendBoth(save.inventory, wallet, mats);
  delete item.broken;
  return { ok: true };
}

// ── Экипировка ───────────────────────────────────────────────────────────────
export function equip(reg: ConfigRegistry, save: SaveState, uid: string): ActionResult {
  const dims = dimsOf(reg);
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  if (!item.slot) return { ok: false, reason: 'Нельзя надеть' };
  // ⚠ Сломанный трофей носить нельзя — сперва к кузнецу (или на разбор). Проверка ЗДЕСЬ, в одной
  // авторитетной точке экипировки: клиент её только дублирует подсказкой.
  if (item.broken) return { ok: false, reason: 'Сломано — почини у кузнеца' };
  const slot = item.slot;
  if (!meetsRequirements(item, effectiveAttrs(save, item))) return { ok: false, reason: 'Недостаточно атрибутов' };

  const twoH = slot === 'weapon' && (item.hands ?? 1) >= 2;
  const mainTwoH = (save.equipment.weapon?.hands ?? 1) >= 2;
  if (slot === 'offhand' && mainTwoH) return { ok: false, reason: 'Занято двумя руками' };

  const prev = save.equipment[slot];
  const displaced = twoH ? save.equipment.offhand : undefined;
  const need: Item[] = [];
  if (prev) need.push(prev);
  if (displaced) need.push(displaced);
  // Смена пояса на меньший: колбы КОМПАКТИМ под новую ёмкость (первые N остаются в поясе), а лишние
  // возвращаем в инвентарь. Иначе колбы сверх beltSlots висли в save.belt вне видимых слотов («лимбо»).
  const newBeltCap = slot === 'belt' ? (item.beltSlots ?? 0) : -1;
  if (slot === 'belt') { for (const c of save.belt.filter((x): x is Item => !!x).slice(newBeltCap)) need.push(c); }

  const idx = save.inventory.findIndex((i) => i.uid === uid);
  save.inventory.splice(idx, 1);
  for (const it of need) {
    if (!hasSpace(save.inventory, it.gridW, it.gridH, dims)) {
      save.inventory.splice(idx, 0, item); // откат
      return { ok: false, reason: 'Нет места для снятого' };
    }
  }
  item.pos = null;
  save.equipment[slot] = item;
  if (twoH && displaced) delete save.equipment.offhand;
  if (slot === 'belt') { const kept = save.belt.filter((x): x is Item => !!x).slice(0, newBeltCap); save.belt = Array.from({ length: newBeltCap }, (_, i) => kept[i] ?? null); }
  for (const it of need) addToInventory(save.inventory, it, dims);
  return { ok: true };
}

export function unequip(reg: ConfigRegistry, save: SaveState, slot: string): ActionResult {
  const s = slot as EquipSlot;
  const it = save.equipment[s];
  if (!it) return { ok: false, reason: 'Слот пуст' };
  const dims = dimsOf(reg);
  // Снятие пояса: ёмкость станет 0 → все колбы из пояса тоже уходят в инвентарь (иначе висли бы в лимбо).
  const beltPotions = s === 'belt' ? save.belt.filter((x): x is Item => !!x) : [];
  const need: Item[] = [it, ...beltPotions];
  for (const n of need) if (!hasSpace(save.inventory, n.gridW, n.gridH, dims)) return { ok: false, reason: 'Нет места' };
  delete save.equipment[s];
  if (s === 'belt') save.belt = [];
  for (const n of need) addToInventory(save.inventory, n, dims);
  return { ok: true };
}

// ── Атрибуты / респек ─────────────────────────────────────────────────────────
export function allocAttr(save: SaveState, attr: string): ActionResult {
  if (!ATTRIBUTES.includes(attr as Attribute)) return { ok: false, reason: 'Неизвестный атрибут' };
  if (save.unspentAttributePoints <= 0) return { ok: false, reason: 'Нет очков атрибутов' };
  save.attributes[attr as Attribute] += 1;
  save.unspentAttributePoints -= 1;
  return { ok: true };
}

export function respec(reg: ConfigRegistry, save: SaveState): ActionResult {
  const cost = reg.get('balance').respecCost;
  if (save.gold < cost) return { ok: false, reason: 'Недостаточно золота' };
  const cls = reg.get('classes').find((c) => c.id === save.classId);
  if (!cls) return { ok: false, reason: 'Класс не найден' };
  const base = cls.startAttributes as Attributes;
  let refunded = 0;
  for (const a of ATTRIBUTES) refunded += Math.max(0, save.attributes[a] - base[a]);
  save.attributes = { ...base };
  save.unspentAttributePoints += refunded;
  save.gold -= cost;
  return { ok: true };
}

// ── Скиллы: единое ДРЕВО СКИЛОВ (только очки, по смежности; класс-ветка — своему классу) ──
function skillNeighbors(tree: ConfigShapes['skill-tree'], id: string): string[] {
  const out: string[] = [];
  for (const [a, b] of tree.edges) { if (a === id) out.push(b); else if (b === id) out.push(a); }
  return out;
}
export function allocActive(reg: ConfigRegistry, save: SaveState, nodeId: string): ActionResult {
  const tree = reg.get('skill-tree');
  const node = tree.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: 'Узел не найден' };
  const branch = tree.branches.find((b) => b.id === node.branchId);
  if (branch?.classId && branch.classId !== save.classId) return { ok: false, reason: 'Ветка другого класса' };
  const rank = save.skills[nodeId] ?? 0;
  if (rank >= node.maxRank) return { ok: false, reason: 'Максимальный ранг' };
  if (save.level < node.levelReq) return { ok: false, reason: `Требуется уровень ${node.levelReq}` };
  // Доступность по смежности: вход ветки, уже вложен, или сосед вложен.
  const allocatable = rank > 0 || tree.entryNodes.includes(nodeId)
    || skillNeighbors(tree, nodeId).some((n) => (save.skills[n] ?? 0) > 0);
  if (!allocatable) return { ok: false, reason: 'Недоступный вход или нет смежного узла' };
  if (node.cost.type !== 'points') return { ok: false, reason: 'Неверный тип стоимости' };
  if (save.unspentSkillPoints < node.cost.amount) return { ok: false, reason: 'Недостаточно очков скиллов' };
  save.unspentSkillPoints -= node.cost.amount;
  save.skills[nodeId] = rank + 1;
  if (rank === 0 && node.effect.active) {
    const slot = save.hotbar.findIndex((s) => s === null);
    if (slot >= 0) save.hotbar[slot] = nodeId;
  }
  return { ok: true };
}

// ── Гнёзда активных скилов (модульные скилы) ──────────────────────────────────
/**
 * ПРОВЕРКА ОДНА НА ОБЕ КОМАНДЫ: что узел вообще можно оснащать и что гнездо существует.
 * Вынесена отдельно, чтобы «вынуть» не оказалось слабее «вставить»: дыры любят именно асимметрию.
 */
function socketTarget(reg: ConfigRegistry, save: SaveState, nodeId: string, slot: number):
  { ok: true; slots: (string | null)[] } | { ok: false; reason: string } {
  const tree = reg.get('skill-tree');
  const node = tree.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: 'Узел не найден' };
  if (!node.effect.active) return { ok: false, reason: 'У этого узла нет активного скила' };
  const branch = tree.branches.find((b) => b.id === node.branchId);
  if (branch?.classId && branch.classId !== save.classId) return { ok: false, reason: 'Ветка другого класса' };
  const open = socketsOpen(reg, save.skills[nodeId] ?? 0);
  if (open === 0) return { ok: false, reason: 'Скил не выучен' };
  if (slot < 0 || slot >= open) return { ok: false, reason: `Гнездо ещё не открыто (есть ${open})` };
  save.sockets ??= {};
  const slots = (save.sockets[nodeId] ??= []);
  while (slots.length < open) slots.push(null);   // выравниваем под число открытых гнёзд
  return { ok: true, slots };
}

/**
 * ВСТАВИТЬ вставку в гнездо. Авторитетно: клиент шлёт намерение, решает сервер.
 *
 * Резолв (`session/inserts.ts`) и так игнорирует негодное, но молча — и это правильно для случая
 * «конфиг поменялся под собранным скилом». Но ПРИ ВСТАВКЕ молчание недопустимо: игрок должен
 * узнать ПОЧЕМУ не влезло, а не видеть пустое гнездо без объяснений.
 */
export function socketInsert(reg: ConfigRegistry, save: SaveState, nodeId: string, slot: number, insertId: string): ActionResult {
  const t = socketTarget(reg, save, nodeId, slot);
  if (!t.ok) return { ok: false, reason: t.reason };
  const ins = insertById(reg, insertId);
  if (!ins) return { ok: false, reason: 'Вставка не найдена' };
  if (!insertUnlocked(reg, save, insertId)) return { ok: false, reason: 'Вставка не открыта в дереве' };
  const active = reg.get('skill-tree').nodes.find((n) => n.id === nodeId)!.effect.active!;
  // Оружие берём из экипировки: вставка вроде «пробойника» осмысленна только с луком в руках.
  if (!insertFits(ins, active, save.equipment.weapon?.weaponClass)) return { ok: false, reason: 'Этой вставке здесь не место' };
  // ОДНА ВСТАВКА КАЖДОГО ТИПА — главное правило системы: именно оно делает сборку выбором.
  for (let i = 0; i < t.slots.length; i++) {
    if (i === slot) continue;
    const other = t.slots[i];
    if (other && insertById(reg, other)?.type === ins.type) {
      return { ok: false, reason: `Вставка этого типа уже стоит в другом гнезде` };
    }
  }
  t.slots[slot] = insertId;
  return { ok: true };
}

/** ВЫНУТЬ вставку из гнезда. Без пошлины: вставка открыта деревом и не тратится — терять нечего. */
export function socketClear(reg: ConfigRegistry, save: SaveState, nodeId: string, slot: number): ActionResult {
  const t = socketTarget(reg, save, nodeId, slot);
  if (!t.ok) return { ok: false, reason: t.reason };
  if (!t.slots[slot]) return { ok: false, reason: 'Гнездо и так пусто' };
  t.slots[slot] = null;
  return { ok: true };
}

/** Комиссия сброса дерева скилов: `skillRespecCostPerPoint` × суммарно вложенных очков. */
export function skillRespecFee(reg: ConfigRegistry, save: SaveState): number {
  let ranks = 0;
  for (const rank of Object.values(save.skills)) if (rank > 0) ranks += rank;
  return ranks * reg.get('balance').skillRespecCostPerPoint;
}

/**
 * Сбрасывает ВСЁ дерево скилов за золото. Возвращает все вложенные очки скиллов
 * (unspentSkillPoints += Σ рангов), берёт комиссию `skillRespecFee` (за вложенное очко).
 * Бинды действий, ссылавшиеся на сброшенные скиллы, очищаются (ЛКМ→атака, ПКМ/хотбар→пусто).
 */
export function respecSkills(reg: ConfigRegistry, save: SaveState): ActionResult {
  let ranks = 0;
  for (const rank of Object.values(save.skills)) if (rank > 0) ranks += rank;
  if (ranks === 0) return { ok: false, reason: 'Скиллы не вложены' };
  const fee = skillRespecFee(reg, save);
  if (save.gold < fee) return { ok: false, reason: `Нужно ${fee} золота на сброс` };
  save.gold -= fee;
  save.unspentSkillPoints += ranks;
  save.skills = {};
  // Гнёзда живут рангами узлов, а рангов больше нет — оставлять вставки значит копить мусор,
  // который оживёт сам собой, если игрок перевложится в тот же узел.
  save.sockets = {};
  // Сброшенные скиллы больше нельзя держать в биндах.
  if (save.mouseLeft && save.mouseLeft !== 'attack') save.mouseLeft = 'attack';
  if (save.mouseRight && save.mouseRight !== 'attack') save.mouseRight = null;
  save.hotbar = save.hotbar.map((s) => (s && s !== 'attack' ? null : s));
  return { ok: true };
}

// ── Пассивы (золото ×2/ранг + очки пассивов) ──────────────────────────────────
function passiveNeighbors(tree: ConfigShapes['mastery-tree'], id: string): string[] {
  const out: string[] = [];
  for (const [a, b] of tree.edges) { if (a === id) out.push(b); else if (b === id) out.push(a); }
  return out;
}
/**
 * Ставит бинд действия в слот (клиентская раскладка ввода, часть сейва → персистит сервер).
 * slot: 0=ЛКМ, 1=ПКМ, 2..4=доп.слоты (hotbar[0..2]). value: id скилла / 'attack' / null.
 */
export function setBinding(save: SaveState, slot: number, value: string | null): ActionResult {
  if (slot === 0) save.mouseLeft = value;
  else if (slot === 1) save.mouseRight = value;
  else if (slot >= 2 && slot <= 4) {
    while (save.hotbar.length < 3) save.hotbar.push(null);
    save.hotbar[slot - 2] = value;
  } else return { ok: false, reason: 'Неверный слот бинда' };
  return { ok: true };
}

/** Кладёт расходник из инвентаря в первый свободный слот пояса (ёмкость — beltSlots надетого пояса). */
export function moveToBelt(save: SaveState, uid: string): ActionResult {
  const cap = save.equipment.belt?.beltSlots ?? 0;
  if (cap <= 0) return { ok: false, reason: 'Пояс не надет' };
  while (save.belt.length < cap) save.belt.push(null);
  const idx = save.inventory.findIndex((i) => i.uid === uid);
  if (idx < 0) return { ok: false, reason: 'Предмет не в инвентаре' };
  if (save.inventory[idx]!.kind !== 'consumable') return { ok: false, reason: 'Не расходник' };
  const slot = save.belt.findIndex((s) => !s);
  if (slot < 0) return { ok: false, reason: 'Пояс полон' };
  save.belt[slot] = save.inventory.splice(idx, 1)[0]!;
  return { ok: true };
}

/**
 * Входы дерева мастерства. Класс-гейт снят (Ф6): все входы доступны всем классам —
 * прокачка стартует с любого входа, дальше по смежности. Параметр `save` оставлен для
 * совместимости сигнатуры вызовов.
 */
export function passiveEntriesFor(reg: ConfigRegistry, _save?: SaveState): string[] {
  return reg.get('mastery-tree').entryNodes;
}

export function allocPassive(reg: ConfigRegistry, save: SaveState, nodeId: string): ActionResult {
  const tree = reg.get('mastery-tree');
  const node = tree.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: 'Узел не найден' };
  const rank = save.masteries[nodeId] ?? 0;
  if (rank >= node.maxRank) return { ok: false, reason: 'Максимальный ранг' };
  // Вход доступен только своему классу; прочее — по смежности (переходы дают край соседней ветви).
  const entries = passiveEntriesFor(reg, save);
  const allocatable = rank > 0 || entries.includes(nodeId)
    || passiveNeighbors(tree, nodeId).some((n) => (save.masteries[n] ?? 0) > 0);
  if (!allocatable) return { ok: false, reason: 'Недоступный вход или нет смежного узла' };
  if (node.cost.type !== 'gold') return { ok: false, reason: 'Неверный тип стоимости' };
  if (save.unspentMasteryPoints < 1) return { ok: false, reason: 'Нет очков мастерства' };
  const mult = reg.get('balance').passiveRankCostMult;
  const cost = Math.round(node.cost.amount * Math.pow(mult, rank));
  if (save.gold < cost) return { ok: false, reason: 'Недостаточно золота' };
  save.gold -= cost;
  save.unspentMasteryPoints -= 1;
  save.masteries[nodeId] = rank + 1;
  return { ok: true };
}

/** Суммарное золото, реально вложенное в текущие пассивы (Σ гео-цен всех вложенных рангов). */
export function passiveInvestedGold(reg: ConfigRegistry, save: SaveState): number {
  const tree = reg.get('mastery-tree');
  const mult = reg.get('balance').passiveRankCostMult;
  let gold = 0;
  for (const [id, rank] of Object.entries(save.masteries)) {
    const node = tree.nodes.find((n) => n.id === id);
    if (!node || rank <= 0) continue;
    for (let r = 0; r < rank; r++) gold += Math.round(node.cost.amount * Math.pow(mult, r));
  }
  return gold;
}

/** Комиссия сброса пассивов: доля `passiveRespecCostPct` от вложенного золота (растёт с прокачкой). */
export function passiveRespecFee(reg: ConfigRegistry, save: SaveState): number {
  return Math.round(passiveInvestedGold(reg, save) * reg.get('balance').passiveRespecCostPct);
}

/**
 * Сбрасывает ВСЕ пассивы за золото. Комиссия растёт с прокачкой (доля вложенного золота —
 * чтобы поздняя игра с миллионами не делала сброс копеечным). Возвращает ТОЛЬКО очки пассивов
 * (Σ рангов, в т.ч. за осиротевшие после регенерации дерева узлы), потраченное на узлы золото
 * НЕ возвращает. Заодно чистит осиротевшие аллокации (`masteries` обнуляется целиком).
 */
export function respecPassives(reg: ConfigRegistry, save: SaveState): ActionResult {
  let ranks = 0;
  for (const rank of Object.values(save.masteries)) if (rank > 0) ranks += rank;
  if (ranks === 0) return { ok: false, reason: 'Мастерства не вложены' };
  const fee = passiveRespecFee(reg, save);
  if (save.gold < fee) return { ok: false, reason: `Нужно ${fee} золота на сброс` };
  save.gold -= fee;
  save.unspentMasteryPoints += ranks;
  save.masteries = {};
  return { ok: true };
}
