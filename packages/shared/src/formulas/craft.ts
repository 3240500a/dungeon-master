import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { CraftParts, Item, Rarity } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';
import type { MaterialCost } from '../economy/materials.js';
import { createRng, type Rng } from './rng.js';
import { affixTargetOfBase, buildCraftShell, inferTierId, nameByRarity, rollAffixes } from './itemgen.js';

/**
 * КОВКА ОРУЖИЯ ИЗ ДЕТАЛЕЙ — чистое ядро (docs/CRAFT_WEAPONS.md).
 *
 * ⭐ Один источник правды для трёх потребителей: сервер (когда ковку врежут в игру), окно ковки
 * в игре и песочница конфиг-редактора. Здесь нет ни DOM, ни сети, ни сейва — только
 * «конфиг + вход → вещь, цена, журнал».
 *
 * Устройство: у каждого класса ЧЕТЫРЕ гнезда с фиксированной ролью. Деталь = ФОРМА (точка на оси
 * своего гнезда, `weapon-parts.axis`) × МАТЕРИАЛ (ступень 1..5, одна на вещь). Форма решает
 * характер, материал — какой ступени вещь можно собрать. Вклад формы ВЫВОДИТСЯ из `axis` × шаг
 * гнезда (`balance.craft`), руками в вариант не пишется ни одно число — поэтому «деталь написала
 * в чужой стат» невозможно по построению, а вариантов может быть сколько угодно.
 */

type Base = ConfigShapes['items.base'][number];
type WeaponBase = Extract<Base, { kind: 'weapon' }>;
type Tier = ConfigShapes['item-tiers'][number];
export type WeaponPart = ConfigShapes['weapon-parts'][number];
export type WeaponAnatomy = ConfigShapes['weapon-anatomy'][number];
export type CraftTuning = ConfigShapes['balance']['craft'];

export type CraftSlot = 'strike' | 'grip' | 'bind' | 'head';
export const CRAFT_SLOT_LIST: readonly CraftSlot[] = ['strike', 'grip', 'bind', 'head'];
/** Роль гнезда одной строкой — для подписи в окне ковки. */
export const CRAFT_SLOT_ROLE: Record<CraftSlot, string> = {
  strike: 'урон ↔ скорость',
  grip: 'дальше ↔ шире',
  bind: 'префиксы ↔ суффиксы',
  head: 'укус ↔ упор',
};

const r4 = (x: number): number => Math.round(x * 10000) / 10000;
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

// ── Ступени предмета ─────────────────────────────────────────────────────────────────────────────

/** Ступени предмета по возрастанию (t0 … t6). Выключенные не участвуют, как и в дропе. */
export function craftTiers(reg: ConfigRegistry): Tier[] {
  const all = reg.get('item-tiers');
  const on = all.filter((t) => t.enabled !== false);
  return [...(on.length ? on : all)].sort((a, b) => a.minItemLevel - b.minItemLevel);
}

/** Индекс ступени по id (−1 — нет такой). */
export function tierIndex(reg: ConfigRegistry, id: string | undefined): number {
  return id ? craftTiers(reg).findIndex((t) => t.id === id) : -1;
}

/** Индекс ступени ЛЮБОЙ вещи: записанная, иначе выведенная по статам (старые сейвы). */
export function tierIndexOfItem(reg: ConfigRegistry, item: Item): number {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const id = item.tier ?? (base ? inferTierId(reg.get('item-tiers'), base, item) : undefined);
  return Math.max(0, tierIndex(reg, id));
}

// ── Материал: полоса ступеней ────────────────────────────────────────────────────────────────────

/** Ступеней материала в каждой семье. Одинаково у всех — иначе гнёзда рассинхронятся (§10.1). */
export const MATERIAL_STEPS = 5;

/**
 * ⭐ ПОЛОСА МАТЕРИАЛА: ступень `k` строит вещи тиров t(k)…t(k+1), первая дотягивается до t0.
 * Одна и та же у всех семей, поэтому «сталь уже дамасская, а древко ещё трухлявое» невозможно:
 * рассинхрон нечем создать. На t2…t5 на выбор ровно два материала — дешёвый на своём потолке
 * и дорогой на своём полу.
 */
export function materialBand(step: number): { lo: number; hi: number } {
  const k = clamp(Math.round(step), 1, MATERIAL_STEPS);
  return k === 1 ? { lo: 0, hi: 2 } : { lo: k, hi: Math.min(6, k + 1) };
}

/** Какие ступени материала покрывают ступень предмета `t`. */
export function stepsForTier(t: number): number[] {
  const out: number[] = [];
  for (let k = 1; k <= MATERIAL_STEPS; k++) { const b = materialBand(k); if (b.lo <= t && t <= b.hi) out.push(k); }
  return out;
}

/** id материала семьи на ступени: `iron` + 3 → `iron-3`. */
export const materialId = (family: string, step: number): string => `${family}-${step}`;

// ── Журнал кузнеца ───────────────────────────────────────────────────────────────────────────────

/**
 * ЖУРНАЛ КУЗНЕЦА (§12): что игрок уже умеет ковать. Чертежей как предметов нет — всё открывается
 * разбором найденных вещей у кузнеца. В игре живёт на АККАУНТЕ, рядом с кошельком материалов.
 */
export interface CraftJournal {
  /** Открытые базы (чертежи). */
  bases: string[];
  /** Открытые варианты деталей. */
  variants: string[];
  /** Высший тир (индекс), который игрок когда-либо разбирал. */
  tierHi: number;
  /** Разборы оружия по классам — счётчик к «эскизу» (жалость). */
  classSalvages: Record<string, number>;
  /** Неизрасходованные эскизы: каждый открывает любой неоткрытый вариант на выбор. */
  sketches: number;
  /** Разобрано мифических (t6) вещей — ворота t6. */
  mythic: number;
}

export function emptyJournal(): CraftJournal {
  return { bases: [], variants: [], tierHi: -1, classSalvages: {}, sketches: 0, mythic: 0 };
}

/** Журнал «всё открыто» — для песочницы, где проверяют баланс, а не петлю открытия. */
export function fullJournal(reg: ConfigRegistry): CraftJournal {
  return {
    bases: reg.get('items.base').filter((b) => b.kind === 'weapon').map((b) => b.id),
    variants: reg.get('weapon-parts').map((p) => p.id),
    tierHi: craftTiers(reg).length - 1,
    classSalvages: {},
    sketches: 0,
    mythic: reg.get('balance').craft.journal.mythicSalvages,
  };
}

/**
 * Потолок ступени, который разрешает журнал. t6 — особый случай ровно в одном месте, где его
 * просил владелец: мало разобрать ОДНУ мифическую вещь, нужно `mythicSalvages` штук.
 */
export function journalTierCap(reg: ConfigRegistry, j: CraftJournal): number {
  const last = craftTiers(reg).length - 1;
  const mythicOk = j.mythic >= reg.get('balance').craft.journal.mythicSalvages;
  return Math.min(j.tierHi, mythicOk ? last : last - 1);
}

// ── Анатомия и варианты ─────────────────────────────────────────────────────────────────────────

export function anatomyOf(reg: ConfigRegistry, weaponClass: string | undefined): WeaponAnatomy | undefined {
  return reg.get('weapon-anatomy').find((a) => a.id === weaponClass && a.enabled !== false);
}

/** Варианты гнезда для класса, по оси от «+1» к «−1» (так их и показывает окно ковки). */
export function variantsFor(reg: ConfigRegistry, weaponClass: string, slot: CraftSlot): WeaponPart[] {
  return reg.get('weapon-parts')
    .filter((p) => p.enabled !== false && p.slot === slot && (p.classes as string[]).includes(weaponClass))
    .sort((a, b) => b.axis - a.axis || a.id.localeCompare(b.id));
}

/** Сборка по умолчанию: в каждом гнезде вариант с осью ближе всего к нулю («эталон»). */
export function defaultParts(reg: ConfigRegistry, weaponClass: string): Omit<CraftParts, 'step'> | null {
  const pick = (slot: CraftSlot): string | undefined =>
    [...variantsFor(reg, weaponClass, slot)].sort((a, b) => Math.abs(a.axis) - Math.abs(b.axis))[0]?.id;
  const out = { strike: pick('strike'), grip: pick('grip'), bind: pick('bind'), head: pick('head') };
  return out.strike && out.grip && out.bind && out.head ? (out as Omit<CraftParts, 'step'>) : null;
}

export function partById(reg: ConfigRegistry, id: string): WeaponPart | undefined {
  return reg.get('weapon-parts').find((p) => p.id === id);
}

// ── Диапазон ступени ────────────────────────────────────────────────────────────────────────────

/**
 * На какой ступени можно сковать эту базу из этого материала (§11): снизу — полоса материала и
 * `minTier` базы, сверху — полоса, `maxTier` базы и журнал. null — никак.
 * ⭐ Деталь носит ПОРОГ, а не свою ступень: все четыре куются на ступени ВЕЩИ и по её цене, поэтому
 * «три дешёвые + одна t6» не существует как объект.
 */
export function craftTierRange(
  reg: ConfigRegistry,
  base: Base,
  step: number,
  journal?: CraftJournal,
): { lo: number; hi: number } | null {
  const band = materialBand(step);
  const baseLo = Math.max(0, tierIndex(reg, base.minTier ?? undefined));
  const maxT = tierIndex(reg, base.maxTier ?? undefined);
  const baseHi = maxT < 0 ? craftTiers(reg).length - 1 : maxT;
  const jHi = journal ? journalTierCap(reg, journal) : craftTiers(reg).length - 1;
  const lo = Math.max(band.lo, baseLo);
  const hi = Math.min(band.hi, baseHi, jHi);
  return lo <= hi ? { lo, hi } : null;
}

// ── Ёмкость аффиксов ────────────────────────────────────────────────────────────────────────────

export interface AffixForm { prefix: number; suffix: number }

/** Потолок Σ ёмкости по ступени (§6.2). Число слотов даёт ступень, выбор даёт форма. */
export function capacityOf(reg: ConfigRegistry, t: number): number {
  const ladder = reg.get('balance').craft.capacityByTier;
  return ladder[clamp(t, 0, ladder.length - 1)] ?? 0;
}

/**
 * ФОРМА ЁМКОСТИ из оси обвязки: +1 — всё в префиксы, −1 — в суффиксы, 0 — поровну.
 * ⚠ Зажата лимитами редкого (не больше 3 на сторону): формы 3+3 дроп не даёт вовсе, значит и
 * ковка её не даёт (§6.1). Поэтому на Σ=5 существуют только 3+2 и 2+3.
 */
export function formOf(sigma: number, axis: number): AffixForm {
  const s = Math.max(0, Math.round(sigma));
  const p = clamp(Math.round((s * (1 + clamp(axis, -1, 1))) / 2), Math.max(0, s - 3), Math.min(3, s));
  return { prefix: p, suffix: s - p };
}

export const formKey = (f: AffixForm): string => `${f.prefix}+${f.suffix}`;

/** Множитель цены формы M = 1 / частота такой-или-лучшей формы у найденных редких (§6.1). */
export function formMult(reg: ConfigRegistry, f: AffixForm): number {
  if (f.prefix + f.suffix === 0) return 1;
  return reg.get('balance').craft.formMult[formKey(f)] ?? 1;
}

// ── Грань и статус ──────────────────────────────────────────────────────────────────────────────

/**
 * Какой статус вешает это оружие: физическая грань (рана/кровотечение/увечье/ошеломление) или
 * стихия магического. ⚠ У луков и арбалетов грани нет (`physSub` пуст) — им вешать нечего.
 */
export function statusKindOf(reg: ConfigRegistry, w: { physSub?: string; damageKind?: string; damageType?: string }): string | undefined {
  if (w.physSub) return reg.get('phys-subtypes').find((p) => p.id === w.physSub)?.kind;
  if (w.damageKind === 'magical') return reg.get('magic-subtypes').find((m) => m.id === w.damageType)?.ailment;
  return undefined;
}

// ── Запекание деталей ───────────────────────────────────────────────────────────────────────────

export interface CraftBake {
  /** Что добавить в `baseStats` вещи. */
  mods: StatModifier[];
  /** Итоговые множители дальности и дуги (только ближний бой). */
  reachMult?: number;
  arcMult?: number;
  affixCap: AffixForm;
  statusKind?: string;
  /** Честные оговорки для окна: где ось сегодня не работает и почему. */
  notes: string[];
}

export interface ResolvedParts { strike: WeaponPart; grip: WeaponPart; bind: WeaponPart; head: WeaponPart }

/** ИД деталей → записи, с проверкой гнезда, класса и включённости. */
export function resolveParts(
  reg: ConfigRegistry,
  weaponClass: string,
  parts: Omit<CraftParts, 'step'>,
): { ok: true; parts: ResolvedParts } | { ok: false; reason: string } {
  const out: Partial<ResolvedParts> = {};
  for (const slot of CRAFT_SLOT_LIST) {
    const p = partById(reg, parts[slot]);
    if (!p || p.enabled === false) return { ok: false, reason: `Нет такой детали: ${parts[slot]}` };
    if (p.slot !== slot) return { ok: false, reason: `«${p.name}» не для этого гнезда` };
    if (!(p.classes as string[]).includes(weaponClass)) return { ok: false, reason: `«${p.name}» не подходит этому классу` };
    out[slot] = p;
  }
  return { ok: true, parts: out as ResolvedParts };
}

const baseFlat = (base: Base, stat: string): number =>
  base.baseStats.filter((m) => m.stat === stat && m.kind === 'flat').reduce((s, m) => s + m.value, 0);

/**
 * ⭐ ЗАПЕКАНИЕ: вклад четырёх гнёзд в статы самой вещи (§14). Нового множительного слоя в бою нет —
 * вклад ложится туда же, где живут урон и скорость любой найденной вещи, и сам доезжает до боя,
 * тултипа, стат-листа и калькулятора.
 */
export function bakeParts(reg: ConfigRegistry, base: WeaponBase, t: number, parts: ResolvedParts): CraftBake {
  const k = reg.get('balance').craft;
  const mods: StatModifier[] = [];
  const notes: string[] = [];
  const push = (stat: string, kind: 'flat' | 'increased', value: number): void => {
    const v = r4(value);
    if (v !== 0) mods.push({ stat, kind, value: v } as StatModifier);
  };

  // 1 · Ударная часть — единственная ось ДПС, зеркальная.
  const a1 = parts.strike.axis;
  push('damagePct', 'flat', k.strike.damagePct * a1);
  push('attackSpeed', 'increased', -k.strike.attackSpeed * a1);

  // 2 · Держак — площадь-нейтрально: дальность K^a, дуга K^(−2a), `дуга × дальность²` постоянна.
  let reachMult: number | undefined;
  let arcMult: number | undefined;
  const a2 = parts.grip.axis;
  if (base.attackType === 'melee') {
    reachMult = r4((base.reachMult ?? 1) * k.gripK ** a2);
    arcMult = r4((base.arcMult ?? 1) * k.gripK ** (-2 * a2));
  } else if (a2 !== 0) {
    notes.push('Держак у стрелкового и магического пока только вид: дальность снаряда — константа, честной оси нет (§5.2).');
  }

  // 4 · Оголовье — укус ↔ упор. Упор: блок (у лука — стойкость к прерыванию). Укус: статус грани.
  const a4 = parts.head.axis;
  const isBow = base.weaponClass === 'bow';
  if (isBow) {
    push('interruptResist', 'flat', k.headInterrupt * a4);
    if (a4 < 0) notes.push('Стойкость к прерыванию не бывает ниже нуля: у лука сторона укуса стоит бесплатно.');
  } else {
    push('blockChance', 'flat', k.headBlock * a4);
    const own = baseFlat(base, 'blockChance');
    if (a4 < 0 && own + k.headBlock * a4 < 0) {
      notes.push(`Блока у базы ${Math.round(own * 100)} % — минус упирается в ноль, и укус достаётся бесплатно (долг §7.2).`);
    }
  }
  const statusKind = statusKindOf(reg, base);
  const bite = statusKind ? k.bite[statusKind] : undefined;
  if (bite) push(bite.stat, 'flat', -bite.value * a4);
  else if (a4 !== 0) notes.push('У базы нет грани — рычагу статуса нечем торговать (§7.1).');

  // 3 · Обвязка — форма ёмкости. Число слотов даёт ступень.
  const affixCap = formOf(capacityOf(reg, t), parts.bind.axis);

  return { mods, reachMult, arcMult, affixCap, statusKind, notes };
}

// ── Цена ────────────────────────────────────────────────────────────────────────────────────────

export interface CraftCostLine { slots: CraftSlot[]; family: string; cheap: { id: string; n: number }; dear: { id: string; n: number } }
export interface CraftCost { materials: MaterialCost; gold: number; lines: CraftCostLine[]; mult: number }

/**
 * ЦЕНА КОВКИ (§13). ⭐ ОТНОСИТЕЛЬНАЯ: платится ступенью ниже выбранной и самой выбранной, то есть
 * ровно тем, что на этой ступени и падает, — иначе низ лестницы умирает. Раскладка по гнёздам
 * неравная (сигнатурное дороже), всё ×M формы: перекошенная форма дороже сбалансированной.
 */
export function craftCost(reg: ConfigRegistry, base: WeaponBase, t: number, step: number, form: AffixForm): CraftCost {
  const k = reg.get('balance').craft;
  const anat = anatomyOf(reg, base.weaponClass);
  const tier = craftTiers(reg)[t];
  const M = formMult(reg, form);
  const cheapStep = Math.max(1, step - 1);
  const buckets: { slots: CraftSlot[]; family: string; c: number; d: number }[] = [];
  if (anat) {
    buckets.push({ slots: ['strike'], family: anat.strike.family, c: k.cost.strike.cheap, d: k.cost.strike.dear });
    buckets.push({ slots: ['grip'], family: anat.grip.family, c: k.cost.grip.cheap, d: k.cost.grip.dear });
    if (anat.bind.family === anat.head.family) {
      buckets.push({ slots: ['bind', 'head'], family: anat.bind.family, c: k.cost.trim.cheap, d: k.cost.trim.dear });
    } else {
      // У лука обвязка — волокно, оголовье — плечи: прибор делится поровну между семьями.
      buckets.push({ slots: ['bind'], family: anat.bind.family, c: Math.ceil(k.cost.trim.cheap / 2), d: Math.ceil(k.cost.trim.dear / 2) });
      buckets.push({ slots: ['head'], family: anat.head.family, c: Math.ceil(k.cost.trim.cheap / 2), d: Math.ceil(k.cost.trim.dear / 2) });
    }
  }
  const materials: MaterialCost = {};
  const lines: CraftCostLine[] = [];
  for (const b of buckets) {
    const cheap = { id: materialId(b.family, cheapStep), n: Math.ceil(b.c * M) };
    const dear = { id: materialId(b.family, step), n: Math.ceil(b.d * M) };
    lines.push({ slots: b.slots, family: b.family, cheap, dear });
    for (const x of [cheap, dear]) if (x.n > 0) materials[x.id] = (materials[x.id] ?? 0) + x.n;
  }
  return { materials, gold: Math.round(k.cost.goldPerReqMult * (tier?.reqMult ?? 1)), lines, mult: M };
}

/** Хватает ли сырья и золота. Пустой список — хватает. */
export function craftMissing(wallet: MaterialCost, gold: number, cost: CraftCost): { materials: MaterialCost; gold: number } {
  const lack: MaterialCost = {};
  for (const [id, n] of Object.entries(cost.materials)) { const have = wallet[id] ?? 0; if (have < n) lack[id] = n - have; }
  return { materials: lack, gold: Math.max(0, cost.gold - gold) };
}

// ── Ковка ───────────────────────────────────────────────────────────────────────────────────────

export interface CraftInput {
  baseId: string;
  /** Индекс ступени (0 = t0). */
  tier: number;
  /** Ступень материала 1..5 — одна на вещь. */
  step: number;
  parts: Omit<CraftParts, 'step'>;
}

export interface CraftPreview {
  ok: boolean;
  reason?: string;
  item?: Item;
  cost?: CraftCost;
  bake?: CraftBake;
  /** Потолок, до которого вещь потом можно поднять: верх полосы материала и базы. */
  ceiling?: number;
  range?: { lo: number; hi: number };
}

/**
 * ⭐ СКОВАТЬ (или показать, что выйдет). Чистая: ничего не списывает — это делает вызывающий,
 * и ровно поэтому предпросмотр и ковка не могут разойтись: окно рисует тот же результат, за
 * который потом платят.
 *
 * `journal` — что открыто (нет → всё). `materialsOn` — проверять ли, что материалы ступени
 * включены в конфиге: в игре да, в песочнице можно смотреть и выключенные.
 */
export function craftWeapon(
  reg: ConfigRegistry,
  input: CraftInput,
  opts: { journal?: CraftJournal; materialsOn?: boolean } = {},
): CraftPreview {
  const base = reg.get('items.base').find((b) => b.id === input.baseId);
  if (!base || base.kind !== 'weapon') return { ok: false, reason: 'Такого оружия кузнец не знает' };
  if (opts.journal && !opts.journal.bases.includes(base.id)) return { ok: false, reason: 'Чертёж не открыт: разбери такую вещь у кузнеца' };
  const range = craftTierRange(reg, base, input.step, opts.journal);
  if (!range) return { ok: false, reason: 'Из этого материала такую вещь не собрать' };
  if (input.tier < range.lo || input.tier > range.hi) {
    return { ok: false, reason: `Из этого материала — только ${craftTiers(reg)[range.lo]?.name} … ${craftTiers(reg)[range.hi]?.name}`, range };
  }
  const res = resolveParts(reg, base.weaponClass, input.parts);
  if (!res.ok) return { ok: false, reason: res.reason, range };
  if (opts.journal) {
    const closed = CRAFT_SLOT_LIST.map((s) => res.parts[s]).find((p) => !opts.journal!.variants.includes(p.id));
    if (closed) return { ok: false, reason: `Деталь «${closed.name}» ещё не открыта`, range };
  }
  const tier = craftTiers(reg)[input.tier]!;
  const bake = bakeParts(reg, base, input.tier, res.parts);
  const cost = craftCost(reg, base, input.tier, input.step, bake.affixCap);
  if (opts.materialsOn) {
    const off = Object.keys(cost.materials).find((id) => !reg.get('craft-materials').some((m) => m.id === id && m.enabled !== false));
    if (off) return { ok: false, reason: `Материал ещё не в игре: ${off}`, range, cost, bake };
  }

  const item = buildCraftShell(base, tier, reg.get('balance').maxTotalRequirement);
  item.baseStats.push(...bake.mods);
  if (bake.reachMult !== undefined) item.reachMult = bake.reachMult;
  if (bake.arcMult !== undefined) item.arcMult = bake.arcMult;
  item.affixCap = bake.affixCap;
  item.parts = { ...input.parts, step: input.step };
  const maxT = tierIndex(reg, base.maxTier ?? undefined);
  const ceiling = Math.min(materialBand(input.step).hi, maxT < 0 ? craftTiers(reg).length - 1 : maxT);
  return { ok: true, item, cost, bake, ceiling, range };
}

// ── Зачарование ─────────────────────────────────────────────────────────────────────────────────

type RarityDef = ConfigShapes['rarities'][number];

/**
 * ⭐ СЛОТЫ ДЛЯ `rollAffixes` с учётом объявленной ёмкости. Движок не меняется ни на строку: при
 * `min = max = P+S` и лимитах ровно P и S цикл физически не может лечь другим сплитом (§6.3).
 * Нет ёмкости — слоты по редкости, как у любого дропа. ⚠ Этой же функцией обязана пользоваться
 * перекатка, иначе она снесёт купленную форму первым нажатием.
 */
export function affixSlotsFor(rDef: RarityDef | undefined, cap?: AffixForm): { minAffixes: number; maxAffixes: number; maxPrefix: number; maxSuffix: number } {
  const def = { minAffixes: rDef?.minAffixes ?? 0, maxAffixes: rDef?.maxAffixes ?? 0, maxPrefix: rDef?.maxPrefix ?? 0, maxSuffix: rDef?.maxSuffix ?? 0 };
  if (!cap) return def;
  const P = Math.min(cap.prefix, def.maxPrefix);
  const S = Math.min(cap.suffix, def.maxSuffix);
  const total = Math.min(P + S, def.maxAffixes);
  return { minAffixes: total, maxAffixes: total, maxPrefix: P, maxSuffix: S };
}

/** Цена зачарования: золото × множитель ступени × цена редкости × M формы (§13). */
export function enchantCost(reg: ConfigRegistry, item: Item, rarity: Rarity): number {
  const k = reg.get('balance').craft;
  const tier = craftTiers(reg)[tierIndexOfItem(reg, item)];
  const rDef = reg.get('rarities').find((r) => r.id === rarity);
  const M = item.affixCap ? formMult(reg, item.affixCap) : 1;
  return Math.round(k.cost.enchantGold * (tier?.reqMult ?? 1) * (rDef?.priceMult ?? 1) * M);
}

/**
 * ⭐ ЗАЧАРОВАТЬ: поднять вещь до магической или редкой. Аффиксы катаются ТЕМ ЖЕ броском, что у
 * дропа, только слоты берутся из ёмкости вещи. Случайность здесь законна (правило Р3): форма
 * известна заранее, катаются значения. Возвращает НОВЫЙ предмет — исходный не трогает.
 */
export function enchantItem(reg: ConfigRegistry, item: Item, rarity: Rarity, rng: Rng): Item {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base) return item;
  const rDef = reg.get('rarities').find((r) => r.id === rarity);
  const affixes = reg.get('affixes');
  const rolled = rollAffixes(affixes, affixTargetOfBase(base), rarity, affixSlotsFor(rDef, item.affixCap), item.itemLevel, rng);
  const tier = craftTiers(reg)[tierIndexOfItem(reg, item)];
  const tierName = tier ? buildCraftShell(base, tier).name : base.name;
  return {
    ...item,
    rarity,
    affixes: rolled,
    name: nameByRarity(base, tierName, rarity, rolled, affixes, reg.get('rare-names'), rng),
  };
}

// ── Детали найденной вещи ───────────────────────────────────────────────────────────────────────

/** FNV-1a: сид из строки. Нужен, чтобы детали вещи выводились из неё самой, без броска. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) || 1;
}

const FLOOR_STEP = [1, 1, 1, 2, 3, 4, 5];
const CEIL_STEP = [1, 1, 2, 3, 4, 5, 5];
const RARITY_ADD: Record<string, number> = { normal: 0, magic: 0.5, rare: 1 };

/**
 * ⭐ ИЗ ЧЕГО ВЕЩЬ СДЕЛАНА — тождество разбора (§10.9): ступень сырья = та, из которой вещь и была
 * бы собрана. Пол полосы тира + надбавка за редкость (0 / 0.5 / 1), дробь — вероятностно.
 * Без `rng` дробь отбрасывается (детерминированный показ).
 */
export function salvageStep(t: number, rarity: Rarity, rng?: Rng): number {
  const i = clamp(t, 0, 6);
  const v = FLOOR_STEP[i]! + (RARITY_ADD[rarity] ?? 0);
  const whole = Math.floor(v);
  const up = rng && v - whole > 0 ? rng.chance(v - whole) : false;
  return clamp(whole + (up ? 1 : 0), 1, CEIL_STEP[i]!);
}

/**
 * ⭐ ДЕТАЛИ ЛЮБОГО ОРУЖИЯ. У скованного — записанные. У найденного — выведенные ДЕТЕРМИНИРОВАННО
 * из него самого (сид от `uid` и базы): партсет «был в мече с момента падения», разбор его только
 * открывает. Бросок в момент разбора запрещён — это была бы лотерея (правило Р3).
 * Редкость варианта = его частота на дропе (`balance.craft.rarityWeight`), а не сила.
 * ⚠ Вывод стабилен, пока не меняется набор вариантов класса: добавишь вариант — у старых вещей
 * детали могут переехать. Перед врезкой в игру: записывать `parts` на вещь при первом чтении.
 */
export function partsOf(reg: ConfigRegistry, item: Item): CraftParts | null {
  if (item.parts) return item.parts;
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base || base.kind !== 'weapon') return null;
  const w = reg.get('balance').craft.rarityWeight;
  const rng = createRng(hashStr(`${item.uid}|${item.baseId}`));
  const pick = (slot: CraftSlot): string | undefined => {
    const pool = [...variantsFor(reg, base.weaponClass, slot)].sort((a, b) => a.id.localeCompare(b.id));
    const weights = pool.map((p) => w[p.rarity] ?? 0);
    const total = weights.reduce((s, x) => s + x, 0);
    if (!pool.length || total <= 0) return pool[0]?.id;
    let roll = rng.next() * total;
    for (let i = 0; i < pool.length; i++) { roll -= weights[i]!; if (roll < 0) return pool[i]!.id; }
    return pool[pool.length - 1]!.id;
  };
  const strike = pick('strike'), grip = pick('grip'), bind = pick('bind'), head = pick('head');
  if (!strike || !grip || !bind || !head) return null;
  return { strike, grip, bind, head, step: salvageStep(tierIndexOfItem(reg, item), item.rarity, rng) };
}

// ── Разбор: журнал и сырьё ──────────────────────────────────────────────────────────────────────

export interface SalvageUnlock {
  journal: CraftJournal;
  /** Впервые открытые варианты. */
  unlocked: string[];
  newBase: boolean;
  /** Выдан эскиз (жалость). */
  sketch: boolean;
  tierUp: boolean;
  mythic: boolean;
}

/**
 * ⭐ РАЗОБРАЛ — ОТКРЫЛ (§12). Разбор вещи у кузнеца открывает её базу и четыре её детали, двигает
 * потолок ступени и копит жалость: каждые `sketchAfter` разборов своего класса дают «эскиз» —
 * любой неоткрытый вариант класса на выбор. 95-й перцентиль ожидания редкой детали без него —
 * 36 часов, и каталог превращается в издевательство.
 * Скованное сюда не идёт: у него свой глагол «переплавить», иначе ковка стала бы прачечной знаний.
 */
export function salvageIntoJournal(reg: ConfigRegistry, journal: CraftJournal, item: Item): SalvageUnlock {
  const j: CraftJournal = { ...journal, bases: [...journal.bases], variants: [...journal.variants], classSalvages: { ...journal.classSalvages } };
  const none = { journal: j, unlocked: [], newBase: false, sketch: false, tierUp: false, mythic: false };
  if (item.parts) return none; // скованное открывает только переплавка — и то нет
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const parts = partsOf(reg, item);
  if (!base || base.kind !== 'weapon' || !parts) return none;
  const unlocked: string[] = [];
  for (const slot of CRAFT_SLOT_LIST) if (!j.variants.includes(parts[slot])) { j.variants.push(parts[slot]); unlocked.push(parts[slot]); }
  const newBase = !j.bases.includes(base.id);
  if (newBase) j.bases.push(base.id);
  const t = tierIndexOfItem(reg, item);
  const tierUp = t > j.tierHi;
  if (tierUp) j.tierHi = t;
  const k = reg.get('balance').craft.journal;
  const n = (j.classSalvages[base.weaponClass] ?? 0) + 1;
  const sketch = n >= k.sketchAfter;
  j.classSalvages[base.weaponClass] = sketch ? n - k.sketchAfter : n;
  if (sketch) j.sketches += 1;
  const mythic = t === craftTiers(reg).length - 1;
  if (mythic) j.mythic += 1;
  return { journal: j, unlocked, newBase, sketch, tierUp, mythic };
}

/** Потратить эскиз: открыть выбранный вариант. Нет эскизов или уже открыт — журнал не меняется. */
export function useSketch(journal: CraftJournal, variantId: string): CraftJournal {
  if (journal.sketches <= 0 || journal.variants.includes(variantId)) return journal;
  return { ...journal, variants: [...journal.variants, variantId], sketches: journal.sketches - 1 };
}

/**
 * Сырьё с разбора оружия — из ТЕХ семей, из которых вещь собрана, на той ступени, из которой она
 * собрана (§10.9). Количества — как у нынешних правил разбора: сигнатурная часть 3, держак 2,
 * прибор 2.
 */
export function craftSalvageYield(reg: ConfigRegistry, item: Item, rng: Rng): MaterialCost {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const anat = base?.kind === 'weapon' ? anatomyOf(reg, base.weaponClass) : undefined;
  if (!anat) return {};
  const step = item.parts?.step ?? salvageStep(tierIndexOfItem(reg, item), item.rarity, rng);
  const out: MaterialCost = {};
  const add = (fam: string, n: number): void => { const id = materialId(fam, step); out[id] = (out[id] ?? 0) + n; };
  add(anat.strike.family, 3);
  add(anat.grip.family, 2);
  if (anat.bind.family === anat.head.family) add(anat.bind.family, 2);
  else { add(anat.bind.family, 1); add(anat.head.family, 1); }
  return out;
}

/**
 * ⭐ ПЕРЕПЛАВКА скованного — вместо разбора (§16). Возвращает долю вложенного, журналу не пишет.
 * Без неё ковка стала бы прачечной: скуй обычную → разбери как редкую → получи дорогое.
 */
export function meltReturn(reg: ConfigRegistry, item: Item): MaterialCost {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!item.parts || !base || base.kind !== 'weapon') return {};
  const cost = craftCost(reg, base, tierIndexOfItem(reg, item), item.parts.step, item.affixCap ?? { prefix: 0, suffix: 0 });
  const m = reg.get('balance').craft.melt;
  const out: MaterialCost = {};
  for (const l of cost.lines) {
    const c = Math.floor(l.cheap.n * m.cheap), d = Math.floor(l.dear.n * m.dear);
    if (c > 0) out[l.cheap.id] = (out[l.cheap.id] ?? 0) + c;
    if (d > 0) out[l.dear.id] = (out[l.dear.id] ?? 0) + d;
  }
  return out;
}
