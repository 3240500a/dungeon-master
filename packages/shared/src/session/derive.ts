import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { Attributes, DerivedStats, StatModifier } from '../types/attributes.js';
import type { CombatStats } from '../types/combat.js';
import type { Item } from '../types/items.js';
import { deriveStats, finalAttributes, modifiersFromItems } from '../formulas/stats.js';
import { DEFAULT_HP_MANA_SCALING } from '../types/attributes.js';
import { armorClassModifiers } from '../formulas/resolveArmor.js';
import { passiveTreeModifiers, activeTreeModifiers, setBonusModifiers, playerTriggers, type ResolvedTrigger } from '../formulas/skills.js';
import { combatStatsOf } from '../formulas/playerCombat.js';

/**
 * Headless-версия расчётов персонажа (то, что в клиенте делает GameState): те же
 * модификаторы (экипировка + класс брони + пассивки + мастерства) и те же чистые
 * формулы shared. Конфиг передаётся явно — функции чистые и переиспользуются
 * клиентом/сервером/симом одинаково.
 */

/** Полный боевой снимок игрока за один расчёт (кэшируется на тик). */
export interface PlayerSnapshot {
  modifiers: StatModifier[];
  derived: DerivedStats;
  attrs: Attributes;
  combat: CombatStats;
  /** Реактивные триггеры мастерств (условия проверяет сессия в бою). */
  triggers: ResolvedTrigger[];
}

/** Все надетые предметы списком. */
export function equippedItems(save: SaveState): Item[] {
  return Object.values(save.equipment).filter(Boolean) as Item[];
}

/** Все модификаторы: экипировка + штрафы класса брони + пассивки + мастерства. */
export function playerModifiers(save: SaveState, cfg: ConfigRegistry): StatModifier[] {
  const eq = equippedItems(save);
  const mods = modifiersFromItems(eq);
  mods.push(...armorClassModifiers(eq, cfg.get('armor-classes')));
  mods.push(...passiveTreeModifiers(cfg.get('skills-passive'), save.passiveSkills));
  mods.push(...activeTreeModifiers(cfg.get('skills-active'), save.classId, save.activeSkills));
  mods.push(...setBonusModifiers(cfg.get('skills-active'), save.classId, save.activeSkills, eq));
  return mods;
}

/**
 * Считает полный боевой снимок игрока (derived + итоговые атрибуты + combat-stats).
 * `extraMods` — рантайм-моды поверх персистентных (активные тоглы/стойки/баффы),
 * которые знает только сессия; для чистого расчёта из сейва передавать не нужно.
 */
export function playerSnapshot(save: SaveState, cfg: ConfigRegistry, extraMods: StatModifier[] = []): PlayerSnapshot {
  const modifiers = playerModifiers(save, cfg);
  if (extraMods.length) modifiers.push(...extraMods);
  const scaling = cfg.get('classes').find((c) => c.id === save.classId)?.derived ?? DEFAULT_HP_MANA_SCALING;
  const derived = deriveStats(save.attributes, modifiers, scaling, save.level);
  const attrs = finalAttributes(save.attributes, modifiers);
  const combat = combatStatsOf(derived, save.level);
  const triggers = playerTriggers(cfg.get('skills-active'), save.classId, save.activeSkills);
  return { modifiers, derived, attrs, combat, triggers };
}
