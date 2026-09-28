import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { BaseRoll, CraftPartPick, CraftParts, Item, ItemOrigin, Rarity, RolledStat } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';
import type { MaterialCost } from '../economy/materials.js';
import { createRng, type Rng } from './rng.js';
import { isSafeKey } from '../session/wireLimits.js';
import { affixPool, affixTargetOfBase, baseStatRange, buildCraftShell, fixedBaseRoll, inferTierId, nameByRarity, rollAffixes, rollBaseQ, scaleBaseStats, snapFloor, type BaseShape } from './itemgen.js';
import { axisOf, balanceAxisOf, bladeStats, strikeAxisOf } from './bladeStats.js';
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

/**
 * Ступени предмета по возрастанию (t0 … t6) — ПОЛНАЯ лестница, выключенные тоже.
 * ⚠ R12-08: индекс ступени хранится в базе (потолок журнала `tierHi`) и ключует таблицы (`capacityByTier`), а вещи выключенной
 * ступени у игроков остаются. По лестнице ВКЛЮЧЁННЫХ выключенная в редакторе ступень сдвигала все индексы выше себя: вещь своей
 * ступени не находила (зачарование скованной t5 стоило как t0, разбор поднимал журналу t0), ёмкость аффиксов и потолок журнала
 * уезжали на соседнюю ступень. Выключенная ступень только не РОЖДАЕТСЯ заново: ковка на неё — отказ (`craftWeapon`), подъём у
 * кузнеца её перешагивает (`nextTier`), дроп не выбирает (`pickTierClamped`).
 */
export function craftTiers(reg: ConfigRegistry): Tier[] {
  return [...reg.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);
}

/** Индекс ступени по id (−1 — нет такой). */
export function tierIndex(reg: ConfigRegistry, id: string | undefined): number {
  return id ? craftTiers(reg).findIndex((t) => t.id === id) : -1;
}

/** Индекс ступени ЛЮБОЙ вещи: записанная, иначе выведенная по статам (старые сейвы). */
export function tierIndexOfItem(reg: ConfigRegistry, item: Item): number {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const id = item.tier ?? (base ? inferTierId(reg.get('item-tiers'), base, item, reg.get('balance').loot.baseRoll) : undefined);
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

/**
 * Безопасный ключ словаря из базы (id класса, id материала): короткий, из латиницы, цифр, `_` и `-`, и
 * НЕ ключ прототипа. ⚠ R10-10: определён в `session/wireLimits.ts` — тот же алфавит держит схема конфига.
 */
export { isSafeKey };

/**
 * ЖУРНАЛ ИЗ БАЗЫ → ВАЛИДНЫЙ ЖУРНАЛ. Лежит в JSONB аккаунта, и доверять форме нельзя: старая
 * запись, ручная правка, чужая версия кода. Чего нет или что не того типа — пусто, ноль, −1.
 * Массивы — только строки и без повторов; счётчики — целые ≥ 0. Возвращает НОВЫЙ объект.
 */
export function normalizeJournal(raw: unknown): CraftJournal {
  const j = emptyJournal();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return j;
  const r = raw as Record<string, unknown>;
  const strs = (x: unknown): string[] =>
    Array.isArray(x) ? [...new Set(x.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 128))] : [];
  const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  j.bases = strs(r.bases);
  j.variants = strs(r.variants);
  j.typesSeen = strs(r.typesSeen);
  j.typesForged = strs(r.typesForged);
  j.tierHi = typeof r.tierHi === 'number' && Number.isInteger(r.tierHi) && r.tierHi >= -1 ? r.tierHi : -1;
  j.sketches = count(r.sketches);
  j.mythic = count(r.mythic);
  const cs = r.classSalvages;
  if (cs && typeof cs === 'object' && !Array.isArray(cs)) {
    for (const [k, v] of Object.entries(cs as Record<string, unknown>)) {
      const n = count(v);
      if (isSafeKey(k) && n > 0) j.classSalvages[k] = n;
    }
  }
  return j;
}

// ── Ключ заявки на ковку ─────────────────────────────────────────────────────────────────────────

/**
 * КЛЮЧ ИДЕМПОТЕНТНОСТИ заявки на ковку (`nonce`): его придумывает клиент, сервер помнит последние
 * `CRAFT_NONCES_KEEP` на АККАУНТЕ рядом с журналом. Повтор заявки после обрыва связи или переезда на
 * другую ноду находит свой ключ и отвечает прежней вещью, а не кует вторую и не списывает второй раз.
 */
export const CRAFT_NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const CRAFT_NONCES_KEEP = 32;
export interface CraftNonce { n: string; uid: string }

export const isCraftNonce = (x: unknown): x is string => typeof x === 'string' && CRAFT_NONCE_RE.test(x);

/** Ключи из базы → только валидные `{n, uid}`, без повторов (побеждает последний), не больше 32 последних. */
export function normalizeCraftNonces(raw: unknown): CraftNonce[] {
  if (!Array.isArray(raw)) return [];
  const byN = new Map<string, CraftNonce>();
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const { n, uid } = e as Record<string, unknown>;
    if (!isCraftNonce(n) || typeof uid !== 'string' || !uid.length || uid.length > 128) continue;
    byN.delete(n);                        // повтор — переезжает в конец, как свежий
    byN.set(n, { n, uid });
  }
  return [...byN.values()].slice(-CRAFT_NONCES_KEEP);
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

/**
 * Варианты гнезда для семейства, по оси от «+1» к «−1» (так их и показывает окно ковки). У клинков с
 * измеренной геометрией — по ВЫВЕДЕННОЙ оси (§26): ручное число у них задаёт только вид заглушки.
 */
export function variantsFor(reg: ConfigRegistry, weaponClass: string, slot: CraftSlot, hands?: number): WeaponPart[] {
  return reg.get('weapon-parts')
    .filter((p) => p.enabled !== false && p.slot === slot && (p.classes as string[]).includes(weaponClass) && (hands === undefined || !p.hands.length || p.hands.includes(hands)))
    .map((p) => ({ p, a: axisOf(reg, p) }))
    .sort((x, y) => y.a - x.a || x.p.id.localeCompare(y.p.id))
    .map((x) => x.p);
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
 * у ключа — эталон базы с самым высоким потолком (при равенстве — эталонной базы класса, чья своя скорость
 * ближе всего к ×1, потом — с самым богатым пулом форм: у меча это длинный, а не короткий с его +6 %); материалы —
 * `step`, прижатый к окну формы. `null` — семейство сейчас не куётся: в каком-то гнезде нет ни одной включённой детали
 * (хозяин снял гнездо с игры в редакторе — схема это разрешает; окно ковки говорит это, а не падает: V-B3-06).
 */
export function defaultParts(reg: ConfigRegistry, weaponClass: string, hands: number, step = 1): CraftParts | null {
  const keySlot = keySlotOf(reg, weaponClass);
  const hiOf = (id: string): number => { const b = reg.get('items.base').find((x) => x.id === id); return b ? baseTierRange(reg, b).hi : -1; };
  // При равном потолке — ЭТАЛОННАЯ база класса: своя скорость ближе всего к ×1 (длинный меч, а не короткий
  // с его +6 % — у того пул больше, но он не эталон). Потом — пул богаче.
  const speedOff = (id: string): number => {
    const b = reg.get('items.base').find((x) => x.id === id);
    return Math.abs(b ? baseFlat(b, 'attackSpeed') + b.baseStats.filter((m) => m.stat === 'attackSpeed' && m.kind === 'increased').reduce((s, m) => s + m.value, 0) : 0);
  };
  // V-B3-06: база, чьи формы все выключены в редакторе, в эталон не годится — иначе `null` («семейство не куётся») при живых формах других баз.
  const keyGroup = keyVariantsByBase(reg, weaponClass, hands).filter((g) => g.variants.length > 0)
    .sort((a, b) => hiOf(b.baseId) - hiOf(a.baseId) || speedOff(a.baseId) - speedOff(b.baseId) || b.variants.length - a.variants.length)[0];
  const pick = (slot: CraftSlot): CraftPartPick | undefined => {
    const pool = slot === keySlot ? (keyGroup?.variants ?? []) : variantsFor(reg, weaponClass, slot, hands);
    const p = [...pool].sort((a, b) => Math.abs(axisOf(reg, a)) - Math.abs(axisOf(reg, b)))[0];
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
 * `recorded` — детали, ЗАПИСАННЫЕ на вещь (R6-10): выключенная после рождения вещи всё равно её деталь, и числа вещи собираются
 * из неё, как переплавка (`meltReturn`) возвращает сырьё выключенной. Новую вещь из выключенной не собрать (ковка, дроп).
 */
export function resolveParts(
  reg: ConfigRegistry,
  weaponClass: string,
  hands: number,
  picks: CraftParts,
  opts: { recorded?: boolean } = {},
): { ok: true; parts: ResolvedParts } | { ok: false; reason: string } {
  const anat = anatomyRow(reg, weaponClass);
  if (!anat) return { ok: false, reason: 'Такого класса кузнец не знает' };
  const out: Partial<ResolvedParts> = {};
  for (const slot of CRAFT_SLOT_LIST) {
    const pick = picks[slot];
    const p = pick && partById(reg, pick.id);
    if (!p || (p.enabled === false && !opts.recorded)) return { ok: false, reason: `Нет такой детали: ${pick?.id ?? '—'}` };
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
  /**
   * Разброс мин–макс от ширины клинка (§26): ложится в числа базы (`scaleBaseStats`) и на вещь как
   * `spreadMult`. Нет — клинок без геометрии, числа базы как есть.
   */
  spread?: number;
  /** Точка баланса вещи, в ±1: клинок + оголовье (§26); у клинка без геометрии — ось оголовья. */
  balance: number;
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
  // ⭐ У клинка с измеренной геометрией ось — его место в вилке по длине (+ поправка формы), §26.
  const blade = bladeStats(reg, parts.strike);
  const a1 = blade ? blade.axis : strikeAxisOf(reg, parts.strike);
  const damageMult = r4(1 + k.strike.damagePct * a1);
  push('attackSpeed', 'flat', -k.strike.attackSpeed * a1);
  if (blade?.outOfBracket) {
    notes.push(blade.bracket
      ? `Клинок ${parts.strike.geom!.len} см вне вилки «${blade.bracket.name}» (${blade.bracket.lo}–${blade.bracket.hi}): ось упёрлась в край.`
      : 'У клинка нет вилки по тегу `blade`: длина и ширина не считаются.');
  }

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
  // ⭐ У клинка с геометрией рычаг — ТОЧКА БАЛАНСА вещи: клинок и оголовье вместе, в ±1 (§26). Один
  // продавец блока и статуса, а не два — иначе крайние детали складывались бы вдвое (§23).
  const a4 = balanceAxisOf(reg, parts.strike, parts.head);
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

  const spread = blade && blade.spread !== 1 ? blade.spread : undefined;
  return { damageMult, mods, reachMult, arcMult, affixCap, statusKind, spread, balance: a4, notes };
}

/** Форма чисел базы по запеканию: разброс клинка (или ничего). */
export const shapeOfBake = (bake: Pick<CraftBake, 'spread'>): BaseShape | undefined =>
  bake.spread !== undefined ? { spread: bake.spread } : undefined;

// ── Цена ────────────────────────────────────────────────────────────────────────────────────────

export interface CraftCostLine { slot: CraftSlot; family: string; id: string; n: number }
/** Доводка в цене: отдельной строкой, а не в `lines` — переплавка возвращает долю `lines`, доводку нет. */
export interface CraftFinishCost { index: number; name: string; floor: number; id: string; n: number; goldMult: number }
export interface CraftCost { materials: MaterialCost; gold: number; lines: CraftCostLine[]; mult: number; finish?: CraftFinishCost }

type FinishRow = CraftTuning['finish'][number];
/** Уровень доводки по индексу; вне списка или список пуст — «без доводки» (пол 0). */
export function finishOf(reg: ConfigRegistry, index: number | undefined): FinishRow & { index: number } {
  const list = reg.get('balance').craft.finish;
  const i = Math.max(0, Math.min(list.length - 1, Math.round(index ?? 0)));
  const row = list[i];
  return row ? { ...row, index: i } : { id: 'plain', name: 'Обычная работа', floor: 0, strikeUnits: 0, goldMult: 1, index: 0 };
}

/**
 * ЦЕНА КОВКИ (§13): каждая деталь — СВОИМ материалом, единиц по её МАССЕ (клинок вдвое тяжелее
 * остального — те же доли, что у ступени вещи), всё ×M формы ёмкости: перекошенная форма дороже
 * сбалансированной. Дешёвая рукоять под дорогим клинком — законный способ сэкономить: она же и
 * тянет ступень вещи вниз ровно на свою долю.
 */
export function craftCost(reg: ConfigRegistry, weaponClass: string, parts: ResolvedParts, picks: CraftParts, t: number, form: AffixForm, finish?: number): CraftCost {
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
  const gold = Math.round(k.cost.goldPerReqMult * (tier?.reqMult ?? 1));
  // Доводка — сырьём УДАРНОЙ части (клинок доводят его же металлом) и золотом ×goldMult. Каждая строка
  // платит и действует СВОИМИ числами: «первая = без доводки» — лишь договорённость данных, не код,
  // иначе удалённая «Обычная работа» сделала бы бесплатной следующую строку.
  const f = finishOf(reg, finish);
  const strike = lines.find((l) => l.slot === 'strike');
  const neutral = f.floor <= 0 && f.strikeUnits <= 0 && f.goldMult === 1;
  if (neutral || !strike) return { materials, gold, lines, mult: M };
  if (f.strikeUnits > 0) materials[strike.id] = (materials[strike.id] ?? 0) + f.strikeUnits;
  return {
    materials, gold: Math.round(gold * f.goldMult), lines, mult: M,
    finish: { index: f.index, name: f.name, floor: f.floor, id: strike.id, n: f.strikeUnits, goldMult: f.goldMult },
  };
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
  /** Уровень доводки — индекс в `balance.craft.finish`; нет — без доводки. */
  finish?: number;
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
  /**
   * ⭐ ВИЛКА: что может выпасть при этой доводке — [низ, верх] по каждой катаемой стате (без формы
   * клинка: её множитель накладывает подсказка). У предпросмотра вещь — середина вилки, а числа
   * игрок видит только так; настоящий бросок — при ковке (`opts.rng`).
   */
  ranges?: Partial<Record<RolledStat, [number, number]>>;
}

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
  && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const shortId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64;
const INPUT_KEYS = ['weaponClass', 'hands', 'parts', 'finish'] as const;
const PICK_KEYS = ['id', 'step'] as const;

/**
 * ⭐ ЗАЯВКА С ПРОВОДА → ЧИСТАЯ `CraftInput`. Сервер не верит ни одному полю: заявка пересобирается
 * заново из `{id, step}` четырёх гнёзд, и ни один лишний ключ до вещи не доезжает (иначе `parts`
 * скованной вещи несли бы то, что прислал клиент). Отказ, а не молчаливая правка:
 * - гнёзд ровно четыре, у каждого ровно `id` (строка) и `step` (целое 1…5);
 * - хват — 1 или 2; класс — строка;
 * - доводка — целый индекс существующей строки `balance.craft.finish`. ⚠ `finishOf` индекс ПРИЖИМАЕТ
 *   молча — для окна это удобно, для заявки опасно: игрок платил бы за одну доводку, а получал другую.
 * Остальное (есть ли деталь, её гнездо, класс, окно ступеней, журнал) проверяет `craftWeapon`.
 */
export function parseCraftInput(reg: ConfigRegistry, raw: unknown): { ok: true; input: CraftInput } | { ok: false; reason: string } {
  const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  if (!isPlainObject(raw) || !onlyKeys(raw, INPUT_KEYS)) return bad('Неверная заявка на ковку');
  const { weaponClass, hands, parts, finish } = raw;
  if (!shortId(weaponClass)) return bad('Неверная заявка: класс оружия');
  if (hands !== 1 && hands !== 2) return bad('Неверная заявка: хват');
  if (!isPlainObject(parts) || !onlyKeys(parts, CRAFT_SLOT_LIST) || !CRAFT_SLOT_LIST.every((s) => s in parts)) {
    return bad('Неверная заявка: нужны ровно четыре детали');
  }
  const clean = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pick = parts[slot];
    if (!isPlainObject(pick) || !onlyKeys(pick, PICK_KEYS) || !shortId(pick.id)) return bad('Неверная заявка: деталь');
    const step = pick.step;
    if (typeof step !== 'number' || !Number.isInteger(step) || step < 1 || step > MATERIAL_STEPS) return bad('Неверная заявка: ступень материала');
    clean[slot] = { id: pick.id, step };
  }
  const input: CraftInput = { weaponClass, hands, parts: clean };
  if (finish !== undefined) {
    const n = reg.get('balance').craft.finish.length;
    if (typeof finish !== 'number' || !Number.isInteger(finish) || finish < 0 || finish >= Math.max(1, n)) return bad('Неверная заявка: доводка');
    input.finish = finish;
  }
  return { ok: true, input };
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
  opts: { journal?: CraftJournal; materialsOn?: boolean; atTier?: number; rng?: Rng; at?: 'lo' | 'hi' } = {},
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
  // ⚠ R12-08: выключенная в редакторе ступень не куётся — как не падает и с монстров. Прежде её индекс занимала следующая
  // включённая: те же материалы давали вещь ступенью выше (и с чужой ёмкостью аффиксов).
  if (tiers[t]?.enabled === false && tiers.some((x) => x.enabled !== false)) {
    return { ok: false, reason: `Ступень ${tiers[t]!.name} кузнец сейчас не куёт: возьми материалы другой ступени`, ...view };
  }
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
  const cost = craftCost(reg, input.weaponClass, res.parts, input.parts, t, bake.affixCap, input.finish);
  if (opts.materialsOn) {
    const off = Object.keys(cost.materials).find((id) => !reg.get('craft-materials').some((m) => m.id === id && m.enabled !== false));
    if (off) return { ok: false, reason: `Материал ещё не в игре: ${off}`, cost, bake, ...view };
  }

  // ⭐ Бросок базы: без `rng` — предпросмотр (середина вилки + сама вилка), с `rng` — ковка.
  // Доводка поднимает только ПОЛ броска; верх вилки тот же, что у найденной вещи этого тира.
  const spread = reg.get('balance').loot.baseRoll;
  const floor = cost.finish?.floor ?? 0;
  // Форма клинка (разброс от ширины, §26) — в числа базы ДО тира и броска: вилка «от и до» уже с ней.
  const shape = shapeOfBake(bake);
  const ranges = baseStatRange(base, tier.statMult, spread, floor, shape);
  // `at` — вещь на краю вилки (низ при этой доводке / верх): окно сравнивает «от и до», а не середину.
  // Предпросмотр — середина СВОЕЙ вилки: при доводке без пола это прежнее число (поле не пишем), с полом —
  // середина [пол, 1], иначе вещь окна несла бы урон, которого ковка не даст никогда.
  const lo = snapFloor(floor);
  const baseRoll: BaseRoll | undefined = opts.rng ? rollBaseQ(base, opts.rng, floor)
    : opts.at ? fixedBaseRoll(base, opts.at === 'lo' ? lo : 1)
    : lo > 0 ? fixedBaseRoll(base, (lo + 1) / 2) : undefined;
  // ⭐ Требования — со скидкой кузнеца, ТОЙ ЖЕ, что у подъёма тира (`forgePrices.upgradeReqDiscount`):
  // «кузнечная вещь легче в требованиях». Без неё скованная ступень надевалась позже поднятой находки
  // той же ступени, и ковка проигрывала подъёму всегда (замер К7, §22). Предпросмотр — этот же вызов.
  const bal = reg.get('balance');
  const item = buildCraftShell(base, tier, bal.maxTotalRequirement, { baseRoll, spread, shape, reqDiscount: bal.forgePrices.upgradeReqDiscount });
  if (!opts.rng && !opts.at) item.rollPreview = ranges;
  item.name = craftedName(tier, type);
  item.baseStats = [...item.baseStats, ...bake.mods]; // новый массив: статы базы в конфиге не трогаем
  if (bake.damageMult !== 1) item.damageMult = bake.damageMult;
  if (bake.reachMult !== undefined) item.reachMult = bake.reachMult;
  if (bake.arcMult !== undefined) item.arcMult = bake.arcMult;
  item.affixCap = bake.affixCap;
  item.parts = structuredClone(input.parts);
  // Что заплачено сырьём (без доводки): переплавка вернёт долю ЭТОГО, а не цены после правки конфига (§16).
  item.craftPaid = cost.lines.filter((l) => l.n > 0).map((l) => ({ id: l.id, n: l.n }));
  if (type.typeId) item.typeId = type.typeId;
  return { ok: true, item, cost, bake, ranges, ...view };
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

/**
 * ⭐ НАБЕРЁТ ЛИ ПУЛ ОПЛАЧЕННУЮ ФОРМУ — при ЛЮБОМ исходе броска (§17). `rollAffixes` при опустевшем
 * пуле делает `break` МОЛЧА: выключил дизайнер полдюжины аффиксов — игрок заплатил за пять слотов,
 * получил три, и никто не узнал. Поэтому отказ — до оплаты, и по худшему случаю, а не по среднему.
 *
 * Модель броска: каждый выбор выносит из пула «узел» — сам аффикс, его группу и тёзок по id (узлы —
 * связные компоненты по группе и id; склеить лишнее — только строже). Узел бывает только-префиксным,
 * только-суффиксным и смешанным. Худший случай: выборы одной стороны съедают смешанные узлы другой.
 * Застрять цикл может трижды — кончились все узлы; добрали префиксы, а суффиксов не осталось; и
 * наоборот. Здесь проверяются ровно эти три неравенства.
 */
export function affixSlotsFillable(
  pool: readonly { id: string; kind: 'prefix' | 'suffix'; group?: string }[],
  slots: { minAffixes: number; maxAffixes: number; maxPrefix: number; maxSuffix: number },
): boolean {
  const P = Math.max(0, slots.maxPrefix), S = Math.max(0, slots.maxSuffix);
  if (slots.minAffixes > P + S) return false;               // нижнюю границу не набрать при любом пуле
  const total = Math.min(Math.max(0, slots.maxAffixes), P + S);
  if (total <= 0) return true;
  // Узлы: объединяем аффиксы с общей группой и с общим id (выбор выносит и тех, и других).
  const parent = pool.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const union = (a: number, b: number): void => { parent[find(a)] = find(b); };
  const firstBy = new Map<string, number>();
  pool.forEach((a, i) => {
    for (const key of [`id:${a.id}`, ...(a.group ? [`g:${a.group}`] : [])]) {
      const j = firstBy.get(key);
      if (j === undefined) firstBy.set(key, i); else union(i, j);
    }
  });
  const sides = new Map<number, { p: boolean; s: boolean }>();
  pool.forEach((a, i) => {
    const r = find(i);
    const u = sides.get(r) ?? { p: false, s: false };
    if (a.kind === 'prefix') u.p = true; else u.s = true;
    sides.set(r, u);
  });
  let pureP = 0, pureS = 0, mixed = 0;
  for (const u of sides.values()) { if (u.p && u.s) mixed++; else if (u.p) pureP++; else if (u.s) pureS++; }
  if (pureP + pureS + mixed < total) return false;
  if (total > S && pureP + mixed - Math.min(S, mixed) < total - S) return false;
  if (total > P && pureS + mixed - Math.min(P, mixed) < total - P) return false;
  return true;
}

/**
 * Слоты зачарования вещи до редкости `rarity` и ответ «пул их наберёт» — один расчёт для окна и сервера.
 * Нет базы или редкости — `null`: зачаровывать нечего.
 */
export function enchantSlots(reg: ConfigRegistry, item: Item, rarity: Rarity):
  { slots: ReturnType<typeof affixSlotsFor>; fillable: boolean } | null {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const rDef = reg.get('rarities').find((r) => r.id === rarity);
  if (!base || !rDef) return null;
  const slots = affixSlotsFor(rDef, item.affixCap);
  const pool = affixPool(reg.get('affixes'), affixTargetOfBase(base), rarity, item.itemLevel);
  return { slots, fillable: affixSlotsFillable(pool, slots) };
}

/**
 * ⭐ M ФОРМЫ, КОТОРУЮ ВЕЩЬ ПРИМЕТ при редкости `rarity` (R2-23): ёмкость, зажатая лимитами редкости
 * (`affixSlotsFor`), а не объявленная. Магическая у 3+2 катает 1+1 — и платит как 1+1 (×1.09), а не ×5.97
 * за пять слотов, которых не получит. Один шов на зачарование и перекатку (R2-10): обе катают ровно эту
 * форму и обе за неё платят. Потолок редкости ниже P+S делает сплит неопределённым — тогда берём верх
 * (P, S): переплатить безопаснее, чем недоплатить. Нет ёмкости (найденная вещь) — 1.
 */
export function rolledFormMult(reg: ConfigRegistry, item: Item, rarity: Rarity): number {
  if (!item.affixCap) return 1;
  const s = affixSlotsFor(reg.get('rarities').find((r) => r.id === rarity), item.affixCap);
  return formMult(reg, { prefix: s.maxPrefix, suffix: s.maxSuffix });
}

/** Цена зачарования: золото × множитель ступени × цена редкости × M формы, которую она катает (§13). */
export function enchantCost(reg: ConfigRegistry, item: Item, rarity: Rarity): number {
  const k = reg.get('balance').craft;
  const tier = craftTiers(reg)[tierIndexOfItem(reg, item)];
  const rDef = reg.get('rarities').find((r) => r.id === rarity);
  return Math.round(k.cost.enchantGold * (tier?.reqMult ?? 1) * (rDef?.priceMult ?? 1) * rolledFormMult(reg, item, rarity));
}

/**
 * ⭐ ЗАЧАРОВАТЬ: поднять вещь до магической или редкой. Аффиксы катаются ТЕМ ЖЕ броском, что у
 * дропа, только слоты берутся из ёмкости вещи. Случайность здесь законна (правило Р3): форма
 * известна заранее, катаются значения. Имя строится от ТИПА («Жгучий ранний меч»), а не от
 * базы. Возвращает НОВЫЙ предмет — исходный не трогает.
 * ⚠ Нет базы в конфиге — `null`, а не «вещь как была»: иначе зовущий принял бы нетронутую вещь за
 * зачарованную и взял бы за неё золото.
 */
export function enchantItem(reg: ConfigRegistry, item: Item, rarity: Rarity, rng: Rng): Item | null {
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base) return null;
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
 * переехать. Поэтому любое найденное оружие получает детали НАВСЕГДА в момент рождения (`foundParts`,
 * `shapeFoundWeapon`) — после этого вывод для него не зовётся. Вывод от `uid` остаётся старым сейвам.
 */
export function partsOf(reg: ConfigRegistry, item: Item): CraftParts | null {
  if (item.parts) return item.parts;
  if (item.foundParts) return item.foundParts;
  return deriveParts(reg, item, hashStr(`${item.uid}|${item.baseId}`));
}

/** Вывод деталей найденной вещи с заданным сидом (ступени — под её тир, варианты — по частоте на дропе). */
function deriveParts(reg: ConfigRegistry, item: Item, seed: number): CraftParts | null {
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
  const rng = createRng(seed);
  const has =(slot: CraftSlot, s: number): boolean => pools[slot].some((p) => p.stepMin <= s && s <= p.stepMax);

  // Ступени: все четвёрки, из которых кузнец собрал бы ровно эту ступень, — ровные предпочтительнее.
  // ⚠ Предпочтительнее В СУММЕ, а не поштучно (R2-30): перекошенных четвёрок на ступень сотни, и при весе
  // `1/(1+разброс)` они вместе перевешивали ровную — ступень 5 была у 26 % находок t2, у 48 % t3. Вес падает
  // экспонентой от разброса (`craft.foundEvenness`), отсчёт — от ровнейшей: у неё вес 1 при любом k, и
  // большое k не обнулит все веса разом (тогда `weighted` молча взял бы первую по перебору, а не ровную).
  type Steps = Record<CraftSlot, { step: number }>;
  const exact: { s: Steps; dev: number }[] = [];
  let near: { s: Steps; d: number } | null = null;
  for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (let c = 1; c <= 5; c++) for (let d = 1; d <= 5; d++) {
    const s: Steps = { strike: { step: a }, grip: { step: b }, bind: { step: c }, head: { step: d } };
    if (!CRAFT_SLOT_LIST.every((sl) => has(sl, s[sl].step))) continue;
    const { q, tier } = tierOfSteps(reg, s);
    if (tier === t) exact.push({ s, dev: CRAFT_SLOT_LIST.reduce((acc, sl) => acc + Math.abs(s[sl].step - q), 0) });
    else if (!near || Math.abs(tier - t) < near.d) near = { s, d: Math.abs(tier - t) };
  }
  const even = reg.get('balance').craft.foundEvenness;
  const devMin = exact.reduce((m, x) => Math.min(m, x.dev), Infinity);
  const chosen = weighted(exact, (x) => Math.exp(-even * (x.dev - devMin)), rng)?.s ?? near?.s;
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

/**
 * СТУПЕНИ ЗАПИСАННЫХ ДЕТАЛЕЙ ПОД НОВУЮ СТУПЕНЬ ВЕЩИ — для подъёма найденного меча в кузнице (§26).
 * Варианты те же (клинок не меняется вместе с тиром), а ступени материала — такие, чтобы из них ковалась
 * ровно ступень `t`: разбор обязан отдавать то, из чего вещь сделана (§10.9). Из подходящих четвёрок —
 * ближайшая к прежней.
 *
 * ⚠ R4-31: РОВНО НЕ СОБИРАЕТСЯ (окна материалов не пускают) — `null`. Прежде бралась ближайшая по ступени, и t5-меч,
 * чей клинок выше ступени 4 не куётся, становился t6 с деталями t5: разбор отдавал прежнее сырьё, а сама форма была
 * такой, какую ковка на t6 не собирает и какой не бывает у найденного t6. Детали не из конфига — как есть: проверить нечем.
 * Подъём у кузнеца на `null` не останавливается — см. `upgradeFoundParts` (R5-09).
 */
export function restepParts(reg: ConfigRegistry, parts: CraftParts, t: number): CraftParts | null {
  const recs = CRAFT_SLOT_LIST.map((slot) => partById(reg, parts[slot].id));
  if (recs.some((p) => !p)) return parts;
  const win = recs.map((p) => { const a: number[] = []; for (let s = p!.stepMin; s <= p!.stepMax; s++) a.push(s); return a; });
  let best: { s: CraftParts; move: number } | null = null;
  for (const a of win[0]!) for (const b of win[1]!) for (const c of win[2]!) for (const e of win[3]!) {
    const steps = [a, b, c, e];
    const s = {} as CraftParts;
    CRAFT_SLOT_LIST.forEach((slot, i) => { s[slot] = { id: parts[slot].id, step: steps[i]! }; });
    if (tierOfSteps(reg, s).tier !== t) continue;
    const move = CRAFT_SLOT_LIST.reduce((acc, slot) => acc + Math.abs(s[slot].step - parts[slot].step), 0);
    if (!best || move < best.move) best = { s, move };
  }
  return best?.s ?? null;
}

/**
 * ⭐ ДЕТАЛИ НАЙДЕННОГО ПОД СТУПЕНЬ ПОДЪЁМА У КУЗНЕЦА (§26, §10.9). Сперва — те же четыре варианта на других ступенях
 * (`restepParts`). Не собираются — ДЕРЖИТСЯ ТО, ЧТО НЕСЁТ ТИП И ЧИСЛА: ключевая деталь (тип, кодекс), а у клинка с
 * геометрией ещё и оголовье (точка баланса — блок и укус). Прочие гнёзда числа найденной вещи не трогают (держак и
 * обвязка — см. `shapeFoundWeapon`), и под ступень берётся другой вариант той же семьи: по частоте на дропе, как у
 * находки (`rarityWeight`), с сидом от самой вещи — предпросмотр и подъём дают одно и то же, лотереи нет (и перекаткой её не
 * устроить: сид — от неизменного в вещи, `upgradeSeed`, R7-17). Меняется
 * как можно меньше гнёзд, ступени — ближе к прежним. Не дотягивается и держимое — `null`: выше эта форма не куётся.
 *
 * ⚠ R5-09: отказ R4-31 бил и по вещам, чьи числа от деталей не зависят вовсе: 15–52 % найденных t5 посохов, жезлов,
 * арбалетов, топоров и кинжалов навсегда не поднимались до t6, потому что окно рукояти или обвязки кончалось на 4-й
 * ступени. Кузница — главный путь к t6 до 80-го уровня, а по находке не видно, какая из них «не куётся».
 */
export function upgradeFoundParts(reg: ConfigRegistry, item: Item, t: number): CraftParts | null {
  const parts = item.foundParts;
  if (!parts) return null;
  // ⚠ R6-10: ВЫКЛЮЧЕННАЯ ПОСЛЕ НАХОДКИ ДЕТАЛЬ на новую ступень не переезжает: такой формы кузнец больше не делает, и подъём
  // обязан собрать то, что собрала бы ковка. Держак или обвязка — берётся другой вариант той же семьи (ниже); клинок, оголовье
  // или ключ (на них тип и числа) — подъёма нет. Прежде `restepParts` переносил её как есть, а сборка статов её отвергала —
  // и вещь уходила на t3 с множителем удара клинка, но без его платы скоростью.
  const off = CRAFT_SLOT_LIST.some((slot) => partById(reg, parts[slot].id)?.enabled === false);
  const same = off ? null : restepParts(reg, parts, t);
  if (same) return same;
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base || base.kind !== 'weapon') return null;
  const cls = base.weaponClass;
  const hands = base.hands ?? 1;
  const strike = partById(reg, parts.strike.id);
  const held = new Set<CraftSlot>([keySlotOf(reg, cls)]);
  if (strike && bladeStats(reg, strike)) { held.add('strike'); held.add('head'); }
  const pools = {} as Record<CraftSlot, WeaponPart[]>;
  for (const slot of CRAFT_SLOT_LIST) {
    const own = partById(reg, parts[slot].id);
    pools[slot] = held.has(slot)
      ? (own && own.enabled !== false ? [own] : [])
      : [...variantsFor(reg, cls, slot, hands)].sort((a, b) => a.id.localeCompare(b.id));
    if (!pools[slot].length) return null;
  }
  const fits = (p: WeaponPart, s: number): boolean => p.stepMin <= s && s <= p.stepMax;
  /** Записанный вариант гнезда остаётся на ступени `s`: он в пуле (включён, той семьи) и его окно её пускает. */
  const keeps = (slot: CraftSlot, s: number): boolean => pools[slot].some((p) => p.id === parts[slot].id && fits(p, s));
  type Steps = Record<CraftSlot, { step: number }>;
  let best: { s: Steps; changed: number; move: number } | null = null;
  for (let a = 1; a <= MATERIAL_STEPS; a++) for (let b = 1; b <= MATERIAL_STEPS; b++) for (let c = 1; c <= MATERIAL_STEPS; c++) for (let d = 1; d <= MATERIAL_STEPS; d++) {
    const s: Steps = { strike: { step: a }, grip: { step: b }, bind: { step: c }, head: { step: d } };
    if (!CRAFT_SLOT_LIST.every((sl) => pools[sl].some((p) => fits(p, s[sl].step)))) continue;
    if (tierOfSteps(reg, s).tier !== t) continue;
    const changed = CRAFT_SLOT_LIST.filter((sl) => !keeps(sl, s[sl].step)).length;
    const move = CRAFT_SLOT_LIST.reduce((acc, sl) => acc + Math.abs(s[sl].step - parts[sl].step), 0);
    if (!best || changed < best.changed || (changed === best.changed && move < best.move)) best = { s, changed, move };
  }
  if (!best) return null;
  const w = reg.get('balance').craft.rarityWeight;
  const rng = createRng(upgradeSeed(item, parts, t));
  const out = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const step = best.s[slot].step;
    if (keeps(slot, step)) { out[slot] = { id: parts[slot].id, step }; continue; }
    const p = weighted(pools[slot].filter((x) => fits(x, step)), (x) => w[x.rarity] ?? 0, rng)!;
    out[slot] = { id: p.id, step };
  }
  return out;
}

/**
 * ⚠ R7-17: СИД ЗАМЕНЫ ДЕТАЛИ ПРИ ПОДЪЁМЕ (`upgradeFoundParts`) — только из того, что у найденной вещи НЕ МЕНЯЕТСЯ после рождения
 * (база, редкость, уровень, бросок базы), её записанных деталей (они и ведут цепочку подъёмов) и ступени подъёма. Прежде — от
 * `foundSeed`, а в нём аффиксы и имя: перекатка у кузнеца их меняет, и три перекатки давали 2–4 разных замены в 93 % таких
 * вещей — предпросмотр (чистая функция) показывал, когда подставится редкая деталь, а разбор поднятой открывал её в журнале.
 * Ключи — в своём порядке, а не в порядке объекта: jsonb базы переставляет ключи, и сид не должен зависеть от записи в базу.
 */
function upgradeSeed(item: Item, parts: CraftParts, t: number): number {
  const roll = item.baseRoll ? (Object.keys(item.baseRoll) as (keyof BaseRoll)[]).sort().map((k) => `${k}:${item.baseRoll![k]}`).join(',') : '';
  const recorded = CRAFT_SLOT_LIST.map((slot) => `${parts[slot].id}@${parts[slot].step}`).join(',');
  return hashStr(`${item.baseId}|${item.rarity}|${item.itemLevel}|${roll}|${recorded}|${t}`);
}

/**
 * Сид деталей найденной вещи — из того, что уже выпало: база, редкость, уровень, тир, бросок, аффиксы,
 * имя. Не из `uid`: тот сделан из времени и `Math.random`, и сим с сидом перестал бы повторяться; и не
 * новым броском `rng` — лишний бросок сдвинул бы всю следующую добычу. Только для РОЖДЕНИЯ вещи (`shapeFoundWeapon`):
 * подъём сеется `upgradeSeed` (R7-17) — аффиксы у кузнеца перекатываются.
 */
function foundSeed(item: Item): number {
  const aff = item.affixes.map((a) => `${a.affixId}:${a.modifier?.value ?? ''}`).join(',');
  return hashStr(`${item.baseId}|${item.rarity}|${item.itemLevel}|${item.tier ?? ''}|${JSON.stringify(item.baseRoll ?? {})}|${aff}|${item.name}`);
}

/**
 * ⭐ НАЙДЕННЫЙ МЕЧ = СКОВАННЫЙ ИЗ ТЕХ ЖЕ ДЕТАЛЕЙ (§26). Вид вещи обязан совпадать с её числами:
 * меч с широким клинком бьёт ровно и с пола, и из кузницы. Детали выводятся один раз и
 * записываются на вещь (`foundParts`), дальше они не переезжают ни при подъёме тира, ни при новом
 * варианте в пуле.
 *
 * Что берётся от деталей: ось длины (удар ↔ скорость), разброс ширины и точка баланса (блок ↔ укус).
 * Держак (дальность и дуга) и обвязка (ёмкость аффиксов) у найденной вещи не трогаются — её аффиксы
 * уже выпали. Уникальные не трогаются вовсе: они собраны руками.
 * ⭐ Детали ЗАПИСЫВАЮТСЯ у любого найденного оружия (§12.1): вывод «на каждом чтении» переезжал бы при
 * правке `rarityWeight` или пула, и разбор открывал бы не то, что было в вещи. Но статы берутся от
 * деталей ТОЛЬКО у ударной части с геометрией; у остальных вещь возвращается с теми же числами, лишь с
 * `foundParts` (сторож — тест «с деталями и без — одни статы»). Остальные классы перейдут на эту систему
 * сами, как только их ударные части получат модели. Идемпотентна: статы пересобираются от базы,
 * повторный вызов даёт то же самое.
 */
export function shapeFoundWeapon(reg: ConfigRegistry, item: Item): Item {
  if (item.parts || item.rarity === 'unique' || item.kind !== 'weapon') return item;
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  if (!base || base.kind !== 'weapon') return item;
  const picks = item.foundParts ?? deriveParts(reg, item, foundSeed(item));
  if (!picks) return item;
  // R6-10: записанные детали собираются и выключенными после рождения вещи — это её детали (`recorded`).
  const res = resolveParts(reg, base.weaponClass, base.hands ?? 1, picks, { recorded: !!item.foundParts });
  const t = tierIndexOfItem(reg, item);
  const statMult = reg.get('item-tiers').find((x) => x.id === item.tier)?.statMult ?? craftTiers(reg)[t]?.statMult ?? 1;
  // ⚠ R6-10: ЗАПЕЧЬ НЕЧЕМ (деталь убрана из конфига, у клинка не стало геометрии), а вещь клинок уже запекал (подъём у
  // кузнеца: `retierItem` оставил его `damageMult`/`spreadMult`, а статы собрал от базы) — ось удара снимается ЦЕЛИКОМ:
  // множитель, разброс и числа формы. Одна сторона оси без другой — урон клинка без его платы скоростью.
  const plain = (it: Item): Item => {
    if (it.damageMult === undefined && it.spreadMult === undefined) return it;
    const { damageMult: _d, spreadMult: _s, ...rest } = it;
    return { ...rest, baseStats: scaleBaseStats(base.baseStats, statMult, it.baseRoll, reg.get('balance').loot.baseRoll) };
  };
  if (!res.ok) return plain(item);
  // Не клинок с геометрией — детали записаны, числа вещи НЕ тронуты (ни статы, ни множители).
  if (!bladeStats(reg, res.parts.strike)) return plain({ ...item, foundParts: structuredClone(picks) });
  const bake = bakeParts(reg, base, t, res.parts);
  const shape = shapeOfBake(bake);
  const out: Item = {
    ...item,
    foundParts: structuredClone(picks),
    // От базы, а не от текущих статов: повторный вызов не накопит вклад клинка дважды.
    baseStats: [...scaleBaseStats(base.baseStats, statMult, item.baseRoll, reg.get('balance').loot.baseRoll, shape), ...bake.mods],
  };
  if (bake.damageMult !== 1) out.damageMult = bake.damageMult; else delete out.damageMult;
  if (shape?.spread !== undefined) out.spreadMult = shape.spread; else delete out.spreadMult;
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
  /** Засчитан мифик: t6 и найден (`countsAsMythicFind`), а не куплен, не скован и не поднят кузнецом. */
  mythic: boolean;
}

/**
 * Откуда вещь НАЙДЕНА (§12.2): дроп, сундук, босс. Только такая вещь учит журнал деталям и кодексу, копит
 * жалость-эскиз и ворота t6. Лавка, награда, старт и ковка — нет; вещь без поля (сейв старше него) — тоже
 * нет: доверять нечему.
 */
export const FIND_ORIGINS: ReadonlySet<ItemOrigin> = new Set<ItemOrigin>(['drop', 'chest', 'boss']);

/** Откуда должна прийти мифическая вещь, чтобы её разбор засчитался воротам t6: те же найденные. */
export const MYTHIC_ORIGINS: ReadonlySet<ItemOrigin> = FIND_ORIGINS;

/** Найдена ли вещь (`FIND_ORIGINS`), а не куплена, выдана или без происхождения. */
export const countsAsFind = (item: Pick<Item, 'origin'>): boolean => !!item.origin && FIND_ORIGINS.has(item.origin);

/** Засчитается ли разбор этой вещи счётчику мификов: найдена, а не куплена, и ступень не поднята кузнецом. */
export const countsAsMythicFind = (item: Pick<Item, 'origin' | 'tierForged'>): boolean =>
  countsAsFind(item) && !item.tierForged;

/**
 * ⭐ РАЗОБРАЛ — ОТКРЫЛ (§12). Разбор вещи у кузнеца открывает её базу и четыре её детали, двигает
 * потолок ступени, отмечает тип в кодексе и копит жалость: каждые `sketchAfter` разборов своего
 * класса дают «эскиз». 95-й перцентиль ожидания редкой детали без него — 36 часов, и каталог
 * превращается в издевательство.
 * Скованное сюда не идёт: у него свой глагол «переплавить», иначе ковка стала бы прачечной знаний.
 * ⚠ Детали, кодекс, жалость и ворота t6 — только у НАЙДЕННОГО (`countsAsFind`). Стартовый набор бесплатен и
 * бесконечен (создал героя → разобрал → удалил), а лавка катается по уровню первого в комнате: альт первого
 * уровня скупал бы каталог деталей и эскизы по ценам t0. Купленное, выданное и вещь без происхождения
 * открывают только ТИП и ПОТОЛОК СТУПЕНИ — «что это за вещь и какой она ступени»: цена лавки видит ступень (§12.4).
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
  const newBase = !j.bases.includes(base.id);
  if (newBase) j.bases.push(base.id);
  const t = tierIndexOfItem(reg, item);
  const tierUp = t > j.tierHi;
  if (tierUp) j.tierHi = t;
  if (!countsAsFind(item)) return { journal: j, unlocked: [], newBase, sketch: false, tierUp, mythic: false };
  const unlocked: string[] = [];
  for (const slot of CRAFT_SLOT_LIST) if (!j.variants.includes(parts[slot].id)) { j.variants.push(parts[slot].id); unlocked.push(parts[slot].id); }
  const type = typeOfItem(reg, item);
  const newType = type?.typeId && !j.typesSeen.includes(type.typeId) ? type.typeId : undefined;
  if (newType) j.typesSeen.push(newType);
  const k = reg.get('balance').craft.journal;
  const n = (j.classSalvages[base.weaponClass] ?? 0) + 1;
  const sketch = n >= k.sketchAfter;
  j.classSalvages[base.weaponClass] = sketch ? n - k.sketchAfter : n;
  if (sketch) j.sketches += 1;
  // ⚠ Ворота t6 считают только НАЙДЕННЫЕ мифики (`countsAsMythicFind`): иначе лавка на 80-м уровне,
  // где вся витрина мифическая, продавала бы их за золото (§12.4), а кузница поднимала бы t5 до t6.
  const mythic = t === craftTiers(reg).length - 1 && countsAsMythicFind(item);
  if (mythic) j.mythic += 1;
  return { journal: j, unlocked, newBase, newType, sketch, tierUp, mythic };
}

/**
 * Можно ли потратить эскиз на вариант. ⚠ Ключевой вариант НЕОТКРЫТОЙ базы — нельзя: ключ несёт
 * тип, и эскиз стал бы чертежом в обход разбора, а базы открываются только разбором. Выключенный — тоже нельзя
 * (R3-11): ковать из него нельзя, и эскиз пропал бы зря.
 */
export function sketchable(reg: ConfigRegistry, journal: CraftJournal, variantId: string): boolean {
  const p = partById(reg, variantId);
  if (!p || p.enabled === false || journal.variants.includes(variantId)) return false;
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
 * ⚠ Доля — от ЗАПЛАЧЕННОГО (`item.craftPaid`, записано ковкой), а не от нынешней цены: цену перекалибруют
 * в редакторе (§13), и при пересчёте по ней каждая уже скованная вещь после подорожания переплавлялась бы
 * дороже, чем обошлась, — печатный станок сырья. Нет записи (вещь старше поля) — по нынешней цене, как было.
 */
export function meltReturn(reg: ConfigRegistry, item: Item): MaterialCost {
  if (!item.parts) return {};
  const k = reg.get('balance').craft;
  if (Array.isArray(item.craftPaid)) {
    const out: MaterialCost = {};
    for (const line of item.craftPaid) {
      if (!line || typeof line.id !== 'string' || !isSafeKey(line.id) || !Number.isFinite(line.n) || line.n <= 0) continue;
      const n = Math.floor(Math.floor(line.n) * k.melt.share);
      if (n > 0) out[line.id] = (out[line.id] ?? 0) + n;
    }
    return out;
  }
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const anat = base?.kind === 'weapon' ? anatomyRow(reg, base.weaponClass) : undefined;
  if (!anat) return {};
  // Те же строки, что у `craftCost` (единицы гнезда × M формы, доводка — нет), но БЕЗ проверок
  // `resolveParts`: деталь, выключенную или убранную ПОСЛЕ ковки, переплавить всё равно обязаны —
  // иначе вещь застряла бы у игрока навсегда. Нет записи детали — материал семьи гнезда.
  const M = formMult(reg, item.affixCap ?? { prefix: 0, suffix: 0 });
  const out: MaterialCost = {};
  for (const slot of CRAFT_SLOT_LIST) {
    const pick = item.parts[slot];
    if (!pick) continue;
    const p = partById(reg, pick.id);
    const id = materialId(p ? partFamily(anat, slot, p) : anat[slot].family, pick.step);
    const n = Math.floor(Math.ceil(k.cost.units[slot] * M) * k.melt.share);
    if (n > 0) out[id] = (out[id] ?? 0) + n;
  }
  return out;
}
