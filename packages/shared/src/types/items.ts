import type { Attribute, StatModifier } from './attributes.js';
import type { DamageType } from './combat.js';

export type Rarity = 'normal' | 'magic' | 'rare' | 'unique';

export const RARITY_ORDER: Rarity[] = ['normal', 'magic', 'rare', 'unique'];

/** Слоты экипировки. `offhand` — щит ИЛИ второе одноручное оружие. */
export type EquipSlot =
  | 'weapon'
  | 'offhand'
  | 'helm'
  | 'chest'
  | 'gloves'
  | 'boots'
  | 'belt'
  | 'ring'
  | 'amulet';

/** Тип атаки: ближний взмах vs снаряд. Задаёт паттерн базовой атаки (ЛКМ) и фолбэк-атрибут. */
export type AttackType = 'melee' | 'ranged';
/** Вид урона: физический (physSub-статусы, вес по Сила/Ловк) vs магический (стихия, вес=Инт, болт тратит ману). */
export type DamageKind = 'physical' | 'magical';

/** Вид предмета — дискриминатор базы (совпадает со схемой items.base). */
export type ItemKind = 'weapon' | 'armor' | 'shield' | 'jewelry' | 'consumable';

/** Эффект применения расходника (зелья/колбы). */
export interface ConsumableUse {
  /** Мгновенное лечение (плоское HP). */
  heal?: number;
  /** Лечение долей от макс. HP (0..1). */
  healPct?: number;
  /** Мгновенное восстановление маны (плоское). */
  mana?: number;
  /** Мана долей от макс. (0..1). */
  manaPct?: number;
  /** Снять все дебаффы. */
  cure?: boolean;
  /** Временные стат-моды и длительность (сек). */
  buffMods?: StatModifier[];
  buffDurationSec?: number;
}

/** Класс щита (вес) — задаёт профиль требований (лёгкий/средний/тяжёлый). */
export type ShieldClass = 'light' | 'medium' | 'heavy';

/** Класс оружия — ветвь дерева редактора + подпись в тултипе. */
export type WeaponClass =
  | 'sword' | 'axe' | 'mace' | 'dagger' | 'spear' | 'halberd'
  | 'bow' | 'crossbow' | 'wand' | 'staff';

/** Вес оружия — id из конфига weapon-weights (power/finesse/доли скейла — в конфиге). */
export type WeaponWeight = string;

/** Подтип физ. урона — id из конфига phys-subtypes (какой статус вешает — в конфиге). */
export type PhysSubtype = string;

/** Класс брони — id из конфига armor-classes (data-driven: штрафы/шум/выдержка в конфиге). */
export type ArmorClass = string;

/**
 * Сигнатурные свойства оружия (сверх baseStats). Все опциональны; масштабом тира
 * НЕ трогаются — это механика, а не числа урона. Читаются боевым контроллером.
 */
export interface WeaponSignature {
  weaponClass?: WeaponClass;
  /** Вес (профиль/требования/масштаб сигнатур). */
  weight?: WeaponWeight;
  /** Подтип физ. урона (стаковый дебафф). */
  physSub?: PhysSubtype;
  /** Шанс оглушить цель (0..1). */
  stunChance?: number;
  /** Игнор доли брони цели (0..1). */
  armorPenPct?: number;
  /** Множитель ширины дуги базовой атаки (топоры > 1). */
  arcMult?: number;
  /** Множитель дальности базовой атаки (копья > 1). */
  reachMult?: number;
  /** Доп. урон по целям с низким HP (0..1). */
  lowHpBonusPct?: number;
  /** Сила отбрасывания цели (px, 0 — нет). */
  knockback?: number;
}

/** Определение базы предмета из конфига (items.base). */
export interface ItemBase extends WeaponSignature {
  /** Класс брони (для брони/щитов). */
  armorClass?: ArmorClass;
  id: string;
  name: string;
  /** Род названия для согласования тир-префикса (м/ж/с/мн). */
  gender?: 'm' | 'f' | 'n' | 'p';
  /** Слот экипировки. У расходников отсутствует. */
  slot?: EquipSlot;
  /** Кол-во быстрых слотов пояса (для брони-пояса). */
  beltSlots?: number;
  /** Эффект применения (для kind='consumable'). */
  use?: ConsumableUse;
  /** Тип атаки (ближний/дальний). Только для оружия. */
  attackType?: AttackType;
  /** Вид урона (физический/магический). Только для оружия. */
  damageKind?: DamageKind;
  /** Тип базового урона оружия (physical для мили/луков, стихия для посохов). */
  damageType?: DamageType;
  /** Сколько рук занимает оружие (1 или 2). Двуручное блокирует offhand. */
  hands?: number;
  itemLevel: number;
  /** Базовые модификаторы, которые даёт сама база (без аффиксов). */
  baseStats: StatModifier[];
  /** Требования по атрибутам для надевания. */
  requirements: Partial<Record<Attribute, number>>;
  /** Размер в клетках инвентаря. */
  gridW: number;
  gridH: number;
}

/** Скатанный на предмете аффикс (конкретное значение из диапазона тира). */
export interface RolledAffix {
  affixId: string;
  kind: 'prefix' | 'suffix';
  modifier: StatModifier;
}

/** Конкретный экземпляр предмета (в мире/инвентаре/экипировке). */
export interface Item extends WeaponSignature {
  armorClass?: ArmorClass;
  /** Класс щита (для kind='shield'). */
  shieldClass?: ShieldClass;
  /** Вид предмета (оружие/броня/щит/украшение) — с базы. */
  kind?: ItemKind;
  /** Уникальный runtime-id экземпляра. */
  uid: string;
  baseId: string;
  name: string;
  /** Слот экипировки. У расходников отсутствует. */
  slot?: EquipSlot;
  /** Кол-во быстрых слотов пояса (для брони-пояса). */
  beltSlots?: number;
  /** Эффект применения (для kind='consumable'). */
  use?: ConsumableUse;
  attackType?: AttackType;
  damageKind?: DamageKind;
  damageType?: DamageType;
  hands?: number;
  rarity: Rarity;
  itemLevel: number;
  requirements: Partial<Record<Attribute, number>>;
  /** База + скатанные аффиксы, готовые к суммированию. */
  affixes: RolledAffix[];
  baseStats: StatModifier[];
  /** Размер в клетках инвентаря. */
  gridW: number;
  gridH: number;
  /** Позиция в сетке инвентаря (клетки). null — не размещён/на земле. */
  pos?: { x: number; y: number } | null;
}
