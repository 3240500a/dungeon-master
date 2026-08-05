import type { Item, RolledAffix, Rarity } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { Rng } from './rng.js';

type ItemsBase = ConfigShapes['items.base'];
type Affixes = ConfigShapes['affixes'];
type Uniques = ConfigShapes['uniques'];
type ItemTiers = ConfigShapes['item-tiers'];

/** Статы базы, масштабируемые тиром (урон/броня). Прочие (скор.атаки/блок) — flat. */
const TIER_SCALED = new Set(['minDamage', 'maxDamage', 'armor']);

/**
 * Тир по уровню предмета, зажатый диапазоном [minTier, maxTier] базы. Лестница
 * сортируется по minItemLevel; берётся высший тир ≤ ilvl, но не ниже minTier и не
 * выше maxTier базы. Так «Ржавый нож» не станет Мифическим, а «мифрил» — Сломанным.
 */
export function pickTierClamped(
  tiers: ItemTiers | undefined,
  itemLevel: number,
  minTierId: string,
  maxTierId: string,
): ItemTiers[number] | undefined {
  if (!tiers || tiers.length === 0) return undefined;
  // Выключенные тиры не выбираются (фолбэк на все, если вдруг всё выключено — чтобы предметы генерились).
  const usable = tiers.filter((t) => t.enabled !== false);
  const sorted = [...(usable.length ? usable : tiers)].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const idOf = (id: string): number => {
    const i = sorted.findIndex((t) => t.id === id);
    return i < 0 ? -1 : i;
  };
  let byLevel = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.minItemLevel <= itemLevel) byLevel = i;
  const loRaw = idOf(minTierId), hiRaw = idOf(maxTierId);
  const lo = loRaw < 0 ? 0 : loRaw;
  const hi = hiRaw < 0 ? sorted.length - 1 : hiRaw;
  const clamped = Math.min(Math.max(byLevel, Math.min(lo, hi)), Math.max(lo, hi));
  return sorted[clamped];
}

function scaleBaseStats(stats: StatModifier[], mult: number): StatModifier[] {
  if (mult === 1) return stats;
  return stats.map((m) =>
    m.kind === 'flat' && TIER_SCALED.has(m.stat) ? { ...m, value: Math.round(m.value * mult) } : m);
}

/** Дефолт капа суммы требований (если не передан из `balance.maxTotalRequirement`). */
const MAX_REQ_TOTAL_DEFAULT = 180;
/**
 * Масштабирует требования тиром (`mult`) и КАПИТ сумму `maxTotal` ПРОПОРЦИОНАЛЬНО: если Σ>кап —
 * все атрибуты ужимаются в (кап/Σ) раз (только сила → кап силы; сила+ловк → делится по доле).
 * `maxTotal<=0` — без капа.
 */
function scaleReqs(reqs: Item['requirements'], mult: number, maxTotal: number = MAX_REQ_TOTAL_DEFAULT): Item['requirements'] {
  const scaled: Partial<Record<keyof Item['requirements'], number>> = {};
  let total = 0;
  for (const [k, v] of Object.entries(reqs)) { if (v !== undefined) { const s = v * mult; scaled[k as keyof Item['requirements']] = s; total += s; } }
  const f = maxTotal > 0 && total > maxTotal ? maxTotal / total : 1;
  const out: Item['requirements'] = {};
  for (const [k, s] of Object.entries(scaled)) { const r = Math.round((s as number) * f); if (r > 0) out[k as keyof Item['requirements']] = r; }
  return out;
}

/** Согласует прилагательное-тир по роду названия базы (Крепкий → Крепкое/Крепкая/Крепкие). */
function declineTier(adj: string, gender: string | undefined): string {
  if (!adj || gender === 'm' || !gender) return adj;
  const stem = adj.replace(/(ый|ий|ой)$/, '');
  if (stem === adj) return adj; // не прилагательное — как есть
  if (gender === 'f') return stem + 'ая';
  if (gender === 'n') return stem + 'ое';
  if (gender === 'p') return stem + (/[кгхжшчщ]$/.test(stem) ? 'ие' : 'ые');
  return adj;
}

function tieredName(prefix: string, baseName: string, gender?: string): string {
  return prefix ? `${declineTier(prefix, gender)} ${baseName}` : baseName;
}

/** Имя magic-предмета (D2): слово-префикс + база + слово-суффикс. Префикс склоняется по роду базы. */
function magicName(baseName: string, gender: string | undefined, rolled: RolledAffix[], wordById: Map<string, string>): string {
  const preW = wordById.get(rolled.find((a) => a.kind === 'prefix')?.affixId ?? '') ?? '';
  const sufW = wordById.get(rolled.find((a) => a.kind === 'suffix')?.affixId ?? '') ?? '';
  let name = baseName;
  if (preW) name = `${declineTier(preW, gender)} ${name}`;   // слово-прилагательное префикса
  if (sufW) name = `${name} ${sufW}`;                        // слово-суффикс (родительный, без склонения)
  return name;
}
/** Имя раре/уника: имя базы + титул. Титул-прилагательное согласуется по роду базы (declineTier),
 *  титул родительного падежа («Тёмных братьев», «Пепел древних») инвариантен. Пусто → только база. */
function titledName(baseName: string, gender: string | undefined, title: string): string {
  return title ? `${baseName} ${declineTier(title, gender)}` : baseName;
}
type RareTheme = 'fire' | 'cold' | 'lightning' | 'poison' | 'physical';
type RareGroup = 'leech' | 'crit' | 'onkill' | 'defense' | 'life' | 'mana' | 'might' | 'finesse' | 'haste' | 'ward';
interface RareNoun { t: string; themes?: RareTheme[] }
interface RareEpithet { t: string; groups?: RareGroup[] }
/** Стат УРОНА → тема основы (стихия из урона/резиста, физика из урона). Крит и резист-как-свойство — ниже. */
const STAT_THEME: Record<string, RareTheme> = {
  addFire: 'fire', resFire: 'fire',
  addCold: 'cold', resCold: 'cold',
  addLightning: 'lightning', resLightning: 'lightning',
  addPoison: 'poison', resPoison: 'poison',
  minDamage: 'physical', maxDamage: 'physical', physPct: 'physical', damagePct: 'physical',
};
/** Вторичный стат → группа эпитета (вампиризм/крит/защита/…). Урон здесь не участвует — он в основе. */
const STAT_GROUP: Record<string, RareGroup> = {
  lifeLeechPct: 'leech', manaLeechPct: 'leech', critChance: 'crit',
  lifeOnKill: 'onkill', manaOnKill: 'onkill',
  armor: 'defense', blockChance: 'defense', evade: 'defense',
  maxHp: 'life', hpRegen: 'life', vitality: 'life',
  maxMana: 'mana', manaRegen: 'mana', intelligence: 'mana',
  strength: 'might', dexterity: 'finesse', accuracy: 'finesse',
  attackSpeed: 'haste', moveSpeed: 'haste',
  resFire: 'ward', resCold: 'ward', resLightning: 'ward', resPoison: 'ward',
};
/** Порядок «интересности» вторичного свойства для эпитета (первое найденное на предмете — берём). */
const GROUP_PRIORITY: RareGroup[] = ['leech', 'crit', 'onkill', 'defense', 'mana', 'life', 'might', 'finesse', 'haste', 'ward'];

/** Тема ОСНОВЫ = тип урона предмета: доминантный стихийный УРОН → его стихия; иначе физ-урон →
 *  physical; иначе доминантный стихийный РЕЗИСТ → его стихия (fromResist); иначе нет темы (утилита). */
function primaryTheme(rolled: RolledAffix[]): { theme?: RareTheme; fromResist: boolean } {
  const dom = (pred: (s: string) => boolean): RareTheme | undefined => {
    let best: RareTheme | undefined, bv = -Infinity;
    for (const r of rolled) { const s = r.modifier?.stat; if (!s || !pred(s) || !STAT_THEME[s]) continue; const v = r.modifier!.value ?? 0; if (v > bv) { bv = v; best = STAT_THEME[s]; } }
    return best;
  };
  const dmgEl = dom((s) => s.startsWith('add'));
  if (dmgEl) return { theme: dmgEl, fromResist: false };
  if (rolled.some((r) => r.modifier && ['minDamage', 'maxDamage', 'physPct', 'damagePct'].includes(r.modifier.stat))) return { theme: 'physical', fromResist: false };
  const resEl = dom((s) => s.startsWith('res'));
  if (resEl) return { theme: resEl, fromResist: true };
  return { theme: undefined, fromResist: false };
}
/** Группа эпитета = главное вторичное свойство (по GROUP_PRIORITY). skipWard — не брать резист как
 *  свойство, если он уже стал основой (иначе «Мороз оберега» дублирует). Нет свойств → undefined. */
function secondaryGroup(rolled: RolledAffix[], skipWard: boolean): RareGroup | undefined {
  const present = new Set<RareGroup>();
  for (const r of rolled) { const g = r.modifier ? STAT_GROUP[r.modifier.stat] : undefined; if (g) present.add(g); }
  for (const g of GROUP_PRIORITY) { if (g === 'ward' && skipWard) continue; if (present.has(g)) return g; }
  return undefined;
}
const pickWord = <T extends { t: string }>(pool: T[], fallback: T[], all: T[], rng: Rng): T | undefined =>
  (pool.length ? pool : fallback.length ? fallback : all)[rng.int(0, (pool.length ? pool : fallback.length ? fallback : all).length - 1)];
/** Имя рарного предмета «говорящее»: ОСНОВА по типу урона (стихия/физика), ЭПИТЕТ по главному
 *  вторичному свойству — «Искра жажды» (молния + вампиризм). Всё выводится из роллнутых аффиксов.
 *  Нет основ в пуле → fallback (тир-имя). Резист тоже задаёт стихию основы. */
function rareItemName(baseName: string, gender: string | undefined, pool: { nouns: RareNoun[]; epithets: RareEpithet[] } | undefined, rolled: RolledAffix[], rng: Rng, fallback: string): string {
  const nouns = pool?.nouns ?? [], eps = pool?.epithets ?? [];
  if (nouns.length === 0) return fallback;
  const { theme, fromResist } = primaryTheme(rolled);
  const neutralN = nouns.filter((w) => !w.themes || w.themes.length === 0);
  const noun = pickWord(theme ? nouns.filter((w) => w.themes?.includes(theme)) : [], neutralN, nouns, rng)!.t;
  const grp = secondaryGroup(rolled, fromResist);
  const neutralE = eps.filter((w) => !w.groups || w.groups.length === 0);
  const ep = eps.length ? pickWord(grp ? eps.filter((w) => w.groups?.includes(grp)) : [], neutralE, eps, rng) : undefined;
  return titledName(baseName, gender, ep ? `${noun} ${ep.t}` : noun);
}

/** Поля экземпляра, зависящие от вида базы (сужение по kind), включая слот. */
function gearFields(base: ItemsBase[number]): Partial<Item> {
  if (base.kind === 'weapon') {
    return {
      slot: base.slot,
      attackType: base.attackType,
      damageKind: base.damageKind,
      damageType: base.damageType,
      hands: base.hands,
      weaponClass: base.weaponClass,
      weight: base.weight,
      physSub: base.physSub,
      stunChance: base.stunChance,
      armorPenPct: base.armorPenPct,
      arcMult: base.arcMult,
      reachMult: base.reachMult,
      lowHpBonusPct: base.lowHpBonusPct,
      knockback: base.knockback,
    };
  }
  if (base.kind === 'armor') return { slot: base.slot, armorClass: base.armorClass, beltSlots: base.beltSlots };
  if (base.kind === 'shield') return { slot: base.slot, shieldClass: base.shieldClass };
  if (base.kind === 'consumable') return { use: base.use }; // без слота — не экипируется
  return { slot: base.slot }; // jewelry — только слот + baseStats/requirements
}

/** Уровень предмета выводится из minTier (не задаётся руками): порог этого тира. */
function baseItemLevel(base: ItemsBase[number], tiers?: ItemTiers): number {
  return tiers?.find((t) => t.id === base.minTier)?.minItemLevel ?? 1;
}

type Rarities = ConfigShapes['rarities'];

let uidCounter = 0;
function nextUid(): string {
  return `it_${Date.now().toString(36)}_${(uidCounter++).toString(36)}`;
}

/**
 * ЕДИНАЯ сборка Item из базы — весь маппинг полей/сигнатур + масштаб тира в одном
 * месте. Все пути (старт, квест, магазин, дроп, уник) идут через него — без дублей.
 */
function buildItem(
  base: ItemsBase[number],
  o: { rarity: Rarity; name: string; itemLevel: number; statMult: number; reqMult: number; affixes: RolledAffix[]; maxReqTotal?: number },
): Item {
  return {
    uid: nextUid(),
    baseId: base.id,
    kind: base.kind,
    name: o.name,
    ...gearFields(base),
    rarity: o.rarity,
    itemLevel: o.itemLevel,
    requirements: scaleReqs(base.requirements, o.reqMult, o.maxReqTotal),
    baseStats: scaleBaseStats(base.baseStats, o.statMult),
    affixes: o.affixes,
    gridW: base.gridW,
    gridH: base.gridH,
    pos: null,
  };
}

/**
 * Normal-предмет из базы через ЕДИНЫЙ конвейер: тир берётся по itemLevel базы (как
 * у дропа — никаких исключений), имя согласуется по роду. Без аффиксов. `tiers` не
 * передан → базовый тир (×1.0, без префикса).
 */
export function itemFromBase(base: ItemsBase[number], tiers?: ItemTiers): Item {
  const ilvl = baseItemLevel(base, tiers);
  // Расходники не тирятся (нет префикса «Сломанное зелье» и масштаба урона/брони).
  const tier = base.kind === 'consumable' ? undefined : pickTierClamped(tiers, ilvl, base.minTier, base.maxTier);
  return buildItem(base, {
    rarity: 'normal',
    name: tieredName(tier?.name ?? '', base.name, base.gender),
    itemLevel: ilvl,
    statMult: tier?.statMult ?? 1,
    reqMult: tier?.reqMult ?? 1,
    affixes: [],
  });
}

/** Ищет базу по id и создаёт normal-предмет (тир по уровню); null — база не найдена. */
export function itemFromBaseId(itemsBase: ItemsBase, baseId: string, tiers?: ItemTiers): Item | null {
  const base = itemsBase.find((b) => b.id === baseId);
  return base ? itemFromBase(base, tiers) : null;
}

/** Катит редкость с учётом смещения темы (dropBias повышает шанс редких). Пороги —
 * data-driven (rarities.threshold), каскад rarest-first (unique→rare→magic→normal). */
export function rollRarity(dropBias: number, rng: Rng, rarities: Rarities): Rarity {
  const r = rng.next() / Math.max(0.0001, dropBias);
  // Выключенные редкости не роллятся (их порог пропускается — дроп «падает» к следующей доступной).
  const ordered = rarities.filter((x) => x.enabled !== false).sort((a, b) => a.threshold - b.threshold);
  for (const rar of ordered) if (r < rar.threshold) return rar.id;
  return 'normal';
}

/** Атрибуты — их бонусы всегда целые (округляем вверх). */
const ATTR_STATS = new Set(['strength', 'dexterity', 'intelligence', 'vitality']);

type Affix = Affixes[number];

/** Цель фильтра аффиксов по типу предмета (и база, и Item подходят). */
export interface AffixTarget { kind: string; slot?: string; attackType?: string; damageKind?: string }

/** Цель из базы (сужение дискриминированного union). */
function affixTargetOf(base: ItemsBase[number]): AffixTarget {
  const t: AffixTarget = { kind: base.kind };
  if ('slot' in base) t.slot = base.slot;
  if (base.kind === 'weapon') { t.attackType = base.attackType; t.damageKind = base.damageKind; }
  return t;
}

/** Токен appliesTo/exclude совпал с предметом? Вид / слот / грань оружия (weapon.melee|physical|…). */
function tokenMatches(tok: string, t: AffixTarget): boolean {
  if (tok === t.kind) return true;
  if (t.slot && tok === t.slot) return true;
  if (t.kind === 'weapon') {
    if (t.attackType && tok === `weapon.${t.attackType}`) return true;
    if (t.damageKind && tok === `weapon.${t.damageKind}`) return true;
  }
  return false;
}
/** Аффикс подходит предмету: exclude перебивает, пустой appliesTo = любой. */
function affixFits(affix: Affix, t: AffixTarget): boolean {
  if (affix.exclude.length && affix.exclude.some((x) => tokenMatches(x, t))) return false;
  if (affix.appliesTo.length === 0) return true;
  return affix.appliesTo.some((x) => tokenMatches(x, t));
}
type AffixSpec = { stat: string; modKind: 'flat' | 'increased'; tiers: { min: number; max: number; ilvl: number }[] };
/** Стат-моды аффикса: мультистат mods[] либо одностатовый stat+tiers. */
function affixSpecs(affix: Affix): AffixSpec[] {
  if (affix.mods && affix.mods.length) return affix.mods;
  if (affix.stat && affix.tiers.length) return [{ stat: affix.stat, modKind: affix.modKind, tiers: affix.tiers }];
  return [];
}
/** Есть ли у аффикса хоть один тир, доступный на этом ilvl, ИЛИ он прок-аффикс (без тиров). */
function affixEligible(affix: Affix, itemLevel: number): boolean {
  return !!affix.proc || affixSpecs(affix).some((s) => s.tiers.some((t) => t.ilvl <= itemLevel));
}
function rollSpec(spec: AffixSpec, itemLevel: number, rng: Rng): RolledAffix['modifier'] | null {
  const eligible = spec.tiers.filter((t) => t.ilvl <= itemLevel);
  if (eligible.length === 0) return null;
  const tier = eligible[eligible.length - 1]!; // лучший доступный тир
  const raw = rng.float(tier.min, tier.max);
  const value = ATTR_STATS.has(spec.stat) ? Math.ceil(raw) : Math.round(raw * 100) / 100;
  return { stat: spec.stat, kind: spec.modKind, value };
}
/** Один аффикс → 1+ RolledAffix (мультистат = несколько записей с общим affixId). */
function rollAffixMods(affix: Affix, itemLevel: number, rng: Rng): RolledAffix[] {
  const out: RolledAffix[] = [];
  for (const spec of affixSpecs(affix)) {
    const m = rollSpec(spec, itemLevel, rng);
    if (m) out.push({ affixId: affix.id, kind: affix.kind, modifier: m });
  }
  if (affix.proc) out.push({ affixId: affix.id, kind: affix.kind, proc: { skillId: affix.proc.skillId, level: affix.proc.level, chance: affix.proc.chance, trigger: affix.proc.trigger } });
  return out;
}
/** Взвешенный выбор аффикса по `weight` (нулевая сумма → равномерно). */
/** Эффективный вес аффикса на данной базе: базовый `weight` × произведение множителей `tagWeights`,
 *  чьи токены совпали с базой (PoE2: магическое оружие чаще катает стихии, физическое — физ и т.п.). */
function affixWeight(a: Affix, t: AffixTarget): number {
  let w = Math.max(0, a.weight);
  for (const tw of a.tagWeights) if (tokenMatches(tw.tag, t)) w *= tw.mult;
  return w;
}
function weightedPickAffix(pool: Affix[], t: AffixTarget, rng: Rng): Affix | undefined {
  if (pool.length === 0) return undefined;
  const total = pool.reduce((s, a) => s + affixWeight(a, t), 0);
  if (total <= 0) return pool[rng.int(0, pool.length - 1)];
  let roll = rng.next() * total;
  for (const a of pool) { roll -= affixWeight(a, t); if (roll < 0) return a; }
  return pool[pool.length - 1];
}

/**
 * Катит аффиксы по правилам D2: пул фильтруется по ТИПУ предмета (appliesTo/exclude), ilvl и гейту
 * magic/rare; общее число = rng(minAffixes,maxAffixes) распределяется по префиксам/суффиксам в
 * пределах maxPrefix/maxSuffix; выбор взвешенный по weight; из одной группы — не больше одного.
 */
export function rollAffixes(
  affixes: Affixes,
  target: AffixTarget,
  rarity: Rarity,
  slots: { minAffixes: number; maxAffixes: number; maxPrefix: number; maxSuffix: number },
  itemLevel: number,
  rng: Rng,
): RolledAffix[] {
  const rareGate = (a: Affix): boolean => (rarity === 'magic' ? a.onMagic : rarity === 'rare' ? a.onRare : true);
  const usable = affixes.filter((a) => a.enabled !== false && rareGate(a) && affixFits(a, target) && affixEligible(a, itemLevel));
  let prefixes = usable.filter((a) => a.kind === 'prefix');
  let suffixes = usable.filter((a) => a.kind === 'suffix');
  const total = Math.max(0, rng.int(slots.minAffixes, slots.maxAffixes));
  const out: RolledAffix[] = [];
  let nP = 0, nS = 0;
  for (let i = 0; i < total; i++) {
    const canP = nP < slots.maxPrefix && prefixes.length > 0;
    const canS = nS < slots.maxSuffix && suffixes.length > 0;
    if (!canP && !canS) break;
    const asPrefix = canP && canS ? rng.next() < 0.5 : canP;
    const pick = weightedPickAffix(asPrefix ? prefixes : suffixes, target, rng);
    if (!pick) break;
    const keep = (a: Affix): boolean => a.id !== pick.id && !(pick.group && a.group === pick.group);
    prefixes = prefixes.filter(keep);
    suffixes = suffixes.filter(keep);
    if (asPrefix) nP++; else nS++;
    out.push(...rollAffixMods(pick, itemLevel, rng));
  }
  return out;
}

/**
 * Генерирует предмет из базы (или уникум) с учётом редкости, iLvl и ТИРА. По ilvl
 * дропа берётся высший доступный тир (`opts.tiers`): урон/броня базы масштабируются
 * `statMult`, требования — `reqMult`, имя получает префикс тира. Аффиксы — по ilvl.
 */
export function generateItem(
  itemsBase: ItemsBase,
  affixes: Affixes,
  uniques: Uniques,
  opts: { dropBias: number; itemLevel: number; baseId?: string; tiers?: ItemTiers; rarities: Rarities; categoryWeights?: Record<string, number>; rareNames?: { nouns: RareNoun[]; epithets: RareEpithet[] }; forceRarity?: Rarity; maxReqTotal?: number },
  rng: Rng,
): Item {
  const rarity = opts.forceRarity ?? rollRarity(opts.dropBias, rng, opts.rarities); // песочница-редактор может форсить редкость
  // Эффективный itemLevel дропа = уровень вызова (глубина/сложность), но не ниже
  // itemLevel самой базы. Влияет на тир (зажатый диапазоном базы), аффиксы, цену.
  const dropIlvl = Math.max(1, Math.round(opts.itemLevel));

  const uniquePool = uniques.filter((u) => u.enabled !== false); // выключенные уники не выпадают
  if (rarity === 'unique' && uniquePool.length > 0) {
    const unique = rng.pick(uniquePool);
    const base = itemsBase.find((b) => b.id === unique.baseId);
    if (base) {
      const ilvl = Math.max(baseItemLevel(base, opts.tiers), dropIlvl);
      const tier = pickTierClamped(opts.tiers, ilvl, base.minTier, base.maxTier);
      return buildItem(base, {
        rarity: 'unique',
        name: titledName(base.name, base.gender, unique.name), // имя базы + титул уника
        itemLevel: ilvl,
        statMult: tier?.statMult ?? 1,
        reqMult: tier?.reqMult ?? 1,
        affixes: unique.fixedAffixes.map((fa) => ({ affixId: unique.id, kind: fa.kind, modifier: fa.modifier })),
        maxReqTotal: opts.maxReqTotal,
      });
    }
  }

  // Выбор базы: по baseId (магазин/квест), иначе — взвешенно по категориям (`categoryWeights` из
  // balance.loot) × per-item `dropWeight`. Без weights — прежнее поведение (равномерно по экипу).
  // Выключенные базы (enabled:false) не выпадают из случайного дропа (явный baseId — можно).
  const enabledBase = itemsBase.filter((b) => b.enabled !== false);
  const equipPool = enabledBase.filter((b) => b.kind !== 'consumable');
  const base = opts.baseId
    ? itemsBase.find((b) => b.id === opts.baseId) ?? rng.pick(equipPool)
    : opts.categoryWeights
      ? pickDropBase(enabledBase, opts.categoryWeights, rng)
      : rng.pick(equipPool);

  // Расходники (колбы) не роллят редкость/аффиксы/тир — всегда normal.
  const isConsumable = base.kind === 'consumable';
  const ilvl = Math.max(baseItemLevel(base, opts.tiers), dropIlvl);
  const tier = isConsumable ? undefined : pickTierClamped(opts.tiers, ilvl, base.minTier, base.maxTier);
  const effRarity: Rarity = isConsumable ? 'normal' : rarity === 'unique' ? 'rare' : rarity;
  const rDef = opts.rarities.find((x) => x.id === effRarity);
  const rolled = isConsumable ? [] : rollAffixes(
    affixes, affixTargetOf(base), effRarity,
    { minAffixes: rDef?.minAffixes ?? 0, maxAffixes: rDef?.maxAffixes ?? 0, maxPrefix: rDef?.maxPrefix ?? 0, maxSuffix: rDef?.maxSuffix ?? 0 },
    ilvl, rng);

  // Имя (D2): normal — тир-прилагательное; magic — слова аффиксов вокруг базы; rare — база + «основа эпитет».
  const tierName = tieredName(tier?.name ?? '', base.name, base.gender);
  let displayName = tierName;
  if (effRarity === 'magic') { const mn = magicName(base.name, base.gender, rolled, new Map(affixes.map((a) => [a.id, a.word]))); displayName = mn === base.name ? tierName : mn; }
  else if (effRarity === 'rare') displayName = rareItemName(base.name, base.gender, opts.rareNames, rolled, rng, tierName);

  return buildItem(base, {
    rarity: effRarity,
    name: displayName,
    itemLevel: ilvl,
    statMult: tier?.statMult ?? 1,
    reqMult: tier?.reqMult ?? 1,
    affixes: rolled,
    maxReqTotal: opts.maxReqTotal,
  });
}

/** Взвешенный индекс по массиву весов (роллит `rng.next()`); -1 при нулевой сумме. */
function weightedIndex(weights: number[], rng: Rng): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) return -1;
  let roll = rng.next() * total;
  for (let i = 0; i < weights.length; i++) { roll -= Math.max(0, weights[i]!); if (roll < 0) return i; }
  return weights.length - 1;
}

/**
 * Взвешенный выбор базы дропа в ДВА шага, чтобы доля категории НЕ зависела от числа баз в ней:
 * (1) выбрать КАТЕГОРИЮ по `categoryWeights` (доля категории целиком), (2) внутри — базу по её
 * `dropWeight` (тонкая настройка per-item). Категории с весом 0 или без баз не выпадают; при
 * нулевой сумме — фолбэк на равномерный выбор. Чистая функция.
 */
export function pickDropBase(itemsBase: ItemsBase, categoryWeights: Record<string, number>, rng: Rng): ItemsBase[number] {
  const byKind = new Map<string, ItemsBase[number][]>();
  for (const b of itemsBase) { const arr = byKind.get(b.kind) ?? []; arr.push(b); byKind.set(b.kind, arr); }
  const kinds = [...byKind.keys()].filter((k) => (categoryWeights[k] ?? 0) > 0);
  const ki = weightedIndex(kinds.map((k) => categoryWeights[k] ?? 0), rng);
  if (ki < 0) return rng.pick(itemsBase); // ни одной валидной категории → равномерно
  const pool = byKind.get(kinds[ki]!)!;
  const bi = weightedIndex(pool.map((b) => b.dropWeight ?? 1), rng);
  return pool[bi < 0 ? rng.int(0, pool.length - 1) : bi]!;
}
