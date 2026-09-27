import { ConfigRegistry } from '../config/registry.js';
import { generateItem, rollTierLevel } from '../formulas/itemgen.js';
import {
  baseTierRange, capacityOf, craftTiers, craftWeapon, enchantCost, enchantItem, enchantSlots, formMult, formOf, fullJournal,
  journalTierCap, keyVariantsByBase, materialId, normalizeJournal, partFamily, salvageIntoJournal, shapeFoundWeapon,
  tierIndexOfItem, tierOfSteps, variantsFor, type CraftCost, type CraftInput, type CraftJournal,
} from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, anatomyRow, keySlotOf, type CraftSlot, type WeaponPart } from '../formulas/craftType.js';
import { meetsRequirements } from '../formulas/stats.js';
import { createRng } from '../formulas/rng.js';
import { nextTier, retierItem } from '../formulas/itemgen.js';
import { availableMaterials, carriedMaterials, type MaterialCost } from '../economy/materials.js';
import {
  craftAction, enchantAction, forgeRepair, forgeSalvage, forgeUpgrade, fieldSalvage as doFieldSalvage,
  shopBuyPrice, shopSellPrice,
} from '../economy/townActions.js';
import { depositCarried } from '../economy/materials.js';
import { addToInventory } from '../inventory/grid.js';
import type { CraftParts, EquipSlot } from '../types/items.js';
import type { AccountStash } from '../types/stash.js';
import { estimateAttack } from '../formulas/playerCombat.js';
import type { Rng } from '../formulas/rng.js';
import type { StatModifier } from '../types/attributes.js';
import type { Item, AttackType, Rarity } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import { botAttrs, botDerived } from './playerBot.js';
import type { BuildPolicy } from './types.js';

/**
 * Экономика бота: скоринг предметов (лучший DPS для оружия, взвешенно для брони),
 * решение экип/продать, магазин, кузница (починка, подъём тира, ковка, зачарование, разбор),
 * вложение очков скиллов и золота в пассивы.
 * Все веса — грубые, доводятся на калибровке (Фаза D). Approx: дуал-вилд/двуручное
 * в экипе не различаем (сравниваем по слоту), смежность пассивов учитываем.
 *
 * ⭐ Цены и действия — АВТОРИТЕТНЫЕ функции игры (`economy/townActions.ts`), а не своя копия: иначе
 * сим мерил бы экономику, которой в игре нет. До K7 здесь жила своя формула цены (без надбавки
 * ступени, без пола разбора) — и отчёт о золоте расходился с сервером в разы на высоких ступенях.
 */

const OFFENSE_STATS = new Set([
  'minDamage', 'maxDamage', 'critChance', 'critMultiplier', 'accuracy',
  'addFire', 'addCold', 'addLightning', 'addPoison', 'attackSpeed',
]);
const DEFENSE_STATS = new Set([
  'armor', 'maxHp', 'blockChance', 'evade', 'hpRegen', 'manaRegen',
  'resFire', 'resCold', 'resLightning', 'resPoison',
]);

const FLAT_WEIGHT: Record<string, number> = {
  armor: 1, maxHp: 0.5, evade: 0.5, blockChance: 40, hpRegen: 2, manaRegen: 1,
  resFire: 60, resCold: 60, resLightning: 60, resPoison: 60,
  minDamage: 3, maxDamage: 3, accuracy: 0.3, critChance: 80, critMultiplier: 20,
  addFire: 3, addCold: 3, addLightning: 3, addPoison: 3,
  strength: 2, dexterity: 2, intelligence: 2, vitality: 3,
};
const INC_WEIGHT: Record<string, number> = {
  attackSpeed: 60, moveSpeed: 8, maxHp: 20, armor: 8, minDamage: 20, maxDamage: 20,
};

/**
 * ПРОДАЖА ЗА ЗОЛОТО — ценой игры (`shopSellPrice`), вещь уже вынута из сумки/экипа вызывающим.
 * ⚠ СКОВАННОЕ БОТ НЕ ПРОДАЁТ НИКОГДА: у ковки нет выхода в золото (§13 — две кассы не пересекаются),
 * её глагол — переплавка. Сюда скованная вещь попасть не должна; попала — бросок, а не тихая выручка,
 * иначе сим показал бы «ковка окупается продажей» ровно там, где игра этого не позволяет.
 */
function sellForGold(reg: ConfigRegistry, save: SaveState, item: Item): number {
  if (item.parts) throw new Error(`sim: бот попытался продать скованную вещь «${item.name}»`);
  const price = shopSellPrice(reg, item);
  save.gold += price;
  return price;
}

function itemMods(item: Item): StatModifier[] {
  return [...item.baseStats, ...item.affixes.flatMap((a) => (a.modifier ? [a.modifier] : []))];
}

/** Взвешенная оценка «полезности» набора модификаторов с учётом уклона урон/защита. */
function scoreMods(mods: StatModifier[], offenseBias: number): number {
  let s = 0;
  for (const m of mods) {
    const w = m.kind === 'flat' ? (FLAT_WEIGHT[m.stat] ?? 0) : (INC_WEIGHT[m.stat] ?? 0);
    let val = m.value * w;
    if (OFFENSE_STATS.has(m.stat)) val *= 0.5 + offenseBias;
    else if (DEFENSE_STATS.has(m.stat)) val *= 0.5 + (1 - offenseBias);
    s += val;
  }
  return s;
}

/** Профильный тип атаки класса (по стартовому оружию). */
export function classAttackType(reg: ConfigRegistry, classId: string): AttackType {
  const cls = reg.get('classes').find((c) => c.id === classId);
  const w = cls ? reg.get('items.base').find((b) => b.id === cls.startWeaponId) : undefined;
  return (w?.kind === 'weapon' ? w.attackType : 'melee') as AttackType;
}

function isWeaponLike(item: Item): boolean {
  return item.slot === 'weapon' || (item.slot === 'offhand' && !!item.attackType);
}

/**
 * ДПС ОРУЖИЯ в руках этого героя — средний удар × темп, без поправок бота на «свой тип» и аффиксы.
 * Одна мера для решения экипа и для отчёта «сила оружия по источникам» (сковал / нашёл / купил, §22).
 */
export function weaponDps(reg: ConfigRegistry, save: SaveState, item: Item): number {
  const d = botDerived(reg, save);
  const attrs = botAttrs(reg, save);
  const scaling = reg.get('balance').weaponAttrScaling;
  const avg = estimateAttack(d, attrs, item, scaling, reg.get('weapon-weights'));
  // Скорость — как считает бой: (1 + плоская) × (1 + проценты). Плоская часть — плата клинка за длину
  // (§26): без неё бот видел бы длинный клинок на ±10 % сильнее, а он сильнее лишь на ≈1 %.
  let flatAps = 0, incAps = 0;
  for (const m of itemMods(item)) if (m.stat === 'attackSpeed') { if (m.kind === 'flat') flatAps += m.value; else incAps += m.value; }
  return avg * (1 + flatAps) * (1 + incAps);
}

/** Скор предмета для решения экипа. Оружие — по фактическому DPS (мягко к своему типу). */
export function scoreItem(reg: ConfigRegistry, save: SaveState, item: Item, policy: BuildPolicy): number {
  if (isWeaponLike(item)) {
    const onType = item.attackType === classAttackType(reg, save.classId) ? 1.1 : 1.0;
    return weaponDps(reg, save, item) * onType + scoreMods(itemMods(item), policy.offenseBias) * 0.1;
  }
  return scoreMods(itemMods(item), policy.offenseBias);
}

/** Итог рассмотрения дропа: надет ли + сколько золота выручено с продажи (для отчёта забега). */
export interface DropResult {
  equipped: boolean;
  sold: number;
  /** Оставлено в сумке: сломанный апгрейд (понесём чинить) или ноша для журнала кузнеца (понесём разбирать). */
  kept?: boolean;
  /** Сколько единиц материалов вышло при разборе на месте. */
  salvaged?: number;
  /** Сколько ВЕЩЕЙ разобрано на месте (найденных: находка или снятая ради неё). */
  salvagedItems?: number;
  /** Скованных вещей переплавлено на месте (снятых ради лучшей находки). */
  melted?: number;
}

/**
 * НОША К КУЗНЕЦУ (ковка открыта). Найденное оружие, которое бот и так пустил бы в разбор, он несёт
 * домой: у кузнеца выход по деталям целиком, в поле — доля `balance.salvage.fieldYield`, и журнал
 * открывает только кузнец (§12.2). Так играет тот, кто куёт: сырьё обвязки и оголовья иначе не набрать.
 * То, что без ковки ушло бы в золото (не по силам), несём, только если его разбор что-то ОТКРОЕТ:
 * иначе сравнение «с ковкой / без» мерило бы не ковку, а отказ от продажи.
 * `carryCells` — бюджет клеток сумки под ношу (остальное место — под добычу и сырьё); последние
 * `JOURNAL_RESERVE` клеток — только под открытия. `journal` — рабочая копия: взятая ноша в неё уже
 * записана, чтобы второй такой же меч не занимал запас «ради журнала».
 */
export interface FieldCarry { journal: CraftJournal; carryCells: number; }

/** Клетки ноши, которые держим под оружие с неоткрытым в журнале (одна большая двуручная вещь). */
const JOURNAL_RESERVE = 8;

/**
 * Возьмёт ли бот эту вещь кузнецу. `scrap` — без ноши она ушла бы в разбор на месте (а не в золото).
 * Берёт — списывает бюджет; открытие пишет в рабочую копию журнала.
 */
function carryToForge(reg: ConfigRegistry, item: Item, carry: FieldCarry, scrap: boolean): boolean {
  if (item.kind !== 'weapon' || item.parts || item.rarity === 'unique') return false;
  const area = Math.max(1, item.gridW * item.gridH);
  if (area > carry.carryCells) return false;
  const u = salvageIntoJournal(reg, carry.journal, item);
  const opens = u.newBase || u.unlocked.length > 0 || u.tierUp || u.mythic;
  if (!opens && (!scrap || area > carry.carryCells - JOURNAL_RESERVE)) return false;
  if (opens) carry.journal = u.journal;
  carry.carryCells -= area;
  return true;
}

/**
 * Рассматривает подобранный предмет: если по скору лучше надетого и проходит требования — надевает
 * (снятое разбирает на месте); иначе разбирает или продаёт. `carry` — ковка открыта: найденное
 * оружие несём кузнецу (`carryToForge`). Мутирует save.
 */
export function considerDrop(reg: ConfigRegistry, save: SaveState, item: Item, policy: BuildPolicy, carry?: FieldCarry): DropResult {
  const better = (it: Item): boolean => {
    if (!it.slot) return false;
    const cur = save.equipment[it.slot];
    return scoreItem(reg, save, it, policy) > (cur ? scoreItem(reg, save, cur, policy) : -Infinity);
  };
  const scrap = (it: Item): DropResult => {
    const r = sellOrSalvage(reg, save, it);
    return { equipped: false, sold: r.sold, salvaged: r.mats, salvagedItems: r.took ? 1 : 0 };
  };
  // Скованное в сумке (сейв из игры): переплавка на месте, а не вышло (сумка полна) — несём кузнецу.
  // В золото — никогда: `sellForGold` на нём бросает.
  const meltOrCarry = (it: Item): DropResult => {
    const mats = fieldSalvage(reg, save, it);
    return mats !== null ? { equipped: false, sold: 0, salvaged: mats, melted: 1 } : { equipped: false, sold: 0, kept: true };
  };

  // ⚠ СТЕК СЫРЬЯ НЕСЁМ ДОМОЙ. Без этой ветки бот продавал бы его как вещь без слота — сим
  // показывал бы нулевой приход материалов и лишнее золото, то есть врал в обе стороны.
  if (item.kind === 'material') return { equipped: false, sold: 0, kept: true };

  // ⚠ СЛОМАННОЕ НАДЕТЬ НЕЛЬЗЯ (Ч4). Раньше бот его спокойно «экипировал» — сим завышал силу
  // персонажа и не тратил ни золота, ни материалов на починку, то есть врал в обе стороны.
  if (item.broken) {
    // Стоящее — несём домой чинить (в городе `visitForge`), остальное перерабатываем НА МЕСТЕ.
    if (item.slot && meetsRequirements(item, save.attributes) && better(item)) {
      return { equipped: false, sold: 0, kept: true };
    }
    if (item.parts) return meltOrCarry(item);
    if (carry && carryToForge(reg, item, carry, true)) return { equipped: false, sold: 0, kept: true };
    const mats = fieldSalvage(reg, save, item);
    return { equipped: false, sold: 0, salvaged: mats ?? 0, salvagedItems: mats !== null ? 1 : 0 };
  }

  // Расходники бот не экипирует — сразу в золото (нет слота).
  if (!item.slot) return { equipped: false, sold: sellForGold(reg, save, item) };
  if (meetsRequirements(item, save.attributes) && better(item)) {
    const cur = save.equipment[item.slot];
    // ⭐ Снятое СКОВАННОЕ — только в переплавку, прямо на месте (в золото ковка не уходит, §13). Не вышло
    // (сумка полна под выход) — остаётся в руках до кузницы, а находка идёт своим путём.
    if (cur?.parts) {
      const mats = fieldSalvage(reg, save, cur);
      if (mats !== null) {
        save.equipment[item.slot] = item;
        return { equipped: true, sold: 0, salvaged: mats, melted: 1 };
      }
    } else {
      // ⚠ Заменённую вещь НЕ продаём вслепую: разобрать её на месте выгоднее по смыслу игры
      // (материалы дефицитны, золото — нет), а уники разбору не поддаются вовсе.
      const r = cur ? sellOrSalvage(reg, save, cur) : { sold: 0, mats: 0, took: false };
      save.equipment[item.slot] = item;
      return { equipped: true, sold: r.sold, salvaged: r.mats, salvagedItems: r.took ? 1 : 0 };
    }
  }
  if (item.parts) return meltOrCarry(item);
  const wearable = meetsRequirements(item, save.attributes);
  if (carry && carryToForge(reg, item, carry, wearable)) return { equipped: false, sold: 0, kept: true };
  // Не по силам — в золото, как было: разбирать то, что ещё может пригодиться, бот не спешит.
  if (!wearable) return { equipped: false, sold: sellForGold(reg, save, item) };
  return scrap(item);
}

/**
 * ⭐ Ненужная вещь идёт В РАЗБОР, а не в продажу — это и есть задуманная петля: «проще разобрать
 * сразу, чем тащить хлам домой». Продаём только то, что разобрать нельзя (уники, расходники):
 * иначе бот копил бы золото, которого в игре и так избыток, и не копил бы материалы.
 * Возвращает выручку золотом (0, если ушло в материалы) и сколько единиц сырья вышло.
 */
function sellOrSalvage(reg: ConfigRegistry, save: SaveState, item: Item): { sold: number; mats: number; took: boolean } {
  const mats = fieldSalvage(reg, save, item);
  if (mats !== null) return { sold: 0, mats, took: true };
  return { sold: sellForGold(reg, save, item), mats: 0, took: false };
}

/** Единиц сырья в сумке — разбор кладёт выход именно туда (стеками), а не в кошелёк сейва. */
const bagUnits = (save: SaveState): number => Object.values(carriedMaterials(save.inventory)).reduce((a, b) => a + b, 0);

/**
 * Разбор на месте через АВТОРИТЕТНОЕ действие: цены и правила одни с игрой. Сколько единиц вышло; `null` — отказ (вещь цела).
 * ⚠ Мерить — по СУМКЕ. Раньше мерили `totalMaterials(save)` — старый кошелёк сейва, куда разбор больше
 * не кладёт: выходил 0, и `sellOrSalvage` уже разобранную вещь ЕЩЁ И продавал — двойной выход в симе.
 * ⚠ R9-03: 0 единиц — не отказ: пустой бросок разбирает вещь в ничто (как в игре), и продать её после этого уже нечего.
 */
function fieldSalvage(reg: ConfigRegistry, save: SaveState, item: Item): number | null {
  const before = bagUnits(save);
  save.inventory.push(item);
  const r = doFieldSalvage(reg, save, item.uid, createRng(((item.uid.length * 2654435761) ^ save.gold) >>> 0 || 1));
  if (!r.ok) { save.inventory = save.inventory.filter((i) => i.uid !== item.uid); return null; }
  return bagUnits(save) - before;
}

/** Золото, которое бот держит на магазин: пассивы и зачарование его не трогают. */
const goldReserve = (save: SaveState): number => 60 + save.level * 12;

/**
 * Итог похода в кузницу. `spent` — золото на починку и подъём тира; ковка и зачарование — отдельно
 * (`goldCraft`, `goldEnchant`): это разные стоки, и отчёт обязан их различать.
 */
export interface ForgeResult {
  spent: number;
  repaired: number;
  upgraded: number;
  deposited?: number;
  /** Ковка (K7): скованно, зачаровано, переплавлено скованных, разобрано найденных у кузнеца. */
  crafted: number;
  enchanted: number;
  melted: number;
  salvaged: number;
  /** Строк открытий журнала за визит (тип, детали, ступень, мифики, эскиз). */
  unlocked: number;
  goldCraft: number;
  goldEnchant: number;
  /** Сырьё, единиц: пришло разбором найденного; пришло переплавкой; ушло на ковку; ушло на починку и подъём тира. */
  matsIn: number;
  matsMelt: number;
  matsOutCraft: number;
  matsOutForge: number;
  /** Золото с продажи того, что кузнец не берёт (уникальное). */
  sold: number;
}

/** Кузница бота. Без `craft` бот ведёт себя как до ковки — это «до» в сравнении на одном сиде. */
export interface ForgeOpts {
  /** Ковка открыта: разбор у кузнеца (журнал), ковка лучшего доступного, зачарование, переплавка. */
  craft?: boolean;
  /** Броски городских действий. Свой поток, не мировой: ковка не должна сдвигать забег того же сида. */
  rng?: Rng;
  /** Ключ заявки на ковку. У сима — счётчик (ядро требует 8–64 символа `[A-Za-z0-9_-]`). */
  nonce?: () => string;
  /** Флаг разработчика «полный журнал» — как `DM_CRAFT_FULL_JOURNAL` на сервере. */
  fullJournal?: boolean;
}

/** Всё сырьё игрока: сумка + кошелёк сундука, единиц. */
const allUnits = (save: SaveState, wallet: MaterialCost): number =>
  Object.values(availableMaterials(save.inventory, wallet)).reduce((a, b) => a + b, 0);

/**
 * НА ВЕРСТАК: разбор у кузнеца авторитетным `forgeSalvage` — найденное открывает журнал и отдаёт
 * сырьё по деталям, скованное переплавляется. Вещь, которой нет в сумке (снятая с руки), кладётся туда.
 * Кузнец не берёт (уникальное) — в золото; скованное бот не продаёт никогда и оставляет в сумке.
 */
function salvageAtForge(reg: ConfigRegistry, save: SaveState, stash: AccountStash, item: Item, rng: Rng, out: ForgeResult): void {
  if (!save.inventory.includes(item)) save.inventory.push(item);
  const wallet = stash.materials ?? (stash.materials = {});
  const m0 = allUnits(save, wallet);
  const r = forgeSalvage(reg, save, stash, item.uid, rng);
  if (r.ok) {
    const got = allUnits(save, wallet) - m0;
    if (item.parts) { out.melted++; out.matsMelt += got; }
    else { out.salvaged++; out.matsIn += got; out.unlocked += r.unlocked?.length ?? 0; }
    return;
  }
  if (item.parts) return;
  save.inventory = save.inventory.filter((i) => i !== item);
  out.sold += sellForGold(reg, save, item);
}

/**
 * ⭐ КУЗНИЦА — главный сток золота новой экономики, и до этого бот в неё не заходил вовсе.
 *
 * Сперва чиним принесённое (сломанное надеть нельзя), потом качаем тир надетого, пока хватает
 * золота и материалов. Все операции — АВТОРИТЕТНЫЕ действия игры, а не копия их логики:
 * иначе цены в симе и в игре разойдутся, и балансировать будет нечего.
 *
 * ⭐ С ОТКРЫТОЙ КОВКОЙ (`opts.craft`) бот делает то же, что игрок у кузнеца: разбирает принесённое
 * оружие (журнал растёт), куёт лучшее, на что хватает сырья и золота, если оно заметно сильнее
 * надетого, зачаровывает скованное, когда золото сверх запаса, а снятое скованное — переплавляет.
 * Сырьё — из сумки и сундука аккаунта (`stash.materials`), журнал — `stash.forgeJournal`.
 */
export function visitForge(reg: ConfigRegistry, save: SaveState, policy: BuildPolicy, stash: AccountStash, opts: ForgeOpts = {}): ForgeResult {
  const out: ForgeResult = {
    spent: 0, repaired: 0, upgraded: 0, crafted: 0, enchanted: 0, melted: 0, salvaged: 0, unlocked: 0,
    goldCraft: 0, goldEnchant: 0, matsIn: 0, matsMelt: 0, matsOutCraft: 0, matsOutForge: 0, sold: 0,
  };
  const wallet = stash.materials ?? (stash.materials = {});
  const rng = opts.rng ?? createRng(1);
  const units = (): number => allUnits(save, wallet);
  const curScore = (slot: EquipSlot): number => { const c = save.equipment[slot]; return c ? scoreItem(reg, save, c, policy) : -Infinity; };
  const worthRepair = (it: Item): boolean =>
    !!it.broken && !!it.slot && meetsRequirements(it, save.attributes) && scoreItem(reg, save, it, policy) > curScore(it.slot);
  // Снятое с руки: оружие при открытой ковке и любое скованное — на верстак, остальное как раньше.
  const retire = (it: Item): void => {
    if (it.parts || (opts.craft && it.kind === 'weapon')) salvageAtForge(reg, save, stash, it, rng, out);
    else sellOrSalvage(reg, save, it);
  };
  // ⭐ Сперва СДАЁМ сырьё в сундук — так игрок и делает, вернувшись из забега: сумка пустеет,
  // а запас становится общим и перестаёт быть под угрозой смерти.
  out.deposited = depositCarried(save.inventory, wallet);
  // 0. На верстак: скованное из сумки — всегда в переплавку (разбор работает и при закрытой ковке, D13);
  // при открытой ковке — и принесённое найденное оружие (журнал и сырьё), кроме сломанного апгрейда под починку.
  for (const item of [...save.inventory]) {
    if (item.parts || (opts.craft && item.kind === 'weapon' && !worthRepair(item))) salvageAtForge(reg, save, stash, item, rng, out);
  }
  // 1. Починка принесённого: чиним и надеваем, если лучше текущего.
  for (const item of [...save.inventory]) {
    if (!item.broken || !item.slot) continue;
    const gold0 = save.gold, m0 = units();
    if (!forgeRepair(reg, save, item.uid, wallet).ok) continue;
    out.spent += gold0 - save.gold;
    out.matsOutForge += m0 - units();
    out.repaired++;
    const cur = save.equipment[item.slot];
    if (scoreItem(reg, save, item, policy) > (cur ? scoreItem(reg, save, cur, policy) : -Infinity)) {
      save.inventory = save.inventory.filter((i) => i.uid !== item.uid);
      save.equipment[item.slot] = item;
      if (cur) retire(cur);
    }
  }
  // 2. Ковка: лучшее доступное — если заметно сильнее надетого; тут же зачарование, пока вещь в сумке.
  if (opts.craft) craftAtForge(reg, save, stash, policy, rng, opts, out);
  // 3. Подъём тира надетого — по одному шагу на слот за визит (как сделал бы игрок).
  for (const [slot, item] of Object.entries(save.equipment) as [EquipSlot, Item | undefined][]) {
    if (!item || item.parts) continue;   // скованное кузница не поднимает — его перековывают
    const base = reg.get('items.base').find((b) => b.id === item.baseId);
    const tier = base ? nextTier(reg.get('item-tiers'), base, item.tier) : undefined;
    if (!base || !tier) continue;
    // ⚠ Проверяем НОСИБЕЛЬНОСТЬ ДО улучшения: требования растут с тиром, и «прокачал и снял»
    // было бы чистым убытком. Скидка кузницы уже учтена в `retierItem`.
    const after = retierItem(base, item, tier, {
      reqDiscount: reg.get('balance').forgePrices.upgradeReqDiscount,
      maxReqTotal: reg.get('balance').maxTotalRequirement,
      spread: reg.get('balance').loot.baseRoll,
    });
    if (!meetsRequirements(after, save.attributes)) continue;
    const gold0 = save.gold, m0 = units();
    save.inventory.push(item);
    const ok = forgeUpgrade(reg, save, item.uid, wallet).ok;
    // `forgeUpgrade` ЗАМЕНЯЕТ объект в сумке (D14) — надеваем то, что лежит там теперь.
    const upgraded = save.inventory.find((i) => i.uid === item.uid) ?? item;
    save.inventory = save.inventory.filter((i) => i.uid !== item.uid);
    if (!ok) continue;
    save.equipment[slot] = upgraded;
    out.spent += gold0 - save.gold;
    out.matsOutForge += m0 - units();
    out.upgraded++;
  }
  // Выход разбора и переплавки лёг в сумку — туда же, в сундук.
  out.deposited += depositCarried(save.inventory, wallet);
  return out;
}

// ── Ковка бота ──────────────────────────────────────────────────────────────

/**
 * План ковки: заявка, вещь-предпросмотр (середина вилки), цена, ступень и скор бота. `score` — уже с
 * зачарованием, на которое хватит золота после ковки (`enchant`): скованная вещь рождается обычной, и без
 * этого бот сравнивал бы голую заготовку с найденной магической — и не ковал бы никогда (Р1: скованное
 * равно лучшим найденным редким, а не голым).
 */
export interface CraftPlan { input: CraftInput; item: Item; cost: CraftCost; tier: number; score: number; enchant?: Rarity; }

/** Счётчик ключей заявок, когда вызывающий свой не дал: ключ не повторяется в пределах процесса. */
let simNonceSeq = 0;

/** Во сколько раз скованное должно быть сильнее надетого, чтобы бот тратил на него сырьё. */
const CRAFT_MARGIN = 0.1;

/**
 * ⭐ ЛУЧШЕЕ, ЧТО БОТ МОЖЕТ СКОВАТЬ СЕЙЧАС: из открытого в журнале, на сырьё сумки + сундука и на золото
 * сейва, по силам (требования) — самую высокую ступень каждой открытой базы, самой дешёвой сборкой
 * (цена сырья по `sellPrice`), затем лучшую по скору бота. Сверху — самая высокая доводка по карману:
 * она поднимает только пол броска (§13.1), верх вилки тот же.
 *
 * Перебор честный и конечный: 5⁴ ступеней на базу, деталь гнезда под ступень — из открытых та, чьего
 * сырья больше всего. Проверку правил не дублирует — предпросмотр идёт тем же `craftWeapon`, что и
 * ковка, с тем же журналом и включённостью сырья. Сам ничего не тратит.
 */
export function bestCraft(
  reg: ConfigRegistry, save: SaveState, stash: AccountStash, policy: BuildPolicy, opts: { fullJournal?: boolean } = {},
): CraftPlan | null {
  const journal = opts.fullJournal ? fullJournal(reg) : normalizeJournal(stash.forgeJournal);
  const cap = journalTierCap(reg, journal);
  if (cap < 0 || !journal.bases.length) return null;
  const have = availableMaterials(save.inventory, stash.materials ?? {});
  const k = reg.get('balance').craft;
  const tiers = craftTiers(reg);
  const mats = reg.get('craft-materials');
  const on = new Set(mats.filter((m) => m.enabled !== false).map((m) => m.id));
  const price = new Map(mats.map((m) => [m.id, m.sellPrice]));
  const open = new Set(journal.variants);
  const fits = (cost: CraftCost): boolean =>
    Number.isFinite(save.gold) && save.gold >= cost.gold && Object.entries(cost.materials).every(([id, n]) => (have[id] ?? 0) >= n);
  // Ступень вещи по четвёрке ступеней материала — от базы не зависит, считаем один раз.
  const tierAt = new Map<string, number>();
  for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (let c = 1; c <= 5; c++) for (let d = 1; d <= 5; d++) {
    tierAt.set(`${a}${b}${c}${d}`, tierOfStepsFast(reg, [a, b, c, d]));
  }

  let best: CraftPlan | null = null;
  for (const baseId of journal.bases) {
    const base = reg.get('items.base').find((b) => b.id === baseId);
    if (!base || base.kind !== 'weapon' || base.enabled === false) continue;
    const hands = base.hands ?? 1;
    const anat = anatomyRow(reg, base.weaponClass);
    if (!anat) continue;
    const keySlot = keySlotOf(reg, base.weaponClass);
    const pools = {} as Record<CraftSlot, WeaponPart[]>;
    let complete = true;
    for (const slot of CRAFT_SLOT_LIST) {
      const pool = slot === keySlot
        ? keyVariantsByBase(reg, base.weaponClass, hands).find((g) => g.baseId === base.id)?.variants ?? []
        : variantsFor(reg, base.weaponClass, slot, hands);
      pools[slot] = pool.filter((p) => open.has(p.id));
      if (!pools[slot].length) { complete = false; break; }
    }
    if (!complete) continue;
    const range = baseTierRange(reg, base);
    const hi = Math.min(range.hi, cap);
    if (hi < range.lo) continue;
    // Деталь гнезда под ступень материала: из открытых — та, чьего сырья больше всего, потом ближе к эталону.
    const memo = new Map<string, WeaponPart | null>();
    const pickFor = (slot: CraftSlot, step: number): WeaponPart | null => {
      const key = `${slot}${step}`;
      if (memo.has(key)) return memo.get(key)!;
      const stock = (p: WeaponPart): number => have[materialId(partFamily(anat, slot, p), step)] ?? 0;
      const p = pools[slot].filter((x) => x.stepMin <= step && step <= x.stepMax)
        .sort((x, y) => stock(y) - stock(x) || Math.abs(x.axis) - Math.abs(y.axis) || x.id.localeCompare(y.id))[0] ?? null;
      memo.set(key, p);
      return p;
    };
    // Самая дешёвая сборка каждой ступени вещи, на которую хватает сырья и золота.
    const cheapest = new Map<number, { picks: CraftParts; value: number }>();
    for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (let c = 1; c <= 5; c++) for (let d = 1; d <= 5; d++) {
      const t = tierAt.get(`${a}${b}${c}${d}`)!;
      if (t < range.lo || t > hi) continue;
      const steps = [a, b, c, d];
      const picks = {} as CraftParts;
      const parts = {} as Record<CraftSlot, WeaponPart>;
      let ok = true;
      CRAFT_SLOT_LIST.forEach((slot, i) => {
        const p = ok ? pickFor(slot, steps[i]!) : null;
        if (!p) { ok = false; return; }
        parts[slot] = p;
        picks[slot] = { id: p.id, step: steps[i]! };
      });
      if (!ok) continue;
      const gold = Math.round(k.cost.goldPerReqMult * (tiers[t]?.reqMult ?? 1));
      if (!(save.gold >= gold)) continue;
      const M = formMult(reg, formOf(capacityOf(reg, t), parts.bind.axis));
      const need: MaterialCost = {};
      for (const slot of CRAFT_SLOT_LIST) {
        const id = materialId(partFamily(anat, slot, parts[slot]), picks[slot].step);
        if (!on.has(id)) { ok = false; break; }
        need[id] = (need[id] ?? 0) + Math.ceil(k.cost.units[slot] * M);
      }
      if (!ok || Object.entries(need).some(([id, n]) => (have[id] ?? 0) < n)) continue;
      const value = Object.entries(need).reduce((s, [id, n]) => s + n * (price.get(id) ?? 0), 0);
      const prev = cheapest.get(t);
      if (!prev || value < prev.value) cheapest.set(t, { picks, value });
    }
    // Высшая ступень, которую бот может и сковать, и надеть.
    for (const t of [...cheapest.keys()].sort((x, y) => y - x)) {
      const input: CraftInput = { weaponClass: base.weaponClass, hands, parts: cheapest.get(t)!.picks };
      const pv = craftWeapon(reg, input, { journal, materialsOn: true });
      if (!pv.ok || !pv.item || !pv.cost || !fits(pv.cost) || !meetsRequirements(pv.item, save.attributes)) continue;
      const { score, enchant } = planScore(reg, save, pv.item, pv.cost.gold, policy);
      if (!best || score > best.score) best = { input, item: pv.item, cost: pv.cost, tier: t, score, enchant };
      break;
    }
  }
  if (!best) return null;
  // Доводка дороже золотом — и может съесть зачарование: берём самую высокую, что по карману и НЕ хуже без неё.
  for (let f = k.finish.length - 1; f >= 1; f--) {
    const input: CraftInput = { ...best.input, finish: f };
    const pv = craftWeapon(reg, input, { journal, materialsOn: true });
    if (!pv.ok || !pv.item || !pv.cost || !fits(pv.cost)) continue;
    const scored = planScore(reg, save, pv.item, pv.cost.gold, policy);
    if (scored.score >= best.score) return { input, item: pv.item, cost: pv.cost, tier: best.tier, ...scored };
  }
  return best;
}

/** Ступень вещи по ступеням четырёх гнёзд — тем же `tierOfSteps`, что и ковка (без своей формулы). */
function tierOfStepsFast(reg: ConfigRegistry, s: number[]): number {
  return tierOfSteps(reg, { strike: { step: s[0]! }, grip: { step: s[1]! }, bind: { step: s[2]! }, head: { step: s[3]! } }).tier;
}

/**
 * Зачарование, на которое бот готов потратиться: редкое, иначе магическое — если пул наберёт и золото
 * (`gold`, по умолчанию всё, что есть) останется сверх запаса.
 */
function enchantChoice(reg: ConfigRegistry, save: SaveState, item: Item, gold = save.gold): Rarity | null {
  if (!item.parts || item.rarity !== 'normal' || item.broken) return null;
  for (const r of ['rare', 'magic'] as const) {
    const fit = enchantSlots(reg, item, r);
    if (!fit?.fillable || Math.min(fit.slots.maxAffixes, fit.slots.maxPrefix + fit.slots.maxSuffix) <= 0) continue;
    if (gold - enchantCost(reg, item, r) >= goldReserve(save)) return r;
  }
  return null;
}

/** Бросков зачарования на оценку плана: свойства катаются, и одно число врало бы в любую сторону. */
const ENCHANT_SAMPLES = 3;

/**
 * Скор скованной вещи для решения «ковать ли»: с зачарованием, если на него хватит золота после ковки, —
 * средним по нескольким броскам ТЕМ ЖЕ `enchantItem`, что у кузнеца (детерминированные сиды: сим повторяем).
 */
function planScore(reg: ConfigRegistry, save: SaveState, item: Item, craftGold: number, policy: BuildPolicy): { score: number; enchant?: Rarity } {
  const bare = scoreItem(reg, save, item, policy);
  const r = enchantChoice(reg, save, item, save.gold - craftGold);
  if (!r) return { score: bare };
  let sum = 0, n = 0;
  for (let k = 1; k <= ENCHANT_SAMPLES; k++) {
    const e = enchantItem(reg, item, r, createRng(k));
    if (e) { sum += scoreItem(reg, save, e, policy); n++; }
  }
  return n ? { score: Math.max(bare, sum / n), enchant: r } : { score: bare };
}

/** Зачаровать вещь из сумки, если бот готов (`enchantChoice`). Ядро само откажет до оплаты. */
function enchantInBag(reg: ConfigRegistry, save: SaveState, uid: string, rng: Rng, out: ForgeResult): void {
  const item = save.inventory.find((i) => i.uid === uid);
  const r = item ? enchantChoice(reg, save, item) : null;
  if (!r) return;
  const gold0 = save.gold;
  if (enchantAction(reg, save, uid, r, rng).ok) { out.enchanted++; out.goldEnchant += gold0 - save.gold; }
}

/**
 * Шаг ковки у кузнеца: лучшее доступное (`bestCraft`), если оно заметно сильнее надетого; своё
 * скованное бот меняет только на ступень выше (иначе перековывал бы ради броска). Ковка и зачарование —
 * АВТОРИТЕТНЫМИ `craftAction` / `enchantAction`; надевается по слоту, как любая находка бота; снятое —
 * на верстак. Потом — зачарование надетого скованного, когда золото сверх запаса.
 */
function craftAtForge(
  reg: ConfigRegistry, save: SaveState, stash: AccountStash, policy: BuildPolicy, rng: Rng, opts: ForgeOpts, out: ForgeResult,
): void {
  const wallet = stash.materials ?? (stash.materials = {});
  const units = (): number => allUnits(save, wallet);
  const cur = save.equipment.weapon;
  const curScore = cur ? scoreItem(reg, save, cur, policy) : -Infinity;
  const plan = bestCraft(reg, save, stash, policy, { fullJournal: opts.fullJournal });
  const worth = !!plan && (!cur || (
    (!cur.parts || plan.tier > tierIndexOfItem(reg, cur)) && plan.score > curScore * (1 + CRAFT_MARGIN)));
  if (plan && worth) {
    const gold0 = save.gold, m0 = units();
    const r = craftAction(reg, save, stash, opts.nonce?.() ?? `sim-craft-${++simNonceSeq}`, plan.input, rng, { fullJournal: opts.fullJournal });
    // Повтор ключа ядро отвечает прежним uid и НИЧЕГО не кует — такой «успех» ковкой не считается.
    if (r.ok && r.uid && save.inventory.some((i) => i.uid === r.uid)) {
      out.crafted++;
      out.goldCraft += gold0 - save.gold;
      out.matsOutCraft += m0 - units();
      enchantInBag(reg, save, r.uid, rng, out);
      const made = save.inventory.find((i) => i.uid === r.uid);
      if (made && scoreItem(reg, save, made, policy) > curScore) {
        // Надевается так же, как любая находка бота (по слоту, `considerDrop`): иначе скованный двуручник
        // платил бы щитом, который найденный двуручник у бота не снимает, и «сковал / нашёл» врало бы.
        save.inventory = save.inventory.filter((i) => i !== made);
        made.pos = null;
        save.equipment.weapon = made;
        if (cur) salvageAtForge(reg, save, stash, cur, rng, out);   // снятое — на верстак: журнал и сырьё / переплавка
      } else if (made) {
        salvageAtForge(reg, save, stash, made, rng, out);   // бросок лёг хуже надетого — обратно в сырьё
      }
    }
  }
  // Надетое скованное без свойств — зачаровать, когда накопилось золото. Ядро зачаровывает из сумки —
  // вещь на миг кладётся туда, как при подъёме тира.
  const w = save.equipment.weapon;
  if (w && enchantChoice(reg, save, w)) {
    save.inventory.push(w);
    enchantInBag(reg, save, w.uid, rng, out);
    save.equipment.weapon = save.inventory.find((i) => i.uid === w.uid) ?? w;
    save.inventory = save.inventory.filter((i) => i.uid !== w.uid);
  }
}

/** Итог похода в магазин: потрачено на покупки / выручено с продажи заменённого / что куплено. */
export interface ShopResult { spent: number; sold: number; bought: Item[]; }

/**
 * Магазин: сток на (level+1) — как `rollGear` сервера: ступень базы БРОСКОМ в окне (D21), происхождение
 * `shop` (D16), цена — `shopBuyPrice` игры. Покупает апгрейды по карману. Заменённое продаёт ценой игры;
 * скованное не продаёт — кладёт в сумку, и кузница его переплавит. Мутирует save.
 */
export function visitShop(reg: ConfigRegistry, save: SaveState, level: number, rng: Rng, policy: BuildPolicy): ShopResult {
  const itemsBase = reg.get('items.base');
  const affixes = reg.get('affixes');
  const uniques = reg.get('uniques');
  const rarities = reg.get('rarities');
  const loot = reg.get('balance').loot;
  const dims = reg.get('balance').inventory;
  let spent = 0, sold = 0; const bought: Item[] = [];
  for (let i = 0; i < 8; i++) {
    const item = shapeFoundWeapon(reg, generateItem(itemsBase, affixes, uniques,
      { dropBias: 1.3, itemLevel: level + 1, tierLevel: rollTierLevel(level + 1, loot.tierWindow, rng),
        tiers: reg.get('item-tiers'), rarities, baseRoll: loot.baseRoll, origin: 'shop', noUnique: true }, rng));   // R13-09: уников в лавке нет
    const price = shopBuyPrice(reg, item);
    if (!item.slot || save.gold < price || !meetsRequirements(item, save.attributes)) continue;
    const cur = save.equipment[item.slot];
    const curScore = cur ? scoreItem(reg, save, cur, policy) : -Infinity;
    if (scoreItem(reg, save, item, policy) > curScore) {
      if (cur?.parts) {
        // Скованное — в сумку к кузнецу (переплавка), не на прилавок. Места нет — не покупаем.
        cur.pos = null;
        if (!addToInventory(save.inventory, cur, dims)) continue;
      } else if (cur) sold += sellForGold(reg, save, cur);
      save.gold -= price; spent += price;
      save.equipment[item.slot] = item; bought.push(item);
    }
  }
  return { spent, sold, bought };
}

// ── Скиллы и пассивы ─────────────────────────────────────────────────────────

/** Вкладывает очки скиллов в единое ДРЕВО СКИЛОВ по смежности (класс-ветка — только своя). */
function allocateActivePoints(reg: ConfigRegistry, save: SaveState, _policy: BuildPolicy, _rng: Rng): void {
  const tree = reg.get('skill-tree');
  const neighbors = (id: string): string[] => {
    const out: string[] = [];
    for (const [a, b] of tree.edges) { if (a === id) out.push(b); else if (b === id) out.push(a); }
    return out;
  };
  const usableClass = (branchId: string): boolean => {
    const br = tree.branches.find((b) => b.id === branchId);
    return !br?.classId || br.classId === save.classId;
  };
  const allocatable = (n: (typeof tree.nodes)[number]): boolean => {
    const rank = save.skills[n.id] ?? 0;
    if (rank >= n.maxRank || n.levelReq > save.level || n.cost.amount > save.unspentSkillPoints) return false;
    if (!usableClass(n.branchId)) return false;
    return rank > 0 || tree.entryNodes.includes(n.id) || neighbors(n.id).some((x) => (save.skills[x] ?? 0) > 0);
  };
  for (let guard = 0; guard < 500 && save.unspentSkillPoints > 0; guard++) {
    const cands = tree.nodes.filter(allocatable);
    if (!cands.length) break;
    cands.sort((a, b) => a.levelReq - b.levelReq || (save.skills[a.id] ?? 0) - (save.skills[b.id] ?? 0));
    const node = cands[0]!;
    save.skills[node.id] = (save.skills[node.id] ?? 0) + 1;
    save.unspentSkillPoints -= node.cost.amount;
  }
}

function neighborMap(edges: readonly (readonly [string, string])[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [a, b] of edges) {
    (map.get(a) ?? map.set(a, []).get(a)!).push(b);
    (map.get(b) ?? map.set(b, []).get(b)!).push(a);
  }
  return map;
}

/** Тратит очки пассивов + золото жадно (польза/цена), уважая смежность и резерв на магазин. */
function allocatePassives(reg: ConfigRegistry, save: SaveState, policy: BuildPolicy, rng: Rng): void {
  const tree = reg.get('mastery-tree');
  const mult = reg.get('balance').passiveRankCostMult;
  const nbr = neighborMap(tree.edges);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const unlocked = new Set<string>(tree.entryNodes);
  for (const [id, r] of Object.entries(save.masteries)) {
    if (r > 0) { unlocked.add(id); for (const n of nbr.get(id) ?? []) unlocked.add(n); }
  }
  const reserve = goldReserve(save); // держим золото на магазин
  void rng;

  for (let guard = 0; guard < 1000 && save.unspentMasteryPoints > 0; guard++) {
    let best: { id: string; cost: number } | null = null;
    let bestVal = 0;
    for (const id of unlocked) {
      const node = byId.get(id);
      if (!node) continue;
      const rank = save.masteries[id] ?? 0;
      if (rank >= node.maxRank || node.levelReq > save.level) continue;   // R10-11: как `allocPassive`
      const cost = Math.round(node.cost.amount * Math.pow(mult, rank));
      if (save.gold - cost < reserve) continue;
      const val = scoreMods(node.effect.modifiers ?? [], policy.offenseBias) / Math.max(1, cost);
      if (val > bestVal) { bestVal = val; best = { id, cost }; }
    }
    if (!best) break;
    save.masteries[best.id] = (save.masteries[best.id] ?? 0) + 1;
    save.gold -= best.cost;
    save.unspentMasteryPoints -= 1;
    for (const n of nbr.get(best.id) ?? []) unlocked.add(n);
  }
}

/** Тратит доступные очки скиллов и золото в пассивы (если политика разрешает). */
export function allocateSkillsAndPassives(reg: ConfigRegistry, save: SaveState, policy: BuildPolicy, rng: Rng): void {
  if (!policy.useSkills) return;
  allocateActivePoints(reg, save, policy, rng);
  allocatePassives(reg, save, policy, rng);
}
