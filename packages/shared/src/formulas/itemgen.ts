import type { Item, ItemOrigin, RolledAffix, Rarity, BaseRoll, RolledStat } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { Rng } from './rng.js';
import { uuidv7 } from './uuid.js';

type ItemsBase = ConfigShapes['items.base'];
type Affixes = ConfigShapes['affixes'];
type Uniques = ConfigShapes['uniques'];
type ItemTiers = ConfigShapes['item-tiers'];

/** Статы базы, масштабируемые тиром (урон/броня). Прочие (скор.атаки/блок) — flat. */
const TIER_SCALED = new Set(['minDamage', 'maxDamage', 'armor']);

/**
 * ⭐ R12-03: МЕНЯЕТ ЛИ СТУПЕНЬ ВЕЩЬ С ТАКИМИ СТАТАМИ БАЗЫ. Ступень множит только урон и броню базы (`TIER_SCALED`); скорость,
 * блок, аффиксы от неё не зависят, а требования она лишь поднимает. У кольца и амулета нет ни урона, ни брони: «Мифическое»
 * кольцо — то же «Убогое», только слово в имени другое. Такой вещи ступень не поднимают у кузнеца (`canUpgradeItem`: подъём брал
 * золото и сырьё за ничто), не берут за неё надбавку в лавке (`tierPremium`) и не мерят по ней мощь (`effectiveLevel`).
 * Годится и вещь: её статы базы — те же пары, помноженные на ступень.
 */
export function tierMatters(base: { baseStats: readonly StatModifier[] }): boolean {
  return base.baseStats.some((m) => m.kind === 'flat' && TIER_SCALED.has(m.stat) && m.value !== 0);
}

/**
 * Тир по уровню предмета, зажатый диапазоном [minTier, maxTier] базы. Лестница
 * сортируется по minItemLevel; берётся высший тир ≤ ilvl, но не ниже minTier и не
 * выше maxTier базы. Так «Ржавый нож» не станет Мифическим, а «мифрил» — Убогим.
 */
/** Настройки окна, в котором катается СТУПЕНЬ базы (`balance.loot.tierWindow`). */
export interface TierWindow {
  low: number; over: number; bias: number;
  softCap: number; softK: number; hardCap: number;
}

/**
 * ЭФФЕКТИВНЫЙ УРОВЕНЬ МОНСТРА ДЛЯ ВЫБОРА СТУПЕНИ — «ручник» против бесконечного забега.
 *
 * ⚠ Без него глубина становится краном мифических вещей: у нас уровень монстра растёт от мощи
 * игрока И от глубины, так что на уровне 150 окно целиком уезжает выше порога верхней ступени,
 * и она сыплется почти с каждого трупа. В Д4 ту же дыру закрыли жёстко — в Яме уровень предмета
 * упирается в кап с ПЕРВОГО тира, и двести тиров глубины не покупают ни единицы качества вещей;
 * платит она материалами мастеринга, а не шмотом.
 *
 * Мы берём мягче: выше `softCap` уровень считается со степенью `softK` (<1), то есть растёт
 * всё медленнее, а `hardCap` обрубает навсегда. Замер: мифические 5 % на уровне 80, 12 % на 150,
 * 15 % на 200 и 18 % на 300 — дальше не растёт НИКОГДА.
 */
export function effTierLevel(monsterLevel: number, w: TierWindow): number {
  const m = Math.max(1, monsterLevel);
  const raw = m <= w.softCap ? m : w.softCap + Math.pow(m - w.softCap, w.softK);
  return Math.min(w.hardCap, raw);
}

/**
 * УРОВЕНЬ, ПО КОТОРОМУ ВЫБИРАЕТСЯ СТУПЕНЬ БАЗЫ — бросок в окне вокруг уровня монстра.
 *
 * ⚠ Раньше ступень бралась детерминированно: «высшая, у которой minItemLevel ≤ уровня». Броска
 * не было вовсе, поэтому какой у игрока уровень — такая и ступень, всегда. Найти вещь лучше или
 * хуже своего уровня было невозможно, и «повезло, выпал Мифический» не существовало как событие.
 *
 * Идея окна — из Д2: монстр катает не одну полосу классов сокровищ, а ДИАПАЗОН снизу доверху,
 * где его уровень лишь верхняя граница. Поэтому высокие базы редки не отдельным броском на
 * удачу, а тем, что они тонкий ломтик широкого пула.
 *
 * `u^bias` при `bias > 1` смещает выборку к НИЖНЕЙ границе: чем выше ступень, тем реже.
 * ⚠ Это уровень ТОЛЬКО для ступени базы. Аффиксы катаются по настоящему уровню монстра — как
 * в Д2, где слабая база с высоким ilvl может нести отличные свойства.
 */
export function rollTierLevel(monsterLevel: number, w: TierWindow, rng: Rng): number {
  const eff = effTierLevel(monsterLevel, w);
  const lo = Math.max(1, Math.round(eff * w.low));
  const hi = Math.max(lo, eff + w.over);
  return Math.max(1, Math.round(lo + (hi - lo) * Math.pow(rng.float(0, 1), Math.max(0.01, w.bias))));
}

export function pickTierClamped(
  tiers: ItemTiers | undefined,
  itemLevel: number,
  minTierId: string,
  maxTierId: string,
): ItemTiers[number] | undefined {
  if (!tiers || tiers.length === 0) return undefined;
  // ⚠ R14-06: ДИАПАЗОН БАЗЫ — НА ПОЛНОЙ ЛЕСТНИЦЕ, выключенные тоже (как у кузницы: `nextTier`, `baseTierRange`). Раньше лестница
  // была из включённых: выключенный `maxTier` базы там не находился (−1), и потолок пропадал — кожаный доспех с потолком t3 падал
  // t5 с тел, из сундуков, с прилавка, а кузнец отвечал «лучше не сделать»; выключенный `minTier` ронял пол на t0. Нет такой
  // ступени в конфиге вовсе — граница открыта, как прежде.
  const sorted = [...tiers].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const loRaw = sorted.findIndex((t) => t.id === minTierId), hiRaw = sorted.findIndex((t) => t.id === maxTierId);
  const a = loRaw < 0 ? 0 : loRaw, b = hiRaw < 0 ? sorted.length - 1 : hiRaw;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  // Выключенные тиры не выбираются: высшая ВКЛЮЧЁННАЯ ступень диапазона с minItemLevel ≤ ilvl, а нет такой — низшая включённая
  // в нём. Выключено всё (или весь диапазон базы) — в игре все его ступени, чтобы предметы генерились; из диапазона не выходим.
  const inRange = sorted.slice(lo, hi + 1);
  const on = inRange.filter((t) => t.enabled !== false);
  const pool = on.length ? on : inRange;
  let pick = pool[0];
  for (const t of pool) if (t.minItemLevel <= itemLevel) pick = t;
  return pick;
}

/**
 * ⭐ ВИЛКА БАЗЫ (как в D2): урон и броня катаются вокруг числа тира, ±`spread`. Центр вилки —
 * прежнее число, поэтому вещь без броска (q = 0.5) ровно такая, какой была до бросков.
 * Умолчание совпадает с `balance.loot.baseRoll` (схема) — для вызовов, которым конфиг не передан.
 */
export const DEFAULT_ROLL_SPREAD: RollSpread = { weapon: 0.15, armor: 0.2 };
export interface RollSpread { weapon: number; armor: number }
const spreadOf = (stat: string, s: RollSpread): number => (stat === 'armor' ? s.armor : s.weapon);
/** Множитель вилки для доли q: 1 − s … 1 + s. */
export const rollFactor = (q: number, spread: number): number => 1 + spread * (2 * Math.max(0, Math.min(1, q)) - 1);

/**
 * ⭐ ФОРМА ЧИСЕЛ БАЗЫ от клинка (docs/CRAFT_WEAPONS.md §26): `spread` разводит мин и макс урона вокруг
 * ТОЙ ЖЕ середины (×0.4 — широкий, ровный удар; ×1.6 — узкий, вразнобой). Средний урон не меняется,
 * поэтому ДПС ширина не двигает. Нет формы или ×1 — числа базы как есть.
 */
export interface BaseShape { spread?: number }

/**
 * Статы базы с формой клинка — ДО тира и броска: форма живёт в числах базы, поэтому тир (множитель)
 * её сохраняет от «Сломанного» до «Мифического», а бросок вилки катается уже вокруг формы.
 * Значения дробные — округляет `scaleBaseStats` вместе с тиром, иначе ×0.4 на 5–9 съедалось бы дважды.
 */
export function shapedBaseStats(stats: StatModifier[], shape?: BaseShape): StatModifier[] {
  const s = shape?.spread;
  const mn = stats.find((m) => m.stat === 'minDamage' && m.kind === 'flat');
  const mx = stats.find((m) => m.stat === 'maxDamage' && m.kind === 'flat');
  if (s === undefined || s === 1 || !mn || !mx) return stats;
  const mid = (mn.value + mx.value) / 2, half = ((mx.value - mn.value) / 2) * Math.max(0, s);
  return stats.map((m) => (m === mn ? { ...m, value: Math.max(0.5, mid - half) } : m === mx ? { ...m, value: mid + half } : m));
}

/** Форма, записанная на вещи (`spreadMult`), — для подъёма тира и вывода тира старых сейвов. */
export const shapeOfItem = (item: { spreadMult?: number }): BaseShape | undefined =>
  item.spreadMult !== undefined && item.spreadMult !== 1 ? { spread: item.spreadMult } : undefined;

/**
 * Статы базы на тире с броском. ⚠ Всегда НОВЫЙ массив, даже при ×1: вещь с общим массивом базы
 * превращала любую правку статов вещи (ковка дописывает вклад деталей) в правку САМОЙ БАЗЫ в
 * конфиге — и всех следующих вещей. Считается всегда ОТ БАЗЫ (не домножением текущих), поэтому
 * подъём тира не копит ошибку округления, а бросок переживает его долей q.
 */
export function scaleBaseStats(stats: StatModifier[], mult: number, roll?: BaseRoll, spread: RollSpread = DEFAULT_ROLL_SPREAD, shape?: BaseShape): StatModifier[] {
  const out = shapedBaseStats(stats, shape).map((m) => {
    if (m.kind !== 'flat' || !TIER_SCALED.has(m.stat)) return { ...m };
    const q = roll?.[m.stat as RolledStat];
    const f = q === undefined ? 1 : rollFactor(q, spreadOf(m.stat, spread));
    return { ...m, value: Math.round(m.value * mult * f) };
  });
  // Мин и макс катаются порознь — на узкой вилке макс не может оказаться ниже мина.
  const mn = out.find((m) => m.stat === 'minDamage' && m.kind === 'flat');
  const mx = out.find((m) => m.stat === 'maxDamage' && m.kind === 'flat');
  // ⚠ Форма клинка округляется так же, ПОРОЗНЬ: мин зависит только от своего броска, макс — от своего, и
  // вилка «от и до» держит каждый. Цена — шум округления: середина клинка уезжает до полединицы, и на малых
  // числах короткого меча (6–11, t1; с 25.09 в нём и архаичные клинки) ширина двигает ДПС до ~8 % у героя
  // 1-го уровня. Подгонка суммы мин + макс
  // убирала шум, но связывала мин с броском макса — и вещь выкатывалась за показанную вилку (§26).
  if (mn && mx && mx.value < mn.value) mx.value = mn.value;
  return out;
}

/** Катаемые статы базы (есть в базе, масштабируются тиром, ненулевые). */
function rolledStatsOf(base: ItemsBase[number]): RolledStat[] {
  return base.baseStats.filter((m) => m.kind === 'flat' && TIER_SCALED.has(m.stat) && m.value !== 0).map((m) => m.stat as RolledStat);
}

/**
 * Пол броска на сетке сотых, ВВЕРХ: доля хранится до сотых, и без этого пол 0.333 давал бы бросок 0.33 —
 * ниже показанного края вилки. Через ×1e4 — иначе 0.07·100 = 7.000000000000001 уехало бы в 0.08.
 */
export const snapFloor = (floor: number): number => Math.ceil(Math.round(Math.max(0, Math.min(1, floor)) * 1e4) / 100) / 100;

/**
 * БРОСОК БАЗЫ: по доле q на каждую катаемую стату, порознь. `floor` поднимает НИЖНЮЮ границу
 * (доводка при ковке): q ∈ [floor, 1] — верх вилки не растёт никогда. Доля округляется до сотых:
 * вещь не тащит в сейв шум плавающей точки, а крайние значения вилки достижимы.
 */
export function rollBaseQ(base: ItemsBase[number], rng: Rng, floor = 0): BaseRoll | undefined {
  const stats = rolledStatsOf(base);
  if (!stats.length) return undefined;
  const f = snapFloor(floor);
  const out: BaseRoll = {};
  for (const st of stats) out[st] = Math.max(f, Math.round((f + (1 - f) * rng.next()) * 100) / 100);
  return out;
}

/** Бросок, у которого КАЖДАЯ катаемая стата стоит на доле q (край вилки — для показа «от и до»). */
export function fixedBaseRoll(base: ItemsBase[number], q: number): BaseRoll | undefined {
  const stats = rolledStatsOf(base);
  return stats.length ? (Object.fromEntries(stats.map((s) => [s, Math.max(0, Math.min(1, q))])) as BaseRoll) : undefined;
}

/** ВИЛКА статов базы на тире: [значение при q = floor, значение при q = 1] по каждой катаемой стате. */
export function baseStatRange(base: ItemsBase[number], statMult: number, spread: RollSpread = DEFAULT_ROLL_SPREAD, floor = 0, shape?: BaseShape): Partial<Record<RolledStat, [number, number]>> {
  const stats = rolledStatsOf(base);
  const at = (q: number) => scaleBaseStats(base.baseStats, statMult, Object.fromEntries(stats.map((s) => [s, q])) as BaseRoll, spread, shape);
  const lo = at(snapFloor(floor)), hi = at(1);
  const out: Partial<Record<RolledStat, [number, number]>> = {};
  for (const st of stats) {
    const a = lo.find((m) => m.stat === st && m.kind === 'flat')?.value, b = hi.find((m) => m.stat === st && m.kind === 'flat')?.value;
    if (a !== undefined && b !== undefined) out[st] = [a, b];
  }
  return out;
}

/** Дефолт капа суммы требований (если не передан из `balance.maxTotalRequirement`). */
const MAX_REQ_TOTAL_DEFAULT = 180;
/**
 * Масштабирует требования тиром (`mult`) и КАПИТ сумму `maxTotal` ПРОПОРЦИОНАЛЬНО: если Σ>кап —
 * все атрибуты ужимаются в (кап/Σ) раз (только сила → кап силы; сила+ловк → делится по доле).
 * `maxTotal<=0` — без капа.
 *
 * ⚠ V-B2-03: ужатые доли округляются НАИБОЛЬШИМ ОСТАТКОМ, а не каждая сама по себе. `Math.round` по атрибуту
 * перелетал кап: 14:26 на t6 ужималось ровно в 66.5 + 123.5, обе половинки вверх — 67 + 124 = 191 при капе 190
 * (копья, луки, арбалеты — из дропа, лавки, ковки и подъёма). Теперь: пол каждой доли, а недостающие до ⌊кап⌋ очки —
 * крупнейшим дробным частям (ничья — большему атрибуту, затем порядку ключей). Сумма ужатых = ⌊кап⌋ ровно, каждый
 * атрибут — пол или потолок своей доли. Неужатые требования округляются как прежде (`Math.round`) — они не меняются.
 *
 * ⚠ C-01: и НЕ ужатые — под тем же потолком. Наибольший остаток включался только при Σ СТРОГО больше капа, а Σ РОВНО на капе
 * (или чуть ниже) шла по атрибуту и перелетала его: 37/39 × 2.5 = 92.5 + 97.5 = 190 → 93 + 98 = 191; три доли по .6 (62.6 +
 * 62.6 + 64.6 = 189.8) → 63 + 63 + 65 = 191. Поставке такое не встречается, но ступень и базу хозяин правит живьём. Теперь
 * округление по атрибуту — только пока его сумма ≤ ⌊кап⌋; иначе те же доли (без ужатия) раздаются наибольшим остатком до ⌊кап⌋.
 */
function scaleReqs(reqs: Item['requirements'], mult: number, maxTotal: number = MAX_REQ_TOTAL_DEFAULT): Item['requirements'] {
  type Attr = keyof Item['requirements'];
  const scaled: [Attr, number][] = [];
  let total = 0;
  for (const [k, v] of Object.entries(reqs)) { if (v !== undefined) { const s = v * mult; scaled.push([k as Attr, s]); total += s; } }
  const out: Item['requirements'] = {};
  const capped = maxTotal > 0 && total > maxTotal;
  if (!capped) {
    const rounded = scaled.map(([k, s]) => [k, Math.round(s)] as const);
    if (!(maxTotal > 0 && rounded.reduce((n, [, r]) => n + r, 0) > Math.floor(maxTotal))) {
      for (const [k, r] of rounded) if (r > 0) out[k] = r;
      return out;
    }
  }
  const f = capped ? maxTotal / total : 1;
  const parts = scaled.map(([k, s], i) => { const x = s * f; const fl = Math.floor(x); return { k, i, x, r: fl, frac: x - fl }; });
  let left = Math.floor(maxTotal) - parts.reduce((n, p) => n + p.r, 0);
  // Сравнение дробей — с допуском: 66.5 и 123.5 после умножения бывают 66.4999… и 123.5000…, а это ничья, не «больше».
  const order = [...parts].sort((a, b) => (Math.abs(b.frac - a.frac) > 1e-9 ? b.frac - a.frac : b.x - a.x || a.i - b.i));
  for (const p of order) { if (left <= 0) break; p.r++; left--; }
  for (const p of parts) if (p.r > 0) out[p.k] = p.r;
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
      versatile: base.versatile || undefined,
      weaponClass: base.weaponClass,
      weight: base.weight,
      physSub: base.physSub,
      stunChance: base.stunChance,
      armorPenPct: base.armorPenPct,
      arcMult: base.arcMult,
      reachMult: base.reachMult,
      lowHpBonusPct: base.lowHpBonusPct,
      knockback: base.knockback,
      modelId: base.modelId,   // 3D-модель оружия (GLB) — несётся на инстанс (рендер + сеть пиров)
    };
  }
  if (base.kind === 'armor') return { slot: base.slot, armorClass: base.armorClass, beltSlots: base.beltSlots, modelId: base.modelId };   // 3D submesh-вариант брони
  if (base.kind === 'shield') return { slot: base.slot, shieldClass: base.shieldClass, modelId: base.modelId };
  if (base.kind === 'consumable') return { use: base.use }; // без слота — не экипируется
  return { slot: base.slot }; // jewelry — только слот + baseStats/requirements
}

/** Уровень предмета выводится из minTier (не задаётся руками): порог этого тира. */
function baseItemLevel(base: ItemsBase[number], tiers?: ItemTiers): number {
  return tiers?.find((t) => t.id === base.minTier)?.minItemLevel ?? 1;
}

type Rarities = ConfigShapes['rarities'];

/**
 * Ф2: идентификатор предмета — UUIDv7. Прежний `it_<время>_<счётчик>` не был глобально
 * уникальным (счётчик обнулялся на рестарте), а на нём должен держаться журнал происхождения.
 * Подробности — в `uuid.ts`.
 */
const nextUid = uuidv7;

/**
 * ЕДИНАЯ сборка Item из базы — весь маппинг полей/сигнатур + масштаб тира в одном
 * месте. Все пути (старт, квест, магазин, дроп, уник) идут через него — без дублей.
 */
function buildItem(
  base: ItemsBase[number],
  o: { rarity: Rarity; name: string; itemLevel: number; statMult: number; reqMult: number; affixes: RolledAffix[]; maxReqTotal?: number; tierId?: string; baseRoll?: BaseRoll; spread?: RollSpread; shape?: BaseShape; origin?: ItemOrigin },
): Item {
  const item: Item = {
    uid: nextUid(),
    baseId: base.id,
    kind: base.kind,
    name: o.name,
    ...gearFields(base),
    rarity: o.rarity,
    itemLevel: o.itemLevel,
    tier: o.tierId,
    requirements: scaleReqs(base.requirements, o.reqMult, o.maxReqTotal),
    baseStats: scaleBaseStats(base.baseStats, o.statMult, o.baseRoll, o.spread, o.shape),
    affixes: o.affixes,
    gridW: base.gridW,
    gridH: base.gridH,
    pos: null,
  };
  if (o.baseRoll) item.baseRoll = o.baseRoll;
  if (o.shape?.spread !== undefined && o.shape.spread !== 1) item.spreadMult = o.shape.spread;
  // Откуда вещь — пишет тот, кто её родил (§12.4): счётчик мификов журнала верит только этому полю.
  if (o.origin) item.origin = o.origin;
  return item;
}

/**
 * СЛЕДУЮЩИЙ ТИР вещи — или `undefined`, если она уже на потолке своей базы.
 * Потолок задан самой базой (`maxTier`), поэтому «бесконечное улучшение» невозможно
 * по построению, а не бюджетом: дешёвая база не станет мифической никогда.
 */
/**
 * КАКОГО ТИРА ВЕЩЬ НА САМОМ ДЕЛЕ — когда поле `tier` не записано.
 *
 * ⚠ ЗАЧЕМ ЭТО НУЖНО. Поле `tier` появилось только в Ч5; вещи из сейвов старше него приходят без
 * него. А `nextTier` без текущего тира считал вещь стоящей НИЖЕ первой ступени и предлагал
 * «улучшить» до t0 — то есть пересобрать статы с множителем ×1.0. Замер: алебарда 14–30 после
 * такого «улучшения» становилась 11–23, и игрок платил за это золотом и сырьём.
 *
 * Тир восстанавливаем ПО СТАТАМ, а не по уровню предмета: статы — это след, который тир оставил
 * на вещи физически, и он верен даже если базу с тех пор правили или вещь перековали в кузнице.
 * Уровень предмета — лишь то, из чего тир КОГДА-ТО выбирали, и после перековки он уже врёт.
 * Базы без шкалируемых статов (кольца, амулеты) следа не оставляют — там падаем на уровень.
 */
export function inferTierId(
  tiers: ItemTiers | undefined,
  base: ItemsBase[number],
  item: { tier?: string; baseStats: StatModifier[]; itemLevel: number; baseRoll?: BaseRoll; spreadMult?: number },
  spread: RollSpread = DEFAULT_ROLL_SPREAD,
): string | undefined {
  if (item.tier) return item.tier;
  if (!tiers?.length) return undefined;
  // ⚠ R12-08: сверка — со ВСЕЙ лестницей, выключенные тоже: след на статах оставила ступень, которой вещь была, а выключенная
  // после её рождения ступень от этого не перестала быть её ступенью (иначе вещь «была бы» соседней).
  // ⭐ Но — В ПРЕДЕЛАХ БАЗЫ (`minTier`…`maxTier`, предложение «Разбор, сырьё и чары» §14.2): вещь прода 08.08 с подъёмом-заглушкой
  // (статы ×1.2 за клик, «★» в имени, без лимита) по статам читалась как t6 — короткий меч с потолком t3 тоже. Ступени вне базы она
  // не бывает никогда. Нет такой ступени в конфиге — граница открыта, как у `pickTierClamped`.
  const sorted = [...tiers].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const loAt = sorted.findIndex((t) => t.id === base.minTier), hiAt = sorted.findIndex((t) => t.id === base.maxTier);
  const lo = loAt < 0 ? 0 : loAt, hi = hiAt < 0 ? sorted.length - 1 : hiAt;
  const pool = sorted.slice(Math.min(lo, hi), Math.max(lo, hi) + 1);
  // Сравнивать можно только то, что тир вообще масштабирует (`scaleBaseStats`), и только `flat`.
  // Числа базы — С ФОРМОЙ клинка (`spreadMult`): узкий 5–15 на «Сломанном» не должен читаться чужим тиром.
  const pairs = shapedBaseStats(base.baseStats, shapeOfItem(item))
    .filter((b) => b.kind === 'flat' && TIER_SCALED.has(b.stat) && b.value !== 0)
    .map((b) => ({ b, cur: item.baseStats.find((m) => m.stat === b.stat && m.kind === 'flat') }))
    .filter((p): p is { b: StatModifier; cur: StatModifier } => !!p.cur);
  if (!pairs.length) return pickTierClamped(tiers, item.itemLevel, base.minTier, base.maxTier)?.id;
  let best: ItemTiers[number] | undefined;
  let bestErr = Infinity;
  for (const t of pool) {
    let err = 0;
    // Вещь с броском сравниваем с ЕЁ местом в вилке, а не с центром: иначе край вилки читался бы соседним тиром.
    for (const p of pairs) {
      const q = item.baseRoll?.[p.b.stat as RolledStat];
      const f = q === undefined ? 1 : rollFactor(q, spreadOf(p.b.stat, spread));
      err += Math.abs(p.cur.value - Math.round(p.b.value * t.statMult * f)) / Math.abs(p.b.value);
    }
    if (err < bestErr) { bestErr = err; best = t; }
  }
  return best?.id;
}

export function nextTier(
  tiers: ItemTiers | undefined,
  base: ItemsBase[number],
  currentTierId: string | undefined,
): ItemTiers[number] | undefined {
  if (!tiers?.length || base.kind === 'consumable') return undefined;
  // ⭐ R12-08: МЕСТО ВЕЩИ — НА ПОЛНОЙ ЛЕСТНИЦЕ, выключенные тоже; выключенную ступень подъём лишь ПЕРЕШАГИВАЕТ. Раньше лестница
  // была из включённых: вещь выключенной в редакторе ступени своей там не находила (−1) и «улучшалась» до t0 — за золото и
  // сырьё, t5-меч 30–53 → 7–12; а выключенный потолок базы (`maxTier`) пропадал вовсе, и база шла до верха лестницы.
  // Всё выключено — все в игре (как у дропа, `pickTierClamped`). Ступени вещи нет в конфиге вовсе — где она стоит, неизвестно:
  // подъёма нет, а не «на t0».
  const sorted = [...tiers].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const anyOn = tiers.some((t) => t.enabled !== false);
  const hi = sorted.findIndex((t) => t.id === base.maxTier);
  const cap = hi < 0 ? sorted.length - 1 : hi;
  const cur = currentTierId ? sorted.findIndex((t) => t.id === currentTierId) : -1;
  if (currentTierId && cur < 0) return undefined;
  for (let i = cur + 1; i <= cap; i++) if (!anyOn || sorted[i]!.enabled !== false) return sorted[i];
  return undefined;
}

/**
 * ПЕРЕСБОРКА ВЕЩИ НА ДРУГОМ ТИРЕ — статы и требования пересчитываются от БАЗЫ, а приставка
 * в названии меняется на новую.
 *
 * ⚠ Считаем от базы, а не домножаем текущие статы: домножение накапливает ошибку округления
 * и разъезжается с тем, что даёт генерация того же тира — «Отличный» из кузницы обязан быть
 * равен «Отличному» с пола, иначе тир перестаёт что-либо значить.
 *
 * `reqDiscount` — кузнечная скидка на требования: найденный «Мастерский» меч сильнее, кузнечный
 * доступнее раньше. Это и есть причина возиться с крафтом, а не ждать удачного дропа.
 */
export function retierItem(
  base: ItemsBase[number],
  item: Item,
  tier: ItemTiers[number],
  opts: { reqDiscount?: number; maxReqTotal?: number; spread?: RollSpread } = {},
): Item {
  const reqMult = tier.reqMult * (1 - (opts.reqDiscount ?? 0));
  return {
    ...item,
    tier: tier.id,
    name: item.rarity === 'normal' ? tieredName(tier.name, base.name, base.gender) : item.name,
    requirements: scaleReqs(base.requirements, reqMult, opts.maxReqTotal),
    // Бросок переживает подъём: та же доля q на новом тире — вещь остаётся на своём месте вилки.
    // Форма клинка (`spreadMult`) — тоже: мин и макс нового тира разводятся вокруг той же середины.
    // ⚠ Вклад деталей (скорость клинка, блок, укус) отсюда НЕ переносится: статы собираются от базы, как и
    // раньше. Найденному мечу его клинок возвращает `upgradedItem` → `shapeFoundWeapon` — от деталей, а не
    // вычитанием из текущих статов (правка базы после выпадения иначе застряла бы в вещи навсегда).
    baseStats: scaleBaseStats(base.baseStats, tier.statMult, item.baseRoll, opts.spread, shapeOfItem(item)),
  };
}

/**
 * Что лежит в статах вещи СВЕРХ статов базы — вклад деталей, дописанный ковкой или клинком найденного
 * меча. Сверка по паре (стат, вид) с вычёркиванием, а не срезом по длине. Для показа и проверок: статы
 * вещи из этого не собираются.
 */
export function bakedExtras(baseStats: StatModifier[], itemStats: StatModifier[]): StatModifier[] {
  const left = new Map<string, number>();
  for (const m of baseStats) { const k = `${m.stat}|${m.kind}`; left.set(k, (left.get(k) ?? 0) + 1); }
  const out: StatModifier[] = [];
  for (const m of itemStats) {
    const k = `${m.stat}|${m.kind}`;
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else out.push({ ...m });
  }
  return out;
}

/**
 * Normal-предмет из базы через ЕДИНЫЙ конвейер: тир берётся по itemLevel базы (как
 * у дропа — никаких исключений), имя согласуется по роду. Без аффиксов. `tiers` не
 * передан → базовый тир (×1.0, без префикса).
 */
export function itemFromBase(base: ItemsBase[number], tiers?: ItemTiers, origin?: ItemOrigin): Item {
  const ilvl = baseItemLevel(base, tiers);
  // Расходники не тирятся (нет префикса «Убогое зелье» и масштаба урона/брони).
  const tier = base.kind === 'consumable' ? undefined : pickTierClamped(tiers, ilvl, base.minTier, base.maxTier);
  return buildItem(base, {
    rarity: 'normal',
    name: tieredName(tier?.name ?? '', base.name, base.gender),
    itemLevel: ilvl,
    statMult: tier?.statMult ?? 1,
    reqMult: tier?.reqMult ?? 1,
    tierId: tier?.id,
    affixes: [],
    origin,
  });
}

/**
 * ⚠ R13-12: БАЗА В ИГРЕ — есть в конфиге и не выключена в редакторе (`enabled: false`: «не выпадает и не в магазине»). Выдача
 * вещи по id базы (`itemFromBaseId`) галку не смотрит — её смотрит тот, кто выдаёт: награда квеста (`questLogic`) и, ⚠ R14-08,
 * стартовый комплект (`newCharacterSave`).
 */
export function baseInGame(itemsBase: ItemsBase): (baseId: string) => boolean {
  const on = new Set(itemsBase.filter((b) => b.enabled !== false).map((b) => b.id));
  return (baseId) => on.has(baseId);
}

/** Ищет базу по id и создаёт normal-предмет (тир по уровню); null — база не найдена. `origin` — кто родил (§12.4). */
export function itemFromBaseId(itemsBase: ItemsBase, baseId: string, tiers?: ItemTiers, origin?: ItemOrigin): Item | null {
  const base = itemsBase.find((b) => b.id === baseId);
  return base ? itemFromBase(base, tiers, origin) : null;
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
 * ПУЛ, из которого катает `rollAffixes`: включённые, прошедшие гейт magic/rare, подходящие предмету и
 * доступные на его ilvl. Вынесен ради ОДНОГО ответа: проверка «пул наберёт оплаченную форму» перед
 * зачарованием (`craft.ts`) обязана видеть ровно тот пул, из которого потом катится бросок.
 */
export function affixPool(affixes: Affixes, target: AffixTarget, rarity: Rarity, itemLevel: number): Affix[] {
  const rareGate = (a: Affix): boolean => (rarity === 'magic' ? a.onMagic : rarity === 'rare' ? a.onRare : true);
  return affixes.filter((a) => a.enabled !== false && rareGate(a) && affixFits(a, target) && affixEligible(a, itemLevel));
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
  const usable = affixPool(affixes, target, rarity, itemLevel);
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
 * Нижняя из двух ступеней по лестнице (`minItemLevel`): потолок базы и внешний потолок (лавка не выше t4 — `balance.shop.maxTier`).
 * Внешнего нет или такой ступени нет в конфиге — потолок базы как есть.
 */
export function lowerTierId(tiers: ItemTiers | undefined, baseMax: string, cap: string | undefined): string {
  if (!cap || !tiers?.length) return baseMax;
  const lvl = (id: string): number => tiers.find((t) => t.id === id)?.minItemLevel ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(lvl(cap))) return baseMax;
  return lvl(cap) < lvl(baseMax) ? cap : baseMax;
}

/**
 * Генерирует предмет из базы (или уникум) с учётом редкости, iLvl и ТИРА. По ilvl
 * дропа берётся высший доступный тир (`opts.tiers`): урон/броня базы масштабируются
 * `statMult`, требования — `reqMult`, имя получает префикс тира. Аффиксы — по ilvl.
 * `origin` — кто родил вещь (дроп, сундук, лавка…): его пишет ВЫЗЫВАЮЩИЙ, сам генератор этого не знает.
 * ⭐ R13-09: `noUnique` — бросок «уник» даёт редкую вещь просящей базы (как пустой пул уников): кузница уников не продаёт.
 */
export function generateItem(
  itemsBase: ItemsBase,
  affixes: Affixes,
  uniques: Uniques,
  opts: { dropBias: number; itemLevel: number; tierLevel?: number; baseId?: string; tiers?: ItemTiers; rarities: Rarities; categoryWeights?: Record<string, number>; rareNames?: { nouns: RareNoun[]; epithets: RareEpithet[] }; forceRarity?: Rarity; maxReqTotal?: number; baseRoll?: RollSpread; origin?: ItemOrigin; noUnique?: boolean; maxTier?: string },
  rng: Rng,
): Item {
  const rarity = opts.forceRarity ?? rollRarity(opts.dropBias, rng, opts.rarities); // песочница-редактор может форсить редкость
  // Эффективный itemLevel дропа = уровень вызова (глубина/сложность), но не ниже
  // itemLevel самой базы. Влияет на тир (зажатый диапазоном базы), аффиксы, цену.
  const dropIlvl = Math.max(1, Math.round(opts.itemLevel));
  // ⚠ СТУПЕНЬ базы и АФФИКСЫ живут на РАЗНЫХ уровнях. `tierLevel` — бросок в окне вокруг уровня
  // монстра (`rollTierLevel`), и он решает только ступень; аффиксы остаются на `itemLevel`.
  // Слей их в одно число — и высокоуровневый игрок получал бы не только низкую базу, но и слабые
  // свойства на ней, то есть просадку силы вдобавок к просадке ступени.
  const tierIlvl = Math.max(1, Math.round(opts.tierLevel ?? opts.itemLevel));

  // Выключенные базы (enabled:false) не выпадают из случайного дропа (явный baseId — можно).
  const enabledBase = itemsBase.filter((b) => b.enabled !== false);
  // Выключенные уники не выпадают. ⚠ R13-12: и уники на базе, которой нет в игре (выключена в редакторе или убрана): отбор
  // смотрел только на галку уника, а базу искал среди ВСЕХ — уник на выключенной базе падал с тел, из сундуков и с прилавка
  // (128 из 384 уников за 20 000 дропов при выключенной секире палача). Не осталось ни одного — «уник» падает редкой вещью.
  const uniquePool = rarity === 'unique' && !opts.noUnique
    ? uniques.filter((u) => u.enabled !== false && enabledBase.some((b) => b.id === u.baseId)) : [];
  if (uniquePool.length > 0) {
    const unique = rng.pick(uniquePool);
    const base = enabledBase.find((b) => b.id === unique.baseId);
    if (base) {
      const ilvl = Math.max(baseItemLevel(base, opts.tiers), dropIlvl);
      const tier = pickTierClamped(opts.tiers, Math.max(baseItemLevel(base, opts.tiers), tierIlvl), base.minTier, lowerTierId(opts.tiers, base.maxTier, opts.maxTier));
      return buildItem(base, {
        rarity: 'unique',
        name: titledName(base.name, base.gender, unique.name), // имя базы + титул уника
        itemLevel: ilvl,
        statMult: tier?.statMult ?? 1,
        reqMult: tier?.reqMult ?? 1,
        tierId: tier?.id,
        affixes: unique.fixedAffixes.map((fa) => ({ affixId: unique.id, kind: fa.kind, modifier: fa.modifier })),
        maxReqTotal: opts.maxReqTotal,
        // Бросок базы — ПОСЛЕДНИМ из rng: остальной поток (редкость, аффиксы, имя) не сдвигается.
        baseRoll: rollBaseQ(base, rng),
        spread: opts.baseRoll,
        origin: opts.origin,
      });
    }
  }

  // Выбор базы: по baseId (магазин/квест), иначе — взвешенно по категориям (`categoryWeights` из
  // balance.loot) × per-item `dropWeight`. Без weights — прежнее поведение (равномерно по экипу).
  // Выключенные базы не выпадают из случайного дропа (`enabledBase` выше).
  const equipPool = enabledBase.filter((b) => b.kind !== 'consumable');
  const base = opts.baseId
    ? itemsBase.find((b) => b.id === opts.baseId) ?? rng.pick(equipPool)
    : opts.categoryWeights
      ? pickDropBase(enabledBase, opts.categoryWeights, rng)
      : rng.pick(equipPool);

  // Расходники (колбы) не роллят редкость/аффиксы/тир — всегда normal.
  const isConsumable = base.kind === 'consumable';
  const ilvl = Math.max(baseItemLevel(base, opts.tiers), dropIlvl);
  const tier = isConsumable ? undefined
    : pickTierClamped(opts.tiers, Math.max(baseItemLevel(base, opts.tiers), tierIlvl), base.minTier, lowerTierId(opts.tiers, base.maxTier, opts.maxTier));
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
    tierId: tier?.id,
    affixes: rolled,
    maxReqTotal: opts.maxReqTotal,
    // Бросок базы — ПОСЛЕДНИМ из rng: остальной поток (редкость, аффиксы, имя) не сдвигается.
    // Колбы не катаются.
    baseRoll: isConsumable ? undefined : rollBaseQ(base, rng),
    spread: opts.baseRoll,
    origin: opts.origin,
  });
}

/**
 * ⭐ ВХОД КОВКИ В ЕДИНЫЙ КОНВЕЙЕР (docs/CRAFT_WEAPONS.md §19). Скованная вещь собирается ТОЙ ЖЕ
 * `buildItem`, что и дроп, — второго конвейера нет, и «скованный Мастерский» по каркасу равен
 * «Мастерскому» с пола. Выходит всегда ОБЫЧНОЙ: аффиксы — отдельным глаголом «зачаровать».
 * Происхождение — `craft`: скованное счётчику мификов не идёт никогда.
 *
 * `reqDiscount` — кузнечная скидка на требования, ТА ЖЕ, что у подъёма тира (`retierItem`): множитель
 * требований тира × (1 − скидка), и уже потом кап и округление — одной `scaleReqs`. Скованная и поднятая у
 * кузнеца вещь одной базы и ступени требуют ровно одинаково (решение владельца: кузнечная вещь легче).
 */
export function buildCraftShell(
  base: ItemsBase[number],
  tier: ItemTiers[number],
  maxReqTotal?: number,
  roll?: { baseRoll?: BaseRoll; spread?: RollSpread; shape?: BaseShape; reqDiscount?: number },
): Item {
  return buildItem(base, {
    rarity: 'normal',
    name: tieredName(tier.name, base.name, base.gender),
    itemLevel: tier.minItemLevel,
    statMult: tier.statMult,
    reqMult: tier.reqMult * (1 - (roll?.reqDiscount ?? 0)),
    tierId: tier.id,
    affixes: [],
    maxReqTotal,
    baseRoll: roll?.baseRoll,
    spread: roll?.spread,
    shape: roll?.shape,
    origin: 'craft',
  });
}

/** Цель фильтра аффиксов по базе — та же, по которой катает дроп. */
export function affixTargetOfBase(base: ItemsBase[number]): AffixTarget {
  return affixTargetOf(base);
}

/**
 * Имя вещи ПОСЛЕ зачарования — тем же правилом, что у дропа: magic — слова аффиксов вокруг базы,
 * rare — «основа эпитет» по свойствам. Своя формула имени здесь значила бы, что скованная редкая
 * зовётся иначе, чем такая же найденная.
 */
export function nameByRarity(
  base: ItemsBase[number],
  tierName: string,
  rarity: Rarity,
  rolled: RolledAffix[],
  affixes: Affixes,
  rareNames: { nouns: RareNoun[]; epithets: RareEpithet[] } | undefined,
  rng: Rng,
): string {
  if (rarity === 'magic') {
    const mn = magicName(base.name, base.gender, rolled, new Map(affixes.map((a) => [a.id, a.word])));
    return mn === base.name ? tierName : mn;
  }
  if (rarity === 'rare') return rareItemName(base.name, base.gender, rareNames, rolled, rng, tierName);
  return tierName;
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
