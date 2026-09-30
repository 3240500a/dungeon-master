import type { EarnedPoints, SaveState } from '../types/save.js';
import { levelForXp } from '../formulas/xp.js';

/** Поля баланса, нужные для начисления опыта и очков за уровень (структурно ⊆ balance). */
export interface LevelPointsBalance {
  xpTable: number[];
  attributePointsPerLevel: number;
  skillPointsPerLevel: number;
  masteryPointsPerLevel: number;
}

/**
 * Начисляет опыт и применяет левелапы (очки атрибутов/скиллов/пассивов). Мутирует `save`,
 * возвращает `{leveled}`. ЕДИНАЯ истина прокачки: используется и боевой наградой сессии
 * (`GameSession.awardXp`), и сдачей квеста на сервере (`turnInQuest`). Восстановление
 * HP/маны сущности при левелапе — забота вызывающего (сущность есть только в сессии).
 *
 * ⭐ D2: уровень только растёт (R9-05: кривая медленнее или потолок ниже — герой остаётся своим уровнем), очки за уровень — по конфигу
 * ЭТОГО мига, и выданное пишется в книгу заработанного (`save.earned`, если сейв её помнит — иначе её выведет дописка `settleEarned`
 * из того, что есть, и выданное здесь в неё войдёт). Правка конфига касается только будущих уровней.
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
    save.unspentMasteryPoints += b.masteryPointsPerLevel;
    creditEarned(save, { attributePoints: b.attributePointsPerLevel, skillPoints: b.skillPointsPerLevel, masteryPoints: b.masteryPointsPerLevel });
    leveled = true;
  }
  return { leveled };
}

/** ⭐ D2: выдача очков — в книгу заработанного (`save.earned`); сейв без книги — ничего (её выведет `settleEarned`). */
export function creditEarned(save: SaveState, got: Partial<EarnedPoints>): void {
  const e = save.earned;
  if (!e) return;
  e.attributePoints += got.attributePoints ?? 0;
  e.skillPoints += got.skillPoints ?? 0;
  e.masteryPoints += got.masteryPoints ?? 0;
}
