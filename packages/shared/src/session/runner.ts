import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import { createRng } from '../formulas/rng.js';
import { effectiveLevel } from '../formulas/power.js';
import { newDebuffState } from '../world/debuffs.js';
import { Cell } from '../world/grid.js';
import type { PlayerEntity } from '../world/state.js';
import { generateFloor } from '../dungeon/generateFloor.js';
import { resolveMonsterPool } from '../dungeon/floorSpec.js';
import { spawnPacksEl } from '../dungeon/floor.js';
import { townLayout } from '../dungeon/town.js';
import { generateRunPlan } from '../dungeon/run/generateRunPlan.js';
import type { RunConfig, RunNode, RunPlan } from '../dungeon/run/types.js';
import type { DungeonLayout } from '../dungeon/floorCommon.js';
import { applyDeathPenalty } from '../economy/death.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import type { Item } from '../types/items.js';
import { newBotSave, classProfileAttr, allocateAttributes } from '../sim/playerBot.js';
import { considerDrop, visitShop, visitForge, allocateSkillsAndPassives, weaponDps, type FieldCarry } from '../sim/economy.js';
import type { BuildPolicy } from '../sim/types.js';
import { emptyStash, sanitizeStash } from '../economy/stashActions.js';
import { availableMaterials, materialItem } from '../economy/materials.js';
import { normalizeJournal } from '../formulas/craft.js';
import { shopBuyPrice, shopSellPrice, SHOP_CONSUMABLE_STOCK, shopConsumableIds } from '../economy/townActions.js';
import type { AccountStash } from '../types/stash.js';
import { GameSession, type SessionEvent } from './session.js';
import { BotController, type BotTier, type BotStyle } from './bot.js';
import { playerSnapshot } from './derive.js';
import { buildSnapshot, type RunReport, type CurvePoint } from './stats.js';

/**
 * Полный прогон «сим = игра = сервер»: бот ведёт настоящий `GameSession` по РЕАЛЬНОМУ забегу v2
 * (тот же путь, что `Room`): RunConfig → `generateRunPlan` (ветвящийся граф) → по узлам
 * `generateFloor` + `resolveMonsterPool` + `spawnPacksEl` (пул/глубина/плотность узла) → бой реальным
 * ядром → лут/очки/магазин → смерть (`applyDeathPenalty`) → город/новый забег. Тик 30 Гц как сервер.
 * Собирает `RunReport` (финальный билд + статы + кривая). Все сиды — из `settings.seed` (детерминизм).
 *
 * ОГРАНИЧЕНИЕ (снимется в Ф3 «реализм бота»): бот не дёргает рычаги → двери этажа открываем заранее
 * (замок — навигационный гиммик, не ось баланса); спуск по узлам программный (бот ещё не идёт к выходу);
 * магазин/распределение очков — пока эвристики sim/economy (авторитетные townActions — Ф2b).
 *
 * ⭐ КОВКА (K7): с `craft` бот несёт найденное оружие кузнецу, разбирает его там (журнал — на «аккаунте»
 * прогона, `stash`), куёт лучшее доступное и зачаровывает — всё АВТОРИТЕТНЫМИ действиями игры. Броски
 * кузницы идут своим потоком: мировые броски (планы забегов, лавка) у прогона с ковкой и без неё одни и те
 * же, и расходятся прогоны только там, где ковка изменила самого героя. ⚠ Один сид — это ОДНА траектория:
 * смерть в одном прогоне и её отсутствие в другом разводят их дальше, поэтому сравнивать — по нескольким сидам.
 */
export interface SessionSimSettings {
  classId: string;
  difficultyId: string;
  seed: number;
  /** Гнать до этого уровня персонажа. */
  targetLevel: number;
  /** Потолок сим-часов игрового времени. */
  maxHours: number;
  build: BuildPolicy;
  /** Шаг тика, сек (по умолчанию 1/30 — как серверный TICK_DT). */
  dt?: number;
  /** Потолок времени на этаж, сек (анти-залипание). */
  floorTimeCapSec?: number;
  /** Стоп после стольких смертей. */
  maxDeaths?: number;
  /** Время на один поход в город (телепорт+лечёж+магазин+возврат), сек. */
  townTripSec?: number;
  /** Уровень мастерства бота (basic|kite|potions|rotation). По умолчанию rotation. */
  botTier?: BotTier;
  /** Стиль прохождения этажа (clear|balanced|rush). По умолчанию balanced. */
  botStyle?: BotStyle;
  /** Ковка открыта. По умолчанию — как в игре (`balance.craft.live`). Сравнение «до/после» — два прогона. */
  craft?: boolean;
  /** Флаг разработчика «полный журнал» (как `DM_CRAFT_FULL_JOURNAL`): замер ковки без петли открытия. */
  fullJournal?: boolean;
  /** Стартовый сундук аккаунта (сырьё, журнал) — например, настоящий из базы. Нет — пустой, как у нового. */
  stash?: AccountStash;
  /** Стартовый сейв (копируется). Нет — новый бот класса `classId`. */
  save?: SaveState;
}

/** Бюджет клеток сумки под ношу к кузнецу: четверть сумки, остальное — под добычу и сырьё (иначе бот встаёт над лутом). */
const carryCellsOf = (reg: ConfigRegistry): number => Math.floor((reg.get('balance').inventory.cols * reg.get('balance').inventory.rows) / 4);

/** Откуда пришла новая вещь в руке — для разноса прироста силы оружия (§22 «сковал против нашёл»). */
type PowerSource = 'found' | 'shop' | 'craft' | 'upgrade';

function reviveFull(p: PlayerEntity, save: SaveState, reg: ConfigRegistry): void {
  const snap = playerSnapshot(save, reg);
  p.hp = snap.derived.maxHp;
  p.mana = snap.derived.maxMana;
  p.stamina = snap.derived.maxStamina;
  p.debuffs = newDebuffState();
  p.alive = true;
}

/** Свежий сид на каждый новый забег (номер забега мешаем в базовый сид — детерминированно). */
function runSeedOf(base: number, idx: number): number {
  return ((base ^ ((idx + 1) * 0x9e3779b1)) >>> 0) || 1;
}

/** RunConfig сима: первый включённый биом/шаблон + тир; сид — из settings (не Date.now, как на сервере). */
function buildRunConfig(reg: ConfigRegistry, difficultyId: string, seed: number): RunConfig {
  const biomes = reg.get('biomes').filter((b) => b.enabled !== false);
  const tpls = reg.get('run-templates').filter((t) => t.enabled !== false);
  const biome = biomes[0] ?? reg.get('biomes')[0]!;
  const tpl = tpls[0] ?? reg.get('run-templates')[0];
  return { templateId: tpl?.id ?? 'default', biomeId: biome.id, tier: difficultyId, seed, modifiers: [] };
}

/** Открывает все двери этажа (бот не дёргает рычаги до Ф3) — этаж полностью проходим. */
function openDoors(layout: DungeonLayout): void {
  for (const d of layout.doors) for (const c of d.cells) { const row = layout.grid[c.cy]; if (row) row[c.cx] = Cell.Floor; }
}

/** Материалы по ступеням: для баланса важна ступень, а не пятнадцать отдельных id. */
function tierSums(reg: ConfigRegistry, mats: Record<string, number>): Record<string, number> {
  const defs = reg.get('craft-materials');
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(mats)) {
    const t = defs.find((d) => d.id === id)?.tier;
    const key = t ? `ступень ${t}` : 'прочее';
    out[key] = (out[key] ?? 0) + n;
  }
  return out;
}

/**
 * СЫРЬЁ В ЦЕНАХ ЛАВКИ (R3-20): сколько золота дала бы сдача этих единиц полными стеками сумки — той же
 * `shopSellPrice`, что у сервера на `sell` (поштучно). Бот сырьё не продаёт, и без этой мерки отчёт не видел крана.
 */
function sellWorth(reg: ConfigRegistry, mats: Record<string, number>): number {
  const defs = reg.get('craft-materials');
  const stack = Math.max(1, reg.get('balance').inventory.materialStack);
  let sum = 0;
  for (const [id, n] of Object.entries(mats)) {
    const def = defs.find((d) => d.id === id);
    if (!def || !Number.isFinite(n) || n < 1) continue;
    const full = Math.floor(Math.floor(n) / stack), rest = Math.floor(n) - full * stack;
    if (full > 0) sum += full * shopSellPrice(reg, materialItem(def, stack, id));
    if (rest > 0) sum += shopSellPrice(reg, materialItem(def, rest, id));
  }
  return sum;
}

/**
 * Пополняет пояс бота лечебными зельями (у реального игрока пояс всегда полон перед вылазкой) — ПОКУПКОЙ в лавке, как
 * игрок (R2-04): недостающее до шести, сперва лечебные, кончились на прилавке (`SHOP_CONSUMABLE_STOCK` за заход) —
 * малые; не хватает золота — сколько хватит. Раньше бот получал шесть зелий даром на каждой остановке, и прогон
 * баланса не видел этой траты вовсе. ⭐ R11-13: только зелья, которые лавка продаёт (`shopConsumableIds`: выключенная в редакторе
 * база не продаётся) — раньше бот покупал и выключенное. Возвращает потраченное золото.
 */
export function stockBeltFromShop(reg: ConfigRegistry, save: SaveState): number {
  const itemsBase = reg.get('items.base');
  const sold = new Set(shopConsumableIds(reg));
  const belt = Array.from({ length: 6 }, (_, i) => save.belt[i] ?? null);
  const left: Record<string, number> = {};
  for (const id of ['healing-potion', 'minor-healing-potion']) if (sold.has(id)) left[id] = SHOP_CONSUMABLE_STOCK;
  let spent = 0;
  for (let i = 0; i < belt.length; i++) {
    if (belt[i]) continue;
    const id = Object.keys(left).find((k) => left[k]! > 0);
    const potion = id ? itemFromBaseId(itemsBase, id, undefined, 'shop') : null;
    if (!id || !potion) break;
    const price = shopBuyPrice(reg, potion);
    if (save.gold < price) break;
    save.gold -= price; spent += price; left[id]!--;
    belt[i] = potion;
  }
  save.belt = belt;
  return spent;
}

export function runSessionSim(reg: ConfigRegistry, settings: SessionSimSettings): RunReport {
  const dt = settings.dt ?? 1 / 30;
  const floorCap = settings.floorTimeCapSec ?? 240;
  const maxDeaths = settings.maxDeaths ?? 60;
  const townTripSec = settings.townTripSec ?? 45;
  const rng = createRng((settings.seed >>> 0) || 1);
  const powerCfg = reg.get('balance').power;
  const tiers = reg.get('item-tiers');   // R12-09: мощь — и по ступени вещей, как у сервера
  const deathPenalty = reg.get('balance').deathPenalty;
  const prefabs = reg.get('room-prefabs');
  const biomes = reg.get('biomes');

  const save = settings.save ? structuredClone(settings.save) : newBotSave(reg, settings.classId);
  const profile = classProfileAttr(reg, settings.classId);
  const session = new GameSession(reg, settings.seed, settings.difficultyId);
  const p = session.addPlayer('p1', save);
  const bot = new BotController(reg, settings.botTier ?? 'rotation', settings.botStyle ?? 'balanced');

  let totalTime = 0;
  let kills = 0;
  let deaths = 0;
  let gold = 0;
  let goldSold = 0;
  let goldSpent = 0;
  let itemsBought = 0;
  let items = 0;
  let xp = 0;
  const lootByType: Record<string, number> = {};
  const lootByRarity: Record<string, number> = {};
  const lootBySlot: Record<string, number> = {};
  const materials: Record<string, number> = {};
  let fromMonsters = 0;
  let fromChests = 0;
  let brokenItems = 0;
  let chestsOpened = 0;
  let matsGained = 0;   // единиц материалов с РАЗБОРА в поле (с монстров считается по событиям)
  let repaired = 0;
  let upgraded = 0;
  let goldOnPassives = 0;
  /**
   * Сундук аккаунта в симе: сырьё сдаётся сюда в городе и отсюда же тратится кузницей; здесь же журнал
   * кузнеца. Копия — чтобы прогон не правил чужой объект (сундук из базы, общий для сравнения).
   */
  const stash: AccountStash = settings.stash ? sanitizeStash(reg, structuredClone(settings.stash)) : emptyStash(reg);
  const craftOn = settings.craft ?? reg.get('balance').craft.live;
  const forgeRng = createRng(((settings.seed ^ 0x6b1d5ed) >>> 0) || 1);
  let nonceSeq = 0;
  const units = (): number => Object.values(availableMaterials(save.inventory, stash.materials ?? {})).reduce((a, b) => a + b, 0);
  const matsStart = units();
  // Ковка (K7): счётчики, поток сырья и прирост силы оружия по источникам.
  let crafted = 0, enchanted = 0, meltedForge = 0, meltedField = 0, salvagedForge = 0, salvagedField = 0, unlocked = 0;
  let goldCraft = 0, goldEnchant = 0, matsForge = 0, matsMelt = 0, matsOutCraft = 0, matsOutForge = 0;
  const gains: Record<PowerSource, number> = { found: 0, shop: 0, craft: 0, upgrade: 0 };
  /**
   * Прирост ДПС оружия в руке от шага `fn`, разнесённый по источнику новой вещи. ДПС до и после — в ОДНОМ
   * состоянии героя (старое оружие на миг возвращается в руку): иначе прирост уровня за шаг записался бы
   * на вещь. Считается, только когда вещь в руке сменилась: дренаж сумки зовётся каждый тик.
   */
  const watched = <T>(fn: () => T): T => {
    const w0 = save.equipment.weapon;
    const t0 = w0?.tier, r0 = w0?.rarity;
    const res = fn();
    const w1 = save.equipment.weapon;
    if (!w1 || (w1 === w0 && w1.tier === t0 && w1.rarity === r0)) return res;
    const d1 = weaponDps(reg, save, w1);
    let d0 = 0;
    if (w0) { save.equipment.weapon = w0; d0 = weaponDps(reg, save, w0); save.equipment.weapon = w1; }
    const same = !!w0 && w0.uid === w1.uid;
    const src: PowerSource = same ? (w1.tier !== t0 ? 'upgrade' : 'craft')
      : w1.origin === 'craft' ? 'craft' : w1.origin === 'shop' ? 'shop' : 'found';
    gains[src] += d1 - d0;
    return res;
  };
  let curFloor = 0;
  let deepest = 0;
  let floorsCompleted = 0;
  const curve: CurvePoint[] = [];
  let lastCurveT = -Infinity;

  const stop = (): boolean =>
    save.level >= settings.targetLevel || totalTime >= settings.maxHours * 3600 || deaths >= maxDeaths;

  /**
   * Разбор сумки на ходу. ⚠ Сломанный АПГРЕЙД не перерабатываем: его несут к кузнецу,
   * и именно за это платят золотом — без этого главный сток экономики в симе не работает.
   */
  let keptUids = new Set<string>();
  const drainInventory = (): void => {
    // Ничего нового с прошлого разбора — пересматривать нечего. Без этой проверки дренаж шёл КАЖДЫЙ тик
    // (сырьё в сумке лежит всегда), а с ковкой каждый тик пересчитывал бы журнал на всю ношу.
    if (save.inventory.every((i) => keptUids.has(i.uid))) return;
    watched(drainNow);
  };
  const drainNow = (): void => {
    const keep: Item[] = [];
    // Ковка открыта — найденное оружие несём кузнецу. Бюджет клеток — на каждый дренаж
    // заново: вся ноша пересматривается, и свежая находка может вытеснить старую.
    const carry: FieldCarry | undefined = craftOn ? { journal: normalizeJournal(stash.forgeJournal), carryCells: carryCellsOf(reg) } : undefined;
    while (save.inventory.length) {
      const it = save.inventory.pop()!;
      const r = considerDrop(reg, save, it, settings.build, carry);
      goldSold += r.sold;
      if (r.melted) { meltedField += r.melted; matsMelt += r.salvaged ?? 0; }
      else matsGained += r.salvaged ?? 0;
      salvagedField += r.salvagedItems ?? 0;
      if (r.kept) keep.push(it);
    }
    save.inventory = keep;
    keptUids = new Set(keep.map((i) => i.uid));
  };
  const sampleCurve = (): void => {
    if (totalTime - lastCurveT >= 60) {
      lastCurveT = totalTime;
      curve.push({ timeSec: Math.round(totalTime), level: save.level, power: effectiveLevel(save, powerCfg, undefined, tiers).total, floor: curFloor });
    }
  };
  /** Распределение очков за уровни (атрибуты + скиллы/пассивы) — дёшево, зовём после каждого этажа. */
  const allocate = (): void => {
    allocateAttributes(save, profile, settings.build, rng);
    // ⚠ Пассивки покупаются ЗА ЗОЛОТО (цена узла растёт геометрически), и до этого их трата
    // нигде не учитывалась: отчёт показывал, будто бот копит золото, хотя он его тратит.
    const before = save.gold;
    allocateSkillsAndPassives(reg, save, settings.build, rng);
    goldOnPassives += Math.max(0, before - save.gold);
  };
  const stockBelt = (): void => { goldSpent += stockBeltFromShop(reg, save); };
  /** Городская остановка: распределение + пара заходов в магазин + полный пояс зелий (эконом-бот). */
  const doTown = (): void => {
    allocate();
    for (let k = 0; k < 2; k++) {
      const r = watched(() => visitShop(reg, save, save.level, rng, settings.build));
      goldSpent += r.spent; goldSold += r.sold; itemsBought += r.bought.length;
    }
    // Кузница ПОСЛЕ магазина: чинить и качать имеет смысл то, что уже отобрано как лучшее.
    const f = watched(() => visitForge(reg, save, settings.build, stash, {
      craft: craftOn, rng: forgeRng, fullJournal: settings.fullJournal,
      nonce: () => `sim-${settings.seed >>> 0}-${++nonceSeq}`,
    }));
    goldSpent += f.spent; goldSold += f.sold; repaired += f.repaired; upgraded += f.upgraded;
    crafted += f.crafted; enchanted += f.enchanted; meltedForge += f.melted; salvagedForge += f.salvaged; unlocked += f.unlocked;
    goldCraft += f.goldCraft; goldEnchant += f.goldEnchant;
    matsForge += f.matsIn; matsMelt += f.matsMelt; matsOutCraft += f.matsOutCraft; matsOutForge += f.matsOutForge;
    stockBelt();
  };

  /** Учёт событий тика — один для боя и для сбора лута. */
  const onEvent = (e: SessionEvent): void => {
    if (e.type === 'monster-died') kills++;
    else if (e.type === 'gold') gold += e.amount;
    else if (e.type === 'item-dropped') {
      items++;
      const t = e.item.kind ?? 'other';
      lootByType[t] = (lootByType[t] ?? 0) + 1;
      lootByRarity[e.item.rarity] = (lootByRarity[e.item.rarity] ?? 0) + 1;
      const sl = e.item.slot ?? '—';
      lootBySlot[sl] = (lootBySlot[sl] ?? 0) + 1;
      if (e.from === 'chest') fromChests++; else fromMonsters++;
      if (e.item.broken) brokenItems++;
    } else if (e.type === 'materials') {
      for (const [id, n] of Object.entries(e.gains)) materials[id] = (materials[id] ?? 0) + n;
    } else if (e.type === 'chest-opened') chestsOpened++;
    else if (e.type === 'xp') xp += e.amount;
    else if (e.type === 'player-died') deaths++;
  };

  let runPlan: RunPlan | null = null;
  let node: RunNode | null = null;
  let runIdx = 0;
  const nodeById = (id: string): RunNode | null => runPlan!.nodes.find((n) => n.id === id) ?? null;

  while (!stop()) {
    if (!node) {
      // Новый забег: свежий граф из сида, старт с города (магазин/очки), затем стартовый узел.
      runPlan = generateRunPlan(reg, buildRunConfig(reg, settings.difficultyId, runSeedOf(settings.seed, runIdx++)));
      node = nodeById(runPlan.startId);
      if (!node) break;
      doTown();
      reviveFull(p, save, reg);
      totalTime += townTripSec;
    }

    curFloor = node.depth;
    if (node.type === 'rest') {
      // Rest-узел = город посреди забега: магазин + распределение + отдых.
      doTown();
      reviveFull(p, save, reg);
      totalTime += townTripSec;
      node = node.edges.length ? nodeById(node.edges[0]!.to) : null; // финалить некуда с rest — но edges есть
      continue;
    }

    // Боевой узел: генерим этаж по floorSpec узла и заселяем пулом/глубиной/плотностью узла (как Room.enterNode).
    // ⚠ Сундуки передаём ЯВНО: без этого бот проходил этажи без них и отчёт показывал бы
    // ноль целых вещей — то есть врал бы ровно там, где его и смотрят.
    const layout = generateFloor(node.floorSpec, prefabs, undefined, undefined,
      { tiers: reg.get('chests'), perFloor: reg.get('balance').loot.chestsPerFloor });
    openDoors(layout);
    const biome = biomes.find((b) => b.id === node!.biomeId) ?? biomes[0]!;
    const pool = resolveMonsterPool(biome, node.depth);
    const el = effectiveLevel(save, powerCfg, undefined, tiers).total;
    const frng = createRng((node.floorSpec.seed >>> 0) || 1);
    const monsters = spawnPacksEl(reg, layout, node.depth, settings.difficultyId, frng, el, pool, node.floorSpec.packDensity, node.floorSpec.floorId);
    session.enterFloor(node.depth, {
      grid: layout.grid, spawn: layout.spawn, exits: layout.exits, monsters, chests: layout.chests,
      runNodeId: node.id, runNodeType: node.type, floorModifiers: node.floorSpec.modifiers, biomeId: node.biomeId,
    });
    bot.syncHotbar(save);
    deepest = Math.max(deepest, node.depth);

    // Бой до зачистки / достижения выхода / смерти / таймаута (игрок не обязан зачищать весь этаж).
    const exits = layout.exits ?? [];
    let reachedExit = -1;
    let floorTime = 0;
    while (session.monstersAlive > 0 && p.alive && floorTime < floorCap && reachedExit < 0 && !stop()) {
      for (const e of session.tick(dt, { p1: bot.input(session.world, p) })) onEvent(e);
      if (session.world.drops.length === 0 && save.inventory.length > 0) drainInventory();
      for (let i = 0; i < exits.length; i++) { const e = exits[i]!; if (Math.hypot(e.x - p.pos.x, e.y - p.pos.y) <= 26) { reachedExit = i; break; } }
      floorTime += dt; totalTime += dt; sampleCurve();
    }
    // Фаза сбора лута (добираем оставшийся дроп).
    let lootTime = 0;
    while (p.alive && session.world.drops.length > 0 && lootTime < 20 && !stop()) {
      // ⚠ События сбора тоже считаем: раньше их выбрасывали, и подобранное здесь сырьё и золото в отчёт
      // не попадало — сверка сырья (пришло − ушло = запас) расходилась ровно на эту добычу.
      for (const e of session.tick(dt, { p1: bot.input(session.world, p) })) onEvent(e);
      drainInventory();
      lootTime += dt; totalTime += dt;
    }
    drainInventory();

    if (!p.alive) {
      // Смерть: авторитетный штраф (золото + часть инвентаря), возврат в город, возрождение.
      applyDeathPenalty(save, deathPenalty, rng);
      reviveFull(p, save, reg);
      node = null; // новый забег с города
      totalTime += townTripSec;
      continue;
    }
    allocate(); // очки за набранные уровни — сразу
    const cleared = session.monstersAlive === 0;
    if (cleared || reachedExit >= 0) floorsCompleted++;
    // Спуск: по достигнутому выходу (ребро того же индекса); иначе зачистил → первое ребро;
    // финал (0 рёбер) или таймаут без выхода → null (новый забег/город).
    const edge = reachedExit >= 0 ? node.edges[reachedExit] ?? node.edges[0] : cleared ? node.edges[0] : undefined;
    node = edge ? nodeById(edge.to) : null;
  }

  const hours = totalTime / 3600;
  const perHour = (n: number): number => (hours > 0 ? Math.round((n / hours) * 10) / 10 : 0);
  const matsMonsters = Object.values(materials).reduce((a, b) => a + b, 0);
  const matsIn = matsMonsters + matsGained + matsForge + matsMelt;
  const matsOut = matsOutCraft + matsOutForge;
  const matsEnd = units();
  const endMats = availableMaterials(save.inventory, stash.materials ?? {});
  const journal = normalizeJournal(stash.forgeJournal);
  const weapon = save.equipment.weapon;
  const r1 = (x: number): number => Math.round(x * 10) / 10;
  return {
    classId: settings.classId,
    difficultyId: settings.difficultyId,
    seed: settings.seed,
    totalTimeSec: Math.round(totalTime),
    totalHours: Math.round(hours * 100) / 100,
    deepestFloor: deepest,
    floorsCompleted,
    kills,
    deaths,
    goldEarned: gold,
    goldSold,
    goldSpent,
    itemsBought,
    itemsFound: items,
    itemsRepaired: repaired,
    itemsUpgraded: upgraded,
    goldOnPassives,
    xpEarned: xp,
    killsPerHour: hours > 0 ? Math.round(kills / hours) : 0,
    craftedPerHour: perHour(crafted),
    meltedPerHour: perHour(meltedForge + meltedField),
    salvagedPerHour: perHour(salvagedForge + salvagedField),
    enchantedPerHour: perHour(enchanted),
    xpPerHour: hours > 0 ? Math.round(xp / hours) : 0,
    lootPerHour: hours > 0 ? Math.round((items / hours) * 10) / 10 : 0,
    goldEnd: save.gold,
    loot: {
      byType: lootByType,
      byRarity: lootByRarity,
      bySlot: lootBySlot,
      fromMonsters,
      fromChests,
      broken: brokenItems,
      materials,
      materialsByTier: tierSums(reg, materials),
      chestsOpened,
      salvagedInField: matsGained,
    },
    craft: {
      enabled: craftOn,
      crafted, enchanted,
      melted: meltedForge + meltedField,
      salvagedAtForge: salvagedForge,
      salvagedInField: salvagedField,
      unlocked,
      goldOnCraft: goldCraft,
      goldOnEnchant: goldEnchant,
      materials: {
        in: { monsters: matsMonsters, field: matsGained, forge: matsForge, melt: matsMelt, total: matsIn },
        out: { craft: matsOutCraft, forge: matsOutForge, total: matsOut },
        lost: matsStart + matsIn - matsOut - matsEnd,
        end: matsEnd,
        endByTier: tierSums(reg, endMats),
        inPerHour: perHour(matsIn),
        outPerHour: perHour(matsOut),
        sellWorth: { monsters: sellWorth(reg, materials), end: sellWorth(reg, endMats) },
      },
      power: {
        found: r1(gains.found), shop: r1(gains.shop), craft: r1(gains.craft), upgrade: r1(gains.upgrade),
        perHour: { found: perHour(gains.found), shop: perHour(gains.shop), craft: perHour(gains.craft), upgrade: perHour(gains.upgrade) },
        weaponDps: weapon ? r1(weaponDps(reg, save, weapon)) : 0,
        weaponSource: !weapon ? '—' : weapon.parts ? 'craft' : (weapon.origin ?? 'found'),
      },
      journal: { bases: journal.bases.length, variants: journal.variants.length, tierHi: journal.tierHi, mythic: journal.mythic },
    },
    levelCurve: curve,
    finalBuild: buildSnapshot(reg, save),
    finalSave: save,
    finalStash: stash,
  };
}
