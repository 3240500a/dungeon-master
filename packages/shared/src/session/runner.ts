import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import { createRng } from '../formulas/rng.js';
import { effectiveLevel } from '../formulas/power.js';
import { newDebuffState } from '../world/debuffs.js';
import type { PlayerEntity } from '../world/state.js';
import { buildFloor } from '../dungeon/floor.js';
import { newBotSave, classProfileAttr, allocateAttributes } from '../sim/playerBot.js';
import { considerDrop, visitShop, allocateSkillsAndPassives } from '../sim/economy.js';
import type { BuildPolicy } from '../sim/types.js';
import { GameSession } from './session.js';
import { BotController } from './bot.js';
import { playerSnapshot } from './derive.js';
import { buildSnapshot, type RunReport, type CurvePoint } from './stats.js';

/**
 * Полный прогон «сим = игра»: бот ведёт настоящий `GameSession` этаж за этажом,
 * дерётся реальным боевым ядром, подбирает/надевает лут (эконом-скоринг), тратит
 * очки, ходит в магазин, умирает и возвращается — до целевого уровня/лимита часов.
 * Собирает `RunReport` (финальный билд + статы забегов + кривая). Заменяет
 * абстрактный `runSim` настоящей симуляцией.
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
  /** Шаг тика, сек (по умолчанию 0.05 — 20 тиков/сек игрового времени). */
  dt?: number;
  /** Потолок времени на этаж, сек (анти-залипание). */
  floorTimeCapSec?: number;
  /** Стоп после стольких смертей. */
  maxDeaths?: number;
  /** Время на один поход в город (телепорт+лечёж+магазин+возврат), сек. */
  townTripSec?: number;
}

function reviveFull(p: PlayerEntity, save: SaveState, reg: ConfigRegistry): void {
  const snap = playerSnapshot(save, reg);
  p.hp = snap.derived.maxHp;
  p.mana = snap.derived.maxMana;
  p.debuffs = newDebuffState();
  p.alive = true;
}

export function runSessionSim(reg: ConfigRegistry, settings: SessionSimSettings): RunReport {
  const dt = settings.dt ?? 0.05;
  const floorCap = settings.floorTimeCapSec ?? 240;
  const maxDeaths = settings.maxDeaths ?? 60;
  const townTripSec = settings.townTripSec ?? 45;
  const rng = createRng((settings.seed >>> 0) || 1);
  const powerCfg = reg.get('balance').power;

  const save = newBotSave(reg, settings.classId);
  const profile = classProfileAttr(reg, settings.classId);
  const session = new GameSession(reg, settings.seed, settings.difficultyId);
  const p = session.addPlayer('p1', save);
  const bot = new BotController(reg);

  let totalTime = 0;
  let kills = 0;
  let deaths = 0;
  let gold = 0;
  let items = 0;
  let xp = 0;
  let depth = 1;
  let deepest = 1;
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
      curve.push({ timeSec: Math.round(totalTime), level: save.level, power: effectiveLevel(save, powerCfg).total, floor: depth });
    }
  };

  const floorSeedBase = (settings.seed >>> 0) || 1;
  while (!stop()) {
    const layout = buildFloor(reg, save, floorSeedBase, depth, settings.difficultyId, rng);
    session.enterFloor(depth, layout);
    bot.syncHotbar(save);
    deepest = Math.max(deepest, depth);

    // Бой до зачистки / смерти / таймаута.
    let floorTime = 0;
    while (session.monstersAlive > 0 && p.alive && floorTime < floorCap && !stop()) {
      const events = session.tick(dt, { p1: bot.input(session.world, p) });
      for (const e of events) {
        if (e.type === 'monster-died') kills++;
        else if (e.type === 'gold') gold += e.amount;
        else if (e.type === 'item-dropped') items++;
        else if (e.type === 'xp') xp += e.amount;
        else if (e.type === 'player-died') deaths++;
      }
      if (session.world.drops.length === 0 && save.inventory.length > 0) drainInventory();
      floorTime += dt;
      totalTime += dt;
      sampleCurve();
    }

    // Фаза сбора лута (после зачистки добираем оставшийся дроп).
    let lootTime = 0;
    while (p.alive && session.world.drops.length > 0 && lootTime < 20 && !stop()) {
      session.tick(dt, { p1: bot.input(session.world, p) });
      drainInventory();
      lootTime += dt;
      totalTime += dt;
    }
    drainInventory();

    if (!p.alive) {
      // Смерть: штраф золота, возврат в город (глубина 1), возрождение, добор гира.
      gold = Math.max(0, gold); // события уже учтены
      save.gold = Math.round(save.gold * 0.85);
      depth = 1;
      reviveFull(p, save, reg);
      allocateAttributes(save, profile, settings.build, rng);
      allocateSkillsAndPassives(reg, save, settings.build, rng);
      for (let k = 0; k < 2; k++) visitShop(reg, save, save.level, rng, settings.build);
      totalTime += townTripSec; // возрождение/перезаход в город стоит времени
    } else {
      if (session.monstersAlive === 0) floorsCompleted++;
      allocateAttributes(save, profile, settings.build, rng);
      allocateSkillsAndPassives(reg, save, settings.build, rng);
      // Возврат в город: планово раз в 4 этажа ИЛИ когда HP просело (зелий нет —
      // осторожный игрок телепортируется лечиться, а не идёт дальше на низком HP).
      const hpFrac = p.hp / Math.max(1, playerSnapshot(save, reg).derived.maxHp);
      if (depth % 4 === 0 || hpFrac < 0.5) {
        for (let k = 0; k < 2; k++) visitShop(reg, save, save.level, rng, settings.build);
        reviveFull(p, save, reg); // отдых в городе
        totalTime += townTripSec; // дорога в город и обратно
      }
      depth++;
    }
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
