import type { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { newBotSave, levelUpBotTo, classProfileAttr, allocateAttributes } from '../sim/playerBot.js';
import { visitShop, allocateSkillsAndPassives } from '../sim/economy.js';
import { DEFAULT_BUILD, type BuildPolicy } from '../sim/types.js';
import type { SaveState } from '../types/save.js';
import { microFightStats } from './microFight.js';
import type { BotTier, BotStyle } from './bot.js';

/**
 * Агрегация/свипы поверх реального микро-боя (Ф4): строим уровне-адекватного бота и гоняем
 * сетку «уровень × монстр» → удары-до-смерти/TTK/death-rate. Числа для хитмапов калибровки
 * (цель ~5-6 ударов на моба). Всё детерминировано от сида.
 */

/** Бот уровня L с уровне-адекватным гиром/скиллами/атрибутами (как prepBotAt сервера/сима). */
export function buildBotAt(reg: ConfigRegistry, classId: string, level: number, build: BuildPolicy, seed: number): SaveState {
  const rng = createRng((seed >>> 0) || 1);
  const save = newBotSave(reg, classId);
  levelUpBotTo(reg, save, level, build, rng);
  save.gold += level * 200; // «как будто нафармил» — чтобы было на что купить гир по уровню
  const profile = classProfileAttr(reg, classId);
  // Несколько кругов магазин+распределение — гир/скиллы догоняют уровень (как в реальном забеге к этому уровню).
  for (let k = 0; k < 4; k++) {
    visitShop(reg, save, level, rng, build);
    allocateAttributes(save, profile, build, rng);
    allocateSkillsAndPassives(reg, save, build, rng);
  }
  return save;
}

export interface SweepCell {
  level: number;
  monsterId: string;
  hitsToKill: number;   // среднее ударов-до-смерти (то самое «5-6»)
  hitsP10: number;
  hitsP90: number;
  ttkSec: number;       // среднее время-до-смерти
  killRate: number;     // доля прогонов, где моб убит в лимит
  deathRate: number;    // доля прогонов, где игрок погиб
  dpsOut: number;
}

export interface SweepOpts {
  classId: string;
  levels: number[];
  monsterIds: string[];
  /** Смещение глубины моба от уровня игрока (моб = depth `level + depthOffset`). По умолчанию 0 (на-уровне). */
  depthOffset?: number;
  build?: BuildPolicy;
  tier?: BotTier;
  style?: BotStyle;
  /** Прогонов микро-боя на ячейку (Монте-Карло). По умолчанию 8. */
  runs?: number;
  seed?: number;
  rarity?: 'normal' | 'magic' | 'rare' | 'unique';
}

/**
 * Сетка ударов-до-смерти: для каждого уровня строим бота, для каждого монстра — микро-бой на N сидов.
 * Возвращает плоский список ячеек (редактор раскладывает в хитмап). Один бот на уровень (переиспользуется
 * по монстрам — микро-бой не мутирует сейв: economy=false).
 */
export function sweepHitsToKill(reg: ConfigRegistry, opts: SweepOpts): SweepCell[] {
  const build = opts.build ?? DEFAULT_BUILD;
  const runs = opts.runs ?? 8;
  const seed = (opts.seed ?? 1) >>> 0;
  const depthOff = opts.depthOffset ?? 0;
  const rarity = opts.rarity ?? 'normal';
  const monsters = reg.get('monsters');
  const gear = reg.get('monster-gear');
  const affx = reg.get('monster-affixes');
  const cells: SweepCell[] = [];

  for (const level of opts.levels) {
    const save = buildBotAt(reg, opts.classId, level, build, seed + level * 101);
    for (const monsterId of opts.monsterIds) {
      const depth = Math.max(0, level + depthOff);
      const mon = generateMonster(monsters, gear, affx, {
        baseId: monsterId, depth, mderive: reg.get('monster-derive'),
        itemAffixes: reg.get('monster-item-affixes'), rarities: reg.get('rarities'), rarity,
        monsterRarity: reg.get('monster-rarity'), monsterUniques: reg.get('monster-uniques'),
      }, createRng(1));
      const s = microFightStats(reg, { save, monsters: [mon], tier: opts.tier, style: opts.style }, runs, seed);
      cells.push({
        level, monsterId,
        hitsToKill: s.hitsToKill.mean, hitsP10: s.hitsToKill.p10, hitsP90: s.hitsToKill.p90,
        ttkSec: s.ttkSec.mean, killRate: s.killRate, deathRate: s.deathRate, dpsOut: s.dpsOutMean,
      });
    }
  }
  return cells;
}
