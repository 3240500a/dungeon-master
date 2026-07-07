import type { StatModifier } from './attributes.js';

/** Стоимость прокачки узла. Активные — за очки, пассивные — за золото. */
export interface SkillCost {
  type: 'points' | 'gold';
  amount: number;
}

/** Механика активного скилла (совпадает со схемой `skills-active`). */
export type SkillActiveType =
  | 'strike' | 'cleave' | 'nova' | 'projectile' | 'boomerang' | 'dash'
  | 'curse' | 'buff' | 'toggle' | 'ground' | 'meteor';

/** Наложение стихийного статуса при попадании скилла. */
export interface SkillAilment {
  chance: number;
  mag: number;
  mag2?: number;
  maxStacks: number;
  durationMs: number;
}

/**
 * Исполняемая часть активного скилла. Совпадает с zod-схемой `skills-active`
 * (движок `session.ts` читает эти же поля). Поля с дефолтами в схеме здесь
 * опциональны — легаси-узлы (без `type`) их не задают.
 */
export interface SkillActive {
  /** id способности (легаси-роутинг по имени; для типизированных — просто ярлык). */
  abilityId: string;
  manaCost: number;
  /** Легаси-КД (сек). 0 — новая модель (скорость от attackSpeed). */
  cooldown: number;
  /** Механика. Нет → старое поведение по имени abilityId. */
  type?: SkillActiveType;
  /** Стихия урона (иначе — по имени abilityId). */
  element?: 'physical' | 'fire' | 'cold' | 'lightning' | 'poison';
  damageMult?: number;
  /** Коэффициент скорости удара (attackSpeed × speed). */
  speed?: number;
  count?: number;
  spread?: number;
  pierce?: boolean;
  radius?: number;
  arcMult?: number;
  rangeMult?: number;
  knockback?: number;
  stunSec?: number;
  ailment?: SkillAilment;
  /** Замах (сек) — окно, в которое удар можно прервать станом/ошеломлением. */
  windupSec?: number;
  toggleGroup?: string;
  reservePct?: number;
  buffMods?: StatModifier[];
  durationSec?: number;
}

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
