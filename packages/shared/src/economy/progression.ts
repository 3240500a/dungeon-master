import type { SaveState } from '../types/save.js';
import { levelForXp } from '../formulas/xp.js';

/** Поля баланса, нужные для начисления опыта и очков за уровень (структурно ⊆ balance). */
export interface LevelPointsBalance {
  xpTable: number[];
  attributePointsPerLevel: number;
  skillPointsPerLevel: number;
  passivePointsPerLevel: number;
}

/**
 * Начисляет опыт и применяет левелапы (очки атрибутов/скиллов/пассивов). Мутирует `save`,
 * возвращает `{leveled}`. ЕДИНАЯ истина прокачки: используется и боевой наградой сессии
 * (`GameSession.awardXp`), и сдачей квеста на сервере (`turnInQuest`). Восстановление
 * HP/маны сущности при левелапе — забота вызывающего (сущность есть только в сессии).
 */
export function gainXp(save: SaveState, b: LevelPointsBalance, amount: number): { leveled: boolean } {
  if (amount <= 0) return { leveled: false };
  save.xp += amount;
  const target = levelForXp(save.xp, b.xpTable);
  let leveled = false;
  while (save.level < target) {
    save.level += 1;
    save.unspentAttributePoints += b.attributePointsPerLevel;
    save.unspentSkillPoints += b.skillPointsPerLevel;
    save.unspentPassivePoints += b.passivePointsPerLevel;
    leveled = true;
  }
  return { leveled };
}
