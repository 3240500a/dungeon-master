import type { ConfigShapes } from '../config/schemas.js';
import { emptyPacket, type CombatStats, type DamagePacket } from '../types/combat.js';
import type { MonsterAffix, ScaledMonster } from '../types/world.js';
import type { DebuffApply, DebuffKind } from '../world/debuffs.js';
import type { Rng } from './rng.js';

type Monsters = ConfigShapes['monsters'];
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

/** Коэффициенты прогрессивного роста стата монстра по уровню (см. balance.monsterScaling). */
export interface MonsterScaling {
  hpPerLevel: number;
  damagePerLevel: number;
  armorPerLevel: number;
  accuracyPerLevel: number;
  evadePerLevel: number;
  blockPerLevel: number;
  critPerLevel: number;
  resistPerLevel: number;
}

/** Фолбэк-коэффициенты (в синхроне с balance.monsterScaling) — для сима/тестов без конфига. */
const DEFAULT_SCALING: MonsterScaling = {
  hpPerLevel: 0.8, damagePerLevel: 0.3, armorPerLevel: 1, accuracyPerLevel: 3,
  evadePerLevel: 2, blockPerLevel: 0.004, critPerLevel: 0.003, resistPerLevel: 0.005,
};

/**
 * Генерирует экземпляр монстра: база из пула + прогрессивный масштаб всего стат-блока по
 * глубине (data-driven, коэффициенты из balance.monsterScaling) + 0–2 аффикса + редкость.
 */
export function generateMonster(
  monsters: Monsters,
  affixesPool: Affixes,
  opts: { baseId?: string; depth: number; xpGrowth?: number; championXpMult?: number; scaling?: MonsterScaling },
  rng: Rng,
): ScaledMonster {
  const base = (opts.baseId ? monsters.find((b) => b.id === opts.baseId) : undefined) ?? rng.pick(monsters);
  const d = Math.max(0, opts.depth);
  const xpGrowth = opts.xpGrowth ?? 0.2; // прирост опыта за уровень (balance.monsterXpGrowth)
  const s = opts.scaling ?? DEFAULT_SCALING;

  const m: ScaledMonster = {
    ...base,
    hp: Math.round(base.hp * (1 + d * s.hpPerLevel)),
    minDamage: base.minDamage * (1 + d * s.damagePerLevel),
    maxDamage: base.maxDamage * (1 + d * s.damagePerLevel),
    armor: base.armor + d * s.armorPerLevel,
    accuracy: base.accuracy + d * s.accuracyPerLevel,
    evade: Math.round(base.evade + d * s.evadePerLevel),
    blockChance: base.blockChance + d * s.blockPerLevel,
    critChance: base.critChance + d * s.critPerLevel,
    resFire: base.resFire + d * s.resistPerLevel,
    resCold: base.resCold + d * s.resistPerLevel,
    resLightning: base.resLightning + d * s.resistPerLevel,
    resPoison: base.resPoison + d * s.resistPerLevel,
    xp: Math.round(base.xp * (1 + d * xpGrowth)),
    level: d + 1,
    rarity: 'normal',
    affixes: [],
    damage: 0,
  };

  const champion = rng.chance(0.08);
  if (champion) {
    m.rarity = 'champion';
    m.hp = Math.round(m.hp * 2.5);
    m.minDamage *= 1.5;
    m.maxDamage *= 1.5;
    m.xp = Math.round(m.xp * (opts.championXpMult ?? 3));
    m.hpRegen = Math.round(m.hp * 0.006); // ~0.6% HP/сек — тут «увечье» ценно
    m.name = `Чемпион: ${m.name}`;
  }

  const affCount = champion ? 2 : rng.chance(0.35) ? 1 : 0;
  const pool = [...affixesPool];
  for (let i = 0; i < affCount && pool.length > 0; i++) {
    const [aff] = pool.splice(rng.int(0, pool.length - 1), 1);
    if (!aff) break;
    applyAffix(m, aff);
    m.affixes.push(aff.id);
    m.name = `${aff.name} ${m.name}`;
  }

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
