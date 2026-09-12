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
  attackType?: string;
  damageKind?: string;
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

/**
 * Разбивка добычи за забег — ЧТО и СКОЛЬКО реально выпало.
 *
 * Нужна не для красоты: после перевода экономики на материалы «сколько выпало вещей» перестало
 * описывать поток наград. Здесь видно обе половины сразу — вещи по слотам и редкостям, материалы
 * по ступеням, и откуда что пришло (труп или сундук).
 */
export interface LootBreakdown {
  byType: Record<string, number>;   // weapon/armor/shield/jewelry/consumable
  byRarity: Record<string, number>; // normal/magic/rare/unique/…
  /** По слоту экипировки — сразу видно, какие слоты остались без источника. */
  bySlot: Record<string, number>;
  /** Сколько вещей пришло с трупа и сколько из сундуков. */
  fromMonsters: number;
  fromChests: number;
  /** Сколько вещей выпало СЛОМАННЫМИ (их нельзя надеть до кузнеца). */
  broken: number;
  /** Материалы по id: сколько единиц упало за забег. */
  materials: Record<string, number>;
  /** Материалы по ступеням 1/2/3 — главная сводка для баланса крафта. */
  materialsByTier: Record<string, number>;
  /** Сундуков открыто. */
  chestsOpened: number;
  /** Единиц материалов, полученных РАЗБОРОМ в поле (остальное — с монстров). */
  salvagedInField: number;
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
  goldEarned: number;   // с убийств монстров
  goldSold: number;     // выручено с продажи лута (дроп + заменённый гир)
  goldSpent: number;    // потрачено в магазине
  itemsBought: number;  // куплено в магазине
  itemsFound: number;
  /** Починено сломанных трофеев у кузнеца — и сколько раз поднят тир. Главные стоки золота. */
  itemsRepaired: number;
  itemsUpgraded: number;
  /** Золото, вложенное в пассивные узлы (цена растёт геометрически) — крупный тихий сток. */
  goldOnPassives: number;
  xpEarned: number;
  killsPerHour: number;
  xpPerHour: number;
  lootPerHour: number;
  loot: LootBreakdown;
  levelCurve: CurvePoint[];
  finalBuild: BuildSnapshot;
  /** Полный финальный сейв бота — для загрузки в калькулятор (карточка персонажа 1:1). */
  finalSave: SaveState;
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
    attackType: item.attackType,
    damageKind: item.damageKind,
    armorClass: item.armorClass,
    weight: item.weight,
    physSub: item.physSub,
    affixes: item.affixes.flatMap((a) => (a.modifier ? [modLabel(a.modifier)] : a.proc ? [`шанс каста ${a.proc.skillId}`] : [])),
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
