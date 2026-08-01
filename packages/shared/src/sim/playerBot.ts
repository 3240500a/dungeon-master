import { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import { deriveStats, finalAttributes, modifiersFromItems } from '../formulas/stats.js';
import { passiveTreeModifiers, skillTreeModifiers } from '../formulas/skills.js';
import { combatStatsOf, attackWeaponsOf, estimateAttack, WEAPON_ATTR } from '../formulas/playerCombat.js';
import { abilityRankMult, abilityCooldown } from '../formulas/combat.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { xpForLevel } from '../formulas/xp.js';
import type { Rng } from '../formulas/rng.js';
import { DEFAULT_HP_MANA_SCALING, type Attributes, type DerivedStats, type StatModifier } from '../types/attributes.js';
import type { CombatStats, DamageType } from '../types/combat.js';
import type { Item, AttackType } from '../types/items.js';
import { SAVE_VERSION, type SaveState } from '../types/save.js';
import type { BuildPolicy } from './types.js';

const ALL_ATTRS: (keyof Attributes)[] = ['strength', 'dexterity', 'intelligence', 'vitality'];

/** Пустой сейв бота уровня 1 выбранного класса (со стартовым оружием). */
export function newBotSave(reg: ConfigRegistry, classId: string): SaveState {
  const cls = reg.get('classes').find((c) => c.id === classId) ?? reg.get('classes')[0]!;
  const weapon = itemFromBaseId(reg.get('items.base'), cls.startWeaponId, reg.get('item-tiers'));
  const equipment: SaveState['equipment'] = {};
  if (weapon) equipment.weapon = weapon;
  return {
    version: SAVE_VERSION,
    name: 'Bot', charId: 'bot', createdAt: 0,
    classId: cls.id, level: 1, xp: 0, gold: 0,
    attributes: { ...cls.startAttributes },
    unspentAttributePoints: 0, unspentSkillPoints: 0, unspentMasteryPoints: 0,
    skills: {}, masteries: {},
    equipment, inventory: [], stash: [], belt: [],
    mouseLeft: 'attack', mouseRight: null,
    hotbar: [null, null, null],
    quests: [], activeQuestDefs: [], maxDepth: 0,
    difficultyProgress: {}, lastDifficulty: 'normal',
  };
}

/** Все модификаторы персонажа: гир + пассивы + мастерства (как GameState.allModifiers). */
export function characterModifiers(reg: ConfigRegistry, save: SaveState): StatModifier[] {
  const equipped = Object.values(save.equipment).filter(Boolean) as Item[];
  const mods = modifiersFromItems(equipped);
  mods.push(...passiveTreeModifiers(reg.get('mastery-tree'), save.masteries));
  mods.push(...skillTreeModifiers(reg.get('skill-tree'), save.skills));
  return mods;
}

/** Per-класс масштаб пулов HP/маны из конфига (фолбэк — дефолт). */
function classScaling(reg: ConfigRegistry, classId: string) {
  return reg.get('classes').find((c) => c.id === classId)?.derived ?? DEFAULT_HP_MANA_SCALING;
}

export function botDerived(reg: ConfigRegistry, save: SaveState): DerivedStats {
  return deriveStats(save.attributes, characterModifiers(reg, save), classScaling(reg, save.classId), save.level, reg.get('balance').moveSpeedBase);
}

export function botAttrs(reg: ConfigRegistry, save: SaveState): Attributes {
  return finalAttributes(save.attributes, characterModifiers(reg, save));
}

/** Профильный атрибут класса — по типу стартового оружия. */
export function classProfileAttr(reg: ConfigRegistry, classId: string): keyof Attributes {
  const cls = reg.get('classes').find((c) => c.id === classId);
  const w = cls ? reg.get('items.base').find((b) => b.id === cls.startWeaponId) : undefined;
  return WEAPON_ATTR[(w?.kind === 'weapon' ? w.attackType : 'melee') as AttackType];
}

/** Тратит нераспределённые очки атрибутов: профиль + пол живучести, с разбросом билда. */
export function allocateAttributes(
  save: SaveState,
  profile: keyof Attributes,
  policy: BuildPolicy,
  rng: Rng,
): void {
  while (save.unspentAttributePoints > 0) {
    save.unspentAttributePoints -= 1;
    let target: keyof Attributes = rng.next() < policy.vitalityShare ? 'vitality' : profile;
    // Разброс: иногда уходит в нестандартный атрибут (пробуем другие билды).
    if (rng.next() < policy.variance * 0.2) target = rng.pick(ALL_ATTRS);
    save.attributes[target] += 1;
  }
}

/** Догоняет бота до уровня L: выдаёт очки за уровни и распределяет атрибуты. */
export function levelUpBotTo(
  reg: ConfigRegistry,
  save: SaveState,
  level: number,
  policy: BuildPolicy,
  rng: Rng,
): void {
  const balance = reg.get('balance');
  const target = Math.max(1, Math.round(level));
  const gained = target - save.level;
  if (gained > 0) {
    save.unspentAttributePoints += gained * balance.attributePointsPerLevel;
    save.unspentSkillPoints += gained * balance.skillPointsPerLevel;
    save.unspentMasteryPoints += gained * balance.masteryPointsPerLevel;
    save.level = target;
    save.xp = xpForLevel(target, balance.xpTable);
  }
  allocateAttributes(save, classProfileAttr(reg, save.classId), policy, rng);
}

/** Способности AoE (бьют по всей пачке) — по abilityId, как в боевом контроллере. */
const AOE_RE = /nova|shout|taunt|caltrops|berserk|wolf|horn|rally|blizzard|meteor|trap|rain|skin|wall/;
/** Уклон монстров ближнего боя за счёт кайта игрока (по типу атаки). Стрелки кайт игнорируют. */
const KITE_DODGE: Record<AttackType, number> = { melee: 0, ranged: 0.35 };

function abilityElement(id: string): DamageType {
  if (/fire|flame|meteor/.test(id)) return 'fire';
  if (/frost|ice|cold|blizzard|nova/.test(id)) return 'cold';
  if (/shock|lightning|storm/.test(id)) return 'lightning';
  if (/poison|venom/.test(id)) return 'poison';
  return 'physical';
}

/** Выученная активка как каст: элемент, AoE, КД/мана, магнитуда удара, число снарядов. */
export interface SimSkill {
  element: DamageType;
  aoe: boolean;
  cooldown: number;
  manaCost: number;
  /** Урон одного попадания (в своём элементе) — как в executeAbility. */
  magnitude: number;
  /** Целей у одиночной способности (веер); у AoE — 0 (бьёт всех). */
  projectiles: number;
}

/** Собирает выученные активки в касты для тик-боя (магнитуда от базового удара оружия). */
function buildSkills(reg: ConfigRegistry, save: SaveState, d: DerivedStats, attrs: Attributes): SimSkill[] {
  const tree = reg.get('skill-tree');
  const scaling = reg.get('balance').weaponAttrScaling;
  const base = estimateAttack(d, attrs, save.equipment.weapon, scaling, reg.get('weapon-weights'));
  const skills: SimSkill[] = [];
  for (const node of tree.nodes) {
    const active = node.effect.active;
    const rank = save.skills[node.id] ?? 0;
    if (!active || rank <= 0) continue;
    const aoe = AOE_RE.test(active.abilityId);
    skills.push({
      element: abilityElement(active.abilityId),
      aoe,
      cooldown: abilityCooldown(active.cooldown, rank),
      manaCost: active.manaCost,
      magnitude: base * (aoe ? 1.5 : 1.4) * abilityRankMult(rank),
      projectiles: aoe ? 0 : 3,
    });
  }
  // Кастуются только 4 скилла (как хотбар в игре) — берём сильнейшие по магнитуде.
  return skills.sort((a, b) => b.magnitude - a.magnitude).slice(0, 4);
}

/** Боевая модель игрока для тик-боя (производные + оружие + скиллы + кайт). */
export interface PlayerModel {
  combat: CombatStats;
  attrs: Attributes;
  derived: DerivedStats;
  weapons: (Item | undefined)[];
  scaling: number;
  /** Справочник весов оружия (data-driven доли скейла/сигнатуры). */
  weights: ConfigShapes['weapon-weights'];
  /** Секунд между ударами (с учётом дуал-вилда). */
  attackInterval: number;
  maxHp: number;
  hpRegen: number;
  maxMana: number;
  manaRegen: number;
  /** Реальные касты (пусто, если политика без скиллов). */
  skills: SimSkill[];
  /** Шанс, что удар монстра ближнего боя пройдёт мимо из-за кайта (0 у мили). */
  kiteDodge: number;
}

export function makePlayerModel(
  reg: ConfigRegistry,
  save: SaveState,
  opts: { useSkills?: boolean } = {},
): PlayerModel {
  const mods = characterModifiers(reg, save);
  const d = deriveStats(save.attributes, mods, classScaling(reg, save.classId), save.level, reg.get('balance').moveSpeedBase);
  const attrs = finalAttributes(save.attributes, mods);
  const weapons = attackWeaponsOf(save);
  const dual = weapons.length > 1;
  const attackInterval = 1 / Math.max(0.2, d.attackSpeed * (dual ? 1.2 : 1));
  const mainAt: AttackType = save.equipment.weapon?.attackType ?? 'melee';
  return {
    combat: combatStatsOf(d, save.level),
    attrs, derived: d, weapons,
    scaling: reg.get('balance').weaponAttrScaling,
    weights: reg.get('weapon-weights'),
    attackInterval,
    maxHp: d.maxHp, hpRegen: d.hpRegen,
    maxMana: d.maxMana, manaRegen: d.manaRegen,
    skills: opts.useSkills ? buildSkills(reg, save, d, attrs) : [],
    kiteDodge: KITE_DODGE[mainAt],
  };
}
