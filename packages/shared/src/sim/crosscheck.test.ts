import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { buildBotAt } from '../session/aggregate.js';
import { microFightStats } from '../session/microFight.js';
import { closedFormTtk } from './closedForm.js';
import { DEFAULT_BUILD } from './types.js';

/**
 * Кросс-чек: закрытая формула (`closedFormTtk`) и реальный движок (`simulateMicroFight`) должны
 * согласовываться на БАЗОВОЙ АТАКЕ (без скиллов/DoT). Расхождение = баг в одной из моделей.
 * Метрика — «попавших ударов до смерти» (общая для формулы и движка), с запасом на стохастику/крит/округление.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const classId = reg.get('classes')[0]!.id;

function mob(baseId: string, depth: number) {
  return generateMonster(reg.get('monsters'), reg.get('monster-gear'), reg.get('monster-affixes'),
    { baseId, depth, mderive: reg.get('monster-derive'), itemAffixes: reg.get('affixes'), rarities: reg.get('rarities'), rarity: 'normal', monsterRarity: reg.get('monster-rarity'), monsterUniques: reg.get('monster-uniques'), randomChampion: false },
    createRng(1));
}

describe('кросс-чек: закрытая формула ≈ реальный движок (базовая атака)', () => {
  it('landedHitsToKill формулы согласуется со средним ударов микро-боя', () => {
    // Танковый моб (глубина ≫ уровня) → кил за много ударов: дискретность «≥1 удар» размывается,
    // формула и движок должны сойтись близко. (На ~1-ударных киллах отношение искажает целочисленность.)
    for (const level of [15, 25, 35]) {
      const save = buildBotAt(reg, classId, level, DEFAULT_BUILD, 7);
      const m = mob('zombie-brute', level * 2 + 10); // глубина растёт быстрее уровня — держим кил за много ударов
      const cf = closedFormTtk(reg, save, m);
      const mc = microFightStats(reg, { save, monsters: [m], tier: 'basic' }, 40, 3);
      const ratio = mc.hitsToKill.mean / cf.landedHitsToKill;
      console.log(`L${level}: движок=${mc.hitsToKill.mean.toFixed(2)} формула=${cf.landedHitsToKill.toFixed(2)} отношение=${ratio.toFixed(2)} kill=${Math.round(mc.killRate * 100)}% ударов~${mc.hitsToKill.mean.toFixed(0)}`);
      expect(mc.killRate).toBeGreaterThan(0.7);    // базовый бот стабильно убивает
      expect(mc.hitsToKill.mean).toBeGreaterThan(3); // достаточно ударов, чтобы дискретность не искажала
      expect(ratio).toBeGreaterThan(0.7);           // формула и движок в согласии (±допуск на крит/роллы)
      expect(ratio).toBeLessThan(1.45);
    }
  });
});
