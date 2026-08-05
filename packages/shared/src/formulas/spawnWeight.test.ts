import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { monsterDepthCurve, spawnWeightAt, weightedPickId } from './spawnWeight.js';
import type { ConfigShapes } from '../config/schemas.js';

const reg = new ConfigRegistry();
reg.loadAll();
const tiers = reg.get('depth-tiers');
const monsters = reg.get('monsters');
const mon = (id: string): ConfigShapes['monsters'][number] => monsters.find((m) => m.id === id)!;

describe('monsterDepthCurve', () => {
  it('авто: столбец силового тира по рядам depth-tiers', () => {
    const weak = monsterDepthCurve(mon('zombie'), tiers); // scout = weak
    expect(weak.length).toBe(tiers.length);
    expect(weak[0]).toBe(tiers[0]!.weights.weak);
    expect(weak[weak.length - 1]).toBe(tiers[tiers.length - 1]!.weights.weak);
  });

  it('ручной spawnCurve перекрывает авто', () => {
    const custom = [10, 20, 30, 40, 50, 60];
    const m = { ...mon('zombie'), spawnCurve: custom };
    expect(monsterDepthCurve(m, tiers)).toEqual(custom);
  });

  it('spawnCurve неверной длины игнорируется (фолбэк на тир)', () => {
    const m = { ...mon('zombie'), spawnCurve: [1, 2] };
    expect(monsterDepthCurve(m, tiers)).not.toEqual([1, 2]);
  });
});

describe('spawnWeightAt', () => {
  it('weak доминирует на мелководье, спадает к бездне', () => {
    const scout = mon('zombie');
    expect(spawnWeightAt(scout, tiers, 1)).toBeGreaterThan(spawnWeightAt(scout, tiers, 24));
  });

  it('boss ≈ 0 на первых этажах, растёт к глубине', () => {
    const lord = mon('zombie-lord'); // boss
    expect(spawnWeightAt(lord, tiers, 1)).toBeLessThan(5);
    expect(spawnWeightAt(lord, tiers, 24)).toBeGreaterThan(spawnWeightAt(lord, tiers, 1));
  });

  it('на этаже 1 weak весит больше boss', () => {
    expect(spawnWeightAt(mon('zombie'), tiers, 1)).toBeGreaterThan(spawnWeightAt(mon('zombie-lord'), tiers, 1));
  });

  it('интерполяция между контрольными этажами (промежуточный между краями тира)', () => {
    const scout = mon('zombie');
    const w1 = spawnWeightAt(scout, tiers, 1);
    const w4 = spawnWeightAt(scout, tiers, 4);
    const w2 = spawnWeightAt(scout, tiers, 2);
    expect(w2).toBeLessThanOrEqual(Math.max(w1, w4));
    expect(w2).toBeGreaterThanOrEqual(Math.min(w1, w4));
  });

  it('клампится за границами (ниже первого / выше последнего этажа)', () => {
    const scout = mon('zombie');
    expect(spawnWeightAt(scout, tiers, 0)).toBe(spawnWeightAt(scout, tiers, 1));
    expect(spawnWeightAt(scout, tiers, 999)).toBe(spawnWeightAt(scout, tiers, tiers[tiers.length - 1]!.fromFloor));
  });
});

describe('weightedPickId', () => {
  it('вес 0 у одного кандидата → он не выбирается', () => {
    const w: Record<string, number> = { a: 0, b: 10 };
    for (let i = 0; i < 20; i++) {
      expect(weightedPickId(['a', 'b'], (id) => w[id]!, i / 20, () => 'a')).toBe('b');
    }
  });

  it('все веса 0 → равномерный фолбэк', () => {
    expect(weightedPickId(['a', 'b'], () => 0, 0.5, () => 'FB')).toBe('FB');
  });

  it('пустой список → фолбэк', () => {
    expect(weightedPickId([], () => 1, 0.5, () => 'FB')).toBe('FB');
  });

  it('на этаже 1: скаут (weak) выбирается чаще фанатика (strong) из общего пула', () => {
    const pool = ['zombie', 'zombie-fanatic'];
    const wt = (id: string) => spawnWeightAt(mon(id), tiers, 1);
    let scout = 0;
    for (let i = 0; i < 100; i++) if (weightedPickId(pool, wt, i / 100, () => pool[0]!) === 'zombie') scout++;
    expect(scout).toBeGreaterThan(80);
  });
});
