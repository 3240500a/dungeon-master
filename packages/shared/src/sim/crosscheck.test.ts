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
  // ⚠ Id обязан существовать: без него `generateMonster` берёт СЛУЧАЙНОГО из всего ростера, и тест молча
  // мерил бы другого монстра после каждой правки ростера (так и было: «zombie-brute» исчез при переименовании,
  // и бросок попадал в рыцаря, пока в ростере было 13 монстров).
  expect(reg.get('monsters').some((m) => m.id === baseId), `нет монстра ${baseId}`).toBe(true);
  return generateMonster(reg.get('monsters'), reg.get('monster-gear'), reg.get('monster-affixes'),
    { baseId, depth, mderive: reg.get('monster-derive'), itemAffixes: reg.get('affixes'), rarities: reg.get('rarities'), rarity: 'normal', monsterRarity: reg.get('monster-rarity'), monsterUniques: reg.get('monster-uniques') },
    createRng(1));
}

describe('кросс-чек: закрытая формула ≈ реальный движок (базовая атака)', () => {
  it('landedHitsToKill формулы согласуется со средним ударов микро-боя', () => {
    // Танковый моб (глубина ≫ уровня) → кил за много ударов: дискретность «≥1 удар» размывается,
    // формула и движок должны сойтись близко. (На ~1-ударных киллах отношение искажает целочисленность.)
    for (const level of [15, 25, 35]) {
      const save = buildBotAt(reg, classId, level, DEFAULT_BUILD, 7);
      // ⚠ 13.10: ГЛУБИНУ ИЩЕМ, А НЕ ЗАДАЁМ ЧИСЛОМ. Было `level * 2 + 10` — «танк, кил за много ударов».
      // План по силе поднял жизнь монстров с ×6.5 до ×160 за 10→80 — и на той же глубине бот перестал убивать
      // вовсе (killRate 0), то есть сторож проверял бы согласие двух моделей на пустом наборе. Предмет здесь —
      // СОГЛАСИЕ формулы и движка, а не конкретная глубина: берём САМУЮ ТАНКОВУЮ из тех, где бот ещё стабильно
      // убивает и ударов больше трёх. Так сторож живёт через любую правку баланса.
      // Кандидаты от самого танкового к самому хрупкому: рыцарь (strong, щит+латы) → боец (medium) → зомби (weak).
      const CAND: [string, number][] = [
        ['zombie-knight', level * 2 + 10], ['zombie-knight', level + 10], ['zombie-knight', level],
        ['zombie-fighter', level + 10], ['zombie-fighter', level], ['zombie', level + 10], ['zombie', level],
      ];
      const tries = CAND.map(([id, depth]) => {
        const m = mob(id, depth);
        return { id, depth, m, mc: microFightStats(reg, { save, monsters: [m], tier: 'basic' }, 60, 3) };
      });
      const ok = tries.filter((t) => t.mc.killRate > 0.7 && t.mc.hitsToKill.mean > 3);
      expect(ok.length, `нет монстра, которого бот ${level} ур. убивает за >3 ударов: ${tries.map((t) => `${t.id} гл.${t.depth} kill=${Math.round(t.mc.killRate * 100)}% ударов=${t.mc.hitsToKill.mean.toFixed(1)}`).join(' · ')}`).toBeGreaterThan(0);
      const { depth, m, mc } = ok[0]!;
      const cf = closedFormTtk(reg, save, m);
      const ratio = mc.hitsToKill.mean / cf.landedHitsToKill;
      console.log(`L${level} (${ok[0]!.id} гл.${depth}): движок=${mc.hitsToKill.mean.toFixed(2)} формула=${cf.landedHitsToKill.toFixed(2)} отношение=${ratio.toFixed(2)} kill=${Math.round(mc.killRate * 100)}%`);
      expect(ratio).toBeGreaterThan(0.7);           // формула и движок в согласии (±допуск на крит/роллы)
      expect(ratio).toBeLessThan(1.45);
    }
  });
});
