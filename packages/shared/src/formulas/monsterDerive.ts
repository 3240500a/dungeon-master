import type { ConfigShapes } from '../config/schemas.js';
import type { MonsterDef, MonsterFaction, MonsterAi } from '../types/world.js';
import type { DamageType } from '../types/combat.js';
import type { PhysSubtype } from '../types/items.js';

/**
 * Деривация боевого стат-блока монстра из АТРИБУТОВ (STR/DEX/INT/VIT) + ЭКИПИРОВКИ — зеркально
 * игроку: VIT→HP, STR→урон/армор, DEX→меткость/уворот/скор.атаки/крит, INT→маг-урон. Урон = урон
 * оружия × скейл по ведущему атрибуту (по весу/типу оружия), защита — из брони, AI/тип урона — из
 * оружия. Атрибуты растут с уровнем (levelGrowth) → всё деривнутое масштабируется. Чистая функция.
 */

type Gear = ConfigShapes['monster-gear'][number];
type GearWeapon = Extract<Gear, { kind: 'weapon' }>;
type GearArmor = Extract<Gear, { kind: 'armor' }>;
type GearShield = Extract<Gear, { kind: 'shield' }>;

/** Авторская «заготовка» монстра (без боевых статов — они деривятся). */
export interface MonsterTemplate {
  id: string;
  name: string;
  faction: MonsterFaction;
  sprite: string;
  str: number; dex: number; int: number; vit: number;
  /** Роль/тир — для генерации пачек и множителей (xp). */
  role?: string;
  tier?: 'weak' | 'medium' | 'strong' | 'boss';
  /** Явный AI (иначе выводится из оружия). */
  ai?: MonsterAi;
  moveSpeed?: number;
  vision?: number; visionAngle?: number; hearing?: number;
  weight?: number;
}

/** Коэффициенты деривации (тюнятся; дефолты в синхроне с ощущением игрока). */
export interface MonsterDeriveScaling {
  levelGrowth: number; // прирост атрибутов за уровень (доля от базы)
  hpBase: number; hpPerVit: number; hpPerLevel: number;
  dmgPerAttr: number;  // +доля урона оружия за ед. ведущего атрибута
  armorPerStr: number;
  accBase: number; accPerLevel: number;
  evadeBase: number; evadePerDex: number;
  iasPerDex: number; critPerDex: number;
  resistPerLevel: number;
}
export const DEFAULT_MDERIVE: MonsterDeriveScaling = {
  levelGrowth: 0.1, hpBase: 6, hpPerVit: 1.2, hpPerLevel: 1,
  dmgPerAttr: 0.02, armorPerStr: 0.15,
  accBase: 20, accPerLevel: 3, evadeBase: 5, evadePerDex: 1.5,
  iasPerDex: 0.001, critPerDex: 0.0015, resistPerLevel: 0.005,
};

/** Базовые сопротивления по фракции (характер: нежить — яд+/огонь−, конструкт — яд+/молния−, демон — огонь+). */
const FACTION_RES: Record<MonsterFaction, Partial<Record<'resFire' | 'resCold' | 'resLightning' | 'resPoison', number>>> = {
  undead: { resPoison: 0.5, resFire: -0.25 },
  monster: { resPoison: 0.3, resLightning: -0.2 },
  demon: { resFire: 0.3 },
  beast: {},
};

/** Ведущий атрибут урона по оружию: магия→INT, дальний физ→DEX, мили тяж/сред→STR, лёгкий→DEX. */
function damageAttr(w: GearWeapon, str: number, dex: number, int: number): number {
  if (w.damageType !== 'physical') return int;
  if (w.attackType === 'ranged') return dex;
  return w.weight === 'heavy' || w.weight === 'medium' ? str : dex;
}

/** xp-множитель по тиру монстра. */
const TIER_XP: Record<NonNullable<MonsterTemplate['tier']>, number> = { weak: 0.7, medium: 1, strong: 1.8, boss: 4 };

export function deriveMonsterStats(
  tpl: MonsterTemplate,
  weapon: GearWeapon,
  armor: GearArmor | null,
  shield: GearShield | null,
  level: number,
  s: MonsterDeriveScaling = DEFAULT_MDERIVE,
): MonsterDef {
  const g = 1 + Math.max(0, level - 1) * s.levelGrowth; // рост атрибутов за уровень
  const str = tpl.str * g, dex = tpl.dex * g, int = tpl.int * g, vit = tpl.vit * g;

  const dmgMult = 1 + damageAttr(weapon, str, dex, int) * s.dmgPerAttr;
  const minDamage = Math.max(1, Math.round(weapon.minDamage * dmgMult));
  const maxDamage = Math.max(minDamage, Math.round(weapon.maxDamage * dmgMult));

  const res = FACTION_RES[tpl.faction] ?? {};
  const rl = Math.max(0, level - 1) * s.resistPerLevel;

  return {
    id: tpl.id,
    name: tpl.name,
    faction: tpl.faction,
    sprite: tpl.sprite,
    hp: Math.round(s.hpBase + vit * s.hpPerVit + level * s.hpPerLevel),
    minDamage,
    maxDamage,
    damageType: weapon.damageType as DamageType,
    physSub: weapon.physSub as PhysSubtype | undefined,
    attackSpeed: weapon.attackSpeed * (1 + dex * s.iasPerDex),
    moveSpeed: tpl.moveSpeed ?? 50,
    armor: Math.round((armor?.defense ?? 0) + (shield?.defense ?? 0) + str * s.armorPerStr),
    accuracy: Math.round(s.accBase + dex * 2 + level * s.accPerLevel),
    evade: Math.round(s.evadeBase + dex * s.evadePerDex),
    blockChance: shield ? shield.block : 0,
    critChance: Math.min(0.5, 0.05 + dex * s.critPerDex),
    critMultiplier: 1.5,
    hpRegen: 0,
    resFire: (res.resFire ?? 0) + rl,
    resCold: (res.resCold ?? 0) + rl,
    resLightning: (res.resLightning ?? 0) + rl,
    resPoison: (res.resPoison ?? 0) + rl,
    xp: Math.round((5 + level * 3) * (TIER_XP[tpl.tier ?? 'medium'])),
    ai: tpl.ai ?? (weapon.attackType === 'ranged' ? 'ranged-kiter' : 'melee-chaser'),
    vision: tpl.vision ?? 240,
    visionAngle: tpl.visionAngle ?? 100,
    hearing: tpl.hearing ?? 96,
    weight: tpl.weight ?? 100,
  };
}
