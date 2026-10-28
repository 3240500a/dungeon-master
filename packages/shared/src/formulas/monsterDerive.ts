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

/** Коэффициенты деривации монстра (data-driven, конфиг `monster-derive`) — как деривация статов игрока:
 *  стартовые атрибуты монстра растут за уровень (levelGrowth), а из них считаются hp/урон/меткость/…
 *  по этим коэффициентам. Всё редактируемо → крутизна кривых задаётся здесь, тюнится в калькуляторе. */
export interface MonsterDeriveScaling {
  levelGrowth: number; // прирост атрибутов за уровень (доля от базы): A = base × (1 + (L-1)×levelGrowth)
  hpBase: number; hpPerVit: number; hpPerLevel: number;
  /**
   * ⭐ Крутизна кривой жизни: `hpPerVit` растёт как `(L/10)^hpVitPower`. 1 — линейно, 0 — выключено (плоско).
   * Это РЫЧАГ «ТОЛЬКО ЖИЗНЬ» (решение владельца 13.10): урон крутится ступенями оружия, и только
   * `levelGrowth` двигает обоих сразу. Уровень 10 — точка опоры: там множитель ровно 1 при любой крутизне.
   */
  hpVitPower: number;
  dmgPerAttr: number;  // +доля урона оружия за ед. ведущего атрибута
  armorPerStr: number;
  accBase: number; accPerLevel: number;
  evadeBase: number; evadePerDex: number;
  iasPerDex: number; critPerDex: number;
  resistPerLevel: number;
  xpBase: number; xpPerLevel: number;
  /** Множитель xp по силовому тиру монстра. */
  tierXp: Record<'weak' | 'medium' | 'strong' | 'boss', number>;
  /**
   * ⭐ 13.10 РАЗБРОС ВНУТРИ ПАЧКИ: множители жизни и урона по силовому тиру — «в пачке есть мясо и есть бумага».
   * До этого разница тиров держалась только на атрибутах (босс был толстее слабого всего в 6 раз), а босс добирал
   * своё собственным оверрайдом `derive.hpPerVit` — правка баланса боссов требовала ходить по монстрам. Теперь
   * это один рычаг на всех. Опыт (`tierXp`) сознательно НЕ трогали — решение владельца.
   */
  tierHp: Record<'weak' | 'medium' | 'strong' | 'boss', number>;
  tierDmg: Record<'weak' | 'medium' | 'strong' | 'boss', number>;
  /**
   * ⭐ 13.10: НАСКОЛЬКО БОСС-КОМНАТА ГЛУБЖЕ СВОЕГО ЭТАЖА — ДОЛЕЙ уровня, а не плоским числом уровней.
   * Надбавка = `max(1, round(уровень_этажа × bossRoomDepthPct))`, применяется в заселении (`dungeon/floor.ts`,
   * тот же шов у сима). Было плоское «+3».
   * ⚠ ПОЧЕМУ ДОЛЯ. Жизнь растёт степенью (`hpVitPower` 1.76), поэтому одно и то же «+3» значит совершенно разное:
   * замер — ×1.77 к жизни на 1-м уровне, ×2.07 на 4-м, ×1.14 на 60-м, ×1.04 на 200-м. То есть босс был стеной
   * на первых этажах и почти не отличался от рядового в бездне — ровно наоборот нужному. Доля 0.1 даёт
   * ×1.15…×1.33 на всём диапазоне 1…200 и на глубине 30 ровно +3 — там, где прежнее число и было откалибровано.
   */
  bossRoomDepthPct: number;
}
export const DEFAULT_MDERIVE: MonsterDeriveScaling = {
  levelGrowth: 0.1, hpBase: 10, hpPerVit: 3.37, hpPerLevel: 0, hpVitPower: 1.76,
  dmgPerAttr: 0.02, armorPerStr: 0.15,
  accBase: 20, accPerLevel: 3, evadeBase: 5, evadePerDex: 1.5,
  iasPerDex: 0.001, critPerDex: 0.0015, resistPerLevel: 0.005,
  xpBase: 12, xpPerLevel: 5, tierXp: { weak: 0.7, medium: 1, strong: 1.8, boss: 4 },
  tierHp: { weak: 0.5, medium: 1, strong: 2.5, boss: 10 },
  tierDmg: { weak: 0.8, medium: 1, strong: 1.5, boss: 3 },
  bossRoomDepthPct: 0.1,
};

/** Базовые сопротивления по фракции (характер: нежить — яд+/огонь−, конструкт — яд+/молния−, демон — огонь+). */
const FACTION_RES: Record<MonsterFaction, Partial<Record<'resFire' | 'resCold' | 'resLightning' | 'resPoison', number>>> = {
  undead: { resPoison: 0.5, resFire: -0.25 },
  monster: { resPoison: 0.3, resLightning: -0.2 },
  demon: { resFire: 0.3 },
  beast: {},
};

/**
 * Ведущий атрибут урона по оружию: магия→INT, дальний физ→DEX, мили с силовым перевесом→STR, иначе DEX.
 * ⚠ Список весов здесь ДУБЛИРУЕТ лестницу из `weapon-weights.json` (у монстра таблицы весов под рукой
 * нет — приходит только id). Добавили вес с перевесом силы — допишите его сюда, иначе монстр с ним
 * начнёт бить от ловкости, которой у него нет.
 */
const STR_WEIGHTS = new Set(['heavy', 'massive', 'medium']);
function damageAttr(w: GearWeapon, str: number, dex: number, int: number): number {
  if (w.damageType !== 'physical') return int;
  if (w.attackType === 'ranged') return dex;
  return STR_WEIGHTS.has(w.weight ?? '') ? str : dex;
}

export function deriveMonsterStats(
  tpl: MonsterTemplate,
  weapon: GearWeapon,
  armor: GearArmor | null,
  shield: GearShield | null,
  level: number,
  s: MonsterDeriveScaling = DEFAULT_MDERIVE,
  helm: GearArmor | null = null,   // 4-й слот (опц.): defense шлема суммируется с бронёй
): MonsterDef {
  const g = 1 + Math.max(0, level - 1) * s.levelGrowth; // рост атрибутов за уровень
  const str = tpl.str * g, dex = tpl.dex * g, int = tpl.int * g, vit = tpl.vit * g;

  const tier = tpl.tier ?? 'medium';
  // ⭐ 13.10: множитель тира — ВНУТРИ `dmgMult`, до округления: иначе мин и макс округляются дважды и вилка уезжает.
  const dmgMult = (1 + damageAttr(weapon, str, dex, int) * s.dmgPerAttr) * (s.tierDmg[tier] ?? 1);
  const minDamage = Math.max(1, Math.round(weapon.minDamage * dmgMult));
  const maxDamage = Math.max(minDamage, Math.round(weapon.maxDamage * dmgMult));

  const res = FACTION_RES[tpl.faction] ?? {};
  const rl = Math.max(0, level - 1) * s.resistPerLevel;

  return {
    id: tpl.id,
    name: tpl.name,
    faction: tpl.faction,
    sprite: tpl.sprite,
    // ⭐ 13.10: жизнь — ПРОГРЕССИВНЫЙ `hpPerVit`: `hpBase + vit × hpPerVit × (L/10)^hpVitPower` (+ линейный `hpPerLevel`,
    // в данных 0). Уровень 10 — точка опоры (множитель 1 при любой крутизне). Живучесть берётся ВЫРОСШАЯ
    // (`vit` уже с `levelGrowth`), чтобы `levelGrowth` оставался рычагом «и жизнь, и урон», а `hpVitPower` — только жизни.
    hp: Math.round((s.hpBase + vit * s.hpPerVit * Math.pow(Math.max(1, level) / 10, s.hpVitPower) + level * s.hpPerLevel) * (s.tierHp[tier] ?? 1)),
    minDamage,
    maxDamage,
    damageType: weapon.damageType as DamageType,
    physSub: weapon.physSub as PhysSubtype | undefined,
    attackSpeed: weapon.attackSpeed * (1 + dex * s.iasPerDex),
    moveSpeed: tpl.moveSpeed ?? 50,
    armor: Math.round((armor?.defense ?? 0) + (helm?.defense ?? 0) + (shield?.defense ?? 0) + str * s.armorPerStr),
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
    xp: Math.round((s.xpBase + level * s.xpPerLevel) * (s.tierXp[tier] ?? 1)),
    ai: tpl.ai ?? (weapon.attackType === 'ranged' ? 'ranged-kiter' : 'melee-chaser'),
    vision: tpl.vision ?? 240,
    visionAngle: tpl.visionAngle ?? 100,
    hearing: tpl.hearing ?? 96,
    weight: tpl.weight ?? 100,
  };
}
