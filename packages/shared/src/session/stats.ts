import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { Attributes, StatModifier } from '../types/attributes.js';
import type { Item } from '../types/items.js';
import { effectiveLevel } from '../formulas/power.js';
import { estimateAttack } from '../formulas/playerCombat.js';
import { playerSnapshot, equippedItems } from './derive.js';

/**
 * Статистика прогона (как d2planner): финальный билд + статы забегов + кривые.
 * Чистые данные — CLI/редактор форматируют их в отчёт/карточку.
 */

export interface EquipSummary {
  slot: string;
  name: string;
  rarity: string;
  itemLevel: number;
  weaponType?: string;
  armorClass?: string;
  weight?: string;
  physSub?: string;
  affixes: string[];
}

export interface BuildSnapshot {
  classId: string;
  level: number;
  power: number;
  attributes: Attributes;
  effectiveAttributes: Attributes;
  derived: {
    maxHp: number;
    maxMana: number;
    armor: number;
    evade: number;
    critChance: number;
    attackSpeed: number;
    moveSpeed: number;
    avgHit: number;
  };
  equipment: EquipSummary[];
  skills: { id: string; rank: number }[];
  passiveNodes: number;
  passiveRanks: number;
}

export interface FloorLog {
  depth: number;
  timeSec: number;
  kills: number;
  deaths: number;
  goldGained: number;
  drops: number;
  xpGained: number;
}

export interface CurvePoint {
  timeSec: number;
  level: number;
  power: number;
  floor: number;
}

export interface RunReport {
  classId: string;
  difficultyId: string;
  seed: number;
  totalTimeSec: number;
  totalHours: number;
  deepestFloor: number;
  floorsCompleted: number;
  kills: number;
  deaths: number;
  goldEarned: number;
  itemsFound: number;
  xpEarned: number;
  killsPerHour: number;
  xpPerHour: number;
  lootPerHour: number;
  levelCurve: CurvePoint[];
  finalBuild: BuildSnapshot;
}

function modLabel(m: StatModifier): string {
  const sign = m.value >= 0 ? '+' : '';
  return m.kind === 'increased' ? `${sign}${Math.round(m.value * 100)}% ${m.stat}` : `${sign}${m.value} ${m.stat}`;
}

function equipSummary(item: Item, slot: string): EquipSummary {
  return {
    slot,
    name: item.name,
    rarity: item.rarity,
    itemLevel: item.itemLevel,
    weaponType: item.weaponType,
    armorClass: item.armorClass,
    weight: item.weight,
    physSub: item.physSub,
    affixes: item.affixes.map((a) => modLabel(a.modifier)),
  };
}

/** Снимок финального билда персонажа (d2planner-стиль). */
export function buildSnapshot(reg: ConfigRegistry, save: SaveState): BuildSnapshot {
  const snap = playerSnapshot(save, reg);
  const scaling = reg.get('balance').weaponAttrScaling;
  const avgHit = estimateAttack(snap.derived, snap.attrs, save.equipment.weapon, scaling, reg.get('weapon-weights'));
  const equipment: EquipSummary[] = [];
  for (const [slot, item] of Object.entries(save.equipment)) {
    if (item) equipment.push(equipSummary(item, slot));
  }
  const passiveRanks = Object.values(save.masteries).reduce((a, b) => a + b, 0);
  return {
    classId: save.classId,
    level: save.level,
    power: effectiveLevel(save, reg.get('balance').power).total,
    attributes: { ...save.attributes },
    effectiveAttributes: snap.attrs,
    derived: {
      maxHp: Math.round(snap.derived.maxHp),
      maxMana: Math.round(snap.derived.maxMana),
      armor: Math.round(snap.derived.armor),
      evade: Math.round(snap.derived.evade),
      critChance: Math.round(snap.derived.critChance * 1000) / 10,
      attackSpeed: Math.round(snap.derived.attackSpeed * 100) / 100,
      moveSpeed: Math.round(snap.derived.moveSpeed),
      avgHit: Math.round(avgHit * 10) / 10,
    },
    equipment,
    skills: Object.entries(save.skills).filter(([, r]) => r > 0).map(([id, rank]) => ({ id, rank })),
    passiveNodes: Object.values(save.masteries).filter((r) => r > 0).length,
    passiveRanks,
  };
}
