import { ConfigRegistry } from '../../config/registry.js';
import { affixFormKeys, questsRandomSchema, type ConfigShapes } from '../../config/schemas.js';
import type { EarnedPoints, SaveState } from '../../types/save.js';
import type { CraftParts, EquipSlot, Item, ItemOrigin } from '../../types/items.js';
import type { AccountStash } from '../../types/stash.js';
import type { QuestDef } from '../../types/quest.js';
import { ATTRIBUTES } from '../../types/attributes.js';
import { createRng, type Rng } from '../../formulas/rng.js';
import { generateItem, itemFromBaseId, rollTierLevel } from '../../formulas/itemgen.js';
import { CRAFT_SLOT_LIST, baseOfKeyPart, keySlotOf } from '../../formulas/craftType.js';
import {
  affixSlotsFor, baseTierRange, countsAsFind, countsAsMythicFind, craftTiers, craftWeapon, enchantCost, formKey, formMult, isCraftNonce, journalTierCap,
  normalizeCraftNonces, normalizeJournal, parseCraftInput, partById, partsOf, salvageIntoJournal, shapeFoundWeapon, tierIndexOfItem, typeOfItem, variantsFor,
  type AffixForm, type CraftInput, type CraftJournal,
} from '../../formulas/craft.js';
import { meetsRequirements, unmetWorn } from '../../formulas/stats.js';
import { isVersatile } from '../../formulas/versatile.js';
import { xpForLevel } from '../../formulas/xp.js';
import { addToInventory, findFree, type Dims } from '../../inventory/grid.js';
import { saveStateSchema } from '../../validation/save.js';
import { parseTownCommand } from '../../session/netSchemas.js';
import {
  SHOP_CONSUMABLE_STOCK, allocActive, allocAttr, allocPassive, applyConsumable, attrRespecRefund, buyItem, canEnchantItem, canUpgradeItem, craftAction,
  depositMaterials, enchantAction, equip, fieldSalvage, forgeGold, forgeRepair, forgeReroll, forgeSalvage, forgeUpgrade,
  moveInventoryItem, moveToBelt, passiveRespecFee, repairCost, respec, respecPassives, respecSkills, salvageMean, salvageRange,
  salvageWorth, sellItem, settleEarned, shopBuyPrice, shopConsumableIds, shopSellPrice, sketchAction, skillRespecFee, unequip, upgradeCost,
  upgradedItem, pointsHeld, type ActionResult,
} from '../townActions.js';
import { emptyStash, sanitizeStash, stashDims, stashMove, type StashDst } from '../stashActions.js';
import { acceptQuest, ensureMainQuest, generateBoard, trackFloor, trackObjective, turnInQuest } from '../questLogic.js';
import { newCharacterSave } from '../newCharacter.js';
import { applyDeathPenalty } from '../death.js';
import { gainXp } from '../progression.js';
import { canAffordBoth, giveMaterialsTo, type MaterialCost } from '../materials.js';

/**
 * ⭐ ФАЗЗЕР ЭКОНОМИКИ (B2) — МОДЕЛЬ И ИНВАРИАНТЫ. Один аккаунт: два героя и общий сундук (кошелёк сырья, журнал кузнеца, ключи
 * заявок, вкладки), лавка со стоком, доска заданий, находки с тел. Шаги — НАСТОЯЩИЕ действия города (`townActions`,
 * `stashActions`, `questLogic`, `death`) со случайными — годными и негодными — входами, как их прислал бы честный клиент,
 * устаревший клиент (цены своего конфига) и злой клиент; между шагами хозяин правит конфиг живьём (`reload`).
 *
 * После КАЖДОГО шага — инварианты целостности (`stepInvariants` — переход «до → после» по плану шага, `stateInvariants` — само
 * состояние):
 *  I1 — отказ не трогает ни сейвы, ни сундук (байт в байт);
 *  I2 — ни одного отрицательного, дробного, NaN или бесконечного числа в золоте, счётчиках, требованиях, статах, в целях и наградах
 *       заданий на доске и в журнале (C-02: цель «0 из 0» не закрыть никогда);
 *  I3 — uid уникальны по обоим героям и сундуку;
 *  I4 — СОХРАНЕНИЕ: золото растёт только продажей и наградой и ровно на показанное; сырьё — только разбором (вещь при этом
 *       уходит) и впрыском добычи; вещи появляются только покупкой (золото уплачено), ковкой (сырьё и золото уплачены),
 *       наградой и впрыском; прочие вещи не меняются ни на байт (кроме места в сетке);
 *  I5 — ГРОСБУХ: ценность аккаунта (золото + сырьё по `sellPrice` + вещь по лучшему из «продать / разобрать») от шага
 *       города не растёт, от впрыска — не больше впрыснутого (петля с прибылью — нарушение, сжатая до кратчайшей);
 *  I6 — журнал, потолок ступени и ворота мификов двигаются только разбором годной находки и тратой эскиза;
 *  I7 — каждая вещь проходит zod-схему сейва (`validation/save.ts`) туда-обратно без изменений;
 *  плюс сетка (вещь в своих клетках, без наложений), экипировка по правилам слотов и требований, правила вещи (свойств не больше
 *  редкости и оплаченной формы, ступень в окне базы, сумма требований под потолком), очки (вложенное + свободное = выданное
 *  уровнями по очкам за уровень ТОГО мига — по книге героя `PointsBook`, все три пула; атрибуты — от старта, с которым создан, не ниже
 *  него, R18-07; сброс итог Σ атрибутов + свободные не двигает — `respec-total`, и у сейва без старта, R19-01), ⭐ D2: книга
 *  заработанного сейва (`save.earned`) = выданное моделью (`earned`) и = вложенное + свободное (`earned-held`), уровень не опускается
 *  (`level-drop`), возврат сброса атрибутов не зависит от живого конфига (`refund-config`), вход дописывает только недостающее
 *  (`reenter`); согласие на цену
 *  (`maxGold`/`minGold`/`maxMaterials`/`minYield`), «не упал» и «конфиг никто не правит на месте»; цена у каждой формы ёмкости,
 *  которую даёт ковка, и богаче не дешевле (`formPrices`, R17-03), и ковка, зачарование и перекатка платят только за форму с ценой
 *  (`unpricedForm`); кривая опыта строго растёт (`xpCurve`, R20-05); ⚠ R23-04: лавка не скупает дороже, чем продаёт, — у каждой вещи
 *  прилавка (снаряжение и зелья) цена покупки не ниже скупки и не ниже 1 (`shopArbitrage`, при любом `rarities.priceMult`, шаг `priceEdit`).
 *
 * Шаг хранится АБСТРАКТНО — `{k, h, s}`: вид, герой, сид своих бросков; что именно он берёт (какую вещь, какую цену), решается
 * по состоянию в момент исполнения. Поэтому сжатие (`shrink`) выбрасывает шаги, и оставшиеся по-прежнему осмысленны.
 * Только для тестов: игра и сервер модуль не импортируют. Шов для комнаты — `plan` (у шага есть и команда `cmd`).
 */

// ── Шаги ──────────────────────────────────────────────────────────────────────────────────────────

export type OpKind =
  | 'buy' | 'sell' | 'craft' | 'enchant' | 'sketch' | 'forgeSalvage' | 'fieldSalvage' | 'upgrade' | 'reroll' | 'repair'
  | 'stashMove' | 'deposit' | 'equip' | 'unequip' | 'useConsumable' | 'moveBelt' | 'moveItem' | 'allocAttr' | 'respec'
  | 'allocPassive' | 'respecPassives' | 'allocSkill' | 'respecSkills' | 'acceptQuest' | 'ensureMain' | 'questProgress' | 'turnIn'
  | 'death' | 'loot' | 'lootMats' | 'gold' | 'xp' | 'config' | 'restock' | 'clientSync' | 'newHero' | 'classEdit' | 'progEdit' | 'reenter'
  | 'priceEdit';

/** Шаг цепочки: вид, чей герой (0/1), сид его бросков. */
export interface Op { k: OpKind; h: 0 | 1; s: number }

/** Веса видов шагов — город чаще, впрыски и конфиг реже. */
export const OP_WEIGHTS: Record<OpKind, number> = {
  buy: 7, sell: 7, craft: 11, enchant: 5, sketch: 3, forgeSalvage: 9, fieldSalvage: 4, upgrade: 7, reroll: 4, repair: 4,
  stashMove: 10, deposit: 3, equip: 7, unequip: 4, useConsumable: 2, moveBelt: 2, moveItem: 2, allocAttr: 3, respec: 2,
  allocPassive: 1, respecPassives: 1, allocSkill: 1, respecSkills: 1, acceptQuest: 3, ensureMain: 1, questProgress: 3, turnIn: 3,
  death: 2, loot: 11, lootMats: 6, gold: 2, xp: 1, config: 4, restock: 2, clientSync: 2, newHero: 1,
  // ⚠ R19-01: только правка старта классов и очков за уровень (в `config` она — две из пятнадцати): зовёт свой профиль (R18-07), здесь — 0,
  // чтобы цепочки прочих профилей не сдвинулись.
  classEdit: 0,
  // ⭐ D2: правка прокачки (старт, очки за уровень всех трёх пулов, кривая, древа) — свой профиль; в общем она идёт через `config`.
  progEdit: 0,
  // ⭐ D2: вход героя заново (сервер дописывает сейв старше правила, записанное не трогает).
  reenter: 1,
  // ⚠ R23-04: множитель цены редкости ВНИЗ, до нуля (`rarities.priceMult`), — свой профиль. Здесь — 0: он дешевит и золото кузницы
  // (`forgeGold`), а правки конфига общего профиля нарочно «игроку хуже» (`configPlan`) — иначе гросбух мерил бы баланс цен подъёма.
  priceEdit: 0,
};

/** Цепочка шагов из сида: виды по весам, от состояния не зависит (сжатие это и требует). */
export function genOps(seed: number, len: number, weights: Partial<Record<OpKind, number>> = OP_WEIGHTS): Op[] {
  const r = createRng((seed * 2654435761) >>> 0 || 1);
  const kinds = Object.entries(weights).filter(([, w]) => (w ?? 0) > 0) as [OpKind, number][];
  const total = kinds.reduce((s, [, w]) => s + w, 0);
  const out: Op[] = [];
  for (let i = 0; i < len; i++) {
    let roll = r.next() * total;
    let k = kinds[kinds.length - 1]![0];
    for (const [kind, w] of kinds) { roll -= w; if (roll < 0) { k = kind; break; } }
    out.push({ k, h: r.chance(0.5) ? 0 : 1, s: r.int(1, 2 ** 31 - 1) });
  }
  return out;
}

// ── Конфиг: общий неизменяемый образец и живые правки ──────────────────────────────────────────────

type Tables = Record<string, unknown>;
const tablesOf = (r: ConfigRegistry): Tables => (r as unknown as { data: Tables }).data;
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}
let PRISTINE: Tables | null = null;
/**
 * Конфиг по умолчанию — разобран ОДИН раз и заморожен целиком: реестры цепочек делят таблицы (копия карты, не таблиц). Правка
 * конфига на месте любым кодом игры — бросок `TypeError` (строгий режим модулей), то есть нарушение «упал»: общая таблица,
 * поправленная одним вызовом, на сервере поехала бы у всех.
 */
export function pristineTables(): Tables {
  if (!PRISTINE) { const r = new ConfigRegistry(); r.loadAll(); PRISTINE = deepFreeze({ ...tablesOf(r) }); }
  return PRISTINE;
}
/** Реестр поверх набора таблиц (карта своя, таблицы общие и замороженные). */
export function regFrom(tables: Tables): ConfigRegistry {
  const r = new ConfigRegistry();
  (r as unknown as { data: Tables }).data = { ...tables };
  return r;
}
/** Правка одной таблицы живьём — как `/api/dev/config` → `reload`: копия, правка, разбор схемой, заморозка. */
export function reloadTable<K extends keyof ConfigShapes>(reg: ConfigRegistry, key: K, edit: (t: ConfigShapes[K]) => void): void {
  const t = structuredClone(reg.get(key));
  edit(t);
  reg.reload({ [key]: t } as Partial<Record<K, unknown>>);
  deepFreeze(tablesOf(reg)[key]);
}

// ── Мир ───────────────────────────────────────────────────────────────────────────────────────────

export interface FuzzWorld {
  /** Конфиг сервера (живой). */
  reg: ConfigRegistry;
  /** Конфиг клиента — по нему он показывает цены (может отставать от сервера). */
  view: ConfigRegistry;
  heroes: [SaveState, SaveState];
  stash: AccountStash;
  /** Снаряжение прилавка (сток героя 0) и зелья лавки. */
  shop: Item[];
  potions: Item[];
  board: QuestDef[];
  boardAt: number;
  /** Часы сервера (мс). */
  now: number;
  /** Ключи заявок на ковку, которые слал каждый герой. */
  nonces: [string[], string[]];
  n: number;
  /** Поколение конфига (кэш оценок). */
  cfgVer: number;
  /** Заявка ковки, под которую последний раз падало сырьё с тел: ковка чаще берёт её (иначе сырья не хватает почти всегда). */
  pending?: CraftInput;
  pendingHero?: 0 | 1;
  /** Вещи аккаунта на земле (выброшены героем — поднять может сосед по аккаунту): для переписи комнаты. */
  ground?: Item[];
  /** ⭐ C-01: база и ступень, которые правка хозяина посадила РОВНО на потолок требований (`landOnCap`): находки чаще их. */
  landed?: { baseId: string; tierLevel: number };
  /** ⭐ C-01: потолок требований, под которым вещь (uid + требования) встретилась впервые (`birthCap`). */
  reqCaps?: Map<string, number>;
  /** ⚠ R18-07 / ⭐ D2: книга очков каждого героя (`PointsBook`) — по ней I4 меряет вложенное и выданное по всем трём пулам. */
  books: [PointsBook, PointsBook];
  liqCache: Map<string, number>;
}

/**
 * ⚠ R18-07 / ⭐ D2: КНИГА ОЧКОВ ГЕРОЯ — модель, а не сейв: старт, с которым герой создан (строка класса В ТОТ МОМЕНТ), и очки, выданные
 * уровнями по очкам за уровень того времени — по пулам (`cum.attr[L]` — очков атрибутов выдано к уровню L; `skill`, `mastery` — так же).
 * Правка хозяина живьём (строка класса, очки за уровень, кривая, древа) выданного не пересчитывает: I4 мерил вложенное от нынешней строки —
 * так же, как мерил его сброс, и правка «Сила 20→15, Ловкость 15→20» с последующим сбросом (+5 очков из воздуха) была ему не видна; очки
 * скилов и мастерства мерил по ЖИВЫМ очкам за уровень — правку их он не пережил бы.
 * ⚠ R19-01: `floor` — старт, который сейв обязан помнить (у героя, созданного после R18-07, — тот же `start`). Сейв старше R18-07 (`legacy`)
 * старта не помнит, пока его не запишет первый вход или сброс: по атрибуту не выше нынешнего значения и не выше строки класса В ТОТ МИГ —
 * модель считает это сама в плане шага (`pending`) и сверяет после него. Итог героя (`start` + выданное) сброс не двигает ни у кого.
 * ⭐ D2: `ledger` — сдвиг книги заработанного сейва (`save.earned`) от выданного моделью: у героя, созданного с книгой, — нули. Сейв старше D2
 * (`legacyLedger`) книги не помнит, пока её не допишет вход или сброс (`settleEarned`) — из того, что у героя есть: модель считает дописку сама
 * в плане шага (`pendingLedger`), дальше ждёт `save.earned` = выдано моделью + сдвиг. Нет `ledger` — сейв книги не помнит и не должен.
 */
export interface PointsBook {
  start: Record<string, number>; level: number; cum: { attr: number[]; skill: number[]; mastery: number[] };
  legacy?: boolean; floor?: Record<string, number>; pending?: Record<string, number>;
  legacyLedger?: boolean; ledger?: EarnedPoints; pendingLedger?: EarnedPoints;
}
function bookOf(reg: ConfigRegistry, s: SaveState): PointsBook {
  const cls = reg.get('classes').find((c) => c.id === s.classId);
  const b = reg.get('balance');
  const start = { ...(cls?.startAttributes ?? s.attributes) };
  const line = (per: number): number[] => Array.from({ length: s.level + 1 }, (_, l) => Math.max(0, l - 1) * per);
  return {
    start, level: s.level, cum: { attr: line(b.attributePointsPerLevel), skill: line(b.skillPointsPerLevel), mastery: line(b.masteryPointsPerLevel) },
    ...(s.startAttributes ? { floor: { ...start } } : { legacy: true }),
    ...(s.earned ? { ledger: { attributePoints: 0, skillPoints: 0, masteryPoints: 0 } } : { legacyLedger: true }),
  };
}
/**
 * Книга ← уровни героев после шага: каждый новый уровень — по очкам за уровень нынешнего конфига (шаг шёл при нём; правка конфига —
 * отдельный шаг). Уровень ниже записанного (комната поднялась из базы после падения) — книга помнит выданное к каждому уровню; в ядре
 * такое — нарушение ⭐ D2 `level-drop` (уровни не отнимаются, R9-05; шаг падения процесса комната судит отдельно).
 */
function noteLevels(w: FuzzWorld, out: Violation[]): void {
  const bal = w.reg.get('balance');
  w.heroes.forEach((s, h) => {
    const b = w.books[h]!;
    if (s.level < b.level) out.push({ inv: 'I4', code: 'level-drop', id: `${h}`, msg: `герой ${h}: уровень ${b.level} → ${s.level} — уровни не отнимаются (R9-05)` });
    for (let l = b.level + 1; l <= s.level && l <= 10_000; l++) {
      b.cum.attr[l] = (b.cum.attr[l - 1] ?? 0) + bal.attributePointsPerLevel;
      b.cum.skill[l] = (b.cum.skill[l - 1] ?? 0) + bal.skillPointsPerLevel;
      b.cum.mastery[l] = (b.cum.mastery[l - 1] ?? 0) + bal.masteryPointsPerLevel;
    }
    b.level = s.level;
  });
}
/** ⚠ R19-01: старт, который вход или сброс запишет сейву без него (не выше своих атрибутов и нынешней строки класса) — модель считает сама. */
function legacyStartOf(reg: ConfigRegistry, s: SaveState): Record<string, number> | undefined {
  const row = reg.get('classes').find((c) => c.id === s.classId)?.startAttributes;
  return row ? Object.fromEntries(ATTRIBUTES.map((a) => [a, Math.max(0, Math.min(Math.floor(s.attributes[a]), row[a]))])) : undefined;
}
/**
 * ⭐ D2: что допишет вход или сброс сейву старше правила — модель считает сама (план шага, до исполнения): старт (R19-01) и книгу заработанного
 * из того, что у героя есть: атрибуты сверх старта целым + свободные, Σ рангов скилов и мастерства + свободные.
 */
function planSettle(w: FuzzWorld, h: 0 | 1, s: SaveState): void {
  const book = w.books[h]!;
  const st = s.startAttributes ?? legacyStartOf(w.reg, s);
  if (!s.startAttributes && st) book.pending = st;
  if (s.earned || !st) return;
  let over = 0;
  for (const a of ATTRIBUTES) over += Math.max(0, s.attributes[a] - st[a]!);
  const ranks = (m: Record<string, number>): number => Object.values(m).reduce((n, v) => n + (v > 0 ? v : 0), 0);
  book.pendingLedger = {
    attributePoints: Math.floor(over) + s.unspentAttributePoints,
    skillPoints: ranks(s.skills) + s.unspentSkillPoints,
    masteryPoints: ranks(s.masteries) + s.unspentMasteryPoints,
  };
}
/** Очки скилов наград сданных заданий героя (цепочка) — выданное сверх уровней. */
function questSkillBonus(s: SaveState): number {
  return s.quests.filter((q) => q.status === 'turned-in')
    .reduce((n, q) => n + (s.activeQuestDefs.find((d) => d.id === q.questId)?.reward.skillPoints ?? 0), 0);
}
let PRISTINE_REG: ConfigRegistry | null = null;
/** Реестр по умолчанию (общий, только для чтения) — «конфиг, которого никто не правил», для сверки `refund-config`. */
function pristineReg(): ConfigRegistry { return (PRISTINE_REG ??= regFrom(pristineTables())); }

const dimsOf = (reg: ConfigRegistry): Dims => reg.get('balance').inventory;
const windowMs = (reg: ConfigRegistry): number => Math.max(0, reg.get('balance').townRestockSec) * 1000;

/** Сток кузницы — тот же бросок, что `Room.rollGear` (ступень окном, `shop`, без уников). */
export function rollShop(reg: ConfigRegistry, heroLevel: number, rng: Rng): Item[] {
  const itemsBase = reg.get('items.base');
  const loot = reg.get('balance').loot;
  const level = Math.max(1, heroLevel);
  const on = itemsBase.filter((b) => b.enabled !== false);
  const pools = [
    on.filter((b) => b.kind === 'weapon' && b.attackType === 'melee'),
    on.filter((b) => b.kind === 'weapon' && b.attackType === 'ranged'),
    on.filter((b) => b.kind === 'armor' || b.kind === 'shield' || b.kind === 'jewelry'),
  ];
  const gear: Item[] = [];
  for (const [i, pool] of pools.entries()) {
    for (let n = 0; n < [5, 3, 5][i]! && pool.length; n++) {
      gear.push(shapeFoundWeapon(reg, generateItem(itemsBase, reg.get('affixes'), reg.get('uniques'), {
        dropBias: 1.3, itemLevel: level + 1, baseId: rng.pick(pool).id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
        tierLevel: rollTierLevel(level + 1, loot.tierWindow, rng), rareNames: reg.get('rare-names'),
        maxReqTotal: reg.get('balance').maxTotalRequirement, baseRoll: loot.baseRoll, origin: 'shop', noUnique: true,
      }, rng)));
    }
  }
  return gear;
}
/** Зелья лавки — как `Room.freshConsumables`. */
export function rollPotions(reg: ConfigRegistry): Item[] {
  const out: Item[] = [];
  for (const id of shopConsumableIds(reg)) for (let n = 0; n < SHOP_CONSUMABLE_STOCK; n++) {
    const p = itemFromBaseId(reg.get('items.base'), id, undefined, 'shop');
    if (p) out.push(p);
  }
  return out;
}

/** Находка с тела/сундука/босса — как `GameSession.killMonster`: ступень окном, клинок из деталей, трофей бывает сломан. */
export function foundItem(reg: ConfigRegistry, r: Rng, opts: { weapon?: boolean; level?: number; near?: number } = {}): Item {
  const loot = reg.get('balance').loot;
  const lvl = opts.level ?? (opts.near !== undefined && r.chance(0.7) ? Math.max(1, opts.near + r.int(-8, 4)) : r.int(1, 95));
  const on = reg.get('items.base').filter((b) => b.enabled !== false);
  if (!opts.weapon && r.chance(0.08)) {
    const pots = on.filter((b) => b.kind === 'consumable');
    const p = pots.length ? itemFromBaseId(reg.get('items.base'), r.pick(pots).id, undefined, 'drop') : null;
    if (p) return p;
  }
  const weapons = on.filter((b) => b.kind === 'weapon');
  const gear = on.filter((b) => b.kind !== 'consumable');
  // Редкие по пулу, но важные для правил рук: полуторное (одной рукой — только со щитом) и щиты — чаще, чем их доля в пуле.
  const versatile = weapons.filter((b) => b.versatile);
  const shields = on.filter((b) => b.kind === 'shield');
  const x = r.next();
  const baseId = x < 0.08 && versatile.length ? r.pick(versatile).id
    : x < 0.14 && shields.length && !opts.weapon ? r.pick(shields).id
    : (opts.weapon || r.chance(0.55)) && weapons.length ? r.pick(weapons).id
    : r.chance(0.5) && gear.length ? r.pick(gear).id : undefined;
  const origin: ItemOrigin = r.pick(['drop', 'drop', 'chest', 'boss'] as const);
  const item = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
    dropBias: r.float(0.5, 4), itemLevel: lvl, tierLevel: rollTierLevel(lvl, loot.tierWindow, r), baseId,
    tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), categoryWeights: baseId ? undefined : loot.categoryWeights,
    rareNames: reg.get('rare-names'), maxReqTotal: reg.get('balance').maxTotalRequirement, baseRoll: loot.baseRoll, origin,
  }, r));
  // Сломанными падают только трофеи и не уники (`killMonster`, R7-19).
  if (baseId && item.rarity !== 'unique' && r.chance(0.25)) item.broken = true;
  return item;
}

/** ⭐ C-01: находка ТОЙ базы на ТОЙ ступени, что правка посадила на потолок требований (`landOnCap`) — дроп/сундук, как `foundItem`. */
function landedItem(reg: ConfigRegistry, r: Rng, at: { baseId: string; tierLevel: number }): Item {
  return shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
    dropBias: r.float(0.5, 4), itemLevel: at.tierLevel + r.int(0, 3), tierLevel: at.tierLevel, baseId: at.baseId,
    tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), rareNames: reg.get('rare-names'),
    maxReqTotal: reg.get('balance').maxTotalRequirement, baseRoll: reg.get('balance').loot.baseRoll, origin: r.pick(['drop', 'chest'] as const),
  }, r));
}

/** Стартовое состояние цепочки: два героя одного аккаунта (история — законная: опыт, находки, журнал разборами). */
export function newWorld(seed: number): FuzzWorld {
  const r = createRng((seed * 7919 + 13) >>> 0 || 1);
  const reg = regFrom(pristineTables());
  const bal = reg.get('balance');
  const classes = reg.get('classes').filter((c) => c.enabled !== false);
  const dims = dimsOf(reg);
  // ⚠ R19-01: герой, созданный до R18-07, старта не помнит (таких в базе все старые) — свой бросок, чтобы миры прочих сидов не сдвинулись.
  const old = createRng((seed * 2654435761 + 11) >>> 0 || 7);
  // ⭐ D2: и книги заработанного не помнит; герой между R18-07 и D2 — старт помнит, книгу нет. Тоже свой бросок.
  const preD2 = createRng((seed * 40503 + 17) >>> 0 || 5);
  const mk = (i: number): SaveState => {
    const s = newCharacterSave(reg, r.pick(classes).id, `Ф${i}`, `fz${seed}-${i}`);
    if (old.chance(0.35)) delete s.startAttributes;
    if (!s.startAttributes || preD2.chance(0.3)) delete s.earned;
    s.createdAt = 0;
    if (r.chance(0.8)) gainXp(s, bal, xpForLevel(r.int(2, 70), bal.xpTable));
    // Очки — вложены (законно) целиком или частью; часть ждёт.
    const keep = r.chance(0.3) ? r.int(0, s.unspentAttributePoints) : 0;
    for (let k = 0; k < 12 && s.unspentAttributePoints > keep; k++) allocAttr(s, r.pick(ATTRIBUTES), r.int(1, s.unspentAttributePoints - keep));
    s.gold = r.chance(0.12) ? 0 : r.int(10, 40_000);
    for (let n = r.int(0, 14); n > 0; n--) addToInventory(s.inventory, foundItem(reg, r, { near: s.level }), dims);
    return s;
  };
  const heroes: [SaveState, SaveState] = [mk(0), mk(1)];
  const stash = emptyStash(reg);
  const mats = reg.get('craft-materials');
  for (let n = r.int(0, 25); n > 0; n--) { const m = r.pick(mats); stash.materials![m.id] = (stash.materials![m.id] ?? 0) + r.int(1, 120); }
  const sd = stashDims(reg);
  for (let n = r.int(0, 10); n > 0; n--) addToInventory(stash.tabs[r.int(0, stash.tabs.length - 1)]!, foundItem(reg, r), sd);
  // Журнал: пусто — или история разборов у кузнеца (законный путь его роста), плюс счёт мификов прошлого.
  if (r.chance(0.6)) {
    let j = normalizeJournal(undefined);
    for (let n = r.int(1, 70); n > 0; n--) j = salvageIntoJournal(reg, j, foundItem(reg, r, { weapon: true })).journal;
    if (r.chance(0.3)) j.mythic = r.int(0, 6);
    if (r.chance(0.7)) j.sketches += r.int(0, 4);
    stash.forgeJournal = j;
    // История: что-то уже сковано (сырьё и золото — с тел, ковка — настоящая).
    for (let n = r.chance(0.5) ? r.int(1, 3) : 0; n > 0; n--) {
      const inp = feasibleInput(reg, j, r);
      const pv = inp ? craftWeapon(reg, inp, { journal: j, materialsOn: true }) : null;
      if (!inp || !pv?.cost) continue;
      const hero = heroes[r.int(0, 1)]!;
      hero.gold += pv.cost.gold;
      for (const [id, k] of Object.entries(pv.cost.materials)) stash.materials![id] = (stash.materials![id] ?? 0) + k;
      craftAction(reg, hero, stash, `init-${seed}-${n}`.padEnd(8, '0'), inp, r);
    }
  }
  sanitizeStash(reg, stash);
  const now = 1_700_000_000_000 + r.int(0, 1e6);
  const w: FuzzWorld = {
    reg, view: regFrom(tablesOf(reg)), heroes, stash, shop: [], potions: [], board: [], boardAt: now, now,
    nonces: [[], []], n: 0, cfgVer: 0, books: [bookOf(reg, heroes[0]), bookOf(reg, heroes[1])], liqCache: new Map(),
  };
  restock(w, r);
  return w;
}

function restock(w: FuzzWorld, r: Rng): void {
  w.shop = rollShop(w.reg, w.heroes[0].level, r);
  w.potions = rollPotions(w.reg);
  w.boardAt = w.now;
  w.board = generateBoard(w.reg, r, w.now);
}

// ── Перепись состояния ───────────────────────────────────────────────────────────────────────────

/** Где лежит вещь. */
type Where = `inv${0 | 1}` | `eq${0 | 1}` | `belt${0 | 1}` | `leg${0 | 1}` | `tab${number}` | 'ground';
interface Held { item: Item; where: Where; key: string }

export interface Census {
  /** Сейвы и сундук в каноническом виде — для «отказ ничего не тронул». */
  json: string;
  heroJson: [string, string];
  stashJson: string;
  gold: [number, number];
  /** Сырьё аккаунта по id: стеки в сумках и вкладках + кошелёк. */
  mats: Record<string, number>;
  /** Вещи (не сырьё) по uid. */
  items: Map<string, Held>;
  /** Все uid (с сырьём) — для уникальности; где лежит каждый. */
  uidList: string[];
  uidWhere: Map<string, string[]>;
  value: number;
  journal: CraftJournal;
  nonces: string;
}

const keyOf = (it: Item): string => { const { pos: _p, ...rest } = it; return JSON.stringify(rest); };

/** Во что вещь обращается городом: лучшее из «продать» и «разобрать у кузнеца» (верх вилки по `sellPrice`). */
export function liquidation(w: FuzzWorld, it: Item, key = keyOf(it)): number {
  const k = `${w.cfgVer}|${key}`;
  const hit = w.liqCache.get(k);
  if (hit !== undefined) return hit;
  const v = it.kind === 'material' ? shopSellPrice(w.reg, it) : Math.max(shopSellPrice(w.reg, it), salvageWorth(w.reg, it));
  if (w.liqCache.size > 50_000) w.liqCache.clear();
  w.liqCache.set(k, v);
  return v;
}

/** Канонический сундук: журнал и ключи — как их нормализует чтение из базы (ноль в счёте жалости = нет записи). */
function canonStash(st: AccountStash): AccountStash {
  return { ...st, forgeJournal: normalizeJournal(st.forgeJournal), craftNonces: normalizeCraftNonces(st.craftNonces) };
}

/**
 * Сейв для «отказ ничего не тронул»: без служебного сервера — опознания стока (`townStock`, пишет покупка и заход в город) и
 * здоровья на момент записи (`vitals`, пишет запись): это не действие игрока и не экономика.
 */
const heroCanon = (s: SaveState): string => JSON.stringify({ ...s, townStock: undefined, vitals: undefined });

export function census(w: FuzzWorld): Census {
  const heroJson: [string, string] = [heroCanon(w.heroes[0]), heroCanon(w.heroes[1])];
  const stashJson = JSON.stringify(canonStash(w.stash));
  const mats: Record<string, number> = {};
  const items = new Map<string, Held>();
  const uidList: string[] = [];
  const uidWhere = new Map<string, string[]>();
  const priceOf = new Map(w.reg.get('craft-materials').map((m) => [m.id, m.sellPrice] as const));
  let value = 0;
  const see = (it: Item | null | undefined, where: Where): void => {
    if (!it) return;
    uidList.push(it.uid);
    const wh = uidWhere.get(it.uid);
    if (wh) wh.push(where); else uidWhere.set(it.uid, [where]);
    const key = keyOf(it);
    value += liquidation(w, it, key);
    if (it.kind === 'material') {
      if (it.materialId) mats[it.materialId] = (mats[it.materialId] ?? 0) + (it.count ?? 1);
      return;
    }
    items.set(it.uid, { item: it, where, key });
  };
  w.heroes.forEach((s, h) => {
    const i = h as 0 | 1;
    value += s.gold;
    for (const it of s.inventory) see(it, `inv${i}`);
    for (const it of Object.values(s.equipment)) see(it, `eq${i}`);
    for (const it of s.belt) see(it, `belt${i}`);
    for (const it of s.stash ?? []) see(it, `leg${i}`);
  });
  w.stash.tabs.forEach((tab, t) => { for (const it of tab) see(it, `tab${t}`); });
  for (const it of w.ground ?? []) see(it, 'ground');
  for (const [id, n] of Object.entries(w.stash.materials ?? {})) {
    mats[id] = (mats[id] ?? 0) + n;
    value += n * (priceOf.get(id) ?? 0);
  }
  return {
    json: `${heroJson[0]}\n${heroJson[1]}\n${stashJson}`, heroJson, stashJson,
    gold: [w.heroes[0].gold, w.heroes[1].gold], mats, items, uidList, uidWhere, value,
    journal: normalizeJournal(w.stash.forgeJournal), nonces: JSON.stringify(normalizeCraftNonces(w.stash.craftNonces)),
  };
}

// ── Итог шага и его ожидания ───────────────────────────────────────────────────────────────────────

export interface Res { ok: boolean; reason?: string; uid?: string }

/** Что шагу разрешено менять (при успехе). Всё не названное — обязано остаться как было. */
export interface Spec {
  /** Золото героя `h`: ровно `delta`; `maxPay` — согласие (заплачено не больше); `minGet` — продано не дешевле; `free` — любое. */
  gold?: { h: 0 | 1; delta?: number; maxPay?: number; minGet?: number; free?: boolean };
  /** Сырьё: `spend` — списано ровно; `maxSpend` — согласие; `gain` — приход в вилке; `minGain` — согласие; `loss` — только убыль; `free` — любой приход. */
  mats?: {
    spend?: MaterialCost; maxSpend?: Record<string, number>; gain?: Record<string, { min: number; max: number }>;
    minGain?: Record<string, number>; loss?: boolean; free?: boolean;
  };
  /** Ровно эти вещи уходят. */
  consumes?: string[];
  /** Могут уйти вещи из сумки героя (смерть). */
  bagLoss?: 0 | 1;
  /** Герой удалён целиком (вещи сумки, надетое и пояс уходят). */
  heroGone?: 0 | 1;
  /** Эти вещи вправе поменяться (тот же uid). */
  transforms?: string[];
  /** Появиться вправе ровно `n` новых вещей (−1 — ноль или одна, −2 — сколько угодно) и проверка каждой. */
  creates?: { n: number; check?: (it: Item) => string | null };
  /** Гросбух: на сколько ценность вправе вырасти (впрыск). */
  injected?: number;
  /** Своё правило журнала (по умолчанию журнал не меняется). */
  journal?: (before: CraftJournal, after: CraftJournal) => string | null;
  /** Ключи заявок вправе поменяться. */
  nonces?: boolean;
  /** ⚠ R19-01: Σ атрибутов + свободные очки атрибутов героя `h` — ровно `total` (сброс очки переносит, а не теряет и не создаёт). */
  attrTotal?: { h: 0 | 1; total: number };
  /** Прочие проверки итога. */
  extra?: () => string | null;
}

export interface Plan {
  desc: string;
  /** Чей шаг (план вправе заменить героя шага: ковку под упавшее сырьё зовёт тот, кому оно упало). */
  h?: 0 | 1;
  /** `town` — действие игрока (гросбух не растёт); `inject` — добыча/опыт (растёт не больше впрыска); `meta` — конфиг, сток. */
  kind: 'town' | 'inject' | 'meta';
  /** Команда сервера (`TownCommand`) — для прогона через комнату. Нет — шаг только локальный. */
  cmd?: Record<string, unknown>;
  run: () => Res;
  spec: (res: Res) => Spec;
}

const refuse = (desc: string, kind: Plan['kind'] = 'town'): Plan => ({ desc, kind, run: () => ({ ok: false, reason: 'нечего делать' }), spec: () => ({}) });
const asRes = (r: ActionResult & { uid?: string }): Res => ({ ok: r.ok, reason: r.reason, uid: r.uid });

// ── Броски аргументов ────────────────────────────────────────────────────────────────────────────

type Consent = 'none' | 'view' | 'off' | 'junk';
function consentMode(r: Rng): Consent {
  const x = r.next();
  return x < 0.35 ? 'none' : x < 0.84 ? 'view' : x < 0.95 ? 'off' : 'junk';
}
const JUNK_NUM = [Number.NaN, -1, Infinity, -Infinity, 0.5, 1e18, 0];
/** Согласие на цену (`maxGold`): нет поля, цена клиента, ниже её, мусор. */
function payConsent(r: Rng, shown: () => number | undefined): number | undefined {
  const m = consentMode(r);
  if (m === 'none') return undefined;
  if (m === 'junk') return r.pick(JUNK_NUM);
  const v = shown();
  if (v === undefined) return undefined;
  return m === 'off' ? v - r.int(1, 60) : v;
}
/** Согласие на выручку (`minGold`): цена клиента, выше её, мусор. */
function getConsent(r: Rng, shown: () => number | undefined): number | undefined {
  const m = consentMode(r);
  if (m === 'none') return undefined;
  if (m === 'junk') return r.pick(JUNK_NUM);
  const v = shown();
  if (v === undefined) return undefined;
  return m === 'off' ? v + r.int(1, 60) : v;
}
/** Согласие на сырьё (`maxMaterials` / `minYield` / `avgYield`): карта клиента, сдвинутая, мусор. */
function mapConsent(r: Rng, shown: () => Record<string, number> | null | undefined, dir: -1 | 1): Record<string, number> | undefined {
  const m = consentMode(r);
  if (m === 'none') return undefined;
  if (m === 'junk') {
    const junk: Record<string, number>[] = [
      { 'iron-1': Number.NaN }, { 'iron-1': -1 }, {}, { 'iron-1': 1.5 }, { 'iron-1': Infinity }, [] as unknown as Record<string, number>,
    ];
    return r.pick(junk);
  }
  const v = shown();
  if (!v) return undefined;
  const out = { ...v };
  if (m === 'off') {
    const ids = Object.keys(out);
    if (ids.length) { const id = r.pick(ids); out[id] = Math.max(0, out[id]! + dir * r.int(1, 5)); }
  }
  return out;
}

/** Вещь из сумки: по предикату (если есть такие), иначе любая; изредка — чужой или несуществующий uid. */
function pickUid(w: FuzzWorld, r: Rng, h: 0 | 1, pred?: (it: Item) => boolean): string {
  const s = w.heroes[h];
  const x = r.next();
  if (x < 0.04) return 'нет-такой-вещи';
  if (x < 0.07) { const eq = Object.values(s.equipment).filter(Boolean) as Item[]; if (eq.length) return r.pick(eq).uid; }
  if (x < 0.10) { const o = w.heroes[1 - h as 0 | 1].inventory; if (o.length) return r.pick(o).uid; }
  if (x < 0.12) { const t = w.stash.tabs.flat(); if (t.length) return r.pick(t).uid; }
  const good = pred ? s.inventory.filter(pred) : s.inventory;
  const pool = good.length ? good : s.inventory;
  return pool.length ? r.pick(pool).uid : 'пустая-сумка';
}
const invItem = (s: SaveState, uid: string): Item | undefined => s.inventory.find((i) => i.uid === uid);
const isFoundWeapon = (it: Item): boolean => it.kind === 'weapon' && !it.parts;
const isCrafted = (it: Item): boolean => !!it.parts;
/**
 * ⚠ R17-03: форма, за которую платит шаг (ковка — ёмкость вещи; зачарование и перекатка — она же, зажатая лимитами редкости, как
 * `rolledFormMult`), — по СЫРОЙ таблице `balance.craft.formMult`, мимо `formMult`: форма без строки шла по ×1, и сверка той же функцией
 * этого не увидела бы. Нарушение строкой или `null`.
 */
function unpricedForm(reg: ConfigRegistry, cap: AffixForm | undefined, rarity?: string): string | null {
  if (!cap) return null;
  const s = rarity ? affixSlotsFor(reg.get('rarities').find((x) => x.id === rarity), cap) : { maxPrefix: cap.prefix, maxSuffix: cap.suffix };
  const f = { prefix: s.maxPrefix, suffix: s.maxSuffix };
  if (f.prefix + f.suffix === 0 || Object.prototype.hasOwnProperty.call(reg.get('balance').craft.formMult, formKey(f))) return null;
  return `оплачена форма ${formKey(f)} без цены в balance.craft.formMult (ёмкость вещи ${formKey(cap)})`;
}

// ── Ковка: заявки ────────────────────────────────────────────────────────────────────────────────

/** Заявка из открытого в журнале (иногда с неоткрытой деталью), ступени — к потолку журнала. */
type WeaponBaseRow = Extract<ConfigShapes['items.base'][number], { kind: 'weapon' }>;
function journalInput(reg: ConfigRegistry, j: CraftJournal, r: Rng): CraftInput | null {
  const bases = j.bases.map((id) => reg.get('items.base').find((b) => b.id === id)).filter((b): b is WeaponBaseRow => b?.kind === 'weapon');
  if (!bases.length) return null;
  const base = r.pick(bases);
  const cls = base.weaponClass;
  const hands = base.hands ?? 1;
  const keySlot = keySlotOf(reg, cls);
  const cap = journalTierCap(reg, j);
  // Общая ступень материала, которая при ровной сборке даёт ступень вещи не выше потолка (t = round(1.5·(s−1))).
  const steps = [1, 2, 3, 4, 5].filter((s) => Math.round(1.5 * (s - 1) + 1e-9) <= Math.max(0, cap));
  const target = r.chance(0.75) && steps.length ? r.pick(steps) : r.int(1, 5);
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    let pool = variantsFor(reg, cls, slot, hands);
    if (slot === keySlot) pool = pool.filter((p) => baseOfKeyPart(reg, cls, hands, p) === base.id);
    const open = pool.filter((p) => j.variants.includes(p.id));
    const use = open.length && r.chance(0.9) ? open : pool;
    if (!use.length) return null;
    const p = r.pick(use);
    const step = r.chance(0.8) ? Math.min(p.stepMax, Math.max(p.stepMin, target)) : r.int(p.stepMin, p.stepMax);
    parts[slot] = { id: p.id, step };
  }
  const nf = reg.get('balance').craft.finish.length;
  return { weaponClass: cls, hands, parts, ...(r.chance(0.5) && nf ? { finish: r.int(0, nf - 1) } : {}) };
}
/** Заявка из журнала, которую журнал и окна ступеней ПРОПУСКАЮТ (несколько попыток); нет такой — `null`. */
function feasibleInput(reg: ConfigRegistry, j: CraftJournal, r: Rng): CraftInput | null {
  for (let k = 0; k < 10; k++) {
    const inp = journalInput(reg, j, r);
    if (inp && craftWeapon(reg, inp, { journal: j, materialsOn: true }).ok) return inp;
  }
  return null;
}
/** Заявка из любых деталей семейства (скорее всего — отказ журнала или окна). */
function randomInput(reg: ConfigRegistry, r: Rng): CraftInput | null {
  const types = reg.get('weapon-types');
  if (!types.length) return null;
  const t = r.pick(types);
  const hands = r.chance(0.5) ? 1 : 2;
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = reg.get('weapon-parts').filter((p) => p.slot === slot && (p.classes as string[]).includes(t.id));
    if (!pool.length) return null;
    const p = r.pick(pool);
    parts[slot] = { id: p.id, step: r.int(1, 5) };
  }
  return { weaponClass: t.id, hands, parts };
}
/** Кривые заявки с провода (схема сервера пропустила бы только часть; ядро обязано отказать без траты). */
function junkInput(r: Rng, good: CraftInput | null): unknown {
  const g = good ?? { weaponClass: 'sword', hands: 1, parts: { strike: { id: 'x', step: 1 }, grip: { id: 'x', step: 1 }, bind: { id: 'x', step: 1 }, head: { id: 'x', step: 1 } } };
  const c = structuredClone(g) as unknown as Record<string, unknown> & { parts: Record<string, Record<string, unknown>> };
  switch (r.int(0, 9)) {
    case 0: c.parts.strike!.step = 0; break;
    case 1: c.parts.grip!.step = 2.5; break;
    case 2: c.parts.head!.step = 6; break;
    case 3: c.hands = 3; break;
    case 4: delete c.parts.bind; break;
    case 5: c.extra = 1; break;
    case 6: c.parts.strike!.extra = 1; break;
    case 7: c.finish = 99; break;
    case 8: return JSON.parse('{"__proto__": {"x": 1}, "weaponClass": "sword", "hands": 1}');
    default: return r.pick([null, 'заявка', 42, [], {}]);
  }
  return c;
}

// ── Правило журнала при разборе (§12.2–12.4) ──────────────────────────────────────────────────────

const setDiff = (a: string[], b: string[]): string[] => a.filter((x) => !b.includes(x));
function sameJ(b: CraftJournal, a: CraftJournal, keys: (keyof CraftJournal)[]): string | null {
  for (const k of keys) if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) return `журнал: поле ${k} изменилось (${JSON.stringify(b[k])} → ${JSON.stringify(a[k])})`;
  return null;
}
const ALL_J: (keyof CraftJournal)[] = ['bases', 'variants', 'tierHi', 'classSalvages', 'sketches', 'mythic', 'typesSeen', 'typesForged'];
/**
 * Журнал после разбора `item` у кузнеца — по документации (CRAFT_WEAPONS.md §12.2–12.4), а не по `salvageIntoJournal`:
 * скованное и не оружие — журнал не трогают; найденное ИЛИ купленное оружие — открывает тип и потолок ступени; детали, кодекс,
 * жалость — только найденное (`drop`/`chest`/`boss`); мифик — только найденный t6 без подъёма кузнецом.
 */
function salvageJournalRule(reg: ConfigRegistry, item: Item): (b: CraftJournal, a: CraftJournal) => string | null {
  const base = reg.get('items.base').find((x) => x.id === item.baseId);
  const parts = partsOf(reg, item);
  const t = tierIndexOfItem(reg, item);
  const last = craftTiers(reg).length - 1;
  const type = typeOfItem(reg, item);
  return (b, a) => {
    if (!base || base.kind !== 'weapon' || item.parts || !parts) return sameJ(b, a, ALL_J);
    const s = sameJ(b, a, ['typesForged']);
    if (s) return s;
    if (setDiff(b.bases, a.bases).length) return 'журнал: база пропала';
    const nb = setDiff(a.bases, b.bases);
    if (nb.some((x) => x !== item.baseId)) return `журнал: открыта чужая база ${nb.join(',')}`;
    if (a.tierHi !== Math.max(b.tierHi, t)) return `журнал: потолок ${b.tierHi} → ${a.tierHi}, а вещь ступени ${t}`;
    if (!countsAsFind(item)) return sameJ(b, a, ['variants', 'typesSeen', 'classSalvages', 'sketches', 'mythic']);
    if (setDiff(b.variants, a.variants).length) return 'журнал: деталь пропала';
    const ids = CRAFT_SLOT_LIST.map((sl) => parts[sl].id);
    const nv = setDiff(a.variants, b.variants);
    if (nv.some((x) => !ids.includes(x))) return `журнал: открыта чужая деталь ${nv.join(',')}`;
    const nt = setDiff(a.typesSeen, b.typesSeen);
    if (nt.some((x) => x !== type?.typeId)) return `журнал: кодекс открыл чужой тип ${nt.join(',')}`;
    // Жалость (§12): каждый `sketchAfter`-й разбор найденного оружия класса — эскиз; счёт класса +1 (или обнуляется остатком).
    const every = reg.get('balance').craft.journal.sketchAfter;
    const n = (b.classSalvages[base.weaponClass] ?? 0) + 1;
    const sketch = n >= every;
    if (a.sketches !== b.sketches + (sketch ? 1 : 0)) return `журнал: эскизов ${b.sketches} → ${a.sketches} при счёте класса ${n} из ${every}`;
    if ((a.classSalvages[base.weaponClass] ?? 0) !== (sketch ? n - every : n)) return `журнал: счёт жалости ${base.weaponClass} ${n - 1} → ${a.classSalvages[base.weaponClass] ?? 0}`;
    for (const k of new Set([...Object.keys(a.classSalvages), ...Object.keys(b.classSalvages)])) {
      if (k !== base.weaponClass && a.classSalvages[k] !== b.classSalvages[k]) return `журнал: счёт жалости чужого класса ${k}`;
    }
    const mythic = t === last && countsAsMythicFind(item);
    if (a.mythic !== b.mythic + (mythic ? 1 : 0)) return `журнал: мификов ${b.mythic} → ${a.mythic} (вещь t${t}, ${item.origin}, поднята=${!!item.tierForged})`;
    return null;
  };
}

// ── План шага ────────────────────────────────────────────────────────────────────────────────────

/** Сколько золота уплачено: вещь цела и не сдвинулась ни на что, кроме названного. */
const onlyChanged = (before: Item, after: Item | undefined, keys: string[]): string | null => {
  if (!after) return 'вещь пропала';
  const strip = (it: Item): string => JSON.stringify(Object.fromEntries(Object.entries(it).filter(([k]) => !keys.includes(k) && k !== 'pos')));
  return strip(before) === strip(after) ? null : `вещь изменилась сверх ${keys.join('/')}: ${diffKeys(before, after, [...keys, 'pos'])}`;
};
function diffKeys(a: Item, b: Item, skip: string[]): string {
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  const ra = a as unknown as Record<string, unknown>, rb = b as unknown as Record<string, unknown>;
  for (const k of ks) if (!skip.includes(k) && JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) out.push(k);
  return out.join(',');
}
const findAnywhere = (w: FuzzWorld, uid: string): Item | undefined => {
  for (const s of w.heroes) {
    const it = s.inventory.find((i) => i.uid === uid) ?? Object.values(s.equipment).find((i) => i?.uid === uid) ?? s.belt.find((i) => i?.uid === uid);
    if (it) return it;
  }
  return w.stash.tabs.flat().find((i) => i.uid === uid);
};

/**
 * ПЛАН ШАГА: броски аргументов по состоянию, ожидания (цены и вилки — до исполнения), исполнение на ядре и команда для
 * комнаты. `rng` шага — от его сида: те же броски при повторе.
 */
export function plan(w: FuzzWorld, op: Op): Plan {
  const r = createRng(op.s);
  // Ковку под упавшее сырьё чаще затевает тот, кому оно упало (сырьё в сумке — у него, не у соседа).
  const h: 0 | 1 = op.k === 'craft' && w.pendingHero !== undefined && r.chance(0.7) ? w.pendingHero : op.h;
  const p = planFor(w, op, r, h);
  p.h = h;
  return p;
}

function planFor(w: FuzzWorld, op: Op, r: Rng, h: 0 | 1): Plan {
  const s = w.heroes[h];
  const reg = w.reg;
  const townRng = createRng((op.s ^ 0x9e3779b9) >>> 0 || 7);
  switch (op.k) {
    case 'buy': {
      const pool = [...w.shop, ...w.potions];
      if (!pool.length) return refuse('купить: прилавок пуст');
      const item = r.pick(pool);
      const potion = w.potions.includes(item);
      // Сток пережил срок — комната сперва катает новый (`stockStale`/`restock`), отказ.
      const stale = !potion && w.now - w.boardAt >= windowMs(reg);
      const off = potion ? !shopConsumableIds(reg).includes(item.baseId) : !reg.get('items.base').some((b) => b.id === item.baseId && b.enabled !== false);
      const price = shopBuyPrice(reg, item);
      const maxGold = payConsent(r, () => shopBuyPrice(w.view, item));
      return {
        desc: `купить «${item.name}» [${item.uid.slice(-6)}] за ${price}, согласие ${maxGold}${off ? ' (база выключена)' : ''}`,
        kind: 'town', cmd: { cmd: 'buy', uid: item.uid, ...(maxGold !== undefined ? { maxGold } : {}) },
        run: () => {
          if (stale) { restock(w, r); return { ok: false, reason: 'сток обновился' }; }
          if (off) return { ok: false, reason: 'нет в ассортименте' };
          const res = buyItem(reg, s, item, maxGold);
          if (res.ok) { w.shop = w.shop.filter((i) => i !== item); w.potions = w.potions.filter((i) => i !== item); }
          return asRes(res);
        },
        spec: () => ({
          gold: { h, delta: -price, maxPay: maxGold },
          creates: { n: 1, check: (it) => (it.uid !== item.uid ? 'появилась не купленная вещь' : it.origin !== 'shop' ? 'купленная вещь не из лавки' : null) },
        }),
      };
    }
    case 'sell': {
      const uid = pickUid(w, r, h);
      const it = invItem(s, uid);
      const price = it ? shopSellPrice(reg, it) : 0;
      const minGold = it ? getConsent(r, () => shopSellPrice(w.view, it)) : undefined;
      return {
        desc: `продать ${it ? `«${it.name}»×${it.count ?? 1}` : uid} за ${price}, согласие ${minGold}`,
        kind: 'town', cmd: { cmd: 'sell', uid, ...(minGold !== undefined ? { minGold } : {}) },
        run: () => asRes(sellItem(reg, s, uid, minGold)),
        spec: () => ({
          gold: { h, delta: price, minGet: minGold },
          ...(it?.kind === 'material' ? { mats: { spend: { [it.materialId!]: it.count ?? 1 } } } : { consumes: [uid] }),
        }),
      };
    }
    case 'craft': {
      const j = normalizeJournal(w.stash.forgeJournal);
      // Ключ заявки: свежий, свой прежний, соседа по аккаунту, кривой.
      const x = r.next();
      const mine = w.nonces[h], other = w.nonces[1 - h as 0 | 1];
      const nonce: unknown = x < 0.76 || (!mine.length && !other.length && x < 0.96) ? `fz-${String(++w.n).padStart(6, '0')}`
        : x < 0.86 && mine.length ? r.pick(mine)
        : x < 0.96 && other.length ? r.pick(other)
        : r.pick(['short', 'bad nonce!', '', 12345, undefined, 'x'.repeat(65)]);
      const y = r.next();
      const good = w.pending && r.chance(0.7) ? w.pending : r.chance(0.5) ? feasibleInput(reg, j, r) : journalInput(reg, j, r);
      const input: unknown = y < 0.8 && good ? good : y < 0.94 ? randomInput(reg, r) : junkInput(r, good);
      const parsed = parseCraftInput(reg, input);
      const pv = parsed.ok ? craftWeapon(reg, parsed.input, { journal: j, materialsOn: true }) : null;
      const pvView = parsed.ok ? craftWeapon(w.view, parsed.input, { journal: j, materialsOn: true }) : null;
      const maxGold = payConsent(r, () => pvView?.cost?.gold);
      const maxMaterials = mapConsent(r, () => pvView?.cost?.materials, -1);
      const replay = isCraftNonce(nonce) ? normalizeCraftNonces(w.stash.craftNonces).find((e) => e.n === nonce) : undefined;
      if (typeof nonce === 'string' && isCraftNonce(nonce) && !mine.includes(nonce)) mine.push(nonce);
      const cap = journalTierCap(reg, j);
      return {
        desc: `ковать ${pv?.item?.name ?? '?'} ${parsed.ok ? JSON.stringify(parsed.input.parts) : JSON.stringify(input)?.slice(0, 80)} ключ ${String(nonce)}${replay ? ' (повтор)' : ''}`
          + ` цена ${pv?.cost ? `${pv.cost.gold}з ${JSON.stringify(pv.cost.materials)}` : pv?.reason ?? (parsed.ok ? '' : parsed.reason)}, согласие ${maxGold} ${JSON.stringify(maxMaterials)}`,
        kind: 'town', cmd: { cmd: 'craft', nonce, input, ...(maxGold !== undefined ? { maxGold } : {}), ...(maxMaterials !== undefined ? { maxMaterials } : {}) },
        run: () => {
          const res = craftAction(reg, s, w.stash, nonce, input, townRng, { maxGold, maxMaterials });
          if (res.ok && input === w.pending) w.pending = undefined;
          return asRes(res);
        },
        spec: (res) => {
          if (replay) {
            return { extra: () => (res.uid !== replay.uid ? `повтор ключа ответил другой вещью ${res.uid} вместо ${replay.uid}` : null) };
          }
          if (!pv?.ok || !pv.cost || !parsed.ok) return { extra: () => 'ковка прошла там, где предпросмотр сервера отказывал' };
          const cost = pv.cost;
          return {
            gold: { h, delta: -cost.gold, maxPay: maxGold },
            mats: { spend: cost.materials, maxSpend: maxMaterials },
            nonces: true,
            journal: (b, a) => {
              const e = sameJ(b, a, ['bases', 'variants', 'tierHi', 'classSalvages', 'sketches', 'mythic', 'typesSeen']);
              if (e) return e;
              const nt = setDiff(a.typesForged, b.typesForged);
              return nt.length > 1 || nt.some((t) => t !== pv.type?.typeId) ? `журнал: «сковал» чужой тип ${nt.join(',')}` : null;
            },
            creates: {
              n: 1,
              check: (it) => {
                if (it.uid !== res.uid) return 'появилась вещь не с uid ответа';
                if (it.origin !== 'craft') return `скованная вещь с происхождением ${it.origin}`;
                if (JSON.stringify(it.parts) !== JSON.stringify(parsed.input.parts)) return 'детали вещи не те, что в заявке';
                const base = reg.get('items.base').find((b) => b.id === it.baseId);
                if (!base || base.enabled === false) return `скована выключенная база ${it.baseId}`;
                if (!j.bases.includes(it.baseId)) return `ворота журнала: база ${it.baseId} не открыта`;
                const closed = CRAFT_SLOT_LIST.map((sl) => it.parts![sl].id).filter((id) => !j.variants.includes(id));
                if (closed.length) return `ворота журнала: детали ${closed.join(',')} не открыты`;
                const offPart = CRAFT_SLOT_LIST.map((sl) => partById(reg, it.parts![sl].id)).find((p) => !p || p.enabled === false);
                if (offPart !== undefined) return `скована выключенная деталь ${offPart?.id}`;
                const t = tierIndexOfItem(reg, it);
                if (t > cap) return `ворота журнала: ступень t${t} выше потолка ${cap} (tierHi ${j.tierHi}, мификов ${j.mythic})`;
                if (craftTiers(reg)[t]?.enabled === false) return `скована выключенная ступень t${t}`;
                const offMat = Object.keys(cost.materials).find((id) => !reg.get('craft-materials').some((m) => m.id === id && m.enabled !== false));
                if (offMat) return `ковка съела выключенный материал ${offMat}`;
                if (it.rarity !== 'normal' || it.affixes.length) return 'скованная вещь не обычная';
                const noPrice = unpricedForm(reg, it.affixCap);
                if (noPrice) return `ковка: ${noPrice}`;
                const nonceRec = normalizeCraftNonces(w.stash.craftNonces).find((e) => e.n === nonce);
                if (nonceRec?.uid !== it.uid) return 'ключ заявки не записан с uid вещи';
                return null;
              },
            },
          };
        },
      };
    }
    case 'enchant': {
      const uid = pickUid(w, r, h, (it) => isCrafted(it) && it.rarity === 'normal');
      const it = invItem(s, uid);
      const rarity = r.chance(0.92) ? r.pick(['magic', 'rare'] as const) : r.pick(['unique', 'normal', 'legendary']);
      const cost = it && (rarity === 'magic' || rarity === 'rare') ? enchantCost(reg, it, rarity) : 0;
      const can = it && (rarity === 'magic' || rarity === 'rare') ? canEnchantItem(reg, it, rarity) : { ok: false };
      const maxGold = it && (rarity === 'magic' || rarity === 'rare') ? payConsent(r, () => enchantCost(w.view, it, rarity)) : undefined;
      const before = it ? structuredClone(it) : undefined;
      return {
        desc: `зачаровать ${it ? `«${it.name}»` : uid} до ${rarity} за ${cost}, согласие ${maxGold}`,
        kind: 'town', cmd: { cmd: 'forgeEnchant', uid, rarity, ...(maxGold !== undefined ? { maxGold } : {}) },
        run: () => asRes(enchantAction(reg, s, uid, rarity, townRng, maxGold)),
        spec: () => ({
          gold: { h, delta: -cost, maxPay: maxGold },
          transforms: [uid],
          extra: () => {
            if (!can.ok) return 'зачарование прошло там, где canEnchantItem отказывал';
            const noPrice = unpricedForm(reg, before?.affixCap, rarity);
            if (noPrice) return `зачарование: ${noPrice}`;
            const after = invItem(s, uid);
            if (after?.rarity !== rarity) return `редкость после зачарования ${after?.rarity}`;
            return onlyChanged(before!, after, ['rarity', 'affixes', 'name']);
          },
        }),
      };
    }
    case 'sketch': {
      const j = normalizeJournal(w.stash.forgeJournal);
      const parts = reg.get('weapon-parts');
      const x = r.next();
      const sk = parts.filter((p) => p.enabled !== false && !j.variants.includes(p.id));
      const variantId: unknown = x < 0.6 && sk.length ? r.pick(sk).id : x < 0.85 ? r.pick(parts).id
        : x < 0.93 && j.variants.length ? r.pick(j.variants) : r.pick([123, '__proto__', undefined, '']);
      return {
        desc: `эскиз → ${String(variantId)} (эскизов ${j.sketches})`,
        kind: 'town', cmd: { cmd: 'forgeSketch', variantId },
        run: () => asRes(sketchAction(reg, w.stash, variantId)),
        spec: () => ({
          journal: (b, a) => {
            const e = sameJ(b, a, ['bases', 'tierHi', 'classSalvages', 'mythic', 'typesSeen', 'typesForged']);
            if (e) return e;
            if (b.sketches <= 0) return 'эскиз потрачен без эскизов';
            if (a.sketches !== b.sketches - 1) return `эскизов ${b.sketches} → ${a.sketches}`;
            const nv = setDiff(a.variants, b.variants);
            if (setDiff(b.variants, a.variants).length || nv.length !== 1 || nv[0] !== variantId) return `эскиз открыл ${nv.join(',')} вместо ${String(variantId)}`;
            const p = partById(reg, String(variantId));
            if (!p || p.enabled === false) return 'эскиз открыл выключенную деталь';
            // Ключевая деталь неоткрытого типа эскизом не открывается (§12): тип открывает только разбор.
            const ok = (p.classes as string[]).some((cls) => p.slot !== keySlotOf(reg, cls)
              || [1, 2].some((hh) => { const bid = baseOfKeyPart(reg, cls, hh, p); return !!bid && b.bases.includes(bid); }));
            return ok ? null : `эскиз открыл ключевую деталь неоткрытого типа ${p.id}`;
          },
        }),
      };
    }
    case 'forgeSalvage':
    case 'fieldSalvage': {
      const inField = op.k === 'fieldSalvage';
      const weaponFirst = r.chance(0.5);
      const uid = pickUid(w, r, h, (it) => (weaponFirst ? isFoundWeapon(it) : it.kind !== 'material'));
      const it = invItem(s, uid);
      const range = it ? salvageRange(reg, it, inField) : { ok: false, range: {} };
      const minYield = it ? mapConsent(r, () => { const v = salvageRange(w.view, it, inField); return v.ok ? Object.fromEntries(Object.entries(v.range).map(([k, m]) => [k, m.min])) : null; }, 1) : undefined;
      const avgYield = it ? mapConsent(r, () => salvageMean(w.view, it, inField), 1) : undefined;
      const rule = it ? salvageJournalRule(reg, it) : undefined;
      return {
        desc: `${inField ? 'разбор в поле' : 'разбор у кузнеца'} ${it ? `«${it.name}» (${it.origin ?? '—'}, ${it.rarity}${it.parts ? ', скована' : ''}${it.tierForged ? ', поднята' : ''})` : uid}`
          + ` вилка ${JSON.stringify(range.range)}, согласие ${JSON.stringify(minYield)} / ${JSON.stringify(avgYield)}`,
        kind: 'town',
        cmd: { cmd: inField ? 'salvage' : 'forgeSalvage', uid, ...(minYield !== undefined ? { minYield } : {}), ...(avgYield !== undefined ? { avgYield } : {}) },
        run: () => asRes(inField ? fieldSalvage(reg, s, uid, townRng, minYield, avgYield) : forgeSalvage(reg, s, w.stash, uid, townRng, minYield, avgYield)),
        spec: () => ({
          consumes: [uid],
          mats: { gain: range.range, minGain: minYield },
          ...(inField ? {} : { journal: rule }),
          extra: () => (range.ok ? null : 'разбор прошёл там, где вилка отказывала'),
        }),
      };
    }
    case 'upgrade': {
      const afford = r.chance(0.5);
      const uid = pickUid(w, r, h, (it) => it.kind !== 'material' && it.kind !== 'consumable' && !it.parts
        && (!afford || (canUpgradeItem(reg, it).ok && canAffordBoth(s.inventory, w.stash.materials ?? {}, upgradeCost(reg, it)))));
      const it = invItem(s, uid);
      const gold = it ? forgeGold(reg, it, 'upgrade') : 0;
      const mats = it ? upgradeCost(reg, it) : {};
      const next = it ? upgradedItem(reg, it) : undefined;
      const maxGold = it ? payConsent(r, () => forgeGold(w.view, it, 'upgrade')) : undefined;
      const maxMaterials = it ? mapConsent(r, () => upgradeCost(w.view, it), -1) : undefined;
      const t0 = it ? tierIndexOfItem(reg, it) : -1;
      return {
        desc: `поднять ${it ? `«${it.name}» t${t0}` : uid} за ${gold}з ${JSON.stringify(mats)}, согласие ${maxGold} ${JSON.stringify(maxMaterials)}`,
        kind: 'town', cmd: { cmd: 'forgeUpgrade', uid, ...(maxGold !== undefined ? { maxGold } : {}), ...(maxMaterials !== undefined ? { maxMaterials } : {}) },
        run: () => asRes(forgeUpgrade(reg, s, uid, w.stash.materials ?? {}, maxGold, maxMaterials)),
        spec: () => ({
          gold: { h, delta: -gold, maxPay: maxGold },
          mats: { spend: mats, maxSpend: maxMaterials },
          transforms: [uid],
          extra: () => {
            const after = invItem(s, uid);
            if (!next) return 'подъём прошёл там, где upgradedItem отказывал';
            if (!after) return 'поднятая вещь пропала из сумки';
            if (keyOf(after) !== keyOf(next)) return `поднятая вещь не та, что в предпросмотре: ${diffKeys(after, next, ['pos'])}`;
            if (!after.tierForged) return 'поднятая вещь без метки tierForged';
            return tierIndexOfItem(reg, after) > t0 ? null : `ступень не выросла: t${t0} → t${tierIndexOfItem(reg, after)}`;
          },
        }),
      };
    }
    case 'reroll': {
      const uid = pickUid(w, r, h, (it) => it.rarity === 'magic' || it.rarity === 'rare');
      const it = invItem(s, uid);
      const gold = it ? forgeGold(reg, it, 'reroll') : 0;
      const maxGold = it ? payConsent(r, () => forgeGold(w.view, it, 'reroll')) : undefined;
      const before = it ? structuredClone(it) : undefined;
      const limit = reg.get('balance').forgePrices.rerollLimit;
      return {
        desc: `перекатить ${it ? `«${it.name}» (перекаток ${it.rerolls ?? 0})` : uid} за ${gold}, согласие ${maxGold}`,
        kind: 'town', cmd: { cmd: 'forgeReroll', uid, ...(maxGold !== undefined ? { maxGold } : {}) },
        run: () => asRes(forgeReroll(reg, s, uid, townRng, maxGold)),
        spec: () => ({
          gold: { h, delta: -gold, maxPay: maxGold },
          transforms: [uid],
          extra: () => {
            const after = invItem(s, uid);
            if (!after || !before) return 'перекатанная вещь пропала';
            if ((after.rerolls ?? 0) !== (before.rerolls ?? 0) + 1) return 'счёт перекаток не +1';
            if ((after.rerolls ?? 0) > limit) return `перекаток ${after.rerolls} сверх предела ${limit}`;
            if (before.rarity === 'unique') return 'перекатан уник';
            if (before.broken) return 'перекатана сломанная вещь';
            const noPrice = unpricedForm(reg, before.affixCap, before.rarity);
            if (noPrice) return `перекатка: ${noPrice}`;
            return onlyChanged(before, after, ['affixes', 'rerolls']);
          },
        }),
      };
    }
    case 'repair': {
      const afford = r.chance(0.5);
      const uid = pickUid(w, r, h, (it) => !!it.broken && (!afford || canAffordBoth(s.inventory, w.stash.materials ?? {}, repairCost(reg, it))));
      const it = invItem(s, uid);
      const gold = it ? forgeGold(reg, it, 'repair') : 0;
      const mats = it ? repairCost(reg, it) : {};
      const maxGold = it ? payConsent(r, () => forgeGold(w.view, it, 'repair')) : undefined;
      const maxMaterials = it ? mapConsent(r, () => repairCost(w.view, it), -1) : undefined;
      const before = it ? structuredClone(it) : undefined;
      return {
        desc: `починить ${it ? `«${it.name}»${it.broken ? ' (сломана)' : ''}` : uid} за ${gold}з ${JSON.stringify(mats)}`,
        kind: 'town', cmd: { cmd: 'forgeRepair', uid, ...(maxGold !== undefined ? { maxGold } : {}), ...(maxMaterials !== undefined ? { maxMaterials } : {}) },
        run: () => asRes(forgeRepair(reg, s, uid, w.stash.materials ?? {}, maxGold, maxMaterials)),
        spec: () => ({
          gold: { h, delta: -gold, maxPay: maxGold },
          mats: { spend: mats, maxSpend: maxMaterials },
          transforms: [uid],
          extra: () => {
            const after = invItem(s, uid);
            if (!before?.broken) return 'починена целая вещь';
            if (!Object.keys(mats).length) return 'починка без сырья';
            if (before.rarity === 'unique') return 'починен уник';
            if (after?.broken) return 'вещь осталась сломанной';
            return onlyChanged(before, after, ['broken']);
          },
        }),
      };
    }
    case 'stashMove': {
      const fromBag = r.chance(0.5);
      const tabItems = w.stash.tabs.flat();
      const src = fromBag || !tabItems.length ? invItem(s, pickUid(w, r, h)) : r.pick(tabItems);
      const uid = src?.uid ?? pickUid(w, r, h);
      const tabs = w.stash.tabs.length;
      const x0 = r.next();
      const dst: StashDst = x0 < 0.05 ? r.pick([tabs, -1, 99, 1.5]) as number : x0 < 0.5 ? 'inv' : r.int(0, Math.max(0, tabs - 1));
      const target = dst === 'inv' ? s.inventory : w.stash.tabs[dst as number];
      const dims = dst === 'inv' ? dimsOf(reg) : stashDims(reg);
      const free = target && src ? findFree(target.filter((i) => i !== src), src.gridW, src.gridH, dims) : null;
      const at = free && r.chance(0.7) ? free : { x: r.int(-1, dims.cols), y: r.int(-1, dims.rows) };
      return {
        desc: `сундук: ${src ? `«${src.name}»` : uid} → ${dst} (${at.x},${at.y})`,
        kind: 'town', cmd: { cmd: 'stashMove', uid, dst, x: at.x, y: at.y },
        run: () => asRes(stashMove(reg, s, w.stash, uid, dst, at.x, at.y)),
        spec: () => ({}),
      };
    }
    case 'deposit':
      return {
        desc: 'сдать сырьё в сундук', kind: 'town', cmd: { cmd: 'depositMaterials' },
        run: () => asRes(depositMaterials(s, w.stash.materials ?? (w.stash.materials = {}))),
        spec: () => ({}),
      };
    case 'equip': {
      const strict = r.chance(0.7);
      const uid = pickUid(w, r, h, (it) => !!it.slot && (!strict || (!it.broken && meetsRequirements(it, s.attributes))));
      const it = invItem(s, uid);
      const x = r.next();
      const slot = x < 0.7 ? undefined : x < 0.96 ? 'offhand' : r.pick(['ring2', 'weapon', 'belt']);
      return {
        desc: `надеть ${it ? `«${it.name}» (${it.slot}${it.hands === 2 ? ', 2H' : ''}${it.versatile ? ', полуторное' : ''})` : uid}${slot ? ` в ${slot}` : ''}`,
        kind: 'town', cmd: { cmd: 'equip', uid, ...(slot ? { slot } : {}) },
        run: () => asRes(equip(reg, s, uid, slot as 'offhand' | undefined)),
        spec: () => ({}),
      };
    }
    case 'unequip': {
      const on = Object.keys(s.equipment).filter((k) => s.equipment[k as EquipSlot]);
      const slot = on.length && r.chance(0.85) ? r.pick(on) : r.pick(['weapon', 'offhand', 'helm', 'belt', 'ring', 'x', '__proto__']);
      return {
        desc: `снять ${slot}`, kind: 'town', cmd: { cmd: 'unequip', slot },
        run: () => asRes(unequip(reg, s, slot)),
        spec: () => ({}),
      };
    }
    case 'useConsumable': {
      const pots = [...s.inventory.filter((i) => i.kind === 'consumable'), ...(s.belt.filter(Boolean) as Item[])];
      const uid = pots.length && r.chance(0.9) ? r.pick(pots).uid : pickUid(w, r, h);
      const hp = r.int(0, 100);
      return {
        desc: `выпить ${uid.slice(-6)} при ${hp}/100`, kind: 'town', cmd: { cmd: 'useConsumable', uid },
        // Как `Room.useConsumable`: эффект на сущность, расход только при эффекте.
        run: () => {
          const inBelt = s.belt.findIndex((i) => i?.uid === uid);
          const item = inBelt >= 0 ? s.belt[inBelt] : s.inventory.find((i) => i.uid === uid);
          if (!item?.use) return { ok: false, reason: 'не расходник' };
          // ⚠ C-11 (бафф-зелья): бафф базы (`use.buffMods` на `buffDurationSec`) — тоже эффект; в модели бафф не висит — действует всегда.
          const base = reg.get('items.base').find((b) => b.id === item.baseId);
          const buff = base?.kind === 'consumable' && !!base.use.buffMods?.length && (base.use.buffDurationSec ?? 0) > 0;
          if (!applyConsumable({ hp, mana: 0, debuffs: {} }, item.use, 100, 100) && !buff) return { ok: false, reason: 'Нет эффекта' };
          if (inBelt >= 0) s.belt[inBelt] = null;
          else s.inventory.splice(s.inventory.findIndex((i) => i.uid === uid), 1);
          return { ok: true };
        },
        spec: () => ({ consumes: [uid] }),
      };
    }
    case 'moveBelt': {
      const uid = pickUid(w, r, h, (it) => it.kind === 'consumable');
      return { desc: `в пояс ${uid.slice(-6)}`, kind: 'town', cmd: { cmd: 'moveBelt', uid }, run: () => asRes(moveToBelt(s, uid)), spec: () => ({}) };
    }
    case 'moveItem': {
      const uid = pickUid(w, r, h);
      const d = dimsOf(reg);
      const x = r.int(-1, d.cols), y = r.int(-1, d.rows);
      return { desc: `переложить ${uid.slice(-6)} в (${x},${y})`, kind: 'town', cmd: { cmd: 'moveItem', uid, x, y }, run: () => asRes(moveInventoryItem(reg, s, uid, x, y)), spec: () => ({}) };
    }
    case 'allocAttr': {
      const attr = r.chance(0.93) ? r.pick(ATTRIBUTES) : r.pick(['luck', '__proto__', 'constructor']);
      const n = r.chance(0.85) ? r.int(1, Math.max(1, s.unspentAttributePoints + 1)) : r.pick([0, -1, 1.5, Number.NaN, 1e9]);
      const before = { ...s.attributes }, pts = s.unspentAttributePoints;
      return {
        desc: `вложить ${n} в ${attr} (есть ${pts})`, kind: 'town', cmd: { cmd: 'allocAttr', attr, n },
        run: () => asRes(allocAttr(s, attr, n)),
        spec: () => ({
          extra: () => {
            if (s.unspentAttributePoints !== pts - n) return `очков ${pts} → ${s.unspentAttributePoints} при вложении ${n}`;
            for (const a of ATTRIBUTES) if (s.attributes[a] !== before[a] + (a === attr ? n : 0)) return `атрибут ${a}: ${before[a]} → ${s.attributes[a]}`;
            return null;
          },
        }),
      };
    }
    case 'respec': {
      const cost = reg.get('balance').respecCost;
      const refund = attrRespecRefund(reg, s);
      const pts = s.unspentAttributePoints;
      const maxGold = payConsent(r, () => w.view.get('balance').respecCost);
      // ⚠ R19-01: итог героя (Σ атрибутов + свободные) сброс только переносит; сейву без старта он запишет старт — по атрибуту не выше
      // нынешнего и не выше строки класса сейчас (модель считает сама, `stateInvariants` сверяет).
      const total = ATTRIBUTES.reduce((n, a) => n + s.attributes[a], 0) + pts;
      // ⭐ D2: сейву старше правила сброс допишет и книгу заработанного — из того, что есть до сброса (`planSettle`).
      planSettle(w, h, s);
      return {
        desc: `сброс атрибутов за ${cost} (вернёт ${refund}${s.startAttributes ? '' : ', сейв без старта'}), согласие ${maxGold}`, kind: 'town', cmd: { cmd: 'respec', ...(maxGold !== undefined ? { maxGold } : {}) },
        run: () => asRes(respec(reg, s, maxGold)),
        spec: () => ({
          gold: { h, delta: -cost, maxPay: maxGold },
          attrTotal: { h, total },
          extra: () => (s.unspentAttributePoints === pts + refund ? null : `очков после сброса ${s.unspentAttributePoints}, ждали ${pts + refund}`),
        }),
      };
    }
    case 'allocPassive': {
      const tree = reg.get('mastery-tree');
      const owned = Object.keys(s.masteries);
      const near = tree.edges.filter(([a, b]) => owned.includes(a) || owned.includes(b)).flat();
      const cands = [...tree.entryNodes, ...near];
      const nodeId = cands.length && r.chance(0.9) ? r.pick(cands) : r.pick(tree.nodes).id;
      const node = tree.nodes.find((n) => n.id === nodeId);
      const rank = s.masteries[nodeId] ?? 0;
      const cost = node ? Math.round(node.cost.amount * Math.pow(reg.get('balance').passiveRankCostMult, rank)) : 0;
      const maxGold = node ? payConsent(r, () => Math.round(node.cost.amount * Math.pow(w.view.get('balance').passiveRankCostMult, rank))) : undefined;
      return {
        desc: `мастерство ${nodeId} ранг ${rank + 1} за ${cost}`, kind: 'town', cmd: { cmd: 'allocPassive', nodeId, ...(maxGold !== undefined ? { maxGold } : {}) },
        run: () => asRes(allocPassive(reg, s, nodeId, maxGold)),
        spec: () => ({ gold: { h, delta: -cost, maxPay: maxGold } }),
      };
    }
    case 'respecPassives': {
      const fee = passiveRespecFee(reg, s);
      const maxGold = payConsent(r, () => passiveRespecFee(w.view, s));
      return {
        desc: `сброс мастерства за ${fee}`, kind: 'town', cmd: { cmd: 'respecPassives', ...(maxGold !== undefined ? { maxGold } : {}) },
        run: () => asRes(respecPassives(reg, s, maxGold)), spec: () => ({ gold: { h, delta: -fee, maxPay: maxGold } }),
      };
    }
    case 'allocSkill': {
      const tree = reg.get('skill-tree');
      const owned = Object.keys(s.skills);
      const mineBranch = (id: string): boolean => {
        const n = tree.nodes.find((x) => x.id === id);
        const b = tree.branches.find((x) => x.id === n?.branchId);
        return !b?.classId || b.classId === s.classId;
      };
      const near = tree.edges.filter(([a, b]) => owned.includes(a) || owned.includes(b)).flat();
      const cands = [...tree.entryNodes, ...near].filter(mineBranch);
      const nodeId = cands.length && r.chance(0.9) ? r.pick(cands) : r.pick(tree.nodes).id;
      return { desc: `скил ${nodeId}`, kind: 'town', cmd: { cmd: 'allocSkill', nodeId }, run: () => asRes(allocActive(reg, s, nodeId)), spec: () => ({}) };
    }
    case 'respecSkills': {
      const fee = skillRespecFee(reg, s);
      const maxGold = payConsent(r, () => skillRespecFee(w.view, s));
      return {
        desc: `сброс скилов за ${fee}`, kind: 'town', cmd: { cmd: 'respecSkills', ...(maxGold !== undefined ? { maxGold } : {}) },
        run: () => asRes(respecSkills(reg, s, maxGold)), spec: () => ({ gold: { h, delta: -fee, maxPay: maxGold } }),
      };
    }
    case 'acceptQuest': {
      const def = w.board.length && r.chance(0.9) ? r.pick(w.board) : undefined;
      const replace = r.chance(0.3);
      const stale = w.now - w.boardAt >= windowMs(reg);
      return {
        desc: `взять задание ${def?.id ?? '—'}${replace ? ' (с заменой)' : ''}`, kind: 'town',
        cmd: { cmd: 'acceptQuest', questId: def?.id ?? 'rnd_x_0', ...(replace ? { replace } : {}) },
        run: () => {
          if (stale) { restock(w, r); return { ok: false, reason: 'доска обновилась' }; }
          if (!def) return { ok: false, reason: 'Нет на доске' };
          const res = acceptQuest(s, def, { now: w.now, windowMs: windowMs(reg), boardAt: w.boardAt }, replace);
          if (res.ok) w.board = w.board.filter((q) => q !== def);
          return asRes(res);
        },
        spec: () => ({}),
      };
    }
    case 'ensureMain':
      return {
        desc: 'выдать цепочку', kind: 'inject',
        run: () => (ensureMainQuest(reg, s) ? { ok: true } : { ok: false, reason: 'цепочка начата' }),
        spec: () => ({ injected: 0 }),
      };
    case 'questProgress': {
      const act = s.quests.filter((q) => q.status === 'active');
      const q = act.length ? r.pick(act) : undefined;
      const def = q ? s.activeQuestDefs.find((d) => d.id === q.questId) : undefined;
      return {
        desc: `прогресс задания ${q?.questId ?? '—'}`, kind: 'inject',
        run: () => {
          if (!def) return { ok: false, reason: 'нет активного' };
          let changed = false;
          for (const o of def.objectives) {
            const times = r.chance(0.7) ? o.amount : r.int(1, Math.max(1, o.amount));
            if (o.type === 'reach-floor') changed = trackFloor(s, r.chance(0.8) ? o.amount : r.int(1, o.amount)).changed || changed;
            else if (o.type === 'kill' || o.type === 'collect-item') for (let i = 0; i < times; i++) changed = trackObjective(s, o.type, o.target ?? '').changed || changed;
          }
          return changed ? { ok: true } : { ok: false, reason: 'не сдвинулось' };
        },
        spec: () => ({ injected: 0 }),
      };
    }
    case 'turnIn': {
      const done = s.quests.filter((q) => q.status === 'completed');
      const q = done.length && r.chance(0.85) ? r.pick(done) : s.quests.length ? r.pick(s.quests) : undefined;
      const questId = q?.questId ?? 'нет-задания';
      const def = s.activeQuestDefs.find((d) => d.id === questId);
      const reward = def?.reward ?? {};
      const sp = s.unspentSkillPoints;
      const status0 = q?.status;
      let got: Item | undefined;
      return {
        desc: `сдать ${questId} (${q?.status ?? '—'}), награда ${JSON.stringify(reward)}`, kind: 'inject', cmd: { cmd: 'turnInQuest', questId },
        run: () => asRes(turnInQuest(reg, s, questId)),
        spec: () => ({
          gold: { h, delta: reward.gold ?? 0 },
          creates: {
            n: -1,   // 0 или 1: вещь награды, если база в игре
            check: (it) => {
              got = it;
              if (it.origin !== 'quest') return `награда с происхождением ${it.origin}`;
              return it.baseId === reward.itemBaseId ? null : `награда ${it.baseId}, обещано ${reward.itemBaseId}`;
            },
          },
          get injected() { return (reward.gold ?? 0) + (got ? liquidation(w, got) : 0); },
          extra: () => {
            if (status0 !== 'completed') return `сдано задание в статусе ${status0}`;
            if (s.quests.find((x) => x.questId === questId)?.status === 'completed') return 'задание осталось «выполнено» после сдачи';
            return s.unspentSkillPoints >= sp + (reward.skillPoints ?? 0) ? null : 'очки скилов награды не выданы';
          },
        }),
      };
    }
    case 'death': {
      const g = s.gold;
      const pen = reg.get('balance').deathPenalty;
      return {
        desc: `смерть героя ${h} (золото ${g})`, kind: 'town',
        run: () => { applyDeathPenalty(s, pen, townRng); return { ok: true }; },
        spec: () => ({ gold: { h, delta: -Math.floor(g * pen.goldPercent) }, mats: { loss: true }, bagLoss: h }),
      };
    }
    case 'loot': {
      // ⭐ C-01: после посадки на потолок — часто та самая база на той самой ступени (иначе правка почти не встречалась бы с дропом).
      const it = w.landed && r.chance(0.5) ? landedItem(reg, r, w.landed) : foundItem(reg, r, { near: s.level });
      let placed = false;
      return {
        desc: `находка «${it.name}» (${it.origin}, ${it.rarity}, t${tierIndexOfItem(reg, it)}${it.broken ? ', сломана' : ''})`, kind: 'inject',
        run: () => { placed = addToInventory(s.inventory, it, dimsOf(reg)); return placed ? { ok: true, uid: it.uid } : { ok: false, reason: 'сумка полна' }; },
        spec: () => ({ creates: { n: 1 }, injected: liquidation(w, it) }),
      };
    }
    case 'lootMats': {
      const mats = reg.get('craft-materials').filter((m) => m.enabled !== false);
      const gains: MaterialCost = {};
      // Иногда — ровно под заявку ковки из журнала или под подъём/починку вещи из сумки (добыча, которой хватит на шаг).
      const x = r.next();
      const good = x < 0.55 ? feasibleInput(reg, normalizeJournal(w.stash.forgeJournal), r) : null;
      const pv = good ? craftWeapon(reg, good, { materialsOn: true }) : null;
      const bag = s.inventory.filter((i) => i.kind !== 'material' && i.kind !== 'consumable');
      const ladder = x >= 0.55 && x < 0.8 && bag.length ? (() => { const it = r.pick(bag); return r.chance(0.5) ? upgradeCost(reg, it) : repairCost(reg, it); })() : {};
      if (pv?.cost) { w.pending = good!; w.pendingHero = h; for (const [id, n] of Object.entries(pv.cost.materials)) gains[id] = n + r.int(0, 20); }
      else if (Object.keys(ladder).length) for (const [id, n] of Object.entries(ladder)) gains[id] = n + r.int(0, 10);
      else for (let n = r.int(1, 4); n > 0 && mats.length; n--) { const m = r.pick(mats); gains[m.id] = (gains[m.id] ?? 0) + r.int(1, 80); }
      const price = new Map(reg.get('craft-materials').map((m) => [m.id, m.sellPrice] as const));
      let injected = 0;
      // Добыча прошлых забегов, уже сданная в сундук (как кнопкой «сдать сырьё»), — в кошелёк аккаунта.
      const toWallet = !!pv?.cost && r.chance(0.5);
      return {
        desc: `сырьё с тел ${JSON.stringify(gains)}${toWallet ? ' (сразу в сундук)' : ''}`, kind: 'inject',
        run: () => {
          if (toWallet) {
            const wal = w.stash.materials ?? (w.stash.materials = {});
            for (const [id, n] of Object.entries(gains)) { wal[id] = (wal[id] ?? 0) + n; injected += n * (price.get(id) ?? 0); }
            return { ok: true };
          }
          const left = giveMaterialsTo(s.inventory, gains, reg.get('craft-materials'), dimsOf(reg), reg.get('balance').inventory.materialStack, () => `m-${++w.n}`);
          // Не влезло — осталось на земле (пропало для аккаунта).
          let placed = 0;
          for (const [id, n] of Object.entries(gains)) { const got = n - (left[id] ?? 0); placed += got; injected += got * (price.get(id) ?? 0); }
          return placed > 0 ? { ok: true } : { ok: false, reason: 'сумка полна' };
        },
        spec: () => ({ mats: { free: true }, get injected() { return injected; } }),
      };
    }
    case 'gold': {
      const n = r.chance(0.7) ? r.int(1, 800) : r.int(800, 4000);
      return { desc: `золото с тел +${n}`, kind: 'inject', run: () => { s.gold += n; return { ok: true }; }, spec: () => ({ gold: { h, delta: n }, injected: n }) };
    }
    case 'xp': {
      const n = r.int(10, 50_000);
      return { desc: `опыт +${n}`, kind: 'inject', run: () => { gainXp(s, reg.get('balance'), n); return { ok: true }; }, spec: () => ({ injected: 0 }) };
    }
    case 'config': return configPlan(w, r);
    case 'classEdit': {
      // ⚠ R19-01: сброс сейва без старта ломала правка ДО его первого сброса — в общем `config` она редка, а первый сброс рано.
      let desc = '';
      return {
        get desc() { return `конфиг: ${desc}`; }, kind: 'meta',
        run: () => { desc = editClassPoints(w, r); w.cfgVer++; w.liqCache.clear(); return { ok: true }; },
        spec: () => ({}),
      };
    }
    case 'progEdit': {
      // ⭐ D2: правка прокачки хозяином — старт класса, очки за уровень всех трёх пулов, кривая опыта, древа скилов и мастерства (с опечатками).
      // Служебный шаг: сейвы и сундук — байт в байт (I1 `meta-mutates`): правка сама ничего не чеканит и не отнимает.
      let desc = '';
      const sync = r.chance(0.3);
      return {
        get desc() { return `конфиг: ${desc}${sync ? ' (клиент перечитал)' : ''}`; }, kind: 'meta',
        run: () => {
          desc = editProgression(w, r);
          w.cfgVer++; w.liqCache.clear();
          if (sync) w.view = regFrom(tablesOf(reg));
          return { ok: true };
        },
        spec: () => ({}),
      };
    }
    case 'priceEdit': {
      // ⚠ R23-04: хозяин опускает множитель цены редкости («обычное ничего не стоит») — служебный шаг, сейвы байт в байт; клиент — иногда.
      let desc = '';
      const sync = r.chance(0.5);
      return {
        get desc() { return `конфиг: ${desc}${sync ? ' (клиент перечитал)' : ''}`; }, kind: 'meta',
        run: () => {
          desc = editRarityPrice(reg, r);
          w.cfgVer++; w.liqCache.clear();
          if (sync) w.view = regFrom(tablesOf(reg));
          return { ok: true };
        },
        spec: () => ({}),
      };
    }
    case 'reenter': {
      // ⭐ D2: герой вошёл заново — сервер дописывает сейву старше правила старт и книгу заработанного (`RoomManager.sanitize` →
      // `settleEarned`) из того, что у героя есть, по конфигу этого мига; что сейв помнит — не трогает, уровень и очки — тоже.
      planSettle(w, h, s);
      const had = { start: !!s.startAttributes, earned: !!s.earned };
      const snap = (): string => JSON.stringify([
        s.level, s.xp, s.attributes, s.unspentAttributePoints, s.unspentSkillPoints, s.unspentMasteryPoints, s.skills, s.masteries,
        had.start ? s.startAttributes : null, had.earned ? s.earned : null,
      ]);
      const was = snap();
      return {
        desc: `вход героя ${h}${had.start ? '' : ', сейв без старта'}${had.earned ? '' : ', сейв без книги'}`, kind: 'town',
        run: () => { settleEarned(reg, s); return { ok: true }; },
        spec: () => ({
          extra: () => {
            if (snap() !== was) return `вход тронул уровень, очки или записанное: ${was.slice(0, 200)} → ${snap().slice(0, 200)}`;
            if (!s.startAttributes || !s.earned) return `вход не дописал сейв (старт ${!!s.startAttributes}, книга ${!!s.earned})`;
            return null;
          },
        }),
      };
    }
    case 'newHero': {
      // Герой удалён, на его месте — новый со стартовым комплектом (R3-04: комплект бесплатен и бесконечен — продаётся за 1,
      // не разбирается; переложенное в сундук до удаления остаётся аккаунту).
      const classes = reg.get('classes').filter((c) => c.enabled !== false);
      const cls = r.pick(classes).id;
      // ⚠ R19-01: иногда — герой, созданный до R18-07 (сейв старта не помнит): сброс таких мерил от живых очков за уровень и строки класса.
      const legacy = r.chance(0.4);
      // ⭐ D2: и между R18-07 и D2 — старт помнит, книги заработанного нет (её допишет вход или сброс).
      const preD2 = !legacy && r.chance(0.3);
      let born: Item[] = [];
      return {
        desc: `удалить героя ${h} и создать нового (${cls}${legacy ? ', сейв старше R18-07 — без старта' : preD2 ? ', сейв старше D2 — без книги' : ''})`, kind: 'inject',
        run: () => {
          const fresh = newCharacterSave(reg, cls, `Н${++w.n}`, s.charId);
          if (legacy) delete fresh.startAttributes;
          if (legacy || preD2) delete fresh.earned;
          fresh.createdAt = 0;
          w.heroes[h] = fresh;
          w.books[h] = bookOf(reg, fresh);
          born = [...fresh.inventory, ...(Object.values(fresh.equipment).filter(Boolean) as Item[])];
          return { ok: true };
        },
        spec: () => ({
          gold: { h, free: true }, mats: { loss: true }, heroGone: h,
          creates: { n: -2, check: (it) => (it.origin !== 'start' ? `у нового героя вещь с происхождением ${it.origin}` : null) },
          get injected() { return born.reduce((n, it) => n + liquidation(w, it), 0); },
        }),
      };
    }
    case 'restock':
      return { desc: 'новый сток и доска', kind: 'meta', run: () => { restock(w, r); return { ok: true }; }, spec: () => ({}) };
    case 'clientSync':
      return { desc: 'клиент перечитал конфиг', kind: 'meta', run: () => { w.view = regFrom(tablesOf(w.reg)); return { ok: true }; }, spec: () => ({}) };
  }
}

/**
 * ⭐ C-01: ПОСАДКА РОВНО НА ПОТОЛОК ТРЕБОВАНИЙ — правка хозяина, на которой округление по атрибуту перелетало потолок (Σ ровно на
 * нём, доли по .5). Базе с требованиями они поднимаются до нечётных, ступени из её окна множитель требований — до ближайшей
 * половинки не ниже прежнего и не ниже посадки (нечётное × x.5 — доля с .5), потолок — до суммы, если она выше. Всё только растёт:
 * игроку хуже, как и прочие правки (выше потолок — выше требования НОВЫХ вещей; прежние под ним и остаются).
 */
function landOnCap(reg: ConfigRegistry, r: Rng): { desc: string; at?: { baseId: string; tierLevel: number } } {
  const pool = reg.get('items.base').filter((b) => b.enabled !== false && b.kind !== 'consumable' && Object.values(b.requirements).some((v) => (v ?? 0) > 0));
  if (!pool.length) return { desc: 'посадка на потолок: нет базы с требованиями' };
  const b = r.pick(pool);
  const req: Record<string, number> = {};
  for (const [k, v] of Object.entries(b.requirements)) if (v) req[k] = (v % 2 ? v : v + 1) + 2 * r.int(0, 3);
  const sum = Object.values(req).reduce((n, v) => n + v, 0);
  const tiers = reg.get('item-tiers');
  const br = baseTierRange(reg, b);
  const ti = r.int(br.lo, Math.min(br.hi, tiers.length - 1));
  const t = tiers[ti]!;
  const cap0 = reg.get('balance').maxTotalRequirement;
  const m = Math.ceil(Math.max(t.reqMult, cap0 / sum) - 0.5) + 0.5;
  const cap = Math.max(cap0, sum * m);
  reloadTable(reg, 'items.base', (bs) => { const row = bs.find((x) => x.id === b.id); if (row) row.requirements = { ...row.requirements, ...req }; });
  reloadTable(reg, 'item-tiers', (ts) => { ts[ti]!.reqMult = m; });
  if (cap !== cap0) reloadTable(reg, 'balance', (bal) => { bal.maxTotalRequirement = cap; });
  return { desc: `посадка на потолок: ${b.id} ${JSON.stringify(req)} × ${t.id} ${t.reqMult} → ${m} = ${sum * m}, потолок ${cap0} → ${cap}`, at: { baseId: b.id, tierLevel: t.minItemLevel } };
}

/**
 * ⚠ C-02: ПРАВКА ЗАДАНИЙ — как хозяин в редакторе, в том числе с опечаткой: вилка шаблона доски (число целей, золото, опыт) или
 * награда квеста цепочки (золото, опыт, очки скилов) — годное целое, ноль, минус, дробь, перевёрнутая вилка. Негодное обязана
 * отвергнуть схема (`reload` бросает — конфиг прежний, как и в игре: редактор получает отказ). Пропущенное схемой дошло бы до доски,
 * приёма и сдачи — его ловят числа заданий (`questNumbers`) и числа героя (I2: золото в минус, дробные очки).
 * ⚠ C-13 (цели заданий): и ТИП ЦЕЛИ — любой, что предлагает схема (редактор строит выпадашку по ней), «talk-npc» (её редактор
 * предлагал, а игра не считала) и мусор. Пропущенный схемой тип без трекера ловит `questNumbers` (`quest-untracked`).
 */
function editQuests(reg: ConfigRegistry, r: Rng): string {
  /** Число правки: чаще годное целое из [lo, hi], иногда ноль, минус или дробь. */
  const val = (lo: number, hi: number): number => {
    const x = r.int(0, 9);
    return x < 6 ? r.int(lo, hi) : x === 6 ? 0 : x === 7 ? -r.int(1, 500) : x === 8 ? r.int(lo, hi) + 0.5 : lo;
  };
  let what = '';
  try {
    if (r.chance(0.2)) {
      const type = r.pick([...questsRandomSchema.element.shape.objectiveType.options, 'talk-npc', 'open-chest']);
      if (r.chance(0.5)) {
        reloadTable(reg, 'quests.random', (t) => {
          const tpl = r.pick(t);
          tpl.objectiveType = type as typeof tpl.objectiveType;
          what = `${tpl.id}.objectiveType → ${type}`;
        });
      } else {
        reloadTable(reg, 'quests.main', (t) => {
          const q = r.pick(t);
          const o = r.pick(q.objectives);
          if (o) o.type = type as typeof o.type;
          what = `${q.id}.${o?.id ?? '—'}.type → ${type}`;
        });
      }
    } else if (r.chance(0.6)) {
      reloadTable(reg, 'quests.random', (t) => {
        const tpl = r.pick(t);
        const key = r.pick(['amountRange', 'rewardGoldRange', 'rewardXpRange'] as const);
        const [lo, hi] = key === 'amountRange' ? [1, 12] : [0, 300];
        let a = val(lo, hi), b = val(lo, hi);
        // Обычно по порядку, изредка — перевёрнутая вилка.
        if ((a > b) === r.chance(0.85)) [a, b] = [b, a];
        tpl[key] = [a, b];
        what = `${tpl.id}.${key} → [${a}, ${b}]`;
      });
    } else {
      reloadTable(reg, 'quests.main', (t) => {
        const q = r.pick(t);
        const key = r.pick(['gold', 'xp', 'skillPoints'] as const);
        const v = key === 'skillPoints' ? val(0, 3) : val(0, 400);
        q.reward = { ...q.reward, [key]: v };
        what = `${q.id}.reward.${key} → ${v}`;
      });
    }
    return `задания: ${what}`;
  } catch (e) {
    if (!/не прошёл валидацию/.test(String((e as Error)?.message))) throw e;
    return `задания: ${what} — отказ схемы`;
  }
}

/**
 * ⚠ R17-03: ПРАВКА ЦЕН ФОРМ ЁМКОСТИ — как хозяин в редакторе: ✕ у строки `balance.craft.formMult` или опечатка в ключе («3 +2»,
 * «3+2 », «3-2»). Такую таблицу обязана отвергнуть схема (`reload` бросает — конфиг прежний): форма без строки шла по ×1, вшестеро
 * дешевле. Пропущенную схемой ловит `formPrices` (цена у каждой формы, которую даёт ёмкость, и богаче не дешевле). И законная правка:
 * ёмкость опущена до 4, строки Σ5 убраны — вещи 3+2 в сумках остаются без цены формы, и зачарование с перекаткой обязаны им
 * отказывать (спеки шагов, `unpricedForm`).
 */
function editForms(reg: ConfigRegistry, r: Rng): string {
  let what = '';
  try {
    if (r.chance(0.3)) {
      reloadTable(reg, 'balance', (b) => {
        const k = b.craft;
        k.capacityByTier = k.capacityByTier.map((n) => Math.min(n, 4));
        for (const key of Object.keys(k.formMult)) if (key.split('+').reduce((n, x) => n + Number(x), 0) > 4) delete k.formMult[key];
        what = 'ёмкость до 4, строки Σ5 убраны';
      });
    } else {
      reloadTable(reg, 'balance', (b) => {
        const fm = b.craft.formMult;
        const key = r.pick(Object.keys(fm));
        const v = fm[key]!;
        delete fm[key];
        const typo = r.pick([null, `${key} `, key.replace('+', ' +'), key.replace('+', '-'), `${key}+0`]);
        if (typo) fm[typo] = v;
        what = typo ? `строка formMult «${key}» → «${typo}»` : `строка formMult «${key}» ✕`;
      });
    }
    return `цены форм: ${what}`;
  } catch (e) {
    if (!/не прошёл валидацию/.test(String((e as Error)?.message))) throw e;
    return `цены форм: ${what} — отказ схемы`;
  }
}

/**
 * ⚠ R18-07: ПРАВКА СТАРТА КЛАССА И ОЧКОВ ЗА УРОВЕНЬ — как хозяин в редакторе: старт класса героя (чаще) или любого, вверх и вниз, изредка
 * дробь и минус (их обязана отвергнуть схема: половину очка после сброса не вложить); очки за уровень — атрибутов, ⭐ D2 скилов и мастерства —
 * туда и обратно, с теми же опечатками. Старым героям ни то ни другое выданного не пересчитывает: сброс меряет вложенное от старта, с которым
 * герой создан (`save.startAttributes`), книга модели (`PointsBook`) — тоже. Мерил бы от нынешней строки — сброс после правки дарил бы очки
 * (I4 `attr-points`) или делал очки базы свободными (I4 `attr-floor`).
 */
function editClassPoints(w: FuzzWorld, r: Rng): string {
  const reg = w.reg;
  /** Число правки: чаще годный сдвиг (не ниже нуля), иногда дробь или минус. */
  const val = (was: number, steps: number[]): number => {
    const x = r.int(0, 9);
    return x < 8 ? Math.max(0, was + r.pick(steps)) : x === 8 ? was + 0.5 : -r.int(1, 5);
  };
  let what = '';
  try {
    if (r.chance(0.65)) {
      const mine = w.heroes.map((s) => s.classId);
      reloadTable(reg, 'classes', (t) => {
        const row = (r.chance(0.8) ? t.find((c) => c.id === r.pick(mine)) : undefined) ?? r.pick(t);
        const st = row.startAttributes as Record<string, number>;
        const edits: string[] = [];
        for (let n = r.int(1, 2); n > 0; n--) {
          const a = r.pick(ATTRIBUTES);
          st[a] = val(st[a]!, [-8, -5, -3, -1, 1, 3, 5, 8]);
          edits.push(`${a} → ${st[a]}`);
        }
        what = `старт ${row.id}: ${edits.join(', ')}`;
      });
    } else {
      const k = r.pick(['attributePointsPerLevel', 'attributePointsPerLevel', 'skillPointsPerLevel', 'masteryPointsPerLevel'] as const);
      const name = k === 'attributePointsPerLevel' ? 'атрибутов' : k === 'skillPointsPerLevel' ? 'скилов' : 'мастерства';
      reloadTable(reg, 'balance', (b) => {
        b[k] = val(b[k], [-2, -1, 1, 2, 3]);
        what = `очков ${name} за уровень → ${b[k]}`;
      });
    }
    return `классы: ${what}`;
  } catch (e) {
    if (!/не прошёл валидацию/.test(String((e as Error)?.message))) throw e;
    return `классы: ${what} — отказ схемы`;
  }
}

/**
 * ⭐ D2: ПРАВКА ДРЕВ СКИЛОВ И МАСТЕРСТВА — как хозяин в редакторе, чаще по узлу, куда вложено: потолок ранга ниже вложенного, уровень узла
 * выше героя, узел убран целиком (со связями и входом), цена ранга мастерства; и опечатки, которые обязана отвергнуть схема (ранг 0, уровень 0,
 * узел древа скилов не за одно очко — R6-17). Вложенное остаётся рангами, как было: сброс обязан вернуть Σ рангов и за узлы, которых в древе
 * больше нет (очки скилов и мастерства по книге — `skill-points`, `mastery-points`).
 */
function editTrees(w: FuzzWorld, r: Rng): string {
  const reg = w.reg;
  let what = '';
  type Node = { id: string; maxRank: number; levelReq: number; cost: { type: string; amount: number } };
  type Tree = { nodes: Node[]; edges: [string, string][]; entryNodes: string[] };
  const edit = (label: string, t: Tree, owned: string[], skill: boolean): void => {
    const mine = t.nodes.filter((n) => owned.includes(n.id));
    const node = mine.length && r.chance(0.8) ? r.pick(mine) : r.pick(t.nodes);
    if (!node) { what = `${label}: пусто`; return; }
    switch (r.int(0, 5)) {
      case 0: node.maxRank = 1; what = `${label}: ${node.id} — ранг не выше 1`; break;
      case 1: node.levelReq = r.int(40, 99); what = `${label}: ${node.id} — с уровня ${node.levelReq}`; break;
      case 2: case 3:
        t.nodes = t.nodes.filter((n) => n !== node);
        t.edges = t.edges.filter(([a, b]) => a !== node.id && b !== node.id);
        t.entryNodes = t.entryNodes.filter((id) => id !== node.id);
        what = `${label}: ${node.id} убран`;
        break;
      case 4:
        if (skill) { node.maxRank += r.int(1, 3); what = `${label}: ${node.id} — ранг до ${node.maxRank}`; }
        else { node.cost.amount = Math.max(1, Math.round(node.cost.amount * r.pick([0.5, 2, 3]))); what = `${label}: ${node.id} — цена ранга ${node.cost.amount}`; }
        break;
      default: {
        const x = r.int(0, 2);
        if (x === 0) { node.maxRank = 0; what = `${label}: ${node.id} — ранг 0`; }
        else if (x === 1) { node.levelReq = 0; what = `${label}: ${node.id} — уровень 0`; }
        else if (skill) { node.cost.amount = 2; what = `${label}: ${node.id} — два очка за ранг`; }
        else { node.maxRank = -1; what = `${label}: ${node.id} — ранг −1`; }
      }
    }
  };
  try {
    if (r.chance(0.5)) reloadTable(reg, 'skill-tree', (t) => edit('древо скилов', t as unknown as Tree, w.heroes.flatMap((s) => Object.keys(s.skills)), true));
    else reloadTable(reg, 'mastery-tree', (t) => edit('древо мастерства', t as unknown as Tree, w.heroes.flatMap((s) => Object.keys(s.masteries)), false));
    return `древа: ${what}`;
  } catch (e) {
    if (!/не прошёл валидацию/.test(String((e as Error)?.message))) throw e;
    return `древа: ${what} — отказ схемы`;
  }
}

/** ⭐ D2: ПРАВКА ПРОКАЧКИ — старт класса и очки за уровень (`editClassPoints`), кривая опыта (`editXpCurve`) или древа (`editTrees`). */
function editProgression(w: FuzzWorld, r: Rng): string {
  const x = r.int(0, 9);
  return x < 4 ? editClassPoints(w, r) : x < 7 ? editXpCurve(w.reg, r) : editTrees(w, r);
}

/**
 * ⚠ R20-05: ПРАВКА КРИВОЙ ОПЫТА — как хозяин в редакторе: годная (медленнее, быстрее, потолок ниже) и опечатка, которую обязана
 * отвергнуть схема: ступенька (участок порогов ниже прежних — вставка мимо), пропущенная цифра, повтор, минус, NaN, ненулевой порог
 * первого уровня. Пропущенную ловит `xpCurve`: с такой кривой герой 10-го с одного очка опыта вставал 20-м с очками всех уровней, и
 * вернуть таблицу — уровни не отнимаются (R9-05).
 */
function editXpCurve(reg: ConfigRegistry, r: Rng): string {
  let what = '';
  try {
    reloadTable(reg, 'balance', (b) => {
      const t = b.xpTable;
      const top = t.length - 1;
      const i = r.int(3, Math.max(3, top));
      switch (r.int(0, 9)) {
        case 0: { const k = r.pick([1.1, 1.25]); b.xpTable = t.map((v) => Math.round(v * k)); what = `медленнее ×${k}`; break; }
        case 1: b.xpTable = t.map((v) => Math.round(v * 0.8)); what = 'быстрее ×0.8'; break;
        case 2: b.xpTable = t.slice(0, Math.max(3, r.int(Math.min(30, top), top))); what = `потолок → ${b.xpTable.length - 1}`; break;
        case 3: { const to = Math.min(top, i + r.int(3, 10)); for (let j = i; j <= to; j++) t[j] = 100; what = `ступенька xp[${i}..${to}] = 100`; break; }
        case 4: t[i] = Math.round(t[i]! / 10); what = `пропущенная цифра xp[${i}] → ${t[i]}`; break;
        case 5: t[i] = t[i - 1]!; what = `повтор xp[${i}] = xp[${i - 1}]`; break;
        case 6: t[i] = -t[i]!; what = `минус xp[${i}] → ${t[i]}`; break;
        case 7: t[i] = Number.NaN; what = `xp[${i}] → NaN`; break;
        case 8: t[1] = r.int(1, 90); what = `xp[1] → ${t[1]}`; break;
        default: t[2] = 0; what = 'xp[2] → 0';
      }
    });
    return `кривая опыта: ${what}`;
  } catch (e) {
    if (!/не прошёл валидацию/.test(String((e as Error)?.message))) throw e;
    return `кривая опыта: ${what} — отказ схемы`;
  }
}

/**
 * ⚠ R23-04: МНОЖИТЕЛЬ ЦЕНЫ РЕДКОСТИ ВНИЗ — как хозяин из редактора: схема пускает `rarities.priceMult` от 0 («обычное ничего не стоит»),
 * и оценка вещи (`round(… × priceMult)`) у зелья прилавка ниже ≈ 0.026 округлялась в 0, а скупка держит пол 1. Вниз: в разы, к порогу
 * округления, в ноль; иногда — назад к поставке.
 */
function editRarityPrice(reg: ConfigRegistry, r: Rng): string {
  let desc = '';
  reloadTable(reg, 'rarities', (t) => {
    const row = r.pick(t);
    const was = row.priceMult;
    const x = r.int(0, 5);
    row.priceMult = x === 0 ? 0 : x === 1 ? r.pick([0.005, 0.01, 0.02, 0.025]) : x === 2 ? Math.round(was * 10) / 100
      : x === 3 ? Math.round(was * 50) / 100 : x === 4 ? r.pick([0.026, 0.03, 0.05]) : pristineReg().get('rarities').find((q) => q.id === row.id)?.priceMult ?? 1;
    desc = `множитель цены «${row.id}» ${was} → ${row.priceMult}`;
  });
  return desc;
}

/**
 * ПРАВКА КОНФИГА ЖИВЬЁМ — как хозяин из редактора: галки (сырьё, деталь, база, ступень) в обе стороны, правки «игроку хуже»
 * (цена ковки и кузницы вверх, выход разбора и цена сырья вниз; требования базы, множитель ступени и потолок требований — вверх,
 * с посадкой ровно на потолок, C-01), правка заданий с опечатками (C-02), цен форм ёмкости (R17-03), старта классов и очков за
 * уровень (R18-07), кривой опыта (R20-05; и правкой прокачки — D2), древ (D2) и откат к умолчанию. Клиент перечитывает конфиг не всегда.
 */
function configPlan(w: FuzzWorld, r: Rng): Plan {
  const reg = w.reg;
  const x = r.int(0, 14);
  let desc = '';
  let edit: () => void;
  type Row = { id: string; enabled?: boolean };
  const flip = (key: 'craft-materials' | 'weapon-parts' | 'items.base' | 'item-tiers'): void => {
    reloadTable(reg, key, (t) => {
      const row = r.pick(t as readonly Row[]) as Row | undefined;
      if (row) { row.enabled = row.enabled === false; desc = `${key}: ${row.id} → ${row.enabled ? 'вкл' : 'выкл'}`; }
    });
  };
  switch (x) {
    case 0: case 1: edit = () => flip('craft-materials'); break;
    case 2: edit = () => flip('weapon-parts'); break;
    case 3: edit = () => flip('items.base'); break;
    case 4: edit = () => flip('item-tiers'); break;
    case 5: case 6: case 7:
      edit = () => {
        const which = r.int(0, 11);
        if (which === 11) {
          reloadTable(reg, 'craft-materials', (t) => { const m = r.pick(t); m.sellPrice = Math.max(1, Math.floor(m.sellPrice / 2)); desc = `цена сырья ${m.id} → ${m.sellPrice}`; });
          return;
        }
        reloadTable(reg, 'balance', (b) => {
          const k = b.craft, f = b.forgePrices;
          switch (which) {
            case 0: { const sl = r.pick(['strike', 'grip', 'bind', 'head'] as const); k.cost.units[sl] += r.int(1, 8); desc = `ковка: единиц ${sl} → ${k.cost.units[sl]}`; break; }
            case 1: k.cost.goldPerReqMult = Math.round(k.cost.goldPerReqMult * 1.5); desc = `ковка: золото → ${k.cost.goldPerReqMult}`; break;
            case 2: k.cost.enchantGold = Math.round(k.cost.enchantGold * 1.5); desc = `зачарование → ${k.cost.enchantGold}`; break;
            case 3: f.upgradeTier = Math.round(f.upgradeTier * 1.5); desc = `подъём → ${f.upgradeTier}`; break;
            case 4: f.rerollAffix = Math.round(f.rerollAffix * 1.5); f.repairBroken = Math.round(f.repairBroken * 1.5); desc = `перекатка/починка → ${f.rerollAffix}/${f.repairBroken}`; break;
            case 5: { const t = r.pick(['tier1', 'tier2', 'tier3'] as const); f.upgradeMaterials[t] += r.int(1, 5); f.repairMaterials[t] += r.int(1, 3); desc = `сырьё подъёма/починки ${t} → ${f.upgradeMaterials[t]}/${f.repairMaterials[t]}`; break; }
            case 6: b.respecCost = Math.round(b.respecCost * 1.5); desc = `сброс → ${b.respecCost}`; break;
            case 7: b.salvage.fieldYield = Math.round(b.salvage.fieldYield * 50) / 100; desc = `выход в поле → ${b.salvage.fieldYield}`; break;
            case 8: { const sl = r.pick(['strike', 'grip', 'bind', 'head'] as const); k.salvage.units[sl] = Math.max(0, k.salvage.units[sl] - 1); desc = `разбор: единиц ${sl} → ${k.salvage.units[sl]}`; break; }
            case 9: k.melt.share = Math.round(k.melt.share * 50) / 100; desc = `переплавка → ${k.melt.share}`; break;
            default: { const row = r.pick(k.finish as any[]); row.strikeUnits += r.int(1, 4); row.goldMult = Math.round(row.goldMult * 125) / 100; desc = `доводка ${row.id} → ${row.strikeUnits}/${row.goldMult}`; }
          }
        });
      };
      break;
    case 8:
      edit = () => { const l = landOnCap(reg, r); desc = l.desc; w.landed = l.at; };
      break;
    case 11:
      edit = () => { desc = editQuests(reg, r); };
      break;
    case 12:
      edit = () => { desc = editForms(reg, r); };
      break;
    case 13: case 14:
      // ⭐ D2: старт класса и очки за уровень (R18-07), кривая опыта (R20-05) и древа — одной правкой прокачки.
      edit = () => { desc = editProgression(w, r); };
      break;
    case 10:
      edit = () => { desc = editXpCurve(reg, r); };
      break;
    default:
      edit = () => { (reg as unknown as { data: Tables }).data = { ...pristineTables() }; desc = 'конфиг — по умолчанию'; w.landed = undefined; };
  }
  const sync = r.chance(0.5);
  return {
    get desc() { return `конфиг: ${desc}${sync ? ' (клиент перечитал)' : ''}`; },
    kind: 'meta',
    run: () => {
      edit();
      w.cfgVer++;
      w.liqCache.clear();
      if (sync) w.view = regFrom(tablesOf(reg));
      return { ok: true };
    },
    spec: () => ({}),
  };
}

// ── Инварианты ───────────────────────────────────────────────────────────────────────────────────

/** Нарушение: инвариант, код (ключ дедупа), текст; `id` — устойчивая личность для «было ли до шага» (иначе — текст). */
export interface Violation { inv: string; code: string; msg: string; id?: string }

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** I2: числа вещи. */
function itemNumbers(it: Item, where: string, out: Violation[]): void {
  const bad = (code: string, msg: string): void => { out.push({ inv: 'I2', code, msg: `${where} «${it.name}» [${it.uid.slice(-6)}]: ${msg}` }); };
  if (it.count !== undefined && !(isInt(it.count) && it.count >= 1)) bad('count', `count=${it.count}`);
  if (!(isInt(it.itemLevel) && it.itemLevel >= 1)) bad('ilvl', `itemLevel=${it.itemLevel}`);
  for (const [a, v] of Object.entries(it.requirements ?? {})) if (v !== undefined && !(isInt(v) && v >= 0)) bad('req', `требование ${a}=${v}`);
  for (const m of it.baseStats ?? []) if (!finite(m.value)) bad('stat', `стат ${m.stat}=${m.value}`);
  for (const a of it.affixes ?? []) if (a.modifier && !finite(a.modifier.value)) bad('affix', `аффикс ${a.affixId}=${a.modifier.value}`);
  if (!(isInt(it.gridW) && it.gridW >= 1 && isInt(it.gridH) && it.gridH >= 1)) bad('grid', `размер ${it.gridW}×${it.gridH}`);
  if (it.rerolls !== undefined && !(isInt(it.rerolls) && it.rerolls >= 0)) bad('rerolls', `rerolls=${it.rerolls}`);
  for (const [k, v] of Object.entries(it.baseRoll ?? {})) if (!(finite(v) && v >= 0 && v <= 1)) bad('roll', `baseRoll.${k}=${v}`);
  for (const l of it.craftPaid ?? []) if (!(isInt(l.n) && l.n >= 0)) bad('paid', `craftPaid ${l.id}=${l.n}`);
  for (const k of ['damageMult', 'spreadMult', 'reachMult', 'arcMult'] as const) { const v: unknown = it[k]; if (v !== undefined && !finite(v)) bad('mult', `${k}=${String(v)}`); }
}

/**
 * ⚠ C-13 (цели заданий): какие цели игра СЧИТАЕТ — модель фаззера, та же, что двигает шаг `questProgress`: убийство и подбор
 * (`trackObjective`), вход на этаж (`trackFloor`). Цель другого типа на доске или в журнале не закрыть никогда (цепочка встаёт).
 */
const QUEST_TRACKED: ReadonlySet<string> = new Set(['kill', 'collect-item', 'reach-floor']);

/**
 * I2: числа задания (C-02) — на доске и в журнале героя. Цель выполнима (целое ≥ 1: «0 из 0» не сдвигается, и задание не
 * закрыть никогда; тип — из тех, что игра считает, C-13), награда — целые не меньше нуля (иначе сдача уводит золото в минус, а
 * очки скилов в дробь).
 */
function questNumbers(d: QuestDef, where: string, out: Violation[]): void {
  for (const o of d.objectives) if (!(isInt(o.amount) && o.amount >= 1)) out.push({ inv: 'I2', code: 'quest-amount', msg: `${where} «${d.id}»: цель ${o.id} — ${o.amount}` });
  for (const o of d.objectives) if (!QUEST_TRACKED.has(o.type)) out.push({ inv: 'I2', code: 'quest-untracked', msg: `${where} «${d.id}»: цель ${o.id} типа «${o.type}» игра не считает — задание не закрыть` });
  for (const k of ['gold', 'xp', 'skillPoints'] as const) {
    const v = d.reward[k];
    if (v !== undefined && !(isInt(v) && v >= 0)) out.push({ inv: 'I2', code: 'quest-reward', msg: `${where} «${d.id}»: награда ${k}=${v}` });
  }
}

/**
 * ⭐ C-01: ПОТОЛОК, ПОД КОТОРЫМ ВЕЩЬ РОДИЛАСЬ (или последний раз пересобрана — подъём меняет требования): запоминается при первой
 * встрече вещи с такими требованиями. Хозяин опускает потолок — прежние вещи своих требований не меняют (так и в игре), и судить
 * их по новому было бы ложной тревогой; новые и пересобранные судятся по действующему.
 */
function birthCap(w: FuzzWorld, it: Item): number {
  const k = `${it.uid}|${JSON.stringify(it.requirements ?? {})}`;
  const caps = (w.reqCaps ??= new Map());
  let cap = caps.get(k);
  if (cap === undefined) { cap = w.reg.get('balance').maxTotalRequirement; caps.set(k, cap); }
  return cap;
}

/**
 * Правила вещи: свойств не больше, чем даёт редкость (и оплаченная форма скованной), ступень — в окне базы, сумма требований —
 * под потолком, действовавшим при её рождении (`birthCap`). Уник — со своими свойствами, обычная — без свойств.
 */
function itemRules(w: FuzzWorld, it: Item, where: string, out: Violation[]): void {
  const reg = w.reg;
  if (it.kind === 'material' || it.kind === 'consumable') return;
  const bad = (code: string, msg: string): void => { out.push({ inv: 'item', code, id: `${it.uid}:${code}`, msg: `${where} «${it.name}» [${it.uid.slice(-6)}]: ${msg}` }); };
  if (it.rarity !== 'unique') {
    const r = reg.get('rarities').find((x) => x.id === it.rarity);
    const ids = (kind: 'prefix' | 'suffix'): number => new Set(it.affixes.filter((a) => a.kind === kind).map((a) => a.affixId)).size;
    const p = ids('prefix'), sfx = ids('suffix');
    if (r && (p + sfx > r.maxAffixes || p > r.maxPrefix || sfx > r.maxSuffix)) bad('affix-count', `${p}+${sfx} свойств при редкости ${it.rarity} (до ${r.maxPrefix}+${r.maxSuffix}, всего ${r.maxAffixes})`);
    if (it.affixCap && (p > it.affixCap.prefix || sfx > it.affixCap.suffix)) bad('affix-cap', `${p}+${sfx} свойств при оплаченной форме ${it.affixCap.prefix}+${it.affixCap.suffix}`);
  }
  const base = reg.get('items.base').find((b) => b.id === it.baseId);
  if (base && it.tier) {
    const br = baseTierRange(reg, base);
    const t = tierIndexOfItem(reg, it);
    if (t < br.lo || t > br.hi) bad('tier-window', `ступень t${t} вне окна базы t${br.lo}–t${br.hi}`);
  }
  const reqSum = Object.values(it.requirements ?? {}).reduce<number>((n, v) => n + (v ?? 0), 0);
  const cap = birthCap(w, it);
  if (reqSum > cap) bad('req-cap', `требований ${reqSum} сверх потолка ${cap} (${JSON.stringify(it.requirements)}, происхождение ${it.origin})`);
}

/**
 * ⚠ R23-04: ЛАВКА НЕ СКУПАЕТ ДОРОЖЕ, ЧЕМ ПРОДАЁТ — у каждой вещи прилавка (снаряжение стока и зелья) цена покупки (`shopBuyPrice`) не ниже
 * скупки (`shopSellPrice`) и не ниже 1: «купил → сдал» в худшем случае в ноль. Гросбух (I5) видит это только на покупке, а здесь — сама цена,
 * как только правка конфига её сделала (зелье за 0 при скупке за 1 — раскупить прилавок без гроша и сдать; и так на каждый заход в город).
 */
function shopArbitrage(w: FuzzWorld, out: Violation[]): void {
  for (const it of [...w.shop, ...w.potions]) {
    const k = `buy|${w.cfgVer}|${it.uid}`;
    let buy = w.liqCache.get(k);
    if (buy === undefined) { buy = shopBuyPrice(w.reg, it); w.liqCache.set(k, buy); }
    const sell = shopSellPrice(w.reg, it);
    if (!(buy >= 1) || buy < sell) {
      out.push({ inv: 'rule', code: 'buy-sell', id: `shop:${it.uid}`, msg: `прилавок «${it.name}» [${it.uid.slice(-6)}] (${it.rarity}, ilvl ${it.itemLevel}): покупка ${buy}, скупка ${sell} — купил и сдал в плюс` });
    }
  }
}

/**
 * ⚠ R17-03: ЦЕНЫ ФОРМ ЁМКОСТИ. У каждой формы, которую даёт ёмкость (`affixFormKeys`), цена есть — по `formMult`, которым платят
 * ковка, зачарование и перекатка, — и форма на свойство богаче (с любой стороны) не дешевле. ✕ у строки или опечатка, пропущенные
 * схемой, — здесь: без строки форма шла по ×1 (3+2 дешевле 3+1 вшестеро), с нынешним `formMult` — «цены нет».
 */
function formPrices(reg: ConfigRegistry, out: Violation[]): void {
  const keys = affixFormKeys(Math.max(0, ...reg.get('balance').craft.capacityByTier));
  const m = (key: string): number | undefined => { const [p, s] = key.split('+').map(Number); return formMult(reg, { prefix: p!, suffix: s! }); };
  for (const key of keys) {
    const v = m(key);
    if (v === undefined || !(v >= 1)) { out.push({ inv: 'rule', code: 'form-price', id: `form:${key}`, msg: `форма ${key}: цены нет (${v}) — ковка, зачарование и перекатка ей обязаны отказывать` }); continue; }
    const [p, s] = key.split('+').map(Number);
    for (const poorer of [`${p! - 1}+${s}`, `${p}+${s! - 1}`]) {
      const u = keys.includes(poorer) ? m(poorer) : undefined;
      if (u !== undefined && v < u) out.push({ inv: 'rule', code: 'form-price', id: `form:${key}<${poorer}`, msg: `форма ${key} (×${v}) дешевле беднее её ${poorer} (×${u})` });
    }
  }
}

/**
 * ⚠ R20-05: КРИВАЯ ОПЫТА ЖИВОГО КОНФИГА — 0, 0, дальше строго растёт, числа конечные ≥ 0. Иначе участок порогов ниже прежних герой
 * проходит одним очком опыта — уровни с очками за каждый, навсегда (R9-05). Книга очков (`PointsBook`) такого не видит: она пишет
 * уровни, какие выдало ядро по той же кривой, — сторож здесь, на самой кривой.
 */
function xpCurve(reg: ConfigRegistry, out: Violation[]): void {
  const t = reg.get('balance').xpTable;
  const bad = t.findIndex((v, i) => !(finite(v) && v >= 0) || (i < 2 ? v !== 0 : !(v > t[i - 1]!)));
  if (bad >= 0) out.push({ inv: 'rule', code: 'xp-curve', id: `xp:${bad}`, msg: `кривая опыта: xpTable[${bad}] = ${t[bad]} (перед ним ${t[bad - 1]}) — не «0, 0, дальше строго растёт»: участок не выше прежних проходится одним очком опыта` });
}

/** Сетка: каждая вещь в своих клетках, без наложений. */
function gridCheck(items: Item[], d: Dims, where: string, out: Violation[]): void {
  const cells = new Map<string, string>();
  for (const it of items) {
    const p = it.pos;
    if (!p || !isInt(p.x) || !isInt(p.y) || p.x < 0 || p.y < 0 || p.x + it.gridW > d.cols || p.y + it.gridH > d.rows) {
      out.push({ inv: 'grid', code: 'bounds', msg: `${where}: «${it.name}» вне сетки (${JSON.stringify(p)}, ${it.gridW}×${it.gridH})` });
      continue;
    }
    for (let x = p.x; x < p.x + it.gridW; x++) for (let y = p.y; y < p.y + it.gridH; y++) {
      const k = `${x},${y}`;
      const o = cells.get(k);
      if (o) { out.push({ inv: 'grid', code: 'overlap', msg: `${where}: «${it.name}» наложена на ${o} в (${k})` }); return; }
      cells.set(k, it.name);
    }
  }
}

const normJson = (x: unknown): unknown => JSON.parse(JSON.stringify(x));
/** I7: сейв проходит схему туда-обратно без изменений. */
function zodCheck(save: SaveState, where: string, out: Violation[]): void {
  const raw = normJson(save);
  const res = saveStateSchema.safeParse(raw);
  if (!res.success) { out.push({ inv: 'I7', code: 'reject', msg: `${where}: схема сейва отвергла: ${res.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }); return; }
  const back = normJson(res.data);
  if (!deepEq(back, raw)) out.push({ inv: 'I7', code: 'roundtrip', msg: `${where}: схема изменила сейв: ${firstDiff(raw, back)}` });
}
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
  return ka.every((k) => deepEq(ra[k], rb[k]));
}
function firstDiff(a: unknown, b: unknown, path = ''): string {
  if (deepEq(a, b)) return '';
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return `${path}: ${JSON.stringify(a)?.slice(0, 60)} → ${JSON.stringify(b)?.slice(0, 60)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = (a as Record<string, unknown>)[k], vb = (b as Record<string, unknown>)[k];
    if (!deepEq(va, vb)) return firstDiff(va, vb, `${path}.${k}`);
  }
  return path;
}

/**
 * Инварианты состояния после шага (что бы ни делал шаг). Зовётся после КАЖДОГО шага (и в ядре, и в комнате) — поэтому здесь же книга
 * очков дописывает уровни, взятые шагом (`noteLevels`, R18-07, D2).
 */
export function stateInvariants(w: FuzzWorld, c: Census, zodFor: { hero: boolean[]; stash: boolean }): Violation[] {
  const out: Violation[] = [];
  const reg = w.reg;
  noteLevels(w, out);
  // Прилавок родился под тем потолком, что действовал при броске стока: запомнить сейчас, до правки, а не при покупке (`birthCap`).
  for (const it of w.shop) birthCap(w, it);
  // I3: uid уникальны.
  const seen = new Set<string>();
  for (const u of c.uidList) {
    if (seen.has(u)) out.push({ inv: 'I3', code: 'dup-uid', id: u, msg: `uid ${u} встречается дважды: ${c.uidWhere.get(u)?.join(', ')} («${c.items.get(u)?.item.name ?? 'сырьё'}»)` });
    seen.add(u);
  }
  w.heroes.forEach((s, h) => {
    const who = `герой ${h}`;
    // I2: числа героя.
    if (!(isInt(s.gold) && s.gold >= 0)) out.push({ inv: 'I2', code: 'gold', msg: `${who}: золото ${s.gold}` });
    for (const k of ['unspentAttributePoints', 'unspentSkillPoints', 'unspentMasteryPoints', 'level'] as const) {
      if (!(isInt(s[k]) && s[k] >= 0)) out.push({ inv: 'I2', code: k, msg: `${who}: ${k}=${s[k]}` });
    }
    if (!(finite(s.xp) && s.xp >= 0)) out.push({ inv: 'I2', code: 'xp', msg: `${who}: xp=${s.xp}` });
    for (const a of ATTRIBUTES) if (!(isInt(s.attributes[a]) && s.attributes[a] >= 0)) out.push({ inv: 'I2', code: 'attr', msg: `${who}: ${a}=${s.attributes[a]}` });
    for (const [id, v] of Object.entries(s.skills)) if (!(isInt(v) && v >= 0)) out.push({ inv: 'I2', code: 'skill', msg: `${who}: скил ${id}=${v}` });
    for (const [id, v] of Object.entries(s.masteries)) if (!(isInt(v) && v >= 0)) out.push({ inv: 'I2', code: 'mastery', msg: `${who}: мастерство ${id}=${v}` });
    for (const it of s.inventory) { itemNumbers(it, `${who} сумка`, out); itemRules(w, it, `${who} сумка`, out); }
    for (const it of Object.values(s.equipment)) if (it) { itemNumbers(it, `${who} надето`, out); itemRules(w, it, `${who} надето`, out); }
    for (const it of s.belt) if (it) itemNumbers(it, `${who} пояс`, out);
    for (const d of s.activeQuestDefs) questNumbers(d, `${who} журнал`, out);
    gridCheck(s.inventory, dimsOf(reg), `${who} сумка`, out);
    // Экипировка: слот по правилам, двуручник запирает вторую руку, сломанное не носится, требования держатся.
    const eq = s.equipment;
    for (const [slot, it] of Object.entries(eq)) {
      if (!it) continue;
      const fits = slot === 'offhand' ? it.slot === 'offhand' || (it.slot === 'weapon' && (it.hands ?? 1) < 2) : it.slot === slot;
      if (!fits) out.push({ inv: 'equip', code: 'slot', msg: `${who}: «${it.name}» (${it.slot}) в слоте ${slot}` });
      if (it.broken) out.push({ inv: 'equip', code: 'broken', msg: `${who}: надета сломанная «${it.name}»` });
      if (it.kind === 'material' || it.kind === 'consumable') out.push({ inv: 'equip', code: 'kind', msg: `${who}: надет ${it.kind}` });
    }
    const main = eq.weapon;
    if (main && (main.hands ?? 1) >= 2 && !main.versatile && eq.offhand) out.push({ inv: 'equip', code: '2h', msg: `${who}: двуручник «${main.name}» и вторая рука «${eq.offhand.name}»` });
    if (isVersatile(main) && eq.offhand?.slot === 'weapon') out.push({ inv: 'equip', code: 'versatile', msg: `${who}: полуторное с оружием во второй руке` });
    const unmet = unmetWorn(s.attributes, Object.values(eq).filter(Boolean) as Item[]);
    for (const u of unmet) out.push({ inv: 'equip', code: 'unmet', id: `${h}:${u.uid}`, msg: `${who}: не держится «${u.name}» (${JSON.stringify(u.requirements)} при ${JSON.stringify(s.attributes)})` });
    const cap = eq.belt?.beltSlots ?? 0;
    s.belt.forEach((it, i) => {
      if (it && i >= cap) out.push({ inv: 'equip', code: 'belt-limbo', msg: `${who}: колба «${it.name}» в поясе вне ёмкости (${i} ≥ ${cap})` });
      if (it && it.kind !== 'consumable') out.push({ inv: 'equip', code: 'belt-kind', msg: `${who}: в поясе ${it.kind}` });
    });
    // Очки не берутся из воздуха: вложенное + свободное = выданное уровнями (и наградой цепочки — очки скилов).
    // ⚠ R18-07: атрибуты — по книге героя (`PointsBook`): вложенное — от старта, с которым он создан, выданное — по очкам за уровень
    // того времени. От нынешней строки класса правка хозяина двигала бы «вложенное» сама, без единого шага героя.
    const book = w.books[h]!;
    const L = s.level;
    // ⚠ R19-01: сейв старше R18-07 — старт появляется первым входом или сбросом (что он запишет, модель посчитала в плане шага — `pending`);
    // комната, поднятая из базы до записи, снова его не помнит.
    const pend = book.pending;
    book.pending = undefined;
    if (book.legacy) book.floor = s.startAttributes === undefined ? undefined : pend ?? book.floor;
    const inv = ATTRIBUTES.reduce((n, a) => n + (s.attributes[a] - (book.start[a] ?? 0)), 0);
    const want = book.cum.attr[L];
    if (inv + s.unspentAttributePoints !== want) out.push({ inv: 'I4', code: 'attr-points', id: `${h}`, msg: `${who}: атрибутов вложено ${inv} + свободно ${s.unspentAttributePoints} ≠ выдано ${want} (уровень ${L})` });
    // Очки базы свободными не становятся: атрибут не ниже старта (сброс к опущенной строке класса раздавал их заново). У сейва без старта —
    // не ниже старта при создании, пока вход или сброс не записал свой.
    const floor = book.floor ?? book.start;
    const low = ATTRIBUTES.filter((a) => s.attributes[a] < (floor[a] ?? 0));
    if (low.length) out.push({ inv: 'I4', code: 'attr-floor', id: `${h}`, msg: `${who}: ${low.map((a) => `${a} ${s.attributes[a]} < старта ${floor[a]}`).join(', ')}` });
    // Сейв помнит тот же старт — от него ядро меряет возврат сброса (сейв старше R18-07 до первого входа или сброса — никакого).
    const startOk = book.floor ? ATTRIBUTES.every((a) => s.startAttributes?.[a] === book.floor![a]) : s.startAttributes === undefined;
    if (!startOk) out.push({ inv: 'I4', code: 'attr-start', id: `${h}`, msg: `${who}: старт в сейве ${JSON.stringify(s.startAttributes)} ≠ ${book.floor ? `ждали ${JSON.stringify(book.floor)}` : 'сейв без старта его не помнит'}` });
    // ⭐ D2: очки скилов и мастерства — тоже по книге (очки за уровень того времени), вложенное — Σ рангов (очко за ранг, R6-17; и за узлы,
    // которых в древе уже нет): живые очки за уровень и живое древо правка хозяина двигала бы сама.
    const ranks = (m: Record<string, number>): number => Object.values(m).reduce((n, v) => n + v, 0);
    const bonus = questSkillBonus(s);
    const sWant = (book.cum.skill[L] ?? 0) + bonus;
    if (ranks(s.skills) + s.unspentSkillPoints !== sWant) out.push({ inv: 'I4', code: 'skill-points', id: `${h}`, msg: `${who}: очков скилов вложено ${ranks(s.skills)} + свободно ${s.unspentSkillPoints} ≠ выдано ${sWant}` });
    const mWant = book.cum.mastery[L] ?? 0;
    if (ranks(s.masteries) + s.unspentMasteryPoints !== mWant) out.push({ inv: 'I4', code: 'mastery-points', id: `${h}`, msg: `${who}: очков мастерства вложено ${ranks(s.masteries)} + свободно ${s.unspentMasteryPoints} ≠ выдано ${mWant}` });
    // ⭐ D2: книга заработанного сейва — ровно выданное моделью (сдвиг — от дописки сейва старше правила, дальше заморожен): правка конфига,
    // вход и сброс её не двигают, двигает только выдача. Сейв старше D2 — книги нет, пока её не допишет вход или сброс (`pendingLedger`).
    const pl = book.pendingLedger;
    book.pendingLedger = undefined;
    if (book.legacyLedger) {
      if (s.earned === undefined) book.ledger = undefined;
      else if (pl && !book.ledger) {
        book.ledger = {
          attributePoints: pl.attributePoints - (book.cum.attr[L] ?? 0), skillPoints: pl.skillPoints - sWant, masteryPoints: pl.masteryPoints - mWant,
        };
      }
    }
    const led = book.ledger;
    const eWant: EarnedPoints | undefined = led && {
      attributePoints: (book.cum.attr[L] ?? 0) + led.attributePoints, skillPoints: sWant + led.skillPoints, masteryPoints: mWant + led.masteryPoints,
    };
    if (!deepEq(s.earned, eWant)) out.push({ inv: 'I4', code: 'earned', id: `${h}`, msg: `${who}: книга заработанного ${JSON.stringify(s.earned)} ≠ ${eWant ? `выдано ${JSON.stringify(eWant)}` : 'сейв старше D2 её не помнит (дописки не было)'}` });
    // ⭐ D2: и по самому сейву — вложенное (атрибуты — сверх его старта) + свободное = записано в книге.
    if (s.earned && s.startAttributes && !deepEq(pointsHeld(s, s.startAttributes), s.earned)) {
      out.push({ inv: 'I4', code: 'earned-held', id: `${h}`, msg: `${who}: вложено + свободно ${JSON.stringify(pointsHeld(s, s.startAttributes))} ≠ книга ${JSON.stringify(s.earned)}` });
    }
    // ⭐ D2: возврат сброса атрибутов — вложенное сверх записанного старта, от живого конфига не зависит (правка строки класса и очков за
    // уровень его не двигает): тот же сейв по конфигу по умолчанию — то же число.
    if (s.startAttributes) {
      const live = attrRespecRefund(reg, s), base = attrRespecRefund(pristineReg(), s);
      if (live !== base) out.push({ inv: 'I4', code: 'refund-config', id: `${h}`, msg: `${who}: сброс вернёт ${live} по живому конфигу и ${base} по умолчанию — правка конфига двигает возврат` });
    }
    if (zodFor.hero[h]) zodCheck(s, who, out);
  });
  for (const d of w.board) questNumbers(d, 'доска', out);
  formPrices(reg, out);
  xpCurve(reg, out);
  shopArbitrage(w, out);
  // Сундук: кошелёк, вкладки, журнал.
  for (const [id, n] of Object.entries(w.stash.materials ?? {})) if (!(isInt(n) && n >= 1)) out.push({ inv: 'I2', code: 'wallet', msg: `кошелёк: ${id}=${n}` });
  const sd = stashDims(reg);
  w.stash.tabs.forEach((tab, t) => {
    for (const it of tab) { itemNumbers(it, `вкладка ${t}`, out); itemRules(w, it, `вкладка ${t}`, out); }
    gridCheck(tab, sd, `вкладка ${t}`, out);
  });
  const j = c.journal;
  if (!(isInt(j.sketches) && j.sketches >= 0 && isInt(j.mythic) && j.mythic >= 0 && isInt(j.tierHi) && j.tierHi >= -1)) {
    out.push({ inv: 'I2', code: 'journal', msg: `журнал: ${JSON.stringify({ s: j.sketches, m: j.mythic, t: j.tierHi })}` });
  }
  if (zodFor.stash) {
    // Вещи вкладок — той же схемой вещи, что и сейв (своей схемы у сундука нет): вкладка как сумка героя.
    w.stash.tabs.forEach((tab, t) => { if (tab.length) zodCheck({ ...w.heroes[0], inventory: tab, equipment: {}, belt: [] }, `вкладка ${t}`, out); });
  }
  return out;
}

/** Инварианты перехода «до → после» по плану шага. */
export function stepInvariants(w: FuzzWorld, p: Plan, res: Res, b: Census, a: Census): Violation[] {
  const out: Violation[] = [];
  const v = (inv: string, code: string, msg: string): void => { out.push({ inv, code, msg }); };
  if (p.kind === 'meta') {
    if (a.json !== b.json) v('I1', 'meta-mutates', `служебный шаг (конфиг/сток) изменил сейв или сундук: ${firstDiff(JSON.parse(`[${b.json.split('\n').join(',')}]`), JSON.parse(`[${a.json.split('\n').join(',')}]`))}`);
    return out;
  }
  if (!res.ok) {
    if (a.json !== b.json) v('I1', 'refusal-mutates', `отказ «${res.reason}» изменил сейв или сундук: ${firstDiff(JSON.parse(`[${b.json.split('\n').join(',')}]`), JSON.parse(`[${a.json.split('\n').join(',')}]`))}`);
    return out;
  }
  const spec = p.spec(res);
  // I4: золото.
  for (const h of [0, 1] as const) {
    const d = a.gold[h] - b.gold[h];
    const g = spec.gold?.h === h ? spec.gold : undefined;
    if (!g) { if (d !== 0) v('I4', 'gold-untouched', `золото героя ${h} изменилось на ${d}, шаг его не трогает`); continue; }
    if (g.free) continue;
    if (g.delta !== undefined && d !== g.delta) v('I4', 'gold-delta', `золото героя ${h}: ${d}, ждали ${g.delta}`);
    if (g.maxPay !== undefined && !(Number.isFinite(g.maxPay) && -d <= g.maxPay)) v('consent', 'max-gold', `взято ${-d} золота при согласии ${g.maxPay}`);
    if (g.minGet !== undefined && !(Number.isFinite(g.minGet) && d >= g.minGet)) v('consent', 'min-gold', `выручка ${d} при согласии ${g.minGet}`);
  }
  // I4: сырьё.
  const m = spec.mats;
  const ids = new Set([...Object.keys(a.mats), ...Object.keys(b.mats), ...Object.keys(m?.spend ?? {}), ...Object.keys(m?.gain ?? {})]);
  for (const id of ids) {
    const d = (a.mats[id] ?? 0) - (b.mats[id] ?? 0);
    if (m?.free) { if (d < 0) v('I4', 'mats-loot-loss', `добыча убавила ${id} на ${-d}`); continue; }
    if (m?.loss) { if (d > 0) v('I4', 'mats-gain', `${id} +${d} на шаге без прихода`); continue; }
    if (m?.gain) {
      const g = m.gain[id];
      if (!g) { if (d !== 0) v('I4', 'mats-outside', `разбор сдвинул ${id} на ${d} вне вилки`); continue; }
      if (d < g.min || d > g.max) v('I4', 'mats-range', `разбор дал ${id} ${d} вне вилки ${g.min}–${g.max}`);
      continue;
    }
    const want = -(m?.spend?.[id] ?? 0);
    if (d !== want) v('I4', 'mats-delta', `${id}: ${d}, ждали ${want}`);
  }
  if (m?.maxSpend !== undefined) {
    for (const id of ids) {
      const spent = (b.mats[id] ?? 0) - (a.mats[id] ?? 0);
      const own = Object.prototype.hasOwnProperty.call(m.maxSpend, id) ? m.maxSpend[id]! : 0;
      if (spent > 0 && !(spent <= own)) v('consent', 'max-mats', `списано ${id} ${spent} при согласии ${JSON.stringify(m.maxSpend)}`);
    }
  }
  if (m?.minGain !== undefined) {
    for (const [id, n] of Object.entries(m.minGain)) {
      const got = (a.mats[id] ?? 0) - (b.mats[id] ?? 0);
      if (!(got >= n)) v('consent', 'min-yield', `разбор дал ${id} ${got} при согласии ${n}`);
    }
  }
  // I4: вещи — ушли только названные, появились только разрешённые, прочие не изменились.
  // Вещь, которая УЖЕ лежит дважды (I3 пойман раньше), по uid не сверить: перепись держит одну копию. Её судьба — не этого шага.
  const dup = (u: string): boolean => (b.uidWhere.get(u)?.length ?? 0) > 1 || (a.uidWhere.get(u)?.length ?? 0) > 1;
  const gone = [...b.items.keys()].filter((u) => !a.items.has(u) && !dup(u));
  const born = [...a.items.keys()].filter((u) => !b.items.has(u) && !dup(u));
  const consumes = (spec.consumes ?? []).filter((u) => !dup(u));
  for (const u of gone) {
    const was = b.items.get(u)!;
    const bagOk = (spec.bagLoss !== undefined && was.where === `inv${spec.bagLoss}`)
      || (spec.heroGone !== undefined && [`inv${spec.heroGone}`, `eq${spec.heroGone}`, `belt${spec.heroGone}`].includes(was.where));
    if (!consumes.includes(u) && !bagOk) v('I4', 'item-vanished', `вещь «${was.item.name}» (${was.where}) исчезла`);
  }
  for (const u of consumes) if (b.items.has(u) && a.items.has(u)) v('I4', 'item-kept', `вещь «${b.items.get(u)!.item.name}» не ушла, хотя шаг её расходует`);
  const cr = spec.creates;
  const allowed = cr ? (cr.n === -2 ? Infinity : cr.n < 0 ? 1 : cr.n) : 0;
  if (born.length > allowed || (cr && cr.n > 0 && born.length !== cr.n)) v('I4', 'item-born', `появилось вещей ${born.length}, разрешено ${cr ? cr.n : 0}: ${born.map((u) => a.items.get(u)!.item.name).join(', ')}`);
  for (const u of born) { const e = cr?.check?.(a.items.get(u)!.item); if (e) v('I4', 'item-born-check', e); }
  const tf = spec.transforms ?? [];
  for (const [u, was] of b.items) {
    const now = a.items.get(u);
    if (now && !tf.includes(u) && !dup(u) && now.key !== was.key) v('I4', 'item-mutated', `вещь «${was.item.name}» изменилась: ${diffKeys(was.item, now.item, ['pos'])}`);
  }
  // I6: журнал и ключи.
  const je = spec.journal ? spec.journal(b.journal, a.journal) : sameJ(b.journal, a.journal, ALL_J);
  if (je) v('I6', 'journal', je);
  if (!spec.nonces && a.nonces !== b.nonces) v('I6', 'nonces', 'ключи заявок изменились не ковкой');
  // I5: гросбух.
  const inj = p.kind === 'inject' ? spec.injected ?? 0 : 0;
  if (a.value > b.value + inj + 1e-6) v('I5', 'ledger', `ценность аккаунта ${b.value} → ${a.value} (+${a.value - b.value}, впрыснуто ${inj})`);
  // ⚠ R19-01: итог очков атрибутов героя — независимо от ядра (возврат ядра `extra` сверяет с его же `attrRespecRefund`).
  if (spec.attrTotal) {
    const s = w.heroes[spec.attrTotal.h];
    const t = ATTRIBUTES.reduce((n, x) => n + s.attributes[x], 0) + s.unspentAttributePoints;
    if (t !== spec.attrTotal.total) v('I4', 'respec-total', `герой ${spec.attrTotal.h}: атрибуты + свободные ${spec.attrTotal.total} → ${t} (сброс очки переносит, а не ${t < spec.attrTotal.total ? 'теряет' : 'создаёт'})`);
  }
  const e = spec.extra?.();
  if (e) v('rule', 'extra', e);
  return out;
}

// ── Прогон и сжатие ─────────────────────────────────────────────────────────────────────────────

export interface FuzzHooks {
  /** Сброс счётчика uid (детерминизм повтора). */
  resetUids?: () => void;
  /** Только для проверки зубов сторожа: подложить «баг» после исполнения шага. */
  afterRun?: (w: FuzzWorld, op: Op, res: Res) => void;
}
export interface Found { at: number; op: Op; v: Violation; log: string[] }
export interface OpStat { ok: number; no: number; why: Record<string, number> }
export interface RunOut {
  found?: Found;
  /** Нарушения СТАРТОВОГО состояния (законная история: новый герой, опыт, находки) — не шага; дальше ловятся только новые. */
  init: Violation[];
  stats: Record<string, OpStat>;
  steps: number;
  /** Журнал шагов прогона. */
  log: string[];
}

/** Ключ нарушения для дедупа: инвариант, код, вид шага. */
export const violationKey = (f: { op: Op; v: Violation }): string => `${f.v.inv}:${f.v.code}:${f.op.k}`;
const sig = (x: Violation): string => `${x.inv}:${x.code}:${x.id ?? x.msg}`;

/**
 * ПРОГОН ЦЕПОЧКИ: мир из сида, шаги по порядку, инварианты после каждого. Первое нарушение — стоп (`only` — ловить только
 * этот ключ, прочие нарушения пропускаются: сжатие не должно подменять одно нарушение другим; `skip` — эти ключи уже известны,
 * прогон идёт дальше мимо них). Нарушения СОСТОЯНИЯ шагу засчитываются, только если их не было до него: унаследованное
 * (стартовый комплект, прошлый шаг) — не его.
 */
export function runOps(seed: number, ops: readonly Op[], hooks: FuzzHooks = {}, only?: string, skip?: (key: string) => boolean): RunOut {
  hooks.resetUids?.();
  const w = newWorld(seed);
  const stats: RunOut['stats'] = {};
  const log: string[] = [];
  let before = census(w);
  const zodFor = { hero: [true, true], stash: true };
  const init = stateInvariants(w, before, zodFor);
  let prevState = new Set(init.map(sig));
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    w.now += createRng(op.s ^ 0x51ed).int(1_000, 30_000);
    let p: Plan;
    let res: Res;
    try {
      p = plan(w, op);
      // Команда с провода — сперва схемой сервера (`Room.handleCmd` → `parseTownCommand`): кривое до ядра не доходит.
      const wire = p.cmd ? parseTownCommand(JSON.parse(JSON.stringify(p.cmd))) : null;
      res = wire && !wire.ok ? { ok: false, reason: `схема: ${wire.error}` } : p.run();
      hooks.afterRun?.(w, op, res);
    } catch (e) {
      const v: Violation = { inv: 'crash', code: String((e as Error)?.message ?? e).replace(/[0-9a-f-]{8,}|\d+/g, '#').slice(0, 80), msg: String((e as Error)?.stack ?? e).slice(0, 600) };
      log.push(`#${i} ${op.k}/${op.h}: ПАДЕНИЕ ${v.msg.split('\n')[0]}`);
      const key = violationKey({ op, v });
      if (only ? key === only : !skip?.(key)) return { found: { at: i, op, v, log }, init, stats, steps: i + 1, log };
      return { init, stats, steps: i + 1, log };
    }
    const st = (stats[op.k] ??= { ok: 0, no: 0, why: {} });
    if (res.ok) st.ok++;
    else { st.no++; const why = (res.reason ?? '').replace(/«[^»]*»/g, '«»').replace(/\d+/g, '#').replace(/:.*$/, ':…').slice(0, 60); st.why[why] = (st.why[why] ?? 0) + 1; }
    log.push(`#${i} ${op.k}/${p.h ?? op.h}: ${p.desc} → ${res.ok ? 'ок' : `отказ «${res.reason}»`}`);
    const after = census(w);
    zodFor.hero = [after.heroJson[0] !== before.heroJson[0], after.heroJson[1] !== before.heroJson[1]];
    zodFor.stash = after.stashJson !== before.stashJson;
    const state = stateInvariants(w, after, zodFor);
    const vs = [...stepInvariants(w, p, res, before, after), ...state.filter((x) => !prevState.has(sig(x)))];
    // Схему проверяем только у изменившегося — её нарушение переносим в «было», чтобы не терять его при неизменном сейве.
    prevState = new Set([...state.map(sig), ...[...prevState].filter((x) => x.startsWith('I7:'))]);
    const hit = only ? vs.find((v) => violationKey({ op, v }) === only) : vs.find((v) => !skip?.(violationKey({ op, v })));
    if (hit) return { found: { at: i, op, v: hit, log }, init, stats, steps: i + 1, log };
    before = after;
  }
  return { init, stats, steps: ops.length, log };
}

/**
 * СЖАТИЕ: обрезать после нарушения, затем выбрасывать куски (половины, четверти… по одному), пока нарушение ТОГО ЖЕ ключа
 * воспроизводится. `budget` — предел прогонов.
 */
export function shrink(seed: number, ops: readonly Op[], key: string, hooks: FuzzHooks = {}, budget = 300): { ops: Op[]; out: RunOut } {
  let cur = [...ops];
  let best = runOps(seed, cur, hooks, key);
  if (!best.found) return { ops: cur, out: best };
  cur = cur.slice(0, best.found.at + 1);
  let runs = 1;
  let chunk = Math.max(1, Math.floor(cur.length / 2));
  while (chunk >= 1 && runs < budget) {
    let removed = false;
    for (let at = 0; at < cur.length && runs < budget;) {
      const cand = [...cur.slice(0, at), ...cur.slice(at + chunk)];
      runs++;
      const out = runOps(seed, cand, hooks, key);
      if (out.found) { cur = cand.slice(0, out.found.at + 1); best = out; removed = true; }
      else at += chunk;
    }
    if (!removed) chunk = Math.floor(chunk / 2);
  }
  return { ops: cur, out: best };
}
