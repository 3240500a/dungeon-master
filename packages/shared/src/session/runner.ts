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
import { newBotSave, classProfileAttr, allocateAttributes } from '../sim/playerBot.js';
import { considerDrop, visitShop, allocateSkillsAndPassives } from '../sim/economy.js';
import type { BuildPolicy } from '../sim/types.js';
import { GameSession } from './session.js';
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
}

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

export function runSessionSim(reg: ConfigRegistry, settings: SessionSimSettings): RunReport {
  const dt = settings.dt ?? 1 / 30;
  const floorCap = settings.floorTimeCapSec ?? 240;
  const maxDeaths = settings.maxDeaths ?? 60;
  const townTripSec = settings.townTripSec ?? 45;
  const rng = createRng((settings.seed >>> 0) || 1);
  const powerCfg = reg.get('balance').power;
  const deathPenalty = reg.get('balance').deathPenalty;
  const prefabs = reg.get('room-prefabs');
  const biomes = reg.get('biomes');

  const save = newBotSave(reg, settings.classId);
  const profile = classProfileAttr(reg, settings.classId);
  const session = new GameSession(reg, settings.seed, settings.difficultyId);
  const p = session.addPlayer('p1', save);
  const bot = new BotController(reg, settings.botTier ?? 'rotation', settings.botStyle ?? 'balanced');

  let totalTime = 0;
  let kills = 0;
  let deaths = 0;
  let gold = 0;
  let items = 0;
  let xp = 0;
  let curFloor = 0;
  let deepest = 0;
  let floorsCompleted = 0;
  const curve: CurvePoint[] = [];
  let lastCurveT = -Infinity;

  const stop = (): boolean =>
    save.level >= settings.targetLevel || totalTime >= settings.maxHours * 3600 || deaths >= maxDeaths;

  const drainInventory = (): void => {
    while (save.inventory.length) considerDrop(reg, save, save.inventory.pop()!, settings.build);
  };
  const sampleCurve = (): void => {
    if (totalTime - lastCurveT >= 60) {
      lastCurveT = totalTime;
      curve.push({ timeSec: Math.round(totalTime), level: save.level, power: effectiveLevel(save, powerCfg).total, floor: curFloor });
    }
  };
  /** Распределение очков за уровни (атрибуты + скиллы/пассивы) — дёшево, зовём после каждого этажа. */
  const allocate = (): void => {
    allocateAttributes(save, profile, settings.build, rng);
    allocateSkillsAndPassives(reg, save, settings.build, rng);
  };
  const itemsBase = reg.get('items.base');
  /** Пополняет пояс лечебными зельями (у реального игрока пояс всегда полон перед вылазкой). */
  const stockBelt = (): void => { save.belt = Array.from({ length: 6 }, () => itemFromBaseId(itemsBase, 'healing-potion') ?? null); };
  /** Городская остановка: распределение + пара заходов в магазин + полный пояс зелий (эконом-бот). */
  const doTown = (): void => { allocate(); for (let k = 0; k < 2; k++) visitShop(reg, save, save.level, rng, settings.build); stockBelt(); };

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
    const layout = generateFloor(node.floorSpec, prefabs);
    openDoors(layout);
    const biome = biomes.find((b) => b.id === node!.biomeId) ?? biomes[0]!;
    const pool = resolveMonsterPool(biome, node.depth);
    const el = effectiveLevel(save, powerCfg).total;
    const frng = createRng((node.floorSpec.seed >>> 0) || 1);
    const monsters = spawnPacksEl(reg, layout, node.depth, settings.difficultyId, frng, el, pool, node.floorSpec.packDensity);
    session.enterFloor(node.depth, {
      grid: layout.grid, spawn: layout.spawn, exits: layout.exits, monsters,
      runNodeId: node.id, runNodeType: node.type, floorModifiers: node.floorSpec.modifiers,
    });
    bot.syncHotbar(save);
    deepest = Math.max(deepest, node.depth);

    // Бой до зачистки / достижения выхода / смерти / таймаута (игрок не обязан зачищать весь этаж).
    const exits = layout.exits ?? [];
    let reachedExit = -1;
    let floorTime = 0;
    while (session.monstersAlive > 0 && p.alive && floorTime < floorCap && reachedExit < 0 && !stop()) {
      for (const e of session.tick(dt, { p1: bot.input(session.world, p) })) {
        if (e.type === 'monster-died') kills++;
        else if (e.type === 'gold') gold += e.amount;
        else if (e.type === 'item-dropped') items++;
        else if (e.type === 'xp') xp += e.amount;
        else if (e.type === 'player-died') deaths++;
      }
      if (session.world.drops.length === 0 && save.inventory.length > 0) drainInventory();
      for (let i = 0; i < exits.length; i++) { const e = exits[i]!; if (Math.hypot(e.x - p.pos.x, e.y - p.pos.y) <= 26) { reachedExit = i; break; } }
      floorTime += dt; totalTime += dt; sampleCurve();
    }
    // Фаза сбора лута (добираем оставшийся дроп).
    let lootTime = 0;
    while (p.alive && session.world.drops.length > 0 && lootTime < 20 && !stop()) {
      session.tick(dt, { p1: bot.input(session.world, p) });
      drainInventory();
      lootTime += dt; totalTime += dt;
    }
    drainInventory();

    if (!p.alive) {
      // Смерть: авторитетный штраф (золото + часть инвентаря), возврат в город, возрождение.
      applyDeathPenalty(save, deathPenalty);
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
    itemsFound: items,
    xpEarned: xp,
    killsPerHour: hours > 0 ? Math.round(kills / hours) : 0,
    xpPerHour: hours > 0 ? Math.round(xp / hours) : 0,
    lootPerHour: hours > 0 ? Math.round((items / hours) * 10) / 10 : 0,
    levelCurve: curve,
    finalBuild: buildSnapshot(reg, save),
  };
}
