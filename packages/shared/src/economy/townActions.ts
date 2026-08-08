import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import type { Item, EquipSlot, Rarity, ConsumableUse } from '../types/items.js';
import { ATTRIBUTES, type Attribute, type Attributes } from '../types/attributes.js';
import { finalAttributes, meetsRequirements, modifiersFromItems } from '../formulas/stats.js';
import { rollAffixes } from '../formulas/itemgen.js';
import type { Rng } from '../formulas/rng.js';
import { addToInventory, hasSpace, placeWithDisplacement, type Dims } from '../inventory/grid.js';
import type { DebuffState } from '../world/debuffs.js';

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
/** Улучшение: +20% (мин +1) к плоским базовым статам, префикс ★. Цена `forgePrices.upgradeTier`. */
export function forgeUpgrade(reg: ConfigRegistry, save: SaveState, uid: string): ActionResult {
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  const cost = reg.get('balance').forgePrices.upgradeTier;
  if (save.gold < cost) return { ok: false, reason: 'Недостаточно золота' };
  save.gold -= cost;
  item.baseStats = item.baseStats.map((m) => (m.kind === 'flat' ? { ...m, value: Math.max(m.value + 1, Math.round(m.value * 1.2)) } : m));
  if (!item.name.startsWith('★')) item.name = `★ ${item.name}`;
  return { ok: true };
}
/** Реролл аффиксов: заново катит столько же аффиксов из пула (rng — от вызывающего). Цена `forgePrices.rerollAffix`. */
export function forgeReroll(reg: ConfigRegistry, save: SaveState, uid: string, rng: Rng): ActionResult {
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  const cost = reg.get('balance').forgePrices.rerollAffix;
  if (save.gold < cost) return { ok: false, reason: 'Недостаточно золота' };
  save.gold -= cost;
  const rDef = reg.get('rarities').find((r) => r.id === item.rarity);
  item.affixes = rollAffixes(
    reg.get('affixes'),
    { kind: item.kind ?? '', slot: item.slot, attackType: item.attackType, damageKind: item.damageKind },
    item.rarity,
    { minAffixes: rDef?.minAffixes ?? 1, maxAffixes: rDef?.maxAffixes ?? 1, maxPrefix: rDef?.maxPrefix ?? 3, maxSuffix: rDef?.maxSuffix ?? 3 },
    item.itemLevel, rng);
  return { ok: true };
}

// ── Экипировка ───────────────────────────────────────────────────────────────
export function equip(reg: ConfigRegistry, save: SaveState, uid: string): ActionResult {
  const dims = dimsOf(reg);
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  if (!item.slot) return { ok: false, reason: 'Нельзя надеть' };
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
