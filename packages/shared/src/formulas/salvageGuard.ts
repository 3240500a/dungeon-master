import type { ConfigKey, ConfigShapes } from '../config/schemas.js';
import { ESSENCE_FAMILY } from './salvage.js';

/**
 * ⭐ ПРАВИЛА РАЗБОРА ПОВЕРХ НЕСКОЛЬКИХ ТАБЛИЦ — то, чего схема одной таблицы не видит (`configCrossIssues`): реестр (файлы, оверрайды базы,
 * `/api/dev/config`) и редактор (до отправки) не пускают конфиг, который их ломает. Оба правила — про то, чтобы защита разбора держалась
 * ПРАВИЛОМ, а не числами, которые хозяин правит живьём (предложение «Разбор, сырьё и чары» §11.2):
 *
 * 1. РЕЦЕПТ СВОЕЙ СТУПЕНИ (`salvageRecipeIssues`): строка `t` рецепта (`balance.salvage.recipeByTier`) — сорта четырёх деталей, из которых
 *    ковка (`balance.craft.tierFromParts`) собирает РОВНО ступень `t`. Иначе разбор вещи t4 давал бы сырьё на t5 — лестница сырья стала бы
 *    насосом. Число строк и ступеней может расходиться (редактор сохраняет по таблице за раз: добавить ступень и её строку разом нельзя, и
 *    требование «строк ровно столько» запирало оба порядка): ступень без своей строки берёт последнюю (`salvageGrades` зажимает индекс) —
 *    сорт ниже своей ступени, насоса нет; лишние строки не читаются. Проверяется каждая строка, у которой есть ступень.
 * 2. ⭐ D4 (решение владельца 06.10: «пусть продаются, но чтобы это было невыгодно, как во всех играх»): РАЗОБРАТЬ И ПРОДАТЬ СЫРЬЁ НЕ
 *    ВЫГОДНЕЕ, ЧЕМ ПРОДАТЬ ВЕЩЬ. Держится двумя замками:
 *    - ПРАВИЛОМ в ядре — лавка платит за вещь не меньше, чем стоит выход её разбора у кузнеца (`shopSellPrice`, пол `salvageWorth`): при
 *      ЛЮБОМ конфиге, у найденной, купленной и скованной (переплавка), с эссенцией — и при множителе цены редкости у нуля (R23-04);
 *    - ЦЕНАМИ СЫРЬЯ (`salvageSellIssues`, здесь): сырьё не дороже вещи, из которой оно вышло, — так что пол цены не задирает цены вещей.
 *      Верх выхода разбора у кузнеца (лучший бросок, самый дорогой материал сорта) — не дороже САМОЙ ДЕШЁВОЙ обычной вещи этой ступени
 *      (`shopSellPrice` без аффиксов при множителе редкости 1, уровень — низ окна ступени `minItemLevel − tierWindow.over`) с допуском
 *      `SELL_FLOOR_SLACK`. Само неравенство D4 держит пол в ядре при ЛЮБОМ конфиге; это правило — о том, чтобы пол не стал ценой вещей.
 *      Прежде допуска не было, а на низу (t0–t1) запаса нет вовсе (7 против 7): правка окна лута (`tierWindow.over`), порога ступени
 *      (`minItemLevel`) или единиц разбора на единицу отказывала словами «снизь цену сырья», хотя ядро и так держало D4, а цена вещи
 *      поднималась на одно-два золота. Опасное — старые цены 36/108 (вещь t6 за 756 вместо 134) — правило по-прежнему не пускает.
 *      Множитель редкости и эссенция сюда не входят нарочно: правка редкости живьём (R23-04) не должна упираться в цену сырья, а их
 *      держит пол в ядре. Сторож настоящими вещами — `salvageSell.test.ts`.
 */
export interface SalvageGuardIssue {
  table: ConfigKey;
  msg: string;
  /** Какая строка (одна и та же до и после правки — один `id`): сравнить «до» и «после» (`crossIssuesWorse`). */
  id: string;
  /** Насколько глубоко (больше — хуже). */
  severity: number[];
}

/**
 * Допуск правила D4 по ценам: сырьё с разбора вещи может стоить до `1 + SELL_FLOOR_SLACK` самой дешёвой обычной вещи своей ступени — пол
 * цены в ядре поднимет такую вещь на эту долю, не больше. Больше — отказ: цены вещей потянуло бы вверх ценой сырья (кран золота с продажи).
 */
export const SELL_FLOOR_SLACK = 0.25;

type Balance = ConfigShapes['balance'];
type Tiers = ConfigShapes['item-tiers'];

const SLOTS = ['strike', 'grip', 'bind', 'head'] as const;

/** Ступень, которую ковка соберёт из четырёх сортов (`tierOfSteps` без реестра): Q — средний сорт по массе, ступень = round(scale·(Q−1)). */
export function tierOfGrades(balance: Balance, grades: readonly number[], tierCount: number): number {
  const k = balance.craft.tierFromParts;
  let sw = 0, s = 0;
  SLOTS.forEach((slot, i) => { const w = k.weights[slot]; sw += w; s += w * (grades[i] ?? 1); });
  const q = sw > 0 ? Math.round((s / sw) * 10000) / 10000 : 1;
  return Math.max(0, Math.min(tierCount - 1, Math.round(k.scale * (q - 1) + 1e-9)));
}

/**
 * Правило 1: строка рецепта куётся ровно в свою ступень — каждая строка, у которой есть ступень (`t < min(строк, ступеней)`). Сколько строк —
 * не правило (см. шапку): лишних не читают, недостающих ступеней разбор зажимает к последней строке.
 */
export function salvageRecipeIssues(balance: Balance, tiers: Tiers): SalvageGuardIssue[] {
  const rows = balance.salvage.recipeByTier;
  const out: SalvageGuardIssue[] = [];
  const names = [...tiers].sort((a, b) => a.minItemLevel - b.minItemLevel).map((t) => t.id);
  rows.forEach((row, t) => {
    if (t >= tiers.length) return;
    const got = tierOfGrades(balance, row, tiers.length);
    if (got !== t) {
      out.push({
        table: 'balance', id: `recipe:${t}`, severity: [Math.abs(got - t)],
        msg: `рецепт разбора ступени ${names[t] ?? t} (${row.join('/')}) куётся в ${names[got] ?? got}, а не в свою ступень: разбор обязан возвращать ровно рецепт своей ступени (balance.salvage.recipeByTier)`,
      });
    }
  });
  return out;
}

/** Таблицы правила D4. */
export interface SalvageSellTables {
  balance: Balance;
  'item-tiers': Tiers;
  'craft-materials': ConfigShapes['craft-materials'];
  'salvage-rules': ConfigShapes['salvage-rules'];
}

/** Самое дорогое включённое сырьё сорта не выше `g` (выключенный сорт разбор спускает ниже — `knownOnly`), без эссенции. */
function topPrice(mats: SalvageSellTables['craft-materials'], g: number): number {
  let p = 0;
  for (const m of mats) if (m.enabled && m.family !== ESSENCE_FAMILY && m.tier <= g) p = Math.max(p, m.sellPrice);
  return p;
}

/** Верх выхода по правилу (броня, щит, украшение, оружие без деталей кузнеца) на сорте `g`, в золоте. */
function rulesTop(t: SalvageSellTables, g: number): number {
  const mult = t.balance.salvage.armorSlotMult as Record<string, number>;
  const anyArmor = Math.max(1, ...Object.values(mult));
  let best = 0;
  for (const r of t['salvage-rules']) {
    if (r.enabled === false || !r.yields?.length) continue;
    const m = r.kind === 'armor' ? (r.slot ? (mult[r.slot] ?? 1) : anyArmor) : 1;
    let units = 0;
    for (const y of r.yields) units += Math.max(0, Math.ceil(Math.max(0, y.max) * m - 1e-9));
    best = Math.max(best, units * topPrice(t['craft-materials'], g));
  }
  return best;
}

/** Самая дешёвая обычная вещь ступени в лавке — `shopSellPrice` без аффиксов на низу окна ступени, множитель редкости 1. */
function cheapestSell(t: SalvageSellTables, minItemLevel: number): number {
  const lvl = Math.max(1, minItemLevel - t.balance.loot.tierWindow.over);
  return Math.max(1, Math.floor((15 + lvl * 4) * 0.4));
}

/**
 * Правило 2 (D4), часть «цены сырья»: сырьё с разбора у кузнеца — не дороже самой дешёвой обычной вещи своей ступени с допуском
 * `SELL_FLOOR_SLACK`. Пусто — держится. Таблица нарушения — `craft-materials` (цены), а текст называет все ручки, из которых складывается
 * неравенство: правка любой из них может его нарушить, и чинить можно любой.
 */
export function salvageSellIssues(t: SalvageSellTables): SalvageGuardIssue[] {
  const s = t.balance.salvage;
  const units = t.balance.craft.salvage.units;
  const tiers = [...t['item-tiers']].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const out: SalvageGuardIssue[] = [];
  tiers.forEach((tier, ti) => {
    const row = s.recipeByTier[Math.min(ti, s.recipeByTier.length - 1)] ?? [1, 1, 1, 1];
    const weapon = SLOTS.reduce((sum, slot, i) => sum + units[slot] * topPrice(t['craft-materials'], row[i] ?? 1), 0);
    const armor = rulesTop(t, Math.min(...row));
    const top = Math.max(weapon, armor);
    const sell = cheapestSell(t, tier.minItemLevel);
    if (top > Math.floor(sell * (1 + SELL_FLOOR_SLACK) + 1e-9)) {
      const from = weapon >= armor
        ? `выхода оружия (balance.craft.salvage.units ${SLOTS.map((k) => units[k]).join('/')})`
        : 'выхода брони, щита, украшения (salvage-rules, balance.salvage.armorSlotMult)';
      out.push({
        table: 'craft-materials', id: `sell:${tier.id}`, severity: [top / Math.max(1, sell)],
        msg: `⭐ D4 разбор не выгоднее продажи: обычная вещь ${tier.id} в лавке от ${sell} золота, а сырьё её разбора у кузнеца — до ${top} `
          + `(больше чем на ${Math.round(SELL_FLOOR_SLACK * 100)} %: пол цены в ядре задрал бы цены вещей ценой сырья). Складывается из цены сырья `
          + `(craft-materials.sellPrice), ${from}, рецепта (balance.salvage.recipeByTier) и цены самой дешёвой вещи ступени `
          + `(уровень — item-tiers.minItemLevel ${tier.minItemLevel} − balance.loot.tierWindow.over ${t.balance.loot.tierWindow.over}): поправь любую из этих ручек`,
      });
    }
  });
  return out;
}
