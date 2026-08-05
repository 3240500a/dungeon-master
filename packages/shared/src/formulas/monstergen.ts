import type { ConfigShapes } from '../config/schemas.js';
import { emptyPacket, type CombatStats, type DamagePacket } from '../types/combat.js';
import type { MonsterAffix, ScaledMonster } from '../types/world.js';
import type { DebuffApply, DebuffKind } from '../world/debuffs.js';
import type { Rng } from './rng.js';
import { deriveMonsterStats, DEFAULT_MDERIVE, type MonsterDeriveScaling, type MonsterTemplate } from './monsterDerive.js';

type Monsters = ConfigShapes['monsters'];
type MonsterGear = ConfigShapes['monster-gear'];
type Gear = MonsterGear[number];
type GearWeapon = Extract<Gear, { kind: 'weapon' }>;
type GearArmor = Extract<Gear, { kind: 'armor' }>;
type GearShield = Extract<Gear, { kind: 'shield' }>;
type Affixes = ConfigShapes['monster-affixes'];
type PhysSubtypes = ConfigShapes['phys-subtypes'];
type MagicSubtypes = ConfigShapes['magic-subtypes'];
type Debuffs = ConfigShapes['debuffs'];
/** Форма блока `monster` состояния (прок от удара монстра). */
type MonsterProc = Debuffs[number]['monster'];

function applyAffix(m: ScaledMonster, aff: MonsterAffix): void {
  const rec = m as unknown as Record<string, number>;
  for (const [k, v] of Object.entries(aff.mult)) {
    if (v === undefined || typeof rec[k] !== 'number') continue;
    rec[k] = rec[k]! * v;
  }
  for (const [k, v] of Object.entries(aff.add)) {
    if (v === undefined) continue;
    rec[k] = (typeof rec[k] === 'number' ? rec[k]! : 0) + v;
  }
  if (aff.damageType) m.damageType = aff.damageType;
}

/** Резерв-оружие: если у монстра не задано/не найдено оружие — бьёт «кулаками» (валидный монстр). */
const FISTS: GearWeapon = {
  kind: 'weapon', id: '__fists', name: 'кулаки', faction: 'monster', enabled: true,
  weaponClass: 'mace', weight: 'light', attackType: 'melee', hands: 1,
  damageType: 'physical', minDamage: 1, maxDamage: 2, attackSpeed: 1,
};

/** Разрешить экипировку монстра по id-ссылкам его заготовки (оружие обязательно → фолбэк FISTS). */
function resolveGear(gear: MonsterGear, tpl: { weapon?: string; armor?: string; offhand?: string }): {
  weapon: GearWeapon; armor: GearArmor | null; shield: GearShield | null;
} {
  const weapon = (gear.find((g) => g.kind === 'weapon' && g.id === tpl.weapon) as GearWeapon | undefined) ?? FISTS;
  const armor = tpl.armor ? ((gear.find((g) => g.kind === 'armor' && g.id === tpl.armor) as GearArmor | undefined) ?? null) : null;
  const shield = tpl.offhand ? ((gear.find((g) => g.kind === 'shield' && g.id === tpl.offhand) as GearShield | undefined) ?? null) : null;
  return { weapon, armor, shield };
}

/**
 * Генерирует экземпляр монстра: заготовка из пула → боевой стат-блок ДЕРИВИТСЯ из АТРИБУТОВ
 * (STR/DEX/INT/VIT) + ЭКИПИРОВКИ по уровню (`deriveMonsterStats`, зеркально игроку) → +чемпион
 * (×hp/×dmg/реген) → 0–2 аффикса → редкость. `mderive` перекрывает коэффициенты деривации.
 */
export function generateMonster(
  monsters: Monsters,
  monsterGear: MonsterGear,
  affixesPool: Affixes,
  opts: { baseId?: string; depth: number; championXpMult?: number; forceChampion?: boolean; mderive?: MonsterDeriveScaling },
  rng: Rng,
): ScaledMonster {
  const base = (opts.baseId ? monsters.find((b) => b.id === opts.baseId) : undefined) ?? rng.pick(monsters);
  const level = Math.max(0, opts.depth) + 1;
  const { weapon, armor, shield } = resolveGear(monsterGear, base);
  const def = deriveMonsterStats(base as MonsterTemplate, weapon, armor, shield, level, opts.mderive ?? DEFAULT_MDERIVE);

  const m: ScaledMonster = { ...def, level, rarity: 'normal', affixes: [], damage: 0 };

  // rng-бросок делаем всегда (стабильный поток), форс — сверху.
  const champion = rng.chance(0.08) || opts.forceChampion === true;
  if (champion) {
    m.rarity = 'champion';
    m.hp = Math.round(m.hp * 2.5);
    m.minDamage *= 1.5;
    m.maxDamage *= 1.5;
    m.xp = Math.round(m.xp * (opts.championXpMult ?? 3));
    m.hpRegen = Math.max(1, Math.round(m.hp * 0.006)); // ~0.6% HP/сек (мин. 1) — тут «увечье» ценно
    m.name = `Чемпион: ${m.name}`;
  }

  const affCount = champion ? 2 : rng.chance(0.35) ? 1 : 0;
  const pool = affixesPool.filter((a) => (a as { enabled?: boolean }).enabled !== false); // выключенные аффиксы монстров не навешиваются
  for (let i = 0; i < affCount && pool.length > 0; i++) {
    const [aff] = pool.splice(rng.int(0, pool.length - 1), 1);
    if (!aff) break;
    applyAffix(m, aff);
    m.affixes.push(aff.id);
    m.name = `${aff.name} ${m.name}`;
  }

  m.hp = Math.max(1, Math.round(m.hp)); // афикс-мульты могли расчемпионить hp в дробь — округляем в конце
  m.minDamage = Math.round(m.minDamage);
  m.maxDamage = Math.max(m.minDamage, Math.round(m.maxDamage));
  m.damage = Math.round((m.minDamage + m.maxDamage) / 2);
  return m;
}

/** Боевой стат-блок монстра для resolveAttack. */
export function monsterCombatStats(m: ScaledMonster): CombatStats {
  return {
    accuracy: m.accuracy,
    evade: m.evade,
    armor: m.armor,
    armorPen: 0,
    blockChance: m.blockChance,
    critChance: m.critChance,
    critMultiplier: m.critMultiplier,
    resFire: m.resFire,
    resCold: m.resCold,
    resLightning: m.resLightning,
    resPoison: m.resPoison,
    ailmentPct: 0,
    level: m.level,
  };
}

/** Пакет урона удара монстра (весь урон в его damageType). */
export function buildMonsterPacket(m: ScaledMonster, rng: Rng): DamagePacket {
  const p = emptyPacket();
  p[m.damageType] += rng.float(m.minDamage, m.maxDamage);
  return p;
}

/** Один дебафф из блока `monster` подтипа: DoT (`magPerDamage`) → сила = доля от maxDamage монстра; иначе флэт mag/mag2. */
function monsterProc(kind: DebuffKind, maxDamage: number, md: MonsterProc): DebuffApply {
  const out: DebuffApply = {
    kind,
    chance: md.chance,
    maxStacks: md.maxStacks,
    durationMs: md.durationMs,
    mag: md.magPerDamage != null ? maxDamage * md.magPerDamage : md.mag,
  };
  if (md.mag2 != null) out.mag2 = md.mag2;
  return out;
}

/**
 * Дебаффы, которые монстр вешает на игрока: физ-статус по его `physSub` (подтип → вид) + стих-статус по его
 * `damageType`, если это стихия (подтип → ailment). Параметры наложения — из самого состояния (`debuffs[kind].monster`),
 * тот же источник, что у оружия (симметрично, никакого задвоения). `magPerDamage` — сила = доля от maxDamage монстра.
 */
export function monsterDebuffs(m: ScaledMonster, physSubs: PhysSubtypes, magicSubtypes: MagicSubtypes, debuffs: Debuffs): DebuffApply[] {
  const out: DebuffApply[] = [];
  if (m.physSub) {
    const sub = physSubs.find((s) => s.id === m.physSub);
    const md = sub && debuffs.find((d) => d.id === sub.kind)?.monster;
    if (sub && md) out.push(monsterProc(sub.kind, m.maxDamage, md));
  }
  if (m.damageType !== 'physical') {
    const sub = magicSubtypes.find((s) => s.id === m.damageType);
    const md = sub && debuffs.find((d) => d.id === sub.ailment)?.monster;
    if (sub && md) out.push(monsterProc(sub.ailment, m.maxDamage, md));
  }
  return out;
}
