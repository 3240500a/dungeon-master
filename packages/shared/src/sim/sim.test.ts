import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { newBotSave, levelUpBotTo, makePlayerModel, botDerived } from './playerBot.js';
import { simulateFight, simulateFights } from './fight.js';
import { runSim } from './run.js';
import { DEFAULT_BUILD, type BuildPolicy, type SimSettings } from './types.js';

const reg = new ConfigRegistry();
reg.loadAll();
const classId = reg.get('classes')[0]!.id;

function pack(cl: number, count: number, rng: ReturnType<typeof createRng>) {
  return Array.from({ length: count }, () =>
    generateMonster(reg.get('monsters'), reg.get('monster-affixes'), { baseId: 'skeleton', depth: cl }, rng));
}

function botAt(level: number, build: BuildPolicy = DEFAULT_BUILD) {
  const save = newBotSave(reg, classId);
  levelUpBotTo(reg, save, level, build, createRng(level * 7 + 1));
  return save;
}

describe('sim: бой', () => {
  it('детерминирован при одном сиде', () => {
    const model = makePlayerModel(reg, botAt(10));
    const a = simulateFight(model, pack(4, 3, createRng(5)), createRng(9));
    const b = simulateFight(model, pack(4, 3, createRng(5)), createRng(9));
    expect(a).toEqual(b);
  });

  it('выше уровень монстров → не выше винрейт', () => {
    const model = makePlayerModel(reg, botAt(12));
    const easy = simulateFights((rng) => pack(3, 3, rng), model, 40, createRng(2));
    const hard = simulateFights((rng) => pack(40, 3, rng), model, 40, createRng(3));
    expect(easy.winRate).toBeGreaterThanOrEqual(hard.winRate);
    expect(easy.winRate).toBeGreaterThan(0.5);
  });

  it('выше уровень игрока → выше исходящий DPS', () => {
    const low = makePlayerModel(reg, botAt(4));
    const high = makePlayerModel(reg, botAt(24));
    const lo = simulateFights((rng) => pack(6, 3, rng), low, 30, createRng(11));
    const hi = simulateFights((rng) => pack(6, 3, rng), high, 30, createRng(11));
    expect(hi.avgDpsOut).toBeGreaterThan(lo.avgDpsOut);
  });

  it('больше живучести в билде → больше HP', () => {
    const tank = botDerived(reg, botAt(15, { ...DEFAULT_BUILD, vitalityShare: 0.8, variance: 0 }));
    const glass = botDerived(reg, botAt(15, { ...DEFAULT_BUILD, vitalityShare: 0.05, variance: 0 }));
    expect(tank.maxHp).toBeGreaterThan(glass.maxHp);
  });
});

function settings(over: Partial<SimSettings>): SimSettings {
  return {
    scenario: 'progression', classId, difficultyId: 'normal',
    level: 10, floor: 1, targetLevel: 6, maxHours: 40, iterations: 1,
    seed: 123, build: DEFAULT_BUILD, floorOverheadSec: 20, ...over,
  };
}

describe('sim: runSim', () => {
  it('fight — валидный агрегат', () => {
    const out = runSim(reg, settings({ scenario: 'fight', level: 12, floor: 1, iterations: 25 }));
    expect(out.fight).toBeDefined();
    expect(out.fight!.winRate).toBeGreaterThanOrEqual(0);
    expect(out.fight!.winRate).toBeLessThanOrEqual(1);
    expect(out.fight!.challengeLevel).toBeGreaterThan(0);
  });

  it('floor — валидный агрегат', () => {
    const out = runSim(reg, settings({ scenario: 'floor', level: 8, floor: 1, iterations: 4 }));
    expect(out.floor).toBeDefined();
    expect(out.floor!.avgTimeSec).toBeGreaterThan(0);
    expect(out.floor!.clearRate).toBeGreaterThanOrEqual(0);
    expect(out.floor!.clearRate).toBeLessThanOrEqual(1);
  });

  it('progression — кривая часы→уровень монотонна и в пределах цели', () => {
    const out = runSim(reg, settings({ scenario: 'progression', targetLevel: 6, maxHours: 60 }));
    const pr = out.progression!;
    expect(pr.curve.length).toBeGreaterThanOrEqual(1);
    // Может слегка перескочить цель (один этаж даёт XP на несколько уровней сразу).
    expect(pr.reachedLevel).toBeGreaterThanOrEqual(6);
    expect(pr.totalHours).toBeGreaterThan(0);
    for (let i = 1; i < pr.curve.length; i++) {
      expect(pr.curve[i]!.level).toBeGreaterThanOrEqual(pr.curve[i - 1]!.level);
      expect(pr.curve[i]!.hours).toBeGreaterThanOrEqual(pr.curve[i - 1]!.hours);
    }
  });
});
