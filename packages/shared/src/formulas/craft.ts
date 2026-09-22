import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { CraftPartPick, CraftParts, Item, Rarity } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';
import type { MaterialCost } from '../economy/materials.js';
import { createRng, type Rng } from './rng.js';
import { affixTargetOfBase, buildCraftShell, inferTierId, nameByRarity, rollAffixes } from './itemgen.js';
import {
  CRAFT_SLOT_LIST, agree, anatomyRow, baseOfKeyPart, keySlotOf, partFits, resolveType,
  type CraftSlot, type PartSet, type TypeInfo, type WeaponAnatomy, type WeaponPart,
} from './craftType.js';

/**
 * КОВКА ОРУЖИЯ ИЗ ДЕТАЛЕЙ — чистое ядро (docs/CRAFT_WEAPONS.md).
 *
 * ⭐ Один источник правды для трёх потребителей: сервер (когда ковку врежут в игру), окно ковки
 * в игре и песочница конфиг-редактора. Здесь нет ни DOM, ни сети, ни сейва — только
 * «конфиг + вход → вещь, цена, журнал».
 *
 * Порядок решений — от деталей: игрок выбирает СЕМЕЙСТВО (класс × хват), потом четыре детали, и у
 * каждой — свой материал. Всё остальное выводится:
 * - ТИП — из ключевой детали (`craftType.ts`): база целиком и историческое имя;
 * - СТУПЕНЬ ВЕЩИ — из материалов деталей, средним по массе (`tierOfSteps`);
 * - ВКЛАД ФОРМЫ — из `axis` × шаг гнезда (`balance.craft`), руками в вариант не пишется ни одно
 *   число, поэтому «деталь написала в чужой стат» невозможно, а вариантов может быть сколько угодно.
 */

type Base = ConfigShapes['items.base'][number];
type WeaponBase = Extract<Base, { kind: 'weapon' }>;
type Tier = ConfigShapes['item-tiers'][number];
export type CraftTuning = ConfigShapes['balance']['craft'];

/** Роль гнезда одной строкой — для подписи в окне ковки. */
export const CRAFT_SLOT_ROLE: Record<CraftSlot, string> = {
  strike: 'урон ↔ скорость',
  grip: 'дальше ↔ шире',
  bind: 'префиксы ↔ суффиксы',
  head: 'укус ↔ упор',
};

const r4 = (x: number): number => Math.round(x * 10000) / 10000;
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const lowFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

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

/** Ступени базы: снизу `minTier`, сверху `maxTier` (короткий меч не бывает выше t3). */
export function baseTierRange(reg: ConfigRegistry, base: Base): { lo: number; hi: number } {
  const last = craftTiers(reg).length - 1;
  const lo = Math.max(0, tierIndex(reg, base.minTier ?? undefined));
  const maxT = tierIndex(reg, base.maxTier ?? undefined);
  return { lo, hi: maxT < 0 ? last : maxT };
}

// ── Материал ─────────────────────────────────────────────────────────────────────────────────────

/** Ступеней материала в каждой семье. Одинаково у всех — иначе гнёзда рассинхронятся (§10.1). */
export const MATERIAL_STEPS = 5;

/** id материала семьи на ступени: `iron` + 3 → `iron-3`. */
export const materialId = (family: string, step: number): string => `${family}-${step}`;

/** Семья материала детали: своя у варианта (дубина — дерево) или гнезда. */
export function partFamily(anat: WeaponAnatomy, slot: CraftSlot, p: WeaponPart): string {
  return p.family || anat[slot].family;
}

/** Как показать ступень материала в этом гнезде: «Уклад», а у ствола жезла — «морёный». */
export function stepLabel(reg: ConfigRegistry, anat: WeaponAnatomy, slot: CraftSlot, p: WeaponPart, step: number): string {
  const own = !p.family ? anat[slot].stepNames[step - 1] : undefined;
  if (own) return own;
  const id = materialId(partFamily(anat, slot, p), step);
  return reg.get('craft-materials').find((m) => m.id === id)?.name ?? id;
}

/**
 * ⭐ СТУПЕНЬ ВЕЩИ ИЗ ДЕТАЛЕЙ (§11): средний уровень материала ПО МАССЕ —
 * `Q = Σ(вес·ступень)/Σвес`, ступень = round(scale·(Q−1)). Вещь целиком из одной ступени k даёт
 * t0, t2, t3, t5, t6; смешанные материалы закрывают промежуточные. Булатный клинок при болотном
 * прочем даёт t2, а не мифик: клинок весит две пятых, а не всё.
 */
export function tierOfSteps(reg: ConfigRegistry, picks: Record<CraftSlot, { step: number }>): { q: number; tier: number } {
  const k = reg.get('balance').craft.tierFromParts;
  let sw = 0, s = 0;
  for (const slot of CRAFT_SLOT_LIST) { const w = k.weights[slot]; sw += w; s += w * picks[slot].step; }
  const q = sw > 0 ? s / sw : 1;
  const last = craftTiers(reg).length - 1;
  return { q: r4(q), tier: clamp(Math.round(k.scale * (q - 1) + 1e-9), 0, last) };
}

// ── Журнал кузнеца ───────────────────────────────────────────────────────────────────────────────

/**
 * ЖУРНАЛ КУЗНЕЦА (§12): что игрок уже умеет ковать. Чертежей как предметов нет — всё открывается
 * разбором найденных вещей у кузнеца. В игре живёт на АККАУНТЕ, рядом с кошельком материалов.
 */
export interface CraftJournal {
  /** Открытые базы (типы механики). */
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
  /** Кодекс: исторические типы, которые игрок видел на разобранных вещах. */
  typesSeen: string[];
  /** Кодекс: исторические типы, которые игрок сковал сам. */
  typesForged: string[];
}

export function emptyJournal(): CraftJournal {
  return { bases: [], variants: [], tierHi: -1, classSalvages: {}, sketches: 0, mythic: 0, typesSeen: [], typesForged: [] };
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
    typesSeen: [],
    typesForged: [],
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

export const anatomyOf = anatomyRow;

/** Варианты гнезда для семейства, по оси от «+1» к «−1» (так их и показывает окно ковки). */
export function variantsFor(reg: ConfigRegistry, weaponClass: string, slot: CraftSlot, hands?: number): WeaponPart[] {
  return reg.get('weapon-parts')
    .filter((p) => p.enabled !== false && p.slot === slot && (p.classes as string[]).includes(weaponClass) && (hands === undefined || !p.hands.length || p.hands.includes(hands)))
    .sort((a, b) => b.axis - a.axis || a.id.localeCompare(b.id));
}

export function partById(reg: ConfigRegistry, id: string): WeaponPart | undefined {
  return reg.get('weapon-parts').find((p) => p.id === id);
}

/** Ключевые варианты семейства, СГРУППИРОВАННЫЕ ПО БАЗАМ — так их показывает окно: заголовок-база, строки-формы. */
export function keyVariantsByBase(reg: ConfigRegistry, weaponClass: string, hands: number): { baseId: string; variants: WeaponPart[] }[] {
  const slot = keySlotOf(reg, weaponClass);
  const out = new Map<string, WeaponPart[]>();
  for (const b of reg.get('weapon-types').find((t) => t.id === weaponClass)?.bases ?? []) if (b.hands === hands && !out.has(b.base)) out.set(b.base, []);
  for (const p of variantsFor(reg, weaponClass, slot, hands)) {
    const baseId = baseOfKeyPart(reg, weaponClass, hands, p);
    if (baseId) out.get(baseId)?.push(p);
  }
  return [...out.entries()].map(([baseId, variants]) => ({ baseId, variants }));
}

/** Ступень, прижатая к окну материалов варианта. */
export const clampStep = (p: WeaponPart, step: number): number => clamp(Math.round(step), p.stepMin, p.stepMax);

/**
 * Сборка по умолчанию для семейства: в каждом гнезде вариант с осью ближе всего к нулю («эталон»),
 * у ключа — эталон базы с самым высоким потолком (при равенстве — с самым богатым пулом форм:
 * у меча это рыцарский, а не короткий с потолком t3); материалы — `step`, прижатый к окну формы.
 */
export function defaultParts(reg: ConfigRegistry, weaponClass: string, hands: number, step = 1): CraftParts | null {
  const keySlot = keySlotOf(reg, weaponClass);
  const hiOf = (id: string): number => { const b = reg.get('items.base').find((x) => x.id === id); return b ? baseTierRange(reg, b).hi : -1; };
  const keyGroup = [...keyVariantsByBase(reg, weaponClass, hands)].sort((a, b) => hiOf(b.baseId) - hiOf(a.baseId) || b.variants.length - a.variants.length)[0];
  const pick = (slot: CraftSlot): CraftPartPick | undefined => {
    const pool = slot === keySlot ? (keyGroup?.variants ?? []) : variantsFor(reg, weaponClass, slot, hands);
    const p = [...pool].sort((a, b) => Math.abs(a.axis) - Math.abs(b.axis))[0];
    return p ? { id: p.id, step: clampStep(p, step) } : undefined;
  };
  const out = { strike: pick('strike'), grip: pick('grip'), bind: pick('bind'), head: pick('head') };
  return out.strike && out.grip && out.bind && out.head ? (out as CraftParts) : null;
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

// ── Детали: проверка ─────────────────────────────────────────────────────────────────────────────

export type ResolvedParts = PartSet;

/**
 * ИД деталей → записи, с проверкой гнезда, класса, хвата, включённости и ОКНА МАТЕРИАЛОВ:
 * широкое лезвие из булата не куётся — не потому, что нельзя, а потому, что такой формы из такой
 * стали не делали, и окно формы это говорит.
 */
export function resolveParts(
  reg: ConfigRegistry,
  weaponClass: string,
  hands: number,
  picks: CraftParts,
): { ok: true; parts: ResolvedParts } | { ok: false; reason: string } {
  const anat = anatomyRow(reg, weaponClass);
  if (!anat) return { ok: false, reason: 'Такого класса кузнец не знает' };
  const out: Partial<ResolvedParts> = {};
  for (const slot of CRAFT_SLOT_LIST) {
    const pick = picks[slot];
    const p = pick && partById(reg, pick.id);
    if (!p || p.enabled === false) return { ok: false, reason: `Нет такой детали: ${pick?.id ?? '—'}` };
    if (p.slot !== slot) return { ok: false, reason: `«${p.name}» не для этого гнезда` };
    if (!partFits(p, weaponClass, slot, hands)) return { ok: false, reason: `«${p.name}» не подходит этому семейству` };
    if (!Number.isInteger(pick.step) || pick.step < p.stepMin || pick.step > p.stepMax) {
      return { ok: false, reason: `«${p.name}» куётся только из ступеней ${p.stepMin}–${p.stepMax}: ${stepLabel(reg, anat, slot, p, p.stepMin)} … ${stepLabel(reg, anat, slot, p, p.stepMax)}` };
    }
    out[slot] = p;
  }
  return { ok: true, parts: out as ResolvedParts };
}

// ── Запекание деталей ───────────────────────────────────────────────────────────────────────────

export interface CraftBake {
  /**
   * Множитель УДАРА от ударной части: ложится в `Item.damageMult`, бой множит на него весь удар
   * (оружие + атрибуты), подсказка — цифры урона. Не строка «+10 % урона» и не сложение с бонусами героя.
   */
  damageMult: number;
  /** Что добавить в `baseStats` вещи (скорость ударной части — плоской частью скорости оружия). */
  mods: StatModifier[];
  /** Итоговые множители дальности и дуги (только ближний бой). */
  reachMult?: number;
  arcMult?: number;
  affixCap: AffixForm;
  statusKind?: string;
  /** Честные оговорки для окна: где ось сегодня не работает и почему. */
  notes: string[];
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

  // 1 · Ударная часть — единственная ось ДПС внутри типа, зеркальная, и она МНОЖИТ само оружие:
  // урон — в цифрах урона вещи, скорость — плоской частью скорости оружия, которую бой умножает на
  // все проценты скорости (`(1 + flat) × (1 + increased)`). Тогда ДПС формы = (1+0.1a)(1−0.08a) — один
  // и тот же у любой базы и любого билда (разброс 4.1 %), а не зависящий от бонусов героя.
  const a1 = parts.strike.axis;
  const damageMult = r4(1 + k.strike.damagePct * a1);
  push('attackSpeed', 'flat', -k.strike.attackSpeed * a1);

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

  return { damageMult, mods, reachMult, arcMult, affixCap, statusKind, notes };
}

// ── Цена ────────────────────────────────────────────────────────────────────────────────────────

export interface CraftCostLine { slot: CraftSlot; family: string; id: string; n: number }
export interface CraftCost { materials: MaterialCost; gold: number; lines: CraftCostLine[]; mult: number }

/**
 * ЦЕНА КОВКИ (§13): каждая деталь — СВОИМ материалом, единиц по её МАССЕ (клинок вдвое тяжелее
 * остального — те же доли, что у ступени вещи), всё ×M формы ёмкости: перекошенная форма дороже
 * сбалансированной. Дешёвая рукоять под дорогим клинком — законный способ сэкономить: она же и
 * тянет ступень вещи вниз ровно на свою долю.
 */
export function craftCost(reg: ConfigRegistry, weaponClass: string, parts: ResolvedParts, picks: CraftParts, t: number, form: AffixForm): CraftCost {
  const k = reg.get('balance').craft;
  const anat = anatomyRow(reg, weaponClass);
  const tier = craftTiers(reg)[t];
  const M = formMult(reg, form);
  const materials: MaterialCost = {};
  const lines: CraftCostLine[] = [];
  if (anat) {
    for (const slot of CRAFT_SLOT_LIST) {
      const family = partFamily(anat, slot, parts[slot]);
      const id = materialId(family, picks[slot].step);
      const n = Math.ceil(k.cost.units[slot] * M);
      lines.push({ slot, family, id, n });
      if (n > 0) materials[id] = (materials[id] ?? 0) + n;
    }
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
  /** Семейство: класс × хват. */
  weaponClass: string;
  hands: number;
  /** Четыре детали, у каждой — своя ступень материала. База, имя и ступень вещи выводятся. */
  parts: CraftParts;
}

export interface CraftPreview {
  ok: boolean;
  reason?: string;
  item?: Item;
  cost?: CraftCost;
  bake?: CraftBake;
  /** Что получилось: база и историческое имя. */
  type?: TypeInfo;
  /** Ступень вещи (индекс) и средний уровень материала по массе. */
  tier?: number;
  q?: number;
}

/** Имя скованной вещи: приставка тира, согласованная с родом ТИПА, + имя типа. */
export function craftedName(tier: Tier, type: TypeInfo): string {
  return `${agree(tier.name, type.gender)} ${lowFirst(type.name)}`;
}

/**
 * ⭐ СКОВАТЬ (или показать, что выйдет). Чистая: ничего не списывает — это делает вызывающий,
 * и ровно поэтому предпросмотр и ковка не могут разойтись: окно рисует тот же результат, за
 * который потом платят.
 *
 * `journal` — что открыто (нет → всё). `materialsOn` — проверять ли, что материалы деталей
 * включены в конфиге: в игре да, в песочнице можно смотреть и выключенные. `atTier` — ТОЛЬКО для
 * замеров (сетка баланса): ступень вещи задана явно, чтобы сравнивать формы на одной ступени, — иначе
 * подмена формы с другим окном материалов сдвинула бы ступень, и замер мерил бы её, а не форму.
 */
export function craftWeapon(
  reg: ConfigRegistry,
  input: CraftInput,
  opts: { journal?: CraftJournal; materialsOn?: boolean; atTier?: number } = {},
): CraftPreview {
  const res = resolveParts(reg, input.weaponClass, input.hands, input.parts);
  if (!res.ok) return { ok: false, reason: res.reason };
  const type = resolveType(reg, input.weaponClass, input.hands, res.parts);
  if (!type.ok) return { ok: false, reason: type.reason, type };
  const base = reg.get('items.base').find((b) => b.id === type.baseId);
  if (!base || base.kind !== 'weapon') return { ok: false, reason: 'Такого оружия кузнец не знает', type };
  const { q, tier: fromParts } = tierOfSteps(reg, input.parts);
  const t = opts.atTier ?? fromParts;
  const tiers = craftTiers(reg);
  const view = { type, tier: t, q };
  if (opts.journal) {
    if (!opts.journal.bases.includes(base.id)) return { ok: false, reason: `Тип «${base.name}» не открыт: разбери такую вещь у кузнеца`, ...view };
    const closed = CRAFT_SLOT_LIST.map((s) => res.parts[s]).find((p) => !opts.journal!.variants.includes(p.id));
    if (closed) return { ok: false, reason: `Деталь «${closed.name}» ещё не открыта`, ...view };
  }
  const br = baseTierRange(reg, base);
  if (t < br.lo) return { ok: false, reason: `${base.name} не бывает ниже ${tiers[br.lo]?.id} ${tiers[br.lo]?.name}: возьми материалы получше`, ...view };
  if (t > br.hi) return { ok: false, reason: `${base.name} не бывает выше ${tiers[br.hi]?.id} ${tiers[br.hi]?.name}: возьми материалы попроще`, ...view };
  if (opts.journal) {
    const cap = journalTierCap(reg, opts.journal);
    if (t > cap) {
      const last = tiers.length - 1;
      const need = reg.get('balance').craft.journal.mythicSalvages;
      return {
        ok: false, ...view,
        reason: t === last && opts.journal.tierHi >= last
          ? `Мифическую ступень кузнец откроет после ${need} разобранных мифических вещей (сейчас ${opts.journal.mythic})`
          : `Кузнец ещё не работал со ступенью ${tiers[t]?.name}: разбери вещь такой ступени или выше`,
      };
    }
  }
  const tier = tiers[t]!;
  const bake = bakeParts(reg, base, t, res.parts);
  const cost = craftCost(reg, input.weaponClass, res.parts, input.parts, t, bake.affixCap);
  if (opts.materialsOn) {
    const off = Object.keys(cost.materials).find((id) => !reg.get('craft-materials').some((m) => m.id === id && m.enabled !== false));
    if (off) return { ok: false, reason: `Материал ещё не в игре: ${off}`, cost, bake, ...view };
  }

  const item = buildCraftShell(base, tier, reg.get('balance').maxTotalRequirement);
  item.name = craftedName(tier, type);
  item.baseStats = [...item.baseStats, ...bake.mods]; // новый массив: статы базы в конфиге не трогаем
  if (bake.damageMult !== 1) item.damageMult = bake.damageMult;
  if (bake.reachMult !== undefined) item.reachMult = bake.reachMult;
  if (bake.arcMult !== undefined) item.arcMult = bake.arcMult;
  item.affixCap = bake.affixCap;
  item.parts = structuredClone(input.parts);
  if (type.typeId) item.typeId = type.typeId;
  return { ok: true, item, cost, bake, ...view };
}

/** Тип вещи по её деталям (скованной — записанным, найденной — выведенным). */
export function typeOfItem(reg: ConfigRegistry, item: Item): TypeInfo | undefined {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const picks = partsOf(reg, item);
  if (!base || base.kind !== 'weapon' || !picks) return undefined;
  const res = resolveParts(reg, base.weaponClass, base.hands ?? 1, picks);
  if (!res.ok) return undefined;
  const t = resolveType(reg, base.weaponClass, base.hands ?? 1, res.parts);
  return t.ok ? t : undefined;
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
 * известна заранее, катаются значения. Имя строится от ТИПА («Жгучий каролингский меч»), а не от
 * базы. Возвращает НОВЫЙ предмет — исходный не трогает.
 */
export function enchantItem(reg: ConfigRegistry, item: Item, rarity: Rarity, rng: Rng): Item {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base) return item;
  const rDef = reg.get('rarities').find((r) => r.id === rarity);
  const affixes = reg.get('affixes');
  const rolled = rollAffixes(affixes, affixTargetOfBase(base), rarity, affixSlotsFor(rDef, item.affixCap), item.itemLevel, rng);
  const tier = craftTiers(reg)[tierIndexOfItem(reg, item)];
  const type = item.parts ? typeOfItem(reg, item) : undefined;
  const named = type ? { ...base, name: type.name, gender: type.gender } : base;
  const tierName = tier ? (type ? craftedName(tier, type) : buildCraftShell(base, tier).name) : named.name;
  return {
    ...item,
    rarity,
    affixes: rolled,
    name: nameByRarity(named, tierName, rarity, rolled, affixes, reg.get('rare-names'), rng),
  };
}

// ── Детали найденной вещи ───────────────────────────────────────────────────────────────────────

/** FNV-1a: сид из строки. Нужен, чтобы детали вещи выводились из неё самой, без броска. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) || 1;
}

function weighted<T>(items: T[], weight: (x: T) => number, rng: Rng): T | undefined {
  const ws = items.map((x) => Math.max(0, weight(x)));
  const total = ws.reduce((s, x) => s + x, 0);
  if (!items.length) return undefined;
  if (total <= 0) return items[0];
  let roll = rng.next() * total;
  for (let i = 0; i < items.length; i++) { roll -= ws[i]!; if (roll < 0) return items[i]; }
  return items[items.length - 1];
}

/**
 * ⭐ ИЗ ЧЕГО СДЕЛАНА НАЙДЕННАЯ ВЕЩЬ. У скованной — записанное. У найденной — выведенное
 * ДЕТЕРМИНИРОВАННО из неё самой (сид от `uid` и базы): партсет «был в мече с момента падения»,
 * разбор его только открывает. Бросок в момент разбора запрещён — это была бы лотерея (правило Р3).
 *
 * Тождество разбора (§10.9): ступени деталей подбираются так, чтобы из них ковалась РОВНО ступень
 * вещи — разбор отдаёт то, из чего вещь сделана. Ключевая деталь берётся из пула СВОЕЙ базы, поэтому
 * тип найденной вещи = её база. Редкость варианта = его частота на дропе (`rarityWeight`), не сила.
 * ⚠ Вывод стабилен, пока не меняются пулы вариантов: добавишь вариант — у старых вещей детали могут
 * переехать. Перед врезкой в игру: записывать `parts` на вещь при первом чтении.
 */
export function partsOf(reg: ConfigRegistry, item: Item): CraftParts | null {
  if (item.parts) return item.parts;
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base || base.kind !== 'weapon') return null;
  const cls = base.weaponClass;
  const hands = base.hands ?? 1;
  const keySlot = keySlotOf(reg, cls);
  const w = reg.get('balance').craft.rarityWeight;
  const pools = {} as Record<CraftSlot, WeaponPart[]>;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot
      ? (keyVariantsByBase(reg, cls, hands).find((g) => g.baseId === base.id)?.variants ?? [])
      : variantsFor(reg, cls, slot, hands);
    if (!pool.length) return null;
    pools[slot] = [...pool].sort((a, b) => a.id.localeCompare(b.id));
  }
  const t = tierIndexOfItem(reg, item);
  const rng = createRng(hashStr(`${item.uid}|${item.baseId}`));
  const has = (slot: CraftSlot, s: number): boolean => pools[slot].some((p) => p.stepMin <= s && s <= p.stepMax);

  // Ступени: все четвёрки, из которых кузнец собрал бы ровно эту ступень, — ровные предпочтительнее.
  type Steps = Record<CraftSlot, { step: number }>;
  const exact: { s: Steps; wgt: number }[] = [];
  let near: { s: Steps; d: number } | null = null;
  for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (let c = 1; c <= 5; c++) for (let d = 1; d <= 5; d++) {
    const s: Steps = { strike: { step: a }, grip: { step: b }, bind: { step: c }, head: { step: d } };
    if (!CRAFT_SLOT_LIST.every((sl) => has(sl, s[sl].step))) continue;
    const { q, tier } = tierOfSteps(reg, s);
    if (tier === t) exact.push({ s, wgt: 1 / (1 + CRAFT_SLOT_LIST.reduce((acc, sl) => acc + Math.abs(s[sl].step - q), 0)) });
    else if (!near || Math.abs(tier - t) < near.d) near = { s, d: Math.abs(tier - t) };
  }
  const chosen = weighted(exact, (x) => x.wgt, rng)?.s ?? near?.s;
  if (!chosen) return null;

  const out = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const step = chosen[slot].step;
    const fit = pools[slot].filter((p) => p.stepMin <= step && step <= p.stepMax);
    const p = weighted(fit, (x) => w[x.rarity] ?? 0, rng)!;
    out[slot] = { id: p.id, step };
  }
  return out;
}

// ── Разбор: журнал и сырьё ──────────────────────────────────────────────────────────────────────

export interface SalvageUnlock {
  journal: CraftJournal;
  /** Впервые открытые варианты. */
  unlocked: string[];
  newBase: boolean;
  /** Впервые увиденный исторический тип (кодекс). */
  newType?: string;
  /** Выдан эскиз (жалость). */
  sketch: boolean;
  tierUp: boolean;
  mythic: boolean;
}

/**
 * ⭐ РАЗОБРАЛ — ОТКРЫЛ (§12). Разбор вещи у кузнеца открывает её базу и четыре её детали, двигает
 * потолок ступени, отмечает тип в кодексе и копит жалость: каждые `sketchAfter` разборов своего
 * класса дают «эскиз». 95-й перцентиль ожидания редкой детали без него — 36 часов, и каталог
 * превращается в издевательство.
 * Скованное сюда не идёт: у него свой глагол «переплавить», иначе ковка стала бы прачечной знаний.
 */
export function salvageIntoJournal(reg: ConfigRegistry, journal: CraftJournal, item: Item): SalvageUnlock {
  const j: CraftJournal = {
    ...journal, bases: [...journal.bases], variants: [...journal.variants], classSalvages: { ...journal.classSalvages },
    typesSeen: [...(journal.typesSeen ?? [])], typesForged: [...(journal.typesForged ?? [])],
  };
  const none = { journal: j, unlocked: [], newBase: false, sketch: false, tierUp: false, mythic: false };
  if (item.parts) return none; // скованное открывает только переплавка — и то нет
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const parts = partsOf(reg, item);
  if (!base || base.kind !== 'weapon' || !parts) return none;
  const unlocked: string[] = [];
  for (const slot of CRAFT_SLOT_LIST) if (!j.variants.includes(parts[slot].id)) { j.variants.push(parts[slot].id); unlocked.push(parts[slot].id); }
  const newBase = !j.bases.includes(base.id);
  if (newBase) j.bases.push(base.id);
  const type = typeOfItem(reg, item);
  const newType = type?.typeId && !j.typesSeen.includes(type.typeId) ? type.typeId : undefined;
  if (newType) j.typesSeen.push(newType);
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
  return { journal: j, unlocked, newBase, newType, sketch, tierUp, mythic };
}

/**
 * Можно ли потратить эскиз на вариант. ⚠ Ключевой вариант НЕОТКРЫТОЙ базы — нельзя: ключ несёт
 * тип, и эскиз стал бы чертежом в обход разбора, а базы открываются только разбором.
 */
export function sketchable(reg: ConfigRegistry, journal: CraftJournal, variantId: string): boolean {
  const p = partById(reg, variantId);
  if (!p || journal.variants.includes(variantId)) return false;
  for (const cls of p.classes) {
    if (p.slot !== keySlotOf(reg, cls)) return true;
    for (const h of [1, 2]) {
      const b = baseOfKeyPart(reg, cls, h, p);
      if (b && journal.bases.includes(b)) return true;
    }
  }
  return false;
}

/** Потратить эскиз: открыть выбранный вариант. Нельзя (нет эскизов, открыт, ключ чужой базы) — журнал не меняется. */
export function useSketch(reg: ConfigRegistry, journal: CraftJournal, variantId: string): CraftJournal {
  if (journal.sketches <= 0 || !sketchable(reg, journal, variantId)) return journal;
  return { ...journal, variants: [...journal.variants, variantId], sketches: journal.sketches - 1 };
}

/**
 * Сырьё с разбора оружия — ровно то, из чего вещь сделана: каждая деталь отдаёт свой материал
 * своей ступени (§10.9). Редкость добавляет единицы ударной части.
 */
export function craftSalvageYield(reg: ConfigRegistry, item: Item): MaterialCost {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const anat = base?.kind === 'weapon' ? anatomyRow(reg, base.weaponClass) : undefined;
  const picks = partsOf(reg, item);
  if (!anat || !picks) return {};
  const k = reg.get('balance').craft.salvage;
  const out: MaterialCost = {};
  for (const slot of CRAFT_SLOT_LIST) {
    const p = partById(reg, picks[slot].id);
    if (!p) continue;
    const id = materialId(partFamily(anat, slot, p), picks[slot].step);
    const n = k.units[slot] + (slot === 'strike' ? (k.rarityBonus[item.rarity as keyof typeof k.rarityBonus] ?? 0) : 0);
    if (n > 0) out[id] = (out[id] ?? 0) + n;
  }
  return out;
}

/**
 * ⭐ ПЕРЕПЛАВКА скованного — вместо разбора (§16). Возвращает долю вложенного, журналу не пишет.
 * Без неё ковка стала бы прачечной: скуй обычную → разбери как редкую → получи дорогое.
 */
export function meltReturn(reg: ConfigRegistry, item: Item): MaterialCost {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!item.parts || !base || base.kind !== 'weapon') return {};
  const res = resolveParts(reg, base.weaponClass, base.hands ?? 1, item.parts);
  if (!res.ok) return {};
  const cost = craftCost(reg, base.weaponClass, res.parts, item.parts, tierIndexOfItem(reg, item), item.affixCap ?? { prefix: 0, suffix: 0 });
  const share = reg.get('balance').craft.melt.share;
  const out: MaterialCost = {};
  for (const l of cost.lines) {
    const n = Math.floor(l.n * share);
    if (n > 0) out[l.id] = (out[l.id] ?? 0) + n;
  }
  return out;
}
