/** Первичные атрибуты персонажа. */
export type Attribute = 'strength' | 'dexterity' | 'intelligence' | 'vitality';

export const ATTRIBUTES: Attribute[] = [
  'strength',
  'dexterity',
  'intelligence',
  'vitality',
];

export type Attributes = Record<Attribute, number>;

/**
 * Per-класс масштабирование производных характеристик от уровня (data-driven, редактируется в классе).
 * `maxHp = hpBase + vitality·hpPerVitality + (level−1)·hpPerLevel`, аналогично мана
 * от интеллекта. Меткость: `accuracy += (level−1)·accuracyPerLevel` (рейтинг атаки растёт с уровнем,
 * чтобы не отставать от растущего уклонения монстров). Прибавки `*PerLevel` применяются с 2-го уровня.
 */
export interface HpManaScaling {
  hpBase: number;
  hpPerVitality: number;
  hpPerLevel: number;
  /** Базовый реген HP/сек (при 0 вын.). */
  hpRegenBase: number;
  /** Реген HP/сек за 1 очко выносливости. */
  hpRegenPerVitality: number;
  manaBase: number;
  manaPerIntelligence: number;
  /** Мана и от Живучести (мана ← Интеллект + Живучесть). */
  manaPerVitality: number;
  manaPerLevel: number;
  /** Базовый реген маны/сек. */
  manaRegenBase: number;
  manaRegenPerIntelligence: number;
  manaRegenPerVitality: number;
  /** Выносливость: база + от Силы и Ловкости (боевой ресурс). */
  staminaBase: number;
  staminaPerStrength: number;
  staminaPerDexterity: number;
  staminaPerLevel: number;
  staminaRegenBase: number;
  staminaRegenPerStrength: number;
  staminaRegenPerDexterity: number;
  /** Прибавка к меткости (рейтингу атаки) за каждый уровень после 1-го. */
  accuracyPerLevel: number;
}

/** Значения по умолчанию: пулы — прежняя формула (50 + вын·5 / 20 + инт·3); меткость +2 за уровень.
 *  HP-реген почти нулевой (0.1 + вын·0.01) — при малых пулах опора на зелья/вампиризм/гир; мана — как было. */
export const DEFAULT_HP_MANA_SCALING: HpManaScaling = {
  hpBase: 50,
  hpPerVitality: 5,
  hpPerLevel: 0,
  hpRegenBase: 0.1,
  hpRegenPerVitality: 0.01,
  manaBase: 20,
  manaPerIntelligence: 3,
  manaPerVitality: 1,
  manaPerLevel: 0,
  manaRegenBase: 0.5,
  manaRegenPerIntelligence: 0.05,
  manaRegenPerVitality: 0.02,
  staminaBase: 40,
  staminaPerStrength: 2,
  staminaPerDexterity: 1.5,
  staminaPerLevel: 0,
  staminaRegenBase: 3,
  staminaRegenPerStrength: 0.08,
  staminaRegenPerDexterity: 0.05,
  accuracyPerLevel: 2,
};

/** Производные (расчётные) характеристики. */
export interface DerivedStats {
  maxHp: number;
  maxMana: number;
  /** Пул выносливости — ресурс боевых активок (растёт от Силы/Ловкости). */
  maxStamina: number;
  /** Базовый физический урон до модификаторов оружия/скиллов. */
  minDamage: number;
  maxDamage: number;
  attackSpeed: number;
  /** Скорость каста (множитель): каст-тайм скиллов делится на неё. Растёт от Интеллекта. */
  castSpeed: number;
  critChance: number;
  critMultiplier: number;
  armor: number;
  /** Пробой брони цели (доля 0..1) — снижает эффективную броню защитника. */
  armorPen: number;
  moveSpeed: number;
  /** Меткость — рейтинг атаки (сравнивается с evade цели). */
  accuracy: number;
  /** Уклонение — рейтинг защиты (сравнивается с accuracy атакующего). */
  evade: number;
  /** Шанс блока (0..0.75) — только от оружия/щита. */
  blockChance: number;
  /** Плоская стихийная добавка к урону (с гира/скиллов). */
  addFire: number;
  addCold: number;
  addLightning: number;
  addPoison: number;
  /**
   * Множители исходящего урона (доля, 0.1 = +10%). Применяются к пакету удара/каста:
   * `damagePct` бустит ВЕСЬ урон (слабее), *Pct — только свою стихию. Складываются.
   */
  damagePct: number;
  physPct: number;
  firePct: number;
  coldPct: number;
  lightningPct: number;
  poisonPct: number;
  /** % к наложению статусов/дебафов ударом (ГЛОБАЛЬНО шанс и сила × (1+ailmentPct)). */
  ailmentPct: number;
  /** Глобальная +% к ДЛИТЕЛЬНОСТИ статусов (× (1+ailmentDurPct)). */
  ailmentDurPct: number;
  // Per-kind %-наложения статусов: шанс/сила/длительность (ветки скиллов/пассивок). Складываются с глобальными.
  woundChancePct: number; woundPowerPct: number; woundDurPct: number;
  bleedChancePct: number; bleedPowerPct: number; bleedDurPct: number;
  sunderChancePct: number; sunderPowerPct: number; sunderDurPct: number;
  dazeChancePct: number; dazePowerPct: number; dazeDurPct: number;
  burnChancePct: number; burnPowerPct: number; burnDurPct: number;
  poisonChancePct: number; poisonPowerPct: number; poisonDurPct: number;
  shockChancePct: number; shockPowerPct: number; shockDurPct: number;
  freezeChancePct: number; freezePowerPct: number; freezeDurPct: number;
  /** Реген в секунду. */
  hpRegen: number;
  manaRegen: number;
  staminaRegen: number;
  /** Сопротивления стихиям как доля (−0.75..0.75), в UI × 100 = %. */
  resFire: number;
  resCold: number;
  resLightning: number;
  resPoison: number;
  /** Стойкость к прерыванию замаха (0..1) — шанс не сбить тяжёлый удар станом/ошеломлением. */
  interruptResist: number;
}

/**
 * Имя стата для модификатора: либо атрибут, либо производная характеристика.
 * Тип намеренно строковый (данные приходят из конфигов) — валидные имена
 * перечислены здесь как ориентир, но не сужают тип.
 */
export type StatName = Attribute | keyof DerivedStats;

/**
 * Модификатор характеристики. Складывается в общий пул перед расчётом.
 * `flat` прибавляется, `increased` — процентная прибавка (0.1 = +10%).
 */
export interface StatModifier {
  /** Имя стата (см. StatName); строковый, т.к. значения задаются в конфигах. */
  stat: string;
  kind: 'flat' | 'increased';
  value: number;
}
