import { describe, it, expect } from 'vitest';
import { deriveStats } from './stats.js';
import { damageMultOf, attackByType, estimateAttack } from './playerCombat.js';
import type { Attributes } from '../types/attributes.js';

const attrs: Attributes = { strength: 10, dexterity: 10, intelligence: 10, vitality: 10 };
const scaling = { melee: 0.5, ranged: 0.5, magic: 0.5 };
// weightScaleSplit не вызывается без оружия-melee-с-весом → таблица весов не нужна.
const weights = {} as never;

describe('множители исходящего урона (%-статы)', () => {
  it('damageMultOf складывает общий damagePct и стихийный *Pct', () => {
    const d = deriveStats(attrs, [
      { stat: 'damagePct', kind: 'flat', value: 0.1 },
      { stat: 'firePct', kind: 'flat', value: 0.25 },
    ]);
    expect(damageMultOf(d, 'fire')).toBeCloseTo(1.35); // 1 + 0.10 + 0.25
    expect(damageMultOf(d, 'physical')).toBeCloseTo(1.1); // 1 + 0.10
    expect(damageMultOf(d, 'cold')).toBeCloseTo(1.1);
  });

  it('attackByType масштабирует стихийную добавку на свой множитель', () => {
    const d = deriveStats(attrs, [
      { stat: 'addFire', kind: 'flat', value: 10 },
      { stat: 'firePct', kind: 'flat', value: 0.2 },
      { stat: 'damagePct', kind: 'flat', value: 0.1 },
    ]);
    const t = attackByType(d, attrs, undefined, scaling, weights);
    expect(t.fire.min).toBeCloseTo(13); // 10 × (1 + 0.1 + 0.2)
    expect(t.fire.max).toBeCloseTo(13);
  });

  it('estimateAttack растёт с damagePct', () => {
    const plain = deriveStats(attrs, []);
    const boosted = deriveStats(attrs, [{ stat: 'damagePct', kind: 'flat', value: 0.5 }]);
    const a = estimateAttack(plain, attrs, undefined, scaling, weights);
    const b = estimateAttack(boosted, attrs, undefined, scaling, weights);
    expect(b).toBeCloseTo(a * 1.5);
  });
});
