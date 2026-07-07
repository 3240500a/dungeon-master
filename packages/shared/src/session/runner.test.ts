import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { DEFAULT_BUILD } from '../sim/types.js';
import { runSessionSim } from './runner.js';

describe('runSessionSim — настоящий сим на GameSession', () => {
  it('воин прокачивается, дерётся, собирает лут и билд', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const r = runSessionSim(reg, {
      classId: 'warrior',
      difficultyId: 'normal',
      seed: 42,
      targetLevel: 5,
      maxHours: 1,
      build: DEFAULT_BUILD,
    });
    expect(r.kills).toBeGreaterThan(0);
    expect(r.xpEarned).toBeGreaterThan(0);
    expect(r.totalTimeSec).toBeGreaterThan(0);
    expect(r.finalBuild.level).toBeGreaterThanOrEqual(3);
    expect(r.finalBuild.equipment.length).toBeGreaterThan(0);
    expect(r.finalBuild.derived.maxHp).toBeGreaterThan(0);
    expect(r.levelCurve.length).toBeGreaterThan(0);
  });

  it('детерминизм: один сид → одинаковый итог', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const opts = { classId: 'warrior', difficultyId: 'normal', seed: 99, targetLevel: 4, maxHours: 1, build: DEFAULT_BUILD };
    const a = runSessionSim(reg, opts);
    const b = runSessionSim(reg, opts);
    expect(a.kills).toBe(b.kills);
    expect(a.totalTimeSec).toBe(b.totalTimeSec);
    expect(a.finalBuild.level).toBe(b.finalBuild.level);
  });
});
