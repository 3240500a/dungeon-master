import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { effectiveLevel, startChallenge, challengeAtFloor } from '../formulas/power.js';
import { newBotSave, levelUpBotTo, makePlayerModel } from './playerBot.js';
import { allocateSkillsAndPassives, visitShop } from './economy.js';
import { simulateFights } from './fight.js';
import { simulateFloor } from './floor.js';
import { simulateProgression } from './progression.js';
import type { SaveState } from '../types/save.js';
import type { FightStats, ProgressionResult, ScenarioKind, SimSettings } from './types.js';

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

/** Экипирует бота уровня L: стипендия «как будто нафармил» + магазин + скиллы/пассивы. */
function prepBotAt(reg: ConfigRegistry, settings: SimSettings, rng: ReturnType<typeof createRng>): SaveState {
  const save = newBotSave(reg, settings.classId);
  levelUpBotTo(reg, save, settings.level, settings.build, rng);
  save.gold += settings.level * 120;
  for (let k = 0; k < 3; k++) visitShop(reg, save, settings.level, rng, settings.build);
  allocateSkillsAndPassives(reg, save, settings.build, rng);
  return save;
}

/** Единая точка запуска сима: диспетчеризует по сценарию и агрегирует итог. */
export function runSim(reg: ConfigRegistry, settings: SimSettings): SimOutput {
  const rng = createRng((settings.seed >>> 0) || 1);
  const diffs = reg.get('difficulties');
  const diff = diffs.find((d) => d.id === settings.difficultyId) ?? diffs[0]!;
  const power = reg.get('balance').power;

  if (settings.scenario === 'fight') {
    const save = prepBotAt(reg, settings, rng);
    const model = makePlayerModel(reg, save, { useSkills: settings.build.useSkills });
    const el = effectiveLevel(save, power).total;
    const cl = challengeAtFloor(startChallenge(el, diff), diff, settings.floor);
    const pool = reg.get('biomes')[0]!.monsterPool;
    const monsters = reg.get('monsters');
    const affx = reg.get('monster-affixes');
    const make = (r: typeof rng) =>
      Array.from({ length: 3 }, () => generateMonster(monsters, affx, { baseId: r.pick(pool), depth: cl }, r));
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
