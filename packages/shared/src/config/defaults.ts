import balance from './data/balance.json' with { type: 'json' };
import classes from './data/classes.json' with { type: 'json' };
import itemsBase from './data/items-base.json' with { type: 'json' };
import affixes from './data/affixes.json' with { type: 'json' };
import uniques from './data/uniques.json' with { type: 'json' };
import monsters from './data/monsters.json' with { type: 'json' };
import monsterAffixes from './data/monster-affixes.json' with { type: 'json' };
import monsterRoles from './data/monster-roles.json' with { type: 'json' };
import packs from './data/packs.json' with { type: 'json' };
import difficulties from './data/difficulties.json' with { type: 'json' };
import biomes from './data/biomes.json' with { type: 'json' };
import floors from './data/floors.json' with { type: 'json' };
import runModifiers from './data/run-modifiers.json' with { type: 'json' };
import runTemplates from './data/run-templates.json' with { type: 'json' };
import itemTiers from './data/item-tiers.json' with { type: 'json' };
import armorClasses from './data/armor-classes.json' with { type: 'json' };
import physSubtypes from './data/phys-subtypes.json' with { type: 'json' };
import weaponWeights from './data/weapon-weights.json' with { type: 'json' };
import damageKinds from './data/damage-kinds.json' with { type: 'json' };
import magicSubtypes from './data/magic-subtypes.json' with { type: 'json' };
import debuffs from './data/debuffs.json' with { type: 'json' };
import rarities from './data/rarities.json' with { type: 'json' };
import masteryTree from './data/mastery-tree.json' with { type: 'json' };
import skillTree from './data/skill-tree.json' with { type: 'json' };
import questsMain from './data/quests-main.json' with { type: 'json' };
import questsRandom from './data/quests-random.json' with { type: 'json' };
import roomPrefabs from './data/room-prefabs.json' with { type: 'json' };

/** Сырые данные конфигов по умолчанию (до валидации). */
export const defaultConfigData: Record<string, unknown> = {
  balance,
  classes,
  'items.base': itemsBase,
  affixes,
  uniques,
  monsters,
  'monster-affixes': monsterAffixes,
  'monster-roles': monsterRoles,
  packs,
  difficulties,
  biomes,
  floors,
  'run-modifiers': runModifiers,
  'run-templates': runTemplates,
  'item-tiers': itemTiers,
  'armor-classes': armorClasses,
  'phys-subtypes': physSubtypes,
  'weapon-weights': weaponWeights,
  'damage-kinds': damageKinds,
  'magic-subtypes': magicSubtypes,
  debuffs,
  rarities,
  'mastery-tree': masteryTree,
  'skill-tree': skillTree,
  'quests.main': questsMain,
  'quests.random': questsRandom,
  'room-prefabs': roomPrefabs,
};
