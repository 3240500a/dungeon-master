/**
 * Типы симулятора баланса (эконом-бот + бой + прокачка). Чистые данные, без
 * Phaser/DOM. Ядро гоняется из редактора (вкладка) и CLI (`npm run sim`).
 */

export type ScenarioKind = 'fight' | 'floor' | 'progression';

/** Политика билда бота: как тратит атрибуты/скиллы и насколько пробует нестандарт. */
export interface BuildPolicy {
  /** Доля очков атрибутов в живучесть (пол). Остальное — профильный атрибут. */
  vitalityShare: number;
  /** Разброс билда: 0 — строго профиль, 1 — часто уходит в нестандарт. */
  variance: number;
  /** Тратить ли очки скиллов/золото в пассивы (иначе только база+гир). */
  useSkills: boolean;
  /** Уклон скиллов/пассивов: 0 — защита, 1 — урон. */
  offenseBias: number;
}

export interface SimSettings {
  scenario: ScenarioKind;
  classId: string;
  difficultyId: string;
  /** Для fight/floor — уровень персонажа и этаж. */
  level: number;
  floor: number;
  /** Для progression — до какого уровня и сколько сим-часов максимум. */
  targetLevel: number;
  maxHours: number;
  /** Монте-Карло итераций на точку. */
  iterations: number;
  seed: number;
  build: BuildPolicy;
  /** Секунд не-боевой части этажа (ходьба/исследование). */
  floorOverheadSec: number;
}

export const DEFAULT_BUILD: BuildPolicy = {
  vitalityShare: 0.35,
  variance: 0.3,
  useSkills: true,
  offenseBias: 0.5,
};

export interface FightResult {
  win: boolean;
  timeSec: number;
  /** Остаток HP игрока в конце (0..1). */
  playerHpFrac: number;
  /** Абсолютный остаток HP/маны в конце (для переноса между пачками этажа). */
  endHp: number;
  endMana: number;
  dpsOut: number;
  dpsIn: number;
  monstersKilled: number;
  xp: number;
}

/** Агрегат по N боям (Монте-Карло). */
export interface FightStats {
  winRate: number;
  avgTimeSec: number;
  avgHpFracOnWin: number;
  avgDpsOut: number;
  avgDpsIn: number;
  iterations: number;
}

export interface FloorResult {
  cleared: boolean;
  died: boolean;
  timeSec: number;
  xp: number;
  gold: number;
  drops: number;
  packsCleared: number;
  challengeLevel: number;
  /** Наименьший остаток HP (доля) по пачкам — прокси выживаемости для темпа. */
  minHpFrac: number;
}

export interface ProgressionPoint {
  level: number;
  hours: number;
  floor: number;
  power: number;
  deaths: number;
}

export interface ProgressionResult {
  reachedLevel: number;
  totalHours: number;
  deaths: number;
  curve: ProgressionPoint[];
  /** Этаж, где выживаемость просела ниже порога (или null). */
  wallFloor: number | null;
}
