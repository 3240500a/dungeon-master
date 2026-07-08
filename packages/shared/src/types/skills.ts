import type { StatModifier } from './attributes.js';

/** Стоимость прокачки узла. Активные — за очки, пассивные — за золото. */
export interface SkillCost {
  type: 'points' | 'gold';
  amount: number;
}

/** Категория активного скилла (совпадает со схемой `skills-active`, дискриминатор). */
export type SkillCategory = 'attack' | 'cast' | 'aura' | 'stance' | 'buff';
/** Форма каста (стихийное заклинание). */
export type CastShape = 'projectile' | 'boomerang' | 'nova' | 'ground' | 'meteor' | 'curse';
export type WeaponTypeSel = 'melee' | 'ranged' | 'magic';
export type WeaponClassSel = 'sword' | 'axe' | 'mace' | 'dagger' | 'spear' | 'bow' | 'crossbow' | 'wand' | 'staff';
type DamageTypeSel = 'physical' | 'fire' | 'cold' | 'lightning' | 'poison';

/** Наложение стихийного статуса при попадании скилла. */
export interface SkillAilment {
  chance: number;
  mag: number;
  mag2?: number;
  maxStacks: number;
  durationMs: number;
}

/** Общие поля активной способности. */
interface ActiveCommon {
  abilityId: string;
  manaCost: number;
  /** КД, сек (0 = без КД, тайминг от attackSpeed×speed). */
  cooldown: number;
}
/** Ограничения оружия (attack/cast). Пусто → любое оружие. */
interface WeaponRestrict {
  weaponTypes?: WeaponTypeSel[];
  weaponClasses?: WeaponClassSel[];
  hands: 'any' | 'one' | 'two';
}

/** Атака: удар оружием (геометрия/состав от оружия) + моды/эффекты скилла. */
export interface AttackActive extends ActiveCommon, WeaponRestrict {
  category: 'attack';
  speed: number;
  damageMult: number;
  arcMult: number;
  rangeMult: number;
  windupSec: number;
  knockback: number;
  shoveChance: number;
  stunSec: number;
  element?: DamageTypeSel;
  ailment?: SkillAilment;
  /** Опц. рывок-гэпклоузер. */
  dash?: { speed: number; weightBonus: number };
}
/** Каст: стихийное заклинание (свод к element), форма — shape. */
export interface CastActive extends ActiveCommon, WeaponRestrict {
  category: 'cast';
  shape: CastShape;
  element?: DamageTypeSel;
  speed: number;
  damageMult: number;
  count: number;
  spread: number;
  pierce: boolean;
  radius: number;
  windupSec: number;
  knockback: number;
  shoveChance: number;
  stunSec: number;
  ailment?: SkillAilment;
}
/** Аура: тогл, резерв маны, стат-моды (пати-радиус — задел). */
export interface AuraActive extends ActiveCommon {
  category: 'aura';
  toggleGroup?: string;
  reservePct?: number;
  buffMods?: StatModifier[];
  radius?: number;
}
/** Стойка: личный тогл-эксклюзив. */
export interface StanceActive extends ActiveCommon {
  category: 'stance';
  toggleGroup?: string;
  reservePct?: number;
  buffMods?: StatModifier[];
}
/** Временный бафф: стат-моды за ману на durationSec. */
export interface BuffActive extends ActiveCommon {
  category: 'buff';
  durationSec: number;
  buffMods?: StatModifier[];
}

/** Исполняемая часть активного скилла (v2: дискриминирована по `category`). Совпадает со схемой. */
export type SkillActive = AttackActive | CastActive | AuraActive | StanceActive | BuffActive;

/** Условный «сет»-бонус: моды при надетом комплекте брони одного класса. */
export interface SkillSetBonus {
  /** id класса брони (из конфига armor-classes). */
  requireArmorClass: string;
  minPieces: number;
  mods: StatModifier[];
}

/** Реактивный триггер мастерства: условный эффект на боевое событие. */
export interface SkillTrigger {
  on: 'hit-dealt' | 'hit-taken';
  condition?: {
    targetBurning?: boolean;
    targetStunned?: boolean;
    targetFaction?: 'undead' | 'demon' | 'beast' | 'monster';
    selfHpBelowPct?: number;
    whileToggle?: string;
  };
  effect: {
    bonusDamagePct?: number;
    reflectPct?: number;
    reflectElement?: 'physical' | 'fire' | 'cold' | 'lightning' | 'poison';
    damageTakenReductionPct?: number;
  };
}

/**
 * Эффект узла. Пассивные узлы обычно дают `modifiers`. Активные узлы
 * дополнительно задают исполняемый скилл через `active`; мастерства — `triggers`.
 */
export interface SkillEffect {
  modifiers?: StatModifier[];
  active?: SkillActive;
  setBonus?: SkillSetBonus;
  triggers?: SkillTrigger[];
}

export type SkillNodeKind = 'active' | 'passive';

export interface SkillNode {
  id: string;
  kind: SkillNodeKind;
  name: string;
  description: string;
  cost: SkillCost;
  /** id узлов, которые нужно вложить прежде этого. */
  requires: string[];
  /** Максимум вложений (рангов). */
  maxRank: number;
  /** Минимальный уровень персонажа для прокачки (гейт активных веток). */
  levelReq: number;
  effect: SkillEffect;
  /** Координаты для отрисовки в редакторе-графе. */
  x: number;
  y: number;
}

/** Активное дерево одного класса: 3 ветки. */
export interface ActiveSkillTree {
  classId: string;
  branches: { id: string; name: string }[];
  nodes: (SkillNode & { branchId: string })[];
}

/** Общее пассивное дерево (одно на всех). */
export interface PassiveSkillTree {
  entryNodes: string[];
  /** Неориентированные связи узлов (смежность для прокачки + рёбра графа). */
  edges: [string, string][];
  nodes: (SkillNode & { notable?: boolean })[];
}
