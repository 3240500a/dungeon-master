import type { Attributes, HpManaScaling } from './attributes.js';
import type { DamageType } from './combat.js';
import type { PhysSubtype } from './items.js';

/** Фракция монстра — основа аффинити классов (нежить/демоны · звери/монстры). */
export type MonsterFaction = 'undead' | 'demon' | 'beast' | 'monster';

/** Определение класса (Воин/Маг/Лучник). */
export interface ClassDef {
  id: string;
  name: string;
  startAttributes: Attributes;
  startWeaponId: string;
  /** id активного дерева скиллов этого класса. */
  activeTreeId: string;
  sprite: string;
  /** Фракции, против которых класс силён (+% урона по аффинити). */
  affinity: MonsterFaction[];
  /** Per-класс масштаб пулов HP/маны (от атрибутов и уровня). */
  derived: HpManaScaling;
}

export type MonsterAi = 'melee-chaser' | 'ranged-kiter' | 'stationary';

export interface MonsterDef {
  id: string;
  name: string;
  hp: number;
  minDamage: number;
  maxDamage: number;
  damageType: DamageType;
  /** Фракция — для аффинити классов. */
  faction: MonsterFaction;
  /** Подтип физ. урона — монстр вешает свой дебафф на игрока (опц.). */
  physSub?: PhysSubtype;
  attackSpeed: number;
  moveSpeed: number;
  armor: number;
  accuracy: number;
  evade: number;
  blockChance: number;
  critChance: number;
  /** Множитель крит-удара (паритет с игроком). */
  critMultiplier: number;
  /** Реген HP в секунду (0 у обычных; >0 у чемпионов/боссов — тогда «увечье» ценно). */
  hpRegen: number;
  resFire: number;
  resCold: number;
  resLightning: number;
  resPoison: number;
  xp: number;
  ai: MonsterAi;
  sprite: string;
  /** Радиус зрения (px). */
  vision: number;
  /** Полный угол конуса зрения (градусы). */
  visionAngle: number;
  /** Радиус слуха (px). */
  hearing: number;
  /** Вес (масса) для расталкивания сущностей. */
  weight: number;
}

export type MonsterRarity = 'normal' | 'champion';

/** Модификаторы аффикса монстра (умножения/добавки к полям + тип урона). */
export interface MonsterAffix {
  id: string;
  name: string;
  mult: Partial<Record<string, number>>;
  add: Partial<Record<string, number>>;
  damageType?: DamageType;
}

/** Сгенерированный экземпляр монстра (база + масштаб глубины + аффиксы + редкость). */
export interface ScaledMonster extends MonsterDef {
  rarity: MonsterRarity;
  affixes: string[];
  /** Уровень монстра (глубина+1) — для формулы брони. */
  level: number;
  /** Средний урон (для совместимости со старым кодом атаки). */
  damage: number;
}

/** Тема подземелья. */
export interface DungeonTheme {
  id: string;
  name: string;
  tileset: string;
  /** id монстров, доступных к спавну. */
  monsterPool: string[];
  /** Сдвиг таблицы дропа в этой теме (множитель редкости). */
  dropBias: number;
  modifiers: string[];
}
