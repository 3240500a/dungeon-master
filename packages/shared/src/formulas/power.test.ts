import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { Item, Rarity } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import {
  effectiveLevel,
  startChallenge,
  challengeAtFloor,
  runChallengeLevel,
  isDifficultyUnlocked,
  type PowerConfig,
} from './power.js';

const reg = new ConfigRegistry();
reg.loadAll();
const powerCfg = reg.get('balance').power;
const diffs = reg.get('difficulties');
const easy = diffs[0]!;
const normal = diffs[1]!;
const hard = diffs[2]!;

function mkItem(rarity: Rarity, itemLevel: number): Item {
  return {
    uid: `u${Math.random()}`, baseId: 'b', name: 'x', slot: 'chest', rarity,
    itemLevel, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1,
  };
}

function mkSave(over: Partial<SaveState>): SaveState {
  return {
    level: 10, equipment: {}, passiveSkills: {}, attributes: {} as SaveState['attributes'],
    ...over,
  } as unknown as SaveState;
}

describe('effectiveLevel', () => {
  it('голый персонаж: EL = уровень', () => {
    const p = effectiveLevel(mkSave({ level: 20 }), powerCfg);
    expect(p.gearBonus).toBe(0);
    expect(p.passiveBonus).toBe(0);
    expect(p.total).toBe(20);
  });

  it('гир поднимает EL, но не выше каппа', () => {
    const equipment = { chest: mkItem('rare', 20), helm: mkItem('unique', 20) } as SaveState['equipment'];
    const p = effectiveLevel(mkSave({ level: 20, equipment }), powerCfg);
    expect(p.gearBonus).toBeGreaterThan(0);

    const tiny: PowerConfig = { ...powerCfg, gearMax: 1 };
    expect(effectiveLevel(mkSave({ level: 20, equipment }), tiny).gearBonus).toBeLessThanOrEqual(1);
  });

  it('перерос уровня не даёт сверх номинала (currency ≤ 1)', () => {
    const low = effectiveLevel(mkSave({ level: 5, equipment: { chest: mkItem('rare', 5) } as SaveState['equipment'] }), powerCfg);
    const over = effectiveLevel(mkSave({ level: 5, equipment: { chest: mkItem('rare', 99) } as SaveState['equipment'] }), powerCfg);
    expect(over.gearBonus).toBe(low.gearBonus);
  });

  it('пассивы дают бонус в пределах каппа', () => {
    const p = effectiveLevel(mkSave({ level: 10, passiveSkills: { a: 8, b: 8 } }), powerCfg);
    expect(p.passiveBonus).toBeGreaterThan(0);
    const capped: PowerConfig = { ...powerCfg, passiveMax: 1 };
    expect(effectiveLevel(mkSave({ level: 10, passiveSkills: { a: 999 } }), capped).passiveBonus).toBe(1);
  });
});

describe('startChallenge', () => {
  it('flat: EL + offset', () => {
    expect(startChallenge(20, normal)).toBe(20);
    expect(startChallenge(20, hard)).toBe(25);
  });
  it('percent: EL × (1 + offset)', () => {
    expect(startChallenge(20, easy)).toBe(18); // -10%
  });
  it('не опускается ниже 1', () => {
    expect(startChallenge(1, easy)).toBe(1);
  });
});

describe('challengeAtFloor', () => {
  it('этаж 1 = стартовый CL, глубже — растёт', () => {
    expect(challengeAtFloor(20, normal, 1)).toBe(20);
    expect(challengeAtFloor(20, normal, 5)).toBe(24);
  });
  it('дробный floorStep округляется', () => {
    expect(challengeAtFloor(25, hard, 3)).toBe(28); // 25 + 2*1.5
  });
});

describe('runChallengeLevel', () => {
  it('голый персонаж на средней, этаж 1 = уровень', () => {
    expect(runChallengeLevel(mkSave({ level: 10 }), normal, 1, powerCfg)).toBe(10);
  });
});

describe('isDifficultyUnlocked', () => {
  it('первый тир открыт сразу; следующий — только если его unlockFloor 0', () => {
    expect(isDifficultyUnlocked(diffs, 0, {})).toBe(true); // первый всегда открыт
    // Второй тир открыт на старте ТОЛЬКО если его порог 0 (устойчиво к тюнингу гейта сложностей).
    expect(isDifficultyUnlocked(diffs, 1, {})).toBe(diffs[1]!.unlockFloor === 0);
  });
  it('следующий тир требует глубину на предыдущем', () => {
    expect(isDifficultyUnlocked(diffs, 2, { [normal.id]: 5 })).toBe(false);
    expect(isDifficultyUnlocked(diffs, 2, { [normal.id]: hard.unlockFloor })).toBe(true);
  });
});
