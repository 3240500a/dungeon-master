import { ConfigRegistry } from '../config/registry.js';
import { createRng, type Rng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { effectiveLevel, floorMonsterLevel } from '../formulas/power.js';
import { newBotSave, levelUpBotTo, makePlayerModel } from './playerBot.js';
import { allocateSkillsAndPassives, visitShop } from './economy.js';
import { simulateFights } from './fight.js';
import { monsterPicker, simulateFloor } from './floor.js';
import { simulateProgression } from './progression.js';
import type { SaveState } from '../types/save.js';
import type { BuildPolicy, FightStats, ProgressionResult, ScenarioKind, SimSettings } from './types.js';

export interface FightOutput extends FightStats {
  challengeLevel: number;
  playerLevel: number;
  power: number;
}

export interface FloorOutput {
  clearRate: number;
  deathRate: number;
  challengeLevel: number;
  avgTimeSec: number;
  avgXp: number;
  avgGold: number;
  avgDrops: number;
  avgPacks: number;
  avgMinHpFrac: number;
  iterations: number;
}

export interface SimOutput {
  scenario: ScenarioKind;
  fight?: FightOutput;
  floor?: FloorOutput;
  progression?: ProgressionResult;
}

/**
 * Экипирует бота уровня L: стипендия «как будто нафармил» + магазин + скиллы/пассивы.
 *
 * ⚠ ОДИН «честный герой» на весь оракул: сим баланса и ЗАМЕРЫ (ttk потолков печатей — `economy/sealCaps.test.ts`)
 * обязаны мерить одного и того же бота. Соберёшь героя второй раз рядом — замер начнёт мерить сборку, а не правило.
 */
export function prepBot(reg: ConfigRegistry, classId: string, level: number, build: BuildPolicy, rng: Rng): SaveState {
  const save = newBotSave(reg, classId);
  levelUpBotTo(reg, save, level, build, rng);
  save.gold += level * 120;
  for (let k = 0; k < 3; k++) visitShop(reg, save, level, rng, build);
  allocateSkillsAndPassives(reg, save, build, rng);
  return save;
}

const prepBotAt = (reg: ConfigRegistry, settings: SimSettings, rng: Rng): SaveState =>
  prepBot(reg, settings.classId, settings.level, settings.build, rng);

/** Единая точка запуска сима: диспетчеризует по сценарию и агрегирует итог. */
export function runSim(reg: ConfigRegistry, settings: SimSettings): SimOutput {
  const rng = createRng((settings.seed >>> 0) || 1);
  const diffs = reg.get('difficulties');
  const diff = diffs.find((d) => d.id === settings.difficultyId) ?? diffs[0]!;
  const power = reg.get('balance').power;

  if (settings.scenario === 'fight') {
    const save = prepBotAt(reg, settings, rng);
    const model = makePlayerModel(reg, save, { useSkills: settings.build.useSkills });
    const el = effectiveLevel(save, power, undefined, reg.get('item-tiers')).total;
    const cl = floorMonsterLevel(diff, settings.floor);   // ⭐ 13.10 (Г1): уровень монстров — от глубины, не от мощи `el`
    const monsters = reg.get('monsters');
    const affx = reg.get('monster-affixes');
    const gear = reg.get('monster-gear');
    const mderive = reg.get('monster-derive');
    const gearTiers = reg.get('monster-gear-tiers'); // ступень снаряжения монстра — как в игре
    // Монстр — по весу спавна игры на этом этаже (`monsterPicker`), а не поштучно: двойники делят вес источника.
    const picker = monsterPicker(reg, settings.floor);
    const make = (r: typeof rng) =>
      // ⚠ `depth` генератора НОЛЬ-БАЗОВЫЙ (`level = depth + 1`) — как в игре, кладём `cl - 1`, иначе монстр на уровень сильнее.
      Array.from({ length: 3 }, () => generateMonster(monsters, gear, affx, { baseId: picker.pick(r), depth: cl - 1, mderive, gearTiers }, r));
    const stats = simulateFights(make, model, settings.iterations, rng);
    return { scenario: 'fight', fight: { ...stats, challengeLevel: cl, playerLevel: save.level, power: el } };
  }

  if (settings.scenario === 'floor') {
    const n = Math.max(1, settings.iterations);
    let cleared = 0, died = 0, time = 0, xp = 0, gold = 0, drops = 0, packs = 0, minhp = 0, cl = 0;
    for (let i = 0; i < n; i++) {
      const save = prepBotAt(reg, settings, rng);
      const res = simulateFloor(reg, save, diff, settings.floor, settings.build, settings.floorOverheadSec, rng);
      if (res.cleared) cleared += 1;
      if (res.died) died += 1;
      time += res.timeSec; xp += res.xp; gold += res.gold;
      drops += res.drops; packs += res.packsCleared; minhp += res.minHpFrac; cl = res.challengeLevel;
    }
    return {
      scenario: 'floor',
      floor: {
        clearRate: cleared / n, deathRate: died / n, challengeLevel: cl,
        avgTimeSec: time / n, avgXp: xp / n, avgGold: gold / n, avgDrops: drops / n,
        avgPacks: packs / n, avgMinHpFrac: minhp / n, iterations: n,
      },
    };
  }

  // progression — один репрезентативный прогон (кривая часы→уровень).
  return { scenario: 'progression', progression: simulateProgression(reg, settings, rng) };
}
