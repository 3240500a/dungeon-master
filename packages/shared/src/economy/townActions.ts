import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { EarnedPoints, SaveState } from '../types/save.js';
import type { Item, EquipSlot, Rarity, ConsumableUse } from '../types/items.js';
import { ATTRIBUTES, type Attribute, type Attributes } from '../types/attributes.js';
import { unmetWorn } from '../formulas/stats.js';
import { isVersatile } from '../formulas/versatile.js';
import { rollAffixes, nextTier, inferTierId, retierItem, tierMatters } from '../formulas/itemgen.js';
import {
  CRAFT_NONCES_KEEP, FORM_UNPRICED, MATERIAL_STEPS, affixSlotsFor, craftMissing, craftSalvageYield, craftTiers, craftWeapon, enchantCost,
  enchantItem, enchantSlots, essenceMaterials, fullJournal, isCraftNonce, materialId, meltReturn, normalizeCraftNonces, normalizeJournal,
  parseCraftInput, partById, partFamily, partsOf, rolledFormMult, salvageIntoJournal, shapeFoundWeapon, sketchable, tierIndex, typeOfItem,
  upgradeFoundParts, useSketch, type SalvageUnlock, catalogProgress, emptyJournal, salvageFullOrigin, salvageGrades, salvageTierIndex, priceTierIndex,
  type CraftJournal,
} from '../formulas/craft.js';
import type { Rng } from '../formulas/rng.js';
import { addToInventory, hasSpace, placeWithDisplacement, type Dims } from '../inventory/grid.js';
import type { DebuffState } from '../world/debuffs.js';
import { socketsOpen, insertById, insertUnlocked, insertFits } from '../session/inserts.js';
import { ESSENCE_ID, UNIQUE_NO_SALVAGE, canSalvage, salvageFromItem, salvageRuleFor, type SalvageRng } from '../formulas/salvage.js';
import { addToWallet, availableMaterials, bagCopy, canAffordBoth, carriedMaterials, giveMaterialsTo, missingForBoth, spendBoth, depositCarried,
  type MaterialCost, type MaterialWallet } from './materials.js';
import type { AccountStash } from '../types/stash.js';
import type { TownCommand } from '../session/netTypes.js';
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

/** Начало отказа «цена выросла» (R5-15) — по нему клиент понимает, что его конфиг устарел, и перечитывает его. */
export const PRICE_CHANGED = 'Цена изменилась';

/**
 * ⭐ R5-15: СОГЛАСИЕ НА ЦЕНУ. Платная команда (ковка, зачарование, улучшение, перекатка, починка, сбросы) несёт
 * `maxGold` — цену, которую показала игроку карточка. Золото берёт сервер по СВОЕМУ конфигу, а у клиента он мог
 * устареть: деплой с правкой баланса при переподключении без перезагрузки страницы, правка из редактора, `/api/config`,
 * не ответивший на старте. Раньше сервер молча брал новую цену (ковка t6, показанная за 3000, стоила 4500) — теперь
 * отказ ДО любой траты и новая цена в причине. Цена ниже показанной — не отказ: игрок согласился на большее.
 * `maxGold` нет — прежнее поведение (Unity и старые вкладки его не шлют). Невалидный (`NaN`) — отказ: цена не согласована.
 */
export function priceRaised(gold: number, maxGold: number | undefined): ActionResult | null {
  if (maxGold === undefined) return null;
  return Number.isFinite(maxGold) && gold <= maxGold ? null : { ok: false, reason: `${PRICE_CHANGED}: ${gold} золота` };
}

/**
 * ⭐ V-B3-07: КОМАНДЫ, ЧЕЙ ИСХОД ОКНО РИСУЕТ ПО СВОЕМУ КОНФИГУ — кузница, лавка, разбор: вещь ковки (урон «от–до», требования,
 * ступень), предпросмотр подъёма, выход разбора, «горит / погашено». Согласие на цену (`maxGold`, `maxMaterials`, `minYield`)
 * держит только цену: правка живьём, не менявшая цены (вилка броска базы, скидка требований), — и игрок платил показанное за
 * ДРУГУЮ вещь; отказ не ценой («Кузнец ещё не куёт», «Материал ещё не в игре») конфиг клиента не перечитывал вовсе.
 * Покупки здесь нет: вещь и цену прилавка присылает сервер (кадр `shop`, R4-37), конфиг клиента в ней не участвует, а цену держит `maxGold`.
 */
export const CONFIG_CONSENT_CMDS: ReadonlySet<TownCommand['cmd']> = new Set<TownCommand['cmd']>([
  'sell', 'forgeUpgrade', 'forgeReroll', 'forgeRepair', 'forgeSalvage', 'craft', 'forgeEnchant', 'forgeSketch', 'salvage', 'forgeExchange',
]);

/**
 * ⭐ V-B3-07: СОГЛАСИЕ НА КОНФИГ. `cfgRev` — ревизия конфига, с которого клиент нарисовал окно (`ConfigRegistry.revision`); у сервера
 * другая — отказ ДО исполнения, и причина начинается с «Цена изменилась»: клиент по ней перечитывает конфиг (`App.syncConfig`), и
 * окно показывает то, что сервер сделает. Нет поля — прежнее поведение (Unity и старые вкладки его не шлют).
 * ⭐ 08.10 (Д1): годится и ИГРОВАЯ ревизия (`gameRevision`): клиент, приславший её, рисовал окно с того же игрового конфига, а правка
 * картинки (текстура, материал, вид модели) исход команды не меняет — отказывать ему не за что. Полная ревизия по-прежнему годится.
 */
export function configChanged(reg: ConfigRegistry, cfgRev: string | undefined): ActionResult | null {
  if (cfgRev === undefined || cfgRev === reg.revision() || cfgRev === reg.gameRevision()) return null;
  return { ok: false, reason: `${PRICE_CHANGED}: условия кузницы и лавки обновлены` };
}

/**
 * ⭐ D3: причина отказа СОГЛАСИЯ НА СБОРКУ (`buildChanged`) — «Цена изменилась…»: клиент по ней перечитывает конфиг, а поскольку код вкладки
 * перечитыванием не догнать, сразу за этим говорит «перезагрузите страницу» (`client/net/versionGate.ts`).
 */
export const BUILD_CHANGED = `${PRICE_CHANGED}: сервер обновился`;

/**
 * ⭐ D3: СОГЛАСИЕ НА СБОРКУ — зеркало `configChanged` для КОДА. `build` — штамп сборки вкладки (`buildStampOf` исходников shared, вписан в
 * бандл), с кода которой окно посчитало цену и исход: формулу цены кузницы и скупки, выход разбора, вилки ковки. У сервера штамп другой
 * (`serverBuild`: деплой сменил код, вкладка его пережила без перезагрузки — L2 / R3-25) — отказ ДО исполнения: согласие на цену
 * (`maxGold`, `minGold`, `minYield`) держит лишь одну сторону, и старый код, показавший цену ВЫШЕ новой, получал вещь за другую цену, чем
 * показал (дешевле показанного, а выход разбора — щедрее обещанного). Нет штампа с любой стороны (Unity, дев-сервер Vite, сервер без
 * исходников, старая вкладка) — сравнивать нечего, как раньше.
 */
export function buildChanged(serverBuild: string, build: string | undefined): ActionResult | null {
  if (!build || !serverBuild || build === serverBuild) return null;
  return { ok: false, reason: BUILD_CHANGED };
}

/**
 * V-B3-07: команда с ревизией СВОЕГО конфига — для команд `CONFIG_CONSENT_CMDS` (прочие — как есть). Клиент зовёт на отправке.
 * ⭐ R16 C-07: `rev` строкой — ревизия, которую сервер прислал с телом конфига, легшим у клиента (`CONFIG_REV_HEADER`, `App.configRevision`).
 * ⭐ D3: `build` — штамп сборки вкладки (`clientBuild`), согласие на КОД (`buildChanged`); пустой — поля нет (дев-сервер, мост редактора).
 */
export function withConfigRev(rev: ConfigRegistry | string, command: TownCommand, build = ''): TownCommand {
  if (!CONFIG_CONSENT_CMDS.has(command.cmd)) return command;
  return { ...command, cfgRev: typeof rev === 'string' ? rev : rev.revision(), ...(build ? { build } : {}) } as TownCommand;
}

/**
 * ⚠ R6-16: ЗЕРКАЛО `priceRaised` ДЛЯ ПРОДАЖИ. `minGold` — сколько лавка обещала за вещь (подпись «+N» по конфигу клиента);
 * даёт МЕНЬШЕ — отказ до продажи, с ценой в причине. Больше — не отказ. Нет поля — как раньше; невалидное — отказ.
 */
export function priceDropped(gold: number, minGold: number | undefined): ActionResult | null {
  if (minGold === undefined) return null;
  return Number.isFinite(minGold) && gold >= minGold ? null : { ok: false, reason: `${PRICE_CHANGED}: лавка даст ${gold} золота` };
}

/** Сколько `id` в словаре согласия: только своё поле объекта и только конечное число ≥ 0, иначе `NaN` (согласия нет). */
function consentOf(shown: Record<string, number>, id: string): number {
  if (!Object.prototype.hasOwnProperty.call(shown, id)) return 0;
  const n = shown[id];
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}
const consentBroken = (shown: unknown): boolean =>
  !shown || typeof shown !== 'object' || Array.isArray(shown) || Object.keys(shown).some((id) => Number.isNaN(consentOf(shown as Record<string, number>, id)));

/**
 * ⭐ R8-14: СОГЛАСИЕ НА СЫРЬЁ — зеркало `priceRaised` для материалов. `maxMaterials` — сырьё, которое показала карточка
 * (ковка, улучшение, починка). Берёт ядро по СВОЕМУ конфигу, и правка из редактора живьём (`craft.cost.units`, строка формы,
 * доводка, `upgradeMaterials`/`repairMaterials`) поднимала сырьё молча: золото то же — `maxGold` проходил, а из сумки и
 * кошелька сундука уходило больше показанного. Любого материала нужно больше, чем в карточке (или его там не было), — отказ
 * до траты, с ценой в причине. Меньше — не отказ. Нет поля — прежнее поведение (песочница редактора, сим, тесты); кривое — отказ.
 * ⭐ СЕРВЕР поля не прощает (`serverMaterialsConsent`): команда без него — согласие «ни на какое сырьё».
 */
export function materialsRaised(reg: ConfigRegistry, cost: MaterialCost, maxMaterials: Record<string, number> | undefined): ActionResult | null {
  if (maxMaterials === undefined) return null;
  const raised = consentBroken(maxMaterials)
    || Object.entries(cost).some(([id, n]) => n > 0 && !(n <= consentOf(maxMaterials, id)));
  return raised ? { ok: false, reason: `${PRICE_CHANGED}: ${describeCost(reg, cost)}` } : null;
}

/**
 * ⭐ СОГЛАСИЕ НА СЫРЬЁ У СЕРВЕРА ОБЯЗАТЕЛЬНО: нет поля `maxMaterials` — согласие «ни на какое сырьё» (`{}`), а не «на любое». Подъём, починка,
 * перекатка и зачарование с сырьём или эссенцией в цене без него — отказ «Цена изменилась» ДО траты; без сырья в цене — как прежде.
 * ⚠ Прежде «нет поля» значило «прежнее поведение», и с эссенцией в цене перекатки и чар (§6.2) клиент, рисующий по старым правилам (Unity
 * до переноса, старая вкладка), платил эссенцией из сумки и сундука, которой карточка не показывала: зачарование скованной t3 до редкой
 * молча снимало 16 эссенции (R8-14 в обход). Веб шлёт поле всегда (`forgeBench`, `craftHost`).
 */
export function serverMaterialsConsent(maxMaterials: Record<string, number> | undefined): Record<string, number> {
  return maxMaterials ?? {};
}

/**
 * ⭐ R8-14: СОГЛАСИЕ НА ВЫХОД РАЗБОРА — зеркало `priceDropped`. `minYield` — нижняя граница вилки «от–до», которую показал
 * верстак (или меню разбора в поле): разбор уничтожает вещь, и после правки выхода живьём (`craft.salvage.units`, правила
 * разбора, `fieldYield`) он молча давал меньше обещанного. Меньше показанного по любому материалу — отказ, вещь цела.
 * Больше — не отказ. Сверка — по НИЖНЕЙ границе этого же расчёта (`salvageRange`): бросок выхода случаен.
 * ⭐ R9-04: и по СРЕДНЕМУ (`avgYield`, `salvageMean`). Низ дробной доли — 0 при любой правке: пояс в поле, обычное оружие
 * (0.3 × 1–3 единицы детали) показывали «0–1» и до правки `fieldYield` 0.3 → 0.05, и после — согласие по низу пропускало
 * разбор за шестую часть обещанного. Среднее меньше показанного по любому материалу — тот же отказ. Своего среднего сервер
 * не посчитал (исходов больше предела) — сверка только по низу.
 */
export function yieldDropped(
  reg: ConfigRegistry, item: Item, inField: boolean, minYield: Record<string, number> | undefined, avgYield?: Record<string, number>,
): ActionResult | null {
  if (minYield === undefined && avgYield === undefined) return null;
  const range = salvageRange(reg, item, inField).range;
  const low: MaterialCost = {};
  for (const [id, r] of Object.entries(range)) low[id] = r.min;
  const own = (m: MaterialCost, id: string): number => (Object.prototype.hasOwnProperty.call(m, id) ? m[id]! : 0);
  const lowDropped = minYield !== undefined
    && (consentBroken(minYield) || Object.keys(minYield).some((id) => consentOf(minYield, id) > own(low, id)));
  const mean = avgYield !== undefined ? salvageMean(reg, item, inField) : null;
  // Допуск — шум плавающей точки: тот же конфиг даёт то же число до бита, правка доли — в разы.
  const avgDropped = avgYield !== undefined
    && (consentBroken(avgYield) || (mean !== null && Object.keys(avgYield).some((id) => consentOf(avgYield, id) > own(mean, id) + 1e-9)));
  if (!lowDropped && !avgDropped) return null;
  const avg = mean ? `, в среднем ${describeCost(reg, Object.fromEntries(Object.entries(mean).map(([id, n]) => [id, Math.round(n * 100) / 100]))) || 'ничего'}` : '';
  return { ok: false, reason: `${PRICE_CHANGED}: разбор даст от ${describeCost(reg, low) || 'ничего'}${avg}` };
}

/** Живые витальные поля цели зелья (общий тип для клиента-GameState и серверного PlayerEntity). */
export interface Vitals { hp: number; mana: number; debuffs: DebuffState; }

/** Пул «полон» с точностью до шума плавающей точки (сотни единиц — шум ~10⁻¹³; доля единицы зелью не повод уходить). */
const FULL_EPS = 1e-6;

/**
 * Применяет мгновенный эффект расходника (лечение/мана/снятие статусов) к витальным
 * полям — ЕДИНАЯ истина для клиента и сервера. Возвращает false, если ничего не
 * изменилось (полное HP у чистого лечения). Бафф-моды (buffMods) обрабатываются
 * отдельно на стороне вызывающего (у клиента и сервера — разные каналы): у сервера — `GameSession.drink` →
 * `drinkBuff` (⚠ C-11, бафф-зелья: до него сервер бафф не вешал вовсе, и зелье-бафф не выпивалось никогда).
 *
 * ⚠ C-14: `manaCap` — ЭФФЕКТИВНЫЙ потолок маны (ауры резервируют долю пула: `effectivePool`). Сила зелья — от полного пула, а
 * налить можно только до потолка: у потолка зелье «без эффекта» и не тратится. Раньше сравнение шло с полным `maxMana` — зелье у
 * зарезервированного потолка уходило, реген тика срезал ману обратно, а каст того же тика тратил налитое сверх резерва.
 * ⚠ «Не полон» — с допуском на шум плавающей точки (`FULL_EPS`): потолок пересчитывается каждый тик (снимок статов, резерв), и мана,
 * подрезанная регеном к потолку прошлого тика, лежала ниже нынешнего на 4·10⁻¹³ — колба уходила за «+0» (фаззер правил, сид 590).
 */
export function applyConsumable(t: Vitals, use: ConsumableUse, maxHp: number, maxMana: number, manaCap: number = maxMana): boolean {
  let did = false;
  const heal = (use.heal ?? 0) + (use.healPct ?? 0) * maxHp;
  if (heal > 0 && t.hp < maxHp - FULL_EPS) { t.hp = Math.min(maxHp, t.hp + heal); did = true; }
  const mana = (use.mana ?? 0) + (use.manaPct ?? 0) * maxMana;
  if (mana > 0 && t.mana < manaCap - FULL_EPS) { t.mana = Math.min(manaCap, t.mana + mana); did = true; }
  if (use.cure) {
    const keys = Object.keys(t.debuffs);
    if (keys.length) { for (const k of keys) delete (t.debuffs as Record<string, unknown>)[k]; did = true; }
  }
  return did;
}

// ── Цены (совпадают с бывшим town/pricing.ts) ────────────────────────────────
type Rarities = ConfigShapes['rarities'];
const priceMult = (rarities: Rarities, id: Rarity): number => rarities.find((r) => r.id === id)?.priceMult ?? 1;

/**
 * НАДБАВКА ЗА СТУПЕНЬ: вещь стоит, сколько она бьёт (D21). ⚠ До неё цена ступени не видела вовсе —
 * `(15 + ilvl × 4 + аффиксы × 12) × редкость`, и мифическая «обычная» с прилавка на 80-м уровне стоила
 * ≈ 339 золота, восемь убийств (§12.4).
 *
 * Надбавка — `(15 + 4 × порог ступени) × (statMult − 1)`: на пороге своей ступени вещь стоит ровно
 * ×statMult прежней цены (мифик 80-го уровня ≈ 2 000), а уровень СВЕРХ порога добавляет цену как раньше,
 * НЕ множась на ступень. ⚠ Множитель на всю цену сделал бы подъём ступени в кузнице печатным станком на
 * глубине, будь он и в продаже: прибавка продажи от подъёма росла бы с уровнем вещи без предела, а цена
 * подъёма — нет (сторож (г) — `shopPrices.test.ts`).
 * ⚠ Надбавка — ТОЛЬКО В ЦЕНЕ ПОКУПКИ (R2-16): лавка дорого продаёт, а скупает по-прежнему (`shopSellPrice`).
 * Будь она и в продаже, каждая сданная находка — обычное поведение игрока — приносила бы ×1.24 золота на
 * 20-м уровне и ×2.5 на 90-м (доход за убийство +53 % на глубине) против цели «золото дефицитно всю игру».
 * Нет тира на вещи (сейв старше поля, зелья, сырьё) — надбавки нет, как было.
 * ⚠ R12-03: и у вещи, которую ступень НЕ МЕНЯЕТ (кольцо, амулет — `tierMatters`): «Мифическое» кольцо бьёт как «Убогое» с
 * теми же свойствами, а стоило впятеро дороже (на 80-м уровне 4 910 против 890 при одной скупке 356).
 */
function tierPremium(reg: ConfigRegistry, item: Item): number {
  const t = item.tier ? reg.get('item-tiers').find((x) => x.id === item.tier) : undefined;
  if (!t || !Number.isFinite(t.statMult) || t.statMult <= 1) return 0;
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (base && !tierMatters(base)) return 0;
  return (15 + 4 * Math.max(0, t.minItemLevel)) * (t.statMult - 1);
}

/**
 * БЕСПЛАТНЫЙ СТАРТОВЫЙ КОМПЛЕКТ (R3-04) — лавка берёт за 1, кузнец разбирает ТОЛЬКО В КАТАЛОГ: ни сырья, ни эссенции, ни эскиза
 * (решение владельца D1; нового в каталоге нет — отказ с причиной, §9.3). ⚠ R4-34: только НЕТРОНУТЫЙ: поднятый у кузнеца (`tierForged`)
 * оплачен золотом и сырьём — он разбирается как купленный, по исходной ступени (`bornTier` = t0: сорт I, не выше III, без эссенции).
 * Краном это не стало: подъём бесплатной вещи дороже того, что она потом даст продажей или разбором, на каждой
 * ступени (сторож — `starterKit.test.ts`). Происхождение не переписывается: эскиз такая вещь не копит (`countsAsFind`).
 */
const freeKit = (item: Item): boolean => item.origin === 'start' && !item.tierForged;

/** Оценка `(15 + ilvl × 4 + аффиксы × 12 + надбавка) × редкость`. Без надбавки — база скупки лавкой (и вся оценка до D21). */
const estimate = (reg: ConfigRegistry, item: Item, premium = 0): number =>
  Math.round((15 + item.itemLevel * 4 + item.affixes.length * 12 + premium) * priceMult(reg.get('rarities'), item.rarity));

/** Оценочная стоимость предмета НА ПРИЛАВКЕ: iLvl + кол-во аффиксов + надбавка ступени, × редкость. */
export function shopItemValue(reg: ConfigRegistry, item: Item): number {
  return estimate(reg, item, tierPremium(reg, item));
}
export function shopSellPrice(reg: ConfigRegistry, item: Item): number {
  // ⭐ Сырьё — ПОШТУЧНО по `craft-materials.sellPrice` (сорта I–V: 1 · 2 · 5 · 10 · 15, эссенция 5 — D4, дешевле вещи, из которой вышли). До этого стек шёл по
  // формуле вещи — 7 золота за стек любой длины и любой ступени: стек из одной ржавой железки стоил как семь,
  // а сотня булата — как та же одна. Отсюда же меряются инварианты «не прачечная» (цена сырья = его продажа).
  if (item.kind === 'material') {
    const unit = reg.get('craft-materials').find((m) => m.id === item.materialId)?.sellPrice ?? 0;
    const n = typeof item.count === 'number' && Number.isFinite(item.count) && item.count >= 1 ? Math.floor(item.count) : 1;
    return Math.max(1, unit * n);
  }
  // ⚠ R3-04: СТАРТОВЫЙ КОМПЛЕКТ — за 1. Он бесплатен и бесконечен: создал героя → переложил комплект в сундук
  // аккаунта (или бросил соседу) → удалил героя → заново. По формуле вещи комплект стоил 35 золота, и скрипт гонял
  // круг за 2–3 с — десятки тысяч золота в час против цели «золото дефицитно». Сырья его разбор не даёт — только каталог (`salvagePlan`).
  if (freeKit(item)) return 1;
  // Без надбавки ступени (R2-16, см. `tierPremium`): она — плата за силу вещи на прилавке, а не доход с находки.
  const flat = Math.max(1, Math.floor(estimate(reg, item) * 0.4));
  // ⭐ D4 (решение владельца 06.10: сырьё продаётся, но «разобрать и продать» — невыгодно): ЛАВКА ПЛАТИТ ЗА ВЕЩЬ НЕ МЕНЬШЕ, ЧЕМ СТОИТ
  // ВЫХОД ЕЁ РАЗБОРА У КУЗНЕЦА (`salvageWorth`: лучший бросок, сырьё и эссенция по `sellPrice`). Правило, а не числа — держится при ЛЮБОМ
  // конфиге: и у скованной (переплавка возвращает долю заплаченного сырья, а формула вещи о нём не знает: меч III из 89 единиц III
  // сдавался за ≈ 54, а переплавка — за ≈ 255), и при множителе цены редкости у нуля (R23-04). У найденных при живых ценах сырья пол
  // не включается (цены держит `salvageSellIssues`, сторож — `salvageSell.test.ts`): цена вещи — её формула. Петли нет: ковка берёт всё
  // сырьё и золото, а продажа скованного возвращает не больше доли `melt.share` < 1 сырья — меньше, чем продажа того же сырья напрямую.
  return Math.max(flat, salvageWorth(reg, item));
}

/**
 * БРОСКИ-КРАЙНОСТИ для вилки «от и до»: настоящий расчёт разбора, но кубик всегда даёт низ либо верх.
 * ⚠ Верх — «доля округлится вверх, ЕСЛИ ОНА ЕСТЬ». Бросок «всегда да» добавлял единицу и к целому
 * выходу: настоящий `chance(0)` не выпадает никогда, и нагрудник с потолком 3 обещал «до 4», а пол цены
 * лавки (`salvageWorth`) считал четвёртую единицу. Доля меньше `1e-9` — шум плавающей точки (3 × 0.1),
 * а не шанс: настоящий бросок её не увидит.
 */
const ROLL_LO: SalvageRng = { int: (a) => a, chance: () => false };
const ROLL_HI: SalvageRng = { int: (_a, b) => b, chance: (p) => p > 1e-9 };

/**
 * СКОЛЬКО СТОИТ СЫРЬЁ С РАЗБОРА вещи у кузнеца — по верху вилки выхода, в ценах `craft-materials.sellPrice`.
 * Не разбирается — 0. Тот же расчёт, что у самого разбора (`salvageYield`), а не своя формула.
 */
export function salvageWorth(reg: ConfigRegistry, item: Item): number {
  const hi = salvageYield(reg, item, ROLL_HI, false);
  if (!hi.ok) return 0;
  const mats = reg.get('craft-materials');
  let sum = 0;
  for (const [id, n] of Object.entries(hi.gains)) sum += n * (mats.find((m) => m.id === id)?.sellPrice ?? 0);
  return Math.ceil(sum);
}

/**
 * ЛАВКА РАСХОДНИКОВ (R2-04): что и по сколько штук лежит на прилавке — заново на КАЖДЫЙ заход в город (сервер
 * катает это в `Room.freshConsumables`). Бросать тут нечего, поэтому это не сток героя, как снаряжение. Одно место —
 * для сервера и для бота прогона баланса: бот пополняет пояс ПОКУПКОЙ из того же запаса.
 */
export const SHOP_CONSUMABLES: readonly string[] = ['minor-healing-potion', 'healing-potion', 'mana-potion', 'antidote'];
export const SHOP_CONSUMABLE_STOCK = 5;

/**
 * ⭐ R11-13: ЗЕЛЬЯ ЛАВКИ, КОТОРЫЕ ЕСТЬ В ИГРЕ: из `SHOP_CONSUMABLES` — только расходники, чья база есть в `items.base` и не выключена
 * в редакторе (`enabled: false`: «не выпадает и не в магазине»). Раньше выключенная база с монстров не падала, а лавка раскладывала
 * её по пять на каждый заход в город и продавала, и бот прогона баланса покупал её в пояс. Один список — серверу и боту.
 */
export function shopConsumableIds(reg: ConfigRegistry): string[] {
  const on = new Set(reg.get('items.base').filter((b) => b.kind === 'consumable' && b.enabled !== false).map((b) => b.id));
  return SHOP_CONSUMABLES.filter((id) => on.has(id));
}

/**
 * ЦЕНА ПОКУПКИ: оценка, но НЕ ДЕШЕВЛЕ сырья, которое даст разбор этой вещи у кузнеца (D21).
 * ⚠ Без пола лавка была бы краном сырья за золото: детали найденной вещи видны на ней (`foundParts`), и
 * «Крепкий» меч с булатным клинком (ступень вещи — средняя по массе, §11) стоил ≈ 130 золота, а разбор
 * отдавал три булата — 324 в ценах сырья. Покупатель выбирал бы такие глазами. Продажу пол не трогает.
 * ⚠ R23-04: и НЕ ДЕШЕВЛЕ СКУПКИ (`shopSellPrice`, а она — от 1): лавка не скупает дороже, чем продаёт, — «купил → сдал» в худшем случае
 * в ноль. Оценка — `round(… × priceMult)`, а схема пускает множитель редкости от 0 («обычное ничего не стоит»): ниже ≈ 0.026 зелье прилавка
 * стоило 0, а сдавалось за 1 — 20 колб даром и +20 золота на каждый заход в город (прилавок зелий заново). Одно правило вместо пола под
 * каждую правку: кузница пол 1 держит сама (`forgeGold`), а тут пол — и есть скупка той же вещи.
 */
export function shopBuyPrice(reg: ConfigRegistry, item: Item): number {
  return Math.max(shopItemValue(reg, item), salvageWorth(reg, item), shopSellPrice(reg, item));
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

/**
 * ⚠ R4-08: ТРЕБОВАНИЯ ДЕРЖАТСЯ ВСЁ ВРЕМЯ НОШЕНИЯ. Проверялись они только на входе в слот — и неверно: смена амулета
 * считала прибавку УХОДЯЩЕГО, а снятие вещи и сброс атрибутов не проверяли ничего. Кольцо +Сила → тяжёлый меч →
 * снял кольцо (или сбросил очки в Ловкость) — меч висел и бил в полную силу при 20 Силы из 30, честным интерфейсом.
 *
 * Возвращает надетую вещь, которую перемена (`attrs` и `worn` — как станет) лишила бы опоры (`unmetWorn`), хотя
 * до неё вещь держалась. Уже не державшаяся (сейв старше правки) не мешает ни снять её, ни что-то ещё: иначе две
 * такие вещи запирали бы друг друга навсегда. Бонусы дерева мастерства в требования не идут (как и раньше).
 */
function wornBroken(save: SaveState, attrs: Attributes, worn: Item[]): Item | undefined {
  const before = new Set(unmetWorn(save.attributes, equippedItems(save)).map((i) => i.uid));
  return unmetWorn(attrs, worn).find((i) => !before.has(i.uid));
}
/** Отказ «на вещь не хватит атрибутов» — одна строка для снятия, смены и сброса. */
const wornReason = (it: Item): string => `Не хватит атрибутов на «${it.name}» — сперва сними её`;

// ── Магазин ──────────────────────────────────────────────────────────────────
/**
 * ⭐ V-B3-02: КУПИТ ЛИ ПРИЛАВОК — хватит ли золота и ляжет ли вещь в сумку. ОДИН ответ для покупки (`buyItem`) и для ценника
 * окна («по карману» у лавки зелий и «🛒 Купить» кузницы): ценник смотрел только на золото, и вещь «по карману» в полную сумку
 * отказывала «Нет места». `price` — цена, которую спишут: у сервера своя (`shopBuyPrice`), у окна — цена кадра (`app.shopPrice`, R4-37).
 */
export function canBuy(reg: ConfigRegistry, save: SaveState, item: Item, price: number): ActionResult {
  if (save.gold < price) return { ok: false, reason: 'Недостаточно золота' };
  if (!hasSpace(save.inventory, item.gridW, item.gridH, dimsOf(reg))) return { ok: false, reason: 'Нет места' };
  return { ok: true };
}

// ⭐ R6-16: покупка несёт `maxGold` (цена кадра лавки), продажа — `minGold` (подпись «+N»): цена на сервере могла уйти от
// показанной (правка из редактора живьём, деплой при переподключении без перезагрузки), и молча он брать не должен.
export function buyItem(reg: ConfigRegistry, save: SaveState, item: Item, maxGold?: number): ActionResult {
  const price = shopBuyPrice(reg, item);
  const raised = priceRaised(price, maxGold);
  if (raised) return raised;
  const can = canBuy(reg, save, item, price);
  if (!can.ok) return can;
  save.gold -= price;
  addToInventory(save.inventory, item, dimsOf(reg));
  return { ok: true };
}

export function sellItem(reg: ConfigRegistry, save: SaveState, uid: string, minGold?: number): ActionResult {
  const idx = save.inventory.findIndex((i) => i.uid === uid);
  if (idx < 0) return { ok: false, reason: 'Предмет не в инвентаре' };
  const price = shopSellPrice(reg, save.inventory[idx]!);
  const dropped = priceDropped(price, minGold);
  if (dropped) return dropped;
  save.inventory.splice(idx, 1);
  save.gold += price;
  return { ok: true };
}

// ── Кузница (авторитетно; раньше мутировал клиент → откатывалось сейвом) ──────
/**
 * ⭐ ВЕЩЬ «КАК НАЙДЕННАЯ» на своей ступени — мерка цены подъёма и починки (предложение «Разбор, сырьё и чары» §7): обычная, без
 * свойств, найденная (полный сорт, без потолка не-находки), без `bornTier`, без метки подъёма и без поломки. Её разбор у кузнеца и
 * есть «что вещь этой ступени стоит в сырье»: одна таблица (рецепт `salvage.recipeByTier`, правила `salvage-rules`) описывает и что
 * вещь даёт, и что она стоит, поэтому разойтись они не могут.
 */
function asFound(item: Item): Item {
  const { bornTier: _b, tierForged: _f, broken: _x, ...rest } = item;
  return { ...rest, origin: 'drop', rarity: 'normal', affixes: [] };
}

/**
 * ПОБОЧНЫЕ семьи правила разбора вещи — строки «0–N» (`min` 0): прибор щита, поддоспешник лат. Они подкармливают узкие семьи ковки
 * (рецензия 06.10: Прибор и Ткань шли только с оружия своего класса; «Плечи» с их китовым усом кожаной брони сняты), а в основу подъёма не входят.
 * Семья, что есть и в обязательной строке, побочной не считается.
 */
function optionalFamilies(reg: ConfigRegistry, item: Item): Set<string> {
  const rule = salvageRuleFor(item, weaponClassOf(reg, item), reg.get('salvage-rules'));
  const fam = (id: string): string => reg.get('craft-materials').find((m) => m.id === id)?.family ?? id.replace(/-\d+$/, '');
  const must = new Set((rule?.yields ?? []).filter((y) => y.min > 0).map((y) => fam(y.materialId)));
  return new Set((rule?.yields ?? []).filter((y) => y.min <= 0).map((y) => fam(y.materialId)).filter((f) => !must.has(f)));
}

/** Главная семья сырья вещи: у оружия по деталям — семья ударной части; у прочего — первая семья правила разбора. Нет — `undefined`. */
function mainFamily(reg: ConfigRegistry, item: Item): string | undefined {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (base?.kind === 'weapon') {
    const anat = reg.get('weapon-anatomy').find((a) => a.id === base.weaponClass);
    const picks = partsOf(reg, item);
    const p = picks ? partById(reg, picks.strike.id) : undefined;
    if (anat && p) return partFamily(anat, 'strike', p);
  }
  const first = salvageRuleFor(item, weaponClassOf(reg, item), reg.get('salvage-rules'))?.yields?.[0]?.materialId;
  return first ? reg.get('craft-materials').find((m) => m.id === first)?.family : undefined;
}

/** Сложить `n` сырья `family-grade` в цену, спустив выключенный сорт до ближайшего включённого ниже (`knownOnly`); нет ни одного — пропуск. */
function addGrade(reg: ConfigRegistry, out: MaterialCost, family: string | undefined, grade: number, n: number): void {
  if (!family || !(n > 0)) return;
  for (const [id, k] of Object.entries(knownOnly(reg, { [materialId(family, Math.max(1, Math.min(MATERIAL_STEPS, grade)))]: n }))) {
    out[id] = (out[id] ?? 0) + k;
  }
}

/**
 * ⭐ ЦЕНА ПОДЪЁМА В СЫРЬЕ — ПО СТУПЕНИ, А НЕ ПО РЕДКОСТИ (предложение «Разбор, сырьё и чары» §7, `forgePrices.upgradeMaterials`).
 * Подъём до ступени t просит:
 * - ОСНОВУ — верх вилки разбора этой вещи у кузнеца, будь она НАЙДЕНА на ступени t (`asFound` поднятой вещи: те же детали в своих
 *   семьях, рецепт t), × `baseShare`. Оружие — 7 единиц по рецепту t (лук платит Деревом и Тканью своих деталей, концы-накладки — Прибором;
 *   не одним Деревом прежних правил `w-*`); нагрудник 3, шлем, сапоги, перчатки и пояс по 2, щит — 3 дерева + 2 железа. Эссенции в основе нет; ПОБОЧНОГО выхода
 *   правила (строка «0–N»: прибор щита, поддоспешник лат — `optionalFamilies`) тоже нет: он подкармливает узкие
 *   семьи ковки, а не делает подъём брони дороже;
 * - РАСХОДНИК — `consumable` сырья I сорта главной семьи вещи (`mainFamily`): сток I на любой глубине.
 * Редкость меняет только золото (`forgeGold`). Поэтому IV и V тратятся подъёмом до t5–t6, а «поднять и разобрать» — чистый расход при
 * ЛЮБЫХ числах: разбор поднятой вещи идёт по исходной ступени (`bornTier`, §11.2).
 * Пусто — кузнец эту вещь не поднимает (уник, скованная, на потолке, всё сырьё выключено), и это ОТКАЗ (`canUpgradeItem`), а не «бесплатно».
 * ⚠ Было: лестница сортов I–III по редкости — редкий меч t1→t2 просил Уклад, а IV и V подъём не тратил никогда.
 */
export function upgradeCost(reg: ConfigRegistry, item: Item): MaterialCost {
  if (item.rarity === 'unique' || item.parts) return {};
  const next = upgradedItem(reg, item);
  if (!next) return {};
  const k = reg.get('balance').forgePrices.upgradeMaterials;
  const out: MaterialCost = {};
  const found = asFound(next);
  const hi = salvageYield(reg, found, ROLL_HI, false);
  const optional = hi.source === 'rules' ? optionalFamilies(reg, found) : new Set<string>();
  const familyOf = (id: string): string | undefined => reg.get('craft-materials').find((m) => m.id === id)?.family;
  if (hi.ok) {
    for (const [id, n] of Object.entries(hi.gains)) {
      if (id === ESSENCE_ID || optional.has(familyOf(id) ?? '')) continue;
      const m = Math.ceil(n * k.baseShare - 1e-9);
      if (m > 0) out[id] = (out[id] ?? 0) + m;
    }
  }
  addGrade(reg, out, mainFamily(reg, found), 1, k.consumable);
  return out;
}

/**
 * ⭐ ЦЕНА ПОЧИНКИ В СЫРЬЕ — по ступени вещи (§7, `forgePrices.repairMaterials`): `consumable` сырья I сорта главной семьи + `main` ГЛАВНОГО
 * сорта вещи на её нынешней ступени — сорт ударной части оружия по рецепту (`salvage.recipeByTier`), у брони, щита и оружия без деталей —
 * нижний сорт строки, как у их разбора. Редкость — только в золоте. Пусто (уник, всё сырьё выключено) — ОТКАЗ (`canRepairItem`).
 */
export function repairCost(reg: ConfigRegistry, item: Item): MaterialCost {
  if (item.rarity === 'unique') return {};
  const k = reg.get('balance').forgePrices.repairMaterials;
  const found = asFound(item);
  const family = mainFamily(reg, found);
  const g = salvageGrades(reg, found);
  const byParts = Object.keys(craftSalvageYield(reg, found)).length > 0;
  const out: MaterialCost = {};
  addGrade(reg, out, family, 1, k.consumable);
  addGrade(reg, out, family, byParts ? (g.row[0] ?? g.low) : g.low, k.main);
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
export function forgeUpgrade(reg: ConfigRegistry, save: SaveState, uid: string, wallet: MaterialWallet, maxGold?: number, maxMaterials?: Record<string, number>): ActionResult {
  const idx = save.inventory.findIndex((i) => i.uid === uid);
  const item = save.inventory[idx];
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  const can = canUpgradeItem(reg, item);
  if (!can.ok) return can;
  // ⚠ Результат считает `upgradedItem` — ТА ЖЕ функция, которой кузница рисует предпросмотр
  // «было → станет». Будь здесь своя копия расчёта, скидка на требования или потолок их суммы
  // разъехались бы молча, и окно обещало бы игроку не то, за что он платит.
  const next = upgradedItem(reg, item)!;   // `canUpgradeItem` уже отказал бы без неё
  const gold = forgeGold(reg, item, 'upgrade');
  const mats = upgradeCost(reg, item);
  const raised = priceRaised(gold, maxGold) ?? materialsRaised(reg, mats, maxMaterials);   // R5-15, R8-14: цена карточки устарела — отказ до траты
  if (raised) return raised;
  if (save.gold < gold) return { ok: false, reason: 'Недостаточно золота' };
  if (!canAffordBoth(save.inventory, wallet, mats)) {
    return { ok: false, reason: `Не хватает материалов: ${describeCost(reg, missingForBoth(save.inventory, wallet, mats))}` };
  }
  // ⚠ Списываем ОБА ресурса и только потом меняем предмет: иначе отказ на середине оставил бы
  // игрока без золота и без улучшения.
  save.gold -= gold;
  spendBoth(save.inventory, wallet, mats);
  // ⚠ ЗАМЕНА объекта, а не `Object.assign` (D14): новая вещь — это `next` целиком. Переклейка
  // оставила бы ключи, которые пересборка УДАЛИЛА (`shapeFoundWeapon` снимает `damageMult` и
  // `spreadMult`, когда клинок их больше не даёт), — и вещь несла бы множитель урона от старой формы.
  // Ищем заново по uid: `spendBoth` мог убрать из сумки опустевший стек, и прежний индекс уже чужой.
  const at = save.inventory.findIndex((i) => i.uid === uid);
  if (at >= 0) save.inventory[at] = next;
  else save.inventory.push(next);   // вещи с этим uid в сумке нет — вставка не задвоит её
  return { ok: true };
}

/**
 * МОЖНО ЛИ УЛУЧШИТЬ — ОДИН ответ для карточки верстака и для отказа сервера (как `canRerollItem`, `canSalvageItem`).
 * ⚠ R2-12: карточка считала своё (`nextTierOf` + `upgradeCost`) и скованной вещи не видела — горела «Улучшить до
 * «Отличный»» с ценой, а сервер всегда отказывал. Золото и сырьё — не здесь: их не хватает «пока», и карточка
 * показывает это построчно.
 * ⭐ R12-03: вещь, которую ступень НЕ МЕНЯЕТ (кольцо, амулет: ни урона, ни брони — `tierMatters`), — отказ до оплаты. Прежде
 * подъём кольца t0 → t6 брал 13 584 золота и шесть лестниц железа, а статы, требования, аффиксы и мощь героя оставались те же.
 */
export function canUpgradeItem(reg: ConfigRegistry, item: Item): ActionResult {
  if (item.broken) return { ok: false, reason: 'Сперва почини' };
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base) return { ok: false, reason: 'Кузнец не знает такой вещи' };
  if (item.parts) return { ok: false, reason: 'Скованную вещь поднимает замена детали, а не подъём тира' };
  // ⭐ Уник кузнец не поднимает — ЯВНО (§7). Прежде его отсекала только пустая лестница сырья по редкости (`unique: 0`); цена по ступени
  // у него не пуста, и без этой строки уник t3 → t6 поднимался бы за ≈ 17 тыс. золота и ×2.4 к статам базы. «Нашёл — носи как есть».
  if (item.rarity === 'unique') return { ok: false, reason: UNIQUE_NO_UPGRADE };
  if (!tierMatters(base)) return { ok: false, reason: 'Ступень этой вещи ничего не меняет' };
  // Ступень выше есть, а подъёма нет — у найденного меча, чьи детали до неё не дотягиваются (R4-31).
  if (!upgradedItem(reg, item)) return { ok: false, reason: nextTierOf(reg, item) ? 'Эта форма выше не куётся' : 'Лучше эту вещь уже не сделать' };
  if (!Object.keys(upgradeCost(reg, item)).length) return { ok: false, reason: 'Эту вещь кузнец не улучшает' };
  return { ok: true };
}

/** Отказ подъёма уникальной вещи — одна строка для сервера, карточки и эталона Unity. */
export const UNIQUE_NO_UPGRADE = 'Уникальную вещь кузнец не поднимает';

/** Какое действие кузницы считаем. */
export type ForgeOp = 'upgrade' | 'repair' | 'reroll';

/**
 * ЦЕНА РАБОТЫ КУЗНЕЦА В ЗОЛОТЕ = база × `reqMult` ступени × `priceMult` редкости.
 *
 * ⚠ ЗАЧЕМ. Доход золота растёт с уровнем монстра (`ур + 3` за убийство), а цены были ПЛОСКИМИ:
 * замер показал 1.0 улучшения за этаж на 5-м уровне и 14.0 на сотом, то есть золото к концу игры
 * обесценивалось в четырнадцать раз. Со ступенью в цене эта колонка встаёт колом: 1.4 / 0.9 / 0.6
 * улучшения за этаж (обычная / магическая / редкая) на ВСЕХ ступенях.
 *
 * ⭐ Сырьё масштабируется СОРТОМ, а не количеством (`upgradeCost`, `repairCost`, предложение «Разбор, сырьё и чары» §7): подъём до t
 * просит основу по рецепту ступени t, а приход высоких сортов — только с находок своей ступени. Редкость меняет только золото.
 *
 * ⚠ Множители не новые: `item-tiers.reqMult` и `rarities.priceMult` уже есть в конфиге. Заводить
 * третью колонку значило бы держать три таблицы про одно и то же и следить, чтобы они не разъехались.
 * `reqMult` выбран, а не `statMult`: он отслеживает рост дохода заметно точнее (проверено замером).
 *
 * У улучшения ступень берётся ЦЕЛЕВАЯ — платим за то, что покупаем, а не за то, что имеем. У починки и перекатки — нынешняя ступень цены
 * (`priceTierIndex`: записанная, а у вещи без поля — по уровню, как её разбор); у подъёма — по статам (`inferTierId`), как сам подъём.
 *
 * ⚠ ПЕРЕКАТКА СКОВАННОЙ — ещё × M формы, которую она катает (R2-10, docs/CRAFT_WEAPONS.md §6.3): каждая
 * перекатка выдаёт ГАРАНТИРОВАННУЮ форму, ровно как зачарование (`rolledFormMult` — тот же шов). Без
 * множителя одно зачарование 3+2 за 9 743 открывало три полных броска той же формы по 1 958 — скидка 80 %.
 * У найденной ёмкости нет, множитель 1: её перекатка катает случайное число слотов, как дроп.
 */
export function forgeGold(reg: ConfigRegistry, item: Item, op: ForgeOp): number {
  const fp = reg.get('balance').forgePrices;
  const base = op === 'upgrade' ? fp.upgradeTier : op === 'repair' ? fp.repairBroken : fp.rerollAffix;
  const tiers = reg.get('item-tiers');
  const itemsBase = reg.get('items.base');
  const b = itemsBase.find((x) => x.id === item.baseId);
  const curId = b ? inferTierId(tiers, b, item, reg.get('balance').loot.baseRoll) : item.tier;
  const tier = op === 'upgrade'
    ? tiers.find((t) => t.id === (b ? nextTier(tiers, b, curId)?.id ?? curId : curId))
    : craftTiers(reg)[priceTierIndex(reg, item)];
  const rarity = reg.get('rarities').find((r) => r.id === item.rarity);
  // R17-03: у катаемой формы нет цены — NaN (не число, а не скидка до ×1); `canRerollItem` откажет раньше, «Форма без цены».
  const form = op === 'reroll' ? rolledFormMult(reg, item, item.rarity) ?? Number.NaN : 1;
  return Math.max(1, Math.round(base * (tier?.reqMult ?? 1) * (rarity?.priceMult ?? 1) * form));
}

/** Какой тир будет следующим (для подписи кнопки) — или `undefined`, если вещь на потолке. */
export function nextTierOf(reg: ConfigRegistry, item: Item): { id: string; name: string } | undefined {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base) return undefined;
  const tiers = reg.get('item-tiers');
  return nextTier(tiers, base, inferTierId(tiers, base, item, reg.get('balance').loot.baseRoll));
}

/**
 * КАКОЙ СТАНЕТ ВЕЩЬ ПОСЛЕ УЛУЧШЕНИЯ — источник предпросмотра «было → станет» И самого
 * улучшения (`forgeUpgrade` зовёт эту же функцию). `undefined` — нет базы, вещь на потолке либо записанные
 * детали найденного до следующей ступени не дотягиваются (R4-31).
 */
export function upgradedItem(reg: ConfigRegistry, item: Item): Item | undefined {
  // ⚠ СКОВАННУЮ не поднимаем (docs/CRAFT_WEAPONS.md §11): её ступень — функция материалов деталей.
  // `retierItem` пересобрал бы статы от базы и молча стёр вклад деталей (поле `parts` при этом
  // выжило бы), а доводка, оплаченная по цене дешёвой ступени, доехала бы до мифической.
  if (item.parts) return undefined;
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base) return undefined;
  const tiers = reg.get('item-tiers');
  // ⚠ Тир БЕРЁТСЯ ИЗ ВЕЩИ, а при отсутствии поля — ВОССТАНАВЛИВАЕТСЯ по статам (`inferTierId`).
  // Без этого вещь из старого сейва считалась стоящей ниже первой ступени, «улучшалась» до t0
  // и становилась слабее: замер — алебарда 14–30 → 11–23 за 200 золота и сырьё.
  const bal = reg.get('balance');
  const tier = nextTier(tiers, base, inferTierId(tiers, base, item, bal.loot.baseRoll));
  if (!tier) return undefined;
  // Бросок базы переживает подъём: доля q та же, поэтому «удачный» меч остаётся удачным на новом тире.
  const next = retierItem(base, item, tier, {
    reqDiscount: bal.forgePrices.upgradeReqDiscount,
    maxReqTotal: bal.maxTotalRequirement,
    spread: bal.loot.baseRoll,
  });
  // Ступень куплена у кузнеца, а не найдена: мифик так не засчитается воротам t6 (`countsAsMythicFind`).
  // ⭐ И РАЗБОР ПОЙДЁТ ПО ИСХОДНОЙ СТУПЕНИ (`bornTier`, пишет только первый подъём): «поднять и разобрать» — всегда чистый расход,
  // какие бы цены ни стояли в конфиге (предложение «Разбор, сырьё и чары» §5, §11.2). Вещь, поднятая до этого поля (только тестовая
  // база), — без него: разбор читает её как купленную (`salvageFullOrigin`), а не по нынешней ступени.
  if (!item.tierForged && !item.bornTier) {
    const born = craftTiers(reg)[salvageTierIndex(reg, item)]?.id;
    if (born) next.bornTier = born;
  }
  next.tierForged = true;
  // ⭐ Найденный меч с записанными деталями (§26): клинок тот же, ступени деталей — под новый тир (разбор
  // отдаёт то, из чего вещь сделана), статы клинка — заново от деталей, а не вычитанием из старых статов.
  if (!next.foundParts) return next;
  // ⚠ R4-31: детали этой формы до новой ступени не дотягиваются — выше она не куётся, как не собрала бы её и ковка:
  // подъёма нет (`canUpgradeItem` говорит почему). R5-09: «не дотягиваются» — это ключ (тип), а у клинка с геометрией и
  // оголовье: они несут тип и числа. Держак и обвязка, кончившиеся на ступени ниже, берутся другие той же семьи.
  const parts = upgradeFoundParts(reg, next, tierIndex(reg, tier.id));
  return parts ? shapeFoundWeapon(reg, { ...next, foundParts: parts }) : undefined;
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
  // R9-04: пустой низ — это «от 0», а не «вилки нет»: отказ `salvageYield` решает лучший бросок (R9-03), и пустая вилка
  // бывает только у вещи, которая не даст ничего никогда. Раньше мелочь в поле (пояс, перчатки, обычное оружие) шла с `{}`.
  const lo = salvageYield(reg, item, ROLL_LO, inField);
  if (!lo.ok) return { ...lo, range: {} };
  const hi = salvageYield(reg, item, ROLL_HI, inField);
  const range: Record<string, { min: number; max: number }> = {};
  for (const id of new Set([...Object.keys(lo.gains), ...Object.keys(hi.gains)])) {
    const min = lo.gains[id] ?? 0;
    range[id] = { min, max: Math.max(hi.gains[id] ?? 0, min) };
  }
  return { ok: true, range };
}

/** Предел исходов перебора в `salvageMean`. Правило разбора из конфига — 1–2 строки с вилкой в 1–2 единицы: ≤ 16 исходов. */
const MEAN_RUNS_MAX = 4096;
/** Сигналы перебора: бросок дошёл до развилки, которой ещё нет в пути; исходов больше предела. */
const MEAN_FORK = Symbol('развилка');
const MEAN_OVER = Symbol('перебор');

/**
 * ⭐ R9-04: СРЕДНИЙ ВЫХОД РАЗБОРА — ожидание НАСТОЯЩЕГО броска (`salvageYield`), как вилка — его крайности, а не своя формула.
 * Перебираются все исходы кубика: `int` — каждое значение поровну, `chance(p)` — «да» с весом p и «нет» с весом 1 − p; выход
 * исхода идёт в сумму со своим весом. Нужен согласию (`yieldDropped`): низ вилки дробной доли — 0 при любой правке выхода,
 * а среднее видит и её (`fieldYield` 0.3 → 0.05 — вилка «0–1» та же, среднее вшестеро меньше). Не разбирается — `null`;
 * исходов больше предела (правило из редактора с вилкой в сотни единиц) — тоже `null`: сверять не по чему.
 */
export function salvageMean(reg: ConfigRegistry, item: Item, inField: boolean): Record<string, number> | null {
  if (!salvageYield(reg, item, ROLL_HI, inField).ok) return null;
  type Pick = { v: number; p: number };
  const sum: Record<string, number> = {};
  let runs = 0;
  // Путь — выборы кубика по порядку. Бросок дальше пути бросает `MEAN_FORK` с вариантами — и перебор идёт по каждому.
  const walk = (path: readonly Pick[], weight: number): void => {
    if (++runs > MEAN_RUNS_MAX) throw MEAN_OVER;
    const st: { at: number; fork: Pick[] } = { at: 0, fork: [] };
    const take = (opts: () => Pick[]): number => {
      if (st.at < path.length) return path[st.at++]!.v;
      st.fork = opts();
      throw MEAN_FORK;
    };
    const rng: SalvageRng = {
      int: (a, b) => take(() => {
        const n = b - a + 1;
        if (n > MEAN_RUNS_MAX) throw MEAN_OVER;
        return n <= 1 ? [{ v: a, p: 1 }] : Array.from({ length: n }, (_, k) => ({ v: a + k, p: 1 / n }));
      }),
      chance: (p) => take(() => (p >= 1 ? [{ v: 1, p: 1 }] : p <= 0 ? [{ v: 0, p: 1 }] : [{ v: 1, p }, { v: 0, p: 1 - p }])) === 1,
    };
    let gains: MaterialCost;
    try {
      gains = salvageYield(reg, item, rng, inField).gains;
    } catch (e) {
      if (e !== MEAN_FORK) throw e;
      for (const o of st.fork) walk([...path, o], weight * o.p);
      return;
    }
    for (const [id, n] of Object.entries(gains)) sum[id] = (sum[id] ?? 0) + n * weight;
  };
  try {
    walk([], 1);
  } catch (e) {
    if (e === MEAN_OVER) return null;
    throw e;
  }
  return sum;
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

/**
 * Слоты перекатки. ⚠ С учётом объявленной ёмкости скованной вещи (docs/CRAFT_WEAPONS.md §6.3): возьми их
 * прямо из редкости, и перекатка снесёт купленную форму первым нажатием (вернуть ровно 3+2 — 16.7 %).
 * У найденной вещи ёмкости нет, и слоты те же, что были. Редкости нет в конфиге — `null`: катать не по чему.
 */
function rerollSlots(reg: ConfigRegistry, item: Item): ReturnType<typeof affixSlotsFor> | null {
  const rDef = reg.get('rarities').find((r) => r.id === item.rarity);
  if (!rDef) return null;
  return item.affixCap
    ? affixSlotsFor(rDef, item.affixCap)
    : { minAffixes: rDef.minAffixes, maxAffixes: rDef.maxAffixes, maxPrefix: rDef.maxPrefix, maxSuffix: rDef.maxSuffix };
}

/**
 * МОЖНО ЛИ ПЕРЕКАТИТЬ — ОДИН ответ для карточки верстака и для отказа сервера (как `canSalvageItem`): если
 * развести их по двум местам, карточка будет предлагать то, что сервер отклонит, — или брать деньги за ничто.
 */
export function canRerollItem(reg: ConfigRegistry, item: Item): ActionResult {
  if (item.broken) return { ok: false, reason: 'Сперва почини' };
  // ⚠ ПРЕДЕЛ ПЕРЕКАТОК. Подъём тира ограничен потолком базы сам по себе, а перекатка крутит
  // случайность: без предела её жмут, пока не выпадет идеал, и редкость аффиксов перестаёт
  // что-либо значить. Считаем потраченное, чтобы отсутствие поля значило «ни разу».
  const limit = reg.get('balance').forgePrices.rerollLimit;
  if ((item.rerolls ?? 0) >= limit) return { ok: false, reason: 'Эту вещь перекатывать больше нельзя' };
  // ⚠ R2-13: у уникальной свойства СВОИ (`fixedAffixes`) — бросок по редкости стёр бы их за деньги; у обычной
  // слотов ноль — перекатка брала золото, катала пустоту и тратила перекатку, которую скованная вещь потом
  // уносила в зачарование (осталось бы 2 из 3). Отказ до платы.
  if (item.rarity === 'unique') return { ok: false, reason: 'Уникальные вещи не перекатываются' };
  const slots = rerollSlots(reg, item);
  if (!slots || Math.min(slots.maxAffixes, slots.maxPrefix + slots.maxSuffix) <= 0) {
    return { ok: false, reason: item.rarity === 'normal' ? 'У обычной вещи нечего перекатывать' : 'Этой вещи нечего перекатывать' };
  }
  // У скованной вещи форма ОПЛАЧЕНА (§6.3): пул, который её не наберёт, — отказ до платы, как у зачарования.
  if (item.affixCap && !enchantSlots(reg, item, item.rarity)?.fillable) {
    return { ok: false, reason: 'Кузнецу не хватит свойств на форму этой вещи' };
  }
  // ⚠ R17-03: у катаемой формы нет цены (хозяин опустил ёмкость и убрал её строку) — отказ до платы, а не перекатка по ×1.
  if (rolledFormMult(reg, item, item.rarity) === undefined) return { ok: false, reason: FORM_UNPRICED };
  return { ok: true };
}

/**
 * ⭐ ЭССЕНЦИЯ ПЕРЕКАТКИ — словарём сырья (`essenceMaterials`, §6.2): половина зачарования до редкости вещи. Одна функция для карточки
 * верстака (строка «Чародейская эссенция N (есть M)», согласие `maxMaterials`) и сервера.
 */
export function rerollMaterials(reg: ConfigRegistry, item: Item): MaterialCost {
  return essenceMaterials(reg, item, item.rarity, 'reroll');
}

/** ⭐ ЭССЕНЦИЯ ЗАЧАРОВАНИЯ до `rarity` — словарём сырья (`essenceMaterials`, §6.2). Одна функция для карточки, окна ковки и сервера. */
export function enchantMaterials(reg: ConfigRegistry, item: Item, rarity: Rarity): MaterialCost {
  return essenceMaterials(reg, item, rarity, 'enchant');
}

/**
 * Реролл аффиксов: заново катит столько же аффиксов из пула (rng — от вызывающего). Цена — `forgeGold`
 * (`forgePrices.rerollAffix`, у скованной × M формы) и ЭССЕНЦИЯ (`rerollMaterials`, §6.2) — из сумки, недостающее из кошелька сундука
 * (`wallet`; на сервере — транзакция сундука). Все отказы — `canRerollItem`, цена (`maxGold`, `maxMaterials` — R5-15, R8-14), золото и
 * эссенция, — до платы.
 */
export function forgeReroll(
  reg: ConfigRegistry, save: SaveState, uid: string, rng: Rng, maxGold?: number, wallet: MaterialWallet = {}, maxMaterials?: Record<string, number>,
): ActionResult {
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  const can = canRerollItem(reg, item);
  if (!can.ok) return can;
  const slots = rerollSlots(reg, item)!;   // `canRerollItem` уже отказал бы без редкости
  const cost = forgeGold(reg, item, 'reroll');
  const mats = rerollMaterials(reg, item);
  const raised = priceRaised(cost, maxGold) ?? materialsRaised(reg, mats, maxMaterials);   // R5-15, R8-14
  if (raised) return raised;
  if (save.gold < cost) return { ok: false, reason: 'Недостаточно золота' };
  if (!canAffordBoth(save.inventory, wallet, mats)) {
    return { ok: false, reason: `Не хватает материалов: ${describeCost(reg, missingForBoth(save.inventory, wallet, mats))}` };
  }
  save.gold -= cost;
  spendBoth(save.inventory, wallet, mats);
  item.rerolls = (item.rerolls ?? 0) + 1;
  item.affixes = rollAffixes(
    reg.get('affixes'),
    { kind: item.kind ?? '', slot: item.slot, attackType: item.attackType, damageKind: item.damageKind },
    item.rarity, slots, item.itemLevel, rng);
  return { ok: true };
}

/**
 * ⭐ РАЗБОР У КУЗНЕЦА — полный выход (docs/ECONOMY.md Ч3, docs/CRAFT_WEAPONS.md §10.9, §12, §16; предложение «Разбор, сырьё и чары»).
 * Что делать, решает сама вещь (`salvagePlan`):
 * - СКОВАННАЯ — переплавка (`meltReturn`): доля заплаченного, без эссенции;
 * - ОРУЖИЕ — сырьё семей его деталей, сорт — по рецепту ступени вещи (`craftSalvageYield`, `salvageGrades`);
 * - броня, щит, украшение — по правилу (`salvage-rules`), нижний сорт рецепта ступени;
 * - найденное и награда магической или редкой редкости — ещё ЭССЕНЦИЯ (`balance.salvage.essence`);
 * - СТАРТОВЫЙ НАБОР — только каталог, без сырья (R3-04: он бесплатен и бесконечен); нового в каталоге нет — отказ с причиной;
 * - уникальное — отказ (выключатель `uniqueSalvage`).
 * ⭐ ЛЮБАЯ разобранная у кузнеца вещь пополняет КАТАЛОГ (`salvageIntoJournal`, решение владельца D1): тип и детали оружия, кодекс,
 * снаряжение (`gearSeen`); жалость-эскиз — только находки. Итог — строки открытий (`unlocked`) и итоговая строка (`summary`: «Получено: …
 * · Каталог: …») — она есть ВСЕГДА, даже когда нового в каталоге нет: «разобрал, а ничего не добавилось» больше не бывает молча.
 * Сырьё кладётся в сумку, а что не влезло — в кошелёк сундука: у кузнеца сундук рядом, и потерять выход разбора из-за полной сумки было
 * бы нечестно. Поэтому действие идёт через сундук аккаунта (одной транзакцией на сервере).
 * ⚠ Все отказы — ДО разбора: он уничтожает вещь, и «правила нет» не должно съедать её впустую.
 */
export function forgeSalvage(
  reg: ConfigRegistry, save: SaveState, stash: AccountStash, uid: string, rng: SalvageRng, minYield?: Record<string, number>,
  avgYield?: Record<string, number>,
): ActionResult & { unlocked?: string[]; summary?: string } {
  const idx = save.inventory.findIndex((i) => i.uid === uid);
  if (idx < 0) return { ok: false, reason: 'Предмет не в инвентаре' };
  const item = save.inventory[idx]!;
  const out = salvageYield(reg, item, rng, false);
  if (!out.ok) return { ok: false, reason: out.reason };
  const dropped = yieldDropped(reg, item, false, minYield, avgYield);   // R8-14, R9-04: вилка верстака устарела — вещь цела
  if (dropped) return dropped;
  const unlock = salvageIntoJournal(reg, normalizeJournal(stash.forgeJournal), item);
  // Стартовый набор даёт только каталог (§9.3): нового нет — отказ ДО разбора, «разобрать и не получить ничего» нельзя.
  if (out.source === 'catalog' && !catalogGained(unlock)) return { ok: false, reason: STARTER_KNOWN };
  // ── Проверки позади: дальше только запись, отказать она уже не может ──
  save.inventory.splice(idx, 1);
  // Вещь уже снята с полки — место под сырьё освободилось, и оно почти всегда доливается в стек.
  const left = giveMaterialsTo(save.inventory, out.gains, reg.get('craft-materials'), dimsOf(reg), stackOf(reg), uuidv7);
  if (Object.keys(left).length) addToWallet(stash.materials ?? (stash.materials = {}), left);
  stash.forgeJournal = unlock.journal;
  return {
    ok: true,
    unlocked: unlockLabels(reg, unlock, item),
    summary: `Получено: ${describeCost(reg, out.gains) || 'сырья нет'} · Каталог: ${catalogLine(reg, item, unlock)}${unlock.sketch ? ' · Эскиз: деталь на выбор во вкладке «Ковка»' : ''}`,
  };
}

/** Отказ разбора стартового набора, из которого каталогу нечего взять (§9.3) — одна строка для сервера и карточки. */
export const STARTER_KNOWN = 'Всё из этой вещи уже в каталоге, а сырья стартовый набор не даёт — продай за 1';
/** Отказ разбора стартового набора в поле: сырья он не даёт, а каталог пишет только кузнец (решение D2). */
export const STARTER_FIELD = 'Стартовый набор сырья не даёт, а каталог пополняет только кузнец';

/** Добавил ли разбор в каталог хоть что-то: тип, деталь, кодекс, снаряжение. */
export function catalogGained(u: SalvageUnlock): boolean {
  return u.newBase || u.unlocked.length > 0 || !!u.newType || !!u.newGear;
}

/** Класс оружия словами для строки каталога: «меч» (`weapon-anatomy.name`), нет — id. */
function classLabel(reg: ConfigRegistry, cls: string): string {
  const name = reg.get('weapon-anatomy').find((a) => a.id === cls)?.name;
  return name ? name[0]!.toLowerCase() + name.slice(1) : cls;
}

/**
 * ⭐ СТРОКА КАТАЛОГА разбора у кузнеца (предложение §9.4) — по итогу журнала (`salvageIntoJournal`): что добавится и прогресс класса.
 * «+ тип «Длинный меч» · + деталь «Клинок с долом» (меч: 24 из 41)», «всё уже в каталоге (меч: 24 из 41)», «+ «Латы»», ««Латы» уже в
 * каталоге». Есть ВСЕГДА: после сотни разборов новое открывает меньше половины, и молчание читалось как «ничего не добавилось».
 */
export function catalogLine(reg: ConfigRegistry, item: Item, u: SalvageUnlock): string {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base) return 'кузнец такой вещи не знает';
  if (base.kind !== 'weapon') return u.newGear ? `+ «${base.name}»` : `«${base.name}» уже в каталоге`;
  const gains = [
    ...(u.newBase ? [`+ тип «${base.name}»`] : []),
    ...u.unlocked.map((id) => `+ деталь «${partById(reg, id)?.name ?? id}»`),
    ...(u.newType ? [`+ кодекс «${typeOfItem(reg, item)?.name ?? u.newType}»`] : []),
  ];
  const p = catalogProgress(reg, u.journal, base.weaponClass);
  const tail = `(${classLabel(reg, base.weaponClass)}: ${p.known} из ${p.total})`;
  if (gains.length) return `${gains.join(' · ')} ${tail}`;
  return item.parts ? `все детали уже в каталоге ${tail}` : `всё из этой вещи уже в каталоге ${tail}`;
}

/** Что открыл разбор — строками для окна: «Тип «Длинный меч»», «Деталь «Широкий, XXII»», «Снаряжение «Латы»», «Эскиз…». */
function unlockLabels(reg: ConfigRegistry, u: SalvageUnlock, item: Item): string[] {
  const out: string[] = [];
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (u.newBase && base) out.push(`Тип «${base.name}»`);
  for (const id of u.unlocked) out.push(`Деталь «${partById(reg, id)?.name ?? id}»`);
  if (u.newType) out.push(`Кодекс: «${typeOfItem(reg, item)?.name ?? u.newType}»`);
  if (u.newGear && base) out.push(`Снаряжение «${base.name}»`);
  // R3-11: эскиз тратится во вкладке «Ковка» (`forgeSketch`) — строка говорит, где, а не обещает в пустоту.
  if (u.sketch) out.push('Эскиз: откроет закрытую деталь на выбор во вкладке «Ковка»');
  return out;
}

/**
 * РАЗБОР НА МЕСТЕ, прямо в подземелье: тот же выбор пути, что у кузницы, но выход — доля `balance.salvage.fieldYield` (сырьё И эссенция,
 * вероятностным округлением), а КАТАЛОГ НЕ ПОПОЛНЯЕТСЯ (решение владельца D2: «разбор в поле не пишет в каталог, а только часть ресурсов
 * даёт»): повод нести вещь домой — каталог и втрое больший выход у кузнеца. Ни верстака, ни возврата в город — выделил трофей и
 * переработал. Мира и позиции не требует, поэтому живёт здесь, рядом с кузнечным близнецом, а не в сессии.
 * ⚠ Сундука в поле нет: не влезшее в сумку сырьё пропало бы вместе с вещью. Поэтому сперва примерка на
 * копии сумки (`fieldSalvageFits`, по ЛУЧШЕМУ броску) — не влезает целиком, значит отказ, и вещь цела.
 */
export function fieldSalvage(
  reg: ConfigRegistry, save: SaveState, uid: string, rng: SalvageRng, minYield?: Record<string, number>, avgYield?: Record<string, number>,
): ActionResult & { summary?: string } {
  const idx = save.inventory.findIndex((i) => i.uid === uid);
  if (idx < 0) return { ok: false, reason: 'Предмет не в инвентаре' };
  const out = salvageYield(reg, save.inventory[idx]!, rng, true);
  if (!out.ok) return { ok: false, reason: out.reason };
  const dropped = yieldDropped(reg, save.inventory[idx]!, true, minYield, avgYield);   // R8-14, R9-04
  if (dropped) return dropped;
  if (!fieldSalvageFits(reg, save.inventory, save.inventory[idx]!)) return { ok: false, reason: FIELD_SALVAGE_FULL };
  save.inventory.splice(idx, 1);
  const left = giveMaterialsTo(save.inventory, out.gains, reg.get('craft-materials'), dimsOf(reg), stackOf(reg), uuidv7);
  // Не бывает: выпавший бросок не больше лучшего (поштучно, те же материалы), а лучший влез в ту же сумку. Бросок — чтобы
  // сервер откатил сейв, а не молча потерял сырьё.
  if (Object.keys(left).length) throw new Error('fieldSalvage: примерка разошлась с записью');
  return { ok: true, summary: `Получено: ${describeCost(reg, out.gains) || 'ничего'} · ${FIELD_NO_CATALOG}` };
}

/** Строка разбора в поле про каталог: его пополняет только кузнец (решение D2). */
export const FIELD_NO_CATALOG = 'каталог пополняет только разбор у кузнеца';

/** Отказ разбора в поле «сырьё не влезет» — одна строка для сервера и окна. */
export const FIELD_SALVAGE_FULL = 'Сумка полна: сырьё с разбора не поместится';

/**
 * ⭐ V-B3-04: ВЛЕЗЕТ ЛИ СЫРЬЁ РАЗБОРА В ПОЛЕ — примерка на копии сумки без самой вещи, ПО ЛУЧШЕМУ БРОСКУ (как отказ «ничего не дал
 * бы», R9-03). ОДИН ответ для `fieldSalvage` и меню инвентаря: раньше примерялся ВЫПАВШИЙ бросок, и та же вещь в той же сумке то
 * разбиралась, то нет, а меню («Разобрать здесь») броска не знает — оно предлагало разбор, и после двух вопросов о скованной вещи
 * сервер отказывал «Сумка полна». Лучший бросок поштучно не меньше любого выпавшего и из тех же материалов, поэтому влез он —
 * влезет и выпавший. Вещь не разбирается вовсе — `true`: отказ скажет `salvageYield` (`canSalvageItem`), место тут ни при чём.
 */
export function fieldSalvageFits(reg: ConfigRegistry, inventory: readonly Item[], item: Item): boolean {
  const best = salvageYield(reg, item, ROLL_HI, true);
  if (!best.ok) return true;
  const probe = bagCopy(inventory);
  const idx = probe.findIndex((i) => i.uid === item.uid);
  if (idx >= 0) probe.splice(idx, 1);
  return !Object.keys(giveMaterialsTo(probe, best.gains, reg.get('craft-materials'), dimsOf(reg), stackOf(reg), () => 'probe')).length;
}

/**
 * Откуда берётся выход разбора: переплавка скованного, детали оружия, правило (броня, щит, украшение, оружие без деталей кузнеца),
 * только каталог (стартовый набор у кузнеца — сырья нет).
 */
export type SalvageSource = 'melt' | 'parts' | 'rules' | 'catalog';

/**
 * Только ВКЛЮЧЁННЫЕ материалы. Неизвестный конфигу id положить некуда, и «выход» из него был бы враньём.
 * ⚠ R2-28: выключенный — «не падает и не участвует в рецептах» (`craftMaterialsSchema`), и разбор его тоже
 * не выдаёт: иначе «булат — позже» в редакторе не держал бы ничего, находки t5/t6 и переплавка клали бы его
 * в сумку и сундук, а лавка скупала бы поштучно. Правило то же, что у пути по правилу (`gradeId`) и у тел
 * монстров: ступень СПУСКАЕТСЯ до ближайшей включённой той же семьи; ниже нет ни одной — единицы пропадают.
 */
function knownOnly(reg: ConfigRegistry, gains: MaterialCost): MaterialCost {
  const mats = reg.get('craft-materials');
  const out: MaterialCost = {};
  for (const [id, n] of Object.entries(gains)) {
    if (!(n > 0) || !Number.isFinite(n)) continue;
    const def = mats.find((m) => m.id === id);
    const to = !def || def.enabled ? def
      : mats.filter((m) => m.enabled && m.family === def.family && m.tier < def.tier).sort((a, b) => b.tier - a.tier)[0];
    if (to) out[to.id] = (out[to.id] ?? 0) + Math.floor(n);
  }
  return out;
}

/**
 * ⭐ СКОЛЬКО ЭССЕНЦИИ ДАСТ РАЗБОР У КУЗНЕЦА: по редкости (`balance.salvage.essence`), и только у вещей из списка разрешённых
 * (`ESSENCE_ORIGINS` — находки и награды, `salvageFullOrigin`). Купленное, без происхождения, стартовое, поднятое до `bornTier` и
 * переплавка — ноль: эссенция не пишется в `craftPaid`, и «зачаровать → переплавить» её не возвращает.
 */
export function essenceOf(reg: ConfigRegistry, item: Item): number {
  if (item.parts || !salvageFullOrigin(item)) return 0;
  const n = (reg.get('balance').salvage.essence as Record<string, number>)[item.rarity] ?? 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * ПУТЬ РАЗБОРА — одно решение для кнопки, подсказки «что выйдет» и самого разбора. Уникальное — отказ (выключатель `uniqueSalvage`).
 * Стартовый набор — только каталог у кузнеца, в поле — отказ. Скованное — только переплавка: на путь по правилу ему нельзя (зачаровал до
 * редкой — и получил бы эссенцию из вещи, скованной из болотного). Оружие с деталями кузнеца — по деталям; если детали не вывести (база
 * ушла из конфига или вне ковки) — по правилу. Сорт — по рецепту ступени вещи (`salvageGrades`), эссенция — `essenceOf`.
 */
function salvagePlan(reg: ConfigRegistry, item: Item, inField: boolean):
  { ok: true; source: SalvageSource; base: MaterialCost; grade: number; essence: number } | { ok: false; reason: string } {
  const tuning = reg.get('balance').salvage;
  if (item.rarity === 'unique' && !tuning.uniqueSalvage) return { ok: false, reason: UNIQUE_NO_SALVAGE };
  // ⚠ R3-04: стартовый комплект бесплатен и бесконечен (создал героя → переложил → удалил): сырья с него нет никогда — только каталог у
  // кузнеца (решение D1). Продаётся он за 1 (`shopSellPrice`).
  if (freeKit(item)) return inField ? { ok: false, reason: STARTER_FIELD } : { ok: true, source: 'catalog', base: {}, grade: 1, essence: 0 };
  const field = (): boolean => !inField || tuning.fieldYield > 0;
  if (item.parts) {
    const base = knownOnly(reg, meltReturn(reg, item));
    if (!Object.keys(base).length) return { ok: false, reason: 'Переплавка ничего не дала бы' };
    return field() ? { ok: true, source: 'melt', base, grade: 1, essence: 0 } : { ok: false, reason: 'Разбор ничего не даст' };
  }
  const essence = essenceOf(reg, item);
  const byParts = knownOnly(reg, craftSalvageYield(reg, item));   // не оружие — пусто
  if (Object.keys(byParts).length) {
    return field() ? { ok: true, source: 'parts', base: byParts, grade: 1, essence } : { ok: false, reason: 'Разбор ничего не даст' };
  }
  const can = canSalvage(item, weaponClassOf(reg, item), reg.get('salvage-rules'), tuning, inField);
  return can.ok
    ? { ok: true, source: 'rules', base: {}, grade: salvageGrades(reg, item).low, essence }
    : { ok: false, reason: can.reason ?? 'Эту вещь не из чего разбирать' };
}

/** Доля от целого выхода с вероятностным округлением остатка (0.6 → шесть раз из десяти единица). */
function shareOf(full: MaterialCost, share: number, rng: SalvageRng): MaterialCost {
  const out: MaterialCost = {};
  for (const [id, n] of Object.entries(full)) {
    const raw = n * share;
    const whole = Math.floor(raw);
    const got = whole + (rng.chance(raw - whole) ? 1 : 0);
    if (got > 0) out[id] = got;
  }
  return out;
}

/**
 * Общий расчёт разбора для кузницы и поля: выбирает путь (`salvagePlan`), проверяет допустимость и
 * катает выход. Один шов — чтобы «что даст разбор» в подсказке и то, что реально начислится, не разошлись.
 */
export function salvageYield(
  reg: ConfigRegistry,
  item: Item,
  rng: SalvageRng,
  inField: boolean,
): ActionResult & { gains: Record<string, number>; source?: SalvageSource } {
  const plan = salvagePlan(reg, item, inField);
  if (!plan.ok) return { ok: false, reason: plan.reason, gains: {} };
  // Стартовый набор у кузнеца: сырья нет по правилу, а «нового в каталоге нет» решает журнал (`forgeSalvage`, `canSalvageItem`).
  if (plan.source === 'catalog') return { ok: true, gains: {}, source: plan.source };
  // ⚠ R9-03: «НИЧЕГО НЕ ДАЛ БЫ» — ПО ЛУЧШЕМУ БРОСКУ, А НЕ ПО ВЫПАВШЕМУ. Отказ решался после броска и оставлял вещь в сумке,
  // а повтор катал заново (`townRng()` на команду): пояс в поле (0.24–0.36 единицы) отказывал в 70 % бросков, и «жми, пока
  // не выйдет» давало ровно единицу вместо трети — правило «поле — 30 % от кузницы» не держалось (у кузнеца перчатки и пояс
  // так же поднимали выход на 11 %). Теперь отказ — только вещи, которой и лучший бросок не дал бы ничего; иначе пустой
  // бросок разбирает её в ничто — вилка «0–1» (`salvageRange`) ровно это и обещает.
  if (!Object.keys(rollSalvage(reg, item, plan, ROLL_HI, inField)).length) return { ok: false, reason: 'Разбор ничего не дал бы', gains: {} };
  return { ok: true, gains: rollSalvage(reg, item, plan, rng, inField), source: plan.source };
}

/** Бросок выхода по уже выбранному пути (`salvagePlan`). Пусто — бросок не дал ничего. Эссенция — последним броском. */
function rollSalvage(
  reg: ConfigRegistry, item: Item, plan: { source: SalvageSource; base: MaterialCost; grade: number; essence: number }, rng: SalvageRng,
  inField: boolean,
): MaterialCost {
  const tuning = reg.get('balance').salvage;
  if (plan.source === 'catalog') return {};
  const mats = reg.get('craft-materials');
  const out: MaterialCost = plan.source !== 'rules'
    ? (inField ? shareOf(plan.base, tuning.fieldYield, rng) : { ...plan.base })
    : knownOnly(reg, salvageFromItem(item, weaponClassOf(reg, item), reg.get('salvage-rules'), tuning, rng, {
      inField,
      grade: plan.grade,
      knownMaterial: (id) => mats.some((c) => c.id === id && c.enabled),
    }));
  if (plan.essence > 0) {
    const ess = knownOnly(reg, inField ? shareOf({ [ESSENCE_ID]: plan.essence }, tuning.fieldYield, rng) : { [ESSENCE_ID]: plan.essence });
    for (const [id, n] of Object.entries(ess)) out[id] = (out[id] ?? 0) + n;
  }
  return out;
}

/**
 * МОЖНО ЛИ РАЗОБРАТЬ — ОДИН ответ для кнопки в UI и для отказа сервера. Если развести их по
 * двум местам, кнопка будет предлагать то, что сервер отклоняет.
 * `journal` — журнал кузнеца аккаунта (кадр сундука): с ним стартовый набор, из которого каталогу нечего взять, получает отказ с причиной
 * ДО нажатия (§9.3). Без него (кадр не пришёл) — как прежде: отказ скажет сервер.
 */
export function canSalvageItem(reg: ConfigRegistry, item: Item, inField: boolean, journal?: CraftJournal | null): ActionResult {
  // R9-03: и отказ «ничего не дал бы» — тот же, что у разбора: по лучшему броску, от кубика не зависит.
  const hi = salvageYield(reg, item, ROLL_HI, inField);
  if (!hi.ok) return { ok: false, reason: hi.reason };
  if (hi.source === 'catalog' && journal !== undefined && !catalogGained(salvageIntoJournal(reg, normalizeJournal(journal ?? emptyJournal()), item))) {
    return { ok: false, reason: STARTER_KNOWN };
  }
  return { ok: true };
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

/**
 * МОЖНО ЛИ ПОЧИНИТЬ — ОДИН ответ для карточки верстака и для отказа сервера (как `canUpgradeItem`, `canRerollItem`).
 * Золото и сырьё — не здесь: их не хватает «пока», и карточка показывает это построчно.
 * ⚠ R7-19: УНИК КУЗНЕЦ НЕ ЧИНИТ — кузницу он не проходит вовсе (docs/ECONOMY.md §1: «Нашёл — носи как есть»), и цена сырья у него
 * пуста (`repairCost`): пустая — это ОТКАЗ, а не «бесплатно». Прежде `forgeRepair` на пустой цене проверку сырья пропускал, и
 * сломанный уник чинился за одно золото, когда редкий той же базы платил железом. Сломанным уник больше и не падает
 * (`GameSession.killMonster`), а сломанный из старого сейва цел на входе (`mendBrokenUniques`).
 * ⚠ R10-14: пустая цена — отказ и у НЕ-уника: всё сырьё главной семьи выключено в редакторе (конфиг, который R2-28/R6-22
 * поддерживают) — починка не берётся за одно золото.
 */
export function canRepairItem(reg: ConfigRegistry, item: Item): ActionResult {
  if (!item.broken) return { ok: false, reason: 'Вещь цела' };
  if (item.rarity === 'unique') return { ok: false, reason: 'Уникальную вещь кузнец не чинит' };
  if (!Object.keys(repairCost(reg, item)).length) return { ok: false, reason: 'Эту вещь кузнец не чинит' };
  return { ok: true };
}

/**
 * ⚠ R7-19: СЛОМАННЫЙ УНИК ИЗ СЕЙВА СТАРШЕ R7-19 — ЦЕЛ. Тогда трофей ломался без оглядки на редкость; теперь уник не чинится
 * (`canRepairItem`), не разбирается и сломанным не надевается — лежал бы мёртвым грузом. Снимаем флаг на загрузке: сейв —
 * `roomManager` (как раскладку сумки), сундук — `sanitizeStash`. Чинить было нечего: уник «носи как есть». Мутирует на месте,
 * возвращает, сколько вещей вылечено.
 */
export function mendBrokenUniques(items: Iterable<Item | null | undefined>): number {
  let n = 0;
  for (const it of items) if (it?.broken && it.rarity === 'unique') { delete it.broken; n++; }
  return n;
}

/**
 * ПОЧИНКА СЛОМАННОГО ТРОФЕЯ — золото + материалы (`repairCost`: расходник I сорта и главный сорт вещи по её ступени). После неё это
 * обычная вещь своего тира, её можно носить и улучшать. Все отказы вещи — `canRepairItem` (R7-19: уник — отказ), до платы.
 */
export function forgeRepair(reg: ConfigRegistry, save: SaveState, uid: string, wallet: MaterialWallet, maxGold?: number, maxMaterials?: Record<string, number>): ActionResult {
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  const can = canRepairItem(reg, item);
  if (!can.ok) return can;
  const gold = forgeGold(reg, item, 'repair');
  const mats = repairCost(reg, item);
  const raised = priceRaised(gold, maxGold) ?? materialsRaised(reg, mats, maxMaterials);   // R5-15, R8-14
  if (raised) return raised;
  if (save.gold < gold) return { ok: false, reason: 'Недостаточно золота' };
  // Цена сырья не пуста — пустую `canRepairItem` уже отказал (R7-19, R10-14): «бесплатно по сырью» не бывает.
  if (!canAffordBoth(save.inventory, wallet, mats)) {
    return { ok: false, reason: `Не хватает материалов: ${describeCost(reg, missingForBoth(save.inventory, wallet, mats))}` };
  }
  save.gold -= gold;
  spendBoth(save.inventory, wallet, mats);
  delete item.broken;
  return { ok: true };
}

// ── Ковка из деталей (docs/CRAFT_WEAPONS.md) ─────────────────────────────────
/**
 * ⭐ V-B3-03: ЛЯЖЕТ ЛИ СКОВАННАЯ ВЕЩЬ В СУМКУ — место ПОСЛЕ списания сырья (оно может освободить клетку), примеркой на копии.
 * ОДИН ответ для `craftAction` и кнопки «Ковать»: окно смотрело только на цену, и при полной сумке кнопка горела, а сервер
 * отказывал «Нет места в сумке». Сумка отдаёт сырьё первой, остаток — сундук (`spendBoth`); сколько в сундуке, сумке всё равно,
 * поэтому примерке он не нужен — только то, что сумка отдаст сама. Хватает ли сырья вообще, решает `craftMissing`, не здесь.
 */
export function craftFits(reg: ConfigRegistry, inventory: readonly Item[], materials: MaterialCost, item: Pick<Item, 'gridW' | 'gridH'>): boolean {
  const probe = bagCopy(inventory);
  const carried = carriedMaterials(probe);
  const fromBag: MaterialCost = {};
  for (const [id, n] of Object.entries(materials)) { const k = Math.min(n, carried[id] ?? 0); if (k > 0) fromBag[id] = k; }
  spendBoth(probe, {}, fromBag);
  return hasSpace(probe, item.gridW, item.gridH, dimsOf(reg));
}

/**
 * ⭐ СКОВАТЬ — авторитетно. Одно ядро на сервер, мост калькулятора и песочницу редактора: паритет по
 * построению, а не сверкой.
 *
 * Порядок железный: ВСЕ проверки чистые и идут до единой траты — ключ заявки, сама заявка
 * (`parseCraftInput`), детали, семейство, окна ступеней и журнал (`craftWeapon`), сырьё из сумки и
 * сундука, золото, место в сумке ПОСЛЕ списания (примерка на копии). Потом запись, которая отказать
 * уже не может. Бросок базы (`rng`) обязателен: без него `craftWeapon` отдал бы предпросмотр с вилкой.
 *
 * Повтор `nonce` — прежний ответ (uid той вещи) без единого изменения: повтор после обрыва связи не
 * скуёт вторую вещь и не спишет второй раз. Ключ пишется в сундук вместе с вещью и списанием — на
 * сервере это одна транзакция. Кодекс «сковал» (`typesForged`) ведёт ядро, а не хозяин окна.
 *
 * `fullJournal` — флаг разработчика (DM_CRAFT_FULL_JOURNAL; сервер передаёт его только вне продакшена,
 * `server/src/net/devFlags.ts`): ворота журнала открыты, но в сохранённый журнал это не пишется. `allowDisabledMaterials` — ТОЛЬКО песочница редактора; сервер его не передаёт.
 * `maxGold` — цена в золоте, которую показало окно ковки (R5-15, `priceRaised`), `maxMaterials` — его сырьё (R8-14,
 * `materialsRaised`); повтор ключа их не проверяет: он не платит.
 */
export function craftAction(
  reg: ConfigRegistry, save: SaveState, stash: AccountStash, nonce: unknown, input: unknown, rng: Rng,
  opts: { fullJournal?: boolean; allowDisabledMaterials?: boolean; maxGold?: number; maxMaterials?: Record<string, number> } = {},
): ActionResult & { uid?: string } {
  if (!isCraftNonce(nonce)) return { ok: false, reason: 'Неверный ключ заявки' };
  const seen = normalizeCraftNonces(stash.craftNonces).find((e) => e.n === nonce);
  if (seen) return { ok: true, uid: seen.uid };
  const parsed = parseCraftInput(reg, input);
  if (!parsed.ok) return parsed;
  const journal = normalizeJournal(stash.forgeJournal);
  const pv = craftWeapon(reg, parsed.input, {
    journal: opts.fullJournal ? fullJournal(reg) : journal,
    materialsOn: !opts.allowDisabledMaterials,
    rng,
  });
  if (!pv.ok || !pv.item || !pv.cost) return { ok: false, reason: pv.reason ?? 'Этого кузнец не скуёт' };
  const { item, cost } = pv;
  // R5-15, R8-14: окно показало другую цену (золото или сырьё) — отказ до траты.
  const raised = priceRaised(cost.gold, opts.maxGold) ?? materialsRaised(reg, cost.materials, opts.maxMaterials);
  if (raised) return raised;
  const wallet = stash.materials ?? {};
  const lack = craftMissing(availableMaterials(save.inventory, wallet), 0, cost).materials;
  const goldOk = Number.isFinite(save.gold) && save.gold >= cost.gold;
  if (Object.keys(lack).length || !goldOk) {
    const parts = [...(Object.keys(lack).length ? [describeCost(reg, lack)] : []), ...(goldOk ? [] : [`${cost.gold} золота`])];
    return { ok: false, reason: `Не хватает: ${parts.join(' · ')}` };
  }
  // Место — ПОСЛЕ списания: сырьё из сумки может освободить клетку, и игрок с полной сумкой сырья не
  // должен упираться в «нет места» ровно перед тем, ради чего его нёс. Меряем на копии (`craftFits` — ей же гасит «Ковать» окно).
  const dims = dimsOf(reg);
  if (!craftFits(reg, save.inventory, cost.materials, item)) return { ok: false, reason: 'Нет места в сумке' };

  // ── Проверки позади: дальше только запись, отказать она уже не может ──
  const w = stash.materials ?? (stash.materials = {});
  if (!spendBoth(save.inventory, w, cost.materials) || !addToInventory(save.inventory, item, dims)) {
    // Не бывает: та же сумка и тот же путь, что у примерки. Бросок — чтобы сервер откатил сейв целиком.
    throw new Error('craftAction: примерка разошлась с записью');
  }
  save.gold -= cost.gold;
  // Происхождение `craft` пишет сама сборка (`buildCraftShell`): счётчику мификов скованное не идёт.
  if (pv.type?.typeId && !journal.typesForged.includes(pv.type.typeId)) journal.typesForged.push(pv.type.typeId);
  stash.forgeJournal = journal;
  stash.craftNonces = [...normalizeCraftNonces(stash.craftNonces), { n: nonce, uid: item.uid }].slice(-CRAFT_NONCES_KEEP);
  return { ok: true, uid: item.uid };
}

/**
 * МОЖНО ЛИ ЗАЧАРОВАТЬ ВЕЩЬ — ОДИН ответ для карточки верстака и для отказа сервера (как `canRerollItem`, R3-09): если
 * развести их, карточка предлагала бы то, что сервер отклонит. Без золота и без места вещи (сумка): их проверяет
 * зовущий — сервер по сейву, верстак по своей сумке.
 */
export function canEnchantItem(reg: ConfigRegistry, item: Item, rarity: string): ActionResult {
  if (rarity !== 'magic' && rarity !== 'rare') return { ok: false, reason: 'Зачаровать можно до магической или редкой' };
  if (!item.parts) return { ok: false, reason: 'Зачаровать можно только скованную вещь' };
  if (item.rarity !== 'normal') return { ok: false, reason: 'Вещь уже зачарована' };
  if (item.broken) return { ok: false, reason: 'Сперва почини' };
  const fit = enchantSlots(reg, item, rarity);
  if (!fit) return { ok: false, reason: 'Кузнец не знает такой вещи' };
  if (Math.min(fit.slots.maxAffixes, fit.slots.maxPrefix + fit.slots.maxSuffix) <= 0) return { ok: false, reason: 'Этой вещи некуда принять свойства' };
  if (!fit.fillable) return { ok: false, reason: 'Кузнецу не хватит свойств на форму этой вещи' };
  // ⚠ R17-03: у катаемой формы нет цены — отказ до платы, а не зачарование по ×1 (цене самой бедной формы).
  if (rolledFormMult(reg, item, rarity) === undefined) return { ok: false, reason: FORM_UNPRICED };
  const cost = enchantCost(reg, item, rarity);
  if (!Number.isFinite(cost) || cost < 0) return { ok: false, reason: 'Кузнец не может назвать цену' };
  return { ok: true };
}

/**
 * ⭐ ЗАЧАРОВАТЬ скованную вещь до магической или редкой — за золото (`enchantCost`, §13) и ЭССЕНЦИЮ (`enchantMaterials`, §6.2: из сумки,
 * недостающее — из кошелька сундука `wallet`). Только СКОВАННАЯ (у найденной аффиксы уже выпали), только обычная, только из сумки, не
 * уникальная. Эссенция в `craftPaid` не пишется: «зачаровать → переплавить» её не возвращает.
 * ⚠ Отказ ДО оплаты, если пул аффиксов не наберёт оплаченную форму при любом броске (§17) или базы
 * нет в конфиге. Поверх — страховка: бросок делается до оплаты, и недобор тоже отказ.
 */
export function enchantAction(
  reg: ConfigRegistry, save: SaveState, uid: string, rarity: string, rng: Rng, maxGold?: number, wallet: MaterialWallet = {},
  maxMaterials?: Record<string, number>,
): ActionResult & { uid?: string } {
  if (rarity !== 'magic' && rarity !== 'rare') return { ok: false, reason: 'Зачаровать можно до магической или редкой' };
  const idx = typeof uid === 'string' ? save.inventory.findIndex((i) => i.uid === uid) : -1;
  const item = save.inventory[idx];
  if (!item) return { ok: false, reason: 'Предмет не в инвентаре' };
  const can = canEnchantItem(reg, item, rarity);
  if (!can.ok) return can;
  const cost = enchantCost(reg, item, rarity);
  const mats = enchantMaterials(reg, item, rarity);
  const raised = priceRaised(cost, maxGold) ?? materialsRaised(reg, mats, maxMaterials);   // R5-15, R8-14
  if (raised) return raised;
  if (!Number.isFinite(save.gold) || save.gold < cost) return { ok: false, reason: `Недостаточно золота: нужно ${cost}` };
  if (!canAffordBoth(save.inventory, wallet, mats)) {
    return { ok: false, reason: `Не хватает материалов: ${describeCost(reg, missingForBoth(save.inventory, wallet, mats))}` };
  }
  const next = enchantItem(reg, item, rarity, rng);
  if (!next) return { ok: false, reason: 'Кузнец не знает такой вещи' };
  const fit = enchantSlots(reg, item, rarity)!;
  if (new Set(next.affixes.map((a) => a.affixId)).size < fit.slots.minAffixes) return { ok: false, reason: 'Кузнецу не хватит свойств на форму этой вещи' };
  // ── Проверки позади ──
  save.gold -= cost;
  // Эссенция — из сумки и сундука. ⚠ Индекс вещи — ЗАНОВО по uid: `spendBoth` мог убрать из сумки опустевшую стопку эссенции.
  spendBoth(save.inventory, wallet, mats);
  const at = save.inventory.findIndex((i) => i.uid === item.uid);
  save.inventory[at >= 0 ? at : idx] = next;   // новый объект целиком: `enchantItem` исходную вещь не трогает
  return { ok: true, uid: next.uid };
}

/**
 * ⭐ ПОТРАТИТЬ ЭСКИЗ (R3-11, docs/CRAFT_WEAPONS.md §12): открыть в журнале аккаунта выбранную деталь. Эскиз — жалость
 * разбора (каждые `sketchAfter` разборов найденного оружия класса), и он режет хвост ожидания редкой детали. Раньше
 * эскизы копились, разбор их обещал («деталь на выбор»), а потратить было нечем — ни команды, ни окна.
 *
 * Можно ли — решает `sketchable` (ключевую форму НЕОТКРЫТОГО типа эскиз не открывает: типы открываются разбором;
 * выключенную деталь — тоже: ковать из неё нельзя, и эскиз пропал бы). Все отказы — ДО изменения журнала. Журнал
 * живёт в сундуке аккаунта, поэтому на сервере это транзакция сундука, как вся кузница.
 */
export function sketchAction(reg: ConfigRegistry, stash: AccountStash, variantId: unknown): ActionResult & { unlocked?: string[] } {
  const journal = normalizeJournal(stash.forgeJournal);
  if (journal.sketches <= 0) return { ok: false, reason: 'Эскизов нет' };
  const part = typeof variantId === 'string' ? partById(reg, variantId) : undefined;
  if (!part || typeof variantId !== 'string') return { ok: false, reason: 'Нет такой детали' };
  if (journal.variants.includes(variantId)) return { ok: false, reason: 'Эта деталь уже открыта' };
  if (!sketchable(reg, journal, variantId)) return { ok: false, reason: 'Эту деталь эскизом не открыть: её тип открывает только разбор' };
  // ── Проверки позади ──
  stash.forgeJournal = useSketch(reg, journal, variantId);
  return { ok: true, unlocked: [`Деталь «${part.name}»`] };
}

// ── Экипировка ───────────────────────────────────────────────────────────────
/**
 * ⭐ R11-02: ЧТО ВСТАНЕТ ВО ВТОРУЮ РУКУ — одно правило для ядра (`equip`) и пупсика (веб, эталон Unity): если развести их,
 * ячейка принимала бы то, что сервер отклонит (или надел бы не туда). Щит — под всё, кроме запирающего двуручника. Оружие
 * (дуал-вилд) — только одноручное и только к одноручному или пустой руке: полуторное одной рукой носят со ЩИТОМ (§25), и
 * полуторное во вторую руку не берут вовсе. Причина отказа — строкой; `null` — встанет.
 */
export function offhandRefusal(item: Item, main: Item | undefined): string | null {
  if ((main?.hands ?? 1) >= 2 && !main?.versatile) return 'Занято двумя руками';
  if (item.slot === 'offhand') return null;
  if (item.slot !== 'weapon') return 'Этот предмет не для этого слота';
  if ((item.hands ?? 1) >= 2) return 'Двуручное оружие во вторую руку не взять';
  if (isVersatile(main)) return 'Полуторное оружие одной рукой носят только со щитом';
  return null;
}

/** Что сделает `equip`, если все проверки пройдены: вещь, слот, что снимется (прежняя вещь, вторая рука, лишние колбы). */
interface EquipPlan { item: Item; slot: EquipSlot; idx: number; displaced: Item | undefined; need: Item[]; newBeltCap: number }

/**
 * Проверки `equip` — без записи: причина отказа строкой или план. ⭐ R16-08: их же спрашивает пупсик (`equipRefusal`) — раньше он
 * мерил требования, сняв с героя только вещь целевой ячейки, и пускал двуручник, которому хватало Силы лишь со щитом (щит снимается).
 */
function equipPlan(reg: ConfigRegistry, save: SaveState, uid: string, target?: 'offhand'): EquipPlan | string {
  const dims = dimsOf(reg);
  const item = save.inventory.find((i) => i.uid === uid);
  if (!item) return 'Предмет не в инвентаре';
  if (!item.slot) return 'Нельзя надеть';
  // ⚠ Сломанный трофей носить нельзя — сперва к кузнецу (или на разбор). Проверка ЗДЕСЬ, в одной
  // авторитетной точке экипировки: клиент её только дублирует подсказкой.
  if (item.broken) return 'Сломано — почини у кузнеца';
  if (target !== undefined && target !== 'offhand') return 'Нельзя надеть';
  const slot: EquipSlot = target ?? item.slot;
  if (slot === 'offhand') { const no = offhandRefusal(item, save.equipment.weapon); if (no) return no; }

  // ⭐ Полуторное оружие вторую руку НЕ запирает: со щитом оно просто переходит в одноручный хват
  // и теряет часть урона и темпа (`versatile.ts`). Настоящий двуручник — запирает, как и раньше.
  const twoH = slot === 'weapon' && (item.hands ?? 1) >= 2 && !item.versatile;
  const prev = save.equipment[slot];
  // Двуручник снимает вторую руку целиком; полуторный — только второе ОРУЖИЕ (R11-02): одной рукой его носят лишь со щитом.
  const off = save.equipment.offhand;
  const displaced = slot === 'weapon' && (twoH || (isVersatile(item) && off?.slot === 'weapon')) ? off : undefined;
  // ⚠ R4-08: требования — по тому, что будет надето ПОСЛЕ смены: уходящая вещь (и снятое со второй руки) своей
  // прибавкой больше не подпирает ни новую вещь, ни оставшиеся.
  const broken = wornBroken(save, save.attributes, equippedItems(save).filter((i) => i !== prev && i !== displaced).concat(item));
  if (broken) return broken === item ? 'Недостаточно атрибутов' : wornReason(broken);

  const need: Item[] = [];
  if (prev) need.push(prev);
  if (displaced) need.push(displaced);
  // Смена пояса на меньший: колбы КОМПАКТИМ под новую ёмкость (первые N остаются в поясе), а лишние
  // возвращаем в инвентарь. Иначе колбы сверх beltSlots висли в save.belt вне видимых слотов («лимбо»).
  const newBeltCap = slot === 'belt' ? (item.beltSlots ?? 0) : -1;
  if (slot === 'belt') { for (const c of save.belt.filter((x): x is Item => !!x).slice(newBeltCap)) need.push(c); }

  const idx = save.inventory.findIndex((i) => i.uid === uid);
  // ⚠ Место — под ВСЁ снятое РАЗОМ, примеркой на копии сумки (как у ковки и разбора): `hasSpace` по
  // одной вещи клетку не занимает, и каждая проверка шла по той же пустоте. Щит под двуручником и
  // колбы пояса влезали «поодиночке», а второй `addToInventory` молча не находил места — вещь пропадала.
  const probe = bagCopy(save.inventory);
  probe.splice(idx, 1);
  for (const it of need) if (!addToInventory(probe, { ...it }, dims)) return 'Нет места для снятого';
  return { item, slot, idx, displaced, need, newBeltCap };
}

/**
 * ⭐ R16-08: НАДЕНЕТ ЛИ СЕРВЕР — причина отказа `equip` строкой или `null`, без записи. Одно решение для ядра и пупсика (веб, эталон
 * Unity): пред-проверка пупсика снимала с героя только вещь целевой ячейки — а `equip` снимает и вторую руку под двуручником и держит
 * требования всего надетого (R4-08), и место под снятое. Двуручник, которому хватало Силы лишь со щитом, слетал с курсора, а сервер
 * отказывал молча для окна (строка — только в логе игры).
 */
export function equipRefusal(reg: ConfigRegistry, save: SaveState, uid: string, target?: 'offhand'): string | null {
  const plan = equipPlan(reg, save, uid, target);
  return typeof plan === 'string' ? plan : null;
}

/**
 * Надеть вещь из сумки. Без `target` — в её родной слот (меню «Надеть», кузница, Unity). ⭐ R11-02: `target: 'offhand'` —
 * во вторую руку (пупсик: вещь брошена на ячейку «Левая рука»); так одноручное оружие встаёт вторым (дуал-вилд). Раньше
 * цели не было: кинжал, брошенный в левую ячейку, менял меч в основной руке, а ветка «Парное оружие» не открывалась никогда.
 * Проверки — `equipPlan` (их же спрашивает пупсик, `equipRefusal`).
 */
export function equip(reg: ConfigRegistry, save: SaveState, uid: string, target?: 'offhand'): ActionResult {
  const plan = equipPlan(reg, save, uid, target);
  if (typeof plan === 'string') return { ok: false, reason: plan };
  const dims = dimsOf(reg);
  const { item, slot, idx, displaced, need, newBeltCap } = plan;

  // ── Проверки позади: дальше только запись ──
  save.inventory.splice(idx, 1);
  item.pos = null;
  save.equipment[slot] = item;
  if (displaced) delete save.equipment.offhand;
  if (slot === 'belt') { const kept = save.belt.filter((x): x is Item => !!x).slice(0, newBeltCap); save.belt = Array.from({ length: newBeltCap }, (_, i) => kept[i] ?? null); }
  // Не бывает: та же сумка и тот же порядок, что у примерки. Бросок — чтобы сервер откатил сейв, а не потерял вещь.
  for (const it of need) if (!addToInventory(save.inventory, it, dims)) throw new Error('equip: примерка разошлась с записью');
  return { ok: true };
}

export function unequip(reg: ConfigRegistry, save: SaveState, slot: string): ActionResult {
  const s = slot as EquipSlot;
  const it = save.equipment[s];
  if (!it) return { ok: false, reason: 'Слот пуст' };
  const broken = wornBroken(save, save.attributes, equippedItems(save).filter((i) => i !== it));   // R4-08
  if (broken) return { ok: false, reason: wornReason(broken) };
  const dims = dimsOf(reg);
  // Снятие пояса: ёмкость станет 0 → все колбы из пояса тоже уходят в инвентарь (иначе висли бы в лимбо).
  const beltPotions = s === 'belt' ? save.belt.filter((x): x is Item => !!x) : [];
  const need: Item[] = [it, ...beltPotions];
  // ⚠ Примерка ВСЕГО снятого на копии сумки (см. `equip`): поодиночке пояс и колбы влезали, вместе — нет.
  const probe = bagCopy(save.inventory);
  for (const n of need) if (!addToInventory(probe, { ...n }, dims)) return { ok: false, reason: 'Нет места' };
  delete save.equipment[s];
  if (s === 'belt') save.belt = [];
  for (const n of need) if (!addToInventory(save.inventory, n, dims)) throw new Error('unequip: примерка разошлась с записью');
  return { ok: true };
}

// ── Атрибуты / респек ─────────────────────────────────────────────────────────
/**
 * Вложить `n` очков в атрибут одной командой (R2-15). ⚠ Пачкой, а не по команде на очко: после сброса у
 * героя 40-го уровня ≈ 195 очков, и «OK — применить» слало 195 кадров разом — сервер рвал соединение по
 * потолку кадров (120) на 121-м. Всё или ничего: очков меньше `n` — отказ, ни одно не вложено.
 */
export function allocAttr(save: SaveState, attr: string, n = 1): ActionResult {
  if (!ATTRIBUTES.includes(attr as Attribute)) return { ok: false, reason: 'Неизвестный атрибут' };
  if (!Number.isSafeInteger(n) || n < 1) return { ok: false, reason: 'Неверное число очков' };
  if (save.unspentAttributePoints <= 0) return { ok: false, reason: 'Нет очков атрибутов' };
  if (save.unspentAttributePoints < n) return { ok: false, reason: `Очков атрибутов меньше: есть ${save.unspentAttributePoints}` };
  save.attributes[attr as Attribute] += n;
  save.unspentAttributePoints -= n;
  return { ok: true };
}

/**
 * ⚠ R18-07: К ЧЕМУ СБРОС СТАВИТ АТРИБУТЫ И СКОЛЬКО ВОЗВРАЩАЕТ — от старта, с которым герой создан (`save.startAttributes`), а не от
 * нынешней строки класса. Мерили от строки живого конфига: правка хозяина (живьём или деплоем) дарила старым героям очки — воин 10-го,
 * вложивший 45 в Силу, после «Сила 20→15, Ловкость 15→20» получал 50 и выходил со 115 против 110 у свежего; опущенный старт делал очки
 * базы свободными. Правка строки класса старых героев не догоняет и при сбросе (как кривая опыта — уровни, R9-05).
 * Сейв старше правки старта не помнит — старт по `legacyStartAttributes` (R19-01). Возврат целый.
 * ⭐ D2: сейву со стартом строка класса не нужна вовсе — возврат от живого конфига не зависит, и правка (строку убрали, id сменили) сброс не
 * запирает. `null` — только старта нет и вывести не из чего (класс неизвестен).
 */
function attrRespecPlan(reg: ConfigRegistry, save: SaveState): { base: Attributes; refund: number } | null {
  const base = save.startAttributes ? { ...save.startAttributes } : legacyStartAttributes(reg, save);
  if (!base) return null;
  let over = 0;
  for (const a of ATTRIBUTES) over += Math.max(0, save.attributes[a] - base[a]);
  return { base, refund: Math.floor(over) };
}

/**
 * ⚠ R19-01: СТАРТ СЕЙВА СТАРШЕ R18-07 (поля `startAttributes` нет — таких в базе все, кто создан до правки): по атрибуту не выше того, что
 * у героя есть, и не выше нынешней строки класса. Сброс ставит его и возвращает всё сверх — итог героя (Σ атрибутов + свободные) не меняет
 * НИКАКАЯ правка. Раньше возврат урезался очками, выданными уровнями по ЖИВОМУ `attributePointsPerLevel`, а сброс ставил саму строку и
 * записывал её стартом: «очков за уровень 5→4» — воин 10-го терял 9 вложенных, 50-го — 49 (и навсегда: старт записан); поднятая строка
 * (опечатка «Живучесть 20→80») — очки из воздуха, тоже навсегда. Строка, не менявшаяся с создания героя, — ровно его старт: честный
 * сброс прежний. Опущенная с тех пор строка отдаёт разницу свободными очками (итог тот же), поднятая оставляет вложенное до неё в базе.
 * Потому старт такому сейву пишет ещё и вход (`RoomManager.sanitize`) — по строке ДО любой будущей правки. Класс неизвестен — `null`.
 */
export function legacyStartAttributes(reg: ConfigRegistry, save: SaveState): Attributes | null {
  const row = reg.get('classes').find((c) => c.id === save.classId)?.startAttributes;
  if (!row) return null;
  const out = { ...row } as Attributes;
  for (const a of ATTRIBUTES) out[a] = Math.max(0, Math.min(Math.floor(save.attributes[a]), row[a]));
  return out;
}

/**
 * ⭐ D2: СКОЛЬКО ОЧКОВ У ГЕРОЯ ЕСТЬ — по пулам, вложенное + свободное. Атрибуты — сверх старта `start` и целым, ровно как их вернёт сброс
 * (`attrRespecPlan`); скилы и мастерство — Σ рангов (узел стоит очко за ранг, R6-17; сброс возвращает Σ рангов и за узлы, которых в
 * древе уже нет). От конфига не зависит ничего: выдачу не пересчитывает ни одна правка.
 */
export function pointsHeld(save: SaveState, start: Attributes): EarnedPoints {
  let over = 0;
  for (const a of ATTRIBUTES) over += Math.max(0, save.attributes[a] - start[a]);
  const ranks = (m: Record<string, number>): number => Object.values(m).reduce((n, r) => n + (r > 0 ? r : 0), 0);
  return {
    attributePoints: Math.floor(over) + save.unspentAttributePoints,
    skillPoints: ranks(save.skills) + save.unspentSkillPoints,
    masteryPoints: ranks(save.masteries) + save.unspentMasteryPoints,
  };
}

/**
 * ⭐ D2: ОДНОРАЗОВАЯ ДОПИСЬ СЕЙВА СТАРШЕ ПРАВИЛА «ПРАВКА КОНФИГА НЕ ЧЕКАНИТ И НЕ ОТНИМАЕТ ЗАРАБОТАННОЕ». Чего сейв не помнит — выводится
 * из того, что у героя ЕСТЬ, по конфигу этого мига, ОДИН раз, и дальше заморожено: старт (R19-01, `legacyStartAttributes` — не выше своих
 * атрибутов и нынешней строки класса) и книга заработанного (`save.earned` = `pointsHeld` от этого старта — итог героя не двигается).
 * Записанное не трогается никогда — правка хозяина после дописи до героя не доходит. Зовут вход (`RoomManager.sanitize` — до любой
 * будущей правки) и сброс атрибутов (он и так пишет старт). Класс неизвестен и старта нет — ничего (допишет следующий вход).
 * Возвращает, дописано ли что-нибудь.
 */
export function settleEarned(reg: ConfigRegistry, save: SaveState): boolean {
  let changed = false;
  if (!save.startAttributes) {
    const st = legacyStartAttributes(reg, save);
    if (st) { save.startAttributes = st; changed = true; }
  }
  if (!save.earned && save.startAttributes) { save.earned = pointsHeld(save, save.startAttributes); changed = true; }
  return changed;
}

/**
 * Сколько очков вернёт сброс атрибутов: вложенное сверх старта героя (`attrRespecPlan`, R18-07). Одно число для ядра (0 — отказ, R6-11)
 * и для кнопки («Сбросить» гаснет, когда сбрасывать нечего). Класс неизвестен — 0.
 */
export function attrRespecRefund(reg: ConfigRegistry, save: SaveState): number {
  return attrRespecPlan(reg, save)?.refund ?? 0;
}

/** Проверки `respec` без записи — причина отказа строкой или то, что сброс запишет (`respecRefusal` спрашивает то же). */
function respecPlan(reg: ConfigRegistry, save: SaveState, maxGold?: number): string | { base: Attributes; refunded: number; cost: number } {
  const plan = attrRespecPlan(reg, save);
  if (!plan) return 'Класс не найден';
  // ⚠ R6-11: СБРАСЫВАТЬ НЕЧЕГО — ОТКАЗ, как у скилов и мастерств. Раньше `respecCost` списывался всегда: второй клик
  // двойного клика платил за ничто, свежий герой — за пустое место.
  const refunded = plan.refund;
  if (refunded === 0) return 'Атрибуты не вложены';
  const cost = reg.get('balance').respecCost;
  const raised = priceRaised(cost, maxGold);   // R5-15
  if (raised) return raised.reason ?? PRICE_CHANGED;
  if (save.gold < cost) return 'Недостаточно золота';
  const base = plan.base;
  // ⚠ R4-08: надетое, что держится на вложенных очках, после сброса висело бы без опоры (очки ушли бы в другое).
  const broken = wornBroken(save, base, equippedItems(save));
  if (broken) return `После сброса не хватит атрибутов на «${broken.name}» — сперва сними её`;
  return { base, refunded, cost };
}

/**
 * ⭐ R19-07: СБРОСИТ ЛИ СЕРВЕР АТРИБУТЫ — причина отказа `respec` строкой или `null`, без записи, в том же порядке (класс, «не вложены», цена,
 * золото, надетое без опоры). Одно решение для ядра и кнопки «Сбросить атрибуты» мастера (веб, эталон Unity): кнопка смотрела только на возврат
 * и золото — герой, чьё надетое держится на вложенных очках, подтверждал сброс, а сервер отказывал «сперва сними её».
 */
export function respecRefusal(reg: ConfigRegistry, save: SaveState, maxGold?: number): string | null {
  const plan = respecPlan(reg, save, maxGold);
  return typeof plan === 'string' ? plan : null;
}

export function respec(reg: ConfigRegistry, save: SaveState, maxGold?: number): ActionResult {
  const plan = respecPlan(reg, save, maxGold);
  if (typeof plan === 'string') return { ok: false, reason: plan };
  const { base, refunded, cost } = plan;
  // ── Проверки позади (`respecPlan`): дальше только запись ──
  // ⭐ R8-10: мощь узла сверяет требования вещей запаса не ниже атрибутов до сброса — сброс их не прячет (`effectiveLevel`).
  const peak = { ...save.attributes };
  for (const a of ATTRIBUTES) peak[a] = Math.max(peak[a], save.respecPeak?.[a] ?? 0);
  save.respecPeak = peak;
  // ⭐ D2: сейв старше правила — дописать старт и книгу заработанного ДО переноса очков (итог тот же до и после сброса; старт — тот же `base`).
  settleEarned(reg, save);
  save.attributes = { ...base };
  // R18-07: сейв без старта с этой минуты его помнит — следующий сброс меряет от того, к чему сбросили (у прочих — тот же).
  save.startAttributes = { ...base };
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
 * ⚠ V-RF-03: гнёзда — КОПИЕЙ, выровненной под число открытых; в сейв их кладёт только успех (`socketsCommit`). Раньше выравнивание
 * писало в сейв здесь, до проверок вставки, и любой отказ («Вставка не открыта в дереве», «Гнездо и так пусто»…) менял сейв.
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
  const slots = [...(save.sockets?.[nodeId] ?? [])];
  while (slots.length < open) slots.push(null);   // выравниваем под число открытых гнёзд
  return { ok: true, slots };
}
/** Успех «вставить/вынуть» — гнёзда узла в сейв (V-RF-03: только здесь, после всех проверок). */
function socketsCommit(save: SaveState, nodeId: string, slots: (string | null)[]): void {
  (save.sockets ??= {})[nodeId] = slots;
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
  socketsCommit(save, nodeId, t.slots);
  return { ok: true };
}

/** ВЫНУТЬ вставку из гнезда. Без пошлины: вставка открыта деревом и не тратится — терять нечего. */
export function socketClear(reg: ConfigRegistry, save: SaveState, nodeId: string, slot: number): ActionResult {
  const t = socketTarget(reg, save, nodeId, slot);
  if (!t.ok) return { ok: false, reason: t.reason };
  if (!t.slots[slot]) return { ok: false, reason: 'Гнездо и так пусто' };
  t.slots[slot] = null;
  socketsCommit(save, nodeId, t.slots);
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
export function respecSkills(reg: ConfigRegistry, save: SaveState, maxGold?: number): ActionResult {
  let ranks = 0;
  for (const rank of Object.values(save.skills)) if (rank > 0) ranks += rank;
  if (ranks === 0) return { ok: false, reason: 'Скиллы не вложены' };
  const fee = skillRespecFee(reg, save);
  const raised = priceRaised(fee, maxGold);   // R5-15
  if (raised) return raised;
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
 *
 * ⚠ R3-02: привязать можно ТОЛЬКО то, что предлагает панель биндов (веб и Unity): пусто, базовую атаку или
 * активный узел древа, в который вложен хотя бы ранг. Раньше в сейв ложилась ЛЮБАЯ строка — и `"x\u0000"`, которую
 * Postgres в jsonb не принимает: каждая следующая запись героя падала, он играл из памяти, а рестарт откатывал его к
 * сейву до бинда (дюп через соседа по аккаунту, откат неудачных бросков). Оружие здесь не проверяем: бинд переживает
 * смену оружия, и панель лишь гасит скилл, который с этим оружием не кастуется.
 */
export function setBinding(reg: ConfigRegistry, save: SaveState, slot: number, value: string | null): ActionResult {
  if (value !== null && value !== 'attack') {
    const node = reg.get('skill-tree').nodes.find((n) => n.id === value);
    if (!node?.effect.active || !((save.skills[value] ?? 0) > 0)) return { ok: false, reason: 'Этот скилл не выучен' };
  }
  if (slot === 0) save.mouseLeft = value;
  else if (slot === 1) save.mouseRight = value;
  else if (slot >= 2 && slot <= 4) {
    while (save.hotbar.length < 3) save.hotbar.push(null);
    save.hotbar[slot - 2] = value;
  } else return { ok: false, reason: 'Неверный слот бинда' };
  return { ok: true };
}

/**
 * Кладёт расходник из инвентаря в первый свободный слот пояса (ёмкость — beltSlots надетого пояса).
 *
 * ⚠ V-B2-01: сначала ВСЕ проверки, сейв — только на успехе. Пояс добивался пустыми ячейками до ёмкости ДО проверок, и отказ
 * («Предмет не в инвентаре», «Не расходник», «Пояс полон») менял сейв: `[]` → `[null,null,null,null]`, а `moveBelt` без
 * отката — автосейв писал это в базу. Недостающие хвостовые ячейки (пояс короче ёмкости) — свободные; ячейка за ёмкостью —
 * не место (колба там висела бы «в лимбо», вне видимых слотов).
 */
export function moveToBelt(save: SaveState, uid: string): ActionResult {
  const cap = save.equipment.belt?.beltSlots ?? 0;
  if (cap <= 0) return { ok: false, reason: 'Пояс не надет' };
  const idx = save.inventory.findIndex((i) => i.uid === uid);
  if (idx < 0) return { ok: false, reason: 'Предмет не в инвентаре' };
  if (save.inventory[idx]!.kind !== 'consumable') return { ok: false, reason: 'Не расходник' };
  let slot = -1;
  for (let i = 0; i < cap && slot < 0; i++) if (!save.belt[i]) slot = i;
  if (slot < 0) return { ok: false, reason: 'Пояс полон' };
  while (save.belt.length < cap) save.belt.push(null);
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

export function allocPassive(reg: ConfigRegistry, save: SaveState, nodeId: string, maxGold?: number): ActionResult {
  const tree = reg.get('mastery-tree');
  const node = tree.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: 'Узел не найден' };
  const rank = save.masteries[nodeId] ?? 0;
  if (rank >= node.maxRank) return { ok: false, reason: 'Максимальный ранг' };
  // ⚠ R10-11: «Треб. уровень» редактора — как у древа скилов (`allocActive`). Не смотрели вовсе: узел, закрытый до 60-го
  // уровня, брал герой 2-го с очком мастерства и золотом.
  if (save.level < node.levelReq) return { ok: false, reason: `Требуется уровень ${node.levelReq}` };
  // Вход доступен только своему классу; прочее — по смежности (переходы дают край соседней ветви).
  const entries = passiveEntriesFor(reg, save);
  const allocatable = rank > 0 || entries.includes(nodeId)
    || passiveNeighbors(tree, nodeId).some((n) => (save.masteries[n] ?? 0) > 0);
  if (!allocatable) return { ok: false, reason: 'Недоступный вход или нет смежного узла' };
  if (node.cost.type !== 'gold') return { ok: false, reason: 'Неверный тип стоимости' };
  if (save.unspentMasteryPoints < 1) return { ok: false, reason: 'Нет очков мастерства' };
  const mult = reg.get('balance').passiveRankCostMult;
  const cost = Math.round(node.cost.amount * Math.pow(mult, rank));
  const raised = priceRaised(cost, maxGold);   // R6-16: «след. ранг: N зол.» карточки — дороже сервер не возьмёт
  if (raised) return raised;
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
export function respecPassives(reg: ConfigRegistry, save: SaveState, maxGold?: number): ActionResult {
  let ranks = 0;
  for (const rank of Object.values(save.masteries)) if (rank > 0) ranks += rank;
  if (ranks === 0) return { ok: false, reason: 'Мастерства не вложены' };
  const fee = passiveRespecFee(reg, save);
  const raised = priceRaised(fee, maxGold);   // R5-15
  if (raised) return raised;
  if (save.gold < fee) return { ok: false, reason: `Нужно ${fee} золота на сброс` };
  save.gold -= fee;
  save.unspentMasteryPoints += ranks;
  save.masteries = {};
  return { ok: true };
}
