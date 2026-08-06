import type { ConfigShapes } from '../config/schemas.js';
import { emptyPacket, type CombatStats, type DamagePacket } from '../types/combat.js';
import type { MonsterAffix, ScaledMonster, MonsterGearRoll } from '../types/world.js';
import type { RolledAffix } from '../types/items.js';
import type { DebuffApply, DebuffKind } from '../world/debuffs.js';
import type { Rng } from './rng.js';
import { rollAffixes, type AffixTarget } from './itemgen.js';
import { deriveMonsterStats, DEFAULT_MDERIVE, type MonsterDeriveScaling, type MonsterTemplate } from './monsterDerive.js';

type Monsters = ConfigShapes['monsters'];
type MonsterGear = ConfigShapes['monster-gear'];
type Gear = MonsterGear[number];
type GearWeapon = Extract<Gear, { kind: 'weapon' }>;
type GearArmor = Extract<Gear, { kind: 'armor' }>;
type GearShield = Extract<Gear, { kind: 'shield' }>;
type Affixes = ConfigShapes['monster-affixes'];
type ItemAffixes = ConfigShapes['affixes'];
type Rarities = ConfigShapes['rarities'];
type MonsterRarityCfg = ConfigShapes['monster-rarity'];
type MonsterUniques = ConfigShapes['monster-uniques'];
/** Редкость гира монстра как у предметов: 4 редкости. unique — топ (элит-статы + уник-имя + гир на всех слотах). */
type GearRarity = 'normal' | 'magic' | 'rare' | 'unique';
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

/**
 * Маппинг гир-афикса (item-движок) → стат монстра — «одна истина» по редкости с предметами. Проценты
 * урона (physPct/damagePct — kind:flat, но семантика %) множат урон; armor/acc/evade/ias/hp/ms — flat
 * или ×(1+v) по kind; резисты/крит/блок/реген — прибавка; прочее (атрибуты/мана/лич-стил) монстру не маппим.
 */
function applyGearAffix(m: ScaledMonster, mod: NonNullable<RolledAffix['modifier']>): void {
  const v = mod.value; const inc = mod.kind === 'increased';
  switch (mod.stat) {
    case 'minDamage': m.minDamage += v; break;
    case 'maxDamage': m.maxDamage += v; break;
    case 'physPct': case 'damagePct': m.minDamage *= 1 + v; m.maxDamage *= 1 + v; break;
    case 'addFire': case 'addCold': case 'addLightning': case 'addPoison': m.minDamage += v; m.maxDamage += v; break;
    case 'armor': m.armor = inc ? m.armor * (1 + v) : m.armor + v; break;
    case 'accuracy': m.accuracy = inc ? m.accuracy * (1 + v) : m.accuracy + v; break;
    case 'evade': m.evade = inc ? m.evade * (1 + v) : m.evade + v; break;
    case 'attackSpeed': m.attackSpeed = inc ? m.attackSpeed * (1 + v) : m.attackSpeed + v; break;
    case 'maxHp': m.hp = inc ? m.hp * (1 + v) : m.hp + v; break;
    case 'moveSpeed': m.moveSpeed = inc ? m.moveSpeed * (1 + v) : m.moveSpeed + v; break;
    case 'hpRegen': m.hpRegen += v; break;
    case 'critChance': m.critChance = Math.min(0.75, m.critChance + v); break;
    case 'blockChance': m.blockChance = Math.min(0.75, m.blockChance + v); break;
    case 'resFire': m.resFire += v; break;
    case 'resCold': m.resCold += v; break;
    case 'resLightning': m.resLightning += v; break;
    case 'resPoison': m.resPoison += v; break;
    default: break; // атрибуты/мана/лич-стил — монстру не применяем
  }
}

/** Слоты афиксов item-предмета по редкости (magic 1–2, rare 3–5) — как у лута, одна истина. */
function affixSlots(rarities: Rarities, rarity: GearRarity): { minAffixes: number; maxAffixes: number; maxPrefix: number; maxSuffix: number } {
  const r = rarities.find((x) => x.id === rarity);
  return { minAffixes: r?.minAffixes ?? 0, maxAffixes: r?.maxAffixes ?? 0, maxPrefix: r?.maxPrefix ?? 0, maxSuffix: r?.maxSuffix ?? 0 };
}

/** Сколько СЛОТОВ гира «прокачиваем» по редкости+уровню (не больше числа надетых). Нет конфига → все надетые. */
function affixedItemCount(cfg: MonsterRarityCfg | undefined, rarity: GearRarity, level: number, available: number): number {
  if (rarity === 'normal') return 0;
  const c = cfg?.find((x) => x.id === rarity);
  if (!c) return available;
  const n = c.minItems + Math.floor(Math.max(0, level - 1) / Math.max(1, c.levelsPerItem));
  return Math.min(Math.max(c.minItems, Math.min(n, c.maxItems)), available);
}

/** Уникальные слова-афиксы предмета (для отображения). */
function affixWords(rolled: RolledAffix[], itemAffixes: ItemAffixes): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const r of rolled) { if (seen.has(r.affixId)) continue; seen.add(r.affixId); out.push(itemAffixes.find((a) => a.id === r.affixId)?.word || r.affixId); }
  return out;
}

/** Элит-буст (чемпион/уник): жирный HP/урон/xp + реген (мин. 1). */
function eliteBoost(m: ScaledMonster, xpMult: number): void {
  m.hp = Math.round(m.hp * 2.5);
  m.minDamage *= 1.5; m.maxDamage *= 1.5;
  m.xp = Math.round(m.xp * xpMult);
  m.hpRegen = Math.max(1, Math.round(m.hp * 0.006));
}

/** Имя уникального монстра из пула (по фракции; фолбэк — любой доступный, затем дефолт). */
function pickUniqueName(pool: MonsterUniques | undefined, faction: string, fallback: string, rng: Rng): string {
  const usable = (pool ?? []).filter((u) => (u as { enabled?: boolean }).enabled !== false);
  const byFaction = usable.filter((u) => u.faction === faction);
  const list = byFaction.length ? byFaction : usable;
  return list.length ? list[rng.int(0, list.length - 1)]!.name : `Уникальный ${fallback}`;
}

/** Имя магич./рарного монстра: слово-префикс + имя + слово-суффикс (как у magic-предмета). */
function monsterAffixName(name: string, rolled: RolledAffix[], itemAffixes: ItemAffixes): string {
  const wordOf = (id: string): string => itemAffixes.find((a) => a.id === id)?.word ?? '';
  const pre = wordOf(rolled.find((r) => r.kind === 'prefix')?.affixId ?? '');
  const suf = wordOf(rolled.find((r) => r.kind === 'suffix')?.affixId ?? '');
  let n = name;
  if (pre) n = `${pre} ${n}`;
  if (suf) n = `${n} ${suf}`;
  return n;
}

/** Резерв-оружие: если у монстра не задано/не найдено оружие — бьёт «кулаками» (валидный монстр). */
const FISTS: GearWeapon = {
  kind: 'weapon', id: '__fists', name: 'кулаки', faction: 'monster', enabled: true,
  weaponClass: 'mace', weight: 'light', attackType: 'melee', hands: 1,
  damageType: 'physical', minDamage: 1, maxDamage: 2, attackSpeed: 1,
};

/** Разрешить экипировку монстра по id-ссылкам его заготовки (оружие обязательно → фолбэк FISTS). 4 слота. */
function resolveGear(gear: MonsterGear, tpl: { weapon?: string; armor?: string; helm?: string; offhand?: string }): {
  weapon: GearWeapon; armor: GearArmor | null; helm: GearArmor | null; shield: GearShield | null;
} {
  const weapon = (gear.find((g) => g.kind === 'weapon' && g.id === tpl.weapon) as GearWeapon | undefined) ?? FISTS;
  const armor = tpl.armor ? ((gear.find((g) => g.kind === 'armor' && g.id === tpl.armor) as GearArmor | undefined) ?? null) : null;
  const helm = tpl.helm ? ((gear.find((g) => g.kind === 'armor' && g.id === tpl.helm) as GearArmor | undefined) ?? null) : null;
  const shield = tpl.offhand ? ((gear.find((g) => g.kind === 'shield' && g.id === tpl.offhand) as GearShield | undefined) ?? null) : null;
  return { weapon, armor, helm, shield };
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
  opts: {
    baseId?: string; depth: number; uniqueXpMult?: number; mderive?: MonsterDeriveScaling;
    /** Редкость монстра = редкость его гира (item-афиксы + редкости). 4 редкости: normal/magic/rare/unique. */
    itemAffixes?: ItemAffixes; rarities?: Rarities; rarity?: GearRarity;
    /** Сколько слотов гира прокачивать по редкости+уровню (monster-rarity). Нет → все надетые. */
    monsterRarity?: MonsterRarityCfg;
    /** Пул имён уникальных монстров (для rarity:'unique'). */
    monsterUniques?: MonsterUniques;
  },
  rng: Rng,
): ScaledMonster {
  const base = (opts.baseId ? monsters.find((b) => b.id === opts.baseId) : undefined) ?? rng.pick(monsters);
  const level = Math.max(0, opts.depth) + 1;
  const { weapon, armor, helm, shield } = resolveGear(monsterGear, base);
  // Коэффициенты деривации: сначала переопределение самого моба (monster.derive), иначе — общие (opts.mderive).
  const mderive = (base as { derive?: MonsterDeriveScaling }).derive ?? opts.mderive ?? DEFAULT_MDERIVE;
  const def = deriveMonsterStats(base as MonsterTemplate, weapon, armor, shield, level, mderive, helm);

  const m: ScaledMonster = { ...def, level, rarity: 'normal', affixes: [], damage: 0 };

  if (opts.itemAffixes && opts.rarities) {
    // Редкость монстра = редкость его гира (4 редкости). По редкости+уровню N СЛОТОВ становятся magic/rare
    // (item-движок катает афиксы на каждом по его цели: оружие→оружейные, броня/шлем→броневые, щит→блок),
    // все афиксы маппятся в статы. Оружие «прокачиваем» первым (урон), остальное — по rng-порядку.
    const gearRar: GearRarity = opts.rarity ?? 'normal';
    // unique — топ-редкость: элит-статы (×hp/×dmg/реген) + уник-имя, гир катается на ВСЕХ слотах.
    if (gearRar === 'unique') eliteBoost(m, opts.uniqueXpMult ?? 3);
    const affRar: GearRarity = gearRar;
    const slotRar: GearRarity = affRar === 'unique' ? 'rare' : affRar; // у unique-предметов слоты игрока=0 → монстру берём rare
    m.rarity = gearRar; // normal/magic/rare/unique

    // Надетые слоты (оружие всегда) + цель афиксов + базовые статы каждого (для тултипа).
    const pieces: { slot: MonsterGearRoll['slot']; name: string; target: AffixTarget; base: MonsterGearRoll['base'] }[] = [
      { slot: 'weapon', name: weapon.name, target: { kind: 'weapon', slot: 'weapon', attackType: weapon.attackType, damageKind: weapon.damageType === 'physical' ? 'physical' : 'magic' }, base: { minDamage: weapon.minDamage, maxDamage: weapon.maxDamage, damageType: weapon.damageType, attackSpeed: weapon.attackSpeed } },
    ];
    if (armor) pieces.push({ slot: 'armor', name: armor.name, target: { kind: 'armor', slot: 'chest' }, base: { defense: armor.defense } });
    if (shield) pieces.push({ slot: 'shield', name: shield.name, target: { kind: 'shield', slot: 'offhand' }, base: { block: shield.block, defense: shield.defense } });
    if (helm) pieces.push({ slot: 'helm', name: helm.name, target: { kind: 'armor', slot: 'helm' }, base: { defense: helm.defense } });

    const nItems = affixedItemCount(opts.monsterRarity, affRar, level, pieces.length); // unique → все слоты
    // Выбор слотов: оружие первым (индекс 0), остальные — перетасованы rng (детерминизм по сиду).
    const restOrder = pieces.slice(1);
    for (let i = restOrder.length - 1; i > 0; i--) { const j = rng.int(0, i); [restOrder[i], restOrder[j]] = [restOrder[j]!, restOrder[i]!]; }
    const chosen = new Set<MonsterGearRoll['slot']>();
    if (nItems > 0) chosen.add(pieces[0]!.slot);
    for (const p of restOrder) { if (chosen.size >= nItems) break; chosen.add(p.slot); }

    const slots = affixSlots(opts.rarities, slotRar); // афиксов/предмет: rare-слоты для unique
    const allRolled: RolledAffix[] = [];
    const rolls: MonsterGearRoll[] = [];
    for (const p of pieces) {
      if (chosen.has(p.slot)) {
        const rolled = rollAffixes(opts.itemAffixes, p.target, slotRar, slots, level, rng);
        allRolled.push(...rolled);
        const mods = rolled.filter((r) => r.modifier).map((r) => r.modifier!);
        rolls.push({ slot: p.slot, name: p.name, rarity: affRar, affixes: affixWords(rolled, opts.itemAffixes), mods, base: p.base });
      } else {
        rolls.push({ slot: p.slot, name: p.name, rarity: 'normal', affixes: [], mods: [], base: p.base });
      }
    }
    for (const ra of allRolled) if (ra.modifier) applyGearAffix(m, ra.modifier);
    for (const id of new Set(allRolled.map((r) => r.affixId))) m.affixes.push(id);
    // Имя: unique — из пула (как у предметов); иначе слова афиксов вокруг базы.
    if (gearRar === 'unique') m.name = pickUniqueName(opts.monsterUniques, base.faction, m.name, rng);
    else if (allRolled.length) m.name = monsterAffixName(m.name, allRolled, opts.itemAffixes);
    m.gearRolls = rolls;
    // гир-афиксы могли раздробить деривнутые статы — округляем затронутое.
    m.armor = Math.max(0, Math.round(m.armor));
    m.accuracy = Math.round(m.accuracy);
    m.evade = Math.round(m.evade);
    m.hpRegen = Math.round(m.hpRegen);
    m.attackSpeed = Math.round(m.attackSpeed * 100) / 100;
    m.critChance = Math.round(m.critChance * 1000) / 1000;
  } else {
    // СТАРОЕ (депрекейт): monster-affixes стат-мульты — фолбэк для вызовов без item-афиксов.
    const affCount = rng.chance(0.35) ? 1 : 0;
    const pool = affixesPool.filter((a) => (a as { enabled?: boolean }).enabled !== false); // выключенные аффиксы монстров не навешиваются
    for (let i = 0; i < affCount && pool.length > 0; i++) {
      const [aff] = pool.splice(rng.int(0, pool.length - 1), 1);
      if (!aff) break;
      applyAffix(m, aff);
      m.affixes.push(aff.id);
      m.name = `${aff.name} ${m.name}`;
    }
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
